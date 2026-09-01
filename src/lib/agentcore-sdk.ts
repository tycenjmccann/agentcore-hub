// Server-side AgentCore SDK client
// Dynamic discovery via Control Plane + invocation via Data Plane
// Region is passed per-request — no shared mutable state.

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  SearchRegistryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
  ListAgentRuntimesCommand,
  ListMemoriesCommand,
  GetHarnessCommand,
  GetAgentRuntimeCommand,
  CreateRegistryCommand,
  GetRegistryCommand,
  ListRegistriesCommand,
  UpdateRegistryCommand,
  DeleteRegistryCommand,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  UpdateRegistryRecordCommand,
  DeleteRegistryRecordCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { resolveWatchdog } from "./workflow/watchdog";

export const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

// SSE keep-alive cadence for long harness tool loops. Well under the ~120s
// idle window App Runner and typical proxies enforce, so a silent "researching"
// turn never trips the connection. Resolved from the fleet-wide watchdog config
// (TEAM-3618 D1.1); the legacy 15_000 is the fallback baked into resolveWatchdog,
// so an agents.json without a watchdog block keeps today's exact cadence.
const HARNESS_HEARTBEAT_MS = resolveWatchdog().heartbeatIntervalMs;

// Per-region client cache (avoids recreating clients on every call)
const bedrockClients = new Map<string, BedrockRuntimeClient>();
const agentCoreClients = new Map<string, BedrockAgentCoreClient>();
const controlClients = new Map<string, BedrockAgentCoreControlClient>();
const logsClients = new Map<string, CloudWatchLogsClient>();

// In-memory store — not shared across ECS tasks or durable across restarts. Swap with DynamoDB/Redis for production persistence.
// Seed from existing JSON files on disk if present (backwards compat with pre-in-memory deployments).
const memoryMappings = new Map<string, string>();
const payloadFormats = new Map<string, string>();

// Seed maps from disk at module load time (sync, runs once on cold start)
(function seedFromDisk() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const mmPath = path.join(process.cwd(), ".memory-mappings.json");
    if (fs.existsSync(mmPath)) {
      const data = JSON.parse(fs.readFileSync(mmPath, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        memoryMappings.set(k, v as string);
      }
    }
    const pfPath = path.join(process.cwd(), ".payload-formats.json");
    if (fs.existsSync(pfPath)) {
      const data = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
      for (const [k, v] of Object.entries(data)) {
        payloadFormats.set(k, v as string);
      }
    }
  } catch {
    // File not found or read-only filesystem — start with empty maps
  }
})();

export function setMemoryMapping(agentId: string, memoryId: string) {
  memoryMappings.set(agentId, memoryId);
}

export function removeMemoryMapping(agentId: string) {
  memoryMappings.delete(agentId);
}

export function getMemoryMapping(agentId: string): string | null {
  return memoryMappings.get(agentId) || null;
}

export function getAllMemoryMappings(): Record<string, string> {
  return Object.fromEntries(memoryMappings);
}

export function setPayloadFormat(agentId: string, format: string) {
  payloadFormats.set(agentId, format);
}

export function getPayloadFormat(agentId: string): string | null {
  return payloadFormats.get(agentId) || null;
}

export function getAllPayloadFormats(): Record<string, string> {
  return Object.fromEntries(payloadFormats);
}

function getBedrockClient(region: string): BedrockRuntimeClient {
  let client = bedrockClients.get(region);
  if (!client) {
    client = new BedrockRuntimeClient({ region });
    bedrockClients.set(region, client);
  }
  return client;
}

function getAgentCoreClient(region: string): BedrockAgentCoreClient {
  let client = agentCoreClients.get(region);
  if (!client) {
    client = new BedrockAgentCoreClient({ region });
    agentCoreClients.set(region, client);
  }
  return client;
}

function getControlClient(region: string): BedrockAgentCoreControlClient {
  let client = controlClients.get(region);
  if (!client) {
    client = new BedrockAgentCoreControlClient({ region });
    controlClients.set(region, client);
  }
  return client;
}

export function getLogsClient(region: string): CloudWatchLogsClient {
  let client = logsClients.get(region);
  if (!client) {
    client = new CloudWatchLogsClient({ region });
    logsClients.set(region, client);
  }
  return client;
}

// ─── Agent Discovery ───────────────────────────────────────────────────────────

export interface DiscoveredAgent {
  id: string;
  name: string;
  arn: string;
  type: "harness" | "runtime";
  status: string;
  createdAt?: string;
  updatedAt?: string;
  // Enriched data (populated by getAgentDetail)
  memoryId?: string;
  logGroup?: string;
  model?: string;
  description?: string;
  systemPrompt?: string;
  tools?: Array<{ type: string; name?: string }>;
}

export interface DiscoveredMemory {
  id: string;
  arn?: string;
  status: string;
}

// Per-region cache with TTL
const agentCaches = new Map<string, { data: DiscoveredAgent[]; ts: number }>();
const memoryCaches = new Map<string, { data: DiscoveredMemory[]; ts: number }>();
const logGroupCaches = new Map<string, { data: string[]; ts: number }>();
const CACHE_TTL = 60_000; // 60 seconds

