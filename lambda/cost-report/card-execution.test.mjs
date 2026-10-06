// TEAM-5337 — buildCard executed, not pinned on its source.
//
// buildCard takes its I/O as a trailing `io` argument, so these tests run the
// whole card on a fixture event list and fake telemetry: the review.cap_resolved
// loop count (TEAM-5321 FR-7) and the DL-035 empty_sweep outcome / CI verdict on
// the two real empty-sweep rows, 33rea7 and f7jj7j.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCard, CAP_RESOLVED_EVENT, DEFAULT_PRICING, deliveryOutcomeOf, deriveCiVerdict, summarize,
} from "./index.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const readRepoJson = (rel) => JSON.parse(readFileSync(REPO + rel, "utf8"));
const CASES = readRepoJson("lambda/cost-report/fixtures/empty-sweep-cases.json").cases;
const workflowOf = (c) => (c.fixture ? readRepoJson(c.fixture) : c.workflow);

function fakeIo(events = []) {
  return {
    fetchEvents: async () => events,
    fetchCodingSessions: async () => [],
    resolveSpanLogGroups: async () => [],
    queryPersonaSpans: async () => [],
    queryClaudeCodeSpans: async () => [],
    queryCodingUsageRecords: async () => ({ rows: [] }),
  };
}
const noCompletion = async () => null;

const RUN = {
  workflowId: "wf-cap",
  phase: "complete",
  startedAt: "2026-10-01T10:00:00.000Z",
  completedAt: "2026-10-01T12:00:00.000Z",
  agentTasks: {
    "T-1": { agentId: "agentcore_hub_backend_dev", status: "complete", title: "Build it",
      startedAt: "2026-10-01T10:05:00.000Z", completedAt: "2026-10-01T10:30:00.000Z" },
    "T-2": { agentId: "agentcore_hub_code_reviewer", status: "complete", title: "Review",
      startedAt: "2026-10-01T10:31:00.000Z", completedAt: "2026-10-01T11:00:00.000Z" },
  },
};
const ev = (type, at, detail = {}) => ({ type, timestamp: at, detail: { timestamp: at, ...detail } });
const CAP_EVENTS = [
  ev("ticket.created", "2026-10-01T10:01:00.000Z", { ticket: { id: "T-1", title: "Build it", assignee: "agentcore_hub_backend_dev" } }),
  ev("review.rejected", "2026-10-01T10:40:00.000Z", { ticketId: "T-2" }),
  ev("ticket.created", "2026-10-01T10:41:00.000Z", { ticket: { id: "T-3", title: "Fix (review): null check", assignee: "agentcore_hub_backend_dev", spawnedBy: { kind: "review_fix", ticketId: "T-2" } } }),
  ev(CAP_RESOLVED_EVENT, "2026-10-01T10:50:00.000Z", { ticketId: "T-2", round: 1, residualCount: 2, verdict: "follow-ups" }),
  ev(CAP_RESOLVED_EVENT, "2026-10-01T10:55:00.000Z", { ticketId: "T-2", round: 2, residualCount: 1, verdict: "follow-ups" }),
];

test("buildCard counts each review.cap_resolved as one loop, outside changeRequests", async () => {
  const baseline = await buildCard("wf-cap", RUN, DEFAULT_PRICING, noCompletion,
    fakeIo(CAP_EVENTS.filter((e) => e.type !== CAP_RESOLVED_EVENT)));
  const card = await buildCard("wf-cap", RUN, DEFAULT_PRICING, noCompletion, fakeIo(CAP_EVENTS));
  assert.equal(card.quality.capResolved, 2);
  assert.equal(card.quality.changeRequests, 1);
  assert.equal(card.quality.changeRequests, baseline.quality.changeRequests);
  assert.equal(card.quality.fixTickets, baseline.quality.fixTickets);
  assert.equal(card.quality.loops, card.quality.changeRequests + card.quality.fixTickets + 2);
  assert.equal(card.quality.loops, baseline.quality.loops + 2);
});

test("a duplicated cap_resolved (double-published copy) counts once", async () => {
  const dup = { ...CAP_EVENTS[3], timestamp: "2026-10-01T10:50:00.004Z" };
  const card = await buildCard("wf-cap", RUN, DEFAULT_PRICING, noCompletion, fakeIo([...CAP_EVENTS, dup]));
  assert.equal(card.quality.capResolved, 2);
});

for (const id of ["33rea7", "f7jj7j"]) {
  const row = readRepoJson(`lambda/orchestrator/fixtures/workflow-${id}.json`);

  test(`${id}: the card reports outcome empty_sweep, not complete`, async () => {
    const card = await buildCard(row.workflowId || id, row, DEFAULT_PRICING, noCompletion, fakeIo());
    assert.equal(card.run.phase, "complete");
    assert.equal(card.run.outcome, "empty_sweep");
    assert.equal(card.quality.outcome, "empty_sweep");
    assert.equal(summarize(card).outcome, "empty_sweep");
  });

  test(`${id}: the RM's mergeCommit is not a CI pass`, async () => {
    const card = await buildCard(row.workflowId || id, row, DEFAULT_PRICING, noCompletion, fakeIo());
    assert.deepEqual(card.quality.ci, { verdict: "unknown", source: "empty-sweep", ticketId: null });
  });

  test(`${id} control: without the empty_sweep outcome it is a delivered run with a merge-commit pass`, async () => {
    const control = structuredClone(row);
    for (const t of Object.values(control.agentTasks)) delete t.outcome;
    const card = await buildCard(control.workflowId || id, control, DEFAULT_PRICING, noCompletion, fakeIo());
    assert.equal(card.run.outcome, "complete");
    assert.equal(card.quality.ci.verdict, "pass");
    assert.equal(card.quality.ci.source, "merge-commit");
  });
}

test("deriveCiVerdict: a certified build still passes on an empty sweep", async () => {
  const row = readRepoJson("lambda/orchestrator/fixtures/workflow-33rea7.json");
  const tasks = [{ ticketId: "TEAM-5206", agentId: "agentcore_hub_ci_agent", completedAt: "2026-09-28T12:00:00.000Z" }];
  const v = await deriveCiVerdict(row, tasks, async () => ({ ci_status: "certified" }));
  assert.equal(v.verdict, "pass");
  assert.equal(v.source, "completion:certified");
});

for (const c of CASES) {
  test(`deliveryOutcomeOf — ${c.name}`, () => {
    assert.equal(deliveryOutcomeOf(workflowOf(c)), c.expected);
  });
}
