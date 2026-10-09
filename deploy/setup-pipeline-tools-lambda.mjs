#!/usr/bin/env node
/**
 * setup-pipeline-tools-lambda.mjs — deploy the agentcore-hub-pipeline-tools Lambda.
 *
 * The release_manager (PIPELINE mode) calls Pipeline___{get_state,start_deploy,
 * get_build_log} through this Lambda to trigger + watch the deploy pipeline.
 * The coding-runtime IAM role is AccessDenied on CodePipeline/CodeBuild, so the
 * pipeline drive MUST live in this narrowly-scoped Lambda, not in the agent's
 * shell.
 *
 * CI_PROJECT must name a PR-check project with no deploy permissions. Enabling
 * PIPELINE_CI_START_BUILD grants agent-triggerable CI execution: the role gets
 * codebuild:StartBuild on THAT ONE project ARN plus the hub-*-ci convention
 * wildcard and nothing else, and the name is validated (validateCiProjectName,
 * below) before any AWS call — a wildcard, or a name that collides with the
 * build/deploy/runtime-image project or the pipeline, aborts the deploy rather
 * than handing an agent a way to start a deploy.
 *
 * ─── The hub-* naming convention (TEAM-4337) ──────────────────────────────────
 * The Lambda can now drive MORE than the hub's own pipeline: it reads the CD
 * registry (config/cd-registry.json in the artifact bucket) at runtime and
 * resolves a per-repo target from it. IAM is widened ONCE, by CONVENTION, so
 * registering a repo needs no IAM change and no redeploy:
 *
 *   CodePipeline      hub-<slug>-deploy
 *   CodeBuild         hub-<slug>-ci  /  hub-<slug>-build  /  hub-<slug>-deploy
 *   CloudWatch Logs   /aws/codebuild/hub-<slug>-*
 *
 * `hub-` is therefore a RESERVED prefix: anything named hub-* in a
 * PIPELINE_REGIONS region is readable and triggerable by this role. The hub's own
 * resources keep the agentcore-hub-* prefix and stay pinned as exact ARNs.
 *
 * The wildcard is suffix-scoped per action class, which is the whole safety
 * argument: codebuild:StartBuild gets ONLY project/hub-*-ci, never project/hub-*
 * and never hub-*-deploy. There is still NO codepipeline:PutApprovalResult —
 * widening the allow-list can only add a pipeline to READ and TRIGGER, never an
 * approval path.
 *
 * ─── The ship-approval record (TEAM-4525) ─────────────────────────────────────
 * start_deploy records the head SHA a human already approved at Merge Approval,
 * keyed on the merge commit, under pipeline-artifacts/ship-approvals/ in the
 * artifact bucket, so the pipeline can skip re-asking that same human for
 * byte-identical code. That adds ONE statement — ShipApprovalRecordWrite,
 * s3:PutObject on that ONE prefix and nothing else: the only S3 write this role
 * has. It is not an approval grant. codepipeline:PutApprovalResult remains absent
 * in every combination (asserted, not just reviewed, in this script's test), and
 * a role that can write evidence but cannot release a gate is exactly what makes
 * the conditional gate safe.
 *
 * A record is only written when the Lambda can PROVE the commit being deployed is
 * the merge of that approved head — it asks GitHub about the caller's pr_url
 * (merged / head.sha / merge_commit_sha), which is what GITHUB_TOKEN below is for.
 * The token is read-only and confers no approval capability.
 *
 * ─── Why the token is now a deploy-time REQUIREMENT (TEAM-4706) ───────────────
 * "Optional" is technically true and operationally a trap: a Lambda with no token
 * can never verify the merge binding, so it answers
 * preapproval:{recorded:false, reason:"merge_binding_unverified"} forever and
 * EVERY deploy pages a human — the exact drift this deployment hit in prod, and
 * invisible until a release stalls at a gate nobody expected. Its sibling failure
 * was a role without s3:PutObject on the ship-approvals prefix
 * (reason:"record_write_failed"). So this script now REFUSES to deploy a Lambda
 * that cannot record an approval unless the operator opts out explicitly with
 * --allow-no-github-token, and scripts/verify-infra.sh asserts both prerequisites
 * against the live account (the env var NAME and the IAM Resource - never the
 * secret's value).
 *
 * Idempotent / re-runnable. Account-guarded via deploy/config.sh conventions.
 *
 * Usage:
 *   AWS_PROFILE=tycenj-prod node deploy/setup-pipeline-tools-lambda.mjs
 *   # deliberately without a token (every deploy will page a human):
 *   AWS_PROFILE=tycenj-prod node deploy/setup-pipeline-tools-lambda.mjs --allow-no-github-token
 *
 * Env (all optional — sane prod defaults):
 *   PIPELINE_NAME   default agentcore-hub-deploy   (the CodePipeline)
 *   BUILD_PROJECT   default agentcore-hub-build
 *   CI_PROJECT      default agentcore-hub-ci       (the PR-check CodeBuild project;
 *                   the only project Pipeline___start_ci_build can ever start)
 *   PIPELINE_CI_START_BUILD  "1" to grant codebuild:StartBuild on CI_PROJECT
 *                   (adds the CiStartBuild statement + sets the same var on the
 *                   function, so Pipeline___capabilities advertises the tool).
 *                   Anything else — including unset — omits the grant entirely.
 *   GITHUB_TOKEN    a READ-ONLY GitHub token (public_repo / repo:read is enough).
 *                   GITHUB_PAT is accepted as an alias — many operators have only
 *                   that one exported.
 *                   Used for one thing: proving pr_url's PR is merged with
 *                   head.sha == approved_head_sha and merge_commit_sha ==
 *                   commit_sha before a ship-approval record may be written.
 *                   REQUIRED unless --allow-no-github-token is passed: with
 *                   neither var set no record can ever be written, so every deploy
 *                   pages a human — the pre-TEAM-4525 behaviour, which is a
 *                   regression rather than a default worth defaulting to.
 *                   Only sent when non-empty, so it never clobbers a token an
 *                   operator set out of band. Never printed, logged or echoed by
 *                   this script — only the variable NAME ever appears in output.
 *                   (GITHUB_TIMEOUT_MS, read by the Lambda itself, defaults to
 *                   5000: that call is on a 60s Lambda's critical path, so a slow
 *                   API must fail closed rather than burn the whole budget.)
 *   DEPLOY_PROJECT  default agentcore-hub-deploy   (the Deploy stage's CodeBuild
 *                   project — same NAME as the pipeline, different resource kind)
 *   RUNTIME_IMAGE_PROJECT  default agentcore-hub-runtime-image-deploy (TEAM-5033).
 *                   The Deploy stage's SECOND, parallel CodeBuild action
 *                   (Deploy_runtime_images). IAM SCOPING ONLY — it is deliberately
 *                   NOT set on the function: the Lambda learns this name by reading
 *                   the pipeline's own definition (codepipeline:GetPipeline), so a
 *                   fifth project added to the stack needs no code change. This var
 *                   exists because an IAM Resource cannot be discovered at runtime —
 *                   project/hub-* cannot match an agentcore-hub-* name, so the
 *                   BatchGetBuilds/ListBuildsForProject and GetLogEvents grants need
 *                   the exact ARN. It is READ-ONLY in every statement: this name must
 *                   never appear in CiStartBuild.
 *   PIPELINE_REGIONS  comma list of regions holding hub-*-deploy pipelines.
 *                   Default: AWS_REGION alone. The list is taken LITERALLY — set
 *                   it to every region you register repos in, the Lambda's own
 *                   region included, or those repos get AccessDenied.
 *   AWS_REGION      default us-east-1
 */

