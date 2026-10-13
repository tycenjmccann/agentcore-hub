import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-5791 — a Ready ticket stranded behind an UN-released running claim.
 *
 * A self-park whose claim release fails closed (unattributable park, or a Jira
 * expand=changelog page past 100 histories) leaves agentTasks[T] `running`. The
 * cascade later Readies T; the Ready handler's claim CAS refuses it until the
 * claim is 2× the lease TTL old, and nothing event-driven retries. The periodic
 * backstop is the reconcile sweep, which is `enforce` in prod (hand-deployed
 * 2026-09-04, d18c855; the detector stays at its `shadow` default). Its ready
 * branch used to recover through the bare redispatchTicket, which claims and
 * invokes but never moves the board to In Progress — so the recovered session ran
 * outside the in_progress lifecycle (self-park release, harness park, detector,
 * retry budget) and could strand again. The fix routes a ready candidate through
 * the full Ready handler, behind the lease gate + F7 re-check + the claim CAS.
 *
 * Harness: index.mjs imported for real at the deployed config; only the AWS SDK
 * clients and workflow-store are faked (stateful, with the real CAS predicates).
 * Only Date is faked, so claims and parks age between sweep ticks.
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
      if (cmd.input.FunctionName === "agentcore-hub-agent-invoker") h.state.invokes.push(JSON.parse(cmd.input.Payload));
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  Object.assign(h.state, { heartbeats: [], events: [], invokes: [], ticketStatusWrites: [], jiraPosts: [] });
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

describe("TEAM-5791 — Ready ticket behind a stale un-released claim (DynamoDB provider)", () => {
  it("claim past 2×TTL, lease dead → the sweep dispatches it ONCE through the Ready handler (board → in_progress)", async () => {
    seed({ claimMin: 70 });
    const oldStart = h.state.workflow.agentTasks["T-2"].startedAt;

    const m = await sweep();

    expect(m.redispatched).toBe(1);
    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.workflow.agentTasks["T-2"].status).toBe("running");
    expect(h.state.workflow.agentTasks["T-2"].startedAt > oldStart).toBe(true); // a NEW claim generation
    // The root cause: the recovered session must run on an in_progress ticket.
    expect(h.state.ticketStatusWrites).toEqual([{ ticketId: "T-2", status: "in_progress" }]);
    expect(h.state.tickets["T-2"].status).toBe("in_progress");

    // The next tick sees a live, fresh claim — no second dispatch.
    await sweep();
    expect(h.state.invokes).toHaveLength(1);
  });

  it("a recovered session that dies again enters the in_progress retry budget: one retry, then escalation", async () => {
    seed({ claimMin: 70 });
    await sweep();
    expect(h.state.invokes).toHaveLength(1);

    vi.setSystemTime(T0 + 70 * MIN); // the recovered agent goes silent past 2×TTL
    await sweep();
    expect(h.state.invokes).toHaveLength(2);
    expect(h.state.workflow.deadSessionRetries?.["T-2"]).toBe(1); // budget spent by the steal

    vi.setSystemTime(T0 + 140 * MIN); // and dies again
    await sweep();
    expect(h.state.invokes).toHaveLength(2); // no third dispatch
    expect(eventsOf("agent.escalated").map((e) => e.detail?.reason)).toEqual(["dead_session_retry_exhausted"]);
    expect(h.state.workflow.agentTasks["T-2"].status).toBe("error");
  });

  it("NEGATIVE — live lease: claim past 2×TTL but a heartbeat 2 min ago → never dispatched", async () => {
    seed({ claimMin: 70 });
    h.state.heartbeats = [{ type: "agent.streaming", timestamp: ago(2), detail: { agentId: DEV, ticketId: "T-2" } }];
    const before = { ...h.state.workflow.agentTasks["T-2"] };

    await sweep();

    expect(h.state.invokes).toHaveLength(0);
    expect(h.state.workflow.agentTasks["T-2"]).toEqual(before);
    expect(h.state.tickets["T-2"].status).toBe("ready");
    expect(h.state.ticketStatusWrites).toEqual([]);
  });

  it("NEGATIVE — claim younger than the 2×TTL hatch (lease dead) → refused, retried by a later tick once the hatch opens", async () => {
    seed({ claimMin: 40 });
    const before = { ...h.state.workflow.agentTasks["T-2"] };

    await sweep();
    expect(h.state.invokes).toHaveLength(0);
    expect(h.state.workflow.agentTasks["T-2"]).toEqual(before);
    expect(h.state.ticketStatusWrites).toEqual([]); // the claim CAS is lost BEFORE any board write

    vi.setSystemTime(T0 + 30 * MIN); // claim now 70 min old
    await sweep();
    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.tickets["T-2"].status).toBe("in_progress");
  });

  it("two concurrent sweeps → exactly one dispatch and one board write (claim CAS is the arbiter)", async () => {
    seed({ claimMin: 70 });

    await Promise.all([sweep(), sweep()]);

    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.ticketStatusWrites).toHaveLength(1);
  });

  it("UNCHANGED — an in_progress ticket with a stale claim is stolen + re-dispatched via redispatchTicket (no board write)", async () => {
    seed({ claimMin: 70, status: "in_progress" });

    const m = await sweep();

    expect(m.redispatched).toBe(1);
    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.ticketStatusWrites).toEqual([]);
    expect(h.state.workflow.deadSessionRetries?.["T-2"]).toBe(1);
  });

  it("MODE DEPENDENCY — with RECONCILE_SWEEP_MODE unset (code default off) nothing recovers it", async () => {
    await load({ RECONCILE_SWEEP_MODE: undefined });
    seed({ claimMin: 70 });

    const m = await sweep();

    expect(m.mode).toBe("off");
    expect(h.state.invokes).toHaveLength(0);
  });
});

