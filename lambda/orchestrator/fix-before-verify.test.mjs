import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { selectFixBeforeVerifyTargets, FIX_BEFORE_VERIFY_PERSONAS } from "./verdict-contract.mjs";

/**
 * FR-D1.7 — a fix ticket blocks the run's open verifiers AT CREATION TIME
 * (TEAM-4246 D1).
 *
 * The hole, from wf_1788731227559_dowtdh verbatim: TEAM-4183 `Fix (review):
 * ActivityFeed clear/undo — 3 findings` was created at 23:18:03 with
 * `blockedBy: []`, and QA TEAM-4181 was invoked at 23:19:21 — 78 seconds later,
 * against code the fix had not touched. The cascade gate (cascade.mjs) closes the
 * same hole one step downstream, but by the time a cascade runs the verifier has
 * already reported; the edge has to exist the moment the fix ticket appears.
 *
 * Two levels, deliberately:
 *   1. selectFixBeforeVerifyTargets — pure, so every exclusion is pinned with plain
 *      objects and no DDB. This is where the CYCLE guard lives (two fix tickets in
 *      one stream batch must not block each other) and it is the rule most likely
 *      to be "simplified" by a future reader.
 *   2. the real handler, driven with a real DDB-stream INSERT record and only its
 *      I/O seams mocked (the contract-warning.test.mjs pattern) — because "off is
 *      byte-identical", "shadow writes nothing" and "a failure never rejects the
 *      record" are properties of the WIRING, not of the predicate.
 *
 * The board below models run c2uqki's shape (QA TEAM-4232 open, CI TEAM-4233 open,
 * fix TEAM-4241 filed against them). No c2uqki dossier is vendored on this branch,
 * so these are literal objects, not fixture reads.
 */

const FIX = "TEAM-4241";
const QA = "TEAM-4232";
const CI = "TEAM-4233";
const EPIC = "TEAM-4230";

const qaTicket = (over = {}) => ({ ticketId: QA, assignee: "agentcore_hub_qa_verifier", status: "todo", blockedBy: [], ...over });
const ciTicket = (over = {}) => ({ ticketId: CI, assignee: "agentcore_hub_ci_agent", status: "todo", blockedBy: [], ...over });
// The production caller injects `(kind) => FIX_KINDS.has(kind)`; this mirrors that
// Set literally (scripts/check-fix-kinds-parity.sh owns the canonical list).
const isFixKind = (kind) => ["review_fix", "qa_fix", "ci_fix", "ship_fix", "sync_fix", "codex_fix"].includes(kind);
const isAdvisory = (t) => Array.isArray(t?.labels) && t.labels.includes("advisory");

