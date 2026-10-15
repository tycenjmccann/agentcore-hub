/**
 * TEAM-6337 — a full redeploy must not silently drop container env keys that
 * were applied live with deploy/ecs-express/set-env.sh.
 *
 * Root cause: deploy/ecs-express/deploy.sh and deploy/apprunner/deploy.sh rebuild
 * the whole container env from a fixed forward allow-list (shell + .env.local)
 * and never read the live service. Any key set live (TELEGRAM_*,
 * ANOMALY_INTAKE_SECRET, CODING_AGENT_RUNTIME_ARN, JIRA_WEBHOOK_SECRET …) that is
 * not also in .env.local — or not in the allow-list at all — vanished on the
 * next redeploy. TEAM-6336 fixed one key; this is the defect class.
 *
 * Fix: deploy/lib/env-drift-guard.sh. When the service already exists, both
 * scripts read the live env KEYS (never values) and refuse if any of them is
 * missing from the env they are about to submit, unless ALLOW_ENV_KEY_DROP=1.
 * It runs BEFORE any IAM/ECR/docker step, so a refused deploy changes nothing.
 * An update whose live env cannot be read fails closed (same rule as set-env.sh).
 *
 * Hermetic, same harness as jira-webhook-secret-forward.test.ts: scratch repo
 * tree, PATH-shimmed fake `aws` / `docker` that log every call, child env from an
 * allow-list. The fake `aws` reads the live describe JSON from the scratch dir
 * and flips list-services to "exists" once a create call is logged.
 *
 * Fail-on-base demo: DEPLOY_SH_ECS_EXPRESS / DEPLOY_SH_APPRUNNER point the suite
 * at another copy of a script (e.g. `git show main:deploy/ecs-express/deploy.sh`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "../../..");
const SENTINEL = "sentinel-live-value-do-not-print-7f3a";
const DROP_ERROR = /live .*env has keys the new env lacks/;

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Target = "ecs-express" | "apprunner";
const TARGETS: Target[] = ["ecs-express", "apprunner"];
const scriptFor = (target: Target): string =>
  (target === "ecs-express" ? process.env.DEPLOY_SH_ECS_EXPRESS : process.env.DEPLOY_SH_APPRUNNER) ??
  join(REPO_ROOT, "deploy", target, "deploy.sh");

type Call = string[];
const parseCalls = (log: string): Call[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\x1e")
        .filter((rec) => rec.length > 0)
        .map((rec) => rec.split("\0").filter((a, i, arr) => !(i === arr.length - 1 && a === "")))
    : [];
const argAfter = (call: Call, flag: string): string | undefined => {
  const i = call.indexOf(flag);
  return i >= 0 ? call[i + 1] : undefined;
};

const ECS_ARN = "arn:aws:ecs:us-east-1:123456789012:service/default/agentcore-hub";
const AR_ARN = "arn:aws:apprunner:us-east-1:123456789012:service/agentcore-hub/abc";

/** Fake aws. $ROOT/exists = the service exists; $ROOT/describe.json = the live describe. */
const AWS_SHIM = (root: string): string => `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${root}/aws.log"; printf '\\x1e' >> "${root}/aws.log"
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "ecr get-login-password") echo fake-token ;;
  "s3 cp") exit 1 ;;
  "ecs list-services")
    if [ -f "${root}/exists" ]; then echo '{"serviceArns":["${ECS_ARN}"]}'; else echo '{"serviceArns":[]}'; fi ;;
  "ecs create-express-gateway-service")
    [ "$3" = help ] && exit 0
    touch "${root}/exists"; echo "${ECS_ARN}" ;;
  "ecs describe-express-gateway-service") cat "${root}/describe.json" ;;
  "apprunner list-services")
    if [ -f "${root}/exists" ]; then
      echo '{"ServiceSummaryList":[{"ServiceName":"agentcore-hub","ServiceArn":"${AR_ARN}","Status":"RUNNING","ServiceUrl":"hub.example.awsapprunner.com"}]}'
    else echo '{"ServiceSummaryList":[]}'; fi ;;
  "apprunner create-service") touch "${root}/exists" ;;
  "apprunner describe-service") cat "${root}/describe.json" ;;
  *) : ;;
esac
exit 0
`;

