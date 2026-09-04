# CI/CD Pipeline Module — Design Spec

Status: **IMPLEMENTED — pipeline live.** Pilot target: the hub's own repo
(`agentcore-hub`). This doc defines the module boundary, the AWS-native
pipeline, the buildspecs that port `DEPLOY.md`, and how three agent
blueprints re-scope now that a real pipeline owns the deterministic work.

See [Pipeline quickstart](pipeline-quickstart.md) for the short operator-facing walkthrough.

---

## 1. Why this exists (the problem)

Today the SDLC fleet runs deterministic build/test/deploy work *inside* agent
runtimes:

- **CI agent** shells `npx tsc --noEmit && npm run build && npm test` through
  `claude_code` on the coding runtime.
- **QA verifier** re-runs the same `tsc`/`build`/`test` before its semantic checks.
- **Release manager (CD ticket)** executes `DEPLOY.md` step-by-step via
  `claude_code`, on a laptop-equivalent shell, with prod creds.

That is the root of the recurring CI pain and the class of failure that took the
orchestrator down (a deploy zip that omitted `lease-constants.json` →
INIT-crash): **a deterministic job run in a nondeterministic place** — gateway
polling, 15-min idle kills, silent session death, shell drift, hand-typed zip
commands. Enterprises never let a human or an agent be the *runner*. The SCM
triggers a machine, the machine enforces, and humans/agents only author, judge,
and react.

### The reframe

The "CI agent" conflates two jobs. Only one belongs to an agent.

| Job | Today | Belongs in |
| --- | --- | --- |
| **Run** build/test/lint/manifest-check/scan | CI agent shells out → flaky | **CodeBuild** (hermetic, deterministic) |
| **Judge / triage / fix** a red build | CI agent | **Agent** — as a *reactive fixer*, not a runner |

The build is not a judgment call — same bytes every time. That is the textbook
definition of CI, and exactly what an agent is worst at.

---

## 2. Enterprise gate mapping (target state)

| Gate | Enterprise owner | Agent today | New owner |
| --- | --- | --- | --- |
| Compile / unit+integration / lint / type-check | Automated CI (required check) | CI agent (runs) | **CodeBuild PR-check** → required status → branch protection blocks merge |
| SAST / dep-scan / IaC policy scan | Automated CI | (none) | **CodeBuild PR-check** (`npm audit`, semgrep, `cdk-nag`) |
| Lambda-zip manifest integrity | (none — this is why the orchestrator crashed) | (none) | **CodeBuild PR-check** hard gate (`scripts/check-lambda-zip-manifest.sh`) |
| Adversarial diff review | Senior engineer (judgment) | code-reviewer | **KEEP unchanged** — a pipeline cannot do this |
| Acceptance / exploratory / live-integration / visual | QA engineer (judgment) + regression suite | QA verifier (runs + judges) | **KEEP, re-scoped** — reads CI result, owns semantic/PRD/visual/live |
| Merge approval | Code owner | human merge gate | **KEEP** (already human) |
| Build artifact + deploy staging→prod | Automated CD pipeline | RM shells `DEPLOY.md` | **CodePipeline** deploy stage runs it under an IAM role; RM opens PR + writes Merge Brief only |

Net effect on the fleet:

- **CI agent** stops being a runner → becomes a thin **CI-fixer** (reads red
  CodeBuild logs; auto-remediates whitelisted mechanical failures itself — see
  §11 — and files grouped fix tickets for logic failures). The CI phase stays in
  `workflows.json`. *(Decision: keep as thin CI-fixer.)*
- **QA verifier + code-reviewer** stay — they are the judgment layer.
- **Release manager** stops shelling `DEPLOY.md`; the CD ticket **triggers and
  reports a CodePipeline execution** instead.
- The lease-constants class of bug is gone by construction: the manifest check
  and the zip both run in a hermetic CodeBuild container, gated before merge.

---

## 3. Why AWS-native, and which services

Requirement: AWS-centric repo → build it the way a pure-AWS shop would. GitHub
Actions is free for public repos but is not AWS-native and can't emit into the
account's own observability. AWS-native primitives:

