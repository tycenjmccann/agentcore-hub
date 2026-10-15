/**
 * TEAM-6336 sibling — .claude-plugin/bin/apply-env.sh must not drop
 * JIRA_WEBHOOK_SECRET when it regenerates .env.local.
 *
 * Root cause: apply-env.sh rewrites .env.local wholesale from the /setup answers
 * blob (`} > "$ENV_FILE"`, after a .bak copy) and the skill never asks for the
 * webhook secret — DEPLOY.md has the operator add it to .env.local by hand. A
 * re-run of /setup therefore dropped the line, and because the full-redeploy
 * scripts now forward the secret FROM .env.local (same ticket), the next
 * deploy returned the hub to unsigned passthrough. Same defect class.
 *
 * Fix: answers.jira.webhook_secret (optional, like the other jira.* keys) wins
 * when non-empty; otherwise the existing .env.local value is carried over;
 * otherwise the key stays absent. Non-empty values go through the shared
 * charset guard BEFORE the backup/overwrite, so a refused run is a no-op.
 *
 * TEAM-6347 (ship review R2-F1/R2-F2 on PR #1001): the TEAM-6336 fix resolved
 * the secret for every run but EMITTED it only inside the workflow/jira
 * branch, so a re-run with modules ["core","cloud-code"] (or a provider switch
 * to dynamodb) still dropped it and the next deploy silently turned signing
 * off. Now the resolved secret is always emitted; answers.jira.
 * disable_webhook_signing === true is the one explicit way to drop it; a
 * secret + disable together is refused. DEPLOYMENT_URL is carried over too, and
 * a `JIRA_WEBHOOK_SECRET_NEW=1` marker is printed when the answers bring a
 * different secret onto an existing (non-placeholder) deployment, so the setup
 * skill can run the Jira webhook step BEFORE the hub redeploy (DEPLOY.md's
 * Jira-first order).
 *
 * Hermetic like jira-webhook-secret-format.test.ts: scratch tree keeping the
 * .claude-plugin/bin/../.. layout so the script's REPO_ROOT is the scratch dir,
 * child env from an allow-list, no network (the script only runs jq).
 *
 * TEAM-6352 (R3-F2): replacing an ALREADY-SET secret on an existing deployment
 * is a rotation, not a first enable. The NEW=1 marker sent the skill down the
 * Jira-first order, which with one hub key 401s every delivery until the hub
 * redeploys. Now the old value is kept as JIRA_WEBHOOK_SECRET_PREVIOUS and a
 * JIRA_WEBHOOK_SECRET_ROTATING=1 marker (hub first) is printed instead.
 *
 * Fail-on-base demo: APPLY_ENV_SH=<path> points the suite at another copy of
 * the script (e.g. `git show <base>:.claude-plugin/bin/apply-env.sh`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "../../..");
const APPLY_ENV_SH = process.env.APPLY_ENV_SH ?? join(REPO_ROOT, ".claude-plugin", "bin", "apply-env.sh");
const HEX = "a087bb7308b9ddb0e5281aa541d57292d3cc5a2b3a5837b4f6f10744dfdcd464";
const OTHER = "njlkSWWO1AxrYziUR8EoQ8x2kJC8EcEpxA6ldAefw/Q=";
const REFUSAL = /JIRA_WEBHOOK_SECRET (is empty|contains)/;
const MARKER = /^JIRA_WEBHOOK_SECRET_NEW=1\b/m;
const ROTATING = /^JIRA_WEBHOOK_SECRET_ROTATING=1\b/m;
const DEPLOYED_URL = "https://abc123.us-east-1.awsapprunner.com";

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

const JIRA_BLOCK = {
  site_url: "example.atlassian.net",
  email: "ops@example.com",
  api_token: "test-token",
  project_key: "TEAM",
};

type JiraBlock = Record<string, unknown> | null;

/** Full answers blob. `jira` defaults to the jira block; pass `null` for a non-Jira install. */
const answers = (opts: { modules?: string[]; ticketProvider?: string; jira?: JiraBlock } = {}) => ({
  brand_name: "Test Hub",
  modules: opts.modules ?? ["core", "workflow"],
  ticket_provider: opts.ticketProvider ?? "jira",
  workflow_runtimes: 1,
  deploy_mode: "lightweight",
  aws_account: "123456789012",
  aws_region: "us-east-1",
  github: { mode: "skip" },
  jira: opts.jira === undefined ? JIRA_BLOCK : opts.jira,
});

