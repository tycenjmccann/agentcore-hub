import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fixtures from "./__fixtures__/closeout-boards.json";
import { mapJiraStatusToInternal, INTERNAL_STATUS_TO_JIRA } from "@/lib/workflow/jira-client";

/**
 * TEAM-5421 acceptance replays: three real stopped runs, cancelled end to end.
 *
 * Each replay seeds the run's at-stop board (__fixtures__/closeout-boards.json,
 * see its _doc for the derivation) into ONE in-memory tickets table, POSTs the
 * REAL cancel route, then feeds every ticket row the route changed into the REAL
 * orchestrator handler as a DynamoDB-stream MODIFY record, exactly what the
 * tickets table's stream would deliver. Only the I/O seams are mocked: the AWS
 * SDK clients (shared by the route and the orchestrator) and workflow-store.
 *
 * Asserted per run: the exact moved / cancelled / kept sets, the post-run epic
 * and its banner, and that the orchestrator emits ticket.cancelled and never
 * agent.complete after workflow.cancelled.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  type Row = Record<string, unknown>;
  const state = {
    workflow: {} as Row,
    tickets: new Map<string, Row>(),
    s3: new Map<string, string>(),
    events: [] as Row[], // events-table Put items, route + orchestrator, in order
    agentInvokes: [] as Row[], // orchestrator dispatches (agent invoker Lambda)
    seq: 9000,
  };
  return { state };
});

// ─── In-memory DynamoDB (same evaluator as route.test.ts) ───────────────────

type Expr = { names?: Record<string, string>; values?: Record<string, unknown> };
const ccf = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

function evalTerm(item: Record<string, unknown>, term: string, e: Expr): boolean {
  const t = term.trim();
  const name = (p: string) => e.names?.[p] ?? p;
  const ne = /^attribute_not_exists\((.+)\)$/.exec(t);
  if (ne) return item[name(ne[1])] === undefined;
  const m = /^(\S+)\s*(=|<>|<)\s*(:\w+)$/.exec(t);
  if (!m) throw new Error(`unsupported condition term: ${t}`);
  const a = item[name(m[1])];
  const b = e.values?.[m[3]];
  if (m[2] === "=") return a === b;
  if (m[2] === "<>") return a !== b;
  return a !== undefined && String(a) < String(b);
}

function evalCondition(item: Record<string, unknown>, expr: string | undefined, e: Expr) {
  if (!expr) return true;
  return expr.split(" OR ").some((or) => or.split(" AND ").every((term) => evalTerm(item, term, e)));
}

function applyUpdate(item: Record<string, unknown>, expr: string, e: Expr) {
  const name = (p: string) => e.names?.[p] ?? p;
  for (const [, kind, body] of expr.matchAll(/(SET|REMOVE)\s+(.*?)(?=\s+(?:SET|REMOVE)\s|$)/g)) {
    for (const part of body.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (kind === "REMOVE") delete item[name(part)];
      else {
        const [path, val] = part.split("=").map((s) => s.trim());
        item[name(path)] = structuredClone(e.values?.[val]);
      }
    }
  }
}

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand extends Cmd {}
  class UpdateCommand extends Cmd {}
  class QueryCommand extends Cmd {}
  class PutCommand extends Cmd {}
  class ScanCommand extends Cmd {}
  return {
    GetCommand,
    UpdateCommand,
    QueryCommand,
    PutCommand,
    ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: Cmd) => {
          const input = cmd.input as Record<string, unknown> & {
            TableName: string;
            Key?: Record<string, string>;
            UpdateExpression?: string;
            ConditionExpression?: string;
            ExpressionAttributeNames?: Record<string, string>;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
          const e = { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues };
          const table = input.TableName;
          const isWf = table.includes("workflows");
          const isTickets = table.includes("tickets");
          if (cmd instanceof GetCommand) {
            if (isWf) return { Item: structuredClone(h.state.workflow) };
            if (isTickets) {
              const row = h.state.tickets.get(String(input.Key?.ticketId));
              return { Item: row ? structuredClone(row) : undefined };
            }
            return {};
          }
          if (cmd instanceof QueryCommand) {
            const pid = e.values?.[":pid"];
            if (!isTickets || pid === undefined) return { Items: [] };
            return { Items: [...h.state.tickets.values()].filter((t) => t.parentId === pid).map((t) => structuredClone(t)) };
          }
          if (cmd instanceof ScanCommand) return { Items: [] };
          if (cmd instanceof PutCommand) {
            if (table.includes("events")) h.state.events.push(input.Item as Record<string, unknown>);
            return {};
          }
          // UpdateCommand: the route's writes are fully evaluated; the
          // orchestrator writes nothing to tickets/workflows on these paths.
          if (isWf) {
            if (!evalCondition(h.state.workflow, input.ConditionExpression, e)) throw ccf();
            applyUpdate(h.state.workflow, String(input.UpdateExpression), e);
            return {};
          }
          const id = String(input.Key?.ticketId);
          const row = h.state.tickets.get(id) ?? { ticketId: id };
          if (!evalCondition(row, input.ConditionExpression, e)) throw ccf();
          applyUpdate(row, String(input.UpdateExpression), e);
          h.state.tickets.set(id, row);
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  class PutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetObjectCommand,
    PutObjectCommand,
    S3Client: class {
      async send(cmd: GetObjectCommand) {
        const body = cmd instanceof GetObjectCommand ? h.state.s3.get(cmd.input.Key) : undefined;
        if (body === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => body } };
      }
    },
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => ({
  PutEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  EventBridgeClient: class {
    async send() {
      return { FailedEntryCount: 0 };
    }
  },
}));

// One Lambda client for both callers: the route's ticket-tools create_ticket
// (answered with a fresh epic row) and the orchestrator's agent invoker.
vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class {
    constructor(public input: { FunctionName: string; Payload: Uint8Array | string }) {}
  },
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array | string } }) {
      const call = JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString());
      if (call.tool_name === "Tickets___create_ticket") {
        const key = `TEAM-${++h.state.seq}`;
        h.state.tickets.set(key, {
          ticketId: key, status: "todo", type: "epic", title: call.parameters.summary,
          workflowId: call.parameters.workflow_id, description: call.parameters.description,
        });
        return { Payload: Buffer.from(JSON.stringify({ key, status: "created" })) };
      }
      h.state.agentInvokes.push(call);
      return {};
    }
  },
}));

vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

// workflow-store reads/writes the same in-memory workflow row.
vi.mock("../../../../../../lambda/orchestrator/workflow-store.mjs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id: string) => (h.state.workflow.id === id ? structuredClone(h.state.workflow) : null)),
  completeTaskEntry: vi.fn(async (wfId: string, tid: string) => {
    const tasks = h.state.workflow.agentTasks as Record<string, Record<string, unknown>>;
    if (h.state.workflow.id === wfId) tasks[tid] = { ...(tasks[tid] || { ticketId: tid }), status: "complete" };
  }),
  mergeTaskMetadata: vi.fn(async () => {}),
  claimInvocation: vi.fn(async () => true),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  appendNotification: vi.fn(async () => {}),
  appendReviewNotificationOnce: vi.fn(async () => false),
  advancePhase: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async (id: string, ts: string) => {
    if (h.state.workflow.id !== id || ["complete", "cancelled"].includes(String(h.state.workflow.phase))) return false;
    Object.assign(h.state.workflow, { phase: "complete", completedAt: ts });
    return true;
  }),
  claimTerminalOutcome: vi.fn(async () => false),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
}));

process.env.SHIP_MERGE_VERIFY = "off";

const { POST } = await import("./route");
const { handler: orchestrator } = await import("../../../../../../lambda/orchestrator/index.mjs");

// ─── Replay harness ──────────────────────────────────────────────────────────

type Board = {
  workflowId: string;
  epicId: string;
  stopAt: string;
  board: Array<Record<string, unknown> & { ticketId: string; status: string }>;
  tasksAtStop: Record<string, { status: string; agentId: string }>;
  completions: Record<string, Record<string, unknown>>;
};
const RUNS = (fixtures as unknown as { runs: Record<string, Board> }).runs;
const ids = (...n: Array<number | [number, number]>) =>
  n.flatMap((x) => (Array.isArray(x) ? Array.from({ length: x[1] - x[0] + 1 }, (_, i) => x[0] + i) : [x])).map((x) => `TEAM-${x}`).sort();

function seed(run: Board) {
  h.state.tickets = new Map(run.board.map((t) => [t.ticketId, structuredClone(t)]));
  h.state.tickets.set(run.epicId, { ticketId: run.epicId, type: "epic", status: "in_progress", workflowId: run.workflowId });
  h.state.s3 = new Map(Object.entries(run.completions).map(([id, rec]) => [`completions/${id}.json`, JSON.stringify({ ticketId: id, ...rec })]));
  h.state.workflow = {
    id: run.workflowId,
    workflowId: run.workflowId,
    epicId: run.epicId,
    workflowDefId: "software-delivery",
    phase: "running",
    input: { title: "replay" },
    humanNotifications: [],
    agentTasks: Object.fromEntries(
      Object.entries(run.tasksAtStop).map(([tid, t]) => [tid, { ticketId: tid, ...t, startedAt: new Date().toISOString() }])
    ),
  };
  h.state.events = [];
  h.state.agentInvokes = [];
}

const snapshot = () => new Map([...h.state.tickets].map(([k, v]) => [k, structuredClone(v)]));

/** POST the real route, then stream every changed ticket row into the real orchestrator. */
async function cancelAndStream(workflowId: string) {
  const before = snapshot();
  const res = await POST(
    new NextRequest(`http://localhost/api/workflow/${workflowId}/cancel`, { method: "POST" }),
    { params: { id: workflowId } }
  );
  const body = await res.json();
  const changed = [...h.state.tickets].filter(([k, v]) => JSON.stringify(before.get(k)) !== JSON.stringify(v));
  for (const [id, row] of changed) {
    const old = before.get(id);
    await orchestrator({
      Records: [{
        eventName: old ? "MODIFY" : "INSERT",
        dynamodb: { NewImage: structuredClone(row), ...(old ? { OldImage: { status: old.status } } : {}) },
      }],
    });
  }
  return { status: res.status, body, changed: new Set(changed.map(([k]) => k)) };
}

