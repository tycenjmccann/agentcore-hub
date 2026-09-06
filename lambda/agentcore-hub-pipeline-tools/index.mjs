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
 *   - start_ci_build: (TEAM-4122 FR-4) Start the PR-CHECK build for one commit,
 *                     so the CI agent can re-run CI on a head it just pushed
 *                     instead of waiting for a webhook that may never fire. The
 *                     project is ALWAYS CI_PROJECT — never a caller argument —
 *                     and the StartBuild input is an allow-list of three keys,
 *                     so no override (buildspec/env/image/privileged/role/source)
 *                     can ride in from the agent's args.
 *   - capabilities:   What this Lambda will actually do in THIS deployment, so an
 *                     agent can branch without probing with a real StartBuild.
 *
 * DELIBERATELY ABSENT: PutApprovalResult. The in-pipeline ManualApproval (deploy
 * gate) is a HUMAN decision, bridged to Telegram (telegram-bug-intake). An agent
 * must never approve its own deploy. This Lambda is read + trigger only. Still
 * true after FR-4: start_ci_build starts a PR CHECK, which deploys nothing, and
 * capabilities reports approveDeploy:false unconditionally.
 *
 * Env:
 *   PIPELINE_NAME       default "agentcore-hub-deploy"  (the CodePipeline)
 *   BUILD_PROJECT       default "agentcore-hub-build"
 *   CI_PROJECT          default "agentcore-hub-ci" — the PR-check project, and the
 *                       ONLY project start_ci_build can ever start. Validated at
 *                       module load (validateCiProjectName): a wildcard, or a name
 *                       that collides with the build/deploy/runtime-image project
 *                       or the pipeline, disables start_ci_build rather than
 *                       pointing agent-triggerable StartBuild at a deploy
 *   PIPELINE_CI_START_BUILD  "1" iff the deploy granted codebuild:StartBuild on
 *                       CI_PROJECT. Read ONLY to advertise the capability — the
 *                       IAM grant is the actual gate, so a lie in either
 *                       direction cannot start (or block) a build by itself
 *   DEPLOY_PROJECT      set on this Lambda by deploy/setup-pipeline-tools-lambda.mjs
 *                       (which also uses it for IAM scoping); read here ONLY to
 *                       refuse a CI_PROJECT that names it. To reach the Deploy
 *                       stage's CodeBuild project (same name as the pipeline,
 *                       different resource kind), callers pass
 *                       project="agentcore-hub-deploy" explicitly to get_build_log
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
  StartBuildCommand,
} from "@aws-sdk/client-codebuild";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const REGION = process.env.AWS_REGION || "us-east-1";
const PIPELINE_NAME = process.env.PIPELINE_NAME || "agentcore-hub-deploy";
const BUILD_PROJECT = process.env.BUILD_PROJECT || "agentcore-hub-build";
const CI_PROJECT = process.env.CI_PROJECT || "agentcore-hub-ci";
const DEPLOY_PROJECT = process.env.DEPLOY_PROJECT || "agentcore-hub-deploy";

// A CodeBuild project that deploys, but is not the pipeline's Deploy stage, so
// the DEPLOY_PROJECT/PIPELINE_NAME comparisons below would not catch it.
const RESERVED_CI_PROJECTS = ["agentcore-hub-runtime-image-deploy"];

