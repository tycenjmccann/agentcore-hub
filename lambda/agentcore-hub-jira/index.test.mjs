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

import { adfToText, getIssue, handler, clampSummary, SEARCH_MAX_PAGES, mapStatusToInternal, findCancelTransition } from "./index.mjs";
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

// ─── TEAM-5168 (R2-05): list_tickets pages through /search/jql ─────────────────
//
// The endpoint answers ONE page (`maxResults`) plus `isLast` / `nextPageToken`. A
// caller that stops at page one sees the OLDEST rows and nothing that says more
// exist — which is how a follow-up filed as child #101 was invisible to the
// `[fu:<hash>]` dedupe and got created twice. `complete:false` is the explicit
// "could not see everything" signal when the page bound is hit.

/** `n` bare children of TEAM-1, keys TEAM-<from>.. as Jira's search returns them. */
const childPage = (from, n) => Array.from({ length: n }, (_, i) => ({
  key: `TEAM-${from + i}`,
  fields: { summary: `Child ${from + i}`, status: { name: "To Do" }, labels: [], issuetype: { name: "Task" } },
}));
const tokenOf = (url) => new URL(url).searchParams.get("nextPageToken");

test("TEAM-5168: list_tickets follows nextPageToken — 101 children across two pages, the 101st returned, complete:true", async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (!tokenOf(u)) {
      return new Response(JSON.stringify({ issues: childPage(100, 100), isLast: false, nextPageToken: "p2" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      issues: [{ key: "TEAM-4901", fields: { summary: "Document the new flag [fu:c909026e]", status: { name: "To Do" }, labels: ["followup-c909026e"], issuetype: { name: "Task" } } }],
      isLast: true,
    }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(urls.length, 2, "one request per page");
    assert.equal(tokenOf(urls[0]), null, "page 1 carries no token");
    assert.equal(tokenOf(urls[1]), "p2", "page 2 carries the token page 1 answered");
    for (const u of urls) {
      const params = new URL(u).searchParams;
      assert.equal(params.get("jql"), "parent = TEAM-1 ORDER BY created ASC");
      assert.equal(params.get("maxResults"), "100");
    }
    assert.equal(result.tickets.length, 101);
    assert.equal(result.tickets[100].ticketId, "TEAM-4901");
    assert.equal(result.tickets[100].title, "Document the new flag [fu:c909026e]");
    assert.equal(result.complete, true);
    assert.equal(result.scan_incomplete, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5168: list_tickets stops at the page bound and says so — complete:false, scan_incomplete:true", async () => {
  let pagesServed = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    pagesServed++;
    return new Response(JSON.stringify({ issues: childPage(pagesServed * 1000, 100), isLast: false, nextPageToken: `p${pagesServed + 1}` }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(pagesServed, SEARCH_MAX_PAGES, "exactly the bound, then stop");
    assert.equal(result.tickets.length, SEARCH_MAX_PAGES * 100);
    assert.equal(result.complete, false);
    assert.equal(result.scan_incomplete, true);
    assert.match(result.warning, /truncated after \d+ pages/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5168: a failed page THROWS — a partial list is never answered as complete", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!tokenOf(String(url))) {
      return new Response(JSON.stringify({ issues: childPage(100, 100), isLast: false, nextPageToken: "p2" }), { status: 200 });
    }
    return new Response(JSON.stringify({ errorMessages: ["Internal server error"] }), { status: 500 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.match(result.error, /^Jira API 500/);
    assert.equal(result.tickets, undefined, "no partial roster on a failed page");
    assert.equal(result.complete, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-5174 (R3-02): isLast:false without a usable nextPageToken is TRUNCATED ──
//
// The TEAM-5168 loop derived the next token as `isLast === false ? nextPageToken :
// undefined` and exited on a falsy token — so a page that said "more exist" but
// carried no token (or an empty / repeated one) was answered as complete:true.
// Mirror src/lib/workflow/jira-search-paginate.ts: isLast decides completeness;
// a missing token only decides that we must STOP, and stopping early is incomplete.

test("TEAM-5174: isLast:false with NO nextPageToken → complete:false, scan_incomplete:true (not a complete roster)", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ issues: childPage(100, 100), isLast: false }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(calls, 1, "nothing to follow — one request, then stop");
    assert.equal(result.tickets.length, 100, "the rows that WERE read are still handed back");
    assert.equal(result.complete, false);
    assert.equal(result.scan_incomplete, true);
    assert.match(result.warning, /^child listing under TEAM-1 truncated at page 1 \(isLast:false but no nextPageToken\) \(100 tickets, oldest first\); Jira reports more children$/);
    assert.doesNotMatch(result.warning, /after \d+ pages/, "must not claim the page bound was hit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5174: isLast:false with an EMPTY-STRING nextPageToken → complete:false, scan_incomplete:true", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ issues: childPage(100, 100), isLast: false, nextPageToken: "" }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(calls, 1);
    assert.equal(result.tickets.length, 100);
    assert.equal(result.complete, false);
    assert.equal(result.scan_incomplete, true);
    assert.match(result.warning, /truncated at page 1 \(isLast:false but no nextPageToken\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5174: a REPEATED nextPageToken stops after the second page → complete:false, no infinite loop", async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const from = tokenOf(String(url)) ? 200 : 100;
    return new Response(JSON.stringify({ issues: childPage(from, 100), isLast: false, nextPageToken: "p2" }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(urls.length, 2, "page 1, page 2 (token p2), then the repeated token stops the loop");
    assert.equal(tokenOf(urls[0]), null);
    assert.equal(tokenOf(urls[1]), "p2");
    assert.equal(result.tickets.length, 200);
    assert.equal(result.complete, false);
    assert.equal(result.scan_incomplete, true);
    assert.match(result.warning, /truncated at page 2 \(a repeated nextPageToken\)/);
    assert.doesNotMatch(result.warning, /after \d+ pages/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-5181 (R4-01): a fresh nextPageToken means MORE PAGES even without isLast ──
//
// Atlassian's OpenAPI for /rest/api/3/search/jql does not require `isLast`, and
// documents `nextPageToken` as null only on the last (or only) page. TEAM-5174
// exited on `isLast !== false`, so a page with a fresh token and no isLast was
// answered as a complete roster after ONE page — the TEAM-5168 defect again.
// Rule: isLast:true wins (stop, complete, a stray token ignored); otherwise a fresh
// token is followed; a repeated token is truncated; no token is truncated only
// when isLast:false says more exist.

test("TEAM-5181: token present + isLast OMITTED → page 2 fetched, 101 tickets, complete:true", async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (!tokenOf(u)) {
      return new Response(JSON.stringify({ issues: childPage(100, 100), nextPageToken: "p2" }), { status: 200 });
    }
    return new Response(JSON.stringify({ issues: childPage(200, 1), isLast: true }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(urls.length, 2, "the token is followed even though isLast is absent");
    assert.equal(tokenOf(urls[1]), "p2");
    assert.equal(result.tickets.length, 101);
    assert.equal(result.tickets[100].ticketId, "TEAM-200");
    assert.equal(result.complete, true);
    assert.equal(result.scan_incomplete, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5181: isLast:true with a non-empty nextPageToken → stop after one page, complete:true (isLast wins)", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ issues: childPage(100, 3), isLast: true, nextPageToken: "stray" }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(calls, 1, "the contradictory token is ignored");
    assert.equal(result.tickets.length, 3);
    assert.equal(result.complete, true);
    assert.equal(result.scan_incomplete, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5181: isLast OMITTED + a REPEATED nextPageToken → complete:false (repeated_token), no infinite loop", async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const from = tokenOf(String(url)) ? 200 : 100;
    return new Response(JSON.stringify({ issues: childPage(from, 100), nextPageToken: "p2" }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(urls.length, 2, "page 1, page 2 (token p2), then the repeated token stops the loop");
    assert.equal(tokenOf(urls[1]), "p2");
    assert.equal(result.tickets.length, 200);
    assert.equal(result.complete, false);
    assert.equal(result.scan_incomplete, true);
    assert.match(result.warning, /truncated at page 2 \(a repeated nextPageToken\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5181: no isLast and no nextPageToken → the only page, complete:true", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ issues: childPage(100, 2) }), { status: 200 });
  };
  try {
    const result = await handler({ tool_name: "Tickets___list_tickets", parameters: { parent_id: "TEAM-1" } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(calls, 1);
    assert.equal(result.tickets.length, 2);
    assert.equal(result.complete, true);
    assert.equal(result.scan_incomplete, undefined);
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
// TEAM-5721: `statusAtPost` is the status the first transition POST lands on (default:
// the last status served) — a move after the last read; each POST appends a changelog
// item and moves `live`. `failRevert` 500s every POST after the first; `changelog:
// "empty"` answers the read-back with no histories.
// TEAM-5723: each pushed history echoes the POST body's `historyMetadata` (as Jira does)
// unless `stripHistoryMetadata`; `duplicateNonce` records our move twice;
// `foreignMovesAfterPost: [[from, to], ...]` appends OTHER-actor moves (no metadata,
// later `created`) right after our first POST; `priorHistories` seeds that many
// metadata-less older moves; `changelogPageSize` bounds the `expand=changelog` page
// (with an honest `total`) and the `/changelog?startAt=` pages; `changelogPaging:
// "empty"` makes every `/changelog` page come back with no values.
// TEAM-5728 (R3-1): the two reads are served in Jira's DOCUMENTED order — the
// `expand=changelog` page is NEWEST-first and capped at 100, the dedicated
// `/changelog` endpoint pages OLDEST-first — so a cursor shared between them
// re-reads the newest entries, exactly as it does against Jira.
// TEAM-5724: `labels` is live issue state — `update.labels` ops from a transition POST
// or a `PUT /issue` are applied to it (`calls.labels` is the final set, `calls.puts` the
// PUT bodies); `refuseLabelsOnPost` replays the TEAM-4908 screen refusal;
// `failUnlabelledPost` 500s a transition POST that carries no labels;
// `failParkClaimRemoval` 500s a PUT whose only op removes a park-claim label.
// TEAM-5729: `unlabelledPostGate(body, n)` is awaited before the n-th unlabelled POST is
// served and may return a Response to serve instead — lets a test hold one request mid-POST
// while a second request of the SAME park runs to completion; `calls.histories` is the
// changelog the stub would serve (the evidence the orchestrator reads).
function installTransitionStub({ failLinkFor = [], preLinked = [], statusSequence = ["In Progress"], statusAtPost = null, failRevert = false, changelog = "real",
  foreignMovesAfterPost = [], stripHistoryMetadata = false, duplicateNonce = false, priorHistories = 0, changelogPageSize = null, changelogPaging = "real",
  labels = [], refuseLabelsOnPost = false, failUnlabelledPost = false, failParkClaimRemoval = false, unlabelledPostGate = null } = {}) {
  const calls = { links: [], comments: [], transitions: [], statusReads: 0, changelogReads: 0, changelogPages: [], labels: [...labels], puts: [], histories: null };
  let unlabelledPosts = 0;
  const applyLabelOps = (ops) => {
    for (const op of ops || []) {
      if (op.remove) calls.labels = calls.labels.filter((l) => l !== op.remove);
      if (op.add && !calls.labels.includes(op.add)) calls.labels.push(op.add);
    }
  };
  const TO_NAME = { 11: "Blocked", 31: "Done" };
  const histories = [];
  const pushHistory = (from, to, historyMetadata = null) => {
    const h = { id: String(1000 + histories.length), created: new Date(Date.UTC(2026, 9, 13, 0, 0, histories.length)).toISOString(),
      items: [{ field: "status", fromString: from, toString: to }] };
    if (historyMetadata && !stripHistoryMetadata) h.historyMetadata = historyMetadata;
    histories.push(h);
  };
  for (let i = 0; i < priorHistories; i++) pushHistory(i % 2 ? "In Progress" : "To Do", i % 2 ? "To Do" : "In Progress");
  calls.histories = histories;
  const served = () => (changelog === "empty" ? [] : histories);
  let live = null;
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
    if (url.includes("expand=changelog") && method === "GET") {
      calls.changelogReads += 1;
      const all = served();
      const size = Math.min(changelogPageSize ?? 100, 100); // Jira: newest first, at most 100
      const page = [...all].reverse().slice(0, size);
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { status: { name: live } },
        changelog: { startAt: 0, maxResults: size, total: all.length, histories: page } }), { status: 200 });
    }
    if (url.includes("/changelog?") && method === "GET") {
      const startAt = Number(/[?&]startAt=(\d+)/.exec(url)?.[1] ?? 0);
      calls.changelogPages.push(startAt);
      const all = served();
      const size = changelogPageSize || 100;
      const values = changelogPaging === "empty" ? [] : all.slice(startAt, startAt + size);
      return new Response(JSON.stringify({ startAt, maxResults: size, total: all.length, isLast: startAt + size >= all.length, values }), { status: 200 });
    }
    if (url.includes("fields=status") && method === "GET") {
      // TEAM-5707: one status per read (last repeats), so a move between the
      // first read and the pre-POST re-read is expressible.
      const name = statusSequence[Math.min(calls.statusReads++, statusSequence.length - 1)];
      live = name;
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { status: { name } } }), { status: 200 });
    }
    if (url.includes("/rest/api/3/issue/") && url.includes("fields=issuelinks") && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-24", fields: {
        issuelinks: [...linked].map((k) => ({ type: { name: "Blocks" }, inwardIssue: { key: k } })),
      } }), { status: 200 });
    }
    if (url.includes("fields=labels") && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { labels: [...calls.labels] } }), { status: 200 });
    }
    if (/\/rest\/api\/3\/issue\/TEAM-24$/.test(url) && method === "PUT") {
      const body = JSON.parse(init.body);
      calls.puts.push(body);
      const ops = body.update?.labels || [];
      if (failParkClaimRemoval && ops.length && ops.every((op) => String(op.remove || "").startsWith("park-claim:"))) {
        return new Response(JSON.stringify({ errorMessages: ["label store down"] }), { status: 500 });
      }
      applyLabelOps(ops);
      return new Response(null, { status: 204 });
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
      const body = JSON.parse(init.body);
      calls.transitions.push(body);
      if (failRevert && calls.transitions.length > 1) {
        return new Response(JSON.stringify({ errorMessages: ["boom"] }), { status: 500 });
      }
      if (unlabelledPostGate && !body.update?.labels) {
        const served = await unlabelledPostGate(body, ++unlabelledPosts);
        if (served) return served;
      }
      // TEAM-5724: the screen refusal is a 400 that applies nothing; a 500 on the
      // unlabelled POST moves nothing either. Labels on a successful POST apply with it.
      if (refuseLabelsOnPost && body.update?.labels) {
        return new Response(JSON.stringify({ errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." } }), { status: 400 });
      }
      if (failUnlabelledPost && !body.update?.labels) {
        return new Response(JSON.stringify({ errorMessages: ["Internal server error"] }), { status: 500 });
      }
      applyLabelOps(body.update?.labels);
      // The screen-refusal POST was not a move; the move is the one that was accepted.
      const accepted = calls.transitions.filter((t) => !(refuseLabelsOnPost && t.update?.labels));
      const from = accepted.length === 1 && statusAtPost ? statusAtPost : live;
      const to = TO_NAME[body.transition.id];
      pushHistory(from, to, body.historyMetadata);
      if (duplicateNonce) pushHistory(from, to, body.historyMetadata);
      live = to;
      if (calls.transitions.length === 1) {
        for (const [f, t] of foreignMovesAfterPost) { pushHistory(f, t); live = t; }
      }
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
    assert.equal(calls.changelogReads, 0, "TEAM-5721: no expected_status → no read-back");
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

// TEAM-5707: expected_status — Jira has no conditional transition, so the fence is
// the first read (before any comment/link) plus a re-read right before the POST.
test("transition_ticket: expected_status mismatch at the first read is refused before any Jira write", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ statusSequence: ["Blocked"] });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", reason: "r", blocked_by: "TEAM-30", expected_status: "in_progress" } });
    assert.equal(res.error, "Status precondition failed: TEAM-24 is blocked, expected in_progress — not transitioned.");
    assert.deepEqual(calls.comments, []);
    assert.deepEqual(calls.links, []);
    assert.deepEqual(calls.transitions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: expected_status mismatch at the pre-POST re-read is refused, no transition", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ statusSequence: ["In Progress", "Done"] });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress" } });
    assert.match(res.error, /^Status precondition failed: TEAM-24 is done, expected in_progress/);
    assert.deepEqual(calls.transitions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: expected_status that matches on both reads transitions normally", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub();
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress" } });
    assert.equal(res.status, "blocked");
    assert.equal(calls.statusReads, 2, "first read + the pre-POST re-read");
    assert.equal(calls.changelogReads, 1, "TEAM-5721: one post-POST read-back");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// TEAM-5721: Jira's POST /transitions has no compare-and-set, so a move that lands
// after the pre-POST re-read is caught by the changelog read-back and reverted.
test("transition_ticket: TEAM-5721 — Done landing after the last read is reverted and refused, never blocked", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ statusAtPost: "Done" });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", reason: "park", expected_status: "in_progress" } });
    assert.equal(res.status, undefined);
    assert.equal(res.error, "Status precondition failed: TEAM-24 moved under the write (was done, expected in_progress) — transition reverted.");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }, { id: "31" }], "the park, then the revert to Done");
    assert.equal(calls.transitions[1].historyMetadata?.extraData?.fenceNonce, calls.transitions[0].historyMetadata?.extraData?.fenceNonce, "TEAM-5723: the revert is attributed to the same request");
    assert.equal(calls.comments.length, 2);
    assert.match(adfToText(calls.comments[1].body), /^Fenced: this ticket moved to done .* transition reverted\.\s*$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5721 — a failed revert still refuses with the precondition error", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ statusAtPost: "Done", failRevert: true });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress" } });
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition failed: TEAM-24 moved under the write \(was done, expected in_progress\) — revert failed \(.*boom.*\)\.$/);
    assert.equal(calls.transitions.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5721 — an unprovable source is refused as unverified, with no revert", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ changelog: "empty" });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress" } });
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition unverified: TEAM-24 was sent to blocked/);
    assert.doesNotMatch(res.error, /transitioned/i, "the harness's _ParkGate._moved keys on that word");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// TEAM-5723 (R2-1): the TEAM-5721 read-back took the NEWEST move into the target, which
// nothing tied to this request — another actor's In Progress → Blocked landing after our
// Done → Blocked vouched for it. Now the POST carries a per-request nonce in
// `historyMetadata` and the read-back verifies only the one history that carries it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const park = (extra = {}) => handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress", ...extra } });
const FOREIGN_BOUNCE = [["Blocked", "In Progress"], ["In Progress", "Blocked"]];

// TEAM-5728 (R3-4): …and once the source is known wrong, the revert is withheld when
// anything moved after our entry — the other actor's In Progress → Blocked is a move the
// revert would clobber, not a move it may undo.
test("transition_ticket: TEAM-5723/TEAM-5728 — R2-1: foreign moves after our POST do not mask a Done source; refused, and the revert is withheld because the ticket moved again", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ statusAtPost: "Done", foreignMovesAfterPost: FOREIGN_BOUNCE });
  try {
    const res = await park({ reason: "park" });
    assert.equal(res.status, undefined, "the other actor's In Progress → Blocked entry must not vouch for our Done → Blocked move");
    assert.match(res.error, /^Status precondition failed: TEAM-24 moved under the write \(was done, expected in_progress\) — revert withheld \(TEAM-24 is now blocked; .*\)\.$/);
    assert.doesNotMatch(res.error, /transitioned/i, "the harness's _ParkGate._moved keys on that word");
    assert.doesNotMatch(res.error, /reverted/, "nothing was reverted");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }], "the park only: no revert over the other actor's moves");
    const nonce = calls.transitions[0].historyMetadata?.extraData?.fenceNonce;
    assert.match(String(nonce), UUID_RE, "the park POST carries a per-request nonce in historyMetadata.extraData");
    const comment = adfToText(calls.comments.at(-1).body);
    assert.match(comment, /^Fenced: this ticket moved to done .* revert withheld \(TEAM-24 is now blocked; .*\)\.\s*$/);
    assert.doesNotMatch(comment, /reverted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5723 — foreign moves after a genuine In Progress → Blocked move still verify as ours", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ foreignMovesAfterPost: FOREIGN_BOUNCE });
  try {
    const res = await park();
    assert.equal(res.status, "blocked");
    assert.equal(res.message, "Transitioned to blocked");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }], "no revert: our own entry says In Progress → Blocked");
    assert.equal(calls.changelogReads, 1);
    assert.deepEqual(calls.changelogPages, [], "the nonce is on the expand page: no /changelog paging");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5723 — a changelog without historyMetadata is unverified, no revert", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ stripHistoryMetadata: true });
  try {
    const res = await park();
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition unverified: TEAM-24 was sent to blocked .*could not be attributed to this request \(fence nonce matched 0 changelog entries\), expected in_progress — not reported as moved\.$/);
    assert.doesNotMatch(res.error, /transitioned/i, "the harness's _ParkGate._moved keys on that word");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }], "no revert: nowhere known to go back to");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5723 — two changelog entries carrying our nonce are unverified, no revert", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ duplicateNonce: true });
  try {
    const res = await park();
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition unverified: .*fence nonce matched 2 changelog entries/);
    assert.doesNotMatch(res.error, /transitioned/i);
    assert.equal(calls.transitions.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The expand page is newest-first, so the nonce falls off it only when enough OTHER
// moves land after ours: [p0, p1, p2, ours, f1, f2] → expand = [f2, f1]; /changelog pages
// oldest-first from ITS OWN cursor: [p0, p1], then [p2, ours].
test("transition_ticket: TEAM-5723 — a nonce past the expand page is found by paging /changelog", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ priorHistories: 3, changelogPageSize: 2, foreignMovesAfterPost: FOREIGN_BOUNCE });
  try {
    const res = await park();
    assert.equal(res.status, "blocked");
    assert.deepEqual(calls.changelogPages, [0, 2], "TEAM-5728 (R3-1): /changelog walks from its own startAt=0, stepping by what each page returned");
    assert.equal(calls.transitions.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5723 — /changelog paging exhausted without the nonce is unverified, no revert", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ priorHistories: 3, changelogPageSize: 2, changelogPaging: "empty", foreignMovesAfterPost: FOREIGN_BOUNCE });
  try {
    const res = await park();
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition unverified: .*fence nonce matched 0 changelog entries/);
    assert.doesNotMatch(res.error, /transitioned/i);
    assert.deepEqual(calls.changelogPages, [0], "an empty page ends the walk; no spin");
    assert.equal(calls.transitions.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// TEAM-5728 (R3-1): Jira serves `expand=changelog` NEWEST-first (≤100) and pages
// `GET /issue/{key}/changelog` OLDEST-first. The TEAM-5723 walk seeded the dedicated
// endpoint's startAt from the expand page's length, so past 100 histories our own
// (newest) entry came back twice — "fence nonce matched 2" — a legit park refused as
// unverified, and a park that raced Done left in Blocked with no revert.
test("transition_ticket: TEAM-5728 — R3-1: a legit park on a ticket with more than 100 histories verifies as ours (one /changelog page, no double count)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ priorHistories: 100 });
  try {
    const res = await park();
    assert.equal(res.error, undefined, "our entry is on the expand page AND the last /changelog page; it is one history, not two carriers");
    assert.equal(res.status, "blocked");
    assert.equal(res.message, "Transitioned to blocked");
    assert.equal(calls.changelogReads, 1);
    assert.deepEqual(calls.changelogPages, [0], "the dedicated endpoint starts from its own cursor");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5728 — R3-1: an entry on both the expand page and a /changelog page is one history (deduped by id)", async () => {
  const originalFetch = globalThis.fetch;
  // [p0, p1, ours, f1, f2] → expand = [f2, f1, ours]; /changelog page 0 = [p0, p1, ours]
  const calls = installTransitionStub({ priorHistories: 2, changelogPageSize: 3, foreignMovesAfterPost: FOREIGN_BOUNCE });
  try {
    const res = await park();
    assert.equal(res.status, "blocked");
    assert.deepEqual(calls.changelogPages, [0]);
    assert.equal(calls.transitions.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5728 — R3-1: a park that raced Done on a ticket with more than 100 histories is still reverted to Done", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ priorHistories: 100, statusAtPost: "Done" });
  try {
    const res = await park();
    assert.equal(res.status, undefined);
    assert.equal(res.error, "Status precondition failed: TEAM-24 moved under the write (was done, expected in_progress) — transition reverted.");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }, { id: "31" }], "the park, then the revert to Done — not left in Blocked as unverified");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// TEAM-5728 (R3-4): the revert found its transition by destination and POSTed it with no
// look at what happened after our entry. Our Done → Blocked, then another actor's
// Blocked → Won't Do, then our "revert" posted Won't Do → Done and said "reverted".
test("transition_ticket: TEAM-5728 — R3-4: a foreign move after our wrong-source park withholds the revert; conflict error, label taken back off", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ labels: ["wf:wf_1"], statusAtPost: "Done", foreignMovesAfterPost: [["Blocked", "Won't Do"]] });
  try {
    const res = await park({ claim_started_at: "2026-10-13T03:00:00.000Z" });
    assert.equal(res.status, undefined);
    assert.match(res.error, /^Status precondition failed: TEAM-24 moved under the write \(was done, expected in_progress\) — revert withheld \(TEAM-24 is now cancelled; .*\)\.$/);
    assert.doesNotMatch(res.error, /transitioned/i, "the harness's _ParkGate._moved keys on that word");
    assert.doesNotMatch(res.error, /reverted/, "the other actor's Won't Do stands; nothing was reverted");
    assert.deepEqual(calls.transitions.map((t) => t.transition), [{ id: "11" }], "no revert POST over the other actor's Won't Do");
    assert.equal(calls.changelogReads, 1, "the withhold decision reuses the verification read");
    const comment = adfToText(calls.comments.at(-1).body);
    assert.match(comment, /^Fenced: this ticket moved to done .* revert withheld \(TEAM-24 is now cancelled; .*\)\.\s*$/);
    assert.doesNotMatch(comment, /reverted/);
    assert.deepEqual(calls.puts, [{ update: { labels: [{ remove: `park-claim:2026-10-13T03:00:00.000Z:${calls.transitions[0].historyMetadata.extraData.fenceNonce}` }] } }], "TEAM-5724/5729: the park-claim label that rode the POST — THIS request's — is taken back off");
    assert.deepEqual(calls.labels, ["wf:wf_1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition_ticket: TEAM-5723 — without expected_status the POST body carries no historyMetadata", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub();
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked" } });
    assert.equal(res.status, "blocked");
    assert.deepEqual(calls.transitions, [{ transition: { id: "11" } }], "byte-identical to the unfenced body");
    assert.equal(calls.changelogReads, 0);
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
    if (u.includes("fields=status") && method === "GET") {
      return new Response(JSON.stringify({ key: ticketId, fields: { status: { name: "In Progress" } } }), { status: 200 });
    }
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
async function withJira({ issues = {}, siblings = [], searchFails = false, transitionRefusesLabels = false, onLabelsRefused = null, transitions = [{ id: "31", name: "Done", to: { name: "Done" } }], onTransitionPost = null }, fn) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  // TEAM-5711: every `?fields=status` GET, so the precondition re-reads are countable.
  const reads = { status: 0, changelog: 0 };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    if (method !== "GET") writes.push({ method, path, body });
    // Exactly `?fields=status` — the precondition reads, not compensateDone's changelog read.
    if (method === "GET" && /\?fields=status$/.test(path)) reads.status += 1;
    if (method === "GET" && /expand=changelog/.test(path)) reads.changelog += 1;
    const json = (payload) => new Response(JSON.stringify(payload ?? {}), { status: 200 });

    if (/\/transitions$/.test(path)) {
      if (method === "POST") {
        // TEAM-4908: a workflow with no transition screen refuses update.labels here.
        if (transitionRefusesLabels && body?.update?.labels) {
          // TEAM-5711: lets a test move the ticket in the window the fallback opens.
          onLabelsRefused?.(issues);
          return new Response(JSON.stringify({ errorMessages: [], errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." } }), { status: 400 });
        }
        // TEAM-5721: a landed POST is a changelog item from the issue's status, which
        // `onTransitionPost` may move first (a move after the last pre-POST read).
        const issue = issues[/^\/rest\/api\/3\/issue\/([^/?]+)/.exec(path)?.[1]];
        if (issue) {
          onTransitionPost?.(issues, body);
          const to = transitions.find((t) => t.id === body?.transition?.id)?.to?.name;
          // TEAM-5723: Jira echoes the POST's historyMetadata on the history it records.
          (issue.history ||= []).push({ id: String(100 + issue.history.length), items: [{ field: "status", fromString: issue.status || "In Review", toString: to }],
            ...(body?.historyMetadata ? { historyMetadata: body.historyMetadata } : {}) });
          // TEAM-5728: a landed POST moves the issue — the read-back sees the status our move produced.
          if (to) issue.status = to;
        }
        return new Response(null, { status: 204 });
      }
      return json({ transitions });
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
        changelog: { histories: issue.history || [] },
      });
    }
    return json({});
  };
  try {
    return await fn({ writes, issues, reads });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const transitionDone = (ticket_id, extra = {}) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id, transition_id: "done", ...extra } });

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

test("gate guard: a workflow with no transition screen still closes — stamp via PUT, then transition (TEAM-4908)", async () => {
  // agentis-demo's team-managed workflow has no transition screens, so Jira 400s
  // `update.labels` on POST /transitions although editmeta lists labels as
  // editable. Before this fallback every human ✅ on a verified gate 409'd.
  await withJira({ issues: { "TEAM-4908": { labels: [...DEPLOY_GATE] } }, transitionRefusesLabels: true }, async ({ writes, issues }) => {
    const res = await transitionDone("TEAM-4908");

    assert.equal(res.status, "done");
    assert.equal(res.gateVerification.result, "indeterminate");
    // 1st POST carried the stamp and was refused; then PUT /issue stamped; then a
    // bare POST closed it — stamp strictly before close.
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [
      "POST /rest/api/3/issue/TEAM-4908/transitions",
      "PUT /rest/api/3/issue/TEAM-4908",
      "POST /rest/api/3/issue/TEAM-4908/transitions",
    ]);
    assert.deepEqual(writes[1].body, { update: { labels: [{ add: "gateverify:indeterminate" }] } });
    assert.deepEqual(writes[2].body, { transition: { id: "31" } });
    assert.ok(issues["TEAM-4908"].labels.includes("gateverify:indeterminate"));
  });
});

// TEAM-5711: the TEAM-4908 fallback PUTs the stamp and POSTs the transition again.
// That second POST went out with no expected_status re-check, so a ticket that moved
// after the pre-POST check (one PUT round-trip later) was still transitioned.
test("gate guard: TEAM-5711 — a status move between the refused labelled POST and the fallback POST is refused, no second transition", async () => {
  await withJira({
    issues: { "TEAM-5711": { labels: [...DEPLOY_GATE] } },
    transitionRefusesLabels: true,
    onLabelsRefused: (issues) => { issues["TEAM-5711"].status = "Blocked"; },
  }, async ({ writes, reads }) => {
    const res = await transitionDone("TEAM-5711", { expected_status: "in_review" });

    const posts = writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path));
    assert.equal(posts.length, 1, "only the refused labelled POST — the fallback POST never goes out");
    assert.ok(posts[0].body.update?.labels, "the one POST is the labelled attempt");
    assert.equal(res.status, undefined, "the ticket did not move");
    assert.match(String(res.error), /^Status precondition failed: TEAM-5711 is blocked, expected in_review — not transitioned\.$/);
    // The stamp landed before the re-check: a stamp with no close, the recoverable half (TEAM-4908).
    assert.equal(writes.filter((w) => w.method === "PUT").length, 1);
    assert.equal(reads.status, 3, "first read, pre-POST re-read, pre-fallback-POST re-read");
  });
});

test("gate guard: TEAM-5711 — the fallback still closes when the status holds, with exactly one extra status read", async () => {
  await withJira({ issues: { "TEAM-5711": { labels: [...DEPLOY_GATE] } }, transitionRefusesLabels: true }, async ({ writes, reads }) => {
    const res = await transitionDone("TEAM-5711", { expected_status: "in_review" });

    assert.equal(res.status, "done");
    assert.equal(writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path)).length, 2);
    assert.equal(reads.status, 3);
    assert.equal(reads.changelog, 2, "TEAM-5721 fence read-back, then compensateDone's");
  });
});

