/**
 * TEAM-5173 r5-F3 — vitest coverage of the coding_usage paging contract, so that
 * `npx vitest run lambda/cost-report` (the ticket's literal acceptance gate) has
 * something to run. The rest of lambda/cost-report is node:test (`node --test
 * lambda/cost-report`, the CI gate) and the two runners cannot share a file: this
 * one is `.test.ts` under `__tests__/`, which node's default test globs
 * (`*.test.{js,mjs,cjs}`) never match and deploy/pipeline/surfaces.json ignores.
 *
 * Hermetic: `collectInsightsRows` takes its Insights runner as an argument, so the
 * 10,001-record store below stands in for CloudWatch. Importing index.mjs
 * evaluates its top-level `@aws-sdk/*` imports — safe offline, see
 * pricing.test.mjs's header.
 */
import { describe, expect, it } from "vitest";

import {
  aggregateCodingUsage,
  collectInsightsRows,
  parseCodingUsageLine,
  parseInsightsTimestamp,
  queryCodingUsageRecords,
} from "../index.mjs";

type Row = { "@timestamp": string; "@message": string; "@ptr": string };
type Runner = (groups: string[], query: string, startSec: number, endSec: number) => Promise<Row[]>;

const T0 = Date.UTC(2026, 8, 25, 20, 0, 0);
const SID = "cc-r5f3-vitest-0123456789abcdef";
const LIMIT = 10000;

/** The Instances runtime's {"log":"<json>"} envelope around one 10-input-token turn. */
function usageLine(ms: number): string {
  const inner = {
    timestamp: new Date(ms).toISOString(), message: "coding_usage", cli: "codex", coding_session_id: SID,
    model: "us.openai.gpt-5.5", input_tokens: 10, output_tokens: 1, cached_input_tokens: 0, credits: 0.0,
  };
  return JSON.stringify({ log: JSON.stringify(inner) });
}

const insightsTs = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

/** n records spread evenly over `seconds` seconds from T0. */
function records(n: number, seconds: number) {
  return Array.from({ length: n }, (_, i) => {
    const ms = T0 + Math.floor((i * seconds * 1000) / n);
    return { ms, msg: usageLine(ms), ptr: `ptr-${i}` };
  });
}

/** `sort @timestamp asc | limit N` over an in-memory store, window in whole seconds. */
function fakeInsights(store: ReturnType<typeof records>, limit = LIMIT) {
  const calls: Array<{ startSec: number; endSec: number }> = [];
  const run: Runner = async (_groups, _query, startSec, endSec) => {
    calls.push({ startSec, endSec });
    return store
      .filter((r) => r.ms >= startSec * 1000 && r.ms < endSec * 1000)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, limit)
      .map((r) => ({ "@timestamp": insightsTs(r.ms), "@message": r.msg, "@ptr": r.ptr }));
  };
  return { run, calls };
}

const WINDOW = [T0 / 1000 - 60, T0 / 1000 + 60] as const;

describe("collectInsightsRows (TEAM-5173 r5-F3)", () => {
  it("collects all 10,001 records across the 10,000-row page limit and bills them in full", async () => {
    const store = records(10001, 3);
    const { run, calls } = fakeInsights(store);
    const res = await collectInsightsRows(run, "g", "… | sort @timestamp asc | limit 10000", WINDOW[0], WINDOW[1], { limit: LIMIT });
    expect(res.complete).toBe(true);
    expect(res.pages).toBe(2);
    expect(res.rows).toHaveLength(10001);
    expect(calls[1].startSec).toBe(Math.floor(store[9999].ms / 1000));
    const billed = aggregateCodingUsage(res.rows.map((r: Row) => parseCodingUsageLine(r["@message"])), [SID]);
    expect(billed).toHaveLength(1);
    expect(billed[0].inp).toBe(10 * 10001);
  });

  it("reports complete:false when a full page sits inside one second (cursor cannot advance)", async () => {
    const { run } = fakeInsights(records(10001, 1));
    const res = await collectInsightsRows(run, "g", "…", WINDOW[0], WINDOW[1], { limit: LIMIT });
    expect(res.complete).toBe(false);
    expect(res.reason).toBe("no-progress");
    expect(res.pages).toBe(2);
    expect(res.rows).toHaveLength(10000);
  });

  it("reports complete:false at the page cap", async () => {
    const { run, calls } = fakeInsights(records(1000, 100), 100);
    const res = await collectInsightsRows(run, "g", "…", WINDOW[0], T0 / 1000 + 200, { limit: 100, maxPages: 3 });
    expect(res).toMatchObject({ complete: false, reason: "page-cap", pages: 3 });
    expect(calls).toHaveLength(3);
  });

  it("parses Insights' @timestamp rendering and rejects other shapes", () => {
    expect(parseInsightsTimestamp("2026-09-25 20:58:56.609")).toBe(Date.UTC(2026, 8, 25, 20, 58, 56, 609));
    expect(Number.isNaN(parseInsightsTimestamp(undefined))).toBe(true);
    expect(Number.isNaN(parseInsightsTimestamp("not a time"))).toBe(true);
  });
});

describe("queryCodingUsageRecords (TEAM-5173 r5-F3)", () => {
  const sessions = [{ sessionId: SID, cli: "codex", agentId: "a", runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt1" }];

  it("returns complete:true and no gap when every page was read", async () => {
    const gaps: string[] = [];
    const res = await queryCodingUsageRecords(sessions, gaps, WINDOW[0], WINDOW[1], fakeInsights(records(10001, 3)).run);
    expect(res.complete).toBe(true);
    expect(res.rows[0].inp).toBe(10 * 10001);
    expect(gaps).toEqual([]);
  });

  it("returns complete:false (→ costPartial) and names the group when the walk could not finish", async () => {
    const gaps: string[] = [];
    const res = await queryCodingUsageRecords(sessions, gaps, WINDOW[0], WINDOW[1], fakeInsights(records(10001, 1)).run);
    expect(res.complete).toBe(false);
    expect(res.rows[0].inp).toBe(10 * 10000);
    expect(gaps).toEqual([
      "coding_usage results incomplete on /aws/bedrock-agentcore/runtimes/rt1-DEFAULT (no-progress after 2 page(s) of 10000) — codex/kiro cost understated",
    ]);
  });
});
