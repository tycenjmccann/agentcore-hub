import { describe, it, expect } from "vitest";
import {
  SWEEP_HEAD_PATTERNS,
  isSweepHead,
  decideSweepPreflight,
  isViableSweepPr,
  runSweepPreflight,
  commentOnSweepPr,
  sweepSkipCommentBody,
  parseRemovalLedger,
  shouldMintEpic,
  sweepPreflightNote,
  preflightRowField,
  skipCommentTarget,
} from "./sweep-preflight";

/**
 * TEAM-4740 FR-9 — the sweep preflight's decision matrix.
 *
 * The whole point of this module is that it can CANCEL a run before it starts, so
 * the two directions are not symmetric: a wrong `proceed` costs a redundant sweep,
 * a wrong `skip` silently retires a scheduled flow. Every probe failure below is
 * therefore asserted to PROCEED, and `probeFailed` is asserted to be visible so
 * "we proceeded because we could not look" is distinguishable in the record from
 * "we proceeded because there was work".
 *
 * `fetchImpl` is injected everywhere — no network, no token, no AWS.
 */

type DecideInput = Parameters<typeof decideSweepPreflight>[0];

/** A PR that IS viable, so each row below overrides exactly the one fact it tests. */
const PR = (over: Partial<DecideInput["openSweepPrs"][number]> = {}) => ({
  number: 30,
  url: "https://github.com/o/r/pull/30",
  headRef: "chore/dead-code-sweep-2026-09-01",
  baseSha: "aaa111",
  deletedPaths: [] as string[],
  baseRef: "main",
  draft: false,
  headRepoFullName: "o/r",
  mergeable: true as boolean | null,
  ...over,
});

/** TEAM-4752 D4: viability is judged against repo facts, which are now inputs. */
const REPO_FACTS = { defaultBranch: "main", repoFullName: "o/r" };
const decide = (
  input: Omit<DecideInput, "defaultBranch" | "repoFullName"> &
    Partial<Pick<DecideInput, "defaultBranch" | "repoFullName">>
) => decideSweepPreflight({ ...REPO_FACTS, ...input });

describe("SWEEP_HEAD_PATTERNS / isSweepHead", () => {
  it("matches the three branch shapes a sweep actually pushes", () => {
    expect(isSweepHead("feature/TEAM-4634-dead-code-sweep-round-2")).toBe(true);
    expect(isSweepHead("chore/dead-code-sweep-2026-09-01")).toBe(true);
    expect(isSweepHead("sweep/2026-09")).toBe(true);
    expect(SWEEP_HEAD_PATTERNS).toHaveLength(3);
  });

  it("ignores a human branch that merely mentions sweeping", () => {
    // The reason the patterns are an explicit list rather than /sweep/: this
    // branch making a scheduled run skip itself would be silent and permanent.
    for (const ref of ["fix/sweep-the-logs", "main", "feature/TEAM-1-dead-code", "feature/dead-code-sweep"]) {
      expect(isSweepHead(ref), ref).toBe(false);
    }
  });
});

