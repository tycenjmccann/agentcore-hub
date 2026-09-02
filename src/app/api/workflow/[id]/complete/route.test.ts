import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3619 D4a — the completion guard on POST /api/workflow/[id]/complete.
 *
 * Two new refusals layered on top of the existing no-bypass open-children gate:
 *   1. A cancelled run (cancelledAt stamped) can never be completed — 409
 *      workflow_cancelled, checked before anything else.
 *   2. Behind COMPLETION_EVIDENCE_REQUIRED (default ON — enforce, TEAM-3690):
 *      a done ticket in a completion-required phase whose agentTask has no
 *      output/artifact is a phantom deliverable — 409 missing_evidence by
 *      default and on any unrecognized value (fail-closed). Only the explicit
 *      opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0 falls back to a
 *      shadow-log + success.
 *
 * We mock only the seams: the DDB doc client (GetCommand returns the workflow;
 * writes are captured), EventBridge, the ticket reader, and the def loader.
 */

const h = vi.hoisted(() => {
  const state: {
    workflow: Record<string, unknown>;
    tickets: Array<Record<string, unknown>>;
    def: Record<string, unknown>;
    updates: Array<Record<string, unknown>>;
    // TEAM-3686 F1: simulate the terminal write losing its CAS. When set, the
    // UpdateCommand throws with this error name — after first swapping the
    // stored workflow for `workflowAfterFail` (the racing writer's result), so
    // the route's re-read sees what actually won.
    updateError: string | null;
    workflowAfterFail: Record<string, unknown> | null;
  } = { workflow: {}, tickets: [], def: {}, updates: [], updateError: null, workflowAfterFail: null };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.workflow };
          if (name === "UpdateCommand") {
            if (h.state.updateError) {
              if (h.state.workflowAfterFail) h.state.workflow = h.state.workflowAfterFail;
              const e = new Error("conditional check failed");
              e.name = h.state.updateError;
              throw e;
            }
            h.state.updates.push(cmd.input);
            return {};
          }
          return {}; // PutCommand (events table) — non-fatal
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send() {
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@/lib/workflow/dynamo-read", () => ({
  getTicketsForWorkflowFromDynamo: vi.fn(async () => h.state.tickets),
}));
vi.mock("@/lib/workflow/jira-read", () => ({
  getTicketsForWorkflowFromJira: vi.fn(async () => h.state.tickets),
}));
vi.mock("@/lib/workflow/jira-client", () => ({ JiraClient: { fromEnv: () => ({ transitionIssue: vi.fn() }) } }));
vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async () => h.state.def),
}));

let POST: typeof import("./route").POST;

const SAVED = ["COMPLETION_EVIDENCE_REQUIRED", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

async function load() {
  vi.resetModules();
  ({ POST } = await import("./route"));
}

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.updateError = null;
  h.state.workflowAfterFail = null;
  h.state.def = { completionRequiresAgentPhases: ["ship"] };
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.TICKET_PROVIDER = "dynamodb";
  delete process.env.COMPLETION_EVIDENCE_REQUIRED;
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(id = "wf_1") {
  return POST(new NextRequest(`http://localhost/api/workflow/${id}/complete`, { method: "POST", body: "{}" }), {
    params: { id },
  });
}

describe("POST complete — cancellation guard (D4a)", () => {
  it("refuses a cancelled run with 409 workflow_cancelled before loading tickets", async () => {
    h.state.workflow = { workflowId: "wf_1", phase: "ship", cancelledAt: "2026-08-30T00:00:00Z" };
    h.state.tickets = [];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("workflow_cancelled");
    expect(body.cancelledAt).toBe("2026-08-30T00:00:00Z");
    expect(h.state.updates.length).toBe(0);
  });
});

describe("POST complete — cancel/complete race CAS guard (TEAM-3686 F1)", () => {
  const CLEAN_WF = { workflowId: "wf_1", phase: "ship", agentTasks: {} };

  it("guards the terminal write with attribute_not_exists(cancelledAt)", async () => {
    h.state.workflow = { ...CLEAN_WF };
    h.state.tickets = [];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.state.updates.length).toBe(1);
    expect(String(h.state.updates[0].ConditionExpression)).toContain(
      "attribute_not_exists(cancelledAt)"
    );
  });

  it("a cancel landing between pre-read and write yields 409 workflow_cancelled", async () => {
    h.state.workflow = { ...CLEAN_WF };
    h.state.tickets = [];
    // The CAS loses; the re-read reveals the racing cancel's stamp.
    h.state.updateError = "ConditionalCheckFailedException";
    h.state.workflowAfterFail = { ...CLEAN_WF, cancelledAt: "2026-08-31T00:00:00Z" };
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("workflow_cancelled");
    expect(body.cancelledAt).toBe("2026-08-31T00:00:00Z");
    expect(h.state.updates.length).toBe(0);
  });

  it("a lost CAS without a cancel stamp yields the generic terminal 409", async () => {
    h.state.workflow = { ...CLEAN_WF };
    h.state.tickets = [];
    // Another completer won — terminal phase, no cancelledAt.
    h.state.updateError = "ConditionalCheckFailedException";
    h.state.workflowAfterFail = { ...CLEAN_WF, phase: "complete" };
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Workflow already in terminal state");
  });

  it("a non-CAS write error still propagates as a 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.workflow = { ...CLEAN_WF };
    h.state.tickets = [];
    h.state.updateError = "ProvisionedThroughputExceededException";
    await load();
    const res = await post();
    expect(res.status).toBe(500);
    error.mockRestore();
  });
});

