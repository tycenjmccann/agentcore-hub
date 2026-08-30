import { NextRequest, NextResponse } from "next/server";
import { loadWorkflowDefs } from "@/lib/workflow/defs-loader";
import { humanWaitIntervals, unionMs, type Interval } from "@/lib/metrics/gate-dwell";
import { summarizeThroughput, type ThroughputRow } from "@/lib/metrics/throughput";

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

// ─── Workflow-type resolution ───────────────────────────────────────────────

const OTHER_TYPE = "Other";

/** workflowId → display type name, via the workflows table + live defs. */
async function buildWorkflowTypeMap(): Promise<{
  typeOf: Map<string, string>;
  defName: Map<string, string>;
  workflows: Array<{ workflowId: string; type: string; startedAt?: string; completedAt?: string; humanReviewMs?: number }>;
}> {
  const [defs, rows] = await Promise.all([
    loadWorkflowDefs().catch(() => []),
    getAllWorkflowsFromDDB().catch(() => []),
  ]);
  const defName = new Map<string, string>();
  for (const d of defs) defName.set(d.id, (d as { displayName?: string; name?: string }).displayName || d.name || d.id);

  const typeOf = new Map<string, string>();
  const workflows: Array<{ workflowId: string; type: string; startedAt?: string; completedAt?: string; humanReviewMs?: number }> = [];
  for (const w of rows) {
    const type = (w.workflowDefId && defName.get(w.workflowDefId)) || OTHER_TYPE;
    typeOf.set(w.workflowId, type);
    // Tombstoned rows (deleted from the board) keep classifying their tickets
    // but must not count as completed work in the throughput lanes.
    if (w.deleted) continue;
    workflows.push({ workflowId: w.workflowId, type, startedAt: w.startedAt, completedAt: w.completedAt, humanReviewMs: w.humanReviewMs });
  }
  return { typeOf, defName, workflows };
}

function wfIdFromLabels(labels: string[]): string | null {
  const l = labels.find((x) => x.startsWith("wf:"));
  return l ? l.slice(3) : null;
}

/**
 * Resolve a ticket's workflow type. Order:
 *   1. wf: label → workflows-table row (tombstones included)
 *   2. wfdef: label stamped at intake (survives workflow-row loss entirely)
 *   3. Bug heuristic — a Bug, or a subtask under one, is the bug-fix pipeline
 *      (covers tickets whose workflow rows were deleted before tombstoning)
 */
