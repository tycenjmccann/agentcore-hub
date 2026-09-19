/**
 * TEAM-4740 FR-9 — dead-code-sweep preflight.
 *
 * A scheduled sweep is the one flow that can do a full run's work and produce
 * nothing anyone wants. Three real runs show the shape:
 *
 *   lpkxmt  swept `main` at 0760fcc and opened PR #33 — while #30, also based on
 *           0760fcc, was still open. Same base, same call graph, so #33 deleted
 *           the same code #30 already deletes. Two competing PRs, neither merged.
 *   mgfcwf  the same thing at cbe4965 with #6/#7.
 *   xgf0dt  `main` HAD moved, so there genuinely was new dead code — but #23 was
 *           still open, and the sweep re-reported everything #23 already removes.
 *
 * So the question this module answers before a run is minted is not "is there
 * dead code" but "is there dead code THIS run could remove that an open PR does
 * not already remove". Three outcomes:
 *
 *   skip open_sweep_pr   an open sweep PR that could actually LAND is based on the
 *                        CURRENT main — its diff is exactly what we would produce.
 *                        Re-verify it and stop. (TEAM-4752 D4: "could land" is a
 *                        check, not an assumption — see `isViableSweepPr`.)
 *   skip unchanged_main  no open sweep PR and main has not moved since the last
 *                        sweep's base — the last sweep already answered this SHA.
 *   proceed              main moved. `alreadyRemoved` names what an open PR is
 *                        already deleting so the analyst does not re-report it.
 *
 * DL-028 direction: ANY probe failure proceeds. "We could not look at GitHub" is
 * not "there is nothing to sweep", and a skip is the destructive answer here — it
 * cancels a run outright. Failing open costs a redundant sweep; failing closed
 * silently retires the flow the first time a token expires.
 *
 * Everything except `runSweepPreflight`/`commentOnSweepPr` is pure. Those two use
 * `ghGet`/`ghHeaders` from repo-check.ts — the hub's one GitHub client — with an
 * injectable `fetchImpl`, so the whole module is testable with no network.
 */

import { ghGet, ghHeaders } from "./repo-check";

/**
 * Branch names a dead-code sweep pushes. Kept as an explicit list rather than one
 * loose /sweep/ match: a human branch called `fix/sweep-the-logs` must not make a
 * scheduled run skip itself.
 */
export const SWEEP_HEAD_PATTERNS: RegExp[] = [
  /^feature\/.*-dead-code-sweep-.*/,
  /^chore\/dead-code-sweep-/,
  /^sweep\//,
];

/** True when `headRef` is a branch a dead-code sweep produced. */
export function isSweepHead(headRef: string): boolean {
  const ref = String(headRef || "");
  return SWEEP_HEAD_PATTERNS.some((re) => re.test(ref));
}

/** An open sweep PR, reduced to what the decision needs. */
export interface OpenSweepPr {
  number: number;
  url: string;
  headRef: string;
  /** The commit on the default branch this PR is based on (`base.sha`). */
  baseSha: string;
  /** Paths (and ledger-named symbols) this PR already deletes. */
  deletedPaths: string[];
  // ─── TEAM-4752 D4: whether this PR could actually land ─────────────────────
  /** `base.ref` — the branch the PR targets, not the branch it came from. */
  baseRef: string;
  /** GitHub's `draft` flag: a draft PR is not offered for merge. */
  draft: boolean;
  /** `head.repo.full_name` — "owner/repo", so a fork's PR is recognizable. */
  headRepoFullName: string;
  /** GitHub's three-state mergeability: `false` = CONFLICTING, `null` = not yet
   *  computed. Null is NOT a negative; GitHub computes it asynchronously. */
  mergeable: boolean | null;
}

/** The `prs` echo on a skip — enough for a human to go look at what blocked it. */
export interface SkippedPrRef {
  number: number;
  url: string;
  baseSha: string;
  /** TEAM-4752 D4: so the caller can WORD its comment from the observed state
   *  instead of asserting "still mergeable" on the strength of the base SHA. */
  mergeable: boolean | null;
}

export type SweepSkipReason = "open_sweep_pr" | "unchanged_main";

