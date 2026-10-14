import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3755 F3 — the INVARIANT that makes markTaskComplete's unconditional
 * "ticket done" safe, driven end-to-end from a real ticket-done event.
 *
 * F3 observed that markTaskComplete flips a ticket's task entry to complete even
 * when the agent's completion record says the work was BLOCKED (deploy-blocked /
 * static-ci-only), and asked for either ticket-level enforcement or a
 * documented + tested invariant. We rely on the run-level gate (the D2 design:
 * a ticket status is the agent's report, the workflow phase is the lifecycle
 * verdict — see the doc block on markTaskComplete in index.mjs), so this suite is
 * the contract that keeps that choice honest:
 *
 *   ticket done + a SHIP_BLOCKED signal  ==>  workflow closes on a BLOCKED
 *   terminal phase (claimTerminalOutcome), NEVER "complete".
 *
 * It also pins TEAM-3755 F1 (P0) end-to-end: `commit_sha` on the completion
 * record is the HEAD of the still-unmerged feature branch and must NOT read as a
 * merge verdict. Before F1 the commitSha-only case below closed the run
 * "complete" over unmerged work — the 29g73c failure (FR-D2.2 / AC-D2.4).
 *
 * Harness: index.mjs is REAL (real markTaskComplete → real harvest → real
 * completion gate → real closeWorkflowBlocked); only the I/O seams are mocked —
 * the AWS SDK clients and workflow-store. Same shape as
 * done-handlers-cascade.test.mjs (real handlers) plus completion-gates.test.mjs's
 * S3-served config (the only way to get a def whose completionRequiresAgentPhases
 * includes "ship").
 */

const SHIP = "TEAM-9"; // the release-manager ticket that just closed
const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const QA = "agentcore_hub_qa_verifier";
const CI = "agentcore_hub_ci_agent";
const RELEASE = "agentcore_hub_release_manager";

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    /** S3 objects by key — the two configs plus completions/{ticketId}.json. */
    s3Objects: /** @type {Record<string, string>} */ ({}),
    // Captured terminal decisions — the whole point of the suite.
    completions: /** @type {any[]} */ ([]), // store.completeWorkflow (the GREEN close)
    terminalClaims: /** @type {any[]} */ ([]), // store.claimTerminalOutcome (the HONEST close)
    merges: /** @type {any[]} */ ([]), // harvested fields
    events: /** @type {any[]} */ ([]), // events-table Put items
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
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (name === "QueryCommand") {
            // lease.lastAgentActivity reads the EVENTS table (no heartbeat →
            // stale); everything else is the tickets parentId-index.
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
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") return {};
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) throw new Error("NoSuchKey");
      return { Body: { transformToString: async () => body } };
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
  completeTaskEntry: vi.fn(async (wfId, tid, entry) => {
    // Mirror the real per-key write so the in-memory row the gate re-reads is honest.
    if (h.state.workflow?.agentTasks) h.state.workflow.agentTasks[tid] = entry;
  }),
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => {
    h.state.merges.push({ wfId, tid, fields });
    if (h.state.workflow?.agentTasks?.[tid]) Object.assign(h.state.workflow.agentTasks[tid], fields);
  }),
  // The two terminal seams. Recording BOTH is what lets each test assert not just
  // "the honest close happened" but "the green close did NOT".
  completeWorkflow: vi.fn(async (id, ts) => { h.state.completions.push({ id, ts }); return true; }),
  claimTerminalOutcome: vi.fn(async (id, outcome, ts, reason) => {
    h.state.terminalClaims.push({ id, outcome, ts, reason: reason ?? null });
    return true;
  }),
  claimInvocation: vi.fn(async () => true),
  appendReviewNotificationOnce: vi.fn(async () => true),
  setTaskStatus: vi.fn(async () => {}),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
}));

// The harvest is gated on ARTIFACT_BUCKET, and the config loaders need it too;
// read at module load, so set before the dynamic import.
process.env.ARTIFACT_BUCKET = "test-bucket";

let handleTicketDone;
let handleTicketDoneUnified;
let handler;

/**
 * Load index.mjs, then prime the roster/def caches through handler() with an
 * empty stream event (no records, no side effects) — the caches are only filled
 * by handler(), and without them the fallback def declares NO ship phase and the
 * whole D2 gate is inert.
 */
