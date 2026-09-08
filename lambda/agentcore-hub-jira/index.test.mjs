/**
 * Tests for agentcore-hub-jira ticket-tools Lambda.
 *
 * Covers the two TEAM-3545 review findings:
 *   - Finding 1: adfToText must preserve logical line breaks (hardBreak + block
 *     nodes) so an isolated `DECISION: <value>` line survives flattening.
 *   - Finding 2: getIssue must fetch comments newest-first from the dedicated
 *     /comment endpoint (not the paginated embedded container) and return them
 *     chronologically.
 *
 * Uses only Node's built-in runner (node:test + node:assert) — no dependencies.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { adfToText, getIssue, handler } from "./index.mjs";
import { parseFixContractBlock } from "./fix-contract.mjs";

// ─── Finding 1: adfToText ──────────────────────────────────────────────────────

test("adfToText: hardBreak splits a paragraph so DECISION stays on its own line", () => {
  // The exact shape the release manager sees: a human comment with the decision
  // on the first line and rationale after a Shift+Enter (hardBreak).
  const doc = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "DECISION: merge-with-known-findings" },
          { type: "hardBreak" },
          { type: "text", text: "rationale: findings are non-blocking" },
        ],
      },
    ],
  };

  const lines = adfToText(doc).split("\n");
  assert.ok(
    lines.includes("DECISION: merge-with-known-findings"),
    `expected an isolated DECISION line, got lines: ${JSON.stringify(lines)}`
  );
  // The rationale must NOT be joined onto the DECISION line.
  assert.ok(lines.includes("rationale: findings are non-blocking"));
});

test("adfToText: bulletList items each land on their own line", () => {
  const doc = {
    type: "bulletList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
    ],
  };
  const lines = adfToText(doc).split("\n").filter((l) => l.length > 0);
  assert.deepEqual(lines, ["first", "second"]);
});

test("adfToText: orderedList items each land on their own line", () => {
  const doc = {
    type: "orderedList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
    ],
  };
  const lines = adfToText(doc).split("\n").filter((l) => l.length > 0);
  assert.deepEqual(lines, ["one", "two"]);
});

test("adfToText: blockquote and codeBlock each land on their own line", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "DECISION: hold" }] },
    ],
  };
  const lines = adfToText(doc).split("\n").filter((l) => l.length > 0);
  assert.deepEqual(lines, ["quoted", "DECISION: hold"]);
});

test("adfToText: heading and paragraph behavior unchanged", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", content: [{ type: "text", text: "Title" }] },
      { type: "paragraph", content: [{ type: "text", text: "body text" }] },
    ],
  };
  const lines = adfToText(doc).split("\n").filter((l) => l.length > 0);
  assert.deepEqual(lines, ["Title", "body text"]);
});

test("adfToText: plain strings pass through and unknown nodes flatten their content", () => {
  assert.equal(adfToText("just a string"), "just a string");
  assert.equal(adfToText(null), "");
  // Unknown node type: no separator, content flattened through.
  const unknown = { type: "someFutureInlineMark", content: [{ type: "text", text: "kept" }] };
  assert.equal(adfToText(unknown), "kept");
});

// ─── Finding 2: getIssue comment fetch ─────────────────────────────────────────

/** Build an ADF doc for a single-line comment body. */
function adfLine(text) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

