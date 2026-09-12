import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4498 — POST /api/workflow/[id]/agent-chat.
 *
 * The four things this route must never get wrong, in order of blast radius:
 *  1. It must not chat with a BUSY agent (that's the mailbox's job) — the idle
 *     guard is the whole feature.
 *  2. It must not send `workflow_id` (or `detach`) to the runtime: the runtime
 *     publishes agent.started unconditionally when a workflow_id is present, so
 *     a chat would forge a dispatch into the run's event stream and convince the
 *     board and the stale detector that the persona had restarted.
 *  3. It must reject un-vetted ids BEFORE touching AWS.
 *  4. It must not hand upstream failure text (account ids, ARNs) to the browser.
 *
 * Only the two seams are mocked — the DynamoDB reads and the runtime invoker.
 * The idle predicate, the persona roster and the prompt are the real ones.
 */

const h = vi.hoisted(() => {
  const state: {
    workflow: Record<string, unknown> | null;
    invocation: { sessionId: string; runtimeArn: string | null; ticketId: string | null; timestamp: string | null } | null;
    workflowReads: string[];
    invokes: Array<{ agentRuntimeArn: string; prompt: string; sessionId: string; payloadFormat?: string }>;
    upstreamFrames: string[];
    discoverCalls: number;
  } = {
    workflow: null,
    invocation: null,
    workflowReads: [],
    invokes: [],
    upstreamFrames: ['data: {"type":"text","content":"ok"}', 'data: {"type":"done"}'],
    discoverCalls: 0,
  };
  return { state };
});

vi.mock("@/lib/workflow/dynamo-read", () => ({
  getWorkflowFromDynamo: async (id: string) => {
    h.state.workflowReads.push(id);
    return h.state.workflow;
  },
  getLatestAgentInvocation: async () => h.state.invocation,
}));

vi.mock("@/lib/agentcore-sdk", () => ({
  DEFAULT_REGION: "us-east-1",
  discoverAgents: async () => {
    h.state.discoverCalls++;
    return [{ id: "a", name: "agentcore_hub_agent", arn: "arn:discovered", type: "runtime", status: "READY" }];
  },
  invokeAgentRuntime: async (params: { agentRuntimeArn: string; prompt: string; sessionId: string; payloadFormat?: string }) => {
    h.state.invokes.push(params);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of h.state.upstreamFrames) controller.enqueue(encoder.encode(`${frame}\n\n`));
        controller.close();
      },
    });
  },
}));

const { POST, GET } = await import("./route");

const PERSONA = "agentcore_hub_code_reviewer";

function workflowWith(status: string) {
  return {
    id: "wf-1",
    phase: "review",
    input: { title: "Idle chat" },
    agentTasks: {
      "TEAM-1": { agentId: PERSONA, ticketId: "TEAM-1", status, startedAt: "2026-09-12T00:00:00Z" },
    },
  };
}

function post(body: unknown, id = "wf-1") {
  return POST(
    new NextRequest(`http://localhost/api/workflow/${id}/agent-chat`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: { id } }
  );
}

