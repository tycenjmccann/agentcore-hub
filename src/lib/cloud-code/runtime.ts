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

export interface CodingTurnParams {
  sessionId: string; // runtimeSessionId — selects the warm microVM
  prompt: string;
  cli: CloudCodeCli;
  repo?: string;
  claudeSessionId?: string;
  userId?: string;
  tenantId?: string; // isolation boundary; scopes the runtime's config/checkpoint S3 keys
  configVersion?: string;
  region?: string;
  // "Port to cloud" handoff (first turn only): check out the pushed branch and
  // natively resume the laptop transcript shipped to this S3 key.
  branch?: string;
  resumeTranscriptKey?: string;
  resumeSessionId?: string;
}

function buildTurnPayload(params: CodingTurnParams): Record<string, unknown> {
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
  // Tenant scopes the runtime's config + checkpoint S3 keys (must match s3keys.ts).
  if (params.tenantId) payload.tenant_id = params.tenantId;
  if (params.configVersion) payload.config_version = params.configVersion;
  if (params.branch) payload.branch = params.branch;
  if (params.resumeTranscriptKey) payload.resume_transcript = params.resumeTranscriptKey;
  if (params.resumeSessionId) payload.resume_session_id = params.resumeSessionId;
  return payload;
}

export async function invokeCodingTurn(params: CodingTurnParams): Promise<CodingTurnResult> {
  if (!CODING_RUNTIME_ARN) {
    throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  }
  const region = params.region || REGION;

  const payload = buildTurnPayload(params);

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
export async function invokeCodingTurnStream(params: CodingTurnParams): Promise<ReadableStream<Uint8Array>> {
  if (!CODING_RUNTIME_ARN) {
    throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  }
  const region = params.region || REGION;

  const payload = { ...buildTurnPayload(params), stream: true };

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

/**
 * Pre-warm a session's microVM: clone the repo, check out the branch, and
 * install the ported transcript NOW — no CLI runs. Called right after a port so
 * the workspace is hot by the time the user opens the link (cloning a big repo
 * can take 10-30s). Best-effort; resolves on the runtime's {warmed:true} reply.
 */
export async function warmCodingSession(params: {
  sessionId: string;
  cli: CloudCodeCli;
  repo?: string;
  branch?: string;
  resumeTranscriptKey?: string;
  resumeSessionId?: string;
  // Materialize the user's config bundle (skills/agents/MCP) as part of warming,
  // so an opened session is hot AND has the user's tools without a chat turn.
  userId?: string;
  tenantId?: string;
  configVersion?: string;
  region?: string;
}): Promise<void> {
  if (!CODING_RUNTIME_ARN) throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  const region = params.region || REGION;
  const payload: Record<string, unknown> = {
    warm: true,
    cli: params.cli,
    session_id: params.sessionId,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.branch) payload.branch = params.branch;
  if (params.resumeTranscriptKey) payload.resume_transcript = params.resumeTranscriptKey;
  if (params.resumeSessionId) payload.resume_session_id = params.resumeSessionId;
  if (params.userId) payload.user_id = params.userId;
  if (params.tenantId) payload.tenant_id = params.tenantId;
  if (params.configVersion) payload.config_version = params.configVersion;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CODING_RUNTIME_ARN,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "application/json",
  });
  await client(region).send(command);
}

/**
 * Config-only prepare: tell the session's microVM to materialize the user's
 * config bundle (skills/agents/.mcp.json) + default MCP gateway, then return —
 * no repo clone, no CLI. Fired by the /shell route before it hands the browser a
 * presigned PTY URL, so a TERMINAL-only session (which never runs a chat turn)
 * still gets the user's skills + MCP servers on disk. Idempotent + sub-second on
 * a warm VM (the runtime's apply marker no-ops a repeat).
 */
export async function prepareCodingSession(params: {
  sessionId: string;
  cli: CloudCodeCli;
  userId?: string;
  tenantId?: string;
  configVersion?: string;
  region?: string;
}): Promise<void> {
  if (!CODING_RUNTIME_ARN) throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  const region = params.region || REGION;
  const payload: Record<string, unknown> = {
    prepare: true,
    cli: params.cli,
    session_id: params.sessionId,
  };
  if (params.userId) payload.user_id = params.userId;
  if (params.tenantId) payload.tenant_id = params.tenantId;
  if (params.configVersion) payload.config_version = params.configVersion;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CODING_RUNTIME_ARN,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "application/json",
  });
  await client(region).send(command);
}

/**
 * Checkpoint: ask the runtime to upload the session's (now-grown) transcript
 * back to S3 so the laptop can pull it home and `claude --resume` locally — the
 * round trip. Returns the S3 key of the uploaded transcript + the cloud branch.
 */
export async function checkpointCodingSession(params: {
  sessionId: string;
  cli: CloudCodeCli;
  repo?: string;
  resumeSessionId?: string; // the conversation's real id (the transcript filename)
  tenantId?: string;
  region?: string;
}): Promise<{ key?: string; bytes?: number; branch?: string }> {
  if (!CODING_RUNTIME_ARN) throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  const region = params.region || REGION;
  const payload: Record<string, unknown> = {
    checkpoint: true,
    cli: params.cli,
    session_id: params.sessionId,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.resumeSessionId) payload.resume_session_id = params.resumeSessionId;
  if (params.tenantId) payload.tenant_id = params.tenantId;

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
    throw new Error(`checkpoint: bad runtime response: ${body.slice(0, 200)}`);
  }
  if (parsed.error) throw new Error(String(parsed.error));
  return {
    key: parsed.key as string | undefined,
    bytes: parsed.bytes as number | undefined,
    branch: parsed.branch as string | undefined,
  };
}
