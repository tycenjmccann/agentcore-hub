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
 *                     (TEAM-4525) It also RECORDS what the human already
 *                     approved: given approved_head_sha (the head SHA the human
 *                     approved at Merge Approval) it verifies CI is certified on
 *                     that head and writes a SHIP-APPROVAL RECORD to
 *                     pipeline-artifacts/ship-approvals/<merge_commit>.json. The
 *                     pipeline reads that record to decide whether asking the
 *                     same human a SECOND time for byte-identical code is
 *                     necessary. Recording is not approving: see the
 *                     DELIBERATELY ABSENT block below.
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
 *                     (TEAM-4448 D2) It also owns the RETRY decision: a SHA gets
 *                     at most TWO builds, and the second one only when the first
 *                     died in an infra phase (PROVISIONING/DOWNLOAD_SOURCE/
 *                     INSTALL/PRE_BUILD) — not the caller's code. A second infra
 *                     death, or any BUILD-phase failure, is a structural refusal
 *                     (install_flake_retry_failed / build_failed_not_retryable),
 *                     never another build: the cap has to live here, because an
 *                     agent asked to judge "is this flaky?" will always say yes.
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
 * first, env default last — deterministic, but ORDER IS NOT MEANING (TEAM-4358):
 * the env default is the target whose `pipeline === PIPELINE_NAME`, flagged
 * `isEnvDefault`, never `targets[0]`. When the registry names this deployment's
 * own pipeline (the hub's own entry normally does), THAT entry is the env default
 * target — carrying the registry's region/ciProject rather than env's.
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
 * is deliberately NOT fanned out — every S3 access (the registry, the handoff
 * marker, the ship-approval record) is against the HUB's own artifact bucket, in
 * the hub account, in THIS Lambda's region. A cross-account target's assumed
 * role is never used for it: the record is hub state, not the foreign account's.
 *
 * DELIBERATELY ABSENT: PutApprovalResult. The in-pipeline ManualApproval (deploy
 * gate) is a HUMAN decision, bridged to Telegram (telegram-bug-intake). An agent
 * must never approve its own deploy. This Lambda is read + trigger only. Still
 * true after FR-4 and after multi-target: start_ci_build starts a PR CHECK, which
 * deploys nothing; capabilities reports approveDeploy:false unconditionally; and
 * widening the registry can only ever add a pipeline to READ and TRIGGER, never
 * an approval path.
 *
 * Still true after TEAM-4525's ship-approval record, and the distinction is the
 * whole point: the record is a WITNESS STATEMENT about a decision a human already
 * made (the Merge Approval on a specific head SHA), written to the hub's own
 * bucket. It carries no approval token, reaches no CodePipeline API, and cannot
 * release a gate by itself — the PIPELINE decides, from the record plus its own
 * source revision, whether re-asking the same human for byte-identical code adds
 * anything. Anything unexpected (no record, a different merge commit, an
 * unverified head, a failed write) leaves the human gate firing, which is why
 * every failure path here is a `recorded:false` reason rather than a throw.
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
 *                       the CD registry (config/cd-registry.json) and the Deploy
 *                       stage's handoff markers, and the destination of the
 *                       ship-approval records start_deploy writes. Unset → no S3
 *                       call at all: the registry is empty, the env default is the
 *                       only target (single-pipeline mode), and no ship-approval
 *                       record can be recorded (so the human deploy gate fires)
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
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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
// STS is a core client in the nodejs20.x runtime-bundled SDK (this Lambda zips
// index.mjs + cd-registry.mjs ONLY — no node_modules — so every import must be
// runtime-provided). Used to assume a registry entry's cross-account
// hub-cd-trigger-* role before reading/triggering a foreign-account pipeline.
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
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
// Read-only GitHub credential, used for ONE thing: proving that the commit a
// start_deploy wants recorded really is the merge of the head SHA a human
// approved (verifyMergeBinding). Optional — when unset, no ship-approval record
// can be written and every deploy keeps its human gate, which is the pre-
// TEAM-4525 behaviour. It grants no approval capability of any kind.
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
/** GitHub is on the critical path of a 60s Lambda; a slow API must fail closed
 * (unverified → gate fires), not burn the whole budget. */
const GITHUB_TIMEOUT_MS = Number(process.env.GITHUB_TIMEOUT_MS || 5000);

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

// One STS client in this Lambda's own region, using the role's ambient creds —
// the source identity for every cross-account AssumeRole.
let stsClient = null;
function sts() {
  if (!stsClient) stsClient = new STSClient({ region: REGION });
  return stsClient;
}

// A credentials provider that assumes a cross-account hub-cd-trigger-* role with
// its ExternalId, caching the temp creds until ~1 min before expiry so a warm
// container re-assumes at most once every ~14 min instead of per request. Passed
// as the `credentials` option to the CodePipeline/CodeBuild/Logs clients for a
// cross-account target; a plain-object credentials provider function is the
// AWS SDK v3 contract. Uses only the runtime-bundled @aws-sdk/client-sts.
function assumeRoleProvider(roleArn, externalId) {
  let cached = null; // { creds, expiresAt }
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt - 60_000 > now) return cached.creds;
    const out = await sts().send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: "hub-pipeline-tools",
        ExternalId: externalId,
        DurationSeconds: 900,
      })
    );
    const c = out.Credentials || {};
    cached = {
      creds: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration,
      },
      expiresAt: c.Expiration ? new Date(c.Expiration).getTime() : now + 900_000,
    };
    return cached.creds;
  };
}

// CodePipeline/CodeBuild/Logs, memoized per region|roleArn — a target in another
// region OR another account (via an assumed role) needs its own clients, and a
// warm container should not rebuild them per call.
const clientsByRegion = new Map();

/**
 * @param {string} region
 * @param {string|null} [roleArn]     cross-account trigger role to assume (null → same-account)
 * @param {string|null} [externalId]  the role's required ExternalId
 * @returns {{cp: CodePipelineClient, cb: CodeBuildClient, logs: CloudWatchLogsClient}}
 */
