/**
 * POST /api/workflow-manager/chat
 *
 * Body: { conversationId, message, workflowId? }
 * Streams the Workflow Manager harness (agentcore_hub_workflow_manager) CHAT
 * response as SSE. Reuses the shared harness invoker (invokeHarnessAgent) so the
 * event schema matches every other streaming surface — the client parses it with
 * the shared sseData reader.
 *
 * The harness has persistent memory (actorId "workflow-manager"), so each
 * conversation is a session (sessionId = wmchat-{conversationId}); prior context
 * carries across sessions via memory — the client sends only the new message.
 */

import { NextRequest } from "next/server";
import { invokeHarnessAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";
import { getWorkflowFromDynamo, getLastEventForWorkflow } from "@/lib/workflow/dynamo-read";
import { isTerminalPhase } from "@/lib/workflow/types";
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HARNESS_NAME = "agentcore_hub_workflow_manager";
const ACTOR_ID = "workflow-manager";

let cachedHarnessArn: string | null = process.env.WORKFLOW_MANAGER_ARN || null;

async function resolveHarnessArn(region: string): Promise<string | null> {
  if (cachedHarnessArn) return cachedHarnessArn;
  const control = new BedrockAgentCoreControlClient({ region });
  const page = await control.send(new ListHarnessesCommand({}));
  const match = (page.harnesses || []).find((h) => h.harnessName === HARNESS_NAME);
  cachedHarnessArn = match?.arn || null;
  return cachedHarnessArn;
}

/**
 * Live snapshot of the viewed workflow, injected into the prompt so the WM
 * doesn't burn its first minute re-orienting (listing tables, re-pulling the
 * dossier) before answering "why is this stalled?". Best-effort: any read
 * failure degrades to the bare id line.
 */
async function buildWorkflowContext(workflowId: string): Promise<string> {
  try {
    const [wf, lastEvent] = await Promise.all([
      getWorkflowFromDynamo(workflowId),
      getLastEventForWorkflow(workflowId).catch(() => null),
    ]);
    if (!wf) return `Context: currently viewing workflow ${workflowId}`;

    const lines = [
      `Context: currently viewing workflow ${workflowId} — live snapshot (already fetched for you; verify with the toolkit only if you need more depth):`,
      `- title: ${(wf.input as { title?: string })?.title || "(untitled)"}`,
      `- phase: ${wf.phase}${wf.error ? ` (error: ${wf.error})` : ""}`,
      `- epic: ${wf.epicId || "none"} | def: ${wf.workflowDefId || "default"} | type: ${wf.workflowType || "feature"}`,
      `- started: ${wf.startedAt}${wf.completedAt ? ` | completed: ${wf.completedAt}` : ""}`,
    ];

    const tasks = Object.values(
      (wf.agentTasks || {}) as Record<string, { agentId?: string; ticketId?: string; status?: string; startedAt?: string; completedAt?: string; error?: string }>,
    );
    if (tasks.length) {
      const active = tasks.filter((t) => t.status === "running" || t.status === "waiting_response" || t.status === "pending");
      const failed = tasks.filter((t) => t.status === "error");
      const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
        const s = t.status || "unknown";
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {});
      lines.push(`- agent tasks: ${tasks.length} total (${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ")})`);
      for (const t of active) {
        lines.push(`  - ACTIVE ${t.agentId || "?"} [${t.status}] ticket ${t.ticketId || "?"}${t.startedAt ? ` since ${t.startedAt}` : ""}`);
      }
      for (const t of failed) {
        lines.push(`  - FAILED ${t.agentId || "?"} ticket ${t.ticketId || "?"}: ${(t.error || "").slice(0, 200)}`);
      }
    }

    // TEAM-3747 D2: deploy-blocked / static-ci-only are terminal too, so a blocked
    // run is not reported to the manager as running/"LIKELY STALLED".
    const isRunning = !isTerminalPhase(wf.phase as string);
    if (lastEvent?.timestamp) {
      const silentMin = Math.round((Date.now() - new Date(lastEvent.timestamp as string).getTime()) / 60000);
      lines.push(`- last event: ${lastEvent.type || "?"} at ${lastEvent.timestamp}${isRunning ? ` (${silentMin} min ago${silentMin >= 10 ? " — LIKELY STALLED" : ""})` : ""}`);
    }

    return lines.join("\n");
  } catch {
    return `Context: currently viewing workflow ${workflowId}`;
  }
}

export async function POST(req: NextRequest) {
  const region = process.env.AWS_REGION || DEFAULT_REGION;
  const { conversationId, message, workflowId } = await req.json().catch(() => ({}));
  if (!conversationId || !message) {
    return Response.json(
      { error: "conversationId and message are required" },
      { status: 400 },
    );
  }

  const harnessArn = await resolveHarnessArn(region);
  if (!harnessArn) {
    return Response.json(
      { error: "Workflow Manager harness not found. Deploy it first." },
      { status: 503 },
    );
  }

  // sessionId must be >= 33 chars for AgentCore.
  const sessionId = `wmchat-${conversationId}`.padEnd(33, "0");
  const contextBlock = workflowId ? await buildWorkflowContext(workflowId) : null;
  const prompt = contextBlock ? `${contextBlock}\n\n${message}` : message;

  const stream = await invokeHarnessAgent({
    harnessArn,
    prompt,
    sessionId,
    actorId: ACTOR_ID,
    timeoutSeconds: 600,
    maxIterations: 40,
    region,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
