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

import { adfToText, getIssue, handler, clampSummary } from "./index.mjs";
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

// ─── DL-024: transition_ticket blocked_by + get_issue blockedBy ────────────────

/**
 * Stateful Jira stub for transition_ticket: records issueLink POSTs, comment
 * POSTs and transition POSTs; serves a transition list that includes Blocked.
 */
function installTransitionStub({ failLinkFor = [], preLinked = [] } = {}) {
  const calls = { links: [], comments: [], transitions: [] };
  const linked = new Set(preLinked); // inward Blocks links Jira would report on the ticket
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (url.endsWith("/rest/api/3/issueLink") && method === "POST") {
      const body = JSON.parse(init.body);
      calls.links.push(body);
      if (failLinkFor.includes(body.inwardIssue.key)) {
        return new Response(JSON.stringify({ errorMessages: ["Issue link already exists."] }), { status: 400 });
      }
      linked.add(body.inwardIssue.key);
      return new Response("", { status: 201 });
    }
    if (url.includes("/rest/api/3/issue/") && url.includes("fields=issuelinks") && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-24", fields: {
        issuelinks: [...linked].map((k) => ({ type: { name: "Blocks" }, inwardIssue: { key: k } })),
      } }), { status: 200 });
    }
    if (url.includes("/comment") && method === "POST") {
      calls.comments.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "1" }), { status: 201 });
    }
    if (url.includes("/transitions") && method === "GET") {
      return new Response(JSON.stringify({ transitions: [
        { id: "11", name: "Blocked", to: { name: "Blocked" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ] }), { status: 200 });
    }
    if (url.includes("/transitions") && method === "POST") {
      calls.transitions.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return calls;
}

test("transition_ticket: blocked_by links each blocker as Blocks BEFORE the transition (agent self-park)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub();
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-24", transition_id: "blocked", reason: "ship-review r1: waiting on 2 fixes", blocked_by: "TEAM-30, TEAM-31,TEAM-30" },
    });
    assert.equal(res.status, "blocked");
    assert.deepEqual(res.blockedByAdded, ["TEAM-30", "TEAM-31"]); // deduped, trimmed
    // blocker → ticket, one link per key
    assert.deepEqual(
      calls.links.map((l) => [l.type.name, l.inwardIssue.key, l.outwardIssue.key]),
      [["Blocks", "TEAM-30", "TEAM-24"], ["Blocks", "TEAM-31", "TEAM-24"]]
    );
    assert.deepEqual(calls.transitions, [{ transition: { id: "11" } }]);
    assert.equal(calls.comments.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: blocked_by accepts an array; a duplicate-link 400 on an ALREADY-linked blocker is not fatal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ failLinkFor: ["TEAM-30"], preLinked: ["TEAM-30"] });
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-24", transition_id: "blocked", blocked_by: ["TEAM-30", "TEAM-31"] },
    });
    assert.equal(res.status, "blocked");
    assert.equal(calls.links.length, 2);
    assert.equal(calls.transitions.length, 1, "the transition still happens: the link exists, the 400 was a duplicate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: a blocker that could NOT be linked aborts the transition (no Blocked-with-no-edge parking)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ failLinkFor: ["TEAM-999"] }); // e.g. a nonexistent key
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-24", transition_id: "blocked", blocked_by: "TEAM-30,TEAM-999" },
    });
    assert.match(res.error, /could not link TEAM-999/);
    assert.match(res.error, /NOT transitioned/);
    assert.equal(calls.links.length, 2);
    assert.deepEqual(calls.transitions, [], "no transition when a requested blocker is missing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: without blocked_by the call is unchanged (no issueLink traffic, no blockedByAdded)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub();
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-24", transition_id: "blocked" },
    });
    assert.equal(res.status, "blocked");
    assert.equal("blockedByAdded" in res, false);
    assert.deepEqual(calls.links, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: a malformed blocked_by entry is rejected before any Jira write", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub();
  try {
    // The handler converts throws into a bare { error } for the tool caller.
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", blocked_by: "TEAM-30,not a key" } });
    assert.match(res.error, /Invalid blocked_by entry/);
    assert.deepEqual(calls.links, []);
    assert.deepEqual(calls.transitions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getIssue: requests issuelinks and returns blockedBy from the inward side of Blocks links", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (url.includes("/comment")) return new Response(JSON.stringify({ comments: [] }), { status: 200 });
    return new Response(JSON.stringify({
      key: "TEAM-24",
      fields: {
        summary: "Ship", status: { name: "Blocked" }, labels: ["agent:agentcore_hub_release_manager"], issuetype: { name: "Task" },
        issuelinks: [
          { type: { name: "Blocks" }, inwardIssue: { key: "TEAM-30" } },   // TEAM-30 blocks TEAM-24
          { type: { name: "Blocks" }, outwardIssue: { key: "TEAM-40" } },  // TEAM-24 blocks TEAM-40 — not a blocker of ours
          { type: { name: "Relates" }, inwardIssue: { key: "TEAM-50" } },  // unrelated link type
        ],
      },
    }), { status: 200 });
  };
  try {
    const result = await getIssue({ issue_key: "TEAM-24" });
    assert.deepEqual(result.blockedBy, ["TEAM-30"]);
    assert.equal(result.assignee, "agentcore_hub_release_manager");
    const issueUrl = requested.find((u) => !u.includes("/comment"));
    assert.ok(/fields=[^&]*issuelinks/.test(issueUrl), `issue GET should request issuelinks: ${issueUrl}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4537: summary clamp — Jira 400s "Summary can't exceed 255 characters" ─
//
// wf_1789190697687_fxrs67 / epic TEAM-4518: a self-improvement run's
// auto-generated title exceeded 255 chars and the create died with a Jira 400.
// The bug-intake path in the orchestrator already clamps; this Lambda's general
// create/update paths did not.

const LONG_TITLE = "A".repeat(200) + " " + "B".repeat(200); // 401 chars, one space near the middle
const LONG_DESCRIPTION = "The full text must survive in the description even though the title is long. " + "x".repeat(300);
// TEAM-4537: pinned so the Jira Lambda and the DynamoDB twin
// (lambda/agentcore-hub-tickets/index.test.mjs) are asserted against the
// IDENTICAL clamped string for the IDENTICAL input — a drift in either
// clampSummary() copy fails a test instead of silently diverging.
const EXPECTED_CLAMPED_LONG_TITLE = "A".repeat(200) + "…";

test("createTicket: a >255-char summary is clamped to <=255 chars on the create POST, description kept in full", async () => {
  const cap = captureCreate({ createdKey: "TEAM-900" });
  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: LONG_TITLE, description: LONG_DESCRIPTION, workflow_id: "run1" },
    });
    assert.equal(result.ticketId, "TEAM-900");
    assert.ok(cap.fields, "expected a create POST");
    assert.ok(cap.fields.summary.length <= 255, `summary too long: ${cap.fields.summary.length} chars`);
    assert.ok(/\S$/.test(cap.fields.summary), "summary must not end in whitespace");
    assert.equal(cap.fields.summary, EXPECTED_CLAMPED_LONG_TITLE);
    assert.ok(LONG_TITLE.startsWith(cap.fields.summary.replace(/…$/, "")), "clamped summary must be a prefix of the original title");
    const description = cap.fields.description.content[0].content[0].text;
    assert.equal(description, LONG_DESCRIPTION, "description must carry the full text, unclamped");
  } finally {
    cap.restore();
  }
});

test("createTicket: dedupe on a long summary matches against the CLAMPED stored summary, not the raw one", async () => {
  const originalFetch = globalThis.fetch;
  const clamped = clampSummary(LONG_TITLE);
  let posted = false;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const u = String(url);
    if (u.includes("/rest/api/3/search/jql")) {
      // The prior create for this same long title stored the CLAMPED summary.
      return new Response(JSON.stringify({
        issues: [{
          key: "TEAM-901",
          fields: { summary: clamped, status: { name: "To Do" }, labels: ["wf:run1"], issuetype: { name: "Task" } },
        }],
      }), { status: 200 });
    }
    if (u.includes("/transitions")) return new Response(JSON.stringify({ transitions: [] }), { status: 200 });
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      posted = true;
      return new Response(JSON.stringify({ key: "TEAM-902" }), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    const result = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: LONG_TITLE, workflow_id: "run1" },
    });
    assert.equal(result.deduplicated, true, "the retried create of the same long title must dedupe, not duplicate");
    assert.equal(result.ticketId, "TEAM-901");
    assert.ok(!posted, "no new issue should be created on a dedupe hit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("updateTicket: a >255-char title is clamped on the PUT", async () => {
  const originalFetch = globalThis.fetch;
  let putFields = null;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method === "PUT") {
      putFields = JSON.parse(options.body).fields;
      return new Response("", { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    await handler({
      tool_name: "Tickets___update_ticket",
      parameters: { ticket_id: "TEAM-903", title: LONG_TITLE },
    });
    assert.ok(putFields, "expected a PUT");
    assert.ok(putFields.summary.length <= 255, `summary too long: ${putFields.summary.length} chars`);
    assert.ok(/\S$/.test(putFields.summary), "summary must not end in whitespace");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-4537 review P2: the clamp must never split a surrogate pair ──────────
//
// slice() counts UTF-16 code units, so cutting at 254 can land between the high
// and low surrogate of an astral character (emoji, astral CJK) and ship a lone
// high surrogate to Jira — the length passes but the visible title is corrupted.
// Table-driven so every boundary the rule has is pinned in one place.

const ASTRAL_TITLE = "x" + "😀".repeat(128);                    // 257 code units, cut falls mid-pair
const EXPECTED_CLAMPED_ASTRAL = "x" + "😀".repeat(126) + "…";  // 254 code units, whole code points only

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const CLAMP_CASES = [
  { name: "exactly 255 chars passes through untouched", input: "A".repeat(255), expected: "A".repeat(255) },
  { name: "256 chars is clamped", input: "A".repeat(256), expected: "A".repeat(254) + "…" },
  { name: "no whitespace anywhere still clamps (hard cut, 200-char floor)", input: "A".repeat(300), expected: "A".repeat(254) + "…" },
  // Last space sits at index 150, below the 200 floor → hard cut, not a word cut.
  { name: "last space before the 200 floor falls back to a hard cut", input: "A".repeat(150) + " " + "B".repeat(200), expected: "A".repeat(150) + " " + "B".repeat(103) + "…" },
  { name: "space at exactly the 200 floor is used as the word boundary", input: "A".repeat(200) + " " + "B".repeat(200), expected: "A".repeat(200) + "…" },
  { name: "runs of spaces before the cut leave no trailing whitespace", input: "A".repeat(240) + "   " + "B".repeat(100), expected: "A".repeat(240) + "…" },
  // lastIndexOf(" ") does not match tab/newline, so this is a hard cut; trimEnd
  // still guarantees no trailing whitespace whichever branch ran.
  { name: "tab/newline before the cut still yields no trailing whitespace", input: "A".repeat(240) + "\t\n" + "B".repeat(100), expected: "A".repeat(240) + "\t\n" + "B".repeat(12) + "…" },
  { name: "astral boundary: never emits a lone surrogate", input: ASTRAL_TITLE, expected: EXPECTED_CLAMPED_ASTRAL },
];

for (const c of CLAMP_CASES) {
  test(`clampSummary: ${c.name}`, () => {
    const out = clampSummary(c.input);
    assert.equal(out, c.expected);
    assert.ok(out.length <= 255, `must be <=255 code units, got ${out.length}`);
    assert.ok(!LONE_SURROGATE.test(out), "must not contain an unpaired surrogate");
    if (out !== c.input) assert.ok(/\S$/.test(out), "must not end in whitespace");
  });
}

// ─── TEAM-4706 (DL-030): a ship-phase ticket cannot go Done with no record ─────
//
// The record at s3://$ARTIFACT_BUCKET/completions/<ticket_id>.json, written by
// lambda/workflow-output's report_completion BEFORE it asks this Lambda for the
// transition, is the only durable statement of what actually shipped — the run's
// completion gates, its KPIs and the deploy audit trail all read it. A ship ticket
// closed by hand leaves them with nothing.
//
// The rails that keep the gate from becoming a deadlock are as load-bearing as the
// gate itself, and each has a test here: human gates are exempt (the hub UI's
// approve and the Telegram bridge's ✅ transition through this same tool without
// writing a record), non-ship tickets are untouched, and an indeterminate S3 answer
// refuses rather than assumes (DL-028's positive-evidence rule).
//
// The DynamoDB twin (lambda/agentcore-hub-tickets/index.test.mjs) asserts the
// identical behaviour in that provider's idiom — a returned object rather than a
// throw the handler maps to `{ error }`.

const SHIP_TICKET = "TEAM-4066";
const SHIP_RECORD_KEY = `completions/${SHIP_TICKET}.json`;
const COMPLETION_HINT =
  "call WorkflowOutput___report_completion(ticket_id=…) — it writes the record and transitions the ticket for you";

/** The roster as config/agents.json serves it (agentId → phase). */
const SHIP_ROSTER = {
  agents: [
    { agentId: "agentcore_hub_release_manager", phase: "ship" },
    { agentId: "agentcore_hub_backend_dev", phase: "development" },
  ],
};

/**
 * A fresh module instance WITH an artifact bucket (ARTIFACT_BUCKET is read at
 * module load), plus a stub on its exported S3 client: `node --test` has no module
 * registry to mock, so the client itself is the seam. Returns the module and the
 * recorded S3 traffic — `records` is the completion-record read.
 *
 * TEAM-4757: the gate GETs the record's body, so the record read and the roster read
 * are both GetObject and the KEY PREFIX separates them (it used to be the command
 * type). `records` lists the keys that exist and serves each a pre-TEAM-4756 body —
 * neither followUpsPending nor status — which is what every test written before that
 * field existed assumed. `recordBodies[key]` overrides with a RAW STRING, so a
 * pending record, a non-JSON body and an empty body are all expressible.
 */
async function loadShipGate({ records = [], recordBodies = {}, recordError = null, bucket = "test-bucket" } = {}) {
  process.env.ARTIFACT_BUCKET = bucket;
  const mod = await import(`./index.mjs?ship-gate=${loadSeq++}`);
  const s3Calls = { records: [], gets: [] };
  mod.s3.send = async (cmd) => {
    const key = cmd?.input?.Key;
    if (String(key).startsWith("completions/")) {
      s3Calls.records.push(key);
      if (recordError) throw recordError;
      if (!(key in recordBodies) && !records.includes(key)) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      const body =
        key in recordBodies
          ? recordBodies[key]
          : JSON.stringify({ ticketId: key.slice("completions/".length).replace(/\.json$/, ""), summary: "shipped" });
      return { Body: { transformToString: async () => body } };
    }
    s3Calls.gets.push(key);
    if (key === "config/agents.json") {
      return { Body: { transformToString: async () => JSON.stringify(SHIP_ROSTER) } };
    }
    const err = new Error(`NoSuchKey: ${key}`);
    err.name = "NoSuchKey";
    throw err;
  };
  return { mod, s3Calls };
}

/**
 * Jira stub for a Done transition: serves the `?fields=labels` read the gate makes,
 * a transition list containing Done, and records every POST so a refusal can be
 * proven to have written NOTHING.
 */
function installDoneStub({ labels = [], ticketId = SHIP_TICKET } = {}) {
  const calls = { labelReads: [], transitions: [], comments: [], restore: null };
  const originalFetch = globalThis.fetch;
  calls.restore = () => { globalThis.fetch = originalFetch; };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("fields=labels") && method === "GET") {
      calls.labelReads.push(u);
      return new Response(JSON.stringify({ key: ticketId, fields: { labels } }), { status: 200 });
    }
    if (u.includes("/transitions") && method === "GET") {
      return new Response(JSON.stringify({ transitions: [
        { id: "11", name: "Blocked", to: { name: "Blocked" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ] }), { status: 200 });
    }
    if (u.includes("/transitions") && method === "POST") {
      calls.transitions.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/comment") && method === "POST") {
      calls.comments.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "1" }), { status: 201 });
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  return calls;
}

const doneTransition = (h, ticketId = SHIP_TICKET, extra = {}) =>
  h({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: ticketId, transition_id: "done", ...extra } });

test("TEAM-4706 (a): a ship ticket with NO completion record is refused, and Jira is never POSTed", async () => {
  const { mod, s3Calls } = await loadShipGate();
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_release_manager", "phase:ship", "wf:run1"] });
  try {
    const res = await doneTransition(mod.handler, SHIP_TICKET, { reason: "PR merged" });

    // The structured refusal survives the throw → `{ error }` boundary verbatim.
    assert.equal(res.ok, false);
    assert.equal(res.reason, "completion_record_required");
    assert.equal(res.hint, COMPLETION_HINT);
    // `error` is what the hub UI's rejectedDetails() reads as "it did not move".
    assert.match(res.error, /Cannot move TEAM-4066 to Done/);
    assert.match(res.error, /report_completion/);

    // Nothing was written: no transition POST, and not even the reason comment.
    assert.deepEqual(cap.transitions, [], "a refused transition must not fire in Jira");
    assert.deepEqual(cap.comments, [], "a refused transition must leave no comment behind");
    assert.deepEqual(s3Calls.records, [SHIP_RECORD_KEY]);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (a, cont.): `skip` cannot walk around the gate — it resolves to Done", async () => {
  const { mod } = await loadShipGate();
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_release_manager", "phase:ship"] });
  try {
    const res = await mod.handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: SHIP_TICKET, transition_id: "skip", reason: "not needed" },
    });
    assert.equal(res.reason, "completion_record_required");
    assert.deepEqual(cap.transitions, []);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (b): the same ship ticket WITH the record transitions normally", async () => {
  const { mod, s3Calls } = await loadShipGate({ records: [SHIP_RECORD_KEY] });
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_release_manager", "phase:ship"] });
  try {
    const res = await doneTransition(mod.handler);

    assert.equal(res.status, "done");
    assert.equal(res.ticketId, SHIP_TICKET);
    assert.equal(res.reason, undefined);
    assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
    assert.deepEqual(s3Calls.records, [SHIP_RECORD_KEY]);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (c): a NON-ship ticket closes with no record and never probes S3", async () => {
  const { mod, s3Calls } = await loadShipGate();
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_backend_dev", "phase:development"], ticketId: "TEAM-4067" });
  try {
    const res = await doneTransition(mod.handler, "TEAM-4067");

    assert.equal(res.status, "done");
    assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
    // The cheap phase predicate runs FIRST: the completion-record probe never
    // happens. (The only S3 traffic is the cold-start roster config read, which
    // this Lambda already made before this ticket existed.)
    assert.deepEqual(s3Calls.records, []);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (d): a human-review gate closes with no record — the UI/Telegram approve path", async () => {
  const { mod, s3Calls } = await loadShipGate();
  // A Merge Approval gate carries `phase:ship` itself, so the human exemption has
  // to be checked BEFORE the phase label or every human gate deadlocks.
  const cap = installDoneStub({
    labels: ["human-review", "reviewer:release-owner", "phase:ship", "wf:run1"],
    ticketId: "TEAM-4068",
  });
  try {
    const res = await doneTransition(mod.handler, "TEAM-4068", { reason: "approved" });

    assert.equal(res.status, "done");
    assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
    assert.deepEqual(s3Calls.records, []);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (e): ship phase read from the assignee's ROSTER phase, with no phase label", async () => {
  const { mod, s3Calls } = await loadShipGate();
  // No phase:ship label at all — the only signal is that agent:<id> is a
  // ship-phase agent in config/agents.json.
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_release_manager", "wf:run1"] });
  try {
    const res = await doneTransition(mod.handler);

    assert.equal(res.reason, "completion_record_required");
    assert.equal(res.hint, COMPLETION_HINT);
    assert.deepEqual(cap.transitions, []);
    assert.deepEqual(s3Calls.records, [SHIP_RECORD_KEY]);
    // The phase came from the S3 roster, not from a hardcoded name here.
    assert.ok(s3Calls.gets.includes("config/agents.json"));
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

test("TEAM-4706 (f): an INDETERMINATE S3 answer refuses (fails closed) and leaks nothing", async () => {
  const denied = new Error("User: arn:aws:sts::…:assumed-role/… is not authorized to perform s3:GetObject");
  denied.name = "AccessDenied";
  denied.$metadata = { httpStatusCode: 403 };
  const { mod } = await loadShipGate({ recordError: denied });
  const cap = installDoneStub({ labels: ["agent:agentcore_hub_release_manager", "phase:ship"] });
  try {
    const res = await doneTransition(mod.handler);

    assert.equal(res.reason, "completion_record_required");
    assert.deepEqual(cap.transitions, [], "an unreadable bucket must not close a ship ticket");
    // The message names the failure CLASS, never the AWS error body / identity.
    assert.match(res.error, /could not read completions\/TEAM-4066\.json \(AccessDenied 403\)/);
    assert.ok(!res.error.includes("assumed-role"), res.error);
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
});

// ─── TEAM-4757 R3-2: the record's BODY is the proof, not its existence ────────
//
// TEAM-4756 made reportCompletion stamp `followUpsPending`/`status` into the record,
// written after materializing follow-up tickets and before the Done transition. A
// record in the pending state existed exactly like a finished one, so the
// existence-only guard admitted it and a direct transition_ticket(done) closed the
// run — cascading, and completing the epic over follow-ups that were never filed.
// The admission test is `followUpsPending !== true`, never `=== false`: a pre-4756
// record, a sweep skip-record and the `complete_transition_failed` restamp all
// legitimately lack the field. Byte-identical twin of the (g)…(l) cases in
// lambda/agentcore-hub-tickets/index.test.mjs; the refusal STRINGS come from
// gate-contract.mjs's judgeCompletionRecord, which is why both twins can assert them.

/** A ship ticket whose record says what `body` says. */
async function shipDoneWithRecord(body, { labels = ["agent:agentcore_hub_release_manager", "phase:ship"] } = {}) {
  const { mod, s3Calls } = await loadShipGate({ recordBodies: { [SHIP_RECORD_KEY]: body } });
  const cap = installDoneStub({ labels });
  try {
    return { res: await doneTransition(mod.handler), cap, s3Calls };
  } finally {
    cap.restore();
    delete process.env.ARTIFACT_BUCKET;
  }
}

test("TEAM-4757 (g): a record with followUpsPending:true is REFUSED — the R3-2 hole", async () => {
  const { res, cap, s3Calls } = await shipDoneWithRecord(
    JSON.stringify({
      ticketId: SHIP_TICKET,
      summary: "deployed",
      followUpsPending: true,
      status: "complete_pending_follow_ups",
    })
  );

  assert.equal(res.ok, false);
  assert.equal(res.reason, "completion_record_required");
  assert.equal(res.hint, COMPLETION_HINT);
  // The message names the state AND the one call that fixes it.
  assert.match(
    res.error,
    /completions\/TEAM-4066\.json has followUpsPending:true \(status complete_pending_follow_ups\)/
  );
  assert.match(
    res.error,
    /re-run WorkflowOutput___report_completion with the same arguments to materialize the follow-ups/
  );
  // Nothing was written, and the record was read exactly once.
  assert.deepEqual(cap.transitions, [], "a pending record must not close a ship ticket");
  assert.deepEqual(cap.comments, []);
  assert.deepEqual(s3Calls.records, [SHIP_RECORD_KEY]);
});

test("TEAM-4757 (h): followUpsPending:false + status complete transitions", async () => {
  const { res, cap } = await shipDoneWithRecord(
    JSON.stringify({ ticketId: SHIP_TICKET, followUpsPending: false, status: "complete" })
  );

  assert.equal(res.status, "done");
  assert.equal(res.reason, undefined);
  assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
});

test("TEAM-4757 (i): a PRE-4756 record — neither field — still transitions", async () => {
  // Every record written before TEAM-4756 looks like this. `=== false` instead of
  // `!== true` would strand every in-flight run the moment this deploys.
  const { res, cap } = await shipDoneWithRecord(
    JSON.stringify({ ticketId: SHIP_TICKET, summary: "shipped", pr_url: "https://example.test/pr/1" })
  );

  assert.equal(res.status, "done");
  assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
});

test("TEAM-4757 (i, cont.): a sweep SKIP-record transitions, and so does the transition-failed restamp", async () => {
  // sweepSkipRecord deliberately stamps neither field (a skip is not a completion
  // report); the `complete_transition_failed` restamp deliberately leaves
  // followUpsPending false, because the follow-ups ARE filed there and only the Done
  // write failed — closing that ticket directly is a legitimate recovery.
  const skip = await shipDoneWithRecord(
    JSON.stringify({ ticketId: SHIP_TICKET, evidence_kind: "skipped", skipped: true, reason: "empty_sweep_no_siblings" })
  );
  assert.equal(skip.res.status, "done");

  const failed = await shipDoneWithRecord(
    JSON.stringify({ ticketId: SHIP_TICKET, followUpsPending: false, status: "complete_transition_failed" })
  );
  assert.equal(failed.res.status, "done");
});

test('TEAM-4757 (j): followUpsPending:"true" (a STRING) transitions — the test is `=== true`, not truthiness', async () => {
  const { res, cap } = await shipDoneWithRecord(
    JSON.stringify({ ticketId: SHIP_TICKET, followUpsPending: "true" })
  );

  assert.equal(res.status, "done");
  assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
});

test("TEAM-4757 (k): followUpsPending:true with no status names the status `unstated`", async () => {
  const { res, cap } = await shipDoneWithRecord(JSON.stringify({ ticketId: SHIP_TICKET, followUpsPending: true }));

  assert.equal(res.reason, "completion_record_required");
  assert.match(res.error, /has followUpsPending:true \(status unstated\)/);
  assert.deepEqual(cap.transitions, []);
});

test("TEAM-4757 (l): an UNREADABLE body refuses — fails closed", async () => {
  // A record we cannot parse cannot tell us whether its follow-ups are pending, and
  // "could not tell" is not "they are filed" — the same three-outcome discipline as
  // workflow-output's readCdLedger.
  for (const [body, detail] of [
    ["not json at all", "unparseable JSON"],
    ["", "an empty body"],
    ["[]", "parsed to an array, not an object"],
    ["null", "parsed to null, not an object"],
  ]) {
    const { res, cap } = await shipDoneWithRecord(body);

    assert.equal(res.ok, false, `body ${JSON.stringify(body)} must refuse`);
    assert.equal(res.reason, "completion_record_required");
    assert.ok(
      res.error.includes(`completions/TEAM-4066.json could not be read as a completion record (${detail}`),
      `body ${JSON.stringify(body)}: expected the "${detail}" refusal, got: ${res.error}`
    );
    assert.match(res.error, /Re-run WorkflowOutput___report_completion/);
    assert.deepEqual(cap.transitions, []);
  }
});

test("createTicket: an emoji title whose cut lands mid-surrogate-pair is clamped without corruption", async () => {
  const cap = captureCreate({ createdKey: "TEAM-910" });
  try {
    await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: ASTRAL_TITLE,
        description: LONG_DESCRIPTION,
        assignee: "agentcore_hub_requirements_analyst",
      },
    });
    assert.equal(cap.posts.length, 1);
    assert.ok(cap.fields.summary.length <= 255);
    assert.equal(cap.fields.summary, EXPECTED_CLAMPED_ASTRAL);
    assert.ok(
      !LONE_SURROGATE.test(cap.fields.summary),
      `summary sent to Jira must not contain an unpaired surrogate: ${JSON.stringify(cap.fields.summary.slice(-6))}`
    );
  } finally {
    cap.restore();
  }
});

// ─── TEAM-4739: the typed gate guard, Jira-side ────────────────────────────────
//
// The cross-provider truth table is src/lib/workflow/gate-guard-parity.test.ts,
// which drives BOTH Lambdas through the same rows and compares refusal payloads.
// What is asserted here is what only this twin does:
//   - the verification stamp and the `gate:awaiting-console` removal ride in the
//     SAME `POST /transitions` request as the transition itself (Jira has no
//     arbitrary field to write a structured record into, so the LABEL is the
//     stamp, and a stamp written by an adjacent call could be lost after the
//     close);
//   - with no PIPELINE_TOOLS_LAMBDA — the configuration every existing install
//     has — the guard ADMITS and stamps `indeterminate` rather than refusing;
//   - the two createTicket seams refuse through this twin's throw/`toolResult`
//     idiom, which is not the DynamoDB twin's `textResult` return.
//
// Note on env: both consts are read at module load and this runner has no module
// mocking, so `unset` is the state under test throughout. That is deliberate — it
// is the only state in which the guard's fail direction is observable without an
// AWS call, and it is the state that must never wedge a real install.

/**
 * Run `fn` against a scripted Jira. `issues` maps key → {labels, description};
 * `siblings` are the raw issues a `parent = X` search returns. Every non-GET
 * request is recorded in `writes`.
 */
async function withJira({ issues = {}, siblings = [], searchFails = false }, fn) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    if (method !== "GET") writes.push({ method, path, body });
    const json = (payload) => new Response(JSON.stringify(payload ?? {}), { status: 200 });

    if (/\/transitions$/.test(path)) {
      if (method === "POST") return new Response(null, { status: 204 });
      return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
    }
    if (/\/search\/jql/.test(path)) {
      if (searchFails) return new Response(JSON.stringify({ errorMessages: ["boom"] }), { status: 500 });
      return json({ issues: siblings });
    }
    if (/\/comment$/.test(path)) return json({ id: "1" });
    const keyMatch = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(path);
    if (path === "/rest/api/3/issue" && method === "POST") return json({ key: "TEAM-901", id: "901" });
    if (keyMatch && method === "PUT") {
      const issue = issues[keyMatch[1]];
      for (const op of body?.update?.labels || []) {
        if (op.add && issue && !issue.labels.includes(op.add)) issue.labels.push(op.add);
      }
      return new Response(null, { status: 204 });
    }
    if (keyMatch && method === "GET") {
      const issue = issues[keyMatch[1]];
      if (!issue) return new Response(JSON.stringify({ errorMessages: ["not found"] }), { status: 404 });
      return json({
        key: keyMatch[1],
        fields: {
          labels: issue.labels,
          description: issue.description ?? null,
          status: { name: issue.status || "In Review" },
          issuetype: { name: issue.issuetype || "Task" },
        },
      });
    }
    return json({});
  };
  try {
    return await fn({ writes, issues });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const transitionDone = (ticket_id) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id, transition_id: "done" } });

const DEPLOY_GATE = ["gate:deploy-approval", "pipeline:hub-x-deploy", "exec:0f8fad5b-d9cb-469f-a165-70867728950e"];

test("gate guard: with no probe configured the close is ADMITTED and stamped indeterminate", async () => {
  // The fail direction, as a deployment fact. A gate ticket nobody may close is an
  // unliftable stall: there is no escalation rung above the human this gate pages.
  await withJira({ issues: { "TEAM-900": { labels: [...DEPLOY_GATE] } } }, async ({ writes }) => {
    const res = await transitionDone("TEAM-900");

    assert.equal(res.status, "done");
    assert.equal(res.gateVerification.result, "indeterminate");
    assert.equal(res.gateVerification.reason, "probe_failed");
    assert.equal(res.gateVerification.evidence, "probe_not_configured");
    assert.equal(res.gateVerification.gateKind, "deploy-approval");

    const posts = writes.filter((w) => /\/transitions$/.test(w.path));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, {
      transition: { id: "31" },
      update: { labels: [{ add: "gateverify:indeterminate" }] },
    });
  });
});

test("gate guard: the stamp and the parked-label removal ride in ONE transitions POST", async () => {
  await withJira(
    { issues: { "TEAM-901": { labels: ["gate:blocker", "gate:awaiting-console"] } } },
    async ({ writes }) => {
      const res = await transitionDone("TEAM-901");

      assert.equal(res.gateVerification.result, "indeterminate");
      // A blocker gate has no probe at all — no external condition to read.
      assert.equal(res.gateVerification.reason, "no_probe_available");

      const posts = writes.filter((w) => /\/transitions$/.test(w.path));
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body, {
        transition: { id: "31" },
        update: { labels: [{ remove: "gate:awaiting-console" }, { add: "gateverify:indeterminate" }] },
      });
      // No adjacent label PUT: a stamp written separately could be lost after the
      // close, leaving a closed gate with no record of what admitted it.
      assert.equal(writes.filter((w) => w.method === "PUT").length, 0);
    }
  );
});

test("gate guard: a `remove` is only emitted for a label that is actually present", async () => {
  // Jira 400s a remove of an absent label, and that 400 would abort a transition
  // the guard already decided to admit.
  await withJira({ issues: { "TEAM-902": { labels: ["gate:blocker"] } } }, async ({ writes }) => {
    await transitionDone("TEAM-902");
    const posts = writes.filter((w) => /\/transitions$/.test(w.path));
    assert.deepEqual(posts[0].body.update.labels, [{ add: "gateverify:indeterminate" }]);
  });
});

test("gate guard: a CONTRADICTORY stamp is removed in the same POST that adds the new one", async () => {
  // TEAM-4750 B2. done -> reopen -> done with a different verdict used to leave both
  // gateverify:verified and gateverify:indeterminate on the issue. Order matters only
  // in that the awaiting removal stays first, keeping the common case unchanged.
  await withJira(
    { issues: { "TEAM-903": { labels: ["gate:blocker", "gate:awaiting-console", "gateverify:verified"] } } },
    async ({ writes }) => {
      const res = await transitionDone("TEAM-903");

      assert.equal(res.gateVerification.result, "indeterminate");
      const posts = writes.filter((w) => /\/transitions$/.test(w.path));
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body.update.labels, [
        { remove: "gate:awaiting-console" },
        { remove: "gateverify:verified" },
        { add: "gateverify:indeterminate" },
      ]);
      // That the issue then carries exactly one stamp is pinned in
      // src/lib/workflow/gate-guard-parity.test.ts, whose Jira fake applies the ops.
    }
  );
});

test("gate guard: a stale stamp is removed using the spelling the issue carries", async () => {
  // sanitizeUserLabels rewrites the colon to a hyphen, so both spellings exist in
  // the wild - and a remove must name the label as stored or Jira 400s the request.
  await withJira(
    { issues: { "TEAM-904": { labels: ["gate:blocker", "gateverify-verified"] } } },
    async ({ writes }) => {
      await transitionDone("TEAM-904");
      const posts = writes.filter((w) => /\/transitions$/.test(w.path));
      assert.deepEqual(posts[0].body.update.labels, [
        { remove: "gateverify-verified" },
        { add: "gateverify:indeterminate" },
      ]);
    }
  );
});

test("gate guard: a non-gate ticket's transitions POST is byte-identical to before", async () => {
  await withJira({ issues: { "TEAM-903": { labels: ["phase:development", "agent:agentcore_hub_backend_dev"] } } }, async ({ writes }) => {
    const res = await transitionDone("TEAM-903");
    assert.equal(res.gateVerification, undefined);
    const posts = writes.filter((w) => /\/transitions$/.test(w.path));
    assert.deepEqual(posts[0].body, { transition: { id: "31" } });
  });
});

test("gate guard: `gate:approval` alone is untouched — a human escalation gate is not probed", async () => {
  await withJira({ issues: { "TEAM-904": { labels: ["gate:approval"] } } }, async ({ writes }) => {
    const res = await transitionDone("TEAM-904");
    assert.equal(res.gateVerification, undefined);
    const posts = writes.filter((w) => /\/transitions$/.test(w.path));
    assert.deepEqual(posts[0].body, { transition: { id: "31" } });
  });
});

test("gate guard: a blockquoted DECISION line IS parsed in Jira mode (a known, bounded twin difference)", async () => {
  // adfToText FLATTENS blockquotes, so a `> DECISION: abort` inside a Jira
  // blockquote reaches parseFixDecision as an unquoted line — where the DynamoDB
  // twin, which reads raw markdown, rejects it. Bounded on purpose: a DECISION can
  // only ever produce `indeterminate`, never `verified`, so the worst case is that
  // Jira lifts a stall the other twin would not. Recorded here so the difference is
  // a decision rather than a surprise.
  const quoted = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "DECISION: accept-proxy" }] }],
      },
    ],
  };
  assert.ok(adfToText(quoted).split("\n").includes("DECISION: accept-proxy"));
});

test("createTicket: a deploy gate with no `exec:` label is refused through the toolResult idiom", async () => {
  await withJira({}, async ({ writes }) => {
    const res = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "Approve the deploy",
        description: "please approve",
        labels: ["gate:deploy-approval", "pipeline:hub-x-deploy"],
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, "gate_condition_unmet");
    assert.match(res.hint, /exactly one `exec:<execution-id>` label \(found 0\)/);
    // The thrown Error's message is what every existing caller reads as "the ticket
    // did not move"; the structured fields ride alongside it.
    assert.equal(res.error, res.hint);
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 0);
  });
});

test("createTicket: the third identical gate ticket is refused, and the epic is marked", async () => {
  const sibling = (key) => ({
    key,
    fields: {
      summary: "CI is unavailable",
      status: { name: "To Do" },
      labels: ["gate-ci-unavailable", `head-${"b".repeat(40)}`],
      issuelinks: [],
    },
  });
  const issues = { "TEAM-1": { labels: ["wf:wf_1"], issuetype: "Epic" } };

  await withJira({ issues, siblings: [sibling("TEAM-800"), sibling("TEAM-810")] }, async ({ writes }) => {
    const res = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "CI is unavailable",
        labels: ["gate:ci-unavailable", `head:${"b".repeat(40)}`],
        parent_key: "TEAM-1",
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, "gate_loop_environmental");
    assert.equal(res.existingTicketId, "TEAM-800");
    assert.match(res.error, /Work the existing ticket TEAM-800/);
    // No fourth ticket, and the epic carries the marker that dedupes the page.
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 0);
    assert.ok(issues["TEAM-1"].labels.includes("gate:loop-broken"));
  });
});

test("createTicket: the gate-loop guard FAILS OPEN on an unreadable epic — it is never the thing that refuses", async () => {
  // A creation wall that trips whenever a read fails is a wedge, not a guard: the
  // loop guard must not be what stops this create.
  //
  // TEAM-4752 D1: the create is nonetheless refused now — by the open-gate
  // autowire, which reads the SAME `parent = TEAM-1` search and no longer reads
  // "the search failed" as "no merge gate is open". That refusal is uniform (this
  // ticket has a parent and no `human:` assignee, so the autowire governs it) and
  // it is retryable, which is the whole difference from a wedge. What this test
  // still pins is that the loop guard itself stayed open: no
  // `gate_loop_environmental`, and no `gate:loop-broken` label on the epic.
  const issues = { "TEAM-1": { labels: ["wf:wf_1"] } };
  await withJira({ issues, searchFails: true }, async ({ writes }) => {
    const res = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "CI is unavailable",
        // Fully bound: the TEAM-4764 shape seam runs BEFORE the autowire's sibling
        // scan, so an unbound gate would be refused for its labels and never reach
        // the fail-open behaviour this test pins.
        labels: ["gate:ci-unavailable", "pipeline:hub-x-deploy", `head:${"b".repeat(40)}`],
        parent_key: "TEAM-1",
      },
    });
    assert.notEqual(res.reason, "gate_loop_environmental");
    assert.equal(issues["TEAM-1"].labels.includes("gate:loop-broken"), false);
    assert.match(res.error, /^create_ticket refused: the sibling scan under TEAM-1 failed/);
    assert.equal(res.ticketId, undefined);
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 0);
  });
});

// ─── TEAM-4740 FR-12 / FR-5: base_branch + open-gate autowire (Jira twin) ──────
//
// The DynamoDB twin's copy of this matrix lives in
// lambda/agentcore-hub-tickets/index.test.mjs; the two are held to ONE regex,
// refusal string and description line by src/lib/workflow/base-branch-parity.test.ts.
// This file owns the Jira-side BEHAVIOUR: the branch rides one ADF block (Jira has
// no arbitrary columns), and the freeze is expressed as Blocks issue links plus a
// real "Blocked" transition rather than a status column write.

const EPIC = "TEAM-4734";
const GATE_KEY = "TEAM-4668";
const CD_KEY = "TEAM-4703";

/** A sibling as Jira's search actually returns it. */
function issue(key, fields) {
  return {
    key,
    fields: {
      summary: "",
      status: { name: "To Do" },
      labels: [],
      created: "2026-09-14T12:00:00.000+0000",
      ...fields,
    },
  };
}

/** The human Merge Approval gate: human-review + reviewer:<who>, In Review. */
const gateIssue = (fields = {}) =>
  issue(GATE_KEY, {
    summary: "Merge Approval: [SI] system binding",
    status: { name: "In Review" },
    labels: ["human-review", "reviewer:tycen"],
    created: "2026-09-14T17:33:00.000+0000",
    ...fields,
  });

/** The run's CD ticket: an agent ticket stamped with the ship phase. */
const cdIssue = (key = CD_KEY, fields = {}) =>
  issue(key, {
    summary: "CD: merge + deploy",
    status: { name: "To Do" },
    labels: ["agent:agentcore_hub_release_manager", "phase:ship"],
    created: "2026-09-14T16:00:00.000+0000",
    ...fields,
  });

/**
 * Route Jira's REST surface for a create whose sibling scan matters. Splits the
 * two JQL searches by their query (`parent = …` is the FR-5 scan; anything else is
 * the pre-existing idempotency probe) and records the links + transitions the
 * freeze is actually made of.
 */
function captureGateCreate({ createdKey = "TEAM-4711", siblings = [], scanFails = false } = {}) {
  const cap = {
    posts: [], fields: null, siblingScans: [], dupScans: [],
    links: [], transitionIds: [], restore: null,
  };
  const originalFetch = globalThis.fetch;
  cap.restore = () => { globalThis.fetch = originalFetch; };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const u = String(url);
    if (u.includes("/rest/api/3/search/jql")) {
      const jql = jqlOf(u);
      if (jql.startsWith("parent = ")) {
        cap.siblingScans.push(jql);
        if (scanFails) {
          return new Response(JSON.stringify({ errorMessages: ["The parent field is not searchable"] }), { status: 400 });
        }
        return new Response(JSON.stringify({ issues: siblings }), { status: 200 });
      }
      cap.dupScans.push(jql);
      return new Response(JSON.stringify({ issues: [] }), { status: 200 });
    }
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      cap.posts.push(u);
      cap.fields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ key: createdKey }), { status: 201 });
    }
    if (u.endsWith("/rest/api/3/issueLink") && method === "POST") {
      cap.links.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/transitions")) {
      if (method === "POST") {
        cap.transitionIds.push(JSON.parse(options.body).transition.id);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ transitions: [
        { id: "21", name: "Ready", to: { name: "Ready" } },
        { id: "31", name: "Blocked", to: { name: "Blocked" } },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return cap;
}

/** An ordinary agent ticket under the epic. */
const AGENT_TICKET = {
  summary: "Fix the abandon guard",
  assignee: "agentcore_hub_backend_dev",
  parent_key: EPIC,
};

/** The block texts of a captured ADF description, in order. */
const blocksOf = (cap) => (cap.fields.description?.content || []).map((n) => n.content?.[0]?.text ?? "");

test("FR-12: base_branch rides one ADF block and comes back on the response", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate();
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, description: "Fix the abandon guard.", base_branch: "main" },
    });
    assert.equal(result.ticketId, "TEAM-4711", JSON.stringify(result));
    assert.equal(result.base_branch, "main");

    // Its OWN block, after the prose — adfToText separates block nodes with "\n",
    // which is the only reason the anchored parser can find the line at all.
    assert.deepEqual(blocksOf(cap), ["Fix the abandon guard.", "base_branch: main"]);
    const flattened = adfToText(cap.fields.description);
    assert.equal(flattened.match(m.BASE_BRANCH_LINE_RE)[1], "main");
  } finally {
    cap.restore();
  }
});

test("FR-12: the contract block still leads, with the branch line last", async () => {
  const m = await loadWithMode("enforce");
  const cap = captureGateCreate();
  try {
    await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...SHIP_FIX, base_branch: "feature/TEAM-4734--si-x" },
    });
    // parseFixContractBlock needs contract-first-then-prose; the branch line must
    // not get between them.
    assert.deepEqual(cap.fields.description.content.map((n) => n.type), ["codeBlock", "paragraph", "paragraph"]);
    const parsed = parseFixContractBlock(adfToText(cap.fields.description));
    assert.ok(parsed, "the contract must still parse back out");
    assert.equal(parsed.kind, "ship_fix");
    assert.equal(
      adfToText(cap.fields.description).match(m.BASE_BRANCH_LINE_RE)[1],
      "feature/TEAM-4734--si-x"
    );
  } finally {
    cap.restore();
  }
});

test("FR-12: an invalid base_branch creates NOTHING", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate();
  try {
    for (const bad of ["--upload-pack=x", "-main", "/main", "feature/../main", "main@{1}", "main.lock", "feature/", "a b"]) {
      const result = await m.handler({
        tool_name: "Tickets___create_ticket",
        parameters: { ...AGENT_TICKET, base_branch: bad },
      });
      // The twin's idiom: createTicket throws, the handler maps it to `error`.
      assert.equal(result.error, m.baseBranchRefusal(bad), `for ${JSON.stringify(bad)}`);
      assert.equal(result.ticketId, undefined);
    }
    assert.equal(cap.posts.length, 0, "no issue may be created for a refused branch");
    // Refused BEFORE any Jira I/O at all — not even the sibling scan.
    assert.equal(cap.siblingScans.length, 0);
  } finally {
    cap.restore();
  }
});

test("FR-12: an absent base_branch leaves the description byte-identical", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate();
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, description: "Plain ticket." },
    });
    assert.deepEqual(blocksOf(cap), ["Plain ticket."]);
    assert.equal("base_branch" in result, false);

    // …and with no description either, there is still no description field.
    const cap2 = captureGateCreate();
    try {
      await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
      assert.equal(cap2.fields.description, undefined);
    } finally {
      cap2.restore();
    }
  } finally {
    cap.restore();
  }
});

test("FR-5: an open gate freezes a new agent ticket behind the CD ticket", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, description: "Fix the abandon guard.", workflow_id: "run1" },
    });

    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(result.autowired, {
      reason: "open_gate",
      blockedBy: [CD_KEY],
      gateTicketId: GATE_KEY,
    });
    // The freeze in Jira IS the link + the transition; there is no status column.
    assert.deepEqual(cap.links, [{
      type: { name: "Blocks" },
      inwardIssue: { key: CD_KEY },
      outwardIssue: { key: "TEAM-4711" },
    }]);
    assert.deepEqual(cap.transitionIds, ["31"]);
    // The banner LEADS the prose: it changes what the assignee must do.
    const blocks = blocksOf(cap);
    assert.ok(blocks[0].startsWith("DELIVERY CONSTRAINT:"), blocks[0]);
    assert.ok(blocks[0].includes(CD_KEY));
    assert.ok(blocks[0].includes("your OWN pull request to main"));
    assert.equal(blocks[1], "Fix the abandon guard.");
    // One scan, on the parent, ordered — and the pre-existing dedupe probe is
    // untouched beside it.
    assert.deepEqual(cap.siblingScans, [`parent = ${EPIC} ORDER BY created ASC`]);
    assert.equal(cap.dupScans.length, 1);
  } finally {
    cap.restore();
  }
});

test("FR-5: the caller's own blockers are kept and the CD edge appended", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, blocked_by: ["TEAM-4700"] },
    });
    assert.equal(result.status, "blocked");
    assert.deepEqual(cap.links.map((l) => l.inwardIssue.key), ["TEAM-4700", CD_KEY]);
  } finally {
    cap.restore();
  }
});

test("FR-5: a human:* gate is never frozen — and costs no scan", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: "Merge Approval: round 2", assignee: "human:tycen", parent_key: EPIC },
    });
    assert.equal(result.status, "todo");
    assert.equal(result.autowired, undefined);
    assert.deepEqual(cap.links, []);
    // Freezing a human gate would deadlock the run, so the answer never depends on
    // a scan succeeding.
    assert.equal(cap.siblingScans.length, 0);
  } finally {
    cap.restore();
  }
});

test("FR-5: no duplicate edge when the caller already ordered it behind CD", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, blocked_by: [CD_KEY] },
    });
    assert.equal(result.autowired, undefined);
    assert.deepEqual(cap.links.map((l) => l.inwardIssue.key), [CD_KEY]);
    // No banner either: the ordering it explains was already the caller's.
    assert.equal(cap.fields.description, undefined);
  } finally {
    cap.restore();
  }
});

test("FR-5: a settled CD ticket, a closed gate, or no CD ticket → no GATE freeze", async () => {
  const m = await loadWithMode("off");
  // TEAM-4763 P2: "no gate freeze" no longer implies "dispatched now". Where the
  // roster still holds an OPEN agent sibling, the root-blocker half orders the new
  // ticket behind it — reason `no_root_blocker`, no gateTicketId, no banner. So each
  // case now states which half, if either, is expected to fire; the third element is
  // the root it must wait for, or null for "nothing at all".
  const cases = [
    ["CD already done", [gateIssue(), cdIssue(CD_KEY, { status: { name: "Done" } })], null],
    ["gate approved", [gateIssue({ status: { name: "Done" } }), cdIssue()], CD_KEY],
    ["gate never presented", [gateIssue({ status: { name: "To Do" } }), cdIssue()], CD_KEY],
    ["no gate at all", [cdIssue()], CD_KEY],
    ["gate but no CD ticket", [gateIssue()], null],
    ["a human ticket that is not a merge gate", [
      gateIssue({ summary: "Bug intake triage" }), cdIssue(),
    ], CD_KEY],
  ];
  for (const [why, siblings, root] of cases) {
    const cap = captureGateCreate({ siblings });
    try {
      const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
      // In every case the one thing that must not happen is the GATE freeze.
      assert.notEqual(result.autowired?.reason, "open_gate", why);
      if (root) {
        assert.equal(result.status, "blocked", why);
        assert.deepEqual(result.autowired, { reason: "no_root_blocker", rootTicketId: root, blockedBy: [root] }, why);
        assert.deepEqual(cap.links.map((l) => l.inwardIssue.key), [root], why);
        assert.equal(cap.fields.description, undefined, `${why}: the root autowire writes no banner`);
      } else {
        assert.equal(result.status, "todo", why);
        assert.equal(result.autowired, undefined, why);
        assert.deepEqual(cap.links, [], why);
      }
    } finally {
      cap.restore();
    }
  }
});

test("FR-5: the gate is recognized by LABEL as well as by title", async () => {
  const m = await loadWithMode("off");
  // sanitizeUserLabels maps ':' to '-', so the stamp can arrive either way.
  for (const label of ["gate:merge-approval", "gate-merge-approval"]) {
    const cap = captureGateCreate({
      siblings: [gateIssue({ summary: "Approve the merge", labels: ["human-review", label] }), cdIssue()],
    });
    try {
      const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
      assert.equal(result.autowired?.gateTicketId, GATE_KEY, label);
    } finally {
      cap.restore();
    }
  }
});

test("FR-5: the CD ticket is found by phase:ship AND by the roster fallback", async () => {
  const m = await loadWithMode("off");
  // No phase stamp: the agent: label's phase in the roster is what says "ship".
  const rosterOnly = captureGateCreate({
    siblings: [gateIssue(), cdIssue(CD_KEY, { labels: ["agent:agentcore_hub_release_manager"] })],
  });
  try {
    const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
    assert.deepEqual(result.autowired?.blockedBy, [CD_KEY]);
  } finally {
    rosterOnly.restore();
  }

  // A non-ship agent sibling is not a CD ticket, so the GATE freeze does not fire —
  // TEAM-4763 P2's root autowire then orders the ticket behind that sibling as the
  // run's root, naming no gate and writing no banner.
  const notCd = captureGateCreate({
    siblings: [gateIssue(), cdIssue("TEAM-4690", { labels: ["agent:agentcore_hub_backend_dev"] })],
  });
  try {
    const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
    assert.deepEqual(result.autowired, {
      reason: "no_root_blocker",
      rootTicketId: "TEAM-4690",
      blockedBy: ["TEAM-4690"],
    });
  } finally {
    notCd.restore();
  }
});

test("FR-5: the NEWEST CD ticket wins when a re-run filed a second one", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({
    siblings: [
      gateIssue(),
      cdIssue("TEAM-4600", { created: "2026-09-10T09:00:00.000+0000" }),
      cdIssue("TEAM-4710", { created: "2026-09-15T09:00:00.000+0000" }),
    ],
  });
  try {
    const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
    assert.deepEqual(result.autowired?.blockedBy, ["TEAM-4710"]);
  } finally {
    cap.restore();
  }
});

// TEAM-4752 D1 — this used to FAIL OPEN and file the ticket UNFROZEN. A failed
// scan is not evidence that no gate is open, and an unfrozen ticket is dispatched
// straight onto a branch the open merge is about to supersede. Refuse instead; the
// refusal is retryable, whereas a blocked ticket with no blocker edge is a wedge.
test("FR-5 REFUSES the create when the sibling scan fails", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()], scanFails: true });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, description: "Fix the abandon guard." },
    });
    // The twin's idiom: createTicket throws, the handler maps it to `error`.
    assert.match(result.error, /^create_ticket refused: the sibling scan under TEAM-4734 failed/);
    assert.match(result.error, /Nothing was created\. Retry the call\./);
    assert.equal(result.ticketId, undefined, JSON.stringify(result));
    // Nothing reached Jira: no issue, no link, no transition — and the refusal
    // precedes the idempotency probe, so not even that search ran.
    assert.equal(cap.posts.length, 0);
    assert.deepEqual(cap.links, []);
    assert.deepEqual(cap.transitionIds, []);
    assert.equal(cap.dupScans.length, 0);
    // …and it is the SHARED body, byte for byte — the twins may not drift.
    assert.equal(
      result.error,
      m.siblingScanRefusal(EPIC, "Jira API 400: The parent field is not searchable")
    );
  } finally {
    cap.restore();
  }
});

test("FR-5: a ticket with no parent is never scanned", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { summary: "Fix null check", assignee: "agentcore_hub_backend_dev" },
    });
    assert.equal(result.autowired, undefined);
    assert.equal(cap.siblingScans.length, 0);
  } finally {
    cap.restore();
  }
});

test("FR-5: a deduped retry is reconciled against the AUTOWIRED blockers", async () => {
  // The defect this guards: reconcileBlockersAndStatus derives status from the list
  // it is handed, so reconciling a duplicate against the RAW arg would transition an
  // already-frozen ticket to Ready and undo the freeze on every retry.
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue()] });
  const originalFetch = globalThis.fetch;
  const dup = issue("TEAM-4705", {
    summary: AGENT_TICKET.summary,
    labels: ["agent:agentcore_hub_backend_dev", "wf:run1"],
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/api/3/search/jql") && !jqlOf(u).startsWith("parent = ")) {
      return new Response(JSON.stringify({ issues: [dup] }), { status: 200 });
    }
    return originalFetch(url, options);
  };
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, workflow_id: "run1" },
    });
    assert.equal(result.deduplicated, true, JSON.stringify(result));
    assert.equal(cap.posts.length, 0, "a dedupe must not create a second issue");
    // The freeze is applied to the EXISTING ticket instead.
    assert.deepEqual(cap.links, [{
      type: { name: "Blocks" },
      inwardIssue: { key: CD_KEY },
      outwardIssue: { key: "TEAM-4705" },
    }]);
    assert.deepEqual(cap.transitionIds, ["31"]);
  } finally {
    cap.restore();
  }
});

// ─── TEAM-4763 P2 (FR-11 seam 7b) — the root blocker, at MINT time ────────────
//
// A ticket minted mid-run that names no blocker used to be dispatched the moment it
// landed, into a run whose earlier phase may still be running. The tickets twin's
// half of this is lambda/agentcore-hub-tickets/index.test.mjs (same cases, same
// names), and src/lib/workflow/root-blocker-parity.test.ts holds the two to the
// identical marker. The journey-event half is asserted only there: this runner has
// no module mocking, so there is no DynamoDB double to observe it with.

const ROOT_KEY = "TEAM-4735";   // the analyst's ticket: earliest non-human sibling
const LATER_KEY = "TEAM-4750";  // a later agent ticket — never the root

/** An ordinary open agent sibling, as Jira's search returns it. */
const agentIssue = (key = ROOT_KEY, fields = {}) =>
  issue(key, {
    summary: `Work: ${key}`,
    status: { name: "In Progress" },
    labels: ["agent:agentcore_hub_requirements_analyst"],
    created: "2026-09-14T10:00:00.000+0000",
    ...fields,
  });

test("FR-11: a mid-run ticket is ordered behind the run's root, with no banner", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({
    siblings: [agentIssue(LATER_KEY, { created: "2026-09-14T18:00:00.000+0000" }), agentIssue()],
  });
  try {
    const result = await m.handler({
      tool_name: "Tickets___create_ticket",
      parameters: { ...AGENT_TICKET, description: "Fix the abandon guard." },
    });

    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.deepEqual(result.autowired, {
      reason: "no_root_blocker",
      rootTicketId: ROOT_KEY,
      blockedBy: [ROOT_KEY],
    });
    // The freeze in Jira IS the link + the transition.
    assert.deepEqual(cap.links, [{
      type: { name: "Blocks" },
      inwardIssue: { key: ROOT_KEY },
      outwardIssue: { key: "TEAM-4711" },
    }]);
    assert.deepEqual(cap.transitionIds, ["31"]);
    // No DELIVERY CONSTRAINT banner: that one is about a merge superseding a branch.
    assert.deepEqual(blocksOf(cap), ["Fix the abandon guard."]);
    // The earliest-created sibling wins, not the first one JQL returned.
    assert.notEqual(result.autowired.rootTicketId, LATER_KEY);
    // And it reuses the open-gate scan: one `parent = …` search, not two.
    assert.deepEqual(cap.siblingScans, [`parent = ${EPIC} ORDER BY created ASC`]);
  } finally {
    cap.restore();
  }
});

test("FR-11: human:*, a caller's own blockers, and the run's first ticket are left alone", async () => {
  const m = await loadWithMode("off");
  const cases = [
    ["a human gate is what work waits ON", [agentIssue()], { summary: "Merge Approval: round 2", assignee: "human:tycen", parent_key: EPIC }],
    ["the caller already stated its ordering", [agentIssue()], { ...AGENT_TICKET, blocked_by: ["TEAM-4700"] }],
    ["the run's first ticket has no root yet", [], { ...AGENT_TICKET }],
    ["a roster of gates is no root", [gateIssue()], { ...AGENT_TICKET }],
    ["a done root would be a permanent wedge", [agentIssue(ROOT_KEY, { status: { name: "Done" } })], { ...AGENT_TICKET }],
    // `Skipped`/`Cancelled` are outside the 6-status workflow, so they arrive
    // unmapped and lowercased — and cascade.mjs resolves a blocker on done/cancelled
    // only, so a skipped root never unblocks anything, ever.
    ["a skipped root, same reason", [agentIssue(ROOT_KEY, { status: { name: "Skipped" } })], { ...AGENT_TICKET }],
    ["a cancelled root, same reason", [agentIssue(ROOT_KEY, { status: { name: "Cancelled" } })], { ...AGENT_TICKET }],
  ];
  for (const [why, siblings, parameters] of cases) {
    const cap = captureGateCreate({ siblings });
    try {
      const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters });
      assert.equal(result.autowired, undefined, why);
      // The caller's own blocker is still honoured — "unwired" means the autowire
      // added nothing, not that the edge the caller asked for was dropped.
      const expectedLinks = (parameters.blocked_by || []).map((key) => key);
      assert.deepEqual(cap.links.map((l) => l.inwardIssue.key), expectedLinks, why);
    } finally {
      cap.restore();
    }
  }
});

test("FR-11: the gate freeze wins when a merge gate is open — never two autowires", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [gateIssue(), cdIssue(), agentIssue()] });
  try {
    const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
    assert.equal(result.autowired.reason, "open_gate");
    assert.deepEqual(result.autowired.blockedBy, [CD_KEY]);
    assert.equal(result.autowired.rootTicketId, undefined);
    assert.deepEqual(cap.links.map((l) => l.inwardIssue.key), [CD_KEY]);
  } finally {
    cap.restore();
  }
});

test("FR-11: a REFUSED scan never reaches the root autowire — there is no create to wire", async () => {
  const m = await loadWithMode("off");
  const cap = captureGateCreate({ siblings: [agentIssue()], scanFails: true });
  try {
    const result = await m.handler({ tool_name: "Tickets___create_ticket", parameters: { ...AGENT_TICKET } });
    assert.match(result.error, /^create_ticket refused: the sibling scan under TEAM-4734 failed/);
    assert.equal(cap.posts.length, 0);
    assert.deepEqual(cap.links, []);
  } finally {
    cap.restore();
  }
});
