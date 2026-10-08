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

import { adfToText, getIssue, handler, clampSummary, SEARCH_MAX_PAGES } from "./index.mjs";
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

// TEAM-5340 F2: report_completion reads the run's review cap off the Merge Approval
// gate's gate-meta line, so get_issue has to hand back the description (flattened).
test("getIssue: requests description and returns it flattened (gate-meta stays readable)", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  const meta = 'gate-meta: {"gate":"merge-approval","maxRounds":2}';
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (url.includes("/comment")) return new Response(JSON.stringify({ comments: [] }), { status: 200 });
    return new Response(JSON.stringify({
      key: "TEAM-2",
      fields: {
        summary: "Merge Approval: x", status: { name: "To Do" }, labels: [], issuetype: { name: "Task" },
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Merge Approval gate." }] }, { type: "paragraph", content: [{ type: "text", text: meta }] }] },
      },
    }), { status: 200 });
  };
  try {
    const result = await getIssue({ issue_key: "TEAM-2" });
    const issueUrl = requested.find((u) => !u.includes("/comment"));
    assert.ok(/[?&]fields=[^&]*description/.test(issueUrl), `issue GET should request description: ${issueUrl}`);
    assert.equal(typeof result.description, "string");
    assert.equal(result.description.trim().split("\n").at(-1), meta);
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
    // TEAM-5338: every non-Done transition reads labels+status (is this a human gate leaving review?)
    if (url.includes("/rest/api/3/issue/") && url.includes("fields=labels,status") && method === "GET") {
      return new Response(JSON.stringify({ key: "TEAM-24", fields: { labels: ["agent:dev"], status: { name: "In Progress" } } }), { status: 200 });
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

// TEAM-4706 (d) — a human-review gate closes with no completion record — now runs
// on the decision harness below (TEAM-5391: every human gate needs a signed pick),
// see "TEAM-5391: an UNDECLARED human gate ...".

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

test("TEAM-5348 (g2): a ship-phase record at complete_pending_event / complete_pending_sweep refuses the direct Done - followUpsPending:false is not enough", async () => {
  // The reviewer's probe: TEAM-5340's two withheld states leave followUpsPending
  // false, so the `=== true` test alone let a direct Done walk around the hold.
  for (const status of ["complete_pending_event", "complete_pending_sweep", "complete_pending_something_new"]) {
    const { res, cap, s3Calls } = await shipDoneWithRecord(
      JSON.stringify({ ticketId: SHIP_TICKET, summary: "deployed", followUpsPending: false, status })
    );
    assert.equal(res.ok, false, status);
    assert.equal(res.reason, "completion_record_required");
    assert.equal(res.hint, COMPLETION_HINT);
    assert.match(res.error, new RegExp(`completions/TEAM-4066\\.json is still ${status}`));
    assert.match(res.error, /re-run with the same arguments and answers complete/);
    assert.deepEqual(cap.transitions, [], `a ${status} record must not close a ship ticket`);
    assert.deepEqual(s3Calls.records, [SHIP_RECORD_KEY]);
  }
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
async function withJira({ issues = {}, siblings = [], searchFails = false, transitionRefusesLabels = false }, fn) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    if (method !== "GET") writes.push({ method, path, body });
    const json = (payload) => new Response(JSON.stringify(payload ?? {}), { status: 200 });

    if (/\/transitions$/.test(path)) {
      if (method === "POST") {
        // TEAM-4908: a workflow with no transition screen refuses update.labels here.
        if (transitionRefusesLabels && body?.update?.labels) {
          return new Response(JSON.stringify({ errorMessages: [], errors: { labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown." } }), { status: 400 });
        }
        return new Response(null, { status: 204 });
      }
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

// ─── TEAM-5322: the human-gate decision contract, Jira-side ─────────────────────
//
// The cross-provider rows land in gate-guard-parity.test.ts (chunk C). What is
// asserted here is what only this twin does: the listed-human comment source
// (author.accountId in GATE_HUMAN_ACCOUNT_IDS, never the service account from
// /myself), the entity properties that hold the post-condition and the signed
// verification state, the JQL-driven reprobe, and the already-Done ratify path.
//
// Env: GATE_DECISION_KEY (the literal-key test seam) and GATE_HUMAN_ACCOUNT_IDS
// are read at CALL time, so each test sets and restores them. PIPELINE_TOOLS_LAMBDA
// and ARTIFACT_BUCKET are read at module load, so each test gets a fresh instance;
// the probe is stubbed at LambdaClient.prototype.send (no module mocking here).

import { LambdaClient } from "@aws-sdk/client-lambda";
import { mintDecisionToken } from "./decision-contract.mjs";
import { buildGateVerify, gateDecisionRecordKey, gateHoldActedKey, verifyGateDecisionRecord } from "./gate-contract.mjs";

const DKEY = "test-decision-key-not-a-secret";
const SVC = "svc-account-1";
const HUMAN = "human-account-1";
const DWF = "wf_1791220686225_znl7a4";
const BOUND_DESC = ["Deploy hub-x to prod?", "DECISION OPTIONS: approve | reject"];
const PC = { kind: "pipeline_execution", target: "hub-x-deploy#0f8fad5b-d9cb-469f-a165-70867728950e", expect: { status: "Succeeded" } };

const adfDoc = (lines) => ({
  type: "doc",
  version: 1,
  content: [].concat(lines).map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

/** A fresh instance, with the S3 traffic recorded and the probe answering `probe`. */
async function loadDecisionGate({ probe = null, bucket = "hub-artifacts", humans = null } = {}) {
  process.env.ARTIFACT_BUCKET = bucket;
  if (probe) process.env.PIPELINE_TOOLS_LAMBDA = "hub-pipeline-tools";
  else delete process.env.PIPELINE_TOOLS_LAMBDA;
  const mod = await import(`./index.mjs?decision-gate=${loadSeq++}`);
  delete process.env.PIPELINE_TOOLS_LAMBDA;
  // A keyed S3: PutObject honours `IfNoneMatch:"*"` (412 PreconditionFailed when the key
  // exists, as S3 does), GetObject answers a stored body or 403 AccessDenied (the role has
  // no s3:ListBucket, so a miss is 403 in prod too). `s3Puts` keeps the signed records
  // the TEAM-5322/5340 tests assert on; the TEAM-5347 create-once ledger writes
  // (jti/, holds/) are kept apart in `ledgerPuts`. `s3Fail.fn(cmd)` may return an error
  // to throw, to script a 409 or a 5xx.
  // TEAM-5372: PutObject also honours `IfMatch` and answers an ETag (GetObject too),
  // and `seq` logs `put:<key>` in order, for "the record lands first" assertions (a
  // test pushes its Jira writes onto it through hooks.beforeWrite). TEAM-5387: the
  // twin never deletes a gate-decision record, so a DeleteObject THROWS here and
  // `s3Deletes` stays as the canary the record tests assert empty.
  const s3Puts = [];
  const ledgerPuts = [];
  const s3Deletes = [];
  const seq = [];
  const objects = new Map();
  const etags = new Map();
  let etagSeq = 0;
  const s3Fail = { fn: null };
  const precondition = () => {
    const err = new Error("At least one of the pre-conditions you specified did not hold");
    err.name = "PreconditionFailed";
    err.$metadata = { httpStatusCode: 412 };
    return err;
  };
  const isLedgerKey = (key) => /\/gate-decisions\/[^/]+\/(jti|holds)\//.test(key);
  mod.s3.send = async (cmd) => {
    const forced = s3Fail.fn ? s3Fail.fn(cmd) : null;
    if (forced) throw forced;
    if (cmd.constructor.name === "PutObjectCommand") {
      const { Key, Body, IfNoneMatch, IfMatch } = cmd.input;
      if (IfNoneMatch === "*" && objects.has(Key)) throw precondition();
      if (IfMatch && etags.get(Key) !== IfMatch) throw precondition();
      objects.set(Key, String(Body));
      etags.set(Key, `"etag-${++etagSeq}"`);
      seq.push(`put:${Key}`);
      (isLedgerKey(Key) ? ledgerPuts : s3Puts).push({ key: Key, body: JSON.parse(Body) });
      return { ETag: etags.get(Key) };
    }
    if (cmd.constructor.name === "DeleteObjectCommand") {
      s3Deletes.push({ key: cmd.input.Key, ifMatch: cmd.input.IfMatch });
      throw new Error(`DeleteObject must never be issued by the jira twin (TEAM-5387): ${cmd.input.Key}`);
    }
    if (cmd.constructor.name === "GetObjectCommand" && objects.has(cmd.input.Key)) {
      const body = objects.get(cmd.input.Key);
      // An object a test seeded straight into `objects` gets its ETag on first read.
      if (!etags.has(cmd.input.Key)) etags.set(cmd.input.Key, `"etag-${++etagSeq}"`);
      return { Body: { transformToString: async () => body }, ETag: etags.get(cmd.input.Key) };
    }
    const err = new Error("Access Denied");
    err.name = "AccessDenied";
    err.$metadata = { httpStatusCode: 403 };
    throw err;
  };
  const probeCalls = [];
  const originalSend = LambdaClient.prototype.send;
  LambdaClient.prototype.send = async function (cmd) {
    const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
    probeCalls.push(req);
    const text = JSON.stringify(probe || {});
    return { Payload: Buffer.from(JSON.stringify({ content: [{ type: "text", text }] })) };
  };
  const env = { GATE_DECISION_KEY: process.env.GATE_DECISION_KEY, GATE_HUMAN_ACCOUNT_IDS: process.env.GATE_HUMAN_ACCOUNT_IDS };
  process.env.GATE_DECISION_KEY = DKEY;
  if (humans === null) delete process.env.GATE_HUMAN_ACCOUNT_IDS;
  else process.env.GATE_HUMAN_ACCOUNT_IDS = humans;
  const restore = () => {
    LambdaClient.prototype.send = originalSend;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { mod, s3Puts, ledgerPuts, s3Deletes, seq, objects, s3Fail, probeCalls, restore };
}

/**
 * A scripted Jira that keeps state: labels, status, comments (with author
 * accountId and `created`), entity properties, and a changelog (`history`) of
 * every status and label change. `writes` is every non-GET in order; `gets` every
 * GET path. The mock clock starts 5 minutes in the past and ticks 1s per event,
 * so a write always lands after a seeded one and before a token minted now.
 * `hooks.beforeWrite(write, issues)` runs before a write is applied: a test's
 * way to land a concurrent human action, or to fail a write. `hooks.beforeGet`
 * does the same before a read is served (TEAM-5408).
 */
async function withDecisionJira(issues, fn, hooks = {}) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  const gets = [];
  const STATUS_BY_TRANSITION = { 31: "Done", 21: "In Review", 41: "Blocked", 51: "Won't Do", 11: "Ready" };
  let clock = Date.now() - 300_000;
  const tick = () => new Date((clock += 1000)).toISOString();
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    if (method === "GET") gets.push(path);
    else writes.push({ method, path, body });
    const json = (payload, status = 200) => new Response(JSON.stringify(payload ?? {}), { status });
    const notFound = () => json({ errorMessages: ["not found"] }, 404);
    // TEAM-5408: `hooks.beforeGet(get, issues, tick)` runs before a read is served: a
    // test's way to land a concurrent human action BETWEEN two of the handler's reads.
    if (method === "GET" && hooks.beforeGet) await hooks.beforeGet({ path }, issues, tick);
    if (method !== "GET" && hooks.beforeWrite) {
      const forced = await hooks.beforeWrite({ method, path, body }, issues, tick);
      if (forced) return forced;
    }
    const labelItem = (before, after) =>
      before.join(" ") === after.join(" ") ? [] : [{ field: "labels", fromString: before.join(" "), toString: after.join(" ") }];
    const applyLabels = (issue, ops) => {
      const before = [...issue.labels];
      for (const op of ops || []) {
        if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
        if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
      }
      return labelItem(before, issue.labels);
    };

    if (path === "/rest/api/3/myself") return json({ accountId: SVC });
    if (path.startsWith("/rest/api/3/search/jql")) {
      const hits = Object.entries(issues)
        .filter(([, i]) => i.labels.includes("gate:verifying") && (i.status || "In Review") === "In Review")
        .map(([key, i]) => ({ key, fields: { summary: i.summary || "", labels: i.labels, status: { name: i.status || "In Review" } } }));
      return json({ issues: hits, isLast: true });
    }
    if (path === "/rest/api/3/issue" && method === "POST") {
      issues["TEAM-901"] = { labels: body.fields.labels, properties: {}, comments: [] };
      return json({ key: "TEAM-901", id: "901" });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/?]+)(\/[^?]*)?/.exec(path);
    if (!m) return json({});
    const issue = issues[m[1]];
    const sub = m[2] || "";
    if (!issue) return notFound();
    issue.properties ||= {};
    issue.comments ||= [];
    issue.history ||= [];
    if (sub === "/changelog") {
      if (issue.changelogFails) return json({ errorMessages: ["changelog unavailable"] }, 500);
      return json({ values: issue.history, startAt: 0, total: issue.history.length, isLast: true });
    }
    const prop = /^\/properties\/(.+)$/.exec(sub);
    if (prop) {
      if (method === "PUT") { issue.properties[prop[1]] = body; return new Response(null, { status: 204 }); }
      if (method === "DELETE") {
        if (issue.deleteFails) return json({ errorMessages: ["delete failed"] }, 500);
        delete issue.properties[prop[1]];
        return new Response(null, { status: 204 });
      }
      return prop[1] in issue.properties ? json({ key: prop[1], value: issue.properties[prop[1]] }) : notFound();
    }
    if (sub === "/comment") {
      if (method === "POST") {
        issue.comments.push({ body: body.body, accountId: SVC, created: tick() });
        return json({ id: String(issue.comments.length) }, 201);
      }
      return json({
        comments: [...issue.comments].reverse().map((c, i, all) => ({ id: c.id ?? String(all.length - i), body: c.body, created: c.created, author: { accountId: c.accountId, displayName: c.accountId } })),
      });
    }
    if (sub === "/transitions") {
      if (method === "POST") {
        const from = issue.status || "In Review";
        issue.status = STATUS_BY_TRANSITION[body.transition.id];
        const items = [{ field: "status", fromString: from, toString: issue.status }, ...applyLabels(issue, body.update?.labels)];
        issue.history.push({ created: tick(), items });
        return new Response(null, { status: 204 });
      }
      return json({ transitions: issue.transitions || [
        { id: "31", name: "Done", to: { name: "Done" } },
        { id: "21", name: "In Review", to: { name: "In Review" } },
        { id: "41", name: "Blocked", to: { name: "Blocked" } },
      ] });
    }
    if (method === "PUT") {
      const items = applyLabels(issue, body?.update?.labels);
      if (items.length) issue.history.push({ created: tick(), items });
      // TEAM-5358 B2/F3: an update_ticket description write lands on the issue.
      if (body?.fields?.description) issue.description = [adfToText(body.fields.description).replace(/\n$/, "")];
      return new Response(null, { status: 204 });
    }
    return json({
      key: m[1],
      fields: {
        summary: issue.summary || "Deploy gate",
        labels: issue.labels,
        description: issue.description ? adfDoc(issue.description) : null,
        status: { name: issue.status || "In Review" },
        parent: issue.parent ? { key: issue.parent } : null,
        issuetype: { name: "Task" },
      },
    });
  };
  try {
    return await fn({ writes, gets, issues, tick });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const boundGate = (extra = {}) => ({
  labels: ["human-review", "reviewer:alice", `wf:${DWF}`],
  description: BOUND_DESC,
  status: "In Review",
  ...extra,
});
const humanComment = (text, accountId = HUMAN) => ({ body: adfDoc(text), accountId });
// TEAM-5358 F3: a token is bound to the gate's scope + options lines; `description`
// (lines, as the issue fixture holds them) defaults to BOUND_DESC.
const tokenFor = (ticketId, option = "approve", { description = BOUND_DESC, ...extra } = {}) =>
  mintDecisionToken({ ticketId, option, channel: "hub", by: "alice@example.com", workflowId: DWF, description: [].concat(description).join("\n"), ...extra }, DKEY);
const closeGate = (h, ticket_id, extra = {}) =>
  h({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id, transition_id: "done", ...extra } });
const transitionPosts = (writes) => writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path));

test("TEAM-5322 F1: an agent-shaped done (reason DECISION: approve, plain decision) on a bound gate is refused and nothing moves", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-950": boundGate() }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-950", { reason: "DECISION: approve", decision: "approve" });
      assert.equal(res.ok, false);
      assert.equal(res.reason, "decision_required");
      assert.deepEqual(res.options, ["approve", "reject"]);
      assert.equal(res.detail, "unsigned_decision_ignored");
      assert.ok(res.error, "the refusal keeps the `error` field callers key on");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(issues["TEAM-950"].status, "In Review");

      // The options comment is written once per stall, not once per retry.
      await closeGate(mod.handler, "TEAM-950", { reason: "DECISION: approve" });
      const comments = writes.filter((w) => /\/comment$/.test(w.path));
      assert.equal(comments.length, 1, "one options comment; the reason was never persisted");
      assert.doesNotMatch(adfToText(comments[0].body.body), /^DECISION: approve$/m);
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 F1: a token for another ticket and an expired token are refused; a valid one closes with a DECISION comment", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-951": boundGate() }, async ({ writes, issues }) => {
      const other = await closeGate(mod.handler, "TEAM-951", { decision_token: tokenFor("TEAM-999") });
      assert.equal(other.detail, "decision_token_ticket_mismatch");
      const expired = await closeGate(mod.handler, "TEAM-951", {
        decision_token: tokenFor("TEAM-951", "approve", { now: Date.now() - 3600_000 }),
      });
      assert.equal(expired.detail, "decision_token_expired");
      assert.equal(transitionPosts(writes).length, 0);

      const ok = await closeGate(mod.handler, "TEAM-951", { decision_token: tokenFor("TEAM-951") });
      assert.equal(ok.status, "done");
      assert.deepEqual(ok.decision, { option: "approve", override: true, channel: "hub" });
      assert.equal(issues["TEAM-951"].status, "Done");
      const last = issues["TEAM-951"].comments.at(-1);
      assert.equal(adfToText(last.body).split("\n")[0], "DECISION: override:approve");
    });
  } finally {
    restore();
  }
});

test("TEAM-5340 F1: a decided done writes the signed gate-decision record (transition and ratify); a refused one writes none", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({
      "TEAM-951": boundGate(),
      "TEAM-961": boundGate({ status: "Done" }),
      "TEAM-962": boundGate(),
    }, async () => {
      const refused = await closeGate(mod.handler, "TEAM-962", { reason: "DECISION: approve" });
      assert.equal(refused.reason, "decision_required");
      assert.equal(s3Puts.length, 0);

      assert.equal((await closeGate(mod.handler, "TEAM-951", { decision_token: tokenFor("TEAM-951") })).status, "done");
      assert.equal((await closeGate(mod.handler, "TEAM-961", { decision_token: tokenFor("TEAM-961"), reason: "ratify: Jira UI close by abc" })).ratified, true);
      // Not Merge Approval gates: only the per-gate record, one per close.
      assert.deepEqual(s3Puts.map((p) => p.key), [gateDecisionRecordKey(DWF, "TEAM-951"), gateDecisionRecordKey(DWF, "TEAM-961")]);
      const [rec] = s3Puts.map((p) => p.body);
      assert.equal(rec.kind, "gate-decision");
      assert.equal(rec.v, 3, "TEAM-5358 F10: the canonicalJson record format");
      assert.equal(rec.ticketId, "TEAM-951");
      assert.equal(rec.workflowId, DWF);
      assert.equal(rec.status, "done");
      assert.deepEqual(rec.decision, { option: "approve", override: true, channel: "hub", by: "alice@example.com" });
      // No gate-scope line on BOUND_DESC and no status move in the changelog yet: both null, still signed.
      assert.equal(rec.scope, null);
      assert.equal(rec.cycle, null);
      assert.equal(verifyGateDecisionRecord(rec, [DKEY]), true);
      assert.equal(verifyGateDecisionRecord({ ...rec, decision: { ...rec.decision, option: "accept-as-known" } }, [DKEY]), false);
      assert.equal(s3Puts[1].body.decision.option, "approve");
    });
  } finally {
    restore();
  }
});

const SCOPE_HEAD = "19d074146120e4f72ec19b4276e25246cc043f82";
const SCOPED_DESC = [...BOUND_DESC, `gate-scope: {"round": 3, "headSha": "${SCOPE_HEAD}", "findingIds": ["TEAM-5038:5b3d5910", "TEAM-5038:29701435"]}`];

test("TEAM-5348 F1: the record signs the gate-scope line AS READ and the changelog's cycle; get_issue reports the same cycle", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    // The gate entered In Review once (cycle 1) before the decision - in the past, so a
    // token minted now is inside the cycle.
    const entered = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await withDecisionJira({
      "TEAM-963": boundGate({ description: SCOPED_DESC, history: [{ created: entered, items: [{ field: "status", fromString: "To Do", toString: "In Review" }] }] }),
    }, async () => {
      // get_issue on the human gate exposes the current cycle (one changelog read).
      const before = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: "TEAM-963" } });
      assert.equal(before.gateCycle, new Date(entered).toISOString());

      assert.equal((await closeGate(mod.handler, "TEAM-963", { decision_token: tokenFor("TEAM-963", "approve", { description: SCOPED_DESC }) })).status, "done");
      const rec = s3Puts.at(-1).body;
      assert.equal(s3Puts.at(-1).key, gateDecisionRecordKey(DWF, "TEAM-963"));
      assert.deepEqual(rec.scope, { round: 3, headSha: SCOPE_HEAD, findingIds: ["TEAM-5038:29701435", "TEAM-5038:5b3d5910"] });
      assert.equal(rec.cycle, new Date(entered).toISOString());
      assert.equal(verifyGateDecisionRecord(rec, [DKEY]), true);
      assert.equal(verifyGateDecisionRecord({ ...rec, scope: { ...rec.scope, headSha: "deadbeef".repeat(5) } }, [DKEY]), false);
      assert.equal(verifyGateDecisionRecord({ ...rec, cycle: null }, [DKEY]), false);

      // Closing (In Review -> Done) is not a reset: get_issue still reports the signed cycle.
      const after = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: "TEAM-963" } });
      assert.equal(after.gateCycle, rec.cycle);
    });
  } finally {
    restore();
  }
});

