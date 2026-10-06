import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_HEADERS, NON_ADMIN_HEADERS, SSO_AUTH_MODE, SVC_HEADERS } from "@/lib/auth/admin-test-headers";

/**
 * TEAM-5347 F9 — GET /api/cloud-code/github/manifest writes the deploy-level GitHub
 * App master credential (phase 2), so it is gated by requireHumanAdmin: a provable
 * human in the admin group. isAdmin() alone was true under AUTH_MODE=none, where every
 * caller — the fleet's agents included — is "default".
 */
const h = vi.hoisted(() => ({
  puts: [] as Array<Record<string, unknown>>,
  stateValid: true,
}));

vi.mock("@/lib/cloud-code/github-app", () => ({
  exchangeManifestCode: async () => ({ appId: "1", privateKey: "k", slug: "hub-app", webhookSecret: "w", clientId: "c", clientSecret: "s" }),
  resetGithubAppConfigCache: () => {},
  issueInstallState: async () => "install-state",
  issueManifestState: async () => "manifest-state",
  verifyManifestState: async () => h.stateValid,
}));
vi.mock("@/lib/cloud-code/github-secrets", () => ({
  putGithubAppConfig: async (cfg: Record<string, unknown>) => {
    h.puts.push(cfg);
  },
}));

const { GET } = await import("./route");

const get = (query = "", headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost/api/cloud-code/github/manifest${query}`, { headers }));

beforeEach(() => {
  h.puts.length = 0;
  h.stateValid = true;
  process.env.AUTH_MODE = SSO_AUTH_MODE;
  delete process.env.DEPLOYMENT_URL;
});
afterEach(() => {
  delete process.env.AUTH_MODE;
});

describe("GET /api/cloud-code/github/manifest — TEAM-5347 F9 admin gate", () => {
  const forbiddenCases: Array<[string, () => Record<string, string>]> = [
    ["AUTH_MODE=none (isAdmin alone would say yes)", () => { process.env.AUTH_MODE = "none"; return {}; }],
    ["no identity under SSO", () => ({})],
    ["a service identity in the admin group", () => ({ ...SVC_HEADERS, "x-agentcore-groups": "admin" })],
    ["a human without the admin group", () => NON_ADMIN_HEADERS],
  ];
  for (const [name, headers] of forbiddenCases) {
    it(`${name} ⇒ redirected to ?github=forbidden, and a ?code is never exchanged`, async () => {
      const hs = headers();
      const res = await get("?code=tmp&state=manifest-state", hs);
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.headers.get("location")).toBe("http://localhost/cloud-code?github=forbidden");
      expect(h.puts).toHaveLength(0);
    });
  }

  it("a human admin gets the phase-1 manifest form", async () => {
    const res = await get("", ADMIN_HEADERS);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("https://github.com/settings/apps/new?state=manifest-state");
    expect(h.puts).toHaveLength(0);
  });

  it("a human admin returning with a code stores the App and is sent to install it", async () => {
    const res = await get("?code=tmp&state=manifest-state", ADMIN_HEADERS);
    expect(res.headers.get("location")).toBe("https://github.com/apps/hub-app/installations/new?state=install-state");
    expect(h.puts).toEqual([{ appId: "1", privateKey: "k", slug: "hub-app", webhookSecret: "w", clientId: "c", clientSecret: "s" }]);
  });

  it("a human admin with a code whose state does not verify stores nothing", async () => {
    h.stateValid = false;
    const res = await get("?code=tmp&state=forged", ADMIN_HEADERS);
    expect(res.headers.get("location")).toBe("http://localhost/cloud-code?github=state_mismatch");
    expect(h.puts).toHaveLength(0);
  });
});
