# Onboarding an iOS app to the hub release pipeline

A field guide for wiring a new iOS app to `hub-<slug>-ios-deploy`. It captures the
recipe that actually works on the hub's **shared reserved Mac fleet** and every
trap we hit doing it the first time (Brush Up, 2026-09-11). Read the Gotchas table
before you start — most of a day was lost to items #1 and #7.

---

## What you end up with

`Source → Build → Approval → Deploy`, a V2 CodePipeline:

- **Source** — your `main` branch. Change detection is OFF, so a merge does not
  ship. A release is started on purpose.
- **Build** — archives the app, signs it, uploads it to TestFlight. No gate.
- **Approval** — a human "submit to the App Store" gate. The hub cannot pass it.
- **Deploy** — submits the already-uploaded build to App Store review (App Store
  Connect API only, no signing).

TestFlight is automatic; the App Store is gated. Internal testers get every build
immediately; a real submission needs a human click.

---

## Pick your signing path first

This is the single most important decision and the source of most of the pain.

**Reserved Mac fleets come in two flavors:**

| Fleet | Has a login/GUI + securityd session? | Signing path |
|---|---|---|
| A **dedicated** fleet you create and run one build at a time | usually yes | keychain + fastlane works |
| The **hub's shared** `ios-agent-tests` fleet (reused across CI/test/release) | **NO** | keychain import is **refused**; you MUST sign keychain-free |

