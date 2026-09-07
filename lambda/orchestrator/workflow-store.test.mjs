import { describe, it, expect, beforeEach } from "vitest";
import {
  initWorkflowStore,
  createWorkflow,
  claimInvocation,
  trackTicket,
  mergeTaskMetadata,
  completeTaskEntry,
  setTaskStatus,
  markDeadSessionDetected,
  clearDeadSessionDetected,
  incrementDeadSessionRetry,
  markAwaitTimeoutEmitted,
  markInitialPhaseAnnounced,
  incrementCleanExitRedispatch,
  claimDeadSessionSynthesis,
  claimReverifySlot,
  releaseReverifySlot,
  advancePhase,
  setResumeContext,
  setRepoCheck,
  setCiCheck,
  setSyncMain,
  appendNotification,
  appendReviewNotificationOnce,
  ackNotifications,
  completeWorkflow,
  claimTerminalOutcome,
  claimFinalization,
  appendReviewRound,
  appendReviewCapEscalation,
  appendReviewAuthorization,
  setShipHeadDeferrals,
  appendReworkRound,
  appendReworkEscalation,
  appendReworkAuthorization,
  markGateRequested,
  markGateRejected,
  markGateRejectedFromLegacy,
  markGateApproved,
} from "./workflow-store.mjs";
import { GATE_STATES } from "./gate-state.mjs";

/**
 * R2 (docs/race-condition-study.md): every store op must be a SCOPED
 * conditional write — no full-row puts, no unconditioned map replacement.
 * These tests pin the write shapes with a stub client; the conditional-race
 * semantics (winner/loser) are pinned by simulating
 * ConditionalCheckFailedException.
 */

const sent = [];
let failNextCondition = false;
/**
 * The row a GetCommand sees. Only the re-verify-slot CAS reads back (on a LOST
 * condition, to tell "no task entry" from "this sha is already claimed"), so
 * everything else leaves this null and never notices.
 */
let stubItem = null;
/**
 * Per-conditional-write outcomes, consumed in order — `failNextCondition` is a
 * one-shot, and claimReverifySlot's stale takeover issues TWO conditional writes
 * around a read, so some tests must say "fail, then fail again".
 */
const condOutcomes = [];
/** A non-CCFE error to raise once, for the rethrow path. */
let throwOnce = null;

