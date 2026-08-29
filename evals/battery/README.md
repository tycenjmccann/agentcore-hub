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
- `deploy/workflow-manager/**` — the Workflow Manager prompt, skills, and toolkit
- `src/config/agents.json` — agent roster (ids, tiers, routing)
- `src/config/workflows.json` — workflow definitions
- `blueprints/**` — task blueprints served to agents at runtime
- `evals/battery/**` — the battery itself (cases, thresholds, runner)

The PR check is a check run named exactly **`config-evals-gate`**, published by
a credential-isolated job (see the HERM-1/HERM-3/CRED-2/CRED-3 comments in the
workflow). For same-repo PRs it is `success` only when every active case ran,
scored, and held the thresholds; every other state — battery crash, timeout,
missing results — is an explicit **failure**, never neutral. Fork PRs are the
one deliberate exception: **no check is published at all**, and the required
check's *absence* is what blocks the merge — see "Fork PRs" below.

There is no neutral verdict anywhere in this pipeline: the publish job maps
everything that is not `verdict: "PASS"` + a successful battery job onto
`conclusion: failure`, and the deploy guard treats anything but a green check
as "refuse to ship". So every "the gate proved nothing" condition below is a
**FAIL with an explicit `failureReason`**, not a neutral conclusion.

### Fork PRs — the gate is same-repo only (FR-2 fork-safety decision; CRED-2, TEAM-3425)

The gate cannot run for fork PRs, by two independent mechanisms, so it is
**formally restricted to same-repo PRs**:

- Fork PRs cannot assume the OIDC eval role, so the battery has no Bedrock
  credentials to score anything with.
- On fork `pull_request` events GitHub hands the workflow a **read-only
  `GITHUB_TOKEN`** and does not honor workflow- or job-level permission
  requests (`checks: write` included), so `checks.create` returns 403:
  publishing *any* `config-evals-gate` check run — failing or passing — from a
  fork-triggered run is impossible by platform design. (An earlier design had
  a fork-guard job "publish an explicit failing check" for gated fork PRs;
  that call could never succeed and the design is superseded.)

**Enforcement is the required check's absence.** With `config-evals-gate` set
as a required status check in branch protection, a fork PR never acquires the
check and sits at "Expected — waiting" — it cannot merge (fail closed by check
**absence**, not by a published failure). On top of that, a fork PR that
touches gated paths (or whose path detection failed) gets a visibly **failing
`fork-guard` job** — a plain `exit 1` with an explanatory `::error::` and a
step-summary write-up, no `checks.create` attempt — and an ungated fork PR
gets an informational exit-0 `fork-notice` job explaining the same constraint.

**Maintainer workflow for fork contributions:** to gate a fork contribution, a
maintainer pushes the fork branch to the base repository
(`git push origin <sha>:refs/heads/<branch>`) and opens (or retargets) the PR
from that same-repo branch; the battery then runs with OIDC credentials and
publishes the check as usual.

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
| `referenceInputs.expectedToolTrajectory` | Ordered tool calls (`tool`, optional `argsSubset`, `optional`) the run should produce. **Required whenever the custom dependency-chain evaluator is listed.** Non-`optional` entries are also enforced mechanically: a run that never calls one fails the case (`failed_required_tool`) with zero judge spend. |
| `referenceInputs.forbiddenTools` | Per-case additions to the global forbidden list; a call to one fails the case mechanically, no judge involved. |
| `referenceInputs.personaContract` | Curated list of the STOCK persona's non-negotiable rules — the judge reference for `persona_contract_compliance`. Pinned in the case file, **never** sourced from the working-tree prompt (that file is the artifact under test). A gating knob: read from the base ref in gate mode. |
| `evaluators` | 1–10 evaluator names (the AgentCore API caps a config at 10 — `maxActiveEvaluatorsPerCase` in `thresholds.json` mirrors that). |
| `modelTier` | `haiku` (default — cheapest tier that reproduces the behavior), `sonnet`, or `opus`. **`opus` requires `provenance.tierJustification`.** |
| `timeoutSeconds` | Per-case watchdog; a timeout is a case failure (no retry). |
| `status` | `active` or `retired` (+ `retirement_reason`). |
| `provenance` | `source` (`incident` \| `synthetic` \| `workflow`), `mintedBy`, `mintedOn`, optional `reference` (ticket/incident id), `tierJustification`. |
| `input` | Fixture pointers: `transcript` (replayed as prior messages), `files` (seeded into the in-memory S3 under `shared/inputs/`), `repoFixture`, `blueprints` (battery-local blueprint copies that `load_blueprint` serves INSTEAD of the working-tree file — see "Persona-contract sensitivity"). |
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
  `expectedToolTrajectory`. Only list it on cases whose task actually involves
  a ticket-dependency chain — on anything else the judge has nothing to
  violate and hands back a free 100 that dilutes the score vector.
