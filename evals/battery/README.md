# Config-Evals Battery

## Overview

The battery is the regression gate for the hub's **agent configuration**: the
artifacts that change agent behavior without changing application code. A PR
touching any gated path must hold the recorded baseline before it can merge,
and the deploy scripts refuse to ship a commit that never passed.

Gated paths (the same list appears in `.github/workflows/config-evals-gate.yml`
and in each deploy script's `require_eval_gate` call — always the `src/config/`
copies, never the S3 ones):

- `deploy/runtime-agent/prompts/**` — per-persona system prompts
- `deploy/workflow-manager/system-prompt.md` — the Workflow Manager prompt
- `src/config/agents.json` — agent roster (ids, tiers, routing)
- `src/config/workflows.json` — workflow definitions
- `blueprints/**` — task blueprints served to agents at runtime
- `evals/battery/**` — the battery itself (cases, thresholds, runner)

The PR check is a check run named exactly **`config-evals-gate`**, published by
a credential-isolated job (see the HERM-1/CRED-2/CRED-3 comments in the
workflow). It is `success` only when every active case ran, scored, and held
the thresholds; every other state — battery crash, timeout, missing results,
fork PR — is an explicit **failure**, never neutral or absent.

There is no neutral verdict anywhere in this pipeline: the publish job maps
everything that is not `verdict: "PASS"` + a successful battery job onto
`conclusion: failure`, and the deploy guard treats anything but a green check
as "refuse to ship". So every "the gate proved nothing" condition below is a
**FAIL with an explicit `failureReason`**, not a neutral conclusion.

### What can never produce a PASS

| Condition | Why |
| --- | --- |
| `baseline.json` is still `bootstrap: true` | Nothing to compare against — the run still executes and reports scores (the baseline workflow consumes them), but the gate stays red until a real baseline is published. |
| Zero baseline-compared gating cases | Informational cases (new-in-PR, or every case under a bootstrap baseline) prove nothing; PASS requires ≥1 scored case that was actually compared to a baseline entry. |
| Any case not `scored` | errored / timed_out / skipped / unscored / forbidden-tool — a partial run is never a pass. |
| Duplicate case ids across `cases/*.json` | Preflight failure, before any spend. |
| Accumulated spend above `maxRunUsd` | The runner aborts remaining work and fails the suite. |
| A case active at the base ref that the PR deletes | Preflight failure — a PR cannot remove a gating case. |

## Case format

Cases live in `cases/*.json`, one file per case, validated against
`schema/case.schema.json` by preflight (which runs before any model call —
malformed cases fail loudly at zero cost). **Ids must be unique across
`cases/`**: two files claiming the same id would collapse in every id-keyed
roster (manifest cross-check, baseline lookup, selection), so preflight and
`npm run battery:lint` both fail and name the offending files. Copy
`cases/_template.json` to start a new one. Fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable slug, also the `fixtures/<id>/` directory name. |
| `title` | Human summary. |
| `targetAgentId` | Must exist in `src/config/agents.json` (preflight cross-checks) and match `^agentcore_hub_[a-z0-9_]+$`. |
| `taskPrompt` | The orchestrator turn handed to the agent (min 20 chars). |
| `referenceInputs.expectedOutcomes` | ≥1 concrete outcome the judge verifies. |
| `referenceInputs.expectedToolTrajectory` | Ordered tool calls (`tool`, optional `argsSubset`, `optional`) the run should produce. **Required whenever the custom dependency-chain evaluator is listed.** |
| `referenceInputs.forbiddenTools` | Per-case additions to the global forbidden list; a call to one fails the case mechanically, no judge involved. |
| `evaluators` | 1–10 evaluator names (the AgentCore API caps a config at 10 — `maxActiveEvaluatorsPerCase` in `thresholds.json` mirrors that). |
| `modelTier` | `haiku` (default — cheapest tier that reproduces the behavior), `sonnet`, or `opus`. **`opus` requires `provenance.tierJustification`.** |
| `timeoutSeconds` | Per-case watchdog; a timeout is a case failure (no retry). |
| `status` | `active` or `retired` (+ `retirement_reason`). |
| `provenance` | `source` (`incident` \| `synthetic` \| `workflow`), `mintedBy`, `mintedOn`, optional `reference` (ticket/incident id), `tierJustification`. |
| `input` | Fixture pointers: `transcript` (replayed as prior messages), `files` (seeded into the in-memory S3 under `shared/inputs/`), `repoFixture`, `blueprints`. |
| `evaluator_floors` | Optional per-evaluator absolute floors overriding the derived ones. A gating knob: in gate mode it is read from the base ref for cases that already exist there. |

