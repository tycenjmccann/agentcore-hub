---
name: si-synthesis
description: SYNTHESIZE-mode playbook — batch pending run analyses into ONE system-improvement PRD under the SI banner. Separates agent-level gaps (fleet repo) from harness/system gaps (hub repo), writes the PRD to the fleet-imp-agent/prd/ prefix that prd-submitter watches, and marks the analyses as batched. Load on every SYNTHESIZE invocation.
---

# SI synthesis — run analyses → one system-improvement PRD

You are the system-level half of the SI loop. The agent SI loop batches agent
EVALS and improves agent prompts/blueprints in the fleet repo. You batch
WORKFLOW ANALYSES and improve the system the agents operate in: orchestrator,
gates, workflow defs, runtime/harness infra, intake — in the hub repo.

The trigger prompt lists pending `<workflowId>/<analysisId>` pairs. Your job:
one PRD that fixes the highest-leverage systemic gaps across the batch, not a
re-listing of every finding.

## 0. Verify what already shipped — DO THIS FIRST

```bash
python3 /mnt/workspace/toolkit/si_verify.py        # dry run: rules, writes nothing
```

This is the step that stops the loop asking for the same thing forever. It reads
the SI ledger, recomputes each shipped attempt's promised metric before and after
the ship, and rules `verified | no-effect | regressed | insufficient` — by
arithmetic, with no judgement of yours in it.

- **Reproduce its `## Prior attempts` table verbatim** in your report and in the
  PRD when the PRD re-files any pattern it names. Do not restate its verdicts in
  your own words, do not average them with your impression of the runs, and never
  overturn one: it is measuring, you are reading. If you think a verdict is wrong,
  say which number you think is wrong and why — that is a finding about the metric,
  not a licence to ignore it.
- `insufficient` means **not enough runs yet**, not "no effect". A pattern sitting
  at `insufficient` is still being watched; re-filing it buys nothing.
- `no-effect` / `regressed` is the strongest input you have: that ask is still
  owed, and the previous fix is known not to have worked. Say so in the PRD, and
  propose something DIFFERENT — re-filing the same deliverable is the failure mode
  this whole ledger exists to make visible.

Then list what is already tracked, so you reuse keys instead of minting new ones:

```bash
python3 /mnt/workspace/toolkit/si_ledger.py keys
```

## 1. Gather

Bootstrap the toolkit (system prompt), then pull each pending analysis:

```bash
python3 - <<'EOF'
import boto3, json, os
t = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION","us-east-1")).Table(os.environ["ANALYSES_TABLE"])
pairs = [("wfId","analysisId")]  # from the trigger prompt
out = []
for wf, an in pairs:
    out.append(t.get_item(Key={"workflowId": wf, "analysisId": an}).get("Item"))
json.dump(out, open("/mnt/workspace/si-batch.json","w"), default=str)
EOF
```

Also read your knowledge files (`workflow-manager/knowledge/*.md` in S3) —
they hold the cross-run patterns you've already confirmed.

## 2. Synthesize — agents vs the system

Bucket every finding/recommendation in the batch:

- **Agent-level** (an agent's prompt/blueprint/model is weak): NOTE it in the
  PRD's "agent-level observations" appendix but do NOT make it a deliverable —
  the agent SI loop owns those. If one agent dominates the batch, say so; the
  eval loop may be missing it (crashed runs are invisible to evals).
- **System-level** (yours): orchestrator dispatch/recovery, gate placement and
  convergence, workflow-def phase design, runtime/harness infra (timeouts,
  silent deaths, artifact handoffs), intake scoping. These become the PRD.
  Orchestrator deliverables are limited to dispatch / cascade / claim / reaper
  / completion *correctness* (DL-009). Everything about what happens next —
  who waits on whom, re-verification, branch sync, loop caps — is an agent
  blueprint or ticket-tool change (DL-011), even when the symptom is a stall.
  Never ask for a new orchestrator module or `*_MODE` flag.

Rank by leverage: recurrence across runs × wall-clock or rework cost, citing
analysisIds + metric values. 2-4 deliverables max — a PRD with 10 asks
produces a run that converges on none.

### The dedupe gate — which keys you may file

Every deliverable names the `patternKey`s it fixes (the analyses carry them; step 0
listed the rest). A key is **not filable** when the ledger says it is already being
answered, and `si_verify.py` / `si_ledger.py get <key>` print the reason verbatim:

- **`in-run`** — a pipeline run is carrying it right now. File nothing; let that run
  land. Two runs fixing one defect is how you get two conflicting fixes and a
  merge race.
- **`landed` / `deployed` within 14 days and not yet ruled on** — the fix is out and
  nobody has measured it. Wait for `si_verify` to judge it, then you will know
  whether the ask is owed at all.
- **`wont-fix`** — a human turned it off. Do not re-file it; if you believe that is
  wrong, say so in your report rather than routing around it.

An `open`, `no-effect` or `regressed` key is filable — and a `no-effect`/`regressed`
one should be filed with a DIFFERENT approach, citing the failed attempt.

If the gate empties your batch, that is a real outcome: file nothing, and report
that everything in the batch is already in flight or awaiting a verdict. A PRD
submitted anyway is rejected by prd-submitter with the same reason, so you only
lose the run.

## 3. Write the PRD (chunked — same rule as run-analysis)

Build `/mnt/workspace/si-prd.json` in SMALL tool calls (≤60 lines each;
assemble with python if long). Exact shape prd-submitter expects:

```json
{
  "title": "system: <one-line theme of the batch>",
  "description": "markdown: evidence-cited gaps + 2-4 concrete deliverables with acceptance criteria, ending in ## Expected improvements",
  "repoUrl": "<hub repo URL — from the trigger prompt>",
  "sources": [{"type": "s3", "value": "s3://<bucket>/<analysis s3 key>", "label": "analysis <id>"}],
  "batch": {"analysisIds": ["<wfId>/<analysisId>", "..."], "generatedAt": "<iso>"},
  "si": {
    "patternKeys": ["<every key this PRD answers>"],
    "expected": [{
      "patternKey": "harness.silent-death.exit-without-report",
      "metric": "dead_sessions_per_run",
      "baseline": {"value": 2.4, "runs": 5, "window": {"defIds": ["software-delivery"], "since": "<iso>"}},
      "target": 0,
      "observeRuns": 5
    }]
  }
}
```

`repoUrl` is what routes this run to the HUB repo instead of the fleet repo —
never omit it. prd-submitter prefixes the title with `[SI]` itself.

### `si.expected[]` is mandatory — a PRD without it is rejected

prd-submitter refuses a system PRD that carries no `expected[]`, and refuses one
naming a key the dedupe gate blocks. This is not bureaucracy: "expected impact" as
free prose is exactly what made the old loop unfalsifiable — every PRD claimed an
improvement, none named a number anyone could check, so nobody ever checked.

- `metric` must be one of the ten the toolkit computes. `python3
  /mnt/workspace/toolkit/si_metrics.py` with no arguments prints all ten for the
  current window; the names are also in `si_ledger.py`'s `METRIC_NAMES`. A metric
  outside that list is rejected — if the thing you want to promise is not
  measurable yet, the deliverable is "make it measurable".
- `baseline` is **measured, not estimated**: take it from `si_metrics.py <metric>
  --def-id <def> --runs 5`, and copy the `value`, `runs` and `window` it printed.
  If the metric comes back `unavailable`, use `"baseline": null` and say in the
  description that the baseline is unknown — `si_verify` will then recompute the
  before window itself rather than comparing against a number you invented.
- `target` is the number that would make this deliverable a success. `observeRuns`
  (default 5) is how many runs must complete after the fix ships before a verdict
  is possible.
- One `expected` entry per (patternKey, metric). Two metrics for one pattern is
  fine and means both must hold for the row to reach `verified`.

Then end the description with the section the pipeline agents read:

```markdown
## Expected improvements

| pattern | metric | baseline | target | observe |
|---|---|---|---|---|
| `harness.silent-death.exit-without-report` | dead_sessions_per_run | 2.4 (5 runs) | 0 | 5 runs |

These are the numbers this PRD will be judged against by `si_verify.py` after it
ships. They are not aspirations — a run that ships something else has not
delivered this PRD.
```

## 4. Publish + mark batched

```bash
aws s3 cp /mnt/workspace/si-prd.json \
  "s3://$ARTIFACT_BUCKET/fleet-imp-agent/prd/system-$(date +%Y%m%dT%H%M%S).json"
```

The upload IS the submission (S3 → EventBridge → prd-submitter → workflow).
Then mark every batched analysis so the next cycle doesn't re-count it:

```bash
python3 - <<'EOF'
import boto3, os, datetime
t = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION","us-east-1")).Table(os.environ["ANALYSES_TABLE"])
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
for wf, an in pairs:  # same pairs as step 1
    t.update_item(Key={"workflowId": wf, "analysisId": an},
                  UpdateExpression="SET siBatchedAt = :t",
                  ExpressionAttributeValues={":t": now})
EOF
```

Mark rows even if you excluded their findings from the PRD — batched means
"considered", not "shipped". If the PRD upload fails, do NOT mark anything.

Marking the analyses batched does NOT mark the ledger. prd-submitter flips the
pattern rows to `in-run` when it accepts the PRD, because only it knows the run id
that ended up carrying them — a row marked in-run by a PRD that was never submitted
would block the ask forever.

## 5. Report

Reply with: batch size, the PRD title, the 2-4 deliverables (one line each), the
`## Expected improvements` table, and what you left to the agent SI loop.

Also reproduce step 0's `## Prior attempts` table and one line per pattern you
declined to file, with the gate's reason. "I filed nothing because everything is in
flight" is a complete and useful report; a PRD that quietly re-files a key already
in a run is not.