- Battery-local: `persona_contract_compliance` — scores the trajectory/output
  STRICTLY against the case's pinned `referenceInputs.personaContract`, not
  against whatever instructions the agent's (possibly degraded) prompt gave
  it. Preflight/lint reject a case that lists it without `personaContract`.
  It exists only in the local-judge backend — it is not provisioned by
  `deploy/evaluations/setup-evaluations.sh`.

## Persona-contract sensitivity (TEAM-3352)

A degraded system prompt is only detectable if the system prompt is the
**load-bearing** source of the persona's rules during the run, and if the
judges score against a reference the PR cannot rewrite. Three rules follow:

1. **taskPrompts must not restate the persona contract.** A case prompt that
   says "load your blueprint first … report via report_completion … never
   transition tickets" re-teaches a degraded agent the correct behavior, so
   the battery exercises the degraded prompt without ever depending on it.
   qa-* taskPrompts describe only the WORK (the assignment and its inputs);
   the contract lives solely in the prompt under test.
2. **Fixture blueprints for contract-heavy personas.** `load_blueprint`
   normally serves the working-tree blueprint, and the production qa-verifier
   blueprint restates the whole contract — an intact blueprint outvotes a
   degraded prompt. qa-* cases therefore pin a battery-local copy
   (`input.blueprints` → `fixtures/blueprints/qa-verifier.md`) that gives
   process pointers only. Trade-off: those cases no longer exercise
   production-blueprint changes; blueprint coverage comes from the cases that
   do NOT pin a fixture copy.
3. **Judges get a curated reference contract, never the working-tree prompt.**
   `referenceInputs.personaContract` is a distilled, case-pinned list of the
   stock persona's non-negotiable rules, rendered into the judge context as
   `## Reference: persona contract` and scored by `persona_contract_compliance`.
   Sourcing it from the prompt file would let the degraded artifact define its
   own rubric; in gate mode the field is a base-ref-pinned gating knob so the
   PR under test cannot water it down either.

`qa-verifier-degradation-canary-004` is the standing tripwire: its fixtures
make "always PASS / skip evidence" and correct behavior diverge observably
(the dev output claims green tests with no logs, and one acceptance criterion
is admitted-unmet in the fixture itself). The stock persona must FAIL with
evidence and file a fix ticket; a degraded persona PASSes without
verification — which the persona evaluator, the outcome-based builtins, and
the mechanical `Tickets___create_ticket` requirement all see.

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
| `BATTERY_RUN_DEADLINE_SECONDS` | `780` (13 min); in `--baseline-mode` auto-scaled to `780 × repeat` (2340s for repeat 3) | Whole-run watchdog: aborts outstanding work, marks unfinished cases `timed_out`, and still writes results + check summary (FAIL). An explicit env value is honored verbatim in every mode (no scaling); the startup `Limits:` line logs the effective value and notes when it was auto-scaled. |
| `BATTERY_MAX_TRANSPORT_RETRIES` | `1` | Per-case transport retry budget (jittered backoff, elapsed-capped); retries re-run the failed turn, never the whole case. |

Every exit path that could have spent Bedrock money — gate PASS/FAIL, baseline
success or failure, watchdog abort, spend-ceiling abort, even a runner crash —
prints `Total spend: $X.XXXX (ceiling $Y.YY)` from the live ledger.

**Infra read retry (TEAM-3405).** A transient filesystem error reading a
case's inputs (fixture seed, transcript, system prompt) — `EACCES`, `EIO`,
`ESTALE`, `EBUSY`, `EMFILE`, `ENFILE`, the kind an NFS/EFS lease blip
produces — gets ONE retry after a 2s delay, and the run's record carries
`infraRetried: true` (also in `battery-progress.jsonl`). Only errors thrown
BEFORE the first model turn qualify; behavioral failures (forbidden/required
tool, timeout, judge scoring) are never retried, and `ENOENT` is excluded — a
missing file is a deterministic config error, not a blip.

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