Evaluator names are the ones provisioned by
`deploy/evaluations/setup-evaluations.sh`:

- Builtins: `Builtin.ToolSelectionAccuracy`, `Builtin.ToolParameterAccuracy`,
  `Builtin.InstructionFollowing`, `Builtin.GoalSuccessRate`,
  `Builtin.Correctness`, `Builtin.Coherence`, `Builtin.Faithfulness`,
  `Builtin.Helpfulness`, `Builtin.ResponseRelevance`, `Builtin.Conciseness`.
- Custom on-demand: `dependency_chain_compliance-VyBv7H2bCi` — scores whether
  the tool trajectory respected task dependencies; it is meaningless without a
  reference trajectory, so preflight rejects a case that lists it without
  `expectedToolTrajectory`.

## Running locally

```bash
# Preflight + hermeticity self-test + plan, zero Bedrock calls:
npm run battery:dry-run

# Fixture/sanitization lint (also part of CI):
npm run battery:lint

# Run one case against your own AWS credentials (Bedrock Converse in us-east-1):
node evals/battery/run-battery.mjs --case triage-crash-chain-001 --results /tmp/results.json

# Full gate run, comparing added-vs-base cases like CI does:
node evals/battery/run-battery.mjs --results /tmp/results.json --base-ref origin/main

# Regenerate a baseline locally (NEVER commit the output from a laptop —
# the merge-to-main workflow owns evals/battery/baseline.json):
node evals/battery/run-battery.mjs --baseline-mode --repeat 3 --out /tmp/baseline.json
```

`check-summary.md` (the text posted to the PR check) is written next to
whatever `--results` path you give.

### Runtime limits & progress output (TEAM-3352)

The runner prints a start line (`▶ case-id`), an agent-loop→scoring transition
line (`⚖`), and a completion line (with elapsed seconds) per case, and appends
each finished case to `battery-progress.jsonl` next to the results file — a
killed run still leaves per-case evidence. Every Bedrock path is bounded; env
knobs (all optional):

| Env var | Default | Meaning |
| --- | --- | --- |
| `BATTERY_BEDROCK_CONCURRENCY` | `3` | Global cap on in-flight Converse calls (agent turns + judge calls combined) across all case workers. |
| `BATTERY_CASE_DEADLINE_SECONDS` | `timeoutSeconds + 60 × evaluators` | End-to-end per-case deadline covering the agent loop AND judge scoring; firing during scoring ⇒ `unscored` (gate FAIL), suite continues. |
| `BATTERY_RUN_DEADLINE_SECONDS` | `780` (13 min) | Whole-run watchdog: aborts outstanding work, marks unfinished cases `timed_out`, and still writes results + check summary (FAIL). |
| `BATTERY_MAX_TRANSPORT_RETRIES` | `1` | Per-case transport retry budget (jittered backoff, elapsed-capped); retries re-run the failed turn, never the whole case. |

## Scoring backend

`scoringBackend: "local-judge"` — each evaluator is scored by **Claude Opus 4.7
via Bedrock Converse** (`us.anthropic.claude-opus-4-7`, maxTokens 1000), using
the same llmAsAJudge shape as the repo's provisioned evaluator
(`deploy/evaluations/dependency_chain_evaluator.json`): a 0.0/0.5/1.0 rating
scale whose native scores are ×100 at ingestion to the battery's 0–100 scale.

