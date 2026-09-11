import { describe, it, expect } from "vitest";
import { normalizeRepoKey, parseCdRegistry, findCdEntry, deliveryModeFor, upsertCdEntry, removeCdEntry, pipelineProjectsFor, resolveRegistryTtlMs, validateCdEntryInput } from "./cd-registry";

/** App-side mirror of lambda/orchestrator/cd-registry.mjs — same matching rules. */
describe("cd-registry (app)", () => {
  const reg = parseCdRegistry({ version: 1, repos: [{ repo: "Acme/Hub", pipeline: "hub-deploy", region: "us-east-1" }] });

  it("normalizes every GitHub ref form to lower-case owner/repo", () => {
    expect(normalizeRepoKey("https://github.com/Acme/Hub.git")).toBe("acme/hub");
    expect(normalizeRepoKey("git@github.com:Acme/Hub.git")).toBe("acme/hub");
    expect(normalizeRepoKey("acme/hub")).toBe("acme/hub");
    expect(normalizeRepoKey("hub")).toBeNull();
    expect(normalizeRepoKey("")).toBeNull();
    // TEAM-4421/TEAM-4426: trailing slash AFTER .git must not survive the strip.
    expect(normalizeRepoKey("https://github.com/owner/repo.git/")).toBe("owner/repo");
    expect(normalizeRepoKey("git@github.com:owner/repo.git/")).toBe("owner/repo");
    // TEAM-4441 (ship-review F1 on #529): the mirror-image slash-BEFORE-.git
    // form must survive too — the TEAM-4421 reorder alone regressed this.
    expect(normalizeRepoKey("https://github.com/owner/repo/.git")).toBe("owner/repo");
    expect(normalizeRepoKey("owner/repo/.git")).toBe("owner/repo");
    expect(normalizeRepoKey("https://github.com/owner/repo/.git/")).toBe("owner/repo");
    expect(normalizeRepoKey("https://github.com/Owner/Repo/.git")).toBe("owner/repo");
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

/**
 * TEAM-4350 — one TTL contract across all four readers of config/cd-registry.json.
 * Asserts the LITERAL 60000, not a constant imported from the module, so the test
 * pins the requirement rather than whatever the implementation currently says.
 */
describe("resolveRegistryTtlMs (registry cache window)", () => {
  it("defaults to the 60s window the orchestrator, tools Lambda and bridge use", () => {
    // Explicit env objects: immune to a CD_REGISTRY_TTL_MS set in the ambient shell.
    expect(resolveRegistryTtlMs({})).toBe(60_000);
    expect(resolveRegistryTtlMs({ CD_REGISTRY_TTL_MS: undefined })).toBe(60_000);
  });

  it("an explicit override wins, and a useless value falls back to 60s", () => {
    expect(resolveRegistryTtlMs({ CD_REGISTRY_TTL_MS: "5000" })).toBe(5_000);
    expect(resolveRegistryTtlMs({ CD_REGISTRY_TTL_MS: "1" })).toBe(1); // the Lambda tests' TTL=1 trick
    // 0/negative would mean an S3 GET per request; Infinity would pin a stale
    // registry for the life of the process; the rest are operator typos.
    for (const bad of ["", "   ", "0", "-1", "-60000", "abc", "Infinity", "NaN"]) {
      expect(resolveRegistryTtlMs({ CD_REGISTRY_TTL_MS: bad })).toBe(60_000);
    }
  });
});

/**
 * TEAM-4416 — shape validation on POST /api/workflow/cd-registry, at the edge
 * rather than as a later opaque AWS error inside a Lambda (docs/agents-own-cd.md
 * "runtime allow-list"). One case per rule; blank optional fields keep meaning
 * "clear it" (upsertCdEntry's semantics), so they must NOT be rejected.
 */
describe("validateCdEntryInput", () => {
  it("repo: normalizes valid forms, rejects the rest", () => {
    expect(validateCdEntryInput({ repo: "Acme/Hub" })).toBeNull();
    expect(validateCdEntryInput({ repo: "https://github.com/Acme/Hub.git" })).toBeNull();
    expect(validateCdEntryInput({ repo: "hub" })).toEqual({ repo: "must be owner/repo or a GitHub URL" });
    expect(validateCdEntryInput({ repo: "" })).toEqual({ repo: "must be owner/repo or a GitHub URL" });
    expect(validateCdEntryInput({})).toEqual({ repo: "must be owner/repo or a GitHub URL" });
  });

  it("non-object bodies are rejected up front instead of throwing", () => {
    expect(validateCdEntryInput(null)).toEqual({ repo: "must be owner/repo or a GitHub URL" });
    expect(validateCdEntryInput("acme/hub")).toEqual({ repo: "must be owner/repo or a GitHub URL" });
    expect(validateCdEntryInput([])).toEqual({ repo: "must be owner/repo or a GitHub URL" });
  });

  it("region: AWS region shape, including gov partitions", () => {
    expect(validateCdEntryInput({ repo: "a/b", region: "us-east-1" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", region: "us-gov-west-1" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", region: "us-east-11" })).toEqual({ region: "must be an AWS region like us-east-1 or us-gov-west-1" });
    expect(validateCdEntryInput({ repo: "a/b", region: "US-EAST-1" })).toEqual({ region: "must be an AWS region like us-east-1 or us-gov-west-1" });
    expect(validateCdEntryInput({ repo: "a/b", region: "us-east" })).toEqual({ region: "must be an AWS region like us-east-1 or us-gov-west-1" });
  });

  it("pipeline: CodePipeline name rules", () => {
    expect(validateCdEntryInput({ repo: "a/b", pipeline: "hub-juno-deploy" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", pipeline: "my pipeline" })).toEqual({ pipeline: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])" });
    expect(validateCdEntryInput({ repo: "a/b", pipeline: "bad/name" })).toEqual({ pipeline: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])" });
    expect(validateCdEntryInput({ repo: "a/b", pipeline: "x".repeat(101) })).toEqual({ pipeline: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])" });
  });

  it("ciProject: CodeBuild project name rules", () => {
    expect(validateCdEntryInput({ repo: "a/b", ciProject: "juno-pr-checks" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", ciProject: "x" })).toEqual({ ciProject: "must be a valid CodeBuild project name (2-150 chars of [A-Za-z0-9_-])" });
    expect(validateCdEntryInput({ repo: "a/b", ciProject: "bad name" })).toEqual({ ciProject: "must be a valid CodeBuild project name (2-150 chars of [A-Za-z0-9_-])" });
    expect(validateCdEntryInput({ repo: "a/b", ciProject: "x".repeat(151) })).toEqual({ ciProject: "must be a valid CodeBuild project name (2-150 chars of [A-Za-z0-9_-])" });
  });

  it("deployDoc: relative repo path, no leading slash, no .. segment, max 200 chars", () => {
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "docs/DEPLOY.md" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "DEPLOY.md" })).toBeNull();
    // A dot IN a segment is not a traversal segment ("..foo" / "a..b" are names).
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "docs/..deploy.md" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "x".repeat(200) })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "/etc/passwd" })).toEqual({ deployDoc: "must be a relative path (no leading slash)" });
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "\\etc\\passwd" })).toEqual({ deployDoc: "must be a relative path (no leading slash)" });
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "../../etc/passwd" })).toEqual({ deployDoc: "must not contain a .. path segment" });
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "a/../b" })).toEqual({ deployDoc: "must not contain a .. path segment" });
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "x".repeat(201) })).toEqual({ deployDoc: "must be at most 200 characters" });
  });

  it("deployDoc: a .. segment is caught however it is spelled — backslash, ./.., bare", () => {
    // The segment split is on [\\/]+, so a Windows-style separator cannot hide a
    // traversal from the check (the registry document is consumed by Linux
    // Lambdas, but the value arrives from an operator's keyboard).
    for (const bad of ["a\\..\\b", "..\\b", "./..", "docs/./../x", "..", "../", "a//../b"]) {
      expect(validateCdEntryInput({ repo: "a/b", deployDoc: bad })).toEqual({ deployDoc: "must not contain a .. path segment" });
    }
  });

  it("deployDoc: an encoded .. is caught through up to 3 decode passes", () => {
    // TEAM-4416 review (P2): `%2e%2e/secrets` used to pass the segment check,
    // because the check only ever saw the bytes as typed. The rules now also run
    // against each decoded form, so one or two encoding layers cannot hide a
    // traversal — and the reason is still the `..`-segment one, not a separate
    // "no encoding" rule (a literal `%` stays legal, see the next test).
    for (const bad of ["%2e%2e/secrets", "%2E%2E/secrets", "..%2fsecrets", "%252e%252e/x", "%2e%2e%5cx", "docs/%2e%2e/DEPLOY.md"]) {
      expect(validateCdEntryInput({ repo: "a/b", deployDoc: bad })).toEqual({ deployDoc: "must not contain a .. path segment" });
    }
    // An encoded separator that decodes to an ABSOLUTE path fails on that rule.
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "%2fetc/passwd" })).toEqual({ deployDoc: "must be a relative path (no leading slash)" });
  });

  it("deployDoc: a literal % in a filename is legal — decoding is best-effort, never a rule of its own", () => {
    // The approved rule set is leading-slash / .. segment / 200 chars. `%` is a
    // legal character in a repo path, and a value whose escapes are malformed
    // simply has no decoded form (decodeURIComponent throws → raw is final).
    for (const ok of ["docs/100%/DEPLOY.md", "100%.md", "%zz", "a%20b/DEPLOY.md", "docs/50%-off/DEPLOY.md"]) {
      expect(validateCdEntryInput({ repo: "a/b", deployDoc: ok })).toBeNull();
    }
  });

  it("deployDoc: a trailing slash is accepted — it is a relative path, and none of the rules forbid it", () => {
    // Pinned deliberately: the rule set is leading-slash / .. / length. A path
    // that names a directory is an operator oddity, not a traversal, and
    // upsertCdEntry stores it verbatim as it does today.
    expect(validateCdEntryInput({ repo: "a/b", deployDoc: "docs/" })).toBeNull();
  });

  it("notes: max 2000 chars", () => {
    expect(validateCdEntryInput({ repo: "a/b", notes: "x".repeat(2000) })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", notes: "x".repeat(2001) })).toEqual({ notes: "must be at most 2000 characters" });
  });

  it("a non-string optional field is rejected regardless of its value", () => {
    expect(validateCdEntryInput({ repo: "a/b", pipeline: 42 })).toEqual({ pipeline: "must be a string" });
    expect(validateCdEntryInput({ repo: "a/b", region: null })).toEqual({ region: "must be a string" });
  });

  it("blank/whitespace optional fields are the upsert 'clear it' signal, not a value — never rejected", () => {
    expect(validateCdEntryInput({ repo: "a/b", pipeline: "" })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", notes: "   " })).toBeNull();
    expect(validateCdEntryInput({ repo: "a/b", region: "", pipeline: "", ciProject: "", deployDoc: "", notes: "" })).toBeNull();
  });

  it("reports every failing field at once", () => {
    expect(validateCdEntryInput({ repo: "hub", region: "us-east-11", pipeline: "my pipe", deployDoc: "../x" })).toEqual({
      repo: "must be owner/repo or a GitHub URL",
      region: "must be an AWS region like us-east-1 or us-gov-west-1",
      pipeline: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])",
      deployDoc: "must not contain a .. path segment",
    });
  });

  it("a fully valid payload with every optional field set passes unchanged", () => {
    expect(
      validateCdEntryInput({
        repo: "acme/juno",
        pipeline: "hub-juno-deploy",
        region: "us-east-1",
        ciProject: "hub-juno-ci",
        deployDoc: "docs/DEPLOY.md",
        notes: "onboarded by ops",
      })
    ).toBeNull();
  });
});
