import { NextRequest, NextResponse } from "next/server";
import { loadWorkflowDefs } from "@/lib/workflow/defs-loader";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

// ─── Shared Types ───────────────────────────────────────────────────────────

type Timeframe = "day" | "week" | "month" | "year";

interface FlowBucket {
  label: string;
  created: number;
  resolved: number;
  /** resolved count per workflow-type display name (for the stacked bars) */
  byType: Record<string, number>;
}

interface ThroughputRow {
  type: string;
  count: number;
  /** median end-to-end minutes per completed workflow */
  e2eMin: number;
  aiMin: number;
  humanMin: number;
}

interface ActivityItem {
  key: string;
  summary: string;
  action: "resolved" | "started" | "in_review" | "queued";
  at: string;
}

interface MetricsResult {
  ticketsResolved: number;
  ticketsCreated: number;
  ticketsInProgress: number;
  inFlightWorkflows: number;
  avgResolutionTime: number;
  /** % of completed workflows with zero human-review dwell; null = no completions in window */
  automationRate: number | null;
  throughput: number;
  timeframe: Timeframe;
  buckets: FlowBucket[];
  throughputByType: ThroughputRow[];
  activity: ActivityItem[];
}

function getTimeframeDivisor(timeframe: Timeframe): number {
  const map: Record<Timeframe, number> = { day: 1, week: 7, month: 30, year: 365 };
  return map[timeframe];
}

function getTimeframeCutoff(timeframe: Timeframe): Date {
  const now = new Date();
  const map: Record<Timeframe, number> = { day: 1, week: 7, month: 30, year: 365 };
  return new Date(now.getTime() - map[timeframe] * 86400000);
}

// ─── Time bucketing ─────────────────────────────────────────────────────────
// day → 12 two-hour buckets, week → 7 daily, month → 30 daily, year → 12 monthly.

interface BucketSpec {
  starts: number[]; // epoch ms, ascending
  labels: string[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildBuckets(timeframe: Timeframe): BucketSpec {
  const now = new Date();
  const starts: number[] = [];
  const labels: string[] = [];

  if (timeframe === "day") {
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    end.setHours(end.getHours() + 1); // include the in-progress hour
    for (let i = 11; i >= 0; i--) {
      const t = new Date(end.getTime() - (i + 1) * 2 * 3600000);
      starts.push(t.getTime());
      labels.push(`${String(t.getHours()).padStart(2, "0")}:00`);
    }
  } else if (timeframe === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      starts.push(d.getTime());
      labels.push(i === 0 ? "Today" : DAY_NAMES[d.getDay()]);
    }
  } else if (timeframe === "month") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      starts.push(d.getTime());
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      starts.push(d.getTime());
      labels.push(MONTH_NAMES[d.getMonth()]);
    }
  }
  return { starts, labels };
}

function bucketIndex(spec: BucketSpec, iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t) || t < spec.starts[0]) return -1;
  for (let i = spec.starts.length - 1; i >= 0; i--) {
    if (t >= spec.starts[i]) return i;
  }
  return -1;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Workflow-type resolution ───────────────────────────────────────────────

const OTHER_TYPE = "Other";

/** workflowId → display type name, via the workflows table + live defs. */
async function buildWorkflowTypeMap(): Promise<{
  typeOf: Map<string, string>;
  workflows: Array<{ workflowId: string; type: string; startedAt?: string; completedAt?: string; humanReviewMs?: number }>;
}> {
  const [defs, rows] = await Promise.all([
    loadWorkflowDefs().catch(() => []),
    getAllWorkflowsFromDDB().catch(() => []),
  ]);
  const defName = new Map<string, string>();
  for (const d of defs) defName.set(d.id, (d as { displayName?: string; name?: string }).displayName || d.name || d.id);

  const typeOf = new Map<string, string>();
  const workflows = rows.map((w) => {
    const type = (w.workflowDefId && defName.get(w.workflowDefId)) || OTHER_TYPE;
    typeOf.set(w.workflowId, type);
    return { workflowId: w.workflowId, type, startedAt: w.startedAt, completedAt: w.completedAt, humanReviewMs: w.humanReviewMs };
  });
  return { typeOf, workflows };
}

function wfIdFromLabels(labels: string[]): string | null {
  const l = labels.find((x) => x.startsWith("wf:"));
  return l ? l.slice(3) : null;
}

// ─── Jira Provider ──────────────────────────────────────────────────────────

