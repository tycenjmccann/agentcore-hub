/**
 * Liveness-clock thresholds — TEAM-4166 D2 (§2.1, §2.5).
 *
 * The analyzer's WATCH scan judges a running workflow STALE per phase: a dev
 * agent may go dark for a whole claude_code run, a ship gate should never sit
 * silent for long. These are the DEFAULTS — the analyzer Lambda reads env
 * overrides (WM_LIVENESS_*_MINUTES) on top of them; this module exists so the
 * TS side (and its parity tests) reference the SAME numbers the Lambda ships.
 *
 * Single source of truth is src/config/liveness-constants.json (the same
 * TS-imports-JSON / Lambda-reads-JSON precedent as lease-constants.json). The
 * Lambda mirror lambda/workflow-analyzer/liveness-constants.mjs reads that file
 * too, so a value can only be changed in one place.
 *
 * §2.1 sync invariants (asserted in liveness.test.mjs against src/lib/workflow/
 * stale.ts): the span-fresh window must be shorter than the claude_code STUCK
 * threshold (a streaming agent is never stale), and the dev window must be at
 * least the claude_code STUCK threshold AND the lease TTL (§2.5) — the liveness
 * clock must never fire before the board would even call the agent stuck, nor
 * before its lease could have expired.
 */

import livenessConstants from "../../config/liveness-constants.json";

const { devMinutes, verifyMinutes, shipMinutes, spanFreshMinutes, defaultMinutes } =
  livenessConstants;

export const LIVENESS_DEV_MS = devMinutes * 60_000;
export const LIVENESS_VERIFY_MS = verifyMinutes * 60_000;
export const LIVENESS_SHIP_MS = shipMinutes * 60_000;
export const LIVENESS_SPAN_FRESH_MS = spanFreshMinutes * 60_000;
export const LIVENESS_DEFAULT_MS = defaultMinutes * 60_000;
