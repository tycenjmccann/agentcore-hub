/**
 * Liveness-clock thresholds — TEAM-4166 D2 (§2.1, §2.5). Lambda mirror.
 *
 * Reads the SAME src/config/liveness-constants.json the TS side imports
 * (src/lib/workflow/liveness-constants.ts), so the numbers can only be changed
 * in one place — the exact lease-constants.mjs precedent. The deploy copies the
 * JSON in beside this module (deploy/workflow-manager/deploy.sh), so the local
 * "./liveness-constants.json" is preferred; the "../../src/config/..." fallback
 * is what resolves in the repo (tests, local runs) where no copy has been made.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadLivenessConstants() {
  const candidates = ["./liveness-constants.json", "../../src/config/liveness-constants.json"];
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(HERE, rel), "utf8"));
    } catch {
      // try the next candidate
    }
  }
  // Last-resort literals — MUST match src/config/liveness-constants.json. This
  // path is never taken in a correct deploy or repo checkout; it only keeps the
  // module from crashing at cold start if the JSON is somehow absent.
  return { devMinutes: 45, verifyMinutes: 20, shipMinutes: 12, spanFreshMinutes: 2, defaultMinutes: 10 };
}

const { devMinutes, verifyMinutes, shipMinutes, spanFreshMinutes, defaultMinutes } =
  loadLivenessConstants();

export const LIVENESS_DEV_MS = devMinutes * 60_000;
export const LIVENESS_VERIFY_MS = verifyMinutes * 60_000;
export const LIVENESS_SHIP_MS = shipMinutes * 60_000;
export const LIVENESS_SPAN_FRESH_MS = spanFreshMinutes * 60_000;
export const LIVENESS_DEFAULT_MS = defaultMinutes * 60_000;
