import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4688 — GET /api/evaluations/sessions/[sessionId], the authoritative
 * per-session verdict view.
 *
 * The two cross-links are the whole point of this route, and both are easy to get
 * subtly wrong: the trace page is `/agents/<agentId>` and filters on `session_id`
 * (the same param name the trace API takes), and `workflowHref` exists ONLY when
 * the rows carry a workflowId — an ad-hoc invocation has no run, and a
 * `/workflow?id=undefined` link is worse than no link.
 *
 * A session with no rows is a 404, not an empty 200 body the UI would render as
 * "0 evaluations".
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
  sessionIds: [] as string[],
}));

vi.mock("@/lib/eval-results", () => ({
  queryBySession: vi.fn(async (sessionId: string) => {
    h.sessionIds.push(sessionId);
    if (h.error) throw h.error;
    return h.rows;
  }),
}));

const { GET } = await import("./route");

const get = (sessionId: string) =>
  GET(new Request(`http://localhost/api/evaluations/sessions/${sessionId}`), { params: { sessionId } });

function row(over: Record<string, unknown> = {}) {
  return {
    agentId: "agentcore_hub_requirements_analyst",
    sk: "2026-09-15T10:00:00.000Z#a",
    sessionId: "sess-1",
    persona: "agentcore_hub_ios_designer",
    workflowId: "wf_abc",
    ticketId: "TEAM-1",
    evaluator: "Helpfulness",
    score: 0.9,
    scoreLabel: "PASS",
    explanation: "The response addressed the request.",
    status: "COMPLETED",
    statusReason: "",
    traceId: "1-68c0-abc",
    spanId: "span-1",
    requestId: "req-1",
    logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_x",
    evaluatedAt: "2026-09-15T10:00:00.000Z",
    day: "2026-09-15",
    ingestedAt: "2026-09-15T10:01:00.000Z",
    source: "online-evaluation",
    ...over,
  };
}

beforeEach(() => {
  h.rows = [];
  h.error = null;
  h.sessionIds = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/evaluations/sessions/[sessionId]", () => {
  it("returns every verdict plus both cross-links", async () => {
    h.rows = [
      row(),
      row({ evaluator: "Correctness", score: 0.3, scoreLabel: "FAIL", explanation: "Missed the AC.", explanationTruncated: true, evaluatedAt: "2026-09-15T10:00:09.000Z" }),
    ];

    const res = await get("sess-1");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.sessionIds).toEqual(["sess-1"]);
    expect(body).toMatchObject({
      sessionId: "sess-1",
      agentId: "agentcore_hub_requirements_analyst",
      persona: "agentcore_hub_ios_designer",
      workflowId: "wf_abc",
      ticketId: "TEAM-1",
      evaluatedAt: "2026-09-15T10:00:09.000Z", // latest of the two rows
      tracesHref: "/agents/agentcore_hub_requirements_analyst?session_id=sess-1",
      workflowHref: "/workflow?id=wf_abc",
    });
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      evaluator: "Helpfulness",
      score: 0.9,
      scoreLabel: "PASS",
      explanation: "The response addressed the request.",
      explanationTruncated: false,
      traceId: "1-68c0-abc",
      spanId: "span-1",
      requestId: "req-1",
      logGroup: "/aws/bedrock-agentcore/evaluations/results/eval_x",
      day: "2026-09-15",
      source: "online-evaluation",
    });
    expect(body.results[1]).toMatchObject({ evaluator: "Correctness", score: 0.3, explanationTruncated: true });
  });

  it("workflowHref is null when no row carries a workflowId", async () => {
    h.rows = [row({ workflowId: undefined, ticketId: undefined })];
    const body = await (await get("sess-1")).json();
    expect(body.workflowHref).toBeNull();
    expect(body.workflowId).toBeNull();
    expect(body.ticketId).toBeNull();
    // The trace link does not depend on a run.
    expect(body.tracesHref).toBe("/agents/agentcore_hub_requirements_analyst?session_id=sess-1");
  });

  it("picks up a workflowId that only some rows carry", async () => {
    h.rows = [row({ workflowId: undefined }), row({ evaluator: "Correctness", workflowId: "wf_late" })];
    const body = await (await get("sess-1")).json();
    expect(body.workflowId).toBe("wf_late");
    expect(body.workflowHref).toBe("/workflow?id=wf_late");
  });

  it("percent-encodes the session id in the trace link and decodes the path param", async () => {
    h.rows = [row({ sessionId: "sess/1 2" })];
    const body = await (await get(encodeURIComponent("sess/1 2"))).json();
    expect(h.sessionIds).toEqual(["sess/1 2"]);
    expect(body.tracesHref).toBe("/agents/agentcore_hub_requirements_analyst?session_id=sess%2F1%202");
  });

  it("tracesHref is null when the rows have no agentId", async () => {
    h.rows = [row({ agentId: undefined })];
    const body = await (await get("sess-1")).json();
    expect(body.agentId).toBeNull();
    expect(body.tracesHref).toBeNull();
  });

  it("404s for a session with no results", async () => {
    h.rows = [];
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/nope/);
  });

  it("400s on an empty session id and 500s when the query fails", async () => {
    expect((await get("")).status).toBe(400);
    h.error = new Error("ddb blip");
    const res = await get("sess-1");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("ddb blip");
  });
});
