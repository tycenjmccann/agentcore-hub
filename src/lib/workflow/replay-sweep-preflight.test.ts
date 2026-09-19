import { describe, it, expect } from "vitest";
import { runSweepPreflight, shouldMintEpic, sweepPreflightNote, skipCommentTarget } from "./sweep-preflight";
import workflowsConfig from "@/config/workflows.json";

/**
 * TEAM-4740 FR-9 acceptance — four real dead-code-sweep runs, replayed through the
 * REAL preflight with GitHub's actual responses as fixtures.
 *
 * These are the runs the preflight exists for. Each one burned a full sweep +
 * review + QA + ship chain, and three of the four produced a PR nobody could
 * merge because an equivalent PR was already open on the same base:
 *
 *   lpkxmt   main @0760fcc. #30 and #33 both open, both based on 0760fcc. The run
 *            opened a third. ⇒ skip open_sweep_pr, prs [30, 33], ZERO agent tickets.
 *   mgfcwf   the same failure at cbe4965 with #6 and #7. ⇒ skip.
 *   xgf0dt   main HAD moved past #23's base, so there was real new dead code — but
 *            the sweep re-reported all three symbols #23 already removes, and the
 *            reviewer spent a round rejecting them. ⇒ proceed, stacked on #23,
 *            alreadyRemoved = the three symbols.
 *   p5ogpg   REGRESSION: no open sweep PR and main moved. This is the healthy case
 *            and it must be untouched — a preflight that skips this one has
 *            silently retired the flow.
 *
 * The route-level contract (a skip mints NO epic, NO tickets, NO workflow row) is
 * asserted through `shouldMintEpic`, which is the single branch route.ts takes.
 */

type Route = { status?: number; json?: unknown };

