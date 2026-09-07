// TEAM-4121 FR-10 — the fix-ticket predicate, pinned against the SAME fixture
// the Workflow Manager toolkit uses.
//
// The performance card's "Fix tickets" row (this Lambda) and the WM's
// `fixTickets.count` (deploy/workflow-manager/toolkit/compute_metrics.py) are
// shown for the same run, so they must agree on what a fix ticket IS. Before
// this change both counted `title.startsWith("Fix:")`, which by mid-2026 was
// wrong in both directions at once — the agents had standardized on
// "Fix (review):" / "Fix (QA):" / "Fix (ship-review r2):" / "Fix (CI):", none of
// which starts with "Fix:", while a bug-fix run's own intake-planned
// "Fix: <the feature>" ticket was counted as a rework loop.
//
// The two implementations are in different languages and cannot share code, so
// they share a FIXTURE: deploy/workflow-manager/toolkit/fixtures/fix-lineage.json
// (its `_fixture.cases` explains every ticket). test_metrics.py's FixLineage
// asserts the same 16 ids from Python; the list below is copied from there
// deliberately, so a change on either side fails on the other.
//
// The JS side stops at the predicate: the card reports a NUMBER, so nothing here
// needs the kind/origin/round/tag lineage the WM computes. That asymmetry is the
// point — one shared definition of "is a fix", one place that reasons about it.
//
// Importing index.mjs evaluates its top-level `@aws-sdk/*` imports; see
// pricing.test.mjs's header for why that is safe offline and never ships.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeGateRounds, dedupeEvents, fixTicketIds, intakeCompletedAt, isFixTicket } from "./index.mjs";

const FIXTURE = fileURLToPath(
  new URL("../../deploy/workflow-manager/toolkit/fixtures/fix-lineage.json", import.meta.url),
);
const dossier = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Exactly what test_metrics.py FixLineage.test_count_and_ids_in_creation_order
// asserts, in the same creation order.
const EXPECTED_IDS = [
  "LIN-10", "LIN-11", "LIN-12", "LIN-13", "LIN-14",
  "LIN-15", "LIN-16", "LIN-17", "LIN-18", "LIN-19", "LIN-21",
  "LIN-22", "LIN-23", "LIN-24", "LIN-25", "LIN-26",
];

/**
 * The dossier through cost-report's eyes. The WM reads a `tickets[]` array from
 * the ticket provider; this Lambda only ever sees the workflow row's agentTasks
 * map plus the events, so the fixture's tickets become agentTasks entries (which
 * is where `spawnedBy` and `createdAt` live on the real row).
 */
function asWorkflow(tickets = dossier.tickets) {
  const agentTasks = {};
  for (const t of tickets) {
    if (t.type === "epic") continue; // epics are not tracked as tasks
    agentTasks[t.ticketId] = {
      agentId: t.assignee, title: t.title, status: "complete",
      createdAt: t.createdAt, spawnedBy: t.spawnedBy,
    };
  }
  return { epicId: dossier.epicId, agentTasks };
}

const events = () => dedupeEvents(dossier.events);

test("the shared fixture yields the same fix tickets as the Python toolkit", () => {
  const ids = fixTicketIds(events(), [], asWorkflow());
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(ids.length, dossier._fixture.expected.count);
});

test("the intake-planned 'Fix:' ticket is excluded, the later one is not", () => {
  const intakeAt = intakeCompletedAt(events(), asWorkflow());
  // The boundary is the analyst's own completion, stated by the fixture.
  assert.equal(new Date(intakeAt).toISOString(), "2026-07-02T10:15:00.000Z");

  const ids = fixTicketIds(events(), [], asWorkflow());
  assert.ok(!ids.includes("LIN-3"), "LIN-3 is the work the run exists to do");
  // LIN-21 is the same legacy title shape, created after planning finished.
  assert.ok(ids.includes("LIN-21"));
});

