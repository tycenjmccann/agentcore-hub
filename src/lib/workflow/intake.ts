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
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";
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

/**
 * A dns.lookup(hostname, { all: true }) seam so tests can inject resolved
 * addresses without touching the network (mirrors the fetchImpl injection).
 * The shape is the subset we use of Node's LookupAddress[].
 */
export type LookupImpl = (
  hostname: string
) => Promise<ReadonlyArray<{ address: string; family?: number }>>;

/**
 * The connect-time pin factory (TEAM-4115). Injectable only so a test can observe
 * / substitute the dispatcher; production always uses createPinnedDispatcher.
 */
export type DispatcherFactory = (host: string, addresses: readonly string[]) => Agent;

export interface ValidateIntakeSourcesOptions {
  /** Injected for tests; defaults to a real S3Client in the resolved region. */
  s3Client?: AwsClientLike;
  /** Injected for tests; defaults to globalThis.fetch looked up at CALL time. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to dns.lookup(host, { all: true }). */
  lookupImpl?: LookupImpl;
  /** Injected for tests; defaults to createPinnedDispatcher. */
  dispatcherFactory?: DispatcherFactory;
  env?: NodeJS.ProcessEnv;
  /** Skips hub-bucket resolution entirely (and therefore STS). */
  hubBucket?: string;
  stsClient?: AwsClientLike;
  now?: () => Date;
}

const URL_TIMEOUT_MS = 10_000;

/**
 * TEAM-4101 r2-F2: hard ceiling on the pre-fetch DNS lookup. A hung resolver
 * must not eat into the 10s-per-source fetch budget; the lookup is a cheap gate,
 * not the work. Same bounded-race-with-cleared-timer pattern as probeAccountId.
 */
export const DNS_LOOKUP_TIMEOUT_MS = 2_000;

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

