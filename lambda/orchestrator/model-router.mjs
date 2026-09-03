/**
 * Complexity-based model router for workflow agent invocations.
 *
 * Routes each agent task to the cheapest model tier that can handle it:
 *   haiku -> sonnet -> opus -> fable
 *
 * Three layers, cheapest first:
 *   L0  phase/agent priors  (0 ms, free)   — default tier + floor per phase
 *   L1  deterministic escalators (0 ms)    — keywords, prompt size, retries, labels
 *   L2  Haiku LLM classifier (~1 s, ~$0.0003) — only when L0+L1 land in the
 *       ambiguity band; skipped entirely when `classifier: false`
 *
 * The `conservatism` knob (0..1) only ever biases UPWARD:
 *   - shifts tier thresholds down (more tasks land on higher tiers)
 *   - raises the confidence bar the classifier must clear to route low
 *   - 1.0 ~= "route almost everything to opus/fable"
 *
 * Every decision returns the full reasoning trail so misroutes are auditable.
 */

// ── Tier catalog ─────────────────────────────────────────────────────────────
// Bedrock inference-profile ids (bare model ids 500 on this account).
// Opus tier pins 4.6: 4.8 requires the Mantle Responses lane in the harness
// catalog and can't take the Converse prefill turn.
export const TIERS = ["haiku", "sonnet", "opus", "fable"];

export const TIER_MODELS = {
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  sonnet: "us.anthropic.claude-sonnet-5",
  opus: "us.anthropic.claude-opus-5",
  fable: "us.anthropic.claude-fable-5-1",
};

const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

// ── L0: phase priors ─────────────────────────────────────────────────────────
// default = where the phase's typical task lands; floor = never route below.
// Phases from src/config/agents.json + workflows.json across all blueprints.
const PHASE_PRIORS = {
  intake: { default: "haiku", floor: "haiku" },
  scheduling: { default: "haiku", floor: "haiku" },
  signoff: { default: "haiku", floor: "haiku" },
  approval: { default: "sonnet", floor: "haiku" },
  qualification: { default: "sonnet", floor: "haiku" },
  triage: { default: "sonnet", floor: "haiku" },
  requirements: { default: "opus", floor: "sonnet" },
  strategy: { default: "opus", floor: "sonnet" },
  design: { default: "opus", floor: "sonnet" },
  development: { default: "opus", floor: "sonnet" },
  generation: { default: "sonnet", floor: "haiku" },
  creative: { default: "sonnet", floor: "haiku" },
  drafting: { default: "sonnet", floor: "sonnet" },
  redline: { default: "opus", floor: "sonnet" },
  review: { default: "opus", floor: "sonnet" },
  verification: { default: "sonnet", floor: "sonnet" },
};
const UNKNOWN_PHASE_PRIOR = { default: "opus", floor: "sonnet" };

// ── L1: deterministic escalators ─────────────────────────────────────────────
// Each hit bumps the running tier to at least `min` (never lowers it).
const ESCALATORS = [
  {
    name: "security-critical",
    min: "opus",
    test: (s) => /\b(security|vulnerab|auth[nz]?|crypto|exploit|injection|owasp|cve)\b/i.test(s),
  },
  {
    name: "architecture-migration",
    min: "opus",
    test: (s) => /\b(architect|migration|refactor(ing)? (the )?(whole|entire|codebase)|redesign|breaking change|data model)\b/i.test(s),
  },
  {
    name: "multi-step-planning",
    min: "opus",
    test: (s) => /\b(plan(ning)? (the )?(sprint|epic|roadmap)|decompose|break down into (tickets|tasks)|dependency (graph|chain))\b/i.test(s),
  },
  {
    name: "debugging-root-cause",
    min: "opus",
    test: (s) => /\b(root.?cause|race condition|deadlock|memory leak|intermittent|flaky|heisenbug)\b/i.test(s),
  },
  {
    name: "large-context",
    min: "sonnet",
    test: (s) => s.length > 60_000, // ~15k tokens of task context
  },
  {
    name: "legal-contract",
    min: "opus",
    test: (s) => /\b(contract|liability|indemnif|compliance|regulatory|gdpr|hipaa)\b/i.test(s),
  },
];

// Share of duplicate lines: 400 identical import lines -> ~0.995.
function lineRepetition(s) {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 20) return 0;
  return 1 - new Set(lines).size / lines.length;
}