describe("decideSweepPreflight — the four rows", () => {
  it("open sweep PR based on the CURRENT main ⇒ skip open_sweep_pr, echoing every match", () => {
    const d = decide({
      mainSha: "aaa111",
      openSweepPrs: [PR({ number: 30 }), PR({ number: 33, url: "https://github.com/o/r/pull/33" })],
    });
    expect(d).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [
        { number: 30, url: "https://github.com/o/r/pull/30", baseSha: "aaa111", mergeable: true },
        { number: 33, url: "https://github.com/o/r/pull/33", baseSha: "aaa111", mergeable: true },
      ],
    });
  });

  it("no open sweep PR and main unmoved ⇒ skip unchanged_main with no prs", () => {
    expect(decide({ mainSha: "aaa111", openSweepPrs: [], lastSweepBaseSha: "aaa111" })).toEqual({
      decision: "skip",
      reason: "unchanged_main",
      prs: [],
    });
  });

  it("open sweep PR(s) and main MOVED ⇒ proceed, carrying what they already delete", () => {
    const d = decide({
      mainSha: "bbb222",
      openSweepPrs: [
        PR({ number: 30, deletedPaths: ["src/b.ts", "src/a.ts"] }),
        PR({ number: 33, url: "https://github.com/o/r/pull/33", deletedPaths: ["src/a.ts", "src/c.ts"] }),
      ],
    });
    expect(d).toEqual({
      decision: "proceed",
      // Union, deduped, sorted — a stable list is what makes the description
      // block byte-stable across retries of the same submission.
      alreadyRemoved: ["src/a.ts", "src/b.ts", "src/c.ts"],
      stackedOn: { number: 33, url: "https://github.com/o/r/pull/33" },
    });
  });

  it("nothing open and main moved ⇒ plain proceed with an empty list", () => {
    expect(decide({ mainSha: "bbb222", openSweepPrs: [], lastSweepBaseSha: "aaa111" })).toEqual({
      decision: "proceed",
      alreadyRemoved: [],
    });
  });

  it("an unknown last base is not treated as a match", () => {
    // lastSweepBaseSha is NOT derivable with a bounded query today, so undefined
    // is the normal case — it must never coerce into "unchanged".
    for (const last of [undefined, null, ""]) {
      expect(decide({ mainSha: "aaa111", openSweepPrs: [], lastSweepBaseSha: last })).toEqual({
        decision: "proceed",
        alreadyRemoved: [],
      });
    }
  });

  it("a non-sweep open PR at main is not a reason to skip", () => {
    const d = decide({
      mainSha: "aaa111",
      openSweepPrs: [PR({ headRef: "fix/sweep-the-logs" })],
      lastSweepBaseSha: "zzz",
    });
    expect(d).toEqual({ decision: "proceed", alreadyRemoved: [] });
  });
});

// ─── TEAM-4752 D4: viability ───────────────────────────────────────────────────

/**
 * A skip cancels the run outright, and its justification is "an open PR already
 * delivers this diff". `baseSha === mainSha` says only that the PR STARTED from the
 * commit we would sweep — it says nothing about whether the PR can ever land. So
 * every row here is a PR sitting exactly at main HEAD, differing in one fact, and
 * the question is whether that fact makes the skip a lie.
 */
describe("isViableSweepPr — one definite negative per clause", () => {
  const rows: Array<[string, Partial<DecideInput["openSweepPrs"][number]>, boolean]> = [
    ["the ordinary case", {}, true],
    ["mergeable is null (GitHub has not computed it YET)", { mergeable: null }, true],
    ["CONFLICTING", { mergeable: false }, false],
    ["a draft — GitHub does not offer it for merge", { draft: true }, false],
    ["targeting a release branch, not main", { baseRef: "release/2026-09" }, false],
    ["no base ref at all (GitHub omitted it)", { baseRef: "" }, false],
    ["opened from a fork", { headRepoFullName: "someone-else/agentcore-hub" }, false],
    ["head repo unknown (fork deleted)", { headRepoFullName: "" }, false],
  ];

  it.each(rows)("%s ⇒ viable=%o", (_label, over, expected) => {
    expect(isViableSweepPr(PR(over), REPO_FACTS)).toBe(expected);
  });

  it("is false when the repo facts themselves are unknown", () => {
    // An empty defaultBranch would otherwise match a PR whose baseRef is also
    // empty, i.e. two unknowns agreeing into a licence to cancel a run.
    expect(isViableSweepPr(PR({ baseRef: "" }), { defaultBranch: "", repoFullName: "o/r" })).toBe(false);
    expect(isViableSweepPr(PR({ headRepoFullName: "" }), { defaultBranch: "main", repoFullName: "" })).toBe(false);
  });
});