// TEAM-5721: a move that lands AFTER the last pre-POST read (the fallback's re-read
// passed) is caught by the changelog read-back, reverted, and refused.
test("gate guard: TEAM-5721 — a move after the fallback re-read is read back, reverted and refused", async () => {
  await withJira({
    issues: { "TEAM-5721": { labels: [...DEPLOY_GATE] } },
    transitionRefusesLabels: true,
    transitions: [{ id: "31", name: "Done", to: { name: "Done" } }, { id: "11", name: "Blocked", to: { name: "Blocked" } }],
    onTransitionPost: (issues, body) => { if (body.transition.id === "31") issues["TEAM-5721"].status = "Blocked"; },
  }, async ({ writes }) => {
    const res = await transitionDone("TEAM-5721", { expected_status: "in_review" });

    const posts = writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path));
    assert.deepEqual(posts.map((p) => [p.body.transition.id, !!p.body.update?.labels]), [["31", true], ["31", false], ["11", false]]);
    assert.equal(res.status, undefined);
    assert.equal("superseded" in res, false);
    assert.equal(res.error, "Status precondition failed: TEAM-5721 moved under the write (was blocked, expected in_review) — transition reverted.");
  });
});

test("gate guard: any OTHER transition 400 still propagates (no blind retry)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    if (/\/transitions$/.test(path) && method === "POST") {
      return new Response(JSON.stringify({ errorMessages: ["Transition is not valid"] }), { status: 400 });
    }
    if (/\/transitions$/.test(path)) return new Response(JSON.stringify({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] }), { status: 200 });
    if (/\/rest\/api\/3\/issue\/TEAM-4909/.test(path) && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-4909", fields: { labels: [...DEPLOY_GATE], description: null, status: { name: "In Review" }, issuetype: { name: "Task" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    const res = await transitionDone("TEAM-4909");
    assert.match(String(res.error), /Jira API 400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("createTicket: the second identical gate ticket is refused, and the epic is marked", async () => {
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

  // ONE prior: FR-2 makes the SECOND same-triple gate the loop, not the third.
  await withJira({ issues, siblings: [sibling("TEAM-800")] }, async ({ writes }) => {
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
    assert.match(res.error, /1 already exists for the same target/);
    // No second ticket, and the epic carries the marker that dedupes the page.
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 0);
    assert.ok(issues["TEAM-1"].labels.includes("gate:loop-broken"));
  });
});

// ─── TEAM-4986: a deploy gate is keyed on its `exec:<id>`, Jira-side ───────────
//
// The DynamoDB replay is lambda/agentcore-hub-tickets/replay-gate-binding.test.mjs
// and the truth table is src/lib/workflow/gate-loop-parity.test.ts. What only this
// twin can prove is the STATUS round trip: the prior gate is Done in Jira's own
// vocabulary, and it is `mapStatusToInternal` turning "Done" into `done` that makes
// the shared contract's settled-gate rule fire at all.
const TEAM_4986 = {
  pipeline: "hub-juno-deploy",
  execDone: "c33ac06f-b684-4d0a-b486-d8f812020022",
  execNew: "7bb31573-3917-49aa-898e-c132c9bc5ad6",
};

/** TEAM-4979, the earlier follow-up's deploy gate, as Jira's search returns it. */
const deployGateIssue = (statusName) => ({
  key: "TEAM-4979",
  fields: {
    summary: "Deploy Approval: earlier follow-up",
    status: { name: statusName },
    labels: [
      "gate-approval",
      "gate-deploy-approval",
      `pipeline-${TEAM_4986.pipeline}`,
      `exec-${TEAM_4986.execDone}`,
    ],
    issuelinks: [],
  },
});

const fileDeployGate = (exec) =>
  handler({
    tool_name: "Tickets___create_ticket",
    parameters: {
      summary: "Deploy Approval: production deploy for the review-fix follow-up",
      description: "Approve the production deploy.",
      labels: [
        "gate:approval",
        "gate:deploy-approval",
        `pipeline:${TEAM_4986.pipeline}`,
        `exec:${exec}`,
      ],
      parent_key: "TEAM-4798",
    },
  });

test("createTicket: a deploy gate for a SECOND execution is created over a Done one (TEAM-4986)", async () => {
  // The incident on wf_bug_TEAM-4798: refused against a DONE gate for another
  // execution, and the Bug epic wrongly labelled `gate:loop-broken`.
  const issues = { "TEAM-4798": { labels: ["wf:wf_bug_TEAM-4798"], issuetype: "Bug" } };
  await withJira({ issues, siblings: [deployGateIssue("Done")] }, async ({ writes }) => {
    const res = await fileDeployGate(TEAM_4986.execNew);

    assert.notEqual(res.ok, false);
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 1);
    assert.equal(issues["TEAM-4798"].labels.includes("gate:loop-broken"), false);
  });
});

