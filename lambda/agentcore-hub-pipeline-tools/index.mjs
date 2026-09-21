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
 *                     (TEAM-4706) It also answers WHOSE human approval the deploy
 *                     gate is holding — `waitingOn.holdsGate` is "this" only when
 *                     the parked execution is the caller's, so a blueprint files
 *                     exactly one human gate ticket instead of duplicating another
 *                     build's. Observational: presence of the approval token, never
 *                     its value, and still no way to answer the gate.
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
 *                     (TEAM-4866) It ADOPTS instead of duplicating: if an
 *                     execution for this exact commit is already InProgress, the
 *                     answer is `started:false, adopted:true` carrying THAT
 *                     execution's id, so two tickets deploying the same merge
 *                     commit no longer run the pipeline twice. Best-effort — an
 *                     unreadable execution list starts as before.
 *   - get_build_log:  For a Failed Build stage — the CodeBuild build's phase
 *                     contexts + a tail of its CloudWatch log, so RM can file a
 *                     precise fix ticket (it does NOT hand-fix). (TEAM-4866) That
 *                     includes the Deploy stage's SECOND CodeBuild action, the
 *                     runtime-image deploy — read-only, like every other project
 *                     this tool reaches.
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
 *   RUNTIME_IMAGE_PROJECT  default "agentcore-hub-runtime-image-deploy" — the Deploy
 *                       stage's SECOND CodeBuild action (Deploy_runtime_images).
 *                       READ-ONLY (TEAM-4866): get_build_log may resolve a build id
 *                       in it so a failed runtime-image deploy can be explained, and
 *                       it stays in RESERVED_CI_PROJECTS so nothing can ever hand it
 *                       to codebuild:StartBuild. The IAM grant is read-only too
 *                       (BuildRead + BuildLogRead, never CiStartBuild)
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
  // TEAM-4706: used on ONE cold path only — resolving which newer execution took
  // over from a Superseded one (findSupersedingExecution). Never on a poll.
  ListPipelineExecutionsCommand,
  // TEAM-4740 FR-4: the ONLY new CodePipeline write this Lambda has ever gained,
  // and it is a STOP, not an approval. Reachable from exactly one place —
  // start_deploy's opt-in abandon path — behind proven git ancestry, a re-read of
  // the live gate and a confirmed Stop (Sid PipelineAbandonSuperseded).
  // PutApprovalResult is still absent from this file and from the role, and that
  // is the property that keeps "abandon the run in front of me" from ever being
  // "approve the run in front of me".
  StopPipelineExecutionCommand,
} from "@aws-sdk/client-codepipeline";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  // TEAM-4740 SEC-1(3): probe for a `<merge_commit>.rejected.json` veto before
  // writing a ship-approval record. HeadObject, never GetObject — the existence
  // of the marker is the whole signal, and this role is granted nothing that could
  // read its body.
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
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
// TEAM-4866 — the Deploy stage's other CodeBuild action, for the env default
// target. A READ target only; registry targets derive their own name through
// pipelineProjects().runtimeImageProject.
const RUNTIME_IMAGE_PROJECT =
  process.env.RUNTIME_IMAGE_PROJECT || "agentcore-hub-runtime-image-deploy";
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
//
// TEAM-4866 made the name configurable (RUNTIME_IMAGE_PROJECT) so get_build_log
// can READ it. The union — never the env value alone — is what keeps that from
// weakening this list: overriding the env moves what is readable, and can never
// un-reserve the default name for an agent-triggerable StartBuild.
const RESERVED_CI_PROJECTS = [
  ...new Set([RUNTIME_IMAGE_PROJECT, "agentcore-hub-runtime-image-deploy"]),
];

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
      // READ-only (TEAM-4866) — see readableProjectsOf below.
      runtimeImageProject: projects.runtimeImageProject,
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
      // From env, not derived: the hub's own runtime-image project name is
      // settable independently of PIPELINE_NAME (TEAM-4866).
      runtimeImageProject: RUNTIME_IMAGE_PROJECT,
      isEnvDefault: true,
    });
  }
  return targets;
}

/**
 * Every CodeBuild project name a target owns for ALL purposes — the set that
 * makes a project "registered" for start_ci_build's validation and for the
 * default project_not_registered refusal.
 *
 * TEAM-4866: runtimeImageProject is deliberately NOT here. Adding it would make
 * the runtime-image deploy project a registered project everywhere, softening the
 * RESERVED_CI_PROJECTS refusal in start_ci_build from "refused, with zero AWS
 * traffic" into a silent ignore. Read access is a strictly smaller grant and gets
 * its own set below.
 */
function projectsOf(target) {
  return [target.ciProject, target.buildProject, target.deployProject].filter(Boolean);
}

/**
 * Every CodeBuild project a target's build LOG may be read for (TEAM-4866) —
 * projectsOf plus the Deploy stage's runtime-image action. Used ONLY by
 * get_build_log (a read of phases + a log tail); never by start_ci_build, and
 * never by the IAM-relevant "can this be started" question.
 */
function readableProjectsOf(target) {
  return [...projectsOf(target), target.runtimeImageProject].filter(Boolean);
}

/**
 * The target that owns CodeBuild project `name`, or null. `readable:true` widens
 * the membership test to the read-only set (runtime-image project included).
 */
function targetForProject(targets, name, { readable = false } = {}) {
  if (!name) return null;
  const owns = readable ? readableProjectsOf : projectsOf;
  return targets.find((t) => owns(t).includes(name)) || null;
}

