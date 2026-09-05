import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3991 D2.2 — the parked→fix EDGE that create_ticket must write.
 *
 * index.test.mjs pins that the `spawned_by` marker is persisted on the FIX
 * ticket. That marker alone is what wf 1pl3h1 already had, and it was not enough:
 * TEAM-3727 (the origin) stayed `blocked` with an empty `blockedBy`, so when its
 * fix closed nothing in the cascade could see that the blocker had cleared, and a
 * human had to dispatch it twice. The missing half is the reverse edge — the
 * ORIGIN becomes blockedBy the fix — which is what makes the fix's completion an
 * unblock event for the origin.
 *
 * Contract under test:
 *   - a valid origin key (gateTicketId|qaTicketId|codexTicketId) → one scoped
 *     UpdateCommand on the ORIGIN with list_append + an idempotency/closed guard;
 *   - the guard losing (already linked, or origin done/cancelled) is a NO-OP: the
 *     fix ticket is still created and the tool still returns success;
 *   - no marker → no edge at all (byte-for-byte the old behavior).
 *
 * Harness: the §3(a) shape of index.test.mjs (stub DDB doc client, no AWS), with
 * the UpdateCommands split by target — the id counter's bump vs the edge write.
 */

const COUNTER_KEY_MARKER = "nextNum";

const h = vi.hoisted(() => ({
  state: {
    puts: /** @type {any[]} */ ([]),
    edges: /** @type {any[]} */ ([]),
    counter: 0,
    /** Set to an error name to make the NEXT edge UpdateCommand throw. */
    edgeError: /** @type {string | null} */ (null),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "UpdateCommand") {
            // Two distinct UpdateCommand callers: nextTicketId's counter bump
            // (ExpressionAttributeNames #n → nextNum) and the blockedBy edge.
            const isCounter = Object.values(cmd.input.ExpressionAttributeNames || {}).includes(COUNTER_KEY_MARKER);
            if (isCounter) {
              h.state.counter += 1;
              return { Attributes: { nextNum: h.state.counter } };
            }
            if (h.state.edgeError) {
              const err = new Error("condition failed");
              err.name = h.state.edgeError;
              h.state.edgeError = null;
              throw err;
            }
            h.state.edges.push(cmd.input);
            return {};
          }
          if (name === "PutCommand") { h.state.puts.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

let handler;

const create = (args) => handler({ name: "Tickets___create_ticket", arguments: args });
/** createTicket returns the ticket envelope on success; errors come back as textResult. */
const ok = (res) => res?.status === "created" && res.key;

beforeEach(async () => {
  h.state.puts.length = 0;
  h.state.edges.length = 0;
  h.state.counter = 0;
  h.state.edgeError = null;
  delete process.env.ARTIFACT_BUCKET;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

const QA_FIX = {
  summary: "Fix the null check QA found",
  assignee: "agentcore_hub_backend_dev",
  spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-3727" },
  phase: "development",
};

describe("create_ticket writes the origin→fix blockedBy edge (D2.2)", () => {
  it("wf 1pl3h1 shape: a qa_fix names TEAM-3727 → TEAM-3727 becomes blockedBy the new fix", async () => {
    const res = await create(QA_FIX);
    expect(ok(res)).toBeTruthy();

    const fixId = h.state.puts[0].ticketId;
    expect(fixId).toBe("TEAM-1");

    expect(h.state.edges).toHaveLength(1);
    const edge = h.state.edges[0];
    expect(edge.Key).toEqual({ ticketId: "TEAM-3727" });
    // Append, never overwrite — the origin may already be blockedBy other work.
    expect(edge.UpdateExpression).toContain("list_append(if_not_exists(blockedBy, :empty), :fixList)");
    expect(edge.ExpressionAttributeValues[":fixList"]).toEqual([fixId]);
    expect(edge.ExpressionAttributeValues[":fixId"]).toBe(fixId);
    expect(edge.ExpressionAttributeValues[":empty"]).toEqual([]);
    // Idempotent (no duplicate edge on a retried create) AND never re-opens a
    // closed origin.
    expect(edge.ConditionExpression).toContain("NOT contains(blockedBy, :fixId)");
    expect(edge.ConditionExpression).toContain("#s <> :done");
    expect(edge.ConditionExpression).toContain("#s <> :cancelled");
    expect(edge.ExpressionAttributeNames).toMatchObject({ "#s": "status" });
    expect(typeof edge.ExpressionAttributeValues[":now"]).toBe("string");
    // The fix ticket still carries the marker completion.mjs reads.
    expect(h.state.puts[0].spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-3727" });
  });

  it("each origin key is honored: gateTicketId (review_fix) and codexTicketId (codex_fix)", async () => {
    await create({ ...QA_FIX, spawned_by: { kind: "review_fix", gateTicketId: "TEAM-19" } });
    await create({ ...QA_FIX, spawned_by: { kind: "codex_fix", codexTicketId: "TEAM-44" } });
    expect(h.state.edges.map((e) => e.Key.ticketId)).toEqual(["TEAM-19", "TEAM-44"]);
  });

  it("the guard losing (already linked / origin closed) does NOT fail the create", async () => {
    h.state.edgeError = "ConditionalCheckFailedException";

    const res = await create(QA_FIX);

    expect(ok(res)).toBeTruthy();
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.edges).toHaveLength(0);
  });

  it("an unexpected DDB error on the edge is swallowed too — the fix ticket is what matters", async () => {
    h.state.edgeError = "ProvisionedThroughputExceededException";

    const res = await create(QA_FIX);

    expect(ok(res)).toBeTruthy();
    expect(h.state.puts).toHaveLength(1);
  });

  it("no spawned_by → no edge write at all (unchanged for ordinary tickets)", async () => {
    const res = await create({ summary: "Ordinary task", assignee: "agentcore_hub_backend_dev" });
    expect(ok(res)).toBeTruthy();
    expect(h.state.edges).toHaveLength(0);
    expect(h.state.puts[0].spawnedBy).toBeUndefined();
  });

  it("a marker with a kind but no origin id → no edge (nothing to point at)", async () => {
    await create({ ...QA_FIX, spawned_by: { kind: "qa_fix" } });
    expect(h.state.edges).toHaveLength(0);
    expect(h.state.puts[0].spawnedBy).toEqual({ kind: "qa_fix" });
  });

  it("spawned_by.by / findingId are persisted but never used as the origin", async () => {
    await create({
      ...QA_FIX,
      spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-3727", by: "agentcore_hub_qa_verifier", findingId: "F3", junk: "x" },
    });
    expect(h.state.puts[0].spawnedBy).toEqual({
      kind: "qa_fix",
      qaTicketId: "TEAM-3727",
      by: "agentcore_hub_qa_verifier",
      findingId: "F3",
    });
    expect(h.state.edges[0].Key).toEqual({ ticketId: "TEAM-3727" });
  });
});
