import { describe, it, expect, beforeEach } from "vitest";
import {
  initWorkflowStore,
  createWorkflow,
  claimInvocation,
  trackTicket,
  mergeTaskMetadata,
  setTaskStatus,
  advancePhase,
  setResumeContext,
  appendNotification,
  ackNotifications,
  completeWorkflow,
} from "./workflow-store.mjs";

/**
 * R2 (docs/race-condition-study.md): every store op must be a SCOPED
 * conditional write — no full-row puts, no unconditioned map replacement.
 * These tests pin the write shapes with a stub client; the conditional-race
 * semantics (winner/loser) are pinned by simulating
 * ConditionalCheckFailedException.
 */

const sent = [];
let failNextCondition = false;

const stubDdb = {
  async send(cmd) {
    sent.push({ type: cmd.constructor.name, input: cmd.input });
    if (failNextCondition && cmd.input.ConditionExpression) {
      failNextCondition = false;
      const err = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    }
    return {};
  },
};

beforeEach(() => {
  sent.length = 0;
  failNextCondition = false;
  initWorkflowStore(stubDdb, "workflows-test");
});

const writes = () => sent.filter((c) => c.type !== "GetCommand");

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
  it("completes exactly once (phase-guarded conditional)", async () => {
    const won = await completeWorkflow("wf_1", "2026-08-30T00:00:00Z");
    expect(won).toBe(true);
    const w = writes()[0];
    expect(w.input.ConditionExpression).toContain("phase <> :complete");
    expect(w.input.ConditionExpression).toContain("phase <> :cancelled");
  });

  it("returns false for the losing concurrent completion", async () => {
    failNextCondition = true;
    expect(await completeWorkflow("wf_1", "x")).toBe(false);
  });
});
