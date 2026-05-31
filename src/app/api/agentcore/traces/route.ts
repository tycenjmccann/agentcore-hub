import { NextRequest, NextResponse } from "next/server";
import {
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getLogsClient, DEFAULT_REGION } from "@/lib/agentcore-sdk";
import agentsConfig from "@/config/agents.json";

// In-memory cache for recently captured traces (immediate availability during streaming)
// Bounded: max 100 entries, 5-minute TTL per entry
const TRACE_CACHE_MAX = 100;
const TRACE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  traces: TraceRecord[];
  insertedAt: number;
}

const traceCache: Map<string, CacheEntry> = new Map();

function traceCacheGet(key: string): TraceRecord[] | undefined {
  const entry = traceCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.insertedAt > TRACE_CACHE_TTL_MS) {
    traceCache.delete(key);
    return undefined;
  }
  traceCache.delete(key);
  traceCache.set(key, entry);
  return entry.traces;
}

function traceCacheSet(key: string, traces: TraceRecord[]): void {
  traceCache.delete(key);
  while (traceCache.size >= TRACE_CACHE_MAX) {
    const oldest = traceCache.keys().next().value;
    if (oldest !== undefined) traceCache.delete(oldest);
    else break;
  }
  traceCache.set(key, { traces, insertedAt: Date.now() });
}

interface TraceRecord {
  id: string;
  event: string;
  name: string;
  timestamp: string;
  duration?: number; // seconds
  details?: Record<string, unknown>;
}

interface TraceDiagnostics {
  // "anchored": matched on attributes.session.id (high confidence)
  // "fallback": matched on raw @message substring only — agent isn't propagating session.id into OTEL baggage
  // "none": no matches in either mode
  matchMode: "anchored" | "fallback" | "none";
  // "complete" | "timeout" | "failed" — distinguishes "queried successfully, no data" from "query never returned"
  queryStatus: "complete" | "timeout" | "failed";
  // True when aws/spans doesn't exist — almost always means Transaction Search isn't enabled
  logGroupMissing?: boolean;
  // True when anchored returned 0 but fallback found rows — agent emitted spans without session.id attribute
  sessionIdPropagationMissing?: boolean;
}

/**
 * GET /api/agentcore/traces?session_id=xxx
 * Returns OTEL trace spans for a session from aws/spans.
 * Shows all spans — tool calls, model calls, service calls, lifecycle events.
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const sessionId = req.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json({ error: "session_id required" }, { status: 400 });
  }

  // Check in-memory cache first (real-time traces captured during streaming)
  const cached = traceCacheGet(sessionId);
  if (cached && cached.length > 0) {
    return NextResponse.json({ traces: cached, source: "realtime_cache" });
  }

  // Query OTEL spans from aws/spans (Transaction Search log group — all spans land here)
  try {
    const { traces, diagnostics } = await queryOtelSpans(sessionId, region);

    // Enrich tool spans with their actual input/output from the agent's runtime log group.
    // OTEL spans on aws/spans only carry tool metadata (name, status); the args + result
    // live in the runtime log under body.output.messages[].content as toolUse/toolResult blocks.
    if (traces.length > 0) {
      try {
        await enrichTraceTools(traces, sessionId, region);
      } catch (err) {
        console.warn("Tool enrichment failed (non-fatal):", (err as Error).message);
      }
    }

    return NextResponse.json({
      traces,
      source: traces.length > 0 ? `otel_spans:${diagnostics.matchMode}` : "empty",
      diagnostics,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("OTEL spans query error:", msg);
    // Surface known fatal errors as diagnostics rather than swallowing them
    const logGroupMissing = /ResourceNotFoundException|log group does not exist/i.test(msg);
    return NextResponse.json({
      traces: [],
      source: "error",
      diagnostics: {
        matchMode: "none",
        queryStatus: "failed",
        logGroupMissing,
      } satisfies TraceDiagnostics,
    });
  }
}

/**
 * POST /api/agentcore/traces
 * Cache real-time trace events (captured during streaming, before CW propagation).
 */
export async function POST(req: NextRequest) {
  const { session_id, traces } = await req.json();

  if (!session_id || !traces || !Array.isArray(traces)) {
    return NextResponse.json({ error: "session_id and traces[] required" }, { status: 400 });
  }

  const existing = traceCacheGet(session_id) || [];
  existing.push(...traces);
  traceCacheSet(session_id, existing);

  return NextResponse.json({ stored: true, total: existing.length });
}

