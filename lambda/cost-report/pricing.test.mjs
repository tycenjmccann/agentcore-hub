// TEAM-3954: cache-aware cost accounting in the performance-card Lambda.
// REPORT_VERSION 4: input_tokens semantics are per-engine (see uncachedInput).
//
// Unit tests for the pure `addUsage` reducer exported by index.mjs. Importing
// index.mjs evaluates its top-level `@aws-sdk/*` imports and constructs a few
// clients (lines ~109-116), but the lambda dir has no real node_modules — the
// AWS SDK is provided by the Lambda runtime, and deploy.sh zips index.mjs ALONE
// (`zip -j index.mjs`), so nothing here ever ships. A tiny gitignored stub
// node_modules beside this file satisfies those imports offline; addUsage
// itself is pure arithmetic and never touches the SDK.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";

import { addUsage, uncachedInput, PERSONA_CHAT_SPAN_FILTER } from "./index.mjs";

// Fixture: 10/50 USD per 1M in/out; cache-read at 0.1x input; cache-write
// surcharge 1.25x (5m) / 2x (1h) / 1.25x (default) of the input rate.
const PRICING = {
  models: { m: { input: 10, output: 50 } },
  default: { input: 10, output: 50 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { "5m": 1.25, "1h": 2, default: 1.25 },
};

const M = 1_000_000;

// Fresh accumulator + the engine record addUsage writes into. Default engine
// is "persona" (Strands spans), whose input_tokens INCLUDES cache traffic.
function fresh(engine = "persona") {
  const byAgent = {};
  return {
    byAgent,
    add: (row) => addUsage(byAgent, "req", engine, row, PRICING),
    eng: () => byAgent.req.engines[engine],
  };
}

test("persona: cache-read tokens are billed ONLY at the discounted rate (input includes them)", () => {
  const t = fresh();
  // Strands reports input_tokens = uncached + cache_read + cache_write, so a
  // 2M input with 1M read means 1M uncached ($10) + 1M read ($10 * 0.1 = $1).
  t.add({ model: "m", inp: 2 * M, outp: 0, cacheRead: M });
  const u = t.eng();
  assert.equal(u.usd, 11);
  assert.equal(u.inputTokens, 2 * M); // token counters stay raw
  assert.equal(u.cacheReadInputTokens, M);
  assert.equal(u.cacheWriteInputTokens, 0);
});

test("persona: a fully cached prompt is not also billed as fresh input (the 7x bug)", () => {
  const t = fresh();
  t.add({ model: "m", inp: M, outp: 0, cacheRead: M });
  // Pre-v4 this came out as $10 + $1 = $11 — the cached 1M charged at 110%.
  assert.equal(t.eng().usd, 1);
});

test("claude_code: input_tokens is the uncached remainder, so it is billed in full", () => {
  const t = fresh("claude_code");
  t.add({ model: "m", inp: M, outp: 0, cacheRead: M });
  // 1M uncached ($10) + 1M read ($1).
  assert.equal(t.eng().usd, 11);
});

test("codex: cached_input_tokens is a subset of input_tokens", () => {
  const t = fresh("codex");
  t.add({ model: "m", inp: 2 * M, outp: 0, cacheRead: M });
  assert.equal(t.eng().usd, 11);
});

test("unknown engine falls back to the inclusive heuristic (input >= cache => subtract)", () => {
  assert.equal(uncachedInput("mystery", 10, 3, 2), 5); // inclusive shape
  assert.equal(uncachedInput("mystery", 2, 3, 2), 2);  // remainder shape
  assert.equal(uncachedInput("persona", 2, 3, 2), 0);  // never negative
});

test("regression: Buster dead-code sweep (wf_1788779651903_463811) persona spend", () => {
  // Real persona totals from the run's v3 card. At 20/100 the card said
  // $1,857.09; the correct Bedrock-equivalent figure is ~$243.
  const pricing = { ...PRICING, models: { f: { input: 20, output: 100 } }, default: { input: 20, output: 100 } };
  const byAgent = {};
  addUsage(byAgent, "run", "persona", {
    model: "f", inp: 79_315_825, outp: 410_456, cacheRead: 77_443_509, cacheWrite: 1_871_132, ttl: "5m",
  }, pricing);
  const usd = byAgent.run.engines.persona.usd;
  assert.ok(usd > 240 && usd < 246, `expected ~243, got ${usd}`);
});

test("cache-write is billed at the per-TTL surcharge multiple of the input rate", () => {
  const oneHour = fresh();
  oneHour.add({ model: "m", inp: M, outp: 0, cacheWrite: M, ttl: "1h" });
  // 1M cache-write @ 1h => $10 * 2 = $20.
  assert.equal(oneHour.eng().usd, 20);
  assert.equal(oneHour.eng().cacheWriteInputTokens, M);

  const fiveMin = fresh();
  fiveMin.add({ model: "m", inp: M, outp: 0, cacheWrite: M, ttl: "5m" });
  // 1M cache-write @ 5m => $10 * 1.25 = $12.50.
  assert.equal(fiveMin.eng().usd, 12.5);
});

test("missing or unknown ttl falls back to the default write multiplier", () => {
  const noTtl = fresh();
  noTtl.add({ model: "m", inp: M, outp: 0, cacheWrite: M }); // ttl absent
  assert.equal(noTtl.eng().usd, 12.5); // default 1.25 => $12.50

  const badTtl = fresh();
  badTtl.add({ model: "m", inp: M, outp: 0, cacheWrite: M, ttl: "42h" }); // unknown tier
  assert.equal(badTtl.eng().usd, 12.5); // still default 1.25 => $12.50
});

test("tokens accumulate across rows and byModel tracks read/write", () => {
  const t = fresh();
  t.add({ model: "m", inp: 100, outp: 200, cacheRead: 50, cacheWrite: 30, ttl: "1h" });
  t.add({ model: "m", inp: 400, outp: 600, cacheRead: 70, cacheWrite: 10, ttl: "1h" });
  const u = t.eng();
  assert.equal(u.inputTokens, 500);
  assert.equal(u.outputTokens, 800);
  assert.equal(u.cacheReadInputTokens, 120);
  assert.equal(u.cacheWriteInputTokens, 40);

  const m = u.byModel.m;
  assert.equal(m.inputTokens, 500);
  assert.equal(m.outputTokens, 800);
  assert.equal(m.cacheReadInputTokens, 120);
  assert.equal(m.cacheWriteInputTokens, 40);
  assert.equal(m.usd, u.usd); // single model => byModel usd mirrors engine usd
});

test("back-compat: cachedInputTokens mirrors cacheReadInputTokens", () => {
  const t = fresh();
  t.add({ model: "m", inp: 0, outp: 0, cacheRead: 111 });
  t.add({ model: "m", inp: 0, outp: 0, cacheRead: 222 });
  const u = t.eng();
  assert.equal(u.cachedInputTokens, 333);
  assert.equal(u.cachedInputTokens, u.cacheReadInputTokens);
});

test("plain rows (no cache fields) are unchanged by cache logic", () => {
  const t = fresh();
  t.add({ model: "m", inp: M, outp: M });
  const u = t.eng();
  // 1M in @ $10 + 1M out @ $50 = $60, with zero cache footprint.
  assert.equal(u.usd, 60);
  assert.equal(u.cacheReadInputTokens, 0);
  assert.equal(u.cacheWriteInputTokens, 0);
  assert.equal(u.cachedInputTokens, 0);
});

// TEAM-3964 / R1-F1: strands-agents >=1.53 names model spans exactly "chat"
// (no " <model>" suffix — model id moved to the gen_ai.request.model
// attribute). The persona query's filter must match that exact name, not just
// the legacy "chat <model>" shape, or persona token/cache accounting on
// current strands silently zeroes out.
test("persona chat-span filter matches the exact strands >=1.53 span name", () => {
  assert.match(PERSONA_CHAT_SPAN_FILTER, /name\s*=\s*"chat"/);
});

test("persona chat-span filter still matches the legacy 'chat <model>' shape", () => {
  assert.match(PERSONA_CHAT_SPAN_FILTER, /name like \/\^chat \//);
});

test("persona chat-span filter still ORs in the api_request event-name branch", () => {
  assert.match(PERSONA_CHAT_SPAN_FILTER, /`attributes\.event\.name` = "api_request"/);
});
