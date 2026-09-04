/**
 * Performance Card Lambda — deterministic per-workflow-run scorecard covering
 * COST, TIME and QUALITY, plus anomaly bands against the run's own def-level
 * baseline. No LLM anywhere: DynamoDB reads, CloudWatch Logs Insights queries,
 * Cost Explorer + CloudWatch metrics for infra, and arithmetic.
 *
 * (Function name stays `agentcore-hub-cost-report` for deploy continuity; the
 * cost report grew into the performance card, it was not replaced.)
 *
 * Trigger shapes:
 *   1. EventBridge {source: "agentcore-hub.orchestrator", detail-type:
 *      "workflow.complete"} → card (auto, idempotent per completedAt)
 *   2. Direct invoke {workflowId} → card (re-run/backfill, always overwrites)
 *   3. Direct invoke {rebuildIndex: true} → rebuild performance/index.json from
 *      every terminal workflow's existing card, recompute every card's bands
 *      from that index (bands are a pure function of the index), refresh infra.
 *
 * Cost sources, joined per run:
 *   • Persona LLM spans — session.id "{ticketId}_{workflowId}-{agentId}-{ts}"
 *     carries gen_ai.usage.* per model (aws/spans + per-runtime span groups).
 *   • Claude Code CLI — api_request OTEL events on the coding runtime's log
 *     group, session.id = the fleet's cc-* coding session, mapped to
 *     workflow/agent via the cloud-code sessions table.
 *   • Codex / Kiro — structured "coding_usage" app-log records per turn.
 *
 * Time: wall-clock, human-gate wait (interval union), active (wall − human),
 * agent work (Σ task durations), orchestration idle (active − work).
 * Quality: tasks, rework rounds (re-invocations), change requests, fix tickets,
 * review-gate rounds, nudges, interventions, errors, first-pass yield.
 *
 * Bands: for each KPI, median + MAD over the same workflowDefId's cards that
 * completed in the prior BASELINE_DAYS (min BASELINE_MIN samples). z ≥ 2 warn,
 * z ≥ 3 alert. The fleet-level view (/api/workflow/performance) reads the same
 * index and applies the same arithmetic (src/lib/workflow/performance.ts).
 *
 * Output:
 *   s3://{ARTIFACT_BUCKET}/workflows/{wfId}/shared/performance-card.{json,md}
 *   s3://{ARTIFACT_BUCKET}/workflows/{wfId}/shared/cost-report.json  (alias)
 *   s3://{ARTIFACT_BUCKET}/performance/index.json  (fleet index + infra)
 *   events table row type "workflow.performance"
 *   CloudWatch metrics AgentCoreHub/Performance{WorkflowDefId}
 *
 * Env: ARTIFACT_BUCKET (required), WORKFLOWS_TABLE, EVENTS_TABLE,
 *      CLOUD_CODE_TABLE, CODING_RUNTIME_LOG_GROUP, PRICING_S3_KEY,
 *      PERFORMANCE_INDEX_KEY, METRIC_NAMESPACE, PUBLISH_CW_METRICS (1|0),
 *      INFRA_REGION (Cost Explorer filter, default AWS_REGION).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, PutMetricDataCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "us-east-1";
const INFRA_REGION = process.env.INFRA_REGION || REGION;
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const CLOUD_CODE_TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";
const CODING_LOG_GROUP = process.env.CODING_RUNTIME_LOG_GROUP || "";
const PRICING_S3_KEY = process.env.PRICING_S3_KEY || "config/pricing.json";
const INDEX_KEY = process.env.PERFORMANCE_INDEX_KEY || "performance/index.json";
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || "AgentCoreHub/Performance";
const PUBLISH_METRICS = (process.env.PUBLISH_CW_METRICS ?? "1") !== "0";

export const REPORT_VERSION = 3;
export const BASELINE_DAYS = 28;
export const BASELINE_MIN = 5;
const INFRA_WINDOW_DAYS = 30;
const INFRA_REFRESH_MS = 6 * 3600_000;
const INDEX_CAP = 2000;
/** CloudWatch rejects datapoints older than 2 weeks; leave a margin. */
const METRIC_MAX_AGE_MS = 13 * 86_400_000;
const TERMINAL_PHASES = new Set(["complete", "cancelled", "error", "deploy-blocked", "static-ci-only"]);

const DEFAULT_PRICING = {
  models: {}, default: { input: 5.5, output: 27.5 }, cachedInputDiscount: 0.1,
  // Cache-write (5-minute vs 1-hour) surcharge as a multiple of the input rate,
  // keyed by the span's hub.cache_ttl; `default` covers a missing/unknown ttl.
  cacheWriteMultiplier: { "5m": 1.25, "1h": 2, default: 1.25 },
  kiro: { usdPerCredit: 0 }, agentcore: { runtimeGbHourUsd: 0.00945, runtimeVcpuHourUsd: 0.0895 },
};

/**
 * KPIs that get anomaly bands. `floor` is the minimum sigma so a flat baseline
 * (MAD 0) cannot make every run an alert. direction "upper" (default) = higher
 * is worse; "lower" = lower is worse (first-pass yield).
 */
export const BAND_KPIS = [
  { path: "cost.totalUsd", label: "Total cost", unit: "usd", floor: 5 },
  { path: "cost.personaUsd", label: "Persona LLM cost", unit: "usd", floor: 5 },
  { path: "cost.codingUsd", label: "Coding CLI cost", unit: "usd", floor: 2 },
  { path: "cost.tokens.total", label: "Tokens", unit: "tokens", floor: 500_000 },
  { path: "time.wallMs", label: "Wall-clock", unit: "ms", floor: 900_000 },
  { path: "time.activeMs", label: "Active time", unit: "ms", floor: 900_000 },
  { path: "time.agentWorkMs", label: "Agent work", unit: "ms", floor: 900_000 },
  { path: "time.humanWaitMs", label: "Human wait", unit: "ms", floor: 900_000 },
  { path: "quality.tasks", label: "Agent tasks", unit: "count", floor: 1 },
  { path: "quality.reworkRounds", label: "Rework rounds", unit: "count", floor: 1 },
  { path: "quality.loops", label: "Loops", unit: "count", floor: 1 },
  { path: "quality.nudges", label: "Nudges", unit: "count", floor: 1 },
  { path: "quality.errors", label: "Errors", unit: "count", floor: 1 },
  { path: "quality.firstPassYield", label: "First-pass yield", unit: "ratio", floor: 0.1, direction: "lower" },
  { path: "cost.personaCacheHitRate", label: "Persona cache hit rate", unit: "ratio", floor: 0.1, direction: "lower" },
];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const logs = new CloudWatchLogsClient({ region: REGION });
const cw = new CloudWatchClient({ region: REGION });
// Cost Explorer is a us-east-1 global endpoint regardless of the account's region.
const ce = new CostExplorerClient({ region: "us-east-1" });
const s3 = new S3Client({ region: REGION });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = "[performance-card]";

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET not set");
  if (event?.rebuildIndex) return rebuildIndex(event);

  const isEventBridge = event?.source === "agentcore-hub.orchestrator";
  const workflowId = isEventBridge ? event?.detail?.workflowId : event?.workflowId;
  if (!workflowId) throw new Error(`No workflowId in event: ${JSON.stringify(event).slice(0, 300)}`);

  const workflow = (await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }))).Item;
  if (!workflow) {
    console.warn(`${LOG} workflow ${workflowId} not found — skipping`);
    return { skipped: "not-found" };
  }

  const cardKey = cardKeyOf(workflowId);
  if (isEventBridge) {
    const existing = await getJson(cardKey).catch(() => null);
    if (existing?.run?.completedAt && existing.run.completedAt === workflow.completedAt
      && existing.reportVersion === REPORT_VERSION) {
      return { skipped: "already-reported" };
    }
  }

  const pricing = await loadPricing();
  const index = await loadIndex();
  const card = await buildCard(workflowId, workflow, pricing);
  card.bands = computeBands(card, index.cards);
  await writeCard(card);

  index.cards = upsertSummary(index.cards, summarize(card));
  await maybeRefreshInfra(index, pricing);
  await saveIndex(index);

  await Promise.all([publishMetrics(card), putPerformanceEvent(card, cardKey)]);

  console.log(`${LOG} ${workflowId} → $${card.cost.totalUsd} ${card.bands.status} (${cardKey})`);
  return { workflowId, cardKey, totalCostUsd: card.cost.totalUsd, status: card.bands.status, anomalies: card.bands.anomalies };
};

