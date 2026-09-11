# Agents Own CD — operating model

How the release manager (RM) and CI agent drive the deploy pipeline in
PIPELINE mode, and where the humans sit. Design + rationale:
[`cicd-pipeline-module-design.md`](cicd-pipeline-module-design.md); stage
walkthrough: [`pipeline-quickstart.md`](pipeline-quickstart.md).

## Which repos the hub deploys at all — the CD registry

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
(where that pipeline lives — absent means the hub's own region), and optionally
`ciProject` (the repo's CodeBuild PR-check project) and `iosPipeline` (an
optional **second** pipeline for the same repo — the iOS App Store release,
`hub-<slug>-ios-deploy`; see [`ios-cd-pipeline.md`](ios-cd-pipeline.md)). Everything else is derived
from the pipeline name, by one rule shared by every surface —
`pipelineProjects()` in `lambda/orchestrator/cd-registry.mjs` and its TS mirror
`pipelineProjectsFor()` in `src/lib/cd-registry.ts`:

```
pipeline: hub-<slug>-deploy
  → ciProject     hub-<slug>-ci      (unless the entry names one explicitly)
  → buildProject  hub-<slug>-build
  → deployProject hub-<slug>-deploy
```

`iosPipeline`, when present, derives its own macOS projects by the same rule from
its base `hub-<slug>-ios`: `hub-<slug>-ios-{ci,build,deploy}`. It is a `hub-*-deploy`
name so it reuses the same IAM wildcards, and is never the tools Lambda env default,
so an agent must name it explicitly.

`slug` = the repo name, lowercased, every run of `[^a-z0-9]+` collapsed to `-`,
trimmed of leading/trailing `-`, truncated to 40 chars. A pipeline name that does
not end in `-deploy` is used as the base as-is (`juno` → `juno-ci` / `juno-build`).
`hub-` is a **reserved prefix** for hub-managed pipelines; the hub's own resources
keep their historical `agentcore-hub-*` names, so `agentcore-hub-deploy` derives
`agentcore-hub-ci` / `agentcore-hub-build`.

`POST /api/workflow/cd-registry` shape-validates every field (`repo`, `region`,
`pipeline`, `iosPipeline`, `ciProject`, `deployDoc`, `notes`) before it reaches S3 —
`validateCdEntryInput` in `src/lib/cd-registry.ts` — and rejects with
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

Onboarding a new repo means creating its pipeline(s) and adding the entry.
`deploy/cd-connect/` ships the templates for a team to stand this up in its own
account: a cross-account trust role, a backend repo-pipeline stack, and the iOS
App Store release stack, each with a README.

## The RM loop (trigger → watch → fix ticket → re-trigger)

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

## The deploy gate is human-only

The in-pipeline **ManualApproval** stage is a second gate beyond the merge
gate: the merge gate authorizes the merge, the deploy gate authorizes shipping
the built artifacts. It is bridged to Telegram by the `telegram-bug-intake`
poller: it polls `GetPipelineState`, atomically claims the approval token in
DynamoDB (exactly one ping per wait), and sends Approve / Reject inline
buttons that map to `PutApprovalResult`. The tools Lambda **deliberately has
no `PutApprovalResult`** — an agent can never approve its own deploy. The
bridge is gated by `DEPLOY_PIPELINE_NAME` on that Lambda (unset = no-op).

## CI two-lane policy (summary)

On a red build, the CI agent classifies the failure
(see [`blueprints/ci-agent.md`](../blueprints/ci-agent.md) P2a for the full
rules):

- **Mechanical lane — self-fix.** Whitelist-only (prettier, `eslint --fix`,
  import ordering, lockfile regen); default-deny anything else. Run the tool,
  never hand-edit; single pass; scope-capped to files already in the diff;
  re-verify green on the **new** head SHA via `Pipeline___get_build_status`.
- **Logic lane — ticket.** Anything touching source logic gets a grouped fix
  ticket to the owning dev. Mixed failures: auto-fix the mechanical, ticket the
  logic, FAIL until the tickets land.

## Ship merge-verify completion gate

The orchestrator refuses to finalize a ship-phase workflow when it can prove
the feature branch is unmerged (emits `workflow.cd_unmerged` and leaves the
run open) — a CD ticket marked done without a real merge can no longer
false-complete a run. Best-effort: a GitHub/API failure never blocks a
legitimate completion. Opt-out: `SHIP_MERGE_VERIFY=off`.

## Deploy-gate banner in the UI

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
