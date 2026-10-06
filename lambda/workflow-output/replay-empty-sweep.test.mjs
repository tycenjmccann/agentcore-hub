import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * TEAM-5323 replay — an empty sweep that paged a human for a merge that would
 * never exist (33rea7 / TEAM-5209, f7jj7j / TEAM-5287).
 *
 * Three pieces of REAL code, chained, with only the AWS seams mocked:
 *
 *   1. workflow-output's `handler` takes the sweeper's report_completion
 *      {outcome:"empty_sweep"} and runs the skip pass;
 *   2. every Tickets___* call it makes is routed by FunctionName into the real
 *      tickets twin `handler` — so the skip of a decision-bound gate goes through
 *      gateConditionCleared → decisionCleared → skipExempt → judgeSkipRecord /
 *      sweeperProvesSkip exactly as in production, no stub in between;
 *   3. every status write to `done` runs the real orchestrator cascade
 *      (createCascade().cascadeUnblock) at that moment, as the DynamoDB stream does.
 *
 * One stateful store backs all three: the S3 map workflow-output writes records
 * into is the one the twin reads them from, and the tickets table rows are the ones
 * the twin and the cascade both move. Nothing is hand-seeded under completions/ for
 * the run under replay — the sweeper's record and every skip record are whatever
 * workflow-output really wrote (f7jj7j's priorCompletions are the EARLIER pass).
 *
 * "0 review.needed": the orchestrator emits review.needed when a human ticket
 * reaches ready (handleHumanReviewGate). So the assertion is that no cascade ever
 * readied a human:* ticket.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "hub-artifacts";
  process.env.TICKET_PROVIDER = "dynamodb";
  process.env.TICKET_TOOLS_LAMBDA = "agentcore-hub-tickets";
  process.env.TICKETS_TABLE = "agentcore-hub-tickets";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.AWS_REGION = "us-east-1";
  process.env.GATE_DECISION_KEY = "replay-gate-decision-key-0123456789abcdef";
  return {
    items: /** @type {Record<string, any>} */ ({}),
    objects: /** @type {Map<string, string>} */ (new Map()),
    s3Puts: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    doneWrites: /** @type {string[]} */ ([]),
    readied: /** @type {{ticketId: string, assignee: string, by: string}[]} */ ([]), // every cascade Ready write
    cascadeEvents: /** @type {any[]} */ ([]),
    onPut: /** @type {((key: string) => void) | null} */ (null),
    twin: /** @type {any} */ (null),
    cascade: /** @type {any} */ (null),
    parentOf: /** @type {(id: string) => string} */ (() => ""),
  };
});

