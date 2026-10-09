/**
 * `input.modelOverride` validation for the routine save paths (TEAM-5016
 * finding 6).
 *
 * A routine's `input.modelOverride` is forwarded verbatim to `/api/workflow/start`
 * on every fire. That front door validates the override (TEAM-5008 finding 7)
 * and 400s a typo, a retired id or a read-only row — so a routine saved with
 * one failed silently, forever, on its schedule: the runner recorded
 * `lastRun.status:"failed"` and returned 200 (a 4xx is terminal), and nobody
 * was ever asked to fix the value at the moment it was typed.
 *
 * So the SAME validator runs where the value is written — routine create and
 * PATCH — and refuses with the SAME 400 body the workflow route sends, so the
 * console can render one error for both. The stored value is the NORMALIZED
 * catalog id: a routine's override is a string (`RoutineInputTemplate`), and the
 * front door re-validates that string at fire time.
 */

import { NextResponse } from "next/server";
import { loadModelsRegistry } from "@/lib/models-registry";
import { validateModelOverride } from "@/lib/models/validate-model-override";

export type RoutineOverrideGuard =
  /** Store `modelOverride` when present; an absent key means "clear it". */
  | { ok: true; modelOverride?: string }
  | { ok: false; response: NextResponse };

/**
 * Is `value` an override a routine may carry? `null`, `undefined` and an empty
 * string all mean "use the configured default", and clear a stored override.
 */
export async function guardRoutineModelOverride(value: unknown): Promise<RoutineOverrideGuard> {
  const verdict = validateModelOverride(await loadModelsRegistry(), value);
  if (!verdict.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid_model_override", reason: verdict.reason, modelOverride: value },
        { status: 400 }
      ),
    };
  }
  // `override === undefined` is the validator's "nothing to store" — the same
  // branch the workflow route takes when it deletes the key.
  if (verdict.override === undefined) return { ok: true };
  return { ok: true, modelOverride: verdict.modelId };
}