const withStatus = (s: string) => [...h.state.tickets.values()].filter((t) => t.status === s).map((t) => String(t.ticketId)).sort();
const postRunEpic = () => [...h.state.tickets.values()].find((t) => t.type === "epic" && String(t.title).startsWith("Post-run follow-ups"));
const movedUnder = (key: string) => [...h.state.tickets.values()].filter((t) => t.parentId === key).map((t) => String(t.ticketId)).sort();
const eventsAfterCancel = (type: string) => {
  const at = h.state.events.findIndex((e) => e.type === "workflow.cancelled");
  expect(at).toBeGreaterThanOrEqual(0);
  return h.state.events.slice(at + 1).filter((e) => e.type === type);
};

const ORIGIN_RE = /AGENT-AUTHORED FOLLOW-UP \(materialized by report_completion from ([^;\s)]+);/;

function expectMoved(run: Board, expected: string[]) {
  let withOrigin = 0;
  const epic = postRunEpic();
  expect(epic?.title).toBe(`Post-run follow-ups ${run.workflowId}`);
  expect(epic?.status).toBe("todo");
  const key = String(epic?.ticketId);
  expect(movedUnder(key)).toEqual(expected);
  for (const id of expected) {
    const t = h.state.tickets.get(id)!;
    expect(t.status, id).toBe("todo");
    expect(t.blockedBy, id).toEqual([]);
    expect(String(t.description), id).toContain(`MOVED on cancel of ${run.workflowId}:`);
    // A report_completion follow-up names its origin; a hand-filed advisory has
    // none to name, and keeps its own text (the finding) below the banner.
    const original = String(run.board.find((b) => b.ticketId === id)?.description ?? "");
    const origin = ORIGIN_RE.exec(original)?.[1];
    expect(String(t.description), id).toContain(`Originating ticket: ${origin ?? "unknown"}`);
    if (origin) withOrigin++;
    if (original) expect(String(t.description), id).toContain(original.slice(0, 60));
  }
  return { key, withOrigin };
}

