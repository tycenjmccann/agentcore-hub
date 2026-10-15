/**
 * TEAM-6336 (review round 3 on TEAM-6322) — a full redeploy must not silently
 * drop JIRA_WEBHOOK_SECRET from the hub.
 *
 * Root cause: deploy/ecs-express/deploy.sh and deploy/apprunner/deploy.sh rebuild
 * the whole container env from a fixed forward allow-list (shell + .env.local,
 * never the live service) and that list lacked JIRA_WEBHOOK_SECRET. After the
 * operator enabled signing with set-env.sh, the next full redeploy replaced the
 * container env without the secret and /api/jira/webhook reverted to unsigned
 * passthrough.
 *
 * Fix: both scripts source deploy/lib/jira-webhook-secret.sh right after
 * .env.local is loaded — BEFORE the first aws call — refuse a non-empty value
 * outside the shared charset, and forward the key. Unset or empty is not
 * forwarded (passthrough stays as it was). route.ts / hub-signature.ts untouched.
 *
 * Hermetic, same pattern as jira-webhook-secret-format.test.ts: a scratch repo
 * tree (so the script's own REPO_ROOT resolves there and a dev box's real
 * .env.local is never sourced), PATH-shimmed fake `aws` / `docker` that log every
 * call and answer the update path with canned JSON, and a child env built from
 * an allow-list (never process.env). The scripts have no sleep on this path:
 * the fake describe/list reports ACTIVE / RUNNING on the first poll.
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
const HEX = "a087bb7308b9ddb0e5281aa541d57292d3cc5a2b3a5837b4f6f10744dfdcd464";
const REFUSAL = /JIRA_WEBHOOK_SECRET (is empty|contains)/;

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

const shim = (dir: string, name: string, body: string): void => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
};

type Target = "ecs-express" | "apprunner";

/** One logged CLI call: argv as the shim received it. */
type Call = string[];

/** Calls are \x1e-separated records of NUL-separated args, so the multi-line App Runner JSON survives. */
const parseCalls = (log: string): Call[] | null => {
  if (!existsSync(log)) return null;
  return readFileSync(log, "utf8")
    .split("\x1e")
    .filter((rec) => rec.length > 0)
    .map((rec) => rec.split("\0").filter((a, i, arr) => !(i === arr.length - 1 && a === "")));
};

const argAfter = (call: Call, flag: string): string | undefined => {
  const i = call.indexOf(flag);
  return i >= 0 ? call[i + 1] : undefined;
};

/** Canned answers for the fake aws, keyed on "<service> <operation>"; everything else exits 0 silently. */
const AWS_SHIM = (log: string): string => `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${log}"; printf '\\x1e' >> "${log}"
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "ecr get-login-password") echo fake-token ;;
  # No deployed agents.json to bundle (some sandboxes inject ARTIFACT_BUCKET into
  # every child env, so this branch is reached): the script then keeps the
  # tracked copy, exactly as on a box whose bucket has no config yet.
  "s3 cp") exit 1 ;;
  "ecs list-services")
    echo '{"serviceArns":["arn:aws:ecs:us-east-1:123456789012:service/default/agentcore-hub"]}' ;;
  # TEAM-6337: the live env carries only keys every case here forwards, so the
  # drift guard (deploy/lib/env-drift-guard.sh) passes and the update is reached.
  "ecs describe-express-gateway-service")
    echo '{"service":{"status":{"statusCode":"ACTIVE"},"activeConfigurations":[{"ingressPaths":[{"endpoint":"hub.example.on.aws"}],"primaryContainer":{"image":"old","containerPort":8080,"environment":[{"name":"HOSTNAME","value":"0.0.0.0"},{"name":"PORT","value":"8080"},{"name":"NODE_ENV","value":"production"},{"name":"AWS_REGION","value":"us-east-1"}]}}]}}' ;;
  "apprunner list-services")
    echo '{"ServiceSummaryList":[{"ServiceName":"agentcore-hub","ServiceArn":"arn:aws:apprunner:us-east-1:123456789012:service/agentcore-hub/abc","Status":"RUNNING","ServiceUrl":"hub.example.awsapprunner.com"}]}' ;;
  "apprunner describe-service")
    echo '{"Service":{"SourceConfiguration":{"ImageRepository":{"ImageConfiguration":{"Port":"8080","RuntimeEnvironmentVariables":{"HOSTNAME":"0.0.0.0","PORT":"8080","NODE_ENV":"production","AWS_REGION":"us-east-1"}}}}}}' ;;
  *) : ;;
esac
exit 0
`;