## Mock mode / local demo (TEAM-3295)

`node evals/battery/run-battery.mjs --mock` runs the FULL pipeline — case
loading, hermetic stub registry, mechanical required/forbidden-tool checks,
gate math, check summary, exit codes — with a deterministic local transport
(`lib/mock-transport.mjs`) and a synthetic in-memory baseline. **Zero AWS
calls** (the Bedrock transport is never constructed; unit-asserted), ~1s for
all 13 cases.

The mock judge is sensitive to working-tree prompt degradation via the
TEAM-3352 mechanism: for cases pinning `referenceInputs.personaContract`, the
contract-sensitive evaluators (`persona_contract_compliance`,
`Builtin.InstructionFollowing`) score healthy only while the target agent's
working-tree prompt still carries its contract clauses (token-coverage
heuristic, calibrated margins). So:

- **innocuous edit** (whitespace/comment) → scores reproduce the synthetic
  baseline → **PASS**;
- **degraded qa-verifier prompt** (FIRST STEP / CRITICAL RULES stripped) →
  floor breaches on the qa-* cases naming the responsible evaluators →
  **FAIL**, exit 1.

Captured demo output for both scenarios lives in `demo/` (see
`demo/README.md` to regenerate). `--mock` is refused alongside
`--baseline-mode`/`--base-ref`: it is a local demo, never gate evidence — mock
results are stamped `scoringBackend: "mock"` and can never be compared against
a `local-judge` baseline (backend mismatch fails closed). The committed
bootstrap `baseline.json` and its B1 guard are untouched by mock runs.

## CI AWS credentials (one-time setup)

The `battery` job in `.github/workflows/config-evals-gate.yml` (and the
baseline workflow) authenticates via GitHub OIDC only — there are no static
AWS keys anywhere in CI. Until the pieces below are provisioned, the battery
job fails at the credentials step and the gate **fails closed** (the publish
job posts a failing `config-evals-gate` check). One-time setup:

