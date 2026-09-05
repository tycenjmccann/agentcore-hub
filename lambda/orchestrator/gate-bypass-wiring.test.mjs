import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3991 D1.1 — the gate-bypass detector WIRED INTO the done cascade.
 *
 * gate-bypass.test.mjs pins the pure module. This pins the thing that actually
 * failed on wf sffzti: nothing called it. Both done handlers must run the check
 * immediately before they publish `agent.complete`, in a run whose def declares
 * a Merge Approval gate, and the work must still be announced — the merge really
 * did happen, so `agent.complete` is published either way, carrying
 * `gateBypass: true` so the board can show it.
 *
 * Harness: the §3(a) shape (real index.mjs, mocked I/O seams) — evidence-harvest's
 * ticket/children DDB stubs plus completion-gates' S3 config serving, because the
 * def must carry `reviewGates` (the hardcoded fallback def has none, which is why
 * the pre-existing suites are unaffected by this wiring). GitHub is the real
 * `githubApi` over a stubbed global fetch, so the injected-dep seam is exercised
 * end-to-end rather than mocked away.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    ebEvents: /** @type {any[]} */ ([]),
    statuses: /** @type {any[]} */ ([]),
    merges: /** @type {any[]} */ ([]),
    claims: /** @type {any[]} */ ([]),
    flagsHeld: /** @type {Set<string>} */ (new Set()),
    notifications: /** @type {any[]} */ ([]),
    // GitHub: `GET <path>` per call, and the merged-PR list served to the
    // `head=`/`base=` closed-PR queries.
    ghCalls: /** @type {string[]} */ ([]),
    headPrs: /** @type {any[]} */ ([]),
    basePrs: /** @type {any[]} */ ([]),
    ghStatus: 200,
    workflowsConfig: /** @type {any} */ (null),
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
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
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
  S3Client: class {
    async send(cmd) {
      const key = cmd?.input?.Key;
      if (cmd.constructor.name !== "GetObjectCommand") return {};
      const body = key === "config/workflows.json" ? JSON.stringify(h.state.workflowsConfig)
        : key === "config/agents.json" ? JSON.stringify(AGENTS_CONFIG)
        : h.state.s3Objects[key];
      if (body === undefined || body === "null") {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(cmd) {
      for (const e of cmd?.input?.Entries || []) {
        h.state.ebEvents.push({ type: e.DetailType, detail: JSON.parse(e.Detail) });
      }
      return {};
    }
  },
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
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => { h.state.merges.push({ wfId, tid, fields, via: "merge" }); }),
  // The detector's write seam: the task entry may predate the run's agentTasks
  // map, so it uses the track-or-merge variant (R2 — named store fn per attribute).
  mergeTaskMetadataOrTrack: vi.fn(async (wfId, tid, fields) => { h.state.merges.push({ wfId, tid, fields, via: "orTrack" }); }),
  // TEAM-4099 F2 — the CAS that must land BEFORE any observable side effect.
  // One winner per (workflow, ticket, scope); `h.state.flagsHeld` survives across
  // handler calls within a test so a re-Done really loses the claim.
  claimGateBypassFlag: vi.fn(async (wfId, tid, opts = {}) => {
    h.state.claims.push({ wfId, tid, ...opts });
    const key = `${wfId}/${tid}/${opts.shadow ? "shadow" : "flag"}`;
    if (h.state.flagsHeld.has(key)) return { won: false };
    h.state.flagsHeld.add(key);
    return { won: true };
  }),
  setTaskStatus: vi.fn(async (wfId, tid, status) => { h.state.statuses.push({ wfId, tid, status }); }),
  // Mirrors the real contract: id-idempotent while the row is unacked, and only
  // the caller that actually appended gets `true` (TEAM-4099 leans on this — the
  // escalation append is the one step a CAS loser is allowed to retry).
  appendNotificationOnce: vi.fn(async (wfId, n) => {
    if (h.state.notifications.some((x) => x.n?.id === n.id && !x.n?.acknowledged)) return false;
    h.state.notifications.push({ wfId, n });
    return true;
  }),
  appendNotification: vi.fn(async (wfId, n) => { h.state.notifications.push({ wfId, n }); }),
  appendReviewNotificationOnce: vi.fn(async () => true),
  ackNotifications: vi.fn(async () => {}),
  claimInvocation: vi.fn(async () => true),
  setProtectionCheck: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
}));

// Read at module load / on the first config fetch.
process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "test-pat";

