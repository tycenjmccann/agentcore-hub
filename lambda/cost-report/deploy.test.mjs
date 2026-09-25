/**
 * deploy.sh --backfill, exercised hermetically.
 *
 * The interesting behaviour of lambda/cost-report/deploy.sh is what it does when
 * invokes FAIL: it must record the reason, keep going, still rebuild the index,
 * and report coverage measured from the rebuilt index rather than from CLI exit
 * codes. None of that is observable against real AWS without burning a fleet, so
 * each case runs the real script inside a throwaway REPO_ROOT with a fake
 * deploy/config.sh and a fake `aws` on PATH.
 *
 * Why a fake REPO_ROOT rather than an env seam in the script: the real
 * deploy/config.sh sources the repo's gitignored .env.local, which can set
 * EXPECTED_ACCOUNT_ID and abort the script for reasons that have nothing to do
 * with the code under test.
 *
 * The pricing seeder (TEAM-5073/TEAM-5081) is covered here too: the fake `aws`
 * keeps an on-disk S3 store that honours put-object --if-none-match, so each
 * case reads back WHAT ended up at config/pricing.json, not just which command
 * ran — the base script's unconditional `s3 cp` is modelled as the overwrite
 * it is, which is how the race cases fail on base and pass on the fix.
 *
 * Why .mjs: `node --test lambda/cost-report` is already a blocking CI gate
 * (.github/workflows/ci.yml, deploy/pipeline/buildspec-ci.yml), so this file
 * gates itself with no CI wiring, and `\.test\.mjs$` is already ignored by
 * deploy/pipeline/surfaces.json so it cannot trigger a Lambda deploy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// Overridable so the same suite can be pointed at a pre-fix deploy.sh to show the
// findings reproduce (see the TEAM-4505 evidence); defaults to the real script.
const DEPLOY_SH = process.env.COST_REPORT_DEPLOY_SH || path.join(HERE, "deploy.sh");

// 123456789012 is the placeholder scripts/check-no-hardcoded-accounts.sh mandates.
const FAKE_CONFIG = `#!/bin/bash
AWS_REGION="us-east-1"
ACCOUNT_ID="123456789012"
ARTIFACT_BUCKET="fake-artifacts"
WORKFLOWS_TABLE="fake-workflows"
EVENTS_TABLE="fake-events"
CLOUD_CODE_TABLE="fake-cloud-code"
LAMBDA_ROLE_ARN="arn:aws:iam::\${ACCOUNT_ID}:role/fake-lambda-role"
export AWS_REGION ACCOUNT_ID ARTIFACT_BUCKET WORKFLOWS_TABLE EVENTS_TABLE CLOUD_CODE_TABLE LAMBDA_ROLE_ARN
`;

// Dispatches on the AWS CLI's service/operation. Every branch that deploy.sh
// treats as infrastructure is a no-op; `lambda invoke` is where the test's
// interesting behaviour lives, keyed off the workflowId in the payload.
const AWS_SHIM = `#!/bin/bash
SB="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$SB/aws-calls.log"
svc="$1"; shift
case "$svc" in
  iam) exit 0 ;;
  s3api)
    op="$1"; shift
    key=""; body=""; cond=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --key) key="$2"; shift 2 ;;
        --body) body="$2"; shift 2 ;;
        --if-none-match) cond="$2"; shift 2 ;;
        --bucket|--region|--content-type) shift 2 ;;
        *) shift ;;
      esac
    done
    store="$SB/store/$key"
    case "$op" in
      head-object)
        # answers from fixtures/head-object.{code,err}: absent = exit 0 (the
        # object exists), which is what every pre-TEAM-5073 case assumed. An
        # object already in the store exists whatever the fixture says, so the
        # seeder's confirming HEAD after a 412 (TEAM-5113) sees the other
        # writer's document.
        [[ -f "$store" ]] && exit 0
        if [[ -f "$SB/fixtures/head-object.code" ]]; then
          cat "$SB/fixtures/head-object.err" >&2
          exit "$(cat "$SB/fixtures/head-object.code")"
        fi
        exit 0 ;;
      put-object)
        # A real enough S3 (TEAM-5081): --if-none-match '*' creates only, and the
        # stored bytes are readable by the test. fixtures/appear-after-head is
        # "another writer" landing the moment anything tries to write the key.
        if [[ -f "$SB/fixtures/put-object.err" ]]; then cat "$SB/fixtures/put-object.err" >&2; exit 254; fi
        if [[ -f "$SB/fixtures/put-object.409" ]]; then
          n=0; [[ -f "$SB/store/.409-count" ]] && n="$(cat "$SB/store/.409-count")"
          if (( n < $(cat "$SB/fixtures/put-object.409") )); then
            mkdir -p "$SB/store"; echo $(( n + 1 )) > "$SB/store/.409-count"
            echo "An error occurred (ConditionalRequestConflict) when calling the PutObject operation: Conditional request cannot succeed due to a conflicting operation against this resource." >&2
            exit 254
          fi
        fi
        if [[ -f "$SB/fixtures/appear-after-head" && ! -f "$store" ]]; then mkdir -p "$(dirname "$store")"; cp "$SB/fixtures/appear-after-head" "$store"; fi
        if [[ -n "$cond" && -f "$store" ]]; then
          echo "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" >&2
          exit 254
        fi
        mkdir -p "$(dirname "$store")"; cp "$body" "$store"
        echo '{"ETag":"fake"}'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  dynamodb) cat "$SB/fixtures/scan.json"; exit 0 ;;
  s3)
    shift                                   # 'cp'
    src=""; dst=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --only-show-errors) shift ;;
        --region) shift 2 ;;
        --*) shift ;;
        *) if [[ -z "$src" ]]; then src="$1"; else dst="$1"; fi; shift ;;
      esac
    done
    if [[ "$src" == s3://* ]]; then
      [[ -f "$SB/fixtures/index.json" ]] || exit 1
      cp "$SB/fixtures/index.json" "$dst"
    elif [[ "$dst" == s3://* ]]; then
      # local → S3 is the PRE-fix seed path: an unconditional overwrite, modelled
      # as one so the race cases show the base script losing.
      key="$(printf '%s' "$dst" | sed 's|^s3://[^/]*/||')"
      store="$SB/store/$key"
      if [[ -f "$SB/fixtures/appear-after-head" && ! -f "$store" ]]; then mkdir -p "$(dirname "$store")"; cp "$SB/fixtures/appear-after-head" "$store"; fi
      mkdir -p "$(dirname "$store")"; cp "$src" "$store"
    fi
    exit 0 ;;
  lambda)
    op="$1"; shift
    case "$op" in
      get-function-configuration) echo "None"; exit 0 ;;
      wait) exit 0 ;;
      update-function-code|update-function-configuration) echo "2026-01-01T00:00:00.000+0000"; exit 0 ;;
      put-function-concurrency) echo '{"ReservedConcurrentExecutions":5}'; exit 0 ;;
      invoke) : ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac

payload=""; outfile=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload) payload="$2"; shift 2 ;;
    --function-name|--region|--cli-read-timeout|--query|--output|--cli-binary-format) shift 2 ;;
    --*) shift ;;
    *) outfile="$1"; shift ;;
  esac
done
[[ -n "$outfile" ]] || outfile=/dev/null

if [[ "$payload" == *rebuildIndex* ]]; then
  touch "$SB/rebuild-ran"
  if [[ -f "$SB/fixtures/rebuild-clierr" ]]; then
    echo "An error occurred (AccessDeniedException) when calling the Invoke operation" >&2
    exit 255
  fi
  if [[ -f "$SB/fixtures/rebuild-fnerr" ]]; then
    printf '{"errorType":"Error","errorMessage":"rebuild boom"}' > "$outfile"
    echo "Unhandled"; exit 0
  fi
  printf '{"cards":4,"rewritten":0}' > "$outfile"
  echo "None"; exit 0
fi

id="$(printf '%s' "$payload" | sed -n 's/.*"workflowId":"\\([^"]*\\)".*/\\1/p')"
printf '%s\\n' "$id" >> "$SB/invoked.log"
case "$id" in
  wf_ok_*)
    printf '{"workflowId":"%s"}' "$id" > "$outfile"; echo "None"; exit 0 ;;
  wf_fnerr_*)
    printf '{"errorType":"Error","errorMessage":"boom"}' > "$outfile"; echo "Unhandled"; exit 0 ;;
  wf_cli_*)
    echo "An error occurred (AccessDeniedException) when calling the Invoke operation" >&2; exit 255 ;;
  wf_throttle_*)
    n="$SB/attempts.$id"
    c=0; [[ -f "$n" ]] && c="$(cat "$n")"
    c=$(( c + 1 )); printf '%s' "$c" > "$n"
    if (( c < 2 )); then
      echo "An error occurred (TooManyRequestsException) when calling the Invoke operation: Rate exceeded" >&2
      exit 255
    fi
    printf '{"workflowId":"%s"}' "$id" > "$outfile"; echo "None"; exit 0 ;;
  *)
    printf '{"workflowId":"%s"}' "$id" > "$outfile"; echo "None"; exit 0 ;;
