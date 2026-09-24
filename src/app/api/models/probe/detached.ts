/**
 * The probe route's detached work, tracked (TEAM-5016 finding 7).
 *
 * POST /api/models/probe answers 202 and finishes the probe after the response
 * has gone, so nothing in the response can be awaited to learn that the row was
 * written. The tests used to poll for the write with `vi.waitFor` and its
 * implicit 1s timeout — a slow CI box made that flaky. `track` registers each
 * detached run and `settleDetached` resolves once every registered run has
 * finished, so a test awaits the fact rather than guessing a deadline.
 *
 * This is not a `route.ts` export on purpose: Next only allows the HTTP method
 * handlers (and a few config fields) as runtime exports of a route module, and a
 * stray export fails `next build`. Same reason `../registry/save.ts` is a
 * sibling module rather than part of its route.
 */

const pending = new Set<Promise<unknown>>();

/** Register a detached run. Returns the same promise so the caller can `void` it. */
export function track<T>(run: Promise<T>): Promise<T> {
  pending.add(run);
  void run.finally(() => pending.delete(run)).catch(() => {});
  return run;
}

/** Test seam: resolves once every tracked run has settled, failures included. */
export async function settleDetached(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
