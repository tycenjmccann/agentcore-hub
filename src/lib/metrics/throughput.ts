/**
 * Per-type workflow duration rollup for the "Where the time goes" panel.
 *
 * The AI/human split is computed from SUMS, not medians: median human dwell is
 * ~0 whenever fewer than half the runs hit a gate, which hid day-long approval
 * waits behind "100% AI". Totals answer the question the panel actually asks —
 * of all the wall-clock this type consumed, how much was waiting on a human?
 */

export interface WorkflowDuration {
  type: string;
  e2eMs: number;
  humanMs: number;
}

export interface ThroughputRow {
  type: string;
  count: number;
  /** median end-to-end minutes per completed workflow (per-run estimate) */
  e2eMin: number;
  /** summed minutes across all completed workflows of this type */
  totalE2eMin: number;
  totalAiMin: number;
  totalHumanMin: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeThroughput(workflows: WorkflowDuration[]): ThroughputRow[] {
  const byType = new Map<string, { e2e: number[]; human: number[] }>();
  for (const wf of workflows) {
    if (wf.e2eMs <= 0) continue;
    const entry = byType.get(wf.type) || { e2e: [], human: [] };
    entry.e2e.push(wf.e2eMs);
    // Dwell can only overrun e2e through clock skew or an interval left open
    // past workflow completion — cap so a single run can't go negative-AI.
    entry.human.push(Math.min(Math.max(wf.humanMs, 0), wf.e2eMs));
    byType.set(wf.type, entry);
  }
  return [...byType.entries()]
    .map(([type, v]) => {
      const totalE2e = v.e2e.reduce((a, b) => a + b, 0);
      const totalHuman = v.human.reduce((a, b) => a + b, 0);
      const totalE2eMin = Math.round(totalE2e / 60000);
      const totalHumanMin = Math.round(totalHuman / 60000);
      return {
        type,
        count: v.e2e.length,
        e2eMin: Math.round(median(v.e2e) / 60000),
        totalE2eMin,
        totalHumanMin,
        totalAiMin: Math.max(0, totalE2eMin - totalHumanMin),
      };
    })
    .sort((a, b) => b.count - a.count);
}