describe("decideSweepPreflight — only a PR that could LAND justifies a skip (D4)", () => {
  const NOT_VIABLE: Array<[string, Partial<DecideInput["openSweepPrs"][number]>]> = [
    ["CONFLICTING", { mergeable: false }],
    ["a draft", { draft: true }],
    ["based on main but targeting another branch", { baseRef: "release/2026-09" }],
    ["from a fork", { headRepoFullName: "fork/agentcore-hub" }],
  ];

  it.each(NOT_VIABLE)("proceeds when the only PR at main HEAD is %s", (_label, over) => {
    const d = decide({
      mainSha: "aaa111",
      openSweepPrs: [PR({ number: 30, deletedPaths: ["src/gone.ts"], ...over })],
    });
    // Proceed, AND with nothing suppressed: `alreadyRemoved` means "do not
    // re-report, that PR handles it" — which is exactly what this PR cannot do.
    expect(d).toEqual({ decision: "proceed", alreadyRemoved: [] });
  });

  it.each([true, null] as Array<boolean | null>)("skips on a PR at main HEAD whose mergeable is %o", (mergeable) => {
    const d = decide({ mainSha: "aaa111", openSweepPrs: [PR({ number: 30, mergeable })] });
    expect(d).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      // The observed value travels with the echo, so the caller's comment can say
      // "not yet computed" instead of asserting "still mergeable".
      prs: [{ number: 30, url: "https://github.com/o/r/pull/30", baseSha: "aaa111", mergeable }],
    });
  });

  it("a viable PR at main HEAD still skips even when an unmergeable sibling is open", () => {
    const d = decide({
      mainSha: "aaa111",
      openSweepPrs: [PR({ number: 30, mergeable: false }), PR({ number: 33, url: "u33" })],
    });
    // Only the viable one is echoed — a human sent to look must be sent to the PR
    // that can actually be merged.
    expect(d).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [{ number: 33, url: "u33", baseSha: "aaa111", mergeable: true }],
    });
  });

  it("stackedOn and alreadyRemoved skip over the unmergeable newest PR", () => {
    // #33 is newer, so pre-D4 the run would have been told it was stacked on a PR
    // that can never merge, and told not to re-report the paths only #33 deletes.
    const d = decide({
      mainSha: "bbb222",
      openSweepPrs: [
        PR({ number: 30, url: "u30", deletedPaths: ["src/a.ts"] }),
        PR({ number: 33, url: "u33", mergeable: false, deletedPaths: ["src/never-lands.ts"] }),
      ],
    });
    expect(d).toEqual({
      decision: "proceed",
      alreadyRemoved: ["src/a.ts"],
      stackedOn: { number: 30, url: "u30" },
    });
  });

  it("an unmergeable open sweep PR still blocks the unchanged_main skip", () => {
    // Deliberately asymmetric: `unchanged_main` says "the last sweep already
    // answered this SHA". An open-but-conflicting sweep PR is evidence the last
    // sweep's answer is UNDELIVERED, so this is the run that should look again.
    const d = decide({
      mainSha: "aaa111",
      openSweepPrs: [PR({ number: 30, mergeable: false })],
      lastSweepBaseSha: "aaa111",
    });
    expect(d).toEqual({ decision: "proceed", alreadyRemoved: [] });
  });
});

describe("parseRemovalLedger", () => {
  it("reads the bulleted identifiers under a Removal Ledger heading", () => {
    expect(
      parseRemovalLedger(
        [
          "Removes three unreferenced helpers.",
          "",
          "## Removal Ledger",
          "- `_extract_json_array`",
          "- `_store_briefings` — last caller deleted in #19",
          "* budget_map",
          "",
          "## Testing",
          "- `test_nothing_else_broke`",
        ].join("\n")
      )
    ).toEqual(["_extract_json_array", "_store_briefings", "budget_map"]);
  });

  it("yields nothing for a body with no ledger, and never throws on junk", () => {
    expect(parseRemovalLedger("- `orphan`")).toEqual([]);
    expect(parseRemovalLedger(null)).toEqual([]);
    expect(parseRemovalLedger(undefined)).toEqual([]);
    expect(parseRemovalLedger("## Removal Ledger\n\nnothing bulleted here")).toEqual([]);
  });
});