import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNCTION_NAME = "agentcore-hub-pipeline-tools";
const ROLE_NAME = "agentcore-hub-pipeline-tools-role";

// ─── CI project validation (byte-duplicated from the Lambda) ───────────────────
// This is the same function as lambda/agentcore-hub-pipeline-tools/index.mjs's
// exported validateCiProjectName, deliberately COPIED rather than imported: the
// Lambda zip is index.mjs only (no shared module can ship with it), and importing
// index.mjs here would construct three AWS SDK clients inside a deploy script.
// The two copies are pinned against each other on a shared matrix by
// deploy/setup-pipeline-tools-lambda.test.mjs — change one, change both.
const RESERVED_CI_PROJECTS = ["agentcore-hub-runtime-image-deploy"];

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

/**
 * Normalize a PIPELINE_REGIONS comma list: trim, drop empties, dedupe, keep the
 * operator's order. Empty/absent → [fallback] (the Lambda's own region).
 *
 * Exported because both the policy builder and the function's env var must agree
 * on the SAME list — a mismatch would grant one region and route to another.
 */
export function parsePipelineRegions(value, fallback) {
  const seen = new Set();
  for (const part of String(value ?? "").split(",")) {
    const region = part.trim();
    if (region) seen.add(region);
  }
  if (seen.size === 0 && fallback) seen.add(fallback);
  return [...seen];
}