test("createTicket: an OPEN deploy gate for the SAME execution is still the loop (TEAM-4986)", async () => {
  const issues = { "TEAM-4798": { labels: ["wf:wf_bug_TEAM-4798"], issuetype: "Bug" } };
  await withJira({ issues, siblings: [deployGateIssue("In Review")] }, async ({ writes }) => {
    const res = await fileDeployGate(TEAM_4986.execDone);

    assert.equal(res.ok, false);
    assert.equal(res.reason, "gate_loop_environmental");
    assert.equal(res.existingTicketId, "TEAM-4979");
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 0);
    assert.ok(issues["TEAM-4798"].labels.includes("gate:loop-broken"));
  });
});

test("createTicket: a DONE gate for the SAME execution is answered, not looping (TEAM-4986)", async () => {
  // The other half of the status rule, and the twin-parity assertion for Jira's
  // "Done" → `done` map: an answered gate cannot be the ticket to work.
  const issues = { "TEAM-4798": { labels: ["wf:wf_bug_TEAM-4798"], issuetype: "Bug" } };
  await withJira({ issues, siblings: [deployGateIssue("Done")] }, async ({ writes }) => {
    const res = await fileDeployGate(TEAM_4986.execDone);

    assert.notEqual(res.ok, false);
    assert.equal(writes.filter((w) => w.path === "/rest/api/3/issue").length, 1);
    assert.equal(issues["TEAM-4798"].labels.includes("gate:loop-broken"), false);
  });
});

