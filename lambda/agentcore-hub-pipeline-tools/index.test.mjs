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
 *
 * TEAM-4337 makes the CD registry the runtime allow-list, so the mocks now
 * record WHICH CLIENT a command went to, not just which command was sent:
 *  - the S3 mock is KEY-AWARE (config/cd-registry.json vs the handoff marker),
 *  - the CodePipeline/CodeBuild/Logs mocks capture their constructor region and
 *    tag every recorded call with it.
 * Multi-target tests therefore assert two things a single-target suite could
 * not: that a request reached the RIGHT REGION, and that a refusal reached no
 * AWS client at all. Section 8 holds them; every mock addition is additive, so
 * sections 1-7 read `.type`/`.input` exactly as before.
 *
 * TEAM-4348 (code review of TEAM-4337/4338) closes three places where the
 * RESOLVED target and the resource actually touched could diverge:
 *  5. get_build_log fell back to the resolved target (`|| target`) when the
 *     project parsed out of build_id was not any target's, so an unregistered
 *     build_id project still drove BatchGetBuilds + GetLogEvents. Now:
 *     project_not_registered, zero AWS calls; a disagreeing args.project +
 *     build_id project is project_mismatch, also zero AWS calls.
 *  6. resolveTarget resolved args.project BEFORE the requirePipelineName
 *     check, so start_deploy({project, commit_sha}) could start a pipeline
 *     execution without ever passing pipeline_name. Now: the project branch is
 *     skipped entirely for requirePipelineName calls.
 *  7. start_ci_build and get_build_status built their clients from the
 *     pipeline_name-resolved target while the project came from elsewhere, so
 *     a cross-region call reached the wrong region. Now: region follows the
 *     project's OWNER, and get_build_status allow-lists its project too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// Section 8.10 asserts on the SOURCE of index.mjs, not on its behaviour: no
// runtime test can prove an approval path is absent from every code path.
import { readFile } from "node:fs/promises";

/** NoSuchKey, the way S3 raises it — the default for BOTH mocked keys. */
function noSuchKey() {
  const err = new Error("NoSuchKey");
  err.name = "NoSuchKey";
  return err;
}

const h = vi.hoisted(() => ({
  // The S3 key the Lambda reads the CD registry from. Hoisted so the key-aware
  // S3 mock factory can see it (mock factories run before top-level consts).
  CD_REGISTRY_KEY: "config/cd-registry.json",
  state: {
    cpCalls: [], // { region, name, type, input } for every CodePipeline command sent
    cbCalls: [], // { region, name, type, input } for every CodeBuild command sent
    logsCalls: [], // { region, name, type, input } for every Logs command sent
    stsCalls: [], // { region, input } for every STS AssumeRole (cross-account only)
    clientInits: [], // { kind, region, hasCreds } for every AWS client CONSTRUCTED
    // Cross-account: the temp creds AssumeRole hands back. The cp/cb/logs mocks
    // resolve their `credentials` provider in send() (a real client would, when
    // signing), so a cross-account tool call actually reaches this stub.
    assumeRoleImpl: async () => ({
      Credentials: {
        AccessKeyId: "ASIA-XACCT",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date(Date.now() + 900_000),
      },
    }),
    getPipelineStateImpl: async () => ({ stageStates: [] }),
    listActionExecutionsImpl: async () => ({ actionExecutionDetails: [] }),
    startPipelineExecutionImpl: async () => ({ pipelineExecutionId: "exec-new" }),
    getPipelineExecutionImpl: async () => ({ pipelineExecution: { artifactRevisions: [] } }),
    s3Calls: [], // { Bucket, Key } for every GetObject, registry reads included
    // config/cd-registry.json. Default NoSuchKey = "no registry" = env target only,
    // which is what every pre-TEAM-4337 test assumes.
    registryImpl: async () => {
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    },
    // Every other key (the handoff marker).
    getObjectImpl: async () => {
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    },
    getLogEventsImpl: async () => ({ events: [] }),
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
    constructor(cfg) {
      this.region = cfg?.region;
      this.credentials = cfg?.credentials;
      h.state.clientInits.push({ kind: "codepipeline", region: cfg?.region, hasCreds: typeof cfg?.credentials === "function" });
    }
    async send(cmd) {
      if (typeof this.credentials === "function") await this.credentials();
      const type = cmd?.__type;
      h.state.cpCalls.push({
        region: this.region,
        name: cmd.input?.name ?? cmd.input?.pipelineName ?? null,
        type,
        input: cmd.input,
      });
      if (type === "GetPipelineState") return h.state.getPipelineStateImpl(cmd.input);
      if (type === "ListActionExecutions") return h.state.listActionExecutionsImpl(cmd.input);
      if (type === "StartPipelineExecution") return h.state.startPipelineExecutionImpl(cmd.input);
      if (type === "GetPipelineExecution") return h.state.getPipelineExecutionImpl(cmd.input);
      return {};
    }
  },
  GetPipelineStateCommand: class { constructor(i) { this.input = i; this.__type = "GetPipelineState"; } },
  GetPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "GetPipelineExecution"; } },
  StartPipelineExecutionCommand: class { constructor(i) { this.input = i; this.__type = "StartPipelineExecution"; } },
  ListActionExecutionsCommand: class { constructor(i) { this.input = i; this.__type = "ListActionExecutions"; } },
}));

vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class {
    constructor(cfg) {
      this.region = cfg?.region;
      this.credentials = cfg?.credentials;
      h.state.clientInits.push({ kind: "codebuild", region: cfg?.region, hasCreds: typeof cfg?.credentials === "function" });
    }
    async send(cmd) {
      if (typeof this.credentials === "function") await this.credentials();
      const type = cmd?.__type;
      h.state.cbCalls.push({
        region: this.region,
        name: cmd.input?.projectName ?? null,
        type,
        input: cmd.input,
      });
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

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(cfg) {
      this.region = cfg?.region;
      h.state.clientInits.push({ kind: "s3", region: cfg?.region });
    }
    async send(cmd) {
      h.state.s3Calls.push(cmd.input);
      // KEY-AWARE: the CD registry and the handoff marker share one bucket and
      // one client, so only the Key distinguishes them. Keeping both in s3Calls
      // preserves the existing `.at(-1)` and `toEqual([])` assertions.
      if (cmd.input?.Key === h.CD_REGISTRY_KEY) return h.state.registryImpl(cmd.input);
      return h.state.getObjectImpl(cmd.input);
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    constructor(cfg) {
      this.region = cfg?.region;
      this.credentials = cfg?.credentials;
      h.state.clientInits.push({ kind: "logs", region: cfg?.region, hasCreds: typeof cfg?.credentials === "function" });
    }
    async send(cmd) {
      if (typeof this.credentials === "function") await this.credentials();
      h.state.logsCalls.push({
        region: this.region,
        name: cmd.input?.logGroupName ?? null,
        type: "GetLogEvents",
        input: cmd.input,
      });
      return h.state.getLogEventsImpl(cmd.input);
    }
  },
  GetLogEventsCommand: class { constructor(i) { this.input = i; } },
}));

// Cross-account only: the assume-role provider clientsFor() wires onto a
// cross-account target's clients calls this. Records every AssumeRole so a test
// can assert the RoleArn + ExternalId that reached STS (the confused-deputy
// guard), and that a same-account call never touches it.
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    constructor(cfg) {
      this.region = cfg?.region;
    }
    async send(cmd) {
      h.state.stsCalls.push({ region: this.region, input: cmd.input });
      return h.state.assumeRoleImpl(cmd.input);
    }
  },
  AssumeRoleCommand: class { constructor(i) { this.input = i; } },
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

// ─── TEAM-4337 multi-target fixtures + helpers ───────────────────────────────

/**
 * Two pipelines in two regions plus a DEPLOY.md-mode CD repo (no pipeline, so
 * pipelineProjects() yields nothing and it must NOT become a target). The first
 * entry deliberately names the env default pipeline, so the env target is
 * de-duplicated rather than appended — targets are exactly these two.
 */
const MULTI_REGISTRY = {
  version: 1,
  repos: [
    { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-east-1" },
    { repo: "acme/widget", pipeline: "hub-widget-deploy", region: "us-west-2" },
    { repo: "acme/legacy", deployDoc: "docs/DEPLOY.md" },
  ],
};

/**
 * TEAM-4358 F1 — the same two targets as MULTI_REGISTRY with the hub entry
 * SECOND. Registry ORDER must not decide which target an unqualified call acts
 * on; only PIPELINE_NAME does. Pre-fix, `isEnvDefault` was stamped false on every
 * registry entry, so no target carried it and resolveTarget fell to `targets[0]`
 * — routing every unqualified read AND start_ci_build below to hub-widget-* in
 * us-west-2.
 */
const HUB_SECOND_REGISTRY = {
  version: 1,
  repos: [
    { repo: "acme/widget", pipeline: "hub-widget-deploy", region: "us-west-2" },
    { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-east-1" },
  ],
};

/** Serve `doc` (object or raw string) for the registry key. */
function serveRegistry(doc) {
  h.state.registryImpl = async () => ({
    Body: {
      transformToString: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)),
    },
  });
}

/**
 * A fresh module instance whose CD registry is `doc`.
 *
 * The registry is fetched per invocation but CACHED in module scope, so a test
 * that needs a different registry must re-import — which is exactly what
 * withEnv's vi.resetModules() gives us. There is deliberately no test-only
 * reset export on index.mjs.
 *
 * Client constructions and S3 calls made while the module was loading are
 * discarded, so a test can assert exactly what ONE INVOCATION touched.
 */
async function withRegistry(doc, fn, env = {}) {
  if (doc !== null) serveRegistry(doc);
  return withEnv({ ARTIFACT_BUCKET: "hub-artifacts-test", ...env }, async (mod) => {
    h.state.clientInits = [];
    h.state.s3Calls = [];
    h.state.stsCalls = [];
    return fn(mod);
  });
}

/** Regions of every client of `kind` constructed since the last reset. */
function initRegions(kind) {
  return h.state.clientInits.filter((c) => c.kind === kind).map((c) => c.region);
}

