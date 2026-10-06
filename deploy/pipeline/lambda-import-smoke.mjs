#!/usr/bin/env node
/**
 * lambda-import-smoke.mjs — load a Lambda zip the way the runtime will, BEFORE
 * the Deploy stage replaces the live code with it (TEAM-5321 FR-15).
 *
 *   node deploy/pipeline/lambda-import-smoke.mjs <zip> <entry> \
 *        [--canary get_transitions] [--sdk-dir DIR] [--timeout-ms 30000]
 *
 * A ticket-Lambda zip that lacked a local module (gate-contract.mjs) deployed
 * green: nothing imported the code before update-function-code, and every tool
 * call then failed with ERR_MODULE_NOT_FOUND. This extracts the zip into a temp
 * dir, `await import()`s the entry FROM THERE, and asserts `handler` is a
 * function. With --canary it also calls the handler with a read-only
 * get_transitions for CANARY-SMOKE and fails unless the tool envelope has one
 * of the expected shapes (lambda-smoke-contract.mjs judgeCanaryEnvelope — the
 * same rule the live canary applies, plus the stub-unreachable envelopes only an
 * offline run can produce).
 *
 * Module resolution:
 *   * relative imports (./x.mjs) resolve only inside the extracted zip, so a
 *     file missing from the zip fails exactly as it would on Lambda;
 *   * a zip with no node_modules/ (the ticket twins rely on the nodejs20.x
 *     runtime's AWS SDK v3) gets <tmp>/node_modules -> --sdk-dir as a SIBLING of
 *     (the Deploy stage fills --sdk-dir from `lambda-smoke-contract.mjs deps`)
 *     the extract dir. ESM ignores NODE_PATH; bare `@aws-sdk/*` specifiers walk up
 *     from <tmp>/pkg and land there. A zip that bundles node_modules/ gets no
 *     link, so a package missing from the bundle fails too.
 *
 * The import + call run in a child process with a scrubbed env: AWS points at a
 * dead local endpoint with dummy credentials (the CodeBuild role's container
 * credentials are never passed through), Jira at a dead local port, so the
 * canary cannot reach anything real. The parent kills the child at the timeout.
 *
 * Exit 0 = OK, 1 = smoke failed (message on stderr), 2 = usage error.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANARIES, extract, judgeCanaryEnvelope } from "./lambda-smoke-contract.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "../..");
const MODULE_ERROR = /Cannot find module|ERR_MODULE_NOT_FOUND|is not defined|is not a function|Unknown tool/;
const RESULT_MARK = "SMOKE-RESULT ";
const STUB_ENV = {
  AWS_REGION: "us-east-1",
  AWS_DEFAULT_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIACANARYSMOKE00000",
  AWS_SECRET_ACCESS_KEY: "canary-smoke-not-a-secret",
  AWS_SESSION_TOKEN: "canary-smoke",
  AWS_ENDPOINT_URL: "http://127.0.0.1:1",
  AWS_MAX_ATTEMPTS: "1",
  AWS_EC2_METADATA_DISABLED: "true",
  JIRA_SITE_URL: "127.0.0.1:9",
  JIRA_BASE_URL: "http://127.0.0.1:9",
  JIRA_EMAIL: "canary@example.invalid",
  JIRA_API_TOKEN: "canary",
  PROJECT_KEY: "CANARY",
  TICKETS_TABLE: "canary-smoke",
  // TEAM-5346: the bundled Lambdas assert these at module load (eval-packager and
  // token-aggregator throw without a bucket, routines-runner without the hub URL).
  // Dead-stub values only - the endpoint above is unreachable and the URL is a
  // closed local port, so the import smoke still cannot touch anything real.
  ARTIFACT_BUCKET: "canary-smoke-bucket",
  ARTIFACTS_BUCKET: "canary-smoke-bucket",
  WORKFLOW_API_URL: "http://127.0.0.1:9",
  WORKFLOWS_TABLE: "canary-smoke",
  EVENTS_TABLE: "canary-smoke",
  ROUTINES_TABLE: "canary-smoke",
};

function usage(msg) {
  console.error(`lambda-import-smoke: ${msg}\nusage: lambda-import-smoke.mjs <zip> <entry> [--canary get_transitions] [--sdk-dir DIR] [--timeout-ms N]`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { positional: [], canary: null, sdkDir: join(REPO, "node_modules"), timeoutMs: 30_000, child: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--child") opts.child = true;
    else if (a === "--canary") opts.canary = argv[++i];
    else if (a === "--sdk-dir") opts.sdkDir = resolve(argv[++i] || "");
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

// ── child: import + optional canary, inside the extracted tree ──────────────
async function child(entryPath, canary) {
  let mod;
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch (err) {
    throw new Error(`import failed: ${err?.code ? `${err.code}: ` : ""}${err?.message || err}`);
  }
  if (typeof mod.handler !== "function") throw new Error(`handler is not a function (got ${typeof mod.handler})`);
  if (!canary) return "handler=function";
  const result = await mod.handler(CANARIES[canary]);
  if (!result || typeof result !== "object") throw new Error(`canary returned no tool envelope (got ${JSON.stringify(result)})`);
  const text = JSON.stringify(result);
  // Named first only for a clearer message; the decision is the positive shape.
  if (MODULE_ERROR.test(text)) throw new Error(`canary envelope carries a module error: ${text.slice(0, 500)}`);
  const verdict = judgeCanaryEnvelope(canary, result, { offline: true });
  if (!verdict.ok) throw new Error(`canary ${verdict.why}`);
  return `handler=function, canary=${verdict.why}: ${text.slice(0, 160)}`;
}

// ── parent: extract, link the SDK, spawn the child under a timeout ──────────
function runChild(args, env, timeoutMs) {
  return new Promise((resolveRun) => {
    const proc = spawn(process.execPath, [SELF, "--child", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolveRun({ code: 1, out, err: `${err}timed out after ${timeoutMs}ms\n` });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, out, err });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [zipArg, entry] = opts.positional;
  if (!zipArg || !entry) usage("need <zip> and <entry>");
  if (opts.canary && !(opts.canary in CANARIES)) usage(`unknown canary ${opts.canary} (known: ${Object.keys(CANARIES).join(", ")})`);

  if (opts.child) {
    try {
      // Marked: the handler logs to stdout too, and only this line is the result.
      console.log(`${RESULT_MARK}${await child(resolve(zipArg, entry), opts.canary)}`);
      process.exit(0);
    } catch (err) {
      console.error(err?.message || String(err));
      process.exit(1);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) usage("--timeout-ms must be a positive number");
  const zip = resolve(zipArg);
  const fail = (msg) => {
    console.error(`IMPORT SMOKE FAILED: ${zipArg}/${entry}: ${msg}`);
    process.exitCode = 1;
  };
  if (!existsSync(zip)) return fail("zip not found");

  const tmp = mkdtempSync(join(tmpdir(), "lambda-import-smoke-"));
  try {
    const pkg = join(tmp, "pkg");
    extract(zip, pkg);
    if (!existsSync(join(pkg, entry))) return fail(`entry ${entry} is not in the zip`);
    if (!existsSync(join(pkg, "node_modules"))) {
      if (!existsSync(opts.sdkDir)) return fail(`zip bundles no node_modules and --sdk-dir ${opts.sdkDir} does not exist`);
      symlinkSync(opts.sdkDir, join(tmp, "node_modules"), "dir");
    }
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: tmp, ...STUB_ENV };
    const args = [pkg, entry, ...(opts.canary ? ["--canary", opts.canary] : [])];
    const { code, out, err } = await runChild(args, env, opts.timeoutMs);
    // 13 = Node's "unsettled top-level await": the import or handler promise
    // never settled and nothing else kept the event loop alive.
    if (code === 13 && !err.trim()) return fail("the import or handler promise never settled");
    if (code !== 0) return fail(err.trim() || `exit ${code}`);
    const result = out.split("\n").find((l) => l.startsWith(RESULT_MARK))?.slice(RESULT_MARK.length);
    if (!result) return fail(`child exited 0 without a result line`);
    console.log(`import-smoke OK ${entry} (${result})`);
  } catch (err) {
    fail(err?.message || String(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
