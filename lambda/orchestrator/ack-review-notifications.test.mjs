/**
 * Unit tests for scoped acknowledgment of review_needed notifications on gate
 * resolution (reviewAckIndices / ackReviewNotifications + their call sites).
 *
 * Run: node --test lambda/orchestrator/ack-review-notifications.test.mjs
 *
 * All AWS clients are stubbed by monkey-patching the client prototypes'
 * `send` — instances delegate to the prototype chain, so patching after
 * import works and no network/credential resolution ever happens.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ARTIFACT_BUCKET must be set BEFORE importing index.mjs (read at module load)
// so loadWorkflowDefs fetches our stubbed workflows.json — the hold-branch test
// needs a workflow def with a reviewGates onReject:"hold" entry.
process.env.ARTIFACT_BUCKET = "test-artifact-bucket";

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";

const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";

// ─── Stub state (reset per test) ──────────────────────────────────────────────

const state = {
  tickets: new Map(),      // ticketId → item (GetCommand on tickets table)
  children: new Map(),     // parentId → items (QueryCommand on parentId-index)
  workflows: new Map(),    // workflowId → workflow row
  sent: [],                // every ddb command: { name, input }
  failMatcher: null,       // (name, input) => truthy → reject that send; return an Error to throw it verbatim
};

beforeEach(() => {
  state.tickets.clear();
  state.children.clear();
  state.workflows.clear();
  state.sent = [];
  state.failMatcher = null;
});

// ─── DynamoDB DocumentClient router ───────────────────────────────────────────

DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const name = cmd.constructor.name;
  const input = cmd.input;
  state.sent.push({ name, input });
  if (state.failMatcher) {
    const fail = state.failMatcher(name, input);
    if (fail) throw fail instanceof Error ? fail : new Error("simulated DynamoDB failure");
  }
  if (name === "GetCommand" && input.TableName === TICKETS_TABLE) {
    return { Item: state.tickets.get(input.Key.ticketId) || undefined };
  }
  if (name === "GetCommand" && input.TableName === WORKFLOWS_TABLE) {
    return { Item: state.workflows.get(input.Key.workflowId) || undefined };
  }
  if (name === "QueryCommand" && input.TableName === TICKETS_TABLE) {
    const pid = input.ExpressionAttributeValues?.[":pid"];
    return { Items: state.children.get(pid) || [] };
  }
  if (name === "QueryCommand") return { Items: [] };
  if (name === "ScanCommand") return { Items: [] };
  return {}; // Update/Put mutations are captured only
};

// EventBridge → resolved no-op (publishEvent must not stall on credentials).
EventBridgeClient.prototype.send = async () => ({});

// S3 → serve the orchestrator's config objects. agents.json errors (exercises
// the fallback-roster path, which includes agentcore_hub_backend_dev);
// workflows.json carries the "hold-def" used by the hold-branch test.
S3Client.prototype.send = async (cmd) => {
  const key = cmd.input?.Key;
  if (key === "config/workflows.json") {
    const config = {
      workflows: [{
        id: "hold-def",
        intakeAgentId: "agentcore_hub_requirements_analyst",
        phases: [{ agentPhase: "development" }],
        completionRequiresAgentPhases: ["development"],
        reviewGates: [{ afterPhase: "development", onReject: "hold" }],
      }],
    };
    return { Body: { transformToString: async () => JSON.stringify(config) } };
  }
  throw new Error(`no stub for S3 key ${key}`);
};

const { handler, ackReviewNotifications, reviewAckIndices, handleTicketDoneUnified } =
  await import("./index.mjs");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notif(ticketId, { type = "review_needed", acknowledged = false } = {}) {
  return { id: `notif_${ticketId}`, type, ticketId, reviewer: "alice", acknowledged };
}

function ackUpdates() {
  return state.sent.filter(
    (c) => c.name === "UpdateCommand" &&
      c.input.TableName === WORKFLOWS_TABLE &&
      (c.input.UpdateExpression || "").includes("humanNotifications[")
  );
}

function ticketReopens() {
  return state.sent.filter(
    (c) => c.name === "UpdateCommand" &&
      c.input.TableName === TICKETS_TABLE &&
      c.input.ExpressionAttributeValues?.[":s"] === "todo"
  );
}

function siblingQueries() {
  return state.sent.filter(
    (c) => c.name === "QueryCommand" && c.input.TableName === TICKETS_TABLE
  );
}

/** Fixture: gate ticket + workflow + one non-blocked sibling, DDB provider. */
function seedGateFixture(n, { assignee = "human:alice", notifications } = {}) {
  const ticketId = `T-GATE${n}`;
  const parentId = `EPIC-${n}`;
  const workflowId = `wf_test${n}`;
  const workflow = {
    id: workflowId,
    workflowId,
    workflowDefId: "software-delivery",
    phase: "verification",
    agentTasks: {},
    humanNotifications: notifications ?? [notif(ticketId)],
  };
  state.workflows.set(workflowId, workflow);
  const gate = { ticketId, status: "done", assignee, parentId, workflowId, type: "task" };
  state.tickets.set(ticketId, gate);
  // A todo sibling with no blockers: cascade unblocks nothing and the
  // workflow is not complete, so completeWorkflow never runs.
  state.children.set(parentId, [
    gate,
    { ticketId: `T-SIB${n}`, status: "todo", assignee: "agentcore_hub_backend_dev", parentId, blockedBy: [] },
  ]);
  return { ticketId, parentId, workflowId, workflow, gate };
}

