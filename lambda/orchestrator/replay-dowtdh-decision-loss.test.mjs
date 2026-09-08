import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractGateDecisions, appendDecisions } from "./artifact-chain.mjs";

/**
 * TEAM-4248 D3, acceptance 4 — the dowtdh run, replayed through the REAL
 * orchestrator (handleTicketDone → recordGateDecisions, then handleTicketReady →
 * handleHumanReviewGate → loadReviewPackage → attachPackageToTicket /
 * handleReviewRejection). Only the AWS SDK clients, workflow-store and `fetch`
 * are mocked; review-cap.mjs is the REAL one, so an enforced withhold reopens
 * TEAM-4177 down the same path a human's "Request changes" takes.
 *
 * What happened, from the dossier and the reviewer's F1 evidence:
 *   TEAM-4174 (Spec Approval)   the product owner resolved Concern 3 — "5000 ms
 *                               window; pause the countdown while Undo has focus
 *                               or hover" — and Concern 4.
 *   TEAM-4176 (Design Approval) the same owner restated Concern 3.
 *   TEAM-4175 / TEAM-4177       the design recommended the opposite and plan.md
 *                               wrote "Keep fixed 5000 ms; no focus-pause" under
 *                               "## Deviations: None yet.", citing TEAM-4174 zero
 *                               times.
 *   TEAM-4178 (Plan Approval)   the engineer APPROVED that plan at 22:45:27.665Z,
 *                               because the package they were shown never said a
 *                               decision had been dropped. The contradiction
 *                               surfaced 5 hours later as reviewer finding F1 P1
 *                               and fix ticket TEAM-4183.
 *
 * Every fixture here is that run's own record: the workflow row, the workflow def,
 * the six review-package bullets the engineer actually saw and the two events the
 * gate emitted all come out of dowtdh-dossier.json; plan.md is the real
 * 001fe322 blob. The one thing hand-authored is the two gate COMMENTS
 * (dowtdh-gate-decisions.json) — the dossier's tickets carry no `comments` key at
 * all, and that absence is the defect D3 fixes.
 */

const FIXTURES = "../../deploy/workflow-manager/toolkit/fixtures/";
const fixture = (name) => readFileSync(fileURLToPath(new URL(FIXTURES + name, import.meta.url)), "utf8");
const jsonFixture = (name) => JSON.parse(fixture(name));

const DOSSIER = jsonFixture("dowtdh-dossier.json");
const GATE_DECISIONS = jsonFixture("dowtdh-gate-decisions.json");
const PLAN_MD_ORIGINAL = fixture("dowtdh-plan-001fe322.md");
const PLAN_MD_POSTFIX = fixture("dowtdh-plan-postfix.md");

const WF = DOSSIER.workflowId;                      // wf_1788731227559_dowtdh
const EPIC = DOSSIER.epicId;                        // TEAM-4162
const SPEC_GATE = "TEAM-4174";
const DESIGN_GATE = "TEAM-4176";
const PLAN_TICKET = "TEAM-4177";
const PLAN_GATE = "TEAM-4178";
const IMPL_TICKET = "TEAM-4179";
const DEV = "agentcore_hub_frontend_dev";
const LEDGER_PATH = `.sdlc/${WF}/decisions.md`;
const MIRROR_KEY = `workflows/${WF}/shared/decisions.md`;
const PLAN_KEY = `workflows/${WF}/shared/plan.md`;
const PACKAGE_KEY = `workflows/${WF}/shared/review-package-plan.json`;

const ticketOf = (id) => DOSSIER.tickets.find((t) => t.ticketId === id);
const gateFixture = (id) => GATE_DECISIONS.gates.find((g) => g.gateTicketId === id);

/** The review_needed notification TEAM-4178 actually carried, and its package. */
const NOTIF = DOSSIER.workflow.humanNotifications.find(
  (n) => n.ticketId === PLAN_GATE && n.type === "review_needed"
);
const REVIEW_PACKAGE = { summary: NOTIF.summary, bullets: NOTIF.bullets, links: NOTIF.links };
// loadReviewPackage trims every bullet, and the run's own 200-char clamp left one
// of these ending mid-word on a space — so the trimmed forms are what a re-run of
// the same package produces.
const PACKAGE_BULLETS = NOTIF.bullets.map((b) => b.trim());
/** The two events the gate emitted, as the dossier recorded them. */
const dossierDetail = (type) =>
  DOSSIER.events.find((e) => e.type === type && e.detail?.ticketId === PLAN_GATE).detail;

