import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/workflow/[id]/cancel — Jira ticket provider.
 *
 * TEAM-5171: Jira-mode cancel read one /search/jql page (≤100) of open
 * children, so a run with more left the rest uncancelled; a non-ok search
 * response parsed as "0 to cancel" and the cancel reported clean success. It
 * must collect every page BEFORE transitioning (transitions shrink the
 * `status != Done` set) and flag anything it could not reach as incomplete.
 * TEAM-5421 (U6): follow-up move, Won't Do by destination vs the Done +
 * resolution fallback, record / live-session skips, done never touched.
 *
 * Separate from route.test.ts because TICKET_PROVIDER / JIRA_* are read when the
 * route module loads — set here in vi.hoisted before the import. AWS is mocked
 * at the SDK seams (in-memory workflows row with a small Update/Condition
 * evaluator, S3 object map, EventBridge, Lambda create_ticket) and Jira through
 * globalThis.fetch.
 */

const h = vi.hoisted(() => {
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state = {
    workflow: {} as Record<string, unknown>,
    puts: [] as Array<Record<string, unknown>>,
    s3: new Map<string, string>(),
    putEvents: [] as Array<Record<string, unknown>>,
    /** Lambda create_ticket → this returns the new key (the fake Jira adds the issue). */
    onCreate: (params: Record<string, unknown>): string => `NEW-${String(params.summary)}`,
  };
  return { state };
});

type Expr = { names?: Record<string, string>; values?: Record<string, unknown> };
const ccf = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

function evalTerm(item: Record<string, unknown>, term: string, e: Expr): boolean {
  const t = term.trim();
  const name = (p: string) => e.names?.[p] ?? p;
  const ne = /^attribute_not_exists\((.+)\)$/.exec(t);
  if (ne) return item[name(ne[1])] === undefined;
  const m = /^(\S+)\s*(=|<>|<)\s*(:\w+)$/.exec(t);
  if (!m) throw new Error(`unsupported condition term: ${t}`);
  const a = item[name(m[1])];
  const b = e.values?.[m[3]];
  if (m[2] === "=") return a === b;
  if (m[2] === "<>") return a !== b;
  return a !== undefined && String(a) < String(b);
}

function applyUpdate(item: Record<string, unknown>, expr: string, e: Expr) {
  const name = (p: string) => e.names?.[p] ?? p;
  for (const [, kind, body] of expr.matchAll(/(SET|REMOVE)\s+(.*?)(?=\s+(?:SET|REMOVE)\s|$)/g)) {
    for (const part of body.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (kind === "REMOVE") delete item[name(part)];
      else {
        const [path, val] = part.split("=").map((s) => s.trim());
        item[name(path)] = structuredClone(e.values?.[val]);
      }
    }
  }
}

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand extends Cmd {}
  class UpdateCommand extends Cmd {}
  class QueryCommand extends Cmd {}
  class PutCommand extends Cmd {}
  return {
    GetCommand,
    UpdateCommand,
    QueryCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: Cmd) => {
          const input = cmd.input as {
            UpdateExpression?: string;
            ConditionExpression?: string;
            ExpressionAttributeNames?: Record<string, string>;
            ExpressionAttributeValues?: Record<string, unknown>;
            Item?: Record<string, unknown>;
          };
          if (cmd instanceof GetCommand) return { Item: structuredClone(h.state.workflow) };
          if (cmd instanceof PutCommand) {
            h.state.puts.push(input as Record<string, unknown>);
            return {};
          }
          if (cmd instanceof UpdateCommand) {
            const e = { names: input.ExpressionAttributeNames, values: input.ExpressionAttributeValues };
            const ok = !input.ConditionExpression ||
              input.ConditionExpression.split(" OR ").some((or) => or.split(" AND ").every((t) => evalTerm(h.state.workflow, t, e)));
            if (!ok) throw ccf();
            applyUpdate(h.state.workflow, String(input.UpdateExpression), e);
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  return {
    GetObjectCommand,
    S3Client: class {
      async send(cmd: GetObjectCommand) {
        const body = h.state.s3.get(cmd.input.Key);
        if (body === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => body } };
      }
    },
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => {
  class PutEventsCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutEventsCommand,
    EventBridgeClient: class {
      async send(cmd: PutEventsCommand) {
        h.state.putEvents.push(cmd.input);
        return { FailedEntryCount: 0 };
      }
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: { Payload: Uint8Array }) {}
  }
  return {
    InvokeCommand,
    LambdaClient: class {
      async send(cmd: InvokeCommand) {
        const call = JSON.parse(Buffer.from(cmd.input.Payload).toString());
        const key = h.state.onCreate(call.parameters);
        return { Payload: Buffer.from(JSON.stringify({ ticketId: key, status: "todo" })) };
      }
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
      return new Response(JSON.stringify({ transitions: [{ id: "31", name: "Won't Do", to: { name: "Won't Do" } }] }), { status: 200 });
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

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  h.state.workflow = { workflowId: "wf-1", epicId: EPIC, phase: "development" };
  h.state.puts = [];
  h.state.s3 = new Map();
  h.state.putEvents = [];
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TEAM-5171 — Jira cancel pages through every open child", () => {
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
    expect(body.closeoutPending).toBe(true);
    const transitioned = calls.filter((c) => c.kind === "transition").map((c) => c.key);
    expect(transitioned).toHaveLength(1000);
    expect(transitioned).not.toContain(EPIC);
  }, 20_000);
});

