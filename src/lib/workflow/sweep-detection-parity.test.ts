import { describe, it, expect, vi, afterAll } from "vitest";
import {
  DETECTION_PHASE,
  normalizeSweepDetectionMode,
  stripUnenforcedDetectionPhase as stripTs,
} from "./sweep-detection";
import { normalizeVerdictMode } from "../../../lambda/orchestrator/verdict-contract.mjs";
import workflowsConfig from "@/config/workflows.json";

/**
 * TEAM-4265 F9 parity contract: feed the SAME def through the TS route twin and the
 * orchestrator ORIGINAL (`lambda/orchestrator/index.mjs stripUnenforcedDetectionPhase`)
 * at every value SWEEP_DETECTION_PHASE can hold, and assert identical results —
 * including the IDENTITY cases, because the original documents "returns the def
 * unchanged when there is nothing to strip, so identity checks elsewhere keep
 * working". Same role as lease-parity / ship-review-parity / verified-heads-parity:
 * the HTTP route is a second, human-driven way to close a run, so a drift here means
 * the manual `complete` 409s on a sweep the orchestrator completes.
 *
 * The mode lives in a module-level const in the .mjs (it is a Lambda; the env is
 * fixed for the container's life), so the original has to be RE-IMPORTED per mode —
 * hence the vi.resetModules() + dynamic import below. index.mjs is importable here
 * because it does no fs/network work at module load, only AWS client construction:
 * the mock block is the same six-package seam as
 * lambda/orchestrator/sweep-mode-defaults.test.mjs.
 */

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Items: [] }) }) },
  GetCommand: class { constructor(public input: unknown) {} },
  PutCommand: class { constructor(public input: unknown) {} },
  UpdateCommand: class { constructor(public input: unknown) {} },
  QueryCommand: class { constructor(public input: unknown) {} },
  ScanCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  ListObjectsV2Command: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class { async send() { return {}; } },
  InvokeAgentCommand: class { constructor(public input: unknown) {} },
}));

type Def = { completionRequiresAgentPhases?: string[]; [k: string]: unknown };
type StripFn = (def: Def) => Def;

const SAVED_FLAG = process.env.SWEEP_DETECTION_PHASE;

/** The .mjs original, loaded with SWEEP_DETECTION_PHASE set to `raw`. */
async function loadMjs(raw: string | undefined): Promise<StripFn> {
  if (raw === undefined) delete process.env.SWEEP_DETECTION_PHASE;
  else process.env.SWEEP_DETECTION_PHASE = raw;
  vi.resetModules();
  const mod = await import("../../../lambda/orchestrator/index.mjs");
  return mod.stripUnenforcedDetectionPhase as StripFn;
}

afterAll(() => {
  if (SAVED_FLAG === undefined) delete process.env.SWEEP_DETECTION_PHASE;
  else process.env.SWEEP_DETECTION_PHASE = SAVED_FLAG;
});

/**
 * Every value an operator (or a typo, or an unset var) can put in the env, spanning
 * the normalizer's three branches: unset/empty → shadow, the three recognized modes
 * (case- and space-insensitively), and garbage → off.
 */
const RAW_MODES: Array<string | undefined> = [undefined, "", "off", "shadow", "enforce", "ENFORCE ", "garbage"];

/** The REAL dead-code-sweep def — the one def in the repo that lists "detection". */
const SWEEP_DEF = (workflowsConfig.workflows as Array<Record<string, unknown>>).find(
  (w) => w.id === "dead-code-sweep"
) as Def;

const DEFS: Array<{ name: string; def: Def }> = [
  { name: "the real dead-code-sweep def (detection first)", def: SWEEP_DEF },
  {
    name: "detection in the MIDDLE of the list",
    def: { id: "synthetic", completionRequiresAgentPhases: ["development", "detection", "review"] },
  },
  {
    name: "no detection phase (every other def)",
    def: { id: "software-delivery", completionRequiresAgentPhases: ["development", "ship"] },
  },
  { name: "no completionRequiresAgentPhases at all (a legacy def)", def: { id: "legacy" } },
  { name: "an empty completionRequiresAgentPhases", def: { id: "empty", completionRequiresAgentPhases: [] } },
];

describe("detection-phase strip parity (TS route twin vs orchestrator .mjs)", () => {
  it("the real sweep def is the case this exists for — it lists the detection phase", () => {
    expect(DETECTION_PHASE).toBe("detection");
    expect(SWEEP_DEF?.completionRequiresAgentPhases).toContain(DETECTION_PHASE);
  });

  for (const raw of RAW_MODES) {
    const label = raw === undefined ? "unset" : JSON.stringify(raw);

    describe(`SWEEP_DETECTION_PHASE=${label}`, () => {
      for (const { name, def } of DEFS) {
        it(`agrees: ${name}`, async () => {
          const stripMjs = await loadMjs(raw);
          const mode = normalizeSweepDetectionMode(raw);
          // A pristine clone, so a port that MUTATED its input is caught rather
          // than masked by comparing the mutation to itself.
          const pristine = structuredClone(def);

          const ts = stripTs(def, mode);
          const mjs = stripMjs(def);

          expect(ts).toEqual(mjs);
          expect(ts.completionRequiresAgentPhases).toEqual(mjs.completionRequiresAgentPhases);
          // The identity contract: both return the SAME object, or both a copy.
          expect(ts === def).toBe(mjs === def);
          if (mjs !== def) {
            expect(ts).not.toBe(def);
            // Only the required-phase list narrows; `phases` is never stripped.
            expect(ts.phases).toBe(def.phases);
          }
          expect(def).toEqual(pristine);
        });
      }
    });
  }

  it("the table exercises BOTH branches (a strip and an identity return)", async () => {
    const outcomes = new Set<string>();
    for (const raw of RAW_MODES) {
      const stripMjs = await loadMjs(raw);
      for (const { def } of DEFS) outcomes.add(stripMjs(def) === def ? "identity" : "stripped");
    }
    expect(outcomes).toEqual(new Set(["identity", "stripped"]));
  });

  it("only enforce keeps detection required — off/shadow/garbage all strip it", async () => {
    for (const raw of RAW_MODES) {
      const stripMjs = await loadMjs(raw);
      const required = stripMjs(SWEEP_DEF).completionRequiresAgentPhases || [];
      const expected = normalizeSweepDetectionMode(raw) === "enforce";
      expect(required.includes(DETECTION_PHASE)).toBe(expected);
      expect((stripTs(SWEEP_DEF, normalizeSweepDetectionMode(raw)).completionRequiresAgentPhases || []).includes(DETECTION_PHASE)).toBe(
        expected
      );
    }
  });

  it("the mode normalizers agree (unset → shadow, garbage → off)", () => {
    const inputs: unknown[] = [
      undefined, null, "", "  ", "off", "OFF", " Off ", "shadow", " Shadow ", "enforce", "ENFORCE",
      "ENFORCE ", "enforc", "garbage", "1", "true", 1, {},
    ];
    for (const raw of inputs) {
      expect(normalizeSweepDetectionMode(raw)).toBe(normalizeVerdictMode(raw));
    }
  });
});
