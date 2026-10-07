/**
 * TEAM-5375: the hub's one Jira status vocabulary.
 *
 * TEAM-5358 FR-3 says a cancelled ticket lands on Won't Do, never Done. The
 * cancelled-status names used to be copied into every hub Jira reader and every
 * transition picker, and the copies drifted: exact-case readers turned "Wont Do"
 * into open `todo` work, and the cancel pickers took a transition by its NAME,
 * so a transition named "Cancel" that ends in Done force-closed cancelled work
 * as shipped. Every hub path reads from here instead.
 *
 * PARITY: the Jira Lambda (lambda/agentcore-hub-jira/index.mjs) is its own deploy
 * unit and keeps its own `CANCELLED_JIRA_NAMES` / `mapStatusToInternal`;
 * jira-status-lambda-parity.test.ts pins it to this module.
 */

/** Normalized Jira status names that mean "cancelled". PARITY: CANCELLED_JIRA_NAMES in the Jira Lambda. */
export const CANCELLED_STATUS_NAMES = ["won't do", "wont do", "cancelled", "canceled"] as const;

/** The Jira status a cancel lands on. */
export const CANCEL_JIRA_STATUS = "Won't Do";

/** Wire error for "this issue's workflow has no cancel status". Same string as the Jira Lambda's. */
export const CANCEL_STATUS_MISSING = "cancel_status_missing";

/** Trim, lowercase, and fold curly / modifier apostrophes to `'`. */
export function normalizeJiraStatusName(name: unknown): string {
  return String(name ?? "").trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
}

/** True for any spelling of Won't Do / Cancelled, whatever its case or apostrophe. */
export function isCancelledStatusName(name: unknown): boolean {
  return (CANCELLED_STATUS_NAMES as readonly string[]).includes(normalizeJiraStatusName(name));
}

// ─── Status Mapping ────────────────────────────────────────────────────────────

/** Maps Jira status display names (case-insensitive) to internal status values */
export const JIRA_STATUS_TO_INTERNAL: Record<string, string> = {
  "to do": "todo",
  "todo": "todo",
  "ready": "ready",
  "open": "todo",
  "in progress": "in_progress",
  "in review": "in_review",
  "done": "done",
  "closed": "done",
  "resolved": "done",
  "blocked": "blocked",
  // TEAM-5358 FR-3: a cancelled ticket is closed, never open work.
  ...Object.fromEntries(CANCELLED_STATUS_NAMES.map((n) => [n, "cancelled"])),
};

/** Maps internal status values to Jira transition names */
export const INTERNAL_STATUS_TO_JIRA: Record<string, string> = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: CANCEL_JIRA_STATUS,
};

/**
 * Normalize a Jira status name to an internal status string.
 * Falls back to the lowercased input if no mapping found.
 */
export function mapJiraStatusToInternal(jiraStatus: string): string {
  if (isCancelledStatusName(jiraStatus)) return "cancelled";
  const normalized = jiraStatus.toLowerCase().trim();
  return JIRA_STATUS_TO_INTERNAL[normalized] || normalized;
}

// ─── Cancel transition ─────────────────────────────────────────────────────────

export interface JiraTransitionLike {
  id: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

/**
 * The transition that cancels an issue: its DESTINATION must be a cancel status.
 * The transition's name is never read — a "Cancel" transition that ends in Done
 * is a Done. `to.statusCategory` cannot qualify one either: Jira files Won't Do
 * under the `done` category, the same as Done itself.
 */
export function pickCancelTransition<T extends JiraTransitionLike>(transitions: readonly T[]): T | null {
  return transitions.find((t) => isCancelledStatusName(t.to?.name)) ?? null;
}

/** The issue has no Won't Do / Cancelled transition. Never answered with a Done one. */
export class CancelStatusMissingError extends Error {
  readonly code = CANCEL_STATUS_MISSING;
  constructor(readonly issueKey: string, readonly available: string[] = []) {
    super(`No Won't Do / Cancelled transition for ${issueKey}`);
    this.name = "CancelStatusMissingError";
  }
}
