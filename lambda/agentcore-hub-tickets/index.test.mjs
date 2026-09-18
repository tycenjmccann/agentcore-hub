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
    // TEAM-4130 F1: transition_ticket's status write (`SET #s = :s, …`), so the
    // status a transition actually persists is assertable, not just its envelope.
    statusUpdates: /** @type {any[]} */ ([]),
    // TEAM-4537: edit_issue's title write (`SET #t = :t, …`).
    editUpdates: /** @type {any[]} */ ([]),
    // TEAM-4706: every completion-record read the ship-phase Done gate makes (by
    // Key), so a non-ship transition can be asserted to make NO S3 call at all…
    s3RecordReads: /** @type {string[]} */ ([]),
    // …and an INDETERMINATE S3 answer (AccessDenied, throttle, timeout) can be
    // injected: null = "exists iff the key is in state.s3Objects".
    recordImpl: /** @type {((input: any) => any) | null} */ (null),
    /**
     * The completion records that exist, e.g. completions/TEAM-4066.json. TEAM-4757:
     * the gate GETs the body, so the VALUE is the body it serves —
     *   `true`   → a pre-TEAM-4756 record (neither followUpsPending nor status), the
     *              shape every test written before that field existed assumed;
     *   object   → served as JSON.stringify(value);
     *   string   → served verbatim, so a non-JSON or empty body is expressible.
     */
    s3Objects: /** @type {Record<string, true | object | string>} */ ({}),
    // TEAM-4739: the typed gate guard's probe into the pipeline-tools Lambda —
    // every call recorded (so "made no probe at all" is assertable), and the reply
    // injected by tool name. An absent entry makes the invoke THROW, which is the
    // suite's default and the case the admit-on-indeterminate rule turns on.
    probes: /** @type {any[]} */ ([]),
    probeBy: /** @type {Record<string, {result?: unknown}>} */ ({}),
    // TEAM-4739 gate-loop gather / TEAM-4740 FR-5 open-gate autowire scan — both
    // features read the SAME parentId-index Query, so they share this fixture.
    siblings: /** @type {any[]} */ ([]),
    /** Journey events written through publishJourneyEvent. */
    events: /** @type {any[]} */ ([]),
    /** Make the NEXT conditional status write lose its race, once. */
    statusRaceOnce: false,
    // TEAM-4740 FR-5: every Query issued, and the switch that makes the scan
    // FAIL — the fail-open direction is the whole point of the feature, so it
    // has to be drivable.
    queries: /** @type {any[]} */ ([]),
    queryThrows: false,
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.state.probes.push({ tool: req.tool_name, args: req.parameters });
      const plan = h.state.probeBy[req.tool_name];
      if (!plan) {
        const err = new Error("connect ETIMEDOUT");
        err.name = "TimeoutError";
        throw err;
      }
      // The real tools Lambda double-encodes (`jsonResult`), so feed that shape.
      return {
        Payload: Buffer.from(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan.result, null, 2) }] })
        ),
      };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd.input.Key;
      // TEAM-4706 + TEAM-4757: the completion-record read and the roster/workflow
      // config reads are now both GetObject on one client, so the KEY PREFIX is what
      // separates them (it used to be the command type, when the gate HeadObject-ed).
      // The __type tag is still the shape the repo's other Lambda suites use
      // (lambda/agentcore-hub-pipeline-tools/index.test.mjs).
      if (String(key).startsWith("completions/")) {
        h.state.s3RecordReads.push(key);
        if (h.state.recordImpl) return h.state.recordImpl(cmd.input);
        if (!(key in h.state.s3Objects)) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        const record = h.state.s3Objects[key];
        // `true` = a pre-4756 record: it exists and carries neither new field.
        const text =
          record === true
            ? JSON.stringify({ ticketId: key.slice("completions/".length).replace(/\.json$/, ""), summary: "shipped" })
            : typeof record === "string"
              ? record
              : JSON.stringify(record);
        return { Body: { transformToString: async () => text } };
      }
      if (!(key in h.state.s3)) throw new Error(`NoSuchKey: ${key}`);
      const body = h.state.s3[key];
      return { Body: { transformToString: async () => JSON.stringify(body) } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
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
            if (cmd.input.ExpressionAttributeValues?.[":s"] !== undefined) {
              // A transitionIssue status write, not nextTicketId's counter bump.
              // TEAM-4739: a conditional one carries the gate label plan, and can
              // lose its race with a concurrent labeller.
              if (h.state.statusRaceOnce && cmd.input.ConditionExpression) {
                h.state.statusRaceOnce = false;
                h.state.statusUpdates.push(cmd.input);
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
              }
              h.state.statusUpdates.push(cmd.input);
              return {};
            }
            const title = cmd.input.ExpressionAttributeValues?.[":t"];
            if (title !== undefined) {
              // TEAM-4537: editIssue's title write (ReturnValues: ALL_NEW) — echo
              // back what was actually written, so the clamp is assertable off
              // the same response editIssue itself maps into `fields.summary`.
              h.state.editUpdates.push(cmd.input);
              return { Attributes: { ticketId: cmd.input.Key.ticketId, title, status: "todo", priority: "Medium", updatedAt: cmd.input.ExpressionAttributeValues[":u"] } };
            }
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] };
          if (name === "PutCommand") {
            // TEAM-4739: a journey event and a new ticket both arrive as a Put;
            // `eventId` is what tells them apart.
            if (cmd.input.Item?.eventId) h.state.events.push(cmd.input.Item);
            else h.state.puts.push(cmd.input.Item);
            return {};
          }
          if (name === "QueryCommand") {
            // TEAM-4740 FR-5: the sibling scan. Returned unfiltered (the Lambda
            // drops __COUNTER__ itself) so the test can prove it does. Also feeds
            // TEAM-4739's gate-loop gather — same parentId-index Query.
            h.state.queries.push(cmd.input);
            if (h.state.queryThrows) {
              const err = new Error("Requested resource not found: parentId-index");
              err.name = "ResourceNotFoundException";
              throw err;
            }
            return { Items: h.state.siblings };
          }
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

async function edit(args) {
  return handler({ name: "Tickets___edit_issue", arguments: args });
}