describe("selectFixBeforeVerifyTargets — who waits for a fresh fix ticket", () => {
  const select = (siblings, extra = {}) =>
    selectFixBeforeVerifyTargets({ fixId: FIX, siblings, isFixKind, isAdvisory, ...extra });

  it("picks the run's open QA and CI tickets", () => {
    expect(select([qaTicket(), ciTicket()])).toEqual([QA, CI]);
  });

  it("matches the CI agent by ID, not by phase — agents.json puts it in `review`", () => {
    // This is the whole reason the persona set is explicit. A phase-derived rule
    // reading agents.json would drop the CI agent and leave dowtdh's exact hole.
    expect(FIX_BEFORE_VERIFY_PERSONAS.has("agentcore_hub_ci_agent")).toBe(true);
    expect(select([ciTicket({ phase: "review" })])).toEqual([CI]);
  });

  it("also picks a verification-phase ticket whose assignee is not in the set", () => {
    expect(select([{ ticketId: "TEAM-4299", assignee: "agentcore_hub_perf_tester", status: "ready", phase: "verification" }])).toEqual(["TEAM-4299"]);
  });

  it("falls back to the injected phaseOf when the board carries no phase field", () => {
    const roster = { agentcore_hub_perf_tester: "verification" };
    const targets = select([{ ticketId: "TEAM-4299", assignee: "agentcore_hub_perf_tester", status: "todo" }], {
      phaseOf: (t) => roster[t?.assignee] || null,
    });
    expect(targets).toEqual(["TEAM-4299"]);
  });

  it("ignores every persona that is not a verifier", () => {
    // code_reviewer and release_manager are deliberately absent: a review fix is
    // filed BY the reviewer, so blocking its own open ticket parks the persona that
    // has to re-verify the fix.
    const board = [
      { ticketId: "TEAM-4234", assignee: "agentcore_hub_code_reviewer", status: "todo", blockedBy: [] },
      { ticketId: "TEAM-4235", assignee: "agentcore_hub_release_manager", status: "todo", blockedBy: [] },
      { ticketId: "TEAM-4236", assignee: "agentcore_hub_backend_dev", status: "in_progress", blockedBy: [] },
      { ticketId: "TEAM-4237", assignee: "human:reviewer", status: "todo", blockedBy: [] },
    ];
    expect(select(board)).toEqual([]);
  });

  it("excludes a DONE verifier — nothing waits on a finished ticket", () => {
    expect(select([qaTicket({ status: "done" }), ciTicket()])).toEqual([CI]);
  });

  it("excludes a CANCELLED verifier", () => {
    expect(select([qaTicket({ status: "cancelled" }), ciTicket()])).toEqual([CI]);
  });

  it("is case- and whitespace-tolerant about terminal statuses", () => {
    expect(select([qaTicket({ status: " Done " }), ciTicket({ status: "CANCELLED" })])).toEqual([]);
  });

  it("excludes an advisory verifier — the run does not wait on backlog", () => {
    expect(select([qaTicket({ labels: ["advisory"] }), ciTicket()])).toEqual([CI]);
  });

  it("never selects the fix ticket itself", () => {
    // A fix filed BY the QA verifier is assigned to a verifier persona, so without
    // this guard a qa_fix would block itself and never start.
    expect(select([{ ticketId: FIX, assignee: "agentcore_hub_qa_verifier", status: "todo", spawnedBy: { kind: "qa_fix" } }])).toEqual([]);
  });

  it("never selects ANOTHER fix ticket — the cycle guard", () => {
    // Two fix tickets landing in one stream batch: each INSERT runs this selection,
    // and without the guard they would block each other and neither could start.
    const otherFix = { ticketId: "TEAM-4242", assignee: "agentcore_hub_qa_verifier", status: "todo", blockedBy: [], spawnedBy: { kind: "qa_fix", qaTicketId: QA } };
    expect(select([otherFix, qaTicket()])).toEqual([QA]);
  });

  it("skips a target that already lists the fix in blockedBy (twin delivery)", () => {
    expect(select([qaTicket({ blockedBy: [FIX] }), ciTicket()])).toEqual([CI]);
  });

  it("de-duplicates and tolerates junk siblings without throwing", () => {
    expect(select([qaTicket(), qaTicket(), null, undefined, {}, "TEAM-9"])).toEqual([QA]);
  });

  it("returns [] for a missing fixId or a non-array board", () => {
    for (const bad of [undefined, null, "", 42]) {
      expect(selectFixBeforeVerifyTargets({ fixId: bad, siblings: [qaTicket()] })).toEqual([]);
      expect(selectFixBeforeVerifyTargets({ fixId: FIX, siblings: bad })).toEqual([]);
    }
    expect(selectFixBeforeVerifyTargets()).toEqual([]);
  });

  it("defaults its injected predicates to inert — a missing isFixKind never crashes", () => {
    // Called with no predicates at all, the only rules left are the structural ones.
    expect(selectFixBeforeVerifyTargets({ fixId: FIX, siblings: [qaTicket(), ciTicket()] })).toEqual([QA, CI]);
  });
});

/**
 * ─── The wiring: a real DDB-stream INSERT through the real handler ─────────────
 *
 * Only the I/O seams are mocked. The INSERT carries status `blocked` (a fix filed
 * with a dependency, TEAM-4044) so the status switch below the INSERT branch breaks
 * immediately and the assertions see this hook alone — same technique as
 * contract-warning.test.mjs, which pins the neighbouring advisory on the same branch.
 */

const h = vi.hoisted(() => ({
  state: {
    siblings: [],
    events: [],
    updates: [],
    queryThrows: false,
    updateThrows: false,
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
          if (name === "QueryCommand") {
            if (h.state.queryThrows) throw new Error("parentId-index unavailable");
            return { Items: h.state.siblings };
          }
          if (name === "GetCommand") {
            const id = cmd.input.Key?.ticketId;
            return { Item: h.state.siblings.find((t) => t.ticketId === id) || null };
          }
          if (name === "UpdateCommand") {
            if (h.state.updateThrows) throw new Error("conditional write failed");
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
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
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
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
  getWorkflow: vi.fn(async () => ({ id: "wf_c2uqki", epicId: EPIC, agentTasks: {}, resumeContexts: {}, humanNotifications: [] })),
  trackTicket: vi.fn(async () => true),
}));

/** The stream record the tickets Lambda's create_ticket produces for a fix. */
const insertFix = (over = {}) => ({
  Records: [{
    eventName: "INSERT",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: FIX },
        status: { S: "blocked" },
        assignee: { S: "agentcore_hub_backend_dev" },
        workflowId: { S: "wf_c2uqki" },
        parentId: { S: EPIC },
        type: { S: "task" },
        blockedBy: { L: [{ S: "TEAM-4240" }] },
        spawnedBy: { M: { kind: { S: "review_fix" }, gateTicketId: { S: "TEAM-4231" } } },
        ...over,
      },
    },
  }],
});

