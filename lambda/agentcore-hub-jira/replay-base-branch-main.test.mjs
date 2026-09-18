/**
 * TEAM-4663 replay, jira half — `base_branch: main` through the create seam.
 *
 * The tickets twin's half of this replay (and the chain that follows it into
 * workflow-output's `main_fix_requires_pr` refusal) lives in
 * lambda/agentcore-hub-tickets/replay-base-branch-main.test.mjs. Both files replace
 * a fixture in lambda/orchestrator/replay-head-of-line.test.mjs that declared the
 * release manager's create_ticket payload as a literal and then asserted its own
 * fields back — true for every possible state of the code under test.
 *
 * What this file owns is the part only this provider can answer: the branch and the
 * freeze banner have to survive Jira's ADF description, because `adfToText` is the
 * only thing downstream (and the only thing the FR-5 regex) ever sees. A banner and
 * a `base_branch:` line packed into ONE paragraph would flatten into one line and
 * `BASE_BRANCH_LINE_RE` would never match it, so the block structure is the
 * contract, not an implementation detail.
 *
 * Only `fetch` is stubbed (restored in a `finally`, as index.test.mjs does); the
 * module under test runs as shipped. EVENTS_TABLE is deliberately left unset so the
 * autowire audit stays dark — this Lambda's deploy env does not set it either, and
 * there is no DynamoDB double here.
 *
 * Run by the existing `node --test lambda/agentcore-hub-jira` step (ci.yml,
 * buildspec-ci.yml); no vitest entry needed.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Env before the import: ARTIFACT_BUCKET unset keeps the roster on its in-module
// fallback (no S3 call from a unit test), and the module reads both at load.
delete process.env.ARTIFACT_BUCKET;
delete process.env.EVENTS_TABLE;
process.env.JIRA_PROJECT_KEY = "TEAM";

const { handler, adfToText, baseBranchLine, baseBranchRefusal } = await import("./index.mjs");

const EPIC = "TEAM-4734";
const CD = "TEAM-4703";       // the release manager's CD ticket
const GATE = "TEAM-4705";     // the open human Merge Approval gate
const MINTED = "TEAM-4763";
const WF = "p5ogpg";
const FIX_BODY = "The FR-5 base-branch check must fire at the create seam, not at review time.";

/** The epic's children as they stood while the merge gate was open. */
const SIBLINGS = [
  {
    key: CD,
    fields: {
      summary: "CD: merge and deploy the TEAM-4734 epic",
      status: { name: "In Progress" },
      labels: ["agent:agentcore_hub_release_manager", "phase:ship"],
      created: "2026-09-10T10:00:00Z",
    },
  },
  {
    key: GATE,
    fields: {
      summary: "Merge Approval: TEAM-4734",
      status: { name: "In Review" },
      labels: ["human-review", "reviewer:tycen"],
      created: "2026-09-10T11:00:00Z",
    },
  },
];

/**
 * A Jira double that records what was sent. Both the sibling scan and the
 * idempotency dedupe hit /search/jql, so they are told apart by their JQL — the
 * scan is `parent = <epic> ORDER BY created ASC`.
 */
function stubJira({ siblings = SIBLINGS } = {}) {
  const calls = { posts: [], transitions: [], links: [], searches: [] };
  let createdFields = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.includes("/rest/api/3/search/jql")) {
      const jql = decodeURIComponent(new URL(url, "https://jira.test").searchParams.get("jql") || "");
      calls.searches.push(jql);
      if (!jql.startsWith(`parent = ${EPIC}`)) return json({ issues: [] });
      return json({ issues: siblings });
    }
    if (url.endsWith("/rest/api/3/issue") && method === "POST") {
      createdFields = body.fields;
      calls.posts.push(body.fields);
      return json({ key: MINTED }, 201);
    }
    if (url.includes("/rest/api/3/issueLink")) {
      calls.links.push(body);
      return json({});
    }
    if (url.includes("/transitions")) {
      if (method === "GET") {
        return json({ transitions: [{ id: "41", name: "Blocked", to: { name: "Blocked" } }] });
      }
      calls.transitions.push(body);
      return json({});
    }
    return json({});
  };
  return { calls, fields: () => createdFields, restore: () => { globalThis.fetch = originalFetch; } };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

