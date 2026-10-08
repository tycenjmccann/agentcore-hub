/**
 * TEAM-5426 replay, jira half — rfq233's security review TEAM-5357 went Done on
 * "Changes needed" and released the dev lanes. The tickets twin's half lives in
 * lambda/agentcore-hub-tickets/replay-design-amendment.test.mjs; this file proves
 * the same two guards read Jira's label idiom (`fix:` / `phase:` / `origin:` /
 * `agent:`):
 *
 *   - ONE "Amend design" ticket per review: the second is refused
 *     design_amendment_exhausted before anything is POSTed, and an unreadable
 *     epic refuses too.
 *   - a security-review ticket cannot reach Done without its completion record.
 *
 * Only `fetch` is stubbed, and it serves the board fixture's `stored` REST rows —
 * the ones design-amendment-shapes.test.mjs proves serialize to the wire rows
 * workflow-output's tests consume. ARTIFACT_BUCKET is unset, so the completion
 * record is unreadable by construction — exactly the "no record" case (the
 * record-content cases live in design-amendment-shapes.test.mjs).
 *
 * Run by the existing `node --test lambda/agentcore-hub-jira` step.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

delete process.env.ARTIFACT_BUCKET;
delete process.env.EVENTS_TABLE;
process.env.JIRA_PROJECT_KEY = "TEAM";

const { handler } = await import("./index.mjs");

const STORED = JSON.parse(readFileSync(new URL("../workflow-output/__fixtures__/design-amendment/team-5356-board.json", import.meta.url), "utf8")).jira.stored;
const EPIC = "TEAM-5353";
const REVIEW = "TEAM-5357";
const MINTED = "TEAM-5400";

const BOARD = JSON.parse(JSON.stringify(STORED.rest));
/** The fixture's amendment row, re-keyed, with its origin label swapped or dropped. */
const PRIOR = (origin = REVIEW, status = "In Progress") => {
  const row = JSON.parse(JSON.stringify(STORED.amendment));
  const labels = row.fields.labels.filter((l) => !l.startsWith("origin:"));
  return { ...row, key: "TEAM-5361", fields: { ...row.fields, status: { name: status }, labels: [...labels, ...(origin ? [`origin:${origin.toLowerCase()}`] : [])] } };
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

function stubJira({ siblings = BOARD, searchFails = false, issueLabels = [] } = {}) {
  const calls = { posts: [], transitions: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes("/rest/api/3/search/jql")) {
      const jql = decodeURIComponent(new URL(url, "https://jira.test").searchParams.get("jql") || "");
      if (!jql.startsWith(`parent = ${EPIC}`)) return json({ issues: [] });
      if (searchFails) return json({ errorMessages: ["Service Unavailable"] }, 503);
      return json({ issues: siblings });
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      calls.posts.push(body.fields);
      return json({ key: MINTED }, 201);
    }
    if (url.includes("/transitions")) {
      if (method === "GET") return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
      calls.transitions.push(body);
      return json({});
    }
    if (url.includes(`/rest/api/3/issue/`) && method === "GET") {
      return json({ fields: { labels: issueLabels, description: null } });
    }
    return json({});
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const amend = () => handler({
  tool_name: "Tickets___create_ticket",
  parameters: {
    summary: "Amend design: address security review TEAM-5357 findings",
    description: "1 Critical, 4 High - see shared/security-review.md",
    issue_type: "Task",
    parent_key: EPIC,
    assignee: "agentcore_hub_backend_designer",
    workflow_id: "wf_1791311636588_rfq233",
    spawned_by: { kind: "review_fix", gateTicketId: REVIEW },
    phase: "design",
  },
});

test("the first design amendment is created", async () => {
  const jira = stubJira();
  try {
    const res = await amend();
    assert.equal(res.error, undefined, res.error);
    assert.equal(jira.calls.posts.length, 1);
    assert.ok(jira.calls.posts[0].labels.includes("fix:review_fix"));
    assert.ok(jira.calls.posts[0].labels.includes("phase:design"));
  } finally { jira.restore(); }
});

test("a second design amendment for the same review is refused before anything is POSTed", async () => {
  const jira = stubJira({ siblings: [...BOARD, PRIOR()] });
  try {
    const res = await amend();
    assert.equal(res.ok, false);
    assert.equal(res.reason, "design_amendment_exhausted");
    assert.equal(res.existingTicketId, "TEAM-5361");
    assert.match(res.error, /ONE amendment turn/);
    assert.equal(jira.calls.posts.length, 0);
  } finally { jira.restore(); }
});

test("with no origin label (FIX_TICKET_CONTRACT off) the epic is the scope", async () => {
  const jira = stubJira({ siblings: [...BOARD, PRIOR(null)] });
  try {
    const res = await amend();
    assert.equal(res.reason, "design_amendment_exhausted");
    assert.equal(jira.calls.posts.length, 0);
  } finally { jira.restore(); }
});

test("a cancelled prior or another review's amendment does not use the slot", async () => {
  for (const prior of [PRIOR(REVIEW, "Cancelled"), PRIOR("TEAM-5398")]) {
    const jira = stubJira({ siblings: [...BOARD, prior] });
    try {
      const res = await amend();
      assert.equal(res.error, undefined, res.error);
      assert.equal(jira.calls.posts.length, 1);
    } finally { jira.restore(); }
  }
});

test("an unreadable epic refuses the create (fail closed)", async () => {
  const jira = stubJira({ searchFails: true });
  try {
    const res = await amend();
    assert.ok(res.error, "a refusal");
    assert.equal(jira.calls.posts.length, 0);
  } finally { jira.restore(); }
});

test("a security-review ticket cannot reach Done without its completion record", async () => {
  const jira = stubJira({ issueLabels: ["agent:agentcore_hub_security_reviewer", "phase:design"] });
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: REVIEW, transition_id: "done" },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "completion_record_required");
    assert.match(res.error, /a security-review ticket/);
    assert.equal(jira.calls.transitions.length, 0);
  } finally { jira.restore(); }
});

test("another agent's ticket still reaches Done", async () => {
  const jira = stubJira({ issueLabels: ["agent:agentcore_hub_backend_designer", "phase:design"] });
  try {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-5356", transition_id: "done" },
    });
    assert.equal(res.error, undefined, res.error);
    assert.equal(jira.calls.transitions.length, 1);
  } finally { jira.restore(); }
});
