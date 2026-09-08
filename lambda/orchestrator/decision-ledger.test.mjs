import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4248 D3 FR-D3.3/4/5 — the decision ledger's I/O half, through the REAL
 * index.mjs (only the AWS SDK, workflow-store, review-cap and `fetch` seams are
 * mocked).
 *
 * dowtdh is the fixture and the reason. The product owner resolved Concern 3 at
 * Spec Approval TEAM-4174 ("5000 ms window; pause the countdown while Undo has
 * focus or hover") and restated it at Design Approval TEAM-4176. The design
 * recommended the opposite, plan.md TEAM-4177 wrote "Keep fixed 5000 ms; no
 * focus-pause" under "## Deviations: None yet.", and TEAM-4178 (Plan Approval)
 * APPROVED that plan — because the engineer's review package never said a
 * decision had been dropped. It cost reviewer finding F1 P1 and fix ticket
 * TEAM-4183 at the very end of the run.
 *
 * artifact-chain.test.mjs pins the pure grammar. These cases pin the CALLER:
 *   off      → zero GitHub calls, zero S3 writes, zero events, no checklist, and
 *              the dowtdh gate opens exactly as it did.
 *   shadow   → the ledger is committed + mirrored, the package leads with what was
 *              dropped, the authors get the checklist — and no gate is withheld.
 *   enforce  → shadow, plus the Plan Approval gate is not presented at all: the
 *              plan goes back for rework and no human is paged.
 */

const WF = "wf_1788731227559_dowtdh";
const EPIC = "TEAM-4162";
const SPEC_GATE = "TEAM-4174";
const PLAN_GATE = "TEAM-4178";
const PLAN_TICKET = "TEAM-4177";
const DESIGNER = "agentcore_hub_frontend_designer";
const DEV = "agentcore_hub_frontend_dev";
const QA = "agentcore_hub_qa_verifier";
const PO = "human:product-owner";
const BRANCH = "feature/TEAM-4162-undo-window";
const LEDGER_PATH = `.sdlc/${WF}/decisions.md`;
const MIRROR_KEY = `workflows/${WF}/shared/decisions.md`;

/** The product owner's comment, verbatim from the reviewer's F1 evidence. */
const PO_COMMENT = {
  author: PO,
  timestamp: "2026-09-06T14:12:00.000Z",
  content:
    "Spec reads well. Two things before I approve.\n" +
    "Concern 3 (Undo auto-dismiss): RESOLVED - 5000 ms window; pause the countdown while Undo has focus or hover.\n" +
    "Concern 4 (reload inside the window): RESOLVED - accept commit-at-click; the snapshot stays memory-only.",
};
const APPROVAL_ONLY = { author: PO, timestamp: "2026-09-06T14:13:00.000Z", content: "Approved." };

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    storeCalls: /** @type {string[]} */ ([]),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    s3Puts: /** @type {{ key: string, body: string }[]} */ ([]),
    /** GitHub calls, in order: every one is a claim this feature makes about I/O. */
    gh: /** @type {{ method: string, path: string, body: any }[]} */ ([]),
    ghFiles: /** @type {Record<string, { text: string, sha: string }>} */ ({}),
    /** Statuses the next PUTs answer with (shift()ed); anything left → 200. */
    putStatuses: /** @type {number[]} */ ([]),
    /** When a PUT conflicts, the body the WINNER left behind (CAS rebuild path). */
    conflictWinner: /** @type {string|null} */ (null),
    shaSeq: 0,
    cap: /** @type {any} */ (null),
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
            if (String(cmd.input.TableName).includes("events")) return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "ScanCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send() {
      return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") {
        h.state.s3Puts.push({ key: cmd.input.Key, body: String(cmd.input.Body) });
        h.state.s3Objects[cmd.input.Key] = String(cmd.input.Body);
        return {};
      }
      if (name === "ListObjectsV2Command") {
        const keys = Object.keys(h.state.s3Objects).filter((k) => k.startsWith(cmd.input.Prefix));
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      h.state.s3Gets.push(cmd.input.Key);
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) { const e = new Error("no such key"); e.name = "NoSuchKey"; throw e; }
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

