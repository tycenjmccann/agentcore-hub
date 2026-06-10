#!/usr/bin/env bash
#
# deploy/apprunner/deploy.sh — Idempotent App Runner deployment for AgentCore Hub
#
# Creates (if needed):
#   1. ECR repository: agentcore-hub-frontend
#   2. AppRunnerECRAccessRole (lets App Runner pull from ECR)
#   3. agentcore-hub-apprunner-instance role (runtime perms for the container)
#   4. Docker build + push (linux/amd64)
#   5. App Runner service: agentcore-hub
#
# Outputs:
#   DEPLOYMENT_URL — the public App Runner URL (persisted to .env.local)
#
# Prerequisites:
#   - AWS CLI configured (AWS_PROFILE or default credentials)
#   - Docker running (docker info must succeed)
#   - .env.local exists (for runtime env vars injected into the service)
#
# Usage:
#   ./deploy/apprunner/deploy.sh
#
# Bug 3 fix: HOSTNAME=0.0.0.0 and PORT=8080 are always set as App Runner
# RuntimeEnvironmentVariables so they override the container's HOSTNAME
# injection. Without this, Next.js standalone binds to the EC2 internal
# hostname and the TCP health check on 127.0.0.1:8080 fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# Load .env.local so we can forward runtime env vars to App Runner.
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${AWS_REGION:?AWS_REGION must be set}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="agentcore-hub-frontend"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
SERVICE_NAME="agentcore-hub"
ECR_ACCESS_ROLE="AppRunnerECRAccessRole"
INSTANCE_ROLE="agentcore-hub-apprunner-instance"

echo "═══════════════════════════════════════════════════════════════"
echo "  App Runner Deploy — AgentCore Hub"
echo "  Account: $ACCOUNT_ID  Region: $AWS_REGION"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Pre-flight: Docker must be running ───────────────────────────────────────

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop or Colima first." >&2
  exit 1
fi

# ─── Step 1: ECR repository ──────────────────────────────────────────────────

echo "  [1/5] ECR repository: $ECR_REPO"
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

# ─── Step 2: AppRunnerECRAccessRole ──────────────────────────────────────────

echo "  [2/5] IAM role: $ECR_ACCESS_ROLE"
ECR_TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "build.apprunner.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

if aws iam get-role --role-name "$ECR_ACCESS_ROLE" >/dev/null 2>&1; then
  echo "        Already exists — refreshing trust policy"
  aws iam update-assume-role-policy \
    --role-name "$ECR_ACCESS_ROLE" \
    --policy-document "$ECR_TRUST_POLICY" >/dev/null
else
  aws iam create-role \
    --role-name "$ECR_ACCESS_ROLE" \
    --assume-role-policy-document "$ECR_TRUST_POLICY" \
    --description "Allows App Runner to pull images from ECR" \
    --output text >/dev/null
  echo "        Created"
fi
aws iam attach-role-policy \
  --role-name "$ECR_ACCESS_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess" \
  >/dev/null
echo "        Attached AWSAppRunnerServicePolicyForECRAccess"
ECR_ACCESS_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ECR_ACCESS_ROLE}"
echo ""

# ─── Step 3: Instance role ───────────────────────────────────────────────────

echo "  [3/5] IAM role: $INSTANCE_ROLE"
INSTANCE_TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

if aws iam get-role --role-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  echo "        Already exists — refreshing policies"
  aws iam update-assume-role-policy \
    --role-name "$INSTANCE_ROLE" \
    --policy-document "$INSTANCE_TRUST_POLICY" >/dev/null
else
  aws iam create-role \
    --role-name "$INSTANCE_ROLE" \
    --assume-role-policy-document "$INSTANCE_TRUST_POLICY" \
    --description "Instance role for AgentCore Hub App Runner service" \
    --output text >/dev/null
  echo "        Created"
fi

ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}-${AWS_REGION}}"
aws iam put-role-policy \
  --role-name "$INSTANCE_ROLE" \
  --policy-name "AgentCoreHubAppRunnerPerms" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"LambdaInvoke\",
        \"Effect\": \"Allow\",
        \"Action\": \"lambda:InvokeFunction\",
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
          \"bedrock-agentcore:InvokeHarness\",
          \"bedrock-agentcore:GetAgentRuntime\",
          \"bedrock-agentcore:GetHarness\",
          \"bedrock-agentcore:ListAgentRuntimes\",
          \"bedrock-agentcore:ListHarnesses\"
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
      }
    ]
  }"
echo "        Attached inline policy"
INSTANCE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_ROLE}"
echo ""

# ─── Step 4: Docker build + ECR push ─────────────────────────────────────────

echo "  [4/5] Docker build + ECR push"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

IMAGE_TAG="$(git rev-parse --short HEAD 2>/dev/null || echo 'latest')"
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

# ─── Step 5: App Runner service ──────────────────────────────────────────────

echo "  [5/5] App Runner service: $SERVICE_NAME"

# Collect runtime env vars to inject into the container.
# Bug 3 fix: always set HOSTNAME=0.0.0.0 and PORT=8080 so Next.js standalone
# binds to all interfaces. App Runner injects its own HOSTNAME at launch
# which would otherwise override the Dockerfile ENV and break the health check.
ENV_VARS='{
  "HOSTNAME": "0.0.0.0",
  "PORT": "8080",
  "NODE_ENV": "production"'