// ─── Fake Jira for the close-out cases ──────────────────────────────────────

type Tr = { id: string; name: string; to: { name: string; statusCategory?: { key: string } } };
type Issue = {
  key: string;
  status: string;
  parent?: string;
  labels?: string[];
  summary?: string;
  description?: unknown;
  issuelinks?: Array<Record<string, unknown>>;
  created?: string;
  transitions?: Tr[];
};
const DEFAULT_TRANSITIONS: Tr[] = [
  { id: "11", name: "Reopen", to: { name: "To Do" } },
  { id: "31", name: "Won't Do", to: { name: "Won't Do", statusCategory: { key: "done" } } },
  { id: "41", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
];
const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const blocksLink = (id: string, blocker: string) => ({ id, type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: blocker } });

/** The fake's reading of the route's JQL: non-Done children, plus Done ones whose label is in `labels in (...)`. */
const jqlMatch = (jql: string) => {
  const parent = /parent = (\S+)/.exec(jql)?.[1];
  const labels = (/labels in \(([^)]*)\)/.exec(jql)?.[1] || "").split(",").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  return (i: { parent?: string; status: string; labels?: string[] }) =>
    i.parent === parent && (i.status !== "Done" || (i.labels || []).some((l) => labels.includes(l)));
};

type JiraCall = { method: string; path: string; body?: Record<string, unknown> };