test("TEAM-5348 F1: a reopen in the Jira UI (no twin write) moves the cycle get_issue reports, so the old record no longer matches; an agent ticket has no gateCycle; an unreadable changelog omits the key", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    const entered = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await withDecisionJira({
      "TEAM-964": boundGate({ description: SCOPED_DESC, history: [{ created: entered, items: [{ field: "status", fromString: "To Do", toString: "In Review" }] }] }),
      "TEAM-965": { labels: [`wf:${DWF}`], description: ["plain agent ticket"], status: "In Progress" },
      "TEAM-966": boundGate({ changelogFails: true }),
    }, async ({ issues, tick }) => {
      assert.equal((await closeGate(mod.handler, "TEAM-964", { decision_token: tokenFor("TEAM-964", "approve", { description: SCOPED_DESC }) })).status, "done");
      const rec = s3Puts.at(-1).body;
      assert.equal(rec.cycle, new Date(entered).toISOString());
      // A human reopens it in the Jira UI: Done -> Blocked lands in the changelog only.
      issues["TEAM-964"].status = "Blocked";
      const reopenedAt = tick();
      issues["TEAM-964"].history.push({ created: reopenedAt, items: [{ field: "status", fromString: "Done", toString: "Blocked" }] });
      // ...and the sweep later skips it to Done (a skip writes no record).
      issues["TEAM-964"].status = "Done";
      const now = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: "TEAM-964" } });
      assert.equal(now.status, "done");
      assert.equal(now.gateCycle, new Date(reopenedAt).toISOString());
      assert.notEqual(now.gateCycle, rec.cycle, "workflow-output refuses on this mismatch");

      const agent = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: "TEAM-965" } });
      assert.equal("gateCycle" in agent, false);

      const unreadable = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: "TEAM-966" } });
      assert.equal(unreadable.ticketId, "TEAM-966", "get_issue itself still answers");
      assert.equal("gateCycle" in unreadable, false, "the key is omitted, so workflow-output fails closed");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322: a DECISION comment by a listed human account closes the gate (channel jira)", async () => {
  const { mod, restore } = await loadDecisionGate({ humans: `${HUMAN}, someone-else` });
  try {
    const gate = boundGate({ comments: [humanComment("DECISION: approve")] });
    await withDecisionJira({ "TEAM-952": gate }, async ({ gets, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-952");
      assert.equal(res.status, "done");
      assert.deepEqual(res.decision, { option: "approve", override: false, channel: "jira" });
      assert.ok(gets.includes("/rest/api/3/myself"), "the service account is resolved to exclude it");
      assert.match(adfToText(issues["TEAM-952"].comments.at(-1).body).trim(), /^DECISION: approve\nvia jira \(jira:human-account-1\)$/);
    });
  } finally {
    restore();
  }
});

test("TEAM-5322: a DECISION comment by the service account is never an answer, even when it is (wrongly) listed", async () => {
  // Every agent comment is posted AS the service account, so admitting it would let
  // any agent answer its own gate through Tickets___add_comment.
  const { mod, restore } = await loadDecisionGate({ humans: `${HUMAN},${SVC}` });
  try {
    const gate = boundGate({ comments: [humanComment("DECISION: approve", SVC)] });
    await withDecisionJira({ "TEAM-953": gate }, async ({ writes }) => {
      const res = await closeGate(mod.handler, "TEAM-953");
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "unsigned_decision_ignored");
      assert.equal(transitionPosts(writes).length, 0);
    });
  } finally {
    restore();
  }
});