beforeEach(() => {
  h.state.cpCalls = [];
  h.state.cbCalls = [];
  h.state.logsCalls = [];
  h.state.stsCalls = [];
  h.state.clientInits = [];
  h.state.assumeRoleImpl = async () => ({
    Credentials: {
      AccessKeyId: "ASIA-XACCT",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
  // Back to "no registry", so the shared top-level `handler` resolves the env
  // default target and every pre-TEAM-4337 suite behaves exactly as before.
  h.state.registryImpl = async () => {
    throw noSuchKey();
  };
  h.state.getLogEventsImpl = async () => ({ events: [] });
  h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
  h.state.listActionExecutionsImpl = async () => ({ actionExecutionDetails: [] });
  h.state.startPipelineExecutionImpl = async () => ({ pipelineExecutionId: "exec-new" });
  h.state.getPipelineExecutionImpl = async () => ({
    pipelineExecution: { artifactRevisions: [] },
  });
  h.state.s3Calls = [];
  h.state.getObjectImpl = async () => {
    const err = new Error("NoSuchKey");
    err.name = "NoSuchKey";
    throw err;
  };
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
    expect(out.detail).not.toContain("not authorized to perform");

    // TEAM-4358: after TEAM-4337's convention IAM, three causes produce this
    // denial — the flag being unset is only one of them, and the text used to
    // name it as if it were the only one.
    expect(out.detail).toContain("PIPELINE_REGIONS");
    expect(out.detail).toContain("hub-*-ci");
    // Which region was refused is half the diagnosis: the grant is fanned out
    // per region, so the same project name can be granted in one and not another.
    // The env target's region, resolved the same way index.mjs does (no registry
    // here, so this is the module-load REGION).
    expect(out.region).toBe(process.env.AWS_REGION || "us-east-1");
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

    // The flat keys describe the ENV DEFAULT and are kept verbatim for callers
    // written against version 2. version 3 (TEAM-4337) adds `targets` — asserted
    // in the multi-target suite, not here.
    expect(out).toMatchObject({
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployPipeline: "agentcore-hub-deploy",
      version: 3,
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

// ─── Infra handoff on a SUCCEEDED run ────────────────────────────────────────
// The Deploy stage used to `exit 2` when a changeset also touched infra-only
// files: a green deploy reported as a Failed action. "Failed" then meant either
// a real failure or a clean deploy with a follow-up, and only a build log could
// tell them apart — six straight Failed executions (2026-09-08/09) is what made
// the pipeline unreadable. It now succeeds and records the file list in S3;
// get_state reports that as `handoff` data.

describe("get_state infra handoff marker", () => {
  const sha = "a7679ed62d8af7251518fcb21e154698f09e9242";

  function withRevision(revisionId) {
    h.state.getPipelineExecutionImpl = async () => ({
      pipelineExecution: { artifactRevisions: [{ revisionId }] },
    });
  }

  it("reports handoff files on a run whose Deploy stage wrote a marker", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("exec-1");
    withRevision(sha);
    h.state.getObjectImpl = async () => ({
      Body: {
        transformToString: async () =>
          "deploy/setup-pipeline-tools-lambda.mjs\ndeploy/setup-lambda-role.sh\n",
      },
    });

    const out = await withEnv({ ARTIFACT_BUCKET: "bucket-x" }, (mod) =>
      invokeOn(mod.handler, "get_state", { execution_id: "exec-1" })
    );

    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.handoff.files).toEqual([
      "deploy/setup-pipeline-tools-lambda.mjs",
      "deploy/setup-lambda-role.sh",
    ]);
    // Keyed on the 12-char GIT_SHA the Build stage uses, under the one prefix
    // this role can read.
    expect(h.state.s3Calls.at(-1)).toEqual({
      Bucket: "bucket-x",
      Key: `pipeline-artifacts/handoff/${sha.slice(0, 12)}.txt`,
    });
  });

  it("returns handoff null when the deploy had nothing to hand off", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("exec-1");
    withRevision(sha);
    const out = await withEnv({ ARTIFACT_BUCKET: "bucket-x" }, (mod) =>
      invokeOn(mod.handler, "get_state", { execution_id: "exec-1" })
    );
    expect(out.succeeded).toBe(true);
    expect(out.handoff).toBe(null);
  });

  it("never fails get_state when the marker lookup errors", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("exec-1");
    withRevision(sha);
    h.state.getObjectImpl = async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDenied";
      throw err;
    };
    const out = await withEnv({ ARTIFACT_BUCKET: "bucket-x" }, (mod) =>
      invokeOn(mod.handler, "get_state", { execution_id: "exec-1" })
    );
    expect(out.succeeded).toBe(true);
    expect(out.handoff).toBe(null);
  });

  it("does not call S3 at all when no artifact bucket is configured", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("exec-1");
    withRevision(sha);
    const out = await withEnv({ ARTIFACT_BUCKET: undefined }, (mod) =>
      invokeOn(mod.handler, "get_state", { execution_id: "exec-1" })
    );
    expect(out.handoff).toBe(null);
    expect(h.state.s3Calls).toEqual([]);
  });
});

// ─── 8. Multi-target resolution off the CD registry (TEAM-4337) ──────────────

/**
 * The registry — not env, and not the caller's args — is the allow-list. These
 * cases pin the three properties that make that safe:
 *
 *   1. ROUTING. A registered pipeline in another region is reached with a client
 *      constructed for THAT region, and the env default still reaches REGION.
 *   2. REFUSAL COSTS NOTHING. An unregistered pipeline/project, or an ambiguous
 *      deploy, is answered from the registry alone: zero AWS commands, and for
 *      a pipeline refusal not even a CodePipeline client construction.
 *   3. (TEAM-4348) THE PROJECT'S OWNER WINS THE REGION. When a call names a
 *      project some OTHER way than pipeline_name (a build_id's embedded
 *      project, or an explicit project alongside an unrelated pipeline_name),
 *      the client region and the response `region` follow that project's own
 *      target — never the pipeline_name-resolved one, and never a silent
 *      `|| target` fallback into an unregistered name.
 *
 * Every case goes through withRegistry -> withEnv, because both the env values
 * and the registry cache are per-module-instance.
 */
describe("multi-target registry resolution", () => {
  const WIDGET = "hub-widget-deploy";
  const HUB = "agentcore-hub-deploy";

  // 8.1 region routing ──────────────────────────────────────────────────────

  it("routes a registry target's get_state to that target's region", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_state", { pipeline_name: WIDGET })
    );

    expect(out.pipelineName).toBe(WIDGET);
    expect(out.region).toBe("us-west-2");
    expect(out.repo).toBe("acme/widget");

    const call = h.state.cpCalls.find((c) => c.type === "GetPipelineState");
    expect(call.region).toBe("us-west-2");
    expect(call.name).toBe(WIDGET);
    // The pipeline's region, and ONLY that region, got a client.
    expect(initRegions("codepipeline")).toEqual(["us-west-2"]);
  });

  it("routes the env default target to REGION, not to a registry region", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    // Registry absent -> the env default is the only target.
    await withRegistry(null, (mod) => invokeOn(mod.handler, "get_state", {}), {
      AWS_REGION: "us-east-1",
    });

    const call = h.state.cpCalls.find((c) => c.type === "GetPipelineState");
    expect(call.region).toBe("us-east-1");
    expect(call.name).toBe(HUB);
  });

  // 8.1b (TEAM-4358) registry ORDER never picks the default target ──────────
  //
  // Every case here is UNQUALIFIED (no pipeline_name, no project, no build_id):
  // the tool must fall back to the target this deployment is CONFIGURED for
  // (PIPELINE_NAME), which in HUB_SECOND_REGISTRY is the second entry. Each
  // asserts both halves — the hub resource was used, AND no client was ever even
  // constructed for the other target's region. `initRegions` is emptied by
  // withRegistry after module load, so these counts are one invocation's.

  it("resolves an unqualified get_state to PIPELINE_NAME, not to the first registry entry", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });

    const out = await withRegistry(HUB_SECOND_REGISTRY, (mod) => invokeOn(mod.handler, "get_state", {}), {
      AWS_REGION: "us-east-1",
    });

    expect(out.pipelineName).toBe(HUB);
    expect(out.region).toBe("us-east-1");
    expect(out.repo).toBe("tycenjmccann/agentcore-hub");

    const call = h.state.cpCalls.find((c) => c.type === "GetPipelineState");
    expect(call.name).toBe(HUB);
    expect(call.region).toBe("us-east-1");
    // The other target's region never got a client at all.
    expect(initRegions("codepipeline")).toEqual(["us-east-1"]);
  });

  it("starts an unqualified CI build on the hub's CI project, with the 3-key allow-list intact", async () => {
    const sha = "9".repeat(40);

    const out = await withRegistry(
      HUB_SECOND_REGISTRY,
      (mod) => invokeOn(mod.handler, "start_ci_build", { commit_sha: sha }),
      { AWS_REGION: "us-east-1" }
    );

    expect(out.ok).toBe(true);
    expect(out.region).toBe("us-east-1");
    // Pre-fix this StartBuild went to hub-widget-ci in us-west-2 — another repo's
    // PR check, started off another repo's registry position.
    const start = h.state.cbCalls.find((c) => c.type === "StartBuild");
    expect(start.input).toEqual({
      projectName: "agentcore-hub-ci",
      sourceVersion: sha,
      idempotencyToken: `ci-${sha}`,
    });
    expect(start.region).toBe("us-east-1");
    // Every CodeBuild call of this invocation (the dedupe scan included).
    expect([...new Set(h.state.cbCalls.map((c) => c.region))]).toEqual(["us-east-1"]);
    expect(h.state.cbCalls.some((c) => /^hub-widget-/.test(c.name || ""))).toBe(false);
  });

  it("scans the hub's CI project for an unqualified get_build_status", async () => {
    h.state.listBuildsImpl = async () => ({
      ids: ["agentcore-hub-ci:33333333-2222-3333-4444-555555555555"],
    });

    const out = await withRegistry(
      HUB_SECOND_REGISTRY,
      (mod) => invokeOn(mod.handler, "get_build_status", {}),
      { AWS_REGION: "us-east-1" }
    );

    expect(out.project).toBe("agentcore-hub-ci");
    expect(out.region).toBe("us-east-1");
    const list = h.state.cbCalls.find((c) => c.type === "ListBuildsForProject");
    expect(list.name).toBe("agentcore-hub-ci");
    expect(initRegions("codebuild")).toEqual(["us-east-1"]);
  });

  it("reads the hub's build project for an unqualified get_build_log (no build_id)", async () => {
    h.state.listBuildsImpl = async () => ({
      ids: ["agentcore-hub-build:44444444-2222-3333-4444-555555555555"],
    });

    const out = await withRegistry(
      HUB_SECOND_REGISTRY,
      (mod) => invokeOn(mod.handler, "get_build_log", {}),
      { AWS_REGION: "us-east-1" }
    );

    expect(out.project).toBe("agentcore-hub-build");
    expect(out.region).toBe("us-east-1");
    const list = h.state.cbCalls.find((c) => c.type === "ListBuildsForProject");
    expect(list.name).toBe("agentcore-hub-build");
    expect(h.state.cbCalls.some((c) => /^hub-widget-/.test(c.name || ""))).toBe(false);
    expect(initRegions("codebuild")).toEqual(["us-east-1"]);
    expect(initRegions("logs")).not.toContain("us-west-2");
  });

  it("still refuses an unqualified start_deploy — the fix widens no write path", async () => {
    const out = await withRegistry(
      HUB_SECOND_REGISTRY,
      (mod) => invokeOn(mod.handler, "start_deploy", { commit_sha: "a".repeat(40) }),
      { AWS_REGION: "us-east-1" }
    );

    // A default target for the READ tools must never become a default DEPLOY.
    expect(out).toEqual({
      ok: false,
      reason: "pipeline_name_required",
      known: [WIDGET, HUB],
    });
    expect(h.state.cpCalls).toEqual([]);
    expect(initRegions("codepipeline")).toEqual([]);
  });

  // 8.2 refusals make no AWS call ───────────────────────────────────────────

  it("refuses an unregistered pipeline_name with zero CodePipeline traffic", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_state", { pipeline_name: "someone-elses-deploy" })
    );

    expect(out).toEqual({
      ok: false,
      reason: "pipeline_not_registered",
      requested: "someone-elses-deploy",
      known: [HUB, WIDGET],
    });
    expect(h.state.cpCalls).toEqual([]);
    // Not even a client: resolution happens before any client is asked for.
    expect(initRegions("codepipeline")).toEqual([]);
  });

  it("refuses an unregistered project with zero CodeBuild traffic", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_status", { project: "someone-elses-ci" })
    );

    expect(out.ok).toBe(false);
    expect(out.reason).toBe("project_not_registered");
    expect(out.requested).toBe("someone-elses-ci");
    // Every project of every target, so the caller can correct itself.
    expect(out.known).toEqual(
      expect.arrayContaining(["agentcore-hub-ci", "hub-widget-ci", "hub-widget-build", WIDGET])
    );
    expect(h.state.cbCalls).toEqual([]);
    expect(initRegions("codebuild")).toEqual([]);
  });

  it("refuses start_deploy without pipeline_name when more than one target exists", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_deploy", { commit_sha: "a".repeat(40) })
    );

    expect(out).toEqual({
      ok: false,
      reason: "pipeline_name_required",
      known: [HUB, WIDGET],
    });
    // The one WRITE this Lambda can make never happens on a guess. A project
    // cannot substitute for pipeline_name either — see 8.2b below.
    expect(h.state.cpCalls).toEqual([]);
  });

  // 8.2b (TEAM-4348) args.project cannot substitute for pipeline_name ───────

  it("refuses start_deploy that names only a project — project is not a deploy input", async () => {
    for (const project of ["agentcore-hub-ci", "hub-widget-build"]) {
      h.state.cpCalls = [];
      h.state.clientInits = [];
      const out = await withRegistry(MULTI_REGISTRY, (mod) =>
        invokeOn(mod.handler, "start_deploy", { project, commit_sha: "a".repeat(40) })
      );

      expect(out, project).toEqual({
        ok: false,
        reason: "pipeline_name_required",
        known: [HUB, WIDGET],
      });
      expect(h.state.cpCalls, project).toEqual([]);
      expect(initRegions("codepipeline"), project).toEqual([]);
    }
  });

  // 8.3 the env default path is unchanged ───────────────────────────────────

  it("sends byte-identical inputs for the env default when no registry exists", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const sha = "b".repeat(40);

    await withRegistry(
      null,
      async (mod) => {
        await invokeOn(mod.handler, "get_state", {});
        await invokeOn(mod.handler, "start_deploy", { commit_sha: sha });
      },
      { AWS_REGION: "us-east-1" }
    );

    // Exactly the pre-TEAM-4337 payloads — no extra key, no target metadata.
    expect(h.state.cpCalls.find((c) => c.type === "GetPipelineState").input).toEqual({
      name: HUB,
    });
    expect(h.state.cpCalls.find((c) => c.type === "StartPipelineExecution").input).toEqual({
      name: HUB,
      clientRequestToken: `deploy-${sha}`,
    });
  });

  it("routes start_deploy to the requested target's region", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_deploy", { pipeline_name: WIDGET })
    );

    expect(out.pipelineName).toBe(WIDGET);
    expect(out.region).toBe("us-west-2");
    const call = h.state.cpCalls.find((c) => c.type === "StartPipelineExecution");
    expect(call.region).toBe("us-west-2");
    expect(call.name).toBe(WIDGET);
  });

  // 8.4 error text names the REQUESTED pipeline ─────────────────────────────

  it("names the requested pipeline and region in the not-found error", async () => {
    h.state.getPipelineStateImpl = async () => {
      const err = new Error("nope");
      err.name = "PipelineNotFoundException";
      throw err;
    };

    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_state", { pipeline_name: WIDGET })
    );

    // Not the env defaults: an operator reading this must see what was asked for.
    expect(out.configured).toBe(false);
    expect(out.error).toBe(`Pipeline "${WIDGET}" not found in us-west-2`);
    expect(out.error).not.toContain(HUB);
    expect(out.error).not.toContain("us-east-1");
  });

  // 8.5 get_build_log infers the project, and the region, from the build id ──

  it("infers the owning project and region from a build_id", async () => {
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: [
        {
          id: input.ids[0],
          buildStatus: "FAILED",
          phases: [],
          logs: { groupName: "/aws/codebuild/hub-widget-build", streamName: "stream-1" },
        },
      ],
    });
    h.state.getLogEventsImpl = async () => ({ events: [{ message: "boom" }] });

    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_log", {
        build_id: "hub-widget-build:11111111-2222-3333-4444-555555555555",
      })
    );

    // `project` is optional: the id carries it as "<projectName>:<uuid>".
    expect(out.project).toBe("hub-widget-build");
    expect(out.region).toBe("us-west-2");

    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    expect(batch.region).toBe("us-west-2");
    // A known build id needs no scan of the project's history.
    expect(h.state.cbCalls.some((c) => c.type === "ListBuildsForProject")).toBe(false);
    expect(h.state.logsCalls.map((c) => c.region)).toEqual(["us-west-2"]);
  });

  // 8.5b (TEAM-4348) the build_id's project is allow-listed too ─────────────

  it("refuses a build_id whose project is not registered, with zero CodeBuild and Logs traffic", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_log", {
        build_id: "hub-unregistered-build:11111111-2222-3333-4444-555555555555",
      })
    );

    expect(out).toEqual({
      ok: false,
      reason: "project_not_registered",
      requested: "hub-unregistered-build",
      known: expect.arrayContaining([
        "agentcore-hub-ci",
        "agentcore-hub-build",
        HUB,
        "hub-widget-ci",
        "hub-widget-build",
        WIDGET,
      ]),
    });
    expect(h.state.cbCalls).toEqual([]);
    expect(h.state.logsCalls).toEqual([]);
    // Not even a client: the refusal happens before clientsFor is ever called.
    expect(initRegions("codebuild")).toEqual([]);
    expect(initRegions("logs")).toEqual([]);
  });

  it("refuses a project that disagrees with the build_id's project instead of picking one", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_log", {
        project: "agentcore-hub-build",
        build_id: "hub-widget-build:11111111-2222-3333-4444-555555555555",
      })
    );

    expect(out).toEqual({
      ok: false,
      reason: "project_mismatch",
      requested: "agentcore-hub-build",
      buildIdProject: "hub-widget-build",
    });
    expect(h.state.cbCalls).toEqual([]);
    expect(h.state.logsCalls).toEqual([]);
    expect(initRegions("codebuild")).toEqual([]);
    expect(initRegions("logs")).toEqual([]);
  });

  it("reads the build_id's OWNER region even when pipeline_name names another target", async () => {
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: [
        {
          id: input.ids[0],
          buildStatus: "FAILED",
          phases: [],
          logs: { groupName: "/aws/codebuild/hub-widget-build", streamName: "stream-1" },
        },
      ],
    });
    h.state.getLogEventsImpl = async () => ({ events: [{ message: "boom" }] });

    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_log", {
        pipeline_name: HUB,
        build_id: "hub-widget-build:11111111-2222-3333-4444-555555555555",
      })
    );

    expect(out.project).toBe("hub-widget-build");
    expect(out.region).toBe("us-west-2");
    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    expect(batch.region).toBe("us-west-2");
    expect(h.state.logsCalls.map((c) => c.region)).toEqual(["us-west-2"]);
  });

  // 8.6 start_ci_build on a registry target ─────────────────────────────────

  it("starts a registry target's CI project with the 3-key allow-list in its region", async () => {
    const sha = "c".repeat(40);
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", { project: "hub-widget-ci", commit_sha: sha })
    );

    expect(out.ok).toBe(true);
    const start = h.state.cbCalls.find((c) => c.type === "StartBuild");
    expect(start.region).toBe("us-west-2");
    // Deep-equal, not toMatchObject: a fourth key is the defect.
    expect(start.input).toEqual({
      projectName: "hub-widget-ci",
      sourceVersion: sha,
      idempotencyToken: `ci-${sha}`,
    });
  });

  // 8.7 start_ci_build can never reach a deploy project ─────────────────────

  it("never starts a deploy project, even when asked for one by name", async () => {
    const sha = "d".repeat(40);
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", { project: WIDGET, commit_sha: sha })
    );

    // A registered name resolves the TARGET, then the CI project is taken from
    // the target - a non-CI project is ignored, never honoured (and never
    // rejected, so a retry loop cannot probe for one).
    expect(out.ok).toBe(true);
    const start = h.state.cbCalls.find((c) => c.type === "StartBuild");
    expect(start.input.projectName).toBe("hub-widget-ci");
    expect(h.state.cbCalls.some((c) => c.name === WIDGET)).toBe(false);
    expect(h.state.cbCalls.some((c) => /-deploy$/.test(c.name || ""))).toBe(false);
  });

  it("refuses a registry ciProject that collides with another target's deploy project", async () => {
    const out = await withRegistry(
      {
        version: 1,
        repos: [
          { repo: "acme/widget", pipeline: WIDGET, region: "us-west-2", ciProject: HUB },
        ],
      },
      (mod) =>
        invokeOn(mod.handler, "start_ci_build", {
          pipeline_name: WIDGET,
          commit_sha: "e".repeat(40),
        })
    );

    // Validated per call, against EVERY target's names - the module-load check
    // could not see this value.
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("ci_project_invalid");
    expect(h.state.cbCalls.filter((c) => c.type === "StartBuild")).toEqual([]);
  });

  it("refuses the reserved runtime-image project, with zero AWS traffic", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", {
        project: "agentcore-hub-runtime-image-deploy",
        commit_sha: "f".repeat(40),
      })
    );

    // Not any target's project, so it is refused at resolution - the reserved
    // list never even has to be consulted.
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("project_not_registered");
    expect(h.state.cbCalls).toEqual([]);
  });

  // 8.6b (TEAM-4348) region follows the project's owner, not the ─────────────
  // pipeline_name-resolved target ────────────────────────────────────────────

  it("start_ci_build sends every CodeBuild call to the CI project's own region", async () => {
    const sha = "1".repeat(40);
    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", {
        pipeline_name: HUB,
        project: "hub-widget-ci",
        commit_sha: sha,
      })
    );

    expect(out.ok).toBe(true);
    expect(out.region).toBe("us-west-2");
    // Every CodeBuild call this invocation made — the dedupe scan AND
    // StartBuild — went to the project's own region, not HUB's (us-east-1).
    expect(h.state.cbCalls.length).toBeGreaterThan(0);
    expect([...new Set(h.state.cbCalls.map((c) => c.region))]).toEqual(["us-west-2"]);
    const start = h.state.cbCalls.find((c) => c.type === "StartBuild");
    expect(start.input).toEqual({
      projectName: "hub-widget-ci",
      sourceVersion: sha,
      idempotencyToken: `ci-${sha}`,
    });
  });

  it("get_build_status scans the project's own region, and refuses an unregistered project even with a pipeline_name", async () => {
    h.state.listBuildsImpl = async () => ({ ids: ["hub-widget-ci:22222222-2222-3333-4444-555555555555"] });

    const ok = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_status", {
        pipeline_name: HUB,
        project: "hub-widget-ci",
      })
    );
    expect(ok.region).toBe("us-west-2");
    const list = h.state.cbCalls.find((c) => c.type === "ListBuildsForProject");
    expect(list.region).toBe("us-west-2");

    h.state.cbCalls = [];
    const bad = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_build_status", {
        pipeline_name: HUB,
        project: "someone-elses-ci",
      })
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("project_not_registered");
    expect(h.state.cbCalls).toEqual([]);
  });

  // 8.8 registry read failures degrade to the env target ────────────────────

  it("falls back to the env target when the registry read is denied", async () => {
    h.state.registryImpl = async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDenied";
      throw err;
    };

    const out = await withRegistry(null, (mod) => invokeOn(mod.handler, "capabilities"), {
      AWS_REGION: "us-east-1",
    });

    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].pipeline).toBe(HUB);
    expect(out.targets[0].region).toBe("us-east-1");
  });

  it("treats a missing registry object as an empty registry", async () => {
    // beforeEach already installs the NoSuchKey default; assert it explicitly.
    const out = await withRegistry(null, (mod) => invokeOn(mod.handler, "capabilities"));

    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].pipeline).toBe(HUB);
    expect(h.state.s3Calls.map((c) => c.Key)).toEqual(["config/cd-registry.json"]);
  });

  it("keeps the last good registry copy when a later read fails", async () => {
    await withRegistry(
      MULTI_REGISTRY,
      async (mod) => {
        const first = await invokeOn(mod.handler, "capabilities");
        expect(first.targets.map((t) => t.pipeline)).toEqual([HUB, WIDGET]);

        // Expire the 1ms TTL, then break the read.
        await new Promise((resolve) => setTimeout(resolve, 10));
        h.state.registryImpl = async () => {
          const err = new Error("AccessDenied");
          err.name = "AccessDenied";
          throw err;
        };

        const second = await invokeOn(mod.handler, "capabilities");
        expect(second.targets.map((t) => t.pipeline)).toEqual([HUB, WIDGET]);
        // It really did re-read - this is a retained copy, not a cache hit.
        expect(h.state.s3Calls).toHaveLength(2);
      },
      { CD_REGISTRY_TTL_MS: "1" }
    );
  });

  // 8.8b (TEAM-4358) a malformed body is a failed read, not "nothing registered"

  it("keeps the last good registry copy when a later read returns a malformed body", async () => {
    await withRegistry(
      MULTI_REGISTRY,
      async (mod) => {
        const first = await invokeOn(mod.handler, "capabilities");
        expect(first.targets.map((t) => t.pipeline)).toEqual([HUB, WIDGET]);

        // Expire the 1ms TTL, then serve a truncated document. parseCdRegistry is
        // tolerant, so pre-fix this became an EMPTY registry, was assigned over
        // the cache, and un-registered acme/widget for the whole TTL.
        await new Promise((resolve) => setTimeout(resolve, 10));
        serveRegistry("{not json");

        const second = await invokeOn(mod.handler, "capabilities");
        expect(second.targets.map((t) => t.pipeline)).toEqual([HUB, WIDGET]);
        // It really did re-read — a retained copy, not a cache hit.
        expect(h.state.s3Calls).toHaveLength(2);
      },
      { CD_REGISTRY_TTL_MS: "1" }
    );
  });

  it("does not re-read S3 on every invocation after a denied read (the TTL window opens anyway)", async () => {
    h.state.registryImpl = async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDenied";
      throw err;
    };

    // Default 60s TTL: two invocations, one read. Pre-fix the failing branch never
    // stamped registryLoadedAt, so every tool call for the container's life paid an
    // S3 GetObject — and every one of them could fail again.
    await withRegistry(
      null,
      async (mod) => {
        const first = await invokeOn(mod.handler, "capabilities");
        const second = await invokeOn(mod.handler, "capabilities");

        for (const out of [first, second]) {
          expect(out.targets).toHaveLength(1);
          expect(out.targets[0].pipeline).toBe(HUB);
          expect(out.targets[0].region).toBe("us-east-1");
        }
        expect(h.state.s3Calls).toHaveLength(1);
      },
      { AWS_REGION: "us-east-1" }
    );
  });

  // 8.9 capabilities v3 ─────────────────────────────────────────────────────

  it("reports version 3 with one entry per target and the flat keys intact", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) => invokeOn(mod.handler, "capabilities"), {
      AWS_REGION: "us-east-1",
    });

    expect(out.version).toBe(3);
    // Version-2 callers keep reading exactly what they read before.
    expect(out).toMatchObject({
      startCiBuild: false,
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployPipeline: HUB,
      approveDeploy: false,
    });

    // The DEPLOY.md-mode repo has no pipeline, so it is NOT a target.
    expect(out.targets.map((t) => t.pipeline)).toEqual([HUB, WIDGET]);
    for (const target of out.targets) {
      expect(Object.keys(target).sort()).toEqual([
        "buildProject",
        "ciProject",
        "deployProject",
        "pipeline",
        "region",
        "repo",
        "startCiBuild",
      ]);
    }
    expect(out.targets[1]).toEqual({
      repo: "acme/widget",
      pipeline: WIDGET,
      region: "us-west-2",
      ciProject: "hub-widget-ci",
      buildProject: "hub-widget-build",
      deployProject: WIDGET,
      startCiBuild: false,
    });
  });

  it("narrows capabilities to one target with pipeline_name, and refuses an unknown one", async () => {
    await withRegistry(MULTI_REGISTRY, async (mod) => {
      const one = await invokeOn(mod.handler, "capabilities", { pipeline_name: WIDGET });
      expect(one.targets.map((t) => t.pipeline)).toEqual([WIDGET]);
      // The flat env-default keys are NOT filtered - they describe this Lambda.
      expect(one.deployPipeline).toBe(HUB);

      const bad = await invokeOn(mod.handler, "capabilities", { pipeline_name: "nope-deploy" });
      expect(bad).toEqual({
        ok: false,
        reason: "pipeline_not_registered",
        requested: "nope-deploy",
        known: [HUB, WIDGET],
      });
    });
  });

  // 8.10 the invariant that survives every widening ─────────────────────────

  it("the source contains no PutApprovalResult command, only comments about its absence", async () => {
    const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

    // Widening the allow-list may add pipelines to READ and TRIGGER. It must
    // never add an approval path: the deploy gate is human-only.
    expect(source).not.toMatch(/PutApprovalResultCommand/);
    expect(source).not.toMatch(/new\s+PutApproval/);
    expect(source).not.toMatch(/putApprovalResult/);
    // The only mentions left are the comments asserting it is absent.
    expect(source).toMatch(/DELIBERATELY ABSENT: PutApprovalResult/);
  });
});