const asString = (body) => (typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
const noSuchKey = (key) => {
  const err = new Error(`The specified key does not exist: ${key}`);
  err.name = "NoSuchKey";
  err.$metadata = { httpStatusCode: 404 };
  return err;
};

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input || {};
      if (name === "PutObjectCommand") {
        h.s3Puts.push(input);
        h.objects.set(input.Key, asString(input.Body));
        if (h.onPut) h.onPut(input.Key);
        return { ETag: `"e${h.s3Puts.length}"` };
      }
      if (name === "DeleteObjectCommand") {
        h.objects.delete(input.Key);
        return {};
      }
      if (name === "ListObjectsV2Command") {
        return { Contents: [...h.objects.keys()].filter((k) => k.startsWith(input.Prefix || "")).map((Key) => ({ Key })) };
      }
      if (!h.objects.has(input.Key)) throw noSuchKey(input.Key);
      const body = h.objects.get(input.Key);
      if (name === "HeadObjectCommand") return { ContentLength: body.length };
      return { Body: { transformToString: async () => body, transformToByteArray: async () => Buffer.from(body) } };
    }
  },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; } },
  DeleteObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    async send() {
      const err = new Error("not authorized");
      err.name = "AccessDeniedException";
      throw err;
    }
  },
  GetSecretValueCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      // The ticket-tools Lambda is the real twin. Anything else (the pipeline-tools
      // probe) is unreachable, which the twin reads as `indeterminate`.
      if (cmd.input.FunctionName !== process.env.TICKET_TOOLS_LAMBDA) {
        const err = new Error("connect ETIMEDOUT");
        err.name = "TimeoutError";
        throw err;
      }
      const out = await h.twin(req);
      return { Payload: new TextEncoder().encode(JSON.stringify(out ?? null)) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }

  const conditionalFailure = () => {
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    return err;
  };

  /**
   * The parts of an UpdateCommand the twin's transition / comment paths and the
   * cascade's Ready write use, applied to the row. A write that lands `done` runs
   * the real cascade before returning — the DynamoDB stream, in-line.
   */
  async function apply(input, by) {
    const row = h.items[input.Key.ticketId];
    const v = input.ExpressionAttributeValues || {};
    if (!row) return;
    if (/#s = :cur/.test(input.ConditionExpression || "") && row.status !== v[":cur"]) throw conditionalFailure();
    for (const k of [":dcm", ":cmts", ":comment"]) {
      if (Array.isArray(v[k])) row.comments = [...(row.comments || []), ...v[k]];
    }
    if (Array.isArray(v[":vfy"])) row.labels = [...(row.labels || []), ...v[":vfy"]];
    if (v[":s"] === undefined) return;
    row.status = v[":s"];
    // The cascade's only write is its Ready move (`todo` in the DynamoDB provider:
    // the stream's todo-with-blockers-resolved is the dispatch trigger).
    if (by === "cascade") h.readied.push({ ticketId: row.ticketId, assignee: row.assignee, by });
    if (row.status === "done") {
      h.doneWrites.push(row.ticketId);
      await h.cascade.cascadeUnblock(row.ticketId, row.parentId, { workflowId: row.workflowId, id: row.workflowId });
    }
  }

  const client = (by) => ({
    send: async (cmd) => {
      const name = cmd.constructor.name;
      const input = cmd.input || {};
      if (name === "UpdateCommand") {
        const v = input.ExpressionAttributeValues || {};
        if (v[":s"] !== undefined || v[":comment"] !== undefined || v[":cmts"] !== undefined || v[":dcm"] !== undefined) {
          await apply(input, by);
          return {};
        }
        return {};
      }
      if (name === "GetCommand") {
        if (input.TableName !== process.env.TICKETS_TABLE) return {};
        const row = h.items[input.Key.ticketId];
        return { Item: row ? structuredClone(row) : undefined };
      }
      if (name === "PutCommand") {
        if (input.TableName === process.env.EVENTS_TABLE) h.events.push(input.Item);
        return {};
      }
      if (name === "QueryCommand") {
        const pid = input.ExpressionAttributeValues?.[":pid"];
        if (pid === undefined) return { Items: [] };
        return { Items: Object.values(h.items).filter((r) => r.parentId === pid).map((r) => structuredClone(r)) };
      }
      if (name === "ScanCommand") return { Items: [] };
      return {};
    },
  });

  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: { from: () => client("twin"), cascadeClient: client("cascade") },
  };
});

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const agentsJson = readFileSync(new URL("../../src/config/agents.json", import.meta.url), "utf8");

const { handler: workflowOutput } = await import("./index.mjs");
const { handler: twin } = await import("../agentcore-hub-tickets/index.mjs");
const { createCascade } = await import("../orchestrator/cascade.mjs");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
h.twin = twin;

/** Load a ticket fixture into the shared table (and its earlier pass's records into S3). */
function seed(name, over = {}) {
  const fx = fixture(name);
  expect(fx.synthetic).toBe(true);
  for (const t of fx.tickets) h.items[t.ticketId] = { ...structuredClone(t), ...(over[t.ticketId] || {}) };
  for (const [id, rec] of Object.entries(fx.priorCompletions || {})) h.objects.set(`completions/${id}.json`, JSON.stringify(rec));
  return fx;
}

