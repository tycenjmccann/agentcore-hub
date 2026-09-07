/**
 * Agent Invoker Lambda — Fire-and-Forget Agent Kickoff
 *
 * Invoked ASYNCHRONOUSLY by the Orchestration Lambda (InvocationType: "Event").
 * Sends the invocation request to AgentCore Runtime and returns immediately once
 * the Runtime accepts (HTTP 200). Does NOT wait for agent completion.
 *
 * The agent is responsible for its own lifecycle:
 * - Writes streaming events (agent.streaming) directly to DynamoDB as it works
 * - Calls report_completion tool when done → workflow-output Lambda → marks ticket "done"
 * - DynamoDB Stream on ticket status change → Orchestrator cascade
 *
 * If the agent crashes without calling report_completion, recovery is the
 * dead-session detector sweep (dead-session-detector.mjs): an EventBridge
 * schedule (rate(5 minutes)) invokes the orchestrator, which lease-guards the
 * stale claim, steals it, and re-dispatches once or escalates. Rollout mode is
 * DEAD_SESSION_DETECTOR_MODE (off | shadow | enforce). The manual nudge button
 * remains for human-initiated recovery.
 *
 * Input: { harnessArn, sessionId, prompt, workflowId, agentId, ticketId, modelOverride }
 * Output: none (fire-and-forget)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { eventIdFor, normalizeEventDedupeMode } from "./event-id.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const TICKET_PROVIDER = (process.env.TICKET_PROVIDER || "dynamodb").trim().toLowerCase();
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
// Events table (FR-D4.3 liveness): the detector's lease.lastAgentActivity reads
// THIS table for agent.streaming/agent.started heartbeats to decide slow-vs-dead.
// Runtime agents write it directly (main.py); the harness path only reaches
// EventBridge, so publishAgentEvent now dual-writes here too. Same default name
// as the orchestrator's EVENTS_TABLE so both halves land in one place.
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const EVENT_BUS = process.env.EVENT_BUS || "default";
// Events-table double-write collapse (TEAM-4120 FR-2 / TEAM-4167 D3 FR-3.4):
// off | enforce, DEFAULT enforce. Same flag, same strict allow-list, as the
// orchestrator and events-writer — all three must agree for the EventBridge
// copy to overwrite the direct copy rather than double it. Instant rollback =
// set off. agent.streaming keeps random ids (RANDOM_ID_TYPES in event-id.mjs):
// its chunks share a content key and collapsing them would drop heartbeats.
const EVENT_DEDUPE_MODE = normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce");

// ─── Bounded transient-failure retry (FR-D4.2) ──────────────────────────────
// A transient Bedrock/AgentCore fault (5xx / ServiceUnavailable / Throttling /
// timeout) at the invoke boundary — including on the CD/merge step — should
// self-heal with a bounded, jittered backoff instead of parking the run for a
// human. Bounds are env-configurable with safe defaults; a hard attempt cap
// means no infinite loop (R7), and exhausting the bound re-throws the last
// error, which falls through to the handler's EXISTING escalation path
// (mark blocked + agent.error). Deterministic 4xx faults are never retried.
function clampInt(raw, dflt, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}
const INVOKE_MAX_ATTEMPTS = clampInt(process.env.AGENT_INVOKE_MAX_ATTEMPTS, 3, 1, 10);
const INVOKE_BACKOFF_BASE_MS = clampInt(process.env.AGENT_INVOKE_BACKOFF_BASE_MS, 500, 0, 60_000);
const INVOKE_BACKOFF_MAX_MS = clampInt(process.env.AGENT_INVOKE_BACKOFF_MAX_MS, 5_000, 0, 300_000);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const events = new EventBridgeClient({ region: REGION });

export const handler = async (event) => {
  const { harnessArn, sessionId, prompt, workflowId, agentId, ticketId, modelOverride, connectors, watchdog } = event;
  console.log(`[agent-invoker] Fire-and-forget: ${agentId} for workflow ${workflowId} (ticket: ${ticketId || "unknown"})`);

  try {
    // Determine invocation mode: Runtime (preferred) or Harness (legacy)
    const useRuntime = harnessArn.includes(":runtime/") || harnessArn.includes("/runtime/") || process.env.USE_RUNTIME === "true";

    if (useRuntime) {
      await withInvokeRetry(
        () => fireAndForgetRuntime(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride, ticketId, connectors, watchdog),
        `runtime invoke ${agentId}`,
        // TEAM-3756 F4: lets the retry loop prove "the first attempt already
        // started this agent" before re-sending with the same sessionId.
        { workflowId, ticketId, agentId }
      );
    } else {
      // Legacy harness agents still use synchronous invocation (to be migrated)
      const output = await withInvokeRetry(
        () => invokeHarnessAgent(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride, ticketId),
        `harness invoke ${agentId}`
      );
      // For legacy agents that don't call report_completion, write done ourselves.
      // The invocation event carries the exact ticket — the lookup is only a
      // fallback for old callers that didn't pass it.
      const doneTicketId = ticketId || await findTicketForAgent(workflowId, agentId);
      if (doneTicketId) {
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId: doneTicketId },
          UpdateExpression: "SET #s = :s, #u = :u",
          ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
          ExpressionAttributeValues: { ":s": "done", ":u": new Date().toISOString() },
        }));
      }
    }

    console.log(`[agent-invoker] ${agentId} invocation ${useRuntime ? "kicked off (fire-and-forget)" : "completed (legacy)"}`);

  } catch (err) {
    const error = err.message || String(err);
    console.error(`[agent-invoker] ${agentId} invocation failed:`, error);

    // The board write below is DDB-mode only: in Jira mode the tickets table
    // does not exist, and the ResourceNotFoundException it threw here aborted the
    // handler BEFORE agent.error was published — a failed invoke left a running
    // claim, no error event and an unparked ticket (prod 23:12Z, TEAM-3989). The
    // orchestrator parks Jira tickets itself off agent.error; this Lambda's one
    // non-negotiable duty on failure is to PUBLISH it. If the agent was accepted
    // but crashes later, the dead-session detector sweep handles it.
    let failedTicketId = ticketId;
    try {
      failedTicketId = ticketId || await findTicketForAgent(workflowId, agentId);
      if (failedTicketId && TICKET_PROVIDER !== "jira") {
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId: failedTicketId },
          UpdateExpression: "SET #s = :s, #u = :u, #e = :e",
          ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt", "#e": "error" },
          ExpressionAttributeValues: { ":s": "blocked", ":u": new Date().toISOString(), ":e": error },
        }));
      }
    } catch (boardErr) {
      console.error(`[agent-invoker] ${agentId} could not park ${failedTicketId || "(unknown ticket)"} on the board (non-fatal): ${boardErr?.message || boardErr}`);
    }

    // Publish error event so UI knows immediately
    await publishAgentEvent(workflowId, agentId, "agent.error", { error, ticketId: failedTicketId || ticketId || "" });
  }
};

// ─── AgentCore Harness Invocation ──────────────────────────────────────────────

/**
 * Invoke the AgentCore Harness agent using InvokeHarnessCommand.
 * Uses @aws-sdk/client-bedrock-agentcore (bundled with Lambda).
 * Response is an event stream: messageStart, contentBlockStart, contentBlockDelta, contentBlockStop, messageStop, metadata.
 */
