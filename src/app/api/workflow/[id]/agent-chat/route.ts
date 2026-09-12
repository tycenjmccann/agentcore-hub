/**
 * POST /api/workflow/[id]/agent-chat — chat with a run's Strands persona while
 * it is IDLE (TEAM-4498).
 *
 * Body: { agentId, message }
 * Streams the persona's reply as SSE in the app-wide event schema
 * ({type:"text"|"trace"|"done"|"error"}), so the client reads it with the shared
 * sseData reader exactly like the Workflow Manager chat.
 *
 * Three things make this route different from the mailbox
 * (POST /api/workflow/[id]/message), and all three are deliberate:
 *
 * 1. IDLE-ONLY, the inverse of the mailbox. The mailbox exists to interrupt an
 *    agent mid-turn; this is a read-only Q&A with an agent that has stopped.
 *    A persona whose task is running/waiting_response gets 409 `agent_active`
 *    — decided server-side with `isStaleEligibleStatus`, the one shared
 *    active-turn predicate, so the UI's disabled state and this gate can't drift.
 *
 * 2. NO `workflow_id` IN THE PAYLOAD. The runtime's `_run_agent_invocation`
 *    publishes `agent.started` unconditionally when a workflow_id is present, so
 *    sending it would write a phantom dispatch into the run's event partition and
 *    convince the board, the stale detector and the metrics that the persona had
 *    restarted. The run context the operator wants to ask about is injected into
 *    the prompt instead. The runtime's own `_publish_event` guard then suppresses
 *    every event write for this invocation — chat is invisible to the board, and
 *    no runtime change (hence no fleet redeploy) is needed.
 *
 * 3. NO `detach`. Omitting it keeps the runtime's synchronous streaming path,
 *    which its entrypoint docstring reserves for chat and ad-hoc invokes.
 *
 * Session continuity: the persona's memory session is resumed from the newest
 * `orchestrator.agent_invoked` event, which also records the exact runtime ARN
 * the persona ran on (the fleet may be 1|4|14 runtimes, so it can't be derived).
 * The resolved sessionId is returned in a response header so the client can read
 * prior turns back from persona memory.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  invokeAgentRuntime,
  discoverAgents,
  DEFAULT_REGION,
} from "@/lib/agentcore-sdk";
import {
  getWorkflowFromDynamo,
  getLatestAgentInvocation,
} from "@/lib/workflow/dynamo-read";
import { isStaleEligibleStatus } from "@/lib/workflow/stale";
import { isChatablePersona, personaDisplayName } from "@/lib/workflow/personas";
import { CHAT_MARKER, QUESTION_MARKER } from "@/lib/workflow/persona-chat";
import type { AgentTask } from "@/lib/workflow/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fleet host runtime — the deployed name every persona is invoked through. */
const FLEET_RUNTIME_NAME = "agentcore_hub_agent";

const MAX_MESSAGE_CHARS = 4000;

/**
 * Both ids reach an AWS API (a DynamoDB key and a runtime session id), so they
 * are validated as opaque tokens BEFORE any AWS call. This also happens to
 * reject the board's `human:*` gate pseudo-agents, which contain a colon.
 */
const ID_PATTERN = /^[\w-]+$/;

/** What the client is told when an invoke fails — never the upstream text. */
const OPAQUE_ERROR = "The agent could not be reached. Check the run's logs.";

/**
 * Read-only framing. The persona is invoked with its full toolset (the runtime
 * attaches tools per agent, not per call), so the contract that this is a
 * conversation and not a work assignment has to be stated in the prompt.
 */
function buildPreamble(
  agentId: string,
  workflow: Record<string, unknown>,
  task: AgentTask | undefined
): string {
  const input = workflow.input as { description?: string; title?: string } | undefined;
  const lines = [
    CHAT_MARKER,
    `You are ${personaDisplayName(agentId)} (${agentId}), being asked questions by a human operator`,
    `about work you already did. This is a READ-ONLY conversation, not a new assignment.`,
    ``,
    `Rules for this conversation:`,
    `- Answer from what you did and what you know. Be direct and brief.`,
    `- Do NOT start new work, write or edit files, or push commits.`,
    `- Do NOT create or transition tickets, and do NOT report completion.`,
    `- If something needs doing, say so and let the operator decide.`,
    ``,
    `Run context:`,
    `- workflow: ${String(workflow.id || "")} (phase: ${String(workflow.phase || "unknown")})`,
  ];
  if (input?.title) lines.push(`- request: ${input.title}`);
  if (task) {
    lines.push(`- your ticket: ${task.ticketId} (status: ${task.status})`);
    if (task.completedAt) lines.push(`- you finished at: ${task.completedAt}`);
    if (task.outcome) lines.push(`- your outcome: ${task.outcome}`);
    if (task.error) lines.push(`- your last error: ${task.error}`);
  }
  lines.push(``, QUESTION_MARKER);
  return lines.join("\n");
}

/**
 * `invokeAgentRuntime` puts the raw upstream failure into its error frame. That
 * text can carry an account id or an ARN, so rather than change the shared SDK
 * (every other invoke surface reads it) the frames are rewritten here: the
 * client gets a static message, the server log keeps the real one.
 */
