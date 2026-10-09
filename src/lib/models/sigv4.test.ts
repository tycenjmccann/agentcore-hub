import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BEARER_TOKEN_PREFIX,
  mintBedrockBearerToken,
  signedFetch,
  __resetBearerTokenCache,
} from "./sigv4";

/**
 * The bearer token is a live credential built by hand, so its FORMAT is the
 * contract: get it wrong and Mantle returns an opaque 403. These tests use fixed
 * static credentials so the signature is deterministic and no AWS metadata
 * endpoint is ever consulted.
 */
const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

function decodeToken(token: string): string {
  return Buffer.from(token.slice(BEARER_TOKEN_PREFIX.length), "base64").toString("utf8");
}

describe("mintBedrockBearerToken", () => {
  beforeEach(() => {
    __resetBearerTokenCache();
  });

  it("is the prefix plus a base64 presigned CallWithBearerToken URL", async () => {
    const token = await mintBedrockBearerToken("us-east-2", { credentials: CREDS });

    expect(token.startsWith(BEARER_TOKEN_PREFIX)).toBe(true);
    const url = decodeToken(token);
    // Scheme-less on purpose — that is the exact string AWS base64s into the key.
    expect(url.startsWith("bedrock.amazonaws.com/?")).toBe(true);
    expect(url).toContain("Action=CallWithBearerToken");
    expect(url.endsWith("&Version=1")).toBe(true);
  });

  it("carries a SigV4 presignature scoped to the requested region", async () => {
    const url = decodeToken(await mintBedrockBearerToken("eu-west-1", { credentials: CREDS }));
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));

    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(params.get("X-Amz-Credential")).toContain("/eu-west-1/bedrock/aws4_request");
    expect(params.get("X-Amz-Expires")).toBe("3600");
    expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honours expiresInSeconds", async () => {
    const url = decodeToken(
      await mintBedrockBearerToken("us-east-1", { credentials: CREDS, expiresInSeconds: 900 })
    );
    expect(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("X-Amz-Expires")).toBe("900");
  });

  it("caches per region and re-mints once the cache is dropped", async () => {
    const a = await mintBedrockBearerToken("us-east-2", { credentials: CREDS });
    const b = await mintBedrockBearerToken("us-east-2", { credentials: CREDS });
    expect(b).toBe(a);

    const other = await mintBedrockBearerToken("us-east-1", { credentials: CREDS });
    expect(other).not.toBe(a);

    __resetBearerTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const fresh = await mintBedrockBearerToken("us-east-2", { credentials: CREDS });
    vi.useRealTimers();
    expect(fresh).not.toBe(a);
  });

  it("never logs the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const token = await mintBedrockBearerToken("us-east-2", { credentials: CREDS });
    const logged = log.mock.calls.flat().join(" ");
    log.mockRestore();

    expect(logged).toContain("bearer.minted");
    expect(logged).toContain("region=us-east-2");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(BEARER_TOKEN_PREFIX);
  });
});

describe("signedFetch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs the request and sends it without a host header", async () => {
    await signedFetch({
      service: "bedrock",
      region: "us-east-1",
      method: "GET",
      url: "https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000",
      credentials: CREDS,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(headers.authorization).toContain("/us-east-1/bedrock/aws4_request");
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // fetch derives Host from the URL; a signed copy would be redundant.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("host");
    expect(init.signal).toBeDefined();
  });

  it("signs a POST body and passes the caller's headers through", async () => {
    await signedFetch({
      service: "pricing",
      region: "us-east-1",
      method: "POST",
      url: "https://api.pricing.us-east-1.amazonaws.com/",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSPriceListService.GetProducts",
      },
      body: JSON.stringify({ ServiceCode: "AmazonBedrock" }),
      credentials: CREDS,
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBe('{"ServiceCode":"AmazonBedrock"}');
    expect(headers["x-amz-target"]).toBe("AWSPriceListService.GetProducts");
    expect(headers.authorization).toContain("/us-east-1/pricing/aws4_request");
    // The body must be inside the signature, not merely attached to the request.
    expect(headers.authorization).toContain("x-amz-content-sha256");
  });
});