async function invokeHarnessAgent(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride, ticketId) {
  const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
  const client = new BedrockAgentCoreClient({
    region: REGION,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 30_000,       // 30s to establish connection
      requestTimeout: 840_000,         // 14 min read timeout (agents can run long)
    }),
  });

  const messages = [{ role: "user", content: [{ text: prompt }] }];

  const commandInput = {
    harnessArn,
    runtimeSessionId: sessionId,
    messages,
    timeoutSeconds: 900,    // 15 min — harness default is 3600 but be explicit
    maxIterations: 50,      // Allow plenty of tool call cycles
  };

  // Per-invocation model override
  if (modelOverride) {
    if (typeof modelOverride === "object" && modelOverride.bedrockModelConfig) {
      // Already formatted by orchestrator
      commandInput.model = modelOverride;
    } else if (typeof modelOverride === "string") {
      commandInput.model = { bedrockModelConfig: { modelId: modelOverride } };
    }
  }

  const command = new InvokeHarnessCommand(commandInput);
  const response = await client.send(command);

  let fullOutput = "";

  if (response.stream) {
    for await (const event of response.stream) {
      if ("contentBlockDelta" in event) {
        const delta = event.contentBlockDelta?.delta;
        if (delta?.text) {
          fullOutput += delta.text;
          // Publish streaming event for real-time UI (non-blocking)
          await publishAgentEvent(workflowId, agentId, "agent.streaming", {
            type: "text",
            content: delta.text.slice(0, 200),
            ticketId: ticketId || "",
          }).catch(() => {});
        }
      } else if ("contentBlockStart" in event) {
        const toolUse = event.contentBlockStart?.start?.toolUse;
        if (toolUse) {
          await publishAgentEvent(workflowId, agentId, "agent.streaming", {
            type: "trace",
            toolName: toolUse.name,
            ticketId: ticketId || "",
          }).catch(() => {});
        }
      }
    }
  }

  return fullOutput;
}

