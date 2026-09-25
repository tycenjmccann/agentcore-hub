import { describe, it, expect } from "vitest";
import { harnessDrift, invalidFieldMessage, parseAliasInput, rate, rateQuad } from "./format";
import type { Price } from "./types";

function price(over: Partial<Price> = {}): Price {
  return { input: 1.1, output: 5.5, cacheReadInput: 0.11, cacheWrite: 1.375, source: "published", asOf: "2026-09-01", ...over };
}

// ─── rate ───────────────────────────────────────────────────────────────────

describe("rate", () => {
  // The defect this pins (TEAM-5024 F3a): the old `< 1` magnitude gate rounded the
  // seed's own cache-write rates (haiku 1.375, opus 6.875) to cents, so the page
  // showed a number the account would never be billed.
  it("keeps a third decimal above $1, not just below it", () => {
    expect(rate(1.375)).toBe("$1.375");
    expect(rate(6.875)).toBe("$6.875");
  });

  it("keeps a third decimal below $1", () => {
    expect(rate(0.022)).toBe("$0.022");
    expect(rate(0.275)).toBe("$0.275");
  });

  it("pads to cents when there is no third decimal, at any magnitude", () => {
    expect(rate(4.4)).toBe("$4.40");
    expect(rate(22)).toBe("$22.00");
  });

  it("answers - for a rate that is not a number", () => {
    expect(rate(null)).toBe("-");
    expect(rate(undefined)).toBe("-");
    expect(rate(NaN)).toBe("-");
  });
});

// ─── rateQuad ───────────────────────────────────────────────────────────────

describe("rateQuad", () => {
  // The TEAM-4992 AC9 literal, which is the haiku row.
  it("renders the haiku price as the design specifies", () => {
    expect(rateQuad(price())).toBe("$1.10 / $5.50 / $0.11 / $1.375 per 1M");
  });

  it("says so rather than printing zeros when there is no price", () => {
    expect(rateQuad(undefined)).toBe("no price on record");
  });
});

// ─── harnessDrift ─────────────────────────────────────────────────────────────

// TEAM-5067: the one drift comparison every harness row uses (including
// personal_assistant_agent, which used to short-circuit past it entirely).
describe("harnessDrift", () => {
  it("names the live model when it differs from the registry", () => {
    expect(harnessDrift({ modelId: "us.anthropic.claude-opus-5-5", harnessModel: "global.anthropic.claude-sonnet-4-5-20250929-v1:0" })).toBe(
      "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
  });

  it("is undefined when the harness agrees with the registry", () => {
    expect(harnessDrift({ modelId: "us.anthropic.claude-opus-5-5", harnessModel: "us.anthropic.claude-opus-5-5" })).toBeUndefined();
  });

  it("is undefined when harnessModel is missing or null", () => {
    expect(harnessDrift({ modelId: "us.anthropic.claude-opus-5-5" })).toBeUndefined();
    expect(harnessDrift({ modelId: "us.anthropic.claude-opus-5-5", harnessModel: null })).toBeUndefined();
  });

  it("is undefined when modelId or the whole resolved entry is missing", () => {
    expect(harnessDrift({ harnessModel: "us.anthropic.claude-sonnet-5" })).toBeUndefined();
    expect(harnessDrift(undefined)).toBeUndefined();
  });
});

// ─── alias editor (TEAM-5065) ───────────────────────────────────────────────

describe("parseAliasInput", () => {
  const ID = "us.anthropic.claude-opus-6";

  it("trims, drops empties and de-duplicates in order", () => {
    expect(parseAliasInput(" claude-opus-6, ,opus-6,claude-opus-6 ", ID)).toEqual({ aliases: ["claude-opus-6", "opus-6"] });
    expect(parseAliasInput("   ", ID)).toEqual({ aliases: [] });
  });

  it("refuses a malformed alias with the bad_model_id copy", () => {
    expect(parseAliasInput("claude-opus-6, a b", ID)).toEqual({ error: invalidFieldMessage("bad_model_id", "a b") });
  });

  it("refuses the row's own id", () => {
    expect(parseAliasInput(ID, ID)).toMatchObject({ error: expect.stringContaining("own id") });
  });
});

describe("invalidFieldMessage", () => {
  it("names the alias and the fix for bad_model_id", () => {
    expect(invalidFieldMessage("bad_model_id", "a;b")).toMatch(/^a;b is not a valid model name/);
  });
});
