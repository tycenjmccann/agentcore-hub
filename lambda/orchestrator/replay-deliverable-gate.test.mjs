import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * DL-035 replays through the REAL index.mjs, from the production rows:
 *
 *   33rea7 / f7jj7j — dead-code sweeps that found nothing. Both paged a human
 *     Merge Approval (review.needed + a Telegram gate.requested) for a PR that
 *     never existed. With the gate's condition deliverable_present(kind=pr), the
 *     orchestrator writes its own skip record (workflowId, evidence_kind
 *     "skipped", reason deliverable_absent) BEFORE resolving the gate Done, and
 *     nobody is paged. A PR URL, an unknown predicate or a failed skip-record
 *     write all page exactly as before.
 *   1ykx9f — the run that closed under open human tickets. Completion now holds
 *     while a non-follow-up human ticket is open; human follow-ups do not block.
 *
 * Tickets are rebuilt from the run's own ticket.created events. Those events do
 * not carry blockedBy, so the one edge the gate path reads — Merge Approval is
 * blocked by the "Ship:" ticket — is set here. Only the I/O seams are mocked
 * (AWS SDK clients, workflow-store), as in cd-handoff.test.mjs; the config is the
 * repo's real workflows.json + agents.json.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const repoFile = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    failPut: /** @type {RegExp | null} */ (null),
    failGet: /** @type {RegExp | null} */ (null),
    ops: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    completions: /** @type {any[]} */ ([]),
    deliveries: /** @type {any[]} */ ([]),
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
          if (name === "ScanCommand") return { Items: [] };
          if (name === "UpdateCommand") {
            const s = cmd.input.ExpressionAttributeValues?.[":s"];
            const t = h.state.tickets[cmd.input.Key?.ticketId];
            if (s && String(cmd.input.UpdateExpression).includes("#s = :s")) {
              h.state.ops.push({ op: "status", ticketId: cmd.input.Key?.ticketId, status: s });
              if (t) t.status = s;
            }
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
  LambdaClient: class {
    async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) }; }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") {
        if (h.state.failPut?.test(cmd.input.Key)) throw new Error("AccessDenied");
        h.state.ops.push({ op: "put", key: cmd.input.Key });
        h.state.s3Objects[cmd.input.Key] = cmd.input.Body;
        return {};
      }
      if (name !== "GetObjectCommand") return {};
      h.state.ops.push({ op: "get", key: cmd.input.Key });
      if (h.state.failGet?.test(cmd.input.Key)) {
        const e = new Error("Access Denied"); e.name = "AccessDenied"; e.$metadata = { httpStatusCode: 403 }; throw e;
      }
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) { const e = new Error("The specified key does not exist."); e.name = "NoSuchKey"; throw e; }
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
  claimInvocation: vi.fn(async () => true),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => true),
  adoptFeatureBranch: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  appendReviewNotificationOnce: vi.fn(async (wfId, tid, n) => { h.state.notifications.push(n); return true; }),
  appendNotification: vi.fn(async (wfId, n) => { h.state.notifications.push(n); }),
  ackNotifications: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async (id, ts) => { h.state.completions.push({ id, ts }); return true; }),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setDelivery: vi.fn(async (id, d) => { h.state.deliveries.push({ id, d }); }),
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";
process.env.SHIP_MERGE_VERIFY = "off";

