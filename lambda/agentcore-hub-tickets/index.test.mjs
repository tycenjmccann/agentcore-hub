import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const h = vi.hoisted(() => ({
  state: {
    puts: /** @type {any[]} */ ([]),
    counter: 0,
    // TEAM-3686 F2: S3 config objects by key (config/agents.json, …). With no
    // ARTIFACT_BUCKET (the default here) the lambda never reads S3 and falls
    // back to the hardcoded roster/phase sets, matching the pre-existing tests.
    s3: /** @type {Record<string, unknown>} */ ({}),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd.input.Key;
      if (!(key in h.state.s3)) throw new Error(`NoSuchKey: ${key}`);
      const body = h.state.s3[key];
      return { Body: { transformToString: async () => JSON.stringify(body) } };
    }
  },
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
  h.state.s3 = {};
  delete process.env.ARTIFACT_BUCKET;
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

/**
 * TEAM-3686 F2 — the fix-ticket phase allowlist. completion.mjs's open-fix
 * gate matches fix tickets per-phase, so a fix stamped with an unknown phase
 * is invisible to every required phase's check and the run can complete with
 * the fix still open. Unknown phase on a fix-kind ticket → reject, listing the
 * legal set; non-fix tickets and absent phases keep their existing behavior.
 */
describe("create_ticket — fix-ticket phase allowlist (TEAM-3686 F2)", () => {
  const FIX = { spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-42" } };

  it("rejects a fix-kind ticket with an unknown phase and mints NO ticket", async () => {
    const res = await create({ ...BASE, ...FIX, phase: "zz_nonexistent" });
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(res.content[0].text).toContain('"zz_nonexistent"');
    // The error lists the valid phases (fallback set here — no ARTIFACT_BUCKET).
    expect(res.content[0].text).toContain("Valid phases:");
    expect(res.content[0].text).toContain("development");
    expect(res.content[0].text).toContain("verification");
    expect(h.state.puts.length).toBe(0);
  });

  it("accepts a fix-kind ticket with a known phase and stores it", async () => {
    await create({ ...BASE, ...FIX, phase: "verification" });
    expect(h.state.puts.length).toBe(1);
    expect(h.state.puts[0].phase).toBe("verification");
    expect(h.state.puts[0].spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-42" });
  });

  it("leaves non-fix tickets unaffected — arbitrary phase still stored as-is", async () => {
    await create({ ...BASE, phase: "zz_custom" });
    expect(h.state.puts.length).toBe(1);
    expect(h.state.puts[0].phase).toBe("zz_custom");
  });

  it("a fix-kind ticket with no phase keeps the existing fallback (no stamp written)", async () => {
    await create({ ...BASE, ...FIX });
    expect(h.state.puts.length).toBe(1);
    expect("phase" in h.state.puts[0]).toBe(false);
    expect(h.state.puts[0].spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-42" });
  });

  describe("with S3 config (ARTIFACT_BUCKET set)", () => {
    beforeEach(async () => {
      process.env.ARTIFACT_BUCKET = "test-bucket";
      h.state.s3 = {
        "config/agents.json": {
          agents: [{ agentId: "agentcore_hub_backend_dev", phase: "development" }],
        },
        "config/workflows.json": {
          workflows: [
            {
              id: "marketing",
              phases: [{ agentPhase: "generation" }],
              completionRequiresAgentPhases: ["scheduling"],
            },
          ],
        },
      };
      vi.resetModules();
      ({ handler } = await import("./index.mjs"));
    });

    afterEach(() => {
      delete process.env.ARTIFACT_BUCKET;
    });

    it("derives the valid set from the same configs the orchestrator reads", async () => {
      // roster phase (agents.json)
      await create({ ...BASE, ...FIX, phase: "development" });
      // def agentPhase + completionRequiresAgentPhases (workflows.json)
      await create({ ...BASE, ...FIX, phase: "generation" });
      await create({ ...BASE, ...FIX, phase: "scheduling" });
      expect(h.state.puts.map((p) => p.phase)).toEqual(["development", "generation", "scheduling"]);
    });

    it("rejects a phase outside the config-derived set, listing it", async () => {
      const res = await create({ ...BASE, ...FIX, phase: "ship" });
      expect(res.content[0].text).toMatch(/^Error:/);
      expect(res.content[0].text).toContain("development, generation, scheduling");
      expect(h.state.puts.length).toBe(0);
    });
  });
});