const DEV_TICKET = "TEAM-11";
const GATE_TICKET = "TEAM-19";
const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const REVIEWER = "human:reviewer@example.com";
const FEATURE_BRANCH = "feature/EPIC-1-widget";
const MERGE_COMMIT = "cafebabe1234";

const AGENTS_CONFIG = {
  agents: [
    { agentId: "agentcore_hub_backend_dev", phase: "development" },
    { agentId: "agentcore_hub_release_manager", phase: "ship" },
  ],
};

// The real software-delivery gate config (src/config/workflows.json), trimmed.
const WORKFLOWS_CONFIG = {
  workflows: [
    {
      id: "software-delivery",
      featureBranchPhase: "development",
      completionRequiresAgentPhases: ["development", "ship"],
      reviewGates: [
        { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", onReject: "rework", reviewerRole: "Code Owner", assignee: "human:engineer", maxRounds: 3 },
      ],
      phases: [{ agentPhase: "development" }, { agentPhase: "ship" }],
    },
  ],
};
// Same def with the gate removed: the marketing/sales shape, where the detector
// must stay completely inert (zero GitHub calls).
const NO_GATE_CONFIG = {
  workflows: [{ ...WORKFLOWS_CONFIG.workflows[0], reviewGates: [] }],
};

const mergedPr = (over = {}) => ({
  number: 327,
  merged_at: "2026-09-01T10:00:00Z",
  merge_commit_sha: MERGE_COMMIT,
  html_url: "https://github.com/o/r/pull/327",
  head: { ref: `feature/${DEV_TICKET}-backend-dev`, sha: "headsha" },
  ...over,
});

function makeWorkflow(extra = {}) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: "software-delivery",
    phase: "ship",
    input: { title: "t" },
    featureBranch: FEATURE_BRANCH,
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    humanNotifications: [],
    agentTasks: {
      [DEV_TICKET]: { id: "task_1", agentId: DEV, ticketId: DEV_TICKET, status: "running", startedAt: "2026-09-01T09:00:00Z" },
    },
    ...extra,
  };
}

/** The gate ledger with one APPROVE at `decidedAt` (the human-authenticated path's row). */
const ledgerWith = (decidedAt) => ({
  [GATE_TICKET]: { decisions: [{ decision: "APPROVE", decidedAt, actor: "reviewer@example.com" }] },
});

let handleTicketDoneUnified;
let handleTicketDone;
let handler;

async function load(config = WORKFLOWS_CONFIG) {
  h.state.workflowsConfig = config;
  vi.resetModules();
  ({ handleTicketDoneUnified, handleTicketDone, handler } = await import("./index.mjs"));
  // The roster/def caches are filled lazily by handler(); an empty stream event
  // primes them with no side effects (same trick as completion-gates.test.mjs).
  await handler({ Records: [] });
}

const eventsOfType = (type) => h.state.ebEvents.filter((e) => e.type === type);