vi.mock("./workflow-store.mjs", () => {
  // Named rather than counted on the spies: vi.resetModules() re-runs this
  // factory per mode, so the log lives on h.state where it survives.
  const call = (op, ret) => vi.fn(async () => { h.state.storeCalls.push(op); return typeof ret === "function" ? ret() : ret; });
  return {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    claimInvocation: call("claimInvocation", true),
    putTaskEntry: call("putTaskEntry"),
    trackTicket: call("trackTicket"),
    setTaskStatus: call("setTaskStatus"),
    completeTaskEntry: call("completeTaskEntry"),
    mergeTaskMetadata: call("mergeTaskMetadata"),
    advancePhase: call("advancePhase"),
    adoptFeatureBranch: call("adoptFeatureBranch"),
    setResumeContext: call("setResumeContext"),
    removeResumeContext: call("removeResumeContext"),
    setRepoCheck: call("setRepoCheck"),
    appendReviewNotificationOnce: call("appendReviewNotificationOnce", true),
    appendNotification: call("appendNotification"),
    ackNotifications: call("ackNotifications"),
    completeWorkflow: call("completeWorkflow", true),
    claimTerminalOutcome: call("claimTerminalOutcome", true),
    claimFinalization: call("claimFinalization", false),
    markFinalized: call("markFinalized"),
    setDelivery: call("setDelivery"),
    markGateRequested: call("markGateRequested", true),
    markGateRejected: call("markGateRejected", { state: "rejected", cycles: [{}] }),
    markGateApproved: call("markGateApproved", { state: "approved", cycles: [{}] }),
    markGateRejectedFromLegacy: call("markGateRejectedFromLegacy", true),
  };
});

// escalated:true short-circuits handleReviewRejection before the re-open loop —
// all these cases need to know is that the rejection ran, and with what feedback.
vi.mock("./review-cap.mjs", async () => {
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    parseDecision: actual.parseDecision,
    createReviewCap: () => ({ enforce: (...args) => h.state.cap(...args) }),
  };
});

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "ghp_test";
process.env.REPO_CHECK_MODE = "off";

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
    { agentId: DESIGNER, phase: "design" },
    { agentId: DEV, phase: "development" },
    { agentId: QA, phase: "verification" },
  ],
});

/**
 * The playbook shape, with `artifactChain` on the def itself (a run's overlay
 * resolves to exactly this) — including the orchestrator-owned decisions.md.
 */
const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "playbook-run",
      sdlcFramework: "playbook",
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "design",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "verification"],
      reviewGates: [{ name: "Plan Approval", afterPhase: "development", onReject: "rework", blocking: true }],
      phases: [
        { agentPhase: "requirements" }, { agentPhase: "design" },
        { agentPhase: "development" }, { agentPhase: "verification" },
      ],
      artifactChain: {
        dir: ".sdlc/{workflowId}",
        artifacts: [
          { name: "intent.md", owner: "hub", gate: "Intent Acceptance" },
          { name: "decisions.md", owner: "orchestrator" },
          { name: "spec.md", owner: "agentcore_hub_requirements_analyst", gate: "Spec Approval" },
          { name: "design/<agent>.md", owner: "design", gate: "Design Approval" },
          { name: "plan.md", owner: "development", gate: "Plan Approval" },
          { name: "findings.md", owner: "agentcore_hub_code_reviewer" },
        ],
      },
    },
  ],
});

const ghResponse = (status, json) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(json ?? {}),
});

