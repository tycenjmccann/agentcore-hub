// TEAM-5428 — the card's run facts: outcome from the workflow record, completions
// that need a completion record, interventions that are actions, and delivery
// facts that are not a score. Everything here is pure (assembleQuality,
// runOutcome, deliveryFacts, interventionDetail, computeBands) or takes an
// injected getCompletion (completionRecordSet); nothing touches AWS.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  COUNTED_INTERVENTIONS,
  KPI_CONFIG,
  assembleQuality,
  completionRecordSet,
  computeAgentTasks,
  computeBands,
  computeKpi,
  deliveryFacts,
  interventionDetail,
  isShipTicket,
  runOutcome,
} from "./index.mjs";

const RM = "agentcore_hub_release_manager";
const OP = "agentcore_hub_operator";
const DEV = "agentcore_hub_backend_dev";

/** A completed, CD-registered software-delivery row: one dev ticket, one ship ticket. */
function row(over = {}) {
  return {
    workflowId: "wf_1_test",
    phase: "complete",
    completedAt: "2026-10-01T12:00:00.000Z",
    agentTasks: {
      "T-1": { agentId: DEV, status: "complete", title: "Build", prUrl: "https://github.com/o/r/pull/11" },
      "T-2": { agentId: RM, status: "complete", title: "Ship: thing" },
    },
    ...over,
  };
}

const intervention = (action, at = "2026-10-01T10:00:00Z") =>
  ({ type: "manager.intervention", timestamp: at, detail: { action, ticketId: "T-1", comment: `${action} note` } });

// ─── AC1: outcome ─────────────────────────────────────────────────────────────

describe("runOutcome — from structured workflow-record fields only", () => {
  test("cancelled from cancelledAt alone, and from phase alone", () => {
    assert.equal(runOutcome(row({ phase: "verification", cancelledAt: "2026-10-01T12:00:00Z" })), "cancelled");
    assert.equal(runOutcome(row({ phase: "cancelled" })), "cancelled");
  });

  test("stopped: complete + completeReason + nothing merged + a ship ticket (no ledger)", () => {
    assert.equal(runOutcome(row({ completeReason: "operator close-out: review did not converge" })), "stopped");
  });

  test("stopped with a CD ledger even without a ship ticket", () => {
    const w = row({ completeReason: "closed", delivery: { mode: "cd", pipeline: "p" } });
    delete w.agentTasks["T-2"];
    assert.equal(runOutcome(w), "stopped");
  });

  test("(a) falsified: a non-complete phase is left as it is", () => {
    assert.equal(runOutcome(row({ phase: "error", completeReason: "x" })), "error");
  });

  test("(b) falsified: no completeReason (the orchestrator's own completion) is complete", () => {
    assert.equal(runOutcome(row()), "complete");
    assert.equal(runOutcome(row({ completeReason: "   " })), "complete");
  });

  test("(c) falsified: a merge commit, or a shipped ticket, is complete", () => {
    const w = row({ completeReason: "closed" });
    w.agentTasks["T-2"].mergeCommit = "abc123";
    assert.equal(runOutcome(w, { delivery: deliveryFacts(w) }), "complete");
    const s = row({ completeReason: "closed" });
    s.agentTasks["T-2"].outcome = "shipped";
    assert.equal(runOutcome(s), "complete");
  });

  test("(d) negative: a completed HANDOFF run with no merge is not stopped and not capped", () => {
    // Ledger says handoff …
    const ledger = row({ completeReason: "closed", delivery: { mode: "handoff", prUrl: "https://github.com/o/r/pull/9" } });
    assert.equal(runOutcome(ledger), "complete");
    // … or no ledger and no ship ticket on the row (cd-registry stripped the ship phase).
    const noShip = row({ completeReason: "closed" });
    delete noShip.agentTasks["T-2"];
    assert.equal(runOutcome(noShip), "complete");
    const q = assembleQuality(noShip, [], computeAgentTasks(noShip, []), { hasRecord: new Set(["T-1"]) });
    const kpi = computeKpi({ run: { outcome: q.outcome }, time: { humanGates: 0 }, quality: q.quality }, KPI_CONFIG);
    assert.deepStrictEqual(kpi.capsApplied, []);
  });

  test("operator def: its own Ship ticket counts as the ship ticket (amendment)", () => {
    const w = {
      phase: "complete", completeReason: "closed",
      agentTasks: {
        "T-1": { agentId: OP, status: "complete" },
        "T-2": { agentId: "human:engineer", status: "complete" },
        "T-3": { agentId: OP, status: "complete" },
      },
    };
    // The row stores no title for operator tickets; computeAgentTasks resolves it
    // from ticket.created, exactly as on a real operator run.
    const events = [
      { type: "ticket.created", timestamp: "t1", detail: { ticket: { id: "T-1", title: "Build: agentcore_hub_operator — x", assignee: OP } } },
      { type: "ticket.created", timestamp: "t2", detail: { ticket: { id: "T-3", title: "Ship: agentcore_hub_operator — x", assignee: OP } } },
    ];
    assert.equal(runOutcome(w, { agentTasks: computeAgentTasks(w, events) }), "stopped");
    // Without the Ship ticket the same run reads as a handoff.
    assert.equal(runOutcome(w, { agentTasks: computeAgentTasks(w, events.slice(0, 1)) }), "complete");
    // phase / label forms are accepted too; a Build ticket is not a ship ticket.
    assert.equal(isShipTicket({ agentId: OP }, { phase: "ship" }), true);
    assert.equal(isShipTicket({ agentId: OP }, { labels: ["phase:ship"] }), true);
    assert.equal(isShipTicket({ agentId: OP, title: "Build: x" }), false);
    assert.equal(isShipTicket({ agentId: DEV, title: "Ship: x" }), false);
  });

  test("ticket counts never move the outcome", () => {
    const w = row({ completeReason: "closed" });
    const base = runOutcome(w);
    for (let i = 0; i < 30; i++) w.agentTasks[`X-${i}`] = { agentId: DEV, status: "cancelled" };
    assert.equal(runOutcome(w), base);
    assert.equal(runOutcome(row()), "complete");
  });
});