// ─── AgentCore Runtime: Fire-and-Forget ──────────────────────────────────────

/**
 * Send invocation to AgentCore Runtime and return as soon as HTTP 200 is received.
 * Does NOT wait for the agent to finish. The agent manages its own lifecycle:
 * - Writes streaming events to DynamoDB
 * - Calls report_completion when done (triggers orchestrator cascade)
 * - Nudge system handles crash/hang scenarios
 */
async function fireAndForgetRuntime(runtimeArn, sessionId, prompt, workflowId, agentId, modelOverride, invokerTicketId, connectors, watchdog) {
  const https = await import("https");
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");

  const payload = JSON.stringify({
    prompt,
    workflow_id: workflowId,
    agent_id: agentId,
    ticket_id: invokerTicketId || "",
    // Nobody reads this response (we destroy the connection below), so tell the
    // runtime to detach: ack instantly, run the agent loop as a background task.
    // Without this, the idle response stream gets platform-killed at ~15 min
    // and takes the persona run with it.
    detach: true,
    model_override: modelOverride?.bedrockModelConfig?.modelId || modelOverride || undefined,
    ...(Array.isArray(connectors) && connectors.length ? { connectors } : {}),
    // Fleet-wide watchdog knobs (D1.1) — the runtime reads these payload-first
    // (main.py), falling back to env → its own legacy constants when absent.
    ...(watchdog && typeof watchdog === "object" ? { watchdog } : {}),
  });

  const runtimeId = runtimeArn.split("/").pop();
  const accountId = runtimeArn.split(":")[4];
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const urlPath = `/runtimes/${encodeURIComponent(runtimeId)}/invocations`;

  console.log(`[agent-invoker] Fire-and-forget Runtime invoke: id=${runtimeId}`);

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const request = {
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: urlPath,
    query: { accountId },
    headers: {
      "host": host,
      "content-type": "application/json",
      "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
    },
    body: payload,
  };

  const signedRequest = await signer.sign(request);

  // Send the request and resolve as soon as we get HTTP status back
  // We don't read the response body — the agent handles its own completion
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Runtime did not accept request within 30s")), 30_000);

    const fullPath = `${urlPath}?accountId=${accountId}`;
    const req = https.default.request({
      hostname: host,
      path: fullPath,
      method: "POST",
      headers: { ...signedRequest.headers },
      timeout: 30_000,
    }, (res) => {
      clearTimeout(timer);
      console.log(`[agent-invoker] ${agentId} accepted: HTTP ${res.statusCode}`);

      if (res.statusCode >= 400) {
        // Read error body for diagnostics
        let body = "";
        res.on("data", (chunk) => { body += chunk.toString(); });
        res.on("end", () => {
          const err = new Error(`Runtime rejected: ${res.statusCode} ${body.slice(0, 500)}`);
          err.statusCode = res.statusCode; // let withInvokeRetry classify 5xx-vs-4xx
          reject(err);
        });
      } else {
        // Success — agent is now running. Disconnect immediately.
        res.destroy(); // Don't hold the connection open
        resolve();
      }
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ─── AgentCore Runtime Invocation (Legacy — synchronous wait) ────────────────

/**
 * @deprecated Use fireAndForgetRuntime instead. Kept for harness-mode compatibility.
 */
async function invokeRuntimeAgent(runtimeArn, sessionId, prompt, workflowId, agentId, modelOverride) {
  const https = await import("https");
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");

  const payload = JSON.stringify({
    prompt,
    workflow_id: workflowId,
    agent_id: agentId,
    model_override: modelOverride?.bedrockModelConfig?.modelId || modelOverride || undefined,
  });

  // Extract runtime ID and account from ARN
  const runtimeId = runtimeArn.split("/").pop();
  const accountId = runtimeArn.split(":")[4];
  const host = `bedrock-agentcore.${REGION}.amazonaws.com`;
  const urlPath = `/runtimes/${encodeURIComponent(runtimeId)}/invocations`;

  console.log(`[agent-invoker] Runtime invoke: id=${runtimeId}, account=${accountId}`);

  // SigV4 sign the request — path and query must be separate for proper signing
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const request = {
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: urlPath,
    query: { accountId },
    headers: {
      "host": host,
      "content-type": "application/json",
      "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
    },
    body: payload,
  };

  const signedRequest = await signer.sign(request);

  // Make the HTTPS request with keepalive to prevent premature connection drops
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Runtime invoke timed out after 840s")), 840_000);

    const fullPath = `${urlPath}?accountId=${accountId}`;
    const req = https.default.request({
      hostname: host,
      path: fullPath,
      method: "POST",
      headers: { ...signedRequest.headers, "connection": "keep-alive" },
      timeout: 840_000,
    }, (res) => {
      // Disable socket timeout on the response — SSE streams can be idle between events
      if (res.socket) {
        res.socket.setTimeout(0);
        res.socket.setKeepAlive(true, 30_000);
      }

      console.log(`[agent-invoker] ${agentId} HTTP ${res.statusCode}, headers:`, JSON.stringify(res.headers));

      let fullOutput = "";
      let buffer = "";
      let rawChunks = [];

      res.on("data", (chunk) => {
        const text = chunk.toString();
        buffer += text;
        if (rawChunks.length < 5) rawChunks.push(text.slice(0, 500)); // Log first 5 chunks

        // Parse SSE events as they arrive
        const lines = buffer.split("\n");
        buffer = lines.pop(); // Keep incomplete last line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.event?.contentBlockDelta?.delta?.text) {
                fullOutput += event.event.contentBlockDelta.delta.text;
              }
              if (event.message?.content?.[0]?.text && !fullOutput) {
                fullOutput = event.message.content[0].text;
              }
              // Also try direct text field at top level
              if (event.text && !fullOutput) {
                fullOutput += event.text;
              }
              // Try response.output format
              if (event.response?.output?.message?.content?.[0]?.text && !fullOutput) {
                fullOutput = event.response.output.message.content[0].text;
              }
              if (event.event?.contentBlockStart?.start?.toolUse) {
                publishAgentEvent(workflowId, agentId, "agent.streaming", {
                  type: "trace",
                  toolName: event.event.contentBlockStart.start.toolUse.name,
                }).catch(() => {});
              }
            } catch { /* non-JSON */ }
          }
          // Also try non-SSE: raw JSON response body
          else if (line.trim().startsWith("{")) {
            try {
              const obj = JSON.parse(line.trim());
              if (obj.message?.content?.[0]?.text) {
                fullOutput = obj.message.content[0].text;
              }
              if (obj.output?.message?.content?.[0]?.text) {
                fullOutput = obj.output.message.content[0].text;
              }
              if (obj.text) fullOutput = obj.text;
            } catch { /* not JSON */ }
          }
        }
      });

      res.on("end", () => {
        clearTimeout(timer);
        // Try to parse any remaining buffer as JSON
        if (!fullOutput && buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim());
            if (obj.message?.content?.[0]?.text) fullOutput = obj.message.content[0].text;
            if (obj.output?.message?.content?.[0]?.text) fullOutput = obj.output.message.content[0].text;
            if (obj.text) fullOutput = obj.text;
          } catch { /* not JSON */ }
        }
        console.log(`[agent-invoker] ${agentId} response end. Output length: ${fullOutput.length}, raw chunks: ${rawChunks.length}, first chunk:`, rawChunks[0]?.slice(0, 300));
        if (res.statusCode >= 400) {
          const err = new Error(`Runtime returned ${res.statusCode}: ${fullOutput || buffer}`);
          err.statusCode = res.statusCode; // let withInvokeRetry classify 5xx-vs-4xx
          reject(err);
        } else {
          resolve(fullOutput || "[Agent completed but produced no text output]");
        }
      });

      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Set socket-level keepalive as soon as socket is assigned
    req.on("socket", (socket) => {
      socket.setKeepAlive(true, 30_000);
      socket.setTimeout(840_000);
      socket.on("timeout", () => {
        req.destroy(new Error("Socket timeout after 840s"));
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function findTicketForAgent(workflowId, agentId) {
  // agentTasks is keyed by TICKET id. Prefer this agent's ACTIVE entry —
  // under fix-ticket fan-out one agent holds several entries and "any entry"
  // cross-wires the wrong ticket.
  const wf = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }));
  const candidates = Object.values(wf.Item?.agentTasks || {})
    .filter((t) => t.agentId === agentId && t.ticketId)
    .sort((a, b) => {
      const active = (t) => (t.status === "running" || t.status === "in_progress" ? 0 : 1);
      if (active(a) !== active(b)) return active(a) - active(b);
      return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
    });
  if (candidates[0]?.ticketId) return candidates[0].ticketId;

  // Fallback: scan tickets table for this agent's assigned in-progress ticket.
  const epicId = wf.Item?.epicId;
  if (epicId) {
    const result = await ddb.send(new QueryCommand({
      TableName: TICKETS_TABLE,
      IndexName: "parentId-index",
      KeyConditionExpression: "parentId = :pid",
      FilterExpression: "assignee = :agent AND #s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":pid": epicId, ":agent": agentId, ":status": "in_progress" },
    }));
    if (result.Items?.length > 0) {
      return result.Items[0].ticketId;
    }
  }
  return null;
}


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The HTTP status an invoke error carries, across every shape the three invoke
 * paths produce: a `.statusCode` we attach on the raw-HTTPS paths, the SDK's
 * `$metadata.httpStatusCode`, or the leading 3-digit code in a hand-thrown
 * message ("Runtime rejected: 503 ...", "Runtime returned 400: ..."). The first
 * 3-digit run is the status the paths prefix, never a code buried in a body.
 */
function invokeErrorStatus(err) {
  if (Number.isFinite(err?.statusCode)) return err.statusCode;
  const meta = err?.$metadata?.httpStatusCode;
  if (Number.isFinite(meta)) return meta;
  const m = /\b(\d{3})\b/.exec(err?.message || "");
  return m ? Number(m[1]) : undefined;
}

// Server-side / transient error names the SDK and runtime surface. Distinct from
// 4xx client faults, which are deterministic and must NOT be retried.
const RETRIABLE_ERROR_NAMES = new Set([
  "ThrottlingException", "TooManyRequestsException",
  "ServiceUnavailableException", "ServiceUnavailable",
  "InternalServerException", "InternalFailure", "InternalServerError",
  "ModelNotReadyException", "ModelTimeoutException",
  "RequestTimeout", "RequestTimeoutException", "TimeoutError",
]);
// Transient low-level socket errors (connection reset mid-flight, DNS blip).
const RETRIABLE_ERROR_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE",
]);

