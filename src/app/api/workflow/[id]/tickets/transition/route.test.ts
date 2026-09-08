import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4266 — the completion evidence record POST /api/workflow/[id]/tickets/transition
 * writes on an out-of-band approve.
 *
 * The bug: when an agent shipped its deliverable and died before report_completion,
 * the Workflow Manager's `intervene.py mark-done --evidence "..."` recorded the proof
 * as prose only (a ticket comment + a manager.intervention event). Nothing wrote
 * completions/{ticketId}.json — the record BOTH completion evidence gates require —
 * so the run emitted workflow.completion_blocked reason=missing_evidence forever.
 *
 * This route now persists that evidence as the same record shape
 * lambda/workflow-output reportCompletion writes, create-only (IfNoneMatch "*") so an
 * agent's authoritative record is never clobbered, BEFORE the transition so the
 * orchestrator's done cascade harvests it in the same pass.
 *
 * TEAM-4282 fixes the four defects TEAM-4269 found in that change, and the fake S3
 * below grew into a real little bucket to pin them, because IfNoneMatch / IfMatch /
 * ETag semantics ARE the behaviour under test:
 *   F1  a refused transition arrives as a 200 Lambda payload (textResult in dynamodb
 *       mode, { error } in jira mode) → the route must 409 and undo its own write.
 *   F1b ticketId is an S3 key segment and, in jira mode, was never proved to belong
 *       to this workflow.
 *   F2  a non-412 write failure must fail the request, not close the ticket blind.
 *   F3  a 412 against a BLANK record (reportCompletion writes summary verbatim and
 *       unconditionally) must be filled, conditionally on the ETag just read.
 *
 * We mock only the seams: the S3 + Lambda clients (every command lands in ONE ordered
 * call log so relative ordering is assertable) and the two ticket readers.
 * gate-decision is left real — it is pure, and case "escalation gate" pins that the
 * new write did not disturb its DECISION defaulting. completion-evidence is left real
 * too: the route imports the gates' own completionRecordHasEvidence, and "has evidence"
 * must mean the same thing here as it does at the gate.
 */

const h = vi.hoisted(() => {
  const state: {
    tickets: Array<Record<string, unknown>>;
    workflow: Record<string, unknown> | null;
    // Every S3/Lambda command, in the order the route issued them: proves the
    // PutObject happens BEFORE the tickets-Lambda InvokeCommand.
    calls: Array<{ client: "s3" | "lambda"; command: string; input: Record<string, unknown> }>;
    // TEAM-4284: `calls` only sees what was SENT, so it cannot tell "no key was ever
    // built" from "a key was built and the send was skipped". These record every
    // command CONSTRUCTION — the moment `completions/${ticketId}.json` would come
    // into existence (route.ts:121) — which is the actual claim the key-shape guard
    // makes. `ctorKeys` covers all three S3 commands so a traversal cannot hide in a
    // Get/Delete either.
    ctorLog: string[];
    ctorKeys: string[];
    putCtorKeys: string[];
    // Which workflow id each ticket reader was asked for, per request. Recorded in the
    // hoisted state rather than asserted on the vi.fn, because load() calls
    // vi.resetModules() and the route therefore holds a DIFFERENT mock instance.
    jiraListCalls: string[];
    dynamoListCalls: string[];
    // The fake bucket: key -> { body, etag }. A 412 must leave it as it was.
    bucket: Record<string, { body: string; etag: string }>;
    // When set, the next PutObject rejects with this error.
    s3PutError: Error | null;
    // When set, GetObjectCommand rejects with this error.
    s3GetError: Error | null;
    // Runs right after a successful GetObjectCommand — lets a test mutate the bucket
    // in the window between the read and the conditional write, i.e. the real race.
    afterGet: (() => void) | null;
    // What the tickets Lambda replies with (dynamodb-mode success by default).
    lambdaPayload: unknown;
    // When set, getTicketsForWorkflowFromJira throws it.
    jiraListError: Error | null;
    etagSeq: number;
  } = {
    tickets: [], workflow: { workflowId: "wf_1" }, calls: [], bucket: {},
    ctorLog: [], ctorKeys: [], putCtorKeys: [], jiraListCalls: [], dynamoListCalls: [],
    s3PutError: null, s3GetError: null, afterGet: null,
    lambdaPayload: { status: "transitioned" }, jiraListError: null, etagSeq: 0,
  };
  const precondition = () => {
    const e = new Error("At least one of the pre-conditions you specified did not hold");
    e.name = "PreconditionFailed";
    return e;
  };
  const noSuchKey = () => {
    const e = new Error("The specified key does not exist.");
    e.name = "NoSuchKey";
    return e;
  };
  return { state, precondition, noSuchKey };
});

