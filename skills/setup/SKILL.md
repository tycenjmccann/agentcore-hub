---
name: setup
description: Guided AgentCore Hub setup. Asks the user which modules they want, generates .env.local, and runs only the deploy scripts those modules need — with a verification gate between phases.
---

# /agentcore-hub:setup — AgentCore Hub guided installer

You are running this skill from the root of an `agentcore-hub` clone. Your job is to install AgentCore Hub for the user by:

1. Asking 4–6 questions to figure out what they want (use `AskUserQuestion`, not free-text).
2. Detecting their AWS account/region from their existing credentials.
3. Writing a `.env.local` from their answers (never overwrite an existing one — back up to `.env.local.bak` first).
4. Running the deploy scripts for the modules they picked, in the right order.
5. Pausing after each phase to verify it worked. If a verification fails, surface the actual error and ask the user how to proceed.

**Authoritative references** — read these before doing anything else, they describe the system you're installing:
- `docs/MODULES.md` — module boundaries + per-module file lists
- `README.md` Stages 1–6 — the manual setup this skill automates
- `.env.example` — every env var that may need a value

You are a runner over scripts that already exist in the repo. **Never invent new infra or new scripts.** If something the user wants isn't covered by an existing script in `deploy/`, `scripts/`, or alongside Lambda source under `lambda/<name>/deploy.sh`, tell them and link to the README section instead.

---

## Pre-flight (run silently before Q1)

Run these in parallel and use the results in the questions below:

```bash
pwd                                     # confirm we're in an agentcore-hub clone
test -f package.json && cat package.json | head -5
aws sts get-caller-identity 2>&1        # detect account; capture failures to report in Q3
aws configure get region 2>&1           # detect region
test -f .env.local && echo "EXISTING_ENV_LOCAL"
```

If `pwd` doesn't look like an `agentcore-hub` repo (no `package.json` with `agentcore-hub` in it, or no `docs/MODULES.md`), stop and tell the user to `cd` into the repo first.

If `.env.local` already exists, tell the user up-front: "Found existing `.env.local` — I'll back it up to `.env.local.bak` before writing." Don't ask permission for the backup; just do it when you write the new file.

---

## Q1 — Brand name

- **question:** "Would you like to replace the AgentCore Hub branding with your own brand or company name? This changes the name shown in the header, sidebar, and page titles. AWS resources keep the canonical `agentcore-hub-*` prefix so the app keeps working."
- **header:** "Brand"
- **options:**
  1. *Keep "AgentCore Hub"* — no change to the UI branding.
  2. *Use a custom name* — I'll type the brand or company name to display.

If the user picks "Custom", do a free-text follow-up. Save as `brand_name` in the answers blob. This becomes `NEXT_PUBLIC_BRAND_NAME` in `.env.local`.

> **The user has confirmed this is the contract:** the brand var only affects display text. AWS resource names (DynamoDB tables, Lambdas, IAM roles, S3 bucket prefix, AgentCore runtimes) are part of the application contract and are *always* created with the canonical `agentcore-hub-*` prefix. Do not offer to rename them. If a user asks, point them at the design-lock section in `.claude-plugin/README.md`.

## Q2 — Modules

**Before asking, print a short module overview** so the user can answer with eyes open. Read counts/lambdas from `docs/MODULES.md` and `src/config/agents.json`; do not hard-code them in the skill output if they've drifted. Format:

```
This install can deploy four modules. You'll always get Core; the rest are optional.

  Core           — always installed. Dashboard, Agents browser, Invoke console.
                   No new AWS resources beyond credentials.
  Builder        — adds /build (chat-driven agent creation). Deploys 1 AgentCore
                   harness runtime (agentcore_hub_builder) + 1 Lambda
                   (builder-tools). ~3–5 min.
  Workflow       — adds the multi-agent pipeline (intake → requirements → design
                   → development → QA). Deploys 14 AgentCore Runtime agents
                   (1 Requirements + 8 Design + 3 Development + 1 QA + 1 Review),
                   3 DynamoDB tables, 1 S3 bucket, 4 Lambdas (orchestrator,
                   tickets, jira, workflow-output), and an ECR image. ~10–15 min.
                   Depends on: Core. Optionally uses Jira Cloud for tickets.
  Evaluations    — adds the self-improvement loop. Deploys 3 Lambdas
                   (eval-packager, token-aggregator, prd-submitter), 1 DynamoDB
                   table (agentcore-hub-eval-config), and CloudWatch
                   subscription filters. ~5 min.
                   Depends on: Workflow (it watches Workflow agents' eval logs).
```