// ─── 9. Cross-account CD (assume a hub-cd-trigger-* role in another account) ──
//
// The registry may point a pipeline at ANOTHER AWS account; the tools Lambda
// reaches it by assuming that account's `hub-cd-trigger-<slug>` role with the
// entry's ExternalId (the confused-deputy guard). These pin the two things that
// make that safe and correct: the RoleArn + ExternalId that actually reach STS
// come from the registry entry (never args), and a SAME-account target never
// assumes a role at all — its clients use the ambient credential chain.
describe("cross-account CD (assume-role trigger)", () => {
  const XACCT_REGISTRY = {
    version: 1,
    repos: [
      {
        repo: "tycenjmccann/juno",
        pipeline: "hub-juno-deploy",
        region: "us-west-2",
        account: "023392223961",
        roleArn: "arn:aws:iam::023392223961:role/hub-cd-trigger-juno",
        externalId: "hub-cd-juno-secret",
      },
      { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-east-1" },
    ],
  };

  it("routes a cross-account get_state through an assumed role with the entry's ExternalId", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const out = await withRegistry(XACCT_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_state", { pipeline_name: "hub-juno-deploy" }),
    );

    expect(out.pipelineName).toBe("hub-juno-deploy");
    expect(out.region).toBe("us-west-2");
    expect(out.repo).toBe("tycenjmccann/juno");

    // The CodePipeline call reached the cross-account region, on a client built
    // WITH a credentials provider (the assume-role provider).
    const call = h.state.cpCalls.find((c) => c.type === "GetPipelineState");
    expect(call.region).toBe("us-west-2");
    const init = h.state.clientInits.find((c) => c.kind === "codepipeline");
    expect(init.hasCreds).toBe(true);

    // Exactly one AssumeRole, carrying the entry's RoleArn + ExternalId — not
    // anything from the caller's args.
    expect(h.state.stsCalls).toHaveLength(1);
    expect(h.state.stsCalls[0].input).toMatchObject({
      RoleArn: "arn:aws:iam::023392223961:role/hub-cd-trigger-juno",
      ExternalId: "hub-cd-juno-secret",
      RoleSessionName: "hub-pipeline-tools",
    });
  });

  it("a same-account target in the SAME registry never assumes a role", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const out = await withRegistry(XACCT_REGISTRY, (mod) =>
      invokeOn(mod.handler, "get_state", { pipeline_name: "agentcore-hub-deploy" }),
    );

    expect(out.region).toBe("us-east-1");
    const init = h.state.clientInits.find((c) => c.kind === "codepipeline");
    expect(init.hasCreds).toBe(false);
    expect(h.state.stsCalls).toEqual([]);
  });

  it("a cross-account start_ci_build assumes the role for the CodeBuild client too", async () => {
    const sha = "a".repeat(40);
    const out = await withRegistry(XACCT_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", { pipeline_name: "hub-juno-deploy", commit_sha: sha }),
      { CI_START_BUILD_ENABLED: "1" },
    );

    expect(out.error).toBeUndefined();
    const cbInit = h.state.clientInits.find((c) => c.kind === "codebuild");
    expect(cbInit.region).toBe("us-west-2");
    expect(cbInit.hasCreds).toBe(true);
    expect(h.state.stsCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.state.stsCalls[0].input.RoleArn).toBe("arn:aws:iam::023392223961:role/hub-cd-trigger-juno");
  });
});

