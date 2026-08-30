#!/usr/bin/env bash
#
# deploy/ecs-express/deploy.sh — Idempotent Amazon ECS Express Mode deploy for
# AgentCore Hub. This is the recommended path: App Runner is closed to new
# customers (https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html),
# and ECS Express Mode is AWS's named successor — one API call provisions a
# Fargate service, an Application Load Balancer, auto scaling, and networking.
#
# Creates (if needed):
#   1. ECR repository: agentcore-hub-frontend
#   2. ecsTaskExecutionRole              (ECS pulls the image + writes logs)
#   3. ecsInfrastructureRoleForExpressServices (ECS provisions the ALB/scaling)
#   4. agentcore-hub-ecs-task role       (the app's OWN runtime permissions —
#                                         DynamoDB, S3, Bedrock, AgentCore, etc.)
#   5. Docker build + push (linux/amd64)
#   6. ECS Express Mode service: agentcore-hub
#
# Outputs:
#   DEPLOYMENT_URL — the public https://<service>.ecs.<region>.on.aws URL
#                    (persisted to .env.local)
#
# Prerequisites:
#   - AWS CLI v2 (>= 2.34, which ships the *-express-gateway-service commands)
#   - Docker running (docker info must succeed)
#   - A default VPC with public subnets in AWS_REGION (Express Mode's default).
#     Override with EXPRESS_SUBNETS/EXPRESS_SECURITY_GROUPS if you run without one.
#   - .env.local exists (runtime env vars are forwarded into the container)
#
# Usage:
#   ./deploy/ecs-express/deploy.sh
#
# The container is identical to the App Runner path (same Dockerfile, same
# HOSTNAME=0.0.0.0 + PORT=8080 fix); only the hosting control plane differs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Load .env.local so we can forward runtime env vars to the container.
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${AWS_REGION:?AWS_REGION must be set}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Account guard: if EXPECTED_ACCOUNT_ID is set, refuse to deploy to any other
# account — prevents shipping to the wrong profile. Opt-in; no ID is hardcoded.
if [[ -n "${EXPECTED_ACCOUNT_ID:-}" && "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
  echo "ERROR: refusing to deploy — credentials resolve to account $ACCOUNT_ID," >&2
  echo "       but EXPECTED_ACCOUNT_ID=$EXPECTED_ACCOUNT_ID. Wrong AWS_PROFILE?" >&2
  exit 1
fi

ECR_REPO="agentcore-hub-frontend"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
SERVICE_NAME="agentcore-hub"
CLUSTER="${EXPRESS_CLUSTER:-default}" # Express Mode services land in the default cluster
EXEC_ROLE="ecsTaskExecutionRole"
INFRA_ROLE="ecsInfrastructureRoleForExpressServices"
TASK_ROLE="agentcore-hub-ecs-task"     # the app's runtime permissions
# CPU units + MiB, exactly as the ECS API takes them (NOT vCPU/GB): 1024 = 1 vCPU,
# 2048 = 2 GB. Must be a valid Fargate combo (see the CPU/memory matrix) or the
# create/update call is rejected. Defaults: 1 vCPU / 2 GB.
CPU="${EXPRESS_CPU:-1024}"
MEMORY="${EXPRESS_MEMORY:-2048}"

echo "═══════════════════════════════════════════════════════════════"
echo "  ECS Express Mode Deploy — AgentCore Hub"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Pre-flight ───────────────────────────────────────────────────────────────

if ! aws ecs create-express-gateway-service help >/dev/null 2>&1; then
  echo "ERROR: your AWS CLI lacks the ECS Express Mode commands. Upgrade to" >&2
  echo "       AWS CLI v2 >= 2.34 (aws --version)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop or Colima first." >&2
  exit 1
fi

# ─── Step 1: ECR repository ──────────────────────────────────────────────────

echo "  [1/6] ECR repository: $ECR_REPO"
if aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "        Already exists, skipping"
else
  aws ecr create-repository \
    --repository-name "$ECR_REPO" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --output text >/dev/null
  echo "        Created"
fi
echo ""

# ─── Step 2: Task execution role (ECS pulls image + writes logs) ──────────────

echo "  [2/6] IAM role: $EXEC_ROLE"
EXEC_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'
if aws iam get-role --role-name "$EXEC_ROLE" >/dev/null 2>&1; then
  echo "        Already exists — refreshing trust policy"
  aws iam update-assume-role-policy --role-name "$EXEC_ROLE" \
    --policy-document "$EXEC_TRUST" >/dev/null
else
  aws iam create-role --role-name "$EXEC_ROLE" \
    --assume-role-policy-document "$EXEC_TRUST" \
    --description "ECS task execution role (image pull + logs)" \
    --output text >/dev/null
  echo "        Created"
fi
aws iam attach-role-policy --role-name "$EXEC_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" >/dev/null
echo "        Attached AmazonECSTaskExecutionRolePolicy"
EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE}"
echo ""

# ─── Step 3: Express infrastructure role (ECS provisions ALB/scaling) ─────────

echo "  [3/6] IAM role: $INFRA_ROLE"
INFRA_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowAccessInfrastructureForECSExpressServices",
    "Effect": "Allow",
    "Principal": { "Service": "ecs.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'
if aws iam get-role --role-name "$INFRA_ROLE" >/dev/null 2>&1; then
  echo "        Already exists — refreshing trust policy"
  aws iam update-assume-role-policy --role-name "$INFRA_ROLE" \
    --policy-document "$INFRA_TRUST" >/dev/null
else
  aws iam create-role --role-name "$INFRA_ROLE" \
    --assume-role-policy-document "$INFRA_TRUST" \
    --description "ECS Express Mode infrastructure provisioning role" \
    --output text >/dev/null
  echo "        Created"
fi
aws iam attach-role-policy --role-name "$INFRA_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices" >/dev/null
echo "        Attached AmazonECSInfrastructureRoleforExpressGatewayServices"
INFRA_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INFRA_ROLE}"
echo ""

# ─── Step 4: Task role (the app's OWN runtime permissions) ────────────────────
# This is the direct successor to the App Runner instance role — same policy,
# different trust principal. The container assumes THIS to reach DynamoDB, S3,
# Bedrock, AgentCore, Secrets Manager, and CloudWatch.

echo "  [4/6] IAM role: $TASK_ROLE"
TASK_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'
if aws iam get-role --role-name "$TASK_ROLE" >/dev/null 2>&1; then
  echo "        Already exists — refreshing trust policy"
  aws iam update-assume-role-policy --role-name "$TASK_ROLE" \
    --policy-document "$TASK_TRUST" >/dev/null
else
  aws iam create-role --role-name "$TASK_ROLE" \
    --assume-role-policy-document "$TASK_TRUST" \
    --description "Runtime permissions for the AgentCore Hub ECS task" \
    --output text >/dev/null
  echo "        Created"
fi

ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
aws iam put-role-policy \
  --role-name "$TASK_ROLE" \
  --policy-name "AgentCoreHubRuntimePerms" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"LambdaInvoke\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"lambda:InvokeFunction\",
          \"lambda:GetFunctionConcurrency\",
          \"lambda:PutFunctionConcurrency\",
          \"lambda:DeleteFunctionConcurrency\"
        ],
        \"Resource\": \"arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:agentcore-hub-*\"
      },
      {
        \"Sid\": \"DynamoDB\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"dynamodb:GetItem\", \"dynamodb:PutItem\", \"dynamodb:UpdateItem\",
          \"dynamodb:DeleteItem\", \"dynamodb:Query\", \"dynamodb:Scan\",
          \"dynamodb:BatchGetItem\", \"dynamodb:BatchWriteItem\"
        ],
        \"Resource\": \"arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/agentcore-hub-*\"
      },
      {
        \"Sid\": \"S3Artifacts\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\"],
        \"Resource\": [
          \"arn:aws:s3:::${ARTIFACT_BUCKET}\",
          \"arn:aws:s3:::${ARTIFACT_BUCKET}/*\"
        ]
      },
      {
        \"Sid\": \"AgentCore\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"bedrock-agentcore:InvokeAgentRuntime\",
          \"bedrock-agentcore:InvokeAgentRuntimeCommandShell\",
          \"bedrock-agentcore:InvokeHarness\",
          \"bedrock-agentcore:GetAgentRuntime\",
          \"bedrock-agentcore:GetHarness\",
          \"bedrock-agentcore:ListAgentRuntimes\",
          \"bedrock-agentcore:ListHarnesses\",
          \"bedrock-agentcore:ListRegistries\",
          \"bedrock-agentcore:GetRegistry\",
          \"bedrock-agentcore:CreateRegistry\",
          \"bedrock-agentcore:UpdateRegistry\",
          \"bedrock-agentcore:DeleteRegistry\",
          \"bedrock-agentcore:ListRegistryRecords\",
          \"bedrock-agentcore:GetRegistryRecord\",
          \"bedrock-agentcore:CreateRegistryRecord\",
          \"bedrock-agentcore:UpdateRegistryRecord\",
          \"bedrock-agentcore:DeleteRegistryRecord\",
          \"bedrock-agentcore:SubmitRegistryRecordForApproval\",
          \"bedrock-agentcore:UpdateRegistryRecordStatus\",
          \"bedrock-agentcore:SearchRegistryRecords\",
          \"bedrock-agentcore:ListMemories\",
          \"bedrock-agentcore:GetMemory\",
          \"bedrock-agentcore:ListActors\",
          \"bedrock-agentcore:ListSessions\",
          \"bedrock-agentcore:ListEvents\",
          \"bedrock-agentcore:GetEvent\",
          \"bedrock-agentcore:CreateEvent\",
          \"bedrock-agentcore:ListMemoryRecords\",
          \"bedrock-agentcore:RetrieveMemoryRecords\",
          \"bedrock-agentcore:ListOnlineEvaluationConfigs\",
          \"bedrock-agentcore:GetOnlineEvaluationConfig\",
          \"bedrock-agentcore:UpdateOnlineEvaluationConfig\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"BedrockModels\",
        \"Effect\": \"Allow\",
        \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"CloudWatch\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"cloudwatch:GetMetricData\", \"cloudwatch:GetMetricStatistics\", \"cloudwatch:ListMetrics\",
          \"logs:DescribeLogGroups\", \"logs:DescribeLogStreams\",
          \"logs:GetLogEvents\", \"logs:FilterLogEvents\",
          \"logs:StartQuery\", \"logs:StopQuery\", \"logs:GetQueryResults\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"STS\",
        \"Effect\": \"Allow\",
        \"Action\": \"sts:GetCallerIdentity\",
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"GithubAppSecret\",
        \"Effect\": \"Allow\",
        \"Action\": [\"secretsmanager:GetSecretValue\", \"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\"],
        \"Resource\": \"arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:cloud-code/github-app*\"
      }
    ]
  }"
