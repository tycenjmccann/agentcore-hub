/**
 * PRD Submitter Lambda
 *
 * Trigger: S3 PutObject on fleet-imp-agent/prd/ prefix (via EventBridge)
 *
 * Reads the PRD the fleet improver agent wrote to S3, submits to workflow API.
 *
 * TEAM-4760 — this is the gate between "the Workflow Manager wants something
 * fixed" and "a pipeline run is fixing it", so it is where two things are
 * enforced that nothing downstream can enforce later:
 *
 *   1. A system PRD must promise a NUMBER (`si.expected[]`). "Expected impact" as
 *      free prose is what made the old loop unfalsifiable — every PRD claimed an
 *      improvement, none named a measurement, so no fix was ever checked and the
 *      same ask was re-synthesized for weeks. A PRD with no expectation is
 *      rejected here rather than fixed up, because a run nobody can judge is worse
 *      than no run.
 *   2. A pattern already being answered is not answered twice. The si-ledger's
 *      dedupe rule (`dedupeBlocked`, one definition shared with the Python twin)
 *      refuses a key a run is already carrying, or one that shipped inside the
 *      freshness window and has no verdict yet. Two runs fixing one defect is how
 *      you get two conflicting fixes and a merge race.
 *
 * Both rejections return 200 with a logged reason: a non-2xx would make
 * EventBridge retry the same PRD forever, and the PRD is not going to get better.
 *
 * Environment:
 *   ARTIFACT_BUCKET - S3 bucket
 *   WORKFLOW_API_URL - App Runner workflow API base URL
 *   FLEET_REPO_URL - Git repo URL for the agent fleet
 *   SI_LEDGER_TABLE - si-ledger table (default agentcore-hub-si-ledger)
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  SiLedger,
  dedupeBlocked,
  normalizeKey,
  METRIC_NAMES,
  DEFAULT_OBSERVE_RUNS,
  SI_LEDGER_TABLE_DEFAULT,
} from "./si-ledger.mjs";

const BUCKET = process.env.ARTIFACT_BUCKET;
const WORKFLOW_API = process.env.WORKFLOW_API_URL;
const FLEET_REPO = process.env.FLEET_REPO_URL;
const SI_LEDGER_TABLE = process.env.SI_LEDGER_TABLE || SI_LEDGER_TABLE_DEFAULT;

if (!BUCKET) throw new Error("ARTIFACT_BUCKET env var required");
if (!WORKFLOW_API) throw new Error("WORKFLOW_API_URL env var required");
if (!FLEET_REPO) throw new Error("FLEET_REPO_URL env var required");

const REGION = process.env.AWS_REGION || "us-east-1";

/**
 * Clients are built lazily and handed to `run()` as arguments, so the unit suite
 * drives the whole handler with fakes on Node 20 (no `mock.module`) and never
 * touches AWS, never resolves credentials, never calls fetch.
 */
let s3Client;
let ledgerClient;

function s3() {
  return (s3Client ||= new S3Client({ region: REGION }));
}

function siLedger() {
  if (!ledgerClient) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    ledgerClient = new SiLedger({ ddb, table: SI_LEDGER_TABLE });
  }
  return ledgerClient;
}

/**
 * Is this the Workflow Manager's SYSTEM PRD (si-synthesis skill), as opposed to the
 * fleet improver's agent-prompt PRD?
 *
 * Discriminated on `batch.analysisIds` / `si`, both written only by si-synthesis —
 * NOT on repoUrl. The agent-eval loop's PRDs must keep working unchanged, and
 * demanding a workflow metric from a PRD that tunes one agent's prompt would just
 * block that loop (out of scope, and its own metrics are per-agent eval scores).
 */
export function isSystemPrd(prd) {
  return Boolean(prd?.si) || Array.isArray(prd?.batch?.analysisIds);
}

/**
 * The submission's identity, from the S3 object key: `system-20260918T120000`.
 *
 * Every attempt, expectation and verdict on a ledger row is stamped with it, so it
 * has to be stable (re-reading the same object must produce the same prdKey) and
 * unique per submission (the skill's filename carries a timestamp). Deriving it
 * from the key rather than minting a uuid is what makes a row's history traceable
 * back to the exact PRD document in S3.
 */
export function prdKeyFor(s3Key) {
  return String(s3Key || "").split("/").pop().replace(/\.json$/i, "") || "unknown-prd";
}

/**
 * The key this string names, or null if nothing reusable can be made of it.
 *
 * Coerced with `normalizeKey`, not merely checked with `isValidKey`: the skill's
 * keys are agent-authored prose ("Harness.Silent-Death…"), and every ledger read
 * normalises before it looks the row up. Rejecting what the ledger would happily
 * resolve would refuse a PRD over letter case; accepting what it cannot resolve
 * would leave the ask untracked. `normalizeKey` is the one arbiter, so there is
 * exactly one definition of "is this a key".
 */
function keyOrNull(value) {
  try {
    return normalizeKey(value);
  } catch {
    return null;
  }
}