export interface SweepPreflightSkip {
  decision: "skip";
  reason: SweepSkipReason;
  prs: SkippedPrRef[];
}

export interface SweepPreflightProceed {
  decision: "proceed";
  /** Paths/symbols an open PR already deletes — do NOT re-report these. */
  alreadyRemoved: string[];
  /** The open PR this run's branch effectively stacks on, when there is one. */
  stackedOn?: { number: number; url: string };
  /** Set only when a probe failed and we proceeded rather than guessed. */
  probeFailed?: boolean;
}

export type SweepPreflight = SweepPreflightSkip | SweepPreflightProceed;

/** What `runSweepPreflight` adds to the pure decision: the SHA it decided against. */
export type SweepPreflightRun = SweepPreflight & { mainSha: string | null };

export interface SweepPreflightInput {
  /** Current HEAD of the default branch. */
  mainSha: string;
  /** Open PRs whose head already matched SWEEP_HEAD_PATTERNS. */
  openSweepPrs: OpenSweepPr[];
  /** Base SHA the previous sweep ran against, when it is knowable. */
  lastSweepBaseSha?: string | null;
  // ─── TEAM-4752 D4 — pure function, so what it compares against is an INPUT ──
  /** The branch a viable sweep PR must target (the repo's default branch). */
  defaultBranch: string;
  /** "owner/repo" a viable sweep PR's head must live in — a fork cannot be the
   *  thing that lands this diff. */
  repoFullName: string;
}

/** Newest = highest PR number. GitHub numbers are monotonic per repo. */
function newest(prs: OpenSweepPr[]): OpenSweepPr | undefined {
  return prs.reduce<OpenSweepPr | undefined>(
    (best, pr) => (best === undefined || pr.number > best.number ? pr : best),
    undefined
  );
}

/**
 * TEAM-4752 D4 — could this PR actually deliver the diff we are about to skip?
 *
 * The skip arm's whole claim is "an open PR already contains this run's diff", and
 * it was resting on `base.sha` alone. A PR at the right base SHA that is CONFLICTING,
 * a draft, targeting a release branch, or opened from a fork does not deliver
 * anything — so skipping on it retires the sweep in favour of a PR that will never
 * merge, and the dead code stays. That is strictly worse than the duplicate-PR
 * problem FR-9 was written to solve, because at least a duplicate PR was mergeable.
 *
 * Each clause is a DEFINITE negative, and `mergeable: null` is deliberately not one:
 * GitHub computes mergeability asynchronously and answers null until it has, so
 * treating null as unmergeable would make the decision depend on how quickly we
 * asked. The comment on a skip is worded from the same value instead
 * (`commentOnSweepPr`), so an unknown is disclosed rather than asserted away.
 */
export function isViableSweepPr(
  pr: OpenSweepPr,
  { defaultBranch, repoFullName }: { defaultBranch: string; repoFullName: string }
): boolean {
  if (!pr) return false;
  if (!defaultBranch || pr.baseRef !== defaultBranch) return false;
  if (pr.draft) return false;
  if (pr.mergeable === false) return false;
  if (!repoFullName || pr.headRepoFullName !== repoFullName) return false;
  return true;
}

/**
 * The decision, as a pure function of the observations. Order matters: an open PR at
 * the current main is the strongest signal we have, and it is checked before the
 * (weaker, often unknowable) last-base comparison.
 *
 * TEAM-4752 D4: every arm that CONSUMES an open PR now consumes only the viable
 * ones. That includes the advisory arms — `alreadyRemoved` tells the analyst "do NOT
 * re-report these", so listing paths a conflicting or forked PR can no longer
 * deliver suppresses the only useful part of proceeding. `open.length === 0` for the
 * `unchanged_main` arm stays on the RAW list: an unmergeable sweep PR is still an
 * open sweep PR, and the run that would have to fix it is not the run we should
 * cancel for having nothing to do.
 */