const stubDdb = {
  async send(cmd) {
    // Mirror the DocumentClient (removeUndefinedValues: true) + DynamoDB
    // validation: undefined attribute values are stripped client-side, and an
    // expression referencing a placeholder with no remaining value is a
    // ValidationException — the failure class TEAM-3683 F3 fixed.
    const present = new Set(
      Object.entries(cmd.input.ExpressionAttributeValues || {})
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
    );
    const exprs = [cmd.input.ConditionExpression, cmd.input.UpdateExpression]
      .filter(Boolean).join(" ");
    for (const ph of exprs.match(/:[A-Za-z0-9_]+/g) || []) {
      if (!present.has(ph)) {
        const err = new Error(`ExpressionAttributeValues missing ${ph}`);
        err.name = "ValidationException";
        throw err;
      }
    }
    sent.push({ type: cmd.constructor.name, input: cmd.input });
    if (throwOnce) {
      const err = throwOnce;
      throwOnce = null;
      throw err;
    }
    if (cmd.input.ConditionExpression) {
      const forced = condOutcomes.length ? condOutcomes.shift() : null;
      const fail = forced === null ? failNextCondition : forced === "fail";
      if (forced === null) failNextCondition = false;
      if (fail) {
        const err = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
    }
    if (cmd.constructor.name === "GetCommand") return { Item: stubItem };
    return {};
  },
};

beforeEach(() => {
  sent.length = 0;
  failNextCondition = false;
  condOutcomes.length = 0;
  stubItem = null;
  throwOnce = null;
  initWorkflowStore(stubDdb, "workflows-test");
});

const writes = () => sent.filter((c) => c.type !== "GetCommand");

/**
 * The phase VALUES a terminal-claim CAS refuses. TEAM-3755 F2 replaced both
 * hand-spelled guards with one derived from completion.mjs
 * TERMINAL_WORKFLOW_PHASES, so the placeholders are positional (:tp0…) and the
 * phase names live in ExpressionAttributeValues — assert the semantics (which
 * phases are refused) instead of the placeholder spelling, which is now an
 * implementation detail of the shared helper.
 */
const refusedPhases = (input) =>
  Object.entries(input.ExpressionAttributeValues || {})
    .filter(([key]) => String(input.ConditionExpression).includes(`phase <> ${key}`))
    .map(([, value]) => value)
    .sort();

/** All five phases a run can already be closed on (sorted, for comparison). */
const ALL_TERMINAL_PHASES = ["cancelled", "complete", "deploy-blocked", "error", "static-ci-only"];

describe("createWorkflow", () => {
  it("puts create-once (attribute_not_exists on the key)", async () => {
    const won = await createWorkflow({ id: "wf_1", phase: "requirements" });
    expect(won).toBe(true);
    expect(writes()[0].input.ConditionExpression).toContain("attribute_not_exists(workflowId)");
  });

  it("returns false when the row already exists", async () => {
    failNextCondition = true;
    expect(await createWorkflow({ id: "wf_1" })).toBe(false);
  });
});

describe("claimInvocation", () => {
  const entry = { id: "t1", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: "2026-08-30T00:00:00Z" };

  it("claims via conditional write on the task's running status", async () => {
    const won = await claimInvocation("wf_1", "TEAM-2", entry, "2026-08-29T23:00:00Z");
    expect(won).toBe(true);
    const claim = writes().find((c) => c.input.ConditionExpression?.includes(":running"));
    expect(claim.input.UpdateExpression).toBe("SET agentTasks.#tid = :task");
    expect(claim.input.ConditionExpression).toContain("agentTasks.#tid.startedAt < :staleBefore");
  });

  it("strips a stale deadSessionDetectedAt so a FRESH generation never inherits it (TEAM-3698 F1)", async () => {
    // A caller that spreads the prior task (index.mjs claimTicketInvocation)
    // could carry the previous generation's stamp onto the new startedAt — the
    // detector then skips the live+stamped task forever. The sole writer drops it.
    const inherited = { ...entry, startedAt: "2026-08-31T00:00:00Z", deadSessionDetectedAt: "2026-08-30T12:00:00Z" };
    await claimInvocation("wf_1", "TEAM-2", inherited, "2026-08-30T23:00:00Z");
    const claim = writes().find((c) => c.input.ConditionExpression?.includes(":running"));
    expect(claim.input.ExpressionAttributeValues[":task"]).not.toHaveProperty("deadSessionDetectedAt");
    // The rest of the fresh entry is untouched.
    expect(claim.input.ExpressionAttributeValues[":task"].startedAt).toBe("2026-08-31T00:00:00Z");
    expect(claim.input.ExpressionAttributeValues[":task"].status).toBe("running");
  });

  it("loses to a live concurrent claim", async () => {
    failNextCondition = true;
    // first send is the ensure-map write (no condition) — make the claim fail
    const origSend = stubDdb.send;
    let calls = 0;
    stubDdb.send = async (cmd) => {
      calls++;
      if (calls === 2 && cmd.input.ConditionExpression) {
        const err = new Error("held");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return origSend.call(stubDdb, cmd);
    };
    try {
      expect(await claimInvocation("wf_1", "TEAM-2", entry, "x")).toBe(false);
    } finally {
      stubDdb.send = origSend;
    }
  });
});

describe("trackTicket", () => {
  it("is first-writer-wins", async () => {
    await trackTicket("wf_1", "TEAM-3", { agentId: "qa" });
    const w = writes().find((c) => c.input.ConditionExpression);
    expect(w.input.ConditionExpression).toBe("attribute_not_exists(agentTasks.#tid)");
  });
});

describe("mergeTaskMetadata", () => {
  it("writes per-field paths, never the whole map", async () => {
    await mergeTaskMetadata("wf_1", "TEAM-2", { branch: "b", prUrl: "u", skip: undefined });
    const w = writes()[0];
    expect(w.input.UpdateExpression).toMatch(/agentTasks\.#tid\.#f1 = :v1/);
    expect(w.input.UpdateExpression).not.toMatch(/SET agentTasks = /);
    expect(w.input.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
  });

  it("drops metadata for an untracked entry instead of materializing one", async () => {
    failNextCondition = true;
    await mergeTaskMetadata("wf_1", "TEAM-99", { branch: "b" });
    // no throw = dropped
  });
});

describe("setTaskStatus", () => {
  it("writes only the status of an existing entry", async () => {
    await setTaskStatus("wf_1", "TEAM-2", "error");
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("SET agentTasks.#tid.#st = :s");
    expect(w.input.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
  });
});

describe("markDeadSessionDetected", () => {
  it("stamps under a CAS on the exact claim generation (startedAt) + not-yet-stamped", async () => {
    const won = await markDeadSessionDetected("wf_1", "TEAM-2", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("SET agentTasks.#tid.deadSessionDetectedAt = :now");
    expect(w.input.ConditionExpression).toBe(
      "agentTasks.#tid.startedAt = :expected AND attribute_not_exists(agentTasks.#tid.deadSessionDetectedAt)"
    );
    expect(w.input.ExpressionAttributeValues[":expected"]).toBe("2026-08-30T00:00:00Z");
  });

  it("returns false when the claim moved or was already stamped", async () => {
    failNextCondition = true;
    expect(await markDeadSessionDetected("wf_1", "TEAM-2", "x")).toBe(false);
  });

  it("falls back to attribute_not_exists(startedAt) when the claim has no startedAt (TEAM-3683 F3)", async () => {
    // A legacy running task without startedAt must not produce an expression
    // referencing :expected after removeUndefinedValues strips it — the stub
    // throws ValidationException on exactly that mismatch.
    const won = await markDeadSessionDetected("wf_1", "TEAM-2", undefined);
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.ConditionExpression).toBe(
      "attribute_not_exists(agentTasks.#tid.startedAt) AND attribute_not_exists(agentTasks.#tid.deadSessionDetectedAt)"
    );
    expect(w.input.ConditionExpression).not.toContain(":expected");
    expect(w.input.ExpressionAttributeValues).not.toHaveProperty(":expected");
  });
});

describe("clearDeadSessionDetected (TEAM-3698 F1)", () => {
  it("REMOVEs the stamp under a CAS on the exact claim generation + attribute_exists", async () => {
    const won = await clearDeadSessionDetected("wf_1", "TEAM-2", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("REMOVE agentTasks.#tid.deadSessionDetectedAt");
    expect(w.input.ConditionExpression).toBe(
      "agentTasks.#tid.startedAt = :expected AND attribute_exists(agentTasks.#tid.deadSessionDetectedAt)"
    );
    expect(w.input.ExpressionAttributeValues[":expected"]).toBe("2026-08-30T00:00:00Z");
  });

  it("returns false when the generation moved between stamp and clear", async () => {
    failNextCondition = true;
    expect(await clearDeadSessionDetected("wf_1", "TEAM-2", "x")).toBe(false);
  });

  it("falls back to attribute_not_exists(startedAt) and omits ExpressionAttributeValues when no startedAt", async () => {
    // No placeholder in the expression → the values map must be ABSENT (an empty
    // map is a ValidationException); the stub also rejects any dangling placeholder.
    const won = await clearDeadSessionDetected("wf_1", "TEAM-2", undefined);
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.ConditionExpression).toBe(
      "attribute_not_exists(agentTasks.#tid.startedAt) AND attribute_exists(agentTasks.#tid.deadSessionDetectedAt)"
    );
    expect(w.input.ConditionExpression).not.toContain(":expected");
    expect(w.input.ExpressionAttributeValues).toBeUndefined();
  });
});

describe("incrementDeadSessionRetry", () => {
  it("seeds the map then bumps the per-ticket leaf with if_not_exists (never touches qaRetryCount)", async () => {
    await incrementDeadSessionRetry("wf_1", "TEAM-2");
    expect(writes()[0].input.UpdateExpression).toContain("if_not_exists(deadSessionRetries, :empty)");
    const bump = writes()[1];
    expect(bump.input.UpdateExpression).toBe(
      "SET deadSessionRetries.#tid = if_not_exists(deadSessionRetries.#tid, :zero) + :one"
    );
    expect(bump.input.ExpressionAttributeNames["#tid"]).toBe("TEAM-2");
    expect(bump.input.ReturnValues).toBe("UPDATED_NEW");
  });
});

describe("markAwaitTimeoutEmitted (TEAM-4166 D1)", () => {
  it("stamps the task's awaitTimeoutEmittedAt under attribute_not_exists (once-only)", async () => {
    const won = await markAwaitTimeoutEmitted("wf_1", "TEAM-2", "2026-09-06T08:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("SET agentTasks.#tid.awaitTimeoutEmittedAt = :at");
    expect(w.input.ConditionExpression).toBe("attribute_not_exists(agentTasks.#tid.awaitTimeoutEmittedAt)");
    expect(w.input.ExpressionAttributeNames["#tid"]).toBe("TEAM-2");
    expect(w.input.ExpressionAttributeValues[":at"]).toBe("2026-09-06T08:00:00Z");
    // NOT anchored to a claim generation — no startedAt in the guard.
    expect(w.input.ConditionExpression).not.toContain("startedAt");
  });

  it("returns false when another writer already emitted (CCFE), never throws", async () => {
    failNextCondition = true;
    await expect(markAwaitTimeoutEmitted("wf_1", "TEAM-2", "x")).resolves.toBe(false);
  });
});

describe("markInitialPhaseAnnounced (TEAM-4167 D3 FR-3.3)", () => {
  it("claims the emit under a top-level attribute_not_exists CAS (once-only)", async () => {
    const won = await markInitialPhaseAnnounced("wf_1", "requirements");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("SET announcedInitialPhase = :p");
    expect(w.input.ConditionExpression).toBe("attribute_not_exists(announcedInitialPhase)");
    expect(w.input.ExpressionAttributeValues[":p"]).toBe("requirements");
    // Row-level claim, not anchored to any per-task generation.
    expect(w.input.ConditionExpression).not.toContain("startedAt");
    expect(w.input.ConditionExpression).not.toContain("agentTasks");
  });

  it("returns false when the initial phase was already announced (CCFE), never throws", async () => {
    failNextCondition = true;
    await expect(markInitialPhaseAnnounced("wf_1", "requirements")).resolves.toBe(false);
  });
});

describe("incrementCleanExitRedispatch (TEAM-4166 D2)", () => {
  it("seeds the top-level map then bumps the per-ticket leaf with if_not_exists (never touches deadSessionRetries)", async () => {
    await incrementCleanExitRedispatch("wf_1", "TEAM-2");
    expect(writes()[0].input.UpdateExpression).toContain("if_not_exists(cleanExitRedispatches, :empty)");
    expect(writes()[0].input.ConditionExpression).toBeUndefined();
    const bump = writes()[1];
    expect(bump.input.UpdateExpression).toBe(
      "SET cleanExitRedispatches.#tid = if_not_exists(cleanExitRedispatches.#tid, :zero) + :one"
    );
    expect(bump.input.ExpressionAttributeNames["#tid"]).toBe("TEAM-2");
    expect(bump.input.ReturnValues).toBe("UPDATED_NEW");
    expect(bump.input.UpdateExpression).not.toContain("deadSessionRetries");
  });

  it("returns the new count read back from UPDATED_NEW", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.input.ReturnValues === "UPDATED_NEW") {
        return { Attributes: { cleanExitRedispatches: { "TEAM-2": 1 } } };
      }
      return {};
    };
    try {
      expect(await incrementCleanExitRedispatch("wf_1", "TEAM-2")).toBe(1);
    } finally {
      stubDdb.send = origSend;
    }
  });
});

describe("claimDeadSessionSynthesis (TEAM-4120 FR-3)", () => {
  it("seeds the map, then claims the per-ticket leaf with attribute_not_exists", async () => {
    const ok = await claimDeadSessionSynthesis("wf_1", "TEAM-2");
    expect(ok).toBe(true);
    // Step 1 has NO condition (idempotent seed — DynamoDB rejects SET a.b when a
    // is missing), step 2 carries the CAS.
    expect(writes()[0].input.UpdateExpression).toContain("if_not_exists(deadSessionSynthesized, :empty)");
    expect(writes()[0].input.ConditionExpression).toBeUndefined();
    const claim = writes()[1];
    expect(claim.input.UpdateExpression).toBe("SET deadSessionSynthesized.#tid = :one");
    expect(claim.input.ConditionExpression).toBe("attribute_not_exists(deadSessionSynthesized.#tid)");
    expect(claim.input.ExpressionAttributeNames["#tid"]).toBe("TEAM-2");
  });

  it("returns false when the synthesis was already spent (CCFE), never throws", async () => {
    failNextCondition = true;
    await expect(claimDeadSessionSynthesis("wf_1", "TEAM-2")).resolves.toBe(false);
  });
});

describe("advancePhase", () => {
  it("pins the feature branch with if_not_exists", async () => {
    await advancePhase("wf_1", "development", "feature/x");
    expect(writes()[0].input.UpdateExpression).toContain("featureBranch = if_not_exists(featureBranch, :fb)");
  });

  it("writes only the phase when no branch", async () => {
    await advancePhase("wf_1", "design");
    expect(writes()[0].input.UpdateExpression).toBe("SET phase = :p");
  });
});

describe("setResumeContext", () => {
  it("ensures the map then sets one key", async () => {
    await setResumeContext("wf_1", "TEAM-2", "note");
    expect(writes()[0].input.UpdateExpression).toContain("if_not_exists(resumeContexts");
    expect(writes()[1].input.UpdateExpression).toBe("SET resumeContexts.#k = :note");
  });
});

describe("appendNotification", () => {
  it("uses list_append, never a full-array rewrite", async () => {
    await appendNotification("wf_1", { id: "n1" });
    expect(writes()[0].input.UpdateExpression).toContain("list_append(if_not_exists(humanNotifications");
  });

  it("bumps notifVersion so a concurrent ack CAS fails and re-reads", async () => {
    await appendNotification("wf_1", { id: "n1" });
    expect(writes()[0].input.UpdateExpression).toContain("notifVersion = if_not_exists(notifVersion, :zero) + :one");
  });
});

describe("appendReviewNotificationOnce (TEAM-3684 Finding 2)", () => {
  it("appends under a notifVersion CAS when no open review_needed exists", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", notifVersion: 2, humanNotifications: [] } };
      }
      return {};
    };
    let appended;
    try {
      appended = await appendReviewNotificationOnce("wf_1", "GATE-1", {
        id: "n1", ticketId: "GATE-1", type: "review_needed", acknowledged: false,
      });
    } finally {
      stubDdb.send = origSend;
    }
    expect(appended).toBe(true);
    const w = sent.find((c) => c.type === "UpdateCommand");
    expect(w.input.UpdateExpression).toBe("SET humanNotifications = :n, notifVersion = :next");
    expect(w.input.ConditionExpression).toContain("notifVersion = :cur");
    expect(w.input.ExpressionAttributeValues[":cur"]).toBe(2);
    expect(w.input.ExpressionAttributeValues[":next"]).toBe(3);
    expect(w.input.ExpressionAttributeValues[":n"]).toHaveLength(1);
    expect(w.input.ExpressionAttributeValues[":n"][0].id).toBe("n1");
  });

  it("is a no-op when an unacknowledged review_needed already exists (no write)", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", notifVersion: 4, humanNotifications: [
          { id: "open", ticketId: "GATE-1", type: "review_needed", acknowledged: false },
        ] } };
      }
      return {};
    };
    let appended;
    try {
      appended = await appendReviewNotificationOnce("wf_1", "GATE-1", {
        id: "dup", ticketId: "GATE-1", type: "review_needed", acknowledged: false,
      });
    } finally {
      stubDdb.send = origSend;
    }
    expect(appended).toBe(false);
    expect(sent.filter((c) => c.type === "UpdateCommand")).toHaveLength(0);
  });

  it("re-notifies once a prior review_needed was acknowledged (reopened gate)", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", notifVersion: 7, humanNotifications: [
          { id: "old", ticketId: "GATE-1", type: "review_needed", acknowledged: true },
        ] } };
      }
      return {};
    };
    let appended;
    try {
      appended = await appendReviewNotificationOnce("wf_1", "GATE-1", {
        id: "fresh", ticketId: "GATE-1", type: "review_needed", acknowledged: false,
      });
    } finally {
      stubDdb.send = origSend;
    }
    expect(appended).toBe(true);
    const w = sent.find((c) => c.type === "UpdateCommand");
    // Old (acked) + fresh are both retained; the append never rewrites history away.
    expect(w.input.ExpressionAttributeValues[":n"]).toHaveLength(2);
  });

  it("stands down on CAS loss when the re-read now shows a concurrent open notification", async () => {
    let gets = 0;
    let updates = 0;
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      if (cmd.constructor.name === "GetCommand") {
        gets++;
        // First read: clear. Second read (after our CAS loss): a concurrent
        // completion already appended an open review_needed → we must stand down.
        return gets === 1
          ? { Item: { workflowId: "wf_1", notifVersion: 5, humanNotifications: [] } }
          : { Item: { workflowId: "wf_1", notifVersion: 6, humanNotifications: [
              { id: "concurrent", ticketId: "GATE-1", type: "review_needed", acknowledged: false },
            ] } };
      }
      updates++;
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      const err = new Error("cas"); err.name = "ConditionalCheckFailedException"; throw err;
    };
    let appended;
    try {
      appended = await appendReviewNotificationOnce("wf_1", "GATE-1", {
        id: "mine", ticketId: "GATE-1", type: "review_needed", acknowledged: false,
      });
    } finally {
      stubDdb.send = origSend;
    }
    expect(appended).toBe(false);
    expect(updates).toBe(1); // exactly one write attempt — no duplicate append
    expect(gets).toBe(2);    // re-read after the CAS loss, then stood down
  });

  it("persists an optional humanAssignee ADDITIVELY on the notification (TEAM-4166 D2 §2.4)", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", notifVersion: 1, humanNotifications: [] } };
      }
      return {};
    };
    try {
      const appended = await appendReviewNotificationOnce(
        "wf_1", "GATE-1",
        { id: "n1", ticketId: "GATE-1", type: "review_needed", acknowledged: false },
        3, "human:alice"
      );
      expect(appended).toBe(true);
    } finally {
      stubDdb.send = origSend;
    }
    const w = sent.find((c) => c.type === "UpdateCommand");
    expect(w.input.ExpressionAttributeValues[":n"][0].humanAssignee).toBe("human:alice");
    // additive: the original fields survive untouched
    expect(w.input.ExpressionAttributeValues[":n"][0].id).toBe("n1");
  });

  it("omits humanAssignee entirely when none is passed (byte-identical to existing callers)", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", notifVersion: 1, humanNotifications: [] } };
      }
      return {};
    };
    try {
      await appendReviewNotificationOnce("wf_1", "GATE-1", {
        id: "n1", ticketId: "GATE-1", type: "review_needed", acknowledged: false,
      });
    } finally {
      stubDdb.send = origSend;
    }
    const w = sent.find((c) => c.type === "UpdateCommand");
    expect(w.input.ExpressionAttributeValues[":n"][0]).not.toHaveProperty("humanAssignee");
  });
});

