/**
 * Pipeline module (bolt-on) — server-side status reads.
 *
 * Reads each CD target's CI CodeBuild project (recent builds) and its deploy
 * CodePipeline (stage state). Pure reads; no triggers here. Core never imports
 * this — it lives under the optional `pipeline` module surface only.
 *
 * Multi-target (TEAM-4336): the hub merges + deploys every repo in the CD
 * registry, each with its own pipeline in its own region, so this returns a LIST
 * of targets rather than one global status. Targets come from the registry
 * (derived via pipelineProjectsFor) plus the env default pipeline when no entry
 * already names it. One target's AWS failure populates only that target's
 * `error` — the rest still render.
 */
import {
  CodeBuildClient,
  ListBuildsForProjectCommand,
  BatchGetBuildsCommand,
} from "@aws-sdk/client-codebuild";
import {
  CodePipelineClient,
  GetPipelineStateCommand,
} from "@aws-sdk/client-codepipeline";
import { DEFAULT_REGION } from "@/lib/agentcore-sdk";
import {
  loadCdRegistry,
  normalizeRepoKey,
  pipelineProjectsFor,
  type CdRegistry,
} from "@/lib/cd-registry";

const CI_PROJECT = process.env.PIPELINE_CI_PROJECT || "agentcore-hub-ci";
const DEPLOY_PIPELINE =
  process.env.PIPELINE_DEPLOY_NAME || "agentcore-hub-deploy";

export interface CiBuildSummary {
  id: string;
  status: string; // SUCCEEDED | FAILED | IN_PROGRESS | STOPPED | FAULT | TIMED_OUT
  sourceVersion?: string;
  startedAt?: string;
  endedAt?: string;
  logUrl?: string;
}

export interface StageState {
  name: string;
  status: string; // Succeeded | Failed | InProgress | ... | Unknown
  lastUpdated?: string;
  revisionSummary?: string;
  // A ManualApproval action in this stage currently awaiting a human decision
  // (has a token + InProgress). Powers the "deploy gate waiting" signal in the
  // workflow board — otherwise the post-merge deploy gate is invisible in the UI.
  awaitingApproval?: boolean;
  approvalUrl?: string; // the action's entityUrl (view-commit / review link)
  // Execution identity (TEAM-4403): WHICH pipeline execution is parked here, and
  // which source commit produced it. The board's deploy-gate banner was
  // repo-scoped, so one parked approval leaked onto every active run of that
  // repo; with these the banner is scoped to the run whose commit is actually at
  // the gate. `sourceSha` is derived from `actionStates[].currentRevision` on the
  // state we already fetched because the task role is granted only
  // codepipeline:GetPipelineState — GetPipelineExecution is not available to us.
  executionId?: string;
  /** Full 40-char source commit SHA; undefined when it cannot be tied to `executionId`. */
  sourceSha?: string;
}

/** One CD target: a registered repo's pipeline, or the env default pipeline. */
export interface PipelineTargetStatus {
  /** Registry repo key (`owner/repo`); "" for the env default target. */
  repo: string;
  pipeline: string;
  region: string;
  ciProject: string;
  recentBuilds: CiBuildSummary[];
  stages: StageState[];
  error?: string;
}

export interface PipelineStatus {
  enabled: boolean;
  pipelines: PipelineTargetStatus[];
}

export function isPipelineEnabled(value = process.env.PIPELINE_ENABLED): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** The resource names of one target, before its AWS state is read. */
interface PipelineTarget {
  repo: string;
  pipeline: string;
  region: string;
  ciProject: string;
}

function envTarget(registry: CdRegistry): PipelineTarget {
  // Attribute the env default pipeline to a registry entry that names it, so the
  // target is self-describing. Unreachable while targets are deduped by pipeline
  // name (such an entry already produced its own target) — kept so the field
  // stays honest if that rule ever changes.
  const owner = registry.repos.find((e) => e.pipeline === DEPLOY_PIPELINE);
  return {
    repo: owner?.repo || "",
    pipeline: DEPLOY_PIPELINE,
    region: DEFAULT_REGION,
    ciProject: CI_PROJECT,
  };
}

/**
 * Every CD target, or just one repo's when `repo` is given (an unknown or
 * unregistered repo narrows to the env default target — the caller is expected
 * to check the returned `repo` before acting on it).
 */
