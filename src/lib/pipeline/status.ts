/**
 * Pipeline module (bolt-on) — server-side status reads.
 *
 * Reads the CI CodeBuild project's recent builds and the deploy CodePipeline's
 * state. Pure reads; no triggers here. Core never imports this — it lives under
 * the optional `pipeline` module surface only.
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
}

export interface PipelineStatus {
  enabled: boolean;
  region: string;
  ciProject: string;
  deployPipeline: string;
  recentBuilds: CiBuildSummary[];
  stages: StageState[];
  error?: string;
}

export function isPipelineEnabled(value = process.env.PIPELINE_ENABLED): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const region = DEFAULT_REGION;
  const base: PipelineStatus = {
    enabled: isPipelineEnabled(),
    region,
    ciProject: CI_PROJECT,
    deployPipeline: DEPLOY_PIPELINE,
    recentBuilds: [],
    stages: [],
  };

  const cb = new CodeBuildClient({ region });
  const cp = new CodePipelineClient({ region });

  try {
    const [builds, state] = await Promise.all([
      recentBuilds(cb, region),
      pipelineStages(cp),
    ]);
    base.recentBuilds = builds;
    base.stages = state;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

async function recentBuilds(
  cb: CodeBuildClient,
  region: string
): Promise<CiBuildSummary[]> {
  const list = await cb.send(
    new ListBuildsForProjectCommand({ projectName: CI_PROJECT })
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

async function pipelineStages(cp: CodePipelineClient): Promise<StageState[]> {
  const st = await cp.send(
    new GetPipelineStateCommand({ name: DEPLOY_PIPELINE })
  );
  return (st.stageStates || []).map((s) => ({
    name: s.stageName || "",
    status: s.latestExecution?.status || "Unknown",
    lastUpdated:
      s.actionStates?.[0]?.latestExecution?.lastStatusChange?.toISOString(),
    revisionSummary:
      s.actionStates?.[0]?.currentRevision?.revisionId?.slice(0, 12),
  }));
}
