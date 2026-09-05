import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateIntakeSources,
  getSourceValidationMode,
  shouldRejectSubmission,
  resolveHubBucket,
  HUB_BUCKET_PROBE_TIMEOUT_MS,
  DNS_LOOKUP_TIMEOUT_MS,
  type SourceValidationResult,
  type SourceCheckResult,
} from "./intake";
import { redactUrl } from "./redact";
import type { IntakeSource } from "./types";

// TEAM-4101 r2-F2 added a pre-fetch dns.lookup on every non-literal URL host. The
// DEFAULT resolver (used whenever a test does not inject lookupImpl) is stubbed
// here to answer "a public address", so the pre-existing suite — which hits
// example.com, slow.example.com, github.com, *.s3.amazonaws.com with only
// fetchImpl mocked — stays hermetic and never touches real DNS (slow.example.com
// is NXDOMAIN in the wild, which would otherwise turn a fetch-timeout assertion
// into a DNS transient). Same specifier as intake.ts's import so vitest's builtin
// mock intercepts it. The r2-F2 tests below inject lookupImpl explicitly.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

/**
 * TEAM-4054 in miniature. Every submission carrying `sources` 422'd with
 * "Source validation failed: … — UnknownError":
 *
 *   - a bodiless S3 HEAD 403 leaves err.message = "UnknownError" and puts the
 *     real signal on err.name / err.$metadata.httpStatusCode, and the old code
 *     printed err.message alone;
 *   - URLs were probed with HEAD, which is a guaranteed 403 against a presigned
 *     URL (signed for exactly one method — almost always GET);
 *   - and ANY error rejected the whole submission.
 *
 * These pin all three, plus the redaction that keeps a presigned URL's signature
 * out of the 422 body / logs / persisted row.
 */

// The real shape of an AWS SDK v3 error off a bodiless HEAD: no XML to parse, so
// message is the useless "UnknownError" and name is the bare status code.
const s3Err = (name: string, status?: number, message = "UnknownError") =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

const PRESIGNED =
  "https://agentcore-hub-artifacts-023392223961-us-east-1.s3.amazonaws.com/prd/spec.md" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260905%2Fus-east-1%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260905T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=SECRETSIG";

/** NODE_ENV is required on NodeJS.ProcessEnv; these tests only care about the
 *  vars the validator reads, so the cast lives in one place. */
const envOf = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv;

const src = (type: IntakeSource["type"], value: string, extra: Partial<IntakeSource> = {}): IntakeSource => ({
  type,
  value,
  ...extra,
});

/** Records every fetch call so we can assert HEAD is NEVER issued. */
type FetchCall = { url: string; method: string; headers: Record<string, string>; redirect?: RequestRedirect };
function fakeFetch(responses: Array<{ status: number }>, calls: FetchCall[]) {
  const cancel = vi.fn(async () => undefined);
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, redirect: init?.redirect });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { status: r.status, ok: r.status < 400, body: { cancel } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, cancel };
}

const okS3 = { send: vi.fn(async () => ({ ContentLength: 12 })) };
const throwingS3 = (err: unknown) => ({ send: vi.fn(async () => { throw err; }) });

const only = (r: SourceValidationResult): SourceCheckResult => {
  expect(r.results).toHaveLength(1);
  return r.results[0];
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── (a) hub bucket, readable ────────────────────────────────────────────────

describe("validateIntakeSources — s3 hub bucket", () => {
  it("HeadObject succeeds → verified in both modes", async () => {
    const s3 = { send: vi.fn(async () => ({ ContentLength: 12 })) };
    const r = await validateIntakeSources([src("s3", "s3://hub-bucket/prd/spec.md")], {
      s3Client: s3,
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });
    const c = only(r);
    expect(c.outcome).toBe("verified");
    expect(c.method).toBe("HeadObject");
    expect(c.detail).toContain("(hub bucket)");
    expect(c.verification.status).toBe("verified");
    expect(r.sources[0].verification).toEqual(c.verification);
    // The own-bucket short-circuit is GONE: a real HeadObject is always issued.
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
    expect(shouldRejectSubmission(r, "strict").reject).toBe(false);
  });

  it("labels a bucket that is not the hub's as external", async () => {
    const r = await validateIntakeSources([src("s3", "s3://someone-elses-bucket/x.md")], {
      s3Client: okS3,
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });
    expect(only(r).detail).toContain("(external bucket)");
  });

  it("malformed s3:// URI is a definitive parse failure with no network call", async () => {
    const s3 = { send: vi.fn(async () => ({})) };
    const r = await validateIntakeSources([src("s3", "s3://bucket-only-no-key")], {
      s3Client: s3,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toMatch(/Invalid S3 URI format/);
    expect(s3.send).not.toHaveBeenCalled();
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(true);
  });
});

// ─── (a2) hub bucket resolution is never env-only ────────────────────────────

describe("resolveHubBucket", () => {
  it("prefers ARTIFACT_BUCKET, then AGENTCORE_HUB_ARTIFACT_BUCKET", async () => {
    await expect(resolveHubBucket({ env: envOf({ ARTIFACT_BUCKET: "a" }) })).resolves.toBe("a");
    await expect(
      resolveHubBucket({ env: envOf({ AGENTCORE_HUB_ARTIFACT_BUCKET: "b" }) })
    ).resolves.toBe("b");
  });

  it("derives from the deploy convention when the env var is unset", async () => {
    await expect(
      resolveHubBucket({ env: envOf({ AWS_ACCOUNT_ID: "123456789012", AWS_REGION: "us-east-1" }) })
    ).resolves.toBe("agentcore-hub-artifacts-123456789012-us-east-1");
  });

  it("falls back to STS GetCallerIdentity when no account id is in the env", async () => {
    const sts = { send: vi.fn(async () => ({ Account: "999999999999" })) };
    await expect(
      resolveHubBucket({ env: envOf({ AWS_REGION: "us-west-2" }), stsClient: sts })
    ).resolves.toBe("agentcore-hub-artifacts-999999999999-us-west-2");
    expect(sts.send).toHaveBeenCalledTimes(1);
  });

  it("STS failure → undefined, never a throw", async () => {
    const sts = { send: vi.fn(async () => { throw new Error("no credentials"); }) };
    await expect(resolveHubBucket({ env: envOf({}), stsClient: sts })).resolves.toBeUndefined();
  });

  it("is not consulted at all when no s3:// source is present", async () => {
    const sts = { send: vi.fn(async () => ({ Account: "1" })) };
    const { impl, cancel } = fakeFetch([{ status: 200 }], []);
    await validateIntakeSources([src("url", "https://example.com/spec.md")], {
      fetchImpl: impl,
      stsClient: sts,
      env: envOf({}),
    });
    expect(sts.send).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
});

// ─── (b) presigned URLs: GET with Range, never HEAD ──────────────────────────

describe("validateIntakeSources — presigned URL", () => {
  it("issues GET with Range: bytes=0-0 (never HEAD) and accepts 206", async () => {
    const calls: FetchCall[] = [];
    const { impl, cancel } = fakeFetch([{ status: 206 }], calls);
    const r = await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) });
    const c = only(r);
    expect(c.outcome).toBe("verified");
    expect(c.method).toBe("GET (Range 0-0)");
    expect(c.verification.status).toBe("verified");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.Range).toBe("bytes=0-0");
    // A HEAD against a GET-signed URL is a guaranteed 403 — the original bug.
    expect(calls.some((x) => x.method === "HEAD")).toBe(false);
    // Body cancelled, never read: the "≤1 byte" guarantee.
    expect(cancel).toHaveBeenCalledTimes(1);
    // The URL is passed through untouched (an extra query param breaks the sig).
    expect(calls[0].url).toBe(PRESIGNED);
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
  });

  it("accepts a 200 to the ranged GET too (origin ignored the Range)", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) });
    expect(only(r).outcome).toBe("verified");
    expect(calls).toHaveLength(1);
  });

  it("Range 403 → falls back to a plain GET; 200 → verified via the fallback", async () => {
    const calls: FetchCall[] = [];
    const { impl, cancel } = fakeFetch([{ status: 403 }, { status: 200 }], calls);
    const r = await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) });
    const c = only(r);
    expect(c.outcome).toBe("verified");
    expect(c.method).toBe("GET");
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("GET");
    expect(calls[1].headers.Range).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("416 (empty object) also falls back to a plain GET", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 416 }, { status: 204 }], calls);
    expect(only(await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) })).outcome).toBe(
      "verified"
    );
    expect(calls).toHaveLength(2);
  });

  it("uses globalThis.fetch when no fetchImpl is injected (looked up at call time)", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);
    vi.stubGlobal("fetch", impl);
    const r = await validateIntakeSources([src("url", "https://example.com/spec.md")], { env: envOf({}) });
    expect(only(r).outcome).toBe("verified");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Range).toBe("bytes=0-0");
  });
});