/**
 * The ledger dowtdh never had, built from the gate comments through the same pure
 * helpers the orchestrator uses — so the `off` cases can be handed a populated
 * ledger without the record path having run.
 */
const LEDGER_MD = [SPEC_GATE, DESIGN_GATE].reduce((md, gateTicketId) => {
  const g = gateFixture(gateTicketId);
  return appendDecisions(md, extractGateDecisions(g.comments, {
    gateTicketId, gateName: g.gateName, reviewer: g.assignee,
  })).md;
}, "");
/** TEAM-4174#3, TEAM-4174#4, TEAM-4176#3 — every one open, none cited in plan.md. */
const OPEN_IDS = [`${SPEC_GATE}#3`, `${SPEC_GATE}#4`, `${DESIGN_GATE}#3`];

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    storeCalls: /** @type {string[]} */ ([]),
    /** Every ticket write, so "was TEAM-4178 ever commented on" is answerable. */
    updates: /** @type {{ ticketId: string, values: any }[]} */ ([]),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    s3Puts: /** @type {{ key: string, body: string }[]} */ ([]),
    gh: /** @type {{ method: string, path: string, body: any }[]} */ ([]),
    ghFiles: /** @type {Record<string, { text: string, sha: string }>} */ ({}),
    shaSeq: 0,
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
          if (name === "UpdateCommand") {
            const values = cmd.input.ExpressionAttributeValues || {};
            h.state.updates.push({ ticketId: cmd.input.Key?.ticketId, values });
            const row = h.state.tickets[cmd.input.Key?.ticketId];
            // Mirror the two writes these cases read back: the status transition
            // and attachPackageToTicket's appended comment.
            if (row && values[":s"]) row.status = values[":s"];
            if (row && Array.isArray(values[":n"])) row.comments = [...(row.comments || []), ...values[":n"]];
            return {};
          }
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession
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
    setResumeContext: vi.fn(async (wfId, ticketId, note) => {
      h.state.storeCalls.push("setResumeContext");
      return { wfId, ticketId, note };
    }),
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
    // The REAL review-cap runs, and it counts rounds off what the append
    // RETURNS — one recorded round is 1 of maxRounds 3, so rework proceeds.
    appendReviewRound: vi.fn(async (wfId, gateTicketId, round) => {
      h.state.storeCalls.push("appendReviewRound");
      return { rounds: [round], authorizations: [], escalations: [] };
    }),
    appendReviewAuthorization: call("appendReviewAuthorization"),
    appendReviewCapEscalation: call("appendReviewCapEscalation"),
  };
});

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "ghp_test";
process.env.REPO_CHECK_MODE = "off";

/** The live roster — the personas resolved here are the dossier's own. */
const AGENTS_CONFIG = readFileSync(
  fileURLToPath(new URL("../../src/config/agents.json", import.meta.url)), "utf8"
);

/**
 * dowtdh's own workflow def, with the ONE line D3 adds: decisions.md joins the
 * playbook chain as an orchestrator-owned artifact. Everything else — the gates,
 * their onReject policies, the chain dir — is the def the run executed under.
 */
const WORKFLOWS_CONFIG = (() => {
  const def = structuredClone(DOSSIER.workflowDef);
  const artifacts = def.frameworks.playbook.artifactChain.artifacts;
  const at = artifacts.findIndex((a) => a.name === "intent.md");
  artifacts.splice(at + 1, 0, { name: "decisions.md", owner: "orchestrator" });
  return JSON.stringify({ workflows: [def] });
})();

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

/** index.mjs snapshots DECISION_LEDGER at module load, so every mode re-imports. */
async function load(mode, { gateGuard = "enforce" } = {}) {
  if (mode === undefined) delete process.env.DECISION_LEDGER;
  else process.env.DECISION_LEDGER = mode;
  process.env.GATE_STATE_GUARD = gateGuard;
  h.state.s3Objects["config/agents.json"] = AGENTS_CONFIG;
  h.state.s3Objects["config/workflows.json"] = WORKFLOWS_CONFIG;
  vi.resetModules();
  const mod = await import("./index.mjs");
  ({ handler, handleTicketDone } = mod);
  await mod.handler({ Records: [] }); // primes roster / defs / registry caches
  reset();
  return mod;
}