const contentsPathOf = (path) => {
  const m = /\/contents\/([^?]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
};

function installFetch() {
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : null;
    h.state.gh.push({ method, path, body });
    const file = contentsPathOf(path);
    if (file && method === "GET") {
      const have = h.state.ghFiles[file];
      if (!have) return ghResponse(404, { message: "Not Found" });
      return ghResponse(200, {
        content: Buffer.from(have.text, "utf8").toString("base64"),
        encoding: "base64",
        sha: have.sha,
      });
    }
    if (file && method === "PUT") {
      const status = h.state.putStatuses.length ? h.state.putStatuses.shift() : 200;
      if (status >= 400) {
        // A CAS loser must see what the winner wrote, or the retry is untested.
        if (h.state.conflictWinner !== null) {
          h.state.ghFiles[file] = { text: h.state.conflictWinner, sha: `sha_winner` };
        }
        return ghResponse(status, { message: `simulated ${status}` });
      }
      h.state.ghFiles[file] = {
        text: Buffer.from(body.content, "base64").toString("utf8"),
        sha: `sha_${++h.state.shaSeq}`,
      };
      return ghResponse(200, { commit: { sha: "c1" } });
    }
    return ghResponse(200, {});
  });
}

let handler;
let handleTicketDone;
let buildAgentContext;

/** index.mjs snapshots DECISION_LEDGER at module load, so every mode re-imports. */
async function load(mode, { gateGuard } = {}) {
  if (mode === undefined) delete process.env.DECISION_LEDGER;
  else process.env.DECISION_LEDGER = mode;
  if (gateGuard) process.env.GATE_STATE_GUARD = gateGuard;
  else delete process.env.GATE_STATE_GUARD;
  h.state.s3Objects["config/agents.json"] = AGENTS_CONFIG;
  h.state.s3Objects["config/workflows.json"] = WORKFLOWS_CONFIG;
  vi.resetModules();
  const mod = await import("./index.mjs");
  ({ handler, handleTicketDone, buildAgentContext } = mod);
  await mod.handler({ Records: [] }); // primes roster / defs / registry caches
  reset();
  return mod;
}

function reset() {
  h.state.events.length = 0;
  h.state.storeCalls.length = 0;
  h.state.s3Gets.length = 0;
  h.state.s3Puts.length = 0;
  h.state.gh.length = 0;
  h.state.putStatuses.length = 0;
  h.state.conflictWinner = null;
}

const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const detailOf = (e) => (typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail);
const ghCalls = (method) => h.state.gh.filter((c) => c.method === method && contentsPathOf(c.path));
const ledgerText = () => h.state.ghFiles[LEDGER_PATH]?.text || "";

/** A DDB-stream MODIFY moving a gate ticket to `done` — the human APPROVED. */
const doneImage = ({ ticketId = SPEC_GATE, assignee = PO, title = "Spec Approval: undo window", comments = [PO_COMMENT] } = {}) => ({
  ticketId, status: "done", assignee, title, comments,
  workflowId: WF, parentId: EPIC, type: "task", blockedBy: [],
});

/** A DDB-stream MODIFY moving the Plan Approval gate to `ready` — page the human. */
const readyEvent = () => ({
  Records: [{
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: PLAN_GATE }, status: { S: "ready" }, assignee: { S: "human:engineer" },
        workflowId: { S: WF }, parentId: { S: EPIC }, type: { S: "task" },
        title: { S: "Plan Approval: undo window" }, blockedBy: { L: [{ S: PLAN_TICKET }] },
      },
      OldImage: { ticketId: { S: PLAN_GATE }, status: { S: "blocked" } },
    },
  }],
});

/** The ledger as it stands after TEAM-4174 resolved Concern 3 and Concern 4. */
const LEDGER_MD =
  `# Gate Decisions\n\n` +
  `### ${SPEC_GATE}#3\n` +
  `- **id:** ${SPEC_GATE}#3\n` +
  `- **Gate:** Spec Approval (${SPEC_GATE})\n` +
  `- **Concern:** 3\n` +
  `- **Reviewer:** ${PO}\n` +
  `- **At:** 2026-09-06T14:12:00.000Z\n` +
  `- **Status:** open\n` +
  `- **Decision:** 5000 ms window; pause the countdown while Undo has focus or hover.\n`;

