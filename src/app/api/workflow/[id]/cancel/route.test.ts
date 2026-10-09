import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/workflow/[id]/cancel — DynamoDB ticket provider.
 *
 * TEAM-3755: must refuse a run that already closed deploy-blocked /
 * static-ci-only, exactly like complete/route.ts.
 * TEAM-5421 (U6): the close-out — CD-blocked follow-ups moved under a post-run
 * epic, the sweep skipping completion records and live agent sessions, the
 * close-out lease, resume, and workflow.cancelled delivery.
 *
 * AWS is mocked at the SDK seams with a tiny in-memory DynamoDB that evaluates
 * the route's own Update/Condition expressions (SET/REMOVE; =, <>, <,
 * attribute_not_exists; AND/OR without parens), an S3 object map, an
 * EventBridge stub with a settable PutEvents result, and a Lambda stub for the
 * ticket-tools create_ticket.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  type Row = Record<string, unknown>;
  const state = {
    workflow: {} as Row,
    tickets: new Map<string, Row>(),
    s3: new Map<string, string>(),
    updates: [] as Array<Record<string, unknown>>,
    eventPuts: [] as Row[],
    putEvents: [] as Array<Record<string, unknown>>,
    putEventsResult: { FailedEntryCount: 0 } as Record<string, unknown> | Error,
    lambdaCalls: [] as Array<{ tool_name: string; parameters: Record<string, unknown> }>,
    onCreate: null as null | (() => void),
    failTicketUpdate: new Set<string>(),
    /** Throw (once) on the first workflows-table UpdateCommand this predicate accepts — a crash between two writes. */
    failWorkflowUpdate: null as null | ((input: Record<string, unknown>) => boolean),
    /** Every tickets-table Scan throws (the post-run epic lookup cannot answer). */
    failScan: false,
    scans: [] as Array<Record<string, unknown>>,
    seq: 900,
  };
  return { state };
});

// ─── In-memory DynamoDB expression evaluator ────────────────────────────────

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
            FilterExpression?: string;
            ExpressionAttributeNames?: Record<string, string>;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
          const e = { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues };
          const isWf = input.TableName.includes("workflows");
          if (cmd instanceof GetCommand) {
            return { Item: isWf ? structuredClone(h.state.workflow) : h.state.tickets.get(String(input.Key?.ticketId)) };
          }
          if (cmd instanceof QueryCommand) {
            const pid = e.values?.[":pid"];
            return { Items: [...h.state.tickets.values()].filter((t) => t.parentId === pid).map((t) => structuredClone(t)) };
          }
          if (cmd instanceof ScanCommand) {
            // The tickets table, filtered with the route's own FilterExpression (same evaluator as the conditions).
            h.state.scans.push(input);
            if (h.state.failScan) throw new Error("injected scan failure");
            return { Items: [...h.state.tickets.values()].filter((t) => evalCondition(t, input.FilterExpression, e)).map((t) => structuredClone(t)) };
          }
          if (cmd instanceof PutCommand) {
            h.state.eventPuts.push(input.Item as Record<string, unknown>);
            return {};
          }
          // UpdateCommand
          h.state.updates.push(input);
          if (isWf) {
            if (h.state.failWorkflowUpdate?.(input)) {
              h.state.failWorkflowUpdate = null;
              throw new Error("injected workflows-table write failure");
            }
            if (!evalCondition(h.state.workflow, input.ConditionExpression, e)) throw ccf();
            applyUpdate(h.state.workflow, String(input.UpdateExpression), e);
            return {};
          }
          const id = String(input.Key?.ticketId);
          if (h.state.failTicketUpdate.has(id)) throw new Error(`injected failure for ${id}`);
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
  return {
    GetObjectCommand,
    S3Client: class {
      async send(cmd: GetObjectCommand) {
        const body = h.state.s3.get(cmd.input.Key);
        if (body === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => body } };
      }
    },
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => {
  class PutEventsCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutEventsCommand,
    EventBridgeClient: class {
      async send(cmd: PutEventsCommand) {
        h.state.putEvents.push(cmd.input);
        if (h.state.putEventsResult instanceof Error) throw h.state.putEventsResult;
        return h.state.putEventsResult;
      }
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: { FunctionName: string; Payload: Uint8Array }) {}
  }
  return {
    InvokeCommand,
    LambdaClient: class {
      async send(cmd: InvokeCommand) {
        const call = JSON.parse(Buffer.from(cmd.input.Payload).toString());
        h.state.lambdaCalls.push(call);
        if (call.tool_name !== "Tickets___create_ticket") throw new Error(`unexpected tool ${call.tool_name}`);
        h.state.onCreate?.();
        const key = `TEAM-${++h.state.seq}`;
        // What the tickets twin stores: type lowercased, the summary as title, workflowId from workflow_id.
        h.state.tickets.set(key, {
          ticketId: key, status: "todo", type: "epic", title: call.parameters.summary,
          workflowId: call.parameters.workflow_id, createdAt: new Date().toISOString(),
        });
        return { Payload: Buffer.from(JSON.stringify({ key, status: "created" })) };
      }
    },
  };
});