1. **GitHub OIDC provider** in the target account:
   `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
2. **IAM role** for the gate, `MaxSessionDuration` 900 (the job needs one
   short session), with a trust policy pinned to this repo's same-repo
   `pull_request` runs — condition
   `token.actions.githubusercontent.com:sub` like
   `repo:tycenjmccann/agentcore-hub:pull_request` (plus `:ref:refs/heads/main`
   for the baseline workflow's push runs).
3. **Least-privilege permissions** matching what the runner actually calls
   (CRED-5): `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream`
   on the task-model inference profiles
   (`us.anthropic.claude-haiku-4-5-20251001-v1:0`,
   `us.anthropic.claude-sonnet-5`) and the judge
   (`us.anthropic.claude-opus-4-7`) ONLY — no `s3`, `lambda`, `dynamodb`,
   `logs`, and expressly no `bedrock-agentcore` permissions. (The baseline
   workflow's role additionally needs nothing from AWS — the baseline commit
   uses the GitHub token, not AWS.)
4. **Repo variable** `AWS_EVAL_GATE_ROLE_ARN` = the role's ARN
   (Settings → Secrets and variables → Actions → Variables).
5. **GitHub environment** `config-evals` (the battery job runs in it; add
   reviewers/branch restrictions there if desired).

## Baseline lifecycle

`baseline.json` holds per-case per-evaluator means (`runs_per_case: 3`), the
`source_commit` it was generated from, and the `scoringBackend`.

- **Per-case quorum (TEAM-3405).** In `--baseline-mode --repeat N` a case is
  baseline-eligible when at least `ceil(2N/3)` of its N runs scored (2-of-3 for
  repeat 3); the per-evaluator means are computed over the scored runs only,
  and each baseline case records `runsScored`/`runsAttempted`/`topUpRuns` so
  the artifact is honest about its sample size. A case below quorum still
  fails the whole baseline run — an unsound baseline is never written. Gate
  mode is unaffected: any non-`scored` case fails the gate.
- **Per-case top-up runs (TEAM-3405, baseline mode ONLY).** After the main
  N-run pass, a case still below quorum gets up to 2 extra runs, stopping the
  moment quorum is reached (logged as `↻ top-up run for <case> …`). Top-up
  runs draw from the same run deadline and spend ceiling (both re-checked
  before every run — the ceiling is never raised), count into `runsAttempted`,
  and the means stay computed over scored runs only. The math: with per-run
  failure rate p = 0.3, P(case below quorum) is ~22% with a bare 3-run pass
  (`p³ + 3(1−p)p² ≈ 0.216`) but ~3% with 3+2 runs (`p⁵ + 5(1−p)p⁴ ≈ 0.031`).
  A case that exhausts its top-ups below quorum still fails the whole
  baseline. Gate mode has no top-ups — a gate case runs exactly once.

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
- **Baseline publication (ops prerequisite).** For the first real baseline to
  land, the `config-evals` GitHub environment and the
  `AWS_EVAL_GATE_ROLE_ARN` repo variable must exist, and branch protection on
  `main` must allow pushes from the `github-actions[bot]` app (or the commit
  step's token swapped for a narrowly-scoped deploy key) — see the SECRET-4
  comment in the baseline workflow. Until that run succeeds, the committed
  baseline stays `bootstrap: true` and every gate run correctly FAILs.
- **Missing or unparseable baseline = gate failure.** So is a *pre-existing*
  case absent from the baseline (drift or hand-editing).
- **New-in-PR cases run informational**: scores are reported in the check
  summary but produce no delta verdict in the PR that introduces them; the
  post-merge baseline run absorbs them. A suite in which *every* case is
  informational is a `FAIL` ("no baseline-compared gating cases") — otherwise a
  PR that made every case look new would pass by proving nothing.
- Concurrent baseline runs are serialized; a run whose commit is superseded by
  a baseline from a descendant commit discards itself (see the workflow).

### Baseline freshness & the commit-back race

`source_commit` is **the sha the baseline was generated from** — the runner
records `git rev-parse HEAD` of its own checkout, and the workflow asserts it
equals `$GITHUB_SHA` before committing. It may legitimately *trail* `main`'s
tip: it says "these scores describe this tree", not "this is main's newest
commit". Gate/deploy tooling that needs freshness compares `source_commit`
against `main` (ancestry), never against wall-clock time.

The race it guards against: baseline run **A** (from commit A) is in flight;
gated commit **B** merges to `main`; A finishes and its
`git pull --rebase origin main` succeeds *cleanly* because B didn't touch
`baseline.json` — nothing conflicts, yet A's baseline describes a stale tree.
The commit-back step therefore runs the same supersession + ancestry checks on
**both** rebase outcomes:

- **Superseded** — `origin/main` already carries a baseline whose
  `source_commit` is a descendant of our commit ⇒ ours is stale; discard and
  exit green (both the conflict path and the clean path).
- **Ancestry** — if `$GITHUB_SHA` is no longer an ancestor of `origin/main`
  (history rewrite, dispatch on a stale ref), abort with an error instead of
  pushing.
- **Main advanced, no newer baseline** — not fatal: our baseline is the best
  available, so it pushes with a warning; the queued run for the newer commit
  supersedes it when it lands.

The bot commit message carries `[skip ci]`, so the push-back does not trigger
another baseline run (no recursion). If the queued run for a newer commit is
ever lost (manual cancellation, runner outage), recovery is a manual
`workflow_dispatch` of **Config Evals Baseline** — it regenerates from `main`'s
tip and supersedes whatever is committed.

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

#### Trusted-base harness in CI (HERM-3, TEAM-3425)

Base-ref rule reading (above) stops a PR from rewriting the **rules**; HERM-3
stops it from rewriting the **referee**. In CI the battery job checks out the
**base revision** at the workspace root — `npm ci` (against base's
package.json/lockfile, and before any PR-head byte exists on disk),
`run-battery.mjs`, and everything under `evals/battery/lib/` execute from
base — and the PR head contributes **data only**: a fixed allow-list of
candidate config is mirrored in from a second `pr-head/` checkout (which is
deleted before the runner starts):

- `deploy/runtime-agent/prompts/`, `deploy/workflow-manager/`, `blueprints/`
- `src/config/workflows.json`, `src/config/agents.json`

So the artifact the publish job trusts was always produced by base-revision
code reading base-revision rules. In this mode `battery-results.json` records
`configSha` (the base sha the harness ran from — the runner's own
`git rev-parse HEAD`) **and** `candidateSha` (the PR head sha, passed in via
`GATE_CANDIDATE_SHA`).

Consequences for a PR that touches `evals/battery/**`: **nothing under
`evals/battery/` is overlaid** — runner, lib/, schema/, cases/, fixtures/,
manifest.json, thresholds.json, and baseline.json are all read from base in
the PR's own gate run. Harness, case, and rule changes are *not* exercised
pre-merge by the gate itself; they take effect post-merge (the merge-to-main
baseline workflow and every subsequent PR's gate run use them). Pre-merge
coverage for battery changes comes from the unit suite
(`evals/battery/__tests__/`) and local `--mock`/`--dry-run` runs. The gate
still runs on such PRs (the path filter includes `evals/battery/**`, fail
closed) — it just scores base config with the base harness.

The trust-boundary invariants (base-sha root checkout, head-to-`pr-head/`-only
checkout, the exact overlay allow-list never containing the harness, `npm ci`
before the head checkout, pr-head deletion before the run, no `checks: write`
on any fork-reachable job) are pinned by
`evals/battery/__tests__/gate-workflow.test.ts` and
`evals/battery/__tests__/gate-workflow-contract.test.ts` — weakening the
workflow fails the unit suite.

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

**Retire, don't retry.** The exact rule:

- **Max 1 retry per case per run, transient errors only** — throttling, 5xx,
  connection reset/timeout (classified by error type in
  `lib/agent-runner.mjs`, never by score). Score variance is never a retry
  reason.
- **Verdict flips ≥ 2 of the last 5 runs on unchanged config ⇒ flagged** in
  the check summary ("Flaky candidates") and in the flake ledger. "Unchanged
  config" is a fingerprint over the case's effective definition + the system
  prompt it ran against (`lib/flake.mjs configFingerprint`); a fingerprint
  change resets the flip window, so a deliberate config change never reads as
  flake. Errored/timed-out runs count as fails for flip purposes.
- **Flagging is informational only** — it never changes the gate verdict.
  Verdict history lives in `flake-ledger.jsonl` (JSONL, one line per run ×
  case, written through the same C2 redaction as `battery-progress.jsonl`).
  Locally it lands next to the results file (override with
  `--flake-ledger <path>` or `BATTERY_FLAKE_LEDGER`); in CI the gate job
  restores the previous ledger best-effort via `actions/cache`, appends this
  run, saves it back, and uploads it with the results artifact. A stale or
  missing ledger only costs flag history, never a verdict.
- **Retirement is the fix**: a PR that sets `status: "retired"` with a
  `retirement_reason`, and removes the id from `manifest.json` `activeCases`.
  A case that flips verdicts on unchanged config erodes the gate's authority.
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
- **Synthetic test tenant** (TEAM-3090): every case result records
  `tenant: "battery-test"` (`BATTERY_TENANT` in `lib/agent-runner.mjs`). No
  AgentCore runtime session is ever created — cases are direct Bedrock
  Converse calls — so the tenant exists purely to mark battery traffic as
  non-prod; the hermeticity self-test refuses a tenant that doesn't start
  with `battery-` or that looks prod-like.
- **Packager belt-and-suspenders** (TEAM-3090): battery runs emit no OTEL and
  never reach the eval-results log groups by design, but
  `lambda/eval-packager/index.mjs` additionally skips any record whose session
  id starts with `battery-` (`isBatterySession`) — it can never be buffered to
  DynamoDB, batched to S3, or counted toward the improver flush.
- **Sanitized fixtures** enforced by `npm run battery:lint`.
- **CI credential preflight**: the gate job checks out with
  `persist-credentials: false` (both the workspace and the pr-head side
  checkout) and asserts no git credential survives on disk before the battery
  runs.
- **Harness from the trusted base revision** (HERM-3, TEAM-3425): in CI the
  battery job's workspace is checked out at the PR's *base* sha — the runner,
  `lib/`, scoring code, and `package*.json` are always pre-merge-reviewed
  code. Only the candidate config paths (prompts, `deploy/workflow-manager/`,
  `blueprints/`, `src/config/workflows.json`, `src/config/agents.json`) are
  overlaid from the PR head before the run, so a PR that edits
  `evals/battery/**` cannot fabricate its own verdict — a harness change is
  exercised by the gate only after it merges.

## Deploy gate + break-glass

Every deploy target that ships gated artifacts sources
`deploy/lib/check-eval-gate.sh` and calls `require_eval_gate <globs...>`
before its first S3 write or docker build. Semantics against HEAD:

- **Verified battery PASS** → deploy proceeds (latched in `EVAL_GATE_CHECKED`
  so a 14-agent fleet fan-out queries GitHub once). A `success` conclusion is
  NOT enough (TEAM-3426): `skip-publish` publishes a SUCCESS check for PRs that
  touch no gated path, so `config-evals-gate` can be a required status check,
  and that skipped-success proves nothing about the tree. The guard accepts a
  success only when it carries the `config-evals-gate-verdict: PASS` marker line
  in its check-run summary — emitted by every branch of
  `config-evals-gate.yml` — or, for pre-marker historical checks, an output
  title starting with `PASS`.
- **SKIPPED success** (marker `SKIPPED`, or a title starting with `SKIPPED`) →
  informational only, treated as **absent**: it never proceeds, never latches,
  and never anchors the ancestor scan. Any other success that is neither
  identifiably PASS nor SKIPPED is also treated as absent (fail closed), with a
  loud warning.
- **Queued/in-progress** → refused: wait for the gate.
- **Failure/cancelled/timed-out** → refused, with the check URL and the
  failing evaluator lines from the summary.
- **Absent** (no check, or a non-PASS success as above) → refused if HEAD or
  any scanned first-parent ancestor (back to a PASS anchor) touched the
  target's gated globs — that means the gate was bypassed. Also refused,
  fail-closed, if the scan hits the
  `EVAL_GATE_BELT_MAX` cap (100 first-parent commits, see
  `deploy/lib/check-eval-gate.sh`) with history still unexamined and no PASS
  anchor or gated-path touch found. Proceeds with a note only when nothing
  gated changed across a fully-scanned history or since a PASS anchor.
- A **dirty working tree** touching gated paths always refuses: deploys ship
  committed, gated state only.

Break-glass (audited — BG-2/BG-3) has two equivalent forms:

```bash
# CLI form (deploy/runtime-agent/deploy.sh, deploy-one.sh, and deploy-fleet.sh)
./deploy/runtime-agent/deploy.sh --force --force-reason "INC-123: hotfix, gate red on an unrelated case" backend_dev

# Env-var form (every gated target, including the raw require_eval_gate calls in DEPLOY.md)
EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON="INC-123: hotfix, gate red on an unrelated case" \
  ./deploy/ecs-express/deploy.sh
```

`--force`/`--force-reason` (parsed by the shared `deploy/lib/parse-force-args.sh`,
also accepted as `--force-reason=<why>`) is pure sugar: it exports
`EVAL_GATE_OVERRIDE=1` and `EVAL_GATE_OVERRIDE_REASON` before the gate runs, so
both forms land in the **same** audited path with the same audit trail. `--force`
without a non-empty reason is refused up front, before any gate or deploy work
(an inherited non-empty `EVAL_GATE_OVERRIDE_REASON` counts as the reason; a
`--force-reason` on the command line always wins over it). Any other unknown
`--flag` is rejected rather than misparsed as an agent name, and gated scripts
that take no CLI args (`deploy-topology.sh`, `workflow-manager`, `apprunner`,
`ecs-express`) reject `--force` with an error pointing at the env form.

The override prints a loud banner and writes
`{timestamp, sha, identity (STS caller ARN), script, reason}` to
`s3://$ARTIFACT_BUCKET/eval-gate/overrides/<ts>-<sha>.txt` **and**
`.eval-gate-overrides.log` (gitignored). If the S3 write fails you must type
`OVERRIDE-UNAUDITED` at a real tty; non-interactive unaudited overrides are
refused, and an override with no durable record at all is refused outright. An
empty reason is refused outright. From `deploy.sh` the override is spent once —
the parent gate call audits and then latches, so its 14 `deploy-one.sh` children
short-circuit on the latch token instead of writing 14 audit records.

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