// ─── SSRF gate for the URL check (TEAM-4091 F1 + TEAM-4101 r2-F2 + TEAM-4115) ─
//
// checkUrlSource issues a SERVER-SIDE GET to a caller-supplied URL and persists
// the status code into verification.detail, which the submitter reads back. That
// is a blind status oracle for anything the ECS task can reach — most sharply
// http://169.254.169.254/ (the instance metadata endpoint) and the VPC's private
// ranges. The submission route has no auth under AUTH_MODE=none.
//
// SCOPE, EXPLICITLY:
//  - LITERAL hosts are blocked outright by urlGate (127.0.0.1, [::1], fc00::/7,
//    169.254.169.254, …). WHATWG URL already normalizes the obfuscated numeric
//    forms (http://0x7f000001/ and http://127.1/ both give hostname "127.0.0.1"),
//    so testing url.hostname after parsing covers them.
//  - NON-literal hosts are now RESOLVED via dns.lookup (TEAM-4101 r2-F2) and
//    rejected if ANY answer is private/link-local/loopback — a public name with an
//    RFC1918/link-local A/AAAA record (or attacker-controlled DNS on this
//    unauthenticated route) was otherwise a legal source and a blind oracle.
//  - DNS-rebinding TOCTOU is now CLOSED (TEAM-4115, ship-review r3-F1). It used
//    to be the accepted residual: undici did its OWN resolution at connect(), so a
//    TTL-0 zone could answer public to our lookup and 169.254.169.254 (or a
//    VPC-internal address) to undici microseconds later — one server-side GET with
//    its status class persisted, i.e. a blind status oracle past the gate. Both
//    fetches now run on a per-check undici Agent whose connector `lookup` returns
//    ONLY the address set this gate just vetted (createPinnedDispatcher), and
//    refuses any other hostname outright. There is no second resolution to race:
//    the socket can only go to an address we already classified as routable. The
//    vetted set is re-classified inside the pin as well, so even a caller that
//    hands over a bad set gets refused before a socket exists.
//
// The blocked-range classifier covers the non-unicast/special-purpose space too
// (multicast, reserved/broadcast, benchmarking, IETF protocol assignments, NAT64
// and 6to4 by their embedded IPv4) — a v6 costume over 127.0.0.1 is still
// 127.0.0.1, and 2002:7f00:1:: / 64:ff9b::7f00:1 are exactly that.

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
  // TEAM-4115: the non-unicast / special-purpose space the pin must also refuse.
  // None of it is a legitimate source host, and a connect to it is either a
  // local-segment broadcast/multicast probe or an on-link special case.
  if (a >= 224 && a <= 239) return "multicast address 224.0.0.0/4";
  if (a >= 240) return "reserved address 240.0.0.0/4";
  if (a === 192 && b === 0 && parts[2] === 0) return "IETF protocol assignments 192.0.0.0/24";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking address 198.18.0.0/15";
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
  // TEAM-4115: 64:ff9b::/96 is the well-known NAT64 prefix — a v6 address that a
  // translator turns straight back into the embedded IPv4, so it must be decided
  // by that IPv4 exactly like the ::ffff: mapped case. 64:ff9b::7f00:1 reaches
  // 127.0.0.1; 64:ff9b::a9fe:a9fe reaches the metadata endpoint.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // 64:ff9b:1::/48 — the local-use translation prefix (RFC 8215). Its lower
    // bits are not a fixed embedded-v4 layout, so refuse the whole /48 outright.
    if (g[2] === 1) return "local-use NAT64 prefix 64:ff9b:1::/48";
    if (g.slice(2, 6).every((x) => x === 0)) {
      const mapped = blockedIpv4Reason(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
      if (mapped) return `NAT64 ${mapped}`;
    }
  }
  // 2002::/16 — 6to4 embeds the IPv4 of the relay in groups 1-2, so 2002:7f00:1::
  // is 127.0.0.1 wearing a v6 costume. Same treatment.
  if (g[0] === 0x2002) {
    const mapped = blockedIpv4Reason(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`);
    if (mapped) return `6to4 ${mapped}`;
  }
  const topByte = g[0] >> 8;
  if (topByte === 0xfc || topByte === 0xfd) return "unique-local address fc00::/7";
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return "link-local address fe80::/10";
  if (topByte === 0xff) return "multicast address ff00::/8";
  return undefined;
}

/**
 * Result of the literal-host gate: either a Check to report (blocked / unparseable),
 * or the canonical host to proceed with (`literal` distinguishes an already-vetted
 * IP literal, which skips the resolver, from a name that still needs one).
 */
type UrlGateResult = { check: Check } | { host: string; literal: boolean };

/**
 * Refuse the URL on its LITERAL host before any socket is opened, and hand back
 * the canonical host for the resolver step. A URL we cannot even parse is
 * definitive — nothing downstream will ever fetch it — mirroring "Invalid S3 URI
 * format".
 */
function urlGate(value: string): UrlGateResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { check: { outcome: "definitive", method: "parse", detail: `Invalid URL format: ${redactUrl(value)}` } };
  }

  const blocked = (reason: string): UrlGateResult => ({
    check: {
      outcome: "definitive",
      method: "parse",
      detail: `Blocked URL host — ${reason}: ${redactUrl(value)}`,
    },
  });

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return blocked(`unsupported scheme ${url.protocol.replace(/:$/, "")}`);
  }
  // URL.hostname brackets an IPv6 literal: "[::1]".
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // Canonicalize the trailing root dot(s) BEFORE any name/literal check (r2-F1):
  // new URL("http://LOCALHOST./").hostname === "localhost." — neither the
  // "localhost" nor the ".localhost" test matched, so the loopback NAME slipped
  // straight through to a server-side GET. WHATWG already strips the dot for an
  // IPv4 literal (new URL("http://127.0.0.1./").hostname === "127.0.0.1"), but
  // net.isIPv4("127.0.0.1.") is false, so we strip defensively for every host —
  // this canonical host is also what is later handed to the resolver (F2).
  const canonicalHost = host.replace(/\.+$/, "");
  if (!canonicalHost) return blocked("empty host");
  if (canonicalHost === "localhost" || canonicalHost.endsWith(".localhost")) {
    return blocked("loopback name localhost");
  }
  const literalV4 = isIPv4(canonicalHost);
  const literalV6 = isIPv6(canonicalHost);
  const reason = literalV4
    ? blockedIpv4Reason(canonicalHost)
    : literalV6
      ? blockedIpv6Reason(canonicalHost)
      : undefined;
  if (reason) return blocked(reason);
  return { host: canonicalHost, literal: literalV4 || literalV6 };
}

/**
 * The one address classifier both the pre-flight resolver and the connect-time
 * pin call, so the two can never disagree about what "blocked" means. A scope id
 * (fe80::1%eth0) is not part of the address; anything that is not an IP at all is
 * refused outright — the pin only ever hands literal addresses to the socket.
 */
function blockedAddressReason(address: string): string | undefined {
  const addr = address.replace(/%.*$/, "");
  return isIPv4(addr) ? blockedIpv4Reason(addr) : isIPv6(addr) ? blockedIpv6Reason(addr) : "non-IP DNS answer";
}

/** Node's dns.lookup callback shape, as undici's `connect.lookup` hook uses it. */
type PinnedLookup = (
  hostname: string,
  // `family` is Node's LookupOptions shape (number | "IPv4" | "IPv6"); we only
  // ever read `all`, but the type has to stay assignable to net.LookupFunction.
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" } | undefined,
  // On the error path undici/net never reads the address argument, but
  // net.LookupFunction types it as non-optional — hence the union rather than `?`.
  callback: (
    err: NodeJS.ErrnoException | null,
    addressOrAll: string | Array<{ address: string; family: number }>,
    family?: number
  ) => void
) => void;

/** Metadata the pin hangs on its dispatcher so tests can assert what it pinned. */
export const PINNED_META = Symbol("intake.pinnedDispatcher");

export interface PinnedMeta {
  host: string;
  addresses: readonly string[];
  lookup: PinnedLookup;
}

/**
 * TEAM-4115 — the connect-time pin that closes the DNS-rebinding TOCTOU.
 *
 * A `lookup` hook for undici's connector that resolves EXACTLY ONE hostname to
 * EXACTLY the address set the pre-flight resolver already vetted, and never
 * consults system DNS. Two independent refusals, both before any socket exists:
 *
 *  - a request for any other hostname (a redirect we did not follow, a
 *    connection-reuse mix-up) errors out rather than resolving;
 *  - every vetted address is re-run through blockedAddressReason. The vetted set
 *    comes from our own resolver, so this is belt-and-braces — but it is what
 *    makes the pin safe even if a future caller hands it a bad set, and it is the
 *    invariant the adversarial test pins.
 *
 * `skipRangeRecheck` exists ONLY for the real-socket integration test, which has
 * to pin to 127.0.0.1 to have a server to talk to. Nothing in the app sets it.
 */
export function buildPinnedLookup(
  host: string,
  addresses: readonly string[],
  opts: { skipRangeRecheck?: boolean } = {}
): PinnedLookup {
  const pinnedHost = host.replace(/\.+$/, "").toLowerCase();
  return (hostname, options, callback) => {
    const asked = String(hostname ?? "")
      .replace(/\.+$/, "")
      .toLowerCase();
    if (asked !== pinnedHost) {
      callback(new Error("Blocked URL host — connect to unvetted host refused"), "");
      return;
    }
    const vetted: Array<{ address: string; family: number }> = [];
    for (const address of addresses) {
      if (!opts.skipRangeRecheck) {
        const reason = blockedAddressReason(address);
        if (reason) {
          callback(new Error(`Blocked URL host — ${reason}`), "");
          return;
        }
      }
      const family = isIPv4(address) ? 4 : isIPv6(address) ? 6 : 0;
      if (family === 0) {
        callback(new Error("Blocked URL host — non-IP address refused"), "");
        return;
      }
      vetted.push({ address, family });
    }
    if (vetted.length === 0) {
      callback(new Error("Blocked URL host — no vetted address"), "");
      return;
    }
    if (options?.all) callback(null, vetted);
    else callback(null, vetted[0].address, vetted[0].family);
  };
}

/**
 * An undici Agent whose connector resolves `host` only to `addresses`.
 *
 * WHY an npm `undici` Agent handed to Node's GLOBAL fetch via the non-standard
 * `init.dispatcher`, rather than undici's own fetch: verified working on the
 * runtime Node (Dockerfile: node:22-alpine) and CI Node 20 — a global-fetch GET
 * to a hostname with NO DNS record SUCCEEDS through this dispatcher, which is
 * itself the proof the pin is honoured (an ignored dispatcher would ENOTFOUND).
 * undici's `buildConnector` spreads unknown `connect` options into BOTH
 * `net.connect` and `tls.connect`, so `lookup` applies to http and https alike,
 * and it sets `servername` AFTER that spread — TLS is still verified against the
 * ORIGINAL hostname, so pinning the address does not weaken certificate checks.
 * The real-socket test in intake.test.ts is the regression guard: if a future
 * Node stops honouring `init.dispatcher`, that test fails loudly instead of the
 * pin silently becoming a no-op.
 */
export function createPinnedDispatcher(
  host: string,
  addresses: readonly string[],
  opts: { skipRangeRecheck?: boolean } = {}
): Agent {
  const lookup = buildPinnedLookup(host, addresses, opts);
  const dispatcher = new Agent({
    connect: { lookup, timeout: DNS_LOOKUP_TIMEOUT_MS },
    // One source check is one request; no reason to hold a pool open.
    pipelining: 0,
  });
  Object.defineProperty(dispatcher, PINNED_META, {
    value: { host, addresses: [...addresses], lookup } satisfies PinnedMeta,
    enumerable: false,
  });
  return dispatcher;
}

/**
 * Resolve a NON-literal host and refuse it if ANY answer is a blocked address
 * (r2-F2). Bounded by DNS_LOOKUP_TIMEOUT_MS with the same race-and-always-clear
 * pattern as probeAccountId. Returns a Check to report, or the vetted address set
 * for the caller to PIN the connection to (TEAM-4115) — only a fully routable
 * answer set gets that far.
 *
 * The resolved IP is NEVER put in the detail: the string is fixed and, like every
 * other detail, goes through redactUrl.
 */
async function resolveHostGuard(
  host: string,
  value: string,
  lookupImpl: LookupImpl
): Promise<{ check: Check } | { addresses: string[] }> {
  const transient = (reason: string): { check: Check } => ({
    check: {
      outcome: "transient",
      method: "DNS",
      detail: `URL unreachable — DNS -> ${reason}: ${redactUrl(value)}`,
    },
  });

  const TIMED_OUT = Symbol("dns-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: ReadonlyArray<{ address: string; family?: number }>;
  try {
    const raced = await Promise.race([
      lookupImpl(host),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (raced === TIMED_OUT) return transient("timeout");
    addresses = raced;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const name = (err as Error)?.name;
    return transient(code || name || "Error");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!addresses || addresses.length === 0) return transient("no addresses");

  const vetted: string[] = [];
  for (const { address } of addresses) {
    // fe80::1%eth0 → fe80::1 — a scope/zone id is not part of the address.
    const addr = address.replace(/%.*$/, "");
    if (blockedAddressReason(addr)) {
      return {
        check: {
          outcome: "definitive",
          method: "parse",
          detail: `Blocked URL host — resolves to a private/link-local address: ${redactUrl(value)}`,
        },
      };
    }
    vetted.push(addr);
  }
  // The addresses the GET is now PINNED to (TEAM-4115) — the record cannot be
  // swapped underneath us between this lookup and undici's connect().
  return { addresses: vetted };
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
  ctx: {
    fetchImpl: typeof fetch;
    lookupImpl: LookupImpl;
    env: NodeJS.ProcessEnv;
    dispatcherFactory?: DispatcherFactory;
  }
): Promise<Check> {
  // FIRST, before even the trusted-owner shortcut: a blocked literal host must
  // never be labelled "trusted" on the strength of a path that spells out
  // github.com/<owner>/.
  const gate = urlGate(value);
  if ("check" in gate) return gate.check;

  // THEN resolve a non-literal host and vet every answer — still BEFORE the
  // trusted-owner shortcut and the GET, so a name that resolves into a private
  // range can neither be labelled "trusted" nor reached. Literal hosts were
  // already vetted above and skip the resolver entirely: their vetted set is the
  // literal itself.
  let vettedAddresses: readonly string[] = [gate.host];
  if (!gate.literal) {
    const resolved = await resolveHostGuard(gate.host, value, ctx.lookupImpl);
    if ("check" in resolved) return resolved.check;
    vettedAddresses = resolved.addresses;
  }

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
  //
  // TEAM-4115: BOTH fetches ride the same connect-time pin, built from the set
  // the gate/resolver just vetted, so undici can no longer re-resolve the name
  // and land on 169.254.169.254 (the DNS-rebinding TOCTOU). `dispatcher` is
  // non-standard on RequestInit, hence the cast; stub fetchImpls in tests simply
  // ignore it.
  let method = "GET (Range 0-0)";
  const dispatcher = (ctx.dispatcherFactory ?? createPinnedDispatcher)(gate.host, vettedAddresses);
  try {
    let res = await ctx.fetchImpl(value, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "manual",
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
      dispatcher,
    } as RequestInit);
    await discardBody(res);

    // 403 can mean "Range is not in the signed headers"; 416 means the object is
    // empty or the origin dislikes the range. Both are worth one plain retry.
    if (res.status === 403 || res.status === 416) {
      method = "GET";
      res = await ctx.fetchImpl(value, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
        dispatcher,
      } as RequestInit);
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
    // A pin refusal surfaces as fetch's opaque TypeError with the real reason on
    // `cause` — carry that through so "connect to unvetted host refused" is not
    // laundered into a bare "fetch failed".
    const cause = (err as { cause?: { message?: string } })?.cause?.message || "";
    return {
      outcome: "transient",
      method,
      // undici echoes the request URL into some messages — redact it too.
      detail:
        `URL unreachable — ${method} -> ${name}: ${redactUrl(value)}` +
        (message ? ` — ${redactUrl(message)}` : "") +
        (cause && cause !== message ? ` — ${redactUrl(cause)}` : ""),
    };
  } finally {
    // Never leak a socket or the connector's keep-alive timer: an unclosed Agent
    // keeps vitest's event loop alive and the ECS task's fd count climbing.
    try {
      await dispatcher.close();
    } catch {
      try {
        await dispatcher.destroy();
      } catch {
        /* already gone */
      }
    }
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
  // Same call-time resolution for the DNS seam (TEAM-4101 r2-F2).
  const lookupImpl: LookupImpl = opts.lookupImpl ?? ((h) => dnsLookup(h, { all: true }));

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
      check = await checkUrlSource(value, {
        fetchImpl,
        lookupImpl,
        env,
        dispatcherFactory: opts.dispatcherFactory,
      });
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
