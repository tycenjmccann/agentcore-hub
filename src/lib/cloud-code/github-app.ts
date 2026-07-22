/**
 * Cloud Code — GitHub App installation tokens.
 *
 * The safe replacement for a shared long-lived GITHUB_PAT. The App's private key
 * lives ONLY in the hub (Secrets Manager, `cloud-code/github-app`); it NEVER
 * enters the microVM. Per session we sign a short-lived App JWT, exchange it for
 * an installation access token (~1h, scoped to the single repo when we can name
 * it), and hand THAT to the runtime in the invoke payload. The agent can only
 * ever see the expiring, narrow token — not the master key.
 *
 * Multi-tenant: a connection is per (tenant, user), so a turn clones with the
 * token of whoever actually owns the session, never escalating across tenants.
 */

import { SignJWT, importPKCS8 } from "jose";
import { createPrivateKey, createHmac, timingSafeEqual, randomBytes } from "crypto";
import { getGithubAppConfig, type GithubAppSecret } from "./github-secrets";
import { getGithubConnection } from "./github-store";

const GITHUB_API = process.env.GITHUB_API_URL || "https://api.github.com";

/** Bare repo name from owner/name OR a clone URL (https/ssh), sans `.git`. */
export function repoShortName(repo?: string): string | undefined {
  if (!repo) return undefined;
  const last = repo
    .trim()
    .replace(/\.git$/i, "")
    .split(/[/:]/) // handles owner/name, https://…/owner/name, git@host:owner/name
    .filter(Boolean)
    .pop();
  return last || undefined;
}

export type GithubAppConfig = GithubAppSecret;

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO 8601
}

let _config: GithubAppConfig | null = null;
// Only a SUCCESSFUL load is cached (indefinitely — the App key is stable until an
// operator rotates it, which calls resetGithubAppConfigCache). A missing/failed
// load is NEVER cached: negative caching would make an instance that first ran
// before the App existed — or hit a transient Secrets Manager error — return
// "not configured" for its whole life, so cloneTokenForUser would fall back to
// the broad shared PAT for a user who IS App-connected. Re-check every call when
// unconfigured; success flips it to the cached path.
async function loadConfig(): Promise<GithubAppConfig | null> {
  if (_config) return _config;
  const cfg = await getGithubAppConfig();
  if (cfg) _config = cfg;
  return cfg;
}

/** True when the App is configured (App ID + private key present). */
export async function githubAppConfigured(): Promise<boolean> {
  return Boolean(await loadConfig());
}

/** Invalidate the cached config (after an operator (re)creates the App). */
export function resetGithubAppConfigCache(): void {
  _config = null;
}

// GitHub App JWTs live at most 10 min; use 9 to leave clock-skew margin. GitHub
// also rejects an `iat` in the future, so back-date it 60s.
async function appJwt(cfg: GithubAppConfig): Promise<string> {
  const key = await importPrivateKey(cfg.privateKey);
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 9 * 60)
    .setIssuer(cfg.appId)
    .sign(key);
}

// GitHub distributes the App key as PKCS#1 (`BEGIN RSA PRIVATE KEY`). jose's
// importPKCS8 wants PKCS#8 (`BEGIN PRIVATE KEY`). Convert via Node's crypto so
// operators can paste the key exactly as GitHub gave it.
async function importPrivateKey(pem: string) {
  const normalized = pem.includes("BEGIN RSA PRIVATE KEY")
    ? createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString()
    : pem;
  return importPKCS8(normalized, "RS256");
}

// Cache minted tokens per (installation + repo scope) until 5 min before expiry.
// A warm session can fire many turns; minting each time would be needless GitHub
// API load and latency.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const _tokenCache = new Map<string, InstallationToken>();

function cacheKey(installationId: string, repositories?: string[]): string {
  return `${installationId}::${(repositories || []).slice().sort().join(",")}`;
}

/**
 * Mint (or reuse a cached) installation access token. `repositories` (short
 * names, e.g. ["agentcore-hub"]) narrows the token to just those repos when
 * provided; a whole-installation token is issued otherwise. Throws if the App
 * isn't configured or GitHub rejects the request — callers fall back to GITHUB_PAT.
 */