test("getIssue: fetches comments newest-first and returns them chronologically", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;

  // Response as Jira serves it with orderBy=-created: NEWEST first.
  const newestFirst = [
    { author: { displayName: "Release Manager" }, body: adfLine("DECISION: ship"), created: "2026-08-31T12:00:00.000Z" },
    { author: { displayName: "Reviewer" }, body: adfLine("looks good"), created: "2026-08-30T09:00:00.000Z" },
    { author: { displayName: "Author" }, body: adfLine("please review"), created: "2026-08-29T08:00:00.000Z" },
  ];

  globalThis.fetch = async (url) => {
    requested.push(url);
    if (url.includes("/comment")) {
      return new Response(JSON.stringify({ comments: newestFirst }), { status: 200 });
    }
    // Issue GET — note: no `comment` field embedded.
    return new Response(
      JSON.stringify({
        key: "TEAM-1",
        fields: {
          summary: "Do the thing",
          status: { name: "In Review" },
          labels: ["wf:abc"],
          issuetype: { name: "Task" },
        },
      }),
      { status: 200 }
    );
  };

  try {
    const result = await getIssue({ issue_key: "TEAM-1" });

    // Issue itself still mapped.
    assert.equal(result.ticketId, "TEAM-1");
    assert.equal(result.title, "Do the thing");
    assert.equal(result.workflowId, "abc");

    // The comment request must be newest-first via the dedicated endpoint.
    const commentUrl = requested.find((u) => u.includes("/comment"));
    assert.ok(commentUrl, "expected a request to the /comment endpoint");
    assert.ok(commentUrl.includes("orderBy=-created"), `expected orderBy=-created, got ${commentUrl}`);

    // The issue GET must NOT request the embedded comment field.
    const issueUrl = requested.find((u) => !u.includes("/comment"));
    assert.ok(issueUrl && !/[?&]fields=[^&]*comment/.test(issueUrl), `issue GET should not request comment field: ${issueUrl}`);

    // Returned comments must be chronological (oldest → newest).
    assert.equal(result.comments.length, 3);
    assert.deepEqual(
      result.comments.map((c) => c.created),
      ["2026-08-29T08:00:00.000Z", "2026-08-30T09:00:00.000Z", "2026-08-31T12:00:00.000Z"]
    );
    // Mapping shape: author / body / created.
    assert.deepEqual(result.comments[0], {
      author: "Author",
      body: "please review\n",
      created: "2026-08-29T08:00:00.000Z",
    });
    assert.equal(result.comments[2].author, "Release Manager");
    assert.equal(result.comments[2].body, "DECISION: ship\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getIssue: comment fetch failure returns the mapped issue with comments: []", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (url.includes("/comment")) {
      // Simulate a Jira error on the comment endpoint.
      return new Response(JSON.stringify({ errorMessages: ["boom"] }), { status: 500 });
    }
    return new Response(
      JSON.stringify({
        key: "TEAM-2",
        fields: { summary: "Another", status: { name: "To Do" }, labels: [], issuetype: { name: "Task" } },
      }),
      { status: 200 }
    );
  };

  try {
    const result = await getIssue({ issue_key: "TEAM-2" });
    assert.equal(result.ticketId, "TEAM-2");
    assert.equal(result.title, "Another");
    assert.deepEqual(result.comments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── createTicket dedupe: a resolved same-summary ticket is not a live duplicate ──

test("createTicket: a Done same-summary ticket is NOT a duplicate — a new ticket is created", async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];
  const searchUrls = [];

  const SUMMARY = "Escalation: ship-review not converging (TEAM-1)";

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    // Dedupe search — returns a prior gate with the SAME summary/labels, Done.
    if (url.includes("/rest/api/3/search/jql")) {
      searchUrls.push(url);
      return new Response(
        JSON.stringify({
          issues: [
            {
              key: "TEAM-10",
              fields: { summary: SUMMARY, status: { name: "Done" }, labels: ["wf:run1"], issuetype: { name: "Task" } },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      posts.push(url);
      return new Response(JSON.stringify({ key: "TEAM-11" }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: SUMMARY, workflow_id: "run1" },
    });
    assert.equal(posts.length, 1, `expected one create POST, got ${posts.length}`);
    assert.equal(result.ticketId, "TEAM-11");
    assert.ok(!result.deduplicated, "a Done gate must not be returned as a dedupe hit");
    // Terminal tickets are filtered server-side too, so a live duplicate can
    // never be crowded out of the result window by old completed matches.
    assert.equal(searchUrls.length, 1);
    const jql = decodeURIComponent(searchUrls[0]).replace(/\+/g, " "); // URLSearchParams encodes spaces as "+"
    assert.ok(jql.includes("statusCategory != Done"), `JQL must exclude Done: ${jql}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTicket: a non-Done same-summary ticket IS still returned as a duplicate", async () => {
  const originalFetch = globalThis.fetch;
  const posts = [];

  const SUMMARY = "Escalation: ship-review not converging (TEAM-1)";

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (url.includes("/rest/api/3/search/jql")) {
      return new Response(
        JSON.stringify({
          issues: [
            {
              key: "TEAM-10",
              fields: { summary: SUMMARY, status: { name: "To Do" }, labels: ["wf:run1"], issuetype: { name: "Task" } },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      posts.push(url);
      return new Response(JSON.stringify({ key: "TEAM-11" }), { status: 201 });
    }
    // reconcileBlockersAndStatus with no blockers/assignee makes no other calls.
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: SUMMARY, workflow_id: "run1" },
    });
    assert.equal(posts.length, 0, "a live duplicate must not trigger a create");
    assert.equal(result.ticketId, "TEAM-10");
    assert.ok(result.deduplicated, "expected the live duplicate to be flagged deduplicated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── getIssue accepts the gateway `ticket_id` param ──────────────────────────────

test("handler(Tickets___get_issue) accepts ticket_id and hits Jira with the real key", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];

  globalThis.fetch = async (url) => {
    requested.push(url);
    if (url.includes("/comment")) {
      return new Response(JSON.stringify({ comments: [], total: 0, startAt: 0, maxResults: 50 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        key: "TEAM-123",
        fields: { summary: "Gateway direct", status: { name: "In Review" }, labels: ["wf:run9"], issuetype: { name: "Task" } },
      }),
      { status: 200 }
    );
  };

  try {
    const result = await handler({
      tool_name: "Tickets___get_issue",
      parameters: { ticket_id: "TEAM-123" },
    });
    const issueUrl = requested.find((u) => !u.includes("/comment"));
    assert.ok(issueUrl.includes("/rest/api/3/issue/TEAM-123"), `expected TEAM-123 in issue URL, got ${issueUrl}`);
    assert.ok(!/\/issue\/undefined/.test(issueUrl), `issue key must not be undefined: ${issueUrl}`);
    assert.equal(result.ticketId, "TEAM-123");
    assert.equal(result.title, "Gateway direct");
    assert.ok(!result.error, `expected a result, got error: ${result.error}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4113: spawned_by → fix:<kind> label on create ─────────────────────────

test("createTicket: spawned_by {kind:'qa_fix'} adds a fix:qa_fix label to the POST", async () => {
  const originalFetch = globalThis.fetch;
  let postedFields = null;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (url.includes("/rest/api/3/search/jql")) {
      return new Response(JSON.stringify({ issues: [] }), { status: 200 }); // no dedupe hit
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      postedFields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ key: "TEAM-77" }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "Fix flaky login test",
        workflow_id: "run1",
        assignee: "agentcore_hub_backend_dev",
        spawned_by: { kind: "qa_fix" },
      },
    });
    assert.equal(result.ticketId, "TEAM-77");
    assert.ok(postedFields, "expected a create POST");
    assert.ok(postedFields.labels.includes("fix:qa_fix"), `expected fix:qa_fix label, got ${JSON.stringify(postedFields.labels)}`);
    // The wf + agent labels must survive alongside it.
    assert.ok(postedFields.labels.includes("wf:run1"));
    assert.ok(postedFields.labels.includes("agent:agentcore_hub_backend_dev"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTicket: spawned_by with an unknown kind is dropped (no fix: label)", async () => {
  const originalFetch = globalThis.fetch;
  let postedFields = null;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (url.includes("/rest/api/3/search/jql")) {
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      postedFields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ key: "TEAM-78" }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "Something",
        workflow_id: "run1",
        spawned_by: { kind: "not_a_real_kind" },
      },
    });
    assert.ok(postedFields, "expected a create POST");
    assert.ok(!postedFields.labels.some((l) => l.startsWith("fix:")), `no fix: label expected, got ${JSON.stringify(postedFields.labels)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4121 FR-8: the fix contract in Jira mode ──────────────────────────────
//
// Jira has no arbitrary columns, so the contract rides two carriers:
//   labels      — fix:<kind> origin:<id> evidence:<src> phase:<p>
//                 contract:incomplete  (the machine-readable index the
//                 orchestrator's mapJiraIssueToTicket reads back)
//   description — the `# fix-contract v1` block, rendered as a yaml codeBlock
//                 ahead of the prose (the human/agent-readable copy)
// Both must survive the round trip, and mode=off must add neither.
//
// FIX_TICKET_CONTRACT is snapshotted at module load, so each mode needs its own
// module instance: a cache-busting query on the specifier gives us one without a
// test-runner module registry (node --test has no vi.resetModules()).

let loadSeq = 0;
async function loadWithMode(mode) {
  if (mode === undefined) delete process.env.FIX_TICKET_CONTRACT;
  else process.env.FIX_TICKET_CONTRACT = mode;
  // No ARTIFACT_BUCKET → the fresh instance takes the fallback roster + fallback
  // phase set with no S3 call, so the F7 rejection asserts against a fixed
  // phase list wherever this runs.
  delete process.env.ARTIFACT_BUCKET;
  return import(`./index.mjs?fix-contract-mode=${mode ?? "unset"}-${loadSeq++}`);
}

/**
 * Route Jira's REST surface for a create: no dedupe hit, capture the POST.
 * Returns the capture object plus a restore(); every test restores in `finally`.
 */
function captureCreate({ createdKey = "TEAM-500" } = {}) {
  const cap = { posts: [], searches: [], fields: null, restore: null };
  const originalFetch = globalThis.fetch;
  cap.restore = () => { globalThis.fetch = originalFetch; };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const u = String(url);
    if (u.includes("/rest/api/3/search/jql")) {
      cap.searches.push(u);
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    }
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      cap.posts.push(u);
      cap.fields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ key: createdKey }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return cap;
}

/** The ship_fix a release manager files, with a contract that satisfies every rule. */
const SHIP_FIX = {
  summary: "Fix (ship): auth — expired token 500s",
  description: "The final diff regresses the expired-token path.",
  workflow_id: "run1",
  assignee: "agentcore_hub_backend_dev",
  phase: "ship",
  spawned_by: { kind: "ship_fix", shipTicketId: "TEAM-50" },
  fix_contract: {
    invariant: "an expired token yields 401, never 500",
    evidence_source: "live",
    evidence_repro: "curl -H 'Authorization: Bearer expired' /api/me",
    cited_location: "src/auth.ts:88, src/auth.ts:120-134",
    sibling_scope: "do not touch the session store",
  },
};

/** JQL as Jira receives it (URLSearchParams encodes spaces as "+"). */
const jqlOf = (searchUrl) => decodeURIComponent(searchUrl.split("jql=")[1].split("&")[0]).replace(/\+/g, " ");

test("FR-8 enforce: a complete contract becomes labels + a yaml codeBlock description", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: SHIP_FIX });
    assert.equal(result.ticketId, "TEAM-500", `expected a create, got ${JSON.stringify(result)}`);
    assert.equal(cap.posts.length, 1);

    // The label index — every field the orchestrator reads back.
    const labels = cap.fields.labels;
    assert.ok(labels.includes("fix:ship_fix"), JSON.stringify(labels));
    assert.ok(labels.includes("origin:TEAM-50"), JSON.stringify(labels));
    assert.ok(labels.includes("evidence:live"), JSON.stringify(labels));
    assert.ok(labels.includes("phase:ship"), JSON.stringify(labels));
    assert.ok(!labels.includes("contract:incomplete"));
    // …alongside the pre-existing routing labels.
    assert.ok(labels.includes("wf:run1"));
    assert.ok(labels.includes("agent:agentcore_hub_backend_dev"));

    // The description: contract block FIRST as a codeBlock, prose after.
    const content = cap.fields.description.content;
    assert.deepEqual(content.map((n) => n.type), ["codeBlock", "paragraph"]);
    assert.equal(content[0].attrs.language, "yaml");
    assert.ok(content[0].content[0].text.startsWith("# fix-contract v1"));
    assert.equal(content[1].content[0].text, SHIP_FIX.description);
  } finally {
    cap.restore();
  }
});

test("FR-8: adfToText(description) → parseFixContractBlock round-trips, rest === the prose", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    await h({ tool_name: "Tickets___create_ticket", parameters: SHIP_FIX });

    // Exactly the path the orchestrator takes: flatten the ADF, then parse.
    const parsed = parseFixContractBlock(adfToText(cap.fields.description));
    assert.ok(parsed, "the rendered block must parse back out of the flattened ADF");
    assert.equal(parsed.kind, "ship_fix");
    assert.equal(parsed.originId, "TEAM-50");
    assert.equal(parsed.phase, "ship");
    assert.equal(parsed.contract.invariant, SHIP_FIX.fix_contract.invariant);
    assert.equal(parsed.contract.evidenceSource, "live");
    assert.equal(parsed.contract.evidenceRepro, SHIP_FIX.fix_contract.evidence_repro);
    assert.deepEqual(parsed.contract.citedLocation, ["src/auth.ts:88", "src/auth.ts:120-134"]);
    assert.equal(parsed.contract.siblingScope, "do not touch the session store");
    // The block is metadata, not the body — the prose comes back intact and alone.
    assert.equal(parsed.rest, SHIP_FIX.description);
  } finally {
    cap.restore();
  }
});

test("FR-8 shadow: an incomplete contract is accepted and marked contract:incomplete", async () => {
  const { handler: h } = await loadWithMode("shadow");
  const cap = captureCreate();
  try {
    const result = await h({
      tool_name: "Tickets___create_ticket",
      parameters: { ...SHIP_FIX, fix_contract: { invariant: "an expired token yields 401, never 500" } },
    });
    assert.equal(result.ticketId, "TEAM-500");
    const labels = cap.fields.labels;
    assert.ok(labels.includes("contract:incomplete"), JSON.stringify(labels));
    assert.ok(labels.includes("fix:ship_fix"));
    assert.ok(labels.includes("origin:TEAM-50"));
    assert.ok(labels.includes("phase:ship"));
    // No evidence_source parsed → no evidence: label to index on.
    assert.ok(!labels.some((l) => l.startsWith("evidence:")), JSON.stringify(labels));
    // The partial contract still ships in the description — the dev gets the one
    // field the author did fill in rather than nothing.
    const parsed = parseFixContractBlock(adfToText(cap.fields.description));
    assert.equal(parsed.contract.invariant, "an expired token yields 401, never 500");
    assert.equal(parsed.contract.evidenceSource, null);
  } finally {
    cap.restore();
  }
});

test("FR-8 enforce: an incomplete contract is refused and NOTHING is created in Jira", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    const result = await h({
      tool_name: "Tickets___create_ticket",
      parameters: { ...SHIP_FIX, fix_contract: { evidence_source: "live", evidence_repro: "curl /api/me", cited_location: "src/auth.ts:88" } },
    });
    assert.equal(result.error, "'invariant' is required on a fix ticket (missing: invariant)");
    assert.equal(cap.posts.length, 0, "a refused fix ticket must leave no issue behind");
    // Validation precedes the dedupe search too — no Jira traffic at all.
    assert.equal(cap.searches.length, 0);
  } finally {
    cap.restore();
  }
});

