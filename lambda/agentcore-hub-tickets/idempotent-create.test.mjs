import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-5712: create_ticket's `client_token` (dynamodb twin).
 *
 * The runtime harness files an escalation and botocore can re-send the Lambda
 * Invoke after the first invoke's Put already landed — the counter then minted a
 * second ticket for the same escalation. With a token, the create writes a lock
 * row `IDEMP#<token>` (attribute_not_exists) recording the id it reserved, and the
 * ticket Put is conditional too, so any replay — sequential, after a partial
 * failure, or concurrent — converges on ONE ticket under ONE id.
 *
 * Mocked: the AWS seams only, as an in-memory table that honours
 * attribute_not_exists on Put, sparse GSIs (a row without the index key is not in
 * the index) and a base-table Scan that returns every row — the one read path a
 * lock row could leak through.
 */

const h = vi.hoisted(() => ({
  state: {
    table: /** @type {Map<string, any>} */ (new Map()),
    counter: 0,
    /** Throw on the next ticket (non-lock) Put, once — a partial failure. */
    failNextTicketPut: false,
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { throw new Error("no pipeline tools here"); } },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  const condFail = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          // Yield first, so two concurrent creates interleave at every call; the
          // condition below is then evaluated atomically, as DynamoDB does.
          await new Promise((r) => setImmediate(r));
          const name = cmd.constructor.name;
          const t = h.state.table;
          if (name === "UpdateCommand") {
            if (cmd.input.Key.ticketId === "__COUNTER__") {
              h.state.counter += 1;
              t.set("__COUNTER__", { ticketId: "__COUNTER__", nextNum: h.state.counter });
              return { Attributes: { nextNum: h.state.counter } };
            }
            return {};
          }
          if (name === "PutCommand") {
            const item = cmd.input.Item;
            if (item.eventId) return {};
            if (!String(item.ticketId).startsWith("IDEMP#") && h.state.failNextTicketPut) {
              h.state.failNextTicketPut = false;
              throw Object.assign(new Error("ProvisionedThroughputExceededException"), { name: "ProvisionedThroughputExceededException" });
            }
            if (/attribute_not_exists\(ticketId\)/.test(cmd.input.ConditionExpression || "") && t.has(item.ticketId)) throw condFail();
            t.set(item.ticketId, clone(item));
            return {};
          }
          if (name === "GetCommand") return { Item: clone(t.get(cmd.input.Key.ticketId)) };
          if (name === "QueryCommand") {
            const attr = cmd.input.IndexName === "assignee-index" ? "assignee" : "parentId";
            const want = Object.values(cmd.input.ExpressionAttributeValues)[0];
            return { Items: [...t.values()].filter((i) => i[attr] !== undefined && i[attr] === want).map(clone) };
          }
          if (name === "ScanCommand") {
            let items = [...t.values()];
            if (cmd.input.FilterExpression === "#s = :s") items = items.filter((i) => i.status === cmd.input.ExpressionAttributeValues[":s"]);
            return { Items: items.map(clone) };
          }
          return {};
        },
      }),
    },
  };
});

let handler;
const call = (name, args) => handler({ name: `Tickets___${name}`, arguments: args });
const create = (args) => call("create_ticket", args);

const EPIC = "TEAM-900";
const TOKEN = "hfe-0123456789abcdef0123456789abcdef";
const ESCALATION = {
  summary: "Harness: TEAM-5696 persona ended without report_completion",
  description: "harness-synthesised: escalation",
  parent_key: EPIC,
  assignee: "human:engineer",
  workflow_id: "wf_test",
  labels: ["harness-synthesised"],
};

const tickets = () => [...h.state.table.values()].filter((i) => i.ticketId !== "__COUNTER__" && !String(i.ticketId).startsWith("IDEMP#"));
const locks = () => [...h.state.table.values()].filter((i) => String(i.ticketId).startsWith("IDEMP#"));