beforeEach(async () => {
  h.state.puts.length = 0;
  h.state.counter = 0;
  h.state.s3 = {};
  h.state.labelUpdates.length = 0;
  h.state.condFail.length = 0;
  h.state.statusUpdates.length = 0;
  h.state.editUpdates.length = 0;
  h.state.items = {};
  h.state.s3RecordReads.length = 0;
  h.state.recordImpl = null;
  h.state.s3Objects = {};
  h.state.probes.length = 0;
  h.state.probeBy = {};
  h.state.siblings.length = 0;
  h.state.events.length = 0;
  h.state.statusRaceOnce = false;
  h.state.queries.length = 0;
  h.state.queryThrows = false;
  delete process.env.ARTIFACT_BUCKET;
  // TEAM-4739: both are read at MODULE LOAD, so the default here is "unset" — the
  // configuration an install that has never heard of the gate guard still has.
  delete process.env.PIPELINE_TOOLS_LAMBDA;
  // TEAM-4740 FR-5: the journey-event writer is dark unless EVENTS_TABLE is set,
  // and it writes through the same doc client — leaving it set would put an event
  // row into state.puts and make every ticket assertion below ambiguous.
  delete process.env.EVENTS_TABLE;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

/** Reload the Lambda with gate-guard env set (both consts are load-time). */
async function reloadWithEnv(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const BASE = { summary: "Fix null check", assignee: "agentcore_hub_backend_dev" };
// TEAM-4130 F1: the run's ship ticket, the one a blocker edge must not strand.
const SHIP = "TEAM-4066";

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

    /**
     * TEAM-4131 F2 — `advisory` is RESERVED on a fix ticket and on a human gate.
     *
     * Under ADVISORY_ROUTING=enforce the orchestrator treats an advisory-labelled
     * child as backlog the run does not wait on. `labels` is a caller-supplied
     * string that main.py exposes to every persona, so a QA agent (or a
     * prompt-injected one) filing a REAL qa_fix with labels="advisory" made the run
     * finalize with the fix open. completion.mjs holds the read-side floor; this is
     * the write side — the word never reaches the record in the first place.
     *
     * It is deliberately NOT in SYSTEM_LABEL_PREFIXES: `advisory` is a legitimate
     * user label on an ordinary backlog ticket (the test above pins that), so it is
     * reserved per-ticket-SHAPE rather than globally.
     */
    it.each([
      ["qa_fix", { kind: "qa_fix", qaTicketId: "TEAM-42" }],
      ["review_fix", { kind: "review_fix", gateTicketId: "TEAM-42" }],
      ["codex_fix", { kind: "codex_fix", codexTicketId: "TEAM-42" }],
      ["ship_fix", { kind: "ship_fix", shipTicketId: "TEAM-42" }],
      ["ci_fix", { kind: "ci_fix", ciTicketId: "TEAM-42" }],
      ["sync_fix", { kind: "sync_fix", ciTicketId: "TEAM-42" }],
    ])("a %s ticket cannot be labelled advisory — dropped and reported", async (_kind, spawned_by) => {
      const res = await create({ ...BASE, spawned_by, labels: "Advisory, needs docs" });
      // The ticket is still filed (dropping a label is not a rejection) …
      expect(h.state.puts.length).toBe(1);
      expect(h.state.puts[0].labels).toEqual(["needs-docs"]);
      // … and the drop is REPORTED, so the Lambda logs it and the caller can see
      // its label was refused rather than silently honoured.
      expect(res.droppedLabels).toEqual(["advisory"]);
      expect(res.ticket.labels).toEqual(["needs-docs"]);
      expect(h.state.puts[0].spawnedBy.kind).toBe(spawned_by.kind);
    });

    it("a HUMAN GATE ticket cannot be labelled advisory either — being waited on is its function", async () => {
      const res = await create({ summary: "Merge Approval", assignee: "human:reviewer", labels: "advisory" });
      expect(res.droppedLabels).toEqual(["advisory"]);
      expect("labels" in h.state.puts[0]).toBe(false); // the only label was dropped
    });

    it("a NON-fix, non-human ticket keeps `advisory` — the guard is narrow by design", async () => {
      const res = await create({ ...BASE, labels: "advisory, needs docs" });
      expect(h.state.puts[0].labels).toEqual(["advisory", "needs-docs"]);
      expect("droppedLabels" in res).toBe(false);
      // An unknown kind is not a fix kind. (It is also rejected as a marker, so
      // the ticket carries no spawnedBy — the label decision must not depend on
      // the raw argument, only on what was actually accepted.)
      const bad = await create({ ...BASE, spawned_by: { kind: "qa_fixx" }, labels: "advisory" });
      expect(bad.content?.[0]?.text || "").toMatch(/^Error:/);
    });

    it("the reserved word is matched exactly — 'advisory-followup' is a normal label on a fix ticket", async () => {
      const res = await create({
        ...BASE, spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-42" }, labels: "advisory-followup, ADVISORY ",
      });
      expect(h.state.puts[0].labels).toEqual(["advisory-followup"]);
      expect(res.droppedLabels).toEqual(["advisory"]); // case- and whitespace-insensitive
    });

    /**
     * TEAM-4131 F1 — the sync-main conflict rounds ride on spawned_by, and
     * sanitizeSpawnedBy drops any key that is not allow-listed WITHOUT a word. A
     * dropped `round` would silently un-cap the human escalation.
     */
    it("keeps priorFixTicketId + round on a sync_fix, and refuses a garbage round", async () => {
      await create({
        ...BASE,
        spawned_by: { kind: "sync_fix", ciTicketId: "TEAM-9", priorFixTicketId: "TEAM-500", round: "2" },
      });
      expect(h.state.puts[0].spawnedBy).toEqual({
        kind: "sync_fix", ciTicketId: "TEAM-9", priorFixTicketId: "TEAM-500", round: 2,
      });

      h.state.puts.length = 0;
      await create({
        ...BASE,
        spawned_by: { kind: "sync_fix", ciTicketId: "TEAM-9", priorFixTicketId: "TEAM-500 OR 1=1", round: 1e6 },
      });
      expect(h.state.puts[0].spawnedBy).toEqual({ kind: "sync_fix", ciTicketId: "TEAM-9" });
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

/**
 * TEAM-4130 F1 — the refutation this ticket turns on. `addBlockers` used to set
 * `status = "blocked"` on every ticket it added an edge to, including a release
 * manager that was already `in_progress`. These two tests pin what that costs by
 * pinning the CURRENT transition table exactly as it is (TRANSITIONS is NOT
 * changed by this ticket):
 *
 *   (i)  from `in_progress`, `done` resolves through the REAL `done` row — a
 *        clean completion, which is what report_completion needs;
 *   (ii) from `blocked` there is no `done` row at all, so the same call only
 *        resolves because the matcher also matches on `t.to`, and the row it
 *        lands on is `skip` — the ticket closes labelled a SKIP, and with a
 *        `reason` it even records a skipReason. Not an error, which is exactly
 *        why the clobber was invisible in production.
 */
describe("transition_ticket — reaching done from in_progress vs from blocked (TEAM-4130 F1)", () => {
  const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });

  // TEAM-4706: these three cases CLOSE the run's ship ticket, which since DL-030
  // requires its completion record to exist (the describe below owns that rule).
  // The record is provisioned here so each test still asserts exactly what it was
  // written to assert — which transition row `done` resolves through — rather than
  // the new gate.
  beforeEach(async () => {
    process.env.ARTIFACT_BUCKET = "test-bucket";
    h.state.s3Objects[`completions/${SHIP}.json`] = true;
    vi.resetModules();
    ({ handler } = await import("./index.mjs"));
  });

  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  it("(i) done from in_progress resolves through the real `done` transition", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res).toMatchObject({ key: SHIP, status: "transitioned", from: "in_progress", to: "done" });
    expect(res.transition).toBe("Done"); // the real completion row, NOT "Skip"
    expect(h.state.statusUpdates).toHaveLength(1);
    expect(h.state.statusUpdates[0].ExpressionAttributeValues[":s"]).toBe("done");
    expect(h.state.statusUpdates[0].UpdateExpression).not.toContain("skipReason");
  });

  it("(ii) done from blocked resolves through the `skip` row's `to` alias", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "blocked", assignee: "agentcore_hub_release_manager" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    // It SUCCEEDS — and that is the problem: the run's ship ticket is recorded
    // as Skipped, not Completed.
    expect(res).toMatchObject({ key: SHIP, status: "transitioned", from: "blocked", to: "done" });
    expect(res.transition).toBe("Skip");
    expect(h.state.statusUpdates[0].ExpressionAttributeValues[":s"]).toBe("done");
  });

  it("(ii, cont.) …and with a reason it stamps skipReason on a completed ticket", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "blocked", assignee: "agentcore_hub_release_manager" };

    const res = await transition({ ticket_id: SHIP, to_status: "done", reason: "PR merged, deploy triggered" });

    expect(res.skipReason).toBe("PR merged, deploy triggered");
    expect(h.state.statusUpdates[0].UpdateExpression).toContain("#sr = :sr");
    expect(h.state.statusUpdates[0].ExpressionAttributeNames["#sr"]).toBe("skipReason");
  });

  it("blocked offers no `done` transition id — only `skip` reaches done", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "blocked", assignee: "agentcore_hub_release_manager" };

    const res = await handler({ name: "Tickets___get_transitions", arguments: { ticket_id: SHIP } });

    expect(res.currentStatus).toBe("blocked");
    expect(res.transitions.map((t) => t.id)).not.toContain("done");
    expect(res.transitions.filter((t) => t.to === "done").map((t) => t.id)).toEqual(["skip"]);
    // in_progress, by contrast, has the real one.
    h.state.items[SHIP].status = "in_progress";
    const live = await handler({ name: "Tickets___get_transitions", arguments: { ticket_id: SHIP } });
    expect(live.transitions.map((t) => t.id)).toContain("done");
  });
});

