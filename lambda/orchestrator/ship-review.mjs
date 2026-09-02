/**
 * Ship-review convergence arithmetic AND the diff-scoped gate — the orchestrator
 * (Lambda) port of src/lib/workflow/ship-review.ts.
 *
 * TEAM-3619 D2c (convergence cap) + TEAM-3689 (`enforceDiffScope` /
 * `diffScopeRounds` / `effectiveRoundCountDiffScoped`, the deterministic form of
 * release-manager.md Step 4's DIFF-SCOPED GATE). The orchestrator is plain .mjs
 * with no build step, so it cannot import the TS module the web app and the
 * blueprint contract share. This is a HAND PORT and must agree with the TS
 * original bit-for-bit — a drift means the orchestrator's cap enforcement and
 * diff-scope classification disagree with the release manager's own round
 * accounting about when the loop is over and which findings gate, which is
 * exactly the runaway-rework bug the cap closes.
 *
 * Same hand-port pattern (and same obligation) as lease.mjs ↔ lease.ts from
 * TEAM-3618; parity is asserted by src/lib/workflow/ship-review-parity.test.ts,
 * which feeds identical fixtures through both copies.
 *
 * Keep the two files' comments and structure aligned too — the next person to
 * change the arithmetic needs to see immediately that there is a twin.
 */

/**
 * Effective ship-review round count. Pure; input order-insensitive.
 *
 * Tolerant of malformed ledger entries (written by an LLM, not this code):
 * a missing/non-array `findings`, or non-object finding entries, are treated
 * as a plain round rather than throwing. Ledgers may also contain duplicate
 * round numbers if a caller wrote an entry without going through mergeRound;
 * rounds are deduped by round number (last entry per round wins) before
 * filtering/reducing.
 *
 * `opts.regressionCountsDouble` mirrors the gate config field of the same
 * name: true (the default) weighs a regression round 2, false weighs every
 * CHANGES-NEEDED round 1 regardless of regressions.
 */
export function effectiveRoundCount(rounds, authorizations = [], opts = {}) {
  const regressionCountsDouble = opts.regressionCountsDouble ?? true;
  const lastReset = Math.max(
    0,
    ...authorizations.filter((a) => a.decision === "continue").map((a) => a.resetAtRound)
  );
  const dedupedByRound = new Map();
  for (const r of rounds) dedupedByRound.set(r.round, r);
  return [...dedupedByRound.values()]
    .filter((r) => r.round > lastReset && r.verdict === "CHANGES-NEEDED")
    .reduce(
      (n, r) =>
        n +
        (regressionCountsDouble &&
        Array.isArray(r.findings) &&
        r.findings.some((f) => f?.regressionOf != null)
          ? 2
          : 1),
      0
    );
}

/**
 * Idempotent round merge keyed by round number (reviewedHeadSha is carried
 * on the entry but not part of the key). Under the blueprint numbering rule
 * (release-manager.md Step 4.1) a round number is reused only when
 * re-running the same head SHA, so overwriting the entry for an existing
 * round is always a re-run replace; a new SHA always arrives as a new round
 * number, never as a same-round overwrite.
 */
export function mergeRound(rounds, entry) {
  const i = rounds.findIndex((r) => r.round === entry.round);
  if (i === -1) return [...rounds, entry];
  const next = rounds.slice();
  next[i] = entry; // re-run of the same round: overwrite in place
  return next;
}

// ── Diff-scoped gate (release-manager.md Step 4, "DIFF-SCOPED GATE") ──────────
//
// The blueprint's rule — a finding gates only if EVERY file it cites is inside
// the PR change set; anything else is advisory and can never flip the verdict —
// lived ONLY as LLM prose, with no deterministic enforcement (QA finding F1).
// `enforceDiffScope` is that enforcement: it downgrades any out-of-diff blocking
// finding to advisory regardless of what the reviewer wrote, so a CHANGES-NEEDED
// verdict can never survive without at least one genuinely in-diff finding.

const CLASSIFICATION_IN_DIFF = "IN-DIFF";
const CLASSIFICATION_ADVISORY = "ADVISORY";

/** Normalize a path for change-set membership: coerce, trim, drop a leading
 *  `./` or `/` so `./src/a.ts`, `/src/a.ts` and `src/a.ts` all compare equal. */
function normalizePath(p) {
  return String(p ?? "")
    .trim()
    .replace(/^\.?\/+/, "");
}

/** A single change-set token may be a rename in `old -> new` form (git's
 *  human-readable rename arrow); expand it to BOTH paths. */
function expandArrow(token) {
  return token.includes(" -> ")
    ? token.split(" -> ").map((x) => x.trim()).filter(Boolean)
    : [token];
}

/**
 * Build the set of normalized paths a change set covers. Accepts either bare
 * paths or raw `git diff --name-status` lines: a leading status code (A, M, D,
 * T, U, X, B, or a similarity-scored R100/C075) is stripped, and rename/copy
 * entries — whether tab-delimited (`R100\told\tnew`) or arrow form
 * (`old -> new`) — contribute BOTH paths. Non-array input → empty set (so the
 * guard, when it runs at all, fails toward advisory rather than throwing).
 */