/**
 * Which target does this invocation act on?
 *
 *   args.pipeline_name  → the target whose `pipeline` matches EXACTLY, else a
 *                         pipeline_not_registered refusal.
 *   args.project        → READ TOOLS ONLY (requirePipelineName false): the
 *                         target owning that ci/build/deploy project — plus the
 *                         runtime-image deploy project when the caller passes
 *                         readableProjects (get_build_log, TEAM-4866) — else a
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
async function resolveTarget(
  args = {},
  { requirePipelineName = false, readableProjects = false } = {}
) {
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
      // readableProjects (TEAM-4866) is passed by get_build_log ONLY, and widens
      // this membership test to the read-only set — see readableProjectsOf.
      const owns = readableProjects ? readableProjectsOf : projectsOf;
      const target = targetForProject(targets, requestedProject, { readable: readableProjects });
      if (!target) {
        return {
          target: null,
          targets,
          refusal: {
            ok: false,
            reason: "project_not_registered",
            requested: requestedProject,
            known: targets.flatMap(owns),
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
      // The ONE tool that may name the Deploy stage's runtime-image project
      // (TEAM-4866): reading a build log is a read. No other case passes this.
      case "get_build_log":
        return await onTarget(args, { readableProjects: true }, (t, all) =>
          getBuildLog(args, t, all)
        );
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
//
// It also returns `sourceRevision` — the commit this execution was started for,
// already read here for the handoff key. TEAM-4706's superseded lookup needs it to
// recognise the newer execution built from the SAME commit, and reading it from
// this one call keeps that path at a single extra API call.
async function executionSnapshot(pipelineName, pipelineExecutionId, cp) {
  const none = { status: null, handoff: null, sourceRevision: null };
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
  if (!ARTIFACT_BUCKET || !sha) return { status, handoff: null, sourceRevision: sha || null };
  // The Build stage truncates the source revision to 12 chars for GIT_SHA, and
  // the Deploy stage keys the marker on that.
  const key = `pipeline-artifacts/handoff/${sha.slice(0, 12)}.txt`;
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key })
    );
    const body = await obj.Body.transformToString();
    const files = body.split("\n").map((l) => l.trim()).filter(Boolean);
    return { status, handoff: { sha: sha.slice(0, 12), files }, sourceRevision: sha };
  } catch (e) {
    // NoSuchKey is the normal case: this deploy had nothing to hand off.
    if (e.name !== "NoSuchKey" && e.name !== "NotFound") {
      console.warn("handoff marker read failed (non-fatal):", e.name, e.message);
    }
    return { status, handoff: null, sourceRevision: sha };
  }
}

/**
 * TEAM-4706 — which execution took over from a Superseded one?
 *
 * CodePipeline supersedes a queued execution when a newer one enters the same
 * stage, and the newer one is then the run that reaches (and parks at) the human
 * deploy gate. A blueprint watching its own execution_id therefore has to be able
 * to FOLLOW its work: the successor is the newest OTHER execution built from the
 * IDENTICAL source revision, because that is the only relationship that proves the
 * new run carries the same commit rather than someone else's later push.
 *
 * ONE ListPipelineExecutions, its DEFAULT page, no pagination — the whole history
 * is never walked. Called only from the superseded branch of getState's waitingOn,
 * never from a poll that is merely waiting.
 *
 * `sourceRevision` is the fallback read from GetPipelineExecution
 * (artifactRevisions); the summary's own sourceRevisions value is preferred when
 * the caller's execution is still on this page, so both sides of the comparison
 * come from the same field.
 *
 * @returns {Promise<string|null>} the successor's pipelineExecutionId, or null
 */
async function findSupersedingExecution(pipelineName, executionId, sourceRevision, cp) {
  let summaries = [];
  try {
    const out = await cp.send(new ListPipelineExecutionsCommand({ pipelineName }));
    summaries = out.pipelineExecutionSummaries || [];
  } catch (e) {
    // Non-fatal, like every other enrichment in get_state: no successor reported.
    console.warn("list-pipeline-executions failed (non-fatal):", e?.name, e?.message);
    return null;
  }
  const mine = summaries.find((s) => s?.pipelineExecutionId === executionId);
  const revision = mine?.sourceRevisions?.[0]?.revisionId || sourceRevision || null;
  // No revision to match on → no claim. Guessing "the newest execution" here would
  // point a blueprint at an unrelated push.
  if (!revision) return null;
  // Summaries come back newest-first, so the first match is the newest successor.
  const successor = summaries.find(
    (s) =>
      s?.pipelineExecutionId &&
      s.pipelineExecutionId !== executionId &&
      s.sourceRevisions?.[0]?.revisionId === revision
  );
  return successor?.pipelineExecutionId || null;
}

/** How many summaries the adoption probe reads. One page, newest-first — a
 * duplicate of a commit we are deploying RIGHT NOW is necessarily recent. */
const ADOPTION_SCAN = 20;

/**
 * TEAM-4866 — is an execution for THIS exact commit already in flight?
 *
 * Two executions deployed byte-identical code five minutes apart (2026-09-19
 * e60cfd93 / 520dd56d) because nothing looked: gateAhead only sees an execution
 * PARKED on the ManualApproval gate, so a RUNNING duplicate is invisible to it,
 * and CodePipeline's own clientRequestToken idempotency does not dedupe two
 * DIFFERENT calls that merely happen to carry the same source revision (the
 * duplicate's Source stage pulled the branch HEAD, it passed no commit_sha at all).
 *
 * ORDERING INVARIANT — this runs BEFORE StartPipelineExecution, and must stay
 * there. That is the whole reason no "is this one mine?" filter is needed: at the
 * moment of the call our own execution does not exist yet, so every InProgress
 * summary on this revision belongs to somebody else. Move this call after the
 * start and it would adopt the execution it just created, report started:false
 * for a deploy it DID start, and make the tool lie about what it did.
 *
 * Matching is conservative — a wrong adoption means a deploy that never happens:
 *   - 40-hex commit_sha  → exact compare against every sourceRevisions[] entry
 *                          (Source may report more than one artifact).
 *   - 7-39 hex           → prefix match, adopted ONLY when exactly one InProgress
 *                          execution matches. Two matches is ambiguous, so we start.
 *   - anything else      → no candidate (the caller skips the probe entirely).
 * Only status "InProgress" counts: a Succeeded/Failed/Stopped/Superseded execution
 * on this revision is history, and re-deploying after a failure is the point.
 *
 * FAIL-OPEN by construction: this is duplicate avoidance, not a safety gate. A
 * throw (AccessDenied on a role that predates the ListPipelineExecutions grant, a
 * throttle) comes back as {error} and the caller starts exactly as before.
 *
 * @returns {Promise<{summary: object|null, error: string|null}>}
 */
