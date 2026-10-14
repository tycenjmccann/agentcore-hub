/**
 * twin-preflight.mjs — the Deploy stage's IAM/env preflight for the two ticket twins
 * (agentcore-hub-jira, agentcore-hub-tickets). TEAM-5910, TEAM-5799 follow-up.
 *
 * Since TEAM-5832/TEAM-5805 both twins GetObject completions/<ticket>.json on every
 * non-ship Done and admit a missing record ONLY on 404; anything else refuses with
 * completion_record_required. S3 answers a missing key with 404 only when the caller
 * also holds s3:ListBucket on the bucket — the ArtifactBucketList statement
 * (tickets-lambda-config.mjs) that ONLY deploy/setup-tickets-lambda.mjs applies, a
 * handoff. The pipeline ships twin code with update-function-code alone, so without
 * this check a green deploy could ship code that refuses every non-ship Done fleet-wide.
 *
 * buildspec-deploy.yml runs this in pre_build, over /tmp/deploy-plan.tsv, before
 * anything touches prod. For each twin the plan would update it reads the function's
 * Role + ARTIFACT_BUCKET and the role's INLINE policies, and exits 1 unless every twin
 * is provably ready. A failed pre_build means CodeBuild never runs the build phase: no
 * code ships, nothing needs rolling back, and the baseline does not advance, so the next
 * run re-plans the twin.
 *
 * Fail closed on anything unproven:
 *   - an IAM or Lambda read that fails (AccessDenied, throttling, ...) — "could not tell";
 *   - a grant that exists only in a MANAGED policy. setup-tickets-lambda.mjs writes the
 *     grant inline, and this check reads inline policies only (the Deploy role holds
 *     iam:ListRolePolicies / iam:GetRolePolicy on the two twin roles and nothing more);
 *   - a conditioned Allow (TEAM-5883: an s3:prefix condition never binds to GetObject's
 *     implicit list check, so S3 still answers 403), or any Deny that may apply;
 *   - GetObject is proven over the WHOLE completions/ namespace, never one probe key
 *     (TEAM-5924): an Allow counts only when its Resource covers every key under
 *     completions/, and any GetObject Deny whose Resource could match one of them refuses.
 *   - TEAM-5941: the same for s3:PutObject over completions/ — the twins' Done-intent
 *     fence writes the record (IfMatch) right before the commit and REFUSES the Done when
 *     the write is denied, so fence-carrying twin code onto a role without the grant
 *     would refuse every Done on a ticket with a record.
 * The twins' own fail-closed semantics are untouched; this only decides whether their
 * code may ship.
 *
 * Zero npm imports: the Deploy stage has node and the aws CLI but no SDK. The decision
 * (decideTwin) is pure; inspectTwin is the thin CLI wrapper, its runner injected so
 * deploy/lib/__tests__/twin-preflight.test.ts needs no AWS.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TWIN_FUNCTIONS = ["agentcore-hub-jira", "agentcore-hub-tickets"];

const PROVIDER_OF = { "agentcore-hub-jira": "jira", "agentcore-hub-tickets": "dynamodb" };
const SETUP_FIX = (fn) =>
  `source deploy/config.sh && TICKET_PROVIDER=${PROVIDER_OF[fn] || "<provider>"} node deploy/setup-tickets-lambda.mjs`;
const ROLE_READ_FIX =
  "./deploy/pipeline/deploy.sh (grants the Deploy role iam:ListRolePolicies + iam:GetRolePolicy on the twin roles, TwinPreflightIamRead)";

/** The twin LAMBDA rows of a plan-surfaces.py plan: `LAMBDA fn dir npm optional files note`. */
export function parsePlanTwins(planText) {
  const twins = [];
  for (const line of String(planText || "").split("\n")) {
    const [kind, fn, , , optional] = line.split("\t");
    if (kind === "LAMBDA" && TWIN_FUNCTIONS.includes(fn)) twins.push({ fn, optional: optional === "1" });
  }
  return twins;
}