/** Mode 3: rebuild the fleet index from existing cards + recompute their bands. */
async function rebuildIndex(event) {
  const pricing = await loadPricing();
  const workflows = await scanTerminalWorkflows();
  const cards = [];
  for (const chunk of chunks(workflows, 10)) {
    const got = await Promise.all(chunk.map((w) => getJson(cardKeyOf(w.workflowId)).catch(() => null)));
    for (const c of got) if (c?.reportVersion === REPORT_VERSION) cards.push(c);
  }
  let summaries = cards.map(summarize).sort((a, b) => a.completedAt.localeCompare(b.completedAt));

  // Bands are a pure function of the index: recompute for every card so a
  // backfill run in any order converges to the same result.
  let rewritten = 0;
  for (const chunk of chunks(cards, 10)) {
    await Promise.all(chunk.map(async (card) => {
      const next = computeBands(card, summaries);
      if (JSON.stringify(next) !== JSON.stringify(card.bands)) {
        card.bands = next;
        await writeCard(card);
        rewritten++;
      }
    }));
  }
  summaries = cards.map(summarize).sort((a, b) => a.completedAt.localeCompare(b.completedAt));

  const index = { version: 1, updatedAt: new Date().toISOString(), cards: summaries.slice(-INDEX_CAP), infra: null };
  const prior = await loadIndex().catch(() => null);
  if (prior?.infra && !event?.refreshInfra) index.infra = prior.infra;
  await maybeRefreshInfra(index, pricing, !!event?.refreshInfra);
  await saveIndex(index);
  console.log(`${LOG} index rebuilt: ${summaries.length} cards, ${rewritten} bands rewritten`);
  return { cards: summaries.length, rewritten, infraUpdatedAt: index.infra?.updatedAt || null };
}

// ─── Card assembly ────────────────────────────────────────────────────────────

