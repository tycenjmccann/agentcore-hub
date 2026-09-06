import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4166 §1.2 — the Jira twin of `annotate_precondition_unmet`. Jira has no
 * structured columns, so the awaited siblings ride as `awaiting:<id>` LABELS
 * (the durable index the orchestrator reads back) plus a structured comment
 * marker for the richer fields. Deliberately NO transition — this is an
 * annotation. And the labels must round-trip: mapIssue (exercised here through
 * the exported getIssue) reconstructs `preconditionUnmet.awaitingIds` from them,
 * so a Jira-mode ticket carries the SAME field a DynamoDB-mode one stores.
 */

const h = vi.hoisted(() => ({ calls: [] }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
}));

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return typeof body === "string" ? body : JSON.stringify(body ?? {}); },
  };
}

// A recording fetch keyed by `METHOD path`. Comment POST / label PUT succeed;
// GET issue + GET comments serve whatever `h.issue` / `h.comments` hold.
vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
  const method = options.method || "GET";
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  h.calls.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });
  if (method === "POST" && /\/comment$/.test(path)) return response(201, { id: "10001" });
  if (method === "PUT" && /\/issue\/[^/]+$/.test(path)) return response(204, "");
  if (method === "GET" && /\/comment(\?|$)/.test(path)) return response(200, { comments: h.comments || [] });
  if (method === "GET" && /\/issue\/[^/?]+/.test(path)) return response(200, h.issue || {});
  return response(200, {});
}));

delete process.env.ARTIFACT_BUCKET; // loadValidAssignees skips S3 → fallback roster
const jira = await import("./index.mjs");

beforeEach(() => {
  h.calls.length = 0;
  h.issue = null;
  h.comments = [];
});

describe("annotate_precondition_unmet (jira)", () => {
  it("posts a marker comment + awaiting: labels, never transitions, returns { ticketId, preconditionUnmet }", async () => {
    const r = await jira.handler({
      tool_name: "Tickets___annotate_precondition_unmet",
      parameters: {
        ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156", "TEAM-4157"], note: "waiting",
        reportedAt: "2026-09-06T08:00:00.000Z", agentId: "agentcore_hub_release_manager", source: "tool",
      },
    });

    expect(r.ticketId).toBe("TEAM-4126");
    expect(r.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
    expect(r.preconditionUnmet.source).toBe("tool");

    // The comment carries the machine-readable marker.
    const comment = h.calls.find((c) => c.method === "POST" && /\/comment$/.test(c.path));
    expect(comment).toBeTruthy();
    const commentText = JSON.stringify(comment.body);
    expect(commentText).toContain("<!-- precondition-unmet");
    expect(commentText).toContain("TEAM-4156");

    // Labels are added via the additive update verb, case PRESERVED so the id
    // round-trips as a real ticket key.
    const put = h.calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    expect(put.body.update.labels).toEqual([{ add: "awaiting:TEAM-4156" }, { add: "awaiting:TEAM-4157" }]);

    // NEVER a transition.
    expect(h.calls.some((c) => /\/transitions/.test(c.path))).toBe(false);
  });

  it("round-trips: getIssue rebuilds preconditionUnmet.awaitingIds from awaiting: labels", async () => {
    h.issue = {
      key: "TEAM-4126",
      fields: {
        summary: "ship", status: { name: "In Progress" }, issuetype: { name: "Task" },
        labels: ["wf:wf_1", "awaiting:TEAM-4156", "awaiting:TEAM-4157"],
      },
    };
    const t = await jira.getIssue({ ticket_id: "TEAM-4126" });
    expect(t.preconditionUnmet.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
    expect(t.preconditionUnmet.source).toBe("label"); // mapIssue sees only fields
  });
});