/** dowtdh's plan.md as APPROVED at 001fe322: it cites the gate nowhere. */
const PLAN_MD_ORIGINAL =
  `# Plan: Clear the Activity feed with an undo window\n\n## Concerns\n\n` +
  `| 3 | Undo auto-dismisses at 5000 ms. | Keep fixed 5000 ms; no focus-pause (designer rec) | resolved |\n\n` +
  `## Deviations\n\nNone yet.\n`;

/** The same plan written after the fix — the departure names the decision. */
const PLAN_MD_POSTFIX =
  PLAN_MD_ORIGINAL.replace(
    "None yet.",
    `- **D1 — Concern 3 / ${SPEC_GATE}#3, partially implemented.** Hover-pause ships; focus-pause omitted because the only focusable child is Undo itself.`,
  );

function setWorkflow(extra = {}) {
  h.state.workflow = {
    id: WF,
    workflowId: WF,
    phase: "development",
    epicId: EPIC,
    workflowDefId: "playbook-run",
    input: { title: "Undo window", description: "d", sdlcFramework: "playbook" },
    repoConfig: { layout: "single-repo", repos: [{ platform: "shared", url: "https://github.com/tycenjmccann/demo-app", defaultBranch: "main" }] },
    featureBranch: BRANCH,
    agentTasks: {},
    humanNotifications: [],
    ...extra,
  };
}

beforeEach(() => {
  h.state.tickets = {
    [SPEC_GATE]: { ticketId: SPEC_GATE, workflowId: WF, parentId: EPIC, assignee: PO, type: "task", status: "done", title: "Spec Approval: undo window", comments: [PO_COMMENT] },
    [PLAN_GATE]: { ticketId: PLAN_GATE, workflowId: WF, parentId: EPIC, assignee: "human:engineer", type: "task", status: "ready", title: "Plan Approval: undo window", blockedBy: [PLAN_TICKET] },
    [PLAN_TICKET]: { ticketId: PLAN_TICKET, workflowId: WF, parentId: EPIC, assignee: DEV, type: "task", status: "done", title: "Plan: undo window" },
  };
  // One still-open sibling, so nothing on these paths tips into completion.
  h.state.children = [
    { ticketId: PLAN_TICKET, parentId: EPIC, workflowId: WF, assignee: DEV, status: "done", blockedBy: [] },
    { ticketId: "TEAM-4180", parentId: EPIC, workflowId: WF, assignee: QA, status: "blocked", blockedBy: [PLAN_GATE] },
  ];
  h.state.s3Objects = { "config/agents.json": AGENTS_CONFIG, "config/workflows.json": WORKFLOWS_CONFIG };
  h.state.ghFiles = {};
  h.state.shaSeq = 0;
  h.state.cap = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));
  installFetch();
  reset();
  setWorkflow();
});

afterEach(() => {
  delete process.env.DECISION_LEDGER;
  delete process.env.GATE_STATE_GUARD;
  vi.restoreAllMocks();
});

