/**
 * TEAM-6338 — .claude-plugin/bin/apply-env.sh must not drop keys in
 * .env.local that it does not itself manage.
 *
 * Root cause: apply-env.sh rewrites .env.local wholesale from a fixed set of
 * `emit` calls (`} > "$ENV_FILE"`, after a .bak copy). Before this fix, the
 * only two keys ever read back from the previous file were
 * JIRA_WEBHOOK_SECRET and DEPLOYMENT_URL (TEAM-6336/6347). Every other key
 * was dropped on a /setup re-run: a hand-added one (e.g. EXPECTED_ACCOUNT_ID,
 * which DEPLOY.md has the operator add by hand) and the ones run-module.sh /
 * deploy.sh upsert into .env.local AFTER apply-env.sh has run (
 * BUILDER_AGENT_ID, CODING_AGENT_RUNTIME_ARN, CLOUD_CODE_TABLE,
 * AGENTCORE_ROLE_ARN, LAMBDA_ROLE_ARN). This contradicted both this script's
 * own "safe to edit by hand" header and the setup skill's "Never wipe
 * .env.local" promise (skills/setup/SKILL.md, "Re-runs").
 *
 * Fix: MANAGED_KEYS lists every key apply-env.sh itself can emit (including
 * JIRA_WEBHOOK_SECRET/DEPLOYMENT_URL — their carry-over/drop rules are
 * unchanged, see apply-env-jira-webhook-secret.test.ts). Any other assignment
 * line found in the previous .env.local, plus any hand-written comment, is
 * carried over byte-for-byte into a trailing "Preserved" section. This
 * script's own generated comments/section headers are not themselves
 * preserved, so a re-run is idempotent. The write goes to a temp file first,
 * then mv into place.
 *
 * Hermetic like the sibling suite: scratch tree keeping the
 * .claude-plugin/bin/../.. layout so the script's REPO_ROOT is the scratch
 * dir, child env from an allow-list, no network (the script only runs jq).
 *
 * Fail-on-base demo: APPLY_ENV_SH=<path> points the suite at another copy of
 * the script (e.g. `git show origin/main:.claude-plugin/bin/apply-env.sh`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "../../..");
const APPLY_ENV_SH = process.env.APPLY_ENV_SH ?? join(REPO_ROOT, ".claude-plugin", "bin", "apply-env.sh");

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hermeticEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
  };
  return { ...base, ...extra } as NodeJS.ProcessEnv;
};

const baseAnswers = (opts: { modules?: string[] } = {}) => ({
  brand_name: "Test Hub",
  modules: opts.modules ?? ["core", "workflow"],
  ticket_provider: "dynamodb",
  workflow_runtimes: 1,
  deploy_mode: "lightweight",
  aws_account: "123456789012",
  aws_region: "us-east-1",
  github: { mode: "skip" },
  jira: null,
});

/** Scratch tree + run. `existingEnv` is the .env.local already on disk (undefined = first setup). */
const runApplyEnv = (answersBlob: object, existingEnv?: string, shellEnv: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "apply-env-preserve-"));
  scratchDirs.push(root);
  mkdirSync(join(root, ".claude-plugin", "bin"), { recursive: true });
  cpSync(APPLY_ENV_SH, join(root, ".claude-plugin", "bin", "apply-env.sh"));
  cpSync(join(REPO_ROOT, "deploy", "lib"), join(root, "deploy", "lib"), { recursive: true });
  const envFile = join(root, ".env.local");
  if (existingEnv !== undefined) writeFileSync(envFile, existingEnv);
  const answersPath = join(root, "answers.json");
  writeFileSync(answersPath, JSON.stringify(answersBlob));

  const r = spawnSync("bash", [join(root, ".claude-plugin", "bin", "apply-env.sh"), answersPath], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 60_000,
    env: hermeticEnv(shellEnv),
  });
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
  const bak = existsSync(`${envFile}.bak`) ? readFileSync(`${envFile}.bak`, "utf8") : null;
  const mode = existsSync(envFile) ? (statSync(envFile).mode & 0o777).toString(8) : null;
  // Any leftover `.env.local.XXXXXX` mktemp scratch file would mean the
  // mv-into-place step did not run to completion.
  const leftoverTemp = readdirSync(root).some((f) => f !== ".env.local" && f !== ".env.local.bak" && f.startsWith(".env.local"));
  return { ...r, root, env, bak, mode, leftoverTemp };
};

/** Lines of the form [export] KEY="VALUE" or KEY=VALUE → map (loose enough for unquoted/export hand-added lines). */
const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")])
  );