| Concern | Service |
| --- | --- |
| SCM link (GitHub → AWS, no PAT) | **CodeConnections** (formerly CodeStar Connections), one org-level GitHub App link |
| Deterministic build/test/scan | **CodeBuild** (Linux standard image for TS/Lambda; the existing macOS fleet for iOS) |
| Orchestrated deploy w/ approval | **CodePipeline** — Source → Build → ManualApproval → Deploy |
| Approval notification | **Telegram bridge** (poll-based, in `telegram-bug-intake` — see §5; SNS kept as email fallback) |
| Provenance / integrity | build-once, promote-by-digest (ECR image digest + Lambda zip S3 version) |

Cost: CodeBuild ~$0.005/min (general1.small Linux), CodePipeline $1/active
pipeline/month, CodeConnections free, SNS negligible. A hub deploy is a handful
of build-minutes — dollars/month, versus GitHub Actions being "free" only for
public repos and blind to the AWS account.

---

## 4. Module boundary (the modular contract)

CI/CD is a **bolt-on module**, exactly like Workflow / Evaluations / Cloud Code.
A forker who never enables it gets the hub with zero pipeline, and the app still
passes `npx tsc --noEmit` + `npm run build`. Four independent layers, one enable
flag:

| Layer | Location | Opt-out |
| --- | --- | --- |
| **CDK pipeline stack** (CodePipeline/CodeBuild/CodeConnections/SNS) | `deploy/pipeline/` — self-contained, own `cdk deploy` entrypoint, imports nothing from `src/` | Don't run it |
| **buildspecs** (`buildspec-ci.yml`, `buildspec-deploy.yml`) | `deploy/pipeline/` | Inert without the stack |
| **UI/API surface** (pipeline status / trigger / approvals in-console) | optional module `pipeline` in `src/config/modules.ts`, routes under `src/app/pipeline/` + `src/app/api/pipeline/` | Flip the module out (one-place edit) |
| **Agent re-scoping** (CI-fixer / QA / RM read pipeline results) | blueprints, gated behind `PIPELINE_ENABLED` | Unset the flag → blueprints fall back to today's shell-out behavior |

New `ModuleId`: `"pipeline"`. New nav entry (display order, after Cloud Code):
`{ href: "/pipeline", label: "Pipeline", icon: <Workflow/Rocket>, module: "pipeline" }`.

Enable flag: `PIPELINE_ENABLED` (env, forwarded to the ECS container and read by
blueprints via the orchestrator context). Absent/`0` → module hidden, blueprints
behave exactly as today. This is the whole opt-out.

### Pipelines are split by independently-deployable component

> **Status (2026-09-04):** the app pipeline's Deploy stage now covers every
> *code* surface, not just the three app targets — see
> `deploy/pipeline/surfaces.json` (manifest), `plan-surfaces.py` (planner) and
> `scripts/check-deploy-surfaces.sh` (CI gate: every `lambda/*` and `deploy/*`
> file must be a surface, a handoff, or explicitly excluded). What remains a
> handoff is exactly what the narrow role cannot do: runtime images and infra
> scripts (IAM/env/tables). The "fleet + eval pipeline" below therefore shrinks
> to an image-build-and-`UpdateAgentRuntime` increment.

The hub is not one deployable — it is an **app** (Next.js + orchestrator Lambda +
`config/*`) and a **fleet + eval-infra** (14 runtime agents + evaluator config +
alarms + eval-packager, i.e. DEPLOY.md steps 4-9). These have different blast
radius, cadence, secrets, and IAM. Coupling them into one deploy forces one role
to hold everything — the least-privilege violation that surfaced repeatedly in
review. So they get **separate pipelines from the same parameterized CDK stack**:

- **App pipeline (this pilot).** Deploys Lambda code + S3 config + ECS roll.
  Narrow role: `lambda:UpdateFunctionCode` (+ waiter read), S3 on the artifact
  bucket, `ecs:UpdateExpressGatewayService`. Triggered by `src/`,
  `lambda/orchestrator/`, `deploy/ecs-express/`, `src/config/*.json`. A changeset
  that also touches fleet/eval files **deploys the app targets, advances the
  baseline SHA, then fails the action as a terminal non-rollback handoff** — a
  human runs DEPLOY.md steps 4-9 (the documented deploy-contract handoff), never
  a silent skip. (See §6 for why the deploy-then-signal ordering is deliberate.)
- **Fleet + eval pipeline (follow-up).** A second `cdk deploy` of the same stack
  with `{component: "fleet-eval"}`: its own buildspec, its own broader-but-
  isolated role (AgentCore control-plane, fleet-role PassRole, GitHub/MCP secrets
  from Secrets Manager, the `agentcore` CLI in its build image), triggered by
  `deploy/runtime-agent/`, `blueprints/`, `deploy/evaluations/`,
  `lambda/eval-packager/`. Deploys DEPLOY.md steps 4-9 with the ordering the
  contract requires.

Then **(b)**, the longer play: the fleet stands up this same parameterized stack
in the *target repos* it builds features for — a templating pass, not a rewrite.

Enable flags: `NEXT_PUBLIC_PIPELINE_ENABLED` (build-time; shows the `/pipeline`
nav tab) and `PIPELINE_ENABLED` (fleet/orchestrator context; blueprints read
pipeline results instead of shelling builds). Both unset → module hidden,
blueprints behave exactly as today. That is the whole opt-out.

---

## 5. Pipeline topology (pilot = hub repo)

```
GitHub: tycenjmccann/agentcore-hub
   │
   │  (CodeConnections GitHub App link — no PAT)
   │
   ├── on PR push ──────────────► CodeBuild: agentcore-hub-ci
   │                               buildspec-ci.yml
   │                               → posts a required commit status
   │                               → branch protection on `main` blocks merge if red
   │
   └── after merge to main ────► CodePipeline: agentcore-hub-deploy (APP pipeline)
        (RM: Pipeline___start_deploy — push trigger not wired; see below)
                                   ├─ Source   (CodeConnections, main)
                                   ├─ Build    buildspec-ci.yml again (build-once)
                                   │           → artifacts: orchestrator.zip (+ digest),
                                   │             ECR image (by digest)
                                   ├─ Approval  ManualApproval → Telegram (poll bridge)
                                   └─ Deploy   buildspec-deploy.yml
                                               (Lambda code + S3 config + ECS roll,
                                                promote-by-digest; fleet/eval change
                                                → deploy app targets, advance baseline,
                                                  then FAIL as a terminal handoff to
                                                  the fleet+eval pipeline)
```

- **Approval notification (as implemented):** a **poll-based Telegram bridge**,
  not SNS. The `telegram-bug-intake` poller calls `GetPipelineState`, detects a
  ManualApproval action awaiting a decision, atomically claims the approval
  token in DynamoDB (so exactly one ping fires), and sends Approve / Reject
  inline buttons whose taps map to `PutApprovalResult`. Gated by
  `DEPLOY_PIPELINE_NAME` on that Lambda — unset makes the whole path a no-op.
  (The CDK stack still provisions an SNS topic as an email fallback.)
- **Merge does NOT auto-trigger the pipeline — the agent-owned trigger
  contract.** The CDK stack deliberately sets `triggerOnPush: false` on the
  Source stage: leaving it `true` would double-trigger every merge (auto +
  RM) once the GitHub App gains webhook permission. The release manager
  starts the pipeline explicitly via `Pipeline___start_deploy` after merging,
  and the ManualApproval action in the Deploy stage remains the human deploy
  gate (approved via Telegram).
- **PR-check webhook is gated OFF by default.** The CodeBuild PR webhook only
  turns on with `PIPELINE_CI_WEBHOOK=1` at CDK deploy time. The required PR
  checks today are the GitHub Actions in `.github/workflows/ci.yml`.

- **Build-once / promote-by-digest:** the Deploy stage never rebuilds. It
  consumes the Build stage's ECR image *digest* and the orchestrator zip's S3
  *version id*, so what a human approved is byte-identical to what deploys.
