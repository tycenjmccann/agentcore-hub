import { describe, it, expect, vi } from "vitest";
import {
  evidenceFromBranchProbe as probeTs,
  findTicketPullRequest as findPrTs,
  probeTicketBranches as sweepTs,
  parseRepo as parseRepoTs,
} from "./evidence";
import {
  evidenceFromBranchProbe as probeMjs,
  findTicketPullRequest as findPrMjsRaw,
  probeTicketBranches as sweepMjsRaw,
} from "../../../lambda/orchestrator/evidence.mjs";

/**
 * The .mjs side has no type annotations, so TS infers its option bags from the
 * destructuring defaults only (owner/repo, which have none, come out absent).
 * Widen the two option-taking exports rather than contorting the fixtures — the
 * whole point of the suite is to feed BOTH sides the identical loose payloads.
 */
type OptionFn = (githubFetch: unknown, opts: Record<string, unknown>) => Promise<unknown>;
const findPrMjs = findPrMjsRaw as unknown as OptionFn;
const sweepMjs = sweepMjsRaw as unknown as OptionFn;

/**
 * TEAM-3991 D1.2/D1.5 parity contract — `src/lib/workflow/evidence.ts` is a hand
 * port of `lambda/orchestrator/evidence.mjs`. Both sides answer the same two
 * questions about the same GitHub payloads:
 *
 *   "did this agent leave provable work behind?"  (evidenceFromBranchProbe)
 *   "does a PR for this ticket already exist?"     (findTicketPullRequest)
 *
 * A drift means the console would synthesize evidence the orchestrator would not
 * accept, or re-dispatch an agent the orchestrator would have resumed. The
 * NEVER-FABRICATE rule is the load-bearing case: an empty probe must be
 * `hasEvidence: false` on both sides, forever.
 */

const PROBES: Array<[string, Record<string, unknown>]> = [
  ["empty", {}],
  ["no args at all", undefined as unknown as Record<string, unknown>],
  ["branch pushed, 0 commits ahead, no PR", { branch: "feature/T-1-dev", branchHead: { commit: { sha: "aaa1111" } }, compare: { ahead_by: 0 }, prs: [] }],
  ["branch 3 ahead, no PR", { branch: "feature/T-1-dev", branchHead: { commit: { sha: "aaa1111" } }, compare: { ahead_by: 3 }, prs: [] }],
  [
    "0 ahead but an open PR (evidence via the PR alone)",
    { branch: "feature/T-1-dev", compare: { ahead_by: 0 }, prs: [{ number: 7, html_url: "u/7", state: "open", head: { ref: "feature/T-1-dev", sha: "bbb2222" } }] },
  ],
  [
    "merged PR outranks an open one",
    {
      branch: "",
      prs: [
        { number: 8, html_url: "u/8", state: "open", head: { ref: "feature/T-1-a", sha: "ccc3333" } },
        { number: 9, html_url: "u/9", state: "closed", merged_at: "2026-09-01T00:00:00Z", head: { ref: "feature/T-1-b", sha: "ddd4444" } },
      ],
    },
  ],
  [
    "closed-unmerged PR only",
    { prs: [{ number: 10, html_url: "u/10", state: "closed", merged_at: null, head: { ref: "feature/T-1-c", sha: "eee5555" } }] },
  ],
  ["branch name falls back to the branchHead", { branchHead: { name: "feature/T-1-dev", commit: { sha: "fff6666" } }, compare: { ahead_by: 1 } }],
  ["ahead_by not a number", { branch: "b", compare: { ahead_by: "many" }, prs: [] }],
  ["ahead_by missing", { branch: "b", compare: {}, prs: [] }],
  ["prs not an array", { branch: "b", prs: null }],
  ["nulls everywhere", { branch: "", branchHead: null, compare: null, prs: [] }],
];

