import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3991 D2.1 + D2.2 — the two halves of "the run moved on and nobody asked
 * the siblings".
 *
 * D2.1 (recompute): the cascade answers "who did THIS ticket unblock?". wf sffzti
 * broke that assumption — TEAM-3799 was blockedBy nothing, all its work was
 * unblocked, it had no live lease, and no cascade edge pointed at it, so it sat
 * until a human dispatched it by hand. After the human decided the escalation
 * gate, EVERY sibling must be re-asked the invariant, through the ONE
 * implementation of it (cascade.reconcileDependent — R3).
 *
 * D2.2 (park): the mirror failure. An agent ticket pushed to `blocked` mid-run
 * (a fix ticket was filed against it) kept a `running` claim, so every liveness
 * check downstream read it as a session in flight and nothing re-drove it when
 * the blocker cleared (wf 1pl3h1's TEAM-3727). The claim must be parked, and
 * `parked` is deliberately not a live claim status.
 *
 * Harness: done-handlers-cascade's §3(a) shape — REAL index.mjs driving the REAL
 * cascade + REAL lease logic, only the AWS/store seams mocked. A mocked cascade
 * would prove nothing here: the point is that the recompute reaches a real
 * dispatch.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    lambdaInvokes: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    // TEAM-4099 F7 — every single-ticket provider read (GetCommand on the tickets
    // table), so a test can assert the read COUNT, not the implementation.
    getReads: /** @type {string[]} */ ([]),
    store: {
      claimInvocation: /** @type {any[]} */ ([]),
      parkClaim: /** @type {any[]} */ ([]),
      parkClaimResult: true,
    },
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
          if (name === "GetCommand") {
            h.state.getReads.push(cmd.input.Key.ticketId);
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (name === "QueryCommand") {
            // No heartbeats in the events table → every lease reads stale.
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send(cmd) { h.state.lambdaInvokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
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
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  completeTaskEntry: vi.fn(async () => {}),
  claimInvocation: vi.fn(async (wfId, tid) => { h.state.store.claimInvocation.push({ wfId, tid }); return true; }),
  appendReviewNotificationOnce: vi.fn(async () => true),
  appendReviewRound: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  mergeTaskMetadataOrTrack: vi.fn(async () => {}),
  appendNotificationOnce: vi.fn(async () => true),
  appendNotification: vi.fn(async () => {}),
  resetDeadSessionRetry: vi.fn(async () => {}),
  incrementDeadSessionRetry: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  trackTask: vi.fn(async () => {}),
  // D2.2 — the CAS under test. The park is only claimed when THIS caller wins.
  parkClaim: vi.fn(async (wfId, tid, expectedStartedAt) => {
    h.state.store.parkClaim.push({ wfId, tid, expectedStartedAt });
    return h.state.store.parkClaimResult;
  }),
}));

// cascade.mjs / lease.mjs deliberately NOT mocked.
process.env.CASCADE_EXTENDED_STATES = "enforce";
process.env.RUNTIME_ARN_AGENTCORE_HUB_BACKEND_DEV =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/backend-dev";
process.env.RUNTIME_ARN_AGENTCORE_HUB_RELEASE_MANAGER =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/release-manager";

const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const RM = "agentcore_hub_release_manager";
const REVIEWER = "human:reviewer@example.com";
const ESC_GATE = "TEAM-3790";
const STALLED = "TEAM-3799"; // blockedBy nothing observable — the sffzti shape
const RM_TICKET = "TEAM-3800";
const UPSTREAM = "TEAM-3798";

let handleTicketDoneUnified;
let handler;
let recomputeRun;

async function load(provider = "dynamodb") {
  process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ handleTicketDoneUnified, handler, recomputeRun } = await import("./index.mjs"));
}

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);
const invokedTickets = () =>
  h.state.lambdaInvokes.map((i) => { try { return JSON.parse(i.Payload).ticketId; } catch { return null; } });

beforeEach(() => {
  h.state.tickets = {};
  h.state.children = [];
  h.state.workflow = null;
  h.state.lambdaInvokes.length = 0;
  h.state.events.length = 0;
  h.state.getReads.length = 0;
  h.state.store.claimInvocation.length = 0;
  h.state.store.parkClaim.length = 0;
  h.state.store.parkClaimResult = true;
});