describe("completeTaskEntry", () => {
  it("touches only status + completedAt when the entry exists", async () => {
    await completeTaskEntry("wf_1", "TEAM-2", { status: "complete", completedAt: "2026-01-01T00:00:00Z" });
    const w = writes()[0];
    expect(w.input.UpdateExpression).toBe("SET agentTasks.#tid.#st = :s, agentTasks.#tid.completedAt = :ts");
    expect(w.input.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
  });

  it("seeds the whole entry only when untracked (condition fails)", async () => {
    failNextCondition = true;
    const seed = { id: "t1", agentId: "dev", ticketId: "TEAM-2", status: "complete", completedAt: "2026-01-01T00:00:00Z" };
    await completeTaskEntry("wf_1", "TEAM-2", seed);
    const last = writes()[writes().length - 1];
    expect(last.input.UpdateExpression).toBe("SET agentTasks.#tid = :task");
    expect(last.input.ExpressionAttributeValues[":task"]).toEqual(seed);
  });
});

describe("ackNotifications", () => {
  it("acks matching entries under a version CAS", async () => {
    const wf = {
      workflowId: "wf_1",
      notifVersion: 3,
      humanNotifications: [
        { id: "a", ticketId: "TEAM-2", type: "review_needed", acknowledged: false },
        { id: "b", ticketId: "TEAM-9", type: "review_needed", acknowledged: false },
      ],
    };
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") return { Item: wf };
      return {};
    };
    try {
      await ackNotifications("wf_1", (n) => n.ticketId === "TEAM-2");
    } finally {
      stubDdb.send = origSend;
    }
    const w = sent.find((c) => c.type === "UpdateCommand");
    expect(w.input.ConditionExpression).toContain("notifVersion = :cur");
    expect(w.input.ExpressionAttributeValues[":cur"]).toBe(3);
    expect(w.input.ExpressionAttributeValues[":next"]).toBe(4);
    const list = w.input.ExpressionAttributeValues[":n"];
    expect(list[0].acknowledged).toBe(true);
    expect(list[1].acknowledged).toBe(false);
  });

  it("no-ops when nothing matches", async () => {
    const origSend = stubDdb.send;
    stubDdb.send = async (cmd) => {
      sent.push({ type: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { workflowId: "wf_1", humanNotifications: [{ id: "a", ticketId: "X", acknowledged: false }] } };
      }
      return {};
    };
    try {
      await ackNotifications("wf_1", () => false);
    } finally {
      stubDdb.send = origSend;
    }
    expect(sent.filter((c) => c.type === "UpdateCommand")).toHaveLength(0);
  });
});