// What DEPLOY.md's operator-by-hand step, run-module.sh and deploy.sh leave
// behind across a real install: the generated header, a managed key with a
// stale value, the four TEAM-6338 ticket keys, an unquoted hand-added value,
// an `export` line, and a hand-written comment.
const EXISTING = `# Generated by .claude-plugin/bin/apply-env.sh — safe to edit by hand
# Modules: core,workflow

NEXT_PUBLIC_BRAND_NAME="Test Hub"
AWS_REGION="us-west-2"
TICKET_PROVIDER="dynamodb"

# --- Preserved from previous .env.local (not managed by /setup) ---
DEPLOYMENT_URL="https://abc123.us-east-1.awsapprunner.com"
EXPECTED_ACCOUNT_ID="123456789012"
CODING_AGENT_RUNTIME_ARN="arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/coding-agent-abc"
BUILDER_AGENT_ID=abc123
AGENTCORE_ROLE_ARN="arn:aws:iam::123456789012:role/agentcore-hub-runtime"
LAMBDA_ROLE_ARN="arn:aws:iam::123456789012:role/agentcore-hub-lambda"
CLOUD_CODE_TABLE="agentcore-hub-cloud-code"
# a note I left myself
export MY_EXPORTED_VAR="kept too"
`;

describe("apply-env.sh preserves keys it does not manage across a /setup re-run (TEAM-6338)", () => {
  it("the four ticket keys — DEPLOYMENT_URL, EXPECTED_ACCOUNT_ID, CODING_AGENT_RUNTIME_ARN, BUILDER_AGENT_ID — all survive a re-run", () => {
    const r = runApplyEnv(baseAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.DEPLOYMENT_URL).toBe("https://abc123.us-east-1.awsapprunner.com");
    expect(env.EXPECTED_ACCOUNT_ID).toBe("123456789012");
    expect(env.CODING_AGENT_RUNTIME_ARN).toBe("arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/coding-agent-abc");
    expect(env.BUILDER_AGENT_ID).toBe("abc123");
  });

  it("also preserves keys run-module.sh/deploy.sh add that aren't in the ticket's four, plus an export line and a hand comment", () => {
    const r = runApplyEnv(baseAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.AGENTCORE_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/agentcore-hub-runtime");
    expect(env.LAMBDA_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/agentcore-hub-lambda");
    expect(env.CLOUD_CODE_TABLE).toBe("agentcore-hub-cloud-code");
    expect(env.MY_EXPORTED_VAR).toBe("kept too");
    expect(r.env).toContain("# a note I left myself");
  });

  it("survives a re-run with a smaller module set (no Workflow module)", () => {
    const r = runApplyEnv(baseAnswers({ modules: ["core", "cloud-code"] }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.BUILDER_AGENT_ID).toBe("abc123");
    expect(env.CODING_AGENT_RUNTIME_ARN).toBe("arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/coding-agent-abc");
    expect(env.EXPECTED_ACCOUNT_ID).toBe("123456789012");
    // The regenerated side still drops the workflow block as before.
    expect("TICKET_PROVIDER" in env).toBe(false);
  });

  it("a managed key with a stale on-disk value is replaced, not carried over, and appears exactly once", () => {
    const r = runApplyEnv(baseAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.AWS_REGION).toBe("us-east-1"); // from the answers, not the stale "us-west-2"
    expect(r.env!.match(/^AWS_REGION=/gm)).toHaveLength(1);
  });

  it("is idempotent: a second run produces a byte-identical file (no stacked 'Preserved' sections)", () => {
    const first = runApplyEnv(baseAnswers(), EXISTING);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const second = runApplyEnv(baseAnswers(), first.env!);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.env).toBe(first.env);
    expect(second.env!.match(/# --- Preserved from previous \.env\.local/g)).toHaveLength(1);
  });

  it("the write is atomic: no leftover .env.local.XXXXXX temp file after a run, and the final file is mode 600", () => {
    const r = runApplyEnv(baseAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.leftoverTemp).toBe(false);
    expect(r.mode).toBe("600");
  });

  it("a first install with no .env.local yet still works and writes nothing to a 'Preserved' section", () => {
    const r = runApplyEnv(baseAnswers());
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.env).not.toContain("# --- Preserved from previous .env.local");
    expect(r.bak).toBeNull();
  });

  it("a plain hand-added key with no run-module.sh/deploy.sh involvement also survives", () => {
    const r = runApplyEnv(baseAnswers(), 'AWS_REGION="us-east-1"\nMY_CUSTOM_KEY="custom value with spaces"\n');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).MY_CUSTOM_KEY).toBe("custom value with spaces");
  });

  it("every MANAGED_KEYS entry in the script matches an actual `emit KEY` call site (parity guard)", () => {
    const script = readFileSync(APPLY_ENV_SH, "utf8");
    const managedMatch = /MANAGED_KEYS=\(([\s\S]*?)\)/.exec(script);
    expect(managedMatch, "apply-env.sh must define a MANAGED_KEYS list").not.toBeNull();
    const managedKeys = managedMatch![1].match(/[A-Z_][A-Z0-9_]*/g) ?? [];
    // Only actual call sites (lines that start with `emit `, ignoring
    // indentation) — excludes the comments above that mention "emit" in
    // prose, like the "`emit KEY ...` call sites" phrase right above the
    // MANAGED_KEYS declaration.
    const emittedKeys = new Set(
      script
        .split("\n")
        .map((l) => /^\s*emit\s+([A-Z_][A-Z0-9_]*)\b/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1])
    );
    for (const key of emittedKeys) {
      expect(managedKeys, `emit ${key} has no MANAGED_KEYS entry — a re-run would duplicate it in the 'Preserved' section`).toContain(key);
    }
  });
});