const sweep = (ticketId, workflowId) =>
  workflowOutput({
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: ticketId, workflow_id: workflowId, agent_id: "agentcore_hub_code_sweeper",
      summary: "EMPTY SWEEP — 0 verified removals; every candidate is still referenced.",
      outcome: "empty_sweep",
    },
  });
const result = (res) => JSON.parse(res.content[0].text);
const recordOf = (id) => (h.objects.has(`completions/${id}.json`) ? JSON.parse(h.objects.get(`completions/${id}.json`)) : undefined);
const humanReadied = () => h.readied.filter((r) => String(r.assignee).startsWith("human:"));
const twinCall = (name, args) => twin({ name, arguments: args });

beforeEach(() => {
  h.items = {};
  h.objects = new Map([["config/agents.json", agentsJson]]);
  h.s3Puts.length = 0;
  h.events.length = 0;
  h.doneWrites.length = 0;
  h.readied.length = 0;
  h.cascadeEvents.length = 0;
  h.onPut = null;
  h.cascade = createCascade({
    ddb: DynamoDBDocumentClient.cascadeClient,
    ticketsTable: process.env.TICKETS_TABLE,
    provider: "dynamodb",
    jiraTransition: async () => {},
    getChildTickets: async (parentId) => Object.values(h.items).filter((r) => r.parentId === parentId).map((r) => structuredClone(r)),
    publishEvent: async (...args) => { h.cascadeEvents.push(args); },
    log: () => {},
    sleep: async () => {},
  });
});

describe("33rea7 replay — the sweeper TEAM-5204 reports an empty sweep", () => {
  const WF = "wf_1790592080841_33rea7";
  const SWEEPER = "TEAM-5204";
  const GATE = "TEAM-5209";

  it("33rea7 replay: 0 review.needed, TEAM-5209 Done skipped within 10s", async () => {
    seed("tickets-33rea7-synthetic.json");
    const started = performance.now();
    const res = result(await sweep(SWEEPER, WF));
    const elapsed = performance.now() - started;

    expect(res.status).toBe("complete");
    // Dependents first: the gate goes before the Ship ticket it waits on.
    expect(res.emptySweepSkipped).toEqual(["TEAM-5211", "TEAM-5210", GATE, "TEAM-5208", "TEAM-5207", "TEAM-5206", "TEAM-5205"]);
    expect(res).not.toHaveProperty("emptySweepFailed");
    // The typed deploy gate is not this sweep's to close. The DynamoDB twin's
    // get_issue / list_tickets carry no labels, so here it is kept out by having no
    // in-run blocker (it mirrors a pipeline approval), not by its gate: label — the
    // label path is index.test.mjs's, in the Jira shape that does carry labels.
    expect(res.emptySweepLeft).toEqual([{ ticketId: "TEAM-5212", why: "no_blockers" }]);
    expect(h.items["TEAM-5212"].status).toBe("in_review");

    expect(h.items[GATE].status).toBe("done");
    expect(recordOf(GATE)).toMatchObject({
      ticketId: GATE, workflowId: WF, sweeperTicketId: SWEEPER,
      evidence_kind: "skipped", skipped: true, reason: "empty_sweep", transition_id: "skip",
    });
    // The sweeper's own record names its run — what sweeperProvesSkip trusts.
    expect(recordOf(SWEEPER)).toMatchObject({ ticket_id: SWEEPER, workflowId: WF, status: "complete", outcome: "empty_sweep" });
    expect(h.doneWrites.at(-1)).toBe(SWEEPER);

    expect(humanReadied()).toEqual([]);
    expect(h.events.filter((e) => e.type === "review.needed" || e.type === "review.reawakened")).toEqual([]);
    expect(elapsed).toBeLessThanOrEqual(10_000);
  });

  it("R-8: decision guard on — the sweep's skip is admitted by the real twin, a plain done is refused", async () => {
    // The gate already paged (in_review), as in the real run.
    seed("tickets-33rea7-synthetic.json", { [GATE]: { status: "in_review" } });
    const refused = await twinCall("Tickets___transition_ticket", { ticket_id: GATE, transition_id: "done", reason: "Skipped: empty_sweep" });
    expect(refused).toMatchObject({ ok: false, reason: "decision_required", options: ["approve", "approve-with-known-findings"] });
    expect(h.items[GATE].status).toBe("in_review");

    const res = result(await sweep(SWEEPER, WF));

    expect(res.emptySweepSkipped).toContain(GATE);
    expect(h.items[GATE].status).toBe("done");
    // A sweep skip is not a human decision: no DECISION comment, and no
    // merge-approval record that could later stand in as ship-approval proof.
    expect(h.items[GATE].comments.some((c) => /DECISION:/.test(c.content))).toBe(false);
    expect(h.s3Puts.filter((p) => p.Key.startsWith("pipeline-artifacts/gate-decisions/"))).toEqual([]);
  });

  it("R-8 negative: under the old order (skip before the sweeper record) the twin refuses", async () => {
    seed("tickets-33rea7-synthetic.json");
    // Test-only: take the sweeper's record away the moment the gate's skip record
    // lands — the state the pre-5323 order (skip pass before the record write)
    // always presented to the twin.
    h.onPut = (key) => { if (key === `completions/${GATE}.json`) h.objects.delete(`completions/${SWEEPER}.json`); };

    const res = result(await sweep(SWEEPER, WF));

    expect(res.emptySweepFailed).toEqual([{ ticketId: GATE, reason: expect.stringMatching(/decision-bound human gate.*\(no_decision\)/) }]);
    expect(h.items[GATE].status).not.toBe("done");
    // …and then the Ship ticket's skip cascades it to ready: the real run's
    // review.needed for TEAM-5209, reproduced.
    expect(humanReadied().map((r) => r.ticketId)).toEqual([GATE]);
  });
});

