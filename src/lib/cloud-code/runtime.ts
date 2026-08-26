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
  StopRuntimeSessionCommand,
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
  // "Port to cloud" handoff: check out the pushed branch and natively resume
  // the laptop transcript shipped to this S3 key.
  branch?: string;
  resumeTranscriptKey?: string;
  resumeSessionId?: string;
  // Flexible git handoff. gitMode: "pushed" (clone + checkout branch), "bundle"
  // (clone cloneUrl, then git-fetch the uploaded bundle to layer the laptop's
  // commits on top), "selfContained" (rebuild a standalone repo from a whole-repo
  // bundle --all), or "none" (bare workspace). cloneUrl is the explicit origin;
  // resumeBundleKey is the bundle's S3 key.
  gitMode?: "pushed" | "bundle" | "selfContained" | "none";
  cloneUrl?: string;
  resumeBundleKey?: string;
  // Short-lived GitHub App installation token minted for the session owner (see
  // github-app.ts). Handed to the runtime per turn; never persisted.
  githubToken?: string;
  // True when the owner has a GitHub App installation. When set, a missing token
  // means the scoped mint was DENIED — the runtime must NOT fall back to
  // GITHUB_PAT, or the clone would escalate beyond the user's App scope.
  githubAppConnected?: boolean;
  // Chat attachments: paths relative to the session's artifact prefix (composer
  // uploads). The runtime downloads them into the workspace and appends their
  // on-disk paths to the prompt.
  attachments?: string[];
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
  if (params.gitMode) payload.git_mode = params.gitMode;
  if (params.cloneUrl) payload.clone_url = params.cloneUrl;
  if (params.resumeBundleKey) payload.resume_bundle = params.resumeBundleKey;
  if (params.githubToken) payload.github_token = params.githubToken;
  if (params.githubAppConnected) payload.github_app_connected = true;
  if (params.attachments?.length) payload.attachments = params.attachments;
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
 * frames as the turn runs — claude token deltas, codex per-step frames.
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
 * Interrupt a running turn ("Ctrl-C"). Chat turns run headless in the session
 * microVM (claude --print), so there's no PTY signal to send — StopRuntimeSession
 * tears the microVM down and kills the in-flight CLI. The workspace (EFS) +
 * transcript persist, so the next turn resumes with any partial work intact.
 */
export async function stopCodingSession(params: {
  sessionId: string; // runtimeSessionId — selects the microVM to tear down
  region?: string;
}): Promise<void> {
  if (!CODING_RUNTIME_ARN) throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  const region = params.region || REGION;
  await client(region).send(
    new StopRuntimeSessionCommand({
      runtimeSessionId: params.sessionId,
      agentRuntimeArn: CODING_RUNTIME_ARN,
      qualifier: "DEFAULT",
    })
  );
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
  githubToken?: string;
  githubAppConnected?: boolean;
  gitMode?: "pushed" | "bundle" | "selfContained" | "none";
  cloneUrl?: string;
  resumeBundleKey?: string;
}): Promise<{ resumeReady: boolean }> {
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
  if (params.gitMode) payload.git_mode = params.gitMode;
  if (params.cloneUrl) payload.clone_url = params.cloneUrl;
  if (params.resumeBundleKey) payload.resume_bundle = params.resumeBundleKey;
  if (params.userId) payload.user_id = params.userId;
  if (params.tenantId) payload.tenant_id = params.tenantId;
  if (params.configVersion) payload.config_version = params.configVersion;
  if (params.githubToken) payload.github_token = params.githubToken;
  if (params.githubAppConnected) payload.github_app_connected = true;

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CODING_RUNTIME_ARN,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "application/json",
  });
  const res = await client(region).send(command);
  // resume_ready: the runtime wrote the Terminal auto-resume hint, so opening the
  // PTY will land in the live TUI. /shell relays this so the browser knows whether
  // to fire its first-prompt seed (no resume → hold the seed, don't type it into a
  // bare shell).
  return { resumeReady: await parseResumeReady(res.response) };
}

// Both warm and prepare report whether the runtime's Terminal auto-resume hint is
// in place. Non-JSON / missing body → not ready (the seed stays pending).
async function parseResumeReady(body?: { transformToString(): Promise<string> }): Promise<boolean> {
  try {
    const text = body ? await body.transformToString() : "";
    return Boolean(JSON.parse(text).resume_ready);
  } catch {
    return false;
  }
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
}): Promise<{ resumeReady: boolean }> {
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
  const res = await client(region).send(command);
  // resume_ready: a restored/prior /tmp hint means the Terminal will auto-resume
  // this conversation (gates the client's first-prompt seed).
  return { resumeReady: await parseResumeReady(res.response) };
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
  // Workspace resolution on the runtime derives the slug from repo OR cloneUrl —
  // a cloneUrl-only session (non-GitHub/SSH origin) MUST forward it or the
  // checkpoint resolves to the bare session dir, misses the transcript's project
  // slug, and 404s the pull-home.
  cloneUrl?: string;
  gitMode?: "pushed" | "bundle" | "selfContained" | "none";
  resumeSessionId?: string; // the conversation's real id (the transcript filename)
  tenantId?: string;
  region?: string;
}): Promise<{
  key?: string;
  bytes?: number;
  branch?: string;
  artifactPrefix?: string;
  artifactCount?: number;
  // bundle/selfContained sessions: S3 key of a whole-history git bundle carrying
  // the cloud's commits (no writable origin to fetch them from). The pull leg
  // fetches from this bundle instead of origin.
  returnBundleKey?: string;
  returnBundleBranch?: string;
}> {
  if (!CODING_RUNTIME_ARN) throw new Error("CODING_AGENT_RUNTIME_ARN is not set");
  const region = params.region || REGION;
  const payload: Record<string, unknown> = {
    checkpoint: true,
    cli: params.cli,
    session_id: params.sessionId,
  };
  if (params.repo) payload.repo = params.repo;
  if (params.cloneUrl) payload.clone_url = params.cloneUrl;
  if (params.gitMode) payload.git_mode = params.gitMode;
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
  // The runtime also harvests touched-untracked deliverables to an S3 prefix
  // ({count, bytes, prefix}) — surfaced so the checkpoint route can presign a
  // GET per file for the pull-home leg.
  const arts = (parsed.artifacts || {}) as { count?: number; prefix?: string };
  const rb = (parsed.return_bundle || null) as { key?: string; branch?: string } | null;
  return {
    key: parsed.key as string | undefined,
    bytes: parsed.bytes as number | undefined,
    branch: parsed.branch as string | undefined,
    artifactPrefix: arts.prefix || undefined,
    artifactCount: arts.count ?? 0,
    returnBundleKey: rb?.key || undefined,
    returnBundleBranch: rb?.branch || undefined,
  };
}