describe("DECISION_LEDGER=off — byte-identical to before D3", () => {
  it("an approved gate with two decisions in its comments writes NOTHING, anywhere", async () => {
    await load("off");
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(h.state.gh, "off must not talk to GitHub at all").toHaveLength(0);
    expect(h.state.s3Puts.map((p) => p.key)).not.toContain(MIRROR_KEY);
    expect(h.state.events.filter((e) => String(e.type).startsWith("decision."))).toHaveLength(0);
  });

  it("the dowtdh Plan Approval gate opens on a plan that honours nothing", async () => {
    await load("off");
    h.state.s3Objects[`workflows/${WF}/shared/decisions.md`] = LEDGER_MD;
    h.state.s3Objects[`workflows/${WF}/shared/plan.md`] = PLAN_MD_ORIGINAL;
    await handler(readyEvent());
    // The defect, reproduced: a human is paged to approve it.
    expect(h.state.storeCalls).toContain("appendReviewNotificationOnce");
    expect(h.state.events.filter((e) => String(e.type).startsWith("decision."))).toHaveLength(0);
    expect(h.state.s3Gets, "off must not even read the ledger").not.toContain(MIRROR_KEY);
    expect(h.state.cap).not.toHaveBeenCalled();
  });

  it("a QA persona's context is unchanged and pays no ledger read", async () => {
    await load("off");
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD;
    const ctx = await buildAgentContext(
      { ticketId: "TEAM-4180", assignee: QA, parentId: EPIC, title: "Verify the undo window", description: "d" },
      h.state.workflow,
    );
    expect(ctx).toContain("## SDLC Framework");
    expect(ctx).not.toContain("## Gate Decisions");
    expect(h.state.s3Gets).not.toContain(MIRROR_KEY);
  });

  it("the Plan ticket's own context is byte-identical with and without a ledger present", async () => {
    await load("off");
    const planTicket = { ticketId: PLAN_TICKET, assignee: DEV, parentId: EPIC, title: "Plan: undo window", description: "d" };
    const bare = await buildAgentContext(planTicket, h.state.workflow);
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD;
    expect(await buildAgentContext(planTicket, h.state.workflow)).toBe(bare);
  });
});

