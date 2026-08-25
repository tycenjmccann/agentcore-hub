import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  discoverAgents,
  discoverLogGroups,
  DEFAULT_REGION,
} from "@/lib/agentcore-sdk";

// Per-region client caches
const logsClients = new Map<string, CloudWatchLogsClient>();
function getLogsClient(region: string): CloudWatchLogsClient {
  let client = logsClients.get(region);
  if (!client) {
    client = new CloudWatchLogsClient({ region });
    logsClients.set(region, client);
  }
  return client;
}

const cwClients = new Map<string, CloudWatchClient>();
function getCWClient(region: string): CloudWatchClient {
  let client = cwClients.get(region);
  if (!client) {
    client = new CloudWatchClient({ region });
    cwClients.set(region, client);
  }
  return client;
}


// Per-region metrics cache (2 minutes TTL)
const metricsCaches = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 120_000;

// Max agents to fetch detailed metrics for (avoids rate limiting)
const MAX_AGENTS_FOR_METRICS = 20;

// Process items in batches of `limit` to control concurrency
async function processInBatches<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

interface AgentMetrics {
  id: string;
  name: string;
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  avgDuration: number; // seconds
  totalDuration: number; // seconds
  invocations: number;
}

/**
 * GET /api/agentcore/metrics
 * Returns real metrics from:
 * - aws/spans log group (OTEL trace spans with gen_ai.usage.input_tokens/output_tokens)
 * - AWS/Bedrock-AgentCore CloudWatch metrics (Invocations, Latency)
 * - AgentCore Memory API (session counts)
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;

  const cached = metricsCaches.get(region);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const agents = await discoverAgents(region);

    // Fetch token usage from aws/spans and CW metrics in parallel
    const [tokensByAgent, cwMetricsByAgent, sessionCounts] = await Promise.all([
      getTokenUsageFromSpans(region),
      getCWMetricsForAgents(agents, region),
      getSessionCounts(agents, region),
    ]);

    // Build per-agent metrics
    const agentMetrics: AgentMetrics[] = agents.map((agent) => {
      // Match agent to span service name: harnesses use "harness_<name>.<endpoint>", runtimes use "<name>.<endpoint>"
      const serviceName = agent.type === "harness"
        ? `harness_${agent.name}.DEFAULT`
        : `${agent.name}.DEFAULT`;

      const tokens = tokensByAgent[serviceName] || { input: 0, output: 0, calls: 0 };
      const cw = cwMetricsByAgent[agent.id] || { invocations: 0, avgLatency: 0, totalDuration: 0 };
      const sessions = sessionCounts[agent.id] || 0;

      return {
        id: agent.id,
        name: agent.name,
        sessions,
        tokensIn: tokens.input,
        tokensOut: tokens.output,
        avgDuration: cw.avgLatency > 0 ? Math.round(cw.avgLatency / 1000) : 0, // ms -> seconds
        totalDuration: cw.totalDuration > 0 ? Math.round(cw.totalDuration / 1000) : 0,
        invocations: cw.invocations,
      };
    });

    // Aggregate totals
    const totalSessions = agentMetrics.reduce((sum, a) => sum + a.sessions, 0);
    const totalTokensIn = agentMetrics.reduce((sum, a) => sum + a.tokensIn, 0);
    const totalTokensOut = agentMetrics.reduce((sum, a) => sum + a.tokensOut, 0);
    const totalDuration = agentMetrics.reduce((sum, a) => sum + a.totalDuration, 0);
    const totalInvocations = agentMetrics.reduce((sum, a) => sum + a.invocations, 0);
    const avgSessionDuration = totalInvocations > 0 ? Math.round(totalDuration / totalInvocations) : 0;
    const activeAgents = agents.filter((a) => a.status === "ACTIVE" || a.status === "READY").length;

    const result = {
      usage: {
        totalSessions,
        totalTokensIn,
        totalTokensOut,
        avgSessionDuration,
        totalDuration,
        totalInvocations,
        activeAgents,
        totalAgents: agents.length,
      },
      agentMetrics,
    };

    metricsCaches.set(region, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Metrics error:", error);
    return NextResponse.json({ error: "Failed to fetch metrics" }, { status: 500 });
  }
}

/**
 * OTEL span destinations. Newer runtimes deliver spans to their own log group's
 * `spans` stream (unified span destination) instead of the shared aws/spans, so
 * queries must cover both. Insights caps a query at 50 log groups.
 */
