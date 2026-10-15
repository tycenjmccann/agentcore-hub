/**
 * TEAM-6136 — the TEAM-6032 (DL-038) follow-up PR gate for POST
 * /api/workflow/[id]/complete. NOT a port: the gate is the orchestrator's own
 * `followUpPrGate` (lambda/orchestrator/completion.mjs, pure, no imports beyond
 * repo-check.mjs), so both terminal-completion entry points share one set of
 * exclusions and one fail-open.
 *
 * TEAM-6187 — the gate's INPUTS are built the orchestrator's way too
 * (completeWorkflow, lambda/orchestrator/index.mjs ~3474-3535):
 *   1. fresh-record overlay — `harvestCompletionEvidence(wf, t, false, true)` on
 *      every task: a completions/<t>.json written after the Done stamp overwrites
 *      the task's ship signals (completion.mjs freshRecordFields, the SAME rule);
 *   2. the landing probe — `featureBranchMergeProbe` → completion.mjs
 *      featureBranchLanding: `merged:true` is the gate's mergeProof, `merged:false`
 *      REFUSES completion (CompletionRejectedUnmergedBranch), `null` is fail-open;
 *   3. the follow-up gate itself, with that proof and those tasks.
 * This file only builds the route's deps — the orchestrator's are readCompletionRecord,
 * harvestCompletionEvidence, featureBranchMergeProbe and githubApi (index.mjs).
 */
import {
  dropCarriedOffenders as dropCarriedOffendersMjs,
  followUpPrGate,
  featureBranchLanding,
  freshRecordFields,
  isIntentOnlyReservation,
  readCompletionRecords as readCompletionRecordsMjs,
  recheckShipVerdict as recheckShipVerdictMjs,
  recordedHeads,
} from "../../../lambda/orchestrator/completion.mjs";
import { ghGet, parseGitHubUrl } from "@/lib/workflow/repo-check";

export { followUpPrGate };

type Env = Record<string, string | undefined>;
type AgentTasks = Record<string, Record<string, unknown>>;
type CompletionRecord = Record<string, unknown>;
type ReadCompletionRecord = (ticketId: string) => Promise<CompletionRecord | null>;
type GithubGet = (path: string) => Promise<unknown>;

/** completion.mjs featureBranchLanding's answer (see its JSDoc); only `merged === false` refuses. */
export interface MergeProbe {
  merged: boolean | null;
  mergeCommit?: string;
  prUrl?: string;
  reason?: string;
}

/** The gate's contract (completion.mjs JSDoc). TS would infer `tickets: never[]` and a
 *  zero-arg readCompletionRecord from the .mjs defaults, so the shape is stated here. */
type FollowUpPrGate = (args: {
  workflow: Record<string, unknown>;
  agentTasks: unknown;
  tickets: Array<Record<string, unknown>>;
  mergeProof: MergeProbe | null;
  readCompletionRecord: ReadCompletionRecord;
  getAgentPhase: (agentId: string) => string | undefined;
  api: GithubGet;
  warn: (msg: string) => void;
}) => Promise<string[]>;
const gate = followUpPrGate as unknown as FollowUpPrGate;

/** The ship verdict's shape (completion.mjs evaluateShipVerdict / the route's port). */
interface ShipVerdictLike {
  required: boolean;
  shipped: boolean;
  handoff: boolean;
  outcome: string | null;
  blockReason: string | null;
  offenders: Array<{ ticketId: string; phase?: string; verdict: string }>;
}

/**
 * TEAM-6192 — NOT a port: the orchestrator's own delegation step (completion.mjs
 * dropCarriedOffenders, also called by completeWorkflow's re-check). Drops only the
 * verdict-less offenders verdictCarried excuses; proof-aware for the unified ticket.
 */
type DelegationCtx = {
  children: Array<Record<string, unknown>>;
  agentTasks: unknown;
  records: Record<string, CompletionRecord | null>;
  /** TEAM-6231 F3 — ids whose record read FAILED (not missing): never excused. */
  failed?: Set<string>;
  mergeProof: MergeProbe | null;
  shipPhases?: string[];
  getAgentPhase?: (agentId: string) => string | undefined;
};
export const dropCarriedOffenders = dropCarriedOffendersMjs as unknown as <V extends ShipVerdictLike>(
  verdict: V,
  ctx: DelegationCtx
) => V;

/** TEAM-6231 — the orchestrator's one re-check (completion.mjs recheckShipVerdict): fresh-record
 *  overlay (F2) → `evaluate` (each surface's own evaluateShipVerdict) → dropCarriedOffenders. */