function expectNoCompletionAfterCancel(cancelled: string[]) {
  expect(eventsAfterCancel("agent.complete")).toHaveLength(0);
  expect(eventsAfterCancel("ticket.cancelled").map((e) => String((e.detail as Record<string, unknown>)?.ticketId ?? e.ticketId)).sort())
    .toEqual(expect.arrayContaining(cancelled));
  expect(h.state.agentInvokes).toHaveLength(0); // nothing dispatched on a cancelled run
}

beforeEach(() => {
  h.state.seq = 9000;
});

describe("TEAM-5421 replay: cancelled runs close as cancelled", () => {
  it("rfq233: 17 CD-blocked follow-ups moved, 5366 + 5418 + the epic cancelled, done kept", async () => {
    const run = RUNS.rfq233;
    seed(run);
    const doneBefore = withStatus("done");
    const { status, body } = await cancelAndStream(run.workflowId);
    expect(status).toBe(200);

    const moved = ids([5377, 5384], 5393, 5394, 5400, 5402, 5403, 5406, 5410, 5414, 5416);
    expect(moved).toHaveLength(17);
    // 5381, 5382, 5400, 5414 are hand-filed advisories: no report_completion origin
    expect(expectMoved(run, moved).withOrigin).toBe(13);
    expect(body.followUpsMoved).toBe(17);

    expect(withStatus("cancelled")).toEqual(ids(5353, 5366, 5418));
    expect(withStatus("done")).toEqual(doneBefore);
    for (const id of ids(5365, 5389, 5412)) expect(h.state.tickets.get(id)?.status).toBe("done");
    expect(body.ticketsLeftRunning).toEqual([]);
    expect(body.closeoutPending).toBe(false);
    expectNoCompletionAfterCancel(ids(5366, 5418));
  });

  it("znl7a4: open tickets cancelled, the live session left until released, then cancelled on re-POST", async () => {
    const run = RUNS.znl7a4;
    seed(run);
    const first = await cancelAndStream(run.workflowId);
    expect(first.status).toBe(200);

    const moved = ids([5333, 5335], [5341, 5344], [5349, 5351]);
    expect(expectMoved(run, moved).withOrigin).toBe(10);
    expect(first.body.followUpsMoved).toBe(10);
    expect(withStatus("cancelled")).toEqual(ids([5326, 5331], 5352));
    expect(h.state.tickets.get("TEAM-5325")?.status).toBe("in_progress");
    expect(first.body.ticketsLeftRunning).toEqual(["TEAM-5325"]);
    expect(first.body.closeoutPending).toBe(true);
    expect(h.state.tickets.get(run.epicId)?.status).toBe("in_progress"); // not clean yet

    // The existing claim-release path frees the session; the re-POST resumes.
    (h.state.workflow.agentTasks as Record<string, Record<string, unknown>>)["TEAM-5325"].status = "failed";
    const second = await cancelAndStream(run.workflowId);
    expect(second.status).toBe(200);
    expect(second.body.resumed).toBe(true);
    expect(second.body.closeoutPending).toBe(false);
    expect(withStatus("cancelled")).toEqual(ids(5315, 5325, [5326, 5331], 5352));
    expectMoved(run, moved); // unchanged by the resume, same epic
    expect([...h.state.tickets.values()].filter((t) => String(t.title).startsWith("Post-run follow-ups"))).toHaveLength(1);
    expectNoCompletionAfterCancel(ids(5325, [5326, 5331], 5352));
  });

  it("TEAM-5259: 5264-5267 + 5279 + the epic cancelled, 5 follow-ups moved", async () => {
    const run = RUNS["TEAM-5259"];
    seed(run);
    const { status, body } = await cancelAndStream(run.workflowId);
    expect(status).toBe(200);
    expect(expectMoved(run, ids(5268, 5270, [5275, 5277])).withOrigin).toBe(5);
    expect(body.followUpsMoved).toBe(5);
    expect(withStatus("cancelled")).toEqual(ids(5259, [5264, 5267], 5279));
    expectNoCompletionAfterCancel(ids([5264, 5267], 5279));
  });

  it("a real Ship + CD close is untouched: agent.complete, phase complete, later cancel → 409 with zero writes", async () => {
    const run = RUNS["TEAM-5259"];
    seed(run);
    // Every child done with a real completion record; the CD ticket is the last to close.
    const cd = "TEAM-5267";
    for (const t of h.state.tickets.values()) {
      if (t.type === "epic") continue;
      if (t.ticketId !== cd) t.status = "done";
      h.state.s3.set(`completions/${t.ticketId}.json`, JSON.stringify({ ticketId: t.ticketId, summary: "did the work", status: "complete" }));
    }
    const tasks = h.state.workflow.agentTasks as Record<string, Record<string, unknown>>;
    for (const t of h.state.tickets.values()) {
      if (t.type !== "epic") tasks[String(t.ticketId)] = { ticketId: t.ticketId, agentId: t.assignee, status: t.ticketId === cd ? "running" : "complete" };
    }
    h.state.tickets.get(cd)!.status = "done";
    await orchestrator({
      Records: [{ eventName: "MODIFY", dynamodb: { NewImage: structuredClone(h.state.tickets.get(cd)), OldImage: { status: "in_progress" } } }],
    });
    expect(h.state.events.filter((e) => e.type === "agent.complete").map((e) => (e.detail as Record<string, unknown>)?.ticketId ?? e.ticketId)).toContain(cd);
    expect(h.state.events.filter((e) => e.type === "ticket.cancelled")).toHaveLength(0);
    expect(h.state.workflow.phase).toBe("complete");

    const before = snapshot();
    const res = await POST(
      new NextRequest(`http://localhost/api/workflow/${run.workflowId}/cancel`, { method: "POST" }),
      { params: { id: run.workflowId } }
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify([...h.state.tickets])).toBe(JSON.stringify([...before]));
    expect(h.state.events.filter((e) => e.type === "workflow.cancelled")).toHaveLength(0);
  });
});

