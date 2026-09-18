/**
 * kpiVersion 2 — re-invocation classification.
 *
 * Since DL-024 an agent parks its ticket `blocked_by` something and is re-invoked
 * when that closes, so "invoked twice" no longer means "sent back". These tests
 * pin what each re-invocation is called and which kinds count as rework, using
 * the shape of a real run (wf_bug_TEAM-4711: code review r1→r4, a CI restart, a
 * QA human gate, a ship-review fix, two CI re-certs).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  REINVOCATION_KINDS, REWORK_KINDS, classifyReinvocation, computeAgentTasks,
  reinvocationTotals, interventionDetail,
} from "./index.mjs";

const T0 = Date.parse("2026-09-17T02:00:00.000Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const ev = (min, type, detail = {}) => ({ eventId: `${min}-${type}`, timestamp: at(min), type, detail });

const HUMAN = "human:engineer";
const REVIEWER = "agentcore_hub_code_reviewer";
const FIXER = "agentcore_hub_bug_fixer";
const CI = "agentcore_hub_ci_agent";
const QA = "agentcore_hub_qa_verifier";
const RM = "agentcore_hub_release_manager";
const ANALYST = "agentcore_hub_requirements_analyst";

/** The 4711-shaped run: one row per ticket the orchestrator tracked. */
function workflow() {
  return {
    id: "wf_test", agentTasks: {
      "T-1": { agentId: ANALYST, status: "complete", startedAt: at(0), completedAt: at(5), createdAt: at(0) },
      "T-2": { agentId: FIXER, status: "complete", startedAt: at(5), completedAt: at(40), createdAt: at(0), title: "Fix: stream drops mid-turn" },
      "T-3": { agentId: REVIEWER, status: "complete", startedAt: at(40), completedAt: at(300), createdAt: at(0) },
      "T-4": { agentId: FIXER, status: "complete", startedAt: at(60), completedAt: at(120), createdAt: at(60), title: "Fix (review): r1 findings", spawnedBy: { kind: "review", ticketId: "T-3" } },
      "T-5": { agentId: FIXER, status: "complete", startedAt: at(140), completedAt: at(180), createdAt: at(140), title: "Fix (review): r2 findings", spawnedBy: { kind: "review", ticketId: "T-3" } },
      "T-6": { agentId: HUMAN, status: "complete", completedAt: at(290), createdAt: at(200) },
      "T-7": { agentId: CI, status: "complete", startedAt: at(300), completedAt: at(340), createdAt: at(0) },
      "T-8": { agentId: QA, status: "complete", startedAt: at(340), completedAt: at(380), createdAt: at(0) },
      "T-9": { agentId: HUMAN, status: "complete", completedAt: at(370), createdAt: at(360) },
      "T-10": { agentId: RM, status: "complete", startedAt: at(380), completedAt: at(470), createdAt: at(0) },
      "T-11": { agentId: FIXER, status: "complete", startedAt: at(400), completedAt: at(430), createdAt: at(400), title: "Fix (ship-review r1): findings", spawnedBy: { kind: "ship-review", ticketId: "T-10" } },
      "T-12": { agentId: CI, status: "complete", startedAt: at(430), completedAt: at(440), createdAt: at(430), title: "CI (re-cert): head 643c0e1" },
      "T-13": { agentId: CI, status: "complete", startedAt: at(450), completedAt: at(460), createdAt: at(450), title: "CI (re-cert): head a422f2c" },
    },
  };
}