async function findInFlightForRevision(pipelineName, sha, cp) {
  let summaries = [];
  try {
    const out = await cp.send(
      new ListPipelineExecutionsCommand({ pipelineName, maxResults: ADOPTION_SCAN })
    );
    summaries = out.pipelineExecutionSummaries || [];
  } catch (e) {
    console.warn(
      "adoption probe: list-pipeline-executions failed (non-fatal, starting anyway):",
      e?.name,
      e?.message
    );
    return { summary: null, error: e?.name || "list_failed" };
  }
  const exact = FULL_SHA.test(sha);
  const matches = summaries.filter(
    (s) =>
      s?.pipelineExecutionId &&
      s.status === "InProgress" &&
      (s.sourceRevisions || []).some((r) => {
        const rev = normalizeSha(r?.revisionId);
        return exact ? rev === sha : rev.startsWith(sha);
      })
  );
  // Ambiguity is only possible on a short SHA; an exact 40-hex match on two live
  // executions means two runs of the same commit, and adopting the newest (first)
  // is exactly what a second caller wants.
  if (matches.length === 0) return { summary: null, error: null };
  if (!exact && matches.length > 1) {
    console.warn(
      `adoption probe: short sha ${sha} matched ${matches.length} in-flight executions — starting instead of guessing`
    );
    return { summary: null, error: null };
  }
  return { summary: matches[0], error: null };
}

/** An AWS SDK timestamp (a Date live, a string in a replayed fixture) as an ISO
 * string, or null. A value that does not parse is UNKNOWN — never a fabricated
 * date, because `pendingSince` is what a blueprint uses to decide how long a
 * human has been sitting on a gate. */
function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * TEAM-4740 — the ONE place this Lambda decides "a human approval is pending".
 *
 * Detected exactly the way the Telegram bridge detects it
 * (deploy/telegram-bug-intake scanDeployApprovalsForTarget): an action with a
 * token AND status InProgress. Extracted so `get_state` and `start_deploy` cannot
 * drift into two different answers about who holds the gate — the head-of-line
 * bug this ticket fixes is precisely a disagreement between "what the pipeline
 * shows" and "what the caller was told".
 *
 * Reads the token's PRESENCE only; the value is never bound to a name, compared,
 * returned or logged.
 *
 * @param {object} state raw GetPipelineState output
 * @returns {{stage: string|null, action: string|null, executionId: string|null,
 *   pendingSince: string|null} | null} the first pending approval, or null
 */
function findPendingApproval(state) {
  for (const s of state?.stageStates || []) {
    const a = (s.actionStates || []).find(
      (x) => x.latestExecution?.token && x.latestExecution?.status === "InProgress"
    );
    if (!a) continue;
    return {
      // The execution PARKED at the gate: the stage's own latest execution, since
      // a waiting ManualApproval is what that stage is currently running.
      stage: s.stageName || null,
      action: a.actionName || null,
      executionId: s.latestExecution?.pipelineExecutionId || null,
      pendingSince: isoOrNull(a.latestExecution?.lastStatusChange),
    };
  }
  return null;
}

/**
 * TEAM-4740 FR-4 — the ACTIONABLE projection of `waitingOn`.
 *
 * `waitingOn` (TEAM-4706) says WHO holds the human deploy gate. It is
 * observational, and an agent reading it still has to work out whether that means
 * "this is mine, wait for the human" or "someone else's run is in front of me and
 * mine will never even enter the stage". This function makes that second case a
 * VALUE: a `blocker` object plus a one-word `remedy`.
 *
 * PURE, exported and separately tested (src/lib/workflow/blocker-projection.test.ts)
 * on purpose: it is the whole decision, so it must be readable as a truth table
 * rather than inferred from two call sites. It performs no I/O and takes no
 * clients — every field it cannot derive is passed in already-resolved, or stays
 * null.
 *
 * `blocker` is non-null for `holdsGate === "older"` and NOTHING ELSE. "this" means
 * the gate is ours (wait for the human — normal), and "unknown" means we could not
 * establish a relationship, which is not evidence that something is in front of us.
 *
 * `blocker` always has EXACTLY these seven keys, every one present with an
 * explicit null: a consumer must never have to tell "absent" from "unknown", and
 * JSON.stringify drops undefined. Note C8: `holdsGate` can be "older" with
 * `executionId === null` (the stage named OUR execution as inbound but exposed no
 * parked execution id) — that is still a real blocker, just an unnameable one, and
 * an unnameable blocker can never be abandoned.
 *
 * `remedy` is a SIBLING on the response, never a key inside `blocker`:
 *   null                  nothing is in front of us
 *   "follow_superseder"   our own run was superseded — the successor inherited our
 *                         commit and the gate, so follow it (waitingOn.supersededBy)
 *   "wait"               someone else's run genuinely holds the gate
 * start_deploy may additionally report "abandon", but only AFTER it has proven
 * ancestry and confirmed a Stop — this function never speculates it.
 *
 * @param {object|null} waitingOn get_state's waitingOn, or null
 * @param {{ours?: string|null, sourceSha?: string|null, pr?: string|null,
 *   pendingSince?: string|null}} [opts] `ours` is the caller's own execution id;
 *   the rest are enrichments the caller resolved (each optional, null when unknown)
 * @returns {{blocker: object|null, remedy: string|null}}
 */