/** DDB-stream MODIFY record with typed attribute values. */
function streamRecord(image, oldStatus) {
  const s = (v) => ({ S: v });
  const NewImage = {
    ticketId: s(image.ticketId),
    status: s(image.status),
    ...(image.parentId ? { parentId: s(image.parentId) } : {}),
    ...(image.workflowId ? { workflowId: s(image.workflowId) } : {}),
    ...(image.assignee ? { assignee: s(image.assignee) } : {}),
  };
  return {
    Records: [{
      eventName: "MODIFY",
      dynamodb: { NewImage, OldImage: { ticketId: s(image.ticketId), status: s(oldStatus) } },
    }],
  };
}

// ─── 1. Helper unit tests ─────────────────────────────────────────────────────

test("multi-index ack: one UpdateCommand targeting exactly the matching indices", async () => {
  const workflow = {
    id: "wf_multi",
    humanNotifications: [
      notif("T-OTHER"),                                   // 0: other ticket, unacked
      notif("T-1", { acknowledged: true }),               // 1: matching but acked
      notif("T-1"),                                       // 2: MATCH
      notif("T-1", { type: "workflow_complete" }),        // 3: same ticket, other type
      notif("T-2"),                                       // 4: other ticket
      notif("T-1"),                                       // 5: MATCH
    ],
  };

  assert.deepEqual(reviewAckIndices(workflow, "T-1"), [2, 5]);
  await ackReviewNotifications(workflow, "T-1");

  const updates = ackUpdates();
  assert.equal(updates.length, 1, "exactly one UpdateCommand");
  assert.equal(state.sent.length, 1, "no other sends");
  const { input } = updates[0];
  assert.equal(
    input.UpdateExpression,
    "SET humanNotifications[2].acknowledged = :true, humanNotifications[5].acknowledged = :true"
  );
  // Identity guard: every targeted index asserts ticketId + type, so a
  // compaction-shifted (or out-of-range) index fails the condition instead
  // of acking the wrong entry.
  assert.equal(
    input.ConditionExpression,
    "humanNotifications[2].ticketId = :tid AND humanNotifications[2].#nt = :rn AND " +
    "humanNotifications[5].ticketId = :tid AND humanNotifications[5].#nt = :rn"
  );
  assert.deepEqual(input.ExpressionAttributeNames, { "#nt": "type" });
  assert.deepEqual(input.ExpressionAttributeValues, { ":true": true, ":tid": "T-1", ":rn": "review_needed" });
  assert.deepEqual(input.Key, { workflowId: "wf_multi" });
  assert.equal(input.TableName, WORKFLOWS_TABLE);

  assert.equal(workflow.humanNotifications[2].acknowledged, true);
  assert.equal(workflow.humanNotifications[5].acknowledged, true);
  assert.equal(workflow.humanNotifications[0].acknowledged, false, "index 0 untouched");
});

test("idempotent redelivery: all matching already acknowledged → zero sends", async () => {
  const workflow = {
    id: "wf_idem",
    humanNotifications: [notif("T-1", { acknowledged: true }), notif("T-1", { acknowledged: true })],
  };
  assert.deepEqual(reviewAckIndices(workflow, "T-1"), []);
  await ackReviewNotifications(workflow, "T-1");
  assert.equal(state.sent.length, 0);
});

