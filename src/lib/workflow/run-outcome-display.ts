/**
 * TEAM-4249 D2.9 — how a run's TERMINAL OUTCOME reads in the console, and how the
 * orchestrator's out-of-band events read as a one-line notice.
 *
 * Why this is a separate pure module rather than inline component logic:
 *
 *  1. Two surfaces render the same outcome vocabulary (WorkflowBoard's status
 *     header and PipelineVisualization's status description) and had already
 *     drifted — the board knew about the ship-blocked pair, the visualization's
 *     switch fell through to "Idle / Waiting to start..." for anything it did not
 *     enumerate. A run that closed as `nothing-to-remove` therefore rendered as
 *     *still running* in one place and *idle* in the other.
 *
 *  2. `WorkflowEvent` (./types) is a CLOSED union covering the events the board
 *     reduces. The orchestrator also publishes events that are NOT members of it
 *     — `orchestrator.completion_blocked`, `workflow.skipped`,
 *     `workflow.nothing_to_remove` — which reach the UI through
 *     transform-event.ts's `default:` passthrough as `{ type, ...detail,
 *     timestamp }`. They cannot be `case` labels in a `switch (event.type)` over
 *     the union, so they are narrowed STRUCTURALLY here, from `unknown`, and the
 *     board's existing `default:` branches delegate to this module.
 *
 * Workflow is an optional module (src/config/modules.ts): this file imports only
 * from ./types, so it stays removable with the rest of the module.
 *
 * The outcome table is typed `Record<TerminalPhase, …>` against TERMINAL_PHASES,
 * so adding a sixth terminal outcome to types.ts fails `tsc --noEmit` here rather
 * than silently rendering as "In Progress: <slug>".
 */

import {
  NO_OP_OUTCOMES,
  TERMINAL_PHASES,
  isTerminalPhase,
  type NoOpOutcome,
  type WorkflowPhase,
} from "./types";

/** Which colour family / semantic family a run's status reads as. */
export type RunOutcomeTone =
  | "running"
  | "complete"
  | "ship-blocked"
  | "no-op"
  | "cancelled"
  | "error";

export interface RunOutcomeDisplay {
  /**
   * Header text for the outcome, or null when the caller should fall back to its
   * own `In Progress: <phase name>` rendering. Null for every non-terminal phase
   * AND for "complete" with open fix-it tickets (that run is still working — the
   * board names the phase the open tickets belong to).
   */
  label: string | null;
  /** One-line explanation (PipelineVisualization's `text`, tooltips). */
  text: string;
  tone: RunOutcomeTone;
  /** True when the run is finished: pollers, intervals and the SSE nudge stop. */
  finished: boolean;
}

export interface DescribeRunOutcomeOptions {
  /**
   * A "complete" run with open fix-it tickets is NOT finished — preserves the
   * board's long-standing `phase === "complete" && !hasOpenTickets` semantics.
   */
  hasOpenTickets?: boolean;
}

type TerminalPhase = (typeof TERMINAL_PHASES)[number];

interface TerminalOutcomeEntry {
  label: string;
  text: string;
  tone: RunOutcomeTone;
}

/**
 * Strings are lifted VERBATIM from the two pre-existing surfaces so this refactor
 * is invisible for the outcomes that already rendered:
 *   - complete / error / deploy-blocked / static-ci-only →
 *     PipelineVisualization.getStatusDescription()
 *   - the labels → WorkflowBoard's former `shipBlockedLabel` chain
 * run-outcome-display.test.ts pins that parity against the component source.
 */
const TERMINAL_OUTCOMES: Record<TerminalPhase, TerminalOutcomeEntry> = {
  complete: {
    label: "Complete",
    text: "Workflow finished successfully!",
    tone: "complete",
  },
  error: {
    label: "Error",
    text: "Workflow encountered an error.",
    tone: "error",
  },
  cancelled: {
    label: "Cancelled",
    text: "Workflow was cancelled.",
    tone: "cancelled",
  },
  "deploy-blocked": {
    label: "Deploy Blocked",
    text: "CI passed but the deploy/preflight was blocked — nothing shipped.",
    tone: "ship-blocked",
  },
  "static-ci-only": {
    label: "CI-Only (Not Shipped)",
    text: "CI was green but no merge/deploy happened — work is not shipped.",
    tone: "ship-blocked",
  },
  "nothing-to-remove": {
    label: "Nothing to Remove",
    text: "The sweep verified there was nothing safe to remove — no changes were made.",
    tone: "no-op",
  },
};

/** A fresh object per call: callers spread it into React state. */
function running(): RunOutcomeDisplay {
  return { label: null, text: "", tone: "running", finished: false };
}

