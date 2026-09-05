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
    // TEAM-3991 D1.4: the cd-evidence listing (ListObjectsV2 on
    // workflows/<wf>/shared/cd-evidence/), the captured events-table rows, and a
    // switch that makes ONLY the tickets-table write fail (the epic roll-up).
    s3List: Array<{ Key: string; LastModified?: string }>;
    events: Array<Record<string, unknown>>;
    epicUpdateThrows: string | null;
  } = {
    workflow: {}, tickets: [], def: {}, updates: [], updateError: null, workflowAfterFail: null,
    s3Objects: {}, s3Gets: [], s3Error: null,
    s3List: [], events: [], epicUpdateThrows: null,
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
            // TEAM-3991 D1.4: the epic roll-up writes the TICKETS table; failing
            // only that one is how the roll-up-failure path is driven without
            // touching the workflow's terminal claim.
            if (h.state.epicUpdateThrows && cmd.input.TableName === "agentcore-hub-tickets") {
              throw new Error(h.state.epicUpdateThrows);
            }
            if (h.state.updateError) {
              if (h.state.workflowAfterFail) h.state.workflow = h.state.workflowAfterFail;
              const e = new Error("conditional check failed");
              e.name = h.state.updateError;
              throw e;
            }
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "PutCommand") {
            h.state.events.push(cmd.input.Item as Record<string, unknown>);
            return {};
          }
          return {};
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
    async send(cmd: { constructor: { name: string }; input: { Key: string } }) {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        if (h.state.s3Error) throw h.state.s3Error;
        return { Contents: h.state.s3List };
      }
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
  ListObjectsV2Command: class {
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

const SAVED = [
  "COMPLETION_EVIDENCE_REQUIRED", "TICKET_PROVIDER", "ARTIFACT_BUCKET", "EPIC_ROLLUP_BACKOFF_MS",
  // TEAM-3991 D1.3: the merge probe reads GITHUB_PAT at CALL time, so a suite can
  // turn the probe on and off without reloading the route module.
  "GITHUB_PAT",
] as const;
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
  h.state.s3List.length = 0;
  h.state.events.length = 0;
  h.state.epicUpdateThrows = null;
  for (const k of SAVED) saved[k] = process.env[k];
  // TEAM-3991 D1.4: no real sleeping between epic roll-up retries.
  process.env.EPIC_ROLLUP_BACKOFF_MS = "0";
  process.env.TICKET_PROVIDER = "dynamodb";
  // TEAM-3976: the completions-record fallback is gated on ARTIFACT_BUCKET (read
  // at module load, so it must be set before every load()).
  process.env.ARTIFACT_BUCKET = "test-bucket";
  delete process.env.COMPLETION_EVIDENCE_REQUIRED;
  // No PAT by default: every pre-D1.3 suite must keep behaving exactly as before,
  // which means the merge probe answers { merged: null } without a single fetch.
  delete process.env.GITHUB_PAT;
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

/**
 * TEAM-3991 D1.4 — the three honesty gaps this route shared with the
 * orchestrator, driven end-to-end:
 *
 *   1. wf sffzti DEPLOYED and closed `static-ci-only`. The release manager's
 *      report_completion tool has no outcome field, so the only record of the
 *      deploy is the `cd-evidence/deploy-*.md` file it wrote — unread until now.
 *   2. wf 1pl3h1 closed `complete` while escalation gate TEAM-3757 sat in_review
 *      over an unmerged PR. Its "PREFLIGHT BLOCKED" cd-evidence file went unread
 *      too, and no close ever named the gate a human still owed a decision to.
 *   3. wf 7ef4fp closed `complete` with its epic left in In Progress: the epic
 *      roll-up was a separate best-effort write after the terminal claim, so a
 *      failure (or a crash) left the run complete with nobody responsible for the
 *      board. The obligation is now created ATOMICALLY with the terminal claim
 *      (epicRollupPending) and only cleared once the epic really moved.
 */
describe("POST complete — CD evidence, open gates, atomic epic roll-up (TEAM-3991 D1.4)", () => {
  const EPIC = "TEAM-3990";
  const CD_KEY = "workflows/wf_1/shared/cd-evidence/deploy-20260905T0100Z.md";
  const shipTicket = {
    ticketId: "T-4", type: "task", status: "done", phase: "ship",
    assignee: "agentcore_hub_release_manager",
  };
  const shipRun = (ship: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    workflowId: "wf_1",
    phase: "ship",
    workflowDefId: "software-delivery",
    epicId: EPIC,
    agentTasks: { "T-4": { ticketId: "T-4", output: "release summary written", ...ship } },
    ...extra,
  });
  const seedCd = (body: string, key = CD_KEY, LastModified = "2026-09-05T01:00:00Z") => {
    h.state.s3List.push({ Key: key, LastModified });
    h.state.s3Objects[key] = body;
  };
  const find = (pred: (u: Record<string, unknown>) => boolean) => h.state.updates.find(pred);
  const epicUpdate = () => find((u) => u.TableName === "agentcore-hub-tickets");
  const terminalUpdate = () => find((u) => String(u.ConditionExpression).includes("#phase <>"));
  const rollupCleared = () => find((u) => String(u.UpdateExpression) === "REMOVE epicRollupPending");
  const cdStamp = () =>
    find(
      (u) =>
        u.ConditionExpression === "attribute_exists(agentTasks.#tid)" &&
        Object.values((u.ExpressionAttributeNames as Record<string, string>) || {}).includes("outcome")
    );

  describe("manager-supplied evidence satisfies the deliverable gate (D1.3)", () => {
    const doneDevTicket = {
      ticketId: "T-1", type: "task", status: "done", phase: "development",
      assignee: "agentcore_hub_backend_dev",
    };
    beforeEach(() => {
      h.state.def = { completionRequiresAgentPhases: ["development"] };
      h.state.tickets = [doneDevTicket];
    });

    it("evidence a human pasted in via mark_done (evidenceSource:manager, output only) is real evidence — no 409, no S3 read", async () => {
      // The mark-done route writes output+evidenceSource:"manager" and nothing
      // else — no branch, no commit, no PR (that is the whole point: a human is
      // vouching). The gate must accept it exactly like an agent's own output,
      // otherwise the run it just unblocked can never close.
      h.state.workflow = {
        workflowId: "wf_1",
        phase: "development",
        workflowDefId: "software-delivery",
        agentTasks: {
          "T-1": {
            ticketId: "T-1", status: "complete",
            output: "Verified by hand: endpoints live, screenshots in the ticket.",
            evidenceSource: "manager", markedDoneBy: "alice@example.com",
          },
        },
      };
      await load();
      const res = await post();
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("complete");
      expect(h.state.s3Gets).toEqual([]); // the happy path never reads S3
      expect(h.state.updates.length).toBe(1);
    });

    it("a manager-written completions record (source:\"manager\") is re-harvested rather than 409'd", async () => {
      // mark_done wrote the record but the agentTasks entry predates it (the run
      // was closed out-of-band). source is "manager", not "agent" — accepted:
      // what matters is that the record carries evidence, not who typed it.
      h.state.workflow = {
        workflowId: "wf_1",
        phase: "development",
        workflowDefId: "software-delivery",
        agentTasks: { "T-1": { ticketId: "T-1", status: "complete" } },
      };
      h.state.s3Objects["completions/T-1.json"] = JSON.stringify({
        source: "manager",
        ticket_id: "T-1",
        summary: "Verified by hand — merged in PR #274.",
        pr_url: "https://github.com/x/y/pull/274",
        marked_done_by: "alice@example.com",
      });
      await load();
      const res = await post();
      expect(res.status).toBe(200);
      expect(h.state.s3Gets).toEqual(["completions/T-1.json"]);
      const backfill = find((u) => u.ConditionExpression === "attribute_exists(agentTasks.#tid)");
      expect(backfill).toBeTruthy();
      const fields = Object.entries((backfill!.ExpressionAttributeNames as Record<string, string>) || {})
        .filter(([k]) => k !== "#tid")
        .map(([, v]) => v)
        .sort();
      expect(fields).toEqual(["output", "prUrl"]);
      // SECURITY: a re-harvest never invents a merge verdict or an outcome.
      expect(fields).not.toContain("mergeCommit");
      expect(fields).not.toContain("outcome");
    });
  });

  describe("cd-evidence gives the ship verdict a voice", () => {
    beforeEach(() => {
      // The suites above delete ARTIFACT_BUCKET in their afterEach and the bucket
      // is read at module load — re-assert it before every load() here, or the
      // whole cd-evidence harvest is inert.
      process.env.ARTIFACT_BUCKET = "test-bucket";
      h.state.tickets = [shipTicket];
    });

    it("wf sffzti: \"# DEPLOY SUCCEEDED\" turns a verdict-less ship ticket into outcome=deployed and closes GREEN", async () => {
      h.state.workflow = shipRun({}); // no mergeCommit, no outcome — static-ci-only before D1.4
      seedCd("# DEPLOY SUCCEEDED - staging + prod\n\nCodeBuild agentcore-hub-deploy #41 green.");
      await load();
      const res = await post();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("complete");
      // The run REPORTS what it actually did — not the CI-only default.
      expect(body.outcome).toBe("deployed");
      expect(body.epicRolledUp).toBe(true);
      // The verdict is durable on the ship task, scoped to the existing entry.
      const stamp = cdStamp();
      expect(stamp).toBeTruthy();
      expect((stamp!.ExpressionAttributeNames as Record<string, string>)["#tid"]).toBe("T-4");
      expect(Object.values(stamp!.ExpressionAttributeValues as Record<string, unknown>)).toEqual(
        expect.arrayContaining(["deployed", CD_KEY])
      );
      // …and the terminal event carries it, so a workflow.complete consumer can
      // tell a deployed run from a merged-but-undeployed one.
      const complete = h.state.events.find((e) => e.type === "workflow.complete");
      expect((complete!.detail as Record<string, unknown>).outcome).toBe("deployed");
      expect((complete!.detail as Record<string, unknown>).epicRolledUp).toBe(true);
    });

    it("newest cd-evidence file wins (a re-run supersedes an earlier blocked attempt)", async () => {
      h.state.workflow = shipRun({});
      seedCd(
        "# PREFLIGHT BLOCKED: PR #274 is not merged",
        "workflows/wf_1/shared/cd-evidence/deploy-20260904T0900Z.md",
        "2026-09-04T09:00:00Z"
      );
      seedCd("# DEPLOY SUCCEEDED - after the merge landed");
      await load();
      const res = await post();
      expect((await res.json()).outcome).toBe("deployed");
      expect(h.state.s3Gets).toEqual([CD_KEY]); // only the newest file is read
    });

    it("wf 1pl3h1's unread file: \"# PREFLIGHT BLOCKED\" closes deploy-blocked with the reason — and the epic is NOT rolled up", async () => {
      h.state.workflow = shipRun({});
      seedCd("# PREFLIGHT BLOCKED: PR #274 is not merged\n\nRefusing to deploy an unmerged branch.");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await load();
      const res = await post();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("deploy-blocked");
      expect(body.reason).toContain("PR #274 is not merged");
      // The work did not ship, so the board must not say it did.
      expect(epicUpdate()).toBeUndefined();
      expect(h.state.events.some((e) => e.type === "workflow.complete")).toBe(false);
      expect(h.state.events.some((e) => e.type === "workflow.deploy_blocked")).toBe(true);
      error.mockRestore();
    });

    it("an unparseable cd-evidence file changes nothing — the pre-D1.4 verdict stands", async () => {
      h.state.workflow = shipRun({});
      seedCd("# CD run log\n\nramping traffic, nothing decided yet");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await load();
      const res = await post();
      const body = await res.json();
      expect(body.status).toBe("static-ci-only");
      expect(body.outcome).toBe("static-ci-only");
      expect(cdStamp()).toBeUndefined(); // no verdict ⇒ nothing stamped
      error.mockRestore();
    });

    it("a ship ticket that already reported an outcome is never re-judged by S3", async () => {
      h.state.workflow = shipRun({ outcome: "shipped", mergeCommit: "9f1c2ab" });
      seedCd("# PREFLIGHT BLOCKED: stale file from an earlier attempt");
      await load();
      const res = await post();
      expect((await res.json()).status).toBe("complete");
      expect(h.state.s3Gets).toEqual([]); // never listed, never read
    });
  });

  describe("an open human gate forbids a green close (wf 1pl3h1)", () => {
    it("escalation TEAM-3757 sitting in_review is REFUSED and named — the run never closes complete", async () => {
      // Belt and braces: this route's open-children gate fires first (it counts an
      // in_review human ticket as open, where the orchestrator's structural check
      // only looks at agent phases — which is exactly how 1pl3h1 slipped through
      // there). Either way the contract asserted here is the same: no green close,
      // and the response NAMES the ticket the human still owes a decision to.
      // openGateOf() then backs the same rule up inside the ship ladder.
      h.state.workflow = shipRun({ mergeCommit: "9f1c2ab" });
      h.state.tickets = [
        shipTicket,
        {
          ticketId: "TEAM-3757", type: "task", status: "in_review",
          assignee: "human:reviewer@example.com",
          title: "Escalation #1: ship-review not converging",
        },
      ];
      await load();
      const res = await post();

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.openTickets).toEqual([
        { ticketId: "TEAM-3757", status: "in_review", title: "Escalation #1: ship-review not converging" },
      ]);
      // Nothing was written and nothing was announced.
      expect(h.state.updates).toEqual([]);
      expect(h.state.events).toEqual([]);
    });

    it("the same gate DONE lets the run close green (control)", async () => {
      h.state.workflow = shipRun({ mergeCommit: "9f1c2ab" });
      h.state.tickets = [
        shipTicket,
        { ticketId: "TEAM-3757", type: "task", status: "done", assignee: "human:reviewer@example.com", title: "Merge Approval" },
      ];
      await load();
      const res = await post();
      expect((await res.json()).status).toBe("complete");
    });
  });

  describe("atomic epic roll-up (wf 7ef4fp)", () => {
    beforeEach(() => {
      h.state.tickets = [shipTicket];
      h.state.workflow = shipRun({ mergeCommit: "9f1c2ab" });
    });

    it("the roll-up obligation is created in the SAME write as the terminal claim, then discharged and cleared", async () => {
      await load();
      const res = await post();

      expect(res.status).toBe(200);
      expect((await res.json()).epicRolledUp).toBe(true);
      // 1. One write claims the run AND records who owes the board a transition.
      const terminal = terminalUpdate()!;
      expect(String(terminal.UpdateExpression)).toContain("epicRollupPending = :pending");
      expect((terminal.ExpressionAttributeValues as Record<string, unknown>)[":pending"]).toBe(true);
      expect(refusedPhases(terminal)).toEqual(ALL_TERMINAL_PHASES);
      // 2. The epic really moved (tickets table, scoped write — NOT the workflows
      //    table, so the single-writer rule is intact).
      const epic = epicUpdate()!;
      expect(epic.Key).toEqual({ ticketId: EPIC });
      expect((epic.ExpressionAttributeValues as Record<string, unknown>)[":s"]).toBe("done");
      // 3. Only then is the obligation discharged, guarded on its own existence.
      const cleared = rollupCleared()!;
      expect(cleared.ConditionExpression).toBe("attribute_exists(epicRollupPending)");
      expect(h.state.updates.indexOf(cleared)).toBeGreaterThan(h.state.updates.indexOf(epic));
    });

    it("a run with no epic neither claims nor clears the flag (no vacuous write)", async () => {
      const noEpic = shipRun({ mergeCommit: "9f1c2ab" }) as Record<string, unknown>;
      delete noEpic.epicId;
      h.state.workflow = noEpic;
      await load();
      const res = await post();
      expect((await res.json()).epicRolledUp).toBe(false);
      expect(h.state.updates.length).toBe(1);
      expect(String(h.state.updates[0].UpdateExpression)).not.toContain("epicRollupPending");
    });

    it("a failing roll-up LEAVES epicRollupPending set, announces workflow.epic_rollup_failed, and still completes the run", async () => {
      // The delivery is real — the run must not be un-completed because a board
      // write failed. But the flag stays, so the sweep retries and no human has to
      // notice the epic silently stuck in In Progress (the 7ef4fp failure).
      h.state.epicUpdateThrows = "ProvisionedThroughputExceededException";
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await load();
      const res = await post();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("complete");
      expect(body.epicRolledUp).toBe(false);
      expect(rollupCleared()).toBeUndefined(); // the obligation is still outstanding
      const failure = h.state.events.find((e) => e.type === "workflow.epic_rollup_failed");
      expect(failure).toBeTruthy();
      expect(failure!.detail).toMatchObject({ workflowId: "wf_1", epicId: EPIC, attempts: 3 });
      expect(String((failure!.detail as Record<string, unknown>).lastError)).toContain(
        "ProvisionedThroughputExceeded"
      );
      // …and the completion event says so too, rather than implying a clean close.
      const complete = h.state.events.find((e) => e.type === "workflow.complete");
      expect((complete!.detail as Record<string, unknown>).epicRolledUp).toBe(false);
      // It retried before giving up (3 attempts, one warn each).
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("roll-up attempt")).length).toBe(3);
      error.mockRestore();
      warn.mockRestore();
    });
  });
});

