# DEPLOY.md

Deploy contract for AgentCore Hub (see `docs/DEPLOY-md-contract.md` for the
format). The hub is a three-target deploy: orchestrator Lambda (code only),
config/blueprints to S3, and the Next.js app to ECS Express Mode. The contract
also carries the evaluation-infrastructure targets: eval-packager Lambda,
runtime-agent fleet telemetry, evaluator rubric/config, eval health alarms,
and a one-time scorecard reset. Some files referenced by the evaluation steps
(`deploy/evaluations/*-alarm.json`, the updated `setup-evaluations.sh`,
`lambda/eval-packager/lib/`, …) land with the evaluation-infrastructure PR's
merge commit — the contract runs from a fresh clone of that merge commit.

> **Pipeline mode.** When the CI/CD pipeline module is deployed
> (`deploy/pipeline/`), steps 0-3 below are executed by the
> `agentcore-hub-deploy` CodePipeline (see `docs/pipeline-quickstart.md`) —
> the commands here are the legacy/manual path and remain the contract source
> the pipeline's buildspecs are ported from.

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
- `agentcore` CLI installed (the evaluator/eval-config steps use it)
- `AGENTCORE_ROLE_ARN` and `GATEWAY_ARN` exported (consumed by
  `deploy/runtime-agent/deploy-fleet.sh` / `deploy-one.sh`)
- SNS alert topic, declared by NAME: `agentcore-hub-alerts`. The alarm step
  resolves its ARN at apply time (`aws sns create-topic` is idempotent by
  name); the alarm JSONs intentionally omit `AlarmActions` and no ARN is ever
  hardcoded in this file or those JSONs.

## Required secrets

None resolved by the deploy itself — runtime credentials (Jira, GitHub PAT,
Telegram) already live on the deployed resources' env/Secrets Manager and are
NOT rewritten by the commands below. That is deliberate:

- **Never run `lambda/orchestrator`'s full deploy script without `JIRA_*` env
  set — it rewrites function env vars and would blank prod Jira credentials.**
  The staging deploy below is code-only for exactly this reason.

## Staging deploy

The hub has no separate staging account; "staging" = deploying code-only
targets and verifying before the app rollout completes traffic shift.

```bash
# 0. Workflow command queue (one-time infra; idempotent). Creates the SQS FIFO
#    queue + DLQ + event source mapping onto the orchestrator, and prints the
#    queue URL. Set that URL as WORKFLOW_COMMAND_QUEUE_URL in .env.local BEFORE
#    the ECS app deploy (step below) — without it the webhook route falls back
#    to the legacy direct Lambda invoke (still functional, not serialized).
./scripts/create-command-queue.sh

# 1. Orchestrator Lambda — CODE ONLY (never its deploy.sh; see Required secrets)
#    NEVER `zip -qr .` here: it omits src/config/lease-constants.json (which
#    lease.mjs requires), so the deployed function INIT-crashes on every invoke
#    (Runtime.Unknown) and ALL workflow dispatch stops. Copy the JSON in beside
#    the code and reuse deploy.sh's OWN explicit `zip -rq function.zip ...` file
#    list (same pattern as deploy/pipeline/buildspec-ci.yml — one list, no drift),
#    then validate the built archive with the manifest guard.
cp src/config/lease-constants.json lambda/orchestrator/lease-constants.json
( cd lambda/orchestrator && npm ci --omit=dev )
ZIP_ARGS="$(grep -oE 'zip -rq function\.zip .*' lambda/orchestrator/deploy.sh | sed 's/^zip -rq function\.zip //')"
( cd lambda/orchestrator && zip -rq /tmp/orchestrator.zip $ZIP_ARGS )
rm -f lambda/orchestrator/lease-constants.json
bash scripts/check-lambda-zip-manifest.sh --zip /tmp/orchestrator.zip
aws lambda update-function-code --function-name agentcore-hub-orchestrator \
  --zip-file fileb:///tmp/orchestrator.zip --region "$AWS_REGION"

# 2. Blueprints + prompts + config → S3 artifact bucket
#    (blueprints/prompts are safe to cp; agents.json must be MERGED onto the S3
#    copy — the S3 version carries deploy-injected runtimeArns the repo nulls out)
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

The evaluation-infrastructure steps below have explicit ordering constraints:
the eval-packager (step 4) MUST deploy before the rubric re-registration
(step 6), and the alarms (step 8) come LAST, only after a healthy batch.

Step 4 — eval-packager Lambda, CODE ONLY (mirrors the orchestrator pattern;
never rewrite its env vars — `IMPROVEMENT_AGENT_ARN` etc. live on the
function; the full provisioning path `deploy/continuous-improvement/deploy.sh`
is NOT part of this contract). MUST run before the rubric re-registration in
step 6: the packager must understand NotApplicable verdicts before the first
N/A result arrives.

```bash
# lib/ is mandatory in the zip (index.mjs imports lib/classify.mjs →
# ERR_MODULE_NOT_FOUND without it) and node_modules must be bundled
# (runtime deps like @smithy/signature-v4 aren't in nodejs20.x)
cd lambda/eval-packager && npm ci --omit=dev && \
  zip -qr /tmp/eval-packager.zip index.mjs package.json lib node_modules && cd ../..
