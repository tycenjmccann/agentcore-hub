/**
 * TEAM-5171: getTicketsForWorkflowFromJira read one /search/jql page, so a
 * workflow with >100 `wf:` children lost the rest from the board, the
 * transition gate lookup and — worst — the completion gate. It must page
 * through all of them; with `requireComplete` a truncated scan throws.
 *
 * jira-read.ts reads its JIRA_* env at module top level, hence resetModules +
 * dynamic import (same as jira-read-labels.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const WORKFLOW_ID = "wf_1";
const EPIC = "TEAM-1";

const children = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `TEAM-${from + i}`,
    fields: {
      summary: `child ${from + i}`,
      status: { name: "To Do" },
      issuetype: { name: "Task" },
      parent: { key: EPIC },
      labels: [`wf:${WORKFLOW_ID}`],
    },
  }));

/** /search/jql pages keyed by nextPageToken ("" = first); /issue/<epic> answers the epic. */
function stubJira(pages: Record<string, unknown> | ((token: string) => unknown)) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/rest/api/3/search/jql")) {
      const token = u.searchParams.get("nextPageToken") ?? "";
      const body = typeof pages === "function" ? pages(token) : pages[token];
      if (!body) throw new Error(`no page for token "${token}"`);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.pathname.endsWith(`/rest/api/3/issue/${EPIC}`)) {
      return new Response(
        JSON.stringify({ key: EPIC, fields: { summary: "epic", status: { name: "In Progress" }, issuetype: { name: "Epic" }, labels: [] } }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected ${u.pathname}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

describe("getTicketsForWorkflowFromJira — pagination (TEAM-5171)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_PROJECT_KEY = "TEAM";
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_PROJECT_KEY;
  });

  it("returns all 150 children across 2 pages (plus the epic)", async () => {
    stubJira({
      "": { issues: children(100, 100), isLast: false, nextPageToken: "p2" },
      p2: { issues: children(200, 50), isLast: true },
    });
    const { getTicketsForWorkflowFromJira } = await import("./jira-read");

    const tickets = await getTicketsForWorkflowFromJira(WORKFLOW_ID);
    const childIds = tickets.filter((t) => t.ticketId !== EPIC).map((t) => t.ticketId);
    expect(childIds).toHaveLength(150);
    expect(new Set(childIds).size).toBe(150);
    expect(childIds).toContain("TEAM-249");
    expect(tickets.some((t) => t.ticketId === EPIC)).toBe(true);
  });

  const endless = () => {
    let n = 0;
    return () => ({ issues: children(100 + n * 100, 100), isLast: false, nextPageToken: `p${++n}` });
  };

  it("requireComplete: a scan truncated at the cap throws instead of returning a partial list", async () => {
    stubJira(endless());
    const { getTicketsForWorkflowFromJira } = await import("./jira-read");

    const err = await getTicketsForWorkflowFromJira(WORKFLOW_ID, { requireComplete: true }).then(() => null, (e: Error) => e);
    expect(err?.name).toBe("JiraSearchTruncatedError");
    expect(err?.message).toMatch(/truncated/);
  });

  it("without requireComplete a truncated scan returns the capped list", async () => {
    stubJira(endless());
    const { getTicketsForWorkflowFromJira } = await import("./jira-read");

    const tickets = await getTicketsForWorkflowFromJira(WORKFLOW_ID);
    expect(tickets.filter((t) => t.ticketId !== EPIC)).toHaveLength(1000);
  });
});
