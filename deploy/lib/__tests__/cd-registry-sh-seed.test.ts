import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * scripts/cd-registry.sh `seed` (TEAM-5125), the sibling of the buildspec-deploy.yml
 * Target 2 defect fixed in the same ticket (deploy/pipeline/test_buildspec_deploy_seed.py).
 *
 * `seed` used to be its own hand-rolled `head-object || aws s3 cp`: ANY head-object
 * failure — a throttle, an expired token, a 5xx, not just a real 404 — read as
 * "absent" and the unconditional cp then overwrote the LIVE CD registry (the
 * deploy-trigger allow-list) with the empty repo seed. It now sources the same
 * shared helper (deploy/lib/s3-seed-if-absent.sh) Target 2 and lambda/cost-report/
 * deploy.sh use, so a HEAD error other than a real 404 fails the command instead of
 * seeding, and the write is a conditional create (put-object --if-none-match).
 *
 * Hermetic: cd-registry.sh is copied into a throwaway REPO_ROOT (so its
 * `source deploy/config.sh` no-ops — the file doesn't exist there, and `|| true`
 * swallows that) alongside a real copy of the helper and the repo's seed file, and
 * run under a fake `aws` (fixtures/fake-aws-s3.sh) with an on-disk store.
 */

const REPO = resolve(__dirname, "../../..");
const SCRIPT = resolve(REPO, "scripts/cd-registry.sh");
const HELPER = resolve(REPO, "deploy/lib/s3-seed-if-absent.sh");
const SEED_FILE = resolve(REPO, "src/config/cd-registry.json");
const FAKE_AWS = resolve(__dirname, "fixtures/fake-aws-s3.sh");

const HEAD_THROTTLE = "An error occurred (ThrottlingException) when calling the HeadObject operation: Rate exceeded";
const FOREIGN = '{"foreign":"created by another writer between HEAD and PUT"}';
const SEED_CONTENT = readFileSync(SEED_FILE, "utf8");

let tmp: string;
let root: string;
let store: string;
let log: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cd-registry-seed-"));
  root = join(tmp, "root");
  store = join(tmp, "store");
  log = join(tmp, "aws.log");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "deploy/lib"), { recursive: true });
  mkdirSync(join(root, "src/config"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts/cd-registry.sh"));
  chmodSync(join(root, "scripts/cd-registry.sh"), 0o755);
  copyFileSync(HELPER, join(root, "deploy/lib/s3-seed-if-absent.sh"));
  copyFileSync(SEED_FILE, join(root, "src/config/cd-registry.json"));
  mkdirSync(join(tmp, "bin"));
  copyFileSync(FAKE_AWS, join(tmp, "bin/aws"));
  chmodSync(join(tmp, "bin/aws"), 0o755);
  mkdirSync(join(store, "config"), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seed(env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(root, "scripts/cd-registry.sh"), "seed"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
      ARTIFACT_BUCKET: "fake-artifacts",
      AWS_REGION: "us-east-1",
      FAKE_S3_STORE: store,
      FAKE_S3_LOG: log,
      S3_SEED_RETRY_SLEEP: "0 0",
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const stored = () => (existsSync(join(store, "config/cd-registry.json")) ? readFileSync(join(store, "config/cd-registry.json"), "utf8") : null);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const puts = () => calls().filter((l) => l.startsWith("s3api put-object"));
const cps = () => calls().filter((l) => l.startsWith("s3 cp"));

describe("scripts/cd-registry.sh seed", () => {
  it("absent → seeded via a conditional create, not a plain cp", () => {
    const r = seed();
    expect(r.code, r.out).toBe(0);
    expect(stored()).toBe(SEED_CONTENT);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toContain("--if-none-match *");
    expect(cps()).toEqual([]);
  });

  it("present → the live registry is kept; nothing written", () => {
    writeFileSync(join(store, "config/cd-registry.json"), FOREIGN);
    const r = seed();
    expect(r.code, r.out).toBe(0);
    expect(stored()).toBe(FOREIGN);
    expect(puts()).toEqual([]);
    expect(cps()).toEqual([]);
  });

  it("a HEAD throttle fails the command and keeps the live registry — the bug this fixes", () => {
    writeFileSync(join(store, "config/cd-registry.json"), FOREIGN);
    const r = seed({ FAKE_S3_HEAD_ERR: HEAD_THROTTLE, FAKE_S3_HEAD_ERR_KEY: "config/cd-registry.json" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/ERROR: head-object config\/cd-registry\.json failed/);
    expect(stored()).toBe(FOREIGN);
    expect(puts()).toEqual([]);
    expect(cps()).toEqual([]);
  });

  it("a concurrent create between HEAD and PUT keeps the other writer's registry", () => {
    const r = seed({ FAKE_S3_APPEAR_AFTER_HEAD: "config/cd-registry.json", FAKE_S3_APPEAR_CONTENT: FOREIGN });
    expect(r.code, r.out).toBe(0);
    expect(stored()).toBe(FOREIGN);
    expect(r.out).toMatch(/appeared after the head check/);
  });
});