test("TEAM-5322: with GATE_HUMAN_ACCOUNT_IDS unset the comment source is off (fail closed) and /myself is never read", async () => {
  const { mod, restore } = await loadDecisionGate({ humans: null });
  try {
    const gate = boundGate({ comments: [humanComment("DECISION: approve")] });
    await withDecisionJira({ "TEAM-954": gate }, async ({ writes, gets }) => {
      const res = await closeGate(mod.handler, "TEAM-954");
      assert.equal(res.reason, "decision_required");
      assert.equal(transitionPosts(writes).length, 0);
      assert.ok(!gets.includes("/rest/api/3/myself"));
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 FR-10: an approved close with an unmet probe holds In Review — label PUT, then the signed property PUT, no transition", async () => {
  // No PIPELINE_TOOLS_LAMBDA ⇒ the probe is indeterminate ⇒ UNMET (the opposite of
  // the probed-gate guard's admit-on-indeterminate).
  const { mod, restore } = await loadDecisionGate();
  try {
    const gate = boundGate({ properties: { "agentcore-hub-post-condition": PC } });
    await withDecisionJira({ "TEAM-955": gate }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-955", { decision_token: tokenFor("TEAM-955") });
      assert.equal(res.status, "verifying");
      assert.equal(res.requested, "done");
      assert.equal(res.postCondition.met, false);
      assert.match(res.postCondition.detail, /^indeterminate:probe_not_configured/);
      assert.equal(transitionPosts(writes).length, 0, "the status never changes, so nothing cascades");

      const labelPut = writes.findIndex((w) => w.method === "PUT" && w.path === "/rest/api/3/issue/TEAM-955");
      const propPut = writes.findIndex((w) => w.method === "PUT" && w.path.endsWith("/properties/agentcore-hub-gate-verify"));
      assert.ok(labelPut >= 0 && propPut > labelPut, `label then property, got ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`);
      assert.deepEqual(writes[labelPut].body, { update: { labels: [{ add: "gate:verifying" }] } });

      const gv = issues["TEAM-955"].properties["agentcore-hub-gate-verify"];
      assert.equal(gv.ticketId, "TEAM-955");
      assert.equal(gv.workflowId, DWF);
      assert.equal(Date.parse(gv.verifyUntil) - Date.parse(gv.requestedAt), 10 * 60 * 1000);
      assert.ok(gv.sig && gv.decision.token);
      assert.equal(issues["TEAM-955"].status, "In Review");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322: a post-condition gate decided by a Jira comment with no key available refuses decision_channel_unavailable", async () => {
  const { mod, restore } = await loadDecisionGate({ humans: HUMAN });
  // A secret id nothing can read: the literal seam is off, so loadDecisionKeys fails.
  delete process.env.GATE_DECISION_KEY;
  process.env.GATE_DECISION_SECRET_ID = "agentcore-hub-gate-decision-key-test-absent";
  process.env.AWS_REGION ||= "us-east-1";
  const originalSecretsSend = (await import("@aws-sdk/client-secrets-manager")).SecretsManagerClient.prototype.send;
  const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  SecretsManagerClient.prototype.send = async () => {
    const err = new Error("denied");
    err.name = "AccessDeniedException";
    throw err;
  };
  try {
    const gate = boundGate({ comments: [humanComment("DECISION: approve")], properties: { "agentcore-hub-post-condition": PC } });
    await withDecisionJira({ "TEAM-956": gate }, async ({ writes }) => {
      const res = await closeGate(mod.handler, "TEAM-956");
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "decision_channel_unavailable");
      assert.equal(transitionPosts(writes).length, 0);
    });
  } finally {
    SecretsManagerClient.prototype.send = originalSecretsSend;
    delete process.env.GATE_DECISION_SECRET_ID;
    restore();
  }
});

/** A held gate as the hold path leaves it: label, post-condition, signed gate-verify. */
const heldJti = (ticketId) => `held-${ticketId}-jti-0001`;
function heldGate(ticketId, { now = Date.now(), summary = "Deploy gate", tamper = false } = {}) {
  const decision = { option: "approve", override: true, channel: "hub", by: "alice@example.com", token: tokenFor(ticketId, "approve", { now, jti: heldJti(ticketId) }) };
  const gv = buildGateVerify(
    { ticketId, workflowId: DWF, decision, postCondition: PC, probe: { met: false, observed: null, detail: "unmet", probeAt: new Date(now).toISOString() }, now },
    DKEY
  );
  if (tamper) gv.verifyUntil = new Date(now + 24 * 3600_000).toISOString();
  return boundGate({
    summary,
    labels: ["human-review", "reviewer:alice", `wf:${DWF}`, "gate:verifying"],
    // TEAM-5338: the hold spent its token.
    properties: { "agentcore-hub-post-condition": PC, "agentcore-hub-gate-verify": gv, "agentcore-hub-gate-decision-jtis": { jtis: [heldJti(ticketId)] } },
  });
}

test("TEAM-5322 reprobe: a met probe closes the held gate, stamps verified, claims the hold (property left inert) and writes the merge-approval record", async () => {
  const { mod, s3Puts, ledgerPuts, seq, probeCalls, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-957": heldGate("TEAM-957", { summary: "Merge Approval: hub-x" }) }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.equal(res.ok, true);
      assert.deepEqual(res.results, [{ ticketId: "TEAM-957", outcome: "verified" }]);
      assert.equal(probeCalls[0].tool_name, "Pipeline___verify_postcondition");
      assert.deepEqual(probeCalls[0].parameters, PC);

      const posts = transitionPosts(writes);
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body, { transition: { id: "31" }, update: { labels: [{ add: "gateverify:verified" }] } });
      assert.equal(issues["TEAM-957"].status, "Done");
      // TEAM-5347 F3: the reprobe never deletes the property (no CAS to do it safely);
      // the acted claim in the ledger is what makes it inert.
      assert.ok("agentcore-hub-gate-verify" in issues["TEAM-957"].properties);
      assert.ok(!writes.some((w) => w.method === "DELETE"));
      assert.deepEqual(ledgerPuts.map((p) => p.key), [gateHoldActedKey(DWF, "TEAM-957", issues["TEAM-957"].properties[GV].sig)]);
      assert.equal(ledgerPuts[0].body.outcome, "verified");

      // TEAM-5372: the per-gate record (TEAM-5340 F1) lands before the hold claim and
      // the Done; the merge-approval record follows the Done, as before.
      assert.deepEqual(s3Puts.map((p) => p.key), [
        gateDecisionRecordKey(DWF, "TEAM-957"),
        `pipeline-artifacts/gate-decisions/${DWF}/merge-approval.json`,
      ]);
      assert.deepEqual(seq.map((e) => e.replace(/^(put|delete):.*\/(gates|jti|holds)\/.*$/, "$1:$2")).filter((e) => !/merge-approval/.test(e)), ["put:gates", "put:holds", "post:transitions"]);
      assert.equal(s3Puts[1].body.decision.option, "approve");
      assert.ok(s3Puts[1].body.sig);
      assert.equal(verifyGateDecisionRecord(s3Puts[0].body, [DKEY]), true);
    }, {
      beforeWrite: (w) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path)) seq.push("post:transitions");
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 reprobe: unmet inside the window writes nothing; unmet past it swaps to approved-unverified and re-pages, status unchanged", async () => {
  const { mod, restore } = await loadDecisionGate({ probe: { ok: true, met: false, error: "execution InProgress", observed: { status: "InProgress" } } });
  try {
    await withDecisionJira({
      "TEAM-958": heldGate("TEAM-958"),
      "TEAM-959": heldGate("TEAM-959", { now: Date.now() - 11 * 60 * 1000 }),
    }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      const byId = Object.fromEntries(res.results.map((r) => [r.ticketId, r.outcome]));
      assert.deepEqual(byId, { "TEAM-958": "pending", "TEAM-959": "unverified" });
      assert.ok(!writes.some((w) => w.path.includes("TEAM-958")), "an open window is never touched");

      const gate = issues["TEAM-959"];
      assert.equal(gate.status, "In Review", "the cascade never fires on an unverified gate");
      assert.ok(!gate.labels.includes("gate:verifying"));
      for (const l of ["gate:approved-unverified", "gateverify:unverified", "gate:awaiting-console"]) {
        assert.ok(gate.labels.includes(l), `missing ${l}: ${gate.labels}`);
      }
      assert.ok("agentcore-hub-gate-verify" in gate.properties, "TEAM-5347 F3: left inert behind its acted claim, never deleted");
      const texts = gate.comments.map((c) => adfToText(c.body));
      assert.ok(texts.some((t) => /^Post-condition still unmet after the 10-minute verification window \(pipeline_execution hub-x-deploy#/.test(t)));
      assert.ok(texts.some((t) => /was approved but its post-condition was never observed/.test(t)));
      assert.equal(transitionPosts(writes).length, 0);
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 reprobe: a gate-verify property whose sig does not verify is ignored, and nothing is written", async () => {
  const { mod, probeCalls, restore } = await loadDecisionGate({ probe: { ok: true, met: true } });
  try {
    await withDecisionJira({ "TEAM-960": heldGate("TEAM-960", { tamper: true }) }, async ({ writes }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-960", outcome: "ignored_unsigned" }]);
      assert.equal(writes.length, 0);
      assert.equal(probeCalls.length, 0, "a forged record never even reaches the probe");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 F7: done on an already-Done bound gate ratifies with no transition; without a decision it refuses", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({
      "TEAM-961": boundGate({ status: "Done" }),
      "TEAM-962": boundGate({ status: "Done" }),
    }, async ({ writes, issues }) => {
      const ok = await closeGate(mod.handler, "TEAM-961", { decision_token: tokenFor("TEAM-961"), reason: "ratify: Jira UI close by abc" });
      assert.equal(ok.status, "done");
      assert.equal(ok.ratified, true);
      assert.deepEqual(ok.decision, { option: "approve", override: true, channel: "hub" });
      assert.equal(transitionPosts(writes).length, 0, "already Done: nothing to transition");
      assert.equal(adfToText(issues["TEAM-961"].comments.at(-1).body).split("\n")[0], "DECISION: override:approve");

      const refused = await closeGate(mod.handler, "TEAM-962", { reason: "ratify: Jira UI close by abc" });
      assert.equal(refused.reason, "decision_required");
      assert.equal(refused.ratified, undefined);
      assert.equal(transitionPosts(writes).length, 0, "the webhook route, not the twin, reopens a refused ratify");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 F4: labels_add refuses the twin-owned state labels with label_reserved and writes nothing", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-963": boundGate() }, async ({ writes }) => {
      for (const label of ["gate:verifying", "gate-approved-unverified", "gateverify:verified"]) {
        const res = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-963", labels: ["ok-label", label] } });
        assert.equal(res.ok, false);
        assert.equal(res.reason, "label_reserved");
        assert.deepEqual(res.labels, [label]);
      }
      assert.equal(writes.length, 0);
      const fine = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-963", labels: ["gate:awaiting-console"] } });
      assert.equal(fine.status, "labels_added", "an ordinary gate label is still the caller's to add");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322 FR-11: labels_add refuses a second, different head: label with head_label_conflict; the same head is idempotent", async () => {
  const { mod, restore } = await loadDecisionGate();
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  try {
    const labelled = boundGate();
    labelled.labels = [...labelled.labels, `head:${A}`];
    await withDecisionJira({ "TEAM-963": labelled }, async ({ writes }) => {
      const res = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-963", labels: [`head:${B}`] } });
      assert.equal(res.ok, false);
      assert.equal(res.reason, "head_label_conflict");
      assert.deepEqual(res.existing, [A]);
      assert.deepEqual(res.requested, [B]);
      assert.equal(writes.length, 0);
      const same = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-963", labels: [`head:${A}`] } });
      assert.equal(same.status, "labels_added");
    });
  } finally {
    restore();
  }
});

test("TEAM-5322: update_ticket refuses post_condition_immutable and gate_frozen (decision-options); create validates post_condition first", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-964": boundGate() }, async ({ writes, issues }) => {
      const pc = await mod.handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-964", post_condition: PC } });
      assert.equal(pc.reason, "post_condition_immutable");
      const rewrite = await mod.handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-964", description: "DECISION OPTIONS: approve | approve-anyway" } });
      assert.equal(rewrite.reason, "gate_frozen");
      assert.equal(rewrite.field, "decision-options");
      assert.deepEqual(rewrite.options, ["approve", "reject"]);
      assert.equal(writes.length, 0);

      const unbound = await mod.handler({ tool_name: "Tickets___create_ticket", parameters: { summary: "Deploy gate", assignee: "human:alice", description: "no options here", post_condition: PC } });
      assert.equal(unbound.reason, "post_condition_invalid");
      const badKind = await mod.handler({ tool_name: "Tickets___create_ticket", parameters: { summary: "Deploy gate", assignee: "human:alice", description: BOUND_DESC.join("\n"), post_condition: { kind: "shell", target: "x" } } });
      assert.equal(badKind.reason, "post_condition_invalid");
      assert.ok(!writes.some((w) => w.path === "/rest/api/3/issue"), "nothing was created");

      // The execution probed must be the one the gate's exec:/pipeline: labels name.
      const EXEC_LABELS = ["pipeline:hub-x-deploy", "exec:0f8fad5b-d9cb-469f-a165-70867728950e"];
      for (const labels of [undefined, ["pipeline:hub-x-deploy", "exec:11111111-2222-4333-8444-555555555555"], ["pipeline:hub-y-deploy", EXEC_LABELS[1]]]) {
        const unbound = await mod.handler({ tool_name: "Tickets___create_ticket", parameters: { summary: "Deploy gate", assignee: "human:alice", description: BOUND_DESC.join("\n"), post_condition: PC, labels } });
        assert.equal(unbound.reason, "post_condition_invalid", `labels ${JSON.stringify(labels)}`);
      }
      assert.ok(!writes.some((w) => w.path === "/rest/api/3/issue"), "nothing was created");

      const created = await mod.handler({ tool_name: "Tickets___create_ticket", parameters: { summary: "Deploy gate", assignee: "human:alice", description: BOUND_DESC.join("\n"), post_condition: PC, labels: EXEC_LABELS } });
      assert.equal(created.ticketId, "TEAM-901");
      assert.deepEqual(created.postCondition, PC);
      assert.deepEqual(issues["TEAM-901"].properties["agentcore-hub-post-condition"], PC);
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5338: cycle-scoped, single-use decisions and a re-checking reprobe ────
//
// Jira has no conditional write, so the twin re-reads before it acts (F5), binds a
// decision to the cycle the changelog says is current (F4) and spends each token
// id in an issue property (F3). The probe is where a concurrent human lands in
// these tests: `duringProbe` runs inside the stubbed Pipeline___ call.

const JTIS = "agentcore-hub-gate-decision-jtis";
const GV = "agentcore-hub-gate-verify";

function duringProbe(fn) {
  const send = LambdaClient.prototype.send;
  LambdaClient.prototype.send = async function (cmd) {
    await fn();
    return send.call(this, cmd);
  };
}

/** A second, newer hold for the same gate: a human re-closed while the reprobe ran. */
function newerHold(ticketId) {
  const now = Date.now() + 5000;
  const decision = { option: "approve", override: true, channel: "hub", by: "bob@example.com", token: tokenFor(ticketId, "approve", { now }) };
  return buildGateVerify(
    { ticketId, workflowId: DWF, decision, postCondition: PC, probe: { met: false, observed: null, detail: "unmet", probeAt: new Date(now).toISOString() }, now },
    DKEY
  );
}

test("TEAM-5338 F5: a human reopens the gate while the reprobe probes - no Done, the hold is kept", async () => {
  const { mod, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-970": heldGate("TEAM-970") }, async ({ writes, issues }) => {
      duringProbe(() => { issues["TEAM-970"].status = "Blocked"; });
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-970", outcome: "superseded" }]);
      assert.equal(issues["TEAM-970"].status, "Blocked");
      assert.equal(transitionPosts(writes).length, 0);
      assert.ok(GV in issues["TEAM-970"].properties, "nothing was acted on, so nothing is deleted");
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F5: a human re-closes while the reprobe runs - the newer hold is never deleted", async () => {
  const { mod, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    // (a) the newer hold lands before the reprobe writes: it does not act at all.
    await withDecisionJira({ "TEAM-971": heldGate("TEAM-971") }, async ({ writes, issues }) => {
      const newer = newerHold("TEAM-971");
      duringProbe(() => { issues["TEAM-971"].properties[GV] = newer; });
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-971", outcome: "superseded" }]);
      assert.equal(transitionPosts(writes).length, 0);
      assert.deepEqual(issues["TEAM-971"].properties[GV], newer);
    });
    // (b) it lands during the act (TEAM-5347 F3: there is no delete any more, so a
    // newer hold can never be destroyed by the reprobe).
    let newer;
    await withDecisionJira({ "TEAM-972": heldGate("TEAM-972") }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-972", outcome: "verified" }]);
      assert.equal(transitionPosts(writes).length, 1);
      assert.deepEqual(issues["TEAM-972"].properties[GV], newer, "the newer hold survives the act untouched");
      assert.ok(!writes.some((w) => w.method === "DELETE"));
    }, {
      beforeWrite: (w, issues) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path)) issues["TEAM-972"].properties[GV] = newer = newerHold("TEAM-972");
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: a hold already claimed is already_acted (a lingering property or re-added label never re-acts); a claim older than 5 min hands the gate back", async () => {
  const { mod, objects, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    const fresh = heldGate("TEAM-973");
    const stale = heldGate("TEAM-983");
    const claim = (ticketId, gate, at) => objects.set(
      gateHoldActedKey(DWF, ticketId, gate.properties[GV].sig),
      JSON.stringify({ v: 1, kind: "hold-acted", ticketId, workflowId: DWF, sig: gate.properties[GV].sig, outcome: "verified", at })
    );
    claim("TEAM-973", fresh, new Date(Date.now() - 60_000).toISOString());
    claim("TEAM-983", stale, new Date(Date.now() - 6 * 60_000).toISOString());
    await withDecisionJira({ "TEAM-973": fresh, "TEAM-983": stale }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [
        { ticketId: "TEAM-973", outcome: "already_acted" },
        { ticketId: "TEAM-983", outcome: "already_acted", stale: true },
      ]);
      assert.equal(transitionPosts(writes).length, 0, "never re-acted");
      assert.equal(issues["TEAM-973"].status, "In Review");
      assert.ok(issues["TEAM-973"].labels.includes("gate:verifying"), "a fresh claim is another invocation's: left alone");
      // The stale one: the Lambda died mid-act. The mark comes off and the human is paged.
      assert.ok(!issues["TEAM-983"].labels.includes("gate:verifying"));
      assert.ok(issues["TEAM-983"].labels.includes("gate:awaiting-console"));
      assert.ok(issues["TEAM-983"].comments.some((c) => /claimed for verification but never finished/.test(adfToText(c.body))));
      assert.equal(issues["TEAM-983"].status, "In Review");
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F6: the reprobe ignores a hold whose stored post-condition is not the signed one, and a hold whose token was never spent", async () => {
  const { mod, probeCalls, restore } = await loadDecisionGate({ probe: { ok: true, met: true } });
  try {
    const swapped = heldGate("TEAM-974");
    swapped.properties["agentcore-hub-post-condition"] = { ...PC, target: "hub-y-deploy#0f8fad5b-d9cb-469f-a165-70867728950e" };
    const unspent = heldGate("TEAM-975");
    unspent.properties[JTIS] = { jtis: [] };
    await withDecisionJira({ "TEAM-974": swapped, "TEAM-975": unspent }, async ({ writes }) => {
      const res = await mod.handler({ mode: "reprobe" });
      const byId = Object.fromEntries(res.results.map((r) => [r.ticketId, r.outcome]));
      assert.deepEqual(byId, { "TEAM-974": "ignored_tampered", "TEAM-975": "ignored_unbound" });
      assert.equal(probeCalls.length, 0);
      assert.equal(writes.length, 0);
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F5: a non-Done move of a held gate clears gate:verifying / approved-unverified and its gateVerify", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    const gate = heldGate("TEAM-976");
    gate.labels.push("gate:approved-unverified");
    await withDecisionJira({ "TEAM-976": gate }, async ({ writes, issues }) => {
      const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-976", transition_id: "blocked" } });
      assert.equal(res.status, "blocked");
      assert.equal(res.gateVerifyDeleteFailed, undefined);
      const posts = transitionPosts(writes);
      assert.deepEqual(posts[0].body.update.labels, [{ remove: "gate:verifying" }, { remove: "gate:approved-unverified" }]);
      assert.ok(!(GV in issues["TEAM-976"].properties));
      assert.ok(!issues["TEAM-976"].labels.some((l) => /^gate:(verifying|approved-unverified)$/.test(l)));
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F4: an approval made before a reopen does not authorize the next close; a new one does", async () => {
  const { mod, restore } = await loadDecisionGate({ humans: HUMAN });
  try {
    await withDecisionJira({ "TEAM-977": boundGate() }, async ({ issues, tick }) => {
      const gate = issues["TEAM-977"];
      gate.comments = [{ ...humanComment("DECISION: approve"), created: tick() }];
      assert.equal((await closeGate(mod.handler, "TEAM-977")).status, "done");

      // The human withdraws the approval: back to In Review starts a new cycle.
      const back = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-977", transition_id: "in_review", reason: "approval withdrawn" } });
      assert.equal(back.status, "in_review");
      const stale = await closeGate(mod.handler, "TEAM-977");
      assert.equal(stale.reason, "decision_required");
      assert.equal(gate.status, "In Review", "the pre-reopen DECISION comment no longer answers");

      gate.comments.push({ ...humanComment("DECISION: approve"), created: tick() });
      const fresh = await closeGate(mod.handler, "TEAM-977");
      assert.equal(fresh.status, "done");
      assert.equal(fresh.decision.option, "approve");
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F3: a decision token is spent on use - a replay after a reopen is refused", async () => {
  const { mod, ledgerPuts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-978": boundGate() }, async ({ issues }) => {
      const token = tokenFor("TEAM-978");
      assert.equal((await closeGate(mod.handler, "TEAM-978", { decision_token: token })).status, "done");
      assert.equal(issues["TEAM-978"].properties[JTIS].jtis.length, 1, "the property stays as a one-release mirror");
      assert.equal(ledgerPuts.length, 1, "the ledger is the spend (TEAM-5347 F1)");
      assert.equal(ledgerPuts[0].body.jti, issues["TEAM-978"].properties[JTIS].jtis[0]);
      assert.ok(!JSON.stringify(ledgerPuts[0].body).includes(token), "the ledger never carries the token");
      await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-978", transition_id: "in_review" } });
      const replay = await closeGate(mod.handler, "TEAM-978", { decision_token: token });
      assert.equal(replay.detail, "decision_token_consumed");
      assert.equal(issues["TEAM-978"].status, "In Review");
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F3/F4: a token for another run, or an unreadable changelog, is refused", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-979": boundGate(), "TEAM-980": boundGate({ changelogFails: true }) }, async ({ writes }) => {
      const other = await closeGate(mod.handler, "TEAM-979", { decision_token: tokenFor("TEAM-979", "approve", { workflowId: "wf_other" }) });
      assert.equal(other.detail, "decision_token_workflow_mismatch");
      const blind = await closeGate(mod.handler, "TEAM-980", { decision_token: tokenFor("TEAM-980") });
      assert.equal(blind.detail, "decision_channel_unavailable");
      assert.equal(transitionPosts(writes).length, 0);
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F4: an approved-unverified label from an earlier cycle is stale - the close probes and holds instead of admitting", async () => {
  const { mod, restore } = await loadDecisionGate({ probe: { ok: true, met: false, error: "InProgress", observed: { status: "InProgress" } } });
  try {
    const gate = boundGate({
      labels: ["human-review", "reviewer:alice", `wf:${DWF}`, "gate:approved-unverified"],
      properties: { "agentcore-hub-post-condition": PC },
    });
    await withDecisionJira({ "TEAM-981": gate }, async ({ issues, tick }) => {
      // The label was gained, then the gate re-entered In Review.
      gate.history = [
        { created: tick(), items: [{ field: "labels", fromString: "", toString: "gate:approved-unverified" }] },
        { created: tick(), items: [{ field: "status", fromString: "Blocked", toString: "In Review" }] },
      ];
      const res = await closeGate(mod.handler, "TEAM-981", { decision_token: tokenFor("TEAM-981") });
      assert.equal(res.status, "verifying", "a fresh cycle is not the human's second word");
      assert.equal(issues["TEAM-981"].status, "In Review");
    });
  } finally {
    restore();
  }
});

test("TEAM-5338 F10: the handler log line never carries a decision token", async () => {
  const { mod, restore } = await loadDecisionGate();
  const lines = [];
  const originalLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await withDecisionJira({ "TEAM-982": boundGate() }, async () => {
      const token = tokenFor("TEAM-982");
      await closeGate(mod.handler, "TEAM-982", { decision_token: token, nested: { authorization: "Bearer x" } });
      assert.ok(lines.length > 0);
      assert.ok(!lines.some((l) => l.includes(token) || l.includes("Bearer x")));
    });
  } finally {
    console.log = originalLog;
    restore();
  }
});

// ─── TEAM-5347 F1: the jti spend is one create-once write in S3 ─────────────────
//
// Jira properties have no CAS; the ledger does (PutObject If-None-Match). Two closes
// presenting one token race on ONE key, so exactly one admits. The fake S3 in
// loadDecisionGate is the arbiter: 412 to the second writer, 403 on a missing key.

const ledgerKeys = (ledgerPuts) => ledgerPuts.map((p) => p.key);

test("TEAM-5347 F1: two parallel closes with one token - exactly one admits, the other is consumed, one transition", async () => {
  const { mod, ledgerPuts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-990": boundGate() }, async ({ writes, issues }) => {
      const token = tokenFor("TEAM-990");
      const [a, b] = await Promise.all([
        closeGate(mod.handler, "TEAM-990", { decision_token: token }),
        closeGate(mod.handler, "TEAM-990", { decision_token: token }),
      ]);
      const admitted = [a, b].filter((r) => r.status === "done");
      const refused = [a, b].filter((r) => r.detail === "decision_token_consumed");
      assert.equal(admitted.length, 1, `exactly one admit: ${JSON.stringify([a, b])}`);
      assert.equal(refused.length, 1, "the other is refused as consumed");
      assert.equal(transitionPosts(writes).length, 1, "one Done transition");
      assert.equal(issues["TEAM-990"].status, "Done");
      assert.equal(ledgerPuts.length, 1, "one ledger row: the loser's 412 wrote nothing");
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F1: two parallel closes on one human DECISION comment - the derived jti collides, one wins", async () => {
  const { mod, ledgerPuts, restore } = await loadDecisionGate({ humans: HUMAN });
  try {
    const gate = boundGate({ comments: [humanComment("DECISION: approve")] });
    await withDecisionJira({ "TEAM-991": gate }, async ({ writes, issues }) => {
      const [a, b] = await Promise.all([closeGate(mod.handler, "TEAM-991"), closeGate(mod.handler, "TEAM-991")]);
      assert.equal([a, b].filter((r) => r.status === "done").length, 1, JSON.stringify([a, b]));
      assert.equal([a, b].filter((r) => r.detail === "decision_token_consumed").length, 1);
      assert.equal(transitionPosts(writes).length, 1);
      assert.equal(ledgerPuts.length, 1, "both closes derived the SAME id from the comment");
      assert.equal(issues["TEAM-991"].status, "Done");
      // The id is a function of (ticket, comment id, author), not of the clock.
      const { commentDecisionJti } = await import("./gate-contract.mjs");
      assert.equal(ledgerPuts[0].body.jti, commentDecisionJti("TEAM-991", "1", `jira:${HUMAN}`));
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F1: two closes with two different tokens - both ledger keys exist, neither jti is lost", async () => {
  const { mod, ledgerPuts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-992": boundGate() }, async ({ issues }) => {
      const first = tokenFor("TEAM-992", "approve", { jti: "first-jti-0000000000000001" });
      const second = tokenFor("TEAM-992", "approve", { jti: "second-jti-000000000000001" });
      assert.equal((await closeGate(mod.handler, "TEAM-992", { decision_token: first })).status, "done");
      // Already Done: the second word is ratified, and spends ITS OWN key.
      const again = await closeGate(mod.handler, "TEAM-992", { decision_token: second });
      assert.equal(again.status, "done");
      assert.deepEqual(ledgerKeys(ledgerPuts).sort(), [
        `pipeline-artifacts/gate-decisions/${DWF}/jti/TEAM-992/first-jti-0000000000000001.json`,
        `pipeline-artifacts/gate-decisions/${DWF}/jti/TEAM-992/second-jti-000000000000001.json`,
      ].sort(), "one object per jti - no list to overwrite");
      // And the mirror property kept both (it is a list now, not a race).
      assert.deepEqual([...issues["TEAM-992"].properties[JTIS].jtis].sort(), ["first-jti-0000000000000001", "second-jti-000000000000001"]);
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F1: a 409 on the ledger put is retried; three 409s refuse; a 5xx refuses; nothing moves on a refusal", async () => {
  const { mod, s3Fail, objects, restore } = await loadDecisionGate();
  const prevWait = process.env.CLAIM_RETRY_WAIT_MS;
  process.env.CLAIM_RETRY_WAIT_MS = "0";
  const conflict = () => Object.assign(new Error("conflict"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } });
  try {
    await withDecisionJira({ "TEAM-993": boundGate(), "TEAM-994": boundGate(), "TEAM-995": boundGate() }, async ({ writes, issues }) => {
      let conflicts = 2;
      // TEAM-5372: the gate-decision record is claimed first; these faults are the ledger's.
      const ledger = (cmd) => cmd.constructor.name === "PutObjectCommand" && cmd.input.IfNoneMatch && /\/jti\//.test(cmd.input.Key);
      s3Fail.fn = (cmd) => (ledger(cmd) && conflicts-- > 0 ? conflict() : null);
      assert.equal((await closeGate(mod.handler, "TEAM-993", { decision_token: tokenFor("TEAM-993") })).status, "done", "409, 409, then the put wins");

      conflicts = 3;
      const tooMany = await closeGate(mod.handler, "TEAM-994", { decision_token: tokenFor("TEAM-994") });
      assert.equal(tooMany.detail, "decision_channel_unavailable", "three 409s: the spend is unproven");
      assert.equal(issues["TEAM-994"].status, "In Review");

      s3Fail.fn = (cmd) => (ledger(cmd)
        ? Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } })
        : null);
      const broken = await closeGate(mod.handler, "TEAM-995", { decision_token: tokenFor("TEAM-995") });
      assert.equal(broken.detail, "decision_channel_unavailable");
      assert.equal(issues["TEAM-995"].status, "In Review");
      assert.equal(transitionPosts(writes).length, 1, "only TEAM-993 moved");
      // TEAM-5387: a refused spend KEEPS the record its close had claimed (never
      // deleted); the same decision retried reuses it, a different one is refused.
      assert.deepEqual([...objects.keys()].filter((k) => /\/gates\//.test(k)), ["TEAM-993", "TEAM-994", "TEAM-995"].map((t) => gateDecisionRecordKey(DWF, t)));
    });
  } finally {
    if (prevWait === undefined) delete process.env.CLAIM_RETRY_WAIT_MS;
    else process.env.CLAIM_RETRY_WAIT_MS = prevWait;
    restore();
  }
});

test("TEAM-5347 F1: ARTIFACT_BUCKET unset - a decision-bound close is refused, a plain ticket still moves", async () => {
  const { mod, restore } = await loadDecisionGate({ bucket: "" });
  try {
    const plain = { labels: ["agent:agentcore_hub_backend_dev", `wf:${DWF}`], status: "In Progress" };
    await withDecisionJira({ "TEAM-996": boundGate(), "TEAM-997": plain }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-996", { decision_token: tokenFor("TEAM-996") });
      assert.equal(res.detail, "decision_channel_unavailable", "no ledger ⇒ no proof the token is unspent");
      assert.equal(issues["TEAM-996"].status, "In Review");
      assert.equal((await closeGate(mod.handler, "TEAM-997")).status, "done");
      assert.equal(transitionPosts(writes).length, 1);
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F1: the SDK probe says If-None-Match is dropped - every decision-bound close is refused", async () => {
  const { mod, ledgerPuts, s3Puts, restore } = await loadDecisionGate();
  const errors = [];
  const originalError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    mod.s3Probe.run = async () => ({ verdict: "missing", missing: ["PutObject If-None-Match"], seen: [], sdkVersion: "3.600.0" });
    await withDecisionJira({ "TEAM-998": boundGate() }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-998", { decision_token: tokenFor("TEAM-998") });
      // TEAM-5372: the gate-decision record is the first create-once write, so it is
      // the claim that refuses.
      assert.equal(res.detail, "gate_decision_unrecorded");
      assert.equal(issues["TEAM-998"].status, "In Review");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(ledgerPuts.length, 0, "no put is attempted on an SDK that would let every spend win");
      assert.equal(s3Puts.length, 0, "nor a record");
      assert.ok(errors.some((l) => /3\.600\.0/.test(l) && /If-None-Match/.test(l)), "the SDK version is logged");
    });
    // `inconclusive` (a stubbed client, as in every other test here) changes nothing.
    mod.s3Probe.run = async () => ({ verdict: "inconclusive", reason: "stub", missing: [], seen: [], sdkVersion: null });
    await withDecisionJira({ "TEAM-999": boundGate() }, async () => {
      assert.equal((await closeGate(mod.handler, "TEAM-999", { decision_token: tokenFor("TEAM-999") })).status, "done");
    });
  } finally {
    console.error = originalError;
    restore();
  }
});

test("TEAM-5347 F1 reprobe: a jti proven by the ledger proceeds; one proven only by the mirror property proceeds (one release); one proven by neither is ignored", async () => {
  const { mod, objects, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    const { gateJtiLedgerKey } = await import("./gate-contract.mjs");
    const ledgerOnly = heldGate("TEAM-1001");
    delete ledgerOnly.properties[JTIS];
    objects.set(gateJtiLedgerKey(DWF, "TEAM-1001", heldJti("TEAM-1001")), JSON.stringify({ v: 1, kind: "jti-spent", jti: heldJti("TEAM-1001") }));
    const propertyOnly = heldGate("TEAM-1002");
    const neither = heldGate("TEAM-1003");
    delete neither.properties[JTIS];
    await withDecisionJira({ "TEAM-1001": ledgerOnly, "TEAM-1002": propertyOnly, "TEAM-1003": neither }, async ({ issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      const byTicket = Object.fromEntries(res.results.map((r) => [r.ticketId, r.outcome]));
      assert.deepEqual(byTicket, { "TEAM-1001": "verified", "TEAM-1002": "verified", "TEAM-1003": "ignored_unbound" });
      assert.equal(issues["TEAM-1003"].status, "In Review", "a GET 403 on the ledger is not a proof of spending");
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5347 F2: a reopen that never re-enters In Review still ends the cycle ──

test("TEAM-5347 F2: In Review -> Done -> Blocked (no re-entry) stales the earlier token and the earlier DECISION comment", async () => {
  const { mod, restore } = await loadDecisionGate({ humans: HUMAN });
  try {
    await withDecisionJira({ "TEAM-1010": boundGate(), "TEAM-1011": boundGate() }, async ({ issues, tick }) => {
      // Token path. `early` is minted 10 minutes ago: before the fake Jira's clock (which
      // starts 5 minutes ago), so the reopen below lands AFTER it.
      const early = tokenFor("TEAM-1010", "approve", { now: Date.now() - 600_000 });
      assert.equal((await closeGate(mod.handler, "TEAM-1010", { decision_token: tokenFor("TEAM-1010") })).status, "done");
      const back = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1010", transition_id: "blocked", reason: "reopened for rework" } });
      assert.equal(back.status, "blocked");
      assert.equal(issues["TEAM-1010"].status, "Blocked");
      const stale = await closeGate(mod.handler, "TEAM-1010", { decision_token: early });
      assert.equal(stale.reason, "decision_required");
      assert.equal(stale.detail, "decision_token_stale", "Done -> Blocked started a new cycle without any entry into In Review");
      assert.equal(issues["TEAM-1010"].status, "Blocked");
      // A token minted after the reopen is the human's new word.
      assert.equal((await closeGate(mod.handler, "TEAM-1010", { decision_token: tokenFor("TEAM-1010") })).status, "done");

      // Comment path: the approval predates Done -> Blocked, so it no longer answers.
      const gate = issues["TEAM-1011"];
      gate.comments = [{ ...humanComment("DECISION: approve"), created: tick() }];
      assert.equal((await closeGate(mod.handler, "TEAM-1011")).status, "done");
      await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1011", transition_id: "blocked" } });
      const unanswered = await closeGate(mod.handler, "TEAM-1011");
      assert.equal(unanswered.reason, "decision_required");
      assert.equal(gate.status, "Blocked");
      gate.comments.push({ ...humanComment("DECISION: approve"), created: tick() });
      const fresh = await closeGate(mod.handler, "TEAM-1011");
      assert.equal(fresh.status, "done");
      assert.equal(fresh.decision.option, "approve");
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5347 F3: the hold's end of life is claim-first and verified after the write ─

/** A reopen the human makes in Jira, as the changelog would record it (on the fake's clock, so it orders before the write it precedes). */
const reopenInJira = (issue, from, to, tick) => {
  issue.status = to;
  issue.history.push({ created: tick(), items: [{ field: "status", fromString: from, toString: to }] });
};
const recordPuts = (s3Puts) => s3Puts.map((p) => p.key);
/** The signed records S3 holds. TEAM-5387: a refused or compensated close leaves its record (never deleted). */
const storedRecords = (objects) => [...objects.keys()].filter((k) => /\/gates\/|merge-approval\.json$/.test(k));

test("TEAM-5347 F3: a reopen lands between liveHold and the Done POST - the Done is compensated back, no signed record is written", async () => {
  const { mod, s3Puts, ledgerPuts, s3Deletes, objects, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-1020": heldGate("TEAM-1020", { summary: "Merge Approval: hub-x" }) }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-1020", outcome: "superseded_compensated", reason: "status_moved" }]);
      assert.equal(res.compensated, 1);
      const gate = issues["TEAM-1020"];
      assert.equal(gate.status, "Blocked", "the human's reopen stands");
      // TEAM-5372: the gate-decision record was claimed before the Done. TEAM-5387: it
      // STAYS when the Done is compensated - bound to the cycle that was judged, it is
      // stale for every reader - and no merge-approval record is written at all.
      assert.deepEqual(recordPuts(s3Puts), [gateDecisionRecordKey(DWF, "TEAM-1020")]);
      assert.deepEqual(s3Deletes, [], "never deleted");
      assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, "TEAM-1020")], "the gate-decision record stays; no merge-approval record for a Done that did not stand");
      assert.equal(ledgerPuts.length, 1, "the hold was claimed (and stays claimed: it is never re-acted)");
      assert.ok(!gate.labels.includes("gateverify:verified"), "the stamp came off with the compensation");
      assert.ok(gate.labels.includes("gate:awaiting-console"), "re-paged");
      assert.ok(gate.comments.some((c) => /Superseded: this gate moved \(status_moved\)/.test(adfToText(c.body))));
      // Two POSTs: the Done, then the compensating move back.
      const posts = transitionPosts(writes);
      assert.equal(posts.length, 2);
      assert.equal(posts[1].body.transition.id, "41");
      assert.ok(GV in gate.properties, "never deleted");
    }, {
      beforeWrite: (w, issues, tick) => {
        // The human reopens AFTER liveHold re-read In Review and BEFORE the Done POST lands.
        if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues["TEAM-1020"].status !== "Blocked") {
          reopenInJira(issues["TEAM-1020"], "In Review", "Blocked", tick);
        }
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: Blocked -> In Review inside the window moves the cycle - the Done is compensated even though it left In Review", async () => {
  const { mod, objects, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-1021": heldGate("TEAM-1021") }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-1021", outcome: "superseded_compensated", reason: "cycle_moved" }]);
      assert.equal(issues["TEAM-1021"].status, "In Review", "back where the human left it");
      // TEAM-5387: the record stays (it names the old cycle, so no reader counts it).
      assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, "TEAM-1021")]);
      assert.equal(transitionPosts(writes).length, 2);
    }, {
      beforeWrite: (w, issues, tick) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues["TEAM-1021"].history.length === 0) {
          reopenInJira(issues["TEAM-1021"], "In Review", "Blocked", tick);
          reopenInJira(issues["TEAM-1021"], "Blocked", "In Review", tick);
        }
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: two reprobes race on one hold - the claim admits exactly one act, one Done POST", async () => {
  const { mod, ledgerPuts, s3Puts, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-1022": heldGate("TEAM-1022") }, async ({ writes, issues }) => {
      const [a, b] = await Promise.all([mod.handler({ mode: "reprobe" }), mod.handler({ mode: "reprobe" })]);
      const outcomes = [a.results[0].outcome, b.results[0].outcome].sort();
      assert.equal(outcomes.filter((o) => o === "verified").length, 1, JSON.stringify(outcomes));
      assert.ok(["already_acted", "superseded"].includes(outcomes.find((o) => o !== "verified")), JSON.stringify(outcomes));
      assert.equal(transitionPosts(writes).length, 1, "one Done");
      assert.equal(ledgerPuts.length, 1, "one claim won; the loser's 412 wrote nothing");
      assert.equal(recordPuts(s3Puts).length, 1, "one gate-decision record");
      assert.equal(issues["TEAM-1022"].status, "Done");
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: a hold install whose gate moved after the property PUT undoes itself and refuses gate_moved", async () => {
  const { mod, ledgerPuts, restore } = await loadDecisionGate({ probe: { ok: true, met: false, error: "InProgress", observed: { status: "InProgress" } } });
  try {
    const gate = boundGate({ properties: { "agentcore-hub-post-condition": PC } });
    await withDecisionJira({ "TEAM-1023": gate }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-1023", { decision_token: tokenFor("TEAM-1023") });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "gate_moved");
      assert.equal(issues["TEAM-1023"].status, "Blocked", "the human's reopen stands");
      assert.ok(!(GV in issues["TEAM-1023"].properties), "our hold was removed");
      assert.ok(!issues["TEAM-1023"].labels.includes("gate:verifying"), "our mark was removed");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(ledgerPuts.length, 1, "the token was spent (fail closed): the human decides again with a fresh one");
      assert.ok(!issues["TEAM-1023"].comments.some((c) => /^DECISION:/m.test(adfToText(c.body))), "no decision comment for a hold that did not stand");
    }, {
      beforeWrite: (w, issues, tick) => {
        if (w.method === "PUT" && w.path.endsWith(`/properties/${GV}`)) reopenInJira(issues["TEAM-1023"], "In Review", "Blocked", tick);
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: a decided Done from the tool path that lands on a reopened gate is compensated and refused gate_moved", async () => {
  const { mod, objects, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-1024": boundGate() }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-1024", { decision_token: tokenFor("TEAM-1024") });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "gate_moved");
      assert.equal(issues["TEAM-1024"].status, "Blocked");
      // TEAM-5387: the record stays; the reopen moved the cycle, so it is stale for every reader.
      assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, "TEAM-1024")], "the gate-decision record stays (never deleted)");
      assert.equal(transitionPosts(writes).length, 2, "the Done, then the move back");
    }, {
      beforeWrite: (w, issues, tick) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues["TEAM-1024"].status === "In Review") {
          reopenInJira(issues["TEAM-1024"], "In Review", "Blocked", tick);
        }
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5347 F3: a non-Done move (and a ratify) deletes only the hold it observed - a newer hold installed meanwhile survives", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    // (a) no interference: the observed hold is deleted, as before.
    await withDecisionJira({ "TEAM-1025": heldGate("TEAM-1025") }, async ({ writes, issues }) => {
      const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1025", transition_id: "blocked", reason: "rework" } });
      assert.equal(res.status, "blocked");
      assert.ok(!(GV in issues["TEAM-1025"].properties));
      assert.equal(writes.filter((w) => w.method === "DELETE").length, 1);
    });
    // (b) a newer hold lands between the read and the move: it is NOT ours, so it stays.
    let newer;
    await withDecisionJira({ "TEAM-1026": heldGate("TEAM-1026") }, async ({ writes, issues }) => {
      const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1026", transition_id: "blocked", reason: "rework" } });
      assert.equal(res.status, "blocked");
      assert.equal(res.gateVerifyDeleteFailed, undefined);
      assert.deepEqual(issues["TEAM-1026"].properties[GV], newer, "the newer hold survives");
      assert.ok(!writes.some((w) => w.method === "DELETE"));
    }, {
      beforeWrite: (w, issues) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path)) issues["TEAM-1026"].properties[GV] = newer = newerHold("TEAM-1026");
      },
    });
    // (c) ratify of an already-Done gate that still carries a hold (no post-condition
    // left to probe, so the close is admitted and ratified): same rule.
    let newest;
    const ratified = heldGate("TEAM-1027");
    ratified.status = "Done";
    delete ratified.properties["agentcore-hub-post-condition"];
    await withDecisionJira({ "TEAM-1027": ratified }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-1027", { decision_token: tokenFor("TEAM-1027"), reason: "ratify: Jira UI close by abc" });
      assert.equal(res.ratified, true);
      assert.deepEqual(issues["TEAM-1027"].properties[GV], newest, "the newer hold survives the ratify");
      assert.ok(!writes.some((w) => w.method === "DELETE"));
    }, {
      beforeWrite: (w, issues) => {
        // The ratify's first write is the DECISION comment; the newer hold lands then.
        if (w.method === "POST" && /\/comment$/.test(w.path) && !newest) issues["TEAM-1027"].properties[GV] = newest = newerHold("TEAM-1027");
      },
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5358 FR-3: cancelled is Won't Do, never Done; F2: a signed stop ─────

test("mapStatusToInternal(\"Won't Do\") === \"cancelled\" (and Cancelled/canceled)", async () => {
  const { mapStatusToInternal } = await import("./index.mjs");
  for (const name of ["Won't Do", "won't do", "Wont Do", "WON'T DO", "Won’t Do", " Wont Do ", "Cancelled", "canceled", "CANCELED"]) {
    assert.equal(mapStatusToInternal(name), "cancelled", name);
  }
  assert.equal(mapStatusToInternal("Done"), "done");
  assert.equal(mapStatusToInternal("Some Custom"), "some_custom");
});

/** A Jira for one agent ticket whose workflow offers `transitions`; records every write. */
function installCancelStub(transitions) {
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    if (method !== "GET") {
      writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/transitions")) return new Response(JSON.stringify({ transitions }), { status: 200 });
    return new Response(JSON.stringify({
      key: "TEAM-970",
      fields: { summary: "Backend work", labels: ["agent:agentcore_hub_backend_dev"], status: { name: "In Progress" }, issuetype: { name: "Task" } },
    }), { status: 200 });
  };
  return writes;
}

const cancelTicket = (extra = {}) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-970", transition_id: "cancelled", reason: "run cancelled", ...extra } });

test("transition to cancelled with no Won't Do transition returns cancel_status_missing and POSTs no transition", async () => {
  const originalFetch = globalThis.fetch;
  const writes = installCancelStub([
    { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
    { id: "11", name: "Blocked", to: { name: "Blocked" } },
  ]);
  try {
    const res = await cancelTicket();
    assert.equal(res.ok, false);
    assert.equal(res.error, "cancel_status_missing");
    assert.equal(res.ticketId, "TEAM-970");
    assert.deepEqual(res.available, ["Done (-> Done)", "Blocked (-> Blocked)"]);
    assert.deepEqual(writes, [], "no transition, no reason comment");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transition to cancelled never picks a Done-category transition", async () => {
  const originalFetch = globalThis.fetch;
  // A transition NAMED Won't Do that lands on Done is not a cancel.
  let writes = installCancelStub([
    { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
    { id: "61", name: "Won't Do", to: { name: "Done", statusCategory: { key: "done" } } },
  ]);
  try {
    assert.equal((await cancelTicket()).error, "cancel_status_missing");
    assert.deepEqual(writes, []);
    // The real Won't Do status (Done-category in Jira, but its own status) is taken,
    // and the `cancel` id is an alias of the target.
    writes = installCancelStub([
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
      { id: "51", name: "Won't Do", to: { name: "Won't Do", statusCategory: { key: "done" } } },
    ]);
    const res = await cancelTicket({ transition_id: "cancel" });
    assert.equal(res.status, "cancelled");
    const posts = writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path));
    assert.deepEqual(posts.map((p) => p.body.transition.id), ["51"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// TEAM-5375: the cancel transition is picked by destination alone, not by the
// first name-or-destination hit (which can be a Done-bound "Won't Do").
test("transition to cancelled takes the real Won't Do past a Done-bound decoy listed first", async () => {
  const originalFetch = globalThis.fetch;
  const writes = installCancelStub([
    { id: "61", name: "Won't Do", to: { name: "Done", statusCategory: { key: "done" } } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do", statusCategory: { key: "done" } } },
  ]);
  try {
    const res = await cancelTicket();
    assert.equal(res.status, "cancelled");
    const posts = writes.filter((w) => w.method === "POST" && /\/transitions$/.test(w.path));
    assert.deepEqual(posts.map((p) => p.body.transition.id), ["51"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transition to cancelled refuses a "Cancel" transition that lands on Done', async () => {
  const originalFetch = globalThis.fetch;
  const writes = installCancelStub([{ id: "41", name: "Cancel", to: { name: "Done", statusCategory: { key: "done" } } }]);
  try {
    const res = await cancelTicket();
    assert.equal(res.error, "cancel_status_missing");
    assert.deepEqual(res.available, ["Cancel (-> Done)"]);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("F2: reviewer:* gate -> cancelled refused without stopped token", async () => {
  const { mod, s3Puts, ledgerPuts, restore } = await loadDecisionGate();
  const transitions = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
  ];
  const cancel = (ticket_id, extra = {}) =>
    mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id, transition_id: "cancelled", ...extra } });
  try {
    await withDecisionJira({
      "TEAM-971": boundGate({ transitions }),
      // No DECISION OPTIONS line: still a human gate, still needs the stop.
      "TEAM-972": boundGate({ transitions, description: ["Approve the deploy."] }),
    }, async ({ writes, issues }) => {
      const bare = await cancel("TEAM-971", { reason: "run abandoned" });
      assert.equal(bare.reason, "decision_required");
      assert.deepEqual(bare.options, ["stopped"]);
      assert.equal(bare.detail, "no_decision");
      assert.equal((await cancel("TEAM-972")).reason, "decision_required");
      // An approve token is not a stop, and is not spent on the refused cancel.
      const approve = await cancel("TEAM-971", { decision_token: tokenFor("TEAM-971", "approve") });
      assert.equal(approve.detail, "stop_requires_signed_decision");
      assert.equal(ledgerPuts.length, 0);
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);
      assert.equal(issues["TEAM-971"].status, "In Review");

      const ok = await cancel("TEAM-971", { decision_token: tokenFor("TEAM-971", "stopped"), reason: "operator stopped the run" });
      assert.equal(ok.status, "cancelled");
      assert.deepEqual(ok.decision, { option: "stopped", override: true, channel: "hub" });
      assert.equal(issues["TEAM-971"].status, "Won't Do");
      assert.equal(adfToText(issues["TEAM-971"].comments.at(-1).body).split("\n")[0], "DECISION: override:stopped");
      assert.deepEqual(s3Puts.map((p) => p.key), [gateDecisionRecordKey(DWF, "TEAM-971")]);
      assert.equal(s3Puts[0].body.decision.option, "stopped");
      assert.equal(verifyGateDecisionRecord(s3Puts[0].body, [DKEY]), true);
    });
  } finally {
    restore();
  }
});

test("TEAM-5371: a label-only gate (human-review or reviewer:* beside an agent: label) cannot be cancelled without a signed stop", async () => {
  const { mod, s3Puts, ledgerPuts, restore } = await loadDecisionGate();
  const transitions = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
  ];
  const cancel = (ticket_id, extra = {}) =>
    mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id, transition_id: "cancelled", ...extra } });
  const agent = "agent:agentcore_hub_release_manager";
  try {
    await withDecisionJira({
      "TEAM-981": boundGate({ transitions, labels: ["human-review", agent, `wf:${DWF}`] }),
      "TEAM-982": boundGate({ transitions, labels: ["reviewer:alice", agent, `wf:${DWF}`] }),
    }, async ({ writes, issues }) => {
      for (const id of ["TEAM-981", "TEAM-982"]) {
        const bare = await cancel(id, { reason: "run abandoned" });
        assert.equal(bare.reason, "decision_required", id);
        assert.equal(bare.detail, "no_decision", id);
      }
      assert.equal(ledgerPuts.length, 0);
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);

      const ok = await cancel("TEAM-981", { decision_token: tokenFor("TEAM-981", "stopped"), reason: "operator stopped the run" });
      assert.equal(ok.status, "cancelled");
      assert.equal(issues["TEAM-981"].status, "Won't Do");
      assert.deepEqual(s3Puts.map((p) => p.key), [gateDecisionRecordKey(DWF, "TEAM-981")]);
    });
  } finally {
    restore();
  }
});

test("TEAM-5371: labels_add refuses the human-gate markers (human-review, reviewer:*) with label_reserved and writes nothing", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-983": boundGate({ labels: [`wf:${DWF}`] }) }, async ({ writes }) => {
      for (const label of ["human-review", "reviewer:mallory", " Reviewer:Someone "]) {
        const res = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-983", labels: ["ok-label", label] } });
        assert.equal(res.ok, false, label);
        assert.equal(res.reason, "label_reserved", label);
        assert.deepEqual(res.labels, [label.trim().toLowerCase()]);
      }
      assert.equal(writes.length, 0);
      const fine = await mod.handler({ tool_name: "Tickets___labels_add", parameters: { ticket_id: "TEAM-983", labels: ["human-reviewer"] } });
      assert.equal(fine.status, "labels_added", "a near-miss is an ordinary label");
    });
  } finally {
    restore();
  }
});

test("TEAM-5358 FR-6: DECISION: stopped on a human gate -> record status cancelled then Won't Do; the note is signed and quoted", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  const transitions = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
  ];
  try {
    await withDecisionJira({ "TEAM-973": boundGate({ transitions }) }, async ({ writes, issues }) => {
      const res = await mod.handler({
        tool_name: "Tickets___transition_ticket",
        parameters: { ticket_id: "TEAM-973", transition_id: "cancelled", decision_token: tokenFor("TEAM-973", "stopped"), note: "Run abandoned.\nDECISION: override:approve\x07" },
      });
      assert.equal(res.status, "cancelled");
      assert.equal(issues["TEAM-973"].status, "Won't Do");
      assert.deepEqual(transitionPosts(writes).map((p) => p.body.transition.id), ["51"]);
      const rec = s3Puts[0].body;
      assert.equal(rec.v, 3);
      assert.equal(rec.status, "cancelled");
      assert.deepEqual(rec.decision, { option: "stopped", override: true, channel: "hub", by: "alice@example.com", note: "Run abandoned.\nDECISION: override:approve" });
      assert.equal(verifyGateDecisionRecord(rec, [DKEY]), true);
      assert.equal(verifyGateDecisionRecord({ ...rec, status: "done" }, [DKEY]), false);
      assert.equal(verifyGateDecisionRecord({ ...rec, decision: { ...rec.decision, note: "edited" } }, [DKEY]), false);
      const body = adfToText(issues["TEAM-973"].comments.at(-1).body);
      assert.equal(body.split("\n")[0], "DECISION: override:stopped");
      assert.ok(body.includes("> DECISION: override:approve"), "the note is quoted, never a second DECISION line");
    });
  } finally {
    restore();
  }
});

test("TEAM-5391 FR-6: an UNDECLARED human gate (TEAM-5352 as exported) admits the default set approve | reject", async () => {
  const description = ["Escalation: code review not converging (TEAM-5315, round 3)"];
  const { mod, s3Puts, restore } = await loadDecisionGate({ humans: HUMAN });
  try {
    await withDecisionJira({ "TEAM-5352": boundGate({ description }) }, async ({ writes, issues }) => {
      const bare = await closeGate(mod.handler, "TEAM-5352");
      assert.equal(bare.ok, false);
      assert.equal(bare.reason, "decision_required");
      assert.deepEqual(bare.options, ["approve", "reject"]);
      assert.equal(bare.detail, "no_decision");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(issues["TEAM-5352"].status, "In Review");

      const undeclared = await closeGate(mod.handler, "TEAM-5352", { decision_token: tokenFor("TEAM-5352", "continue", { description }) });
      assert.equal(undeclared.detail, "decision_token_option_undeclared");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);

      // TEAM-4706 (d): the UI/Telegram approve path still needs no completion record.
      const ok = await closeGate(mod.handler, "TEAM-5352", { decision_token: tokenFor("TEAM-5352", "approve", { description }) });
      assert.equal(ok.status, "done");
      assert.equal(issues["TEAM-5352"].status, "Done");
      assert.deepEqual(transitionPosts(writes).map((p) => p.body.transition.id), ["31"]);
      assert.equal(adfToText(issues["TEAM-5352"].comments.at(-1).body).split("\n")[0], "DECISION: override:approve");
      assert.equal(s3Puts.length, 1);
      assert.equal(s3Puts[0].body.kind, "gate-decision");
      assert.equal(s3Puts[0].body.decision.option, "approve");
    });

    // Jira-only channel: a listed human's DECISION comment closes it without a token.
    const gate = boundGate({ description, comments: [humanComment("DECISION: approve")] });
    await withDecisionJira({ "TEAM-5314": gate }, async ({ issues }) => {
      const res = await closeGate(mod.handler, "TEAM-5314");
      assert.equal(res.status, "done");
      assert.deepEqual(res.decision, { option: "approve", override: false, channel: "jira" });
      assert.equal(issues["TEAM-5314"].status, "Done");
    });
  } finally {
    restore();
  }
});

test("TEAM-5391: a signed fix-decision pick on a ci-unavailable gate counts as its DECISION line", async () => {
  // No build for the head, no DECISION line in the description: only the human's
  // signed `accept-proxy` pick can lift the stall, exactly as the line would.
  const { mod, probeCalls, restore } = await loadDecisionGate({ probe: { ok: true, match: null, project: "hub-x-ci" } });
  const description = ["CI unreachable for head.", "DECISION OPTIONS: repaired | accept-proxy | abort"];
  const labels = ["human-review", "reviewer:alice", `wf:${DWF}`, "gate:ci-unavailable", "pipeline:hub-x-deploy", `head:${"c".repeat(40)}`];
  try {
    await withDecisionJira({ "TEAM-977": boundGate({ labels, description }) }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-977", { decision_token: tokenFor("TEAM-977", "accept-proxy", { description }) });
      assert.equal(res.status, "done");
      assert.equal(issues["TEAM-977"].status, "Done");
      assert.equal(transitionPosts(writes).length, 1);
      assert.deepEqual(probeCalls.map((c) => c.tool_name), ["Pipeline___get_build_status"]);
      assert.equal(probeCalls[0].parameters.commit_sha, "c".repeat(40));
    });
  } finally {
    restore();
  }
});

test("TEAM-5358 FR-6: DECISION: <listed> -> done with record status done; an undeclared option -> decision_required with options", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-974": boundGate() }, async ({ writes, issues }) => {
      const bad = await closeGate(mod.handler, "TEAM-974", { decision_token: tokenFor("TEAM-974", "merge-anyway") });
      assert.equal(bad.reason, "decision_required");
      assert.deepEqual(bad.options, ["approve", "reject"]);
      assert.equal(bad.detail, "decision_token_option_undeclared");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);

      assert.equal((await closeGate(mod.handler, "TEAM-974", { decision_token: tokenFor("TEAM-974") })).status, "done");
      assert.equal(issues["TEAM-974"].status, "Done");
      const rec = s3Puts[0].body;
      assert.equal(rec.v, 3);
      assert.equal(rec.status, "done");
      assert.equal(rec.decision.option, "approve");
      assert.equal("note" in rec.decision, false);
      assert.equal(verifyGateDecisionRecord(rec, [DKEY]), true);
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5396 F1: reject is Request changes, never a Done close ────────────────
test("TEAM-5396 F1: a reject token on done is refused reject_requests_changes_not_closes - no POST, no record, token unspent", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  const UNDECLARED = ["Approve the merge of PR #807."];
  try {
    await withDecisionJira({ "TEAM-990": boundGate(), "TEAM-991": boundGate({ description: UNDECLARED }) }, async ({ writes, issues }) => {
      for (const [id, description] of [["TEAM-990", BOUND_DESC], ["TEAM-991", UNDECLARED]]) {
        const t = tokenFor(id, "reject", { description, jti: `reject-${id}-000001` });
        const res = await closeGate(mod.handler, id, { decision_token: t });
        assert.equal(res.ok, false, id);
        assert.equal(res.reason, "decision_required");
        assert.equal(res.detail, "reject_requests_changes_not_closes");
        assert.equal(issues[id].status, "In Review");
        // Not spent: the same token is refused for the same reason, not as consumed.
        assert.equal((await closeGate(mod.handler, id, { decision_token: t })).detail, "reject_requests_changes_not_closes");
      }
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);
      // Request changes is the reject path: In Review -> Blocked needs no token.
      const back = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-991", transition_id: "blocked", reason: "the cache key ignores the tenant" } });
      assert.equal(back.status, "blocked");
      assert.equal(issues["TEAM-991"].status, "Blocked");
    });
  } finally {
    restore();
  }
});

test("TEAM-5396 F1: a Jira-UI Done ratified on a human `DECISION: reject` comment is refused, not ratified", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate({ humans: HUMAN });
  try {
    await withDecisionJira({ "TEAM-992": boundGate({ status: "Done", comments: [humanComment("DECISION: reject")] }) }, async ({ writes }) => {
      const res = await closeGate(mod.handler, "TEAM-992", { reason: "ratify: Jira UI close by abc" });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "reject_requests_changes_not_closes");
      assert.equal(res.ratified, undefined);
      assert.equal(transitionPosts(writes).length, 0, "the webhook route reopens a refused ratify");
      assert.equal(s3Puts.length, 0);
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5396 F2: the cancelled terminal contract, before any write ───────────
test("TEAM-5396 F2: cancelled -> * and done -> cancelled return terminal_status with no comment, no transition POST, no write", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    const cases = [
      ["Won't Do", "ready"], ["Cancelled", "ready"], ["Won't Do", "skip"], ["Won't Do", "in_progress"], ["Won't Do", "done"],
      ["Done", "cancelled"], ["Done", "cancel"],
    ];
    for (const [status, transition_id] of cases) {
      // A bound gate too: the refusal must come before the decision guard's comment and key load.
      for (const issue of [boundGate({ status }), { labels: ["agent:agentcore_hub_backend_dev"], status }]) {
        await withDecisionJira({ "TEAM-993": issue }, async ({ writes, issues }) => {
          const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-993", transition_id, reason: "move it" } });
          const label = `${status} -> ${transition_id}`;
          assert.equal(res.ok, false, label);
          assert.equal(res.error, "terminal_status", label);
          assert.equal(res.from, status === "Done" ? "done" : "cancelled", label);
          assert.deepEqual(writes, [], `${label}: no comment, no transition POST, no property write`);
          assert.equal(issues["TEAM-993"].status, status);
        });
      }
    }
    assert.equal(s3Puts.length, 0);
  } finally {
    restore();
  }
});

// ─── TEAM-5408 (R2-01): the terminal guard holds at EVERY status read before a write ─
//
// The real handler with only Jira HTTP mocked. `beforeGet` lands the human's cancel
// between two of the handler's own status reads; `statusReadsOf` is the sequence of
// status names the handler observed, so the ticket's repro - reads
// ["In Progress","Cancelled"] - is asserted literally.
const isStatusRead = (path) => /^\/rest\/api\/3\/issue\/TEAM-\d+\?fields=[^&]*status/.test(path);
const RACED_TICKET = (status, transitions) => ({
  labels: ["agent:agentcore_hub_api_dev"],
  status,
  transitions: transitions || [
    { id: "11", name: "Ready", to: { name: "Ready" } },
    { id: "41", name: "Blocked", to: { name: "Blocked" } },
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
  ],
});
/** Flip `id` to `to` right before the handler's (flipAfter+1)th status read; records what each read saw. */
const flipAfterStatusRead = (id, flipAfter, to) => {
  const seen = [];
  return {
    seen,
    hooks: {
      beforeGet: ({ path }, issues) => {
        if (!isStatusRead(path)) return;
        if (seen.length === flipAfter) issues[id].status = to;
        seen.push(issues[id].status);
      },
    },
  };
};

test("TEAM-5408 R2-01 repro: status reads [In Progress, Cancelled] on a ready move -> terminal_status, writes = []", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    // flipAfter 1: the cancel lands between the entry read and the cycle-reset read (the
    // reported interleaving). flipAfter 2: between the cycle-reset read and the write phase.
    for (const [flipAfter, readAt] of [[1, "cycle-read"], [2, "pre-write"]]) {
      const { seen, hooks } = flipAfterStatusRead("TEAM-994", flipAfter, "Cancelled");
      await withDecisionJira({ "TEAM-994": RACED_TICKET("In Progress") }, async ({ writes, issues }) => {
        const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-994", transition_id: "ready", reason: "picking it back up" } });
        const label = `flip after read #${flipAfter}`;
        assert.equal(res.ok, false, label);
        assert.equal(res.error, "terminal_status", label);
        assert.equal(res.from, "cancelled", label);
        assert.equal(res.to, "ready", label);
        assert.equal(res.readAt, readAt, label);
        assert.deepEqual(writes, [], `${label}: no comment, no transition POST`);
        assert.equal(issues["TEAM-994"].status, "Cancelled", label);
        assert.ok(seen.length >= 2, `${label}: a later read fired and was the guarded one (${JSON.stringify(seen)})`);
      }, hooks);
      if (flipAfter === 1) assert.deepEqual(seen, ["In Progress", "Cancelled"], "the ticket's repro, literally");
    }
    assert.equal(s3Puts.length, 0);
  } finally {
    restore();
  }
});

test("TEAM-5408: a cancel inside the comment -> transition burst refuses the POST (pre-transition read); the reason comment is the residual", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-995": RACED_TICKET("In Progress") }, async ({ writes, issues }) => {
      const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-995", transition_id: "ready", reason: "picking it back up" } });
      assert.equal(res.ok, false);
      assert.equal(res.error, "terminal_status");
      assert.equal(res.readAt, "pre-transition");
      assert.equal(transitionPosts(writes).length, 0, "no transition POST");
      assert.deepEqual(writes.map((w) => w.path), ["/rest/api/3/issue/TEAM-995/comment"], "the comment is the one write Jira's API cannot take back");
      assert.equal(issues["TEAM-995"].status, "Cancelled");
    }, {
      // The human cancels while the reason comment is in flight.
      beforeWrite: (w, issues) => { if (/\/comment$/.test(w.path)) issues["TEAM-995"].status = "Cancelled"; },
    });
  } finally {
    restore();
  }
});

test("TEAM-5408: In Progress -> Done between reads on a cancel -> terminal_status (done is never cancelled), writes = []", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    for (const transition_id of ["cancelled", "cancel"]) {
      // A cancel is a non-Done target, so the next status read after the entry read is
      // the cycle-reset read; the gate-context read follows it.
      const { seen, hooks } = flipAfterStatusRead("TEAM-996", 1, "Done");
      await withDecisionJira({ "TEAM-996": RACED_TICKET("In Progress") }, async ({ writes, issues }) => {
        const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-996", transition_id, reason: "stopped" } });
        assert.equal(res.ok, false, transition_id);
        assert.equal(res.error, "terminal_status", transition_id);
        assert.equal(res.from, "done", transition_id);
        assert.equal(res.to, "cancelled", transition_id);
        assert.equal(res.readAt, "cycle-read", transition_id);
        assert.deepEqual(writes, [], `${transition_id}: no comment, no transition POST`);
        assert.equal(issues["TEAM-996"].status, "Done", transition_id);
        assert.deepEqual(seen, ["In Progress", "Done"], transition_id);
      }, hooks);
    }
    assert.equal(s3Puts.length, 0);
  } finally {
    restore();
  }
});

test("TEAM-5408: a NON-terminal interleaving (In Progress -> Blocked between reads) still transitions, and the landed status is verified", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    for (const flip of [{ after: 1, to: "Blocked" }, null]) {
      const { hooks } = flip ? flipAfterStatusRead("TEAM-997", flip.after, flip.to) : { hooks: {} };
      await withDecisionJira({ "TEAM-997": RACED_TICKET("In Progress") }, async ({ writes, issues }) => {
        const res = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-997", transition_id: "ready", reason: "picking it back up" } });
        const label = flip ? `flip to ${flip.to}` : "no flip";
        assert.equal(res.status, "ready", label);
        assert.equal(res.message, "Transitioned to ready", label);
        assert.equal(res.landed, "ready", label);
        assert.equal(res.verified, true, label);
        assert.equal(res.error, undefined, label);
        assert.equal(transitionPosts(writes).length, 1, label);
        assert.equal(writes.filter((w) => /\/comment$/.test(w.path)).length, 1, label);
        assert.equal(issues["TEAM-997"].status, "Ready", label);
      }, hooks);
    }
  } finally {
    restore();
  }
});

test("TEAM-5408: a gate cancelled right after our Done is not moved back and not re-paged (compensateDone honours the terminal rule)", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-998": boundGate() }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-998", { decision_token: tokenFor("TEAM-998") });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "gate_moved");
      const gate = issues["TEAM-998"];
      assert.equal(gate.status, "Won't Do", "the human's cancel stands");
      assert.equal(transitionPosts(writes).length, 1, "our Done only: no move back to In Review");
      assert.ok(!gate.labels.includes("gate:awaiting-console"), "not re-paged");
      assert.ok(gate.comments.some((c) => /Superseded: this gate was cancelled \(status_moved\)/.test(adfToText(c.body))));
      assert.ok(!gate.comments.some((c) => /Decide it again/.test(adfToText(c.body))), "no re-decide prompt on a cancelled gate");
    }, {
      // The human cancels AFTER our Done landed and BEFORE verifyOwnDone reads the changelog.
      beforeGet: ({ path }, issues, tick) => {
        if (/\/changelog(\?|$)/.test(path) && issues["TEAM-998"].status === "Done") reopenInJira(issues["TEAM-998"], "Done", "Won't Do", tick);
      },
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5413 (R3-02): a cancel our Done overwrote is compensated TO Won't Do ─────
//
// TEAM-5396 F2 compensated a Done that landed on a concurrently cancelled gate back to
// the cancelled terminal (verifyOwnDone reads Won't Do -> Done, compensateDone moves
// it back). TEAM-5408's inline guard then consulted terminalMoveRefusal(done ->
// cancelled) for that undo and skipped the move: the gate stayed Done behind a claimed
// decision record. These run the real handler with only Jira HTTP stubbed and judge
// the outcome the way a dependant's cascade does: the orchestrator's own
// isBlockerResolved, with gateDecided wired to the real standingGateDecision over the
// record the close claimed and the gate as this Lambda's get_issue now reports it.
import { isBlockerResolved } from "../orchestrator/cascade.mjs";
import { standingGateDecision } from "../orchestrator/proof-record-verify.mjs";

const CANCELLABLE_TRANSITIONS = [
  { id: "31", name: "Done", to: { name: "Done" } },
  { id: "21", name: "In Review", to: { name: "In Review" } },
  { id: "41", name: "Blocked", to: { name: "Blocked" } },
  // TEAM-5375 decoy: NAMED Won't Do, lands on Done, listed before the real one.
  { id: "61", name: "Won't Do", to: { name: "Done" } },
  { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
];

/** Does a dependant of `ticketId` see its blocker resolved? The orchestrator's rule, over the live gate and the stored record. */
async function dependantSeesResolved(mod, objects, ticketId) {
  const live = await mod.handler({ tool_name: "Tickets___get_issue", parameters: { ticket_id: ticketId } });
  const blocker = { ticketId, status: live.status, assignee: live.assignee, labels: live.labels, workflowId: DWF };
  const gateDecided = async (b, workflowId) => {
    const s = await standingGateDecision(b.ticketId, {
      workflowId,
      keys: [DKEY],
      readJson: async (key) => (objects.has(key) ? JSON.parse(objects.get(key)) : null),
      liveGate: async () => live,
    });
    return s.ok && s.record.status === "done";
  };
  return { resolved: await isBlockerResolved(blocker, { workflowId: DWF, gateDecided }), live };
}

test("TEAM-5413 (R3-02): a cancel between the pre-transition read and the Done POST is compensated to Won't Do - In Review gate and Blocked gate", async () => {
  const { mod, objects, restore } = await loadDecisionGate();
  try {
    for (const start of ["In Review", "Blocked"]) {
      const id = start === "Blocked" ? "TEAM-5414" : "TEAM-5413";
      await withDecisionJira({ [id]: boundGate({ status: start, transitions: CANCELLABLE_TRANSITIONS }) }, async ({ writes, issues }) => {
        const res = await closeGate(mod.handler, id, { decision_token: tokenFor(id) });
        const gate = issues[id];
        assert.equal(res.reason, "decision_required", start);
        assert.equal(res.detail, "gate_moved", start);
        assert.equal(gate.status, "Won't Do", `${start}: the cancelled terminal wins`);
        // Our Done, then the compensating move to the REAL Won't Do (the decoy is skipped).
        assert.deepEqual(transitionPosts(writes).map((p) => p.body.transition.id), ["31", "51"], start);
        assert.ok(gate.comments.some((c) => /Superseded: this gate was cancelled \(status_moved\)/.test(adfToText(c.body))), start);
        assert.ok(!gate.comments.some((c) => /Decide it again/.test(adfToText(c.body))), `${start}: no re-decide prompt on a cancelled gate`);
        assert.ok(!gate.labels.includes("gate:awaiting-console"), `${start}: not re-paged`);
        assert.ok(!gate.labels.includes("gateverify:verified"), start);
        // TEAM-5387: the claimed record stays; no merge-approval record for a Done that did not stand.
        assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, id)], start);
        // The decision is not standing and a dependant stays blocked.
        const { resolved, live } = await dependantSeesResolved(mod, objects, id);
        assert.equal(live.status, "cancelled", start);
        assert.equal(resolved, false, `${start}: isBlockerResolved must be false for a dependant`);
      }, {
        // The human cancels AFTER the pre-transition read and BEFORE our Done POST lands.
        beforeWrite: (w, issues, tick) => {
          if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues[id].status === start) {
            reopenInJira(issues[id], start, "Won't Do", tick);
          }
        },
      });
      objects.clear();
    }
  } finally {
    restore();
  }
});

test("TEAM-5413 (R3-02): reprobe - a cancel between liveHold and the Done POST is compensated to Won't Do (superseded_compensated), no merge-approval record", async () => {
  const { mod, s3Puts, objects, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    const held = heldGate("TEAM-5415", { summary: "Merge Approval: hub-x" });
    held.transitions = CANCELLABLE_TRANSITIONS;
    await withDecisionJira({ "TEAM-5415": held }, async ({ writes, issues }) => {
      const res = await mod.handler({ mode: "reprobe" });
      assert.deepEqual(res.results, [{ ticketId: "TEAM-5415", outcome: "superseded_compensated", reason: "status_moved" }]);
      assert.equal(res.compensated, 1);
      const gate = issues["TEAM-5415"];
      assert.equal(gate.status, "Won't Do", "the cancelled terminal wins");
      assert.deepEqual(transitionPosts(writes).map((p) => p.body.transition.id), ["31", "51"]);
      assert.deepEqual(recordPuts(s3Puts), [gateDecisionRecordKey(DWF, "TEAM-5415")], "no merge-approval record");
      assert.ok(GV in gate.properties, "the hold is never deleted");
      assert.ok(!gate.labels.includes("gate:awaiting-console"), "not re-paged");
      assert.ok(!gate.labels.includes("gateverify:verified"));
      assert.ok(gate.comments.some((c) => /Superseded: this gate was cancelled \(status_moved\)/.test(adfToText(c.body))));
      assert.ok(!gate.comments.some((c) => /Decide it again/.test(adfToText(c.body))));
      const { resolved, live } = await dependantSeesResolved(mod, objects, "TEAM-5415");
      assert.equal(live.status, "cancelled");
      assert.equal(resolved, false, "isBlockerResolved must be false for a dependant");
    }, {
      beforeWrite: (w, issues, tick) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues["TEAM-5415"].status === "In Review") {
          reopenInJira(issues["TEAM-5415"], "In Review", "Won't Do", tick);
        }
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5413: R2-01 holds - a cancel observed on the pre-transition read of a decided Done is refused terminal_status with no POST", async () => {
  const { mod, objects, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-5416": boundGate({ transitions: CANCELLABLE_TRANSITIONS }) }, async ({ writes, issues }) => {
      const res = await closeGate(mod.handler, "TEAM-5416", { decision_token: tokenFor("TEAM-5416") });
      assert.equal(res.ok, false);
      assert.equal(res.error, "terminal_status");
      assert.equal(res.readAt, "pre-transition");
      assert.equal(res.from, "cancelled");
      assert.equal(res.to, "done");
      assert.equal(transitionPosts(writes).length, 0, "no transition POST at all");
      assert.equal(issues["TEAM-5416"].status, "Won't Do");
      assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, "TEAM-5416")], "the claimed record stays; no merge-approval record");
      const { resolved } = await dependantSeesResolved(mod, objects, "TEAM-5416");
      assert.equal(resolved, false);
    }, {
      // The human cancels while the transitions list is being fetched: the next status
      // read is the pre-transition one.
      beforeGet: ({ path }, issues, tick) => {
        if (/\/transitions$/.test(path) && issues["TEAM-5416"].status === "In Review") reopenInJira(issues["TEAM-5416"], "In Review", "Won't Do", tick);
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5358 FR-6: a second POST with the same jti writes no second record; stopped on a done close and a changed scope are refused", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-976": boundGate(), "TEAM-977": boundGate() }, async ({ writes, issues }) => {
      const t = tokenFor("TEAM-976", "approve", { jti: "reuse-jti-000000001" });
      assert.equal((await closeGate(mod.handler, "TEAM-976", { decision_token: t })).status, "done");
      assert.equal(s3Puts.length, 1);
      issues["TEAM-976"].status = "In Review";
      const again = await closeGate(mod.handler, "TEAM-976", { decision_token: t });
      assert.equal(again.reason, "decision_required");
      assert.equal(again.detail, "decision_token_consumed");
      assert.equal(s3Puts.length, 1);
      assert.equal(transitionPosts(writes).length, 1);

      const stop = await closeGate(mod.handler, "TEAM-977", { decision_token: tokenFor("TEAM-977", "stopped") });
      assert.equal(stop.detail, "stopped_cancels_not_closes");

      // Minted over BOUND_DESC; the row now carries a gate-scope line.
      const minted = tokenFor("TEAM-977");
      issues["TEAM-977"].description = SCOPED_DESC;
      const moved = await closeGate(mod.handler, "TEAM-977", { decision_token: minted });
      assert.equal(moved.reason, "decision_required");
      assert.equal(moved.detail, "decision_scope_changed");
      assert.equal(issues["TEAM-977"].status, "In Review");
      assert.equal(s3Puts.length, 1);
    });
  } finally {
    restore();
  }
});

// ─── TEAM-5358 B2/F3: gate-scope and DECISION OPTIONS are frozen once declared ─
const P4_SCOPE = (ids) => `gate-scope: {"round": 3, "headSha": "${SCOPE_HEAD}", "findingIds": ${JSON.stringify(ids)}}`;
const P4_DESC = [...BOUND_DESC, P4_SCOPE(["CR-9:11111111"])];
const P4_WIDENED = [...BOUND_DESC, P4_SCOPE(["CR-9:11111111", "CR-9:22222222"])].join("\n");
const updateGate = (h, ticket_id, extra) => h({ tool_name: "Tickets___update_ticket", parameters: { ticket_id, ...extra } });
const issuePuts = (writes) => writes.filter((w) => w.method === "PUT" && /\/issue\/[^/]+$/.test(w.path));

test("p4-scope: scope [CR-9:11111111], human approves, agent update_ticket appending CR-9:22222222 -> gate_frozen field gate-scope, description unchanged", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-985": boundGate({ description: P4_DESC }) }, async ({ writes, issues }) => {
      assert.equal((await closeGate(mod.handler, "TEAM-985", { decision_token: tokenFor("TEAM-985", "approve", { description: P4_DESC }) })).status, "done");
      assert.equal(issues["TEAM-985"].status, "Done");
      assert.deepEqual(s3Puts[0].body.scope.findingIds, ["CR-9:11111111"]);

      const res = await updateGate(mod.handler, "TEAM-985", { description: P4_WIDENED });
      assert.equal(res.reason, "gate_frozen");
      assert.equal(res.field, "gate-scope");
      assert.equal(res.decided, true);
      assert.equal(issuePuts(writes).length, 0);
      assert.deepEqual(issues["TEAM-985"].description, P4_DESC);

      // Before a decision the same widening, and an options edit, are refused as well.
      issues["TEAM-985"].status = "In Review";
      const pending = await updateGate(mod.handler, "TEAM-985", { description: P4_WIDENED });
      assert.equal(pending.reason, "gate_frozen");
      assert.equal(pending.decided, false);
      const opts = await updateGate(mod.handler, "TEAM-985", { description: P4_DESC.join("\n").replace("approve | reject", "approve | reject | merge-anyway") });
      assert.equal(opts.reason, "gate_frozen");
      assert.equal(opts.field, "decision-options");
      assert.deepEqual(opts.options, ["approve", "reject"]);
      assert.equal(issuePuts(writes).length, 0);
    });
  } finally {
    restore();
  }
});