async function buildCard(workflowId, workflow, pricing) {
  const gaps = [];
  const rawEvents = await fetchEvents(workflowId);
  const events = dedupeEvents(rawEvents);
  const codingSessions = await fetchCodingSessions(workflowId);

  const started = workflow.startedAt ? Date.parse(workflow.startedAt) : null;
  const ended = Date.parse(workflow.completedAt || workflow.cancelledAt || "") ||
    (events.length ? Date.parse(events[events.length - 1].timestamp) : Date.now());
  // Query window padded generously — spans flush late, runs can straddle days.
  const qStart = Math.floor(((started || ended) - 3600_000) / 1000);
  const qEnd = Math.floor((ended + 3600_000) / 1000) + 1;

  const spanGroups = await resolveSpanLogGroups();
  const [personaUsage, ccUsage, codingUsage] = await Promise.all([
    queryPersonaSpans(spanGroups, workflowId, qStart, qEnd),
    queryClaudeCodeSpans(spanGroups, codingSessions, qStart, qEnd),
    queryCodingUsageRecords(codingSessions, qStart, qEnd),
  ]);

  // ── Attribute usage rows to agents ──
  const byAgent = {};
  const agentOf = (sid) => {
    const tail = sid.split(`_${workflowId}-`)[1] || "";
    return tail.replace(/-\d+$/, "") || "unknown";
  };
  for (const row of personaUsage) addUsage(byAgent, agentOf(row.sid), "persona", row, pricing);
  const sessionAgent = new Map(codingSessions.map((s) => [s.sessionId, s.agentId || "unknown"]));
  for (const row of ccUsage) addUsage(byAgent, sessionAgent.get(row.sid) || "unknown", "claude_code", row, pricing);
  for (const row of codingUsage) {
    addUsage(byAgent, sessionAgent.get(row.sid) || "unknown", row.cli === "kiro" ? "kiro" : "codex", row, pricing);
  }

  if (!personaUsage.length) gaps.push("no persona spans matched this run's session ids — persona LLM cost missing");
  if (codingSessions.length && !ccUsage.length && !codingUsage.length) {
    gaps.push(`${codingSessions.length} coding session(s) recorded but no usage telemetry found (pre-usage-patch run?)`);
  }
  if (!codingSessions.length) gaps.push("no coding sessions recorded for this run");

  // ── Roll up cost ──
  const byEngine = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cached: 0, total: 0 };
  let kiroCredits = 0, totalUsd = 0, personaUsd = 0;
  for (const rec of Object.values(byAgent)) {
    for (const [engine, u] of Object.entries(rec.engines)) {
      const e = (byEngine[engine] ||= {
        usd: 0, inputTokens: 0, outputTokens: 0,
        cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0,
        kiroCredits: 0, byModel: {},
      });
      e.usd += u.usd; e.inputTokens += u.inputTokens; e.outputTokens += u.outputTokens;
      e.cacheReadInputTokens += u.cacheReadInputTokens; e.cacheWriteInputTokens += u.cacheWriteInputTokens;
      e.cachedInputTokens += u.cachedInputTokens; e.kiroCredits += u.kiroCredits;
      for (const [m, mv] of Object.entries(u.byModel)) {
        const em = (e.byModel[m] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, usd: 0 });
        em.inputTokens += mv.inputTokens; em.outputTokens += mv.outputTokens;
        em.cacheReadInputTokens += mv.cacheReadInputTokens; em.cacheWriteInputTokens += mv.cacheWriteInputTokens;
        em.usd += mv.usd;
      }
      tokens.input += u.inputTokens; tokens.output += u.outputTokens;
      tokens.cacheRead += u.cacheReadInputTokens; tokens.cacheWrite += u.cacheWriteInputTokens;
      tokens.cached += u.cachedInputTokens;
      kiroCredits += u.kiroCredits;
      totalUsd += u.usd;
      if (engine === "persona") personaUsd += u.usd;
    }
    rec.totalUsd = round4(Object.values(rec.engines).reduce((s, u) => s + u.usd, 0));
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  for (const e of Object.values(byEngine)) {
    e.usd = round4(e.usd);
    e.cacheHitRate = cacheHitRate(e.cacheReadInputTokens, e.inputTokens, e.cacheWriteInputTokens);
    for (const m of Object.values(e.byModel)) m.usd = round4(m.usd);
  }
  // Hit rate = cache reads ÷ (fresh input + cache reads + cache writes), i.e. the
  // share of prompt tokens served from cache. null when there was no input at all.
  const cacheHitRateOverall = cacheHitRate(tokens.cacheRead, tokens.input, tokens.cacheWrite);
  const pe = byEngine.persona;
  const personaCacheHitRate = pe
    ? cacheHitRate(pe.cacheReadInputTokens, pe.inputTokens, pe.cacheWriteInputTokens)
    : null;
  if (kiroCredits > 0 && !(pricing.kiro?.usdPerCredit > 0)) {
    gaps.push("kiro credits present but pricing.kiro.usdPerCredit is 0 — kiro USD reported as 0");
  }

  // ── Time ──
  const phases = computePhases(events, ended, gaps);
  const agentTasks = computeAgentTasks(workflow, events);
  const aiTasks = agentTasks.filter((t) => !isHuman(t.agentId));
  const humanWaitMs = computeHumanWait(events, ended);
  const wallMs = started ? Math.max(0, ended - started) : null;
  const activeMs = wallMs == null ? null : Math.max(0, wallMs - humanWaitMs);
  const agentWorkMs = aiTasks.reduce((s, t) => s + (t.durationMs || 0), 0);
  // Union of task intervals: wall time during which at least one agent ran.
  const busyMs = unionMs(aiTasks.filter((t) => t.startedAt && t.completedAt)
    .map((t) => [Date.parse(t.startedAt), Date.parse(t.completedAt)]));
  if (aiTasks.some((t) => t.durationMs == null)) gaps.push("some agent tasks lack start/complete timestamps — agent work time understated");

  // ── Quality ──
  const count = (type) => events.filter((e) => e.type === type).length;
  const changeRequests = count("review.rejected");
  const fixTickets = countFixTickets(events, agentTasks);
  const gates = computeGateRounds(workflow);
  const reworkRounds = aiTasks.reduce((s, t) => s + t.reworkRounds, 0);
  const tasksCompleted = aiTasks.filter((t) => t.status === "complete" || t.status === "done").length;
  const firstPass = aiTasks.filter((t) => t.reworkRounds === 0).length;
  const prUrl = findPrUrl(workflow, events, agentTasks);
  const outcome = workflow.phase || "unknown";

  // ── Per-agent rollup (cost + work + rework) ──
  const agents = {};
  for (const t of aiTasks) {
    const a = (agents[t.agentId] ||= { tasks: 0, workMs: 0, reworkRounds: 0, usd: 0, engines: [] });
    a.tasks++; a.workMs += t.durationMs || 0; a.reworkRounds += t.reworkRounds;
  }
  for (const [agentId, rec] of Object.entries(byAgent)) {
    const a = (agents[agentId] ||= { tasks: 0, workMs: 0, reworkRounds: 0, usd: 0, engines: [] });
    a.usd = rec.totalUsd; a.engines = Object.keys(rec.engines);
  }
  for (const a of Object.values(agents)) a.usd = round4(a.usd);

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    workflowId,
    epicId: workflow.epicId || null,
    workflowDefId: workflow.workflowDefId || workflow.defId || "unknown",
    title: workflow.input?.title || workflow.title || null,
    run: {
      phase: outcome,
      outcome,
      startedAt: workflow.startedAt || null,
      completedAt: workflow.completedAt || workflow.cancelledAt || null,
      prUrl,
      featureBranch: workflow.featureBranch || lastDetail(events, "workflow.complete")?.featureBranch || null,
    },
    cost: {
      totalUsd: round4(totalUsd),
      personaUsd: round4(personaUsd),
      codingUsd: round4(totalUsd - personaUsd),
      perTaskUsd: aiTasks.length ? round4(totalUsd / aiTasks.length) : null,
      tokens,
      cacheHitRate: cacheHitRateOverall,
      personaCacheHitRate,
      kiroCredits: round4(kiroCredits),
      byEngine,
      byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, {
        totalUsd: v.totalUsd,
        engines: Object.fromEntries(Object.entries(v.engines).map(([ek, ev]) => [ek, {
          usd: round4(ev.usd), inputTokens: ev.inputTokens, outputTokens: ev.outputTokens,
          cacheReadInputTokens: ev.cacheReadInputTokens, cacheWriteInputTokens: ev.cacheWriteInputTokens,
          cachedInputTokens: ev.cachedInputTokens,
          ...(ev.kiroCredits ? { kiroCredits: round4(ev.kiroCredits) } : {}),
          byModel: Object.fromEntries(Object.entries(ev.byModel).map(([mk, mv]) => [mk, { ...mv, usd: round4(mv.usd) }])),
        }])),
      }])),
    },
    time: {
      wallMs,
      humanWaitMs,
      activeMs,
      agentWorkMs,
      busyMs,
      idleMs: activeMs == null ? null : Math.max(0, activeMs - busyMs),
      agentUtilization: activeMs ? round4(busyMs / activeMs) : null,
      humanGates: count("review.needed"),
      phases,
    },
    quality: {
      outcome,
      tasks: aiTasks.length,
      tasksCompleted,
      reworkRounds,
      changeRequests,
      fixTickets,
      gateRounds: gates.rounds,
      gateReworks: gates.reworks,
      loops: changeRequests + fixTickets,
      nudges: count("workflow.nudge") + count("nudge"),
      interventions: count("manager.intervention"),
      errors: count("agent.error") + count("error"),
      retries: count("agent.retry"),
      unblocks: count("orchestrator.unblocked"),
      firstPassYield: aiTasks.length ? round4(firstPass / aiTasks.length) : null,
      prUrl,
    },
    agents,
    agentTasks,
    codingSessions: codingSessions.map((s) => ({ sessionId: s.sessionId, cli: s.cli, agentId: s.agentId })),
    bands: null,
    dataQuality: {
      gaps,
      pricingSource: PRICING_S3_KEY,
      events: { raw: rawEvents.length, unique: events.length },
    },
  };
}

export function addUsage(byAgent, agentId, engine, row, pricing) {
  const rec = (byAgent[agentId] ||= { engines: {} });
  const u = (rec.engines[engine] ||= {
    usd: 0, inputTokens: 0, outputTokens: 0,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cachedInputTokens: 0,
    kiroCredits: 0, byModel: {},
  });
  const inp = Number(row.inp || 0), outp = Number(row.outp || 0);
  // Query aliases (post-TEAM-3954): cacheRead / cacheWrite; ttl selects the
  // cache-write surcharge tier (5m vs 1h).
  const read = Number(row.cacheRead || 0), write = Number(row.cacheWrite || 0);
  const credits = Number(row.credits || 0);
  const model = row.model || "unknown";
  u.inputTokens += inp; u.outputTokens += outp;
  u.cacheReadInputTokens += read; u.cacheWriteInputTokens += write;
  u.cachedInputTokens += read; // keep: cached == cache-read, for pre-3954 readers
  u.kiroCredits += credits;
  let usd;
  if (credits > 0) {
    usd = credits * (pricing.kiro?.usdPerCredit || 0);
  } else {
    const p = pricing.models[model] || pricing.default;
    const discount = pricing.cachedInputDiscount ?? 0.1;
    const writeMult = pricing.cacheWriteMultiplier?.[row.ttl] ?? pricing.cacheWriteMultiplier?.default ?? 1.25;
    usd = (inp / 1e6) * p.input
      + (outp / 1e6) * p.output
      + (read / 1e6) * p.input * discount
      + (write / 1e6) * p.input * writeMult;
  }
  u.usd += usd;
  const m = (u.byModel[model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, usd: 0 });
  m.inputTokens += inp; m.outputTokens += outp;
  m.cacheReadInputTokens += read; m.cacheWriteInputTokens += write;
  m.usd += usd;
}