describe("TEAM-5791 — Jira provider", () => {
  const JIRA_TRANSITIONS = [
    { id: "21", name: "Ready", to: { name: "Ready" } },
    { id: "31", name: "In Progress", to: { name: "In Progress" } },
    { id: "51", name: "Blocked", to: { name: "Blocked" } },
    { id: "61", name: "Done", to: { name: "Done" } },
  ];
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj), json: async () => obj });
  const issue = (key, status, blockedBy = []) => ({
    key,
    fields: {
      summary: key, status: { name: status }, issuetype: { name: "Task" }, parent: { key: "EPIC-1" },
      labels: [`agent:${DEV}`, "wf:wf_1"], comment: { comments: [] },
      issuelinks: blockedBy.map((k) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: k } })),
    },
  });

  it("claim past 2×TTL, lease dead → ONE In Progress transition and ONE dispatch", async () => {
    await load({ TICKET_PROVIDER: "jira", JIRA_SITE_URL: "jira.test", JIRA_EMAIL: "bot@test", JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM" });
    seed({ claimMin: 70 });
    const issues = { "T-2": issue("T-2", "Ready", ["T-3"]), "T-3": issue("T-3", "Done") };
    global.fetch = vi.fn(async (url, init = {}) => {
      const u = new URL(String(url));
      const method = (init.method || "GET").toUpperCase();
      if (u.pathname === "/rest/api/3/search/jql") return jsonResp({ issues: Object.values(issues), isLast: true });
      const m = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?$/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if (method === "GET") return jsonResp({ transitions: JIRA_TRANSITIONS });
        const body = JSON.parse(init.body);
        const to = JIRA_TRANSITIONS.find((t) => t.id === body.transition.id).to.name;
        h.state.jiraPosts.push({ key, to });
        issues[key].fields.status.name = to;
        return { ok: true, status: 204, text: async () => "" };
      }
      if (sub === "/comment") return jsonResp({ comments: [], total: 0 });
      return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "{}" };
    });

    const m = await sweep();

    expect(m.redispatched).toBe(1);
    expect(h.state.invokes).toHaveLength(1);
    expect(h.state.jiraPosts).toEqual([{ key: "T-2", to: "In Progress" }]);
  });
});
