// Converse loop with a fully mocked transport — no client is ever constructed.
// Uses the real repo root only for fs reads (system prompts, fixtures).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCase,
  buildMessages,
  isRetryableTransportError,
  isThrottlingOrServerError,
  MODEL_TIERS,
  usageCostUsd,
} from "../lib/agent-runner.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const QA_CASE = JSON.parse(
  readFileSync(join(REPO_ROOT, "evals/battery/cases/qa-verifier-regression-001.json"), "utf8")
);
// Retry-policy tests end the conversation without tool calls, so they use a
// variant with no required trajectory (which would otherwise fail mechanically).
const NO_TRAJECTORY_CASE = {
  ...QA_CASE,
  referenceInputs: { ...QA_CASE.referenceInputs, expectedToolTrajectory: [] },
};

const endTurn = (text = "Done.") => ({
  stopReason: "end_turn",
  usage: { inputTokens: 100, outputTokens: 10 },
  output: { message: { role: "assistant", content: [{ text }] } },
});
const toolUse = (name: string, input: any, id = "t1") => ({
  stopReason: "tool_use",
  usage: { inputTokens: 100, outputTokens: 10 },
  output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input } }] } },
});

describe("happy path", () => {
  it("executes the tool loop against the stub registry and records the trajectory", async () => {
    const script = [
      toolUse("load_blueprint", { blueprint_name: "qa-verifier" }),
      toolUse("WorkflowOutput___report_completion", { ticket_id: "BATT-110", summary: "PASS" }, "t2"),
      endTurn(),
    ];
    let i = 0;
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t1", converse: async () => script[i++] });
    expect(run.status).toBe("completed");
    expect(run.attempt).toBe(1);
    expect(run.trajectory.map((t: any) => t.tool)).toEqual(["load_blueprint", "WorkflowOutput___report_completion"]);
    expect(run.trajectory[0].argsDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(run.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    expect(run.sessionId).toBe("battery-t1-qa-verifier-regression-001");
  });
});

describe("forbidden-tool enforcement (mechanical, no judge)", () => {
  it("returns failed_forbidden_tool when the agent calls a per-case forbidden tool", async () => {
    const script = [
      toolUse("Tickets___transition_ticket", { ticket_id: "BATT-110", transition_id: "done" }),
      endTurn(),
    ];
    let i = 0;
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t2", converse: async () => script[i++] });
    // Status alone gates scoring: run-battery only judges 'completed' cases,
    // so a forbidden hit is a case FAIL with zero judge spend.
    expect(run.status).toBe("failed_forbidden_tool");
    expect(run.forbiddenHits).toEqual(["Tickets___transition_ticket"]);
  });
});

describe("timeout watchdog", () => {
  it("returns timed_out with NO retry when the per-case watchdog fires", async () => {
    let calls = 0;
    const hang = (_params: any, { signal }: any) =>
      new Promise((_resolve, reject) => {
        calls++;
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const fastCase = { ...QA_CASE, timeoutSeconds: 0.05 };
    const run = await runCase({ caseDef: fastCase, repoRoot: REPO_ROOT, runId: "t3", converse: hang });
    expect(run.status).toBe("timed_out");
    expect(run.attempt).toBe(1);
    expect(run.error).toContain("timed out");
    expect(calls).toBe(1);
  });
});

describe("transport retry policy (FR-10: single retry, typed errors only)", () => {
  it("retries once on throttling with zero model output, then succeeds", async () => {
    let calls = 0;
    const converse = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      return endTurn();
    };
    const run = await runCase({ caseDef: NO_TRAJECTORY_CASE, repoRoot: REPO_ROOT, runId: "t4", converse });
    expect(run.status).toBe("completed");
    expect(run.attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it("gives up after exactly one retry on persistent connection resets", async () => {
    let calls = 0;
    const converse = async () => {
      calls++;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    };
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t5", converse });
    expect(run.status).toBe("errored");
    expect(run.attempt).toBe(2);
    expect(calls).toBe(2);
  });

  it("does NOT retry a non-transport error", async () => {
    let calls = 0;
    const converse = async () => {
      calls++;
      throw Object.assign(new Error("bad input"), { name: "ValidationException" });
    };
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t6", converse });
    expect(run.status).toBe("errored");
    expect(run.attempt).toBe(1);
    expect(calls).toBe(1);
  });

  it("classifies transport errors by type, never by score", () => {
    expect(isRetryableTransportError({ name: "ThrottlingException" })).toBe(true);
    expect(isRetryableTransportError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isRetryableTransportError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableTransportError({ name: "ValidationException", $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isRetryableTransportError({ name: "AccessDeniedException" })).toBe(false);
  });

  it("tests name and HTTP status independently — a ThrottlingException's 400 status must not hide its name", () => {
    // Regression (TEAM-3352 finding 1D): the old classifier tested
    // String(status || name), so throttling's httpStatusCode 400 shadowed the
    // name and mid-case throttling was misclassified as non-retryable.
    expect(isThrottlingOrServerError({ name: "ThrottlingException", $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(isRetryableTransportError({ name: "ThrottlingException", $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(isThrottlingOrServerError({ name: "TooManyRequestsException" })).toBe(true);
    expect(isThrottlingOrServerError({ name: "SomethingElse", $metadata: { httpStatusCode: 502 } })).toBe(true);
    expect(isThrottlingOrServerError({ name: "ValidationException", $metadata: { httpStatusCode: 400 } })).toBe(false);
  });
});

describe("required-tool enforcement (mechanical, no judge)", () => {
  it("fails a run that never calls a non-optional expectedToolTrajectory tool", async () => {
    // QA_CASE requires load_blueprint and WorkflowOutput___report_completion;
    // this agent answers in prose without touching either.
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t7", converse: async () => endTurn() });
    expect(run.status).toBe("failed_required_tool");
    expect(run.missingRequiredTools).toEqual(["load_blueprint", "WorkflowOutput___report_completion"]);
  });

  it("does not enforce optional trajectory entries", async () => {
    const caseDef = {
      ...QA_CASE,
      referenceInputs: {
        ...QA_CASE.referenceInputs,
        expectedToolTrajectory: [
          { tool: "load_blueprint", optional: false },
          { tool: "Tickets___add_comment", optional: true },
        ],
      },
    };
    const script = [toolUse("load_blueprint", { blueprint_name: "qa-verifier" }), endTurn()];
    let i = 0;
    const run = await runCase({ caseDef, repoRoot: REPO_ROOT, runId: "t8", converse: async () => script[i++] });
    expect(run.status).toBe("completed");
    expect(run.missingRequiredTools).toEqual([]);
  });

  it("forbidden-tool failure takes precedence over a missing required tool", async () => {
    const script = [
      toolUse("Tickets___transition_ticket", { ticket_id: "BATT-110", transition_id: "done" }),
      endTurn(),
    ];
    let i = 0;
    const run = await runCase({ caseDef: QA_CASE, repoRoot: REPO_ROOT, runId: "t9", converse: async () => script[i++] });
    expect(run.status).toBe("failed_forbidden_tool");
  });
});

describe("message building", () => {
  it("replays transcripts as prior messages, coalescing to keep roles alternating", () => {
    const transcript = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" }, // trailing user — taskPrompt must coalesce onto it
    ];
    const messages = buildMessages(transcript, "the task");
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].content.map((c: any) => c.text)).toEqual(["second", "the task"]);
  });

  it("prefixes a user turn when a transcript starts with the assistant", () => {
    const messages = buildMessages([{ role: "assistant", content: "hello" }], "the task");
    expect(messages[0].role).toBe("user");
  });
});

describe("tier map + cost accounting", () => {
  it("mirrors CODING_MODEL_TIERS from deploy/runtime-agent/main.py", () => {
    const mainPy = readFileSync(join(REPO_ROOT, "deploy/runtime-agent/main.py"), "utf8");
    for (const [tier, modelId] of Object.entries(MODEL_TIERS)) {
      expect(mainPy).toContain(`"${tier}": "${modelId}"`);
    }
  });

  it("prices usage per tier", () => {
    expect(usageCostUsd("haiku", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(6);
    expect(usageCostUsd("judge", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(5);
  });
});
