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
    // TEAM-3976: completions/{ticketId}.json served by key; every GetObject key
    // recorded; s3Error (when set) makes every read throw it (non-NoSuchKey path).
    s3Objects: Record<string, string>;
    s3Gets: string[];
    s3Error: Error | null;
  } = {
    workflow: {}, tickets: [], def: {}, updates: [], updateError: null, workflowAfterFail: null,
    s3Objects: {}, s3Gets: [], s3Error: null,
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

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { input: { Key: string } }) {
      h.state.s3Gets.push(cmd.input.Key);
      if (h.state.s3Error) throw h.state.s3Error;
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class {
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

const SAVED = ["COMPLETION_EVIDENCE_REQUIRED", "TICKET_PROVIDER", "ARTIFACT_BUCKET"] as const;
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
  h.state.s3Objects = {};
  h.state.s3Gets.length = 0;
  h.state.s3Error = null;
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.TICKET_PROVIDER = "dynamodb";
  // TEAM-3976: the completions-record fallback is gated on ARTIFACT_BUCKET (read
  // at module load, so it must be set before every load()).
  process.env.ARTIFACT_BUCKET = "test-bucket";
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

/**
 * TEAM-3976 — the completions-record fallback on the evidence gate.
 *
 * The production failure: a dev ticket was mark_done'd (Workflow Manager) BEFORE
 * the agent's report_completion fired. The orchestrator's one-shot harvest found
 * no completions/T.json and left agentTasks[T] = {status:"complete"} with no
 * output; the later report_completion wrote the record but its done→done
 * transition was a no-op, so nothing re-harvested and this route 409'd forever.
 * Now the gate consults completions/{ticketId}.json for the would-be offenders
 * only, backfills the entry (field-scoped, existing-entry-only — the hand-port of
 * workflow-store.mjs mergeTaskMetadata), and completes. A missing/blank record or
 * a failed read keeps the 409 — never a 500, never a silent skip.
 */
describe("POST complete — completions-record fallback (TEAM-3976)", () => {
  const doneDevTicket = {
    ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "agentcore_hub_backend_dev",
  };
  const RECORD = JSON.stringify({
    ticket_id: "T-1",
    summary: "Fixed it",
    pr_url: "https://github.com/x/y/pull/1",
    commit_sha: "abc",
    branch: "feature/x",
    artifacts: "shared/dev-evidence/T-1.md",
  });
  const backfillUpdate = () =>
    h.state.updates.find((u) => u.ConditionExpression === "attribute_exists(agentTasks.#tid)");

  beforeEach(() => {
    h.state.def = { completionRequiresAgentPhases: ["development"] };
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "development",
      workflowDefId: "software-delivery",
      // mark_done landed first: complete, but no output/artifactKey.
      agentTasks: { "T-1": { ticketId: "T-1", status: "complete", completedAt: "2026-09-01T00:00:00Z" } },
    };
    h.state.tickets = [doneDevTicket];
  });

  it("record with summary+pr_url → 200, and agentTasks.T-1 is backfilled via a field-scoped UpdateCommand", async () => {
    h.state.s3Objects["completions/T-1.json"] = RECORD;
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.state.s3Gets).toEqual(["completions/T-1.json"]);
    const backfill = backfillUpdate();
    expect(backfill).toBeTruthy();
    expect(backfill!.TableName).toBe("agentcore-hub-workflows");
    expect(backfill!.Key).toEqual({ workflowId: "wf_1" });
    const names = backfill!.ExpressionAttributeNames as Record<string, string>;
    const values = backfill!.ExpressionAttributeValues as Record<string, unknown>;
    expect(names["#tid"]).toBe("T-1");
    const fieldNames = Object.entries(names).filter(([k]) => k !== "#tid").map(([, v]) => v).sort();
    expect(fieldNames).toEqual(["branch", "commitSha", "output", "prUrl"]);
    expect(Object.values(values)).toEqual(
      expect.arrayContaining(["Fixed it", "https://github.com/x/y/pull/1", "abc", "feature/x"])
    );
    expect(fieldNames).not.toContain("mergeCommit");
    expect(fieldNames).not.toContain("outcome");
    expect(String(backfill!.UpdateExpression)).toMatch(/^SET agentTasks\.#tid\.#f0 = :v0/);
    // The green completion write still happened after the backfill.
    expect(h.state.updates.length).toBe(2);
    expect(h.state.updates[1].ConditionExpression).toContain("#phase <>");
  });

  it("no record → 409 missing_evidence [{T-1, development}], nothing written", async () => {
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("missing_evidence");
    expect(body.tickets).toEqual([{ ticketId: "T-1", phase: "development" }]);
    expect(h.state.s3Gets).toEqual(["completions/T-1.json"]);
    expect(h.state.updates.length).toBe(0);
  });

  it("blank record (whitespace summary) → 409 — an empty record is not evidence (AC-D4.1)", async () => {
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ ticket_id: "T-1", summary: "   " });
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("missing_evidence");
    expect(h.state.updates.length).toBe(0);
  });

  it("S3 read throws a non-NoSuchKey error → still 409 (not 500, not a skipped check)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.s3Objects["completions/T-1.json"] = RECORD; // present, but unreadable
    h.state.s3Error = Object.assign(new Error("AccessDenied"), { name: "AccessDenied" });
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("missing_evidence");
    expect(h.state.updates.length).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence check skipped"))).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("read failed"))).toBe(true);
    warn.mockRestore();
  });

  it("happy path (entry already has output) → ZERO completions/ reads", async () => {
    h.state.workflow = {
      ...h.state.workflow,
      agentTasks: { "T-1": { ticketId: "T-1", status: "complete", output: "already harvested" } },
    };
    h.state.s3Objects["completions/T-1.json"] = RECORD;
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.state.s3Gets).toEqual([]);
    expect(h.state.updates.length).toBe(1); // only the green completion write
  });
});
