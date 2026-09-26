import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5171 — Jira-mode cancel read one /search/jql page (≤100) of open
 * children, so a run with more left the rest uncancelled; a non-ok search
 * response parsed as "0 to cancel" and the cancel reported clean success. It
 * must collect every page BEFORE transitioning (transitions shrink the
 * `status != Done` set) and flag anything it could not reach as incomplete.
 *
 * Separate from route.test.ts because TICKET_PROVIDER / JIRA_* are read when the
 * route module loads — set here in vi.hoisted before the import.
 */

const h = vi.hoisted(() => {
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  const state: { workflow: Record<string, unknown>; puts: Array<Record<string, unknown>> } = {
    workflow: {},
    puts: [],
  };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    QueryCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.workflow };
          if (name === "PutCommand") h.state.puts.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

const { POST } = await import("./route");

const EPIC = "TEAM-1";
const open = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}`, fields: { status: { name: "To Do" } } }));

type Call = { kind: "search" | "transition"; key?: string; token?: string };

/** Jira stub: /search/jql pages by nextPageToken, GET transitions offers Won't Do, POST transitions 204s. */
function stubJira(search: (token: string) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/rest/api/3/search/jql")) {
      const token = u.searchParams.get("nextPageToken") ?? "";
      calls.push({ kind: "search", token });
      return search(token);
    }
    const m = u.pathname.match(/\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (m) {
      if ((init.method || "GET") === "POST") {
        calls.push({ kind: "transition", key: m[1] });
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ transitions: [{ id: "31", name: "Won't Do" }] }), { status: 200 });
    }
    throw new Error(`unexpected ${u.pathname}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeRequest() {
  return new NextRequest("http://localhost/api/workflow/wf-1/cancel", { method: "POST" });
}

function cancelEventDetail() {
  const put = h.state.puts.find((p) => (p.Item as Record<string, unknown>)?.type === "workflow.cancelled");
  return (put?.Item as Record<string, unknown>)?.detail as Record<string, unknown>;
}

describe("TEAM-5171 — Jira cancel pages through every open child", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    h.state.workflow = { workflowId: "wf-1", epicId: EPIC, phase: "development" };
    h.state.puts = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("cancels all 150 open children across 2 pages, collecting every page first, then closes the epic", async () => {
    const calls = stubJira((token) =>
      token === ""
        ? json({ issues: open(100, 100), isLast: false, nextPageToken: "p2" })
        : json({ issues: open(200, 50), isLast: true })
    );

    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);

    const transitioned = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    const childTransitions = transitioned.filter((k) => k !== EPIC);
    expect(childTransitions).toHaveLength(150);
    expect(new Set(childTransitions).size).toBe(150);
    expect(transitioned).toContain(EPIC);

    const lastSearch = calls.map((c) => c.kind).lastIndexOf("search");
    const firstTransition = calls.findIndex((c) => c.kind === "transition");
    expect(lastSearch).toBeLessThan(firstTransition);

    const body = await res.json();
    expect(body.ticketsIncomplete).toBeUndefined();
    expect(cancelEventDetail().ticketsCancelled).toBe(151);
  });

  it("a non-ok search response is reported as incomplete, not as '0 to cancel'", async () => {
    stubJira(() => json({ errorMessages: ["boom"] }, 500));

    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("cancelled");
    expect(body.ticketsIncomplete).toBe(true);
    expect(String(body.error)).toMatch(/500/);
    expect(cancelEventDetail().ticketsIncomplete).toBe(true);
  });

  it("a search truncated at the cap is reported as incomplete and leaves the epic open", async () => {
    let n = 0;
    const calls = stubJira(() => json({ issues: open(100 + n * 100, 100), isLast: false, nextPageToken: `p${++n}` }));

    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    const body = await res.json();
    expect(body.ticketsIncomplete).toBe(true);
    const transitioned = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    expect(transitioned).toHaveLength(1000);
    expect(transitioned).not.toContain(EPIC);
  });
});