function sanitizeErrorFrames(source: ReadableStream, context: string): ReadableStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const rewrite = (frame: string): string => {
    if (!frame.startsWith("data: ")) return frame;
    let parsed: { type?: string; event?: string; content?: string };
    try {
      parsed = JSON.parse(frame.slice(6));
    } catch {
      return frame;
    }
    const isError = parsed.type === "error" || parsed.event === "error";
    if (!isError) return frame;
    console.error(`[agent-chat] ${context} upstream error:`, parsed.content);
    return `data: ${JSON.stringify({ ...parsed, content: OPAQUE_ERROR })}`;
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        // Frames are "\n\n"-delimited; hold a partial tail until it completes.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!part) continue;
          controller.enqueue(encoder.encode(`${rewrite(part)}\n\n`));
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
      },
    })
  );
}

type Target =
  | { error: NextResponse }
  | { workflow: Record<string, unknown>; task: AgentTask | undefined; active: boolean };

/**
 * The checks GET and POST share, in the order that keeps every AWS call behind a
 * validated input. `active` is returned rather than rejected here because GET
 * reports it (so the modal can render a disabled composer) while POST refuses it.
 */
async function resolveTarget(workflowId: string, agentId: string): Promise<Target> {
  if (!ID_PATTERN.test(workflowId)) {
    return { error: NextResponse.json({ error: "Invalid workflow id" }, { status: 400 }) };
  }
  if (!ID_PATTERN.test(agentId)) {
    return { error: NextResponse.json({ error: "Invalid agentId" }, { status: 400 }) };
  }
  if (!isChatablePersona(agentId)) {
    return {
      error: NextResponse.json(
        { error: "Chat is only available for pipeline agents", code: "not_a_persona" },
        { status: 400 }
      ),
    };
  }

  const workflow = await getWorkflowFromDynamo(workflowId);
  if (!workflow) {
    return { error: NextResponse.json({ error: "Workflow not found" }, { status: 404 }) };
  }

  // agentTasks is keyed by ticketId, so find this persona's entries by agentId.
  // A persona can hold more than one ticket in a run (rework); ANY live one
  // means it is mid-turn.
  const tasks = Object.values(
    (workflow.agentTasks as Record<string, AgentTask> | undefined) || {}
  ).filter(t => t?.agentId === agentId);

  // Newest task first — the one the operator is looking at in the modal.
  const task = [...tasks].sort((a, b) =>
    String(b.startedAt || "").localeCompare(String(a.startedAt || ""))
  )[0];

  return { workflow, task, active: tasks.some(t => isStaleEligibleStatus(t.status)) };
}

/**
 * GET /api/workflow/[id]/agent-chat?agentId=… → { sessionId, active }
 *
 * `sessionId` is the memory session the modal reads prior chat turns back from
 * (via /api/agentcore/memory/events); null when this persona was never
 * dispatched in this run, which simply means there is nothing to replay.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const agentId = (req.nextUrl.searchParams.get("agentId") || "").trim();
  const target = await resolveTarget(params.id, agentId);
  if ("error" in target) return target.error;

  const invocation = await getLatestAgentInvocation(params.id, agentId).catch(() => null);
  return NextResponse.json({
    sessionId: invocation?.sessionId || null,
    active: target.active,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const workflowId = params.id;

  let body: { agentId?: unknown; message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` },
      { status: 400 }
    );
  }

  const target = await resolveTarget(workflowId, agentId);
  if ("error" in target) return target.error;
  if (target.active) {
    return NextResponse.json(
      {
        error: "This agent is working. Chat is available when it is idle.",
        code: "agent_active",
      },
      { status: 409 }
    );
  }
  const { workflow, task } = target;

  const invocation = await getLatestAgentInvocation(workflowId, agentId).catch(() => null);

  let runtimeArn = invocation?.runtimeArn || null;
  if (!runtimeArn) {
    // Never dispatched in this run (or an older event without the ARN): fall
    // back to discovery of the fleet host by name.
    const agents = await discoverAgents(region).catch(() => []);
    runtimeArn =
      agents.find(a => a.type === "runtime" && a.name === FLEET_RUNTIME_NAME)?.arn || null;
  }
  if (!runtimeArn) {
    return NextResponse.json(
      { error: "Fleet runtime not found. Deploy the fleet first." },
      { status: 503 }
    );
  }

  // Resuming the recorded session lands these turns in the same memory session
  // the run used, so the persona answers with its own working context. With no
  // recorded session, open a fresh one (AgentCore requires >= 33 chars).
  const sessionId =
    invocation?.sessionId || `chat-${workflowId}-${agentId}-${Date.now()}`.padEnd(33, "0");

  const prompt = `${buildPreamble(agentId, workflow, task)}\n${message}`;

  // payloadFormat "custom" passes this JSON through verbatim — note the absent
  // workflow_id and detach (see the header comment).
  const payload = JSON.stringify({
    prompt,
    agent_id: agentId,
    ticket_id: task?.ticketId || "",
  });

  let stream: ReadableStream;
  try {
    stream = await invokeAgentRuntime({
      agentRuntimeArn: runtimeArn,
      prompt: payload,
      sessionId,
      payloadFormat: "custom",
      region,
    });
  } catch (err) {
    console.error(`[agent-chat] invoke failed for ${agentId} in ${workflowId}:`, err);
    return NextResponse.json({ error: OPAQUE_ERROR }, { status: 502 });
  }

  return new Response(sanitizeErrorFrames(stream, `${agentId}/${workflowId}`), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Lets the client read prior turns for exactly this memory session.
      "X-Chat-Session-Id": sessionId,
    },
  });
}
