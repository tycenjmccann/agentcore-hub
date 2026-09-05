/**
 * Intake Processing
 *
 * Handles multi-source input for workflow initiation:
 * - URL: Fetch webpage content, extract text/images
 * - Upload: Process uploaded files (PDF→text, images→base64)
 * - S3: Read objects from user-specified S3 location
 *
 * Processed content is packaged for the requirements agent.
 */

import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { IntakeSource, SourceVerification } from "./types";
import { redactUrl } from "./redact";

export { redactUrl };

interface ProcessedSource {
  type: IntakeSource["type"];
  originalValue: string;
  content: string;
  contentType: string;
  label?: string;
  s3Key?: string; // Where it was stored in the workflow bucket
  isImage?: boolean; // True if this is an image (content is base64)
  imageFormat?: string; // png, jpeg, gif, webp
  isBinary?: boolean; // True if binary non-image (PDF, etc.)
}

// ─── Upfront Validation ─────────────────────────────────────────────────────
//
// TEAM-4054: every submission carrying `sources` used to 422 with
// "Source validation failed … UnknownError". Three defects stacked up:
//
//  1. A HEAD against S3 gets a BODILESS 403. The AWS SDK v3 has no XML error
//     body to parse, so it sets err.message = "UnknownError" and puts the only
//     real signal on err.name ("403") and err.$metadata.httpStatusCode. The old
//     catch printed err.message alone, laundering a plain cross-account
//     AccessDenied into a mystery. (Live: the hub runs in account 838829463875
//     and its task role grants s3:GetObject on
//     agentcore-hub-artifacts-838829463875-us-east-1 ONLY; the reported source
//     lived in agentcore-hub-artifacts-023392223961-us-east-1 — a DIFFERENT
//     account. Cross-account AccessDenied, not env drift. Runtime agents in the
//     hub account cannot read it either without a bucket-policy grant, which is
//     why the 403 detail says so.)
//  2. URLs were probed with HEAD. An S3 presigned URL is signed for exactly ONE
//     method ("An HTTP method (GET for downloading objects, PUT for uploading,
//     HEAD for reading object metadata, etc)" —
//     https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html),
//     so HEAD against a GET-signed URL is a guaranteed 403. We now issue a GET
//     with Range: bytes=0-0 and cancel the body — one byte, correct method.
//  3. Any error rejected the whole submission. Reachability is a network
//     opinion, not a fact: 403/timeout/5xx now ride along as
//     verification.status="unverified" (SOURCE_VALIDATION_MODE=lenient default)
//     and only definitive negatives (malformed s3://, S3 404, URL 404/410)
//     still 422.
//
// Every string that could contain a URL goes through redactUrl() — presigned
// query strings are bearer credentials and these details land in 422 bodies,
// console logs and the persisted workflow row.

/**
 * Minimal AWS-client seam so tests can inject a stub (mirroring the fetchImpl
 * injection in repo-check.ts). `any` is deliberate: the SDK's send() is generic
 * over its own Command union, so any narrower parameter type makes a real
 * S3Client / STSClient un-assignable here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AwsClientLike = { send: (cmd: any) => Promise<any> };

/** Outcome of one source check. "definitive" = a negative we trust. */
export type SourceOutcome = "verified" | "definitive" | "transient" | "skipped";

export interface SourceCheckResult {
  source: IntakeSource;
  outcome: SourceOutcome;
  method: string;
  detail?: string;
  checkedAt: string;
  verification: SourceVerification;
}

export interface SourceValidationResult {
  results: SourceCheckResult[];
  /** Negatives we trust — these reject the submission in every mode. */
  definitiveErrors: string[];
  /** "Could not verify" — rejects only in strict mode. */
  transientErrors: string[];
  /** Input sources, copied with the AUTHORITATIVE verification marker set
   *  (any caller-supplied `verification` is discarded first). */
  sources: IntakeSource[];
}

export type SourceValidationMode = "strict" | "lenient";