function events() {
  const inv = (min, tid, agentId) => ev(min, "agent.invoked", { ticketId: tid, agentId });
  return [
    ev(0, "agent.complete", { ticketId: "T-1", agentId: ANALYST }),          // intake done → later "Fix:" titles are fixes
    inv(5, "T-2", FIXER), ev(40, "agent.complete", { ticketId: "T-2", agentId: FIXER }),
    // Review r1 → files fix T-4, parks; T-4 completes; reviewer re-woken (fix_rework)
    inv(40, "T-3", REVIEWER),
    ev(60, "ticket.created", { ticket: { id: "T-4", title: "Fix (review): r1 findings", assignee: FIXER, spawnedBy: { kind: "review", ticketId: "T-3" } } }),
    ev(60.1, "orchestrator.claim_released", { ticketId: "T-3", agentId: REVIEWER, reason: "agent_self_park", blockedBy: ["T-4"] }),
    inv(60.2, "T-4", FIXER), ev(120, "agent.complete", { ticketId: "T-4", agentId: FIXER }),
    ev(120.1, "orchestrator.unblocked", { ticketId: "T-3", unblockedBy: "T-4" }), inv(120.2, "T-3", REVIEWER),
    // Review r2 → fix T-5 → reviewer re-woken again (fix_rework)
    ev(140, "ticket.created", { ticket: { id: "T-5", title: "Fix (review): r2 findings", assignee: FIXER, spawnedBy: { kind: "review", ticketId: "T-3" } } }),
    ev(140.1, "orchestrator.claim_released", { ticketId: "T-3", agentId: REVIEWER, reason: "agent_self_park", blockedBy: ["T-5"] }),
    inv(140.2, "T-5", FIXER), ev(180, "agent.complete", { ticketId: "T-5", agentId: FIXER }),
    ev(180.1, "orchestrator.unblocked", { ticketId: "T-3", unblockedBy: "T-5" }), inv(180.2, "T-3", REVIEWER),
    // Review r3 → residual P2 → human escalation gate T-6; human accepts overnight; reviewer re-woken (human_gate)
    ev(200, "review.needed", { ticketId: "T-6" }),
    ev(200.1, "orchestrator.claim_released", { ticketId: "T-3", agentId: REVIEWER, reason: "agent_self_park", blockedBy: ["T-6"] }),
    ev(290, "agent.complete", { ticketId: "T-6", agentId: HUMAN }),
    ev(290.1, "orchestrator.unblocked", { ticketId: "T-3", unblockedBy: "T-6" }), inv(290.2, "T-3", REVIEWER),
    ev(300, "agent.complete", { ticketId: "T-3", agentId: REVIEWER }),
    // CI: session dies silently, WM retries (retry → error, not rework)
    ev(300.1, "orchestrator.unblocked", { ticketId: "T-7", unblockedBy: "T-3" }), inv(300.2, "T-7", CI),
    ev(320, "agent.retry", { ticketId: "T-7", agentId: CI, reason: "manual_restart" }),
    ev(320, "manager.intervention", { action: "retry", by: "workflow-manager", ticketId: "T-7", comment: "Session silent 19 min with no completion; restarting." }),
    inv(320.1, "T-7", CI),
    ev(323, "manager.intervention", { action: "comment", by: "workflow-manager", ticketId: "T-7", comment: "RCA: persona_run ended status OK without report_completion." }),
    ev(340, "agent.complete", { ticketId: "T-7", agentId: CI }),
    // QA: parks on a human decision gate T-9, re-woken (human_gate)
    ev(340.1, "orchestrator.unblocked", { ticketId: "T-8", unblockedBy: "T-7" }), inv(340.2, "T-8", QA),
    ev(360, "review.needed", { ticketId: "T-9" }),
    ev(360.1, "orchestrator.claim_released", { ticketId: "T-8", agentId: QA, reason: "agent_self_park", blockedBy: ["T-9"] }),
    ev(370, "agent.complete", { ticketId: "T-9", agentId: HUMAN }),
    ev(370.1, "orchestrator.unblocked", { ticketId: "T-8", unblockedBy: "T-9" }), inv(370.2, "T-8", QA),
    ev(380, "agent.complete", { ticketId: "T-8", agentId: QA }),
    // Ship review r1 → fix T-11 → CI re-cert T-12 → RM re-woken by the re-cert (ci_recert)
    ev(380.1, "orchestrator.unblocked", { ticketId: "T-10", unblockedBy: "T-8" }), inv(380.2, "T-10", RM),
    ev(400, "ticket.created", { ticket: { id: "T-11", title: "Fix (ship-review r1): findings", assignee: FIXER, spawnedBy: { kind: "ship-review", ticketId: "T-10" } } }),
    ev(400.1, "orchestrator.claim_released", { ticketId: "T-10", agentId: RM, reason: "agent_self_park", blockedBy: ["T-12"] }),
    inv(400.2, "T-11", FIXER), ev(430, "agent.complete", { ticketId: "T-11", agentId: FIXER }),
    ev(430.1, "ticket.created", { ticket: { id: "T-12", title: "CI (re-cert): head 643c0e1", assignee: CI } }),
    inv(430.2, "T-12", CI), ev(440, "agent.complete", { ticketId: "T-12", agentId: CI }),
    ev(440.1, "orchestrator.unblocked", { ticketId: "T-10", unblockedBy: "T-12" }), inv(440.2, "T-10", RM),
    // main moved → second re-cert T-13 → RM re-woken again (ci_recert)
    ev(450, "orchestrator.claim_released", { ticketId: "T-10", agentId: RM, reason: "agent_self_park", blockedBy: ["T-13"] }),
    inv(450.2, "T-13", CI), ev(460, "agent.complete", { ticketId: "T-13", agentId: CI }),
    ev(460.1, "orchestrator.unblocked", { ticketId: "T-10", unblockedBy: "T-13" }), inv(460.2, "T-10", RM),
    ev(470, "agent.complete", { ticketId: "T-10", agentId: RM }),
  ];
}