// ─── D2.1 recompute ──────────────────────────────────────────────────────────

/** wf sffzti: the escalation gate a human just Done'd, plus the run's siblings. */
function sffztiRun() {
  h.state.tickets = {
    [ESC_GATE]: {
      ticketId: ESC_GATE, parentId: PARENT, workflowId: "wf_1", assignee: REVIEWER,
      status: "done", title: "Escalation #1: ship-review not converging (round 3)",
    },
    [UPSTREAM]: { ticketId: UPSTREAM, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" },
    // The RM's own blocker is still open, so the RM is NOT a recompute candidate
    // — it is reached by the targeted TEAM-3971 wake instead. Human-assigned, so
    // it is never a candidate itself either.
    "TEAM-3801": { ticketId: "TEAM-3801", parentId: PARENT, workflowId: "wf_1", assignee: REVIEWER, status: "in_review" },
  };
  h.state.children = [
    { ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
    { ticketId: ESC_GATE, parentId: PARENT, status: "done", assignee: REVIEWER, type: "task", title: "Escalation #1: ship-review not converging (round 3)" },
    // The stalled sibling: blockers DONE, no live lease, and NOT blockedBy the
    // gate — invisible to the cascade, which is exactly why it needed a human.
    { ticketId: STALLED, parentId: PARENT, status: "blocked", assignee: DEV, type: "task", blockedBy: [UPSTREAM] },
    { ticketId: "TEAM-3801", parentId: PARENT, status: "in_review", assignee: REVIEWER, type: "task" },
    { ticketId: RM_TICKET, parentId: PARENT, status: "todo", assignee: RM, type: "task", blockedBy: ["TEAM-3801"] },
  ];
  h.state.workflow = {
    id: "wf_1", workflowId: "wf_1", epicId: PARENT, workflowDefId: "software-delivery",
    phase: "ship", input: { title: "t" }, humanNotifications: [],
    agentTasks: {}, // no claims at all → nothing reads live
  };
}

const recomputes = () => eventsOfType("orchestrator.recompute").map((e) => e.detail);

describe("recomputeRun re-asks every sibling (D2.1)", () => {
  it("sffzti shape: a decided escalation gate re-drives TEAM-3799 through the cascade, with ZERO manager dispatches", async () => {
    await load();
    sffztiRun();

    await handleTicketDoneUnified(ESC_GATE);

    // Both human-gate hooks fired: the approval announcement and the
    // escalation-decision wake each recompute the run.
    const triggers = recomputes().map((r) => r.trigger);
    expect(triggers).toContain("review.approved");
    expect(triggers).toContain("escalation_decided");

    const first = recomputes()[0];
    expect(first.workflowId).toBe("wf_1");
    expect(first.candidates).toContain(STALLED);
    // Never candidates: the human gate itself, a done sibling, a human ticket,
    // and a sibling whose own blocker is still open.
    expect(first.candidates).not.toContain(ESC_GATE);
    expect(first.candidates).not.toContain(UPSTREAM);
    expect(first.candidates).not.toContain("TEAM-3801");
    expect(first.candidates).not.toContain(RM_TICKET);
    // Outcome + the D2.1 structured reason, straight from reconcileDependent.
    expect(first.outcomes[STALLED]).toEqual({ outcome: "redispatched", reason: "claimed" });

    // …and the re-drive is REAL: the claim CAS was won and the agent invoked.
    expect(h.state.store.claimInvocation.some((c) => c.tid === STALLED)).toBe(true);
    expect(invokedTickets()).toContain(STALLED);

    // The whole point: no human had to touch it.
    expect(eventsOfType("manager.intervention")).toHaveLength(0);

    // The approval itself is announced (the ledger row is NOT written here — F6).
    const approved = eventsOfType("review.approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].detail).toMatchObject({ workflowId: "wf_1", gateTicketId: ESC_GATE });
  });

  it("an agent ticket's completion recomputes the run too (trigger agent.complete)", async () => {
    await load();
    sffztiRun();
    h.state.tickets[UPSTREAM] = { ticketId: UPSTREAM, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" };

    await handleTicketDoneUnified(UPSTREAM);

    const agentComplete = recomputes().filter((r) => r.trigger === "agent.complete");
    expect(agentComplete).toHaveLength(1);
    expect(agentComplete[0].candidates).toContain(STALLED);
  });

  it("a run with no eligible sibling emits NO recompute event (a backstop that says nothing when there is nothing)", async () => {
    await load();
    h.state.tickets = { [UPSTREAM]: { ticketId: UPSTREAM, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" } };
    h.state.children = [
      { ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      // Human-assigned gate, an unassigned row, and a still-blocked sibling:
      // none is a candidate.
      { ticketId: "TEAM-9", parentId: PARENT, status: "in_review", assignee: REVIEWER, type: "task" },
      { ticketId: "TEAM-10", parentId: PARENT, status: "todo", assignee: null, type: "task" },
      { ticketId: STALLED, parentId: PARENT, status: "blocked", assignee: DEV, type: "task", blockedBy: ["TEAM-9"] },
    ];
    h.state.workflow = {
      id: "wf_1", workflowId: "wf_1", epicId: PARENT, workflowDefId: "software-delivery",
      input: { title: "t" }, humanNotifications: [], agentTasks: {},
    };

    await handleTicketDoneUnified(UPSTREAM);

    expect(eventsOfType("orchestrator.recompute")).toHaveLength(0);
    expect(invokedTickets()).not.toContain(STALLED);
  });
});

// ─── TEAM-4099 F7 — the recompute is bounded ─────────────────────────────────

/**
 * The backstop above runs on EVERY terminal signal, inside the same 60-second
 * invocation that owns the completion, fix-verification and gate work for the
 * record that triggered it. These tests pin the three bounds as invariants —
 * provider read count, reconcile count — never as "which helper was called".
 */

/** Warm the roster/defs cache the way a real invocation does, then clear counters. */
async function warm() {
  await handler({ source: "orchestrator.sweep", action: "runtime_health_sweep" });
  h.state.getReads.length = 0;
  h.state.events.length = 0;
}

/** A FRESH run object per test — reconcileDependent mutates agentTasks in place. */
const newWf = () => ({ id: "wf_1", workflowId: "wf_1", epicId: PARENT, workflowDefId: "software-delivery", input: { title: "t" }, humanNotifications: [], agentTasks: {} });

/** `n` agent siblings, each blocked behind `blockedBy`. No claims → nothing live. */
const blockedSiblings = (n, blockedBy, prefix = "TASK") =>
  Array.from({ length: n }, (_, i) => ({
    ticketId: `${prefix}-${i}`, parentId: PARENT, status: "blocked", assignee: DEV, type: "task", blockedBy,
  }));

describe("recompute bounds (TEAM-4099 F7)", () => {
  it("100 siblings x 5 blockers each: ZERO single-ticket provider reads (the snapshot already has them)", async () => {
    await load();
    await warm();
    // 4 done blockers + 1 still-open one, all siblings of the same epic. The
    // predicate therefore walks all 5 edges of all 100 siblings — 500 blocker
    // resolutions, which used to be 500 serial getTicket round-trips.
    const done = Array.from({ length: 4 }, (_, i) => ({ ticketId: `BLK-${i}`, parentId: PARENT, status: "done", assignee: DEV, type: "task" }));
    // The open one is a human gate, so it is not a candidate in its own right —
    // this test measures the PREDICATE's reads and nothing else.
    const open = { ticketId: "BLK-OPEN", parentId: PARENT, status: "in_review", assignee: REVIEWER, type: "task" };
    h.state.children = [
      ...done, open,
      ...blockedSiblings(100, [...done.map((d) => d.ticketId), open.ticketId]),
    ];
    // Every sibling is ALSO readable one-by-one from the tickets table — the
    // measurement is that the recompute does not need to, not that it cannot.
    for (const c of h.state.children) h.state.tickets[c.ticketId] = { ...c, workflowId: "wf_1" };
    const wf = newWf();
    h.state.workflow = wf;

    const result = await recomputeRun(wf, PARENT, "agent.complete");

    expect(result.scanned).toBe(105);
    expect(result.candidates).toEqual([]); // every one is genuinely still blocked
    expect(h.state.getReads).toEqual([]); // <- the F7 invariant
    expect(result.foreignReads).toBe(0);
  });

  it("cross-epic blockers cost ONE read each, memoized — not one per sibling edge", async () => {
    await load();
    await warm();
    // Neither blocker is a child of this epic, so neither is in the snapshot.
    h.state.tickets = {
      "OTHER-1": { ticketId: "OTHER-1", status: "done" },
      "OTHER-2": { ticketId: "OTHER-2", status: "in_progress" },
    };
    h.state.children = blockedSiblings(20, ["OTHER-1", "OTHER-2"]);
    const wf = newWf();
    h.state.workflow = wf;

    const result = await recomputeRun(wf, PARENT, "agent.complete");

    // 40 blocker edges over 20 siblings, 2 distinct foreign ids => 2 reads.
    expect(h.state.getReads.sort()).toEqual(["OTHER-1", "OTHER-2"]);
    expect(result.foreignReads).toBe(2);
    expect(result.candidates).toEqual([]);
  });

  it("over the candidate cap: stops at the cap, says truncated, and leaves the rest to the sweep", async () => {
    process.env.RECOMPUTE_MAX_CANDIDATES = "5";
    await load();
    await warm();
    h.state.children = [
      { ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      ...blockedSiblings(12, [UPSTREAM]),
    ];
    const wf = newWf();
    h.state.workflow = wf;

    const result = await recomputeRun(wf, PARENT, "agent.complete");
    delete process.env.RECOMPUTE_MAX_CANDIDATES;

    expect(result.candidates).toHaveLength(5);
    expect(result.truncated).toBe(true);
    // The bound is on WORK done, not just on the reported list.
    expect(h.state.store.claimInvocation).toHaveLength(5);
    expect(invokedTickets()).toHaveLength(5);
    // …and a hit bound is always announced, so an operator can see the gap.
    expect(recomputes()[0]).toMatchObject({ truncated: true, cap: 5 });
  });

  it("over the wall-clock budget: stops mid-scan and says budgetExceeded", async () => {
    await load();
    await warm();
    h.state.children = [
      { ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      ...blockedSiblings(3, [UPSTREAM]),
    ];
    const wf = newWf();
    h.state.workflow = wf;

    // 15s per tick: the first candidate is inside the 20s budget, the second is not.
    let t = -15_000;
    const now = () => (t += 15_000);

    const result = await recomputeRun(wf, PARENT, "agent.complete", { now });

    expect(result.candidates).toHaveLength(1);
    expect(result.budgetExceeded).toBe(true);
    expect(h.state.store.claimInvocation).toHaveLength(1);
    expect(recomputes()[0]).toMatchObject({ budgetExceeded: true, budgetMs: 20_000 });
  });

  it("two terminal records for the same run in one invocation recompute it once, and a reset re-arms it", async () => {
    await load();
    await warm();
    h.state.children = [
      { ticketId: UPSTREAM, parentId: PARENT, status: "done", assignee: DEV, type: "task" },
      ...blockedSiblings(1, [UPSTREAM]),
    ];
    const wf = newWf();
    h.state.workflow = wf;

    const first = await recomputeRun(wf, PARENT, "agent.complete");
    const second = await recomputeRun(wf, PARENT, "agent.complete");
    // A different trigger is a different question — never deduped away.
    const other = await recomputeRun(wf, PARENT, "review.approved");

    expect(first.candidates).toEqual(["TASK-0"]);
    expect(second).toMatchObject({ deduped: true, candidates: [] });
    expect(other.candidates).toEqual(["TASK-0"]);
    expect(recomputes().map((r) => r.trigger)).toEqual(["agent.complete", "review.approved"]);

    // The next invocation starts clean (the handler clears the per-invocation set).
    await warm();
    expect((await recomputeRun(wf, PARENT, "agent.complete")).candidates).toEqual(["TASK-0"]);
  });
});

// ─── D2.2 park ───────────────────────────────────────────────────────────────

/** wf 1pl3h1: TEAM-3727 running, then pushed to blocked by its fix ticket. */
function parkedRun(taskStatus = "running") {
  h.state.tickets = {
    "TEAM-3727": { ticketId: "TEAM-3727", parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "blocked" },
    "GATE-1": { ticketId: "GATE-1", parentId: PARENT, workflowId: "wf_1", assignee: REVIEWER, status: "blocked", title: "Merge Approval" },
  };
  h.state.workflow = {
    id: "wf_1", workflowId: "wf_1", epicId: PARENT, workflowDefId: "software-delivery",
    input: { title: "t" }, humanNotifications: [],
    agentTasks: {
      "TEAM-3727": { id: "t1", agentId: DEV, ticketId: "TEAM-3727", status: taskStatus, startedAt: "2026-09-01T20:56:00Z" },
    },
  };
}

const streamRecord = (ticketId, status, extra = {}) => ({
  eventName: "MODIFY",
  dynamodb: {
    NewImage: { ticketId, status, parentId: PARENT, workflowId: "wf_1", ...extra },
    OldImage: { ticketId, status: "in_progress" },
  },
});

describe("an agent ticket going blocked parks its claim (D2.2)", () => {
  it("DDB-stream path: running claim → parkClaim with the observed startedAt + agent.parked", async () => {
    await load();
    parkedRun("running");

    await handler({ Records: [streamRecord("TEAM-3727", "blocked", { assignee: DEV })] });

    expect(h.state.store.parkClaim).toEqual([
      { wfId: "wf_1", tid: "TEAM-3727", expectedStartedAt: "2026-09-01T20:56:00Z" },
    ]);
    const parked = eventsOfType("agent.parked");
    expect(parked).toHaveLength(1);
    expect(parked[0].detail).toMatchObject({ workflowId: "wf_1", ticketId: "TEAM-3727", agentId: DEV });
  });

  it("Jira-webhook path: the same park (both blocked handlers, not one)", async () => {
    await load("jira");
    parkedRun("in_progress");
    // In Jira mode getTicket goes to the Jira REST API, not the tickets table.
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        key: "TEAM-3727",
        fields: {
          summary: "Backend dev work",
          status: { name: "Blocked" },
          issuetype: { name: "Task" },
          parent: { key: PARENT },
          labels: [`agent:${DEV}`, "wf:wf_1"],
        },
      }),
    }));

    await handler({ source: "jira-webhook", ticketId: "TEAM-3727", newStatus: "blocked", oldStatus: "in_progress" });
    vi.unstubAllGlobals();

    expect(h.state.store.parkClaim).toEqual([
      { wfId: "wf_1", tid: "TEAM-3727", expectedStartedAt: "2026-09-01T20:56:00Z" },
    ]);
    expect(eventsOfType("agent.parked")).toHaveLength(1);
  });

  it("a HUMAN gate going blocked is 'request changes', not a park — parkClaim is never called", async () => {
    await load();
    parkedRun("running");

    await handler({ Records: [streamRecord("GATE-1", "blocked", { assignee: REVIEWER })] });

    expect(h.state.store.parkClaim).toHaveLength(0);
    expect(eventsOfType("agent.parked")).toHaveLength(0);
  });

  it("a task that is not holding a live claim is left alone (no wasted CAS)", async () => {
    await load();
    parkedRun("complete");

    await handler({ Records: [streamRecord("TEAM-3727", "blocked", { assignee: DEV })] });

    expect(h.state.store.parkClaim).toHaveLength(0);
    expect(eventsOfType("agent.parked")).toHaveLength(0);
  });

  it("losing the CAS (the claim already moved on) publishes nothing", async () => {
    await load();
    parkedRun("running");
    h.state.store.parkClaimResult = false;

    await handler({ Records: [streamRecord("TEAM-3727", "blocked", { assignee: DEV })] });

    expect(h.state.store.parkClaim).toHaveLength(1);
    expect(eventsOfType("agent.parked")).toHaveLength(0);
  });
});
