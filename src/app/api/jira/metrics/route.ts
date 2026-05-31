import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

// ─── Shared Types ───────────────────────────────────────────────────────────

type Timeframe = "day" | "week" | "month" | "year";

interface MetricsResult {
  ticketsResolved: number;
  ticketsInProgress: number;
  epicsActive: number;
  storiesCompleted: number;
  storiesInProgress: number;
  avgResolutionTime: number;
  automationRate: number;
  throughput: number;
  timeframe: Timeframe;
  epicProgress: Array<{ epic: string; key: string; stories: number; done: number }>;
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

interface JiraSearchResult {
  issues: Array<Record<string, unknown>>;
  nextPageToken?: string;
  isLast?: boolean;
}

async function jiraCount(jql: string): Promise<number> {
  let count = 0;
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({ jql, fields: "status", maxResults: "100" });
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
    count += (data.issues || []).length;
    nextPageToken = data.isLast === false ? data.nextPageToken : undefined;
  } while (nextPageToken);
  return count;
}

async function jiraFetch(jql: string, fields: string, maxResults = 50): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ jql, fields, maxResults: maxResults.toString() });
  const response = await fetch(`${getBaseUrl()}/rest/api/3/search/jql?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira search failed: ${response.status} — ${errorText}`);
  }
  const data: JiraSearchResult = await response.json();
  return data.issues || [];
}

async function jiraEpicProgress(project: string): Promise<Array<{ epic: string; key: string; stories: number; done: number }>> {
  const epics = await jiraFetch(
    `project = ${project} AND issuetype = Epic AND status != Done ORDER BY updated DESC`,
    "summary",
    10
  );
  const results = await Promise.all(
    epics.map(async (epic) => {
      const key = epic.key as string;
      const fields = epic.fields as Record<string, unknown>;
      const summary = (fields?.summary as string) || key;
      const children = await jiraFetch(`project = ${project} AND parent = ${key}`, "status", 100);
      const done = children.filter((c) => {
        const cf = c.fields as Record<string, unknown>;
        const status = cf?.status as Record<string, unknown> | undefined;
        return status?.name === "Done";
      }).length;
      return { epic: summary, key, stories: children.length, done };
    })
  );
  return results.filter((r) => r.stories > 0);
}

async function getMetricsFromJira(timeframe: Timeframe): Promise<MetricsResult> {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Jira not configured — set JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  }

  const project = JIRA_PROJECT_KEY;
  const resolvedSince = getResolvedJql(timeframe);

  const [ticketsResolved, ticketsInProgress, epicsActive, storiesCompleted, storiesInProgress, resolvedIssues, epicProgress] = await Promise.all([
    jiraCount(`project = ${project} AND status = Done AND resolved >= ${resolvedSince}`),
    jiraCount(`project = ${project} AND status = "In Progress"`),
    jiraCount(`project = ${project} AND issuetype = Epic AND status != Done`),
    jiraCount(`project = ${project} AND status = Done AND labels is not EMPTY AND resolved >= ${resolvedSince}`),
    jiraCount(`project = ${project} AND status in ("In Progress", "Ready", "In Review") AND labels is not EMPTY`),
    jiraFetch(`project = ${project} AND status = Done AND resolved >= ${resolvedSince}`, "resolutiondate,created", 50),
    jiraEpicProgress(project),
  ]);

  let avgResolutionTime = 0;
  if (resolvedIssues.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const issue of resolvedIssues) {
      const fields = issue.fields as Record<string, unknown>;
      const created = fields?.created as string | undefined;
      const resolutiondate = fields?.resolutiondate as string | undefined;
      if (created && resolutiondate) {
        totalMs += new Date(resolutiondate).getTime() - new Date(created).getTime();
        count++;
      }
    }
    if (count > 0) avgResolutionTime = Math.round(totalMs / count / 60000);
  }

  const automationRate = ticketsResolved > 0
    ? Math.min(100, Math.round((storiesCompleted / ticketsResolved) * 100))
    : 0;
  const throughput = Math.round((ticketsResolved / getTimeframeDivisor(timeframe)) * 10) / 10;

  return { ticketsResolved, ticketsInProgress, epicsActive, storiesCompleted, storiesInProgress, avgResolutionTime, automationRate, throughput, timeframe, epicProgress };
}

// ─── DynamoDB Provider ──────────────────────────────────────────────────────

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";

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

async function getAllTicketsFromDDB(): Promise<DDBTicket[]> {
  const ddb = getDDB();
  const items: DDBTicket[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TICKETS_TABLE,
      ExclusiveStartKey: lastKey,
    }));
    for (const item of result.Items || []) {
      if (item.ticketId === "__COUNTER__") continue;
      items.push(item as unknown as DDBTicket);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function getMetricsFromDDB(timeframe: Timeframe): Promise<MetricsResult> {
  const allTickets = await getAllTicketsFromDDB();
  const cutoff = getTimeframeCutoff(timeframe);

  const epics = allTickets.filter((t) => t.type === "epic");
  const tasks = allTickets.filter((t) => t.type !== "epic");

  // Resolved in timeframe (status=done, updatedAt >= cutoff)
  const resolved = tasks.filter((t) => t.status === "done" && t.updatedAt && new Date(t.updatedAt) >= cutoff);
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const activeEpics = epics.filter((t) => t.status !== "done");

  // Stories = all non-epic tasks (our system doesn't label them differently)
  const storiesCompleted = resolved.length;
  const storiesInProgress = inProgress.length;

  // Avg resolution time (updatedAt - createdAt for resolved tickets)
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

  // Automation rate: all resolved are agent-driven in DDB mode (100%)
  const automationRate = resolved.length > 0 ? 100 : 0;
  const throughput = Math.round((resolved.length / getTimeframeDivisor(timeframe)) * 10) / 10;

  // Epic progress: active epics with their children
  const epicProgress = activeEpics
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 10)
    .map((epic) => {
      const children = tasks.filter((t) => t.parentId === epic.ticketId);
      const done = children.filter((t) => t.status === "done").length;
      return { epic: epic.title || epic.ticketId, key: epic.ticketId, stories: children.length, done };
    })
    .filter((e) => e.stories > 0);

  return {
    ticketsResolved: resolved.length,
    ticketsInProgress: inProgress.length,
    epicsActive: activeEpics.length,
    storiesCompleted,
    storiesInProgress,
    avgResolutionTime,
    automationRate,
    throughput,
    timeframe,
    epicProgress,
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