esac
`;

const ZIP_SHIM = "#!/bin/bash\nexit 0\n";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

function scanItem(workflowId, { phase = "complete", completedAt, deleted } = {}) {
  const item = { workflowId: { S: workflowId }, phase: { S: phase } };
  if (completedAt) item.completedAt = { S: completedAt };
  if (deleted) item.deleted = { BOOL: true };
  return item;
}

/** A throwaway REPO_ROOT holding the real deploy.sh + index.mjs and fake everything else. */
function sandbox({ items = [], indexCards = null, rebuildFnErr = false, rebuildCliErr = false, headObject = null, appearAfterHead = null, putObjectErr = null, put409 = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-report-deploy-"));
  for (const sub of ["deploy/lib", "lambda/cost-report", "src/config", "bin", "fixtures", "store"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "deploy/config.sh"), FAKE_CONFIG);
  // Copied every run, so the test can never drift from the script it tests.
  fs.copyFileSync(DEPLOY_SH, path.join(dir, "lambda/cost-report/deploy.sh"));
  fs.chmodSync(path.join(dir, "lambda/cost-report/deploy.sh"), 0o755);
  // The shared seeder the script sources via $REPO_ROOT (TEAM-5081) — the real one.
  fs.copyFileSync(path.join(REPO, "deploy/lib/s3-seed-if-absent.sh"), path.join(dir, "deploy/lib/s3-seed-if-absent.sh"));
  // The real index.mjs: the REPORT_VERSION / INDEX_CAP greps run against real content.
  fs.copyFileSync(path.join(HERE, "index.mjs"), path.join(dir, "lambda/cost-report/index.mjs"));
  const kpi = fs.readFileSync(path.join(REPO, "src/config/kpi.json"));
  fs.writeFileSync(path.join(dir, "src/config/kpi.json"), kpi);
  fs.writeFileSync(path.join(dir, "lambda/cost-report/kpi.json"), kpi); // symlink resolved
  fs.copyFileSync(path.join(REPO, "src/config/pricing.json"), path.join(dir, "src/config/pricing.json"));

  fs.writeFileSync(path.join(dir, "fixtures/scan.json"), JSON.stringify({ Items: items }));
  if (indexCards) fs.writeFileSync(path.join(dir, "fixtures/index.json"), JSON.stringify({ version: 1, cards: indexCards }));
  if (rebuildFnErr) fs.writeFileSync(path.join(dir, "fixtures/rebuild-fnerr"), "");
  if (rebuildCliErr) fs.writeFileSync(path.join(dir, "fixtures/rebuild-clierr"), "");
  if (headObject) {
    fs.writeFileSync(path.join(dir, "fixtures/head-object.code"), String(headObject.code));
    fs.writeFileSync(path.join(dir, "fixtures/head-object.err"), headObject.stderr);
  }
  if (appearAfterHead !== null) fs.writeFileSync(path.join(dir, "fixtures/appear-after-head"), appearAfterHead);
  if (putObjectErr) fs.writeFileSync(path.join(dir, "fixtures/put-object.err"), putObjectErr);
  if (put409 !== null) fs.writeFileSync(path.join(dir, "fixtures/put-object.409"), String(put409));

  fs.writeFileSync(path.join(dir, "bin/aws"), AWS_SHIM, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin/zip"), ZIP_SHIM, { mode: 0o755 });
  return dir;
}

function run(dir, args, env = {}) {
  const opts = {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, S3_SEED_RETRY_SLEEP: "0 0", ...env },
  };
  try {
    return { code: 0, out: execFileSync("bash", [path.join(dir, "lambda/cost-report/deploy.sh"), ...args], opts) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

const read = (dir, rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : "");

// ─── A-4: a failing invoke must not abandon the queue or skip the rebuild ──────

test("backfill records failures, keeps going, still rebuilds the index, exits 0", () => {
  const items = [
    scanItem("wf_ok_1", { completedAt: iso(1 * DAY) }),
    scanItem("wf_ok_2", { completedAt: iso(2 * DAY) }),
    scanItem("wf_ok_3", { completedAt: iso(3 * DAY) }),
    scanItem("wf_fnerr_1", { completedAt: iso(4 * DAY) }),
    scanItem("wf_cli_1", { completedAt: iso(5 * DAY) }),
    // Filtered out by the candidate scan.
    scanItem("wf_ok_deleted", { completedAt: iso(1 * DAY), deleted: true }),
    scanItem("wf_ok_running", { phase: "dev", completedAt: iso(1 * DAY) }),
    scanItem("wf_ok_old", { completedAt: iso(400 * DAY) }),
  ];
  const dir = sandbox({ items, indexCards: [1, 2, 3, 4].map((n) => ({ workflowId: `wf_ok_${n}`, completedAt: iso(n * DAY) })) });
  const { code, out } = run(dir, ["--backfill"]);

  assert.equal(code, 0, out);
  // A-4: the rebuild is reached even though wf_cli_1 exited 255.
  assert.ok(fs.existsSync(path.join(dir, "rebuild-ran")), out);
  assert.match(out, /==> Rebuild index \+ bands \+ infra/);

  // A-3a: FunctionError and CLI failures are both failures, and the count is real.
  assert.match(out, /^backfill: invoked 3\/5 ok, 2 failed$/m, out);
  assert.match(out, /^ {2}FAILED wf_fnerr_1\s+FunctionError:Unhandled\s+.*errorMessage/m, out);
  assert.match(out, /^ {2}FAILED wf_cli_1\s+cli-exit-255\s+.*AccessDeniedException/m, out);
  assert.doesNotMatch(out, /\(100%\)/, out);

  // A-3b: coverage comes from the index (4 in-window cards), not the 3 ok invokes.
  assert.match(out, /^coverage: 4\/5 v\d+ cards in the index within the last 90d \(80%\)$/m, out);
  assert.match(out, /^WARNING: coverage below 95% — 2 invoke\(s\) failed/m, out);
  assert.match(out, /^note: the fleet index keeps only the newest 2000 cards \(INDEX_CAP/m, out);

  // The window/deleted/phase filters held: nothing outside the candidate set ran.
  const invoked = read(dir, "invoked.log").trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(invoked, ["wf_cli_1", "wf_fnerr_1", "wf_ok_1", "wf_ok_2", "wf_ok_3"]);
});

test("full coverage prints the coverage line and no warning", () => {
  const items = [scanItem("wf_ok_1", { completedAt: iso(DAY) }), scanItem("wf_ok_2", { completedAt: iso(2 * DAY) })];
  const dir = sandbox({ items, indexCards: [1, 2].map((n) => ({ workflowId: `wf_ok_${n}`, completedAt: iso(n * DAY) })) });
  const { code, out } = run(dir, ["--backfill"]);

  assert.equal(code, 0, out);
  assert.match(out, /^backfill: invoked 2\/2 ok, 0 failed$/m, out);
  assert.match(out, /^coverage: 2\/2 v\d+ cards in the index within the last 90d \(100%\)$/m, out);
  assert.doesNotMatch(out, /WARNING: coverage below 95%/, out);
  assert.doesNotMatch(out, /FAILED /, out);
  assert.match(out, /✓ .* deployed/, out);
});

test("coverage counts only in-window cards, so stale index rows cannot inflate it", () => {
  const items = [scanItem("wf_ok_1", { completedAt: iso(DAY) }), scanItem("wf_ok_2", { completedAt: iso(2 * DAY) })];
  const dir = sandbox({
    items,
    indexCards: [
      { workflowId: "wf_ok_1", completedAt: iso(DAY) },
      { workflowId: "wf_ancient_1", completedAt: iso(500 * DAY) },
      { workflowId: "wf_ancient_2", completedAt: iso(600 * DAY) },
    ],
  });
  const { code, out } = run(dir, ["--backfill"]);
  assert.equal(code, 0, out);
  assert.match(out, /^coverage: 1\/2 v\d+ cards in the index within the last 90d \(50%\)$/m, out);
  assert.match(out, /^WARNING: coverage below 95%/m, out);
});

test("an unreadable index degrades to a warning, not a failure", () => {
  const items = [scanItem("wf_ok_1", { completedAt: iso(DAY) })];
  const dir = sandbox({ items }); // no fixtures/index.json → shim's s3 cp exits 1
  const { code, out } = run(dir, ["--backfill"]);
  assert.equal(code, 0, out);
  assert.match(out, /^WARNING: could not read s3:\/\/fake-artifacts\/performance\/index\.json — coverage unknown/m, out);
  assert.match(out, /✓ .* deployed/, out);
});

// ─── D-2: an unchecked rebuild invoke must not let a stale index masquerade as fresh ──

test("a rebuild FunctionError marks coverage unknown instead of reading the stale index", () => {
  const items = [scanItem("wf_ok_1", { completedAt: iso(DAY) }), scanItem("wf_ok_2", { completedAt: iso(2 * DAY) })];
  // A stale read WOULD print (100%) here — the index already matches both candidates.
  const dir = sandbox({
    items,
    indexCards: [1, 2].map((n) => ({ workflowId: `wf_ok_${n}`, completedAt: iso(n * DAY) })),
    rebuildFnErr: true,
  });
  const { code, out } = run(dir, ["--backfill"]);

  assert.equal(code, 0, out);
  assert.match(out, /^backfill: invoked 2\/2 ok, 0 failed$/m, out);
  assert.match(out, /^WARNING: rebuild failed: .*Unhandled.*rebuild boom/m, out);
  assert.match(out, /^coverage: unknown \(index not rebuilt\)$/m, out);
  assert.doesNotMatch(out, /^coverage: \d+\/\d+/m, out);
  assert.doesNotMatch(out, /\(100%\)/, out);
  assert.doesNotMatch(out, /WARNING: coverage below 95%/, out);
  assert.match(out, /✓ .* deployed/, out);

  // The stale index was never even downloaded.
  assert.doesNotMatch(read(dir, "aws-calls.log"), /s3 cp s3:\/\/fake-artifacts\/performance\/index\.json/, out);
});

test("a rebuild CLI error is also a warning, not a script failure", () => {
  const items = [scanItem("wf_ok_1", { completedAt: iso(DAY) })];
  const dir = sandbox({ items, indexCards: [{ workflowId: "wf_ok_1", completedAt: iso(DAY) }], rebuildCliErr: true });
  const { code, out } = run(dir, ["--backfill"]);

  assert.equal(code, 0, out);
  assert.match(out, /^WARNING: rebuild failed: cli-exit-255 .*AccessDeniedException/m, out);
  assert.match(out, /^coverage: unknown \(index not rebuilt\)$/m, out);
  assert.match(out, /✓ .* deployed/, out);
});

test("--rebuild-index alone with a failing rebuild warns and exits 0", () => {
  const dir = sandbox({ items: [], rebuildFnErr: true });
  const { code, out } = run(dir, ["--rebuild-index"]);

  assert.equal(code, 0, out);
  assert.match(out, /^WARNING: rebuild failed:/m, out);
  assert.doesNotMatch(out, /^coverage:/m, out);
});

test("a throttled invoke is retried with backoff and lands in ok", () => {
  const items = [scanItem("wf_throttle_1", { completedAt: iso(DAY) })];
  const dir = sandbox({ items, indexCards: [{ workflowId: "wf_throttle_1", completedAt: iso(DAY) }] });
  const { code, out } = run(dir, ["--backfill"], { COST_REPORT_BACKFILL_ATTEMPTS: "2" });

  assert.equal(code, 0, out);
  assert.match(out, /^backfill: invoked 1\/1 ok, 0 failed$/m, out);
  assert.equal(read(dir, "attempts.wf_throttle_1"), "2", "the throttle should have been retried exactly once");
});

test("a non-throttle CLI error is recorded without burning retries", () => {
  const items = [scanItem("wf_cli_1", { completedAt: iso(DAY) })];
  const dir = sandbox({ items, indexCards: [] });
  const { code, out } = run(dir, ["--backfill"]);
  assert.equal(code, 0, out);
  assert.match(out, /^backfill: invoked 0\/1 ok, 1 failed$/m, out);
  assert.equal(read(dir, "invoked.log").trim().split("\n").filter(Boolean).length, 1);
});

// ─── A-5: flag parsing ────────────────────────────────────────────────────────

test("an unknown argument is a usage error before anything is deployed", () => {
  const dir = sandbox();
  const { code, out } = run(dir, ["--bogus"]);
  assert.equal(code, 2, out);
  assert.match(out, /unknown argument: --bogus/);
  assert.match(out, /usage: lambda\/cost-report\/deploy\.sh/);
  // Parsing happens before deploy/config.sh is sourced: no AWS call at all.
  assert.equal(read(dir, "aws-calls.log"), "");
});

test("--since-days without --backfill is a usage error", () => {
  const dir = sandbox();
  const { code, out } = run(dir, ["--since-days", "5"]);
  assert.equal(code, 2, out);
  assert.match(out, /--since-days only applies to --backfill/);
  assert.equal(read(dir, "aws-calls.log"), "");
});

test("--since-days validates its argument", () => {
  for (const bad of ["abc", "-1", "3.5", ""]) {
    const dir = sandbox();
    const { code, out } = run(dir, ["--backfill", "--since-days", bad]);
    assert.equal(code, 2, `--since-days ${JSON.stringify(bad)} should be rejected: ${out}`);
    assert.match(out, /--since-days needs a non-negative integer/);
    assert.equal(read(dir, "aws-calls.log"), "");
  }
  const dir = sandbox();
  const { code } = run(dir, ["--backfill", "--since-days"]);
  assert.equal(code, 2, "a missing N should be rejected");
});

test("--since-days is honoured in either order (A-5: it used to be ignored when first)", () => {
  const items = [scanItem("wf_ok_new", { completedAt: iso(5 * DAY) }), scanItem("wf_ok_mid", { completedAt: iso(60 * DAY) })];
  const cards = [{ workflowId: "wf_ok_new", completedAt: iso(5 * DAY) }];
  for (const args of [["--backfill", "--since-days", "30"], ["--since-days", "30", "--backfill"]]) {
    const dir = sandbox({ items, indexCards: cards });
    const { code, out } = run(dir, args);
    assert.equal(code, 0, out);
    assert.match(out, /completed in the last 30d/, out);
    assert.match(out, /^backfill: invoked 1\/1 ok, 0 failed$/m, out);
    // wf_ok_mid is 60d old — outside a 30d window.
    assert.deepEqual(read(dir, "invoked.log").trim().split("\n").filter(Boolean), ["wf_ok_new"]);
  }
});

test("--since-days 0 means all time", () => {
  const items = [scanItem("wf_ok_new", { completedAt: iso(DAY) }), scanItem("wf_ok_ancient", { completedAt: iso(900 * DAY) })];
  const dir = sandbox({
    items,
    indexCards: [
      { workflowId: "wf_ok_new", completedAt: iso(DAY) },
      { workflowId: "wf_ok_ancient", completedAt: iso(900 * DAY) },
    ],
  });
  const { code, out } = run(dir, ["--since-days", "0", "--backfill"]);
  assert.equal(code, 0, out);
  assert.match(out, /completed in all time/, out);
  assert.match(out, /^backfill: invoked 2\/2 ok, 0 failed$/m, out);
  assert.match(out, /^coverage: 2\/2 v\d+ cards in the index within all time \(100%\)$/m, out);
});

test("--rebuild-index alone rebuilds and prints no backfill or coverage line", () => {
  const dir = sandbox({ items: [] });
  const { code, out } = run(dir, ["--rebuild-index"]);
  assert.equal(code, 0, out);
  assert.ok(fs.existsSync(path.join(dir, "rebuild-ran")), out);
  assert.doesNotMatch(out, /^backfill:/m, out);
  assert.doesNotMatch(out, /^coverage:/m, out);
});

test("no flags deploys code + env + IAM and does not rebuild the index", () => {
  const dir = sandbox({ items: [] });
  const { code, out } = run(dir, []);
  assert.equal(code, 0, out);
  assert.ok(!fs.existsSync(path.join(dir, "rebuild-ran")), out);
  assert.match(out, /✓ .* deployed/, out);
  // PERFORMANCE_INDEX_KEY comes from the same INDEX_KEY the coverage read uses.
  assert.match(read(dir, "aws-calls.log"), /PERFORMANCE_INDEX_KEY[^\n]*performance\/index\.json/);
});

test("--help prints usage and exits 0", () => {
  const dir = sandbox();
  const { code, out } = run(dir, ["--help"]);
  assert.equal(code, 0, out);
  assert.match(out, /usage: lambda\/cost-report\/deploy\.sh/);
  assert.equal(read(dir, "aws-calls.log"), "");
});

// ─── TEAM-5073 / TEAM-5081: pricing.json is seeded ONLY when absent, by a conditional create ──
// config/pricing.json is the live projection. `head-object ... >/dev/null 2>&1`
// read every failure — a 403, a throttle, expired credentials — as "absent" and
// cp'd the repo seed over the live rates (TEAM-5073: only a 404 / Not Found is
// absence; anything else stops the deploy before it writes). Then the 404 branch
// still did an unconditional `s3 cp`: a writer creating the key between the HEAD
// and the copy was clobbered (TEAM-5081: the write is `put-object
// --if-none-match '*'`; 412 = another writer's document, kept).

