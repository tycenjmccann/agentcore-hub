import { describe, it, expect } from "vitest";
import * as modelIdCanon from "./model-id";
import * as registry from "@/lib/models-registry";
import * as types from "@/components/models/types";
import { isValidModelId, isDiscoverableModelId } from "./model-id";

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
