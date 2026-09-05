import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * TEAM-4099 F8 — the effective mode of a flag is decided in THREE independent
 * places, and before F8 they disagreed:
 *
 *   1. the code default in index.mjs (`process.env.X || "..."`),
 *   2. template.yaml's parameter Default (the SAM path),
 *   3. what deploy.sh forwards (the path actually used in this repo).
 *
 * (3) is the one that decides production, and it is the one that used to omit
 * the flags: `aws lambda update-function-configuration --environment` REPLACES
 * the whole variable map, so an omitted var is DELETED from the function and (1)
 * silently wins — which is how D1.2 / D2.3 / D4.3 / the roll-up retry shipped
 * inert with an `enforce`-looking template sitting next to them.
 *
 * These tests pin the agreement itself, in the direction that matters: a future
 * change to any ONE layer fails here instead of quietly re-creating the gap.
 * Nothing here mocks the flag resolution — the code column is read out of the
 * real module via its own cold-start reporter.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(HERE, "template.yaml"), "utf8");
const deploySh = readFileSync(join(HERE, "deploy.sh"), "utf8");

/**
 * Every operator-facing mode flag. `code` is what index.mjs must resolve with the
 * var unset, `deploy` is the literal default deploy.sh must forward (SHIP_MERGE_VERIFY
 * is an on/off flag, so its wire value differs from the reported level), `param`
 * is the template.yaml parameter or null for the two fail-closed code-only gates.
 */
const FLAGS = [
  { env: "DEAD_SESSION_DETECTOR_MODE", code: "enforce", deploy: "enforce", param: "DeadSessionDetectorMode" },
  { env: "RECONCILE_SWEEP_MODE", code: "enforce", deploy: "enforce", param: "ReconcileSweepMode" },
  { env: "GATE_BYPASS_MODE", code: "enforce", deploy: "enforce", param: "GateBypassMode" },
  { env: "FIX_VERIFICATION_REQUIRED", code: "enforce", deploy: "enforce", param: "FixVerificationRequired" },
  // Deliberately NOT enforced by default — see the "stays dark" test below.
  { env: "CASCADE_EXTENDED_STATES", code: "off", deploy: "off", param: "CascadeExtendedStates" },
  { env: "OTEL_ACTIVITY_CONFIRM", code: "off", deploy: "off", param: "OtelActivityConfirm" },
  { env: "COMPLETION_EVIDENCE_REQUIRED", code: "enforce", deploy: "enforce", param: null },
  { env: "SHIP_MERGE_VERIFY", code: "enforce", deploy: "on", param: null },
];

// ─── AWS/store seams (index.mjs constructs clients at import) ────────────────
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class { constructor(i) { this.input = i; } },
  PutCommand: class { constructor(i) { this.input = i; } },
  UpdateCommand: class { constructor(i) { this.input = i; } },
  QueryCommand: class { constructor(i) { this.input = i; } },
  ScanCommand: class { constructor(i) { this.input = i; } },
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
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
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async () => null),
}));

/** Import index.mjs with EVERY mode var unset, capturing what it logs at import. */
async function loadWithUnsetFlags() {
  for (const f of FLAGS) delete process.env[f.env];
  delete process.env.CODING_AGENT_RUNTIME_ARN;
  const logs = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  vi.resetModules();
  const mod = await import("./index.mjs");
  spy.mockRestore();
  return { mod, logs };
}