/** Env → the values this script deploys with. Defaults live here so the policy
 * builder and main() can never disagree about them. */
export function resolveEnv(env = process.env) {
  const REGION = env.AWS_REGION || "us-east-1";
  return {
    REGION,
    PIPELINE_NAME: env.PIPELINE_NAME || "agentcore-hub-deploy",
    BUILD_PROJECT: env.BUILD_PROJECT || "agentcore-hub-build",
    CI_PROJECT: env.CI_PROJECT || "agentcore-hub-ci",
    // The Deploy stage's CodeBuild project. Shares its NAME with PIPELINE_NAME
    // (the CodePipeline) but is a DIFFERENT AWS resource kind — keep the two
    // constants distinct; do not collapse them.
    DEPLOY_PROJECT: env.DEPLOY_PROJECT || "agentcore-hub-deploy",
    // TEAM-5033: the Deploy stage's SECOND, parallel CodeBuild project
    // (Deploy_runtime_images). Present here for IAM SCOPING ONLY and NOT sent to
    // the function — the Lambda discovers it from the pipeline definition. See the
    // Env block above for why an IAM Resource still has to name it literally.
    RUNTIME_IMAGE_PROJECT:
      env.RUNTIME_IMAGE_PROJECT || "agentcore-hub-runtime-image-deploy",
    PIPELINE_CI_START_BUILD: env.PIPELINE_CI_START_BUILD === "1" ? "1" : "0",
    // Every region holding a hub-*-deploy pipeline this role may read + trigger.
    // Normalized to a comma string so the same value can go straight onto the
    // function as an env var; buildInlinePolicy re-parses it.
    PIPELINE_REGIONS: parsePipelineRegions(env.PIPELINE_REGIONS, REGION).join(","),
    // Both the registry source (config/cd-registry.json) and where the Deploy
    // stage records its infra handoff list (get_state reports it as `handoff`).
    // Same convention as deploy/config.sh; ACCOUNT is only known at deploy time,
    // so buildInlinePolicy derives the ARN from it.
    ARTIFACT_BUCKET: env.ARTIFACT_BUCKET || "",
    // TEAM-4525: read-only GitHub credential used ONLY to prove that a
    // start_deploy's commit_sha really is the merge of the head SHA a human
    // approved (verifyMergeBinding). It confers no approval capability.
    // GITHUB_PAT is an accepted alias (TEAM-4706): the two names are equivalent
    // here, GITHUB_TOKEN wins, and with NEITHER set main() refuses to deploy —
    // a token-less Lambda answers merge_binding_unverified forever and pages a
    // human on every deploy. --allow-no-github-token is the explicit opt-out.
    GITHUB_TOKEN: env.GITHUB_TOKEN || env.GITHUB_PAT || "",
  };
}

/**
 * The deploy-time GitHub-token guard, as a pure decision (TEAM-4706).
 *
 * Separated from main() so the DECISION is unit-assertable without executing a
 * deploy: main() is only the caller (print + exit). `token` is never inspected
 * beyond "is there one" and is NEVER placed in the returned message — only the
 * variable NAMES may appear, because a message like this ends up in CI logs.
 *
 * ok:false     → refuse the deploy (no token, no opt-out).
 * ok:true      → proceed; a non-null message is a WARNING that must be printed
 *                (the operator opted out and every deploy will page a human).
 */