// ─── (c) definitive S3 negatives ─────────────────────────────────────────────

describe("validateIntakeSources — S3 object missing", () => {
  for (const name of ["NotFound", "NoSuchKey", "404"]) {
    it(`${name} → definitive, rejected in BOTH modes`, async () => {
      const r = await validateIntakeSources([src("s3", "s3://hub-bucket/prd/gone.md")], {
        s3Client: throwingS3(s3Err(name, 404)),
        env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
      });
      const c = only(r);
      expect(c.outcome).toBe("definitive");
      expect(c.detail).toMatch(/HeadObject/);
      expect(c.detail).toMatch(/NoSuchKey|NotFound/);
      expect(c.detail).toMatch(/404/);
      expect(c.verification.status).toBe("unverified");
      expect(shouldRejectSubmission(r, "lenient")).toEqual({ reject: true, errors: [c.detail] });
      expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
    });
  }
});

// ─── (d) AccessDenied is transient, and never reads "UnknownError" ───────────

describe("validateIntakeSources — S3 AccessDenied", () => {
  // The live case: the hub runs in account 838829463875 and its task role grants
  // s3:GetObject on its OWN bucket only; the reported source lived in
  // agentcore-hub-artifacts-023392223961-us-east-1 (a different account). A
  // bodiless HEAD 403 arrives as name="403", message="UnknownError".
  for (const err of [s3Err("403", 403, "UnknownError"), s3Err("AccessDenied", 403), s3Err("Forbidden", 403)]) {
    it(`${err.name} → transient; accepted as unverified in lenient mode`, async () => {
      const r = await validateIntakeSources(
        [src("s3", "s3://agentcore-hub-artifacts-023392223961-us-east-1/prd/spec.md")],
        { s3Client: throwingS3(err), env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }) }
      );
      const c = only(r);
      expect(c.outcome).toBe("transient");
      expect(c.detail).toMatch(/HeadObject/);
      expect(c.detail).toMatch(/AccessDenied/);
      expect(c.detail).toMatch(/403/);
      // The whole point of the fix: "UnknownError" is never the reported cause.
      expect(c.detail).not.toMatch(/UnknownError$/);
      expect(c.detail).not.toContain("UnknownError");
      // Cross-account reads fail for the pipeline agents too — say so.
      expect(c.detail).toContain("validator role has no read access");
      expect(c.detail).toContain("bucket policy grant");

      expect(c.verification.status).toBe("unverified");
      expect(c.verification.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
      expect(shouldRejectSubmission(r, "strict")).toEqual({ reject: true, errors: [c.detail] });
    });
  }
});

// ─── (d2) TEAM-4089: no SDK placeholder, no duplicate-of-name, in the detail ──

/**
 * QA TEAM-4064 saw the REAL bodiless 403 off the wire and it did not match the
 * mock every test above uses: name "403", message "Unknown" (not "UnknownError"),
 * $metadata.httpStatusCode 403. The old filter compared against the single
 * literal "UnknownError", so the operator-facing detail read
 *   "… -> AccessDenied (403): s3://… — Unknown — validator role has no read…"
 * i.e. the exact meaningless-SDK-artefact text this feature exists to remove.
 */
