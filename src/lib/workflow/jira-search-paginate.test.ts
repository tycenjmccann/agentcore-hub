/**
 * TEAM-5171: searchJqlAll — the one bounded pager every web-tier /search/jql
 * reader goes through. Transport is injected, so no fetch stub is needed.
 */

import { describe, it, expect, vi } from "vitest";
import { searchJqlAll, type JqlPage } from "./jira-search-paginate";

type Issue = { key: string };

const issues = (from: number, n: number): Issue[] =>
  Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}` }));

/** fetchPage that serves `pages` in order, recording every request's params. */
function servePages(pages: Array<JqlPage<Issue>>) {
  const calls: URLSearchParams[] = [];
  const fetchPage = vi.fn(async (params: URLSearchParams) => {
    calls.push(params);
    const page = pages[calls.length - 1];
    if (!page) throw new Error(`unexpected page request #${calls.length}`);
    return page;
  });
  return { fetchPage, calls };
}

describe("searchJqlAll (TEAM-5171)", () => {
  it("follows nextPageToken until isLast and returns every issue", async () => {
    const { fetchPage, calls } = servePages([
      { issues: issues(0, 100), isLast: false, nextPageToken: "t2" },
      { issues: issues(100, 50), isLast: true },
    ]);
    const res = await searchJqlAll({ fetchPage, jql: "parent = E-1", fields: "status" });

    expect(res.truncated).toBe(false);
    expect(res.issues).toHaveLength(150);
    expect(calls).toHaveLength(2);
    expect(calls[0].get("nextPageToken")).toBeNull();
    expect(calls[0].get("maxResults")).toBe("100");
    expect(calls[0].get("jql")).toBe("parent = E-1");
    expect(calls[0].get("fields")).toBe("status");
    expect(calls[1].get("nextPageToken")).toBe("t2");
  });

  it("stops at the cap and reports truncated when more pages exist", async () => {
    const { fetchPage, calls } = servePages([
      { issues: issues(0, 100), isLast: false, nextPageToken: "t2" },
      { issues: issues(100, 50), isLast: false, nextPageToken: "t3" },
    ]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status", cap: 150 });

    expect(res.truncated).toBe(true);
    expect(res.issues).toHaveLength(150);
    // The second page only asks for what is left under the cap.
    expect(calls[1].get("maxResults")).toBe("50");
  });

  it("reaching exactly the cap on the last page is not truncated", async () => {
    const { fetchPage } = servePages([{ issues: issues(0, 100), isLast: true }]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status", cap: 100 });
    expect(res).toEqual({ issues: issues(0, 100), truncated: false });
  });

  it("isLast:false without a nextPageToken is truncated, not complete", async () => {
    const { fetchPage } = servePages([{ issues: issues(0, 100), isLast: false }]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res.truncated).toBe(true);
    expect(res.issues).toHaveLength(100);
  });

  it("a repeated token is truncated and terminates", async () => {
    const { fetchPage, calls } = servePages([
      { issues: issues(0, 10), isLast: false, nextPageToken: "same" },
      { issues: issues(10, 10), isLast: false, nextPageToken: "same" },
    ]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res.truncated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("endless empty pages with fresh tokens are bounded", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => ({ issues: [], isLast: false, nextPageToken: `t${++n}` }));
    const res = await searchJqlAll<Issue>({ fetchPage, jql: "q", fields: "status", cap: 200 });
    expect(res.truncated).toBe(true);
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(4);
  });

  // TEAM-5181 (R4-01): Atlassian's OpenAPI does not require `isLast`, and
  // `nextPageToken` is null only on the last (or only) page — so a fresh token
  // means more pages even when isLast is absent. isLast:true wins over a stray token.
  it("TEAM-5181: a page without isLast but with a nextPageToken has more pages", async () => {
    const { fetchPage, calls } = servePages([
      { issues: issues(0, 3), nextPageToken: "t2" },
      { issues: issues(3, 2), isLast: true },
    ]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res).toEqual({ issues: issues(0, 5), truncated: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].get("nextPageToken")).toBe("t2");
  });

  it("TEAM-5181: isLast:true with a stray nextPageToken stops after one page, complete", async () => {
    const { fetchPage, calls } = servePages([{ issues: issues(0, 3), isLast: true, nextPageToken: "stray" }]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res).toEqual({ issues: issues(0, 3), truncated: false });
    expect(calls).toHaveLength(1);
  });

  it("TEAM-5181: a page with neither isLast nor a token is the only page", async () => {
    const { fetchPage, calls } = servePages([{ issues: issues(0, 3) }]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res).toEqual({ issues: issues(0, 3), truncated: false });
    expect(calls).toHaveLength(1);
  });

  it("TEAM-5181: no isLast + a repeated token is truncated and terminates", async () => {
    const { fetchPage, calls } = servePages([
      { issues: issues(0, 10), nextPageToken: "same" },
      { issues: issues(10, 10), nextPageToken: "same" },
    ]);
    const res = await searchJqlAll({ fetchPage, jql: "q", fields: "status" });
    expect(res.truncated).toBe(true);
    expect(res.issues).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });

  it("a page error propagates to the caller", async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error("Jira 503");
    });
    await expect(searchJqlAll<Issue>({ fetchPage, jql: "q", fields: "status" })).rejects.toThrow("Jira 503");
  });
});