test("p4-scope: a decided gate cannot gain a scope line; title-only and reworded-brief edits still succeed", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({
      "TEAM-986": boundGate({ status: "Done" }),
      "TEAM-987": boundGate({ status: "Done", description: P4_DESC }),
    }, async ({ writes, issues }) => {
      const add = await updateGate(mod.handler, "TEAM-986", { description: P4_DESC.join("\n") });
      assert.equal(add.reason, "gate_frozen");
      assert.equal(add.field, "gate-scope");
      assert.equal(add.decided, true);
      assert.equal(issuePuts(writes).length, 0);

      assert.equal((await updateGate(mod.handler, "TEAM-987", { title: "Deploy gate (renamed)" })).message, "Updated");
      const reworded = P4_DESC.join("\n").replace("Deploy hub-x", "Please deploy hub-x");
      assert.equal((await updateGate(mod.handler, "TEAM-987", { description: reworded })).message, "Updated");
      assert.equal(issuePuts(writes).length, 2);
      assert.deepEqual(issues["TEAM-987"].description, [reworded]);
    });
  } finally {
    restore();
  }
});

test("p4-scope: the same scope edit on a gate with no gate-scope/options succeeds; an agent ticket is never frozen", async () => {
  const { mod, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({
      "TEAM-988": boundGate({ description: ["Approve the deploy."] }),
      "TEAM-989": { labels: [`wf:${DWF}`, "agent:agentcore_hub_api_dev"], description: P4_DESC, status: "Done" },
    }, async ({ issues }) => {
      const declared = `Approve the deploy.\n${P4_SCOPE(["CR-9:11111111"])}`;
      assert.equal((await updateGate(mod.handler, "TEAM-988", { description: declared })).message, "Updated");
      // Declared now, so frozen.
      const again = await updateGate(mod.handler, "TEAM-988", { description: `Approve the deploy.\n${P4_SCOPE(["CR-9:22222222"])}` });
      assert.equal(again.reason, "gate_frozen");
      assert.deepEqual(issues["TEAM-988"].description, [declared]);
      assert.equal((await updateGate(mod.handler, "TEAM-989", { description: P4_WIDENED })).message, "Updated");
      assert.deepEqual(issues["TEAM-989"].description, [P4_WIDENED]);
    });
  } finally {
    restore();
  }
});