/** The create the release manager made, as it was actually made: no blockers named. */
const filedFix = (extra = {}) => handler({
  tool_name: "Tickets___create_ticket",
  parameters: {
    summary: "Fix: deliver the FR-5 base-branch check to main",
    description: FIX_BODY,
    issue_type: "Task",
    parent_key: EPIC,
    assignee: "agentcore_hub_api_dev",
    workflow_id: WF,
    phase: "ship",
    base_branch: "main",
    ...extra,
  },
});

/** The stored description as LINES — what every downstream reader actually gets. */
const lines = (adf) => adfToText(adf).split(/\n+/).filter((l) => l.length > 0);

test("base_branch: main is recorded and stated as its OWN ADF block, after the banner and the prose", async () => {
  const jira = stubJira();
  try {
    const res = await filedFix();

    // The response mirrors the branch under its wire name — this object is what an
    // agent copies from.
    assert.equal(res.base_branch, "main");
    assert.equal(res.ticketId, MINTED);

    // Three separate block nodes, in delivery order. adfToText joins block nodes
    // with "\n", so this structure is exactly what makes BASE_BRANCH_LINE_RE (a
    // multiline, line-anchored pattern) able to find the branch at all.
    const content = jira.fields().description.content;
    assert.equal(content.length, 3);
    assert.deepEqual(content.map((b) => b.type), ["paragraph", "paragraph", "paragraph"]);
    const flat = lines(jira.fields().description);
    assert.equal(flat.length, 3);
    assert.equal(flat[1], FIX_BODY);
    assert.equal(flat[2], baseBranchLine("main"));
    // The banner leads and names the CD ticket the work is frozen behind. Its prose
    // is byte-compared against the tickets twin's in the sibling replay, so nothing
    // here writes it down.
    assert.ok(flat[0].includes(CD), `banner should name ${CD}: ${flat[0]}`);
  } finally {
    jira.restore();
  }
});

test("no blocker named ⇒ frozen behind the CD ticket: one link, one Blocked transition, autowired marker", async () => {
  const jira = stubJira();
  try {
    const res = await filedFix();

    assert.equal(res.status, "blocked");
    assert.deepEqual(res.autowired, { reason: "open_gate", blockedBy: [CD], gateTicketId: GATE });
    // Exactly one blocker edge, pointing the right way (blocker → ticket).
    assert.equal(jira.calls.links.length, 1);
    assert.equal(jira.calls.links[0].inwardIssue.key, CD);
    assert.equal(jira.calls.links[0].outwardIssue.key, MINTED);
    assert.equal(jira.calls.transitions.length, 1);
    assert.equal(jira.calls.transitions[0].transition.id, "41");
    // One sibling scan, not one per predicate.
    assert.equal(jira.calls.searches.filter((q) => q.startsWith(`parent = ${EPIC}`)).length, 1);
  } finally {
    jira.restore();
  }
});

test("a caller that already named the CD ticket gets no banner — the base_branch line stays", async () => {
  const jira = stubJira();
  try {
    const res = await filedFix({ blocked_by: [CD] });

    assert.equal(res.autowired, undefined);
    assert.equal(res.base_branch, "main");
    // Prose then branch line, and nothing else.
    assert.deepEqual(lines(jira.fields().description), [FIX_BODY, baseBranchLine("main")]);
  } finally {
    jira.restore();
  }
});

test("a base_branch the regex refuses reaches Jira not at all", async () => {
  const jira = stubJira();
  try {
    const res = await filedFix({ base_branch: "main; rm -rf /" });

    // The refusal body is the agent's only instruction for how to retry, so it is
    // the shipped one verbatim — and byte-compared against the tickets twin's by
    // src/lib/workflow/base-branch-parity.test.ts.
    assert.equal(res.error, baseBranchRefusal("main; rm -rf /"));
    assert.equal(res.ticketId, undefined);
    // Refused before the sibling scan and before the create POST: nothing was
    // created, and nothing was even looked up.
    assert.equal(jira.calls.posts.length, 0);
    assert.equal(jira.calls.searches.length, 0);
  } finally {
    jira.restore();
  }
});

test("no base_branch stated ⇒ no line, no response key (a pre-feature create is unchanged)", async () => {
  const jira = stubJira({ siblings: [] });
  try {
    const res = await filedFix({ base_branch: undefined });

    assert.equal(res.base_branch, undefined);
    assert.equal(res.autowired, undefined);   // no gate among the siblings
    assert.deepEqual(lines(jira.fields().description), [FIX_BODY]);
  } finally {
    jira.restore();
  }
});