function clientsFor(region, roleArn = null, externalId = null) {
  const r = region || REGION;
  // externalId is part of the identity: rotating it (same role + region) must
  // build a fresh client whose provider closes over the NEW value, else the
  // cached provider keeps assuming with the stale ExternalId once its ~15-min
  // session lapses, and every cross-account call fails until the container recycles.
  const key = `${r}|${roleArn || ""}|${externalId || ""}`;
  let set = clientsByRegion.get(key);
  if (!set) {
    const cfg = { region: r };
    // roleArn is only ever non-null for an entry parseCdRegistry validated as a
    // complete cross-account triple (12-digit account + hub-cd-trigger-* name +
    // externalId), so the assumed role is bounded to read + StartPipelineExecution.
    if (roleArn) cfg.credentials = assumeRoleProvider(roleArn, externalId);
    set = {
      cp: new CodePipelineClient(cfg),
      cb: new CodeBuildClient(cfg),
      logs: new CloudWatchLogsClient(cfg),
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
 *   MALFORMED body     → the LAST GOOD copy (TEAM-4358). A truncated or
 *                        half-written document is a failed read, not "nothing is
 *                        registered".
 *   any other error    → the LAST GOOD copy is kept and a warning logged, so a
 *                        transient S3 error cannot un-register a live repo
 *                        mid-deploy.
 *
 * EVERY path opens the TTL window, same as the orchestrator
 * (lambda/orchestrator/index.mjs:259) — including the failing ones.
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
    // JSON.parse HERE rather than letting parseCdRegistry do it (TEAM-4358).
    // parseCdRegistry is tolerant BY DESIGN — a malformed document becomes an
    // EMPTY registry — and assigning that would DISCARD the last good copy and
    // cache "nothing registered" for the whole TTL: one truncated S3 read
    // un-registers every repo. Parsing first turns a malformed body into a
    // SyntaxError the catch treats like any other read failure. parseCdRegistry
    // takes the already-parsed object, so tolerant per-ENTRY handling is
    // unchanged.
    const doc = JSON.parse(await obj.Body.transformToString());
    registryCache = parseCdRegistry(doc);
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      registryCache = { version: 1, repos: [] };
    } else {
      console.warn("cd-registry read failed (keeping last copy, non-fatal):", e?.name, e?.message);
    }
  }
  // Stamped on EVERY path, failures included (TEAM-4358). Without this, a
  // persistent AccessDenied or network fault meant an S3 GetObject on every
  // single tool invocation for the life of the container.
  registryLoadedAt = now;
  return registryCache;
}

/**
 * @typedef {{repo: string|null, pipeline: string, region: string,
 *            roleArn: string|null, externalId: string|null,
 *            ciProject: string, buildProject: string, deployProject: string,
 *            isEnvDefault: boolean}} Target
 */

/**
 * Every target this deployment can act on: one per registry entry that names a
 * pipeline (expanded by pipelineProjects), then the env default unless a registry
 * entry already names that pipeline. Order is deterministic (registry order, env
 * default last), but callers must NOT read `targets[0]` as "the default"
 * (TEAM-4358) — that made an unqualified call act on whichever repo an operator
 * happened to register first. Exactly one target always carries
 * `isEnvDefault: true`: the one whose `pipeline === PIPELINE_NAME`, whether it
 * came from the registry or from env.
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
      // Cross-account trigger role, or null for the same-account common case.
      roleArn: projects.roleArn || null,
      externalId: projects.externalId || null,
      ciProject: projects.ciProject,
      buildProject: projects.buildProject,
      deployProject: projects.deployProject,
      // The registry may name the deployment's OWN pipeline, and normally does.
      // That entry IS the env default — it just carries the registry's
      // region/ciProject instead of env's. Stamping false here (TEAM-4358) left
      // NO target flagged, and resolveTarget's fallback then degraded to registry
      // ORDER.
      isEnvDefault: projects.pipeline === PIPELINE_NAME,
    });
  }
  if (!seen.has(PIPELINE_NAME)) {
    targets.push({
      repo: PIPELINE_REPO || null,
      pipeline: PIPELINE_NAME,
      region: REGION,
      // The env-default (hub's own) pipeline is always same-account.
      roleArn: null,
      externalId: null,
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
  // The env default, BY NAME. `|| targets[0]` used to stand here and was a silent
  // bug (TEAM-4358): with this deployment's own pipeline listed in the registry no
  // target carried the flag, so an unqualified call acted on whichever repo was
  // registered FIRST — a read, or a start_ci_build, against another repo's
  // project in another repo's region. listTargets guarantees one flagged target;
  // the second find states that invariant structurally, so a future change there
  // degrades to the CONFIGURED pipeline rather than back to list order.
  const envDefault =
    targets.find((t) => t.isEnvDefault) || targets.find((t) => t.pipeline === PIPELINE_NAME);
  if (!envDefault) {
    // Unreachable while listTargets appends the env default (see above). Refuse
    // rather than return an undefined target: guessing one is the whole thing
    // this block exists to prevent.
    return {
      target: null,
      targets,
      refusal: { ok: false, reason: "pipeline_name_required", known: pipelines },
    };
  }
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

// ─── the execution snapshot (status + handoff marker) ─────────────────────────
// ONE GetPipelineExecution answers two questions, so it is made once and both
// answers are returned together:
//
//  1. `status` — the EXECUTION's own disposition. get_state's stage-level
//     arithmetic cannot always reach a verdict: a stage CodePipeline SKIPPED (the
//     TEAM-4525 conditional deploy gate) may keep an older pipelineExecutionId,
//     so "have all stages caught up to this execution?" stays false forever and a
//     release manager polls a finished run until it gives up. The execution's own
//     Succeeded/Failed/Stopped/Cancelled/Superseded is authoritative about that.
//  2. `handoff` — a Deploy stage that shipped every code surface but also touched
//     infra-only files (runtime create/setup scripts, IAM/env/table scripts)
//     writes the file list to pipeline-artifacts/handoff/<sha>.txt and SUCCEEDS.
//     It used to exit 2 — a green deploy reported as Failed — so "Failed" meant
//     either a real failure or a clean deploy with a follow-up, and only a build
//     log could tell them apart. get_state reports it as data on a succeeded run.
//
// `cp` is the CALLER's region-correct CodePipeline client; `s3` is always this
// Lambda's own, because the marker lives in the one artifact bucket. The marker
// read stays gated on ARTIFACT_BUCKET (no bucket → no S3 call at all); the status
// does not, because it needs no bucket.
async function executionSnapshot(pipelineName, pipelineExecutionId, cp) {
  const none = { status: null, handoff: null };
  if (!pipelineExecutionId) return none;
  let sha = "";
  let status = null;
  try {
    const ex = await cp.send(
      new GetPipelineExecutionCommand({ pipelineName, pipelineExecutionId })
    );
    status = ex.pipelineExecution?.status || null;
    sha = ex.pipelineExecution?.artifactRevisions?.[0]?.revisionId || "";
  } catch (e) {
    console.warn("get-pipeline-execution failed (non-fatal):", e.message);
    return none;
  }
  if (!ARTIFACT_BUCKET || !sha) return { status, handoff: null };
  // The Build stage truncates the source revision to 12 chars for GIT_SHA, and
  // the Deploy stage keys the marker on that.
  const key = `pipeline-artifacts/handoff/${sha.slice(0, 12)}.txt`;
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key })
    );
    const body = await obj.Body.transformToString();
    const files = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return { status, handoff: { sha: sha.slice(0, 12), files } };
  } catch (e) {
    // NoSuchKey is the normal case: this deploy had nothing to hand off.
    if (e.name !== "NoSuchKey" && e.name !== "NotFound") {
      console.warn("handoff marker read failed (non-fatal):", e.name, e.message);
    }
    return { status, handoff: null };
  }
}

/** Execution dispositions from which nothing further can happen. A run in any of
 * them is terminal whatever the stage-level arithmetic says. */
