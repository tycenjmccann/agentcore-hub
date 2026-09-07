import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4166 §1.2 — the PROVIDER-PARITY contract for the precondition channel.
 * workflow-output invokes ONE tool name (`Tickets___annotate_precondition_unmet`)
 * with ONE param shape and reads back ONE key (`preconditionUnmet`), regardless
 * of backend. This pins that both ticket Lambdas honour that contract: identical
 * `{ ticketId, preconditionUnmet }` return shape, and NEITHER transitions the
 * ticket. The provider-specific mechanics (a DDB column vs. Jira labels+marker)
 * live in each Lambda's own annotate-precondition.test.mjs; what matters here is
 * that an agent — and the orchestrator — never has to know which is running.
 */

const h = vi.hoisted(() => ({ ddbItem: null, ddbUpdates: [], jiraCalls: [] }));

// ─── DynamoDB tickets Lambda seams ───────────────────────────────────────────
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd) {
        const kind = cmd?.constructor?.name;
        if (kind === "GetCommand") return { Item: h.ddbItem };
        if (kind === "UpdateCommand") { h.ddbUpdates.push(cmd.input); return {}; }
        return {};
      },
    }),
  },
  PutCommand: class { constructor(i) { this.input = i; } },
  GetCommand: class { constructor(i) { this.input = i; } },
  UpdateCommand: class { constructor(i) { this.input = i; } },
  QueryCommand: class { constructor(i) { this.input = i; } },
  ScanCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));

// ─── Jira Lambda seam (global fetch) ─────────────────────────────────────────
function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(body ?? {}); } };
}
vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
  const method = options.method || "GET";
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  h.jiraCalls.push({ method, path });
  if (method === "POST" && /\/comment$/.test(path)) return response(201, { id: "1" });
  if (method === "PUT" && /\/issue\/[^/]+$/.test(path)) return response(204, {});
  return response(200, {});
}));

delete process.env.ARTIFACT_BUCKET;
const dynamodb = await import("./index.mjs");
const jira = await import("../agentcore-hub-jira/index.mjs");

const HANDLERS = { dynamodb: dynamodb.handler, jira: jira.handler };

beforeEach(() => {
  h.ddbItem = { ticketId: "TEAM-4126", status: "in_progress", blockedBy: [] };
  h.ddbUpdates.length = 0;
  h.jiraCalls.length = 0;
});

for (const provider of ["dynamodb", "jira"]) {
  describe(`annotate contract [provider=${provider}]`, () => {
    it("returns { ticketId, preconditionUnmet } and never transitions the ticket", async () => {
      const r = await HANDLERS[provider]({
        tool_name: "Tickets___annotate_precondition_unmet",
        parameters: {
          ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"],
          note: "waiting", reportedAt: "2026-09-06T08:00:00.000Z",
          agentId: "agentcore_hub_release_manager", source: "tool",
        },
      });

      // Same key both providers, same shape.
      expect(r.ticketId).toBe("TEAM-4126");
      expect(Array.isArray(r.preconditionUnmet.awaitingIds)).toBe(true);
      expect(r.preconditionUnmet.awaitingIds).toContain("TEAM-4156");

      // Neither provider transitions.
      if (provider === "dynamodb") {
        expect(h.ddbUpdates.every((u) => !/status/i.test(u.UpdateExpression))).toBe(true);
      } else {
        expect(h.jiraCalls.some((c) => /\/transitions/.test(c.path))).toBe(false);
      }
    });
  });
}