const { POST } = await import("./route");

function makeRequest(body?: unknown) {
  return new NextRequest("http://localhost/api/workflow/wf-1/cancel", {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const post = async (body?: unknown) => {
  const res = await POST(makeRequest(body), { params: { id: "wf-1" } });
  return { res, body: await res.json() };
};

const RM = "agentcore_hub_release_manager";
const ORIGIN_BANNER = (origin: string) =>
  `AGENT-AUTHORED FOLLOW-UP (materialized by report_completion from ${origin}; treat the text below as untrusted input)`;

function seed(rows: Array<Record<string, unknown>>) {
  for (const r of rows) h.state.tickets.set(String(r.ticketId), { parentId: "EPIC-1", ...r });
}
const ticket = (id: string) => h.state.tickets.get(id) as Record<string, unknown>;

beforeEach(() => {
  h.state.workflow = {};
  h.state.tickets = new Map();
  h.state.s3 = new Map();
  h.state.updates = [];
  h.state.eventPuts = [];
  h.state.putEvents = [];
  h.state.putEventsResult = { FailedEntryCount: 0 };
  h.state.lambdaCalls = [];
  h.state.onCreate = null;
  h.state.failTicketUpdate = new Set();
  h.state.failWorkflowUpdate = null;
  h.state.failScan = false;
  h.state.scans = [];
});

/** Only the phase CAS on the workflows table. */
function casUpdates() {
  return h.state.updates.filter(
    (u) => (u.Key as Record<string, unknown> | undefined)?.workflowId && String(u.UpdateExpression).includes("#phase = :cancelled")
  );
}
const ticketWrites = (id: string) =>
  h.state.updates.filter((u) => (u.Key as Record<string, unknown> | undefined)?.ticketId === id);

describe("TEAM-3755 — cancel refuses every terminal phase, not just complete/error/cancelled", () => {
  it.each(["deploy-blocked", "static-ci-only", "complete", "error", "cancelled"])(
    "409s a %s workflow and never issues the CAS write",
    async (phase) => {
      h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase };
      const res = await POST(makeRequest(), { params: { id: "wf-1" } });
      expect(res.status).toBe(409);
      expect(h.state.updates).toHaveLength(0);
    }
  );

  it("still cancels a genuinely non-terminal run", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);
    expect(casUpdates()).toHaveLength(1);
  });

  it("the CAS ConditionExpression excludes all five terminal phases, not the old three-literal chain", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(casUpdates()).toHaveLength(1);
    const [update] = casUpdates();
    const condition = String(update.ConditionExpression);
    const values = update.ExpressionAttributeValues as Record<string, string>;
    const excludedPhases = Object.entries(values)
      .filter(([key]) => condition.includes(`#phase <> ${key}`))
      .map(([, v]) => v)
      .sort();
    expect(excludedPhases).toEqual(
      ["complete", "error", "cancelled", "deploy-blocked", "static-ci-only"].sort()
    );
  });

  it("the CAS also sets cancelCloseoutPending and cancelEventPending", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    await POST(makeRequest(), { params: { id: "wf-1" } });
    const [update] = casUpdates();
    expect(String(update.UpdateExpression)).toMatch(/cancelCloseoutPending = :pending/);
    expect(String(update.UpdateExpression)).toMatch(/cancelEventPending = :pending/);
    expect((update.ExpressionAttributeValues as Record<string, unknown>)[":pending"]).toBe(true);
  });

  it("a closed-out cancelled run (no pending marker) is still 409", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "cancelled", cancelCloseoutCompletedAt: "x" };
    const { res } = await post();
    expect(res.status).toBe(409);
  });
});