function typeForIssue(
  issue: JiraIssue,
  typeOf: Map<string, string>,
  defName: Map<string, string>
): string {
  const labels = (issue.fields?.labels as string[]) || [];
  const wfId = wfIdFromLabels(labels);
  const mapped = wfId ? typeOf.get(wfId) : undefined;
  if (mapped) return mapped;
  const defLabel = labels.find((l) => l.startsWith("wfdef:"));
  if (defLabel) {
    const name = defName.get(defLabel.slice(6));
    if (name) return name;
  }
  const issuetype = (issue.fields?.issuetype as { name?: string })?.name;
  const parentType = (issue.fields?.parent as { fields?: { issuetype?: { name?: string } } })
    ?.fields?.issuetype?.name;
  if (issuetype === "Bug" || parentType === "Bug") {
    return defName.get("bug-fix") || "Bug-Fix";
  }
  return OTHER_TYPE;
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
  const [resolvedIssues, createdIssues, inProgressIssues, activityIssues, wfMap] = await Promise.all([
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND status = Done AND resolved >= ${since}`, "resolutiondate,created,labels,issuetype,parent"),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND created >= ${since}`, "created,labels"),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND status = "In Progress"`, "labels", { cap: 300 }),
    jiraFetchAll(`project = ${project} AND issuetype != Epic AND labels = "agentcore-hub-workflow" ORDER BY updated DESC`, "summary,status,updated", { cap: 100 }),
    buildWorkflowTypeMap(),
  ]);

  // Gate tickets need their own window: dwell belongs to workflows that
  // COMPLETED in the window, whose gates may have closed before it started —
  // so anchor the gate query at the earliest such workflow's start. Also fetch
  // gates still open regardless of last update: a gate untouched for a week is
  // exactly the dwell we must not miss.
  const inWindowStarts = wfMap.workflows
    .filter((w) => w.completedAt && w.startedAt && new Date(w.completedAt) >= cutoff)
    .map((w) => new Date(w.startedAt!).getTime())
    .filter((t) => !Number.isNaN(t));
  const gateSince = new Date(Math.min(cutoff.getTime(), ...inWindowStarts)).toISOString().slice(0, 10);
  const gateIssues = await jiraFetchAll(
    `project = ${project} AND labels = "human-review" AND (updated >= "${gateSince}" OR statusCategory != Done)`,
    "labels",
    { expand: "changelog", cap: 300 }
  );

  // ── Flow buckets: created + resolved per bucket, resolved stacked by type ──
  // The JQL `-7d` window is a rolling superset of the midnight-aligned buckets;
  // everything is counted through bucketIndex so the KPIs, the stacked bars,
  // and the created-vs-resolved chart all agree on one window.
  const buckets: FlowBucket[] = spec.labels.map((label) => ({ label, created: 0, resolved: 0, byType: {} }));
  for (const issue of resolvedIssues) {
    const resolved = issue.fields?.resolutiondate as string | undefined;
    if (!resolved) continue;
    const idx = bucketIndex(spec, resolved);
    if (idx < 0) continue;
    buckets[idx].resolved++;
    const type = typeForIssue(issue, wfMap.typeOf, wfMap.defName);
    buckets[idx].byType[type] = (buckets[idx].byType[type] || 0) + 1;
  }
  for (const issue of createdIssues) {
    const created = issue.fields?.created as string | undefined;
    if (!created) continue;
    const idx = bucketIndex(spec, created);
    if (idx >= 0) buckets[idx].created++;
  }

  // ── Human-review dwell per workflow (In Review + Blocked; see gate-dwell.ts) ──
  // Kept as raw intervals: a workflow can have several gate tickets parked at
  // once (round-N queued while round N-1 is still open) — that overlap is one
  // human wait, not two, so per-workflow dwell is a UNION, clipped below to
  // the workflow's own start→completion window.
  const nowMs = Date.now();
  const intervalsByWf = new Map<string, Interval[]>();
  for (const issue of gateIssues) {
    const wfId = wfIdFromLabels((issue.fields?.labels as string[]) || []);
    if (!wfId) continue;
    const list = intervalsByWf.get(wfId) || [];
    list.push(...humanWaitIntervals(issue.changelog, nowMs));
    intervalsByWf.set(wfId, list);
  }

  // ── Throughput per type: completed workflows in window ──
  let humanTouched = 0;
  const durations = [];
  for (const wf of wfMap.workflows) {
    if (!wf.completedAt || !wf.startedAt) continue;
    if (new Date(wf.completedAt) < cutoff) continue;
    const startMs = new Date(wf.startedAt).getTime();
    const endMs = new Date(wf.completedAt).getTime();
    const e2eMs = endMs - startMs;
    if (e2eMs <= 0) continue;
    // Live source: gate-ticket dwell, clipped to the workflow window (a gate
    // left open past completion must not keep accruing against this run).
    // Fallback: a humanReviewMs override stored on the workflow row (backfill/seed).
    const gateMs = unionMs(
      (intervalsByWf.get(wf.workflowId) || [])
        .map((iv) => ({ start: Math.max(iv.start, startMs), end: Math.min(iv.end, endMs) }))
        .filter((iv) => iv.end > iv.start)
    );
    const humanMs = Math.min(Math.max(gateMs, wf.humanReviewMs || 0), e2eMs);
    if (humanMs > 60000) humanTouched++;
    durations.push({ type: wf.type, e2eMs, humanMs });
  }
  const throughputByType = summarizeThroughput(durations);

  const automationRate = durations.length > 0
    ? Math.round(((durations.length - humanTouched) / durations.length) * 100)
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
  // Counted from the buckets (not the raw JQL result) so the KPI numbers, the
  // backlog gap, and the created-vs-resolved chart can never disagree.
  const ticketsResolved = buckets.reduce((s, b) => s + b.resolved, 0);
  const ticketsCreated = buckets.reduce((s, b) => s + b.created, 0);
  const ticketsInProgress = inProgressIssues.length;
  const inFlightWfIds = new Set(
    inProgressIssues.map((i) => wfIdFromLabels((i.fields?.labels as string[]) || [])).filter(Boolean)
  );

  // Average over the same bucketed population the resolved KPI counts.
  let avgResolutionTime = 0;
  {
    let totalMs = 0;
    let count = 0;
    for (const issue of resolvedIssues) {
      const created = issue.fields?.created as string | undefined;
      const resolutiondate = issue.fields?.resolutiondate as string | undefined;
      if (!created || !resolutiondate || bucketIndex(spec, resolutiondate) < 0) continue;
      totalMs += new Date(resolutiondate).getTime() - new Date(created).getTime();
      count++;
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
  /** Tombstone flag — row was "deleted" from the board but kept for ticket-type mapping. */
  deleted?: boolean;
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
  // Keep KPI counts and the chart on the same bucket window (see Jira provider).
  const resolvedCount = buckets.reduce((s, b) => s + b.resolved, 0);
  const createdCount = buckets.reduce((s, b) => s + b.created, 0);

  // No changelog in DDB mode → human dwell unknown beyond a stored override.
  const durations = [];
  for (const wf of wfMap.workflows) {
    if (!wf.completedAt || !wf.startedAt) continue;
    if (new Date(wf.completedAt) < cutoff) continue;
    const e2eMs = new Date(wf.completedAt).getTime() - new Date(wf.startedAt).getTime();
    if (e2eMs <= 0) continue;
    durations.push({ type: wf.type, e2eMs, humanMs: wf.humanReviewMs || 0 });
  }
  const throughputByType = summarizeThroughput(durations);

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

  // Average over the same bucketed population the resolved KPI counts.
  let avgResolutionTime = 0;
  const sample = resolved.filter((t) => bucketIndex(spec, t.updatedAt!) >= 0).slice(0, 50);
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
    ticketsResolved: resolvedCount,
    ticketsCreated: createdCount,
    ticketsInProgress: inProgress.length,
    inFlightWorkflows: new Set(inProgress.map((t) => t.workflowId).filter(Boolean)).size,
    avgResolutionTime,
    automationRate: durations.length > 0
      ? Math.round(((durations.length - durations.filter((d) => d.humanMs > 60000).length) / durations.length) * 100)
      : null,
    throughput: Math.round((resolvedCount / getTimeframeDivisor(timeframe)) * 10) / 10,
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