const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";

function getAuthHeader(): string {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;
}

function getBaseUrl(): string {
  return `https://${JIRA_SITE_URL}`;
}

function getResolvedJql(timeframe: Timeframe): string {
  const map: Record<Timeframe, string> = { day: "-1d", week: "-7d", month: "-30d", year: "-365d" };
  return map[timeframe];
}

interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
  changelog?: { histories: Array<{ created: string; items: Array<Record<string, unknown>> }> };
}

interface JiraSearchResult {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Paginated search — pulls every matching issue (100/page). */
async function jiraFetchAll(jql: string, fields: string, opts?: { expand?: string; cap?: number }): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  const cap = opts?.cap ?? 1000;
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({ jql, fields, maxResults: "100" });
    if (opts?.expand) params.set("expand", opts.expand);
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const response = await fetch(`${getBaseUrl()}/rest/api/3/search/jql?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: getAuthHeader(), Accept: "application/json" },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Jira search failed: ${response.status} — ${errorText}`);
    }
    const data: JiraSearchResult = await response.json();
    issues.push(...(data.issues || []));
    nextPageToken = data.isLast === false && issues.length < cap ? data.nextPageToken : undefined;
  } while (nextPageToken);
  return issues;
}

/** Total ms an issue spent in "In Review", from its status changelog. Open dwell counts up to now. */
function reviewDwellMs(issue: JiraIssue): number {
  const transitions: Array<{ at: number; from?: string; to?: string }> = [];
  for (const h of issue.changelog?.histories || []) {
    for (const item of h.items || []) {
      if (item.field === "status") {
        // "toString" collides with Object.prototype in TS — index access avoids the method type
        transitions.push({
          at: new Date(h.created).getTime(),
          from: item["fromString"] as string,
          to: item["toString"] as unknown as string,
        });
      }
    }
  }
  transitions.sort((a, b) => a.at - b.at);
  let total = 0;
  let enteredAt: number | null = null;
  for (const t of transitions) {
    if (t.to === "In Review") enteredAt = t.at;
    else if (t.from === "In Review" && enteredAt !== null) {
      total += t.at - enteredAt;
      enteredAt = null;
    }
  }
  if (enteredAt !== null) total += Date.now() - enteredAt;
  return total;
}

function activityAction(statusName: string): ActivityItem["action"] {
  if (statusName === "Done") return "resolved";
  if (statusName === "In Review") return "in_review";
  if (statusName === "In Progress") return "started";
  return "queued";
}