If you reuse the hub's shared fleet (recommended — macOS compute is expensive and
you should not stand up a second one), **use the keychain-free path**: `rcodesign`
to sign + `altool` to upload. The example buildspec in this kit is already written
that way. Do not try to "fix" the keychain approach on the shared fleet; it cannot
be fixed from inside the build (see Gotcha #1).

---

## Step 0 — Prerequisites

- Apple Developer account + an App Store Connect app record for your bundle id.
- An **App Store Connect API key** (`.p8`), App Manager role. Used for both upload
  and submit, so no Apple ID / 2FA in CI.
- A **distribution certificate** + an **App Store provisioning profile** for the
  bundle id. Create a dedicated CI cert so you can revoke it without touching your
  laptop's cert. (Both can be created via the ASC API.)
- Access to the account+region where the pipeline runs (for Brush Up: the hub
  account, us-east-1). macOS has no on-demand compute, so you need a MAC_ARM
  reserved fleet ARN to reuse.

---

## Step 1 — Signing material into Secrets Manager (LLM-blind)

Never commit these, never put them in the registry or any agent prompt. One path
prefix, e.g. `hub-<slug>-ios`:

| Secret | Contents |
|---|---|
| `<path>/dist-cert-pem` | **cert + private key as PEM** (what the build reads) |
| `<path>/provisioning-profile` | base64 of the `.mobileprovision` |
| `<path>/asc-api-key-p8` | the ASC API key `.p8` (raw) |
| `<path>/asc-key-id`, `<path>/asc-issuer-id` | the key's ID + issuer ID |

`rcodesign` reads a cert+key **PEM**, not a `.p12`. Convert your `.p12` once, on a
Mac (see Gotcha #2 — do this with the system LibreSSL, not OpenSSL 3):

```bash
# reads a legacy .p12 that OpenSSL 3 chokes on; -nodes leaves the key unencrypted
/usr/bin/openssl pkcs12 -in dist.p12 -passin pass:'<p12-password>' -nodes -out dist.pem
# dist.pem now holds the private key + your dist cert + the WWDR intermediate
aws secretsmanager create-secret --name hub-<slug>-ios/dist-cert-pem \
  --secret-string file://dist.pem --region <region>
```

The PEM is KMS-encrypted at rest in Secrets Manager and only the build role can
read it. Store the raw `.p8` and the profile the same way. You can keep the
original `.p12`+password as extra secrets, but the keychain-free build does not use
them.

Pass `SigningSecretsPath=arn:aws:secretsmanager:<region>:<account>:secret:hub-<slug>-ios/*`
so the build/deploy roles get `GetSecretValue` on exactly these.

---

## Step 2 — Buildspecs

Copy into your repo at `.hub/`:

- `buildspec-ios-ci.yml` (from `buildspec-ios-ci.example.yml`) — PR check: build +
  unit tests on a simulator, signs nothing.
- `buildspec-ios-build.yml` (from `buildspec-ios-build.example.yml`) — the
  keychain-free archive + sign + TestFlight upload.
- `buildspec-ios-deploy.yml` (from `buildspec-ios-deploy.example.yml`) — App Store
  submit via the ASC API.

Fill in your workspace/scheme, bundle id, and the secret path prefix. You do **not**
need an `ExportOptions.plist` with the keychain-free path.

The build recipe, in words:

1. Download `rcodesign` (pinned release, `macos-universal`), install on PATH.
2. Archive **unsigned**: `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
   CODE_SIGN_IDENTITY=""`. (See Gotcha #3 — signing overrides are global and break
   Swift Package targets.)
3. Copy the profile into the app as `embedded.mobileprovision`; extract its
   entitlements from the profile.
4. `rcodesign sign --pem-source dist.pem -e entitlements.plist <App>.app` — signs
   the main binary and every nested framework, no keychain.
5. Zip `Payload/<App>.app` into an `.ipa`.
6. `xcrun altool --upload-app -f app.ipa -t ios --apiKey <id> --apiIssuer <issuer>`
   with the `.p8` placed at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`.
7. Write `build-meta.json` (version + build number) for the Deploy stage.

Build number = UTC `yymmddHHMM`: unique and increasing without editing the project.

---

## Step 3 — Deploy the pipeline

```bash
aws cloudformation deploy \
  --template-file hub-ios-release-pipeline.cfn.yaml \
  --stack-name hub-<slug>-ios-pipeline \
  --capabilities CAPABILITY_NAMED_IAM --region <region> \
  --parameter-overrides \
      Slug=<slug> GitHubOwner=<owner> GitHubRepo=<repo> GitHubBranch=main \
      GitHubConnectionArn=<connection ARN, status AVAILABLE> \
      ExistingMacFleetArn=<shared fleet ARN> \
      SigningSecretsPath=arn:aws:secretsmanager:<region>:<account>:secret:hub-<slug>-ios/* \
      MacImage=aws/codebuild/macos-arm-base:15
```

Note the `PipelineName`, `ApprovalTopicArn`, `MacFleetArn` outputs.

---

## Step 4 — Register with the hub

Add `iosPipeline` to the repo's CD registry entry:

```bash
scripts/cd-registry.sh add <owner>/<repo> --ios-pipeline hub-<slug>-ios-deploy --region <region>
```

The hub can now start and watch the pipeline. Note: the hub bridges gates by
**polling**, not SNS — the approval topic has no subscription by default, so the
hub does not yet ping a human when the gate opens. Approve in the Console (Step 5)
until a notification bridge is wired.

---

## Step 5 — Run and approve

Start a release (any one):

- Ask the hub to run `Pipeline___start_deploy` with `pipeline_name=hub-<slug>-ios-deploy`.
- Console → CodePipeline → `hub-<slug>-ios-deploy` → **Release change**.
- `aws codepipeline start-pipeline-execution --name hub-<slug>-ios-deploy --region <region>`

Approve at the gate: open the pipeline, find the **Approval** action, **Review →
Approve**. Deploy then submits to the App Store. **Reject** to stop after
TestFlight (a validation run) — the uploaded build stays on TestFlight, nothing is
submitted.

---

## Gotchas (symptom → cause → fix)

**#1 — `security import` refuses the private key: "SecKeychainItemImport: User
interaction is not allowed."**
The shared reserved Mac boots with no login/default keychain and no securityd/GUI
session. Any private-key keychain import is refused — with `-A`, with `-T`, and via
fastlane `setup_ci` + `import_certificate` (Apple's/AWS's documented path). It is
not fixable from inside the build. → Sign keychain-free with `rcodesign`; upload
with `altool` + the ASC API key. Both avoid the keychain entirely.

**#2 — OpenSSL 3 reads "0 keys" from a valid `.p12`.**
Older Apple `.p12` files use legacy RC2-40 (`pbeWithSHA1And40BitRC2`) encryption
that OpenSSL 3 refuses by default, so it silently reports no key. The `.p12` is
fine. → Convert with the system **LibreSSL** (`/usr/bin/openssl`) or macOS
`security`, both of which read legacy encryption. Store a PEM (Step 1).

**#3 — Every Swift Package target fails to sign during archive.**
`xcodebuild` signing overrides (`CODE_SIGN_IDENTITY`,
`PROVISIONING_PROFILE_SPECIFIER`, `CODE_SIGN_STYLE=Manual`) are **global** — they
hit aws-sdk-swift, Facebook, etc., which have no profile. Automatic signing at
archive wants an Apple *Development* cert you should not ship to CI. → Archive
**unsigned** and sign the built `.app` afterward with rcodesign.

**#4 — `rcodesign` dies with `configuration file error: UnknownField("url",
["sign","remote-sign"])`.**
rcodesign merges config from a user file, a cwd file, AND `RCODESIGN_*` env vars.
The shared fleet exports stale `RCODESIGN_*` remote-signing vars from another job.
`-C /dev/null` disables the *file* configs but not the env ones. The error only
fires at `sign` time (not `analyze-certificate`). → `unset` every `RCODESIGN_*`
var before signing, and pass `-C /dev/null` **before** the subcommand.

**#5 — CodeBuild: "Expected Commands[N] to be of string type" at DOWNLOAD_SOURCE.**
Any buildspec command written as a plain scalar that contains `: ` (colon-space) or
` #` is parsed by YAML as a mapping/comment, not a string. → Put such commands in a
`- |` block scalar. Lint locally: load the buildspec with `yaml.safe_load` and
assert every command is a `str`.

**#6 — `altool` can't find the API key.**
`altool --apiKey <id>` looks for the `.p8` on disk, not inline. → Write it to
`~/.appstoreconnect/private_keys/AuthKey_<id>.p8` before calling altool. No
keychain needed.

**#7 — MAC_ARM fleet stuck at INSUFFICIENT_CAPACITY.**
New reserved Mac fleets can be backlogged for a long time across regions/sizes. →
Reuse an existing fleet ARN (`ExistingMacFleetArn`) instead of creating one. This
is why Brush Up runs in the hub account on the shared fleet.

**#8 — Signing settings vs. runtime entitlements.**
The app's real entitlements come from the **provisioning profile** (app id, team
id, `get-task-allow=false`, TestFlight `beta-reports-active`, keychain groups). Pass
the profile's entitlements to rcodesign with `-e`; do not hand-write them.

---

## Rotating the signing cert

1. Create a new DISTRIBUTION cert + App Store profile via the ASC API.
2. Convert the new `.p12` to PEM with LibreSSL (Step 1), including the WWDR
   intermediate.
3. Overwrite `dist-cert-pem` and `provisioning-profile`. No pipeline change.

The private key lives only in Secrets Manager.
