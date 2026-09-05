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
const verificationPuts = () => h.state.s3Puts.filter((p) => String(p.Key).includes("/shared/verifications/"));
const transitions = () => h.state.lambdaCalls.filter((c) => c.tool_name === "Tickets___transition_ticket");
const savedRecord = () => JSON.parse(completionPuts()[0].Body);
const savedVerification = () => JSON.parse(verificationPuts()[0].Body);

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

/**
 * TEAM-4099 F4 — the ONE write direction that is allowed to overwrite.
 *
 * The orchestrator's salvage path (evidence.mjs synthesizeCompletion) creates
 * completions/<tid>.json with `IfNoneMatch: "*"`, so a synthesis can never
 * clobber an agent's record. Here the reverse is intentional and unconditional:
 * an agent reporting after the salvage guessed must replace
 * `source: "synthesized"` with its own report (the done cascade's harvest then
 * promotes the task row's evidenceSource off "synthesized"). An existing
 * `source: "agent"` record means the same agent is re-reporting — last write
 * wins, as it always has.
 */
describe("TEAM-4099 F4 — real report_completion overwrites the record unconditionally", () => {
  it("writes the record with no IfNoneMatch / IfMatch precondition", async () => {
    const res = await report({
      ticket_id: "TEAM-4001", summary: "done", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    expect(res.isError).toBeFalsy();
    expect(completionPuts()).toHaveLength(1);
    expect(completionPuts()[0].IfNoneMatch).toBeUndefined();
    expect(completionPuts()[0].IfMatch).toBeUndefined();
    expect(completionPuts()[0].Key).toBe("completions/TEAM-4001.json");
  });

  it("real beats synthesized: a second, re-report still lands at the same key", async () => {
    await report({
      ticket_id: "TEAM-4001", summary: "first", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    await report({
      ticket_id: "TEAM-4001", summary: "corrected", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
    });
    const puts = completionPuts();
    expect(puts).toHaveLength(2);
    expect(puts.every((p) => p.Key === "completions/TEAM-4001.json")).toBe(true);
    expect(JSON.parse(puts[1].Body)).toMatchObject({ summary: "corrected", source: "agent" });
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

/**
 * TEAM-3992 Q4 — the SHA-pinned verification record. A re-verify ticket reports a
 * `verification` block; the Lambda persists it inside the completion record AND
 * writes a durable, idempotently-keyed record the completion gate reads without
 * racing the agentTasks harvest. A malformed block must be a HARD rejection — a
 * fix that reported garbage would otherwise look re-verified to the gate.
 */
describe("TEAM-3992 Q4 — verification record", () => {
  const SHA = "abcdef1234567890";

  it("persists verification + findings in the completion record and a durable record at the SHA-pinned key", async () => {
    const res = await report({
      ticket_id: "TEAM-4001", summary: "re-reviewed", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
      verification: { target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "review", verdict: "pass" },
      findings: [{ component: "auth", severity: "high", summary: "null deref", files: ["a.ts"] }],
    });
    expect(res.isError).toBeFalsy();
    // Completion record carries both.
    expect(savedRecord().verification).toEqual({ target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "review", verdict: "pass" });
    expect(savedRecord().findings).toHaveLength(1);
    // Durable record keyed by target + sha + kind.
    expect(verificationPuts()).toHaveLength(1);
    expect(verificationPuts()[0].Key).toBe(`workflows/wf1/shared/verifications/TEAM-3050/${SHA}.review.json`);
    const rec = savedVerification();
    expect(rec).toMatchObject({
      target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "review", verdict: "pass",
      verifier_ticket_id: "TEAM-4001", source: "agent", reported_by: "agentcore_hub_backend_dev",
    });
    expect(rec.at).toBeTruthy();
  });

  it("normalizes kind/verdict/sha case before keying the record", async () => {
    await report({
      ticket_id: "TEAM-4001", summary: "x", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
      verification: { target_ticket_id: "TEAM-3050", head_sha: "ABCDEF1", kind: "CI", verdict: "PASS" },
    });
    expect(verificationPuts()[0].Key).toBe("workflows/wf1/shared/verifications/TEAM-3050/abcdef1.ci.json");
    expect(savedVerification()).toMatchObject({ kind: "ci", verdict: "pass", head_sha: "abcdef1" });
  });

  it("carries build_id and evidence_key through when supplied", async () => {
    await report({
      ticket_id: "TEAM-4001", summary: "x", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
      verification: { target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "ci", verdict: "pass", build_id: 42, evidence_key: "k/x.log" },
    });
    expect(savedVerification()).toMatchObject({ build_id: "42", evidence_key: "k/x.log" });
  });

  it("writes verification into the completion record but NO durable record when workflow_id is absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await report({
      ticket_id: "TEAM-4001", summary: "x",
      agent_id: "agentcore_hub_backend_dev",
      verification: { target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "review", verdict: "pass" },
    });
    expect(res.isError).toBeFalsy();
    expect(savedRecord().verification).toBeTruthy();
    expect(verificationPuts()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/durable record NOT written/);
    warn.mockRestore();
  });

  for (const [label, bad] of [
    ["missing target_ticket_id", { head_sha: SHA, kind: "review", verdict: "pass" }],
    ["bad kind", { target_ticket_id: "T", head_sha: SHA, kind: "smoke", verdict: "pass" }],
    ["bad verdict", { target_ticket_id: "T", head_sha: SHA, kind: "review", verdict: "green" }],
    ["short sha", { target_ticket_id: "T", head_sha: "abc", kind: "review", verdict: "pass" }],
    ["non-hex sha", { target_ticket_id: "T", head_sha: "zzzzzzz", kind: "review", verdict: "pass" }],
    ["not an object", "review"],
  ]) {
    it(`rejects malformed verification (${label}) with no S3 write`, async () => {
      const res = await report({
        ticket_id: "TEAM-4001", summary: "x", workflow_id: "wf1",
        agent_id: "agentcore_hub_backend_dev", verification: bad,
      });
      expect(res.isError).toBe(true);
      expect(completionPuts()).toHaveLength(0);
      expect(verificationPuts()).toHaveLength(0);
      expect(transitions()).toHaveLength(0);
    });
  }

  it("does not weaken ownership — a human-gate ticket is refused even with a valid verification", async () => {
    const res = await report({
      ticket_id: "TEAM-4002", summary: "x", workflow_id: "wf1",
      agent_id: "agentcore_hub_backend_dev",
      verification: { target_ticket_id: "TEAM-3050", head_sha: SHA, kind: "review", verdict: "pass" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/REFUSED/);
    expect(completionPuts()).toHaveLength(0);
    expect(verificationPuts()).toHaveLength(0);
  });
});