Why not the AgentCore Evaluations service directly? Security review **CRED-5**:
the v1 gate role ships **zero `bedrock-agentcore` permissions** — the CI job
can invoke Converse and nothing else. Additionally, the repo's only
demonstrated agentcore eval commands operate on *online* (deployed-runtime)
sessions; they don't score local hermetic sessions, so an on-demand backend
would have required new, unproven service surface inside the gate.

`lib/scoring.mjs` is the adapter seam: `scoreCase({ transport })` takes any
Converse-shaped transport, so a future `on-demand` backend slots in behind the
same interface. The active backend name is recorded in both `baseline.json`
and every results file — **a backend mismatch between baseline and current run
is a gate failure** (fail closed; scores across backends are not comparable).

## Baseline lifecycle

`baseline.json` holds per-case per-evaluator means (`runs_per_case: 3`), the
`source_commit` it was generated from, and the `scoringBackend`.

- **Bootstrap state.** `bootstrap: true` with `runs_per_case: 0` and empty
  `cases` means no real baseline has been recorded yet; every case runs
  informational until the first baseline workflow run populates the file.
  **A bootstrap baseline can never produce a green gate**: the suite verdict is
  `FAIL` with `baseline is bootstrap — gate cannot pass until a real baseline is
  published…`, and the runner exits non-zero. Scores are still executed and
  reported so the baseline workflow (and reviewers) can see them; only the
  verdict is withheld. Bootstrap is a "gate not yet armed" state, and an unarmed
  gate must not look identical to a passing one.
- **Regenerated ONLY by `.github/workflows/config-evals-baseline.yml`** on
  merge to `main` (or manual dispatch). PR runs never write it — the runner
  has no baseline-writing code path outside `--baseline-mode --out`.
- **Missing or unparseable baseline = gate failure.** So is a *pre-existing*
  case absent from the baseline (drift or hand-editing).
- **New-in-PR cases run informational**: scores are reported in the check
  summary but produce no delta verdict in the PR that introduces them; the
  post-merge baseline run absorbs them. A suite in which *every* case is
  informational is a `FAIL` ("no baseline-compared gating cases") — otherwise a
  PR that made every case look new would pass by proving nothing.
- Concurrent baseline runs are serialized; a run whose commit is superseded by
  a baseline from a descendant commit discards itself (see the workflow).

### Where the gating rules come from (gate mode)

A PR can edit the battery's own config, so in **gate mode** — whenever
`--base-ref <ref>` is passed, as CI does — the runner refuses to referee itself
with PR-controlled rules. It reads these from `git show <base-ref>:<path>`
instead of the PR checkout:

| File | What comes from the base ref |
| --- | --- |
| `baseline.json` | the whole baseline (means, `source_commit`, `scoringBackend`) |
| `thresholds.json` | every knob: `overallDropMaxPoints`, `floorRule`, `maxRunUsd` |
| `manifest.json` | the gating knobs only — `minActiveCases`, and which case ids count as active |
| `cases/<id>.json` (base-active cases only) | the gating knobs only — `evaluator_floors`, the `evaluators` list, and `referenceInputs.forbiddenTools` (union with HEAD: a PR may add a prohibition, never drop one) |

Everything else in a case file stays PR-head — `taskPrompt`, `input` fixtures,
`targetAgentId`, `modelTier`, `expectedOutcomes`/`expectedToolTrajectory`. That
is the case's *content*: it has to be editable in the same PR that edits the
config it exercises (an agent-id rename would otherwise deadlock). Only the
knobs that decide *how strictly* the case is judged are deferred.

Consequences for a PR that touches the battery:

- **Weakening thresholds or hand-editing the baseline has no effect on its own
  gate run.** The change applies from the merge onward. Same for lowering a
  case's `evaluator_floors`, dropping an evaluator from a pre-existing case, or
  removing one of its `forbiddenTools` — the runner logs which knobs it
  overrode and gates on the base-ref values.
