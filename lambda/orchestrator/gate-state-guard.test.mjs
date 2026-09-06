import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4120 FR-1 — the GATE_STATE_GUARD wiring inside index.mjs.
 *
 * gate-state.test.mjs pins the pure truth table. These tests pin the CALLER: that
 * the real orchestrator opens a gate's cycle where it pages the human, closes it
 * on both conclusions, and consults it on BOTH `→ blocked` twins (the Jira
 * webhook's processStatusChange and the DDB stream's processRecord) —
 *
 *   off      → byte-identical: zero store.markGate* writes, zero
 *              gate.reject_ignored, and not one extra workflow read. A rejection
 *              that enforce would drop still reopens the upstream work.
 *   enforce  → a gate sitting in `requested` is admitted exactly once (the CAS
 *              claim); the duplicate / never-presented ones are dropped.
 *   shadow   → records + reports (wouldDrop:true) but drops NOTHING.
 *
 * index.mjs is imported for real; only its I/O seams (AWS SDK, workflow-store,
 * the review-cap factory) are mocked. Reaching handleReviewRejection is observed
 * through the cap's `enforce` (escalated:true short-circuits before the re-open
 * loop) — the same signal review-rejection.test.mjs uses.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    ebEvents: /** @type {any[]} */ ([]),
    enforce: /** @type {any} */ (null),
    // Every store.markGate* call, in order — the ledger's write log. Counted here
    // rather than on the spies because vi.resetModules() re-runs the mock factory
    // (fresh vi.fn()s) on every per-mode re-import.
    gateWrites: /** @type {any[]} */ ([]),
    // resolveWorkflow → store.getWorkflow: how the "off does no extra read"
    // claim is measured.
    workflowReads: 0,
    // markGateRejected's CAS outcome: true → this caller claimed the rejection,
    // false → another deliverer already closed it (ConditionalCheckFailed).
    rejectClaims: true,
    // markGateRejectedFromLegacy's CAS outcome (TEAM-4129 F2). false = a
    // concurrent deliverer converged the legacy row first.
    legacyClaims: true,
    // Make the ledger write throw, to exercise the guard's fail-open catch.
    gateWriteThrows: false,
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
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "QueryCommand") {
            // lease.lastAgentActivity reads the EVENTS table (no heartbeat →
            // every lease reads stale); getChildTickets reads the TICKETS
            // parentId-index → the sibling set.
            if (String(cmd.input.TableName).includes("events")) return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession → none
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
  // Every artifact read (CD registry, review package, completion records) misses
  // — index.mjs treats each as non-fatal, which is the shape we want here.
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("./workflow-store.mjs", () => {
  const ledger = (op, ret) => vi.fn(async (wfId, ticketId, at, opts) => {
    h.state.gateWrites.push({ op, wfId, ticketId, at, opts });
    if (h.state.gateWriteThrows) throw new Error("ledger unavailable");
    return typeof ret === "function" ? ret() : ret;
  });
  return {
    initWorkflowStore: vi.fn(() => {}), // called at index.mjs module load
    getWorkflow: vi.fn(async (id) => {
      h.state.workflowReads++;
      return h.state.workflow?.id === id ? h.state.workflow : null;
    }),
    ackNotifications: vi.fn(async () => {}),
    setResumeContext: vi.fn(async () => {}),
    removeResumeContext: vi.fn(async () => {}),
    // The gate-park path (handleHumanReviewGate): truthy = THIS call notified.
    appendReviewNotificationOnce: vi.fn(async () => true),
    completeTaskEntry: vi.fn(async () => {}),
    claimInvocation: vi.fn(async () => true),
    setTaskStatus: vi.fn(async () => {}),
    // TEAM-4120 FR-1 — the three ledger setters the guard is built on.
    markGateRequested: ledger("requested", true),
    markGateRejected: ledger("rejected", () => (h.state.rejectClaims ? { state: "rejected", cycles: [{}] } : null)),
    markGateApproved: ledger("approved", () => ({ state: "approved", cycles: [{}] })),
    // TEAM-4129 F2 — the legacy converge. A REAL store CAS leaves the row in
    // `rejected`, so this fake mutates the in-memory workflow the same way: the
    // next delivery must read the converged state, which is the entire point.
    markGateRejectedFromLegacy: vi.fn(async (wfId, ticketId, at) => {
      h.state.gateWrites.push({ op: "rejected_legacy", wfId, ticketId, at });
      if (h.state.gateWriteThrows) throw new Error("ledger unavailable");
      if (!h.state.legacyClaims) return false; // a concurrent twin got there first
      const wf = h.state.workflow;
      if (wf) {
        wf.gateStates = wf.gateStates || {};
        wf.gateStates[ticketId] = {
          state: "rejected",
          resolvedAt: at,
          cycles: [{ requestedAt: null, resolvedAt: at, outcome: "rejected", source: "legacy" }],
        };
      }
      return true;
    }),
  };
});

vi.mock("./review-cap.mjs", async () => {
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    parseDecision: actual.parseDecision,
    createReviewCap: () => ({ enforce: (...args) => h.state.enforce(...args) }),
  };
});