describe("cancelled/stopped quality band — banded against its own population", () => {
  const summary = (i, outcome, score) => ({
    workflowId: `wf_${i}`, workflowDefId: "software-delivery", completedAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
    outcome, cost: { total: 10 }, time: {}, quality: { score },
  });
  const card = (outcome, score) => ({
    workflowId: "wf_me", workflowDefId: "software-delivery", run: { outcome, completedAt: "2026-09-30T00:00:00.000Z" },
    cost: { totalUsd: 10 }, time: {}, quality: { score }, dataQuality: {},
  });
  const baseline = [
    ...[1, 2, 3, 4, 5].map((i) => summary(i, "complete", 90)),
    ...[6, 7, 8, 9, 10].map((i) => summary(i, i % 2 ? "cancelled" : "stopped", 40)),
  ];

  test("a cancelled card's quality.score band uses only cancelled/stopped runs", () => {
    const b = computeBands(card("cancelled", 40), baseline).kpis["quality.score"];
    assert.equal(b.n, 5);
    assert.equal(b.median, 40);
    assert.equal(b.status, "ok");
  });

  test("a finished card's quality.score band never includes capped runs; other KPIs keep the full baseline", () => {
    const bands = computeBands(card("complete", 90), baseline);
    assert.equal(bands.kpis["quality.score"].n, 5);
    assert.equal(bands.kpis["quality.score"].median, 90);
    assert.equal(bands.kpis["cost.totalUsd"].n, 10);
  });
});

// ─── AC2: completion records ──────────────────────────────────────────────────

describe("completions require a completion record", () => {
  const w = {
    phase: "cancelled",
    agentTasks: {
      "A-1": { agentId: DEV, status: "complete" }, // report_completion event
      "A-2": { agentId: DEV, status: "complete" }, // S3 object only
      "A-3": { agentId: DEV, status: "complete" }, // cascade-closed, no record
      "H-1": { agentId: "human:engineer", status: "complete" }, // human gate, never counted
    },
  };
  const events = [{ type: "workflow.report_completion", timestamp: "t", detail: { ticketId: "A-1" } }];

  test("either an event or a completions/ object is a record; a cascade closure is neither", async () => {
    const tasks = computeAgentTasks(w, events);
    const ai = tasks.filter((t) => !t.agentId.startsWith("human"));
    const reads = [];
    const ids = await completionRecordSet(events, ai, async (id) => { reads.push(id); return id === "A-2" ? { ok: 1 } : null; });
    assert.deepStrictEqual([...ids].sort(), ["A-1", "A-2"]);
    assert.deepStrictEqual(reads.sort(), ["A-2", "A-3"], "only done AI tasks with no event are read from S3");

    const { quality } = assembleQuality(w, events, tasks, { hasRecord: ids });
    assert.equal(quality.tasks, 3, "tasks is unchanged: every AI ticket");
    assert.equal(quality.tasksCompleted, 2);
    assert.equal(quality.tasksClosedWithoutWork, 1, "humans are never counted here either");
    assert.equal(quality.firstPassYield, 1, "A-3 is out of both numerator and denominator");
  });

  test("a failed read is not evidence of a missing record", async () => {
    const gaps = [];
    const ids = await completionRecordSet([], [{ ticketId: "A-9", status: "complete" }], async () => { throw new Error("boom"); }, gaps);
    assert.ok(ids.has("A-9"));
    assert.equal(gaps.length, 1);
  });

  test("no records at all → firstPassYield abstains (null), not 0", () => {
    const { quality } = assembleQuality(w, [], computeAgentTasks(w, []), { hasRecord: new Set() });
    assert.equal(quality.firstPassYield, null);
    assert.equal(quality.tasksCompleted, 0);
    assert.equal(quality.tasksClosedWithoutWork, 3);
  });
});

