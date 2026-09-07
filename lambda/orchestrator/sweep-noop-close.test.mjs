import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import workflowsConfig from "../../src/config/workflows.json";
import agentsConfig from "../../src/config/agents.json";

/**
 * TEAM-4247 D2 — a dead-code sweep that verified NOTHING to remove is ended by the
 * ORCHESTRATOR, not by the model.
 *
 * The hole, verbatim from blueprints/code-sweeper.md Step 2.5: on a zero-yield
 * sweep the agent is told to `Tickets___list_tickets(epic)` and hand-`skip` every
 * downstream ticket "in REVERSE dependency order". That is a mass ticket mutation
 * performed by an LLM as the run's only termination mechanism. Miss one ticket, or
 * skip out of order, and the cascade dispatches a reviewer / QA / CI / release
 * manager against a branch that does not exist — and the Merge Approval gate pages
 * a human to approve a merge with no PR.
 *
 * The gate is therefore about the WIRING, which is why these tests drive the REAL
 * handlers (both done twins) through the REAL cascade with only the I/O seams
 * mocked — the done-handlers-cascade.test.mjs harness. The properties under test
 * are exactly the ones a pure predicate cannot express:
 *   - ZERO successor dispatches (the cascade does not run for this ticket),
 *   - `workflow.complete` is NEVER published — nothing shipped,
 *   - one close per run across the webhook twin, the stream twin and a redelivery
 *     (the CAS in store.claimTerminalOutcome is the sole arbiter),
 *   - off is byte-identical: the completion record is not even read.
 *
 * The board models run c2uqki: epic TEAM-4228, sweeper TEAM-4230 reporting
 * "OUTCOME: ZERO verified-dead removals" out of 93 candidates, with the reviewer /
 * QA / CI / ship chain and the human Merge Approval gate still open behind it.
 */

const EPIC = "TEAM-4228";
const DETECT = "TEAM-4230"; // the sweeper's detection ticket
const REVIEW = "TEAM-4231";
const QA = "TEAM-4232";
const CI = "TEAM-4233";
const GATE = "TEAM-4239"; // human Merge Approval
const WF = "wf_c2uqki";
const SWEEPER = "agentcore_hub_code_sweeper";
const PR = "https://github.com/tycenjmccann/ember/pull/60";

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    scanRows: /** @type {any[]} */ ([]), // rows the reconcile sweep's Scan may see
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, any>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    updates: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    githubCalls: /** @type {any[]} */ ([]),
    githubFails: false,
    claimWins: true,
    claims: /** @type {any[]} */ ([]),
    finalized: /** @type {string[]} */ ([]),
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
          const table = cmd.input.TableName;
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "QueryCommand") {
            // lease.mjs reads the EVENTS table for heartbeats; getChildTickets and
            // the completion snapshot read the TICKETS parentId-index.
            if (table === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "ScanCommand") {
            // The reconcile sweep's open-workflow scan (sweep-scan.mjs) filters on
            // NOT (#p IN (:tp0…)), derived from TERMINAL_WORKFLOW_PHASES. Evaluate
            // that filter for REAL against `scanRows` so "a closed run is never
            // swept" is a property of the expression the code builds, not of the
            // mock. Empty by default → every other test is unaffected.
            const excluded = Object.entries(cmd.input.ExpressionAttributeValues || {})
              .filter(([k]) => k.startsWith(":tp"))
              .map(([, v]) => v);
            return { Items: (h.state.scanRows || []).filter((r) => !excluded.includes(r.phase)) };
          }
          return {};
        },
      }),
    },
  };
});

