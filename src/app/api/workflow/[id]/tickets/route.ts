import { NextRequest, NextResponse } from "next/server";
import { getWorkflowFromDynamo, getTicketsForWorkflowFromDynamo, getTicketsByIds } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Workflow metadata always lives in DDB (agentcore-hub-workflows table)
    const state = await getWorkflowFromDynamo(params.id);
    if (!state) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    let tickets;
    if (TICKET_PROVIDER === "jira") {
      tickets = await getTicketsForWorkflowFromJira(params.id);
    } else {
      // Scan by workflowId
      tickets = await getTicketsForWorkflowFromDynamo(params.id);

      // Also fetch any ticket IDs referenced in agentTasks that the scan missed
      // (tickets may not have workflowId field set)
      if (state.agentTasks) {
        const ticketIds = Object.values(state.agentTasks as Record<string, Record<string, unknown>>)
          .map((t) => t.ticketId as string)
          .filter(Boolean);
        const foundIds = new Set(tickets.map((t: Record<string, unknown>) => t.ticketId));
        const missingIds = ticketIds.filter(id => !foundIds.has(id));
        if (missingIds.length > 0) {
          const extra = await getTicketsByIds(missingIds);
          tickets = [...tickets, ...extra];
        }
      }
    }

    // Include Jira browse base URL only when Jira is the ticket provider
    const jiraSiteUrl = TICKET_PROVIDER === "jira" ? (process.env.JIRA_SITE_URL || null) : null;
    const browseBaseUrl = jiraSiteUrl ? `https://${jiraSiteUrl}/browse` : null;

    return NextResponse.json({ tickets, browseBaseUrl }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(`[tickets] Error fetching tickets for ${params.id}:`, err);
    return NextResponse.json(
      { error: `Failed to fetch tickets: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
