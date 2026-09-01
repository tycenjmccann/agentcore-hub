import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3619 D4c — create_ticket's spawnedBy/phase pass-through.
 *
 * The QA verifier and code reviewer file fix tickets through this Lambda; the
 * marker they pass is what makes the run's completion re-verify (completion.mjs
 * condition iii) refuse to close while a fix is open. The contract under test:
 *   - a VALID marker is persisted in the exact shape completion.mjs reads
 *     (spawnedBy.{kind, originId}) + the phase stamp;
 *   - an UNKNOWN kind is rejected outright (no junk on the record, no ticket
 *     minted) — agents can't scribble arbitrary provenance;
 *   - ABSENT fields leave the record byte-for-byte as it was before (backward
 *     compatible), and stray keys inside a valid marker are dropped.
 */

const h = vi.hoisted(() => ({ state: { puts: /** @type {any[]} */ ([]), counter: 0 } }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
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
            // nextTicketId's counter bump.
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "PutCommand") { h.state.puts.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

let handler;

async function create(args) {
  return handler({ name: "Tickets___create_ticket", arguments: args });
}

beforeEach(async () => {
  h.state.puts.length = 0;
  h.state.counter = 0;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

const BASE = { summary: "Fix null check", assignee: "agentcore_hub_backend_dev" };

describe("create_ticket — spawnedBy/phase pass-through (D4c)", () => {
  it("persists a valid qa_fix marker + phase in the shape completion.mjs reads", async () => {
    await create({ ...BASE, spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-42" }, phase: "development" });
    expect(h.state.puts.length).toBe(1);
    const item = h.state.puts[0];
    expect(item.spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-42" });
    expect(item.phase).toBe("development");
  });

  it("rejects an unknown kind and mints NO ticket", async () => {
    const res = await create({ ...BASE, spawned_by: { kind: "bogus_fix", qaTicketId: "TEAM-42" } });
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text).toMatch(/spawned_by\.kind/);
    expect(h.state.puts.length).toBe(0); // validation precedes nextTicketId/Put
  });

  it("writes no spawnedBy/phase when absent (backward compatible)", async () => {
    await create({ ...BASE });
    expect(h.state.puts.length).toBe(1);
    const item = h.state.puts[0];
    expect("spawnedBy" in item).toBe(false);
    expect("phase" in item).toBe(false);
  });

  it("drops stray/ill-typed keys inside a valid marker", async () => {
    await create({
      ...BASE,
      spawned_by: { kind: "codex_fix", codexTicketId: "TEAM-9", gateTicketId: 123, evil: "x" },
    });
    const item = h.state.puts[0];
    expect(item.spawnedBy).toEqual({ kind: "codex_fix", codexTicketId: "TEAM-9" });
  });
});
