/**
 * TEAM-5426, jira half (2/2) — what design-amendment.test.mjs cannot reach with
 * ARTIFACT_BUCKET unset:
 *
 *   - the board fixture's jira wire rows ARE this twin's real list_tickets /
 *     get_issue output over the fixture's `stored` REST rows (fails on drift, so
 *     workflow-output's tests cannot drift from what this Lambda really returns);
 *   - a security review's Done needs the record's securityReview stamp: a record
 *     alone — a FAIL one with no amendment, or one written for another agent_id —
 *     is refused;
 *   - two concurrent amendment creates both pass the pre-create scan; the
 *     post-create re-scan withdraws the NEWER one (fix:/origin: labels stripped,
 *     duplicate-of:<keeper> added, moved to Done — this workflow has no Cancelled).
 *
 * Stubbed: `fetch`, and the exported S3 client's `send`. Run by the existing
 * `node --test lambda/agentcore-hub-jira` step.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.ARTIFACT_BUCKET = "test-artifacts";
delete process.env.EVENTS_TABLE;
process.env.JIRA_BASE_URL = "https://jira.test";
process.env.JIRA_PROJECT_KEY = "TEAM";
process.env.JIRA_EMAIL = "x";
process.env.JIRA_API_TOKEN = "x";

const { handler, s3 } = await import("./index.mjs");

const BOARD = JSON.parse(readFileSync(new URL("../workflow-output/__fixtures__/design-amendment/team-5356-board.json", import.meta.url), "utf8")).jira;
const EPIC = "TEAM-5353";
const REVIEW = "TEAM-5357";
const clone = (v) => JSON.parse(JSON.stringify(v));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

/**
 * A Jira Cloud stand-in. `search()` answers each epic search (it is called again on
 * the post-create re-scan), `issue(key)` answers GET /issue/<key>.
 */
function stubJira({ search, issue, minted = "TEAM-5400", linkFails = false }) {
  const calls = { posts: [], puts: [], transitions: [], links: [], seq: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    if (u.includes("/rest/api/3/search/jql")) return json({ issues: search(calls), isLast: true });
    if (u.endsWith("/rest/api/3/issueLink") && method === "POST") {
      if (linkFails) return json({ errorMessages: ["Service Unavailable"] }, 503);
      calls.links.push(body);
      calls.seq.push(`link:${body.inwardIssue.key}->${body.outwardIssue.key}`);
      return new Response(null, { status: 201 });
    }
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      calls.posts.push(body.fields);
      return json({ key: minted }, 201);
    }
    if (u.includes("/transitions")) {
      if (method === "GET") return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
      calls.transitions.push({ url: u, body });
      calls.seq.push(`transition:${/issue\/([A-Z]+-\d+)\//.exec(u)?.[1]}`);
      return json({});
    }
    if (u.includes("/comment")) return json({ comments: [] });
    const m = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)/.exec(u);
    if (m && method === "PUT") {
      calls.puts.push({ key: m[1], body });
      return new Response(null, { status: 204 });
    }
    if (m) return json(issue(m[1]));
    return json({});
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const call = (name, parameters) => handler({ tool_name: name, parameters });

// ── 1. the fixture is this twin's real wire shape ─────────────────────────────

test("list_tickets over the stored REST rows reproduces the fixture's jira siblings", async () => {
  const jira = stubJira({ search: () => clone(BOARD.stored.rest), issue: () => clone(BOARD.stored.restIssue) });
  try {
    const res = await call("Tickets___list_tickets", { parent_id: EPIC });
    assert.deepEqual(res.tickets, BOARD.siblings);
  } finally { jira.restore(); }
});

test("get_issue over the stored REST issue reproduces the fixture's jira issue", async () => {
  const jira = stubJira({ search: () => [], issue: () => clone(BOARD.stored.restIssue) });
  try {
    const res = await call("Tickets___get_issue", { ticket_id: REVIEW });
    assert.deepEqual(res, BOARD.issue);
  } finally { jira.restore(); }
});

test("the stored amendment serializes to the fixture's jira amendment", async () => {
  const jira = stubJira({ search: () => [...clone(BOARD.stored.rest), clone(BOARD.stored.amendment)], issue: () => ({}) });
  try {
    const res = await call("Tickets___list_tickets", { parent_id: EPIC });
    assert.deepEqual(res.tickets.at(-1), BOARD.amendment);
  } finally { jira.restore(); }
});

// ── 2. the Done guard reads the securityReview stamp ──────────────────────────

async function doneWithRecord(record) {
  const originalSend = s3.send;
  s3.send = async () => ({ Body: { transformToString: async () => JSON.stringify(record) } });
  const jira = stubJira({ search: () => [], issue: () => clone(BOARD.stored.restIssue) });
  try {
    const res = await call("Tickets___transition_ticket", { ticket_id: REVIEW, transition_id: "done" });
    return { res, transitions: jira.calls.transitions.length };
  } finally {
    jira.restore();
    s3.send = originalSend;
  }
}
const record = (extra) => ({ ticketId: REVIEW, agentId: "agentcore_hub_security_reviewer", summary: "Verdict: FAIL", status: "complete", completedAt: "2026-10-06T20:40:00Z", ...extra });