// ─── runSweepPreflight (injected fetch) ───────────────────────────────────────

type Route = { status?: number; json?: unknown };

/**
 * A fake GitHub keyed on the path prefix, recording every URL it was asked for.
 * LONGEST key wins: `/pulls/30` and `/pulls/30/files` are now both real routes, and
 * a first-match stub would answer the files read with the PR detail body.
 */
function ghStub(routes: Record<string, Route | (() => Route)>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    seen.push(path);
    const key = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { status: 404, json: async () => ({ message: "Not Found" }) };
    const r = typeof routes[key] === "function" ? (routes[key] as () => Route)() : (routes[key] as Route);
    return { status: r.status ?? 200, json: async () => r.json ?? null };
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const BASE = { owner: "o", repo: "r", defaultBranch: "main", token: "t" };

/** The viability fields the single-PR endpoint is fetched for (TEAM-4752 D4). */
const LANDABLE = { base: { ref: "main" }, draft: false, head: { repo: { full_name: "o/r" } }, mergeable: true };
/** GitHub's PR-detail body: the list fields plus the viability ones. */
const detail = (pr: Record<string, unknown>) => ({
  ...pr,
  ...LANDABLE,
  base: { ...(pr.base as object), ...LANDABLE.base },
  head: { ...(pr.head as object), ...LANDABLE.head },
});

// ─── SR2-1/SR2-2 pagination fixtures ───────────────────────────────────────────

/** A FULL page (50) of non-sweep PRs, so a real sweep PR on the next page is the
 *  only reason the preflight would keep reading. */
const nonSweepPr = (n: number) => ({
  number: n,
  html_url: `u${n}`,
  head: { ref: `feature/TEAM-${n}-thing` },
  base: { sha: "aaa111" },
});
const fullListPage = (from: number) => Array.from({ length: 50 }, (_, i) => nonSweepPr(from + i));
/** `count` "removed" files, named so page boundaries are visible in a failure diff. */
const removedFiles = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ status: "removed", filename: `src/gone-${from + i}.ts` }));

