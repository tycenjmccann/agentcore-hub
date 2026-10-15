/**
 * TEAM-6334 (review fix on TEAM-6322/TEAM-6324/TEAM-6333) — JIRA_WEBHOOK_SECRET
 * must reach Jira and the hub as the same bytes.
 *
 * Root cause: deploy/apprunner/setup-jira-webhook.sh passed the value raw to Jira
 * (os.environ → json.dumps), while deploy/ecs-express/set-env.sh's "\n"-joined
 * KEY=VALUE merge dropped a trailing newline silently (and split the value on an
 * embedded one). Jira signed `secret\n`, the hub verified `secret` → every
 * delivery 401'd and was dropped. DEPLOY.md's "byte-for-byte on both sides" was
 * a promise neither writer could keep for arbitrary bytes.
 *
 * Fix: one shared rule, deploy/lib/jira-webhook-secret.sh — the secret must match
 * [A-Za-z0-9._~+/=-]+ (what `openssl rand -hex 32` emits) — and BOTH writers refuse
 * anything else before any network call. The hub side (route.ts) is unchanged.
 *
 * Hermetic, same pattern as load-env-local.test.ts / gate-hardening.test.ts:
 * PATH-shimmed fake `curl` / `aws` that log every call and refuse, a child env
 * built from an allow-list (never process.env), and a scratch copy of the setup
 * script so a dev box's real .env.local is never sourced.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "../../..");
const HELPER = join(REPO_ROOT, "deploy", "lib", "jira-webhook-secret.sh");
// `openssl rand -hex 32` shape and a base64 one (carries `/`, `=`).
const HEX = "a087bb7308b9ddb0e5281aa541d57292d3cc5a2b3a5837b4f6f10744dfdcd464";
const B64 = "njlkSWWO1AxrYziUR8EoQ8x2kJC8EcEpxA6ldAefw/Q=";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};

/** Child env from an allow-list, never a copy of process.env. binDir goes first on PATH. */
const hermeticEnv = (binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const base: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
  };
  return { ...base, ...extra } as NodeJS.ProcessEnv;
};

const shim = (dir: string, name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};

const REFUSAL = /JIRA_WEBHOOK_SECRET (is empty|contains)/;