export function blockerFromWaitingOn(waitingOn, opts = {}) {
  const { ours = null, sourceSha = null, pr = null, pendingSince = null } = opts;
  if (!waitingOn || waitingOn.holdsGate !== "older") {
    return { blocker: null, remedy: null };
  }
  const supersededBy = waitingOn.supersededBy || null;
  // A successor that IS us is not a successor. findSupersedingExecution already
  // excludes the caller's own id, but this projection is the contract and must not
  // depend on that: telling a caller to "follow" itself is a spin loop, and the
  // safe direction for a capability flag is off.
  const supersedable = Boolean(supersededBy) && supersededBy !== ours;
  return {
    blocker: {
      executionId: waitingOn.executionId ?? null,
      sourceSha: sourceSha ?? null,
      pr: pr ?? null,
      pendingSince: pendingSince ?? null,
      stage: waitingOn.stage ?? null,
      action: waitingOn.action ?? null,
      supersedable,
    },
    remedy: supersedable ? "follow_superseder" : "wait",
  };
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
//
// TEAM-4706 adds `waitingOn`: null, or WHICH execution is parked at the human
// deploy gate and how it relates to the caller's — see the block that builds it.
// Observational only; it grants no approval capability and reads the approval
// token's PRESENCE, never its value.
async function getState(args = {}, target) {
  // The pipeline is the RESOLVED target's — args.pipeline_name was already
  // validated against the allow-list (or refused) before we got here.
  const name = target.pipeline;
  const { cp } = clientsFor(target.region, target.roleArn, target.externalId);
  const executionId = String(args.execution_id || "").trim();
  const state = await cp.send(new GetPipelineStateCommand({ name }));

  // TEAM-4706: stageStates[].inboundExecution is the run QUEUED BEHIND whatever
  // currently occupies the stage — the shape of "my execution is waiting for the
  // build in front of it". Collected during the ONE walk below rather than added to
  // the mapped stage, because `stages` is a response contract callers already read.
  const inboundByStage = new Map();
  const stages = (state.stageStates || []).map((s) => {
    inboundByStage.set(s.stageName, s.inboundExecution?.pipelineExecutionId || null);
    return {
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
    };
  });

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
  const {
    status: executionStatus,
    handoff,
    sourceRevision,
  } = await executionSnapshot(name, pipelineExecutionId, cp);

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

  // ── waitingOn: WHOSE approval is the gate holding? (TEAM-4706) ──────────────
  // approvalSkipped answers "is a human being waited on at all". It does not
  // answer the question a polling agent actually has: is the run parked at that
  // gate MINE? A pipeline serialises executions, so the build in front of yours can
  // sit at the human gate for hours while your own execution waits to enter the
  // stage — and get_state's stage list looks identical either way. Without this,
  // an agent either files a SECOND human gate ticket for a gate that is already
  // pending (someone else's), or waits forever on a gate it will never reach.
  //
  // Purely OBSERVATIONAL: it reports a relationship between execution ids and
  // grants no new capability. There is still no PutApprovalResult here.
  //
  // The approval is detected by findPendingApproval — the ONE scanner
  // start_deploy shares, so the two tools can never disagree about who holds the
  // gate. It reads the token's PRESENCE only; the value is never bound to a name
  // here, so it cannot be compared, logged or returned even by mistake.
  let waitingOn = null;
  let blocker = null;
  let remedy = null;
  const pending = findPendingApproval(state);
  if (pending) {
    const parkedId = pending.executionId;
    const inboundId = inboundByStage.get(pending.stage) || null;
    // Fail toward "unknown": claiming "this" wrongly is what makes a blueprint file
    // a duplicate gate ticket, so it is only ever said on positive evidence.
    let holdsGate = "unknown";
    if (executionId) {
      if (parkedId && parkedId === executionId) {
        holdsGate = "this";
      } else if (parkedId || inboundId === executionId) {
        // Either the gate demonstrably belongs to another execution, or this stage
        // names OUR execution as the one queued behind it. Both mean: not ours.
        holdsGate = "older";
      }
    } else if (parkedId && pipelineExecutionId && parkedId === pipelineExecutionId) {
      // No execution_id was supplied, so "mine" can only mean the pipeline's latest
      // run — and it is the one parked.
      holdsGate = "this";
    }
    // All seven keys are ALWAYS present (null rather than absent): JSON.stringify
    // drops undefined, and a field an agent is told to branch on must not appear
    // and disappear with an unnamed stage or action.
    waitingOn = {
      kind: "human_approval",
      stage: pending.stage,
      action: pending.action,
      executionId: parkedId,
      holdsGate,
      // Only meaningful when someone else holds the gate: the execution our own is
      // queued behind.
      queuedBehind: holdsGate === "older" ? parkedId : null,
      // The ONE extra AWS call this field can cost, and only on the cold path: the
      // caller's own execution was superseded, so it needs the id of the run that
      // inherited its commit (and, typically, this gate).
      supersededBy:
        executionId && executionStatus === "Superseded"
          ? await findSupersedingExecution(name, executionId, sourceRevision, cp)
          : null,
    };

    // TEAM-4740 FR-4 — the actionable projection, ADDED BESIDE `waitingOn`, which
    // keeps its exact shape and key order (callers written against TEAM-4706 see no
    // change at all).
    //
    // Enrichment costs at most ONE extra call and only on the branch that can
    // actually use it: someone else holds the gate AND we can name their execution.
    // `pendingSince` is free — the reduced action already carries lastStatusChange.
    let blockedSourceSha = null;
    if (waitingOn.holdsGate === "older" && waitingOn.executionId) {
      // executionSnapshot is the ONE reader of an execution's source revision in
      // this file (artifactRevisions[0].revisionId — NOT `sourceRevisions`, which
      // the ticket names and CodePipeline does not put on this API). Reusing it
      // rather than adding a second reader is what keeps the two in step. It is
      // non-fatal by construction, so a failure leaves the field null.
      blockedSourceSha = (
        await executionSnapshot(name, waitingOn.executionId, cp)
      ).sourceRevision;
    }
    ({ blocker, remedy } = blockerFromWaitingOn(waitingOn, {
      ours: executionId || pipelineExecutionId || null,
      sourceSha: blockedSourceSha,
      // Genuinely unknown here, so null rather than guessed (DL-028): CodePipeline
      // has no PR concept, and the blocking run's PR is only recorded in ITS
      // ship-approval record — another run's state, which this role is deliberately
      // not granted to read.
      pr: null,
      pendingSince: pending.pendingSince,
    }));
  }

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
    // TEAM-4706: null, or WHOSE human approval the gate is currently holding —
    // { kind, stage, action, executionId, holdsGate, queuedBehind, supersededBy }.
    waitingOn,
    // TEAM-4740 FR-4: null, or the run IN FRONT of this one at the human deploy
    // gate — { executionId, sourceSha, pr, pendingSince, stage, action,
    // supersedable }, always all seven keys. Non-null ONLY when waitingOn.holdsGate
    // is "older", i.e. this execution is queued behind someone else's approval and
    // will not enter the stage until theirs resolves.
    blocker,
    // null | "follow_superseder" | "wait" — what to DO about `blocker`. A sibling,
    // never a key inside it.
    remedy,
    stages,
    actionDetails,
  });
}