let handler;
let handleTicketDone;

/** index.mjs snapshots GATE_STATE_GUARD at module load, so every mode re-imports. */
async function load(mode) {
  if (mode === undefined) delete process.env.GATE_STATE_GUARD;
  else process.env.GATE_STATE_GUARD = mode;
  vi.resetModules();
  ({ handler, handleTicketDone } = await import("./index.mjs"));
}

const GATE = "TEAM-900";
const UPSTREAM = "TEAM-10"; // agentcore_hub_api_dev = a "development"-phase fallback-roster agent
const PARENT = "TEAM-1";
const REQUESTED_AT = "2026-09-05T10:00:00.000Z";

const gateStateOf = (state) => ({
  [GATE]: state === null ? undefined : { state, ...(state === "none" ? { cycles: [] } : { requestedAt: REQUESTED_AT, cycles: [] }) },
});
const reviewNeeded = (ticketId = GATE) => ({ id: `notif_${ticketId}`, type: "review_needed", ticketId, acknowledged: false });

/** @param {{ gateState?: string|null, notifications?: any[] }} [o] */
function setWorkflow({ gateState = null, notifications = [] } = {}) {
  h.state.workflow = {
    id: "wf_1",
    workflowDefId: "software-delivery",
    humanNotifications: notifications,
    resumeContexts: {},
    agentTasks: {},
    ...(gateState === null ? {} : { gateStates: gateStateOf(gateState) }),
  };
}

/** A DDB-stream MODIFY on the gate ticket. Plain values pass through unwrapDdbValue. */
const streamEvent = ({ oldStatus = "in_review", newStatus = "blocked", assignee = "human:engineer" } = {}) => ({
  Records: [{
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: GATE }, status: { S: newStatus }, assignee: { S: assignee },
        workflowId: { S: "wf_1" }, parentId: { S: PARENT }, type: { S: "task" },
        blockedBy: { L: [{ S: UPSTREAM }] },
      },
      OldImage: { ticketId: { S: GATE }, status: { S: oldStatus }, assignee: { S: assignee } },
    },
  }],
});

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);
const ignored = () => eventsOfType("gate.reject_ignored").map((e) => e.detail);
const writesOfOp = (op) => h.state.gateWrites.filter((w) => w.op === op);

beforeEach(() => {
  h.state.tickets = {
    [GATE]: {
      ticketId: GATE, workflowId: "wf_1", parentId: PARENT, assignee: "human:engineer",
      status: "blocked", type: "task", blockedBy: [UPSTREAM], reviewComment: "please fix the null check",
    },
    [UPSTREAM]: { ticketId: UPSTREAM, parentId: PARENT, workflowId: "wf_1", assignee: "agentcore_hub_api_dev", type: "task", status: "done" },
  };
  h.state.children = [];
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.ebEvents.length = 0;
  h.state.gateWrites.length = 0;
  h.state.workflowReads = 0;
  h.state.rejectClaims = true;
  h.state.legacyClaims = true;
  h.state.gateWriteThrows = false;
  // escalated:true short-circuits handleReviewRejection before the re-open loop —
  // all we need to know is whether the handler was reached.
  h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));
  setWorkflow();
});

afterEach(() => {
  delete process.env.GATE_STATE_GUARD;
});

