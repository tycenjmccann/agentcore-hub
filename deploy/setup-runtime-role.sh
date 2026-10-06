#!/bin/bash
#
# setup-runtime-role.sh — Create the IAM execution role for AgentCore Runtime agents
#
# This role is assumed by the 15 fleet agents at runtime. It includes permissions
# for all built-in Strands agent tools (code interpreter, browser, memory, gateway,
# knowledge bases) plus observability (CloudWatch Logs, X-Ray, metrics).
#
# Trust: bedrock-agentcore.amazonaws.com
#
# Usage:
#   source deploy/setup-runtime-role.sh
#   # Sets AGENTCORE_ROLE_ARN for use by deploy-fleet.sh
#
#   # TEAM-5346 operator mode (RUN, don't source): one policy document as JSON, no AWS calls
#   PRINT_POLICY=DynamoDBEventsWrite AWS_ACCOUNT_ID=<acct> bash deploy/setup-runtime-role.sh
#
# If the role already exists this script ensures the trust policy + every inline
# policy is up-to-date and exports the ARN. Idempotent.

set -e

REGION="${AWS_REGION:-us-east-1}"

# ─── PRINT_POLICY: emit one document as JSON, touch nothing (TEAM-5346) ───────
# Modelled on deploy/coding-agent-runtime/setup-coding-runtime-role.sh. Env-var
# gated, honoured ONLY when this file is run directly: it is normally `source`d
# by deploy/runtime-agent/deploy-fleet.sh (after `set -a; source .env.local`),
# and an early return in that path would skip the AGENTCORE_ROLE_ARN export at
# the bottom and let the fleet deploy with an empty role. Sourced = print mode
# is ignored, whatever the environment says.
#
#   PRINT_POLICY=DynamoDBEventsWrite bash deploy/setup-runtime-role.sh   # JSON to stdout
#   PRINT_POLICY=S3ArtifactAccess    bash deploy/setup-runtime-role.sh
#   bash deploy/setup-runtime-role.sh --print-policy [name]
_RR_DIRECT=0
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then _RR_DIRECT=1; fi
PRINT_POLICY="${PRINT_POLICY:-}"
if [ "$_RR_DIRECT" = "1" ] && [ "${1:-}" = "--print-policy" ]; then
  PRINT_POLICY="${2:-DynamoDBEventsWrite}"
fi
if [ "$_RR_DIRECT" != "1" ]; then PRINT_POLICY=""; fi

# AWS_ACCOUNT_ID is honoured ONLY under PRINT_POLICY (the setup-workflow-manager.mjs
# idiom, not deploy/config.sh's unconditional one): every other path resolves the
# account from credentials, because this value lands in the trust policy's
# aws:SourceAccount / aws:SourceArn and in every resource ARN below - a forged
# account in .env.local must not be able to aim PutRolePolicy at another account's
# role name. Print mode is offline by construction (the regression test parses the
# document with no credentials), so there it is the only source.
ACCOUNT_ID="${PRINT_POLICY:+${AWS_ACCOUNT_ID:-}}"
if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
fi
ROLE_NAME="agentcore-hub-agentcore-role"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
_RR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Table names the DynamoDB document refers to - env-overridable, defaults equal
# to the code's (deploy/runtime-agent/main.py EVENTS_TABLE / CLOUD_CODE_TABLE;
# the fleet env var for the sessions table is optional, so the role default MUST
# match main.py's). Never hardcode ARNs or accounts; derive them.
EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}"
CLOUD_CODE_TABLE="${CLOUD_CODE_TABLE:-agentcore-hub-cloud-code-sessions}"
TICKETS_TABLE="${TICKETS_TABLE:-agentcore-hub-tickets}"
WORKFLOWS_TABLE="${WORKFLOWS_TABLE:-agentcore-hub-workflows}"