async function getSpanLogGroups(region: string): Promise<string[]> {
  const runtimeGroups = await discoverLogGroups(region);
  return ["aws/spans", ...runtimeGroups].slice(0, 50);
}

/**
 * Query span log groups for per-agent token usage.
 */
async function getTokenUsageFromSpans(region: string): Promise<Record<string, { input: number; output: number; calls: number }>> {
  const empty: Record<string, { input: number; output: number; calls: number }> = {};

  try {
    const client = getLogsClient(region);
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - 30 * 24 * 60 * 60; // Last 30 days

    // Aggregate token usage server-side. Pulling raw @message blobs (limit
    // 10000) and JSON.parsing each one client-side took 80s+; a stats query
    // returns one small row per service in ~1s.
    // Two shapes carry gen_ai.usage tokens: Strands/ADOT model spans (named
    // "chat <model>") and Claude Code CLI api_request log events (coding
    // runtime — its collector normalizes input_tokens -> gen_ai.usage.* and
    // event.name arrives as "api_request", body carries the claude_code prefix).
    const query = `
      fields \`attributes.gen_ai.usage.input_tokens\` as inp, \`attributes.gen_ai.usage.output_tokens\` as outp, \`resource.attributes.service.name\` as svc
      | filter name like /^chat / or \`attributes.event.name\` = "api_request"
      | stats sum(inp) as inputTokens, sum(outp) as outputTokens, count(*) as calls by svc
    `;

    const startRes = await client.send(
      new StartQueryCommand({
        logGroupNames: await getSpanLogGroups(region),
        startTime,
        endTime,
        queryString: query,
      })
    );

    if (!startRes.queryId) return empty;

    const results = await pollQuery(client, startRes.queryId, 15);
    if (!results || results.length === 0) return empty;

    const agents: Record<string, { input: number; output: number; calls: number }> = {};

    for (const row of results) {
      const svc = row.svc;
      if (!svc) continue;
      const input = Number(row.inputTokens || 0);
      const output = Number(row.outputTokens || 0);
      const calls = Number(row.calls || 0);
      agents[svc] = { input, output, calls };
    }

    return agents;
  } catch (err) {
    console.error("Token spans query error:", err);
    return empty;
  }
}

/**
 * Get CloudWatch metrics (Invocations, Latency) from AWS/Bedrock-AgentCore namespace.
 */