export interface ValidateIntakeSourcesOptions {
  /** Injected for tests; defaults to a real S3Client in the resolved region. */
  s3Client?: AwsClientLike;
  /** Injected for tests; defaults to globalThis.fetch looked up at CALL time. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Skips hub-bucket resolution entirely (and therefore STS). */
  hubBucket?: string;
  stsClient?: AwsClientLike;
  now?: () => Date;
}

const URL_TIMEOUT_MS = 10_000;

/** SOURCE_VALIDATION_MODE — anything that is not exactly "strict" is lenient. */
export function getSourceValidationMode(env: NodeJS.ProcessEnv = process.env): SourceValidationMode {
  return (env.SOURCE_VALIDATION_MODE || "").trim().toLowerCase() === "strict" ? "strict" : "lenient";
}

/**
 * The 422-vs-accept decision. Definitive negatives (a malformed s3:// URI, an
 * S3 404, an HTTP 404/410) are worth a submitter's time to fix now — nothing
 * downstream will ever read those. "Could not verify" is not: the validator's
 * IAM identity is not the identity the pipeline agents run under, so its 403 is
 * evidence about the validator, not about the source. Rejecting on it is what
 * made every sourced submission fail. Strict mode is the opt-in for operators
 * who would rather block than ship an unverified reference.
 */
export function shouldRejectSubmission(
  result: SourceValidationResult,
  mode: SourceValidationMode
): { reject: boolean; errors: string[] } {
  const errors = [...result.definitiveErrors, ...(mode === "strict" ? result.transientErrors : [])];
  return { reject: errors.length > 0, errors };
}

// ─── Hub bucket resolution ───────────────────────────────────────────────────

function resolveRegion(env: NodeJS.ProcessEnv): string {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
}

/** Memoized only for the DEFAULT (non-injected) STS client, so tests that pass
 *  their own stub always get a fresh call. */
let defaultAccountIdProbe: Promise<string | undefined> | null = null;

async function probeAccountId(
  region: string,
  stsClient?: AwsClientLike
): Promise<string | undefined> {
  const run = async (client: AwsClientLike) => {
    try {
      const res = (await client.send(new GetCallerIdentityCommand({}))) as { Account?: string };
      return res?.Account || undefined;
    } catch {
      // No credentials / no sts:GetCallerIdentity / network. The hub bucket is
      // then simply unknown — that only costs us the "(hub bucket)" label, it
      // must never fail a submission.
      return undefined;
    }
  };
  if (stsClient) return run(stsClient);
  if (!defaultAccountIdProbe) {
    defaultAccountIdProbe = run(new STSClient({ region }));
  }
  return defaultAccountIdProbe;
}

/**
 * The hub's own artifacts bucket. NEVER env-only: the old code short-circuited
 * on ARTIFACT_BUCKET alone, so an unset var silently turned "our own bucket"
 * into "a stranger's bucket". Falls back to the deploy convention
 * (`agentcore-hub-artifacts-<account>-<region>`, mirroring
 * deploy/ecs-express/deploy.sh) with the account id from env or STS.
 * Returns undefined when it cannot be determined — never throws.
 */
export async function resolveHubBucket(
  opts: { env?: NodeJS.ProcessEnv; stsClient?: AwsClientLike } = {}
): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const explicit = env.ARTIFACT_BUCKET || env.AGENTCORE_HUB_ARTIFACT_BUCKET;
  if (explicit) return explicit;

  const region = resolveRegion(env);
  const accountId = env.AWS_ACCOUNT_ID || env.ACCOUNT_ID || (await probeAccountId(region, opts.stsClient));
  return accountId ? `agentcore-hub-artifacts-${accountId}-${region}` : undefined;
}

// ─── Per-source checks ───────────────────────────────────────────────────────

interface Check {
  outcome: SourceOutcome;
  method: string;
  detail?: string;
}

/** Names that carry no information beyond the status code we already print. */
const UNINFORMATIVE_ERROR_NAMES = new Set([
  "",
  "Error",
  "UnknownError",
  "403",
  "404",
  "Forbidden",
  "NotFound",
  "NoSuchKey",
  "AccessDenied",
]);