vi.mock("@aws-sdk/client-s3", () => {
  /** TEAM-4284: every construction is recorded, whether or not it is ever sent. */
  const ctor = (command: string, input: Record<string, unknown>) => {
    h.state.ctorLog.push(command);
    h.state.ctorKeys.push(String(input.Key ?? ""));
    if (command === "PutObjectCommand") h.state.putCtorKeys.push(String(input.Key ?? ""));
  };
  class PutObjectCommand {
    constructor(public input: Record<string, unknown>) { ctor("PutObjectCommand", input); }
  }
  class GetObjectCommand {
    constructor(public input: Record<string, unknown>) { ctor("GetObjectCommand", input); }
  }
  class DeleteObjectCommand {
    constructor(public input: Record<string, unknown>) { ctor("DeleteObjectCommand", input); }
  }
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      h.state.calls.push({ client: "s3", command: name, input: cmd.input });
      const key = String(cmd.input.Key);
      const held = h.state.bucket[key];

      if (name === "GetObjectCommand") {
        if (h.state.s3GetError) throw h.state.s3GetError;
        if (!held) throw h.noSuchKey();
        h.state.afterGet?.();
        return { Body: { transformToString: async () => held.body }, ETag: held.etag };
      }

      if (name === "DeleteObjectCommand") {
        // Conditional delete: only removes the exact version the caller saw.
        if (cmd.input.IfMatch !== undefined && held?.etag !== cmd.input.IfMatch) throw h.precondition();
        delete h.state.bucket[key];
        return {};
      }

      // PutObjectCommand
      if (h.state.s3PutError) throw h.state.s3PutError;
      if (cmd.input.IfNoneMatch === "*" && held) throw h.precondition();
      if (cmd.input.IfMatch !== undefined && held?.etag !== cmd.input.IfMatch) throw h.precondition();
      const etag = `"etag-${++h.state.etagSeq}"`;
      h.state.bucket[key] = { body: String(cmd.input.Body), etag };
      return { ETag: etag };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) { h.state.ctorLog.push("InvokeCommand"); }
  }
  class LambdaClient {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      h.state.calls.push({ client: "lambda", command: cmd.constructor.name, input: cmd.input });
      return { Payload: Buffer.from(JSON.stringify(h.state.lambdaPayload)) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock("@/lib/workflow/dynamo-read", () => ({
  getWorkflowFromDynamo: vi.fn(async () => h.state.workflow),
  getTicketsForWorkflowFromDynamo: vi.fn(async (id: string) => {
    h.state.dynamoListCalls.push(id);
    return h.state.tickets;
  }),
}));
vi.mock("@/lib/workflow/jira-read", () => ({
  getTicketsForWorkflowFromJira: vi.fn(async (id: string) => {
    h.state.jiraListCalls.push(id);
    if (h.state.jiraListError) throw h.state.jiraListError;
    return h.state.tickets;
  }),
}));

let POST: typeof import("./route").POST;

const SAVED = ["ARTIFACT_BUCKET", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

/** ARTIFACT_BUCKET/TICKET_PROVIDER are read at module load, so set env BEFORE loading. */
async function load() {
  vi.resetModules();
  ({ POST } = await import("./route"));
}

const EVIDENCE = "PR #87 open+green / streamed QA VERDICT: PASS";
const KEY = "completions/TEAM-X.json";

/** The refusal shapes the two ticket Lambdas actually return (both HTTP 200). */
const DDB_REFUSAL = {
  content: [{ text: 'Invalid transition "done" from status "done". Available: reopen (→ todo)' }],
};
const JIRA_REFUSAL = { error: 'No transition to "Done" found. Available: Reopen (-> To Do)' };
/** …and their success shapes — note jira's `status` is NOT "transitioned". */
const DDB_SUCCESS = { key: "TEAM-X", status: "transitioned", from: "in_progress", to: "done", transition: "Done" };
const JIRA_SUCCESS = { ticketId: "TEAM-X", status: "done", message: "Transitioned to done" };

/** Seed the fake bucket as if an agent's report_completion had already written. */
function seed(key: string, record: Record<string, unknown>, etag = '"etag-seed"') {
  h.state.bucket[key] = { body: JSON.stringify(record, null, 2), etag };
  return h.state.bucket[key].body;
}

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.ctorLog.length = 0;
  h.state.ctorKeys.length = 0;
  h.state.putCtorKeys.length = 0;
  h.state.jiraListCalls.length = 0;
  h.state.dynamoListCalls.length = 0;
  h.state.bucket = {};
  h.state.s3PutError = null;
  h.state.s3GetError = null;
  h.state.afterGet = null;
  h.state.lambdaPayload = { status: "transitioned" };
  h.state.jiraListError = null;
  h.state.etagSeq = 0;
  h.state.workflow = { workflowId: "wf_1" };
  h.state.tickets = [
    { ticketId: "TEAM-X", status: "in_progress", assignee: "agentcore_hub_backend_dev", title: "Build the thing" },
  ];
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.TICKET_PROVIDER = "dynamodb";
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function post(body: Record<string, unknown>, id = "wf_1") {
  return POST(
    new NextRequest(`http://localhost/api/workflow/${id}/tickets/transition`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: { id } }
  );
}

const s3calls = () => h.state.calls.filter((c) => c.client === "s3");
const puts = () => h.state.calls.filter((c) => c.client === "s3" && c.command === "PutObjectCommand");
const gets = () => h.state.calls.filter((c) => c.client === "s3" && c.command === "GetObjectCommand");
const dels = () => h.state.calls.filter((c) => c.client === "s3" && c.command === "DeleteObjectCommand");
const invokes = () => h.state.calls.filter((c) => c.client === "lambda");
const stored = () =>
  Object.fromEntries(Object.entries(h.state.bucket).map(([k, v]) => [k, v.body]));
/** TEAM-4284: constructed (not merely sent) commands — see h.state.ctorLog. */
const putCtors = () => h.state.putCtorKeys;
const ctorLog = () => h.state.ctorLog;

describe("transition route — completion evidence record (TEAM-4266)", () => {
  it("done + evidence + no existing record → writes completions/{ticketId}.json BEFORE the transition", async () => {
    await load();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", comment: "Closed by WM", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, ticketId: "TEAM-X", newStatus: "done", completionRecordWritten: true });

    // Exactly one PUT, at the documented key, create-only — and nothing else: a
    // clean create never reads or deletes (TEAM-4282).
    expect(puts()).toHaveLength(1);
    expect(gets()).toHaveLength(0);
    expect(dels()).toHaveLength(0);
    const put = puts()[0].input;
    expect(put.Bucket).toBe("test-bucket");
    expect(put.Key).toBe(KEY);
    expect(put.IfNoneMatch).toBe("*");
    expect(put.ContentType).toBe("application/json");

    // The record is the same shape lambda/workflow-output reportCompletion writes,
    // plus the audit fields — a non-empty `summary` is what the gate reads.
    const record = JSON.parse(String(put.Body));
    expect(record).toMatchObject({
      ticket_id: "TEAM-X",
      summary: EVIDENCE,
      artifacts: "",
      branch: null,
      commit_sha: null,
      pr_url: null,
      source: "workflow-manager",
      evidence_kind: "static",
    });
    expect(typeof record.completed_at).toBe("string");
    expect(Number.isNaN(Date.parse(record.completed_at))).toBe(false);

    // ORDERING: the record must land before the transition, because the orchestrator's
    // done cascade harvests it off the stream/webhook this transition fires.
    const putIndex = h.state.calls.findIndex((c) => c.command === "PutObjectCommand");
    const invokeIndex = h.state.calls.findIndex((c) => c.command === "InvokeCommand");
    expect(putIndex).toBeGreaterThanOrEqual(0);
    expect(invokeIndex).toBeGreaterThanOrEqual(0);
    expect(putIndex).toBeLessThan(invokeIndex);

    // The transition itself is unchanged.
    expect(JSON.parse(Buffer.from(invokes()[0].input.Payload as Uint8Array).toString())).toEqual({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-X", transition_id: "done", reason: "Closed by WM" },
    });
  });

  it("done WITHOUT evidence → no S3 write and the response shape is unchanged", async () => {
    await load();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", comment: "Approved from console" });
    const json = await res.json();

    expect(puts()).toHaveLength(0);
    expect(s3calls()).toHaveLength(0);
    expect(json).toEqual({ success: true, ticketId: "TEAM-X", newStatus: "done" });
    expect(json).not.toHaveProperty("completionRecordWritten");
    expect(invokes()).toHaveLength(1);
  });

  it("non-done target with evidence → no S3 write", async () => {
    await load();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "blocked", evidence: EVIDENCE });
    const json = await res.json();

    expect(s3calls()).toHaveLength(0);
    expect(json).toEqual({ success: true, ticketId: "TEAM-X", newStatus: "blocked" });
    expect(invokes()).toHaveLength(1);
  });

  it("blank/non-string evidence is ignored, not rejected", async () => {
    await load();
    for (const value of ["   ", "", 42, null]) {
      h.state.calls.length = 0;
      const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: value });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(s3calls()).toHaveLength(0);
      expect(json).not.toHaveProperty("completionRecordWritten");
    }
  });

  it("an escalation gate still gets its defaulted DECISION, and the record is written too", async () => {
    await load();
    h.state.tickets = [
      {
        ticketId: "TEAM-G",
        status: "in_progress",
        assignee: "agentcore_hub_release_manager",
        title: "Escalation #2: ship-review not converging",
      },
    ];

    const res = await post({ ticketId: "TEAM-G", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(json).toMatchObject({
      success: true,
      decisionDefaulted: "merge-with-known-findings",
      completionRecordWritten: true,
    });
    expect(puts()).toHaveLength(1);
    // The defaulted DECISION still reaches the tickets Lambda as the reason.
    const payload = JSON.parse(Buffer.from(invokes()[0].input.Payload as Uint8Array).toString());
    expect(payload.parameters.reason).toContain("DECISION: merge-with-known-findings");
  });

  it("jira mode takes the same path (no DDB pre-check, record still written)", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    // TEAM-4282 F1b: TEAM-X IS in the workflow's Jira tickets, so the ownership
    // proof resolves and the write proceeds exactly as before.
    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].input.Key).toBe(KEY);
  });

  it("evidence longer than the gate's own cap is truncated to 10000 chars", async () => {
    await load();
    await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: "x".repeat(20000) });
    const record = JSON.parse(String(puts()[0].input.Body));
    expect(record.summary).toHaveLength(10000);
  });
});