async function getCWMetricsForAgents(
  agents: Array<{ id: string; name: string; type: string; arn: string }>,
  region: string
): Promise<Record<string, { invocations: number; avgLatency: number; totalDuration: number }>> {
  const result: Record<string, { invocations: number; avgLatency: number; totalDuration: number }> = {};
  const cw = getCWClient(region);
  const endTime = new Date();
  const startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

  const listRes = await cw.send(new ListMetricsCommand({
    Namespace: "AWS/Bedrock-AgentCore",
    MetricName: "Invocations",
    Dimensions: [{ Name: "Operation", Value: "InvokeAgentRuntime" }],
  }));

  const cwDimMap: Record<string, { resource: string; name: string }[]> = {};
  for (const metric of listRes.Metrics || []) {
    const dims = Object.fromEntries((metric.Dimensions || []).map((d) => [d.Name!, d.Value!]));
    if (!dims.Resource || !dims.Name) continue;

    const baseName = dims.Name.replace(/::DEFAULT$/, "");
    if (!cwDimMap[baseName]) cwDimMap[baseName] = [];
    cwDimMap[baseName].push({ resource: dims.Resource, name: dims.Name });
  }

  const promises = agents.map(async (agent) => {
    const lookupName = agent.type === "harness" ? `harness_${agent.name}` : agent.name;
    const entries = cwDimMap[lookupName] || [];

    if (entries.length === 0) {
      result[agent.id] = { invocations: 0, avgLatency: 0, totalDuration: 0 };
      return;
    }

    try {
      let totalInvocations = 0;
      let weightedLatency = 0;
      let totalDuration = 0;

      for (const entry of entries) {
        const dimensions = [
          { Name: "Resource", Value: entry.resource },
          { Name: "Operation", Value: "InvokeAgentRuntime" },
          { Name: "Name", Value: entry.name },
        ];

        const [invRes, latRes] = await Promise.all([
          cw.send(new GetMetricStatisticsCommand({
            Namespace: "AWS/Bedrock-AgentCore",
            MetricName: "Invocations",
            Dimensions: dimensions,
            StartTime: startTime, EndTime: endTime,
            Period: 30 * 24 * 60 * 60,
            Statistics: ["Sum"],
          })),
          cw.send(new GetMetricStatisticsCommand({
            Namespace: "AWS/Bedrock-AgentCore",
            MetricName: "Latency",
            Dimensions: dimensions,
            StartTime: startTime, EndTime: endTime,
            Period: 30 * 24 * 60 * 60,
            Statistics: ["Average", "Sum"],
          })),
        ]);

        const inv = invRes.Datapoints?.reduce((s, dp) => s + (dp.Sum || 0), 0) || 0;
        const avgLat = latRes.Datapoints?.[0]?.Average || 0;
        const durSum = latRes.Datapoints?.reduce((s, dp) => s + (dp.Sum || 0), 0) || 0;

        totalInvocations += inv;
        weightedLatency += avgLat * inv;
        totalDuration += durSum;
      }

      const avgLatency = totalInvocations > 0 ? weightedLatency / totalInvocations : 0;
      result[agent.id] = { invocations: totalInvocations, avgLatency, totalDuration };
    } catch {
      result[agent.id] = { invocations: 0, avgLatency: 0, totalDuration: 0 };
    }
  });

  await Promise.all(promises);
  return result;
}

/**
 * Get session counts for all agents from OTEL spans (aws/spans + per-agent
 * unified span destinations). Counts distinct session.id values per agent
 * service name.
 */
async function getSessionCounts(
  agents: Array<{ id: string; name: string; type: string }>,
  region: string
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  // Initialize all to 0
  for (const agent of agents) result[agent.id] = 0;

  try {
    const client = getLogsClient(region);
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - 30 * 24 * 60 * 60; // Last 30 days

    const query = `
      fields resource.attributes.service.name as svc, attributes.session.id as sessionId
      | filter ispresent(attributes.session.id)
      | stats count_distinct(sessionId) as sessionCount by svc
    `;

    const startRes = await client.send(
      new StartQueryCommand({
        logGroupNames: await getSpanLogGroups(region),
        startTime,
        endTime,
        queryString: query,
      })
    );

    if (!startRes.queryId) return result;

    const rows = await pollQuery(client, startRes.queryId, 15);
    if (!rows || rows.length === 0) return result;

    // Map service names back to agent IDs
    const svcToAgent = new Map<string, string>();
    for (const agent of agents) {
      const prefix = agent.type === "harness" ? "harness_" : "";
      svcToAgent.set(`${prefix}${agent.name}.DEFAULT`, agent.id);
    }

    for (const row of rows) {
      const svc = row.svc || "";
      const count = parseInt(row.sessionCount || "0", 10);
      const agentId = svcToAgent.get(svc);
      if (agentId) result[agentId] = count;
    }

    return result;
  } catch (err) {
    console.error("Session count from spans error:", err);
    return result;
  }
}

/**
 * Poll CloudWatch Logs Insights query until complete.
 */
async function pollQuery(
  client: CloudWatchLogsClient,
  queryId: string,
  maxSeconds: number
): Promise<Record<string, string>[] | null> {
  let attempts = 0;
  while (attempts < maxSeconds) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;

    const res = await client.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === "Complete" || res.status === "Failed") {
      if (!res.results || res.results.length === 0) return null;
      return res.results.map((row) => {
        const fields: Record<string, string> = {};
        for (const f of row) {
          if (f.field && f.value) fields[f.field] = f.value;
        }
        return fields;
      });
    }
  }
  return null;
}