function reset() {
  h.state.events.length = 0;
  h.state.storeCalls.length = 0;
  h.state.updates.length = 0;
  h.state.s3Gets.length = 0;
  h.state.s3Puts.length = 0;
  h.state.gh.length = 0;
}

const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const detailOf = (e) => (typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail);
const ghCalls = (method) => h.state.gh.filter((c) => c.method === method && contentsPathOf(c.path));
const commentsOn = (ticketId) => (h.state.tickets[ticketId]?.comments || []).map((c) => c.content);
const notificationFor = async (ticketId) => {
  const store = await import("./workflow-store.mjs");
  const call = store.appendReviewNotificationOnce.mock.calls.find((c) => c[1] === ticketId);
  return call?.[2] || null;
};

/**
 * The board as it stood at 22:41:47Z, when TEAM-4178 went ready: the spec and
 * design gates and the plan ticket done, the plan gate ready, the implementation
 * ticket blocked behind it. Replaying the two earlier gate approvals against this
 * board records their decisions without re-dispatching anything (both successors
 * are already done), which is exactly what a webhook redelivery would do.
 */
function setBoard() {
  const row = (id, extra = {}) => ({ ...structuredClone(ticketOf(id)), ...extra });
  h.state.tickets = {
    [SPEC_GATE]: row(SPEC_GATE, { comments: structuredClone(gateFixture(SPEC_GATE).comments) }),
    [DESIGN_GATE]: row(DESIGN_GATE, { comments: structuredClone(gateFixture(DESIGN_GATE).comments) }),
    [PLAN_TICKET]: row(PLAN_TICKET),
    [PLAN_GATE]: row(PLAN_GATE, { status: "ready" }),
    [IMPL_TICKET]: row(IMPL_TICKET, { status: "blocked" }),
  };
  h.state.children = Object.values(h.state.tickets).map((t) => ({
    ticketId: t.ticketId, parentId: EPIC, workflowId: WF,
    assignee: t.assignee, status: t.status, blockedBy: t.blockedBy || [],
  }));
}

/**
 * dowtdh's own workflow row, wound back to the gate moment: the run was mid
 * development with no PR and no notification yet. The dossier row is its final
 * state (phase "complete", delivery set), which would send the rejection path
 * looking for a PR diff that did not exist at 22:41.
 */
function setWorkflow(extra = {}) {
  const row = structuredClone(DOSSIER.workflow);
  delete row.delivery;
  delete row.completedAt;
  delete row.finalizedAt;
  h.state.workflow = { ...row, phase: "development", humanNotifications: [], ...extra };
}

/** A DDB-stream MODIFY moving the Plan Approval gate to `ready` — page the human. */
const readyEvent = () => ({
  Records: [{
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: PLAN_GATE }, status: { S: "ready" },
        assignee: { S: ticketOf(PLAN_GATE).assignee },
        workflowId: { S: WF }, parentId: { S: EPIC }, type: { S: "task" },
        title: { S: ticketOf(PLAN_GATE).title }, blockedBy: { L: [{ S: PLAN_TICKET }] },
      },
      OldImage: { ticketId: { S: PLAN_GATE }, status: { S: "blocked" } },
    },
  }],
});

/** The engineer's approval of TEAM-4178 — the click that lost the decision. */
const approvalImage = (ticketId) => ({
  ...structuredClone(ticketOf(ticketId)),
  status: "done",
  comments: structuredClone(gateFixture(ticketId)?.comments || []),
});

/**
 * Replay the two gate approvals that CARRIED the decisions, so the ledger under
 * test is the one the real record path wrote (not a hand-built string).
 */
async function recordBothGates() {
  await handleTicketDone(SPEC_GATE, approvalImage(SPEC_GATE));
  await handleTicketDone(DESIGN_GATE, approvalImage(DESIGN_GATE));
}

beforeEach(() => {
  setBoard();
  setWorkflow();
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    [PLAN_KEY]: PLAN_MD_ORIGINAL,
    [PACKAGE_KEY]: JSON.stringify(REVIEW_PACKAGE),
  };
  h.state.ghFiles = {};
  h.state.shaSeq = 0;
  installFetch();
  reset();
});

afterEach(() => {
  delete process.env.DECISION_LEDGER;
  delete process.env.GATE_STATE_GUARD;
  vi.restoreAllMocks();
});