describe("runSweepPreflight", () => {
  it("probes main, the open PRs and each sweep PR's detail + files — and nothing else", async () => {
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" }, body: "" };
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": {
        json: [
          pr30,
          { number: 31, html_url: "u31", head: { ref: "feature/TEAM-1-thing" }, base: { sha: "aaa111" }, body: "" },
        ],
      },
      "/repos/o/r/pulls/30/files": { json: [{ status: "removed", filename: "src/gone.ts" }] },
      "/repos/o/r/pulls/30": { json: detail(pr30) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [{ number: 30, url: "u30", baseSha: "aaa111", mergeable: true }],
      mainSha: "aaa111",
    });
    // The exact call set: #31 is not a sweep branch, so neither its detail nor its
    // files are ever fetched — the preflight must not walk every open PR.
    expect(seen).toEqual([
      "/repos/o/r/commits/main",
      "/repos/o/r/pulls?state=open&per_page=50&page=1",
      "/repos/o/r/pulls/30",
      "/repos/o/r/pulls/30/files?per_page=100&page=1",
    ]);
  });

  // ─── SR2-1: the open-PR list is paginated ─────────────────────────────────
  it("paginates the open-PR list to find an OLD open sweep PR past page 1", async () => {
    // GitHub sorts open PRs newest-first, so an old sweep PR sitting exactly at
    // main HEAD is invisible to a single-page read once 50+ other PRs are open.
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" }, body: "" };
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open&per_page=50&page=1": { json: fullListPage(1) },
      "/repos/o/r/pulls?state=open&per_page=50&page=2": { json: [pr30] },
      "/repos/o/r/pulls/30": { json: detail(pr30) },
      "/repos/o/r/pulls/30/files": { json: [{ status: "removed", filename: "src/gone.ts" }] },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [{ number: 30, url: "u30", baseSha: "aaa111", mergeable: true }],
      mainSha: "aaa111",
    });
    expect(seen).toContain("/repos/o/r/pulls?state=open&per_page=50&page=1");
    expect(seen).toContain("/repos/o/r/pulls?state=open&per_page=50&page=2");
    expect(seen.some((u) => u.includes("page=3"))).toBe(false);
  });

  // ─── SR2-2: a sweep PR's files list is paginated ──────────────────────────
  it("paginates a sweep PR's changed-files list across pages", async () => {
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" }, body: "" };
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "bbb222" } },
      "/repos/o/r/pulls?state=open": { json: [pr30] },
      "/repos/o/r/pulls/30": { json: detail(pr30) },
      "/repos/o/r/pulls/30/files?per_page=100&page=1": { json: removedFiles(1, 100) },
      "/repos/o/r/pulls/30/files?per_page=100&page=2": { json: removedFiles(101, 2) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf.decision).toBe("proceed");
    const alreadyRemoved = pf.decision === "proceed" ? pf.alreadyRemoved : [];
    expect(alreadyRemoved).toHaveLength(102);
    expect(alreadyRemoved).toContain("src/gone-1.ts");
    expect(alreadyRemoved).toContain("src/gone-101.ts");
    expect(seen).toContain("/repos/o/r/pulls/30/files?per_page=100&page=1");
    expect(seen).toContain("/repos/o/r/pulls/30/files?per_page=100&page=2");
  });

  it("open-PR list pagination cap ⇒ fails open without requesting an 11th page", async () => {
    // Every page comes back FULL (50 items) forever, so the probe can never
    // conclude it has seen the whole list. Ten pages in, it must give up rather
    // than report a truncated list as though it were complete.
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: fullListPage(1) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], probeFailed: true, mainSha: null });
    const listPages = seen.filter((u) => u.startsWith("/repos/o/r/pulls?state=open"));
    expect(listPages).toHaveLength(10);
    expect(listPages.some((u) => u.includes("page=11"))).toBe(false);
  });

  it("PR files-list pagination cap ⇒ fails open without requesting an 11th page", async () => {
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" }, body: "" };
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [pr30] },
      "/repos/o/r/pulls/30": { json: detail(pr30) },
      "/repos/o/r/pulls/30/files": { json: removedFiles(1, 100) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], probeFailed: true, mainSha: null });
    const filesPages = seen.filter((u) => u.startsWith("/repos/o/r/pulls/30/files"));
    expect(filesPages).toHaveLength(10);
    expect(filesPages.some((u) => u.includes("page=11"))).toBe(false);
  });

  it("collects removed paths AND ledger symbols into deletedPaths", async () => {
    const pr23 = {
      number: 23,
      html_url: "u23",
      head: { ref: "chore/dead-code-sweep-x" },
      base: { sha: "aaa111" },
      body: "## Removal Ledger\n- `helper_one`",
    };
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "bbb222" } },
      "/repos/o/r/pulls?state=open": { json: [pr23] },
      "/repos/o/r/pulls/23/files": { json: [{ status: "removed", filename: "src/x.ts" }, { status: "modified", filename: "src/y.ts" }] },
      "/repos/o/r/pulls/23": { json: detail(pr23) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({
      decision: "proceed",
      alreadyRemoved: ["helper_one", "src/x.ts"],
      stackedOn: { number: 23, url: "u23" },
      mainSha: "bbb222",
    });
  });

  it("falls back to a derived PR url when GitHub omits html_url", async () => {
    const pr7 = { number: 7, head: { ref: "sweep/a" }, base: { sha: "aaa111" } };
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [pr7] },
      "/repos/o/r/pulls/7/files": { json: [] },
      "/repos/o/r/pulls/7": { json: detail(pr7) },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf.decision === "skip" && pf.prs[0].url).toBe("https://github.com/o/r/pull/7");
  });

  it("reads viability from the PR DETAIL, which is the only endpoint that has it", async () => {
    // The list body says nothing about mergeability — GitHub computes it per PR. So
    // a CONFLICTING PR looks identical to a clean one until the detail call, and
    // without that call the run gets cancelled in favour of a PR that cannot merge.
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" } };
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [pr30] },
      "/repos/o/r/pulls/30/files": { json: [{ status: "removed", filename: "src/gone.ts" }] },
      "/repos/o/r/pulls/30": { json: { ...detail(pr30), mergeable: false } },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], mainSha: "aaa111" });
    expect(seen).toContain("/repos/o/r/pulls/30");
  });

  it("treats a detail body with no mergeable field as 'not yet computed', and skips", async () => {
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" } };
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [pr30] },
      "/repos/o/r/pulls/30/files": { json: [] },
      "/repos/o/r/pulls/30": { json: { ...detail(pr30), mergeable: undefined } },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [{ number: 30, url: "u30", baseSha: "aaa111", mergeable: null }],
      mainSha: "aaa111",
    });
  });

  it("does not skip for a fork's PR, however perfectly based", async () => {
    const pr30 = { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" } };
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [pr30] },
      "/repos/o/r/pulls/30/files": { json: [] },
      "/repos/o/r/pulls/30": { json: { ...detail(pr30), head: { ref: "sweep/2026-09", repo: { full_name: "fork/r" } } } },
    });
    expect(await runSweepPreflight({ ...BASE, fetchImpl })).toEqual({
      decision: "proceed",
      alreadyRemoved: [],
      mainSha: "aaa111",
    });
  });

  it.each([
    ["the main-HEAD read 404s", { "/repos/o/r/commits/main": { status: 404, json: { message: "Not Found" } } }],
    ["main comes back with no sha", { "/repos/o/r/commits/main": { json: {} } }],
    [
      "the PR list is rate-limited",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { status: 403, json: { message: "rate limit" } },
      },
    ],
    [
      "the PR list is not an array",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { json: { message: "nope" } },
      },
    ],
    [
      // SR2-1: the FIRST page reads fine — it is the SECOND page that fails, so a
      // helper that only checked page 1's status would miss this.
      "the PR list's second page is rate-limited",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open&per_page=50&page=1": { json: fullListPage(1) },
        "/repos/o/r/pulls?state=open&per_page=50&page=2": { status: 403, json: { message: "rate limit" } },
      },
    ],
    [
      "a per-PR files read fails",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { json: [{ number: 30, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }] },
        "/repos/o/r/pulls/30": { json: detail({ number: 30, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }) },
        "/repos/o/r/pulls/30/files": { status: 500, json: null },
      },
    ],
    [
      // TEAM-4752 D4: the new probe fails the same way as every other one. It must
      // not fail CLOSED into a skip, and it must not silently degrade into "assume
      // viable" either — an unread detail is an unknown, and unknowns proceed.
      "the per-PR detail read is rate-limited",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { json: [{ number: 30, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }] },
        "/repos/o/r/pulls/30": { status: 403, json: { message: "rate limit" } },
      },
    ],
    [
      "the per-PR detail body is not an object",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { json: [{ number: 30, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }] },
        "/repos/o/r/pulls/30": { json: null },
      },
    ],
  ])("FAILS OPEN when %s", async (_label, routes) => {
    const { fetchImpl } = ghStub(routes as Record<string, Route>);
    // Note the shape: even the first case, where an open PR at main WOULD have
    // skipped, proceeds. A skip needs positive evidence (DL-028).
    expect(await runSweepPreflight({ ...BASE, fetchImpl })).toEqual({
      decision: "proceed",
      alreadyRemoved: [],
      probeFailed: true,
      mainSha: null,
    });
  });

  it("FAILS OPEN when fetch itself throws (timeout / DNS)", async () => {
    const fetchImpl = (async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as unknown as typeof fetch;
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({ decision: "proceed", alreadyRemoved: [], probeFailed: true, mainSha: null });
  });

  it("FAILS OPEN without probing at all when the repo is unresolved", async () => {
    const { fetchImpl, seen } = ghStub({});
    const pf = await runSweepPreflight({ owner: "", repo: "r", defaultBranch: "main", fetchImpl });
    expect(pf.decision).toBe("proceed");
    expect(seen).toEqual([]);
  });

  it("sends the repo-check header set, so there is one GitHub client and not two", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return { status: 200, json: async () => ({ sha: "aaa111" }) };
    }) as unknown as typeof fetch;
    await runSweepPreflight({ ...BASE, fetchImpl });
    expect(calls[0].headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer t",
    });
  });
});

