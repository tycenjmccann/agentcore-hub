// TEAM-5167 R2-06: the create-once claims in index.mjs are only claims if the SDK
// serializes `IfNoneMatch` / `IfMatch` onto the wire. This file runs against the REAL
// @aws-sdk/client-s3 (no mocks, no network — the probe's request handler throws before
// any I/O) and pins two things: the bundled version carries the headers, and the probe
// tells a serializer that drops them apart from a client it cannot see through.
import { describe, it, expect } from "vitest";
import * as s3 from "@aws-sdk/client-s3";
import { probeConditionalHeaders, PROBE_CASES } from "./s3-conditional.mjs";

describe("s3-conditional — probeConditionalHeaders", () => {
  it("the bundled @aws-sdk/client-s3 serializes If-None-Match and If-Match on PutObject, and If-Match on DeleteObject", async () => {
    const verdict = await probeConditionalHeaders(s3);
    expect(verdict.verdict, JSON.stringify(verdict)).toBe("ok");
    expect(verdict.missing).toEqual([]);
    expect(verdict.sdkVersion).toMatch(/^3\.\d+\.\d+$/);
    // Every probe case was actually serialized and carried its header.
    expect(verdict.seen).toHaveLength(PROBE_CASES.length);
    for (const row of verdict.seen) expect(row.headers[row.header]).toBe(row.expected);
  });

  it("the bundled version is one that has all three conditional headers (>= 3.700.0)", async () => {
    const { verdict, sdkVersion } = await probeConditionalHeaders(s3);
    const [major, minor] = sdkVersion.split(".").map(Number);
    expect(verdict).toBe("ok");
    expect(major).toBe(3);
    // IfNoneMatch on PutObject: 3.635.0; conditional DeleteObject: 3.698.0; IfMatch on PutObject: 3.700.0.
    expect(minor).toBeGreaterThanOrEqual(700);
  });

  it("a serializer that DROPS the conditional inputs is a conclusive `missing`, naming each header", async () => {
    // Same real client and middleware; only the command inputs lose their conditions —
    // what an older SDK's model does to them.
    const dropping = {
      ...s3,
      PutObjectCommand: class extends s3.PutObjectCommand {
        constructor({ IfNoneMatch, IfMatch, ...rest }) { super(rest); }
      },
      DeleteObjectCommand: class extends s3.DeleteObjectCommand {
        constructor({ IfMatch, ...rest }) { super(rest); }
      },
    };
    const verdict = await probeConditionalHeaders(dropping);
    expect(verdict.verdict).toBe("missing");
    expect(verdict.missing).toEqual(PROBE_CASES.map((c) => c.label));
  });

  it("only ONE header missing is still `missing`, and names only that one", async () => {
    const dropping = {
      ...s3,
      DeleteObjectCommand: class extends s3.DeleteObjectCommand {
        constructor({ IfMatch, ...rest }) { super(rest); }
      },
    };
    const verdict = await probeConditionalHeaders(dropping);
    expect(verdict.verdict).toBe("missing");
    expect(verdict.missing).toEqual(["DeleteObject If-Match"]);
  });

  it("a client the probe cannot see through (no middleware stack — a mocked SDK) is `inconclusive`, never `missing`", async () => {
    const mocked = {
      ...s3,
      S3Client: class { async send() { return {}; } },
    };
    const verdict = await probeConditionalHeaders(mocked);
    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.missing).toEqual([]);
  });

  it("a client whose send never reaches the request handler is `inconclusive` too", async () => {
    const swallowing = {
      ...s3,
      S3Client: class extends s3.S3Client { async send() { return {}; } },
    };
    const verdict = await probeConditionalHeaders(swallowing);
    expect(verdict.verdict).toBe("inconclusive");
  });

  it("a probe that throws is `inconclusive` with the reason, not a crash at cold start", async () => {
    const broken = {
      ...s3,
      S3Client: class { constructor() { throw new Error("no runtime config"); } },
    };
    const verdict = await probeConditionalHeaders(broken);
    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.reason).toMatch(/no runtime config/);
  });
});