const REGISTRY = JSON.stringify({
  version: 1,
  repos: [
    { repo: "tycenjmccann/juno", pipeline: "hub-juno-deploy", region: "us-west-2" },
    { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-west-2" },
  ],
});

const RM = "agentcore_hub_release_manager";
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const statusOps = (ticketId, status) => h.state.ops.filter((o) => o.op === "status" && o.ticketId === ticketId && o.status === status);

let handler, completeWorkflow, isWorkflowComplete;

async function load(workflowsConfig = repoFile("src/config/workflows.json")) {
  h.state.s3Objects = {
    "config/agents.json": repoFile("src/config/agents.json"),
    "config/workflows.json": workflowsConfig,
    "config/cd-registry.json": REGISTRY,
  };
  vi.resetModules();
  ({ handler, completeWorkflow, isWorkflowComplete } = await import("./index.mjs"));
  await handler({ Records: [] }); // primes roster / defs / registry caches
}

/** The run as it stood when its last ship blocker closed: not terminal, no stamps. */
function liveRow(id) {
  const { completedAt, finalizedAt, delivery, ...row } = fixture(`workflow-${id}.json`);
  return { ...row, id: row.id || row.workflowId, phase: "ship", humanNotifications: [] };
}

/** Tickets from the run's ticket.created events (first sighting wins), all Done. */
function ticketsOf(id, workflow) {
  const out = {};
  for (const e of fixture(`events-${id}.json`)) {
    if (e.type !== "ticket.created" || !e.detail?.ticket) continue;
    const t = e.detail.ticket;
    if (out[t.id]) continue;
    out[t.id] = {
      ticketId: t.id, parentId: workflow.epicId, workflowId: workflow.id, type: "task",
      assignee: t.assignee, title: t.title, labels: t.labels || [], status: "done", blockedBy: [],
    };
  }
  return out;
}

/** The labels intake-materialize stamps on a def gate (src/lib/workflow/intake-materialize.ts emitGate). */
const MATERIALIZED_GATE_LABELS = ["wfdef:dead-code-sweep", "phase:ship", "gate:merge-approval"];

/** Sweep run with its Merge Approval gate just Ready (blocked by the Ship ticket). */
function sweepAtGate(id) {
  const workflow = liveRow(id);
  const tickets = ticketsOf(id, workflow);
  const all = Object.values(tickets);
  const gate = all.find((t) => t.assignee.startsWith("human:") && /^Merge Approval/.test(t.title));
  const ship = all.find((t) => t.assignee === RM && /^Ship:/.test(t.title));
  gate.status = "ready";
  // The run's ticket.created events carry no labels, so the gate gets the ones it
  // was materialized with (TEAM-5336 F4: the real `gate:<slug>` form, not a stand-in).
  gate.labels = gate.labels.length ? gate.labels : [...MATERIALIZED_GATE_LABELS];
  gate.blockedBy = [ship.ticketId];
  h.state.workflow = workflow;
  h.state.tickets = tickets;
  h.state.children = all;
  return { workflow, gate, ship };
}

function readyRecord(ticketId) {
  const t = h.state.tickets[ticketId];
  return {
    Records: [{
      eventName: "MODIFY",
      dynamodb: {
        NewImage: { ticketId, status: "ready", assignee: t.assignee, parentId: t.parentId, workflowId: t.workflowId, type: "task", blockedBy: [] },
        OldImage: { ticketId, status: "blocked" },
      },
    }],
  };
}

beforeEach(() => {
  h.state.ops.length = 0;
  h.state.events.length = 0;
  h.state.notifications.length = 0;
  h.state.completions.length = 0;
  h.state.deliveries.length = 0;
  h.state.failPut = null;
  h.state.failGet = null;
});

for (const id of ["33rea7", "f7jj7j"]) {
  describe(`${id} replay — deliverable_present(kind=pr) Merge Approval`, () => {
    it("no PR: skip record (workflowId, skipped, deliverable_absent) BEFORE Done; never paged", async () => {
      await load();
      const { workflow, gate } = sweepAtGate(id);
      await handler(readyRecord(gate.ticketId));

      const key = `completions/${gate.ticketId}.json`;
      expect(JSON.parse(h.state.s3Objects[key])).toMatchObject({
        ticketId: gate.ticketId,
        workflowId: workflow.id,
        evidence_kind: "skipped",
        skipped: true,
        reason: "deliverable_absent",
      });
      const putAt = h.state.ops.findIndex((o) => o.op === "put" && o.key === key);
      const doneAt = h.state.ops.findIndex((o) => o.op === "status" && o.ticketId === gate.ticketId && o.status === "done");
      expect(putAt).toBeGreaterThanOrEqual(0);
      expect(doneAt).toBeGreaterThan(putAt);

      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(0);
      expect(eventsOf("review.needed")).toHaveLength(0);
      expect(h.state.notifications).toHaveLength(0);
      expect(eventsOf("gate.skipped")).toHaveLength(1);
      expect(eventsOf("gate.skipped")[0].detail).toMatchObject({ ticketId: gate.ticketId, reason: "deliverable_absent", phase: "ship" });
    });

    it("with a PR URL on a task, the gate pages as today", async () => {
      await load();
      const { workflow, gate, ship } = sweepAtGate(id);
      workflow.agentTasks[ship.ticketId] = { ...workflow.agentTasks[ship.ticketId], prUrl: "https://github.com/o/r/pull/7" };
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
      expect(eventsOf("review.needed")).toHaveLength(1);
      expect(h.state.s3Objects[`completions/${gate.ticketId}.json`]).toBeUndefined();
    });

    it("a PR URL only on a blocker's completion record still pages (harvest race closed)", async () => {
      await load();
      const { gate, ship } = sweepAtGate(id);
      h.state.s3Objects[`completions/${ship.ticketId}.json`] = JSON.stringify({ ticketId: ship.ticketId, pr_url: "https://github.com/o/r/pull/9" });
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
    });

    it("an unknown predicate pages", async () => {
      const cfg = JSON.parse(repoFile("src/config/workflows.json"));
      cfg.workflows.find((w) => w.id === "dead-code-sweep").reviewGates[0].condition = "deliverable_present(kind=zip)";
      await load(JSON.stringify(cfg));
      const { gate } = sweepAtGate(id);
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
      expect(eventsOf("gate.skipped")).toHaveLength(0);
    });

    it("a failed skip-record write pages as today (and never resolves the gate)", async () => {
      await load();
      const { gate } = sweepAtGate(id);
      h.state.failPut = /^completions\//;
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
    });

    it("real materialized gate:merge-approval label is skipped when no PR (TEAM-5336 F4)", async () => {
      await load();
      const { gate } = sweepAtGate(id);
      expect(gate.labels).toEqual(MATERIALIZED_GATE_LABELS);
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "done")).toHaveLength(1);
      expect(eventsOf("gate.skipped")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(0);
    });

    for (const typed of ["gate-deploy-approval", "gate-ci-unavailable", "gate:approval"]) {
      it(`a typed gate (${typed}) is never skipped — pages (TEAM-5336 F4)`, async () => {
        await load();
        const { gate } = sweepAtGate(id);
        gate.labels = [...MATERIALIZED_GATE_LABELS, typed];
        await handler(readyRecord(gate.ticketId));
        expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
        expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
        expect(eventsOf("review.needed")).toHaveLength(1);
        expect(eventsOf("gate.skipped")).toHaveLength(0);
        expect(h.state.s3Objects[`completions/${gate.ticketId}.json`]).toBeUndefined();
      });
    }

    it("completion record read AccessDenied → gate pages, no skip record, no gate.skipped (TEAM-5336 F5)", async () => {
      await load();
      const { gate, ship } = sweepAtGate(id);
      h.state.failGet = new RegExp(`^completions/${ship.ticketId}\\.json$`);
      await handler(readyRecord(gate.ticketId));
      expect(h.state.ops.some((o) => o.op === "get" && o.key === `completions/${ship.ticketId}.json`)).toBe(true);
      expect(h.state.s3Objects[`completions/${gate.ticketId}.json`]).toBeUndefined();
      expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
      expect(eventsOf("gate.skipped")).toHaveLength(0);
    });

    it("completion record NoSuchKey → treated as absent (skip proceeds) (TEAM-5336 F5)", async () => {
      await load();
      const { gate, ship } = sweepAtGate(id);
      expect(h.state.s3Objects[`completions/${ship.ticketId}.json`]).toBeUndefined();
      await handler(readyRecord(gate.ticketId));
      expect(h.state.ops.some((o) => o.op === "get" && o.key === `completions/${ship.ticketId}.json`)).toBe(true);
      expect(JSON.parse(h.state.s3Objects[`completions/${gate.ticketId}.json`])).toMatchObject({ skipped: true });
      expect(eventsOf("gate.skipped")).toHaveLength(1);
    });

    it("completion: delivery outcome empty_sweep with no prState, and workflow.complete carries it", async () => {
      await load();
      const { workflow } = sweepAtGate(id);
      await completeWorkflow(workflow);
      expect(h.state.deliveries).toHaveLength(1);
      expect(h.state.deliveries[0].d.outcome).toBe("empty_sweep");
      expect(h.state.deliveries[0].d).not.toHaveProperty("prState");
      const done = eventsOf("workflow.complete");
      expect(done).toHaveLength(1);
      expect(done[0].detail.outcome).toBe("empty_sweep");
    });
  });
}