function changeSetToPathSet(changeSet) {
  const out = new Set();
  if (!Array.isArray(changeSet)) return out;
  for (const raw of changeSet) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    let tokens;
    if (s.includes("\t")) {
      const parts = s.split("\t").map((p) => p.trim()).filter(Boolean);
      // Drop a leading name-status code (R/C carry a similarity number).
      tokens = parts.length >= 2 && /^[A-Z]\d*$/.test(parts[0]) ? parts.slice(1) : parts;
    } else {
      tokens = [s];
    }
    for (const t of tokens) {
      for (const path of expandArrow(t)) {
        const n = normalizePath(path);
        if (n) out.add(n);
      }
    }
  }
  return out;
}

/** The normalized files a finding cites: `citedFiles` preferred, `files` as an
 *  alias. A missing/non-array list yields `[]` — which makes the finding
 *  advisory (it cites no resolvable file). */
function citedFilesOf(finding) {
  const raw = Array.isArray(finding.citedFiles)
    ? finding.citedFiles
    : Array.isArray(finding.files)
      ? finding.files
      : [];
  const out = [];
  for (const f of raw) {
    const n = normalizePath(f);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Deterministically apply the diff-scoped gate to one round. PURE — the input
 * round and its findings are never mutated; a fresh normalized round is
 * returned. Tolerant of malformed LLM-written entries in the exact spirit of
 * `effectiveRoundCount`: it NEVER throws, and every ambiguity fails toward
 * advisory / non-blocking so a malformed finding can never gate.
 *
 * Rules (mirror release-manager.md Step 4's classification):
 *  - a finding is IN-DIFF only if it cites ≥1 file AND every cited file is in
 *    `changeSet` (paths normalized; renames count as both paths);
 *  - any other finding — one citing a file outside the change set, OR citing no
 *    resolvable files, OR a non-object entry — is forced to ADVISORY, and its
 *    `regressionOf` is stripped (blueprint: only IN-DIFF findings can be a
 *    regression for cap purposes), so it can neither gate nor weigh double;
 *  - if the verdict is CHANGES-NEEDED but ZERO findings remain IN-DIFF it is
 *    downgraded — to PASS when no findings remain at all, else to the
 *    non-blocking PASS-with-known-findings. Invariant: the returned round can
 *    never present CHANGES-NEEDED without at least one IN-DIFF finding.
 *
 * `changeSet` defaults to the round's own `changeSet` field when omitted.
 */
export function enforceDiffScope(round, changeSet) {
  // Non-object round (malformed ledger entry): nothing to scope, pass through.
  if (!round || typeof round !== "object") return round;
  const paths = changeSetToPathSet(changeSet !== undefined ? changeSet : round.changeSet);
  const rawFindings = Array.isArray(round.findings) ? round.findings : [];
  let inDiffCount = 0;
  const findings = rawFindings.map((f) => {
    if (!f || typeof f !== "object") {
      // Malformed finding: cannot cite anything → advisory, cannot gate.
      return { classification: CLASSIFICATION_ADVISORY };
    }
    const cited = citedFilesOf(f);
    const inDiff = cited.length >= 1 && cited.every((c) => paths.has(c));
    if (inDiff) {
      inDiffCount++;
      return { ...f, classification: CLASSIFICATION_IN_DIFF };
    }
    // Downgrade: force ADVISORY and drop regressionOf (advisory findings are
    // never regressions), so the round can neither gate nor weigh double on it.
    const { regressionOf: _dropped, ...rest } = f;
    return { ...rest, classification: CLASSIFICATION_ADVISORY };
  });

  let verdict = round.verdict;
  if (verdict === "CHANGES-NEEDED" && inDiffCount === 0) {
    verdict = findings.length === 0 ? "PASS" : "PASS-with-known-findings";
  }
  return { ...round, findings, verdict };
}

/**
 * Apply `enforceDiffScope` to every round that CARRIES change-set data, leaving
 * every other round byte-identical. This is the seam that keeps the guard inert
 * by default: a round with no `changeSet` array (every old ledger entry, and
 * every round the orchestrator writes itself) passes through untouched, so
 * `effectiveRoundCount` sees exactly what it saw before. Enforcement engages
 * only once a producer records the `changeSet` alongside classified findings.
 */
export function diffScopeRounds(rounds) {
  return (Array.isArray(rounds) ? rounds : []).map((r) =>
    r && typeof r === "object" && Array.isArray(r.changeSet) ? enforceDiffScope(r) : r
  );
}

/**
 * `effectiveRoundCount` after diff-scoping — the entry point the enforcement
 * path uses. Identical to `effectiveRoundCount` when no round records a
 * `changeSet` (so it is a safe drop-in for existing callers), but once change
 * sets are present it counts ONLY rounds that still gate after out-of-diff
 * findings are downgraded.
 */
export function effectiveRoundCountDiffScoped(rounds, authorizations = [], opts = {}) {
  return effectiveRoundCount(diffScopeRounds(rounds), authorizations, opts);
}
