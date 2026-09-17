import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3619 D4a — the completion guard on POST /api/workflow/[id]/complete.
 *
 * Refusals layered on top of the existing no-bypass open-children gate:
 *   1. A cancelled run (cancelledAt stamped) can never be completed — 409
 *      workflow_cancelled, checked before anything else.
 *   2. required_phase_incomplete (409) — a completion-required phase with no
 *      done agent ticket is a structural gap; enforced regardless of the flag.
 *   3. Behind COMPLETION_EVIDENCE_REQUIRED (default ON — enforce): the ship/CD
 *      merge-verdict gate. A done ship ticket with no merge/deploy verdict does
 *      not fake "complete" — the route closes on the honest terminal outcome
 *      (deploy-blocked / static-ci-only). Fail-closed on any unrecognized value;
 *      only the explicit opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0
 *      shadow-logs the would-be outcome and completes.
 *
 * (The former per-ticket deliverable-evidence precondition was removed — an
 * agent's report_completion is now the sole definition of done.)
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
  } = {
    workflow: {}, tickets: [], def: {}, updates: [], updateError: null, workflowAfterFail: null,
  };
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

/**
 * TEAM-3755 F2 — the phase VALUES a terminal write's CAS refuses. Both terminal
 * writes on this route (the green complete and closeBlocked) now derive that
 * guard from ONE list (TERMINAL_PHASES), so the placeholders are positional
 * (:tp0…): assert which phases are refused, not how they are spelled.
 */
const refusedPhases = (update: Record<string, unknown>): string[] => {
  const values = (update.ExpressionAttributeValues as Record<string, unknown>) || {};
  const cond = String(update.ConditionExpression);
  return Object.entries(values)
    .filter(([key]) => cond.includes(`#phase <> ${key}`))
    .map(([, value]) => String(value))
    .sort();
};

/** All five phases a run can already be closed on (sorted, for comparison). */
const ALL_TERMINAL_PHASES = ["cancelled", "complete", "deploy-blocked", "error", "static-ci-only"];

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
  // A genuinely finished run: the def's one required phase ("ship", from
  // beforeEach) has a done agent ticket whose task carries output AND a merge
  // commit, so every upstream gate passes and these tests are about the terminal
  // write's CAS alone. It used to be an empty ticket list — TEAM-3755 F4 now
  // refuses that (a required phase with no done agent ticket never ran), so the
  // shortcut would 409 before reaching the write it means to exercise.
  const SHIPPED_TICKETS = [
    { ticketId: "T-4", type: "task", status: "done", phase: "ship", assignee: "rm" },
  ];
  const CLEAN_WF = {
    workflowId: "wf_1",
    phase: "ship",
    agentTasks: { "T-4": { ticketId: "T-4", output: "merged the release PR", mergeCommit: "9f1c2ab" } },
  };

  it("guards the terminal write with attribute_not_exists(cancelledAt)", async () => {
    h.state.workflow = { ...CLEAN_WF };
    h.state.tickets = [...SHIPPED_TICKETS];
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
    h.state.tickets = [...SHIPPED_TICKETS];
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
    h.state.tickets = [...SHIPPED_TICKETS];
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
    h.state.tickets = [...SHIPPED_TICKETS];
    h.state.updateError = "ProvisionedThroughputExceededException";
    await load();
    const res = await post();
    expect(res.status).toBe(500);
    error.mockRestore();
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
    expect(String(h.state.updates[0].ConditionExpression)).toContain(
      "attribute_not_exists(cancelledAt)"
    );
    expect(refusedPhases(h.state.updates[0])).toEqual(ALL_TERMINAL_PHASES);
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
      agentTasks: {
        "T-1": { ticketId: "T-1", output: "implemented" },
        "T-2": { ticketId: "T-2", output: "verified" },
      },
    };
    // Both required phases have a done agent ticket (TEAM-3755 F4) — the subject
    // here is the ABSENCE of a ship phase, not a missing phase.
    h.state.tickets = [
      { ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "dev" },
      { ticketId: "T-2", type: "task", status: "done", phase: "verification", assignee: "qa" },
    ];
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

  it("TEAM-3755 F1: a commit sha alone is NOT a merge verdict here either", async () => {
    // Parity with completion.mjs shipVerdictOf: commitSha is the unmerged branch
    // HEAD, harvested onto every ship record. Accepting it completed runs green
    // over work that never landed.
    h.state.workflow = shipWorkflow({ commitSha: "abc1234" });
    h.state.tickets = [doneShipTicket];
    await load();
    const res = await post();
    const body = await res.json();
    expect(body.status).toBe("static-ci-only");
    expect(body.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "none" }]);
  });
});

