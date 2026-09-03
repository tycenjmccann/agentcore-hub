/**
 * TEAM-3822 — pipeline-tools Lambda regression suite (first test file for this
 * Lambda).
 *
 * Drives the REAL `handler` export with the three AWS SDK clients mocked at the
 * module seam (same vi.mock + vi.hoisted shape as
 * lambda/orchestrator/agent-invoker-retry.test.mjs), so the execution-scoped
 * get_state race fix, the get_build_status scan clamp, and the start_deploy
 * idempotency token are all exercised end-to-end with no AWS and no
 * credentials.
 *
 * Pinned defects:
 *  1. get_state computed terminal/succeeded from ALL stageStates, so right
 *     after start_deploy a poll could read the PREVIOUS execution's all-green
 *     stages as the new run's completion. Now: execution_id scopes the
 *     computation and matchesExecution:false forces terminal:false.
 *  2. get_build_status's `Math.min(Number(args.scan) || 15, 50)` let a negative
 *     scan invert ids.slice(0, n) into a from-end slice (dropping the NEWEST
 *     builds). Now: integer clamp to [1, 50], non-numeric → 15.
 *  3. start_deploy sent no clientRequestToken, so a retried tool call
 *     double-triggered the pipeline. Now: commit_sha derives a charset/length-
 *     valid token; no sha → token OMITTED (never empty/invalid).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    cpCalls: [], // { type, input } for every CodePipeline command sent
    cbCalls: [], // { type, input } for every CodeBuild command sent
    getPipelineStateImpl: async () => ({ stageStates: [] }),
    listActionExecutionsImpl: async () => ({ actionExecutionDetails: [] }),
    startPipelineExecutionImpl: async () => ({ pipelineExecutionId: "exec-new" }),
    listBuildsImpl: async () => ({ ids: [] }),
    batchGetBuildsImpl: async (input) => ({
      builds: (input.ids || []).map((id) => ({
        id,
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: `sha-${id}`,
        sourceVersion: `pr/${id}`,
        endTime: "2026-01-01T00:00:00Z",
      })),
    }),
  },
}));

vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class {
    async send(cmd) {
      const type = cmd?.__type;
      h.state.cpCalls.push({ type, input: cmd.input });
      if (type === "GetPipelineState") return h.state.getPipelineStateImpl(cmd.input);
      if (type === "ListActionExecutions") return h.state.listActionExecutionsImpl(cmd.input);
      if (type === "StartPipelineExecution") return h.state.startPipelineExecutionImpl(cmd.input);
      return {};
    }
  },
  GetPipelineStateCommand: class { constructor(i) { this.input = i; this.__type = "GetPipelineState"; } },
  StartPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "StartPipelineExecution"; } },
  ListActionExecutionsCommand: class { constructor(i) { this.input = i; this.__type = "ListActionExecutions"; } },
}));

vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class {
    async send(cmd) {
      const type = cmd?.__type;
      h.state.cbCalls.push({ type, input: cmd.input });
      if (type === "ListBuildsForProject") return h.state.listBuildsImpl(cmd.input);
      if (type === "BatchGetBuilds") return h.state.batchGetBuildsImpl(cmd.input);
      return {};
    }
  },
  ListBuildsForProjectCommand: class { constructor(i) { this.input = i; this.__type = "ListBuildsForProject"; } },
  BatchGetBuildsCommand: class { constructor(i) { this.input = i; this.__type = "BatchGetBuilds"; } },
}));

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    async send() { return { events: [] }; }
  },
  GetLogEventsCommand: class { constructor(i) { this.input = i; } },
}));

const { handler } = await import("./index.mjs");

/** Invoke the handler the way the runtime's _invoke_lambda does and parse the
 * jsonResult text payload back into an object. */
async function invoke(tool, args = {}) {
  const res = await handler({ name: `Pipeline___${tool}`, arguments: args });
  return JSON.parse(res.content[0].text);
}

/** A GetPipelineState response where every stage is green and belongs to
 * `executionId`. */
function allGreenStages(executionId) {
  return {
    stageStates: ["Source", "Build", "Deploy"].map((stageName) => ({
      stageName,
      latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
      actionStates: [
        {
          actionName: `${stageName}_action`,
          latestExecution: { status: "Succeeded" },
        },
      ],
    })),
  };
}

beforeEach(() => {
  h.state.cpCalls = [];
  h.state.cbCalls = [];
  h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
  h.state.listActionExecutionsImpl = async () => ({ actionExecutionDetails: [] });
  h.state.startPipelineExecutionImpl = async () => ({ pipelineExecutionId: "exec-new" });
  h.state.listBuildsImpl = async () => ({ ids: [] });
});

// ─── 1. Execution-scoped get_state ───────────────────────────────────────────

