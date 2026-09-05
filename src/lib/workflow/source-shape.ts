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
 * Two layers, because one is not enough:
 *   1. validateSourcesShape — the front door. New bad rows stop here with a 400.
 *   2. formatSourceDisplay  — the read path. Rows ALREADY persisted (and rows
 *      written by any future path that skips the route) still have to render.
 *
 * ZERO SERVER-ONLY IMPORTS: this is imported by the route AND by the
 * client-bundled WorkflowBoard, so it may only depend on ./redact (itself
 * import-free). Never import intake.ts here — it pulls in @aws-sdk/client-s3.
 */

import { redactUrl } from "./redact";

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

/**
 * TEAM-4090: a persisted row's `input.sources` is untrusted the same way any one
 * source item is (see the file header) — a caller that skips the REST validator
 * can persist `sources` as a non-empty STRING or an array-like OBJECT
 * (`{ length: 1, 0: {...} }`), both of which pass a `.length > 0` guard and then
 * throw "sources.map is not a function", blanking the whole board. Only
 * Array.isArray proves `.map` is safe to call.
 */
export function sourcesForDisplay(input: unknown): unknown[] {
  if (typeof input !== "object" || input === null) return [];
  const sources = (input as Record<string, unknown>).sources;
  return Array.isArray(sources) ? sources : [];
}

/** Everything the board needs to render one source, all of it already a string
 *  and already redacted. Nothing here may be interpolated into JSX raw. */
export interface SourceDisplay {
  /** Stringified source type — never an object. */
  type: string;
  /** Redacted then truncated. What the operator sees. */
  text: string;
  /** Redacted, untruncated — safe for a title attribute. */
  full: string;
  /** Redacted label, or undefined when there isn't a usable one. */
  label?: string;
  unverified: boolean;
  /** Redacted verification detail, or undefined. */
  detail?: string;
}

const MAX_DISPLAY_LENGTH = 64;
const HEAD = 40;
const TAIL = 23;

/** A value we cannot render — shown instead of throwing, so one bad legacy row
 *  cannot blank the whole board. */
const INVALID_PLACEHOLDER = "(invalid)";

function truncateMiddle(text: string): string {
  if (text.length <= MAX_DISPLAY_LENGTH) return text;
  return `${text.slice(0, HEAD)}…${text.slice(-TAIL)}`;
}

/**
 * Render-safe view of one persisted intake source.
 *
 * REDACT BEFORE TRUNCATE (TEAM-4078 F2): the old board built its display text
 * from the RAW value as `slice(0, 40) + "…" + slice(-23)`. For an S3 presigned
 * URL the last 23 characters are the tail of `X-Amz-Signature=<64 hex>`, and a
 * URL of 64 characters or fewer was printed whole — so the sources list put a
 * live object credential on screen (and in the DOM, and in any screenshot).
 * Truncating the REDACTED string can only ever cut up "…&X-Amz-Signature=
 * REDACTED".
 *
 * redactUrl leaves non-URL values (a bare S3 key, an upload id) untouched, so a
 * plain value still displays verbatim.
 */
export function formatSourceDisplay(src: unknown): SourceDisplay {
  const record = (typeof src === "object" && src !== null ? src : {}) as Record<string, unknown>;

  const rawValue = record.value;
  const full = typeof rawValue === "string" ? redactUrl(rawValue) : INVALID_PLACEHOLDER;

  const rawType = record.type;
  // String(...) over a raw {} render: an object interpolated into JSX throws
  // "Objects are not valid as a React child" and takes the board down.
  const type = typeof rawType === "string" && rawType.length > 0 ? rawType : String(rawType);

  const rawLabel = record.label;
  const label = typeof rawLabel === "string" && rawLabel.length > 0 ? redactUrl(rawLabel) : undefined;

  const verification = (typeof record.verification === "object" && record.verification !== null
    ? record.verification
    : {}) as Record<string, unknown>;
  const rawDetail = verification.detail;

  return {
    type,
    text: truncateMiddle(full),
    full,
    ...(label ? { label } : {}),
    unverified: verification.status === "unverified",
    ...(typeof rawDetail === "string" && rawDetail.length > 0 ? { detail: redactUrl(rawDetail) } : {}),
  };
}