async function getMetricsFromJira(timeframe: Timeframe): Promise<MetricsResult> {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Jira not configured — set JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  }

  const project = JIRA_PROJECT_KEY;
  const since = getResolvedJql(timeframe);
  const cutoff = getTimeframeCutoff(timeframe);
  const spec = buildBuckets(timeframe);

  // Epics are containers — their child stories are the countable work, so they
  // stay out of the flow counts entirely.
  const [resolvedIssues, createdIssues, inProgressIssues, gateIssues, activityIssues, wfMap] = await Promise.all([
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND status = Done AND resolved >= ${since}`, "resolutiondate,created,labels"),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND created >= ${since}`, "created,labels"),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND status = "In Progress"`, "labels", { cap: 300 }),
    jiraFetchAll(`project = ${project} AND labels = "human-review" AND updated >= ${since}`, "labels", { expand: "changelog", cap: 300 }),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND labels = "agentcore-hub-workflow" ORDER BY updated DESC`, "summary,status,updated", { cap: 100 }),
    buildWorkflowTypeMap(),
  ]);

  // ── Flow buckets: created + resolved per bucket, resolved stacked by type ──
  const buckets: FlowBucket[] = spec.labels.map((label) => ({ label, created: 0, resolved: 0, byType: {} }));
  for (const issue of resolvedIssues) {
    const resolved = issue.fields?.resolutiondate as string | undefined;
    if (!resolved) continue;
    const idx = bucketIndex(spec, resolved);
    if (idx < 0) continue;
    buckets[idx].resolved++;
    const wfId = wfIdFromLabels((issue.fields?.labels as string[]) || []);
    const type = (wfId && wfMap.typeOf.get(wfId)) || OTHER_TYPE;
    buckets[idx].byType[type] = (buckets[idx].byType[type] || 0) + 1;
  }
  for (const issue of createdIssues) {
    const created = issue.fields?.created as string | undefined;
    if (!created) continue;
    const idx = bucketIndex(spec, created);
    if (idx >= 0) buckets[idx].created++;
  }

  // ── Human-review dwell per workflow ──
  const humanMsByWf = new Map<string, number>();
  for (const issue of gateIssues) {
    const wfId = wfIdFromLabels((issue.fields?.labels as string[]) || []);
    if (!wfId) continue;
    humanMsByWf.set(wfId, (humanMsByWf.get(wfId) || 0) + reviewDwellMs(issue));
  }

  // ── Throughput per type: completed workflows in window ──
  const byType = new Map<string, { e2e: number[]; human: number[] }>();
  let completedCount = 0;
  let humanTouched = 0;
  for (const wf of wfMap.workflows) {
    if (!wf.completedAt || !wf.startedAt) continue;
    if (new Date(wf.completedAt) < cutoff) continue;
    const e2e = new Date(wf.completedAt).getTime() - new Date(wf.startedAt).getTime();
    if (e2e <= 0) continue;
    completedCount++;
    // Live source: "In Review" dwell mined from gate-ticket changelogs.
    // Fallback: a humanReviewMs override stored on the workflow row (backfill/seed).
    const humanMs = Math.min(Math.max(humanMsByWf.get(wf.workflowId) || 0, wf.humanReviewMs || 0), e2e);
    if (humanMs > 60000) humanTouched++;
    const entry = byType.get(wf.type) || { e2e: [], human: [] };
    entry.e2e.push(e2e);
    entry.human.push(humanMs);
    byType.set(wf.type, entry);
  }
  const throughputByType: ThroughputRow[] = [...byType.entries()]
    .map(([type, v]) => {
      const e2eMin = Math.round(median(v.e2e) / 60000);
      const humanMin = Math.round(median(v.human) / 60000);
      return { type, count: v.e2e.length, e2eMin, humanMin, aiMin: Math.max(0, e2eMin - humanMin) };
    })
    .sort((a, b) => b.count - a.count);

  const automationRate = completedCount > 0
    ? Math.round(((completedCount - humanTouched) / completedCount) * 100)
    : null;

  // ── Activity feed ──
  const activity: ActivityItem[] = activityIssues.slice(0, 12).map((issue) => {
    const fields = issue.fields || {};
    const status = (fields.status as { name?: string })?.name || "";
    return {
      key: issue.key,
      summary: (fields.summary as string) || issue.key,
      action: activityAction(status),
      at: (fields.updated as string) || new Date().toISOString(),
    };
  });

  // ── Aggregates ──
  const ticketsResolved = resolvedIssues.length;
  const ticketsCreated = createdIssues.length;
  const ticketsInProgress = inProgressIssues.length;
  const inFlightWfIds = new Set(
    inProgressIssues.map((i) => wfIdFromLabels((i.fields?.labels as string[]) || [])).filter(Boolean)
  );

  let avgResolutionTime = 0;
  if (resolvedIssues.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const issue of resolvedIssues) {
      const created = issue.fields?.created as string | undefined;
      const resolutiondate = issue.fields?.resolutiondate as string | undefined;
      if (created && resolutiondate) {
        totalMs += new Date(resolutiondate).getTime() - new Date(created).getTime();
        count++;
      }
    }
    if (count > 0) avgResolutionTime = Math.round(totalMs / count / 60000);
  }

  const throughput = Math.round((ticketsResolved / getTimeframeDivisor(timeframe)) * 10) / 10;

  return {
    ticketsResolved,
    ticketsCreated,
    ticketsInProgress,
    inFlightWorkflows: inFlightWfIds.size,
    avgResolutionTime,
    automationRate,
    throughput,
    timeframe,
    buckets,
    throughputByType,
    activity,
  };
}

// ─── DynamoDB Provider ──────────────────────────────────────────────────────

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";

function getDDB() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