describe("require_jira_webhook_secret_format (deploy/lib/jira-webhook-secret.sh)", () => {
  // The value travels as a positional arg, so the test's own quoting can never
  // alter the bytes under test.
  const check = (value: string) =>
    spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source "${HELPER}"; require_jira_webhook_secret_format "$1"`, "_", value],
      { encoding: "utf8", env: hermeticEnv("/nonexistent") }
    );

  it.each([
    ["hex (openssl rand -hex 32)", HEX],
    ["base64", B64],
    ["dots / tildes / dashes / underscores", "a.b~c-d_e"],
  ])("accepts %s", (_name, value) => {
    const r = check(value);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });

  it.each([
    ["trailing newline", "abc\n", /whitespace or a newline/],
    ["embedded newline", "ab\ncd", /whitespace or a newline/],
    ["space", "ab c", /whitespace or a newline/],
    ["tab", "\tabc", /whitespace or a newline/],
    ["dollar", "a$b", /outside \[A-Za-z0-9\._~\+\/=-\]/],
    ["double quote", 'a"b', /outside \[A-Za-z0-9\._~\+\/=-\]/],
    ["hash", "a#b", /outside \[A-Za-z0-9\._~\+\/=-\]/],
    ["empty", "", /is empty/],
  ])("rejects %s with the reason and the openssl hint, never echoing the value", (_name, value, reason) => {
    const r = check(value);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(REFUSAL);
    expect(r.stderr).toMatch(reason);
    expect(r.stderr).toMatch(/openssl rand -hex 32/);
    if (value.trim()) expect(r.stderr).not.toContain(value.trim());
  });
});

describe("setup-jira-webhook.sh refuses an unsafe JIRA_WEBHOOK_SECRET before any Jira call", () => {
  /**
   * Scratch tree that keeps the deploy/apprunner/../.. layout, so the script's
   * own REPO_ROOT resolves to the scratch dir and no real .env.local is sourced.
   * Every curl invocation is a network call: the shim records its argv (NUL-
   * separated so a JSON body survives) and fails like `curl -f` would.
   */
  const runSetup = (secret: string | undefined) => {
    const root = scratch("jira-webhook-setup-");
    mkdirSync(join(root, "deploy", "apprunner"), { recursive: true });
    cpSync(join(REPO_ROOT, "deploy", "lib"), join(root, "deploy", "lib"), { recursive: true });
    cpSync(
      join(REPO_ROOT, "deploy", "apprunner", "setup-jira-webhook.sh"),
      join(root, "deploy", "apprunner", "setup-jira-webhook.sh")
    );
    const bin = join(root, "bin");
    mkdirSync(bin);
    const curlLog = join(root, "curl.log");
    shim(bin, "curl", `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${curlLog}"\nexit 22\n`);

    const env: Record<string, string> = {
      JIRA_SITE_URL: "example.atlassian.net",
      JIRA_EMAIL: "ops@example.com",
      JIRA_API_TOKEN: "test-token",
      JIRA_PROJECT_KEY: "TEAM",
      DEPLOYMENT_URL: "https://hub.example",
    };
    if (secret !== undefined) env.JIRA_WEBHOOK_SECRET = secret;

    // cwd is deliberately NOT the script's dir: the helper must resolve from
    // the script's own location.
    const r = spawnSync("bash", [join(root, "deploy", "apprunner", "setup-jira-webhook.sh")], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 60_000,
      env: hermeticEnv(bin, env),
    });
    const curlArgs = existsSync(curlLog) ? readFileSync(curlLog, "utf8").split("\0") : null;
    return { ...r, curlArgs };
  };

  it.each([
    ["trailing newline", "abc\n"],
    ["embedded newline", "ab\ncd"],
    ["space", "ab c"],
  ])("%s → exit 1, clear error, zero curl calls", (_name, secret) => {
    const r = runSetup(secret);
    // The network-call check comes first: on the base branch the script also
    // exits 1 (the stubbed curl fails the create), so "no curl at all" is what
    // distinguishes a refusal from a failed attempt.
    expect(
      r.curlArgs,
      `setup-jira-webhook.sh reached curl before refusing:\n${r.curlArgs?.join(" ")}`
    ).toBeNull();
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/JIRA_WEBHOOK_SECRET contains whitespace or a newline/);
    expect(r.stderr).toMatch(/openssl rand -hex 32/);
    expect(r.stderr).not.toContain(secret.trim());
    expect(r.stdout).not.toMatch(/Checking for existing webhooks/);
  });

  it("a hex secret passes the guard and is sent to Jira byte-for-byte", () => {
    const r = runSetup(HEX);
    expect(r.stderr).not.toMatch(REFUSAL);
    // Reached Step 1 (list) and — since the failed list falls back to "[]" —
    // Step 2's create POST, whose JSON body carries the exact secret.
    expect(r.curlArgs).not.toBeNull();
    const body = r.curlArgs!.find((a) => a.trimStart().startsWith("{"));
    expect(body, `no JSON body in curl calls:\n${r.curlArgs!.join(" ")}`).toBeDefined();
    expect(JSON.parse(body!).secret).toBe(HEX);
  });

  it("unset secret: guard skipped, payload carries no secret field (byte-identical to before)", () => {
    const r = runSetup(undefined);
    expect(r.stderr).not.toMatch(REFUSAL);
    const body = r.curlArgs?.find((a) => a.trimStart().startsWith("{"));
    expect(body).toBeDefined();
    expect("secret" in JSON.parse(body!)).toBe(false);
  });
});