const jiraAnswers = (
  webhookSecret?: string,
  ticketProvider = "jira",
  modules: string[] = ["core", "workflow"],
  extraJira: Record<string, unknown> = {}
) =>
  answers({
    modules,
    ticketProvider,
    jira: { ...JIRA_BLOCK, ...(webhookSecret === undefined ? {} : { webhook_secret: webhookSecret }), ...extraJira },
  });

/** Scratch tree + run. `existingEnv` is the .env.local already on disk (undefined = first setup). */
const runApplyEnv = (answersBlob: object, existingEnv?: string, shellEnv: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "apply-env-secret-"));
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
  return { ...r, env, bak };
};

/** Lines of the form KEY="VALUE" → map (the script only ever emits that shape). */
const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => /^([A-Z_]+)="(.*)"$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]])
  );

const secretLines = (text: string) => text.split("\n").filter((l) => l.startsWith("JIRA_WEBHOOK_SECRET="));

// What DEPLOY.md step (a) leaves behind: a hand-added line after a first setup.
const EXISTING = `# Generated by .claude-plugin/bin/apply-env.sh — safe to edit by hand
NEXT_PUBLIC_BRAND_NAME="Test Hub"
AWS_REGION="us-east-1"
TICKET_PROVIDER="jira"
JIRA_SITE_URL="example.atlassian.net"
JIRA_WEBHOOK_SECRET="${HEX}"
`;
// …and what deploy.sh appends once the service is up (an existing deployment).
const EXISTING_DEPLOYED = `${EXISTING}DEPLOYMENT_URL="${DEPLOYED_URL}"\n`;
// A deployed hub that never had signing on (the R2-F2 first-time-enable case).
const DEPLOYED_UNSIGNED = `${EXISTING.replace(`JIRA_WEBHOOK_SECRET="${HEX}"\n`, "")}DEPLOYMENT_URL="${DEPLOYED_URL}"\n`;