describe("validateIntakeSources — S3 error detail carries no SDK placeholder (TEAM-4089)", () => {
  const CROSS_ACCOUNT = "s3://agentcore-hub-artifacts-023392223961-us-east-1/prd/spec.md";
  const denied = (err: unknown) =>
    validateIntakeSources([src("s3", CROSS_ACCOUNT)], {
      s3Client: throwingS3(err),
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });

  it('the real bodiless 403 (name "403", message "Unknown") reports no "Unknown" at all', async () => {
    const c = only(
      await denied(Object.assign(new Error("Unknown"), { name: "403", $metadata: { httpStatusCode: 403 } }))
    );
    expect(c.outcome).toBe("transient");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail).toContain("HeadObject");
    expect(c.detail).toContain("AccessDenied");
    expect(c.detail).toContain("403");
    expect(c.detail).toContain("validator role has no read access");
    // Covers "Unknown" and "UnknownError" in one assertion.
    expect(c.detail).not.toMatch(/Unknown/);
  });

  it("a body-ful 403 does not print AccessDenied twice, once per spelling", async () => {
    const c = only(
      await denied(
        Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
      )
    );
    expect(c.outcome).toBe("transient");
    expect(c.verification.status).toBe("unverified");
    // "AccessDenied (403)" is the label; the message "Access Denied" is the same
    // fact with a space in it, so it must not ride along as an extra.
    expect(c.detail!.match(/AccessDenied/g)).toHaveLength(1);
    expect(c.detail).not.toContain("Access Denied");
    expect(c.detail).toContain("AccessDenied (403)");
  });

  for (const message of ["  unknown  ", "UNKNOWN", "unknown_error", "Unknown Error"]) {
    it(`a case/whitespace variant of the placeholder (${JSON.stringify(message)}) is still dropped`, async () => {
      const c = only(
        await denied(Object.assign(new Error(message), { name: "403", $metadata: { httpStatusCode: 403 } }))
      );
      expect(c.outcome).toBe("transient");
      expect(c.detail!.toLowerCase()).not.toContain("unknown");
    });
  }

  it("a message that only repeats the status code or the name is dropped", async () => {
    const byStatus = only(
      await denied(Object.assign(new Error("403"), { name: "403", $metadata: { httpStatusCode: 403 } }))
    );
    // "403" appears once, in the "(403)" the label already prints.
    expect(byStatus.detail!.match(/403/g)).toHaveLength(1);

    const byName = only(
      await denied(
        Object.assign(new Error("PermanentRedirect"), {
          name: "PermanentRedirect",
          $metadata: { httpStatusCode: 301 },
        })
      )
    );
    expect(byName.detail!.match(/PermanentRedirect/g)).toHaveLength(1);
  });

  it("a genuinely informative message is STILL reported — the filter is not a blanket drop", async () => {
    const endpointMsg = "The bucket you are attempting to access must be addressed using the specified endpoint.";
    const c = only(
      await denied(
        Object.assign(new Error(endpointMsg), { name: "PermanentRedirect", $metadata: { httpStatusCode: 301 } })
      )
    );
    expect(c.outcome).toBe("transient");
    expect(c.detail).toContain(endpointMsg);

    const credsMsg = "Missing credentials in config, if using AWS_CONFIG_FILE, set AWS_SDK_LOAD_CONFIG=1";
    const creds = only(
      await denied(Object.assign(new Error(credsMsg), { name: "CredentialsError" }))
    );
    expect(creds.outcome).toBe("transient");
    expect(creds.detail).toContain(credsMsg);
    expect(creds.detail).toContain("no status");
  });

  it("an error with no message at all still yields a usable detail", async () => {
    const c = only(await denied(Object.assign(new Error(""), { name: "403", $metadata: { httpStatusCode: 403 } })));
    expect(c.detail).toBe(
      `S3 object unreadable — HeadObject -> AccessDenied (403): ${CROSS_ACCOUNT}` +
        " — validator role has no read access to this bucket; runtime agents in the hub account will need a " +
        "bucket policy grant, or upload the object to the hub artifacts bucket instead"
    );
  });

  // TEAM-4105 (TEAM-4089 follow-up): QA proved the REAL live shape is name
  // "Unknown" (not "403") — a bare placeholder the SDK also uses on the NAME
  // slot. UNINFORMATIVE_ERROR_NAMES held "UnknownError" but not "Unknown", and
  // the name slot did a raw Set.has() instead of going through the same
  // normalizing check as the message slot, so "Unknown" rode along as an extra.
  it('the real live shape (name "Unknown", message "UnknownError") reports no "unknown" at all', async () => {
    const c = only(
      await denied(Object.assign(new Error("UnknownError"), { name: "Unknown", $metadata: { httpStatusCode: 403 } }))
    );
    expect(c.outcome).toBe("transient");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail).toContain("HeadObject");
    expect(c.detail).toContain("AccessDenied");
    expect(c.detail).toContain("403");
    expect(c.detail).toContain("validator role has no read access");
    expect(c.detail!.toLowerCase()).not.toContain("unknown");
  });

  it('name "Unknown" AND message "Unknown" together report no "unknown" at all', async () => {
    const c = only(
      await denied(Object.assign(new Error("Unknown"), { name: "Unknown", $metadata: { httpStatusCode: 403 } }))
    );
    expect(c.outcome).toBe("transient");
    expect(c.detail).toContain("HeadObject");
    expect(c.detail).toContain("AccessDenied");
    expect(c.detail).toContain("403");
    expect(c.detail).toContain("validator role has no read access");
    expect(c.detail!.toLowerCase()).not.toContain("unknown");
  });

  it("a case variant on the name slot (\"UNKNOWN\" / \"unknown error\") is still dropped", async () => {
    const c = only(
      await denied(Object.assign(new Error("unknown error"), { name: "UNKNOWN", $metadata: { httpStatusCode: 403 } }))
    );
    expect(c.outcome).toBe("transient");
    expect(c.detail).toContain("HeadObject");
    expect(c.detail).toContain("AccessDenied");
    expect(c.detail).toContain("403");
    expect(c.detail).toContain("validator role has no read access");
    expect(c.detail!.toLowerCase()).not.toContain("unknown");
  });

  it('a name-slot "Unknown" on a 404 is still definitive, with no "unknown" in the detail', async () => {
    const c = only(
      await denied(Object.assign(new Error("UnknownError"), { name: "Unknown", $metadata: { httpStatusCode: 404 } }))
    );
    expect(c.outcome).toBe("definitive");
    expect(c.detail).toContain("NotFound (404)");
    expect(c.detail!.toLowerCase()).not.toContain("unknown");
  });
});

// ─── (e) transient vs definitive elsewhere ──────────────────────────────────

describe("validateIntakeSources — transient failures", () => {
  it("S3 DNS failure → transient, no rejection in lenient mode", async () => {
    const r = await validateIntakeSources([src("s3", "s3://nope/x.md")], {
      s3Client: throwingS3(Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "Error" })),
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });
    const c = only(r);
    expect(c.outcome).toBe("transient");
    expect(c.detail).toContain("S3 object unreachable");
    expect(c.detail).toContain("getaddrinfo ENOTFOUND");
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
  });

  it("S3 5xx → transient", async () => {
    const r = await validateIntakeSources([src("s3", "s3://hub-bucket/x.md")], {
      s3Client: throwingS3(s3Err("InternalError", 500, "We encountered an internal error")),
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });
    expect(only(r).outcome).toBe("transient");
  });

  it("URL fetch that throws TimeoutError → transient", async () => {
    const impl = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const r = await validateIntakeSources([src("url", "https://slow.example.com/spec.md")], {
      fetchImpl: impl,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("transient");
    expect(c.detail).toContain("TimeoutError");
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
    expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
  });

  it("URL 503 → transient, URL 404 and 410 → definitive", async () => {
    const mk = async (status: number) => {
      const { impl } = fakeFetch([{ status }, { status }], []);
      return only(await validateIntakeSources([src("url", "https://example.com/x")], { fetchImpl: impl, env: envOf({}) }));
    };
    expect((await mk(503)).outcome).toBe("transient");
    expect((await mk(429)).outcome).toBe("transient");
    expect((await mk(401)).outcome).toBe("transient");
    // 403 retries plainly and stays transient when the retry also 403s.
    expect((await mk(403)).outcome).toBe("transient");
    expect((await mk(404)).outcome).toBe("definitive");
    expect((await mk(410)).outcome).toBe("definitive");
  });
});