// Every agent dispatch and every Tickets___* tool call goes through the Lambda
// client — capturing it is how "zero successor dispatches" is proven.
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      h.state.lambdaInvokes.push(cmd.input);
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd.input?.Key || "";
      if (cmd.constructor.name === "GetObjectCommand") h.state.s3Gets.push(key);
      // loadReviewPackage LISTS the shared/ prefix before reading the parts. Served
      // out of the same seeded object map so the merge-and-clamp path runs for real;
      // with nothing seeded it returns no Contents, which is what every other test
      // in this file already relied on (the throw below was caught and read as
      // "no package").
      if (cmd.constructor.name === "ListObjectsV2Command") {
        const prefix = cmd.input?.Prefix || "";
        return { Contents: Object.keys(h.state.s3Objects).filter((k) => k.startsWith(prefix)).map((k) => ({ Key: k })) };
      }
      if (cmd.constructor.name !== "GetObjectCommand" || !(key in h.state.s3Objects)) {
        const err = new Error(`NoSuchKey: ${key}`);
        err.name = "NoSuchKey";
        throw err;
      }
      const body = h.state.s3Objects[key];
      return { Body: { transformToString: async () => (typeof body === "string" ? body : JSON.stringify(body)) } };
    }
  },
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
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => {
    if (h.state.workflow?.agentTasks?.[tid]) Object.assign(h.state.workflow.agentTasks[tid], fields);
  }),
  claimInvocation: vi.fn(async () => true),
  appendReviewNotificationOnce: vi.fn(async () => true),
  setTaskStatus: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => true),
  // The CAS. Returning false models "another writer already claimed a terminal
  // phase" — the twin/redelivery case.
  claimTerminalOutcome: vi.fn(async (workflowId, outcome, completedAt, reason) => {
    h.state.claims.push({ workflowId, outcome, completedAt, reason });
    return h.state.claimWins;
  }),
  markFinalized: vi.fn(async (workflowId) => { h.state.finalized.push(workflowId); }),
}));

// loadWorkflowDefs early-returns without a bucket, and readCompletionRecord
// returns null — both read at module load, so set before the dynamic import.
process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "ghp_test";
process.env.RUNTIME_ARN_AGENTCORE_HUB_CODE_REVIEWER =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/code-reviewer";

/**
 * The dead-code-sweep def as the orchestrator will see it, with the detection
 * phase present. Written to survive commit 4 landing the phase in the repo config:
 * it is inserted only when the config does not already declare it, so this file
 * asserts the same shape before and after.
 */
function sweepDefWithDetection() {
  const def = JSON.parse(
    JSON.stringify(workflowsConfig.workflows.find((w) => w.id === "dead-code-sweep"))
  );
  if (!def.phases.some((p) => p.agentPhase === "detection")) {
    def.phases.splice(1, 0, {
      id: "detection",
      name: "Detect",
      type: "agent",
      agentPhase: "detection",
      agentId: SWEEPER,
    });
  }
  return def;
}

/** A completion record as lambda/workflow-output writes it after commit 1. */
function completionRecord(over = {}) {
  return {
    ticket_id: DETECT,
    summary: "OUTCOME: ZERO verified-dead removals survived verification of 93 candidates.",
    completed_at: "2026-08-31T04:12:00Z",
    verified_removable: 0,
    candidates: 93,
    ...over,
  };
}

function makeWorkflow(over = {}) {
  return {
    id: WF,
    workflowId: WF,
    epicId: EPIC,
    workflowDefId: "dead-code-sweep",
    phase: "detection",
    featureBranch: "feature/TEAM-4228-dead-code-sweep-tycenjmccann-ember-2026",
    input: { title: "Dead code sweep: ember" },
    repoConfig: { repos: [{ url: "https://github.com/tycenjmccann/ember" }] },
    humanNotifications: [],
    agentTasks: {
      [DETECT]: { id: "task_detect", agentId: SWEEPER, ticketId: DETECT, status: "running" },
    },
    ...over,
  };
}

/** The c2uqki board: detection done, the whole verify→ship chain still open. */
function board() {
  return [
    { ticketId: DETECT, parentId: EPIC, status: "done", assignee: SWEEPER, phase: "detection", type: "task" },
    { ticketId: REVIEW, parentId: EPIC, status: "todo", assignee: "agentcore_hub_code_reviewer", blockedBy: [DETECT], type: "task" },
    { ticketId: QA, parentId: EPIC, status: "todo", assignee: "agentcore_hub_qa_verifier", blockedBy: [REVIEW], type: "task" },
    { ticketId: CI, parentId: EPIC, status: "todo", assignee: "agentcore_hub_ci_agent", blockedBy: [QA], type: "task" },
    { ticketId: GATE, parentId: EPIC, status: "blocked", assignee: "human:engineer", blockedBy: [CI], type: "task" },
  ];
}

let handleTicketDoneUnified;
let handleTicketDone;
let handler;
let stripUnenforcedDetectionPhase;
let buildAgentContext;
let sweepYieldNote;
let sweepYieldAudience;