describe("completeWorkflow", () => {
  it("completes exactly once, CASing off EVERY terminal phase (TEAM-3755 F2)", async () => {
    // F2: this guard used to list only complete/cancelled/error by hand, so a
    // completion racing in behind an honest deploy-blocked / static-ci-only close
    // satisfied the condition and overwrote the blocked verdict with "complete" —
    // destroying the FR-D2.2 evidence that nothing shipped. Both terminal claims
    // now derive the same five-phase guard from one list.
    const won = await completeWorkflow("wf_1", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(refusedPhases(w.input)).toEqual(ALL_TERMINAL_PHASES);
  });

  it("refuses to complete a cancelled run (TEAM-3619 D4a — cancelledAt guard)", async () => {
    const won = await completeWorkflow("wf_1", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.ConditionExpression).toContain("attribute_not_exists(cancelledAt)");
  });

  it("returns false for the losing concurrent completion", async () => {
    failNextCondition = true;
    expect(await completeWorkflow("wf_1", "x")).toBe(false);
  });
});

/**
 * TEAM-3747 D2 — the HONEST terminal close ("no green close over unshipped work").
 * Same conditional-write discipline as completeWorkflow: exactly one winner, a lost
 * CAS is a graceful no-op (so a duplicate closeWorkflowBlocked writes nothing and
 * emits nothing), and cancellation still precedes everything.
 */
describe("claimTerminalOutcome (TEAM-3747 D2)", () => {
  it("claims the blocked phase, CASing off EVERY terminal phase (including the D2 pair)", async () => {
    const won = await claimTerminalOutcome("wf_1", "deploy-blocked", "2026-09-01T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.UpdateExpression).toContain("SET phase = :outcome");
    expect(w.input.ExpressionAttributeValues[":outcome"]).toBe("deploy-blocked");
    expect(w.input.ExpressionAttributeValues[":ts"]).toBe("2026-09-01T00:00:00Z");
    expect(refusedPhases(w.input)).toEqual(ALL_TERMINAL_PHASES);
    expect(w.input.ConditionExpression).toContain("attribute_not_exists(cancelledAt)");
  });

  it("with no reason it writes no blockReason (and leaves no dangling placeholder)", async () => {
    // The stub client throws ValidationException on an unbound placeholder, so a
    // passing call is itself the assertion that :reason is absent, not undefined.
    await claimTerminalOutcome("wf_1", "static-ci-only", "2026-09-01T00:00:00Z");
    const w = writes()[0];
    expect(w.input.UpdateExpression).not.toContain("blockReason");
    expect(w.input.ExpressionAttributeValues[":reason"]).toBeUndefined();
    expect(w.input.ExpressionAttributeValues[":outcome"]).toBe("static-ci-only");
  });

  it("records the block reason when supplied, clamped to 500 chars", async () => {
    await claimTerminalOutcome("wf_1", "deploy-blocked", "2026-09-01T00:00:00Z", "x".repeat(700));
    const w = writes()[0];
    expect(w.input.UpdateExpression).toContain("blockReason = :reason");
    expect(w.input.ExpressionAttributeValues[":reason"]).toHaveLength(500);
  });

  it("idempotent: the losing racer gets false and never throws (duplicate close = no-op)", async () => {
    failNextCondition = true;
    expect(await claimTerminalOutcome("wf_1", "deploy-blocked", "ts")).toBe(false);
  });
});

describe("claimFinalization", () => {
  it("takes over a stale completion under a finalizedAt CAS that also excludes cancelled runs", async () => {
    const won = await claimFinalization("wf_1", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.ConditionExpression).toContain("phase = :complete");
    expect(w.input.ConditionExpression).toContain("attribute_not_exists(finalizedAt)");
    expect(w.input.ConditionExpression).toContain("attribute_not_exists(cancelledAt)");
    expect(w.input.ConditionExpression).toContain("completedAt < :staleBefore");
  });

  it("returns false when another retry already claimed finalization", async () => {
    failNextCondition = true;
    expect(await claimFinalization("wf_1", "x")).toBe(false);
  });
});

describe("review gate ledger (TEAM-3619 D2c)", () => {
  const round = { round: 1, verdict: "CHANGES-NEEDED", findings: [] };

  it("seeds the map and the per-gate entry with if_not_exists, then list_appends the round", async () => {
    await appendReviewRound("wf_1", "TEAM-900", round);
    const w = writes();
    expect(w[0].input.UpdateExpression).toContain("if_not_exists(reviewGateHistory, :empty)");
    expect(w[1].input.UpdateExpression).toBe(
      "SET reviewGateHistory.#g = if_not_exists(reviewGateHistory.#g, :seed)"
    );
    expect(w[1].input.ExpressionAttributeValues[":seed"]).toEqual({
      rounds: [], authorizations: [], escalations: [],
    });
    expect(w[1].input.ExpressionAttributeNames["#g"]).toBe("TEAM-900");
    // A lost round is a cap that trips late — append, never rewrite the array.
    expect(w[2].input.UpdateExpression).toBe(
      "SET reviewGateHistory.#g.rounds = list_append(if_not_exists(reviewGateHistory.#g.rounds, :empty), :r)"
    );
    expect(w[2].input.ExpressionAttributeValues[":r"]).toEqual([round]);
  });

  it("returns the POST-write ledger so the caller counts a concurrent cycle's round too", async () => {
    const ledger = { rounds: [round], authorizations: [], escalations: [] };
    initWorkflowStore(
      {
        async send(cmd) {
          sent.push({ type: cmd.constructor.name, input: cmd.input });
          return cmd.input.ReturnValues === "ALL_NEW"
            ? { Attributes: { workflowId: "wf_1", reviewGateHistory: { "TEAM-900": ledger } } }
            : {};
        },
      },
      "workflows-test"
    );
    expect(await appendReviewRound("wf_1", "TEAM-900", round)).toEqual(ledger);
    expect(writes()[2].input.ReturnValues).toBe("ALL_NEW");
  });

  it("returns null when the row is gone rather than inventing an empty ledger", async () => {
    // The stub returns {} (no Attributes) — a caller must not read that as
    // "zero rounds so far", which would silently reset the cap.
    expect(await appendReviewRound("wf_1", "TEAM-900", round)).toBeNull();
  });

  it("append-onlys escalations and authorizations under the same gate key", async () => {
    await appendReviewCapEscalation("wf_1", "TEAM-900", { escalatedAtRound: 3, decision: null });
    expect(writes()[2].input.UpdateExpression).toBe(
      "SET reviewGateHistory.#g.escalations = list_append(if_not_exists(reviewGateHistory.#g.escalations, :empty), :e)"
    );
    sent.length = 0;
    await appendReviewAuthorization("wf_1", "TEAM-900", { decision: "continue", resetAtRound: 3 });
    expect(writes()[2].input.UpdateExpression).toBe(
      "SET reviewGateHistory.#g.authorizations = list_append(if_not_exists(reviewGateHistory.#g.authorizations, :empty), :a)"
    );
  });
});

describe("setRepoCheck (repo URL pre-flight)", () => {
  it("is a scoped SET of the single repoCheck attribute — no full-row put", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    const rc = { checkedAt: "2026-09-04T00:00:00Z", results: [{ url: "https://github.com/tycenj/agentcore-hub", ok: false, definitive: true, status: 404, reason: "GitHub 404" }] };
    await setRepoCheck("wf_1", rc);
    expect(sent.length).toBe(1);
    expect(sent[0].input.UpdateExpression).toBe("SET repoCheck = :rc");
    expect(sent[0].input.ExpressionAttributeValues[":rc"]).toEqual(rc);
    expect(sent[0].input.Key).toEqual({ workflowId: "wf_1" });
  });
});


describe("setCiCheck (CI reachability pre-flight, TEAM-4122)", () => {
  it("is a scoped SET of the single ciCheck attribute — no full-row put", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    const cc = {
      checkedAt: "2026-09-06T00:00:00Z",
      projectName: "agentcore-hub-ci",
      webhook: false,
      startBuild: false,
      githubHook: "unknown",
      certifiable: false,
      verdict: "uncertifiable",
      reason: "no PR webhook and no StartBuild",
      mode: "enforce",
    };
    await setCiCheck("wf_1", cc);
    expect(sent.length).toBe(1);
    expect(sent[0].input.UpdateExpression).toBe("SET ciCheck = :cc");
    expect(sent[0].input.ExpressionAttributeValues[":cc"]).toEqual(cc);
    expect(sent[0].input.Key).toEqual({ workflowId: "wf_1" });
  });
});

