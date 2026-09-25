import { describe, it, expect } from "vitest";
import { registryFallbackBanner } from "./fallback-banner";
import type { RegistryDoc } from "./types";

/** TEAM-5052 — the page must say when it is not showing the live registry. */

const doc = (version: number) => ({ version }) as unknown as RegistryDoc;

describe("registryFallbackBanner", () => {
  it("returns null for the live document", () => {
    expect(registryFallbackBanner({ registry: doc(7), source: "s3", fallback: null })).toBeNull();
    // An older server that does not send `source` is not a fallback either.
    expect(registryFallbackBanner({ registry: doc(7) })).toBeNull();
  });

  it("returns null for a healthy warm-cache hit — 'cache' alone is not a fallback (TEAM-5074)", () => {
    // A non-forced GET after a healthy read reports source:"cache" with no
    // fallback (the TTL hit). The banner keys on `fallback`, not `source`.
    expect(registryFallbackBanner({ registry: doc(7), source: "cache", fallback: null })).toBeNull();
    expect(registryFallbackBanner({ registry: doc(7), source: "seed", fallback: null })).toBeNull();
  });

  it("names the refused version and reason for a seed fallback", () => {
    const text = registryFallbackBanner({
      registry: doc(1),
      source: "seed",
      fallback: {
        reason: "invalid",
        detail: "catalog.us.anthropic.claude-opus-4-6.aliases.us.anthropic.claude-opus-4-6-v1=duplicate_alias",
        refusedVersion: 2,
      },
    });
    expect(text).toContain("the bundled seed (version 1)");
    expect(text).toContain("live version 2 was refused");
    expect(text).toContain("duplicate_alias");
    expect(text).toContain("Saving a valid registry here replaces it.");
  });

  it("says last good copy for a cache fallback", () => {
    const text = registryFallbackBanner({
      registry: doc(9),
      source: "cache",
      fallback: { reason: "error", detail: "SlowDown" },
    });
    expect(text).toContain("the last good copy (version 9)");
    expect(text).toContain("could not be read (SlowDown)");
    expect(text).not.toContain("Saving a valid registry");
  });
});
