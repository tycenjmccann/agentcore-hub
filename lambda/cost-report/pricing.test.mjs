// TEAM-3954: cache-aware cost accounting in the performance-card Lambda.
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

import { addUsage } from "./index.mjs";

// Fixture: 10/50 USD per 1M in/out; cache-read at 0.1x input; cache-write
// surcharge 1.25x (5m) / 2x (1h) / 1.25x (default) of the input rate.
const PRICING = {
  models: { m: { input: 10, output: 50 } },
  default: { input: 10, output: 50 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { "5m": 1.25, "1h": 2, default: 1.25 },
};

const M = 1_000_000;

// Fresh accumulator + the engine record addUsage writes into.
function fresh() {
  const byAgent = {};
  return {
    byAgent,
    add: (row) => addUsage(byAgent, "req", "strands", row, PRICING),
    eng: () => byAgent.req.engines.strands,
  };
}

test("cache-read tokens are billed at the discounted input rate", () => {
  const t = fresh();
  t.add({ model: "m", inp: M, outp: 0, cacheRead: M });
  const u = t.eng();
  // plain input 1M => $10; cache-read 1M => $10 * 0.1 = $1.
  assert.equal(u.usd, 11);
  assert.equal(u.cacheReadInputTokens, M);
  assert.equal(u.cacheWriteInputTokens, 0);
});

test("cache-write is billed at the per-TTL surcharge multiple of the input rate", () => {
  const oneHour = fresh();
  oneHour.add({ model: "m", inp: 0, outp: 0, cacheWrite: M, ttl: "1h" });
  // 1M cache-write @ 1h => $10 * 2 = $20.
  assert.equal(oneHour.eng().usd, 20);
  assert.equal(oneHour.eng().cacheWriteInputTokens, M);

  const fiveMin = fresh();
  fiveMin.add({ model: "m", inp: 0, outp: 0, cacheWrite: M, ttl: "5m" });
  // 1M cache-write @ 5m => $10 * 1.25 = $12.50.
  assert.equal(fiveMin.eng().usd, 12.5);
});

test("missing or unknown ttl falls back to the default write multiplier", () => {
  const noTtl = fresh();
  noTtl.add({ model: "m", inp: 0, outp: 0, cacheWrite: M }); // ttl absent
  assert.equal(noTtl.eng().usd, 12.5); // default 1.25 => $12.50

  const badTtl = fresh();
  badTtl.add({ model: "m", inp: 0, outp: 0, cacheWrite: M, ttl: "42h" }); // unknown tier
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
