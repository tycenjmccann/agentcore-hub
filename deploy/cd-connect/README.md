# Connect your repo to the AgentCore Hub for CD

This kit lets a team that owns an app in **its own AWS account** have the hub
**trigger + watch** its deploy pipeline(s) — while every ship decision stays a
human gate and the hub never gets deploy credentials.

A repo can have up to **two** pipelines, both hub-triggered from one registry
entry:

| Pipeline | Name | Template | Ships |
|---|---|---|---|
| Backend / web | `hub-<slug>-deploy` | [`backend/hub-repo-pipeline.cfn.yaml`](backend/hub-repo-pipeline.cfn.yaml) | your AWS surfaces (per DEPLOY.md) |
| iOS App Store release | `hub-<slug>-ios-deploy` | [`ios/hub-ios-release-pipeline.cfn.yaml`](ios/hub-ios-release-pipeline.cfn.yaml) | the app: build + sign → TestFlight → App Store submit |

Both are `hub-<slug>-*deploy` names, so **one** trigger role
([`hub-cd-trigger-role.cfn.yaml`](hub-cd-trigger-role.cfn.yaml), scoped to
`hub-<slug>-*`) covers both, and the hub resolves every project by convention
with no per-repo config.

The hub reaches your pipelines by assuming that one trigger-only role. It can
read state and press "start". It **cannot** approve any deploy or App Store
submit gate (no `codepipeline:PutApprovalResult` anywhere in its reach) and has
no other access to your account.

## Naming convention (required — this is how the hub finds your resources)

| Resource | Backend | iOS release |
|---|---|---|
| CodePipeline | `hub-<slug>-deploy` | `hub-<slug>-ios-deploy` |
| Deploy project | `hub-<slug>-deploy` | `hub-<slug>-ios-deploy` |
| Build project | `hub-<slug>-build` | `hub-<slug>-ios-build` |
| CI (PR-check) project | `hub-<slug>-ci` | `hub-<slug>-ios-ci` |
| Trust role (shared) | `hub-cd-trigger-<slug>` | `hub-cd-trigger-<slug>` |

## Order

1. **Trust role first**, once per repo: `hub-cd-trigger-role.cfn.yaml` (see its
   header). Covers both pipelines.
2. **Backend pipeline** (if you have AWS surfaces): [`backend/README.md`](backend/README.md).
3. **iOS release pipeline** (if you ship an app): [`ios/README.md`](ios/README.md).
4. **Register** with the hub owner.

## The registry entry

A repo with both pipelines is one entry. `pipeline` is the backend deploy;
`iosPipeline` is the App Store release; `region`, `account`, `roleArn`,
`externalId` are shared:

```jsonc
{
  "repo": "owner/app",
  "pipeline": "hub-app-deploy",
  "iosPipeline": "hub-app-ios-deploy",
  "region": "<your-region>",
  "account": "<your-12-digit-account>",
  "roleArn": "arn:aws:iam::<your-account>:role/hub-cd-trigger-app",
  "externalId": "<the value you chose>"
}
```

Same-account (the hub's own account) omits `account`/`roleArn`/`externalId`. A
repo with only an app and no AWS backend sets `iosPipeline` and omits `pipeline`.
Edit the registry via the hub's Workflow tab → CD registry…, `scripts/cd-registry.sh`
(`--pipeline`, `--ios-pipeline`, …), or `POST /api/workflow/cd-registry`.

## What the hub does with it

- The release manager sees a `## Delivery Mode` block naming both pipelines. It
  drives each with the same `Pipeline___*` tools, passing `pipeline_name`.
- `Pipeline___start_deploy` → `StartPipelineExecution`. The pipeline runs Source
  → Build, then STOPS at its human gate (deploy gate for backend; App Store
  submit gate for iOS).
- A human approves in **your** console (or via the hub's Telegram bridge, if the
  hub owner subscribes it to your `ApprovalTopicArn`). Only then does the final
  stage run. The hub **never** approves either gate.

## Security summary

- Hub → your account = one role, `sts:AssumeRole` with ExternalId, read +
  `StartPipelineExecution` only, scoped to `hub-<slug>-*`.
- No `PutApprovalResult` in the hub's reach → the hub starts a pipeline, a human
  always ships.
- Deploy/signing credentials never leave your account and are never assumable by
  the hub. Signing certs, provisioning profiles and the App Store Connect key
  live in Secrets Manager and are read only by your build containers.
