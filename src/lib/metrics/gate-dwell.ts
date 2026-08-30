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

/**
 * Total ms the ticket spent in any of `statuses`. Consecutive counted statuses
 * (e.g. Blocked → In Review) accrue as one continuous interval. An interval
 * still open at `nowMs` counts up to `nowMs`.
 */
export function dwellMs(
  transitions: StatusTransition[],
  statuses: ReadonlySet<string>,
  nowMs: number
): number {
  let total = 0;
  let enteredAt: number | null = null;
  for (const t of transitions) {
    const entering = t.to !== undefined && statuses.has(t.to);
    if (entering && enteredAt === null) {
      enteredAt = t.at;
    } else if (!entering && enteredAt !== null) {
      total += t.at - enteredAt;
      enteredAt = null;
    }
  }
  if (enteredAt !== null) total += Math.max(0, nowMs - enteredAt);
  return total;
}

/** Convenience: waiting-on-human ms for a gate ticket's changelog. */
export function humanWaitMs(changelog: JiraChangelog | undefined, nowMs = Date.now()): number {
  return dwellMs(extractStatusTransitions(changelog), HUMAN_WAIT_STATUSES, nowMs);
}
