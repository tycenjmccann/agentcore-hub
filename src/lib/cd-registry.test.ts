import { describe, it, expect } from "vitest";
import { normalizeRepoKey, parseCdRegistry, findCdEntry, deliveryModeFor, upsertCdEntry, removeCdEntry, pipelineProjectsFor } from "./cd-registry";

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

/**
 * TEAM-4336 — the multi-CD naming convention as CODE. Every surface that names a
 * repo's CI/build/deploy resources (the tools Lambda, the Telegram deploy-gate
 * bridge, /pipeline, the board's deploy-gate banner) derives them from the ONE
 * `pipeline` field, so a repo can be onboarded by naming its pipeline alone. TS
 * mirror of pipelineProjects() in lambda/orchestrator/cd-registry.mjs.
 */
describe("pipelineProjectsFor (app mirror of pipelineProjects)", () => {
  const DEFAULT_REGION = process.env.AWS_REGION || "us-east-1";

  it("the hub's own pipeline derives the hub's own projects", () => {
    // agentcore-hub-* is NOT renamed to hub-*: the convention strips "-deploy"
    // from whatever the entry names, so the hub keeps its historical resources.
    expect(pipelineProjectsFor({ repo: "a/b", pipeline: "agentcore-hub-deploy" })).toEqual({
      pipeline: "agentcore-hub-deploy",
      region: DEFAULT_REGION,
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployProject: "agentcore-hub-deploy",
    });
  });

  it("a hub-<slug>-deploy pipeline derives hub-<slug>-ci / -build / -deploy", () => {
    const p = pipelineProjectsFor({ repo: "acme/juno", pipeline: "hub-juno-deploy", region: "eu-west-1" })!;
    expect(p.ciProject).toBe("hub-juno-ci");
    expect(p.buildProject).toBe("hub-juno-build");
    expect(p.deployProject).toBe("hub-juno-deploy");
    expect(p.region).toBe("eu-west-1");
  });

  it("a pipeline NOT ending in -deploy is its own base (no suffix invented away)", () => {
    const p = pipelineProjectsFor({ repo: "acme/juno", pipeline: "juno" })!;
    expect(p.ciProject).toBe("juno-ci");
    expect(p.buildProject).toBe("juno-build");
    expect(p.deployProject).toBe("juno");
  });

  it("an explicit ciProject wins over the derived name; buildProject stays derived", () => {
    // A repo whose PR-check project predates the convention must still work.
    const p = pipelineProjectsFor({ repo: "acme/juno", pipeline: "hub-juno-deploy", ciProject: "juno-pr-checks" })!;
    expect(p.ciProject).toBe("juno-pr-checks");
    expect(p.buildProject).toBe("hub-juno-build");
  });

  it("region falls back to the module default when the entry omits it", () => {
    // A definite string either way — every caller hands it to an AWS client.
    expect(pipelineProjectsFor({ repo: "acme/juno", pipeline: "hub-juno-deploy" })!.region).toBe(DEFAULT_REGION);
  });

  it("no pipeline → null (registered, but the legacy DEPLOY.md path)", () => {
    expect(pipelineProjectsFor({ repo: "acme/juno" })).toBeNull();
    expect(pipelineProjectsFor({ repo: "acme/juno", pipeline: "   " })).toBeNull();
    expect(pipelineProjectsFor({ repo: "acme/juno", deployDoc: "DEPLOY.md" })).toBeNull();
  });
});
