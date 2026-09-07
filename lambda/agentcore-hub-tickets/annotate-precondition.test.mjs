import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4166 §1.2 — the DynamoDB tickets Lambda's `annotate_precondition_unmet`
 * action. It stamps a top-level `preconditionUnmet` record on the ticket and
 * MERGES awaited ids with any already present (a ticket can accumulate awaited
 * siblings across several agent reports), and — critically — it makes NO status
 * or blockedBy change: this is an annotation the orchestrator reads, not a
 * transition. The awaited-edge write is the orchestrator's job (the addBlockers
 * seam), not this tool's.
 */

// `updateThrows` (TEAM-4261) makes the guarded UpdateCommand fail the way DynamoDB
// really does when `attribute_exists(ticketId)` is not satisfied.
const h = vi.hoisted(() => ({ item: null, updates: [], updateThrows: null }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd) {
        const kind = cmd?.constructor?.name;
        if (kind === "GetCommand") return { Item: h.item };
        if (kind === "UpdateCommand") {
          h.updates.push(cmd.input);
          if (h.updateThrows) {
            const err = new Error(h.updateThrows.message);
            err.name = h.updateThrows.name;
            throw err;
          }
          return {};
        }
        return {};
      },
    }),
  },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
  UpdateCommand: class { constructor(input) { this.input = input; } },
  QueryCommand: class { constructor(input) { this.input = input; } },
  ScanCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
}));

// No ARTIFACT_BUCKET → loadValidAgents skips S3 and uses the fallback roster.
delete process.env.ARTIFACT_BUCKET;
const { handler } = await import("./index.mjs");

const annotate = (parameters) =>
  handler({ tool_name: "Tickets___annotate_precondition_unmet", parameters });

beforeEach(() => {
  h.item = { ticketId: "TEAM-4126", status: "in_progress", blockedBy: [] };
  h.updates.length = 0;
  h.updateThrows = null;
});

describe("annotate_precondition_unmet (dynamodb)", () => {
  it("stamps preconditionUnmet and returns { ticketId, preconditionUnmet }", async () => {
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], note: "n", reportedAt: "2026-09-06T08:00:00.000Z",
      agentId: "agentcore_hub_release_manager", source: "tool",
    });
    expect(r.ticketId).toBe("TEAM-4126");
    expect(r.preconditionUnmet).toEqual({
      awaitingIds: ["TEAM-4156"], note: "n", reportedAt: "2026-09-06T08:00:00.000Z",
      agentId: "agentcore_hub_release_manager", source: "tool",
    });
  });

  it("UNIONs new ids with the ids already stamped (dedup, order stable)", async () => {
    h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"] };
    const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156", "TEAM-4157"] });
    expect(r.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
  });

  it("writes ONLY preconditionUnmet + updatedAt — never status or blockedBy", async () => {
    await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"] });
    expect(h.updates).toHaveLength(1);
    // The write is aliased (#pu → preconditionUnmet), so resolve the expression
    // through ExpressionAttributeNames before asserting on the real column set.
    const u = h.updates[0];
    const names = u.ExpressionAttributeNames || {};
    const columns = Object.values(names);
    expect(columns).toContain("preconditionUnmet");
    expect(columns).toContain("updatedAt");
    // NEVER touches the ticket's lifecycle — this is an annotation, not a transition.
    expect(columns).not.toContain("status");
    expect(columns).not.toContain("blockedBy");
    expect(u.UpdateExpression).not.toMatch(/status|blockedBy/i);
    // Guarded so a typo'd key never upserts a phantom row.
    expect(u.ConditionExpression).toContain("attribute_exists(ticketId)");
  });

  it("errors cleanly on a missing ticket", async () => {
    h.item = null;
    const r = await annotate({ ticket_id: "TEAM-9999", awaitingIds: ["TEAM-1"] });
    expect(JSON.stringify(r)).toMatch(/not found/i);
    // TEAM-4261 — and it is a top-level `error`, not text the caller has to parse.
    // The consumer (workflow-output report_precondition_unmet) branches on this key
    // to decide whether the agent really parked; content-only text read as success.
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/not found/i);
    expect(h.updates).toHaveLength(0);
  });

  /**
   * TEAM-4261 — a THROWN write failure is a failure on the wire too.
   *
   * The stamp write is guarded by `attribute_exists(ticketId)` (TEAM-4166), so a
   * row deleted between the GetCommand and the UpdateCommand raises
   * ConditionalCheckFailedException. That lands in the handler's catch, which
   * returned content-only text before this ticket — so the agent was told it had
   * parked even though the stamp never persisted.
   */
  it("a ConditionalCheckFailedException on the guarded write surfaces as { error, content }", async () => {
    h.updateThrows = {
      name: "ConditionalCheckFailedException",
      message: "The conditional request failed",
    };

    const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"] });

    expect(h.updates).toHaveLength(1); // the write was attempted…
    expect(typeof r.error).toBe("string"); // …and its failure is visible
    expect(r.error).toMatch(/conditional request failed/i);
    // The text channel still carries the same message (text-readers unaffected).
    expect(r.content[0].text).toBe(r.error);
    // NONE of the success keys — the caller cannot mistake this for a stamp.
    expect(r.ticketId).toBeUndefined();
    expect(r.preconditionUnmet).toBeUndefined();
  });
});

