import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateIntakeSources,
  getSourceValidationMode,
  shouldRejectSubmission,
  resolveHubBucket,
  type SourceValidationResult,
  type SourceCheckResult,
} from "./intake";
import { redactUrl } from "./redact";
import type { IntakeSource } from "./types";

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
type FetchCall = { url: string; method: string; headers: Record<string, string> };
function fakeFetch(responses: Array<{ status: number }>, calls: FetchCall[]) {
  const cancel = vi.fn(async () => undefined);
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers });
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
