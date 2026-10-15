/**
 * TEAM-6146 — "there are three partial copies of the Jira status -> hub status
 * mapping; only the ticket-transition-refusal.ts mirror is pinned by a parity test."
 *
 * This pins the REMAINING copies — the orchestrator Lambda's private mapJiraStatus,
 * jira-client.ts's mapJiraStatusToInternal (the real Jira webhook / nudge / retry
 * routes), and the board readers ticket-provider-jira.ts / jira-read.ts — against the
 * REAL jira ticket-tools Lambda's mapStatusToInternal, the same way
 * ticket-transition-refusal.jira-e2e.test.ts already pins jiraStatusToInternal.
 *
 * Hermetic: both Lambda modules (jira, orchestrator) are imported for real with
 * ARTIFACT_BUCKET / WORKFLOWS_TABLE / EVENTS_TABLE / PIPELINE_TOOLS_LAMBDA unset, so
 * neither one does any AWS I/O at module load (same env shape as the e2e test above).
 * Nothing here invokes a handler — only the pure status-mapping functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { jiraDisplayNameOf, jiraStatusToInternal, HUB_STATUSES } from "./ticket-transition-refusal";
import { jiraStatusToTicketStatus } from "./jira-status-map";
import { mapJiraStatusToInternal, BOARD_ALIASES } from "./jira-client";

// Every Jira display name the mirror knows (via each hub status), the cancelled
// spellings, and names the hub does NOT model — duplicated from
// ticket-transition-refusal.jira-e2e.test.ts's NAMES (not exported there).
const NAMES: unknown[] = [
  ...HUB_STATUSES.map((s) => jiraDisplayNameOf(s)),
  "To Do", "Ready", "In Progress", "In Review", "Blocked", "Done", "Won't Do",
  "WONT DO", "wont do", "Cancelled", "Canceled",
  "Closed", "Resolved", "Open", "Waiting for review", "Ready for QA",
  "  In Progress ", "DONE", "", null, undefined,
];

const ENV_KEYS = ["JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "ARTIFACT_BUCKET", "WORKFLOWS_TABLE", "EVENTS_TABLE", "PIPELINE_TOOLS_LAMBDA"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.JIRA_SITE_URL = "jira.test";
  process.env.JIRA_EMAIL = "bot@test";
  process.env.JIRA_API_TOKEN = "t";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.WORKFLOWS_TABLE;
  delete process.env.EVENTS_TABLE;
  delete process.env.PIPELINE_TOOLS_LAMBDA;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function loadJiraCanon(): Promise<(name: unknown) => string> {
  vi.resetModules();
  const mod = (await import("../../../lambda/agentcore-hub-jira/index.mjs")) as { mapStatusToInternal: (name: unknown) => string };
  return mod.mapStatusToInternal;
}

async function loadOrchestratorMapJiraStatus(): Promise<(name: unknown) => string> {
  vi.resetModules();
  const mod = (await import("../../../lambda/orchestrator/index.mjs")) as { mapJiraStatus: (name: unknown) => string };
  return mod.mapJiraStatus;
}

describe("jira-status-map.ts × the REAL jira Lambda's mapStatusToInternal (TEAM-6146)", () => {
  it.each(NAMES.map((n) => [n]))("the shared mirror jiraStatusToInternal(%j) === mapStatusToInternal(%j)", async (name) => {
    const mapStatusToInternal = await loadJiraCanon();
    expect(jiraStatusToInternal(name)).toBe(mapStatusToInternal(name));
  });
});

describe("orchestrator mapJiraStatus × the REAL jira Lambda's mapStatusToInternal (TEAM-6146)", () => {
  it.each(NAMES.map((n) => [n]))("mapJiraStatus(%j) === mapStatusToInternal(%j)", async (name) => {
    const mapStatusToInternal = await loadJiraCanon();
    const mapJiraStatus = await loadOrchestratorMapJiraStatus();
    expect(mapJiraStatus(name)).toBe(mapStatusToInternal(name));
  });

  it('"Backlog" still maps to "backlog" (not modeled by the canonical map, but a real orchestrator board state)', async () => {
    const mapJiraStatus = await loadOrchestratorMapJiraStatus();
    expect(mapJiraStatus("Backlog")).toBe("backlog");
  });
});

describe("jira-client.ts mapJiraStatusToInternal × the REAL jira Lambda (TEAM-6146)", () => {
  it("BOARD_ALIASES is exactly todo/open -> todo, closed/resolved -> done", () => {
    expect(BOARD_ALIASES).toEqual({ todo: "todo", open: "todo", closed: "done", resolved: "done" });
  });

  it.each(NAMES.map((n) => [n]))("mapJiraStatusToInternal(%j) === BOARD_ALIASES[norm] ?? mapStatusToInternal(%j)", async (name) => {
    const mapStatusToInternal = await loadJiraCanon();
    const norm = typeof name === "string" ? name.trim().toLowerCase() : "";
    const expected = BOARD_ALIASES[norm] ?? mapStatusToInternal(name);
    expect(mapJiraStatusToInternal(name)).toBe(expected);
  });

  it("is null-safe (undefined/null do not throw, and match the canonical empty-name output)", () => {
    expect(mapJiraStatusToInternal(undefined)).toBe("");
    expect(mapJiraStatusToInternal(null)).toBe("");
  });
});

describe("jiraStatusToTicketStatus (board fallback used by ticket-provider-jira.ts / jira-read.ts) (TEAM-6146)", () => {
  it.each(NAMES.map((n) => [n]))("jiraStatusToTicketStatus(%j) === canon when canon is a known TicketStatus, else 'todo'", async (name) => {
    const mapStatusToInternal = await loadJiraCanon();
    const canon = mapStatusToInternal(name);
    const expected = [...HUB_STATUSES, "backlog"].includes(canon) ? canon : "todo";
    expect(jiraStatusToTicketStatus(name)).toBe(expected);
  });

  it('"Backlog" -> "backlog"', () => {
    expect(jiraStatusToTicketStatus("Backlog")).toBe("backlog");
  });

  it('an unmodeled name (e.g. "Waiting for review") -> "todo"', () => {
    expect(jiraStatusToTicketStatus("Waiting for review")).toBe("todo");
  });
});

/**
 * Drive-through: prove ticket-provider-jira.ts and jira-read.ts actually CALL
 * jiraStatusToTicketStatus, not just that the helper itself is correct.
 */