/**
 * TEAM-4184 — the merge is MONOTONIC in the two fields the D2 evidence guard
 * reasons about (`reportedAt` and `source`), because re-reports are NOT ordered:
 * the orchestrator's level-triggered pickup re-annotates a spawn-derived stamp
 * that can land after the agent's own tool report. Last-writer-wins there would
 * walk the liveness clock backwards (making a current park look like a previous
 * claim's residue → a false dead-session escalation) and downgrade the source.
 *
 * TEAM-4185 F3 tightens `reportedAt` from max-wins to FIRST-writer-wins: max-wins
 * still let a re-report move the stamp FORWARD, and the level-triggered pickup
 * re-annotates with `now()`, which restarted the FR-1.4 wait SLA on every pickup.
 * The stamp records when the wait BEGAN, so the first parseable value is the one
 * that matters. `source` stays rank-preserving — it is not a clock.
 */
describe("annotate_precondition_unmet — monotonic merge (TEAM-4184)", () => {
  it("keeps the LATER reportedAt when an older re-report arrives", async () => {
    h.item.preconditionUnmet = {
      awaitingIds: ["TEAM-4156"], reportedAt: "2026-09-06T09:10:00.000Z", source: "tool",
    };
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
      reportedAt: "2026-09-06T07:07:00.000Z", source: "derived",
    });
    expect(r.preconditionUnmet.reportedAt).toBe("2026-09-06T09:10:00.000Z");
    expect(r.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
  });

  // TEAM-4185 F3 — was "advances reportedAt when the incoming report IS newer".
  // It must NOT advance: a stamp that moves forward on every re-report resets the
  // wait-SLA clock, so a ticket parked for hours keeps reading as freshly parked
  // and its await_timeout never fires. First (parseable) writer wins.
  it("does NOT advance reportedAt when the incoming report is newer (TEAM-4185 F3)", async () => {
    h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], reportedAt: "2026-09-06T07:07:00.000Z" };
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4199"], reportedAt: "2026-09-06T09:10:00.000Z",
    });
    expect(r.preconditionUnmet.reportedAt).toBe("2026-09-06T07:07:00.000Z");
    // The NEW awaited id still lands — only the clock is pinned.
    expect(r.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4199"]);
  });

  it("takes the incoming reportedAt when the row carries none (or an unparseable one)", async () => {
    for (const prior of [undefined, "", "not-a-date"]) {
      h.updates.length = 0;
      h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], reportedAt: prior };
      const r = await annotate({
        ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], reportedAt: "2026-09-06T09:10:00.000Z",
      });
      expect(r.preconditionUnmet.reportedAt).toBe("2026-09-06T09:10:00.000Z");
    }
  });

  it("never downgrades source: tool survives a derived (or label) re-report", async () => {
    for (const incoming of ["derived", "label", undefined]) {
      h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], source: "tool" };
      const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], source: incoming });
      // `undefined` defaults to "tool" (the tool's own callers), so it is a no-op.
      expect(r.preconditionUnmet.source).toBe("tool");
    }
  });

  it("UPGRADES source when the incoming report ranks higher (label → derived → tool)", async () => {
    for (const [prior, incoming] of [["label", "derived"], ["derived", "tool"], ["label", "tool"]]) {
      h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], source: prior };
      const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], source: incoming });
      expect(r.preconditionUnmet.source).toBe(incoming);
    }
  });

  it("an unknown/absent stored source loses to any real incoming source", async () => {
    h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"] }; // no source at all
    const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], source: "label" });
    expect(r.preconditionUnmet.source).toBe("label");
  });
});