describe("setSyncMain (pre-CI default-branch sync, TEAM-4122)", () => {
  it("is a scoped SET of the single syncMain attribute — no full-row put", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    const sm = {
      at: "2026-09-06T00:00:00Z",
      sha: "abc1234",
      baseHeadSha: "def5678",
      status: "synced",
      ciTicketId: "TEAM-9",
    };
    await setSyncMain("wf_1", sm);
    expect(sent.length).toBe(1);
    expect(sent[0].input.UpdateExpression).toBe("SET syncMain = :sm");
    expect(sent[0].input.ExpressionAttributeValues[":sm"]).toEqual(sm);
    expect(sent[0].input.Key).toEqual({ workflowId: "wf_1" });
  });
});


describe("setShipHeadDeferrals (ship-head stability, TEAM-4111)", () => {
  it("count > 0 → scoped SET of the two attrs, no full-row put", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    await setShipHeadDeferrals("wf_1", 2, "TEAM-SHIP");
    expect(sent.length).toBe(1);
    expect(sent[0].input.UpdateExpression).toBe("SET shipHeadDeferrals = :n, shipHeadTicketId = :t");
    expect(sent[0].input.ExpressionAttributeValues).toEqual({ ":n": 2, ":t": "TEAM-SHIP" });
    expect(sent[0].input.Key).toEqual({ workflowId: "wf_1" });
  });

  it("count <= 0 → REMOVEs both attrs (dispatched run carries no ship-head state)", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    await setShipHeadDeferrals("wf_1", 0);
    expect(sent.length).toBe(1);
    expect(sent[0].input.UpdateExpression).toBe("REMOVE shipHeadDeferrals, shipHeadTicketId");
    expect(sent[0].input.ExpressionAttributeValues).toBeUndefined();
  });
});


