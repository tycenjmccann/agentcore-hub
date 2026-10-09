import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertSameOrigin } from "./request-guard";

/**
 * A registry write repins live harnesses, so a cross-site POST riding an admin's
 * session cookie is worth refusing. The guard's two rules are both here, plus the
 * deliberate non-rule: a MISSING Sec-Fetch-Site is not hostile (server-side
 * callers and curl do not send it).
 */

function req(
  method: string,
  headers: Record<string, string>,
  url = "https://hub.example.com/api/models/registry"
): Request {
  return new Request(url, { method, headers });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertSameOrigin", () => {
  it("never refuses a safe method, whatever the headers say", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        assertSameOrigin(req(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }))
      ).toBeNull();
    }
  });

  it("allows a same-origin POST", () => {
    expect(
      assertSameOrigin(
        req("POST", {
          "sec-fetch-site": "same-origin",
          origin: "https://hub.example.com",
          host: "hub.example.com",
        })
      )
    ).toBeNull();
  });

  it("allows same-site and none (an address-bar-initiated request)", () => {
    for (const site of ["same-site", "none", "Same-Origin"]) {
      expect(
        assertSameOrigin(
          req("POST", { "sec-fetch-site": site, origin: "https://hub.example.com", host: "hub.example.com" })
        )
      ).toBeNull();
    }
  });

  it("refuses a cross-site POST on Sec-Fetch-Site alone", async () => {
    const res = assertSameOrigin(
      req("POST", { "sec-fetch-site": "cross-site", origin: "https://hub.example.com", host: "hub.example.com" })
    );
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "cross_origin" });
  });

  it("refuses when the Origin host is not our Host", async () => {
    const res = assertSameOrigin(
      req("POST", { "sec-fetch-site": "same-site", origin: "https://evil.example", host: "hub.example.com" })
    );
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "cross_origin" });
  });

  it("refuses an unparseable Origin", () => {
    expect(assertSameOrigin(req("POST", { origin: "not-a-url", host: "hub.example.com" }))?.status).toBe(403);
  });

  it("refuses when Origin is present but Host is missing", () => {
    expect(assertSameOrigin(req("POST", { origin: "https://hub.example.com" }))?.status).toBe(403);
  });

  it("allows a POST with neither header — curl and server-side callers are not the threat", () => {
    expect(assertSameOrigin(req("POST", { host: "hub.example.com" }))).toBeNull();
  });

  it("allows the opaque Origin `null` and falls back to Sec-Fetch-Site", () => {
    expect(
      assertSameOrigin(req("POST", { origin: "null", "sec-fetch-site": "same-origin", host: "hub.example.com" }))
    ).toBeNull();
    expect(
      assertSameOrigin(req("POST", { origin: "null", "sec-fetch-site": "cross-site", host: "hub.example.com" }))
        ?.status
    ).toBe(403);
  });

  it("compares host including port, not just hostname", () => {
    expect(
      assertSameOrigin(req("POST", { origin: "http://localhost:3000", host: "localhost:3000" }))
    ).toBeNull();
    expect(
      assertSameOrigin(req("POST", { origin: "http://localhost:4000", host: "localhost:3000" }))?.status
    ).toBe(403);
  });

  it("guards DELETE and PUT too, not only POST", () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      expect(assertSameOrigin(req(method, { "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    }
  });

  it("logs the reason without echoing the whole request", () => {
    const warn = vi.spyOn(console, "warn");
    assertSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }));
    expect(warn.mock.calls.flat().join(" ")).toContain("request.cross_origin reason=sec-fetch-site");
  });
});