/**
 * Query aws/spans OTEL log group for spans matching a session ID.
 *
 * Two-phase strategy:
 *   1. Anchored: filter on attributes.session.id (high confidence, fast — indexed field)
 *   2. Fallback: substring on @message, only if anchored returned 0 (catches agents
 *      that didn't propagate session.id into OTEL baggage — diagnostic signal)
 *
 * Requires CloudWatch Transaction Search enabled in the account.
 */
async function queryOtelSpans(
  sessionId: string,
  region: string
): Promise<{ traces: TraceRecord[]; diagnostics: TraceDiagnostics }> {
  // Phase 1: anchored query on the structured attribute
  const anchored = await runSpansQuery(sessionId, region, "anchored");
  if (anchored.traces.length > 0 || anchored.queryStatus !== "complete") {
    return {
      traces: anchored.traces,
      diagnostics: {
        matchMode: anchored.traces.length > 0 ? "anchored" : "none",
        queryStatus: anchored.queryStatus,
        logGroupMissing: anchored.logGroupMissing,
      },
    };
  }

  // Phase 2: fallback — anchored returned 0 with status=Complete; agent may not be tagging spans
  const fallback = await runSpansQuery(sessionId, region, "fallback");
  return {
    traces: fallback.traces,
    diagnostics: {
      matchMode: fallback.traces.length > 0 ? "fallback" : "none",
      queryStatus: fallback.queryStatus,
      logGroupMissing: fallback.logGroupMissing,
      sessionIdPropagationMissing: fallback.traces.length > 0,
    },
  };
}

interface SpansQueryResult {
  traces: TraceRecord[];
  queryStatus: "complete" | "timeout" | "failed";
  logGroupMissing?: boolean;
}

async function runSpansQuery(
  sessionId: string,
  region: string,
  mode: "anchored" | "fallback"
): Promise<SpansQueryResult> {
  const client = getLogsClient(region);

  const endTime = Date.now();
  const startTime = endTime - 7 * 24 * 60 * 60 * 1000; // 7 days back — keeps older sessions visible without big scan cost (anchored filter is indexed)

  // Anchored mode hits the structured field directly. Fallback is the legacy raw-message substring
  // — kept only as a safety net for agents that emit spans but don't tag session.id correctly.
  const sessionFilter =
    mode === "anchored"
      ? `| filter attributes.session.id = "${sessionId}"`
      : `| filter @message like "${sessionId}"`;

  let startRes;
  try {
    startRes = await client.send(
      new StartQueryCommand({
        logGroupName: "aws/spans",
        startTime: Math.floor(startTime / 1000),
        endTime: Math.floor(endTime / 1000),
        queryString: `fields @timestamp, name, kind, durationNano,
          attributes.session.id as sessionId,
          attributes.gen_ai.tool.name as toolName,
          attributes.gen_ai.tool.status as toolStatus,
          attributes.gen_ai.tool.description as toolDescription,
          attributes.gen_ai.tool.call.id as toolCallId,
          attributes.gen_ai.operation.name as operation,
          status.code as statusCode
        ${sessionFilter}
        | filter name not like "InternalOperation"
        | filter name != "GET" and name != "PUT" and name != "POST" and name != "DELETE"
        | filter name not like "CountTokens"
        | filter kind != "CLIENT"
        | sort @timestamp asc
        | limit 200`,
      })
    );
  } catch (err) {
    const msg = (err as Error).message;
    const logGroupMissing = /ResourceNotFoundException|log group does not exist/i.test(msg);
    return { traces: [], queryStatus: "failed", logGroupMissing };
  }

  if (!startRes.queryId) return { traces: [], queryStatus: "failed" };

  // Poll for results (max 15s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const results = await client.send(new GetQueryResultsCommand({ queryId: startRes.queryId }));

    if (results.status === "Complete" || results.status === "Cancelled" || results.status === "Failed") {
      const queryStatus = results.status === "Complete" ? "complete" : "failed";
      if (!results.results || results.results.length === 0) {
        return { traces: [], queryStatus };
      }

      const traces = results.results.map((row, idx) => {
        const fields: Record<string, string> = {};
        for (const f of row) {
          if (f.field && f.value) fields[f.field] = f.value;
        }

        const durationSec = fields.durationNano
          ? parseFloat(fields.durationNano) / 1_000_000_000
          : undefined;

        const spanName = fields.name || "span";
        const displayName = formatSpanName(spanName, fields);
        const eventType = categorizeSpan(spanName, fields);

        return {
          id: `otel_${idx}_${Date.now()}`,
          event: eventType,
          name: displayName,
          timestamp: fields["@timestamp"] || new Date().toISOString(),
          duration: durationSec,
          details: {
            spanName,
            kind: fields.kind,
            operation: fields.operation,
            statusCode: fields.statusCode,
            toolName: fields.toolName,
            toolStatus: fields.toolStatus,
            toolDescription: fields.toolDescription,
            toolCallId: fields.toolCallId,
          },
        };
      });

      return { traces, queryStatus };
    }
  }

  // Hit poll budget without seeing terminal status — query is still running on CW side
  return { traces: [], queryStatus: "timeout" };
}

