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
  its own workflow def's recent history (`normal` / `warn` / `alert`, with `z`).
  A `warn`/`alert` band is the strongest "this run was unusual" evidence you have.
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

NEVER write analysis.json in one tool call — a large run's report will hit the
model's output-token cap mid-call, the truncated tool input is discarded, and
the whole ANALYZE invocation dies (this killed every auto-analysis of big
runs). Write it in parts, each tool call small:

1. `/mnt/workspace/<wfId>/summary.md` — the report body. Append it in chunks
   of at most ~60 lines per call (`cat >> summary.md <<'EOF' ...`). Keep the
   whole report under ~300 lines; long evidence belongs in findings, not prose.
2. `/mnt/workspace/<wfId>/analysis-body.json` — everything EXCEPT
   summaryMarkdown. If findings + recommendations are long, append the arrays
   in pieces with python, not one giant heredoc.
3. Assemble:

```bash
python3 - <<'EOF'
import json
w = "/mnt/workspace/<wfId>"
body = json.load(open(f"{w}/analysis-body.json"))
body["summaryMarkdown"] = open(f"{w}/summary.md").read()
json.dump(body, open(f"{w}/analysis.json", "w"), indent=1)
EOF
```

`analysis.json` must have EXACTLY these fields
(`save_analysis.py` rejects anything malformed):

```json
{
  "scores": {"overall": 0-100, "planning": 0-100, "execution": 0-100,
             "reviewEfficiency": 0-100, "reworkDiscipline": 0-100},
  "verdict": "one-sentence assessment",
  "findings": [{"title": "", "kind": "bottleneck|failure|success|risk",
                "severity": "critical|high|medium|low", "phase": "",
                "agentId": null, "evidence": "cite ticket IDs + metric values"}],
  "recommendations": [{"title": "", "priority": "P0|P1|P2",
                       "type": "workflow-def|prompt|gate-config|process|tooling",
                       "target": "phase/agent/gate", "description": "",
                       "expectedImpact": ""}],
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