// ─── AC3: interventions ───────────────────────────────────────────────────────

describe("interventions are actions", () => {
  test("a comment is listed with counted:false and adds nothing", () => {
    const d = interventionDetail([intervention("comment"), intervention("comment", "2026-10-01T11:00:00Z")]);
    assert.equal(d.length, 2);
    assert.ok(d.every((i) => i.counted === false && i.action === "comment" && i.note));
    const { quality } = assembleQuality(row(), [intervention("comment")], computeAgentTasks(row(), []), {});
    assert.equal(quality.interventions, 0);
    assert.equal(quality.interventionsDetail.length, 1);
  });

  test("each of the eight actions counts, in either spelling", () => {
    assert.deepStrictEqual([...COUNTED_INTERVENTIONS].sort(),
      ["cancel", "complete", "dispatch", "escalate", "file-bug", "mark-done", "retry", "unstick"]);
    for (const a of [...COUNTED_INTERVENTIONS, "mark_done", "file_bug"]) {
      assert.equal(interventionDetail([intervention(a)])[0].counted, true, a);
    }
    assert.equal(interventionDetail([intervention("mark_done")])[0].action, "mark_done", "the raw action is kept for the reader");
  });

  test("an unknown action is listed, not counted; orchestrator.escalation_decided adds nothing", () => {
    const events = [
      intervention("ponder"),
      { type: "orchestrator.escalation_decided", timestamp: "t", detail: { ticketId: "T-2" } },
      { type: "orchestrator.escalation_decided", timestamp: "t2", detail: { ticketId: "T-2" } },
    ];
    const { quality } = assembleQuality(row(), events, computeAgentTasks(row(), events), {});
    assert.equal(quality.interventions, 0);
    assert.deepStrictEqual(quality.interventionsDetail.map((i) => [i.action, i.counted]), [["ponder", false]]);
  });
});

// ─── AC4: delivery facts ──────────────────────────────────────────────────────

describe("delivery is a fact, not a score", () => {
  test("a merged CD run: mergedSha, prNumbers, deployed", () => {
    const w = row({ delivery: { mode: "cd", pipeline: "agentcore-hub-deploy" } });
    w.agentTasks["T-2"] = { ...w.agentTasks["T-2"], mergeCommit: "1087ed98", completedAt: "2026-10-01T11:00:00Z", prUrl: "https://github.com/o/r/pull/12" };
    assert.deepStrictEqual(deliveryFacts(w, [], computeAgentTasks(w, [])), { mergedSha: "1087ed98", prNumbers: [11, 12], deployed: true });
  });

  test("merged without a CD ledger is not deployed", () => {
    const w = row();
    w.agentTasks["T-2"].mergeCommit = "abc";
    assert.equal(deliveryFacts(w).deployed, false);
  });

  test("unmerged: mergedSha null, the PRs still listed (deduped, sorted)", () => {
    const w = row();
    w.agentTasks["T-3"] = { agentId: DEV, status: "complete", prUrl: "https://github.com/o/r/pull/11" };
    const events = [{ type: "workflow.complete", timestamp: "t", detail: { prUrl: "https://github.com/o/r/pull/7" } }];
    assert.deepStrictEqual(deliveryFacts(w, events, computeAgentTasks(w, events)), { mergedSha: null, prNumbers: [7, 11], deployed: false });
  });

  test("no kpi.json component reads delivery", () => {
    const sources = KPI_CONFIG.quality.components.flatMap((c) => [c.source, c.per, c.baseline, ...(c.sources || [])]).filter(Boolean);
    assert.ok(sources.length > 0);
    assert.ok(sources.every((s) => !s.startsWith("delivery")), sources.join(", "));
  });
});