aws lambda update-function-code --function-name agentcore-hub-eval-packager \
  --zip-file fileb:///tmp/eval-packager.zip --region "$AWS_REGION"
aws lambda wait function-updated --function-name agentcore-hub-eval-packager --region "$AWS_REGION"
```

Step 5 — runtime-agent fleet redeploy (ships the `main.py` telemetry fixes
F3.1/F3.2). Lightweight direct-code deploy by default;
`DEPLOY_MODE=robust ./deploy-fleet.sh` is the container image build/push path
(`build-and-push.sh` + `deploy-one-robust.py`), needed only per the escalation
in `deploy/runtime-agent/DEPLOY.md` when the CodeZip path delivers no spans.
`deploy-fleet.sh` runs `refresh-agents-json.sh` and the BLOCKING
`verify-fleet.sh` invoke_agent span probe itself — the deploy is not
telemetry-verified until that passes.

```bash
cd deploy/runtime-agent && ./deploy-fleet.sh && cd ../..
```

Step 6 — evaluator rubric re-registration (only AFTER step 4). The full
runbook lives in `deploy/evaluations/setup-evaluations.sh`, above the
`CUSTOM_EVALUATOR` variable — use the `CUSTOM_EVALUATOR` value from that
script (the account-specific ID is deliberately not duplicated here).

```bash
agentcore eval evaluator update --help   # verify the installed CLI exposes the update verb first
agentcore eval evaluator update --evaluator-id "$CUSTOM_EVALUATOR" \
  --config-file deploy/evaluations/dependency_chain_evaluator.json
```

Fallback if the CLI lacks `update`: `agentcore eval evaluator create
--config-file ...` → capture the new ID → set `CUSTOM_EVALUATOR` in
`setup-evaluations.sh` to it → re-run `setup-evaluations.sh` →
`deploy/runtime-agent/refresh-agents-json.sh` → update the
`custom_evaluators` map in `deploy/evaluations/eval-config-ids.json`.

Step 7 — apply the reduced sampling/evaluator load profile
(30% × 5 evaluators):

```bash
./deploy/evaluations/setup-evaluations.sh   # exits non-zero if any per-agent config fails
```

Step 8 — eval health alarms, GATED. Run the observation command first; create
the alarms ONLY if BOTH metrics show a non-zero Sum on the dimensionless
`AgentCoreHub/Evaluations` fleet series over a healthy batch (that series only
exists once the new packager EMF record ships). Otherwise STOP — the step is
not ready, not failed.

```bash
# GATE — observe a healthy batch first (expect a non-zero Sum for BOTH metrics):
for metric in EvalSessionsTotal EvalResultsTotal; do
  aws cloudwatch get-metric-statistics --namespace AgentCoreHub/Evaluations \
    --metric-name "$metric" --statistics Sum --period 86400 \
    --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --query 'Datapoints[].Sum' --output text     # expect: non-zero number(s), not empty
done

# Apply (AlarmActions resolved by topic NAME at apply time — never hardcoded in the JSONs):
ALERT_TOPIC_ARN=$(aws sns create-topic --name agentcore-hub-alerts --query TopicArn --output text)
for alarm in throttle-rate-alarm span-missing-alarm span-missing-elevated-alarm; do
  aws cloudwatch put-metric-alarm \
    --cli-input-json "file://deploy/evaluations/${alarm}.json" \
    --alarm-actions "$ALERT_TOPIC_ARN"