describe("set-env.sh refuses JIRA_WEBHOOK_SECRET with a newline/whitespace before any ecs call", () => {
  /**
   * Runs in place, like scripts/__tests__/si-ledger-handoff.test.mjs's set-env test.
   * AWS_ACCOUNT_ID is preset so config.sh:20 skips its sts probe; the fake aws
   * logs every call and refuses it, so the script can never get past the first
   * ecs call — the assertion that matters is whether that call happened at all.
   */
  const runSetEnv = (...args: string[]) => {
    const dir = scratch("set-env-secret-");
    const log = join(dir, "aws.log");
    shim(dir, "aws", `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho "fake aws: refusing $*" >&2\nexit 254\n`);
    const r = spawnSync("bash", [join(REPO_ROOT, "deploy", "ecs-express", "set-env.sh"), ...args], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 60_000,
      env: hermeticEnv(dir, { AWS_ACCOUNT_ID: "123456789012", AWS_REGION: "us-east-1" }),
    });
    return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };

  it.each([
    ["trailing newline", "abc\n"],
    ["embedded newline", "ab\ncd"],
    ["space", "ab c"],
  ])("%s → exit 1, error names the key, no ecs call", (_name, secret) => {
    const r = runSetEnv(`JIRA_WEBHOOK_SECRET=${secret}`, "--dry-run");
    // Same ordering rationale as the setup-script case: on base the "\n"-joined
    // merge swallowed the newline and the script went on to `ecs list-services`.
    expect(r.calls, `set-env.sh reached an ecs call before refusing:\n${r.calls}`).not.toMatch(/\becs\b/);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/JIRA_WEBHOOK_SECRET contains whitespace or a newline/);
    expect(r.stderr).not.toContain(secret.trim());
    expect(r.stdout).not.toMatch(/🔧/);
  });

  it("a hex secret passes the guard and proceeds to the service lookup", () => {
    const r = runSetEnv(`JIRA_WEBHOOK_SECRET=${HEX}`, "--dry-run");
    expect(r.stderr).not.toMatch(REFUSAL);
    expect(r.calls).toMatch(/^ecs list-services/m);
  });

  it("other keys are untouched: a newline in another value still reaches the lookup as before", () => {
    const r = runSetEnv("SOME_OTHER_KEY=abc\n", "--dry-run");
    expect(r.stderr).not.toMatch(/JIRA_WEBHOOK_SECRET/);
    expect(r.calls).toMatch(/^ecs list-services/m);
  });

  // TEAM-6352: the retiring key of a staged rotation is an HMAC key Jira held,
  // so set-env.sh holds it to the same rule (and names it in the error).
  it("JIRA_WEBHOOK_SECRET_PREVIOUS with whitespace → exit 1 naming that key, no ecs call", () => {
    const r = runSetEnv("JIRA_WEBHOOK_SECRET_PREVIOUS=ab c", "--dry-run");
    expect(r.calls, `set-env.sh reached an ecs call before refusing:\n${r.calls}`).not.toMatch(/\becs\b/);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/JIRA_WEBHOOK_SECRET_PREVIOUS contains whitespace or a newline/);
  });

  it("a hex JIRA_WEBHOOK_SECRET_PREVIOUS passes the guard and proceeds to the service lookup", () => {
    const r = runSetEnv(`JIRA_WEBHOOK_SECRET=${HEX}`, `JIRA_WEBHOOK_SECRET_PREVIOUS=${HEX}`, "--dry-run");
    expect(r.stderr).not.toMatch(/JIRA_WEBHOOK_SECRET(_PREVIOUS)? (is empty|contains)/);
    expect(r.calls).toMatch(/^ecs list-services/m);
  });

  it("--unset JIRA_WEBHOOK_SECRET (the documented rollback) is not guarded", () => {
    const r = runSetEnv("--unset", "JIRA_WEBHOOK_SECRET", "--dry-run");
    expect(r.stderr).not.toMatch(REFUSAL);
    expect(r.calls).toMatch(/^ecs list-services/m);
  });
});