describe("get_state execution scoping (the post-start_deploy race)", () => {
  it("does NOT report the OLD run's all-green stages as terminal for a NEW execution_id", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("OLD");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(false);
    expect(out.terminal).not.toBe(true);
    expect(out.succeeded).not.toBe(true);
  });

  it("matchesExecution:true + terminal:false while a matching stage is InProgress", async () => {
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Source",
          latestExecution: { status: "InProgress", pipelineExecutionId: "NEW" },
          actionStates: [
            { actionName: "GitHub_main", latestExecution: { status: "InProgress" } },
          ],
        },
        {
          stageName: "Build",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "OLD" },
          actionStates: [
            { actionName: "Build_and_gate", latestExecution: { status: "Succeeded" } },
          ],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.terminal).toBe(false);
    expect(out.succeeded).toBe(false);
  });

  it("matchesExecution:true + terminal/succeeded once the matching stages are all green", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("NEW");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
  });

  it("scopes failure detection to the matching execution only", async () => {
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Source",
          latestExecution: { status: "Failed", pipelineExecutionId: "OLD" },
          actionStates: [],
        },
        {
          stageName: "Build",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "NEW" },
          actionStates: [],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    // The OLD run's failure must not bleed into the NEW run's verdict.
    expect(out.matchesExecution).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
  });

  it("back-compat: omitted execution_id keeps today's unscoped behavior", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("OLD");

    const out = await invoke("get_state", {});

    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
    // matchesExecution is an execution-scoped concept — absent without the arg.
    expect(out).not.toHaveProperty("matchesExecution");
  });
});

// ─── 2. get_build_status scan clamping ───────────────────────────────────────

describe("get_build_status scan clamping", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `build-${i}`); // newest first

  beforeEach(() => {
    h.state.listBuildsImpl = async () => ({ ids: [...twenty] });
  });

  /** Returns the ids get_build_status actually looked up via BatchGetBuilds. */
  async function scannedIds(scan) {
    h.state.cbCalls = [];
    await invoke("get_build_status", { scan });
    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    return batch ? batch.input.ids : [];
  }

  it("negative scan clamps to 1 (never a from-end slice dropping the newest builds)", async () => {
    const ids = await scannedIds(-5);
    expect(ids).toEqual(["build-0"]); // the NEWEST build, not the 15 oldest
    expect(ids.length).toBe(1);
  });

  it("scan 0 clamps to 1 (never an empty scan)", async () => {
    const ids = await scannedIds(0);
    expect(ids).toEqual(["build-0"]);
  });

  it("oversized scan clamps to 50", async () => {
    h.state.listBuildsImpl = async () => ({
      ids: Array.from({ length: 60 }, (_, i) => `build-${i}`),
    });
    const ids = await scannedIds(999);
    expect(ids.length).toBe(50);
    expect(ids[0]).toBe("build-0");
    expect(ids[49]).toBe("build-49");
  });

  it("non-numeric scan falls back to the default 15", async () => {
    const ids = await scannedIds("abc");
    expect(ids.length).toBe(15);
    expect(ids[0]).toBe("build-0");
  });

  it("in-range scan is honored as-is (back-compat)", async () => {
    const ids = await scannedIds(3);
    expect(ids).toEqual(["build-0", "build-1", "build-2"]);
  });
});

// ─── 3. start_deploy idempotency token ───────────────────────────────────────

describe("start_deploy clientRequestToken idempotency", () => {
  function startCall() {
    return h.state.cpCalls.find((c) => c.type === "StartPipelineExecution");
  }

  it("derives a charset/length-valid token from commit_sha", async () => {
    const out = await invoke("start_deploy", { commit_sha: "abc123def" });

    const call = startCall();
    expect(call).toBeDefined();
    const token = call.input.clientRequestToken;
    expect(token).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(1);
    expect(token.length).toBeLessThanOrEqual(128);
    expect(token).toContain("abc123def");
    expect(out.started).toBe(true);
    expect(out.pipelineExecutionId).toBe("exec-new");
  });

  it("sanitizes a dirty sha to the allowed charset", async () => {
    await invoke("start_deploy", { commit_sha: "abc/123+z" });

    const token = startCall().input.clientRequestToken;
    expect(token).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(token).toContain("abc123z");
  });

  it("clamps the token to 128 chars", async () => {
    await invoke("start_deploy", { commit_sha: "a".repeat(500) });

    const token = startCall().input.clientRequestToken;
    expect(token).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(token.length).toBe(128);
  });

  it("OMITS clientRequestToken entirely when no commit_sha is given", async () => {
    await invoke("start_deploy", {});

    const call = startCall();
    expect(call).toBeDefined();
    expect(call.input).not.toHaveProperty("clientRequestToken");
  });

  it("OMITS clientRequestToken when the sanitized sha is empty (never sends an invalid token)", async () => {
    await invoke("start_deploy", { commit_sha: "///+++" });

    expect(startCall().input).not.toHaveProperty("clientRequestToken");
  });
});
