import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * TEAM-5426 replay (tickets twin) — rfq233: the security review TEAM-5357 said
 * "Verdict: FAIL (changes needed)" and still went Done, releasing the dev
 * lanes TEAM-5358/5359 seconds later.
 *
 *   - the review gets ONE "Amend design" ticket (review_fix, phase=design,
 *     origin = the review). The first is minted; a second is refused
 *     design_amendment_exhausted before an id exists, and an unreadable epic
 *     refuses too (fail closed, like the gate-loop guard).
 *   - two concurrent creates both pass that scan-then-create check; the
 *     post-create re-scan withdraws the NEWER one (cancelled), oldest id keeps
 *     the slot.
 *   - the review ticket can no longer be walked to Done around
 *     WorkflowOutput___report_completion: no completion record, no Done — and a
 *     record without report_completion's securityReview stamp (or a non-PASS
 *     one with no amendment) is no better.
 *   - the board fixture's dynamodb wire rows are this twin's real serializer
 *     output over its `stored` rows (re-derived below, fails on drift).
 *
 * Mocked: the AWS seams only. The guards and gate-contract.mjs are the real ones.
 */

const BOARD = JSON.parse(readFileSync(new URL("../workflow-output/__fixtures__/design-amendment/team-5356-board.json", import.meta.url), "utf8"));

const h = vi.hoisted(() => ({
  state: {
    items: /** @type {Record<string, any>} */ ({}),
    puts: /** @type {any[]} */ ([]),
    statusUpdates: /** @type {any[]} */ ([]),
    /** Every write in order: "repoint:<id>" / "status:<id>". */
    writes: /** @type {string[]} */ ([]),
    repointFails: false,
    siblings: /** @type {any[]} */ ([]),
    queryFails: false,
    counter: 0,
    record: /** @type {string|null} */ (null),
    /** Runs on each ticket PutCommand — a concurrent create landing between scan and re-scan. */
    onPut: /** @type {null | ((item: any) => void)} */ (null),
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
              h.state.writes.push(`status:${cmd.input.Key.ticketId}`);
              return {};
            }
            if (cmd.input.ExpressionAttributeValues?.[":keeper"] !== undefined) {
              if (h.state.repointFails) throw Object.assign(new Error("ProvisionedThroughputExceededException"), { name: "ProvisionedThroughputExceededException" });
              h.state.writes.push(`repoint:${cmd.input.Key.ticketId}`);
              const row = h.state.siblings.find((r) => r.ticketId === cmd.input.Key.ticketId);
              if (row) row.blockedBy = [...(row.blockedBy || []), ...cmd.input.ExpressionAttributeValues[":keeper"]];
              return {};
            }
            if (cmd.input.ExpressionAttributeValues?.[":comment"] !== undefined) return {};
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] };
          if (name === "PutCommand") {
            if (!cmd.input.Item?.eventId) {
              h.state.puts.push(cmd.input.Item);
              h.state.onPut?.(cmd.input.Item);
            }
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

const EPIC = BOARD.epic;
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
  workflow_id: "wf_1791311636588_rfq233",
  spawned_by: { kind: "review_fix", gateTicketId: REVIEW },
  phase: "design",
});

const board = () => JSON.parse(JSON.stringify(BOARD.dynamodb.stored.items));
/** A stored amendment row for the same review (a prior, or a concurrent racer). */
const amendmentRow = (ticketId, status) => ({ ...JSON.parse(JSON.stringify(BOARD.dynamodb.stored.amendment)), ticketId, status });
/** The id `n` steps from `id`, same prefix. */
const step = (id, n) => id.replace(/(\d+)$/, (d) => String(Number(d) + n));

