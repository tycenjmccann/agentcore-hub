import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4099 F6 — the app tier's ONE workflows-table writer.
 *
 * Ten route files used to hand-roll their own UpdateCommands against the
 * workflows table, and scripts/check-workflow-writes.sh only ever scanned
 * lambda/orchestrator/*.mjs — so two of them had quietly drifted off the R2 rule
 * (mark-done clobbered real evidence, the escalation ack rewrote the whole
 * notification list). This suite pins the SHAPE of every moved write: what it
 * conditions on, what it scopes to, and which ones fill rather than replace.
 *
 * The only mock is the DDB doc client; every command input is captured verbatim.
 */

const h = vi.hoisted(() => ({
  state: {
    sent: [] as Array<{ name: string; input: Record<string, any> }>,
    /** Item returned by GetCommand (the ack path's own read). */
    item: null as Record<string, unknown> | null,
    /** Command names (in order) whose send() should raise a CCF. */
    failWith: [] as Array<string | null>,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand extends Cmd {}
  class PutCommand extends Cmd {}
  class UpdateCommand extends Cmd {}
  class TransactWriteCommand extends Cmd {}
  return {
    GetCommand,
    PutCommand,
    UpdateCommand,
    TransactWriteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
          const name = cmd.constructor.name;
          h.state.sent.push({ name, input: cmd.input });
          const fail = h.state.failWith.shift();
          if (fail) {
            const e = new Error(fail);
            e.name = fail;
            throw e;
          }
          if (name === "GetCommand") return { Item: h.state.item };
          return {};
        },
      }),
    },
  };
});

const store = await import("./workflow-store");

const WORKFLOWS = "agentcore-hub-workflows";

const updates = () => h.state.sent.filter((s) => s.name === "UpdateCommand").map((s) => s.input);
const puts = () => h.state.sent.filter((s) => s.name === "PutCommand").map((s) => s.input);
const ccf = () => {
  const e = new Error("ConditionalCheckFailedException");
  e.name = "ConditionalCheckFailedException";
  return e;
};

beforeEach(() => {
  h.state.sent.length = 0;
  h.state.item = null;
  h.state.failWith.length = 0;
});

describe("every write targets the workflows table and is scoped", () => {
  it("no write is unconditioned except the ones that are documented as such", async () => {
    await store.mergeTaskMetadata("wf_1", "T-1", { output: "x" });
    await store.setTaskStatus("wf_1", "T-1", "ready");
    await store.setManagerWatch("wf_1", false);
    await store.claimCancellation("wf_1", { cancelledAt: "t", previousPhase: "development" });
    await store.clearEpicRollupPending("wf_1");
    for (const u of updates()) {
      expect(u.TableName).toBe(WORKFLOWS);
      expect(u.Key).toEqual({ workflowId: "wf_1" });
      expect(u.ConditionExpression).toBeTruthy();
    }
  });
});