// ─── Bands (pure — mirrored in src/lib/workflow/performance.ts) ───────────────

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function quantile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * Robust band for one KPI: median ± k·sigma where sigma = 1.4826·MAD floored
 * at max(floor, 10% of |median|). Returns null when the baseline is too thin.
 */
export function bandFor(values, current, floor, direction = "upper") {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length < BASELINE_MIN) return null;
  const med = median(xs);
  const mad = median(xs.map((v) => Math.abs(v - med)));
  const sigma = Math.max(1.4826 * mad, 0.1 * Math.abs(med), floor);
  const sign = direction === "lower" ? -1 : 1;
  const z = current == null ? null : (sign * (current - med)) / sigma;
  const status = z == null ? "unknown" : z >= 3 ? "alert" : z >= 2 ? "warn" : "ok";
  return {
    n: xs.length, median: round4(med), p75: round4(quantile(xs, 0.75)), sigma: round4(sigma),
    warnAbove: round4(med + sign * 2 * sigma), alertAbove: round4(med + sign * 3 * sigma), direction,
    value: current == null ? null : round4(current), z: z == null ? null : round4(z), status,
  };
}

/**
 * Baseline = same def's cards that completed within BASELINE_DAYS before this
 * card (strictly earlier, never itself) — so recomputing in any order converges.
 */
export function computeBands(card, summaries) {
  const completedAt = card.run?.completedAt || card.generatedAt;
  const endMs = Date.parse(completedAt);
  const startMs = endMs - BASELINE_DAYS * 86_400_000;
  const baseline = summaries.filter((s) =>
    s.workflowId !== card.workflowId &&
    s.workflowDefId === card.workflowDefId &&
    s.completedAt && Date.parse(s.completedAt) < endMs && Date.parse(s.completedAt) >= startMs &&
    (s.cost?.total ?? 0) > 0);

  const kpis = {};
  const anomalies = [];
  let worst = baseline.length >= BASELINE_MIN ? "ok" : "insufficient";
  for (const k of BAND_KPIS) {
    const values = baseline.map((s) => getPath(s, summaryPathOf(k.path)));
    const current = getPath(card, k.path);
    const band = bandFor(values, current, k.floor, k.direction || "upper");
    kpis[k.path] = band ? { label: k.label, unit: k.unit, ...band } : { label: k.label, unit: k.unit, value: current ?? null, status: "insufficient" };
    if (band?.status === "warn" || band?.status === "alert") {
      anomalies.push({ kpi: k.path, label: k.label, status: band.status, value: band.value, median: band.median, z: band.z });
      if (band.status === "alert" || worst === "ok") worst = band.status;
    }
  }
  return {
    baseline: { workflowDefId: card.workflowDefId, n: baseline.length, windowDays: BASELINE_DAYS, minSamples: BASELINE_MIN },
    status: worst,
    anomalies,
    kpis,
  };
}

/** Card KPI path → index-summary path (summaries are compact). */
function summaryPathOf(path) {
  return path
    .replace("cost.totalUsd", "cost.total")
    .replace("cost.personaUsd", "cost.persona")
    .replace("cost.codingUsd", "cost.coding")
    .replace("cost.tokens.total", "cost.tokens")
    .replace("time.wallMs", "time.wall")
    .replace("time.activeMs", "time.active")
    .replace("time.agentWorkMs", "time.agentWork")
    .replace("time.humanWaitMs", "time.humanWait");
}

export function summarize(card) {
  return {
    workflowId: card.workflowId,
    epicId: card.epicId,
    workflowDefId: card.workflowDefId,
    title: card.title,
    outcome: card.run?.outcome || card.run?.phase || null,
    startedAt: card.run?.startedAt || null,
    completedAt: card.run?.completedAt || card.generatedAt,
    prUrl: card.run?.prUrl || null,
    cost: {
      total: card.cost.totalUsd, persona: card.cost.personaUsd, coding: card.cost.codingUsd,
      tokens: card.cost.tokens.total, tokensIn: card.cost.tokens.input, tokensOut: card.cost.tokens.output,
      cached: card.cost.tokens.cached,
      cacheRead: card.cost.tokens.cacheRead, cacheWrite: card.cost.tokens.cacheWrite,
      cacheHitRate: card.cost.cacheHitRate, personaCacheHitRate: card.cost.personaCacheHitRate,
      byEngine: Object.fromEntries(Object.entries(card.cost.byEngine || {}).map(([k, v]) => [k, v.usd])),
    },
    time: {
      wall: card.time.wallMs, active: card.time.activeMs, agentWork: card.time.agentWorkMs,
      humanWait: card.time.humanWaitMs, busy: card.time.busyMs ?? null, idle: card.time.idleMs, utilization: card.time.agentUtilization,
    },
    quality: {
      tasks: card.quality.tasks, reworkRounds: card.quality.reworkRounds, changeRequests: card.quality.changeRequests,
      fixTickets: card.quality.fixTickets, loops: card.quality.loops, nudges: card.quality.nudges,
      errors: card.quality.errors, gateRounds: card.quality.gateRounds, firstPassYield: card.quality.firstPassYield,
      humanGates: card.time.humanGates,
    },
    agents: Object.fromEntries(Object.entries(card.agents || {}).map(([k, v]) => [k, {
      usd: v.usd, workMs: v.workMs, tasks: v.tasks, reworkRounds: v.reworkRounds,
    }])),
    status: card.bands?.status || "insufficient",
    anomalies: (card.bands?.anomalies || []).map((a) => ({ kpi: a.kpi, status: a.status, z: a.z })),
    gaps: card.dataQuality?.gaps?.length || 0,
  };
}

function upsertSummary(cards, summary) {
  const rest = (cards || []).filter((c) => c.workflowId !== summary.workflowId);
  rest.push(summary);
  rest.sort((a, b) => (a.completedAt || "").localeCompare(b.completedAt || ""));
  return rest.slice(-INDEX_CAP);
}

// ─── Infra (Cost Explorer + CloudWatch runtime split) ─────────────────────────

/** SERVICE → infra bucket. Bedrock model tokens are per-run LLM cost, not infra. */
const SERVICE_BUCKETS = {
  "EC2 - Other": "network",
  "Amazon Virtual Private Cloud": "network",
  "Amazon Elastic File System": "storage",
  "Amazon Simple Storage Service": "storage",
  "AmazonCloudWatch": "observability",
  "Amazon Elastic Container Service": "platform",
  "AWS Lambda": "platform",
  "Amazon DynamoDB": "platform",
  "Amazon EC2 Container Registry (ECR)": "platform",
  "AWS Secrets Manager": "platform",
  "CloudWatch Events": "platform",
  "Amazon Elastic Load Balancing": "platform",
  "AWS Key Management Service": "platform",
  "Amazon Simple Queue Service": "platform",
  "CodeBuild": "ciFleet",
  "AWS CodePipeline": "ciFleet",
  "AWS App Runner": "legacy",
  "Amazon Bedrock Service": "llm",
  "Amazon Bedrock": "llm",
};
const CORE_BUCKETS = ["runtimeCompute", "agentMemory", "network", "storage", "observability", "platform"];
const OPTIONAL_BUCKETS = ["evaluations", "ciFleet", "legacy"];