test("p4-scope: scope edited between view and click: token s mismatch -> close refused decision_scope_changed", async () => {
  const { mod, s3Puts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-990": boundGate() }, async ({ writes, issues }) => {
      // Viewed (and clicked) with options and no scope; an agent adds the scope line first.
      const clicked = tokenFor("TEAM-990");
      assert.equal((await updateGate(mod.handler, "TEAM-990", { description: P4_DESC.join("\n") })).message, "Updated");
      const res = await closeGate(mod.handler, "TEAM-990", { decision_token: clicked });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "decision_scope_changed");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Puts.length, 0);
      assert.equal(issues["TEAM-990"].status, "In Review");
      assert.equal((await closeGate(mod.handler, "TEAM-990", { decision_token: tokenFor("TEAM-990", "approve", { description: P4_DESC }) })).status, "done");
    });
  } finally {
    restore();
  }
});

test("update_ticket sets fields.parent and deletes Blocks links not in blocked_by", async () => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  const issuelinks = [
    { id: "1001", type: { name: "Blocks" }, inwardIssue: { key: "TEAM-980" } },
    { id: "1002", type: { name: "Blocks" }, inwardIssue: { key: "TEAM-981" } },
    // An outward link (this ticket blocks another) is never touched.
    { id: "1003", type: { name: "Blocks" }, outwardIssue: { key: "TEAM-982" } },
  ];
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    if (method !== "GET") {
      writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(null, { status: method === "POST" ? 201 : 204 });
    }
    return new Response(JSON.stringify({ key: "TEAM-975", fields: { issuelinks } }), { status: 200 });
  };
  try {
    const res = await handler({
      tool_name: "Tickets___update_ticket",
      parameters: { ticket_id: "TEAM-975", parent: "TEAM-990", blocked_by: ["TEAM-981", "TEAM-983"] },
    });
    assert.equal(res.message, "Updated");
    const put = writes.find((w) => w.method === "PUT" && w.path === "/rest/api/3/issue/TEAM-975");
    assert.deepEqual(put.body.fields.parent, { key: "TEAM-990" });
    assert.deepEqual(writes.filter((w) => w.method === "DELETE").map((w) => w.path), ["/rest/api/3/issueLink/1001"]);
    const links = writes.filter((w) => w.method === "POST" && w.path === "/rest/api/3/issueLink");
    assert.deepEqual(links.map((l) => [l.body.inwardIssue.key, l.body.outwardIssue.key]), [["TEAM-983", "TEAM-975"]]);
    assert.deepEqual(res.blockersRemoved, ["TEAM-980"]);
    assert.deepEqual(res.blockersAdded, ["TEAM-983"]);

    // `[]` detaches every blocker, and a blocked_by-only edit sends no empty PUT.
    writes.length = 0;
    const cleared = await handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-975", blocked_by: [] } });
    assert.deepEqual(cleared.blockedBy, []);
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ["DELETE /rest/api/3/issueLink/1001", "DELETE /rest/api/3/issueLink/1002"]);

    const bad = await handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-975", parent: "" } });
    assert.match(bad.error, /Invalid parent/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("update_ticket assignee swaps agent:/reviewer: labels in the same PUT; a decision-bound gate stays on a human", async () => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  let fields = { labels: ["wf:wf-1", "agent:agentcore_hub_backend_dev", "followup-0123abcd"], description: null, status: { name: "Blocked" } };
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    if (method !== "GET") {
      writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ key: "TEAM-975", fields }), { status: 200 });
  };
  try {
    const res = await handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-975", assignee: "human:engineer" } });
    assert.equal(res.assignee, "human:engineer");
    const put = writes.find((w) => w.method === "PUT");
    assert.deepEqual(put.body.update.labels, [{ remove: "agent:agentcore_hub_backend_dev" }, { add: "human-review" }, { add: "reviewer:engineer" }]);
    assert.deepEqual(put.body.fields, {});

    writes.length = 0;
    const unknown = await handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-975", assignee: "not_an_agent" } });
    assert.match(unknown.error, /Invalid assignee/);
    assert.equal(writes.length, 0);

    fields = { labels: ["human-review", "reviewer:engineer"], description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Approve?\nDECISION OPTIONS: approve | reject" }] }] }, status: { name: "In Review" } };
    const pinned = await handler({ tool_name: "Tickets___update_ticket", parameters: { ticket_id: "TEAM-975", assignee: "agentcore_hub_backend_dev" } });
    assert.equal(pinned.reason, "assignee_immutable");
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── TEAM-5372: the gate-decision record lands first, or the close is refused ─────
const GATE_RECORD_ATTRS = { option: "approve", override: true, channel: "hub", by: "alice@example.com" };
/** Seed `objects` with a signed record for `ticketId` (cycle null = a gate never reset). */
async function seedGateRecord(objects, ticketId, { cycle = null, ...decision } = {}) {
  const { buildGateDecisionRecord } = await import("./gate-contract.mjs");
  const record = buildGateDecisionRecord(
    { ticketId, workflowId: DWF, decision: { ...GATE_RECORD_ATTRS, ...decision }, labels: boundGate().labels, description: BOUND_DESC.join("\n"), cycle },
    DKEY
  );
  const key = gateDecisionRecordKey(DWF, ticketId);
  objects.set(key, JSON.stringify(record));
  return { key, record };
}
const pushPosts = (seq) => ({
  beforeWrite: (w) => {
    if (w.method === "POST" && /\/transitions$/.test(w.path)) seq.push("post:transitions");
  },
});
const shortSeq = (seq) => seq.map((e) => e.replace(/^(put|delete):.*\/(gates|jti|holds)\/.*$/, "$1:$2"));
const failDone = () => ({
  beforeWrite: (w) =>
    w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31"
      ? new Response(JSON.stringify({ errorMessages: ["boom"] }), { status: 500 })
      : null,
});

test("TEAM-5372: a decided Done and a stopped cancel put the record, then spend the token, then post the transition", async () => {
  const { mod, seq, restore } = await loadDecisionGate();
  const transitions = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "51", name: "Won't Do", to: { name: "Won't Do" } },
  ];
  try {
    await withDecisionJira({ "TEAM-1101": boundGate(), "TEAM-1102": boundGate({ transitions }) }, async ({ issues }) => {
      assert.equal((await closeGate(mod.handler, "TEAM-1101", { decision_token: tokenFor("TEAM-1101") })).status, "done");
      assert.deepEqual(shortSeq(seq), ["put:gates", "put:jti", "post:transitions"]);
      seq.length = 0;
      const stop = await mod.handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1102", transition_id: "cancelled", decision_token: tokenFor("TEAM-1102", "stopped") } });
      assert.equal(stop.status, "cancelled");
      assert.equal(issues["TEAM-1102"].status, "Won't Do");
      assert.deepEqual(shortSeq(seq), ["put:gates", "put:jti", "post:transitions"]);
    }, pushPosts(seq));
  } finally {
    restore();
  }
});