echo "        Attached inline runtime policy"
TASK_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}"
echo ""

# ─── Step 5: Docker build + ECR push ─────────────────────────────────────────

echo "  [5/6] Docker build + ECR push"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# The tracked src/config/agents.json ships runtimeArn:null (open-source contract).
# Bundle the deployed copy (real ARNs) from S3 for the build only, then restore
# the null version so git stays clean. Mirrors the App Runner path exactly.
RESTORE_AGENTS_JSON=""
AGENTS_JSON_PATH="$REPO_ROOT/src/config/agents.json"
if [[ -n "${ARTIFACT_BUCKET:-}" ]]; then
  if aws s3 cp "s3://${ARTIFACT_BUCKET}/config/agents.json" /tmp/agents.s3.json \
       --region "$AWS_REGION" --only-show-errors 2>/dev/null; then
    cp "$AGENTS_JSON_PATH" /tmp/agents.git.json
    cp /tmp/agents.s3.json "$AGENTS_JSON_PATH"
    RESTORE_AGENTS_JSON=1
    echo "        Bundling deployed agents.json (real runtime ARNs) from S3"
  fi
fi
restore_agents_json() {
  if [[ -n "$RESTORE_AGENTS_JSON" && -f /tmp/agents.git.json ]]; then
    cp /tmp/agents.git.json "$AGENTS_JSON_PATH"
    echo "        Restored tracked agents.json (runtimeArn:null)"
  fi
}
trap restore_agents_json EXIT

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
CONFIG_HASH="$(shasum "$AGENTS_JSON_PATH" 2>/dev/null | cut -c1-8 || echo '00000000')"
IMAGE_TAG="${GIT_SHA}-${CONFIG_HASH}"
FULL_TAG="${ECR_URI}:${IMAGE_TAG}"
LATEST_TAG="${ECR_URI}:latest"

