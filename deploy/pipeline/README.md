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

### Scope: app pipeline only (this pilot)

The hub splits into two independently-deployable components with different blast
radius + IAM, so they get **separate pipelines from this same parameterized
stack**:
- **App pipeline (here):** Lambda + S3 config + ECS. Narrow role.
- **Fleet + eval pipeline (follow-up):** the 14 runtime agents + evaluator config
  + alarms + eval-packager (DEPLOY.md steps 4-9). Its own broader-but-isolated
  role, secrets, and `agentcore` CLI.

If a merge touches fleet/eval files (`deploy/runtime-agent/`, `blueprints/`,
`deploy/evaluations/`, `lambda/eval-packager/`), the app pipeline's Deploy stage
**BLOCKS in pre_build before any prod mutation** — a human runs DEPLOY.md steps
4-9 (the documented handoff), never a silent skip.

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

## Removing / not using it

Do nothing. Don't run `deploy.sh`. Leave `NEXT_PUBLIC_PIPELINE_ENABLED` and
`PIPELINE_ENABLED` unset. The `/pipeline` nav entry stays hidden, the blueprints
run their legacy self-build path, and the CDK stack is never created. To fully
remove the surface, delete the `pipeline` entries from `src/config/modules.ts`,
`src/app/pipeline/`, `src/app/api/pipeline/`, `src/lib/pipeline/`, and this
directory (see `docs/MODULES.md`).
