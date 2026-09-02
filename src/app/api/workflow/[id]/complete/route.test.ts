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

  // NOTE (TEAM-3747 D2): the tests below reach the SUCCESS path, so their ship
  // tickets must now also satisfy the merge-verdict gate — a done ship ticket with
  // only output/artifactKey no longer completes (that is the D2 divert, pinned in
  // its own describe). `mergeCommit` keeps the evidence gate the subject here.
  it("completes when evidence is present (task output), flag ON", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "1";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "opened PR #12; head sha abc", mergeCommit: "abc1234" } },
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
      agentTasks: {
        "T-4": { ticketId: "T-4", output: "", artifactKey: "workflows/wf_1/shared/ship.md", mergeCommit: "abc1234" },
      },
    };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete"); // the artifact satisfied the evidence gate
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
        "T-6": { ticketId: "T-6", output: "opened PR #34", mergeCommit: "abc1234" },
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

/**
 * TEAM-3747 D2 — the ship/CD merge-verdict gate on this route, PARITY with the
 * orchestrator's completeWorkflow + closeWorkflowBlocked. The manager toolkit's
 * `complete` intervention is the OTHER way a run can be closed green over
 * unshipped work, so the same rule applies here: a done ship ticket must carry a
 * merge/deploy verdict, and when it doesn't the route closes on the honest
 * terminal outcome (200 with status=outcome) rather than faking "complete".
 */
describe("POST complete — ship/CD merge-verdict gate (TEAM-3747 D2)", () => {
  const doneShipTicket = { ticketId: "T-4", type: "task", status: "done", phase: "ship", assignee: "rm" };
  const shipWorkflow = (ship: Record<string, unknown>) => ({
    workflowId: "wf_1",
    phase: "ship",
    workflowDefId: "software-delivery",
    agentTasks: { "T-4": { ticketId: "T-4", output: "release summary written", ...ship } },
  });
  // closeBlocked writes `#phase = :outcome`; the complete path writes
  // `#phase = :complete` (and closeBlocked also carries :complete as a CAS guard,
  // so :outcome must be checked first).
  const phaseOfUpdate = (u: Record<string, unknown>) => {
    const v = u.ExpressionAttributeValues as Record<string, unknown>;
    return v?.[":outcome"] ?? v?.[":complete"];
  };

  it("AC-D2.4: output but no merge verdict → closes static-ci-only, NOT complete", async () => {
    h.state.workflow = shipWorkflow({});
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    // 200 (the close succeeded) but the STATUS is the honest outcome.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("static-ci-only");
    expect(body.outcome).toBe("static-ci-only");
    expect(body.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "none" }]);
    expect(body.reason).toBeUndefined(); // no block was declared → nothing invented
    // The terminal write went to the blocked phase, guarded by the same CAS as the
    // complete write (including the two new terminal phases).
    expect(h.state.updates.length).toBe(1);
    expect(phaseOfUpdate(h.state.updates[0])).toBe("static-ci-only");
    const cond = String(h.state.updates[0].ConditionExpression);
    expect(cond).toContain("attribute_not_exists(cancelledAt)");
    expect(cond).toContain(":deployBlocked");
    expect(cond).toContain(":staticCi");
  });

  it("FR-D2.1: an explicit deploy block → closes deploy-blocked with the reason persisted", async () => {
    h.state.workflow = shipWorkflow({
      outcome: "deploy-blocked",
      blockReason: "required check cd/deploy-staging is failing — refusing to merge",
    });
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("deploy-blocked");
    expect(body.reason).toBe("required check cd/deploy-staging is failing — refusing to merge");
    expect(body.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "deploy-blocked" }]);
    expect(phaseOfUpdate(h.state.updates[0])).toBe("deploy-blocked");
    expect(String(h.state.updates[0].UpdateExpression)).toContain("blockReason = :reason");
    expect((h.state.updates[0].ExpressionAttributeValues as Record<string, unknown>)[":reason"]).toBe(
      "required check cd/deploy-staging is failing — refusing to merge"
    );
  });

  it("a merge commit completes normally — the gate only diverts phantoms", async () => {
    h.state.workflow = shipWorkflow({ mergeCommit: "9f1c2ab" });
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(h.state.updates.length).toBe(1);
    expect(phaseOfUpdate(h.state.updates[0])).toBe("complete");
  });

  it("explicit opt-out (=off): shadow-logs the would-be outcome and completes", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.workflow = shipWorkflow({});
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("would close as static-ci-only (shadow opt-out)"))
    ).toBe(true);
    warn.mockRestore();
  });

  it("fail-closed: an unrecognized flag value (\"banana\") still diverts", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "banana";
    h.state.workflow = shipWorkflow({});
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect((await res.json()).status).toBe("static-ci-only");
  });

  it("AC-D2.5: a legacy def with no ship phase is untouched — plain complete", async () => {
    h.state.def = { completionRequiresAgentPhases: ["development", "verification"] };
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "review",
      workflowDefId: "software-delivery",
      // Old-shape entry: no mergeCommit/outcome/blockReason keys at all.
      agentTasks: { "T-1": { ticketId: "T-1", output: "implemented" } },
    };
    h.state.tickets = [{ ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "dev" }];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(phaseOfUpdate(h.state.updates[0])).toBe("complete");
  });

  it("a run already closed deploy-blocked is terminal — 409 at the early guard, no write", async () => {
    // Idempotency parity with the orchestrator's claimTerminalOutcome: the D2
    // outcomes joined TERMINAL_PHASES, so a repeated manager `complete` on an
    // already-blocked run is refused up front instead of overwriting the verdict.
    h.state.workflow = { ...shipWorkflow({ mergeCommit: "9f1c2ab" }), phase: "deploy-blocked" };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Workflow already in terminal state");
    expect(body.phase).toBe("deploy-blocked");
    expect(h.state.updates.length).toBe(0);
  });

  it("static-ci-only is terminal too — 409, no write", async () => {
    h.state.workflow = { ...shipWorkflow({ mergeCommit: "9f1c2ab" }), phase: "static-ci-only" };
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).phase).toBe("static-ci-only");
    expect(h.state.updates.length).toBe(0);
  });

  it("a blocked close losing its CAS to a concurrent terminal write yields 409, not a fake close", async () => {
    h.state.workflow = shipWorkflow({});
    h.state.tickets = [doneShipTicket];
    h.state.updateError = "ConditionalCheckFailedException";
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Workflow already in terminal state");
    expect(h.state.updates.length).toBe(0);
  });
});