/**
 * TEAM-4185 F3 — first-writer-wins metadata, and a no-op writes NOTHING.
 *
 * The remaining last-writer-wins fields (`note`, `agentId`) were clobbered by the
 * orchestrator's level-triggered re-annotate, which carries neither: the reporting
 * agent's own note became "" and its id became null, erasing who parked and why.
 * And because the record was rewritten unconditionally, `updatedAt` moved on every
 * re-report — which is the timestamp reconcile-sweep's parkedLongEnough reads, so a
 * ticket re-reported once per sweep interval could never become a candidate.
 */
describe("annotate_precondition_unmet — first-writer-wins + no-op (TEAM-4185 F3)", () => {
  const STAMPED = {
    awaitingIds: ["TEAM-4156"],
    note: "waiting on the ship fixes",
    reportedAt: "2026-09-06T07:07:00.000Z",
    agentId: "agentcore_hub_release_manager",
    source: "tool",
  };

  it("preserves the stored note and agentId when a re-report carries neither", async () => {
    h.item.preconditionUnmet = { ...STAMPED };
    const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"], source: "derived" });
    expect(r.preconditionUnmet.note).toBe("waiting on the ship fixes");
    expect(r.preconditionUnmet.agentId).toBe("agentcore_hub_release_manager");
    // Still the first stamp, and the union still grew.
    expect(r.preconditionUnmet.reportedAt).toBe("2026-09-06T07:07:00.000Z");
    expect(r.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
  });

  it("takes the incoming note/agentId when the row carries none (empty is not a writer)", async () => {
    for (const prior of [{}, { note: "", agentId: null }]) {
      h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], ...prior };
      const r = await annotate({
        ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], note: "n", agentId: "agentcore_hub_ci",
      });
      expect(r.preconditionUnmet.note).toBe("n");
      expect(r.preconditionUnmet.agentId).toBe("agentcore_hub_ci");
    }
  });

  it("a re-report that changes nothing performs NO write (updatedAt does not move)", async () => {
    h.item.preconditionUnmet = { ...STAMPED };
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], note: STAMPED.note,
      reportedAt: STAMPED.reportedAt, agentId: STAMPED.agentId, source: "tool",
    });
    expect(h.updates).toHaveLength(0);
    expect(r.unchanged).toBe(true);
    // The caller still gets the record back — the contract is unchanged.
    expect(r.ticketId).toBe("TEAM-4126");
    expect(r.preconditionUnmet).toEqual(STAMPED);
  });

  it("a re-report with DIFFERENT metadata but the same ids is still a no-op", async () => {
    h.item.preconditionUnmet = { ...STAMPED };
    await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"],
      // Every one of these loses to the stored value, so the merged record is
      // byte-identical to what is already there → nothing to write.
      reportedAt: "2026-09-06T09:10:00.000Z", source: "derived",
      agentId: "orchestrator", note: "re-derived at pickup",
    });
    expect(h.updates).toHaveLength(0);
  });

  it("a genuinely NEW awaited id still writes", async () => {
    h.item.preconditionUnmet = { ...STAMPED };
    await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"] });
    expect(h.updates).toHaveLength(1);
  });

  it("a legacy row missing note/agentId is normalized ONCE, then goes quiet", async () => {
    // Pre-4185 rows exist without the full field set; the first re-report fills
    // them in (a real change), and the next identical one writes nothing.
    h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], reportedAt: STAMPED.reportedAt, source: "tool" };
    const first = await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"] });
    expect(h.updates).toHaveLength(1);
    expect(first.unchanged).toBeUndefined();

    h.item.preconditionUnmet = first.preconditionUnmet;
    await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"] });
    expect(h.updates).toHaveLength(1); // still just the first write
  });
});