export const recheckShipVerdict = recheckShipVerdictMjs as unknown as <V extends ShipVerdictLike>(
  ctx: Omit<DelegationCtx, "agentTasks"> & { agentTasks: unknown; evaluate: (agentTasks: unknown) => V }
) => V;

/** TEAM-6231 F3 — every id through the reader; a rejection is `null` + listed in `failed`. Never throws. */
export const readCompletionRecords = readCompletionRecordsMjs as unknown as (
  ticketIds: string[],
  read: ReadCompletionRecord
) => Promise<{ records: Record<string, CompletionRecord | null>; failed: Set<string> }>;

type FeatureBranchLanding = (args: {
  owner: string;
  repo: string;
  base: string;
  head: unknown;
  api: GithubGet;
  recordedHeads: string[];
}) => Promise<MergeProbe>;
const landing = featureBranchLanding as unknown as FeatureBranchLanding;

type FreshRecordFields = (
  entry: Record<string, unknown> | undefined,
  record: CompletionRecord,
  opts?: { transitioned?: boolean; hasEvidence?: boolean }
) => { fresh: boolean; fields: Record<string, unknown> };
const freshFields = freshRecordFields as unknown as FreshRecordFields;
const heads = recordedHeads as unknown as (agentTasks: AgentTasks) => string[];

/**
 * Mirror of the orchestrator's `mergeVerifyConfigured` (index.mjs completeWorkflow):
 * SHIP_MERGE_VERIFY not opted out, a ship phase in the def, a feature branch, a
 * repo config and a GitHub token. The `!verdict.handoff` half is the caller's.
 */
export function followUpPrGateConfigured(
  workflow: Record<string, unknown>,
  hasShipPhase: boolean,
  env: Env = process.env
): boolean {
  const optedOut = ["off", "false", "0"].includes(String(env.SHIP_MERGE_VERIFY || "").trim().toLowerCase());
  return !optedOut && hasShipPhase && Boolean(workflow.featureBranch && workflow.repoConfig && env.GITHUB_PAT);
}

/**
 * The gate's / probe's `api`: GET-only, throws on non-2xx like the orchestrator's
 * githubApi — INCLUDING `err.status` (TEAM-6187 §1a): featureBranchLanding reads
 * `err.status === 404` to tell an auto-deleted branch from a failed read.
 */
export function githubApi(token: string | undefined, fetchImpl?: typeof fetch): GithubGet {
  return async (path: string): Promise<unknown> => {
    const r = await ghGet(path, { token, fetchImpl });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`GitHub GET ${path} ${r.status}`) as Error & { status: number };
      err.status = r.status;
      throw err;
    }
    return r.json;
  };
}

/**
 * The orchestrator's `featureBranchMergeProbe(workflow, agentTasks)` (index.mjs):
 * did the feature branch land on the first repo's default branch? Any thrown
 * error → `{ merged: null }` (fail-OPEN; only `merged === false` refuses).
 * `recordedHeads(agentTasks)` binds the deleted-branch proof (TEAM-5913), which is
 * why the OVERLAID tasks must be passed. Never throws.
 */
export async function featureBranchMergeProbe(opts: {
  workflow: Record<string, unknown>;
  agentTasks: AgentTasks;
  api: GithubGet;
  warn?: (msg: string) => void;
}): Promise<MergeProbe> {
  const warn = opts.warn ?? console.warn;
  const id = String(opts.workflow.workflowId ?? opts.workflow.id ?? "");
  try {
    const repoConfig = opts.workflow.repoConfig as { repos?: Array<{ url?: string; defaultBranch?: string }> } | undefined;
    const { owner, repo } = parseGitHubUrl(String(repoConfig?.repos?.[0]?.url || "")) || { owner: "", repo: "" };
    const base = repoConfig?.repos?.[0]?.defaultBranch || "main";
    const probe = await landing({ owner, repo, base, head: opts.workflow.featureBranch, api: opts.api, recordedHeads: heads(opts.agentTasks) });
    if (probe.merged === null && probe.reason) warn(`[complete] merge-verify inconclusive for ${id}: ${probe.reason}`);
    return probe;
  } catch (err) {
    warn(`[complete] merge-verify skipped for ${id}: ${(err as Error)?.message || String(err)}`);
    return { merged: null };
  }
}

