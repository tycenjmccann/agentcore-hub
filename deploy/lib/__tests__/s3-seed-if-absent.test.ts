import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Unit tests for deploy/lib/s3-seed-if-absent.sh (TEAM-5081).
 *
 * The helper is the ONE seeder both lambda/cost-report/deploy.sh and the
 * pipeline's Target 2 use for the live config/*.json documents. Its contract:
 * HEAD is only a fast path (404-only absence, TEAM-5073); the WRITE is the guard
 * (`put-object --if-none-match '*'`), so a writer that creates the key between
 * the HEAD and the PUT keeps its document (412 = kept, not an error); a 409 race
 * is retried a bounded number of times; anything else fails the deploy.
 *
 * Hermetic: a fake `aws` (fixtures/fake-aws-s3.sh) on PATH keeps an on-disk
 * store that honours --if-none-match, so each case reads back WHAT is stored,
 * not just which command ran.
 */

const HELPER = resolve(__dirname, "../s3-seed-if-absent.sh");
const FAKE_AWS = resolve(__dirname, "fixtures/fake-aws-s3.sh");

const HEAD_403 = "An error occurred (403) when calling the HeadObject operation: Forbidden";
const HEAD_EXPIRED = "An error occurred (ExpiredToken) when calling the HeadObject operation: The provided token has expired.";
const PUT_403 = "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied";
const FOREIGN = '{"foreign":"created by another writer between HEAD and PUT"}';

