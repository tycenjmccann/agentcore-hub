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
 *   SI_APPROVER_HOURS / SI_APPROVER_DAYS - the approver window (approver-window.mjs);
 *                     unset means no system PRD is ever held
 *
 * Entry points (TEAM-5771): an S3 event submits a PRD; `{mode:"tick"}` (a
 * five-minute EventBridge rule) starts held PRDs whose window has opened;
 * `{mode:"status"}` lists every hold, so a held PRD is never read as dropped.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
import { parseWindow, inWindow, nextOpenAt } from "./approver-window.mjs";

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
 *
 * A system PRD runs on the Operator def (one worker + one reviewer). The full
 * software-delivery fan-out turned small system fixes into 30-ticket runs that
 * never converged. Agent PRDs keep the default def.
 */
export function buildPayload({ prd, repoUrl, prdKey, keys, expected, sources, system = false }) {
  return {
    title: `[SI] ${prd.title}`,
    ...(system ? { workflowDefId: "operator" } : {}),
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
export async function run(event, { s3, ledger, fetchImpl, now: nowAt, env = process.env }) {
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
  const now = (nowAt ? new Date(nowAt) : new Date()).toISOString();
  const system = isSystemPrd(prd);
  let keys = [];
  let holdWindow = null;
  let sources = Array.isArray(prd.sources) ? [...prd.sources] : [];

  if (system) {
    const valid = validateSi(prd);
    if (!valid.ok) {
      console.error(`[prd-submitter] REJECTED ${key}: ${valid.reason}`);
      return { statusCode: 200, body: `Rejected: ${valid.reason}` };
    }
    keys = collectKeys(prd);

    // TEAM-5771: only SYNTHESIZE's own drops can be held — every other source
    // (agent PRDs, anything outside fleet-imp-agent/prd/system-*) starts as before.
    holdWindow = SYSTEM_KEY_RE.test(key) ? parseWindow(env) : null;
    if (SYSTEM_KEY_RE.test(key)) {
      // A redelivery of a PRD that was held: resume the ledger half (the gate
      // would now refuse our OWN in-run flip), or, once started, do nothing. The
      // archive is read too, and regardless of the window env — a hold that the
      // tick finished must never be held or started a second time.
      const existing = (await readDeferral(s3, deferralKey(prdKey))) || (await readDeferral(s3, doneKey(prdKey)));
      if (existing) return holdLedger(existing.record, ledger);
    }

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
  const payload = buildPayload({ prd, repoUrl, prdKey, keys, expected, sources, system });

  if (holdWindow && !inWindow(now, holdWindow)) {
    const expectedByKey = Object.fromEntries(keys.map((patternKey) => [patternKey, expectedFor(patternKey, prd, prdKey, now)]));
    return defer({ s3, ledger, key, prdKey, keys, expectedByKey, payload, now, window: holdWindow });
  }

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

  const startBody = await resp.json();
  const named = startedRun(startBody);
  if (!named) {
    // A 2xx that names no run (the sweep-preflight skip): nothing started, so
    // nothing to put in-run. Not an error EventBridge should retry.
    console.error(`[prd-submitter] API ${resp.status} started no run for ${prdKey}: ${JSON.stringify(startBody).slice(0, 300)}`);
    return { statusCode: 200, body: JSON.stringify({ started: false, prdKey, response: startBody }) };
  }
  const { workflowId, epicId } = named;
  console.log(`[prd-submitter] Workflow started: ${workflowId} (epic: ${epicId ?? "none — coalesced onto an existing run"})`);

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

// ── approver-window hold (TEAM-5771) ────────────────────────────────────────
//
// A system PRD that lands outside the approver's window is not started: its
// Operator run would park a Merge Approval nobody can close for hours. The keys
// still flip to in-run at once (so SYNTHESIZE cannot re-file them meanwhile);
// only the start waits, in a record under DEFERRED_PREFIX in the artifact bucket
// the submitter already writes snapshots to. The tick starts it.
//
// Exactly-once rests on three things, none of them new infrastructure:
//   - the record is created with IfNoneMatch, so a redelivered PRD cannot fork it;
//   - a tick claims it with an ETag compare-and-swap, so two ticks cannot both start it;
//   - a claim (`starting`) is never re-POSTed: one whose tick died, or whose start
//     got no definitive answer, is flagged STUCK for a human, because the start
//     route re-points its sourceTicket dedup once the first run is terminal.
// Nothing is lost because a record only leaves `pending`/`starting` after a 2xx
// or a human's decision.

export const DEFERRED_PREFIX = "prd-submitter/deferred/";
export const DONE_PREFIX = "prd-submitter/deferred-done/";
const SYSTEM_KEY_RE = /^fleet-imp-agent\/prd\/system-/;
// A claim older than this belongs to a tick that died mid-start. It is flagged
// for a human, never re-POSTed: whether its start reached the route is unknown.
const STALE_CLAIM_MS = 10 * 60 * 1000;
// Start responses that do not prove the route did nothing: a thrown fetch (0)
// and the gateway errors, where the route may still be creating the run.
const UNKNOWN_OUTCOME_STATUS = new Set([0, 502, 504]);

/**
 * The one line a human needs to resolve a claim whose start may or may not have
 * created a run: there is no read API by sourceTicket, so the human looks.
 */
function stuckMessage(key, record) {
  return `STUCK ${record.prdKey}: claimed ${record.claimedAt}, start outcome unknown` +
    `${record.lastError ? ` (${record.lastError})` : ""} — never re-POSTed automatically. ` +
    `Find the run whose input.sourceTicket is "${record.payload?.sourceTicket}": if it exists, set ${key} ` +
    `state "started" + its workflowId (the tick links and archives it); if none, set state "pending" (the tick starts it).`;
}

export function deferralKey(prdKey) {
  return `${DEFERRED_PREFIX}${prdKey}.json`;
}

function doneKey(prdKey) {
  return `${DONE_PREFIX}${prdKey}.json`;
}

export function sourceTicketFor(prdKey) {
  return `si-prd:${prdKey}`;
}

/**
 * The run a 2xx from /api/workflow/start names, or null when it names none.
 * route.ts answers 2xx in three shapes: a fresh start {workflowId, epicId,
 * materialized, deferred} (route.ts:834, :1018); a coalesce onto a run that
 * already owns the sourceTicket, {workflowId, deduplicated: true} with NO epicId
 * (:612, :755, :952); and a sweep-preflight skip {skipped, reason, prs, mainSha}
 * that started nothing (:649). → { workflowId, epicId | null } | null
 */
export function startedRun(body) {
  const workflowId = typeof body?.workflowId === "string" && body.workflowId ? body.workflowId : null;
  if (!workflowId) return null;
  return { workflowId, epicId: typeof body.epicId === "string" && body.epicId ? body.epicId : null };
}

function isPreconditionFailed(err) {
  const status = err?.$metadata?.httpStatusCode;
  return status === 412 || status === 409 || err?.name === "PreconditionFailed" || err?.name === "ConditionalRequestConflict";
}

function isNotFound(err) {
  return err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

/** → { record, etag } or null when there is no hold. */
async function readDeferral(s3, key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { record: JSON.parse(await out.Body.transformToString()), etag: out.ETag };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Conditional write; → the new ETag. `cond` is { IfNoneMatch: "*" } or { IfMatch: etag }. */
async function writeDeferral(s3, key, record, cond = {}) {
  const out = await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(record, null, 1),
    ContentType: "application/json",
    ...cond,
  }));
  return out?.ETag;
}

function holdNote(record) {
  return `deferred: start scheduled ${record.scheduledStartAt} (approver window)`;
}

/**
 * Hold a system PRD. Write order is the stuck-hold guarantee: the RECORD first
 * (a failure throws before anything is in the ledger, and EventBridge retries),
 * then the ledger. A ledger failure throws too: the retry finds the record and
 * resumes here, and if retries run out the tick still starts the run and
 * backfills the ledger — never an in-run row with no record behind it.
 */
async function defer({ s3, ledger, key, prdKey, keys, expectedByKey, payload, now, window }) {
  const record = {
    prdKey,
    s3Key: key,
    arrivedAt: now,
    scheduledStartAt: nextOpenAt(now, window).toISOString(),
    window,
    keys,
    expectedByKey,
    payload: { ...payload, sourceTicket: sourceTicketFor(prdKey) },
    state: "pending",
    ledgerLinked: false,
  };
  try {
    await writeDeferral(s3, deferralKey(prdKey), record, { IfNoneMatch: "*" });
  } catch (err) {
    if (!isPreconditionFailed(err)) throw err;
    // A concurrent delivery of the same PRD created it first: resume from theirs.
    const existing = await readDeferral(s3, deferralKey(prdKey));
    if (existing) return holdLedger(existing.record, ledger);
    throw err;
  }
  return holdLedger(record, ledger);
}

/**
 * The ledger half of a hold: promise + in-run attempt with no run yet. Idempotent,
 * and a no-op once the run exists: a redelivery after the tick linked the attempt
 * must not stamp a second, run-less one (applyAttempt keys on prdKey+workflowId,
 * so it would append, and a newest attempt with no workflowId hides the run from
 * the analyzer's si-reap).
 */
async function holdLedger(record, ledger) {
  const problem = holdProblem(record);
  if (problem) {
    const body = `Rejected: hold record for ${record?.prdKey ?? "(no prdKey)"} is malformed (${problem}) — fix or delete it, then redeliver`;
    console.error(`[prd-submitter] ${body}`);
    return { statusCode: 200, body };
  }
  const { prdKey, keys = [], arrivedAt, scheduledStartAt } = record;
  if (record.state === "started") {
    console.log(`[prd-submitter] redelivery of held ${prdKey}: already started as ${record.workflowId} — nothing to do`);
    return {
      statusCode: 200,
      body: JSON.stringify({ deferred: true, started: true, prdKey, workflowId: record.workflowId, patternKeys: keys }),
    };
  }
  for (const patternKey of keys) {
    const row = await ledger.get(patternKey);
    const attempts = Array.isArray(row?.attempts) ? row.attempts : [];
    if (attempts.some((a) => a?.prdKey === prdKey && a?.workflowId)) continue; // the tick already linked this key
    const entries = record.expectedByKey?.[patternKey] || [];
    if (entries.length) await ledger.putExpected(patternKey, entries, { prdKey, at: arrivedAt });
    // workflowId stays empty until the tick starts the run: si-reap skips such a
    // row, and the tick later fills THIS attempt in place rather than appending
    // a second one (attempt counts are read by the si-ledger API and CLI).
    await ledger.stampAttempt(patternKey, { prdKey, outcome: "in-run", note: holdNote(record) });
  }
  console.log(`[prd-submitter] DEFERRED ${prdKey} arrived=${arrivedAt} scheduledStart=${scheduledStartAt} keys=${keys.join(",")} (si-ledger → in-run, start held for the approver window)`);
  return {
    statusCode: 200,
    body: JSON.stringify({ deferred: true, prdKey, arrivedAt, scheduledStartAt, patternKeys: keys }),
  };
}

/**
 * Point the hold's in-run attempt at the run that now carries it, IN PLACE, so
 * the row ends exactly as an unheld submission leaves it (one attempt). If the
 * hold's ledger write never landed, fall back to the ordinary writes.
 */
async function linkLedger(record, ledger) {
  const { prdKey, workflowId, epicId, keys = [] } = record;
  for (const patternKey of keys) {
    const row = await ledger.get(patternKey);
    if (!row) {
      console.warn(`[prd-submitter] si-ledger link: no row for ${patternKey} — skipped`);
      continue;
    }
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    if (attempts.some((a) => a?.prdKey === prdKey && a?.workflowId === workflowId)) continue;
    const held = attempts.find((a) => a?.prdKey === prdKey && !a?.workflowId);
    if (held) {
      const next = structuredClone(row);
      const attempt = next.attempts.find((a) => a?.prdKey === prdKey && !a?.workflowId);
      attempt.workflowId = String(workflowId);
      if (epicId) attempt.epicId = String(epicId);
      attempt.note = `deferred ${record.arrivedAt} -> started ${record.startedAt}`;
      await ledger.put(next);
    } else {
      const entries = record.expectedByKey?.[patternKey] || [];
      if (entries.length) await ledger.putExpected(patternKey, entries, { prdKey, at: record.arrivedAt });
      await ledger.markInRun([patternKey], { prdKey, workflowId, epicId });
    }
  }
}

async function listDeferralKeys(s3, prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    for (const obj of out?.Contents || []) if (obj?.Key?.endsWith(".json")) keys.push(obj.Key);
    ContinuationToken = out?.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

/**
 * A finished hold (started + ledger linked) moves to DONE_PREFIX, so the tick's
 * list stays the size of what is actually pending. Copy first, then delete: a
 * crash between the two leaves the record in both places, and the next tick
 * just finishes the move.
 */
async function archive(s3, key, record) {
  await writeDeferral(s3, doneKey(record.prdKey), record);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    // Non-fatal: the record is `started` + linked, so the next tick only
    // re-archives it — a started record is never POSTed again.
    console.warn(`[prd-submitter] tick: archived ${key} but could not delete it (re-archived next tick): ${err?.message || err}`);
  }
}

const isTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * Why a hold in an actionable state cannot be acted on, or null when it can.
 * A record missing what the start needs (a stray or hand-written object) is
 * skipped, never POSTed: an empty payload would start a run from nothing.
 */
export function holdProblem(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "not a JSON object";
  if (typeof record.prdKey !== "string" || !record.prdKey) return "no prdKey";
  if (!Array.isArray(record.keys)) return "no keys[]";
  if (record.state === "started") return typeof record.workflowId === "string" && record.workflowId ? null : "started with no workflowId";
  if (!isTime(record.scheduledStartAt)) return "no valid scheduledStartAt";
  const p = record.payload;
  if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.title !== "string" || !p.title) return "no valid payload";
  if (record.state === "starting" && !isTime(record.claimedAt)) return "starting with no valid claimedAt";
  return null;
}

/**
 * One record, as far forward as it will go this tick.
 * → { outcome: "waiting" | "linked" | "unlinked" | "skipped" | "failed" | "malformed" | "stuck", started }
 */
async function advance(key, { s3, ledger, fetchImpl, nowMs }) {
  let found;
  try {
    found = await readDeferral(s3, key);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    found = { record: null };
  }
  if (!found) return { outcome: "skipped", started: false };
  let { record, etag } = found;
  let started = false;

  if (!record || ["pending", "starting", "started"].includes(record.state)) {
    const problem = holdProblem(record);
    if (problem) {
      // Left exactly as found — no claim, no POST, no ledger write.
      console.warn(`[prd-submitter] tick: malformed hold ${key} (${problem}) — skipped, never started`);
      return { outcome: "malformed", started };
    }
  }

  if (record.state === "starting") {
    // A claim is never re-POSTed by a tick. Its start may already have created a
    // run before the claim's holder died, and /api/workflow/start re-points its
    // (sourceTicket, defId) marker once that run is terminal, so a blind retry
    // could fork a second run for one PRD. A live claim belongs to its tick; a
    // stale or unknown-outcome one is a human's call (see stuckMessage).
    if (!record.uncertain && nowMs - Date.parse(record.claimedAt) <= STALE_CLAIM_MS) return { outcome: "waiting", started };
    console.error(`[prd-submitter] tick: ${stuckMessage(key, record)}`);
    return { outcome: "stuck", started };
  }

  if (record.state === "pending") {
    if (!(Date.parse(record.scheduledStartAt) <= nowMs)) return { outcome: "waiting", started };

    const claimed = { ...record, state: "starting", claimedAt: new Date(nowMs).toISOString() };
    delete claimed.uncertain;
    try {
      etag = await writeDeferral(s3, key, claimed, { IfMatch: etag });
    } catch (err) {
      if (isPreconditionFailed(err)) return { outcome: "skipped", started }; // another tick holds it
      throw err;
    }

    let resp;
    try {
      resp = await fetchImpl(`${WORKFLOW_API}/api/workflow/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record.payload),
      });
    } catch (err) {
      resp = { ok: false, status: 0, text: async () => String(err?.message || err) };
    }
    if (!resp.ok) {
      const lastError = `API ${resp.status}: ${await resp.text()}`;
      if (UNKNOWN_OUTCOME_STATUS.has(resp.status)) {
        // The request may have reached the route and created a run: stay
        // claimed, flagged, and never retried automatically.
        const flagged = { ...claimed, uncertain: true, lastError };
        await writeDeferral(s3, key, flagged, { IfMatch: etag });
        console.error(`[prd-submitter] tick: ${stuckMessage(key, flagged)}`);
        return { outcome: "stuck", started };
      }
      console.error(`[prd-submitter] tick: start of held ${record.prdKey} failed (${lastError}) — retrying next tick`);
      await writeDeferral(s3, key, { ...claimed, state: "pending", lastError }, { IfMatch: etag });
      return { outcome: "failed", started };
    }
    const startBody = await resp.json();
    const named = startedRun(startBody);
    if (!named) {
      // The route answered but started nothing (a sweep-preflight skip). A
      // retry would answer the same, so a human decides, as for any stuck hold.
      const flagged = { ...claimed, uncertain: true, lastError: `API ${resp.status} named no run: ${JSON.stringify(startBody).slice(0, 300)}` };
      await writeDeferral(s3, key, flagged, { IfMatch: etag });
      console.error(`[prd-submitter] tick: ${stuckMessage(key, flagged)}`);
      return { outcome: "stuck", started };
    }
    const { workflowId, epicId } = named;
    record = { ...claimed, state: "started", workflowId, epicId, startedAt: new Date(nowMs).toISOString() };
    delete record.lastError;
    started = true;
    try {
      etag = await writeDeferral(s3, key, record, { IfMatch: etag });
    } catch (err) {
      // The record stays `starting`, which a tick never re-POSTs; name the run
      // here so the human resolving it does not have to look it up.
      console.error(`[prd-submitter] tick: STARTED ${record.prdKey} as ${workflowId} but could not record it (${err?.message || err}) — set ${key} to state "started", workflowId "${workflowId}"`);
      throw err;
    }
    console.log(`[prd-submitter] STARTED ${record.prdKey} ${workflowId} (epic: ${epicId ?? "none — coalesced"}) arrived=${record.arrivedAt} scheduled=${record.scheduledStartAt}`);
  }

  if (record.state === "started" && !record.ledgerLinked) {
    try {
      await linkLedger(record, ledger);
    } catch (err) {
      console.error(`[prd-submitter] tick: si-ledger link FAILED for ${record.prdKey} (run ${record.workflowId} is unaffected; retrying next tick): ${err?.message || err}`);
      return { outcome: "unlinked", started };
    }
    record = { ...record, ledgerLinked: true };
    await writeDeferral(s3, key, record, { IfMatch: etag });
  }

  if (record.state === "started" && record.ledgerLinked) {
    await archive(s3, key, record);
    return { outcome: "linked", started };
  }
  return { outcome: "skipped", started };
}

/** The five-minute tick: start every hold whose window has opened. Never throws per record. */
export async function tick({ s3, ledger, fetchImpl, now }) {
  const nowMs = (now ? new Date(now) : new Date()).getTime();
  const counts = { held: 0, waiting: 0, started: 0, linked: 0, unlinked: 0, failed: 0, skipped: 0, malformed: 0, stuck: 0 };
  const keys = await listDeferralKeys(s3, DEFERRED_PREFIX);
  counts.held = keys.length;
  for (const key of keys) {
    try {
      const { outcome, started } = await advance(key, { s3, ledger, fetchImpl, nowMs });
      counts[outcome] += 1;
      if (started) counts.started += 1;
    } catch (err) {
      counts.failed += 1;
      console.error(`[prd-submitter] tick: ${key} failed: ${err?.message || err}`);
    }
  }
  console.log(`[prd-submitter] tick: held=${counts.held} waiting=${counts.waiting} started=${counts.started} linked=${counts.linked} unlinked=${counts.unlinked} failed=${counts.failed} skipped=${counts.skipped} malformed=${counts.malformed} stuck=${counts.stuck}`);
  return { statusCode: 200, body: JSON.stringify(counts) };
}

/** Every hold, pending and finished — what `{mode:"status"}` returns. */
export async function status({ s3, now }) {
  const nowMs = (now ? new Date(now) : new Date()).getTime();
  const deferred = [];
  for (const prefix of [DEFERRED_PREFIX, DONE_PREFIX]) {
    for (const key of await listDeferralKeys(s3, prefix)) {
      let found;
      try {
        found = await readDeferral(s3, key);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        found = { record: null };
      }
      if (!found) continue;
      const r = found.record && typeof found.record === "object" ? found.record : {};
      const problem = ["pending", "starting", "started"].includes(r.state) || !found.record ? holdProblem(found.record) : null;
      deferred.push({
        key,
        prdKey: r.prdKey,
        arrivedAt: r.arrivedAt,
        scheduledStartAt: r.scheduledStartAt,
        state: r.state,
        ...(r.workflowId ? { workflowId: r.workflowId } : {}),
        ...(r.lastError ? { lastError: r.lastError } : {}),
        ...(prefix === DEFERRED_PREFIX && problem ? { malformed: problem } : {}),
        ...(prefix === DEFERRED_PREFIX && !problem && r.state === "starting" &&
          (r.uncertain || nowMs - Date.parse(r.claimedAt) > STALE_CLAIM_MS)
          ? { stuck: stuckMessage(key, r) } : {}),
      });
    }
  }
  return { statusCode: 200, body: JSON.stringify({ deferred }) };
}

export async function handler(event) {
  if (event?.mode === "tick") return tick({ s3: s3(), ledger: siLedger(), fetchImpl: fetch });
  if (event?.mode === "status") return status({ s3: s3() });
  return run(event, { s3: s3(), ledger: siLedger(), fetchImpl: fetch });
}