describe("rework lineage ledger (TEAM-4113)", () => {
  const round = { ticketId: "TEAM-90", at: "2026-09-05T00:00:00Z" };

  it("seeds reworkLineage + the per-lineage entry with if_not_exists, then list_appends the round", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    await appendReworkRound("wf_1", "wf_1:development", round);
    const w = writes();
    expect(w[0].input.UpdateExpression).toContain("if_not_exists(reworkLineage, :empty)");
    expect(w[1].input.UpdateExpression).toBe(
      "SET reworkLineage.#k = if_not_exists(reworkLineage.#k, :seed)"
    );
    expect(w[1].input.ExpressionAttributeValues[":seed"]).toEqual({
      rounds: [], authorizations: [], escalations: [],
    });
    expect(w[1].input.ExpressionAttributeNames["#k"]).toBe("wf_1:development");
    // A lost round is a cap that trips late — append, never rewrite the array.
    expect(w[2].input.UpdateExpression).toBe(
      "SET reworkLineage.#k.rounds = list_append(if_not_exists(reworkLineage.#k.rounds, :empty), :r)"
    );
    expect(w[2].input.ExpressionAttributeValues[":r"]).toEqual([round]);
    expect(w[2].input.ReturnValues).toBe("ALL_NEW");
  });

  it("returns the POST-write lineage ledger so a concurrent round is counted", async () => {
    const ledger = { rounds: [round], authorizations: [], escalations: [] };
    initWorkflowStore(
      {
        async send(cmd) {
          sent.push({ type: cmd.constructor.name, input: cmd.input });
          return cmd.input.ReturnValues === "ALL_NEW"
            ? { Attributes: { workflowId: "wf_1", reworkLineage: { "wf_1:development": ledger } } }
            : {};
        },
      },
      "wf"
    );
    expect(await appendReworkRound("wf_1", "wf_1:development", round)).toEqual(ledger);
  });

  it("returns null when the row is gone rather than inventing an empty ledger", async () => {
    initWorkflowStore(stubDdb, "wf");
    expect(await appendReworkRound("wf_1", "wf_1:development", round)).toBeNull();
  });

  it("append-onlys escalations and authorizations under the same lineage key", async () => {
    initWorkflowStore(stubDdb, "wf");
    sent.length = 0;
    await appendReworkEscalation("wf_1", "wf_1:development", { escalatedAtRound: 4, decision: null });
    expect(writes()[2].input.UpdateExpression).toBe(
      "SET reworkLineage.#k.escalations = list_append(if_not_exists(reworkLineage.#k.escalations, :empty), :e)"
    );
    sent.length = 0;
    await appendReworkAuthorization("wf_1", "wf_1:development", { decision: "continue", resetAtRound: 4 });
    expect(writes()[2].input.UpdateExpression).toBe(
      "SET reworkLineage.#k.authorizations = list_append(if_not_exists(reworkLineage.#k.authorizations, :empty), :a)"
    );
  });
});


/**
 * Review-gate state machine (TEAM-4120 FR-1). Same two-seed-then-CAS shape as the
 * ledgers above, but the CAS is the POINT here, not an optimization: it is what
 * makes "one human decision = one recorded transition" true when the Jira-webhook
 * and DDB-stream twins both fire for the same `→ blocked`.
 */