describe("TEAM-3991 parity — evidenceFromBranchProbe", () => {
  for (const [label, probe] of PROBES) {
    it(`agrees on ${label}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(probeTs(probe as any)).toEqual(probeMjs(probe as any));
    });
  }

  it("NEVER FABRICATES: an empty probe is no evidence on both sides", () => {
    expect(probeTs({}).hasEvidence).toBe(false);
    expect(probeMjs({}).hasEvidence).toBe(false);
  });
});

const PR_LIST = [
  { number: 1, html_url: "u/1", state: "open", head: { ref: "feature/OTHER-1-dev" } },
  { number: 2, html_url: "u/2", state: "open", head: { ref: "feature/T-1-backend-dev" } },
  { number: 3, html_url: "u/3", state: "closed", merged_at: "2026-09-02T00:00:00Z", head: { ref: "feature/T-1-qa" } },
  { number: 4, html_url: "u/4", state: "open", head: { ref: "shared/wf_1" } },
  { number: 5, html_url: "u/5", state: "closed", merged_at: null, head: { ref: "feature/T-2" } },
];

const PR_CASES: Array<[string, unknown, Record<string, string>]> = [
  ["merged wins over open for the same ticket", PR_LIST, { ticketId: "T-1" }],
  ["exact feature/<ticketId> match", PR_LIST, { ticketId: "T-2" }],
  ["the run's shared feature branch counts", PR_LIST, { ticketId: "T-9", featureBranch: "shared/wf_1" }],
  ["no PR for this ticket", PR_LIST, { ticketId: "T-404" }],
  ["a ticket id that is a prefix of another must not match it", PR_LIST, { ticketId: "T" }],
  ["empty list", [], { ticketId: "T-1" }],
  ["GitHub returned a non-array (error shape)", { message: "Bad credentials" }, { ticketId: "T-1" }],
];

describe("TEAM-3991 D1.5 parity — findTicketPullRequest", () => {
  for (const [label, payload, args] of PR_CASES) {
    it(`agrees on ${label}`, async () => {
      const fetchImpl = vi.fn(async () => payload);
      const opts = { owner: "acme", repo: "hub", ...args };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [ts, mjs] = [await findPrTs(fetchImpl, opts as any), await findPrMjs(fetchImpl, opts)];
      expect(ts).toEqual(mjs);
    });
  }

  it("both sides issue the SAME single GitHub call (one list, client-side match)", async () => {
    const tsFetch = vi.fn(async () => PR_LIST);
    const mjsFetch = vi.fn(async () => PR_LIST);
    await findPrTs(tsFetch, { owner: "acme", repo: "hub", ticketId: "T-1", base: "develop" });
    await findPrMjs(mjsFetch, { owner: "acme", repo: "hub", ticketId: "T-1", base: "develop" });
    expect(tsFetch.mock.calls).toEqual(mjsFetch.mock.calls);
    expect(tsFetch).toHaveBeenCalledTimes(1);
  });

  it("a throwing GitHub is `null` on both sides — the caller fails OPEN", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    });
    expect(await findPrTs(boom, { owner: "acme", repo: "hub", ticketId: "T-1" })).toBeNull();
    expect(await findPrMjs(boom, { owner: "acme", repo: "hub", ticketId: "T-1" })).toBeNull();
  });

  it("missing owner/repo/ticketId short-circuits identically (zero calls)", async () => {
    const tsFetch = vi.fn(async () => PR_LIST);
    const mjsFetch = vi.fn(async () => PR_LIST);
    for (const args of [
      { owner: "", repo: "hub", ticketId: "T-1" },
      { owner: "acme", repo: "", ticketId: "T-1" },
      { owner: "acme", repo: "hub", ticketId: "" },
    ]) {
      expect(await findPrTs(tsFetch, args)).toBeNull();
      expect(await findPrMjs(mjsFetch, args)).toBeNull();
    }
    expect(tsFetch).not.toHaveBeenCalled();
    expect(mjsFetch).not.toHaveBeenCalled();
  });
});

describe("TEAM-3991 parity — probeTicketBranches", () => {
  /** A fake GitHub where only `pushed` branches exist. */
  const github = (pushed: Record<string, { ahead: number; prs: unknown[] }>) =>
    vi.fn(async (path: string) => {
      const branchMatch = path.match(/\/branches\/(.+)$/);
      if (branchMatch) {
        const name = decodeURIComponent(branchMatch[1]);
        if (!pushed[name]) throw new Error("404");
        return { name, commit: { sha: `sha-${name}` } };
      }
      const cmpMatch = path.match(/\/compare\/[^.]+\.\.\.(.+)$/);
      if (cmpMatch) return { ahead_by: pushed[decodeURIComponent(cmpMatch[1])]?.ahead ?? 0 };
      const prMatch = path.match(/head=([^&]+)/);
      if (prMatch) return pushed[decodeURIComponent(prMatch[1]).split(":")[1]]?.prs ?? [];
      throw new Error(`unexpected ${path}`);
    });

  const SWEEPS: Array<[string, Record<string, { ahead: number; prs: unknown[] }>, string[]]> = [
    ["nothing pushed", {}, ["feature/T-1-dev", "shared/wf_1"]],
    ["first candidate has commits", { "feature/T-1-dev": { ahead: 2, prs: [] } }, ["feature/T-1-dev", "shared/wf_1"]],
    [
      "first pushed but empty, second carries a PR",
      { "feature/T-1-dev": { ahead: 0, prs: [] }, "shared/wf_1": { ahead: 0, prs: [{ number: 3, html_url: "u/3", state: "open", head: { ref: "shared/wf_1" } }] } },
      ["feature/T-1-dev", "shared/wf_1"],
    ],
    ["duplicate + blank candidates are skipped", { "feature/T-1-dev": { ahead: 1, prs: [] } }, ["", "feature/T-1-dev", "feature/T-1-dev"]],
    ["no candidates", { "feature/T-1-dev": { ahead: 9, prs: [] } }, []],
  ];

  for (const [label, pushed, branches] of SWEEPS) {
    it(`agrees on ${label}`, async () => {
      const tsFetch = github(pushed);
      const mjsFetch = github(pushed);
      const opts = { owner: "acme", repo: "hub", base: "main", branches };
      expect(await sweepTs(tsFetch, opts)).toEqual(await sweepMjs(mjsFetch, opts));
      // Same probe ORDER too — the sweep must not re-order or re-try differently.
      expect(tsFetch.mock.calls).toEqual(mjsFetch.mock.calls);
    });
  }
});

describe("parseRepo (app side only — the orchestrator's is module-private)", () => {
  it("reads owner/repo out of a repoConfig, https or ssh", () => {
    expect(parseRepoTs({ repos: [{ url: "https://github.com/acme/hub.git" }] })).toEqual({ owner: "acme", repo: "hub" });
    expect(parseRepoTs({ repos: [{ url: "git@github.com:acme/hub.git" }] })).toEqual({ owner: "acme", repo: "hub" });
  });

  it("anything else is empty strings, so callers skip GitHub entirely", () => {
    expect(parseRepoTs(undefined)).toEqual({ owner: "", repo: "" });
    expect(parseRepoTs({})).toEqual({ owner: "", repo: "" });
    expect(parseRepoTs({ repos: [{ url: "https://gitlab.com/acme/hub" }] })).toEqual({ owner: "", repo: "" });
  });
});
