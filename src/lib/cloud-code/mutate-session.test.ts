import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CloudCodeSession } from "./types";

/**
 * mutateSession is the optimistic-concurrency CAS that serializes the two writers
 * that race on an interrupted turn: the /message stream completing and the /stop
 * persist, both rewriting the same row. A plain read-modify-write loses one
 * update; this rev-guarded conditional Put must retry and preserve both.
 *
 * We mock ONLY the AWS SDK — an in-memory table that enforces the same
 * `attribute_not_exists(#rev) OR #rev = :prev` condition DynamoDB does — so the
 * real mutateSession code runs against realistic conditional-write semantics with
 * no network. `controller` lets a test inject a competing write mid-flight.
 */
const h = vi.hoisted(() => {
  class ConditionalCheckFailedException extends Error {
    constructor() {
      super("The conditional request failed");
      this.name = "ConditionalCheckFailedException";
    }
  }
  const store = new Map<string, CloudCodeSession>();
  // Called once before each PutCommand's condition is evaluated — lets a test
  // simulate another writer landing between our read and our write.
  const controller: { beforePut?: () => void } = {};
  return { ConditionalCheckFailedException, store, controller };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
  ConditionalCheckFailedException: h.ConditionalCheckFailedException,
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  const clone = <T>(o: T): T => (o == null ? o : JSON.parse(JSON.stringify(o)));
  class GetCommand {
    constructor(public input: any) {}
  }
  class PutCommand {
    constructor(public input: any) {}
  }
  class DeleteCommand {
    constructor(public input: any) {}
  }
  class ScanCommand {
    constructor(public input: any) {}
  }
  const send = async (cmd: any) => {
    if (cmd instanceof GetCommand) {
      return { Item: clone(h.store.get(cmd.input.Key.sessionId)) ?? undefined };
    }
    if (cmd instanceof PutCommand) {
      h.controller.beforePut?.();
      const item = cmd.input.Item as CloudCodeSession;
      const cond = cmd.input.ConditionExpression as string | undefined;
      if (cond) {
        const existing = h.store.get(item.sessionId);
        const prev = cmd.input.ExpressionAttributeValues[":prev"];
        // attribute_not_exists(#rev) OR #rev = :prev
        const ok = !existing || existing.rev === undefined || existing.rev === prev;
        if (!ok) throw new h.ConditionalCheckFailedException();
      }
      h.store.set(item.sessionId, clone(item));
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      h.store.delete(cmd.input.Key.sessionId);
      return {};
    }
    return {};
  };
  return {
    DynamoDBDocumentClient: { from: () => ({ send }) },
    GetCommand,
    PutCommand,
    DeleteCommand,
    ScanCommand,
  };
});

let mutateSession: typeof import("./sessions").mutateSession;
beforeEach(async () => {
  h.store.clear();
  h.controller.beforePut = undefined;
  vi.resetModules();
  ({ mutateSession } = await import("./sessions"));
});

function seed(overrides: Partial<CloudCodeSession> = {}): CloudCodeSession {
  const s: CloudCodeSession = {
    sessionId: "cc-1",
    userId: "default",
    tenantId: "default",
    title: "t",
    cli: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    turns: [],
    ...overrides,
  };
  h.store.set(s.sessionId, s);
  return s;
}

describe("mutateSession — optimistic concurrency", () => {
  it("applies the mutation and increments rev 0→1", async () => {
    seed();
    const out = await mutateSession("cc-1", (s) => ({
      ...s,
      turns: [...s.turns, { role: "agent", text: "hi", at: "x" }],
    }));
    expect(out?.rev).toBe(1);
    expect(out?.turns).toHaveLength(1);
    expect(h.store.get("cc-1")?.rev).toBe(1);
  });

  it("returns null when the row does not exist", async () => {
    const out = await mutateSession("missing", (s) => s);
    expect(out).toBeNull();
  });

  it("skips the write when mutate returns null and returns the current row", async () => {
    seed({ rev: 3 });
    const out = await mutateSession("cc-1", () => null);
    expect(out?.rev).toBe(3); // untouched — no write happened
  });

  it("retries on a lost race and preserves BOTH updates (no lost update)", async () => {
    seed({ turns: [] });
    // First Put: a competitor lands its own append + bumps rev 0→1, so our
    // condition (:prev=0) fails → ConditionalCheckFailedException → retry. On the
    // retry we read rev=1 (with the competitor's turn) and append onto it.
    let fired = false;
    h.controller.beforePut = () => {
      if (fired) return;
      fired = true;
      const cur = h.store.get("cc-1")!;
      h.store.set("cc-1", {
        ...cur,
        rev: (cur.rev ?? 0) + 1,
        turns: [...cur.turns, { role: "agent", text: "competitor", at: "x" }],
      });
    };
    const out = await mutateSession("cc-1", (s) => ({
      ...s,
      turns: [...s.turns, { role: "user", text: "mine", at: "y" }],
    }));
    expect(out?.rev).toBe(2); // 0→1 (competitor) →2 (us)
    expect(out?.turns.map((t) => t.text)).toEqual(["competitor", "mine"]);
  });

  it("throws after exhausting attempts under sustained contention", async () => {
    seed();
    // Every Put loses: a competitor bumps rev on each attempt just before ours.
    h.controller.beforePut = () => {
      const cur = h.store.get("cc-1")!;
      h.store.set("cc-1", { ...cur, rev: (cur.rev ?? 0) + 1 });
    };
    await expect(
      mutateSession("cc-1", (s) => ({ ...s, title: "x" }), 3)
    ).rejects.toThrow(/write contention/);
  });
});