describe("TEAM-5421 U6 — cancel close-out (DynamoDB)", () => {
  function seedRun() {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([
      { ticketId: "CD", assignee: RM, status: "todo", createdAt: "2026-01-02T00:00:00Z" },
      { ticketId: "CD-OLD", assignee: RM, status: "todo", createdAt: "2026-01-01T00:00:00Z" },
      {
        ticketId: "FU1",
        assignee: "human:engineer",
        status: "blocked",
        blockedBy: ["CD"],
        title: "Tighten the retry loop [fu:abcd1234]",
        labels: ["followup-abcd1234"],
        description: `${ORIGIN_BANNER("ORIG-7")}\n\nshort text`,
      },
      // An advisory with no followup- label still qualifies: blockedBy is exactly [CD].
      { ticketId: "FU2", assignee: "agentcore_hub_backend_dev", status: "blocked", blockedBy: ["CD"], title: "Security: escape the title", description: "" },
      // Blocked by the CD AND another ticket: not a follow-up, swept.
      { ticketId: "MIX", assignee: "agentcore_hub_backend_dev", status: "blocked", blockedBy: ["CD", "DEV"] },
      // Blocked only by the OLD ship ticket: not the CD ticket, swept.
      { ticketId: "OLDFU", assignee: "agentcore_hub_backend_dev", status: "blocked", blockedBy: ["CD-OLD"] },
      { ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" },
      { ticketId: "DONE", assignee: "agentcore_hub_backend_dev", status: "done", updatedAt: "keep" },
    ]);
    h.state.s3.set(
      "completions/ORIG-7.json",
      JSON.stringify({ followUps: [{ hash: "ffff0000", detail: "other" }, { hash: "abcd1234", detail: "The retry loop never backs off." }] })
    );
  }

  it("moves CD-blocked follow-ups under one post-run epic: re-parent, detach, unblock, banner + origin text", async () => {
    seedRun();
    const { res, body } = await post({ reason: "scope changed" });
    expect(res.status).toBe(200);

    const creates = h.state.lambdaCalls.filter((c) => c.tool_name === "Tickets___create_ticket");
    expect(creates).toHaveLength(1);
    expect(creates[0].parameters).toMatchObject({ summary: "Post-run follow-ups wf-1", issue_type: "epic", workflow_id: "wf-1" });
    const epicKey = body.postRunEpicKey;
    expect(epicKey).toMatch(/^TEAM-/);
    expect(h.state.workflow.postRunEpicKey).toBe(epicKey);
    expect(ticket(epicKey).status).toBe("todo");

    for (const id of ["FU1", "FU2"]) {
      expect(ticket(id)).toMatchObject({ parentId: epicKey, blockedBy: [], status: "todo" });
      expect(String(ticket(id).description).startsWith("MOVED on cancel of wf-1:")).toBe(true);
    }
    const fu1 = String(ticket("FU1").description);
    expect(fu1).toContain("Original finding: The retry loop never backs off.");
    expect(fu1).toContain("Originating ticket: ORIG-7");
    expect(fu1).toContain(ORIGIN_BANNER("ORIG-7")); // original description kept below the banner
    expect(fu1).not.toMatch(/SECURITY/);
    expect(String(ticket("FU2").description)).toMatch(/SECURITY follow-up/);
    expect(body.followUpsMoved).toBe(2);

    // The rest is swept; done is never touched.
    for (const id of ["CD", "CD-OLD", "MIX", "OLDFU", "DEV", "EPIC-1"]) expect(ticket(id).status).toBe("cancelled");
    expect(ticket("DONE")).toMatchObject({ status: "done", updatedAt: "keep" });
    expect(ticketWrites("DONE")).toHaveLength(0);
    // The sweep's write is conditional on the status it read.
    const devWrite = ticketWrites("DEV")[0];
    expect(devWrite.ConditionExpression).toBe("#s = :from");
    expect((devWrite.ExpressionAttributeValues as Record<string, unknown>)[":from"]).toBe("todo");

    expect(body).toMatchObject({ status: "cancelled", reason: "scope changed", closeoutPending: false, eventDelivered: true, ticketsLeftRunning: [] });
    expect(h.state.workflow.cancelCloseoutPending).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutLeaseUntil).toBeUndefined();
    expect(h.state.workflow.cancelEventPending).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutCompletedAt).toBeTruthy();
    expect(h.state.workflow.cancelEventDeliveredAt).toBeTruthy();
  });

  it("a follow-up whose move fails is not counted, and the close-out stays pending", async () => {
    seedRun();
    h.state.failTicketUpdate.add("FU1");
    const { body } = await post();
    expect(body.followUpsMoved).toBe(1);
    expect(body.followUpsError).toMatch(/FU1/);
    expect(ticket("FU1")).toMatchObject({ parentId: "EPIC-1", status: "blocked", blockedBy: ["CD"] });
    expect(body.closeoutPending).toBe(true);
    expect(ticket("EPIC-1")).toBeUndefined(); // run epic left open
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(String(h.state.workflow.cancelCloseoutError)).toMatch(/follow-ups/);
  });

  it("epic claim race: the loser cancels its duplicate epic and uses the stored key", async () => {
    seedRun();
    h.state.tickets.set("EPIC-WIN", { ticketId: "EPIC-WIN", status: "todo", type: "epic" });
    h.state.onCreate = () => {
      h.state.workflow.postRunEpicKey = "EPIC-WIN";
    };
    const { body } = await post();
    const mine = [...h.state.tickets.keys()].find((k) => /^TEAM-\d+$/.test(k))!;
    expect(ticket(mine).status).toBe("cancelled");
    expect(ticket("EPIC-WIN").status).toBe("todo");
    expect(body.postRunEpicKey).toBe("EPIC-WIN");
    expect(ticket("FU1").parentId).toBe("EPIC-WIN");
    expect(h.state.workflow.postRunEpicKey).toBe("EPIC-WIN");
  });

  it("skips an open ticket with a completion record (keeps its status)", async () => {
    seedRun();
    h.state.s3.set("completions/DEV.json", JSON.stringify({ status: "done" }));
    const { body } = await post();
    expect(ticket("DEV").status).toBe("todo");
    expect(ticketWrites("DEV")).toHaveLength(0);
    expect(body.tickets.keptByRecord).toEqual(["DEV"]);
  });

  it("a CD-blocked follow-up with a completion record is kept as it is, never moved or rewritten", async () => {
    seedRun();
    h.state.s3.set("completions/FU2.json", JSON.stringify({ status: "done" }));
    const { body } = await post();
    expect(ticket("FU2")).toMatchObject({ parentId: "EPIC-1", status: "blocked", blockedBy: ["CD"], description: "" });
    expect(ticketWrites("FU2")).toHaveLength(0);
    expect(body.tickets.keptByRecord).toEqual(["FU2"]);
    expect(body.followUpsMoved).toBe(1);
    expect(ticket("FU1").parentId).toBe(body.postRunEpicKey);
  });

  it("an operator Ship ticket stamped phase ship is the CD even though its roster phase is development; a newer fix ticket is not", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([
      { ticketId: "SHIP", assignee: "agentcore_hub_operator", phase: "ship", status: "done", createdAt: "2026-01-02T00:00:00Z", updatedAt: "keep" },
      { ticketId: "FIX", assignee: "agentcore_hub_api_dev", phase: "ship", spawnedBy: { kind: "ship_fix" }, status: "done", createdAt: "2026-01-03T00:00:00Z" },
      { ticketId: "FU", assignee: "agentcore_hub_backend_dev", status: "blocked", blockedBy: ["SHIP"], title: "Harden the retry", description: "" },
    ]);
    const { body } = await post();
    expect(body.followUpsMoved).toBe(1);
    expect(ticket("FU")).toMatchObject({ parentId: body.postRunEpicKey, blockedBy: [], status: "todo" });
    expect(String(ticket("FU").description)).toContain("waiting only on CD ticket SHIP");
    expect(ticket("SHIP")).toMatchObject({ status: "done", updatedAt: "keep" });
    expect(ticketWrites("SHIP")).toHaveLength(0);
  });

  it("leaves a live agent session running, keeps the close-out pending, and a re-POST after release finishes it", async () => {
    seedRun();
    seed([{ ticketId: "LIVE", assignee: "agentcore_hub_backend_dev", status: "in_progress" }]);
    h.state.workflow.agentTasks = { LIVE: { status: "running" } };

    const first = await post({ reason: "stop" });
    expect(first.body.ticketsLeftRunning).toEqual(["LIVE"]);
    expect(first.body.closeoutPending).toBe(true);
    expect(first.body.followUpsMoved).toBe(2);
    expect(ticket("LIVE").status).toBe("in_progress");
    expect(ticket("EPIC-1")).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(h.state.workflow.cancelCloseoutLeaseUntil).toBeUndefined(); // lease released
    expect(String(h.state.workflow.cancelCloseoutError)).toMatch(/left running: LIVE/);
    const firstCancelledAt = first.body.cancelledAt;
    const fu1Desc = ticket("FU1").description;

    // The existing claim-release path frees the task.
    (h.state.workflow.agentTasks as Record<string, Record<string, unknown>>).LIVE.status = "failed";
    const second = await post({ reason: "ignored on resume" });
    expect(second.res.status).toBe(200);
    expect(second.body).toMatchObject({ resumed: true, cancelledAt: firstCancelledAt, reason: "stop", closeoutPending: false, ticketsLeftRunning: [] });
    expect(ticket("LIVE").status).toBe("cancelled");
    expect(ticket("EPIC-1").status).toBe("cancelled");
    expect(casUpdates()).toHaveLength(1); // no second CAS
    // Follow-ups count again on resume without being rewritten or a second epic.
    expect(second.body.followUpsMoved).toBe(2);
    expect(ticket("FU1").description).toBe(fu1Desc);
    expect(h.state.lambdaCalls).toHaveLength(1);
    expect(h.state.workflow.cancelCloseoutPending).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutCompletedAt).toBeTruthy();
    // The event was delivered on the first attempt: not re-sent.
    expect(h.state.putEvents).toHaveLength(1);
  });

  it("lease contention → 409 and no ticket writes", async () => {
    h.state.workflow = {
      workflowId: "wf-1",
      epicId: "EPIC-1",
      phase: "cancelled",
      cancelCloseoutPending: true,
      cancelledAt: "2026-01-01T00:00:00.000Z",
      cancelCloseoutLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    const { res, body } = await post();
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: "Cancel closeout already in progress" });
    expect(ticketWrites("DEV")).toHaveLength(0);
    expect(casUpdates()).toHaveLength(0);
  });

  it("resumes a pending cancel whose lease expired: stored cancelledAt/reason, no CAS", async () => {
    h.state.workflow = {
      workflowId: "wf-1",
      epicId: "EPIC-1",
      phase: "cancelled",
      previousPhase: "development",
      cancelCloseoutPending: true,
      cancelEventPending: true,
      cancelledAt: "2026-01-01T00:00:00.000Z",
      cancelReason: "original reason",
      cancelCloseoutLeaseUntil: new Date(Date.now() - 1000).toISOString(),
    };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    const { res, body } = await post({ reason: "new" });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ resumed: true, cancelledAt: "2026-01-01T00:00:00.000Z", reason: "original reason", closeoutPending: false, eventDelivered: true });
    expect(casUpdates()).toHaveLength(0);
    expect(ticket("DEV").status).toBe("cancelled");
    expect(h.state.eventPuts[0]).toMatchObject({ eventId: `${Date.parse("2026-01-01T00:00:00.000Z")}-cancelled` });
  });

  it("PutEvents failure keeps the event marker (and the close-out) pending; a resume re-sends the stored detail", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    h.state.putEventsResult = { FailedEntryCount: 1, Entries: [{ ErrorCode: "x" }] };

    const first = await post();
    expect(first.body.eventDelivered).toBe(false);
    expect(first.body.closeoutPending).toBe(true);
    expect(h.state.workflow.cancelEventPending).toBe(true);
    expect(h.state.workflow.cancelEventDeliveredAt).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    const stored = h.state.workflow.cancelEventDetail as Record<string, unknown>;
    expect(stored).toMatchObject({ workflowId: "wf-1", cancelledAt: first.body.cancelledAt, ticketsCancelled: 2 });

    h.state.putEventsResult = { FailedEntryCount: 0 };
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, eventDelivered: true, closeoutPending: false });
    expect(h.state.putEvents).toHaveLength(2);
    const entry = (h.state.putEvents[1].Entries as Array<Record<string, unknown>>)[0];
    expect(entry).toMatchObject({ Source: "agentcore-hub.orchestrator", DetailType: "workflow.cancelled" });
    expect(JSON.parse(String(entry.Detail))).toMatchObject({ ...stored, timestamp: first.body.cancelledAt });
    expect(h.state.workflow.cancelEventPending).toBeUndefined();
    expect(h.state.workflow.cancelEventDeliveredAt).toBeTruthy();
    // One stable events-table row id across both attempts.
    const ids = new Set(h.state.eventPuts.map((p) => p.eventId));
    expect([...ids]).toEqual([`${Date.parse(first.body.cancelledAt)}-cancelled`]);
  });

  it("PutEvents throwing is not delivered either", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    h.state.putEventsResult = new Error("throttled");
    const { body } = await post();
    expect(body.eventDelivered).toBe(false);
    expect(h.state.workflow.cancelEventPending).toBe(true);
  });
});

