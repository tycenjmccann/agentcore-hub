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
