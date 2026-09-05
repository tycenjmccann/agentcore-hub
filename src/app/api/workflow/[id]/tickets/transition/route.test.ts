import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3991 F6 — the gate DECISION ledger, written from the human path only.
 *
 * `reviewGateHistory[gate].decisions` is what gate-bypass.mjs compares a merged
 * PR against, so the row is a security record, not telemetry:
 *   - it is appended when a HUMAN gate is decided (done = APPROVE, blocked =
 *     REQUEST_CHANGES) and at no other time — an agent ticket moving to done is
 *     not an approval, which is the whole reason wf sffzti shipped unapproved;
 *   - `decidedBy` comes from the middleware-verified identity header, NEVER from
 *     the request body — the body is caller-controlled;
 *   - the append is `list_append` on a seeded map entry, so two decisions landing
 *     together are both kept.
 *
 * Seam-mocked like src/app/api/bugs/route.test.ts: the REAL POST handler runs;
 * the DDB doc client, the Lambda client and the workflow/ticket readers are stubs.
 */
const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, any>>,
  lambdaCalls: [] as unknown[],
  /** The tickets the run's board returns. */
  tickets: [] as Array<Record<string, unknown>>,
  /** null = the Lambda reports a FunctionError. */
  lambdaError: null as string | null,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class UpdateCommand {
    constructor(public input: Record<string, any>) {}
  }
  return {
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
          if (cmd.constructor.name === "UpdateCommand") h.updates.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: unknown }) {
      h.lambdaCalls.push(cmd.input);
      if (h.lambdaError) {
        return { FunctionError: "Unhandled", Payload: Buffer.from(h.lambdaError) };
      }
      return {};
    }
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@/lib/workflow/dynamo-read", () => ({
  getWorkflowFromDynamo: vi.fn(async (id: string) => ({ workflowId: id, phase: "ship" })),
  getTicketsForWorkflowFromDynamo: vi.fn(async () => h.tickets),
}));
vi.mock("@/lib/workflow/jira-read", () => ({
  getTicketsForWorkflowFromJira: vi.fn(async () => h.tickets),
}));

const WF = "wf_1";
const GATE = "TEAM-900";
const AGENT_TICKET = "TEAM-901";
const REVIEWER = "human:reviewer@example.com";

type Post = (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;
let POST: Post;

/** The identity header is the ONLY actor source — middleware is its only writer. */
function makeReq(body: Record<string, unknown>, user: string | null = "alice@example.com") {
  return new NextRequest(`http://localhost/api/workflow/${WF}/tickets/transition`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-agentcore-user": user, "x-agentcore-tenant": "acme" } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The one UpdateCommand that appends to the decisions list. */
const decisionAppend = () =>
  h.updates.find((u) => String(u.UpdateExpression || "").includes(".decisions = list_append("));
const appendedRow = () => decisionAppend()?.ExpressionAttributeValues?.[":d"]?.[0];

beforeEach(async () => {
  h.updates.length = 0;
  h.lambdaCalls.length = 0;
  h.lambdaError = null;
  h.tickets = [
    { ticketId: GATE, status: "in_review", assignee: REVIEWER, title: "Merge Approval" },
    { ticketId: AGENT_TICKET, status: "in_progress", assignee: "agentcore_hub_backend_dev" },
  ];
  process.env.TICKET_PROVIDER = "dynamodb";
  vi.resetModules();
  ({ POST } = (await import("./route")) as unknown as { POST: Post });
});

describe("gate DECISION ledger (TEAM-3991 F6)", () => {
  it("approving a human gate appends APPROVE with decidedBy from the verified header", async () => {
    const res = await POST(makeReq({ ticketId: GATE, targetStatus: "done" }), { params: { id: WF } });
    expect(res.status).toBe(200);

    const row = appendedRow();
    expect(row).toMatchObject({ decision: "APPROVE", decidedBy: "alice@example.com", source: "console" });
    expect(Date.parse(row.decidedAt)).not.toBeNaN();

    // Scoped to this gate, and an append — never a whole-array rewrite.
    const upd = decisionAppend();
    expect(upd?.Key).toEqual({ workflowId: WF });
    expect(upd?.ExpressionAttributeNames).toEqual({ "#g": GATE });
    expect(upd?.ExpressionAttributeValues[":empty"]).toEqual([]);
    // The map + gate entry are seeded first, so the append can address them.
    expect(h.updates[0].UpdateExpression).toContain("if_not_exists(reviewGateHistory, :emptyMap)");
    expect(h.updates[1].UpdateExpression).toContain("reviewGateHistory.#g = if_not_exists");
  });

  it("rejecting a human gate appends REQUEST_CHANGES", async () => {
    await POST(makeReq({ ticketId: GATE, targetStatus: "blocked", comment: "fix the migration" }), {
      params: { id: WF },
    });
    expect(appendedRow()).toMatchObject({ decision: "REQUEST_CHANGES", decidedBy: "alice@example.com" });
  });

  it("an AGENT ticket reaching done writes NO ledger row (an agent cannot approve its own merge)", async () => {
    await POST(makeReq({ ticketId: AGENT_TICKET, targetStatus: "done" }), { params: { id: WF } });
    expect(h.lambdaCalls).toHaveLength(1); // the transition itself still happened
    expect(h.updates).toHaveLength(0);
  });

  it("a body-supplied actor is ignored — decidedBy is the header identity", async () => {
    await POST(
      makeReq({ ticketId: GATE, targetStatus: "done", decidedBy: "root", source: "telegram" }),
      { params: { id: WF } }
    );
    expect(appendedRow()).toMatchObject({ decidedBy: "alice@example.com", source: "console" });
  });

  it("a non-decision transition on a human gate is not a verdict (no row)", async () => {
    h.tickets = [{ ticketId: GATE, status: "ready", assignee: REVIEWER, title: "Merge Approval" }];
    await POST(makeReq({ ticketId: GATE, targetStatus: "in_review" }), { params: { id: WF } });
    expect(h.updates).toHaveLength(0);
  });

  it("no row when the transition itself failed — the ledger never claims authority the board lacks", async () => {
    h.lambdaError = JSON.stringify({ errorMessage: "boom" });
    const res = await POST(makeReq({ ticketId: GATE, targetStatus: "done" }), { params: { id: WF } });
    expect(res.status).toBe(500);
    expect(h.updates).toHaveLength(0);
  });
});
