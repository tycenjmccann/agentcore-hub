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
 * If the agent crashes without calling report_completion, the existing nudge system
 * detects 90s idle and triggers recovery.
 *
 * Input: { harnessArn, sessionId, prompt, workflowId, agentId, modelOverride }
 * Output: none (fire-and-forget)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENT_BUS = process.env.EVENT_BUS || "default";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const events = new EventBridgeClient({ region: REGION });

export const handler = async (event) => {
  const { harnessArn, sessionId, prompt, workflowId, agentId, ticketId, modelOverride } = event;
  console.log(`[agent-invoker] Fire-and-forget: ${agentId} for workflow ${workflowId} (ticket: ${ticketId || "unknown"})`);

  try {
    // Determine invocation mode: Runtime (preferred) or Harness (legacy)
    const useRuntime = harnessArn.includes(":runtime/") || harnessArn.includes("/runtime/") || process.env.USE_RUNTIME === "true";

    if (useRuntime) {
      await fireAndForgetRuntime(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride, ticketId);
    } else {
      // Legacy harness agents still use synchronous invocation (to be migrated)
      const output = await invokeHarnessAgent(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride);
      // For legacy agents that don't call report_completion, write done ourselves
      const ticketId = await findTicketForAgent(workflowId, agentId);
      if (ticketId) {
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId },
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

    // Only mark blocked if the Runtime REJECTED the request (connection refused, 4xx, etc.)
    // If the agent was accepted but crashes later, nudge handles it.
    const ticketId = await findTicketForAgent(workflowId, agentId);
    if (ticketId) {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u, #e = :e",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt", "#e": "error" },
        ExpressionAttributeValues: { ":s": "blocked", ":u": new Date().toISOString(), ":e": error },
      }));
    }

    // Publish error event so UI knows immediately
    await publishAgentEvent(workflowId, agentId, "agent.error", { error });
  }
};

// ─── AgentCore Harness Invocation ──────────────────────────────────────────────

/**
 * Invoke the AgentCore Harness agent using InvokeHarnessCommand.
 * Uses @aws-sdk/client-bedrock-agentcore (bundled with Lambda).
 * Response is an event stream: messageStart, contentBlockStart, contentBlockDelta, contentBlockStop, messageStop, metadata.
 */
async function invokeHarnessAgent(harnessArn, sessionId, prompt, workflowId, agentId, modelOverride) {
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
          }).catch(() => {});
        }
      } else if ("contentBlockStart" in event) {
        const toolUse = event.contentBlockStart?.start?.toolUse;
        if (toolUse) {
          await publishAgentEvent(workflowId, agentId, "agent.streaming", {
            type: "trace",
            toolName: toolUse.name,
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
async function fireAndForgetRuntime(runtimeArn, sessionId, prompt, workflowId, agentId, modelOverride, invokerTicketId) {
  const https = await import("https");
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");

  const payload = JSON.stringify({
    prompt,
    workflow_id: workflowId,
    agent_id: agentId,
    ticket_id: invokerTicketId || "",
    model_override: modelOverride?.bedrockModelConfig?.modelId || modelOverride || undefined,
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
        res.on("end", () => reject(new Error(`Runtime rejected: ${res.statusCode} ${body.slice(0, 500)}`)));
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
          reject(new Error(`Runtime returned ${res.statusCode}: ${fullOutput || buffer}`));
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
  // Look up workflow to find the ticket ID
  const wf = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }));
  const task = wf.Item?.agentTasks?.[agentId];
  if (task?.ticketId) return task.ticketId;

  // Fallback: scan tickets table for this agent's assigned ticket (race condition workaround)
  // The orchestrator may have written the ticketId but a concurrent updateWorkflowTask overwrote it
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


async function publishAgentEvent(workflowId, agentId, detailType, detail) {
  try {
    await events.send(new PutEventsCommand({
      Entries: [{
        Source: "agentcore-hub.agent-invoker",
        DetailType: detailType,
        Detail: JSON.stringify({ workflowId, agentId, ...detail, timestamp: new Date().toISOString() }),
        EventBusName: EVENT_BUS,
      }],
    }));
  } catch { /* non-fatal */ }
}