- **One approval, in-pipeline:** the ManualApproval action IS the production
  gate. It coexists with the existing agent/human merge gate (§7) — the merge
  gate authorizes the *merge*; the pipeline approval authorizes the *deploy*.
  For the pilot they can be collapsed (RM's merge gate → merge → pipeline
  auto-runs to its own approval), or kept as two. Pilot choice: **keep the
  pipeline ManualApproval**, because the deploy is the irreversible act and the
  approver should see the built artifacts, not just the diff.

---

## 6. buildspecs — porting `DEPLOY.md` into the pipeline

The current `DEPLOY.md` is a human/agent runbook. The buildspecs are its
machine form. `DEPLOY.md` stays as the source-of-truth contract and the doc RM
reads; the buildspec is the executable projection. **Every command below already
exists in `DEPLOY.md` or `deploy/`** — the port is about *where* it runs
(hermetic container, IAM role) not *what* it runs.

### `deploy/pipeline/buildspec-ci.yml` (PR check + Build stage)

```yaml
version: 0.2
phases:
  install:
    runtime-versions: { nodejs: 20 }
    commands:
      - npm ci
  pre_build:
    commands:
      # Deterministic gates — any red fails the build → required check red → no merge
      - npx tsc --noEmit
      - npm run lint
  build:
    commands:
      - npm run build           # next build == module-removal smoke test
      - npm run test:cloud-code # hermetic (page.route-mocked) UI gate — NOT the
                                # AWS-backed tab/api specs, which need live creds
      # HARD GATE: the exact guard DEPLOY.md's inline zip bypassed
      - bash scripts/check-lambda-zip-manifest.sh
  post_build:
    commands:
      - npm audit --audit-level=high || true   # report; wire to fail once baselined
      # (semgrep / cdk-nag added here in a later pass)
artifacts:
  files:
    - '**/*'
  # Build stage only: also emits orchestrator.zip + image digest (see below)
```

- **iOS target repos** (use (b) later): swap the Node phases for the existing
  `codebuild-ios-mcp` macOS project — same pipeline shape, different build
  image. The hub pilot is pure TS/Lambda so it uses the Linux standard image.

### `deploy/pipeline/buildspec-deploy.yml` (Deploy stage — the 3-target `DEPLOY.md`)

Runs under the **pipeline's IAM role** — no laptop, no `tycenj-prod` profile,
Jira creds never touched. This structurally enforces the two hard rules:
"orchestrator code-only" and "never run the full `deploy.sh` that blanks Jira
creds."

```yaml
version: 0.2
env:
  variables: { AWS_REGION: us-east-1 }
  # ARTIFACT_BUCKET, EXPECTED_ACCOUNT_ID, etc. injected by the pipeline from SSM/stack outputs
phases:
  build:
    commands:
      # ── Target 1: orchestrator Lambda — CODE ONLY (deploy.sh's explicit file list,
      #    which INCLUDES lease-constants.json; NOT `zip -qr .`, NOT the full deploy.sh) ──
      - cp src/config/lease-constants.json lambda/orchestrator/lease-constants.json
      - cd lambda/orchestrator && npm ci --omit=dev
      - zip -rq /tmp/orchestrator.zip index.mjs agent-invoker.mjs events-writer.mjs
          workflow-store.mjs lease.mjs lease-constants.json watchdog.mjs
          dead-session-detector.mjs cascade.mjs review-cap.mjs ship-review.mjs
          completion.mjs package.json node_modules/
      - cd ../..
      - bash scripts/check-lambda-zip-manifest.sh   # re-assert manifest before ship
      - aws lambda update-function-code --function-name agentcore-hub-orchestrator
          --zip-file fileb:///tmp/orchestrator.zip --region "$AWS_REGION"
      - aws lambda wait function-updated --function-name agentcore-hub-orchestrator

      # ── Target 2: config/blueprints → S3 (agents.json MERGED, never cp'd) ──
      - aws s3 sync blueprints/ "s3://$ARTIFACT_BUCKET/blueprints/"
      - aws s3 sync deploy/runtime-agent/prompts/ "s3://$ARTIFACT_BUCKET/prompts/"
      - aws s3 cp src/config/workflows.json "s3://$ARTIFACT_BUCKET/config/workflows.json"
      - aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" /tmp/agents-s3.json
      - python3 deploy/pipeline/merge-agents-json.py   # extracted from DEPLOY.md's inline block
      - aws s3 cp /tmp/agents-merged.json "s3://$ARTIFACT_BUCKET/config/agents.json"

      # ── Target 3: ECS Express app — promote the Build stage's image BY DIGEST ──
      - aws ecs update-express-gateway-service --service-arn "$SERVICE_ARN"
          --primary-container "{\"image\":\"$ECR_URI@$IMAGE_DIGEST\", ... }" ...
  post_build:
    commands:
      # DEPLOY.md smoke checks, verbatim — each must pass or the stage fails (→ rollback action)
      - curl -sf "$DEPLOYMENT_URL/api/agentcore/traces/health"
      - aws lambda invoke --function-name agentcore-hub-orchestrator --payload "$(echo '{}'|base64)" /tmp/o.json
      - test "$(jq -r '.FunctionError // "None"' /tmp/o.json)" = "None"   # guards the INIT-crash class
      - aws s3 cp "s3://$ARTIFACT_BUCKET/config/agents.json" - | python3 -c "..."  # ARNs intact
```