const HEAD_404 = { code: 254, stderr: "An error occurred (404) when calling the HeadObject operation: Not Found\n" };
const FOREIGN = '{"foreign":"created by another writer between HEAD and PUT"}';
const SEED = fs.readFileSync(path.join(REPO, "src/config/pricing.json"), "utf8");
const awsCalls = (dir) => read(dir, "aws-calls.log").split("\n").filter(Boolean);
const pricingCp = (dir) => awsCalls(dir).filter((l) => /^s3 cp .*config\/pricing\.json/.test(l));
const pricingPut = (dir) => awsCalls(dir).filter((l) => /^s3api put-object .*--key config\/pricing\.json /.test(l));
const storedPricing = (dir) => (fs.existsSync(path.join(dir, "store/config/pricing.json")) ? read(dir, "store/config/pricing.json") : null);

test("pricing seeder: present → the live projection is kept, no cp, no put", () => {
  const dir = sandbox();
  const r = run(dir, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /config\/pricing\.json present/);
  assert.deepEqual(pricingCp(dir), []);
  assert.deepEqual(pricingPut(dir), []);
});

test("pricing seeder: a real 404 seeds the repo copy with put-object --if-none-match '*', never s3 cp", () => {
  const dir = sandbox({ headObject: HEAD_404 });
  const r = run(dir, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /seeded config\/pricing\.json/);
  assert.equal(pricingPut(dir).length, 1, r.out);
  assert.match(pricingPut(dir)[0], /--if-none-match \*/);
  assert.deepEqual(pricingCp(dir), []);
  assert.equal(storedPricing(dir), SEED);
});