test("FR-8 off: labels carry fix:/phase: only and the description stays a plain paragraph", async () => {
  const { handler: h } = await loadWithMode(undefined);
  const cap = captureCreate();
  try {
    // Even a wildly incomplete contract is accepted: off means the field is not
    // read at all.
    await h({ tool_name: "Tickets___create_ticket", parameters: { ...SHIP_FIX, fix_contract: { invariant: "" } } });
    const labels = cap.fields.labels;
    assert.deepEqual(
      labels.filter((l) => /^(fix|origin|evidence|contract|phase):/.test(l)),
      // `phase:` is emitted in every mode — a dropped phase stamp is the F7
      // completion-gate hole, a defect fix rather than a contract feature. The
      // contract INDEX labels (origin:/evidence:/contract:) are flag-gated.
      ["fix:ship_fix", "phase:ship"]
    );
    assert.deepEqual(cap.fields.description.content.map((n) => n.type), ["paragraph"]);
    assert.equal(cap.fields.description.content[0].content[0].text, SHIP_FIX.description);
  } finally {
    cap.restore();
  }
});

test("FR-8 F7: a fix ticket with an unknown phase is refused, with the tickets-Lambda wording", async () => {
  const { handler: h } = await loadWithMode("shadow");
  const cap = captureCreate();
  try {
    const result = await h({
      tool_name: "Tickets___create_ticket",
      parameters: { ...SHIP_FIX, phase: "zz_nonexistent" },
    });
    // Byte-identical message to the DynamoDB Lambda's: an agent gets the same
    // instruction whichever provider is deployed.
    assert.match(result.error, /^'phase' "zz_nonexistent" is not a known workflow phase/);
    assert.match(result.error, /invisible to the completion open-fix gate/);
    assert.match(result.error, /Valid phases: .*development.*/);
    assert.equal(cap.posts.length, 0);
  } finally {
    cap.restore();
  }
});

