import { describe, it, expect } from "vitest";
import { isModuleFlagEnabled } from "./modules";

/**
 * TEAM-3739 (same defect class as TEAM-3723/TEAM-3738): the client-side nav gate
 * compared NEXT_PUBLIC_PIPELINE_ENABLED with strict === against "1"/"true", so
 * whitespace or casing variants silently hid the Pipeline tab even when the
 * server-side isPipelineEnabled() reported enabled:true.
 */

describe("isModuleFlagEnabled", () => {
  it('"1" -> true', () => {
    expect(isModuleFlagEnabled("1")).toBe(true);
  });

  it('"1 " -> true (trailing whitespace)', () => {
    expect(isModuleFlagEnabled("1 ")).toBe(true);
  });

  it('" true" -> true (leading whitespace)', () => {
    expect(isModuleFlagEnabled(" true")).toBe(true);
  });

  it('"TRUE" -> true (casing)', () => {
    expect(isModuleFlagEnabled("TRUE")).toBe(true);
  });

  it('"0" -> false', () => {
    expect(isModuleFlagEnabled("0")).toBe(false);
  });

  it("undefined -> false", () => {
    expect(isModuleFlagEnabled(undefined)).toBe(false);
  });

  it("no over-acceptance: yes/on/2/false/empty -> false", () => {
    expect(isModuleFlagEnabled("yes")).toBe(false);
    expect(isModuleFlagEnabled("on")).toBe(false);
    expect(isModuleFlagEnabled("2")).toBe(false);
    expect(isModuleFlagEnabled("false")).toBe(false);
    expect(isModuleFlagEnabled("")).toBe(false);
  });
});
