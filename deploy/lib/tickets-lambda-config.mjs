/**
 * tickets-lambda-config.mjs — the ticket-tools Lambda's deploy-time config, as pure data.
 *
 * deploy/setup-tickets-lambda.mjs is an imperative handoff script (it talks to STS, IAM,
 * DynamoDB and Lambda at top level), so the three decisions that have bitten in prod are
 * kept HERE, with zero AWS imports, so they can be unit-tested
 * (deploy/lib/__tests__/tickets-lambda-config.test.ts) and pinned against drift:
 *
 *   - resolveArtifactBucket     — which bucket the Lambda reads. TEAM-5867 P1: the script
 *     used to derive this BEFORE the account was known, never recomputed it, forwarded it
 *     only when truthy, and replaced the whole Lambda env — so a standalone re-run stripped
 *     ARTIFACT_BUCKET from the live function.
 *   - buildTicketsPolicyStatements — the role's inline policy. TEAM-5867 P0: the role held
 *     s3:GetObject on <bucket>/* only. S3 answers a GetObject of a MISSING key with 404
 *     only when the caller also holds s3:ListBucket on the bucket; without it the answer
 *     is 403 AccessDenied. Since TEAM-5832 (#878) both ticket twins' Done guard admits a
 *     missing completions/<ticket>.json ONLY on 404 and refuses everything else, so every
 *     recordless ticket (human gates, Merge Approval) could never reach Done.
 *   - buildTicketsLambdaEnv     — the env the function runs with; ARTIFACT_BUCKET is now
 *     unconditional in BOTH provider arms (the twins must be configurable identically).
 *
 * This module is consumed by the deploy script at run time only. It is NOT part of either
 * Lambda zip (scripts/check-lambda-zip-manifest.sh reads the script's single `zip` line,
 * which is unchanged) and lives under deploy/lib/, an excluded surface in
 * deploy/pipeline/surfaces.json.
 */

/**
 * The artifact bucket the Lambda reads config/*.json and completions/*.json from.
 *
 * Same rule as deploy/config.sh:39 and deploy/setup-pipeline-tools-lambda.mjs: an explicit
 * ARTIFACT_BUCKET wins; otherwise the conventional name is derived from the account STS
 * reported and the deploy region. AWS_ACCOUNT_ID is deliberately NOT consulted here —
 * config.sh already folds it into ARTIFACT_BUCKET — because reading it before STS answered
 * is exactly how the bucket went empty (TEAM-5867 P1).
 *
 * THROWS when nothing yields a bucket. The caller must fail the deploy on that, before any
 * IAM or Lambda call: an empty bucket would silently drop both S3 statements from the
 * policy and ARTIFACT_BUCKET from the function env.
 */
export function resolveArtifactBucket({ env = process.env, accountId = "", region = "" } = {}) {
  if (env.ARTIFACT_BUCKET) return env.ARTIFACT_BUCKET;
  if (accountId && region) return `agentcore-hub-artifacts-${accountId}-${region}`;
  throw new Error(
    "ARTIFACT_BUCKET could not be resolved: set ARTIFACT_BUCKET (source deploy/config.sh) " +
      "or let `aws sts get-caller-identity` resolve the account. Refusing to deploy without one."
  );
}

/**
 * The inline policy statements for AgentCoreHubTicketsLambdaRole / AgentCoreHubJiraLambdaRole.
 *
 * The DynamoDB statement is only needed for the dynamodb provider; both providers need
 * CloudWatch Logs and the two S3 statements:
 *
 *   ArtifactRead       — s3:GetObject on <bucket>/*: the agent roster, the phase sets, and
 *                        (TEAM-4706 DL-030, TEAM-4757) the body of completions/<ticket>.json
 *                        behind the Done guard.
 *   ArtifactBucketList — s3:ListBucket on the BUCKET ARN (no `/*`), UNCONDITIONED
 *                        (TEAM-5867 P0). This is what makes S3 report a missing record as
 *                        404 instead of 403, which the twins' guard needs to tell "no
 *                        record" (admit a human gate) from "could not read" (refuse). It
 *                        carries no s3:prefix Condition on purpose: the twins probe with
 *                        GetObject, whose implicit ListBucket check has no prefix in its
 *                        request context, so a StringLike s3:prefix condition would never
 *                        match and S3 would keep answering 403. (TEAM-5600 hit the same wall
 *                        on the pipeline-tools role and had to move ITS probe to
 *                        ListObjectsV2 before a prefix condition could bind.) The role
 *                        already reads every object in the bucket, so this adds key-name
 *                        enumeration and nothing else.
 *   CompletionRecordFence — s3:PutObject on <bucket>/completions/* ONLY (TEAM-5941): the
 *                        twins' Done-intent fence is a conditional PutObject of the
 *                        completion record right before the provider commit. The one S3
 *                        write on the role; twin code that carries the fence refuses every
 *                        Done on a ticket with a record until this grant is live, which is
 *                        why twin-preflight.mjs requires it before a twin code deploy.
 *   TicketCreateClaim  — jira provider ONLY (TEAM-6091): s3:PutObject on
 *                        <bucket>/ticket-claims/*, the Jira twin's create-only claim that
 *                        makes a token-less create_ticket atomic. Fails open if denied.
 *
 * The three TEAM-4739 / TEAM-5716 statements are CONDITIONAL on their env var, so an install
 * that has never set them gets a byte-identical policy on redeploy. Each grants the narrowest
 * thing the guard needs: invoke the read-only pipeline probe; PutItem only on the events
 * table (the gate guard appends journey events and never reads them); GetItem only on the
 * workflows table (a claim-stamped park reads agentTasks[<ticket>] and never writes).
 */
