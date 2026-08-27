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

## 3. Write the analysis

`/mnt/workspace/<wfId>/analysis.json` with EXACTLY these fields
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
  "summaryMarkdown": "full report, >= 200 chars"
}
```

Rules: at least one `kind:"success"` finding (what worked). Every finding's
evidence cites ticket IDs and metric values. Recommendations must be
actionable against something concrete: a workflow def's phases/gates
(`workflow-def`/`gate-config`), an agent prompt (`prompt`), the org's process
(`process`), or tooling. `trend.deltas` are this run minus the most recent
prior run (null when no prior).

## 4. Save

```bash
python3 /mnt/workspace/toolkit/save_analysis.py <wfId> --trigger <auto|manual>
```

## 5. Curate your knowledge file

Rewrite (not append) `workflow-manager/knowledge/<workflowDefId>.md` in S3:
durable patterns for this workflow def only. Recurring bottlenecks with run
counts, gate ROI observations, agent weak spots, which past recommendations
were adopted and what changed after. Prune anything stale or one-off. Keep it
under ~200 lines — it is your working memory, not an archive.

## 6. Report

Reply with a 3-5 line summary: verdict, overall score, top bottleneck, top
recommendation.
