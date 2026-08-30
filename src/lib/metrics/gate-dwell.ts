/**
 * Human-gate dwell computation from Jira status changelogs.
 *
 * Human-review gate tickets park in DIFFERENT statuses depending on how the
 * gate was filed: release-manager merge approvals sit in "Blocked" until the
 * Telegram ✅ flips them, while spec/plan gates go straight to "In Review".
 * Both are time a human is the bottleneck, so both count as waiting-on-human.
 */

export interface StatusTransition {
  /** epoch ms of the transition */
  at: number;
  from?: string;
  to?: string;
}

/** Statuses that mean "a human owns this ticket right now" for gate tickets. */
export const HUMAN_WAIT_STATUSES: ReadonlySet<string> = new Set(["In Review", "Blocked"]);

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

export interface Interval {
  start: number;
  end: number;
}

/**
 * Intervals the ticket spent in any of `statuses`. Consecutive counted
 * statuses (e.g. Blocked → In Review) accrue as one continuous interval. An
 * interval still open at `nowMs` runs to `nowMs`.
 */
export function dwellIntervals(
  transitions: StatusTransition[],
  statuses: ReadonlySet<string>,
  nowMs: number
): Interval[] {
  const intervals: Interval[] = [];
  let enteredAt: number | null = null;
  for (const t of transitions) {
    const entering = t.to !== undefined && statuses.has(t.to);
    if (entering && enteredAt === null) {
      enteredAt = t.at;
    } else if (!entering && enteredAt !== null) {
      if (t.at > enteredAt) intervals.push({ start: enteredAt, end: t.at });
      enteredAt = null;
    }
  }
  if (enteredAt !== null && nowMs > enteredAt) intervals.push({ start: enteredAt, end: nowMs });
  return intervals;
}

/** Total ms the ticket spent in any of `statuses`. */
export function dwellMs(
  transitions: StatusTransition[],
  statuses: ReadonlySet<string>,
  nowMs: number
): number {
  return dwellIntervals(transitions, statuses, nowMs).reduce((s, i) => s + (i.end - i.start), 0);
}

/**
 * Total ms covered by the union of intervals. A workflow can have several gate
 * tickets open at once (round-N approval queued in Blocked while round N-1 is
 * In Review) — summing per-ticket dwell double-counts those overlaps.
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

/** Waiting-on-human intervals for a gate ticket's changelog. */
export function humanWaitIntervals(changelog: JiraChangelog | undefined, nowMs = Date.now()): Interval[] {
  return dwellIntervals(extractStatusTransitions(changelog), HUMAN_WAIT_STATUSES, nowMs);
}

/** Convenience: waiting-on-human ms for a single gate ticket's changelog. */
export function humanWaitMs(changelog: JiraChangelog | undefined, nowMs = Date.now()): number {
  return dwellMs(extractStatusTransitions(changelog), HUMAN_WAIT_STATUSES, nowMs);
}
