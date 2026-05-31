// AgentCore streaming client - ported from sample-amazon-bedrock-agentcore-fullstack-webapp
// Handles SSE streaming for agent invocations

import { getClientRegion } from "@/lib/client-cache";

export interface TraceEvent {
  type: "trace";
  event: string;
  name?: string;
  toolUseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp: string;
}

export interface StreamRequest {
  agentId: string;
  agentArn?: string;
  isHarness?: boolean;
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  history?: Array<{ role: string; content: string }>;
  onChunk: (chunk: string) => void;
  onTrace?: (trace: TraceEvent) => void;
  onDone?: (fullResponse: string) => void;
  onError?: (error: Error) => void;
}

export interface AgentInfo {
  id: string;
  name: string;
  arn?: string;
  description?: string;
  status?: string;
  isHarness?: boolean;
  config?: { system_prompt?: string; model_id?: string; [key: string]: unknown };
}

export interface BuilderStreamRequest {
  prompt: string;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  onChunk: (chunk: string) => void;
  onConfig?: (config: HarnessConfig) => void;
  onDone?: (fullResponse: string) => void;
  onError?: (error: Error) => void;
}

export interface HarnessConfig {
  agent_name: string;
  model_id?: string;
  system_prompt?: string;
  tools?: string[];
  mcp_servers?: Record<string, { url: string; tools?: string[] }>;
  guardrails?: Record<string, unknown>;
  memory?: { type: string; config?: Record<string, unknown> };
}

/**
 * Stream an agent invocation via SSE
 * Routes through our Next.js API proxy at /api/agentcore/invoke
 */
export async function streamAgentInvocation(request: StreamRequest): Promise<string> {
  const response = await fetch("/api/agentcore/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
    body: JSON.stringify({
      agentRuntimeArn: request.agentArn,
      agentId: request.agentId,
      isHarness: request.isHarness,
      prompt: request.prompt,
      sessionId: request.sessionId,
      systemPrompt: request.systemPrompt,
      history: request.history,
    }),
  });

  if (!response.ok) {
    const err = new Error(`Invoke failed: ${response.status} ${response.statusText}`);
    request.onError?.(err);
    throw err;
  }

  if (!response.body) {
    throw new Error("No response body received");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          request.onDone?.(fullResponse);
          return fullResponse;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "text" && parsed.content) {
            fullResponse += parsed.content;
            request.onChunk(parsed.content);
          } else if (parsed.type === "trace") {
            request.onTrace?.(parsed as TraceEvent);
          } else if (parsed.type === "done") {
            request.onDone?.(fullResponse);
            return fullResponse;
          } else if (parsed.event?.contentBlockDelta?.delta?.text) {
            // AgentCore Runtime async generator yield format
            const text = parsed.event.contentBlockDelta.delta.text;
            fullResponse += text;
            request.onChunk(text);
          } else if (parsed.event?.contentBlockStart?.start?.toolUse) {
            // Tool use event from async generator yield
            const toolName = parsed.event.contentBlockStart.start.toolUse.name;
            request.onTrace?.({
              type: "trace",
              event: "tool_start",
              name: toolName,
              timestamp: new Date().toISOString(),
            });
          } else if (typeof parsed === "string") {
            fullResponse += parsed;
            request.onChunk(parsed);
          } else {
            // Unknown JSON structure — show raw so it's never silently lost
            const raw = typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : String(parsed);
            fullResponse += raw;
            request.onChunk(raw);
          }
        } catch {
          // Not JSON - treat as plain text chunk
          fullResponse += data;
          request.onChunk(data);
        }
      }
    }
  }

  // Handle remaining buffer
  if (buffer.startsWith("data: ")) {
    const data = buffer.slice(6);
    if (data && data !== "[DONE]") {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "text" && parsed.content) {
          fullResponse += parsed.content;
          request.onChunk(parsed.content);
        } else if (parsed.event?.contentBlockDelta?.delta?.text) {
          const text = parsed.event.contentBlockDelta.delta.text;
          fullResponse += text;
          request.onChunk(text);
        }
      } catch {
        fullResponse += data;
        request.onChunk(data);
      }
    }
  }

  request.onDone?.(fullResponse);
  return fullResponse;
}

/**
 * Stream the builder agent chat for harness-mode agent creation
 * Routes through our Next.js API proxy at /api/agentcore/builder
 */
export async function streamBuilderChat(request: BuilderStreamRequest): Promise<string> {
  const response = await fetch("/api/agentcore/builder", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
    body: JSON.stringify({
      prompt: request.prompt,
      sessionId: request.sessionId,
      history: request.history,
    }),
  });

  if (!response.ok) {
    const err = new Error(`Builder failed: ${response.status} ${response.statusText}`);
    request.onError?.(err);
    throw err;
  }

  if (!response.body) {
    throw new Error("No response body received");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          request.onDone?.(fullResponse);
          return fullResponse;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "text" && parsed.content) {
            fullResponse += parsed.content;
            request.onChunk(parsed.content);
          } else if (parsed.type === "config" && parsed.content) {
            request.onConfig?.(parsed.content as HarnessConfig);
          } else if (parsed.type === "done") {
            request.onDone?.(fullResponse);
            return fullResponse;
          }
        } catch {
          fullResponse += data;
          request.onChunk(data);
        }
      }
    }
  }

  request.onDone?.(fullResponse);
  return fullResponse;
}

/**
 * Parse harness config from markdown code blocks in builder response
 */
export function parseHarnessConfig(text: string): HarnessConfig | null {
  // Strategy 1: fenced code block with known language tag
  const fencedMatch = text.match(/```(?:agent-config|json|yaml)\s*\n([\s\S]*?)```/);
  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1]);
      if (parsed.agent_name) return parsed as HarnessConfig;
    } catch { /* try next strategy */ }
  }

  // Strategy 2: any fenced code block containing agent_name
  const anyFenceMatch = text.match(/```[^\n]*\n([\s\S]*?)```/g);
  if (anyFenceMatch) {
    for (const block of anyFenceMatch) {
      const inner = block.replace(/```[^\n]*\n/, "").replace(/```$/, "");
      try {
        const parsed = JSON.parse(inner);
        if (parsed.agent_name) return parsed as HarnessConfig;
      } catch { /* try next block */ }
    }
  }

  // Strategy 3: find a JSON object with "agent_name" anywhere in the text
  const jsonMatch = text.match(/\{[^{}]*"agent_name"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.agent_name) return parsed as HarnessConfig;
    } catch { /* not valid JSON */ }
  }

  return null;
}

/**
 * List available agents from AgentCore
 */
export async function listAgentCoreAgents(): Promise<AgentInfo[]> {
  const response = await fetch("/api/agentcore/agents", { headers: { "x-aws-region": getClientRegion() } });
  if (!response.ok) return [];
  return response.json();
}

/**
 * Deploy a harness config as a new agent
 */
export async function deployHarnessAgent(config: HarnessConfig): Promise<{ agentId: string; status: string }> {
  const response = await fetch("/api/agentcore/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(`Deploy failed: ${response.status}`);
  }
  return response.json();
}
