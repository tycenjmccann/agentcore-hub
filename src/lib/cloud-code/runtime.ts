/**
 * Cloud Code — invoke the coding runtime.
 *
 * Sends the coding runtime's payload contract ({prompt, repo, cli,
 * claude_session_id}) to /invocations via the AgentCore data-plane and parses
 * the JSON reply ({response, claude_session_id, cli, workspace}).
 *
 * Turns are request/response today (the reply returns when the CLI finishes).
 * Per-tool live streaming is a later upgrade (SSE / streaming protocol).
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CloudCodeCli } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const CODING_RUNTIME_ARN = process.env.CODING_AGENT_RUNTIME_ARN || "";

// A coding turn can run for many minutes; give the SDK a long read timeout.
const clients = new Map<string, BedrockAgentCoreClient>();
function client(region: string): BedrockAgentCoreClient {
  let c = clients.get(region);
  if (!c) {
    c = new BedrockAgentCoreClient({
      region,
      requestHandler: { requestTimeout: 900_000 },
    });
    clients.set(region, c);
  }
  return c;
}

export interface CodingTurnResult {
  response: string;
  claudeSessionId?: string;
  cli: CloudCodeCli;
  workspace?: string;
}

export function codingRuntimeConfigured(): boolean {
  return Boolean(CODING_RUNTIME_ARN);
}

export async function invokeCodingTurn(params: {
  sessionId: string; // runtimeSessionId — selects the warm microVM
  prompt: string;
  cli: CloudCodeCli;
  repo?: string;
  claudeSessionId?: string;
  userId?: string;
  configVersion?: string;
  region?: string;
}): Promise<CodingTurnResult> {
  if (!CODING_RUNTIME_ARN) {
    throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  }
  const region = params.region || REGION;

  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    cli: params.cli,
    // Scope the workspace per session so concurrent sessions on the same repo
    // get isolated checkouts (no clobbering each other's branch/edits).
    session_id: params.sessionId,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.claudeSessionId) payload.claude_session_id = params.claudeSessionId;
  // Per-user config bundle (MCP/skills/agents) the runtime materializes first.
  if (params.userId) payload.user_id = params.userId;
  if (params.configVersion) payload.config_version = params.configVersion;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CODING_RUNTIME_ARN,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "application/json",
  });

  const res = await client(region).send(command);
  const body = res.response ? await res.response.transformToString() : "";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { response: body, cli: params.cli };
  }

  if (parsed.error) {
    throw new Error(String(parsed.error));
  }

  return {
    response: String(parsed.response ?? ""),
    claudeSessionId: (parsed.claude_session_id as string) || undefined,
    cli: (parsed.cli as CloudCodeCli) || params.cli,
    workspace: (parsed.workspace as string) || undefined,
  };
}

/**
 * Streaming variant: returns the runtime's raw text/event-stream body so the
 * caller can relay SSE to the browser. The runtime emits `data: {type:text|done|error}`
 * frames as the Claude turn runs. Claude only — codex stays buffered.
 */
export async function invokeCodingTurnStream(params: {
  sessionId: string;
  prompt: string;
  cli: CloudCodeCli;
  repo?: string;
  claudeSessionId?: string;
  userId?: string;
  configVersion?: string;
  region?: string;
}): Promise<ReadableStream<Uint8Array>> {
  if (!CODING_RUNTIME_ARN) {
    throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  }
  const region = params.region || REGION;

  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    cli: params.cli,
    session_id: params.sessionId,
    stream: true,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.claudeSessionId) payload.claude_session_id = params.claudeSessionId;
  if (params.userId) payload.user_id = params.userId;
  if (params.configVersion) payload.config_version = params.configVersion;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CODING_RUNTIME_ARN,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "text/event-stream",
  });

  const res = await client(region).send(command);
  // res.response is a stream (SdkStream). Expose it as a web ReadableStream.
  const r = res.response as unknown as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (r?.transformToWebStream) return r.transformToWebStream();
  throw new Error("runtime did not return a stream");
}
