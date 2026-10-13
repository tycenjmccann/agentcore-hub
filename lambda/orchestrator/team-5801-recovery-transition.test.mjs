import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-5801 — the reconcile sweep's todo/blocked branch and the release-manager
 * escalation-gate wake recovered an agent through the bare redispatchTicket,
 * which claims and invokes but never moves the board to In Progress. The
 * recovered session then ran outside the in_progress lifecycle (self-park claim
 * release, harness park, dead-session detector, retry budget): a blocked ticket
 * whose agent kept dying was re-invoked every 2×TTL forever, never escalated.
 * TEAM-5791 fixed the ready branch only. Now every agent recovery goes through
 * the full Ready handler, and on Jira a todo/blocked recovery whose board has no
 * → In Progress transition is refused (claim released) instead of invoked.
 *
 * Harness: the TEAM-5791 one (stale-ready-claim-recovery.test.mjs) — index.mjs
 * imported for real at the deployed config, AWS SDK + workflow-store faked
 * statefully with the real CAS predicates, only Date faked. `order` records
 * board writes and invokes in sequence so "transition BEFORE invoke" is pinned.
 */

const h = vi.hoisted(() => ({
  state: {
    workflow: /** @type {any} */ (null),
    tickets: /** @type {Record<string, any>} */ ({}),
    heartbeats: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    invokes: /** @type {any[]} */ ([]),
    ticketStatusWrites: /** @type {any[]} */ ([]),
    jiraPosts: /** @type {any[]} */ ([]),
    order: /** @type {string[]} */ ([]),
    cdRegistry: /** @type {string|null} */ (null),
  },
}));

const ccf = () => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class C { constructor(input) { this.input = input; } }
  class GetCommand extends C {}
  class PutCommand extends C {}
  class UpdateCommand extends C {}
  class QueryCommand extends C {}
  class ScanCommand extends C {}
  const send = async (cmd) => {
    const { input } = cmd;
    const name = cmd.constructor.name;
    if (name === "PutCommand") { h.state.events.push(input.Item); return {}; }
    if (name === "GetCommand") return { Item: h.state.tickets[input.Key?.ticketId] || null };
    if (name === "ScanCommand") return { Items: h.state.workflow ? [h.state.workflow] : [] };
    if (name === "QueryCommand") {
      if (input.IndexName === "parentId-index") {
        const pid = input.ExpressionAttributeValues[":pid"];
        return { Items: Object.values(h.state.tickets).filter((t) => t.parentId === pid) };
      }
      if (input.IndexName === "epicId-index") return { Items: h.state.workflow ? [h.state.workflow] : [] };
      if (input.TableName === "agentcore-hub-events") {
        const v = input.ExpressionAttributeValues;
        if (v[":hb1"]) {
          return { Items: h.state.heartbeats.filter((e) => [v[":hb1"], v[":hb2"]].includes(e.type) && e.detail.agentId === v[":aid"] && e.timestamp >= v[":cutoff"]) };
        }
      }
      return { Items: [] };
    }
    if (name === "UpdateCommand") {
      // The DDB-mode ticket-row write (Ready handler: CAS on status <> in_progress).
      if (input.TableName === "agentcore-hub-tickets" && input.ExpressionAttributeValues?.[":s"]) {
        const t = h.state.tickets[input.Key.ticketId];
        const v = input.ExpressionAttributeValues;
        if (input.ConditionExpression && (t.status === v[":inprog"] || t.status === v[":cancelled"])) throw ccf();
        t.status = v[":s"];
        if (v[":u"]) t.updatedAt = v[":u"];
        h.state.ticketStatusWrites.push({ ticketId: input.Key.ticketId, status: v[":s"] });
        h.state.order.push(`board:${input.Key.ticketId}:${v[":s"]}`);
        return {};
      }
      // lease.mjs stealClaim — CAS on the inspected generation.
      if (input.TableName === "agentcore-hub-workflows" && input.UpdateExpression === "SET agentTasks.#tid.#st = :ready") {
        const task = h.state.workflow.agentTasks[input.ExpressionAttributeNames["#tid"]];
        const v = input.ExpressionAttributeValues;
        if (!task || ![v[":running"], v[":inprog"]].includes(task.status) || task.startedAt !== v[":exp"]) throw ccf();
        task.status = "ready";
        return {};
      }
      return {};
    }
    return {};
  };
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      if (cmd.input.FunctionName === "agentcore-hub-agent-invoker") {
        const p = JSON.parse(cmd.input.Payload);
        h.state.invokes.push(p);
        h.state.order.push(`invoke:${p.ticketId}`);
      }
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name === "GetObjectCommand" && cmd.input.Key === "config/cd-registry.json" && h.state.cdRegistry) {
        return { Body: { transformToString: async () => h.state.cdRegistry } };
      }
      if (cmd.constructor.name === "GetObjectCommand") throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      return {};
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