// Signals that a task is mechanical enough to sink toward the floor.
const SINKERS = [
  {
    name: "formatting-ops",
    test: (s) =>
      /\b(reformat|rename|lint|bump version|update (the )?(label|status|date)|move file|sort|dedupe|convert .{0,20}to (json|yaml|csv))\b/i.test(s) &&
      (s.length < 2_000 || lineRepetition(s) >= 0.8),
  },
  {
    // Explicit acceptance criteria + a concrete file target in a short
    // prompt = well-specified standard work, not deep reasoning. IMPLEMENTATION
    // work only: a review-phase task normally carries the same filename +
    // "Acceptance:" combination, and sinking it would undercut the router's
    // own policy that correctness review is opus work (and suppress the L2
    // classifier via `sank`).
    name: "well-specified-change",
    test: (s, phase) =>
      phase !== "review" &&
      !/\b(review|audit)\b/i.test(s.slice(0, 200)) &&
      s.length < 1_500 &&
      /\bacceptance( criteria)?\s*:/i.test(s) &&
      /\S+\.(sh|ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|json|ya?ml|toml|css|html|md)\b/i.test(s),
  },
  {
    name: "status-report",
    test: (s) => s.length < 2_000 && /\b(summarize (the )?(status|standup|log)|post (a )?comment|notify|ping)\b/i.test(s),
  },
];

// ── L2: Haiku classifier ─────────────────────────────────────────────────────

const CLASSIFIER_MODEL = TIER_MODELS.haiku;

const CLASSIFIER_SYSTEM = `You route tasks inside an agentic dev/CI workflow to the cheapest capable Claude tier.

Tiers, cheapest first:
- haiku: mechanical work. Tool-call formatting, status updates, renames, log triage, simple extraction/summaries.
- sonnet: standard skilled work. Well-scoped code changes, test writing, doc drafting, straightforward QA.
- opus: hard reasoning. Debugging unclear failures, code review for correctness, cross-cutting design, security analysis.
- fable: frontier reasoning. Long-horizon autonomous planning, architecture of whole systems, tasks where a wrong answer poisons everything downstream.

Judge by: (1) reasoning depth needed, (2) blast radius of a wrong answer, (3) how well-specified the task is. Short tasks can be hard; long tasks can be mechanical. When genuinely torn between two tiers, pick the higher one.`;

