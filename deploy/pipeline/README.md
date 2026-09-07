# CI/CD Pipeline module (bolt-on)

AWS-native CI/CD for a repo the hub cares about (pilot: the hub's own repo).
**Entirely optional** — a forker who never runs `deploy.sh` here gets the hub
with no pipeline, and the app still passes `npx tsc --noEmit` + `npm run build`.

Design + rationale: [`docs/cicd-pipeline-module-design.md`](../../docs/cicd-pipeline-module-design.md).

## What it stands up

```
GitHub PR push ─► CodeBuild "agentcore-hub-ci"  ─► required commit status ─► branch protection
merge to main ─► CodePipeline "agentcore-hub-deploy":
                   Source → Build → ManualApproval(SNS) → Deploy
```

- **CI CodeBuild** runs `buildspec-ci.yml`: `tsc --noEmit`, `lint`, `build`,
  `test`, the `check-lambda-zip-manifest.sh` hard gate, and a dep scan. Red = no
  merge. This is the deterministic work the CI agent used to shell out.
- **Deploy CodePipeline** builds ONCE (Build stage emits the orchestrator zip +
  app image by digest) and the Deploy stage promotes those exact artifacts via
  `buildspec-deploy.yml` — the machine form of `DEPLOY.md`'s **app** targets
  (Lambda code + S3 config + ECS roll), run under a narrow IAM role that
  **cannot** rewrite orchestrator config (so it cannot blank prod Jira creds).

### Scope: everything code-only; runtime images + infra are a handoff

The Deploy stage is driven by `surfaces.json` (the deploy-surface manifest) via
`plan-surfaces.py`: from the merge's changed files it plans which Lambdas to
re-zip and `update-function-code`, which S3 toolkits/skills/config to sync, and
which harness prompts/models to `UpdateHarness` (each harness's own setup script
run with `PIPELINE_MODE=1`). Live code and harness config are snapshotted first;
`rollback.sh` restores them on any failure. `scripts/check-deploy-surfaces.sh`
(CI gate) fails when a file under `lambda/` or `deploy/` is covered by no
manifest entry, so a new surface cannot silently fall outside the pipeline.

What the narrow Deploy role deliberately cannot do stays a **handoff**: runtime
images (`deploy/runtime-agent/`, `deploy/coding-agent-runtime/`) and infra
scripts (IAM, env vars, tables, subscriptions — every `deploy.sh` / `setup-*`).
When a merge touches those, the Deploy stage **deploys everything it can,
advances the baseline SHA, then fails the action as a terminal non-rollback
handoff** listing the files — the release manager reports it, a human runs the
owning script (DEPLOY.md maps path → command). Blocking before the deploy would
wedge the pipeline: the baseline only advances on a successful deploy, so the
same commit range would re-block forever. Runtime-image CD is the next
increment.

## Files

| File | Role |
| --- | --- |
| `bin/pipeline.ts` | CDK app entrypoint (env-driven; hardcodes nothing) |
| `lib/pipeline-stack.ts` | the stack: CodeConnections, CI + Build + Deploy CodeBuild, CodePipeline, SNS approval, scoped IAM, cdk-nag |
| `buildspec-ci.yml` | PR check AND the deploy Build stage (gates + artifact emission) |
| `buildspec-deploy.yml` | Deploy stage: the 3-target `DEPLOY.md`, promote-by-digest, smoke checks |
| `merge-agents-json.py` | the agents.json merge (extracted from `DEPLOY.md` step 2 — single source) |
| `ecs-primary-container.py` | builds the ECS roll container JSON, reusing live env, swapping image→digest |
| `ecs-health.py` | parses `describe-express-gateway-service` → status + ingress URL for the rollout health poll |
| `rollback.sh` | on any Deploy-phase failure, restores the prior orchestrator zip + ECS image (snapshotted pre-deploy) |
| `deploy.sh` | idempotent `cdk deploy` wrapper (sources `deploy/config.sh` for the account guard) |

## Deploy

```bash
PIPELINE_GITHUB_OWNER=<gh-owner> ./deploy/pipeline/deploy.sh          # cdk deploy
PIPELINE_GITHUB_OWNER=<gh-owner> ./deploy/pipeline/deploy.sh diff     # cdk diff only
```

Env (all optional except the owner; defaults derive from `deploy/config.sh`):

| Var | Default | Meaning |
| --- | --- | --- |
| `PIPELINE_GITHUB_OWNER` | `GITHUB_OWNER` | GitHub org/user that owns the repo |
| `PIPELINE_GITHUB_REPO` | `agentcore-hub` | repo to build |
| `PIPELINE_BRANCH` | `main` | deploy trigger branch |
| `PIPELINE_CONNECTION_ARN` | (mint new) | reuse an existing CodeConnections link |
| `ECS_SERVICE_ARN` | (skip app roll) | the ECS Express service the Deploy stage rolls |
| `PIPELINE_APPROVAL_SNS_ARN` | (mint new) | reuse an SNS topic (e.g. Telegram-bridged) |
| `PIPELINE_APPROVAL_EMAILS` | — | comma-separated email approvers |
| `PIPELINE_CI_WEBHOOK` | off | `1` enables the CodeBuild PR-check webhook + commit status. PREREQ: the CodeConnections GitHub App must be installed on the repo WITH webhook permission — a repo-level step done AFTER the OAuth handshake in "One-time after first deploy" below. Without it, `CreateWebhook` fails the deploy. See "Runbook: CodeBuild-certified CI for PRs (TEAM-4258)" below. |
| `PIPELINE_CI_START_BUILD` | off | `1` grants the pipeline-tools Lambda `codebuild:StartBuild` on the CI project ONLY (via `node deploy/setup-pipeline-tools-lambda.mjs`, NOT this CDK stack). The fallback for when the webhook cannot be installed: agents can trigger CI builds themselves, bounded by `concurrentBuildLimit` on the CI project and the calling agent's poll cap. See "Runbook: CodeBuild-certified CI for PRs (TEAM-4258)" below. |

### One-time after first deploy

1. **Complete the CodeConnections handshake** (if the link was freshly minted):
   AWS console → Developer Tools → Connections → `agentcore-hub-*` → *Update
   pending connection* → install/authorize on the GitHub org. Until done, the
   PR webhook and Source action cannot reach GitHub.
2. **Enable branch protection** on `main`: require the `agentcore-hub-ci` status
   check + ≥1 approval (GitHub repo settings). This is what makes CI a real
   gate.
3. **Flip the fleet + UI on** (optional, when ready to re-scope agents):
   - App/UI: set `NEXT_PUBLIC_PIPELINE_ENABLED=1` (shows the `/pipeline` tab).
   - Blueprints: set `PIPELINE_ENABLED=1` on the fleet/orchestrator context —
     the CI, QA, and release-manager blueprints then read pipeline results
     instead of shelling builds. Unset → they behave exactly as before.
     Then register the repo this pipeline deploys in the hub's **CD registry**
     with its pipeline name (`scripts/cd-registry.sh add owner/repo --pipeline
     agentcore-hub-deploy --region us-east-1`, or Workflow tab → CD registry…).
     Pipeline Mode is emitted only for a registered repo whose entry names a
     pipeline; a repo that is not registered at all is a HANDOFF (the run ends
     with an open PR — the hub never merges or deploys it).

## Runbook: CodeBuild-certified CI for PRs (TEAM-4258)

**Symptom.** A `PIPELINE_ENABLED` run's CI agent never reports
`ci_status="certified"`. Instead: `Pipeline___capabilities` →
`startCiBuild: false`; `Pipeline___start_ci_build` → `reason:
"start_build_not_granted"`; `Pipeline___get_build_status(commit_sha=<head>)` →
no build for the head SHA. Per `blueprints/ci-agent.md` the agent then degrades
to `ci_status="github-actions-proxy"` and a **BLOCKED** verdict — a green
GitHub Actions check-run is not CodeBuild certification, so the
`scripts/check-lambda-zip-manifest.sh` gate in `buildspec-ci.yml` is only ever
proven on a developer's laptop.

**Diagnosis.** Both opt-in paths to a CodeBuild PR check are off:

| Check | Command | Off looks like |
| --- | --- | --- |
| PR webhook (CDK) | `aws codebuild batch-get-projects --names agentcore-hub-ci --query 'projects[0].webhook'` | `null` |
| Build history | `aws codebuild list-builds-for-project --project-name agentcore-hub-ci` then `batch-get-builds --ids ...` | every `sourceVersion` is a branch name, none is `pr/<n>` |
| StartBuild grant (Lambda role) | `aws iam get-role-policy --role-name agentcore-hub-pipeline-tools-role --policy-name inline --query 'PolicyDocument.Statement[].Sid'` | no `CiStartBuild` Sid |

Both are **human handoffs** (`DEPLOY.md` → "Handed off"): they change IAM and
CDK-managed infra, which the pipeline's narrow Deploy role and the agents
deliberately cannot touch.

### Remedy 1 — grant the tools Lambda StartBuild (recommended; no GitHub App change)

```bash
PIPELINE_CI_START_BUILD=1 \
EXPECTED_ACCOUNT_ID=<prod-account-id> \
AWS_PROFILE=<prod> \
node deploy/setup-pipeline-tools-lambda.mjs
```

`EXPECTED_ACCOUNT_ID` is the account guard — set it and the script aborts before
any write if the profile resolves elsewhere. The script is idempotent and
validates `CI_PROJECT` (`validateCiProjectName`) before any AWS call: the grant
is `codebuild:StartBuild` on the one PR-check project ARN, never the
build/deploy/runtime-image project, never a wildcard.

Verify, in order:

```bash
# 1. IAM: CiStartBuild exists and is scoped to project/agentcore-hub-ci only
aws iam get-role-policy --role-name agentcore-hub-pipeline-tools-role \
  --policy-name inline \
  --query "PolicyDocument.Statement[?Sid=='CiStartBuild']"
# expect: Action ["codebuild:StartBuild"], Resource
#         arn:aws:codebuild:us-east-1:<acct>:project/agentcore-hub-ci  (that ARN only)

# 2. Function env carries the flag (this is what capabilities reads)
aws lambda get-function-configuration --function-name agentcore-hub-pipeline-tools \
  --query Environment.Variables
# expect: PIPELINE_CI_START_BUILD=1

# 3. Tool-level: capabilities advertises it
aws lambda invoke --function-name agentcore-hub-pipeline-tools \
  --payload "$(printf '%s' '{"name":"Pipeline___capabilities","arguments":{}}' | base64)" \
  /tmp/caps.json >/dev/null && cat /tmp/caps.json
# expect: startCiBuild: true
```

4. End to end: on the next `PIPELINE_ENABLED` run, the CI agent's
   `Pipeline___start_ci_build` produces a build whose `resolvedSourceVersion`
   equals the PR head SHA, and `Pipeline___get_build_status(commit_sha=<head>)`
   returns `succeededForCommit: true` → `ci_status="certified"`.

### Remedy 2 — install the PR webhook (optional; makes the check automatic)

Prereq (repo-level, beyond the OAuth handshake): install the CodeConnections
GitHub App on the repo **with webhook permission**. Without it `CreateWebhook`
fails the cdk deploy.

```bash
PIPELINE_CI_WEBHOOK=1 PIPELINE_GITHUB_OWNER=<owner> ./deploy/pipeline/deploy.sh diff
PIPELINE_CI_WEBHOOK=1 PIPELINE_GITHUB_OWNER=<owner> ./deploy/pipeline/deploy.sh
```

Verify:

```bash
aws codebuild batch-get-projects --names agentcore-hub-ci \
  --query 'projects[0].webhook'
# expect filterGroups for PULL_REQUEST_CREATED / PULL_REQUEST_UPDATED /
# PULL_REQUEST_REOPENED (and buildType/reportBuildStatus set)
```

Then push a commit to a PR head: a build appears with `sourceVersion` `pr/<n>`
and `resolvedSourceVersion` == the head SHA, with **no** console or agent
action. Enable it as a required status check in branch protection.

### Footguns — both flags are sticky by convention only

Neither flag is persisted anywhere: each script reads it from the environment on
every run and rewrites the resource unconditionally.

- **`deploy/pipeline/deploy.sh` without `PIPELINE_CI_WEBHOOK=1` removes an
  installed webhook.** The stack sets `webhook: false` / `reportBuildStatus:
  false` and omits `webhookFilters`, so CDK diffs the webhook away and the
  required check silently stops running. Every future run of this script must
  keep `PIPELINE_CI_WEBHOOK=1`.
- **`deploy/setup-pipeline-tools-lambda.mjs` without `PIPELINE_CI_START_BUILD=1`
  revokes the grant.** The script `PutRolePolicy`s the *entire* `inline` policy,
  so an unset flag simply omits the `CiStartBuild` statement — no error, and
  `startCiBuild` flips back to `false` on the next cold start. Every future run
  must keep `PIPELINE_CI_START_BUILD=1`.

Both are recorded in `DEPLOY.md`'s "Handed off" table for whoever runs the
handoff next.

## Removing / not using it

Do nothing. Don't run `deploy.sh`. Leave `NEXT_PUBLIC_PIPELINE_ENABLED` and
`PIPELINE_ENABLED` unset. The `/pipeline` nav entry stays hidden, the blueprints
run their legacy self-build path, and the CDK stack is never created. To fully
remove the surface, delete the `pipeline` entries from `src/config/modules.ts`,
`src/app/pipeline/`, `src/app/api/pipeline/`, `src/lib/pipeline/`, and this
directory (see `docs/MODULES.md`).