test("no-match no-op: absent / empty / non-array humanNotifications", async () => {
  for (const humanNotifications of [undefined, [], "not-an-array"]) {
    const workflow = { id: "wf_edge", ...(humanNotifications !== undefined ? { humanNotifications } : {}) };
    assert.deepEqual(reviewAckIndices(workflow, "T-1"), []);
    await ackReviewNotifications(workflow, "T-1"); // must not throw
  }
  assert.deepEqual(reviewAckIndices(undefined, "T-1"), []);
  assert.equal(state.sent.length, 0);
});

test("selectivity: other types and other tickets are never targeted", async () => {
  const workflow = {
    id: "wf_sel",
    humanNotifications: [
      notif("T-1", { type: "workflow_complete" }),  // same ticket, wrong type
      notif("T-1", { type: "input_needed" }),       // same ticket, wrong type
      notif("T-9"),                                 // review_needed, wrong ticket
      notif("T-1"),                                 // 3: the only MATCH
    ],
  };
  await ackReviewNotifications(workflow, "T-1");
  const updates = ackUpdates();
  assert.equal(updates.length, 1);
  assert.equal(
    updates[0].input.UpdateExpression,
    "SET humanNotifications[3].acknowledged = :true"
  );
  assert.equal(
    updates[0].input.ConditionExpression,
    "humanNotifications[3].ticketId = :tid AND humanNotifications[3].#nt = :rn"
  );
  assert.deepEqual(updates[0].input.ExpressionAttributeNames, { "#nt": "type" });
  assert.equal(workflow.humanNotifications[0].acknowledged, false);
  assert.equal(workflow.humanNotifications[1].acknowledged, false);
  assert.equal(workflow.humanNotifications[2].acknowledged, false);
});

test("failure isolation: send rejects → resolves without throwing, snapshot NOT mutated", async () => {
  const workflow = { id: "wf_fail", humanNotifications: [notif("T-1")] };
  state.failMatcher = (name, input) =>
    name === "UpdateCommand" && (input.UpdateExpression || "").includes("humanNotifications[");
  await ackReviewNotifications(workflow, "T-1"); // must not throw
  assert.equal(workflow.humanNotifications[0].acknowledged, false, "in-memory snapshot untouched on failure");
});

test("dedup interplay: after a successful ack the dedup predicate finds no open notification", async () => {
  const workflow = { id: "wf_dedup", humanNotifications: [notif("T-1"), notif("T-1")] };
  await ackReviewNotifications(workflow, "T-1");
  // The exact predicate handleHumanReviewGate uses to skip re-notification:
  const alreadyNotified = workflow.humanNotifications.some(
    (n) => n.ticketId === "T-1" && n.type === "review_needed" && !n.acknowledged
  );
  assert.equal(alreadyNotified, false, "a re-parked gate would create a fresh notification");
});

// ─── 2. Call-site tests ───────────────────────────────────────────────────────

test("approve-ack, unified path: gate done → scoped ack issued, cascade still runs", async () => {
  const { ticketId } = seedGateFixture(7);
  await handleTicketDoneUnified(ticketId);

  const updates = ackUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.UpdateExpression, "SET humanNotifications[0].acknowledged = :true");
  assert.equal(
    updates[0].input.ConditionExpression,
    "humanNotifications[0].ticketId = :tid AND humanNotifications[0].#nt = :rn"
  );
  assert.deepEqual(updates[0].input.Key, { workflowId: "wf_test7" });
  assert.ok(siblingQueries().length >= 1, "sibling query ran after the ack");
});

test("approve-ack, legacy stream path: DDB-stream image → same scoped ack", async () => {
  const { gate } = seedGateFixture(8);
  await handler(streamRecord(gate, "in_review"));

  const updates = ackUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.UpdateExpression, "SET humanNotifications[0].acknowledged = :true");
  assert.deepEqual(updates[0].input.Key, { workflowId: "wf_test8" });
  assert.ok(siblingQueries().length >= 1, "sibling query ran after the ack");
});