done
```

Step 9 — one-time targeted `dependency_chain` scorecard reset (only AFTER
steps 4 and 6; runbook source: the `deploy/continuous-improvement/backfill-metrics.sh`
header). Do NOT re-run `backfill-metrics.sh` for this — SET-overwrite
semantics plus its 500-event cap would destroy healthy evaluators' history,
and false-positive 0.0s aren't reconstructible from logs anyway. The
`evalScores` map key is the BARE evaluator name (no `-XXXX` id suffix); the
REMOVE is a safe no-op where the key is absent; the packager re-initializes a
missing key to `{sum:0,count:0}` on the next delivery.

```bash
for agent in agentcore_hub_requirements_analyst agentcore_hub_qa_verifier agentcore_hub_ci_agent; do
  aws dynamodb update-item \
    --table-name agentcore-hub-eval-config \
    --key "{\"agentId\":{\"S\":\"$agent\"}}" \
    --update-expression 'REMOVE evalScores.#e' \
    --expression-attribute-names '{"#e":"dependency_chain_compliance_online"}'
done
```

## Smoke checks

```bash
# App is serving (DEPLOYMENT_URL is written to .env.local by the ECS deploy)
curl -sf "$DEPLOYMENT_URL/api/agentcore/traces/health"        # expect HTTP 200

# Orchestrator lambda healthy on the new code
aws lambda get-function --function-name agentcore-hub-orchestrator \
  --query 'Configuration.[State,LastUpdateStatus]' --output text  # expect: Active Successful

# Orchestrator actually RUNS on the new code (get-function State reads Active
# even when the function INIT-crashes — a test invoke is the only real check)
aws lambda invoke --function-name agentcore-hub-orchestrator \
  --payload "$(echo '{}' | base64)" /tmp/orchestrator-smoke.json \
  --query 'FunctionError' --output text                            # expect: None (any FunctionError = INIT-crash class)

# Command queue wired (R1): mapping enabled, DLQ empty
aws lambda list-event-source-mappings --function-name agentcore-hub-orchestrator \
  --query 'EventSourceMappings[?contains(EventSourceArn, `workflow-commands`)].State' \
  --output text                                                    # expect: Enabled
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name agentcore-hub-workflow-commands-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text   # expect: 0

# Config landed with ARNs intact (never null after a merge)
aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" - | \
  python3 -c "import json,sys; a=json.load(sys.stdin); assert all(x.get('runtimeArn') for x in a['agents'] if x.get('type')=='runtime'), 'null runtimeArn — config merge clobbered ARNs'; print('config ok')"

# Eval-packager lambda healthy on the new code
aws lambda get-function --function-name agentcore-hub-eval-packager \
  --query 'Configuration.[State,LastUpdateStatus]' --output text   # expect: Active Successful

# Updated custom evaluator registered (not UPDATE_FAILED)
AGENTCORE_SUPPRESS_RECOMMENDATION=1 agentcore eval evaluator list --max-results 100 \
  | grep dependency_chain_compliance_online          # expect: the evaluator listed, status READY

# Eval configs applied at the reduced profile
agentcore eval online list                           # expect: one eval_<agent> config per fleet agent, none failed

# Alarms exist and are evaluating (only after step 8's gate passed)
aws cloudwatch describe-alarms \
  --alarm-names agentcore-hub-eval-throttle-ratio agentcore-hub-eval-span-missing-ratio agentcore-hub-eval-span-missing-elevated \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text    # expect: 3 rows, each OK or INSUFFICIENT_DATA

# Polluted scorecard key removed
aws dynamodb get-item --table-name agentcore-hub-eval-config \
  --key '{"agentId":{"S":"agentcore_hub_requirements_analyst"}}' \
  --projection-expression 'evalScores.#e' \
  --expression-attribute-names '{"#e":"dependency_chain_compliance_online"}' \
  --output json                                      # expect: empty Item / no dependency_chain_compliance_online key
