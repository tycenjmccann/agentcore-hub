import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import seed from "@/config/models.json";
import type { ModelsRegistry } from "@/lib/models-registry";
import { validateModelOverride } from "./validate-model-override";

/**
 * TEAM-5008 finding 7. The gate's job is narrow: accept exactly what the console
 * and the Routines module actually send, resolve it to the id that will really be
 * invoked, and refuse everything else by NAME so the 400 tells the caller what to
 * fix. Anything accepted here becomes the model every dev agent on the run uses.
 */

function reg(mutate: (r: ModelsRegistry) => void = () => {}): ModelsRegistry {
  const doc = JSON.parse(JSON.stringify(seed)) as ModelsRegistry;
  mutate(doc);
  return doc;
}

beforeEach(() => {
  // resolveModel logs every rejection; the refusal tests are all rejections.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateModelOverride — the string form", () => {
  it("accepts a catalog id, a row alias, a legacy alias and a Claude tier word", () => {
    const r = reg();
    expect(validateModelOverride(r, "us.anthropic.claude-opus-5")).toEqual({
      ok: true,
      override: "us.anthropic.claude-opus-5",
      modelId: "us.anthropic.claude-opus-5",
    });
    // An alias and a legacyAliases key both normalise to the canonical id, so the
    // run records what runs rather than what was typed.
    expect(validateModelOverride(r, "claude-sonnet-5")).toMatchObject({
      ok: true,
      modelId: "us.anthropic.claude-sonnet-5",
    });
    expect(validateModelOverride(r, "claude-opus-47")).toMatchObject({
      ok: true,
      modelId: "us.anthropic.claude-opus-5",
    });
    // DD3: no `cli` means tiers.claude, which is how the persona chain resolves
    // an override — so "opus" is a legal override here, not a typo.
    expect(validateModelOverride(r, "opus")).toMatchObject({
      ok: true,
      modelId: "us.anthropic.claude-opus-5",
    });
    // Surrounding whitespace is a transport artefact, not a different model.
    expect(validateModelOverride(r, "  claude-sonnet-5  ")).toMatchObject({
      ok: true,
      modelId: "us.anthropic.claude-sonnet-5",
    });
  });

  it("treats an absent or blank override as no override at all", () => {
    const r = reg();
    for (const value of [undefined, null, "", "   "]) {
      expect(validateModelOverride(r, value)).toEqual({ ok: true, override: undefined, modelId: "" });
    }
  });

  it("refuses a typo, and an unknown dotted id — there is no passthrough at the front door", () => {
    const r = reg();
    expect(validateModelOverride(r, "clade-opus-5")).toEqual({ ok: false, reason: "unknown_model" });
    // The dangerous one: a well-formed id nobody catalogued used to resolve as
    // `passthrough` and be invoked unpriced and unprobed.
    expect(validateModelOverride(r, "us.anthropic.claude-nonesuch-9")).toEqual({
      ok: false,
      reason: "not_in_catalog",
    });
  });

  it("refuses a retired, quarantined, candidate, unpriced or read-only row, naming which", () => {
    expect(validateModelOverride(reg(), "us.anthropic.claude-opus-4-8")).toEqual({
      ok: false,
      reason: "inactive",
    });
    // Both spellings of quarantine: the document-wide list and the row's status.
    expect(
      validateModelOverride(
        reg((r) => {
          r.quarantine = ["us.anthropic.claude-opus-5"];
        }),
        "us.anthropic.claude-opus-5"
      )
    ).toEqual({ ok: false, reason: "quarantined" });
    expect(
      validateModelOverride(
        reg((r) => {
          r.catalog.find((row) => row.modelId === "us.anthropic.claude-opus-5")!.status = "quarantined";
        }),
        "us.anthropic.claude-opus-5"
      )
    ).toEqual({ ok: false, reason: "quarantined" });
    // A candidate is a model nobody has proven yet — not something to point a
    // whole run at, however green its probes are.
    expect(
      validateModelOverride(
        reg((r) => {
          r.catalog.find((row) => row.modelId === "us.anthropic.claude-opus-5")!.status = "candidate";
        }),
        "us.anthropic.claude-opus-5"
      )
    ).toEqual({ ok: false, reason: "inactive" });
    // Unpriced would bill at the pricing default and make the run's cost a guess.
    expect(
      validateModelOverride(
        reg((r) => {
          delete r.catalog.find((row) => row.modelId === "us.anthropic.claude-opus-5")!.price;
        }),
        "us.anthropic.claude-opus-5"
      )
    ).toEqual({ ok: false, reason: "unpriced" });
    // readOnly rows exist for cost attribution only (the eval judge's row).
    expect(validateModelOverride(reg(), "anthropic.claude-opus-5")).toEqual({
      ok: false,
      reason: "read_only",
    });
  });
});

describe("validateModelOverride — the object form", () => {
  it("accepts a sole bedrockModelConfig and normalises its modelId", () => {
    expect(validateModelOverride(reg(), { bedrockModelConfig: { modelId: "claude-sonnet-5" } })).toEqual({
      ok: true,
      override: { bedrockModelConfig: { modelId: "us.anthropic.claude-sonnet-5" } },
      modelId: "us.anthropic.claude-sonnet-5",
    });
  });

  it("applies the same row rules inside the object as to a bare string", () => {
    expect(validateModelOverride(reg(), { bedrockModelConfig: { modelId: "us.anthropic.claude-opus-4-8" } })).toEqual({
      ok: false,
      reason: "inactive",
    });
    expect(validateModelOverride(reg(), { bedrockModelConfig: { modelId: "" } })).toEqual({
      ok: false,
      reason: "unknown_model",
    });
  });

  it("refuses every other shape", () => {
    const r = reg();
    const rejected: unknown[] = [
      // openAiModelConfig is a promise the orchestrator never keeps: only
      // bedrockModelConfig is read (lambda/orchestrator/agent-invoker.mjs).
      { openAiModelConfig: { modelId: "gpt-4-turbo-preview", apiKeyArn: "arn:aws:secretsmanager:us-east-1:1:secret:k" } },
      // An extra key means the caller believes something untrue about this route.
      { bedrockModelConfig: { modelId: "us.anthropic.claude-opus-5" }, openAiModelConfig: { modelId: "x" } },
      { bedrockModelConfig: { modelId: "us.anthropic.claude-opus-5", apiKeyArn: "arn:aws:secretsmanager:us-east-1:1:secret:k" } },
      { bedrockModelConfig: { modelId: ["us.anthropic.claude-opus-5"] } },
      { bedrockModelConfig: "us.anthropic.claude-opus-5" },
      { bedrockModelConfig: {} },
      { modelId: "us.anthropic.claude-opus-5" },
      {},
      ["us.anthropic.claude-opus-5"],
      42,
      true,
    ];
    for (const value of rejected) {
      expect(validateModelOverride(r, value), JSON.stringify(value)).toEqual({
        ok: false,
        reason: "unsupported_shape",
      });
    }
  });
});