Notes (implemented):
- **CI gate parity.** `buildspec-ci.yml` runs EVERY blocking gate the GitHub CI
  workflow runs — `lint`, `tsc --noEmit`, `test:unit` (vitest),
  `check-workflow-writes.sh`, `next build`, the hermetic Cloud Code UI suite, and the
  runtime-agent telemetry pytest — plus the lambda-zip manifest gate. It has to,
  because with `PIPELINE_ENABLED` the blueprints skip their own mechanical tests
  on a green result; a missing gate here would let unit/race/telemetry
  regressions merge. Kept in lockstep with `.github/workflows/ci.yml`.
- **Eval-infra targets (DEPLOY.md steps 4–9) are OUT of the app pipeline.** They
  belong to the separate fleet+eval pipeline (its own role/secrets/CLI). The app
  pipeline detects a fleet/eval change (`pipeline-out/changed-files.txt`) but does
  NOT block up front — it **deploys the app targets, advances the baseline SHA,
  then fails the action as a terminal non-rollback handoff** so a human runs steps
  4-9. This ordering is deliberate: the baseline only advances on a successful app
  deploy, so blocking *before* the deploy would wedge the pipeline (same range
  re-blocks forever). Deploying-then-signalling means the app always ships and the
  same commits never re-block. The changed-file list is computed from the last
  successfully deployed SHA (recorded in S3), so a multi-commit push cannot hide
  an eval change; an unknown range forces the handoff conservatively.
- **ECS roll is conditional** on `ECS_SERVICE_ARN` being set (Lambda/blueprint-
  only changes skip the image promote), and the roll is **verified**: the Deploy
  stage polls the service to ACTIVE-with-endpoint and curls the app health
  endpoint (200) before declaring success — a container that fails to start
  fails the pipeline.
- **Rollback** (`deploy/pipeline/rollback.sh`) is automatic: pre_build snapshots
  the current orchestrator zip + ECS image; a Deploy-phase failure restores both
  (S3-versioned config is surfaced for manual restore). Closes the
  `deploy/local/rollback.sh` gap `DEPLOY.md` names as outstanding.

---

## 7. Agent re-scoping (behind `PIPELINE_ENABLED`)

Blueprint changes are S3-synced (DEPLOY.md step 2), no fleet redeploy. Each is
written to **fall back to today's behavior when `PIPELINE_ENABLED` is unset**,
so the module stays truly optional.

