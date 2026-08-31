import { describe, it, expect } from "vitest";
import {
  applyAgentStatus,
  applyAgentComplete,
  canRegressCompletedTask,
  shouldForceTicketDone,
} from "./board-state";
import type { AgentTask } from "./types";

const T0 = "2026-08-31T10:00:00.000Z";
const T1 = "2026-08-31T10:05:00.000Z"; // after T0
const T_LATE = "2026-08-31T09:55:00.000Z"; // before T0

function completedTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task_1",
    agentId: "dev",
    ticketId: "TEAM-1",
    status: "complete",
    input: "",
    completedAt: T0,
    ...overrides,
  };
}

describe("canRegressCompletedTask", () => {
  it("allows a NEW ticket (fix-it fan-out)", () => {
    expect(canRegressCompletedTask(completedTask(), { agentId: "dev", status: "running", ticketId: "TEAM-9", timestamp: T_LATE })).toBe(true);
  });

  it("allows a same-ticket event newer than completedAt (rework)", () => {
    expect(canRegressCompletedTask(completedTask(), { agentId: "dev", status: "running", ticketId: "TEAM-1", timestamp: T1 })).toBe(true);
  });

  it("blocks a same-ticket event older than completedAt (late/duplicate)", () => {
    expect(canRegressCompletedTask(completedTask(), { agentId: "dev", status: "running", ticketId: "TEAM-1", timestamp: T_LATE })).toBe(false);
  });

  it("blocks when timestamps are missing (safe default)", () => {
    expect(canRegressCompletedTask(completedTask(), { agentId: "dev", status: "running", ticketId: "TEAM-1" })).toBe(false);
    expect(canRegressCompletedTask(completedTask({ completedAt: undefined }), { agentId: "dev", status: "running", ticketId: "TEAM-1", timestamp: T1 })).toBe(false);
  });
});

describe("applyAgentStatus", () => {
  it("creates a task for an unknown agent", () => {
    const next = applyAgentStatus({}, { agentId: "dev", status: "running", ticketId: "TEAM-1" });
    expect(next?.dev.status).toBe("running");
    expect(next?.dev.ticketId).toBe("TEAM-1");
  });

  it("returns null for a late duplicate on a completed task", () => {
    const next = applyAgentStatus({ dev: completedTask() }, { agentId: "dev", status: "running", ticketId: "TEAM-1", timestamp: T_LATE });
    expect(next).toBeNull();
  });

  it("regresses a completed task to running on rework and clears completedAt", () => {
    const next = applyAgentStatus({ dev: completedTask() }, { agentId: "dev", status: "running", ticketId: "TEAM-1", timestamp: T1 });
    expect(next?.dev.status).toBe("running");
    expect(next?.dev.completedAt).toBeUndefined();
  });

  it("switches ticketId on a NEW-ticket re-invocation", () => {
    const next = applyAgentStatus({ dev: completedTask() }, { agentId: "dev", status: "running", ticketId: "TEAM-9", timestamp: T_LATE });
    expect(next?.dev.status).toBe("running");
    expect(next?.dev.ticketId).toBe("TEAM-9");
  });

  it("updates a non-complete task without conditions", () => {
    const next = applyAgentStatus(
      { dev: completedTask({ status: "running", completedAt: undefined }) },
      { agentId: "dev", status: "waiting_response", ticketId: "TEAM-1" }
    );
    expect(next?.dev.status).toBe("waiting_response");
  });
});

describe("applyAgentComplete", () => {
  it("stamps completedAt from the event timestamp", () => {
    const next = applyAgentComplete(
      { dev: completedTask({ status: "running", completedAt: undefined }) },
      { agentId: "dev", output: "done", timestamp: T1 }
    );
    expect(next?.dev.status).toBe("complete");
    expect(next?.dev.completedAt).toBe(T1);
  });

  it("keeps the longer accumulated output", () => {
    const next = applyAgentComplete(
      { dev: completedTask({ status: "running", output: "a much longer streamed output" }) },
      { agentId: "dev", output: "short", timestamp: T1 }
    );
    expect(next?.dev.output).toBe("a much longer streamed output");
  });

  it("resolves the task by agentId value when keys are ticket ids", () => {
    const next = applyAgentComplete(
      { "TEAM-1": completedTask({ status: "running" }) },
      { agentId: "dev", output: "done", timestamp: T1 }
    );
    expect(next?.["TEAM-1"].status).toBe("complete");
  });

  it("returns null when no task matches", () => {
    expect(applyAgentComplete({}, { agentId: "ghost", timestamp: T1 })).toBeNull();
  });
});

describe("shouldForceTicketDone", () => {
  const doneTask = { status: "complete", completedAt: T0 };

  it("forces done when the ticket is staler than the completion (Jira lag)", () => {
    expect(shouldForceTicketDone(doneTask, { status: "in_progress", updatedAt: T_LATE })).toBe(true);
  });

  it("does NOT force done when the ticket was updated after completion (rework)", () => {
    expect(shouldForceTicketDone(doneTask, { status: "ready", updatedAt: T1 })).toBe(false);
  });

  it("no-op for non-complete tasks, missing tickets, already-done tickets", () => {
    expect(shouldForceTicketDone({ status: "running" }, { status: "ready", updatedAt: T1 })).toBe(false);
    expect(shouldForceTicketDone(doneTask, undefined)).toBe(false);
    expect(shouldForceTicketDone(doneTask, { status: "done", updatedAt: T_LATE })).toBe(false);
  });

  it("forces done when timestamps are missing (legacy behavior)", () => {
    expect(shouldForceTicketDone({ status: "complete" }, { status: "in_progress" })).toBe(true);
  });
});