describe("DECISION_LEDGER=off — dowtdh happens again, byte for byte", () => {
  it("TEAM-4178 is presented and approved with the dossier's own event shapes", async () => {
    await load("off");
    // A ledger exists in S3 (an operator flipped the flag back off): off must not
    // read it, let alone act on it.
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD;

    await handler(readyEvent());
    const needed = eventsOf("review.needed");
    expect(needed).toHaveLength(1);
    expect(detailOf(needed[0])).toMatchObject({
      workflowId: WF, ticketId: PLAN_GATE, reviewer: dossierDetail("review.needed").reviewer,
    });

    // The package the engineer actually saw, reproduced from the run's own bullets.
    const notification = await notificationFor(PLAN_GATE);
    expect(notification).toMatchObject({
      type: "review_needed", title: NOTIF.title, gate: NOTIF.gate,
      summary: NOTIF.summary, details: NOTIF.details, bullets: PACKAGE_BULLETS, links: NOTIF.links,
      reviewer: NOTIF.reviewer,
    });
    // Nothing about a dropped decision reaches the reviewer — the defect itself.
    expect(commentsOn(PLAN_GATE).join("\n")).not.toContain("Decisions not honoured");

    // ...and then it is approved, unblocking the implementation ticket.
    h.state.tickets[PLAN_GATE].status = "done";
    h.state.children.find((c) => c.ticketId === PLAN_GATE).status = "done";
    await handleTicketDone(PLAN_GATE, approvalImage(PLAN_GATE));
    const complete = eventsOf("agent.complete").find((e) => detailOf(e).ticketId === PLAN_GATE);
    const detail = detailOf(complete);
    expect(detail).toMatchObject({
      assignee: "human:engineer", agentId: "human:engineer",
      ticketId: PLAN_GATE, workflowId: WF, unblocked: [IMPL_TICKET],
    });
    // The only fields beyond the ones the dossier's own event carried are D1's
    // verdict enrichment (TEAM-4246, after dowtdh ran) — D3 under `off` adds none.
    expect(Object.keys(detail).sort()).toEqual(
      [...Object.keys(dossierDetail("agent.complete")), "verdict", "verdictSource", "spawnedTickets", "testedHead"].sort()
    );
  });

  it("costs nothing: no GitHub call, no ledger read, no decision event", async () => {
    await load("off");
    h.state.s3Objects[MIRROR_KEY] = LEDGER_MD;
    await recordBothGates();
    await handler(readyEvent());
    expect(h.state.gh, "off must not talk to GitHub at all").toHaveLength(0);
    expect(h.state.s3Gets).not.toContain(MIRROR_KEY);
    expect(h.state.s3Puts.map((p) => p.key)).not.toContain(MIRROR_KEY);
    expect(h.state.events.filter((e) => String(e.type).startsWith("decision."))).toHaveLength(0);
  });
});

describe("the ledger the run never had", () => {
  it("both gate approvals commit their decisions to the run's own branch", async () => {
    await load("shadow");
    await recordBothGates();

    // One commit per gate, on the run's feature branch, at the chain path.
    expect(ghCalls("PUT")).toHaveLength(2);
    for (const put of ghCalls("PUT")) {
      expect(contentsPathOf(put.path)).toBe(LEDGER_PATH);
      expect(put.body.branch).toBe(DOSSIER.workflow.featureBranch);
    }
    const md = h.state.ghFiles[LEDGER_PATH].text;
    for (const id of OPEN_IDS) expect(md).toContain(`### ${id}`);
    expect(md).toContain("5000 ms window; pause the countdown while Undo has focus or hover.");
    // The design lead's "LGTM on the DOM and the tokens." is not a decision.
    expect(md).not.toContain("LGTM");
    // The S3 mirror is what the gate check and the dispatch checklist read.
    expect(h.state.s3Objects[MIRROR_KEY]).toBe(md);

    const ids = eventsOf("decision.recorded").flatMap((e) => detailOf(e).ids);
    expect(ids).toEqual(OPEN_IDS);
  });
});

