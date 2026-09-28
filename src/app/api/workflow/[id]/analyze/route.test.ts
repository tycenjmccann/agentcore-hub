import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5240 — POST /analyze mints the attemptId the panel polls for: the same
 * id goes to the analyzer Lambda (which writes it on workflow.analysis_failed)
 * and back to the caller in the 202 body.
 */

const h = vi.hoisted(() => ({ invokes: [] as Array<Record<string, unknown>>, phase: "complete" }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Item: { phase: h.phase } }) }) },
  };
});
vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class LambdaClient {
    async send(cmd: InvokeCommand) {
      h.invokes.push(cmd.input);
      return {};
    }
  }
  return { LambdaClient, InvokeCommand };
});

let POST: (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;

beforeEach(async () => {
  h.invokes = [];
  h.phase = "complete";
  vi.resetModules();
  ({ POST } = await import("./route"));
});

const call = () =>
  POST(new NextRequest("http://localhost/api/workflow/wf_1/analyze", { method: "POST" }), { params: { id: "wf_1" } });

describe("POST /analyze attemptId (TEAM-5240)", () => {
  it("returns the attemptId it passed to the analyzer", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.invokes).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(h.invokes[0].Payload as Uint8Array).toString());
    expect(payload).toEqual({ workflowId: "wf_1", trigger: "manual", attemptId: body.attemptId });
  });

  it("mints a fresh attemptId per click", async () => {
    const a = (await (await call()).json()).attemptId;
    const b = (await (await call()).json()).attemptId;
    expect(a).not.toBe(b);
  });
});
