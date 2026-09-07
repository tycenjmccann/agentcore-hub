import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4166 §1.2 — the structured `report_precondition_unmet` channel in
 * workflow-output. This is the NON-terminal twin of report_completion: an agent
 * that can't finish yet reports the ids it is waiting on, and the ONLY side
 * effects are (a) a tickets-Lambda `Tickets___annotate_precondition_unmet` invoke
 * that stamps preconditionUnmet and (b) an `agent.precondition_unmet` journey
 * event. It must NEVER transition the ticket (no `Tickets___transition_ticket`)
 * and NEVER write a completions/<id>.json record — doing either would Done a
 * ticket whose work is provably unfinished, which is the whole failure this
 * channel exists to prevent.
 */

const h = vi.hoisted(() => {
  // ticketItem/ticketUpdates (TEAM-4261) belong to the REAL tickets handler, which
  // the end-to-end cases below drive through this same lib-dynamodb mock.
  const state = { puts: [], invokes: [], ddbPuts: [], ticketItem: null, ticketUpdates: [] };
  // The real tickets-Lambda SUCCESS shape — { ticketId, preconditionUnmet: {
  // awaitingIds } }, no `.error` — as pinned by
  // agentcore-hub-tickets/precondition-contract.test.mjs. TEAM-4261: awaitingIds is
  // REQUIRED, not decorative — it is the positive check the consumer now demands
  // before it will report a stamp as persisted.
  state.defaultResponder = (parsed) => ({
    ticketId: parsed.parameters?.ticket_id,
    preconditionUnmet: { awaitingIds: parsed.parameters?.awaitingIds || [] },
  });
  // Per-test override (reset in beforeEach). A responder may return the payload
  // object directly, or { payload, FunctionError } to simulate a Lambda-level
  // unhandled exception, or THROW to simulate an invoke failure.
  state.invokeResponder = state.defaultResponder;
  return state;
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd?.constructor?.name === "PutObjectCommand") h.puts.push(cmd.input);
      return {};
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      // Record the parsed invoke FIRST, so a throwing responder still leaves the
      // invoke assertable (the failure tests check it was the annotate action).
      const parsed = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.invokes.push(parsed);
      // Awaited (TEAM-4261): a responder may be the REAL tickets handler, which is
      // async — an unawaited Promise would stringify to `{}` and silently pass a
      // no-stamp payload to the consumer.
      const out = await h.invokeResponder(parsed);
      const { payload, FunctionError } = out && typeof out === "object" && "payload" in out
        ? out
        : { payload: out, FunctionError: undefined };
      return { Payload: new TextEncoder().encode(JSON.stringify(payload)), ...(FunctionError ? { FunctionError } : {}) };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
// TEAM-4261 — the command set is wider than workflow-output's own PutCommand because
// the end-to-end cases below import the REAL tickets Lambda, which reads the ticket
// row (GetCommand) and writes the stamp (UpdateCommand) through this same seam.
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd) => {
        const kind = cmd?.constructor?.name;
        if (kind === "GetCommand") return { Item: h.ticketItem };
        if (kind === "UpdateCommand") { h.ticketUpdates.push(cmd.input); return {}; }
        h.ddbPuts.push(cmd?.input);
        return {};
      },
    }),
  },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
  UpdateCommand: class { constructor(input) { this.input = input; } },
  QueryCommand: class { constructor(input) { this.input = input; } },
  ScanCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
const { handler } = await import("./index.mjs");
// The REAL DynamoDB tickets Lambda, so the end-to-end cases exercise the actual
// producer→consumer pair rather than a hand-written literal (TEAM-4261).
const tickets = await import("../agentcore-hub-tickets/index.mjs");

const call = (args, name = "WorkflowOutput___report_precondition_unmet") =>
  handler({ tool_name: name, arguments: args });

/** The parsed { content:[{text}] } body of a handler return. */
const result = (r) => JSON.parse(r.content[0].text);

beforeEach(() => {
  h.puts.length = 0;
  h.invokes.length = 0;
  h.ddbPuts.length = 0;
  h.ticketUpdates.length = 0;
  h.ticketItem = null;
  h.invokeResponder = h.defaultResponder;
});