/**
 * TEAM-4282 F1 — a refused transition is reported INSIDE a 200 Lambda payload
 * (lambda/agentcore-hub-tickets/index.mjs:748 textResult / agentcore-hub-jira
 * index.mjs:1074 { error }), so checking response.FunctionError alone reported
 * success:true for a ticket that never moved AND left the evidence record behind.
 */
describe("transition route — a refused transition is not a success (TEAM-4282 F1)", () => {
  it("dynamodb-mode textResult refusal → 409 and the record this call created is deleted", async () => {
    await load();
    h.state.lambdaPayload = DDB_REFUSAL;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).not.toHaveProperty("success");
    expect(json.error).toBe("Ticket transition rejected");
    expect(json.details).toContain("Invalid transition");
    expect(json).toMatchObject({
      ticketId: "TEAM-X", targetStatus: "done",
      completionRecordWritten: false, completionRecordReverted: true,
    });

    // The orphan is compensated with a CONDITIONAL delete on the version we wrote.
    expect(puts()).toHaveLength(1);
    expect(dels()).toHaveLength(1);
    expect(dels()[0].input).toMatchObject({ Bucket: "test-bucket", Key: KEY, IfMatch: '"etag-1"' });
    expect(stored()).toEqual({});
  });

  it("jira-mode { error } refusal → 409 and the record this call created is deleted", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.lambdaPayload = JIRA_REFUSAL;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe("Ticket transition rejected");
    expect(json.details).toContain('No transition to "Done" found');
    expect(json).toMatchObject({ completionRecordWritten: false, completionRecordReverted: true });
    expect(dels()).toHaveLength(1);
    expect(dels()[0].input.IfMatch).toBe('"etag-1"');
    expect(stored()).toEqual({});
  });

  it("a refusal with NO evidence → 409 with zero S3 traffic (detection is independent of the write)", async () => {
    await load();
    h.state.lambdaPayload = DDB_REFUSAL;
    // in_progress → in_review is legal locally; the Lambda is what refuses.
    h.state.tickets = [{ ticketId: "TEAM-X", status: "in_progress", assignee: "human:reviewer", title: "Gate" }];

    const res = await post({ ticketId: "TEAM-X", targetStatus: "in_review" });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe("Ticket transition rejected");
    expect(json).not.toHaveProperty("completionRecordWritten");
    expect(json).not.toHaveProperty("completionRecordReverted");
    expect(s3calls()).toHaveLength(0);
  });

  it("positive control: the dynamodb success payload is still a success", async () => {
    await load();
    h.state.lambdaPayload = DDB_SUCCESS;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(dels()).toHaveLength(0);
    expect(Object.keys(stored())).toEqual([KEY]);
  });

  it("positive control: the jira success payload (status \"done\", not \"transitioned\") is a success", async () => {
    // The regression guard for a success ALLOW-list: a `status === "transitioned"`
    // check would 409 here and delete a record for a ticket that really did move.
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.lambdaPayload = JIRA_SUCCESS;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(dels()).toHaveLength(0);
    expect(Object.keys(stored())).toEqual([KEY]);
  });

  it("refusal after a 412 kept somebody else's record → NO DeleteObject", async () => {
    await load();
    const body = seed(KEY, { ticket_id: "TEAM-X", summary: "agent shipped PR #87", pr_url: "https://x/pr/87" });
    h.state.lambdaPayload = DDB_REFUSAL;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ completionRecordWritten: false, completionRecordReverted: false });
    // This call wrote nothing, so it may not remove anything.
    expect(dels()).toHaveLength(0);
    expect(stored()).toEqual({ [KEY]: body });
  });

  it("refusal after FILLING a blank record → the original bytes are restored, not deleted", async () => {
    await load();
    const original = seed(KEY, {
      ticket_id: "TEAM-X", summary: "", artifacts: "", branch: "feature/TEAM-X",
      commit_sha: null, pr_url: null, completed_at: "2026-09-01T00:00:00.000Z",
    });
    h.state.lambdaPayload = JIRA_REFUSAL;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ completionRecordWritten: false, completionRecordReverted: true });
    // create-only PUT (412) → refill PUT → restore PUT; never a delete, because the
    // record pre-existed this call.
    expect(puts()).toHaveLength(3);
    expect(dels()).toHaveLength(0);
    expect(puts()[2].input.IfMatch).toBe('"etag-1"'); // the version our refill wrote
    expect(stored()).toEqual({ [KEY]: original });
  });
});

