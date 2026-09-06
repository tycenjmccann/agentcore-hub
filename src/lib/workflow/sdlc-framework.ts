/**
 * SDLC framework badge — shared, client-safe helper (TEAM-3048).
 *
 * The single source of truth for normalizing a raw `sdlcFramework` value and
 * for the badge's label/tooltip/class mapping. Render sites must go through
 * this module — no branching on the raw value anywhere else.
 */

export type SdlcFramework = "standard" | "playbook" | "aidlc";

/**
 * Normalizes any raw value. Only the exact strings "playbook" and "aidlc"
 * select those frameworks; undefined | null | "" | unrecognized | non-string
 * → "standard" (the classic requirements → design → dev → QA pipeline). The
 * value is stamped on the workflow row at start from the def's sdlcFramework,
 * so legacy rows without it are, correctly, standard runs.
 */
export function resolveSdlcFramework(value: unknown): SdlcFramework {
  if (value === "playbook" || value === "aidlc") return value;
  return "standard";
}

export const SDLC_BADGE_META: Record<
  SdlcFramework,
  {
    label: string;
    tooltip: string;
    boardClassName: string;
    listClassName: string;
  }
> = {
  standard: {
    label: "STANDARD",
    tooltip: "Standard pipeline — requirements, parallel design, development, QA and ship.",
    boardClassName: "sdlc-badge sdlc-badge--standard",
    listClassName:
      "text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider whitespace-nowrap flex-shrink-0 text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] border-current",
  },
  playbook: {
    label: "PLAYBOOK",
    tooltip: "Playbook framework — expect intent, spec, and plan artifacts.",
    boardClassName: "sdlc-badge sdlc-badge--playbook",
    listClassName:
      "text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider whitespace-nowrap flex-shrink-0 text-[var(--accent-fg)] bg-[var(--accent-subtle)] border-current",
  },
  aidlc: {
    label: "AI-DLC",
    tooltip:
      "AI-DLC framework — expect user_stories, tasks_plan, and validation_report artifacts.",
    boardClassName: "sdlc-badge sdlc-badge--aidlc",
    listClassName:
      "text-[9px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider whitespace-nowrap flex-shrink-0 text-[var(--violet-fg)] bg-[var(--violet-subtle)] border-current",
  },
};