describe("GATE_STATE_GUARD unset — byte-identical (no ledger, no extra read, no drops)", () => {
  beforeEach(async () => { await load(undefined); });

  it("admits a rejection enforce would DROP, and touches nothing new", async () => {
    // The worst case for the guard: a gate the ledger says is already rejected.
    setWorkflow({ gateState: "rejected", notifications: [reviewNeeded()] });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    // Nothing the guard adds happened: no ledger write, no report...
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()).toEqual([]);
    // ...and no extra workflow read. ONE read total, by handleReviewRejection
    // itself — the guard's resolveWorkflow never runs (it returns before it).
    expect(h.state.workflowReads).toBe(1);
  });

  it("still parks a gate for review without opening a cycle", async () => {
    await handler(streamEvent({ oldStatus: "todo", newStatus: "ready" }));

    expect(eventsOfType("review.needed")).toHaveLength(1);
    expect(h.state.gateWrites).toEqual([]);
  });

  it("garbage in GATE_STATE_GUARD is off, not shadow (the strict allow-list, end to end)", async () => {
    await load("on"); // the legacy truthy that means "enabled" for older flags
    setWorkflow({ gateState: "rejected" });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()).toEqual([]);
  });
});

describe("GATE_STATE_GUARD=enforce — the DDB-stream twin", () => {
  beforeEach(async () => { await load("enforce"); });

  it("a gate sitting in `requested` is admitted, and the cycle is closed as rejected", async () => {
    setWorkflow({ gateState: "requested" });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    expect(ignored()).toEqual([]);
    expect(writesOfOp("rejected")).toHaveLength(1);
    const [write] = writesOfOp("rejected");
    expect(write.wfId).toBe("wf_1");
    expect(write.ticketId).toBe(GATE);
    // The cycle carries the requestedAt it was opened with, so a cycle's
    // human-wait duration is derivable from the ledger alone.
    expect(write.opts).toEqual({ requestedAt: REQUESTED_AT });
    // The guard's own resolveWorkflow is the ONE extra read it costs.
    expect(h.state.workflowReads).toBe(2);
  });

  it("the SAME transition delivered twice: the second loses the CAS and is dropped", async () => {
    setWorkflow({ gateState: "requested" });

    await handler(streamEvent());
    expect(h.state.enforce).toHaveBeenCalledTimes(1);

    // The redelivery reads the same (stale) `requested` snapshot, but the ledger
    // write finds the cycle already closed — that lost CAS IS the duplicate.
    h.state.rejectClaims = false;
    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1); // no second rework round
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    // The full report shape (publishEvent stamps the timestamp) — this is what
    // the drop rate is measured from, so pin every field.
    expect(ignored()).toEqual([{
      workflowId: "wf_1", ticketId: GATE, reason: "duplicate", oldStatus: "in_review",
      gateState: "requested", legacyFallback: false, wouldDrop: true, mode: "enforce",
      timestamp: expect.any(String),
    }]);
  });

  it("a gate already recorded `rejected` is a duplicate — dropped without a write", async () => {
    setWorkflow({ gateState: "rejected", notifications: [reviewNeeded()] });

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOfType("review.rejected")).toHaveLength(0);
    expect(h.state.gateWrites).toEqual([]); // classified duplicate → no CAS attempt
    expect(ignored()[0]).toMatchObject({ reason: "duplicate", gateState: "rejected", legacyFallback: false });
  });

  it("a gate already `approved` is unrequested — the reviewer's answer is in, nothing is pending", async () => {
    setWorkflow({ gateState: "approved", notifications: [reviewNeeded()] });

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", gateState: "approved", legacyFallback: false });
  });

  it("no recorded state and no review_needed → never presented, dropped as unrequested", async () => {
    setWorkflow(); // no gateStates, no notifications

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOfType("review.rejected")).toHaveLength(0);
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", gateState: null, legacyFallback: true });
  });

  it("no recorded state but a review_needed exists → legacy fail-open, the rejection proceeds", async () => {
    // Runs that were in flight when the guard was switched on have no ledger.
    setWorkflow({ notifications: [reviewNeeded()] });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()).toEqual([]);
    // TEAM-4129 F2: the LEGACY CAS, and only it — markGateRejected's
    // `state = "requested"` can never hold on such a row, so attempting it was a
    // guaranteed-lost write that also left the ledger unconverged.
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    expect(writesOfOp("rejected_legacy")[0]).toMatchObject({ wfId: "wf_1", ticketId: GATE });
    expect(writesOfOp("rejected")).toHaveLength(0);
  });

  it("an acknowledged review_needed still fails open (both conclusions ack it)", async () => {
    setWorkflow({ notifications: [{ ...reviewNeeded(), acknowledged: true }] });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()).toEqual([]);
  });

  it("a review_needed for a DIFFERENT gate does not fail open", async () => {
    setWorkflow({ notifications: [reviewNeeded("TEAM-901")] });

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", legacyFallback: true });
  });

  it("a `none`-seeded row is legacy too: admitted via the legacy CAS, not the requested one", async () => {
    // The reason legacyFallback is `state not in GATE_STATES` and not `!gateState`:
    // a seeded-but-never-requested row exists as an object, and markGateRejected's
    // CAS can never hold on it (state "none" ≠ "requested"). Losing THAT write was
    // never a duplicate — which is why the legacy row gets its own CAS.
    setWorkflow({ gateState: "none", notifications: [reviewNeeded()] });
    h.state.rejectClaims = false; // the requested-CAS outcome is now irrelevant here

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    expect(ignored()).toEqual([]);
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    expect(writesOfOp("rejected")).toHaveLength(0);
  });

  it("a creation-time `todo → blocked` never reaches the guard at all", async () => {
    setWorkflow({ gateState: "requested" });

    for (const oldStatus of ["todo", "new", ""]) {
      await handler(streamEvent({ oldStatus }));
    }

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()).toEqual([]);
    expect(h.state.workflowReads).toBe(0); // the TEAM-4044 check is still ahead of all I/O
  });

  it("fails OPEN when the ledger itself is broken", async () => {
    setWorkflow({ gateState: "requested" });
    h.state.gateWriteThrows = true;

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    expect(ignored()).toEqual([]);
  });

  it("fails OPEN when the workflow cannot be resolved", async () => {
    h.state.workflow = null;

    await handler(streamEvent());

    // No workflow → no ledger to consult and nothing to report; the rejection is
    // handed on exactly as it was before the guard existed.
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()).toEqual([]);
  });
});