/**
 * Retriable = transient / server-side: 5xx, 429, throttling, service-
 * unavailable, timeouts, and transient socket errors. NOT retriable =
 * deterministic client faults: 4xx validation/auth (400/401/403/404/409/422)
 * fail identically on every attempt, so retrying only burns time before the
 * same escalation. Unknown/unclassifiable → NOT retriable (fail toward the
 * existing escalation rather than looping on a fault we don't understand).
 */
function isRetriableInvokeError(err) {
  if (!err) return false;
  if (RETRIABLE_ERROR_NAMES.has(err.name || "")) return true;
  if (RETRIABLE_ERROR_CODES.has(err.code || "")) return true;
  const status = invokeErrorStatus(err);
  if (Number.isFinite(status)) {
    if (status === 429 || status >= 500) return true;
    if (status >= 400) return false; // other 4xx: deterministic, don't retry
  }
  // Message-level fallback for the raw-HTTPS paths' hand-thrown timeouts
  // ("did not accept request within 30s", "invoke timed out after 840s").
  return /timed out|timeout|did not accept|socket hang up/i.test(err.message || "");
}

// ─── No-duplicate-session guard on retry (TEAM-3756 F4, R7 / FR-D4.4) ────────
//
// INVARIANT: a retry must never start a SECOND agent session for the same
// (ticket, sessionId). The failures below are exactly the ones where the FIRST
// request may already have been ACCEPTED — the body was written and then the
// connection died or the acceptance ack never arrived — so blindly re-sending
// re-invokes an agent that may already be running. A blind retry is safe only
// when we can PROVE the runtime never accepted: an HTTP response of any status
// is that proof (invokeErrorStatus finite → the runtime answered → rejected).

