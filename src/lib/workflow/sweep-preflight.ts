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
 *   skip open_sweep_pr   an open sweep PR is based on the CURRENT main — its diff
 *                        is exactly what we would produce. Re-verify it and stop.
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

/** An open sweep PR, reduced to the four things the decision needs. */
export interface OpenSweepPr {
  number: number;
  url: string;
  headRef: string;
  /** The commit on the default branch this PR is based on (`base.sha`). */
  baseSha: string;
  /** Paths (and ledger-named symbols) this PR already deletes. */
  deletedPaths: string[];
}

/** The `prs` echo on a skip — enough for a human to go look at what blocked it. */
export interface SkippedPrRef {
  number: number;
  url: string;
  baseSha: string;
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
}

/** Newest = highest PR number. GitHub numbers are monotonic per repo. */
function newest(prs: OpenSweepPr[]): OpenSweepPr | undefined {
  return prs.reduce<OpenSweepPr | undefined>(
    (best, pr) => (best === undefined || pr.number > best.number ? pr : best),
    undefined
  );
}

/**
 * The decision, as a pure function of the three observations. Order matters: an
 * open PR at the current main is the strongest signal we have, and it is checked
 * before the (weaker, often unknowable) last-base comparison.
 */
export function decideSweepPreflight({
  mainSha,
  openSweepPrs,
  lastSweepBaseSha,
}: SweepPreflightInput): SweepPreflight {
  const open = (openSweepPrs || []).filter((pr) => pr && isSweepHead(pr.headRef));

  // An open sweep PR based on the CURRENT main already contains this run's diff.
  if (mainSha && open.some((pr) => pr.baseSha === mainSha)) {
    return {
      decision: "skip",
      reason: "open_sweep_pr",
      // All matching PRs, not just the one at main: lpkxmt had two, and a human
      // reading the skip needs to see both to know which one to merge.
      prs: open.map((pr) => ({ number: pr.number, url: pr.url, baseSha: pr.baseSha })),
    };
  }

  // Nothing open and main has not moved: the previous sweep already answered
  // this exact SHA, and a sweep is deterministic in its input.
  if (open.length === 0 && lastSweepBaseSha && mainSha && lastSweepBaseSha === mainSha) {
    return { decision: "skip", reason: "unchanged_main", prs: [] };
  }

  if (open.length > 0) {
    const alreadyRemoved = [...new Set(open.flatMap((pr) => pr.deletedPaths || []))].sort();
    const top = newest(open);
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
  head?: { ref?: string };
  base?: { sha?: string };
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

    const list = await ghGet(`/repos/${o}/${r}/pulls?state=open&per_page=50`, opts);
    if (list.status !== 200 || !Array.isArray(list.json)) return failOpen;

    const candidates = (list.json as GhPr[]).filter((pr) => isSweepHead(pr?.head?.ref || ""));
    const openSweepPrs: OpenSweepPr[] = [];
    for (const pr of candidates) {
      const number = pr.number;
      if (typeof number !== "number") continue;
      const files = await ghGet(`/repos/${o}/${r}/pulls/${number}/files?per_page=100`, opts);
      if (files.status !== 200 || !Array.isArray(files.json)) return failOpen;
      const removed = (files.json as { status?: string; filename?: string }[])
        .filter((f) => f?.status === "removed" && typeof f.filename === "string")
        .map((f) => f.filename as string);
      openSweepPrs.push({
        number,
        url: pr.html_url || `https://github.com/${owner}/${repo}/pull/${number}`,
        headRef: pr.head?.ref || "",
        baseSha: pr.base?.sha || "",
        deletedPaths: [...removed, ...parseRemovalLedger(pr.body)],
      });
    }

    return {
      ...decideSweepPreflight({ mainSha, openSweepPrs, lastSweepBaseSha: opts.lastSweepBaseSha }),
      mainSha,
    };
  } catch {
    return failOpen;
  }
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
}): Promise<boolean> {
  const { owner, repo, number, mainSha, date } = opts;
  if (!owner || !repo || !number) return false;
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      {
        method: "POST",
        headers: { ...ghHeaders(opts.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: `re-verified against main @${mainSha} on ${date}; still mergeable` }),
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
