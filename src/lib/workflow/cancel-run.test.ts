import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-5407 (PR #807 R2-02) — loadRunForCancel() lists the run's tickets before
 * any write, and /stop and cancelRun() decide on that roster. A listing that
 * cannot even be attempted (no epicId on the row; Jira mode without credentials)
 * used to fall through as `tickets: []` with no `listError`, indistinguishable
 * from "the run has no tickets". It must be a listing failure instead.
 *
 * TICKET_PROVIDER is a module constant, so each provider gets a fresh module
 * (vi.resetModules + import). JIRA_* are read per call by getJiraAuth().
 * Seams mocked as in cancel/route.test.ts: the DDB doc client, S3, EventBridge,
 * the ticket Lambda; `fetch` is a spy that must never be reached.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state: {
    workflow: Record<string, unknown>;
    tickets: Array<Record<string, unknown>>;
    queries: Array<Record<string, unknown>>;
    queryError?: Error;
  } = { workflow: {}, tickets: [], queries: [] };
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
          if (name === "GetCommand") return { Item: { ...h.state.workflow } };
          if (name === "QueryCommand") {
            h.state.queries.push(cmd.input);
            if (h.state.queryError) throw h.state.queryError;
            return { Items: h.state.tickets };
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      const e = new Error("The specified key does not exist.");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send() {
      return { FailedEntryCount: 0, Entries: [] };
    }
  },
  PutEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send() {
      return { Payload: new TextEncoder().encode("{}") };
    }
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

type CancelRunModule = typeof import("./cancel-run");

const JIRA_ENV = { JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "token" };
const ENV_KEYS = ["TICKET_PROVIDER", ...Object.keys(JIRA_ENV)] as const;
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearJiraEnv() {
  for (const k of Object.keys(JIRA_ENV)) delete process.env[k];
}

function setJiraEnv() {
  Object.assign(process.env, JIRA_ENV);
}

const running = (over: Record<string, unknown> = {}) => ({ workflowId: "wf-1", epicId: "epic-1", phase: "development", ...over });
const withoutEpic = (over: Record<string, unknown> = {}) => {
  const { epicId: _dropped, ...row } = running(over);
  return row;
};

let originalFetch: typeof globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.state.workflow = running();
  h.state.tickets = [];
  h.state.queries = [];
  h.state.queryError = undefined;
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => {
    throw new Error("unexpected fetch: the listing must not be attempted");
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The ticket's own repro shape: what a caller sees, plus how often the backend was asked. */
function repro(loaded: Awaited<ReturnType<CancelRunModule["loadRunForCancel"]>>, listingCalls: number) {
  if (!loaded.ok) return { ok: false as const, status: loaded.status };
  return { ok: true as const, listError: loaded.listError ?? null, tickets: loaded.tickets.length, listingCalls };
}

describe("TEAM-5407 — loadRunForCancel on the DynamoDB backend (TICKET_PROVIDER unset)", () => {
  let mod: CancelRunModule;

  beforeAll(async () => {
    delete process.env.TICKET_PROVIDER;
    clearJiraEnv();
    vi.resetModules();
    mod = await import("./cancel-run");
  });

  afterAll(() => {
    restoreEnv();
    vi.resetModules();
  });

  it("control: a run with an epicId is listed once through parentId-index", async () => {
    h.state.tickets = [{ ticketId: "T-1", status: "ready", assignee: "agentcore_hub_backend_dev", parentId: "epic-1" }];
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.listError).toBeUndefined();
    expect(loaded.tickets.map((t) => t.ticketId)).toEqual(["T-1"]);
    expect(h.state.queries).toHaveLength(1);
    expect(h.state.queries[0]).toMatchObject({ IndexName: "parentId-index", ExpressionAttributeValues: { ":pid": "epic-1" } });
  });

  it("R2-02 repro: no epicId attribute -> listError set, no roster, the backend never asked", async () => {
    h.state.workflow = withoutEpic();
    h.state.tickets = [{ ticketId: "T-G1", status: "in_review", assignee: "human:engineer" }];
    const loaded = await mod.loadRunForCancel("wf-1");
    const out = repro(loaded, h.state.queries.length);
    expect(out).toMatchObject({ ok: true, tickets: 0, listingCalls: 0 });
    expect(out.ok && out.listError).toMatch(/^Ticket listing unavailable: .*no epicId/);
  });

  it("an empty-string epicId is the same failure", async () => {
    h.state.workflow = running({ epicId: "" });
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok && loaded.listError).toMatch(/no epicId/);
    expect(h.state.queries).toHaveLength(0);
  });

  it("a resumable cancelled row without an epicId is resume:true AND a listing failure (a /stop retry refuses too)", async () => {
    h.state.workflow = withoutEpic({ phase: "cancelled", cancelledAt: "2026-10-01T00:00:00Z", cancelCloseoutPending: true });
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.resume).toBe(true);
    expect(loaded.listError).toMatch(/no epicId/);
    expect(h.state.queries).toHaveLength(0);
  });

  it("regression: a failed parentId-index query is still 'Ticket query failed'", async () => {
    h.state.queryError = new Error("ProvisionedThroughputExceededException");
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok && loaded.listError).toBe("Ticket query failed: ProvisionedThroughputExceededException");
    expect(h.state.queries).toHaveLength(1);
  });

  it("listRunTickets('') rejects with TicketListingUnavailableError no_epic", async () => {
    await expect(mod.listRunTickets("", null)).rejects.toMatchObject({ name: "TicketListingUnavailableError", reason: "no_epic" });
    await expect(mod.listRunTickets("", null)).rejects.toBeInstanceOf(mod.TicketListingUnavailableError);
    expect(h.state.queries).toHaveLength(0);
  });
});

