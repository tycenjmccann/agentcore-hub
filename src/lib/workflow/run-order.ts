/**
 * Shared ordering logic for the Workflow tab's history list (TEAM-4504).
 *
 * The bug: every sort in the list path used `startedAt` only, so a run that
 * started long ago but finished recently sorted below a run that started
 * more recently but finished earlier. "Past" should read newest-finished
 * first; "Active" (still open) correctly has no finish time and keeps
 * sorting by `startedAt`.
 */

export interface RunTimes {
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  erroredAt?: string | null;
  finalizedAt?: string | null;
}

export interface RunTimesWithPhase extends RunTimes {
  phase?: string | null;
}

/** `Date.parse` with missing/unparseable -> 0, never NaN. */
function msOf(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function startedAtMs(w: RunTimes): number {
  return msOf(w.startedAt);
}

/** First parseable finish signal, in priority order; falls back to startedAt, else 0. */
export function finishedAtMs(w: RunTimes): number {
  const candidates = [w.completedAt, w.cancelledAt, w.erroredAt, w.finalizedAt];
  for (const c of candidates) {
    const ms = msOf(c);
    if (ms !== 0) return ms;
  }
  return startedAtMs(w);
}

/** Past list order: newest-finished first, ties broken by newest-started first. */
export function byFinishedDesc(a: RunTimes, b: RunTimes): number {
  const diff = finishedAtMs(b) - finishedAtMs(a);
  if (diff !== 0) return diff;
  return startedAtMs(b) - startedAtMs(a);
}

/**
 * Active-first, then by start date descending — the comparator that used to
 * be duplicated in src/app/workflow/page.tsx (fetch sort + delete-rollback
 * re-sort). Kept as the literal three-phase check both call sites used,
 * rather than `isTerminalPhase`, so behaviour does not silently change for
 * ship-blocked outcomes.
 */
export function byActiveThenStartedDesc(a: RunTimesWithPhase, b: RunTimesWithPhase): number {
  const aActive = a.phase !== "complete" && a.phase !== "error" && a.phase !== "cancelled";
  const bActive = b.phase !== "complete" && b.phase !== "error" && b.phase !== "cancelled";
  if (aActive && !bActive) return -1;
  if (!aActive && bActive) return 1;
  return startedAtMs(b) - startedAtMs(a);
}

/**
 * Active list order (TEAM-4403): runs blocked on a person float to the top,
 * then newest-started first within each group. The awaiting-human test is passed
 * in rather than imported so this stays a pure ordering helper — the caller owns
 * the parked-execution SHAs (see isAwaitingHuman in ./deploy-gate).
 *
 * Behaviour matches the comparator this replaces in src/app/workflow/page.tsx;
 * `startedAtMs` additionally makes a missing/unparseable `startedAt` sort as 0
 * instead of NaN, exactly as byActiveThenStartedDesc above already does.
 */
export function byAwaitingHumanThenStartedDesc<T extends RunTimes>(
  isAwaiting: (w: T) => boolean
): (a: T, b: T) => number {
  return (a, b) => {
    const aWaiting = isAwaiting(a) ? 1 : 0;
    const bWaiting = isAwaiting(b) ? 1 : 0;
    if (aWaiting !== bWaiting) return bWaiting - aWaiting;
    return startedAtMs(b) - startedAtMs(a);
  };
}

/** Rank used for the Dynamo top-50 cut: a run survives if it's recently active OR recently finished. */
export function listRankMs(w: RunTimes): number {
  return Math.max(startedAtMs(w), finishedAtMs(w));
}
