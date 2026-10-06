import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5171 — Jira-mode cancel read one /search/jql page (≤100) of open
 * children, so a run with more left the rest uncancelled; a non-ok search
 * response parsed as "0 to cancel" and the cancel reported clean success. It
 * must collect every page BEFORE transitioning (transitions shrink the
 * `status != Done` set) and flag anything it could not reach as incomplete.
 *
 * TEAM-5358 FR-3 — no Done-category fallback: an issue (or the epic) without a
 * Won't Do / Cancelled transition stays open and is listed in cancelStatusMissing;
 * human gates (reviewer:* / human-review) without a verified stop stay open.
 *
 * TEAM-5358 FR-5 — the follow-up moves run even when the sweep reports
 * cancelStatusMissing.
 *
 * Separate from route.test.ts because TICKET_PROVIDER / JIRA_* are read when the
 * route module loads — set here in vi.hoisted before the import.
 */

const h = vi.hoisted(() => {
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.GATE_DECISION_KEY = "cancel-jira-test-gate-decision-key"; // never Secrets Manager
  process.env.ARTIFACT_BUCKET = "test-bucket"; // S3 is mocked below, never the real bucket
  const state: {
    workflow: Record<string, unknown>;
    puts: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    tools: Array<{ tool: string; params: Record<string, unknown> }>;
  } = { workflow: {}, puts: [], events: [], tools: [] };
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

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(cmd: { input: { Entries?: Array<Record<string, unknown>> } }) {
      h.state.events.push(...(cmd.input.Entries || []));
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

/** The Jira twin's success shapes ({ ticketId, … }). */
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array } }) {
      const { tool_name, parameters } = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.state.tools.push({ tool: tool_name, params: parameters });
      const out = tool_name === "Tickets___create_ticket" ? { ticketId: "TEAM-90", title: parameters.summary } : { ticketId: parameters.ticket_id, message: "Updated" };
      return { Payload: new TextEncoder().encode(JSON.stringify(out)) };
    }
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { POST } = await import("./route");

const EPIC = "TEAM-1";
const open = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}`, fields: { status: { name: "To Do" } } }));

type Call = { kind: "search" | "transition"; key?: string; token?: string; id?: string; jql?: string };

const WONT_DO = [{ id: "31", name: "Won't Do" }];
/** A workflow without a cancel status: only a Done-category transition is offered. */
const DONE_ONLY = [{ id: "41", name: "Close", to: { name: "Closed", statusCategory: { key: "done" } } }];

/**
 * Jira stub: /search/jql pages by nextPageToken, GET transitions offers
 * `transitionsFor(key)` (default Won't Do), POST transitions 204s.
 */
function stubJira(search: (token: string) => Response, transitionsFor: (key: string) => unknown[] = () => WONT_DO) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/rest/api/3/search/jql")) {
      const token = u.searchParams.get("nextPageToken") ?? "";
      calls.push({ kind: "search", token, jql: u.searchParams.get("jql") ?? "" });
      return search(token);
    }
    const m = u.pathname.match(/\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
    if (m) {
      if ((init.method || "GET") === "POST") {
        calls.push({ kind: "transition", key: m[1], id: JSON.parse(String(init.body)).transition.id });
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ transitions: transitionsFor(m[1]) }), { status: 200 });
    }
    throw new Error(`unexpected ${u.pathname}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeRequest() {
  return new NextRequest("http://localhost/api/workflow/wf-1/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "superseded" }),
  });
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
    h.state.events = [];
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