async function readBody(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

beforeEach(() => {
  h.state.workflow = workflowWith("complete");
  h.state.invocation = {
    sessionId: "TEAM-1_wf-1-agentcore_hub_code_reviewer-1757000000000",
    runtimeArn: "arn:recorded",
    ticketId: "TEAM-1",
    timestamp: "2026-09-12T00:10:00Z",
  };
  h.state.workflowReads = [];
  h.state.invokes = [];
  h.state.discoverCalls = 0;
  h.state.upstreamFrames = ['data: {"type":"text","content":"ok"}', 'data: {"type":"done"}'];
});

describe("idle guard", () => {
  it.each(["running", "waiting_response"])("refuses a %s agent with 409 agent_active", async (status) => {
    h.state.workflow = workflowWith(status);
    const res = await post({ agentId: PERSONA, message: "hi" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent_active");
    expect(h.state.invokes).toHaveLength(0);
  });

  it.each(["complete", "error", "pending"])("allows a %s agent", async (status) => {
    h.state.workflow = workflowWith(status);
    const res = await post({ agentId: PERSONA, message: "hi" });
    expect(res.status).toBe(200);
    expect(h.state.invokes).toHaveLength(1);
  });

  it("refuses when ANY of the persona's tickets is live (rework round in flight)", async () => {
    h.state.workflow = {
      ...workflowWith("complete"),
      agentTasks: {
        "TEAM-1": { agentId: PERSONA, ticketId: "TEAM-1", status: "complete", startedAt: "2026-09-12T00:00:00Z" },
        "TEAM-2": { agentId: PERSONA, ticketId: "TEAM-2", status: "running", startedAt: "2026-09-12T01:00:00Z" },
      },
    };
    const res = await post({ agentId: PERSONA, message: "hi" });
    expect(res.status).toBe(409);
  });
});

describe("runtime payload", () => {
  it("carries no workflow_id and no detach, and resumes the recorded session on the recorded runtime", async () => {
    await post({ agentId: PERSONA, message: "why did you reject it?" });
    const [invoke] = h.state.invokes;
    expect(invoke.payloadFormat).toBe("custom");
    expect(invoke.agentRuntimeArn).toBe("arn:recorded");
    expect(invoke.sessionId).toBe(h.state.invocation!.sessionId);

    const payload = JSON.parse(invoke.prompt);
    expect(Object.keys(payload).sort()).toEqual(["agent_id", "prompt", "ticket_id"]);
    expect(payload).not.toHaveProperty("workflow_id");
    expect(payload).not.toHaveProperty("detach");
    expect(payload.agent_id).toBe(PERSONA);
    expect(payload.ticket_id).toBe("TEAM-1");
    // Read-only framing plus the operator's actual question.
    expect(payload.prompt).toContain("[operator-chat]");
    expect(payload.prompt).toContain("READ-ONLY");
    expect(payload.prompt).toMatch(/why did you reject it\?$/);
  });

  it("falls back to fleet discovery and a >= 33 char session when the persona was never dispatched", async () => {
    h.state.invocation = null;
    const res = await post({ agentId: PERSONA, message: "hi" });
    expect(res.status).toBe(200);
    expect(h.state.discoverCalls).toBe(1);
    const [invoke] = h.state.invokes;
    expect(invoke.agentRuntimeArn).toBe("arn:discovered");
    expect(invoke.sessionId.length).toBeGreaterThanOrEqual(33);
  });
});

describe("input validation happens before any AWS call", () => {
  it.each([
    ["workflow id", { id: "wf-1/../secrets", agentId: PERSONA }],
    ["workflow id with a space", { id: "wf 1", agentId: PERSONA }],
    ["agentId", { id: "wf-1", agentId: "agentcore_hub_code_reviewer;rm -rf /" }],
    ["human gate pseudo-agent", { id: "wf-1", agentId: "human:engineer" }],
  ])("rejects a bad %s without reading DynamoDB", async (_label, { id, agentId }) => {
    const res = await post({ agentId, message: "hi" }, id);
    expect(res.status).toBe(400);
    expect(h.state.workflowReads).toHaveLength(0);
    expect(h.state.invokes).toHaveLength(0);
  });

  it("rejects a missing, non-string or over-long message", async () => {
    expect((await post({ agentId: PERSONA })).status).toBe(400);
    expect((await post({ agentId: PERSONA, message: 42 })).status).toBe(400);
    expect((await post({ agentId: PERSONA, message: "x".repeat(4001) })).status).toBe(400);
    expect(h.state.invokes).toHaveLength(0);
  });

  it("404s an unknown workflow", async () => {
    h.state.workflow = null;
    expect((await post({ agentId: PERSONA, message: "hi" })).status).toBe(404);
    expect(h.state.invokes).toHaveLength(0);
  });
});

describe("personas only", () => {
  it.each([
    "agentcore_hub_workflow_manager", // harness — has its own chat
    "agentcore_hub_agent", // the fleet host, not a persona
    "agentcore_hub_coding_runtime", // the coding CLIs' runtime — Cloud Code owns that surface
    "not_in_the_roster",
  ])("rejects %s with not_a_persona", async (agentId) => {
    const res = await post({ agentId, message: "hi" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("not_a_persona");
    expect(h.state.invokes).toHaveLength(0);
  });
});

describe("error hygiene", () => {
  it("replaces an upstream error frame so no ARN or account id reaches the client", async () => {
    h.state.upstreamFrames = [
      'data: {"type":"error","content":"AccessDeniedException: arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agentcore_hub_agent-XYZ is not authorized"}',
    ];
    const res = await post({ agentId: PERSONA, message: "hi" });
    const body = await readBody(res);
    expect(body).not.toContain("123456789012");
    expect(body).not.toContain("arn:aws");
    expect(body).toContain("could not be reached");
  });

  it("passes normal text frames through untouched", async () => {
    const res = await post({ agentId: PERSONA, message: "hi" });
    const body = await readBody(res);
    expect(body).toContain('"content":"ok"');
    expect(body).toContain('{"type":"done"}');
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Chat-Session-Id")).toBe(h.state.invocation!.sessionId);
  });
});

describe("GET (session + idle state for the modal)", () => {
  it("returns the recorded session id and whether the agent is active", async () => {
    h.state.workflow = workflowWith("running");
    const res = await GET(
      new NextRequest(`http://localhost/api/workflow/wf-1/agent-chat?agentId=${PERSONA}`),
      { params: { id: "wf-1" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: h.state.invocation!.sessionId, active: true });
  });

  it("reports no session when the persona never ran, without failing", async () => {
    h.state.invocation = null;
    const res = await GET(
      new NextRequest(`http://localhost/api/workflow/wf-1/agent-chat?agentId=${PERSONA}`),
      { params: { id: "wf-1" } }
    );
    expect(await res.json()).toEqual({ sessionId: null, active: false });
  });
});
