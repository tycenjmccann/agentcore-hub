// TEAM-4167 D3 — the cost-report time card: the FR-3.6 utilization clamp, the
// FR-3.2 review.resolved-keyed human wait, and the FR-3.4 consumer tolerance of
// dedupeEvents once the producers collapse to one row per event.
//
// computeUtilization / computeHumanWait / dedupeEvents are pure and exported, so
// everything here is direct (no AWS seams). Importing index.mjs evaluates its
// top-level @aws-sdk imports; see pricing.test.mjs's header for why that is safe
// offline. deterministicEventId is imported from the orchestrator to prove the
// SAME id the producers now mint is what dedupeEvents sees as one row per event.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeUtilization, computeHumanWait, dedupeEvents } from "./index.mjs";
import { deterministicEventId } from "../orchestrator/event-id.mjs";

// ─── FR-3.6: agentUtilization clamp ───────────────────────────────────────────

test("FR-3.6 utilization: busy ≫ active clamps to 1.0 and flags utilizationClamped", () => {
  // busy = 981.51 × active, active at the floor → the raw ratio is 981.51, the
  // clamp pulls the reported figure to exactly 1.0.
  const active = 1000;
  const busy = 981.51 * active;
  assert.deepEqual(computeUtilization(busy, active), { agentUtilization: 1, utilizationClamped: true });
});

test("FR-3.6 utilization: busy < active is the unchanged ratio, unclamped", () => {
  assert.deepEqual(computeUtilization(500, 2000), { agentUtilization: 0.25, utilizationClamped: false });
});

test("FR-3.6 utilization: a zero/absent active window is null (not a divide-by-zero)", () => {
  assert.deepEqual(computeUtilization(1234, 0), { agentUtilization: null, utilizationClamped: false });
  assert.deepEqual(computeUtilization(1234, null), { agentUtilization: null, utilizationClamped: false });
});

test("FR-3.6 utilization: a sub-second active window uses the 1000 ms denominator floor", () => {
  // Without the floor this would be 5/10 = 0.5; the floor makes it 5/1000.
  assert.deepEqual(computeUtilization(5, 10), { agentUtilization: 0.005, utilizationClamped: false });
});

// ─── FR-3.2: computeHumanWait prefers review.resolved, excludes open gates ─────

const BASE = "2026-09-05T12:00:00.000Z";
const at = (secs) => new Date(Date.parse(BASE) + secs * 1000).toISOString();
const ENDED = Date.parse(BASE) + 10_000_000; // far after every gate

test("FR-3.2 humanWait: review.resolved (resolvedAt) wins over a later legacy review.approved", () => {
  const events = [
    { type: "review.needed", timestamp: BASE, detail: { ticketId: "G1" } },
    // resolvedAt is earlier than the legacy approved — if resolved wins, the
    // wait is 40 s, not the 100 s the legacy event would imply.
    { type: "review.resolved", timestamp: at(40), detail: { ticketId: "G1", resolvedAt: at(40), outcome: "approved" } },
    { type: "review.approved", timestamp: at(100), detail: { ticketId: "G1" } },
  ];
  assert.equal(computeHumanWait(events, ENDED), 40_000);
});

test("FR-3.2 humanWait: falls back to legacy review.approved when there is no review.resolved", () => {
  const events = [
    { type: "review.needed", timestamp: BASE, detail: { ticketId: "G1" } },
    { type: "review.approved", timestamp: at(100), detail: { ticketId: "G1" } },
  ];
  assert.equal(computeHumanWait(events, ENDED), 100_000);
});

test("FR-3.2 humanWait: an UNRESOLVED (open) gate contributes NO wait — not charged to run-end", () => {
  // G1 resolves at 40 s; G2 never resolves. Old code charged G2 all the way to
  // ENDED; now it contributes nothing, so the total is just G1's 40 s.
  const events = [
    { type: "review.needed", timestamp: BASE, detail: { ticketId: "G1" } },
    { type: "review.resolved", timestamp: at(40), detail: { ticketId: "G1", resolvedAt: at(40) } },
    { type: "review.needed", timestamp: BASE, detail: { ticketId: "G2" } },
  ];
  assert.equal(computeHumanWait(events, ENDED), 40_000);
});

// ─── FR-3.4: consumer tolerance — dedupeEvents is a no-op post-collapse ────────

test("FR-3.4 tolerance: dedupeEvents leaves an already-collapsed table (one row per event) unchanged", () => {
  // The table AFTER the producer-side collapse: one row per event, each carrying
  // the SAME deterministic eventId both writers now mint. Distinct content, so
  // dedupeEvents keeps every row, in order — a no-op.
  const detail = (i) => ({ ticketId: `TEAM-${i}`, agentId: "agentcore_hub_api_dev", timestamp: at(i) });
  const rows = [
    { type: "agent.started", detail: detail(1) },
    { type: "agent.complete", detail: detail(1) },
    { type: "review.resolved", detail: { ticketId: "G1", resolvedAt: at(2), timestamp: at(2) } },
    { type: "workflow.phase_change", detail: { phase: "development", workflowId: "wf_1", timestamp: at(3) } },
  ].map((r) => ({ workflowId: "wf_1", eventId: deterministicEventId(r.type, r.detail), timestamp: r.detail.timestamp, ...r }));

  const out = dedupeEvents(rows);
  assert.equal(out.length, rows.length, "no rows collapsed");
  assert.deepEqual(out.map((r) => r.eventId), rows.map((r) => r.eventId), "order preserved");
  assert.deepEqual(out, rows);
});