const DOCKER_SHIM = (root: string): string => `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "${root}/docker.log"; printf '\\x1e' >> "${root}/docker.log"
cat >/dev/null 2>&1 || true
exit 0
`;

/** Live describe for an existing service whose env holds `live` (null = degraded: no container env). */
const describeJson = (target: Target, live: Record<string, string> | null): string => {
  if (target === "ecs-express") {
    const cfg: Record<string, unknown> = { ingressPaths: [{ endpoint: "hub.example.on.aws" }] };
    if (live) {
      cfg.primaryContainer = {
        image: "old-image",
        containerPort: 8080,
        environment: Object.entries(live).map(([name, value]) => ({ name, value })),
      };
    }
    return JSON.stringify({ service: { status: { statusCode: "ACTIVE" }, activeConfigurations: [cfg] } });
  }
  const image: Record<string, unknown> = { Port: "8080" };
  if (live) image.RuntimeEnvironmentVariables = live;
  return JSON.stringify({
    Service: {
      ServiceArn: AR_ARN,
      SourceConfiguration: { ImageRepository: { ImageIdentifier: "old-image", ImageConfiguration: image } },
    },
  });
};

// What the scripts always submit for the .env.local below: the three fixed keys,
// AWS_REGION, and the derived ARTIFACT_BUCKET default.
const BASE_LIVE = { HOSTNAME: "0.0.0.0", PORT: "8080", NODE_ENV: "production", AWS_REGION: "us-east-1" };
const DRIFTED_LIVE = { ...BASE_LIVE, TELEGRAM_BOT_TOKEN: SENTINEL, ANOMALY_INTAKE_SECRET: SENTINEL };

interface RunOpts {
  exists?: boolean;
  live?: Record<string, string> | null;
  envLocalExtra?: string;
  shellEnv?: Record<string, string>;
}

const runDeploy = (target: Target, opts: RunOpts = {}) => {
  const root = mkdtempSync(join(tmpdir(), `env-drift-${target}-`));
  scratchDirs.push(root);
  mkdirSync(join(root, "deploy", target), { recursive: true });
  cpSync(join(REPO_ROOT, "deploy", "lib"), join(root, "deploy", "lib"), { recursive: true });
  cpSync(scriptFor(target), join(root, "deploy", target, "deploy.sh"));
  mkdirSync(join(root, "src", "config"), { recursive: true });
  writeFileSync(join(root, "src", "config", "agents.json"), '{"agents":[]}\n');
  writeFileSync(
    join(root, ".env.local"),
    `AWS_REGION="us-east-1"\nEXPECTED_ACCOUNT_ID="123456789012"\n${opts.envLocalExtra ?? ""}`
  );
  if (opts.exists ?? true) writeFileSync(join(root, "exists"), "");
  writeFileSync(join(root, "describe.json"), describeJson(target, opts.live === undefined ? BASE_LIVE : opts.live));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of [
    ["aws", AWS_SHIM(root)],
    ["docker", DOCKER_SHIM(root)],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const childEnv: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C",
    ...(opts.shellEnv ?? {}),
  };
  const r = spawnSync("bash", [join(root, "deploy", target, "deploy.sh")], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv as NodeJS.ProcessEnv,
  });
  const aws = parseCalls(join(root, "aws.log"));
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stderr: r.stderr, aws, docker: parseCalls(join(root, "docker.log")) };
};

type Run = ReturnType<typeof runDeploy>;
const ops = (r: Run) => r.aws.map((c) => `${c[0]} ${c[1]}`);
const isWrite = (target: Target) => (op: string) =>
  target === "ecs-express"
    ? op === "ecs update-express-gateway-service" || op === "ecs create-express-gateway-service"
    : op === "apprunner update-service" || op === "apprunner create-service";

/** The env the script submitted on its update/create call, as a name→value map. */
const submittedEnv = (target: Target, r: Run): Record<string, string> => {
  const call = r.aws.find((c) => isWrite(target)(`${c[0]} ${c[1]}`) && c[2] !== "help");
  expect(call, `no update/create call:\n${ops(r).join("\n")}\n${r.out}`).toBeDefined();
  if (target === "ecs-express") {
    const pc = JSON.parse(argAfter(call!, "--primary-container")!) as { environment: { name: string; value: string }[] };
    return Object.fromEntries(pc.environment.map((e) => [e.name, e.value]));
  }
  const src = JSON.parse(argAfter(call!, "--source-configuration")!) as {
    ImageRepository: { ImageConfiguration: { RuntimeEnvironmentVariables: Record<string, string> } };
  };
  return src.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables;
};