const FAILED_EXECUTION_STATUSES = new Set([
  "Failed",
  "Stopped",
  "Cancelled",
  "Superseded",
]);
const TERMINAL_EXECUTION_STATUSES = new Set([
  "Succeeded",
  ...FAILED_EXECUTION_STATUSES,
]);

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
//
// TEAM-4525 adds `approvalSkipped` and one safety net. The deploy gate is now
// CONDITIONAL, so a run can legitimately show an Approval stage the pipeline
// SKIPPED: that is neither a failure nor work in progress, and a skipped stage may
// keep an OLDER pipelineExecutionId — which would leave the scoped `allStagesMatch`
// test false forever. So `terminal` is ALSO taken from the execution's own status
// (executionSnapshot), and `approvalSkipped` says out loud that no human is being
// waited on.
async function getState(args = {}, target) {
  // The pipeline is the RESOLVED target's — args.pipeline_name was already
  // validated against the allow-list (or refused) before we got here.
  const name = target.pipeline;
  const { cp } = clientsFor(target.region, target.roleArn, target.externalId);
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

  // TEAM-4525: "Skipped" is a THIRD disposition, and it is neither of the two the
  // arithmetic below tests for. A conditional stage CodePipeline skipped is not
  // Failed (nothing went wrong) and not InProgress (nothing is running), so the
  // `=== "InProgress"` / `Failed|Stopped` comparisons already treat it correctly
  // — stated here because the deploy gate can now be skipped, which makes it a
  // routine status rather than an exotic one, and because a future "anything not
  // Succeeded is a problem" refactor would silently break the feature.
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

  // ONE GetPipelineExecution, two answers (see executionSnapshot):
  //  - handoff: present (non-null) when this execution's Deploy stage recorded
  //    infra files a human must still deploy. NOT a failure — the code shipped.
  //  - executionStatus: the run's own disposition.
  const { status: executionStatus, handoff } = await executionSnapshot(
    name,
    pipelineExecutionId,
    cp
  );

  // TEAM-4525: the execution's own terminal disposition OVERRIDES the stage-level
  // arithmetic, in the one direction that is always safe — it can only ever turn
  // "keep polling" into "this run is over". A SKIPPED stage may hold an older
  // pipelineExecutionId, so allStagesMatch never becomes true and the scoped path
  // would have the release manager poll a finished run forever. A non-Succeeded
  // terminal status also forces anyFailed, so a Failed/Superseded run can never be
  // reported as succeeded:true just because no matching stage carried the failure.
  if (TERMINAL_EXECUTION_STATUSES.has(executionStatus)) {
    terminal = true;
    anyInProgress = false;
    if (FAILED_EXECUTION_STATUSES.has(executionStatus)) anyFailed = true;
  }

  // The deploy gate, when the pipeline decided it had nothing left to ask
  // (TEAM-4525): the human already approved this exact code at Merge Approval, so
  // the in-pipeline ManualApproval was skipped. Reported so a release manager can
  // tell "no human is being waited on" from "a human has not answered yet" —
  // the two look identical in the stage list otherwise. Scoped to the requested
  // execution when one was given; the approval token is still never leaked.
  const approvalStage = stages.find(
    (s) => /approv/i.test(s.stage) || s.actions.some((a) => /approv/i.test(a.action))
  );
  const approvalSkipped = !!(
    approvalStage &&
    (!executionId || approvalStage.executionId === executionId) &&
    (approvalStage.status === "Skipped" ||
      approvalStage.actions.some((a) => /approv/i.test(a.action) && a.status === "Skipped"))
  );

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
    // True iff the conditional deploy gate did not fire for this run.
    approvalSkipped,
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
//
// TEAM-4525 — the OPTIONAL recording args. Pass them and this call also writes a
// ship-approval record (recordShipApproval below) so the pipeline can skip
// re-asking the human who already approved this exact code:
//   approved_head_sha  the head SHA the human approved at Merge Approval. REQUIRED
//                      for a record: without it there is nothing to record.
//   ci_build_id        the CI build that certified that head. Optional — it makes
//                      verification exact instead of a ledger scan.
//   pr_url, workflow_id, ticket_id
//                      provenance, copied into the record verbatim when non-empty.
// Omitting all of them is the pre-TEAM-4525 behaviour exactly: no record, no extra
// AWS call, `preapproval:{recorded:false, reason:"approved_head_sha_missing"}`, and
// the human deploy gate fires. Nothing here can FAIL a deploy: recording is
// best-effort by construction.
async function startDeploy(args = {}, target) {
  const name = target.pipeline;
  const { cp, cb } = clientsFor(target.region, target.roleArn, target.externalId);
  const input = { name };
  // clientRequestToken constraints: ^[a-zA-Z0-9-]+$, 1–128 chars. Sanitize the
  // SHA to that charset; if nothing valid remains (or no SHA was given), OMIT
  // the token entirely — never send an empty/invalid one.
  const rawSha = String(args.commit_sha || "").trim();
  const sanitized = rawSha.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized) {
    input.clientRequestToken = `deploy-${sanitized}`.slice(0, 128);
  }

  // BEFORE the start, so the record is already in place when the pipeline's own
  // Source stage runs and looks for it. Never throws, whatever happens inside.
  const preapproval = await recordShipApproval(args, target, cb);

  const res = await cp.send(new StartPipelineExecutionCommand(input));
  return jsonResult({
    started: true,
    pipelineName: name,
    region: target.region,
    repo: target.repo,
    pipelineExecutionId: res.pipelineExecutionId,
    // { recorded, reason?, key? } — see recordShipApproval.
    preapproval,
    note:
      "Deploy stage has an in-pipeline ManualApproval (deploy gate) that a HUMAN approves (Telegram). " +
      "Poll get_state with execution_id=<this pipelineExecutionId> until terminal:true AND matchesExecution:true. " +
      "preapproval.recorded:true means this call recorded the head SHA a human already approved at Merge Approval " +
      "against THIS merge commit, which is what lets the pipeline skip re-asking that same human for byte-identical " +
      "code — for exactly this merge commit and nothing else. Recording REQUIRES pr_url: GitHub must confirm that PR " +
      "is merged, that its head is approved_head_sha and that its merge commit is commit_sha. Any other commit, an " +
      "unverified head, a CI result that is not certified on it, a binding GitHub will not confirm, or a failed record " +
      "write (preapproval.recorded:false with a reason) and the human " +
      "deploy gate fires as usual, which is the safe outcome, not an error to retry. You have NO approval capability: " +
      "this tool cannot approve a gate, only record what a human already decided — if the gate fires, wait for the human.",
  });
}

