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
  region?: string;
}): Promise<CodingTurnResult> {
  if (!CODING_RUNTIME_ARN) {
    throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  }
  const region = params.region || REGION;

  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    cli: params.cli,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.claudeSessionId) payload.claude_session_id = params.claudeSessionId;

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