// ─── (f) redaction ──────────────────────────────────────────────────────────

describe("redactUrl", () => {
  it("keeps scheme/host/path and parameter names, drops values", () => {
    expect(redactUrl(PRESIGNED)).toContain("https://agentcore-hub-artifacts-023392223961-us-east-1.s3.amazonaws.com/prd/spec.md?");
    expect(redactUrl(PRESIGNED)).toContain("X-Amz-Signature=REDACTED");
    expect(redactUrl(PRESIGNED)).toContain("X-Amz-Credential=REDACTED");
    expect(redactUrl(PRESIGNED)).not.toContain("SECRETSIG");
    expect(redactUrl(PRESIGNED)).not.toContain("AKIA");
  });

  it("leaves a query-less URL and a non-URL string unchanged", () => {
    expect(redactUrl("https://github.com/tycenjmccann/agentcore-hub")).toBe("https://github.com/tycenjmccann/agentcore-hub");
    expect(redactUrl("s3://bucket/key.md")).toBe("s3://bucket/key.md");
    expect(redactUrl("not a url at all")).toBe("not a url at all");
    expect(redactUrl("")).toBe("");
  });

  it("redacts a URL embedded in a larger message (undici echoes it)", () => {
    const msg = `request to ${PRESIGNED} failed, reason: ECONNREFUSED`;
    expect(redactUrl(msg)).not.toContain("SECRETSIG");
    expect(redactUrl(msg)).toContain("ECONNREFUSED");
  });

  it("preserves the fragment", () => {
    expect(redactUrl("https://h/p?a=1#frag")).toBe("https://h/p?a=REDACTED#frag");
  });
});

describe("validateIntakeSources — no presigned signature ever escapes", () => {
  it("redacts in the verified path and in every failure path", async () => {
    const cases: SourceValidationResult[] = [
      // verified (b)
      await validateIntakeSources([src("url", PRESIGNED)], {
        fetchImpl: fakeFetch([{ status: 206 }], []).impl,
        env: envOf({}),
      }),
      // non-2xx
      await validateIntakeSources([src("url", PRESIGNED)], {
        fetchImpl: fakeFetch([{ status: 404 }], []).impl,
        env: envOf({}),
      }),
      // thrown, with the URL echoed back inside err.message
      await validateIntakeSources([src("url", PRESIGNED)], {
        fetchImpl: (async () => {
          throw Object.assign(new Error(`request to ${PRESIGNED} failed`), { name: "TypeError" });
        }) as unknown as typeof fetch,
        env: envOf({}),
      }),
    ];
    for (const r of cases) {
      // Everything that becomes a log line, a 422 detail, or a persisted
      // verification.detail. The source's own `value` is deliberately NOT
      // redacted — that is the reference the pipeline agents have to fetch.
      const surfaced = JSON.stringify({
        details: r.results.map((x) => x.detail),
        markers: r.results.map((x) => x.verification.detail),
        definitiveErrors: r.definitiveErrors,
        transientErrors: r.transientErrors,
        persistedMarkers: r.sources.map((x) => x.verification?.detail),
      });
      expect(surfaced).not.toContain("SECRETSIG");
      expect(surfaced).not.toContain("AKIA");
      expect(only(r).detail).toContain("X-Amz-Signature=REDACTED");
      expect(only(r).verification.detail).toContain("X-Amz-Signature=REDACTED");
      // …and the submitted value survives intact for the agents to read.
      expect(r.sources[0].value).toBe(PRESIGNED);
    }
  });
});

// ─── (g) verification is not forgeable ──────────────────────────────────────

describe("validateIntakeSources — caller-supplied verification", () => {
  it("is discarded, not merged: a forged \"verified\" comes back unverified", async () => {
    const forged = src("s3", "s3://external/x.md", {
      label: "spec",
      verification: { status: "verified", method: "trust me", detail: "totally fine" },
    });
    const r = await validateIntakeSources([forged], {
      s3Client: throwingS3(s3Err("403", 403)),
      env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }),
    });
    expect(r.sources[0].verification?.status).toBe("unverified");
    expect(r.sources[0].verification?.method).toBe("HeadObject");
    expect(r.sources[0].verification?.detail).not.toContain("totally fine");
    // The rest of the source survives, and the input object is not mutated.
    expect(r.sources[0].label).toBe("spec");
    expect(forged.verification?.status).toBe("verified");
  });
});

// ─── TEAM-4079 F4: a locator-less value is classified by source.type ────────
//
// The final else-branch used to swallow ANY value without an s3:// / http(s)://
// prefix, whatever `type` said. So {type:"url", value:"www.example.com/spec.pdf"}
// and {type:"s3", value:"my-bucket/prd/spec.md"} were accepted in BOTH modes with
// a detail that claimed "upload — in memory" (a lie) and verification.status
// "skipped" — a status FR-4.4 reserves for uploads and the trusted-owner
// shortcut. The intake agent then could not fetch either one.