describe("appends one inert entry per gate resolution, idempotently", () => {
  it("shadow commits both decisions on the branch, mirrors them, and emits decision.recorded", async () => {
    await load("shadow");
    await handleTicketDone(SPEC_GATE, doneImage());

    // Exactly one PUT for the two entries the comment carried.
    expect(ghCalls("PUT")).toHaveLength(1);
    expect(ghCalls("PUT")[0].body.branch).toBe(BRANCH);
    expect(contentsPathOf(ghCalls("PUT")[0].path)).toBe(LEDGER_PATH);
    // A fresh ledger has no CAS token — the create case, not a clobber.
    expect(ghCalls("PUT")[0].body.sha).toBeUndefined();

    const md = ledgerText();
    expect(md).toContain(`### ${SPEC_GATE}#3`);
    expect(md).toContain("5000 ms window; pause the countdown while Undo has focus or hover.");
    expect(md).toContain(`### ${SPEC_GATE}#4`);
    expect(md).toContain("- **Status:** open");
    // The prose the human typed is now data: one line, no backticks.
    for (const line of md.split("\n")) expect(line).not.toContain("`");

    const mirror = h.state.s3Puts.filter((p) => p.key === MIRROR_KEY);
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body).toBe(md);

    const recorded = eventsOf("decision.recorded");
    expect(recorded).toHaveLength(1);
    const detail = detailOf(recorded[0]);
    expect(detail.ids).toEqual([`${SPEC_GATE}#3`, `${SPEC_GATE}#4`]);
    expect(detail).toMatchObject({ mode: "shadow", added: 2, committed: true, gateTicketId: SPEC_GATE });
  });

  it("a webhook redelivery of the same gate performs ZERO writes", async () => {
    await load("shadow");
    await handleTicketDone(SPEC_GATE, doneImage());
    reset();
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(ghCalls("PUT"), "the ids are already in the ledger").toHaveLength(0);
    expect(h.state.s3Puts.map((p) => p.key)).not.toContain(MIRROR_KEY);
    expect(eventsOf("decision.recorded")).toHaveLength(0);
  });

  it("an approval with no decision line records nothing — 'Approved.' is not a decision", async () => {
    await load("shadow");
    await handleTicketDone(SPEC_GATE, doneImage({ comments: [APPROVAL_ONLY] }));
    expect(h.state.gh, "not even the ledger read is worth paying for").toHaveLength(0);
    expect(eventsOf("decision.recorded")).toHaveLength(0);
  });

  it("a non-human assignee records nothing — only a gate resolution is a decision", async () => {
    await load("shadow");
    await handleTicketDone(PLAN_TICKET, doneImage({
      ticketId: PLAN_TICKET, assignee: DEV, title: "Plan: undo window",
      comments: [{ author: DEV, content: "Concern 3: RESOLVED - I decided this myself." }],
    }));
    expect(ghCalls("PUT")).toHaveLength(0);
    expect(eventsOf("decision.recorded")).toHaveLength(0);
  });

  it("enforce records exactly as shadow does — the gate check is all it adds", async () => {
    await load("enforce");
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(ghCalls("PUT")).toHaveLength(1);
    expect(ledgerText()).toContain(`### ${SPEC_GATE}#3`);
    expect(detailOf(eventsOf("decision.recorded")[0]).mode).toBe("enforce");
  });

  it("a 409 is retried once against the winner's file and lands", async () => {
    await load("shadow");
    h.state.putStatuses.push(409);
    h.state.conflictWinner = `# Gate Decisions\n\n### TEAM-4176#9\n- **id:** TEAM-4176#9\n- **Status:** open\n`;
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(ghCalls("PUT")).toHaveLength(2);
    // The retry re-derived from the winner's bytes instead of replaying ours.
    expect(ledgerText()).toContain("TEAM-4176#9");
    expect(ledgerText()).toContain(`### ${SPEC_GATE}#3`);
    expect(detailOf(eventsOf("decision.recorded")[0]).committed).toBe(true);
  });

  it("a 409 whose winner already recorded our ids is a success with nothing to write", async () => {
    await load("shadow");
    h.state.putStatuses.push(409);
    // The winner is a concurrent deliverer of the SAME gate: both of our ids are
    // already in its file, so `rebuild` has nothing left to add.
    h.state.conflictWinner =
      `${LEDGER_MD}\n### ${SPEC_GATE}#4\n- **id:** ${SPEC_GATE}#4\n- **Status:** open\n`;
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(ghCalls("PUT"), "no second PUT — rebuild had nothing to add").toHaveLength(1);
    expect(eventsOf("decision.recorded")).toHaveLength(1);
    expect(detailOf(eventsOf("decision.recorded")[0]).committed).toBe(false);
  });

  it("409 then 409 fails open — a warn, the S3 mirror, and no throw", async () => {
    await load("shadow");
    h.state.putStatuses.push(409, 409);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handleTicketDone(SPEC_GATE, doneImage())).resolves.not.toThrow();
    expect(ghCalls("PUT")).toHaveLength(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/failing open/i);
    // The ledger the checklist and the gate check read still exists.
    expect(h.state.s3Puts.filter((p) => p.key === MIRROR_KEY)).toHaveLength(1);
    expect(detailOf(eventsOf("decision.recorded")[0]).committed).toBe(false);
  });

  it("a read-only PAT (403) writes the S3 mirror only, and says why", async () => {
    await load("shadow");
    h.state.putStatuses.push(403);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleTicketDone(SPEC_GATE, doneImage());
    expect(ghCalls("PUT"), "403 is a configuration answer — no retry").toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/contents:write/);
    const mirror = h.state.s3Puts.filter((p) => p.key === MIRROR_KEY);
    expect(mirror).toHaveLength(1);
    expect(mirror[0].body).toContain(`### ${SPEC_GATE}#3`);
    expect(detailOf(eventsOf("decision.recorded")[0]).committed).toBe(false);
  });
});