test("FR-8: caller labels are sanitized — a forged system label never reaches Jira", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    await h({
      tool_name: "Tickets___create_ticket",
      parameters: { ...SHIP_FIX, labels: "advisory, fix:review_fix, WF:other, needs docs" },
    });
    const labels = cap.fields.labels;
    assert.ok(labels.includes("needs-docs"), `expected the normalized label, got ${JSON.stringify(labels)}`);
    // The forged provenance labels are gone; the Lambda's own stay.
    assert.ok(!labels.includes("fix:review_fix"), JSON.stringify(labels));
    assert.ok(labels.includes("fix:ship_fix"));
    assert.deepEqual(labels.filter((l) => l.startsWith("wf:")), ["wf:run1"]);
    // TEAM-4131 F2: this is a ship_fix, so `advisory` is RESERVED and dropped —
    // it would otherwise remove the fix from every completion gate under
    // ADVISORY_ROUTING=enforce. Both provider twins must reach the same decision,
    // so the byte-identical assertion lives in the DynamoDB Lambda's suite too.
    assert.ok(!labels.includes("advisory"), JSON.stringify(labels));
  } finally {
    cap.restore();
  }
});

test("TEAM-4131 F2: `advisory` survives on a NON-fix ticket — the guard is per ticket shape, not global", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    await h({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "Rename the legacy columns",
        workflow_id: "run1",
        assignee: "agentcore_hub_backend_dev",
        phase: "development",
        labels: "advisory, needs docs",
      },
    });
    assert.ok(cap.fields.labels.includes("advisory"), JSON.stringify(cap.fields.labels));
  } finally {
    cap.restore();
  }
});