async function loadWithShipDef() {
  vi.resetModules();
  ({ handleTicketDone, handleTicketDoneUnified, handler } = await import("./index.mjs"));
  await handler({ Records: [] });
}

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: DEV, phase: "development" },
    { agentId: QA, phase: "verification" },
    { agentId: CI, phase: "review" },
    { agentId: RELEASE, phase: "ship" },
  ],
});

const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "software-delivery",
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "development",
      createsPullRequest: false, // the release manager owns the PR on a ship def
      completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
      reviewGates: [],
      phases: [
        { agentPhase: "development" },
        { agentPhase: "verification" },
        { agentPhase: "review" },
        { agentPhase: "ship" },
      ],
    },
  ],
});

/** Every required phase has a done agent ticket → the run is completion-eligible. */
const ALL_DONE = () => [
  { ticketId: "TEAM-1", parentId: PARENT, assignee: DEV, type: "task", status: "done" },
  { ticketId: "TEAM-2", parentId: PARENT, assignee: QA, type: "task", status: "done" },
  { ticketId: "TEAM-3", parentId: PARENT, assignee: CI, type: "task", status: "done" },
  { ticketId: SHIP, parentId: PARENT, assignee: RELEASE, type: "task", status: "done" },
];

function makeWorkflow() {
  const task = (id, agentId) => [
    id,
    { id: `task_${id}`, agentId, ticketId: id, status: "complete", output: "did the work" },
  ];
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: "software-delivery",
    input: { title: "t" },
    repoConfig: { layout: "multi-repo", repos: [{ platform: "backend", url: "https://github.com/o/r", defaultBranch: "main" }] },
    humanNotifications: [],
    agentTasks: Object.fromEntries([
      task("TEAM-1", DEV),
      task("TEAM-2", QA),
      task("TEAM-3", CI),
      // The ship ticket is still running — this event is its completion.
      [SHIP, { id: `task_${SHIP}`, agentId: RELEASE, ticketId: SHIP, status: "running", startedAt: "2020-01-01T00:00:00Z" }],
    ]),
  };
}

/** The release manager's report_completion record for the ship ticket. */
function shipRecord(fields) {
  return JSON.stringify({ ticket_id: SHIP, summary: "Release attempt finished.", ...fields });
}

