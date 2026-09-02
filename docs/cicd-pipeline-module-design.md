# CI/CD Pipeline Module — Design Spec

Status: **DESIGN — not implemented.** Pilot target: the hub's own repo
(`agentcore-hub`). No code lands from this doc; it defines the module boundary,
the AWS-native pipeline, the buildspecs that port `DEPLOY.md`, and how three
agent blueprints re-scope once a real pipeline owns the deterministic work.

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
  CodeBuild logs, files grouped fix tickets). The CI phase stays in
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
| Approval notification | **SNS → existing Telegram bot** (reuse the merge-gate ping path) |
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

### Two pipeline uses (name them, build one)

- **(a) Deploy the hub app itself** — the pilot. One repo, concrete, proves the
  full loop (CI check → merge → pipeline deploy of the Lambda + ECS targets).
- **(b) The fleet stands up pipelines in the *target repos* it builds features
  for** — the bigger long-term play. Same module, a templating pass over (a).
  Out of scope for the pilot; the CDK stack is parameterized by repo so (b) is a
  later `cdk deploy` per target, not a rewrite.

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
   └── on merge to main ───────► CodePipeline: agentcore-hub-deploy
                                   ├─ Source   (CodeConnections, main)
                                   ├─ Build    buildspec-ci.yml again (build-once)
                                   │           → artifacts: orchestrator.zip (+ digest),
                                   │             ECR image (by digest), eval zips
                                   ├─ Approval  ManualApproval → SNS → Telegram
                                   └─ Deploy   buildspec-deploy.yml
                                               (promotes the exact artifacts by digest)
```

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
      - npm test                # fast Playwright: tab UI + API smoke
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

Notes:
- The **eval-infra targets (DEPLOY.md steps 4–9)** become a second deploy action
  or a conditional block, gated on whether the merged changeset touches eval
  files — exactly the "skipped when no eval files" behavior the contract already
  has. Ordering (packager before rubric; alarms last, gated) is preserved as
  action order.
- **ECS roll is conditional** on the changeset touching app code — a Lambda-only
  or blueprint-only change skips the image promote (matches how the hub is
  deployed by hand today).
- **Rollback** = a pipeline action that re-points Lambda at the prior zip S3
  version and ECS at the prior image digest (both already versioned). This is
  the `deploy/local/rollback.sh` gap `DEPLOY.md` names as outstanding — the
  pipeline is where it gets automated.

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
  failure, and file **grouped fix tickets** (one per component, `blocked_by`
  chained on same file) back to the owning dev — exactly its current FAIL path,
  minus running the build itself.
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
  CodePipeline execution** (`aws codepipeline start-pipeline-execution`) and
  poll it to terminal, or (cleaner) let the merge-to-main trigger fire the
  pipeline and have the CD ticket **watch** the execution. Report the pipeline
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

## 10. Open decisions (defaults chosen; flag if you disagree)

1. **One approval or two** (merge gate + pipeline approval). Default: **keep
   both** — merge gate authorizes the merge, pipeline approval authorizes the
   irreversible deploy against built artifacts.
2. **CI-agent disposition.** Decided: **keep as thin CI-fixer** (not retired).
3. **Rollback automation** lands with the pipeline (closes the `DEPLOY.md`
   `rollback.sh` gap) rather than as a separate task. Default: **yes, in the
   Deploy stage.**
4. **`npm audit` failing the build.** Default: **report-only at first**, flip to
   blocking once the current advisories are baselined.
```
