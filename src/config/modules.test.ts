import { describe, it, expect } from "vitest";
import { isModuleFlagEnabled, NAV_ITEMS, type NavItem } from "./modules";

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

/**
 * TEAM-4688: the Workflow board deep-links to the Evaluations drilldown with a
 * plain URL string (no cross-module import), gated ONLY on this registry:
 *
 *   NAV_ITEMS.some((i) => i.module === "evaluations")
 *
 * That is a module-scope constant in a client bundle, so no page-level test can
 * mock it away. This asserts the predicate directly: true against the shipped
 * registry, false the moment the `evaluations` entry is removed — which is the
 * one edit that removing the module makes here (see docs/MODULES.md).
 */
describe("optional-module presence gate (cross-module links)", () => {
  const present = (items: NavItem[]) => items.some((i) => i.module === "evaluations");

  it("is true while the shipped registry carries an evaluations entry", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/evaluations")).toBe(true);
    expect(present(NAV_ITEMS)).toBe(true);
  });

  it("is false once the evaluations entry is removed from the registry", () => {
    const withoutEvaluations = NAV_ITEMS.filter((i) => i.module !== "evaluations");
    expect(present(withoutEvaluations)).toBe(false);
    // Removing one module must not disturb the others.
    expect(withoutEvaluations.some((i) => i.module === "core")).toBe(true);
    expect(withoutEvaluations.some((i) => i.module === "workflow")).toBe(true);
  });
});