describe("TEAM-5407 — loadRunForCancel on the Jira backend (TICKET_PROVIDER=jira)", () => {
  let mod: CancelRunModule;

  beforeAll(async () => {
    process.env.TICKET_PROVIDER = "jira";
    clearJiraEnv();
    vi.resetModules();
    mod = await import("./cancel-run");
  });

  afterAll(() => {
    restoreEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearJiraEnv();
  });

  it("R2-02 repro: no Jira credentials -> listError set, no roster, Jira never called", async () => {
    h.state.workflow = running({ epicId: "PROJ-1" });
    const loaded = await mod.loadRunForCancel("wf-1");
    const out = repro(loaded, fetchSpy.mock.calls.length);
    expect(out).toMatchObject({ ok: true, tickets: 0, listingCalls: 0 });
    expect(out.ok && out.listError).toMatch(/^Ticket listing unavailable: Jira credentials not configured \(JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN\)/);
    expect(loaded.ok && loaded.jiraAuth).toBeNull();
    expect(h.state.queries).toHaveLength(0);
  });

  it("credentials present but no epicId -> listError no epicId, Jira never called", async () => {
    setJiraEnv();
    h.state.workflow = withoutEpic();
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok && loaded.listError).toMatch(/^Ticket listing unavailable: .*no epicId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("control: credentials and an epicId -> one JQL over the epic and its children, epic split out", async () => {
    setJiraEnv();
    h.state.workflow = running({ epicId: "PROJ-1" });
    fetchSpy.mockImplementation(async (url: string | URL) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/rest/api/3/search/jql");
      expect(u.searchParams.get("jql")).toBe("parent = PROJ-1 OR key = PROJ-1");
      return new Response(
        JSON.stringify({
          issues: [
            { key: "PROJ-1", fields: { status: { name: "In Progress" }, summary: "Epic" } },
            { key: "PROJ-2", fields: { status: { name: "To Do" }, labels: ["agent:agentcore_hub_backend_dev"] } },
          ],
          isLast: true,
        }),
        { status: 200 }
      );
    });
    const loaded = await mod.loadRunForCancel("wf-1");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.listError).toBeUndefined();
    expect(loaded.epic?.ticketId).toBe("PROJ-1");
    expect(loaded.tickets.map((t) => t.ticketId)).toEqual(["PROJ-2"]);
    expect(loaded.truncated).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("listRunTickets without auth rejects with TicketListingUnavailableError no_jira_auth", async () => {
    await expect(mod.listRunTickets("PROJ-1", null)).rejects.toMatchObject({ name: "TicketListingUnavailableError", reason: "no_jira_auth" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
