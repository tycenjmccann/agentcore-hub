import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TEAM-4995 / DL-033 + DL-009: the orchestrator may not resolve a model.
 *
 * It used to carry a `modelMap` — its own tier → model-id table, a third copy of
 * the same knowledge the fleet runtime held twice — so `modelOverride: "opus"`
 * meant one model when the orchestrator dispatched and another when the runtime
 * resolved locally, with nothing reporting the disagreement. The orchestrator is
 * an event router (DL-009): it forwards the override VERBATIM and whoever calls
 * Bedrock resolves it through config/models.json.
 *
 * This is a text assertion on purpose. Importing index.mjs pulls the whole
 * Lambda (and its AWS clients) into the test process; what needs pinning is a
 * property of the source, not of a function: that no map grew back, that the
 * wrap happens exactly once, and that the file did not grow past its budget.
 */

const ROOT = join(__dirname, "..", "..", "..");
const ORCH = "lambda/orchestrator/index.mjs";
const INDEX_BUDGET = 5175; // ORCH_INDEX_BUDGET in scripts/check-orchestrator-surface.sh (DL-034)

describe("orchestrator forwards a model override verbatim (DL-033)", () => {
  const src = readFileSync(join(ROOT, ORCH), "utf8");

  it("has no modelMap", () => {
    expect(src).not.toMatch(/modelMap/);
  });

  it("wraps a bare string override as bedrockModelConfig.modelId exactly once", () => {
    // Once: a second wrap site is a second policy. The shape is the AgentCore
    // InvokeAgentRuntime model config — unresolved tier name included, because
    // resolution is the runtime's job.
    const matches = src.match(/bedrockModelConfig:\s*\{\s*modelId:\s*override\s*\}/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("names no Claude model id", () => {
    // The two the deleted map held, plus the generation that replaced them.
    expect(src).not.toMatch(/claude-opus-4/);
    expect(src).not.toMatch(/claude-sonnet-4/);
    expect(src).not.toMatch(/anthropic\.claude-/);
  });

  it(`stays inside the ${INDEX_BUDGET}-line surface budget`, () => {
    // Mirrors the CI guard so the budget is visible where the file is edited.
    const lines = src.split("\n").length;
    expect(lines, `${ORCH} is ${lines} lines`).toBeLessThanOrEqual(INDEX_BUDGET);
  });
});
