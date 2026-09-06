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

import { dedupeEvents, fixTicketIds, intakeCompletedAt, isFixTicket } from "./index.mjs";

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
