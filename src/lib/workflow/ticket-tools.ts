/**
 * invokeTicketTool — call one `Tickets___*` tool on the active ticket Lambda
 * (TICKET_TOOLS_LAMBDA: the DynamoDB or the Jira twin; same tool interface).
 *
 * Lifted from start/route.ts's invokeTicketLambda (which keeps its copy) and
 * normalized, because both twins refuse inside a 200 payload with no
 * FunctionError (see rejectedDetails in tickets/transition/route.ts):
 *   tickets twin  success { key, status: "created"|"updated"|"transitioned", … }
 *                 refusal textResult = { content: [{ text }] } (sometimes + ok:false, reason)
 *   jira twin     success { ticketId, … }
 *                 refusal { error } (sometimes + ok:false, reason)
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";
const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

export type TicketToolResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; result?: Record<string, unknown> };

/** The refusal text in a twin payload, or null when it reads as a success. */
export function ticketToolRefusal(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "unreadable ticket tool payload";
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string" && p.error.trim()) return p.error.trim();
  const text = Array.isArray(p.content) ? (p.content[0] as { text?: unknown } | undefined)?.text : undefined;
  if (p.ok === false) return typeof p.reason === "string" ? p.reason : typeof text === "string" ? text : "refused";
  if (Array.isArray(p.content) && p.key === undefined && p.ticketId === undefined) {
    return typeof text === "string" && text.trim() ? text.trim() : "refused by the tickets Lambda";
  }
  return null;
}

/** The ticket key a create returned (tickets twin `key`, jira twin `ticketId`). */
export function ticketKeyOf(result: Record<string, unknown>): string | null {
  const key = result.key ?? result.ticketId ?? (result.ticket as Record<string, unknown> | undefined)?.key;
  return typeof key === "string" && key ? key : null;
}

export async function invokeTicketTool(toolName: string, params: Record<string, unknown>): Promise<TicketToolResult> {
  let resp;
  try {
    resp = await lambda.send(
      new InvokeCommand({
        FunctionName: TICKET_TOOLS_LAMBDA,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ tool_name: toolName, parameters: params })),
      })
    );
  } catch (err) {
    return { ok: false, error: `${toolName} invoke failed: ${(err as Error).message}` };
  }
  const raw = resp.Payload ? new TextDecoder().decode(resp.Payload) : "";
  if (resp.FunctionError) return { ok: false, error: `${toolName} failed: ${raw.slice(0, 300) || resp.FunctionError}` };
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch {
    return { ok: false, error: `${toolName}: unreadable payload` };
  }
  const refusal = ticketToolRefusal(payload);
  if (refusal) return { ok: false, error: `${toolName}: ${refusal}`, result: payload as Record<string, unknown> };
  return { ok: true, result: payload as Record<string, unknown> };
}