describe("apply-env.sh keeps JIRA_WEBHOOK_SECRET across a /setup re-run (TEAM-6336)", () => {
  it("carries over an existing .env.local secret when the answers do not mention one", () => {
    const r = runApplyEnv(jiraAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    const env = parseEnv(r.env!);
    // Regenerated as before…
    expect(env.JIRA_API_TOKEN).toBe("test-token");
    expect(env.TICKET_TOOLS_LAMBDA).toBe("agentcore-hub-jira");
    // …and the hand-added secret survives byte-for-byte (dropped on the base branch).
    expect(env.JIRA_WEBHOOK_SECRET).toBe(HEX);
    expect(r.bak).toBe(EXISTING);
  });

  it("forwards answers.jira.webhook_secret like the other jira.* keys, and it wins over the existing line", () => {
    const r = runApplyEnv(jiraAnswers(OTHER), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(OTHER);
  });

  it("forwards answers.jira.webhook_secret on a first setup (no .env.local yet)", () => {
    const r = runApplyEnv(jiraAnswers(HEX));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(HEX);
    expect(r.bak).toBeNull();
  });

  it("stays absent when neither the answers nor the existing file carry one (signing off, as before)", () => {
    const r = runApplyEnv(jiraAnswers(), 'AWS_REGION="us-east-1"\nTICKET_PROVIDER="jira"\n');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    expect("JIRA_WEBHOOK_SECRET" in parseEnv(r.env!)).toBe(false);
  });

  it("treats an empty answers.jira.webhook_secret as not given (falls back to the existing line)", () => {
    const r = runApplyEnv(jiraAnswers(""), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(HEX);
  });

  it("reads only the file, never the caller's shell: a shell JIRA_WEBHOOK_SECRET is not written", () => {
    const r = runApplyEnv(jiraAnswers(), 'AWS_REGION="us-east-1"\n', { JIRA_WEBHOOK_SECRET: HEX });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect("JIRA_WEBHOOK_SECRET" in parseEnv(r.env!)).toBe(false);
  });

  // TEAM-6347 flipped this rule on purpose. Before: a provider switch to
  // dynamodb dropped the secret along with the other JIRA_* keys. Now a signing
  // secret is never dropped by a provider or module choice — only
  // jira.disable_webhook_signing does that (next describe).
  it("keeps the secret when the ticket provider is dynamodb, while the other JIRA_* keys are still not written (TEAM-6347: provider choice never drops a signing secret)", () => {
    const r = runApplyEnv(jiraAnswers(undefined, "dynamodb"), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect("JIRA_SITE_URL" in env).toBe(false);
    expect(env.TICKET_TOOLS_LAMBDA).toBe("agentcore-hub-tickets");
    expect(env.JIRA_WEBHOOK_SECRET).toBe(HEX);
  });

  // A *trailing* newline is not a case here: `$(jq -r …)` strips it before the
  // guard runs, and since .env.local is the single source every consumer reads,
  // the two sides still hold the same bytes (unlike TEAM-6334's two writers).
  it.each([
    ["embedded newline", "ab\ncd", /whitespace or a newline/],
    ["space", "ab c", /whitespace or a newline/],
    ["dollar", "a$b", /outside \[A-Za-z0-9\._~\+\/=-\]/],
  ])("an invalid answers secret (%s) → exit 1, refusal, .env.local and no .bak untouched", (_n, secret, reason) => {
    const r = runApplyEnv(jiraAnswers(secret), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(REFUSAL);
    expect(r.stderr).toMatch(reason);
    expect(r.stderr).not.toContain(secret.trim());
    // Refused before the backup/overwrite: the file is byte-identical and no .bak exists.
    expect(r.env).toBe(EXISTING);
    expect(r.bak).toBeNull();
    expect(r.stdout).not.toMatch(/Wrote/);
  });

  it("an invalid existing line is refused the same way, leaving the file for the operator to fix", () => {
    const broken = EXISTING.replace(`"${HEX}"`, '"ab c"');
    const r = runApplyEnv(jiraAnswers(), broken);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/whitespace or a newline/);
    expect(r.env).toBe(broken);
    expect(r.bak).toBeNull();
  });
});

describe("apply-env.sh keeps JIRA_WEBHOOK_SECRET regardless of module set and ticket provider (TEAM-6347 R2-F1)", () => {
  it('re-run with modules ["core","cloud-code"] (no Workflow module, jira: null) carries the on-disk secret over', () => {
    const r = runApplyEnv(answers({ modules: ["core", "cloud-code"], jira: null }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    const env = parseEnv(r.env!);
    // No workflow block at all…
    expect("TICKET_PROVIDER" in env).toBe(false);
    expect("JIRA_SITE_URL" in env).toBe(false);
    // …yet the signing secret survives (dropped on the base branch: the emit sat inside the workflow branch).
    expect(env.JIRA_WEBHOOK_SECRET).toBe(HEX);
    expect(r.bak).toBe(EXISTING);
  });

  it('re-run with modules ["core"] alone carries it over too', () => {
    const r = runApplyEnv(answers({ modules: ["core"], jira: null }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(HEX);
  });

  it("a jira-provider run writes the key exactly once (the old nested emit is gone)", () => {
    const r = runApplyEnv(jiraAnswers(), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(secretLines(r.env!)).toHaveLength(1);
  });

  it("nothing resolved and no Workflow module → no line (unchanged: signing stays off)", () => {
    const r = runApplyEnv(answers({ modules: ["core"], jira: null }), 'AWS_REGION="us-east-1"\n');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    expect("JIRA_WEBHOOK_SECRET" in parseEnv(r.env!)).toBe(false);
    expect(r.stdout).not.toMatch(/disabled by/);
  });

  it("jira.disable_webhook_signing: true is the explicit opt-out — the on-disk secret is dropped and a notice printed", () => {
    const r = runApplyEnv(jiraAnswers(undefined, "jira", ["core", "workflow"], { disable_webhook_signing: true }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect("JIRA_WEBHOOK_SECRET" in parseEnv(r.env!)).toBe(false);
    expect(r.stdout).toMatch(/disabled by answers\.jira\.disable_webhook_signing/);
    expect(r.stdout).toMatch(/--unset JIRA_WEBHOOK_SECRET/);
    expect(r.stdout).not.toContain(HEX);
    expect(r.bak).toBe(EXISTING);
  });

  it("the opt-out skips the charset guard: a malformed leftover line is dropped, not refused", () => {
    const broken = EXISTING.replace(`"${HEX}"`, '"ab c"');
    const r = runApplyEnv(jiraAnswers(undefined, "jira", ["core", "workflow"], { disable_webhook_signing: true }), broken);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    expect("JIRA_WEBHOOK_SECRET" in parseEnv(r.env!)).toBe(false);
  });

  it('the opt-out must be the JSON boolean true — the string "true" is not an opt-out', () => {
    const r = runApplyEnv(jiraAnswers(undefined, "jira", ["core", "workflow"], { disable_webhook_signing: "true" }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(HEX);
    expect(r.stdout).not.toMatch(/disabled by/);
  });

  it("webhook_secret and disable_webhook_signing together → exit 1 before the backup, nothing written, value not echoed", () => {
    const r = runApplyEnv(jiraAnswers(OTHER, "jira", ["core", "workflow"], { disable_webhook_signing: true }), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/both jira\.webhook_secret and jira\.disable_webhook_signing/);
    expect(r.stderr).not.toContain(OTHER);
    expect(r.env).toBe(EXISTING);
    expect(r.bak).toBeNull();
    expect(r.stdout).not.toMatch(/Wrote/);
  });
});

describe("apply-env.sh carries DEPLOYMENT_URL over and flags a NEW secret on an existing deployment (TEAM-6347 R2-F2)", () => {
  it("re-emits the prior DEPLOYMENT_URL verbatim, whatever the module set, so setup-jira-webhook.sh can run before the redeploy", () => {
    const r = runApplyEnv(answers({ modules: ["core", "cloud-code"], jira: null }), EXISTING_DEPLOYED);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.DEPLOYMENT_URL).toBe(DEPLOYED_URL);
    expect(env.JIRA_WEBHOOK_SECRET).toBe(HEX);
  });

  it("no DEPLOYMENT_URL on disk → none written; first setup → none written", () => {
    const a = runApplyEnv(jiraAnswers(), EXISTING);
    expect(a.status, `${a.stdout}\n${a.stderr}`).toBe(0);
    expect("DEPLOYMENT_URL" in parseEnv(a.env!)).toBe(false);
    const b = runApplyEnv(jiraAnswers(HEX));
    expect(b.status, `${b.stdout}\n${b.stderr}`).toBe(0);
    expect("DEPLOYMENT_URL" in parseEnv(b.env!)).toBe(false);
  });

  it("reads DEPLOYMENT_URL only from the file, never the caller's shell", () => {
    const r = runApplyEnv(jiraAnswers(), EXISTING, { DEPLOYMENT_URL: DEPLOYED_URL });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect("DEPLOYMENT_URL" in parseEnv(r.env!)).toBe(false);
  });

  it("rotation (TEAM-6352): answers secret replaces an already-set one on a deployment → ROTATING=1 (not NEW=1), old kept as PREVIOUS, values not echoed", () => {
    const r = runApplyEnv(jiraAnswers(OTHER), EXISTING_DEPLOYED);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(ROTATING);
    expect(r.stdout.match(/JIRA_WEBHOOK_SECRET_ROTATING=1/g)).toHaveLength(1);
    expect(r.stdout).not.toMatch(MARKER);
    expect(r.stdout).toMatch(/redeploy the hub FIRST, THEN run \.\/deploy\/apprunner\/setup-jira-webhook\.sh/);
    expect(r.stdout).not.toContain(OTHER);
    expect(r.stdout).not.toContain(HEX);
    const env = parseEnv(r.env!);
    expect(env.JIRA_WEBHOOK_SECRET).toBe(OTHER);
    expect(env.JIRA_WEBHOOK_SECRET_PREVIOUS).toBe(HEX);
  });

  it("marker: first-time enable on a deployed hub that had no secret (the R2-F2 case) → fires", () => {
    const r = runApplyEnv(jiraAnswers(HEX), DEPLOYED_UNSIGNED);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(MARKER);
    expect(r.stdout).not.toMatch(ROTATING);
    expect(parseEnv(r.env!).DEPLOYMENT_URL).toBe(DEPLOYED_URL);
    expect("JIRA_WEBHOOK_SECRET_PREVIOUS" in parseEnv(r.env!)).toBe(false);
  });

  it("no marker when the answers secret equals the on-disk one", () => {
    const r = runApplyEnv(jiraAnswers(HEX), EXISTING_DEPLOYED);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
  });

  it("no marker when nothing is deployed (no DEPLOYMENT_URL on disk)", () => {
    const r = runApplyEnv(jiraAnswers(OTHER), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
  });

  it("no marker on a first install (no .env.local yet)", () => {
    const r = runApplyEnv(jiraAnswers(HEX));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
  });

  it.each([
    ["byo placeholder (SKILL.md)", "https://placeholder.example"],
    ["App Runner URL-lookup fallback (deploy.sh)", "https://placeholder.apprunner.example"],
  ])("no marker when DEPLOYMENT_URL is a placeholder — %s — so the skill never points Jira at it", (_n, url) => {
    const r = runApplyEnv(jiraAnswers(OTHER), `${EXISTING}DEPLOYMENT_URL="${url}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
    // The placeholder itself is still carried over (last known value).
    expect(parseEnv(r.env!).DEPLOYMENT_URL).toBe(url);
  });

  it("no marker on plain carry-over (answers give no secret)", () => {
    const r = runApplyEnv(jiraAnswers(), EXISTING_DEPLOYED);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET).toBe(HEX);
  });
});

describe("apply-env.sh staged rotation keeps the old key as JIRA_WEBHOOK_SECRET_PREVIOUS (TEAM-6352 R3-F2)", () => {
  it("rotation with nothing deployed → neither marker, no PREVIOUS (no hub to protect)", () => {
    const r = runApplyEnv(jiraAnswers(OTHER), EXISTING);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(MARKER);
    expect(r.stdout).not.toMatch(ROTATING);
    expect("JIRA_WEBHOOK_SECRET_PREVIOUS" in parseEnv(r.env!)).toBe(false);
  });

  it("a re-run mid-rotation carries PREVIOUS over (else the next full redeploy reopens the window), no marker", () => {
    const r = runApplyEnv(jiraAnswers(), `${EXISTING_DEPLOYED.replace(HEX, OTHER)}JIRA_WEBHOOK_SECRET_PREVIOUS="${HEX}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect(env.JIRA_WEBHOOK_SECRET).toBe(OTHER);
    expect(env.JIRA_WEBHOOK_SECRET_PREVIOUS).toBe(HEX);
    expect(r.stdout).not.toMatch(ROTATING);
    expect(r.stdout).not.toMatch(MARKER);
    expect(r.stdout).not.toContain(HEX);
  });

  it("carries PREVIOUS regardless of module set (same rule as the current secret)", () => {
    const r = runApplyEnv(answers({ modules: ["core", "cloud-code"], jira: null }), `${EXISTING_DEPLOYED.replace(HEX, OTHER)}JIRA_WEBHOOK_SECRET_PREVIOUS="${HEX}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(parseEnv(r.env!).JIRA_WEBHOOK_SECRET_PREVIOUS).toBe(HEX);
  });

  it("a PREVIOUS equal to the resolved current secret is not emitted", () => {
    const r = runApplyEnv(jiraAnswers(), `${EXISTING_DEPLOYED}JIRA_WEBHOOK_SECRET_PREVIOUS="${HEX}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect("JIRA_WEBHOOK_SECRET_PREVIOUS" in parseEnv(r.env!)).toBe(false);
  });

  it("disable_webhook_signing drops PREVIOUS too", () => {
    const r = runApplyEnv(jiraAnswers(undefined, "jira", ["core", "workflow"], { disable_webhook_signing: true }), `${EXISTING_DEPLOYED}JIRA_WEBHOOK_SECRET_PREVIOUS="${OTHER}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const env = parseEnv(r.env!);
    expect("JIRA_WEBHOOK_SECRET" in env).toBe(false);
    expect("JIRA_WEBHOOK_SECRET_PREVIOUS" in env).toBe(false);
  });

  it("a malformed carried-over PREVIOUS is refused before the backup/overwrite, naming the variable", () => {
    const existing = `${EXISTING_DEPLOYED}JIRA_WEBHOOK_SECRET_PREVIOUS="ab c"\n`;
    const r = runApplyEnv(jiraAnswers(), existing);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/JIRA_WEBHOOK_SECRET_PREVIOUS contains whitespace/);
    expect(r.env).toBe(existing);
    expect(r.bak).toBeNull();
  });
});