test("createTicket: the gate-loop guard FAILS CLOSED on a failed sibling scan", async () => {
  // TEAM-4780. The refusal now comes from the loop breaker itself, one seam earlier
  // than the open-gate autowire — and with the SAME body, because the two share one
  // scan of `parent = TEAM-1` and a failure leaves both questions unanswered: no
  // loop verdict, and no open-gate freeze state. A gate created over an unknown
  // sibling set may be the very loop the breaker exists to stop, and refusing costs
  // one retry, which is the whole difference from a wedge.
  //
  // It still claims NOTHING about a loop it could not see: no
  // `gate_loop_environmental` reason, and no `gate:loop-broken` label on the epic.
  const issues = { "TEAM-1": { labels: ["wf:wf_1"] } };
  await withJira({ issues, searchFails: true }, async ({ writes }) => {
    const res = await handler({
      tool_name: "Tickets___create_ticket",
      parameters: {
        summary: "CI is unavailable",
        // Fully bound, so the TEAM-4764 shape seam is not what refuses. (It runs
        // AFTER the loop seam anyway — an unbound gate in a loop reports the loop.)
        labels: ["gate:ci-unavailable", "pipeline:hub-x-deploy", `head:${"b".repeat(40)}`],
        parent_key: "TEAM-1",
      },
    });
    assert.notEqual(res.reason, "gate_loop_environmental");
    assert.equal(issues["TEAM-1"].labels.includes("gate:loop-broken"), false);
    assert.match(res.error, /^create_ticket refused: the sibling scan under TEAM-1 failed/);
    assert.match(res.error, /Nothing was created\. Retry the call\./);
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
function captureGateCreate({ createdKey = "TEAM-4711", siblings = [], scanFails = false, pages = null } = {}) {
  const cap = {
    posts: [], fields: null, siblingScans: [], siblingScanUrls: [], dupScans: [],
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
        cap.siblingScanUrls.push(u);
        if (scanFails) {
          return new Response(JSON.stringify({ errorMessages: ["The parent field is not searchable"] }), { status: 400 });
        }
        // TEAM-5168: `pages` serves one search/jql body per request, in order — the
        // paged shape (`isLast`, `nextPageToken`) the real endpoint answers.
        if (pages) return new Response(JSON.stringify(pages[Math.min(cap.siblingScans.length, pages.length) - 1]), { status: 200 });
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

test("TEAM-5168: the create-time sibling scan pages too — an open gate on page 2 still freezes the new ticket", async () => {
  const m = await loadWithMode("off");
  // Page 1: 100 settled human gates (never an OPEN gate, never a root blocker), and
  // Jira says there is more. Page 2: the open Merge Approval gate and the CD ticket.
  const settledGate = (i) => issue(`TEAM-${4000 + i}`, {
    summary: `Merge Approval: round ${i}`,
    status: { name: "Done" },
    labels: ["human-review", "reviewer:tycen"],
    created: `2026-09-13T${String(i % 24).padStart(2, "0")}:00:00.000+0000`,
  });
  const cap = captureGateCreate({
    pages: [
      { issues: Array.from({ length: 100 }, (_, i) => settledGate(i)), isLast: false, nextPageToken: "p2" },
      { issues: [gateIssue(), cdIssue()], isLast: true },
    ],
  });
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
    assert.deepEqual(cap.links, [{
      type: { name: "Blocks" },
      inwardIssue: { key: CD_KEY },
      outwardIssue: { key: "TEAM-4711" },
    }]);
    // Still ONE scan of the parent — it just has two pages now.
    assert.deepEqual(cap.siblingScans, [
      `parent = ${EPIC} ORDER BY created ASC`,
      `parent = ${EPIC} ORDER BY created ASC`,
    ]);
    assert.equal(new URL(cap.siblingScanUrls[0]).searchParams.get("nextPageToken"), null);
    assert.equal(new URL(cap.siblingScanUrls[1]).searchParams.get("nextPageToken"), "p2");
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

// ─── TEAM-5101: the child issue type follows the parent's issue type ──────────
//
// A Jira double that ENFORCES the hierarchy rule, so the create path is proven
// against the refusal it exists to avoid: a Task under a standard issue (Bug) is
// 400 "Please select valid parent issue", and so is a Subtask under an Epic. The
// pure truth table lives in child-issue-type.test.mjs.
const HIERARCHY_TYPES = {
  Epic: { name: "Epic", subtask: false, hierarchyLevel: 1 },
  Bug: { name: "Bug", subtask: false, hierarchyLevel: 0 },
};

// TEAM-5122: `getFailures[key]` answers that parent's issuetype GET with a 503 that
// many times (Infinity = persistent) before the real answer; `gets` counts the reads.
async function withHierarchyJira({ parents, refuseSubtask = false, getFailures = {} }, fn) {
  const originalFetch = globalThis.fetch;
  const originalDelay = process.env.JIRA_PARENT_READ_RETRY_MS;
  process.env.JIRA_PARENT_READ_RETRY_MS = "0";
  const posts = [];
  const gets = [];
  const failuresLeft = { ...getFailures };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    const json = (payload, status = 200) => new Response(JSON.stringify(payload ?? {}), { status });
    if (/\/search\/jql/.test(path)) return json({ issues: [] });
    if (path === "/rest/api/3/issue" && method === "POST") {
      posts.push(body.fields);
      const parentType = body.fields.parent ? parents[body.fields.parent.key] : null;
      const type = body.fields.issuetype?.name;
      const invalid = parentType && (
        (parentType.hierarchyLevel === 0 && type !== "Subtask")
        || (parentType.hierarchyLevel === 1 && type === "Subtask")
        || (refuseSubtask && type === "Subtask"));
      if (invalid) return json({ errorMessages: [], errors: { parentId: "Please select valid parent issue." } }, 400);
      return json({ key: "TEAM-777", id: "777" });
    }
    const keyMatch = /^\/rest\/api\/3\/issue\/([^/?]+)\?fields=issuetype/.exec(path);
    if (keyMatch && method === "GET") {
      gets.push(keyMatch[1]);
      if (failuresLeft[keyMatch[1]] > 0) {
        failuresLeft[keyMatch[1]] -= 1;
        return json({ errorMessages: ["Service Unavailable"] }, 503);
      }
      const t = parents[keyMatch[1]];
      if (!t) return json({ errorMessages: ["Issue does not exist"] }, 404);
      return json({ key: keyMatch[1], fields: { issuetype: t } });
    }
    if (/\/transitions$/.test(path)) {
      if (method === "POST") return new Response(null, { status: 204 });
      return json({ transitions: [{ id: "11", name: "To Do", to: { name: "To Do" } }] });
    }
    return json({});
  };
  try {
    return await fn({ posts, gets });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDelay === undefined) delete process.env.JIRA_PARENT_READ_RETRY_MS;
    else process.env.JIRA_PARENT_READ_RETRY_MS = originalDelay;
  }
}

const createUnder = (parent_key, extra = {}) =>
  handler({ tool_name: "Tickets___create_ticket", parameters: { summary: "Document the new flag [fu:0a1b2c3d]", description: "d", parent_key, ...extra } });

test("TEAM-5101 createTicket: a Task (the default) under a Bug is created as a Subtask, parent kept", async () => {
  await withHierarchyJira({ parents: { "TEAM-5000": HIERARCHY_TYPES.Bug } }, async ({ posts }) => {
    const res = await createUnder("TEAM-5000", { issue_type: "Task" });
    assert.equal(res.error, undefined, `create refused: ${res.error}`);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].issuetype.name, "Subtask");
    assert.deepEqual(posts[0].parent, { key: "TEAM-5000" });
  });
});

test("TEAM-5101 createTicket: a Task under an Epic is unchanged — one POST, issuetype Task", async () => {
  await withHierarchyJira({ parents: { "TEAM-1": HIERARCHY_TYPES.Epic } }, async ({ posts }) => {
    const res = await createUnder("TEAM-1", { issue_type: "Task" });
    assert.equal(res.error, undefined);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].issuetype, { name: "Task" });
    assert.deepEqual(posts[0].parent, { key: "TEAM-1" });
  });
});

test("TEAM-5101 createTicket: a Subtask under an Epic is still coerced to Task", async () => {
  await withHierarchyJira({ parents: { "TEAM-1": HIERARCHY_TYPES.Epic } }, async ({ posts }) => {
    const res = await createUnder("TEAM-1", { issue_type: "subtask" });
    assert.equal(res.error, undefined);
    assert.deepEqual(posts.map((p) => p.issuetype.name), ["Task"]);
  });
});

test("TEAM-5101 createTicket: an unreadable parent leaves a Task a Task", async () => {
  await withHierarchyJira({ parents: {} }, async ({ posts }) => {
    await createUnder("TEAM-404", { issue_type: "Task" });
    assert.deepEqual(posts.map((p) => p.issuetype.name), ["Task"]);
  });
});

test("TEAM-5101 createTicket: a refused Subtask we converted is NOT retried as Task and NEVER created parentless", async () => {
  // Before: the refusal fell into the Task retry (known-invalid under a Bug) and
  // then the parentless last resort — an orphan the caller counts as created.
  await withHierarchyJira({ parents: { "TEAM-5000": HIERARCHY_TYPES.Bug }, refuseSubtask: true }, async ({ posts }) => {
    const res = await createUnder("TEAM-5000", { issue_type: "Task" });
    assert.match(res.error, /^Jira API 400: .*Please select valid parent issue/);
    assert.deepEqual(posts.map((p) => p.issuetype.name), ["Subtask"]);
    assert.ok(posts.every((p) => p.parent?.key === "TEAM-5000"), "no parentless POST");
  });
});

// ─── TEAM-5122: an unreadable parent refuses retryably; a standard parent takes only a Subtask ───

test("TEAM-5122 createTicket: a parent GET that 503s under a Bug returns parent_type_unreadable and sends NO POST", async () => {
  // Before: the failed read left the type unknown, a Task was POSTed under the Bug,
  // and Jira's 400 read as permanent in workflow-output — the follow-up was lost.
  await withHierarchyJira({ parents: { "TEAM-5000": HIERARCHY_TYPES.Bug }, getFailures: { "TEAM-5000": Infinity } }, async ({ posts, gets }) => {
    const res = await createUnder("TEAM-5000", { issue_type: "Task" });
    assert.equal(res.reason, "parent_type_unreadable");
    assert.equal(res.ok, false);
    assert.match(res.error, /^parent_type_unreadable: /);
    assert.equal(posts.length, 0, `expected no create POST, got ${JSON.stringify(posts.map((p) => p.issuetype.name))}`);
    assert.equal(gets.length, 2, "the parent is read once more before refusing");
  });
});

test("TEAM-5122 createTicket: an explicit Subtask under a Bug that Jira refuses is NOT retried as Task and NEVER created parentless", async () => {
  await withHierarchyJira({ parents: { "TEAM-5000": HIERARCHY_TYPES.Bug }, refuseSubtask: true }, async ({ posts }) => {
    const res = await createUnder("TEAM-5000", { issue_type: "Subtask" });
    assert.match(res.error || "", /^Jira API 400: .*Please select valid parent issue/);
    assert.deepEqual(posts.map((p) => p.issuetype.name), ["Subtask"], "no Task retry");
    assert.ok(posts.every((p) => p.parent?.key === "TEAM-5000"), "no parentless POST");
  });
});

test("TEAM-5122 createTicket: an Epic whose GET fails once is re-read and still gets its Task", async () => {
  await withHierarchyJira({ parents: { "TEAM-1": HIERARCHY_TYPES.Epic }, getFailures: { "TEAM-1": 1 } }, async ({ posts, gets }) => {
    const res = await createUnder("TEAM-1", { issue_type: "Task" });
    assert.equal(res.error, undefined, `create refused: ${res.error}`);
    assert.equal(gets.length, 2);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].issuetype, { name: "Task" });
    assert.deepEqual(posts[0].parent, { key: "TEAM-1" });
  });
});