let handler;
async function load(mode) {
  if (mode === undefined) delete process.env.FIX_BEFORE_VERIFY;
  else process.env.FIX_BEFORE_VERIFY = mode;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const observed = () => h.state.events.filter((e) => e.type === "orchestrator.fix_before_verify_observed");
const blockerWrites = () => h.state.updates.filter((u) => JSON.stringify(u).includes(FIX));

beforeEach(() => {
  h.state.siblings = [qaTicket({ parentId: EPIC }), ciTicket({ parentId: EPIC })];
  h.state.events.length = 0;
  h.state.updates.length = 0;
  h.state.queryThrows = false;
  h.state.updateThrows = false;
});
afterEach(() => { delete process.env.FIX_BEFORE_VERIFY; });

describe("FIX_BEFORE_VERIFY=enforce — the edge is written at creation", () => {
  beforeEach(async () => { await load("enforce"); });

  it("blocks each open verifier exactly once, preserving a mid-flight status", async () => {
    await handler(insertFix());

    expect(blockerWrites()).toHaveLength(2);
    for (const write of blockerWrites()) {
      // ticket-blockers.mjs writes ONE conditional update per edge; the
      // preserveStatusIf list is what keeps an in_progress verifier from being
      // yanked to `blocked` mid-run (TEAM-4130 F1).
      expect(write.TableName).toBeDefined();
      const rendered = JSON.stringify(write);
      expect(rendered).toContain(FIX);
      expect(rendered).toMatch(/in_progress|in_review/);
    }
    expect(blockerWrites().map((w) => w.Key.ticketId).sort()).toEqual([QA, CI].sort());
  });

  it("publishes one observed event naming what it blocked", async () => {
    await handler(insertFix());

    expect(observed()).toHaveLength(1);
    expect(observed()[0].detail).toMatchObject({ workflowId: "wf_c2uqki", fixId: FIX, blocked: [QA, CI] });
    // `wouldBlock` is the shadow spelling — enforce must not claim a dry run.
    expect(observed()[0].detail).not.toHaveProperty("wouldBlock");
  });

  it("is idempotent on twin/redelivered INSERTs — zero new edges the second time", async () => {
    await handler(insertFix());
    const first = blockerWrites().length;
    // The board now carries the edges the first delivery wrote.
    h.state.siblings = [qaTicket({ blockedBy: [FIX] }), ciTicket({ blockedBy: [FIX] })];
    h.state.events.length = 0;

    await handler(insertFix());

    expect(blockerWrites()).toHaveLength(first);
    expect(observed()).toHaveLength(0);
  });

  it("writes nothing for a non-fix ticket INSERT", async () => {
    await handler(insertFix({ spawnedBy: undefined }));
    expect(blockerWrites()).toHaveLength(0);
    expect(observed()).toHaveLength(0);
  });

  it("publishes nothing when there is no open verifier to hold", async () => {
    h.state.siblings = [qaTicket({ status: "done" }), ciTicket({ status: "done" })];
    await handler(insertFix());
    expect(blockerWrites()).toHaveLength(0);
    expect(observed()).toHaveLength(0);
  });
});

describe("FIX_BEFORE_VERIFY=shadow — observe, write nothing", () => {
  beforeEach(async () => { await load("shadow"); });

  it("publishes wouldBlock and writes ZERO blocker edges", async () => {
    await handler(insertFix());

    expect(blockerWrites()).toHaveLength(0);
    expect(observed()).toHaveLength(1);
    expect(observed()[0].detail).toMatchObject({ workflowId: "wf_c2uqki", fixId: FIX, wouldBlock: [QA, CI] });
    expect(observed()[0].detail).not.toHaveProperty("blocked");
  });

  it("is the UNSET default — a fresh deploy observes rather than acts", async () => {
    await load(undefined);
    await handler(insertFix());
    expect(blockerWrites()).toHaveLength(0);
    expect(observed()).toHaveLength(1);
    expect(observed()[0].detail).toHaveProperty("wouldBlock");
  });
});

describe("FIX_BEFORE_VERIFY=off — byte-identical to pre-4246", () => {
  it("does not even read the board: no event, no write", async () => {
    await load("off");
    // A throwing sibling query would surface if the hook ran at all.
    h.state.queryThrows = true;

    await expect(handler(insertFix())).resolves.toBeUndefined();

    expect(observed()).toHaveLength(0);
    expect(blockerWrites()).toHaveLength(0);
  });

  it("an unrecognized mode falls to off (the typo case), not to shadow", async () => {
    await load("enfroce");
    await handler(insertFix());
    expect(observed()).toHaveLength(0);
    expect(blockerWrites()).toHaveLength(0);
  });
});

describe("the boundary — a failure never rejects the stream record", () => {
  it("survives a failing sibling query", async () => {
    await load("enforce");
    h.state.queryThrows = true;

    await expect(handler(insertFix())).resolves.toBeUndefined();
    expect(blockerWrites()).toHaveLength(0);
  });

  it("survives a failing blocker write", async () => {
    await load("enforce");
    h.state.updateThrows = true;

    await expect(handler(insertFix())).resolves.toBeUndefined();
  });
});