// Socket errors that can fire AFTER the request body was written.
const POST_WRITE_AMBIGUOUS_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);
// SDK timeout names: the request may be sitting accepted behind a slow ack.
const POST_WRITE_AMBIGUOUS_NAMES = new Set([
  "ModelTimeoutException", "RequestTimeout", "RequestTimeoutException", "TimeoutError",
]);

/**
 * True when the error leaves it UNKNOWABLE whether the runtime accepted the
 * first request (and so may already have started the agent). Any error carrying
 * an HTTP status is NOT ambiguous — a response means the request was rejected,
 * not accepted — which keeps the common throttle/5xx retry blind and cheap.
 */
function mayHaveStartedError(err) {
  if (!err) return false;
  if (Number.isFinite(invokeErrorStatus(err))) return false;
  if (POST_WRITE_AMBIGUOUS_CODES.has(err.code || "")) return true;
  if (POST_WRITE_AMBIGUOUS_NAMES.has(err.name || "")) return true;
  return /timed out|timeout|did not accept|socket hang up/i.test(err.message || "");
}

// The agent's own startup heartbeats land within seconds; the slack absorbs
// clock skew between this Lambda and the runtime's event timestamps.
const LIVENESS_CLOCK_SLACK_MS = 5_000;

// TEAM-3764 F3 — the liveness re-check pages through the workflow's events
// instead of trusting one newest-first page: a busy run (parallel design fan-out,
// streaming events) can hold >50 rows NEWER than the heartbeat, and a guard that
// stops at page one would read a running session as "not started" and duplicate
// it on retry (FR-D4.4 / R1). Paging is bounded two ways: by the time horizon
// (newest-first — once a page bottoms out below `sinceMs`, no later page can
// hold a fresh heartbeat: provably NOT started) and by a hard page cap, past
// which the answer is UNKNOWABLE (null → caller refuses the retry, fail-safe).
const LIVENESS_QUERY_PAGE_LIMIT = 50;
const LIVENESS_QUERY_MAX_PAGES = 6;

