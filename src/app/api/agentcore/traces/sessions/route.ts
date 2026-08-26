import { NextRequest, NextResponse } from "next/server";
import {
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getLogsClient, discoverAgents, discoverLogGroups, DEFAULT_REGION } from "@/lib/agentcore-sdk";

interface SessionRecord {
  sessionId: string;
  agentName: string;
  startTime: string;
  endTime: string;
  spanCount: number;
  ticketId?: string;
}

/**
 * GET /api/agentcore/traces/sessions
 * Returns a lightweight list of recent sessions.
 * Query params:
 *   - agent_id: (optional) find and query the agent's own log group
 *   - log_group: (optional) explicit log group to query
 *   - ticket_id: (optional) filter by ticket ID in session
 *   - limit: (optional, default 50) max sessions to return
 *   - days: (optional, default 7) how far back to look
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const agentId = req.nextUrl.searchParams.get("agent_id") || "";
  const ticketId = req.nextUrl.searchParams.get("ticket_id") || "";
  const explicitLogGroup = req.nextUrl.searchParams.get("log_group") || "";
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50", 10);
  const days = parseInt(req.nextUrl.searchParams.get("days") || "7", 10);

  const client = getLogsClient(region);
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  try {
    // OTEL trace spans live in aws/spans (legacy shared destination) AND in
    // per-agent runtime log groups' `spans` stream (unified span destination,
    // default for newer runtimes) — query both.
    const logGroupNames = explicitLogGroup
      ? [explicitLogGroup]
      : ["aws/spans", ...(await discoverLogGroups(region))].slice(0, 50);

    // Build filter using structured OTEL fields (not raw JSON parsing)
    let filterClause = `| filter ispresent(attributes.session.id)`;
    if (agentId) {
      // Resolve agent name from ID. OTEL service name pattern:
      //   harness agents: "harness_{name}.DEFAULT"
      //   runtime agents: "{name}.DEFAULT"
      const agents = await discoverAgents(region);
      const agent = agents.find((a) => a.id === agentId);
      if (agent?.name) {
        const prefix = agent.type === "harness" ? "harness_" : "";
        const agentServiceName = `${prefix}${agent.name}.DEFAULT`;
        filterClause += `\n      | filter resource.attributes.service.name = "${agentServiceName}"`;
      }
    }
    if (ticketId) {
      filterClause += `\n      | filter attributes.session.id like "${ticketId}"`;
    }

    const queryString = `
      fields attributes.session.id as sessionId,
             resource.attributes.service.name as agentName,
             @timestamp
      ${filterClause}
      | stats earliest(@timestamp) as startTime,
              latest(@timestamp) as endTime,
              count(*) as spanCount
        by sessionId, agentName
      | sort startTime desc
      | limit ${limit}
    `;

    const startRes = await client.send(new StartQueryCommand({
      logGroupNames,
      startTime: Math.floor(startTime / 1000),
      endTime: Math.floor(endTime / 1000),
      queryString,
    }));

    if (!startRes.queryId) {
      return NextResponse.json({ sessions: [], error: "Failed to start query" });
    }

    // Poll for results (max 8s)
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await client.send(new GetQueryResultsCommand({ queryId: startRes.queryId }));

      if (results.status === "Complete" || results.status === "Failed" || results.status === "Cancelled") {
        if (!results.results || results.results.length === 0) {
          return NextResponse.json({ sessions: [] });
        }

        const sessions: SessionRecord[] = results.results.map((row) => {
          const fields: Record<string, string> = {};
          for (const f of row) {
            if (f.field && f.value) fields[f.field] = f.value;
          }

          const sessionId = fields.sessionId || "";
          // Extract ticket ID from session ID (pattern: PROJ-1042_sess_xxx or TICKET-123_xxx)
          const ticketMatch = sessionId.match(/^([A-Z]+-\d+)/i);

          return {
            sessionId,
            agentName: fields.agentName || "unknown",
            startTime: fields.startTime || "",
            endTime: fields.endTime || "",
            spanCount: parseInt(fields.spanCount || "0", 10),
            ticketId: ticketMatch ? ticketMatch[1] : undefined,
          };
        });

        return NextResponse.json({ sessions });
      }
    }

    return NextResponse.json({ sessions: [], error: "Query timed out" });
  } catch (err) {
    console.error("Sessions query error:", err);
    return NextResponse.json(
      { sessions: [], error: `Query failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