/**
 * Discover all agents (harnesses + runtimes) in the account.
 */
export async function discoverAgents(region: string = DEFAULT_REGION): Promise<DiscoveredAgent[]> {
  const cached = agentCaches.get(region);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const client = getControlClient(region);
  const agents: DiscoveredAgent[] = [];

  // List harnesses
  try {
    const harnessRes = await client.send(new ListHarnessesCommand({ maxResults: 100 }));
    for (const h of harnessRes.harnesses || []) {
      agents.push({
        id: h.harnessId!,
        name: h.harnessName || h.harnessId!,
        arn: h.arn!,
        type: "harness",
        status: h.status || "UNKNOWN",
        createdAt: h.createdAt?.toISOString(),
        updatedAt: h.updatedAt?.toISOString(),
      });
    }
  } catch (err) {
    console.error("Failed to list harnesses:", err);
  }

  // List runtimes (filter out harness-backing runtimes — those are implementation details)
  const harnessNames = new Set(agents.map((a) => a.name));
  try {
    const runtimeRes = await client.send(new ListAgentRuntimesCommand({ maxResults: 100 }));
    for (const r of runtimeRes.agentRuntimes || []) {
      const name = r.agentRuntimeName || r.agentRuntimeId!;
      // Skip runtimes that are backing endpoints for harnesses (pattern: "harness_<harnessName>")
      if (name.startsWith("harness_") && harnessNames.has(name.replace("harness_", ""))) {
        continue;
      }
      agents.push({
        id: r.agentRuntimeId!,
        name,
        arn: r.agentRuntimeArn!,
        type: "runtime",
        status: r.status || "UNKNOWN",
        updatedAt: r.lastUpdatedAt?.toISOString(),
      });
    }
  } catch (err) {
    console.error("Failed to list runtimes:", err);
  }

  agentCaches.set(region, { data: agents, ts: Date.now() });
  return agents;
}

/**
 * Get detailed info for a specific harness agent (model, tools, system prompt).
 */
export async function getHarnessDetail(harnessId: string, region: string = DEFAULT_REGION): Promise<Partial<DiscoveredAgent>> {
  try {
    const client = getControlClient(region);
    const res = await client.send(new GetHarnessCommand({ harnessId }));
    const h = res.harness;
    if (!h) return {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = h.model as any;
    const modelId = model?.bedrockModelConfig?.modelId || model?.openAiModelConfig?.modelId || model?.geminiModelConfig?.modelId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const systemPrompt = (h.systemPrompt as any[])?.map((b: any) => b.text).filter(Boolean).join("\n") || undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (h.tools as any[])?.map((t: any) => ({
      type: t.type || "unknown",
      name: t.remoteMcp?.url || t.inlineFunction?.name || t.type,
    })) || [];

    // Extract a short description from system prompt (first sentence or first 120 chars)
    let description: string | undefined;
    if (systemPrompt) {
      const firstSentence = systemPrompt.match(/^[^.!?\n]+[.!?]?/)?.[0] || "";
      description = firstSentence.length > 120 ? firstSentence.slice(0, 117) + "..." : firstSentence;
    }

    // Extract memory ID from harness config (the API returns the ARN directly)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memoryConfig = (h as any).memory?.agentCoreMemoryConfiguration;
    let memoryId: string | null = null;
    if (memoryConfig?.arn) {
      // ARN format: arn:aws:bedrock-agentcore:region:account:memory/MEMORY_ID
      const arnParts = memoryConfig.arn.split("/");
      memoryId = arnParts[arnParts.length - 1] || null;
    }

    return { model: modelId, systemPrompt, tools, description, memoryId: memoryId || undefined };
  } catch (err) {
    console.error("Failed to get harness detail:", err);
    return {};
  }
}

/**
 * Get runtime detail — extracts memory ID from env vars or runtime config.
 */
export async function getRuntimeDetail(runtimeId: string, region: string = DEFAULT_REGION): Promise<Partial<DiscoveredAgent>> {
  try {
    const client = getControlClient(region);
    const res = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = res as any;

    // Check environment variables for memory ARN/ID references
    const envVars = rt.environmentVariables || {};
    let memoryId: string | null = null;

    // Common env var names that agents use for memory config
    const memoryEnvKeys = ["BEDROCK_AGENTCORE_MEMORY_ID", "MEMORY_ID", "AGENTCORE_MEMORY_ID", "MEMORY_ARN", "AGENT_MEMORY_ID", "MEMORY_RESOURCE_ID"];
    for (const key of memoryEnvKeys) {
      if (envVars[key]) {
        const val = envVars[key];
        // If it's an ARN, extract the ID
        if (val.includes("memory/")) {
          memoryId = val.split("memory/")[1] || null;
        } else {
          memoryId = val;
        }
        break;
      }
    }

    // Also check all env vars for anything containing a memory ARN pattern
    if (!memoryId) {
      for (const val of Object.values(envVars)) {
        if (typeof val === "string" && val.includes(":memory/")) {
          memoryId = val.split("memory/")[1] || null;
          break;
        }
      }
    }

    return {
      description: rt.description || undefined,
      memoryId: memoryId || undefined,
    };
  } catch (err) {
    console.error("Failed to get runtime detail:", err);
    return {};
  }
}

/**
 * Discover all memory resources in the account.
 */
export async function discoverMemories(region: string = DEFAULT_REGION): Promise<DiscoveredMemory[]> {
  const cached = memoryCaches.get(region);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const client = getControlClient(region);
    const res = await client.send(new ListMemoriesCommand({ maxResults: 100 }));
    const memories = (res.memories || []).map((m) => ({
      id: m.id || "",
      arn: m.arn,
      status: m.status || "UNKNOWN",
    }));
    memoryCaches.set(region, { data: memories, ts: Date.now() });
    return memories;
  } catch (err) {
    console.error("Failed to list memories:", err);
    return [];
  }
}