describe("validateIntakeSources — locator-less value classified by type (F4)", () => {
  it("type url with a scheme-less value → definitive, no fetch attempted", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const s3 = { send: vi.fn() };
    const r = await validateIntakeSources([src("url", "www.example.com/spec.pdf")], {
      fetchImpl: impl,
      s3Client: s3,
      env: envOf({}),
    });

    const c = only(r);
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail).toContain("Unsupported URL scheme");
    expect(c.detail).toContain("www.example.com/spec.pdf");
    // No longer the false "in memory" claim.
    expect(c.detail).not.toContain("in memory");
    expect(r.definitiveErrors).toEqual([c.detail]);
    // Nothing to fetch — a scheme-less value is not a request we can make.
    expect(calls).toHaveLength(0);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("type s3 with a bucket/key value (no s3:// scheme) → definitive, S3 client untouched", async () => {
    const s3 = { send: vi.fn() };
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources([src("s3", "my-bucket/prd/spec.md")], {
      s3Client: s3,
      fetchImpl: impl,
      env: envOf({}),
    });

    const c = only(r);
    expect(c.outcome).toBe("definitive");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail?.startsWith("Invalid S3 URI format")).toBe(true);
    expect(c.detail).toContain("my-bucket/prd/spec.md");
    expect(c.detail).not.toContain("in memory");
    expect(r.definitiveErrors).toEqual([c.detail]);
    expect(s3.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("GUARD: type upload is untouched — still skipped/in-memory", async () => {
    const s3 = { send: vi.fn() };
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources([src("upload", "spec.pdf contents…")], {
      s3Client: s3,
      fetchImpl: impl,
      env: envOf({}),
    });

    const c = only(r);
    expect(c.outcome).toBe("skipped");
    expect(c.method).toBe("none");
    expect(c.verification.status).toBe("skipped");
    expect(c.detail).toBe("upload — in memory, not network-validated");
    expect(r.definitiveErrors).toEqual([]);
    expect(r.transientErrors).toEqual([]);
    expect(s3.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a locator-carrying value still wins over the declared type", async () => {
    // type "upload" but the value IS an s3:// URI — the value must be checked.
    const s3 = { send: vi.fn(async () => ({ ContentLength: 1 })) };
    const r = await validateIntakeSources([src("upload", "s3://hub-bucket/prd/spec.md")], {
      s3Client: s3,
      hubBucket: "hub-bucket",
      env: envOf({}),
    });
    expect(only(r).outcome).toBe("verified");
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it("both are rejected in LENIENT mode — a definitive negative is not a network opinion", async () => {
    const s3 = { send: vi.fn() };
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources(
      [src("url", "www.example.com/spec.pdf"), src("s3", "my-bucket/prd/spec.md"), src("upload", "inline.md")],
      { s3Client: s3, fetchImpl: impl, env: envOf({}) }
    );

    expect(r.results.map((x) => x.outcome)).toEqual(["definitive", "definitive", "skipped"]);
    const decision = shouldRejectSubmission(r, "lenient");
    expect(decision.reject).toBe(true);
    expect(decision.errors).toHaveLength(2);
    expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
  });
});

// ─── (h) no-network paths ───────────────────────────────────────────────────

describe("validateIntakeSources — sources with nothing to reach", () => {
  it("upload → skipped, zero network calls", async () => {
    const s3 = { send: vi.fn() };
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources([src("upload", "design-mock.png")], {
      s3Client: s3,
      fetchImpl: impl,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("skipped");
    expect(c.method).toBe("none");
    expect(c.verification.status).toBe("skipped");
    expect(s3.send).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a GitHub URL under GITHUB_OWNER is trusted → skipped, no fetch", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 200 }], calls);
    const r = await validateIntakeSources([src("url", "https://github.com/tycenjmccann/agentcore-hub/blob/main/README.md")], {
      fetchImpl: impl,
      env: envOf({ GITHUB_OWNER: "tycenjmccann" }),
    });
    const c = only(r);
    expect(c.outcome).toBe("skipped");
    expect(c.method).toBe("trusted-github");
    expect(calls).toHaveLength(0);
  });

  it("no sources → empty result, rejected by nothing", async () => {
    const r = await validateIntakeSources([], { env: envOf({}) });
    expect(r).toEqual({ results: [], definitiveErrors: [], transientErrors: [], sources: [] });
    expect(shouldRejectSubmission(r, "strict").reject).toBe(false);
  });
});

// ─── (i) mode resolution ────────────────────────────────────────────────────

describe("getSourceValidationMode", () => {
  it("defaults to lenient and only exact \"strict\" opts in", () => {
    expect(getSourceValidationMode(envOf({}))).toBe("lenient");
    expect(getSourceValidationMode(envOf({ SOURCE_VALIDATION_MODE: "strict" }))).toBe("strict");
    expect(getSourceValidationMode(envOf({ SOURCE_VALIDATION_MODE: " STRICT " }))).toBe("strict");
    expect(getSourceValidationMode(envOf({ SOURCE_VALIDATION_MODE: "garbage" }))).toBe("lenient");
    expect(getSourceValidationMode(envOf({ SOURCE_VALIDATION_MODE: "" }))).toBe("lenient");
  });
});

// ─── (j) the route-level 422-vs-accept split ────────────────────────────────

/**
 * Why the split is where it is.
 *
 * A definitive negative is a fact about the SOURCE: a malformed s3:// URI, an
 * S3 404/NoSuchKey, an HTTP 404/410. No identity, retry or bucket policy makes
 * those readable, so the submitter is the only one who can fix them and a 422
 * saves the whole run. That is worth blocking on.
 *
 * A transient failure is a fact about the VALIDATOR: the hub's ECS task role is
 * not the role the pipeline agents run under, so its 403 says nothing about
 * whether an agent can read the object; a timeout or 5xx says nothing at all.
 * Rejecting on those is exactly the TEAM-4054 bug — every sourced submission
 * 422'd on a cross-account AccessDenied. Lenient mode accepts them and stamps
 * verification.status="unverified" so the failure is visible on the run instead
 * of fatal at submit; strict mode is the operator opt-in to block anyway.
 */
describe("shouldRejectSubmission", () => {
  const result = (definitiveErrors: string[], transientErrors: string[]): SourceValidationResult => ({
    results: [],
    definitiveErrors,
    transientErrors,
    sources: [],
  });

  it("1 verified + 1 transient → accepted in lenient, rejected in strict", () => {
    const r = result([], ["S3 object unreadable — HeadObject -> AccessDenied (403): s3://x/y"]);
    expect(shouldRejectSubmission(r, "lenient")).toEqual({ reject: false, errors: [] });
    expect(shouldRejectSubmission(r, "strict")).toEqual({ reject: true, errors: r.transientErrors });
  });

  it("1 definitive → rejected in both modes, and strict reports both causes", () => {
    const r = result(["S3 object missing — HeadObject -> NotFound (404): s3://x/y"], ["something flaky"]);
    expect(shouldRejectSubmission(r, "lenient")).toEqual({ reject: true, errors: r.definitiveErrors });
    expect(shouldRejectSubmission(r, "strict")).toEqual({
      reject: true,
      errors: [...r.definitiveErrors, ...r.transientErrors],
    });
  });

  it("all clean → accepted in both modes", () => {
    expect(shouldRejectSubmission(result([], []), "strict").reject).toBe(false);
    expect(shouldRejectSubmission(result([], []), "lenient").reject).toBe(false);
  });
});

// ─── mixed batch: one bad source does not erase the others' markers ─────────

describe("validateIntakeSources — mixed batch", () => {
  it("stamps every source and buckets the errors by kind", async () => {
    const s3 = {
      send: vi.fn(async (cmd: unknown) => {
        const key = (cmd as { input: { Key: string } }).input.Key;
        if (key === "gone.md") throw s3Err("NoSuchKey", 404);
        if (key === "denied.md") throw s3Err("403", 403);
        return { ContentLength: 1 };
      }),
    };
    const r = await validateIntakeSources(
      [
        src("s3", "s3://hub-bucket/ok.md"),
        src("s3", "s3://hub-bucket/gone.md"),
        src("s3", "s3://other/denied.md"),
        src("upload", "inline.md"),
      ],
      { s3Client: s3, env: envOf({ ARTIFACT_BUCKET: "hub-bucket" }) }
    );
    expect(r.results.map((x) => x.outcome)).toEqual(["verified", "definitive", "transient", "skipped"]);
    expect(r.sources.map((x) => x.verification?.status)).toEqual([
      "verified",
      "unverified",
      "unverified",
      "skipped",
    ]);
    expect(r.definitiveErrors).toHaveLength(1);
    expect(r.transientErrors).toHaveLength(1);
    expect(shouldRejectSubmission(r, "lenient").errors).toEqual(r.definitiveErrors);
  });
});

// ─── TEAM-4079 F3: the hub-bucket probe is bounded and never serializing ────
//
// The probe's ONLY product is the "(hub bucket)"/"(external bucket)" label in an
// S3 detail string, yet it was awaited BEFORE the per-source map started, with a
// default STSClient (3 attempts, no request timeout). An unreachable STS endpoint
// therefore stalled every check — URL GETs and in-memory uploads included —
// with nothing bounding it to the 10s/source budget.

/** An STS client whose send() never settles — a hung endpoint, in one line. */
const hangingSts = () => ({ send: vi.fn(() => new Promise<never>(() => {})) });

describe("validateIntakeSources — hub-bucket probe is bounded (F3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) a hung STS probe cannot outlive the probe timeout", async () => {
    vi.useFakeTimers();
    const sts = hangingSts();
    const s3 = { send: vi.fn(async () => ({ ContentLength: 12 })) };

    const pending = validateIntakeSources([src("s3", "s3://some-bucket/prd/spec.md")], {
      s3Client: s3,
      stsClient: sts,
      env: envOf({ AWS_REGION: "us-east-1" }),
    });

    // Nothing but the 2s probe timer stands between us and a result. On the base
    // code this promise never settles and the test times out.
    await vi.advanceTimersByTimeAsync(HUB_BUCKET_PROBE_TIMEOUT_MS + 1);
    const r = await pending;

    const c = only(r);
    expect(c.outcome).toBe("verified");
    // Probe timed out → no hub bucket known → the label degrades, it never fails.
    expect(c.detail).toContain("(external bucket)");
    expect(sts.send).toHaveBeenCalledTimes(1);
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it("(a2) the timeout is well inside the 10s per-source budget in real time", async () => {
    const sts = hangingSts();
    const s3 = { send: vi.fn(async () => ({ ContentLength: 12 })) };
    const started = Date.now();
    const r = await validateIntakeSources([src("s3", "s3://some-bucket/prd/spec.md")], {
      s3Client: s3,
      stsClient: sts,
      env: envOf({ AWS_REGION: "us-east-1" }),
    });
    const elapsed = Date.now() - started;

    expect(only(r).outcome).toBe("verified");
    expect(elapsed).toBeLessThan(5_000); // URL_TIMEOUT_MS is 10s; we are far under
  });

  it("(b) a URL check never waits on the STS probe", async () => {
    const sts = hangingSts();
    const s3 = { send: vi.fn(async () => ({ ContentLength: 12 })) };
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);

    vi.useFakeTimers();
    const pending = validateIntakeSources(
      [src("url", "https://example.com/spec.pdf"), src("s3", "s3://some-bucket/prd/spec.md")],
      { s3Client: s3, stsClient: sts, fetchImpl: impl, env: envOf({ AWS_REGION: "us-east-1" }) }
    );

    // Flush microtasks only — the STS probe is still pending (its timer has not
    // been advanced, and its send() never resolves at all).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.com/spec.pdf");
    expect(calls[0].method).toBe("GET");

    // And the whole batch still completes once the probe timer fires.
    await vi.advanceTimersByTimeAsync(HUB_BUCKET_PROBE_TIMEOUT_MS + 1);
    const r = await pending;
    expect(r.results.map((x) => x.outcome)).toEqual(["verified", "verified"]);
  });

  it("(b2) with NO s3 source the probe is never even started", async () => {
    const sts = hangingSts();
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);

    const r = await validateIntakeSources(
      [src("url", "https://example.com/spec.pdf"), src("upload", "inline.md")],
      { stsClient: sts, fetchImpl: impl, env: envOf({ AWS_REGION: "us-east-1" }) }
    );

    expect(r.results.map((x) => x.outcome)).toEqual(["verified", "skipped"]);
    expect(sts.send).not.toHaveBeenCalled();
  });

  it("an explicit opts.hubBucket short-circuits the probe entirely", async () => {
    const sts = hangingSts();
    const s3 = { send: vi.fn(async () => ({ ContentLength: 1 })) };
    const r = await validateIntakeSources([src("s3", "s3://hub-bucket/prd/spec.md")], {
      s3Client: s3,
      stsClient: sts,
      hubBucket: "hub-bucket",
      env: envOf({}),
    });
    expect(only(r).detail).toContain("(hub bucket)");
    expect(sts.send).not.toHaveBeenCalled();
  });
});

// ─── (g) TEAM-4091 F1: SSRF gate on the URL check ────────────────────────────

/**
 * checkUrlSource issues a SERVER-SIDE GET to a caller-supplied URL and persists
 * the status into verification.detail, which the submitter reads back — a blind
 * status oracle for everything the ECS task can reach, on a route with no auth
 * under AUTH_MODE=none. Two holes: redirects were followed (fetch's default), so
 * the URL actually fetched was not the URL we inspected; and no host was ever
 * refused, so http://169.254.169.254/ was a legal "source".
 *
 * LITERAL hosts are blocked outright by urlGate; a NON-literal host is resolved
 * (TEAM-4101 r2-F2) and rejected if any answer is private/link-local/loopback.
 * The residual is DNS-rebinding TOCTOU (record changes between lookup and connect)
 * — accepted because the oracle is status-only. See the comment on urlGate.
 */
describe("validateIntakeSources — URL redirects are not followed (TEAM-4091 F1)", () => {
  it("a 302 on the ranged GET → transient 'URL redirected', with redirect:manual", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 302 }], calls);
    const r = await validateIntakeSources([src("url", "https://example.com/spec.md")], {
      fetchImpl: impl,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("transient");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail!.startsWith("URL redirected")).toBe(true);
    expect(c.detail).toContain("GET (Range 0-0) -> 302");
    // The redirect is never chased: one call, and it opted out of following.
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe("manual");
    // A redirect is a network opinion, not a fact about the source.
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
    expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
  });

  it("the plain-GET fallback after a 403 also passes redirect:manual", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 403 }, { status: 301 }], calls);
    const c = only(
      await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) })
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].redirect).toBe("manual");
    expect(calls[1].redirect).toBe("manual");
    expect(calls[1].headers.Range).toBeUndefined();
    expect(c.outcome).toBe("transient");
    expect(c.detail!.startsWith("URL redirected")).toBe(true);
    expect(c.detail).toContain("GET -> 301");
    // The signature never reaches the persisted detail.
    expect(c.detail).not.toContain("SECRETSIG");
  });

  it("a 416 fallback that redirects is reported off the fallback's status", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 416 }, { status: 307 }], calls);
    const c = only(
      await validateIntakeSources([src("url", "https://example.com/empty")], { fetchImpl: impl, env: envOf({}) })
    );
    expect(c.detail).toContain("GET -> 307");
    expect(calls.map((x) => x.redirect)).toEqual(["manual", "manual"]);
  });
});