export function decideSweepPreflight({
  mainSha,
  openSweepPrs,
  lastSweepBaseSha,
  defaultBranch,
  repoFullName,
}: SweepPreflightInput): SweepPreflight {
  const open = (openSweepPrs || []).filter((pr) => pr && isSweepHead(pr.headRef));
  const viable = open.filter((pr) => isViableSweepPr(pr, { defaultBranch, repoFullName }));

  // An open, LANDABLE sweep PR based on the CURRENT main already contains this
  // run's diff.
  if (mainSha && viable.some((pr) => pr.baseSha === mainSha)) {
    return {
      decision: "skip",
      reason: "open_sweep_pr",
      // All viable matches, not just the one at main: lpkxmt had two, and a human
      // reading the skip needs to see both to know which one to merge.
      prs: viable.map((pr) => ({ number: pr.number, url: pr.url, baseSha: pr.baseSha, mergeable: pr.mergeable })),
    };
  }

  // Nothing open and main has not moved: the previous sweep already answered
  // this exact SHA, and a sweep is deterministic in its input.
  if (open.length === 0 && lastSweepBaseSha && mainSha && lastSweepBaseSha === mainSha) {
    return { decision: "skip", reason: "unchanged_main", prs: [] };
  }

  if (viable.length > 0) {
    const alreadyRemoved = [...new Set(viable.flatMap((pr) => pr.deletedPaths || []))].sort();
    const top = newest(viable);
    return {
      decision: "proceed",
      alreadyRemoved,
      ...(top ? { stackedOn: { number: top.number, url: top.url } } : {}),
    };
  }

  return { decision: "proceed", alreadyRemoved: [] };
}

// ─── GitHub probe ─────────────────────────────────────────────────────────────

export interface RunSweepPreflightOptions {
  owner: string;
  repo: string;
  defaultBranch: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  lastSweepBaseSha?: string | null;
}

/**
 * Identifiers a sweep PR's own "Removal Ledger" section names. xgf0dt's removals
 * were three Python SYMBOLS (`_extract_json_array`, `_store_briefings`,
 * `budget_map`) inside files that survived, so `status: "removed"` on the files
 * endpoint saw none of them — the PR body was the only place they existed. Parsed
 * best-effort: a bullet list under a `## Removal Ledger` heading, stopping at the
 * next heading. Anything unparseable just yields nothing.
 */
export function parseRemovalLedger(body: string | null | undefined): string[] {
  const lines = String(body || "").split(/\r?\n/);
  const out: string[] = [];
  let inLedger = false;
  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      inLedger = /removal ledger/i.test(line) || /alreadyremoved/i.test(line.replace(/[\s_-]/g, ""));
      continue;
    }
    if (!inLedger) continue;
    // `- \`identifier\`` or `- identifier` / `* identifier`. Take the first
    // token so a trailing " — reason" note does not become part of the name.
    const m = line.match(/^\s*[-*]\s+`?([A-Za-z_][A-Za-z0-9_.]*)`?/);
    if (m) out.push(m[1]);
  }
  return out;
}

interface GhPr {
  number?: number;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  head?: { ref?: string; repo?: { full_name?: string } | null };
  base?: { sha?: string; ref?: string };
  /** Only the single-PR endpoint returns this; the list endpoint omits it. */
  mergeable?: boolean | null;
}

/**
 * SR2-1/SR2-2 pagination bound for the two GitHub LIST reads below. Ten pages is
 * 500 open PRs at per_page=50 and 1000 changed files at per_page=100 — orders of
 * magnitude past anything this repo or any sweep PR has produced.
 */
const GH_LIST_MAX_PAGES = 10;

/**
 * Read EVERY page of a GitHub list endpoint, or report that we could not.
 *
 * `ghGet` returns `{status, json}` only — no response headers — so Link-header
 * pagination is not available without changing the hub's one GitHub client. Pages
 * are walked by `page=N` and stopped by the first SHORT page, which needs no
 * headers; a short page means page N+1 is never requested.
 *
 * `ok: false` is this module's single "the probe could not be completed" signal:
 * a page that is not 200, a page whose body is not an array, or a still-FULL page
 * at `maxPages`. Truncating instead would hide exactly the thing FR-9 looks for
 * (the oldest open sweep PR), so an unread tail fails open (DL-028) rather than
 * being silently reported as the whole list.
 */