/**
 * Find the memory ID associated with an agent by naming convention.
 * Convention: memory ID contains agent name or ID substring.
 */
export async function findMemoryForAgent(agentId: string, region: string = DEFAULT_REGION): Promise<string | null> {
  // Strategy 1: User-defined mapping (fastest, persisted to disk)
  const mapped = getMemoryMapping(agentId);
  if (mapped) return mapped;

  // Strategy 2: Pull memory ID from agent config (harness memory field, runtime env vars)
  const agents = await discoverAgents(region);
  const agent = agents.find((a) => a.id === agentId);

  if (agent?.type === "harness") {
    const detail = await getHarnessDetail(agentId, region);
    if (detail.memoryId) return detail.memoryId;
  }

  if (agent?.type === "runtime") {
    const runtimeDetail = await getRuntimeDetail(agentId, region);
    if (runtimeDetail.memoryId) return runtimeDetail.memoryId;
  }

  if (agent?.memoryId) return agent.memoryId;

  // Strategy 3: Name-based matching — convention is {agentName}_mem-{suffix}
  const memories = await discoverMemories(region);
  if (memories.length === 0) return null;

  // 3a: Precise prefix match using agentId base name (strips trailing -randomSuffix)
  const agentIdBase = agentId.replace(/-[^-]+$/, "");
  for (const mem of memories) {
    if (mem.id.startsWith(`${agentIdBase}_mem`)) return mem.id;
  }

  // 3b: Prefix match using agent display name
  const agentName = agent?.name || agentId;
  const baseName = agentName.replace(/-[A-Za-z0-9]{6,}$/, "");
  for (const mem of memories) {
    if (mem.id.startsWith(`${baseName}_mem`)) return mem.id;
  }

  // 3c: Loose substring fallback
  for (const mem of memories) {
    if (mem.id.toLowerCase().includes(baseName.toLowerCase())) return mem.id;
  }

  return null;
}

/**
 * Discover CloudWatch log groups for AgentCore runtimes.
 */
export async function discoverLogGroups(region: string = DEFAULT_REGION): Promise<string[]> {
  const cached = logGroupCaches.get(region);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const client = getLogsClient(region);
    const res = await client.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: "/aws/bedrock-agentcore/runtimes/",
        limit: 50,
      })
    );
    const groups = (res.logGroups || []).map((g) => g.logGroupName!).filter(Boolean);
    logGroupCaches.set(region, { data: groups, ts: Date.now() });
    return groups;
  } catch (err) {
    console.error("Failed to discover log groups:", err);
    return [];
  }
}

/**
 * Find the log group for an agent by matching its name/ID in the log group path.
 */
export async function findLogGroupForAgent(agentId: string, agentName?: string, region: string = DEFAULT_REGION): Promise<string | null> {
  const groups = await discoverLogGroups(region);
  if (groups.length === 0) return null;

  // Get agent name from discovery cache if not provided
  let name = agentName;
  if (!name) {
    const agents = await discoverAgents(region);
    const agent = agents.find((a) => a.id === agentId);
    name = agent?.name;
  }

  const baseName = (name || agentId).replace(/-[A-Za-z0-9]{6,}$/, "");

  // Strategy 0: Exact match — log group contains the full agent ID (with suffix)
  for (const group of groups) {
    if (group.includes(agentId)) return group;
  }

  // Strategy 1: Log group contains the full agent base name
  // Prefer groups with more stored data (more likely to be the active one)
  const baseMatches = groups.filter((g) => g.toLowerCase().includes(baseName.toLowerCase()));
  if (baseMatches.length === 1) return baseMatches[0];
  if (baseMatches.length > 1) {
    // If multiple matches, prefer the one with the agent ID suffix or return last (often most recent)
    return baseMatches[baseMatches.length - 1];
  }

  // Strategy 2: Significant name parts (> 5 chars, non-generic)
  const genericWords = new Set(["agent", "runtime", "harness", "default", "service"]);
  const significantParts = baseName
    .split(/[-_]/)
    .filter((p) => p.length > 5 && !genericWords.has(p.toLowerCase()));

  for (const group of groups) {
    for (const part of significantParts) {
      if (group.toLowerCase().includes(part.toLowerCase())) return group;
    }
  }

  return null;
}