export async function getPipelineStatus(
  { repo }: { repo?: string } = {}
): Promise<PipelineStatus> {
  // The registry lives in S3; a fresh/offline install still gets the env target.
  let registry: CdRegistry = { version: 1, repos: [] };
  try {
    registry = await loadCdRegistry();
  } catch {
    /* no registry reachable — env default only */
  }

  const targets: PipelineTarget[] = [];
  for (const entry of registry.repos) {
    const projects = pipelineProjectsFor(entry);
    if (!projects) continue; // registered, but no pipeline (legacy DEPLOY.md path)
    targets.push({
      repo: entry.repo,
      pipeline: projects.pipeline,
      region: projects.region,
      ciProject: projects.ciProject,
    });
  }
  // Dedupe by pipeline name: a registry entry naming the env default pipeline
  // owns it (its region/ciProject win over the env defaults).
  const fallback =
    targets.find((t) => t.pipeline === DEPLOY_PIPELINE) || envTarget(registry);
  if (!targets.some((t) => t.pipeline === DEPLOY_PIPELINE)) targets.push(fallback);

  let selected = targets;
  if (repo !== undefined && String(repo).trim()) {
    const key = normalizeRepoKey(repo);
    const mine = key ? targets.filter((t) => t.repo === key) : [];
    selected = mine.length > 0 ? mine : [fallback];
  }

  const clients = new Map<
    string,
    { cb: CodeBuildClient; cp: CodePipelineClient }
  >();
  const clientsFor = (region: string) => {
    let pair = clients.get(region);
    if (!pair) {
      pair = {
        cb: new CodeBuildClient({ region }),
        cp: new CodePipelineClient({ region }),
      };
      clients.set(region, pair);
    }
    return pair;
  };

  const pipelines = await Promise.all(
    selected.map(async (t): Promise<PipelineTargetStatus> => {
      const status: PipelineTargetStatus = { ...t, recentBuilds: [], stages: [] };
      try {
        const { cb, cp } = clientsFor(t.region);
        const [builds, state] = await Promise.all([
          recentBuilds(cb, t.region, t.ciProject),
          pipelineStages(cp, t.pipeline),
        ]);
        status.recentBuilds = builds;
        status.stages = state;
      } catch (e) {
        // Per-target isolation: one repo's missing pipeline / AccessDenied must
        // not blank out every other target on the board.
        status.error = e instanceof Error ? e.message : String(e);
      }
      return status;
    })
  );

  return { enabled: isPipelineEnabled(), pipelines };
}

async function recentBuilds(
  cb: CodeBuildClient,
  region: string,
  ciProject: string
): Promise<CiBuildSummary[]> {
  const list = await cb.send(
    new ListBuildsForProjectCommand({ projectName: ciProject })
  );
  const ids = (list.ids || []).slice(0, 8);
  if (ids.length === 0) return [];
  const detail = await cb.send(new BatchGetBuildsCommand({ ids }));
  return (detail.builds || []).map((b) => ({
    id: b.id || "",
    status: b.buildStatus || "UNKNOWN",
    sourceVersion: b.sourceVersion,
    startedAt: b.startTime?.toISOString(),
    endedAt: b.endTime?.toISOString(),
    logUrl:
      b.logs?.deepLink ||
      (b.logs?.groupName
        ? `https://console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(
            b.logs.groupName
          )}`
        : undefined),
  }));
}

/**
 * The subset of a GetPipelineState stage this module reads. Structural on
 * purpose: the SDK shape satisfies it, and the pure helper below stays directly
 * testable without constructing SDK types.
 */
interface RawStageState {
  stageName?: string;
  latestExecution?: { pipelineExecutionId?: string; status?: string };
  actionStates?: Array<{
    entityUrl?: string;
    currentRevision?: { revisionId?: string };
    latestExecution?: { token?: string; status?: string; lastStatusChange?: Date };
  }>;
}

/** A source commit SHA, as opposed to the 12-char `revisionSummary` digest. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

const fullShaIn = (stage: RawStageState | undefined): string | undefined =>
  (stage?.actionStates || [])
    .map((a) => a.currentRevision?.revisionId)
    .find((id): id is string => !!id && FULL_SHA.test(id));

/**
 * The full source commit SHA behind one pipeline execution, from GetPipelineState
 * alone (the task role has no codepipeline:GetPipelineExecution).
 *
 * `ownStage` wins when it carries a full SHA of its own; otherwise the SHA comes
 * from any stage still reporting the SAME `pipelineExecutionId` — that is how the
 * Source stage's revision is tied to the parked execution. A superseded execution,
 * whose Source stage has already advanced to a newer commit, legitimately yields
 * undefined rather than a wrong SHA; callers must treat that conservatively.
 */
export function sourceShaForExecution(
  stageStates: RawStageState[],
  executionId?: string,
  ownStage?: RawStageState
): string | undefined {
  const own = fullShaIn(ownStage);
  if (own) return own;
  if (!executionId) return undefined;
  for (const s of stageStates || []) {
    if (s === ownStage) continue;
    if (s.latestExecution?.pipelineExecutionId !== executionId) continue;
    const sha = fullShaIn(s);
    if (sha) return sha;
  }
  return undefined;
}

async function pipelineStages(
  cp: CodePipelineClient,
  pipelineName: string
): Promise<StageState[]> {
  const st = await cp.send(new GetPipelineStateCommand({ name: pipelineName }));
  const stageStates: RawStageState[] = st.stageStates || [];
  return stageStates.map((s) => {
    // A ManualApproval action awaiting a decision has a token + InProgress status.
    const approvalAction = (s.actionStates || []).find(
      (a) => a.latestExecution?.token && a.latestExecution?.status === "InProgress"
    );
    const executionId = s.latestExecution?.pipelineExecutionId;
    return {
      name: s.stageName || "",
      status: s.latestExecution?.status || "Unknown",
      lastUpdated:
        s.actionStates?.[0]?.latestExecution?.lastStatusChange?.toISOString(),
      revisionSummary:
        s.actionStates?.[0]?.currentRevision?.revisionId?.slice(0, 12),
      awaitingApproval: !!approvalAction,
      approvalUrl: approvalAction?.entityUrl,
      executionId,
      sourceSha: sourceShaForExecution(stageStates, executionId, s),
    };
  });
}