export function githubTokenGuard({ token, allowNoGithubToken } = {}) {
  if (token) return { ok: true, message: null };
  if (allowNoGithubToken) {
    return {
      ok: true,
      message:
        "WARNING: no GITHUB_TOKEN (or GITHUB_PAT) and --allow-no-github-token was passed - the tools Lambda can never verify a merge binding, so no ship-approval record is ever recorded, the approve-once skip can never fire, and EVERY deploy will page a human.",
    };
  }
  return {
    ok: false,
    message:
      "Refusing to deploy: set GITHUB_TOKEN (or GITHUB_PAT) to a read-only GitHub token, or pass --allow-no-github-token - without one the Lambda cannot verify a merge binding, records no ship-approval, and EVERY deploy pages a human.",
  };
}

/**
 * The Lambda role's inline policy. Pure (env in, document out) so the blast
 * radius of the StartBuild grant is unit-assertable — see
 * deploy/setup-pipeline-tools-lambda.test.mjs.
 *
 * `env` also carries ACCOUNT (from STS at deploy time); every ARN is derived, so
 * no account id is ever hardcoded.
 *
 * Throws when PIPELINE_CI_START_BUILD is on and CI_PROJECT is not a safe
 * PR-check project name — a bad name must fail the deploy, not widen the grant.
 */
