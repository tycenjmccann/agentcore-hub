# The DEPLOY.md Contract

Every repository that the SDLC pipeline deploys MUST carry a `DEPLOY.md` at its
root. It is the single authority the release manager executes after a human
approves the merge gate — the agent runs exactly what the contract declares,
nothing more. **No `DEPLOY.md` → the CD ticket is BLOCKED and nothing merges or
deploys.**

This is what makes CD safe across very different stacks (Next.js on ECS,
Lambda fleets, iOS apps, static sites): the nuance lives in the repo that owns
it, versioned and reviewed like code, instead of in an agent's judgment.

When the repo has a deployed CI/CD pipeline (see
[`cicd-pipeline-module-design.md`](cicd-pipeline-module-design.md)), the
pipeline executes the buildspec form of the contract and the release manager
only triggers/watches it — `DEPLOY.md` remains the contract source the
buildspecs are ported from.

## Why a file, not config

- **Reviewed with the code.** A change to how a repo deploys is a diff in the
  same PR — the code reviewer and the human gate see it.
- **LLM-blind secrets.** The contract names secrets (Secrets Manager keys);
  values are resolved by the environment at execution time. An agent never
  needs, sees, or prints a credential.
- **Deterministic.** The agent's discretion is reduced to "did the command
  exit 0 and match the expected output" — not "what's the right way to deploy
  this".

## Required sections

### `## Staging deploy`
Exact commands, in order, runnable from a fresh clone of the merge commit.
Each command on its own fenced line. Assume nothing that `## Environment
prerequisites` doesn't declare.

### `## Smoke checks`
One entry per check: the command AND the expected output (exit code, HTTP
status, string match). A check without a declared expectation cannot pass.
These run after every deploy, staging and production alike.

### `## Rollback`
A SINGLE command that restores the previous good state. If rollback genuinely
takes more than one command, wrap them in a script committed to the repo and
reference that. The release manager runs this immediately on any deploy or
smoke failure — it must be safe to run unconditionally.

### `## Required secrets`
Secrets Manager names (or SSM parameter names) only — never values, never
account-specific ARNs if a name suffices. The release manager verifies they
exist before deploying and reports missing ones by name.

### `## Environment prerequisites`
Tools, versions, AWS profile/role expectations, region — anything the commands
assume. Missing prerequisite = BLOCKED, not improvised.

## Optional keys

### `auto_promote: staging-green`
Put this literal line anywhere in the file to authorize the production section
to run automatically when ALL staging smoke checks pass. Without it the
pipeline stops after staging and production stays a manual act.

### `## Production deploy`
Same shape as staging. Only executed under `auto_promote` (or by a human).

## iOS repos

Declare the App Store Connect pieces in the same sections: TestFlight upload
command (via the CodeBuild macOS gateway), the ASC API key's Secrets Manager
name under `## Required secrets`, and a TestFlight processing check under
`## Smoke checks`. Secrets wiring for ASC is phase 2 — until then an iOS
DEPLOY.md without provisioned secrets will correctly report BLOCKED with the
missing names.

## Template

```markdown
# DEPLOY.md

## Environment prerequisites
- AWS CLI v2, profile `<profile>` (region us-east-1)
- Node 20 / npm 10

## Required secrets
- my-app/staging/api-key   (Secrets Manager)

## Staging deploy
```bash
npm ci
npm run build
npx cdk deploy MyAppStaging --require-approval never
```

## Smoke checks
```bash
curl -sf https://staging.example.com/health   # expect HTTP 200, body {"ok":true}
npm run test:smoke                            # expect exit 0
```

## Rollback
```bash
./scripts/rollback-staging.sh   # redeploys the previous CDK asset
```

## Production deploy
```bash
npx cdk deploy MyAppProd --require-approval never
```

auto_promote: staging-green   <!-- remove to keep prod manual -->
```

## Validation checklist (for authors)

- [ ] Fresh-clone runnable: every command works from a clean checkout with only the declared prerequisites
- [ ] Every smoke check declares its expected output
- [ ] Rollback is one command and safe to run unconditionally
- [ ] No secret values, account IDs, or personal paths anywhere in the file
- [ ] `auto_promote` present only if unattended prod deploys are truly intended