// ─── the ship-approval record (TEAM-4525) ─────────────────────────────────────
// A ship run used to ask its human TWICE for byte-identical code: once at Merge
// Approval (approve this head SHA) and again at the in-pipeline deploy gate
// (approve deploying the merge commit of that same head). The second ask carries
// no new information, so the pipeline may skip it — but ONLY if it can prove the
// commit it is deploying is the merge commit of the head a human approved, with
// CI certified on that head. This function writes that proof; the PIPELINE reads
// it and decides. Nothing here approves anything.
//
// Fail-closed in every direction: no record, or a record for another commit, and
// the gate fires. So every problem below is a `recorded:false` + reason, never a
// throw and never anything that stops the deploy from starting — a run that
// cannot be pre-approved is a run with a human gate, which is the status quo.
//
// The record's SHAPE is a contract with the pipeline side; do not change a key
// name, the key path or the bucket without changing the reader in lockstep.

/** The one prefix ship-approval records live under, and the only S3 write this
 * Lambda's role is granted (Sid ShipApprovalRecordWrite, s3:PutObject only). */
const SHIP_APPROVAL_PREFIX = "pipeline-artifacts/ship-approvals/";
/** A record is only ever written for FULL 40-hex SHAs: a short SHA is ambiguous,
 * and "the pipeline's source revision equals the merge commit in the record" has
 * to be an exact string comparison on the reader's side. */
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The exact `preapproval.reason` vocabulary. Every value is a reason NO record
 * was written, i.e. a reason the human gate will fire. */
const PREAPPROVAL_REASONS = {
  /** No approved_head_sha was supplied — the caller is not attempting to record
   * anything (every pre-TEAM-4525 caller lands here). */
  MISSING: "approved_head_sha_missing",
  /** commit_sha or approved_head_sha is not a 40-hex SHA. */
  INVALID_SHA: "invalid_sha",
  /** No SUCCEEDED CI build of this target's PR-check project resolves to
   * approved_head_sha, so the head a human approved was never certified. */
  NOT_CERTIFIED: "ci_not_certified",
  /** The PutObject failed (or there is no bucket to write to). The deploy still
   * started; the gate fires. */
  WRITE_FAILED: "record_write_failed",
  // ── the merge binding (TEAM-4525 review P1) ───────────────────────────────
  // CI certification proves "the head a human approved is green". It says NOTHING
  // about the commit we are about to deploy actually BEING that head's merge —
  // the caller supplies both SHAs, so without an independent check an agent could
  // pass a certified head plus any newer, unapproved main commit and get a record
  // written for it. These four reasons are that check failing closed.
  /** No pr_url was supplied. It is REQUIRED to record: it is the only thing that
   * lets this Lambda ask GitHub whether commit_sha is approved_head_sha's merge. */
  PR_URL_MISSING: "pr_url_missing",
  /** pr_url is not a github.com pull URL for THIS target's repo. */
  PR_URL_INVALID: "pr_url_invalid",
  /** GitHub says the PR is not merged, its head is not approved_head_sha, or its
   * merge commit is not commit_sha — the binding the record would assert is false. */
  BINDING_MISMATCH: "merge_binding_mismatch",
  /** GitHub could not be asked (no GITHUB_TOKEN, API error, timeout). An
   * unverifiable binding is treated exactly like a false one. */
  BINDING_UNVERIFIED: "merge_binding_unverified",
};

/** Trim + lowercase, so a caller pasting a capitalized or padded SHA is not
 * silently refused as "invalid". */
function normalizeSha(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Parse a PR URL into `{ owner, repo, number }`, or null.
 *
 * DELIBERATELY strict and anchored: this string comes from an agent and decides
 * which URL we fetch, so no query (`?`), no fragment (`#`), no path traversal
 * (`..`) and no host but github.com can survive it. Both the human form
 * (github.com/o/r/pull/N) and the API form (api.github.com/repos/o/r/pulls/N)
 * are accepted because blueprints paste whichever the merge worker returned.
 */
function parsePrUrl(value) {
  const text = String(value ?? "").trim();
  let m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]{1,10})$/.exec(
    text
  );
  if (!m) {
    m =
      /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pulls\/([0-9]{1,10})$/.exec(
        text
      );
  }
  if (!m) return null;
  const [, owner, repo, number] = m;
  // A path segment of "." or ".." passes the character class above.
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return { owner, repo, number };
}

/**
 * Ask GitHub whether `mergeCommit` really is the merge of `approvedHead` for the
 * PR at `prUrl`, in `expectedRepo`.
 *
 * This is the check that makes the record mean what the pipeline reads it to
 * mean. Without it, `recordShipApproval` would attest a binding
 * (merge_commit ↔ approved_head_sha) that only the CALLER asserted, and the whole
 * conditional gate would rest on trusting the agent that asked for it — which is
 * exactly the thing TEAM-4525 may not do.
 *
 * Three properties must ALL hold:
 *   1. the PR is merged (an open PR's merge commit does not exist yet);
 *   2. its head SHA is the SHA the human approved (no post-approval drift);
 *   3. its merge_commit_sha is the commit we are about to deploy (squash included
 *      — GitHub sets merge_commit_sha to the squash commit).
 * Plus: the PR must live in the target's own repo, so a pr_url pointing at some
 * other (perhaps attacker-authored) repository proves nothing here.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string, detail?: string}>}
 */
