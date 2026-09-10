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
 *                     project is ALWAYS a PR-check project this deployment knows
 *                     (env CI_PROJECT or a target's ciProject) — an args.project
 *                     naming anything else is IGNORED, not honored — and the
 *                     StartBuild input is an allow-list of three keys, so no
 *                     override (buildspec/env/image/privileged/role/source) can
 *                     ride in from the agent's args.
 *   - capabilities:   What this Lambda will actually do in THIS deployment, so an
 *                     agent can branch without probing with a real StartBuild.
 *                     Also enumerates every target (see below).
 *
 * ─── TARGETS: the CD registry IS the allow-list (TEAM-4337) ──────────────────
 *
 * This Lambda used to be pinned to ONE pipeline by env. It now resolves the
 * pipeline/projects a call acts on from the CD registry
 * (config/cd-registry.json in ARTIFACT_BUCKET — the same document the
 * orchestrator reads to decide CD vs handoff), so registering a repo is enough
 * to make its pipeline drivable. A TARGET is one such resolved set:
 *
 *   { repo, pipeline, region, ciProject, buildProject, deployProject, isEnvDefault }
 *
 * Targets come from (a) every registry entry that names a `pipeline`, expanded by
 * the hub-<slug>-{ci,build,deploy} naming convention via pipelineProjects(), plus
 * (b) the env default (PIPELINE_NAME/CI_PROJECT/BUILD_PROJECT/DEPLOY_PROJECT in
 * REGION) unless a registry entry already names that pipeline. Registry order
 * first, env default last — deterministic, so `targets[0]` is stable.
 *
 * A registry entry with NO pipeline (a DEPLOY.md-mode CD repo) yields no target:
 * there is nothing here to drive for it.
 *
 * Every tool resolves exactly one target before touching AWS, and REFUSES
 * structurally (never throws, never falls back to the env default) when the
 * caller names something outside the allow-list. The four refusal reasons:
 *
 *   pipeline_not_registered  args.pipeline_name is not any target's pipeline.
 *                            { ok:false, reason, requested, known:[pipelines] }
 *   project_not_registered   the project we landed on — args.project, OR (for
 *                            get_build_log) the project a build_id names, OR
 *                            (for get_build_status/start_ci_build) a project
 *                            resolved some other way — is not any target's
 *                            ci/build/deploy project.
 *                            { ok:false, reason, requested, known:[projects] }
 *   project_mismatch        (TEAM-4348, get_build_log only) args.project and
 *                            the project build_id names ("<project>:<uuid>")
 *                            disagree. Refused rather than picking one, so a
 *                            caller never gets a DIFFERENT build's log than it
 *                            thinks it asked for.
 *                            { ok:false, reason, requested, buildIdProject }
 *   pipeline_name_required   >1 target and a WRITE tool (start_deploy) was called
 *                            without pipeline_name — refusing to guess which repo
 *                            to deploy. args.project cannot substitute (TEAM-4348:
 *                            start_deploy does not take a project at all).
 *                            { ok:false, reason, known:[pipelines] }
 *
 * A refusal makes ZERO AWS calls. With a single target (the pre-TEAM-4337 shape:
 * empty/absent registry) a call that names nothing resolves to the env default,
 * so the single-pipeline behavior is byte-identical to before.
 *
 * Clients are per-region (clientsFor): a target in us-west-2 gets its own
 * CodePipeline/CodeBuild/Logs clients, and (TEAM-4348) the region used is always
 * the OWNER of the project a call actually names, not just whichever target the
 * args happened to resolve — a pipeline_name naming one repo plus a project
 * belonging to another must still reach the project's own region. The S3 client
 * is deliberately NOT fanned out — both S3 reads (the registry and the handoff
 * marker) live in the one artifact bucket in THIS Lambda's region.
 *
 * DELIBERATELY ABSENT: PutApprovalResult. The in-pipeline ManualApproval (deploy
 * gate) is a HUMAN decision, bridged to Telegram (telegram-bug-intake). An agent
 * must never approve its own deploy. This Lambda is read + trigger only. Still
 * true after FR-4 and after multi-target: start_ci_build starts a PR CHECK, which
 * deploys nothing; capabilities reports approveDeploy:false unconditionally; and
 * widening the registry can only ever add a pipeline to READ and TRIGGER, never
 * an approval path.
 *
 * Env:
 *   PIPELINE_NAME       default "agentcore-hub-deploy"  (the env default target's
 *                       CodePipeline)
 *   BUILD_PROJECT       default "agentcore-hub-build"
 *   CI_PROJECT          default "agentcore-hub-ci" — the env default target's
 *                       PR-check project. Validated at MODULE LOAD
 *                       (validateCiProjectName): a wildcard, or a name that
 *                       collides with the build/deploy/runtime-image project or
 *                       the pipeline, disables start_ci_build rather than pointing
 *                       agent-triggerable StartBuild at a deploy. A REGISTRY
 *                       target's ciProject cannot be checked at load (the registry
 *                       is not read yet), so start_ci_build re-validates the
 *                       project it is about to start against EVERY target's
 *                       build/deploy/pipeline names + RESERVED_CI_PROJECTS on each
 *                       call. Same rule, applied later.
 *   PIPELINE_CI_START_BUILD  "1" iff the deploy granted codebuild:StartBuild on
 *                       the PR-check projects. Read ONLY to advertise the
 *                       capability — the IAM grant is the actual gate, so a lie in
 *                       either direction cannot start (or block) a build by itself
 *   DEPLOY_PROJECT      set on this Lambda by deploy/setup-pipeline-tools-lambda.mjs
 *                       (which also uses it for IAM scoping); read here ONLY to
 *                       refuse a CI_PROJECT that names it. To reach the Deploy
 *                       stage's CodeBuild project (same name as the pipeline,
 *                       different resource kind), callers pass
 *                       project="agentcore-hub-deploy" explicitly to get_build_log
 *   ARTIFACT_BUCKET     the artifact bucket, in this Lambda's region. Source of
 *                       BOTH the CD registry (config/cd-registry.json) and the
 *                       Deploy stage's handoff markers. Unset → no S3 call at all:
 *                       the registry is empty and the env default is the only
 *                       target (single-pipeline mode)
 *   CD_REGISTRY_TTL_MS  default 60000 — how long a warm container reuses the
 *                       registry it read. A read failure keeps the last good copy
 *   PIPELINE_REPO       optional "owner/repo" label for the env default target, so
 *                       capabilities() can name the repo it deploys. Cosmetic —
 *                       nothing resolves on it
 *   REGION              default from AWS_REGION
 */