export function buildInlinePolicy(env) {
  const {
    REGION,
    ACCOUNT,
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
  } = env;
  // TEAM-5033 — defaulted here too, so a caller that builds a policy from a
  // hand-made env object (every test in this script's suite does) still gets the
  // runtime-image grants rather than an "undefined" in an ARN.
  const RUNTIME_IMAGE_PROJECT =
    env.RUNTIME_IMAGE_PROJECT || "agentcore-hub-runtime-image-deploy";
  const artifactBucket =
    env.ARTIFACT_BUCKET ||
    (ACCOUNT ? `agentcore-hub-artifacts-${ACCOUNT}-${REGION}` : "");

  const pipelineArn = `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${PIPELINE_NAME}`;
  const buildArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${BUILD_PROJECT}`;
  const ciArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${CI_PROJECT}`;
  const deployArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${DEPLOY_PROJECT}`;
  // TEAM-5033 — the Deploy stage's parallel runtime-image project. An exact ARN
  // because project/hub-* (below) requires a literal `hub-` prefix and this name
  // starts with `agentcore-hub-`, so the wildcard never covered it. READ ONLY.
  const runtimeImageArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${RUNTIME_IMAGE_PROJECT}`;

  // ─── the hub-* convention wildcards, one set per PIPELINE_REGIONS region ─────
  // Registering a repo in the CD registry must not require an IAM edit, so the
  // grant is by NAME CONVENTION. Each wildcard is suffix-scoped to the narrowest
  // form that action class needs:
  //   read + trigger  hub-*-deploy      (pipelines)
  //   read            project/hub-*     (ci + build + deploy projects)
  //   StartBuild      project/hub-*-ci  ONLY - see the CiStartBuild statement
  const REGIONS = parsePipelineRegions(env.PIPELINE_REGIONS, REGION);
  const hubPipelineArns = REGIONS.map((r) => `arn:aws:codepipeline:${r}:${ACCOUNT}:hub-*-deploy`);
  // TEAM-4740 — computed ONCE and referenced by both pipeline statements below.
  // PipelineAbandonSuperseded must be able to stop exactly the executions
  // PipelineReadAndTrigger can already start and read, and not one more; deriving
  // that list a second time is how the two drift apart.
  const pipelineArns = [pipelineArn, ...hubPipelineArns];
  const hubProjectArns = REGIONS.map((r) => `arn:aws:codebuild:${r}:${ACCOUNT}:project/hub-*`);
  const hubCiArns = REGIONS.map((r) => `arn:aws:codebuild:${r}:${ACCOUNT}:project/hub-*-ci`);
  // Both forms, matching the exact-name log statement below: the group itself and
  // its streams.
  const hubLogArns = REGIONS.flatMap((r) => [
    `arn:aws:logs:${r}:${ACCOUNT}:log-group:/aws/codebuild/hub-*`,
    `arn:aws:logs:${r}:${ACCOUNT}:log-group:/aws/codebuild/hub-*:*`,
  ]);

  const ciStartBuild = PIPELINE_CI_START_BUILD === "1";
  if (ciStartBuild) {
    const check = validateCiProjectName(CI_PROJECT, {
      buildProject: BUILD_PROJECT,
      deployProject: DEPLOY_PROJECT,
      pipelineName: PIPELINE_NAME,
    });
    if (!check.ok) {
      throw new Error(
        `PIPELINE_CI_START_BUILD=1 refused: ${check.reason}. Point CI_PROJECT at the PR-check project (default agentcore-hub-ci) or leave the flag unset.`
      );
    }
  }

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Logs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: "*",
      },
      {
        // Read + trigger only, on the hub's own pipeline and on every registered
        // hub-*-deploy pipeline. NO codepipeline:PutApprovalResult — the deploy
        // gate is a human decision (Telegram bridge). Do not add it here, and note
        // that widening this Resource list can only ever add a pipeline to read
        // and trigger, never an approval path. Still true after TEAM-4525's
        // conditional deploy gate: the tools Lambda writes a ship-approval RECORD
        // (Sid ShipApprovalRecordWrite, s3:PutObject on one prefix) and the
        // pipeline decides whether that record makes a second human ask
        // redundant. Recording is not approving, and there is still no
        // PutApprovalResult anywhere in this role's reach.
        Sid: "PipelineReadAndTrigger",
        Effect: "Allow",
        Action: [
          // TEAM-5033 — the pipeline's DEFINITION, not its state. This is what
          // lets the Lambda answer "which CodeBuild projects does this pipeline
          // own?" without a hardcoded list: the Deploy stage runs a second,
          // parallel CodeBuild action (Deploy_runtime_images) whose log was
          // unreadable, and a future fifth project becomes readable with no IAM
          // or code change. A read of configuration, adding no write and no
          // approval path — it names projects, it cannot run them.
          "codepipeline:GetPipeline",
          "codepipeline:GetPipelineState",
          "codepipeline:ListActionExecutions",
          // Resolves an execution's source revision so get_state can look up
          // that commit's infra-handoff marker.
          "codepipeline:GetPipelineExecution",
          "codepipeline:StartPipelineExecution",
        ],
        Resource: pipelineArns,
      },
      {
        // TEAM-4740 FR-4 — the head-of-line grant, and the only CodePipeline write
        // this role has ever gained beyond StartPipelineExecution. It is a STOP,
        // not an approval: start_deploy may abandon an OLDER execution parked on
        // the human gate, and only after GitHub has PROVEN that execution's commit
        // is contained in the one we are deploying, the live gate has been re-read,
        // and the Stop has been confirmed. Same Resource list as
        // PipelineReadAndTrigger, by construction (`pipelineArns`, computed once
        // above) — a pipeline this role cannot start is a pipeline it must not stop.
        //
        // codepipeline:PutApprovalResult is STILL absent from this role in every
        // combination, and that is the whole point: "abandon the run in front of
        // me" and "approve the run in front of me" must never be the same
        // capability. Do not add an approval action here to save a round trip.
        Sid: "PipelineAbandonSuperseded",
        Effect: "Allow",
        Action: ["codepipeline:StopPipelineExecution"],
        Resource: pipelineArns,
      },
      {
        // Read-only build visibility, incl. the Deploy stage's own CodeBuild
        // project (agentcore-hub-deploy) so get_build_log can read the intentional
        // exit-2 "HANDOFF" signal. project/hub-* covers a registered repo's ci,
        // build AND deploy projects — reading a deploy build's log is how the CI
        // agent sees why a deploy failed. Still NO approval/write action of any
        // kind.
        //
        // TEAM-5033 adds runtimeImageArn: the Deploy stage's parallel
        // Deploy_runtime_images action. Named exactly because project/hub-* cannot
        // match `agentcore-hub-runtime-image-deploy`, and placed BEFORE the
        // wildcards so the exact ARNs stay a contiguous prefix of this list.
        Sid: "BuildRead",
        Effect: "Allow",
        Action: ["codebuild:BatchGetBuilds", "codebuild:ListBuildsForProject"],
        Resource: [buildArn, ciArn, deployArn, runtimeImageArn, ...hubProjectArns],
      },
      // The ONLY write this role ever gets, and only when asked for: StartBuild on
      // the validated PR-check project ARN plus project/hub-*-ci — never the
      // build, deploy or runtime-image project. hub-*-ci is the ONE wildcard
      // permitted in a StartBuild grant anywhere in this repo; project/hub-* and
      // hub-*-deploy must never appear in this statement, because that would hand
      // an agent a way to start a deploy directly and bypass the human gate.
      ...(ciStartBuild
        ? [
            {
              Sid: "CiStartBuild",
              Effect: "Allow",
              Action: ["codebuild:StartBuild"],
              Resource: [ciArn, ...hubCiArns],
            },
          ]
        : []),
      // Read ONE prefix of the artifact bucket: the Deploy stage's handoff
      // markers. Never the roster, blueprints, rollback snapshots or baselines.
      ...(artifactBucket
        ? [
            {
              Sid: "HandoffMarkerRead",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${artifactBucket}/pipeline-artifacts/handoff/*`],
            },
          ]
        : []),
      // The CD registry — which repos this deployment may merge + deploy. ONE
      // exact key, not a prefix: the rest of config/ holds the agent roster and
      // workflow definitions, which this role has no business reading.
      ...(artifactBucket
        ? [
            {
              Sid: "CdRegistryRead",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${artifactBucket}/config/cd-registry.json`],
            },
          ]
        : []),
      // TEAM-4525 — the ONE S3 write this role ever gets: start_deploy records the
      // head SHA a human already approved at Merge Approval, keyed on the merge
      // commit, so the pipeline can skip asking that same human a SECOND time for
      // byte-identical code. Scoped exactly like HandoffMarkerRead is: s3:PutObject
      // ONLY (no GetObject, no Delete, no ListBucket) on ONE prefix of the hub's own
      // artifact bucket. It is NOT an approval grant and must never become one — the
      // record is evidence the PIPELINE evaluates; codepipeline:PutApprovalResult
      // stays absent from this role in every combination, and a role that can write
      // a record but cannot approve a gate is the property that makes the skip safe.
      ...(artifactBucket
        ? [
            {
              Sid: "ShipApprovalRecordWrite",
              Effect: "Allow",
              Action: ["s3:PutObject"],
              Resource: [
                `arn:aws:s3:::${artifactBucket}/pipeline-artifacts/ship-approvals/*`,
              ],
            },
          ]
        : []),
      // TEAM-4740 SEC-1(3) — the veto side of the same prefix. Before recording a
      // ship-approval, start_deploy probes for `<merge_commit>.rejected.json`: a
      // human who explicitly REJECTED this merge commit at the gate must not have
      // that decision silently overridden by a later pre-approval record. The grant
      // is deliberately narrower than ShipApprovalRecordWrite's write scope — only
      // the `*.rejected.json` suffix, so this role can read a veto and nothing else
      // in the prefix, including the approval records it writes. HeadObject needs
      // s3:GetObject; existence is the entire signal and the body is never read.
      ...(artifactBucket
        ? [
            {
              Sid: "ShipRejectionMarkerRead",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [
                `arn:aws:s3:::${artifactBucket}/pipeline-artifacts/ship-approvals/*.rejected.json`,
              ],
            },
          ]
        : []),
      {
        Sid: "BuildLogRead",
        Effect: "Allow",
        Action: ["logs:GetLogEvents"],
        Resource: [
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${BUILD_PROJECT}:*`,
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${CI_PROJECT}:*`,
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${DEPLOY_PROJECT}:*`,
          // TEAM-5033 — the runtime-image project's log group. BuildRead's exact
          // ARN makes its PHASES readable; this makes its LOG readable, which is
          // the half the release manager actually needs to file a fix ticket.
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${RUNTIME_IMAGE_PROJECT}:*`,
          ...hubLogArns,
        ],
      },
      {
        // Cross-account CD (TEAM multi-cd): a registry entry may name a pipeline
        // in ANOTHER account, reached by assuming that account's
        // hub-cd-trigger-<slug> role. The assumed role's OWN policy (read +
        // StartPipelineExecution, NO PutApprovalResult) is the ceiling; this
        // grant only lets the Lambda perform the AssumeRole. The name is a
        // RESERVED prefix (like hub-* here): the account wildcard reaches a new
        // installer's role with no IAM edit, and hub-cd-trigger-* means the only
        // assumable roles are trigger-only ones (enforced again by the role's
        // trust policy + parseCdRegistry's roleArn validation). Still NO approval
        // path anywhere in this role's reach.
        Sid: "CrossAccountAssumeTrigger",
        Effect: "Allow",
        Action: ["sts:AssumeRole"],
        Resource: ["arn:aws:iam::*:role/hub-cd-trigger-*"],
      },
    ],
  };
}

async function main() {
  const cfg = resolveEnv();
  const {
    REGION,
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
    PIPELINE_REGIONS,
    ARTIFACT_BUCKET,
    GITHUB_TOKEN,
  } = cfg;

  // Fail on a bad CI_PROJECT before touching AWS at all (buildInlinePolicy
  // re-checks — this one exists so the operator sees it in one second, not after
  // an STS round trip).
  if (PIPELINE_CI_START_BUILD === "1") {
    const check = validateCiProjectName(CI_PROJECT, {
      buildProject: BUILD_PROJECT,
      deployProject: DEPLOY_PROJECT,
      pipelineName: PIPELINE_NAME,
    });
    if (!check.ok) {
      console.error(`PIPELINE_CI_START_BUILD=1 refused: ${check.reason}`);
      process.exit(1);
    }
  }

  // Same place, same reason: a prerequisite the deploy cannot satisfy must fail
  // in one second, before any AWS call. A Lambda deployed without a GitHub token
  // cannot record a ship-approval, so DL-028's conditional gate silently becomes
  // an unconditional one and every deploy pages a human (TEAM-4706). Only the
  // variable NAMES are ever printed — never the token.
  const gate = githubTokenGuard({
    token: GITHUB_TOKEN,
    allowNoGithubToken: process.argv.includes("--allow-no-github-token"),
  });
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(1);
  }
  if (gate.message) console.warn(gate.message);

  const iam = new IAMClient({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });
  const sts = new STSClient({ region: REGION });

  const { Account: ACCOUNT } = await sts.send(new GetCallerIdentityCommand({}));
  const EXPECTED = process.env.EXPECTED_ACCOUNT_ID;
  if (EXPECTED && ACCOUNT !== EXPECTED) {
    console.error(`Account guard: got ${ACCOUNT}, expected ${EXPECTED}. Aborting.`);
    process.exit(1);
  }
  console.log(`Account:  ${ACCOUNT}`);
  console.log(`Region:   ${REGION}`);
  console.log(`Pipeline: ${PIPELINE_NAME}`);
  console.log(`hub-*:    read + trigger in ${PIPELINE_REGIONS} (CD-registry targets)`);
  console.log(
    `CI build: ${
      PIPELINE_CI_START_BUILD === "1"
        ? `StartBuild GRANTED on ${CI_PROJECT}`
        : "StartBuild not granted (PIPELINE_CI_START_BUILD unset)"
    }`
  );
  // PRESENCE only. The value is a credential and never appears in this script's
  // output, in any branch.
  console.log(
    `GitHub:   ${
      GITHUB_TOKEN
        ? "GITHUB_TOKEN set (merge binding verifiable - approve-once can record)"
        : "no GITHUB_TOKEN/GITHUB_PAT - no ship-approval record, every deploy pages a human"
    }`
  );

  // ─── 1. IAM role (this pipeline + its three CodeBuild projects, exact ARNs, ──
  //        plus the hub-* convention wildcards per PIPELINE_REGIONS) ────────────
  const inlinePolicy = buildInlinePolicy({ ...cfg, ACCOUNT });

  let roleArn;
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    roleArn = r.Role.Arn;
    console.log(`IAM role exists: ${roleArn}`);
  } catch {
    console.log("Creating IAM role...");
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      })
    );
    roleArn = created.Role.Arn;
    await new Promise((s) => setTimeout(s, 10000)); // IAM propagation
  }
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: "inline",
      PolicyDocument: JSON.stringify(inlinePolicy),
    })
  );
  console.log("IAM inline policy applied (read+trigger, NO approval).");

  // ─── 2. Package ──────────────────────────────────────────────────────────────
  const srcDir = join(__dirname, "..", "lambda", FUNCTION_NAME);
  const zipPath = join(srcDir, "function.zip");
  rmSync(zipPath, { force: true });
  // cd-registry.mjs is a BYTE COPY of lambda/orchestrator/cd-registry.mjs
  // (scripts/check-cd-registry-parity.sh pins them identical) and index.mjs
  // imports it, so the zip must carry both files or the Lambda fails to load.
  execSync(`cd "${srcDir}" && zip -qr function.zip index.mjs cd-registry.mjs`, {
    stdio: "inherit",
  });
  const zipBuffer = readFileSync(zipPath);

  // RUNTIME_IMAGE_PROJECT is deliberately NOT here (TEAM-5033): it scopes two IAM
  // Resources and nothing else. The Lambda reads the pipeline's definition to learn
  // which CodeBuild projects it owns, so handing it the name as config would create
  // a second source of truth that drifts the moment the stack adds a project.
  const envVars = {
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
    PIPELINE_REGIONS,
    ARTIFACT_BUCKET: ARTIFACT_BUCKET || `agentcore-hub-artifacts-${ACCOUNT}-${REGION}`,
  };
  // Only when supplied: envVars is spread OVER existingEnv (see the merge below),
  // so an unconditional empty string here would wipe a token an operator set out
  // of band and silently turn every conditional gate back into a human one. Under
  // --allow-no-github-token this is exactly what keeps an already-working Lambda
  // working. The value is written to the function and nowhere else — never logged.
  if (GITHUB_TOKEN) envVars.GITHUB_TOKEN = GITHUB_TOKEN;

  // ─── 3. Create/update the function ───────────────────────────────────────────
  let exists = false;
  let existingEnv = {};
  try {
    const got = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    exists = true;
    // UpdateFunctionConfiguration REPLACES the whole Variables map, so an
    // operator-set var this script does not know about (CD_REGISTRY_TTL_MS,
    // PIPELINE_REPO) would be silently dropped. Merge, with this script's values
    // winning for the keys it owns.
    existingEnv = got.Configuration?.Environment?.Variables || {};
  } catch {
    /* not found */
  }

  if (exists) {
    console.log("Updating function code...");
    await lambda.send(
      new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: zipBuffer })
    );
    await new Promise((s) => setTimeout(s, 4000));
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
        Environment: { Variables: { ...existingEnv, ...envVars } },
        Timeout: 60,
        MemorySize: 256,
      })
    );
  } else {
    console.log("Creating function...");
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: FUNCTION_NAME,
        Runtime: "nodejs22.x",
        Handler: "index.handler",
        Role: roleArn,
        Timeout: 60,
        MemorySize: 256,
        Code: { ZipFile: zipBuffer },
        Environment: { Variables: envVars },
      })
    );
  }
  rmSync(zipPath, { force: true });
  await new Promise((s) => setTimeout(s, 5000));

  // ─── 4. Smoke test: get_state must report the pipeline as configured ──────────
  console.log("\nVerification invoke (get_state)...");
  const inv = await lambda.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify({ name: "Pipeline___get_state", arguments: {} })),
    })
  );
  const payload = JSON.parse(Buffer.from(inv.Payload).toString());
  const text = payload?.content?.[0]?.text || JSON.stringify(payload);
  console.log(text.slice(0, 400));
  if (inv.FunctionError) {
    console.error("\n⚠ Verification invoke FunctionError:", inv.FunctionError);
    process.exit(1);
  }
  const parsed = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (parsed.configured !== true) {
    console.error("\n⚠ Pipeline not reported as configured — check PIPELINE_NAME / perms.");
    process.exit(1);
  }

  console.log(`\n✅ ${FUNCTION_NAME} deployed. Function ARN:`);
  console.log(`   arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION_NAME}`);
  console.log("\nNext: grant the runtime role lambda:InvokeFunction on this function,");
  console.log("set PIPELINE_TOOLS_LAMBDA on the shared runtime, add the 3 tools to");
  console.log("release_manager in agents.json, and redeploy the runtime.");
}

// Run only when executed directly — importing this module (the policy tests do)
// must never deploy anything.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