function ghStub(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    seen.push(path);
    // LONGEST match, not first: `/pulls/30` and `/pulls/30/files` are both routes.
    const key = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { status: 404, json: async () => ({ message: "Not Found" }) };
    const r = routes[key];
    return { status: r.status ?? 200, json: async () => r.json ?? null };
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const REPO = { owner: "tycenjmccann", repo: "agentcore-hub", defaultBranch: "main", token: "pat" };
const run = (routes: Record<string, Route>) => runSweepPreflight({ ...REPO, ...ghStub(routes) });

const pulls = (prs: unknown[]) => ({ "/repos/tycenjmccann/agentcore-hub/pulls?state=open": { json: prs } });
const commits = (sha: string) => ({ "/repos/tycenjmccann/agentcore-hub/commits/main": { json: { sha } } });
const files = (n: number, list: unknown[]) => ({
  [`/repos/tycenjmccann/agentcore-hub/pulls/${n}/files`]: { json: list },
});

const sweepPr = (number: number, baseSha: string, body = "") => ({
  number,
  html_url: `https://github.com/tycenjmccann/agentcore-hub/pull/${number}`,
  head: { ref: `chore/dead-code-sweep-${number}`, repo: { full_name: "tycenjmccann/agentcore-hub" } },
  base: { sha: baseSha, ref: "main" },
  body,
});

/**
 * TEAM-4752 D4 — the single-PR endpoint, which is where `mergeable` lives. Every
 * historical PR below WAS an ordinary open PR on main from a branch in this repo,
 * and GitHub reported all of them mergeable, so the replays must still reach the
 * same verdicts they did before viability was checked. `over` is how the one new
 * row (a CONFLICTING PR) diverges.
 */
const prDetail = (pr: { number: number }, over: Record<string, unknown> = {}) => ({
  [`/repos/tycenjmccann/agentcore-hub/pulls/${pr.number}`]: {
    json: { ...pr, draft: false, mergeable: true, ...over },
  },
});

describe("lpkxmt — two open sweep PRs on the base we were about to sweep", () => {
  const MAIN = "0760fcc1a2b3c4d5e6f708192a3b4c5d6e7f8091";
  const fixture = {
    ...commits(MAIN),
    ...pulls([sweepPr(30, MAIN), sweepPr(33, MAIN)]),
    ...prDetail(sweepPr(30, MAIN)),
    ...prDetail(sweepPr(33, MAIN)),
    ...files(30, [{ status: "removed", filename: "src/lib/legacy/formatter.ts" }]),
    ...files(33, [{ status: "removed", filename: "src/lib/legacy/formatter.ts" }]),
  };

  it("skips with open_sweep_pr and names BOTH open PRs", async () => {
    const pf = await run(fixture);
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [
        { number: 30, url: "https://github.com/tycenjmccann/agentcore-hub/pull/30", baseSha: MAIN, mergeable: true },
        { number: 33, url: "https://github.com/tycenjmccann/agentcore-hub/pull/33", baseSha: MAIN, mergeable: true },
      ],
      mainSha: MAIN,
    });
  });

  it("would NOT have skipped had #30 and #33 both been conflicting (TEAM-4752 D4)", async () => {
    // The counterfactual that makes the skip honest: two PRs at the right base SHA
    // that GitHub says cannot merge deliver nothing, so the sweep is the only thing
    // that can clear the dead code and it must run.
    const pf = await run({
      ...commits(MAIN),
      ...pulls([sweepPr(30, MAIN), sweepPr(33, MAIN)]),
      ...prDetail(sweepPr(30, MAIN), { mergeable: false }),
      ...prDetail(sweepPr(33, MAIN), { mergeable: false }),
      ...files(30, [{ status: "removed", filename: "src/lib/legacy/formatter.ts" }]),
      ...files(33, [{ status: "removed", filename: "src/lib/legacy/formatter.ts" }]),
    });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], mainSha: MAIN });
    expect(shouldMintEpic(pf)).toBe(true);
    // And the analyst is NOT told those paths are handled — they are not.
    expect(sweepPreflightNote(pf)).toBe("");
  });

  it("mints no epic — which is the 0-agent-ticket outcome the run should have had", async () => {
    const pf = await run(fixture);
    // route.ts returns { skipped: true } on exactly this predicate, before either
    // provider's createEpic. No epic ⇒ no tickets ⇒ no workflow row ⇒ no dispatch.
    expect(shouldMintEpic(pf)).toBe(false);
    // And nothing is appended to the analyst's prompt, because there is no analyst.
    expect(sweepPreflightNote(pf)).toBe("");
  });

  it("SR2-3 variant — #33 was rebased elsewhere; the re-verification comment must land on #30", async () => {
    // Same shape as the real run, except #33's base has moved off 0760fcc since it
    // opened. Both PRs are still viable and both are echoed, but only #30 is AT
    // main — so that is the only PR the skip comment may truthfully be posted on.
    const REBASED_BASE = "1111111111111111111111111111111111111111";
    const pf = await run({
      ...commits(MAIN),
      ...pulls([sweepPr(30, MAIN), sweepPr(33, REBASED_BASE)]),
      ...prDetail(sweepPr(30, MAIN)),
      ...prDetail(sweepPr(33, REBASED_BASE)),
      ...files(30, [{ status: "removed", filename: "src/lib/legacy/formatter.ts" }]),
      ...files(33, [{ status: "removed", filename: "src/lib/legacy/other.ts" }]),
    });
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [
        { number: 30, url: "https://github.com/tycenjmccann/agentcore-hub/pull/30", baseSha: MAIN, mergeable: true },
        {
          number: 33,
          url: "https://github.com/tycenjmccann/agentcore-hub/pull/33",
          baseSha: REBASED_BASE,
          mergeable: true,
        },
      ],
      mainSha: MAIN,
    });
    expect(pf.decision === "skip" && skipCommentTarget(pf)).toEqual({
      number: 30,
      url: "https://github.com/tycenjmccann/agentcore-hub/pull/30",
      baseSha: MAIN,
      mergeable: true,
    });
  });
});

describe("mgfcwf — the same failure a week earlier", () => {
  const MAIN = "cbe4965f0e1d2c3b4a59687778695a4b3c2d1e0f";

  it("skips at cbe4965 with #6 and #7", async () => {
    const pf = await run({
      ...commits(MAIN),
      ...pulls([sweepPr(6, MAIN), sweepPr(7, MAIN)]),
      ...prDetail(sweepPr(6, MAIN)),
      ...prDetail(sweepPr(7, MAIN)),
      ...files(6, [{ status: "removed", filename: "lambda/dead/handler.mjs" }]),
      ...files(7, [{ status: "removed", filename: "lambda/dead/handler.mjs" }]),
    });
    expect(pf.decision).toBe("skip");
    expect(pf.decision === "skip" && pf.reason).toBe("open_sweep_pr");
    expect(pf.decision === "skip" && pf.prs.map((p) => p.number)).toEqual([6, 7]);
    expect(shouldMintEpic(pf)).toBe(false);
  });
});

