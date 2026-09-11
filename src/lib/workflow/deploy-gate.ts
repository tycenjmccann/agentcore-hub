/**
 * Workflow module — run-scoping for the deploy gate and the "waiting on a human"
 * signal. Pure functions over plain data: no AWS SDK, no fetch, no React, so both
 * the board (a client component) and the sidebar can import it and both are
 * cheaply unit-testable.
 *
 * WHY THIS EXISTS (TEAM-4403). The board's amber "Deploy gate — awaiting approval"
 * banner was scoped to the run's *repo* (TEAM-4336) but not to the run. One parked
 * ManualApproval on `agentcore-hub-deploy` therefore lit up EVERY active hub-repo
 * run, including runs still in development that had never merged anything — so the
 * banner invited a human to approve a deploy that had nothing to do with the run
 * they were looking at. A repo is not an identity; the merge commit is. These
 * helpers tie a waiting CodePipeline execution to the ONE run whose merge produced
 * it, and answer the sidebar's question "is a person being waited on here?".
 *
 * WHY IT LIVES UNDER src/lib/workflow AND NOT src/lib/pipeline: CLAUDE.md — an
 * optional module may use core libs but never another optional module, and
 * `@/lib/pipeline/status` lazy-pulls the AWS SDK. The board already mirrors
 * `isSameRepo` locally rather than importing `@/lib/cd-registry` for exactly this
 * reason (pinned by terminal-outcome-surfaces.test.ts). So the pipeline shapes are
 * mirrored STRUCTURALLY below — the wire payload from /api/pipeline/status is the
 * contract, not a shared TypeScript import.
 */

/** The subset of the pipeline module's `StageState` this file needs off the wire. */
export interface DeployStageLike {
  name: string;
  awaitingApproval?: boolean;
  approvalUrl?: string;
  /** CodePipeline execution parked at this stage. */
  executionId?: string;
  /** Full 40-char source commit SHA of that execution (never the 12-char summary). */
  sourceSha?: string;
}

/** A deploy gate that provably belongs to the run that asked. */
export interface DeployGateMatch {
  name: string;
  approvalUrl?: string;
  executionId?: string;
  /** The execution's source SHA — matched against the run's merge commit. */
  sourceSha: string;
}

/** The agentTasks entries this file reads (keyed by ticketId, see WorkflowState). */
interface AgentTaskLike {
  agentId?: string;
  mergeCommit?: string;
}

/** The list-payload fields the sidebar predicate reads. */
interface AwaitingHumanInput {
  humanNotifications?: Array<{ type?: string; acknowledged?: boolean }>;
  mergeCommit?: string;
}

/**
 * Shortest prefix we will treat as identifying a commit. Git's own abbreviation
 * floor; below it a "match" is coincidence, not identity.
 */
const MIN_SHA_CHARS = 7;

/** Lowercased hex, or "" when the value isn't a usable commit id. */
function normalizeSha(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v : "";
}

/**
 * Do two commit ids name the same commit? Either side may be abbreviated (the
 * release manager may record a short SHA while CodePipeline reports the full 40),
 * so this is a both-ways prefix test with a floor — NOT string equality.
 */
