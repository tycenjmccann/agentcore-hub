import { describe, it, expect } from "vitest";
import { normalizeRepoKey, parseCdRegistry, findCdEntry, deliveryModeFor, upsertCdEntry, removeCdEntry } from "./cd-registry";

/** App-side mirror of lambda/orchestrator/cd-registry.mjs — same matching rules. */
describe("cd-registry (app)", () => {
  const reg = parseCdRegistry({ version: 1, repos: [{ repo: "Acme/Hub", pipeline: "hub-deploy", region: "us-east-1" }] });

  it("normalizes every GitHub ref form to lower-case owner/repo", () => {
    expect(normalizeRepoKey("https://github.com/Acme/Hub.git")).toBe("acme/hub");
    expect(normalizeRepoKey("git@github.com:Acme/Hub.git")).toBe("acme/hub");
    expect(normalizeRepoKey("acme/hub")).toBe("acme/hub");
    expect(normalizeRepoKey("hub")).toBeNull();
    expect(normalizeRepoKey("")).toBeNull();
  });

  it("parses tolerantly and matches by URL", () => {
    expect(reg.repos).toEqual([{ repo: "acme/hub", pipeline: "hub-deploy", region: "us-east-1" }]);
    expect(findCdEntry(reg, "https://github.com/ACME/hub")?.pipeline).toBe("hub-deploy");
    expect(deliveryModeFor(reg, "https://github.com/acme/hub")).toBe("cd");
    expect(deliveryModeFor(reg, "https://github.com/acme/other")).toBe("handoff");
    expect(deliveryModeFor(reg, "")).toBe("handoff");
    expect(parseCdRegistry("garbage").repos).toEqual([]);
  });

  it("upsert normalizes, merges, clears blank fields and keeps addedAt; remove drops by key", () => {
    const added = upsertCdEntry(reg, { repo: "https://github.com/Acme/Juno.git", pipeline: "juno-deploy", notes: "n" });
    expect(added.repos.map((e) => e.repo)).toEqual(["acme/hub", "acme/juno"]);
    const juno = added.repos.find((e) => e.repo === "acme/juno")!;
    expect(juno.pipeline).toBe("juno-deploy");
    expect(juno.addedAt).toBeTruthy();

    const cleared = upsertCdEntry(added, { repo: "acme/juno", pipeline: "" });
    const juno2 = cleared.repos.find((e) => e.repo === "acme/juno")!;
    expect(juno2.pipeline).toBeUndefined();
    expect(juno2.notes).toBe("n");
    expect(juno2.addedAt).toBe(juno.addedAt);

    expect(removeCdEntry(cleared, "ACME/JUNO").repos.map((e) => e.repo)).toEqual(["acme/hub"]);
    expect(() => upsertCdEntry(reg, { repo: "nope" })).toThrow(/owner\/repo/);
  });
});