const ACCESS_DENIED_HINT =
  " — validator role has no read access to this bucket; runtime agents in the hub account will need a " +
  "bucket policy grant, or upload the object to the hub artifacts bucket instead";

async function checkS3Source(
  value: string,
  ctx: { s3: AwsClientLike | undefined; hubBucket?: string }
): Promise<Check> {
  const match = value.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return { outcome: "definitive", method: "parse", detail: `Invalid S3 URI format: ${redactUrl(value)}` };
  }
  const [, bucket, key] = match;
  const scope = ctx.hubBucket && bucket === ctx.hubBucket ? "hub bucket" : "external bucket";

  if (!ctx.s3) {
    // Only reachable if a caller passes an s3:// source with a hand-built ctx.
    return { outcome: "transient", method: "HeadObject", detail: `S3 client unavailable: ${redactUrl(value)}` };
  }

  try {
    // ALWAYS a real HeadObject, hub bucket included. The old "trust our own
    // bucket" short-circuit meant a wrong key in our own bucket sailed through
    // to an agent that then could not read it.
    await ctx.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      outcome: "verified",
      method: "HeadObject",
      detail: `S3 object readable — HeadObject -> 200 (${scope})`,
    };
  } catch (err) {
    const rawName = typeof (err as { name?: unknown })?.name === "string" ? (err as Error).name : "";
    const rawMessage = typeof (err as { message?: unknown })?.message === "string" ? (err as Error).message : "";
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

    const is404 = status === 404 || rawName === "NotFound" || rawName === "NoSuchKey" || rawName === "404";
    const is403 = status === 403 || rawName === "AccessDenied" || rawName === "Forbidden" || rawName === "403";

    let outcome: SourceOutcome;
    let label: string;
    let errName: string;
    if (is404) {
      outcome = "definitive";
      label = "missing";
      errName = rawName === "NoSuchKey" ? "NoSuchKey" : "NotFound";
    } else if (is403) {
      outcome = "transient";
      label = "unreadable";
      errName = "AccessDenied";
    } else {
      outcome = "transient";
      label = "unreachable";
      errName = rawName || "Error";
    }

    // "UnknownError" is the bodiless-HEAD artefact — it must never be the only
    // thing we report. Anything genuinely informative still rides along.
    const extras: string[] = [];
    if (rawName && rawName !== errName && !UNINFORMATIVE_ERROR_NAMES.has(rawName)) extras.push(rawName);
    if (rawMessage && rawMessage !== "UnknownError") extras.push(rawMessage);

    const detail =
      `S3 object ${label} — HeadObject -> ${errName} (${status ?? "no status"}): ${redactUrl(value)}` +
      (extras.length ? ` — ${extras.map(redactUrl).join(" — ")}` : "") +
      (is403 ? ACCESS_DENIED_HINT : "");

    return { outcome, method: "HeadObject", detail };
  }
}

/** Cancel the body without reading a byte of it. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed, or a stub with no cancellable body */
  }
}