// ─── rfq233 via the Jira provider — the real production defect ─────────────
//
// TICKET_PROVIDER/JIRA_* are read when route.ts and the orchestrator load, so
// this reloads both fresh (vi.resetModules + dynamic import) rather than reuse
// the dynamodb-mode POST/orchestrator captured at the top of this file. Jira
// itself is a small in-memory store answering globalThis.fetch, deliberately
// offering NO Won't Do destination on any transition — the real rfq233 defect:
// cancelOneIssueJira falls back to the only Done-category transition (with
// resolution Won't Do), so the webhook that follows carries newStatus "done",
// not "cancelled". The orchestrator's cancelledRunTicket guard is what keeps
// that from publishing agent.complete.
describe("TEAM-5421 replay: rfq233 via the Jira provider (the real defect)", () => {
  type JiraTicket = {
    status: string; // Jira display name
    parent?: string;
    labels: string[];
    summary: string;
    description?: unknown; // ADF
    issuelinks: Array<{ id: string; type: { name: string }; inwardIssue?: { key: string } }>;
    created?: string;
  };

  const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const blocksLink = (id: string, blocker: string) => ({ id, type: { name: "Blocks" }, inwardIssue: { key: blocker } });

  // No "Won't Do" transition anywhere — forces cancelOneIssueJira's fallback.
  const NO_WONT_DO_TRANSITIONS = [
    { id: "11", name: "Unblock", to: { name: "To Do" } },
    { id: "41", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
  ];

  function buildJiraStore(run: Board): Map<string, JiraTicket> {
    const store = new Map<string, JiraTicket>();
    store.set(run.epicId, { status: "In Progress", labels: [], summary: "epic", issuelinks: [] });
    for (const b of run.board) {
      const blockedBy = (b.blockedBy as string[] | undefined) || [];
      store.set(b.ticketId, {
        status: INTERNAL_STATUS_TO_JIRA[String(b.status)] || "To Do",
        parent: String(b.parentId || run.epicId),
        labels: (b.labels as string[] | undefined) || [],
        summary: String(b.title || ""),
        description: b.description ? adf(String(b.description)) : undefined,
        issuelinks: blockedBy.map((blocker, i) => blocksLink(`L-${b.ticketId}-${i}`, blocker)),
        created: String(b.createdAt || ""),
      });
    }
    return store;
  }

  /** fetch stub: /search/jql, GET/POST issue transitions, PUT issue, DELETE issueLink, GET issue (webhook re-read). */
  function stubJiraFetch(store: Map<string, JiraTicket>) {
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(url));
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: u.pathname, body });

      if (u.pathname.endsWith("/search/jql")) {
        const jql = u.searchParams.get("jql") || "";
        const parent = /parent = (\S+)/.exec(jql)?.[1];
        // The route's JQL: non-Done children, plus Done ones carrying a label from its `labels in (...)` list.
        const listed = (/labels in \(([^)]*)\)/.exec(jql)?.[1] || "").split(",").map((l) => l.trim().replace(/^"|"$/g, ""));
        const issues = [...store.entries()]
          .filter(([, t]) => t.parent === parent && (t.status !== "Done" || t.labels.some((l) => listed.includes(l))))
          .map(([key, t]) => ({
            key,
            fields: { status: { name: t.status }, labels: t.labels, summary: t.summary, description: t.description, issuelinks: t.issuelinks, created: t.created, parent: { key: t.parent } },
          }));
        return new Response(JSON.stringify({ isLast: true, issues }), { status: 200 });
      }
      let m = /\/issue\/([^/]+)\/transitions$/.exec(u.pathname);
      if (m) {
        if (method === "GET") return new Response(JSON.stringify({ transitions: NO_WONT_DO_TRANSITIONS }), { status: 200 });
        const t = store.get(m[1])!;
        const tr = NO_WONT_DO_TRANSITIONS.find((x) => x.id === (body as { transition: { id: string } }).transition.id)!;
        t.status = tr.to.name;
        return new Response(null, { status: 204 });
      }
      m = /\/issueLink\/([^/]+)$/.exec(u.pathname);
      if (m && method === "DELETE") {
        for (const t of store.values()) t.issuelinks = t.issuelinks.filter((l) => l.id !== m![1]);
        return new Response(null, { status: 204 });
      }
      m = /\/issue\/([^/]+)$/.exec(u.pathname);
      if (m && method === "PUT") {
        const t = store.get(m[1])!;
        const fields = (body as { fields: Record<string, unknown> }).fields;
        if (fields.parent) t.parent = (fields.parent as { key: string }).key;
        if (fields.description) t.description = fields.description;
        return new Response(null, { status: 204 });
      }
      if (m && method === "GET") {
        const t = store.get(m[1])!;
        return new Response(
          JSON.stringify({
            key: m[1],
            fields: {
              summary: t.summary, description: t.description, status: { name: t.status }, issuetype: { name: "Task" },
              ...(t.parent ? { parent: { key: t.parent } } : {}), labels: t.labels, issuelinks: t.issuelinks,
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${method} ${u.pathname}`);
    }) as typeof globalThis.fetch;
    return calls;
  }

  async function loadJiraMode() {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    vi.resetModules();
    const route = await import("./route");
    const orch = (await import("../../../../../../lambda/orchestrator/index.mjs")) as unknown as { handler: (e: unknown) => Promise<unknown> };
    return { POST: route.POST, orchestrator: orch.handler };
  }

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TICKET_PROVIDER;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it("no Won't Do transition -> falls back to Done + resolution Won't Do; the webhook still lands as ticket.cancelled, never agent.complete; 17 moved", async () => {
    const run = RUNS.rfq233;
    seed(run); // shared workflow row + S3 completions; h.state.tickets is unused in Jira mode

    const jiraStore = buildJiraStore(run);
    const before = new Map([...jiraStore].map(([k, v]) => [k, structuredClone(v)]));
    const calls = stubJiraFetch(jiraStore);
    const { POST: jiraPOST, orchestrator: jiraOrchestrator } = await loadJiraMode();

    const res = await jiraPOST(
      new NextRequest(`http://localhost/api/workflow/${run.workflowId}/cancel`, { method: "POST" }),
      { params: { id: run.workflowId } }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.followUpsMoved).toBe(17);

    // The real defect, reproduced: no Won't Do destination anywhere, so both
    // open children (and the epic) land on Done, resolution Won't Do — never
    // on Won't Do itself.
    expect(jiraStore.get("TEAM-5366")?.status).toBe("Done");
    expect(jiraStore.get("TEAM-5418")?.status).toBe("Done");
    const fallbackCalls = calls.filter(
      (c) => c.method === "POST" && (c.path.endsWith("/issue/TEAM-5366/transitions") || c.path.endsWith("/issue/TEAM-5418/transitions"))
    );
    expect(fallbackCalls.length).toBeGreaterThan(0);
    for (const c of fallbackCalls) expect(c.body).toMatchObject({ transition: { id: "41" }, fields: { resolution: { name: "Won't Do" } } });

    // Feed every resulting status change through the REAL orchestrator webhook
    // path, exactly how Jira's own webhook would deliver it.
    for (const [id, after] of jiraStore) {
      const was = before.get(id);
      if (!was || was.status === after.status) continue;
      await jiraOrchestrator({
        source: "jira-webhook",
        ticketId: id,
        newStatus: mapJiraStatusToInternal(after.status),
        oldStatus: mapJiraStatusToInternal(was.status),
      });
    }

    expect(eventsAfterCancel("agent.complete")).toHaveLength(0);
    const cancelledIds = eventsAfterCancel("ticket.cancelled").map((e) => String((e.detail as Record<string, unknown>)?.ticketId ?? e.ticketId));
    expect(cancelledIds.sort()).toEqual(ids(5366, 5418));
    expect(h.state.agentInvokes).toHaveLength(0);
  });
});