test("a FAIL record with no amendment is refused (the review's repro)", async () => {
  const { res, transitions } = await doneWithRecord(record({ securityReview: { verdict: "FAIL" } }));
  assert.equal(res.reason, "completion_record_required");
  assert.match(res.error, /no done design amendment/);
  assert.equal(transitions, 0);
});

test("a record with no securityReview stamp is refused", async () => {
  const { res, transitions } = await doneWithRecord(record({ agentId: "agentcore_hub_backend_dev" }));
  assert.equal(res.reason, "completion_record_required");
  assert.match(res.error, /carries no securityReview verdict/);
  assert.equal(transitions, 0);
});

test("a PASS stamp, or a non-PASS stamp naming its amendment, reaches Done", async () => {
  for (const securityReview of [{ verdict: "PASS" }, { verdict: "FAIL", amendmentTicketId: "TEAM-5399" }]) {
    const { res, transitions } = await doneWithRecord(record({ securityReview }));
    assert.equal(res.error, undefined, res.error);
    assert.equal(transitions, 1);
  }
});

// ── 3. two concurrent creates: the newer one withdraws ────────────────────────

const amend = () => call("Tickets___create_ticket", {
  summary: "Amend design: address security review TEAM-5357 findings",
  description: "1 Critical, 4 High - see shared/security-review.md",
  issue_type: "Task",
  parent_key: EPIC,
  assignee: "agentcore_hub_backend_designer",
  workflow_id: "wf_1791311636588_rfq233",
  spawned_by: { kind: "review_fix", gateTicketId: REVIEW },
  phase: "design",
});
/** The racer is visible only once our POST has landed — i.e. on the re-scan. */
const racing = (racerKey) => (calls) => [
  ...clone(BOARD.stored.rest),
  ...(calls.posts.length ? [{ ...clone(BOARD.stored.amendment), key: racerKey }] : []),
];
const mintedIssue = (key) => (key === "TEAM-5400" ? { key, fields: { labels: clone(BOARD.stored.amendment.fields.labels), description: null } } : clone(BOARD.stored.restIssue));

test("the newer of two concurrent amendments is withdrawn, naming the keeper", async () => {
  const jira = stubJira({ search: racing("TEAM-5399"), issue: mintedIssue, minted: "TEAM-5400" });
  try {
    const res = await amend();
    assert.equal(res.reason, "design_amendment_exhausted");
    assert.equal(res.existingTicketId, "TEAM-5399");
    assert.equal(res.withdrawnTicketId, "TEAM-5400");
    assert.match(res.error, /ONE amendment turn/);
    const relabel = jira.calls.puts.find((p) => p.key === "TEAM-5400" && p.body?.update?.labels);
    assert.ok(relabel, "the loser is relabelled");
    // Every fix:/origin: label it was created with (origin: only under FIX_TICKET_CONTRACT).
    const created = jira.calls.posts[0].labels.filter((l) => /^(fix|origin):/.test(l));
    assert.ok(created.includes("fix:review_fix"));
    assert.deepEqual(relabel.body.update.labels, [...created.map((remove) => ({ remove })), { add: "duplicate-of:team-5399" }]);
    assert.ok(jira.calls.transitions.some((t) => t.url.includes("/issue/TEAM-5400/")), "the loser is moved to Done");
  } finally { jira.restore(); }
});

/** As `racing`, plus the review parked behind the loser — visible on the re-scan. */
const racingWithDependent = (racerKey, loser) => (calls) => racing(racerKey)(calls).map((row) => (
  calls.posts.length && row.key === REVIEW
    ? { ...row, fields: { ...row.fields, issuelinks: [...row.fields.issuelinks, { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: loser } }] } }
    : row));

test("a review parked behind the loser is linked to the keeper BEFORE the loser goes Done", async () => {
  const jira = stubJira({ search: racingWithDependent("TEAM-5399", "TEAM-5400"), issue: mintedIssue, minted: "TEAM-5400" });
  try {
    const res = await amend();
    assert.equal(res.reason, "design_amendment_exhausted");
    assert.deepEqual(jira.calls.seq, ["link:TEAM-5399->TEAM-5357", "transition:TEAM-5400"]);
  } finally { jira.restore(); }
});

test("a failed re-link aborts the withdrawal: the loser is kept open, never Done", async () => {
  const jira = stubJira({ search: racingWithDependent("TEAM-5399", "TEAM-5400"), issue: mintedIssue, minted: "TEAM-5400", linkFails: true });
  try {
    const res = await amend();
    assert.equal(res.error, undefined, res.error);
    assert.equal(jira.calls.transitions.length, 0);
    assert.equal(jira.calls.puts.filter((p) => p.body?.update?.labels).length, 0);
  } finally { jira.restore(); }
});

test("the older of two concurrent amendments keeps the slot", async () => {
  const jira = stubJira({ search: racing("TEAM-5401"), issue: mintedIssue, minted: "TEAM-5400" });
  try {
    const res = await amend();
    assert.equal(res.error, undefined, res.error);
    assert.equal(jira.calls.puts.filter((p) => p.body?.update?.labels).length, 0);
    assert.equal(jira.calls.transitions.length, 0);
  } finally { jira.restore(); }
});