describe("ticket-provider-jira.ts JiraCloudProvider — status mapping drive-through (TEAM-6146)", () => {
  const JIRA_ENV = { JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "token", JIRA_PROJECT_KEY: "TEAM" };

  beforeEach(() => {
    Object.assign(process.env, JIRA_ENV);
  });
  afterEach(() => {
    for (const k of Object.keys(JIRA_ENV)) delete process.env[k];
  });

  function mockFetch(landedStatusName: string) {
    return vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      const method = options.method || "GET";
      const u = String(url);
      if (method === "POST" && u.endsWith("/rest/api/3/issue")) {
        return new Response(JSON.stringify({ key: "TEAM-999" }), { status: 201 });
      }
      // the createTicket follow-up getIssue GET
      return new Response(
        JSON.stringify({
          key: "TEAM-999",
          fields: { summary: "s", status: { name: landedStatusName }, issuetype: { name: "Task" }, labels: [] },
        }),
        { status: 200 }
      );
    });
  }

  it.each([
    ["Won't Do", "cancelled"],
    ["DONE", "done"],
    ["Closed", "todo"], // not in TicketStatus's board set via the canonical map — falls back
    ["Backlog", "backlog"],
  ])("createTicket landing in Jira status %j reads back as %j", async (landed, expected) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(landed) as unknown as typeof globalThis.fetch;
    try {
      const { JiraCloudProvider } = await import("./ticket-provider-jira");
      const jira = new JiraCloudProvider();
      const ticket = await jira.createTicket({ parentId: "TEAM-1", title: "t", description: "d", assignee: "" });
      expect(ticket.status).toBe(expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("jira-read.ts getTicketsForWorkflowFromJira — status mapping drive-through (TEAM-6146)", () => {
  const JIRA_ENV = { JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "token", JIRA_PROJECT_KEY: "TEAM" };

  beforeEach(() => {
    Object.assign(process.env, JIRA_ENV);
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of Object.keys(JIRA_ENV)) delete process.env[k];
  });

  function stubSearch(statusName: string) {
    const payload = {
      issues: [
        {
          key: "TEAM-1",
          fields: {
            summary: "s",
            status: { name: statusName },
            issuetype: { name: "Task" },
            created: "2026-09-16T00:00:00.000Z",
            updated: "2026-09-16T01:00:00.000Z",
          },
        },
      ],
    };
    return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
  }

  it.each([
    ["Won't Do", "cancelled"],
    ["DONE", "done"],
    ["Backlog", "backlog"],
  ])("a %j issue reads back as status %j", async (jiraStatus, expected) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubSearch(jiraStatus) as unknown as typeof globalThis.fetch;
    try {
      const { getTicketsForWorkflowFromJira } = await import("./jira-read");
      const tickets = await getTicketsForWorkflowFromJira("wf_1");
      expect(tickets).toHaveLength(1);
      expect(tickets[0].status).toBe(expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
