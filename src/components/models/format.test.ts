import { describe, it, expect } from "vitest";
import { invalidFieldAction, invalidFieldMessage, probeModeLabel, rate, rateQuad } from "./format";
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

// ─── invalidFieldMessage / invalidFieldAction ───────────────────────────────

describe("the unprobed rejection (TEAM-5038)", () => {
  const LUNA = "us.openai.gpt-6-luna";

  // The defect: the tier guard told operators a model "has not passed both probes"
  // and to "run the api and cli probes in the catalog" — implementer vocabulary,
  // no pointer to the control that fixes it.
  it("tells an operator what to do, in their vocabulary", () => {
    const msg = invalidFieldMessage("unprobed", LUNA);
    expect(msg).not.toMatch(/probe/i);
    expect(msg).toMatch(/Test menu/);
    expect(msg).toMatch(/Catalog/);
    expect(msg).toContain(LUNA);
  });

  it("points the unprobed rejection at the row that can fix it", () => {
    expect(invalidFieldAction("unprobed", LUNA)).toEqual({
      label: "Open its Catalog row",
      targetId: `catalog-row-${LUNA}`,
      focusTestId: `catalog-test-${LUNA}`,
    });
  });

  it("offers no action for a reason with no single destination", () => {
    expect(invalidFieldAction("unpriced", LUNA)).toBeNull();
    expect(invalidFieldAction(undefined, LUNA)).toBeNull();
    expect(invalidFieldAction("unprobed", "")).toBeNull();
  });

  // Hermetic twin of tests/tab-models.spec.ts test 16, which pins this sentence
  // verbatim but runs in no CI job.
  it("leaves the other reasons' copy untouched", () => {
    expect(invalidFieldMessage("unpriced", LUNA)).toBe(
      `${LUNA} has no published or manual price. Set a price in the catalog, then save again.`,
    );
  });

  it("names the Test menu items without the word probe", () => {
    expect(probeModeLabel("api")).toBe("API smoke test");
    expect(probeModeLabel("cli")).toBe("CLI smoke test");
  });
});
