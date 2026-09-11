# iOS App Store release — a second CD pipeline per repo

A repo the hub delivers can ship **two** things: its AWS backend/web surfaces
(the `pipeline`) and its iOS app (the `iosPipeline`). Both are hub-triggered,
both keep every ship decision behind a human gate, and one CD-registry entry
carries both. This doc is the hub-side view; the standup kit an app team runs in
its own account is [`deploy/cd-connect/`](../deploy/cd-connect/).

Read [`agents-own-cd.md`](agents-own-cd.md) first — the iOS pipeline is the same
"agents own CD, humans own the gate" model with a second pipeline name.

## Why two pipelines

The backend and the App Store submission are unrelated release trains: one
deploys Lambdas/CDK on merge, the other archives + signs a macOS build, ships it
to TestFlight, and (after a human says so) submits it to App Store review. They
have different build hosts (App Store builds need **macOS/MAC_ARM CodeBuild**,
which has no on-demand compute — a reserved fleet is required), different
credentials (signing cert + provisioning profile + App Store Connect API key),
and different cadences. Splitting them means a backend fix does not re-submit the
app, and an app resubmit does not redeploy the backend. A run can trigger either
or both.

## The registry field

`config/cd-registry.json` gains an optional `iosPipeline` per entry (see
[`src/lib/cd-registry.ts`](../src/lib/cd-registry.ts) and the orchestrator mirror
[`lambda/orchestrator/cd-registry.mjs`](../lambda/orchestrator/cd-registry.mjs)):

```jsonc
{
  "repo": "owner/app",
  "pipeline": "hub-app-deploy",        // backend — what pipelineMode gates
  "iosPipeline": "hub-app-ios-deploy", // iOS App Store release (optional)
  "region": "<region>",
  "account": "<account>", "roleArn": "arn:aws:iam::<account>:role/hub-cd-trigger-app", "externalId": "<value>"
}
```

`iosPipeline` is validated with the same CodePipeline-name rule as `pipeline`.
By convention it is `hub-<slug>-ios-deploy` — a **`hub-*-deploy` name**, chosen
so it:

- reuses the existing `hub-*-deploy` IAM `StartPipelineExecution` wildcard on the
  tools Lambda — **zero new grant**;
- derives its CodeBuild projects through the same `pipelineProjects()` convention
  (base `hub-<slug>-ios` → `hub-<slug>-ios-{ci,build,deploy}`);
- is **never** the tools Lambda's env default (`PIPELINE_NAME`), so it can never
  win an unqualified `Pipeline___*` call — the agent must name it.

Cross-account is unchanged: the same `hub-cd-trigger-<slug>` role + `externalId`
already covers both pipelines, because the role is scoped to `hub-<slug>-*`.

## What the hub does with it

**resolveDelivery** carries `iosPipeline` (or `null`) on a registered repo, and
`null` on a handoff. **deliveryModeContext** — the `## Delivery Mode` block every
persona sees — adds, when present:

```
ios_pipeline_name: hub-app-ios-deploy
ios_pipeline_region: <region>
```

plus a line stating the App Store submit gate is human-only.

The **release manager** ([`blueprints/release-manager.md`](../blueprints/release-manager.md))
drives the iOS pipeline with the **same `Pipeline___*` tools** as the backend,
passing `pipeline_name=<ios_pipeline_name>`. If a run has both, it ships the
backend first, confirms success, then the iOS pipeline. It watches each to a
terminal state and surfaces the App Store submit gate as a human decision it must
**never** approve — the tools Lambda deliberately has no `PutApprovalResult`, so
neither the hub nor any agent can pass a deploy or submit gate.

## The pipeline shape (in the app team's account)

`Source → Build → Approval → Deploy`:

- **Build** (macOS): `xcodebuild archive` → export a signed IPA → upload to
  TestFlight (`xcrun altool` / App Store Connect API). No gate — a green Build
  means the build is already on TestFlight for internal testers.
- **Approval**: the human "submit to App Store" gate, bridged to Telegram like
  the backend deploy gate.
- **Deploy**: submit the uploaded build to App Store review.

Signing material lives in Secrets Manager, LLM-blind, and is granted to the
build/deploy roles by path — never in the repo, the registry, or a prompt.
Source `DetectChanges` is off, so a merge does not auto-ship the app; the release
manager calls `Pipeline___start_deploy`.

Standing it up: [`deploy/cd-connect/ios/`](../deploy/cd-connect/ios/) (CFN
template + buildspecs + README). Shared trust role:
[`deploy/cd-connect/hub-cd-trigger-role.cfn.yaml`](../deploy/cd-connect/hub-cd-trigger-role.cfn.yaml).