// ─── Agent Invocation ──────────────────────────────────────────────────────────

/**
 * Stream a builder agent chat using Bedrock Converse API.
 */
// Tool definition for the builder agent to output structured configs
const SAVE_CONFIG_TOOL = {
  toolSpec: {
    name: "save_agent_config",
    description: "Save the finalized agent configuration. Call this tool whenever you have a complete agent configuration ready for the user to deploy. This populates the Deploy panel in the UI.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Snake_case agent name matching [a-zA-Z][a-zA-Z0-9_]{0,47}" },
          model_id: { type: "string", description: "Bedrock model ID (e.g. global.anthropic.claude-sonnet-4-5-20250929-v1:0)" },
          system_prompt: { type: "string", description: "The full system prompt for the agent" },
          tools: { type: "array", items: { type: "string" }, description: "List of tool names available to the agent" },
          gateway_id: { type: "string", description: "Gateway ID for tool access" },
          memory_arn: { type: "string", description: "Optional memory ARN" },
          execution_role_arn: { type: "string", description: "Optional execution role ARN" },
        },
        required: ["agent_name", "system_prompt"],
      },
    },
  },
};

/**
 * Invoke a deployed AgentCore Runtime agent (non-harness).
 */
/**
 * Supported runtime payload formats.
 * Agents can declare their format, or we'll try the most common ones.
 */
export type PayloadFormat = "prompt" | "messages" | "input_text" | "query" | "custom";

const PAYLOAD_BUILDERS: Record<string, (prompt: string, sessionId: string) => object> = {
  // Most common: simple prompt field
  prompt: (prompt) => ({ prompt }),
  // Converse-style messages array
  messages: (prompt) => ({ messages: [{ role: "user", content: [{ text: prompt }] }] }),
  // Simple input.text pattern
  input_text: (prompt) => ({ input: { text: prompt } }),
  // Query pattern (RAG agents)
  query: (prompt) => ({ query: prompt }),
};

/**
 * Build the invoke payload for a runtime agent.
 * If format is specified, use it directly. Otherwise default to "prompt".
 * The "custom" format passes the prompt as-is (for agents that expect raw JSON input from the user).
 */
function buildRuntimePayload(prompt: string, sessionId: string, format?: PayloadFormat | string): string {
  if (format === "custom") {
    // User is expected to send valid JSON as the prompt
    try { JSON.parse(prompt); return prompt; } catch { /* fall through to prompt format */ }
  }
  // Auto-detect: if prompt is already valid JSON and no explicit format, send as-is
  if (!format) {
    try { JSON.parse(prompt); return prompt; } catch { /* not JSON, use default builder */ }
  }
  const builder = PAYLOAD_BUILDERS[format || "prompt"] || PAYLOAD_BUILDERS.prompt;
  return JSON.stringify(builder(prompt, sessionId));
}

