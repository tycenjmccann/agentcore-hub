/**
 * TEAM-3991 F17/F18 — report_completion ownership + source stamping (first test
 * file for this Lambda).
 *
 * Drives the REAL `handler` export with the AWS SDK clients mocked at the module
 * seam (same vi.mock + vi.hoisted shape as
 * lambda/agentcore-hub-pipeline-tools/index.test.mjs), so both guards are
 * exercised on the actual tool path with no AWS and no credentials.
 *
 * Pinned defects:
 *  1. (F18) `source` came from the caller's argument bag. The completion record
 *     is the evidence a later gate reads, and `source` is what separates an
 *     agent's own claim from a human's mark-done — so a caller could launder its
 *     claim into an operator attestation. Now: server-stamped "agent", last.
 *  2. (F17) No ownership check at all: any agent holding the tool could close
 *     ANY ticket in the run, including a `human:*` review gate — the exact
 *     false-green the gate exists to prevent. Now: refuse before any S3 write or
 *     ticket transition when the assignee is human, or when the caller's
 *     agent_id differs from the assignee. An unavailable lookup logs
 *     ownership_unverified and proceeds (an infra blip must not block real work).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    s3Puts: [], // { Bucket, Key, Body }
    lambdaCalls: [], // { tool_name, parameters }
    ddbPuts: [],
    // Per-ticket assignee/status the mocked Tickets Lambda answers with.
    tickets: {},
    // When set, Tickets___get_issue throws (lookup unavailable).
    getIssueThrows: false,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.__type === "PutObject") {
        h.state.s3Puts.push(cmd.input);
        return {};
      }
      if (cmd.__type === "ListObjectsV2") return { Contents: [] };
      if (cmd.__type === "GetObject") throw new Error("NoSuchKey");
      return {};
    }
  },
  PutObjectCommand: class { constructor(i) { this.input = i; this.__type = "PutObject"; } },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; this.__type = "ListObjectsV2"; } },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://example.invalid/presigned",
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const body = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.state.lambdaCalls.push(body);
      if (body.tool_name === "Tickets___get_issue") {
        if (h.state.getIssueThrows) throw new Error("Lambda unreachable");
        const t = h.state.tickets[body.parameters.ticket_id];
        const payload = t
          ? { key: body.parameters.ticket_id, fields: { status: { name: t.status || "in_progress" }, assignee: { displayName: t.assignee } } }
          : { content: [{ type: "text", text: "Ticket not found" }] };
        return { Payload: Buffer.from(JSON.stringify(payload)) };
      }
      return { Payload: Buffer.from(JSON.stringify({ ok: true })) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ async send(cmd) { h.state.ddbPuts.push(cmd.input); return {}; } }) },
  PutCommand: class { constructor(i) { this.input = i; } },
}));

const { handler } = await import("./index.mjs");

/** Invoke report_completion the way the runtime's tool bridge does. */
async function report(args) {
  return handler({ name: "WorkflowOutput___report_completion", arguments: args });
}

const completionPuts = () => h.state.s3Puts.filter((p) => String(p.Key).startsWith("completions/"));
const transitions = () => h.state.lambdaCalls.filter((c) => c.tool_name === "Tickets___transition_ticket");
const savedRecord = () => JSON.parse(completionPuts()[0].Body);

beforeEach(() => {
  h.state.s3Puts = [];
  h.state.lambdaCalls = [];
  h.state.ddbPuts = [];
  h.state.getIssueThrows = false;
  h.state.tickets = {
    "TEAM-4001": { assignee: "agentcore_hub_backend_dev", status: "in_progress" },
    "TEAM-4002": { assignee: "human:tycen", status: "in_review" },
  };
});

describe("F18 — source is server-stamped, never taken from the caller", () => {
  it("stamps source:agent on an ordinary report", async () => {
    const res = await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    expect(res.isError).toBeFalsy();
    expect(savedRecord().source).toBe("agent");
    expect(savedRecord().reported_by).toBe("agentcore_hub_backend_dev");
  });

  it("overwrites a caller-supplied source:manager — the laundering path", async () => {
    // The whole point of F18: an agent that can write source:"manager" can pass
    // its own claim off as an operator's attestation to a downstream gate.
    await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev", source: "manager",
    });
    expect(savedRecord().source).toBe("agent");
  });

  it("overwrites a caller-supplied reported_by too", async () => {
    await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev", reported_by: "human:tycen",
    });
    expect(savedRecord().reported_by).toBe("agentcore_hub_backend_dev");
  });
});

describe("F17 — a report must come from the ticket's own assignee", () => {
  it("refuses a human-gate ticket with no write and no transition", async () => {
    const res = await report({
      ticket_id: "TEAM-4002", summary: "gate approved by me, honest",
      workflow_id: "wf1", agent_id: "agentcore_hub_backend_dev",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/REFUSED/);
    expect(res.content[0].text).toMatch(/human:tycen/);
    expect(completionPuts()).toHaveLength(0);
    expect(transitions()).toHaveLength(0);
  });

  it("refuses a human-gate ticket even when agent_id is omitted", async () => {
    const res = await report({ ticket_id: "TEAM-4002", summary: "x", workflow_id: "wf1" });
    expect(res.isError).toBe(true);
    expect(completionPuts()).toHaveLength(0);
    expect(transitions()).toHaveLength(0);
  });

  it("refuses when the caller is not the assignee", async () => {
    const res = await report({
      ticket_id: "TEAM-4001", summary: "closing someone else's work",
      workflow_id: "wf1", agent_id: "agentcore_hub_qa_verifier",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/assigned to agentcore_hub_backend_dev, not agentcore_hub_qa_verifier/);
    expect(completionPuts()).toHaveLength(0);
    expect(transitions()).toHaveLength(0);
  });

  it("allows the assignee through and still transitions the ticket", async () => {
    const res = await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev", branch: "feature/TEAM-4001", commit_sha: "abc1234",
    });
    expect(res.isError).toBeFalsy();
    expect(completionPuts()).toHaveLength(1);
    expect(transitions()).toHaveLength(1);
    expect(savedRecord().branch).toBe("feature/TEAM-4001");
  });

  it("proceeds with ownership_unverified when the lookup is unavailable", async () => {
    // An infra blip on the tickets Lambda must not strand a legitimate
    // completion — the check is skipped, but loudly.
    h.state.getIssueThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    expect(res.isError).toBeFalsy();
    expect(completionPuts()).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ownership_unverified/);
    warn.mockRestore();
  });

  it("proceeds with ownership_unverified when the ticket is unknown to the provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await report({
      ticket_id: "TEAM-9999", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    expect(res.isError).toBeFalsy();
    expect(completionPuts()).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ownership_unverified/);
    warn.mockRestore();
  });

  it("proceeds with ownership_unverified when agent_id is absent on an agent ticket", async () => {
    // Older fleet callers omit agent_id; the report cannot be attributed, so it
    // is allowed but recorded as unverifiable rather than silently trusted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await report({ ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1" });
    expect(res.isError).toBeFalsy();
    expect(completionPuts()).toHaveLength(1);
    expect(savedRecord().reported_by).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ownership_unverified/);
    warn.mockRestore();
  });

  it("checks ownership BEFORE writing — the lookup is the first Tickets call", async () => {
    await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    expect(h.state.lambdaCalls[0].tool_name).toBe("Tickets___get_issue");
    expect(h.state.lambdaCalls[0].parameters.ticket_id).toBe("TEAM-4001");
  });
});
