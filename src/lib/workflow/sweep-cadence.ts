/**
 * Sweep cadence gate (TEAM-4247 D2, FR-D2.4) — should this SCHEDULED dead-code
 * sweep run at all?
 *
 * Nothing stops the fleet re-sweeping the same repo every week while the previous
 * sweep's PR is still open for review. That costs a full 14-agent run, files a
 * second overlapping removal PR against the first one's branch point, and pages a
 * human for a Merge Approval on work a human has not finished reading yet.
 *
 * So a scheduled sweep on a repo that was swept less than {@link SWEEP_CADENCE_DAYS}
 * days ago, or that still has an open sweep PR, is SKIPPED with a tombstone rather
 * than run. Only `trigger: "scheduled"` starts are gated — a human pressing "Run
 * now" has said what they want, and the SI/autonomous filer never submits this def.
 *
 * This module is PURE: no AWS, no fetch, no clock of its own. The caller supplies
 * the workflow rows, the open pull requests and `now`, which is what makes the
 * whole gate testable without a table or a token.
 */

import { parseGitHubUrl } from "./repo-check";
import { NO_OP_OUTCOMES, isTerminalPhase } from "./types";
import type { RepoConfig } from "./types";

/** Minimum days between two SCHEDULED sweeps of the same repo. */
export const SWEEP_CADENCE_DAYS = 14;

/** The one def this gate applies to. */
export const SWEEP_DEF_ID = "dead-code-sweep";

/** Why a sweep was skipped. Both values appear verbatim in the `workflow.skipped` event. */
export type SweepSkipReason = "recent-sweep" | "open-sweep-pr";

export interface SweepWorkflowRow {
  workflowId?: string;
  workflowDefId?: string;
  phase?: string;
  startedAt?: string;
  completedAt?: string;
  /** Tombstones from THIS gate carry type: "skipped" — never counted as a sweep. */
  type?: string;
  deleted?: boolean;
  input?: { repoConfig?: RepoConfig } | null;
  repoConfig?: RepoConfig | null;
}

export interface OpenPullRequestLike {
  number?: number;
  url?: string;
  headRef?: string;
  title?: string;
  labels?: string[];
}

/** What the probe managed to learn, so "skipped" and "found nothing" stay distinguishable. */
export interface PrProbeStatus {
  probed: boolean;
  reason?: string;
}

export interface RecentSweepEvidence {
  repo: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  ageDays: number | null;
  minIntervalDays: number;
  runsConsidered: number;
}

export interface OpenSweepPrEvidence {
  repo: string;
  pr: number | null;
  url: string;
  headRef: string;
  title: string;
}

export type SweepGateEvidence = (RecentSweepEvidence | OpenSweepPrEvidence) & {
  prProbe?: PrProbeStatus;
};

/**
 * off | shadow | enforce — PARITY with normalizeVerifiedHeadMode / the
 * orchestrator's normalizeVerdictMode: UNSET → shadow (observe a new install
 * before it starts refusing runs), PRESENT-but-unrecognized → off (a typo must
 * never silently start skipping scheduled work).
 */
export function normalizeSweepCadenceMode(raw: unknown): "off" | "shadow" | "enforce" {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "shadow";
  const v = String(raw).trim().toLowerCase();
  return v === "off" || v === "shadow" || v === "enforce" ? v : "off";
}

/**
 * The repo a sweep is about, as a stable `owner/name` key (lower-cased so
 * https://github.com/Owner/Repo.git and git@github.com:owner/repo agree).
 * Returns "" when there is no parseable GitHub repo — the caller must then skip
 * the gate entirely rather than compare empty keys, which would make every
 * repo-less run look like the same repo.
 */
export function sweepRepoKey(repoConfig?: RepoConfig | null): string {
  for (const r of repoConfig?.repos ?? []) {
    const gh = parseGitHubUrl(r?.url || "");
    if (gh) return `${gh.owner}/${gh.repo}`.toLowerCase();
  }
  return "";
}

/** The repo key a stored workflow row is about (rows carry repoConfig under `input`). */
function rowRepoKey(row: SweepWorkflowRow): string {
  return sweepRepoKey(row.input?.repoConfig || row.repoConfig || null);
}

