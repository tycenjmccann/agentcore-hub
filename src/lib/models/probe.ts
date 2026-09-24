/**
 * Model probes (TEAM-4997): does this model actually work, on both paths we use?
 *
 * A catalog row can be listed, priced and completely unusable — a model that
 * rejects the harness loop's prefill turn, or one the coding CLI can't drive.
 * Two probes answer that, and the answer is recorded on the row so `/models`
 * can refuse to route a `candidate` nobody has ever successfully called:
 *
 *   • API probe — one 16-token turn on the model's own endpoint (Converse for
 *     anthropic, the OpenAI-compatible Responses API for openai).
 *   • CLI probe — one real coding turn on the coding-agent runtime, then a
 *     VERIFICATION COMMAND run inside the same container via the AgentCore
 *     commands API. The turn claiming "I wrote the file" is not evidence; the
 *     file being readable from a second, independent process is.
 *
 * Two deliberate constraints:
 *   1. The verification command reads the workspace path the TURN ITSELF
 *      reported. It never guesses a path, and it never runs at all if the turn
 *      reported none — a `cat` against a guessed directory can only produce a
 *      false negative, or worse a false positive on someone else's file.
 *   2. The path is validated against WORKSPACE_RE before it is interpolated into
 *      a shell command. That regex is what makes the quoting sufficient: no
 *      quote, `$`, backtick, backslash or newline can reach the shell.
 *
 * This module builds its own runtime payload rather than importing
 * src/lib/cloud-code/runtime.ts: Cloud Code is an optional module, and one
 * optional module may not import another (CLAUDE.md, "Modular core + bolt-ons").
 * The payload follows that file's contract (`buildTurnPayload`) plus `model` and
 * `origin:"probe"`, and the teardown is the same StopRuntimeSession call.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import type { CatalogRow, ProbeOutcome } from "@/lib/models-registry";
import { mintBedrockBearerToken } from "./sigv4";

/** Asks for one word, so a working model is cheap and a broken one is obvious. */
export const API_PROBE_PROMPT = "Reply with the word ok.";
/** Forces a tool loop AND leaves on-disk evidence the command probe can verify. */
export const CLI_PROBE_PROMPT = "create hello.txt containing ok, then cat it";

/** Shell-safe workspace path. See constraint 2 in the module doc. */
export const WORKSPACE_RE = /^[A-Za-z0-9._/-]+$/;

const API_TIMEOUT_MS = 30_000;
/** A cold CLI turn clones a repo and runs a real model; 300s is the ceiling. */
const TURN_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_S = 30;

function nowOutcome(ok: boolean, startedMs: number, error?: string): ProbeOutcome {
  return {
    ok,
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - startedMs) / 100) / 10,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// API probe
// ---------------------------------------------------------------------------