/** Every pattern this PRD claims to answer, normalised and deduped. */
export function collectKeys(prd) {
  const raw = [
    ...(Array.isArray(prd?.si?.patternKeys) ? prd.si.patternKeys : []),
    ...(Array.isArray(prd?.si?.expected) ? prd.si.expected.map((e) => e?.patternKey) : []),
  ];
  const out = [];
  for (const value of raw) {
    const key = keyOrNull(value);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Is the `si` block filable? → { ok, reason }.
 *
 * Pure, and strict on purpose: each rejection names the offending value, because
 * this message is the only feedback the Workflow Manager gets (it reads it in the
 * next synthesis's log tail) and "invalid PRD" would tell it nothing.
 */
export function validateSi(prd) {
  const si = prd?.si;
  if (!si || typeof si !== "object") {
    return { ok: false, reason: "no `si` block: a system PRD must name the patterns it answers and the numbers it expects to move" };
  }
  const expected = Array.isArray(si.expected) ? si.expected : null;
  if (!expected || expected.length === 0) {
    return { ok: false, reason: "`si.expected[]` is empty: a PRD that promises no measurable change cannot be verified after it ships, so it is not submitted" };
  }
  for (const [i, entry] of expected.entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: `si.expected[${i}] is not an object` };
    }
    if (!METRIC_NAMES.includes(entry.metric)) {
      return { ok: false, reason: `si.expected[${i}].metric ${JSON.stringify(entry.metric)} is not measurable — expected one of ${METRIC_NAMES.join("|")}` };
    }
    if (!keyOrNull(entry.patternKey)) {
      return { ok: false, reason: `si.expected[${i}].patternKey ${JSON.stringify(entry.patternKey)} is not a <area>.<slug> pattern key` };
    }
  }
  const keys = collectKeys(prd);
  if (keys.length === 0) {
    return { ok: false, reason: "no valid patternKey in `si`: nothing to track this PRD against" };
  }
  return { ok: true, reason: `${keys.length} pattern(s), ${expected.length} expectation(s)` };
}

/**
 * The gate: which of these keys may be filed right now → { blocked, rows }.
 *
 * A key with NO ledger row is blocked too. The row is minted by save_analysis when
 * an analysis first names the pattern, so a key with no row was invented at
 * synthesis time — and markInRun would skip it silently, leaving the ask untracked
 * and the PRD unverifiable, which is exactly the state this feature removes.
 */
export function gate(keys, rows, now) {
  const blocked = [];
  for (const key of keys) {
    const row = rows[key];
    if (!row) {
      blocked.push({
        patternKey: key,
        reason: `${key} has no ledger row — it was never recorded by an analysis, so it cannot be tracked or verified. Reuse a key from \`si_ledger.py keys\`.`,
      });
      continue;
    }
    const verdict = dedupeBlocked(row, { now });
    if (verdict.blocked) blocked.push({ patternKey: key, reason: verdict.reason });
  }
  return blocked;
}

/**
 * The expectations for one pattern, shaped EXACTLY as `applyExpected` will store
 * them (same baseline triple, same defaults). The run and the ledger row must see
 * the same promise: if the payload carried a baseline field the ledger dropped, an
 * agent could quote a number si_verify will never compare against.
 */
export function expectedFor(key, prd, prdKey, at) {
  return (Array.isArray(prd?.si?.expected) ? prd.si.expected : [])
    .filter((e) => keyOrNull(e?.patternKey) === key)
    .map((e) => ({
      metric: e.metric,
      baseline: e.baseline && typeof e.baseline === "object"
        ? {
          value: e.baseline.value === undefined ? null : e.baseline.value,
          runs: e.baseline.runs === undefined ? null : e.baseline.runs,
          window: e.baseline.window === undefined ? null : e.baseline.window,
        }
        : null,
      target: e.target === undefined ? null : e.target,
      observeRuns: Number.isFinite(Number(e.observeRuns)) ? Number(e.observeRuns) : DEFAULT_OBSERVE_RUNS,
      setAt: at,
      prdKey,
    }));
}

/** Where a pattern's pre-submission snapshot lives. */
export function snapshotKey(prdKey, patternKey) {
  return `si-ledger/${prdKey}/${patternKey}.json`;
}

/**
 * The start payload. `si` rides in the BODY, which is what puts it on the
 * workflows row: /api/workflow/start persists `input: {...body}` verbatim, so the
 * analyzer later reads `input.si` to know this run was carrying an SI attempt and
 * which keys to stamp. It is deliberately NOT smuggled in as a fake `sources[]`
 * entry — the agents read sources as reference material, and a machine contract
 * hidden in a human document is a contract nobody can validate.
 */
export function buildPayload({ prd, repoUrl, prdKey, keys, expected, sources }) {
  return {
    title: `[SI] ${prd.title}`,
    description: prd.description,
    repoConfig: {
      layout: "monorepo",
      repos: [{ url: repoUrl, defaultBranch: "main", platform: "backend" }],
    },
    sources,
    ...(keys.length ? { si: { prdKey, patternKeys: keys, expected } } : {}),
  };
}

/**
 * The whole submission, with its three side-effecting collaborators passed in:
 * `s3` (GetObject/PutObject), `ledger` (an SiLedger) and `fetchImpl` (the
 * workflow API). `handler` is the AWS entry point that supplies the real ones.
 */
export async function run(event, { s3, ledger, fetchImpl }) {
  const key = event.detail?.object?.key || event.key;
  if (!key || !key.endsWith(".json")) return { statusCode: 200, body: "Skipped" };

  console.log(`[prd-submitter] ${key}`);

  // Read PRD from S3
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const prd = JSON.parse(await result.Body.transformToString());

  // Only synthesized PRDs ({title, description}) may start a workflow. Raw eval
  // batches (or anything else) landing on the prd/ prefix would interpolate as
  // "[SI] undefined" and burn a full pipeline run on an empty request.
  if (!prd.title || typeof prd.title !== "string" || !prd.description || typeof prd.description !== "string") {
    console.error(`[prd-submitter] REJECTED ${key}: missing title/description — not a synthesized PRD (keys: ${Object.keys(prd).join(", ")})`);
    return { statusCode: 200, body: "Rejected: not a synthesized PRD" };
  }

  // System-SI PRDs (WM si-synthesis skill) target the hub repo, not the agent
  // fleet — prd.repoUrl overrides. Same [SI] banner either way.
  const repoUrl = typeof prd.repoUrl === "string" && prd.repoUrl.startsWith("https://") ? prd.repoUrl : FLEET_REPO;

  const prdKey = prdKeyFor(key);
  const now = new Date().toISOString();
  const system = isSystemPrd(prd);
  let keys = [];
  let sources = Array.isArray(prd.sources) ? [...prd.sources] : [];

  if (system) {
    const valid = validateSi(prd);
    if (!valid.ok) {
      console.error(`[prd-submitter] REJECTED ${key}: ${valid.reason}`);
      return { statusCode: 200, body: `Rejected: ${valid.reason}` };
    }
    keys = collectKeys(prd);

    // Reads before the run starts, so a DynamoDB failure here THROWS and lets
    // EventBridge retry: no run has been started, and submitting one without
    // checking the gate is the duplicate-work case this exists to prevent.
    const rows = {};
    for (const patternKey of keys) rows[patternKey] = await ledger.get(patternKey);

    const blocked = gate(keys, rows, now);
    if (blocked.length) {
      for (const item of blocked) console.error(`[prd-submitter] REJECTED ${key}: ${item.reason}`);
      return {
        statusCode: 200,
        body: `Rejected: ${blocked.length} pattern(s) already being answered — ${blocked.map((b) => b.patternKey).join(", ")}`,
      };
    }

    // Snapshot each row as it looked BEFORE the fix, and hand the snapshots to the
    // run as real sources. This is what lets the pipeline agents read the defect's
    // full history — every prior attempt and failed verdict — instead of only the
    // PRD's summary of it, and it is immutable evidence a later verdict can cite.
    for (const patternKey of keys) {
      const snapshot = snapshotKey(prdKey, patternKey);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: snapshot,
        Body: JSON.stringify({ prdKey, capturedAt: now, row: rows[patternKey] }, null, 1),
        ContentType: "application/json",
      }));
      sources.push({ type: "s3", value: `s3://${BUCKET}/${snapshot}`, label: `si-ledger ${patternKey}` });
    }
  }

  const expected = keys.flatMap((patternKey) => expectedFor(patternKey, prd, prdKey, now));
  const payload = buildPayload({ prd, repoUrl, prdKey, keys, expected, sources });

  const resp = await fetchImpl(`${WORKFLOW_API}/api/workflow/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[prd-submitter] API ${resp.status}: ${err}`);
    return { statusCode: resp.status, body: err };
  }

  const { workflowId, epicId } = await resp.json();
  console.log(`[prd-submitter] Workflow started: ${workflowId} (epic: ${epicId})`);

  if (keys.length) {
    // The run EXISTS now, so nothing below may throw: a rejected invocation makes
    // EventBridge redeliver the same PRD and start a SECOND run for the same fix.
    // A ledger write that fails is logged and re-converged by the next analysis /
    // si_verify sweep; a duplicate pipeline run is not recoverable.
    try {
      for (const patternKey of keys) {
        const entries = expectedFor(patternKey, prd, prdKey, now);
        if (entries.length) await ledger.putExpected(patternKey, entries, { prdKey, at: now });
      }
      await ledger.markInRun(keys, { prdKey, workflowId, epicId });
      console.log(`[prd-submitter] si-ledger: ${keys.join(", ")} → in-run (${prdKey})`);
    } catch (e) {
      console.error(`[prd-submitter] si-ledger write FAILED for ${keys.join(", ")} (run ${workflowId} is unaffected): ${e?.message || e}`);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ workflowId, epicId, prdKey, patternKeys: keys }) };
}

export async function handler(event) {
  return run(event, { s3: s3(), ledger: siLedger(), fetchImpl: fetch });
}
