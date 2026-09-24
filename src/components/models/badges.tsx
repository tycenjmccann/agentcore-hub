/**
 * The page's status vocabulary, in one file so the same meaning always gets the
 * same colour. Four trios plus a neutral, and nothing invents a fifth:
 *
 *   success  published / live / healthy   — trustworthy, nothing to do
 *   warning  interim / drift / stale      — usable, but someone should look
 *   info     manual / applying / lambda   — human-set or in-flight
 *   danger   quarantined / probe failed   — actively unusable
 *   neutral  retired / never probed       — absent rather than bad
 *
 * Every badge also carries its state as TEXT (or a titled icon), never as colour
 * alone, so the distinctions survive a monochrome screenshot and a screen reader.
 */

import { Check, Loader2, Minus, X } from "lucide-react";
import type { ApplyStatus, CatalogStatus, PriceSource, ProbeResult } from "./types";

const BADGE = "text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 font-medium";

const SUCCESS = "bg-success-subtle text-success-fg border-success-fg/30";
const WARNING = "bg-warning-subtle text-warning-fg border-warning-fg/30";
const INFO = "bg-info-subtle text-info-fg border-info-fg/30";
const DANGER = "bg-danger-subtle text-danger-fg border-danger-fg/30";
const NEUTRAL = "bg-surface-3 text-muted border-theme";

const PRICE_SOURCE_CLASSES: Record<PriceSource, string> = {
  published: SUCCESS,
  interim: WARNING,
  manual: INFO,
};

const PRICE_SOURCE_TITLES: Record<PriceSource, string> = {
  published: "Price read from the published AWS price list.",
  interim: "Placeholder price pending a published rate - cost math is approximate.",
  manual: "Price entered by hand.",
};

/** Where a price came from, which is how much to trust the cost figures built on it. */
export function PriceSourceBadge({ source, overdue }: { source: PriceSource; overdue?: boolean }) {
  const title = overdue
    ? "Interim price is more than 14 days old - replace it with a published rate."
    : PRICE_SOURCE_TITLES[source];
  return (
    <span className={`${BADGE} ${overdue ? DANGER : PRICE_SOURCE_CLASSES[source]}`} title={title}>
      {source}
      {overdue ? " overdue" : ""}
    </span>
  );
}

const CATALOG_STATUS_CLASSES: Record<CatalogStatus, string> = {
  active: SUCCESS,
  candidate: INFO,
  quarantined: DANGER,
  retired: NEUTRAL,
};

/** A catalog row's lifecycle: only `active` rows are offerable anywhere. */
export function ModelStatusBadge({ status }: { status: CatalogStatus }) {
  return <span className={`${BADGE} ${CATALOG_STATUS_CLASSES[status]}`}>{status}</span>;
}

const APPLY_CLASSES: Record<ApplyStatus, string> = {
  live: SUCCESS,
  drift: WARNING,
  applying: INFO,
  failed: DANGER,
};

/**
 * Whether a deployable is really running what the registry says. `title` carries
 * the why — a runtime has nothing to apply, a drifted harness names both models —
 * so the pill never has to be decoded from its colour.
 */
export function ApplyStatusPill({
  status,
  title,
  testId,
}: {
  status: ApplyStatus;
  title?: string;
  testId?: string;
}) {
  return (
    <span className={`${BADGE} ${APPLY_CLASSES[status]}`} title={title} data-testid={testId}>
      {status}
    </span>
  );
}

/** The deployable's kind. Only harnesses hold a pinned model that can drift. */
export function TypeChip({ type }: { type: "harness" | "runtime" | "lambda" }) {
  const classes =
    type === "harness"
      ? "bg-accent-subtle text-accent-fg border-accent-fg/30"
      : type === "runtime"
        ? "bg-violet-subtle text-violet-fg border-violet-fg/30"
        : INFO;
  return <span className={`${BADGE} ${classes}`}>{type}</span>;
}

/**
 * One probe's outcome. `running` is the client's own knowledge (a probe was just
 * started and no newer result has landed yet), not a server field — the registry
 * only ever reports finished probes.
 */
export function ProbeMark({
  mode,
  result,
  running,
  testId,
}: {
  mode: "api" | "cli";
  result?: ProbeResult;
  running?: boolean;
  testId?: string;
}) {
  const state = running ? "running" : !result ? "never run" : result.ok ? "passed" : "failed";
  const seconds = result?.seconds != null ? ` in ${result.seconds}s` : "";
  const title = running
    ? `${mode} probe running`
    : !result
      ? `${mode} probe never run`
      : `${mode} probe ${result.ok ? "passed" : "failed"}${seconds} at ${result.at}`;

  const tone = running ? INFO : !result ? NEUTRAL : result.ok ? SUCCESS : DANGER;
  const Icon = running ? Loader2 : !result ? Minus : result.ok ? Check : X;

  return (
    <span className={`${BADGE} inline-flex items-center gap-1`} data-testid={testId}>
      <span className="font-mono text-muted">{mode}</span>
      <span className={`${tone} rounded-full border px-1 inline-flex items-center gap-0.5`}>
        <Icon className={`w-2.5 h-2.5 ${running ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
        <span title={title}>{state}</span>
      </span>
    </span>
  );
}
