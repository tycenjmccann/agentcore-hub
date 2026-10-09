// TEAM-5181 (R4-01) — the backfill's Jira pager, the fourth /rest/api/3/search/jql
// pager in the repo (with lambda/agentcore-hub-jira jiraSearchAll, the orchestrator's
// getChildTicketsFromJira and src/lib/workflow/jira-search-paginate.ts searchJqlAll).
//
// Atlassian's OpenAPI does not require `isLast`; `nextPageToken` is null only on the
// last (or only) page. The list this pager returns drives an unconditional tombstone
// Put per orphaned workflow id, so a partial list must THROW, never return.
//
// scripts/backfill-workflow-tombstones.mjs keeps every side effect (env check,
// process.exit, DynamoDB) behind main(), gated on being run as a script — so this
// import performs no I/O. The transport is injected, so no fetch stub is needed.
//
// Run: `node --test scripts/__tests__/backfill-tombstones-pager.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error("network must not be touched"); };
const { jiraSearch } = await import("../backfill-workflow-tombstones.mjs");
globalThis.fetch = originalFetch;

test("importing the script runs nothing: no fetch, no exit code", () => {
  assert.equal(fetchCalls, 0);
  assert.equal(process.exitCode, undefined);
  assert.equal(typeof jiraSearch, "function");
});

const issues = (from, n) => Array.from({ length: n }, (_, i) => ({ key: `TEAM-${from + i}`, fields: {} }));

/** Serves `pages[i]` to the i-th request; records every request's params. */
function servePages(pages) {
  const calls = [];
  const fetchPage = async (params) => {
    calls.push(params);
    const page = pages[calls.length - 1];
    if (!page) throw new Error(`unexpected page request #${calls.length}`);
    return page;
  };
  return { fetchPage, calls };
}

test("TEAM-5181: token present + isLast OMITTED → page 2 fetched, 101 issues returned", async () => {
  const { fetchPage, calls } = servePages([
    { issues: issues(100, 100), nextPageToken: "p2" },
    { issues: issues(200, 1), isLast: true },
  ]);
  const out = await jiraSearch("project = TEAM", "labels", fetchPage);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get("nextPageToken"), null);
  assert.equal(calls[1].get("nextPageToken"), "p2");
  assert.equal(calls[1].get("jql"), "project = TEAM");
  assert.equal(calls[1].get("maxResults"), "100");
  assert.equal(out.length, 101);
  assert.equal(out[100].key, "TEAM-200");
});

test("TEAM-5181: isLast:true with a non-empty token → one page, complete (isLast wins)", async () => {
  const { fetchPage, calls } = servePages([{ issues: issues(0, 3), isLast: true, nextPageToken: "stray" }]);
  const out = await jiraSearch("q", "labels", fetchPage);
  assert.equal(calls.length, 1);
  assert.equal(out.length, 3);
});

test("TEAM-5181: no isLast and no token → the only page, complete", async () => {
  const { fetchPage, calls } = servePages([{ issues: issues(0, 3) }]);
  const out = await jiraSearch("q", "labels", fetchPage);
  assert.equal(calls.length, 1);
  assert.equal(out.length, 3);
});

test("TEAM-5181: no isLast + a REPEATED token throws after the second page", async () => {
  const { fetchPage, calls } = servePages([
    { issues: issues(0, 100), nextPageToken: "same" },
    { issues: issues(100, 100), nextPageToken: "same" },
  ]);
  await assert.rejects(jiraSearch("q", "labels", fetchPage), /truncated/);
  assert.equal(calls.length, 2);
});

test("TEAM-5174 invariant: isLast:false with NO token throws", async () => {
  const { fetchPage, calls } = servePages([{ issues: issues(0, 100), isLast: false }]);
  await assert.rejects(jiraSearch("q", "labels", fetchPage), /truncated/);
  assert.equal(calls.length, 1);
});

test("TEAM-5174 invariant: isLast:false with an EMPTY token throws", async () => {
  const { fetchPage, calls } = servePages([{ issues: issues(0, 100), isLast: false, nextPageToken: "" }]);
  await assert.rejects(jiraSearch("q", "labels", fetchPage), /truncated/);
  assert.equal(calls.length, 1);
});

test("TEAM-5174 invariant: isLast:false with a REPEATED token throws after the second page", async () => {
  const { fetchPage, calls } = servePages([
    { issues: issues(0, 100), isLast: false, nextPageToken: "same" },
    { issues: issues(100, 100), isLast: false, nextPageToken: "same" },
  ]);
  await assert.rejects(jiraSearch("q", "labels", fetchPage), /truncated/);
  assert.equal(calls.length, 2);
});

test("TEAM-5168 regression: isLast:false with fresh tokens still pages to the end", async () => {
  const { fetchPage, calls } = servePages([
    { issues: issues(0, 100), isLast: false, nextPageToken: "p2" },
    { issues: issues(100, 50), isLast: true },
  ]);
  const out = await jiraSearch("q", "labels", fetchPage);
  assert.equal(calls.length, 2);
  assert.equal(out.length, 150);
});
