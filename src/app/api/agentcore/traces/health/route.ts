import { NextRequest, NextResponse } from "next/server";
import {
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getLogsClient, discoverLogGroups, DEFAULT_REGION } from "@/lib/agentcore-sdk";

/**
 * Account/region-wide health of the OTEL trace pipeline.
 * Answers: "is this account set up to produce traces at all?" — distinct from per-session diagnostics.
 *
 * Cached for 10 minutes per region: results don't change session-to-session, and we don't
 * want to slam DescribeLogGroups / StartQuery on every page load.
 */

export interface TraceHealthIssue {
  severity: "warning" | "error";
  code:
    | "transaction_search_disabled"
    | "no_recent_spans"
    | "query_failed";
  title: string;
  body: string;
  // Optional deep-link to AWS docs / console for the customer to act on
  actionUrl?: string;
  actionLabel?: string;
}

export interface TraceHealth {
  region: string;
  checkedAt: string;
  // True when the pipeline looks fully functional (log group exists + recent span activity)
  healthy: boolean;
  transactionSearchEnabled: boolean;
  recentSpanCount: number | null; // null if we couldn't query
  recentWindowMinutes: number;
  lastSpanTimestamp: string | null;
  issues: TraceHealthIssue[];
}

interface HealthCacheEntry {
  data: TraceHealth;
  expiresAt: number;
}

const HEALTH_CACHE_TTL_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MINUTES = 60;
const healthCache = new Map<string, HealthCacheEntry>();

export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  if (!force) {
    const cached = healthCache.get(region);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ ...cached.data, cached: true });
    }
  }

  const health = await computeTraceHealth(region);
  healthCache.set(region, { data: health, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS });
  return NextResponse.json({ ...health, cached: false });
}

async function computeTraceHealth(region: string): Promise<TraceHealth> {
  const checkedAt = new Date().toISOString();
  const issues: TraceHealthIssue[] = [];
  const client = getLogsClient(region);

  // Check 1: Does aws/spans log group exist? If not, Transaction Search isn't enabled.
  let transactionSearchEnabled = false;
  try {
    const res = await client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: "aws/spans", limit: 1 })
    );
    transactionSearchEnabled = !!res.logGroups?.some((g) => g.logGroupName === "aws/spans");
  } catch (err) {
    // DescribeLogGroups should rarely fail unless IAM is misconfigured; treat as unknown
    console.error("Trace health: DescribeLogGroups failed:", (err as Error).message);
  }

  if (!transactionSearchEnabled) {
    issues.push({
      severity: "error",
      code: "transaction_search_disabled",
      title: "CloudWatch Transaction Search not enabled",
      body:
        "The aws/spans log group doesn't exist in this region. AgentCore traces won't be visible until you enable Transaction Search (one-time per account, ~10 min to propagate).",
      actionUrl:
        "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html",
      actionLabel: "How to enable",
    });

    return {
      region,
      checkedAt,
      healthy: false,
      transactionSearchEnabled: false,
      recentSpanCount: null,
      recentWindowMinutes: RECENT_WINDOW_MINUTES,
      lastSpanTimestamp: null,
      issues,
    };
  }

  // Check 2: Are spans actually being written? A successful enable but zero activity often means
  // sampling at 0%, agents not instrumented with ADOT, or freshly-enabled and still propagating.
  const recent = await queryRecentSpans(region);

  if (recent.status === "failed") {
    issues.push({
      severity: "warning",
      code: "query_failed",
      title: "Couldn't check recent span activity",
      body:
        "CloudWatch Logs Insights returned an error. Verify the IAM role has logs:StartQuery and logs:GetQueryResults on aws/spans.",
    });
  } else if (recent.count === 0) {
    issues.push({
      severity: "warning",
      code: "no_recent_spans",
      title: "No spans received in the last hour",
      body:
        "Transaction Search is enabled but aws/spans is empty for this window. Common causes: sampling rate set too low (default is 1% — bump via UpdateIndexingRule), agents not instrumented with aws-opentelemetry-distro, or Transaction Search just enabled and still propagating (~10 min).",
      actionUrl:
        "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html",
      actionLabel: "Sampling docs",
    });
  }

  const healthy = transactionSearchEnabled && recent.status !== "failed" && recent.count > 0;

  return {
    region,
    checkedAt,
    healthy,
    transactionSearchEnabled,
    recentSpanCount: recent.status === "failed" ? null : recent.count,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    lastSpanTimestamp: recent.lastTimestamp,
    issues,
  };
}

interface RecentSpansResult {
  status: "complete" | "failed";
  count: number;
  lastTimestamp: string | null;
}

async function queryRecentSpans(region: string): Promise<RecentSpansResult> {
  const client = getLogsClient(region);
  const endTime = Date.now();
  const startTime = endTime - RECENT_WINDOW_MINUTES * 60 * 1000;

  // stats count() returns one row with the total. Cheap query — no fields, no filter, tiny window.
  let queryId: string | undefined;
  try {
    // Spans land in aws/spans (legacy shared destination) or per-agent runtime
    // log groups (unified span destination) — count activity across both.
    const spanGroups = ["aws/spans", ...(await discoverLogGroups(region))].slice(0, 50);
    const startRes = await client.send(
      new StartQueryCommand({
        logGroupNames: spanGroups,
        startTime: Math.floor(startTime / 1000),
        endTime: Math.floor(endTime / 1000),
        queryString: `fields @timestamp | filter ispresent(spanId) | stats count() as total, latest(@timestamp) as lastTs`,
      })
    );
    queryId = startRes.queryId;
  } catch (err) {
    console.error("Trace health: StartQuery failed:", (err as Error).message);
    return { status: "failed", count: 0, lastTimestamp: null };
  }

  if (!queryId) return { status: "failed", count: 0, lastTimestamp: null };

  // Poll up to 5s — this is a small stats query, should be fast
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await client.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === "Complete" || res.status === "Failed" || res.status === "Cancelled") {
      if (res.status !== "Complete") return { status: "failed", count: 0, lastTimestamp: null };
      const row = res.results?.[0];
      if (!row) return { status: "complete", count: 0, lastTimestamp: null };
      const fields: Record<string, string> = {};
      for (const f of row) {
        if (f.field && f.value) fields[f.field] = f.value;
      }
      const count = parseInt(fields.total || "0", 10) || 0;
      return { status: "complete", count, lastTimestamp: fields.lastTs || null };
    }
  }
  // Treat poll exhaustion as "complete with no data" — the pipeline is alive enough to query against,
  // we just couldn't confirm activity. Don't flag this as failed; the per-session diagnostics will catch real issues.
  return { status: "complete", count: 0, lastTimestamp: null };
}