/**
 * TEAM-4122 FR-4 (security review F2/F3) — is `name` safe to hand to
 * codebuild:StartBuild on an AGENT's behalf?
 *
 * start_ci_build never accepts a project argument, so this is the only thing
 * standing between "the CI agent re-runs the PR check" and "the CI agent starts a
 * deploy": if CI_PROJECT is misconfigured to name the build/deploy/runtime-image
 * project or the pipeline, the tool refuses instead of starting it. A wildcard is
 * rejected separately from the charset because `*` in a project name is how an
 * over-broad IAM Resource gets copied into config by mistake.
 *
 * Pure and side-effect free: byte-duplicated in
 * deploy/setup-pipeline-tools-lambda.mjs (the Lambda zip is index.mjs only, and
 * importing this module would construct AWS clients in the deploy script), and
 * the two copies are pinned against each other on a shared matrix by
 * deploy/setup-pipeline-tools-lambda.test.mjs.
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateCiProjectName(name, opts = {}) {
  const { buildProject, deployProject, pipelineName } = opts;
  const value = typeof name === "string" ? name : "";
  if (!value) return { ok: false, reason: "CI_PROJECT is empty" };
  if (value.includes("*") || value.includes("?")) {
    return { ok: false, reason: `CI_PROJECT "${value}" contains a wildcard` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/.test(value)) {
    return {
      ok: false,
      reason: `CI_PROJECT "${value}" is not a valid CodeBuild project name (2-255 chars of [A-Za-z0-9_-], starting alphanumeric)`,
    };
  }
  for (const [label, other] of [
    ["BUILD_PROJECT", buildProject],
    ["DEPLOY_PROJECT", deployProject],
    ["PIPELINE_NAME", pipelineName],
    ...RESERVED_CI_PROJECTS.map((p) => ["a reserved deploy project", p]),
  ]) {
    if (other && value === other) {
      return {
        ok: false,
        reason: `CI_PROJECT "${value}" is ${label} — start_ci_build may only start the PR-check project`,
      };
    }
  }
  return { ok: true, reason: null };
}

// Validated ONCE at module load, but never thrown: get_state/get_build_log/
// get_build_status are read-only and must keep working on a deployment whose
// CI_PROJECT is wrong. Only start_ci_build (and the capability it advertises)
// depends on this verdict.
const CI_PROJECT_CHECK = validateCiProjectName(CI_PROJECT, {
  buildProject: BUILD_PROJECT,
  deployProject: DEPLOY_PROJECT,
  pipelineName: PIPELINE_NAME,
});
if (!CI_PROJECT_CHECK.ok) {
  console.warn(`start_ci_build disabled: ${CI_PROJECT_CHECK.reason}`);
}

const cp = new CodePipelineClient({ region: REGION });
const cb = new CodeBuildClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

export const handler = async (event) => {
  let toolName =
    event._tool_name || event.tool_name || event.name || "";
  if (toolName && toolName.includes("___")) {
    toolName = toolName.split("___").pop();
  }
  const args = event.parameters || event.arguments || event.input || event;

  // start_ci_build's args can carry attacker-shaped override keys (buildspec-
  // Override, environmentVariablesOverride, …). They are dropped rather than
  // forwarded — and not echoed into CloudWatch either, so a log reader is never
  // shown a payload that looks like it was honored. Its allow-listed inputs are
  // logged from inside startCiBuild once they have been validated.
  if (toolName === "start_ci_build") {
    console.log(
      "Pipeline tools invoked: start_ci_build",
      JSON.stringify({ argKeys: Object.keys(args || {}).sort() })
    );
  } else {
    console.log("Pipeline tools invoked:", JSON.stringify(event));
  }

  try {
    switch (toolName) {
      case "get_state":
        return await getState(args);
      case "start_deploy":
        return await startDeploy(args);
      case "get_build_log":
        return await getBuildLog(args);
      case "get_build_status":
        return await getBuildStatus(args);
      case "start_ci_build":
        return await startCiBuild(args);
      case "capabilities":
        return capabilities();
      default: {
        const message = `Unknown tool: "${toolName}". Available: get_state, start_deploy, get_build_log, get_build_status, start_ci_build, capabilities`;
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
//
// Execution scoping: GetPipelineState stage statuses can belong to DIFFERENT
// pipeline executions — right after start_deploy a poll can still see the
// PREVIOUS run's all-green stages before Source flips InProgress. Pass the
// execution_id returned by start_deploy to compute terminal/succeeded/failed
// ONLY from stages whose latestExecution matches; matchesExecution:false means
// the new run is not yet visible on any stage (keep polling — never read the
// old run as this run's completion).
async function getState(args = {}) {
  const name = args.pipeline_name || PIPELINE_NAME;
  const executionId = String(args.execution_id || "").trim();
  const state = await cp.send(new GetPipelineStateCommand({ name }));

  const stages = (state.stageStates || []).map((s) => ({
    stage: s.stageName,
    status: s.latestExecution?.status || "Unknown",
    executionId: s.latestExecution?.pipelineExecutionId,
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

  // When an execution_id is given, only the stages whose latest execution IS
  // that execution count toward terminal/succeeded/failed. Omitted → all stages
  // (back-compat with the pre-execution-scoped behavior).
  const scopedStages = executionId
    ? stages.filter((s) => s.executionId === executionId)
    : stages;
  const matchesExecution = executionId ? scopedStages.length > 0 : undefined;

  let anyInProgress, anyFailed, terminal;
  if (executionId) {
    // Scoped path: STAGE-LEVEL status only. actionStates carry no execution id,
    // so a lingering Failed/InProgress action left over from the PREVIOUS run
    // inside a stage whose latestExecution already matches the new id would
    // corrupt the verdict — stage.latestExecution is authoritative for the
    // matched execution. "Stopped" is a failure disposition too (the run will
    // never advance past a stopped stage).
    anyInProgress = scopedStages.some((s) => s.status === "InProgress");
    anyFailed = scopedStages.some(
      (s) => s.status === "Failed" || s.status === "Stopped"
    );
    // Terminal only when the requested execution has a terminal disposition
    // across the WHOLE pipeline: either every stage has caught up to this
    // execution, or a matching stage Failed/Stopped. A Succeeded prefix with
    // later stages still on an older executionId is the mid-transition window
    // (e.g. Source done, Build not yet started) — NOT terminal, keep polling.
    // And ZERO matching stages means the new run isn't visible on any stage
    // yet — never read the old run's state as this run's completion.
    const allStagesMatch =
      matchesExecution && scopedStages.length === stages.length;
    terminal =
      matchesExecution && !anyInProgress && (allStagesMatch || anyFailed);
  } else {
    // Unscoped path (execution_id omitted): the pre-execution-scoped behavior,
    // action-level checks included. Terminal when no stage/action is InProgress.
    anyInProgress = scopedStages.some(
      (s) =>
        s.status === "InProgress" ||
        s.actions.some((a) => a.status === "InProgress")
    );
    anyFailed = scopedStages.some(
      (s) =>
        s.status === "Failed" ||
        s.actions.some((a) => a.status === "Failed")
    );
    terminal = !anyInProgress;
  }
  const pipelineExecutionId =
    executionId ||
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
    // Present only when execution_id was passed: true iff ≥1 stage's latest
    // execution is that execution. When false, terminal/succeeded describe
    // NOTHING about the requested run — keep polling.
    ...(executionId ? { matchesExecution } : {}),
    terminal,
    succeeded: terminal && !anyFailed,
    failed: anyFailed,
    stages,
    actionDetails,
  });
}

// ─── start_deploy ───────────────────────────────────────────────────────────
// Trigger a pipeline run. Use after merge (push auto-trigger is not wired) or to
// re-run after a build-failure fix has landed on the default branch.
// Pass commit_sha (the merge SHA) so the request carries an idempotency token —
// a retried tool call for the same SHA then cannot double-trigger the pipeline.
async function startDeploy(args = {}) {
  const name = args.pipeline_name || PIPELINE_NAME;
  const input = { name };
  // clientRequestToken constraints: ^[a-zA-Z0-9-]+$, 1–128 chars. Sanitize the
  // SHA to that charset; if nothing valid remains (or no SHA was given), OMIT
  // the token entirely — never send an empty/invalid one.
  const rawSha = String(args.commit_sha || "").trim();
  const sanitized = rawSha.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized) {
    input.clientRequestToken = `deploy-${sanitized}`.slice(0, 128);
  }
  const res = await cp.send(new StartPipelineExecutionCommand(input));
  return jsonResult({
    started: true,
    pipelineName: name,
    pipelineExecutionId: res.pipelineExecutionId,
    note: "Deploy stage has an in-pipeline ManualApproval (deploy gate) that a HUMAN approves (Telegram). Poll get_state with execution_id=<this pipelineExecutionId> until terminal:true AND matchesExecution:true.",
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
    // resolvedSourceVersion is the actual commit SHA CodeBuild built (the AWS SDK
    // documents this — NOT sourceVersion, which for a PR build can be a pr/<id>
    // ref). Callers proving "green belongs to the new head" must match on this.
    resolvedSourceVersion: build.resolvedSourceVersion || null,
    sourceVersion: build.sourceVersion || null,
    buildStatus: build.buildStatus,
    currentPhase: build.currentPhase,
    phases,
    logGroup: lg,
    logStream: ls,
    logTail,
  });
}

// ─── get_build_status ─────────────────────────────────────────────────────────
// Prove a build's status for a SPECIFIC commit — the CI agent uses this to
// confirm a green build belongs to the exact head SHA (e.g. after an auto-fix
// push) instead of trusting "the latest build is green". Scans the N most recent
// builds of the project and returns each with its resolvedSourceVersion (the real
// git commit CodeBuild built — sourceVersion may be a pr/<id> ref). If commit_sha
// is given, also returns the matching build + a boolean succeededForCommit.
async function getBuildStatus(args = {}) {
  const project = args.project || CI_PROJECT;
  const commit = (args.commit_sha || "").trim();
  // Clamp scan to an integer in [1, 50]. A negative value would turn
  // ids.slice(0, n) into a from-end slice (silently dropping the NEWEST builds)
  // and 0 would empty the scan; non-numeric input falls back to the default 15.
  const requested = Number(args.scan);
  const scan = Number.isFinite(requested)
    ? Math.min(50, Math.max(1, Math.trunc(requested)))
    : 15;

  const list = await cb.send(
    new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" })
  );
  const ids = (list.ids || []).slice(0, scan);
  if (ids.length === 0) return jsonResult({ project, builds: [], match: null });

  const { builds } = await cb.send(new BatchGetBuildsCommand({ ids }));
  const rows = (builds || []).map((b) => ({
    buildId: b.id,
    buildStatus: b.buildStatus,
    resolvedSourceVersion: b.resolvedSourceVersion || null,
    sourceVersion: b.sourceVersion || null,
    endTime: b.endTime,
  }));

  let match = null;
  if (commit) {
    // Match on resolvedSourceVersion (full or short SHA prefix), newest first.
    match = rows.find(
      (r) =>
        r.resolvedSourceVersion &&
        (r.resolvedSourceVersion === commit ||
          r.resolvedSourceVersion.startsWith(commit) ||
          commit.startsWith(r.resolvedSourceVersion))
    ) || null;
  }

  return jsonResult({
    project,
    requestedCommit: commit || null,
    match,
    succeededForCommit: !!(match && match.buildStatus === "SUCCEEDED"),
    builds: rows,
  });
}

// ─── start_ci_build ───────────────────────────────────────────────────────────
// TEAM-4122 FR-4 — run the PR check for ONE commit. The CI agent calls this after
// it pushes a mechanical auto-fix, because the push may not re-trigger CI (the
// webhook is repo-side and not guaranteed) and "no build" is indistinguishable
// from "build pending" to get_build_status.
//
// Three invariants, in the order they are enforced:
//   1. The project is CI_PROJECT — an env value, validated at module load. args
//      .project is IGNORED, not rejected: a fix-then-retry loop must not learn
//      that naming a different project is even a category of request (F2/F3).
//   2. commit_sha is REQUIRED. It is what makes this tool idempotent — it is both
//      the dedupe key against builds already running and the StartBuild
//      idempotencyToken. A sourceVersion-only call (a branch name) can name a
//      moving target, so "did I already build this?" would be unanswerable (F1).
//   3. The StartBuild input is an ALLOW-LIST of exactly three keys. CodeBuild's
//      *Override inputs can replace the buildspec, the image, the service role and
//      privileged mode — i.e. turn a PR check into arbitrary privileged execution.
//      They are never read from args at all.
async function startCiBuild(args = {}) {
  if (!CI_PROJECT_CHECK.ok) {
    return jsonResult({
      ok: false,
      reason: "ci_project_invalid",
      detail: CI_PROJECT_CHECK.reason,
    });
  }

  const rawSha = String(args.commit_sha ?? "").trim();
  if (!rawSha) {
    return jsonResult({
      ok: false,
      reason: "missing_commit_sha",
      detail: "commit_sha is required — it is the dedupe + idempotency key. Pass the exact head SHA you want CI to prove.",
    });
  }
  if (!/^[0-9a-f]{7,40}$/i.test(rawSha)) {
    return jsonResult({
      ok: false,
      reason: "invalid_commit_sha",
      detail: "commit_sha must be 7-40 hex characters (a git SHA or its short form).",
    });
  }
  const sha = rawSha.toLowerCase();

  const rawSourceVersion = String(args.source_version ?? "").trim();
  const sourceVersion = rawSourceVersion || sha;
  if (!isAllowedSourceVersion(sourceVersion)) {
    return jsonResult({
      ok: false,
      reason: "invalid_source_version",
      detail: 'source_version must be "pr/<number>", a 40-hex commit SHA, or a plain branch name (no refs/ prefix, no "..").',
    });
  }

  // Dedupe BEFORE starting: the same head can be pushed once and re-checked by
  // several agents (CI agent + release manager both watch it), and a duplicate
  // build costs minutes of pipeline time and produces a second, racing verdict
  // for one commit.
  const existing = await findRecentBuildForCommit(CI_PROJECT, sha, 30);
  if (existing) {
    console.log(
      "start_ci_build: reusing build",
      JSON.stringify({
        project: CI_PROJECT,
        buildId: existing.id,
        buildStatus: existing.buildStatus,
      })
    );
    return jsonResult({
      ok: true,
      reused: true,
      buildId: existing.id,
      buildStatus: existing.buildStatus,
      resolvedSourceVersion: existing.resolvedSourceVersion || null,
      project: CI_PROJECT,
    });
  }

  // The allow-list. Do not spread args into this object, ever.
  const input = {
    projectName: CI_PROJECT,
    sourceVersion,
    idempotencyToken: `ci-${sha}`.slice(0, 64),
  };

  let res;
  try {
    res = await cb.send(new StartBuildCommand(input));
  } catch (err) {
    // The IAM grant is the real gate on this tool (PIPELINE_CI_START_BUILD only
    // decides whether the deploy adds the statement), so a denial is a normal,
    // expected answer — reported structurally so the agent can fall back to
    // waiting on the webhook instead of retrying a call it can never make.
    if (err?.name === "AccessDeniedException") {
      return jsonResult({
        ok: false,
        reason: "start_build_not_granted",
        project: CI_PROJECT,
        detail: "This Lambda's role has no codebuild:StartBuild on the CI project. Deploy with PIPELINE_CI_START_BUILD=1 to grant it.",
      });
    }
    if (err?.name === "ResourceNotFoundException") {
      return jsonResult({ ok: false, reason: "project_not_found", project: CI_PROJECT });
    }
    if (err?.name === "InvalidInputException") {
      // CodeBuild rejects a source version this Lambda's shape check accepted
      // (e.g. a branch that does not exist) — same reason code, so the caller
      // has one thing to fix.
      return jsonResult({
        ok: false,
        reason: "invalid_source_version",
        project: CI_PROJECT,
        sourceVersion,
        detail: err.message,
      });
    }
    throw err; // unexpected → the generic handler error path
  }

  const build = res?.build || {};
  console.log(
    "start_ci_build: started",
    JSON.stringify({ project: CI_PROJECT, sourceVersion, buildId: build.id || null })
  );
  return jsonResult({
    ok: true,
    started: true,
    buildId: build.id || null,
    arn: build.arn || null,
    project: CI_PROJECT,
    sourceVersion,
    // Null on a fresh start (CodeBuild has not resolved the ref yet) — poll
    // get_build_status to prove the build belongs to this commit.
    resolvedSourceVersion: build.resolvedSourceVersion || null,
    buildStatus: build.buildStatus || null,
  });
}

/** Allowed source_version shapes. A `refs/...` value or a `..` range is refused
 * outright: both are ways to make one ref name resolve to something other than
 * the branch it appears to name. */