describe("sweepSkipCommentBody — the comment says only what was observed (D4)", () => {
  // This comment is the ONE artefact a skip leaves a human, and it used to end
  // "still mergeable" whatever GitHub said. The `true` row is pinned byte-for-byte
  // because that sentence exists in already-merged PR histories.
  it("mergeable: true keeps today's wording, byte for byte", () => {
    expect(sweepSkipCommentBody({ mainSha: "aaa111", date: "2026-09-17", mergeable: true })).toBe(
      "re-verified against main @aaa111 on 2026-09-17; still mergeable"
    );
  });

  it("mergeable: null discloses the unknown instead of asserting it away", () => {
    expect(sweepSkipCommentBody({ mainSha: "aaa111", date: "2026-09-17", mergeable: null })).toBe(
      "re-verified against main @aaa111 on 2026-09-17; mergeability not yet computed by GitHub"
    );
    // Absent behaves as null — a caller that forgets the field cannot make the
    // function claim mergeability.
    expect(sweepSkipCommentBody({ mainSha: "aaa111", date: "2026-09-17", mergeable: undefined })).toBe(
      "re-verified against main @aaa111 on 2026-09-17; mergeability not yet computed by GitHub"
    );
  });

  it("mergeable: false says CONFLICTING", () => {
    // Unreachable from the skip arm (D4 makes such a PR proceed), but the function
    // cannot be allowed to lie if a future caller passes it.
    expect(sweepSkipCommentBody({ mainSha: "aaa111", date: "2026-09-17", mergeable: false })).toBe(
      "re-verified against main @aaa111 on 2026-09-17; GitHub reports it as CONFLICTING"
    );
  });
});

