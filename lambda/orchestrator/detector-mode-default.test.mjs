/**
 * TEAM-3748 D4 — DEAD_SESSION_DETECTOR_MODE default flip (index.mjs level).
 *
 * The detector's OWN fail-safe coercion (unknown→shadow, shadow→zero-writes) is
 * pinned in dead-session-detector.test.mjs. What lives ONLY in index.mjs is the
 * default the sweep dispatch resolves the env var to before handing it to
 * runSweep:  `process.env.DEAD_SESSION_DETECTOR_MODE || "enforce"`. This suite
 * drives the real orchestrator `handler` with the dead_session_sweep sentinel
 * and asserts the exact mode string index passes through — the detector is
 * mocked so we observe the argument, not the sweep behavior.
 *
 * ARTIFACT_BUCKET is left unset so loadAgentRoster / loadWorkflowDefs fall back
 * to their in-code rosters with zero S3 calls; the AWS SDK seams are mocked to
 * inert clients so module load + initWorkflowStore succeed offline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Survives vi.resetModules(): each re-imported index.mjs uses the SAME mocked
// createDetector, whose runSweep records the mode it was called with here.
const h = vi.hoisted(() => ({ modes: [] }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Items: [] }) }) },
  GetCommand: class { constructor(i) { this.input = i; } },
  PutCommand: class { constructor(i) { this.input = i; } },
  UpdateCommand: class { constructor(i) { this.input = i; } },
  QueryCommand: class { constructor(i) { this.input = i; } },
  ScanCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  // Required even though this test never lists: native ESM links named imports
  // eagerly, so a missing export would break the whole module load.
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class { async send() { return {}; } },
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));
// Capture the mode index hands to the sweep; ignore the injected deps.
vi.mock("./dead-session-detector.mjs", () => ({
  createDetector: () => ({
    runSweep: async (mode) => { h.modes.push(mode); return { mode, sweptBy: "stub" }; },
  }),
  emitMetrics: () => {},
}));

const SWEEP_EVENT = { source: "orchestrator.sweep", action: "dead_session_sweep" };

async function loadHandler() {
  vi.resetModules();
  const mod = await import("./index.mjs");
  return mod.handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modes = [];
  // index.mjs reads these at module load — ensure a clean, offline baseline.
  delete process.env.ARTIFACT_BUCKET;
});

describe("DEAD_SESSION_DETECTOR_MODE default (index.mjs sweep dispatch)", () => {
  it("UNSET → the sweep runs in enforce (the new default)", async () => {
    delete process.env.DEAD_SESSION_DETECTOR_MODE;
    const handler = await loadHandler();

    const result = await handler({ ...SWEEP_EVENT });

    expect(h.modes).toEqual(["enforce"]);
    expect(result.mode).toBe("enforce");
  });

  it('empty string → falsy → coalesces to enforce', async () => {
    process.env.DEAD_SESSION_DETECTOR_MODE = "";
    const handler = await loadHandler();

    await handler({ ...SWEEP_EVENT });

    expect(h.modes).toEqual(["enforce"]);
  });

  it('explicit "shadow" is passed through verbatim (not overridden by the default)', async () => {
    process.env.DEAD_SESSION_DETECTOR_MODE = "shadow";
    const handler = await loadHandler();

    await handler({ ...SWEEP_EVENT });

    expect(h.modes).toEqual(["shadow"]);
  });

  it('explicit "off" is passed through verbatim', async () => {
    process.env.DEAD_SESSION_DETECTOR_MODE = "off";
    const handler = await loadHandler();

    await handler({ ...SWEEP_EVENT });

    expect(h.modes).toEqual(["off"]);
  });

  it('an unrecognized value is passed through for the detector to coerce (fail-safe lives in runSweep, tested there)', async () => {
    process.env.DEAD_SESSION_DETECTOR_MODE = "definitely-not-a-mode";
    const handler = await loadHandler();

    await handler({ ...SWEEP_EVENT });

    // index does NOT re-classify: it forwards the raw value; runSweep normalizes
    // it to shadow (see dead-session-detector.test.mjs "mode normalization").
    expect(h.modes).toEqual(["definitely-not-a-mode"]);
  });
});