```

## Rollback

In pipeline mode, `deploy/pipeline/rollback.sh` now exists and runs
automatically on a Deploy-stage failure (pre_build snapshots the current
orchestrator zip + ECS image; the failure path restores both). The manual path
below remains for legacy mode.

Legacy mode is not yet automated as a single command — an agent hitting a failed
deploy must report BLOCKED (with the failing output) rather than improvise.
Manual rollback: re-point the Lambda at the prior zip via `update-function-code`,
redeploy the previous image tag via `deploy/ecs-express/deploy.sh`, restore
`config/*.json` from S3 object versions (bucket is versioned). For the
evaluation targets: re-point the eval-packager at the prior zip via
`update-function-code` (same pattern as the orchestrator); for the rubric,
`git show <old-sha>:deploy/evaluations/dependency_chain_evaluator.json > /tmp/rubric.json`,
then re-register via the same update/create procedure in
`setup-evaluations.sh` — the packager tolerates a rubric without N/A
indefinitely, so rubric rollback needs no packager rollback; alarms:
`aws cloudwatch delete-alarms --alarm-names ...` (safe, unconditional); the
scorecard REMOVE is not reversible and doesn't need to be — the packager
re-creates the key at `{sum:0,count:0}` on the next delivery; runtime agents:
redeploy the previous commit via `deploy-fleet.sh`. The app-target rollback gap
is closed by `deploy/pipeline/rollback.sh` in pipeline mode; a single-command
legacy-mode wrapper (`deploy/local/rollback.sh`) is the remaining contract gap.

## Production deploy

The staging section above IS the production deploy (single-account hub).
No separate section; no `auto_promote`. Production is a **two-gate** model:
the human merge gate authorizes the *merge*; the in-pipeline ManualApproval
deploy gate (bridged to Telegram Approve/Reject buttons) authorizes the
*deploy* of the artifacts the Build stage already produced. In legacy mode
(no pipeline) the merge gate remains the single act that authorizes the
deploy above.

## Model bump

One-off runbook for rotating the pinned Claude model ids fleet-wide (e.g.
TEAM-3849/3851). NOT part of the routine staging deploy above and not run on
every merge — run this section top to bottom, in order, whenever
`src/lib/models/harness-models.json` / `CODING_MODEL_TIERS` / persona env
defaults change. Several independent deploy targets carry a model id; the order
below avoids a window where the orchestrator, harnesses, and runtimes disagree
about which id is current. The custom eval judge (step 7) is out-of-band — it
scores after the fact, so it goes last and is not part of the disagreement
window.

1. Orchestrator Lambda, code only — identical command to staging step 1 above
   (explicit `zip -rq` file list ported from `deploy.sh`; **never** `zip -qr .`
   — it drops `src/config/lease-constants.json` and the function INIT-crashes
   on every invoke thereafter). Verify with a real test invoke, not just
   `get-function` (which reports `Active` even mid-INIT-crash):
   ```bash
   aws lambda invoke --function-name agentcore-hub-orchestrator \
     --payload "$(echo '{}' | base64)" /tmp/orchestrator-smoke.json \
     --query 'FunctionError' --output text   # expect: None
   ```

2. Blueprints/prompts → S3; `agents.json` MERGED onto the S3 copy (identical
   command to staging step 2 — the S3 copy carries deploy-injected
   `runtimeArn`s that the repo's own copy nulls out). Verify the merge didn't
   clobber ARNs:
   ```bash
   aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" - | \
     python3 -c "import json,sys; a=json.load(sys.stdin); assert all(x.get('runtimeArn') for x in a['agents'] if x.get('type')=='runtime'), 'null runtimeArn — config merge clobbered ARNs'; print('config ok')"
   ```

3. Next.js app → ECS Express Mode (identical command to staging step 3):
   ```bash
   ./deploy/ecs-express/deploy.sh
   ```

4. Harness personas — Workflow Manager, builder, routine builder. Each setup
   script now updates an EXISTING harness's model in place (previously WM/builder
   ignored the model on re-run and routine-builder did nothing at all — a silent
   no-op that left the live harness on its old pin), so re-running is enough:
   ```bash
   # WM: BLOCKING smoke — a chat turn's post-tool-call text must stream live,
   # not arrive as one frozen blob at the end. If the new model buffers,
   # re-run with --model-id us.anthropic.claude-opus-5 rather than shipping a
   # regressed CHAT drawer.
   node deploy/workflow-manager/setup-workflow-manager.mjs

   # Builder — pin explicitly rather than trusting the script's baked-in default:
   node deploy/setup-builder-agent.mjs --model-id us.anthropic.claude-sonnet-5

   # Routine builder — pin explicitly (baked-in default is opus-5):
   node deploy/routine-builder/setup-routine-builder.mjs --model-id us.anthropic.claude-opus-5
   ```
   `UpdateHarness`'s memory attachment needs the `optionalValue` wrapper; the
   `model` field does not — don't copy that wrapper onto the model update by
   reflex.

   Verify each harness is CONFIGURED on the new id (a green setup run only
   proves the invoke succeeded, not that the pin changed). `GetHarness` reads
   back the live model:
   ```bash
   for h in agentcore_hub_workflow_manager agentcore_hub_builder agentcore_hub_routine_builder; do
     id=$(aws bedrock-agentcore-control list-harnesses \
       --query "harnesses[?harnessName=='$h'].harnessId | [0]" --output text)
     model=$(aws bedrock-agentcore-control get-harness --harness-id "$id" \
       --query 'harness.model.bedrockModelConfig.modelId' --output text)
     echo "$h -> $model"   # expect: WM=fable-5-1, builder=sonnet-5, routine-builder=opus-5
   done
   ```

5. Coding-agent runtime — rebuild and deploy with both env vars pinned
   explicitly on the command line (don't rely on the script's baked-in
   default matching what you intend):
   ```bash
   ANTHROPIC_MODEL=us.anthropic.claude-fable-5-1 CLAUDE_MODEL=us.anthropic.claude-fable-5-1 \
     python3 deploy/coding-agent-runtime/deploy.py
   ```

6. Shared fleet runtime — LAST, only once every other target above is
   confirmed on the new id (same pinning):
   ```bash
   ANTHROPIC_MODEL=us.anthropic.claude-fable-5-1 CLAUDE_MODEL=us.anthropic.claude-fable-5-1 \
     ./deploy/runtime-agent/deploy-fleet.sh
   ```
   `UpdateAgentRuntime` REPLACES `env` / `filesystemConfigurations` / `lifecycle`
   wholesale on every call — read back the current `MEMORY_ID`, EFS mount, and
   lifecycle config first and pass them through unchanged, or a "just bump the
   model" deploy silently drops the EFS mount.

7. Custom eval judge — out-of-band, editing
   `deploy/evaluations/dependency_chain_evaluator.json` alone changes NOTHING in
   the account (`setup-evaluations.sh` only PROBES for the evaluator id, it never
   creates or updates it). After the JSON's `modelId` is bumped, roll the change
   to the live evaluator explicitly (verify the exact verb against your installed
   CLI — `agentcore eval evaluator update --help` — the fallback is create + swap
   `CUSTOM_EVALUATOR`; full procedure in `deploy/evaluations/setup-evaluations.sh`
   "Re-registering a corrected evaluator rubric"):
   ```bash
   agentcore eval evaluator update \
     --evaluator-id dependency_chain_compliance_online-mbLh2kEFhw \
     --config-file deploy/evaluations/dependency_chain_evaluator.json
   # Verify the live evaluator now reports the new judge model. The exact
   # get/describe verb varies by CLI version (run `agentcore eval evaluator
   # --help`); confirm the returned config's
   # llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig.modelId is
   # us.anthropic.claude-opus-5, not a pre-bump id.
   ```

### Post-deploy smoke (model bump)

```bash
# New model id shows up in spans on BOTH the shared fleet and coding runtimes
QUERY_ID=$(aws logs start-query --log-group-name aws/spans \
  --start-time "$(date -u -d '30 minutes ago' +%s 2>/dev/null || date -u -v-30M +%s)" \
  --end-time "$(date -u +%s)" \
  --query-string 'fields `attributes.gen_ai.request.model` as model, `resource.attributes.service.name` as svc | filter model like /fable-5-1|opus-5|sonnet-5/ | stats count() by model, svc' \
  --query 'queryId' --output text)
sleep 5 && aws logs get-query-results --query-id "$QUERY_ID"   # expect: rows for the new ids, none for pre-bump ids

# WM: a chat turn succeeds AND streams post-tool text live (manual check in
# the CHAT drawer — no automated proxy for "did it stream" exists yet)

# Builder answers a one-turn prompt
curl -sf -X POST "$DEPLOYMENT_URL/api/agentcore/builder" \
  -H 'Content-Type: application/json' -d '{"prompt":"say hello"}'   # expect: HTTP 200, non-empty reply

# Dashboard cost still resolves for a PRE-bump run (retained src/config/pricing.json rows)
curl -sf "$DEPLOYMENT_URL/api/evaluations" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print('cost ok' if d.get('agents') else 'no data')"

# Codex still invokes (Bedrock Mantle path — openai.gpt-5.5 is untouched by this bump)
```