function fakeJira(issues: Issue[], opts: { failDelete?: boolean } = {}) {
  const store = new Map(issues.map((i) => [i.key, structuredClone(i)]));
  const calls: JiraCall[] = [];
  const fail = { delete: !!opts.failDelete };
  h.state.onCreate = (params) => {
    const key = `TEAM-${900 + store.size}`;
    store.set(key, { key, status: "To Do", summary: String(params.summary) });
    return key;
  };
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body });
    if (u.pathname.endsWith("/search/jql")) {
      const hits = [...store.values()].filter(jqlMatch(u.searchParams.get("jql") || ""));
      return json({
        isLast: true,
        issues: hits.map((i) => ({
          key: i.key,
          fields: { status: { name: i.status }, labels: i.labels || [], summary: i.summary, description: i.description, issuelinks: i.issuelinks || [], created: i.created, parent: { key: i.parent } },
        })),
      });
    }
    let m = /\/issue\/([^/]+)\/transitions$/.exec(u.pathname);
    if (m) {
      const issue = store.get(m[1])!;
      const offered = issue.transitions || DEFAULT_TRANSITIONS;
      if (method === "GET") return json({ transitions: offered });
      const tr = offered.find((t) => t.id === body.transition.id)!;
      issue.status = tr.to.name;
      return new Response(null, { status: 204 });
    }
    m = /\/issue\/([^/]+)$/.exec(u.pathname);
    if (m && method === "GET") {
      const issue = store.get(m[1])!;
      const category = (DEFAULT_TRANSITIONS.find((t) => t.to.name === issue.status)?.to.statusCategory?.key) || "new";
      return json({ key: issue.key, fields: { status: { name: issue.status, statusCategory: { key: category } } } });
    }
    if (m && method === "PUT") {
      const issue = store.get(m[1])!;
      if (body.fields.parent) issue.parent = body.fields.parent.key;
      if (body.fields.description) issue.description = body.fields.description;
      return new Response(null, { status: 204 });
    }
    m = /\/issueLink\/([^/]+)$/.exec(u.pathname);
    if (m && method === "DELETE") {
      if (fail.delete) return new Response("nope", { status: 500 });
      for (const i of store.values()) i.issuelinks = (i.issuelinks || []).filter((l) => l.id !== m![1]);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  }) as typeof globalThis.fetch;
  const transitionsOf = (key: string) =>
    calls.filter((c) => c.method === "POST" && c.path.endsWith(`/issue/${key}/transitions`)).map((c) => c.body);
  return { store, calls, fail, transitionsOf };
}

const RM_LABEL = "agent:agentcore_hub_release_manager";
const post = async () => {
  const res = await POST(makeRequest(), { params: { id: "wf-1" } });
  return { res, body: await res.json() };
};