export function buildTicketsPolicyStatements({
  provider,
  region,
  accountId,
  tableName = "",
  artifactBucket,
  pipelineToolsLambda = "",
  eventsTable = "",
  workflowsTable = "",
}) {
  if (!artifactBucket) {
    throw new Error("buildTicketsPolicyStatements: artifactBucket is required (resolveArtifactBucket first)");
  }
  if (!provider || !region || !accountId) {
    throw new Error("buildTicketsPolicyStatements: provider, region and accountId are required");
  }
  const statements = [
    {
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `arn:aws:logs:${region}:${accountId}:*`,
    },
  ];
  if (provider === "dynamodb") {
    if (!tableName) throw new Error("buildTicketsPolicyStatements: tableName is required for the dynamodb provider");
    statements.push({
      Effect: "Allow",
      Action: [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        // TEAM-6143: a Done carrying require_done is one TransactWriteItems whose
        // ConditionCheck on each required ticket row needs this action.
        "dynamodb:ConditionCheckItem",
      ],
      Resource: [
        `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`,
        `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}/index/*`,
      ],
    });
  }
  statements.push(
    {
      Sid: "ArtifactRead",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: `arn:aws:s3:::${artifactBucket}/*`,
    },
    {
      Sid: "ArtifactBucketList",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: `arn:aws:s3:::${artifactBucket}`,
    },
    {
      // TEAM-5941 (TEAM-5799 ship-review r2 F1): the Done-intent fence. Before the
      // provider commit each twin PutObjects completions/<ticket>.json with IfMatch on
      // the ETag its guard admitted (gate-contract.mjs "Done-intent fence"); a denied
      // write REFUSES the Done (fail closed), so this grant must be live before twin code
      // that carries the fence ships — deploy/lib/twin-preflight.mjs enforces that. The
      // ONLY S3 write on the role, prefix-scoped: the twins never write anywhere else.
      Sid: "CompletionRecordFence",
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: `arn:aws:s3:::${artifactBucket}/completions/*`,
    }
  );
  if (provider === "jira") {
    // TEAM-6091: the Jira twin's token-less create claim — a create-only PutObject
    // (IfNoneMatch:"*", then IfMatch to finalize / take over) of
    // ticket-claims/<derived token>.json before the issue POST, because Jira has no
    // conditional create. Read back through ArtifactRead above. The dynamodb twin
    // dedupes with its IDEMP# lock row instead, so it gets no claim grant. A denied
    // write FAILS OPEN (the twin creates without the claim), so unlike the fence this
    // grant is not a twin-preflight prerequisite.
    statements.push({
      Sid: "TicketCreateClaim",
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: `arn:aws:s3:::${artifactBucket}/ticket-claims/*`,
    });
  }
  if (pipelineToolsLambda) {
    statements.push({
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: `arn:aws:lambda:${region}:${accountId}:function:${pipelineToolsLambda}`,
    });
  }
  if (eventsTable) {
    statements.push({
      Effect: "Allow",
      Action: ["dynamodb:PutItem"],
      Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${eventsTable}`,
    });
  }
  if (workflowsTable) {
    statements.push({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${workflowsTable}`,
    });
  }
  return statements;
}

/**
 * The function's environment, per provider.
 *
 * ARTIFACT_BUCKET is UNCONDITIONAL in both arms (TEAM-5867 P1) — UpdateFunctionConfiguration
 * replaces the whole env, so a conditional spread is what let a re-run strip it. Everything
 * else optional is forwarded ONLY when set in the deploying shell, so an existing install
 * that has never heard of a flag keeps the code default and its config is unchanged by a
 * redeploy: FIX_TICKET_CONTRACT (TEAM-4121 FR-8), PIPELINE_TOOLS_LAMBDA / EVENTS_TABLE
 * (TEAM-4739) and WORKFLOWS_TABLE (TEAM-5716), in BOTH arms — the twins must reach the same
 * verdict, so they must be configurable the same way.
 */
export function buildTicketsLambdaEnv({
  provider,
  region,
  tableName = "",
  projectKey,
  artifactBucket,
  jira = {},
  fixTicketContract = "",
  pipelineToolsLambda = "",
  eventsTable = "",
  workflowsTable = "",
}) {
  if (!artifactBucket) {
    throw new Error("buildTicketsLambdaEnv: artifactBucket is required (resolveArtifactBucket first)");
  }
  const optional = {
    ...(fixTicketContract && { FIX_TICKET_CONTRACT: fixTicketContract }),
    ...(pipelineToolsLambda && { PIPELINE_TOOLS_LAMBDA: pipelineToolsLambda }),
    ...(eventsTable && { EVENTS_TABLE: eventsTable }),
    ...(workflowsTable && { WORKFLOWS_TABLE: workflowsTable }),
  };
  if (provider === "jira") {
    return {
      JIRA_SITE_URL: jira.siteUrl || "",
      JIRA_EMAIL: jira.email || "",
      JIRA_API_TOKEN: jira.apiToken || "",
      JIRA_PROJECT_KEY: projectKey,
      AWS_REGION_OVERRIDE: region,
      ARTIFACT_BUCKET: artifactBucket,
      ...optional,
    };
  }
  return {
    TICKETS_TABLE: tableName,
    PROJECT_KEY: projectKey,
    AWS_REGION_OVERRIDE: region,
    ARTIFACT_BUCKET: artifactBucket,
    ...optional,
  };
}