- **Retiring a case takes effect only once it has landed on the base branch.** A
  case that is active at the base ref but `retired` at HEAD still runs and still
  gates (the runner logs a warning and does not list it as retired).
- **Deleting a base-active case file is a preflight failure**, never a silent
  drop from the run set.
- **New cases use PR-head definitions** — they cannot exist at the base ref, so
  there is nothing else to read. They run informational (see above).
- **If a file is absent at the base ref** (the battery didn't exist there yet),
  the runner falls back to the PR-head copy and says so loudly. That fallback is
  only safe because of the bootstrap and zero-gating-case rules above — a
  fabricated baseline still cannot manufacture a PASS.
- Every run prints a `Gate config resolution` block naming the source of each
  file, and `battery-results.json` records it under `configSources`.

Without `--base-ref` (local/manual runs) everything comes from the working tree,
which is what you want when iterating on a case.

### Gate thresholds (`thresholds.json`)

- **Overall drop rule:** fail when baseline overall mean − current overall
  mean is **strictly greater than 5.00** (a drop of exactly 5.00 passes).
- **Floor rule:** per-case per-evaluator floor = baseline mean − 10, clamped
  up to an absolute minimum of 40; `evaluator_floors` in a case file override
  (base-ref copy in gate mode). One floor breach fails the gate regardless of
  every other cell.
- **Partial runs never pass:** an errored, timed-out, skipped, or unscored
  case is a failure — there is no code path from a partial run to `PASS`.
- **At least one gating case:** `PASS` requires ≥1 scored case compared against
  a baseline entry (`gatingCases` in the results file).
- In gate mode all of these numbers are read from the **base ref** — see above.

## Incident-to-eval-case process (FR-8)

Every production incident traced to agent behavior gets a battery case, so the
config that caused it can never ship again unnoticed. Checklist (start from
`cases/_template.json`):

1. **Pick the incident** and capture its id in `provenance.reference`;
   set `provenance.source: "incident"`.
2. **Extract a sanitized fixture** — the minimal transcript/files/repo state
   that reproduces the behavior. `npm run battery:lint` enforces
   sanitization (no real tokens, hosts, account ids, customer strings).
3. **Write `taskPrompt` as the orchestrator turn** the agent actually received
   (not a paraphrase of the postmortem).
4. **Derive `expectedToolTrajectory`** from what the agent *should* have done;
   add the dependency-chain evaluator if ordering was the failure.
5. **Set floors so the PRE-FIX config fails.** Prove it both ways before
   opening the PR: run the case against the offending config (red) and against
   the fixed config (green). A case that can't distinguish them is decoration,
   not a gate.
6. **Pick the cheapest tier that reproduces** the failure (usually `haiku`;
   `opus` needs `tierJustification`).
7. Add the id to `manifest.json` `activeCases`.

**Incident cases are never retired without a replacement covering the same
regression.**

## Flake retirement policy (FR-10)

**Retire, don't retry.**

- The runner performs **at most one retry per case per run**, and only for
  *typed transport errors* — throttling, 5xx, connection reset/timeout
  (classified by error type in `lib/agent-runner.mjs`, never by score).
  Score variance is never a retry reason.
- A case that flips verdicts on unchanged config is flaky, and flaky cases
  erode the gate's authority. The fix is a PR that sets `status: "retired"`
  with a `retirement_reason`, and removes the id from `manifest.json`
  `activeCases`.
- Retired cases are excluded from gating but **listed in every check summary
  with their reason** — retirement is visible, never silent.
- **Retirement takes effect only after merge.** The retirement PR's own gate run
  still executes and still gates the case it retires (the base ref says it is
  active), so a flaky case cannot be silenced in the same PR that degrades a
  prompt. The check summary logs the case as "still gating this run".
- The battery never drops below `minActiveCases: 10` — read from the base ref in
  gate mode, so lowering the floor and retiring cases in one PR does not work. A
  retirement PR that would go under fails its own gate (preflight) until a
  replacement case lands in the same PR.

## Hermeticity

A battery run executes **zero real side effects**:

- **Closed stub registry** (`lib/registry.mjs`): agents get only curated stub
  tools. `shell`, `http_request`, `python_repl`, `browser`, `environment`,
  code-interpreter, S3 download, and the entire git-push/MCP surface are on
  `FORBIDDEN_TOOLS`; the registry self-tests that no stub overlaps that list,
  and any forbidden call fails the case mechanically.
- Tickets/S3/workflow tools are in-memory fakes (fake `BATT-9xx` ticket keys,
  fixture-seeded S3); coding-engine tools return delegation acks — no repo, no
  push. File tools are jailed to a per-case temp workspace.
- **Session ids are `battery-<runId>-<caseId>`** — never containing `eval_`,
  so the eval-packager Lambda's `resolveAgentId` substring match can never
  mistake a battery session for an online eval session (unit-tested).
- **Sanitized fixtures** enforced by `npm run battery:lint`.
- **CI credential preflight**: the gate job checks out with
  `persist-credentials: false` and asserts no git credential survives on disk
  before running any PR code.

## Deploy gate + break-glass

Every deploy target that ships gated artifacts sources
`deploy/lib/check-eval-gate.sh` and calls `require_eval_gate <globs...>`
before its first S3 write or docker build. Semantics against HEAD:

- **Green** `config-evals-gate` check → deploy proceeds (latched in
  `EVAL_GATE_CHECKED` so a 14-agent fleet fan-out queries GitHub once).
- **Queued/in-progress** → refused: wait for the gate.
- **Failure/cancelled/timed-out** → refused, with the check URL and the
  failing evaluator lines from the summary.
- **Absent** → refused if HEAD (or any of the last 20 first-parent commits
  without an intervening green check) touched the target's gated globs — that
  means the gate was bypassed. Proceeds with a note only when nothing gated
  changed.
- A **dirty working tree** touching gated paths always refuses: deploys ship
  committed, gated state only.

Break-glass (audited — BG-2/BG-3): set **both** `EVAL_GATE_OVERRIDE=1` and a
non-empty `EVAL_GATE_OVERRIDE_REASON`. The override prints a loud banner and
writes `{timestamp, sha, identity (STS caller ARN), script, reason}` to
`s3://$ARTIFACT_BUCKET/eval-gate/overrides/<ts>-<sha>.txt` **and**
`.eval-gate-overrides.log` (gitignored). If the S3 write fails you must type
`OVERRIDE-UNAUDITED` at a real tty; non-interactive unaudited overrides are
refused. An empty reason is refused outright.

## Cost budget

Design cost model ($/MTok, `lib/agent-runner.mjs` `PRICING_PER_MTOK`):

| Tier | Input | Output |
| --- | --- | --- |
| haiku (default) | $1 | $5 |
| sonnet | $2 | $10 |
| opus (needs justification) | $5 | $25 |
| judge (Opus 4.7 scoring) | $5 | $25 |

**`maxRunUsd: 20` is a live ceiling, not a post-hoc report** (`lib/spend.mjs`).
Every Converse response — case turns *and* judge calls — is metered into a
ledger, and the ledger is consulted *before* each call and before each unstarted
case:

- Crossing the ceiling mid-case aborts that case (it lands `errored`).
- Cases not yet started are marked `skipped` and cost nothing.
- The suite verdict is `FAIL` with a `run spend ceiling exceeded` reason naming
  the abandoned cases; the final total is still checked against `maxRunUsd` as a
  backstop (exactly $20 passes).
- Worst-case spend is therefore ~`maxRunUsd` plus the turns already in flight
  across the pool of 4 — not "however much the whole suite happened to cost".

In gate mode `maxRunUsd` comes from the base ref's `thresholds.json`, so a PR
cannot raise its own ceiling. `--baseline-mode` runs each case `--repeat` times,
so its ceiling is `maxRunUsd × repeat`; hitting it fails baseline generation
rather than writing a partial baseline.

The CI job is additionally capped at **`timeout-minutes: 15`** — a hung battery
becomes a failed job, which the publish job turns into a failed check.
