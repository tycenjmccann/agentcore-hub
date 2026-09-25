import { describe, it, expect } from "vitest";
import * as modelIdCanon from "./model-id";
import * as registry from "@/lib/models-registry";
import * as types from "@/components/models/types";
import { assignBareAliases, deriveBareAlias, isValidModelId, isDiscoverableModelId } from "./model-id";

// The example ids below are only ever used in this test file, which is exempt
// from scripts/check-model-surface.sh.

describe("isValidModelId", () => {
  it("accepts the real id shapes the catalog holds", () => {
    for (const id of [
      "us.anthropic.claude-fable-5-1",
      "openai.gpt-5.5",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.openai.gpt-5.6-terra",
    ]) {
      expect(isValidModelId(id), id).toBe(true);
    }
  });

  it("rejects ids that could not be a model (TEAM-4994 finding 9)", () => {
    for (const id of ["", "-leading-dash", "has space", "a", "slash/path", "semi;colon", 'quote"d', "x".repeat(129)]) {
      expect(isValidModelId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe("isDiscoverableModelId", () => {
  it("accepts what a sweep can actually list", () => {
    for (const id of ["us.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5", "openai.gpt-5.5"]) {
      expect(isDiscoverableModelId(id), id).toBe(true);
    }
  });

  it("rejects a bare CLI short name — it is an alias on a profile row, not a row of its own", () => {
    expect(isDiscoverableModelId("claude-opus-6")).toBe(false);
  });

  it("rejects a bare Anthropic foundation-model id — never returned by either listing", () => {
    expect(isDiscoverableModelId("anthropic.claude-opus-5")).toBe(false);
  });
});

describe("one definition, not two (TEAM-5011)", () => {
  it("models-registry.ts and components/models/types.ts re-export the same regex object", () => {
    expect(registry.MODEL_ID_RE).toBe(modelIdCanon.MODEL_ID_RE);
    expect(types.MODEL_ID_RE).toBe(modelIdCanon.MODEL_ID_RE);
  });

  it("and the same isValidModelId function", () => {
    expect(registry.isValidModelId).toBe(modelIdCanon.isValidModelId);
    expect(types.isValidModelId).toBe(modelIdCanon.isValidModelId);
  });
});

// TEAM-5065: the bare CLI alias a discovered us.anthropic.* row gets. The same
// table runs against the mjs twin in lambda/token-aggregator/models-registry.test.mjs.
describe("deriveBareAlias", () => {
  it("strips the us.anthropic. prefix, the version tail and a date stamp", () => {
    expect(deriveBareAlias("us.anthropic.claude-opus-6-v1:0")).toBe("claude-opus-6");
    expect(deriveBareAlias("us.anthropic.claude-opus-6")).toBe("claude-opus-6");
    expect(deriveBareAlias("us.anthropic.claude-opus-6-v1")).toBe("claude-opus-6");
    expect(deriveBareAlias("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5");
    expect(deriveBareAlias("us.anthropic.claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("derives nothing for any other prefix", () => {
    for (const id of [
      "global.anthropic.claude-opus-6",
      "eu.anthropic.claude-opus-6",
      "anthropic.claude-opus-6",
      "us.openai.gpt-6-sol",
      "openai.gpt-5.5",
      "claude-opus-6",
    ]) {
      expect(deriveBareAlias(id), id).toBeNull();
    }
  });

  it("derives nothing that is not a valid model id", () => {
    expect(deriveBareAlias("us.anthropic.")).toBeNull();
    expect(deriveBareAlias("us.anthropic.x")).toBeNull(); // 1 char: MODEL_ID_RE needs 2
  });

  it("agrees with every bare alias the seed was hand-written with", () => {
    for (const row of registry.BUNDLED_REGISTRY.catalog) {
      const bare = row.aliases.filter((a) => !a.includes("."));
      if (!row.modelId.startsWith("us.anthropic.") || bare.length === 0) continue;
      expect(bare, row.modelId).toContain(deriveBareAlias(row.modelId));
    }
  });
});

describe("assignBareAliases", () => {
  it("assigns an unambiguous, unclaimed alias", () => {
    const out = assignBareAliases(["us.anthropic.claude-opus-6-v1:0", "global.anthropic.claude-opus-6-v1:0"], new Set());
    expect([...out]).toEqual([["us.anthropic.claude-opus-6-v1:0", "claude-opus-6"]]);
  });

  it("gives an alias two candidates both derive to neither", () => {
    const out = assignBareAliases(["us.anthropic.claude-opus-6", "us.anthropic.claude-opus-6-v2:0"], new Set());
    expect(out.size).toBe(0);
  });

  it("never assigns a name already taken by an id, alias or legacyAliases key", () => {
    const taken = new Set(["claude-opus-6"]);
    expect(assignBareAliases(["us.anthropic.claude-opus-6"], taken).size).toBe(0);
  });

  it("never assigns a name that is another candidate's id", () => {
    const out = assignBareAliases(["us.anthropic.claude-opus-6", "claude-opus-6"], new Set());
    expect(out.size).toBe(0);
  });
});
