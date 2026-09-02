/**
 * agentcore-hub-pipeline-tools — CI/CD pipeline tools Lambda.
 *
 * Gives the release_manager (and ci_agent) a first-class way to drive the
 * AWS-native deploy pipeline in PIPELINE mode, instead of shelling `aws
 * codepipeline ...` from the coding runtime (whose IAM role is AccessDenied on
 * CodePipeline/CodeBuild — the reason CD silently no-op'd).
 *
 * Tools (agents call them as "Pipeline___<name>"):
 *   - get_state:      GetPipelineState + the latest execution's per-action
 *                     status/summary. The preflight "is a pipeline configured?"
 *                     check and the watch-to-terminal poll both use this.
 *   - start_deploy:   StartPipelineExecution. RM calls this after merging (the
 *                     GitHub push auto-trigger is not wired), and after a
 *                     build-failure fix lands, to re-run.
 *   - get_build_log:  For a Failed Build stage — the CodeBuild build's phase
 *                     contexts + a tail of its CloudWatch log, so RM can file a
 *                     precise fix ticket (it does NOT hand-fix).
 *
 * DELIBERATELY ABSENT: PutApprovalResult. The in-pipeline ManualApproval (deploy
 * gate) is a HUMAN decision, bridged to Telegram (telegram-bug-intake). An agent
 * must never approve its own deploy. This Lambda is read + trigger only.
 *
 * Env:
 *   PIPELINE_NAME       default "agentcore-hub-deploy"
 *   BUILD_PROJECT       default "agentcore-hub-build"
 *   CI_PROJECT          default "agentcore-hub-ci"
 *   REGION              default from AWS_REGION
 */

import {
  CodePipelineClient,
  GetPipelineStateCommand,
  StartPipelineExecutionCommand,
  ListActionExecutionsCommand,
} from "@aws-sdk/client-codepipeline";
import {
  CodeBuildClient,
  BatchGetBuildsCommand,
  ListBuildsForProjectCommand,
} from "@aws-sdk/client-codebuild";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const REGION = process.env.AWS_REGION || "us-east-1";
const PIPELINE_NAME = process.env.PIPELINE_NAME || "agentcore-hub-deploy";
const BUILD_PROJECT = process.env.BUILD_PROJECT || "agentcore-hub-build";
const CI_PROJECT = process.env.CI_PROJECT || "agentcore-hub-ci";

const cp = new CodePipelineClient({ region: REGION });
const cb = new CodeBuildClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

