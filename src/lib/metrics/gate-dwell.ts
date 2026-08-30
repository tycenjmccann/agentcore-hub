/**
 * Human-gate dwell computation from Jira status changelogs.
 *
 * Human-review gate tickets park in DIFFERENT statuses depending on how the
 * gate was filed: release-manager merge approvals sit in "Blocked" until the
 * Telegram ✅ flips them, while spec/plan gates go straight to "In Review".
 *
 * "Blocked" is ambiguous, though — a gate can also be Blocked on upstream
 * rework tickets. The exit transition disambiguates: leaving Blocked for
 * "Ready" means dependencies completed (dependency wait — not counted);
 * leaving for In Review/Done, or still sitting Blocked, means a human was the
 * bottleneck (counted).
 */

export interface StatusTransition {
  /** epoch ms of the transition */
  at: number;
  from?: string;
  to?: string;
}

export interface Interval {
  start: number;
  end: number;
  /** status the ticket moved to when this interval closed; undefined = still open */
  exitTo?: string;
}

interface JiraChangelog {
  histories?: Array<{ created: string; items?: Array<Record<string, unknown>> }>;
}

/** Flatten a Jira changelog into ordered status transitions. */
export function extractStatusTransitions(changelog: JiraChangelog | undefined): StatusTransition[] {
  const transitions: StatusTransition[] = [];
  for (const h of changelog?.histories || []) {
    for (const item of h.items || []) {
      if (item.field !== "status") continue;
      const at = new Date(h.created).getTime();
      if (Number.isNaN(at)) continue;
      // "toString" collides with Object.prototype in TS — index access avoids the method type
      transitions.push({
        at,
        from: item["fromString"] as string | undefined,
        to: item["toString"] as unknown as string | undefined,
      });
    }
  }
  transitions.sort((a, b) => a.at - b.at);
  return transitions;
}

/**
 * Intervals the ticket spent in `status`. An interval still open at `nowMs`
 * runs to `nowMs` with no `exitTo`.
 */
export function statusIntervals(
  transitions: StatusTransition[],
  status: string,
  nowMs: number
): Interval[] {
  const intervals: Interval[] = [];
  let enteredAt: number | null = null;
  for (const t of transitions) {
    const entering = t.to === status;
    if (entering && enteredAt === null) {
      enteredAt = t.at;
    } else if (!entering && enteredAt !== null) {
      if (t.at > enteredAt) intervals.push({ start: enteredAt, end: t.at, exitTo: t.to });
      enteredAt = null;
    }
  }
  if (enteredAt !== null && nowMs > enteredAt) intervals.push({ start: enteredAt, end: nowMs });
  return intervals;
}

/**
 * Total ms covered by the union of intervals. A workflow can have several gate
 * tickets open at once (round-N approval queued in Blocked while round N-1 is
 * In Review) — summing per-ticket dwell double-counts those overlaps. Touching
 * intervals (Blocked ending exactly when In Review starts) merge into one
 * continuous wait.
 */
export function unionMs(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const iv of sorted) {
    if (iv.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.end > curEnd) {
      curEnd = iv.end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Waiting-on-human intervals for a gate ticket's changelog: all In Review
 * time, plus Blocked time that did NOT resolve by dependencies completing
 * (exit to "Ready"). An interval still open in Blocked is ambiguous — pass
 * `openBlockedIsDependency: true` (ticket currently has unresolved blockers)
 * to classify it as a dependency wait instead of a human one.
 */
export function humanWaitIntervals(
  changelog: JiraChangelog | undefined,
  nowMs = Date.now(),
  opts?: { openBlockedIsDependency?: boolean }
): Interval[] {
  const transitions = extractStatusTransitions(changelog);
  const inReview = statusIntervals(transitions, "In Review", nowMs);
  const blocked = statusIntervals(transitions, "Blocked", nowMs).filter((iv) => {
    if (iv.exitTo !== undefined) return iv.exitTo !== "Ready";
    return !opts?.openBlockedIsDependency;
  });
  return [...inReview, ...blocked];
}

/** Convenience: waiting-on-human ms for a single gate ticket's changelog. */
export function humanWaitMs(changelog: JiraChangelog | undefined, nowMs = Date.now()): number {
  return unionMs(humanWaitIntervals(changelog, nowMs));
}