/**
 * TEAM-4282 F1b — ticketId becomes an S3 key segment, and in jira mode nothing
 * proved it belongs to THIS workflow before PR #430 used it.
 */
describe("transition route — ticketId shape + ownership (TEAM-4282 F1b)", () => {
  it.each([
    "../../etc/passwd",
    // TEAM-4284: QA's own probe id, pinned here alongside the original vectors.
    "../../evil/TEAM-9999",
    "a/b",
    "has space",
    "__COUNTER__",
    "TEAM-X.json",
    "",
  ])(
    "rejects ticketId %j with 400 and no AWS traffic",
    async (bad) => {
      await load();
      const res = await post({ ticketId: bad, targetStatus: "done", evidence: EVIDENCE });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toMatch(/ticketId/);
      expect(s3calls()).toHaveLength(0);
      expect(invokes()).toHaveLength(0);
      // TEAM-4284: nothing was even CONSTRUCTED, so no key was ever built.
      expect(putCtors()).toEqual([]);
    }
  );

  it("accepts the id shapes the system actually mints", async () => {
    await load();
    for (const good of ["TEAM-4266", "AGENTCORE-1", "B2", "CLEAN-1", "wf_1-3"]) {
      h.state.calls.length = 0;
      h.state.bucket = {};
      h.state.tickets = [{ ticketId: good, status: "in_progress", assignee: "dev", title: "t" }];
      const res = await post({ ticketId: good, targetStatus: "done", evidence: EVIDENCE });
      expect(res.status).toBe(200);
      expect(puts()[0].input.Key).toBe(`completions/${good}.json`);
    }
  });

  it("jira mode + evidence, ticket not in this workflow → 404, no PUT, no transition", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.tickets = [{ ticketId: "OTHER-9", status: "in_progress", assignee: "dev", title: "someone else's" }];

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ error: "Ticket not found" });
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
  });

  it("jira mode + evidence, the ownership lookup THROWS → 502 fail-closed, no PUT, no transition", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.jiraListError = new Error("Jira search failed: 503 Service Unavailable");

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toBe("could not verify the ticket belongs to this workflow");
    expect(json.details).toContain("503");
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
  });

  it("jira mode WITHOUT evidence keeps the best-effort lookup: a throw never blocks the approve", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.jiraListError = new Error("Jira search failed: 503 Service Unavailable");

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", comment: "Approved from console" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, newStatus: "done" });
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(1);
  });
});