beforeEach(() => {
  h.state.tickets = {
    [SHIP]: { ticketId: SHIP, parentId: PARENT, workflowId: "wf_1", assignee: RELEASE, status: "done" },
  };
  h.state.children = ALL_DONE();
  h.state.workflow = makeWorkflow();
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    // o/r is CD-registered → the ship phase under test is in force.
    "config/cd-registry.json": JSON.stringify({ version: 1, repos: [{ repo: "o/r" }] }),
  };
  h.state.completions.length = 0;
  h.state.terminalClaims.length = 0;
  h.state.merges.length = 0;
  h.state.events.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** The stream-path NewImage (unwrapDdbValue passes plain values through). */
const streamImage = () => ({ parentId: PARENT, workflowId: "wf_1", assignee: RELEASE });

/**
 * Drive a done handler through the fix-spawn re-check. "ship" is in
 * FIX_SPAWNING_PHASES, so a release-manager trigger always sleeps
 * COMPLETION_RECHECK_DELAY_MS (1500 ms) and re-reads the children before
 * completion proceeds — fake timers keep the suite instant. Same pattern as
 * completion-gates.test.mjs; everything up to the setTimeout is microtask-only
 * (all mocks resolve immediately), so the timer is always scheduled by the time
 * runAllTimersAsync yields.
 */
async function drive(fn) {
  vi.useFakeTimers();
  const p = fn();
  await vi.runAllTimersAsync();
  return await p;
}

/** Assert the run closed on `outcome` and NOT on the green path. */
function expectBlockedClose(outcome, reason) {
  expect(h.state.terminalClaims).toHaveLength(1);
  expect(h.state.terminalClaims[0]).toMatchObject({ id: "wf_1", outcome });
  if (reason !== undefined) expect(h.state.terminalClaims[0].reason).toBe(reason);
  // The invariant's teeth: the GREEN close never happened.
  expect(h.state.completions).toHaveLength(0);
  // ...and the terminal verdict was published, so the close is never silent.
  const type = outcome === "deploy-blocked" ? "workflow.deploy_blocked" : "workflow.static_ci_only";
  expect(h.state.events.filter((e) => e.type === type)).toHaveLength(1);
  expect(h.state.events.filter((e) => e.type === "workflow.complete")).toHaveLength(0);
}

describe("TEAM-3755 F3 — ticket done carrying a SHIP_BLOCKED outcome", () => {
  it("(Jira-webhook path) an explicit deploy-blocked record closes the run deploy-blocked, never complete", async () => {
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({
      outcome: "deploy-blocked",
      block_reason: "preflight refused: migration lock held",
      commit_sha: "aaa1111",
    });
    await loadWithShipDef();

    await drive(() => handleTicketDoneUnified(SHIP));

    // The ticket's task entry IS marked complete (the agent did finish) — the
    // block is carried by the harvested outcome, not by a stuck ticket status.
    expect(h.state.workflow.agentTasks[SHIP].status).toBe("complete");
    expect(h.state.workflow.agentTasks[SHIP].outcome).toBe("deploy-blocked");
    expectBlockedClose("deploy-blocked", "preflight refused: migration lock held");
  });

  it("(DDB-stream path) the same record on the other done handler closes it the same way", async () => {
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({
      outcome: "deploy-blocked",
      block_reason: "deploy gate closed",
    });
    await loadWithShipDef();

    await drive(() => handleTicketDone(SHIP, streamImage()));

    expectBlockedClose("deploy-blocked", "deploy gate closed");
  });

  it("TEAM-3755 F1 (P0): commit_sha ALONE is not a merge verdict — the run closes static-ci-only", async () => {
    // The regression this whole ticket is about. Every dev/ship completion record
    // carries commit_sha (the unmerged feature-branch HEAD); no merge_commit and
    // no explicit outcome means nothing landed. Before F1 this closed "complete".
    // No pr_url: the blocked close labels a PR when one is harvested, and that
    // path makes a real GitHub call. Keep this suite network-free (the label is
    // best-effort and covered by replay-d2).
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({ commit_sha: "bbb2222" });
    await loadWithShipDef();

    await drive(() => handleTicketDoneUnified(SHIP));

    // It WAS harvested (the gate saw it) — it just does not count as shipped.
    expect(h.state.workflow.agentTasks[SHIP].commitSha).toBe("bbb2222");
    expect(h.state.workflow.agentTasks[SHIP].mergeCommit).toBeUndefined();
    expectBlockedClose("static-ci-only", null);
  });

  it("positive control: a real merge_commit still closes the run GREEN", async () => {
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({
      commit_sha: "ccc3333",
      merge_commit: "ddd4444",
    });
    await loadWithShipDef();

    await drive(() => handleTicketDoneUnified(SHIP));

    expect(h.state.workflow.agentTasks[SHIP].mergeCommit).toBe("ddd4444");
    expect(h.state.completions).toHaveLength(1);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.events.filter((e) => e.type === "workflow.complete")).toHaveLength(1);
  });

  it("positive control: an explicit outcome \"shipped\" closes GREEN with no merge commit", async () => {
    // The release manager's own verdict is still authoritative — F1 narrowed the
    // INFERRED signal (commitSha), not the explicit one.
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({
      outcome: "shipped",
      commit_sha: "eee5555",
    });
    await loadWithShipDef();

    await drive(() => handleTicketDoneUnified(SHIP));

    expect(h.state.completions).toHaveLength(1);
    expect(h.state.terminalClaims).toHaveLength(0);
  });

  it("a landed webhook merge is not clobbered: the record is read but the merge stands", async () => {
    // harvestCompletionEvidence fills only ABSENT fields, so a mergeCommit that
    // arrived via the webhook metadata merge wins over a bare commit_sha record.
    h.state.workflow.agentTasks[SHIP].mergeCommit = "fff6666";
    h.state.s3Objects[`completions/${SHIP}.json`] = shipRecord({ commit_sha: "ggg7777" });
    await loadWithShipDef();

    await drive(() => handleTicketDoneUnified(SHIP));

    expect(h.state.workflow.agentTasks[SHIP].mergeCommit).toBe("fff6666");
    expect(h.state.completions).toHaveLength(1);
    expect(h.state.terminalClaims).toHaveLength(0);
  });
});