// ── the matcher: the JS port of scripts/verify-infra.sh role_policy_match `any` ──
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const globRe = (pattern, flags = "") =>
  new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags);
const statementsOf = (docs) => docs.flatMap((d) => list(d?.document?.Statement));
const actionMatches = (st, action) => list(st.Action).some((a) => globRe(a, "i").test(action));
const resourceMatches = (st, arn) => list(st.Resource).some((r) => globRe(r).test(arn));

/**
 * TEAM-5924: does the IAM glob `pattern` match EVERY string that starts with `prefix`?
 * Only when it is a literal prefix of `prefix` followed by nothing but `*` (`?` before
 * the star is refused: it is not shown to match the prefix's character).
 */
export function coversPrefix(pattern, prefix) {
  const p = String(pattern);
  const k = p.indexOf("*");
  return k >= 0 && k <= prefix.length && p.slice(0, k) === prefix.slice(0, k) && /^\**$/.test(p.slice(k));
}

/**
 * TEAM-5924: could the IAM glob `pattern` match SOME string that starts with `prefix`?
 * Exact, because the other side is always `prefix` + `*`: once the pattern reaches a `*`
 * (or the end of `prefix`) it can produce the rest.
 */
export function mayIntersectPrefix(pattern, prefix) {
  const p = String(pattern);
  for (let i = 0; i < prefix.length; i++) {
    if (i >= p.length) return false;
    if (p[i] === "*") return true;
    if (p[i] !== "?" && p[i] !== prefix[i]) return false;
  }
  return true;
}

/** Some UNCONDITIONED Allow grants `action` on `arn` in one statement. NotAction/NotResource never count. */
export function policyGrants(docs, action, arn) {
  return statementsOf(docs).some(
    (st) =>
      st?.Effect === "Allow" &&
      !("NotAction" in st) &&
      !("NotResource" in st) &&
      actionMatches(st, action) &&
      resourceMatches(st, arn) &&
      Object.keys(st.Condition || {}).length === 0
  );
}

/** Some Deny MAY deny `action` on `arn` — conditioned or not; a NotAction/NotResource Deny is assumed to. */
export function policyDenies(docs, action, arn) {
  return statementsOf(docs).some(
    (st) =>
      st?.Effect === "Deny" &&
      ("NotAction" in st || "NotResource" in st || (actionMatches(st, action) && resourceMatches(st, arn)))
  );
}

/** Some UNCONDITIONED Allow grants `action` on every key under `prefix`, in one statement. */
export function policyGrantsUnder(docs, action, prefix) {
  return statementsOf(docs).some(
    (st) =>
      st?.Effect === "Allow" &&
      !("NotAction" in st) &&
      !("NotResource" in st) &&
      actionMatches(st, action) &&
      list(st.Resource).some((r) => coversPrefix(r, prefix)) &&
      Object.keys(st.Condition || {}).length === 0
  );
}

/**
 * Some Deny MAY deny `action` on a key under `prefix` — conditioned or not. A NotAction /
 * NotResource Deny, or one with no Resource at all, is assumed to (fail closed).
 */
export function policyMayDenyUnder(docs, action, prefix) {
  return statementsOf(docs).some(
    (st) =>
      st?.Effect === "Deny" &&
      ("NotAction" in st ||
        "NotResource" in st ||
        (actionMatches(st, action) && (!("Resource" in st) || list(st.Resource).some((r) => mayIntersectPrefix(r, prefix)))))
  );
}

/**
 * The verdict for one twin. Pure.
 *   config:   {state:"ok", role, bucket} | {state:"absent"} | {state:"error", error}
 *   policies: {state:"ok", docs:[{name, document}]} | {state:"error", error}
 * @returns {{action:"proceed"|"skip-absent"|"block", reasons:string[]}}
 */