test("TEAM-5122 createTicket: an Epic whose GET 503s PERSISTENTLY also refuses retryably, with NO POST — the trade-off plan A accepts", async () => {
  // Unlike the single-failure case above, a persistent 503 gives no second read that
  // could reveal the Epic. The design in plan A treats this the same as a Bug: refuse
  // with parent_type_unreadable rather than guess Task and risk a Subtask-under-Epic
  // style mismatch. Nothing is created; the caller retries the same call.
  await withHierarchyJira({ parents: { "TEAM-1": HIERARCHY_TYPES.Epic }, getFailures: { "TEAM-1": Infinity } }, async ({ posts, gets }) => {
    const res = await createUnder("TEAM-1", { issue_type: "Task" });
    assert.equal(res.reason, "parent_type_unreadable");
    assert.equal(res.ok, false);
    assert.match(res.error, /^parent_type_unreadable: /);
    assert.equal(posts.length, 0, `expected no create POST, got ${JSON.stringify(posts.map((p) => p.issuetype.name))}`);
    assert.equal(gets.length, 2, "the parent is read once more before refusing");
  });
});

// ─── TEAM-5421: cancelled (Won't Do) is terminal ───────────────────────────────

/**
 * Jira stub for the terminal-status guard: `status` answers the pre-move read,
 * `readBack` (status + changelog) answers the post-Done read. Records every POST.
 */