/**
 * TEAM-5884 R3-1 — a REPLAYED completion of the run's OLD head must not re-order
 * the run's recorded heads. The stream twin re-marks the task (no dedup guard);
 * before the fix markTaskComplete re-stamped completedAt, so the OLD head H became
 * "the latest recorded head", the deleted-branch (404) proof bound to H's merged PR,
 * and completeWorkflow stamped mergeVerifiedBy:"github" onto an unlanded branch (F).
 * Real handleTicketDone → markTaskComplete → completeWorkflow → GitHub probe.
 */
describe("TEAM-5884 R3-1 — replayed done of the OLD head does not re-order the run's heads", () => {
  const MERGED_PR = { number: 846, merged_at: "2026-09-01T01:00:00Z", merge_commit_sha: "m846", head: { sha: "head000" }, base: { ref: "main" }, html_url: "https://github.com/o/r/pull/846", state: "closed" };
  let realFetch;
  beforeEach(() => {
    realFetch = global.fetch;
    process.env.GITHUB_PAT = "ghp_test";
    // Branch auto-deleted after H's PR merged; F (pushed after) never landed anywhere.
    global.fetch = vi.fn(async (url) => {
      const u = decodeURIComponent(String(url));
      if (u.includes("/branches/")) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "Branch not found" }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(u.includes("/pulls?") ? [MERGED_PR] : {}) };
    });
  });
  afterEach(() => { global.fetch = realFetch; delete process.env.GITHUB_PAT; });

  function replayFixture() {
    const wf = makeWorkflow();
    wf.featureBranch = "feature/EPIC-1-fix";
    wf.agentTasks["TEAM-1"] = { ...wf.agentTasks["TEAM-1"], commitSha: "head000", completedAt: "2026-09-01T00:00:00Z" }; // H — merged
    wf.agentTasks["TEAM-2"] = { ...wf.agentTasks["TEAM-2"], commitSha: "fff0000", completedAt: "2026-09-02T00:00:00Z" }; // F — the run's LAST head
    wf.agentTasks["TEAM-3"] = { ...wf.agentTasks["TEAM-3"], completedAt: "2026-09-02T01:00:00Z" };
    // The RM self-reported no merge: only GitHub's proof could satisfy D2.
    wf.agentTasks[SHIP] = { id: `task_${SHIP}`, agentId: RELEASE, ticketId: SHIP, status: "complete", output: "shipped", completedAt: "2026-09-03T00:00:00Z" };
    h.state.workflow = wf;
    h.state.tickets["TEAM-1"] = { ticketId: "TEAM-1", parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done" };
  }

  it("(DDB-stream path) TEAM-1 (H) replayed: completedAt kept, F is not contained in the merged head, 404 proof withheld → no github stamp, run NOT completed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    replayFixture();
    await loadWithShipDef();

    await drive(() => handleTicketDone("TEAM-1", { parentId: PARENT, workflowId: "wf_1", assignee: DEV }));

    expect(h.state.workflow.agentTasks["TEAM-1"].completedAt).toBe("2026-09-01T00:00:00Z");
    expect(h.state.workflow.agentTasks["TEAM-1"].status).toBe("complete");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("recorded head fff0000 is not contained in merged PR #846 head head000"))).toBe(true);
    expect(h.state.merges.some(({ fields }) => fields.mergeVerifiedBy === "github")).toBe(false);
    expect(h.state.completions).toHaveLength(0); // no GREEN close over the unlanded F
    // merged:null → the RM's own (empty) verdict decides: honest static-ci-only close.
    expect(h.state.terminalClaims).toHaveLength(1);
    expect(h.state.terminalClaims[0]).toMatchObject({ id: "wf_1", outcome: "static-ci-only" });
    warn.mockRestore();
  });

  it("positive control: the same run with F never recorded (H IS the last head) still completes on GitHub's proof", async () => {
    replayFixture();
    delete h.state.workflow.agentTasks["TEAM-2"].commitSha;
    await loadWithShipDef();

    await drive(() => handleTicketDone("TEAM-1", { parentId: PARENT, workflowId: "wf_1", assignee: DEV }));

    expect(h.state.merges.some(({ tid, fields }) => tid === SHIP && fields.mergeCommit === "m846" && fields.mergeVerifiedBy === "github")).toBe(true);
    expect(h.state.completions).toHaveLength(1);
    expect(h.state.terminalClaims).toHaveLength(0);
  });
});