const DOCKER_SHIM = (log: string): string => `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${log}"; printf '\\x1e' >> "${log}"
cat >/dev/null 2>&1 || true
exit 0
`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  aws: Call[] | null;
  docker: Call[] | null;
}

/**
 * Run deploy/<target>/deploy.sh from a scratch tree whose .env.local carries the
 * given extra lines (AWS_REGION + EXPECTED_ACCOUNT_ID are always present so the
 * account guard passes against the fake sts). EVAL_GATE is unset, so the
 * config-evals guard prints "skipped" and returns.
 */
const runDeploy = (target: Target, envLocalExtra: string): RunResult => {
  const root = scratch(`deploy-secret-forward-${target}-`);
  mkdirSync(join(root, "deploy", target), { recursive: true });
  cpSync(join(REPO_ROOT, "deploy", "lib"), join(root, "deploy", "lib"), { recursive: true });
  cpSync(join(REPO_ROOT, "deploy", target, "deploy.sh"), join(root, "deploy", target, "deploy.sh"));
  // Only hashed into the image tag; content is irrelevant here.
  mkdirSync(join(root, "src", "config"), { recursive: true });
  writeFileSync(join(root, "src", "config", "agents.json"), '{"agents":[]}\n');
  writeFileSync(
    join(root, ".env.local"),
    `AWS_REGION="us-east-1"\nEXPECTED_ACCOUNT_ID="123456789012"\n${envLocalExtra}`
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  const awsLog = join(root, "aws.log");
  const dockerLog = join(root, "docker.log");
  shim(bin, "aws", AWS_SHIM(awsLog));
  shim(bin, "docker", DOCKER_SHIM(dockerLog));

  // cwd is deliberately not the repo: the script must cd to its own REPO_ROOT.
  const r = spawnSync("bash", [join(root, "deploy", target, "deploy.sh")], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 120_000,
    env: hermeticEnv(bin),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, aws: parseCalls(awsLog), docker: parseCalls(dockerLog) };
};

/** The container env the script submitted on its update call, as a name→value map. */
const submittedEnv = (target: Target, r: RunResult): Record<string, string> => {
  expect(r.aws, `no aws calls were logged:\n${r.stdout}\n${r.stderr}`).not.toBeNull();
  if (target === "ecs-express") {
    const update = r.aws!.find((c) => c[0] === "ecs" && c[1] === "update-express-gateway-service");
    expect(update, `no ecs update-express-gateway-service call:\n${r.aws!.map((c) => c.slice(0, 2).join(" ")).join("\n")}`).toBeDefined();
    const pc = JSON.parse(argAfter(update!, "--primary-container")!) as {
      environment: { name: string; value: string }[];
    };
    return Object.fromEntries(pc.environment.map((e) => [e.name, e.value]));
  }
  const update = r.aws!.find((c) => c[0] === "apprunner" && c[1] === "update-service");
  expect(update, `no apprunner update-service call:\n${r.aws!.map((c) => c.slice(0, 2).join(" ")).join("\n")}`).toBeDefined();
  const src = JSON.parse(argAfter(update!, "--source-configuration")!) as {
    ImageRepository: { ImageConfiguration: { RuntimeEnvironmentVariables: Record<string, string> } };
  };
  return src.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables;
};

const TARGETS: Target[] = ["ecs-express", "apprunner"];

describe.each(TARGETS)("deploy/%s/deploy.sh forwards JIRA_WEBHOOK_SECRET from .env.local (TEAM-6336)", (target) => {
  it("forwards the secret byte-for-byte when .env.local sets a valid one", () => {
    const r = runDeploy(target, `JIRA_WEBHOOK_SECRET="${HEX}"\n`);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    const env = submittedEnv(target, r);
    // Control: the existing forward list still works.
    expect(env.AWS_REGION).toBe("us-east-1");
    // The P1: on the base branch this key is simply absent.
    expect(env.JIRA_WEBHOOK_SECRET).toBe(HEX);
  });

  it("leaves the secret absent when .env.local does not set it (passthrough unchanged)", () => {
    const r = runDeploy(target, "");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    const env = submittedEnv(target, r);
    expect(env.AWS_REGION).toBe("us-east-1");
    expect("JIRA_WEBHOOK_SECRET" in env).toBe(false);
  });

  it("leaves the secret absent when .env.local sets it empty (same opt-in rule as setup-jira-webhook.sh)", () => {
    const r = runDeploy(target, 'JIRA_WEBHOOK_SECRET=""\n');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(REFUSAL);
    const env = submittedEnv(target, r);
    expect("JIRA_WEBHOOK_SECRET" in env).toBe(false);
  });

  it.each([
    ["trailing newline", 'JIRA_WEBHOOK_SECRET="abc\n"\n', "abc", /whitespace or a newline/],
    ["space", 'JIRA_WEBHOOK_SECRET="ab c"\n', "ab c", /whitespace or a newline/],
    ["dollar (single-quoted so bash keeps it literal)", "JIRA_WEBHOOK_SECRET='a$b'\n", "a$b", /outside \[A-Za-z0-9\._~\+\/=-\]/],
  ])("%s → exit 1 with the shared refusal and ZERO aws/docker calls", (_name, line, value, reason) => {
    const r = runDeploy(target, line);
    // Ordering check first: on the base branch the script ignores the value
    // and runs the whole (fake) deploy, so a populated aws.log is what
    // distinguishes "refused before any AWS call" from "deployed anyway".
    expect(r.aws, `deploy.sh reached aws before refusing:\n${r.aws?.map((c) => c.slice(0, 2).join(" ")).join("\n")}`).toBeNull();
    expect(r.docker, "deploy.sh reached docker before refusing").toBeNull();
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(REFUSAL);
    expect(r.stderr).toMatch(reason);
    expect(r.stderr).toMatch(/openssl rand -hex 32/);
    expect(r.stderr).not.toContain(value);
    // Never got as far as the step banner.
    expect(r.stdout).not.toMatch(/\[1\/[56]\] ECR repository/);
  });
});

/**
 * Static pin, like load-env-local.test.ts's KNOWN_SITES sweep: the key must be in
 * each script's forward list, and the guard must be sourced before the first aws
 * invocation — so a future edit can't quietly reorder it behind a mutating call.
 */
describe.each(TARGETS)("deploy/%s/deploy.sh — static contract", (target) => {
  const text = readFileSync(join(REPO_ROOT, "deploy", target, "deploy.sh"), "utf8");

  it("lists JIRA_WEBHOOK_SECRET in the forward allow-list", () => {
    expect(text).toMatch(/for var in[^;]*\bJIRA_WEBHOOK_SECRET\b/);
  });

  it("sources deploy/lib/jira-webhook-secret.sh before its first aws call", () => {
    const sourceAt = text.search(/^\s*source\s+"\$REPO_ROOT\/deploy\/lib\/jira-webhook-secret\.sh"/m);
    const firstAws = text.search(/^[^#\n]*\baws\s+\w/m);
    expect(sourceAt, "guard not sourced").toBeGreaterThan(-1);
    expect(firstAws).toBeGreaterThan(-1);
    expect(sourceAt).toBeLessThan(firstAws);
  });
});