export function shaMatches(a: unknown, b: unknown): boolean {
  const x = normalizeSha(a);
  const y = normalizeSha(b);
  if (!x || !y) return false;
  if (x.length < MIN_SHA_CHARS || y.length < MIN_SHA_CHARS) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * The run's merge commit — the identity we match a CD execution against.
 *
 * `agentTasks` is keyed by ticketId (not agentId), so there is no direct
 * `agentTasks[releaseManagerId]` lookup: scan the entries. The release manager's
 * entry wins when several carry a merge commit (it is the ship-phase author of
 * record); otherwise take the first one present, which keeps working if the RM's
 * agentId is renamed or a different persona records the merge.
 *
 * `commitSha` is deliberately NOT consulted — it is the unmerged feature-branch
 * HEAD and is present on essentially every dev completion, so reading it here
 * would re-create the exact leak this module exists to close (every in-flight run
 * would claim a merge commit and match nothing / anything).
 */
export function mergeCommitOf(
  agentTasks: Record<string, AgentTaskLike | null | undefined> | null | undefined
): string | undefined {
  if (!agentTasks || typeof agentTasks !== "object") return undefined;
  let fallback: string | undefined;
  for (const task of Object.values(agentTasks)) {
    const merge = typeof task?.mergeCommit === "string" ? task.mergeCommit.trim() : "";
    if (!merge) continue;
    const agentId = (task?.agentId || "").toLowerCase();
    if (agentId.includes("release_manager") || agentId.includes("release-manager")) {
      return merge;
    }
    if (!fallback) fallback = merge;
  }
  return fallback;
}

/**
 * The deploy gate for THIS run, or null.
 *
 * Returns non-null only when a stage is awaiting approval AND that execution's
 * source SHA is the run's own merge commit. Every other case is null — no merge
 * commit (the run never shipped, so it cannot own a deploy gate), no waiting
 * stage, or a waiting stage we cannot attribute.
 *
 * That last case is deliberately conservative: when CodePipeline reports no full
 * SHA for the parked execution (e.g. a newer commit superseded it and the Source
 * stage has already advanced past the gate), we show NOTHING rather than fall back
 * to "any awaiting stage". A missing banner is a lost hint; a wrong banner asks a
 * human to approve a production deploy for someone else's change.
 */
export function matchDeployGate(
  stages: DeployStageLike[] | null | undefined,
  mergeCommit: string | null | undefined
): DeployGateMatch | null {
  if (!normalizeSha(mergeCommit)) return null;
  if (!Array.isArray(stages)) return null;
  for (const stage of stages) {
    if (!stage?.awaitingApproval) continue;
    if (!shaMatches(stage.sourceSha, mergeCommit)) continue;
    return {
      name: stage.name,
      approvalUrl: stage.approvalUrl,
      executionId: stage.executionId,
      sourceSha: normalizeSha(stage.sourceSha),
    };
  }
  return null;
}

/**
 * Every source SHA currently parked at a ManualApproval, across all CD targets —
 * the set a sidebar card matches its own merge commit against. Built from the
 * /api/pipeline/status payload; a SHA is globally unique, so no repo scoping is
 * needed to attribute one to a run.
 */
export function waitingApprovalShas(
  pipelines: Array<{ stages?: DeployStageLike[] }> | null | undefined
): string[] {
  if (!Array.isArray(pipelines)) return [];
  const out = new Set<string>();
  for (const target of pipelines) {
    for (const stage of target?.stages || []) {
      if (!stage?.awaitingApproval) continue;
      const sha = normalizeSha(stage.sourceSha);
      if (sha) out.add(sha);
    }
  }
  return [...out];
}

/**
 * Is a person being waited on for this run? The sidebar renders "approval" as the
 * run's stage when this is true, because "development" is a lie while nothing will
 * move until a human acts.
 *
 * Two independent signals:
 *  (a) an UNACKNOWLEDGED `review_needed` notification — the same record the
 *      Telegram bridge pings on, and already present in the /api/workflow/list
 *      payload, so the sidebar needs no per-run fetch. Acknowledging it returns
 *      the card to its real phase.
 *  (b) the run's OWN deploy execution is parked at an approval — matched by merge
 *      commit against `waitingShas`, never by repo.
 */
export function isAwaitingHuman(
  workflow: AwaitingHumanInput | null | undefined,
  waitingShas: Iterable<string> | null | undefined
): boolean {
  const notifications = workflow?.humanNotifications;
  if (Array.isArray(notifications)) {
    for (const n of notifications) {
      if (n?.type === "review_needed" && !n.acknowledged) return true;
    }
  }
  const merge = workflow?.mergeCommit;
  if (!merge || !waitingShas) return false;
  for (const sha of waitingShas) {
    if (shaMatches(sha, merge)) return true;
  }
  return false;
}
