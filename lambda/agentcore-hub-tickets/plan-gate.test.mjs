import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4100 F2 (layer 2, best-effort create-time check) — when a validated
 * ticket plan is persisted for a workflow (workflow-output submitTicketPlan
 * writes shared/ticket-plan.json only after it validates the plan against the
 * def's ticketDag), the analyst may create AGENT tickets ONLY for assignees the
 * plan authorized (coded TICKET_NOT_IN_PLAN). This is the SECOND layer; the
 * orchestrator's realized-graph gate (dag-enforce-gate.test.mjs) is the hard one.
 *
 * Bypasses / no-ops proven here: a trusted server-side caller (_caller:
 * orchestrator — the fix/re-verify spawn envelope) is exempt; a human gate
 * (human:*) is exempt; and a run with NO persisted plan is unchecked (fail-open).
 *
 * NOTE: the create-time EDGE check (TICKET_EDGE_NOT_IN_PLAN) is deliberately NOT
 * implemented here — resolving a blocked_by real-id to its DAG node needs a
 * per-blocker lookup (not cheap, and would diverge across the DDB/Jira twins).
 * Edge/forbidden-edge conformance is enforced by layer 1's validateRealizedGraph
 * over the whole realized graph.
 */

const h = vi.hoisted(() => ({
  state: {
    puts: /** @type {any[]} */ ([]),
    counter: 0,
    /** S3 objects by key; a missing key throws NoSuchKey (→ planAssigneeSet null). */
    s3: /** @type {Record<string, unknown>} */ ({}),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd.input.Key;
      if (!(key in h.state.s3)) {
        const e = new Error(`NoSuchKey: ${key}`);
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => JSON.stringify(h.state.s3[key]) } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "UpdateCommand") { h.state.counter += 1; return { Attributes: { nextNum: h.state.counter } }; }
          if (name === "PutCommand") { h.state.puts.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

const WF = "wf1";
const PLAN_KEY = `workflows/${WF}/shared/ticket-plan.json`;
const DEV = "agentcore_hub_backend_dev";
const QA = "agentcore_hub_qa_verifier";
const OFF_PLAN = "agentcore_hub_frontend_dev"; // a valid agent, but NOT in the plan

/** A validated plan authorizing DEV + QA only. */
const PLAN = { requirements: "r", tickets: [{ id: "p1", assignee: DEV }, { id: "p2", assignee: QA }] };

let handler;

const create = (args, extra = {}) =>
  handler({ _tool_name: "Tickets___create_ticket", parameters: args, ...extra });

/** Extract the error string a textResult-shaped reject carries. */
const errText = (res) => (res?.content?.[0]?.text ?? res?.error ?? JSON.stringify(res));

beforeEach(async () => {
  h.state.puts.length = 0;
  h.state.counter = 0;
  h.state.s3 = { [PLAN_KEY]: PLAN };
  process.env.ARTIFACT_BUCKET = "test-bucket";
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

afterEach(() => {
  delete process.env.ARTIFACT_BUCKET;
});

describe("create_ticket — plan-conformance create-time check (F2 layer 2)", () => {
  it("assignee in the plan → created", async () => {
    const res = await create({ summary: "impl", assignee: DEV, workflow_id: WF });
    expect(res.status).toBe("created");
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.puts[0].assignee).toBe(DEV);
  });

  it("assignee NOT in the plan → rejected TICKET_NOT_IN_PLAN, nothing minted", async () => {
    const res = await create({ summary: "sneak in a designer", assignee: OFF_PLAN, workflow_id: WF });
    expect(errText(res)).toContain("TICKET_NOT_IN_PLAN");
    expect(errText(res)).toContain(OFF_PLAN);
    expect(h.state.puts).toHaveLength(0);
  });

  it("orchestrator envelope (_caller) bypasses the check", async () => {
    const res = await create(
      { summary: "re-verify spawn", assignee: OFF_PLAN, workflow_id: WF },
      { _caller: "orchestrator" }
    );
    expect(res.status).toBe("created");
    expect(h.state.puts).toHaveLength(1);
  });

  it("human gate assignee is exempt from the plan check", async () => {
    const res = await create({ summary: "review gate", assignee: "human:qa-lead", workflow_id: WF });
    expect(res.status).toBe("created");
    expect(h.state.puts).toHaveLength(1);
  });

  it("no persisted plan → unchecked (fail-open, layer 1 is the hard gate)", async () => {
    delete h.state.s3[PLAN_KEY]; // GetObject → NoSuchKey → planAssigneeSet null
    const res = await create({ summary: "no plan yet", assignee: OFF_PLAN, workflow_id: WF });
    expect(res.status).toBe("created");
    expect(h.state.puts).toHaveLength(1);
  });
});