function installTerminalStub({ status, readBack = null, transitions }) {
  const calls = { transitions: [], comments: [], restore: null };
  const originalFetch = globalThis.fetch;
  calls.restore = () => { globalThis.fetch = originalFetch; };
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("expand=changelog") && method === "GET") return json({ key: "TEAM-77", ...readBack });
    if (u.includes("fields=status") && method === "GET") return json({ key: "TEAM-77", fields: { status: { name: status } } });
    if (u.includes("fields=labels") && method === "GET") return json({ key: "TEAM-77", fields: { labels: [] } });
    if (u.includes("/transitions") && method === "GET") return json({ transitions });
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

const TERMINAL_TRANSITIONS = [
  { id: "11", name: "Start", to: { name: "In Progress" } },
  { id: "21", name: "Reopen", to: { name: "To Do" } },
  { id: "31", name: "Done", to: { name: "Done" } },
  { id: "41", name: "Close it", to: { name: "Won't Do" } },
];
const moveTo = (transition_id) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-77", transition_id } });

test("TEAM-5421: mapStatusToInternal maps Won't Do and its spellings to cancelled", () => {
  assert.equal(mapStatusToInternal("Won't Do"), "cancelled");
  for (const n of [" won't do ", "WONT DO", "Cancelled", "canceled"]) assert.equal(mapStatusToInternal(n), "cancelled", n);
  assert.equal(mapStatusToInternal("In Progress"), "in_progress");
});

test("TEAM-5421: a cancelled ticket cannot transition anywhere, and nothing is POSTed", async () => {
  for (const target of ["in_progress", "todo", "done", "skip"]) {
    const cap = installTerminalStub({ status: "Won't Do", transitions: TERMINAL_TRANSITIONS });
    try {
      const res = await moveTo(target);
      assert.match(res.error, /cancelled is terminal/, target);
      assert.deepEqual(cap.transitions, [], target);
      assert.deepEqual(cap.comments, [], target);
    } finally {
      cap.restore();
    }
  }
});

test("TEAM-5421: done → cancelled is refused", async () => {
  const cap = installTerminalStub({ status: "Done", transitions: TERMINAL_TRANSITIONS });
  try {
    const res = await moveTo("cancelled");
    assert.match(res.error, /a done ticket is never cancelled/);
    assert.deepEqual(cap.transitions, []);
  } finally {
    cap.restore();
  }
});

test("TEAM-5421: done → reopen (To Do) is still allowed", async () => {
  const cap = installTerminalStub({ status: "Done", transitions: TERMINAL_TRANSITIONS });
  try {
    const res = await moveTo("todo");
    assert.equal(res.status, "todo");
    assert.deepEqual(cap.transitions, [{ transition: { id: "21" } }]);
  } finally {
    cap.restore();
  }
});

