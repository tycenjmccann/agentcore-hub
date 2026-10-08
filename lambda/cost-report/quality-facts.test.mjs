// TEAM-5428 — the card's run facts: outcome from the workflow record, completions
// that need a completion record, interventions that are actions, and delivery
// facts that are not a score. Everything here is pure (assembleQuality,
// runOutcome, deliveryFacts, interventionDetail, computeBands) or takes an
// injected getCompletion (completionRecords); nothing touches AWS.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CD_LEDGER_ABSENT,
  CD_LEDGER_INDETERMINATE,
  CD_LEDGER_PRESENT,
  COUNTED_INTERVENTIONS,
  KPI_CONFIG,
  assembleQuality,
  completionRecords,
  computeAgentTasks,
  computeBands,
  computeKpi,
  deliveryFacts,
  deriveCiVerdict,
  interventionDetail,
  isShipTicket,
  mergeEvidence,
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

const UNFINISHED = new Set(["cancelled", "stopped"]);

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
    assert.equal(runOutcome(w), "complete");
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
    const q = assembleQuality(noShip, [], computeAgentTasks(noShip, []), { records: { recorded: new Set(["T-1"]) } });
    const kpi = computeKpi({ run: { outcome: q.outcome }, time: { humanGates: 0 }, quality: q.quality }, KPI_CONFIG);
    assert.deepStrictEqual(kpi.capsApplied, []);
  });

  test("(d) a CD-mode run the orchestrator recorded as a handoff is not stopped (review #1)", () => {
    // deliveryRollUp's own handoff values (lambda/orchestrator/completion.mjs:665) …
    for (const outcome of ["complete-with-handoff", "complete:handoff:static-only"]) {
      const w = row({ completeReason: "closed", delivery: { mode: "cd", pipeline: "p", outcome, prState: "open" } });
      assert.equal(runOutcome(w), "complete", outcome);
    }
    // … and a ship task whose own verdict is handoff, with no ledger outcome at all.
    const w = row({ completeReason: "closed", delivery: { mode: "cd", pipeline: "p" } });
    w.agentTasks["T-2"].outcome = "handoff";
    assert.equal(runOutcome(w), "complete");
    assert.equal(mergeEvidence(w).merged, false, "a handoff is never a merge");
  });

  test("(c) merge evidence on the delivery ledger or a ship record, not just the row (review #2)", () => {
    // ledger prState "merged" (deliveryRollUp, completion.mjs:660) with a trimmed row
    const ledger = row({ completeReason: "closed", delivery: { mode: "cd", pipeline: "p", prState: "merged" } });
    assert.equal(runOutcome(ledger), "complete");
    assert.equal(mergeEvidence(ledger).merged, true);
    // a ship completion record's merge_commit, row lacks merge fields
    const rec = row({ completeReason: "closed" });
    const completions = new Map([["T-2", { outcome: "shipped", merge_commit: "abc123" }]]);
    assert.equal(runOutcome(rec, { completions }), "complete");
    assert.equal(deliveryFacts(rec, [], [], { completions }).mergedSha, "abc123");
    // empty_sweep is a shipped run (shipVerdictOf) — not stopped, but not a merge
    const sweep = row({ completeReason: "closed" });
    sweep.agentTasks["T-2"].outcome = "empty_sweep";
    assert.equal(runOutcome(sweep), "complete");
    assert.equal(mergeEvidence(sweep).merged, false);
  });

  test("CI verdict reads the same merge evidence (review #2 sibling)", async () => {
    const w = row({ delivery: { mode: "cd", pipeline: "p", prState: "merged" } });
    const ci = await deriveCiVerdict(w, computeAgentTasks(w, []), async () => null, []);
    assert.deepStrictEqual(ci, { verdict: "pass", source: "merge-commit", ticketId: null });
  });

  test("CI verdict sees a merge recorded only on the ship ticket's completion record (round 2 #1)", async () => {
    const w = row({ completeReason: "closed" });
    const tasks = computeAgentTasks(w, []);
    const get = async (id) => (id === "T-2" ? { outcome: "shipped", merge_commit: "abc1234" } : null);
    const records = await completionRecords([], tasks, get, [], { workflow: w });
    const ci = await deriveCiVerdict(w, tasks, get, [], { completions: records.objects });
    assert.deepStrictEqual(ci, { verdict: "pass", source: "merge-commit", ticketId: null });
    const { outcome, delivery } = assembleQuality(w, [], tasks, { records, ci });
    assert.equal(outcome, "complete");
    assert.equal(delivery.mergedSha, "abc1234");
  });

  test("a non-ship ticket's merge_commit is not a merge; a ship record must say shipped (round 2 #2)", async () => {
    // done build ticket's record carries merge_commit, ship ticket has no verdict
    const w = row({ completeReason: "operator close-out" });
    const tasks = computeAgentTasks(w, []);
    const completions = new Map([["T-1", { outcome: "shipped", merge_commit: "b1d0000" }], ["T-2", {}]]);
    assert.equal(runOutcome(w, { agentTasks: tasks, completions }), "stopped");
    assert.equal(deliveryFacts(w, [], tasks, { completions }).mergedSha, null);
    const ci = await deriveCiVerdict(w, tasks, async () => null, [], { completions });
    assert.equal(ci.source, "none");
    // the same on the row: the orchestrator's harvest copies merge_commit onto any ticket
    const r = row({ completeReason: "operator close-out" });
    r.agentTasks["T-1"].mergeCommit = "b1d0000";
    r.agentTasks["T-1"].outcome = "shipped";
    assert.equal(runOutcome(r), "stopped");
    assert.equal(mergeEvidence(r).mergedSha, null);
    // a ship record with a merge_commit but no "shipped" outcome proves nothing
    const blocked = new Map([["T-2", { outcome: "blocked", merge_commit: "abc1234" }]]);
    assert.equal(runOutcome(w, { agentTasks: tasks, completions: blocked }), "stopped");
    assert.equal(mergeEvidence(w, { agentTasks: tasks, completions: blocked }).mergedSha, null);
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

  test("a finished card's quality.score band never includes capped runs; cost KPIs keep the full baseline", () => {
    const bands = computeBands(card("complete", 90), baseline);
    assert.equal(bands.kpis["quality.score"].n, 5);
    assert.equal(bands.kpis["quality.score"].median, 90);
    assert.equal(bands.kpis["cost.totalUsd"].n, 10);
  });

  test("every quality.* band is split by population, not just the score (review #4)", () => {
    const withFpy = baseline.map((s) => ({ ...s, quality: { ...s.quality, firstPassYield: UNFINISHED.has(s.outcome) ? 0.2 : 0.95 } }));
    const c = { ...card("cancelled", 40), quality: { score: 40, firstPassYield: 0.2 } };
    const bands = computeBands(c, withFpy);
    for (const [path, b] of Object.entries(bands.kpis).filter(([p]) => p.startsWith("quality."))) {
      if (b.n != null) assert.equal(b.n, 5, path);
    }
    assert.equal(bands.kpis["quality.firstPassYield"].median, 0.2);
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
    const records = await completionRecords(events, ai, async (id) => { reads.push(id); return id === "A-2" ? { ok: 1 } : null; });
    assert.deepStrictEqual([...records.recorded].sort(), ["A-1", "A-2"]);
    assert.deepStrictEqual(reads.sort(), ["A-2", "A-3"], "only done AI tasks with no event are read from S3");

    const { quality } = assembleQuality(w, events, tasks, { records });
    assert.equal(quality.tasks, 3, "tasks is unchanged: every AI ticket");
    assert.equal(quality.tasksCompleted, 2);
    assert.equal(quality.tasksClosedWithoutWork, 1, "humans are never counted here either");
    assert.equal(quality.firstPassYield, 1, "A-3 is out of both numerator and denominator");
  });

  test("a denied/failed read proves nothing either way: out of all three counts, counted as unreadable (review #5)", async () => {
    const solo = { phase: "complete", agentTasks: { "A-9": { agentId: DEV, status: "complete" } } };
    const tasks = computeAgentTasks(solo, []);
    const gaps = [];
    const denied = Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    const records = await completionRecords([], tasks, async () => { throw denied; }, gaps);
    assert.equal(records.recorded.has("A-9"), false);
    assert.ok(records.unreadable.has("A-9"));
    assert.equal(gaps.length, 1);
    const { quality } = assembleQuality(solo, [], tasks, { records });
    assert.equal(quality.tasksCompleted, 0);
    assert.equal(quality.tasksClosedWithoutWork, 0);
    assert.equal(quality.tasksRecordUnreadable, 1);
    assert.equal(quality.firstPassYield, null, "not 1 — nothing provable is in the denominator");
  });

  test("a read failure on a ticket the event already proves changes nothing", async () => {
    const events = [{ type: "workflow.report_completion", timestamp: "t", detail: { ticketId: "S-1" } }];
    const records = await completionRecords(events, [{ ticketId: "S-1", agentId: RM, status: "complete" }],
      async () => { throw new Error("boom"); }, []);
    assert.ok(records.recorded.has("S-1"));
    assert.equal(records.unreadable.size, 0);
  });

  test("completion reads are bounded per card (P3)", async () => {
    let inFlight = 0, peak = 0;
    const many = Array.from({ length: 40 }, (_, i) => ({ ticketId: `A-${i}`, agentId: DEV, status: "complete" }));
    await completionRecords([], many, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--; return {};
    }, []);
    assert.ok(peak <= 8, `peak ${peak}`);
  });

  test("no records at all → firstPassYield abstains (null), not 0", () => {
    const { quality } = assembleQuality(w, [], computeAgentTasks(w, []), { records: { recorded: new Set() } });
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
  const EXEC = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

  // Mirrors workflow-output's ship contract (lambda/workflow-output/index.mjs:539).
  const shipped = (rec, cdLedger) => {
    const w = row({ delivery: { mode: "cd", pipeline: "agentcore-hub-deploy" } });
    w.agentTasks["T-2"] = { ...w.agentTasks["T-2"], mergeCommit: "1087ed98", completedAt: "2026-10-01T11:00:00Z", prUrl: "https://github.com/o/r/pull/12" };
    return deliveryFacts(w, [], computeAgentTasks(w, []), { completions: new Map(rec ? [["T-2", rec]] : []), cdLedger });
  };

  test("pipeline path: shipped + merge_commit + pipeline_execution_id → deployed", () => {
    const rec = { outcome: "shipped", merge_commit: "1087ed98", pipeline_name: "agentcore-hub-deploy", pipeline_execution_id: EXEC };
    for (const ledger of [CD_LEDGER_PRESENT, CD_LEDGER_ABSENT, CD_LEDGER_INDETERMINATE]) {
      assert.deepStrictEqual(shipped(rec, ledger), { mergedSha: "1087ed98", prNumbers: [11, 12], deployed: true }, ledger);
    }
  });

  test("pipeline path without an execution id → not deployed (review #3)", () => {
    assert.equal(shipped({ outcome: "shipped", merge_commit: "1087ed98", pipeline_name: "agentcore-hub-deploy" }, CD_LEDGER_ABSENT).deployed, false,
      "pipeline_name on the record means the pipeline path");
    assert.equal(shipped({ outcome: "shipped", merge_commit: "1087ed98" }, CD_LEDGER_PRESENT).deployed, false,
      "a cd-ledger means the pipeline path");
  });

  test("legacy DEPLOY.md path: shipped + merge_commit, no pipeline_name, cd-ledger definitely absent → deployed", () => {
    assert.equal(shipped({ outcome: "shipped", merge_commit: "1087ed98" }, CD_LEDGER_ABSENT).deployed, true);
    assert.equal(shipped({ outcome: "shipped", merge_commit: "1087ed98" }, CD_LEDGER_INDETERMINATE).deployed, false,
      "an unreadable ledger is not proof of absence");
  });

  test("no shipped ship record → not deployed", () => {
    assert.equal(shipped(null, CD_LEDGER_ABSENT).deployed, false, "no completion record at all");
    assert.equal(shipped({ outcome: "blocked", merge_commit: "1087ed98", pipeline_execution_id: EXEC }, CD_LEDGER_ABSENT).deployed, false);
    assert.equal(shipped({ outcome: "shipped", pipeline_execution_id: EXEC }, CD_LEDGER_ABSENT).deployed, false, "no merge_commit");
    const w = row();
    const offShip = new Map([["T-1", { outcome: "shipped", merge_commit: "1087ed98", pipeline_execution_id: EXEC }]]);
    assert.equal(deliveryFacts(w, [], computeAgentTasks(w, []), { completions: offShip, cdLedger: CD_LEDGER_ABSENT }).deployed, false,
      "only a ship ticket's record counts");
  });

  test("a merge on the row with no shipped record is not deployed", () => {
    const w = row();
    w.agentTasks["T-2"].mergeCommit = "abc";
    assert.equal(deliveryFacts(w, [], [], { cdLedger: CD_LEDGER_ABSENT }).deployed, false);
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