test("TEAM-5372: an S3 failure on the record refuses gate_decision_unrecorded - no ledger spend, no POST, and the same token then closes", async () => {
  const { mod, s3Fail, ledgerPuts, objects, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-1103": boundGate() }, async ({ writes, issues }) => {
      const t = tokenFor("TEAM-1103");
      s3Fail.fn = (cmd) => (cmd.constructor.name === "PutObjectCommand" && /\/gates\//.test(cmd.input.Key)
        ? Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } })
        : null);
      const res = await closeGate(mod.handler, "TEAM-1103", { decision_token: t });
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "gate_decision_unrecorded");
      assert.equal(issues["TEAM-1103"].status, "In Review");
      assert.equal(ledgerPuts.length, 0, "the token is not spent");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(writes.length, 0, "no comment either: the refusal leaves no trace in Jira");
      s3Fail.fn = null;
      assert.equal((await closeGate(mod.handler, "TEAM-1103", { decision_token: t })).status, "done");
      assert.equal(issues["TEAM-1103"].status, "Done");
      assert.ok(objects.has(gateDecisionRecordKey(DWF, "TEAM-1103")));
    });
  } finally {
    restore();
  }
});

test("TEAM-5372/TEAM-5387: a ledger failure after the record refuses decision_channel_unavailable and keeps the record; a same-token retry reuses it and closes", async () => {
  const { mod, s3Fail, objects, s3Deletes, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-1104": boundGate() }, async ({ writes, issues }) => {
      const t = tokenFor("TEAM-1104");
      s3Fail.fn = (cmd) => (cmd.constructor.name === "PutObjectCommand" && /\/jti\//.test(cmd.input.Key)
        ? Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } })
        : null);
      const res = await closeGate(mod.handler, "TEAM-1104", { decision_token: t });
      assert.equal(res.detail, "decision_channel_unavailable");
      assert.equal(transitionPosts(writes).length, 0);
      assert.deepEqual(s3Deletes, [], "never deleted");
      assert.deepEqual(storedRecords(objects), [gateDecisionRecordKey(DWF, "TEAM-1104")]);
      const left = objects.get(gateDecisionRecordKey(DWF, "TEAM-1104"));
      s3Fail.fn = null;
      assert.equal((await closeGate(mod.handler, "TEAM-1104", { decision_token: t })).status, "done");
      assert.equal(issues["TEAM-1104"].status, "Done");
      assert.equal(objects.get(gateDecisionRecordKey(DWF, "TEAM-1104")), left, "the retry found its own record `same` and reused it");
    });
  } finally {
    restore();
  }
});