let tmp: string;
let store: string;
let log: string;
let seedFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "s3-seed-"));
  store = join(tmp, "store");
  log = join(tmp, "aws.log");
  mkdirSync(join(tmp, "bin"));
  mkdirSync(store);
  copyFileSync(FAKE_AWS, join(tmp, "bin/aws"));
  chmodSync(join(tmp, "bin/aws"), 0o755);
  seedFile = join(tmp, "seed.json");
  writeFileSync(seedFile, '{"seed":true}\n');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function seed(key: string, env: Record<string, string> = {}, file = seedFile) {
  const r = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; source "$1"; s3_seed_if_absent fake-bucket "$2" "$3" us-east-1`, "_", HELPER, key, file],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
        FAKE_S3_STORE: store,
        FAKE_S3_LOG: log,
        S3_SEED_RETRY_SLEEP: "0 0",
        ...env,
      },
    }
  );
  return { code: r.status, out: r.stdout + r.stderr };
}
const stored = (key: string) => (existsSync(join(store, key)) ? readFileSync(join(store, key), "utf8") : null);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const puts = (key: string) => calls().filter((l) => l.startsWith("s3api put-object") && l.includes(`--key ${key} `));
const cps = () => calls().filter((l) => l.startsWith("s3 cp"));

describe("s3_seed_if_absent", () => {
  it("present → the live document is kept; no write of any kind", () => {
    mkdirSync(join(store, "config"), { recursive: true });
    writeFileSync(join(store, "config/pricing.json"), FOREIGN);
    const r = seed("config/pricing.json");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/config\/pricing\.json present - live document kept/);
    expect(puts("config/pricing.json")).toEqual([]);
    expect(cps()).toEqual([]);
    expect(stored("config/pricing.json")).toBe(FOREIGN);
  });

  it("absent → created with put-object --if-none-match '*', never s3 cp", () => {
    const r = seed("config/pricing.json");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/seeded config\/pricing\.json/);
    expect(puts("config/pricing.json")).toHaveLength(1);
    expect(puts("config/pricing.json")[0]).toMatch(/--if-none-match \*/);
    expect(puts("config/pricing.json")[0]).toMatch(/--content-type application\/json/);
    expect(cps()).toEqual([]);
    expect(stored("config/pricing.json")).toBe('{"seed":true}\n');
  });

  it("concurrent create: HEAD 404, another writer lands, PUT 412 → theirs is kept, exit 0", () => {
    const r = seed("config/models.json", {
      FAKE_S3_APPEAR_AFTER_HEAD: "config/models.json",
      FAKE_S3_APPEAR_CONTENT: FOREIGN,
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/config\/models\.json appeared after the head check - another writer created it, kept/);
    expect(r.out).not.toMatch(/ERROR/);
    expect(stored("config/models.json")).toBe(FOREIGN);
    expect(puts("config/models.json")).toHaveLength(1);
  });

  it("409 race once → retried, then created", () => {
    const r = seed("config/models.json", { FAKE_S3_PUT_409: "1" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/concurrent conditional write is in flight \(409\) - retry 1\/2/);
    expect(r.out).toMatch(/seeded config\/models\.json/);
    expect(puts("config/models.json")).toHaveLength(2);
    expect(stored("config/models.json")).toBe('{"seed":true}\n');
  });

  it("409 race once, then the other writer wins → 412 on the retry, kept", () => {
    const r = seed("config/models.json", {
      FAKE_S3_PUT_409: "1",
      FAKE_S3_APPEAR_AFTER_HEAD: "config/models.json",
      FAKE_S3_APPEAR_CONTENT: FOREIGN,
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/appeared after the head check/);
    expect(stored("config/models.json")).toBe(FOREIGN);
  });

  it("409 on every attempt → bounded (3 attempts), then the deploy fails, nothing written", () => {
    const r = seed("config/models.json", { FAKE_S3_PUT_409: "99" });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/ERROR: put-object config\/models\.json still 409 ConditionalRequestConflict after 3 attempts/);
    expect(puts("config/models.json")).toHaveLength(3);
    expect(stored("config/models.json")).toBeNull();
  });

  it("S3_SEED_MAX_ATTEMPTS bounds the 409 retry", () => {
    const r = seed("config/models.json", { FAKE_S3_PUT_409: "99", S3_SEED_MAX_ATTEMPTS: "1" });
    expect(r.code, r.out).not.toBe(0);
    expect(puts("config/models.json")).toHaveLength(1);
  });

  it.each([HEAD_403, HEAD_EXPIRED])("HEAD non-404 (%s) → fails before any write (TEAM-5073 kept)", (msg) => {
    const r = seed("config/pricing.json", { FAKE_S3_HEAD_ERR: msg });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/ERROR: head-object config\/pricing\.json failed/);
    expect(puts("config/pricing.json")).toEqual([]);
    expect(cps()).toEqual([]);
    expect(stored("config/pricing.json")).toBeNull();
  });

  it("PUT non-412/409 error (403) → fails the deploy, nothing written", () => {
    const r = seed("config/pricing.json", { FAKE_S3_PUT_ERR: PUT_403 });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/ERROR: put-object config\/pricing\.json failed: .*AccessDenied/);
    expect(puts("config/pricing.json")).toHaveLength(1);
    expect(stored("config/pricing.json")).toBeNull();
  });

  /**
   * TEAM-5113 — the 412/409/404 classifiers grepped for their code ANYWHERE in
   * stderr, so an AccessDenied whose role ARN happened to contain
   * "PreconditionFailed" read as "another writer created it, kept": exit 0, the
   * deploy carried on, nothing was seeded. A code now counts only in the CLI's
   * own `An error occurred (<Code>) when calling the <Op> operation` prefix,
   * and a 412 is believed only once a head-object shows the object.
   */
  describe("classifies only the CLI's own error code (TEAM-5113)", () => {
    const heads = (key: string) => calls().filter((l) => l.startsWith("s3api head-object") && l.includes(`--key ${key} `));
    const denied = (tail: string) =>
      `An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:sts::111122223333:assumed-role/${tail} is not authorized to perform: s3:PutObject`;

    it("genuine 412 → a head-object confirms the other writer's object before 'kept', exit 0", () => {
      const r = seed("config/models.json", {
        FAKE_S3_APPEAR_AFTER_HEAD: "config/models.json",
        FAKE_S3_APPEAR_CONTENT: FOREIGN,
      });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/appeared after the head check - another writer created it, kept/);
      expect(heads("config/models.json")).toHaveLength(2);
      expect(stored("config/models.json")).toBe(FOREIGN);
    });

    it("genuine 412 but the confirming head-object still 404s → the deploy fails", () => {
      const r = seed("config/models.json", { FAKE_S3_PUT_412_PHANTOM: "1" });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/ERROR: put-object config\/models\.json answered 412 but head-object does not show the object/);
      expect(r.out).not.toMatch(/kept/);
      expect(stored("config/models.json")).toBeNull();
    });

    it.each([
      ["PreconditionFailed in the role ARN", denied("deploy-PreconditionFailed-probe/ci")],
      ["(412) in the message", denied("deploy-role/ci") + " (412)"],
    ])("AccessDenied with %s → fails the deploy, never 'kept'", (_label, msg) => {
      const r = seed("config/pricing.json", { FAKE_S3_PUT_ERR: msg });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/ERROR: put-object config\/pricing\.json failed: .*AccessDenied/);
      expect(r.out).not.toMatch(/kept/);
      expect(stored("config/pricing.json")).toBeNull();
    });

    it.each([
      ["ConditionalRequestConflict in the role ARN", denied("deploy-ConditionalRequestConflict-probe/ci")],
      ["(409) in the message", denied("deploy-role/ci") + " (409)"],
    ])("AccessDenied with %s → fails at once, not retried as a 409", (_label, msg) => {
      const r = seed("config/pricing.json", { FAKE_S3_PUT_ERR: msg });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/ERROR: put-object config\/pricing\.json failed: .*AccessDenied/);
      expect(r.out).not.toMatch(/retry|still 409/);
      expect(puts("config/pricing.json")).toHaveLength(1);
    });

    it("HEAD 403 whose message contains 'Not Found' → fails before any write, not read as absence", () => {
      const r = seed("config/pricing.json", {
        FAKE_S3_HEAD_ERR: "An error occurred (403) when calling the HeadObject operation: Forbidden - Not Found in allow-list",
      });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/ERROR: head-object config\/pricing\.json failed/);
      expect(puts("config/pricing.json")).toEqual([]);
      expect(stored("config/pricing.json")).toBeNull();
    });
  });

  it("a CLI too old for --if-none-match fails closed instead of copying", () => {
    const r = seed("config/pricing.json", { FAKE_S3_OLD_CLI: "1" });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/ERROR: put-object config\/pricing\.json failed: Unknown options: --if-none-match/);
    expect(cps()).toEqual([]);
    expect(stored("config/pricing.json")).toBeNull();
  });

  it("absence is decided PER KEY: pricing present + models absent → models seeded, pricing untouched", () => {
    mkdirSync(join(store, "config"), { recursive: true });
    writeFileSync(join(store, "config/pricing.json"), FOREIGN);
    const models = join(tmp, "models.json");
    writeFileSync(models, '{"catalog":[]}\n');
    const r1 = seed("config/models.json", {}, models);
    const r2 = seed("config/pricing.json");
    expect(r1.code, r1.out).toBe(0);
    expect(r2.code, r2.out).toBe(0);
    expect(stored("config/models.json")).toBe('{"catalog":[]}\n');
    expect(stored("config/pricing.json")).toBe(FOREIGN);
    expect(puts("config/pricing.json")).toEqual([]);
  });

  it("a missing local seed file is an error, not a silent skip", () => {
    const r = seed("config/pricing.json", {}, join(tmp, "nope.json"));
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/ERROR: seed source for config\/pricing\.json does not exist/);
    expect(calls()).toEqual([]);
  });

  it("records the CLI version once", () => {
    const r = seed("config/pricing.json");
    expect(r.out).toMatch(/seeding with aws-cli\/2\.99\.0/);
  });
});
