import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { requireHumanIdentity } from "./human";

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