// In-memory workflow store with the real store's claim predicate: free unless a
// RUNNING claim younger than staleBefore holds the slot. Synchronous between the
// check and the write, so concurrent claimers are serialized like the CAS.
vi.mock("./workflow-store.mjs", () => {
  const wf = () => h.state.workflow;
  const tasks = () => (wf().agentTasks ||= {});
  const known = {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (wf()?.id === id ? wf() : null)),
    claimInvocation: vi.fn(async (_id, tid, entry, staleBefore) => {
      const cur = tasks()[tid];
      const ok = !cur || cur.status !== "running" || (cur.startedAt || "") < staleBefore;
      if (ok) { const { deadSessionDetectedAt: _s, ...task } = entry; tasks()[tid] = { ...task }; }
      return ok;
    }),
    setTaskStatus: vi.fn(async (_id, tid, status) => { if (tasks()[tid]) tasks()[tid].status = status; }),
    incrementDeadSessionRetry: vi.fn(async (_id, tid) => {
      const r = (wf().deadSessionRetries ||= {});
      r[tid] = (r[tid] || 0) + 1;
      return r[tid];
    }),
    advancePhase: vi.fn(async (_id, phase) => { wf().phase = phase; return true; }),
    appendEscalationOnce: vi.fn(async () => true),
    claimTerminalOutcome: vi.fn(async () => false),
    claimFinalization: vi.fn(async () => false),
  };
  return new Proxy(known, {
    get: (t, k) => (k === "then" || typeof k === "symbol" ? undefined : k in t ? t[k] : (t[k] = vi.fn(async () => true))),
  });
});

const DEV = "agentcore_hub_backend_dev";
const MIN = 60_000;
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (min) => new Date(Date.now() - min * MIN).toISOString();
const sweep = () => mod.handler({ source: "orchestrator.sweep", action: "reconcile_sweep" });
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);

