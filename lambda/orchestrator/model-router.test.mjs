/**
 * Standalone router benchmark. Runs outside the workflow:
 *   node model-router.test.mjs                 # heuristics only (no AWS calls)
 *   node model-router.test.mjs --live          # includes Haiku L2 classifier calls
 *   node model-router.test.mjs --live --conservatism 0.8
 */
import { routeTask, TIERS } from "./model-router.mjs";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const CONS = args.includes("--conservatism") ? parseFloat(args[args.indexOf("--conservatism") + 1]) : 0.5;

// Labeled set: expected = acceptable tiers (router passing = lands in set).
// Mix of real workflow-shaped tasks across phases + adversarial cases
// (short-but-hard, long-but-mechanical).
const CASES = [
  // — mechanical / ops (want haiku) —
  { name: "rename-config-key", phase: "development", expected: ["haiku", "sonnet"],
    prompt: "Rename the config key `maxRetries` to `maxAttempts` in src/config/agents.json and update the two call sites that read it. No behavior change." },
  { name: "status-summary", phase: "intake", expected: ["haiku"],
    prompt: "Summarize the status of the last 5 workflow runs from the log lines below and post a comment on the epic.\n" + "run-1 ok\nrun-2 ok\nrun-3 failed lint\nrun-4 ok\nrun-5 ok" },
  { name: "convert-yaml", phase: "scheduling", expected: ["haiku"],
    prompt: "Convert this campaign schedule to JSON and sort by date.\n- 2026-09-01: launch email\n- 2026-08-20: teaser post\n- 2026-09-15: retargeting" },
  { name: "long-but-mechanical", phase: "development", expected: ["haiku", "sonnet"],
    prompt: "Reformat the following 400 import statements to sort alphabetically. " + "import a from 'a';\n".repeat(400) },

  // — standard skilled work (want sonnet) —
  { name: "scoped-code-change", phase: "development", expected: ["sonnet"],
    prompt: "Add a `--dry-run` flag to scripts/submit-workflow.sh. When set, print the payload that would be POSTed to /api/workflow/start but do not send it. Follow the existing flag parsing style in the script. Include a usage line in the header comment. The script currently accepts --epic and --repo flags and posts JSON with curl. Acceptance: running with --dry-run makes no network calls and exits 0." },
  { name: "write-unit-tests", phase: "verification", expected: ["sonnet"],
    prompt: "Write vitest unit tests for src/lib/workflow/ticket-provider.ts covering: creating a ticket, transitioning status pending->running->done, and the error path when the DynamoDB put fails (mock the client). Match the test style used in src/lib/models/harness-models.test.ts. Aim for the public API only, no private internals. Provide the full test file." },
  { name: "draft-blog-post", phase: "creative", expected: ["sonnet"],
    prompt: "Draft a 600-word launch blog post for our new workflow manager feature. Audience: engineering leads evaluating agentic CI tools. Tone: technical but not academic. Cover: what it watches, how fix-it tickets work, and one concrete debugging story. End with a CTA to the docs. Avoid superlatives and marketing fluff. Structure: hook, 3 sections with headers, CTA." },
  { name: "qa-happy-path", phase: "verification", expected: ["sonnet"],
    prompt: "Run the happy-path QA checklist on the staging build: create an epic, watch the pipeline advance through requirements and design, verify the board shows all 8 design agents, and confirm the QA phase card lists the code-reviewer. Record pass/fail per step with a screenshot name for each. The checklist has 12 steps, listed below. Steps: " + Array.from({length:12},(_,i)=>`step ${i+1}: verify card ${i+1} renders;`).join(" ") },

  // — hard reasoning (want opus) —
  { name: "debug-flaky-test", phase: "development", expected: ["opus", "fable"],
    prompt: "The e2e test tests/workflow-manager-panel.spec.ts fails intermittently in CI (about 1 in 7 runs) with a timeout waiting for the fix-it ticket row to appear. It always passes locally. Recent changes touched the DynamoDB stream handler and the SSE event relay. Find the root cause and fix it — do not just raise the timeout." },
  { name: "code-review-diff", phase: "review", expected: ["opus", "fable"],
    prompt: "Review this diff for correctness before it merges. It changes the orchestrator retry guard to check live harness status instead of the cached manifest. Look for race conditions between the stream trigger and the status poll, double-invoke risk when a retry fires while the original is still streaming, and Jira-mode behavior where the tickets table does not exist. Diff:\n" + "- if (manifest.status === 'running') return;\n+ const live = await getHarnessStatus(arn);\n+ if (live.status === 'running') return;\n".repeat(3) },
  { name: "security-review", phase: "review", expected: ["opus", "fable"],
    prompt: "Security review of the new /api/workflow/start endpoint: it accepts a repo URL and epic description from an unauthenticated Slack webhook and passes them into the orchestrator prompt. Assess injection risk into agent prompts, SSRF via the repo URL, and whether a crafted epic description can make an agent exfiltrate env vars through the report_completion tool." },
  { name: "short-but-hard", phase: "development", expected: ["opus", "fable"],
    prompt: "Workflow runs deadlock when two fix-it tickets for the same agent close within the same second. Fix the root cause." },

  // — frontier / long-horizon (want opus/fable) —
  { name: "architecture-plan", phase: "design", expected: ["opus", "fable"],
    prompt: "Design the architecture for multi-region failover of the whole workflow system: orchestrator Lambda, DynamoDB tables (workflows, tickets, events), the AgentCore harness fleet, and the SSE relay. Cover data-model changes for cross-region idempotency, how in-flight agent sessions fail over, and a migration plan from the current single-region deployment with zero dropped workflows. Produce an ADR with alternatives considered." },
  { name: "epic-decomposition", phase: "requirements", expected: ["opus", "fable"],
    prompt: "Break down this epic into tickets with a dependency graph: 'Add human-in-the-loop approval gates between workflow phases, configurable per blueprint, with Slack approval buttons, timeout escalation, and audit trail.' Consider which phases the orchestrator must pause, how the state machine changes, UI board changes, and Jira-mode differences. Output tickets with acceptance criteria and blocked-by edges." },

  // — phase-prior sanity —
  { name: "requirements-analysis", phase: "requirements", expected: ["sonnet", "opus"],
    prompt: "Analyze the attached PRD for the campaign-scheduler feature and produce user stories with acceptance criteria. The PRD covers audience selection, send-time optimization, and a review step. Flag any ambiguous requirements as open questions rather than guessing. About 15 stories expected." },
  { name: "legal-contract-review", phase: "review", expected: ["opus", "fable"],
    prompt: "Review the MSA redlines in section 7 (limitation of liability) and section 9 (indemnification). Counterparty struck our liability cap and added unlimited indemnity for IP claims. Draft our response position." },
];