test("pricing seeder: concurrent create (HEAD 404, object appears, PUT 412) keeps the other writer's document and the deploy succeeds", () => {
  const dir = sandbox({ headObject: HEAD_404, appearAfterHead: FOREIGN });
  const r = run(dir, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /config\/pricing\.json appeared after the head check - another writer created it, kept/, r.out);
  assert.doesNotMatch(r.out, /ERROR/, r.out);
  assert.equal(storedPricing(dir), FOREIGN, "the stored object must be the other writer's, NOT the seed");
  assert.notEqual(storedPricing(dir), SEED);
  assert.deepEqual(pricingCp(dir), []);
  assert.match(r.out, /✓ .* deployed/, r.out);
});

test("pricing seeder: a 409 race is retried once and then seeds", () => {
  const dir = sandbox({ headObject: HEAD_404, put409: 1 });
  const r = run(dir, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(409\) - retry 1\/2/, r.out);
  assert.equal(pricingPut(dir).length, 2, r.out);
  assert.equal(storedPricing(dir), SEED);
});

test("pricing seeder: a 409 on every attempt fails the deploy after 3 attempts and writes nothing", () => {
  const dir = sandbox({ headObject: HEAD_404, put409: 99 });
  const r = run(dir, []);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /still 409 ConditionalRequestConflict after 3 attempts/, r.out);
  assert.equal(pricingPut(dir).length, 3, r.out);
  assert.equal(storedPricing(dir), null);
});

test("pricing seeder: a put-object error other than 412/409 fails the deploy and never falls back to a copy", () => {
  const dir = sandbox({
    headObject: HEAD_404,
    putObjectErr: "An error occurred (AccessDenied) when calling the PutObject operation: Access Denied\n",
  });
  const r = run(dir, []);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /ERROR: put-object config\/pricing\.json failed: .*AccessDenied/, r.out);
  assert.deepEqual(pricingCp(dir), []);
  assert.equal(storedPricing(dir), null);
  assert.doesNotMatch(r.out, /✓ .* deployed/, r.out);
});

test("pricing seeder: a 403 (or any non-404 error) fails the deploy and never overwrites the live file", () => {
  for (const stderr of [
    "An error occurred (403) when calling the HeadObject operation: Forbidden\n",
    "An error occurred (ExpiredToken) when calling the HeadObject operation: The provided token has expired.\n",
  ]) {
    const dir = sandbox({ headObject: { code: 254, stderr } });
    const r = run(dir, []);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /head-object config\/pricing\.json failed/);
    assert.deepEqual(pricingCp(dir), []);
    assert.deepEqual(pricingPut(dir), []);
    assert.equal(storedPricing(dir), null);
  }
});