/** `Default:` of one template.yaml parameter, unquoted. */
function templateDefault(param) {
  const block = new RegExp(`\\n  ${param}:\\n((?:    .*\\n)+)`).exec(template);
  if (!block) return undefined;
  const def = /^ {4}Default: (.*)$/m.exec(block[1]);
  return def ? def[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

describe("mode-flag defaults agree across code, template and deploy (TEAM-4099 F8)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("index.mjs resolves the shipped default for every flag with the var unset", async () => {
    const { mod, logs } = await loadWithUnsetFlags();
    const modes = mod.emitEffectiveModes(undefined, () => {});

    for (const f of FLAGS) expect([f.env, modes[f.env]]).toEqual([f.env, f.code]);
    // The gate that is armed by an ARN, not a level.
    expect(modes.CODING_RUNTIME_GATE).toBe("off");
    // …and the cold-start report is emitted at import, not only on demand.
    expect(logs.some((l) => l.includes('"type":"orchestrator.effective_modes"'))).toBe(true);
  });

  it("template.yaml's parameter Default matches the code default", () => {
    for (const f of FLAGS.filter((x) => x.param)) {
      expect([f.param, templateDefault(f.param)]).toEqual([f.param, f.code]);
    }
  });

  it("deploy.sh forwards every flag UNCONDITIONALLY with that same default", () => {
    for (const f of FLAGS) {
      // The whole point of F8: no `if [ -n ... ]` around it, so the deployed
      // env map always names the flag and never silently drops it.
      const assignment = new RegExp(`^[A-Z_]+_VARS=",${f.env}=\\$\\{${f.env}:-${f.deploy}\\}"$`, "m");
      expect([f.env, assignment.test(deploySh)]).toEqual([f.env, true]);
      expect(deploySh).not.toMatch(new RegExp(`if \\[ -n "\\$\\{${f.env}:-\\}" \\]`));
    }
  });

  it("…and every forwarded flag actually reaches the orchestrator's env map", () => {
    const line = /^ENV_VARS_ORCH="Variables=\{.*\}"$/m.exec(deploySh);
    expect(line).not.toBeNull();
    for (const v of ["DETECTOR_VARS", "CASCADE_VARS", "RECONCILE_VARS", "GATE_BYPASS_VARS",
      "FIX_VERIFY_VARS", "EVIDENCE_VARS", "SHIP_VERIFY_VARS", "OTEL_VARS"]) {
      expect(line[0]).toContain(`\${${v}}`);
    }
  });

  it("the two flags that stay dark are dark for a stated reason, not by omission", () => {
    // CASCADE_EXTENDED_STATES: shadow is not read-free, and the enforcing
    // reconcile sweep now covers the same stalls under the lease floor.
    expect(templateDefault("CascadeExtendedStates")).toBe("off");
    // OTEL_ACTIVITY_CONFIRM: the absolute hard ceiling is the safe backstop, and
    // confirming costs Logs Insights queries per sweep.
    expect(templateDefault("OtelActivityConfirm")).toBe("off");
    // Both still say so in the template, so the next reader does not have to
    // guess whether the default is a decision or an oversight.
    expect(template).toMatch(/Stays OFF by default: shadow is NOT read-free/);
    expect(template).toMatch(/Ships off — the hard ceiling alone is the safe backstop/);
  });

  it("the coding-runtime gate's IAM is conditional, so it cannot be defaulted on", () => {
    // bedrock-agentcore:InvokeAgentRuntime is granted only under HasCodingRuntime
    // — flipping D4.2 on without an ARN would be a permission error, not a gate.
    expect(template).toMatch(/HasCodingRuntime: !Not \[!Equals \[!Ref CodingAgentRuntimeArn, ""\]\]/);
    expect(templateDefault("CodingAgentRuntimeArn")).toBe("");
  });
});

describe("the cold-start effective-modes report (TEAM-4099 F8)", () => {
  it("logs one structured line naming EVERY flag, plus one EMF datum each", async () => {
    const { mod } = await loadWithUnsetFlags();
    const out = [];
    const modes = mod.emitEffectiveModes(undefined, (m) => out.push(m));

    expect(out).toHaveLength(2);
    const report = JSON.parse(out[0]);
    expect(report.type).toBe("orchestrator.effective_modes");
    for (const name of Object.keys(modes)) expect(report[name]).toBe(modes[name]);

    const emf = JSON.parse(out[1]);
    const metrics = emf._aws.CloudWatchMetrics[0];
    expect(metrics.Namespace).toBe("AgentCoreHub/Orchestrator");
    expect(metrics.Metrics.map((m) => m.Name).sort())
      .toEqual(Object.keys(modes).map((n) => `ModeEnforce_${n}`).sort());
    // 1 = this flag is acting; 0 = off/shadow. A dashboard can alarm on the
    // difference without knowing anything about the deploy.
    expect(emf.ModeEnforce_RECONCILE_SWEEP_MODE).toBe(1);
    expect(emf.ModeEnforce_DEAD_SESSION_DETECTOR_MODE).toBe(1);
    expect(emf.ModeEnforce_CASCADE_EXTENDED_STATES).toBe(0);
    expect(emf.ModeEnforce_OTEL_ACTIVITY_CONFIRM).toBe(0);
    expect(emf.ModeEnforce_CODING_RUNTIME_GATE).toBe(0);
  });

  it("shadow is reported as NOT acting (the pre-F8 posture is visible, not silent)", async () => {
    const { mod } = await loadWithUnsetFlags();
    const out = [];
    mod.emitEffectiveModes(
      { DEAD_SESSION_DETECTOR_MODE: "shadow", RECONCILE_SWEEP_MODE: "off" },
      (m) => out.push(m),
    );
    const emf = JSON.parse(out[1]);
    expect(emf.ModeEnforce_DEAD_SESSION_DETECTOR_MODE).toBe(0);
    expect(emf.ModeEnforce_RECONCILE_SWEEP_MODE).toBe(0);
  });
});