async function maybeRefreshInfra(index, pricing, force = false) {
  const age = index.infra?.updatedAt ? Date.now() - Date.parse(index.infra.updatedAt) : Infinity;
  if (!force && age < INFRA_REFRESH_MS) return;
  try {
    index.infra = await fetchInfra(pricing, index.cards);
  } catch (e) {
    console.warn(`${LOG} infra refresh failed (kept prior):`, e.message);
    if (!index.infra) index.infra = { updatedAt: null, error: e.message };
  }
}

async function fetchInfra(pricing, summaries) {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - INFRA_WINDOW_DAYS * 86_400_000);
  const day = (d) => d.toISOString().slice(0, 10);
  const period = { Start: day(start), End: day(end) };
  const regionFilter = { Dimensions: { Key: "REGION", Values: [INFRA_REGION] } };

  const [byService, agentcore] = await Promise.all([
    ce.send(new GetCostAndUsageCommand({
      TimePeriod: period, Granularity: "MONTHLY", Metrics: ["UnblendedCost"],
      Filter: regionFilter, GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    })),
    ce.send(new GetCostAndUsageCommand({
      TimePeriod: period, Granularity: "MONTHLY", Metrics: ["UnblendedCost", "UsageQuantity"],
      Filter: { And: [regionFilter, { Dimensions: { Key: "SERVICE", Values: ["Amazon Bedrock AgentCore"] } }] },
      GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
    })),
  ]);

  const services = {};
  for (const r of byService.ResultsByTime || []) {
    for (const g of r.Groups || []) {
      const name = g.Keys[0];
      services[name] = round4((services[name] || 0) + Number(g.Metrics.UnblendedCost.Amount));
    }
  }
  const buckets = Object.fromEntries([...CORE_BUCKETS, ...OPTIONAL_BUCKETS, "llm", "excluded"].map((b) => [b, 0]));
  const serviceBucket = {};
  for (const [name, usd] of Object.entries(services)) {
    if (name === "Amazon Bedrock AgentCore") continue; // split by usage type below
    const b = SERVICE_BUCKETS[name] || "excluded";
    serviceBucket[name] = b;
    buckets[b] += usd;
  }
  const agentcoreByUsage = { runtimeMemoryGbHours: 0, runtimeVcpuHours: 0, runtimeUsd: 0, memoryUsd: 0, evaluationsUsd: 0, otherUsd: 0 };
  for (const r of agentcore.ResultsByTime || []) {
    for (const g of r.Groups || []) {
      const ut = g.Keys[0];
      const usd = Number(g.Metrics.UnblendedCost.Amount), qty = Number(g.Metrics.UsageQuantity.Amount);
      if (/Runtime:/.test(ut)) {
        agentcoreByUsage.runtimeUsd += usd;
        if (/:Memory$/.test(ut)) agentcoreByUsage.runtimeMemoryGbHours += qty;
        if (/:vCPU$/.test(ut)) agentcoreByUsage.runtimeVcpuHours += qty;
      } else if (/Memory:/.test(ut)) agentcoreByUsage.memoryUsd += usd;
      else if (/Evaluations:/.test(ut)) agentcoreByUsage.evaluationsUsd += usd;
      else agentcoreByUsage.otherUsd += usd;
    }
  }
  buckets.runtimeCompute += agentcoreByUsage.runtimeUsd;
  buckets.agentMemory += agentcoreByUsage.memoryUsd;
  buckets.evaluations += agentcoreByUsage.evaluationsUsd;
  buckets.platform += agentcoreByUsage.otherUsd;
  for (const k of Object.keys(buckets)) buckets[k] = round4(buckets[k]);
  for (const k of Object.keys(agentcoreByUsage)) agentcoreByUsage[k] = round4(agentcoreByUsage[k]);

  const runtimes = await fetchRuntimeSplit(start, end, pricing).catch((e) => {
    console.warn(`${LOG} runtime split failed:`, e.message);
    return null;
  });

  const coreTotal = round4(CORE_BUCKETS.reduce((s, b) => s + buckets[b], 0));
  const optionalTotal = round4(OPTIONAL_BUCKETS.reduce((s, b) => s + buckets[b], 0));
  const runsInWindow = (summaries || []).filter((s) => s.completedAt >= period.Start && s.completedAt < period.End + "T").length;
  return {
    updatedAt: new Date().toISOString(),
    region: INFRA_REGION,
    windowDays: INFRA_WINDOW_DAYS,
    period,
    buckets,
    coreTotal,
    optionalTotal,
    llmBilledUsd: round4(buckets.llm),
    runsInWindow,
    perRunCoreUsd: runsInWindow ? round4(coreTotal / runsInWindow) : null,
    perRunRuntimeUsd: runsInWindow ? round4((buckets.runtimeCompute + buckets.agentMemory) / runsInWindow) : null,
    agentcore: agentcoreByUsage,
    runtimes,
    byService: Object.fromEntries(Object.entries(services).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { usd: v, bucket: serviceBucket[k] || "agentcore" }])),
  };
}

/** Per-runtime GB-hours / vCPU-hours from AWS/Bedrock-AgentCore, priced at list. */
async function fetchRuntimeSplit(start, end, pricing) {
  const periodSec = Math.ceil((end - start) / 1000 / 60) * 60;
  const q = (id, metric) => ({
    Id: id, ReturnData: true,
    Expression: `SEARCH('AWS/Bedrock-AgentCore MetricName="${metric}"', 'Sum', ${periodSec})`,
  });
  const res = await cw.send(new GetMetricDataCommand({
    StartTime: start, EndTime: end,
    MetricDataQueries: [q("mem", "MemoryUsed-GBHours"), q("cpu", "CPUUsed-vCPUHours")],
  }));
  const gbRate = pricing.agentcore?.runtimeGbHourUsd ?? 0.00945;
  const cpuRate = pricing.agentcore?.runtimeVcpuHourUsd ?? 0.0895;
  const out = {};
  for (const r of res.MetricDataResults || []) {
    const m = /runtime\/([A-Za-z0-9_]+)-[A-Za-z0-9]+/.exec(r.Label || "");
    if (!m) continue; // aggregate label, browser, code-interpreter
    // Each runtime appears under two dimension sets (with/without Name); dedupe by name.
    const name = m[1];
    const rec = (out[name] ||= { gbHours: 0, vcpuHours: 0, usd: 0, _seen: new Set() });
    const key = `${r.Id}|${(r.Label || "").includes("::")}`;
    if (rec._seen.has(key)) continue;
    rec._seen.add(key);
    // Only take the "::DEFAULT" labelled series (one per runtime) to avoid double counting.
    if (!(r.Label || "").includes("::")) continue;
    const v = (r.Values || []).reduce((s, x) => s + x, 0);
    if (r.Id === "mem") rec.gbHours += v; else rec.vcpuHours += v;
  }
  for (const rec of Object.values(out)) {
    delete rec._seen;
    rec.gbHours = round4(rec.gbHours); rec.vcpuHours = round4(rec.vcpuHours);
    rec.usd = round4(rec.gbHours * gbRate + rec.vcpuHours * cpuRate);
  }
  return out;
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

function cardKeyOf(workflowId) { return `workflows/${workflowId}/shared/performance-card.json`; }

async function writeCard(card) {
  const body = JSON.stringify(card, null, 2);
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: cardKeyOf(card.workflowId), Body: body, ContentType: "application/json" })),
    s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: `workflows/${card.workflowId}/shared/performance-card.md`, Body: renderMarkdown(card), ContentType: "text/markdown" })),
    // Legacy alias — readers of cost-report.json keep working.
    s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: `workflows/${card.workflowId}/shared/cost-report.json`, Body: body, ContentType: "application/json" })),
  ]);
}