describe("Plan Approval cannot pass with an unreferenced open decision", () => {
  beforeEach(() => {
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD;
    h.state.s3Objects[`workflows/${WF}/shared/plan.md`] = PLAN_MD_ORIGINAL;
  });

  it("enforce withholds TEAM-4178: no human is paged, the plan goes back for rework", async () => {
    await load("enforce", { gateGuard: "enforce" });
    await handler(readyEvent());

    expect(h.state.storeCalls, "the gate was never opened").not.toContain("appendReviewNotificationOnce");
    expect(h.state.storeCalls).not.toContain("markGateRequested");
    // markGateRejected's CAS pairs `rejected` with a `requested` row's
    // requestedAt; closing a never-requested cycle would make the human's LATER
    // genuine Request-changes classify as a duplicate and be dropped.
    expect(h.state.storeCalls).not.toContain("markGateRejected");
    expect(h.state.workflow.gateStates).toBeUndefined();

    const withheld = eventsOf("decision.gate_withheld");
    expect(withheld).toHaveLength(1);
    expect(detailOf(withheld[0])).toMatchObject({ gateTicketId: PLAN_GATE, phase: "plan", ids: [`${SPEC_GATE}#3`] });
    expect(eventsOf("decision.unhonoured_observed")).toHaveLength(1);

    // Rework runs down the path a human's "Request changes" already takes, and
    // the synthetic reviewComment is its feedback.
    expect(h.state.cap).toHaveBeenCalledTimes(1);
    const feedback = h.state.cap.mock.calls[0][0].feedback;
    expect(feedback).toContain(`${SPEC_GATE}#3`);
    expect(feedback).toContain("## Deviations");
    expect(feedback).toContain("5000 ms window; pause the countdown while Undo has focus or hover.");
  });

  it("shadow presents the same gate, with what was dropped at the FRONT of the package", async () => {
    h.state.s3Objects[`workflows/${WF}/shared/review-package-plan.json`] = JSON.stringify({
      summary: "Plan for the undo window is complete.",
      bullets: ["6 implementation tickets", "no schema change"],
      links: [{ label: "plan", url: "https://example.com/plan" }],
    });
    await load("shadow", { gateGuard: "enforce" });
    await handler(readyEvent());

    expect(h.state.storeCalls, "shadow withholds nothing").toContain("appendReviewNotificationOnce");
    expect(h.state.storeCalls).toContain("markGateRequested");
    expect(eventsOf("decision.unhonoured_observed")).toHaveLength(1);
    expect(eventsOf("decision.gate_withheld")).toHaveLength(0);
    expect(h.state.cap).not.toHaveBeenCalled();

    const store = await import("./workflow-store.mjs");
    const notification = store.appendReviewNotificationOnce.mock.calls[0][2];
    expect(notification.summary).toMatch(/^Decisions not honoured \(1\)/);
    expect(notification.bullets[0]).toContain(`${SPEC_GATE}#3`);
    expect(notification.bullets[0].length).toBeLessThanOrEqual(200);
    // Prepended AFTER loadReviewPackage's own clamp, so the agent's own bullets
    // are widened past, never pushed off the end.
    expect(notification.bullets).toContain("6 implementation tickets");
    expect(notification.bullets).toContain("no schema change");
  });

  it("a gate with no review package at all still carries the section", async () => {
    await load("shadow", { gateGuard: "enforce" });
    await handler(readyEvent());
    const store = await import("./workflow-store.mjs");
    const notification = store.appendReviewNotificationOnce.mock.calls[0][2];
    // loadReviewPackage returns null with no parts — the exact thin gate a dropped
    // decision hides behind, which is why the check does not live inside it.
    expect(notification.bullets[0]).toContain(`${SPEC_GATE}#3`);
  });

  it("the post-fix plan passes the same gate untouched, in both non-off modes", async () => {
    for (const mode of ["shadow", "enforce"]) {
      h.state.s3Objects[`workflows/${WF}/shared/plan.md`] = PLAN_MD_POSTFIX;
      await load(mode, { gateGuard: "enforce" });
      await handler(readyEvent());
      expect(h.state.storeCalls, `${mode} presents the gate`).toContain("appendReviewNotificationOnce");
      expect(h.state.events.filter((e) => String(e.type).startsWith("decision.")), mode).toHaveLength(0);
      expect(h.state.cap, mode).not.toHaveBeenCalled();
    }
  });

  it("a decision already marked resolved never withholds anything", async () => {
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD.replace("- **Status:** open", "- **Status:** resolved");
    await load("enforce", { gateGuard: "enforce" });
    await handler(readyEvent());
    expect(h.state.storeCalls).toContain("appendReviewNotificationOnce");
    expect(eventsOf("decision.gate_withheld")).toHaveLength(0);
  });

  it("a missing plan.md fails OPEN — 'cites nothing' and 'we cannot read it' are not the same", async () => {
    delete h.state.s3Objects[`workflows/${WF}/shared/plan.md`];
    await load("enforce", { gateGuard: "enforce" });
    await handler(readyEvent());
    expect(h.state.storeCalls).toContain("appendReviewNotificationOnce");
    expect(eventsOf("decision.gate_withheld")).toHaveLength(0);
  });
});