/**
 * TEAM-5336 F6 — the same skip in Jira mode, where the Done hop can be refused
 * (jiraTransition returns false, never throws). index.mjs snapshots
 * TICKET_PROVIDER at load, so this suite re-imports in Jira mode and serves the
 * run's tickets as Jira issues by URL (the gate-state-guard.test.mjs harness).
 */
describe("Jira mode — a failed Done transition is not a skip (TEAM-5336 F6)", () => {
  const ORIGINAL_FETCH = global.fetch;
  const TRANSITIONS = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "41", name: "In Review", to: { name: "In Review" } },
  ];
  const STATUS_NAME = { ready: "Ready", done: "Done", in_review: "In Review", blocked: "Blocked", todo: "To Do" };
  /** @type {{ key: string, transition: string, ok: boolean }[]} */
  let posts;
  const asIssue = (t) => ({
    key: t.ticketId,
    fields: {
      summary: t.title,
      status: { name: STATUS_NAME[t.status] || "Done" },
      labels: [
        ...(t.labels || []),
        `wf:${t.workflowId}`,
        t.assignee.startsWith("human:") ? `reviewer:${t.assignee.slice("human:".length)}` : `agent:${t.assignee}`,
      ],
      issuetype: { name: "Task" },
      parent: { key: t.parentId },
      issuelinks: (t.blockedBy || []).map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
      comment: { comments: [] },
    },
  });
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });

  beforeEach(() => {
    posts = [];
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
    global.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/rest/api/3/search/jql")) return jsonResp({ issues: Object.values(h.state.tickets).map(asIssue), isLast: true });
      const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if ((init.method || "GET") === "GET") return jsonResp({ transitions: TRANSITIONS });
        const transition = JSON.parse(init.body).transition.id;
        const ok = transition !== "31"; // Jira refuses the Done hop
        posts.push({ key, transition, ok });
        if (ok && h.state.tickets[key]) h.state.tickets[key].status = "in_review";
        return ok ? { ok: true, status: 204, text: async () => "" } : { ok: false, status: 500, text: async () => "boom" };
      }
      if (sub === "/comment") return jsonResp({}, 201);
      return h.state.tickets[key] ? jsonResp(asIssue(h.state.tickets[key])) : { ok: false, status: 404, text: async () => "not found" };
    });
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    delete process.env.TICKET_PROVIDER;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it("failed Jira Done transition → no gate.skipped, gate pages, skip record retracted (skip_not_applied)", async () => {
    await load();
    const { workflow, gate } = sweepAtGate("33rea7");
    await handler({ source: "jira-webhook", ticketId: gate.ticketId, newStatus: "ready", oldStatus: "blocked" });

    expect(posts.filter((p) => p.key === gate.ticketId).map((p) => [p.transition, p.ok])).toEqual([["31", false], ["41", true]]);
    expect(eventsOf("gate.skipped")).toHaveLength(0);
    expect(eventsOf("review.needed")).toHaveLength(1);
    // Written before the hop, then overwritten: nothing reads it as a skip any more.
    const key = `completions/${gate.ticketId}.json`;
    expect(h.state.ops.filter((o) => o.op === "put" && o.key === key)).toHaveLength(2);
    expect(JSON.parse(h.state.s3Objects[key])).toEqual({
      ticketId: gate.ticketId, workflowId: workflow.id, evidence_kind: "skip_not_applied", skipped: false, reason: "done_transition_failed",
    });
  });
});