export async function invokeAgentRuntime(params: {
  agentRuntimeArn: string;
  prompt: string;
  sessionId: string;
  payloadFormat?: PayloadFormat | string;
  region?: string;
}): Promise<ReadableStream> {
  const region = params.region || DEFAULT_REGION;
  const client = getAgentCoreClient(region);
  const encoder = new TextEncoder();

  const payload = buildRuntimePayload(params.prompt, params.sessionId, params.payloadFormat);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: params.agentRuntimeArn,
    runtimeSessionId: params.sessionId,
    payload: new TextEncoder().encode(payload),
    contentType: "application/json",
    accept: "application/json",
  });

  const invokeStart = Date.now();

  // Emit trace: invocation started
  const traceStart = JSON.stringify({
    type: "trace",
    event: "agent_invoke",
    name: "Agent invocation started",
    timestamp: new Date().toISOString(),
  });

  const response = await client.send(command);

  const latencyMs = Date.now() - invokeStart;

  // Heartbeat state lives in the enclosing scope so both start() and cancel()
  // can touch it. (If declared inside start(), a bare `closed` in cancel() would
  // resolve to the DOM global `Window.closed` — tsc passes, but at runtime in
  // Node ESM the assignment throws and the interval never clears.)
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream({
    async start(controller) {
      // Emit start trace
      controller.enqueue(encoder.encode(`data: ${traceStart}\n\n`));

      // This path buffers the whole runtime response (transformToString) before
      // emitting anything, so a long agent turn sends zero bytes for minutes.
      // Keep the connection alive with SSE comment heartbeats so App Runner /
      // proxies don't drop it. sseData ignores non-`data:` lines.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, HARNESS_HEARTBEAT_MS);

      try {
        if (response.response) {
          const body = await response.response.transformToString();

          // Emit trace: response received
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "trace",
            event: "model_call",
            name: `Response received (${latencyMs}ms)`,
            timestamp: new Date().toISOString(),
          })}\n\n`));

          if (body.includes("data: ")) {
            for (const line of body.split("\n")) {
              if (line.startsWith("data: ")) {
                controller.enqueue(encoder.encode(line + "\n\n"));
              }
            }
          } else {
            let text = body;
            let tokenInfo: { input?: number; output?: number } = {};
            try {
              const parsed = JSON.parse(body);
              // Extract token usage if present
              const usage = parsed.metadata?.usage || parsed.usage;
              if (usage) {
                tokenInfo = { input: usage.inputTokens, output: usage.outputTokens };
              }
              // Handle various response structures from different agent frameworks
              if (parsed.result?.content && Array.isArray(parsed.result.content)) {
                // Strands/MCP style: { result: { role, content: [{ text: "..." }], metadata } }
                text = parsed.result.content.map((b: { text?: string }) => b.text || "").join("");
                const meta = parsed.result.metadata?.usage;
                if (meta) tokenInfo = { input: meta.inputTokens, output: meta.outputTokens };
              } else if (parsed.event?.contentBlockDelta?.delta?.text) {
                // AgentCore Runtime async generator yield: { event: { contentBlockDelta: { delta: { text: "..." } } } }
                text = parsed.event.contentBlockDelta.delta.text;
              } else if (parsed.result && typeof parsed.result === "string") {
                text = parsed.result;
              } else if (parsed.output?.text) {
                // Simple output style: { output: { text: "..." } }
                text = parsed.output.text;
              } else if (parsed.output?.message?.content) {
                // Converse output: { output: { message: { content: [{ text: "..." }] } } }
                text = parsed.output.message.content.map((b: { text?: string }) => b.text || "").join("");
              } else if (parsed.completion) {
                // Completion style: { completion: "..." }
                text = parsed.completion;
              } else if (parsed.response) {
                // Generic response field
                text = typeof parsed.response === "string" ? parsed.response : JSON.stringify(parsed.response, null, 2);
              } else if (parsed.answer) {
                // Q&A style: { answer: "..." }
                text = parsed.answer;
              } else if (typeof parsed === "string") {
                text = parsed;
              }
            } catch {
              // Body might be newline-delimited JSON (multiple yields from async generator)
              // Try to extract text from contentBlockDelta events
              const lines = body.split("\n").filter((l: string) => l.trim());
              if (lines.length > 1) {
                const texts: string[] = [];
                for (const line of lines) {
                  try {
                    const obj = JSON.parse(line);
                    if (obj.event?.contentBlockDelta?.delta?.text) {
                      texts.push(obj.event.contentBlockDelta.delta.text);
                    }
                  } catch { /* skip unparseable lines */ }
                }
                if (texts.length > 0) {
                  text = texts.join("");
                }
              }
              // else use raw body as-is
            }

            const data = JSON.stringify({ type: "text", content: text });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));

            // Emit token usage trace if available
            if (tokenInfo.input || tokenInfo.output) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: "trace",
                event: "usage",
                name: `Tokens: ${tokenInfo.input || 0} in → ${tokenInfo.output || 0} out`,
                timestamp: new Date().toISOString(),
              })}\n\n`));
            }
          }
        }

        // Emit completion trace
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "trace",
          event: "response",
          name: `Complete (${(latencyMs / 1000).toFixed(1)}s)`,
          timestamp: new Date().toISOString(),
        })}\n\n`));

        clearInterval(heartbeat);
        closed = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      } catch (err) {
        clearInterval(heartbeat);
        closed = true;
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "trace",
          event: "error",
          name: errMsg,
          timestamp: new Date().toISOString(),
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", content: errMsg })}\n\n`));
        controller.close();
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
    },
  });
}

/**
 * Invoke a harness-managed agent using InvokeHarness.
 */
