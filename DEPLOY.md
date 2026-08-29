# DEPLOY.md

Deploy contract for AgentCore Hub (see `docs/DEPLOY-md-contract.md` for the
format). The hub is a three-target deploy: orchestrator Lambda (code only),
config/blueprints to S3, and the Next.js app to ECS Express Mode.

## Environment prerequisites

- AWS CLI v2 (>= 2.34, ships the `*-express-gateway-service` commands)
- Docker running (`docker info` succeeds) — the ECS target builds linux/amd64
- Node 20 / npm 10
- `.env.local` present at repo root (holds `AWS_PROFILE`, `AWS_REGION`,
  `EXPECTED_ACCOUNT_ID`, runtime env forwarded to the container). Deploy
  scripts source it via `deploy/config.sh`; never commit it.
- The target account is the PRODUCTION hub account declared by
  `EXPECTED_ACCOUNT_ID` in `.env.local` — scripts verify credentials against
  it before touching anything.

## Required secrets

None resolved by the deploy itself — runtime credentials (Jira, GitHub PAT,
Telegram) already live on the deployed resources' env/Secrets Manager and are
NOT rewritten by the commands below. That is deliberate:

- **Never run `lambda/orchestrator`'s full deploy script without `JIRA_*` env
  set — it rewrites function env vars and would blank prod Jira credentials.**
  The staging deploy below is code-only for exactly this reason.

## Config evals gate

Prompt/config/blueprint changes are gated by the config-evals battery — see
[`evals/battery/README.md`](evals/battery/README.md) for cases, thresholds,
and the break-glass procedure. All deploy targets that ship gated artifacts
(`deploy/runtime-agent/deploy{,-one,-fleet,-topology}.sh`,
`deploy/workflow-manager/deploy.sh`, `deploy/apprunner/deploy.sh`,
`deploy/ecs-express/deploy.sh`) source `deploy/lib/check-eval-gate.sh` and
refuse to run unless HEAD carries a `config-evals-gate` check run that is a
verified battery **PASS** — a bare `success` conclusion is not enough, since the
gate also publishes a SKIPPED success for PRs touching no gated path (see
"Deploy gate + break-glass" in `evals/battery/README.md`).
The gate's CI job assumes an OIDC IAM role — one-time provisioning is
documented in [`evals/battery/README.md`](evals/battery/README.md) under
"CI AWS credentials (one-time setup)".

### Break-glass

Two equivalent forms — the CLI flags are sugar over the env vars, and both route
through the same audited override (loud banner, `{timestamp, sha, STS identity,
script, reason}` to `s3://$ARTIFACT_BUCKET/eval-gate/overrides/` **and**
`.eval-gate-overrides.log`; refused if no durable record can be written):

```bash
# CLI form — deploy/runtime-agent/deploy.sh and deploy-one.sh
./deploy/runtime-agent/deploy.sh --force --force-reason "INC-123: why" backend_dev

# Env-var form — every gated target, including the raw require_eval_gate calls below
EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON="INC-123: why" ./deploy/ecs-express/deploy.sh
```

A reason is mandatory: `--force` without a non-empty `--force-reason` (or an
inherited non-empty `EVAL_GATE_OVERRIDE_REASON`) is refused before any gate or
deploy work, and unknown `--flags` are rejected rather than misread as an agent
name. Full semantics: "Deploy gate + break-glass" in
[`evals/battery/README.md`](evals/battery/README.md).

## Staging deploy

The hub has no separate staging account; "staging" = deploying code-only
targets and verifying before the app rollout completes traffic shift.

```bash
# 1. Orchestrator Lambda — CODE ONLY (never its deploy.sh; see Required secrets)
#    PRE-STEP: the zip ships no gated config, but all three targets run the
#    gate so the contract is uniform (the sha latch makes repeat checks free):
source deploy/lib/check-eval-gate.sh
require_eval_gate "src/config/agents.json" "src/config/workflows.json"
cd lambda/orchestrator && npm ci --omit=dev && zip -qr /tmp/orchestrator.zip . && cd ../..
aws lambda update-function-code --function-name agentcore-hub-orchestrator \
  --zip-file fileb:///tmp/orchestrator.zip --region "$AWS_REGION"

# 2. Blueprints + prompts + config → S3 artifact bucket
#    (blueprints/prompts are safe to cp; agents.json must be MERGED onto the S3
#    copy — the S3 version carries deploy-injected runtimeArns the repo nulls out)
#    PRE-STEP: this target ships gated artifacts raw (no deploy script), so run
#    the eval-gate check yourself before syncing:
source deploy/lib/check-eval-gate.sh
require_eval_gate "blueprints/**" "deploy/runtime-agent/prompts/**" \
  "deploy/workflow-manager/**" "src/config/agents.json" "src/config/workflows.json"
aws s3 sync blueprints/ "s3://$ARTIFACT_BUCKET/blueprints/"
aws s3 sync deploy/runtime-agent/prompts/ "s3://$ARTIFACT_BUCKET/prompts/"
aws s3 cp src/config/workflows.json "s3://$ARTIFACT_BUCKET/config/workflows.json"
aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" /tmp/agents-s3.json
python3 - <<'EOF'   # merge repo agents.json onto the S3 copy, preserving injected runtimeArns
import json
repo = json.load(open("src/config/agents.json"))
s3 = json.load(open("/tmp/agents-s3.json"))
arns = {a["agentId"]: a.get("runtimeArn") for a in s3["agents"]}
for a in repo["agents"]:
    a["runtimeArn"] = a.get("runtimeArn") or arns.get(a["agentId"])
json.dump(repo, open("/tmp/agents-merged.json", "w"), indent=2)
EOF
aws s3 cp /tmp/agents-merged.json "s3://$ARTIFACT_BUCKET/config/agents.json"

# 3. Next.js app → ECS Express Mode (build, push, roll the service)
./deploy/ecs-express/deploy.sh
```

## Smoke checks

```bash
# App is serving (DEPLOYMENT_URL is written to .env.local by the ECS deploy)
curl -sf "$DEPLOYMENT_URL/api/agentcore/traces/health"        # expect HTTP 200

# Orchestrator lambda healthy on the new code
aws lambda get-function --function-name agentcore-hub-orchestrator \
  --query 'Configuration.[State,LastUpdateStatus]' --output text  # expect: Active Successful

# Config landed with ARNs intact (never null after a merge)
aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" - | \
  python3 -c "import json,sys; a=json.load(sys.stdin); assert all(x.get('runtimeArn') for x in a['agents'] if x.get('type')=='runtime'), 'null runtimeArn — config merge clobbered ARNs'; print('config ok')"
```

## Rollback

Not yet automated as a single command — an agent hitting a failed deploy must
report BLOCKED (with the failing output) rather than improvise. Manual
rollback: re-point the Lambda at the prior zip via `update-function-code`,
redeploy the previous image tag via `deploy/ecs-express/deploy.sh`, restore
`config/*.json` from S3 object versions (bucket is versioned). Wrapping this
into `deploy/local/rollback.sh` is the outstanding contract gap.

## Production deploy

The staging section above IS the production deploy (single-account hub).
No separate section; no `auto_promote` — a human approves the merge gate and
the deploy above is the one act it authorizes.