export async function mintInstallationToken(
  installationId: string,
  repositories?: string[]
): Promise<InstallationToken> {
  const cfg = await loadConfig();
  if (!cfg) throw new Error("GitHub App is not configured (cloud-code/github-app secret missing)");

  const ck = cacheKey(installationId, repositories);
  const cached = _tokenCache.get(ck);
  if (cached && Date.parse(cached.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
    return cached;
  }

  const jwt = await appJwt(cfg);
  const body: Record<string, unknown> = {};
  if (repositories?.length) body.repositories = repositories;

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`installation token mint failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { token: string; expires_at: string };
  const minted: InstallationToken = { token: json.token, expiresAt: json.expires_at };
  _tokenCache.set(ck, minted);
  return minted;
}

export interface CloneTokenResult {
  /** The minted installation token, if one was issued. */
  token?: string;
  /** True when the user has a GitHub App installation connected. When this is
   *  true but `token` is undefined, the mint was DENIED (repo out of the
   *  selected-repo scope, installation revoked, GitHub error) — the runtime must
   *  NOT fall back to GITHUB_PAT, or it would clone with broader access than the
   *  user's App scope allows. */
  connected: boolean;
}

/**
 * Clone token for a session's owner. Never throws. The `connected` flag lets the
 * runtime tell two cases apart that must behave differently:
 *   - not connected (App unconfigured OR user hasn't installed) → `{connected:
 *     false}` → GITHUB_PAT fallback is legitimate.
 *   - connected but mint failed/denied → `{connected: true, token: undefined}` →
 *     fallback is FORBIDDEN; the runtime clears creds so the clone fails cleanly
 *     inside the user's chosen App scope rather than escalating to the PAT.
 * `repo` scopes the token to just that repo when the install was selective.
 */
export async function cloneTokenForUser(
  tenantId: string,
  userId: string,
  repo?: string
): Promise<CloneTokenResult> {
  if (!(await githubAppConfigured())) return { connected: false };
  const conn = await getGithubConnection(tenantId, userId).catch(() => null);
  if (!conn?.installationId) return { connected: false };
  try {
    // Scope to the single repo WHENEVER we can name it. Omitting `repositories`
    // yields a token good for EVERY repo in the installation, and the runtime
    // exports it as GH_TOKEN, so a turn on one repo could read/push any sibling.
    const shortName = repoShortName(repo);
    const scope = shortName ? [shortName] : undefined;
    const { token } = await mintInstallationToken(conn.installationId, scope);
    return { token, connected: true };
  } catch {
    // Connected, but GitHub declined the scoped mint → stay connected with no
    // token so the caller enforces scope instead of leaking the PAT.
    return { connected: true };
  }
}

/** Fetch an installation's account + repo-selection metadata (for the connect
 *  callback). Uses the App JWT. Returns null on any failure. */
export async function getInstallation(installationId: string): Promise<{
  account?: string;
  repoSelection?: "all" | "selected";
} | null> {
  try {
    const cfg = await loadConfig();
    if (!cfg) return null;
    const jwt = await appJwt(cfg);
    const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      account?: { login?: string };
      repository_selection?: "all" | "selected";
    };
    return { account: json.account?.login, repoSelection: json.repository_selection };
  } catch {
    return null;
  }
}

// ─── Install state (CSRF / installation-binding guard) ──────────────────────
//
// GitHub's install redirect does NOT tell us WHO initiated it — the callback
// just gets ?installation_id=. Without a check, any signed-in user could hit the
// callback with someone else's installation id and bind it to their own account,
// then mint tokens for that org's repos. We defend with a signed `state`: the
// install route issues `userId.expiry.hmac`, GitHub echoes it back on the
// callback, and we verify it matches the signed-in user and hasn't expired.

const STATE_TTL_MS = 15 * 60 * 1000;

// Last-resort HMAC material when no stable deploy secret is set. Generated once
// per process — fine for a single-instance deploy, but multi-instance setups
// should set AGENTCORE_STATE_SECRET so state verifies across instances.
const _ephemeralStateSecret = randomBytes(32).toString("hex");

async function stateKey(): Promise<Buffer> {
  // A stable, secret, deploy-level value that exists BEFORE the App does. The App
  // key is deliberately NOT used — the manifest-creation flow runs when it does
  // not yet exist, so keying on it would 500 the very page that creates the App.
  const material = process.env.AGENTCORE_STATE_SECRET || _ephemeralStateSecret;
  return createHmac("sha256", "cloud-code/github-state").update(material).digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

// `.` is the state-token field delimiter, but encodeURIComponent does NOT escape
// it — and SSO userIds are email addresses (john.doe@acme.com), so a raw encode
// leaves periods that shatter state.split(".") in verifyState. Escape `.` → %2E
// (decodeURIComponent reverses it) so the userId can never contain the delimiter.
function encodeUserId(userId: string): string {
  return encodeURIComponent(userId).replace(/\./g, "%2E");
}

/** Mint a signed state token binding an install flow to `userId`. */
export async function issueInstallState(userId: string): Promise<string> {
  const key = await stateKey();
  const payload = `${encodeUserId(userId)}.${Date.now() + STATE_TTL_MS}`;
  return `${payload}.${sign(payload, key)}`;
}

export async function verifyInstallState(state: string, userId: string): Promise<boolean> {
  return verifyState(state, userId, "install");
}

// The manifest-creation flow needs its OWN CSRF nonce (a distinct purpose from
// the install flow), so a token minted for one can't be replayed for the other.
export async function issueManifestState(userId: string): Promise<string> {
  const key = await stateKey();
  const payload = `manifest.${encodeUserId(userId)}.${Date.now() + STATE_TTL_MS}`;
  return `${payload}.${sign(payload, key)}`;
}

export async function verifyManifestState(state: string, userId: string): Promise<boolean> {
  return verifyState(state, userId, "manifest");
}

/** Shared HMAC-state verifier. "install" tokens are `user.exp.mac`; "manifest"
 *  tokens are `manifest.user.exp.mac` — kept distinct so neither stands in for
 *  the other. */
async function verifyState(
  state: string,
  userId: string,
  purpose: "install" | "manifest"
): Promise<boolean> {
  try {
    const parts = state.split(".");
    const key = await stateKey();
    if (purpose === "manifest") {
      if (parts.length !== 4 || parts[0] !== "manifest") return false;
      const [, encUser, expiryStr, mac] = parts;
      const expected = sign(`manifest.${encUser}.${expiryStr}`, key);
      const a = Buffer.from(mac);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      if (Date.now() > Number(expiryStr)) return false;
      return decodeURIComponent(encUser) === userId;
    }
    if (parts.length !== 3) return false;
    const [encUser, expiryStr, mac] = parts;
    const expected = sign(`${encUser}.${expiryStr}`, key);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    if (Date.now() > Number(expiryStr)) return false;
    return decodeURIComponent(encUser) === userId;
  } catch {
    return false;
  }
}

/** Exchange a manifest `code` for a created App's credentials (operator setup). */
export async function exchangeManifestCode(code: string): Promise<{
  appId: string;
  privateKey: string;
  slug: string;
  htmlUrl: string;
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
}> {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`manifest conversion failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    id: number;
    slug: string;
    html_url: string;
    pem: string;
    webhook_secret?: string;
    client_id?: string;
    client_secret?: string;
  };
  return {
    appId: String(json.id),
    privateKey: json.pem,
    slug: json.slug,
    htmlUrl: json.html_url,
    webhookSecret: json.webhook_secret,
    clientId: json.client_id,
    clientSecret: json.client_secret,
  };
}