test("non-gate no-op: agent assignee done → no humanNotifications UpdateCommand", async () => {
  const uf = seedGateFixture(91, { assignee: "agentcore_hub_backend_dev" });
  await handleTicketDoneUnified(uf.ticketId);
  assert.equal(ackUpdates().length, 0, "unified path: no ack write for agent tickets");

  const lf = seedGateFixture(92, { assignee: "agentcore_hub_backend_dev" });
  await handler(streamRecord(lf.gate, "in_review"));
  assert.equal(ackUpdates().length, 0, "legacy path: no ack write for agent tickets");
});

test("reject-ack, rework branch: ack issued AND upstream re-opens still execute", async () => {
  const f = seedGateFixture(10);
  // Gate rejected: blocked, reviews T-DEV10 (an agent ticket in the roster).
  const gate = {
    ...f.gate, status: "blocked", blockedBy: ["T-DEV10"], reviewComment: "please fix the edge case",
  };
  state.tickets.set(f.ticketId, gate);
  state.tickets.set("T-DEV10", {
    ticketId: "T-DEV10", status: "done", assignee: "agentcore_hub_backend_dev",
    parentId: f.parentId, workflowId: f.workflowId,
  });

  await handler(streamRecord(gate, "in_review"));

  const updates = ackUpdates();
  assert.equal(updates.length, 1, "ack persisted on rejection");
  assert.equal(updates[0].input.UpdateExpression, "SET humanNotifications[0].acknowledged = :true");
  const reopens = ticketReopens();
  assert.equal(reopens.length, 1, "upstream ticket re-opened");
  assert.deepEqual(reopens[0].input.Key, { ticketId: "T-DEV10" });
  const resumeWrites = state.sent.filter(
    (c) => c.name === "UpdateCommand" && (c.input.UpdateExpression || "").includes("resumeContexts")
  );
  assert.ok(resumeWrites.length >= 1, "rework feedback persisted");
});

test("reject-ack, hold branch: ack issued before the early return; no re-open writes", async () => {
  const f = seedGateFixture(11);
  f.workflow.workflowDefId = "hold-def"; // gate config: afterPhase development, onReject hold
  const gate = { ...f.gate, status: "blocked", blockedBy: ["T-DEV11"] };
  state.tickets.set(f.ticketId, gate);
  state.tickets.set("T-DEV11", {
    ticketId: "T-DEV11", status: "done", assignee: "agentcore_hub_backend_dev",
    parentId: f.parentId, workflowId: f.workflowId,
  });

  await handler(streamRecord(gate, "in_review"));

  assert.equal(ackUpdates().length, 1, "ack persisted even on hold");
  assert.equal(ticketReopens().length, 0, "no re-open after the hold early-return");
  const resumeWrites = state.sent.filter(
    (c) => c.name === "UpdateCommand" && (c.input.UpdateExpression || "").includes("resumeContexts")
  );
  assert.equal(resumeWrites.length, 0, "no resume-context writes on hold");
});

test("ack failure doesn't kill the cascade: sibling query still runs", async () => {
  const { ticketId } = seedGateFixture(12);
  state.failMatcher = (name, input) =>
    name === "UpdateCommand" && (input.UpdateExpression || "").includes("humanNotifications[");

  await handleTicketDoneUnified(ticketId); // must not throw

  assert.equal(ackUpdates().length, 1, "the failing ack attempt was made");
  assert.ok(siblingQueries().length >= 1, "cascade continued past the failed ack");
});

// ─── 3. Compaction race (complete route's compactNotifications rewrites the ────
//        list under the done-cascade — indices computed from the in-memory
//        snapshot go stale; the identity guard + re-read-retry must converge)

function conditionalError() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

/** failMatcher that conditional-fails the first `n` humanNotifications ack writes. */
function failFirstAcks(n) {
  let count = 0;
  return (name, input) => {
    if (name === "UpdateCommand" && (input.UpdateExpression || "").includes("humanNotifications[")) {
      count++;
      if (count <= n) return conditionalError();
    }
    return false;
  };
}

function workflowReads() {
  return state.sent.filter(
    (c) => c.name === "GetCommand" && c.input.TableName === WORKFLOWS_TABLE
  );
}