async function verifyMergeBinding({ prUrl, mergeCommit, approvedHead, expectedRepo }) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return { ok: false, reason: PREAPPROVAL_REASONS.PR_URL_INVALID, detail: "unparseable" };
  }
  const full = `${parsed.owner}/${parsed.repo}`;
  const want = String(expectedRepo ?? "").trim();
  // Only enforceable when the registry entry names a repo; when it does, the PR
  // must be in it. (A registry entry with no repo cannot be cross-checked, and a
  // record for it still requires all three GitHub properties below.)
  if (want && full.toLowerCase() !== want.toLowerCase()) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.PR_URL_INVALID,
      detail: `pr is in ${full}, target repo is ${want}`,
    };
  }
  if (!GITHUB_TOKEN) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.BINDING_UNVERIFIED,
      detail: "GITHUB_TOKEN is not configured on this Lambda",
    };
  }

  let pr;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "agentcore-hub-pipeline-tools",
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      return {
        ok: false,
        reason: PREAPPROVAL_REASONS.BINDING_UNVERIFIED,
        detail: `GitHub returned ${res.status}`,
      };
    }
    pr = await res.json();
  } catch (e) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.BINDING_UNVERIFIED,
      detail: `${e?.name}: ${e?.message}`,
    };
  }

  if (!pr || typeof pr !== "object") {
    return { ok: false, reason: PREAPPROVAL_REASONS.BINDING_UNVERIFIED, detail: "no PR body" };
  }
  if (pr.merged !== true) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.BINDING_MISMATCH,
      detail: "pr is not merged",
    };
  }
  const prHead = normalizeSha(pr.head?.sha);
  if (prHead !== approvedHead) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.BINDING_MISMATCH,
      detail: `pr head ${prHead || "(none)"} != approved ${approvedHead}`,
    };
  }
  const prMerge = normalizeSha(pr.merge_commit_sha);
  if (prMerge !== mergeCommit) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.BINDING_MISMATCH,
      detail: `pr merge commit ${prMerge || "(none)"} != commit_sha ${mergeCommit}`,
    };
  }
  // Defence in depth: the registry repo check above is skipped when the entry has
  // no repo, so re-assert against what GitHub itself says the PR belongs to.
  const apiRepo = normalizeSha(pr.base?.repo?.full_name);
  if (apiRepo && apiRepo !== full.toLowerCase()) {
    return {
      ok: false,
      reason: PREAPPROVAL_REASONS.PR_URL_INVALID,
      detail: `GitHub reports the pr in ${apiRepo}, url said ${full}`,
    };
  }
  return { ok: true };
}

/** Copy `value` onto `record` under `key` only when it is a non-empty string —
 * the contract omits absent optional fields rather than carrying nulls. */
function putIfPresent(record, key, value) {
  const text = String(value ?? "").trim();
  if (text) record[key] = text;
}

/**
 * Is CI certified on `headSha` for `target`'s PR-check project?
 *
 * Returns the build id that proves it, or null. Two paths, both reusing the
 * helpers get_build_status / start_ci_build already prove builds with:
 *
 *   ci_build_id given → BatchGetBuilds on that ONE build, which must be
 *                       SUCCEEDED, belong to this target's CI project, and
 *                       resolve to headSha. Cheapest and most precise: the
 *                       release manager already holds the id it certified on.
 *   otherwise         → findBuildsForCommit's per-SHA ledger, and a SUCCEEDED
 *                       build in it whose RESOLVED source version is headSha.
 *
 * The resolved version is what matters in both paths (sourceVersion can be a
 * pr/<id> ref); an unresolved build is never evidence, so the ledger's
 * "started-with" attribution rule — which exists to COUNT retry attempts — is
 * deliberately not enough here.
 */
async function ciCertifiedBuildId(cb, project, headSha, ciBuildId) {
  const explicit = String(ciBuildId ?? "").trim();
  if (explicit) {
    const { builds } = await cb.send(new BatchGetBuildsCommand({ ids: [explicit] }));
    const build = builds?.[0];
    if (!build) return null;
    if (build.buildStatus !== "SUCCEEDED") return null;
    // The id must name THIS target's PR-check project. A green build of some
    // other project (a build/deploy project, or another repo's CI) proves
    // nothing about this head.
    const owner = build.projectName || parseBuildIdProject(build.id || explicit);
    if (owner !== project) return null;
    if (!commitMatches(build.resolvedSourceVersion, headSha)) return null;
    return build.id || explicit;
  }
  const ledger = await findBuildsForCommit(cb, project, headSha, BUILD_SCAN_WINDOW);
  const green = ledger.find(
    (b) => b.buildStatus === "SUCCEEDED" && commitMatches(b.resolvedSourceVersion, headSha)
  );
  return green ? green.id || null : null;
}

/**
 * Write the ship-approval record for this start_deploy, if and only if it can be
 * proven. Returns the `preapproval` block start_deploy reports:
 *
 *   { recorded: true, key }                — written
 *   { recorded: false, reason }            — not written, and why
 *
 * "Proven" means all of, in this order:
 *   1. both SHAs are full 40-hex;
 *   2. CI is certified on approved_head_sha for this target's PR-check project;
 *   3. GitHub confirms the PR at `pr_url` (REQUIRED) is merged, its head is
 *      approved_head_sha, and its merge_commit_sha is commit_sha.
 *
 * (3) is what stops the record from being an unverified caller assertion. NOTHING
 * here can approve a gate; the worst outcome of any failure is a human gate.
 *
 * @returns {Promise<{recorded: boolean, reason?: string, key?: string}>}
 */