/**
 * TEAM-4129 F2 — a legacy row must CONVERGE, or enforce protects nothing on any
 * run that predates the flag.
 *
 * Before the fix: the legacy admit ran markGateRejected, whose CAS
 * (`state = "requested"`) can never hold on an absent / `none` row, so the ledger
 * stayed unconverged; `|| legacyFallback` then re-admitted every redelivery, and
 * handleReviewRejection reopened the same upstream work again. The state the fake
 * store flips here is exactly what the real CAS leaves behind.
 */
describe("legacy rows converge to `rejected` (TEAM-4129 F2)", () => {
  const legacy = () => setWorkflow({ notifications: [reviewNeeded()] }); // no gateStates at all

  it("enforce: two identical deliveries → the FIRST is admitted, the second is a duplicate", async () => {
    await load("enforce");
    legacy();

    await handler(streamEvent());
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    // The ledger no longer lies about this gate.
    expect(h.state.workflow.gateStates[GATE].state).toBe("rejected");

    // The SAME transition again (webhook redelivery, or the stream twin).
    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1); // NOT reopened twice
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    // Classified off the converged row, so no second CAS is even attempted.
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    expect(writesOfOp("rejected")).toHaveLength(0);
    expect(ignored()).toEqual([{
      workflowId: "wf_1", ticketId: GATE, reason: "duplicate", oldStatus: "in_review",
      // The converged state is what the second delivery reads — legacyFallback is
      // false NOW, which is the whole point of converging.
      gateState: "rejected", legacyFallback: false, wouldDrop: true, mode: "enforce",
      timestamp: expect.any(String),
    }]);
  });

  it("shadow: both deliveries run, but the ledger converges and the second reports wouldDrop", async () => {
    await load("shadow");
    legacy();

    await handler(streamEvent());
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    // Shadow's job IS to populate the ledger, so it converges like enforce.
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    expect(h.state.workflow.gateStates[GATE].state).toBe("rejected");
    expect(ignored()).toEqual([]);

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(2); // shadow drops NOTHING
    expect(eventsOfType("review.rejected")).toHaveLength(2);
    expect(ignored()).toHaveLength(1);
    expect(ignored()[0]).toMatchObject({
      reason: "duplicate", gateState: "rejected", legacyFallback: false,
      wouldDrop: true, mode: "shadow",
    });
  });

  it("enforce: a LOST legacy CAS on the first delivery IS the duplicate (the twin won the race)", async () => {
    // Both twins read the same unconverged snapshot; exactly one converges it.
    // The loser dropping is the entire reason the CAS is the admit decision — and
    // the deliberate exception to the guard's fail-open posture, since the
    // alternative is reopening the upstream work twice on every legacy run.
    await load("enforce");
    legacy();
    h.state.legacyClaims = false;

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOfType("review.rejected")).toHaveLength(0);
    expect(writesOfOp("rejected_legacy")).toHaveLength(1);
    expect(ignored()[0]).toMatchObject({
      reason: "duplicate", gateState: null, legacyFallback: true,
      wouldDrop: true, mode: "enforce",
    });
  });

  it("shadow: a lost legacy CAS still runs (shadow never manufactures a drop)", async () => {
    await load("shadow");
    legacy();
    h.state.legacyClaims = false;

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()).toEqual([]);
  });

  it("off: no converge write at all — still byte-identical", async () => {
    await load(undefined);
    legacy();

    await handler(streamEvent());
    await handler(streamEvent());

    // Twice reopened, exactly as before the guard existed, and zero ledger writes.
    expect(h.state.enforce).toHaveBeenCalledTimes(2);
    expect(h.state.gateWrites).toEqual([]);
    expect(h.state.workflow.gateStates).toBeUndefined();
    expect(ignored()).toEqual([]);
  });

  it("a broken ledger write still fails OPEN on a legacy row", async () => {
    await load("enforce");
    legacy();
    h.state.gateWriteThrows = true;

    await handler(streamEvent());

    // The throw is caught by the guard's own catch → admit. A ledger outage must
    // never be how a human's Request-changes gets swallowed.
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()).toEqual([]);
  });

  it("a gate that was never presented is STILL unrequested — no converge write", async () => {
    // Only the `presented` classification converges: an absent row with no
    // review_needed must not be marked rejected, or a later real park/reject cycle
    // would read a rejection nobody ever made.
    await load("enforce");
    setWorkflow(); // no gateStates, no notifications

    await handler(streamEvent());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", legacyFallback: true });
  });
});

