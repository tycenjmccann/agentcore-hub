---
name: run-analysis
description: Full ANALYZE-mode playbook — post-run workflow analysis. The assessment rubric (planning, execution, human-in-the-loop, rework, deliverables, trend), the exact analysis.json schema save_analysis.py requires, and the knowledge-file curation step. Load on every ANALYZE invocation, and for CHAT deep-dives into how a run performed.
---

# Run analysis — rigorous post-run assessment

Goal: analyze how well the WORKFLOW performed — not the individual agents (the
SI loop covers those), but the system: planning, flow, human touchpoints,
rework, outcomes.

## 1. Gather

```bash
python3 /mnt/workspace/toolkit/pull_dossier.py <wfId>
python3 /mnt/workspace/toolkit/compute_metrics.py <wfId>
python3 /mnt/workspace/toolkit/si_ledger.py keys           # every patternKey already tracked
```

Read your knowledge file for this workflow definition:
`s3://$ARTIFACT_BUCKET/workflow-manager/knowledge/<workflowDefId>.md`
(may not exist yet — that's fine).

`compute_metrics.py` prints `source` first. Check it before you assess anything:

- **`"performance-card@v5"`** — the run has a performance card, and
  `metrics.kpi` / `metrics.time.*` / `metrics.cost.*` / `metrics.quality.*` are
  the card's own numbers: the same ones the Workflow tab shows. Cite them.
- **`"computed"`** — no card (or one too old), so the numbers below were derived
  from the dossier and there is no deterministic score.
  `metrics.dataQuality.notes` says why.

## 2. Assess, with evidence

- **Planning quality** — did the intake agent decompose the request well?
  Right tickets, right agents, sane dependency chain, requirements coverage.
- **Execution** — per-phase durations vs. prior runs; errors, nudges, retries;
  did any agent's task dominate the critical path?
- **Human-in-the-loop efficiency** — per-gate wait times from
  `metrics.humanReviews`. Was each gate worth its delay? Approvals that took
  hours for a rubber stamp vs. rejections that caught real problems.
- **Rework root cause** — for each change request: unclear requirements, agent
  output quality, or gate placement? Cite the reviewer's feedback from ticket
  comments.
- **Deliverables vs. requirements** — do the completions and artifacts
  actually cover what the intake requested?
- **Trend** — compare against `priorAnalyses` in the dossier and your own
  memory of this workflow def. One run is an anecdote; call trends only when
  the data supports them.
- If the run was cancelled or errored: lead with why it stopped.
- If `metrics.managerInterventions` is non-empty, evaluate your own watch
  interventions: did they help?

### When `metrics.source == "performance-card@v5"`

The card carries a **deterministic** 0-100 quality score — pure arithmetic over
the run's counters, with every weight, tolerance and cap in
`src/config/kpi.json`. It is reproducible; your `scores.overall` is a judgement.
Both are wanted, so both are on the record:

- **Cite `metrics.kpi.quality.score` and `metrics.kpi.quality.grade` in the
  verdict**, and say explicitly whether your `scores.overall` agrees with it.
- **File a finding when they diverge by more than 15 points**
  (`kind: "risk"`, `severity: "medium"`): what the arithmetic weighed that you
  did not, or what you saw that no counter captures. A divergence is a real
  signal — either the run is unusual or the weights are — and hiding it makes
  both numbers untrustworthy. Do not adjust `scores.overall` to close the gap.
- `metrics.kpi.quality.confidence` is `full` / `partial` / `insufficient`.
  `insufficient` means the score is `null` (too little evidence to score the
  run) — say so instead of citing a score, and never treat `null` as 0.
- `metrics.kpi.cost.band` / `.time.band` / `.quality.band` are this run against
  its own workflow def's recent history (`ok` / `warn` / `alert`, with `z`).
  A `warn`/`alert` band is the strongest "this run was unusual" evidence you have.
- **kpiVersion 2 (card `reportVersion` ≥ 6) changed what the counters mean — read
  them accordingly.** `quality.reworkRounds` counts only re-invocations caused by
  a fix ticket or a review rejection; a re-wake after a human gate, a CI
  re-certification or a sibling dependency is in `quality.rewakes` (split by
  cause in `quality.reinvocations.byKind`) and is NOT rework. A dead or
  restarted session is in `quality.errors` (via `agent.retry` / `agent.died`), so
  `errors=0` now really means no session died. Every Workflow Manager action is
  in `quality.interventions`, with what it did and said in
  `quality.interventionsDetail` — do not argue a comment "should not count"; the
  WM only acts on a stalled run, so say what stalled. Never compare a v2 score
  against a v1 score as if they meant the same thing.
- **kpiVersion 3 (card `reportVersion` ≥ 11, TEAM-5428):** a `cancelled` or
  `stopped` run (an operator close-out that merged nothing) is capped at 40 (F)
  and banded only against other unfinished runs. `quality.tasksCompleted` counts
  only tickets with a completion record — `tasksClosedWithoutWork` is what a
  cascade closed with none, `tasksRecordUnreadable` what could not be read.
  `quality.interventions` now counts WM *actions* only; a `comment` is in
  `interventionsDetail` with `counted:false`. `delivery.deployed` is `true`,
  `false` or `null` — `null` means a ship record exists but could not be read
  (named in `delivery.shipRecordsUnreadable`); never read it as "not deployed".
- **Do not re-derive what the card provides.** Read counts and durations from
  `metrics.quality.*`, `metrics.time.*`, `metrics.cost.*` — not by counting
  events or tickets yourself. Two numbers for one run is a bug report.
- Two human-wait numbers exist on purpose and mean different things:
  `metrics.time.humanWaitMs` is the card's **union** of gate intervals (the real
  wall-clock the run spent waiting), `metrics.humanWaitTotalMs` is the legacy
  **sum** over reviews (double-counts overlapping gates). Label whichever you
  cite. The same holds for the other legacy counters
  (`changeRequests` is a dict of cycles, `metrics.quality.changeRequests` is the
  card's count) — cite the card's and say so, never average the two.

When `metrics.source == "computed"`, say so in the verdict ("no performance card
for this run, so these numbers are dossier-derived and there is no deterministic
score") and omit the score citation entirely — do not invent one.

## 3. Write the analysis

NEVER write the analysis in one tool call — a large run's report hits the
model's output-token cap mid-call, the truncated tool input is discarded, and
the whole ANALYZE invocation dies (TEAM-5226: this killed auto-analysis of big
runs). Write it as SECTIONS, one top-level key per tool call, into
`/mnt/workspace/<wfId>/analysis.d/`:

| File | Holds |
|---|---|
| `scores.json` | the `scores` object |
| `verdict.json` | the `verdict` JSON string (quoted) |
| `findings.json` | the `findings` array — or split: `findings.1.json`, `findings.2.json`, … (each an array, concatenated in order) |
| `recommendations.json` | the `recommendations` array — may be split the same way |
| `trend.json` | the `trend` object |
| `kpiVersion.json` | the number (omit when there is no card) |
| `summaryMarkdown.md` | the report body; the first chunk with `cat > summaryMarkdown.md`, later chunks appended (`cat >> ...`), at most ~60 lines per call, under ~300 lines total |
| `manifest.json` | **written LAST**: `{"parts": ["scores.json", "verdict.json", "findings.1.json", ...]}` — exactly the JSON part files of THIS analysis. Only listed parts are merged; anything unlisted is ignored |

One `cat > analysis.d/<file> <<'EOF'` per call. If a tool call is ever cut off
by the output limit, the files already written persist — rewrite only the one
that was cut, smaller. When a rewrite changes which files a key lives in (say
`findings.1.json`..`findings.3.json` became a single `findings.json`), rewrite
`manifest.json` too: the superseded files may stay on disk, unlisted files are
simply ignored. `save_analysis.py` merges the directory itself: do NOT assemble
`analysis.json` by hand. While `analysis.d/` exists it governs and any
`analysis.json` in the workspace is ignored; to fall back to a single
`analysis.json` (discouraged), `rm -rf analysis.d` first.

Caps: **at most 12 findings and 12 recommendations** — lead with the most
severe / highest priority. `save_analysis.py` keeps the top 12 of each by
severity / priority (always keeping a success finding), drops the rest and
records how many it dropped, so anything past the cap is wasted output. Keep
`evidence` / `description` tight: the saved row is bounded to DynamoDB's item
limit, and text past a few KB per field is cut there (S3 keeps the full text).

The merged analysis must have EXACTLY these fields
(`save_analysis.py` rejects anything malformed):

```json
{
  "scores": {"overall": 0-100, "planning": 0-100, "execution": 0-100,
             "reviewEfficiency": 0-100, "reworkDiscipline": 0-100},
  "verdict": "one-sentence assessment",
  "findings": [{"title": "", "kind": "bottleneck|failure|success|risk",
                "severity": "critical|high|medium|low", "phase": "",
                "agentId": null, "evidence": "cite ticket IDs + metric values",
                "patternKey": null}],
  "recommendations": [{"title": "", "priority": "P0|P1|P2",
                       "type": "workflow-def|prompt|gate-config|process|tooling",
                       "target": "phase/agent/gate", "description": "",
                       "expectedImpact": "", "patternKey": "<area>.<slug>"}],
  "trend": {"priorRunsCompared": N,
            "deltas": {"totalDurationMs": null, "humanWaitTotalMs": null,
                       "changeRequests": null, "overallScore": null},
            "notes": "markdown"},
  "summaryMarkdown": "full report, >= 200 chars",
  "kpiVersion": 1
}
```

Rules: at least one `kind:"success"` finding (what worked). Every finding's
evidence cites ticket IDs and metric values. Recommendations must be
actionable against something concrete: a workflow def's phases/gates
(`workflow-def`/`gate-config`), an agent prompt (`prompt`), the org's process
(`process`), or tooling. `trend.deltas` are this run minus the most recent
prior run (null when no prior).

### `patternKey` — which defect class this is (required on P0/P1)

Every **P0 and P1** recommendation must carry a `patternKey`; `save_analysis.py`
rejects the analysis otherwise. It is optional on P2 and on findings, but a key
you do write must be well-formed. The key is what makes an ask countable: it is
how "the same fix has been recommended 8 times and 6 attempts changed nothing"
becomes a number instead of a hunch, and how the SI loop refuses to re-synthesize
an ask that is already in flight.

**Reuse before you mint.** Read the `si_ledger.py keys` output from step 1 and
reuse the existing key whenever the defect class is the same, even when the
wording, the phase or the agent differs — one defect, one key, forever. Mint a new
one only when no listed key is the same defect class.

Form: `<area>.<slug>[.<slug>]` — lowercase, segments separated by `.`, words
inside a segment by `-`, at least two segments. Name the **defect**, not the fix
and not the run:

```
harness.silent-death.exit-without-report     good — the failure mode
ci.flake.timeout                             good
ops.paging.out-of-hours                      good
fix-the-harness                              bad  — names the fix, single segment
TEAM-4711.retry                              bad  — names a ticket, uppercase
prompt_tuning                                bad  — underscore, no area/slug split
```

A key is not a severity: `severity` comes from the finding that names the same
key, or from the priority when no finding does. Saving the analysis records one
sighting per key in the ledger — so re-running ANALYZE on the same run does not
double-count, but describing one defect under two keys does. `save_analysis.py`
prints `patternKeys` (recorded) and `ledgerErrors` (attempted and failed); if
`ledgerErrors` is non-empty, say so in your step-6 report — the analysis saved but
the ask is not being tracked yet.

`kpiVersion` is the only optional field: copy `metrics.kpiVersion` (`null` when
there was no card). It records which version of the scoring config produced the
score you cited, so a run scored under v1 is never compared against a v2 run as
though the two numbers meant the same thing. `scores` still has EXACTLY its five
keys — the deterministic score is not a sixth one, and `save_analysis.py`
rejects the row if you add it there.

## 4. Save

```bash
python3 /mnt/workspace/toolkit/save_analysis.py <wfId> --trigger <auto|manual>
```

Read its JSON output. If `ignoredParts` is non-empty and you meant those files
to be part of the analysis, add them to `manifest.json` and save again. A
non-empty `truncated` says what was cut to fit the row (counts, bytes, and the
patternKeys named only by dropped entries — their sightings were still recorded).
On success the script renames `analysis.d/` to `analysis.d.saved-<analysisId>/`;
do not write into it again.

## 5. Curate your knowledge file

Same chunking rule as step 3: build the file locally with several small
appends (≤60 lines per tool call), then upload with `aws s3 cp` — one giant
heredoc dies at the output-token cap and kills the session (the analysis
survives; this step doesn't).

Rewrite (not append) `workflow-manager/knowledge/<workflowDefId>.md` in S3:
durable patterns for this workflow def only. Recurring bottlenecks with run
counts, gate ROI observations, agent weak spots, which past recommendations
were adopted and what changed after. Prune anything stale or one-off. Keep it
under ~200 lines — it is your working memory, not an archive.

## 6. Report

Reply with a 3-5 line summary: verdict, overall score, top bottleneck, top
recommendation. When the run had a card, give both numbers — your
`scores.overall` and `metrics.kpi.quality.score`/`grade` — and one clause on
whether they agree.
