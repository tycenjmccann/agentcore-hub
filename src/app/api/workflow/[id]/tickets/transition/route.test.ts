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
 * We mock only the seams: the S3 + Lambda clients (every command lands in ONE ordered
 * call log so relative ordering is assertable) and the two ticket readers.
 * gate-decision is left real — it is pure, and case "escalation gate" pins that the
 * new write did not disturb its DECISION defaulting.
 */

const h = vi.hoisted(() => {
  const state: {
    tickets: Array<Record<string, unknown>>;
    workflow: Record<string, unknown> | null;
    // Every S3/Lambda command, in the order the route issued them: proves the
    // PutObject happens BEFORE the tickets-Lambda InvokeCommand.
    calls: Array<{ client: "s3" | "lambda"; command: string; input: Record<string, unknown> }>;
    // Objects the fake bucket actually holds after the run — a 412 must leave it empty.
    stored: Record<string, string>;
    // When set, the next PutObject rejects with this error.
    s3PutError: Error | null;
  } = { tickets: [], workflow: { workflowId: "wf_1" }, calls: [], stored: {}, s3PutError: null };
  return { state };
});

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      h.state.calls.push({ client: "s3", command: cmd.constructor.name, input: cmd.input });
      if (h.state.s3PutError) throw h.state.s3PutError;
      h.state.stored[String(cmd.input.Key)] = String(cmd.input.Body);
      return {};
    }
  }
  return { S3Client, PutObjectCommand };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class LambdaClient {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      h.state.calls.push({ client: "lambda", command: cmd.constructor.name, input: cmd.input });
      return { Payload: Buffer.from(JSON.stringify({ status: "transitioned" })) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock("@/lib/workflow/dynamo-read", () => ({
  getWorkflowFromDynamo: vi.fn(async () => h.state.workflow),
  getTicketsForWorkflowFromDynamo: vi.fn(async () => h.state.tickets),
}));
vi.mock("@/lib/workflow/jira-read", () => ({
  getTicketsForWorkflowFromJira: vi.fn(async () => h.state.tickets),
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

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.stored = {};
  h.state.s3PutError = null;
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

const puts = () => h.state.calls.filter((c) => c.client === "s3" && c.command === "PutObjectCommand");
const invokes = () => h.state.calls.filter((c) => c.client === "lambda");

describe("transition route — completion evidence record (TEAM-4266)", () => {
  it("done + evidence + no existing record → writes completions/{ticketId}.json BEFORE the transition", async () => {
    await load();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", comment: "Closed by WM", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, ticketId: "TEAM-X", newStatus: "done", completionRecordWritten: true });

    // Exactly one PUT, at the documented key, create-only.
    expect(puts()).toHaveLength(1);
    const put = puts()[0].input;
    expect(put.Bucket).toBe("test-bucket");
    expect(put.Key).toBe("completions/TEAM-X.json");
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
    expect(h.state.calls.filter((c) => c.client === "s3")).toHaveLength(0);
    expect(json).toEqual({ success: true, ticketId: "TEAM-X", newStatus: "done" });
    expect(json).not.toHaveProperty("completionRecordWritten");
    expect(invokes()).toHaveLength(1);
  });

  it("record already exists (412 PreconditionFailed) → nothing overwritten, transition still happens", async () => {
    await load();
    const exists = new Error("At least one of the pre-conditions you specified did not hold");
    exists.name = "PreconditionFailed";
    h.state.s3PutError = exists;

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    // The create-only PUT was attempted and refused — the agent's authoritative
    // record survives (the fake bucket holds nothing our PUT could have written).
    expect(puts()).toHaveLength(1);
    expect(h.state.stored).toEqual({});
    expect(json).toMatchObject({ success: true, completionRecordWritten: false });
    expect(invokes()).toHaveLength(1);
  });

  it("non-done target with evidence → no S3 write", async () => {
    await load();
    const res = await post({ ticketId: "TEAM-X", targetStatus: "blocked", evidence: EVIDENCE });
    const json = await res.json();

    expect(h.state.calls.filter((c) => c.client === "s3")).toHaveLength(0);
    expect(json).toEqual({ success: true, ticketId: "TEAM-X", newStatus: "blocked" });
    expect(invokes()).toHaveLength(1);
  });

  it("a generic S3 failure never blocks the transition", async () => {
    await load();
    h.state.s3PutError = new Error("kaboom");

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, newStatus: "done", completionRecordWritten: false });
    expect(invokes()).toHaveLength(1);
  });

  it("ARTIFACT_BUCKET unset → skips the write, no 500", async () => {
    delete process.env.ARTIFACT_BUCKET;
    await load();

    const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: EVIDENCE });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(h.state.calls.filter((c) => c.client === "s3")).toHaveLength(0);
    expect(json).toMatchObject({ success: true, completionRecordWritten: false });
    expect(invokes()).toHaveLength(1);
  });

  it("blank/non-string evidence is ignored, not rejected", async () => {
    await load();
    for (const value of ["   ", "", 42, null]) {
      h.state.calls.length = 0;
      const res = await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: value });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(h.state.calls.filter((c) => c.client === "s3")).toHaveLength(0);
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

    expect(json).toMatchObject({ success: true, completionRecordWritten: true });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].input.Key).toBe("completions/TEAM-X.json");
  });

  it("evidence longer than the gate's own cap is truncated to 10000 chars", async () => {
    await load();
    await post({ ticketId: "TEAM-X", targetStatus: "done", evidence: "x".repeat(20000) });
    const record = JSON.parse(String(puts()[0].input.Body));
    expect(record.summary).toHaveLength(10000);
  });
});