export async function invokeHarnessAgent(params: {
  harnessArn: string;
  prompt: string;
  sessionId: string;
  systemPrompt?: string;
  history?: Array<{ role: string; content: string }>;
  region?: string;
  model?: { bedrockModelConfig?: { modelId: string }; openAiModelConfig?: { modelId: string; apiKeyArn: string } };
  /** Scopes the harness's attached Memory (e.g. a persistent PM agent). */
  actorId?: string;
  timeoutSeconds?: number;
  maxIterations?: number;
}): Promise<ReadableStream> {
  const region = params.region || DEFAULT_REGION;
  const client = getAgentCoreClient(region);
  const encoder = new TextEncoder();

  const { InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [];

  if (params.history && params.history.length > 0) {
    for (const msg of params.history) {
      messages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: [{ text: msg.content }],
      });
    }
  }

  messages.push({ role: "user", content: [{ text: params.prompt }] });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commandInput: any = {
    harnessArn: params.harnessArn,
    runtimeSessionId: params.sessionId,
    messages,
  };

  if (params.actorId) commandInput.actorId = params.actorId;
  if (params.timeoutSeconds) commandInput.timeoutSeconds = params.timeoutSeconds;
  if (params.maxIterations) commandInput.maxIterations = params.maxIterations;

  if (params.systemPrompt) {
    commandInput.system = [{ text: params.systemPrompt }];
  }

  // Per-invocation model override (e.g., use Opus for complex dev tasks)
  if (params.model) {
    commandInput.model = params.model;
  }

  const command = new InvokeHarnessCommand(commandInput);
  const response = await client.send(command);

  // Heartbeat state lives in the enclosing scope so both start() and cancel()
  // can touch it. (If declared inside start(), a bare `closed` in cancel() would
  // resolve to the DOM global `Window.closed` — tsc passes, but at runtime in
  // Node ESM the assignment throws and the interval never clears.)
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream({
    async start(controller) {
      // A single harness tool call (the agent "researching") can run for minutes
      // with zero bytes on the wire. App Runner — and most proxies/load balancers —
      // drop a connection that goes idle, which the browser surfaces as a network
      // error mid-chat. Emit an SSE comment heartbeat so bytes always flow. The
      // shared sseData reader only yields `data:` lines, so ": ping" frames are
      // invisible to every client.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, HARNESS_HEARTBEAT_MS);

      try {
        let hasEmittedText = false; // Track if we've sent any text content

        if (response.stream) {
          for await (const event of response.stream as AsyncIterable<Record<string, unknown>>) {
            if ("contentBlockDelta" in event) {
              const delta = event.contentBlockDelta as { delta?: { text?: string } };
              if (delta.delta?.text) {
                hasEmittedText = true;
                const data = JSON.stringify({ type: "text", content: delta.delta.text });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
            } else if ("contentBlockStart" in event) {
              const block = event.contentBlockStart as { start?: { toolUse?: { toolUseId?: string; name?: string } } };
              if (block.start?.toolUse) {
                const trace = JSON.stringify({
                  type: "trace",
                  event: "tool_start",
                  name: block.start.toolUse.name,
                  toolUseId: block.start.toolUse.toolUseId,
                  timestamp: new Date().toISOString(),
                });
                controller.enqueue(encoder.encode(`data: ${trace}\n\n`));
              }
            } else if ("contentBlockStop" in event) {
              const trace = JSON.stringify({ type: "trace", event: "block_stop", timestamp: new Date().toISOString() });
              controller.enqueue(encoder.encode(`data: ${trace}\n\n`));
            } else if ("messageStart" in event) {
              // If we've already sent text and a new message starts (after a tool loop),
              // inject a line break so the new content doesn't run into the previous text
              if (hasEmittedText) {
                const sep = JSON.stringify({ type: "text", content: "\n\n" });
                controller.enqueue(encoder.encode(`data: ${sep}\n\n`));
              }
              const trace = JSON.stringify({ type: "trace", event: "message_start", timestamp: new Date().toISOString() });
              controller.enqueue(encoder.encode(`data: ${trace}\n\n`));
            } else if ("messageStop" in event) {
              // Don't send "done" here — harness agents have multi-turn tool loops.
              // The stream continues after messageStop if the agent is calling tools.
              // "done" is only sent after the full stream iteration completes (below).
              const trace = JSON.stringify({ type: "trace", event: "message_stop", timestamp: new Date().toISOString() });
              controller.enqueue(encoder.encode(`data: ${trace}\n\n`));
            } else if ("metadata" in event) {
              const meta = event.metadata as { usage?: { inputTokens?: number; outputTokens?: number } };
              if (meta.usage) {
                const trace = JSON.stringify({
                  type: "trace",
                  event: "usage",
                  inputTokens: meta.usage.inputTokens,
                  outputTokens: meta.usage.outputTokens,
                  timestamp: new Date().toISOString(),
                });
                controller.enqueue(encoder.encode(`data: ${trace}\n\n`));
              }
            }
          }
        }
        // Stream fully exhausted — NOW signal done
        clearInterval(heartbeat);
        closed = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      } catch (err) {
        clearInterval(heartbeat);
        closed = true;
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", content: errMsg })}\n\n`));
        controller.close();
      }
    },
    cancel() {
      // Client disconnected (navigated away, closed drawer) — stop the heartbeat
      // so we don't leak the interval or write to a dead controller.
      closed = true;
      clearInterval(heartbeat);
    },
  });
}

// ─── AgentCore Registry ──────────────────────────────────────────────────────
// Two-level model:
//   Registry (catalog) ── Registry Record (entry, e.g. MCP server, A2A card)
// Control-plane CRUDL + approval via getControlClient(region); search via the
// data-plane agentcore client. Writes are async — create/update return HTTP 202
// with a CREATING/UPDATING status; poll get* until terminal.

export type RegistryDescriptorType = "MCP" | "A2A" | "CUSTOM" | "AGENT_SKILLS";


export type RecordStatus =
  | "CREATING"
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "DEPRECATED"
  | "UPDATING"
  | "CREATE_FAILED"
  | "UPDATE_FAILED";

export type RegistryAuthorizerType = "AWS_IAM" | "CUSTOM_JWT";