/**
 * How a phase should read. Unknown/legacy phases read as running, exactly as they
 * did before any terminal-outcome list existed.
 */
export function describeRunOutcome(
  phase: string | null | undefined,
  opts: DescribeRunOutcomeOptions = {}
): RunOutcomeDisplay {
  if (!isTerminalPhase(phase)) return running();
  const entry = TERMINAL_OUTCOMES[phase as TerminalPhase];
  // Defensive: isTerminalPhase and the table are derived from the same list, so
  // this is unreachable — but a missing entry must not render as "undefined".
  if (!entry) return running();
  if (phase === "complete" && opts.hasOpenTickets) {
    return { label: null, text: entry.text, tone: entry.tone, finished: false };
  }
  return { label: entry.label, text: entry.text, tone: entry.tone, finished: true };
}

/**
 * Whether a phase is one of the NO-OP terminal outcomes (the run had nothing to
 * do). Narrows so call sites never re-declare the literal.
 */
export function isNoOpPhase(phase: string | null | undefined): phase is NoOpOutcome {
  return !!phase && (NO_OP_OUTCOMES as readonly string[]).includes(phase);
}

export interface OrchestratorEventDisplay {
  /** The notice line — sanitized and clamped to 240 chars. */
  text: string;
  /**
   * The phase the run should adopt, or null when the event explains something
   * WITHOUT closing the run:
   *   - `orchestrator.completion_blocked` — completion was refused, the run is
   *     still open and re-completes when the gate clears.
   *   - `workflow.skipped` — written against a cadence TOMBSTONE row by
   *     /api/workflow/start; the run never started, so there is no phase to set.
   */
  phase: WorkflowPhase | null;
  tone: RunOutcomeTone;
}

/** Notice lines land in the DOM from a Lambda payload — bound their length. */
const MAX_NOTICE_CHARS = 240;

/** Human wording for the reason slugs the orchestrator publishes. */
const COMPLETION_BLOCKED_REASONS: Record<string, string> = {
  "open-fix": "fix tickets are still open under this epic",
  "head-divergence": "the head that would ship was never verified by every gate persona",
};

/** Mirrors SweepSkipReason in ./sweep-cadence (recent-sweep | open-sweep-pr). */
const SKIP_REASONS: Record<string, string> = {
  "recent-sweep": "a sweep already ran for this repo inside the minimum interval",
  "open-sweep-pr": "an earlier sweep PR is still open",
};

/** Coerce an untrusted field to a single-line, control-char-free string. */
function clean(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(text: string): string {
  const t = clean(text);
  return t.length > MAX_NOTICE_CHARS ? `${t.slice(0, MAX_NOTICE_CHARS - 1)}…` : t;
}

/**
 * Structurally narrow one of the orchestrator's non-`WorkflowEvent` events to a
 * notice line (+ the phase it implies). Returns null for everything else —
 * including every member of the closed WorkflowEvent union, which keeps flowing
 * to its own `case` in the board's switches.
 */
export function describeOrchestratorEvent(raw: unknown): OrchestratorEventDisplay | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (typeof event.type !== "string") return null;

  switch (event.type) {
    case "orchestrator.completion_blocked": {
      const slug = clean(event.reason);
      const reason = COMPLETION_BLOCKED_REASONS[slug] || slug || "reason not reported";
      const offenders = Array.isArray(event.offenders)
        ? event.offenders.map(clean).filter(Boolean)
        : [];
      const detail = offenders.length ? ` (${offenders.length}: ${offenders.join(", ")})` : "";
      return {
        text: clamp(`Completion blocked — ${reason}${detail}`),
        phase: null,
        tone: "ship-blocked",
      };
    }

    case "workflow.skipped": {
      const slug = clean(event.reason);
      const reason = SKIP_REASONS[slug] || slug || "reason not reported";
      const repo = clean(event.repo);
      return {
        text: clamp(`Run skipped — ${reason}${repo ? ` (${repo})` : ""}`),
        phase: null,
        tone: "cancelled",
      };
    }

    case "workflow.nothing_to_remove": {
      const candidates =
        typeof event.candidates === "number" && Number.isInteger(event.candidates)
          ? event.candidates
          : null;
      const text =
        candidates === null
          ? "Nothing to remove — the sweep verified no candidate was safely removable."
          : `Nothing to remove — 0 of ${candidates} candidate${candidates === 1 ? "" : "s"} verified removable.`;
      return { text: clamp(text), phase: NO_OP_OUTCOMES[0], tone: "no-op" };
    }

    default:
      return null;
  }
}
