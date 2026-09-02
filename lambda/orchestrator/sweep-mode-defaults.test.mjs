/**
 * TEAM-3763 F2 + F6 — index.mjs-level rollout-mode DEFAULTS for the two sweeps
 * whose safe default is "dark".
 *
 * The reconcile sweep's own coercion (unknown→shadow, off→no-scan) is pinned in
 * reconcile-sweep.test.mjs, and the cascade's normalizeExtendedMode in
 * cascade.test.mjs. What lives ONLY in index.mjs is the value each env var
 * resolves to before it is handed down:
 *   F2 — RECONCILE_SWEEP_MODE unset → "off"  (`process.env.RECONCILE_SWEEP_MODE || "off"`)
 *   F6 — CASCADE_EXTENDED_STATES unset → "off" (resolveCascadeMode)
 *
 * Both must default DARK: the reconcile sweep is now SCHEDULED (deploy.sh wires a
 * reconcile_sweep EventBridge target — F2), and shadow is NOT byte-identical to
 * off (it issues extra DDB reads). A fresh deploy that omits the vars must run
 * zero extra reads/writes.
 *
 * Driving the handler with the reconcile_sweep sentinel exercises BOTH defaults
 * in one call: the handler's reconcile branch calls getReconcileSweep(), whose
 * deps object evaluates `cascade: getCascade()` — so createCascade (F6) AND
 * createReconcileSweep→runSweep (F2) both see the mode index resolved. The two
 * factories are mocked, so we observe the arguments, not the sweep behavior.
 * That the reconcile_sweep sentinel is handled at all is the scheduling
 * counterpart (F2): a scheduled invocation with this Input reaches the runner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ sweepModes: [], extendedStates: [] }));

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

// F6: capture the extendedStates mode index passes to createCascade.
vi.mock("./cascade.mjs", () => ({
  createCascade: (opts) => {
    h.extendedStates.push(opts?.extendedStates);
    return { cascadeUnblock: async () => [], reconcileDependent: async () => "noop" };
  },
  newMetrics: () => ({}),
}));

// F2: capture the mode index passes to the reconcile sweep's runSweep.
vi.mock("./reconcile-sweep.mjs", () => ({
  createReconcileSweep: () => ({
    runSweep: async (mode) => { h.sweepModes.push(mode); return { mode }; },
  }),
}));

const RECONCILE_EVENT = { source: "orchestrator.sweep", action: "reconcile_sweep" };

async function loadHandler() {
  vi.resetModules();
  const mod = await import("./index.mjs");
  return mod.handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sweepModes = [];
  h.extendedStates = [];
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.RECONCILE_SWEEP_MODE;
  delete process.env.CASCADE_EXTENDED_STATES;
});

describe("F2 — RECONCILE_SWEEP_MODE default (index.mjs reconcile dispatch)", () => {
  it("UNSET → the reconcile sweep runs in off (dark by default — the scheduled sentinel is handled)", async () => {
    const handler = await loadHandler();
    const result = await handler({ ...RECONCILE_EVENT });
    // off → runSweep short-circuits before its first ScanCommand: zero reads.
    expect(h.sweepModes).toEqual(["off"]);
    expect(result.mode).toBe("off");
  });

  it("empty string → falsy → coalesces to off", async () => {
    process.env.RECONCILE_SWEEP_MODE = "";
    const handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["off"]);
  });

  it('explicit "shadow" / "enforce" are passed through verbatim (opt-in only)', async () => {
    process.env.RECONCILE_SWEEP_MODE = "shadow";
    let handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["shadow"]);

    h.sweepModes = [];
    process.env.RECONCILE_SWEEP_MODE = "enforce";
    handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["enforce"]);
  });
});

describe("F6 — CASCADE_EXTENDED_STATES default (index.mjs resolveCascadeMode)", () => {
  it("UNSET → the cascade is built with extendedStates=off (pre-epic, zero extra reads)", async () => {
    const handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT }); // instantiates getCascade() via the reconcile deps
    expect(h.extendedStates).toContain("off");
    expect(h.extendedStates.every((m) => m === "off")).toBe(true);
  });

  it("empty string → off", async () => {
    process.env.CASCADE_EXTENDED_STATES = "";
    const handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.extendedStates).toContain("off");
  });

  it("unrecognized garbage → off (only recognized shadow/enforce opt in)", async () => {
    process.env.CASCADE_EXTENDED_STATES = "definitely-not-a-mode";
    const handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.extendedStates).toContain("off");
  });

  it('explicit "shadow" and legacy "true"/"1"/"on" and "enforce" resolve as intended', async () => {
    for (const [raw, expected] of [
      ["shadow", "shadow"],
      ["enforce", "enforce"],
      ["true", "enforce"],
      ["1", "enforce"],
      ["on", "enforce"],
      ["off", "off"],
    ]) {
      h.extendedStates = [];
      process.env.CASCADE_EXTENDED_STATES = raw;
      const handler = await loadHandler();
      await handler({ ...RECONCILE_EVENT });
      expect(h.extendedStates).toContain(expected);
    }
  });
});
