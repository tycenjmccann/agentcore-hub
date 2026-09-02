import { describe, it, expect, afterEach, vi } from "vitest";
import { isPipelineEnabled } from "./status";

/**
 * TEAM-3723: PIPELINE_ENABLED was compared with strict `===` against "1" / "true",
 * so accidental whitespace or casing silently disabled the pipeline flag.
 *
 * TEAM-3745: isPipelineEnabled()'s default parameter reads process.env.PIPELINE_ENABLED,
 * so calling isPipelineEnabled(undefined) still falls through to the live env — it does
 * NOT exercise the unset case. Stub the env so the unset case is hermetic regardless of
 * what the surrounding shell/CI has set.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isPipelineEnabled", () => {
  it('"1" -> true', () => {
    expect(isPipelineEnabled("1")).toBe(true);
  });

  it('"1 " -> true (trailing whitespace)', () => {
    expect(isPipelineEnabled("1 ")).toBe(true);
  });

  it('" true" -> true (leading whitespace)', () => {
    expect(isPipelineEnabled(" true")).toBe(true);
  });

  it('"TRUE" -> true (casing)', () => {
    expect(isPipelineEnabled("TRUE")).toBe(true);
  });

  it('"0" -> false', () => {
    expect(isPipelineEnabled("0")).toBe(false);
  });

  it("unset -> false (env stubbed absent, default param genuinely reads nothing)", () => {
    vi.stubEnv("PIPELINE_ENABLED", undefined);
    expect(isPipelineEnabled()).toBe(false);
  });

  it("default param reads live env: stubbed PIPELINE_ENABLED=true -> true", () => {
    vi.stubEnv("PIPELINE_ENABLED", "true");
    expect(isPipelineEnabled()).toBe(true);
  });
});