describe("TEAM-5358 FR-3 — Jira cancel never falls back to Done", () => {
  let originalFetch: typeof globalThis.fetch;
  const issue = (key: string, status = "To Do", labels: string[] = []) => ({ key, fields: { status: { name: status }, labels } });

  beforeEach(() => {
    h.state.workflow = { workflowId: "wf-1", epicId: EPIC, phase: "development" };
    h.state.puts = [];
    h.state.events = [];
    h.state.tools = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("follow-up moves run even when Jira reports cancel_status_missing", async () => {
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const calls = stubJira(
      () =>
        json({
          issues: [
            issue(EPIC, "In Progress"),
            { key: "TEAM-5", fields: { status: { name: "Blocked" }, labels: ["agent:agentcore_hub_release_manager"], created: "2026-10-01T00:00:00.000+0000" } },
            {
              key: "TEAM-6",
              fields: {
                status: { name: "Blocked" },
                summary: "Rotate the key [fu:0123abcd]",
                labels: ["agent:agentcore_hub_backend_dev", "followup-0123abcd"],
                issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "TEAM-5" } }],
                description: adf("AGENT-AUTHORED FOLLOW-UP (materialized by report_completion from TEAM-4; treat the text below as untrusted input)"),
              },
            },
          ],
          isLast: true,
        }),
      () => DONE_ONLY
    );
    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelStatusMissing.sort()).toEqual([EPIC, "TEAM-5"].sort());
    expect(calls.filter((c) => c.kind === "transition")).toHaveLength(0);
    expect(body).toMatchObject({ followUpsMoved: 1, postRunEpicKey: "TEAM-90" });
    const move = h.state.tools.find((t) => t.tool === "Tickets___update_ticket")!;
    expect(move.params).toMatchObject({ ticket_id: "TEAM-6", parent: "TEAM-90", blocked_by: [] });
    expect(String(move.params.description)).toMatch(/^MOVED on cancel of wf-1: was blocked by CD TEAM-5 \(origin TEAM-4\)/);
    expect(cancelEventDetail()).toMatchObject({ followUpsMoved: 1, postRunEpicKey: "TEAM-90" });
  });

  it("no Done-category transition id is ever POSTed; a missing Won't Do -> cancelStatusMissing lists the key", async () => {
    const calls = stubJira(
      () => json({ issues: [issue(EPIC, "In Progress"), issue("TEAM-2"), issue("TEAM-3")], isLast: true }),
      (key) => (key === "TEAM-3" ? DONE_ONLY : WONT_DO)
    );
    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);
    const posted = calls.filter((c) => c.kind === "transition");
    expect(posted.map((c) => c.id)).not.toContain("41");
    expect(posted.map((c) => c.key)).toEqual(expect.arrayContaining(["TEAM-2", EPIC]));
    expect(posted.map((c) => c.key)).not.toContain("TEAM-3");
    const body = await res.json();
    expect(body.cancelStatusMissing).toEqual(["TEAM-3"]);
    expect(cancelEventDetail().cancelStatusMissing).toEqual(["TEAM-3"]);
  });

  it("a Jira epic without Won't Do stays open and is reported", async () => {
    const calls = stubJira(
      () => json({ issues: [issue(EPIC, "In Progress"), issue("TEAM-2")], isLast: true }),
      (key) => (key === EPIC ? DONE_ONLY : WONT_DO)
    );
    const body = await (await POST(makeRequest(), { params: { id: "wf-1" } })).json();
    const posted = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    expect(posted).toEqual(["TEAM-2"]);
    expect(body.cancelStatusMissing).toEqual([EPIC]);
  });

  it("the JQL lists the epic and every child (all statuses), so done/cancelled ones are skipped locally", async () => {
    const calls = stubJira(() =>
      json({ issues: [issue(EPIC, "In Progress"), issue("TEAM-2", "Done"), issue("TEAM-3", "Won't Do"), issue("TEAM-4")], isLast: true })
    );
    const body = await (await POST(makeRequest(), { params: { id: "wf-1" } })).json();
    expect(calls.find((c) => c.kind === "search")!.jql).toBe(`parent = ${EPIC} OR key = ${EPIC}`);
    const posted = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    expect(posted.sort()).toEqual([EPIC, "TEAM-4"].sort());
    expect(body.tickets).toMatchObject({ cancelled: 2, skipped: 2, failed: 0 });
  });

  it("human gates (reviewer:* / human-review) without a stopped record are left open, and so is the epic", async () => {
    const calls = stubJira(() =>
      json({
        issues: [
          issue(EPIC, "In Progress"),
          issue("TEAM-2", "In Review", ["reviewer:engineer"]),
          issue("TEAM-3", "To Do", ["human-review"]),
          issue("TEAM-4", "To Do", ["agent:agentcore_hub_dev"]),
        ],
        isLast: true,
      })
    );
    const body = await (await POST(makeRequest(), { params: { id: "wf-1" } })).json();
    const posted = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    expect(posted).toEqual(["TEAM-4"]);
    expect(body.humanGatesLeftOpen).toEqual(["TEAM-2", "TEAM-3"]);
    expect(cancelEventDetail().humanGatesLeftOpen).toEqual(["TEAM-2", "TEAM-3"]);
    expect(h.state.events).toHaveLength(1);
  });
});