/**
 * TEAM-4282 F2 — the write is no longer best-effort. Closing the ticket with no
 * record is unrecoverable: mark-done again is a done→done the Lambda refuses.
 */
describe("transition route — a failed evidence write blocks the transition (TEAM-4282 F2)", () => {
  it("a non-412 S3 failure with evidence → 502 and the transition never fires", async () => {
    await load();
    h.state.s3PutError = new Error("kaboom");

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "completion evidence record write failed", details: "kaboom" });
    expect(invokes()).toHaveLength(0);
  });

  it("ARTIFACT_BUCKET unset with evidence → fails closed with a self-diagnosing message", async () => {
    delete process.env.ARTIFACT_BUCKET;
    await load();

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json).toEqual({
      error: "completion evidence record write failed",
      details: "ARTIFACT_BUCKET is not configured",
    });
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
  });

  it("ARTIFACT_BUCKET unset WITHOUT evidence → unaffected, the approve still lands", async () => {
    delete process.env.ARTIFACT_BUCKET;
    await load();

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", comment: "Approved from console" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, ticketId: "TEAM-X", newStatus: "done" });
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(1);
  });

  it("a failed READ of the existing record also fails closed", async () => {
    await load();
    seed(KEY, { ticket_id: "TEAM-X", summary: "" });
    h.state.s3GetError = new Error("AccessDenied");

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json).toEqual({ error: "completion evidence record write failed", details: "AccessDenied" });
    expect(invokes()).toHaveLength(0);
  });
});