export interface Registry {
  name: string;
  description?: string;
  registryId: string;
  registryArn: string;
  authorizerType?: RegistryAuthorizerType;
  approvalConfiguration?: { autoApproval?: boolean };
  status: string;
  statusReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistryRecord {
  recordId: string;
  recordArn: string;
  registryArn?: string;
  name: string;
  description?: string;
  descriptorType: RegistryDescriptorType;
  recordVersion?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

// Full record incl. descriptors payload (from GetRegistryRecord).
export interface RegistryRecordDetail extends RegistryRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptors?: any;
  statusReason?: string;
  synchronizationType?: string;
}

export interface CreateRegistryInput {
  name: string;
  description?: string;
  authorizerType?: RegistryAuthorizerType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authorizerConfiguration?: any;
  approvalConfiguration?: { autoApproval?: boolean };
}

export interface CreateRegistryRecordInput {
  name: string;
  description?: string;
  descriptorType: RegistryDescriptorType;
  // Union keyed by lowercased type — see API docs in CLAUDE context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptors?: any;
  recordVersion?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRegistrySummary(r: any): Registry {
  return {
    name: r.name,
    description: r.description,
    registryId: r.registryId,
    registryArn: r.registryArn,
    authorizerType: r.authorizerType,
    approvalConfiguration: r.approvalConfiguration,
    status: r.status || "UNKNOWN",
    statusReason: r.statusReason,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRecordSummary(r: any): RegistryRecord {
  return {
    recordId: r.recordId,
    recordArn: r.recordArn,
    registryArn: r.registryArn,
    name: r.name,
    description: r.description,
    descriptorType: r.descriptorType,
    // control-plane summary uses recordVersion; data-plane summary uses version
    recordVersion: r.recordVersion ?? r.version,
    status: r.status || "UNKNOWN",
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

/** List all registries in the account (paginated). */
export async function listRegistries(region: string = DEFAULT_REGION): Promise<Registry[]> {
  const client = getControlClient(region);
  const out: Registry[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListRegistriesCommand({ maxResults: 100, nextToken }));
    for (const r of res.registries || []) out.push(mapRegistrySummary(r));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Get a single registry (full detail). */
export async function getRegistry(registryId: string, region: string = DEFAULT_REGION): Promise<Registry> {
  const client = getControlClient(region);
  const res = await client.send(new GetRegistryCommand({ registryId }));
  return mapRegistrySummary({ ...res, registryId });
}

/** Create a registry. Returns the new registry's arn/id (status CREATING). */
export async function createRegistry(input: CreateRegistryInput, region: string = DEFAULT_REGION): Promise<Registry> {
  const client = getControlClient(region);
  const res = await client.send(
    new CreateRegistryCommand({
      name: input.name,
      description: input.description,
      authorizerType: input.authorizerType,
      authorizerConfiguration: input.authorizerConfiguration,
      approvalConfiguration: input.approvalConfiguration,
    })
  );
  const registryArn = res.registryArn || "";
  // CreateRegistry only returns the ARN; derive the id from the ARN tail.
  const registryId = registryArn.split("/").pop() || registryArn;
  return {
    name: input.name,
    description: input.description,
    registryId,
    registryArn,
    authorizerType: input.authorizerType,
    approvalConfiguration: input.approvalConfiguration,
    status: "CREATING",
  };
}

/** Update a registry (name and/or description). PATCH semantics. */
export async function updateRegistry(
  registryId: string,
  patch: { name?: string; description?: string },
  region: string = DEFAULT_REGION
): Promise<void> {
  const client = getControlClient(region);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input: any = { registryId };
  if (patch.name !== undefined) input.name = patch.name;
  if (patch.description !== undefined) input.description = { optionalValue: patch.description };
  await client.send(new UpdateRegistryCommand(input));
}

/** Delete a registry (async — status transitions to DELETING). */
export async function deleteRegistry(registryId: string, region: string = DEFAULT_REGION): Promise<void> {
  const client = getControlClient(region);
  await client.send(new DeleteRegistryCommand({ registryId }));
}

/** List records in a registry (paginated), with optional filters. */
export async function listRegistryRecords(
  params: { registryId: string; status?: RecordStatus; descriptorType?: RegistryDescriptorType; name?: string },
  region: string = DEFAULT_REGION
): Promise<RegistryRecord[]> {
  const client = getControlClient(region);
  const out: RegistryRecord[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListRegistryRecordsCommand({
        registryId: params.registryId,
        status: params.status,
        descriptorType: params.descriptorType,
        name: params.name,
        maxResults: 100,
        nextToken,
      })
    );
    for (const r of res.registryRecords || []) out.push(mapRecordSummary(r));
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

/** Get a single record incl. its full descriptors payload. */
export async function getRegistryRecord(
  registryId: string,
  recordId: string,
  region: string = DEFAULT_REGION
): Promise<RegistryRecordDetail> {
  const client = getControlClient(region);
  const res = await client.send(new GetRegistryRecordCommand({ registryId, recordId }));
  return {
    ...mapRecordSummary(res),
    descriptors: res.descriptors,
    statusReason: res.statusReason,
    synchronizationType: res.synchronizationType,
  };
}

/** Create a record in a registry. Returns id/arn/status (async, CREATING). */
export async function createRegistryRecord(
  registryId: string,
  input: CreateRegistryRecordInput,
  region: string = DEFAULT_REGION
): Promise<{ recordId: string; recordArn: string; status: string }> {
  const client = getControlClient(region);
  const res = await client.send(
    new CreateRegistryRecordCommand({
      registryId,
      name: input.name,
      description: input.description,
      descriptorType: input.descriptorType,
      descriptors: input.descriptors,
      recordVersion: input.recordVersion,
    })
  );
  const recordArn = res.recordArn || "";
  // CreateRegistryRecord only returns recordArn + status; derive id from arn tail.
  const recordId = recordArn.split("/").pop() || recordArn;
  return { recordId, recordArn, status: res.status || "CREATING" };
}

/**
 * Update a record (name + descriptors inline content). PATCH semantics —
 * descriptors are wrapped per the UpdatedDescriptors / optionalValue shapes.
 * `descriptorType` is required to know which descriptor union branch to build.
 */
export async function updateRegistryRecord(
  registryId: string,
  recordId: string,
  patch: { name?: string; description?: string; descriptorType?: RegistryDescriptorType; inlineContent?: string; skillDefinitionContent?: string },
  region: string = DEFAULT_REGION
): Promise<void> {
  const client = getControlClient(region);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input: any = { registryId, recordId };
  if (patch.name !== undefined) input.name = patch.name;
  // Description uses the UpdatedDescription wrapper: { optionalValue: <text> }.
  if (patch.description !== undefined) input.description = { optionalValue: patch.description };

  if (patch.inlineContent !== undefined && patch.descriptorType) {
    // Build UpdatedDescriptors -> optionalValue (UpdatedDescriptorsUnion) ->
    // per-type wrapper -> optionalValue -> field wrapper -> optionalValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let union: any;
    switch (patch.descriptorType) {
      case "MCP":
        union = {
          mcp: {
            optionalValue: {
              server: { optionalValue: { inlineContent: patch.inlineContent } },
            },
          },
        };
        break;
      case "A2A":
        union = {
          a2a: { optionalValue: { agentCard: { inlineContent: patch.inlineContent } } },
        };
        break;
      case "CUSTOM":
        union = {
          custom: { optionalValue: { inlineContent: patch.inlineContent } },
        };
        break;
      case "AGENT_SKILLS": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fields: any = {
          skillMd: { optionalValue: { inlineContent: patch.inlineContent } },
        };
        if (patch.skillDefinitionContent !== undefined && patch.skillDefinitionContent.trim()) {
          fields.skillDefinition = { optionalValue: { inlineContent: patch.skillDefinitionContent } };
        }
        union = { agentSkills: { optionalValue: fields } };
        break;
      }
    }
    input.descriptors = { optionalValue: union };
  }

  await client.send(new UpdateRegistryRecordCommand(input));
}

/** Delete a record. */
export async function deleteRegistryRecord(
  registryId: string,
  recordId: string,
  region: string = DEFAULT_REGION
): Promise<void> {
  const client = getControlClient(region);
  await client.send(new DeleteRegistryRecordCommand({ registryId, recordId }));
}

/** Submit a DRAFT record for approval (-> PENDING_APPROVAL). */
export async function submitRecordForApproval(
  registryId: string,
  recordId: string,
  region: string = DEFAULT_REGION
): Promise<{ status: string }> {
  const client = getControlClient(region);
  const res = await client.send(new SubmitRegistryRecordForApprovalCommand({ registryId, recordId }));
  return { status: res.status || "PENDING_APPROVAL" };
}

/**
 * Set a record's status. Used for approve (APPROVED), reject (REJECTED),
 * deprecate (DEPRECATED). statusReason is required by the API — a sensible
 * default is supplied when the caller omits one.
 */
export async function setRecordStatus(
  registryId: string,
  recordId: string,
  status: RecordStatus,
  statusReason: string | undefined,
  region: string = DEFAULT_REGION
): Promise<{ status: string }> {
  const client = getControlClient(region);
  const reason = statusReason && statusReason.trim() ? statusReason : `Status set to ${status} via AgentCore Hub`;
  const res = await client.send(
    new UpdateRegistryRecordStatusCommand({ registryId, recordId, status, statusReason: reason })
  );
  return { status: res.status || status };
}

/** Full-text search records in a registry (data plane). */
export async function searchRegistryRecords(
  params: { registryId: string; query: string; descriptorType?: RegistryDescriptorType; maxResults?: number },
  region: string = DEFAULT_REGION
): Promise<RegistryRecord[]> {
  const client = getAgentCoreClient(region);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filters: any = params.descriptorType ? { descriptorType: { $eq: params.descriptorType } } : undefined;
  const res = await client.send(
    new SearchRegistryRecordsCommand({
      registryIds: [params.registryId],
      searchQuery: params.query,
      maxResults: params.maxResults,
      filters,
    })
  );
  return (res.registryRecords || []).map(mapRecordSummary);
}