export const handler = async (event) => {
  console.log("Pipeline tools invoked:", JSON.stringify(event));

  let toolName =
    event._tool_name || event.tool_name || event.name || "";
  if (toolName && toolName.includes("___")) {
    toolName = toolName.split("___").pop();
  }
  const args = event.parameters || event.arguments || event.input || event;

  try {
    switch (toolName) {
      case "get_state":
        return await getState(args);
      case "start_deploy":
        return await startDeploy(args);
      case "get_build_log":
        return await getBuildLog(args);
      default: {
        const message = `Unknown tool: "${toolName}". Available: get_state, start_deploy, get_build_log`;
        return { error: message, content: [{ text: message }] };
      }
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    // A missing pipeline surfaces as a structured, non-throwing signal so the
    // agent's preflight can BLOCK cleanly (vs. an opaque runtime error).
    if (err?.name === "PipelineNotFoundException") {
      return jsonResult({
        configured: false,
        error: `Pipeline "${PIPELINE_NAME}" not found in ${REGION}`,
      });
    }
    return textResult(`Error: ${err.name || "Error"}: ${err.message}`);
  }
};

// ─── get_state ────────────────────────────────────────────────────────────────
// Returns whether a pipeline is configured, each stage's latest status, and the
// most-recent execution's per-action detail (status + externalExecutionSummary +
// log/console url). This is BOTH the preflight probe and the watch poll.
async function getState(args = {}) {
  const name = args.pipeline_name || PIPELINE_NAME;
  const state = await cp.send(new GetPipelineStateCommand({ name }));

  const stages = (state.stageStates || []).map((s) => ({
    stage: s.stageName,
    status: s.latestExecution?.status || "Unknown",
    actions: (s.actionStates || []).map((a) => ({
      action: a.actionName,
      status: a.latestExecution?.status || "Unknown",
      summary: a.latestExecution?.summary,
      token: a.latestExecution?.token ? "<present>" : undefined, // never leak the approval token
      lastStatusChange: a.latestExecution?.lastStatusChange,
      entityUrl: a.entityUrl,
      revisionUrl: a.revisionUrl,
    })),
  }));

  // The pipeline is "terminal" for a given execution when no stage is InProgress.
  const anyInProgress = stages.some(
    (s) =>
      s.status === "InProgress" ||
      s.actions.some((a) => a.status === "InProgress")
  );
  const anyFailed = stages.some(
    (s) =>
      s.status === "Failed" ||
      s.actions.some((a) => a.status === "Failed")
  );
  const pipelineExecutionId =
    state.stageStates?.[0]?.latestExecution?.pipelineExecutionId;

  // Enrich the latest execution with per-action summaries (get_state's stage
  // summaries can lag; list-action-executions carries the failure text/URL).
  let actionDetails = [];
  if (pipelineExecutionId) {
    try {
      const ae = await cp.send(
        new ListActionExecutionsCommand({
          pipelineName: name,
          filter: { pipelineExecutionId },
        })
      );
      actionDetails = (ae.actionExecutionDetails || []).map((d) => ({
        stage: d.stageName,
        action: d.actionName,
        status: d.status,
        summary: d.output?.executionResult?.externalExecutionSummary,
        url: d.output?.executionResult?.externalExecutionUrl,
        // CodeBuild build id lives here on the Build action — get_build_log needs it.
        externalExecutionId: d.output?.executionResult?.externalExecutionId,
      }));
    } catch (e) {
      console.warn("list-action-executions failed (non-fatal):", e.message);
    }
  }

  return jsonResult({
    configured: true,
    pipelineName: name,
    pipelineExecutionId,
    terminal: !anyInProgress,
    succeeded: !anyInProgress && !anyFailed,
    failed: anyFailed,
    stages,
    actionDetails,
  });
}

// ─── start_deploy ───────────────────────────────────────────────────────────
// Trigger a pipeline run. Use after merge (push auto-trigger is not wired) or to
// re-run after a build-failure fix has landed on the default branch.
async function startDeploy(args = {}) {
  const name = args.pipeline_name || PIPELINE_NAME;
  const res = await cp.send(
    new StartPipelineExecutionCommand({ name })
  );
  return jsonResult({
    started: true,
    pipelineName: name,
    pipelineExecutionId: res.pipelineExecutionId,
    note: "Deploy stage has an in-pipeline ManualApproval (deploy gate) that a HUMAN approves (Telegram). Poll get_state until terminal.",
  });
}

// ─── get_build_log ──────────────────────────────────────────────────────────
// For a Failed Build stage: return the build's phase contexts (which phase/
// command failed) + a tail of its CloudWatch log. Accepts an explicit build_id
// (from get_state's actionDetails.externalExecutionId) or falls back to the
// project's most recent build.
async function getBuildLog(args = {}) {
  const project = args.project || BUILD_PROJECT;
  let buildId = args.build_id;

  if (!buildId) {
    const list = await cb.send(
      new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" })
    );
    buildId = list.ids?.[0];
    if (!buildId) return textResult(`No builds found for project ${project}`);
  }

  const { builds } = await cb.send(
    new BatchGetBuildsCommand({ ids: [buildId] })
  );
  const build = builds?.[0];
  if (!build) return textResult(`Build ${buildId} not found`);

  const phases = (build.phases || []).map((p) => ({
    phase: p.phaseType,
    status: p.phaseStatus,
    durationSeconds: p.durationInSeconds,
    contexts: (p.contexts || []).map((c) => ({
      statusCode: c.statusCode,
      message: c.message,
    })),
  }));

  // Tail the CloudWatch log (the failing command's stderr/stdout).
  const tailLines = Math.min(Number(args.tail_lines) || 120, 300);
  let logTail = "";
  const lg = build.logs?.groupName;
  const ls = build.logs?.streamName;
  if (lg && ls) {
    try {
      const ev = await logs.send(
        new GetLogEventsCommand({
          logGroupName: lg,
          logStreamName: ls,
          limit: tailLines,
          startFromHead: false,
        })
      );
      logTail = (ev.events || []).map((e) => e.message).join("");
    } catch (e) {
      logTail = `(log fetch failed: ${e.message})`;
    }
  }

  return jsonResult({
    buildId,
    project,
    buildStatus: build.buildStatus,
    currentPhase: build.currentPhase,
    phases,
    logGroup: lg,
    logStream: ls,
    logTail,
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────
// The runtime's _invoke_lambda keeps only content blocks with type:"text"
// (it filters `c.get("type") == "text"`), so every block MUST carry that type
// or the agent sees an empty result.
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
