/**
 * TEAM-5171: JiraClient.searchIssues/getChildIssues read one /search/jql page.
 * getChildIssues (the nudge scan) must return every child and throw rather than
 * hand back a truncated set; searchIssues keeps its `maxResults` limit semantics
 * (the bugs route asks for 1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JiraClient } from "./jira-client";

const issues = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}`, id: String(from + i), fields: { status: { name: "To Do" } } }));

function stubSearch(pages: Record<string, unknown> | ((token: string) => unknown)) {
  const requests: URL[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (!u.pathname.endsWith("/rest/api/3/search/jql")) throw new Error(`unexpected ${u.pathname}`);
    requests.push(u);
    const token = u.searchParams.get("nextPageToken") ?? "";
    const body = typeof pages === "function" ? pages(token) : pages[token];
    if (!body) throw new Error(`no page for token "${token}"`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return requests;
}

const client = () => new JiraClient({ siteUrl: "example.atlassian.net", email: "bot@example.com", apiToken: "token" });

describe("JiraClient — /search/jql pagination (TEAM-5171)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("getChildIssues returns all 150 children across 2 pages", async () => {
    const requests = stubSearch({
      "": { issues: issues(0, 100), isLast: false, nextPageToken: "p2" },
      p2: { issues: issues(100, 50), isLast: true },
    });

    const children = await client().getChildIssues("TEAM-1");
    expect(children).toHaveLength(150);
    expect(children[149].key).toBe("TEAM-149");
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.get("jql")).toBe('parent = "TEAM-1" ORDER BY created ASC');
  });

  it("getChildIssues throws instead of returning a truncated set", async () => {
    let n = 0;
    stubSearch(() => ({ issues: issues(n * 100, 100), isLast: false, nextPageToken: `p${++n}` }));

    const err = await client().getChildIssues("TEAM-1").then(() => null, (e: Error) => e);
    expect(err?.name).toBe("JiraSearchTruncatedError");
  });

  it("searchIssues(q, f, 1) makes one request for 1 result even when more exist", async () => {
    const requests = stubSearch({ "": { issues: issues(0, 1), isLast: false, nextPageToken: "p2" } });

    const res = await client().searchIssues("labels = x", ["summary"], 1);
    expect(res.issues).toHaveLength(1);
    expect(res.isLast).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("maxResults")).toBe("1");
  });
});