// GitHub's OAuth authorize/token host (github.com), distinct from the REST API
// host. Overridable for GHES.
const GITHUB_OAUTH_HOST = process.env.GITHUB_OAUTH_HOST || "https://github.com";

/**
 * Prove the connecting user controls `installationId`: exchange the OAuth `code`
 * GitHub appended to the install redirect for a user access token, then confirm
 * the installation appears in that user's own `/user/installations` AND they
 * administer it. Returns the user's login on success, or null otherwise. Stops a
 * user from binding an installation id they merely *know* (a valid `state` only
 * proves they started *a* flow, not that they administer this installation).
 */
export async function verifyInstallationOwnership(
  code: string,
  installationId: string
): Promise<{ login?: string } | null> {
  try {
    const cfg = await loadConfig();
    if (!cfg?.clientId || !cfg?.clientSecret) return null; // pre-OAuth App: caller decides
    const tokRes = await fetch(`${GITHUB_OAUTH_HOST}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
    });
    if (!tokRes.ok) return null;
    const tok = (await tokRes.json()) as { access_token?: string };
    if (!tok.access_token) return null;
    const bearer = tok.access_token;
    const gh = (path: string) =>
      fetch(`${GITHUB_API}${path}`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

    const target = String(installationId);
    let hit: { id: number; account?: { login?: string; type?: string } } | undefined;
    for (let page = 1; page <= 10; page++) {
      const res = await gh(`/user/installations?per_page=100&page=${page}`);
      if (!res.ok) return null;
      const json = (await res.json()) as {
        installations?: Array<{ id: number; account?: { login?: string; type?: string } }>;
      };
      const list = json.installations || [];
      hit = list.find((i) => String(i.id) === target);
      if (hit) break;
      if (list.length < 100) break; // last page
    }
    if (!hit) return null; // not visible to this user at all → reject

    // Admin proof — /user/installations access alone is insufficient (an org
    // member can see an org install without administering it).
    const login = hit.account?.login;
    const accountType = (hit.account?.type || "").toLowerCase();

    const meRes = await gh("/user");
    if (!meRes.ok) return null;
    const me = (await meRes.json()) as { login?: string };
    if (!me.login) return null;

    if (accountType === "organization") {
      if (!login) return null;
      const memRes = await gh(`/user/memberships/orgs/${encodeURIComponent(login)}`);
      if (!memRes.ok) return null;
      const mem = (await memRes.json()) as { role?: string; state?: string };
      if (mem.role !== "admin" || mem.state !== "active") return null;
      return { login };
    }

    // User (or bot) account install: only the account owner administers it.
    if (login && login.toLowerCase() === me.login.toLowerCase()) {
      return { login };
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the App has OAuth client creds (so ownership can be enforced). */
export async function githubAppHasOAuth(): Promise<boolean> {
  const cfg = await loadConfig();
  return Boolean(cfg?.clientId && cfg?.clientSecret);
}