function isAllowedSourceVersion(value) {
  if (/^pr\/\d{1,7}$/.test(value)) return true;
  if (/^[0-9a-f]{40}$/i.test(value)) return true;
  if (value.startsWith("refs/")) return false;
  if (value.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value);
}

/** Is `resolved` (a build's resolvedSourceVersion) the commit `sha` names? Same
 * prefix rule get_build_status matches on, but restricted to hex values so a
 * short branch name can never prefix-match a SHA. */
function commitMatches(resolved, sha) {
  const r = String(resolved || "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(r)) return false;
  return r === sha || r.startsWith(sha) || sha.startsWith(r);
}

/** The newest IN_PROGRESS-or-SUCCEEDED build of `project` for `sha`, or null.
 * Reuses the ListBuildsForProject → BatchGetBuilds scan get_build_status does;
 * BatchGetBuilds does not promise input order, so the ids (which ARE newest-first)
 * drive the walk. A FAILED build is NOT a reuse — re-running a red build for the
 * same commit is exactly what the CI agent calls this tool to do. */
async function findRecentBuildForCommit(project, sha, scan = 30) {
  const list = await cb.send(
    new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" })
  );
  const ids = (list.ids || []).slice(0, scan);
  if (ids.length === 0) return null;

  const { builds } = await cb.send(new BatchGetBuildsCommand({ ids }));
  const byId = new Map((builds || []).filter((b) => b?.id).map((b) => [b.id, b]));
  for (const id of ids) {
    const build = byId.get(id);
    if (!build || !commitMatches(build.resolvedSourceVersion, sha)) continue;
    if (build.buildStatus === "IN_PROGRESS" || build.buildStatus === "SUCCEEDED") {
      return build;
    }
  }
  return null;
}

// ─── capabilities ─────────────────────────────────────────────────────────────
// What this DEPLOYMENT will do, so an agent can branch without probing with a
// real StartBuild (whose only failure signal would be an AccessDenied it cannot
// distinguish from a transient error). approveDeploy is a hard false: there is no
// PutApprovalResult in this Lambda and there is not going to be one.
function capabilities() {
  return jsonResult({
    startCiBuild: process.env.PIPELINE_CI_START_BUILD === "1" && CI_PROJECT_CHECK.ok,
    ciProject: CI_PROJECT,
    buildProject: BUILD_PROJECT,
    deployPipeline: PIPELINE_NAME,
    approveDeploy: false,
    version: 2,
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
