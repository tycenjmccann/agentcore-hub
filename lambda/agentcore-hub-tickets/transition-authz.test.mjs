import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4099 F3 — the authz floor on human-review-gate decisions.
 *
 * `Tickets___transition_ticket` is an ordinary agent tool and the tool path carries
 * NO caller identity (deploy/runtime-agent/main.py `_invoke_lambda` sends only the
 * tool name plus arguments). `in_review → done` was a legal transition on it, so any
 * dev or fix agent could move its own Merge Approval gate to `done`. That is not
 * merely a wrong board state: gate-bypass.mjs read a `done` gate with no ledger row
 * as a `legacy_status` APPROVE, so an agent could merge unapproved and then have the
 * detector certify its own merge as `clean`.
 *
 * Contract under test:
 *   - the AGENT tool path (no `_caller`) is REFUSED on a `human:*` gate leaving
 *     in_review, and on any transition of one to a terminal `done` (incl. `skip`);
 *   - the same call from a TRUSTED server-side caller (`_caller: "console"` — the
 *     console transition route, which is also what Telegram's gate buttons drive)
 *     succeeds and writes the status;
 *   - ordinary agent tickets are completely unaffected (the common case:
 *     in_progress → done on your own ticket);
 *   - a forged marker cannot be smuggled in through the ARGUMENTS object, which is
 *     the only part of the event an agent controls.
 *
 * Harness: the §3(a) shape of index.test.mjs / tickets-edge.test.mjs — real handler,
 * stub DDB doc client, no AWS.
 */

const h = vi.hoisted(() => ({
  state: {
    /** ticketId → item served to GetCommand. */
    items: /** @type {Record<string, any>} */ ({}),
    /** Every non-counter UpdateCommand input (the status write). */
    updates: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
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
          if (name === "GetCommand") return { Item: h.state.items[cmd.input.Key.ticketId] || null };
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          return {};
        },
      }),
    },
  };
});

const GATE = "TEAM-19";
const DEV = "TEAM-11";
const REVIEWER = "human:reviewer@example.com";

let handler;

/** The AGENT tool path: nested arguments, no envelope marker. main.py's shape. */
const asAgent = (parameters) =>
  handler({ name: "Tickets___transition_ticket", tool_name: "Tickets___transition_ticket", arguments: parameters, parameters });

/** A trusted server-side invoker (console transition route / start route). */
const asTrusted = (parameters, caller = "console") =>
  handler({ tool_name: "Tickets___transition_ticket", _caller: caller, parameters });

const textOf = (res) => res?.content?.[0]?.text ?? JSON.stringify(res);

beforeEach(async () => {
  h.state.items = {
    [GATE]: { ticketId: GATE, assignee: REVIEWER, status: "in_review", title: "Merge Approval" },
    [DEV]: { ticketId: DEV, assignee: "agentcore_hub_backend_dev", status: "in_progress" },
  };
  h.state.updates.length = 0;
  delete process.env.ARTIFACT_BUCKET;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("transition_ticket — human-gate decisions are not agent-writable (TEAM-4099 F3)", () => {
  it("agent tool path: in_review → done on a human gate is REFUSED and writes nothing", async () => {
    const res = await asAgent({ ticket_id: GATE, transition_id: "done" });

    expect(textOf(res)).toMatch(/human-review gate/);
    expect(textOf(res)).toMatch(/does not approve anything/);
    // The whole point: no status write, so no forged approval for gate-bypass.mjs
    // to later read as a legacy_status APPROVE.
    expect(h.state.updates).toHaveLength(0);
  });

  it("agent tool path: 'Request Changes' out of in_review is refused too — a rejection is also the reviewer's call", async () => {
    const res = await asAgent({ ticket_id: GATE, transition_id: "blocked", reason: "self-serve rework" });
    expect(textOf(res)).toMatch(/human-review gate/);
    expect(h.state.updates).toHaveLength(0);
  });

  it("agent tool path: `skip` (blocked → done) on a human gate is refused — skipping a gate is deciding it", async () => {
    h.state.items[GATE].status = "blocked";
    const res = await asAgent({ ticket_id: GATE, transition_id: "skip", reason: "not needed" });
    expect(textOf(res)).toMatch(/human-review gate/);
    expect(h.state.updates).toHaveLength(0);
  });

  it("trusted caller (console/telegram/orchestrator): the same approval lands", async () => {
    for (const caller of ["console", "telegram", "orchestrator"]) {
      h.state.updates.length = 0;
      const res = await asTrusted({ ticket_id: GATE, transition_id: "done", reason: "DECISION: approve" }, caller);

      expect(res).toMatchObject({ key: GATE, status: "transitioned" });
      expect(h.state.updates).toHaveLength(1);
      expect(h.state.updates[0].ExpressionAttributeValues[":s"]).toBe("done");
      // The reviewComment path (leaving in_review with a reason) still runs.
      expect(h.state.updates[0].ExpressionAttributeValues[":rvc"]).toBe("DECISION: approve");
    }
  });

  it("an UNKNOWN caller string is not trusted — the allowlist is closed", async () => {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      _caller: "agentcore_hub_backend_dev",
      parameters: { ticket_id: GATE, transition_id: "done" },
    });
    expect(textOf(res)).toMatch(/human-review gate/);
    expect(h.state.updates).toHaveLength(0);
  });

  it("the marker cannot be forged from inside the ARGUMENTS — an agent owns those, not the envelope", async () => {
    const res = await asAgent({ ticket_id: GATE, transition_id: "done", _caller: "console" });
    expect(textOf(res)).toMatch(/human-review gate/);
    expect(h.state.updates).toHaveLength(0);
  });

  it("args at the event ROOT are never trusted (the `|| event` fallback is fully agent-supplied)", async () => {
    const res = await handler({
      tool_name: "Tickets___transition_ticket",
      _caller: "console",
      ticket_id: GATE,
      transition_id: "done",
    });
    expect(textOf(res)).toMatch(/human-review gate/);
    expect(h.state.updates).toHaveLength(0);
  });

  it("ordinary agent tickets are untouched: an agent still closes its OWN ticket from the tool path", async () => {
    const res = await asAgent({ ticket_id: DEV, transition_id: "done" });

    expect(res).toMatchObject({ key: DEV, status: "transitioned" });
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0].ExpressionAttributeValues[":s"]).toBe("done");
  });

  it("a human gate moving WITHIN the board (not a decision) is still open to the tool path", async () => {
    // blocked → in_review: re-arming the gate after a rework round. Not an approval,
    // not out of in_review, so the guard stays out of the way.
    h.state.items[GATE].status = "blocked";
    const res = await asAgent({ ticket_id: GATE, transition_id: "in_review" });

    expect(res).toMatchObject({ key: GATE, status: "transitioned" });
    expect(h.state.updates[0].ExpressionAttributeValues[":s"]).toBe("in_review");
  });

  it("the pre-existing guard still holds: an AGENT ticket may never enter in_review", async () => {
    h.state.items[DEV].status = "in_progress";
    const res = await asTrusted({ ticket_id: DEV, transition_id: "in_review" });
    expect(textOf(res)).toMatch(/only human-review tickets/);
    expect(h.state.updates).toHaveLength(0);
  });
});