test("TEAM-5421: compensateDone — a Done POST that raced the cancel goes back to Won't Do with a Superseded comment", async () => {
  const cap = installTerminalStub({
    status: "In Progress", // what the pre-move read saw; the cancel landed after it
    readBack: {
      fields: { status: { name: "Done" } },
      changelog: { histories: [
        { items: [{ field: "status", fromString: "In Progress", toString: "Won't Do" }] },
        { items: [{ field: "status", fromString: "Won't Do", toString: "Done" }] },
      ] },
    },
    transitions: TERMINAL_TRANSITIONS,
  });
  try {
    const res = await moveTo("done");
    assert.equal(res.superseded, true);
    assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }, { transition: { id: "41" } }]);
    assert.equal(cap.comments.length, 1);
    assert.match(adfToText(cap.comments[0].body), /^Superseded:/);
  } finally {
    cap.restore();
  }
});

test("TEAM-5421: compensateDone leaves an ordinary Done alone", async () => {
  const cap = installTerminalStub({
    status: "In Progress",
    readBack: { fields: { status: { name: "Done" } }, changelog: { histories: [
      { items: [{ field: "status", fromString: "In Progress", toString: "Done" }] },
    ] } },
    transitions: TERMINAL_TRANSITIONS,
  });
  try {
    const res = await moveTo("done");
    assert.equal(res.status, "done");
    assert.equal("superseded" in res, false);
    assert.deepEqual(cap.transitions, [{ transition: { id: "31" } }]);
    assert.deepEqual(cap.comments, []);
  } finally {
    cap.restore();
  }
});

test("TEAM-5421: findCancelTransition picks by destination, not by name", () => {
  const picked = findCancelTransition([
    { id: "1", name: "Won't Do", to: { name: "Done" } }, // named like a cancel, lands in Done
    { id: "2", name: "Close it", to: { name: "Won't Do" } },
  ]);
  assert.equal(picked.id, "2");
  assert.equal(findCancelTransition([{ id: "1", name: "Cancelled", to: { name: "Done" } }]), null);
});

// ─── TEAM-5719 (R1-3): park-claim label carries the parking claim generation ────

/**
 * Stub for a Blocked transition: serves the status reads, a `?fields=labels` read
 * (the existing labels), the transition list, and records transition POSTs and
 * issue PUTs. `refuseLabelsOnPost` replays the TEAM-4908 screen refusal.
 */
