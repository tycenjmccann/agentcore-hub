import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// TEAM-5828 / TEAM-5854 (DL-037) — once a run's unified PR has merged, its
// integration branch is dead. The orchestrator states that in every persona's
// `## Branch` block (lambda/orchestrator/index.mjs buildAgentContext, NOTE "this
// run's unified PR already merged"); the blueprints are what act on it. These
// checks keep the blueprint side from drifting back to the shapes that stranded
// fix PRs on the dead branch. Pure text — whitespace is normalised so a command
// wrapped across lines still matches.

const DIR = join(__dirname, "../../../blueprints");
const blueprints = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), "utf8").replace(/\s+/g, " ") }));
const read = (name: string) => blueprints.find((b) => b.file === `${name}.md`)!.text;

describe("blueprint PR-base rules (TEAM-5854)", () => {
  it("every `gh pr list … --state merged` check is scoped with --base", () => {
    const offenders = blueprints.flatMap(({ file, text }) =>
      [...text.matchAll(/`(gh pr list[^`]*)`/g)]
        .map((m) => m[1])
        .filter((cmd) => cmd.includes("--state merged") && !cmd.includes("--base"))
        .map((cmd) => `${file}: ${cmd}`)
    );
    expect(offenders).toEqual([]);
  });

  it("no blueprint hardcodes main as a fix ticket's base (use ## Repository default_branch)", () => {
    // The one exemption: hub-infra fixes target the HUB's own repo, not the run's
    // `## Repository` repo (release-manager.md "Hub-infra fix tickets are targeted").
    const HUB_INFRA = 'against the hub\'s own default branch directly: pass `base_branch="main"`';
    expect(read("release-manager")).toContain(HUB_INFRA);
    const offenders = blueprints.flatMap(({ file, text }) =>
      [...text.replace(HUB_INFRA, "").matchAll(/base_branch="main"|"baseBranch":\s*"main"/g)].map((m) => `${file}: ${m[0]}`)
    );
    expect(offenders).toEqual([]);
  });

  it.each(["code-reviewer", "ci-agent", "qa-verifier", "release-manager"])("%s acts on the orchestrator's merged NOTE", (name) => {
    expect(read(name)).toContain("this run's unified PR already merged");
  });

  // TEAM-5869 N5: the ship phase now gets the merged NOTE too, so Step 1 must adopt the
  // fix ticket's own PR instead of opening one from the dead shared branch.
  it("release-manager Step 1 adopts the fix ticket's own PR after the merge", () => {
    const rm = read("release-manager");
    const step1 = rm.slice(rm.indexOf("### Step 1:"), rm.indexOf("### Step 2:"));
    expect(step1.length).toBeGreaterThan(0);
    expect(step1).toContain("this run's unified PR already merged");
    expect(step1).toContain("Adopt the fix ticket's OWN PR");
    expect(step1).toContain("do NOT `create_pull_request` from it");
  });

  // TEAM-5915 (S1-4): resolvePrBase (lambda/orchestrator/completion.mjs) keeps an
  // explicit ticket base_branch even after the unified merge, and ## Branch names
  // it. These pin that the review/verify/sync target is that resolved base — the
  // repo default branch only when the ticket stated none — never "the default
  // branch" unconditionally.
  const between = (text: string, from: string, to: string) => {
    const i = text.indexOf(from);
    const j = text.indexOf(to, i + from.length);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    return text.slice(i, j);
  };
  const BRANCH_BASE = "the `base_branch:` your `## Branch` context names";
  const DEAD = "**After the unified PR has merged, the integration branch is dead.**";

  it.each([
    ["code-reviewer", DEAD, "## Main-sync rule"],
    ["ci-agent", DEAD, "### P0:"],
    ["qa-verifier", "2. Find the implementation branch", "3. Read the acceptance criteria"],
  ])("%s targets the ## Branch base_branch, not the default branch, for a post-merge fix PR", (name, from, to) => {
    const para = between(read(name), from, to);
    expect(para).toContain(BRANCH_BASE);
    expect(para).not.toContain("against the default branch");
  });

  it("release-manager: 'leave base_branch out' is pre-merge only; post-merge keeps a stated base and the hub-infra exception", () => {
    const rm = read("release-manager");
    expect(rm).toContain("Before the merge, on every OTHER ticket you file, leave `base_branch` out entirely");
    expect(rm).not.toContain("target repo. On every OTHER ticket you file");
    const post = between(rm, "**After the unified PR has merged, the default flips.**", "Both kinds share:");
    expect(post).toContain("Every ordinary fix ticket");
    expect(post).toContain(`unless the work targets another stated base (${BRANCH_BASE}`);
    expect(post).toContain("A hub-infra fix keeps its hub `main` base");
  });

  it.each(["api-dev", "backend-dev", "frontend-dev", "bug-fixer"])("%s no longer says ## Branch names the default branch unconditionally", (name) => {
    const t = read(name);
    expect(t).not.toContain("names the default branch as base_branch");
    expect(t).toContain("its base_branch is the base your fix PR targets");
  });
});
