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

  const SUMMARY = "Escalation: ship-review not converging (TEAM-1)";

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    // Dedupe search — returns a prior gate with the SAME summary/labels, Done.
    if (url.includes("/rest/api/3/search/jql")) {
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
