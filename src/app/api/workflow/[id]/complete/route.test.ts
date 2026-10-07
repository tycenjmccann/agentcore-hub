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
    // TEAM-5358 FR-1: every done gate-class ticket must be backed by a record its
    // owner wrote. When on (the default), a key not in s3Objects is synthesized for
    // each done roster ticket: an agent ticket gets a completions record written by
    // its assignee, a human gate a signed v3 decision record. The FR-1/FR-2 tests
    // turn it off and seed s3Objects themselves.
    autoGateRecords: boolean;
    events: Array<Record<string, unknown>>;
  } = {
    workflow: {}, tickets: [], def: {}, updates: [], updateError: null, workflowAfterFail: null,
    s3Objects: {}, s3Gets: [], s3Error: null, autoGateRecords: true, events: [],
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
    async send(cmd: { input: { Entries?: Array<{ Detail?: string }> } }) {
      for (const e of cmd.input.Entries || []) h.state.events.push(JSON.parse(e.Detail || "{}"));
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
      const body = h.state.s3Objects[cmd.input.Key] ?? (h.state.autoGateRecords ? await autoRecord(cmd.input.Key) : undefined);
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

/** The record a gate's owner would have written for `key`, or undefined (see autoGateRecords). */
async function autoRecord(key: string): Promise<string | undefined> {
  const completion = /^completions\/(.+)\.json$/.exec(key);
  const decision = /^pipeline-artifacts\/gate-decisions\/([^/]+)\/gates\/(.+)\.json$/.exec(key);
  const id = completion?.[1] ?? decision?.[2];
  const t = h.state.tickets.find((x) => x.ticketId === id && x.status === "done");
  if (!t) return undefined;
  const human = String(t.assignee || "").startsWith("human:") || (Array.isArray(t.labels) && t.labels.includes("human-review"));
  if (completion && !human) {
    return JSON.stringify({ ticket_id: id, summary: "gate ran", agent_id: t.assignee, workflowId: h.state.workflow.workflowId });
  }
  if (decision && human) return JSON.stringify(await signedDecision(decision[1], String(id)));
  return undefined;
}

const TEST_DECISION_KEY = "complete-route-test-gate-decision-key";

async function signedDecision(workflowId: string, ticketId: string, over: Record<string, unknown> = {}, key = TEST_DECISION_KEY) {
  const { canonicalJson, signVerifyRecord } = await import("@/lib/workflow/decision-contract");
  const unsigned = {
    v: 3,
    ticketId,
    workflowId,
    kind: "gate-decision",
    status: "done",
    decision: { option: "approve", override: false, channel: "hub", by: "eng@example.com" },
    decidedAt: "2026-10-01T00:00:00Z",
    scope: null,
    cycle: null,
    labels: [],
    ...over,
  };
  return { ...unsigned, sig: signVerifyRecord([canonicalJson(unsigned)], key) };
}

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
// DL-036: a gate decision stands only for the gate's live cycle. By default every
// gate reads as cycle null + no scope (what a fresh v3 record carries); h.live overrides.
const live = vi.hoisted(() => ({ map: {} as Record<string, { cycle?: string | null } | null> }));
vi.mock("@/lib/workflow/gate-live", () => ({
  liveGate: vi.fn(async (ticketId: string) => {
    if (ticketId in live.map) {
      const l = live.map[ticketId];
      return l ? { ticketId, cycle: l.cycle, scope: null } : null;
    }
    return { ticketId, cycle: null, scope: null };
  }),
}));

let POST: typeof import("./route").POST;

const SAVED = ["COMPLETION_EVIDENCE_REQUIRED", "TICKET_PROVIDER", "ARTIFACT_BUCKET", "GATE_DECISION_KEY", "AUTH_MODE"] as const;
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
  h.state.autoGateRecords = true;
  h.state.events.length = 0;
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.GATE_DECISION_KEY = TEST_DECISION_KEY;
  delete process.env.AUTH_MODE;
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

function post(id = "wf_1", headers: Record<string, string> = {}) {
  return POST(new NextRequest(`http://localhost/api/workflow/${id}/complete`, { method: "POST", body: "{}", headers }), {
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

  it("a done HUMAN gate stamped phase:<required> with no agentTask is NOT missing evidence (hub-materialized Merge Approval)", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "true";
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "ship",
      workflowDefId: "software-delivery",
      agentTasks: { "T-4": { ticketId: "T-4", output: "merged #578" } },
    };
    h.state.tickets = [
      doneShipTicket,
      { ticketId: "G-1", type: "task", status: "done", phase: "ship", assignee: "human:engineer", labels: ["human-review", "phase:ship"] },
    ];
    await load();
    const res = await post();
    const body = await res.json();
    expect(body.error).not.toBe("missing_evidence");
    expect(res.status).not.toBe(409);
  });

  it("409 missing_evidence when the flag is ON and a done ship ticket has an empty task", async () => {
    h.state.autoGateRecords = false; // no record anywhere: the empty task is the subject
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
    h.state.autoGateRecords = false; // no record anywhere: the empty task is the subject
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
    h.state.autoGateRecords = false; // no record anywhere: the empty task is the subject
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
    // TEAM-5358 FR-1: the opt-out covers agent-work phases only; a gate-class
    // ticket is never shadowed (pinned below), so this uses a development ticket.
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    h.state.autoGateRecords = false;
    h.state.def = { completionRequiresAgentPhases: ["development"] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "development",
      workflowDefId: "software-delivery",
      agentTasks: { "T-1": { ticketId: "T-1", output: "" } },
    };
    h.state.tickets = [{ ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "agentcore_hub_backend_dev" }];
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("missing evidence"))).toBe(true);
    expect(h.state.updates.length).toBe(1);
    warn.mockRestore();
  });

  // TEAM-5369: the missing-evidence fallback applies the same ownership rule as the
  // orchestrator's resolver (completion-evidence-parity.test.ts pins the two), so a
  // non-gate-class ticket cannot close on a record its assignee did not write.
  it.each([
    ["another agent's record", { agent_id: "not-the-assignee" }, 409],
    ["the assignee's own record", { agent_id: "agentcore_hub_backend_dev" }, 200],
    ["a legacy record naming no agent", {}, 200],
  ])("missing evidence resolved from %s -> %s", async (_label, identity, status) => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "1";
    h.state.autoGateRecords = false;
    h.state.def = { completionRequiresAgentPhases: ["development"] };
    h.state.workflow = {
      workflowId: "wf_1",
      phase: "development",
      workflowDefId: "software-delivery",
      agentTasks: { "T-1": { ticketId: "T-1", output: "" } },
    };
    h.state.tickets = [{ ticketId: "T-1", type: "task", status: "done", phase: "development", assignee: "agentcore_hub_backend_dev" }];
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ ticket_id: "T-1", summary: "did it", ...identity });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await load();
    const res = await post();
    expect(res.status).toBe(status);
    if (status === 409) expect((await res.json()).error).toBe("missing_evidence");
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
    expect(h.state.s3Gets.filter((k) => k.startsWith("completions/"))).toEqual(["completions/T-1.json"]);
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
    h.state.autoGateRecords = false; // no record anywhere: the empty task is the subject
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("missing_evidence");
    expect(body.tickets).toEqual([{ ticketId: "T-1", phase: "development" }]);
    expect(h.state.s3Gets.filter((k) => k.startsWith("completions/"))).toEqual(["completions/T-1.json"]);
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
    expect(h.state.s3Gets.filter((k) => k.startsWith("completions/T-1"))).toEqual([]);
    expect(h.state.updates.length).toBe(1); // only the green completion write
  });
});

