import { describe, it, expect } from "vitest";
import {
  SWEEP_HEAD_PATTERNS,
  isSweepHead,
  decideSweepPreflight,
  runSweepPreflight,
  commentOnSweepPr,
  parseRemovalLedger,
  shouldMintEpic,
  sweepPreflightNote,
  preflightRowField,
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

const PR = (over: Partial<Parameters<typeof decideSweepPreflight>[0]["openSweepPrs"][number]> = {}) => ({
  number: 30,
  url: "https://github.com/o/r/pull/30",
  headRef: "chore/dead-code-sweep-2026-09-01",
  baseSha: "aaa111",
  deletedPaths: [] as string[],
  ...over,
});

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
    const d = decideSweepPreflight({
      mainSha: "aaa111",
      openSweepPrs: [PR({ number: 30 }), PR({ number: 33, url: "https://github.com/o/r/pull/33" })],
    });
    expect(d).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [
        { number: 30, url: "https://github.com/o/r/pull/30", baseSha: "aaa111" },
        { number: 33, url: "https://github.com/o/r/pull/33", baseSha: "aaa111" },
      ],
    });
  });

  it("no open sweep PR and main unmoved ⇒ skip unchanged_main with no prs", () => {
    expect(decideSweepPreflight({ mainSha: "aaa111", openSweepPrs: [], lastSweepBaseSha: "aaa111" })).toEqual({
      decision: "skip",
      reason: "unchanged_main",
      prs: [],
    });
  });

  it("open sweep PR(s) and main MOVED ⇒ proceed, carrying what they already delete", () => {
    const d = decideSweepPreflight({
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
    expect(decideSweepPreflight({ mainSha: "bbb222", openSweepPrs: [], lastSweepBaseSha: "aaa111" })).toEqual({
      decision: "proceed",
      alreadyRemoved: [],
    });
  });

  it("an unknown last base is not treated as a match", () => {
    // lastSweepBaseSha is NOT derivable with a bounded query today, so undefined
    // is the normal case — it must never coerce into "unchanged".
    for (const last of [undefined, null, ""]) {
      expect(decideSweepPreflight({ mainSha: "aaa111", openSweepPrs: [], lastSweepBaseSha: last })).toEqual({
        decision: "proceed",
        alreadyRemoved: [],
      });
    }
  });

  it("a non-sweep open PR at main is not a reason to skip", () => {
    const d = decideSweepPreflight({
      mainSha: "aaa111",
      openSweepPrs: [PR({ headRef: "fix/sweep-the-logs" })],
      lastSweepBaseSha: "zzz",
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

/** A fake GitHub keyed on the path suffix, recording every URL it was asked for. */
function ghStub(routes: Record<string, Route | (() => Route)>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    seen.push(path);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return { status: 404, json: async () => ({ message: "Not Found" }) };
    const r = typeof routes[key] === "function" ? (routes[key] as () => Route)() : (routes[key] as Route);
    return { status: r.status ?? 200, json: async () => r.json ?? null };
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const BASE = { owner: "o", repo: "r", defaultBranch: "main", token: "t" };

describe("runSweepPreflight", () => {
  it("probes main, the open PRs and each sweep PR's files — and nothing else", async () => {
    const { fetchImpl, seen } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": {
        json: [
          { number: 30, html_url: "u30", head: { ref: "sweep/2026-09" }, base: { sha: "aaa111" }, body: "" },
          { number: 31, html_url: "u31", head: { ref: "feature/TEAM-1-thing" }, base: { sha: "aaa111" }, body: "" },
        ],
      },
      "/repos/o/r/pulls/30/files": { json: [{ status: "removed", filename: "src/gone.ts" }] },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf).toEqual({
      decision: "skip",
      reason: "open_sweep_pr",
      prs: [{ number: 30, url: "u30", baseSha: "aaa111" }],
      mainSha: "aaa111",
    });
    // #31 is not a sweep branch, so its files are never fetched.
    expect(seen.filter((p) => p.includes("/files"))).toEqual(["/repos/o/r/pulls/30/files?per_page=100"]);
  });

  it("collects removed paths AND ledger symbols into deletedPaths", async () => {
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "bbb222" } },
      "/repos/o/r/pulls?state=open": {
        json: [
          {
            number: 23,
            html_url: "u23",
            head: { ref: "chore/dead-code-sweep-x" },
            base: { sha: "aaa111" },
            body: "## Removal Ledger\n- `helper_one`",
          },
        ],
      },
      "/repos/o/r/pulls/23/files": { json: [{ status: "removed", filename: "src/x.ts" }, { status: "modified", filename: "src/y.ts" }] },
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
    const { fetchImpl } = ghStub({
      "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
      "/repos/o/r/pulls?state=open": { json: [{ number: 7, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }] },
      "/repos/o/r/pulls/7/files": { json: [] },
    });
    const pf = await runSweepPreflight({ ...BASE, fetchImpl });
    expect(pf.decision === "skip" && pf.prs[0].url).toBe("https://github.com/o/r/pull/7");
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
      "a per-PR files read fails",
      {
        "/repos/o/r/commits/main": { json: { sha: "aaa111" } },
        "/repos/o/r/pulls?state=open": { json: [{ number: 30, head: { ref: "sweep/a" }, base: { sha: "aaa111" } }] },
        "/repos/o/r/pulls/30/files": { status: 500, json: null },
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

describe("commentOnSweepPr", () => {
  it("posts exactly one comment with the re-verification wording", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: 201, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const ok = await commentOnSweepPr({ ...BASE, number: 33, fetchImpl, mainSha: "aaa111", date: "2026-09-17" });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/33/comments");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      body: "re-verified against main @aaa111 on 2026-09-17; still mergeable",
    });
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
