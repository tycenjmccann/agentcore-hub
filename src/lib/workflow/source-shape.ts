/**
 * Intake-source shape defenses (TEAM-4078).
 *
 * POST /api/workflow/start has no auth under AUTH_MODE=none and is POSTed
 * directly by routines-runner, prd-submitter, the telegram intake Lambda and
 * scripts — the route parsed `await req.json()` straight into WorkflowInput and
 * never checked that `sources[i]` was even an object. A source like
 * `{ type: "upload", value: null }` was accepted (validateIntakeSources coerces
 * a non-string value to "" and files it under "skipped"), persisted verbatim
 * (DynamoDB removeUndefinedValues drops undefined, not null), and then crashed
 * the workflow board on read with "Cannot read properties of null (reading
 * 'length')". A non-string `type` crashed it with "Objects are not valid as a
 * React child".
 *
 * validateSourcesShape is the front door: bad rows stop here with a 400.
 * Sources are intake material for the requirements agent (they travel in the
 * PRD package); the workflow board no longer renders them.
 *
 * ZERO SERVER-ONLY IMPORTS: keep this file dependency-free. Never import
 * intake.ts here — it pulls in @aws-sdk/client-s3.
 */

/** Mirrors IntakeSourceSchema's `type` enum in mcp/hub/src/workflow/schemas.ts.
 *  Kept an enum, not a free string, so the two front doors agree. */
export const INTAKE_SOURCE_TYPES = ["url", "upload", "s3"] as const;

/**
 * Ceiling on how many sources one submission may carry (TEAM-4091 F3).
 *
 * validateIntakeSources checks every source CONCURRENTLY, and each one can cost
 * up to two outbound GETs of URL_TIMEOUT_MS (10s) each, or an S3 HeadObject. An
 * unauthenticated caller could otherwise turn a single POST into an unbounded
 * fan-out of server-side requests. 32 is far above any real submission (the
 * board shows a handful of design references) and far below a useful amplifier.
 *
 * Mirrored by the zod `.max()` on both MCP front doors — see
 * mcp/hub/src/workflow/schemas.ts.
 */
export const MAX_INTAKE_SOURCES = 32;

/**
 * Validate the SHAPE of a submitted `sources` value — a mirror of
 * IntakeSourceSchema (type enum, value non-empty string, optional string
 * contentType/label) for the REST route, which has no zod layer.
 *
 * Returns null when the value is acceptable, or a caller-facing message naming
 * the offending index. `undefined`/`null` are acceptable: the route already
 * coalesces a missing `sources` to []. `verification` is deliberately not
 * checked — validateIntakeSources discards whatever a caller sends there, so a
 * malformed one can never reach the row.
 */
export function validateSourcesShape(sources: unknown): string | null {
  if (sources === undefined || sources === null) return null;
  if (!Array.isArray(sources)) {
    return 'sources must be an array of { type, value } objects';
  }
  if (sources.length > MAX_INTAKE_SOURCES) {
    return `sources must have at most ${MAX_INTAKE_SOURCES} items`;
  }

  for (let i = 0; i < sources.length; i++) {
    const item: unknown = sources[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return `sources[${i}] must be an object with a "type" and a "value"`;
    }
    const { type, value, contentType, label } = item as Record<string, unknown>;

    if (typeof type !== "string" || !(INTAKE_SOURCE_TYPES as readonly string[]).includes(type)) {
      return `sources[${i}].type must be one of ${INTAKE_SOURCE_TYPES.map((t) => `"${t}"`).join(" | ")}`;
    }
    if (typeof value !== "string" || value.length === 0) {
      return `sources[${i}].value must be a non-empty string`;
    }
    if (contentType !== undefined && typeof contentType !== "string") {
      return `sources[${i}].contentType must be a string when present`;
    }
    if (label !== undefined && typeof label !== "string") {
      return `sources[${i}].label must be a string when present`;
    }
  }

  return null;
}