// ─── FR-4: head-of-line blocking at the human deploy gate (TEAM-4740) ────────
// Starting a deploy while an OLDER execution is parked on the ManualApproval does
// not fail — it queues, invisibly, behind a gate that may not resolve for hours.
// So start_deploy now LOOKS FIRST and refuses; and, only when explicitly asked,
// can abandon the run in front of it once it has PROVEN that doing so throws away
// nothing (their commit is contained in ours).
//
// Every refusal below is a returned value, never a throw, and none of them can
// leave a deploy half-started: the refusal happens before the ship-approval record
// is written and before StartPipelineExecution is called.

/** The closed refusal vocabulary for the gate. Five reasons, and no sixth: each
 * one names a specific thing we could not PROVE, so an agent can tell "wait" from
 * "you are not allowed to do that" from "I could not confirm it worked". */
const ABANDON_REASONS = {
  /** An older execution holds the gate and no abandon was requested. Nothing was
   * started and nothing was recorded. */
  OCCUPIED: "approval_stage_occupied",
  /** Ancestry was not proven: no GITHUB_TOKEN, an unnameable blocker, an
   * unparseable target repo, a GitHub error/timeout, or a compare that says
   * anything other than "ahead". Nothing was stopped. */
  ANCESTRY: "ancestry_unproven",
  /** SEC-5: between the projection and the Stop, the gate stopped being that
   * execution's — most likely a human just decided. Nothing was stopped. */
  GONE: "gate_no_longer_occupied",
  /** SEC-15: codepipeline:StopPipelineExecution is not granted here. */
  NOT_PERMITTED: "abandon_not_permitted",
  /** The Stop was issued but the execution is not confirmed Stopped, so we will
   * not start on top of a run that may still be live. */
  UNCONFIRMED: "abandon_unconfirmed",
};

/** `owner/repo` from a registry target, or null. Anchored and charset-limited for
 * the same reason parsePrUrl is: the result goes straight into a URL path. */