/**
 * TEAM-3755 F4 — structural parity with the orchestrator's isWorkflowComplete:
 * every required agent phase needs a DONE agent ticket. This route's only
 * structural gate was openChildren(), whose DONE_STATUSES counts "cancelled" as
 * closed — so a required phase whose ticket was CANCELLED had no open children,
 * produced no done ship ticket, and evaluateShipVerdict's "nothing to inspect"
 * branch returned green. The route completed runs the orchestrator twin refused.
 */
describe("POST complete — required-phase gate (TEAM-3755 F4)", () => {
  it("a cancelled-only required ship phase is refused — 409, no write, no fake blocked close", async () => {
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "" } },
    };
    h.state.tickets = [{ ticketId: "T-4", type: "task", status: "cancelled", phase: "ship", assignee: "rm" }];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("required_phase_incomplete");
    expect(body.phases).toEqual(["ship"]);
    expect(h.state.updates.length).toBe(0);
  });

  it("a required phase with NO ticket at all is refused, naming every unrun phase", async () => {
    h.state.def = { completionRequiresAgentPhases: ["development", "verification", "ship"] };
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "development",
      workflowDefId: "software-delivery",
      agentTasks: { "T-1": { ticketId: "T-1", output: "implemented" } },
    };
    h.state.tickets = [{ ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "dev" }];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).phases).toEqual(["verification", "ship"]);
    expect(h.state.updates.length).toBe(0);
  });

  it("a HUMAN gate ticket cannot satisfy a required agent phase (twin's isHuman rule)", async () => {
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-9": { ticketId: "T-9", output: "approved" } },
    };
    h.state.tickets = [
      { ticketId: "T-9", type: "task", status: "done", phase: "ship", assignee: "human:reviewer" },
    ];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("required_phase_incomplete");
  });

  it("enforced even with the evidence opt-out ON — it is a structural refusal, not a heuristic", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    h.state.workflow = { workflowId: "wf_1", phase: "ship", agentTasks: {} };
    h.state.tickets = [{ ticketId: "T-4", type: "task", status: "cancelled", phase: "ship", assignee: "rm" }];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("required_phase_incomplete");
    expect(h.state.updates.length).toBe(0);
  });

  it("a legacy def with no required phases is untouched (nothing to prove)", async () => {
    h.state.def = {};
    h.state.workflow = { workflowId: "wf_1", phase: "review", agentTasks: {} };
    h.state.tickets = [{ ticketId: "T-1", type: "task", status: "cancelled", phase: "development", assignee: "dev" }];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
  });
});

/**
 * TEAM-3755 F2 — the GREEN complete write must refuse the same five terminal
 * phases as closeBlocked. It listed only complete/error/cancelled by hand, so a
 * completion racing in behind an honest deploy-blocked / static-ci-only close
 * overwrote the blocked verdict with "complete".
 */
describe("POST complete — terminal-claim CAS parity (TEAM-3755 F2)", () => {
  it("the green complete write CASes off all five terminal phases", async () => {
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      agentTasks: { "T-4": { ticketId: "T-4", output: "merged", mergeCommit: "9f1c2ab" } },
    };
    h.state.tickets = [{ ticketId: "T-4", type: "task", status: "done", phase: "ship", assignee: "rm" }];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect(refusedPhases(h.state.updates[0])).toEqual(ALL_TERMINAL_PHASES);
  });
});