test("TEAM-4131 F2: a HUMAN GATE ticket cannot be labelled advisory", async () => {
  const { handler: h } = await loadWithMode("enforce");
  const cap = captureCreate();
  try {
    await h({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "Merge Approval",
        workflow_id: "run1",
        assignee: "human:reviewer",
        phase: "ship",
        labels: "advisory",
      },
    });
    assert.ok(!cap.fields.labels.includes("advisory"), JSON.stringify(cap.fields.labels));
  } finally {
    cap.restore();
  }
});

// ─── F6: JQL injection ──────────────────────────────────────────────────────────

test("F6: a workflow_id that is not a hub id is refused before any JQL is built", async () => {
  const cap = captureCreate();
  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: "x", workflow_id: 'run1" OR labels = "wf:other' },
    });
    assert.match(result.error, /^Invalid 'workflow_id'/);
    assert.equal(cap.searches.length, 0);
    assert.equal(cap.posts.length, 0, "a refused workflow_id must not create anything");
  } finally {
    cap.restore();
  }
});

test("F6: a summary containing a quote and a backslash is escaped inside the JQL literal", async () => {
  const cap = captureCreate();
  try {
    // The adversarial shape: closing the literal would append `OR project = OTHER`
    // to the dedupe query and let an unrelated ticket be returned as a duplicate.
    const summary = 'He said "hi" \\ bye" OR project = OTHER';
    await handler({ tool_name: "Tickets___create_ticket", parameters: { summary, workflow_id: "run1" } });
    assert.equal(cap.searches.length, 1);
    const jql = jqlOf(cap.searches[0]);
    // Backslash escaped FIRST, then the quote — the reverse order would let the
    // escape of a literal `\"` be swallowed and re-open the injection.
    assert.ok(
      jql.includes('He said \\"hi\\" \\\\ bye\\" OR project = OTHER'),
      `summary not escaped in JQL: ${jql}`
    );
    // No bare quote survives to terminate the operand.
    assert.ok(!jql.includes('He said "hi"'), `unescaped quote reached the JQL: ${jql}`);
  } finally {
    cap.restore();
  }
});