/**
 * TEAM-4282 F3 — a 412 is not automatically "the agent's record wins".
 * reportCompletion (lambda/workflow-output) writes `summary` verbatim and PUTs
 * unconditionally, so an agent can leave an all-blank record that is NOT evidence
 * per completionRecordHasEvidence yet 412s the create-only PUT forever.
 */
describe("transition route — 412 fill-if-blank (TEAM-4282 F3)", () => {
  it("existing record has evidence → read it, keep it, transition anyway", async () => {
    await load();
    const body = seed(KEY, {
      ticket_id: "TEAM-X", summary: "agent shipped it", artifacts: "", branch: "feature/TEAM-X",
      commit_sha: "abc1234", pr_url: "https://github.com/x/y/pull/87",
    });

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    // The create-only PUT was attempted and refused; we read the record, saw real
    // evidence, and wrote nothing — the agent's authoritative record survives.
    expect(puts()).toHaveLength(1);
    expect(gets()).toHaveLength(1);
    expect(stored()).toEqual({ [KEY]: body });
    expect(json).toMatchObject({ success: true, completionRecordWritten: false });
    expect(invokes()).toHaveLength(1);
  });

  it("existing record is BLANK → refilled with IfMatch on the ETag just read", async () => {
    await load();
    seed(KEY, {
      ticket_id: "TEAM-X", summary: "", artifacts: "", branch: "feature/TEAM-X",
      commit_sha: null, pr_url: null, completed_at: "2026-09-01T00:00:00.000Z",
    });

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(puts()).toHaveLength(2);
    expect(gets()).toHaveLength(1);
    // Conditional on exactly the version we read, so a real agent record landing in
    // between wins instead of being clobbered.
    expect(puts()[1].input.IfMatch).toBe('"etag-seed"');
    expect(puts()[1].input.IfNoneMatch).toBeUndefined();

    const merged = JSON.parse(stored()[KEY]);
    expect(merged).toMatchObject({
      ticket_id: "TEAM-X",
      summary: EVIDENCE,
      source: "workflow-manager",
      evidence_kind: "static",
      branch: "feature/TEAM-X",              // non-evidence field preserved
      completed_at: "2026-09-01T00:00:00.000Z", // the agent's own timestamp preserved
    });
    // And the filled record now satisfies the gate.
    const { completionRecordHasEvidence } = await import("@/lib/workflow/completion-evidence");
    expect(completionRecordHasEvidence(merged)).toBe(true);
  });

  it("a concurrent agent record lands during the refill (IfMatch 412) → it wins", async () => {
    await load();
    seed(KEY, { ticket_id: "TEAM-X", summary: "" }, '"etag-stale"');
    // The race, exactly as S3 serialises it: our GET sees the blank record, then the
    // agent's real report_completion lands, so our IfMatch refill is refused.
    let winner = "";
    h.state.afterGet = () => {
      winner = seed(KEY, { ticket_id: "TEAM-X", summary: "the real thing" }, '"etag-newer"');
      h.state.afterGet = null;
    };

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, completionRecordWritten: false });
    // Two PUTs attempted (create-only, then the refill), both refused; the agent's
    // record is untouched and no revert is owed.
    expect(puts()).toHaveLength(2);
    expect(dels()).toHaveLength(0);
    expect(stored()).toEqual({ [KEY]: winner });
    expect(invokes()).toHaveLength(1);
  });

  it("an unparseable existing record is not evidence → refilled", async () => {
    await load();
    h.state.bucket[KEY] = { body: "not json at all", etag: '"etag-junk"' };

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(puts()).toHaveLength(2);
    expect(puts()[1].input.IfMatch).toBe('"etag-junk"');
    expect(JSON.parse(stored()[KEY])).toMatchObject({ ticket_id: "TEAM-X", summary: EVIDENCE });
  });

  it("the record vanishes between the create-only PUT and the read → nothing written, transition proceeds", async () => {
    await load();
    // 412 on the create-only PUT, then a 404 on the read.
    h.state.s3PutError = h.precondition();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, completionRecordWritten: false });
    expect(gets()).toHaveLength(1);
    expect(stored()).toEqual({});
    expect(invokes()).toHaveLength(1);
  });
});