// ─── 9. iOS App Store release pipeline (a SECOND target per repo) ─────────────
//
// An entry's `iosPipeline` (hub-<slug>-ios-deploy) becomes a target alongside
// its backend `pipeline`, so the release manager can trigger + watch the App
// Store release with the same Pipeline___* tools. It is a hub-*-deploy name, so
// it needs NO new IAM grant and pipelineProjects() derives its macOS ci/build/
// deploy the same way. It is NEVER the env default (its name != PIPELINE_NAME),
// so it can never win an unqualified write, and it inherits the backend entry's
// region + cross-account trigger role.
describe("iOS release pipeline as a second target", () => {
  const APP_IOS = "hub-app-ios-deploy";
  const APP_BACKEND = "hub-app-deploy";
  const HUB = "agentcore-hub-deploy";
  const IOS_REGISTRY = {
    version: 1,
    repos: [
      { repo: "acme/app", pipeline: APP_BACKEND, iosPipeline: APP_IOS, region: "us-west-2" },
      { repo: "tycenjmccann/agentcore-hub", pipeline: HUB, region: "us-east-1" },
    ],
  };

  it("resolves get_state to the iOS pipeline, in the entry's region", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const out = await withRegistry(
      IOS_REGISTRY,
      (mod) => invokeOn(mod.handler, "get_state", { pipeline_name: APP_IOS }),
      { AWS_REGION: "us-east-1" }
    );

    expect(out.pipelineName).toBe(APP_IOS);
    expect(out.region).toBe("us-west-2");
    expect(out.repo).toBe("acme/app");
    const call = h.state.cpCalls.find((c) => c.type === "GetPipelineState");
    expect(call.name).toBe(APP_IOS);
    expect(call.region).toBe("us-west-2");
  });

  it("accepts start_deploy on the iOS pipeline — it is a known write target", async () => {
    const sha = "b".repeat(40);
    const out = await withRegistry(
      IOS_REGISTRY,
      (mod) => invokeOn(mod.handler, "start_deploy", { pipeline_name: APP_IOS, commit_sha: sha }),
      { AWS_REGION: "us-east-1" }
    );

    expect(out.started).toBe(true);
    expect(out.pipelineExecutionId).toBe("exec-new");
    const start = h.state.cpCalls.find((c) => c.type === "StartPipelineExecution");
    expect(start.name).toBe(APP_IOS);
    expect(start.region).toBe("us-west-2");
  });

  it("lists BOTH pipelines of a repo when an unqualified start_deploy is refused", async () => {
    const out = await withRegistry(
      IOS_REGISTRY,
      (mod) => invokeOn(mod.handler, "start_deploy", { commit_sha: "c".repeat(40) }),
      { AWS_REGION: "us-east-1" }
    );

    // The iOS pipeline is a target, so it is enumerable — but the App Store
    // submit is a human gate, so the RM must still name it explicitly.
    expect(out).toEqual({
      ok: false,
      reason: "pipeline_name_required",
      known: [APP_BACKEND, APP_IOS, HUB],
    });
    expect(h.state.cpCalls).toEqual([]);
  });

  it("never treats the iOS pipeline as the env default (unqualified read is the hub, not the app)", async () => {
    h.state.getPipelineStateImpl = async () => ({ stageStates: [] });
    const out = await withRegistry(IOS_REGISTRY, (mod) => invokeOn(mod.handler, "get_state", {}), {
      AWS_REGION: "us-east-1",
    });

    expect(out.pipelineName).toBe(HUB);
    expect(out.repo).toBe("tycenjmccann/agentcore-hub");
  });

  it("derives the iOS pipeline's macOS ci/build projects (get_build_status reaches them)", async () => {
    h.state.listBuildsImpl = async () => ({ ids: [] });
    const out = await withRegistry(
      IOS_REGISTRY,
      (mod) => invokeOn(mod.handler, "get_build_status", { project: "hub-app-ios-ci" }),
      { AWS_REGION: "us-east-1" }
    );

    // hub-app-ios-ci is derived from the iOS pipeline's base (hub-app-ios), so it
    // is a known project and the read is not refused.
    expect(out.reason).not.toBe("project_not_registered");
    const call = h.state.cbCalls.find((c) => c.type === "ListBuildsForProject");
    expect(call.region).toBe("us-west-2");
  });
});