describe("classifyReinvocation — one kind per cause", () => {
  const tasks = computeAgentTasks(workflow(), events());
  const byId = Object.fromEntries(tasks.map((t) => [t.ticketId, t]));
  const kinds = (id) => byId[id].reinvocations.map((r) => r.kind);

  test("the reviewer's four rounds: two fix re-wakes are rework, the human-gate re-wake is not", () => {
    assert.deepEqual(kinds("T-3"), ["fix_rework", "fix_rework", "human_gate"]);
    assert.equal(byId["T-3"].invocations, 4);
    assert.equal(byId["T-3"].reworkRounds, 2);
    assert.equal(byId["T-3"].rewakes, 1);
  });

  test("a CI ticket restarted after a silent death is a retry — an error, never rework", () => {
    assert.deepEqual(kinds("T-7"), ["retry"]);
    assert.equal(byId["T-7"].reworkRounds, 0);
    assert.equal(byId["T-7"].retries, 1);
  });

  test("QA re-woken by a human decision gate is a human_gate re-wake", () => {
    assert.deepEqual(kinds("T-8"), ["human_gate"]);
    assert.equal(byId["T-8"].reworkRounds, 0);
  });

  test("the release manager re-woken by CI re-certifications is ci_recert, not rework", () => {
    assert.deepEqual(kinds("T-10"), ["ci_recert", "ci_recert"]);
    assert.equal(byId["T-10"].reworkRounds, 0);
    assert.equal(byId["T-10"].rewakes, 2);
  });

  test("first invocations are never re-invocations", () => {
    for (const id of ["T-1", "T-2", "T-4", "T-5", "T-11", "T-12", "T-13"]) {
      assert.deepEqual(kinds(id), [], id);
      assert.equal(byId[id].reworkRounds, 0, id);
    }
  });

  test("run totals: rework counts only fix/review-caused rounds; the rest are re-wakes or retries", () => {
    const ai = tasks.filter((t) => !String(t.agentId).startsWith("human:"));
    const totals = reinvocationTotals(ai);
    assert.equal(totals.total, 7);
    assert.deepEqual(totals.byKind, {
      retry: 1, human_gate: 2, ci_recert: 2, dependency: 0, fix_rework: 2, review_rework: 0, unknown: 0,
    });
    assert.equal(ai.reduce((s, t) => s + t.reworkRounds, 0), 2, "v1 would have said 7");
    assert.equal(ai.filter((t) => t.reworkRounds === 0).length, 10, "first-pass tasks (v1 would have said 7 of 11)");
  });
});