/**
 * TEAM-5358 FR-1 / FR-2 / F4 / F8 — the close-out predicates. FR-1: every done
 * gate-class ticket is backed by a record its owner wrote (409 open_gates).
 * FR-2: a run that was refused before (a notif_completion_* notice on the row)
 * or that has offenders now completes only under a verified closeout override
 * naming every offender (409 completion_blocked). F8: closedBy is the verified
 * identity, the self-declared x-hub-caller is kept apart as claimedCaller.
 */
describe("POST complete — close-out integrity (TEAM-5358)", () => {
  const SHIP = { ticketId: "S-1", type: "task", status: "done", phase: "ship", assignee: "agentcore_hub_release_manager" };
  const CI = { ticketId: "C-1", type: "task", status: "done", phase: "review", assignee: "agentcore_hub_ci_agent" };
  const SEC = { ticketId: "SR-1", type: "task", status: "done", phase: "design", assignee: "agentcore_hub_security_reviewer" };
  const GATE = { ticketId: "G-1", type: "task", status: "done", phase: "ship", assignee: "human:engineer", labels: ["human-review"] };
  const SHIPPED = { "S-1": { ticketId: "S-1", output: "merged #9", mergeCommit: "a".repeat(40) } };
  const NOTICE = { id: "notif_completion_blocked_wf_1", type: "completion_blocked", acknowledged: false };
  const record = (t: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ticket_id: t.ticketId, summary: "ran", agent_id: t.assignee, ...over });

  beforeEach(() => {
    live.map = {};
    h.state.autoGateRecords = false;
    h.state.workflow = { workflowId: "wf_1", phase: "ship", workflowDefId: "software-delivery", agentTasks: SHIPPED };
    h.state.s3Objects["completions/S-1.json"] = record(SHIP);
  });

  async function override(offenders: string[], over: Record<string, unknown> = {}, key = TEST_DECISION_KEY) {
    const { buildCloseoutOverride, CLOSEOUT_OVERRIDE_KEY } = await import("@/lib/workflow/closeout-override");
    const rec = { ...buildCloseoutOverride({ workflowId: "wf_1", by: "eng@example.com", reason: "known gap", offenders }, key), ...over };
    h.state.s3Objects[CLOSEOUT_OVERRIDE_KEY("wf_1")] = JSON.stringify(rec);
  }

  it("open_gates: a done CI ticket without a completions record -> 409 with offenders, nothing written", async () => {
    h.state.tickets = [SHIP, CI];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("open_gates");
    expect(body.offenders).toEqual([{ ticketId: "C-1", title: "", phase: "review", assignee: "agentcore_hub_ci_agent", why: "no_record" }]);
    expect(body.overridePresent).toBe(false);
    expect(h.state.updates.length).toBe(0);
  });

  it("open_gates: a record written by the workflow-manager does not satisfy a gate-class ticket (F4)", async () => {
    h.state.tickets = [SHIP, CI];
    h.state.s3Objects["completions/C-1.json"] = record(CI, { source: "workflow-manager", agent_id: undefined });
    await load();
    const body = await (await post()).json();
    expect(body.error).toBe("open_gates");
    expect(body.offenders[0]).toMatchObject({ ticketId: "C-1", why: "console_record" });
  });

  it("open_gates: a record whose agent_id differs from the assignee is an offender", async () => {
    h.state.tickets = [SHIP, CI];
    h.state.s3Objects["completions/C-1.json"] = record(CI, { agent_id: "agentcore_hub_backend_dev" });
    await load();
    const body = await (await post()).json();
    expect(body.offenders).toEqual([expect.objectContaining({ ticketId: "C-1", why: "agent_mismatch" })]);
  });

  it("open_gates: the security reviewer is gate-class although its phase is design (F7)", async () => {
    h.state.tickets = [SHIP, SEC];
    await load();
    const body = await (await post()).json();
    expect(body.error).toBe("open_gates");
    expect(body.offenders.map((o: { ticketId: string }) => o.ticketId)).toEqual(["SR-1"]);
  });

  it("the assignee's own record satisfies every agent gate -> 200", async () => {
    h.state.tickets = [SHIP, CI, SEC];
    h.state.s3Objects["completions/C-1.json"] = record(CI);
    h.state.s3Objects["completions/SR-1.json"] = record(SEC);
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
  });

  it("a legacy record (no agent identity, not the console's) completes with warnings[] on the response, event and log", async () => {
    h.state.tickets = [SHIP, CI];
    h.state.s3Objects["completions/C-1.json"] = JSON.stringify({ ticket_id: "C-1", summary: "ran", pr_url: "https://x/pull/1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("complete");
    expect(body.warnings).toEqual([expect.objectContaining({ ticketId: "C-1", why: "legacy_no_agent_id" })]);
    expect(h.state.events.at(-1)).toMatchObject({ warnings: [expect.objectContaining({ ticketId: "C-1" })] });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("C-1:legacy_no_agent_id"))).toBe(true);
    warn.mockRestore();
  });

  it("a legacy record from the console is not legacy-accepted: 409 open_gates console_record", async () => {
    h.state.tickets = [SHIP, CI];
    h.state.s3Objects["completions/C-1.json"] = JSON.stringify({ ticket_id: "C-1", summary: "done", source: "workflow-manager" });
    await load();
    const body = await (await post()).json();
    expect(body.error).toBe("open_gates");
    expect(body.offenders[0].why).toBe("console_record");
  });

  it("a record carrying agentId (not agent_id) for someone else is an offender", async () => {
    h.state.tickets = [SHIP, CI];
    h.state.s3Objects["completions/C-1.json"] = JSON.stringify({ ticket_id: "C-1", summary: "ran", agentId: "agentcore_hub_backend_dev" });
    await load();
    expect((await (await post()).json()).offenders[0].why).toBe("agent_mismatch");
  });

  it("COMPLETION_EVIDENCE_REQUIRED=off does not shadow a gate-class offender", async () => {
    process.env.COMPLETION_EVIDENCE_REQUIRED = "off";
    h.state.tickets = [SHIP, CI];
    await load();
    expect((await (await post()).json()).error).toBe("open_gates");
  });

  it("a human gate is satisfied by a verified v3 decision record", async () => {
    h.state.tickets = [SHIP, GATE];
    h.state.s3Objects["pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json"] = JSON.stringify(await signedDecision("wf_1", "G-1"));
    await load();
    expect((await post()).status).toBe(200);
  });

  it("a human gate whose decision record is signed with another key, or is absent, is an offender", async () => {
    h.state.tickets = [SHIP, GATE];
    h.state.s3Objects["pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json"] = JSON.stringify(
      await signedDecision("wf_1", "G-1", {}, "some-other-key")
    );
    await load();
    const body = await (await post()).json();
    expect(body.error).toBe("open_gates");
    expect(body.offenders).toEqual([expect.objectContaining({ ticketId: "G-1", why: "no_decision_record" })]);
  });

  it("a human gate whose verified record says cancelled (stopped) is not done", async () => {
    h.state.tickets = [SHIP, GATE];
    h.state.s3Objects["pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json"] = JSON.stringify(
      await signedDecision("wf_1", "G-1", {
        status: "cancelled",
        decision: { option: "stopped", override: false, channel: "hub", by: "eng@example.com" },
      })
    );
    await load();
    expect((await (await post()).json()).offenders[0].why).toBe("decision_not_done");
  });

  it("completion_blocked: a notif_completion_* notice and no override -> 409, even with no offenders now", async () => {
    h.state.workflow = { ...h.state.workflow, humanNotifications: [NOTICE] };
    h.state.tickets = [SHIP];
    await load();
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("completion_blocked");
    expect(body).toMatchObject({ offenders: [], missingEvidence: [], overridePresent: false, overrideVerified: false });
    expect(h.state.updates.length).toBe(0);
  });

  it("completion_blocked: a verified override covering every offender -> completes", async () => {
    h.state.workflow = { ...h.state.workflow, humanNotifications: [NOTICE] };
    h.state.tickets = [SHIP, CI, GATE];
    await override(["C-1", "G-1"]);
    await load();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("complete");
  });

  // TEAM-5376: the marker's DELETE-OR-EXPIRE in closeout-lifecycle.md. The terminal
  // write rewrites humanNotifications through compactNotifications: every
  // non-escalation entry is kept, and only the last 3 manager_escalations.
  it("a terminal close keeps a notif_completion_* marker only while it is among the last 3 manager_escalations (compactNotifications)", async () => {
    const esc = (id: string) => ({ id, type: "manager_escalation", acknowledged: false });
    const review = { id: "notif_review_1", type: "review_needed", acknowledged: false };
    const marker = esc("notif_completion_evidence_wf_1");
    const terminalNotifs = () => {
      const u = h.state.updates.find((x) => String(x.UpdateExpression).includes("humanNotifications = :notifs"));
      return (u?.ExpressionAttributeValues as Record<string, unknown>)[":notifs"] as Array<{ id: string }>;
    };
    h.state.tickets = [SHIP];
    await override([]);

    h.state.workflow = { ...h.state.workflow, humanNotifications: [review, esc("e-1"), marker, esc("e-2")] };
    await load();
    expect((await post()).status).toBe(200);
    expect(terminalNotifs().map((n) => n.id)).toEqual(["notif_review_1", "e-1", "notif_completion_evidence_wf_1", "e-2"]);

    h.state.updates.length = 0;
    h.state.workflow = { ...h.state.workflow, phase: "ship", humanNotifications: [marker, esc("e-1"), review, esc("e-2"), esc("e-3")] };
    await load();
    expect((await post()).status).toBe(200);
    expect(terminalNotifs().map((n) => n.id)).toEqual(["notif_review_1", "e-1", "e-2", "e-3"]);
  });

  it("an override covers open_gates offenders too, with no notice on the row", async () => {
    h.state.tickets = [SHIP, CI];
    await override(["C-1"]);
    await load();
    expect((await post()).status).toBe(200);
  });

  it("an override missing one offender -> 409 naming it", async () => {
    h.state.workflow = { ...h.state.workflow, humanNotifications: [NOTICE] };
    h.state.tickets = [SHIP, CI, SEC];
    await override(["C-1"]);
    await load();
    const body = await (await post()).json();
    expect(body.error).toBe("completion_blocked");
    expect(body.overrideVerified).toBe(true);
    expect(body.offenders.map((o: { ticketId: string }) => o.ticketId)).toContain("SR-1");
  });

  it("an override naming MORE than the offenders (a superset) -> 409; only the exact set completes (DL-036)", async () => {
    h.state.workflow = { ...h.state.workflow, humanNotifications: [NOTICE] };
    h.state.tickets = [SHIP, CI];
    await override(["C-1", "SR-1"]);
    await load();
    const body = await (await post()).json();
    expect(body).toMatchObject({ error: "completion_blocked", overrideVerified: true, overrideStale: true });
    await override(["C-1"]);
    await load();
    expect((await post()).status).toBe(200);
  });

  it("a gate decision from an earlier cycle does not stand: the gate stays an offender (DL-036)", async () => {
    h.state.tickets = [SHIP, GATE];
    h.state.s3Objects["pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json"] = JSON.stringify(
      await signedDecision("wf_1", "G-1", { cycle: "c-1" })
    );
    live.map["G-1"] = { cycle: "c-2" };
    await load();
    expect((await (await post()).json()).offenders).toEqual([expect.objectContaining({ ticketId: "G-1", why: "stale_cycle" })]);
    live.map["G-1"] = { cycle: undefined };
    await load();
    expect((await (await post()).json()).offenders).toEqual([expect.objectContaining({ ticketId: "G-1", why: "cycle_unknown" })]);
    live.map["G-1"] = { cycle: "c-1" };
    await load();
    expect((await post()).status).toBe(200);
  });

  it("an override signed with another key, unsigned, or edited after signing is no override", async () => {
    h.state.workflow = { ...h.state.workflow, humanNotifications: [NOTICE] };
    h.state.tickets = [SHIP, CI];
    const { CLOSEOUT_OVERRIDE_KEY } = await import("@/lib/workflow/closeout-override");
    for (const seed of [
      () => override(["C-1"], {}, "some-other-key"),
      () => override(["C-1"], { sig: undefined }),
      async () => {
        await override(["X-9"]);
        const r = JSON.parse(h.state.s3Objects[CLOSEOUT_OVERRIDE_KEY("wf_1")]);
        h.state.s3Objects[CLOSEOUT_OVERRIDE_KEY("wf_1")] = JSON.stringify({ ...r, offenders: ["C-1"] });
      },
      () => {
        // the unsigned shape the orchestrator's parser alone would accept
        h.state.s3Objects[CLOSEOUT_OVERRIDE_KEY("wf_1")] = JSON.stringify({ by: "x", reason: "y", offenders: ["C-1"], at: "z" });
      },
    ]) {
      await seed();
      await load();
      const body = await (await post()).json();
      expect(body).toMatchObject({ error: "completion_blocked", overridePresent: true, overrideVerified: false });
    }
    expect(h.state.updates.length).toBe(0);
  });

  it("closedBy is unauthenticated:complete without a verified human, x-hub-caller kept as claimedCaller", async () => {
    h.state.tickets = [SHIP];
    await load();
    const res = await post("wf_1", { "x-hub-caller": "workflow-manager" });
    expect(res.status).toBe(200);
    const green = h.state.updates.at(-1)!;
    expect(String(green.UpdateExpression)).toContain("closedBy = :by");
    expect(String(green.UpdateExpression)).toContain("claimedCaller = :cc");
    expect(green.ExpressionAttributeValues).toMatchObject({ ":by": "unauthenticated:complete", ":cc": "workflow-manager" });
    expect(h.state.events.at(-1)).toMatchObject({ closedBy: "unauthenticated:complete", claimedCaller: "workflow-manager" });
  });

  it("closedBy is the verified human identity; no header -> no claimedCaller", async () => {
    process.env.AUTH_MODE = "cloudflare-access";
    h.state.tickets = [SHIP];
    await load();
    const res = await post("wf_1", {
      "x-agentcore-user": "u-alice",
      "x-agentcore-tenant": "default",
      "x-agentcore-email": "alice@example.com",
    });
    expect(res.status).toBe(200);
    const green = h.state.updates.at(-1)!;
    expect((green.ExpressionAttributeValues as Record<string, unknown>)[":by"]).toBe("alice@example.com");
    expect(String(green.UpdateExpression)).not.toContain("claimedCaller");
    expect(h.state.events.at(-1)).not.toHaveProperty("claimedCaller");
  });

  it("closedBy is the svc: identity for a service caller", async () => {
    process.env.AUTH_MODE = "cloudflare-access";
    h.state.tickets = [SHIP];
    await load();
    await post("wf_1", { "x-agentcore-user": "svc:workflow-manager", "x-agentcore-tenant": "default" });
    expect((h.state.updates.at(-1)!.ExpressionAttributeValues as Record<string, unknown>)[":by"]).toBe("svc:workflow-manager");
  });

  it("the blocked close (closeBlocked) stamps closedBy and claimedCaller too", async () => {
    h.state.workflow = { workflowId: "wf_1", phase: "ship", workflowDefId: "software-delivery", agentTasks: { "S-1": { ticketId: "S-1", output: "built" } } };
    h.state.tickets = [SHIP];
    await load();
    const res = await post("wf_1", { "x-hub-caller": "workflow-manager" });
    expect((await res.json()).status).toBe("static-ci-only");
    const blocked = h.state.updates.at(-1)!;
    expect(String(blocked.UpdateExpression)).toContain("closedBy = :by");
    expect(blocked.ExpressionAttributeValues).toMatchObject({ ":by": "unauthenticated:complete", ":cc": "workflow-manager" });
    expect(h.state.events.at(-1)).toMatchObject({ closedBy: "unauthenticated:complete", claimedCaller: "workflow-manager" });
  });

  it('the "workflow-manager" literal is absent from the route (F8 grep pin)', async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/["'`]workflow-manager["'`]/);
  });
});