/** When a row's sweep happened. `completedAt` if it finished, else `startedAt`. */
function rowAt(row: SweepWorkflowRow): number | null {
  const raw = row.completedAt || row.startedAt;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Was this repo swept too recently?
 *
 * "Swept" is exactly {@link countsAsPriorSweep}: a PRODUCTIVE terminal outcome
 * ("complete" or a no-op outcome) or a LIVE run. A sweep that errored, was
 * cancelled or closed ship-blocked is NOT a sweep and cannot justify a skip.
 *
 * Deliberately NOT counted:
 *   - this gate's own tombstones (`type: "skipped"`), or a skip would make the
 *     next 14 days of ticks skip on the evidence of a skip;
 *   - `deleted` rows (the metrics-only tombstones the DELETE route leaves); and
 *   - failed/abandoned runs (TEAM-4265 F10 — see countsAsPriorSweep).
 */
export function evaluateSweepCadence(args: {
  repo: string;
  rows: SweepWorkflowRow[];
  now: number;
  minIntervalDays?: number;
}): { skip: SweepSkipReason; evidence: RecentSweepEvidence } | null {
  if (!args.repo) return null;
  const evidence = sweepHistoryEvidence(args);
  if (evidence.lastRunAt === null) return null;
  const age = args.now - Date.parse(evidence.lastRunAt);
  return age < evidence.minIntervalDays * DAY_MS ? { skip: "recent-sweep", evidence } : null;
}

/**
 * TEAM-4265 F10 — does this row count as "this repo was swept"?
 *
 * COUNTED:
 *   - `"complete"` — the sweep ran and landed;
 *   - a {@link NO_OP_OUTCOMES} member (`"nothing-to-remove"`) — the sweep did
 *     happen, it just found nothing, and nothing will have changed by next week
 *     either;
 *   - any LIVE row, i.e. one whose phase is not terminal at all — a sweep still in
 *     flight is the strongest possible reason not to start a second one. A row with
 *     NO phase is live by this rule too, on purpose: unknown is not dead.
 *
 * NOT COUNTED — `"error"`, `"cancelled"`, and the ship-blocked outcomes
 * (`"deploy-blocked"`, `"static-ci-only"`). FR-D2.4 means "swept < 14 days ago",
 * not "attempted": a scheduled sweep that crashed three minutes in used to suppress
 * every retry for a fortnight. A blocked sweep whose removal PR is still open is
 * already caught by the open-PR probe, and one whose PR was closed unmerged should
 * be re-sweepable at the next tick.
 *
 * Reads the shared {@link isTerminalPhase}/{@link NO_OP_OUTCOMES} from ./types
 * rather than a hand-written phase list, so a new terminal outcome cannot silently
 * start counting here.
 */
function countsAsPriorSweep(row: SweepWorkflowRow): boolean {
  const phase = row.phase;
  if (phase === "complete") return true;
  if ((NO_OP_OUTCOMES as readonly string[]).includes(String(phase))) return true;
  return !isTerminalPhase(phase);
}

/**
 * What the cadence check SAW: the newest prior sweep of this repo and its age.
 * Separate from the decision because a run the gate lets through still reports
 * this as its evidence (that is what a shadow rollout reads), and re-deriving it
 * by re-running the decision with a zero interval would report nothing.
 *
 * `runsConsidered` reports the FILTERED set — the rows that actually count as a
 * prior sweep of this repo, not every row the Scan returned.
 */
function sweepHistoryEvidence(args: {
  repo: string;
  rows: SweepWorkflowRow[];
  now: number;
  minIntervalDays?: number;
}): RecentSweepEvidence {
  const { repo, rows, now } = args;
  const minIntervalDays = args.minIntervalDays ?? SWEEP_CADENCE_DAYS;

  const mine = rows.filter(
    (r) =>
      r &&
      r.deleted !== true &&
      r.type !== "skipped" &&
      (r.workflowDefId || SWEEP_DEF_ID) === SWEEP_DEF_ID &&
      rowRepoKey(r) === repo &&
      countsAsPriorSweep(r)
  );

  let newest: SweepWorkflowRow | null = null;
  let newestAt = -Infinity;
  for (const r of mine) {
    const at = rowAt(r);
    // A row with no usable timestamp cannot be aged, so it cannot justify a skip.
    if (at === null || at > now) continue;
    if (at > newestAt) {
      newestAt = at;
      newest = r;
    }
  }

  return {
    repo,
    lastRunId: newest?.workflowId ?? null,
    lastRunAt: newest ? new Date(newestAt).toISOString() : null,
    ageDays: newest ? Math.round(((now - newestAt) / DAY_MS) * 10) / 10 : null,
    minIntervalDays,
    runsConsidered: mine.length,
  };
}

/**
 * A dead-code sweep's own PR, still open.
 *
 * MATCH RULE, and why it is a pattern rather than a stored PR id: the previous
 * sweep's PR url is only on that run's workflow row if it got as far as opening
 * one, and a handoff run's PR is opened by the orchestrator at completion — so
 * keying on the branch/title is what catches the case this gate exists for (a
 * sweep PR sitting open for review). A PR counts when its HEAD BRANCH, TITLE or
 * LABELS mention a sweep: the run's shared branch is
 * `feature/<epicId>-<title-slug>` and a sweep's title always contains "dead
 * code" / "sweep" ({@link SWEEP_PR_PATTERN}). Draft PRs count — a draft sweep PR
 * is unreviewed work in flight either way.
 *
 * False positives cost one skipped scheduled sweep (recoverable: "Run now", or
 * next tick after the PR closes); a false negative costs a duplicate 14-agent run
 * and a human paged for a merge they are already mid-review on. Erring toward the
 * skip is the cheaper error.
 */
export const SWEEP_PR_PATTERN = /dead[-_\s]?code|sweep/i;

export function findOpenSweepPr(
  pulls: OpenPullRequestLike[] | null | undefined,
  args: { repo: string }
): { skip: SweepSkipReason; evidence: OpenSweepPrEvidence } | null {
  for (const pr of pulls ?? []) {
    const haystack = [pr?.headRef || "", pr?.title || "", ...(pr?.labels ?? [])].join(" ");
    if (!SWEEP_PR_PATTERN.test(haystack)) continue;
    return {
      skip: "open-sweep-pr",
      evidence: {
        repo: args.repo,
        pr: typeof pr?.number === "number" ? pr.number : null,
        url: pr?.url || "",
        headRef: pr?.headRef || "",
        title: pr?.title || "",
      },
    };
  }
  return null;
}

/**
 * The whole gate: cadence first (one DDB read, always available), then the open-PR
 * probe (a network call that may have been skipped). Returns `null` when the sweep
 * should run, with the cadence evidence still attached to `observed` so a shadow
 * deployment can see what the gate looked at on a run it let through.
 */
export function evaluateSweepGate(args: {
  repo: string;
  rows: SweepWorkflowRow[];
  pulls?: OpenPullRequestLike[] | null;
  prProbe?: PrProbeStatus;
  now: number;
  minIntervalDays?: number;
}): { skip: SweepSkipReason | null; evidence: SweepGateEvidence } {
  const prProbe = args.prProbe ?? { probed: false, reason: "not probed" };
  const cadence = evaluateSweepCadence(args);
  if (cadence) return { skip: cadence.skip, evidence: { ...cadence.evidence, prProbe } };

  const openPr = prProbe.probed ? findOpenSweepPr(args.pulls, { repo: args.repo }) : null;
  if (openPr) return { skip: openPr.skip, evidence: { ...openPr.evidence, prProbe } };

  // Nothing to skip on: report what the cadence check DID see (the newest prior
  // sweep and its age), which is the evidence a shadow rollout is reading.
  return { skip: null, evidence: { ...sweepHistoryEvidence(args), prProbe } };
}

/**
 * The tombstone's primary key: `skip_<owner-repo>_<yyyymmdd>`.
 *
 * DETERMINISTIC on purpose. The tombstone is written with
 * `attribute_not_exists(workflowId)`, so a routine that fires twice in a day (a
 * retry, an overlapping schedule, two hub replicas) writes ONE tombstone and one
 * `workflow.skipped` event instead of a row per tick. A new day gets a new id, so
 * a repo skipped every day for a fortnight leaves a legible daily trail.
 */
export function skipTombstoneId(repo: string, at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  const day = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10).replace(/-/g, "") : "00000000";
  const slug = (repo || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `skip_${slug}_${day}`;
}

export interface SweepSkipTombstone {
  workflowId: string;
  type: "skipped";
  reason: SweepSkipReason;
  evidence: SweepGateEvidence;
  repo: string;
  defId: string;
  at: string;
  /** Keeps the row out of every list/metrics read (listWorkflowsFromDynamo, cost-report). */
  deleted: true;
  /** Terminal everywhere, so no sweep or watchdog treats the row as live work. */
  phase: "cancelled";
  skipReason: "sweep-cadence";
  /** Mirror of `defId` for the consumers that key on the row field name. */
  workflowDefId: string;
  trigger: string;
}

/**
 * The row a skip leaves behind (TEAM-4247 amendment 2 fixes this shape).
 *
 * It is NOT a run: `deleted: true` keeps it out of the workflow list and out of
 * cost-report's terminal scan, and `type: "skipped"` keeps it out of this gate's
 * own cadence evaluation. It exists so the skip is auditable — which repo, which
 * reason, on what evidence, when — and so the deterministic id can dedupe the
 * same day's repeat ticks.
 */
export function buildSkipTombstone(args: {
  repo: string;
  reason: SweepSkipReason;
  evidence: SweepGateEvidence;
  at: Date | string | number;
  defId?: string;
  trigger?: string;
}): SweepSkipTombstone {
  const at = (args.at instanceof Date ? args.at : new Date(args.at)).toISOString();
  const defId = args.defId || SWEEP_DEF_ID;
  return {
    workflowId: skipTombstoneId(args.repo, at),
    type: "skipped",
    reason: args.reason,
    evidence: args.evidence,
    repo: args.repo,
    defId,
    at,
    deleted: true,
    phase: "cancelled",
    skipReason: "sweep-cadence",
    workflowDefId: defId,
    trigger: args.trigger || "scheduled",
  };
}