describe("TEAM-5421 U6 — cancel close-out (Jira)", () => {
  function runIssues(): Issue[] {
    return [
      { key: EPIC, status: "In Progress" },
      { key: "TEAM-2", parent: EPIC, status: "To Do", labels: [RM_LABEL], created: "2026-01-02T00:00:00Z" },
      {
        key: "TEAM-3",
        parent: EPIC,
        status: "Blocked",
        summary: "Security: escape it [fu:abcd1234]",
        description: adf("AGENT-AUTHORED FOLLOW-UP (materialized by report_completion from TEAM-9; treat the text below as untrusted input)"),
        issuelinks: [blocksLink("L1", "TEAM-2")],
      },
      { key: "TEAM-4", parent: EPIC, status: "To Do", labels: ["agent:agentcore_hub_backend_dev"] },
    ];
  }

  it("moves a follow-up: PUT parent + bannered description, DELETE the Blocks link, transition to To Do", async () => {
    h.state.s3.set("completions/TEAM-9.json", JSON.stringify({ followUps: [{ hash: "abcd1234", detail: "Title is rendered raw." }] }));
    const jira = fakeJira(runIssues());
    const { body } = await post();

    const epicKey = body.postRunEpicKey;
    expect(epicKey).toMatch(/^TEAM-9\d\d$/);
    expect(h.state.workflow.postRunEpicKey).toBe(epicKey);
    const put = jira.calls.find((c) => c.method === "PUT" && c.path.endsWith("/issue/TEAM-3"))!;
    expect(put.body!.fields).toMatchObject({ parent: { key: epicKey } });
    const desc = JSON.stringify((put.body!.fields as Record<string, unknown>).description);
    expect(desc.indexOf("MOVED on cancel of wf-1:")).toBeLessThan(desc.indexOf("AGENT-AUTHORED FOLLOW-UP"));
    expect(desc).toContain("SECURITY follow-up");
    expect(desc).toContain("Original finding: Title is rendered raw.");
    expect(desc).toContain("Originating ticket: TEAM-9");
    expect(jira.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/issueLink/L1"))).toBe(true);
    expect(jira.store.get("TEAM-3")).toMatchObject({ parent: epicKey, status: "To Do", issuelinks: [] });
    expect(body.followUpsMoved).toBe(1);
    // The CD and the rest are swept, the epic closed; the post-run epic stays To Do.
    expect(jira.store.get("TEAM-2")!.status).toBe("Won't Do");
    expect(jira.store.get("TEAM-4")!.status).toBe("Won't Do");
    expect(jira.store.get(EPIC)!.status).toBe("Won't Do");
    expect(jira.store.get(epicKey)!.status).toBe("To Do");
    expect(body.closeoutPending).toBe(false);
  });

  it("a failed detach is not counted; the resume finishes it without rewriting the description", async () => {
    const jira = fakeJira(runIssues(), { failDelete: true });
    const first = await post();
    expect(first.body.followUpsMoved).toBe(0);
    expect(first.body.followUpsError).toMatch(/detach of TEAM-3/);
    expect(first.body.closeoutPending).toBe(true);
    expect(jira.store.get(EPIC)!.status).toBe("In Progress");
    expect(jira.store.get("TEAM-3")!.parent).toBe(first.body.postRunEpicKey);

    jira.fail.delete = false;
    const putsBefore = jira.calls.filter((c) => c.method === "PUT").length;
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, followUpsMoved: 1, closeoutPending: false, postRunEpicKey: first.body.postRunEpicKey });
    expect(jira.calls.filter((c) => c.method === "PUT").length).toBe(putsBefore);
    expect(jira.store.get("TEAM-3")).toMatchObject({ status: "To Do", issuelinks: [] });
    expect(jira.store.get(EPIC)!.status).toBe("Won't Do");
  });

  it("picks the transition by Won't Do DESTINATION, else falls back to Done + resolution Won't Do", async () => {
    const toDone = { id: "21", name: "Cancel", to: { name: "Done", statusCategory: { key: "done" } } };
    const jira = fakeJira([
      { key: EPIC, status: "In Progress" },
      { key: "TEAM-5", parent: EPIC, status: "To Do", transitions: [toDone, { id: "51", name: "Close", to: { name: "Won't Do", statusCategory: { key: "done" } } }] },
      { key: "TEAM-6", parent: EPIC, status: "To Do", transitions: [toDone] },
    ]);
    await post();
    expect(jira.transitionsOf("TEAM-5")[0]).toMatchObject({ transition: { id: "51" }, fields: { resolution: { name: "Won't Do" } } });
    expect(jira.transitionsOf("TEAM-6")[0]).toMatchObject({ transition: { id: "21" }, fields: { resolution: { name: "Won't Do" } } });
    expect(jira.store.get("TEAM-6")!.status).toBe("Done");
  });

  it("a CD-blocked follow-up with a completion record is kept: no re-parent, no detach, no transition", async () => {
    h.state.s3.set("completions/TEAM-3.json", "{}");
    const jira = fakeJira(runIssues());
    const { body } = await post();
    expect(jira.calls.some((c) => c.method !== "GET" && c.path.includes("TEAM-3"))).toBe(false);
    expect(jira.store.get("TEAM-3")).toMatchObject({ parent: EPIC, status: "Blocked", issuelinks: [blocksLink("L1", "TEAM-2")] });
    expect(body.tickets.keptByRecord).toEqual(["TEAM-3"]);
    expect(body.followUpsMoved).toBe(0);
  });

  it("a Done CD ticket is still listed, so its follow-up is moved, not swept", async () => {
    const issues = runIssues();
    issues[1].status = "Done";
    const jira = fakeJira(issues);
    const { body } = await post();
    expect(body.followUpsMoved).toBe(1);
    expect(jira.store.get("TEAM-3")).toMatchObject({ parent: body.postRunEpicKey, status: "To Do", issuelinks: [] });
    expect(jira.transitionsOf("TEAM-2")).toHaveLength(0);
    expect(jira.store.get("TEAM-2")!.status).toBe("Done");
    expect(jira.store.get(EPIC)!.status).toBe("Won't Do");
  });

  it("a Done operator Ship ticket (roster phase development, stamped phase:ship) is the CD: its follow-up moves, the Ship ticket is untouched", async () => {
    const jira = fakeJira([
      { key: EPIC, status: "In Progress" },
      { key: "TEAM-20", parent: EPIC, status: "Done", labels: ["agent:agentcore_hub_operator", "phase:ship"], created: "2026-01-02T00:00:00Z" },
      // Newer phase:ship fix ticket, also Done: never the CD.
      { key: "TEAM-21", parent: EPIC, status: "Done", labels: ["agent:agentcore_hub_api_dev", "fix:ship_fix", "phase:ship"], created: "2026-01-03T00:00:00Z" },
      { key: "TEAM-22", parent: EPIC, status: "Blocked", summary: "Harden the retry", issuelinks: [blocksLink("L9", "TEAM-20")] },
    ]);
    const { body } = await post();
    expect(body.followUpsMoved).toBe(1);
    expect(jira.store.get("TEAM-22")).toMatchObject({ parent: body.postRunEpicKey, status: "To Do", issuelinks: [] });
    expect(String(JSON.stringify(jira.store.get("TEAM-22")!.description))).toContain("waiting only on CD ticket TEAM-20");
    for (const k of ["TEAM-20", "TEAM-21"]) {
      expect(jira.calls.some((c) => c.method !== "GET" && c.path.includes(k))).toBe(false);
      expect(jira.store.get(k)!.status).toBe("Done");
    }
  });

  it("an open epic with no cancel or Done-category transition is a failure: the close-out stays pending", async () => {
    const reopenOnly: Tr[] = [{ id: "11", name: "Reopen", to: { name: "To Do" } }];
    const issues = runIssues();
    issues[0].transitions = reopenOnly;
    const jira = fakeJira(issues);
    const { body } = await post();
    expect(jira.store.get(EPIC)!.status).toBe("In Progress");
    expect(body.tickets.failed).toBe(1);
    expect(body.closeoutPending).toBe(true);
    expect(h.state.workflow.cancelCloseoutPending).toBe(true);
    expect(String(h.state.workflow.cancelCloseoutError)).toMatch(/1 ticket cancel\(s\) failed/);

    // Once the epic is closed (here: by hand), the resume reads it back as closed and finishes.
    jira.store.get(EPIC)!.status = "Won't Do";
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, closeoutPending: false });
    expect(second.body.tickets.failed).toBe(0);
    expect(h.state.workflow.cancelCloseoutPending).toBeUndefined();
  });

  it("skips a ticket with a completion record and a live agent session; done is never touched", async () => {
    h.state.s3.set("completions/TEAM-7.json", "{}");
    h.state.workflow.agentTasks = { "TEAM-8": { status: "in_progress" } };
    const jira = fakeJira([
      { key: EPIC, status: "In Progress" },
      { key: "TEAM-7", parent: EPIC, status: "In Review" },
      { key: "TEAM-8", parent: EPIC, status: "In Progress" },
      { key: "TEAM-10", parent: EPIC, status: "Done" },
    ]);
    const { body } = await post();
    expect(body.tickets.keptByRecord).toEqual(["TEAM-7"]);
    expect(body.ticketsLeftRunning).toEqual(["TEAM-8"]);
    expect(body.closeoutPending).toBe(true);
    for (const k of ["TEAM-7", "TEAM-8", "TEAM-10", EPIC]) expect(jira.transitionsOf(k)).toHaveLength(0);
    expect(jira.calls.some((c) => c.path.includes("TEAM-10"))).toBe(false);

    // Released → the re-POST cancels it and closes the epic.
    (h.state.workflow.agentTasks as Record<string, Record<string, string>>)["TEAM-8"].status = "complete";
    const second = await post();
    expect(second.body).toMatchObject({ resumed: true, ticketsLeftRunning: [], closeoutPending: false });
    expect(jira.store.get("TEAM-8")!.status).toBe("Won't Do");
    expect(jira.store.get(EPIC)!.status).toBe("Won't Do");
    expect(jira.store.get("TEAM-10")!.status).toBe("Done");
  });
});