test("no intake signal at all → nothing is excluded (overcount by one beats dropping a fix)", () => {
  const noTerminals = dossier.events.filter(
    (e) => e.type !== "agent.complete" && e.type !== "workflow.report_completion");
  assert.equal(intakeCompletedAt(noTerminals, asWorkflow()), null);
  const ids = fixTicketIds(noTerminals, [], asWorkflow());
  assert.deepEqual(ids, ["LIN-3", ...EXPECTED_IDS]);
});

test("intake completion falls back to the first task completing when agentId is gone", () => {
  // Older/pruned events carry no detail.agentId; the boundary is then the first
  // task (LIN-2, created 10:00) reporting completion — the same instant, found
  // by ticket instead of by agent.
  const pruned = dossier.events.map((e) => {
    if (e.detail?.agentId !== "agentcore_hub_requirements_analyst") return e;
    const detail = { ...e.detail };
    delete detail.agentId;
    return { ...e, detail };
  });
  const intakeAt = intakeCompletedAt(pruned, asWorkflow());
  assert.equal(new Date(intakeAt).toISOString(), "2026-07-02T10:15:00.000Z");
  assert.ok(!fixTicketIds(pruned, [], asWorkflow()).includes("LIN-3"));
});

test("ticket.created events alone are enough (a run whose workflow row was trimmed)", () => {
  // The fixture publishes ticket.created for LIN-3 (excluded), LIN-10 and LIN-13.
  const ids = fixTicketIds(events(), [], { agentTasks: {} });
  assert.deepEqual(ids, ["LIN-10", "LIN-13"]);
});

test("computed task rows are a title source too", () => {
  const rows = [{ ticketId: "LIN-99", title: "Fix (QA): a row computeAgentTasks resolved" }];
  assert.deepEqual(fixTicketIds([], rows, {}), ["LIN-99"]);
});

test("spawnedBy.kind outranks the title — provenance beats prose", () => {
  // A dev who renames the ticket does not un-file the fix.
  assert.equal(isFixTicket({ title: "Rework the flaky pricing test", spawnedBy: { kind: "qa_fix" } }), true);
  assert.equal(isFixTicket({ title: "Rework the flaky pricing test" }), false);
});

test("every title shape the fleet actually mints is recognized", () => {
  for (const title of [
    "Fix (review): intake.ts source validator — 2 findings",
    "Fix (QA): the error detail still leaks the placeholder name",
    "Fix (QA re-verify): checkS3Source — still leaks via the rawName path",
    "Fix (ship-review r1): Array.isArray guard on input.sources",
    "Fix (ship-review r12): a twelfth round is still a fix",
    "Fix (CI): npm run test:unit is red on the feature head",
    "Fix (sync-main): merge origin/main into the feature branch",
    "Fix (codex): the CLI's own finding",
    "Re-verify (QA): TEAM-4089 — re-run the live probe @ 0949f9d",
  ]) {
    assert.equal(isFixTicket({ title }), true, title);
  }
  for (const title of [
    "QA: Verify submit_workflow accepts s3:// sources",
    "Review: source validation fix",
    "Ship: source validation fix",
    "CI: Validate build and tests",
    "Fixtures: add a dossier for the lineage tests", // must not match on a prefix
    "[advisory] intake.ts — pin the vetted DNS answer",
  ]) {
    assert.equal(isFixTicket({ title }), false, title);
  }
});

test("the regression this replaced: the real titles never started with 'Fix:'", () => {
  // Documented as an assertion so the reason the predicate grew is not folklore.
  const real = [
    "Fix (review): WorkflowBoard sources list + start-route input shape — 2 findings",
    "Fix (QA): intake.ts — real SDK bodiless-403 message leaks into the S3 error detail",
    "Fix (ship-review r2): intake.ts urlGate — trailing-dot host canonicalization",
    "Fix (CI): merge origin/main into feature/TEAM-4054-…",
  ];
  for (const title of real) {
    assert.equal(title.startsWith("Fix:"), false, title); // the old predicate: missed
    assert.equal(isFixTicket({ title }), true, title);    // the new one: counted
  }
});

