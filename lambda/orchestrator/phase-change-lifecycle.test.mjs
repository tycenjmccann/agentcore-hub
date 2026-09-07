import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4167 D3 (FR-3.3) CALL 6 F1 — announcePhaseTransition lifecycle coverage.
 *
 * The run's `workflow.phase_change` lifecycle stream must be COMPLETE and
 * exactly-once for EVERY creation path (app start route + bug bootstrap). Both
 * paths converge on the first agent dispatch, where announcePhaseTransition —
 * behind the ONE store CAS a run ever wins (markInitialPhaseAnnounced) — emits
 * the opening "intake" row (anchored at workflow.startedAt) followed by the
 * initial agent phase (now). A genuine forward advance emits a single phase row
 * and calls advancePhase.
 *
 * We invoke the REAL exported announcePhaseTransition (and let it drive the REAL
 * publishEvent) — only the I/O seams are mocked: the AWS SDK clients (so we can
 * read back the events-table Put items) and workflow-store (so we can drive
 * markInitialPhaseAnnounced win/loss and see advancePhase fire).
 */

const h = vi.hoisted(() => ({
  state: {
    ebEvents: /** @type {any[]} */ ([]), // EventBridge PutEvents inputs
    events: /** @type {any[]} */ ([]), // events-table Put items
    advancePhase: /** @type {any[]} */ ([]),
    // Controllable CAS: a queue of return values (shift per call); default true.
    initialPhaseWins: /** @type {boolean[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          if (cmd.constructor.name === "PutCommand") h.state.events.push(cmd.input.Item);
          return {};
        },
      }),
    },
  };
});
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  markInitialPhaseAnnounced: vi.fn(async () => (h.state.initialPhaseWins.length ? h.state.initialPhaseWins.shift() : true)),
  advancePhase: vi.fn(async (wfId, phase, branch) => { h.state.advancePhase.push({ wfId, phase, branch }); }),
}));

// events-table Put path is gated on EVENTS_TABLE; set before module load so the
// intake/initial rows are captured as Put items (not only EventBridge entries).
process.env.EVENTS_TABLE = "agentcore-hub-events-test";
process.env.EVENT_DEDUPE_MODE = "enforce";

let announcePhaseTransition;

async function load() {
  vi.resetModules();
  ({ announcePhaseTransition } = await import("./index.mjs"));
}

// The initial agent phase is the first phaseOrder entry after "intake".
const WF_DEF = { phaseOrder: ["intake", "requirements", "development", "verification", "complete"] };
const STARTED_AT = "2026-09-06T05:26:21.514000Z";

function phaseChanges() {
  return h.state.events.filter((e) => e.type === "workflow.phase_change").map((e) => e.detail);
}

beforeEach(async () => {
  h.state.ebEvents.length = 0;
  h.state.events.length = 0;
  h.state.advancePhase.length = 0;
  h.state.initialPhaseWins.length = 0;
  await load();
});

describe("announcePhaseTransition — initial phase (both creation paths converge here)", () => {
  it("emits intake (anchored at startedAt) then the initial phase, in order, behind the one CAS", async () => {
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");

    const rows = phaseChanges();
    expect(rows.map((r) => r.phase)).toEqual(["intake", "requirements"]);
    // The intake row is anchored at the run's own startedAt so the opening
    // phase's duration measures from run start.
    expect(rows[0].timestamp).toBe(STARTED_AT);
    expect(rows[0].workflowId).toBe("wf_1");
    // The initial-phase row is stamped now (not the intake anchor).
    expect(rows[1].timestamp).not.toBe(STARTED_AT);
    // The initial agent phase is NOT a forward advance → advancePhase untouched.
    expect(h.state.advancePhase).toEqual([]);
  });

  it("emits NOTHING when the CAS is lost (another delivery already claimed it)", async () => {
    h.state.initialPhaseWins.push(false);
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    expect(phaseChanges()).toEqual([]);
    expect(h.state.advancePhase).toEqual([]);
  });

  it("is once-only across a second dispatch of the same run (CAS wins once, then loses)", async () => {
    h.state.initialPhaseWins.push(true, false);
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-2");
    // Only the first dispatch's intake+initial pair — the second wins nothing.
    expect(phaseChanges().map((r) => r.phase)).toEqual(["intake", "requirements"]);
  });

  it("falls back to now for the intake row when the run has no startedAt", async () => {
    const workflow = { id: "wf_1", phase: "requirements" }; // no startedAt
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    const rows = phaseChanges();
    expect(rows.map((r) => r.phase)).toEqual(["intake", "requirements"]);
    // A real ISO string was stamped (publishEvent's now fallback), not undefined.
    expect(typeof rows[0].timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(rows[0].timestamp))).toBe(false);
  });
});

describe("announcePhaseTransition — forward advance", () => {
  it("emits a single phase row and calls advancePhase (no intake, no CAS)", async () => {
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT, featureBranch: "feat/x" };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "development" }, "TEAM-9");
    const rows = phaseChanges();
    expect(rows.map((r) => r.phase)).toEqual(["development"]);
    expect(workflow.phase).toBe("development");
    expect(h.state.advancePhase).toEqual([{ wfId: "wf_1", phase: "development", branch: "feat/x" }]);
  });

  it("emits nothing on a stale/backward dispatch (agent phase behind current)", async () => {
    const workflow = { id: "wf_1", phase: "verification", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "development" }, "TEAM-9");
    expect(phaseChanges()).toEqual([]);
    expect(h.state.advancePhase).toEqual([]);
  });
});
