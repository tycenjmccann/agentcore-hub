/**
 * TEAM-3763 F2 + F6, as amended by TEAM-4099 F8 — the index.mjs-level rollout-mode
 * DEFAULTS for the reconcile sweep and the cascade's extended states.
 *
 * The reconcile sweep's own coercion (unknown→shadow, off→no-scan) is pinned in
 * reconcile-sweep.test.mjs, and the cascade's normalizeExtendedMode in
 * cascade.test.mjs. What lives ONLY in index.mjs is the value each env var
 * resolves to before it is handed down:
 *   F2/F8 — RECONCILE_SWEEP_MODE unset → "enforce" (`… || "enforce"`)
 *   F6    — CASCADE_EXTENDED_STATES unset → "off"  (resolveCascadeMode)
 *
 * They now differ deliberately. F2 shipped the sweep DARK because it had just
 * become scheduled and nothing yet depended on it. F8 flipped it: dark by default
 * also disabled FR-D1.3's 2-minute ready SLA, D2.3's epic roll-up retry, and F7's
 * "the remainder is left to the sweep" bound — a backstop that is off by default is
 * not a backstop, and every write it makes is already lease-guarded and scoped.
 * CASCADE_EXTENDED_STATES stays dark: its shadow path is NOT read-free (blocker-
 * confirm + lease reads happen before the no-write check), and the enforcing sweep
 * now covers the same stalled dependents under the same lease floor. The full
 * three-layer default agreement (code / template.yaml / deploy.sh) is pinned in
 * mode-defaults.test.mjs.
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
    return { cascadeUnblock: async () => [], reconcileDependent: async () => ({ outcome: "noop", reason: "unknown" }) };
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

describe("F2/F8 — RECONCILE_SWEEP_MODE default (index.mjs reconcile dispatch)", () => {
  it("UNSET → the reconcile sweep runs in ENFORCE (the scheduled backstop actually backstops)", async () => {
    const handler = await loadHandler();
    const result = await handler({ ...RECONCILE_EVENT });
    // TEAM-4099 F8: off made every 5-minute invocation short-circuit before its
    // first scan, so the SLA/roll-up-retry ACs were unmet in a default deploy.
    expect(h.sweepModes).toEqual(["enforce"]);
    expect(result.mode).toBe("enforce");
  });

  it("empty string → falsy → coalesces to enforce (same as unset)", async () => {
    process.env.RECONCILE_SWEEP_MODE = "";
    const handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["enforce"]);
  });

  it('explicit "shadow" / "off" are passed through verbatim (the opt-OUTs still work)', async () => {
    process.env.RECONCILE_SWEEP_MODE = "shadow";
    let handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["shadow"]);

    h.sweepModes = [];
    process.env.RECONCILE_SWEEP_MODE = "off";
    handler = await loadHandler();
    await handler({ ...RECONCILE_EVENT });
    expect(h.sweepModes).toEqual(["off"]);
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