/** Nothing was changed or built: no write call, no iam/ecr call, no docker build. */
const expectNothingMutated = (target: Target, r: Run) => {
  const o = ops(r);
  expect(r.aws.filter((c) => isWrite(target)(`${c[0]} ${c[1]}`) && c[2] !== "help"), o.join("\n")).toEqual([]);
  expect(o.filter((op) => op.startsWith("iam ") || op.startsWith("ecr ")), o.join("\n")).toEqual([]);
  expect(r.docker.filter((c) => c[0] === "buildx" || c[0] === "build" || c[0] === "push" || c[0] === "login"), "docker build/push/login reached").toEqual([]);
};

describe.each(TARGETS)("deploy/%s/deploy.sh refuses to drop live-only env keys (TEAM-6337)", (target) => {
  it("live env has keys the new env lacks → exit 1, names the keys (never values), changes nothing", () => {
    const r = runDeploy(target, { live: DRIFTED_LIVE });
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toMatch(DROP_ERROR);
    expect(r.stderr).toContain("ANOMALY_INTAKE_SECRET");
    expect(r.stderr).toContain("TELEGRAM_BOT_TOKEN");
    expect(r.stderr).toMatch(/ALLOW_ENV_KEY_DROP=1/);
    expect(r.out).not.toContain(SENTINEL);
    expectNothingMutated(target, r);
    // TEAM-6337 follow-up: set-env.sh only exists for ECS — the remediation text
    // must not point App Runner at a script that can't apply to it.
    if (target === "ecs-express") {
      expect(r.stderr).toMatch(/deploy\/ecs-express\/set-env\.sh/);
    } else {
      expect(r.stderr).not.toContain("set-env.sh");
    }
  });

  it("ALLOW_ENV_KEY_DROP=1 → deploys anyway with a warning naming the dropped keys", () => {
    const r = runDeploy(target, { live: DRIFTED_LIVE, shellEnv: { ALLOW_ENV_KEY_DROP: "1" } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARNING: dropping live env keys: ANOMALY_INTAKE_SECRET, TELEGRAM_BOT_TOKEN/);
    expect(r.out).not.toContain(SENTINEL);
    const env = submittedEnv(target, r);
    expect("TELEGRAM_BOT_TOKEN" in env).toBe(false);
  });

  it("a live key that .env.local also forwards is not drift", () => {
    const r = runDeploy(target, {
      live: { ...BASE_LIVE, ANOMALY_INTAKE_SECRET: SENTINEL },
      envLocalExtra: 'ANOMALY_INTAKE_SECRET="from-env-local"\n',
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(DROP_ERROR);
    expect(submittedEnv(target, r).ANOMALY_INTAKE_SECRET).toBe("from-env-local");
  });

  it("live keys ⊆ new keys → deploys, no warning (control)", () => {
    const r = runDeploy(target);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(DROP_ERROR);
    expect(r.out).not.toMatch(/WARNING: dropping live env keys/);
    expect(submittedEnv(target, r).AWS_REGION).toBe("us-east-1");
  });

  it("existing service whose live env cannot be read → fails closed, changes nothing", () => {
    const r = runDeploy(target, { live: null });
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toMatch(/could not read the live .*env/);
    expectNothingMutated(target, r);
  });

  it("no existing service (create path) → guard skipped, create submitted", () => {
    const r = runDeploy(target, { exists: false, live: DRIFTED_LIVE });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(DROP_ERROR);
    expect(submittedEnv(target, r).AWS_REGION).toBe("us-east-1");
  });

  it("still forwards the derived ARTIFACT_BUCKET default when .env.local does not set it", () => {
    const r = runDeploy(target);
    expect(r.status, r.out).toBe(0);
    expect(submittedEnv(target, r).ARTIFACT_BUCKET).toBe("agentcore-hub-artifacts-123456789012-us-east-1");
  });
});