Then ask via `AskUserQuestion`:

- **question:** "This application is modular — you can deploy as many or as few modules as you'd like depending on your use case and the time you have for install. You can deploy additional modules later by re-running /agentcore-hub:setup. Which modules would you like to install?"
- **header:** "Modules"
- **options** (single-select):
  1. *Core only* — Explore agents already deployed in your account. No new AWS resources are created. Fastest path to a working UI.
  2. *Core + Builder* — Adds chat-driven agent creation (`/build`). Deploys 1 AgentCore harness runtime + 1 Lambda. ~3–5 min.
  3. *Core + Builder + Workflow (Recommended)* — Adds the full multi-agent pipeline. Deploys ~15 AgentCore runtimes, 5 Lambdas, 3 DynamoDB tables, and an S3 bucket. ~15–20 min.
  4. *Everything* — Adds the self-improvement evaluation loop on top of #3 (3 more Lambdas, 1 DynamoDB table, CloudWatch subscription filters). ~20–25 min total.

Map the answer to a `MODULES` set in the canonical order `core → builder → workflow → evaluations`. Enforce dependency order: if the user picks Evaluations they must also have Workflow; if they pick Workflow they must also have Core. The four presets above already encode this — if you ever offer a custom selection, validate before continuing.

> **Hard rule:** never reorder the modules. `run-module.sh` runs them in the order you give it, and downstream modules read state written by earlier ones (e.g., Evaluations subscribes to log groups created by Workflow's runtime fleet).

## Q3 — Ticket store *(skip if Workflow not in MODULES)*

- **question:** "The Workflow module uses tickets to orchestrate and assign work between agents. Will you use Jira Cloud, or our built-in DynamoDB system?"
- **header:** "Ticket store"
- **options:**
  1. *Built-in DynamoDB (Recommended for first run)* — We create the `agentcore-hub-tickets` table for you. No external accounts, no extra credentials. Tickets are visible in the app's Tickets tab.
  2. *Jira Cloud* — Tickets are created and updated as Jira issues in your existing project. You'll need your site URL, email, API token, and project key. Best fit if your team already lives in Jira.

If they pick Jira, do a follow-up `AskUserQuestion` (or accept free text via "Other") for `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`. Treat these as secrets — do not echo them back, do not write them anywhere except `.env.local`.

## Q4 — Workflow runtime topology *(skip if Workflow not in MODULES)*

Before asking, print this framing so the user understands what's happening and where it can go:

```
The Workflow module ships 14 personas across four pipeline phases:
  • requirements (1)  – analyst that scopes the work and creates tickets
  • design        (8) – iOS, Android, frontend, backend, security, legal,
                        localization, analytics
  • development   (3) – frontend, backend, API
  • verification + review (2) – QA, CI

How those personas map to AgentCore runtimes is up to you. We default to ONE
runtime that hosts all 14 personas: per-persona prompts live in S3 and the
runtime loads the right one per invocation, caching it for the life of the
microVM. Edit a prompt in S3 and the next session picks it up — no redeploy.

The setup is designed to grow. When a team is ready to own their agent —
different model, separate scaling, isolated logs and metrics — re-run
/agentcore-hub:setup and split that persona out. The end-state most teams reach is one runtime per
team-owned agent. You don't have to start there.
```

Then ask via `AskUserQuestion`:

- **question:** "Workflows are executed by agents. You can use one agent with 14 personas, 4 agents with assigned personas per phase, or 14 individual agents. We recommend starting with 1 agent / 14 personas to limit overhead and expand as the need for different tools and customizations grow. Which would you like?"
- **header:** "Runtimes"
- **options:**
  1. *1 agent, 14 personas (Recommended)* — One AgentCore runtime hosts every persona. Per-persona prompts live in S3 and load per invocation. Cheapest to run, fastest to deploy (~3 min), and easiest to evolve: edit a prompt in S3 and the next session picks it up — no redeploy. You can split agents out later as needs grow.
  2. *4 agents, one per pipeline phase* — Separate runtimes for requirements, design, development, and QA+CI. Each phase can scale, log, and (eventually) run a different model independently. ~6 min to deploy.
  3. *14 agents, one per persona* — Full isolation. Per-agent model/config, separate log groups, separate scaling. Best when teams already own individual agents and need full customization. ~10–15 min to deploy.

Save the answer as `workflow_runtimes` (`1`, `4`, or `14`) in the answers blob. `apply-env.sh` writes it to `.env.local` as `WORKFLOW_RUNTIME_COUNT`. `run-module.sh workflow` invokes `deploy/runtime-agent/deploy-topology.sh`, which branches on this value:
  - `1` → deploy `agentcore_hub_requirements_analyst` as the shared runtime; write its ARN into all 14 `runtimeArn` fields in `src/config/agents.json`.
  - `4` → deploy `requirements_analyst`, `backend_designer`, `backend_dev`, and `qa_verifier` as anchors; map each persona to its phase's anchor (verification + review both go to the QA anchor).
  - `14` → delegate to the existing `deploy-fleet.sh` (one runtime per persona).

In every mode `deploy-topology.sh` syncs all 14 prompts to `s3://$ARTIFACT_BUCKET/prompts/` and uploads the rewritten `agents.json` to `s3://$ARTIFACT_BUCKET/config/agents.json` — that's how the runtime resolves per-persona prompts and how the orchestrator/Jira Lambdas (DL-023) discover the right `runtimeArn` at cold start.

> **No application code changes are required across these three modes** — the orchestrator resolves per-agent via `agents.json` `runtimeArn`, and the runtime resolves per-persona prompts via `prompts/{agentId}.txt`. Topology is purely a deploy + mapping concern.

## Q5 — AWS target

Use the pre-flight detection result:

- If `aws sts get-caller-identity` succeeded, default the option label to `Use detected: <account>/<region>`.
- If it failed, the only option is "Configure credentials and re-run" — abort the skill with a pointer to the README's prerequisites section.

- **question:** "This installer creates real AWS resources in the account your credentials point to. We detected `<account>` in `<region>`. Use this account, or switch to a different AWS profile?"
- **header:** "AWS target"
- **options:**
  1. *Use detected: `<account>` in `<region>` (Recommended)* — Continues with the credentials already in your environment.
  2. *Use a different AWS profile* — I'll name a profile from `~/.aws/credentials` and we'll switch to it.
  3. *Cancel* — Stop without creating anything.

Set `AWS_PROFILE` and `AWS_REGION` for every subsequent shell call.

## Q6 — Deploy target

Before asking, print this framing so the user understands the trade-offs:

```
The AWS infrastructure (Lambdas, agents, DynamoDB tables, S3) deploys the
same either way. The only question is where the Next.js front-end runs.

  Locally (npm run dev)
    Fastest to iterate. App reads .env.local on your laptop.
    ⚠ If you chose Jira Cloud for tickets: Jira sends webhooks over the
      public internet, so localhost is unreachable. You'll need an
      ngrok / Cloudflare Tunnel / similar to expose port 3000, or your
      ticket transitions won't trigger workflows. (DynamoDB tickets work
      either way — they trigger via DynamoDB Streams inside AWS, not
      webhooks.)
    ⚠ If your org blocks outbound tunneling tools, App Runner is simpler.

  AWS App Runner
    Public HTTPS URL, auto-scales, your team can reach it. Builds a
    container from this repo, pushes to ECR, deploys behind an HTTPS
    endpoint. Adds ~5 min and ongoing cost (App Runner + ECR storage).
    Jira webhooks "just work" because the URL is publicly reachable.

  Bring-your-own container
    You already have a deploy target (ECS, EKS, Fargate, your own
    container host). Skip the App Runner build, and we'll record a
    placeholder DEPLOYMENT_URL you can update yourself in .env.local
    once your service is live.

  Skip
    Only create AWS infra; don't touch the Next.js app at all.
```

- **question:** "Where would you like to deploy the Next.js app? The AWS infra deploys the same in every option — this is just where the front-end runs."
- **header:** "App host"
- **options:**
  1. *Locally (Recommended for first run)* — Run `npm run dev` after setup. Fastest to iterate. ⚠ With Jira tickets, you'll need to expose `localhost:3000` via ngrok/Cloudflare Tunnel for webhooks to reach you.
  2. *AWS App Runner* — Public HTTPS URL, auto-scaling, no tunneling needed for Jira. Adds ~5 min and ongoing cost.
  3. *Bring your own container* — Skip the build; you deploy the container yourself (ECS/EKS/Fargate/etc.). We'll set a placeholder `DEPLOYMENT_URL` you'll update later.
  4. *Skip the app* — Only create AWS infra. You'll run the app yourself later.

## Q7 — GitHub integration *(skip if Workflow not in MODULES)*

- **question:** "The Workflow agents push branches and open pull requests as part of the pipeline. How should they authenticate to GitHub?"
- **header:** "GitHub"
- **options:**
  1. *Personal Access Token (Recommended)* — Paste a GitHub PAT with `repo` + `workflow` scope. Simplest path; the agents push and open PRs as you. Stored in `.env.local` only.
  2. *Custom MCP server* — Point us at a GitHub MCP server JSON config (e.g., your org runs one with SSO). Use this if a raw PAT isn't allowed by policy.
  3. *Skip* — The workflow still runs, but stops at "ready for PR" without pushing. Use this to do a dry run before committing real GitHub credentials.

## Q8 — Confirm

Print a recap of every choice plus the exact list of scripts that will run, then ask:

- **question:** "Ready to start the install? This creates real AWS resources in `<account>` (`<region>`). The full pipeline takes about 15–20 minutes; smaller selections are faster. We'll pause and verify after each phase before moving on."
- **header:** "Confirm"
- **options:**
  1. *Yes, run it* — Begin the install. We'll show progress per phase.
  2. *Show me the exact script list first* — Print every script that will run, then come back to this question.
  3. *Cancel* — Stop without creating anything.

---

## After confirmation: write `.env.local`

Build a JSON answers blob and pipe it to `bin/apply-env.sh`:

```bash
cat > /tmp/agentcore-hub-answers.json <<'EOF'
{
  "brand_name": "Bob's AI Hub",
  "modules": ["core", "workflow"],
  "ticket_provider": "dynamodb",
  "workflow_runtimes": 1,
  "aws_account": "...",
  "aws_region": "us-east-1",
  "aws_profile": "default",
  "deploy_target": "local",
  "github": { "mode": "pat", "pat": "..." },
  "jira": null
}
EOF
.claude-plugin/bin/apply-env.sh /tmp/agentcore-hub-answers.json
rm /tmp/agentcore-hub-answers.json
```

`apply-env.sh` is the one place that writes `.env.local`. The skill does **not** write env vars by hand.

---

## Run modules in order

Evaluations is deferred until **after** the deploy-target step because its
`prd-submitter` Lambda needs `DEPLOYMENT_URL` (the App Runner URL) to know where
to POST workflow-start requests. Run modules in this order:

1. `core` → `builder` → `workflow` (skip whichever the user didn't pick)
2. Deploy target step (Local / App Runner / Bring-your-own / Skip)
3. `evaluations` (if selected)

For each module run:

```bash
.claude-plugin/bin/run-module.sh <module>
.claude-plugin/bin/verify-module.sh <module>
```

If `verify-module.sh` exits non-zero, **stop**. Show the user the verification output and ask via `AskUserQuestion`:

- **question:** "Verification of `<module>` failed. What do you want to do?"
- **options:** *Retry*, *Skip this module and continue*, *Abort the whole setup*

Long-running deploys (`build-and-push.sh`, `deploy-fleet.sh`, App Runner deploy) should be delegated to the `deploy-runner` subagent so their multi-MB output doesn't dominate this conversation. Pass the subagent the exact script path and the env vars it needs.

---

## Deploy target step (between workflow and evaluations)

After Core/Builder/Workflow verify clean and **before** running Evaluations:

- **Local (`local`):** print "Run `npm run dev` to start the app at http://localhost:3000." Set `DEPLOYMENT_URL=http://localhost:3000` in `.env.local`. If the user picked Jira tickets, also remind them: "Jira webhooks can't reach `localhost` — expose port 3000 with ngrok / Cloudflare Tunnel, then update `DEPLOYMENT_URL` to the public URL or your ticket transitions won't trigger workflows."
- **App Runner (`apprunner`):** run the App Runner deploy (use the workflow in `.github/workflows/` if present, otherwise the existing `deploy/` script for App Runner if one exists; if neither exists, tell the user honestly and link to the README section). Once the service is healthy, capture the App Runner URL and persist it as `DEPLOYMENT_URL` in `.env.local` (use the same sed-or-append pattern as `BUILDER_AGENT_ID`).
- **Bring-your-own (`byo`):** don't build or push anything. Write `DEPLOYMENT_URL=https://placeholder.example` to `.env.local` and tell the user: "Update `DEPLOYMENT_URL` in `.env.local` once your service is live so prd-submitter and Jira webhooks know where to reach the app." If Evaluations was selected, surface this warning prominently — prd-submitter is being deployed with a placeholder URL.
- **Skip (`skip`):** skip both the deploy and the `DEPLOYMENT_URL` write. If Evaluations was selected, warn the user that prd-submitter will be deployed with a placeholder URL and they must update it manually.

After this step, run Evaluations (if selected) so it picks up the freshly written `DEPLOYMENT_URL`.

---

## Final gate: end-to-end test suite

After every selected module verifies clean **and** the deploy-target step is done, run the full Playwright test suite. This is the only signal that the install is actually working — existence checks and HTTP 200s are not proof of function.

The repo exposes `npm run test:full`, which runs `./tests/run-all.sh --full`:
- Tab tests (`tests/tab-*.spec.ts`)
- API smoke (`tests/e2e-api-routes.spec.ts`)
- Real end-to-end workflow (`tests/e2e-workflow-full.spec.ts`)

Branch on `deploy_target`:

- **`local`:** before running the suite, ensure the dev server is up. If `npm run dev` is not already running on port 3000, start it in the background and wait until `http://localhost:3000` returns 200. Set `DEPLOYMENT_URL=http://localhost:3000` in the test env. Then delegate `npm run test:full` to the `deploy-runner` subagent (the multi-MB Playwright output would otherwise dominate the conversation).
- **`apprunner`:** confirm `DEPLOYMENT_URL` is the App Runner URL (was just persisted by the deploy-target step). Pass it as `DEPLOYMENT_URL` env var to `npm run test:full`. Delegate to `deploy-runner`.
- **`byo` or `skip`:** the test suite needs the app running and there is no app to point at. Tell the user honestly:

  > "I can't run the end-to-end test suite — your container isn't deployed yet (or you chose Skip). Once your service is live and `DEPLOYMENT_URL` in `.env.local` points at it, run this from the repo root to validate the install: `DEPLOYMENT_URL=<your-url> npm run test:full`. Until that passes, treat the install as unverified."

  Print a yellow warning and proceed to the success summary, but mark the install as "deployed but not validated".

On test failure: surface the failing test name and the failure message from the Playwright output. Do **not** try to fix the failure yourself — ask the user via `AskUserQuestion`:

- **question:** "End-to-end test `<test name>` failed: `<short error>`. What do you want to do?"
- **options:** *Retry the suite*, *Skip and finish anyway (the install is unverified)*, *Abort*

On test pass: this is when you declare the install complete. Move any "install complete" copy here. Before this point, the install is "deployed but unvalidated."

---

## Re-runs

The user may run `/agentcore-hub:setup` more than once. Before any module runs, `run-module.sh` should detect what already exists and skip steps that are already done (the underlying scripts are idempotent — they exit 0 if the resource exists). Never wipe `.env.local`. Never delete AWS resources.

---

## Hard rules

- **AWS_PROFILE / AWS_REGION:** every `aws` call must pass them through. Never assume `default`.
- **Secrets:** Jira tokens / GitHub PATs go from the prompt straight into `.env.local`. Do not log them, do not echo them, do not write them to a temp file that lingers.
- **No new infra:** if a user request would require a script that doesn't exist in `deploy/`, `scripts/`, or `lambda/<name>/deploy.sh`, refuse and link to `README.md` / `docs/MODULES.md`.
- **Real errors only:** if a script fails, show the user the actual stderr and the script that produced it. No "something went wrong, check logs."
- **No README duplication:** "next steps" output should link to `README.md` and `docs/MODULES.md` rather than restating them.
- **No in-session script authoring:** when `verify-module.sh` reports a missing resource, you may NOT write a new deploy script, IAM policy, or aws CLI patch to fix it in this session. Stop, surface the gap to the user, and offer Retry / Skip-this-module / Abort. Real fixes belong in a PR to the repo so the next install benefits — not in the install session that found the gap.
- **Do not declare success early:** the install is not complete until `npm run test:full` passes. Existence checks and HTTP 200s are not proof of function. If the test suite was skipped (deploy_target was `byo` or `skip`), the install is "deployed but unvalidated" — say that, don't say "complete".