async function recordShipApproval(args = {}, target, cb) {
  const mergeCommit = normalizeSha(args.commit_sha);
  const approvedHead = normalizeSha(args.approved_head_sha);

  // No approved head → the caller is not claiming a human approved anything.
  // Reported BEFORE the SHA shape check, so "you did not pass it" is never
  // reported as "what you passed is malformed".
  if (!approvedHead) {
    return { recorded: false, reason: PREAPPROVAL_REASONS.MISSING };
  }
  if (!FULL_SHA.test(mergeCommit) || !FULL_SHA.test(approvedHead)) {
    return { recorded: false, reason: PREAPPROVAL_REASONS.INVALID_SHA };
  }

  const project = target.ciProject || CI_PROJECT;
  let ciBuildId = null;
  try {
    ciBuildId = await ciCertifiedBuildId(cb, project, approvedHead, args.ci_build_id);
  } catch (e) {
    // A CodeBuild read that failed proves nothing, so it is the same answer as
    // "not certified": no record, human gate fires.
    console.warn(
      "ship-approval CI verification failed (non-fatal, gate will fire):",
      e?.name,
      e?.message
    );
    return { recorded: false, reason: PREAPPROVAL_REASONS.NOT_CERTIFIED };
  }
  if (!ciBuildId) {
    return { recorded: false, reason: PREAPPROVAL_REASONS.NOT_CERTIFIED };
  }

  // ── the binding, machine-verified (TEAM-4525 review P1) ───────────────────
  // Everything above proves the APPROVED HEAD is green. Nothing above proves
  // `commit_sha` is that head's merge — both SHAs came from the caller. Ask
  // GitHub, and refuse to record if it will not confirm all three properties.
  // Checked AFTER CI so an uncertified head is still reported as
  // `ci_not_certified` (the more fundamental failure) rather than as a URL problem.
  const prUrl = String(args.pr_url ?? "").trim();
  if (!prUrl) {
    return { recorded: false, reason: PREAPPROVAL_REASONS.PR_URL_MISSING };
  }
  const binding = await verifyMergeBinding({
    prUrl,
    mergeCommit,
    approvedHead,
    expectedRepo: target.repo,
  });
  if (!binding.ok) {
    console.warn(
      "ship-approval merge binding REFUSED (non-fatal, human deploy gate will fire):",
      binding.reason,
      binding.detail || ""
    );
    return { recorded: false, reason: binding.reason };
  }

  const key = `${SHIP_APPROVAL_PREFIX}${mergeCommit}.json`;
  // The contract. version/merge_commit/approved_head_sha/recorded_at/recorded_by
  // are ALWAYS present; the rest are provenance for a human reading the record
  // later and are omitted when the caller had nothing to say.
  const record = {
    version: 1,
    merge_commit: mergeCommit,
    approved_head_sha: approvedHead,
  };
  putIfPresent(record, "ci_build_id", ciBuildId);
  putIfPresent(record, "pipeline", target.pipeline);
  putIfPresent(record, "repo", target.repo);
  putIfPresent(record, "pr_url", args.pr_url);
  putIfPresent(record, "workflow_id", args.workflow_id);
  putIfPresent(record, "ticket_id", args.ticket_id);
  record.recorded_at = new Date().toISOString();
  // Literal, not derived: the reader uses it to tell this Lambda's records from
  // anything else that might ever land under the prefix.
  record.recorded_by = "Pipeline___start_deploy";

  try {
    if (!ARTIFACT_BUCKET) {
      // Nowhere to write. Same reason code as a failed PutObject, because the
      // consequence is identical and there is nothing an agent can do about
      // either: it is an operator's missing ARTIFACT_BUCKET.
      throw new Error("ARTIFACT_BUCKET is not set");
    }
    // The HUB's own bucket in the HUB's account — the ambient `s3` client, never a
    // cross-account target's assumed role.
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
        Body: JSON.stringify(record, null, 2),
        ContentType: "application/json",
      })
    );
  } catch (e) {
    console.warn(
      "ship-approval record write failed (non-fatal, human deploy gate will fire):",
      e?.name,
      e?.message
    );
    return { recorded: false, reason: PREAPPROVAL_REASONS.WRITE_FAILED };
  }

  console.log(
    "ship-approval recorded",
    JSON.stringify({
      key,
      merge_commit: mergeCommit,
      approved_head_sha: approvedHead,
      ci_build_id: ciBuildId,
      pipeline: target.pipeline,
    })
  );
  return { recorded: true, key };
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
  const { cb, logs } = clientsFor(owner.region, owner.roleArn, owner.externalId);
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
  const { cb } = clientsFor(owner.region, owner.roleArn, owner.externalId);
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
  // BatchGetBuilds makes no ordering promise, so `ids` (which IS newest-first)
  // drives the walk -- the same reason findBuildsForCommit indexes by id. Reading
  // the response array as if it were ordered made `match` below (the FIRST row for
  // the commit, i.e. "newest") whichever build AWS happened to return first: a SHA
  // carrying a FAILED build plus a green D2 retry could report the FAILED one and
  // succeededForCommit:false for a head CI had actually certified.
  const byId = new Map((builds || []).filter((b) => b?.id).map((b) => [b.id, b]));
  const rows = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((b) => ({
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
// Four invariants, in the order they are enforced:
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
//   4. (TEAM-4448 D2) A SHA gets at most MAX_BUILDS_PER_SHA builds, and the second
//      one ONLY when the newest prior build died in an INFRA_RETRY_PHASES phase.
//      findBuildsForCommit returns the whole per-SHA ledger, so "how many times
//      have we tried this commit, and why did the last one die?" is answered from
//      CodeBuild itself rather than from caller-supplied state — there is nothing
//      for a retry loop to lie about. This TIGHTENS the pre-D2 behaviour on
//      purpose: a build that failed in BUILD/POST_BUILD is no longer re-startable
//      at all (it used to get a fresh build on every call), because re-running a
//      red test suite for an unchanged tree cannot change the answer, and the
//      agent contract for that case is "a fix is a new SHA".
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
  const { cb } = clientsFor(owner.region, owner.roleArn, owner.externalId);

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

  // The per-SHA ledger, read BEFORE starting anything: the same head can be
  // pushed once and re-checked by several agents (CI agent + release manager both
  // watch it), and a duplicate build costs minutes of pipeline time and produces a
  // second, racing verdict for one commit. It also carries every FAILED attempt,
  // which is what bounds the retry below.
  const priorBuilds = await findBuildsForCommit(cb, project, sha, BUILD_SCAN_WINDOW);
  const attempts = priorBuilds.length;
  const live = priorBuilds.find(
    (b) => b.buildStatus === "IN_PROGRESS" || b.buildStatus === "SUCCEEDED"
  );
  if (live) {
    console.log(
      "start_ci_build: reusing build",
      JSON.stringify({
        project,
        buildId: live.id,
        buildStatus: live.buildStatus,
      })
    );
    return jsonResult({
      ok: true,
      reused: true,
      buildId: live.id,
      buildStatus: live.buildStatus,
      resolvedSourceVersion: live.resolvedSourceVersion || null,
      project,
      region: owner.region,
    });
  }

  // ── The retry decision (TEAM-4448 D2) ──────────────────────────────────────
  // Nothing live for this SHA, so every prior build failed. The NEWEST one decides
  // — an older infra flake does not re-open the door once a later attempt failed
  // in the caller's own code.
  let retry = null;
  if (attempts > 0) {
    const prior = priorBuilds[0];
    const { failedPhase, isInfraFailure } = classifyPriorBuild(prior);
    const refusal = {
      ok: false,
      prior_build_id: prior.id || null,
      prior_failed_phase: failedPhase,
      attempts,
      project,
      region: owner.region,
    };
    if (prior.buildStatus === "STOPPED") {
      return jsonResult({
        ...refusal,
        reason: "prior_build_stopped",
        detail:
          "A human stopped the prior build for this commit, so nothing was started here. " +
          "Report BLOCKED and say the prior build was stopped by hand — a stop is a " +
          "decision, not a flake, and re-running it would override that decision.",
      });
    }
    if (!isInfraFailure) {
      return jsonResult({
        ...refusal,
        reason: "build_failed_not_retryable",
        detail:
          `The prior build for this commit failed in ${failedPhase || "an unknown phase"}, ` +
          "which is the caller's own code, not CI infrastructure. Re-running an unchanged " +
          "tree cannot change the answer: classify the failure from prior_build_id's log " +
          "and land a fix. A fix is a NEW commit SHA, which gets its own build.",
      });
    }
    if (attempts >= MAX_BUILDS_PER_SHA) {
      return jsonResult({
        ...refusal,
        reason: "install_flake_retry_failed",
        detail:
          `SHA already retried once after an ${failedPhase} failure; push a new commit or ` +
          "inspect prior_build_id",
      });
    }
    retry = { prior, failedPhase };
  }

  // SR-3.2: a retry re-uses ONE token per SHA (`ci-<sha>-r1`), and CodeBuild
  // rejects the same idempotencyToken presented with different parameters. Two
  // agents retrying the same commit concurrently therefore have to derive
  // sourceVersion from SHARED state — the prior build's own value — not from
  // their own args, or the loser gets an InvalidInputException instead of the
  // winner's build. Only a value this Lambda would have accepted itself is
  // honoured; anything else (a `refs/...` ref an older build was started with)
  // falls back to the caller's.
  const effectiveSourceVersion =
    retry && retry.prior.sourceVersion && isAllowedSourceVersion(retry.prior.sourceVersion)
      ? retry.prior.sourceVersion
      : sourceVersion;

  // The allow-list. Do not spread args into this object, ever.
  const input = {
    projectName: project,
    sourceVersion: effectiveSourceVersion,
    // `ci-<40 hex>-r1` is 46 chars — the slice is belt-and-braces for a token
    // shape that is already provably under CodeBuild's 64-char limit.
    idempotencyToken: (retry ? `ci-${sha}-r1` : `ci-${sha}`).slice(0, 64),
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
        // The retry path adds WHICH build we were retrying; the reason code and
        // the remediation text below are byte-identical either way, because
        // "the grant is missing" has nothing to do with why we were retrying.
        ...(retry ? { prior_build_id: retry.prior.id || null } : {}),
        // TEAM-4358: with the StartBuild grant fanned out per region over the
        // project/hub-*-ci convention, WHICH project in WHICH region was refused
        // is half the diagnosis — and the old single-cause remediation text was
        // wrong for two of the three ways this denial happens.
        region: owner.region,
        detail:
          `This Lambda's role has no codebuild:StartBuild on ${project} in ${owner.region}. ` +
          "Three deploy-side causes: (1) the deployment was not given " +
          "PIPELINE_CI_START_BUILD=1, so the CiStartBuild statement is absent entirely; " +
          "(2) this target's region is not in PIPELINE_REGIONS, so the project/hub-*-ci " +
          "grant was never fanned out to it; (3) the registry entry sets an explicit " +
          "ciProject outside the hub-*-ci convention, which that wildcard cannot match. " +
          "All three are operator changes, not retryable — fall back to waiting on the " +
          "repo's own webhook build.",
      });
    }
    if (err?.name === "ResourceNotFoundException") {
      return jsonResult({ ok: false, reason: "project_not_found", project });
    }
    if (err?.name === "InvalidInputException") {
      // SR-3.2: the ONE retry token for this SHA is already claimed — another
      // caller won the race and its build is the one to poll. Distinguished from
      // a bad ref because the remediation is the opposite: wait, do not fix.
      if (/idempoten/i.test(String(err.message ?? ""))) {
        return jsonResult({
          ok: false,
          reason: "retry_in_flight",
          project,
          region: owner.region,
          sourceVersion: effectiveSourceVersion,
          ...(retry ? { prior_build_id: retry.prior.id || null } : {}),
          detail:
            "Another caller already started this commit's retry with the same idempotency " +
            "token. Poll get_build_status for this commit instead of starting anything — " +
            "the retry that exists IS the one build this SHA gets.",
        });
      }
      // CodeBuild rejects a source version this Lambda's shape check accepted
      // (e.g. a branch that does not exist) — same reason code, so the caller
      // has one thing to fix.
      return jsonResult({
        ok: false,
        reason: "invalid_source_version",
        project,
        sourceVersion: effectiveSourceVersion,
        detail: err.message,
      });
    }
    throw err; // unexpected → the generic handler error path
  }

  const build = res?.build || {};
  console.log(
    "start_ci_build: started",
    JSON.stringify({
      project,
      sourceVersion: effectiveSourceVersion,
      buildId: build.id || null,
      retry: !!retry,
      priorBuildId: retry ? retry.prior.id || null : null,
      priorFailedPhase: retry ? retry.failedPhase : null,
    })
  );
  return jsonResult({
    ok: true,
    started: true,
    buildId: build.id || null,
    arn: build.arn || null,
    project,
    region: owner.region,
    sourceVersion: effectiveSourceVersion,
    // Null on a fresh start (CodeBuild has not resolved the ref yet) — poll
    // get_build_status to prove the build belongs to this commit.
    resolvedSourceVersion: build.resolvedSourceVersion || null,
    buildStatus: build.buildStatus || null,
    // Present ONLY on the retry path, so a caller that never sees `retry` keeps
    // reading exactly the version-2 success shape.
    ...(retry
      ? {
          retry: true,
          retry_reason: "infra_install_failure",
          prior_build_id: retry.prior.id || null,
          prior_failed_phase: retry.failedPhase,
          attempts,
        }
      : {}),
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

/** Is `resolved` (a build's resolvedSourceVersion, or the sourceVersion it was
 * STARTED with) the commit `sha` names? Same prefix rule get_build_status matches
 * on, but restricted to hex values so a short branch name can never prefix-match a
 * SHA -- which is what makes it safe to run against a REQUESTED ref too, as the
 * ledger below now does (TEAM-4462 F2). */
function commitMatches(resolved, sha) {
  const r = String(resolved || "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(r)) return false;
  return r === sha || r.startsWith(sha) || sha.startsWith(r);
}

// ─── the per-SHA retry ledger (TEAM-4448 D2) ──────────────────────────────────
// TEAM-4311's apt Hash-Sum flake killed the INSTALL phase twice in one day: a
// build that never reached the caller's code, reported as a red PR check. There
// was no sanctioned way to retry it, so the only levers an agent had were the ones
// this tool exists to remove (call again, push an empty commit, pass a different
// source_version). The carve-out below gives the flake exactly ONE retry and makes
// everything else a structural refusal, with the cap enforced here rather than by
// agent judgement.
//
// TEAM-4462 F2: the ledger keys on resolvedSourceVersion OR, when CodeBuild never got
// far enough to set one, the sourceVersion the build was STARTED with. Two of the four
// retryable phases below (PROVISIONING, DOWNLOAD_SOURCE) die BEFORE the source is
// resolved, so keying on resolvedSourceVersion alone made exactly those builds
// invisible to the ledger -- attempts stayed 0, every call was a plain first start, and
// the cap this carve-out exists to enforce could not hold for them.

/** Phases that run BEFORE the buildspec's own commands can fail on the caller's
 * code. A death here is the container/network/apt, not the diff. */
const INFRA_RETRY_PHASES = new Set([
  "PROVISIONING",
  "DOWNLOAD_SOURCE",
  "INSTALL",
  "PRE_BUILD",
]);
/** buildStatus values a retry may follow. STOPPED is deliberately absent: a human
 * stopped that build, and re-running it would override their decision. */
const RETRYABLE_STATUSES = new Set(["FAILED", "FAULT", "TIMED_OUT"]);
/** Total builds one commit SHA may ever get from this tool: the first, plus one
 * infra retry. */
const MAX_BUILDS_PER_SHA = 2;
/** BatchGetBuilds accepts at most 100 ids, so the ledger scan cannot be wider. */
const BUILD_SCAN_WINDOW = 100;

/** Why a prior build for this SHA died: `{ status, failedPhase, isInfraFailure }`.
 *
 * `failedPhase` is the FIRST phase in CodeBuild's own (chronological) phases order
 * with a bad phaseStatus — the first thing to break is the cause; every later
 * phase is either skipped or a consequence. Same phaseType/phaseStatus shape
 * get_build_log maps. No phases at all (an old build, or a BatchGetBuilds response
 * without them) → failedPhase null → NOT an infra failure, i.e. no retry: the
 * carve-out only ever fires on positive evidence. Pure; exported for unit tests. */
export function classifyPriorBuild(build) {
  const status = build?.buildStatus ?? null;
  const bad = new Set(["FAILED", "FAULT", "TIMED_OUT", "STOPPED"]);
  const failedPhase =
    (build?.phases || []).find((p) => bad.has(p?.phaseStatus))?.phaseType ?? null;
  return {
    status,
    failedPhase,
    isInfraFailure:
      RETRYABLE_STATUSES.has(status) &&
      failedPhase !== null &&
      INFRA_RETRY_PHASES.has(failedPhase),
  };
}

/** EVERY build of `project` for `sha`, any status, newest first — the retry ledger.
 * Reuses the ListBuildsForProject → BatchGetBuilds scan get_build_status does (two
 * calls, no more: BatchGetBuilds already returns `phases`, so classifying the
 * newest failure needs no extra API call and no extra IAM). BatchGetBuilds does not
 * promise input order, so the ids (which ARE newest-first) drive the walk.
 *
 * Attribution keys on resolvedSourceVersion, or -- when CodeBuild never resolved the
 * ref (a PROVISIONING/DOWNLOAD_SOURCE death) -- on the sourceVersion the build was
 * STARTED with. The three rules are stated inline below (TEAM-4462 F2).
 *
 * Pre-D2 this returned only the newest IN_PROGRESS/SUCCEEDED build, because a
 * FAILED build was simply not a reuse. The whole list is now the point: its LENGTH
 * is the attempt count the retry cap is enforced against. */
async function findBuildsForCommit(cb, project, sha, scan = BUILD_SCAN_WINDOW) {
  const requested = Number(scan);
  const window = Number.isFinite(requested)
    ? Math.min(BUILD_SCAN_WINDOW, Math.max(1, Math.trunc(requested)))
    : BUILD_SCAN_WINDOW;

  const list = await cb.send(
    new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" })
  );
  const ids = (list.ids || []).slice(0, window);
  if (ids.length === 0) return [];

  const { builds } = await cb.send(new BatchGetBuildsCommand({ ids }));
  const byId = new Map((builds || []).filter((b) => b?.id).map((b) => [b.id, b]));
  // A build belongs to `sha` when EITHER
  //  (i)   its resolvedSourceVersion is the sha -- authoritative whenever present;
  //  (ii)  it has NO resolvedSourceVersion and was STARTED for this exact sha
  //        (start_ci_build sends `sha` as sourceVersion whenever source_version is
  //        omitted). commitMatches is hex-only, so a `pr/<n>` or a branch name can
  //        never land here; or
  //  (iii) it has NO resolvedSourceVersion, was started with a NON-hex ref, and an
  //        OLDER build in this ledger resolved to `sha` from the IDENTICAL ref. The
  //        retry path pins effectiveSourceVersion = retry.prior.sourceVersion, so an
  //        r1 retry that died pre-resolve sits directly above its prior carrying the
  //        same ref -- attributing it is exact, not a guess, and it is what makes the
  //        cap hold for pr/<n> callers too.
  //
  // The residual, stated honestly rather than papered over: a FIRST-attempt build
  // started with a pr/<n> or branch ref that dies before resolve has nothing to
  // attribute it by, so it stays invisible (bounded only by the ~5-min idempotency-
  // token dedupe). A caller who wants the full cap on a fresh SHA omits source_version
  // and lets the bare sha be the ref.
  //
  // Walked OLDEST -> NEWEST so rule (iii) can only ever look DOWN the list, at builds
  // strictly older than the unresolved one: a NEWER build resolving `pr/<n>` to this
  // sha says nothing about what that ref pointed at earlier. Reversed at the end so the
  // result stays in newest-first `ids` order -- the retry decision reads priorBuilds[0].
  const provenRefs = new Set();
  const oldestFirst = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const build = byId.get(ids[i]);
    if (!build) continue;
    const ref = String(build.sourceVersion ?? "").trim();
    if (commitMatches(build.resolvedSourceVersion, sha)) {
      if (ref) provenRefs.add(ref); // (iii)'s evidence, for the builds above this one
      oldestFirst.push(build);
      continue;
    }
    // Resolved to something else entirely -> not this sha, whatever it was started as.
    if (String(build.resolvedSourceVersion ?? "").trim()) continue;
    if (!ref) continue;
    if (commitMatches(ref, sha) || provenRefs.has(ref)) oldestFirst.push(build);
  }
  return oldestFirst.reverse();
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
//
// version 4 (TEAM-4448 D2) adds `ciRetry` — the retry contract start_ci_build
// enforces. It sits at TOP LEVEL, not per target: the cap, the retryable phases and
// the refusal reasons are properties of this Lambda's CODE, identical for every
// pipeline it can drive, so an agent reads them once and does not have to discover
// them by tripping over a refusal.
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
    version: 4,
    ciRetry: {
      maxBuildsPerSha: MAX_BUILDS_PER_SHA,
      infraRetryPhases: [...INFRA_RETRY_PHASES],
      scanWindow: BUILD_SCAN_WINDOW,
      retryReason: "infra_install_failure",
      refusalReasons: [
        "install_flake_retry_failed",
        "build_failed_not_retryable",
        "prior_build_stopped",
        "retry_in_flight",
        "start_build_not_granted",
      ],
    },
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