describe("task-entry writes", () => {
  it("mergeTaskMetadata sets per FIELD, never the whole entry, and needs the entry to exist", async () => {
    await store.mergeTaskMetadata("wf_1", "T-1", { output: "did the thing", prUrl: "https://x/1" });
    const [u] = updates();
    expect(u.UpdateExpression).toBe("SET agentTasks.#tid.#f0 = :v0, agentTasks.#tid.#f1 = :v1");
    expect(u.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
    expect(u.ExpressionAttributeNames).toEqual({ "#tid": "T-1", "#f0": "output", "#f1": "prUrl" });
    expect(u.ExpressionAttributeValues).toEqual({ ":v0": "did the thing", ":v1": "https://x/1" });
  });

  it("mergeTaskMetadata drops undefined/null fields and returns false on a lost CAS", async () => {
    h.state.failWith = ["ConditionalCheckFailedException"];
    const applied = await store.mergeTaskMetadata("wf_1", "T-1", { output: "x", branch: undefined, prUrl: null });
    expect(applied).toBe(false);
    expect(updates()[0].ExpressionAttributeNames).toEqual({ "#tid": "T-1", "#f0": "output" });
  });

  it("mergeTaskMetadata with touchUpdatedAt stamps the row in the SAME write (the webhook path)", async () => {
    await store.mergeTaskMetadata("wf_1", "T-1", { status: "complete" }, { touchUpdatedAt: true });
    const [u] = updates();
    expect(u.UpdateExpression).toBe("SET #u = :u, agentTasks.#tid.#f0 = :v0");
    expect(u.ExpressionAttributeNames["#u"]).toBe("updatedAt");
  });

  it("mergeTaskMetadata is a no-op (false, zero writes) when there is nothing settable", async () => {
    expect(await store.mergeTaskMetadata("wf_1", "T-1", { output: undefined })).toBe(false);
    expect(h.state.sent).toEqual([]);
  });

  it("trackTicket is first-writer-wins and reports whether THIS call created the entry", async () => {
    expect(await store.trackTicket("wf_1", "T-1", { ticketId: "T-1" })).toBe(true);
    const [seedMap, seed] = updates();
    expect(seedMap.UpdateExpression).toBe("SET agentTasks = if_not_exists(agentTasks, :emptyMap)");
    expect(seed.UpdateExpression).toBe("SET agentTasks.#tid = if_not_exists(agentTasks.#tid, :seed)");
    expect(seed.ConditionExpression).toBe("attribute_not_exists(agentTasks.#tid)");

    h.state.sent.length = 0;
    h.state.failWith = [null, "ConditionalCheckFailedException"];
    expect(await store.trackTicket("wf_1", "T-1", { ticketId: "T-1" })).toBe(false);
  });

  it("setTaskStatus writes ONLY status, on the existing entry", async () => {
    await store.setTaskStatus("wf_1", "T-1", "ready");
    const [u] = updates();
    expect(u.UpdateExpression).toBe("SET agentTasks.#tid.#st = :s");
    expect(u.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
    expect(u.ExpressionAttributeValues).toEqual({ ":s": "ready" });
  });
});

describe("markDoneEvidence — fill-only unless forced (the F6 fix)", () => {
  it("without force: every field is if_not_exists AND the write refuses an existing output", async () => {
    const res = await store.markDoneEvidence("wf_1", "T-1", { output: "typed", branch: "b" });
    expect(res).toEqual({ applied: true });
    const [u] = updates();
    expect(u.UpdateExpression).toBe(
      "SET agentTasks.#tid.#f0 = if_not_exists(agentTasks.#tid.#f0, :v0), " +
        "agentTasks.#tid.#f1 = if_not_exists(agentTasks.#tid.#f1, :v1)"
    );
    expect(u.ConditionExpression).toBe(
      "attribute_exists(agentTasks.#tid) AND attribute_not_exists(agentTasks.#tid.#out)"
    );
    expect(u.ExpressionAttributeNames["#out"]).toBe("output");
  });

  it("empty-string fields are dropped, so a blank harvest cannot occupy a gap", async () => {
    await store.markDoneEvidence("wf_1", "T-1", { output: "typed", branch: "", commitSha: "" });
    expect(updates()[0].ExpressionAttributeNames).toEqual({
      "#tid": "T-1",
      "#f0": "output",
      "#out": "output",
    });
  });

  it("with force: plain SETs and no output guard", async () => {
    const res = await store.markDoneEvidence("wf_1", "T-1", { output: "override" }, { force: true });
    expect(res).toEqual({ applied: true });
    const [u] = updates();
    expect(u.UpdateExpression).toBe("SET agentTasks.#tid.#f0 = :v0");
    expect(u.ConditionExpression).toBe("attribute_exists(agentTasks.#tid)");
    expect(u.ExpressionAttributeNames["#out"]).toBeUndefined();
  });

  it("a lost CAS on an entry that DOES exist is evidence_exists — not a blind retry", async () => {
    // write → CCF, ensureAgentTasksMap → ok, seed → CCF (entry already there).
    h.state.failWith = ["ConditionalCheckFailedException", null, "ConditionalCheckFailedException"];
    const res = await store.markDoneEvidence("wf_1", "T-1", { output: "typed" });
    expect(res).toEqual({ applied: false, reason: "evidence_exists" });
    // Exactly ONE evidence attempt: the store never retried over the real output.
    expect(updates().filter((u) => String(u.ConditionExpression).includes("#out"))).toHaveLength(1);
  });

  it("a lost CAS because the entry was MISSING seeds it and retries once", async () => {
    h.state.failWith = ["ConditionalCheckFailedException", null, null];
    const res = await store.markDoneEvidence("wf_1", "T-1", { output: "typed" }, { seed: { agentId: "dev" } });
    expect(res).toEqual({ applied: true });
    const seed = updates().find((u) => u.ExpressionAttributeValues?.[":seed"]);
    expect(seed!.ExpressionAttributeValues[":seed"]).toMatchObject({
      ticketId: "T-1",
      status: "pending",
      agentId: "dev",
    });
    expect(updates().filter((u) => String(u.ConditionExpression).includes("#out"))).toHaveLength(2);
  });

  it("nothing settable is reported, not written", async () => {
    expect(await store.markDoneEvidence("wf_1", "T-1", { output: "" })).toEqual({
      applied: false,
      reason: "nothing_to_set",
    });
    expect(h.state.sent).toEqual([]);
  });
});

describe("run-level writes", () => {
  it("completeWorkflow refuses all five terminal phases AND a stamped cancelledAt", async () => {
    expect(
      await store.completeWorkflow("wf_1", {
        completedAt: "t",
        previousPhase: "ship",
        notifications: [],
        epicRollupPending: true,
        completeReason: "manager",
      })
    ).toBe(true);
    const [u] = updates();
    const refused = Object.entries(u.ExpressionAttributeValues as Record<string, string>)
      .filter(([k]) => String(u.ConditionExpression).includes(`#phase <> ${k}`))
      .map(([, v]) => v)
      .sort();
    expect(refused).toEqual([...store.TERMINAL_PHASES].sort());
    expect(u.ConditionExpression).toContain("attribute_not_exists(cancelledAt)");
    // The roll-up obligation is created in the SAME write as the claim.
    expect(u.UpdateExpression).toContain("epicRollupPending = :pending");
    expect(u.UpdateExpression).toContain("completeReason = :reason");
  });

  it("completeWorkflow omits epicRollupPending when the run has no epic", async () => {
    await store.completeWorkflow("wf_1", { completedAt: "t", previousPhase: "ship", notifications: [] });
    const [u] = updates();
    expect(u.UpdateExpression).not.toContain("epicRollupPending");
    expect(u.ExpressionAttributeValues[":pending"]).toBeUndefined();
  });

  it("claimTerminalOutcome uses the same CAS as the green complete", async () => {
    await store.claimTerminalOutcome("wf_1", {
      outcome: "deploy-blocked",
      completedAt: "t",
      previousPhase: "ship",
      notifications: [],
      blockReason: "preflight failed",
    });
    const [u] = updates();
    expect(u.ConditionExpression).toContain("attribute_not_exists(cancelledAt)");
    expect(u.ExpressionAttributeValues[":outcome"]).toBe("deploy-blocked");
    expect(u.UpdateExpression).toContain("blockReason = :reason");
  });

  it("both terminal claims return false (never throw) when they lose", async () => {
    h.state.failWith = ["ConditionalCheckFailedException"];
    expect(await store.completeWorkflow("wf_1", { completedAt: "t", previousPhase: "x", notifications: [] })).toBe(false);
    h.state.failWith = ["ConditionalCheckFailedException"];
    expect(
      await store.claimTerminalOutcome("wf_1", {
        outcome: "static-ci-only",
        completedAt: "t",
        previousPhase: "x",
        notifications: [],
      })
    ).toBe(false);
  });

  it("a non-CAS error still propagates (the caller must not read it as a lost race)", async () => {
    h.state.failWith = ["ProvisionedThroughputExceededException"];
    await expect(store.setTaskStatus("wf_1", "T-1", "ready")).rejects.toThrow();
  });

  it("clearEpicRollupPending REMOVEs only while the flag is there", async () => {
    await store.clearEpicRollupPending("wf_1");
    const [u] = updates();
    expect(u.UpdateExpression).toBe("REMOVE epicRollupPending");
    expect(u.ConditionExpression).toBe("attribute_exists(epicRollupPending)");
  });

  it("claimCancellation refuses every terminal phase and carries the reason only when given", async () => {
    await store.claimCancellation("wf_1", { cancelledAt: "t", previousPhase: "development" });
    expect(updates()[0].UpdateExpression).not.toContain("cancelReason");
    h.state.sent.length = 0;
    await store.claimCancellation("wf_1", { cancelledAt: "t", previousPhase: "development", reason: "wrong PRD" });
    const [u] = updates();
    expect(u.UpdateExpression).toContain("cancelReason = :reason");
    expect(store.TERMINAL_PHASES.every((p) => Object.values(u.ExpressionAttributeValues).includes(p))).toBe(true);
  });

  it("the dedup marker is claimed first-writer-wins and re-pointed on the exact prior owner", async () => {
    expect(await store.claimDedupMarker({ workflowId: "wfdedup_x" })).toBe(true);
    expect(puts()[0].ConditionExpression).toBe("attribute_not_exists(workflowId)");
    h.state.sent.length = 0;
    await store.repointDedupMarker({ workflowId: "wfdedup_x" }, "wf_old");
    expect(puts()[0].ConditionExpression).toBe("canonicalWorkflowId = :old");
    expect(puts()[0].ExpressionAttributeValues).toEqual({ ":old": "wf_old" });
  });

  it("putWorkflowRowFenced puts plainly with no marker, and inside a marker-checked transaction with one", async () => {
    expect(await store.putWorkflowRowFenced({ workflowId: "wf_1" }, undefined)).toEqual({ won: true });
    expect(puts()[0].ConditionExpression).toBeUndefined();

    h.state.sent.length = 0;
    expect(await store.putWorkflowRowFenced({ workflowId: "wf_1" }, "wfdedup_x")).toEqual({ won: true });
    const tx = h.state.sent.find((s) => s.name === "TransactWriteCommand")!.input;
    const check = tx.TransactItems.find((t: Record<string, any>) => t.ConditionCheck).ConditionCheck;
    expect(check.ConditionExpression).toBe("canonicalWorkflowId = :me");
    expect(check.ExpressionAttributeValues).toEqual({ ":me": "wf_1" });
  });

  it("a cancelled fence transaction is a LOSS only when the marker no longer names us", async () => {
    h.state.failWith = ["TransactionCanceledException"];
    h.state.item = { canonicalWorkflowId: "wf_other" };
    expect(await store.putWorkflowRowFenced({ workflowId: "wf_1" }, "wfdedup_x")).toEqual({
      won: false,
      winner: "wf_other",
    });

    // Still ours ⇒ transient conflict, not a loss: it must propagate.
    h.state.sent.length = 0;
    h.state.failWith = ["TransactionCanceledException"];
    h.state.item = { canonicalWorkflowId: "wf_1" };
    await expect(store.putWorkflowRowFenced({ workflowId: "wf_1" }, "wfdedup_x")).rejects.toThrow();
  });
});

describe("appendGateDecision — the merge-authority ledger", () => {
  it("seeds the gate sub-map, then list_appends (never a whole-array rewrite)", async () => {
    await store.appendGateDecision("wf_1", "TEAM-9", { decision: "APPROVE", decidedBy: "alice" });
    const [seedMap, seedGate, append] = updates();
    expect(seedMap.UpdateExpression).toBe("SET reviewGateHistory = if_not_exists(reviewGateHistory, :emptyMap)");
    expect(seedGate.UpdateExpression).toBe(
      "SET reviewGateHistory.#g = if_not_exists(reviewGateHistory.#g, :seed)"
    );
    expect(append.UpdateExpression).toBe(
      "SET reviewGateHistory.#g.decisions = list_append(if_not_exists(reviewGateHistory.#g.decisions, :empty), :d)"
    );
    expect(append.ExpressionAttributeNames).toEqual({ "#g": "TEAM-9" });
    expect(append.ExpressionAttributeValues[":d"]).toEqual([{ decision: "APPROVE", decidedBy: "alice" }]);
  });
});

describe("ackNotifications — per index, never the whole list (the second F6 fix)", () => {
  const NOTIFS = [
    { id: "n1", type: "manager_escalation" },
    { id: "n2", type: "review_needed" },
    { id: "n3", type: "manager_escalation", acknowledged: true },
    { id: "n4", type: "manager_escalation" },
  ];

  it("writes one scoped update per match, conditioned on that index still holding the id", async () => {
    h.state.item = { humanNotifications: NOTIFS };
    const res = await store.ackNotifications("wf_1", (n) => n?.type === "manager_escalation", "2026-01-01T00:00:00Z");
    expect(res).toEqual({ acknowledged: ["n1", "n4"], skipped: [] });

    // NOTHING rewrites the list itself.
    for (const u of updates()) {
      expect(u.UpdateExpression).not.toMatch(/SET humanNotifications = /);
    }
    const [first, second] = updates();
    expect(first.UpdateExpression).toBe(
      "SET humanNotifications[0].acknowledged = :true, humanNotifications[0].acknowledgedAt = :ts, " +
        "notifVersion = if_not_exists(notifVersion, :zero) + :one"
    );
    expect(first.ConditionExpression).toBe("humanNotifications[0].id = :id");
    expect(first.ExpressionAttributeValues).toEqual({
      ":true": true,
      ":ts": "2026-01-01T00:00:00Z",
      ":id": "n1",
      ":zero": 0,
      ":one": 1,
    });
    // Index 3, not index 1: the already-acked and non-matching rows are skipped
    // in place, so the indices written are the ones that were matched.
    expect(second.ConditionExpression).toBe("humanNotifications[3].id = :id");
    expect(second.ExpressionAttributeValues[":id"]).toBe("n4");
  });

  it("a list that moved under us refuses instead of acking the wrong row", async () => {
    h.state.item = { humanNotifications: [{ id: "n1", type: "manager_escalation" }] };
    h.state.failWith = [null, "ConditionalCheckFailedException"]; // Get, then the ack
    expect(await store.ackNotifications("wf_1", () => true)).toEqual({ acknowledged: [], skipped: ["n1"] });
  });

  it("an id-less notification is reported, never blind-written at its index", async () => {
    h.state.item = { humanNotifications: [{ type: "manager_escalation" }] };
    expect(await store.ackNotifications("wf_1", () => true)).toEqual({ acknowledged: [], skipped: ["0"] });
    expect(updates()).toEqual([]);
  });

  it("no notifications at all is a clean no-op", async () => {
    h.state.item = {};
    expect(await store.ackNotifications("wf_1", () => true)).toEqual({ acknowledged: [], skipped: [] });
    expect(updates()).toEqual([]);
  });
});

describe("setResumeContext", () => {
  it("seeds the map then sets the ONE key (two concurrent resumes cannot clobber)", async () => {
    await store.setResumeContext("wf_1", "T-1", "PR #7 exists — resume");
    const [seed, set] = updates();
    expect(seed.UpdateExpression).toBe("SET resumeContexts = if_not_exists(resumeContexts, :empty)");
    expect(set.UpdateExpression).toBe("SET resumeContexts.#k = :note");
    expect(set.ExpressionAttributeNames).toEqual({ "#k": "T-1" });
    expect(set.ExpressionAttributeValues).toEqual({ ":note": "PR #7 exists — resume" });
  });
});

describe("row-level stamps", () => {
  it("setArchived is idempotent by construction, setManagerWatch needs the row", async () => {
    await store.setArchived("wf_1", "2026-01-01T00:00:00Z");
    expect(updates()[0].UpdateExpression).toBe("SET archived = :true, archivedAt = :ts");
    h.state.sent.length = 0;
    expect(await store.setManagerWatch("wf_1", false)).toBe(true);
    expect(updates()[0].ConditionExpression).toBe("attribute_exists(workflowId)");
    h.state.failWith = ["ConditionalCheckFailedException"];
    expect(await store.setManagerWatch("wf_1", false)).toBe(false);
  });

  it("markWorkflowStartError flips a stillborn run to error so the dedup key frees up", async () => {
    await store.markWorkflowStartError("wf_1", "intake ticket creation failed: boom");
    const [u] = updates();
    expect(u.UpdateExpression).toBe("SET #phase = :error, erroredAt = :ts, startError = :msg");
    expect(u.ExpressionAttributeValues[":error"]).toBe("error");
  });

  it("tombstoneWorkflow puts the stripped row (unconditioned on purpose)", async () => {
    await store.tombstoneWorkflow({ workflowId: "wf_1", deleted: true });
    expect(puts()[0]).toEqual({ TableName: WORKFLOWS, Item: { workflowId: "wf_1", deleted: true } });
  });
});

describe("the guard's own premise", () => {
  it("isConditionFailure is what every CAS-losing path returns on, so nothing swallows a real error", async () => {
    // Proven behaviourally: a CCF is a false, anything else throws (above), for
    // each family of write.
    h.state.failWith = ["ConditionalCheckFailedException"];
    expect(await store.mergeTaskMetadata("wf_1", "T-1", { output: "x" })).toBe(false);
    h.state.failWith = ["ValidationException"];
    await expect(store.mergeTaskMetadata("wf_1", "T-1", { output: "x" })).rejects.toThrow();
  });

  it("exports the table name it writes, so tests and tooling never re-derive it", () => {
    expect(store.workflowsTable).toBe(WORKFLOWS);
    expect(ccf().name).toBe("ConditionalCheckFailedException");
  });
});