describe("POST complete — deliverable-evidence gate (D4a)", () => {
  const doneShipTicket = { ticketId: "T-4", type: "task", status: "done", phase: "ship", assignee: "rm" };

  it("409 missing_evidence when the flag is ON and a done ship ticket has an empty task", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "true";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("missing_evidence");
    expect(body.tickets).toEqual([{ ticketId: "T-4", phase: "ship" }]);
    expect(h.state.updates.length).toBe(0); // never wrote the completion
  });

  it("AC-D4.1 (TEAM-3690): with the flag UNSET (default ON) an empty completion record cannot close — 409, no write", async () => {
    // The regression that F2 named: in the default/production config an empty
    // completion record must be REFUSED, not shadow-logged. Env var deleted in
    // beforeEach → the true default → enforce.
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("missing_evidence");
    expect(body.tickets).toEqual([{ ticketId: "T-4", phase: "ship" }]);
    expect(h.state.updates.length).toBe(0); // workflow record NOT written / no completion event
  });

  it("fail-closed: an unrecognized flag value (\"banana\") still enforces — 409, no write", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "banana";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("missing_evidence");
    expect(h.state.updates.length).toBe(0);
  });

  it("shadow-logs and completes ONLY with the explicit opt-out (=off) despite missing evidence", async () => {
    // Shadow mode is no longer the default (TEAM-3690); it requires an explicit
    // emergency opt-out. off|false|0 all disable enforcement; here we assert off.
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("missing evidence"))).toBe(true);
    expect(h.state.updates.length).toBe(1);
    warn.mockRestore();
  });

  it("completes when evidence is present (task output), flag ON", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "1";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "opened PR #12; head sha abc" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(h.state.updates.length).toBe(1);
  });

  it("accepts an artifactKey as evidence in place of output, flag ON", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "on";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "", artifactKey: "workflows/wf_1/shared/ship.md" } },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
  });

  it("cancelled children in a required phase owe no evidence, flag ON", async () => {
    // A cancelled ticket is finished-and-abandoned, not a phantom deliverable —
    // the evidence gate scopes to DONE tickets only (route: cancelled excluded).
    // Its empty task must NOT block completion even with the flag on.
    process.env.COMPLETION_EVIDENCE_REQUIRED = "true";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      // One cancelled ship ticket (no evidence) + one done ship ticket WITH
      // evidence, so phase (i)/(iii) integrity holds and only the cancellation
      // exemption is under test.
      agentTasks: {
        "T-5": { ticketId: "T-5", output: "" },
        "T-6": { ticketId: "T-6", output: "opened PR #34" },
      },
    };
    h.state.tickets = [
      { ticketId: "T-5", type: "task", status: "cancelled", phase: "ship", assignee: "rm" },
      { ticketId: "T-6", type: "task", status: "done", phase: "ship", assignee: "rm" },
    ];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(h.state.updates.length).toBe(1);
  });
});
