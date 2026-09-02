# Pipeline quickstart

This guide walks through what happens after you open a pull request against
`agentcore-hub`, from the required checks through to a deployed and
smoke-tested artifact.

1. A pull request triggers the GitHub Actions required checks: "Lint,
Typecheck, Unit, Build", "Runtime agent telemetry" (hermetic, no AWS access),
and "Cloud Code UI" (which runs mocked, with no AWS access). Branch
protection on `main` blocks the merge if any of these three checks comes
back red, so a broken build or a failing test suite never lands on `main`.

2. Once the pull request merges to `main`, the CodePipeline named
`agentcore-hub-deploy` starts automatically and runs four stages in order:
Source, Build, ManualApproval, and Deploy. The Build stage re-runs the same
gates as the PR check and produces the artifacts the later stages consume.
See the design doc's [pipeline topology](cicd-pipeline-module-design.md#5-pipeline-topology-pilot--hub-repo)
for the full stage-by-stage breakdown.

3. The ManualApproval stage is delivered to Telegram as a message with
Approve and Reject buttons, via the poll-based approval bridge. This is the
deploy gate, and it is distinct from the pull request's merge gate: the
merge gate authorizes the merge itself, while the pipeline approval
authorizes deploying the artifacts the Build stage already produced. See
[pipeline topology](cicd-pipeline-module-design.md#5-pipeline-topology-pilot--hub-repo)
and [agent re-scoping](cicd-pipeline-module-design.md#7-agent-re-scoping-behind-pipeline_enabled)
for how the two gates relate.

4. Approving the deploy promotes exactly what the Build stage produced: the
orchestrator Lambda zip plus the application image, promoted by its ECR
digest rather than rebuilt. This build-once, promote-by-digest approach
means the artifacts a reviewer approved are byte-identical to the ones that
reach production, since the Deploy stage never rebuilds anything. After
promotion, the Deploy stage runs `DEPLOY.md`'s `## Smoke checks` (the traces
health check and orchestrator health checks) as ported into the pipeline's
deploy buildspec, which additionally invokes the orchestrator to guard
against the INIT-crash failure class. See the design doc's
[buildspecs](cicd-pipeline-module-design.md#6-buildspecs--porting-deploymd-into-the-pipeline) section for how each command maps back to `DEPLOY.md`.

For the broader rollout plan, see the design doc's [pilot rollout plan](cicd-pipeline-module-design.md#9-pilot-rollout-plan-hub-repo).
For the exact smoke-check contract, see [`DEPLOY.md`](../DEPLOY.md).