const CLASSIFIER_TOOL = {
  toolSpec: {
    name: "route_task",
    description: "Report the routing decision for the task.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          tier: { type: "string", enum: TIERS },
          confidence: { type: "number", description: "0-1 confidence in the tier choice" },
          reason: { type: "string", description: "One short sentence" },
        },
        required: ["tier", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
};

let _bedrockClient;
async function classifyWithHaiku(taskText, phase, region) {
  if (!_bedrockClient) {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    _bedrockClient = new BedrockRuntimeClient({ region: region || process.env.AWS_REGION || "us-east-1" });
  }
  const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");

  const resp = await _bedrockClient.send(
    new ConverseCommand({
      modelId: CLASSIFIER_MODEL,
      system: [{ text: CLASSIFIER_SYSTEM }],
      messages: [
        {
          role: "user",
          content: [{ text: `Workflow phase: ${phase || "unknown"}\n\nTask:\n${taskText.slice(0, 6000)}` }],
        },
      ],
      toolConfig: { tools: [CLASSIFIER_TOOL], toolChoice: { tool: { name: "route_task" } } },
      inferenceConfig: { maxTokens: 200 },
    })
  );

  const toolUse = resp.output?.message?.content?.find((b) => b.toolUse)?.toolUse;
  const input = toolUse?.input || {};
  if (!TIERS.includes(input.tier)) throw new Error(`classifier returned invalid tier: ${JSON.stringify(input)}`);
  return {
    tier: input.tier,
    confidence: typeof input.confidence === "number" ? input.confidence : 0.5,
    reason: input.reason || "",
    usage: resp.usage,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

const maxTier = (a, b) => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/**
 * @param {object} task
 * @param {string} task.prompt        full task/context text sent to the agent
 * @param {string} [task.phase]       workflow phase (requirements|design|development|review|...)
 * @param {string} [task.agentId]
 * @param {number} [task.retryCount]  attempts so far; each retry escalates one tier
 * @param {string[]} [task.labels]    ticket labels
 * @param {object} [opts]
 * @param {number} [opts.conservatism=0.5]  0 = trust the router, 1 = bias hard toward big models
 * @param {boolean} [opts.classifier=true]  allow the Haiku L2 call in the ambiguity band
 * @param {string} [opts.region]
 * @param {object} [opts.overrides]   per-phase prior overrides, same shape as PHASE_PRIORS
 * @returns {Promise<{tier, modelId, source, trail, classifier?, latencyMs}>}
 */
export async function routeTask(task, opts = {}) {
  const t0 = Date.now();
  const conservatism = Math.min(1, Math.max(0, opts.conservatism ?? 0.5));
  const text = task.prompt || "";
  const trail = [];

  // L0 — phase prior
  const priors = { ...PHASE_PRIORS, ...(opts.overrides || {}) };
  const prior = priors[task.phase] || UNKNOWN_PHASE_PRIOR;
  let tier = prior.default;
  let floor = prior.floor;
  trail.push(`L0 phase=${task.phase || "unknown"} default=${tier} floor=${floor}`);

  // Conservatism raises floors: at >=0.75 nothing routes below sonnet.
  if (conservatism >= 0.75 && TIER_RANK[floor] < TIER_RANK.sonnet) {
    floor = "sonnet";
    trail.push(`L0 conservatism=${conservatism} raised floor to sonnet`);
  }

  // L1 — sinkers (only from the phase default, never below floor)
  let sank = false;
  if (conservatism < 0.9) {
    for (const s of SINKERS) {
      if (s.test(text, task.phase)) {
        const target = TIERS[Math.max(TIER_RANK[floor], TIER_RANK[tier] - 1)];
        if (target !== tier) {
          trail.push(`L1 sinker:${s.name} ${tier}->${target}`);
          tier = target;
          sank = true;
        }
        break;
      }
    }
  }

  // L1 — escalators
  let escalated = false;
  for (const e of ESCALATORS) {
    if (TIER_RANK[e.min] > TIER_RANK[tier] && e.test(text)) {
      trail.push(`L1 escalator:${e.name} ${tier}->${e.min}`);
      tier = e.min;
      escalated = true;
    }
  }

  // L1 — labels + retries
  const labels = (task.labels || []).map((l) => l.toLowerCase());
  if (labels.some((l) => ["security", "migration", "critical", "p0"].includes(l))) {
    if (TIER_RANK[tier] < TIER_RANK.opus) {
      trail.push(`L1 label ${tier}->opus`);
      tier = "opus";
      escalated = true;
    }
  }
  if (task.retryCount > 0) {
    const bumped = TIERS[Math.min(TIERS.length - 1, TIER_RANK[tier] + task.retryCount)];
    trail.push(`L1 retry=${task.retryCount} ${tier}->${bumped}`);
    tier = bumped;
    escalated = true;
  }

  // L2 — Haiku classifier, only when L0/L1 produced no strong signal and the
  // task text is substantial enough that the prior alone is a guess.
  const ambiguous = !escalated && !sank && text.length > 300;
  let classifierResult;
  if (ambiguous && opts.classifier !== false) {
    try {
      classifierResult = await classifyWithHaiku(text, task.phase, opts.region);
      const bar = 0.5 + 0.4 * conservatism; // confidence needed to route BELOW the prior
      let cTier = classifierResult.tier;
      if (TIER_RANK[cTier] < TIER_RANK[tier] && classifierResult.confidence < bar) {
        trail.push(`L2 classifier said ${cTier}@${classifierResult.confidence} < bar ${bar.toFixed(2)}, keeping ${tier}`);
        cTier = tier;
      } else {
        trail.push(`L2 classifier ${tier}->${cTier}@${classifierResult.confidence} (${classifierResult.reason})`);
      }
      tier = cTier;
    } catch (err) {
      trail.push(`L2 classifier failed (${err.message}), keeping ${tier}`);
    }
  }

  // Floor is absolute.
  if (TIER_RANK[tier] < TIER_RANK[floor]) {
    trail.push(`floor ${tier}->${floor}`);
    tier = floor;
  }

  return {
    tier,
    modelId: TIER_MODELS[tier],
    source: classifierResult ? "classifier" : escalated ? "escalator" : sank ? "sinker" : "prior",
    trail,
    ...(classifierResult ? { classifier: classifierResult } : {}),
    latencyMs: Date.now() - t0,
  };
}