/**
 * Did an agent session for this (workflow, ticket) demonstrably START since
 * `sinceMs`? Reads the same heartbeat rows the dead-session detector's
 * lease.lastAgentActivity reads (agent.started / agent.streaming in
 * EVENTS_TABLE — runtime agents write them directly from main.py).
 *
 * Returns true / false / null(unknown: ids missing, the query failed, or the
 * page bound ran out before the scan reached the time window).
 * Callers must treat null as "assume it started": the cost of a wrong "not
 * started" is a duplicate session (R7 violation, unrecoverable), while the cost
 * of a wrong "started" is one stalled claim the dead-session detector already
 * exists to recover.
 */
async function agentStartedSince(liveness, sinceMs) {
  if (!liveness?.workflowId || !(liveness.ticketId || liveness.agentId)) return null;
  try {
    let lastKey;
    for (let page = 0; page < LIVENESS_QUERY_MAX_PAGES; page++) {
      const res = await ddb.send(new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: "workflowId = :w",
        ExpressionAttributeValues: { ":w": liveness.workflowId },
        ScanIndexForward: false, // newest first — startup events are the newest
        Limit: LIVENESS_QUERY_PAGE_LIMIT,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      let pageOldestMs = Infinity;
      for (const e of res.Items || []) {
        const d = e.detail || {};
        const t = Date.parse(e.timestamp || d.timestamp || "");
        if (Number.isFinite(t) && t < pageOldestMs) pageOldestMs = t;
        if (e.type !== "agent.started" && e.type !== "agent.streaming") continue;
        // Ticket-scoped match preferred; an event carrying no ticketId still
        // counts when it is unambiguously this agent's (same agentId).
        const matches = liveness.ticketId && d.ticketId
          ? d.ticketId === liveness.ticketId
          : !!liveness.agentId && d.agentId === liveness.agentId;
        if (!matches) continue;
        if (Number.isFinite(t) && t >= sinceMs) return true;
      }
      // Time horizon crossed: everything on later pages is older still, so a
      // fresh heartbeat provably does not exist. The extra slack keeps a
      // slightly-disordered page boundary from flipping this to a false "not
      // started" (the unrecoverable direction).
      if (pageOldestMs < sinceMs - LIVENESS_CLOCK_SLACK_MS) return false;
      lastKey = res.LastEvaluatedKey;
      if (!lastKey) return false; // table exhausted inside the window — no heartbeat
    }
    console.warn(
      `[agent-invoker] liveness re-check exhausted ${LIVENESS_QUERY_MAX_PAGES} pages ` +
        `without reaching the time window — treating as maybe-started`
    );
    return null;
  } catch (err) {
    console.warn(`[agent-invoker] liveness re-check failed (${err?.message || err}) — treating as maybe-started`);
    return null;
  }
}

/**
 * Run `fn` with bounded retry on transient invoke failures. Jittered exponential
 * backoff (full-jitter over the lower half of the window); a non-retriable error
 * or the final attempt re-throws immediately so the caller's escalation path runs.
 *
 * TEAM-3756 F4: an error on which the first request MAY already have been
 * accepted (mayHaveStartedError) is retried only under the no-duplicate guard:
 *  - `liveness` wired (the fire-and-forget runtime path): re-check the events
 *    table first. Demonstrably started → return WITHOUT retrying (the first
 *    attempt succeeded; the connection just died after acceptance). Provably
 *    not started → retry. Unknown → re-throw: the dead-session detector
 *    recovers a genuinely-lost claim, whereas a duplicate session cannot be
 *    recalled.
 *  - `liveness` NOT wired (the legacy synchronous harness path, where "started"
 *    is not "finished" so an early success-return would be wrong): NON-retriable,
 *    re-throw immediately. Only provably-rejected failures (an HTTP response:
 *    5xx/429/throttle) stay blindly retried there.
 */
async function withInvokeRetry(fn, label, liveness = null) {
  const invokeStartMs = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retriable = isRetriableInvokeError(err);
      if (!retriable || attempt >= INVOKE_MAX_ATTEMPTS) {
        if (retriable) {
          console.error(`[agent-invoker] ${label} exhausted ${attempt} transient attempts — escalating: ${err?.message || err}`);
        }
        throw err;
      }
      if (mayHaveStartedError(err)) {
        if (!liveness) {
          console.error(`[agent-invoker] ${label} failed post-write with no liveness view — NOT retrying (no-duplicate-session, R7): ${err?.message || err}`);
          throw err;
        }
        const started = await agentStartedSince(liveness, invokeStartMs - LIVENESS_CLOCK_SLACK_MS);
        if (started === true) {
          console.log(`[agent-invoker] ${label}: first attempt demonstrably started (heartbeat observed) — skipping retry.`);
          return undefined;
        }
        if (started === null) {
          console.error(`[agent-invoker] ${label} failed post-write and liveness is unknowable — NOT retrying (no-duplicate-session, R7): ${err?.message || err}`);
          throw err;
        }
        // started === false: no heartbeat → the first attempt provably never
        // ran; re-sending cannot duplicate anything.
      }
      const window = Math.min(INVOKE_BACKOFF_MAX_MS, INVOKE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const half = Math.floor(window / 2);
      const jittered = half + Math.floor(Math.random() * (half + 1));
      console.warn(`[agent-invoker] ${label} transient failure (attempt ${attempt}/${INVOKE_MAX_ATTEMPTS}), retrying in ${jittered}ms: ${err?.message || err}`);
      await sleep(jittered);
    }
  }
}

async function publishAgentEvent(workflowId, agentId, detailType, detail) {
  const timestamp = new Date().toISOString();
  const stamped = { workflowId, agentId, ...detail, timestamp };
  // EventBridge: real-time UI stream + anomaly consumers.
  try {
    await events.send(new PutEventsCommand({
      Entries: [{
        Source: "agentcore-hub.agent-invoker",
        DetailType: detailType,
        Detail: JSON.stringify(stamped),
        EventBusName: EVENT_BUS,
      }],
    }));
  } catch { /* non-fatal */ }
  // Events table (FR-D4.3): the detector's lease.lastAgentActivity queries THIS
  // table for heartbeats (agent.streaming/agent.started). Without this write a
  // harness agent's mid-turn streaming never reaches the liveness view, so a
  // slow-but-alive session could be misread as dead. detail.ticketId (threaded
  // by callers) lets lastAgentActivity scope to the right claim. Same item shape
  // as the orchestrator's publishEvent so both producers coexist in one table.
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        workflowId: workflowId || agentId,
        eventId: eventIdFor(EVENT_DEDUPE_MODE, detailType, stamped, () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        type: detailType,
        detail: stamped,
        timestamp,
      },
    }));
  } catch { /* non-fatal */ }
}