describe("GATE_STATE_GUARD=shadow — records and reports, drops nothing", () => {
  beforeEach(async () => { await load("shadow"); });

  it("a would-be duplicate still runs, and is reported with wouldDrop:true", async () => {
    setWorkflow({ gateState: "rejected", notifications: [reviewNeeded()] });

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1); // NOT dropped
    expect(eventsOfType("review.rejected")).toHaveLength(1);
    expect(ignored()[0]).toMatchObject({ reason: "duplicate", wouldDrop: true, mode: "shadow" });
  });

  it("a would-be unrequested drop still runs, and is reported", async () => {
    setWorkflow();

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", wouldDrop: true, mode: "shadow" });
  });

  it("shadow WRITES the ledger (its CAS has to be live before anyone enforces)", async () => {
    setWorkflow({ gateState: "requested" });

    await handler(streamEvent());

    expect(writesOfOp("rejected")).toHaveLength(1);
    expect(ignored()).toEqual([]);
  });

  it("a lost CAS in shadow is not even reported — shadow never manufactures a drop", async () => {
    setWorkflow({ gateState: "requested" });
    h.state.rejectClaims = false;

    await handler(streamEvent());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()).toEqual([]);
  });
});

/**
 * The Jira-webhook twin. index.mjs snapshots TICKET_PROVIDER at module load, so
 * this suite re-imports in Jira mode and routes jiraFetch's global.fetch by URL
 * (same harness as review-rejection.test.mjs's F2 suite).
 */