import {
  CodePipelineClient,
  GetPipelineStateCommand,
  GetPipelineExecutionCommand,
  StartPipelineExecutionCommand,
  ListActionExecutionsCommand,
} from "@aws-sdk/client-codepipeline";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
// Byte copy of lambda/orchestrator/cd-registry.mjs (each Lambda zips from its own
// directory). Pinned identical by scripts/check-cd-registry-parity.sh — edit the
// canonical file in lambda/orchestrator/ and re-copy, never this one. Zero imports,
// so it constructs nothing at load.
import { parseCdRegistry, pipelineProjects } from "./cd-registry.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const PIPELINE_NAME = process.env.PIPELINE_NAME || "agentcore-hub-deploy";
const BUILD_PROJECT = process.env.BUILD_PROJECT || "agentcore-hub-build";
const CI_PROJECT = process.env.CI_PROJECT || "agentcore-hub-ci";
const DEPLOY_PROJECT = process.env.DEPLOY_PROJECT || "agentcore-hub-deploy";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
// Cosmetic label for the env default target only — see the Env block above.
const PIPELINE_REPO = (process.env.PIPELINE_REPO || "").trim();

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

// The ENV DEFAULT's verdict, computed once at module load but never thrown:
// get_state/get_build_log/get_build_status are read-only and must keep working on
// a deployment whose CI_PROJECT is wrong. Only capabilities' flat `startCiBuild`
// depends on this value now — start_ci_build re-validates the project it is about
// to start against every target on each call (validateCiProjectAcrossTargets),
// because a registry-derived ciProject does not exist yet at module load.
const CI_PROJECT_CHECK = validateCiProjectName(CI_PROJECT, {
  buildProject: BUILD_PROJECT,
  deployProject: DEPLOY_PROJECT,
  pipelineName: PIPELINE_NAME,
});
if (!CI_PROJECT_CHECK.ok) {
  console.warn(`start_ci_build disabled: ${CI_PROJECT_CHECK.reason}`);
}

