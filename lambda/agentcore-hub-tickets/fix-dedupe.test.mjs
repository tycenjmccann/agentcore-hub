import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4100 F5 — create-time (workflow, findingId) uniqueness for fix tickets.
 *
 * spawnFixTicketsFromFindings does a cheap read-first sibling check, but two
 * verifier completions (e.g. review + codex) reporting the SAME component race:
 * both pass the read and both reach create_ticket, minting duplicate fix tickets.
 * The tickets Lambda closes this atomically with a dedupe item keyed
 * `dedupe#<wf>#finding#<fid>` written under attribute_not_exists BEFORE the real
 * ticket. This test drives the REAL handler through a stateful DDB stub that
 * honours the conditional put, so the concurrency + crash-takeover paths are
 * exercised for real.
 */

const h = vi.hoisted(() => ({
  state: {
    /** pk (ticketId) -> item, honouring attribute_not_exists on the dedupe claim. */
    store: /** @type {Map<string, any>} */ (new Map()),
    /** real (non-reserved) ticket Items that were actually persisted. */
    realPuts: /** @type {any[]} */ ([]),
    counter: 0,
    now: Date.now(),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("no S3 in this test"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  const conditionFail = () => { const e = new Error("conditional request failed"); e.name = "ConditionalCheckFailedException"; return e; };
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const s = h.state;
          const name = cmd.constructor.name;
          if (name === "GetCommand") {
            return { Item: s.store.get(cmd.input.Key.ticketId) || undefined };
          }
          if (name === "UpdateCommand") {
            const key = cmd.input.Key.ticketId;
            if (key === "__COUNTER__") { s.counter += 1; return { Attributes: { nextNum: s.counter } }; }
            if (key.startsWith("dedupe#")) {
              // finalize: dedupeStatus -> created, dedupeFor -> tid
              const cur = s.store.get(key) || { ticketId: key };
              const vals = cmd.input.ExpressionAttributeValues || {};
              s.store.set(key, { ...cur, dedupeStatus: vals[":created"], dedupeFor: vals[":tid"] });
              return {};
            }
            // linkFixToOrigin on an absent origin → the real Lambda swallows a 412.
            throw conditionFail();
          }
          if (name === "PutCommand") {
            const item = cmd.input.Item;
            if (cmd.input.ConditionExpression) {
              // The F5 dedupe claim: win iff absent OR a stale `pending` claim.
              const existing = s.store.get(item.ticketId);
              const staleBefore = (cmd.input.ExpressionAttributeValues || {})[":staleBefore"];
              const ok = !existing || (existing.dedupeStatus === "pending" && existing.claimedAtMs < staleBefore);
              if (!ok) throw conditionFail();
            } else if (!String(item.ticketId).startsWith("dedupe#") && item.ticketId !== "__COUNTER__") {
              s.realPuts.push(item);
            }
            s.store.set(item.ticketId, item);
            return {};
          }
          return {};
        },
      }),
    },
  };
});

let handler;

const create = (args) => handler({ name: "Tickets___create_ticket", arguments: args });
const errText = (r) => (r?.content?.[0]?.text ?? JSON.stringify(r));
const WF = "wf_dedupe";
const FID = "abc123def456"; // spawned_by.findingId
const FIX = { kind: "qa_fix", qaTicketId: "TEAM-9", findingId: FID };
const BASE = { summary: "Fix (auth): null check", assignee: "agentcore_hub_backend_dev", workflow_id: WF };

beforeEach(async () => {
  h.state.store = new Map();
  h.state.realPuts.length = 0;
  h.state.counter = 0;
  delete process.env.ARTIFACT_BUCKET;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("create_ticket — F5 fix-ticket dedupe (DynamoDB, atomic)", () => {
  it("two concurrent creates for the same finding → exactly one real ticket, the loser returns deduped with the same key", async () => {
    const [a, b] = await Promise.all([
      create({ ...BASE, spawned_by: FIX }),
      create({ ...BASE, spawned_by: FIX }),
    ]);
    expect(h.state.realPuts).toHaveLength(1);
    const winnerKey = h.state.realPuts[0].ticketId;
    const results = [a, b];
    const deduped = results.filter((r) => r.deduped);
    const wonResults = results.filter((r) => r.status === "created");
    expect(wonResults).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    // Both callers converge on the SAME key.
    expect(deduped[0].ticketId).toBe(winnerKey);
    expect(wonResults[0].key).toBe(winnerKey);
    // The dedupe lease settled to `created`.
    const lease = h.state.store.get(`dedupe#${WF}#finding#${FID}`);
    expect(lease).toMatchObject({ dedupeStatus: "created", dedupeFor: winnerKey });
  });

  it("a second create after the first settled → deduped to the same key, no new ticket", async () => {
    const first = await create({ ...BASE, spawned_by: FIX });
    expect(h.state.realPuts).toHaveLength(1);
    const second = await create({ ...BASE, spawned_by: FIX });
    expect(second.deduped).toBe(true);
    expect(second.ticketId).toBe(first.key);
    expect(h.state.realPuts).toHaveLength(1); // no second real ticket
  });

  it("a stale `pending` claim (crashed creator, older than 60s) is taken over → a real ticket IS created", async () => {
    const key = `dedupe#${WF}#finding#${FID}`;
    h.state.store.set(key, { ticketId: key, dedupeStatus: "pending", dedupeFor: "TEAM-orphan", claimedAtMs: Date.now() - 120000 });
    const res = await create({ ...BASE, spawned_by: FIX });
    expect(res.status).toBe("created"); // not deduped — the stale claim was seized
    expect(h.state.realPuts).toHaveLength(1);
    // The lease now points at the real ticket, marked created.
    expect(h.state.store.get(key)).toMatchObject({ dedupeStatus: "created", dedupeFor: res.key });
  });

  it("a FRESH `pending` claim (<60s) blocks a racing create → deduped to the in-flight id", async () => {
    const key = `dedupe#${WF}#finding#${FID}`;
    h.state.store.set(key, { ticketId: key, dedupeStatus: "pending", dedupeFor: "TEAM-inflight", claimedAtMs: Date.now() - 1000 });
    const res = await create({ ...BASE, spawned_by: FIX });
    expect(res.deduped).toBe(true);
    expect(res.ticketId).toBe("TEAM-inflight");
    expect(h.state.realPuts).toHaveLength(0);
  });

  it("a create with no findingId writes NO dedupe item and always creates", async () => {
    await create({ ...BASE }); // no spawned_by
    await create({ ...BASE, spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-9" } }); // fix, but no findingId
    expect(h.state.realPuts).toHaveLength(2);
    const dedupeItems = [...h.state.store.keys()].filter((k) => k.startsWith("dedupe#"));
    expect(dedupeItems).toHaveLength(0);
  });

  it("different findings in the same workflow are independent (no cross-dedupe)", async () => {
    await create({ ...BASE, spawned_by: { ...FIX, findingId: "finding-1" } });
    await create({ ...BASE, spawned_by: { ...FIX, findingId: "finding-2" } });
    expect(h.state.realPuts).toHaveLength(2);
  });

  it("does not surface dedupe rows in search/list results", async () => {
    await create({ ...BASE, spawned_by: FIX });
    const listed = await handler({ name: "Tickets___list_tickets", arguments: { workflow_id: WF } });
    const keys = (listed.issues || []).map((i) => i.key);
    expect(keys.every((k) => !String(k).startsWith("dedupe#"))).toBe(true);
    expect(errText(listed)).not.toContain("dedupe#");
  });
});