/**
 * TEAM-3991 D1.3 — the GitHub merge probe on the complete route (parity with the
 * orchestrator's SHIP_MERGE_VERIFY gate).
 *
 * The release manager's report_completion tool has no merge_commit field, so a
 * merged-and-deployed run's self-reported ship verdict can NEVER read "shipped"
 * (commitSha is the branch HEAD, deliberately not proof). Before this, the route
 * closed every such run static-ci-only — and could not tell it apart from a run
 * whose branch was never merged at all.
 *
 * The probe runs on the REAL module over a stubbed global fetch (no vi.mock of
 * merge-probe.ts), so the URL shape, the merged_at-only reduction and the
 * fail-open behaviour are all exercised end to end.
 */
describe("POST complete — GitHub merge probe (TEAM-3991 D1.3)", () => {
  const EPIC = "TEAM-3990";
  const shipTicket = {
    ticketId: "T-4", type: "task", status: "done", phase: "ship",
    assignee: "agentcore_hub_release_manager",
  };
  /** A run whose ship ticket is done with output but NO merge/deploy verdict. */
  const shipRun = (ship: Record<string, unknown> = {}) => ({
    workflowId: "wf_1",
    phase: "ship",
    workflowDefId: "software-delivery",
    epicId: EPIC,
    featureBranch: "feature/TEAM-3991",
    repoConfig: { repos: [{ url: "https://github.com/acme/widgets.git", defaultBranch: "main" }] },
    agentTasks: { "T-4": { ticketId: "T-4", output: "release summary written", ...ship } },
  });

  let fetchCalls: string[] = [];
  /** Stub api.github.com: `routes` maps a path substring → JSON body. */
  const stubGitHub = (routes: Array<[string, unknown]>) => {
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(String(url));
      const hit = routes.find(([frag]) => String(url).includes(frag));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hit[1] };
    });
  };
  const mergeStamp = () =>
    h.state.updates.find(
      (u) =>
        u.ConditionExpression === "attribute_exists(agentTasks.#tid)" &&
        Object.values((u.ExpressionAttributeNames as Record<string, string>) || {}).includes("mergeVerifiedBy")
    );
  const stampedFields = (u: Record<string, unknown>) =>
    Object.entries((u.ExpressionAttributeNames as Record<string, string>) || {})
      .filter(([k]) => k !== "#tid")
      .map(([, v]) => v)
      .sort();

  beforeEach(() => {
    process.env.ARTIFACT_BUCKET = "test-bucket";
    process.env.GITHUB_PAT = "ghp_test";
    h.state.tickets = [shipTicket];
    fetchCalls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merged PR → mergeCommit + mergeVerifiedBy stamped, and the run closes GREEN", async () => {
    h.state.workflow = shipRun();
    stubGitHub([
      ["/pulls?head=", [{ merged_at: "2026-09-05T01:00:00Z", merge_commit_sha: "9f1c2ab", html_url: "https://github.com/acme/widgets/pull/274" }]],
    ]);
    await load();
    const res = await post();

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    const stamp = mergeStamp();
    expect(stamp).toBeTruthy();
    expect((stamp!.ExpressionAttributeNames as Record<string, string>)["#tid"]).toBe("T-4");
    expect(stampedFields(stamp!)).toEqual(["mergeCommit", "mergeVerifiedBy", "prUrl"]);
    expect(Object.values(stamp!.ExpressionAttributeValues as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["9f1c2ab", "github", "https://github.com/acme/widgets/pull/274"])
    );
    // One list call answers it — compare is only asked when no PR has merged.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/repos/acme/widgets/pulls?head=acme%3Afeature%2FTEAM-3991&state=all&per_page=20");
  });

  it("compare says behind → merged with the base sha as proof (a squash merge leaves no merged PR)", async () => {
    h.state.workflow = shipRun();
    stubGitHub([
      ["/pulls?head=", [{ state: "closed", merge_commit_sha: "test-merge-sha" }]], // never merged
      ["/compare/", { status: "behind", base_commit: { sha: "base9" } }],
    ]);
    await load();
    const res = await post();

    expect((await res.json()).status).toBe("complete");
    expect(Object.values(mergeStamp()!.ExpressionAttributeValues as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["base9", "github"])
    );
    // No prUrl to stamp in this shape — only what GitHub actually proved.
    expect(stampedFields(mergeStamp()!)).toEqual(["mergeCommit", "mergeVerifiedBy"]);
    expect(fetchCalls).toHaveLength(2);
  });

  it("compare says ahead → PROVABLY unmerged: honest blocked close naming the branch, no stamp", async () => {
    h.state.workflow = shipRun();
    stubGitHub([
      ["/pulls?head=", []],
      ["/compare/", { status: "ahead", ahead_by: 4 }],
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await load();
    const res = await post();

    const body = await res.json();
    expect(body.status).toBe("static-ci-only");
    expect(body.reason).toContain("not merged");
    expect(body.reason).toContain("4 commit(s) ahead of main");
    expect(mergeStamp()).toBeUndefined();
    // The work did not ship, so the epic must not be rolled up.
    expect(h.state.updates.find((u) => u.TableName === "agentcore-hub-tickets")).toBeUndefined();
    expect(h.state.events.some((e) => e.type === "workflow.complete")).toBe(false);
    error.mockRestore();
  });

  it("GitHub unreachable → merged:null, self-reported evidence decides exactly as before", async () => {
    h.state.workflow = shipRun();
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await load();
    const res = await post();

    // Unchanged pre-D1.3 outcome: nothing recorded a ship, so static-ci-only.
    expect((await res.json()).status).toBe("static-ci-only");
    expect(mergeStamp()).toBeUndefined(); // an unreachable API proves nothing
    error.mockRestore();
    warn.mockRestore();
  });

  it("no PAT → no probe at all (not one fetch), verdict untouched", async () => {
    delete process.env.GITHUB_PAT;
    h.state.workflow = shipRun();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await load();
    const res = await post();

    expect((await res.json()).status).toBe("static-ci-only");
    expect(fetchCalls).toEqual([]);
    error.mockRestore();
  });

  it("SECURITY: a recorded BLOCK is never overwritten by a merge proof", async () => {
    // A merge does not un-block a deploy-blocked ticket. The offender already said
    // something, so it is skipped by the stamp and its blockReason survives.
    h.state.workflow = shipRun({ outcome: "deploy-blocked", blockReason: "smoke tests failed in prod" });
    stubGitHub([["/pulls?head=", [{ merged_at: "x", merge_commit_sha: "9f1c2ab", html_url: "u" }]]]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await load();
    const res = await post();

    const body = await res.json();
    expect(body.status).toBe("deploy-blocked");
    expect(body.reason).toContain("smoke tests failed in prod");
    expect(mergeStamp()).toBeUndefined();
    error.mockRestore();
  });

  it("a ship ticket that already proved its merge is never probed", async () => {
    h.state.workflow = shipRun({ mergeCommit: "already-proven" });
    await load();
    const res = await post();
    expect((await res.json()).status).toBe("complete");
    expect(fetchCalls).toEqual([]); // the probe only runs when the verdict is short
  });

  it("no repoConfig → no probe, and never a false 'unmerged' (nothing to probe proves nothing)", async () => {
    const { repoConfig, ...noRepo } = shipRun();
    void repoConfig;
    h.state.workflow = noRepo;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await load();
    const res = await post();
    expect((await res.json()).status).toBe("static-ci-only");
    expect(fetchCalls).toEqual([]);
    error.mockRestore();
  });
});
