# CI/CD Pipeline Module — Design Spec

Status: **IMPLEMENTED — pipeline live.** Pilot target: the hub's own repo
(`agentcore-hub`). This doc defines the module boundary, the AWS-native
pipeline, the buildspecs that port `DEPLOY.md`, and how three agent
blueprints re-scope now that a real pipeline owns the deterministic work.

---

## Quickstart (operator walkthrough)

What happens after you open a pull request against `agentcore-hub`, from the
required checks through to a deployed and smoke-tested artifact:

1. A pull request triggers the GitHub Actions required checks: "Lint,
Typecheck, Unit, Build", "Runtime agent telemetry" (hermetic, no AWS access),
and "Cloud Code UI" (which runs mocked, with no AWS access). Branch
protection on `main` blocks the merge if any of these three checks comes
back red, so a broken build or a failing test suite never lands on `main`.

2. Once the pull request merges to `main`, the CodePipeline named
`agentcore-hub-deploy` is started by the release manager calling
`Pipeline___start_deploy` — the merge does **not** auto-trigger it. This is
the agent-owned trigger contract: the CDK stack deliberately sets
`triggerOnPush: false` on the Source stage, since leaving it `true` would
double-trigger every merge (auto + RM) once the GitHub App gains webhook
permission. The pipeline then runs four stages in order:
Source, Build, ManualApproval, and Deploy. The Build stage re-runs the same
gates as the PR check and produces the artifacts the later stages consume.
See [pipeline topology](#5-pipeline-topology-pilot--hub-repo)
for the full stage-by-stage breakdown.

3. The ManualApproval stage is delivered to Telegram as a message with
Approve and Reject buttons, via the poll-based approval bridge. This is the
deploy gate, and it is distinct from the pull request's merge gate: the
merge gate authorizes the merge itself, while the pipeline approval
authorizes deploying the artifacts the Build stage already produced. See
[pipeline topology](#5-pipeline-topology-pilot--hub-repo)
and [agent re-scoping](#7-agent-re-scoping-behind-pipeline_enabled)
for how the two gates relate.

4. Approving the deploy promotes exactly what the Build stage produced: the
orchestrator Lambda zip plus the application image, promoted by its ECR
digest rather than rebuilt. This build-once, promote-by-digest approach
means the artifacts a reviewer approved are byte-identical to the ones that
reach production, since the Deploy stage never rebuilds anything. After
promotion, the Deploy stage runs `DEPLOY.md`'s `## Smoke checks` (the traces
health check and orchestrator health checks) as ported into the pipeline's
deploy buildspec, which additionally invokes the orchestrator to guard
against the INIT-crash failure class. See the
[buildspecs](#6-buildspecs--porting-deploymd-into-the-pipeline) section for how each command maps back to `DEPLOY.md`.

For the broader rollout plan, see the [pilot rollout plan](#9-pilot-rollout-plan-hub-repo).
For the exact smoke-check contract, see [`DEPLOY.md`](../../DEPLOY.md).

---

## Operating model — agents own CD

How the release manager (RM) and CI agent drive the deploy pipeline in
PIPELINE mode, and where the humans sit.

### Which repos the hub deploys at all — the CD registry

Everything below applies only to repos in the hub's **CD registry**
(`s3://<ARTIFACT_BUCKET>/config/cd-registry.json`; `scripts/cd-registry.sh`,
`POST /api/workflow/cd-registry`, or Workflow tab → Target Repository → *CD
registry…*). The orchestrator decides per run, from the run's repo URL:

- **Registered → CD.** Full ship phase: RM reviews the final PR, a human approves
  the Merge Approval gate, RM merges and deploys — in *Pipeline mode* through the
  entry's `pipeline` (`## Pipeline Mode` carries `pipeline_name`; needs
  `PIPELINE_ENABLED`), else in *legacy mode* per the repo's `DEPLOY.md`.
- **Not registered → handoff.** The hub never merges or deploys the repo. The
  effective workflow def drops the ship phase and its gate; intake is told
  `CD_REGISTERED: false` and plans no Ship / Merge Approval / CD tickets (any that
  exist anyway are resolved Done with a comment — `cd.handoff_skip` — never
  dispatched or paged). The run completes after review/QA/CI, the orchestrator
  opens the unified PR with a handoff description and leaves it open for the
  owning team, and records `delivery: { mode: "handoff", prUrl }` on the run.

Why: the hub's fleet works on several repos but its pipeline deploys exactly one.
Before the registry, every repo was told a pipeline owned its deploy, and the RM
on a foreign repo either chased the hub's own pipeline or blocked on a deploy it
had no credentials for (TEAM-4044). Other teams own their merge + deploy; the hub
hands them a reviewed, tested PR.

### The registry is a runtime allow-list, not just intake config

The same document is read at runtime by every surface that can move code to
production: the orchestrator (ship phase or handoff), the
`agentcore-hub-pipeline-tools` Lambda (which pipeline/projects a `Pipeline___*`
call may touch), the Telegram deploy-gate bridge (which pipelines it polls and
offers Approve/Reject for), and the hub UI (`/pipeline`, the board's deploy-gate
banner). So: **registry write access now equals deploy-trigger authority.** Adding
an entry with a `pipeline` is what grants agents the ability to start a deploy of
that repo — treat `POST /api/workflow/cd-registry` and `scripts/cd-registry.sh` as
privileged, and review registry diffs the way you'd review an IAM change.

### Per-entry fields and the naming convention

An entry carries `pipeline` (the CodePipeline that deploys the repo), `region`
(where that pipeline lives — absent means the hub's own region), optionally
`ciProject` (the repo's CodeBuild PR-check project), and — for a pipeline in a
**different AWS account** — an optional cross-account triple: `account` (the
12-digit account the pipeline lives in), `roleArn` (the
`arn:aws:iam::<account>:role/hub-cd-trigger-<slug>` trigger-only role the
`Pipeline___*` tools Lambda `AssumeRole`s there) and `externalId` (the
confused-deputy guard on that AssumeRole). The triple is honored only as a
complete, valid set — `roleArn`'s embedded account cross-checked against
`account`, `roleArn` naming the reserved `hub-cd-trigger-*` role — else it is
dropped and the entry falls back to same-account. Everything else is derived
from the pipeline name, by one rule shared by every surface —
`pipelineProjects()` in `lambda/orchestrator/cd-registry.mjs` and its TS mirror
`pipelineProjectsFor()` in `src/lib/cd-registry.ts`:

```
pipeline: hub-<slug>-deploy
  → ciProject     hub-<slug>-ci      (unless the entry names one explicitly)
  → buildProject  hub-<slug>-build
  → deployProject hub-<slug>-deploy
```

`slug` = the repo name, lowercased, every run of `[^a-z0-9]+` collapsed to `-`,
trimmed of leading/trailing `-`, truncated to 40 chars. A pipeline name that does
not end in `-deploy` is used as the base as-is (`juno` → `juno-ci` / `juno-build`).
`hub-` is a **reserved prefix** for hub-managed pipelines; the hub's own resources
keep their historical `agentcore-hub-*` names, so `agentcore-hub-deploy` derives
`agentcore-hub-ci` / `agentcore-hub-build`.

`POST /api/workflow/cd-registry` shape-validates every field (`repo`, `region`,
`pipeline`, `ciProject`, `deployDoc`, `notes`, plus the cross-account
`account`, `roleArn`, `externalId` — with `roleArn`'s embedded account
cross-checked against `account`, and the triple accepted only whole) before it
reaches S3 — `validateCdEntryInput` in `src/lib/cd-registry.ts` — and rejects with
`400 { error: "invalid_field", fields }` naming every failing field at once, so
a typo'd region or path traversal in `deployDoc` fails here instead of as an
opaque AWS error inside a Lambda later.

Regions: `node deploy/setup-pipeline-tools-lambda.mjs` reads `PIPELINE_REGIONS`
(comma-separated; default = the Lambda's own region) to fan the tools Lambda's IAM
grants (pipeline + project ARNs) out to those regions - it is not a runtime check
in the Lambda. An entry whose region is outside that list was simply never granted
access, so its calls fail at AWS with `AccessDenied`: operator misconfiguration
surfaced as the tool's normal error text, the same shape as the `ciProject` note
below, rather than a silent resolve to the wrong account-local pipeline.

An explicit `ciProject` outside the `hub-*-ci` convention is still checked by
`validateCiProjectName`: it is refused outright when it collides with the entry's
build/deploy/pipeline names or a reserved deploy project (an agent must never be
able to aim `start_ci_build` at a deploy project). Anything else passes the
allow-list and, under convention-scoped IAM, simply fails at AWS with
`AccessDenied` — operator misconfiguration surfaced as the tool's normal error
text, not a silent build of the wrong project.

Onboarding a new repo today means creating its pipeline out of band and adding the
entry. A generic per-repo CDK stack plus onboarding scripts/templates is a
follow-up (PR B).

### The RM loop (trigger → watch → fix ticket → re-trigger)

1. **Merge.** After the human merge gate approves, RM merges the PR
   (`gh pr merge --squash`) and records the merge SHA.
2. **Trigger.** Merge does **not** auto-trigger the pipeline (the GitHub push
   webhook is not wired) — RM calls `Pipeline___start_deploy` and records the
   `pipelineExecutionId`.
3. **Watch to terminal.** RM polls `Pipeline___get_state` until the execution
   is terminal, reporting stage statuses as CD evidence.
4. **On Build FAILED:** RM calls `Pipeline___get_build_log` (phase contexts +
   log tail), then files a **precise fix ticket** (file:line + failing command)
   routed to the owning dev — it never hand-fixes the deploy. When the fix
   merges, RM calls `Pipeline___start_deploy` again. This loop is RM's to own
   until the pipeline is green or the fix is genuinely blocked.

All of this runs through the `Pipeline___*` tools on the
`agentcore-hub-pipeline-tools` Lambda (read + trigger only). The coding-runtime
IAM role is AccessDenied on CodePipeline **by design** — shelling
`aws codepipeline ...` fails, so the narrow Lambda is the only path.

### The deploy gate is human-only

The in-pipeline **ManualApproval** stage is a second gate beyond the merge
gate: the merge gate authorizes the merge, the deploy gate authorizes shipping
the built artifacts. It is bridged to Telegram by the `telegram-bug-intake`
poller: it polls `GetPipelineState`, atomically claims the approval token in
DynamoDB (exactly one ping per wait), and sends Approve / Reject inline
buttons that map to `PutApprovalResult`. The tools Lambda **deliberately has
no `PutApprovalResult`** — an agent can never approve its own deploy. The
bridge is gated by `DEPLOY_PIPELINE_NAME` on that Lambda (unset = no-op).

**…and conditional, never auto-approved.** Held unconditionally, that gate asked
the human to approve byte-identical code twice: in `wf_1789170903227_c3x6k1` the
Merge Approval gate cleared PR head SHA X at 10:38Z and the `Approve_deploy`
ManualApproval cleared the merge of that same X at 16:03Z — 5.1h later, after the
release manager had polled ~2h50m and filed deploy-gate ticket TEAM-4523. The
second ask carries information in exactly one case: the thing about to deploy is
**not** what the human approved. So `Approve_deploy` is now a CONDITIONAL stage,
skipped when — and only when — the pipeline can prove it is deploying the merge of
a SHA a human already approved. The gate is made *unnecessary* for one specific
commit; it is never approved by software. Four moving parts:

1. **Record, before the pipeline starts.** `Pipeline___start_deploy` takes an
   optional `approved_head_sha` (plus `ci_build_id`, `pr_url`, `workflow_id`,
   `ticket_id`). A record is written only when all three of these are proven, in
   this order: `commit_sha` and `approved_head_sha` are both 40-hex; a SUCCEEDED
   build of the target's CI project certifies `approved_head_sha`; and the GitHub
   API, asked about the `pr_url` the caller passed, reports `merged: true` with
   `head.sha == approved_head_sha` and `merge_commit_sha == commit_sha`. That
   third check is the **merge binding** — without it the caller's `commit_sha` is
   an unverified claim, and any commit on `main` could be paired with a certified
   head (review finding on PR #576). It needs a read-only `GITHUB_TOKEN` on the
   tools Lambda (plumbed by `deploy/setup-pipeline-tools-lambda.mjs`, optional,
   5s timeout); with no token nothing is ever recorded, which is exactly the
   pre-TEAM-4525 behaviour. `pr_url` is therefore mandatory for recording, and
   the token grants no approval capability of any kind.
   The record lands at
   `s3://$ARTIFACT_BUCKET/pipeline-artifacts/ship-approvals/<merge_commit>.json`
   — `{version, merge_commit, approved_head_sha, ci_build_id, pipeline, repo,
   pr_url, workflow_id, ticket_id, recorded_at,
   recorded_by:"Pipeline___start_deploy"}` — then the pipeline starts exactly as
   before. Otherwise it starts the pipeline **without** a record and returns
   `preapproval:{recorded:false, reason}`, where `reason` is
   `approved_head_sha_missing` | `invalid_sha` | `ci_not_certified` |
   `pr_url_missing` | `pr_url_invalid` | `merge_binding_mismatch` |
   `merge_binding_unverified` | `record_write_failed`. One new IAM statement on
   the tools Lambda: `s3:PutObject` on exactly that prefix. Symmetrically, all
   three CodeBuild roles in the stack carry an explicit **Deny** on writing that
   prefix (`DenyShipApprovalRecordWrites`, `denyShipApprovalWrites()` in
   `pipeline-stack.ts`), because their commands come from the branch under review
   and the Build role's `pipeline-artifacts/*` grant would otherwise let a change
   forge its own approval; `GetObject` stays allowed so Deploy can re-verify.
2. **Decide, in the Build stage.** `buildspec-ci.yml` declares
   `DEPLOY_PREAPPROVED` in `env.exported-variables`, sets it to `0` in
   `pre_build`, and in the `BUILD_APP_IMAGE` block (after the artifacts are
   emitted) sets it to the output of
   `deploy/pipeline/preapproved-check.sh decide "$FULL_SHA"`. That script prints
   `1` only when the record exists for that exact commit, parses, its
   `merge_commit` equals the resolved source commit, and its `approved_head_sha`
   is 40-hex; every other outcome prints `0`, and it never fails the build. The
   Build also emits `pipeline-out/git-sha-full.txt` (the existing 12-char
   `git-sha.txt` is the image tag and is unchanged), and the Build action carries
   `variablesNamespace: "BuildVars"`.
3. **Skip only on the literal `1`.** The Approval stage carries a CodePipeline V2
   stage-entry condition: `beforeEntry` → one `Rule` of provider `VariableCheck`,
   `configuration: { Variable: "#{BuildVars.DEPLOY_PREAPPROVED}", Operator: "NE",
   Value: "1" }`, `result: Result.SKIP`. Anything other than that literal `1` —
   empty, unresolved, `0`, garbage — enters the stage and pages the human exactly
   as today.
4. **Re-verify, in the Deploy stage.** Both Deploy actions receive
   `DEPLOY_PREAPPROVED` and their buildspecs run `preapproved-check.sh gate
   "$DEPLOY_PREAPPROVED" "$(cat pipeline-out/git-sha-full.txt)"` before touching
   prod: exit 0 for `0` (a human approved) or for `1` when an independent re-read
   of the record still agrees; garbage refuses.

   **Empty is the unwired stack, not garbage (TEAM-4527).** Steps 2-4 ship with
   the source and are live on the next run; the `variablesNamespace`, the
   `beforeEntry` rule and the two env entries only exist after a human runs
   `./deploy/pipeline/deploy.sh`. Until then the variable arrives empty, and
   refusing it made `main` undeployable for three executions that had already
   passed the *human* gate. Empty now proceeds — because the SKIP condition reads
   the same variable through the same namespace, so an unwired stack cannot have
   skipped anything — **unless** a ship-approval record verifies for the deployed
   commit, which is the one state (asymmetric wiring) where a real SKIP could have
   fired, and which therefore still refuses. Empty also refuses when the record
   cannot be looked up at all (no `ARTIFACT_BUCKET`, no `aws`), so "no record"
   always means *looked and found none*. See DL-028 "Rollout contract".

Three checkpoints — decide, skip, re-verify — all fail closed in the same
direction: a missing, stale, unreadable or misread record can only produce a
needless human gate, never a silent deploy. Drift falls out of the same property.
A post-approval `main` sync produces a new head SHA, so the operator's MERGE
worker replies `DRIFT` and refuses to merge — no record is written and the gate
fires (the lesson from the earlier "needed a 2nd approval after a post-gate main
sync" incident). A commit landing on `main` between the merge and `start_deploy`
means the resolved source version no longer matches the record, so the gate fires.
The human-only invariant is untouched: the tools Lambda still has no approval
action of any kind, the Telegram bridge stays the only holder, and no agent gains
any approval capability. The decision logic lives in the blueprints, the tools
Lambda and the pipeline definition — never in the orchestrator (DL-009) and behind
no new `*_MODE` flag. `Pipeline___get_state` reports `approvalSkipped: boolean`,
and the ship/completion record carries `approved_head_sha`.

### CI two-lane policy (summary)

On a red build, the CI agent classifies the failure
(see [`blueprints/ci-agent.md`](../../blueprints/ci-agent.md) P2a for the full
rules):

- **Mechanical lane — self-fix.** Whitelist-only (prettier, `eslint --fix`,
  import ordering, lockfile regen); default-deny anything else. Run the tool,
  never hand-edit; single pass; scope-capped to files already in the diff;
  re-verify green on the **new** head SHA via `Pipeline___get_build_status`.
- **Logic lane — ticket.** Anything touching source logic gets a grouped fix
  ticket to the owning dev. Mixed failures: auto-fix the mechanical, ticket the
  logic, FAIL until the tickets land.

### Ship merge-verify completion gate

The orchestrator refuses to finalize a ship-phase workflow when it can prove
the feature branch is unmerged (emits `workflow.cd_unmerged` and leaves the
run open) — a CD ticket marked done without a real merge can no longer
false-complete a run. Best-effort: a GitHub/API failure never blocks a
legitimate completion. Opt-out: `SHIP_MERGE_VERIFY=off`.

### Deploy-gate banner in the UI

While a ship-phase run is active, the Workflow board polls
`/api/pipeline/status?repo=<the run's repo>` and shows a banner when a
ManualApproval is waiting on **that repo's own pipeline**, naming it (`Deploy gate
— hub-juno-deploy awaiting approval`) with a link to approve. The banner is
derived only from the target whose `repo` matches the run, so a ship run on one
repo can never surface another repo's gate, and a handoff run (unregistered repo,
no matching target) shows nothing. The poll silent-catches when the Pipeline module
is absent, so the board needs no change in non-pipeline deployments.

`/pipeline` shows the same data for every target at once: one section per
registered pipeline plus the env default, each with its region, CI project, stages
and recent builds. Errors are per-target — one repo's missing or AccessDenied
pipeline renders an amber block inside its own section and leaves the rest intact.

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
> `scripts/check-deploy-surfaces.sh` (CI gate: every `lambda/*`, `deploy/*` and
> `src/config/*.json` file must be a surface, a handoff, or explicitly
> excluded). What remains a handoff is exactly what the narrow role cannot do:
> runtime images and infra scripts (IAM/env/tables). The "fleet + eval pipeline"
> below therefore shrinks to an image-build-and-`UpdateAgentRuntime` increment.

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
  baseline SHA, then records a handoff marker in S3 and SUCCEEDS** — a human runs
  DEPLOY.md steps 4-9 (the documented deploy-contract handoff), never a silent
  skip. (See §6 for why the deploy-then-signal ordering is deliberate.)
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
                                                  then SUCCEED with a handoff marker
                                                  for the human-run infra scripts)
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
      # workflows.json + pricing.json ship via the manifest S3CP loop (TEAM-4259 —
      # this used to be an unconditional cp, outside surfaces.json)
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
  then writes `pipeline-artifacts/handoff/<sha>.txt` and SUCCEEDS** so a human runs
  steps 4-9 (`Pipeline___get_state` surfaces the list as `handoff`; it used to
  `exit 2`, which made a green deploy indistinguishable from a broken one —
  2026-09-09). This ordering is deliberate: the baseline only advances on a successful app
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
   to prod (210987654321 / tycenj-prod). Nothing else changes yet.
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

1. **One approval or two** — RESOLVED: **both, but the second only when it can
   change the answer** (TEAM-4525). The merge gate authorizes the merge; the
   in-pipeline ManualApproval (Telegram-bridged, §5) authorizes the deploy, and
   is SKIPPED for the one commit that is provably the merge of the SHA the merge
   gate approved (ship-approval record → `DEPLOY_PREAPPROVED` → `VariableCheck`
   stage-entry condition → Deploy-stage re-verify). Never auto-approved, and
   fail-closed: anything unproven pages the human as before.
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
  `start_deploy` / `get_build_status` / `get_build_log` / `start_ci_build`
  (PR #388) / `capabilities` — six tools, read + trigger only.
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
  banner on the Workflow board: `WorkflowBoard.tsx` polls
  `/api/pipeline/status?repo=<the run's repo>` during a ship-phase run and shows
  when a ManualApproval is waiting on that repo's own pipeline, naming it
  (silent-catch when the Pipeline module is absent).
- **Multi-target (TEAM-4336).** The pilot's one pipeline generalizes to one
  CodePipeline per repo in the CD registry (`hub-<slug>-deploy`, possibly in
  another region OR another AWS account — via an assumed `hub-cd-trigger-<slug>`
  role plus `externalId`, PR #535). The tools Lambda resolves a call's target
  from the registry
  rather than a single `PIPELINE_NAME`, and every surface derives the CI/build
  project names from the entry's `pipeline` through one shared helper
  (`pipelineProjects` / `pipelineProjectsFor`). `/api/pipeline/status` returns a
  target list with per-target error isolation, `/pipeline` renders a section per
  target, and the board's banner is scoped to the run's own repo so it can never
  invite approval of another repo's deploy. `PutApprovalResult` remains absent
  from the tools Lambda — the gate stays human at any number of targets.
  **Known cross-account gap:** only the `Pipeline___*` tools Lambda assumes the
  `hub-cd-trigger-<slug>` role. The read/observe surfaces — `src/lib/pipeline/status.ts`
  (behind `/pipeline`) and the Telegram deploy-gate bridge (`deploy/telegram-bug-intake/`)
  — still build their AWS clients from ambient hub-account credentials and drop the
  entry's `roleArn`/`externalId`. So a cross-account pipeline can be *triggered*, but
  `/pipeline` cannot read its status and Telegram cannot discover or approve its
  ManualApproval gate; that account's deploy can park unnoticed. Closing it means
  threading assumed-role credentials through both surfaces.
