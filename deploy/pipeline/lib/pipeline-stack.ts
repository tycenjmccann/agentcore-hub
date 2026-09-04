import {
  Stack,
  StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as cpactions from "aws-cdk-lib/aws-codepipeline-actions";
import * as codeconnections from "aws-cdk-lib/aws-codeconnections";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";

export interface PipelineStackProps extends StackProps {
  /** GitHub org/user that owns the repo to build (pilot: the hub's own owner). */
  readonly githubOwner: string;
  /** Repo name. Pilot default: "agentcore-hub". */
  readonly githubRepo: string;
  /** Branch that triggers the deploy pipeline (default "main"). */
  readonly branch: string;
  /** Reuse an existing org-level CodeConnections link instead of minting one. */
  readonly existingConnectionArn?: string;
  /** The hub artifact bucket (agents.json merge + orchestrator zip storage). */
  readonly artifactBucketName: string;
  /** The ECS Express service ARN the deploy stage rolls (optional until known). */
  readonly ecsServiceArn?: string;
  /** Events table for the runtime.deploy performance marker (default agentcore-hub-events). */
  readonly eventsTableName?: string;
  /** Reuse an existing SNS approval topic (e.g. the Telegram-bridged one). */
  readonly approvalSnsTopicArn?: string;
  /** Email fallbacks subscribed to the approval topic. */
  readonly approvalEmails: string[];
}

/**
 * The CI/CD pipeline for one repo (pilot: the hub itself).
 *
 * Topology (see docs/cicd-pipeline-module-design.md §5):
 *   PR push  → CodeBuild "ci"     → commit status → branch protection gate
 *   merge    → CodePipeline "deploy": Source → Build → ManualApproval → Deploy
 *
 * Build-once / promote-by-digest: the Deploy stage consumes the Build stage's
 * artifacts (orchestrator zip + ECR image digest), never rebuilds.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const {
      githubOwner,
      githubRepo,
      branch,
      existingConnectionArn,
      artifactBucketName,
      ecsServiceArn,
      approvalSnsTopicArn,
      approvalEmails,
    } = props;
    const eventsTableName = props.eventsTableName || "agentcore-hub-events";

    const region = this.region;
    const account = this.account;

    // ── CodeConnections link (GitHub App — no PAT in the account) ────────────
    // Reuse an existing org-level link when provided; otherwise mint one. A
    // freshly-created connection is PENDING until a human completes the GitHub
    // App handshake in the console (one-time, out-of-band).
    const connectionArn =
      existingConnectionArn ??
      new codeconnections.CfnConnection(this, "GitHubConnection", {
        connectionName: `agentcore-hub-${githubRepo}`.slice(0, 32),
        providerType: "GitHub",
      }).attrConnectionArn;

    // ── The hub's existing artifact bucket (imported, not created here) ──────
    const artifactBucket = s3.Bucket.fromBucketName(
      this,
      "HubArtifactBucket",
      artifactBucketName
    );

    // ── Approval notification topic (SNS → Telegram bridge and/or email) ─────
    const approvalTopic = approvalSnsTopicArn
      ? sns.Topic.fromTopicArn(this, "ApprovalTopic", approvalSnsTopicArn)
      : new sns.Topic(this, "ApprovalTopic", {
          topicName: "agentcore-hub-pipeline-approvals",
          displayName: "AgentCore Hub pipeline deploy approvals",
          enforceSSL: true, // deny non-HTTPS publishes (cdk-nag SNS3)
        });
    for (const email of approvalEmails) {
      approvalTopic.addSubscription(new subs.EmailSubscription(email));
    }

    // ── Shared build environment ─────────────────────────────────────────────
    const buildEnvironment: codebuild.BuildEnvironment = {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Node 20, Docker available
      computeType: codebuild.ComputeType.SMALL,
      privileged: true, // needed for `docker buildx build` in the app image step
    };

    const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
      AWS_REGION_HUB: { value: region },
      ARTIFACT_BUCKET: { value: artifactBucketName },
      EXPECTED_ACCOUNT_ID: { value: account },
    };

    // ─────────────────────────────────────────────────────────────────────────
    // CI project — runs on PR push, posts a required commit status.
    // buildspec-ci.yml is source-controlled in deploy/pipeline/.
    // ─────────────────────────────────────────────────────────────────────────
    const ciLogGroup = new logs.LogGroup(this, "CiLogGroup", {
      logGroupName: `/aws/codebuild/agentcore-hub-ci`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Explicit CI service role with the connection perms baked in as an inline
    // policy AT CONSTRUCTION — so they exist before CreateProject validates the
    // CODECONNECTIONS source auth. Passing perms via role.inlinePolicies (not a
    // separately-attached Policy) avoids both the create-time race AND the
    // circular dependency an addDependency on the project would introduce.
    const connectionActions = [
      "codeconnections:UseConnection",
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codestar-connections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
    ];
    const ciRole = new iam.Role(this, "CiProjectRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "AgentCore Hub CI CodeBuild role (PR check; connection + read-only).",
      inlinePolicies: {
        connection: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "UseCodeConnection",
              actions: connectionActions,
              resources: [connectionArn],
            }),
          ],
        }),
      },
    });

    // The PR-check webhook (CodeBuild's CreateWebhook) requires the GitHub App to
    // be installed on the repo WITH webhook permission — a repo-level install
    // step beyond the OAuth handshake. Gate it: PIPELINE_CI_WEBHOOK=1 turns the
    // PR trigger on once the app is installed; default OFF ships the project
    // (buildspec + role) without the webhook so the CD pipeline can deploy first
    // and the PR-check is enabled as a one-line follow-up. Branch protection can
    // reference the check either way.
    const ciWebhook =
      process.env.PIPELINE_CI_WEBHOOK === "1" ||
      process.env.PIPELINE_CI_WEBHOOK === "true";

    const ciProject = new codebuild.Project(this, "CiProject", {
      projectName: "agentcore-hub-ci",
      role: ciRole,
      description: "PR check: tsc, build, test, lint, lambda-zip manifest gate, dep scan.",
      source: codebuild.Source.gitHub({
        owner: githubOwner,
        repo: githubRepo,
        // Report the build status back onto the PR commit → required check.
        reportBuildStatus: ciWebhook,
        webhook: ciWebhook,
        ...(ciWebhook
          ? {
              webhookFilters: [
                codebuild.FilterGroup.inEventOf(
                  codebuild.EventAction.PULL_REQUEST_CREATED,
                  codebuild.EventAction.PULL_REQUEST_UPDATED,
                  codebuild.EventAction.PULL_REQUEST_REOPENED
                ),
              ],
            }
          : {}),
      }),
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        "deploy/pipeline/buildspec-ci.yml"
      ),
      environment: buildEnvironment,
      environmentVariables: commonEnvVars,
      logging: { cloudWatch: { logGroup: ciLogGroup } },
      timeout: Duration.minutes(30),
      concurrentBuildLimit: 4,
    });
    // Bind the CI project's GitHub source auth to the CodeConnections link
    // (Codex PR #263 P1). CDK L2 has no prop for CODECONNECTIONS source auth, so
    // set it on the L1 Source.Auth via escape hatch. Once the connection's
    // handshake is completed this credential clones + posts the required status;
    // without it the project would fall back to an account OAuth token that may
    // not exist.
    const cfnCiProject = ciProject.node.defaultChild as codebuild.CfnProject;
    cfnCiProject.addPropertyOverride("Source.Auth", {
      Type: "CODECONNECTIONS",
      Resource: connectionArn,
    });

    // Read-only artifact access (does NOT gate CreateProject, so a normal
    // attached policy is fine — no cycle). Deploy nothing.
    ciProject.role!.attachInlinePolicy(
      new iam.Policy(this, "CiReadArtifacts", {
        statements: [
          new iam.PolicyStatement({
            sid: "ReadHubConfigForBuild",
            actions: ["s3:GetObject", "s3:ListBucket"],
            resources: [
              artifactBucket.bucketArn,
              `${artifactBucket.bucketArn}/config/*`,
            ],
          }),
        ],
      })
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Build stage project — builds ONCE on merge; emits artifacts by digest.
    // Reuses buildspec-ci.yml (same gates) plus artifact emission.
    // ─────────────────────────────────────────────────────────────────────────
    const buildProject = new codebuild.PipelineProject(this, "BuildProject", {
      projectName: "agentcore-hub-build",
      description: "Deploy-pipeline Build stage: re-run gates + emit orchestrator zip and app image by digest.",
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        "deploy/pipeline/buildspec-ci.yml"
      ),
      environment: buildEnvironment,
      environmentVariables: {
        ...commonEnvVars,
        ECR_REPO: { value: "agentcore-hub-frontend" },
        BUILD_APP_IMAGE: { value: "true" },
        // Baked into the image client bundle; flip to "1" to show the /pipeline
        // nav tab. Read the SAME documented var name the README + deploy.sh use
        // (Codex PR #263 round-4 P2). Empty = hidden.
        NEXT_PUBLIC_PIPELINE_ENABLED: {
          value: process.env.NEXT_PUBLIC_PIPELINE_ENABLED || "",
        },
      },
      timeout: Duration.minutes(40),
    });
    grantBuildArtifactPerms(this, buildProject.role!, {
      account,
      region,
      artifactBucket,
      connectionArn,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Deploy stage project — runs buildspec-deploy.yml (the 3-target DEPLOY.md)
    // under a NARROW role that CANNOT rewrite orchestrator config (Jira creds).
    // ─────────────────────────────────────────────────────────────────────────
    const deployProject = new codebuild.PipelineProject(this, "DeployProject", {
      projectName: "agentcore-hub-deploy",
      description: "Deploy stage: orchestrator code-only, S3 config merge, ECS roll-by-digest, smoke checks.",
      buildSpec: codebuild.BuildSpec.fromSourceFilename(
        "deploy/pipeline/buildspec-deploy.yml"
      ),
      environment: buildEnvironment,
      environmentVariables: {
        ...commonEnvVars,
        ECR_REPO: { value: "agentcore-hub-frontend" },
        ECS_SERVICE_ARN: { value: ecsServiceArn || "" },
      },
      timeout: Duration.minutes(30),
    });
    grantDeployPerms(this, deployProject.role!, {
      account,
      region,
      artifactBucket,
      ecsServiceArn,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Runtime-image Deploy project — the PR-2 "merge = live" close on agent
    // prompts+TOOLS. Persona prompts already ship via Deploy Target 2's S3 sync,
    // but the fleet/coding TOOL code is baked into main.py inside the runtime
    // image, so a self-improvement run that rewrites a tool used to stop at a
    // human handoff. This action rebuilds only the runtimes whose baked source
    // changed (plan-surfaces.py RUNTIME rows) and image-swaps them in place
    // (update-runtime-image.py preserves env/lifecycle/role/EFS). It runs on a
    // native ARM64 (Graviton) host because both runtime images are linux/arm64;
    // its role is SEPARATE from and narrower than the app deploy role — it can
    // ONLY push to the two runtime ECR repos + UpdateAgentRuntime, never touch
    // Lambda/ECS/IAM. It runs in PARALLEL with the app deploy action so the
    // app's exit-2 HANDOFF (still-manual infra scripts) can't block the image roll.
    // ─────────────────────────────────────────────────────────────────────────
    const runtimeImageProject = new codebuild.PipelineProject(
      this,
      "RuntimeImageProject",
      {
        projectName: "agentcore-hub-runtime-image-deploy",
        description:
          "Deploy stage (parallel): rebuild changed fleet/coding runtime images on arm64 + image-only UpdateAgentRuntime (env/lifecycle preserved).",
        buildSpec: codebuild.BuildSpec.fromSourceFilename(
          "deploy/pipeline/buildspec-runtime-images.yml"
        ),
        environment: {
          // Native Graviton so `docker build --platform linux/arm64` is not QEMU
          // emulation (the images bake claude-code + codex + chromium + skills).
          buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          computeType: codebuild.ComputeType.LARGE,
          privileged: true,
        },
        environmentVariables: {
          ...commonEnvVars,
          EVENTS_TABLE: { value: eventsTableName },
        },
        timeout: Duration.minutes(60), // full image rebuild + push + runtime READY wait
      }
    );
    grantRuntimeImagePerms(this, runtimeImageProject.role!, {
      account,
      region,
      eventsTableName,
    });

    // ── The deploy pipeline: Source → Build → Approval → Deploy ──────────────
    const sourceOutput = new codepipeline.Artifact("Source");
    const buildOutput = new codepipeline.Artifact("BuildArtifacts");

    const pipeline = new codepipeline.Pipeline(this, "DeployPipeline", {
      pipelineName: "agentcore-hub-deploy",
      pipelineType: codepipeline.PipelineType.V2,
      restartExecutionOnUpdate: false,
      stages: [
        {
          stageName: "Source",
          actions: [
            new cpactions.CodeStarConnectionsSourceAction({
              actionName: "GitHub_main",
              owner: githubOwner,
              repo: githubRepo,
              branch,
              connectionArn,
              output: sourceOutput,
              // Agent-owned trigger contract: merges do NOT auto-trigger the
              // pipeline — the release manager explicitly calls
              // Pipeline___start_deploy after the merge lands (see the tools
              // Lambda header, the Pipeline___* docstrings, and
              // blueprints/release-manager.md). Leaving this true would
              // double-trigger every merge (auto + RM) once the GitHub App
              // gains webhook permission.
              triggerOnPush: false,
              // Emit a full git clone (not the default flat ZIP) so the Build
              // stage has a real .git — the image tag falls back to
              // `git rev-parse` when CODEBUILD_RESOLVED_SOURCE_VERSION is unset
              // (Codex PR #263 P1, defense in depth with the buildspec fix).
              codeBuildCloneOutput: true,
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            new cpactions.CodeBuildAction({
              actionName: "Build_and_gate",
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        {
          stageName: "Approval",
          actions: [
            new cpactions.ManualApprovalAction({
              actionName: "Approve_deploy",
              notificationTopic: approvalTopic,
              additionalInformation:
                "Approve to deploy the built artifacts (orchestrator zip + app image by digest) to prod. " +
                "This is the irreversible production act; the merge gate already approved the code.",
              externalEntityLink: `https://github.com/${githubOwner}/${githubRepo}/commits/${branch}`,
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new cpactions.CodeBuildAction({
              actionName: "Deploy_three_targets",
              project: deployProject,
              input: buildOutput, // promote-by-digest: deploy consumes Build's artifacts
              runOrder: 1,
            }),
            // Parallel (same runOrder) so the app action's exit-2 HANDOFF for
            // still-manual infra scripts never blocks the runtime image roll, and
            // vice-versa. Both read the same buildOutput (which carries deploy/**,
            // pipeline-out/changed-files.txt, git-sha.txt).
            new cpactions.CodeBuildAction({
              actionName: "Deploy_runtime_images",
              project: runtimeImageProject,
              input: buildOutput,
              runOrder: 1,
            }),
          ],
        },
      ],
    });

    // ── cdk-nag suppressions: justified, scoped, documented ──────────────────
    applyNagSuppressions(this, {
      ciProject,
      buildProject,
      deployProject,
      runtimeImageProject,
      pipeline,
    });

    // ── Outputs (wired into .env.local / the hub app by deploy/pipeline/deploy.sh) ──
    new CfnOutput(this, "ConnectionArn", {
      value: connectionArn,
      description:
        "CodeConnections ARN. If freshly created it is PENDING — complete the GitHub App handshake in the console once.",
    });
    new CfnOutput(this, "CiProjectName", { value: ciProject.projectName });
    new CfnOutput(this, "RuntimeImageProjectName", {
      value: runtimeImageProject.projectName,
      description:
        "arm64 runtime-image Deploy project; wire into the pipeline-tools Lambda so the RM can read its build log.",
    });
    new CfnOutput(this, "DeployPipelineName", { value: pipeline.pipelineName });
    new CfnOutput(this, "ApprovalTopicArn", { value: approvalTopic.topicArn });
  }
}

// ── IAM helpers ────────────────────────────────────────────────────────────

function grantBuildArtifactPerms(
  scope: Construct,
  role: iam.IRole,
  ctx: {
    account: string;
    region: string;
    artifactBucket: s3.IBucket;
    connectionArn: string;
  }
) {
  role.attachInlinePolicy(
    new iam.Policy(scope, "BuildArtifactPerms", {
      statements: [
        // With codeBuildCloneOutput the Build stage downloads a git clone via the
        // connection, so its role needs the connection actions too (Codex #263
        // round-2 P1). Full trio like the CI role — clone needs the token.
        new iam.PolicyStatement({
          sid: "UseCodeConnection",
          actions: [
            "codeconnections:UseConnection",
            "codeconnections:GetConnection",
            "codeconnections:GetConnectionToken",
            "codestar-connections:UseConnection",
            "codestar-connections:GetConnection",
            "codestar-connections:GetConnectionToken",
          ],
          resources: [ctx.connectionArn],
        }),
        // Push the built app image to ECR (by digest, consumed by Deploy).
        new iam.PolicyStatement({
          sid: "EcrAuth",
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"], // GetAuthorizationToken has no resource scope
        }),
        new iam.PolicyStatement({
          sid: "EcrPush",
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
            "ecr:PutImage",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
          ],
          resources: [
            `arn:aws:ecr:${ctx.region}:${ctx.account}:repository/agentcore-hub-frontend`,
          ],
        }),
        // Store the orchestrator zip artifact for the Deploy stage.
        new iam.PolicyStatement({
          sid: "PutBuildArtifacts",
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
          resources: [
            ctx.artifactBucket.bucketArn,
            `${ctx.artifactBucket.bucketArn}/pipeline-artifacts/*`,
            `${ctx.artifactBucket.bucketArn}/config/*`,
          ],
        }),
      ],
    })
  );
}

/**
 * The Deploy role — deliberately narrow. It can update Lambda CODE (every
 * function in deploy/pipeline/surfaces.json), sync S3 config/toolkits, update
 * harness prompt/model/skills, and roll the one ECS service. It CANNOT
 * `lambda:UpdateFunctionConfiguration` (that is what blanks prod Jira creds —
 * DEPLOY.md's "never run the full deploy.sh" rule, enforced by permission),
 * cannot create/delete harnesses or runtimes, and has no iam:* / no ecs create.
 */
function grantDeployPerms(
  scope: Construct,
  role: iam.IRole,
  ctx: {
    account: string;
    region: string;
    artifactBucket: s3.IBucket;
    ecsServiceArn?: string;
  }
) {
  const statements: iam.PolicyStatement[] = [
    new iam.PolicyStatement({
      sid: "LambdaCodeOnly",
      // GetFunctionConfiguration is REQUIRED by `aws lambda wait function-updated`
      // (it polls that API) — without it the deploy fails after updating code,
      // leaving prod half-deployed (Codex PR #263 P1). Still NO
      // UpdateFunctionConfiguration → cannot rewrite env / blank Jira creds.
      actions: [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
      ],
      resources: [
        `arn:aws:lambda:${ctx.region}:${ctx.account}:function:agentcore-hub-*`,
        // The Telegram intake bot predates the naming convention (surfaces.json).
        `arn:aws:lambda:${ctx.region}:${ctx.account}:function:telegram-bug-intake`,
      ],
    }),
    // Harness prompt / model / skills (surfaces.json "harnesses"): the setup
    // scripts run in PIPELINE_MODE call only Get/List/UpdateHarness on the
    // EXISTING harness — no create, no IAM, no memory, no invoke. Update never
    // passes executionRoleArn, so no iam:PassRole is needed here.
    new iam.PolicyStatement({
      sid: "HarnessCodeSurfaces",
      actions: [
        "bedrock-agentcore:GetHarness",
        "bedrock-agentcore:UpdateHarness",
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${ctx.region}:${ctx.account}:harness/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "HarnessList",
      actions: ["bedrock-agentcore:ListHarnesses"],
      resources: ["*"], // ListHarnesses has no resource scope
    }),
    // Smoke test: invoke the orchestrator with {} → assert FunctionError:None
    // (guards the INIT-crash class the lease-constants zip bug caused).
    new iam.PolicyStatement({
      sid: "OrchestratorSmokeInvoke",
      actions: ["lambda:InvokeFunction"],
      resources: [
        `arn:aws:lambda:${ctx.region}:${ctx.account}:function:agentcore-hub-orchestrator`,
        `arn:aws:lambda:${ctx.region}:${ctx.account}:function:agentcore-hub-eval-packager`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "S3ConfigAndBlueprints",
      actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      resources: [
        ctx.artifactBucket.bucketArn,
        `${ctx.artifactBucket.bucketArn}/*`,
      ],
    }),
    // The WM/routine-builder toolkit+skills syncs run with `aws s3 sync --delete`
    // (mirroring each surface's own deploy.sh) so a renamed/removed toolkit
    // module doesn't linger in S3. --delete needs DeleteObject; scope it to just
    // those prefixes (NOT config/, blueprints/, pipeline-artifacts/) so a deploy
    // can never delete the roster, baselines, or rollback snapshots.
    new iam.PolicyStatement({
      sid: "S3ToolkitSyncDelete",
      actions: ["s3:DeleteObject"],
      resources: [
        `${ctx.artifactBucket.bucketArn}/workflow-manager/*`,
        `${ctx.artifactBucket.bucketArn}/routine-builder/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "EcrPullForRoll",
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
      ],
      resources: ["*"],
    }),
    // Read-only for smoke checks (health endpoint requires no perms; these cover
    // the DEPLOY.md CloudWatch / config assertions).
    new iam.PolicyStatement({
      sid: "SmokeReads",
      actions: [
        "cloudwatch:GetMetricStatistics",
        "logs:FilterLogEvents",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
      ],
      resources: ["*"],
    }),
  ];

  // ECS roll — scoped to the one service when its ARN is known; otherwise the
  // wildcard on the account's express services (still no create/delete).
  statements.push(
    new iam.PolicyStatement({
      sid: "EcsRollService",
      actions: [
        "ecs:UpdateExpressGatewayService",
        "ecs:DescribeExpressGatewayService",
        "ecs:ListServices",
      ],
      resources: ctx.ecsServiceArn
        ? [ctx.ecsServiceArn]
        : [`arn:aws:ecs:${ctx.region}:${ctx.account}:service/*`],
    })
  );
  // UpdateExpressGatewayService registers a new task-definition revision under
  // the hood when the primary-container image changes (pilot run b6cdd247 failed
  // Target 3 on the missing ecs:RegisterTaskDefinition). RegisterTaskDefinition
  // does NOT support resource-level permissions in IAM — it must be "*". This is
  // still narrow: no run/create/delete-service, no cluster mutation.
  statements.push(
    new iam.PolicyStatement({
      sid: "EcsRegisterTaskDef",
      actions: [
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeTaskDefinition",
      ],
      resources: ["*"],
    })
  );
  // PassRole ONLY for the two ECS roles the roll needs — never a wildcard.
  statements.push(
    new iam.PolicyStatement({
      sid: "PassEcsRoles",
      actions: ["iam:PassRole"],
      resources: [
        `arn:aws:iam::${ctx.account}:role/ecsTaskExecutionRole`,
        `arn:aws:iam::${ctx.account}:role/agentcore-hub-ecs-task`,
      ],
      conditions: {
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      },
    })
  );

  // NOTE: runtime IMAGES ship via a SEPARATE parallel action (RuntimeImageProject
  // + grantRuntimeImagePerms) — this app role has no ECR push and no
  // UpdateAgentRuntime on purpose. Genuine INFRA (IAM, env vars, tables,
  // subscriptions) still needs iam:* and stays a handoff: when a merge touches
  // those files the Deploy stage ships everything else, advances the baseline,
  // then exits 2 so the release manager reports the human step (surfaces.json
  // "handoff").

  role.attachInlinePolicy(
    new iam.Policy(scope, "DeployPerms", { statements })
  );
}

/**
 * The runtime-image Deploy role — separate from and narrower than the app Deploy
 * role. It can push to ONLY the two runtime ECR repos and do an image-only
 * UpdateAgentRuntime on the fleet + coding runtimes (which requires PassRole on
 * exactly their two execution roles, scoped by service). It has NO Lambda, NO
 * ECS, NO harness, NO iam:* beyond that one scoped PassRole, and cannot
 * create/delete a runtime — only swap the container image of an existing one.
 */
function grantRuntimeImagePerms(
  scope: Construct,
  role: iam.IRole,
  ctx: { account: string; region: string; eventsTableName: string }
) {
  role.attachInlinePolicy(
    new iam.Policy(scope, "RuntimeImagePerms", {
      statements: [
        new iam.PolicyStatement({
          sid: "EcrAuth",
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"], // GetAuthorizationToken has no resource scope
        }),
        // Push + read ONLY the two runtime image repos (never the app frontend repo).
        new iam.PolicyStatement({
          sid: "EcrPushRuntimeRepos",
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
            "ecr:PutImage",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
          ],
          resources: [
            `arn:aws:ecr:${ctx.region}:${ctx.account}:repository/runtime-agent`,
            `arn:aws:ecr:${ctx.region}:${ctx.account}:repository/coding-agent-runtime`,
          ],
        }),
        // Image-only swap of an EXISTING runtime. No Create/Delete; Get is needed
        // to read live config (env/lifecycle/role/EFS) so Update preserves it.
        new iam.PolicyStatement({
          sid: "RuntimeImageSwap",
          actions: [
            "bedrock-agentcore:GetAgentRuntime",
            "bedrock-agentcore:UpdateAgentRuntime",
          ],
          resources: [
            `arn:aws:bedrock-agentcore:${ctx.region}:${ctx.account}:runtime/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeList",
          actions: ["bedrock-agentcore:ListAgentRuntimes"],
          resources: ["*"], // ListAgentRuntimes has no resource scope
        }),
        // UpdateAgentRuntime re-passes the runtime's OWN execution role; scope to
        // exactly the two runtime roles + the bedrock-agentcore service.
        new iam.PolicyStatement({
          sid: "PassRuntimeRoles",
          actions: ["iam:PassRole"],
          resources: [
            `arn:aws:iam::${ctx.account}:role/agentcore-hub-agentcore-role`,
            `arn:aws:iam::${ctx.account}:role/agentcore-hub-coding-runtime-role`,
          ],
          conditions: {
            StringEquals: {
              "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
            },
          },
        }),
        // The runtime.deploy performance marker (best-effort, single table).
        new iam.PolicyStatement({
          sid: "EmitDeployMarker",
          actions: ["dynamodb:PutItem"],
          resources: [
            `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/${ctx.eventsTableName}`,
          ],
        }),
      ],
    })
  );
}

function applyNagSuppressions(
  scope: Construct,
  r: {
    ciProject: codebuild.IProject;
    buildProject: codebuild.IProject;
    deployProject: codebuild.IProject;
    runtimeImageProject: codebuild.IProject;
    pipeline: codepipeline.Pipeline;
  }
) {
  NagSuppressions.addResourceSuppressions(
    scope,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Scoped wildcards are intentional and minimal: agentcore-hub-* Lambda code updates, harness/* prompt+model updates, runtime/* image-only UpdateAgentRuntime scoped to the runtime-agent + coding-agent-runtime ECR repos, /config/* and /pipeline-artifacts/* S3 prefixes, and ecr:GetAuthorizationToken / bedrock-agentcore:ListHarnesses / ListAgentRuntimes (which have no resource scope). PassRole is pinned to the specific ECS + runtime execution roles with an iam:PassedToService condition. No admin or cross-service wildcard.",
      },
      {
        id: "AwsSolutions-CB4",
        reason:
          "CodeBuild artifacts are ephemeral build outputs in the account's own artifact bucket (SSE-S3 default); no customer data. KMS CMK is unnecessary overhead for a single-account deploy pipeline.",
      },
    ],
    true
  );
  NagSuppressions.addResourceSuppressions(
    r.pipeline,
    [
      {
        id: "AwsSolutions-S1",
        reason:
          "CodePipeline's auto-created artifact bucket holds only transient pipeline artifacts in this account; server access logging adds cost without security value for a single-account pipeline.",
      },
    ],
    true
  );
}
