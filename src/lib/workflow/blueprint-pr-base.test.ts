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

  // TEAM-5934 S2-2: every persona that merges a sync maps `<default branch>` in the shared
  // Main-sync block to the PR's resolved base (the stated `base_branch:`, else the repo
  // default branch). The reviewer/CI wording (TEAM-5915) is the template; the block itself
  // is byte-identical in nine files (scripts/check-blueprint-main-sync.sh) so the mapping
  // lives in each role's own prose.
  const SCOPE_DEV = "**Your scope:** you PUSH the sync — this is the LAST development step";
  const PLACEHOLDER_MAP = /`<default branch>`[^.]*?Main-sync rule[^.]*?\bmeans\b/;
  it.each([
    ["code-reviewer", DEAD, "## Main-sync rule"],
    ["ci-agent", DEAD, "### P0:"],
    ["release-manager", "**Your scope:** you PUSH the sync — but ONLY during the ship review", "### Step 1:"],
    ["api-dev", SCOPE_DEV, "## Sibling-sweep rule"],
    ["backend-dev", SCOPE_DEV, "## Sibling-sweep rule"],
    ["frontend-dev", SCOPE_DEV, "## Sibling-sweep rule"],
    ["bug-fixer", SCOPE_DEV, "## Sibling-sweep rule"],
    ["code-sweeper", "**Your scope:** you PUSH the sync on your own `feature_branch`", "## The core risk"],
  ])("%s maps `<default branch>` in the Main-sync rule to the stated base_branch", (name, from, to) => {
    const para = between(read(name), from, to);
    expect(para).toMatch(PLACEHOLDER_MAP);
    expect(para).toContain(BRANCH_BASE);
  });

  // TEAM-5945: code-sweeper opens its PR into `base_branch` (never merges into it, unlike
  // the four dev personas above), so its own sync step merges the resolved base INTO
  // `feature_branch` and checks ancestry against that same resolved base — never the
  // default branch into a stated non-default base_branch.
  it("code-sweeper Step 5 syncs and checks ancestry against the resolved base, never the default branch into a stated base", () => {
    const t = read("code-sweeper");
    const step = between(t, "Sync `feature_branch` on main FIRST", "Push `feature_branch`, open a PR into `base_branch`");
    expect(step).toContain("resolved base");
    expect(step).toContain("`origin/<base_branch>` when your ticket stated a base");
    expect(step).toContain("never merge the default branch into a stated non-default base");
    expect(step).toContain("`git merge-base --is-ancestor origin/<base_branch> HEAD`");
    expect(step).not.toContain("Merge `origin/<default branch>` INTO your `feature_branch`");
    expect(step).not.toContain("means `<default branch>` is an ancestor of your head");
    expect(t).not.toContain("with your `feature_branch` behind the repo default branch");
  });

  it.each(["api-dev", "backend-dev", "frontend-dev", "bug-fixer"])("%s delivery step syncs from the resolved base, never the default branch into a stated base", (name) => {
    const t = read(name);
    const start = t.search(/Sync `?base_branch`? on main/);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = t.indexOf("sync, then report", start);
    expect(end).toBeGreaterThan(start);
    const step = t.slice(start, end);
    expect(step).toContain("resolved base");
    expect(step).toContain("`origin/<base_branch>` INTO your `feature_branch`");
    expect(step).not.toContain("merge `origin/<default branch>` INTO `base_branch`");
  });

  it("release-manager CONFLICTING sync merges the resolved base into the PR head", () => {
    const step = between(read("release-manager"), "`CONFLICTING` → YOU sync it", "Never a dev fix ticket for staleness");
    expect(step).toContain("resolved base");
    expect(step).toContain("`origin/<base_branch>`");
  });

  // TEAM-5934 S2-3: after the merge, QA's "head you are verifying" is the fix PR's pushed
  // head (its completion record's branch / pr_url), and base_branch is only the diff and
  // ci_head_sha comparison target — `origin/<base_branch>` is the BASE's tip then.
  it("qa-verifier derives the post-merge head from the fix PR and uses base_branch only as the comparison target", () => {
    const scope = between(read("qa-verifier"), "**Your scope:** NOT YOUR CONCERN", "### Step 2: Build Verification");
    expect(scope).toContain("pushed integration-branch head (`git rev-parse origin/<base_branch>`)");
    expect(scope).toContain("`branch` in its completion record");
    expect(scope).toContain("`pr_url`");
    expect(scope).toContain("`base_branch` is ONLY the base you diff and compare against");
    expect(scope).not.toContain("is ALWAYS the pushed integration-branch head");
  });
});