async function loadIndex() {
  const idx = await getJson(INDEX_KEY).catch(() => null);
  return idx && Array.isArray(idx.cards) ? idx : { version: 1, updatedAt: null, cards: [], infra: null };
}

async function saveIndex(index) {
  index.updatedAt = new Date().toISOString();
  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET, Key: INDEX_KEY, Body: JSON.stringify(index), ContentType: "application/json",
  }));
}

async function loadPricing() {
  const p = await getJson(PRICING_S3_KEY).catch(() => null);
  return p ? { ...DEFAULT_PRICING, ...p, agentcore: { ...DEFAULT_PRICING.agentcore, ...(p.agentcore || {}) } } : DEFAULT_PRICING;
}

async function publishMetrics(card) {
  if (!PUBLISH_METRICS) return;
  const ts = Date.parse(card.run.completedAt || card.generatedAt);
  if (!Number.isFinite(ts) || Date.now() - ts > METRIC_MAX_AGE_MS) return;
  const dims = [{ Name: "WorkflowDefId", Value: card.workflowDefId }];
  const h = (ms) => (ms == null ? null : ms / 3600_000);
  const points = [
    ["CostUsd", card.cost.totalUsd, "None"],
    ["PersonaCostUsd", card.cost.personaUsd, "None"],
    ["CodingCostUsd", card.cost.codingUsd, "None"],
    ["TokensTotal", card.cost.tokens.total, "Count"],
    ["PersonaCacheHitRate", card.cost.personaCacheHitRate, "None"],
    ["CacheReadTokens", card.cost.tokens.cacheRead, "Count"],
    ["CacheWriteTokens", card.cost.tokens.cacheWrite, "Count"],
    ["WallHours", h(card.time.wallMs), "None"],
    ["ActiveHours", h(card.time.activeMs), "None"],
    ["AgentWorkHours", h(card.time.agentWorkMs), "None"],
    ["HumanWaitHours", h(card.time.humanWaitMs), "None"],
    ["Tasks", card.quality.tasks, "Count"],
    ["ReworkRounds", card.quality.reworkRounds, "Count"],
    ["Loops", card.quality.loops, "Count"],
    ["Nudges", card.quality.nudges, "Count"],
    ["Errors", card.quality.errors, "Count"],
  ].filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: points.map(([MetricName, Value, Unit]) => ({ MetricName, Value, Unit, Dimensions: dims, Timestamp: new Date(ts) })),
    }));
  } catch (e) {
    console.warn(`${LOG} PutMetricData failed:`, e.message);
  }
}

async function putPerformanceEvent(card, cardKey) {
  const timestamp = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: {
      workflowId: card.workflowId,
      eventId: `evt_${Date.now()}_performance`,
      type: "workflow.performance",
      timestamp,
      detail: {
        ticketId: card.epicId, timestamp,
        totalCostUsd: card.cost.totalUsd, personaUsd: card.cost.personaUsd, codingUsd: card.cost.codingUsd,
        tokens: card.cost.tokens,
        wallMs: card.time.wallMs, activeMs: card.time.activeMs, agentWorkMs: card.time.agentWorkMs, humanWaitMs: card.time.humanWaitMs,
        tasks: card.quality.tasks, reworkRounds: card.quality.reworkRounds, loops: card.quality.loops,
        nudges: card.quality.nudges, errors: card.quality.errors,
        status: card.bands.status, anomalies: card.bands.anomalies,
        reportKey: cardKey,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    },
  }));
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

async function getJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
  return JSON.parse(await res.Body.transformToString());
}

async function fetchEvents(workflowId) {
  const out = [];
  let lastKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "workflowId = :w",
      ExpressionAttributeValues: { ":w": workflowId },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(page.Items || []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return out.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
}

/**
 * The events table receives each event from two writers (the orchestrator and
 * the events-writer stream fan-out), so every row appears twice with a
 * different eventId and shuffled detail key order. Count each event once.
 */
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.type === "agent.streaming") continue;
    // The two copies carry the same detail (incl. detail.timestamp) but their
    // row timestamps differ by milliseconds, so key on the detail's own clock.
    const d = e.detail || {};
    const tid = d.ticketId || d.ticket?.id || "";
    const ts = d.timestamp || (e.timestamp || "").slice(0, 19);
    const key = tid
      ? `${e.type}|${ts}|${tid}|${d.agentId || d.assignee || ""}`
      : `${e.type}|${ts}|${stableJson(d)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function stableJson(v) {
  if (v == null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

async function fetchCodingSessions(workflowId) {
  const out = [];
  let lastKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: CLOUD_CODE_TABLE,
      FilterExpression: "workflowId = :w",
      ExpressionAttributeValues: { ":w": workflowId },
      ProjectionExpression: "sessionId, cli, agentId",
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(page.Items || []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function scanTerminalWorkflows() {
  const out = [];
  let lastKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: WORKFLOWS_TABLE,
      ProjectionExpression: "workflowId, phase, deleted, completedAt",
      ExclusiveStartKey: lastKey,
    }));
    for (const w of page.Items || []) {
      if (w.deleted === true || !TERMINAL_PHASES.has(w.phase)) continue;
      out.push(w);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function resolveSpanLogGroups() {
  // PR #90: newer runtimes write spans to their own log group, older to
  // aws/spans. Cover both. Insights accepts up to 50 groups per query.
  const groups = ["aws/spans"];
  try {
    let token;
    do {
      const page = await logs.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: "/aws/bedrock-agentcore/runtimes/", nextToken: token,
      }));
      for (const g of page.logGroups || []) groups.push(g.logGroupName);
      token = page.nextToken;
    } while (token);
  } catch (e) {
    console.warn(`${LOG} describe-log-groups failed:`, e.message);
  }
  return groups.slice(0, 50);
}

async function runInsights(groups, query, startSec, endSec) {
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupNames: groups, queryString: query, startTime: startSec, endTime: endSec,
  }));
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === "Complete") {
      return (res.results || []).map((r) => Object.fromEntries(r.map((f) => [f.field, f.value])));
    }
    if (["Failed", "Cancelled", "Timeout"].includes(res.status)) throw new Error(`Insights query ${res.status}`);
  }
  throw new Error("Insights query did not complete in 120s");
}

async function queryPersonaSpans(groups, workflowId, startSec, endSec) {
  // Strands model spans: name "chat <model>", session.id carries the wf id.
  // Cache read/write tokens land under either the nested (cache_read.input_tokens)
  // or flat (cache_read_input_tokens) OTEL attribute depending on emitter version;
  // hub.cache_ttl (set by the runtime, TEAM-3953) selects the write price tier.
  const q = `fields \`attributes.session.id\` as sid, \`attributes.gen_ai.usage.input_tokens\` as i, \`attributes.gen_ai.usage.output_tokens\` as o, coalesce(\`attributes.gen_ai.usage.cache_read.input_tokens\`, \`attributes.gen_ai.usage.cache_read_input_tokens\`, 0) as cr, coalesce(\`attributes.gen_ai.usage.cache_creation.input_tokens\`, \`attributes.gen_ai.usage.cache_write_input_tokens\`, 0) as cw, \`attributes.hub.cache_ttl\` as ttl, coalesce(\`attributes.gen_ai.request.model\`, "unknown") as model
| filter sid like "${workflowId}" and (name like /^chat / or \`attributes.event.name\` = "api_request")
| stats sum(i) as inp, sum(o) as outp, sum(cr) as cacheRead, sum(cw) as cacheWrite by sid, model, ttl`;
  return runInsights(groups, q, startSec, endSec).catch((e) => {
    console.warn(`${LOG} persona span query failed:`, e.message);
    return [];
  });
}