test("F6: list_tickets refuses a parent_id that is not an issue key (unquoted operand)", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ issues: [] }), { status: 200 }); };
  try {
    const result = await handler({
      tool_name: "Tickets___list_tickets",
      parameters: { parent_id: "TEAM-1 OR project = OTHER" },
    });
    assert.match(result.error, /^Invalid 'parent_id'/);
    assert.equal(calls.length, 0, "the widened query must never be issued");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("F6: lookup_user escapes the agent query inside its quoted JQL literal", async () => {
  const searches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    searches.push(String(url));
    return new Response(JSON.stringify({ issues: [] }), { status: 200 });
  };
  try {
    await handler({ tool_name: "Tickets___lookup_user", parameters: { query: 'bob" OR x' } });
    assert.ok(searches.length > 0, "expected a search");
    const jql = jqlOf(searches[0]);
    assert.ok(jql.includes('labels in ("agent:bob\\" OR x")'), `query not escaped: ${jql}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4122 FR-5: labels_add, the op name the orchestrator sends ────────────

/**
 * `Tickets___labels_add` is how the orchestrator marks a CI-uncertifiable run's
 * epic, and it does not know which provider is deployed — so this op name and
 * this parameter envelope (`ticket_id` AND `issue_key`, both spelled out) must
 * work identically here and in the dynamodb Lambda, whose index.test.mjs
 * asserts the twin.
 *
 * The invariant that matters is the VERB: `update: {labels:[{add}]}`, never
 * `fields: {labels:[…]}` — the field form is a whole-list replace that would
 * drop every label the pipeline already set (`wf:`, `phase:`, `human-review`…).
 */
test("labels_add: PUTs the additive update verb for ci:uncertifiable", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(null, { status: 204 });
  };
  try {
    const result = await handler({
      tool_name: "Tickets___labels_add",
      parameters: { ticket_id: "EPIC-1", issue_key: "EPIC-1", labels: ["ci:uncertifiable"] },
    });

    assert.equal(result.error, undefined, "the op must be dispatched, not fall through to unknown-tool");
    assert.deepEqual(result, { ticketId: "EPIC-1", status: "labels_added", added: ["ci:uncertifiable"] });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, "PUT");
    assert.ok(calls[0].url.endsWith("/rest/api/3/issue/EPIC-1"), `wrong path: ${calls[0].url}`);
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body, { update: { labels: [{ add: "ci:uncertifiable" }] } });
    // A whole-list replace would silently drop concurrent labels.
    assert.equal(body.fields, undefined, "must not use the fields form (whole-list replace)");
    // Jira rejects a label containing whitespace and fails the WHOLE PUT, so the
    // prose form of this warning is not a legal label on either provider.
    assert.ok(!/\s/.test(body.update.labels[0].add));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("labels_add: issue_key alone is accepted (the dynamodb spelling)", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return new Response(null, { status: 204 }); };
  try {
    const result = await handler({
      tool_name: "Tickets___labels_add",
      parameters: { issue_key: "EPIC-9", labels: ["ci:uncertifiable"] },
    });
    assert.equal(result.ticketId, "EPIC-9");
    assert.ok(calls[0].url.endsWith("/rest/api/3/issue/EPIC-9"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * The failure envelope the orchestrator has to recognize: a rejected label comes
 * back as a BARE `{ error }` with no `content` field, which is why
 * labelEpicUncertifiable inspects the payload rather than trusting a clean
 * return (ci-check-context.test.mjs asserts the orchestrator half).
 */
test("labels_add: a rejected PUT surfaces as a bare { error }, and nothing is reported added", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ errorMessages: ["label is not valid"] }), { status: 400 });
  try {
    const result = await handler({
      tool_name: "Tickets___labels_add",
      parameters: { ticket_id: "EPIC-1", labels: ["ci:uncertifiable"] },
    });
    assert.ok(result.error, `expected an error field, got ${JSON.stringify(result)}`);
    assert.equal(result.status, undefined);
    assert.equal(result.content, undefined, "no content field — this is the shape the orchestrator must check for");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4248 D3: create_ticket's unblocked-non-root guard ─────────────────────
//
// Production runs THIS Lambda (`deploy/runtime-agent/deploy-one.sh:226` deploys
// the fleet with TICKET_TOOLS_LAMBDA=agentcore-hub-jira; c2uqki's dossier records
// ticketProvider: "jira"), so the guard has to hold here or FR-D3.1 is a no-op.
//
// c2uqki: TEAM-4230 (code sweeper) was created with blocked_by=[] and invoked at
// 11:40:37.834Z — 92.3 s BEFORE requirements analyst TEAM-4229 published
// agent.complete. Nothing rejected it because nothing had ever looked at the
// graph. The root is found by ROLE (the `agent:` label for the analyst, or a
// `phase:requirements` stamp), never by "earliest child with no blockers": the
// hub mints the Intent Acceptance gate first, unblocked, and treating THAT as the
// root would exempt the first agent ticket after it.
//
// TICKET_PLAN_VALIDATOR is snapshotted at module load, so each mode gets its own
// instance via the cache-busting-specifier trick loadWithMode already uses.

let planSeq = 0;
async function loadWithPlanMode(mode) {
  if (mode === undefined) delete process.env.TICKET_PLAN_VALIDATOR;
  else process.env.TICKET_PLAN_VALIDATOR = mode;
  // Pinned off so a fix-contract advisory can never be mistaken for a plan one.
  process.env.FIX_TICKET_CONTRACT = "off";
  delete process.env.ARTIFACT_BUCKET;
  return import(`./index.mjs?plan-validator-mode=${mode ?? "unset"}-${planSeq++}`);
}

const D3_EPIC = "TEAM-4228";
/** The analyst's own ticket, still open — the root, by its agent: label. */
const D3_ROOT = {
  key: "TEAM-4229",
  fields: {
    summary: "Analyze dead-code-sweep requirements",
    status: { name: "In Progress" },
    labels: ["wf:c2uqki", "agent:agentcore_hub_requirements_analyst", "phase:requirements"],
    issuetype: { name: "Task" },
  },
};
/** The hub-created Intent Acceptance gate: earliest, unblocked, NOT the root. */
const D3_GATE = {
  key: "TEAM-4227",
  fields: {
    summary: "Intent Acceptance",
    status: { name: "In Review" },
    labels: ["wf:c2uqki", "reviewer:product-owner"],
    issuetype: { name: "Task" },
  },
};
/**
 * The offender as create_ticket receives it. c2uqki's real assignee was
 * `agentcore_hub_code_sweeper`, which exists only in the S3 roster overlay — with
 * no ARTIFACT_BUCKET this Lambda falls back to the core roster and would reject
 * it on assignee grounds before reaching the graph check. The check is
 * role-agnostic, so a core dev persona reproduces it exactly.
 */
const D3_SWEEPER = {
  summary: "Sweep tycenjmccann/ember for dead code",
  workflow_id: "c2uqki",
  assignee: "agentcore_hub_backend_dev",
  parent_key: D3_EPIC,
};

/**
 * Route Jira for a create under an epic whose children are `children`. The root
 * lookup and the dedupe check both hit /search/jql, so they are told apart by the
 * JQL itself (`parent = <key>` is the root lookup).
 */
function captureD3({ children = [], createdKey = "TEAM-4230" } = {}) {
  const cap = { posts: [], rootSearches: [], dedupeSearches: [], restore: null, fail: false };
  const originalFetch = globalThis.fetch;
  cap.restore = () => { globalThis.fetch = originalFetch; };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const u = String(url);
    if (u.includes("/rest/api/3/search/jql")) {
      const jql = decodeURIComponent(u.split("jql=")[1].split("&")[0]).replace(/\+/g, " ");
      if (jql.includes(`parent = ${D3_EPIC}`)) {
        cap.rootSearches.push(jql);
        if (cap.fail) return new Response("throttled", { status: 429 });
        return new Response(JSON.stringify({ issues: children }), { status: 200 });
      }
      cap.dedupeSearches.push(jql);
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    }
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      cap.posts.push(JSON.parse(options.body).fields);
      return new Response(JSON.stringify({ key: createdKey }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return cap;
}

test("D3 off: no root lookup at all, and the result gains no keys", async () => {
  const { handler: h } = await loadWithPlanMode("off");
  const cap = captureD3({ children: [D3_ROOT] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.equal(cap.rootSearches.length, 0, "off must not read the board");
    assert.equal(cap.posts.length, 1);
    assert.equal(result.ticketId, "TEAM-4230");
    assert.ok(!("warning" in result), JSON.stringify(result));
  } finally {
    cap.restore();
  }
});

test("D3 shadow: the ticket is created and the warning names TEAM-4230 and TEAM-4229", async () => {
  const { handler: h } = await loadWithPlanMode("shadow");
  const cap = captureD3({ children: [D3_ROOT] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.equal(cap.posts.length, 1, "shadow files the ticket");
    assert.equal(result.ticketId, "TEAM-4230");
    assert.ok(result.warning.includes("TEAM-4229"), result.warning);
    assert.ok(result.warning.includes(D3_SWEEPER.summary), result.warning);
    assert.equal(cap.rootSearches.length, 1, "one lookup per invocation, memoised");
  } finally {
    cap.restore();
  }
});

test("D3 enforce: the create is refused and NOTHING is POSTed to Jira", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const cap = captureD3({ children: [D3_ROOT] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.ok(result.error, JSON.stringify(result));
    assert.ok(result.error.includes("TEAM-4229"), result.error);
    assert.equal(cap.posts.length, 0, "enforce mints nothing");
  } finally {
    cap.restore();
  }
});

test("D3: the root is also found by a phase:requirements label alone", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const root = {
    ...D3_ROOT,
    fields: { ...D3_ROOT.fields, labels: ["wf:c2uqki", "agent:agentcore_hub_backend_designer", "phase:requirements"] },
  };
  const cap = captureD3({ children: [root] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.ok(result.error?.includes("TEAM-4229"), JSON.stringify(result));
  } finally {
    cap.restore();
  }
});

test("D3: an earlier unblocked human gate is NOT mistaken for the root", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const cap = captureD3({ children: [D3_GATE, D3_ROOT] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.ok(result.error?.includes("TEAM-4229"), JSON.stringify(result));
    assert.ok(!result.error.includes("TEAM-4227"), result.error);
  } finally {
    cap.restore();
  }
});

test("D3: no requirements root under the epic → fail open, silently", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const cap = captureD3({ children: [D3_GATE] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.equal(cap.posts.length, 1, "a bug-fix run has no requirements ticket and must still work");
    assert.ok(!("warning" in result), JSON.stringify(result));
  } finally {
    cap.restore();
  }
});

test("D3: a Done root fails open, so a late sibling is not rejected", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const done = { ...D3_ROOT, fields: { ...D3_ROOT.fields, status: { name: "Done" } } };
  const cap = captureD3({ children: [done] });
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.equal(cap.posts.length, 1);
    assert.ok(!("warning" in result), JSON.stringify(result));
  } finally {
    cap.restore();
  }
});

test("D3: the root itself, an advisory, rework, a chained ticket and a human gate are exempt", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const exempt = [
    { ...D3_SWEEPER, assignee: "agentcore_hub_requirements_analyst" }, // is the root
    { ...D3_SWEEPER, phase: "requirements" },                          // is the root, by stamp
    { ...D3_SWEEPER, labels: ["advisory"] },                           // declined scope
    { ...D3_SWEEPER, spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-4231" }, phase: "development" },
    { ...D3_SWEEPER, blocked_by: ["TEAM-4229"] },                      // already chained
    { ...D3_SWEEPER, assignee: "human:product-owner" },                // hub-created gate
    { ...D3_SWEEPER, parent_key: undefined },                          // no epic to look under
  ];
  for (const params of exempt) {
    const cap = captureD3({ children: [D3_ROOT] });
    try {
      const result = await h({ tool_name: "Tickets___create_ticket", parameters: params });
      assert.equal(cap.posts.length, 1, `expected a create for ${JSON.stringify(params)}: ${JSON.stringify(result)}`);
      assert.ok(
        !(result.warning || "").includes("blocked_by=[]"),
        `${JSON.stringify(params)} → ${result.warning}`,
      );
    } finally {
      cap.restore();
    }
  }
});

test("D3: a failed board read fails open rather than blocking the run", async () => {
  const { handler: h } = await loadWithPlanMode("enforce");
  const cap = captureD3({ children: [D3_ROOT] });
  cap.fail = true; // Jira 429s the lookup
  try {
    const result = await h({ tool_name: "Tickets___create_ticket", parameters: D3_SWEEPER });
    assert.equal(cap.posts.length, 1, `a throttled lookup must not stop a create: ${JSON.stringify(result)}`);
    assert.ok(!("warning" in result), JSON.stringify(result));
  } finally {
    cap.restore();
  }
});