echo "        Building ${FULL_TAG} ..."
docker buildx build \
  --platform linux/amd64 \
  --tag "$FULL_TAG" \
  --tag "$LATEST_TAG" \
  --push \
  --file Dockerfile \
  .
echo "        Pushed to ECR"
echo ""

# ─── Step 6: ECS Express Mode service ─────────────────────────────────────────

echo "  [6/6] ECS Express Mode service: $SERVICE_NAME"

# Build the container env array. HOSTNAME=0.0.0.0 + PORT=8080 mirror the App
# Runner fix: Next.js standalone binds to whatever HOSTNAME resolves to, so pin
# it to all-interfaces or the ALB target health check on :8080 fails.
ENV_JSON="[{\"name\":\"HOSTNAME\",\"value\":\"0.0.0.0\"},{\"name\":\"PORT\",\"value\":\"8080\"},{\"name\":\"NODE_ENV\",\"value\":\"production\"}"
for var in AWS_REGION TICKET_PROVIDER WORKFLOWS_TABLE EVENTS_TABLE TICKETS_TABLE \
           ARTIFACT_BUCKET TICKET_TOOLS_LAMBDA JIRA_SITE_URL JIRA_EMAIL \
           JIRA_API_TOKEN JIRA_PROJECT_KEY GITHUB_PAT GITHUB_OWNER GITHUB_REPO \
           MCP_SERVERS BUILDER_AGENT_ID AGENTCORE_ROLE_ARN LAMBDA_ROLE_ARN \
           NEXT_PUBLIC_BRAND_NAME EVAL_CONFIG_TABLE DEPLOY_MODE \
           WORKFLOW_RUNTIME_COUNT CODING_AGENT_RUNTIME_ARN CLOUD_CODE_TABLE \
           WORKFLOW_MANAGER_ARN ROUTINE_BUILDER_ARN ROUTINES_TABLE \
           ROUTINES_RUNNER_ARN ROUTINES_SCHEDULER_ROLE_ARN ROUTINES_SCHEDULE_GROUP \
           ROUTINES_DLQ_ARN ANOMALY_INTAKE_SECRET \
           WM_MAX_OPEN_AUTO_BUGS WM_BUG_MUTE_DAYS \
           WORKFLOW_COMMAND_QUEUE_URL WORKFLOW_LEASE_TTL_MINUTES; do
  val="${!var:-}"
  if [[ -n "$val" ]]; then
    escaped="${val//\\/\\\\}"; escaped="${escaped//\"/\\\"}"
    ENV_JSON+=",{\"name\":\"${var}\",\"value\":\"${escaped}\"}"
  fi
