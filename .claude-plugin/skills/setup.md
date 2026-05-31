---
name: setup
description: Guided AgentCore Hub setup. Asks the user which modules they want, generates .env.local, and runs only the deploy scripts those modules need — with a verification gate between phases.
---

# /setup — AgentCore Hub guided installer

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

You are a runner over scripts that already exist in the repo. **Never invent new infra or new scripts.** If something the user wants isn't covered by an existing script in `deploy/` or `scripts/`, tell them and link to the README section instead.

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

- **question:** "What should this install be called in the UI? (Header, sidebar, page titles. AWS resource names are not affected.)"
- **header:** "Brand"
- **options:**
  1. *AgentCore Hub* (default)
  2. *Custom — I'll type one*

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

- **question:** "Which modules should this install deploy? (You can re-run /setup later to add more.)"
- **header:** "Modules"
- **options** (single-select):
  1. *Core only — explore agents I've already deployed* — `{core}`. No new AWS deploys beyond credentials check.
  2. *Core + Builder — chat-driven agent creation only* — `{core, builder}`. 1 runtime + 1 Lambda.
  3. *Core + Builder + Workflow — full pipeline (Recommended)* — `{core, builder, workflow}`. 15 runtimes + 5 Lambdas + 3 tables + S3 bucket. ~15–20 min.
  4. *Everything — pipeline + self-improvement eval loop* — `{core, builder, workflow, evaluations}`. Adds the eval loop on top of #3.

Map the answer to a `MODULES` set in the canonical order `core → builder → workflow → evaluations`. Enforce dependency order: if the user picks Evaluations they must also have Workflow; if they pick Workflow they must also have Core. The four presets above already encode this — if you ever offer a custom selection, validate before continuing.

> **Hard rule:** never reorder the modules. `run-module.sh` runs them in the order you give it, and downstream modules read state written by earlier ones (e.g., Evaluations subscribes to log groups created by Workflow's runtime fleet).

## Q3 — Ticket store *(skip if Workflow not in MODULES)*

- **question:** "Where will tickets live?"
- **header:** "Ticket store"
- **options:**
  1. *DynamoDB only* (Recommended for first run) — no external service; this skill creates the `agentcore-hub-tickets` table
  2. *Jira Cloud* — uses your existing Jira project; you'll need site URL, email, API token, and project key

If they pick Jira, do a follow-up `AskUserQuestion` (or accept free text via "Other") for `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`. Treat these as secrets — do not echo them back, do not write them anywhere except `.env.local`.

## Q4 — AWS target

Use the pre-flight detection result:

- If `aws sts get-caller-identity` succeeded, default the option label to `Use detected: <account>/<region>`.
- If it failed, the only option is "Configure credentials and re-run" — abort the skill with a pointer to the README's prerequisites section.

- **question:** "Which AWS account and region should this deploy to?"
- **header:** "AWS target"
- **options:**
  1. *Use detected: `<account>` in `<region>`* (Recommended)
  2. *Use a different `AWS_PROFILE`* — follow up for the profile name and re-run `aws sts get-caller-identity --profile <name>`
  3. *Cancel*

Set `AWS_PROFILE` and `AWS_REGION` for every subsequent shell call.

## Q5 — Deploy target

- **question:** "Where should the Next.js app run?"
- **header:** "Deploy target"
- **options:**
  1. *Local dev* — I'll set up infra; you run `npm run dev` after
  2. *App Runner* (Recommended for sharing) — auto-build + push via ECR
  3. *Skip app deploy* — only create AWS infra; don't touch the Next.js app

## Q6 — GitHub integration *(skip if Workflow not in MODULES)*

- **question:** "How should agents push code and open PRs?"
- **header:** "GitHub"
- **options:**
  1. *Personal Access Token* — set `GITHUB_PAT`. Follow up for the token (treat as secret).
  2. *Custom MCP server* — set `MCP_SERVERS` JSON. Follow up for the JSON blob.
  3. *Skip — agents will stop at "ready for PR"* (the workflow still runs, just no PRs created)

## Q7 — Confirm

Print a recap of every choice plus the exact list of scripts that will run, then ask:

- **question:** "Ready to start? This will make AWS API calls against `<account>` in `<region>`."
- **header:** "Confirm"
- **options:**
  1. *Yes, run it*
  2. *Show me the script list first* — print, then loop back to this question
  3. *Cancel*

---

## After confirmation: write `.env.local`

Build a JSON answers blob and pipe it to `bin/apply-env.sh`:

```bash
cat > /tmp/agentcore-hub-answers.json <<'EOF'
{
  "brand_name": "Bob's AI Hub",
  "modules": ["core", "workflow"],
  "ticket_provider": "dynamodb",
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

For each module in `MODULES` (core → builder → workflow → evaluations), run:

```bash
.claude-plugin/bin/run-module.sh <module>
```

then immediately:

```bash
.claude-plugin/bin/verify-module.sh <module>
```

If `verify-module.sh` exits non-zero, **stop**. Show the user the verification output and ask via `AskUserQuestion`:

- **question:** "Verification of `<module>` failed. What do you want to do?"
- **options:** *Retry*, *Skip this module and continue*, *Abort the whole setup*

Long-running deploys (`build-and-push.sh`, `deploy-fleet.sh`, App Runner deploy) should be delegated to the `deploy-runner` subagent so their multi-MB output doesn't dominate this conversation. Pass the subagent the exact script path and the env vars it needs.

---

## Final step: deploy target

After all modules verify clean:

- **Local dev:** print "Setup complete. Run `npm run dev` to start the app at http://localhost:3000."
- **App Runner:** run the App Runner deploy (use the workflow in `.github/workflows/` if present, otherwise the existing `deploy/` script for App Runner if one exists; if neither exists, tell the user honestly and link to the README section). Verify with the App Runner service status + a `curl` to the health endpoint.
- **Skip app deploy:** print a one-screen summary of what was created (tables, Lambdas, runtimes) and exit.

---

## Re-runs

The user may run `/setup` more than once. Before any module runs, `run-module.sh` should detect what already exists and skip steps that are already done (the underlying scripts are idempotent — they exit 0 if the resource exists). Never wipe `.env.local`. Never delete AWS resources.

---

## Hard rules

- **AWS_PROFILE / AWS_REGION:** every `aws` call must pass them through. Never assume `default`.
- **Secrets:** Jira tokens / GitHub PATs go from the prompt straight into `.env.local`. Do not log them, do not echo them, do not write them to a temp file that lingers.
- **No new infra:** if a user request would require a script that doesn't exist in `deploy/` or `scripts/`, refuse and link to `README.md` / `docs/MODULES.md`.
- **Real errors only:** if a script fails, show the user the actual stderr and the script that produced it. No "something went wrong, check logs."
- **No README duplication:** "next steps" output should link to `README.md` and `docs/MODULES.md` rather than restating them.