beforeEach(() => {
  h.state.tickets = {
    [DEV_TICKET]: { ticketId: DEV_TICKET, parentId: PARENT, workflowId: "wf_1", assignee: DEV, status: "done", phase: "development" },
    [GATE_TICKET]: { ticketId: GATE_TICKET, parentId: PARENT, workflowId: "wf_1", assignee: REVIEWER, status: "in_review", phase: "ship" },
  };
  h.state.children = [
    { ticketId: DEV_TICKET, parentId: PARENT, status: "done", assignee: DEV, type: "task", phase: "development" },
    // The gate ticket, still open — identified by GUARDED PHASE ("ship"), not title.
    { ticketId: GATE_TICKET, parentId: PARENT, status: "in_review", assignee: REVIEWER, type: "task", phase: "ship", title: "Merge Approval" },
  ];
  h.state.workflow = makeWorkflow();
  h.state.s3Objects = {};
  h.state.ebEvents.length = 0;
  h.state.statuses.length = 0;
  h.state.merges.length = 0;
  h.state.notifications.length = 0;
  h.state.claims.length = 0;
  h.state.flagsHeld.clear();
  h.state.ghCalls.length = 0;
  h.state.headPrs = [];
  h.state.basePrs = [];
  h.state.ghStatus = 200;
  delete process.env.GATE_BYPASS_MODE;

  vi.stubGlobal("fetch", async (url) => {
    const u = String(url);
    h.state.ghCalls.push(u);
    const body = u.includes("&head=") ? h.state.headPrs : u.includes("&base=") ? h.state.basePrs : [];
    return {
      ok: h.state.ghStatus < 400,
      status: h.state.ghStatus,
      text: async () => JSON.stringify(h.state.ghStatus < 400 ? body : { message: "Bad credentials" }),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GATE_BYPASS_MODE;
});

describe("done cascade runs the gate-bypass detector (D1.1 wiring)", () => {
  it("Jira-webhook path: merged before any approval → gate_bypass + flag + escalation, and agent.complete still fires with gateBypass:true", async () => {
    await load();
    h.state.headPrs = [mergedPr()];

    await handleTicketDoneUnified(DEV_TICKET);

    const bypass = eventsOfType("workflow.gate_bypass");
    expect(bypass).toHaveLength(1);
    expect(bypass[0].detail).toMatchObject({
      workflowId: "wf_1",
      ticketId: DEV_TICKET,
      mergeCommit: MERGE_COMMIT,
      prUrl: "https://github.com/o/r/pull/327",
      gateTicketId: GATE_TICKET,
      approvedAt: null,
      mode: "enforce",
    });

    // enforce: the task goes back to in_review and is flagged un-reclaimable (F8),
    // the flag landing through the TEAM-4099 F2 claim CAS rather than a blind merge.
    expect(h.state.statuses).toEqual([{ wfId: "wf_1", tid: DEV_TICKET, status: "in_review" }]);
    expect(h.state.merges.some((m) => m.fields.gateBypassFlaggedAt)).toBe(false);
    expect(h.state.claims).toEqual([
      { wfId: "wf_1", tid: DEV_TICKET, mergeCommit: MERGE_COMMIT, flaggedAt: expect.any(String), shadow: false },
    ]);

    // One escalation per offending merge commit (F9), through the CAS-guarded seam,
    // in the shape every escalation consumer selects on (TEAM-4099 F1).
    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.notifications[0].n).toMatchObject({
      id: `notif_gate_bypass_wf_1_${MERGE_COMMIT}`,
      type: "manager_escalation",
      acknowledged: false,
      ticketId: DEV_TICKET,
    });
    expect(h.state.notifications[0].n.details).toMatch(/no APPROVE recorded/);

    // The work DID happen — the completion is still announced, but marked.
    const complete = eventsOfType("agent.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0].detail).toMatchObject({ ticketId: DEV_TICKET, gateBypass: true });
  });

  it("DDB-stream path: the same check runs before agent.complete", async () => {
    await load();
    h.state.headPrs = [mergedPr()];

    await handleTicketDone(DEV_TICKET, { parentId: PARENT, workflowId: "wf_1", assignee: DEV });

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(1);
    expect(eventsOfType("agent.complete")[0].detail.gateBypass).toBe(true);
    expect(h.state.statuses).toEqual([{ wfId: "wf_1", tid: DEV_TICKET, status: "in_review" }]);
  });

  it("CONTROL — an APPROVE row before the merge → no gate_bypass, no flag, a clean agent.complete", async () => {
    await load();
    h.state.headPrs = [mergedPr()];
    h.state.workflow = makeWorkflow({ reviewGateHistory: ledgerWith("2026-09-01T09:30:00Z") });

    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(h.state.statuses).toHaveLength(0);
    expect(h.state.notifications).toHaveLength(0);
    const complete = eventsOfType("agent.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0].detail.gateBypass).toBeUndefined();
  });

  it("CONTROL — the approval landed AFTER the merge: still a bypass (order is the whole point)", async () => {
    await load();
    h.state.headPrs = [mergedPr()];
    h.state.workflow = makeWorkflow({ reviewGateHistory: ledgerWith("2026-09-01T10:30:00Z") });

    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(1);
  });

  // TEAM-4099 F1/F2 — the flag flips the task to in_review, so the ticket can be
  // Done again (and the reconcile sweep re-drives done tickets), which re-entered
  // this path and re-published everything. Whether or not the caller's snapshot
  // already shows the flag, the second pass must be silent.
  it("re-Done of an already-flagged ticket: no second event, no second flip, no second escalation", async () => {
    await load();
    h.state.headPrs = [mergedPr()];

    await handleTicketDoneUnified(DEV_TICKET);
    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(1);
    // What the flag left behind, as the next read would see it: the task is back
    // in_review (so the "already complete" dedup guard no longer short-circuits
    // the cascade — this is exactly why a re-Done reaches the detector again) and
    // carries the flag stamp.
    Object.assign(h.state.workflow.agentTasks[DEV_TICKET], {
      status: "in_review",
      gateBypassFlaggedAt: "2026-09-01T10:05:00Z",
      gateBypassMergeCommit: MERGE_COMMIT,
    });
    h.state.workflow.humanNotifications = h.state.notifications.map((n) => n.n);
    h.state.ebEvents.length = 0;

    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(h.state.statuses).toHaveLength(1);
    expect(h.state.notifications).toHaveLength(1);
    // The completion is still announced — the work really did happen.
    expect(eventsOfType("agent.complete")).toHaveLength(1);
  });

  it("re-Done on a STALE snapshot (flag not yet visible): the claim CAS still stops it", async () => {
    await load();
    h.state.headPrs = [mergedPr()];

    await handleTicketDoneUnified(DEV_TICKET);
    h.state.ebEvents.length = 0;
    // The status flip is visible (the dedup guard lets the cascade through) but
    // the flag stamp is NOT: the caller's snapshot predates it, so the cheap
    // short-circuit misses and only claimGateBypassFlag can stop the re-publish.
    h.state.workflow.agentTasks[DEV_TICKET].status = "in_review";
    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(h.state.claims).toHaveLength(2); // both passes tried the CAS
    expect(h.state.statuses).toHaveLength(1);
    expect(h.state.notifications).toHaveLength(1);
  });

  it("shadow mode: the event only — zero writes to the task or the run", async () => {
    process.env.GATE_BYPASS_MODE = "shadow";
    await load();
    h.state.headPrs = [mergedPr()];

    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")[0].detail.mode).toBe("shadow");
    expect(h.state.statuses).toHaveLength(0);
    expect(h.state.merges.some((m) => m.fields.gateBypassFlaggedAt)).toBe(false);
    expect(h.state.notifications).toHaveLength(0);
    // TEAM-4099 F2: shadow's claim is SHADOW-scoped — writing gateBypassFlaggedAt
    // here would trip the F8 claimInvocation veto, i.e. shadow would enforce.
    expect(h.state.claims).toEqual([
      { wfId: "wf_1", tid: DEV_TICKET, mergeCommit: MERGE_COMMIT, flaggedAt: expect.any(String), shadow: true },
    ]);
    // Still announced as complete, still marked (the merge is real either way).
    expect(eventsOfType("agent.complete")[0].detail.gateBypass).toBe(true);
  });

  it("off mode and a gate-less def are both inert — zero GitHub calls, zero events", async () => {
    process.env.GATE_BYPASS_MODE = "off";
    await load();
    h.state.headPrs = [mergedPr()];
    await handleTicketDoneUnified(DEV_TICKET);
    expect(h.state.ghCalls).toHaveLength(0);
    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(eventsOfType("agent.complete")[0].detail.gateBypass).toBeUndefined();

    delete process.env.GATE_BYPASS_MODE;
    h.state.ebEvents.length = 0;
    h.state.ghCalls.length = 0;
    await load(NO_GATE_CONFIG);
    h.state.headPrs = [mergedPr()];
    await handleTicketDoneUnified(DEV_TICKET);
    expect(h.state.ghCalls).toHaveLength(0);
    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
  });

  it("nothing merged → no verdict at all (a clean run is untouched)", async () => {
    await load();
    // Closed-but-never-merged PRs are not merges.
    h.state.headPrs = [mergedPr({ merged_at: null })];

    await handleTicketDoneUnified(DEV_TICKET);

    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(h.state.notifications).toHaveLength(0);
  });

  it("GitHub unreachable → NEVER a bypass verdict (unknown is not 'unapproved'), and the cascade still completes the ticket", async () => {
    await load();
    h.state.ghStatus = 401;

    await handleTicketDoneUnified(DEV_TICKET);

    expect(h.state.ghCalls.length).toBeGreaterThan(0);
    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
    expect(h.state.statuses).toHaveLength(0);
    expect(eventsOfType("agent.complete")).toHaveLength(1);
    expect(eventsOfType("agent.complete")[0].detail.gateBypass).toBeUndefined();
  });

  it("a human gate ticket's own done is never checked against itself", async () => {
    await load();
    h.state.headPrs = [mergedPr()];
    h.state.tickets[GATE_TICKET].status = "done";

    await handleTicketDoneUnified(GATE_TICKET);

    expect(h.state.ghCalls).toHaveLength(0);
    expect(eventsOfType("workflow.gate_bypass")).toHaveLength(0);
  });
});