// DL-024 — an agent parks ITS OWN ticket behind the tickets it just filed.
// transition_ticket's blocked_by must be ADDITIVE (union with the row), matching
// the Jira Lambda where each entry becomes one more "Blocks" link; a whole-array
// SET here would let a re-park drop a blocker the creation-time graph installed.
describe("transition_ticket — blocked_by is additive (DL-024 agent self-park)", () => {
  const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });

  it("unions CSV blocked_by with the row's existing blockers and reports what was added", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager", blockedBy: ["TEAM-2"] };

    const res = await transition({ ticket_id: SHIP, transition_id: "blocked", blocked_by: "TEAM-3, TEAM-2,TEAM-4" });

    expect(res).toMatchObject({ key: SHIP, from: "in_progress", to: "blocked", blockedByAdded: ["TEAM-3", "TEAM-4"] });
    const u = h.state.statusUpdates[0];
    expect(u.ExpressionAttributeValues[":s"]).toBe("blocked");
    expect(u.ExpressionAttributeValues[":bb"]).toEqual(["TEAM-2", "TEAM-3", "TEAM-4"]);
  });

  it("accepts an array too", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager" };

    const res = await transition({ ticket_id: SHIP, transition_id: "blocked", blocked_by: ["TEAM-3"] });

    expect(res.blockedByAdded).toEqual(["TEAM-3"]);
    expect(h.state.statusUpdates[0].ExpressionAttributeValues[":bb"]).toEqual(["TEAM-3"]);
  });

  it("re-parking on blockers already present writes no blockedBy at all", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager", blockedBy: ["TEAM-2", "TEAM-3"] };

    const res = await transition({ ticket_id: SHIP, transition_id: "blocked", blocked_by: "TEAM-3,TEAM-2" });

    expect("blockedByAdded" in res).toBe(false);
    expect(h.state.statusUpdates[0].UpdateExpression).not.toContain("#bb");
  });

  it("without blocked_by the transition write is unchanged", async () => {
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager", blockedBy: ["TEAM-2"] };

    await transition({ ticket_id: SHIP, transition_id: "blocked" });

    expect(h.state.statusUpdates[0].UpdateExpression).not.toContain("#bb");
  });
});

// ─── TEAM-4537: summary clamp — parity with the Jira Lambda's 255-char cap ─────
//
// DynamoDB itself has no summary-length limit, but create_ticket/edit_issue
// must return the same `ticket.summary`/`fields.summary` under either backend
// (the twins doctrine, TEAM-4131 F2) — so a title that would 400 in Jira mode
// is clamped identically here, not just tolerated.
//
// EXPECTED_CLAMPED_LONG_TITLE is pinned to the SAME literal as the Jira
// Lambda's index.test.mjs for the SAME LONG_TITLE input — a drift in either
// clampSummary() copy fails a test instead of silently diverging.
describe("create_ticket / edit_issue — summary clamp (TEAM-4537)", () => {
  const LONG_TITLE = "A".repeat(200) + " " + "B".repeat(200); // 401 chars, one space near the middle
  const LONG_DESCRIPTION = "The full text must survive in the description even though the title is long. " + "x".repeat(300);
  const EXPECTED_CLAMPED_LONG_TITLE = "A".repeat(200) + "…";

  it("create_ticket clamps a >255-char summary to <=255 chars, description kept in full", async () => {
    await create({ summary: LONG_TITLE, description: LONG_DESCRIPTION });

    expect(h.state.puts.length).toBe(1);
    const item = h.state.puts[0];
    expect(item.title.length).toBeLessThanOrEqual(255);
    expect(item.title).toBe(EXPECTED_CLAMPED_LONG_TITLE);
    expect(item.description).toBe(LONG_DESCRIPTION);
  });

  it("create_ticket's response ticket.summary is the same clamped string as the stored title", async () => {
    const res = await create({ summary: LONG_TITLE });
    expect(res.ticket.summary).toBe(EXPECTED_CLAMPED_LONG_TITLE);
  });

  it("edit_issue clamps a >255-char summary the same way", async () => {
    h.state.items["TEAM-903"] = { ticketId: "TEAM-903", title: "old", status: "todo", priority: "Medium" };

    const res = await edit({ ticket_id: "TEAM-903", summary: LONG_TITLE });

    expect(h.state.editUpdates.length).toBe(1);
    expect(h.state.editUpdates[0].ExpressionAttributeValues[":t"]).toBe(EXPECTED_CLAMPED_LONG_TITLE);
    expect(res.fields.summary).toBe(EXPECTED_CLAMPED_LONG_TITLE);
  });
});

// ─── TEAM-4537 review P2: surrogate-safe clamp (mirrors the Jira Lambda) ───────
//
// The two clampSummary() copies are byte-identical (proven by a diff in CI), so
// this suite mirrors the Jira Lambda's astral + 255/256 boundary cases here to
// catch a one-sided edit that only fixes one twin.
describe("create_ticket / edit_issue — surrogate-safe clamp (TEAM-4537)", () => {
  const ASTRAL_TITLE = "x" + "😀".repeat(128);                    // 257 code units, cut falls mid-pair
  const EXPECTED_CLAMPED_ASTRAL = "x" + "😀".repeat(126) + "…";  // 254 code units, whole code points only
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("create_ticket clamps an emoji title without splitting a surrogate pair", async () => {
    const res = await create({ summary: ASTRAL_TITLE, description: "full text" });

    const item = h.state.puts[0];
    expect(item.title.length).toBeLessThanOrEqual(255);
    expect(item.title).toBe(EXPECTED_CLAMPED_ASTRAL);
    expect(LONE_SURROGATE.test(item.title)).toBe(false);
    expect(res.ticket.summary).toBe(EXPECTED_CLAMPED_ASTRAL);
  });

  it("edit_issue clamps an emoji title without splitting a surrogate pair", async () => {
    h.state.items["TEAM-904"] = { ticketId: "TEAM-904", title: "old", status: "todo", priority: "Medium" };

    await edit({ ticket_id: "TEAM-904", summary: ASTRAL_TITLE });

    const written = h.state.editUpdates[0].ExpressionAttributeValues[":t"];
    expect(written).toBe(EXPECTED_CLAMPED_ASTRAL);
    expect(LONE_SURROGATE.test(written)).toBe(false);
  });

  it("a summary of exactly 255 chars is stored untouched; 256 is clamped", async () => {
    await create({ summary: "A".repeat(255) });
    expect(h.state.puts[0].title).toBe("A".repeat(255));

    await create({ summary: "A".repeat(256) });
    expect(h.state.puts[1].title).toBe("A".repeat(254) + "…");
    expect(h.state.puts[1].title.length).toBe(255);
  });
});

/**
 * TEAM-4706 (DL-030) — a SHIP-PHASE ticket cannot reach done without its
 * completion record (s3://$ARTIFACT_BUCKET/completions/<ticket_id>.json).
 *
 * That record, written by lambda/workflow-output's report_completion BEFORE it
 * asks this Lambda for the transition, is the only durable statement of what
 * actually shipped — the run's completion gates, its KPIs and the deploy audit
 * trail all read it. A ship ticket closed by hand leaves them with nothing.
 *
 * The rails that keep the gate from becoming a deadlock are as load-bearing as
 * the gate itself, and each has a test below:
 *   - HUMAN gates are exempt: the hub UI's approve action and the Telegram
 *     bridge's ✅ transition through this same tool without writing a record;
 *   - NON-ship tickets are untouched, and make no S3 call at all;
 *   - an INDETERMINATE S3 answer refuses (fails closed) — "we could not find a
 *     record" is not "there is no record" (DL-028's positive-evidence rule).
 *
 * TEAM-4757 R3-2 added the (g)…(l) cases: the gate READS THE BODY, because
 * TEAM-4756 made reportCompletion stamp `followUpsPending`/`status` into the record
 * and a record in the pending state used to prove completion exactly as well as a
 * finished one. The admission test is `followUpsPending !== true`, never
 * `=== false` — a pre-4756 record, a sweep skip-record and the transition-failed
 * restamp all legitimately lack the field, and (i)/(j) are what pin that.
 *
 * The jira Lambda's suite asserts the identical twin, in its own idiom.
 */
