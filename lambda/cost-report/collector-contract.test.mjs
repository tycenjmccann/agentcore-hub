// TEAM-5159 — pins the coding-runtime OTel collector's cache-token mapping
// against the exact attribute names lambda/cost-report's span query reads.
//
// The defect this guards: deploy/coding-agent-runtime/otel-collector-config.yaml's
// transform/normalize processor copied input_tokens/output_tokens/model/cost_usd
// into gen_ai.* attributes but never copied Claude Code's cache_read_tokens /
// cache_creation_tokens, so every claude_code card showed cacheRead=0 and no
// cache cost. The collector config and the reader's SPAN_USAGE_FIELDS query live
// in different languages (OTTL vs a Logs Insights query string) and cannot share
// code, so this test parses the YAML and checks its statements against the exact
// attribute names SPAN_USAGE_FIELDS coalesces — the two must never drift apart
// again without this failing.
//
// Only reads the collector config (js-yaml's `yaml` package, already a root
// devDependency — see evals/battery/__tests__/gate-workflow.test.ts for the same
// import). Nothing here touches index.mjs's deployed surface: SPAN_USAGE_FIELDS
// is a plain exported string, no new AWS SDK import, so lambda/cost-report/
// deploy.sh's zip manifest (index.mjs + kpi.json) needs no change.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { SPAN_USAGE_FIELDS } from "./index.mjs";

const COLLECTOR_CONFIG = fileURLToPath(
  new URL("../../deploy/coding-agent-runtime/otel-collector-config.yaml", import.meta.url),
);
const collector = parse(readFileSync(COLLECTOR_CONFIG, "utf8"));

const normalize = collector.processors["transform/normalize"];
const CACHE_READ_STATEMENT =
  'set(attributes["gen_ai.usage.cache_read_input_tokens"], attributes["cache_read_tokens"]) where attributes["cache_read_tokens"] != nil';
const CACHE_WRITE_STATEMENT =
  'set(attributes["gen_ai.usage.cache_write_input_tokens"], attributes["cache_creation_tokens"]) where attributes["cache_creation_tokens"] != nil';

for (const [pipeline, statementsKey] of [["logs", "log_statements"], ["traces", "trace_statements"]]) {
  test(`${pipeline} transform/normalize copies Claude Code cache tokens to gen_ai.usage.cache_*_input_tokens`, () => {
    const statements = normalize[statementsKey][0].statements;
    assert.ok(
      statements.includes(CACHE_READ_STATEMENT),
      `${statementsKey} is missing the cache_read_tokens -> gen_ai.usage.cache_read_input_tokens mapping`,
    );
    assert.ok(
      statements.includes(CACHE_WRITE_STATEMENT),
      `${statementsKey} is missing the cache_creation_tokens -> gen_ai.usage.cache_write_input_tokens mapping`,
    );
  });
}

test("both pipelines still normalize input/output/model/cost the same way", () => {
  // Guards against a future edit narrowing the fix to only one of the two
  // statement lists — logs and traces have always carried identical statements.
  assert.deepStrictEqual(normalize.log_statements[0].statements, normalize.trace_statements[0].statements);
});

test("the collector writes exactly the cache attribute names SPAN_USAGE_FIELDS reads", () => {
  // The names the collector's `set(...)` targets land in — what cost-report's
  // span query must coalesce for, or the mapping above is dead code.
  assert.match(SPAN_USAGE_FIELDS, /`attributes\.gen_ai\.usage\.cache_read_input_tokens`/);
  assert.match(SPAN_USAGE_FIELDS, /`attributes\.gen_ai\.usage\.cache_write_input_tokens`/);
  // The raw Claude Code names the collector reads FROM — kept as the query's
  // last fallback so events logged before this fix still price on --backfill.
  assert.match(SPAN_USAGE_FIELDS, /`attributes\.cache_read_tokens`/);
  assert.match(SPAN_USAGE_FIELDS, /`attributes\.cache_creation_tokens`/);
});
