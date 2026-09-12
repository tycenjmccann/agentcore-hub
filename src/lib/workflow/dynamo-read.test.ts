import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * getLatestAgentInvocation — the read that gives idle persona chat (TEAM-4498)
 * the session and runtime a persona actually ran on.
 *
 * The thing under test is PAGINATION, and it is not a nicety. DynamoDB applies
 * `Limit` to rows scanned, BEFORE `FilterExpression`, and a run's event partition
 * is dominated by `agent.streaming` rows — 1000-2000 for a normal run, 7500+ for
 * a bad one. A single bounded window therefore finds the dispatch of only the
 * last few personas and silently returns null for everyone else, which costs the
 * operator both history replay and the persona's own memory session.
 */

const h = vi.hoisted(() => {
  const state: {
    pages: Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>;
    sent: Record<string, unknown>[];
  } = { pages: [], sent: [] };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    QueryCommand,
    GetCommand: class {},
    ScanCommand: class {},
    BatchGetCommand: class {},
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { input: Record<string, unknown> }) => {
          h.state.sent.push(cmd.input);
          return h.state.pages[h.state.sent.length - 1] || { Items: [] };
        },
      }),
    },
  };
});

const { getLatestAgentInvocation } = await import("./dynamo-read");

const PERSONA = "agentcore_hub_code_reviewer";
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${PERSONA}-AbCdEf`;

/** A page of noise — the streaming rows the filter throws away. */
function noise(n: number) {
  return Array.from({ length: n }, (_, i) => ({ type: "agent.streaming", detail: { seq: i } }));
}

function invokedRow(sessionId: string, timestamp: string) {
  return {
    type: "orchestrator.agent_invoked",
    detail: { agentId: PERSONA, sessionId, runtimeArn: ARN, ticketId: "TEAM-1", timestamp },
  };
}

beforeEach(() => {
  h.state.pages = [];
  h.state.sent = [];
});

describe("getLatestAgentInvocation", () => {
  it("keeps paging past filtered-out pages until it finds the dispatch", async () => {
    // Three pages of pure streaming noise, then the dispatch on the fourth —
    // exactly the shape of a real run, where the old single-window query gave up.
    h.state.pages = [
      { Items: noise(500), LastEvaluatedKey: { eventId: "p1" } },
      { Items: noise(500), LastEvaluatedKey: { eventId: "p2" } },
      { Items: noise(500), LastEvaluatedKey: { eventId: "p3" } },
      { Items: [invokedRow("session-abc", "2026-09-12T00:10:00Z")] },
    ];

    const ref = await getLatestAgentInvocation("wf-1", PERSONA);
    expect(ref).toEqual({
      sessionId: "session-abc",
      runtimeArn: ARN,
      ticketId: "TEAM-1",
      timestamp: "2026-09-12T00:10:00Z",
    });
    expect(h.state.sent).toHaveLength(4);
    // Newest-first, and each page resumes where the last one stopped.
    expect(h.state.sent[0].ScanIndexForward).toBe(false);
    expect(h.state.sent[0].ExclusiveStartKey).toBeUndefined();
    expect(h.state.sent[3].ExclusiveStartKey).toEqual({ eventId: "p3" });
  });

  it("stops at the first page that matches — later pages are older by scan order", async () => {
    h.state.pages = [
      { Items: [invokedRow("newest", "2026-09-12T05:00:00Z")], LastEvaluatedKey: { eventId: "p1" } },
      { Items: [invokedRow("older", "2026-09-12T01:00:00Z")] },
    ];
    expect((await getLatestAgentInvocation("wf-1", PERSONA))?.sessionId).toBe("newest");
    expect(h.state.sent).toHaveLength(1);
  });

  it("orders by detail.timestamp within a page, not by the eventId sort key", async () => {
    h.state.pages = [
      {
        Items: [
          invokedRow("rework", "2026-09-12T09:00:00Z"),
          invokedRow("first-try", "2026-09-12T02:00:00Z"),
        ].reverse(), // arrive oldest-first, as a 0#-prefixed key would
      },
    ];
    expect((await getLatestAgentInvocation("wf-1", PERSONA))?.sessionId).toBe("rework");
  });

  it("returns null when the partition is exhausted with no match", async () => {
    h.state.pages = [{ Items: noise(10) }]; // no LastEvaluatedKey → end of partition
    expect(await getLatestAgentInvocation("wf-1", PERSONA)).toBeNull();
    expect(h.state.sent).toHaveLength(1);
  });

  it("is bounded — a huge partition cannot page forever", async () => {
    // Every page returns a continuation key and never a match.
    h.state.pages = Array.from({ length: 100 }, () => ({
      Items: noise(500),
      LastEvaluatedKey: { eventId: "next" },
    }));
    expect(await getLatestAgentInvocation("wf-1", PERSONA)).toBeNull();
    expect(h.state.sent.length).toBeLessThanOrEqual(20);
  });

  it("reports a missing runtimeArn as null rather than dropping the session", async () => {
    h.state.pages = [
      {
        Items: [
          { type: "orchestrator.agent_invoked", detail: { agentId: PERSONA, sessionId: "s1" } },
        ],
      },
    ];
    const ref = await getLatestAgentInvocation("wf-1", PERSONA);
    expect(ref).toEqual({ sessionId: "s1", runtimeArn: null, ticketId: null, timestamp: null });
  });
});