// ─── Codex review: replay-safe post-run epic + a surfaced lease release ──────

describe("TEAM-5421 Codex review — post-run epic replay safety (DynamoDB)", () => {
  function seedRun() {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([
      { ticketId: "CD", assignee: RM, status: "todo", createdAt: "2026-01-02T00:00:00Z" },
      { ticketId: "FU1", assignee: "human:engineer", status: "blocked", blockedBy: ["CD"], title: "Tighten the retry loop", description: "" },
      { ticketId: "FU2", assignee: "agentcore_hub_backend_dev", status: "blocked", blockedBy: ["CD"], title: "Escape the title", description: "" },
      { ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" },
    ]);
  }
  const creates = () => h.state.lambdaCalls.filter((c) => c.tool_name === "Tickets___create_ticket");
  const epics = () => [...h.state.tickets.values()].filter((t) => t.type === "epic" && t.title === "Post-run follow-ups wf-1");

  it("a crash between the epic create and the row claim: the retry reuses that epic instead of creating a second", async () => {
    seedRun();
    // create_ticket succeeds; the conditional write that stores postRunEpicKey dies.
    h.state.failWorkflowUpdate = (u) => String(u.UpdateExpression).includes("postRunEpicKey");
    const first = await post({ reason: "stop" });
    expect(first.res.status).toBe(200);
    expect(first.body).toMatchObject({ closeoutPending: true, followUpsMoved: 0 });
    expect(first.body.followUpsError).toMatch(/post-run epic/);
    expect(first.body.postRunEpicKey).toBeUndefined();
    expect(h.state.workflow.postRunEpicKey).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(creates()).toHaveLength(1);
    const [orphan] = epics();
    expect(orphan).toMatchObject({ workflowId: "wf-1", status: "todo" });
    expect(ticket("FU1")).toMatchObject({ parentId: "EPIC-1", status: "blocked", blockedBy: ["CD"] });

    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, closeoutPending: false, postRunEpicKey: orphan.ticketId, followUpsMoved: 2 });
    expect(creates()).toHaveLength(1); // no second epic
    expect(epics()).toHaveLength(1);
    expect(h.state.workflow.postRunEpicKey).toBe(orphan.ticketId);
    for (const id of ["FU1", "FU2"]) expect(ticket(id)).toMatchObject({ parentId: orphan.ticketId, blockedBy: [], status: "todo" });
    expect(ticket("EPIC-1").status).toBe("cancelled");
    expect(h.state.workflow.cancelCloseoutPending).toBeUndefined();
    // The lookup is a consistent read of the tickets table, filtered to this run's open epics with the exact summary.
    const scan = h.state.scans.at(-1)!;
    expect(scan.ConsistentRead).toBe(true);
    expect(String(scan.FilterExpression)).toMatch(/workflowId = :wf/);
    expect((scan.ExpressionAttributeValues as Record<string, unknown>)[":title"]).toBe("Post-run follow-ups wf-1");
  });

  it("a lookup that cannot answer fails the attempt (markers kept) and creates nothing; the retry creates exactly one", async () => {
    seedRun();
    h.state.failScan = true;
    const first = await post();
    expect(creates()).toHaveLength(0);
    expect(first.body).toMatchObject({ closeoutPending: true, followUpsMoved: 0 });
    expect(first.body.followUpsError).toMatch(/lookup failed, not creating one/);
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(ticket("FU1")).toMatchObject({ parentId: "EPIC-1", status: "blocked" });

    h.state.failScan = false;
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, closeoutPending: false, followUpsMoved: 2 });
    expect(creates()).toHaveLength(1);
    expect(epics()).toHaveLength(1);
  });

  it("a closed same-summary epic is not reused; the oldest OPEN one is", async () => {
    seedRun();
    const row = (ticketId: string, status: string, createdAt: string) =>
      h.state.tickets.set(ticketId, { ticketId, type: "epic", title: "Post-run follow-ups wf-1", workflowId: "wf-1", status, createdAt });
    row("E-CANCELLED", "cancelled", "2026-01-01T00:00:00Z");
    row("E-NEWER", "todo", "2026-01-03T00:00:00Z");
    row("E-OLDER", "todo", "2026-01-02T00:00:00Z");
    const { body } = await post();
    expect(creates()).toHaveLength(0);
    expect(body).toMatchObject({ postRunEpicKey: "E-OLDER", followUpsMoved: 2, closeoutPending: false });
    expect(ticket("E-NEWER").status).toBe("todo"); // found, not created here: never cancelled
  });

  it("an epic it only FOUND is left alone when the claim is lost to another writer", async () => {
    seedRun();
    h.state.tickets.set("ORPHAN", { ticketId: "ORPHAN", type: "epic", title: "Post-run follow-ups wf-1", workflowId: "wf-1", status: "todo", createdAt: "2026-01-01T00:00:00Z" });
    h.state.tickets.set("EPIC-WIN", { ticketId: "EPIC-WIN", status: "todo", type: "epic" });
    // Another attempt claims the row between this attempt's lookup and its claim (side-effect hook; the write itself proceeds and CCFs).
    h.state.failWorkflowUpdate = (u) => {
      if (String(u.UpdateExpression).includes("postRunEpicKey")) h.state.workflow.postRunEpicKey = "EPIC-WIN";
      return false;
    };
    const { body } = await post();
    expect(creates()).toHaveLength(0);
    expect(body.postRunEpicKey).toBe("EPIC-WIN");
    expect(ticket("ORPHAN").status).toBe("todo");
    expect(ticket("FU1").parentId).toBe("EPIC-WIN");
  });
});

