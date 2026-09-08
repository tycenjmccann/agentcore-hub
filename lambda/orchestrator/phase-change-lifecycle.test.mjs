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
    // TEAM-4288 r3-F4: the CAS fake is STATEFUL, not a queue of canned answers.
    // The durability retry test is only meaningful if re-winning the claim
    // depends on the release actually happening — a queue mock that hands out
    // `true` again would make the retry pass on unfixed code too.
    announced: /** @type {string|null} */ (null), // the announcedInitialPhase attribute
    clears: /** @type {any[]} */ ([]), // clearInitialPhaseAnnounced calls
    // events-table Put fault injection: 0-based indexes of Put calls that reject.
    putCalls: 0,
    failPutIndexes: /** @type {number[]} */ ([]),
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
          if (cmd.constructor.name === "PutCommand") {
            const idx = h.state.putCalls++;
            if (h.state.failPutIndexes.includes(idx)) {
              const err = new Error("Throughput exceeded for table");
              err.name = "ProvisionedThroughputExceededException";
              throw err;
            }
            h.state.events.push(cmd.input.Item);
          }
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

// Stateful stand-in for the real announcedInitialPhase CAS: mark wins only while
// the attribute is unset, clear releases it only when it still holds the value
// this claim wrote (the conditional release in workflow-store.mjs).
vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  markInitialPhaseAnnounced: vi.fn(async (wfId, phase) => {
    if (h.state.announced !== null) return false;
    h.state.announced = phase;
    return true;
  }),
  clearInitialPhaseAnnounced: vi.fn(async (wfId, phase) => {
    h.state.clears.push({ wfId, phase });
    if (h.state.announced !== phase) return false;
    h.state.announced = null;
    return true;
  }),
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
  h.state.clears.length = 0;
  h.state.failPutIndexes.length = 0;
  h.state.announced = null;
  h.state.putCalls = 0;
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
    h.state.announced = "requirements"; // a concurrent delivery got there first
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    expect(phaseChanges()).toEqual([]);
    expect(h.state.advancePhase).toEqual([]);
    // Losing the CAS is not a write failure — the claim must NOT be released.
    expect(h.state.clears).toEqual([]);
  });

  it("is once-only across a second dispatch of the same run (CAS wins once, then loses)", async () => {
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

/**
 * TEAM-4288 r3-F4 — the initial-phase rows must survive a transient events-table
 * failure. The CAS is won BEFORE the two rows are published (that ordering is
 * what keeps concurrent deliveries from double-emitting), so if publishEvent
 * swallows the events-table PutCommand failure the rows are lost FOREVER: the
 * claim can never be re-won, and cost-report's computePhases builds its
 * contiguous phase intervals from consecutive phase_change rows (FR-3.3's
 * "phases sum to totalDurationMs within 1%" then fails). The fix publishes the
 * two rows with { requireDurable: true } and releases the claim on failure.
 */
describe("announcePhaseTransition — initial phase durability (r3-F4)", () => {
  it("releases the claim and re-emits both rows on retry when the FIRST row's write fails", async () => {
    h.state.failPutIndexes.push(0); // the intake row's events-table Put rejects
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };

    // The failure must NOT escape: this is a journal/metric write, and throwing
    // here would fail the whole orchestrator invocation (the agent dispatch).
    await expect(
      announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1")
    ).resolves.toBeUndefined();

    // Nothing landed, and the claim was released so a retry can re-win it.
    expect(phaseChanges()).toEqual([]);
    expect(h.state.clears).toEqual([{ wfId: "wf_1", phase: "requirements" }]);
    expect(h.state.announced).toBeNull();

    // Retry (a re-dispatch of the same run): the CAS is re-won, both rows land.
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    const rows = phaseChanges();
    expect(rows.map((r) => r.phase)).toEqual(["intake", "requirements"]);
    expect(rows[0].timestamp).toBe(STARTED_AT);
    expect(h.state.announced).toBe("requirements");
  });

  it("re-emits the intake row under the SAME eventId when only the SECOND row's write fails", async () => {
    h.state.failPutIndexes.push(1); // intake lands, the initial-phase row rejects
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT };
    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    expect(phaseChanges().map((r) => r.phase)).toEqual(["intake"]);
    expect(h.state.announced).toBeNull(); // claim released

    await announcePhaseTransition(workflow, WF_DEF, { phase: "requirements" }, "TEAM-1");
    // The retry re-publishes row 1. It is anchored at workflow.startedAt, so
    // under EVENT_DEDUPE_MODE=enforce its eventId is deterministic and the
    // second write is an idempotent OVERWRITE of the same events-table item —
    // the accepted cost of the release, versus losing both rows permanently.
    const intakeIds = h.state.events
      .filter((e) => e.type === "workflow.phase_change" && e.detail.phase === "intake")
      .map((e) => e.eventId);
    expect(intakeIds).toHaveLength(2);
    expect(intakeIds[0]).toBe(intakeIds[1]);
    expect(phaseChanges().map((r) => r.phase)).toEqual(["intake", "intake", "requirements"]);
  });
});

describe("announcePhaseTransition — forward advance", () => {
  it("a default publishEvent (no requireDurable) still swallows an events-table failure", async () => {
    // requireDurable is strictly opt-in: the forward-advance row stays
    // best-effort, because throwing there would skip advancePhase and wedge the
    // run mid-phase. Every other publishEvent caller keeps this behaviour.
    h.state.failPutIndexes.push(0);
    const workflow = { id: "wf_1", phase: "requirements", startedAt: STARTED_AT, featureBranch: "feat/x" };
    await expect(
      announcePhaseTransition(workflow, WF_DEF, { phase: "development" }, "TEAM-9")
    ).resolves.toBeUndefined();
    expect(phaseChanges()).toEqual([]); // the row is gone — non-fatal, by design
    expect(h.state.advancePhase).toEqual([{ wfId: "wf_1", phase: "development", branch: "feat/x" }]);
    expect(h.state.clears).toEqual([]);
  });


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