/**
 * Format a span name for display. Keeps it readable without losing info.
 */
function formatSpanName(name: string, fields: Record<string, string>): string {
  // Tool execution spans
  if (fields.toolName) {
    return `Tool: ${fields.toolName}${fields.toolStatus ? ` (${fields.toolStatus})` : ""}`;
  }
  if (name.startsWith("execute_tool ")) {
    return `Tool: ${name.replace("execute_tool ", "")}`;
  }

  // Model/chat spans — show model ID cleanly
  if (name.startsWith("chat ")) {
    const model = name.replace("chat ", "");
    // Shorten model IDs like "us.anthropic.claude-sonnet-4-20250514-v1:0"
    const shortModel = model.replace(/^(us|eu|ap)\.\w+\./, "").replace(/-v\d+:\d+$/, "");
    return `Model: ${shortModel}`;
  }
  if (name === "chat") {
    return "Model call";
  }

  // Agent lifecycle
  if (name === "execute_event_loop_cycle") return "Agent event loop cycle";
  if (name.startsWith("invoke_agent")) return `Invoke: ${name.replace("invoke_agent ", "")}`;
  if (name === "POST /invocations") return "Agent invocation";

  // AWS service calls
  if (name.startsWith("Bedrock AgentCore.")) {
    return name.replace("Bedrock AgentCore.", "AgentCore: ");
  }
  if (name.startsWith("Bedrock Runtime.")) {
    return name.replace("Bedrock Runtime.", "Bedrock: ");
  }
  if (name.startsWith("DynamoDB.")) return name;
  if (name.startsWith("CloudWatch Logs.")) return name;

  return name;
}

/**
 * Categorize a span for UI badge/icon. Lightweight — just identifies the type.
 */
function categorizeSpan(name: string, fields: Record<string, string>): string {
  const n = name.toLowerCase();

  // Tool calls
  if (fields.toolName || n.startsWith("execute_tool")) return "tool_call";

  // Model/LLM calls
  if (n.startsWith("chat")) return "model_call";

  // Agent invocations
  if (n.includes("invoke_agent") || n === "post /invocations") return "request";

  // Memory/AgentCore service calls
  if (n.includes("createevent") || n.includes("retrievememory") || n.includes("listevents")) return "service_call";
  if (n.includes("agentcore")) return "service_call";

  // Bedrock runtime calls (token counting etc)
  if (n.includes("bedrock runtime")) return "service_call";

  // DynamoDB / external service calls
  if (n.startsWith("dynamodb.") || n.startsWith("cloudwatch")) return "service_call";

  // Event loop
  if (n.includes("event_loop")) return "span";

  // Errors (only if not already categorized above)
  if (fields.statusCode === "ERROR") return "error";

  // HTTP methods (internal SDK calls)
  if (n === "get" || n === "put" || n === "post" || n === "delete") return "internal";
  if (n === "internaloperation") return "internal";

  // Token counting
  if (n.includes("counttokens")) return "internal";

  return "span";
}

/**
 * Enrich tool spans with their actual input/output by reading the agent's
 * runtime log group. OTEL spans on aws/spans only carry tool metadata (name,
 * status, json_schema, call_id); the actual args + result live in the runtime
 * log under body.input.messages[].content (the gen_ai_latest_experimental
 * format), where `content` is a JSON-string that decodes to an array of
 * { role, parts: [{ type: "tool_call" | "tool_call_response", id, ... }] }.
 *
 * Mutates `traces` in place. Silent-fails on any error so the basic timeline
 * still renders.
 */