describe("TEAM-5421 Codex review — a lease release that did not happen is reported as still pending", () => {
  const RELEASE = (u: Record<string, unknown>) => {
    const expr = String(u.UpdateExpression);
    return expr.includes("REMOVE") && expr.includes("cancelCloseoutLeaseUntil");
  };

  it("a failed release write: closeoutPending true + closeoutError, markers still on the row; the retry finishes once the lease is free", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    h.state.failWorkflowUpdate = RELEASE;
    const first = await post();
    expect(first.res.status).toBe(200);
    // The sweep itself was clean and the event went out...
    expect(first.body).toMatchObject({ status: "cancelled", eventDelivered: true, ticketsLeftRunning: [] });
    expect(first.body.tickets).toMatchObject({ cancelled: 2, failed: 0 });
    // ...but the markers were never cleared, so the close-out is NOT reported done.
    expect(first.body.closeoutPending).toBe(true);
    expect(first.body.closeoutError).toMatch(/close-out lease not released: injected workflows-table write failure/);
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(h.state.workflow.cancelEventPending).toBe(true);
    expect(h.state.workflow.cancelCloseoutLeaseUntil).toBeTruthy();
    expect(h.state.workflow.cancelCloseoutCompletedAt).toBeUndefined();

    // Still leased → a re-POST is refused; once the lease expires, the resume clears the markers.
    expect((await post()).res.status).toBe(409);
    h.state.workflow.cancelCloseoutLeaseUntil = new Date(Date.now() - 1000).toISOString();
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, closeoutPending: false, eventDelivered: true });
    expect(second.body.closeoutError).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutPending).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutLeaseUntil).toBeUndefined();
    expect(h.state.workflow.cancelCloseoutCompletedAt).toBeTruthy();
  });

  it("a lease another attempt took before the release: closeoutPending true, nothing on the row touched by this attempt", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    h.state.failWorkflowUpdate = (u) => {
      if (RELEASE(u)) h.state.workflow.cancelCloseoutLeaseUntil = "taken-by-another-attempt";
      return false;
    };
    const { body } = await post();
    expect(body.closeoutPending).toBe(true);
    expect(body.closeoutError).toMatch(/close-out lease lost before release/);
    expect(h.state.workflow).toMatchObject({ cancelCloseoutPending: true, cancelEventPending: true, cancelCloseoutLeaseUntil: "taken-by-another-attempt" });
    expect(h.state.workflow.cancelCloseoutCompletedAt).toBeUndefined();
  });

  it("a release that fails after a close-out error keeps BOTH reasons in closeoutError", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "EPIC-1", phase: "development" };
    seed([{ ticketId: "DEV", assignee: "agentcore_hub_backend_dev", status: "todo" }]);
    h.state.failTicketUpdate.add("DEV");
    h.state.failWorkflowUpdate = RELEASE;
    const { body } = await post();
    expect(body.closeoutPending).toBe(true);
    expect(body.closeoutError).toMatch(/1 ticket cancel\(s\) failed/);
    expect(body.closeoutError).toMatch(/close-out lease not released/);
  });
});