async function checkUrlSource(
  value: string,
  ctx: { fetchImpl: typeof fetch; env: NodeJS.ProcessEnv }
): Promise<Check> {
  const trustedOwner = ctx.env.GITHUB_OWNER;
  if (trustedOwner && value.includes(`github.com/${trustedOwner}/`)) {
    return {
      outcome: "skipped",
      method: "trusted-github",
      detail: `trusted GITHUB_OWNER "${trustedOwner}" — not network-validated`,
    };
  }

  // GET, never HEAD: a presigned URL is signed for one method and it is almost
  // always GET. Range: bytes=0-0 keeps it to a single byte; the URL itself is
  // never modified (an extra query param would break the signature) and no
  // other header is added (If-Range etc. would too).
  let method = "GET (Range 0-0)";
  try {
    let res = await ctx.fetchImpl(value, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
    await discardBody(res);

    // 403 can mean "Range is not in the signed headers"; 416 means the object is
    // empty or the origin dislikes the range. Both are worth one plain retry.
    if (res.status === 403 || res.status === 416) {
      method = "GET";
      res = await ctx.fetchImpl(value, { method: "GET", signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
      await discardBody(res);
    }

    // 200 (plain GET) and 206 (satisfied Range) are the expected successes.
    if (res.status >= 200 && res.status < 300) {
      return { outcome: "verified", method, detail: `URL readable — ${method} -> ${res.status}: ${redactUrl(value)}` };
    }

    const gone = res.status === 404 || res.status === 410;
    return {
      outcome: gone ? "definitive" : "transient",
      method,
      detail: `URL unreachable — ${method} -> ${res.status}: ${redactUrl(value)}`,
    };
  } catch (err) {
    const name = (err as Error)?.name || "Error";
    const message = (err as Error)?.message || "";
    return {
      outcome: "transient",
      method,
      // undici echoes the request URL into some messages — redact it too.
      detail:
        `URL unreachable — ${method} -> ${name}: ${redactUrl(value)}` +
        (message ? ` — ${redactUrl(message)}` : ""),
    };
  }
}

function markerFor(check: Check, checkedAt: string): SourceVerification {
  return {
    status: check.outcome === "verified" ? "verified" : check.outcome === "skipped" ? "skipped" : "unverified",
    method: check.method,
    ...(check.detail ? { detail: check.detail } : {}),
    checkedAt,
  };
}

/**
 * Check that every intake source is reachable BEFORE starting the workflow, and
 * stamp each one with what we actually learned. See the block comment above for
 * why a failure is no longer automatically a rejection.
 */
export async function validateIntakeSources(
  sources: IntakeSource[],
  opts: ValidateIntakeSourcesOptions = {}
): Promise<SourceValidationResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const list = sources ?? [];

  const isS3 = (s: IntakeSource) => typeof s?.value === "string" && s.value.startsWith("s3://");
  const hasS3 = list.some(isS3);

  const region = resolveRegion(env);
  const s3 = hasS3 ? opts.s3Client ?? new S3Client({ region }) : undefined;
  // STS is only worth a round-trip when an s3:// source is actually present.
  const hubBucket =
    opts.hubBucket ?? (hasS3 ? await resolveHubBucket({ env, stsClient: opts.stsClient }) : undefined);
  // Resolved at call time, not module load, so a test can stub global.fetch.
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? ((input, init) => globalThis.fetch(input as RequestInfo | URL, init));

  const checks = list.map(async (source): Promise<SourceCheckResult> => {
    const value = typeof source?.value === "string" ? source.value : "";
    let check: Check;
    if (value.startsWith("s3://")) {
      check = await checkS3Source(value, { s3, hubBucket });
    } else if (value.startsWith("http://") || value.startsWith("https://")) {
      check = await checkUrlSource(value, { fetchImpl, env });
    } else {
      // type "upload" (or anything without a network locator) — the content is
      // already in memory; there is nothing to reach out to.
      check = { outcome: "skipped", method: "none", detail: "upload — in memory, not network-validated" };
    }
    const checkedAt = now().toISOString();
    return { source, ...check, checkedAt, verification: markerFor(check, checkedAt) };
  });

  const settled = await Promise.allSettled(checks);
  const results: SourceCheckResult[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const check: Check = {
      outcome: "transient",
      method: "unknown",
      detail: `Validation error: ${redactUrl(String(r.reason))}`,
    };
    const checkedAt = now().toISOString();
    return { source: list[i], ...check, checkedAt, verification: markerFor(check, checkedAt) };
  });

  return {
    results,
    definitiveErrors: results.filter((r) => r.outcome === "definitive").map((r) => r.detail ?? "source rejected"),
    transientErrors: results.filter((r) => r.outcome === "transient").map((r) => r.detail ?? "source unverified"),
    // Caller-supplied `verification` is DROPPED, not merged — a submitter must
    // not be able to hand us verification.status="verified" and skip the check.
    sources: results.map(({ source, verification }) => {
      const { verification: _forged, ...rest } = source ?? ({} as IntakeSource);
      return { ...rest, verification } as IntakeSource;
    }),
  };
}