test("ids are deduped across the three sources and ordered by creation", () => {
  const rows = dossier.tickets.map((t) => ({ ticketId: t.ticketId, title: t.title }));
  const ids = fixTicketIds(events(), rows, asWorkflow());
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(new Set(ids).size, ids.length);
});

// ─── TEAM-4246 D1 FR-D1.11 — gate metrics from verdict events ────────────────
//
// The three numbers this card reports about gates (`reworkRounds`, `gateRounds`,
// `firstPassYield`) had no access to a verdict before D1, so they answered
// adjacent questions instead: how many times a TICKET was re-invoked, how many
// times a HUMAN gate was re-requested. wf_1788731227559_dowtdh is the run that
// showed the gap — its reviewer said CHANGES NEEDED, its QA verifier said FAIL and
// its CI agent said PASS, three gate rounds and two rejections, and the card
// reported `gateRounds: 0` because none of the three was a human review gate.
//
// The sequences below are literal (the real dowtdh dossier carries no
// `detail.verdict` — it predates the field; the orchestrator's own
// verdict-contract.test.mjs pins the ladder that reads its prose, and the Python
// toolkit does the retro scoring). What is asserted here is the ARITHMETIC on top
// of an already-resolved verdict, plus the fallback that keeps every pre-D1 card
// numerically unchanged.

const QA = "agentcore_hub_qa_verifier";
const REVIEWER = "agentcore_hub_code_reviewer";
const CI = "agentcore_hub_ci_agent";

const complete = (ticketId, agentId, at, extra = {}) =>
  ({ type: "agent.complete", timestamp: at, detail: { ticketId, agentId, assignee: agentId, ...extra } });

/** dowtdh's gate sequence, at its real timestamps, as it would be published today. */
const DOWTDH_GATES = [
  complete("TEAM-4180", REVIEWER, "2026-09-06T23:19:21.743Z", { verdict: "CHANGES_NEEDED", verdictSource: "declared" }),
  complete("TEAM-4181", QA, "2026-09-06T23:36:32.821Z", { verdict: "FAIL", verdictSource: "declared", testedHead: "12e9ac6" }),
  complete("TEAM-4182", CI, "2026-09-06T23:42:11.459Z", { verdict: "PASS", verdictSource: "declared", testedHead: "12e9ac6" }),
];

test("enriched events: dowtdh's three gate verdicts → 2 reworks, 3 rounds, no first-pass yield", () => {
  const gates = computeGateRounds({}, DOWTDH_GATES);
  assert.equal(gates.reworkRounds, 2);   // reviewer CHANGES_NEEDED + QA FAIL
  assert.equal(gates.gateRounds, 3);     // …and the CI PASS is still a gate round
  assert.equal(gates.firstPassYield, 0); // two of the three failed on first look
  assert.equal(gates.source, "verdict-events");
});

test("enriched events: every gate PASSing first look yields 1", () => {
  const gates = computeGateRounds({}, [
    complete("T-1", REVIEWER, "2026-09-06T23:00:00Z", { verdict: "PASS" }),
    complete("T-2", QA, "2026-09-06T23:10:00Z", { verdict: "PASS" }),
    complete("T-3", CI, "2026-09-06T23:20:00Z", { verdict: "PASS" }),
  ]);
  assert.equal(gates.reworkRounds, 0);
  assert.equal(gates.gateRounds, 3);
  assert.equal(gates.firstPassYield, 1);
});