/**
 * Re-validate a PR-check project against EVERY target this deployment knows, not
 * just the env default. A registry-derived ciProject reaches us after module load
 * (see the CI_PROJECT env note), so this is where the "start_ci_build may only
 * start a PR check" rule is enforced for it: the name must not be any target's
 * build project, deploy project or pipeline, nor a reserved deploy project.
 */
function validateCiProjectAcrossTargets(name, targets = []) {
  const base = validateCiProjectName(name, {
    buildProject: BUILD_PROJECT,
    deployProject: DEPLOY_PROJECT,
    pipelineName: PIPELINE_NAME,
  });
  if (!base.ok) return base;
  for (const t of targets) {
    const verdict = validateCiProjectName(name, {
      buildProject: t.buildProject,
      deployProject: t.deployProject,
      pipelineName: t.pipeline,
    });
    if (!verdict.ok) return verdict;
  }
  return { ok: true, reason: null };
}

// The S3 client is a single module instance on purpose: the registry and the
// handoff markers both live in the ONE artifact bucket in this Lambda's region.
// Fanning it out per pipeline region would read a bucket that does not exist.
const s3 = new S3Client({ region: REGION });

// CodePipeline/CodeBuild/Logs, memoized per region — a target in another region
// needs its own clients, and a warm container should not rebuild them per call.
const clientsByRegion = new Map();

/** @returns {{cp: CodePipelineClient, cb: CodeBuildClient, logs: CloudWatchLogsClient}} */
function clientsFor(region) {
  const key = region || REGION;
  let set = clientsByRegion.get(key);
  if (!set) {
    set = {
      cp: new CodePipelineClient({ region: key }),
      cb: new CodeBuildClient({ region: key }),
      logs: new CloudWatchLogsClient({ region: key }),
    };
    clientsByRegion.set(key, set);
  }
  return set;
}

// ─── CD registry ──────────────────────────────────────────────────────────────
// The same document the orchestrator reads (lambda/orchestrator/index.mjs
// loadCdRegistry) with the same TTL cache and the same failure directions.

const CD_REGISTRY_KEY = "config/cd-registry.json";
const CD_REGISTRY_TTL_MS = Number(process.env.CD_REGISTRY_TTL_MS) || 60_000;

let registryCache = { version: 1, repos: [] };
let registryLoadedAt = 0;

/**
 * The CD registry, cached for CD_REGISTRY_TTL_MS per warm container.
 *
 * Failure directions, all non-fatal — a registry problem must never take the
 * read-only tools down:
 *   no ARTIFACT_BUCKET → the current (empty) registry, with NO S3 command
 *                        constructed at all. Single-pipeline mode.
 *   NoSuchKey / 404    → empty registry (nothing is registered yet).
 *   any other error    → the LAST GOOD copy is kept and a warning logged, so a
 *                        transient S3 error cannot un-register a live repo
 *                        mid-deploy.
 */
async function loadRegistry({ force = false } = {}) {
  if (!ARTIFACT_BUCKET) return registryCache;
  const now = Date.now();
  if (!force && registryLoadedAt && now - registryLoadedAt < CD_REGISTRY_TTL_MS) {
    return registryCache;
  }
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: CD_REGISTRY_KEY })
    );
    registryCache = parseCdRegistry(await obj.Body.transformToString());
    registryLoadedAt = now;
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      registryCache = { version: 1, repos: [] };
      registryLoadedAt = now;
    } else {
      console.warn("cd-registry read failed (keeping last copy, non-fatal):", e?.name, e?.message);
    }
  }
  return registryCache;
}