describe("report_precondition_unmet — happy path", () => {
  it("invokes annotate_precondition_unmet, publishes the journey event, and NEVER transitions or writes a completion", async () => {
    const r = result(await call({
      ticket_id: "TEAM-4126",
      awaiting_ids: "TEAM-4156, TEAM-4157",
      note: "waiting on the two ship fixes",
      workflow_id: "wf_1",
      agent_id: "agentcore_hub_release_manager",
    }));

    expect(r.status).toBe("waiting");
    expect(r.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
    // TEAM-4189 — the stamp landed, and the caller is told so explicitly.
    expect(r.stampPersisted).toBe(true);

    // Exactly one tickets-Lambda invoke, and it is the annotate action.
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0].tool_name).toBe("Tickets___annotate_precondition_unmet");
    expect(h.invokes[0].parameters.ticket_id).toBe("TEAM-4126");
    expect(h.invokes[0].parameters.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
    expect(h.invokes[0].parameters.source).toBe("tool");
    expect(typeof h.invokes[0].parameters.reportedAt).toBe("string");

    // NEVER a transition — that would Done the unfinished ticket.
    expect(h.invokes.some((i) => i.tool_name === "Tickets___transition_ticket")).toBe(false);

    // NEVER a completions/<id>.json record (no S3 PutObject at all here).
    expect(h.puts.some((p) => String(p.Key || "").startsWith("completions/"))).toBe(false);

    // The journey event landed on the events table.
    const event = h.ddbPuts.find((p) => p?.Item?.type === "agent.precondition_unmet");
    expect(event).toBeTruthy();
    expect(event.Item.workflowId).toBe("wf_1");
    expect(event.Item.detail).toMatchObject({
      ticketId: "TEAM-4126", awaitingIds: ["TEAM-4156", "TEAM-4157"], agentId: "agentcore_hub_release_manager",
    });
    expect(event.Item.detail.stampPersisted).toBe(true);
    expect(event.Item.detail.stampError).toBeNull();
  });

  it("splits on whitespace, drops self and invalid, dedupes, and caps at 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `TEAM-${5000 + i}`).join(" ");
    const r = result(await call({
      ticket_id: "TEAM-4126",
      awaiting_ids: `TEAM-4156 TEAM-4156 TEAM-4126 not-an-id ${many}`,
    }));
    expect(r.awaitingIds).not.toContain("TEAM-4126"); // self dropped
    expect(r.awaitingIds).not.toContain("not-an-id"); // invalid dropped
    // TEAM-4156 once (dedup), then capped at 20 total.
    expect(r.awaitingIds).toHaveLength(20);
    expect(r.awaitingIds.filter((x) => x === "TEAM-4156")).toHaveLength(1);
  });

  it("accepts the bare tool name too and resolves the same handler", async () => {
    const r = result(await call({ ticket_id: "TEAM-1", awaiting_ids: "TEAM-2" }, "report_precondition_unmet"));
    expect(r.status).toBe("waiting");
    expect(h.invokes[0].tool_name).toBe("Tickets___annotate_precondition_unmet");
  });
});

describe("report_precondition_unmet — validation", () => {
  it("rejects a bad ticket_id and touches nothing", async () => {
    const r = result(await call({ ticket_id: "not a key", awaiting_ids: "TEAM-2" }));
    expect(r).toEqual({ status: "error", message: "invalid ticket_id" });
    expect(h.invokes).toHaveLength(0);
    expect(h.ddbPuts).toHaveLength(0);
  });

  it("rejects when no valid awaiting_ids survive", async () => {
    const r = result(await call({ ticket_id: "TEAM-4126", awaiting_ids: "TEAM-4126, junk" }));
    expect(r).toEqual({ status: "error", message: "no valid awaiting_ids" });
    expect(h.invokes).toHaveLength(0);
  });
});

/**
 * TEAM-4189 — a stamp that never landed must be surfaced to the caller. The stamp
 * is the ONLY evidence the orchestrator's D1 re-wake and D2 liveness clock read,
 * so a swallowed annotate failure makes a legitimately parked agent look like a
 * dead session. Every failure shape returns status "error" + stampPersisted false
 * while STILL holding the two hard invariants (no transition, no completion) and
 * still publishing the journey event — now carrying the failure.
 */