describe("xgf0dt — main moved, #23 still open", () => {
  const MAIN = "9f6a9e0dcc11223344556677889900aabbccddee";
  const BASE_23 = "4b1c2d3e4f5060718293a4b5c6d7e8f900112233";
  // #23's removals were three Python SYMBOLS inside files that survived, so the
  // files endpoint reports them as `modified`. The PR body's Removal Ledger is the
  // only place they exist — which is why the parser is not optional here.
  const LEDGER_BODY = [
    "Removes three unreferenced helpers found by vulture.",
    "",
    "## Removal Ledger",
    "- `_extract_json_array`",
    "- `_store_briefings` — last caller deleted in #19",
    "- `budget_map`",
    "",
    "## Testing",
    "- full pytest run",
  ].join("\n");
  const fixture = {
    ...commits(MAIN),
    ...prDetail(sweepPr(23, BASE_23, LEDGER_BODY)),
    ...pulls([
      sweepPr(23, BASE_23, LEDGER_BODY),
      // A live feature PR on the same base: not a sweep branch, never probed.
      { number: 24, html_url: "u24", head: { ref: "feature/TEAM-4700-thing" }, base: { sha: MAIN } },
    ]),
    ...files(23, [
      { status: "modified", filename: "deploy/runtime-agent/main.py" },
      { status: "modified", filename: "lambda/orchestrator/index.mjs" },
    ]),
  };

  it("proceeds, stacked on #23, carrying the three symbols it already removes", async () => {
    const pf = await run(fixture);
    expect(pf).toEqual({
      decision: "proceed",
      alreadyRemoved: ["_extract_json_array", "_store_briefings", "budget_map"],
      stackedOn: { number: 23, url: "https://github.com/tycenjmccann/agentcore-hub/pull/23" },
      mainSha: MAIN,
    });
    expect(shouldMintEpic(pf)).toBe(true);
  });

  it("hands the analyst a do-not-re-report list in its own prompt", async () => {
    const note = sweepPreflightNote(await run(fixture));
    expect(note).toContain("## Sweep preflight");
    expect(note).toContain("Stacked on open PR #23");
    expect(note).toContain("do NOT re-report");
    for (const sym of ["_extract_json_array", "_store_briefings", "budget_map"]) {
      expect(note).toContain(`- ${sym}`);
    }
  });
});

describe("REGRESSION p5ogpg — a healthy sweep is untouched", () => {
  it("proceeds with an empty alreadyRemoved and an unchanged prompt", async () => {
    const MAIN = "7a8b9c0d1e2f3041526374859607182930a4b5c6";
    const pf = await run({
      ...commits(MAIN),
      // Only non-sweep PRs are open.
      ...pulls([{ number: 41, html_url: "u41", head: { ref: "feature/TEAM-4740-api-dev" }, base: { sha: MAIN } }]),
    });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], mainSha: MAIN });
    expect(shouldMintEpic(pf)).toBe(true);
    // The prompt the sweeper receives is byte-identical to the pre-FR-9 one.
    expect(sweepPreflightNote(pf)).toBe("");
  });
});

describe("the def opts in", () => {
  it("dead-code-sweep carries preflight:\"sweep\" and ledgerCommit:false", () => {
    // The gate in route.ts is `def.preflight === "sweep"`, never `def.id` — so
    // this flag is the ONLY thing that turns the preflight on. If it is dropped,
    // every fixture above becomes dead code.
    const defs = (workflowsConfig as { workflows: Record<string, unknown>[] }).workflows;
    const sweep = defs.find((d) => d.id === "dead-code-sweep");
    expect(sweep).toBeDefined();
    expect(sweep!.preflight).toBe("sweep");
    expect(sweep!.ledgerCommit).toBe(false);
    // No other def opts in yet — a preflight that fired on software-delivery
    // would cancel real runs.
    expect(defs.filter((d) => d.preflight === "sweep").map((d) => d.id)).toEqual(["dead-code-sweep"]);
  });
});