/**
 * TEAM-4284 (QA F3 pin) — the QA battery for TEAM-4266 probed the route with
 * `ticketId: "../../evil/TEAM-9999"` and with a well-formed id belonging to another
 * run, in BOTH ticket-provider modes, because on 4f20dd5 the id went straight into
 * `completions/${ticketId}.json` (route.ts:121) with no shape check and — in jira mode
 * — no proof of workflow ownership. TEAM-4282 closed both holes (TICKET_ID_RE at
 * route.ts:33 checked at :338; the jira ownership gate at :428-440). Nothing here
 * changes route.ts: these are the missing PINS, so the guard cannot be deleted
 * silently.
 *
 * Two things make these stronger than the pre-existing cases above:
 *
 *  1. They assert on CONSTRUCTIONS (h.state.putCtorKeys / ctorLog), not sends. "The
 *     evidence key was never built" is the actual security claim; "no PutObject was
 *     sent" is only a consequence of it.
 *  2. Every hostile id is SEEDED INTO the mocked ticket list, so the ownership check
 *     would happily pass it. That leaves the key-shape guard as the only thing that
 *     can refuse — without the seeding these tests would still go green against a
 *     build with no shape guard at all, via the ownership 404 (and the dynamodb
 *     ownership check predates TEAM-4282 entirely).
 */