describe("TEAM-4178 package lists Concern 3 as not honoured", () => {
  it("shadow presents the same gate, with the dropped decisions at the front", async () => {
    await load("shadow");
    await recordBothGates();
    reset();
    await handler(readyEvent());

    // The gate is still the human's to decide: shadow withholds nothing.
    expect(h.state.storeCalls).toContain("appendReviewNotificationOnce");
    expect(h.state.storeCalls).toContain("markGateRequested");
    expect(eventsOf("review.needed")).toHaveLength(1);
    expect(eventsOf("decision.gate_withheld")).toHaveLength(0);
    expect(detailOf(eventsOf("decision.unhonoured_observed")[0])).toMatchObject({
      gateTicketId: PLAN_GATE, phase: "plan", mode: "shadow", ids: OPEN_IDS,
    });

    const notification = await notificationFor(PLAN_GATE);
    expect(notification.summary).toMatch(/^Decisions not honoured \(3\)/);
    // Concern 3 leads, by id, in ≤200 chars — the bullet contract.
    expect(notification.bullets[0]).toContain(`${SPEC_GATE}#3`);
    expect(notification.bullets[0]).toContain("pause the countdown while Undo has focus or hover");
    for (const b of notification.bullets) expect(b.length).toBeLessThanOrEqual(200);
    // Prepended AFTER loadReviewPackage's clamp: all six of the engineer's own
    // bullets survive, in order, and the links are untouched.
    expect(notification.bullets.slice(3)).toEqual(PACKAGE_BULLETS);
    expect(notification.links).toEqual(NOTIF.links);

    // The reviewer opening the ticket sees the same thing the phone ping said.
    const comment = commentsOn(PLAN_GATE).find((c) => c.startsWith("Review package —"));
    expect(comment).toContain("Decisions not honoured (3)");
    expect(comment).toContain(`${SPEC_GATE}#3`);
    expect(comment).toContain(PACKAGE_BULLETS[0]);
  });

  it("enforce never presents it: the plan goes back to TEAM-4177 and no human is paged", async () => {
    await load("enforce");
    await recordBothGates();
    reset();
    await handler(readyEvent());

    // Nothing paged a human, and no gate cycle was opened for a gate we withheld.
    expect(h.state.storeCalls).not.toContain("appendReviewNotificationOnce");
    expect(h.state.storeCalls).not.toContain("markGateRequested");
    expect(h.state.storeCalls).not.toContain("markGateRejected");
    expect(eventsOf("review.needed")).toHaveLength(0);
    expect(h.state.workflow.gateStates).toBeUndefined();
    expect(commentsOn(PLAN_GATE).join("\n")).not.toContain("Review package —");

    expect(detailOf(eventsOf("decision.gate_withheld")[0])).toMatchObject({
      workflowId: WF, gateTicketId: PLAN_GATE, phase: "plan", ids: OPEN_IDS,
    });

    // Rework, down the path a human's "Request changes" already takes: the plan
    // ticket is re-opened with the unhonoured decisions as its resume context.
    const rejected = eventsOf("review.rejected");
    expect(rejected).toHaveLength(1);
    expect(detailOf(rejected[0])).toMatchObject({
      ticketId: PLAN_GATE, onReject: "rework", reopened: [PLAN_TICKET], workflowId: WF,
    });
    const store = await import("./workflow-store.mjs");
    const [, resumedTicket, resumeNote] = store.setResumeContext.mock.calls.at(-1);
    expect(resumedTicket).toBe(PLAN_TICKET);
    expect(resumeNote).toContain(`${SPEC_GATE}#3`);
    expect(resumeNote).toContain("## Deviations");
    expect(resumeNote).toContain("5000 ms window; pause the countdown while Undo has focus or hover.");

    const reopen = h.state.updates.find((u) => u.ticketId === PLAN_TICKET && u.values[":s"] === "todo");
    expect(reopen, "TEAM-4177 is the ticket that wrote the plan").toBeTruthy();
    expect(reopen.values[":sb"]).toEqual({ gateTicketId: PLAN_GATE, kind: "review_fix" });
    expect(reopen.values[":ph"]).toBe("development");
  });

  it("the post-fix plan passes the same gate untouched, in both non-off modes", async () => {
    for (const mode of ["shadow", "enforce"]) {
      setBoard();
      setWorkflow();
      h.state.s3Objects[PLAN_KEY] = PLAN_MD_POSTFIX;
      await load(mode);
      await recordBothGates();
      reset();
      await handler(readyEvent());

      // Every open decision is cited — by id, or by gate key plus concern number.
      expect(h.state.events.filter((e) => String(e.type).startsWith("decision.")), mode).toHaveLength(0);
      expect(eventsOf("review.needed"), mode).toHaveLength(1);
      const notification = await notificationFor(PLAN_GATE);
      expect(notification.summary, mode).toBe(NOTIF.summary);
      expect(notification.bullets, mode).toEqual(PACKAGE_BULLETS);
    }
  });
});
