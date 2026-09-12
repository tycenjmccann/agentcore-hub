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
import { readFileSync } from "node:fs";

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

/**
 * Quality-score configuration — the ONE home for every weight, tolerance, cap and
 * grade threshold (R-3). `lambda/cost-report/kpi.json` is a committed symlink to
 * `src/config/kpi.json`, so the file the Lambda reads and the file the app reads
 * are the same bytes; the deploy zip stores the symlink's *contents*.
 *
 * Read once per cold start with readFileSync (not an import attribute, which
 * would need a JSON module flag on older runtimes). NEVER from S3 — a scorer that
 * can silently pick up new weights mid-fleet is not deterministic — and there is
 * deliberately no in-code default: a missing config must fail loudly rather than
 * score every run against invented numbers.
 */
const KPI_CANDIDATES = ["./kpi.json", "./src/config/kpi.json", "../../src/config/kpi.json"];
function loadKpiConfig() {
  for (const url of KPI_CANDIDATES) {
    try {
      return JSON.parse(readFileSync(new URL(url, import.meta.url), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  throw new Error("kpi.json not found next to index.mjs — refusing to score");
}
export const KPI_CONFIG = loadKpiConfig();

export const REPORT_VERSION = 5; // 5: card.kpi contract (deterministic quality score); 4: uncached-input pricing (cache tokens no longer double-billed)
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
  // The deterministic quality score is banded like any other KPI: a run scoring
  // well below its own def's median is the anomaly, not a fixed threshold.
  { path: "quality.score", label: "Quality score", unit: "count", floor: 5, direction: "lower" },
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

/**
 * A1: should this invoke be allowed to (over)write a card? Pure — no AWS, no
 * logging — so it unit-tests without mocking the DDB client that owns `workflow`.
 *
 * A direct {workflowId} invoke is reachable by anyone who can invoke this
 * Lambda, and it always overwrites the card. Refuse the two cases where doing so
 * would publish something wrong: a deleted run (card resurrected after the row
 * was removed) and a still-running one (a half-run scored as if it had ended).
 * EventBridge only ever fires on workflow.complete, so its path is untouched.
 */
export function guardWorkflow(workflow, { isEventBridge }) {
  if (!workflow) return { skipped: "not-found" };
  if (isEventBridge) return null;
  if (workflow.deleted === true) return { skipped: "deleted" };
  if (!TERMINAL_PHASES.has(workflow.phase)) return { skipped: "not-terminal" };
  return null;
}

export const handler = async (event) => {
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET not set");
  if (event?.rebuildIndex) return rebuildIndex(event);

  const isEventBridge = event?.source === "agentcore-hub.orchestrator";
  const workflowId = isEventBridge ? event?.detail?.workflowId : event?.workflowId;
  if (!workflowId) throw new Error(`No workflowId in event: ${JSON.stringify(event).slice(0, 300)}`);

  const workflow = (await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }))).Item;
  const guard = guardWorkflow(workflow, { isEventBridge });
  if (guard) {
    console.warn(`${LOG} workflow ${workflowId} skipped: ${guard.skipped}`);
    return guard;
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
  // card.kpi is built with band "unknown"/z null (the score exists before any
  // baseline does); the bands are what teach it where the run sits.
  stampKpiBands(card);
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
  //
  // D-17: kpi.{cost,time,quality}.band/z are a *copy* of three band statuses, so
  // the write-if-changed test has to cover the copy too — otherwise a card whose
  // bands are unchanged but whose stamp was written by an older version (or not at
  // all) never gets rewritten. Stamp a throwaway probe and compare both, rather
  // than stamping `card` first and comparing after (which can never differ).
  let rewritten = 0;
  for (const chunk of chunks(cards, 10)) {
    await Promise.all(chunk.map(async (card) => {
      const before = JSON.stringify({ bands: card.bands, kpi: card.kpi ?? null });
      const next = computeBands(card, summaries);
      const probe = { ...card, bands: next, kpi: card.kpi ? JSON.parse(JSON.stringify(card.kpi)) : null };
      stampKpiBands(probe);
      if (JSON.stringify({ bands: next, kpi: probe.kpi }) !== before) {
        card.bands = next;
        card.kpi = probe.kpi;
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

/**
 * The completion record an agent wrote for one ticket, or null when there is none.
 *
 * Flat `completions/{ticketId}.json` — the key lambda/workflow-output/index.mjs
 * actually writes (there is no per-workflow prefix). A missing object is a fact
 * (the ticket never reported), so it becomes null; anything else is a real read
 * failure and rethrown, which deriveCiVerdict turns into an "unknown" verdict plus
 * a dataQuality gap rather than a silent "no CI evidence".
 */
async function defaultGetCompletion(ticketId) {
  try {
    return await getJson(`completions/${ticketId}.json`);
  } catch (e) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function buildCard(workflowId, workflow, pricing, getCompletion = defaultGetCompletion) {
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
  // TEAM-3966 F6: review.parked_advisory is a human's request-changes the
  // orchestrator parked (all findings out-of-diff) rather than reopening — still
  // a change request. Deliberately NOT in computeHumanWait's resolution set: a
  // parked gate is not resolved.
  const changeRequests = count("review.rejected") + count("review.parked_advisory");
  const fixTickets = countFixTickets(events, agentTasks, workflow);
  const gates = computeGateRounds(workflow);
  const reworkRounds = aiTasks.reduce((s, t) => s + t.reworkRounds, 0);
  const tasksCompleted = aiTasks.filter((t) => t.status === "complete" || t.status === "done").length;
  const firstPass = aiTasks.filter((t) => t.reworkRounds === 0).length;
  const prUrl = findPrUrl(workflow, events, agentTasks);
  const outcome = workflow.phase || "unknown";
  const ci = await deriveCiVerdict(workflow, agentTasks, getCompletion, gaps);
  // A run whose telemetry produced no cost at all is not a $0 run — it is a run we
  // could not price. It still gets a card (its time and quality are real); the cost
  // KPIs are the only part that has to abstain. §6.
  const costMissing = !(round4(totalUsd) > 0);

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

  // Hoisted: kpi.computedAt is the same instant as the card's own, by contract.
  const generatedAt = new Date().toISOString();

  const card = {
    reportVersion: REPORT_VERSION,
    generatedAt,
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
      ci,
      // Filled from card.kpi.quality.score below — one source of truth, two paths.
      score: null,
      prUrl,
    },
    agents,
    agentTasks,
    codingSessions: codingSessions.map((s) => ({ sessionId: s.sessionId, cli: s.cli, agentId: s.agentId })),
    bands: null,
    kpi: null,
    dataQuality: {
      gaps,
      costMissing,
      pricingSource: PRICING_S3_KEY,
      events: { raw: rawEvents.length, unique: events.length },
    },
  };

  card.kpi = buildKpiBlock(card, KPI_CONFIG);
  card.quality.score = card.kpi.quality.score;
  return card;
}

/**
 * Whether an engine's `input_tokens` already counts its cache traffic.
 *
 * Strands/Bedrock spans (persona) report input_tokens = uncached + cache_read +
 * cache_write (verified live: total_tokens == input + output, and
 * input − read − write ≈ 2 per call). Codex/OpenAI `cached_input_tokens` is a
 * subset of `input_tokens`. Claude Code's api_request event reports only the
 * uncached remainder. Billing `inp` at the full rate AND adding the cache lines
 * charged cached tokens at 110% instead of 10% — a ~7x overstatement on
 * cache-heavy persona runs (REPORT_VERSION 4 corrects every card).
 */
const INPUT_INCLUDES_CACHE = { persona: true, codex: true, kiro: true, claude_code: false };

/** Input tokens that Bedrock bills at the full (uncached) rate. */
export function uncachedInput(engine, inp, read, write) {
  const cached = read + write;
  const inclusive = INPUT_INCLUDES_CACHE[engine] ?? (inp >= cached);
  return inclusive ? Math.max(inp - cached, 0) : inp;
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
    const uncached = uncachedInput(engine, inp, read, write);
    // Per-model absolute cache-read rate wins over the fractional default
    // (fable-5-1 bills cache reads at 2.5% of input, not 10%).
    const readRate = Number.isFinite(p.cacheReadInput) ? p.cacheReadInput : p.input * discount;
    usd = (uncached / 1e6) * p.input
      + (outp / 1e6) * p.output
      + (read / 1e6) * readRate
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
 *
 * §6: the $0 filter used to sit on the baseline itself, which threw a run's time
 * and quality history away because its *cost* telemetry was missing. There is one
 * baseline now, and only the cost KPIs narrow to the runs that were actually
 * priced (`costBaseline`); a run we could not price also abstains from its own cost
 * bands rather than banding a fake 0 against real spend.
 */
export function computeBands(card, summaries) {
  const completedAt = card.run?.completedAt || card.generatedAt;
  const endMs = Date.parse(completedAt);
  const startMs = endMs - BASELINE_DAYS * 86_400_000;
  const baseline = summaries.filter((s) =>
    s.workflowId !== card.workflowId &&
    s.workflowDefId === card.workflowDefId &&
    s.completedAt && Date.parse(s.completedAt) < endMs && Date.parse(s.completedAt) >= startMs);
  const costBaseline = baseline.filter((s) => (s.cost?.total ?? 0) > 0);

  const kpis = {};
  const anomalies = [];
  let worst = baseline.length >= BASELINE_MIN ? "ok" : "insufficient";
  for (const k of BAND_KPIS) {
    const isCost = k.path.startsWith("cost.");
    const pool = isCost ? costBaseline : baseline;
    const values = pool.map((s) => getPath(s, summaryPathOf(k.path)));
    const current = isCost && card.dataQuality?.costMissing ? null : getPath(card, k.path);
    const band = bandFor(values, current, k.floor, k.direction || "upper");
    kpis[k.path] = band ? { label: k.label, unit: k.unit, ...band } : { label: k.label, unit: k.unit, value: current ?? null, status: "insufficient" };
    if (band?.status === "warn" || band?.status === "alert") {
      anomalies.push({ kpi: k.path, label: k.label, status: band.status, value: band.value, median: band.median, z: band.z });
      if (band.status === "alert" || worst === "ok") worst = band.status;
    }
  }
  return {
    baseline: {
      workflowDefId: card.workflowDefId, n: baseline.length, nCost: costBaseline.length,
      windowDays: BASELINE_DAYS, minSamples: BASELINE_MIN,
    },
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

// ─── Quality score (pure — config-driven, no clock/I/O/randomness) ────────────
//
// R-3: every weight, tolerance, cap and grade threshold lives in kpi.json. The only
// numeric literals below are 0, 1 and 100 (a share of the whole, and the two ends
// of a normalized scale) plus the 0.5 of round-half-up, which is the rounding rule
// itself and not a tunable. If you find yourself typing another number here, it
// belongs in src/config/kpi.json with a kpiVersion bump.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Round half UP, always — written out rather than Math.round so the tie direction
 * is explicit and identical in the TypeScript mirror (Math.round in JS rounds
 * −0.5 to −0, i.e. toward +∞ too, but nothing about the name says so).
 */
const roundHalfUp = (x) => Math.floor(x + 0.5);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * One component's raw reading and its 0..1 normalization, per §2.1.
 *
 * `normalized` is returned UNCLAMPED and UNROUNDED on purpose: a run with 12
 * loops against a tolerance of 8 shows −0.5, which says "half a tolerance past
 * the limit" — the clamp is applied when the points are awarded, so the card
 * can show how far out a run was without letting one bad component eat
 * another's contribution. Per design §3 step 2, only `points` is rounded
 * (round4); `normalized` is the raw arithmetic result.
 */
function normalizeComponent(card, c) {
  if (c.kind === "ratio") {
    const raw = getPath(card, c.source);
    if (!isNum(raw)) return { raw: raw ?? null, normalized: null, note: `${c.source} is not a number` };
    return { raw, normalized: raw };
  }
  if (c.kind === "rate") {
    const num = getPath(card, c.source);
    const per = getPath(card, c.per);
    if (!isNum(num)) return { raw: null, normalized: null, note: `${c.source} is not a number` };
    if (!isNum(per) || per === 0) return { raw: null, normalized: null, note: `${c.per} is 0 or missing — no denominator` };
    const raw = num / per;
    return { raw, normalized: 1 - raw / c.tolerance };
  }
  if (c.kind === "count") {
    const raw = getPath(card, c.source);
    if (!isNum(raw)) return { raw: raw ?? null, normalized: null, note: `${c.source} is not a number` };
    return { raw, normalized: 1 - raw / c.tolerance };
  }
  if (c.kind === "sum") {
    const parts = c.sources.map((s) => getPath(card, s));
    const present = parts.filter(isNum);
    if (!present.length) return { raw: null, normalized: null, note: `none of ${c.sources.join(", ")} is a number` };
    const raw = present.reduce((s, v) => s + v, 0);
    return { raw, normalized: 1 - raw / c.tolerance };
  }
  if (c.kind === "excess") {
    const value = getPath(card, c.source);
    const base = getPath(card, c.baseline);
    if (!isNum(value)) return { raw: null, normalized: null, note: `${c.source} is not a number` };
    if (!isNum(base)) return { raw: null, normalized: null, note: `${c.baseline} is not a number` };
    const raw = Math.max(0, value - base);
    return { raw, normalized: 1 - raw / c.tolerance };
  }
  if (c.kind === "verdict") {
    const raw = getPath(card, c.source) ?? null;
    if ((c.neutralOn || []).includes(raw)) return { raw, normalized: null, note: `${c.source} is "${raw}" — neutral, weight redistributed` };
    const mapped = c.values?.[raw];
    if (!isNum(mapped)) return { raw, normalized: null, note: `${c.source} "${raw}" is not a known verdict` };
    return { raw, normalized: mapped };
  }
  return { raw: null, normalized: null, note: `unknown component kind "${c.kind}"` };
}

/**
 * The deterministic 0-100 quality score for one card. Pure: same card in, same
 * object out, forever — no clock, no I/O, no randomness, nothing read from the
 * environment. That is the whole point of it existing next to the Workflow
 * Manager's agent-authored `scores.overall`.
 *
 * Components a run has no evidence for are EXCLUDED, not scored 0, and the rest are
 * renormalized over the weight that was actually available (`confidence: "partial"`).
 * Below `minEvidenceWeight` there is no honest number to report, so the score is
 * null rather than a guess.
 */
export function computeKpi(card, config) {
  const spec = config.quality;
  const components = [];
  const excluded = [];
  let evidenceWeight = 0;
  let earned = 0;

  for (const c of spec.components) {
    const { raw, normalized, note } = normalizeComponent(card, c);
    const included = isNum(normalized);
    if (included) {
      const clamped = clamp01(normalized);
      evidenceWeight += c.weight;
      earned += c.weight * clamped;
      components.push({
        key: c.key, label: c.label, weight: c.weight, raw,
        normalized, points: round4(c.weight * clamped), included: true, note: null,
      });
    } else {
      excluded.push(c.key);
      components.push({
        key: c.key, label: c.label, weight: c.weight, raw: raw ?? null,
        normalized: null, points: null, included: false, note: note || null,
      });
    }
  }

  const outcome = card.run?.outcome ?? null;
  if (evidenceWeight < spec.minEvidenceWeight) {
    return {
      score: null, grade: null, confidence: "insufficient", evidenceWeight, outcome,
      band: "unknown", z: null, components, excluded, capsApplied: [],
    };
  }

  // Renormalize over the weight that was actually available, then round once.
  let score = roundHalfUp(100 * earned / evidenceWeight);
  const capsApplied = [];
  const cap = config.outcomeCaps?.[outcome];
  // Recorded only when the cap actually lowered the score: "capped at 69" on a run
  // that scored 40 anyway would read as an explanation it isn't.
  if (isNum(cap) && score > cap) {
    capsApplied.push({ kind: "outcome", outcome, cap });
    score = cap;
  }
  const confidence = evidenceWeight === 100 ? "full" : "partial";
  const grade = config.grades.find((g) => score >= g.min)?.grade ?? null;

  return { score, grade, confidence, evidenceWeight, outcome, band: "unknown", z: null, components, excluded, capsApplied };
}

/**
 * card.kpi v1 — the three hero KPIs in one place, so a reader never has to know
 * which of cost/time/quality lives under which card section. Bands are stamped
 * later (they need the fleet index); see stampKpiBands.
 */
export function buildKpiBlock(card, config) {
  const costMissing = !!card.dataQuality?.costMissing;
  return {
    version: config.kpiVersion,
    computedAt: card.generatedAt,
    cost: { usd: costMissing ? null : card.cost.totalUsd, band: "unknown", z: null },
    time: {
      wallMs: card.time.wallMs, activeMs: card.time.activeMs, humanWaitMs: card.time.humanWaitMs,
      band: "unknown", z: null,
    },
    quality: computeKpi(card, config),
  };
}

/** The three band paths card.kpi mirrors, in kpi-block order. */
const KPI_BAND_PATHS = { cost: "cost.totalUsd", time: "time.wallMs", quality: "quality.score" };

/**
 * Copy the three band verdicts into card.kpi. Defensive on purpose: a thin baseline
 * yields `{status:"insufficient"}` with no `z` key at all, and a card built before
 * the bands existed has no kpi to stamp.
 */
export function stampKpiBands(card) {
  if (!card?.kpi) return card;
  for (const [slot, path] of Object.entries(KPI_BAND_PATHS)) {
    const b = card.bands?.kpis?.[path];
    card.kpi[slot].band = b?.status ?? "unknown";
    card.kpi[slot].z = b?.z ?? null;
  }
  return card;
}

/** card.kpi or null — the one read a v4 card must survive. */
export function readKpi(card) {
  return card?.kpi ?? null;
}

// ─── CI verdict (§4) ─────────────────────────────────────────────────────────

const CI_AGENT_ID = "agentcore_hub_ci_agent";
/**
 * Deliberately narrow, and NOT a replacement for FIX_TITLE_RE: this asks the single
 * question "is this specific ticket a CI fix?", where FIX_TITLE_RE asks "is this any
 * kind of fix?" and is pinned by the shared fix-lineage fixture. Keep them apart.
 */
const CI_FIX_TITLE_RE = /^Fix \(CI\)/i;
const DONE_STATUSES = new Set(["complete", "done"]);

/**
 * Did CI pass for this run? Derived, never asserted by an agent's prose.
 *
 * `workflow.agentTasks` (the DynamoDB row's map) is the only place spawnedBy /
 * mergeCommit / outcome live; the computed `agentTasks` rows carry status and
 * completedAt. `getCompletion` is injected so this unit-tests with a plain object
 * map and no S3.
 *
 * Rules in order, first match wins — an unresolved CI fix outranks any earlier
 * "certified" record, because the certification is what the fix exists to redo.
 */
export async function deriveCiVerdict(workflow, agentTasks = [], getCompletion, gaps = []) {
  const rowTasks = (workflow && workflow.agentTasks) || {};

  // 1. A CI fix ticket still open at the terminal state = CI was red and stayed red.
  const open = Object.entries(rowTasks)
    .filter(([, t]) => t?.spawnedBy?.kind === "ci_fix" || CI_FIX_TITLE_RE.test(String(t?.title || "")))
    .filter(([, t]) => !DONE_STATUSES.has(String(t?.status || "").toLowerCase()))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (open.length) return { verdict: "fail", source: "fix-ticket:ci-open", ticketId: open[0][0] };

  // The CI agent's own ticket: latest completion wins, ticketId ascending breaks ties.
  const chosen = (agentTasks || [])
    .filter((t) => t?.agentId === CI_AGENT_ID)
    .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || ""))
      || String(a.ticketId).localeCompare(String(b.ticketId)))[0] || null;

  let record = null;
  if (chosen) {
    try {
      record = await getCompletion(chosen.ticketId);
    } catch {
      // A read failure is not evidence of anything — say so on the card instead of
      // reporting "no CI evidence" as though the ticket had been silent.
      gaps.push(`ci verdict unavailable: could not read completions/${chosen.ticketId}.json`);
    }
  }
  const status = typeof record?.ci_status === "string" ? record.ci_status.trim().toLowerCase() : "";

  // 2 & 3. The CI agent proved a build against the head.
  if (status === "certified") return { verdict: "pass", source: "completion:certified", ticketId: chosen.ticketId };
  if (status === "github-actions-proxy") return { verdict: "pass", source: "completion:github-actions-proxy", ticketId: chosen.ticketId };

  // 4. Something merged: the branch protection that let it through is the evidence.
  //    (`static-ci-only` is NOT a failure — it is a run that never claimed a build.)
  const merged = Object.values(rowTasks).some((t) =>
    (typeof t?.mergeCommit === "string" && t.mergeCommit.trim() !== "") || t?.outcome === "shipped");
  if (merged) return { verdict: "pass", source: "merge-commit", ticketId: null };

  // 5. Explicitly unverified, or nothing to go on at all.
  if (status === "unverified") return { verdict: "unknown", source: "completion:unverified", ticketId: chosen.ticketId };
  return { verdict: "unknown", source: "none", ticketId: null };
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
      score: card.quality.score ?? null,
    },
    // Enough of the score for the fleet view and the bands to work from without
    // fetching every card; the components stay on the card itself.
    kpi: card.kpi
      ? {
        version: card.kpi.version,
        quality: {
          score: card.kpi.quality?.score ?? null,
          grade: card.kpi.quality?.grade ?? null,
          confidence: card.kpi.quality?.confidence ?? null,
        },
      }
      : null,
    costMissing: !!card.dataQuality?.costMissing,
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
    // null on an insufficient-evidence run; the finite filter below drops it rather
    // than publishing a 0 that would drag the def's average down.
    ["QualityScore", card.quality.score, "None"],
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
        qualityScore: card.quality.score ?? null, qualityGrade: card.kpi?.quality?.grade ?? null,
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

// R1-F1 (TEAM-3964): on strands-agents >=1.53 model spans are named exactly
// "chat" (the model id lives in gen_ai.request.model, not the span name); the
// legacy "chat <model>" shape is retained here for older historical data. The
// explicit `name = "chat"` branch is required — `name like /^chat /` alone
// (space-terminated) never matches the exact "chat" name and silently zeroes
// persona token/cache accounting on current strands.
export const PERSONA_CHAT_SPAN_FILTER = '((name = "chat" or name like /^chat /) or `attributes.event.name` = "api_request")';

async function queryPersonaSpans(groups, workflowId, startSec, endSec) {
  // Cache read/write tokens land under either the nested (cache_read.input_tokens)
  // or flat (cache_read_input_tokens) OTEL attribute depending on emitter version;
  // hub.cache_ttl (set by the runtime, TEAM-3953) selects the write price tier.
  const q = `fields \`attributes.session.id\` as sid, \`attributes.gen_ai.usage.input_tokens\` as i, \`attributes.gen_ai.usage.output_tokens\` as o, coalesce(\`attributes.gen_ai.usage.cache_read.input_tokens\`, \`attributes.gen_ai.usage.cache_read_input_tokens\`, 0) as cr, coalesce(\`attributes.gen_ai.usage.cache_creation.input_tokens\`, \`attributes.gen_ai.usage.cache_write_input_tokens\`, 0) as cw, \`attributes.hub.cache_ttl\` as ttl, coalesce(\`attributes.gen_ai.request.model\`, "unknown") as model
| filter sid like "${workflowId}" and ${PERSONA_CHAT_SPAN_FILTER}
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

/**
 * TEAM-4121 FR-10 — what counts as a fix ticket.
 *
 * Kept deliberately identical to the Workflow Manager toolkit's predicate
 * (deploy/workflow-manager/toolkit/compute_metrics.py: FIX_TITLE / is_fix_ticket),
 * because the two numbers are shown side by side: the performance card's "Fix
 * tickets" row and the WM's `fixTickets.count` for the same run. They disagreed
 * for the same two reasons on both sides — the agents standardized on
 * "Fix (review):" / "Fix (QA):" / "Fix (ship-review r2):" / "Fix (CI):" (none of
 * which starts with "Fix:"), while a bug-fix run's own intake-planned
 * "Fix: <the feature>" ticket was counted as a rework loop. A shared fixture
 * (deploy/workflow-manager/toolkit/fixtures/fix-lineage.json) pins the agreement
 * from both languages; see index.test.mjs.
 */
export const FIX_TITLE_RE = /^(Fix \((review|QA|qa|ship-review r\d+|CI|sync-main|[^)]+)\)|Re-verify \()/i;
const INTAKE_AGENT_ID = "agentcore_hub_requirements_analyst";
const TERMINAL_TASK_EVENTS = new Set(["agent.complete", "workflow.report_completion"]);

/**
 * When intake finished planning: everything it planned was created before this
 * instant, every fix an agent filed against the pipeline after it. Falls back to
 * the first-created task completing, then to null (no exclusion — overcounting
 * by one beats dropping a real fix).
 */
export function intakeCompletedAt(events, workflow = {}) {
  let earliest = null;
  for (const e of events) {
    if (!TERMINAL_TASK_EVENTS.has(e.type) || e.detail?.agentId !== INTAKE_AGENT_ID) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts) && (earliest === null || ts < earliest)) earliest = ts;
  }
  if (earliest !== null) return earliest;
  const firstTask = Object.entries(workflow.agentTasks || {})
    .map(([ticketId, t]) => ({ ticketId, at: Date.parse(t.createdAt || "") }))
    .filter((t) => Number.isFinite(t.at))
    .sort((a, b) => a.at - b.at || a.ticketId.localeCompare(b.ticketId))[0];
  if (!firstTask) return null;
  for (const e of events) {
    if (!TERMINAL_TASK_EVENTS.has(e.type) || e.detail?.ticketId !== firstTask.ticketId) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts) && (earliest === null || ts < earliest)) earliest = ts;
  }
  return earliest;
}

/** `spawnedBy.kind` (machine-stamped, most trusted) → title shape → legacy "Fix:" minus intake's own. */
export function isFixTicket(ticket, intakeAt = null) {
  if (ticket?.spawnedBy?.kind) return true;
  const title = String(ticket?.title || "");
  if (FIX_TITLE_RE.test(title)) return true;
  if (!title.startsWith("Fix:")) return false;
  const created = Date.parse(ticket?.createdAt || "");
  return !(intakeAt !== null && Number.isFinite(created) && created < intakeAt);
}

/**
 * Fix ticket ids for a run, in creation order. Three sources, merged by id: the
 * `ticket.created` events (the only place a ticket's title appears for a run
 * whose workflow row was trimmed), workflow.agentTasks (the only place
 * `spawnedBy` and `createdAt` appear), and the computed task rows (titles
 * computeAgentTasks already resolved).
 */
export function fixTicketIds(events, agentTasks = [], workflow = {}) {
  const candidates = new Map();
  const upsert = (id, fields) => {
    if (!id) return;
    const cur = candidates.get(id) || { ticketId: id };
    for (const [k, v] of Object.entries(fields)) if (cur[k] == null && v != null) cur[k] = v;
    candidates.set(id, cur);
  };
  for (const e of events) {
    if (e.type !== "ticket.created") continue;
    const t = e.detail?.ticket || {};
    upsert(t.id || e.detail?.ticketId, {
      title: t.title, spawnedBy: t.spawnedBy, createdAt: t.createdAt || e.timestamp,
    });
  }
  for (const [id, t] of Object.entries(workflow.agentTasks || {})) {
    upsert(id, { title: t.title, spawnedBy: t.spawnedBy, createdAt: t.createdAt });
  }
  for (const t of agentTasks) upsert(t.ticketId, { title: t.title });

  const intakeAt = intakeCompletedAt(events, workflow);
  return [...candidates.values()]
    .filter((t) => isFixTicket(t, intakeAt))
    .sort((a, b) => (Date.parse(a.createdAt || "") || 0) - (Date.parse(b.createdAt || "") || 0)
      || String(a.ticketId).localeCompare(String(b.ticketId)))
    .map((t) => t.ticketId);
}

function countFixTickets(events, agentTasks, workflow) {
  return fixTicketIds(events, agentTasks, workflow).length;
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
/** "74/100 (C)", or why there is no number — never a bare 0. */
function scoreLabel(c) {
  return c.quality?.score == null
    ? "— (insufficient evidence)"
    : `${c.quality.score}/100 (${c.kpi?.quality?.grade ?? "—"})`;
}

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
    `## ✅ Quality: ${scoreLabel(c)} — ${c.quality.loops} loop${c.quality.loops === 1 ? "" : "s"}, ${c.quality.reworkRounds} rework round${c.quality.reworkRounds === 1 ? "" : "s"}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Outcome | ${c.quality.outcome} |`,
    `| Quality score | ${scoreLabel(c)}${c.kpi?.quality?.confidence ? ` · ${c.kpi.quality.confidence} evidence` : ""} |`,
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