async function queryClaudeCodeSpans(groups, codingSessions, startSec, endSec) {
  const ids = codingSessions.map((s) => s.sessionId).filter(Boolean);
  if (!ids.length) return [];
  const idList = ids.map((x) => `"${x}"`).join(",");
  const q = `fields \`attributes.session.id\` as sid, \`attributes.gen_ai.usage.input_tokens\` as i, \`attributes.gen_ai.usage.output_tokens\` as o, coalesce(\`attributes.gen_ai.usage.cache_read.input_tokens\`, \`attributes.gen_ai.usage.cache_read_input_tokens\`, 0) as cr, coalesce(\`attributes.gen_ai.usage.cache_creation.input_tokens\`, \`attributes.gen_ai.usage.cache_write_input_tokens\`, 0) as cw, \`attributes.hub.cache_ttl\` as ttl, coalesce(\`attributes.gen_ai.request.model\`, "unknown") as model
| filter sid in [${idList}] and \`attributes.event.name\` = "api_request"
| stats sum(i) as inp, sum(o) as outp, sum(cr) as cacheRead, sum(cw) as cacheWrite by sid, model, ttl`;
  return runInsights(groups, q, startSec, endSec).catch((e) => {
    console.warn(`${LOG} claude-code span query failed:`, e.message);
    return [];
  });
}

async function queryCodingUsageRecords(codingSessions, startSec, endSec) {
  // Structured coding_usage app-log records (codex tokens, kiro credits) live
  // in the coding runtime's APPLICATION log group, not the span groups.
  const ids = codingSessions.map((s) => s.sessionId).filter(Boolean);
  if (!ids.length || !CODING_LOG_GROUP) return [];
  const idList = ids.map((x) => `"${x}"`).join(",");
  const q = `fields coding_session_id as sid, cli, model, input_tokens, output_tokens, cached_input_tokens, credits
| filter message = "coding_usage" and sid in [${idList}]
| stats sum(input_tokens) as inp, sum(output_tokens) as outp, sum(cached_input_tokens) as cacheRead, sum(credits) as credits by sid, cli, model`;
  return runInsights([CODING_LOG_GROUP], q, startSec, endSec).catch((e) => {
    console.warn(`${LOG} coding_usage query failed:`, e.message);
    return [];
  });
}

// ─── Execution metrics ────────────────────────────────────────────────────────

/** Human gate tickets carry agentId "human:*" — or nothing at all. */
function isHuman(agentId) { return !agentId || /^human/i.test(String(agentId)); }

function lastDetail(events, type) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i].detail || {};
  }
  return null;
}

function computePhases(events, endedMs, gaps) {
  const changes = events.filter((e) => e.type === "workflow.phase_change");
  if (!changes.length) {
    gaps.push("no phase_change events — phase durations unavailable");
    return [];
  }
  return changes.map((e, i) => {
    const entered = Date.parse(e.timestamp);
    const exited = i + 1 < changes.length ? Date.parse(changes[i + 1].timestamp) : endedMs;
    return { phase: e.detail?.phase, enteredAt: e.timestamp, durationMs: Math.max(0, exited - entered) };
  });
}

/**
 * One row per ticket in workflow.agentTasks. reworkRounds = distinct
 * agent.invoked instants for the ticket beyond the first (a review "changes
 * requested" reopens the ticket and the orchestrator re-invokes the persona).
 */
function computeAgentTasks(workflow, events) {
  const invokesByTicket = new Map();
  for (const e of events) {
    if (e.type !== "agent.invoked") continue;
    const tid = e.detail?.ticketId;
    if (!tid) continue;
    (invokesByTicket.get(tid) || invokesByTicket.set(tid, new Set()).get(tid)).add(e.timestamp);
  }
  const titles = new Map();
  for (const e of events) {
    if (e.type === "ticket.created" && e.detail?.ticket?.id) titles.set(e.detail.ticket.id, e.detail.ticket.title || "");
  }
  const tasks = [];
  for (const [ticketId, t] of Object.entries(workflow.agentTasks || {})) {
    const invocations = invokesByTicket.get(ticketId)?.size || (t.startedAt ? 1 : 0);
    tasks.push({
      ticketId,
      agentId: t.agentId,
      title: t.title || titles.get(ticketId) || null,
      status: t.status,
      startedAt: t.startedAt || null,
      completedAt: t.completedAt || null,
      durationMs: t.startedAt && t.completedAt
        ? Math.max(0, Date.parse(t.completedAt) - Date.parse(t.startedAt)) : null,
      invocations,
      reworkRounds: Math.max(0, invocations - 1),
      prUrl: t.prUrl || null,
    });
  }
  return tasks;
}

function countFixTickets(events, agentTasks) {
  const ids = new Set();
  for (const e of events) {
    if (e.type === "ticket.created" && String(e.detail?.ticket?.title || "").startsWith("Fix:")) ids.add(e.detail.ticket.id || e.detail.ticketId);
  }
  for (const t of agentTasks) if (String(t.title || "").startsWith("Fix:")) ids.add(t.ticketId);
  return ids.size;
}

/** reviewGateHistory[ticket].rounds[] — one round per review request. */
function computeGateRounds(workflow) {
  let rounds = 0, reworks = 0;
  for (const g of Object.values(workflow.reviewGateHistory || {})) {
    const n = Array.isArray(g?.rounds) ? g.rounds.length : 0;
    rounds += n; reworks += Math.max(0, n - 1);
  }
  return { rounds, reworks };
}

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
function findPrUrl(workflow, events, agentTasks) {
  const hay = [
    workflow.prUrl,
    lastDetail(events, "workflow.complete")?.prUrl,
    ...agentTasks.map((t) => t.prUrl),
    JSON.stringify(workflow.humanNotifications || []),
    ...Object.values(workflow.agentTasks || {}).map((t) => t.output || ""),
  ].filter(Boolean).join("\n");
  const all = hay.match(PR_RE);
  return all ? all[all.length - 1] : null;
}