test("TEAM-5372: a spent token is refused before any write; a spend lost after the record keeps the (same) record", async () => {
  const { mod, objects, s3Puts, s3Fail, s3Deletes, restore } = await loadDecisionGate();
  const { gateJtiLedgerKey } = await import("./gate-contract.mjs");
  try {
    await withDecisionJira({ "TEAM-1105": boundGate(), "TEAM-1106": boundGate() }, async ({ writes }) => {
      objects.set(gateJtiLedgerKey(DWF, "TEAM-1105", "spent-jti-0000000001"), JSON.stringify({ v: 1, kind: "jti-spent", jti: "spent-jti-0000000001" }));
      const spent = await closeGate(mod.handler, "TEAM-1105", { decision_token: tokenFor("TEAM-1105", "approve", { jti: "spent-jti-0000000001" }) });
      assert.equal(spent.detail, "decision_token_consumed");
      assert.equal(s3Puts.length, 0, "refused at validation: no record");

      // The concurrent close spends the same jti between this close's validation and its spend.
      const jti = "raced-jti-0000000001";
      s3Fail.fn = (cmd) => {
        if (cmd.constructor.name === "PutObjectCommand" && /\/jti\//.test(cmd.input.Key)) {
          objects.set(cmd.input.Key, JSON.stringify({ v: 1, kind: "jti-spent", jti }));
        }
        return null;
      };
      const lost = await closeGate(mod.handler, "TEAM-1106", { decision_token: tokenFor("TEAM-1106", "approve", { jti }) });
      assert.equal(lost.detail, "decision_token_consumed");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(s3Deletes.length, 0, "the same token is the same decision: the winner relies on this record");
      assert.ok(objects.has(gateDecisionRecordKey(DWF, "TEAM-1106")));
    });
  } finally {
    restore();
  }
});

