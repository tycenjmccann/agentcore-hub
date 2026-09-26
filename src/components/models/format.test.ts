import { describe, it, expect } from "vitest";
import { harnessDrift, invalidFieldMessage, invalidFieldUi, probeModeLabel, rate, rateQuad } from "./format";
import type { CatalogRow, InvalidReason, Price } from "./types";

function price(over: Partial<Price> = {}): Price {
  return { input: 1.1, output: 5.5, cacheReadInput: 0.11, cacheWrite: 1.375, source: "published", asOf: "2026-09-01", ...over };
}

function row(over: Partial<CatalogRow> & { modelId: string }): CatalogRow {
  return {
    label: over.modelId,
    vendor: "openai",
    family: "gpt-6",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 200_000,
    aliases: [],
    status: "active",
    price: price(),
    ...over,
  };
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

// ─── invalidFieldMessage / invalidFieldUi ──────────────────────────────────

describe("the unprobed rejection (TEAM-5038)", () => {
  const LUNA = "us.openai.gpt-6-luna";
  const CATALOG = [row({ modelId: LUNA })];

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

  const ROW_ACTION = {
    label: "Open its Catalog row",
    targetId: `catalog-row-${LUNA}`,
    focusTestId: `catalog-test-${LUNA}`,
  };
  const CATALOG_ACTION = { label: "Open the Catalog", targetId: "catalog-section", focusTestId: "catalog-refresh" };

  it("points the unprobed rejection at the row that can fix it", () => {
    const ui = invalidFieldUi("unprobed", LUNA, CATALOG);
    expect(ui.message).toBe(invalidFieldMessage("unprobed", LUNA));
    expect(ui.action).toEqual(ROW_ACTION);
  });

  it("offers no action for a reason with no single destination", () => {
    expect(invalidFieldUi("unpriced", LUNA, CATALOG)).toEqual({ message: invalidFieldMessage("unpriced", LUNA), action: null });
    expect(invalidFieldUi("read_only", LUNA, CATALOG).action).toBeNull();
  });

  // TEAM-5077 finding 2: the sentence and the button used to be built separately
  // (message at 422 time, action at render), so the sentence could point at "the
  // Test menu on its Catalog row" while no button rendered. Both now come out of
  // ONE resolution, so they cannot disagree.
  describe("message and action come from one resolution (TEAM-5077)", () => {
    it("resolves an alias to its row's real id, not the alias text", () => {
      const alias = row({ modelId: LUNA, aliases: ["luna"] });
      const ui = invalidFieldUi("unprobed", "luna", [alias]);
      expect(ui.action).toEqual(ROW_ACTION);
      expect(ui.message).toContain("luna");
      expect(ui.message).toMatch(/on its Catalog row/);
    });

    // The server decides unknown_model / read_only / retired BEFORE unprobed
    // (models-registry.ts targetReason) and only says unprobed about a candidate,
    // so an unprobed subject with no live row HERE means this page's catalog is
    // stale. The honest destination is the Catalog's Refresh, for all three alike.
    const STALE: Array<[string, string, CatalogRow[]]> = [
      ["a retired row (CatalogTable collapses it)", LUNA, [row({ modelId: LUNA, status: "retired" })]],
      ["a read-only judge row (CatalogTable never renders it)", LUNA, [row({ modelId: LUNA, readOnly: true })]],
      ["an id the catalog has never heard of", "us.openai.gpt-6-ghost", CATALOG],
      ["a subject that is the path itself (nothing at that path in the draft)", "tiers.codex.luna", CATALOG],
    ];
    for (const [name, subject, catalog] of STALE) {
      it(`sends ${name} to the Catalog's Refresh, and says so`, () => {
        const ui = invalidFieldUi("unprobed", subject, catalog);
        expect(ui.action).toEqual(CATALOG_ACTION);
        expect(ui.message).toContain(subject);
        expect(ui.message).toMatch(/Refresh catalog/);
        expect(ui.message).not.toMatch(/on its Catalog row/);
        expect(ui.message).not.toMatch(/probe/i);
      });
    }

    it("mentions the Test menu exactly when it renders an action", () => {
      const REASONS: InvalidReason[] = ["unpriced", "inactive", "quarantined", "unprobed", "read_only", "duplicate_alias"];
      const CASES: Array<[string, CatalogRow[]]> = [
        [LUNA, CATALOG],
        [LUNA, [row({ modelId: LUNA, status: "retired" })]],
        ["us.openai.gpt-6-ghost", CATALOG],
      ];
      for (const reason of REASONS) {
        for (const [subject, catalog] of CASES) {
          const ui = invalidFieldUi(reason, subject, catalog);
          expect(ui.message.includes("Test menu"), `${reason} / ${subject}`).toBe(ui.action !== null);
          if (ui.message.includes("on its Catalog row")) expect(ui.action?.targetId).toMatch(/^catalog-row-/);
        }
      }
    });

    it("counts the rows claiming a duplicate alias from the catalog, never below 2", () => {
      const two = [row({ modelId: LUNA, aliases: ["luna"] }), row({ modelId: "us.openai.gpt-6-sol", aliases: ["luna"] })];
      expect(invalidFieldUi("duplicate_alias", "luna", two).message).toContain("claimed by 2 catalog rows");
      expect(invalidFieldUi("duplicate_alias", "luna", [...two, row({ modelId: "us.openai.gpt-6-astra", aliases: ["luna"] })]).message).toContain(
        "claimed by 3 catalog rows",
      );
      expect(invalidFieldUi("duplicate_alias", "luna", []).message).toContain("claimed by 2 catalog rows");
    });
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