done
ENV_JSON+="]"

PRIMARY_CONTAINER="{\"image\":\"${FULL_TAG}\",\"containerPort\":8080,\"environment\":${ENV_JSON}}"

# Optional explicit networking (only when there's no usable default VPC).
NET_ARG=()
if [[ -n "${EXPRESS_SUBNETS:-}" ]]; then
  SUBNETS_JSON=$(printf '"%s",' ${EXPRESS_SUBNETS//,/ }); SUBNETS_JSON="[${SUBNETS_JSON%,}]"
  SG_JSON="[]"
  if [[ -n "${EXPRESS_SECURITY_GROUPS:-}" ]]; then
    SG_JSON=$(printf '"%s",' ${EXPRESS_SECURITY_GROUPS//,/ }); SG_JSON="[${SG_JSON%,}]"
  fi
  NET_ARG=(--network-configuration "{\"subnets\":${SUBNETS_JSON},\"securityGroups\":${SG_JSON}}")
fi

# Idempotency: find OUR service in the target cluster so a re-run updates in
# place instead of creating a duplicate. Match the service-name segment EXACTLY
# — a prefix match would also hit e.g. agentcore-hub-frontend/-worker and, since
# serviceArns ordering isn't guaranteed, could update the wrong service.
# NOTE: a `VAR=val cmd | python3` prefix only exports VAR to `cmd`, NOT to the
# `python3` on the far side of the pipe — so export it for the whole subshell,
# else the lookup KeyErrors (swallowed by 2>/dev/null), returns empty, and a
# re-run wrongly takes the CREATE path and collides with the live service.
export SERVICE_NAME
EXISTING_ARN=$(aws ecs list-services --cluster "$CLUSTER" --region "$AWS_REGION" --output json 2>/dev/null \
  | python3 -c "
import json, os, sys
want = os.environ['SERVICE_NAME']
data = json.load(sys.stdin)
for arn in data.get('serviceArns', []):
    if arn.rsplit('/', 1)[-1] == want:
        print(arn); break
" 2>/dev/null || true)

if [[ -n "$EXISTING_ARN" ]]; then
  echo "        Service exists ($EXISTING_ARN) — updating in place..."
  # Re-apply networking on update too, so rotating EXPRESS_SUBNETS/SECURITY_GROUPS
  # and rerunning actually takes effect (not just on first create).
  aws ecs update-express-gateway-service \
    --service-arn "$EXISTING_ARN" \
    --region "$AWS_REGION" \
    --primary-container "$PRIMARY_CONTAINER" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --cpu "$CPU" \
    --memory "$MEMORY" \
    --health-check-path "/" \
    --monitor-resources \
    ${NET_ARG[@]+"${NET_ARG[@]}"} \
    --output text >/dev/null
  SERVICE_ARN="$EXISTING_ARN"
  echo "        Update started"
else
  echo "        Creating new service..."
  SERVICE_ARN=$(aws ecs create-express-gateway-service \
    --service-name "$SERVICE_NAME" \
    --cluster "$CLUSTER" \
    --region "$AWS_REGION" \
    --primary-container "$PRIMARY_CONTAINER" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --cpu "$CPU" \
    --memory "$MEMORY" \
    --health-check-path "/" \
    --scaling-target '{"minTaskCount":1,"maxTaskCount":4}' \
    --monitor-resources \
    ${NET_ARG[@]+"${NET_ARG[@]}"} \
    --query 'service.serviceArn' --output text)
  echo "        Create started ($SERVICE_ARN)"
fi
echo ""

# ─── Wait for ACTIVE + resolve the URL ────────────────────────────────────────
# statusCode is only ACTIVE|DRAINING|INACTIVE — a fresh service starts INACTIVE
# and flips to ACTIVE once the ALB targets pass health checks. The public
# endpoint lives at activeConfigurations[].ingressPaths[].endpoint (there is no
# service.url field). Poll for ACTIVE; require it after the loop.
echo "        Waiting for service to become ACTIVE (5–10 min)..."
STATUS="UNKNOWN"; STATUS_REASON=""; SERVICE_URL=""
for i in $(seq 1 90); do
  DESC=$(aws ecs describe-express-gateway-service \
    --service-arn "$SERVICE_ARN" --region "$AWS_REGION" --output json 2>/dev/null || echo '{}')
  # Field-separate with \x1f (unit separator): a non-whitespace delimiter, so
  # `read` won't collapse an empty middle field (an empty URL while INACTIVE)
  # the way a tab/space would and shift the columns.
  IFS=$'\x1f' read -r STATUS SERVICE_URL STATUS_REASON <<<"$(echo "$DESC" | python3 -c "
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
s = d.get('service', {})
st = s.get('status') or {}
status = st.get('statusCode', 'UNKNOWN')
reason = st.get('statusReason', '')
url = ''
for cfg in s.get('activeConfigurations', []) or []:
    for ing in cfg.get('ingressPaths', []) or []:
        ep = ing.get('endpoint')
        if ep:
            url = ep; break
    if url: break
sys.stdout.write('\x1f'.join([status, url, reason]))
" 2>/dev/null || printf 'UNKNOWN\x1f\x1f')"
  # ACTIVE with a resolved endpoint = ready. (ACTIVE can briefly precede the
  # ingress endpoint being published, so keep polling until we have both.)
  if [[ "$STATUS" == "ACTIVE" && -n "$SERVICE_URL" ]]; then break; fi
  printf "        [%02d] Status: %s ...\r" "$i" "$STATUS"
  sleep 10
done
echo ""

if [[ "$STATUS" != "ACTIVE" ]]; then
  echo "        ERROR: service did not reach ACTIVE (last status: ${STATUS})." >&2
  [[ -n "$STATUS_REASON" ]] && echo "        Reason: ${STATUS_REASON}" >&2
  echo "        Inspect: aws ecs describe-express-gateway-service --service-arn ${SERVICE_ARN} --region ${AWS_REGION}" >&2
  exit 1
fi

if [[ -z "$SERVICE_URL" ]]; then
  echo "        WARNING: service is ACTIVE but no ingress endpoint was returned yet." >&2
  echo "        Re-run describe-express-gateway-service shortly to get the URL." >&2
elif [[ "$SERVICE_URL" != http* ]]; then
  SERVICE_URL="https://${SERVICE_URL}"
fi
echo "        Service URL: ${SERVICE_URL:-<pending>}"

# Persist DEPLOYMENT_URL to .env.local (only if we actually resolved one, so a
# transient empty endpoint can't blank a previously-good value).
if [[ -n "$SERVICE_URL" ]]; then
  if grep -q '^DEPLOYMENT_URL=' .env.local 2>/dev/null; then
    sed "s|^DEPLOYMENT_URL=.*|DEPLOYMENT_URL=\"${SERVICE_URL}\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
  else
    echo "DEPLOYMENT_URL=\"${SERVICE_URL}\"" >> .env.local
  fi
  chmod 600 .env.local
  echo "        Persisted DEPLOYMENT_URL to .env.local"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ECS Express Mode deploy complete"
echo "  URL: $SERVICE_URL"
echo "═══════════════════════════════════════════════════════════════"
