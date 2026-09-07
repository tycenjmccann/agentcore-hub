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

// `jiraMissing` (TEAM-4261) makes every Jira route answer 404, i.e. "that issue
// does not exist" — the Jira half of `ddbItem = null`.
const h = vi.hoisted(() => ({
  ddbItem: null, ddbUpdates: [], jiraCalls: [], jiraLabels: [], jiraMissing: false,
}));

// ─── DynamoDB tickets Lambda seams ───────────────────────────────────────────
// The Update is APPLIED to the in-memory row (TEAM-4185), not just recorded: the
// F3 cases below re-annotate the same ticket and the second call has to read back
// what the first one wrote — on both providers.
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(cmd) {
        const kind = cmd?.constructor?.name;
        if (kind === "GetCommand") return { Item: h.ddbItem };
        if (kind === "UpdateCommand") {
          h.ddbUpdates.push(cmd.input);
          const vals = cmd.input.ExpressionAttributeValues || {};
          if (h.ddbItem && vals[":pu"]) h.ddbItem.preconditionUnmet = vals[":pu"];
          if (h.ddbItem && vals[":u"]) h.ddbItem.updatedAt = vals[":u"];
          return {};
        }
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
// Stateful in the labels dimension: Jira's labels ARE the record, so a PUT's
// add/remove ops are applied to h.jiraLabels and the `?fields=labels` GET serves
// them back — the Jira half of "the second call reads what the first one wrote".
vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
  const method = options.method || "GET";
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  const body = options.body ? JSON.parse(options.body) : undefined;
  h.jiraCalls.push({ method, path, body });
  if (h.jiraMissing) {
    return response(404, {
      errorMessages: ["Issue does not exist or you do not have permission to see it."],
    });
  }
  if (method === "POST" && /\/comment$/.test(path)) return response(201, { id: "1" });
  if (method === "PUT" && /\/issue\/[^/]+$/.test(path)) {
    for (const op of body?.update?.labels || []) {
      if (op.add && !h.jiraLabels.includes(op.add)) h.jiraLabels.push(op.add);
      if (op.remove) h.jiraLabels = h.jiraLabels.filter((l) => l !== op.remove);
    }
    return response(204, {});
  }
  if (method === "GET" && /\/issue\/[^/]+\?fields=labels$/.test(path)) {
    return response(200, { fields: { labels: h.jiraLabels } });
  }
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
  h.jiraLabels = [];
  h.jiraMissing = false;
});

/**
 * Provider-generic readers for the two things the F3 cases assert about: which
 * awaited ids the BOARD now carries (a DDB column vs. `awaiting:` labels) and how
 * many writes the provider performed. Deliberately not read off the tool's return
 * value — the point is what landed on the ticket.
 */
const BOARD = {
  dynamodb: {
    // `?.` on the row too: the TEAM-4261 failure cases run with no row at all.
    awaited: () => h.ddbItem?.preconditionUnmet?.awaitingIds || [],
    writes: () => h.ddbUpdates.length,
  },
  jira: {
    awaited: () => h.jiraLabels.filter((l) => l.startsWith("awaiting:")).map((l) => l.slice("awaiting:".length)),
    // Every non-GET call is a write (the comment POST bumps `updated` just as the
    // label PUT does — that is exactly why F3 has to suppress both).
    writes: () => h.jiraCalls.filter((c) => c.method !== "GET").length,
  },
};

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

    /**
     * TEAM-4185 F3(c) — the merge semantics are part of the PARITY contract, not a
     * provider detail. The orchestrator's D2 evidence guard and FR-1.4 wait SLA
     * read `preconditionUnmet.reportedAt` through the same seam on both backends,
     * so "the first stamp survives" and "a no-op writes nothing" have to hold on
     * both or the two providers drift into different escalation behaviour.
     */
    const annotate = (parameters) =>
      HANDLERS[provider]({ tool_name: "Tickets___annotate_precondition_unmet", parameters });

    const FIRST = {
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"], note: "waiting on the ship fixes",
      reportedAt: "2026-09-06T07:07:00.000Z", agentId: "agentcore_hub_release_manager", source: "tool",
    };

    it("F3: a second annotate unions the awaited ids and keeps the FIRST reportedAt", async () => {
      await annotate(FIRST);

      // The level-triggered pickup re-annotates: newer clock, weaker source, no
      // note, a different agent. Only the new id may land.
      const r2 = await annotate({
        ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
        reportedAt: "2026-09-06T09:10:00.000Z", source: "derived", agentId: "orchestrator",
      });

      expect(BOARD[provider].awaited()).toEqual(["TEAM-4156", "TEAM-4157"]);
      expect(r2.preconditionUnmet.reportedAt).toBe("2026-09-06T07:07:00.000Z");
    });

    it("F3: a same-ids re-report performs NO provider write at all", async () => {
      await annotate(FIRST);
      const writesAfterFirst = BOARD[provider].writes();
      expect(writesAfterFirst).toBeGreaterThan(0); // the first report really wrote

      const r2 = await annotate(FIRST);

      // Nothing new to say → nothing written, so neither `updatedAt` (DDB) nor the
      // issue's `updated` (Jira) moves. parkedLongEnough / the wait SLA read those.
      expect(BOARD[provider].writes()).toBe(writesAfterFirst);
      expect(r2.unchanged).toBe(true);
      // The return contract still holds on the no-op path.
      expect(r2.ticketId).toBe("TEAM-4126");
      expect(r2.preconditionUnmet.awaitingIds).toContain("TEAM-4156");
      expect(r2.preconditionUnmet.reportedAt).toBe("2026-09-06T07:07:00.000Z");
    });
  });

  /**
   * TEAM-4261 — the FAILURE half of the same parity contract.
   *
   * workflow-output's report_precondition_unmet cannot branch on provider, so a
   * HANDLED failure has to be shape-identical too: a non-empty top-level `error`
   * and NONE of the success keys. Before this ticket the dynamodb provider
   * answered content-only text (`{ content: [{ text: "Issue … not found." }] }`)
   * while jira threw into a `{ error }` catch — and because the consumer inferred
   * success from the ABSENCE of error keys, a failed annotate on dynamodb was
   * reported to the agent as a successful park with nothing written and nothing to
   * re-wake it (ship-review r2-F2).
   *
   * Asserted on SHAPE, not on message text: the texts are provider-specific, the
   * contract is not.
   */
  describe(`annotate failure contract [provider=${provider}]`, () => {
    const annotate = (parameters) =>
      HANDLERS[provider]({ tool_name: "Tickets___annotate_precondition_unmet", parameters });

    const expectHandledFailure = (r) => {
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
      // No success keys — the consumer's positive check must not be satisfiable.
      expect(r.ticketId).toBeUndefined();
      expect(r.preconditionUnmet).toBeUndefined();
    };

    it("a ticket that does not exist is a handled failure, and nothing lands on the board", async () => {
      if (provider === "dynamodb") h.ddbItem = null;
      else h.jiraMissing = true;

      const r = await annotate({ ticket_id: "TEAM-404", awaitingIds: ["TEAM-4156"] });

      expectHandledFailure(r);
      // No stamp on the DDB column / no `awaiting:` label on the Jira issue.
      expect(BOARD[provider].awaited()).toEqual([]);
    });

    it("a missing ticket_id is a handled failure with no provider call at all", async () => {
      const r = await annotate({ awaitingIds: ["TEAM-4156"] });

      expectHandledFailure(r);
      expect(BOARD[provider].writes()).toBe(0);
    });
  });
}
