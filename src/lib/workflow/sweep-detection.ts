/**
 * TEAM-4265 F9 PARITY — hand-port of lambda/orchestrator/index.mjs
 * `stripUnenforcedDetectionPhase` (and its `DETECTION_PHASE` constant), for the
 * HTTP completion route.
 *
 * The orchestrator applies the strip ONCE, centrally, in `getEffectiveWorkflowDef`,
 * so every Lambda-side consumer reads a def with "detection" already filtered out
 * of `completionRequiresAgentPhases`. The route is a second, human-driven way to
 * close a run (the Workflow Manager's `complete` intervention) and it resolves its
 * own def — so without this port it reads the RAW def and the two tiers disagree:
 * `src/config/workflows.json` lists "detection" for `dead-code-sweep`, so under the
 * default `shadow` a sweep whose intake never stamped a detection ticket completes
 * via the orchestrator and 409s `required_phase_incomplete` here. That is the
 * precise wedge the strip exists to prevent, on the one path a human reaches for
 * when a run is already stuck.
 *
 * Lives in a lib module rather than inline in route.ts because a Next.js route file
 * may only export HTTP handlers — an exported helper there fails the build's route
 * type-check, so the parity test could never drive it. Same shape as
 * verified-heads.ts / completion-evidence.ts / ship-review.ts, which the route
 * imports for the same reason. src/lib/workflow/sweep-detection-parity.test.ts pins
 * this port against the .mjs original over a shared table.
 *
 * Keep in agreement with lambda/orchestrator/index.mjs.
 */

/** PARITY MIRROR of DETECTION_PHASE (lambda/orchestrator/index.mjs). */
export const DETECTION_PHASE = "detection";

/**
 * off | shadow | enforce — PARITY with verdict-contract.mjs normalizeVerdictMode
 * (and with normalizeVerifiedHeadMode / normalizeSweepCadenceMode, which are the
 * same three lines): UNSET → shadow (observe a new install before it starts
 * refusing completions), PRESENT-but-unrecognized → off (a typo must never
 * silently make a phase load-bearing).
 */
export function normalizeSweepDetectionMode(raw: unknown): "off" | "shadow" | "enforce" {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "shadow";
  const v = String(raw).trim().toLowerCase();
  return v === "off" || v === "shadow" || v === "enforce" ? v : "off";
}

/**
 * TEAM-4247 D2 — "detection" is REQUIRED for completion only under
 * `SWEEP_DETECTION_PHASE=enforce`. Verbatim reasoning from the .mjs original:
 *
 * Why it has to be conditional: `src/config/workflows.json` reaches the Lambdas by
 * a manual `aws s3 cp`, on its own schedule, and no roster agent claims
 * `phase: "detection"`. The moment that config lands, a `required.every(...)` check
 * would demand a done detection ticket on runs whose intake never created one —
 * wedging every in-flight sweep. Requiring the phase only under enforce means the
 * config can be synced at any time, and the phase becomes load-bearing exactly when
 * the flag that also acts on it is armed.
 *
 * The def's `phases` array is NEVER stripped: the analyst has to see the detection
 * phase (and stamp its ticket) under shadow too, or shadow observes nothing. Only
 * the completion REQUIREMENT is flag-gated. Returns the def unchanged — the SAME
 * object — when there is nothing to strip, so identity checks keep working.
 *
 * `mode` is a parameter here, not a module-level const as in the .mjs original: the
 * route reads the env var per request (like VERIFIED_HEAD_COMPLETION), because a
 * long-lived Next.js server must not cache a flag the operator can flip.
 */
export function stripUnenforcedDetectionPhase<T extends { completionRequiresAgentPhases?: string[] }>(
  def: T,
  mode: "off" | "shadow" | "enforce"
): T {
  if (mode === "enforce") return def;
  const required = def?.completionRequiresAgentPhases;
  if (!Array.isArray(required) || !required.includes(DETECTION_PHASE)) return def;
  return { ...def, completionRequiresAgentPhases: required.filter((p) => p !== DETECTION_PHASE) };
}