export function decideTwin({ fn, optional, expectedBucket, config, policies }) {
  const block = (...reasons) => ({ action: "block", reasons });
  if (!expectedBucket) return block("the pipeline's ARTIFACT_BUCKET is unset, so there is no bucket to check the grant against");
  if (config?.state === "absent") {
    return optional
      ? { action: "skip-absent", reasons: [`${fn} does not exist in this account (optional surface; Target 1b skips it)`] }
      : block(`${fn} does not exist — create it once with ${SETUP_FIX(fn)}`);
  }
  if (config?.state !== "ok") {
    return block(`could not read ${fn}'s configuration (${config?.error || "unknown error"}) — unverifiable, so refused`);
  }
  if (!config.bucket) {
    return block(`${fn} has no ARTIFACT_BUCKET in its env, so its Done guard cannot read completion records — run ${SETUP_FIX(fn)}`);
  }
  if (config.bucket !== expectedBucket) {
    return block(`${fn} reads ARTIFACT_BUCKET=${config.bucket}, not the pipeline's ${expectedBucket} — run ${SETUP_FIX(fn)}`);
  }
  if (policies?.state !== "ok") {
    return block(
      `could not read the inline policies of role ${config.role} (${policies?.error || "unknown error"}) — unverifiable, so refused; ` +
        `if the Deploy role lacks the read, run ${ROLE_READ_FIX}`
    );
  }
  const bucketArn = `arn:aws:s3:::${config.bucket}`;
  const completions = `${bucketArn}/completions/`;
  const reasons = [];
  // ListBucket is one concrete ARN; GetObject is the whole completions/ namespace
  // (TEAM-5924: a single probe key let a Deny on completions/TEAM-* or an Allow on
  // completions/twin-* through).
  const need = [
    ["s3:ListBucket", bucketArn, "a missing completions/<ticket>.json must read as 404, not 403",
      () => policyDenies(policies.docs, "s3:ListBucket", bucketArn), () => policyGrants(policies.docs, "s3:ListBucket", bucketArn)],
    ["s3:GetObject", `${completions}*`, "the Done guard reads completion records",
      () => policyMayDenyUnder(policies.docs, "s3:GetObject", completions), () => policyGrantsUnder(policies.docs, "s3:GetObject", completions)],
    // TEAM-5941: the Done-intent fence is a conditional PutObject of the record right
    // before the provider commit, and a denied write REFUSES the Done (fail closed) —
    // twin code that carries it must not ship onto a role that cannot make the write.
    ["s3:PutObject", `${completions}*`, "the Done-intent fence writes the completion record before the commit (TEAM-5941); a denied write refuses every Done on a ticket with a record",
      () => policyMayDenyUnder(policies.docs, "s3:PutObject", completions), () => policyGrantsUnder(policies.docs, "s3:PutObject", completions)],
  ];
  for (const [action, arn, why, denied, granted] of need) {
    if (denied()) {
      reasons.push(`role ${config.role} has a Deny that may cover ${action} on ${arn} (${why})`);
    } else if (!granted()) {
      reasons.push(`role ${config.role} has no unconditioned inline ${action} covering ${arn} (${why})`);
    }
  }
  if (reasons.length) {
    reasons.push(
      `only INLINE policies are read: a grant that lives only in a managed policy does not count (fail closed) — run ${SETUP_FIX(fn)}, which writes it inline`
    );
    return { action: "block", reasons };
  }
  return { action: "proceed", reasons: [`role ${config.role} grants unconditioned s3:ListBucket on ${bucketArn}, and s3:GetObject and s3:PutObject over ${completions}*, with no Deny that may apply; ARTIFACT_BUCKET is set`] };
}