function parseOwnerRepo(value) {
  const m = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/.exec(
    String(value ?? "").trim()
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Is the blocked execution's commit CONTAINED in the code we are about to deploy?
 *
 * That is the only question that makes abandoning someone else's parked run safe:
 * if their commit is an ancestor of ours, our deploy delivers their change too and
 * nothing is lost. Anything weaker (a newer timestamp, a bigger execution id, a
 * caller's assurance) is a guess.
 *
 * SEC-4 — every input is SERVER-DERIVED. `theirSha` comes from
 * executionSnapshot(blocker.executionId); owner/repo come from the resolved
 * registry target; and "ours" is the repo's DEFAULT BRANCH as GitHub reports it,
 * which is what StartPipelineExecution is about to build. Deliberately not
 * args.commit_sha: a caller must not be able to name the SHA that justifies
 * killing another run.
 *
 * Proof is `compare` returning EXACTLY "ahead". `identical` (same commit — nothing
 * gained), `behind`, `diverged`, a non-2xx, a timeout or a missing token are all
 * NOT PROVEN, and not-proven stops nothing (DL-028: "we could not look" is not
 * "there is nothing there").
 *
 * @returns {Promise<{ok: true, ourRef: string, aheadBy: number|null}
 *   | {ok: false, detail: string}>}
 */
async function proveAncestry(target, theirSha) {
  if (!GITHUB_TOKEN) {
    return { ok: false, detail: "GITHUB_TOKEN is not configured on this Lambda" };
  }
  const their = normalizeSha(theirSha);
  if (!FULL_SHA.test(their)) {
    return {
      ok: false,
      detail: `the blocking execution's source revision (${their || "none"}) is not a full SHA`,
    };
  }
  const parsed = parseOwnerRepo(target.repo);
  if (!parsed) {
    return {
      ok: false,
      detail: `registry target names no parseable owner/repo (${target.repo || "none"})`,
    };
  }
  let branch;
  try {
    const meta = await githubJson(`/repos/${parsed.owner}/${parsed.repo}`);
    if (!meta.ok) {
      return { ok: false, detail: `GitHub returned ${meta.status} for the repo` };
    }
    branch = String(meta.json?.default_branch ?? "").trim();
  } catch (e) {
    return { ok: false, detail: `repo read failed: ${e?.name}: ${e?.message}` };
  }
  // Charset-limited and traversal-free, exactly like parsePrUrl's captures: this
  // string is about to be a URL path segment. Slashes are legal in a ref and are
  // left unencoded, which is what GitHub's compare endpoint expects.
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes("..")) {
    return { ok: false, detail: "GitHub reported no usable default branch" };
  }
  try {
    const cmp = await githubJson(
      `/repos/${parsed.owner}/${parsed.repo}/compare/${their}...${branch}`
    );
    if (!cmp.ok) {
      return {
        ok: false,
        detail: `GitHub returned ${cmp.status} comparing ${their.slice(0, 12)}...${branch}`,
      };
    }
    const status = cmp.json?.status;
    if (status !== "ahead") {
      return {
        ok: false,
        detail: `compare ${their.slice(0, 12)}...${branch} is "${status || "unknown"}", not "ahead"`,
      };
    }
    return {
      ok: true,
      ourRef: branch,
      aheadBy: typeof cmp.json?.ahead_by === "number" ? cmp.json.ahead_by : null,
    };
  } catch (e) {
    return { ok: false, detail: `compare failed: ${e?.name}: ${e?.message}` };
  }
}

/**
 * Abandon the execution parked on the gate — the opt-in path, five gates deep.
 *
 * In order, and every one of them must hold:
 *   1. `holdsGate === "older"` — guaranteed by the caller, which only reaches here
 *      with a non-null blocker;
 *   2. the blocker is NAMEABLE (an unnameable one cannot be proven safe, so it is
 *      reported as ancestry_unproven rather than acted on);
 *   3. ancestry PROVEN (proveAncestry, server-derived inputs only);
 *   4. SEC-5 — a FRESH GetPipelineState still shows that same execution holding a
 *      pending approval, because the human may have decided in the meantime;
 *   5. the Stop is permitted, and the execution is CONFIRMED Stopped afterwards.
 *
 * The abandoned execution's ship-approval record is never touched: it is not
 * copied, rewritten or carried forward. Our own record (if any) is written after
 * this returns, keyed on our own merge commit, exactly as it always was.
 *
 * @returns {Promise<{ok: true, ourRef: string, aheadBy: number|null}
 *   | {ok: false, reason: string, detail: string}>}
 */
async function abandonParkedExecution({ name, target, cp, blocker }) {
  if (!blocker.executionId) {
    return {
      ok: false,
      reason: ABANDON_REASONS.ANCESTRY,
      detail:
        "the blocking execution is not identified, so nothing about it can be proven",
    };
  }
  const proof = await proveAncestry(target, blocker.sourceSha);
  if (!proof.ok) {
    return { ok: false, reason: ABANDON_REASONS.ANCESTRY, detail: proof.detail };
  }

  // SEC-5. Re-read immediately before the Stop, through the SAME scanner get_state
  // uses, so "still occupied" means the same thing in both tools.
  let still;
  try {
    still = findPendingApproval(await cp.send(new GetPipelineStateCommand({ name })));
  } catch (e) {
    return {
      ok: false,
      reason: ABANDON_REASONS.GONE,
      detail: `the gate could not be re-read: ${e?.name}: ${e?.message}`,
    };
  }
  if (!still || still.executionId !== blocker.executionId) {
    return {
      ok: false,
      reason: ABANDON_REASONS.GONE,
      detail: still
        ? `the pending approval now belongs to ${still.executionId}`
        : "no approval is pending any more",
    };
  }

  try {
    await cp.send(
      new StopPipelineExecutionCommand({
        pipelineName: name,
        pipelineExecutionId: blocker.executionId,
        abandon: true,
        // Abandon, not stop-and-wait: a parked ManualApproval has nothing to unwind.
        reason:
          "Abandoned by agentcore-hub: a newer deploy contains this commit (TEAM-4740)".slice(
            0,
            200
          ),
      })
    );
  } catch (e) {
    if (e?.name === "AccessDeniedException" || e?.name === "AccessDenied") {
      return {
        ok: false,
        reason: ABANDON_REASONS.NOT_PERMITTED,
        detail: "codepipeline:StopPipelineExecution is not granted to this Lambda",
      };
    }
    return {
      ok: false,
      reason: ABANDON_REASONS.UNCONFIRMED,
      detail: `stop failed: ${e?.name}: ${e?.message}`,
    };
  }

  // Confirm, do not assume. Reuses executionSnapshot (the one execution reader) and
  // is fail-closed: an unreadable status is not a Stopped status.
  const after = await executionSnapshot(name, blocker.executionId, cp);
  if (after.status !== "Stopped") {
    return {
      ok: false,
      reason: ABANDON_REASONS.UNCONFIRMED,
      detail: `${blocker.executionId} is "${after.status || "unreadable"}", not "Stopped"`,
    };
  }
  return { ok: true, ourRef: proof.ourRef, aheadBy: proof.aheadBy };
}

/**
 * What is in front of a deploy we have not started yet?
 *
 * start_deploy has started NOTHING, so an execution already parked at the gate is
 * provably not ours — this is the one place `holdsGate: "older"` is a certainty
 * rather than an inference, and `supersededBy` is necessarily null (we have no run
 * to have been superseded).
 *
 * FAIL OPEN. A GetPipelineState we could not read means the projection was not
 * evaluated, and refusing on that would turn a transient CodePipeline error into a
 * blocked ship. Queue etiquette is not a safety property — the human deploy gate
 * itself still fires either way — so an unreadable gate proceeds and says so
 * (`gateProbe: "unavailable"`).
 */
async function gateAhead(name, target, cp) {
  let pending = null;
  try {
    pending = findPendingApproval(await cp.send(new GetPipelineStateCommand({ name })));
  } catch (e) {
    console.warn("deploy-gate probe failed (non-fatal, start proceeds):", e?.name, e?.message);
    return { blocker: null, remedy: null, probe: "unavailable" };
  }
  if (!pending) return { blocker: null, remedy: null, probe: "clear" };
  const sourceSha = pending.executionId
    ? (await executionSnapshot(name, pending.executionId, cp)).sourceRevision
    : null;
  const projected = blockerFromWaitingOn(
    {
      kind: "human_approval",
      stage: pending.stage,
      action: pending.action,
      executionId: pending.executionId,
      holdsGate: "older",
      queuedBehind: pending.executionId,
      supersededBy: null,
    },
    { ours: null, sourceSha, pr: null, pendingSince: pending.pendingSince }
  );
  return { ...projected, probe: "occupied" };
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
//
// TEAM-4866 — THREE terminal shapes now, and only the middle one is a refusal:
//   started:true                      a new execution (the ordinary answer)
//   started:false + adopted:true      an execution for THIS commit was already in
//                                     flight, so we return ITS id instead of
//                                     deploying the same bytes twice. ok:true.
//   ok:false + reason                 refused (FR-4 gate occupied / abandon
//                                     refusals) — nothing started, nothing recorded.
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

  // ── TEAM-4866 adoption probe. FIRST — before gateAhead, before the abandon
  // branch, before the start (see findInFlightForRevision's ordering invariant).
  // Before gateAhead specifically because the duplicate may BE the execution
  // parked on the gate: that one is ours to follow, never to abandon, and a
  // gateAhead refusal would have sent the caller off to prove ancestry against a
  // run built from its own commit.
  const adoptionSha = normalizeSha(args.commit_sha);
  let adoptionCheck = null;
  if (/^[0-9a-f]{7,40}$/.test(adoptionSha)) {
    const { summary, error } = await findInFlightForRevision(name, adoptionSha, cp);
    if (error) {
      // Fail-open: record that we could not look, and carry on to start.
      adoptionCheck = { ok: false, reason: error };
    } else if (summary) {
      // The record write is unchanged and unconditional on this path: it is keyed
      // by merge commit and idempotent, so writing it for an execution someone
      // else started is the same statement about the same commit. It can only ever
      // make the human gate MORE likely to fire — the adopted run may already be
      // past the Build stage's preapproved-check, in which case the human is asked
      // exactly as before (fail-closed, DL-028).
      const preapproval = await recordShipApproval(args, target, cb);
      console.log(
        "adopted in-flight execution",
        summary.pipelineExecutionId,
        "for revision",
        adoptionSha
      );
      return jsonResult({
        ok: true,
        started: false,
        adopted: true,
        reason: "same_revision_in_progress",
        pipelineName: name,
        region: target.region,
        repo: target.repo,
        // THEIRS, and deliberately top-level: every caller downstream (the watch
        // poll's execution_id, shared/cd-ledger.json, report_completion) reads
        // this key, and the execution to watch is that one.
        pipelineExecutionId: summary.pipelineExecutionId,
        adoptedExecution: {
          executionId: summary.pipelineExecutionId,
          status: summary.status || null,
          startTime: isoOrNull(summary.startTime),
          trigger: summary.trigger || null,
          sourceRevision: summary.sourceRevisions?.[0]?.revisionId || null,
        },
        preapproval,
        note:
          "NOTHING new was started: an execution for THIS commit was already in flight, so this call ADOPTED it. " +
          "started:false with adopted:true is a SUCCESS, not a refusal — do not retry, and do not treat it as a fault. " +
          "pipelineExecutionId is that execution's: poll get_state with execution_id=<it> until terminal:true AND " +
          "matchesExecution:true, and record it as this run's CD execution exactly as if you had started it. " +
          "holdsGate/waitingOn may report it as another run's gate, which is expected — it deploys your commit. " +
          "The ship-approval record was still written for this merge commit (see preapproval); if the adopted run was " +
          "already past the point where the pipeline reads it, the human deploy gate fires as usual, which is the safe " +
          "outcome. You have NO approval capability here.",
      });
    }
  }

  // ── FR-4 (TEAM-4740). BEFORE recordShipApproval, which is itself before the
  // start: a refused deploy must leave NOTHING behind — no execution and no
  // ship-approval record for a merge commit that was never deployed.
  const gate = await gateAhead(name, target, cp);
  let abandoned = null;
  if (gate.blocker) {
    // Opt-in only, and only ever from an explicit arg. `"true"` is accepted because
    // every runtime-tool parameter arrives as a string.
    const optedIn = args.abandon === true || args.abandon === "true";
    const outcome = optedIn
      ? await abandonParkedExecution({ name, target, cp, blocker: gate.blocker })
      : { ok: false, reason: ABANDON_REASONS.OCCUPIED, detail: "" };
    if (!outcome.ok) {
      return jsonResult({
        ok: false,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        pipelineName: name,
        region: target.region,
        repo: target.repo,
        blocker: gate.blocker,
        remedy: gate.remedy,
        note:
          "NOTHING was started and NO ship-approval record was written — this deploy does not exist. " +
          "An OLDER execution is parked on the human deploy gate, so starting now would only queue behind it. " +
          "remedy 'wait': poll get_state until waitingOn clears, then call start_deploy again. " +
          "remedy 'follow_superseder': your own execution was superseded — poll the successor instead of starting a new run. " +
          "Passing abandon:true asks to discard the run in front of you, and is honoured ONLY when GitHub proves its " +
          "commit is already contained in what you are deploying, the gate is still that run's, and the stop is confirmed. " +
          "You still have NO approval capability: this tool cannot approve a gate for you or for anyone else.",
      });
    }
    // Proven and confirmed — the ONE case where supersedable is asserted true and
    // the remedy is "abandon", because it actually happened.
    abandoned = {
      ...gate.blocker,
      supersedable: true,
      remedy: "abandon",
      ourRef: outcome.ourRef,
      aheadBy: outcome.aheadBy,
    };
    console.log(
      "abandoned parked execution",
      gate.blocker.executionId,
      "ancestry proven against",
      outcome.ourRef
    );
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
    // TEAM-4740: present ONLY when this call discarded a run parked on the gate.
    ...(abandoned ? { abandoned } : {}),
    // Present ONLY when the gate could not be read at all, so a caller can tell
    // "the gate was clear" from "we started without being able to check".
    ...(gate.probe === "unavailable" ? { gateProbe: "unavailable" } : {}),
    // TEAM-4866: present ONLY when the adoption probe was ATTEMPTED and FAILED —
    // absent both on the clean path and when there was no sha to probe with. Same
    // idea as gateProbe: "we started without being able to check for a duplicate".
    ...(adoptionCheck ? { adoptionCheck } : {}),
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
  // ── the human veto (TEAM-4740 SEC-1(3)) ───────────────────────────────────
  /** A `<merge_commit>.rejected.json` marker exists: a human REJECTED this exact
   * commit at a gate. A prior approval of the same head can never outvote that, so
   * no record is written and the gate fires — which is the point. */
  HUMAN_REJECTED: "human_rejected",
  /** The rejection marker could not be probed. We cannot prove there is NO veto,
   * and "we could not look" is not "there is nothing there" (DL-028) — so no
   * record, and the human is asked. */
  REJECTION_UNVERIFIED: "rejection_unverified",
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
 * The ONE way this Lambda talks to GitHub — a single read-only GET.
 *
 * Extracted (TEAM-4740) so a second GitHub read cannot drift from the first on the
 * three properties that make it safe: the read-only token, the pinned API version
 * header, and a timeout SHORTER than the Lambda's own budget so a slow GitHub
 * fails closed instead of consuming it. `path` is always built from values this
 * Lambda derived itself (a parsePrUrl result, a server-read source revision), never
 * pasted from args.
 *
 * The caller decides what a non-2xx MEANS — for a merge binding it is "unverified",
 * for an ancestry probe it is "unproven" — so the status is returned rather than
 * translated here. A transport failure (timeout, DNS) still THROWS: "we could not
 * look" must never be reachable as a successful answer.
 *
 * @returns {Promise<{ok: boolean, status: number, json: any}>} `json` is the parsed
 *   body on 2xx and null otherwise (a non-2xx body is an error document, never data).
 */
async function githubJson(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agentcore-hub-pipeline-tools",
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json() : null };
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
    const gh = await githubJson(
      `/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`
    );
    if (!gh.ok) {
      return {
        ok: false,
        reason: PREAPPROVAL_REASONS.BINDING_UNVERIFIED,
        detail: `GitHub returned ${gh.status}`,
      };
    }
    pr = gh.json;
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

  // ── the human veto, checked FIRST (TEAM-4740 SEC-1(3)) ────────────────────
  // A `<merge_commit>.rejected.json` marker means a human said NO to deploying this
  // exact commit. Every proof below is about whether a human said YES to the code —
  // none of it can outrank an explicit NO, so the veto is read before any of it and
  // short-circuits the whole function. HeadObject, not GetObject: the marker's
  // EXISTENCE is the signal and this role can read nothing else about it.
  //
  // Fail-closed in both directions, which is why this is not folded into one catch:
  // present → no record; unprobeable → no record either. Both mean the human is
  // asked, which is the safe outcome. Only a definite "no such object" continues.
  if (ARTIFACT_BUCKET) {
    const rejectionKey = `${SHIP_APPROVAL_PREFIX}${mergeCommit}.rejected.json`;
    try {
      await s3.send(
        new HeadObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: rejectionKey })
      );
      console.warn(
        "ship-approval REFUSED: a human rejection marker exists for",
        mergeCommit
      );
      return { recorded: false, reason: PREAPPROVAL_REASONS.HUMAN_REJECTED };
    } catch (e) {
      if (e?.name !== "NotFound" && e?.name !== "NoSuchKey" && e?.$metadata?.httpStatusCode !== 404) {
        console.warn(
          "ship-approval rejection probe failed (non-fatal, gate will fire):",
          e?.name,
          e?.message
        );
        return { recorded: false, reason: PREAPPROVAL_REASONS.REJECTION_UNVERIFIED };
      }
    }
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
  //
  // readable:true (TEAM-4866) — the Deploy stage has TWO CodeBuild actions, and a
  // failed Deploy_runtime_images build was unreadable here until its project
  // joined the read set. Reading is all it adds: nothing in this function starts
  // a build, and projectsOf() (what start_ci_build validates against) is
  // untouched.
  const owner = targetForProject(targets, project, { readable: true });
  if (!owner) {
    return jsonResult({
      ok: false,
      reason: "project_not_registered",
      requested: project,
      known: targets.flatMap(readableProjectsOf),
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
// version 5 (TEAM-4740 FR-4) is a get_state/start_deploy shape change, not a new
// field here: get_state gained `blocker` + `remedy` beside `waitingOn`, and
// start_deploy can now REFUSE (approval_stage_occupied) instead of queueing behind
// an older run. Everything else in this payload is byte-identical to version 4, and
// `approveDeploy` is still a hard false — abandoning a run in front of you is not
// approving it, and there is still no PutApprovalResult in this Lambda's reach.
//
// version 6 (TEAM-4866) adds `targets[].runtimeImageProject` — the Deploy stage's
// SECOND CodeBuild action (Deploy_runtime_images), which get_build_log can now
// read a build log from. It is a READ name only: it is a reserved CI project, so
// `startCiBuild` never applies to it, and nothing here can start it. The same
// version covers start_deploy's new ADOPTION answer (`started:false,
// adopted:true` when an execution for that exact commit is already in flight) —
// still no PutApprovalResult anywhere in this Lambda's reach.
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
      // TEAM-4740 SEC-17: no `known: [...]` here. Every other refusal lists the
      // targets because there is no other way to discover them — but THIS tool IS
      // the discovery surface: calling capabilities() with no pipeline_name returns
      // the whole target list. Echoing it inside its own refusal added nothing and
      // meant one more place a registry could be enumerated from.
      return jsonResult({
        ok: false,
        reason: "pipeline_not_registered",
        requested,
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
    version: 6,
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
      // TEAM-4866 — the Deploy stage's second CodeBuild action. READABLE by
      // get_build_log, never startable: it is a reserved CI project, so
      // startCiBuild below says nothing about it.
      runtimeImageProject: t.runtimeImageProject,
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