/**
 * @typedef {{repo: string|null, pipeline: string, region: string,
 *            ciProject: string, buildProject: string, deployProject: string,
 *            isEnvDefault: boolean}} Target
 */

/**
 * Every target this deployment can act on: one per registry entry that names a
 * pipeline (expanded by pipelineProjects), then the env default unless a registry
 * entry already names that pipeline. Order is deterministic (registry order, env
 * default last) so callers and tests can rely on targets[0].
 *
 * @returns {Promise<Target[]>}
 */
async function listTargets() {
  const registry = await loadRegistry();
  const targets = [];
  const seen = new Set();
  for (const entry of registry?.repos || []) {
    const projects = pipelineProjects(entry);
    // No pipeline → a DEPLOY.md-mode CD repo. Nothing here can drive it.
    if (!projects || seen.has(projects.pipeline)) continue;
    seen.add(projects.pipeline);
    targets.push({
      repo: entry.repo || null,
      pipeline: projects.pipeline,
      region: projects.region || REGION,
      ciProject: projects.ciProject,
      buildProject: projects.buildProject,
      deployProject: projects.deployProject,
      isEnvDefault: false,
    });
  }
  if (!seen.has(PIPELINE_NAME)) {
    targets.push({
      repo: PIPELINE_REPO || null,
      pipeline: PIPELINE_NAME,
      region: REGION,
      ciProject: CI_PROJECT,
      buildProject: BUILD_PROJECT,
      deployProject: DEPLOY_PROJECT,
      isEnvDefault: true,
    });
  }
  return targets;
}

/** Every CodeBuild project name a target owns. */
function projectsOf(target) {
  return [target.ciProject, target.buildProject, target.deployProject].filter(Boolean);
}

/** The target that owns CodeBuild project `name`, or null. */
function targetForProject(targets, name) {
  if (!name) return null;
  return targets.find((t) => projectsOf(t).includes(name)) || null;
}

/**
 * Which target does this invocation act on?
 *
 *   args.pipeline_name  → the target whose `pipeline` matches EXACTLY, else a
 *                         pipeline_not_registered refusal.
 *   args.project        → READ TOOLS ONLY (requirePipelineName false): the
 *                         target owning that ci/build/deploy project, else a
 *                         project_not_registered refusal. Skipped entirely when
 *                         requirePipelineName is true (TEAM-4348) — start_deploy
 *                         does not take a project, and honouring one here would
 *                         let it substitute for the pipeline_name this tool
 *                         refuses to guess.
 *   neither             → the only target, if there is only one (the
 *                         single-pipeline shape). With more than one:
 *                         requirePipelineName → pipeline_name_required refusal;
 *                         otherwise the env default (read-only tools stay usable).
 *
 * The refusal path makes NO AWS call — the point is that an unregistered pipeline
 * is answered from the allow-list, not by asking AWS and leaking whether it
 * exists. The resolved target is returned, never stashed: the caller keeps it in
 * its own scope so two concurrent invocations can never see each other's.
 *
 * @returns {Promise<{target: Target|null, refusal: object|null, targets: Target[]}>}
 */