beforeEach(async () => {
  const s = h.state;
  s.items = {};
  s.puts.length = 0;
  s.statusUpdates.length = 0;
  s.writes.length = 0;
  s.repointFails = false;
  s.siblings = board();
  s.queryFails = false;
  s.counter = 100;
  s.record = null;
  s.onPut = null;
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
      phase: "design", spawnedBy: { kind: "review_fix", gateTicketId: "TEAM-5398" },
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

  it("two concurrent creates: the NEWER one is withdrawn (cancelled) after the re-scan, naming the keeper", async () => {
    // The racer passed the same pre-create scan and got the older id; it is
    // visible only on the post-create re-scan.
    h.state.onPut = (item) => h.state.siblings.push(amendmentRow(step(item.ticketId, -1), "todo"));
    const res = await create(amendArgs());
    const mine = h.state.puts[0].ticketId;
    expect(res).toMatchObject({ ok: false, reason: "design_amendment_exhausted", existingTicketId: step(mine, -1), cancelledTicketId: mine });
    expect(h.state.statusUpdates).toHaveLength(1);
    expect(h.state.statusUpdates[0]).toMatchObject({ Key: { ticketId: mine } });
    expect(h.state.statusUpdates[0].ExpressionAttributeValues[":s"]).toBe("cancelled");
  });

  it("a ticket already parked behind the loser gets the keeper as a blocker BEFORE the cancel", async () => {
    // The review parked on the loser (visible on the board from its Put) while the
    // keeper is still open: cancelling the loser alone would release the review.
    h.state.onPut = (item) => {
      h.state.siblings.push(amendmentRow(step(item.ticketId, -1), "todo"));
      h.state.siblings.find((r) => r.ticketId === REVIEW).blockedBy = [item.ticketId];
    };
    const res = await create(amendArgs());
    const mine = h.state.puts[0].ticketId;
    const keeper = step(mine, -1);
    expect(res).toMatchObject({ reason: "design_amendment_exhausted", existingTicketId: keeper, cancelledTicketId: mine });
    expect(h.state.writes).toEqual([`repoint:${REVIEW}`, `status:${mine}`]);
    expect(h.state.siblings.find((r) => r.ticketId === REVIEW).blockedBy).toEqual([mine, keeper]);
  });

  it("a failed re-point aborts the withdrawal: the loser stays, nothing is released", async () => {
    h.state.onPut = (item) => {
      h.state.siblings.push(amendmentRow(step(item.ticketId, -1), "todo"));
      h.state.siblings.find((r) => r.ticketId === REVIEW).blockedBy = [item.ticketId];
    };
    h.state.repointFails = true;
    const res = await create(amendArgs());
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates, "the loser is not cancelled").toHaveLength(0);
  });

  it("two concurrent creates: the OLDER one keeps the slot", async () => {
    h.state.onPut = (item) => h.state.siblings.push(amendmentRow(step(item.ticketId, 1), "todo"));
    const res = await create(amendArgs());
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates, "the keeper is not cancelled").toHaveLength(0);
  });

  it("a failed re-scan keeps the ticket (the pre-create check already passed)", async () => {
    h.state.onPut = () => { h.state.queryFails = true; };
    const res = await create(amendArgs());
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates).toHaveLength(0);
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

  const recordWith = (extra) => JSON.stringify({ ticketId: REVIEW, agentId: REVIEWER, summary: "Verdict: PASS", status: "complete", completedAt: new Date().toISOString(), ...extra });

  it("allows done once report_completion wrote a PASS-stamped record", async () => {
    h.state.record = recordWith({ securityReview: { verdict: "PASS" } });
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("allows done on a non-PASS record that names its done amendment", async () => {
    h.state.record = recordWith({ summary: "Verdict: FAIL", securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-5399" } });
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res.ok).not.toBe(false);
    expect(h.state.statusUpdates).toHaveLength(1);
  });

  it("refuses done on a FAIL record with no amendment (the review's repro)", async () => {
    h.state.record = recordWith({ summary: "Verdict: FAIL", securityReview: { verdict: "FAIL" } });
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res).toMatchObject({ ok: false, reason: "completion_record_required" });
    expect(res.content[0].text).toContain("no done design amendment");
    expect(h.state.statusUpdates).toHaveLength(0);
  });

  it("refuses done on a record with no securityReview stamp (written for another agent_id, or by hand)", async () => {
    h.state.record = recordWith({ summary: "Verdict: FAIL", agentId: "agentcore_hub_backend_dev" });
    const res = await transition({ ticket_id: REVIEW, to_status: "done" });
    expect(res).toMatchObject({ ok: false, reason: "completion_record_required" });
    expect(res.content[0].text).toContain("carries no securityReview verdict");
    expect(h.state.statusUpdates).toHaveLength(0);
  });

  it("other agents' tickets are unaffected", async () => {
    h.state.items[DESIGN] = { ticketId: DESIGN, status: "in_progress", assignee: "agentcore_hub_backend_designer", parentId: EPIC, labels: [] };
    await transition({ ticket_id: DESIGN, to_status: "done" });
    expect(h.state.statusUpdates).toHaveLength(1);
  });
});

describe("TEAM-5426 — the board fixture is this twin's real wire shape", () => {
  it("list_tickets over the stored rows reproduces BOARD.dynamodb.siblings", async () => {
    h.state.siblings = board();
    const res = await handler({ name: "Tickets___list_tickets", arguments: { parent_id: EPIC } });
    expect(res.issues).toEqual(BOARD.dynamodb.siblings);
  });

  it("get_issue over the stored review row reproduces BOARD.dynamodb.issue", async () => {
    for (const item of board()) h.state.items[item.ticketId] = item;
    const res = await handler({ name: "Tickets___get_issue", arguments: { ticket_id: REVIEW } });
    expect(res).toEqual(BOARD.dynamodb.issue);
  });

  it("the amendment row serializes to BOARD.dynamodb.amendment", async () => {
    h.state.siblings = [...board(), amendmentRow("TEAM-5399", "todo")];
    const res = await handler({ name: "Tickets___list_tickets", arguments: { parent_id: EPIC } });
    expect(res.issues.at(-1)).toEqual(BOARD.dynamodb.amendment);
  });
});