async function ghGetAllPages(
  path: string,
  opts: RunSweepPreflightOptions,
  { perPage, maxPages = GH_LIST_MAX_PAGES }: { perPage: number; maxPages?: number }
): Promise<{ ok: true; items: unknown[] } | { ok: false }> {
  const sep = path.includes("?") ? "&" : "?";
  const items: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await ghGet(`${path}${sep}per_page=${perPage}&page=${page}`, opts);
    if (res.status !== 200 || !Array.isArray(res.json)) return { ok: false };
    items.push(...res.json);
    if (res.json.length < perPage) return { ok: true, items };
  }
  return { ok: false };
}

/**
 * Probe GitHub and decide. Never throws: any failure — no token, 404, rate
 * limit, timeout, junk body — returns `proceed` with `probeFailed: true`.
 */
export async function runSweepPreflight(
  opts: RunSweepPreflightOptions
): Promise<SweepPreflightRun> {
  const failOpen: SweepPreflightRun = {
    decision: "proceed",
    alreadyRemoved: [],
    probeFailed: true,
    mainSha: null,
  };
  const { owner, repo, defaultBranch } = opts;
  if (!owner || !repo || !defaultBranch) return failOpen;
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);

  try {
    const head = await ghGet(`/repos/${o}/${r}/commits/${encodeURIComponent(defaultBranch)}`, opts);
    const mainSha = (head.json as { sha?: string } | null)?.sha;
    if (head.status !== 200 || typeof mainSha !== "string" || !mainSha) return failOpen;

    const list = await ghGetAllPages(`/repos/${o}/${r}/pulls?state=open`, opts, { perPage: 50 });
    if (!list.ok) return failOpen;

    const candidates = (list.items as GhPr[]).filter((pr) => isSweepHead(pr?.head?.ref || ""));
    const openSweepPrs: OpenSweepPr[] = [];
    for (const pr of candidates) {
      const number = pr.number;
      if (typeof number !== "number") continue;

      // TEAM-4752 D4: the LIST endpoint does not carry `mergeable` — GitHub computes
      // it per PR, on demand, and only the single-PR endpoint reports it. So a
      // viability check that needs it needs this second call; there is no way to get
      // it in bulk. One extra request per sweep PR, and there are never many.
      const detail = await ghGet(`/repos/${o}/${r}/pulls/${number}`, opts);
      if (detail.status !== 200 || !detail.json || typeof detail.json !== "object") return failOpen;
      const full = detail.json as GhPr;

      const files = await ghGetAllPages(`/repos/${o}/${r}/pulls/${number}/files`, opts, { perPage: 100 });
      if (!files.ok) return failOpen;
      const removed = (files.items as { status?: string; filename?: string }[])
        .filter((f) => f?.status === "removed" && typeof f.filename === "string")
        .map((f) => f.filename as string);
      openSweepPrs.push({
        number,
        url: full.html_url || pr.html_url || `https://github.com/${owner}/${repo}/pull/${number}`,
        headRef: full.head?.ref || pr.head?.ref || "",
        baseSha: full.base?.sha || pr.base?.sha || "",
        deletedPaths: [...removed, ...parseRemovalLedger(full.body ?? pr.body)],
        baseRef: full.base?.ref || pr.base?.ref || "",
        draft: full.draft === true,
        headRepoFullName: full.head?.repo?.full_name || pr.head?.repo?.full_name || "",
        // Anything that is not a literal boolean is "GitHub has not answered yet",
        // which `isViableSweepPr` deliberately does not read as a negative.
        mergeable: typeof full.mergeable === "boolean" ? full.mergeable : null,
      });
    }

    return {
      ...decideSweepPreflight({
        mainSha,
        openSweepPrs,
        lastSweepBaseSha: opts.lastSweepBaseSha,
        defaultBranch,
        repoFullName: `${owner}/${repo}`,
      }),
      mainSha,
    };
  } catch {
    return failOpen;
  }
}

/**
 * TEAM-4752 D4 — the comment body, as a pure function of what we actually observed.
 *
 * "still mergeable" was asserted on the strength of `base.sha` alone, which says only
 * that the PR is based on the current main — nothing about conflicts. The comment is
 * the ONE artefact a skip leaves for a human, and it was the sentence telling them
 * not to look. Each state now says what is true, and the `true` state keeps today's
 * wording byte-for-byte so a merged-by-hand history stays greppable.
 */