# Forward .env.local values that the app needs at runtime
for var in AWS_REGION TICKET_PROVIDER WORKFLOWS_TABLE EVENTS_TABLE TICKETS_TABLE \
           ARTIFACT_BUCKET TICKET_TOOLS_LAMBDA JIRA_SITE_URL JIRA_EMAIL \
           JIRA_API_TOKEN JIRA_PROJECT_KEY GITHUB_PAT GITHUB_OWNER GITHUB_REPO \
           MCP_SERVERS BUILDER_AGENT_ID AGENTCORE_ROLE_ARN LAMBDA_ROLE_ARN \
           NEXT_PUBLIC_BRAND_NAME EVAL_CONFIG_TABLE DEPLOY_MODE \
           WORKFLOW_RUNTIME_COUNT; do
  val="${!var:-}"
  if [[ -n "$val" ]]; then
    # Escape quotes in the value for JSON safety
    escaped="${val//\"/\\\"}"
    ENV_VARS+=", \"${var}\": \"${escaped}\""
  fi
done
ENV_VARS+='}'

# Check if service already exists
EXISTING_ARN=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for svc in data.get('ServiceSummaryList', []):
    if svc.get('ServiceName') == '${SERVICE_NAME}':
        print(svc['ServiceArn'])
        break
" 2>/dev/null || true)

if [[ -n "$EXISTING_ARN" ]]; then
  echo "        Service exists ($EXISTING_ARN) — updating..."
  aws apprunner update-service \
    --service-arn "$EXISTING_ARN" \
    --region "$AWS_REGION" \
    --source-configuration "{
      \"AuthenticationConfiguration\": {
        \"AccessRoleArn\": \"${ECR_ACCESS_ROLE_ARN}\"
      },
      \"ImageRepository\": {
        \"ImageIdentifier\": \"${FULL_TAG}\",
        \"ImageRepositoryType\": \"ECR\",
        \"ImageConfiguration\": {
          \"Port\": \"8080\",
          \"RuntimeEnvironmentVariables\": ${ENV_VARS}
        }
      }
    }" \
    --instance-configuration "{
      \"InstanceRoleArn\": \"${INSTANCE_ROLE_ARN}\"
    }" \
    --output text >/dev/null
  echo "        Update started"
  # update-service is a no-op when the image tag is unchanged (content-only
  # changes reuse the same git-SHA tag). Force a fresh pull so the new image
  # is actually deployed.
  aws apprunner start-deployment \
    --service-arn "$EXISTING_ARN" \
    --region "$AWS_REGION" \
    --output text >/dev/null 2>&1 || true
  echo "        Forced fresh deployment"
else
  echo "        Creating new service..."
  aws apprunner create-service \
    --service-name "$SERVICE_NAME" \
    --region "$AWS_REGION" \
    --source-configuration "{
      \"AuthenticationConfiguration\": {
        \"AccessRoleArn\": \"${ECR_ACCESS_ROLE_ARN}\"
      },
      \"ImageRepository\": {
        \"ImageIdentifier\": \"${LATEST_TAG}\",
        \"ImageRepositoryType\": \"ECR\",
        \"ImageConfiguration\": {
          \"Port\": \"8080\",
          \"RuntimeEnvironmentVariables\": ${ENV_VARS}
        }
      }
    }" \
    --instance-configuration "{
      \"Cpu\": \"1024\",
      \"Memory\": \"2048\",
      \"InstanceRoleArn\": \"${INSTANCE_ROLE_ARN}\"
    }" \
    --health-check-configuration "{
      \"Protocol\": \"TCP\",
      \"Path\": \"/\",
      \"Interval\": 10,
      \"Timeout\": 5,
      \"HealthyThreshold\": 1,
      \"UnhealthyThreshold\": 5
    }" \
    --output text >/dev/null
  echo "        Create started"
fi

# Wait for the service to become RUNNING (up to 15 min)
echo "        Waiting for service to become RUNNING (this can take 5–10 min)..."
for i in $(seq 1 90); do
  STATUS=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
for svc in data.get('ServiceSummaryList', []):
    if svc.get('ServiceName') == '${SERVICE_NAME}':
        print(svc.get('Status', 'UNKNOWN'))
        break
" 2>/dev/null || echo "UNKNOWN")

  if [[ "$STATUS" == "RUNNING" ]]; then
    break
  fi
  if [[ "$STATUS" == "CREATE_FAILED" || "$STATUS" == "DELETE_FAILED" ]]; then
    echo "        ERROR: Service status is $STATUS" >&2
    exit 1
  fi
  printf "        [%02d] Status: %s ...\r" "$i" "$STATUS"
  sleep 10
done
echo ""

# Retrieve the service URL
SERVICE_URL=$(aws apprunner list-services --region "$AWS_REGION" --output json 2>/dev/null \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for svc in data.get('ServiceSummaryList', []):
    if svc.get('ServiceName') == '${SERVICE_NAME}':
        print('https://' + svc.get('ServiceUrl', ''))
        break
" 2>/dev/null || true)

if [[ -z "$SERVICE_URL" || "$SERVICE_URL" == "https://" ]]; then
  echo "        WARNING: Could not retrieve service URL. Check the AWS console." >&2
  SERVICE_URL="https://placeholder.apprunner.example"
fi

echo "        Service URL: $SERVICE_URL"

# Persist DEPLOYMENT_URL to .env.local
if grep -q '^DEPLOYMENT_URL=' .env.local 2>/dev/null; then
  sed "s|^DEPLOYMENT_URL=.*|DEPLOYMENT_URL=\"${SERVICE_URL}\"|" .env.local > .env.local.tmp && mv .env.local.tmp .env.local
else
  echo "DEPLOYMENT_URL=\"${SERVICE_URL}\"" >> .env.local
fi
chmod 600 .env.local
echo "        Persisted DEPLOYMENT_URL to .env.local"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  App Runner deploy complete"
echo "  URL: $SERVICE_URL"
echo "═══════════════════════════════════════════════════════════════"