beforeEach(async () => {
  h.state.table = new Map();
  h.state.counter = 0;
  h.state.failNextTicketPut = false;
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.PIPELINE_TOOLS_LAMBDA;
  delete process.env.EVENTS_TABLE;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("TEAM-5712 — create_ticket client_token", () => {
  it("(a) the same token twice files ONE ticket and returns the same id both times", async () => {
    const first = await create({ ...ESCALATION, client_token: TOKEN });
    const second = await create({ ...ESCALATION, client_token: TOKEN });
    expect(first.key, JSON.stringify(first)).toMatch(/^TEAM-\d+$/);
    expect(second.key).toBe(first.key);
    expect(second.status).toBe("created");
    expect(second.idempotent).toBe(true);
    expect(second.ticket?.key).toBe(first.key);
    expect(tickets()).toHaveLength(1);
  });

  it("(b) the lock row is invisible to every list/search/get path", async () => {
    const made = await create({ ...ESCALATION });
    // Seeded, in the shape the create writes, so the READ paths are what is tested.
    const lockKey = `IDEMP#${TOKEN}`;
    h.state.table.set(lockKey, { ticketId: lockKey, reservedTicketId: made.key, lockedAt: "2026-10-13T00:00:00.000Z", ttl: 1792000000 });
    const keysOf = (res) => (res.issues || []).map((i) => i.key);

    for (const res of [
      await call("list_tickets", {}),                                  // fallback Scan
      await call("list_tickets", { parent_id: EPIC }),
      await call("list_tickets", { assignee: "human:engineer" }),
      await call("search_issues", {}),                                 // fallback Scan
      await call("search_issues", { query: "status = todo" }),         // filtered Scan
      await call("search_issues", { query: `parent = ${EPIC}` }),
      await call("search_issues", { query: "assignee = human:engineer" }),
    ]) {
      expect(keysOf(res), JSON.stringify(res)).not.toContain(lockKey);
      expect(keysOf(res).every((k) => /^TEAM-\d+$/.test(k)), JSON.stringify(res)).toBe(true);
    }
    expect(keysOf(await call("list_tickets", {}))).toContain(made.key);

    const got = await call("get_issue", { issue_key: lockKey });
    expect(got.key).toBeUndefined();
    expect(got.content?.[0]?.text).toMatch(/not found/i);
  });

  it("(c) the lock row carries a ttl ~7 days out and no ticket attributes", async () => {
    const before = Math.floor(Date.now() / 1000);
    const made = await create({ ...ESCALATION, client_token: TOKEN });
    const [lock] = locks();
    expect(lock, "a lock row is written").toBeDefined();
    expect(lock.ticketId).toBe(`IDEMP#${TOKEN}`);
    expect(lock.reservedTicketId).toBe(made.key);
    expect(typeof lock.ttl).toBe("number");
    expect(lock.ttl).toBeGreaterThanOrEqual(before + 7 * 86400 - 5);
    expect(lock.ttl).toBeLessThanOrEqual(before + 7 * 86400 + 60);
    for (const attr of ["status", "assignee", "parentId", "workflowId", "type", "title", "createdAt", "updatedAt"]) {
      expect(lock, `lock row must not carry ${attr}`).not.toHaveProperty(attr);
    }
  });

  it("(d) a retry after a partial failure (lock written, ticket Put failed) files the ticket once, under the reserved id", async () => {
    h.state.failNextTicketPut = true;
    const failed = await create({ ...ESCALATION, client_token: TOKEN });
    expect(failed.content?.[0]?.text, "the first attempt surfaces the failure").toMatch(/^Error:/);
    expect(tickets()).toHaveLength(0);

    const retried = await create({ ...ESCALATION, client_token: TOKEN });
    expect(retried.key).toBe("TEAM-1");             // the id the first attempt reserved
    expect(tickets().map((t) => t.ticketId)).toEqual(["TEAM-1"]);
    expect(locks()[0]?.reservedTicketId).toBe("TEAM-1");

    const again = await create({ ...ESCALATION, client_token: TOKEN });
    expect(again.key).toBe("TEAM-1");
    expect(tickets()).toHaveLength(1);
  });

  it("(e) two concurrent writers with one token file ONE ticket and both get its id", async () => {
    const [a, b] = await Promise.all([
      create({ ...ESCALATION, client_token: TOKEN }),
      create({ ...ESCALATION, client_token: TOKEN }),
    ]);
    expect(a.key, JSON.stringify(a)).toMatch(/^TEAM-\d+$/);
    expect(b.key).toBe(a.key);
    expect(tickets()).toHaveLength(1);
  });

  it("(f) no token: no lock row, and two creates are two tickets (unchanged)", async () => {
    const a = await create({ ...ESCALATION });
    const b = await create({ ...ESCALATION });
    expect(a.key).not.toBe(b.key);
    expect(tickets()).toHaveLength(2);
    expect(locks()).toHaveLength(0);
  });

  it.each([["short"], ["has space in it"], ["IDEMP#nested"], [42], ["x".repeat(129)]])(
    "(g) a malformed token %j is refused before an id is minted",
    async (bad) => {
      const res = await create({ ...ESCALATION, client_token: bad });
      expect(res.content?.[0]?.text).toMatch(/^Error: .*client_token/);
      expect(h.state.counter, "no ticket id was minted").toBe(0);
      expect(tickets()).toHaveLength(0);
    }
  );
});