export function sweepSkipCommentBody({
  mainSha,
  date,
  mergeable,
}: {
  mainSha: string;
  date: string;
  mergeable: boolean | null | undefined;
}): string {
  const head = `re-verified against main @${mainSha} on ${date};`;
  if (mergeable === true) return `${head} still mergeable`;
  if (mergeable === false) return `${head} GitHub reports it as CONFLICTING`;
  return `${head} mergeability not yet computed by GitHub`;
}

/**
 * Post the ONE re-verification comment a skip leaves behind. This is also the
 * notification channel: the PR's subscribers are the repo owner, and the hub has
 * no other notifier it is allowed to reuse. Best-effort — a skip that could not
 * comment is still a correct skip, so this never throws.
 */
export async function commentOnSweepPr(opts: {
  owner: string;
  repo: string;
  number: number;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  mainSha: string;
  date: string;
  /** GitHub's three-state mergeability for this PR, as observed by the preflight. */
  mergeable?: boolean | null;
}): Promise<boolean> {
  const { owner, repo, number, mainSha, date, mergeable } = opts;
  if (!owner || !repo || !number) return false;
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      {
        method: "POST",
        headers: { ...ghHeaders(opts.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: sweepSkipCommentBody({ mainSha, date, mergeable }) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      }
    );
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

// ─── Route helpers ────────────────────────────────────────────────────────────

/**
 * Whether the route should go on to mint an epic, tickets and a workflow row. A
 * skip must create NONE of them — that is the whole saving — so the route's one
 * branch is expressed here where the replay tests can assert it directly.
 */
export function shouldMintEpic(pf: SweepPreflight): boolean {
  return pf.decision !== "skip";
}

/**
 * SR2-3 — which PR the ONE comment a skip leaves behind belongs on.
 *
 * `decideSweepPreflight` skips when ANY viable PR sits at the current main, but
 * echoes EVERY viable PR in `prs` (a human reading the skip needs the whole set —
 * lpkxmt had two). The comment, though, says "re-verified against main @<sha>", so
 * it may only be posted where that is TRUE. Taking the highest number out of `prs`
 * put it on a PR based on some other commit whenever the newest match was not the
 * newest echo. Newest AMONG the PRs actually at `mainSha`; undefined when the SHA
 * is unknown or nothing matches (`unchanged_main`, whose `prs` is empty, lands here
 * too, and correctly comments on nothing).
 */
export function skipCommentTarget(
  pf: SweepPreflightRun & { decision: "skip" }
): SkippedPrRef | undefined {
  if (!pf?.mainSha) return undefined;
  return (pf.prs || []).reduce<SkippedPrRef | undefined>(
    (best, pr) =>
      pr && pr.baseSha === pf.mainSha && (best === undefined || pr.number > best.number) ? pr : best,
    undefined
  );
}

/** The delimited block appended to the run's description. "" when there is
 *  nothing an analyst would act on, so an ordinary sweep's prompt is unchanged. */
export function sweepPreflightNote(pf: SweepPreflight): string {
  if (pf.decision !== "proceed" || pf.alreadyRemoved.length === 0) return "";
  const on = pf.stackedOn ? `Stacked on open PR #${pf.stackedOn.number} (${pf.stackedOn.url}).` : "";
  return [
    "",
    "",
    "## Sweep preflight",
    `${on} alreadyRemoved (already deleted by that PR — do NOT re-report):`.trim(),
    ...pf.alreadyRemoved.map((item) => `- ${item}`),
  ].join("\n");
}

/** The `preflight` field persisted on the workflow row's input, for the UI + audit. */
export function preflightRowField(pf: SweepPreflightRun): {
  decision: string;
  stackedOn?: { number: number; url: string };
  alreadyRemoved: string[];
  mainSha: string | null;
} {
  return {
    decision: pf.decision,
    ...(pf.decision === "proceed" && pf.stackedOn ? { stackedOn: pf.stackedOn } : {}),
    alreadyRemoved: pf.decision === "proceed" ? pf.alreadyRemoved : [],
    mainSha: pf.mainSha,
  };
}