describe("validateIntakeSources — blocked URL hosts (TEAM-4091 F1)", () => {
  /** A fetch that must never be reached; vi.fn so .not.toHaveBeenCalled() is real. */
  const neverFetch = () =>
    vi.fn(async () => ({ status: 206, ok: true, body: { cancel: async () => undefined } }) as unknown as Response);

  const BLOCKED: Array<[string, string]> = [
    ["localhost", "loopback name localhost"],
    ["foo.localhost", "loopback name localhost"],
    ["127.0.0.1", "loopback address 127.0.0.0/8"],
    ["127.42.7.9", "loopback address 127.0.0.0/8"],
    ["10.0.0.1", "private address 10.0.0.0/8"],
    ["172.16.0.1", "private address 172.16.0.0/12"],
    ["172.31.255.255", "private address 172.16.0.0/12"],
    ["192.168.1.1", "private address 192.168.0.0/16"],
    ["169.254.169.254", "link-local address 169.254.0.0/16 (instance metadata)"],
    ["0.0.0.0", "unspecified address 0.0.0.0/8"],
    ["100.64.0.1", "shared address space 100.64.0.0/10"],
    ["[::1]", "loopback address ::1"],
    ["[::]", "unspecified address ::"],
    ["[fc00::1]", "unique-local address fc00::/7"],
    ["[fd12::1]", "unique-local address fc00::/7"],
    ["[fe80::1]", "link-local address fe80::/10"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped loopback address 127.0.0.0/8"],
    ["[::ffff:7f00:1]", "IPv4-mapped loopback address 127.0.0.0/8"],
    ["[::ffff:169.254.169.254]", "IPv4-mapped link-local address 169.254.0.0/16 (instance metadata)"],
  ];

  it.each(BLOCKED)("%s → definitive parse failure, no socket opened", async (host, reason) => {
    const fetchImpl = neverFetch();
    const url = `https://${host}/spec.md`;
    const r = await validateIntakeSources([src("url", url)], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail!.startsWith("Blocked URL host")).toBe(true);
    expect(c.detail).toContain(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Definitive → 422 in every mode, so the oracle is not merely unverified.
    expect(shouldRejectSubmission(r, "lenient")).toEqual({ reject: true, errors: [c.detail] });
    expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
  });

  // r2-F1: a trailing root dot survives WHATWG normalization for a NAME
  // (new URL("http://LOCALHOST./").hostname === "localhost."), so the loopback
  // name checks used to miss it and issue a server-side GET. urlGate now strips
  // trailing dots before the name/literal checks — and does so BEFORE the
  // resolver, so a blocked trailing-dot host never even looks up.
  const TRAILING_DOT: Array<[string, string]> = [
    ["localhost.", "loopback name localhost"],
    ["LOCALHOST.", "loopback name localhost"],
    ["foo.localhost.", "loopback name localhost"],
    ["127.0.0.1.", "loopback address 127.0.0.0/8"],
  ];

  it.each(TRAILING_DOT)("%s (trailing dot) → definitive parse failure, no fetch, no DNS", async (host, reason) => {
    const fetchImpl = neverFetch();
    const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const c = only(
      await validateIntakeSources([src("url", `https://${host}/spec.md`)], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl,
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail!.startsWith("Blocked URL host")).toBe(true);
    expect(c.detail).toContain(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Blocked on the literal host — the resolver is never consulted.
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it("the obfuscated numeric forms are covered by WHATWG normalization", async () => {
    const fetchImpl = neverFetch();
    for (const host of ["0x7f000001", "127.1", "2130706433"]) {
      const c = only(
        await validateIntakeSources([src("url", `http://${host}/latest/meta-data/`)], {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          env: envOf({}),
        })
      );
      expect(c.outcome).toBe("definitive");
      expect(c.detail).toContain("loopback address 127.0.0.0/8");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a loopback host even when the PATH would satisfy the GITHUB_OWNER shortcut", async () => {
    const fetchImpl = neverFetch();
    const c = only(
      await validateIntakeSources([src("url", "https://127.0.0.1/github.com/tycenjmccann/x/README.md")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: envOf({ GITHUB_OWNER: "tycenjmccann" }),
      })
    );
    // The gate runs BEFORE the trusted-owner shortcut, so this is not "trusted".
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toContain("loopback address 127.0.0.0/8");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a non-http(s) scheme never reaches a socket", async () => {
    const fetchImpl = neverFetch();
    // Through the public entry point a "url" source with no http(s):// prefix is
    // already stopped by the TEAM-4079 type dispatch, which is why the detail here
    // is the scheme message rather than "Blocked URL host" — either way it is
    // definitive, and no fetch is issued. urlGate's own scheme branch is the
    // second layer, for any future caller that reaches checkUrlSource directly.
    const c = only(
      await validateIntakeSources([src("url", "ftp://example.com/x")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toContain("Unsupported URL scheme");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const ALLOWED = ["172.32.0.1", "100.128.0.1", "11.0.0.1", "8.8.8.8", "example.com", "[2606:4700::1]"];

  it.each(ALLOWED)("%s is NOT blocked — the ranges are boundaries, not prefixes", async (host) => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);
    const c = only(
      await validateIntakeSources([src("url", `https://${host}/spec.md`)], { fetchImpl: impl, env: envOf({}) })
    );
    expect(c.outcome).toBe("verified");
    expect(calls).toHaveLength(1);
  });

  it("a presigned S3 URL still verifies, untouched and unredirected", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);
    const c = only(await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, env: envOf({}) }));
    expect(c.outcome).toBe("verified");
    expect(calls).toHaveLength(1);
    // Still byte-identical: the gate parses a copy, it never rewrites the URL,
    // and no header beyond Range is added (either would break the signature).
    expect(calls[0].url).toBe(PRESIGNED);
    expect(Object.keys(calls[0].headers)).toEqual(["Range"]);
    expect(calls[0].redirect).toBe("manual");
  });

  it("an unparseable http URL is a definitive parse failure, not a fetch attempt", async () => {
    const fetchImpl = neverFetch();
    const c = only(
      await validateIntakeSources([src("url", "https://")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toContain("Invalid URL format");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ─── (h) TEAM-4101 r2-F2: block hostnames that RESOLVE to a private address ───

/**
 * A literal-only block leaves the oracle wide open: a public name (or attacker
 * DNS on this unauthenticated route) with an A/AAAA record inside a private range
 * — 10.x, 169.254.169.254, fd00::, … — was a legal source, and its status was
 * persisted into verification.detail. checkUrlSource now resolves every
 * non-literal host and refuses it if ANY answer is blocked, BEFORE the GET and
 * before the trusted-owner shortcut. Literal hosts (already vetted by urlGate)
 * skip the resolver. The residual is rebinding TOCTOU — accepted, status-only.
 */
describe("validateIntakeSources — resolved-address block (TEAM-4101 r2-F2)", () => {
  const PRESIGNED_HOST = "agentcore-hub-artifacts-023392223961-us-east-1.s3.amazonaws.com";
  const neverFetch = () =>
    vi.fn(async () => ({ status: 206, ok: true, body: { cancel: async () => undefined } }) as unknown as Response);
  /** A lookup that answers with the given addresses (family inferred from ":"). */
  const lookupTo = (...addrs: string[]) =>
    vi.fn(async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) a public name resolving to 10.0.0.5 is blocked before any fetch", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = lookupTo("10.0.0.5");
    const r = await validateIntakeSources([src("url", "https://attacker.example/x")], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toBe("Blocked URL host — resolves to a private/link-local address: https://attacker.example/x");
    // The resolved IP is never disclosed in the detail.
    expect(c.detail).not.toContain("10.0.0.5");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(true);
  });

  it("(b) a mix of public and private answers is blocked (any blocked address wins)", async () => {
    const fetchImpl = neverFetch();
    const c = only(
      await validateIntakeSources([src("url", "https://attacker.example/x")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: lookupTo("1.2.3.4", "127.0.0.1"),
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.detail).toContain("resolves to a private/link-local address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(c) an all-public answer proceeds to a byte-identical, unredirected GET", async () => {
    const calls: FetchCall[] = [];
    const { impl } = fakeFetch([{ status: 206 }], calls);
    const lookupImpl = lookupTo("93.184.216.34", "2606:4700::1");
    const c = only(await validateIntakeSources([src("url", PRESIGNED)], { fetchImpl: impl, lookupImpl, env: envOf({}) }));
    expect(c.outcome).toBe("verified");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PRESIGNED);
    expect(Object.keys(calls[0].headers)).toEqual(["Range"]);
    expect(calls[0].redirect).toBe("manual");
    // Resolved exactly once, with the parsed host.
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(lookupImpl).toHaveBeenCalledWith(PRESIGNED_HOST);
  });

  it("(d) a lookup that throws ENOTFOUND is transient (unverified), never fetched", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND attacker.example"), { code: "ENOTFOUND" });
    });
    const r = await validateIntakeSources([src("url", "https://attacker.example/x")], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl,
      env: envOf({}),
    });
    const c = only(r);
    expect(c.outcome).toBe("transient");
    expect(c.method).toBe("DNS");
    expect(c.verification.status).toBe("unverified");
    expect(c.detail).toContain("URL unreachable");
    expect(c.detail).toContain("ENOTFOUND");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(shouldRejectSubmission(r, "lenient").reject).toBe(false);
    expect(shouldRejectSubmission(r, "strict").reject).toBe(true);
  });

  it("(d) a lookup returning zero addresses is transient, never fetched", async () => {
    const fetchImpl = neverFetch();
    const c = only(
      await validateIntakeSources([src("url", "https://attacker.example/x")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: vi.fn(async () => []),
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("transient");
    expect(c.method).toBe("DNS");
    expect(c.detail).toContain("no addresses");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(d2) a lookup that never settles times out at DNS_LOOKUP_TIMEOUT_MS, never fetched", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = vi.fn(() => new Promise<never>(() => {})); // never resolves
    vi.useFakeTimers();
    const pending = validateIntakeSources([src("url", "https://attacker.example/x")], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupImpl: lookupImpl as unknown as typeof lookupImpl,
      env: envOf({}),
    });
    await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS + 1);
    const c = only(await pending);
    expect(c.outcome).toBe("transient");
    expect(c.method).toBe("DNS");
    expect(c.detail).toContain("timeout");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(e) literal IP hosts skip the resolver entirely", async () => {
    for (const host of ["8.8.8.8", "[2606:4700::1]"]) {
      const calls: FetchCall[] = [];
      const { impl } = fakeFetch([{ status: 206 }], calls);
      const lookupImpl = lookupTo("10.0.0.5"); // would block IF it were consulted
      const c = only(
        await validateIntakeSources([src("url", `https://${host}/x`)], { fetchImpl: impl, lookupImpl, env: envOf({}) })
      );
      expect(c.outcome).toBe("verified");
      expect(calls).toHaveLength(1);
      expect(lookupImpl).not.toHaveBeenCalled();
    }
  });

  it("(e) a blocked literal IP is refused without consulting the resolver", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = lookupTo("93.184.216.34"); // public — would be allowed IF consulted
    const c = only(
      await validateIntakeSources([src("url", "https://127.0.0.1/x")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl,
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.detail).toContain("loopback address 127.0.0.0/8");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupImpl).not.toHaveBeenCalled();
  });

  it("(f) an IPv6 private/link-local answer is blocked, zone id stripped", async () => {
    const fetchImpl = neverFetch();
    for (const addr of ["fd00::1", "fe80::1%eth0", "::ffff:169.254.169.254"]) {
      const c = only(
        await validateIntakeSources([src("url", "https://attacker.example/x")], {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          lookupImpl: lookupTo(addr),
          env: envOf({}),
        })
      );
      expect(c.outcome).toBe("definitive");
      expect(c.detail).toContain("resolves to a private/link-local address");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(f2) a resolver answer that is not an IP address fails closed", async () => {
    const fetchImpl = neverFetch();
    const c = only(
      await validateIntakeSources([src("url", "https://attacker.example/x")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl: lookupTo("not-an-ip-address"),
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.detail).toContain("resolves to a private/link-local address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(g) the GITHUB_OWNER shortcut does NOT skip the resolver", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = lookupTo("10.0.0.5");
    const c = only(
      await validateIntakeSources([src("url", "https://github.com/tycenjmccann/x/README.md")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl,
        env: envOf({ GITHUB_OWNER: "tycenjmccann" }),
      })
    );
    // Resolves to private → blocked, NOT labelled trusted-github.
    expect(c.outcome).toBe("definitive");
    expect(c.method).toBe("parse");
    expect(c.detail).toContain("resolves to a private/link-local address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(g) a trusted-github URL that resolves public is still skipped (resolver ran first)", async () => {
    const fetchImpl = neverFetch();
    const lookupImpl = lookupTo("93.184.216.34");
    const c = only(
      await validateIntakeSources([src("url", "https://github.com/tycenjmccann/x/README.md")], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupImpl,
        env: envOf({ GITHUB_OWNER: "tycenjmccann" }),
      })
    );
    expect(c.outcome).toBe("skipped");
    expect(c.method).toBe("trusted-github");
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(h) the resolver's block detail still carries no presigned signature", async () => {
    const c = only(
      await validateIntakeSources([src("url", PRESIGNED)], {
        fetchImpl: neverFetch() as unknown as typeof fetch,
        lookupImpl: lookupTo("127.0.0.1"),
        env: envOf({}),
      })
    );
    expect(c.outcome).toBe("definitive");
    expect(c.detail).toContain("X-Amz-Signature=REDACTED");
    expect(c.detail).not.toContain("SECRETSIG");
  });
});