interface DDBTicket {
  ticketId: string;
  status: string;
  type: string;
  parentId?: string;
  workflowId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DDBWorkflow {
  workflowId: string;
  workflowDefId?: string;
  startedAt?: string;
  completedAt?: string;
  /** Optional override: total human-review dwell for this workflow (backfilled rows). */
  humanReviewMs?: number;
}

async function scanAll<T>(table: string): Promise<T[]> {
  const ddb = getDDB();
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: lastKey }));
    for (const item of result.Items || []) {
      if ((item as { ticketId?: string }).ticketId === "__COUNTER__") continue;
      items.push(item as T);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getAllWorkflowsFromDDB(): Promise<DDBWorkflow[]> {
  return scanAll<DDBWorkflow>(WORKFLOWS_TABLE);
}

async function getMetricsFromDDB(timeframe: Timeframe): Promise<MetricsResult> {
  const [allTickets, wfMap] = await Promise.all([
    scanAll<DDBTicket>(TICKETS_TABLE),
    buildWorkflowTypeMap(),
  ]);
  const cutoff = getTimeframeCutoff(timeframe);
  const spec = buildBuckets(timeframe);

  const tasks = allTickets.filter((t) => t.type !== "epic");
  const resolved = tasks.filter((t) => t.status === "done" && t.updatedAt && new Date(t.updatedAt) >= cutoff);
  const created = tasks.filter((t) => t.createdAt && new Date(t.createdAt) >= cutoff);
  const inProgress = tasks.filter((t) => t.status === "in_progress");

  const buckets: FlowBucket[] = spec.labels.map((label) => ({ label, created: 0, resolved: 0, byType: {} }));
  for (const t of resolved) {
    const idx = bucketIndex(spec, t.updatedAt!);
    if (idx < 0) continue;
    buckets[idx].resolved++;
    const type = (t.workflowId && wfMap.typeOf.get(t.workflowId)) || OTHER_TYPE;
    buckets[idx].byType[type] = (buckets[idx].byType[type] || 0) + 1;
  }
  for (const t of created) {
    const idx = bucketIndex(spec, t.createdAt!);
    if (idx >= 0) buckets[idx].created++;
  }

  // No changelog in DDB mode → human dwell unknown; report AI-only throughput.
  const byType = new Map<string, number[]>();
  let completedCount = 0;
  for (const wf of wfMap.workflows) {
    if (!wf.completedAt || !wf.startedAt) continue;
    if (new Date(wf.completedAt) < cutoff) continue;
    const e2e = new Date(wf.completedAt).getTime() - new Date(wf.startedAt).getTime();
    if (e2e <= 0) continue;
    completedCount++;
    const arr = byType.get(wf.type) || [];
    arr.push(e2e);
    byType.set(wf.type, arr);
  }
  const throughputByType: ThroughputRow[] = [...byType.entries()]
    .map(([type, e2es]) => {
      const e2eMin = Math.round(median(e2es) / 60000);
      return { type, count: e2es.length, e2eMin, humanMin: 0, aiMin: e2eMin };
    })
    .sort((a, b) => b.count - a.count);

  const activity: ActivityItem[] = tasks
    .filter((t) => t.updatedAt)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 12)
    .map((t) => ({
      key: t.ticketId,
      summary: t.title || t.ticketId,
      action: t.status === "done" ? "resolved" : t.status === "in_review" ? "in_review" : t.status === "in_progress" ? "started" : "queued",
      at: t.updatedAt!,
    }));

  let avgResolutionTime = 0;
  const sample = resolved.slice(0, 50);
  if (sample.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const t of sample) {
      if (t.createdAt && t.updatedAt) {
        totalMs += new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime();
        count++;
      }
    }
    if (count > 0) avgResolutionTime = Math.round(totalMs / count / 60000);
  }

  return {
    ticketsResolved: resolved.length,
    ticketsCreated: created.length,
    ticketsInProgress: inProgress.length,
    inFlightWorkflows: new Set(inProgress.map((t) => t.workflowId).filter(Boolean)).size,
    avgResolutionTime,
    automationRate: completedCount > 0 ? 100 : null,
    throughput: Math.round((resolved.length / getTimeframeDivisor(timeframe)) * 10) / 10,
    timeframe,
    buckets,
    throughputByType,
    activity,
  };
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const timeframe = (req.nextUrl.searchParams.get("timeframe") || "week") as Timeframe;
  if (!["day", "week", "month", "year"].includes(timeframe)) {
    return NextResponse.json({ error: "Invalid timeframe. Use: day, week, month, year" }, { status: 400 });
  }

  try {
    let result: MetricsResult;

    if (TICKET_PROVIDER === "jira") {
      result = await getMetricsFromJira(timeframe);
    } else {
      result = await getMetricsFromDDB(timeframe);
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[jira/metrics] Error:", err);
    return NextResponse.json(
      { error: `Failed to fetch metrics: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