async function load(mode) {
  if (mode === undefined) delete process.env.SWEEP_DETECTION_PHASE;
  else process.env.SWEEP_DETECTION_PHASE = mode;
  vi.resetModules();
  ({
    handleTicketDoneUnified, handleTicketDone, handler, stripUnenforcedDetectionPhase,
    buildAgentContext, sweepYieldNote, sweepYieldAudience,
  } = await import("./index.mjs"));
  // Warm the module exactly as production does. The roster, the workflow defs and
  // the CD registry are loaded by `handler`, not by the twins, and both halves
  // matter here: without the defs, getEffectiveWorkflowDef falls back to
  // software-delivery (no detection phase, so the assignee fallback can never
  // match); without the roster, no sweep-def agent is dispatchable and the
  // "enforce dispatches nobody" assertion would pass vacuously.
  await handler({ Records: [] });
}

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);
const streamImage = (over = {}) => ({
  parentId: EPIC,
  workflowId: WF,
  assignee: SWEEPER,
  phase: "detection",
  title: "Detect dead code in ember",
  ...over,
});
/**
 * Every status write the run made, as `[ticketId, status]`. The cascade's whole
 * observable effect on a successor is this write: unblocking TEAM-4231 sets it
 * back to `todo`, and the DISPATCH is level-triggered off the resulting stream
 * record on a later Lambda hop. So "made runnable" is the assertion that is
 * upstream of every dispatch — proving it never happens proves no reviewer, QA,
 * CI or release manager is ever invoked, without depending on the second hop.
 */
const statusWrites = () =>
  h.state.updates
    .map((u) => [u.Key?.ticketId, u.ExpressionAttributeValues?.[":s"]])
    .filter(([, status]) => typeof status === "string");
const RUNNABLE = new Set(["todo", "ready", "in_progress"]);

beforeEach(() => {
  h.state.tickets = {
    [DETECT]: { ticketId: DETECT, parentId: EPIC, workflowId: WF, assignee: SWEEPER, phase: "detection", status: "done" },
  };
  h.state.children = board();
  h.state.scanRows = [];
  h.state.workflow = makeWorkflow();
  h.state.s3Objects = {
    "config/workflows.json": { workflows: [sweepDefWithDetection()] },
    // The real roster: the sweep def's agents must be dispatchable, or "enforce
    // dispatched nobody" would be true of every mode.
    "config/agents.json": agentsConfig,
    [`completions/${DETECT}.json`]: completionRecord(),
  };
  h.state.s3Gets.length = 0;
  h.state.events.length = 0;
  h.state.updates.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.githubCalls.length = 0;
  h.state.githubFails = false;
  h.state.claimWins = true;
  h.state.claims.length = 0;
  h.state.finalized.length = 0;
  vi.stubGlobal("fetch", async (url, init) => {
    h.state.githubCalls.push({ url: String(url), method: init?.method, body: init?.body });
    if (h.state.githubFails) return { ok: false, status: 403, text: async () => '{"message":"forbidden"}' };
    return { ok: true, status: 200, text: async () => "[]" };
  });
});

afterEach(() => {
  delete process.env.SWEEP_DETECTION_PHASE;
  vi.unstubAllGlobals();
});

/** Everything a no-op close must be true of, asserted once for both twins. */
function expectClosedNothingToRemove() {
  // (1) The terminal claim, with the honest outcome — not "complete".
  expect(h.state.claims).toHaveLength(1);
  expect(h.state.claims[0]).toMatchObject({ workflowId: WF, outcome: "nothing-to-remove" });
  expect(h.state.claims[0].reason).toMatch(/zero removals/i);
  expect(h.state.finalized).toEqual([WF]);

  // (2) The event, carrying the yield so a consumer never has to re-read S3.
  const closed = eventsOfType("workflow.nothing_to_remove");
  expect(closed).toHaveLength(1);
  expect(closed[0].detail).toMatchObject({
    workflowId: WF,
    outcome: "nothing-to-remove",
    verifiedRemovable: 0,
    candidates: 93,
    ticketId: DETECT,
  });

  // (3) NOT a completion. This is the assertion the whole gate exists for: the
  //     dossier and the performance card must not record a sweep that shipped.
  expect(eventsOfType("workflow.complete")).toHaveLength(0);

  // (4) ZERO successors: the cascade never ran, so nothing was unblocked, no
  //     successor was made runnable (the write a dispatch is triggered off), no
  //     human gate was woken, and nothing was invoked on this hop either.
  expect(eventsOfType("orchestrator.unblocked")).toHaveLength(0);
  expect(eventsOfType("orchestrator.agent_invoked")).toHaveLength(0);
  expect(eventsOfType("review.needed")).toHaveLength(0);
  expect(statusWrites().filter(([, s]) => RUNNABLE.has(s))).toEqual([]);
  expect(h.state.lambdaInvokes).toEqual([]);

  // (5) The ticket still finished, in the right order — the UI's own signal.
  const complete = eventsOfType("agent.complete");
  expect(complete).toHaveLength(1);
  expect(complete[0].detail).toMatchObject({ ticketId: DETECT, unblocked: [] });
  expect(h.state.events.indexOf(complete[0])).toBeLessThan(h.state.events.indexOf(closed[0]));
}