describe("classifyReinvocation — edge kinds", () => {
  const base = () => ({
    byTicket: new Map(), tickets: new Map([["X", { agentId: FIXER }]]), reviewRejectedAt: [], intakeAt: null,
  });

  test("a review gate rejection in the window reopens the ticket → review_rework", () => {
    const ctx = base();
    ctx.reviewRejectedAt = [T0 + 10_000];
    assert.deepEqual(classifyReinvocation("X", T0, T0 + 20_000, ctx), { kind: "review_rework", cause: "review.rejected" });
  });

  test("woken by a non-fix agent ticket → dependency", () => {
    const ctx = base();
    ctx.tickets.set("D", { agentId: "agentcore_hub_backend_dev", title: "Implement API" });
    ctx.byTicket.set("X", [ev(0.1, "orchestrator.unblocked", { ticketId: "X", unblockedBy: "D" })]);
    assert.equal(classifyReinvocation("X", T0, T0 + 20_000, ctx).kind, "dependency");
  });

  test("agent.died (runtime end-of-turn detection, TEAM-4734 FR-7) is a retry", () => {
    const ctx = base();
    ctx.byTicket.set("X", [ev(0.1, "agent.died", { ticketId: "X" })]);
    assert.equal(classifyReinvocation("X", T0, T0 + 20_000, ctx).kind, "retry");
  });

  test("no visible cause → unknown, which still counts as rework (never hide real rework)", () => {
    const r = classifyReinvocation("X", T0, T0 + 20_000, base());
    assert.equal(r.kind, "unknown");
    assert.ok(REWORK_KINDS.has(r.kind));
  });

  test("the kind vocabulary is closed and every rework kind is in it", () => {
    for (const k of REWORK_KINDS) assert.ok(REINVOCATION_KINDS.includes(k), k);
    assert.deepEqual([...REINVOCATION_KINDS].sort(), ["ci_recert", "dependency", "fix_rework", "human_gate", "retry", "review_rework", "unknown"]);
  });

  test("events lacking agent.invoked fall back to the orchestrator's journal event", () => {
    const wf = { id: "w", agentTasks: { A: { agentId: FIXER, status: "complete", startedAt: at(0), completedAt: at(9) } } };
    const evs = [
      ev(0, "orchestrator.agent_invoked", { ticketId: "A", agentId: FIXER }),
      ev(5, "agent.retry", { ticketId: "A", agentId: FIXER }),
      ev(5.1, "orchestrator.agent_invoked", { ticketId: "A", agentId: FIXER }),
    ];
    const [a] = computeAgentTasks(wf, evs);
    assert.equal(a.invocations, 2);
    assert.deepEqual(a.reinvocations.map((r) => r.kind), ["retry"]);
  });
});

describe("interventionDetail — every WM action, with what it said", () => {
  test("extracts action, ticket and a trimmed note in time order", () => {
    const rows = interventionDetail(events());
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.action), ["retry", "comment"]);
    assert.equal(rows[0].ticketId, "T-7");
    assert.match(rows[0].note, /^Session silent 19 min/);
    assert.match(rows[1].note, /^RCA: persona_run ended status OK/);
  });

  test("a note is capped at 240 chars and whitespace-collapsed", () => {
    const rows = interventionDetail([ev(1, "manager.intervention", { action: "comment", comment: `a\n\n${"b".repeat(400)}` })]);
    assert.equal(rows[0].note.length, 240);
    assert.ok(rows[0].note.startsWith("a b"));
  });
});