function installParkStub({ labels = [], refuseLabelsOnPost = false } = {}) {
  const calls = { labelReads: 0, transitions: [], puts: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("fields=status") && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { status: { name: "In Progress" } } }), { status: 200 });
    }
    if (u.includes("fields=labels") && method === "GET") {
      calls.labelReads++;
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { labels } }), { status: 200 });
    }
    if (u.includes("/transitions") && method === "GET") {
      return new Response(JSON.stringify({ transitions: [
        { id: "11", name: "Blocked", to: { name: "Blocked" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ] }), { status: 200 });
    }
    if (u.includes("/transitions") && method === "POST") {
      const body = JSON.parse(init.body);
      calls.transitions.push(body);
      if (refuseLabelsOnPost && body.update?.labels) {
        return new Response(JSON.stringify({ errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." } }), { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (/\/rest\/api\/3\/issue\/TEAM-24$/.test(u) && method === "PUT") {
      calls.puts.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  return calls;
}

const GEN_5719 = "2026-10-13T01:00:00.000Z";
const park5719 = (extra = {}) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", ...extra } });

test("TEAM-5719: a park with claim_started_at adds park-claim:<gen>:<nonce> in the transition POST and removes other generations' labels", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installParkStub({ labels: ["wf:wf_1", "park-claim:2026-10-12T00:00:00.000Z", "park-claim:2026-10-12T00:00:00.000Z:00000000-0000-4000-8000-000000000000"] });
  try {
    const res = await park5719({ claim_started_at: GEN_5719 });
    assert.equal(res.status, "blocked");
    assert.equal(calls.transitions.length, 1);
    const [post] = calls.transitions;
    // TEAM-5729: the nonce the label names is the one the POST's historyMetadata carries.
    const nonce = post.historyMetadata?.extraData?.fenceNonce;
    assert.match(String(nonce), UUID_RE);
    assert.deepEqual(post.transition, { id: "11" });
    assert.deepEqual(post.update, { labels: [
      { remove: "park-claim:2026-10-12T00:00:00.000Z" },
      { remove: "park-claim:2026-10-12T00:00:00.000Z:00000000-0000-4000-8000-000000000000" },
      { add: `park-claim:${GEN_5719}:${nonce}` },
    ] }, "legacy and nonced labels of OTHER generations come off; ours names this request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5719: the TEAM-4908 screen-refusal fallback PUTs the park-claim label before the label-less transition", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installParkStub({ refuseLabelsOnPost: true });
  try {
    const res = await park5719({ claim_started_at: GEN_5719 });
    assert.equal(res.status, "blocked");
    const nonce = calls.transitions[0].historyMetadata?.extraData?.fenceNonce;
    assert.match(String(nonce), UUID_RE);
    assert.deepEqual(calls.puts, [{ update: { labels: [{ add: `park-claim:${GEN_5719}:${nonce}` }] } }]);
    assert.deepEqual(calls.transitions.at(-1).transition, { id: "11" });
    assert.equal(calls.transitions.at(-1).historyMetadata?.extraData?.fenceNonce, nonce, "TEAM-5729: the unlabelled POST carries the same nonce the label names");
    assert.equal(calls.transitions.at(-1).update, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5719: no park-claim label without a claim, with a malformed claim, or for a non-blocked target", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const extra of [{}, { claim_started_at: 42 }, { claim_started_at: "has space" }, { claim_started_at: "" }]) {
      const calls = installParkStub({ labels: ["park-claim:old"] });
      await park5719(extra);
      assert.deepEqual(calls.transitions, [{ transition: { id: "11" } }], JSON.stringify(extra));
      assert.equal(calls.labelReads, 0);
    }
    const calls = installParkStub();
    await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "done", claim_started_at: GEN_5719 } });
    assert.deepEqual(calls.transitions, [{ transition: { id: "31" } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-5724 (R2-2): a park-claim label never outlives a park that did not verify ──
//
// In the TEAM-4908 fallback the park-claim label goes out in its own PUT BEFORE the
// transition, and on the labelled path it rides a transition the fence may revert.
// Either way a leftover `park-claim:<gen>` on a ticket that never moved (or was moved
// back) is a credential: parkGeneration (lambda/orchestrator/lease.mjs) would attribute
// a LATER third-party park to the live claim and release it. Every throw after the
// first POST must therefore take the label we added back off, then rethrow unchanged.
// Each case sends the production park shape: claim_started_at + expected_status.

const GEN_5724 = "2026-10-13T02:00:00.000Z";
// TEAM-5729: the label names THIS request's nonce, so it is derived from the first POST.
const PARK_5724 = (calls) => `park-claim:${GEN_5724}:${calls.transitions[0].historyMetadata.extraData.fenceNonce}`;
const park5724 = (extra = {}) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress", claim_started_at: GEN_5724, ...extra } });
const parkClaimLabelsOf = (labels) => labels.filter((l) => l.startsWith("park-claim:"));
const REMOVE_5724 = (calls) => ({ update: { labels: [{ remove: PARK_5724(calls) }] } });

test("TEAM-5724 (a): fallback — label PUT lands, unlabelled POST 500s → the error propagates and the park-claim label is taken back off", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ labels: ["wf:wf_1"], refuseLabelsOnPost: true, failUnlabelledPost: true });
  try {
    const res = await park5724();
    assert.equal(res.status, undefined, "the ticket did not move");
    assert.match(String(res.error), /Jira API 500/, "the ORIGINAL error, not a compensation error");
    assert.doesNotMatch(String(res.error), /(^|[^ ])transitioned/i, "the harness's _ParkGate._moved keys on that word");
    assert.deepEqual(calls.transitions.map((t) => [t.transition.id, !!t.update?.labels]), [["11", true], ["11", false]], "labelled attempt, then the fallback POST");
    assert.deepEqual(calls.puts, [{ update: { labels: [{ add: PARK_5724(calls) }] } }, REMOVE_5724(calls)], "the stamp, then its removal");
    assert.deepEqual(calls.labels, ["wf:wf_1"], "no park-claim label survives a park that did not happen");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5724 (b): fallback — the re-check after the label PUT refuses → no second POST, label taken back off", async () => {
  const originalFetch = globalThis.fetch;
  // first read, pre-POST re-read, pre-fallback-POST re-read: the ticket moved under the PUT
  const calls = installTransitionStub({ labels: ["wf:wf_1", "park-claim:older"], refuseLabelsOnPost: true, statusSequence: ["In Progress", "In Progress", "Blocked"] });
  try {
    const res = await park5724();
    assert.equal(res.status, undefined);
    assert.match(String(res.error), /^Status precondition failed: TEAM-24 is blocked, expected in_progress — not transitioned\.$/);
    assert.equal(calls.transitions.length, 1, "only the refused labelled POST");
    assert.deepEqual(calls.puts, [{ update: { labels: [{ remove: "park-claim:older" }, { add: PARK_5724(calls) }] } }, REMOVE_5724(calls)]);
    assert.deepEqual(parkClaimLabelsOf(calls.labels), [], "neither the new nor the stale generation remains");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5724 (c1): labelled path — the fence reverts the move (source was Done) → the label that rode the transition is taken back off", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ labels: ["wf:wf_1"], statusAtPost: "Done" });
  try {
    const res = await park5724({ reason: "park" });
    assert.equal(res.status, undefined);
    assert.equal(res.error, "Status precondition failed: TEAM-24 moved under the write (was done, expected in_progress) — transition reverted.");
    assert.deepEqual(calls.transitions.map((t) => [t.transition.id, !!t.update?.labels]), [["11", true], ["31", false]], "the labelled park, then the revert");
    assert.deepEqual(calls.puts, [REMOVE_5724(calls)], "one PUT: the removal (the add rode the POST)");
    assert.deepEqual(calls.labels, ["wf:wf_1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5724 (c2): fallback path — the fence reverts the move → the PUT-stamped label is taken back off", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ labels: ["wf:wf_1"], refuseLabelsOnPost: true, statusAtPost: "Done" });
  try {
    const res = await park5724();
    assert.equal(res.status, undefined);
    assert.equal(res.error, "Status precondition failed: TEAM-24 moved under the write (was done, expected in_progress) — transition reverted.");
    assert.deepEqual(calls.transitions.map((t) => [t.transition.id, !!t.update?.labels]), [["11", true], ["11", false], ["31", false]]);
    assert.deepEqual(calls.puts, [{ update: { labels: [{ add: PARK_5724(calls) }] } }, REMOVE_5724(calls)]);
    assert.deepEqual(calls.labels, ["wf:wf_1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5724 (d): a failed compensating PUT is logged, and the ORIGINAL error still propagates", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  const calls = installTransitionStub({ labels: ["wf:wf_1"], refuseLabelsOnPost: true, failUnlabelledPost: true, failParkClaimRemoval: true });
  try {
    const res = await park5724();
    assert.equal(res.status, undefined);
    assert.match(String(res.error), /Jira API 500: .*Internal server error/, "the POST's error, not the PUT's");
    assert.doesNotMatch(String(res.error), /label store down/);
    assert.deepEqual(calls.puts, [{ update: { labels: [{ add: PARK_5724(calls) }] } }, REMOVE_5724(calls)], "the removal was attempted");
    assert.ok(warnings.some((w) => w.includes(PARK_5724(calls)) && w.includes("label store down")), `a warning names the label and the cause: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5724: a park that verifies keeps its label and issues no compensating PUT (TEAM-5719 unchanged)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const refuseLabelsOnPost of [false, true]) {
      const calls = installTransitionStub({ labels: ["wf:wf_1", "park-claim:older"], refuseLabelsOnPost });
      const res = await park5724();
      assert.equal(res.status, "blocked", `refuse=${refuseLabelsOnPost}`);
      assert.deepEqual(calls.labels, ["wf:wf_1", PARK_5724(calls)], `refuse=${refuseLabelsOnPost}`);
      assert.equal(calls.puts.length, refuseLabelsOnPost ? 1 : 0, `refuse=${refuseLabelsOnPost}: only the fallback stamp, never a removal`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-5729 (R3-2 / R3-3): the label is a POINTER, the changelog entry is the evidence ──
//
// A `park-claim:<gen>` label alone used to be the credential parkGeneration
// (lambda/orchestrator/lease.mjs) released a claim on. R3-2: label PUT ok → POST 500 →
// cleanup PUT 500 left that credential on a ticket that never moved. R3-3: two overlapping
// Lambda executions of ONE park (the harness client retries a timed-out invoke while the
// first still runs) shared the string, so the failing one deleted the successful one's label.
// Now the label is `park-claim:<gen>:<nonce>`, every transition POST of the request carries
// the nonce in historyMetadata (even without expected_status), strip-prior spares same-
// generation siblings, and the orchestrator releases only on the nonce's own changelog entry.

const GEN_5729 = "2026-10-13T04:00:00.000Z";
const park5729 = (extra = {}) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", expected_status: "in_progress", claim_started_at: GEN_5729, ...extra } });
const nonceOf = (post) => post?.historyMetadata?.extraData?.fenceNonce;
const carriersOf = (histories, nonce) => (histories || []).filter((h) => h.historyMetadata?.extraData?.fenceNonce === nonce);

test("TEAM-5729 (J1, R3-2): label PUT lands, POST 500s, cleanup PUT 500s → the leftover label names THIS request and has no changelog carrier (inert)", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  const calls = installTransitionStub({ labels: ["wf:wf_1"], refuseLabelsOnPost: true, failUnlabelledPost: true, failParkClaimRemoval: true });
  try {
    const res = await park5729();
    assert.equal(res.status, undefined, "the ticket did not move");
    assert.match(String(res.error), /Jira API 500/, "the ORIGINAL error propagates");
    const nonce = nonceOf(calls.transitions[0]);
    assert.match(String(nonce), UUID_RE, "the park POST carries a per-request nonce");
    assert.equal(nonceOf(calls.transitions[1]), nonce, "both POSTs of one request carry the same nonce");
    const label = `park-claim:${GEN_5729}:${nonce}`;
    assert.deepEqual(calls.labels, ["wf:wf_1", label], "the leftover names generation AND request, never the generation alone");
    assert.deepEqual(calls.puts.at(-1), { update: { labels: [{ remove: label }] } }, "cleanup targeted exactly this request's label");
    assert.equal(carriersOf(calls.histories, nonce).length, 0, "no changelog carrier: the leftover can confirm nothing to the orchestrator");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("TEAM-5729 (J2, R3-3): overlapping retry of ONE park — A pauses in its fallback POST, B parks and verifies, A fails → B's label and carrier survive", async () => {
  const originalFetch = globalThis.fetch;
  let releaseA;
  const held = new Promise((resolve) => { releaseA = resolve; });
  const calls = installTransitionStub({
    labels: ["wf:wf_1"], refuseLabelsOnPost: true,
    unlabelledPostGate: async (_body, n) => {
      if (n !== 1) return undefined; // B's unlabelled POST is served normally
      await held; // A sits inside its POST until the test lets it fail
      return new Response(JSON.stringify({ errorMessages: ["Internal server error"] }), { status: 500 });
    },
  });
  try {
    const a = park5729();
    // A: labelled POST refused (transitions 1), label PUT (puts 1), re-check, unlabelled POST (transitions 2) — now paused.
    for (let spins = 0; !(calls.transitions.length === 2 && calls.puts.length === 1); spins++) {
      if (spins > 10_000) throw new Error(`A never reached its paused POST: transitions=${calls.transitions.length} puts=${calls.puts.length}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const b = await park5729();
    releaseA();
    const ra = await a;

    assert.equal(b.status, "blocked", "B's park verified and reported moved");
    assert.equal(ra.status, undefined);
    assert.match(String(ra.error), /Jira API 500/, "A's park failed with its own error");
    const nA = nonceOf(calls.transitions[0]), nB = nonceOf(calls.transitions[2]);
    assert.match(String(nA), UUID_RE);
    assert.match(String(nB), UUID_RE);
    assert.notEqual(nA, nB, "two requests of one park never share a nonce");
    const A = `park-claim:${GEN_5729}:${nA}`, B = `park-claim:${GEN_5729}:${nB}`;
    assert.deepEqual(calls.puts, [
      { update: { labels: [{ add: A }] } },
      { update: { labels: [{ add: B }] } },
      { update: { labels: [{ remove: A }] } },
    ], "B strips no same-generation sibling; A removes only its own label");
    assert.deepEqual(calls.labels, ["wf:wf_1", B], "the label of the park that landed survives the sibling's failure");
    const carriers = carriersOf(calls.histories, nB);
    assert.equal(carriers.length, 1, "exactly one changelog entry carries B's nonce");
    assert.deepEqual(carriers[0].items, [{ field: "status", fromString: "In Progress", toString: "Blocked" }]);
    assert.equal(carriersOf(calls.histories, nA).length, 0, "A's nonce has no entry: nothing to confirm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TEAM-5729 (J3): a park WITHOUT expected_status still stamps the request nonce in historyMetadata, and the label names it", async () => {
  const originalFetch = globalThis.fetch;
  const calls = installTransitionStub({ labels: ["wf:wf_1"] });
  try {
    const res = await handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-24", transition_id: "blocked", claim_started_at: GEN_5729 } });
    assert.equal(res.status, "blocked");
    assert.equal(calls.transitions.length, 1);
    const nonce = nonceOf(calls.transitions[0]);
    assert.match(String(nonce), UUID_RE, "a park is always attributable, fenced or not");
    assert.equal(calls.transitions[0].historyMetadata.extraData.expectedStatus, "", "no fence → empty expectedStatus, never \"null\"");
    assert.deepEqual(calls.transitions[0].update.labels, [{ add: `park-claim:${GEN_5729}:${nonce}` }]);
    assert.equal(calls.changelogReads, 0, "no expected_status → no fence read-back (TEAM-5721 behaviour unchanged)");
    assert.deepEqual(calls.labels, ["wf:wf_1", `park-claim:${GEN_5729}:${nonce}`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