describe("SWEEP_DETECTION_PHASE=enforce — the orchestrator ends the run", () => {
  beforeEach(async () => { await load("enforce"); });

  it("closes nothing-to-remove from the webhook twin, dispatching nobody", async () => {
    await handleTicketDoneUnified(DETECT);
    expectClosedNothingToRemove();
  });

  it("closes nothing-to-remove from the stream twin, dispatching nobody", async () => {
    await handleTicketDone(DETECT, streamImage());
    expectClosedNothingToRemove();
  });

  it("blocks the open agent siblings and leaves the human gate alone", async () => {
    await handleTicketDoneUnified(DETECT);
    const blocked = h.state.updates
      .filter((u) => JSON.stringify(u.ExpressionAttributeValues || {}).includes('"blocked"'))
      .map((u) => u.Key.ticketId);
    expect(blocked.sort()).toEqual([REVIEW, QA, CI].sort());
    // A human gate moving to "blocked" is read as "Request changes" on the Jira
    // path and would reopen upstream work — it must never be touched here. It is
    // already unreachable anyway: only the cascade ever notifies a gate.
    expect(blocked).not.toContain(GATE);
  });

  it("labels the PR when the record carries one", async () => {
    h.state.s3Objects[`completions/${DETECT}.json`] = completionRecord({ pr_url: PR });
    await handleTicketDoneUnified(DETECT);
    const label = h.state.githubCalls.find((c) => c.url.includes("/issues/60/labels"));
    expect(label).toBeDefined();
    expect(label.body).toContain("sweep:no-op");
    expect(eventsOfType("workflow.nothing_to_remove")[0].detail.prUrl).toBe(PR);
  });

  it("a failing label never blocks the close (best-effort by contract)", async () => {
    h.state.s3Objects[`completions/${DETECT}.json`] = completionRecord({ pr_url: PR });
    h.state.githubFails = true;
    await handleTicketDoneUnified(DETECT);
    expectClosedNothingToRemove();
  });

  it("closes exactly ONCE across the two twins — the CAS is the only arbiter", async () => {
    await handleTicketDoneUnified(DETECT);
    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(1);

    // The stream twin (or a redelivered record) arrives second: the phase is now
    // terminal, so claimTerminalOutcome loses and every side effect is skipped.
    h.state.claimWins = false;
    h.state.events.length = 0;
    h.state.finalized.length = 0;
    await handleTicketDone(DETECT, streamImage());

    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(0);
    expect(h.state.finalized).toEqual([]);
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(0);
  });

  it("matches the detection ticket by the def's phase agent when the stamp is missing", async () => {
    // The def names agentcore_hub_code_sweeper as the detection phase's agent, so a
    // run whose intake forgot phase="detection" is still gated.
    h.state.tickets[DETECT].phase = undefined;
    h.state.children = board().map((t) => (t.ticketId === DETECT ? { ...t, phase: undefined } : t));
    await handleTicketDoneUnified(DETECT);
    expect(h.state.claims).toHaveLength(1);
  });

  it("does NOT close a productive sweep — 8 removals cascade as always", async () => {
    h.state.s3Objects[`completions/${DETECT}.json`] = completionRecord({ verified_removable: 8 });
    await handleTicketDoneUnified(DETECT);

    expect(h.state.claims).toHaveLength(0);
    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(0);
    // The cascade ran, and the reviewer was made RUNNABLE — the very write the
    // zero-yield case must never produce. This is what makes the enforce
    // assertions non-vacuous: the same board, the same mocks, one different
    // integer in the completion record, and the successor moves.
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(1);
    expect(eventsOfType("orchestrator.unblocked")[0].detail).toMatchObject({
      ticketId: REVIEW,
      unblockedBy: DETECT,
    });
    expect(statusWrites().filter(([, s]) => RUNNABLE.has(s))).toEqual([[REVIEW, "todo"]]);
  });

  it("does NOT close on a record with no yield field at all (every pre-D2 record)", async () => {
    h.state.s3Objects[`completions/${DETECT}.json`] = completionRecord({ verified_removable: undefined });
    await handleTicketDoneUnified(DETECT);
    // Absent is not zero. A truthiness test here would invert the gate.
    expect(h.state.claims).toHaveLength(0);
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(1);
  });

  it("does NOT close a run on another def, even at zero yield", async () => {
    h.state.workflow = makeWorkflow({ workflowDefId: "software-delivery", phase: "development" });
    await handleTicketDoneUnified(DETECT);
    expect(h.state.claims).toHaveLength(0);
    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(0);
  });

  it("degrades to today's behaviour when the record read throws", async () => {
    // The observer discipline: a broken seam must never wedge a run.
    delete h.state.s3Objects[`completions/${DETECT}.json`];
    await handleTicketDoneUnified(DETECT);
    expect(h.state.claims).toHaveLength(0);
    expect(eventsOfType("agent.complete")).toHaveLength(1);
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(1);
  });
});