describe("design and plan context carry the open-decision checklist", () => {
  beforeEach(() => { h.state.s3Objects[MIRROR_KEY] = LEDGER_MD; });

  it("the Plan ticket is told to cite or deviate, by id", async () => {
    await load("shadow");
    const ctx = await buildAgentContext(
      { ticketId: PLAN_TICKET, assignee: DEV, parentId: EPIC, title: "Plan: undo window", description: "d" },
      h.state.workflow,
    );
    expect(ctx).toContain("## Gate Decisions (REQUIRED checklist)");
    expect(ctx).toContain(`- [ ] ${SPEC_GATE}#3 — 5000 ms window; pause the countdown while Undo has focus or hover.`);
    expect(ctx).toContain('"## Deviations: None yet." with an open line above it');
    expect(ctx).toContain(`.sdlc/${WF}/decisions.md`);
  });

  it("a design persona gets it too — the design that contradicted the PO is where it started", async () => {
    await load("shadow");
    const ctx = await buildAgentContext(
      { ticketId: "TEAM-4175", assignee: DESIGNER, parentId: EPIC, title: "Design the undo window", description: "d" },
      h.state.workflow,
    );
    expect(ctx).toContain("## Gate Decisions (REQUIRED checklist)");
    expect(ctx).toContain(`${SPEC_GATE}#3`);
  });

  it("an implementation dev and a QA verifier get no checklist and pay no ledger read", async () => {
    await load("shadow");
    for (const ticket of [
      { ticketId: "TEAM-4179", assignee: DEV, parentId: EPIC, title: "Implement the undo window", description: "d" },
      { ticketId: "TEAM-4180", assignee: QA, parentId: EPIC, title: "Verify the undo window", description: "d" },
    ]) {
      h.state.s3Gets.length = 0;
      const ctx = await buildAgentContext(ticket, h.state.workflow);
      expect(ctx, ticket.assignee).not.toContain("## Gate Decisions");
      expect(h.state.s3Gets, ticket.assignee).not.toContain(MIRROR_KEY);
    }
  });

  it("the checklist comes from the S3 mirror — no GitHub round trip on the dispatch path", async () => {
    await load("shadow");
    await buildAgentContext(
      { ticketId: PLAN_TICKET, assignee: DEV, parentId: EPIC, title: "Plan: undo window", description: "d" },
      h.state.workflow,
    );
    expect(h.state.s3Gets).toContain(MIRROR_KEY);
    expect(ghCalls("GET"), "a dispatch is far more frequent than a gate resolution").toHaveLength(0);
  });

  it("an empty ledger emits no block at all", async () => {
    delete h.state.s3Objects[MIRROR_KEY];
    await load("shadow");
    const ctx = await buildAgentContext(
      { ticketId: PLAN_TICKET, assignee: DEV, parentId: EPIC, title: "Plan: undo window", description: "d" },
      h.state.workflow,
    );
    expect(ctx).toContain("## SDLC Framework");
    expect(ctx).not.toContain("## Gate Decisions");
  });
});
