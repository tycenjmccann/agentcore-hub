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
  ])("%s maps `<default branch>` in the Main-sync rule to the stated base_branch", (name, from, to) => {
    const para = between(read(name), from, to);
    expect(para).toMatch(PLACEHOLDER_MAP);
    expect(para).toContain(BRANCH_BASE);
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

// TEAM-6032 / TEAM-6034 (DL-038) — a post-merge follow-up PR to the default branch
// is not delivered when it opens: it ships through its own CI → Ship → Merge
// Approval → CD chain, filed by the fixer. The orchestrator's completion gate
// (open_follow_up_pr) is only the backstop; these checks keep the procedure in
// one blueprint and every caller pointing at it.
describe("post-merge follow-up PR ship chain (TEAM-6032)", () => {
  const SECTION = "Post-merge follow-up PR: file its ship chain";

  it("no blueprint claims a post-merge PR goes through Merge Approval on its own", () => {
    const offenders = blueprints.filter(({ text }) => text.includes("Merge Approval like any change")).map((b) => b.file);
    expect(offenders).toEqual([]);
  });

  it("bug-fixer owns the procedure: four chain tickets, never self-merge", () => {
    const t = read("bug-fixer");
    expect(t).toContain(`### ${SECTION}`);
    for (const title of ["CI: Certify follow-up PR", "Ship: follow-up PR", "Merge Approval: follow-up PR", "CD: follow-up PR"]) {
      expect(t).toContain(title);
    }
    expect(t).toContain("agentcore_hub_ci_agent");
    expect(t).toContain("agentcore_hub_release_manager");
    expect(t).toContain("never merge it yourself");
  });

  it("the dev blueprints point at the bug-fixer section instead of restating it", () => {
    for (const name of ["api-dev", "backend-dev", "frontend-dev"]) {
      expect(read(name)).toContain('load_blueprint("bug-fixer")');
      expect(read(name)).toContain(SECTION);
    }
  });

  it("release-manager ships follow-up pairs, files orphans, and archives the earlier cd-ledger", () => {
    const t = read("release-manager");
    expect(t).toContain("Ship: follow-up PR");
    expect(t).toContain("CD: follow-up PR");
    expect(t).toContain("Orphan rule (TEAM-6032)");
    expect(t).toContain("open_follow_up_pr");
    expect(t).toContain("workflows/{workflow_id}/shared/cd-ledger-<its mergeCommit>.json");
    expect(t).toMatch(/copy it verbatim to `workflows\/\{workflow_id\}\/shared\/cd-ledger-<its mergeCommit>\.json`.*only THEN start a fresh ledger/);
  });

  it("qa-verifier treats a post-merge fix delivered only on its follow-up CD merge_commit", () => {
    const t = read("qa-verifier");
    expect(t).toContain(SECTION);
    expect(t).toMatch(/`CD: follow-up PR` ticket reports a `merge_commit`/);
  });
});