describe("SWEEP_DETECTION_PHASE=shadow — observe, change nothing", () => {
  beforeEach(async () => { await load("shadow"); });

  it("publishes sweep.detection_observed and still cascades as today", async () => {
    await handleTicketDoneUnified(DETECT);

    const observed = eventsOfType("sweep.detection_observed");
    expect(observed).toHaveLength(1);
    expect(observed[0].detail).toMatchObject({
      workflowId: WF,
      ticketId: DETECT,
      verifiedRemovable: 0,
      candidates: 93,
      wouldClose: true,
    });
    // Nothing was claimed, nothing was blocked, and the blueprint's own Step 2.5
    // choreography is still the mechanism that ends the run.
    expect(h.state.claims).toHaveLength(0);
    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(0);
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(1);
  });

  it("is the UNSET default — a fresh deploy observes rather than acts", async () => {
    await load(undefined);
    await handleTicketDoneUnified(DETECT);
    expect(eventsOfType("sweep.detection_observed")).toHaveLength(1);
    expect(h.state.claims).toHaveLength(0);
  });

  it("garbage coalesces to off, never to enforce", async () => {
    await load("ENFORCE!");
    await handleTicketDoneUnified(DETECT);
    expect(eventsOfType("sweep.detection_observed")).toHaveLength(0);
    expect(h.state.claims).toHaveLength(0);
  });
});

describe("SWEEP_DETECTION_PHASE=off — byte-identical to pre-4247", () => {
  beforeEach(async () => { await load("off"); });

  it("does not read the completion record for the gate, and publishes nothing new", async () => {
    await handleTicketDoneUnified(DETECT);

    expect(eventsOfType("sweep.detection_observed")).toHaveLength(0);
    expect(eventsOfType("workflow.nothing_to_remove")).toHaveLength(0);
    expect(h.state.claims).toHaveLength(0);
    // The cascade ran exactly as before the flag existed.
    expect(eventsOfType("orchestrator.unblocked")).toHaveLength(1);
    // The harvest's own read is memoized and shared, so the gate adds no S3 GET.
    // Off must not add one either: exactly one read of this record on the path.
    expect(h.state.s3Gets.filter((k) => k === `completions/${DETECT}.json`)).toHaveLength(1);
  });
});

/**
 * TEAM-4247 D2, commit 4 — the required-phase strip.
 *
 * `src/config/workflows.json` now declares "detection" in the sweep def's
 * `completionRequiresAgentPhases`, and it reaches the Lambdas by a MANUAL
 * `aws s3 cp` on its own schedule. No roster agent claims `phase: "detection"`,
 * so the moment that config landed, `isWorkflowComplete`'s `required.every(...)`
 * would demand a done detection ticket on every in-flight sweep — including the
 * ones whose intake ran before the phase existed — and wedge them until the
 * dead-session detector escalated.
 *
 * So the REQUIREMENT is flag-gated and the PHASE LIST is not: under off/shadow the
 * def the orchestrator follows has no detection requirement, but it still has the
 * detection phase, because the analyst has to see it (and stamp its ticket) in
 * shadow or shadow observes nothing.
 */