let mod;
async function load(env) {
  for (const k of ["TICKET_PROVIDER", "JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "RECONCILE_SWEEP_MODE", "DEAD_SESSION_DETECTOR_MODE", "WORKFLOW_LEASE_TTL_MINUTES"]) delete process.env[k];
  // Deployed config: reconcile sweep enforce, dead-session detector at its default.
  Object.assign(process.env, { ARTIFACT_BUCKET: "test-bucket", RECONCILE_SWEEP_MODE: "enforce", [`RUNTIME_ARN_${DEV.toUpperCase()}`]: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/dev", ...env });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  vi.resetModules();
  mod = await import("./index.mjs");
}

/** T-2 Ready (its blocker T-3 done, Readied `parkedMin` ago), holding a RUNNING claim `claimMin` old. */
function seed({ claimMin, status = "ready", parkedMin = 45 }) {
  h.state.workflow = {
    id: "wf_1", epicId: "EPIC-1", phase: "development",
    agentTasks: { "T-2": { id: "task_1", agentId: DEV, ticketId: "T-2", status: "running", startedAt: ago(claimMin) } },
  };
  h.state.tickets = {
    "T-2": { ticketId: "T-2", title: "dev work", assignee: DEV, workflowId: "wf_1", parentId: "EPIC-1", status, blockedBy: ["T-3"], updatedAt: ago(parkedMin) },
    "T-3": { ticketId: "T-3", title: "fix", assignee: DEV, workflowId: "wf_1", parentId: "EPIC-1", status: "done", blockedBy: [], updatedAt: ago(90) },
  };
}
const RM = "agentcore_hub_release_manager";
const REPO_URL = "https://github.com/acme/juno";
const REGISTERED = JSON.stringify({ version: 1, repos: [{ repo: "acme/juno", pipeline: "juno-deploy", region: "us-west-2" }] });
const JIRA_ENV = { TICKET_PROVIDER: "jira", JIRA_SITE_URL: "jira.test", JIRA_EMAIL: "bot@test", JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM" };
const ALL_TRANSITIONS = [
  { id: "11", name: "To Do", to: { name: "To Do" } },
  { id: "21", name: "Ready", to: { name: "Ready" } },
  { id: "31", name: "In Progress", to: { name: "In Progress" } },
  { id: "51", name: "Blocked", to: { name: "Blocked" } },
  { id: "61", name: "Done", to: { name: "Done" } },
];
const NO_IN_PROGRESS = ALL_TRANSITIONS.filter((t) => t.to.name !== "In Progress");
const JIRA_NAME = { todo: "To Do", blocked: "Blocked", ready: "Ready" };
const warned = (...parts) => console.warn.mock.calls.some((c) => parts.every((p) => String(c[0]).includes(p)));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  Object.assign(h.state, { heartbeats: [], events: [], invokes: [], ticketStatusWrites: [], jiraPosts: [], order: [], cdRegistry: null });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await load({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.RECONCILE_SWEEP_MODE;
  delete process.env.TICKET_PROVIDER;
});

describe("TEAM-5801 — reconcile sweep, DynamoDB provider", () => {
  for (const status of ["todo", "blocked"]) {
    it(`${status} + stale claim → ONE board write to in_progress, BEFORE the one invoke`, async () => {
      seed({ claimMin: 70, status });

      const m = await sweep();

      expect(m.redispatched).toBe(1);
      expect(h.state.ticketStatusWrites).toEqual([{ ticketId: "T-2", status: "in_progress" }]);
      expect(h.state.order).toEqual(["board:T-2:in_progress", "invoke:T-2"]);
      expect(h.state.tickets["T-2"].status).toBe("in_progress");
    });
  }

  it("blocked + an agent that keeps dying → enters the in_progress retry budget: one retry, then escalation", async () => {
    seed({ claimMin: 70, status: "blocked" });
    await sweep();
    // The invariant every in_progress safeguard keys on.
    expect(h.state.tickets["T-2"].status).toBe("in_progress");

    for (const min of [70, 140, 210]) { vi.setSystemTime(T0 + min * MIN); await sweep(); }

    expect(h.state.invokes).toHaveLength(2); // recovery + one retry, never a third
    expect(h.state.workflow.deadSessionRetries?.["T-2"]).toBe(1);
    expect(eventsOf("agent.escalated").map((e) => e.detail?.reason)).toEqual(["dead_session_retry_exhausted"]);
  });

  it("NEGATIVE — a human gate parked in blocked (Request changes) is not re-presented and not invoked", async () => {
    seed({ claimMin: 70, status: "blocked" });
    Object.assign(h.state.tickets["T-2"], { assignee: "human:tycen", labels: ["human-review"] });
    delete h.state.workflow.agentTasks["T-2"];

    await sweep();

    expect(h.state.invokes).toHaveLength(0);
    expect(h.state.ticketStatusWrites).toEqual([]); // no in_review re-park, no in_progress
    expect(h.state.tickets["T-2"].status).toBe("blocked");
  });
});

describe("TEAM-5801 — escalation-gate wake, DynamoDB provider", () => {
  it("human Done on the escalation gate → the parked release manager runs In Progress, invoked once", async () => {
    await load({ [`RUNTIME_ARN_${RM.toUpperCase()}`]: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/rm" });
    h.state.cdRegistry = REGISTERED; // a handoff run would resolve the ship ticket instead of dispatching it
    h.state.workflow = {
      id: "wf_1", epicId: "EPIC-1", phase: "ship",
      repoConfig: { layout: "multi-repo", repos: [{ platform: "shared", url: REPO_URL, defaultBranch: "main" }] },
      agentTasks: { "T-2": { id: "task_1", agentId: RM, ticketId: "T-2", status: "running", startedAt: ago(70) } },
    };
    const gateTitle = "Escalation #1: ship-review not converging";
    h.state.tickets = {
      "T-2": { ticketId: "T-2", title: "CD: ship", assignee: RM, workflowId: "wf_1", parentId: "EPIC-1", status: "blocked", blockedBy: [], updatedAt: ago(45) },
      "G-1": { ticketId: "G-1", title: gateTitle, assignee: "human:tycen", workflowId: "wf_1", parentId: "EPIC-1", status: "done", blockedBy: [], labels: ["human-review"], updatedAt: ago(0) },
    };

    await mod.handleTicketDone("G-1", {
      ticketId: { S: "G-1" }, title: { S: gateTitle }, assignee: { S: "human:tycen" },
      parentId: { S: "EPIC-1" }, workflowId: { S: "wf_1" }, status: { S: "done" },
    });

    expect(eventsOf("orchestrator.escalation_decided")).toHaveLength(1);
    expect(h.state.order).toEqual(["board:T-2:in_progress", "invoke:T-2"]);
    expect(h.state.tickets["T-2"].status).toBe("in_progress");
  });
});

describe("TEAM-5801 — reconcile sweep, Jira provider", () => {
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj), json: async () => obj });
  const issue = (key, status, blockedBy = []) => ({
    key,
    fields: {
      summary: key, status: { name: status }, issuetype: { name: "Task" }, parent: { key: "EPIC-1" },
      labels: [`agent:${DEV}`, "wf:wf_1"], comment: { comments: [] },
      issuelinks: blockedBy.map((k) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: k } })),
    },
  });
  /** A Jira board whose GET /transitions offers `transitions`; records every POST in jiraPosts + order. */
  async function jiraBoard(status, transitions) {
    await load(JIRA_ENV);
    seed({ claimMin: 70, status });
    const issues = { "T-2": issue("T-2", JIRA_NAME[status], ["T-3"]), "T-3": issue("T-3", "Done") };
    global.fetch = vi.fn(async (url, init = {}) => {
      const u = new URL(String(url));
      const method = (init.method || "GET").toUpperCase();
      if (u.pathname === "/rest/api/3/search/jql") return jsonResp({ issues: Object.values(issues), isLast: true });
      const m = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?$/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if (method === "GET") return jsonResp({ transitions });
        const to = transitions.find((t) => t.id === JSON.parse(init.body).transition.id).to.name;
        h.state.jiraPosts.push({ key, to });
        h.state.order.push(`board:${key}:${to}`);
        issues[key].fields.status.name = to;
        return { ok: true, status: 204, text: async () => "" };
      }
      if (sub === "/comment") return jsonResp({ comments: [], total: 0 });
      return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "{}" };
    });
  }

  for (const status of ["todo", "blocked"]) {
    it(`${JIRA_NAME[status]} + stale claim → ONE In Progress transition, BEFORE the one invoke`, async () => {
      await jiraBoard(status, ALL_TRANSITIONS);

      const m = await sweep();

      expect(m.redispatched).toBe(1);
      expect(h.state.jiraPosts).toEqual([{ key: "T-2", to: "In Progress" }]);
      expect(h.state.order).toEqual(["board:T-2:In Progress", "invoke:T-2"]);
    });
  }

  it("Blocked on a board with no → In Progress transition → refused: no invoke, claim released, warning names it", async () => {
    await jiraBoard("blocked", NO_IN_PROGRESS);

    const m = await sweep();

    expect(h.state.invokes).toHaveLength(0);
    expect(h.state.jiraPosts).toEqual([]);
    expect(h.state.workflow.agentTasks["T-2"].status).toBe("ready"); // freed for a later tick once the board is fixed
    expect(m.redispatched).toBe(0);
    expect(warned("T-2", "blocked", "In Progress")).toBe(true);
  });

  it("UNCHANGED — Ready on a board with no → In Progress transition still invokes (and warns)", async () => {
    await jiraBoard("ready", NO_IN_PROGRESS);

    await sweep();

    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.workflow.agentTasks["T-2"].status).toBe("running");
    expect(warned("T-2", "ready", "In Progress")).toBe(true);
  });
});
