import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-5426 replay (tickets twin) — rfq233: the security review TEAM-5357 said
 * "Changes needed: 1 Critical, 4 High" and still went Done, releasing the dev
 * lanes TEAM-5358/5359 four seconds later.
 *
 *   - the review gets ONE "Amend design" ticket (review_fix, phase=design,
 *     origin = the review). The first is minted; a second is refused
 *     design_amendment_exhausted before an id exists, and an unreadable epic
 *     refuses too (fail closed, like the gate-loop guard).
 *   - the review ticket can no longer be walked to Done around
 *     WorkflowOutput___report_completion: no completion record, no Done.
 *
 * Mocked: the AWS seams only. The guards and gate-contract.mjs are the real ones.
 */

const h = vi.hoisted(() => ({
  state: {
    items: /** @type {Record<string, any>} */ ({}),
    puts: /** @type {any[]} */ ([]),
    statusUpdates: /** @type {any[]} */ ([]),
    siblings: /** @type {any[]} */ ([]),
    queryFails: false,
    counter: 0,
    record: /** @type {string|null} */ (null),
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { throw new Error("no pipeline tools in this replay"); } },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      if (h.state.record !== null) return { Body: { transformToString: async () => h.state.record } };
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; } },
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
          if (name === "UpdateCommand") {
            if (cmd.input.ExpressionAttributeValues?.[":s"] !== undefined) {
              h.state.statusUpdates.push(cmd.input);
              return {};
            }
            if (cmd.input.ExpressionAttributeValues?.[":comment"] !== undefined) return {};
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] };
          if (name === "PutCommand") {
            if (!cmd.input.Item?.eventId) h.state.puts.push(cmd.input.Item);
            return {};
          }
          if (name === "QueryCommand") {
            if (h.state.queryFails) {
              const err = new Error("ProvisionedThroughputExceededException");
              err.name = "ProvisionedThroughputExceededException";
              throw err;
            }
            return { Items: h.state.siblings };
          }
          return {};
        },
      }),
    },
  };
});

const EPIC = "TEAM-5355";
const DESIGN = "TEAM-5356";
const REVIEW = "TEAM-5357";
const REVIEWER = "agentcore_hub_security_reviewer";

let handler;
const create = (args) => handler({ name: "Tickets___create_ticket", arguments: args });
const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });

const amendArgs = () => ({
  summary: "Amend design: address security review TEAM-5357 findings",
  description: "1 Critical, 4 High - see shared/security-review.md",
  parent_key: EPIC,
  assignee: "agentcore_hub_backend_designer",
  workflow_id: "rfq233",
  spawned_by: { kind: "review_fix", gateTicketId: REVIEW },
  phase: "design",
});

const board = () => [
  { ticketId: DESIGN, title: "Backend design", status: "done", assignee: "agentcore_hub_backend_designer", parentId: EPIC },
  { ticketId: REVIEW, title: "Security review", status: "blocked", assignee: REVIEWER, parentId: EPIC, blockedBy: [DESIGN] },
  { ticketId: "TEAM-5358", title: "Backend dev", status: "blocked", assignee: "agentcore_hub_backend_dev", parentId: EPIC, blockedBy: [DESIGN, REVIEW] },
  { ticketId: "TEAM-5359", title: "Frontend dev", status: "blocked", assignee: "agentcore_hub_frontend_dev", parentId: EPIC, blockedBy: [DESIGN, REVIEW] },
];

beforeEach(async () => {
  const s = h.state;
  s.items = {};
  s.puts.length = 0;
  s.statusUpdates.length = 0;
  s.siblings = board();
  s.queryFails = false;
  s.counter = 100;
  s.record = null;
  process.env.ARTIFACT_BUCKET = "test-artifacts";
  process.env.AWS_REGION = "us-east-1";
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("TEAM-5426 — one design amendment per review", () => {
  it("mints the first amendment, stamped review_fix / phase=design / origin=the review", async () => {
    const res = await create(amendArgs());
    expect(res.ok).not.toBe(false);
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.puts[0]).toMatchObject({ phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: REVIEW } });
  });

  it("refuses a second amendment for the same review before an id is minted", async () => {
    h.state.siblings.push({
      ticketId: "TEAM-5360", title: "Amend design", status: "in_progress", parentId: EPIC,
      phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: REVIEW },
    });
    const res = await create(amendArgs());
    expect(res).toMatchObject({ ok: false, reason: "design_amendment_exhausted", existingTicketId: "TEAM-5360" });
    expect(res.content[0].text).toContain("ONE amendment turn");
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter, "no ticket id was minted").toBe(100);
  });

  it("a cancelled prior does not use up the slot", async () => {
    h.state.siblings.push({
      ticketId: "TEAM-5360", status: "cancelled", parentId: EPIC,
      phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: REVIEW },
    });
    await create(amendArgs());
    expect(h.state.puts).toHaveLength(1);
  });

  it("an amendment for a DIFFERENT review is not a prior", async () => {
    h.state.siblings.push({
      ticketId: "TEAM-5361", status: "done", parentId: EPIC,
      phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: "TEAM-5399" },
    });
    await create(amendArgs());
    expect(h.state.puts).toHaveLength(1);
  });

  it("a failed sibling scan refuses (fail closed)", async () => {
    h.state.queryFails = true;
    const res = await create(amendArgs());
    expect(res.content[0].text).toMatch(/^Error:/);
    expect(h.state.puts).toHaveLength(0);
  });

  it("a review_fix that is not design-phase is untouched by the guard", async () => {
    h.state.siblings.push({
      ticketId: "TEAM-5360", status: "in_progress", parentId: EPIC,
      phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: REVIEW },
    });
    await create({ ...amendArgs(), phase: "development", summary: "Fix: review finding in code" });
    expect(h.state.puts).toHaveLength(1);
  });
});

describe("TEAM-5426 — the review cannot be walked to Done around report_completion", () => {
  beforeEach(() => {
    h.state.items[REVIEW] = {
      ticketId: REVIEW, status: "in_progress", assignee: REVIEWER, parentId: EPIC,
      workflowId: "rfq233", labels: [], blockedBy: [DESIGN],
    };
  });

  it("refuses a direct done with no completion record", async () => {
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res).toMatchObject({ ok: false, reason: "completion_record_required" });
    expect(res.content[0].text).toContain("a security-review ticket");
    expect(h.state.statusUpdates).toHaveLength(0);
  });

  it("allows done once report_completion wrote the record", async () => {
    h.state.record = JSON.stringify({ ticketId: REVIEW, agentId: REVIEWER, summary: "Verdict: PASS", completedAt: new Date().toISOString() });
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("other agents' tickets are unaffected", async () => {
    h.state.items[DESIGN] = { ticketId: DESIGN, status: "in_progress", assignee: "agentcore_hub_backend_designer", parentId: EPIC, labels: [] };
    await transition({ ticket_id: DESIGN, to_status: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
  });
});