test("TEAM-5387 R2-2: two closes with DISTINCT tokens for one decision - the loser keeps the record the winner closed on", async () => {
  const { mod, objects, s3Deletes, ledgerPuts, restore } = await loadDecisionGate();
  const { gateJtiLedgerKey, verifyGateDecisionRecord } = await import("./gate-contract.mjs");
  try {
    await withDecisionJira({ "TEAM-1107": boundGate() }, async ({ writes, issues }) => {
      // A claims the record and spends jti-A. Between A's spend and A's POST, B - another
      // token for the same human, option and cycle - finds A's record `same`, spends
      // jti-B and lands Done. A's POST is refused; A must not delete the record B closed on.
      const key = gateDecisionRecordKey(DWF, "TEAM-1107");
      const res = await closeGate(mod.handler, "TEAM-1107", { decision_token: tokenFor("TEAM-1107", "approve", { jti: "raced-jti-A000000001" }) });
      assert.ok(res.error, "A's close did not land");
      assert.equal(res.recordOrphaned, undefined);
      assert.equal(issues["TEAM-1107"].status, "Done", "B's Done stands");
      assert.deepEqual(s3Deletes, [], "A deleted nothing");
      assert.ok(objects.has(key), "the record B closed on is still there");
      assert.ok(verifyGateDecisionRecord(JSON.parse(objects.get(key)), [DKEY]));
      assert.deepEqual(ledgerPuts.map((p) => p.key), [gateJtiLedgerKey(DWF, "TEAM-1107", "raced-jti-A000000001")]);
      assert.ok(objects.has(gateJtiLedgerKey(DWF, "TEAM-1107", "raced-jti-B000000001")), "B's spend is on the ledger");
      assert.equal(transitionPosts(writes).length, 1, "A's refused POST; no compensating move");
    }, {
      beforeWrite: (w, issues, tick) => {
        if (w.method === "POST" && /\/transitions$/.test(w.path) && w.body?.transition?.id === "31" && issues["TEAM-1107"].status === "In Review") {
          // B's close landed first (its record claim found A's `same`; its jti is on the ledger).
          objects.set(gateJtiLedgerKey(DWF, "TEAM-1107", "raced-jti-B000000001"), JSON.stringify({ v: 1, kind: "jti-spent", jti: "raced-jti-B000000001" }));
          reopenInJira(issues["TEAM-1107"], "In Review", "Done", tick);
          return new Response(JSON.stringify({ errorMessages: ["Transition not valid for the current status"] }), { status: 409 });
        }
        return null;
      },
    });
  } finally {
    restore();
  }
});

test("TEAM-5387 R2-7: an AccessDenied on the record put refuses gate_decision_store_unauthorized naming the missing grant - no ledger spend, no POST, no comment", async () => {
  const { mod, s3Fail, ledgerPuts, objects, restore } = await loadDecisionGate();
  const errors = [];
  const originalError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await withDecisionJira({ "TEAM-1108": boundGate() }, async ({ writes, issues }) => {
      const t = tokenFor("TEAM-1108");
      s3Fail.fn = (cmd) => (cmd.constructor.name === "PutObjectCommand" && /\/gates\//.test(cmd.input.Key)
        ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
        : null);
      const res = await closeGate(mod.handler, "TEAM-1108", { decision_token: t });
      const grant = "s3:PutObject on arn:aws:s3:::hub-artifacts/pipeline-artifacts/gate-decisions/*";
      assert.equal(res.reason, "decision_required");
      assert.equal(res.detail, "gate_decision_store_unauthorized");
      assert.equal(res.missingGrant, grant);
      assert.match(res.error, /Missing grant: s3:PutObject on arn:aws:s3:::hub-artifacts\/pipeline-artifacts\/gate-decisions\/\* on the jira Lambda role \(TEAM-5377\)/);
      assert.ok(errors.some((l) => l.includes(grant)), "logged at error level with the grant");
      assert.equal(issues["TEAM-1108"].status, "In Review");
      assert.equal(ledgerPuts.length, 0, "the token is not spent");
      assert.equal(transitionPosts(writes).length, 0);
      assert.equal(writes.length, 0, "no comment either: the refusal leaves no trace in Jira");
      assert.ok(!objects.has(gateDecisionRecordKey(DWF, "TEAM-1108")));
      // Once the grant exists, the same token goes through.
      s3Fail.fn = null;
      assert.equal((await closeGate(mod.handler, "TEAM-1108", { decision_token: t })).status, "done");
      assert.equal(issues["TEAM-1108"].status, "Done");
    });
  } finally {
    console.error = originalError;
    restore();
  }
});

test("TEAM-5372: an existing record - same decision is reused, a different one conflicts, an older cycle is replaced, a newer one refuses gate_moved", async () => {
  const { mod, objects, s3Puts, ledgerPuts, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({
      "TEAM-1107": boundGate(), "TEAM-1108": boundGate(), "TEAM-1109": boundGate(), "TEAM-1110": boundGate(),
    }, async ({ writes, issues }) => {
      const same = await seedGateRecord(objects, "TEAM-1107");
      assert.equal((await closeGate(mod.handler, "TEAM-1107", { decision_token: tokenFor("TEAM-1107") })).status, "done");
      assert.equal(s3Puts.length, 0, "reused, not rewritten");
      assert.deepEqual(JSON.parse(objects.get(same.key)), same.record);

      const other = await seedGateRecord(objects, "TEAM-1108", { option: "reject" });
      const conflict = await closeGate(mod.handler, "TEAM-1108", { decision_token: tokenFor("TEAM-1108") });
      assert.equal(conflict.detail, "gate_decision_conflict");
      assert.equal(issues["TEAM-1108"].status, "In Review");
      assert.deepEqual(JSON.parse(objects.get(other.key)), other.record);

      // A gate never reset judges in cycle null: a record that carries a cycle is newer.
      const newer = await seedGateRecord(objects, "TEAM-1110", { cycle: new Date().toISOString() });
      const stale = await closeGate(mod.handler, "TEAM-1110", { decision_token: tokenFor("TEAM-1110") });
      assert.equal(stale.detail, "gate_moved");
      assert.deepEqual(JSON.parse(objects.get(newer.key)), newer.record);

      // A record that does not verify is replaced (IfMatch), never trusted.
      const key = gateDecisionRecordKey(DWF, "TEAM-1109");
      objects.set(key, JSON.stringify({ kind: "gate-decision", v: 3, ticketId: "TEAM-1109", decision: { option: "reject" }, sig: "forged" }));
      assert.equal((await closeGate(mod.handler, "TEAM-1109", { decision_token: tokenFor("TEAM-1109") })).status, "done");
      const replaced = JSON.parse(objects.get(key));
      assert.equal(verifyGateDecisionRecord(replaced, [DKEY]), true);
      assert.equal(replaced.decision.option, "approve");
      assert.equal(ledgerPuts.length, 2, "only the two closes that went through spent");
      assert.equal(transitionPosts(writes).length, 2);
    });
  } finally {
    restore();
  }
});

test("TEAM-5372: a held close (post-condition unmet) spends first and writes no record", async () => {
  const { mod, s3Puts, ledgerPuts, restore } = await loadDecisionGate({ probe: { ok: true, met: false, error: "InProgress", observed: { status: "InProgress" } } });
  try {
    await withDecisionJira({ "TEAM-1111": boundGate({ properties: { "agentcore-hub-post-condition": PC } }) }, async ({ issues }) => {
      const res = await closeGate(mod.handler, "TEAM-1111", { decision_token: tokenFor("TEAM-1111") });
      assert.equal(res.status, "verifying");
      assert.equal(issues["TEAM-1111"].status, "In Review");
      assert.equal(ledgerPuts.length, 1);
      assert.equal(s3Puts.length, 0);
    });
  } finally {
    restore();
  }
});

test("TEAM-5387: a failed Done POST keeps the record it claimed (never deleted, nothing reports recordOrphaned); a `same` record survives", async () => {
  const { mod, objects, s3Deletes, restore } = await loadDecisionGate();
  try {
    await withDecisionJira({ "TEAM-1112": boundGate(), "TEAM-1114": boundGate() }, async ({ issues }) => {
      const failed = await closeGate(mod.handler, "TEAM-1112", { decision_token: tokenFor("TEAM-1112") });
      assert.ok(failed.error);
      assert.equal(failed.recordOrphaned, undefined);
      assert.equal(issues["TEAM-1112"].status, "In Review");
      assert.ok(objects.has(gateDecisionRecordKey(DWF, "TEAM-1112")), "the record this close wrote stays");
      assert.deepEqual(s3Deletes, []);

      const same = await seedGateRecord(objects, "TEAM-1114");
      await closeGate(mod.handler, "TEAM-1114", { decision_token: tokenFor("TEAM-1114") });
      assert.deepEqual(JSON.parse(objects.get(same.key)), same.record, "a record that was already there stands");
    }, failDone());
  } finally {
    restore();
  }
});

test("TEAM-5372/TEAM-5387: reprobe - a record failure leaves the hold unclaimed for the next tick; a failed Done keeps the record", async () => {
  const { mod, s3Fail, ledgerPuts, objects, seq, restore } = await loadDecisionGate({ probe: { ok: true, met: true, observed: { status: "Succeeded" } } });
  try {
    await withDecisionJira({ "TEAM-1115": heldGate("TEAM-1115") }, async ({ issues }) => {
      s3Fail.fn = (cmd) => (cmd.constructor.name === "PutObjectCommand" && /\/gates\//.test(cmd.input.Key)
        ? Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } })
        : null);
      assert.deepEqual((await mod.handler({ mode: "reprobe" })).results, [{ ticketId: "TEAM-1115", outcome: "error" }]);
      assert.equal(ledgerPuts.length, 0, "the hold is not claimed");
      assert.equal(issues["TEAM-1115"].status, "In Review");
      s3Fail.fn = null;
      seq.length = 0;
      assert.deepEqual((await mod.handler({ mode: "reprobe" })).results, [{ ticketId: "TEAM-1115", outcome: "verified" }]);
      assert.deepEqual(shortSeq(seq), ["put:gates", "put:holds", "post:transitions"]);
      assert.equal(issues["TEAM-1115"].status, "Done");
    }, pushPosts(seq));

    await withDecisionJira({ "TEAM-1116": heldGate("TEAM-1116") }, async () => {
      assert.deepEqual((await mod.handler({ mode: "reprobe" })).results, [{ ticketId: "TEAM-1116", outcome: "error" }]);
      assert.ok(objects.has(gateDecisionRecordKey(DWF, "TEAM-1116")), "TEAM-5387: the record stays for the next tick to reuse");
    }, failDone());
  } finally {
    restore();
  }
});
