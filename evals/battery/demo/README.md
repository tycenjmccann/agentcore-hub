# Mock-mode demo evidence (TEAM-3295)

Captured output of `run-battery.mjs --mock` for the two acceptance scenarios
(see "Mock mode / local demo" in `../README.md`). Both runs execute the full
real pipeline with the deterministic zero-AWS mock transport.

- `green-*`: innocuous edit (trailing comment appended to
  `deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt`) → **✅ PASS**,
  Δ 0 on every evaluator.
- `red-*`: degraded qa-verifier prompt (FIRST STEP + CRITICAL RULES sections
  stripped) → **❌ FAIL**, floor breaches on all four qa-* cases naming
  `persona_contract_compliance` and `Builtin.InstructionFollowing`
  (current 20 < floor 80), plus an overall drop of 8.36 > 5.

Regenerate (each run takes ~1s and makes zero AWS calls):

```bash
# GREEN
printf '\n# innocuous comment\n' >> deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt
node evals/battery/run-battery.mjs --mock --results evals/battery/demo/green-results.json
git checkout -- deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt

# RED — strip the load-bearing sections, run, revert
node -e 'const fs=require("fs"),p="deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt";
fs.writeFileSync(p, fs.readFileSync(p,"utf8")
  .replace(/## FIRST STEP[\s\S]*?(?=## WHAT YOU DO)/,"")
  .replace(/## CRITICAL RULES[\s\S]*?(?=## TOOL STATUS REPORTING)/,""));'
node evals/battery/run-battery.mjs --mock --results evals/battery/demo/red-results.json
git checkout -- deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt
```

(The runner writes `check-summary.md` and `battery-progress.jsonl` next to
`--results`; the summaries here were renamed to `green-/red-check-summary.md`
and the progress files dropped.)