async function resolveTarget(args = {}, { requirePipelineName = false } = {}) {
  const targets = await listTargets();
  const pipelines = targets.map((t) => t.pipeline);

  const requestedPipeline = String(args.pipeline_name ?? "").trim();
  if (requestedPipeline) {
    const target = targets.find((t) => t.pipeline === requestedPipeline) || null;
    if (!target) {
      return {
        target: null,
        targets,
        refusal: {
          ok: false,
          reason: "pipeline_not_registered",
          requested: requestedPipeline,
          known: pipelines,
        },
      };
    }
    return { target, targets, refusal: null };
  }

  // TEAM-4348: args.project only resolves a target for the READ tools. A WRITE
  // tool (start_deploy, requirePipelineName:true) does not accept a project at
  // all, so this branch is skipped for it rather than letting project stand in
  // for the pipeline_name check below.
  if (!requirePipelineName) {
    const requestedProject = String(args.project ?? "").trim();
    if (requestedProject) {
      const target = targetForProject(targets, requestedProject);
      if (!target) {
        return {
          target: null,
          targets,
          refusal: {
            ok: false,
            reason: "project_not_registered",
            requested: requestedProject,
            known: targets.flatMap(projectsOf),
          },
        };
      }
      return { target, targets, refusal: null };
    }
  }

  if (targets.length === 1) return { target: targets[0], targets, refusal: null };
  if (requirePipelineName) {
    return {
      target: null,
      targets,
      refusal: { ok: false, reason: "pipeline_name_required", known: pipelines },
    };
  }
  const envDefault = targets.find((t) => t.isEnvDefault) || targets[0];
  return { target: envDefault, targets, refusal: null };
}

/**
 * Resolve the target for one tool call and run the tool under it. A refusal
 * short-circuits before any AWS call. On the way out, an error is annotated with
 * the pipeline/region that was actually REQUESTED, so the handler's catch can
 * name them without any long-lived module state — the target exists only in this
 * call's scope.
 */
async function onTarget(args, opts, fn) {
  const { target, refusal, targets } = await resolveTarget(args, opts);
  if (refusal) return jsonResult(refusal);
  try {
    return await fn(target, targets);
  } catch (err) {
    if (err && typeof err === "object" && err.pipeline === undefined) {
      err.pipeline = target.pipeline;
      err.region = target.region;
    }
    throw err;
  }
}

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
        return await onTarget(args, {}, (t) => getState(args, t));
      // The one WRITE against a pipeline: with more than one target it refuses
      // rather than guessing which repo to deploy.
      case "start_deploy":
        return await onTarget(args, { requirePipelineName: true }, (t) => startDeploy(args, t));
      case "get_build_log":
        return await onTarget(args, {}, (t, all) => getBuildLog(args, t, all));
      case "get_build_status":
        return await onTarget(args, {}, (t, all) => getBuildStatus(args, t, all));
      case "start_ci_build":
        return await onTarget(args, {}, (t, all) => startCiBuild(args, t, all));
      case "capabilities":
        return await capabilities(args);
      default: {
        const message = `Unknown tool: "${toolName}". Available: get_state, start_deploy, get_build_log, get_build_status, start_ci_build, capabilities`;
        return { error: message, content: [{ text: message }] };
      }
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    // A missing pipeline surfaces as a structured, non-throwing signal so the
    // agent's preflight can BLOCK cleanly (vs. an opaque runtime error). The name
    // and region come from the annotation onTarget put on the error, so the
    // message describes what the caller ASKED FOR, not the env default; env is
    // the fallback for an error raised outside a resolved target.
    if (err?.name === "PipelineNotFoundException") {
      return jsonResult({
        configured: false,
        error: `Pipeline "${err.pipeline || PIPELINE_NAME}" not found in ${err.region || REGION}`,
      });
    }
    return textResult(`Error: ${err.name || "Error"}: ${err.message}`);
  }
};

