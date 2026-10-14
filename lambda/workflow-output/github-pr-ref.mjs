/**
 * TEAM-6154 (ship review r3 F2 of #954) — the ONE GitHub PR-url parser, byte-mirrored
 * from lambda/orchestrator/completion.mjs (TEAM-6133 host anchoring via `new URL`,
 * TEAM-6148 whole-positive-integer PR number). report_completion compares a
 * cd-ledger's `prUrl` against a report's `pr_url` by CANONICAL identity
 * (owner/repo case-insensitive + number), never by string, so a unified CD naming
 * its own PR as GITHUB.COM/Owner/Repo/pull/12#discussion is still its own PR.
 *
 * Why a copy and not an import: every Lambda ships as its own zip and
 * scripts/check-lambda-zip-manifest.sh follows only `./x.mjs` imports, exactly the
 * constraint behind the fix-contract.mjs / gate-contract.mjs copies. The function
 * text below MUST stay identical to the orchestrator's;
 * src/lib/workflow/github-pr-ref-parity.test.ts pins both the source text and a
 * behavioural matrix through both imports. Edit both or neither. Nothing else
 * lives in this file so that pin stays a 1:1 comparison.
 */
export function githubPrRef(text) {
  for (const tok of String(text ?? "").match(/https?:\/\/\S+/gi) || []) {
    let u; try { u = new URL(tok.replace(/[.,;:!?)\]}>'"]+$/, "")); } catch { continue; } // TEAM-6148: prose punctuation off the token
    const p = u.pathname.split("/"), n = /^[1-9]\d*$/.exec(p[4] || "");
    if (u.hostname === "github.com" && p[1] && p[2] && p[3] === "pull" && n) return { owner: p[1], repo: p[2], number: Number(n[0]) };
  }
  return null;
}
