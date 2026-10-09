import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-5016 finding 6 — the routine save paths validate `input.modelOverride`
 * with the workflow front door's validator and answer with its 400 body.
 * ARTIFACT_BUCKET is unset BEFORE the module loads (it reads the bucket at import
 * time), so the registry is the bundled seed and no S3 client is ever built.
 */
describe("guardRoutineModelOverride", () => {
  let saved: string | undefined;
  let guardRoutineModelOverride: typeof import("./model-override").guardRoutineModelOverride;
  beforeEach(async () => {
    saved = process.env.ARTIFACT_BUCKET;
    delete process.env.ARTIFACT_BUCKET;
    vi.resetModules();
    ({ guardRoutineModelOverride } = await import("./model-override"));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ARTIFACT_BUCKET;
    else process.env.ARTIFACT_BUCKET = saved;
  });

  it("clears on absent, null and empty", async () => {
    for (const v of [undefined, null, "", "   "]) expect(await guardRoutineModelOverride(v)).toEqual({ ok: true });
  });

  it("stores the normalized catalog id for an alias, a tier word and an object override", async () => {
    expect(await guardRoutineModelOverride("claude-sonnet-5")).toEqual({ ok: true, modelOverride: "us.anthropic.claude-sonnet-5" });
    expect(await guardRoutineModelOverride("opus")).toEqual({ ok: true, modelOverride: "us.anthropic.claude-opus-5" });
    expect(await guardRoutineModelOverride({ bedrockModelConfig: { modelId: "opus" } })).toEqual({
      ok: true,
      modelOverride: "us.anthropic.claude-opus-5",
    });
  });

  it("refuses with the front door's 400 body, reason included", async () => {
    const cases: Array<[unknown, string]> = [
      ["clade-opus-5", "unknown_model"],
      ["us.anthropic.claude-nonesuch-9", "not_in_catalog"],
      ["us.anthropic.claude-opus-4-8", "inactive"],
      ["anthropic.claude-opus-5", "read_only"],
      [{ openAiModelConfig: { modelId: "gpt-5.5" } }, "unsupported_shape"],
    ];
    for (const [value, reason] of cases) {
      const guard = await guardRoutineModelOverride(value);
      expect(guard.ok).toBe(false);
      if (guard.ok) continue;
      expect(guard.response.status).toBe(400);
      expect(await guard.response.json()).toEqual({ error: "invalid_model_override", reason, modelOverride: value });
    }
  });
});
