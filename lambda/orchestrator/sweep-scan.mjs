/**
 * Shared open-workflow scan for the orchestrator's scheduled sweeps
 * (TEAM-3839 — extracted from reconcile-sweep.mjs and dead-session-detector.mjs,
 * which carried near-identical duplicate copies of this function).
 *
 * Scans workflows in a non-terminal phase, newest first, capped at SWEEP_CAP
 * per sweep. When more than SWEEP_CAP workflows are open, the capped window
 * ROTATES across sweeps (TEAM-3764 F5) instead of always re-inspecting the
 * newest 50 — the fixed newest-first truncation starved everything older
 * forever. TEAM-3839: the dead-session detector's duplicate copy was missed
 * when F5 landed in reconcile-sweep; extracting the ONE implementation here is
 * the fix, so the two sweeps can never drift apart again.
 *
 * Rotation semantics (unchanged from F5): the rotation index is derived from
 * the injected clock in quanta of SWEEP_ROTATION_QUANTUM_MS — stateless (a cold
 * start computes the same window a warm one would; zero writes, so shadow
 * modes stay write-free) and deterministic for tests. The quantum sits above
 * both sweep schedules (rate(5 minutes)), so the index advances by at most 1
 * between sweeps and every chunk of ceil(N/SWEEP_CAP) is inspected within
 * ceil(N/SWEEP_CAP) quanta. Under the cap this is exactly the old
 * slice(0, SWEEP_CAP) — no behavior change below the cap.
 *
 * TEAM-3755 F8 / TEAM-3756 F5: the phase filter is DERIVED from the shared
 * TERMINAL_WORKFLOW_PHASES list (completion.mjs) rather than spelled out here,
 * so a new terminal phase can never be added to the completion gate and
 * forgotten by the sweeps. completion.mjs is pure — no AWS clients, no store
 * import — so importing it here cannot cycle.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { notTerminalPhaseFilter } from "./completion.mjs";

export const SWEEP_CAP = 50;          // workflows inspected per sweep
const WORKFLOW_SCAN_PAGES = 20;       // bound the workflows scan
export const SWEEP_ROTATION_QUANTUM_MS = 10 * 60 * 1000;

/**
 * Build the scan bound to its dependencies. Returns an async function yielding
 * { workflows, matched, rotation, pages } so the caller can flag truncation
 * (and log which rotating window this sweep inspected).
 */
export function createOpenWorkflowScan({ ddb, workflowsTable, now = () => Date.now() }) {
  return async function scanNonTerminalWorkflows() {
    const matched = [];
    let lastKey;
    const openOnly = notTerminalPhaseFilter("#p");
    for (let page = 0; page < WORKFLOW_SCAN_PAGES; page++) {
      const res = await ddb.send(new ScanCommand({
        TableName: workflowsTable,
        FilterExpression: openOnly.filter,
        ExpressionAttributeNames: { "#p": "phase" },
        ExpressionAttributeValues: { ...openOnly.values },
        ExclusiveStartKey: lastKey,
      }));
      for (const w of res.Items || []) matched.push(w);
      lastKey = res.LastEvaluatedKey;
      if (!lastKey) break;
    }
    // Best-effort recency ordering — workflow rows carry no single updatedAt, so
    // fall back through the timestamps they do carry.
    const recency = (w) => String(w.updatedAt || w.completedAt || w.startedAt || "");
    matched.sort((a, b) => recency(b).localeCompare(recency(a)));
    // TEAM-3764 F5 — rotate the capped window: chunk k of the recency-sorted
    // list this quantum, chunk k+1 the next, wrapping. Under the cap this is
    // exactly the old slice(0, SWEEP_CAP).
    const pages = Math.max(1, Math.ceil(matched.length / SWEEP_CAP));
    const rotation = pages === 1 ? 0 : Math.floor(now() / SWEEP_ROTATION_QUANTUM_MS) % pages;
    const start = rotation * SWEEP_CAP;
    return {
      workflows: matched.slice(start, start + SWEEP_CAP),
      matched: matched.length,
      rotation,
      pages,
    };
  };
}