test("compaction race: stale index → conditional failure → re-read, retry converges at shifted index", async () => {
  const esc = () => notif("T-ESC", { type: "manager_escalation" });
  // Pre-compaction snapshot: review_needed for T-1 sits at index 4, behind escalations.
  const workflow = {
    id: "wf_race_a",
    humanNotifications: [esc(), esc(), esc(), esc(), notif("T-1")],
  };
  // Post-compaction row: compactNotifications moved escalations to the tail
  // (kept last 3) — the review_needed entry shifted down to index 0.
  const freshList = [notif("T-1"), esc(), esc(), esc()];
  state.workflows.set("wf_race_a", { workflowId: "wf_race_a", id: "wf_race_a", humanNotifications: freshList });
  state.failMatcher = failFirstAcks(1);

  await ackReviewNotifications(workflow, "T-1"); // must not throw

  const updates = ackUpdates();
  assert.equal(updates.length, 2, "exactly two UpdateCommands: stale attempt + guarded retry");
  assert.equal(updates[0].input.UpdateExpression, "SET humanNotifications[4].acknowledged = :true");
  assert.equal(updates[1].input.UpdateExpression, "SET humanNotifications[0].acknowledged = :true");
  assert.equal(
    updates[1].input.ConditionExpression,
    "humanNotifications[0].ticketId = :tid AND humanNotifications[0].#nt = :rn"
  );
  assert.deepEqual(updates[1].input.ExpressionAttributeNames, { "#nt": "type" });
  assert.equal(updates[1].input.ExpressionAttributeValues[":tid"], "T-1");
  assert.equal(updates[1].input.ExpressionAttributeValues[":rn"], "review_needed");
  const reads = workflowReads();
  assert.equal(reads.length, 1, "one fresh re-read between the attempts");
  assert.equal(reads[0].input.ConsistentRead, true);
  // In-memory snapshot was swapped to the fresh list and the entry acked there.
  assert.equal(workflow.humanNotifications, freshList);
  assert.equal(workflow.humanNotifications[0].type, "review_needed");
  assert.equal(workflow.humanNotifications[0].acknowledged, true);
});

test("compaction race: retry finds entry already acked → no second write, no error log", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const workflow = { id: "wf_race_b", humanNotifications: [notif("T-ESC", { type: "manager_escalation" }), notif("T-1")] };
  state.workflows.set("wf_race_b", {
    workflowId: "wf_race_b", id: "wf_race_b",
    humanNotifications: [notif("T-1", { acknowledged: true })],
  });
  state.failMatcher = failFirstAcks(1);

  await ackReviewNotifications(workflow, "T-1"); // must not throw

  assert.equal(ackUpdates().length, 1, "no second UpdateCommand — another writer already acked");
  assert.equal(workflowReads().length, 1, "fresh re-read happened");
  const failureLogs = errSpy.mock.calls.filter((c) =>
    String(c.arguments[0]).includes("ackReviewNotifications failed")
  );
  assert.equal(failureLogs.length, 0, "no-op success is not logged as a failure");
});

test("compaction race: second conditional failure is non-fatal — logged, snapshot unmutated", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const workflow = { id: "wf_race_c", humanNotifications: [notif("T-1")] };
  const freshList = [notif("T-1")]; // still open — retry fails again anyway
  state.workflows.set("wf_race_c", { workflowId: "wf_race_c", id: "wf_race_c", humanNotifications: freshList });
  state.failMatcher = failFirstAcks(2);

  await ackReviewNotifications(workflow, "T-1"); // must not throw

  assert.equal(ackUpdates().length, 2, "exactly one retry — no infinite loop");
  const failureLogs = errSpy.mock.calls.filter((c) =>
    String(c.arguments[0]).includes("ackReviewNotifications failed for T-1")
  );
  assert.equal(failureLogs.length, 1, "failure logged via the non-fatal path");
  assert.equal(workflow.humanNotifications[0].acknowledged, false, "in-memory entry not mutated on failure");
});

test("compaction race: non-conditional error → no re-read, no retry, still non-fatal", async () => {
  const workflow = { id: "wf_race_d", humanNotifications: [notif("T-1")] };
  state.failMatcher = (name, input) =>
    name === "UpdateCommand" && (input.UpdateExpression || "").includes("humanNotifications[");

  await ackReviewNotifications(workflow, "T-1"); // must not throw

  assert.equal(ackUpdates().length, 1, "generic errors are not retried");
  assert.equal(workflowReads().length, 0, "no fresh re-read for non-conditional errors");
  assert.equal(workflow.humanNotifications[0].acknowledged, false);
});