describe("commentOnSweepPr", () => {
  it("posts exactly one comment with the re-verification wording", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: 201, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ok = await commentOnSweepPr({
      ...BASE,
      number: 33,
      fetchImpl,
      mainSha: "aaa111",
      date: "2026-09-17",
      mergeable: true,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/33/comments");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      body: "re-verified against main @aaa111 on 2026-09-17; still mergeable",
    });
  });

  it("carries the mergeability state into the posted body", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).body);
      return { status: 201, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await commentOnSweepPr({ ...BASE, number: 33, fetchImpl, mainSha: "aaa111", date: "d", mergeable: null });
    expect(bodies[0]).toBe("re-verified against main @aaa111 on d; mergeability not yet computed by GitHub");
  });

  it("never throws — a skip that could not comment is still a correct skip", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await commentOnSweepPr({ ...BASE, number: 1, fetchImpl: boom, mainSha: "a", date: "d" })).toBe(false);
    const forbidden = (async () => ({ status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await commentOnSweepPr({ ...BASE, number: 1, fetchImpl: forbidden, mainSha: "a", date: "d" })).toBe(false);
  });
});

// ─── Route helpers ────────────────────────────────────────────────────────────

describe("route helpers", () => {
  it("shouldMintEpic is false for BOTH skip reasons and true otherwise", () => {
    expect(shouldMintEpic({ decision: "skip", reason: "open_sweep_pr", prs: [] })).toBe(false);
    expect(shouldMintEpic({ decision: "skip", reason: "unchanged_main", prs: [] })).toBe(false);
    expect(shouldMintEpic({ decision: "proceed", alreadyRemoved: [] })).toBe(true);
    expect(shouldMintEpic({ decision: "proceed", alreadyRemoved: [], probeFailed: true })).toBe(true);
  });

  it("skipCommentTarget picks the newest PR that is actually AT mainSha (SR2-3)", () => {
    // #30 is the only one at main; taking the highest PR NUMBER out of `prs` would
    // have picked #33, whose baseSha the comment's claim would then be false about.
    expect(
      skipCommentTarget({
        decision: "skip",
        reason: "open_sweep_pr",
        prs: [
          { number: 30, url: "u30", baseSha: "aaa111", mergeable: true },
          { number: 33, url: "u33", baseSha: "ccc333", mergeable: true },
        ],
        mainSha: "aaa111",
      })
    ).toEqual({ number: 30, url: "u30", baseSha: "aaa111", mergeable: true });

    // Both at main ⇒ the newest of the matching ones, same as before.
    expect(
      skipCommentTarget({
        decision: "skip",
        reason: "open_sweep_pr",
        prs: [
          { number: 30, url: "u30", baseSha: "aaa111", mergeable: true },
          { number: 33, url: "u33", baseSha: "aaa111", mergeable: true },
        ],
        mainSha: "aaa111",
      })
    ).toEqual({ number: 33, url: "u33", baseSha: "aaa111", mergeable: true });

    // No known main SHA ⇒ no PR to truthfully claim re-verification against.
    expect(
      skipCommentTarget({
        decision: "skip",
        reason: "open_sweep_pr",
        prs: [{ number: 30, url: "u30", baseSha: "aaa111", mergeable: true }],
        mainSha: null,
      })
    ).toBeUndefined();

    // unchanged_main's empty echo ⇒ nothing to comment on either.
    expect(
      skipCommentTarget({ decision: "skip", reason: "unchanged_main", prs: [], mainSha: "aaa111" })
    ).toBeUndefined();
  });

  it("renders the delimited alreadyRemoved block the analyst reads", () => {
    expect(
      sweepPreflightNote({
        decision: "proceed",
        alreadyRemoved: ["_extract_json_array", "budget_map"],
        stackedOn: { number: 23, url: "https://github.com/o/r/pull/23" },
      })
    ).toBe(
      "\n\n## Sweep preflight\n" +
        "Stacked on open PR #23 (https://github.com/o/r/pull/23). alreadyRemoved (already deleted by that PR — do NOT re-report):\n" +
        "- _extract_json_array\n- budget_map"
    );
  });

  it("renders NOTHING when there is nothing to warn about", () => {
    // An ordinary sweep's prompt must be byte-identical to the pre-FR-9 one.
    expect(sweepPreflightNote({ decision: "proceed", alreadyRemoved: [] })).toBe("");
    expect(sweepPreflightNote({ decision: "skip", reason: "open_sweep_pr", prs: [] })).toBe("");
  });

  it("persists a row field that omits stackedOn when there is none", () => {
    expect(preflightRowField({ decision: "proceed", alreadyRemoved: [], mainSha: "aaa111" })).toEqual({
      decision: "proceed",
      alreadyRemoved: [],
      mainSha: "aaa111",
    });
    expect(
      preflightRowField({
        decision: "proceed",
        alreadyRemoved: ["src/x.ts"],
        stackedOn: { number: 23, url: "u23" },
        mainSha: "bbb222",
      })
    ).toEqual({
      decision: "proceed",
      alreadyRemoved: ["src/x.ts"],
      stackedOn: { number: 23, url: "u23" },
      mainSha: "bbb222",
    });
  });
});