describe("report_precondition_unmet — a failed stamp is surfaced (TEAM-4189)", () => {
  const ARGS = {
    ticket_id: "TEAM-4126",
    awaiting_ids: "TEAM-4156, TEAM-4157",
    workflow_id: "wf_1",
    agent_id: "agentcore_hub_release_manager",
  };

  /** The invariants that hold on EVERY path, plus the failure-shaped event. */
  function expectSurfacedFailure(r, reason) {
    expect(r.status).toBe("error");
    expect(r.stampPersisted).toBe(false);
    expect(r.error).toContain(reason);
    expect(r.message).toContain("precondition stamp could not be written");
    expect(r.message).toContain("TEAM-4156, TEAM-4157");
    expect(r.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]); // ids preserved for the comment

    // Exactly one tickets-Lambda invoke, and it was the annotate action.
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0].tool_name).toBe("Tickets___annotate_precondition_unmet");
    // The invariants do NOT weaken on the failure path.
    expect(h.invokes.some((i) => i.tool_name === "Tickets___transition_ticket")).toBe(false);
    expect(h.puts.some((p) => String(p.Key || "").startsWith("completions/"))).toBe(false);

    // The dossier still gets the event — and can see the stamp failed.
    const event = h.ddbPuts.find((p) => p?.Item?.type === "agent.precondition_unmet");
    expect(event).toBeTruthy();
    expect(event.Item.detail.stampPersisted).toBe(false);
    expect(event.Item.detail.stampError).toContain(reason);
    expect(event.Item.detail.awaitingIds).toEqual(["TEAM-4156", "TEAM-4157"]);
  }

  it("(a) annotate returning { error } → status error, stampPersisted false, invariants intact", async () => {
    h.invokeResponder = () => ({ error: "ConditionalCheckFailedException: ticket TEAM-4126 not found" });
    expectSurfacedFailure(result(await call(ARGS)), "ConditionalCheckFailedException");
  });

  it("(b) a throwing annotate invoke → same error shape, stampError from err.message", async () => {
    h.invokeResponder = () => { throw new Error("Lambda unavailable"); };
    const r = result(await call(ARGS));
    expectSurfacedFailure(r, "Lambda unavailable");
    expect(r.error).toBe("Lambda unavailable");
  });

  it("(d) an UNHANDLED tickets-Lambda exception (FunctionError + errorMessage) is a failed stamp, not a success", async () => {
    // HTTP 200 with FunctionError and an { errorType, errorMessage } payload —
    // there is no `.error` key, so a naive check would report stampPersisted true.
    h.invokeResponder = () => ({
      payload: { errorType: "TypeError", errorMessage: "x is not a function" },
      FunctionError: "Unhandled",
    });
    expectSurfacedFailure(result(await call(ARGS)), "x is not a function");
  });

  it("(e) a throwing invoke with no message still surfaces as a failed stamp", async () => {
    // A bare `throw undefined` leaves err.message unreachable and String(err)
    // still non-empty ("undefined") — the point is that NO shape of a thrown
    // non-Error (or an Error with an empty message) is allowed to leave
    // stampError falsy, which would fall through to a "waiting" success.
    h.invokeResponder = () => { throw undefined; };
    const r = result(await call(ARGS));

    expect(r.status).toBe("error");
    expect(r.stampPersisted).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);

    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0].tool_name).toBe("Tickets___annotate_precondition_unmet");
    expect(h.invokes.some((i) => i.tool_name === "Tickets___transition_ticket")).toBe(false);
    expect(h.puts.some((p) => String(p.Key || "").startsWith("completions/"))).toBe(false);

    const event = h.ddbPuts.find((p) => p?.Item?.type === "agent.precondition_unmet");
    expect(event).toBeTruthy();
    expect(event.Item.detail.stampPersisted).toBe(false);
  });

  it("caps a stack-trace-sized stampError so it can't bloat the event or the reply", async () => {
    h.invokeResponder = () => ({ error: `boom ${"x".repeat(5000)}` });
    const r = result(await call(ARGS));
    expect(r.error.length).toBe(300);
    const event = h.ddbPuts.find((p) => p?.Item?.type === "agent.precondition_unmet");
    expect(event.Item.detail.stampError.length).toBe(300);
  });

  /**
   * TEAM-4261 (ship-review r2-F2) — the failure shapes TEAM-4189 did NOT cover,
   * because it enumerated the JIRA provider's contract.
   *
   * The DynamoDB tickets Lambda answered a handled failure with content-only text
   * (`{ content: [{ text: "Issue TEAM-404 not found." }] }`) — no `error` key, so the
   * "everything else is success" branch reported stampPersisted true and told the
   * agent it had parked. Nothing was written, so neither the D1 re-wake nor the D2
   * liveness clock had a stamp to read, and the agent was never re-woken.
   *
   * (f)/(f2) drive the REAL tickets handler, so this is the actual producer→consumer
   * pair, not a literal that could drift. (g)/(h) prove the consumer is robust on its
   * own — a tickets Lambda deployed BEFORE the F1 producer fix still answers
   * content-only, and the two Lambdas are deployed independently.
   */
  describe("(TEAM-4261) an annotate that did not stamp is never reported as a park", () => {
    /** Route the invoke into the real tickets handler, tool_name and all. */
    const throughRealTicketsLambda = () => {
      h.invokeResponder = (parsed) =>
        tickets.handler({ tool_name: parsed.tool_name, parameters: parsed.parameters });
    };

    it("(f) REAL dynamodb tickets Lambda, ticket row missing → surfaced failure, not a park", async () => {
      throughRealTicketsLambda();
      h.ticketItem = null; // GetCommand finds no item — the reproduction from the finding

      const r = result(await call(ARGS));

      expectSurfacedFailure(r, "not found");
      // The producer really did decline to write.
      expect(h.ticketUpdates).toHaveLength(0);
    });

    it("(f2) REAL dynamodb tickets Lambda, ticket present → the stamp IS reported as persisted", async () => {
      throughRealTicketsLambda();
      h.ticketItem = { ticketId: "TEAM-4126", status: "in_progress", blockedBy: [] };

      const r = result(await call(ARGS));

      // The positive check is pinned against the REAL producer, so tightening the
      // consumer cannot silently start rejecting a genuine success.
      expect(r.status).toBe("waiting");
      expect(r.stampPersisted).toBe(true);
      expect(h.ticketUpdates).toHaveLength(1);
    });

    it("(g) an OLDER deployed tickets Lambda's content-only failure is still a failed stamp", async () => {
      // The exact literal the dynamodb provider returned before TEAM-4261 F1 — see
      // lambda/agentcore-hub-tickets/precondition-contract.test.mjs for the contract
      // both providers now honour.
      h.invokeResponder = () => ({ content: [{ text: "Issue TEAM-404 not found." }] });

      const r = result(await call(ARGS));

      expectSurfacedFailure(r, "Issue TEAM-404 not found.");
      // The provider's own words reach the agent, not a bare JSON dump.
      expect(r.error).toContain("annotate returned no stamp");
    });

    it("(h) an empty payload is a failed stamp with a non-empty error", async () => {
      h.invokeResponder = () => ({});

      const r = result(await call(ARGS));

      expectSurfacedFailure(r, "annotate returned no stamp");
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
    });

    it("(i) the jira provider's real 404 failure literal is surfaced the same way", async () => {
      // jiraFetch throws `Jira API <status>: <msg>` and the Jira handler's catch
      // returns it as { error } — pinned by the same contract test.
      h.invokeResponder = () => ({
        error: "Jira API 404: Issue does not exist or you do not have permission to see it.",
      });

      expectSurfacedFailure(result(await call(ARGS)), "Jira API 404");
    });

    it("a payload whose preconditionUnmet carries no awaitingIds array is NOT a stamp", async () => {
      // The shape the fixture used before this ticket. It is not what either provider
      // returns, and it is not evidence that awaited ids were written.
      h.invokeResponder = (parsed) => ({ ticketId: parsed.parameters?.ticket_id, preconditionUnmet: {} });

      expectSurfacedFailure(result(await call(ARGS)), "annotate returned no stamp");
    });
  });
});

describe("inferToolFromArgs — awaiting_ids never routes to report_completion", () => {
  it("routes a flat-args call carrying awaiting_ids to the precondition channel, not completion", async () => {
    // Gateway flat args (no tool_name): even with a `summary` present, awaiting_ids wins.
    const r = result(await handler({ ticket_id: "TEAM-4126", awaiting_ids: "TEAM-4156", summary: "half done" }));
    expect(r.status).toBe("waiting");
    expect(h.invokes.some((i) => i.tool_name === "Tickets___transition_ticket")).toBe(false);
    expect(h.puts.some((p) => String(p.Key || "").startsWith("completions/"))).toBe(false);
  });
});
