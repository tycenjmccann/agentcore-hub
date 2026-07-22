import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

/**
 * The GitHub-App CSRF state token is HMAC-signed and carries the userId it was
 * minted for. Two things make it easy to break: (1) SSO userIds are email
 * addresses, and `.` is the token's field delimiter — a raw encode would shatter
 * state.split("."); (2) install vs manifest tokens must NOT be interchangeable.
 * These lock the round-trip, the cross-user rejection, tamper rejection, expiry,
 * and purpose separation.
 *
 * A stable secret is set BEFORE import so issue+verify share one HMAC key
 * (stateKey() reads AGENTCORE_STATE_SECRET on every call).
 */
process.env.AGENTCORE_STATE_SECRET = "test-state-secret-fixed";

let gh: typeof import("./github-app");
beforeAll(async () => {
  gh = await import("./github-app");
});

afterEach(() => {
  vi.useRealTimers();
});

const EMAIL = "john.doe@acme.com"; // the periods are the whole point

describe("github state — install tokens", () => {
  it("round-trips a plain userId", async () => {
    const s = await gh.issueInstallState("u1");
    expect(await gh.verifyInstallState(s, "u1")).toBe(true);
  });

  it("round-trips an email userId despite the '.' delimiter", async () => {
    const s = await gh.issueInstallState(EMAIL);
    expect(s.split(".").length).toBe(3); // user.exp.mac — periods in the email are escaped
    expect(await gh.verifyInstallState(s, EMAIL)).toBe(true);
  });

  it("rejects a token minted for a different user", async () => {
    const s = await gh.issueInstallState(EMAIL);
    expect(await gh.verifyInstallState(s, "eve@evil.com")).toBe(false);
  });

  it("rejects a tampered MAC", async () => {
    const s = await gh.issueInstallState("u1");
    const parts = s.split(".");
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
    expect(await gh.verifyInstallState(parts.join("."), "u1")).toBe(false);
  });

  it("rejects an expired token (past the 15-min TTL)", async () => {
    const s = await gh.issueInstallState("u1");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(await gh.verifyInstallState(s, "u1")).toBe(false);
  });
});

describe("github state — manifest tokens", () => {
  it("round-trips", async () => {
    const s = await gh.issueManifestState(EMAIL);
    expect(await gh.verifyManifestState(s, EMAIL)).toBe(true);
  });

  it("an install token is NOT accepted as a manifest token (purpose separation)", async () => {
    const install = await gh.issueInstallState("u1");
    expect(await gh.verifyManifestState(install, "u1")).toBe(false);
  });

  it("a manifest token is NOT accepted as an install token", async () => {
    const manifest = await gh.issueManifestState("u1");
    expect(await gh.verifyInstallState(manifest, "u1")).toBe(false);
  });
});

describe("github — repoShortName", () => {
  it("extracts the bare repo name from owner/name and clone URLs", () => {
    expect(gh.repoShortName("acme/widgets")).toBe("widgets");
    expect(gh.repoShortName("https://github.com/acme/widgets.git")).toBe("widgets");
    expect(gh.repoShortName("git@github.com:acme/widgets.git")).toBe("widgets");
    expect(gh.repoShortName(undefined)).toBeUndefined();
  });
});
