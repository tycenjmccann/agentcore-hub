/**
 * TEAM-4166 §1.2 — the Jira twin of `annotate_precondition_unmet`. Jira has no
 * structured columns, so the awaited siblings ride as `awaiting:<id>` LABELS
 * (the durable index the orchestrator reads back) plus a structured comment
 * marker for the richer fields. Deliberately NO transition — this is an
 * annotation. And the labels must round-trip: mapIssue (exercised here through
 * the exported getIssue) reconstructs `preconditionUnmet.awaitingIds` from them,
 * so a Jira-mode ticket carries the SAME field a DynamoDB-mode one stores.
 *
 * Uses only Node's built-in runner (node:test + node:assert) — no ARTIFACT_BUCKET
 * so loadValidAssignees skips S3 entirely (see index.test.mjs for the pattern).
 */

import test from "node:test";
import assert from "node:assert/strict";

delete process.env.ARTIFACT_BUCKET;
const jira = await import("./index.mjs");

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return typeof body === "string" ? body : JSON.stringify(body ?? {}); },
  };
}

test("annotate_precondition_unmet (jira): posts a marker comment + awaiting: labels, never transitions, returns { ticketId, preconditionUnmet }", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  // A recording fetch keyed by `METHOD path`. Comment POST / label PUT succeed.
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });
    if (method === "POST" && /\/comment$/.test(path)) return response(201, { id: "10001" });
    if (method === "PUT" && /\/issue\/[^/]+$/.test(path)) return response(204, "");
    return response(200, {});
  };

  try {
    const r = await jira.handler({
      tool_name: "Tickets___annotate_precondition_unmet",
      parameters: {
        ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156", "TEAM-4157"], note: "waiting",
        reportedAt: "2026-09-06T08:00:00.000Z", agentId: "agentcore_hub_release_manager", source: "tool",
      },
    });

    assert.equal(r.ticketId, "TEAM-4126");
    assert.deepEqual(r.preconditionUnmet.awaitingIds, ["TEAM-4156", "TEAM-4157"]);
    assert.equal(r.preconditionUnmet.source, "tool");

    // The comment carries the machine-readable marker.
    const comment = calls.find((c) => c.method === "POST" && /\/comment$/.test(c.path));
    assert.ok(comment, "expected a comment POST");
    const commentText = JSON.stringify(comment.body);
    assert.ok(commentText.includes("<!-- precondition-unmet"));
    assert.ok(commentText.includes("TEAM-4156"));

    // Labels are added via the additive update verb, case PRESERVED so the id
    // round-trips as a real ticket key.
    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [{ add: "awaiting:TEAM-4156" }, { add: "awaiting:TEAM-4157" }]);

    // NEVER a transition.
    assert.ok(!calls.some((c) => /\/transitions/.test(c.path)), "must never transition");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): getIssue round-trips preconditionUnmet.awaitingIds from awaiting: labels", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (method === "GET" && /\/comment(\?|$)/.test(path)) return response(200, { comments: [] });
    if (method === "GET" && /\/issue\/[^/?]+/.test(path)) {
      return response(200, {
        key: "TEAM-4126",
        fields: {
          summary: "ship", status: { name: "In Progress" }, issuetype: { name: "Task" },
          labels: ["wf:wf_1", "awaiting:TEAM-4156", "awaiting:TEAM-4157"],
        },
      });
    }
    return response(200, {});
  };

  try {
    const t = await jira.getIssue({ ticket_id: "TEAM-4126" });
    assert.deepEqual(t.preconditionUnmet.awaitingIds, ["TEAM-4156", "TEAM-4157"]);
    assert.equal(t.preconditionUnmet.source, "label"); // mapIssue sees only fields
  } finally {
    globalThis.fetch = originalFetch;
  }
});