### `ci-agent.md` → thin CI-fixer
- **When `PIPELINE_ENABLED`:** do NOT shell `tsc`/`build`/`test`. Read the
  CodeBuild PR-check status for the branch head SHA (via a `Pipeline___*` tool
  or `aws codebuild batch-get-builds`). Green → PASS, record the tested SHA
  (RM still cross-checks it). Red → pull the CloudWatch build log, triage the
  failure, and split it into two lanes: **mechanical** failures (formatter/
  linter/lockfile — the §11 whitelist) are auto-remediated by the CI agent
  itself in a single pass; **logic** failures get **grouped fix tickets** (one
  per component, `blocked_by` chained on same file) back to the owning dev —
  exactly its current FAIL path, minus running the build itself.
- **When unset:** current blueprint verbatim.

### `qa-verifier.md` → semantic verifier
- **When `PIPELINE_ENABLED`:** drop Step 2's mechanical `npm install / tsc /
  build / lint / test`. Populate the Verification Ledger's compile+test rows
  from the CodeBuild result (cite the build id/log as evidence). KEEP Steps 3
  (visual), 3b (iOS gateway), 3c (live integration), 3d (perf), 4 (acceptance
  criteria) — the judgment work a mechanical pipeline does not do. A PASS still
  requires the compile+test rows green, but now that greenness comes from the
  authoritative CI, not a QA-run shell.
- **When unset:** current blueprint verbatim.

### `release-manager.md` (CD ticket) → trigger + report, don't execute
- **When `PIPELINE_ENABLED`:** Ship ticket unchanged (final PR review + Merge
  Brief). CD ticket: after the human merge gate, **merge the PR, then start the
  CodePipeline execution via `Pipeline___start_deploy`** and poll it to terminal
  with `Pipeline___get_state`. RM drives the pipeline **exclusively through the
  `Pipeline___*` tools** — the coding-runtime IAM role is AccessDenied on
  CodePipeline by design, so `aws codepipeline ...` in `claude_code` fails.
  Merge does **not** auto-trigger the pipeline (the GitHub push webhook is not
  wired); RM must call `Pipeline___start_deploy` explicitly. Report the pipeline
  execution result (stage statuses, approval, deploy + smoke outcomes,
  rollback if any) as the CD evidence — instead of shelling `DEPLOY.md` via
  `claude_code`. `DEPLOY.md` preflight still applies: no `DEPLOY.md` /
  no pipeline configured → BLOCKED.
- **When unset:** current blueprint verbatim (shells `DEPLOY.md`).

### `code-reviewer.md`
- **Unchanged** in all modes. It is pure judgment; the pipeline adds nothing and
  removes nothing.

---

## 8. IAM (least privilege, per role)

- **CodeConnections:** the GitHub App link; no long-lived PAT in the account.
- **CodeBuild CI role:** read source, write logs, post commit status,
  `ecr:GetAuthorizationToken` + push (Build stage only), `s3:PutObject` to the
  artifact bucket for the orchestrator zip. No deploy perms.
- **CodeBuild Deploy role:** the narrow set `DEPLOY.md` needs —
  `lambda:UpdateFunctionCode` (scoped to `agentcore-hub-*`), `s3:*Object` on the
  artifact bucket, `ecs:UpdateExpressGatewayService` on the one service,
  `cloudwatch`/`logs` read for smoke, and the eval-target actions. **No**
  `lambda:UpdateFunctionConfiguration` on the orchestrator (that is what blanks
  Jira creds — the role literally cannot do it). No `iam:*`.
- **CodePipeline role:** orchestrate the stages, publish to the SNS approval
  topic, assume the two CodeBuild roles.
- All authored in the `deploy/pipeline/` CDK stack with `cdk-nag` run in CI.
- Honors the standing constraint: **no public endpoints, no Function URL
  auth=NONE, no `Principal:"*"`** — the pipeline creates none of these.

---

## 9. Pilot rollout plan (hub repo)

1. **CDK stack** in `deploy/pipeline/` — CodeConnections link, CI CodeBuild
   project, deploy CodePipeline, two IAM roles, SNS approval topic. `cdk deploy`
   to prod (838829463875 / tycenj-prod). Nothing else changes yet.
2. **buildspecs** committed to `deploy/pipeline/`; `merge-agents-json.py`
   extracted from DEPLOY.md's inline block (single source of the merge logic).
3. **Branch protection** on `main`: require the `agentcore-hub-ci` status +
   ≥1 approval. This alone kills the CI-flakiness class — every PR now gets a
   deterministic gate.
4. **Prove the CI check** on a throwaway PR (green + a deliberately-red one).
5. **Prove the deploy pipeline** end-to-end on one real merge: Source → Build →
   approve → Deploy → smoke green. Compare the deployed image digest to the
   approved one.
6. **Module surface** (`modules.ts` + `/pipeline` UI) — read-only pipeline
   status first; trigger/approve later.
7. **Re-scope the 3 blueprints** behind `PIPELINE_ENABLED`; S3-sync; flip the
   flag; run one full SDLC workflow through the fleet and confirm CI agent reads
   the check, QA skips the mechanical rebuild, RM watches the pipeline.
8. **Template to (b)** — parameterize the stack per target repo (`talk-to-me`,
   iOS repos) in a later pass.

### Done-when
- A red build blocks merge with a real CloudWatch log (no agent involved).
- A merge deploys via CodePipeline with one human approval; deployed digest ==
  approved digest.
- The orchestrator-zip / lease-constants class of failure cannot recur (manifest
  gate + INIT-crash smoke both in the pipeline).
- `PIPELINE_ENABLED` unset → app builds, `tsc --noEmit` passes, fleet behaves
  exactly as today. Module is genuinely optional.

---

## 10. Open decisions (all resolved)

1. **One approval or two** — RESOLVED: **both**. The merge gate authorizes the
   merge; the in-pipeline ManualApproval (Telegram-bridged, §5) authorizes the
   deploy.
2. **CI-agent disposition** — RESOLVED: **kept as thin CI-fixer**, now with the
   §11 mechanical-lane auto-remediation.
3. **Rollback automation** — RESOLVED: **shipped in the Deploy stage**
   (`deploy/pipeline/rollback.sh` runs automatically on a Deploy-stage failure).
4. **`npm audit` failing the build** — RESOLVED: **report-only**
   (`|| true` in `buildspec-ci.yml`); flip to blocking once the current
   advisories are baselined.

---

## 11. Post-pilot additions (implemented)

- **`agentcore-hub-pipeline-tools` Lambda.** The fleet drives the pipeline
  through a narrow Lambda (`lambda/agentcore-hub-pipeline-tools/`, deployed via
  `deploy/setup-pipeline-tools-lambda.mjs`) exposing `Pipeline___get_state` /
  `start_deploy` / `get_build_status` / `get_build_log` — read + trigger only.
  **Invariant: no `codepipeline:PutApprovalResult`** — an agent must never
  approve its own deploy; the ManualApproval gate stays human (Telegram bridge).
  This exists because the coding-runtime role is AccessDenied on CodePipeline by
  design — the RM's dead-zone RCA.
- **Ship merge-verify completion gate.** The orchestrator refuses to finalize a
  ship-phase workflow if it can prove the feature branch is unmerged (emits
  `workflow.cd_unmerged`, leaves the run open). Best-effort: a GitHub/API
  failure never blocks a legitimate completion. Opt-out: `SHIP_MERGE_VERIFY=off`.
- **CI two-lane auto-remediation** (`blueprints/ci-agent.md` P2a). Mechanical
  failures — an exhaustive whitelist: `prettier`, `eslint --fix`, import
  ordering, lockfile regen — are self-fixed by the CI agent: run the tool (never
  hand-edit), single pass only, scope-capped to files already in the diff, then
  re-verify green on the **new** head SHA via `Pipeline___get_build_status`.
  Default-deny: anything off-whitelist (or touching logic) still files a dev
  ticket.
- **Deploy-gate surfaces.** The Telegram approval bridge (§5) plus a deploy-gate
  banner on the Workflow board: `WorkflowBoard.tsx` polls `/api/pipeline/status`
  during a ship-phase run and shows when a ManualApproval is waiting
  (silent-catch when the Pipeline module is absent).
