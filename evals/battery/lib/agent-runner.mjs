// Runs one battery case: a Bedrock Converse tool-use loop against the closed
// stub registry. System prompt and blueprints come from the WORKING TREE so a
// PR's config changes are what's under test. Transport (`converse`) is
// injectable so vitest can drive the loop without AWS.

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "./registry.mjs";
import { backoffDelayMs, createRetryBudget, linkAbort, sleep } from "./retry.mjs";

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
// FR-10: a single transport retry per case by default (never per score), with
// jittered backoff. Bounded in attempts AND in elapsed time via the per-case
// retry budget below; the runner can widen it with BATTERY_MAX_TRANSPORT_RETRIES.
export const MAX_TRANSPORT_RETRIES = 1;

export function usageCostUsd(tier, usage) {
  const price = PRICING_PER_MTOK[tier];
  return ((usage.inputTokens || 0) * price.input + (usage.outputTokens || 0) * price.output) / 1_000_000;
}

// FR-10 retry classifier: typed transport errors only — throttling, 5xx,
// connection reset/timeout. Score variance is NEVER a retry reason.
// Name and HTTP status are tested INDEPENDENTLY: throttling errors carry
// httpStatusCode 400, so a combined `status || name` string would hide the
// name and misclassify throttling as non-retryable (TEAM-3352 finding 1D).
export function isThrottlingOrServerError(err) {
  const name = String(err?.name || "");
  const status = err?.$metadata?.httpStatusCode;
  return (
    /Throttling|TooManyRequests|ServiceUnavailable/i.test(name) ||
    (typeof status === "number" && status >= 500)
  );
}

export function isRetryableTransportError(err) {
  const name = err?.name || "";
  const code = err?.code || err?.cause?.code || "";
  return (
    isThrottlingOrServerError(err) ||
    /InternalServer|ModelError/i.test(name) ||
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

// One Converse turn with the per-case retry budget: a retryable transport
// failure retries THIS turn (the failed call produced nothing, so the
// conversation state is untouched) after a jittered backoff — never a restart
// of the whole case from turn 0, which under throttling only re-adds the load
// that caused the failure.
async function converseTurn({ converse, params, signal, retryBudget }) {
  for (let retry = 1; ; retry++) {
    try {
      return await converse(params, { signal });
    } catch (err) {
      if (signal?.aborted || !isRetryableTransportError(err) || !retryBudget.tryConsume()) throw err;
      await sleep(backoffDelayMs(retry), signal);
      if (signal?.aborted) throw err;
    }
  }
}

async function converseLoop({ caseDef, repoRoot, converse, modelId, signal, maxTurns, retryBudget }) {
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
      const response = await converseTurn({
        converse,
        params: {
          modelId,
          system,
          messages,
          toolConfig: { tools: registry.toolSpecs },
          inferenceConfig: { maxTokens: 4096 },
        },
        signal,
        retryBudget,
      });
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
 * { id, status: completed|errored|timed_out|failed_forbidden_tool|failed_required_tool,
 *   attempt, trajectory, messages, usage, finalText, forbiddenHits,
 *   missingRequiredTools, error?, sessionId }
 *
 * Forbidden tools AND non-optional expectedToolTrajectory entries are enforced
 * mechanically here, with zero judge spend: contract-critical binary behaviors
 * (blueprint loaded, verdict via report_completion, fix ticket filed) must not
 * depend on an LLM judge noticing their absence in prose (TEAM-3352).
 *
 * `attempt` = transport attempts consumed (1 + retries used).
 * `signal` (optional) is the runner's end-to-end case deadline / whole-run
 * watchdog — an abort from it cuts through in-flight turns and backoff sleeps
 * and reports as timed_out with the deadline's own reason.
 */
export async function runCase({
  caseDef,
  repoRoot,
  runId,
  converse,
  maxTurns = MAX_TURNS,
  signal,
  maxTransportRetries = MAX_TRANSPORT_RETRIES,
}) {
  const sessionId = `battery-${runId}-${caseDef.id}`;
  const modelId = MODEL_TIERS[caseDef.modelTier];
  const watchdog = new AbortController();
  const unlink = linkAbort(signal, watchdog);
  const timer = setTimeout(
    () => watchdog.abort(new Error(`timed out after ${caseDef.timeoutSeconds}s`)),
    caseDef.timeoutSeconds * 1000
  );
  // Retries are bounded in attempts AND in elapsed time: the budget's clock is
  // the same window the agent-loop watchdog enforces.
  const retryBudget = createRetryBudget({
    maxRetries: maxTransportRetries,
    maxElapsedMs: caseDef.timeoutSeconds * 1000,
  });
  const empty = {
    forbiddenHits: [],
    missingRequiredTools: [],
    trajectory: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  try {
    const loop = await converseLoop({
      caseDef,
      repoRoot,
      converse,
      modelId,
      signal: watchdog.signal,
      maxTurns,
      retryBudget,
    });
    const forbidden = new Set(caseDef.referenceInputs?.forbiddenTools || []);
    const forbiddenHits = loop.trajectory.filter((t) => forbidden.has(t.tool)).map((t) => t.tool);
    const called = new Set(loop.trajectory.map((t) => t.tool));
    const missingRequiredTools = [
      ...new Set(
        (caseDef.referenceInputs?.expectedToolTrajectory || [])
          .filter((e) => e && e.optional !== true)
          .map((e) => e.tool)
          .filter((tool) => !called.has(tool))
      ),
    ];
    const status =
      forbiddenHits.length > 0
        ? "failed_forbidden_tool"
        : missingRequiredTools.length > 0
          ? "failed_required_tool"
          : "completed";
    return {
      id: caseDef.id,
      status,
      attempt: retryBudget.used + 1,
      sessionId,
      forbiddenHits,
      missingRequiredTools,
      ...loop,
    };
  } catch (err) {
    if (watchdog.signal.aborted) {
      // Watchdog or external deadline fired — a real timeout, never retried.
      const reason = watchdog.signal.reason;
      return {
        id: caseDef.id,
        status: "timed_out",
        attempt: retryBudget.used + 1,
        sessionId,
        error: reason?.message || `timed out after ${caseDef.timeoutSeconds}s`,
        ...empty,
      };
    }
    return {
      id: caseDef.id,
      status: "errored",
      attempt: retryBudget.used + 1,
      sessionId,
      error: `${err.name || "Error"}: ${err.message}`,
      ...empty,
    };
  } finally {
    clearTimeout(timer);
    unlink();
  }
}
