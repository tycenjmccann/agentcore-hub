import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as orch from "../../../lambda/orchestrator/cd-registry.mjs";
import * as app from "../cd-registry";

/**
 * TEAM-5995 parity contract — workflow-output's inline CD-registry match.
 *
 * workflow-output releases a merge-brief hold on a run that never gets a Merge
 * Approval gate, and "never" for an SDLC def means "the repo is not CD-registered,
 * so the orchestrator strips the ship gate". It decides that with a byte copy of
 * normalizeRepoKey plus a raw-document match (cdRegistryListsRepo), inlined in
 * index.mjs rather than shipped as a module (no zip-manifest change). If either
 * drifts from the orchestrator (cd-registry.mjs) or the app (src/lib/cd-registry.ts),
 * a hold could be released on a run that DOES owe a gate. Pinned two ways: the
 * normalizer's SOURCE is byte-identical, and the match agrees case for case.
 */
const SRC = readFileSync(resolve(__dirname, "../../../lambda/workflow-output/index.mjs"), "utf8");
const extract = (name: string, params: string) => {
  const m = new RegExp(`^function ${name}\\(${params}\\) \\{[\\s\\S]*?^\\}`, "m").exec(SRC);
  if (!m) throw new Error(`function ${name}(${params}) not found in lambda/workflow-output/index.mjs`);
  return m[0];
};
const normalizeSrc = extract("normalizeRepoKey", "value");
const matchSrc = extract("cdRegistryListsRepo", "doc, repoConfig");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inline = new Function(`${normalizeSrc}\n${matchSrc}\nreturn { normalizeRepoKey, cdRegistryListsRepo };`)() as {
  normalizeRepoKey: (v: unknown) => string | null;
  cdRegistryListsRepo: (doc: unknown, repoConfig: unknown) => boolean;
};

const URLS = [
  "https://github.com/Acme/Hub.git", "git@github.com:Acme/Hub.git", "acme/hub", "hub", "",
  "https://github.com/owner/repo.git/", "owner/repo/.git", "https://github.com/Owner/Repo/.git",
  "https://github.com/acme/hub/tree/main", "  acme/hub  ", null, undefined, 42,
];
const DOCS: unknown[] = [
  { version: 1, repos: [] },
  { version: 1, repos: [{ repo: "Acme/Hub", pipeline: "hub-acme-deploy" }] },
  { version: 1, repos: ["https://github.com/acme/hub"] },
  { version: 1, repos: [{ repo: "owner/repo" }, { repo: "not a repo" }, null, 7] },
  { version: 1, repos: [{ pipeline: "no-repo-field" }, { repo: "git@github.com:Owner/Repo.git" }] },
];

describe("workflow-output inline CD-registry match — parity with cd-registry.mjs / cd-registry.ts", () => {
  it("normalizeRepoKey is a byte copy of the orchestrator's", () => {
    expect(normalizeSrc).toBe(orch.normalizeRepoKey.toString());
  });

  it.each(URLS.map((u) => [u]))("normalizeRepoKey(%j) agrees across the three copies", (u) => {
    expect(inline.normalizeRepoKey(u)).toBe(orch.normalizeRepoKey(u));
    expect(inline.normalizeRepoKey(u)).toBe(app.normalizeRepoKey(u));
  });

  it("cdRegistryListsRepo agrees with findCdEntry(parseCdRegistry(doc)) for every (doc, url)", () => {
    for (const doc of DOCS) {
      for (const url of URLS) {
        const repoConfig = { repos: [{ url }] };
        const want = orch.findCdEntry(orch.parseCdRegistry(doc), repoConfig) !== null;
        expect(inline.cdRegistryListsRepo(doc, repoConfig), JSON.stringify({ doc, url })).toBe(want);
        expect(app.findCdEntry(app.parseCdRegistry(doc), url) !== null, JSON.stringify({ doc, url })).toBe(want);
      }
      expect(inline.cdRegistryListsRepo(doc, {})).toBe(false);
      expect(inline.cdRegistryListsRepo(doc, null)).toBe(false);
    }
  });
});
