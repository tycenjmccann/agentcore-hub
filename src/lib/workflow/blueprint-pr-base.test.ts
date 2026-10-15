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
const ARCH = readFileSync(join(__dirname, "../../../docs/architecture.md"), "utf8").replace(/\s+/g, " ");
/** `text` from `start` up to the first `end` after it; fails loudly when `start` is missing. */
const section = (text: string, start: string, end: string) => {
  const i = text.indexOf(start);
  expect(i, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
};

// TEAM-6147 (ship-review r2 R2-F1, regression of TEAM-6134): a blueprint that prescribes a
// `Tickets___*` call with a kwarg the runtime's `@tool` wrapper does not declare is dead text —
// Strands rejects the unknown keyword and the step silently never happens. The wrapper's def
// line (deploy/runtime-agent/main.py) IS the tool spec, so it is read here as source text, the
// same idiom as tool-signature-parity.test.ts (not imported: importing a test file would
// register its suites twice).
const MAIN_PY = readFileSync(join(__dirname, "../../../deploy/runtime-agent/main.py"), "utf8");
/** Parameter names of one `@tool def Name(...)` in main.py (the def line may wrap). */
const toolParams = (name: string): string[] => {
  const start = MAIN_PY.indexOf(`def ${name}(`);
  expect(start, `${name} is not a tool in main.py`).toBeGreaterThan(-1);
  const open = start + `def ${name}`.length;
  let depth = 0;
  let close = -1;
  for (let i = open; i < MAIN_PY.length; i++) {
    if (MAIN_PY[i] === "(") depth++;
    else if (MAIN_PY[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  expect(close, `unbalanced parens on ${name}'s def line`).toBeGreaterThan(open);
  return MAIN_PY.slice(open + 1, close)
    .split(",")
    .map((p) => p.split(":")[0].split("=")[0].trim())
    .filter(Boolean);
};
/** Every `Tickets___x(...)` call prescribed in `text` → { tool, kwargs }. Quoted values and
 *  `<placeholders>` are stripped first so a `=` inside them is not read as a kwarg. */
const prescribedCalls = (text: string) =>
  [...text.matchAll(/Tickets___(\w+)\(([^)]*)\)/g)].map((m) => ({
    tool: `Tickets___${m[1]}`,
    kwargs: [...m[2].replace(/"[^"]*"|'[^']*'|<[^>]*>/g, "").matchAll(/\b(\w+)\s*=/g)].map((k) => k[1]),
  }));
/** Fails unless every kwarg of every prescribed `Tickets___*` call in `text` is a declared parameter. */
const expectCallsSupported = (text: string, where: string) => {
  for (const call of prescribedCalls(text)) {
    const params = toolParams(call.tool);
    for (const k of call.kwargs) expect(params, `${call.tool}(${k}=…) in ${where} — not a parameter of that tool`).toContain(k);
  }
};

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

// TEAM-6032 / TEAM-6034 (DL-038) — a post-merge follow-up PR to the default branch
// is not delivered when it opens: it ships through its own CI → Ship → Merge
// Approval → CD chain, filed by the fixer. The orchestrator's completion gate
// (open_follow_up_pr) is only the backstop; these checks keep the procedure in
// one blueprint and every caller pointing at it.
describe("post-merge follow-up PR ship chain (TEAM-6032)", () => {
  const SECTION = "Post-merge follow-up PR: file its ship chain";

  it("no blueprint claims a post-merge PR goes through Merge Approval on its own", () => {
    const BANNED = ["Merge Approval like any change", "through review → CI → Merge Approval"];
    const offenders = blueprints.flatMap(({ file, text }) => BANNED.filter((p) => text.includes(p)).map((p) => `${file}: ${p}`));
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
      expect(read(name)).toContain(
        "branch fresh from the default branch and PR to the default branch; never PR into the merged integration branch."
      );
    }
  });

  // TEAM-6107: e6aaf94 regressed this exact sentence in api/backend/frontend-dev into
  // "...and PR to the default branch and PR to the default branch;" when it added the
  // bug-fixer pointer. Pin both the specific phrase and a general doubled-phrase guard
  // over every blueprint so the same edit mistake can't silently recur anywhere else.
  it("no blueprint repeats \"and PR to the default branch\" back-to-back", () => {
    const offenders = blueprints
      .filter(({ text }) => text.includes("and PR to the default branch and PR to the default branch"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  // TEAM-6126: this guard was /\b((?:\S+ ){4,}\S+) \1\b/g, which backtracked O(n²) over
  // each one-line blueprint (~13s; synchronous, so testTimeout never fired). Near-linear
  // instead: a back-to-back repeat of k >= minWords tokens at p shares its first
  // minWords-token key with p+k, so only pairs in one bucket are checked.
  // TEAM-6132: the \b edges missed repeats ending in punctuation (… start. … start.) or
  // starting with a backtick, so tokens are compared whole, case-folded, with leading and
  // trailing punctuation stripped. Punctuation-only tokens (—, |, -) are dropped: they are
  // not words, and dropping them makes `start — check` the same repeat as `start, check`.
  const norm = (t: string) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const findRepeatedPhrases = (text: string, minWords = 5) => {
    const raw = text.split(" ").filter(Boolean);
    const w: string[] = [];
    const src: number[] = [];
    raw.forEach((t, i) => {
      const n = norm(t);
      if (n) {
        w.push(n);
        src.push(i);
      }
    });
    const at = new Map<string, number[]>();
    for (let j = 0; j + minWords <= w.length; j++) {
      const key = w.slice(j, j + minWords).join(" ");
      const ps = at.get(key);
      if (ps) ps.push(j);
      else at.set(key, [j]);
    }
    const hits: [number, number][] = [];
    for (const ps of at.values()) {
      for (let a = 0; a < ps.length; a++) {
        for (let b = a + 1; b < ps.length; b++) {
          const p = ps[a];
          const k = ps[b] - p;
          if (k < minWords || p + 2 * k > w.length) continue;
          let t = minWords;
          while (t < k && w[p + t] === w[p + k + t]) t++;
          if (t === k) {
            hits.push([p, k]);
            break;
          }
        }
      }
    }
    // One report per repeat, like the regex's non-overlapping matchAll: a repeat's
    // rotations (… X Y X Y … shifted by one word) all hit, so keep the leftmost.
    hits.sort((x, y) => x[0] - y[0]);
    const found: string[] = [];
    let end = 0;
    for (const [p, k] of hits) {
      if (p < end) continue;
      found.push(raw.slice(src[p], src[p + k - 1] + 1).join(" "));
      end = p + 2 * k;
    }
    return found;
  };

  // TEAM-6132: repeats ending in punctuation or starting with a backtick slipped past the \b edges.
  it.each([
    ["trailing punctuation", "Check the ticket before you start. Check the ticket before you start."],
    ["leading backtick", "`a b c d e `a b c d e"],
    ["punctuation + case variant", "Check the ticket before you start, check the ticket before you start"],
    ["plain words", "check the ticket before you check the ticket before you"],
  ])("findRepeatedPhrases flags a %s repeat (TEAM-6132)", (_, text) => {
    expect(findRepeatedPhrases(text)).toHaveLength(1);
  });

  it.each([
    ["a four-word repeat", "a b c d a b c d"],
    ["a non-adjacent repeat", "a b c d e x a b c d e"],
    ["a punctuation-only run", "- - - - - - - - - -"],
  ])("findRepeatedPhrases ignores %s (TEAM-6132)", (_, text) => {
    expect(findRepeatedPhrases(text)).toEqual([]);
  });

  it("no blueprint repeats any five-plus-word phrase back-to-back", () => {
    const offenders = blueprints.flatMap(({ file, text }) => findRepeatedPhrases(text).map((r) => `${file}: ${r}`));
    expect(offenders).toEqual([]);
  });

  // TEAM-6134 retired the cd-ledger mergeCommit archive (see the F3 test below).
  it("release-manager ships follow-up pairs and files orphans", () => {
    const t = read("release-manager");
    expect(t).toContain("Ship: follow-up PR");
    expect(t).toContain("CD: follow-up PR");
    expect(t).toContain("Orphan rule (TEAM-6032)");
    expect(t).toContain("open_follow_up_pr");
  });

  // TEAM-6134 F1 (ship review of #954): the four chain tickets are four separate creates, so a
  // session can stop after CI + Ship. Title de-dup alone then never files Merge Approval/CD, and
  // the RM orphan rule skipped any PR that already had a Ship ticket. Every pass reconciles all four.
  it("every follow-up chain filing and orphan pass reconciles all four links and their edges (TEAM-6134)", () => {
    const chain = section(read("bug-fixer"), "### Post-merge follow-up PR: file its ship chain", "**Hub-infra fix PR.**");
    expect(chain).toContain("**One chain per PR, reconciled on every pass.**");
    expect(chain).toContain("reconciles all four links for that `pr_url`");
    expect(chain).toContain("create only the missing links");
    // TEAM-6147 (R2-F1): the edge repair must be a call the runtime accepts. `update_ticket`
    // takes only ticket_id/description/title, so the TEAM-6134 text raised and no edge was
    // ever repaired. The supported, additive path is transition_ticket(blocked, blocked_by=…).
    expectCallsSupported(chain, "bug-fixer.md chain section");
    expect(toolParams("Tickets___update_ticket")).not.toContain("blocked_by"); // the premise of the rule
    expect(chain).toMatch(/Tickets___transition_ticket\([^)]*transition_id="blocked"[^)]*blocked_by=/);
    expect(chain).toMatch(/Tickets___transition_ticket\([^)]*expected_status=/);
    // Status guard: only a not-started link is re-blocked; a live or finished one gets a comment.
    expect(chain).toContain("`todo`, `ready` or `blocked`");
    expect(chain).toContain("never re-block it");
    expect(chain).toContain("Tickets___add_comment(");
    expect(chain).toContain("A chain is complete only when all four exist with those edges");
    expect(chain).not.toContain("never re-file a chain whose titles already name your `pr_url`");
    const orphan = section(read("release-manager"), "**Orphan rule (TEAM-6032).**", "Both kinds share:");
    expect(orphan).not.toContain("that has no `Ship: follow-up PR <url>` ticket");
    expect(orphan).toContain("whose chain is incomplete");
    expect(orphan).toContain("create only the missing links and repair only the missing edges");
    expectCallsSupported(orphan, "release-manager.md orphan rule");
  });

  // TEAM-6147: the whole blueprint set, not just the two sections above — nothing may prescribe
  // `update_ticket` with a blocker field anywhere, and the orphan rule's repeat of the repair
  // carries the same status guard.
  it("no blueprint prescribes Tickets___update_ticket with blocked_by (TEAM-6147)", () => {
    const offenders = blueprints.flatMap(({ file, text }) =>
      [...text.matchAll(/Tickets___update_ticket\([^)]*\)/g)]
        .filter((m) => /\bblocked_by\s*=/.test(m[0]))
        .map((m) => `${file}: ${m[0]}`)
    );
    expect(offenders).toEqual([]);
    const orphan = section(read("release-manager"), "**Orphan rule (TEAM-6032).**", "Both kinds share:");
    expect(orphan).toMatch(/Tickets___transition_ticket\([^)]*transition_id="blocked"[^)]*blocked_by=/);
    expect(orphan).toContain("`todo`/`ready`/`blocked`");
    expect(orphan).toContain("Tickets___add_comment");
  });

  // TEAM-6134 F2: follow-up chains run concurrently, so "the newest CI record under the epic" can be
  // another PR's — a spurious SHA mismatch for A and the wrong cert in A's brief. The unified PR
  // keeps today's selection (its CI tickets are the only ones until a follow-up exists).
  it("a PR's CI certification is the newest CI record for THAT PR, never another PR's (TEAM-6134)", () => {
    const step1 = section(read("release-manager"), "### Step 1: Open (or adopt) the unified PR", "### Step 2:");
    expect(step1).toContain("**SHA cross-check:** read the NEWEST CI completion record for THIS PR");
    expect(step1).toContain("For the run's unified PR that is the run's CI tickets whose titles name no follow-up PR (the Tier-5 CI ticket or the latest `CI (re-cert)` ticket)");
    expect(step1).toContain("`CI (re-cert): follow-up PR <url>`");
    expect(step1).toContain("another PR's CI record never invalidates or supplies this PR's certification");
    expect(step1).toContain("from that same NEWEST CI completion record for THIS PR");
    expect(read("ci-agent")).toContain("A `CI (re-cert): follow-up PR <pr_url>` ticket certifies that PR");
    expect(read("qa-verifier")).toContain("the NEWEST CI completion record for the PR you are verifying");
    const STALE = [/newest CI record under the epic/i, /NEWEST CI completion record — the most recently closed/];
    const offenders = blueprints.flatMap(({ file, text }) => STALE.filter((r) => r.test(text)).map((r) => `${file}: ${r}`));
    expect(offenders).toEqual([]);
  });

  // TEAM-6134 F3: the archive rule assumed the other PR's deploy was finished. Chains are not
  // serialized, so a re-dispatched CD-A found B's ledger and started fresh instead of resuming.
  // Each follow-up CD owns cd-ledger-<CD ticket id>.json; the unified CD's cd-ledger.json is untouched.
  it("a follow-up CD keeps its own ledger keyed by its CD ticket and resumes it first (TEAM-6134)", () => {
    const rm = read("release-manager");
    const ledger = section(rm, "#### The CD ledger", "1. **Preflight:**");
    expect(ledger).toContain("`workflows/{workflow_id}/shared/cd-ledger.json` is this run's deploy record, and reading it");
    expect(ledger).toContain("**One ledger per CD ticket (follow-up CD).**");
    expect(ledger).toContain("`workflows/{workflow_id}/shared/cd-ledger-<CD ticket id>.json`");
    expect(ledger).toContain("read it FIRST on every invocation, write it the moment `start_deploy` returns, and resume its `executionId` before any new start");
    expect(ledger).toContain("never writes, copies or archives `shared/cd-ledger.json`");
    expect(ledger).toContain("passes `pipeline_name` on `report_completion`");
    expect(rm).toContain("Write `shared/cd-ledger.json` (on a follow-up CD, your `cd-ledger-<CD ticket id>.json`) the instant");
    const offenders = blueprints.filter(({ text }) => /cd-ledger-<its mergeCommit>|only THEN start a fresh ledger/.test(text)).map((b) => b.file);
    expect(offenders).toEqual([]);
    expect(read("bug-fixer")).toContain("Chains for different PRs are not serialized");
    expect(ARCH).toContain("**Persisted state: the follow-up CD ledger (`workflows/{id}/shared/cd-ledger-<CD ticket id>.json`).**");
    expect(ARCH).not.toContain("**Persisted state: the cd-ledger archive");
  });

  // TEAM-6149 (ship review r2 F2 of #954): the TEAM-6134 text claimed workflow-output
  // "derives nothing" from the unified ledger on a follow-up CD. It derived the unified
  // deploy's stale handoff[]/unmerged, because it read only cd-ledger.json. The reader
  // now selects the per-ticket key first and the unified key only when its prUrl is
  // the report's pr_url; the blueprint tells a follow-up CD to pass that pr_url.
  it("report_completion reads the follow-up CD's own ledger first, unified only on a prUrl match (TEAM-6149)", () => {
    const rm = read("release-manager");
    const ledger = section(rm, "#### The CD ledger", "1. **Preflight:**");
    expect(ledger).toContain("reads your `cd-ledger-<CD ticket id>.json` first and falls back to `shared/cd-ledger.json` only when its `prUrl` is the same PR as your `pr_url`");
    expect(ledger).toContain("`pr_url=<the follow-up PR>`");
    expect(rm).not.toContain("which probes only `shared/cd-ledger.json`");
    expect(ARCH).toContain("`cd-ledger-<ticket_id>.json` first, then `cd-ledger.json` only when its `prUrl` matches the report's `pr_url`");
    expect(ARCH).not.toContain("carries no `handoff[]` / `unmerged`");
  });

  // TEAM-6154 (ship review r3 of #954): the TEAM-6149 match was a string compare (a
  // different host/owner/repo case or a #fragment on the unified CD's OWN PR dropped
  // its handoffs), a prUrl-less unified ledger matched every report (a follow-up CD
  // re-derived the unified deploy's stale unmerged), and a `null` body read as 404.
  // The blueprint and the architecture record state the ownership rule, not the
  // string rule, and the non-object-body refusal.
  it("the unified-ledger fallback is canonical PR identity or deploy evidence, and a non-object body refuses (TEAM-6154)", () => {
    const rm = read("release-manager");
    const ledger = section(rm, "#### The CD ledger", "1. **Preflight:**");
    expect(ledger).toContain("owner/repo case-insensitive, same number");
    expect(ledger).toContain("or when it names no `prUrl` but its `executionId` / `mergeCommit` is the one you report");
    expect(ledger).toContain("a `prUrl`-less ledger nothing ties to your report, is no ledger");
    expect(ledger).toContain("or whose body is not a JSON object, refuses the report");
    expect(ledger).not.toContain("(or no `pr_url` was passed); a mismatch is no ledger");
    expect(ARCH).toContain("by canonical PR identity (owner/repo case-insensitive + number, via a byte-mirror of the orchestrator's `githubPrRef` in `lambda/workflow-output/github-pr-ref.mjs`, parity-pinned)");
    expect(ARCH).toContain("a `prUrl`-less ledger nothing ties to the report derives nothing (source `anonymous`)");
    expect(ARCH).toContain("including a body that exists but is not a JSON object (`null`, an array, a scalar) - refuses the report");
    expect(ARCH).not.toContain("(trim and trailing slash normalized)");
  });

  it("qa-verifier treats a post-merge fix delivered only on its follow-up CD merge_commit", () => {
    const t = read("qa-verifier");
    expect(t).toContain(SECTION);
    expect(t).toMatch(/`CD: follow-up PR` ticket reports a `merge_commit`/);
  });

  // TEAM-6063 finding 1: a `CI: Certify follow-up PR` ticket may carry no fix-ticket
  // blocker, so ci-agent cannot resolve "the fix ticket's own PR" the normal way. It
  // must read the PR named in the ticket itself.
  it("ci-agent certifies the PR a `CI: Certify follow-up PR` ticket names (TEAM-6063)", () => {
    const t = read("ci-agent");
    const para = t.slice(t.indexOf("**After the unified PR has merged, the integration branch is dead.**"), t.indexOf("### P0:"));
    expect(para).toContain("**On a `CI: Certify follow-up PR <pr_url>` ticket**");
    expect(para).toContain("gh pr view <pr_url> --json headRefName,headRefOid,baseRefName");
    expect(para).toContain("never the integration branch or a guessed fix ticket");
    expect(para).toContain("`ci_head_sha` must equal that PR's head SHA");
  });

  // TEAM-6063 finding 2: QA is re-invoked when the fix ticket goes Done, which is
  // PR-open time, before the merge. It must park on the fix's CD ticket instead of
  // verifying (and delivering a verdict) early.
  it("qa-verifier parks on the fix's CD: follow-up PR ticket until it merges (TEAM-6063)", () => {
    const t = read("qa-verifier");
    expect(t).toContain("find its `CD: follow-up PR <pr_url>` ticket");
    expect(t).toContain('transition_id="blocked", blocked_by="<CD ticket id>"');
    expect(t).toMatch(/blocked_by="<CD ticket id>"[^`]*\)`\s*\(DL-024\) and exit WITHOUT `report_completion`/);
  });

  // TEAM-6076 (review round 2 of #933): TEAM-6063's park covers only a CD ticket that
  // exists and is not Done. When none exists (fixer skipped the chain, RM orphan rule
  // not run yet) QA must file the chain itself — bug-fixer's exact four titles — and
  // park on the CD ticket it filed, never verify the undeployed fix. And "Done" alone
  // is not delivery: the CD completion record must report a merge_commit.
  it("qa-verifier files the follow-up chain itself when no CD: follow-up PR ticket exists (TEAM-6076)", () => {
    const t = read("qa-verifier");
    const para = t.slice(t.indexOf("find its `CD: follow-up PR <pr_url>` ticket"), t.indexOf("### Step 5: Deliver Verdict"));
    expect(para.length).toBeGreaterThan(0);
    expect(para).toContain("If NO `CD: follow-up PR <pr_url>` ticket exists");
    expect(para).toContain("the fix is undeployed and you do not verify it");
    expect(para).toContain("Orphan rule (TEAM-6032)");
    expect(para).toContain("never re-file");
    // Same four titles as bug-fixer, in chain order, and the park comes after the filing.
    const TITLE_RE = /`((?:CI: Certify|Ship:|Merge Approval:|CD:) follow-up PR <pr_url>)`/g;
    const titles = (s: string) => [...s.matchAll(TITLE_RE)].map((m) => m[1]);
    const CHAIN = ["CI: Certify follow-up PR <pr_url>", "Ship: follow-up PR <pr_url>", "Merge Approval: follow-up PR <pr_url>", "CD: follow-up PR <pr_url>"];
    expect([...new Set(titles(read("bug-fixer")))]).toEqual(CHAIN);
    const IF_NO = "If NO `CD: follow-up PR <pr_url>` ticket exists";
    const filed = para.slice(para.indexOf(IF_NO) + IF_NO.length);
    expect(titles(filed).slice(0, 4)).toEqual(CHAIN);
    expect(filed.indexOf("CD: follow-up PR <pr_url>` → `agentcore_hub_release_manager`")).toBeLessThan(filed.lastIndexOf("exit WITHOUT `report_completion`"));
    // Delivery = CD ticket Done AND its completion record carries merge_commit; Done without one is not delivered.
    expect(para).toContain("Done AND its completion record");
    expect(para).toContain("Done without a `merge_commit` is NOT delivered");
  });

  // TEAM-6063 finding 3: a hub-infra fix PR is an orphan class the existing chain and
  // completion-gate backstop don't cover (wrong repo, wrong ci_project/pipeline). Someone
  // must still ship or hand it off.
  it.each(["bug-fixer", "release-manager"])("%s names who ships a hub-infra fix PR (TEAM-6063)", (name) => {
    const t = read(name);
    expect(t).toContain("orphan class");
    expect(t).toContain("`ci_project: agentcore-hub-ci`");
    expect(t).toContain("`pipeline: agentcore-hub-deploy`");
    expect(t).toContain("`human:engineer`");
    expect(t).toContain("regardless of whether");
    expect(t).toContain("no completion-gate backstop");
  });
});
