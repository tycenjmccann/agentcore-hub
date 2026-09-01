/**
 * Cost Report Lambda — deterministic per-workflow-run cost + execution report.
 * No LLM anywhere: DynamoDB reads, CloudWatch Logs Insights queries, and
 * arithmetic. Complements (does not replace) the Workflow Manager's narrative
 * ANALYZE — this is the numbers-only artifact every run gets.
 *
 * Trigger shapes:
 *   1. EventBridge {source: "agentcore-hub.orchestrator", detail-type:
 *      "workflow.complete"} → report (auto, idempotent per completedAt)
 *   2. Direct invoke {workflowId} → report (re-run/backfill, always overwrites)
 *
 * Cost sources, joined per run:
 *   • Persona LLM spans — session.id convention "{ticketId}_{workflowId}-{agentId}-{ts}"
 *     carries gen_ai.usage.* per model (aws/spans + per-runtime span groups).
 *   • Claude Code CLI — api_request OTEL events on the coding runtime's log
 *     group, session.id = the fleet's cc-* coding session, mapped to
 *     workflow/agent via the cloud-code sessions table.
 *   • Codex — no OTEL; the runtime logs a structured "coding_usage" record per
 *     turn (parsed from codex's turn.completed JSONL) with coding_session_id.
 *   • Kiro — credits-only billing; same coding_usage records carry credits
 *     (converted via pricing.kiro.usdPerCredit).
 *
 * Output: s3://{ARTIFACT_BUCKET}/workflows/{wfId}/shared/cost-report.json + .md
 * (surfaced automatically by the artifact viewer) + a workflow.cost_report
 * event row for dashboards.
 *
 * Env: ARTIFACT_BUCKET (required), WORKFLOWS_TABLE, EVENTS_TABLE,
 *      CLOUD_CODE_TABLE, CODING_RUNTIME_LOG_GROUP, SPAN_LOG_GROUPS (csv),
 *      PRICING_S3_KEY (default config/pricing.json).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const CLOUD_CODE_TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";
const CODING_LOG_GROUP = process.env.CODING_RUNTIME_LOG_GROUP || "";
const PRICING_S3_KEY = process.env.PRICING_S3_KEY || "config/pricing.json";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const logs = new CloudWatchLogsClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event) => {
  const isEventBridge = event?.source === "agentcore-hub.orchestrator";
  const workflowId = isEventBridge ? event?.detail?.workflowId : event?.workflowId;
  if (!workflowId) throw new Error(`No workflowId in event: ${JSON.stringify(event).slice(0, 300)}`);
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET not set");

  const workflow = (await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE, Key: { workflowId },
  }))).Item;
  if (!workflow) {
    console.warn(`[cost-report] workflow ${workflowId} not found — skipping`);
    return { skipped: "not-found" };
  }

  // Idempotence for the EventBridge path (at-least-once delivery): skip if a
  // report for this completion already exists. Direct invokes always re-run.
  const reportKey = `workflows/${workflowId}/shared/cost-report.json`;
  if (isEventBridge) {
    const existing = await getJson(ARTIFACT_BUCKET, reportKey).catch(() => null);
    if (existing?.run?.completedAt && existing.run.completedAt === workflow.completedAt) {
      return { skipped: "already-reported" };
    }
  }

  const pricing = await getJson(ARTIFACT_BUCKET, PRICING_S3_KEY).catch(() => null)
    || { models: {}, default: { input: 15, output: 75 }, cachedInputDiscount: 0.1, kiro: { usdPerCredit: 0 } };

  const report = await buildReport(workflowId, workflow, pricing);

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET, Key: reportKey,
    Body: JSON.stringify(report, null, 2), ContentType: "application/json",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET, Key: `workflows/${workflowId}/shared/cost-report.md`,
    Body: renderMarkdown(report), ContentType: "text/markdown",
  }));

  // Dashboard-pollable summary row (events table, same shape publishEvent uses).
  const timestamp = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: {
      workflowId,
      eventId: `evt_${Date.now()}_costreport`,
      type: "workflow.cost_report",
      timestamp,
      detail: {
        ticketId: workflow.epicId, timestamp,
        totalCostUsd: report.cost.totalUsd,
        tokens: report.cost.totals,
        durationMs: report.run.totalDurationMs,
        reportKey,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    },
  }));

  console.log(`[cost-report] ${workflowId} → $${report.cost.totalUsd} (${reportKey})`);
  return { workflowId, reportKey, totalCostUsd: report.cost.totalUsd };
};

// ─── Report assembly ──────────────────────────────────────────────────────────

async function buildReport(workflowId, workflow, pricing) {
  const gaps = [];
  const events = await fetchEvents(workflowId);
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
  // personaUsage sid = "{ticketId}_{workflowId}-{agentId}-{ts}"
  const byAgent = {}; // agentId -> { engines: { persona|claude|codex|kiro: {models, tokens, credits, usd} } }
  const agentOf = (sid) => {
    const tail = sid.split(`_${workflowId}-`)[1] || "";
    return tail.replace(/-\d+$/, "") || "unknown";
  };
  for (const row of personaUsage) {
    addUsage(byAgent, agentOf(row.sid), "persona", row, pricing);
  }
  const sessionAgent = new Map(codingSessions.map((s) => [s.sessionId, s.agentId || "unknown"]));
  for (const row of ccUsage) {
    addUsage(byAgent, sessionAgent.get(row.sid) || "unknown", "claude_code", row, pricing);
  }
  for (const row of codingUsage) {
    const engine = row.cli === "kiro" ? "kiro" : "codex";
    addUsage(byAgent, sessionAgent.get(row.sid) || "unknown", engine, row, pricing);
  }

  if (!personaUsage.length) gaps.push("no persona spans matched this run's session ids — persona LLM cost missing");
  if (codingSessions.length && !ccUsage.length && !codingUsage.length) {
    gaps.push(`${codingSessions.length} coding session(s) recorded but no usage telemetry found (pre-usage-patch run?)`);
  }
  if (!codingSessions.length) gaps.push("no coding sessions recorded for this run");

  // ── Execution metrics (deterministic, ported from compute_metrics.py) ──
  const phases = computePhases(events, ended, gaps);
  const agentTasks = computeAgentTasks(workflow, events);
  const humanWait = computeHumanWait(events, ended);
  const fixTickets = agentTasks.filter((t) => (t.title || "").startsWith("Fix:")).length;

  // ── Roll up cost ──
  const engines = {};
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, kiroCredits: 0 };
  let totalUsd = 0;
  for (const [agentId, rec] of Object.entries(byAgent)) {
    for (const [engine, u] of Object.entries(rec.engines)) {
      const e = (engines[engine] ||= { usd: 0, inputTokens: 0, outputTokens: 0, kiroCredits: 0, byModel: {} });
      e.usd += u.usd; e.inputTokens += u.inputTokens; e.outputTokens += u.outputTokens;
      e.kiroCredits += u.kiroCredits;
      for (const [m, mv] of Object.entries(u.byModel)) {
        const em = (e.byModel[m] ||= { inputTokens: 0, outputTokens: 0, usd: 0 });
        em.inputTokens += mv.inputTokens; em.outputTokens += mv.outputTokens; em.usd += mv.usd;
      }
      totals.inputTokens += u.inputTokens; totals.outputTokens += u.outputTokens;
      totals.cachedInputTokens += u.cachedInputTokens; totals.kiroCredits += u.kiroCredits;
      totalUsd += u.usd;
    }
    rec.totalUsd = round4(Object.values(rec.engines).reduce((s, u) => s + u.usd, 0));
  }
  for (const e of Object.values(engines)) {
    e.usd = round4(e.usd);
    for (const m of Object.values(e.byModel)) m.usd = round4(m.usd);
  }
  if (totals.kiroCredits > 0 && !(pricing.kiro?.usdPerCredit > 0)) {
    gaps.push("kiro credits present but pricing.kiro.usdPerCredit is 0 — kiro USD reported as 0");
  }

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    workflowId,
    epicId: workflow.epicId,
    workflowDefId: workflow.workflowDefId || workflow.defId,
    run: {
      phase: workflow.phase,
      startedAt: workflow.startedAt,
      completedAt: workflow.completedAt || workflow.cancelledAt || null,
      totalDurationMs: started ? ended - started : null,
      humanWaitMs: humanWait,
      activeDurationMs: started ? Math.max(0, ended - started - humanWait) : null,
      phases,
      nudges: events.filter((e) => e.type === "workflow.nudge" || e.type === "nudge").length,
      errors: events.filter((e) => e.type === "agent.error" || e.type === "error").length,
      changeRequests: events.filter((e) => e.type === "review.rejected").length,
      fixTickets,
      prUrl: workflow.prUrl || lastDetail(events, "workflow.complete")?.prUrl || null,
    },
    cost: {
      totalUsd: round4(totalUsd),
      totals,
      byEngine: engines,
      byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, {
        totalUsd: v.totalUsd,
        engines: Object.fromEntries(Object.entries(v.engines).map(([ek, ev]) => [ek, {
          usd: round4(ev.usd), inputTokens: ev.inputTokens, outputTokens: ev.outputTokens,
          ...(ev.kiroCredits ? { kiroCredits: round4(ev.kiroCredits) } : {}),
          byModel: Object.fromEntries(Object.entries(ev.byModel).map(([mk, mv]) => [mk, { ...mv, usd: round4(mv.usd) }])),
        }])),
      }])),
    },
    agentTasks,
    codingSessions: codingSessions.map((s) => ({ sessionId: s.sessionId, cli: s.cli, agentId: s.agentId })),
    dataQuality: { gaps, pricingSource: PRICING_S3_KEY },
  };
}

function addUsage(byAgent, agentId, engine, row, pricing) {
  const rec = (byAgent[agentId] ||= { engines: {} });
  const u = (rec.engines[engine] ||= {
    usd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, kiroCredits: 0, byModel: {},
  });
  const inp = Number(row.inp || 0), outp = Number(row.outp || 0);
  const cached = Number(row.cached || 0), credits = Number(row.credits || 0);
  const model = row.model || "unknown";
  u.inputTokens += inp; u.outputTokens += outp; u.cachedInputTokens += cached;
  u.kiroCredits += credits;
  let usd;
  if (credits > 0) {
    usd = credits * (pricing.kiro?.usdPerCredit || 0);
  } else {
    const p = pricing.models[model] || pricing.default;
    const discount = pricing.cachedInputDiscount ?? 0.1;
    usd = (inp / 1e6) * p.input + (outp / 1e6) * p.output + (cached / 1e6) * p.input * discount;
  }
  u.usd += usd;
  const m = (u.byModel[model] ||= { inputTokens: 0, outputTokens: 0, usd: 0 });
  m.inputTokens += inp; m.outputTokens += outp; m.usd += usd;
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

async function getJson(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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

async function fetchCodingSessions(workflowId) {
  // Sessions table is small (GC'd); scan with a filter is fine and avoids a GSI.
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

async function resolveSpanLogGroups() {
  // PR #90: newer runtimes write spans to their own log group, older to
  // aws/spans. Cover both. Runtime span groups follow /aws/bedrock-agentcore/
  // runtimes/* — Insights accepts up to 50 groups per query.
  const groups = ["aws/spans"];
  try {
    let token;
    do {
      const page = await logs.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: "/aws/bedrock-agentcore/runtimes/",
        nextToken: token,
      }));
      for (const g of page.logGroups || []) groups.push(g.logGroupName);
      token = page.nextToken;
    } while (token);
  } catch (e) {
    console.warn("[cost-report] describe-log-groups failed:", e.message);
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
    if (["Failed", "Cancelled", "Timeout"].includes(res.status)) {
      throw new Error(`Insights query ${res.status}`);
    }
  }
  throw new Error("Insights query did not complete in 120s");
}

async function queryPersonaSpans(groups, workflowId, startSec, endSec) {
  // Strands model spans: name "chat <model>", session.id carries the wf id.
  const q = `fields \`attributes.session.id\` as sid, \`attributes.gen_ai.usage.input_tokens\` as i, \`attributes.gen_ai.usage.output_tokens\` as o, coalesce(\`attributes.gen_ai.request.model\`, "unknown") as model
| filter sid like "${workflowId}" and (name like /^chat / or \`attributes.event.name\` = "api_request")
| stats sum(i) as inp, sum(o) as outp by sid, model`;
  return runInsights(groups, q, startSec, endSec).catch((e) => {
    console.warn("[cost-report] persona span query failed:", e.message);
    return [];
  });
}

async function queryClaudeCodeSpans(groups, codingSessions, startSec, endSec) {
  const ids = codingSessions.map((s) => s.sessionId).filter(Boolean);
  if (!ids.length) return [];
  const idList = ids.map((x) => `"${x}"`).join(",");
  const q = `fields \`attributes.session.id\` as sid, \`attributes.gen_ai.usage.input_tokens\` as i, \`attributes.gen_ai.usage.output_tokens\` as o, coalesce(\`attributes.gen_ai.request.model\`, "unknown") as model
| filter sid in [${idList}] and \`attributes.event.name\` = "api_request"
| stats sum(i) as inp, sum(o) as outp by sid, model`;
  return runInsights(groups, q, startSec, endSec).catch((e) => {
    console.warn("[cost-report] claude-code span query failed:", e.message);
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
| stats sum(input_tokens) as inp, sum(output_tokens) as outp, sum(cached_input_tokens) as cached, sum(credits) as credits by sid, cli, model`;
  return runInsights([CODING_LOG_GROUP], q, startSec, endSec).catch((e) => {
    console.warn("[cost-report] coding_usage query failed:", e.message);
    return [];
  });
}

// ─── Execution metrics (ported from workflow-manager/toolkit/compute_metrics.py) ──

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
    return {
      phase: e.detail?.phase,
      enteredAt: e.timestamp,
      durationMs: Math.max(0, exited - entered),
    };
  });
}

function computeAgentTasks(workflow, events) {
  const tasks = [];
  for (const [ticketId, t] of Object.entries(workflow.agentTasks || {})) {
    const invokes = events.filter((e) =>
      (e.type === "agent.invoked" || e.type === "agent.started") &&
      (e.detail?.ticketId === ticketId));
    tasks.push({
      ticketId,
      agentId: t.agentId,
      status: t.status,
      startedAt: t.startedAt || null,
      completedAt: t.completedAt || null,
      durationMs: t.startedAt && t.completedAt
        ? Math.max(0, Date.parse(t.completedAt) - Date.parse(t.startedAt)) : null,
      reworkCount: Math.max(0, invokes.filter((e) => e.type === "agent.invoked").length - 1),
      prUrl: t.prUrl || null,
    });
  }
  return tasks;
}

function computeHumanWait(events, endedMs) {
  // Union of review.needed → (review.approved|review.rejected|end) intervals.
  // Union, not sum: gates overlap (parallel reviews, re-pings) and a summed
  // wait can exceed wall-clock, which reads as nonsense on the report.
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

function round4(n) { return Math.round(n * 10000) / 10000; }
function usd(n) { return `$${(n ?? 0).toFixed(n >= 1 ? 2 : 4)}`; }
function dur(ms) {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function renderMarkdown(r) {
  const lines = [
    `# Cost Report — ${r.workflowId}`,
    ``,
    `Epic **${r.epicId || "—"}** · generated ${r.generatedAt} · deterministic (no LLM)`,
    ``,
    `## Total: ${usd(r.cost.totalUsd)}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Wall-clock | ${dur(r.run.totalDurationMs)} |`,
    `| Human wait | ${dur(r.run.humanWaitMs)} |`,
    `| Active (wall − human) | ${dur(r.run.activeDurationMs)} |`,
    `| Tokens in / out | ${r.cost.totals.inputTokens.toLocaleString()} / ${r.cost.totals.outputTokens.toLocaleString()} |`,
    ...(r.cost.totals.kiroCredits ? [`| Kiro credits | ${r.cost.totals.kiroCredits} |`] : []),
    `| Change requests | ${r.run.changeRequests} |`,
    `| Fix tickets | ${r.run.fixTickets} |`,
    `| Errors / nudges | ${r.run.errors} / ${r.run.nudges} |`,
    ...(r.run.prUrl ? [`| PR | ${r.run.prUrl} |`] : []),
    ``,
    `## By engine`,
    ``,
    `| Engine | Cost | Tokens in | Tokens out | Credits |`,
    `|---|---|---|---|---|`,
    ...Object.entries(r.cost.byEngine).map(([k, v]) =>
      `| ${k} | ${usd(v.usd)} | ${v.inputTokens.toLocaleString()} | ${v.outputTokens.toLocaleString()} | ${v.kiroCredits || "—"} |`),
    ``,
    `## By agent`,
    ``,
    `| Agent | Cost | Engines |`,
    `|---|---|---|`,
    ...Object.entries(r.cost.byAgent)
      .sort((a, b) => b[1].totalUsd - a[1].totalUsd)
      .map(([k, v]) => `| ${k} | ${usd(v.totalUsd)} | ${Object.keys(v.engines).join(", ")} |`),
    ``,
    `## Phases`,
    ``,
    `| Phase | Duration |`,
    `|---|---|`,
    ...r.run.phases.map((p) => `| ${p.phase || "?"} | ${dur(p.durationMs)} |`),
    ``,
  ];
  if (r.dataQuality.gaps.length) {
    lines.push(`## Data gaps`, ``, ...r.dataQuality.gaps.map((g) => `- ${g}`), ``);
  }
  return lines.join("\n");
}
