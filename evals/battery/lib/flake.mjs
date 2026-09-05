// Flake detection (TEAM-3090, FR-10): pure verdict-flip bookkeeping over a
// JSONL ledger. Everything here is INFORMATIONAL ONLY — nothing in this module
// can change a gate verdict; retirement stays a human status:retired PR
// (see README "Flake retirement policy").
//
// Ledger shape: one JSON line per (runId, caseId):
//   { ts, runId, caseId, fingerprint, verdict }
// `fingerprint` identifies "unchanged config" for the case (its effective
// definition + the system prompt text it ran against); `verdict` is
// pass | fail — errored/timed_out/skipped/unscored runs land as fail.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { redactText } from "./redact.mjs";

export const FLAKE_WINDOW = 5;
export const FLAKE_FLIP_THRESHOLD = 2;

// Key-order-independent stringify so semantically identical case defs hash
// identically regardless of construction order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    );
  return value;
}

/** Stable hash identifying "unchanged config" for a case. */
export function configFingerprint(caseDef, systemPromptText) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(caseDef)))
    .update("\u0000")
    .update(String(systemPromptText ?? ""))
    .digest("hex")
    .slice(0, 16);
}

// Appends go through the same C2 redaction as battery-progress.jsonl — ledger
// lines carry runner-derived strings and the file is uploaded as a CI artifact.
export function appendFlakeLedger(ledgerPath, entries) {
  const lines = entries.map((e) => redactText(JSON.stringify(e)).text + "\n").join("");
  appendFileSync(ledgerPath, lines);
}

/** Read a ledger file; a missing file is an empty ledger and a corrupt line costs only itself. */
export function readFlakeLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const e = JSON.parse(line);
        return e && typeof e === "object" && typeof e.caseId === "string" ? [e] : [];
      } catch {
        return [];
      }
    });
}

const normalizeVerdict = (v) => (v === "pass" ? "pass" : "fail");

/**
 * For each caseId: take the entries whose fingerprint matches the NEWEST
 * entry's (a fingerprint change means the config changed, so the flip window
 * resets), keep the last FLAKE_WINDOW of those (ledger order = append order,
 * oldest first), and count adjacent pass↔fail transitions. flips >=
 * FLAKE_FLIP_THRESHOLD ⇒ flagged as {caseId, flips, fingerprint, window}.
 */
export function flagFlakyCases(ledger) {
  const byCase = new Map();
  for (const e of ledger) {
    if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
    byCase.get(e.caseId).push(e);
  }
  const flagged = [];
  for (const [caseId, entries] of byCase) {
    const fingerprint = entries[entries.length - 1].fingerprint;
    const window = entries.filter((e) => e.fingerprint === fingerprint).slice(-FLAKE_WINDOW);
    let flips = 0;
    for (let i = 1; i < window.length; i++)
      if (normalizeVerdict(window[i].verdict) !== normalizeVerdict(window[i - 1].verdict)) flips++;
    if (flips >= FLAKE_FLIP_THRESHOLD)
      flagged.push({
        caseId,
        flips,
        fingerprint,
        window: window.map((e) => ({ runId: e.runId, ts: e.ts, verdict: normalizeVerdict(e.verdict) })),
      });
  }
  return flagged;
}
