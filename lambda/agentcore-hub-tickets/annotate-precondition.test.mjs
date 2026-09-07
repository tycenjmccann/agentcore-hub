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

const h = vi.hoisted(() => ({ item: null, updates: [] }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd) {
        const kind = cmd?.constructor?.name;
        if (kind === "GetCommand") return { Item: h.item };
        if (kind === "UpdateCommand") { h.updates.push(cmd.input); return {}; }
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
    expect(h.updates).toHaveLength(0);
  });
});

/**
 * TEAM-4184 — the merge is MONOTONIC in the two fields the D2 evidence guard
 * reasons about (`reportedAt` and `source`), because re-reports are NOT ordered:
 * the orchestrator's level-triggered pickup re-annotates a spawn-derived stamp
 * that can land after the agent's own tool report. Last-writer-wins there would
 * walk the liveness clock backwards (making a current park look like a previous
 * claim's residue → a false dead-session escalation) and downgrade the source.
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

  it("advances reportedAt when the incoming report IS newer", async () => {
    h.item.preconditionUnmet = { awaitingIds: ["TEAM-4156"], reportedAt: "2026-09-06T07:07:00.000Z" };
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4199"], reportedAt: "2026-09-06T09:10:00.000Z",
    });
    expect(r.preconditionUnmet.reportedAt).toBe("2026-09-06T09:10:00.000Z");
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