describe("transition_ticket — ship-phase Done needs a completion record (TEAM-4706)", () => {
  const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });
  const RECORD_KEY = `completions/${SHIP}.json`;
  const HINT =
    "call WorkflowOutput___report_completion(ticket_id=…) — it writes the record and transitions the ticket for you";

  /** The run's ship ticket: release manager, in progress, phase-stamped `ship`. */
  const shipTicket = (extra = {}) => ({
    ticketId: SHIP,
    status: "in_progress",
    assignee: "agentcore_hub_release_manager",
    phase: "ship",
    ...extra,
  });

  beforeEach(async () => {
    // The gate only reads S3 when a bucket is configured; with none it fails
    // closed, which the "indeterminate" test at the end pins separately.
    process.env.ARTIFACT_BUCKET = "test-bucket";
    h.state.s3 = {
      "config/agents.json": {
        agents: [
          { agentId: "agentcore_hub_release_manager", phase: "ship" },
          { agentId: "agentcore_hub_backend_dev", phase: "development" },
        ],
      },
    };
    vi.resetModules();
    ({ handler } = await import("./index.mjs"));
  });

  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  it("(a) refuses done with no record — exact reason/hint, and NO status write", async () => {
    h.state.items[SHIP] = shipTicket();

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("completion_record_required");
    expect(res.hint).toBe(HINT);
    // The refusal is legible to the agent AND to the hub UI's rejectedDetails().
    expect(res.content[0].text).toContain(HINT);
    expect(res.content[0].text).toContain(`no ${RECORD_KEY}`);
    // Nothing moved: the ticket is still in_progress in DynamoDB.
    expect(h.state.statusUpdates).toHaveLength(0);
    expect(h.state.s3RecordReads).toEqual([RECORD_KEY]);
  });

  it("(a, cont.) the `skip` row cannot walk around the gate either", async () => {
    // From `blocked`, done resolves through the skip row's `to` alias (TEAM-4130
    // F1), so keying the gate on the requested transition id would leave the main
    // hole open. The RESOLVED target is what is tested.
    h.state.items[SHIP] = shipTicket({ status: "blocked" });

    const res = await transition({ ticket_id: SHIP, to_status: "done", reason: "PR merged" });

    expect(res.reason).toBe("completion_record_required");
    expect(h.state.statusUpdates).toHaveLength(0);
  });

  it("(b) allows done once the record exists", async () => {
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = true;

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res).toMatchObject({ key: SHIP, status: "transitioned", from: "in_progress", to: "done" });
    expect("reason" in res).toBe(false);
    expect(h.state.statusUpdates).toHaveLength(1);
    expect(h.state.statusUpdates[0].ExpressionAttributeValues[":s"]).toBe("done");
    expect(h.state.s3RecordReads).toEqual([RECORD_KEY]);
  });

  it("(c) a NON-ship ticket closes with no record and makes no S3 call at all", async () => {
    h.state.items["TEAM-4067"] = {
      ticketId: "TEAM-4067",
      status: "in_progress",
      assignee: "agentcore_hub_backend_dev",
      phase: "development",
    };

    const res = await transition({ ticket_id: "TEAM-4067", to_status: "done" });

    expect(res).toMatchObject({ key: "TEAM-4067", status: "transitioned", to: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
    // The ship-phase predicate is cheap and runs FIRST — the hot path is untouched.
    expect(h.state.s3RecordReads).toEqual([]);
  });

  it("(d) a human-assigned gate closes with no record — the UI/Telegram approve path", async () => {
    // A Merge Approval gate IS a ship-phase ticket (`phase:ship`), and neither the
    // console's approve nor the Telegram bridge's ✅ writes a completion record.
    // Gating it would deadlock every human gate in the pipeline.
    h.state.items["TEAM-4068"] = {
      ticketId: "TEAM-4068",
      status: "in_review",
      assignee: "human:release-owner",
      phase: "ship",
      labels: ["human-review", "reviewer:release-owner", "phase:ship"],
    };

    const res = await transition({ ticket_id: "TEAM-4068", to_status: "done", reason: "approved" });

    expect(res).toMatchObject({ key: "TEAM-4068", status: "transitioned", from: "in_review", to: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
    expect(h.state.s3RecordReads).toEqual([]);
  });

  it("(e) ship phase detected from the assignee's ROSTER phase, with no phase stamp", async () => {
    // No `phase` field and no phase:ship label — the only signal is that the
    // assignee is a ship-phase agent in config/agents.json.
    h.state.items[SHIP] = { ticketId: SHIP, status: "in_progress", assignee: "agentcore_hub_release_manager" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.reason).toBe("completion_record_required");
    expect(res.hint).toBe(HINT);
    expect(h.state.statusUpdates).toHaveLength(0);
    expect(h.state.s3RecordReads).toEqual([RECORD_KEY]);
  });

  it("(f) an INDETERMINATE S3 answer refuses — fails closed, and leaks nothing", async () => {
    h.state.items[SHIP] = shipTicket();
    h.state.recordImpl = () => {
      const err = new Error("User: arn:aws:sts::…:assumed-role/… is not authorized");
      err.name = "AccessDenied";
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.reason).toBe("completion_record_required");
    expect(h.state.statusUpdates).toHaveLength(0);
    // The reason names the failure CLASS, never the AWS error body/identity.
    expect(res.content[0].text).toContain("could not read");
    expect(res.content[0].text).toContain("AccessDenied");
    expect(res.content[0].text).not.toContain("assumed-role");
  });

  // ── TEAM-4757 R3-2: the record's BODY is the proof, not its existence ──────

  it("(g) a record with followUpsPending:true is REFUSED — the R3-2 hole", async () => {
    // reportCompletion's own state when a follow-up create failed: the record is
    // durable, the ticket is deliberately still open, and the follow-up (a
    // post-deploy verification, say) was never filed. Closing here cascades and
    // completes the epic over work that does not exist.
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = {
      ticketId: SHIP,
      summary: "deployed",
      followUpsPending: true,
      status: "complete_pending_follow_ups",
    };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("completion_record_required");
    expect(res.hint).toBe(HINT);
    // The message names the state AND the one call that fixes it.
    expect(res.content[0].text).toContain(
      `${RECORD_KEY} has followUpsPending:true (status complete_pending_follow_ups)`
    );
    expect(res.content[0].text).toContain(
      "re-run WorkflowOutput___report_completion with the same arguments to materialize the follow-ups"
    );
    // Nothing moved, and the record was read exactly once.
    expect(h.state.statusUpdates).toHaveLength(0);
    expect(h.state.s3RecordReads).toEqual([RECORD_KEY]);
  });

  it("(h) followUpsPending:false + status complete closes", async () => {
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = { ticketId: SHIP, followUpsPending: false, status: "complete" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res).toMatchObject({ key: SHIP, status: "transitioned", to: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("(i) a PRE-4756 record — neither field — still closes", async () => {
    // Every record written before TEAM-4756 looks like this, and the invariant held
    // for it too (it predates follow-ups entirely). `=== false` instead of `!== true`
    // would strand every in-flight run at the moment this deploys.
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = { ticketId: SHIP, summary: "shipped", pr_url: "https://example.test/pr/1" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res).toMatchObject({ key: SHIP, status: "transitioned", to: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("(i, cont.) a sweep SKIP-record closes, and so does the transition-failed restamp", async () => {
    // workflow-output's sweepSkipRecord deliberately stamps neither field (a skip is
    // not a completion report), and the `complete_transition_failed` restamp
    // deliberately leaves followUpsPending false — the follow-ups ARE filed there and
    // only the Done write failed, so closing it directly is a legitimate recovery.
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = {
      ticketId: SHIP,
      evidence_kind: "skipped",
      skipped: true,
      reason: "empty_sweep_no_siblings",
    };
    expect((await transition({ ticket_id: SHIP, to_status: "done" })).status).toBe("transitioned");

    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = {
      ticketId: SHIP,
      followUpsPending: false,
      status: "complete_transition_failed",
    };
    expect((await transition({ ticket_id: SHIP, to_status: "done" })).status).toBe("transitioned");
  });

  it("(j) followUpsPending:\"true\" (a STRING) closes — the test is `=== true`, not truthiness", async () => {
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = { ticketId: SHIP, followUpsPending: "true" };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res).toMatchObject({ key: SHIP, status: "transitioned", to: "done" });
  });

  it("(k) followUpsPending:true with no status names the status `unstated`", async () => {
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = { ticketId: SHIP, followUpsPending: true };

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.reason).toBe("completion_record_required");
    expect(res.content[0].text).toContain("has followUpsPending:true (status unstated)");
    expect(h.state.statusUpdates).toHaveLength(0);
  });

  it.each([
    ["non-JSON", "not json at all", "unparseable JSON"],
    ["empty", "", "an empty body"],
    ["a JSON array", "[]", "parsed to an array, not an object"],
    ["JSON null", "null", "parsed to null, not an object"],
  ])("(l) an UNREADABLE body (%s) refuses — fails closed", async (_label, body, detail) => {
    // A record we cannot parse cannot tell us whether its follow-ups are pending, and
    // "could not tell" is not "they are filed" — the same three-outcome discipline as
    // workflow-output's readCdLedger.
    h.state.items[SHIP] = shipTicket();
    h.state.s3Objects[RECORD_KEY] = body;

    const res = await transition({ ticket_id: SHIP, to_status: "done" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("completion_record_required");
    expect(res.content[0].text).toContain(`${RECORD_KEY} could not be read as a completion record (${detail}`);
    expect(res.content[0].text).toContain("Re-run WorkflowOutput___report_completion");
    expect(h.state.statusUpdates).toHaveLength(0);
  });
});

/**
 * TEAM-4739 — the typed gate guard, in the mechanics only THIS twin has.
 *
 * The cross-provider truth table lives in src/lib/workflow/gate-guard-parity.test.ts
 * (it drives both Lambdas through the same rows and compares the refusal payloads
 * byte for byte). What is asserted here is what has no Jira counterpart:
 *   - the UNSET env default: with no PIPELINE_TOOLS_LAMBDA the guard admits and
 *     never constructs a client — the configuration every existing install has;
 *   - `planGateLabelWrite`'s shapes, which exist because DynamoDB forbids one
 *     UpdateExpression from touching both `labels` and `labels[i]`;
 *   - the conditional status write losing a race with a concurrent labeller.
 */
describe("transition_ticket — typed gate guard, DynamoDB-side mechanics (TEAM-4739)", () => {
  const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });
  const GATE = "TEAM-4700";
  const PIPELINE = "hub-x-deploy";
  const EXEC = "0f8fad5b-d9cb-469f-a165-70867728950e";

  const gateTicket = (labels, extra = {}) => ({
    ticketId: GATE,
    status: "in_review",
    assignee: "human:reviewer",
    labels,
    workflowId: "wf_1",
    ...extra,
  });
  const DEPLOY_LABELS = [`gate:deploy-approval`, `pipeline:${PIPELINE}`, `exec:${EXEC}`];

  describe("with NO PIPELINE_TOOLS_LAMBDA configured (the default install)", () => {
    it("admits the close, stamps indeterminate, and never builds a probe", async () => {
      // This is the fail direction stated as a deployment fact: an install that has
      // not been given the probe function must not have every gate ticket become
      // uncloseable. `probe_not_configured` is an indeterminate, not a refusal.
      h.state.items[GATE] = gateTicket(DEPLOY_LABELS);

      const res = await transition({ ticket_id: GATE, to_status: "done" });

      expect(res.gateVerification).toMatchObject({
        result: "indeterminate",
        reason: "probe_failed",
        evidence: "probe_not_configured",
        gateKind: "deploy-approval",
      });
      expect(h.state.probes, "no client, no invoke").toHaveLength(0);
      expect(h.state.statusUpdates).toHaveLength(1);
      expect(h.state.statusUpdates[0].ExpressionAttributeValues[":s"]).toBe("done");
    });

    it("a ci-unavailable gate admits too", async () => {
      h.state.items[GATE] = gateTicket(["gate:ci-unavailable", `head:${"a".repeat(40)}`]);
      const res = await transition({ ticket_id: GATE, to_status: "done" });
      expect(res.gateVerification.result).toBe("indeterminate");
      expect(h.state.statusUpdates).toHaveLength(1);
    });
  });

  describe("with the probe configured", () => {
    beforeEach(async () => {
      await reloadWithEnv({ PIPELINE_TOOLS_LAMBDA: "hub-pipeline-tools", EVENTS_TABLE: "agentcore-hub-events" });
    });

    it("refuses an OPEN approval, leaves the ticket, and pages exactly once", async () => {
      h.state.probeBy.Pipeline___get_state = {
        result: { waitingOn: { stage: "Deploy", action: "ApproveDeploy", holdsGate: "this" } },
      };
      h.state.items[GATE] = gateTicket(DEPLOY_LABELS);

      const res = await transition({ ticket_id: GATE, to_status: "done" });

      expect(res).toMatchObject({ ok: false, reason: "gate_condition_unmet", stage: "Deploy", action: "ApproveDeploy" });
      expect(h.state.statusUpdates, "the ticket does not move").toHaveLength(0);
      expect(h.state.labelUpdates.map((u) => u.ExpressionAttributeValues[":label"])).toEqual(["gate:awaiting-console"]);
      expect(h.state.events.map((e) => e.type)).toEqual(["gate.repaged"]);
      expect(h.state.events[0].detail).toMatchObject({ ticketId: GATE, gateKind: "deploy-approval", attempt: 1 });
    });

    it("the conditional label add is the event dedupe — a repeat refusal is silent", async () => {
      h.state.probeBy.Pipeline___get_state = { result: { waitingOn: { holdsGate: "this" } } };
      h.state.items[GATE] = gateTicket([...DEPLOY_LABELS, "gate:awaiting-console"]);
      // The label is already on the row, so its conditional append fails → no page.
      h.state.condFail.push("gate:awaiting-console");

      const res = await transition({ ticket_id: GATE, to_status: "done" });

      expect(res.reason).toBe("gate_condition_unmet");
      expect(h.state.events, "no second gate.repaged").toHaveLength(0);
    });

    it("a refusal survives an unwritable events table and an unlabelable ticket", async () => {
      // Every side effect is best-effort: a correct refusal must not degrade into a
      // tool error because the events table throttled.
      h.state.probeBy.Pipeline___get_state = { result: { waitingOn: { holdsGate: "this" } } };
      h.state.items[GATE] = gateTicket(DEPLOY_LABELS);
      h.state.condFail.push("gate:awaiting-console");

      const res = await transition({ ticket_id: GATE, to_status: "done" });
      expect(res.reason).toBe("gate_condition_unmet");
      expect(res.hint).toContain("still OPEN");
    });

    it("EVENTS_TABLE unset ⇒ no event, same refusal", async () => {
      delete process.env.EVENTS_TABLE;
      await reloadWithEnv({ PIPELINE_TOOLS_LAMBDA: "hub-pipeline-tools" });
      h.state.probeBy.Pipeline___get_state = { result: { waitingOn: { holdsGate: "this" } } };
      h.state.items[GATE] = gateTicket(DEPLOY_LABELS);

      const res = await transition({ ticket_id: GATE, to_status: "done" });

      expect(res.reason).toBe("gate_condition_unmet");
      expect(h.state.events).toHaveLength(0);
      expect(h.state.labelUpdates).toHaveLength(1); // the label still lands
    });

    describe("planGateLabelWrite — one UpdateExpression, one shape per label state", () => {
      beforeEach(() => {
        h.state.probeBy.Pipeline___get_state = { result: { waitingOn: null } };
      });

      it("no parked label ⇒ a plain list_append, no condition", async () => {
        h.state.items[GATE] = gateTicket(DEPLOY_LABELS);
        await transition({ ticket_id: GATE, to_status: "done" });
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toContain("list_append(if_not_exists(#l, :emptyl), :stampl)");
        expect(w.ExpressionAttributeValues[":stampl"]).toEqual(["gateverify:verified"]);
        expect(w.ConditionExpression).toBeUndefined();
      });

      it("a parked label ⇒ its SLOT is overwritten with the stamp, under a condition", async () => {
        // Not `SET labels = list_append(...)` + `REMOVE labels[i]`: DynamoDB rejects
        // overlapping document paths. Not a whole-list SET either — that clobbers a
        // concurrent labeller.
        h.state.items[GATE] = gateTicket(["gate:awaiting-console", ...DEPLOY_LABELS]);
        await transition({ ticket_id: GATE, to_status: "done" });
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toContain("#l[0] = :stampl");
        expect(w.UpdateExpression).not.toContain("list_append");
        expect(w.ExpressionAttributeValues[":stampl"]).toBe("gateverify:verified");
        expect(w.ConditionExpression).toBe("#l[0] = :awaiting");
        expect(w.ExpressionAttributeValues[":awaiting"]).toBe("gate:awaiting-console");
      });

      it("stamp already present ⇒ the parked slot is REMOVEd and nothing re-added", async () => {
        h.state.items[GATE] = gateTicket([...DEPLOY_LABELS, "gate:awaiting-console", "gateverify:verified"]);
        await transition({ ticket_id: GATE, to_status: "done" });
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toMatch(/REMOVE #l\[3]/);
        expect(w.ExpressionAttributeValues[":stampl"]).toBeUndefined();
      });

      it("a CONTRADICTORY stamp ⇒ the park slot takes the new one, the stale slot is REMOVEd", async () => {
        // TEAM-4750 B2. Both clauses in ONE expression, at distinct indices: only
        // `labels` beside `labels[i]` is forbidden, and multiple REMOVEs resolve
        // against the original indices. Two stamps on one ticket would make the
        // label record of why the gate closed unreadable.
        h.state.items[GATE] = gateTicket([...DEPLOY_LABELS, "gate:awaiting-console", "gateverify:indeterminate"]);
        await transition({ ticket_id: GATE, to_status: "done" });
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toMatch(/#l\[3] = :stampl/);
        expect(w.UpdateExpression).toMatch(/REMOVE #l\[4]/);
        expect(w.UpdateExpression).not.toContain("list_append");
        expect(w.ExpressionAttributeValues[":stampl"]).toBe("gateverify:verified");
        expect(w.ExpressionAttributeValues[":opp0"]).toBe("gateverify:indeterminate");
        // Both touched slots are conditioned, so the race fallback below covers them.
        expect(w.ConditionExpression).toBe("#l[3] = :awaiting AND #l[4] = :opp0");
      });

      it("a stale stamp with NO park label ⇒ the stale slot itself becomes the new stamp", async () => {
        // Nothing else is being cleared, so reusing the contradictory slot is what
        // keeps this a single slot write rather than an append plus a remove.
        h.state.items[GATE] = gateTicket([...DEPLOY_LABELS, "gateverify:indeterminate"]);
        await transition({ ticket_id: GATE, to_status: "done" });
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toMatch(/#l\[3] = :stampl/);
        expect(w.UpdateExpression).not.toContain("REMOVE");
        expect(w.UpdateExpression).not.toContain("list_append");
        expect(w.ExpressionAttributeValues[":stampl"]).toBe("gateverify:verified");
        expect(w.ConditionExpression).toBe("#l[3] = :opp0");
      });

      it("losing the race on the OPPOSITE slot still transitions — without the label clause", async () => {
        // The same fallback the park-label race gets: every slot the plan touches is
        // conditioned, so a concurrent labeller costs the cosmetic label edit and
        // never a verified close.
        h.state.items[GATE] = gateTicket([...DEPLOY_LABELS, "gateverify:indeterminate"]);
        h.state.statusRaceOnce = true;

        const res = await transition({ ticket_id: GATE, to_status: "done" });

        expect(res).toMatchObject({ status: "transitioned", to: "done" });
        expect(h.state.statusUpdates).toHaveLength(2);
        expect(h.state.statusUpdates[1].ConditionExpression).toBeUndefined();
        expect(h.state.statusUpdates[1].UpdateExpression).not.toContain("#l");
        expect(h.state.statusUpdates[1].ExpressionAttributeValues[":gv"].result).toBe("verified");
      });

      it("the stamp rides in the SAME write as the status", async () => {
        h.state.items[GATE] = gateTicket(DEPLOY_LABELS);
        await transition({ ticket_id: GATE, to_status: "done" });
        expect(h.state.statusUpdates).toHaveLength(1);
        const w = h.state.statusUpdates[0];
        expect(w.UpdateExpression).toContain("#s = :s");
        expect(w.UpdateExpression).toContain("#gv = :gv");
        expect(w.ExpressionAttributeValues[":gv"]).toMatchObject({ result: "verified", gateKind: "deploy-approval" });
      });

      it("losing the label race still transitions — without the label clause", async () => {
        // The gate was verified; the only thing lost is a cosmetic label edit. A
        // verified gate that cannot close because a labeller raced it would be the
        // same wedge the whole guard is built to avoid.
        h.state.items[GATE] = gateTicket(["gate:awaiting-console", ...DEPLOY_LABELS]);
        h.state.statusRaceOnce = true;

        const res = await transition({ ticket_id: GATE, to_status: "done" });

        expect(res).toMatchObject({ status: "transitioned", to: "done" });
        expect(h.state.statusUpdates).toHaveLength(2);
        expect(h.state.statusUpdates[1].ConditionExpression).toBeUndefined();
        expect(h.state.statusUpdates[1].UpdateExpression).not.toContain("#l");
        // The verdict is still recorded — the retry drops the LABEL, not the stamp.
        expect(h.state.statusUpdates[1].ExpressionAttributeValues[":gv"].result).toBe("verified");
      });
    });

    it("a non-gate ticket's write is byte-identical to the pre-TEAM-4739 one", async () => {
      h.state.items[GATE] = gateTicket(["phase:development"]);
      const res = await transition({ ticket_id: GATE, to_status: "done" });
      expect(res.gateVerification).toBeUndefined();
      expect(h.state.probes).toHaveLength(0);
      expect(h.state.statusUpdates[0].UpdateExpression).toBe("SET #s = :s, #u = :u");
    });

    it("the ship-phase completion gate still wins — it refuses BEFORE any probe", async () => {
      // Ordering matters: a ship ticket with no completion record must report the
      // missing record (which the agent can produce), not a gate verdict.
      // An AGENT assignee: a `human:` one is never a ship-phase ticket (that is
      // what makes the gate tickets above exempt from the completion-record gate).
      h.state.items[GATE] = gateTicket(["gate:deploy-approval", "phase:ship"], {
        assignee: "agentcore_hub_release_manager",
      });
      const res = await transition({ ticket_id: GATE, to_status: "done" });
      expect(res.reason).toBe("completion_record_required");
      expect(h.state.probes, "no gate probe on a completion-record refusal").toHaveLength(0);
    });
  });
});

/**
 * TEAM-4739 — create_ticket's gate-loop seam, DynamoDB-side.
 *
 * The cross-provider matrix is in src/lib/workflow/gate-loop-parity.test.ts. What is
 * local here: the seam's PLACE in createTicket (before the id counter is touched),
 * and that the parentId-index Query is the only gather it does.
 */
describe("create_ticket — gate-loop seam, DynamoDB-side (TEAM-4739)", () => {
  const EPIC = "TEAM-1";
  const SHA = "b".repeat(40);
  const CI_GATE = ["gate:ci-unavailable", `head:${SHA}`];
  const priorRow = (id) => ({ ticketId: id, labels: ["gate-ci-unavailable", `head-${SHA}`] });

  beforeEach(async () => {
    await reloadWithEnv({ PIPELINE_TOOLS_LAMBDA: "hub-pipeline-tools", EVENTS_TABLE: "agentcore-hub-events" });
    h.state.items[EPIC] = { ticketId: EPIC, type: "epic", workflowId: "wf_1", labels: [] };
  });

  it("refuses the third, and mints NO ticket id", async () => {
    h.state.siblings.push(priorRow("TEAM-800"), priorRow("TEAM-810"));

    const res = await create({ summary: "CI is unavailable", labels: CI_GATE, parent_key: EPIC });

    expect(res).toMatchObject({ ok: false, reason: "gate_loop_environmental", existingTicketId: "TEAM-800" });
    expect(h.state.puts, "no ticket written").toHaveLength(0);
    expect(h.state.counter, "the shared id counter is untouched").toBe(0);
    expect(h.state.labelUpdates[0].ExpressionAttributeValues[":label"]).toBe("gate:loop-broken");
    expect(h.state.events.map((e) => e.type)).toEqual(["workflow.blocked"]);
  });

  it("the __COUNTER__ row is never counted as a sibling", async () => {
    // It lives in the same table and would otherwise be mapped into the verdict as
    // a labelless row — harmless for a targeted gate, but it must not be there.
    h.state.siblings.push({ ticketId: "__COUNTER__", nextNum: 42 }, priorRow("TEAM-800"));
    const res = await create({ summary: "CI is unavailable", labels: CI_GATE, parent_key: EPIC });
    expect(res.ok).not.toBe(false);
    expect(h.state.puts).toHaveLength(1);
  });

  it("an ordinary ticket makes no sibling scan and no probe", async () => {
    h.state.siblings.push(priorRow("TEAM-800"), priorRow("TEAM-810"));
    await create({ ...BASE });
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.probes).toHaveLength(0);
  });
});

/**
 * TEAM-4740 FR-12 — base_branch at CREATE time.
 *
 * A ticket filed mid-run with no branch identity inherits whatever branch its
 * assignee happens to be on; while a Merge Approval gate is open that is the
 * integration branch the merge is about to supersede, so the work evaporates with
 * it (run p5ogpg / TEAM-4663). The contract: a stated branch is VALIDATED (a bad
 * one mints nothing), PERSISTED as a field, and written as one machine-parseable
 * description line — the only carrier that survives get_issue in both providers.
 * An absent branch changes nothing at all.
 *
 * The regex + refusal text + line format are held identical to the jira twin by
 * src/lib/workflow/base-branch-parity.test.ts; this file owns the BEHAVIOUR.
 */
describe("create_ticket — base_branch (FR-12)", () => {
  it("persists the branch as a field, a description line, and on the response", async () => {
    const res = await create({ ...BASE, description: "Fix the abandon guard.", base_branch: "main" });

    expect(h.state.puts).toHaveLength(1);
    const item = h.state.puts[0];
    expect(item.baseBranch).toBe("main");
    // The line is on its own line, AFTER the prose, and matches the parser
    // workflow-output's FR-5 refusal will use.
    expect(item.description).toBe("Fix the abandon guard.\n\nbase_branch: main");
    expect(item.description.match(/^base_branch:\s*(\S+)\s*$/m)[1]).toBe("main");
    // And the caller sees it back under the wire name it sent.
    expect(res.ticket.base_branch).toBe("main");
    expect(res.ticket.description).toBe(item.description);
  });

  it("accepts a real integration branch name", async () => {
    await create({ ...BASE, base_branch: "feature/TEAM-4734--si-system-binding-gate-resolution-deplo" });
    expect(h.state.puts[0].baseBranch).toBe("feature/TEAM-4734--si-system-binding-gate-resolution-deplo");
  });

  it("trims, so a padded value is stored canonically", async () => {
    await create({ ...BASE, base_branch: "  main  " });
    expect(h.state.puts[0].baseBranch).toBe("main");
    expect(h.state.puts[0].description).toBe("base_branch: main");
  });

  it("REFUSES an invalid branch and mints NOTHING — not even a counter bump", async () => {
    const res = await create({ ...BASE, base_branch: "--upload-pack=x" });

    expect(res.content[0].text).toMatch(/^Error: /);
    expect(res.content[0].text).toContain("'base_branch'");
    expect(res.content[0].text).toContain('"--upload-pack=x"');
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(0);
  });

  it.each(["-main", "/main", "feature/../main", "main@{1}", "main.lock", "feature/", "a b"])(
    "REFUSES %j",
    async (bad) => {
      const res = await create({ ...BASE, base_branch: bad });
      expect(res.content[0].text).toMatch(/^Error: /);
      expect(h.state.puts).toHaveLength(0);
    }
  );

  it("an ABSENT branch leaves the ticket byte-identical to before the feature", async () => {
    await create({ ...BASE, description: "Plain ticket." });
    const item = h.state.puts[0];
    expect("baseBranch" in item).toBe(false);
    expect(item.description).toBe("Plain ticket.");
    const res = await create({ ...BASE });
    expect("base_branch" in res.ticket).toBe(false);
    expect(h.state.puts[1].description).toBe("");
  });

  it("an EMPTY branch is 'unstated', not invalid", async () => {
    for (const v of ["", "   "]) {
      h.state.puts.length = 0;
      const res = await create({ ...BASE, base_branch: v });
      expect(res.status).toBe("created");
      expect("baseBranch" in h.state.puts[0]).toBe(false);
    }
  });
});

/**
 * TEAM-4740 FR-5 (create half) — freeze new work behind an OPEN Merge Approval
 * gate.
 *
 * Observed on run TEAM-4660: TEAM-4677 was filed while the Merge Approval gate
 * TEAM-4668 was open, so it was dispatched immediately and its work went onto the
 * integration branch the merge then superseded. The fix is an ordering edge added
 * at CREATE time — the new ticket is blocked_by the CD ticket and carries a banner
 * telling its assignee to deliver via its own PR to main.
 *
 * Every case here is also a statement about the FAIL DIRECTION: the freeze is
 * added only on positive evidence (a gate that is provably open AND a CD ticket
 * that is provably unfinished), and anything else — a scan failure, a human
 * assignee, a settled CD ticket, no gate at all — creates the ticket UNFROZEN.
 */
describe("create_ticket — open-gate autowire (FR-5)", () => {
  const EPIC = "TEAM-4734";
  const GATE = "TEAM-4668";
  const CD = "TEAM-4703";

  /** The human Merge Approval gate, as the hub creates it: labels + title. */
  const gateRow = (overrides = {}) => ({
    ticketId: GATE,
    parentId: EPIC,
    title: "Merge Approval: [SI] system binding",
    status: "in_review",
    labels: ["human-review", "reviewer:tycen"],
    assignee: "human:tycen",
    createdAt: "2026-09-14T17:33:00.000Z",
    ...overrides,
  });

  /** The run's CD ticket, stamped with the ship phase. */
  const cdRow = (overrides = {}) => ({
    ticketId: CD,
    parentId: EPIC,
    title: "CD: merge + deploy",
    status: "todo",
    labels: ["phase:ship"],
    assignee: "agentcore_hub_release_manager",
    createdAt: "2026-09-14T16:00:00.000Z",
    ...overrides,
  });

  const AGENT = { ...BASE, parent_key: EPIC };

  it("freezes a new AGENT ticket behind the CD ticket and says why", async () => {
    h.state.siblings.push(gateRow(), cdRow());

    const res = await create({ ...AGENT, description: "Fix the abandon guard." });

    const item = h.state.puts[0];
    expect(item.blockedBy).toEqual([CD]);
    expect(item.status).toBe("blocked");
    // The banner LEADS the description (it changes what the assignee must do) and
    // names the ticket that has to land first.
    expect(item.description.startsWith("DELIVERY CONSTRAINT:")).toBe(true);
    expect(item.description).toContain(CD);
    expect(item.description).toContain("your OWN pull request to main");
    expect(item.description).toContain("Fix the abandon guard.");
    // And the caller is told, in a shape it can branch on.
    expect(res.autowired).toEqual({
      reason: "open_gate",
      blockedBy: [CD],
      gateTicketId: GATE,
    });
  });

  it("scans the parentId-index directly — labels are what the gate predicate reads", async () => {
    h.state.siblings.push(gateRow(), cdRow());
    await create({ ...AGENT });
    expect(h.state.queries).toHaveLength(1);
    expect(h.state.queries[0].IndexName).toBe("parentId-index");
    expect(h.state.queries[0].ExpressionAttributeValues).toEqual({ ":pid": EPIC });
  });

  it("keeps the caller's own blockers and APPENDS the CD edge", async () => {
    h.state.siblings.push(gateRow(), cdRow());
    await create({ ...AGENT, blocked_by: "TEAM-4700" });
    expect(h.state.puts[0].blockedBy).toEqual(["TEAM-4700", CD]);
  });

  it("does NOT freeze a human:* assignee — the gate is what everything waits on", async () => {
    h.state.siblings.push(gateRow(), cdRow());

    const res = await create({
      ...AGENT,
      assignee: "human:tycen",
      summary: "Merge Approval: round 2",
    });

    expect(h.state.puts[0].blockedBy).toEqual([]);
    expect(h.state.puts[0].status).toBe("todo");
    expect(res.autowired).toBeUndefined();
    // Decided before any I/O: freezing a human gate would deadlock the run, so the
    // answer never depends on a scan succeeding.
    expect(h.state.queries).toHaveLength(0);
  });

  it("adds no DUPLICATE edge when the caller already ordered it behind CD", async () => {
    h.state.siblings.push(gateRow(), cdRow());

    const res = await create({ ...AGENT, blocked_by: [CD] });

    expect(h.state.puts[0].blockedBy).toEqual([CD]);
    expect(res.autowired).toBeUndefined();
    // No banner either: the ordering the banner explains was already the caller's.
    expect(h.state.puts[0].description).toBe("");
  });

  it("does not freeze when the CD ticket is already done", async () => {
    h.state.siblings.push(gateRow(), cdRow({ status: "done" }));
    const res = await create({ ...AGENT });
    expect(h.state.puts[0].blockedBy).toEqual([]);
    expect(h.state.puts[0].status).toBe("todo");
    expect(res.autowired).toBeUndefined();
  });

  it("does not freeze when there is no open gate", async () => {
    // Same siblings, gate already approved — the merge has happened, the
    // integration branch is no longer about to move under anyone.
    h.state.siblings.push(gateRow({ status: "done" }), cdRow());
    const res = await create({ ...AGENT });
    expect(h.state.puts[0].blockedBy).toEqual([]);
    expect(res.autowired).toBeUndefined();
  });

  it("does not freeze when a gate is open but no CD ticket exists", async () => {
    h.state.siblings.push(gateRow());
    const res = await create({ ...AGENT });
    expect(h.state.puts[0].blockedBy).toEqual([]);
    expect(res.autowired).toBeUndefined();
  });

  // TEAM-4752 D1 — this used to FAIL OPEN and create the ticket UNFROZEN, on the
  // argument that an unfrozen ticket is recoverable. It is not: an unfrozen ticket
  // is dispatched immediately, onto a branch the open merge is about to supersede,
  // and that work is thrown away. Nor is "create it blocked" the answer — a blocked
  // ticket with no blocker edge is a permanent wedge. So: refuse, and let the agent
  // retry.
  it("REFUSES the create when the scan errors — nothing minted, not even a ticket number", async () => {
    h.state.queryThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await create({ ...AGENT, description: "Fix the abandon guard." });

    expect(res.content[0].text).toMatch(/^Error: create_ticket refused:/);
    expect(res.content[0].text).toContain(`the sibling scan under ${EPIC} failed`);
    expect(res.content[0].text).toContain("Nothing was created. Retry the call.");
    // Refused before nextTicketId, so the counter is untouched too.
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("REFUSING the create");
    warn.mockRestore();
  });

  it("refuses with the EXACT shared body — the twins may not drift", async () => {
    h.state.queryThrows = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { siblingScanRefusal } = await import("./index.mjs");
    const res = await create({ ...AGENT });
    expect(res.content[0].text).toBe(
      `Error: ${siblingScanRefusal(EPIC, "Requested resource not found: parentId-index")}`
    );
  });

  it("a scan error does NOT refuse a human gate — that path never scans", async () => {
    // The refusal is confined to exactly the path the autowire governs. A human
    // gate returns `untouched` before the try block, so it is unaffected.
    h.state.queryThrows = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await create({ summary: "Merge Approval", assignee: "human:tycen", parent_key: EPIC });
    expect(res.status).toBe("created");
    expect(h.state.puts[0].blockedBy).toEqual([]);
  });

  it("never scans at all without a parent — there are no siblings to scan", async () => {
    h.state.siblings.push(gateRow(), cdRow());
    const res = await create({ ...BASE });
    expect(h.state.queries).toHaveLength(0);
    expect(res.autowired).toBeUndefined();
  });

  it("a scan error does NOT refuse a parentless create either", async () => {
    h.state.queryThrows = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await create({ ...BASE });
    expect(res.status).toBe("created");
    expect(h.state.puts).toHaveLength(1);
  });

  it("detects the gate by LABEL as well as by title", async () => {
    // sanitizeUserLabels maps ':' to '-', so a label-stamped gate can arrive in
    // either form; MERGE_GATE_LABEL_RE accepts both.
    h.state.siblings.push(
      gateRow({ title: "Approve the merge", labels: ["human-review", "gate-merge-approval"] }),
      cdRow()
    );
    const res = await create({ ...AGENT });
    expect(res.autowired.gateTicketId).toBe(GATE);
  });

  it("is not fooled by a human ticket that is neither a merge gate nor in review", async () => {
    h.state.siblings.push(
      gateRow({ title: "Bug intake triage", labels: ["human-review", "reviewer:tycen"] }),
      cdRow()
    );
    const res = await create({ ...AGENT });
    expect(res.autowired).toBeUndefined();
    // …nor by a merge gate that has not been presented to anyone yet.
    h.state.puts.length = 0;
    h.state.siblings.length = 0;
    h.state.siblings.push(gateRow({ status: "todo" }), cdRow());
    expect((await create({ ...AGENT })).autowired).toBeUndefined();
  });

  it("finds the CD ticket via the phase:ship label AND via the roster fallback", async () => {
    // Label stamp (above) and the roster path: no labels at all, the assignee's
    // phase in config/agents.json (here the fallback map) is what says 'ship'.
    h.state.siblings.push(gateRow(), cdRow({ labels: [] }));
    expect((await create({ ...AGENT })).autowired).toEqual({
      reason: "open_gate",
      blockedBy: [CD],
      gateTicketId: GATE,
    });

    // A non-ship agent sibling is NOT a CD ticket, so nothing freezes behind it.
    h.state.puts.length = 0;
    h.state.siblings.length = 0;
    h.state.siblings.push(
      gateRow(),
      cdRow({ ticketId: "TEAM-4690", labels: [], assignee: "agentcore_hub_backend_dev" })
    );
    expect((await create({ ...AGENT })).autowired).toBeUndefined();
  });

  it("picks the NEWEST CD ticket when a re-run filed a second one", async () => {
    h.state.siblings.push(
      gateRow(),
      cdRow({ ticketId: "TEAM-4600", createdAt: "2026-09-10T09:00:00.000Z" }),
      cdRow({ ticketId: "TEAM-4710", createdAt: "2026-09-15T09:00:00.000Z" })
    );
    const res = await create({ ...AGENT });
    expect(res.autowired.blockedBy).toEqual(["TEAM-4710"]);
  });

  it("ignores the ticket-id counter row the index also returns", async () => {
    h.state.siblings.push({ ticketId: "__COUNTER__", parentId: EPIC, nextNum: 7 }, gateRow(), cdRow());
    expect((await create({ ...AGENT })).autowired.blockedBy).toEqual([CD]);
  });

  it("composes banner + prose + base_branch line, in that order", async () => {
    h.state.siblings.push(gateRow(), cdRow());
    await create({ ...AGENT, description: "Own PR to main; this is hub infra.", base_branch: "main" });
    const lines = h.state.puts[0].description.split("\n\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("DELIVERY CONSTRAINT:")).toBe(true);
    expect(lines[1]).toBe("Own PR to main; this is hub infra.");
    expect(lines[2]).toBe("base_branch: main");
  });

  it("audits the edge as a journey event — but only when EVENTS_TABLE is set", async () => {
    h.state.siblings.push(gateRow(), cdRow());
    // Dark by default (the deploy env sets no EVENTS_TABLE): one write, the ticket.
    await create({ ...AGENT });
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.events).toHaveLength(0);

    process.env.EVENTS_TABLE = "agentcore-hub-events";
    h.state.puts.length = 0;
    await create({ ...AGENT, workflow_id: "wf_1757000000_si" });
    delete process.env.EVENTS_TABLE;

    // TEAM-4739's gate-loop event and TEAM-4740's autowire event both carry an
    // `eventId`, so the mock routes any such Put into `h.state.events`, never
    // `h.state.puts` — the ticket write and the audit write stay distinguishable
    // by construction, not by array position.
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.events).toHaveLength(1);
    const event = h.state.events[0];
    expect(event.workflowId).toBe("wf_1757000000_si");
    expect(event.type).toBe("plan.autowired");
    expect(event.detail).toEqual({
      ticketId: event.detail.ticketId,
      reason: "open_gate",
      blockedBy: [CD],
      gateTicketId: GATE,
    });
    // SEC-13: a per-create write must not accumulate forever.
    expect(event.ttl).toBeGreaterThan(Date.now() / 1000);
  });
});