describe("GATE_STATE_GUARD — the Jira-webhook twin (processStatusChange)", () => {
  const jiraIssue = (key, { status = "Blocked", labels = [], blockedBy = [] } = {}) => ({
    key,
    fields: {
      summary: key,
      status: { name: status },
      labels,
      issuetype: { name: "Task" },
      parent: { key: PARENT },
      issuelinks: blockedBy.map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
      comment: { comments: [] },
    },
  });
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
  const jiraRouter = (issues) =>
    vi.fn(async (url, init = {}) => {
      const u = String(url);
      const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if ((init.method || "GET") === "GET") return jsonResp({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
        return { ok: true, status: 204, text: async () => "" };
      }
      if (sub === "/comment") return jsonResp({}, 201);
      return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "not found" };
    });

  const HUMAN_GATE = jiraIssue(GATE, { labels: ["human-review", "reviewer:engineer", "wf:wf_1"], blockedBy: [UPSTREAM] });
  const UPSTREAM_ISSUE = jiraIssue(UPSTREAM, { status: "Done", labels: ["agent:agentcore_hub_api_dev"] });
  const webhook = (oldStatus = "in_review") => ({ source: "jira-webhook", ticketId: GATE, newStatus: "blocked", oldStatus });

  const ORIGINAL_FETCH = global.fetch;
  beforeEach(() => {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
    global.fetch = jiraRouter({ [GATE]: HUMAN_GATE, [UPSTREAM]: UPSTREAM_ISSUE });
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.TICKET_PROVIDER;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it("enforce: a `requested` gate is admitted; the redelivery that loses the CAS is dropped", async () => {
    await load("enforce");
    setWorkflow({ gateState: "requested" });

    await handler(webhook());
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(writesOfOp("rejected")).toHaveLength(1);

    h.state.rejectClaims = false;
    await handler(webhook());
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(ignored()[0]).toMatchObject({ reason: "duplicate", mode: "enforce" });
  });

  it("enforce: a never-presented gate is dropped on this twin too", async () => {
    await load("enforce");
    setWorkflow();

    await handler(webhook());

    expect(h.state.enforce).not.toHaveBeenCalled();
    expect(eventsOfType("review.rejected")).toHaveLength(0);
    expect(ignored()[0]).toMatchObject({ reason: "unrequested", legacyFallback: true });
  });

  it("off: this twin is unchanged — the same never-presented gate still rejects", async () => {
    await load(undefined);
    setWorkflow();

    await handler(webhook());

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.gateWrites).toEqual([]);
    expect(ignored()).toEqual([]);
  });
});

/**
 * The two ends of a cycle. If either hook is missing, enforce eventually drops a
 * real rejection (no `requested` recorded) or admits one on a decided gate
 * (`requested` never closed) — so both are pinned at the handler level.
 */
describe("the cycle's ends — parking a gate opens it, approving it closes it", () => {
  it("the Ready path records `requested` before the reviewer is paged", async () => {
    await load("enforce");

    await handler(streamEvent({ oldStatus: "todo", newStatus: "ready" }));

    expect(writesOfOp("requested")).toHaveLength(1);
    expect(writesOfOp("requested")[0]).toMatchObject({ wfId: "wf_1", ticketId: GATE });
    expect(eventsOfType("review.needed")).toHaveLength(1);
  });

  it("a failed `requested` write never delays the ping (best-effort)", async () => {
    await load("enforce");
    h.state.gateWriteThrows = true;

    await handler(streamEvent({ oldStatus: "todo", newStatus: "ready" }));

    expect(writesOfOp("requested")).toHaveLength(1);
    expect(eventsOfType("review.needed")).toHaveLength(1);
  });

  it("the approve path (gate → done) closes the cycle with its requestedAt", async () => {
    await load("enforce");
    setWorkflow({ gateState: "requested", notifications: [reviewNeeded()] });
    h.state.children = [{ ticketId: GATE, parentId: PARENT, status: "done", assignee: "human:engineer", type: "task" }];

    await handleTicketDone(GATE, { parentId: PARENT, workflowId: "wf_1", assignee: "human:engineer" });

    expect(writesOfOp("approved")).toHaveLength(1);
    expect(writesOfOp("approved")[0]).toMatchObject({ wfId: "wf_1", ticketId: GATE, opts: { requestedAt: REQUESTED_AT } });
  });

  it("off: the approve path writes nothing", async () => {
    await load(undefined);
    setWorkflow({ gateState: "requested", notifications: [reviewNeeded()] });
    h.state.children = [{ ticketId: GATE, parentId: PARENT, status: "done", assignee: "human:engineer", type: "task" }];

    await handleTicketDone(GATE, { parentId: PARENT, workflowId: "wf_1", assignee: "human:engineer" });

    expect(h.state.gateWrites).toEqual([]);
  });

  it("an AGENT ticket going done never touches the gate ledger", async () => {
    await load("enforce");
    h.state.children = [{ ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: "agentcore_hub_api_dev", type: "task" }];

    await handleTicketDone(UPSTREAM, { parentId: PARENT, workflowId: "wf_1", assignee: "agentcore_hub_api_dev" });

    expect(h.state.gateWrites).toEqual([]);
  });
});
