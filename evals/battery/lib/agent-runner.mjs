// Runs one battery case: a Bedrock Converse tool-use loop against the closed
// stub registry. System prompt and blueprints come from the WORKING TREE so a
// PR's config changes are what's under test. Transport (`converse`) is
// injectable so vitest can drive the loop without AWS.

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "./registry.mjs";

// Mirrors CODING_MODEL_TIERS in deploy/runtime-agent/main.py (keep in sync;
// the battery deliberately exposes only haiku/sonnet/opus — no fable tier).
export const MODEL_TIERS = Object.freeze({
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  sonnet: "us.anthropic.claude-sonnet-5",
  opus: "us.anthropic.claude-opus-5",
});

// $/MTok (design cost model): input/output.
export const PRICING_PER_MTOK = Object.freeze({
  haiku: { input: 1, output: 5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 5, output: 25 },
  judge: { input: 5, output: 25 },
});

export const MAX_TURNS = 24;

export function usageCostUsd(tier, usage) {
  const price = PRICING_PER_MTOK[tier];
  return ((usage.inputTokens || 0) * price.input + (usage.outputTokens || 0) * price.output) / 1_000_000;
}

// FR-10 retry classifier: typed transport errors only — throttling, 5xx,
// connection reset/timeout. Score variance is NEVER a retry reason.
export function isRetryableTransportError(err) {
  const name = err?.name || "";
  const code = err?.code || err?.cause?.code || "";
  const status = err?.$metadata?.httpStatusCode;
  return (
    /Throttling|TooManyRequests|ServiceUnavailable|InternalServer|ModelError/i.test(name) ||
    (typeof status === "number" && status >= 500) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|TimeoutError/i.test(`${code} ${name}`)
  );
}

export function systemPromptPath(repoRoot, targetAgentId) {
  return targetAgentId === "agentcore_hub_workflow_manager"
    ? join(repoRoot, "deploy", "workflow-manager", "system-prompt.md")
    : join(repoRoot, "deploy", "runtime-agent", "prompts", `${targetAgentId}.txt`);
}

// Transcript fixtures are [{role, content}] arrays. Converse requires strictly
// alternating roles starting with user, so adjacent same-role messages are
// coalesced into multi-block messages (and the taskPrompt user turn coalesces
// onto a trailing user transcript message).
export function buildMessages(transcript, taskPrompt) {
  const raw = [...(transcript || []).map((m) => ({ role: m.role, text: m.content }))];
  raw.push({ role: "user", text: taskPrompt });
  const messages = [];
  for (const m of raw) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push({ text: m.text });
    else messages.push({ role: m.role, content: [{ text: m.text }] });
  }
  if (messages[0].role !== "user") messages.unshift({ role: "user", content: [{ text: "(session transcript follows)" }] });
  return messages;
}

async function converseLoop({ caseDef, repoRoot, converse, modelId, signal, maxTurns }) {
  const workspaceDir = mkdtempSync(join(tmpdir(), `battery-${caseDef.id}-`));
  try {
    const registry = createRegistry({ caseDef, repoRoot, workspaceDir });
    const system = [{ text: readFileSync(systemPromptPath(repoRoot, caseDef.targetAgentId), "utf8") }];
    let transcript = null;
    if (caseDef.input?.transcript) {
      transcript = JSON.parse(readFileSync(join(repoRoot, "evals", "battery", caseDef.input.transcript), "utf8"));
    }
    const messages = buildMessages(transcript, caseDef.taskPrompt);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let finalText = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await converse(
        {
          modelId,
          system,
          messages,
          toolConfig: { tools: registry.toolSpecs },
          inferenceConfig: { maxTokens: 4096 },
        },
        { signal }
      );
      usage.inputTokens += response.usage?.inputTokens || 0;
      usage.outputTokens += response.usage?.outputTokens || 0;
      const message = response.output?.message || { role: "assistant", content: [] };
      messages.push(message);
      finalText = message.content
        .filter((b) => b.text)
        .map((b) => b.text)
        .join("\n");

      if (response.stopReason !== "tool_use") {
        return { trajectory: registry.trajectory, messages, usage, finalText, turns: turn + 1 };
      }
      const toolResults = message.content
        .filter((b) => b.toolUse)
        .map((b) => ({
          toolResult: {
            toolUseId: b.toolUse.toolUseId,
            content: [{ text: registry.execute(b.toolUse.name, b.toolUse.input) }],
          },
        }));
      messages.push({ role: "user", content: toolResults });
    }
    return {
      trajectory: registry.trajectory,
      messages,
      usage,
      finalText,
      turns: maxTurns,
      maxTurnsExceeded: true,
    };
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

/**
 * Run one case end to end. Returns:
 * { id, status: completed|errored|timed_out|failed_forbidden_tool, attempt,
 *   trajectory, messages, usage, finalText, forbiddenHits, error?, sessionId }
 */
export async function runCase({ caseDef, repoRoot, runId, converse, maxTurns = MAX_TURNS }) {
  const sessionId = `battery-${runId}-${caseDef.id}`;
  const modelId = MODEL_TIERS[caseDef.modelTier];
  let attempt = 0;
  let lastError = null;

  while (attempt < 2) {
    attempt += 1;
    const watchdog = new AbortController();
    const timer = setTimeout(() => watchdog.abort(new Error("case timeout")), caseDef.timeoutSeconds * 1000);
    let producedOutput = false;
    try {
      const loop = await converseLoop({
        caseDef,
        repoRoot,
        converse: async (params, opts) => {
          const r = await converse(params, opts);
          producedOutput = true;
          return r;
        },
        modelId,
        signal: watchdog.signal,
        maxTurns,
      });
      clearTimeout(timer);
      const forbidden = new Set(caseDef.referenceInputs?.forbiddenTools || []);
      const forbiddenHits = loop.trajectory.filter((t) => forbidden.has(t.tool)).map((t) => t.tool);
      const status = forbiddenHits.length > 0 ? "failed_forbidden_tool" : "completed";
      return { id: caseDef.id, status, attempt, sessionId, forbiddenHits, ...loop };
    } catch (err) {
      clearTimeout(timer);
      if (watchdog.signal.aborted) {
        // The per-case watchdog fired — a real timeout, never retried.
        return { id: caseDef.id, status: "timed_out", attempt, sessionId, error: `timed out after ${caseDef.timeoutSeconds}s`, forbiddenHits: [], trajectory: [], usage: { inputTokens: 0, outputTokens: 0 } };
      }
      lastError = err;
      const retryable = isRetryableTransportError(err) && (!producedOutput || /Throttling|5\d\d/.test(String(err?.$metadata?.httpStatusCode || err?.name)));
      if (attempt < 2 && retryable) continue;
      return {
        id: caseDef.id,
        status: "errored",
        attempt,
        sessionId,
        error: `${err.name || "Error"}: ${err.message}`,
        forbiddenHits: [],
        trajectory: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }
  return {
    id: caseDef.id,
    status: "errored",
    attempt,
    sessionId,
    error: `${lastError?.name || "Error"}: ${lastError?.message}`,
    forbiddenHits: [],
    trajectory: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