async function enrichTraceTools(
  traces: TraceRecord[],
  sessionId: string,
  region: string
): Promise<void> {
  const toolSpans = traces.filter((t) => t.details?.toolCallId);
  if (toolSpans.length === 0) return;

  // sessionId format: TEAM-<n>_wf_<id>-<agentId>-<timestamp>
  // Longest match wins so longer IDs beat shorter prefixes.
  const agents = (agentsConfig as { agents: Array<{ agentId: string }> }).agents;
  let matched: { agentId: string } | undefined;
  for (const agent of agents) {
    if (sessionId.includes(`-${agent.agentId}-`) || sessionId.includes(`_${agent.agentId}-`)) {
      if (!matched || agent.agentId.length > matched.agentId.length) matched = agent;
    }
  }
  if (!matched) return;

  const client = getLogsClient(region);

  const lgRes = await client.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: `/aws/bedrock-agentcore/runtimes/${matched.agentId}-`,
      limit: 10,
    })
  );
  const logGroup = lgRes.logGroups?.find((lg) => lg.logGroupName?.endsWith("-DEFAULT"));
  if (!logGroup?.logGroupName) return;

  const endTime = Date.now();
  const startTime = endTime - 7 * 24 * 60 * 60 * 1000; // 7d — sessions can be inspected days later

  const startRes = await client.send(
    new StartQueryCommand({
      logGroupName: logGroup.logGroupName,
      startTime: Math.floor(startTime / 1000),
      endTime: Math.floor(endTime / 1000),
      queryString: `fields @timestamp, @message
        | filter @message like "${sessionId}"
        | filter @message like "tool_call"
        | limit 1000`,
    })
  );
  if (!startRes.queryId) return;

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const results = await client.send(new GetQueryResultsCommand({ queryId: startRes.queryId }));
    if (
      results.status !== "Complete" &&
      results.status !== "Cancelled" &&
      results.status !== "Failed"
    ) {
      continue;
    }
    if (!results.results || results.results.length === 0) return;

    const toolMap: Map<string, { toolInput?: unknown; toolResult?: string }> = new Map();
    for (const row of results.results) {
      const msgField = row.find((f) => f.field === "@message");
      if (!msgField?.value) continue;
      let outer: unknown;
      try {
        outer = JSON.parse(msgField.value);
      } catch {
        continue;
      }
      // body.input.messages[] OR body.output.messages[] — both shapes appear
      const body = (outer as { body?: { input?: unknown; output?: unknown } })?.body;
      if (!body) continue;
      const messageGroups = [
        (body.input as { messages?: unknown })?.messages,
        (body.output as { messages?: unknown })?.messages,
      ].filter(Array.isArray) as unknown[][];

      for (const messages of messageGroups) {
        for (const m of messages) {
          const rawContent = (m as { content?: unknown })?.content;
          if (typeof rawContent !== "string") continue;
          let conv: unknown;
          try {
            conv = JSON.parse(rawContent);
          } catch {
            continue;
          }
          if (!Array.isArray(conv)) continue;
          for (const turn of conv) {
            const parts = (turn as { parts?: unknown })?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
              const p = part as {
                type?: string;
                id?: string;
                arguments?: unknown;
                response?: Array<{ text?: string }>;
              };
              if (!p.id) continue;
              if (p.type === "tool_call") {
                const existing = toolMap.get(p.id) ?? {};
                existing.toolInput = p.arguments;
                toolMap.set(p.id, existing);
              } else if (p.type === "tool_call_response") {
                const existing = toolMap.get(p.id) ?? {};
                if (Array.isArray(p.response)) {
                  existing.toolResult = p.response.map((r) => r.text ?? "").join("\n");
                }
                toolMap.set(p.id, existing);
              }
            }
          }
        }
      }
    }

    for (const span of toolSpans) {
      const id = span.details?.toolCallId as string | undefined;
      if (!id) continue;
      const enriched = toolMap.get(id);
      if (enriched) {
        span.details = {
          ...span.details,
          toolInput: enriched.toolInput,
          toolResult: enriched.toolResult,
        };
      }
    }
    return;
  }
}
