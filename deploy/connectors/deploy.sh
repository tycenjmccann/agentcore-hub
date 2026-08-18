#!/bin/bash
# Connectors — IAM wiring.
#
# Connector credentials live in AWS Secrets Manager under `connectors/*` (never in
# S3 config, never in the roster). Two principals touch them:
#   - the Next app (ECS task role): create/put/delete + describe the secret from the
#     secure credential form.
#   - the fleet runtime (agentcore role): read the secret at invocation time to wire
#     env/mcp/gateway creds for the agent.
# This script grants each principal the minimum needed, scoped to connectors/*.
# Idempotent — re-run any time.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/deploy/config.sh"

APP_ROLE="${ECS_TASK_ROLE_NAME:-agentcore-hub-ecs-task}"
RUNTIME_ROLE="${AGENTCORE_ROLE_NAME:-agentcore-hub-agentcore-role}"
SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:connectors/*"

echo "═══════════════════════════════════════════════════════════"
echo "  Connectors IAM"
echo "  Account: ${ACCOUNT_ID}"
echo "  Secrets: connectors/* (${AWS_REGION})"
echo "═══════════════════════════════════════════════════════════"

# App role: manage connector secrets (create/put/delete/describe) from the UI form.
if aws iam get-role --role-name "$APP_ROLE" >/dev/null 2>&1; then
  aws iam put-role-policy --role-name "$APP_ROLE" \
    --policy-name ConnectorSecretsManage \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Sid\": \"ConnectorSecrets\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"secretsmanager:CreateSecret\",
          \"secretsmanager:PutSecretValue\",
          \"secretsmanager:DescribeSecret\",
          \"secretsmanager:DeleteSecret\",
          \"secretsmanager:TagResource\"
        ],
        \"Resource\": \"${SECRET_ARN}\"
      }]
    }" >/dev/null
  echo "✓ IAM: ConnectorSecretsManage on ${APP_ROLE}"
else
  echo "  (skip ${APP_ROLE} — not found)"
fi

# Runtime role: read connector secrets at invocation time.
if aws iam get-role --role-name "$RUNTIME_ROLE" >/dev/null 2>&1; then
  aws iam put-role-policy --role-name "$RUNTIME_ROLE" \
    --policy-name ConnectorSecretsRead \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Sid\": \"ConnectorSecretsRead\",
        \"Effect\": \"Allow\",
        \"Action\": [\"secretsmanager:GetSecretValue\", \"secretsmanager:DescribeSecret\"],
        \"Resource\": \"${SECRET_ARN}\"
      }]
    }" >/dev/null
  echo "✓ IAM: ConnectorSecretsRead on ${RUNTIME_ROLE}"
else
  echo "  (skip ${RUNTIME_ROLE} — not found)"
fi

echo ""
echo "  ✓ Done. Registry: s3://${ARTIFACT_BUCKET}/config/connectors.json (created on first connector)."
echo "    Credentials: Secrets Manager connectors/<id> (written by the UI form)."