describe("gate state machine (TEAM-4120 FR-1)", () => {
  const AT = "2026-09-05T12:00:00.000Z";
  const REQ_AT = "2026-09-05T10:00:00.000Z";

  /** A client that returns `Attributes` for the ALL_NEW CAS write. */
  const returning = (gateStates) =>
    initWorkflowStore(
      {
        async send(cmd) {
          sent.push({ type: cmd.constructor.name, input: cmd.input });
          return cmd.input.ReturnValues === "ALL_NEW" ? { Attributes: { workflowId: "wf_1", gateStates } } : {};
        },
      },
      "workflows-test"
    );

  /** A client whose CAS write fails with something OTHER than a lost condition. */
  const throwing = () =>
    initWorkflowStore(
      {
        async send(cmd) {
          sent.push({ type: cmd.constructor.name, input: cmd.input });
          if (cmd.input.ConditionExpression) throw new Error("ProvisionedThroughputExceededException");
          return {};
        },
      },
      "workflows-test"
    );

  describe("markGateRequested", () => {
    it("seeds gateStates + the per-gate entry, then CASes state <> requested", async () => {
      expect(await markGateRequested("wf_1", "TEAM-900", AT)).toBe(true);
      const w = writes();
      expect(w).toHaveLength(3);
      expect(w[0].input.UpdateExpression).toBe("SET gateStates = if_not_exists(gateStates, :empty)");
      expect(w[1].input.UpdateExpression).toBe("SET gateStates.#g = if_not_exists(gateStates.#g, :seed)");
      // "none", NOT "requested": a seeded-but-never-presented gate must classify
      // as "no usable state", never as a pending review.
      expect(w[1].input.ExpressionAttributeValues[":seed"]).toEqual({ state: "none", cycles: [] });
      expect(w[1].input.ExpressionAttributeNames["#g"]).toBe("TEAM-900");
      expect(w[2].input.UpdateExpression).toBe(
        "SET gateStates.#g.#st = :req, gateStates.#g.requestedAt = :at"
      );
      expect(w[2].input.ConditionExpression).toBe("gateStates.#g.#st <> :req");
      expect(w[2].input.ExpressionAttributeNames).toEqual({ "#g": "TEAM-900", "#st": "state" });
      expect(w[2].input.ExpressionAttributeValues).toEqual({ ":req": "requested", ":at": AT });
      expect(w[2].input.Key).toEqual({ workflowId: "wf_1" });
    });

    it("returns false when the gate is already requested (re-park is a no-op)", async () => {
      // The seeds carry no ConditionExpression, so the injected failure lands on
      // the CAS — an already-pending gate must NOT get a fresh requestedAt, which
      // would restart the human's clock on every cascade re-wake.
      failNextCondition = true;
      expect(await markGateRequested("wf_1", "TEAM-900", AT)).toBe(false);
    });

    it("rethrows anything that is not a lost condition", async () => {
      throwing();
      await expect(markGateRequested("wf_1", "TEAM-900", AT)).rejects.toThrow(
        "ProvisionedThroughputExceededException"
      );
    });
  });

  describe("markGateRejected", () => {
    it("CASes requested → rejected and list_appends the closed cycle", async () => {
      await markGateRejected("wf_1", "TEAM-900", AT, { requestedAt: REQ_AT });
      const w = writes();
      expect(w).toHaveLength(3);
      expect(w[2].input.UpdateExpression).toBe(
        "SET gateStates.#g.#st = :rej, gateStates.#g.resolvedAt = :at, " +
          "gateStates.#g.cycles = list_append(if_not_exists(gateStates.#g.cycles, :empty), :cycle)"
      );
      // Only a PENDING review can become a rejection — that is the whole guard.
      expect(w[2].input.ConditionExpression).toBe("gateStates.#g.#st = :req");
      expect(w[2].input.ExpressionAttributeValues[":cycle"]).toEqual([
        { requestedAt: REQ_AT, resolvedAt: AT, outcome: "rejected" },
      ]);
      expect(w[2].input.ReturnValues).toBe("ALL_NEW");
    });

    it("returns the POST-write gate row so the caller sees the state it just wrote", async () => {
      const row = { state: "rejected", requestedAt: REQ_AT, resolvedAt: AT, cycles: [{ outcome: "rejected" }] };
      returning({ "TEAM-900": row });
      expect(await markGateRejected("wf_1", "TEAM-900", AT, { requestedAt: REQ_AT })).toEqual(row);
    });

    it("returns null when the CAS is lost — the other twin already recorded it", async () => {
      failNextCondition = true;
      expect(await markGateRejected("wf_1", "TEAM-900", AT, { requestedAt: REQ_AT })).toBeNull();
    });

    it("returns null when the row is gone rather than inventing a state", async () => {
      expect(await markGateRejected("wf_1", "TEAM-900", AT, {})).toBeNull();
    });

    it("records requestedAt as null (never undefined) so the cycle keeps the key", async () => {
      // The DocumentClient strips undefined values; a dropped requestedAt would
      // silently lose the cycle's duration.
      await markGateRejected("wf_1", "TEAM-900", AT);
      expect(writes()[2].input.ExpressionAttributeValues[":cycle"]).toEqual([
        { requestedAt: null, resolvedAt: AT, outcome: "rejected" },
      ]);
    });

    it("rethrows anything that is not a lost condition", async () => {
      throwing();
      await expect(markGateRejected("wf_1", "TEAM-900", AT, {})).rejects.toThrow(
        "ProvisionedThroughputExceededException"
      );
    });
  });

  describe("markGateRejectedFromLegacy (TEAM-4129 F2)", () => {
    /**
     * The stub client never evaluates ConditionExpressions, so pin the SEMANTICS
     * the way DynamoDB would read them: the expression must have the shape
     *   (attribute_not_exists(<path>) OR (<path> <> :a AND <path> <> :b …))
     * and "which states does it admit" then follows from the refused values.
     * Placeholder spellings stay an implementation detail (they are generated
     * from GATE_STATES), exactly like refusedPhases above.
     */
    const legacyCas = (input) => {
      const expr = String(input.ConditionExpression);
      const m = expr.match(/^\(attribute_not_exists\((.+?)\) OR \((.+)\)\)$/);
      if (!m) throw new Error(`unexpected legacy CAS shape: ${expr}`);
      const [, path, conjunction] = m;
      const clause = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <> (:[A-Za-z0-9_]+)$`);
      const refused = conjunction.split(" AND ").map((c) => {
        const cm = c.trim().match(clause);
        if (!cm) throw new Error(`unexpected clause: ${c}`);
        return input.ExpressionAttributeValues[cm[1]];
      });
      return {
        path,
        refused,
        /** @param {string|undefined} state the row's recorded gate state */
        admits: (state) => state === undefined || !refused.includes(state),
      };
    };

    it("seeds the row, then CASes on 'no usable recorded state'", async () => {
      expect(await markGateRejectedFromLegacy("wf_1", "TEAM-900", AT)).toBe(true);
      const w = writes();
      // Same two-write seed as every other gate setter: DynamoDB rejects a nested
      // SET when gateStates.#g is missing, so the ABSENT-row case is handled by
      // creating the row, not by a condition disjunct that could not save the SET.
      expect(w).toHaveLength(3);
      expect(w[0].input.UpdateExpression).toBe("SET gateStates = if_not_exists(gateStates, :empty)");
      expect(w[1].input.UpdateExpression).toBe("SET gateStates.#g = if_not_exists(gateStates.#g, :seed)");
      expect(w[1].input.ExpressionAttributeValues[":seed"]).toEqual({ state: "none", cycles: [] });
      // The write itself is markGateRejected's, minus the requestedAt it has no
      // way of knowing.
      expect(w[2].input.UpdateExpression).toBe(
        "SET gateStates.#g.#st = :rej, gateStates.#g.resolvedAt = :at, " +
          "gateStates.#g.cycles = list_append(if_not_exists(gateStates.#g.cycles, :empty), :cycle)"
      );
      expect(w[2].input.ExpressionAttributeNames).toEqual({ "#g": "TEAM-900", "#st": "state" });
      expect(w[2].input.ExpressionAttributeValues[":rej"]).toBe("rejected");
      expect(w[2].input.Key).toEqual({ workflowId: "wf_1" });
      expect(legacyCas(w[2].input).path).toBe("gateStates.#g.#st");
    });

    it("the condition ACCEPTS the 'none' seed and an absent state, and REFUSES every real state", async () => {
      // This is the whole fix: markGateRejected's `state = "requested"` can never
      // hold for a legacy row, so the ledger never converged and the duplicate
      // guard never fired. The refused set is GATE_STATES itself, derived from the
      // one list the guard's own legacyFallback test uses.
      await markGateRejectedFromLegacy("wf_1", "TEAM-900", AT);
      const cas = legacyCas(writes()[2].input);

      expect([...cas.refused].sort()).toEqual([...GATE_STATES].sort());
      expect(cas.admits("none")).toBe(true);
      expect(cas.admits(undefined)).toBe(true);
      expect(cas.admits("requested")).toBe(false);
      expect(cas.admits("rejected")).toBe(false);
      expect(cas.admits("approved")).toBe(false);
      // An unrecognized value is "no usable state" for the guard too, so the two
      // halves agree by construction rather than by coincidence.
      expect(cas.admits("bogus")).toBe(true);
    });

    it("records the cycle as legacy-sourced with a null requestedAt", async () => {
      // A legacy row genuinely has no recorded request time; stamping `at` would
      // fake a zero-length human wait in the cycle history.
      await markGateRejectedFromLegacy("wf_1", "TEAM-900", AT);
      expect(writes()[2].input.ExpressionAttributeValues[":cycle"]).toEqual([
        { requestedAt: null, resolvedAt: AT, outcome: "rejected", source: "legacy" },
      ]);
    });

    it("returns false on a lost CAS — another deliverer converged the row first", async () => {
      failNextCondition = true;
      expect(await markGateRejectedFromLegacy("wf_1", "TEAM-900", AT)).toBe(false);
    });

    it("rethrows anything that is not a lost condition", async () => {
      throwing();
      await expect(markGateRejectedFromLegacy("wf_1", "TEAM-900", AT)).rejects.toThrow(
        "ProvisionedThroughputExceededException"
      );
    });
  });

  describe("markGateApproved", () => {
    it("accepts requested OR rejected as the prior state (TEAM-3974 re-decides)", async () => {
      await markGateApproved("wf_1", "TEAM-900", AT, { requestedAt: REQ_AT });
      const w = writes();
      expect(w[2].input.UpdateExpression).toBe(
        "SET gateStates.#g.#st = :app, gateStates.#g.resolvedAt = :at, " +
          "gateStates.#g.cycles = list_append(if_not_exists(gateStates.#g.cycles, :empty), :cycle)"
      );
      expect(w[2].input.ConditionExpression).toBe("gateStates.#g.#st IN (:req, :rej)");
      expect(w[2].input.ExpressionAttributeValues[":app"]).toBe("approved");
      expect(w[2].input.ExpressionAttributeValues[":cycle"]).toEqual([
        { requestedAt: REQ_AT, resolvedAt: AT, outcome: "approved" },
      ]);
      expect(w[2].input.ReturnValues).toBe("ALL_NEW");
    });

    it("returns null on a lost CAS (already approved → the repeated ack is a no-op)", async () => {
      failNextCondition = true;
      expect(await markGateApproved("wf_1", "TEAM-900", AT, {})).toBeNull();
    });

    it("returns the POST-write gate row", async () => {
      const row = { state: "approved", requestedAt: REQ_AT, resolvedAt: AT, cycles: [{ outcome: "approved" }] };
      returning({ "TEAM-900": row });
      expect(await markGateApproved("wf_1", "TEAM-900", AT, { requestedAt: REQ_AT })).toEqual(row);
    });

    it("rethrows anything that is not a lost condition", async () => {
      throwing();
      await expect(markGateApproved("wf_1", "TEAM-900", AT, {})).rejects.toThrow(
        "ProvisionedThroughputExceededException"
      );
    });
  });
});

describe("re-verify slot CAS (TEAM-4130 F2)", () => {
  const SHA = "abc1234";
  const NOW = "2026-09-06T12:00:00.000Z";
  const FIX = "TEAM-4130-7";
  /** A row whose one task entry holds whatever slot state a test needs. */
  const rowWith = (entry) => ({ workflowId: "wf_1", agentTasks: { [FIX]: entry } });

  it("claims a free slot with a scoped CAS that also clears any stale ticket id", async () => {
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("claimed");
    expect(writes()).toHaveLength(1);
    const { input } = writes()[0];
    expect(input.UpdateExpression).toContain("SET agentTasks.#tid.reverifySha = :sha");
    expect(input.UpdateExpression).toContain("agentTasks.#tid.reverifyClaimedAt = :now");
    // Without the REMOVE, the PREVIOUS head's ticket id would survive into this
    // head's claim and read as if this head were already filed.
    expect(input.UpdateExpression).toContain("REMOVE agentTasks.#tid.reverifyTicketId");
    expect(input.ConditionExpression).toBe(
      "attribute_exists(agentTasks.#tid) AND (attribute_not_exists(agentTasks.#tid.reverifySha)" +
      " OR agentTasks.#tid.reverifySha <> :sha)"
    );
    expect(input.ExpressionAttributeNames["#tid"]).toBe(FIX);
    expect(input.ExpressionAttributeValues).toEqual({ ":sha": SHA, ":now": NOW });
    // No read on the winning path — the CAS is the whole decision.
    expect(sent.filter((c) => c.type === "GetCommand")).toHaveLength(0);
  });

  it("returns taken when the winner has already filed the ticket", async () => {
    condOutcomes.push("fail");
    stubItem = rowWith({ reverifySha: SHA, reverifyTicketId: "TEAM-4130-9", reverifyClaimedAt: NOW });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("taken");
    expect(writes()).toHaveLength(1);   // no takeover attempted
  });

  it("returns taken while another caller's claim is still fresh", async () => {
    condOutcomes.push("fail");
    stubItem = rowWith({ reverifySha: SHA, reverifyClaimedAt: "2026-09-06T11:59:00.000Z" });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("taken");
    expect(writes()).toHaveLength(1);
  });

  it("returns taken when the slot raced onto a third sha", async () => {
    condOutcomes.push("fail");
    stubItem = rowWith({ reverifySha: "deadbee", reverifyClaimedAt: NOW });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("taken");
  });

  it("returns untracked (fail-open) when there is no task entry to claim on", async () => {
    condOutcomes.push("fail");
    stubItem = { workflowId: "wf_1", agentTasks: {} };
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("untracked");
    expect(sent.filter((c) => c.type === "GetCommand")).toHaveLength(1);
    expect(sent.find((c) => c.type === "GetCommand").input.ProjectionExpression)
      .toBe("agentTasks.#tid");
  });

  it("takes over a claim whose winner died, conditioned on the generation it read", async () => {
    const stale = "2026-09-06T11:40:00.000Z";   // 20 min old, past the 10 min default
    condOutcomes.push("fail", "ok");
    stubItem = rowWith({ reverifySha: SHA, reverifyClaimedAt: stale });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("claimed");
    const takeover = writes()[1].input;
    expect(takeover.ConditionExpression).toBe(
      "agentTasks.#tid.reverifySha = :sha AND attribute_not_exists(agentTasks.#tid.reverifyTicketId)" +
      " AND agentTasks.#tid.reverifyClaimedAt = :oldClaimedAt"
    );
    expect(takeover.ExpressionAttributeValues[":oldClaimedAt"]).toBe(stale);
    // The takeover must leave the SAME state as a fresh claim, or readers would
    // have to distinguish two shapes of "claim held".
    expect(takeover.UpdateExpression).toBe(writes()[0].input.UpdateExpression);
  });

  it("yields to whoever else took over the same stale claim", async () => {
    condOutcomes.push("fail", "fail");
    stubItem = rowWith({ reverifySha: SHA, reverifyClaimedAt: "2026-09-06T11:00:00.000Z" });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW)).toBe("taken");
    expect(writes()).toHaveLength(2);
  });

  it("honours an explicit staleAfterMs", async () => {
    condOutcomes.push("fail", "ok");
    stubItem = rowWith({ reverifySha: SHA, reverifyClaimedAt: "2026-09-06T11:59:00.000Z" });
    expect(await claimReverifySlot("wf_1", FIX, SHA, NOW, { staleAfterMs: 30_000 })).toBe("claimed");
  });

  it("rethrows a non-CCFE claim error instead of guessing", async () => {
    const boom = new Error("throttled");
    boom.name = "ProvisionedThroughputExceededException";
    throwOnce = boom;
    await expect(claimReverifySlot("wf_1", FIX, SHA, NOW)).rejects.toThrow("throttled");
  });

  it("releases the slot after a failed create so it is not wedged", async () => {
    expect(await releaseReverifySlot("wf_1", FIX, SHA)).toBe(true);
    const { input } = writes()[0];
    expect(input.UpdateExpression).toBe(
      "REMOVE agentTasks.#tid.reverifySha, agentTasks.#tid.reverifyClaimedAt"
    );
    expect(input.ConditionExpression).toBe(
      "agentTasks.#tid.reverifySha = :sha AND attribute_not_exists(agentTasks.#tid.reverifyTicketId)"
    );
    expect(input.ExpressionAttributeValues).toEqual({ ":sha": SHA });
  });

  it("refuses to release once a ticket id is linked (CCFE is normal, not an error)", async () => {
    condOutcomes.push("fail");
    expect(await releaseReverifySlot("wf_1", FIX, SHA)).toBe(false);
  });

  it("rethrows a non-CCFE release error", async () => {
    const boom = new Error("network");
    boom.name = "TimeoutError";
    throwOnce = boom;
    await expect(releaseReverifySlot("wf_1", FIX, SHA)).rejects.toThrow("network");
  });
});
