/**
 * In-flight de-dupe for POST /api/workflow/performance.
 *
 * Lives outside the route module because a Next.js route file may only export
 * the recognized route fields (GET/POST/config/dynamic/...) — a test-only
 * export like a map-reset hook fails `next build`'s route type check.
 *
 * Best-effort and per-ECS-task BY DESIGN. With more than one task behind the
 * ALB, two concurrent POSTs on different tasks both invoke; that is acceptable
 * because the cost-report Lambda is idempotent (it recomputes and overwrites
 * the same key), and a cross-task lock would mean writing the workflows table,
 * which this surface deliberately never does.
 */

/**
 * How long a submitted recompute is assumed to still be running. Sized to the
 * cost-report Lambda's own timeout, not to a client's patience: while an
 * invoke may still be in flight, re-invoking only burns Logs Insights scans to
 * write the same S3 key twice.
 */
export const INFLIGHT_TTL_MS = 600_000;

const inflight = new Map<string, number>();

/**
 * Drops every expired marker, then returns how long the given id has been
 * held (undefined if it is free). Sweeping on every call means the map can
 * never grow without bound on a long-lived task.
 */
export function sweepAndCheck(workflowId: string, now: number): number | undefined {
  for (const [id, startedAt] of inflight) {
    if (now - startedAt >= INFLIGHT_TTL_MS) inflight.delete(id);
  }
  return inflight.get(workflowId);
}

export function claim(workflowId: string, now: number): void {
  inflight.set(workflowId, now);
}

export function release(workflowId: string): void {
  inflight.delete(workflowId);
}

/** Test-only: drop every in-flight marker so a spec starts from a clean map. */
export function __resetInflightForTests(): void {
  inflight.clear();
}

/** Test-only: how many markers are held, for asserting the sweep actually sweeps. */
export function __inflightSizeForTests(): number {
  return inflight.size;
}