async function converseProbe(row: CatalogRow): Promise<void> {
  const client = new BedrockRuntimeClient({
    region: row.region,
    requestHandler: { requestTimeout: API_TIMEOUT_MS },
  });
  const res = await client.send(
    new ConverseCommand({
      modelId: row.modelId,
      messages: [{ role: "user", content: [{ text: API_PROBE_PROMPT }] }],
      inferenceConfig: { maxTokens: 16 },
    })
  );
  const text = (res.output?.message?.content || [])
    .map((block) => block.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("empty Converse output");
}

/** Mantle speaks on `.api.aws`; an `*.openai.*` profile on bedrock-runtime. */
function responsesHost(row: CatalogRow): string {
  return row.endpoint === "bedrock-mantle"
    ? `bedrock-mantle.${row.region}.api.aws`
    : `bedrock-runtime.${row.region}.amazonaws.com`;
}

async function responsesProbe(row: CatalogRow): Promise<void> {
  const token = await mintBedrockBearerToken(row.region);
  const res = await fetch(`https://${responsesHost(row)}/openai/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ model: row.modelId, input: "Reply with ok", max_output_tokens: 16 }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  const text = (
    body.output_text ||
    (body.output || []).flatMap((o) => (o.content || []).map((c) => c.text || "")).join("")
  ).trim();
  if (!text) throw new Error("empty Responses output");
}

/** One 16-token turn on the model's own endpoint. Never throws. */
export async function runApiProbe(row: CatalogRow): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    if (row.vendor === "anthropic") await converseProbe(row);
    else await responsesProbe(row);
    console.log(`[models] probe.result modelId=${row.modelId} mode=api ok=true`);
    return nowOutcome(true, started);
  } catch (err) {
    const error = (err as Error)?.message || "probe failed";
    console.warn(`[models] probe.result modelId=${row.modelId} mode=api ok=false error=${error}`);
    return nowOutcome(false, started, error);
  }
}

// ---------------------------------------------------------------------------
// CLI probe
// ---------------------------------------------------------------------------

function agentCoreClient(region: string, timeoutMs: number): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({ region, requestHandler: { requestTimeout: timeoutMs } });
}

/** AgentCore requires a session id of at least 33 characters. */
function probeSessionId(modelId: string): string {
  const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `probe-${slug}-${Date.now()}-${randomUUID()}`.padEnd(33, "-").slice(0, 80);
}

interface TurnReply {
  workspace?: string;
  response?: string;
}

async function runProbeTurn(
  client: BedrockAgentCoreClient,
  runtimeArn: string,
  sessionId: string,
  row: CatalogRow
): Promise<TurnReply> {
  const payload = {
    prompt: CLI_PROBE_PROMPT,
    cli: row.vendor === "openai" ? "codex" : "claude",
    session_id: sessionId,
    // The coding runtime reads `model` per turn; `origin` is inert for a probe
    // (only compared against "workflow"), and teardown is explicit below.
    model: row.modelId,
    origin: "probe",
  };
  const res = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "application/json",
    })
  );
  const body = res.response ? await res.response.transformToString() : "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`bad runtime response: ${body.slice(0, 120)}`);
  }
  if (parsed.error) throw new Error(String(parsed.error));
  return {
    workspace: (parsed.workspace as string) || undefined,
    response: (parsed.response as string) || undefined,
  };
}

/**
 * Run one command in the session's container and return its stdout plus how many
 * executions reported a terminal status. stdout arrives in arbitrary chunks, so
 * it is concatenated before anything is asserted about its contents.
 */
async function runProbeCommand(
  client: BedrockAgentCoreClient,
  runtimeArn: string,
  sessionId: string,
  command: string
): Promise<{ stdout: string; stops: number }> {
  const res = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      body: { command, timeout: COMMAND_TIMEOUT_S },
    })
  );
  let stdout = "";
  let stops = 0;
  for await (const event of res.stream || []) {
    const chunk = (event as { chunk?: { contentDelta?: { stdout?: string }; contentStop?: { status?: string } } }).chunk;
    if (!chunk) {
      // A non-chunk member of the stream union IS the API's error channel. The
      // union includes $UnknownMember, so it is read as a bag of keys.
      const key = Object.keys(event as unknown as Record<string, unknown>)[0] || "unknown";
      throw new Error(`command stream error: ${key}`);
    }
    if (chunk.contentDelta?.stdout) stdout += chunk.contentDelta.stdout;
    if (chunk.contentStop) stops++;
  }
  return { stdout, stops };
}

async function stopProbeSession(
  client: BedrockAgentCoreClient,
  runtimeArn: string,
  sessionId: string
): Promise<void> {
  await client.send(
    new StopRuntimeSessionCommand({
      runtimeSessionId: sessionId,
      agentRuntimeArn: runtimeArn,
      qualifier: "DEFAULT",
    })
  );
}

/**
 * One coding turn plus an independent in-container verification of its work.
 * Never throws; the session is always torn down, including when the turn fails.
 *
 * A green result here means "the CLI worked", not yet "the CLI worked on
 * `row.modelId`": the runtime's turn result carries no model echo, and its
 * `resolve_coding_model` substitutes `defaults.coding*` for an id it cannot
 * resolve. Until the runtime echoes the model it ran, the guard is the probe
 * route's `not_probeable` refusal, which never sends it a substitutable row
 * (TEAM-5008 finding 5).
 */
export async function runCliProbe(
  row: CatalogRow,
  opts: { runtimeArn?: string; region?: string } = {}
): Promise<ProbeOutcome> {
  const started = Date.now();
  const runtimeArn = opts.runtimeArn || process.env.CODING_AGENT_RUNTIME_ARN || "";
  if (!runtimeArn) return nowOutcome(false, started, "CODING_AGENT_RUNTIME_ARN is not set");

  const region = opts.region || process.env.AWS_REGION || "us-east-1";
  const sessionId = probeSessionId(row.modelId);
  const client = agentCoreClient(region, TURN_TIMEOUT_MS);

  let outcome: ProbeOutcome;
  try {
    const turn = await runProbeTurn(client, runtimeArn, sessionId, row);
    const workspace = turn.workspace;
    if (!workspace) {
      outcome = nowOutcome(false, started, "no workspace in turn result");
    } else if (!WORKSPACE_RE.test(workspace)) {
      outcome = nowOutcome(false, started, "unsafe workspace path");
    } else {
      const command = `bash -c 'cat "${workspace}/hello.txt"'`;
      const { stdout, stops } = await runProbeCommand(client, runtimeArn, sessionId, command);
      const ok = stdout.includes("ok") && stops >= 1;
      outcome = nowOutcome(ok, started, ok ? undefined : `hello.txt did not contain ok (stdout=${stdout.trim().slice(0, 80)})`);
    }
  } catch (err) {
    outcome = nowOutcome(false, started, (err as Error)?.message || "probe failed");
  } finally {
    try {
      await stopProbeSession(client, runtimeArn, sessionId);
    } catch {
      /* best-effort teardown; the reaper sweeps a leaked session */
    }
  }

  console.log(
    `[models] probe.result modelId=${row.modelId} mode=cli ok=${outcome.ok}${outcome.error ? ` error=${outcome.error}` : ""}`
  );
  return outcome;
}