function fmt(s, w) { return String(s).padEnd(w); }

const results = [];
for (const c of CASES) {
  const r = await routeTask(
    { prompt: c.prompt, phase: c.phase },
    { conservatism: CONS, classifier: LIVE }
  );
  const pass = c.expected.includes(r.tier);
  results.push({ ...c, ...r, pass });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${fmt(c.name, 24)} ${fmt(c.phase, 14)} -> ${fmt(r.tier, 7)} (want ${c.expected.join("/")})  ${fmt(r.source, 10)} ${r.latencyMs}ms`
  );
  if (!pass) console.log(`      trail: ${r.trail.join(" | ")}`);
}

const passed = results.filter((r) => r.pass).length;
const byTier = Object.fromEntries(TIERS.map((t) => [t, results.filter((r) => r.tier === t).length]));
const l2calls = results.filter((r) => r.classifier).length;
const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)];
const max = lat[lat.length - 1];

// Cost model: $/MTok in/out. Assume avg task = 8k in / 2k out.
const PRICE = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25], fable: [10, 50] };
const taskCost = (t) => (8000 * PRICE[t][0] + 2000 * PRICE[t][1]) / 1e6;
const routedCost = results.reduce((s, r) => s + taskCost(r.tier), 0);
const allOpusCost = results.length * taskCost("opus");
const allFableCost = results.length * taskCost("fable");

console.log(`\n${passed}/${results.length} pass  conservatism=${CONS}  classifier=${LIVE ? "on" : "off"}`);
console.log(`tiers: ${TIERS.map((t) => `${t}=${byTier[t]}`).join("  ")}   L2 calls: ${l2calls}`);
console.log(`router latency: p50=${p50}ms max=${max}ms`);
console.log(`est. cost @8k-in/2k-out per task: routed $${routedCost.toFixed(3)} vs all-opus $${allOpusCost.toFixed(3)} (${(100 * (1 - routedCost / allOpusCost)).toFixed(0)}% saved) vs all-fable $${allFableCost.toFixed(3)} (${(100 * (1 - routedCost / allFableCost)).toFixed(0)}% saved)`);
process.exit(passed === results.length ? 0 : 1);