test("the FIRST verdict decides the yield — a re-verify PASS does not retroactively earn it", () => {
  const gates = computeGateRounds({}, [
    complete("TEAM-4181", QA, "2026-09-06T23:36:32Z", { verdict: "FAIL" }),
    complete("TEAM-4190", QA, "2026-09-07T00:10:00Z", { verdict: "PASS" }),   // the re-verify
  ]);
  assert.equal(gates.gateRounds, 2);     // initial + re-verify
  assert.equal(gates.reworkRounds, 1);
  assert.equal(gates.firstPassYield, 0);
  // …and the reverse order: a first-look PASS followed by a later FAIL still
  // yielded on the first look, but is not rework-free.
  const later = computeGateRounds({}, [
    complete("TEAM-4181", QA, "2026-09-06T23:36:32Z", { verdict: "PASS" }),
    complete("TEAM-4190", QA, "2026-09-07T00:10:00Z", { verdict: "FAIL" }),
  ]);
  assert.equal(later.firstPassYield, 1);
  assert.equal(later.reworkRounds, 1);
});

test("only gate personas and only recognized verdicts count", () => {
  const gates = computeGateRounds({}, [
    complete("T-1", "agentcore_hub_backend_dev", "2026-09-06T22:00:00Z", { verdict: "PASS" }),  // not a gate
    complete("T-2", "human:engineer", "2026-09-06T22:10:00Z", { verdict: "PASS" }),             // not a gate
    complete("T-3", QA, "2026-09-06T22:20:00Z", { verdict: "LGTM" }),                           // not a verdict
    complete("T-4", CI, "2026-09-06T22:30:00Z", { verdict: "BLOCKED" }),
  ]);
  assert.equal(gates.gateRounds, 1);
  // BLOCKED is a verdict and a gate round, but the CI agent is not one of the two
  // personas whose non-PASS means the dev work goes back.
  assert.equal(gates.reworkRounds, 0);
  assert.equal(gates.firstPassYield, 0);
});

test("legacy events without a verdict: the reviewGateHistory numbers, unchanged", () => {
  // A run with two human review gates: 3 rounds on the first, 1 on the second.
  // Snapshot of the pre-change computation — rounds 4, reworks (3-1)+(1-1) = 2.
  const workflow = {
    reviewGateHistory: {
      "TEAM-4178": { rounds: [{ verdict: "CHANGES-NEEDED" }, { verdict: "CHANGES-NEEDED" }, { verdict: "PASS" }] },
      "TEAM-4186": { rounds: [{ verdict: "PASS" }] },
    },
  };
  const legacyEvents = [
    complete("TEAM-4180", REVIEWER, "2026-09-06T23:19:21.743Z"),   // no detail.verdict at all
    complete("TEAM-4181", QA, "2026-09-06T23:36:32.821Z"),
    complete("TEAM-4182", CI, "2026-09-06T23:42:11.459Z"),
  ];
  const gates = computeGateRounds(workflow, legacyEvents);
  assert.equal(gates.gateRounds, 4);
  assert.equal(gates.gateReworks, 2);
  assert.equal(gates.source, "reviewGateHistory");
  // null, not 0: the caller substitutes the task-derived value it has always
  // reported. A 0 here would silently zero every pre-D1 card's rework row.
  assert.equal(gates.reworkRounds, null);
  assert.equal(gates.firstPassYield, null);

  // No events at all, and no history: also the legacy shape, all zeros.
  assert.deepEqual(computeGateRounds({}, []), {
    gateRounds: 0, gateReworks: 0, reworkRounds: null, firstPassYield: null, source: "reviewGateHistory",
  });
  // The old single-argument call still answers the same way.
  assert.deepEqual(computeGateRounds(workflow), { ...gates });
});

test("gateReworks stays review-request-derived even when verdicts are present", () => {
  // The two numbers answer different questions and must not collapse into one:
  // `gateRounds` counts verdicts stated, `gateReworks` counts a human gate being
  // re-requested. A run can have three verdicts and zero re-requests.
  const workflow = { reviewGateHistory: { "TEAM-4178": { rounds: [{ verdict: "PASS" }] } } };
  const gates = computeGateRounds(workflow, DOWTDH_GATES);
  assert.equal(gates.gateRounds, 3);
  assert.equal(gates.gateReworks, 0);
});