/**
 * The orchestrator's pre-probe `harvestCompletionEvidence(wf, ticketId, false, true)`
 * for every task (index.mjs completeWorkflow), minus its DynamoDB write: an entry
 * that has `startedAt` and whose completion record is FRESH (completion.mjs
 * freshRecordFields — written at/after the start and after the Done stamp) gets
 * the record's fields laid over it. Returns a new map (copies; input untouched).
 * A missing record, a reservation (the reader's job) or a failed read leaves the
 * entry as stored. Never throws.
 */
export async function overlayFreshRecords(
  agentTasks: AgentTasks,
  readCompletionRecord: ReadCompletionRecord
): Promise<AgentTasks> {
  const out: AgentTasks = { ...agentTasks };
  await Promise.all(
    Object.entries(agentTasks || {}).map(async ([ticketId, entry]) => {
      if (!entry || typeof entry !== "object" || !entry.startedAt) return;
      try {
        const record = await readCompletionRecord(ticketId);
        if (!record) return;
        const { fresh, fields } = freshFields(entry, record);
        if (!fresh || Object.keys(fields).length === 0) return;
        out[ticketId] = { ...entry, ...fields };
      } catch {
        /* unreadable record: the stored entry stands (orchestrator: warn + skip) */
      }
    })
  );
  return out;
}

/** One read per ticket per completion attempt (the orchestrator's _completionRecordCache). */
export function memoizedReader(read: ReadCompletionRecord): ReadCompletionRecord {
  const cache = new Map<string, Promise<CompletionRecord | null>>();
  return (ticketId) => {
    let p = cache.get(ticketId);
    if (!p) {
      // TEAM-5996: a Done-intent reservation is no record (the orchestrator's readCompletionRecord).
      p = Promise.resolve()
        .then(() => read(ticketId))
        .then((record) => (isIntentOnlyReservation(record) ? null : record));
      cache.set(ticketId, p);
    }
    return p;
  };
}

/**
 * TEAM-6192 — `{ [ticketId]: record | null }` for dropCarriedOffenders, built like
 * completeWorkflow's re-check (every child through the memoized reader, an unreadable
 * record is null).
 */
export async function completionRecordsFor(
  ticketIds: string[],
  read: ReadCompletionRecord
): Promise<Record<string, CompletionRecord | null>> {
  return (await readCompletionRecords(ticketIds, read)).records;
}

export type FollowUpPrOutcome =
  | { unmerged: { reason: string } }
  | { prs: string[]; agentTasks?: AgentTasks; mergeProof?: MergeProbe | null };

/**
 * Overlay → probe → gate, in the orchestrator's order (index.mjs completeWorkflow).
 *   { unmerged: { reason } }  GitHub PROVES the feature branch never landed on the
 *                             default branch — the caller refuses (orchestrator:
 *                             CompletionRejectedUnmergedBranch, run left open).
 *   { prs }                   the open follow-up PR urls that refuse completion;
 *                             [] when there are none or a check could not run
 *                             (fail-open — never throws, so a caller's surrounding
 *                             catch can never be reached through here). TEAM-6192:
 *                             when the checks ran, also the overlaid `agentTasks`
 *                             and the `mergeProof` (merged:true probe, else null)
 *                             the caller's dropCarriedOffenders must use.
 */
export async function openFollowUpPrsAtCompletion(opts: {
  workflow: Record<string, unknown>;
  tickets: Array<Record<string, unknown>>;
  readCompletionRecord: ReadCompletionRecord;
  getAgentPhase: (agentId: string) => string | undefined;
  token: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<FollowUpPrOutcome> {
  const id = String(opts.workflow.workflowId);
  try {
    const readCompletionRecord = memoizedReader(opts.readCompletionRecord);
    const api = githubApi(opts.token, opts.fetchImpl);
    const agentTasks = await overlayFreshRecords((opts.workflow.agentTasks as AgentTasks) || {}, readCompletionRecord);
    const probe = await featureBranchMergeProbe({ workflow: opts.workflow, agentTasks, api });
    if (probe.merged === false) return { unmerged: { reason: probe.reason || "feature branch is not merged into the base" } };
    const mergeProof = probe.merged === true ? probe : null;
    const prs = await gate({
      workflow: { id, ...opts.workflow }, // the gate's warns name `workflow.id`
      agentTasks,
      tickets: opts.tickets,
      mergeProof,
      readCompletionRecord,
      getAgentPhase: opts.getAgentPhase,
      api,
      warn: console.warn,
    });
    return { prs, agentTasks, mergeProof };
  } catch (err) {
    console.warn(`[complete] follow-up PR check skipped for ${id}: ${(err as Error).message}`);
    return { prs: [] };
  }
}
