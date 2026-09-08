/**
 * Liveness-clock thresholds — TEAM-4166 D2 (§2.1, §2.5). Lambda mirror.
 *
 * The numbers can only be changed in one place: src/config/liveness-constants.json,
 * which the TS side imports directly (src/lib/workflow/liveness-constants.ts).
 *
 * TEAM-4295 — "./liveness-constants.json" beside this module is a COMMITTED
 * byte-identical mirror of that file, so the local candidate is what resolves both
 * in the repo and in every deploy. It is committed rather than copied in at deploy
 * time (the lease-constants.json pattern) because the pipeline zips exactly the
 * `files` list in deploy/pipeline/surfaces.json — Target 1b has no hook to copy
 * anything in, so an uncommitted mirror simply never shipped, and this module fell
 * through to the last-resort literals below in the deployed Lambda. The mirror is
 * kept honest in three places: a byte-equality assertion in liveness.test.mjs, a
 * cmp drift check in deploy/workflow-manager/deploy.sh, and the closure guard in
 * scripts/check-lambda-zip-manifest.sh (which requires surfaces.json to list it).
 *
 * The "../../src/config/..." fallback is retained for a tree where the mirror is
 * absent, and the literals for a zip that somehow carries neither.
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