// ── the thin wrapper over the aws CLI ───────────────────────────────────────────
/** Default runner: `aws <args>`, never throwing; `{code, stdout, stderr}`. */
export function awsCli(args) {
  return new Promise((done) => {
    execFile("aws", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const errorCodeOf = (r) => (/An error occurred \(([^)]+)\)/.exec(r.stderr || "") || [])[1] || `aws exit ${r.code}`;
const parseJson = (s) => JSON.parse(String(s || "").trim() || "null");
/** get-role-policy's PolicyDocument: the CLI decodes it to an object; the raw API returns it URL-encoded. */
const policyDocument = (v) => (typeof v === "string" ? JSON.parse(decodeURIComponent(v)) : v);

/** Read one twin's Role + ARTIFACT_BUCKET and its role's inline policies. Never reads other env values. */
export async function inspectTwin(fn, { run = awsCli, region }) {
  const regionArgs = region ? ["--region", region] : [];
  const cfg = await run([
    "lambda", "get-function-configuration", "--function-name", fn, ...regionArgs,
    // Only these two fields come back: the env also holds JIRA_API_TOKEN / GITHUB_PAT.
    "--query", "{role: Role, bucket: Environment.Variables.ARTIFACT_BUCKET}", "--output", "json",
  ]);
  if (cfg.code !== 0) {
    const code = errorCodeOf(cfg);
    return { config: code === "ResourceNotFoundException" ? { state: "absent" } : { state: "error", error: code } };
  }
  let roleArn, bucket;
  try {
    ({ role: roleArn, bucket } = parseJson(cfg.stdout) || {});
  } catch {
    return { config: { state: "error", error: "unparseable get-function-configuration output" } };
  }
  if (!roleArn) return { config: { state: "error", error: "no Role in the function configuration" } };
  const role = String(roleArn).split("/").pop();
  const config = { state: "ok", role, bucket: bucket || "" };

  const names = await run(["iam", "list-role-policies", "--role-name", role, "--query", "PolicyNames", "--output", "json"]);
  if (names.code !== 0) return { config, policies: { state: "error", error: `ListRolePolicies: ${errorCodeOf(names)}` } };
  const docs = [];
  try {
    for (const name of list(parseJson(names.stdout))) {
      const got = await run(["iam", "get-role-policy", "--role-name", role, "--policy-name", name, "--query", "PolicyDocument", "--output", "json"]);
      if (got.code !== 0) return { config, policies: { state: "error", error: `GetRolePolicy ${name}: ${errorCodeOf(got)}` } };
      docs.push({ name, document: policyDocument(parseJson(got.stdout)) });
    }
  } catch (err) {
    return { config, policies: { state: "error", error: `unparseable policy document (${err?.message || err})` } };
  }
  return { config, policies: { state: "ok", docs } };
}

/** Check every twin in the plan. exitCode 1 when any twin blocks. */
export async function runPreflight({ planText, bucket, region, run = awsCli, log = console.log }) {
  const twins = parsePlanTwins(planText);
  if (!twins.length) {
    log("ticket-twin preflight: no ticket twin in this deploy plan — nothing to check");
    return { exitCode: 0, verdicts: [] };
  }
  const verdicts = [];
  for (const { fn, optional } of twins) {
    const seen = bucket ? await inspectTwin(fn, { run, region }) : {};
    const v = decideTwin({ fn, optional, expectedBucket: bucket, ...seen });
    verdicts.push({ fn, ...v });
    log(`ticket-twin preflight: ${fn}: ${v.action.toUpperCase()}`);
    for (const r of v.reasons) log(`  - ${r}`);
  }
  const blocked = verdicts.filter((v) => v.action === "block");
  if (blocked.length) {
    log(
      `ticket-twin preflight REFUSED: ${blocked.map((v) => v.fn).join(", ")} would ship code whose Done guard refuses every ` +
        "non-ship Done (completion_record_required). Nothing was deployed. Fix the role/env with deploy/setup-tickets-lambda.mjs " +
        "(DEPLOY.md, TEAM-5910), then re-run the pipeline."
    );
  }
  return { exitCode: blocked.length ? 1 : 0, verdicts };
}

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  const planPath = argOf(argv, "--plan") || "/tmp/deploy-plan.tsv";
  const { exitCode } = await runPreflight({
    planText: readFileSync(planPath, "utf8"),
    bucket: argOf(argv, "--bucket") || process.env.ARTIFACT_BUCKET || "",
    region: argOf(argv, "--region") || process.env.AWS_REGION_HUB || process.env.AWS_REGION || "",
  });
  process.exitCode = exitCode;
}

// Run only when executed directly — importing this module (the tests do) calls nothing.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