describe("TEAM-4284: ticketId can never reach an S3 key (QA F3 pin, both provider modes)", () => {
  /** QA's fixture: the two tickets that really do belong to the run under test. */
  const QA_TICKETS = [
    { ticketId: "TEAM-4237", status: "in_progress", assignee: "agentcore_hub_backend_dev", title: "Implement the thing" },
    { ticketId: "TEAM-4273", status: "in_progress", assignee: "agentcore_hub_qa", title: "Verify the thing" },
  ];
  const QA_EVIDENCE = "PR #23 review posted";
  const TRAVERSAL_ID = "../../evil/TEAM-9999";
  /** A ticket row for `id`, so ownership cannot be what refuses the request. */
  const seedTicket = (id: string) => ({
    ticketId: id,
    status: "in_progress",
    assignee: "agentcore_hub_backend_dev",
    title: "seeded so the ownership check passes",
  });

  it("TEAM-4284: jira mode — a well-formed ticketId from another workflow is refused before any write", async () => {
    process.env.TICKET_PROVIDER = "jira"; // read at module load (route.ts:19) — set BEFORE load()
    await load();
    h.state.tickets = QA_TICKETS; // TEAM-9999 is NOT one of them

    const res = await post({ ticketId: "TEAM-9999", targetStatus: "done", evidence: QA_EVIDENCE });
    const json = await res.json();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(404); // route.ts:438 — the same answer dynamodb mode gives
    expect(json).toEqual({ error: "Ticket not found" });

    // The ownership proof really ran; the 404 is not an accident of some earlier check.
    expect(h.state.jiraListCalls).toEqual(["wf_1"]);
    expect(putCtors()).toEqual([]);
    expect(ctorLog()).toEqual([]);
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(stored()).toEqual({});
  });

  it("TEAM-4284: jira mode — \"../../evil/TEAM-9999\" is refused by the SHAPE guard, not by ownership", async () => {
    process.env.TICKET_PROVIDER = "jira";
    await load();
    h.state.tickets = [seedTicket(TRAVERSAL_ID), ...QA_TICKETS];

    const res = await post({ ticketId: TRAVERSAL_ID, targetStatus: "done", evidence: QA_EVIDENCE });
    const json = await res.json();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(400); // route.ts:338
    expect(json.error).toMatch(/ticketId/);

    // No key was ever BUILT — not for a Put, not for a Get, not for a Delete.
    expect(putCtors()).toEqual([]);
    expect(h.state.ctorKeys.some((k) => k.includes("evil"))).toBe(false);
    expect(h.state.ctorKeys).toEqual([]);
    expect(ctorLog()).toEqual([]);
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(stored()).toEqual({});
    // The guard sits so early (before route.ts:354/:400) that Jira was never queried.
    expect(h.state.jiraListCalls).toEqual([]);
  });

  it("TEAM-4284: dynamodb mode — \"../../evil/TEAM-9999\" is refused by the SHAPE guard, not by ownership", async () => {
    await load(); // TICKET_PROVIDER = "dynamodb" from beforeEach
    h.state.tickets = [seedTicket(TRAVERSAL_ID), ...QA_TICKETS];

    const res = await post({ ticketId: TRAVERSAL_ID, targetStatus: "done", evidence: QA_EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/ticketId/);
    expect(putCtors()).toEqual([]);
    expect(h.state.ctorKeys.some((k) => k.includes("evil"))).toBe(false);
    expect(ctorLog()).toEqual([]);
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(stored()).toEqual({});
    // The shape guard (route.ts:338) precedes the provider branch (route.ts:363).
    expect(h.state.dynamoListCalls).toEqual([]);
  });

  it("TEAM-4284: dynamodb mode — a foreign well-formed ticketId is 404 Ticket not found before any write", async () => {
    await load();
    h.state.tickets = QA_TICKETS;

    const res = await post({ ticketId: "TEAM-9999", targetStatus: "done", evidence: QA_EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(404); // route.ts:367
    expect(json).toEqual({ error: "Ticket not found" });
    expect(h.state.dynamoListCalls).toEqual(["wf_1"]);
    expect(putCtors()).toEqual([]);
    expect(ctorLog()).toEqual([]);
    expect(s3calls()).toHaveLength(0);
    expect(invokes()).toHaveLength(0);
    expect(stored()).toEqual({});
  });

  /**
   * Property-style: no hostile id, in either mode, may ever produce a constructed
   * evidence key. Each id is seeded into the mocked list first (see the describe
   * header), so the shape guard is the only possible refuser.
   */
  const HOSTILE_IDS = [TRAVERSAL_ID, "TEAM-1/..", "..", "completions/x", "TEAM-1%2F..", "TEAM-1?x", "", "   "];
  const MODES = ["dynamodb", "jira"] as const;

  it.each(MODES.flatMap((mode) => HOSTILE_IDS.map((id) => [mode, id] as [string, string])))(
    "TEAM-4284: %s mode rejects ticketId %j with no evidence key ever constructed",
    async (mode, hostile) => {
      process.env.TICKET_PROVIDER = mode;
      await load();
      h.state.tickets = [seedTicket(hostile), ...QA_TICKETS];

      const res = await post({ ticketId: hostile, targetStatus: "done", evidence: QA_EVIDENCE });
      const json = await res.json();

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(json.error).toMatch(/ticketId/);
      expect(putCtors()).toEqual([]);
      expect(h.state.ctorKeys).toEqual([]);
      expect(ctorLog()).toEqual([]);
      expect(s3calls()).toHaveLength(0);
      expect(invokes()).toHaveLength(0);
      expect(stored()).toEqual({});
    }
  );
});
