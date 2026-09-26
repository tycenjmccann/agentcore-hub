/**
 * TEAM-5171: JiraCloudProvider.isWorkflowComplete read only the first
 * /search/jql page (≤100 children), so an epic whose first 100 children were
 * Done reported complete while child #101+ was still open. It must page through
 * every child, and a scan cut short by the cap must never report complete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const status = (name: string, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}`, fields: { status: { name } } }));

/** Serves /search/jql pages keyed by the request's nextPageToken ("" = first page). */
function stubSearch(pages: Record<string, unknown> | ((token: string) => unknown)) {
  const tokens: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (!u.pathname.endsWith("/rest/api/3/search/jql")) throw new Error(`unexpected ${u.pathname}`);
    const token = u.searchParams.get("nextPageToken") ?? "";
    tokens.push(token);
    const body = typeof pages === "function" ? pages(token) : pages[token];
    if (!body) throw new Error(`no page for token "${token}"`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return tokens;
}

describe("JiraCloudProvider.isWorkflowComplete — pagination (TEAM-5171)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_PROJECT_KEY = "TEAM";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_PROJECT_KEY;
  });

  it("150 children: first page all Done, one open child on page 2 → NOT complete", async () => {
    const tokens = stubSearch({
      "": { issues: status("Done", 0, 100), isLast: false, nextPageToken: "p2" },
      p2: { issues: [...status("Done", 100, 49), ...status("In Progress", 149, 1)], isLast: true },
    });
    const { JiraCloudProvider } = await import("./ticket-provider-jira");

    expect(await new JiraCloudProvider().isWorkflowComplete("TEAM-1")).toBe(false);
    expect(tokens).toEqual(["", "p2"]);
  });

  it("150 children all Done across 2 pages → complete", async () => {
    stubSearch({
      "": { issues: status("Done", 0, 100), isLast: false, nextPageToken: "p2" },
      p2: { issues: status("Done", 100, 50), isLast: true },
    });
    const { JiraCloudProvider } = await import("./ticket-provider-jira");

    expect(await new JiraCloudProvider().isWorkflowComplete("TEAM-1")).toBe(true);
  });

  it("a scan truncated at the cap (every page Done, never isLast) → NOT complete", async () => {
    let n = 0;
    stubSearch(() => ({ issues: status("Done", n * 100, 100), isLast: false, nextPageToken: `p${++n}` }));
    const { JiraCloudProvider } = await import("./ticket-provider-jira");

    expect(await new JiraCloudProvider().isWorkflowComplete("TEAM-1")).toBe(false);
  });
});