describe("1ykx9f replay — an open human ticket holds completion (TEAM-4954)", () => {
  function atClose() {
    const workflow = liveRow("1ykx9f");
    workflow.phase = "verification";
    const tickets = ticketsOf("1ykx9f", workflow);
    h.state.workflow = workflow;
    h.state.tickets = tickets;
    h.state.children = Object.values(tickets);
    return { workflow, tickets };
  }
  const DEV = "agentcore_hub_backend_dev";

  it("every ticket Done → complete (the control)", async () => {
    await load();
    const { workflow } = atClose();
    expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(true);
  });

  it("no completion while the non-follow-up human ticket (TEAM-4939 escalation) is open", async () => {
    await load();
    const { workflow, tickets } = atClose();
    for (const status of ["ready", "in_review"]) {
      tickets["TEAM-4939"].status = status;
      expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(false);
    }
  });

  it("human follow-ups ([fu:] title — TEAM-4931, TEAM-4954) do not block", async () => {
    await load();
    const { workflow, tickets } = atClose();
    expect(tickets["TEAM-4954"].title).toMatch(/\[fu:[0-9a-f]{8}\]\s*$/);
    tickets["TEAM-4931"].status = "ready";
    tickets["TEAM-4954"].status = "in_review";
    expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(true);
  });
});
