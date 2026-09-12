# iOS App Store release pipeline (`hub-<slug>-ios-deploy`)

A **second** pipeline for a repo that ships an iOS app: the hub triggers it to
build + sign the app, push it to TestFlight, then — after a human approves —
submit it to App Store review. macOS CodeBuild (MAC_ARM). Independent of the
backend pipeline; a run can trigger either or both.

> **First time? Read [ONBOARDING.md](ONBOARDING.md) first.** It has the working
> keychain-free signing recipe and every trap we hit onboarding the first app
> (Brush Up). Skipping it costs about a day on the signing step alone.

Flow: **Source → Build** (archive + sign + export IPA + TestFlight upload,
automatic) **→ Approval** (human "submit to App Store" gate) **→ Deploy** (submit
the uploaded build to review). The hub cannot pass the gate — like every deploy
gate, it is human-only.

> Deploy the shared trust role first: [`../hub-cd-trigger-role.cfn.yaml`](../hub-cd-trigger-role.cfn.yaml).
> It is scoped to `hub-<slug>-*`, so it already covers this pipeline — no second
> role.

## Prerequisites

- **Apple Developer account** with an App Store Connect app record for the bundle id.
- **App Store Connect API key** (.p8) — Users and Access → Keys → App Manager
  role. Preferred over an Apple ID (no 2FA in CI). Used for BOTH the TestFlight
  upload and the App Store submit.
- **A distribution certificate + App Store provisioning profile** for the bundle
  id (make a dedicated CI cert you can revoke independently). Both can be created
  via the ASC API.
- **A MAC_ARM reserved CodeBuild fleet.** macOS has no on-demand compute. Pass an
  existing fleet ARN (e.g. the one already backing your iOS test builds) as
  `ExistingMacFleetArn`, or leave it blank to have the stack create a small one.

## 1. Put the signing material in Secrets Manager (LLM-blind)

Never in the repo, the registry, or any agent prompt. Under one path prefix (the
`SigningSecretsPath` you pass the stack, e.g. `hub-<slug>-ios`):

| Secret | Contents |
|---|---|
| `<path>/dist-cert-pem` | distribution **cert + private key as one PEM** (what the build reads) |
| `<path>/provisioning-profile` | base64 of the `.mobileprovision` (App Store profile) |
| `<path>/asc-api-key-p8` | the App Store Connect API key `.p8` |
| `<path>/asc-key-id`, `<path>/asc-issuer-id` | the key's ID + issuer ID |

`rcodesign` reads a cert+key PEM, not a `.p12`. Convert once, on a Mac, with the
system **LibreSSL** — OpenSSL 3 silently reads "0 keys" from legacy `.p12` files
(see ONBOARDING.md Gotcha #2):

```bash
/usr/bin/openssl pkcs12 -in dist.p12 -passin pass:'<pw>' -nodes -out dist.pem  # cert+key+WWDR
aws secretsmanager create-secret --name hub-<slug>-ios/dist-cert-pem \
  --secret-string file://dist.pem --region <your-region>
# ...repeat (raw, no base64) for asc-api-key-p8, asc-key-id, asc-issuer-id;
#    provisioning-profile is base64 of the .mobileprovision ...
```

Pass `SigningSecretsPath=arn:aws:secretsmanager:<region>:<account>:secret:hub-<slug>-ios/*`
so the build/deploy roles get `GetSecretValue` on exactly these secrets.

## 2. Commit the buildspecs

At `.hub/`:
- `.hub/buildspec-ios-ci.yml`     (from `buildspec-ios-ci.example.yml`) — build + XCTest, no signing
- `.hub/buildspec-ios-build.yml`  (from `buildspec-ios-build.example.yml`) — archive UNSIGNED + rcodesign + TestFlight
- `.hub/buildspec-ios-deploy.yml` (from `buildspec-ios-deploy.example.yml`) — App Store submit

Fill in your workspace/scheme, bundle id, and secret path prefix. **No
`ExportOptions.plist` is needed** — the build signs keychain-free with rcodesign
and uploads with altool (see ONBOARDING.md for why the keychain path fails on the
shared fleet).

## 3. Pipeline

```bash
aws cloudformation deploy \
  --template-file hub-ios-release-pipeline.cfn.yaml \
  --stack-name hub-<slug>-ios-pipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <your-region> \
  --parameter-overrides \
      Slug=<slug> \
      GitHubOwner=<owner> GitHubRepo=<repo> GitHubBranch=main \
      GitHubConnectionArn=<your connection ARN> \
      ExistingMacFleetArn=<arn or omit to create one> \
      SigningSecretsPath=arn:aws:secretsmanager:<region>:<account>:secret:hub-<slug>-ios/* \
      ApprovalEmail=<optional>
# Note the PipelineName + ApprovalTopicArn + MacFleetArn outputs.
```

## 4. Register with the hub owner

Add `iosPipeline` to the repo's CD registry entry (alongside `pipeline` if the
repo also has a backend). See [`../README.md`](../README.md#the-registry-entry).
Subscribe the hub's Telegram bridge to the `ApprovalTopicArn` so the App Store
submit gate reaches a human.

## Notes

- **Merge does not auto-ship the app.** Source `DetectChanges` is off; the release
  manager calls `Pipeline___start_deploy` with `pipeline_name=hub-<slug>-ios-deploy`.
- **TestFlight is automatic; the App Store is gated.** Build uploads to TestFlight
  with no gate (internal testers get it immediately); the human gate is the App
  Store submission.
- The MAC_ARM fleet is a standing (billed) resource. Reuse one fleet across your
  iOS CI, test, and release projects.
