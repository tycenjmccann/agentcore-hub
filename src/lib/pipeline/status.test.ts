import { describe, it, expect } from "vitest";
import { isPipelineEnabled } from "./status";

/**
 * TEAM-3723: PIPELINE_ENABLED was compared with strict `===` against "1" / "true",
 * so accidental whitespace or casing silently disabled the pipeline flag.
 */

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

  it("unset/undefined -> false", () => {
    expect(isPipelineEnabled(undefined)).toBe(false);
  });
});
