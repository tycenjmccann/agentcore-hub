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
 * it rides a `precondition-at:<epochMs>` label.
 *
 * TEAM-4185 F3 flips WHICH stamp wins: FIRST-writer, not newest. The stamp records
 * when the wait BEGAN, and a clock that moved forward on every re-report restarted
 * the FR-1.4 wait SLA (same change as the DynamoDB twin's reportedAt merge). So an
 * existing clock is preserved and reported back, a real write prunes the newer
 * sibling labels so the max-wins READERS converge on that first instant, and a
 * re-report with nothing new to say writes NOTHING — no comment, no PUT — because
 * either write bumps the issue's `updated`, which is the field parkedLongEnough
 * reads.
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

test("annotate_precondition_unmet (jira): TEAM-4185 F3 — a NEWER reportedAt never replaces the existing clock", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const older = `precondition-at:${Date.parse("2026-09-06T07:07:00.000Z")}`;
  globalThis.fetch = recordingFetch(calls, ["wf:wf_1", "awaiting:TEAM-4156", older]);

  try {
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
      reportedAt: "2026-09-06T09:10:00.000Z", source: "tool",
    });

    // The new awaited id lands; the clock is left exactly as it was. (Pre-4185 this
    // added precondition-at:09:10 and removed the 07:07 one.)
    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [{ add: "awaiting:TEAM-4157" }]);

    // The PRESERVED stamp is what the tool reports back and what the marker
    // comment carries — the comment trail and the label clock never disagree.
    assert.equal(r.preconditionUnmet.reportedAt, "2026-09-06T07:07:00.000Z");
    const comment = calls.find((c) => c.method === "POST" && /\/comment$/.test(c.path));
    assert.ok(JSON.stringify(comment.body).includes("2026-09-06T07:07:00.000Z"));
    assert.ok(!JSON.stringify(comment.body).includes("09:10"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): TEAM-4185 F3 — a real write prunes back to the OLDEST clock", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const older = `precondition-at:${Date.parse("2026-09-06T07:07:00.000Z")}`;
  const newer = `precondition-at:${Date.parse("2026-09-06T09:10:00.000Z")}`;
  // Two clock labels — a prune that failed earlier. The max-wins readers would
  // read 09:10; pruning the newer one converges them on the first stamp.
  globalThis.fetch = recordingFetch(calls, ["awaiting:TEAM-4156", older, newer]);

  try {
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4157"],
      reportedAt: "2026-09-06T10:00:00.000Z", source: "tool",
    });

    const put = calls.find((c) => c.method === "PUT" && /\/issue\/TEAM-4126$/.test(c.path));
    assert.deepEqual(put.body.update.labels, [
      { add: "awaiting:TEAM-4157" },
      { remove: newer },
    ]);
    assert.equal(r.preconditionUnmet.reportedAt, "2026-09-06T07:07:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): TEAM-4185 F3 — a re-report with no new id and a clock present writes NOTHING", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const clock = `precondition-at:${Date.parse("2026-09-06T07:07:00.000Z")}`;
  globalThis.fetch = recordingFetch(calls, ["awaiting:TEAM-4156", clock]);

  try {
    // The level-triggered pickup re-reports a DERIVED (spawn-time) stamp long
    // after the agent's own tool report — the every-sweep case. Pre-4185 this
    // POSTed a duplicate marker comment, bumping the issue's `updated` and so
    // resetting parkedLongEnough: the parked ticket could never be recovered.
    const r = await annotate({
      ticket_id: "TEAM-4126", awaitingIds: ["TEAM-4156"],
      reportedAt: "2026-09-06T09:10:00.000Z", source: "derived",
    });

    assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "no write of any kind");
    assert.ok(!calls.some((c) => c.method === "POST"), "no marker comment");
    assert.ok(!calls.some((c) => c.method === "PUT"), "no label PUT");
    // The contract still holds on the no-op path, carrying the preserved clock.
    assert.equal(r.ticketId, "TEAM-4126");
    assert.equal(r.unchanged, true);
    assert.equal(r.preconditionUnmet.reportedAt, "2026-09-06T07:07:00.000Z");
    assert.deepEqual(r.preconditionUnmet.awaitingIds, ["TEAM-4156"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("annotate_precondition_unmet (jira): a failed labels read still writes the clock (fails SAFE toward writing)", async () => {
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

test("annotate_precondition_unmet (jira): nothing to add AND no writable clock → no write (TEAM-4185 F3)", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = recordingFetch(calls, []);

  try {
    // No awaited ids and an unparseable stamp: there is literally nothing to
    // record, so the tool must not leave a comment behind either.
    const r = await annotate({ ticket_id: "TEAM-4126", awaitingIds: [], reportedAt: "not-a-date" });
    assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
    assert.equal(r.unchanged, true);
    assert.equal(r.ticketId, "TEAM-4126");
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
