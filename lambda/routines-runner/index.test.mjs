/**
 * Unit tests for the routines-runner payload builder.
 *   node --test    (from lambda/routines-runner/)
 *
 * buildPayload is not exported (the handler pulls AWS SDK at import time), so we
 * re-declare the pure function here and assert its contract. It MUST stay in sync
 * with buildPayload in index.mjs and buildStartPayload in src/lib/routines/payload.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

function buildPayload(input, firedAt) {
  const date = firedAt.toISOString().slice(0, 10);
  const title = String(input.titleTemplate || "Scheduled routine").replace(/\{date\}/g, date);
  const payload = {
    title,
    description: input.description || "",
    workflowDefId: input.workflowDefId,
    sources: input.sources || [],
  };
  if (input.repoConfig) payload.repoConfig = input.repoConfig;
  if (input.modelOverride) payload.modelOverride = input.modelOverride;
  if (Array.isArray(input.connectors) && input.connectors.length) payload.connectors = input.connectors;
  return payload;
}

const FIRED = new Date("2026-08-17T09:00:00.000Z");

test("substitutes {date} in the title", () => {
  const p = buildPayload({ titleTemplate: "Weekly ad report {date}", workflowDefId: "wf" }, FIRED);
  assert.equal(p.title, "Weekly ad report 2026-08-17");
});

test("defaults description and sources", () => {
  const p = buildPayload({ titleTemplate: "x", workflowDefId: "wf" }, FIRED);
  assert.equal(p.description, "");
  assert.deepEqual(p.sources, []);
});

test("omits repoConfig and modelOverride when absent", () => {
  const p = buildPayload({ titleTemplate: "x", workflowDefId: "wf" }, FIRED);
  assert.ok(!("repoConfig" in p));
  assert.ok(!("modelOverride" in p));
});

test("passes repoConfig and modelOverride through when present", () => {
  const repoConfig = { repos: [{ url: "https://example.com/r.git", defaultBranch: "main" }] };
  const p = buildPayload(
    { titleTemplate: "x", workflowDefId: "wf", repoConfig, modelOverride: "opus", sources: [{ url: "u" }] },
    FIRED
  );
  assert.deepEqual(p.repoConfig, repoConfig);
  assert.equal(p.modelOverride, "opus");
  assert.deepEqual(p.sources, [{ url: "u" }]);
});

test("falls back to a default title when template missing", () => {
  const p = buildPayload({ workflowDefId: "wf" }, FIRED);
  assert.equal(p.title, "Scheduled routine");
});

test("passes connectors through when present, omits when empty", () => {
  const p = buildPayload({ titleTemplate: "x", workflowDefId: "wf", connectors: ["meta-ads"] }, FIRED);
  assert.deepEqual(p.connectors, ["meta-ads"]);
  const q = buildPayload({ titleTemplate: "x", workflowDefId: "wf", connectors: [] }, FIRED);
  assert.ok(!("connectors" in q));
});