describe("f7jj7j replay — a retried sweep report by TEAM-5282", () => {
  const WF = "wf_1791195796673_f7jj7j";
  const SWEEPER = "TEAM-5282";
  const GATE = "TEAM-5287";

  it("f7jj7j replay: TEAM-5287 admitted because TEAM-5286 is Done with a skip record", async () => {
    seed("tickets-f7jj7j-synthetic.json");
    const started = performance.now();
    const res = result(await sweep(SWEEPER, WF));
    const elapsed = performance.now() - started;

    expect(res.status).toBe("complete");
    expect(res.emptySweepSkipped).toEqual([GATE]);
    expect(res).not.toHaveProperty("emptySweepFailed");
    expect(res).not.toHaveProperty("emptySweepLeft");
    expect(h.items[GATE].status).toBe("done");
    // Same record, same reason as 33rea7 — the retry is not a different kind of skip.
    expect(recordOf(GATE)).toEqual({
      ticketId: GATE, workflowId: WF, sweeperTicketId: SWEEPER,
      summary: `Skipped: empty_sweep — no removals found by ${SWEEPER}`,
      evidence_kind: "skipped", skipped: true, reason: "empty_sweep", transition_id: "skip",
    });
    expect(humanReadied()).toEqual([]);
    expect(h.events.filter((e) => e.type === "review.needed")).toEqual([]);
    expect(elapsed).toBeLessThanOrEqual(10_000);
  });

  it("a Done blocker whose record is from another run does not admit the gate", async () => {
    const fx = seed("tickets-f7jj7j-synthetic.json");
    h.objects.set("completions/TEAM-5286.json", JSON.stringify({ ...fx.priorCompletions["TEAM-5286"], workflowId: "wf_someone_else" }));

    const res = result(await sweep(SWEEPER, WF));

    expect(res.emptySweepLeft).toEqual([{ ticketId: GATE, why: "blocker_not_skipped: TEAM-5286" }]);
    expect(h.items[GATE].status).toBe("in_review");
    expect(recordOf(GATE)).toBeUndefined();
  });
});
