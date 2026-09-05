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

import { isIPv4, isIPv6 } from "node:net";
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

/**
 * TEAM-4079 F3: hard ceiling on the account-id probe. Its ONLY product is the
 * "(hub bucket)" / "(external bucket)" label in an S3 detail string, so it has
 * no claim on the 10s-per-source budget — an unreachable STS endpoint used to
 * hang every source check (URL fetches included) behind SDK defaults of 3
 * attempts with no request timeout.
 */
export const HUB_BUCKET_PROBE_TIMEOUT_MS = 2_000;

/** Memoized only for the DEFAULT (non-injected) STS client, so tests that pass
 *  their own stub always get a fresh call. SUCCESSES ONLY — see probeAccountId. */
let defaultAccountIdProbe: Promise<string | undefined> | null = null;

/** TEST-ONLY. Drops the memoized default-path probe so a test starts cold.
 *  Nothing in the app should call this. */
export function __resetHubBucketProbeCacheForTests(): void {
  defaultAccountIdProbe = null;
}

async function probeAccountId(
  region: string,
  stsClient?: AwsClientLike
): Promise<string | undefined> {
  const run = async (client: AwsClientLike) => {
    // Race the call against a hard timer: an injected stub or a hung endpoint
    // must not outlive HUB_BUCKET_PROBE_TIMEOUT_MS. The timer is always cleared
    // so a settled probe can never hold the event loop open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client
          .send(new GetCallerIdentityCommand({}))
          .then((res) => ((res as { Account?: string })?.Account as string | undefined) || undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), HUB_BUCKET_PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // No credentials / no sts:GetCallerIdentity / network. The hub bucket is
      // then simply unknown — that only costs us the "(hub bucket)" label, it
      // must never fail a submission.
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  if (stsClient) return run(stsClient);
  if (!defaultAccountIdProbe) {
    // maxAttempts:1 + a bounded requestHandler so the transport agrees with the
    // race above instead of retrying underneath it.
    const pending = run(
      new STSClient({
        region,
        maxAttempts: 1,
        requestHandler: {
          requestTimeout: HUB_BUCKET_PROBE_TIMEOUT_MS,
          connectionTimeout: HUB_BUCKET_PROBE_TIMEOUT_MS,
        },
      })
    );
    defaultAccountIdProbe = pending;
    // NEVER cache a failure. One transient STS blip at cold start used to cost
    // the label for the whole process lifetime; only a real account id sticks.
    // (run() never rejects, so this handler needs no catch.)
    void pending.then((account) => {
      if (!account && defaultAccountIdProbe === pending) defaultAccountIdProbe = null;
    });
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

/** Compare error strings by content only: "Access Denied" ≡ "AccessDenied" ≡ "access_denied". */
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * TEAM-4089: the SDK's placeholder message strings are "UnknownError" AND the
 * bare "Unknown" — which one you get depends on the protocol implementation and
 * the SDK minor, and either can land in `name` or in `message`:
 *   - @smithy/core/dist-es/submodules/client/smithy-client/exceptions.js:46
 *     decorateServiceException -> `message || Message || "UnknownError"`
 *   - .../smithy-client/default-error-handler.js:6 throwDefaultError -> the NAME
 *     falls back to `errorCode || statusCode || "UnknownError"`, which is how a
 *     bodiless HEAD 403 arrives as name "403"
 *   - @aws-sdk/core/dist-es/submodules/protocols/xml/AwsRestXmlProtocol.js:53
 *     `loadRestXmlErrorCode(...) ?? "Unknown"` (parseXmlBody.js:36 returns
 *     undefined when there is no body to parse), and :70 / ProtocolLib.js:58
 *     fall back to "UnknownError"
 * A bodiless HeadObject 403 was observed live (QA TEAM-4064) as
 * name "403" / message "Unknown" / $metadata.httpStatusCode 403.
 * So don't match one exact literal: drop any message that is a placeholder, or
 * that merely repeats what the detail already prints (the name or the status).
 */
function isUninformativeMessage(
  rawMessage: string,
  ctx: { errName: string; rawName: string; status: number | undefined }
): boolean {
  const normalized = normalizeToken(rawMessage);
  if (!normalized) return true;
  const uninformative = new Set(["unknown", "unknownerror"]);
  for (const name of UNINFORMATIVE_ERROR_NAMES) uninformative.add(normalizeToken(name));
  uninformative.add(normalizeToken(ctx.errName));
  uninformative.add(normalizeToken(ctx.rawName));
  if (ctx.status !== undefined) uninformative.add(normalizeToken(String(ctx.status)));
  uninformative.delete("");
  return uninformative.has(normalized);
}

const ACCESS_DENIED_HINT =
  " — validator role has no read access to this bucket; runtime agents in the hub account will need a " +
  "bucket policy grant, or upload the object to the hub artifacts bucket instead";

async function checkS3Source(
  value: string,
  // hubBucket is a PROMISE (TEAM-4079 F3): it is awaited lazily, only on the one
  // path that prints the label, so nothing here queues behind the STS probe.
  ctx: { s3: AwsClientLike | undefined; hubBucket: Promise<string | undefined> }
): Promise<Check> {
  const match = value.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return { outcome: "definitive", method: "parse", detail: `Invalid S3 URI format: ${redactUrl(value)}` };
  }
  const [, bucket, key] = match;

  if (!ctx.s3) {
    // Only reachable if a caller passes an s3:// source with a hand-built ctx.
    return { outcome: "transient", method: "HeadObject", detail: `S3 client unavailable: ${redactUrl(value)}` };
  }

  try {
    // ALWAYS a real HeadObject, hub bucket included. The old "trust our own
    // bucket" short-circuit meant a wrong key in our own bucket sailed through
    // to an agent that then could not read it.
    // The label resolves CONCURRENTLY with the HeadObject, and only the success
    // branch needs it — an error detail never mentions the scope.
    const [, hubBucket] = await Promise.all([
      ctx.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      ctx.hubBucket,
    ]);
    const scope = hubBucket && bucket === hubBucket ? "hub bucket" : "external bucket";
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

    // "UnknownError" and "Unknown" are the bodiless-HEAD artefacts — neither may
    // ever reach the operator. Both the name and message slots go through the
    // same normalizing check (see isUninformativeMessage) rather than a raw Set
    // lookup — TEAM-4105: UNINFORMATIVE_ERROR_NAMES holds "UnknownError" but not
    // the bare "Unknown" the SDK also produces, so the raw .has() let it through.
    // Anything genuinely informative ("must be addressed using the specified
    // endpoint…", a credentials or ECONNREFUSED text) still rides along.
    const extras: string[] = [];
    if (rawName && rawName !== errName && !isUninformativeMessage(rawName, { errName, rawName: "", status })) {
      extras.push(rawName);
    }
    if (!isUninformativeMessage(rawMessage, { errName, rawName, status })) extras.push(rawMessage);

    const detail =
      `S3 object ${label} — HeadObject -> ${errName} (${status ?? "no status"}): ${redactUrl(value)}` +
      (extras.length ? ` — ${extras.map(redactUrl).join(" — ")}` : "") +
      (is403 ? ACCESS_DENIED_HINT : "");

    return { outcome, method: "HeadObject", detail };
  }
}

// ─── SSRF gate for the URL check (TEAM-4091 F1) ──────────────────────────────
//
// checkUrlSource issues a SERVER-SIDE GET to a caller-supplied URL and persists
// the status code into verification.detail, which the submitter reads back. That
// is a blind status oracle for anything the ECS task can reach — most sharply
// http://169.254.169.254/ (the instance metadata endpoint) and the VPC's private
// ranges. The submission route has no auth under AUTH_MODE=none.
//
// SCOPE, EXPLICITLY: only LITERAL hosts are blocked. A hostname that RESOLVES to
// a private address — DNS rebinding, or a public name with an RFC1918 A record —
// is OUT OF SCOPE for this check, because fetch gives us no hook between
// resolution and connect. This closes the trivially-typed oracle, not every SSRF
// avenue. Note that WHATWG URL already normalizes the obfuscated numeric forms
// (http://0x7f000001/ and http://127.1/ both give hostname "127.0.0.1"), so
// testing url.hostname after parsing covers them.

/** Blocked IPv4 range, or undefined for a routable literal. */
function blockedIpv4Reason(host: string): string | undefined {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  const [a, b] = parts;
  if (a === 127) return "loopback address 127.0.0.0/8";
  if (a === 10) return "private address 10.0.0.0/8";
  if (a === 172 && b >= 16 && b <= 31) return "private address 172.16.0.0/12";
  if (a === 192 && b === 168) return "private address 192.168.0.0/16";
  if (a === 169 && b === 254) return "link-local address 169.254.0.0/16 (instance metadata)";
  if (a === 0) return "unspecified address 0.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "shared address space 100.64.0.0/10";
  return undefined;
}

/** Expand an IPv6 literal (already validated by isIPv6) to its 8 groups. */
function expandIpv6(host: string): number[] | undefined {
  let s = host.toLowerCase();
  // A trailing dotted quad (::ffff:127.0.0.1) becomes the last two groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return undefined;
    s = s.slice(0, v4.index) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

/** Blocked IPv6 range, or undefined for a routable literal. */
function blockedIpv6Reason(host: string): string | undefined {
  const g = expandIpv6(host);
  if (!g) return undefined;
  if (g.every((x) => x === 0)) return "unspecified address ::";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback address ::1";
  // ::ffff:a.b.c.d — an IPv4-mapped address is decided by the mapped v4 address,
  // in either the dotted or the hex spelling (::ffff:7f00:1 === ::ffff:127.0.0.1).
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const mapped = blockedIpv4Reason(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    if (mapped) return `IPv4-mapped ${mapped}`;
  }
  const topByte = g[0] >> 8;
  if (topByte === 0xfc || topByte === 0xfd) return "unique-local address fc00::/7";
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return "link-local address fe80::/10";
  return undefined;
}

/**
 * Refuse the URL before any socket is opened. Returns the Check to report, or
 * undefined when the URL is allowed. A URL we cannot even parse is definitive —
 * nothing downstream will ever fetch it — mirroring "Invalid S3 URI format".
 */
function urlGate(value: string): Check | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { outcome: "definitive", method: "parse", detail: `Invalid URL format: ${redactUrl(value)}` };
  }

  const blocked = (reason: string): Check => ({
    outcome: "definitive",
    method: "parse",
    detail: `Blocked URL host — ${reason}: ${redactUrl(value)}`,
  });

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return blocked(`unsupported scheme ${url.protocol.replace(/:$/, "")}`);
  }
  // URL.hostname brackets an IPv6 literal: "[::1]".
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return blocked("loopback name localhost");
  const reason = isIPv4(host) ? blockedIpv4Reason(host) : isIPv6(host) ? blockedIpv6Reason(host) : undefined;
  return reason ? blocked(reason) : undefined;
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
  // FIRST, before even the trusted-owner shortcut: a blocked literal host must
  // never be labelled "trusted" on the strength of a path that spells out
  // github.com/<owner>/.
  const gate = urlGate(value);
  if (gate) return gate;

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
  // redirect:"manual" on BOTH calls (TEAM-4091 F1) — following a redirect hands
  // the destination back to the caller and walks straight past urlGate, which only
  // ever saw the URL that was submitted.
  let method = "GET (Range 0-0)";
  try {
    let res = await ctx.fetchImpl(value, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "manual",
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
    await discardBody(res);

    // 403 can mean "Range is not in the signed headers"; 416 means the object is
    // empty or the origin dislikes the range. Both are worth one plain retry.
    if (res.status === 403 || res.status === 416) {
      method = "GET";
      res = await ctx.fetchImpl(value, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
      });
      await discardBody(res);
    }

    // 200 (plain GET) and 206 (satisfied Range) are the expected successes.
    if (res.status >= 200 && res.status < 300) {
      return { outcome: "verified", method, detail: `URL readable — ${method} -> ${res.status}: ${redactUrl(value)}` };
    }

    // Unfollowed by design: the redirect target is unvalidated, so "could not
    // verify" is the honest answer rather than a status read from somewhere else.
    if (res.status >= 300 && res.status < 400) {
      return {
        outcome: "transient",
        method,
        detail: `URL redirected — ${method} -> ${res.status}: ${redactUrl(value)}`,
      };
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
  // STARTED, NEVER AWAITED HERE (TEAM-4079 F3): awaiting it before the map meant
  // every check — URL GETs and in-memory uploads included — sat behind STS. The
  // .catch keeps it non-rejecting even when no s3:// source ever consumes it, so
  // an unconsumed probe can't surface as an unhandled rejection.
  const hubBucketPromise: Promise<string | undefined> = (
    opts.hubBucket !== undefined
      ? Promise.resolve(opts.hubBucket)
      : hasS3
        ? resolveHubBucket({ env, stsClient: opts.stsClient })
        : Promise.resolve(undefined)
  ).catch(() => undefined);
  // Resolved at call time, not module load, so a test can stub global.fetch.
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? ((input, init) => globalThis.fetch(input as RequestInfo | URL, init));

  const checks = list.map(async (source): Promise<SourceCheckResult> => {
    const value = typeof source?.value === "string" ? source.value : "";
    let check: Check;
    // The VALUE's locator wins, so an s3:// or http(s):// value is checked
    // whatever `type` claims. Only when the value carries no locator does the
    // declared type decide (TEAM-4079 F4) — it used to fall straight through to
    // "upload — in memory", which told the operator a flat lie about a
    // "www.example.com/spec.pdf" the intake agent could never fetch, and marked
    // it "skipped" (a status reserved for uploads and the trust shortcut).
    if (value.startsWith("s3://")) {
      check = await checkS3Source(value, { s3, hubBucket: hubBucketPromise });
    } else if (value.startsWith("http://") || value.startsWith("https://")) {
      check = await checkUrlSource(value, { fetchImpl, env });
    } else if (source?.type === "s3") {
      // Not an s3:// URI — checkS3Source's parse branch rejects it definitively
      // without touching the client.
      check = await checkS3Source(value, { s3, hubBucket: hubBucketPromise });
    } else if (source?.type === "url") {
      check = {
        outcome: "definitive",
        method: "parse",
        detail: `Unsupported URL scheme — expected http(s)://: ${redactUrl(value)}`,
      };
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