/** Total length of the union of [start, end] intervals. */
function unionMs(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = null, curEnd = null;
  for (const [s, e] of sorted) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s; curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

function computeHumanWait(events, endedMs) {
  // Union of review.needed → (review.approved|review.rejected|end) intervals.
  // Union, not sum: gates overlap (parallel reviews, re-pings) and a summed
  // wait can exceed wall-clock, which reads as nonsense on the card.
  const needed = events.filter((e) => e.type === "review.needed");
  const resolved = events.filter((e) => e.type === "review.approved" || e.type === "review.rejected");
  const intervals = [];
  for (const n of needed) {
    const reqAt = Date.parse(n.timestamp);
    const tid = n.detail?.ticketId;
    const match = resolved.find((r) => r.detail?.ticketId === tid && Date.parse(r.timestamp) > reqAt);
    const end = match ? Date.parse(match.timestamp) : endedMs;
    if (end > reqAt) intervals.push([reqAt, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = null, curEnd = null;
  for (const [s, e] of intervals) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart;
      curStart = s; curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total;
}

// ─── Markdown render ──────────────────────────────────────────────────────────

function round4(n) { return n == null ? n : Math.round(n * 10000) / 10000; }
/** cacheRead ÷ (input + cacheRead + cacheWrite); null when the denominator is 0. */
function cacheHitRate(read, input, write) {
  const denom = (input || 0) + (read || 0) + (write || 0);
  return denom > 0 ? round4(read / denom) : null;
}
function usd(n) { return n == null ? "—" : `$${n.toFixed(n >= 1 ? 2 : 4)}`; }
function dur(ms) {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function pct(x) { return x == null ? "—" : `${Math.round(x * 100)}%`; }
function fmtKpi(unit, v) {
  if (v == null) return "—";
  if (unit === "usd") return usd(v);
  if (unit === "ms") return dur(v);
  if (unit === "tokens") return `${(v / 1e6).toFixed(1)}M`;
  if (unit === "ratio") return pct(v);
  return String(Math.round(v * 100) / 100);
}
const STATUS_ICON = { ok: "🟢", warn: "🟡", alert: "🔴", insufficient: "⚪", unknown: "⚪" };

function renderMarkdown(c) {
  const b = c.bands || {};
  const lines = [
    `# Performance Card — ${c.workflowId}`,
    ``,
    `${c.title ? `**${c.title}** · ` : ""}Epic **${c.epicId || "—"}** · ${c.workflowDefId} · outcome **${c.run.outcome}** · generated ${c.generatedAt} · deterministic (no LLM)`,
    ``,
    `## ${STATUS_ICON[b.status] || "⚪"} Bands: ${b.status || "—"}${b.baseline ? ` (baseline n=${b.baseline.n}, ${b.baseline.windowDays}d, same def)` : ""}`,
    ``,
  ];
  if (b.anomalies?.length) {
    lines.push(...b.anomalies.map((a) => `- ${STATUS_ICON[a.status]} **${a.label}** ${fmtKpi(b.kpis[a.kpi]?.unit, a.value)} vs median ${fmtKpi(b.kpis[a.kpi]?.unit, a.median)} (z=${a.z})`), ``);
  } else if (b.status === "ok") {
    lines.push(`All tracked KPIs within 2σ of the def baseline.`, ``);
  } else if (b.status === "insufficient") {
    lines.push(`Not enough prior runs of this def in the baseline window to band against.`, ``);
  }
  lines.push(
    `## 💰 Cost: ${usd(c.cost.totalUsd)}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Persona LLM (Strands agents) | ${usd(c.cost.personaUsd)} |`,
    `| Coding CLIs (bolt-ons) | ${usd(c.cost.codingUsd)} |`,
    `| Per agent task | ${usd(c.cost.perTaskUsd)} |`,
    `| Tokens in / out / cache read / cache write · hit rate | ${c.cost.tokens.input.toLocaleString()} / ${c.cost.tokens.output.toLocaleString()} / ${c.cost.tokens.cacheRead.toLocaleString()} / ${c.cost.tokens.cacheWrite.toLocaleString()} · ${pct(c.cost.cacheHitRate)} |`,
    ...(c.cost.kiroCredits ? [`| Kiro credits | ${c.cost.kiroCredits} |`] : []),
    ``,
    `| Engine | Cost | Tokens in | Tokens out | Cache read | Cache write | Hit |`,
    `|---|---|---|---|---|---|---|`,
    ...Object.entries(c.cost.byEngine).sort((a, b2) => b2[1].usd - a[1].usd).map(([k, v]) =>
      `| ${k} | ${usd(v.usd)} | ${v.inputTokens.toLocaleString()} | ${v.outputTokens.toLocaleString()} | ${v.cacheReadInputTokens.toLocaleString()} | ${v.cacheWriteInputTokens.toLocaleString()} | ${pct(v.cacheHitRate)} |`),
    ``,
    `## ⏱ Time: ${dur(c.time.wallMs)} wall`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Wall-clock (end-to-end loop) | ${dur(c.time.wallMs)} |`,
    `| Human gate wait (${c.time.humanGates} gates) | ${dur(c.time.humanWaitMs)} |`,
    `| Active (wall − human) | ${dur(c.time.activeMs)} |`,
    `| Agent work (Σ task durations) | ${dur(c.time.agentWorkMs)} |`,
    `| Agents busy (union of task intervals) | ${dur(c.time.busyMs)} |`,
    `| Orchestration idle (active − busy) | ${dur(c.time.idleMs)} |`,
    `| Agent utilization (busy ÷ active) | ${pct(c.time.agentUtilization)} |`,
    ``,
    `| Phase | Duration |`,
    `|---|---|`,
    ...c.time.phases.map((p) => `| ${p.phase || "?"} | ${dur(p.durationMs)} |`),
    ``,
    `## ✅ Quality: ${c.quality.loops} loop${c.quality.loops === 1 ? "" : "s"}, ${c.quality.reworkRounds} rework round${c.quality.reworkRounds === 1 ? "" : "s"}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Outcome | ${c.quality.outcome} |`,
    `| Agent tasks (completed) | ${c.quality.tasks} (${c.quality.tasksCompleted}) |`,
    `| First-pass yield (tasks with no rework) | ${pct(c.quality.firstPassYield)} |`,
    `| Rework rounds (re-invocations) | ${c.quality.reworkRounds} |`,
    `| Change requests (review rejected) | ${c.quality.changeRequests} |`,
    `| Fix tickets | ${c.quality.fixTickets} |`,
    `| Review-gate rounds / reworks | ${c.quality.gateRounds} / ${c.quality.gateReworks} |`,
    `| Nudges / manager interventions | ${c.quality.nudges} / ${c.quality.interventions} |`,
    `| Errors / retries | ${c.quality.errors} / ${c.quality.retries} |`,
    ...(c.quality.prUrl ? [`| PR | ${c.quality.prUrl} |`] : []),
    ``,
    `## 🤖 By agent`,
    ``,
    `| Agent | Cost | Work | Tasks | Rework | Engines |`,
    `|---|---|---|---|---|---|`,
    ...Object.entries(c.agents).sort((a, b2) => b2[1].usd - a[1].usd).map(([k, v]) =>
      `| ${k} | ${usd(v.usd)} | ${dur(v.workMs)} | ${v.tasks} | ${v.reworkRounds} | ${v.engines.join(", ") || "—"} |`),
    ``,
  );
  if (b.kpis) {
    lines.push(`## 📊 Bands detail`, ``, `| KPI | Value | Median | Warn > | Alert > | z | |`, `|---|---|---|---|---|---|---|`);
    for (const [path, k] of Object.entries(b.kpis)) {
      lines.push(`| ${k.label} | ${fmtKpi(k.unit, k.value)} | ${fmtKpi(k.unit, k.median)} | ${fmtKpi(k.unit, k.warnAbove)} | ${fmtKpi(k.unit, k.alertAbove)} | ${k.z ?? "—"} | ${STATUS_ICON[k.status] || ""} |`);
      void path;
    }
    lines.push(``);
  }
  if (c.dataQuality.gaps.length) lines.push(`## Data gaps`, ``, ...c.dataQuality.gaps.map((g) => `- ${g}`), ``);
  return lines.join("\n");
}

function* chunks(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}