describe("the detection required-phase strip (config can be synced at any time)", () => {
  /** The def as a run FOLLOWS it, for the mode currently loaded. */
  const effective = () => stripUnenforcedDetectionPhase(sweepDefWithDetection());

  it("strips the REQUIREMENT under shadow, keeping every other phase in order", async () => {
    await load("shadow");
    expect(effective().completionRequiresAgentPhases).toEqual([
      "development",
      "verification",
      "review",
      "ship",
    ]);
  });

  it("strips the REQUIREMENT under off", async () => {
    await load("off");
    expect(effective().completionRequiresAgentPhases).not.toContain("detection");
  });

  it("KEEPS the requirement under enforce — the gate and the requirement arm together", async () => {
    await load("enforce");
    expect(effective().completionRequiresAgentPhases).toEqual([
      "detection",
      "development",
      "verification",
      "review",
      "ship",
    ]);
  });

  it("NEVER strips the phase itself, in any mode", async () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      await load(mode);
      const def = effective();
      expect(def.phases.map((p) => p.agentPhase)).toContain("detection");
      // And the phase still names its agent, which is what the intake context
      // renders and what the zero-yield gate's fallback matches on.
      const detection = def.phases.find((p) => p.agentPhase === "detection");
      expect(detection).toMatchObject({ agentPhase: "detection", agentId: SWEEPER });
    }
  });

  it("does not mutate the def it is given (the defs cache is shared)", async () => {
    await load("shadow");
    const input = sweepDefWithDetection();
    const before = JSON.stringify(input);
    stripUnenforcedDetectionPhase(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("leaves a def with no detection requirement untouched, by identity", async () => {
    await load("shadow");
    const other = { id: "software-delivery", completionRequiresAgentPhases: ["development"] };
    expect(stripUnenforcedDetectionPhase(other)).toBe(other);
  });
});

/**
 * TEAM-4247 D2 — the close skips the cascade, but the cascade is not the only way
 * a successor gets dispatched.
 *
 * D2's acceptance criterion is that a code reviewer / QA verifier / CI agent is
 * NEVER dispatched after a nothing-to-remove close — not merely "not on the hop
 * that closed the run". Dispatch is level-triggered: the reconcile sweep re-drives
 * any dependent whose blockers all read done, a late Jira webhook or a redelivered
 * stream record re-enters the Ready handler, and the reviewer's only blocker (the
 * detection ticket) IS done. So the guards have to refuse on the RUN's phase.
 *
 * Both halves are asserted against the same board with only `workflow.phase`
 * differing, so neither assertion can pass vacuously.
 */
describe("no dispatch AFTER the close (the level-trigger paths)", () => {
  beforeEach(async () => {
    process.env.RECONCILE_SWEEP_MODE = "enforce";
    await load("enforce");
    // The reviewer ticket has to be readable: the stream guard re-reads the ticket
    // before resolving its workflow.
    h.state.tickets[REVIEW] = {
      ticketId: REVIEW, parentId: EPIC, workflowId: WF,
      assignee: "agentcore_hub_code_reviewer", status: "todo", blockedBy: [DETECT],
    };
  });

  afterEach(() => { delete process.env.RECONCILE_SWEEP_MODE; });

  /** A stream MODIFY that re-readies the reviewer, its blocker already done. */
  const readyRecord = (status) => ({
    eventName: "MODIFY",
    dynamodb: {
      OldImage: { ticketId: { S: REVIEW }, status: { S: "blocked" } },
      NewImage: {
        ticketId: { S: REVIEW },
        status: { S: status },
        assignee: { S: "agentcore_hub_code_reviewer" },
        parentId: { S: EPIC },
        workflowId: { S: WF },
        blockedBy: { L: [{ S: DETECT }] },
        title: { S: "Review the sweep" },
      },
    },
  });

  /** Everything an agent dispatch would leave behind, on any path. */
  const dispatchTraces = () => ({
    invokes: h.state.lambdaInvokes.length,
    invokedEvents: eventsOfType("orchestrator.agent_invoked").length + eventsOfType("agent.started").length,
    claimed: statusWrites().filter(([id, s]) => id === REVIEW && s === "in_progress").length,
  });

  for (const status of ["ready", "todo"]) {
    it(`refuses a late "${status}" delivery for the reviewer once the run is closed`, async () => {
      await handleTicketDoneUnified(DETECT);
      expectClosedNothingToRemove();
      // What the winning CAS wrote — claimTerminalOutcome is mocked, so model it.
      h.state.workflow.phase = "nothing-to-remove";
      h.state.events.length = 0;
      h.state.updates.length = 0;
      h.state.lambdaInvokes.length = 0;

      await handler({ Records: [readyRecord(status)] });

      expect(dispatchTraces()).toEqual({ invokes: 0, invokedEvents: 0, claimed: 0 });
    });
  }

  it("DOES dispatch the same delivery while the run is open (the guard is the only difference)", async () => {
    await handler({ Records: [readyRecord("ready")] });
    // phase is still "detection" — an ordinary open run, so the reviewer runs.
    const t = dispatchTraces();
    expect(t.invokes + t.invokedEvents + t.claimed).toBeGreaterThan(0);
  });

  it("the reconcile sweep does not even SEE a closed run (the scan's terminal filter)", async () => {
    h.state.scanRows = [{ ...makeWorkflow({ phase: "nothing-to-remove" }) }];
    const result = await handler({ source: "orchestrator.sweep", action: "reconcile_sweep" });

    expect(result).toMatchObject({ mode: "enforce", candidates: 0, redispatched: 0 });
    expect(dispatchTraces()).toEqual({ invokes: 0, invokedEvents: 0, claimed: 0 });
  });

  it("…and DOES see the same run while it is open (non-vacuous)", async () => {
    h.state.scanRows = [{ ...makeWorkflow() }]; // phase: "detection"
    const result = await handler({ source: "orchestrator.sweep", action: "reconcile_sweep" });
    expect(result.candidates).toBeGreaterThan(0);
  });
});

/**
 * TEAM-4247 D2 FR-D2.6 — yield-aware gate depth.
 *
 * A zero-yield sweep that runs ON (the flag is off/shadow, or the close's CAS was
 * lost) hands its gates a diff with no deletions in it: a candidate ledger and
 * nothing else. The full battery — fresh clone, build, runtime smoke — proves that
 * code nobody touched still works, while the one thing that can actually be wrong,
 * a ledger row claiming a live symbol is unreferenced, is a reading exercise.
 *
 * So the depth is set by DATA, not by an env flag the model cannot see: one line in
 * the persona's context, and the same line in front of the human merge approver. The
 * reviewer's line says the opposite of QA's on purpose — blueprints/code-reviewer.md
 * is untouched by D2 and its ledger re-verification is retained in full.
 */
describe("yield-aware gate depth (FR-D2.6)", () => {
  const LEDGER_ONLY = "ledger-accuracy QA only (no fresh-clone build + runtime smoke); CI builds once.";
  const RETAINED = "ledger re-verification is retained in full";

  /** The board after a zero-yield detection ticket was harvested (commit 1's fill). */
  const harvested = (over = {}) =>
    makeWorkflow({
      agentTasks: {
        [DETECT]: {
          id: "task_detect", agentId: SWEEPER, ticketId: DETECT, status: "done",
          verifiedRemovable: 0, candidates: 93,
        },
      },
      ...over,
    });

  const ticketFor = (assignee) => ({
    ticketId: QA, parentId: EPIC, workflowId: WF, assignee, status: "in_progress",
    title: "Verify the sweep", description: "Verify the removal ledger.",
  });

  beforeEach(async () => {
    // shadow: the mode in which a zero-yield run really does continue to its gates,
    // which is the only situation where depth is a question at all.
    await load("shadow");
    h.state.workflow = harvested();
  });

  it("tells the QA verifier and the CI agent that the diff is deletion-free", async () => {
    for (const assignee of ["agentcore_hub_qa_verifier", "agentcore_hub_ci_agent"]) {
      const ctx = await buildAgentContext(ticketFor(assignee), h.state.workflow);
      expect(ctx, assignee).toContain("## Sweep Yield");
      expect(ctx, assignee).toContain("Detection: 93 candidates, 0 verified removable");
      expect(ctx, assignee).toContain(LEDGER_ONLY);
      expect(ctx, assignee).not.toContain(RETAINED);
    }
  });

  it("tells the code reviewer the opposite — nothing about the ledger review is relaxed", async () => {
    const ctx = await buildAgentContext(ticketFor("agentcore_hub_code_reviewer"), h.state.workflow);
    expect(ctx).toContain("Detection: 93 candidates, 0 verified removable");
    expect(ctx).toContain(RETAINED);
    expect(ctx).not.toContain("no fresh-clone build");
  });

  it("says nothing at all to the personas whose depth it does not set", async () => {
    // The release manager reviews the PR it is handed; the sweeper wrote the ledger.
    for (const assignee of ["agentcore_hub_release_manager", SWEEPER]) {
      const ctx = await buildAgentContext(ticketFor(assignee), h.state.workflow);
      expect(ctx, assignee).not.toContain("## Sweep Yield");
    }
    expect(sweepYieldAudience("agentcore_hub_release_manager")).toBeNull();
    expect(sweepYieldAudience("agentcore_hub_qa_verifier")).toBe("verify");
    expect(sweepYieldAudience("agentcore_hub_code_reviewer")).toBe("reverify");
  });

  it("says nothing when the sweep DID remove code — 8 removals get the full battery", async () => {
    h.state.workflow = harvested();
    h.state.workflow.agentTasks[DETECT].verifiedRemovable = 8;
    const ctx = await buildAgentContext(ticketFor("agentcore_hub_qa_verifier"), h.state.workflow);
    expect(ctx).not.toContain("## Sweep Yield");
    expect(sweepYieldNote(h.state.workflow, "verify")).toBeNull();
  });

  it("says nothing on a run whose record predates the field entirely", async () => {
    h.state.workflow = makeWorkflow(); // no verifiedRemovable anywhere
    const ctx = await buildAgentContext(ticketFor("agentcore_hub_qa_verifier"), h.state.workflow);
    expect(ctx).not.toContain("## Sweep Yield");
  });

  it("says nothing on another def, even at zero yield", async () => {
    const other = harvested({ workflowDefId: "software-delivery" });
    expect(sweepYieldNote(other, "verify")).toBeNull();
    const ctx = await buildAgentContext(ticketFor("agentcore_hub_qa_verifier"), other);
    expect(ctx).not.toContain("## Sweep Yield");
  });

  it("respects the 200-char package-bullet clamp, and drops the count when it is absent", () => {
    const wide = harvested();
    wide.agentTasks[DETECT].candidates = 999999;
    for (const audience of ["verify", "reverify"]) {
      expect(sweepYieldNote(wide, audience).length, audience).toBeLessThanOrEqual(200);
    }
    const noCount = harvested();
    delete noCount.agentTasks[DETECT].candidates;
    expect(sweepYieldNote(noCount, "verify")).toContain("Detection: 0 verified removable");
    expect(sweepYieldNote(noCount, "verify")).not.toContain("candidates");
  });

  it("leads the human merge gate's package with the same line", async () => {
    // The Merge Approval gate is blocked by the CI ticket, so the package phase
    // resolves to `review` — the real blocker walk, not a stubbed phase.
    h.state.tickets[CI] = { ticketId: CI, parentId: EPIC, workflowId: WF, assignee: "agentcore_hub_ci_agent", status: "done" };
    h.state.tickets[GATE] = { ticketId: GATE, parentId: EPIC, workflowId: WF, assignee: "human:engineer", status: "ready", blockedBy: [CI] };
    h.state.s3Objects[`workflows/${WF}/shared/review-package-review.json`] = {
      summary: "Ledger of 93 candidates; nothing removed.",
      bullets: ["93 candidates examined", "no files deleted"],
      links: [{ label: "PR", url: PR }],
    };

    await handler({
      Records: [{
        eventName: "MODIFY",
        dynamodb: {
          OldImage: { ticketId: { S: GATE }, status: { S: "blocked" } },
          NewImage: {
            ticketId: { S: GATE }, status: { S: "ready" },
            assignee: { S: "human:engineer" }, parentId: { S: EPIC },
            workflowId: { S: WF }, blockedBy: { L: [{ S: CI }] },
            title: { S: "Merge Approval" },
          },
        },
      }],
    });

    const comments = h.state.updates
      .filter((u) => u.Key?.ticketId === GATE && u.ExpressionAttributeValues?.[":n"])
      .flatMap((u) => u.ExpressionAttributeValues[":n"].map((c) => c.content))
      .join("\n");
    expect(comments).toContain("Detection: 93 candidates, 0 verified removable");
    expect(comments).toContain(RETAINED);
    // The agent's own bullets survive behind it — the note is added, not a rewrite.
    expect(comments).toContain("93 candidates examined");
    expect(comments).toContain("Ledger of 93 candidates");
  });
});