// ─── handoff marker ───────────────────────────────────────────────────────────
// A Deploy stage that shipped every code surface but also touched infra-only
// files (runtime create/setup scripts, IAM/env/table scripts) writes the file
// list to pipeline-artifacts/handoff/<sha>.txt and SUCCEEDS. It used to exit 2 —
// a green deploy reported as Failed — so "Failed" meant either a real failure or
// a clean deploy with a follow-up, and only a build log could tell them apart.
// get_state now reports it as data on a succeeded run.
// `cp` is the CALLER's region-correct CodePipeline client; `s3` is always this
// Lambda's own, because the marker lives in the one artifact bucket.
async function handoffForExecution(pipelineName, pipelineExecutionId, cp) {
  if (!ARTIFACT_BUCKET || !pipelineExecutionId) return null;
  let sha = "";
  try {
    const ex = await cp.send(
      new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId })
    );
    sha = ex.pipelineExecution?.artifactRevisions?.[0]?.revisionId || "";
  } catch (e) {
    console.warn("get-pipeline-execution failed (non-fatal):", e.message);
    return null;
  }
  if (!sha) return null;
  // The Build stage truncates the source revision to 12 chars for GIT_SHA, and
  // the Deploy stage keys the marker on that.
  const key = `pipeline-artifacts/handoff/${sha.slice(0, 12)}.txt`;
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key })
    );
    const body = await obj.Body.transformToString();
    const files = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return { sha: sha.slice(0, 12), files };
  } catch (e) {
    // NoSuchKey is the normal case: this deploy had nothing to hand off.
    if (e.name !== "NoSuchKey" && e.name !== "NotFound") {
      console.warn("handoff marker read failed (non-fatal):", e.name, e.message);
    }
    return null;
  }
}

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
async function getState(args = {}, target) {
  // The pipeline is the RESOLVED target's — args.pipeline_name was already
  // validated against the allow-list (or refused) before we got here.
  const name = target.pipeline;
  const { cp } = clientsFor(target.region);
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

  // Present (non-null) when this execution's Deploy stage recorded infra files a
  // human must still deploy. It is NOT a failure — the code deploy succeeded.
  const handoff = await handoffForExecution(name, pipelineExecutionId, cp);

  return jsonResult({
    configured: true,
    pipelineName: name,
    // Which target answered — so a multi-repo agent can prove it polled the
    // pipeline it meant to.
    region: target.region,
    repo: target.repo,
    pipelineExecutionId,
    handoff,
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
//
// With more than one target this REFUSES without pipeline_name
// (pipeline_name_required) rather than defaulting: deploying the wrong repo is
// not a recoverable mistake, and the env default is the hub itself.
// start_deploy takes no `project` argument, and (TEAM-4348) resolveTarget skips
// the args.project branch for this call entirely — an args.project cannot
// substitute for pipeline_name here, it is simply ignored.
async function startDeploy(args = {}, target) {
  const name = target.pipeline;
  const { cp } = clientsFor(target.region);
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
    region: target.region,
    repo: target.repo,
    pipelineExecutionId: res.pipelineExecutionId,
    note: "Deploy stage has an in-pipeline ManualApproval (deploy gate) that a HUMAN approves (Telegram). Poll get_state with execution_id=<this pipelineExecutionId> until terminal:true AND matchesExecution:true.",
  });
}

// ─── get_build_log ──────────────────────────────────────────────────────────
// For a Failed Build stage: return the build's phase contexts (which phase/
// command failed) + a tail of its CloudWatch log. Accepts an explicit build_id
// (from get_state's actionDetails.externalExecutionId) or falls back to the
// project's most recent build.
//
// Project resolution, in order: an explicit args.project → the project named
// INSIDE build_id (CodeBuild ids are literally "<projectName>:<uuid>") → the
// resolved target's build project → env BUILD_PROJECT. The build_id step
// matters because get_state's actionDetails.externalExecutionId is the only
// handle an agent has after a failure, and it already carries the project — so
// a cross-region build log works without the caller knowing which target owns
// it.
//
// TEAM-4348: args.project is NOT pre-validated by resolveTarget for this tool
// (a build_id's project bypasses resolveTarget entirely — it never sees args.
// build_id), so BOTH names are checked here, before any client is constructed:
//   - if args.project and the build_id's project disagree, refuse
//     project_mismatch rather than silently picking one (the caller would get a
//     DIFFERENT build's log than it thinks it asked for);
//   - whatever project we land on must be a REGISTERED one — project_not_
//     registered otherwise. This closes the gap where an unregistered
//     build_id project used to fall back to the resolved target and still run
//     BatchGetBuilds + GetLogEvents, in that target's region.
async function getBuildLog(args = {}, target, targets = []) {
  const explicit = String(args.project ?? "").trim();
  const fromId = parseBuildIdProject(args.build_id);
  if (explicit && fromId && explicit !== fromId) {
    return jsonResult({
      ok: false,
      reason: "project_mismatch",
      requested: explicit,
      buildIdProject: fromId,
    });
  }
  const project = explicit || fromId || target.buildProject || BUILD_PROJECT;
  // Region follows whoever owns that project — never the `|| target` fallback:
  // an unregistered project must be refused, not silently read in whichever
  // region the (possibly unrelated) resolved target happens to sit in.
  const owner = targetForProject(targets, project);
  if (!owner) {
    return jsonResult({
      ok: false,
      reason: "project_not_registered",
      requested: project,
      known: targets.flatMap(projectsOf),
    });
  }
  const { cb, logs } = clientsFor(owner.region);
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
    region: owner.region,
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
//
// TEAM-4348: when args.pipeline_name is also passed, resolveTarget resolves on
// the PIPELINE and never validates args.project against the allow-list (the
// project branch only runs when pipeline_name is absent) — the sibling of the
// get_build_log gap. So the project this function lands on is allow-listed
// here too, and the region used is that project's OWNER, not the
// pipeline_name-resolved target: scanning the wrong region silently returns
// "no builds", which a merge gate reads as "CI never ran" rather than as an
// error.
async function getBuildStatus(args = {}, target, targets = []) {
  const project = String(args.project ?? "").trim() || target.ciProject || CI_PROJECT;
  const owner = targetForProject(targets, project);
  if (!owner) {
    return jsonResult({
      ok: false,
      reason: "project_not_registered",
      requested: project,
      known: targets.flatMap(projectsOf),
    });
  }
  const { cb } = clientsFor(owner.region);
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
  if (ids.length === 0) {
    return jsonResult({ project, region: owner.region, builds: [], match: null });
  }

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
    region: owner.region,
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
//   1. The project is a PR-CHECK project this deployment KNOWS: env CI_PROJECT or
//      some target's ciProject. args.project naming anything else (a build or
//      deploy project, say) is IGNORED, not rejected: a fix-then-retry loop must
//      not learn that naming a different project is even a category of request
//      (F2/F3). Whatever project we land on is then re-validated against EVERY
//      target's build/deploy/pipeline names, so a registry entry cannot smuggle a
//      deploy project in as a "ciProject" either.
//   2. commit_sha is REQUIRED. It is what makes this tool idempotent — it is both
//      the dedupe key against builds already running and the StartBuild
//      idempotencyToken. A sourceVersion-only call (a branch name) can name a
//      moving target, so "did I already build this?" would be unanswerable (F1).
//   3. The StartBuild input is an ALLOW-LIST of exactly three keys. CodeBuild's
//      *Override inputs can replace the buildspec, the image, the service role and
//      privileged mode — i.e. turn a PR check into arbitrary privileged execution.
//      They are never read from args at all.
async function startCiBuild(args = {}, target, targets = []) {
  // Step 1: which PR-check project. An args.project that is not a known PR-check
  // project falls back to the resolved target's — silently, by design.
  const knownCiProjects = new Set([CI_PROJECT, ...targets.map((t) => t.ciProject)].filter(Boolean));
  const requested = String(args.project ?? "").trim();
  const project =
    requested && knownCiProjects.has(requested) ? requested : target.ciProject || CI_PROJECT;

  const check = validateCiProjectAcrossTargets(project, targets);
  if (!check.ok) {
    return jsonResult({
      ok: false,
      reason: "ci_project_invalid",
      detail: check.reason,
    });
  }
  // TEAM-4348: region follows the project's OWNER, not the (possibly
  // unrelated) target pipeline_name resolved — a pipeline_name naming one repo
  // plus a ciProject belonging to another used to send the dedupe scan and
  // StartBuild to a region where the project does not exist. The `|| target`
  // fallback is safe HERE and only here: `project` is already constrained to
  // knownCiProjects and re-validated above, so it can never be an unregistered
  // name reaching AWS (contrast get_build_log/get_build_status, which refuse
  // instead of falling back).
  const owner = targetForProject(targets, project) || target;
  const { cb } = clientsFor(owner.region);

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
  const existing = await findRecentBuildForCommit(cb, project, sha, 30);
  if (existing) {
    console.log(
      "start_ci_build: reusing build",
      JSON.stringify({
        project,
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
      project,
      region: owner.region,
    });
  }

  // The allow-list. Do not spread args into this object, ever.
  const input = {
    projectName: project,
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
        project,
        detail: "This Lambda's role has no codebuild:StartBuild on the CI project. Deploy with PIPELINE_CI_START_BUILD=1 to grant it.",
      });
    }
    if (err?.name === "ResourceNotFoundException") {
      return jsonResult({ ok: false, reason: "project_not_found", project });
    }
    if (err?.name === "InvalidInputException") {
      // CodeBuild rejects a source version this Lambda's shape check accepted
      // (e.g. a branch that does not exist) — same reason code, so the caller
      // has one thing to fix.
      return jsonResult({
        ok: false,
        reason: "invalid_source_version",
        project,
        sourceVersion,
        detail: err.message,
      });
    }
    throw err; // unexpected → the generic handler error path
  }

  const build = res?.build || {};
  console.log(
    "start_ci_build: started",
    JSON.stringify({ project, sourceVersion, buildId: build.id || null })
  );
  return jsonResult({
    ok: true,
    started: true,
    buildId: build.id || null,
    arn: build.arn || null,
    project,
    region: owner.region,
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

/** The project a CodeBuild build id names. Build ids are "<projectName>:<uuid>",
 * so the id an agent already holds from get_state's actionDetails carries the
 * project — no extra lookup needed to fetch its log. Null when there is no colon
 * or nothing before it. */
function parseBuildIdProject(buildId) {
  const value = String(buildId ?? "").trim();
  if (!value.includes(":")) return null;
  return value.split(":")[0] || null;
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
async function findRecentBuildForCommit(cb, project, sha, scan = 30) {
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
//
// version 3 adds `targets` — every pipeline/project set this deployment can act
// on, so an agent can discover the right pipeline_name instead of assuming the
// env default. The flat startCiBuild/ciProject/buildProject/deployPipeline keys
// describe the ENV DEFAULT and are kept for callers written against version 2.
// Optional args.pipeline_name narrows `targets` to that one (and refuses with
// pipeline_not_registered if it is not a target at all).
async function capabilities(args = {}) {
  const targets = await listTargets();
  const requested = String(args.pipeline_name ?? "").trim();
  let listed = targets;
  if (requested) {
    listed = targets.filter((t) => t.pipeline === requested);
    if (listed.length === 0) {
      return jsonResult({
        ok: false,
        reason: "pipeline_not_registered",
        requested,
        known: targets.map((t) => t.pipeline),
      });
    }
  }
  const flagOn = process.env.PIPELINE_CI_START_BUILD === "1";
  return jsonResult({
    startCiBuild: flagOn && CI_PROJECT_CHECK.ok,
    ciProject: CI_PROJECT,
    buildProject: BUILD_PROJECT,
    deployPipeline: PIPELINE_NAME,
    approveDeploy: false,
    version: 3,
    targets: listed.map((t) => ({
      repo: t.repo,
      pipeline: t.pipeline,
      region: t.region,
      ciProject: t.ciProject,
      buildProject: t.buildProject,
      deployProject: t.deployProject,
      // Per target: the flag is deployment-wide, but a target whose ciProject
      // fails validation cannot be started even so.
      startCiBuild: flagOn && validateCiProjectAcrossTargets(t.ciProject, targets).ok,
    })),
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
