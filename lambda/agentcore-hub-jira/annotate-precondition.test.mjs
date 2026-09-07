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
    // round-trips as a real ticket key. TEAM-4184: plus the reportedAt clock.
    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [
      { add: "awaiting:TEAM-4156" },
      { add: "awaiting:TEAM-4157" },
      { add: `precondition-at:${Date.parse("2026-09-06T08:00:00.000Z")}` },
    ]);

    // NEVER a transition.
    assert.ok(!calls.some((c) => /\/transitions/.test(c.path)), "must never transition");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/**
 * TEAM-4184 — the reportedAt clock must survive a FIELDS-ONLY read, because the
 * sibling read the D2 evidence guard runs (getChildTicketsFromJira) requests no
 * `comment` field, and Jira caps an issue's comments at the 20 oldest anyway. So
 * it rides a `precondition-at:<epochMs>` label, written MONOTONICALLY: newest
 * wins, superseded labels are pruned in the same PUT, an older re-report is a
 * no-op on the clock.
 */
function recordingFetch(calls, existingLabels) {
  return async (url, options = {}) => {
    const method = options.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });
    if (method === "POST" && /\/comment$/.test(path)) return response(201, { id: "10001" });
    if (method === "PUT" && /\/issue\/[^/]+$/.test(path)) return response(204, "");
    if (method === "GET" && /\/issue\/[^/]+\?fields=labels$/.test(path)) {
      if (existingLabels === "throw") return response(500, "boom");
      return response(200, { fields: { labels: existingLabels || [] } });
    }
    return response(200, {});
  };
}

const annotate = (parameters) =>
  jira.handler({ tool_name: "Tickets___annotate_precondition_unmet", parameters });

test("annotate_precondition_unmet (jira): a NEWER reportedAt adds the clock and prunes the superseded label", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const older = `precondition-at:${Date.parse("2026-09-06T07:07:00.000Z")}`;
  globalThis.fetch = recordingFetch(calls, ["wf:wf_1", "awaiting:TEAM-4156", older]);

  try {
    await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
      reportedAt: "2026-09-06T09:10:00.000Z", source: "tool",
    });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    const newer = `precondition-at:${Date.parse("2026-09-06T09:10:00.000Z")}`;
    assert.deepEqual(put.body.update.labels, [
      { add: "awaiting:TEAM-4157" },
      { add: newer },
      { remove: older },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): an OLDER reportAt never moves the clock backwards and prunes nothing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const newer = `precondition-at:${Date.parse("2026-09-06T09:10:00.000Z")}`;
  globalThis.fetch = recordingFetch(calls, ["awaiting:TEAM-4156", newer]);

  try {
    // The level-triggered pickup re-reports a DERIVED (spawn-time) stamp long
    // after the agent's own tool report. It must not clobber the live clock.
    await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"],
      reportedAt: "2026-09-06T07:07:00.000Z", source: "derived",
    });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    // Only the (idempotent, server-side-deduped) awaiting add — no clock add, no
    // remove of the fresher label.
    assert.deepEqual(put.body.update.labels, [{ add: "awaiting:TEAM-4156" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): a failed labels read still writes the clock (max-wins makes pruning optional)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = recordingFetch(calls, "throw");

  try {
    await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
      reportedAt: "2026-09-06T09:10:00.000Z", source: "tool",
    });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [
      { add: "awaiting:TEAM-4157" },
      { add: `precondition-at:${Date.parse("2026-09-06T09:10:00.000Z")}` },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): the clock label is written even with NO awaited ids", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = recordingFetch(calls, []);

  try {
    await annotate({ ticket_id: "TEAM-4126", awaitingIds: [], reportedAt: "2026-09-06T09:10:00.000Z" });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.ok(put, "expected the PUT to fire for the clock alone");
    assert.deepEqual(put.body.update.labels, [
      { add: `precondition-at:${Date.parse("2026-09-06T09:10:00.000Z")}` },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): an unparseable reportedAt writes no clock label at all", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = recordingFetch(calls, []);

  try {
    await annotate({ ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"], reportedAt: "not-a-date" });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [{ add: "awaiting:TEAM-4157" }]);
    assert.ok(
      !JSON.stringify(put.body).includes("precondition-at:"),
      "must never write precondition-at:NaN"
    );
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
    // No clock label on this issue → no invented reportedAt.
    assert.equal("reportedAt" in t.preconditionUnmet, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): getIssue reads reportedAt back off the clock label — MAX when several survive", async () => {
  const originalFetch = globalThis.fetch;
  const older = Date.parse("2026-09-06T07:07:00.000Z");
  const newer = Date.parse("2026-09-06T09:10:00.000Z");
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (method === "GET" && /\/comment(\?|$)/.test(path)) return response(200, { comments: [] });
    if (method === "GET" && /\/issue\/[^/?]+/.test(path)) {
      return response(200, {
        key: "TEAM-4126",
        fields: {
          summary: "ship", status: { name: "In Progress" }, issuetype: { name: "Task" },
          // Both clock labels present — a prune that failed. Max still wins, so
          // the guard reads the RIGHT instant.
          labels: [
            "wf:wf_1", "awaiting:TEAM-4157",
            `precondition-at:${older}`, `precondition-at:${newer}`, "precondition-at:junk",
          ],
        },
      });
    }
    return response(200, {});
  };

  try {
    const t = await jira.getIssue({ ticket_id: "TEAM-4126" });
    assert.equal(t.preconditionUnmet.reportedAt, new Date(newer).toISOString());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