# ─── S3ArtifactAccess document (put further down; hoisted so PRINT_POLICY can emit it) ───
# TEAM-4995 (DL-033): config/models.json — the one model registry the fleet's
# models_registry.load_registry() reads at persona-resolution time — needs NO new
# key here. This grant is bucket-wide (the bucket ARN plus /*), so config/* is
# already covered; adding the key would be a no-op that implies it was not.
#
# The write side is the opposite: this role runs 18 prompt-driven personas, and
# the Allow above is bucket-wide, so it also covers the document that decides
# which model every one of them runs on. This principal only READS the registry
# (models_registry.py get_object), so DenyRegistryWrite takes the three registry
# keys back — Deny outranks every Allow, here and in any other attached policy.
# The only writers are the token aggregator's own role (setup-token-aggregator-role.sh,
# RegistryReadWrite, already scoped to exactly these keys) and the hub's ECS task
# role (the console save); neither is touched.
#
# TEAM-5322 (FR-11, DL-028): DenyGateDecisionRecordWrites does the same for
# pipeline-artifacts/gate-decisions/*. The ticket twins write a Merge Approval
# decision record there when a HUMAN decides that gate, and Pipeline___start_deploy
# will only pre-approve a deploy when it finds one. The tools Lambda cannot check
# the record's sig, so the record is only worth anything because an agent cannot
# write it: Deny here, the twins' own roles are the only writers. Keep it ONE
# statement, so other protected-prefix Denies can sit next to it.
#
# TEAM-5323: DenyCompletionRecordWrites closes completions/* the same way. The
# twins' skip exemption trusts a completions/<ticket>.json skip record as proof an
# empty sweep closed a gate; only the workflow-output Lambda (its own role) writes
# them, so the fleet must not be able to write or delete one directly.
S3_ARTIFACT_POLICY="{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"S3Access\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\"],
        \"Resource\": [
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}\",
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/*\"
        ]
      },
      {
        \"Sid\": \"DenyRegistryWrite\",
        \"Effect\": \"Deny\",
        \"Action\": [\"s3:PutObject\", \"s3:DeleteObject\"],
        \"Resource\": [
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/config/models.json\",
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/config/models.prev.json\",
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/config/pricing.json\"
        ]
      },
      {
        \"Sid\": \"DenyGateDecisionRecordWrites\",
        \"Effect\": \"Deny\",
        \"Action\": [\"s3:PutObject\"],
        \"Resource\": [
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/pipeline-artifacts/gate-decisions/*\"
        ]
      },
      {
        \"Sid\": \"DenyCompletionRecordWrites\",
        \"Effect\": \"Deny\",
        \"Action\": [\"s3:PutObject\", \"s3:DeleteObject\"],
        \"Resource\": [
          \"arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}/completions/*\"
        ]
      }
    ]
  }"

# ─── DynamoDBEventsWrite document (TEAM-5346, review r2 of TEAM-5325) ────────
# Built by deploy/lib/hub-table-guards.mjs - the one definition, shared with the
# Workflow Manager's setup script. Before: PutItem/UpdateItem/DeleteItem on
# table/agentcore-hub-* - so any of the 18 prompt-driven personas, which run with a
# shell and python_repl, could rewrite a ticket's status/assignee, forget a spent
# decision jti (decisionJtisUsed), or REMOVE parkedTickets.<t> / redispatchCounts.<t>
# on the workflow row, bypassing the Tickets Lambda's conditional writes and the
# orchestrator's workflow-store. After: writes ONLY where main.py writes - the
# events table (agent.* journey events; query + delete of the operator mailbox)
# and the coding-session row - the previous read wildcard kept as-is, and an
# explicit Deny on every write action against the tickets and workflows tables.
# Deny outranks every Allow in every attached policy (BedrockAgentCoreFullAccess
# included) - the DenyCompletionRecordWrites pattern, on DynamoDB.
DYNAMODB_POLICY="$(TICKETS_TABLE="$TICKETS_TABLE" WORKFLOWS_TABLE="$WORKFLOWS_TABLE" \
  node "$_RR_DIR/lib/hub-table-guards.mjs" runtime-policy \
    --region "$REGION" --account "$ACCOUNT_ID" \
    --events-table "$EVENTS_TABLE" --sessions-table "$CLOUD_CODE_TABLE")"

if [ -n "$PRINT_POLICY" ]; then
  case "$PRINT_POLICY" in
    DynamoDBEventsWrite|1) printf '%s\n' "$DYNAMODB_POLICY" ;;
    S3ArtifactAccess) printf '%s\n' "$S3_ARTIFACT_POLICY" ;;
    *) echo "✗ unknown PRINT_POLICY: $PRINT_POLICY (known: DynamoDBEventsWrite, S3ArtifactAccess)" >&2
       exit 2 ;;
  esac
  exit 0
fi

# Trust policy — AgentCore can assume this role
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:*" }
    }
  }]
}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
  echo "   ✓ Role \"$ROLE_NAME\" already exists — refreshing policies"
  # Update trust in case it drifted.
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" >/dev/null
else
  echo "   Creating IAM role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Execution role for AgentCore Hub fleet runtime agents (all built-in tools)" \
    --output text > /dev/null
  echo "   ✓ Role created"
fi

# ─── Managed Policy ───────────────────────────────────────────────────────────
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess"
echo "   ✓ Attached BedrockAgentCoreFullAccess"

# ─── Observability (CloudWatch Logs + X-Ray + Metrics) ────────────────────────
# Required per: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html
# logs:PutResourcePolicy on the runtime log groups is the prerequisite for the
# unified telemetry destination (UNIFIED_TRACES_DESTINATION_ENABLED=true) — it's
# what lets the platform grant itself delivery into /aws/bedrock-agentcore/runtimes/*,
# where the `invoke_agent` spans land in the `spans` log streams.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "Observability" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"LogsCreateGroup\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:DescribeLogStreams\", \"logs:CreateLogGroup\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*\"]
      },
      {
        \"Sid\": \"LogsDescribeGroups\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:DescribeLogGroups\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*\"]
      },
      {
        \"Sid\": \"LogsWrite\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*\"]
      },
      {
        \"Sid\": \"LogsResourcePolicyForUnifiedTelemetry\",
        \"Effect\": \"Allow\",
        \"Action\": [\"logs:PutResourcePolicy\"],
        \"Resource\": [\"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*\"]
      },
      {
        \"Sid\": \"XRay\",
        \"Effect\": \"Allow\",
        \"Action\": [\"xray:PutTraceSegments\", \"xray:PutTelemetryRecords\", \"xray:GetSamplingRules\", \"xray:GetSamplingTargets\"],
        \"Resource\": [\"*\"]
      },
      {
        \"Sid\": \"Metrics\",
        \"Effect\": \"Allow\",
        \"Action\": \"cloudwatch:PutMetricData\",
        \"Resource\": \"*\",
        \"Condition\": { \"StringEquals\": { \"cloudwatch:namespace\": \"bedrock-agentcore\" } }
      }
    ]
  }"
echo "   ✓ Attached Observability (Logs + X-Ray + Metrics)"

# ─── Bedrock Model Invocation ─────────────────────────────────────────────────
# Claude Code uses bedrock:InvokeModel. The codex tool routes GPT-5.5 through
# Bedrock Mantle (OpenAI-compatible) with a short-term bearer token, which needs
# bedrock-mantle:* and bedrock:CallWithBearerToken (Resource:* — the bearer-token
# actions don't support resource-level scoping).
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockModelInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"InvokeModels\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
        \"Resource\": [
          \"arn:aws:bedrock:*::foundation-model/*\",
          \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:*\"
        ]
      },
      {
        \"Sid\": \"BedrockMantleForCodex\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock-mantle:*\", \"bedrock:CallWithBearerToken\"],
        \"Resource\": \"*\"
      }
    ]
  }"
echo "   ✓ Attached Bedrock model invoke (+ Mantle for Codex)"

# ─── ECR Pull (container deploy) ─────────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "ECRPullAccess" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "ECRPull",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchCheckLayerAvailability"
      ],
      "Resource": "*"
    }]
  }'
echo "   ✓ Attached ECR pull access"

# ─── Code Interpreter + Browser (built-in Strands tools) ─────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "CodeInterpreterAndBrowser" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"BuiltInSandboxTools\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"bedrock-agentcore:CreateCodeInterpreter\",
        \"bedrock-agentcore:StartCodeInterpreterSession\",
        \"bedrock-agentcore:InvokeCodeInterpreter\",
        \"bedrock-agentcore:StopCodeInterpreterSession\",
        \"bedrock-agentcore:GetCodeInterpreterSession\",
        \"bedrock-agentcore:ListCodeInterpreterSessions\",
        \"bedrock-agentcore:ListCodeInterpreters\",
        \"bedrock-agentcore:GetCodeInterpreter\",
        \"bedrock-agentcore:DeleteCodeInterpreter\",
        \"bedrock-agentcore:ExecuteCode\",
        \"bedrock-agentcore:ExecuteCommand\",
        \"bedrock-agentcore:InstallPackages\",
        \"bedrock-agentcore:UploadFile\",
        \"bedrock-agentcore:DownloadFile\",
        \"bedrock-agentcore:CreateBrowser\",
        \"bedrock-agentcore:StartBrowserSession\",
        \"bedrock-agentcore:StopBrowserSession\",
        \"bedrock-agentcore:GetBrowserSession\",
        \"bedrock-agentcore:ListBrowserSessions\",
        \"bedrock-agentcore:ListBrowsers\",
        \"bedrock-agentcore:GetBrowser\",
        \"bedrock-agentcore:DeleteBrowser\",
        \"bedrock-agentcore:UpdateBrowserStream\",
        \"bedrock-agentcore:ConnectBrowserAutomationStream\",
        \"bedrock-agentcore:ConnectBrowserLiveViewStream\"
      ],
      \"Resource\": \"*\"
    }]
  }"
echo "   ✓ Attached Code Interpreter + Browser"

# ─── Remote coding runtime (Cloud Code) ──────────────────────────────────────
# Lets fleet personas run claude_code/codex/kiro turns on the standalone coding
# runtime (persistent EFS sessions, resumable from the Cloud Code tab).
# InvokeAgentRuntimeCommand: the fleet waits on a turn by running a short shell
# probe inside the coding session (reads the turn dir, kills a runaway CLI's
# process group) instead of polling an EFS journal (DL-026).
# StopRuntimeSession: reaper for a session whose runner is wedged after a kill.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "InvokeCodingRuntime" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeCodingRuntime\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"bedrock-agentcore:InvokeAgentRuntime\",
        \"bedrock-agentcore:InvokeAgentRuntimeCommand\",
        \"bedrock-agentcore:StopRuntimeSession\"
      ],
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/*\"
    }]
  }"
echo "   ✓ Attached coding-runtime invoke access"

# ─── Memory (built-in Strands tool) ──────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "AgentCoreMemory" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"MemoryDataPlane\",
      \"Effect\": \"Allow\",
      \"Action\": [
        \"bedrock-agentcore:CreateEvent\",
        \"bedrock-agentcore:GetEvent\",
        \"bedrock-agentcore:DeleteEvent\",
        \"bedrock-agentcore:ListEvents\",
        \"bedrock-agentcore:ListActors\",
        \"bedrock-agentcore:ListSessions\",
        \"bedrock-agentcore:GetMemoryRecord\",
        \"bedrock-agentcore:DeleteMemoryRecord\",
        \"bedrock-agentcore:ListMemoryRecords\",
        \"bedrock-agentcore:RetrieveMemoryRecords\",
        \"bedrock-agentcore:BatchCreateMemoryRecords\",
        \"bedrock-agentcore:BatchDeleteMemoryRecords\",
        \"bedrock-agentcore:BatchUpdateMemoryRecords\",
        \"bedrock-agentcore:ListMemoryExtractionJobs\",
        \"bedrock-agentcore:StartMemoryExtractionJob\"
      ],
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:memory/*\"
    }]
  }"
echo "   ✓ Attached Memory access"

# ─── Gateway Invoke (built-in Strands tool) ───────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "GatewayInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeGateway\",
      \"Effect\": \"Allow\",
      \"Action\": \"bedrock-agentcore:InvokeGateway\",
      \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*\"
    }]
  }"
echo "   ✓ Attached Gateway invoke"

# ─── Workload Identity + API Key Access (for gateway OAuth/API key tools) ─────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "WorkloadIdentityAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"WorkloadTokens\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"bedrock-agentcore:GetWorkloadAccessToken\",
          \"bedrock-agentcore:GetWorkloadAccessTokenForJWT\",
          \"bedrock-agentcore:GetWorkloadAccessTokenForUserId\",
          \"bedrock-agentcore:GetResourceApiKey\",
          \"bedrock-agentcore:GetResourceOauth2Token\"
        ],
        \"Resource\": [
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default/apikeycredentialprovider/*\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:token-vault/default/oauth2credentialprovider/*\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default\",
          \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:workload-identity-directory/default/workload-identity/*\"
        ]
      },
      {
        \"Sid\": \"SecretsForApiKeys\",
        \"Effect\": \"Allow\",
        \"Action\": \"secretsmanager:GetSecretValue\",
        \"Resource\": \"arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:bedrock-agentcore-identity!default/*\"
      }
    ]
  }"
echo "   ✓ Attached Workload Identity + API Key access"

# ─── Knowledge Base Retrieve (Strands `retrieve` tool) ────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "BedrockKnowledgeBaseAccess" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"KBRetrieve\",
      \"Effect\": \"Allow\",
      \"Action\": [\"bedrock:Retrieve\", \"bedrock:RetrieveAndGenerate\"],
      \"Resource\": \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*\"
    }]
  }"
echo "   ✓ Attached Knowledge Base retrieve"

# ─── Lambda Invoke (for ticket tools) ────────────────────────────────────────
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "LambdaInvoke" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"InvokeLambda\",
      \"Effect\": \"Allow\",
      \"Action\": \"lambda:InvokeFunction\",
      \"Resource\": \"arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:agentcore-hub-*\"
    }]
  }"
echo "   ✓ Attached Lambda invoke"

# ─── S3 Artifacts (for prompts and outputs) ──────────────────────────────────
# Document hoisted to the top of this file (S3_ARTIFACT_POLICY) so PRINT_POLICY
# can emit it offline; the comments explaining each Deny live there.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "S3ArtifactAccess" \
  --policy-document "$S3_ARTIFACT_POLICY"
echo "   ✓ Attached S3 artifact access"

# ─── DynamoDB ────────────────────────────────────────────────────────────────
# Document built at the top of this file (DYNAMODB_POLICY, by
# deploy/lib/hub-table-guards.mjs). Same policy NAME as before so this put
# replaces the old table/agentcore-hub-* write wildcard in place.
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBEventsWrite" \
  --policy-document "$DYNAMODB_POLICY"
echo "   ✓ Attached DynamoDB (events + coding-session writes; tickets/workflows writes DENIED)"

echo ""
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

export AGENTCORE_ROLE_ARN="$ROLE_ARN"
echo "   ✓ AGENTCORE_ROLE_ARN=$ROLE_ARN"
