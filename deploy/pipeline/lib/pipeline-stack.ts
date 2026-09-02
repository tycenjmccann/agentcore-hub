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

    const ciProject = new codebuild.Project(this, "CiProject", {
      projectName: "agentcore-hub-ci",
      description: "PR check: tsc, build, test, lint, lambda-zip manifest gate, dep scan.",
      source: codebuild.Source.gitHub({
        owner: githubOwner,
        repo: githubRepo,
        // Report the build status back onto the PR commit → required check.
        reportBuildStatus: true,
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(
            codebuild.EventAction.PULL_REQUEST_CREATED,
            codebuild.EventAction.PULL_REQUEST_UPDATED,
            codebuild.EventAction.PULL_REQUEST_REOPENED
          ),
        ],
      }),
      // Authorize this GitHub source via the SAME CodeConnections link the
      // pipeline Source action uses — otherwise the PR-check project has no
      // credential to clone or post the required status and silently relies on a
      // pre-existing account-level OAuth token (Codex PR #263 P1). Set as a
      // source-level auth override below via the L1 escape hatch.
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

    // CI role: read-only beyond logs. It must NOT deploy anything.
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
          // Use the CodeConnections link (clone + status post).
          new iam.PolicyStatement({
            sid: "UseCodeConnection",
            actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection"],
            resources: [connectionArn],
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
        // nav tab (Codex PR #263 P2). Empty = hidden.
        NEXT_PUBLIC_PIPELINE_ENABLED: {
          value: process.env.PIPELINE_NAV_ENABLED || "",
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
              triggerOnPush: true,
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
            }),
          ],
        },
      ],
    });

    // ── cdk-nag suppressions: justified, scoped, documented ──────────────────
    applyNagSuppressions(this, { ciProject, buildProject, deployProject, pipeline });

    // ── Outputs (wired into .env.local / the hub app by deploy/pipeline/deploy.sh) ──
    new CfnOutput(this, "ConnectionArn", {
      value: connectionArn,
      description:
        "CodeConnections ARN. If freshly created it is PENDING — complete the GitHub App handshake in the console once.",
    });
    new CfnOutput(this, "CiProjectName", { value: ciProject.projectName });
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
        // connection, so its role needs UseConnection too (Codex #263 round-2 P1).
        new iam.PolicyStatement({
          sid: "UseCodeConnection",
          actions: [
            "codeconnections:UseConnection",
            "codestar-connections:UseConnection",
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
 * The Deploy role — deliberately narrow. It can update Lambda CODE, sync S3
 * config, and roll the one ECS service. It CANNOT
 * `lambda:UpdateFunctionConfiguration` (that is what blanks prod Jira creds —
 * DEPLOY.md's "never run the full deploy.sh" rule, enforced by permission) and
 * has no iam:* / no ecs create.
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
      ],
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

  // ── Eval-target actions (DEPLOY.md steps 4-9), used ONLY when the changeset
  // touches eval files and the agentcore CLI is present (Codex #263 round-3 P1).
  // deploy-eval-targets.sh calls: sns:CreateTopic, cloudwatch:PutMetricAlarm,
  // dynamodb:UpdateItem on the eval-config table, and the fleet redeploy needs
  // AgentCore control-plane + a PassRole for bedrock-agentcore.amazonaws.com.
  statements.push(
    new iam.PolicyStatement({
      sid: "EvalAlarmsAndTopic",
      actions: [
        "sns:CreateTopic",
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DescribeAlarms",
      ],
      resources: ["*"], // PutMetricAlarm/DescribeAlarms are not resource-scoped; CreateTopic is idempotent-by-name
    }),
    new iam.PolicyStatement({
      sid: "EvalConfigTable",
      actions: ["dynamodb:UpdateItem", "dynamodb:GetItem"],
      resources: [
        `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/agentcore-hub-eval-config`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "EvalFleetControlPlane",
      actions: [
        "bedrock-agentcore:UpdateAgentRuntime",
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:ListAgentRuntimes",
        "bedrock-agentcore:UpdateOnlineEvaluationConfig",
        "bedrock-agentcore:GetOnlineEvaluationConfig",
        "bedrock-agentcore:ListOnlineEvaluationConfigs",
      ],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "PassFleetRuntimeRole",
      actions: ["iam:PassRole"],
      resources: [
        `arn:aws:iam::${ctx.account}:role/agentcore-hub-agentcore-role`,
      ],
      conditions: {
        StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" },
      },
    })
  );

  role.attachInlinePolicy(
    new iam.Policy(scope, "DeployPerms", { statements })
  );
}

function applyNagSuppressions(
  scope: Construct,
  r: {
    ciProject: codebuild.IProject;
    buildProject: codebuild.IProject;
    deployProject: codebuild.IProject;
    pipeline: codepipeline.Pipeline;
  }
) {
  NagSuppressions.addResourceSuppressions(
    scope,
    [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Scoped wildcards are intentional and minimal: agentcore-hub-* Lambda code updates, /config/* and /pipeline-artifacts/* S3 prefixes, and ecr:GetAuthorizationToken (which has no resource scope). No admin or cross-service wildcard.",
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
