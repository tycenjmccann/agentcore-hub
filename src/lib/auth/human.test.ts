import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { claimedCallerOf, forbidden, requireHumanAdmin, requireHumanIdentity, verifiedActor } from "./human";

/** TEAM-5338 F1: the one "is this a human?" answer behind hub decisions and park clears. */
const req = (headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/x", { headers });
const SSO = { "x-agentcore-user": "u-alice", "x-agentcore-tenant": "acme" };

afterEach(() => {
  delete process.env.AUTH_MODE;
});

describe("requireHumanIdentity truth table", () => {
  const rows: Array<[string, string | undefined, Record<string, string>, ReturnType<typeof requireHumanIdentity>]> = [
    ["AUTH_MODE unset, no headers", undefined, {}, { ok: false, reason: "default_identity" }],
    ["AUTH_MODE unset, spoofed SSO headers", undefined, SSO, { ok: false, reason: "default_identity" }],
    ["AUTH_MODE=none, svc headers", "none", { "x-agentcore-user": "svc:x", "x-agentcore-tenant": "acme" }, { ok: false, reason: "default_identity" }],
    ["auth on, no headers", "cloudflare-access", {}, { ok: false, reason: "unauthenticated" }],
    ["auth on, user 'default'", "cloudflare-access", { "x-agentcore-user": "default", "x-agentcore-tenant": "default" }, { ok: false, reason: "default_identity" }],
    ["auth on, svc: identity", "cloudflare-access", { "x-agentcore-user": "svc:mcp-cli", "x-agentcore-tenant": "acme" }, { ok: false, reason: "service_identity" }],
    ["auth on, SSO user without email", "cloudflare-access", SSO, { ok: true, by: "u-alice", userId: "u-alice" }],
    ["auth on, SSO user with email", "cloudflare-access", { ...SSO, "x-agentcore-email": "alice@example.com" }, { ok: true, by: "alice@example.com", userId: "u-alice" }],
  ];
  for (const [name, mode, headers, want] of rows) {
    it(name, () => {
      if (mode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = mode;
      expect(requireHumanIdentity(req(headers))).toEqual(want);
    });
  }
});

describe("requireHumanAdmin truth table (TEAM-5347 F9)", () => {
  const ADMIN = { ...SSO, "x-agentcore-groups": "ops,admin" };
  const rows: Array<[string, string | undefined, Record<string, string>, ReturnType<typeof requireHumanAdmin>]> = [
    ["AUTH_MODE unset, no headers (isAdmin alone would say yes)", undefined, {}, { ok: false, reason: "default_identity" }],
    ["AUTH_MODE=none, admin headers", "none", ADMIN, { ok: false, reason: "default_identity" }],
    ["auth on, no headers", "cloudflare-access", {}, { ok: false, reason: "unauthenticated" }],
    ["auth on, svc: identity in the admin group", "cloudflare-access", { "x-agentcore-user": "svc:x", "x-agentcore-tenant": "acme", "x-agentcore-groups": "admin" }, { ok: false, reason: "service_identity" }],
    ["auth on, human without the admin group", "cloudflare-access", SSO, { ok: false, reason: "not_admin" }],
    ["auth on, human whose group merely contains 'admin'", "cloudflare-access", { ...SSO, "x-agentcore-groups": "administrators" }, { ok: false, reason: "not_admin" }],
    ["auth on, human in the admin group", "cloudflare-access", ADMIN, { ok: true, by: "u-alice", userId: "u-alice" }],
    ["auth on, admin with email", "cloudflare-access", { ...ADMIN, "x-agentcore-email": "alice@example.com" }, { ok: true, by: "alice@example.com", userId: "u-alice" }],
  ];
  for (const [name, mode, headers, want] of rows) {
    it(name, () => {
      if (mode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = mode;
      expect(requireHumanAdmin(req(headers))).toEqual(want);
    });
  }

  it("forbidden() keeps `error: forbidden` for callers that key on it, names the reason, and carries extra init", async () => {
    const res = forbidden({ ok: false, reason: "not_admin" }, { headers: { "Cache-Control": "no-store" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "forbidden", reason: "not_admin", hint: expect.stringContaining("admin group") });
    const human = forbidden({ ok: false, reason: "default_identity" });
    expect(await human.json()).toMatchObject({ error: "forbidden", reason: "default_identity", hint: expect.stringContaining("SSO") });
  });
});

describe("verifiedActor / claimedCallerOf (TEAM-5358 F8)", () => {
  const rows: Array<[string, string | undefined, Record<string, string>, string]> = [
    ["AUTH_MODE unset", undefined, { "x-agentcore-user": "u-alice", "x-agentcore-tenant": "acme" }, "unauthenticated:complete"],
    ["auth on, no headers", "cloudflare-access", {}, "unauthenticated:complete"],
    ["auth on, default user", "cloudflare-access", { "x-agentcore-user": "default", "x-agentcore-tenant": "default" }, "unauthenticated:complete"],
    ["auth on, svc: identity", "cloudflare-access", { "x-agentcore-user": "svc:workflow-manager", "x-agentcore-tenant": "acme" }, "svc:workflow-manager"],
    ["auth on, human", "cloudflare-access", { ...SSO, "x-agentcore-email": "alice@example.com" }, "alice@example.com"],
  ];
  for (const [name, mode, headers, want] of rows) {
    it(`verifiedActor: ${name}`, () => {
      if (mode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = mode;
      expect(verifiedActor(req(headers), "complete")).toBe(want);
    });
  }

  it("the self-declared x-hub-caller is never the actor", () => {
    expect(verifiedActor(req({ "x-hub-caller": "eng@example.com" }), "complete")).toBe("unauthenticated:complete");
  });

  it("claimedCallerOf trims, strips control chars, clamps, and is undefined when empty", () => {
    expect(claimedCallerOf(req({ "x-hub-caller": "  workflow-manager " }))).toBe("workflow-manager");
    expect(claimedCallerOf(req({ "x-hub-caller": "a\tb" }))).toBe("ab");
    expect(claimedCallerOf(req({ "x-hub-caller": "x".repeat(300) }))!.length).toBe(100);
    expect(claimedCallerOf(req({ "x-hub-caller": "   " }))).toBeUndefined();
    expect(claimedCallerOf(req())).toBeUndefined();
  });
});
