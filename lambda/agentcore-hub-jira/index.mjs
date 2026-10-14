/**
 * agentcore-hub-jira — Ticket tools Lambda for Jira Cloud.
 *
 * Deploy this when TICKET_PROVIDER=jira.
 * Agents call this Lambda to create/update/transition tickets in Jira.
 *
 * Env vars:
 *   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 */

import { randomUUID } from "node:crypto"; // TEAM-5723: per-request fence nonce; TEAM-5941: the Done-intent nonce
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
// TEAM-4740 FR-5 (interim): the ONLY DynamoDB this Lambda touches is the events
// table, and only to audit an autowired blocker edge — the same write the DynamoDB
// twin makes, so the twins emit one event vocabulary instead of two. Dark unless
// EVENTS_TABLE is set (this Lambda's deploy env does not set it), and the client is
// built lazily inside emitJourneyEvent so an unconfigured deploy pays nothing.
// Both packages are provided by the nodejs20.x runtime, so the self-contained zip
// stays self-contained.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
// TEAM-4121 FR-8: the shared fix-ticket contract. Byte-identical copy of the one
// in lambda/agentcore-hub-tickets/ and lambda/orchestrator/ (each Lambda ships as
// a self-contained zip, so they cannot share a file); CI byte-compares them.
// Edit one copy, then `cp` it over the other two.
import {
  FIX_KINDS,
  KIND_TO_ORIGIN_KEY,
  TICKET_KEY_RE,
  gateKindsOf,
  sanitizeSpawnedBy,
  validateFixContract,
  normalizeContractMode,
  sanitizeUserLabels,
  contractLabels,
  renderFixContractBlock,
  escapeJql,
} from "./fix-contract.mjs";
// TEAM-4739: the probe/journey/verdict half of the gate contract. TWO byte-identical
// copies (this one and lambda/agentcore-hub-tickets/gate-contract.mjs, the canonical
// one); the orchestrator deliberately does NOT get a copy — it must not grow a probe
// seam (DL-009). Edit the tickets copy, then `cp` it here.
import {
  GATE_AWAITING_CONSOLE_LABEL,
  GATE_AWAITING_CONSOLE_RE,
  GATE_CONDITION_UNMET,
  GATE_LOOP_BROKEN_LABEL,
  GATE_LOOP_BROKEN_RE,
  MERGE_GATE_LABEL_RE,
  consoleApprovalUrl,
  descriptionCarriesConsoleLink,
  gateExecOf,
  gateHeadOf,
  gateLoopRefusal,
  gateLoopVerdict,
  gatePipelineOf,
  gateRefusal,
  gateShapeRefusal,
  gateVerificationSlots,
  invokeProbe,
  judgeCompletionRecord,
  judgeBriefHold,
  briefHoldUnknown,
  judgePostCommitHold,
  postCommitHoldConflict,
  postCommitUncheckedWarning,
  DONE_INTENT_FENCE_ATTEMPTS,
  DONE_UNFENCED_WHAT,
  classifyS3WriteError,
  doneIntentContendedRefusal,
  doneIntentUnfencedRefusal,
  rejudgeAdmitted,
  withDoneIntent,
  withoutDoneIntent,
  doneIntentReservation,
  SECURITY_REVIEWER_AGENT,
  designAmendmentVerdict,
  designAmendmentRefusal,
  designAmendmentKeeper,
  amendmentDependents,
  parseFixDecision,
  pipelineLabelOverflow,
  pipelineLabelRefusal,
  probedGateKindOf,
  publishJourneyEvent,
  terminalMoveRefusal,
  verifyGateCondition,
} from "./gate-contract.mjs";

// ─── Jira Config ─────────────────────────────────────────────────────────────

const SITE = process.env.JIRA_SITE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";
// TEAM-4113: fix-ticket origin kinds an agent may stamp via `spawned_by` — now
// the shared FIX_KINDS from fix-contract.mjs (TEAM-4121), in lockstep with the
// DynamoDB tickets Lambda + orchestrator completion.mjs by construction.
// TEAM-4121 FR-8: off = ignore the contract fields (byte-identical to before);
// shadow = validate + accept + label `contract:incomplete`; enforce = reject.
const FIX_TICKET_CONTRACT = normalizeContractMode(process.env.FIX_TICKET_CONTRACT);

const BASE_URL = `https://${SITE}`;
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

// ─── S3 Config (for agent roster) ────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
// TEAM-4739. Both are OPTIONAL and both fail SOFT when unset:
//   PIPELINE_TOOLS_LAMBDA — the read-only pipeline probe. Unset ⇒ every gate
//     verdict is `indeterminate`, i.e. every gate close is ADMITTED and stamped.
//     An install without the pipeline module keeps exactly today's behaviour.
//   EVENTS_TABLE — where `gate.repaged` / `workflow.blocked` journey events go.
//     Unset ⇒ no event is written; the refusal itself is unaffected.
const PIPELINE_TOOLS_LAMBDA = process.env.PIPELINE_TOOLS_LAMBDA || "";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "";

// This Lambda talks to Jira, not DynamoDB — the ONLY reason it needs a document
// client is the shared journey-event writer, and only when EVENTS_TABLE is set. So
// it is built lazily: an install without the events table never constructs one, and
// the cold start of every other tool call is unchanged.
let journeyDdb = null;
function eventsClient() {
  if (!EVENTS_TABLE) return null;
  if (!journeyDdb) {
    journeyDdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }
  return journeyDdb;
}

// Exported ONLY as a test seam: this suite runs under `node --test`, which has no
// module registry to mock (no vi.mock), so index.test.mjs stubs `s3.send` on a
// freshly imported instance to drive the completion-record HeadObject below.
// Production code never reassigns it.
export const s3 = new S3Client({ region: REGION });

// TEAM-5716: the orchestrator's workflows table, read (GetItem only) to fence a
// claim-stamped park on its claim generation. Unset ⇒ no client, fence inert,
// byte-identical. Exported as a test seam exactly like `s3` above.
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "";
export const workflowsDdb = WORKFLOWS_TABLE ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })) : null;

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_ASSIGNEES = new Set([
  "agentcore_hub_requirements_analyst",
  "agentcore_hub_frontend_designer",
  "agentcore_hub_ios_designer",
  "agentcore_hub_backend_designer",
  "agentcore_hub_android_designer",
  "agentcore_hub_security_reviewer",
  "agentcore_hub_legal_compliance",
  "agentcore_hub_localization",
  "agentcore_hub_analytics_designer",
  "agentcore_hub_backend_dev",
  "agentcore_hub_api_dev",
  "agentcore_hub_frontend_dev",
  "agentcore_hub_code_reviewer",
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
  "agentcore_hub_release_manager",
]);

let VALID_ASSIGNEES = null;

async function loadValidAssignees() {
  if (VALID_ASSIGNEES) return VALID_ASSIGNEES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-jira] No ARTIFACT_BUCKET — using fallback roster");
    VALID_ASSIGNEES = FALLBACK_ASSIGNEES;
    return VALID_ASSIGNEES;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    VALID_ASSIGNEES = new Set(config.agents.map((a) => a.agentId));
    console.log(`[agentcore-hub-jira] Loaded ${VALID_ASSIGNEES.size} agents from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-jira] Failed to load roster from S3: ${err.message} — using fallback`);
    VALID_ASSIGNEES = FALLBACK_ASSIGNEES;
  }
  return VALID_ASSIGNEES;
}

// ─── Workflow Phases (TEAM-4121 F7 — ported from the DynamoDB tickets Lambda) ─
//
// TEAM-3686 established this check in the DynamoDB provider: completion.mjs's
// open-fix gate matches fix tickets per-phase (`phaseOf(t) === p` for each
// required phase p), so a fix ticket stamped with a phase outside the known set
// is invisible to EVERY required phase's check — the run can be declared
// complete with the fix still open. Jira mode had the same exposure and worse:
// createTicket DROPPED `phase` on the floor entirely, so an agent's correct
// stamp was silently lost and the orchestrator had nothing to read.
//
// The valid set is derived from the same S3 configs the orchestrator and the
// DynamoDB Lambda read — roster phases from config/agents.json plus each
// workflow def's agentPhases + completionRequiresAgentPhases from
// config/workflows.json — and the rejection text is byte-identical to the
// tickets Lambda's, so an agent gets the same instruction in either mode.
const FALLBACK_PHASES = new Set([
  "requirements",
  "design",
  "development",
  "verification",
  "review",
  "ship",
]);

let VALID_PHASES = null;

async function loadValidPhases() {
  if (VALID_PHASES) return VALID_PHASES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-jira] No ARTIFACT_BUCKET — using fallback phase set");
    VALID_PHASES = FALLBACK_PHASES;
    return VALID_PHASES;
  }
  const phases = new Set();
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const a of config.agents || []) {
      if (typeof a.phase === "string" && a.phase) phases.add(a.phase);
    }
  } catch (err) {
    console.warn(`[agentcore-hub-jira] Failed to load agent phases from S3: ${err.message}`);
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/workflows.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const w of config.workflows || []) {
      for (const p of w.phases || []) {
        if (typeof p.agentPhase === "string" && p.agentPhase) phases.add(p.agentPhase);
      }
      for (const p of w.completionRequiresAgentPhases || []) {
        if (typeof p === "string" && p) phases.add(p);
      }
    }
  } catch (err) {
    console.warn(`[agentcore-hub-jira] Failed to load workflow phases from S3: ${err.message}`);
  }
  if (phases.size === 0) {
    console.warn("[agentcore-hub-jira] No phases loaded from S3 — using fallback phase set");
    VALID_PHASES = FALLBACK_PHASES;
  } else {
    VALID_PHASES = phases;
    console.log(`[agentcore-hub-jira] Loaded ${phases.size} valid phases from S3 config`);
  }
  return VALID_PHASES;
}

// ─── Agent → phase map (TEAM-4706) ───────────────────────────────────────────
//
// VALID_PHASES above collapses the roster to a SET of phase names, which cannot
// answer the question the ship-phase gate asks: "is THIS ticket's assignee a
// ship-phase agent?" Same loader style, same S3 object (config/agents.json), so
// a roster edit still needs no redeploy — Lambdas pick it up on the next cold
// start. The fallback mirrors src/config/agents.json's pipeline roster, so an S3
// read failure still recognizes the release manager as ship phase.
const FALLBACK_AGENT_PHASES = new Map([
  ["agentcore_hub_requirements_analyst", "requirements"],
  ["agentcore_hub_frontend_designer", "design"],
  ["agentcore_hub_ios_designer", "design"],
  ["agentcore_hub_backend_designer", "design"],
  ["agentcore_hub_android_designer", "design"],
  ["agentcore_hub_security_reviewer", "design"],
  ["agentcore_hub_legal_compliance", "design"],
  ["agentcore_hub_localization", "design"],
  ["agentcore_hub_analytics_designer", "design"],
  ["agentcore_hub_backend_dev", "development"],
  ["agentcore_hub_api_dev", "development"],
  ["agentcore_hub_frontend_dev", "development"],
  ["agentcore_hub_code_reviewer", "review"],
  ["agentcore_hub_qa_verifier", "verification"],
  ["agentcore_hub_ci_agent", "review"],
  ["agentcore_hub_release_manager", "ship"],
]);

let AGENT_PHASES = null;

async function loadAgentPhases() {
  if (AGENT_PHASES) return AGENT_PHASES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-jira] No ARTIFACT_BUCKET — using fallback agent-phase map");
    AGENT_PHASES = FALLBACK_AGENT_PHASES;
    return AGENT_PHASES;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    const map = new Map();
    for (const a of config.agents || []) {
      if (typeof a.agentId === "string" && a.agentId && typeof a.phase === "string" && a.phase) {
        map.set(a.agentId, a.phase);
      }
    }
    if (map.size === 0) throw new Error("no agentId/phase pairs in config/agents.json");
    AGENT_PHASES = map;
    console.log(`[agentcore-hub-jira] Loaded ${map.size} agent phases from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-jira] Failed to load agent phases from S3: ${err.message} — using fallback agent-phase map`);
    AGENT_PHASES = FALLBACK_AGENT_PHASES;
  }
  return AGENT_PHASES;
}

// ─── Ship-phase completion-record gate (TEAM-4706, DL-030) ───────────────────
//
// A ship-phase ticket may not reach Done unless the agent's own completion record
// exists at s3://$ARTIFACT_BUCKET/completions/<ticket_id>.json — the record
// lambda/workflow-output writes (reportCompletion) BEFORE it asks this Lambda for
// the transition, and the only durable statement of what actually shipped. Closing
// a ship ticket by hand leaves the run's completion gates, its KPIs and the deploy
// audit trail with nothing to read.
//
// TEAM-4757 R3-2: the guard READS THE RECORD'S BODY, it no longer just proves the
// key exists. reportCompletion stamps `followUpsPending` (and a `status` of
// "complete" / "complete_pending_follow_ups" / "complete_transition_failed") into
// the record after materializing follow-up tickets and before the Done transition,
// so a record written while follow-ups were still unfiled used to satisfy an
// existence-only check exactly as well as a finished one — and a direct
// transition_ticket(done) on that ticket closed the run, cascaded, and completed the
// epic over work that was never filed. `followUpsPending === true` is now refused
// with the re-run hint; `!== true` (never `=== false`) admits every pre-4756 record,
// every sweep skip-record and the transition-failed recovery. The judgement itself —
// every refusal string — is judgeCompletionRecord in gate-contract.mjs, so the two
// providers cannot drift on what they say; only the GetObject is per-twin.
//
// Twin of the block in lambda/agentcore-hub-tickets/index.mjs: both providers must
// refuse identically (the twins doctrine, TEAM-4131 F2), so edit both or neither.
// Not in fix-contract.mjs — that module is byte-compared across three copies by
// CI, and each provider expresses the refusal in its own idiom.
const SHIP_PHASE = "ship";

// The refusal payload, verbatim in both providers. `reason` is what an agent (and
// the orchestrator) match on; `hint` names the one call that does this correctly.
const COMPLETION_RECORD_REQUIRED = {
  ok: false,
  reason: "completion_record_required",
  hint: "call WorkflowOutput___report_completion(ticket_id=…) — it writes the record and transitions the ticket for you",
};

/**
 * Is this ticket a ship-phase AGENT ticket? Cheap checks first: the caller only
 * pays for the S3 read of the completion record when this says yes.
 *
 * Human-review gates are EXEMPT, and that exemption comes first — the hub UI's
 * approve action (src/app/api/workflow/[id]/tickets/transition/route.ts) and the
 * Telegram bridge's ✅ both transition through this same tool without writing a
 * record, and a Merge Approval gate carries `phase:ship` itself, so gating them
 * would deadlock every human gate in the pipeline.
 */
async function isShipPhaseTicket(labels) {
  const labelList = (labels || []).map((l) => String(l));
  if (labelList.some((l) => l === "human-review" || l.startsWith("reviewer:"))) return false;
  if (labelList.includes(`phase:${SHIP_PHASE}`)) return true;
  const agentLabel = labelList.find((l) => l.startsWith("agent:"));
  if (!agentLabel) return false;
  const assignee = agentLabel.slice("agent:".length);
  if (!assignee || assignee.startsWith("human:")) return false;
  const phases = await loadAgentPhases();
  return phases.get(assignee) === SHIP_PHASE;
}

/**
 * POSITIVE proof that completions/<ticketId>.json exists AND reports finished work.
 * Fails CLOSED on an indeterminate answer (AccessDenied, throttle, timeout,
 * ARTIFACT_BUCKET unset, a body that is not a JSON object): "we could not find a
 * record" is not "there is no record", the same positive-evidence rule as DL-028's
 * deploy gate. `why` is log/message text only — never a credential, never the raw
 * AWS error body.
 *
 * TEAM-4757 R3-2: this GETs the body rather than HeadObject-ing the key, because
 * existence alone stopped being the answer when TEAM-4756 started stamping
 * `followUpsPending`/`status` into the record (see judgeCompletionRecord's section
 * in gate-contract.mjs for the invariant and for why the test is `!== true`). The
 * missing-record and indeterminate texts are byte-unchanged; only a record that
 * exists and says its follow-ups are still pending is newly refused.
 */
async function completionRecordProven(ticketId, opts = {}, capture = null) {
  const key = `completions/${ticketId}.json`;
  if (!ARTIFACT_BUCKET) {
    return { proven: false, why: `ARTIFACT_BUCKET is unset, so ${key} cannot be read` };
  }
  let bodyText;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    // Inside the try on purpose: a stream that fails mid-read, or a response with no
    // Body at all, is the same "could not tell" as the GetObject itself throwing.
    bodyText = await res.Body.transformToString();
    // TEAM-5941: `securityReview` rides along so the fence's re-judge uses the same judge.
    if (capture) Object.assign(capture, { key, etag: res.ETag, absent: false, bodyText, recordGated: true, securityReview: opts.securityReview === true });
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) {
      return { proven: false, why: `no ${key} in the artifact bucket` };
    }
    return { proven: false, why: `could not read ${key} (${err?.name || "S3Error"}${status ? ` ${status}` : ""})` };
  }
  return judgeCompletionRecord(key, bodyText, opts);
}

/**
 * TEAM-5805 / TEAM-5832: the merge-brief hold on a ticket whose Done is NOT otherwise
 * gated on its record — every ticket but ship-phase and security reviews, because the
 * writer (workflow-output) stamps `briefPending` on any ticket whose report named the
 * brief, whoever it is assigned to. The key is the ticket id alone, so it is the same
 * key for any assignee. null (admit) only when there is provably no hold to read:
 *   · ARTIFACT_BUCKET unset — deploy-time config (since TEAM-5867 setup-tickets-lambda.mjs
 *     refuses to deploy without one and always sets it, so this means a function last
 *     deployed before that, or a hand-edited env), and with no bucket the writer cannot
 *     stamp a hold either. Refusing here would refuse EVERY non-ship Done fleet-wide, with no retry
 *     that could ever succeed. Ship-phase and security tickets still refuse an unset
 *     bucket through completionRecordProven.
 *   · 404 / NoSuchKey / NotFound — no record, so no hold.
 * Anything else — AccessDenied, throttling, a 5xx, a timeout, a body stream that fails
 * mid-read — is "could not tell", not "no hold", and REFUSES (briefHoldUnknown marks it
 * `unknown: true`, so the caller says so), the same positive-evidence rule as completionRecordProven. A body
 * that reads but cannot be judged refuses too (judgeBriefHold).
 */
async function briefHoldOf(ticketId, capture = null) {
  const key = `completions/${ticketId}.json`;
  if (!ARTIFACT_BUCKET) return null;
  let bodyText;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    // Inside the try on purpose, as in completionRecordProven: a stream that fails
    // mid-read, or no Body at all, is the same "could not tell".
    bodyText = await res.Body.transformToString();
    if (capture) Object.assign(capture, { key, etag: res.ETag, absent: false, bodyText });
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) {
      if (capture) Object.assign(capture, { key, absent: true });
      return null;
    }
    return briefHoldUnknown(key, `could not read ${key} (${err?.name || "S3Error"}${status ? ` ${status}` : ""})`);
  }
  return judgeBriefHold(key, bodyText);
}

/**
 * The refusal, in this Lambda's idiom: transitionTicket signals every other
 * failure by throwing, and the handler turns a throw into `{ error }`. The
 * structured payload rides on the Error so the handler can return `reason`/`hint`
 * verbatim ALONGSIDE `error` — the `error` field is what the hub UI's
 * rejectedDetails() recognizes as "the ticket did not move".
 */
function completionRecordRequiredError(ticketId, why, what = "a ship-phase ticket") {
  const err = new Error(
    `Cannot move ${ticketId} to Done: ${what} needs its completion record first — ` +
    `${COMPLETION_RECORD_REQUIRED.hint} (${why})`
  );
  err.toolResult = { ...COMPLETION_RECORD_REQUIRED };
  return err;
}

/**
 * TEAM-5941 (TEAM-5799 ship-review r2 F1): the Done-intent fence — the LAST awaited
 * step before the transition POST. See the "Done-intent fence" section of
 * gate-contract.mjs for the design. This is the I/O half, in this twin's idiom (throws
 * a completionRecordRequiredError to refuse). Twin of the tickets Lambda's
 * fenceDoneIntent. Mutates `admitted` on success: `etag`/`bodyText` become the fenced
 * record (so postCommitHoldCheck compares against it), `absent` is false and `intent` is set.
 *
 *   · a record admitted ⇒ PUT the intent onto it with IfMatch on the admitted ETag;
 *   · no record admitted (404) ⇒ TEAM-5959 (TEAM-5799 F5): RESERVE the key with a
 *     create-only PUT (IfNoneMatch:"*") of an intent-only reservation
 *     (gate-contract.mjs doneIntentReservation) — it used to skip the fence, and a
 *     record created + hold-stamped inside the commit window then lost the fence;
 *   · PUT won ⇒ fenced;
 *   · 412/409 ⇒ re-read and re-judge with the guard's own judge: a hold ⇒ the standard
 *     refusal; admitted (a hold-free record, or another twin's reservation) ⇒ CAS again
 *     with IfMatch, DONE_INTENT_FENCE_ATTEMPTS times in all, then refuse;
 *   · the record vanished (PUT or re-read 404) ⇒ a ship / security ticket refuses as it
 *     would on "no record" (DL-030); any other ticket RE-RESERVES create-only on the
 *     next attempt (TEAM-5959: it used to proceed unfenced);
 *   · AccessDenied, 5xx, a failed re-read ⇒ REFUSE (fail closed: deploy config, not a race).
 * A refusal here can leave the reason comment and blocker links written (as the
 * TEAM-5707 precondition re-read can); the ticket itself has not moved.
 */
async function fenceDoneIntent(ticketId, admitted) {
  if (!ARTIFACT_BUCKET || !admitted.key) return;
  const key = admitted.key;
  const vanished = () => {
    if (admitted.recordGated) {
      throw completionRecordRequiredError(ticketId, `no ${key} in the artifact bucket`, admitted.securityReview ? "a security-review ticket" : "a ship-phase ticket");
    }
    Object.assign(admitted, { absent: true });
    delete admitted.etag;
    delete admitted.bodyText;
  };
  const errText = (err) => `${err?.name || "S3Error"}${err?.$metadata?.httpStatusCode ? ` ${err.$metadata.httpStatusCode}` : ""}`;
  for (let attempt = 1; attempt <= DONE_INTENT_FENCE_ATTEMPTS; attempt++) {
    const at = new Date().toISOString();
    const nonce = randomUUID();
    const intent = { provider: "jira", at, nonce };
    // TEAM-5959: nothing admitted (404, or vanished under an earlier attempt) ⇒ a
    // create-only reservation; a record ⇒ the intent CASed onto its body.
    const reserving = admitted.absent === true;
    const body = JSON.stringify(reserving ? doneIntentReservation(ticketId, intent) : withDoneIntent(JSON.parse(admitted.bodyText), intent), null, 2);
    let kind;
    try {
      const res = await s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key, Body: body, ContentType: "application/json", ...(reserving ? { IfNoneMatch: "*" } : { IfMatch: admitted.etag }) }));
      Object.assign(admitted, { etag: res.ETag, bodyText: body, intent: { at, nonce }, absent: false });
      return;
    } catch (err) {
      kind = classifyS3WriteError(err);
      if (kind === "other") {
        console.warn(`[agentcore-hub-jira] ${ticketId}: refusing done — the Done-intent fence on ${key} could not be written (${errText(err)})`);
        throw completionRecordRequiredError(ticketId, doneIntentUnfencedRefusal(key, `PutObject ${errText(err)}`), DONE_UNFENCED_WHAT);
      }
      if (kind === "gone") {
        vanished();
        console.warn(`[agentcore-hub-jira] ${ticketId}: ${key} vanished under the Done-intent fence (attempt ${attempt}/${DONE_INTENT_FENCE_ATTEMPTS}) — reserving it`);
        continue;
      }
    }
    // The record moved under the fence (or another writer created it first): read what
    // it says now, with the guard's judge.
    let bodyText;
    let etag;
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
      bodyText = await res.Body.transformToString();
      etag = res.ETag;
    } catch (err) {
      if (classifyS3WriteError(err) === "gone") {
        vanished();
        console.warn(`[agentcore-hub-jira] ${ticketId}: ${key} vanished under the Done-intent fence (attempt ${attempt}/${DONE_INTENT_FENCE_ATTEMPTS}) — reserving it`);
        continue;
      }
      console.warn(`[agentcore-hub-jira] ${ticketId}: refusing done — ${key} changed under the Done-intent fence and could not be re-read (${errText(err)})`);
      throw completionRecordRequiredError(ticketId, doneIntentUnfencedRefusal(key, `re-read ${errText(err)}`), DONE_UNFENCED_WHAT);
    }
    const verdict = rejudgeAdmitted(key, bodyText, admitted);
    if (verdict) {
      console.warn(`[agentcore-hub-jira] ${ticketId}: refusing done on ${verdict.what} — the record changed under the Done-intent fence: ${verdict.why}`);
      throw completionRecordRequiredError(ticketId, verdict.why, verdict.what);
    }
    Object.assign(admitted, { etag, bodyText, absent: false });
    console.warn(`[agentcore-hub-jira] ${ticketId}: ${key} changed under the Done-intent fence (${kind}, attempt ${attempt}/${DONE_INTENT_FENCE_ATTEMPTS}) — still admitted, fencing again`);
  }
  throw completionRecordRequiredError(ticketId, doneIntentContendedRefusal(key, DONE_INTENT_FENCE_ATTEMPTS), DONE_UNFENCED_WHAT);
}

/**
 * TEAM-5941: take the intent back off the record when the transition did not commit.
 * Best-effort, one conditional PUT, every failure only logged: a stale intent is
 * harmless (the drain treats one older than DONE_INTENT_TTL_MS as absent).
 */
async function clearDoneIntent(ticketId, admitted) {
  if (!admitted?.intent || !admitted.key || !admitted.bodyText) return;
  try {
    const body = JSON.stringify(withoutDoneIntent(JSON.parse(admitted.bodyText)), null, 2);
    const res = await s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: admitted.key, Body: body, ContentType: "application/json", IfMatch: admitted.etag }));
    Object.assign(admitted, { etag: res.ETag, bodyText: body });
    delete admitted.intent;
  } catch (err) {
    console.warn(`[agentcore-hub-jira] ${ticketId}: the Done did not commit and the Done-intent on ${admitted.key} could not be cleared (${err?.name || "S3Error"}) — it expires on its own`);
  }
}

// ─── The typed gate guard (TEAM-4739) ────────────────────────────────────────
//
// Twin of the block in lambda/agentcore-hub-tickets/index.mjs. Every REFUSAL STRING
// and every payload field comes out of the shared gate-contract.mjs, so the two
// providers cannot drift on what they say; only the I/O idiom differs (this one
// throws with `err.toolResult`, the DynamoDB twin returns a textResult).
//
// FAIL DIRECTION — the single most important thing about this guard. It answers "may
// this gate ticket CLOSE?", whose dangerous failure is an UNLIFTABLE STALL: there is
// no escalation rung above the human, so a gate nobody may close wedges the run
// forever. It therefore refuses ONLY on a definite negative — a SUCCESSFUL probe
// read whose content contradicts the close — and ADMITS everything indeterminate
// (unreachable probe, timeout, unparseable payload, unbound gate), stamping
// `gateVerification:"indeterminate"` so the close is auditable. DL-028's
// positive-evidence rule answers a DIFFERENT question ("may I DEPLOY?"), where the
// dangerous failure is an unapproved production change; it is untouched here.

/**
 * Both gates on a `→ Done` transition, in order: TEAM-4706's ship-phase completion
 * record (unchanged), then the typed-gate probe.
 *
 * @param {object} [admitted] TEAM-5926: filled with the completion-record read the
 *   guard admitted on ({key, etag, absent, bodyText}), for postCommitHoldCheck
 * @returns {Promise<object|null>} the verification to stamp, or null when this
 *   ticket is not a probed gate. Throws to refuse.
 */
async function gateConditionCleared(ticketId, labels, description, admitted = null) {
  // TEAM-4706 (DL-030), unchanged: a ship-phase ticket cannot reach Done without
  // its completion record.
  if (await isShipPhaseTicket(labels)) {
    const proof = await completionRecordProven(ticketId, {}, admitted);
    if (!proof.proven) {
      console.warn(
        `[agentcore-hub-jira] ${ticketId}: refusing done on a ship-phase ticket — ${proof.why}`
      );
      throw completionRecordRequiredError(ticketId, proof.why);
    }
  } else if ((labels || []).map((l) => String(l)).includes(`agent:${SECURITY_REVIEWER_AGENT}`)) {
    // TEAM-5426: a security review closes only through report_completion, which
    // refuses a non-PASS verdict until the one design amendment is done
    // (design_amendment_required). A direct `→ Done` would walk around that, so
    // the record must carry the securityReview stamp that only an ADMITTED report
    // writes — an existing record alone (say one written on a FAIL) is not enough.
    const proof = await completionRecordProven(ticketId, { securityReview: true }, admitted);
    if (!proof.proven) {
      console.warn(
        `[agentcore-hub-jira] ${ticketId}: refusing done on a security-review ticket — ${proof.why}`
      );
      throw completionRecordRequiredError(ticketId, proof.why, "a security-review ticket");
    }
  } else {
    // TEAM-5805 / TEAM-5832: any other ticket — whatever its `agent:` label says, or
    // none, human gates included — may carry a merge-brief hold (briefPending) that a
    // replay stamped when it could not put the brief on the gate; a direct `→ Done`
    // would release the gate without it. No record ⇒ admit; a record S3 cannot read ⇒
    // refuse.
    const hold = await briefHoldOf(ticketId, admitted);
    if (hold) {
      const what = hold.unknown ? "a ticket whose merge-brief hold cannot be read" : "a ticket whose merge brief is held";
      console.warn(`[agentcore-hub-jira] ${ticketId}: refusing done on ${what} — ${hold.why}`);
      throw completionRecordRequiredError(ticketId, hold.why, what);
    }
  }
  return verifyTypedGate(ticketId, labels, description);
}

/**
 * Probe the condition a gate ticket asserts. Returns null — no probe, no stamp, no
 * extra call, byte-identical to the pre-TEAM-4739 path — for any ticket that is not
 * a PROBED gate: a plain ticket, and deliberately also a `gate:approval` human
 * escalation gate (see PROBED_GATE_KINDS).
 */
async function verifyTypedGate(ticketId, labels, description) {
  const list = Array.isArray(labels) ? labels : [];
  if (gateKindsOf(list).length === 0) return null;
  const gateKind = probedGateKindOf(list);
  if (!gateKind) return null;

  const verdict = await verifyGateCondition(PIPELINE_TOOLS_LAMBDA, {
    gateKind,
    pipeline: gatePipelineOf(list),
    execId: gateExecOf(list),
    head: gateHeadOf(list),
    // ADVISORY only: a DECISION line can lift an environmental stall, it can never
    // manufacture a `verified`.
    decision: parseFixDecision(description),
    region: REGION,
  });

  if (!verdict.refuse) return verdict.verification;

  const refusal = gateRefusal({ ticketId, gateKind, verdict });
  await repageGate(ticketId, list, gateKind, verdict, refusal);
  const err = new Error(refusal.message);
  err.toolResult = { ...refusal.payload };
  throw err;
}

/** The run this ticket belongs to, off its own `wf:` label (SEC-16: never a caller argument). */
function gateWorkflowIdOf(labels) {
  for (const l of Array.isArray(labels) ? labels : []) {
    const m = /^wf[:-](.+)$/.exec(String(l ?? "").trim());
    if (m) return m[1];
  }
  return "";
}

/**
 * The refusal's side effects. The ticket STAYS WHERE IT IS — there is no
 * `awaiting_console` status — so all this does is make the stall visible: the
 * `gate:awaiting-console` label (which the Telegram bridge re-pages on), one
 * `gate.repaged` journey event, and one comment carrying the console deep link.
 *
 * It NEVER dispatches, and it never creates a ticket: a gate that cannot be closed
 * is answered by verifying the condition, not by filing a second gate.
 *
 * SIDE-EFFECT DEDUPE (event AND comment), and the one place this differs from the
 * DynamoDB twin: Jira's `add` verb is idempotent server-side and reports nothing
 * back, so addLabels cannot tell "newly added" from "already there" the way a
 * conditional list_append can. The dedupe is therefore the labels we ALREADY hold
 * from the transition's read — the first refusal pages and comments, every later
 * refusal on the same stall repeats the payload in silence. (A racing labeller could
 * cost one duplicate event; a duplicate page is cheaper than a missed one.)
 *
 * The comment is under that dedupe for a reason this twin feels harder than the
 * other (TEAM-4750 B1): getIssue reads only the newest 50 comments, so a
 * `transition_ticket(done)` retry loop appending the same console link evicts the
 * human's advisory `DECISION:` line out of the window the guard itself reads.
 *
 * Every side effect is best-effort: a correct refusal must not turn into a tool
 * error because Jira rate-limited a comment.
 */
async function repageGate(ticketId, labels, gateKind, verdict, refusal) {
  const parked = labels.some((l) => GATE_AWAITING_CONSOLE_RE.test(String(l ?? "").trim().toLowerCase()));
  let newlyLabelled = false;
  if (!parked) {
    try {
      await addLabels({ ticket_id: ticketId, labels: [GATE_AWAITING_CONSOLE_LABEL] });
      newlyLabelled = true;
    } catch (err) {
      console.warn(`[agentcore-hub-jira] ${ticketId}: could not label the parked gate — ${err?.name}`);
    }
  }

  if (newlyLabelled) {
    await publishJourneyEvent(eventsClient(), EVENTS_TABLE, gateWorkflowIdOf(labels), "gate.repaged", {
      ticketId,
      gateKind,
      consoleUrl: verdict.consoleUrl,
      attempt: 1,
    });

    try {
      await addComment({ ticket_id: ticketId, comment: refusal.comment });
    } catch (err) {
      console.warn(`[agentcore-hub-jira] ${ticketId}: could not comment the refusal — ${err?.name}`);
    }
  }
}

/**
 * The label half of the admit path, as Jira `update.labels` ops that ride in the
 * SAME request as the transition: stamp the verification, take `gate:awaiting-console`
 * off. One request, so a close can never be recorded without its verification.
 *
 * Jira has no arbitrary-field store, so the LABEL is the stamp here (the DynamoDB
 * twin writes the same label plus the structured `gateVerification` map). Only ever
 * removes a label the issue provably carries — a `remove` of an absent label risks a
 * 400 that would fail the whole transition, which is also why every remove uses the
 * issue's OWN spelling of the label rather than the canonical colon form.
 *
 * TEAM-4750 B2: the CONTRADICTORY stamp is removed too. Adding `gateverify:<result>`
 * without taking the opposite one off left a ticket carrying both after
 * done → reopen → done with a different verdict. Which labels those are comes from
 * gateVerificationSlots (gate-contract.mjs), the same helper the DynamoDB twin uses,
 * so neither twin can drift from the other. Order — awaiting, then contradictory,
 * then the add — keeps the common single-remove case byte-identical to before.
 */
function planGateLabelOps(labels, verification) {
  const list = Array.isArray(labels) ? labels : [];
  const { stamp, same, opposite } = gateVerificationSlots(list, verification?.result);
  const ops = [];
  for (const l of list) {
    if (GATE_AWAITING_CONSOLE_RE.test(String(l ?? "").trim().toLowerCase())) ops.push({ remove: l });
  }
  for (const o of opposite) ops.push({ remove: list[o] });
  if (stamp && same.length === 0) ops.push({ add: stamp });
  return ops;
}

/**
 * Refuse a SECOND gate ticket of the same kind against the same target under one
 * epic — the environmental loop that has an agent re-filing "CI is unavailable"
 * forever instead of starting a build. FR-2: one OPEN prior sharing this gate's own
 * binding already proves the re-file is the same environmental gate restated.
 *
 * What "the same target" means is per kind, and gateLoopVerdict owns the rule
 * (TEAM-4986): a deploy-approval gate is keyed on its `exec:<id>` and nothing else,
 * the rest on `head:` or an overlapping blocked_by. Never the parent and kind alone,
 * and never a sibling that has already been answered.
 *
 * Narrowed to PROBED_GATE_KINDS: a `gate:approval` human escalation is deliberately
 * RE-FILED when a round cap trips, so counting those as a loop would break the one
 * escalation path the system has.
 *
 * TWO fail directions, and the split is the point:
 *   - the SIBLING SCAN fails CLOSED — a scan failure REFUSES before anything is
 *     minted, exactly as autowireOpenGate does with the same scan (TEAM-4752 D1),
 *     because a gate created over an unknown sibling set may be the very loop this
 *     breaker exists to stop. Refusing costs one retry; creating costs another gate
 *     ticket nobody will notice.
 *   - the epic READ, the epic LABEL and the EVENT stay best-effort and fail open.
 *     They are the PAGE, not the verdict: an unreadable epic must not turn a proven
 *     loop into a created ticket.
 *
 * @returns {Promise<Error|null>} the Error to throw from createTicket, or null
 */
async function refuseGateLoop({ labels, blockedBy, parentId }) {
  const gateKind = probedGateKindOf(labels);
  if (!gateKind || !parentId || !TICKET_KEY_RE.test(String(parentId))) return null;

  // ONE sibling scan per create, shared with autowireOpenGate below. Both read the
  // same scanSiblingTickets, which pages through jiraSearchAll under one bound
  // (TEAM-5168): one scan, one bound, one fail direction.
  let siblings = [];
  try {
    siblings = await scanSiblingTickets(parentId);
  } catch (err) {
    console.warn(
      `[agentcore-hub-jira] gate-loop sibling scan failed for parent ${parentId} ` +
        `(REFUSING the create): ${err.message}`
    );
    return new Error(siblingScanRefusal(parentId, err.message));
  }

  // The NEW ticket's own labels carry its bindings — gateLoopVerdict reads the
  // `exec:`/`head:` binding itself (TEAM-4989), via the same sameGateBinding the
  // orchestrator's W3 re-file watch uses, so a create-time refusal and a re-file
  // page can never disagree about what "the same gate" means.
  const verdict = gateLoopVerdict(siblings, { gateKind, labels, blockedBy });
  if (!verdict.loop) return null;

  // Needed only for the page below now that the verdict reads the binding itself
  // (TEAM-4989) — the event still has to name what looped.
  const head = gateHeadOf(labels);
  const execId = gateExecOf(labels);

  // Only now is the epic worth reading — it carries the marker (the event dedupe)
  // and, in its labels, the workflowId the event needs (SEC-16: off the EPIC, never
  // a caller argument). `null` means COULD NOT TELL, which is not "not yet marked":
  // an unreadable epic skips both the label and the page, and still refuses.
  let epicLabels = null;
  try {
    const epic = await jiraFetch(`/rest/api/3/issue/${parentId}?fields=labels`);
    epicLabels = epic?.fields?.labels || [];
  } catch (err) {
    console.warn(`[agentcore-hub-jira] could not read epic ${parentId} — ${err?.name}`);
  }

  // The epic carries the marker, and its ABSENCE in the read above is the event
  // dedupe (same before/after rule as repageGate — Jira's `add` reports nothing).
  // The 2nd attempt pages; the 3rd and every later one refuses with the same
  // payload and emits nothing.
  const alreadyBroken =
    epicLabels === null ||
    epicLabels.some((l) => GATE_LOOP_BROKEN_RE.test(String(l ?? "").trim().toLowerCase()));
  let newlyBroken = false;
  if (!alreadyBroken) {
    try {
      await addLabels({ ticket_id: parentId, labels: [GATE_LOOP_BROKEN_LABEL] });
      newlyBroken = true;
    } catch (err) {
      console.warn(`[agentcore-hub-jira] could not label epic ${parentId} — ${err?.name}`);
    }
  }

  const refusal = gateLoopRefusal({ gateKind, verdict, epicId: parentId });
  if (newlyBroken) {
    // `attempt` is the number of THIS attempt — priors + this one, so 2 at the
    // threshold. Not a counter of our own: nothing here is stateful enough to keep
    // one, and later attempts emit nothing at all.
    await publishJourneyEvent(eventsClient(), EVENTS_TABLE, gateWorkflowIdOf(epicLabels), "workflow.blocked", {
      reason: "environmental",
      gateKind,
      blockedByTicketId: refusal.payload.existingTicketId,
      head: head || "",
      // The binding that WAS the verdict, alongside `head` (TEAM-4986): a deploy
      // gate has no head, so without this the page cannot say what looped.
      exec: execId || "",
      attempt: verdict.priorCount + 1,
    });
  }
  const err = new Error(refusal.message);
  err.toolResult = { ...refusal.payload };
  return err;
}

/**
 * TEAM-5426: a review gets ONE design amendment. Runs only for a design-phase
 * review_fix; refuses the second one before anything reaches Jira. A failed
 * sibling scan REFUSES, the same fail direction as refuseGateLoop.
 */
async function refuseSecondDesignAmendment({ spawnedBy, phase, parentId }) {
  const self = { kind: spawnedBy?.kind || "", phase: phase || "", origin: spawnedBy?.gateTicketId || "" };
  if (!parentId || !TICKET_KEY_RE.test(String(parentId))) return null;
  if (self.kind !== "review_fix" || self.phase !== "design") return null;
  let siblings = [];
  try {
    siblings = await scanSiblingTickets(parentId);
  } catch (err) {
    console.warn(
      `[agentcore-hub-jira] design-amendment sibling scan failed for parent ${parentId} ` +
        `(REFUSING the create): ${err.message}`
    );
    return new Error(siblingScanRefusal(parentId, err.message));
  }
  const verdict = designAmendmentVerdict(siblings, self);
  if (!verdict.exhausted) return null;
  const refusal = designAmendmentRefusal({ verdict, origin: self.origin });
  console.warn(`[agentcore-hub-jira] ${refusal.payload.reason} under ${parentId}: prior ${refusal.payload.existingTicketId}`);
  const err = new Error(refusal.message);
  err.toolResult = { ...refusal.payload };
  return err;
}

/**
 * TEAM-5426 race repair: the check above is scan-then-create, so two concurrent
 * creates can both pass it. Re-scan AFTER the create; if an OLDER live amendment
 * for the same review exists (designAmendmentKeeper — every racer agrees which),
 * this one withdraws before its key is returned: its `fix:`/`origin:` labels are
 * removed (so neither side counts it as an amendment any more), it gains
 * `duplicate-of:<keeper>`, and it is closed — this workflow has no Cancelled
 * status. Done is a resolved blocker to the cascade, so first every ticket
 * already parked behind this one (amendmentDependents — its key is searchable
 * from the POST on) gets a "Blocks" link from the keeper: the Done can then
 * release nothing the keeper still holds. The caller gets the same
 * design_amendment_exhausted refusal naming the keeper.
 * Best-effort: a failed re-scan or re-link keeps the ticket (logged) — the
 * pre-create scan already refused every serial duplicate. Jira search is
 * eventually consistent, so two creates inside its index lag can still both
 * survive; that is the residual.
 *
 * TEAM-5727: the relabel PUT and the Done transition are two requests, and the
 * Done can fail (or its response can be lost) after the relabel has already
 * landed — the same defect class TEAM-5724 fixed for the park-claim label. A
 * Done that provably did NOT land is compensated: one best-effort PUT puts the
 * stripped `fix:`/`origin:` labels back and takes `duplicate-of:<keeper>` back
 * off, so a failed withdrawal leaves the ticket exactly as it was (open ticket,
 * original labels), never half-withdrawn. A Done whose RESPONSE was lost but
 * which a re-read shows actually landed is left alone and reported as withdrawn
 * — restoring labels on a ticket that is really Done would be wrong, and the
 * keeper is unaffected either way. If the re-read itself fails, that counts as
 * "not landed" (compensate): a stranded ticket is the worse of the two guesses.
 * The same reasoning covers the relabel PUT itself: a lost PUT response may
 * have applied, so compensation is attempted from the moment the PUT is sent,
 * not only once it is confirmed — the restore is additive/idempotent either way
 * (re-adding a present label or removing an absent one is a no-op on Jira's side).
 */
async function withdrawDuplicateAmendment({ ticketId, labels, spawnedBy, phase, parentId }) {
  const self = { ticketId, kind: spawnedBy?.kind || "", phase: phase || "", origin: spawnedBy?.gateTicketId || "" };
  if (!parentId || self.kind !== "review_fix" || self.phase !== "design") return null;
  let keeper = null;
  let relabelled = null; // { restore: [...], marker } once the relabel PUT has gone out
  try {
    const siblings = await scanSiblingTickets(parentId);
    keeper = designAmendmentKeeper(siblings, self);
    if (!keeper) return null;
    // Not linkBlockers: that one swallows a failed link, and a dependent left
    // blocked only by the loser is exactly what this must never produce.
    for (const dependent of amendmentDependents(siblings, ticketId, keeper)) {
      await jiraFetch("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({ type: { name: "Blocks" }, inwardIssue: { key: keeper }, outwardIssue: { key: dependent } }),
      });
    }
    const strip = (labels || []).filter((l) => /^(fix|origin):/i.test(String(l)));
    const marker = `duplicate-of:${keeper.toLowerCase()}`;
    // Set BEFORE the PUT goes out, not after it resolves: a lost response is
    // indistinguishable from a refusal, so from here on a throw must be treated
    // as "may have applied" — the catch below decides whether to undo it.
    relabelled = { restore: strip, marker };
    await jiraFetch(`/rest/api/3/issue/${ticketId}`, {
      method: "PUT",
      body: JSON.stringify({
        update: { labels: [...strip.map((remove) => ({ remove })), { add: marker }] },
      }),
    });
    await transitionTicket({
      ticket_id: ticketId,
      transition_id: "done",
      reason: `Withdrawn: a concurrent create filed a second design amendment; ${keeper} is the one amendment for this review.`,
    });
  } catch (err) {
    // TEAM-5727: the Done's own response didn't confirm it, so ask Jira directly
    // before deciding. Landed → the withdrawal is real despite the throw; fall
    // through to the same refusal the success path returns, labels left as
    // withdrawn. Not landed (or unreadable) → undo the relabel and keep the
    // ticket, same as every other best-effort failure of this function.
    if (relabelled) {
      if (await withdrawalLanded(ticketId)) {
        console.warn(`[agentcore-hub-jira] ${ticketId}: Done response did not confirm but a re-read shows it landed — treating as withdrawn: ${err.message}`);
      } else {
        await restoreWithdrawnLabels(ticketId, relabelled);
        console.warn(
          `[agentcore-hub-jira] design-amendment re-scan under ${parentId} failed for ${ticketId} ` +
            `(${keeper ? `older ${keeper} exists; ` : ""}keeping it): ${err.message}`
        );
        return null;
      }
    } else {
      console.warn(
        `[agentcore-hub-jira] design-amendment re-scan under ${parentId} failed for ${ticketId} ` +
          `(${keeper ? `older ${keeper} exists; ` : ""}keeping it): ${err.message}`
      );
      return null;
    }
  }
  const refusal = designAmendmentRefusal({ verdict: { priors: [keeper] }, origin: self.origin });
  console.warn(`[agentcore-hub-jira] ${refusal.payload.reason} under ${parentId}: ${ticketId} raced ${keeper} and was withdrawn`);
  const err = new Error(refusal.message);
  err.toolResult = { ...refusal.payload, withdrawnTicketId: ticketId };
  return err;
}

/**
 * A typed gate ticket must be USABLE by whoever — or whatever — will later have to
 * resolve it. A `gate:deploy-approval` must be bound to exactly one execution and one
 * pipeline and carry the console deep link, so the human it pages can act; a
 * `gate:ci-unavailable` must be bound to one pipeline and one 40-hex head, so the
 * close guard has something to probe (TEAM-4758 — an unbound one closed unproven).
 *
 * The label half is gateShapeRefusal() in gate-contract.mjs, so both twins refuse in
 * identical words. Only the PROBE half is here, and only deploy-approval has one:
 * `capabilities().approveDeploy` is a hardcoded `false` (DL-028: the deploy gate is
 * human-only, and no tool may approve it), so the link requirement always applies,
 * and the probe earns its keep as the only read that can tell us the `pipeline:`
 * label names a pipeline the hub is actually allowed to reach. A ci-unavailable gate
 * claims CI is down, so an unreachable probe would be no evidence either way.
 *
 * FAIL DIRECTION, again: an UNREACHABLE probe creates the ticket. Only a successful
 * read that reports the pipeline unregistered refuses.
 *
 * @returns {Promise<Error|null>}
 */
async function validateGateTicketShape({ labels, description }) {
  const list = Array.isArray(labels) ? labels : [];
  const refuse = (hint) => {
    const err = new Error(hint);
    err.toolResult = { ok: false, reason: GATE_CONDITION_UNMET, hint };
    return err;
  };

  const shape = gateShapeRefusal(list);
  if (shape) return refuse(shape.hint);

  if (!gateKindsOf(list).includes("deploy-approval")) return null;
  const pipeline = gatePipelineOf(list);

  const probe = await invokeProbe(PIPELINE_TOOLS_LAMBDA, "Pipeline___capabilities", {
    pipeline_name: pipeline,
  });
  if (!probe.ok) return null; // unreachable ⇒ create; never a wall
  const caps = probe.result || {};
  if (caps.ok === false) {
    return refuse(
      `pipeline "${pipeline}" is not one the hub may reach (${caps.reason || "pipeline_not_registered"}) — ` +
        `use a \`pipeline:\` label naming an entry in the CD registry`
    );
  }
  if (caps.approveDeploy === false && !descriptionCarriesConsoleLink(description, { pipeline, region: REGION })) {
    return refuse(
      `a deploy-approval gate with no approve capability must carry the console link: ` +
        consoleApprovalUrl({ pipeline, region: REGION })
    );
  }
  return null;
}

// ─── Status Mapping ──────────────────────────────────────────────────────────

// TEAM-5719: label prefix carrying a park's claim generation. Same literal as the
// orchestrator's PARK_CLAIM_LABEL (lambda/orchestrator/lease.mjs).
// TEAM-5729: the full shape is `park-claim:<generation>:<nonce>` — the nonce is this
// request's, and the orchestrator releases only when a changelog history carries it
// (historyMetadata.extraData.fenceNonce) into Blocked. The label is a POINTER to that
// evidence, never a credential on its own; lease.mjs parses it.
export const PARK_CLAIM_LABEL = "park-claim:";

const INTERNAL_TO_JIRA = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  // TEAM-5421: where a cancelled run's tickets go. Terminal — nothing leaves it,
  // and the hub's cancel route (not this tool) is the only thing that moves here.
  cancelled: "Won't Do",
};

const JIRA_TO_INTERNAL = {
  ...Object.fromEntries(Object.entries(INTERNAL_TO_JIRA).map(([k, v]) => [v.toLowerCase(), k])),
  "wont do": "cancelled",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export function mapStatusToInternal(jiraStatus) {
  const name = String(jiraStatus ?? "").trim().toLowerCase();
  return JIRA_TO_INTERNAL[name] || name.replace(/\s+/g, "_");
}

/** The transition INTO cancelled, picked by destination — transition names are per-workflow prose. */
export function findCancelTransition(transitions) {
  return (transitions || []).find((t) => mapStatusToInternal(t?.to?.name) === "cancelled") || null;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

async function jiraFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (resp.status === 204) return null;

  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!resp.ok) {
    // Surface EVERYTHING Jira says — errorMessages, field errors, or the raw
    // body. (A precedence bug here (`a || b ? x : y`) used to reduce real JQL
    // errors to "400: {}", leaving agents unable to self-correct queries.)
    const parts = [];
    if (Array.isArray(body?.errorMessages) && body.errorMessages.length) parts.push(body.errorMessages.join("; "));
    if (body?.errors && Object.keys(body.errors).length) parts.push(JSON.stringify(body.errors));
    const msg = parts.join(" | ") || (typeof body === "string" ? body : JSON.stringify(body));
    throw new Error(`Jira API ${resp.status}: ${msg}`);
  }
  return body;
}

async function jiraSearch(jql, fields = ["summary", "status", "labels", "assignee", "issuetype", "parent"], maxResults = 50) {
  const params = new URLSearchParams({ jql, fields: fields.join(","), maxResults: String(maxResults) });
  return jiraFetch(`/rest/api/3/search/jql?${params.toString()}`);
}

/**
 * TEAM-5168 (R2-05): the ONE paginated search. `/rest/api/3/search/jql` answers one
 * page of `maxResults` rows plus `isLast` and `nextPageToken`; a caller that reads
 * only the first page sees the OLDEST rows and nothing that says more exist. That is
 * how a follow-up filed as child #101 became invisible to the `[fu:<hash>]` dedupe
 * and was created twice.
 *
 * Follows every fresh `nextPageToken` (the same rule as the orchestrator's
 * getChildTicketsFromJira, src/lib/workflow/jira-search-paginate.ts and
 * scripts/backfill-workflow-tombstones.mjs), bounded by `maxPages`. Answers
 * `{ issues, complete, pages, truncatedReason? }`: `complete:false` means the loop
 * stopped short and the list is the oldest rows read so far — a caller must treat
 * that as "could not see everything", never as "nothing else exists".
 * TEAM-5174 (R3-02): a page that says `isLast:false` but carries no / an empty /
 * a repeated `nextPageToken` cannot be followed, so the loop STOPS, `complete:false`.
 * TEAM-5181 (R4-01): `isLast` is optional in the vendor schema; a fresh token with
 * isLast absent is followed, isLast:true is trusted even beside a token.
 * A page that fails throws (jiraFetch), so a partial list is never handed back as
 * if it were complete.
 */
export const SEARCH_MAX_PAGES = 10; // 1000 rows at 100/page: a bound, not a target
async function jiraSearchAll(jql, fields, { pageSize = 100, maxPages = SEARCH_MAX_PAGES } = {}) {
  const issues = [];
  let nextPageToken;
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ jql, fields: fields.join(","), maxResults: String(pageSize) });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const data = await jiraFetch(`/rest/api/3/search/jql?${params.toString()}`);
    issues.push(...(data?.issues || []));
    // TEAM-5181 (R4-01): Atlassian's OpenAPI does not require `isLast`, and
    // `nextPageToken` is null only on the last (or only) page — so a fresh token
    // means MORE PAGES even when isLast is absent. An explicit isLast:true wins
    // over a stray token (the combo contradicts the vendor contract; the flag is
    // the explicit signal). Same order as the orchestrator, searchJqlAll and the
    // tombstone backfill.
    if (data?.isLast === true) return { issues, complete: true, pages: page };
    const next = data?.nextPageToken;
    if (typeof next === "string" && next !== "") {
      if (next !== nextPageToken) { nextPageToken = next; continue; }
      console.warn(`[agentcore-hub-jira] search page ${page} repeats the previous nextPageToken - stopping with ${issues.length} rows, incomplete`);
      return { issues, complete: false, pages: page, truncatedReason: "repeated_token" };
    }
    if (data?.isLast === false) {
      // TEAM-5174 (R3-02): Jira says more rows exist but gave nothing to follow.
      // Stopping here is INCOMPLETE — never "nothing else exists".
      console.warn(`[agentcore-hub-jira] search page ${page} says isLast:false but carries no nextPageToken - stopping with ${issues.length} rows, incomplete`);
      return { issues, complete: false, pages: page, truncatedReason: "missing_token" };
    }
    return { issues, complete: true, pages: page }; // no isLast, no token: the only/last page
  }
  return { issues, complete: false, pages: maxPages, truncatedReason: "page_cap" };
}

/**
 * Why an incomplete jiraSearchAll answer stopped, as the clause a caller's warning
 * puts after "truncated". The page-cap wording is the TEAM-5168 one, unchanged; the
 * token cases (TEAM-5174) say which page could not be followed instead of claiming
 * the bound was hit.
 */
function truncationClause(search) {
  if (search.truncatedReason === "missing_token") return `at page ${search.pages} (isLast:false but no nextPageToken)`;
  if (search.truncatedReason === "repeated_token") return `at page ${search.pages} (a repeated nextPageToken)`;
  return `after ${SEARCH_MAX_PAGES} pages`;
}

/**
 * Resolve a human-review reviewer reference ("<email | display name | accountId>")
 * to a real Jira accountId so the gate ticket can be assigned to that person —
 * which makes Jira notify them natively. Returns null if no assignable user
 * matches (caller falls back to label-only). Matches against users assignable in
 * the project so we never assign someone who can't act on the ticket.
 */
async function resolveReviewerAccountId(ref) {
  if (!ref) return null;
  // Already an accountId (Jira account ids contain a ':' or are 24-hex)?
  if (ref.includes(":")) return ref;
  try {
    const q = encodeURIComponent(ref);
    const users = await jiraFetch(
      `/rest/api/3/user/assignable/search?project=${PROJECT_KEY}&query=${q}&maxResults=5`
    );
    if (!Array.isArray(users) || users.length === 0) return null;
    const lref = ref.toLowerCase();
    const exact = users.find(
      (u) => (u.emailAddress || "").toLowerCase() === lref ||
             (u.displayName || "").toLowerCase() === lref
    );
    return (exact || users[0]).accountId || null;
  } catch (err) {
    console.log(`[jira-tools] reviewer resolve failed for "${ref}": ${err.message}`);
    return null;
  }
}

/**
 * List human reviewers available in the project, each tagged with the Jira
 * project ROLES they hold (Designer, Developer, QA & CI, ...). Roles are the
 * domain mapping: the orchestrator filters this roster to a gate's phase so the
 * intake agent picks a real, domain-appropriate person. 100% API-driven — no
 * config of names. Returns [{ accountId, displayName, email, roles[] }].
 */
async function listReviewers(params = {}) {
  // 1. Assignable users in the project (only people who can actually own a ticket).
  const users = await jiraFetch(
    `/rest/api/3/user/assignable/search?project=${PROJECT_KEY}&maxResults=200`
  );
  const byId = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    if (u.accountType && u.accountType !== "atlassian") continue; // skip app/customer accts
    byId.set(u.accountId, {
      accountId: u.accountId,
      displayName: u.displayName,
      email: u.emailAddress || null,
      roles: [],
    });
  }

  // 2. Tag each user with the project roles they belong to (= their domains).
  try {
    const roleMap = await jiraFetch(`/rest/api/3/project/${PROJECT_KEY}/role`);
    for (const [roleName, roleUrl] of Object.entries(roleMap || {})) {
      const roleId = String(roleUrl).split("/").pop();
      try {
        const detail = await jiraFetch(`/rest/api/3/project/${PROJECT_KEY}/role/${roleId}`);
        for (const actor of detail.actors || []) {
          const accId = actor.actorUser?.accountId;
          if (accId && byId.has(accId)) byId.get(accId).roles.push(roleName);
        }
      } catch { /* skip unreadable role */ }
    }
  } catch (err) {
    console.log(`[jira-tools] role tagging failed: ${err.message}`);
  }

  let reviewers = [...byId.values()];

  // Optional role filter (orchestrator passes the gate's domain → e.g. "Designer").
  if (params.role) {
    const want = String(params.role).toLowerCase();
    reviewers = reviewers.filter((r) => r.roles.some((rn) => rn.toLowerCase().includes(want)));
  }
  return { reviewers };
}

// ─── Tool Implementations ────────────────────────────────────────────────────

/**
 * TEAM-4537: Jira hard-caps issue summary at 255 chars — a long auto-generated
 * title (self-improvement/feature runs paste the whole request) otherwise 400s
 * the create/update and the workflow dies at intake (wf_1789190697687_fxrs67).
 * Trims to a word boundary when that keeps at least 200 chars, so a title with
 * no whitespace near the cut still clamps instead of growing unbounded. The
 * full text always survives separately in the description — this only shortens
 * what Jira shows as the summary.
 *
 * Kept local rather than added to fix-contract.mjs — that module is byte-compared
 * across three copies by CI, and this clamp needs no cross-Lambda contract.
 */
export function clampSummary(s) {
  if (typeof s !== "string" || s.length <= 255) return s;
  let cut = s.slice(0, 254);
  // Slicing by UTF-16 code units can land inside a surrogate pair (emoji, astral
  // CJK) and leave a lone high surrogate — a visibly corrupted summary. Back up
  // one code unit so the cut always falls on a whole code point.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace >= 200 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trimEnd() + "…";
}

// ─── TEAM-4740 FR-12: base_branch (SEC-12) ───────────────────────────────────
//
// The branch this ticket's PR must target. A ticket filed mid-run with no branch
// identity inherits whatever branch its assignee happens to be on — and while a
// Merge Approval gate is open that is the integration branch the merge is about
// to supersede, so the work evaporates with it (run p5ogpg / TEAM-4663).
//
// Twins doctrine (TEAM-4131 F2): the REGEX and the refusal TEXT are byte-identical
// here and in lambda/agentcore-hub-tickets/index.mjs; only the DELIVERY differs
// (this twin throws, as every other createTicket refusal here does; the DynamoDB
// twin returns a textResult). src/lib/workflow/base-branch-parity.test.ts imports
// BOTH modules and fails if either drifts.
//
// The pattern is git check-ref-format reduced to what a branch NAME may be: no
// leading "-" (that is an argument, not a ref) or "/", no ".." / "//" / "@{"
// anywhere, no ".lock" suffix, no trailing "/" or ".", 1-120 chars drawn from
// [A-Za-z0-9._/-]. Lookbehind is fine — both twins run nodejs20.x.
export const BASE_BRANCH_RE =
  /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,120}(?<![/.])$/;

/** The refusal body. Byte-identical in both twins — pinned by the parity test. */
export function baseBranchRefusal(value) {
  return (
    `'base_branch' ${JSON.stringify(String(value ?? ""))} is not a valid branch name. ` +
    `Expected 1-120 characters from [A-Za-z0-9._/-], with no leading "-" or "/", no "..", ` +
    `"//" or "@{" anywhere, no ".lock" suffix and no trailing "/" or "." — e.g. "main" ` +
    `or "feature/TEAM-1234-thing".`
  );
}

/**
 * TEAM-4752 D1 — the create-time refusal when the open-gate sibling scan FAILS.
 *
 * Byte-identical in both twins, pinned by src/lib/workflow/sibling-scan-parity
 * .test.ts (output AND `.toString()` source), for the same reason
 * baseBranchRefusal is: an agent reads this string and has to be able to act on
 * it, and two providers disagreeing about the wording is how a persona learns to
 * pattern-match one of them.
 *
 * REFUSE rather than create: see the FAIL DIRECTION note on autowireOpenGate.
 */
export function siblingScanRefusal(parentKey, error) {
  return (
    `create_ticket refused: the sibling scan under ${parentKey} failed (${error}), so the ` +
    `open-gate freeze state is unknown and the ticket cannot be created safely. Nothing was ` +
    `created. Retry the call.`
  );
}

/**
 * The ONE machine-parseable line both twins append to a ticket's description.
 *
 * workflow-output's FR-5 refusal reads a ticket back through Tickets___get_issue,
 * which returns the description and neither a `baseBranch` field nor labels — so
 * the description line is the only carrier that survives BOTH providers. It is
 * emitted byte-identically here and in the DynamoDB twin, and BASE_BRANCH_LINE_RE
 * is the exact parser, exported so the parity test proves the line round-trips.
 * In this twin the line is its own ADF block, so adfToText puts it on its own
 * line — which is what the anchored regex needs.
 */
export function baseBranchLine(value) {
  return `base_branch: ${value}`;
}
export const BASE_BRANCH_LINE_RE = /^base_branch:\s*(\S+)\s*$/m;

/**
 * Validate at CREATE time. Absent/empty is NOT an error — it means "no branch
 * stated", and such a ticket is byte-identical to one filed before this feature.
 * A stated-but-invalid branch IS refused: silently dropping it would produce
 * exactly the ticket whose absence of a branch lost TEAM-4663.
 */
export function validateBaseBranch(base_branch) {
  const raw = typeof base_branch === "string" ? base_branch.trim() : "";
  if (!raw) return { ok: true, value: null };
  if (!BASE_BRANCH_RE.test(raw)) return { ok: false, value: null };
  return { ok: true, value: raw };
}

// ─── TEAM-5101: the child issue type follows the parent's issue type ─────────

/**
 * THE resolver for "which issue type may live under this parent" — every child
 * create goes through it, so no caller has to know Jira's hierarchy rule.
 *
 * Jira rejects both wrong pairings: a Subtask under an Epic, and a Task under a
 * standard issue (a Bug-rooted bug-fix run, where Jira answers 400 "Please select
 * valid parent issue"). `parentIssueType` is Jira's `fields.issuetype` object
 * (`{ name, subtask, hierarchyLevel }`) or null when the parent could not be read.
 *
 *   Epic-level parent (name epic, or hierarchyLevel >= 1): Subtask -> Task.
 *   Standard parent (Bug/Task/Story: named, not a subtask, level 0): Task -> Subtask.
 *   Unknown parent: Subtask -> Task (an orphan is worse than a Task); Task stays.
 *
 * Every other request is returned unchanged.
 */
export function resolveChildIssueType(requested, parentIssueType) {
  if (!parentIssueType) return requested === "Subtask" ? "Task" : requested;
  const name = String(parentIssueType.name || "").trim().toLowerCase();
  const level = parentIssueType.hierarchyLevel;
  const isEpicLevel = name === "epic" || (typeof level === "number" && level >= 1);
  if (isEpicLevel) return requested === "Subtask" ? "Task" : requested;
  const isStandard = !!name && parentIssueType.subtask !== true && (level === undefined || level === null || level === 0);
  if (isStandard && requested === "Task") return "Subtask";
  return requested;
}

/**
 * TEAM-5122: the create refusal when the parent's issue type cannot be read. A
 * Bug and an Epic take different child types, so a guess is a Jira 400 the caller
 * would read as permanent; refusing creates nothing and says "retry". The error
 * message LEADS with this token — workflow-output reads `payload.error` as the reason.
 */
export const PARENT_TYPE_UNREADABLE = "parent_type_unreadable";
/**
 * A definite answer about the parent (absent / forbidden / malformed) — the same set
 * workflow-output calls non-retryable. Everything else (5xx, 429, 401, network)
 * says nothing about the parent, so it is re-read once and then refused.
 */
const PARENT_READ_DEFINITE_RE = /^Jira API (400|403|404|422):/;

// ─── TEAM-4740 FR-5: freeze new work behind an open Merge Approval gate ──────

let eventsDdb = null;

/**
 * Stays LOCAL rather than becoming a thin wrapper over
 * gate-contract.mjs's publishJourneyEvent: EVENTS_TABLE here is read from
 * process.env at CALL time (below), not at module load — same shape as the
 * tickets twin, whose index.test.mjs FR-5 tests set/delete that env var
 * mid-test with no module reload to exercise both the on and off paths. A
 * module-load-time table name would go stale the moment the first such test ran.
 *
 * The autowired blocker edge, as a journey event. Same Item shape as
 * lambda/workflow-output/index.mjs publishJourneyEvent (copied deliberately, so
 * the two cannot drift into two event vocabularies) plus a `ttl` — the events
 * table has TTL enabled on that attribute (scripts/create-dynamodb-tables.sh),
 * and SEC-13 says a per-create write must not accumulate forever.
 *
 * Dark by default: neither twin's deploy env sets EVENTS_TABLE
 * (deploy/setup-tickets-lambda.mjs), so this is a no-op until an operator sets it
 * — the `autowired` field on the create response is the signal callers read.
 * Non-fatal in every direction: an event is never worth failing a create over.
 */
async function emitJourneyEvent(workflowId, type, detail) {
  const table = process.env.EVENTS_TABLE;
  if (!table || !workflowId) return;
  try {
    if (!eventsDdb) {
      eventsDdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    await eventsDdb.send(new PutCommand({
      TableName: table,
      Item: {
        workflowId,
        eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        detail,
        timestamp: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
      },
    }));
  } catch { /* non-fatal */ }
}

/** The banner. Byte-identical in both twins. */
function gateFreezeBanner(cdTicketId) {
  return (
    `DELIVERY CONSTRAINT: a Merge Approval gate is open on this run's integration ` +
    `branch, so this ticket is frozen behind the CD ticket ${cdTicketId}. Do NOT push ` +
    `to the integration branch — the merge is about to supersede it and your work would ` +
    `go with it. After the merge lands, deliver this work via your OWN pull request to main.`
  );
}

/**
 * An OPEN human Merge Approval gate, from a normalized sibling row: a human-owned
 * ticket (human-review / reviewer:*) that is a merge-approval gate (the label, or
 * the title the hub gives it) and is currently presented to a person (in_review).
 * Byte-identical predicate in both twins.
 */
function isOpenMergeGate(row) {
  const labels = row.labels || [];
  if (!labels.some((l) => l === "human-review" || l.startsWith("reviewer:"))) return false;
  const isMergeGate =
    labels.some((l) => MERGE_GATE_LABEL_RE.test(l)) || row.title.startsWith("Merge Approval");
  if (!isMergeGate) return false;
  return row.status === "in_review";
}

/** Terminal for freezing purposes: a finished CD ticket blocks nothing. */
function isSettled(status) {
  return status === "done" || status === "closed";
}

/**
 * Siblings under `parent_key`, normalized to the shape both twins' predicates
 * read. `parent` is interpolated into JQL, so it is shape-checked first (F6's
 * rule: never interpolate anything that has not been proved to be a ticket key) —
 * a bad key throws, and BOTH callers turn that into a refused create. Labels are
 * requested explicitly because the gate predicate is defined in terms of them.
 *
 * TEAM-4780: `issuelinks` is requested and `blockedBy` carried too, because
 * refuseGateLoop shares this scan and blocked_by overlap is one of the ways
 * gateLoopVerdict recognizes the same target. Additive — none of the freeze
 * predicates read it.
 *
 * TEAM-4986: `status` matters to that verdict too — an ANSWERED gate is never a
 * prior — so it stays mapped to the internal form here (`"Done"` → `done`), which
 * is what the shared contract's isSettledGateStatus() is written against.
 */
async function scanSiblingTickets(parentKey) {
  const key = String(parentKey || "");
  if (!TICKET_KEY_RE.test(key)) throw new Error(`not a ticket key: ${JSON.stringify(key)}`);
  // TEAM-5168: paged, not a single 50-row page — a prior gate or the open merge gate
  // filed as child #51+ used to be invisible here. The bound is a flag, not a
  // refusal: at 1000+ children the operator is told, and the create still proceeds
  // on what was read (strictly more than the silent cap before).
  const search = await jiraSearchAll(
    `parent = ${key} ORDER BY created ASC`,
    ["summary", "status", "labels", "assignee", "issuetype", "created", "issuelinks"]
  );
  if (!search.complete) {
    console.warn(
      `[agentcore-hub-jira] sibling scan under ${key} is INCOMPLETE: truncated ${truncationClause(search)} ` +
        `(${search.issues.length} tickets, oldest first) and Jira reports more - gate/root predicates run on a truncated roster`
    );
  }
  return (search.issues || []).map((iss) => {
    const labels = (iss.fields?.labels || []).map((l) => String(l));
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    const reviewerLabel = labels.find((l) => l.startsWith("reviewer:"));
    return {
      ticketId: String(iss.key || ""),
      title: String(iss.fields?.summary || ""),
      status: mapStatusToInternal(iss.fields?.status?.name || ""),
      labels,
      blockedBy: blockedByOfFields(iss.fields) || [],
      // This twin carries the assignee as a label; reconstruct the internal form
      // (`human:<who>` / `<agentId>`) so the shared predicates read identically.
      assignee: agentLabel
        ? agentLabel.slice("agent:".length)
        : reviewerLabel
          ? `human:${reviewerLabel.slice("reviewer:".length)}`
          : "",
      createdAt: String(iss.fields?.created || ""),
    };
  });
}

/**
 * FR-5 create half: while a Merge Approval gate is open on this run, a NEW agent
 * ticket is frozen behind the run's CD ticket instead of being handed a branch the
 * merge is about to supersede. Returns the blockers to use, the banner to prepend,
 * the `autowired` marker for the response, and the siblings it scanned —
 * `{ blockedBy, banner, autowired, siblings }` on every path, so the caller never
 * has to distinguish absent from unknown.
 *
 * FAIL DIRECTION — REFUSE THE CREATE (TEAM-4752 D1). It used to fail OPEN, on the
 * argument that an unfrozen ticket is recoverable while a ticket frozen behind a
 * blocker that does not exist never runs at all. The second half of that is still
 * true, which is why the fix is NOT "create it blocked" — a `blocked` ticket with
 * no blocker edge is a permanent wedge. But the first half was wrong: an unfrozen
 * ticket is dispatched immediately, onto a branch the open merge is about to
 * supersede, and that work is thrown away rather than recovered. So a scan failure
 * now returns `scanFailed` and createTicket refuses (see siblingScanRefusal) —
 * nothing is created, and the agent can simply retry.
 *
 * The refusal is confined to the path this autowire actually governs: a
 * `human:*` assignee and a parentless create return `untouched` above without ever
 * scanning, so both stay byte-for-byte as they were. Note the shape-check in
 * scanSiblingTickets throws for a non-key `parent`, and that now refuses too —
 * correctly: a parent we cannot even name is not a parent we can clear.
 *
 * `ticketIdIfKnown` exists so a caller that already has an id (a future
 * re-materialization path) cannot freeze a ticket behind itself; both twins mint
 * the id AFTER this seam, so today it is always null.
 */
async function autowireOpenGate({ parent_key, assignee, blocked_by, ticketIdIfKnown }) {
  const blockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
  // TEAM-4763 P2: `siblings` rides on every non-refusing return so the root-blocker
  // autowire below reuses THIS scan instead of issuing a second Query. The two
  // pre-scan returns carry `[]`, which is honest — nothing was looked at — and both
  // are cases the root autowire has to skip anyway (a parentless create has no
  // siblings to wait for; a human gate is never frozen behind delivery work), so no
  // path is left silently inert by the empty list.
  const untouched = { blockedBy: blockers, banner: "", autowired: null, siblings: [] };
  if (!parent_key) return untouched;
  // A human gate is never frozen behind delivery work — it IS the decision the
  // delivery work is waiting on, so freezing it would deadlock the run.
  if (typeof assignee === "string" && assignee.startsWith("human:")) return untouched;

  try {
    const siblings = await scanSiblingTickets(parent_key);
    // Every path below this line has looked, so every path below this line reports
    // what it saw — `untouched` would say "we never scanned".
    const scanned = { ...untouched, siblings };
    const gate = siblings.find(isOpenMergeGate);
    if (!gate) return scanned;

    // The CD ticket: the non-human sibling the ship-phase predicate claims, newest
    // first (a re-run files a second one and the latest is the live one).
    const candidates = [];
    for (const row of siblings) {
      if (row.ticketId === gate.ticketId) continue;
      if (ticketIdIfKnown && row.ticketId === ticketIdIfKnown) continue;
      if (row.assignee.startsWith("human:")) continue;
      if (await isShipPhaseTicket(row.labels)) candidates.push(row);
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const cd = candidates[0];
    if (!cd) return scanned;            // nothing to freeze behind
    if (isSettled(cd.status)) return scanned;
    if (blockers.includes(cd.ticketId)) return scanned;    // caller already ordered it

    return {
      blockedBy: [...blockers, cd.ticketId],
      banner: gateFreezeBanner(cd.ticketId),
      autowired: { reason: "open_gate", blockedBy: [cd.ticketId], gateTicketId: gate.ticketId },
      siblings,
    };
  } catch (err) {
    // TEAM-4752 D1: NOT `untouched` — that spelled "we looked and there is no
    // gate", which is the one thing we do not know here.
    console.warn(
      `[jira-tools] open-gate autowire scan failed for parent ${parent_key} ` +
      `(REFUSING the create): ${err.message}`
    );
    return { ...untouched, scanFailed: true, error: err.message };
  }
}

// ─── TEAM-4763 P2 (FR-11 seam 7b) — the root blocker, at MINT time ────────────
//
// Byte-identical in both twins, from here to the end of autowireRootBlocker. Edit
// the tickets copy, then mirror it into lambda/agentcore-hub-jira/index.mjs;
// src/lib/workflow/root-blocker-parity.test.ts fails if the two ever disagree — it
// compares both twins' OUTPUT over a shared roster matrix and both twins' SOURCE
// byte for byte, which is why these two pure helpers are exported at all.

/**
 * The run's ROOT ticket: the earliest-created non-human sibling under the epic — in
 * practice the analyst's own ticket, because the hub creates it first at run start.
 *
 * The same rule lambda/workflow-output/index.mjs findRootTicket applies at PLAN time
 * (same non-human filter, same localeCompare sort, same fail-to-null), and that is
 * the point: the two halves have to name the SAME ticket or a run's unblocked work
 * waits for different things depending on when it was filed. The plan-time half only
 * ever sees the batch an intake agent submitted in one call; this one sees every
 * ticket minted after it.
 */
export function findRootTicket(siblings) {
  const candidates = (siblings || []).filter((s) => !s.assignee.startsWith("human:"));
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (a.createdAt && b.createdAt ? String(a.createdAt).localeCompare(String(b.createdAt)) : 0));
  return sorted[0];
}

/**
 * FR-11 create half (seam 7b): a ticket minted mid-run that names NO blocker waits
 * for the run's root ticket instead of being dispatched the moment it lands.
 *
 * PURE — it consumes the siblings autowireOpenGate already scanned, so it costs no
 * extra Query and has no failure mode of its own. That also settles the fail
 * direction the ticket asked about: a scan that failed never reaches here, because
 * autowireOpenGate returns `scanFailed` and createTicket REFUSES the create above
 * (TEAM-4752 D1) rather than filing it unwired.
 *
 * Returns the same `{ blockedBy, banner, autowired }` shape as autowireOpenGate, and
 * no banner: the DELIVERY CONSTRAINT banner says "a merge is about to supersede your
 * branch", which is true of an open merge gate and of nothing else.
 *
 * Skipped, deliberately, when:
 *   - the caller named a blocker — it already stated the ordering it wants;
 *   - the assignee is `human:*` — a review gate is what work waits ON, not with;
 *   - nothing was scanned (a parentless create, or the run's very first ticket);
 *   - there is no non-human sibling, or the only one is this ticket itself;
 *   - THE ROOT IS ALREADY OVER. This one is not in the ticket and is load-bearing:
 *     by the time most mid-run tickets are minted the analyst's ticket is already
 *     done, and filing `blocked` behind a finished blocker is a PERMANENT wedge —
 *     nothing re-fires the unblock cascade for a ticket that was already over when
 *     the edge appeared, and RECONCILE_SWEEP_MODE is off by default. Same guard and
 *     same reasoning as autowireOpenGate's `isSettled(cd.status)` above, widened by
 *     the two statuses isSettled leaves out on purpose: cascade.mjs resolves a
 *     blocker on `done`/`cancelled` only, so a `skipped` root would wedge hardest of
 *     all. Without this guard the feature would wedge nearly every create it touched.
 */
export function autowireRootBlocker({ assignee, blockedBy, siblings, ticketIdIfKnown }) {
  const untouched = { blockedBy, banner: "", autowired: null };
  if (blockedBy.length > 0) return untouched;
  if (typeof assignee === "string" && assignee.startsWith("human:")) return untouched;
  if (!siblings || siblings.length === 0) return untouched;
  const root = findRootTicket(siblings);
  if (!root) return untouched;
  if (ticketIdIfKnown && root.ticketId === ticketIdIfKnown) return untouched;
  if (isSettled(root.status) || root.status === "skipped" || root.status === "cancelled") return untouched;

  return {
    blockedBy: [root.ticketId],
    banner: "",
    autowired: { reason: "no_root_blocker", rootTicketId: root.ticketId, blockedBy: [root.ticketId] },
  };
}

// TEAM-5712: `client_token` is read so the twins accept the same keys, and then
// deliberately ignored — idempotent create is the dynamodb twin's (an IDEMP#
// lock row); Jira has no conditional create, so a resend can still duplicate.
async function createTicket(params) {
  const { summary: rawSummary, description, parent_key, assignee, issue_type, blocked_by, workflow_id, spawned_by, fix_contract, phase, labels, base_branch, client_token: _clientTokenIgnored } = params;
  const summary = clampSummary(rawSummary);

  // TEAM-4121 FR-8: provenance + contract, validated BEFORE anything is created
  // in Jira so a rejected fix ticket leaves no partially-wired issue behind.
  const spawn = sanitizeSpawnedBy(spawned_by);
  if (spawn.error && FIX_TICKET_CONTRACT === "enforce") throw new Error(spawn.error);
  if (spawn.error) console.warn(`[jira-tools] ignoring spawned_by with unknown/invalid kind: ${JSON.stringify(spawned_by)} (${spawn.error})`);
  const fixKind = spawn.value ? spawn.value.kind : null;
  const originId = fixKind ? spawn.value[KIND_TO_ORIGIN_KEY[fixKind]] || null : null;

  // F7: `phase` used to be accepted and then silently DROPPED here, so a fix
  // ticket's phase stamp never reached the orchestrator in Jira mode and the
  // completion open-fix gate could not see it. Validate it against the same
  // config-derived set the DynamoDB Lambda uses, with the same message.
  const phaseStamp = typeof phase === "string" && phase.trim() ? phase.trim() : null;
  if (spawn.value && phaseStamp) {
    const validPhases = await loadValidPhases();
    if (!validPhases.has(phaseStamp)) {
      throw new Error(
        `'phase' "${phaseStamp}" is not a known workflow phase — a fix ticket ` +
        `with an unknown phase would be invisible to the completion open-fix gate. ` +
        `Valid phases: ${[...validPhases].sort().join(", ")}`
      );
    }
  }

  let contract = null;
  let contractIncomplete = false;
  if (spawn.value && FIX_TICKET_CONTRACT !== "off") {
    const fc = validateFixContract({ spawnedBy: spawn.value, ...(fix_contract || {}) });
    const detail = [
      fc.missing.length ? `missing: ${fc.missing.join(", ")}` : null,
      fc.invalid.length ? `invalid: ${fc.invalid.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    if (!fc.ok && FIX_TICKET_CONTRACT === "enforce") {
      const firstProblem = fc.missing[0] || fc.invalid[0];
      throw new Error(`'${firstProblem}' is required on a fix ticket (${detail})`);
    }
    if (!fc.ok) {
      contractIncomplete = true;
      console.warn(`[jira-tools] fix contract incomplete (shadow, accepting): ${detail}`);
    }
    contract = fc.contract;
  }

  // TEAM-4740 FR-12 (seam 5a): the stated base branch, validated BEFORE anything
  // is created in Jira — same discipline as the fix contract above, so a refused
  // ticket leaves no partially-wired issue behind. Absent/empty is not an error;
  // it just means no branch was stated.
  const baseBranchCheck = validateBaseBranch(base_branch);
  if (!baseBranchCheck.ok) throw new Error(baseBranchRefusal(base_branch));
  const baseBranch = baseBranchCheck.value;

  // Validate assignee against known roster — reject hallucinated agent names.
  // "human:<who>" assignees are human-review gates, not agents, and are always
  // allowed (the orchestrator parks them for a person instead of invoking).
  const isHumanReviewer = typeof assignee === "string" && assignee.startsWith("human:");
  if (assignee && !isHumanReviewer && !VALID_ASSIGNEES.has(assignee)) {
    const valid = [...VALID_ASSIGNEES].join(", ");
    throw new Error(
      `Invalid assignee "${assignee}". Valid agents: ${valid}. ` +
      `Note: There is NO "agentcore_hub_ios_dev" agent. ALL iOS/SwiftUI/Android/Web development goes to "agentcore_hub_frontend_dev".`
    );
  }

  // TEAM-4750 B3: an over-long `pipeline:` label is refused, not stored. It has to
  // be checked HERE — on the RAW label, before sanitizeUserLabels truncates it to
  // MAX_LABEL — because after truncation the label still matches PIPELINE_LABEL_RE
  // and names a DIFFERENT pipeline, which the gate would then be verified against.
  // Before the issue is created, so a refusal leaves nothing behind.
  const longPipelineLabel = pipelineLabelOverflow(labels);
  if (longPipelineLabel) {
    const refusal = pipelineLabelRefusal(longPipelineLabel);
    const err = new Error(refusal.hint);
    err.toolResult = refusal;
    throw err;
  }

  // TEAM-4739: hoisted from where the label list is assembled (it used to run just
  // before `issueLabels.push(...userLabels.labels)`). sanitizeUserLabels is PURE and
  // its result is still only consumed there, so this is a no-op reordering — but the
  // two gate seams below need the sanitized list, and they must run BEFORE the
  // idempotency guard: that guard fails open, and a refused gate ticket must be
  // refused whether or not the dedupe read succeeded.
  const userLabels = sanitizeUserLabels(labels, { spawnedBy: spawn.value, assignee });

  // Two gate seams, in order. An unreachable PROBE creates the ticket, and so does
  // an unreadable epic, for the same reason the → done guard admits on
  // indeterminate: a creation wall that trips whenever a read fails is a wedge.
  // A failed SIBLING SCAN is the exception (TEAM-4780): it is the loop verdict's
  // only evidence, and it is the same scan autowireOpenGate refuses on below.
  const loopRefusal = await refuseGateLoop({
    labels: userLabels.labels,
    blockedBy: blocked_by,
    parentId: parent_key,
  });
  if (loopRefusal) throw loopRefusal;
  // TEAM-5426: the one-shot design amendment (gate-contract.mjs).
  const amendmentRefusal = await refuseSecondDesignAmendment({
    spawnedBy: spawn.value,
    phase: phaseStamp,
    parentId: parent_key,
  });
  if (amendmentRefusal) throw amendmentRefusal;
  const shapeRefusal = await validateGateTicketShape({ labels: userLabels.labels, description });
  if (shapeRefusal) throw shapeRefusal;

  // TEAM-4740 FR-5 (seam 7b): while a Merge Approval gate is open on this run, new
  // agent work is frozen behind the CD ticket rather than pushed onto a branch the
  // merge is about to supersede. Runs AFTER the two gate seams above (TEAM-4739
  // owns this insertion point first).
  //
  // TEAM-4752 D1: an unreadable roster of siblings REFUSES the create — it no
  // longer files the ticket unfrozen, because "we could not look" is not evidence
  // that no gate is open. Refused BEFORE the idempotency guard and the create POST,
  // so nothing reaches Jira.
  let autowire = await autowireOpenGate({
    parent_key,
    assignee,
    blocked_by,
    ticketIdIfKnown: null,
  });
  if (autowire.scanFailed) throw new Error(siblingScanRefusal(parent_key, autowire.error));

  // TEAM-4763 P2 (FR-11 seam 7b): no gate froze this ticket and the caller named no
  // blocker, so it waits for the run's ROOT ticket rather than being dispatched into
  // a run whose first phase may still be running. Only when the open-gate half
  // produced nothing, so the two can never both fire; pure, and it reuses the
  // siblings that scan already returned. Reassigned rather than named separately
  // because every consumer below — `blockers`, the banner, the plan.autowired event
  // and the response key — is already generic over which autowire produced it.
  if (!autowire.autowired) {
    autowire = autowireRootBlocker({
      assignee,
      blockedBy: autowire.blockedBy,
      siblings: autowire.siblings,
      ticketIdIfKnown: null,
    });
  }

  // ─── Idempotency guard ───────────────────────────────────────────────────
  // create_ticket has no natural idempotency, so any repeat (a model retry, an
  // agentic-loop replay, a redelivered invocation) silently creates a full
  // duplicate ticket plan. Before creating, look for an existing ticket in the
  // same workflow with the same summary + assignee; if found, return it instead
  // of making a copy. Keyed on the wf:<id> label so it only dedupes within a run.
  // F6: `workflow_id` is interpolated into a JQL string literal, so it is
  // shape-checked (it is a hub-minted `wf_<ms>_<slug>` id, never free text) and
  // the summary is escaped backslash-first via the shared escapeJql. Escaping the
  // quote first would double-escape the backslashes the escape itself adds,
  // letting a summary containing `\"` terminate the literal and append JQL.
  if (workflow_id && !/^[A-Za-z0-9_-]+$/.test(String(workflow_id))) {
    throw new Error(`Invalid 'workflow_id' ${JSON.stringify(workflow_id)} — expected a hub workflow id (letters, digits, _ and - only)`);
  }
  if (workflow_id && summary) {
    try {
      // statusCategory != Done: resolved tickets are excluded SERVER-SIDE so a
      // live duplicate is never pushed out of the 5-result window by older
      // completed same-summary tickets (Codex P2 on #356). The isDoneStatus
      // check below stays as defense-in-depth for the returned page.
      const jql = `project = ${PROJECT_KEY} AND labels = "wf:${escapeJql(workflow_id)}" AND statusCategory != Done AND summary ~ "\\"${escapeJql(summary)}\\"" ORDER BY created ASC`;
      const existingSearch = await jiraSearch(jql, ["summary", "status", "labels", "assignee", "issuetype", "parent"], 5);
      const wantAgentLabel = assignee && !isHumanReviewer ? `agent:${assignee}` : null;
      const wantReviewerLabel = isHumanReviewer ? `reviewer:${assignee.slice("human:".length)}` : null;
      // Normalize so cosmetic rewordings of the SAME planned ticket dedupe:
      // trim, collapse internal whitespace, lowercase, drop a trailing period.
      // (A full re-plan with materially different titles is caught upstream by
      // the analyst's list-first/verify-after step, not here.)
      const normSummary = (s) =>
        (s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/\.$/, "");
      const wantSummary = normSummary(summary);
      // A same-summary ticket that is already Done/Closed must NOT be treated as
      // a duplicate. Escalation gates (e.g. "ship-review not converging") are
      // recreated on purpose; if we returned the prior, resolved gate its stale
      // "DECISION: continue" comment gets re-parsed and the round cap resets
      // forever without a fresh human decision. A terminal status → create anew.
      const isDoneStatus = (iss) => {
        const internal = mapStatusToInternal(iss.fields?.status?.name || "");
        return internal === "done" || internal === "closed" || internal === "cancelled";
      };
      const dup = (existingSearch.issues || []).find((iss) => {
        if (isDoneStatus(iss)) return false; // completed gate is not a live duplicate
        if (normSummary(iss.fields?.summary) !== wantSummary) return false; // summary ~ is fuzzy; require normalized-exact
        const labs = iss.fields?.labels || [];
        if (wantAgentLabel) return labs.includes(wantAgentLabel);
        if (wantReviewerLabel) return labs.includes(wantReviewerLabel);
        return true; // no assignee to disambiguate — same summary in same run is a dup
      });
      if (dup) {
        // The original invocation may have been interrupted after the issue was
        // created but before its blocker links + initial status were set. If we
        // returned the bare dup now, the orchestrator would see a ticket missing
        // the dependencies/state it relies on and could run or wedge it early.
        // Reconcile (idempotently) before returning.
        // TEAM-4740 FR-5: reconcile against the AUTOWIRED blockers, not the raw
        // arg. reconcileBlockersAndStatus derives the status from the list it is
        // handed, so passing the un-autowired list here would transition an
        // already-frozen duplicate to Ready and undo the freeze on every retry.
        await reconcileBlockersAndStatus(dup.key, autowire.blockedBy, assignee);
        console.log(`[jira-tools] IDEMPOTENT: "${summary}" (${assignee || "unassigned"}) already exists as ${dup.key} in ${workflow_id} — reconciled blockers/status, returning existing instead of duplicating.`);
        return { ...mapIssue(dup), deduplicated: true };
      }
    } catch (err) {
      // Never let the dedupe check block creation — fail open.
      console.warn(`[jira-tools] idempotency check failed (proceeding to create): ${err.message}`);
    }
  }
  // ─── End idempotency guard ─────────────────────────────────────────────────

  // Assignee is carried as a label (Jira's assignee field needs an accountId).
  // Human-review gates use a "reviewer:<who>" label + a "human-review" marker so
  // the orchestrator recognizes them and parks instead of invoking an agent.
  // (`issueLabels`, not `labels` — the latter is now a caller-supplied argument,
  // sanitized and appended at the end of this block.)
  const issueLabels = [];
  if (isHumanReviewer) {
    issueLabels.push("human-review");
    issueLabels.push(`reviewer:${assignee.slice("human:".length)}`);
  } else if (assignee) {
    issueLabels.push(`agent:${assignee}`);
  }
  if (workflow_id) issueLabels.push(`wf:${workflow_id}`);
  // TEAM-4113: agents stamp a fix ticket's origin as `spawned_by:{kind}`; the
  // DynamoDB tickets Lambda persists it, so mirror it here as a `fix:<kind>`
  // label. The orchestrator reconstructs `spawnedBy.kind` from this label
  // (mapJiraIssueToTicket) so the completion evidence gate + rework-loop cap
  // count agent-filed fixes in Jira mode the same as in DynamoDB mode.
  // TEAM-4121 FR-8: the rest of the contract rides along as labels — `origin:`
  // (lineage), `evidence:` (how the author knows), `phase:` (F7, what the
  // completion gate reads), and `contract:incomplete` when shadow mode let a
  // partial contract through. Jira mode has no place to persist a structured
  // record, so the labels ARE the index; the block in the description is the
  // human/agent-readable copy.
  //
  // `fix:<kind>` and `phase:<p>` are emitted regardless of FIX_TICKET_CONTRACT:
  // the first is pre-existing behavior and the second is the F7 defect fix (a
  // dropped phase stamp is a completion-gate hole with or without contracts).
  // The contract INDEX labels — origin:/evidence:/contract:incomplete — appear
  // only when the flag is on, so mode=off adds no new FR-8 surface to Jira.
  if (fixKind) {
    const contractOn = FIX_TICKET_CONTRACT !== "off";
    issueLabels.push(...contractLabels(contractOn ? contract : null, {
      kind: fixKind,
      originId: contractOn ? originId : null,
      phase: phaseStamp,
      incomplete: contractIncomplete,
    }));
  } else if (phaseStamp) {
    // A non-fix ticket may still carry a phase stamp; it just isn't validated
    // above (only fix tickets are gated on the known-phase set).
    issueLabels.push(`phase:${phaseStamp}`);
  }
  // Caller-supplied labels last, and only after the system namespaces are
  // stripped out of them — an agent must not be able to forge `fix:`/`wf:`.
  // TEAM-4131 F2: `advisory` is likewise refused on a fix ticket / human gate —
  // the twins must reach the same decision, or the hole just moves provider.
  issueLabels.push(...userLabels.labels);
  if (userLabels.dropped.length > 0) {
    console.warn(`[jira-tools] dropped ${userLabels.dropped.length} label(s) squatting a system namespace: ${userLabels.dropped.join(", ")}`);
  }

  // Normalize common LLM variations of issue type names to Jira's canonical form
  const ISSUE_TYPE_ALIASES = {
    "subtask": "Subtask",
    "sub-task": "Subtask",
    "sub task": "Subtask",
    "task": "Task",
    "story": "Story",
    "epic": "Epic",
    "bug": "Bug",
  };
  const requestedType = (issue_type || "Task").toString().trim();
  let canonicalType = ISSUE_TYPE_ALIASES[requestedType.toLowerCase()] || requestedType;

  // Jira forbids a Subtask whose parent is an Epic (subtasks may only live under
  // standard issue types). Intake agents plan phase tickets as children of the
  // run's Epic, so a Subtask request there is always invalid — Jira 400s it, the
  // agent then retries WITHOUT a parent, and the resulting orphan is invisible to
  // both the orchestrator's epic->children unblock cascade and the nudge/unstick
  // tool, wedging the whole run. Coerce Subtask->Task when the parent is an Epic
  // so the ticket is created correctly as an Epic child on the first try.
  // TEAM-5101: and the reverse — a Task under a Bug (a bug-fix run's root) is
  // just as invalid, so it becomes a Subtask. resolveChildIssueType owns the rule.
  // TEAM-5122: a read standard parent takes ONLY a Subtask (requested or converted).
  let subtaskOnly = false;
  if ((canonicalType === "Subtask" || canonicalType === "Task") && parent_key) {
    const requested = canonicalType;
    let parentIssueType = null;
    let readErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const parent = await jiraFetch(`/rest/api/3/issue/${parent_key}?fields=issuetype`);
        parentIssueType = parent?.fields?.issuetype || null;
        readErr = null;
        break;
      } catch (err) {
        readErr = err;
        if (PARENT_READ_DEFINITE_RE.test(err.message || "")) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, Number(process.env.JIRA_PARENT_READ_RETRY_MS ?? 250)));
      }
    }
    if (readErr && !PARENT_READ_DEFINITE_RE.test(readErr.message || "")) {
      const err = new Error(`${PARENT_TYPE_UNREADABLE}: could not read parent ${parent_key}'s issue type (${readErr.message}); nothing was created. Retry the call.`);
      err.toolResult = { ok: false, reason: PARENT_TYPE_UNREADABLE, hint: "transient Jira read failure - retry the same call" };
      throw err;
    }
    if (readErr) {
      console.warn(`[jira-tools] could not read parent ${parent_key} issuetype (${readErr.message})${requested === "Subtask" ? "; coercing Subtask -> Task to avoid orphaning." : "."}`);
    }
    canonicalType = resolveChildIssueType(requested, parentIssueType);
    // The resolver is the oracle for "standard parent": it turns a Task into a Subtask there.
    subtaskOnly = !!parentIssueType && resolveChildIssueType("Task", parentIssueType) === "Subtask";
    if (parentIssueType && requested === "Subtask" && canonicalType === "Task") {
      console.log(`[jira-tools] parent ${parent_key} is an Epic — coercing Subtask -> Task (Jira forbids subtask-of-Epic) so the child isn't orphaned.`);
    }
    if (requested === "Task" && canonicalType === "Subtask") {
      console.log(`[jira-tools] parent ${parent_key} is a ${parentIssueType.name} — coercing Task -> Subtask (Jira only accepts sub-tasks under a standard issue).`);
    }
  }

  const fields = {
    project: { key: PROJECT_KEY },
    summary,
    issuetype: { name: canonicalType },
    labels: issueLabels,
  };

  // Human-review gate: assign the ticket to a REAL Jira user so they're notified
  // natively. The reviewer:<who> label still drives the orchestrator/UI; this
  // additionally sets Jira's assignee field when <who> resolves to a project
  // user. Unresolvable → label-only (no hard failure).
  if (isHumanReviewer) {
    const reviewerRef = assignee.slice("human:".length);
    const accountId = await resolveReviewerAccountId(reviewerRef);
    if (accountId) {
      fields.assignee = { accountId };
      console.log(`[jira-tools] review gate assigned to ${reviewerRef} (${accountId})`);
    } else {
      console.log(`[jira-tools] reviewer "${reviewerRef}" not assignable in ${PROJECT_KEY} — label-only`);
    }
  }

  // TEAM-4121 FR-8: when a contract exists, it leads the description as a yaml
  // codeBlock. A codeBlock (not a paragraph) because the block is line-oriented
  // and Jira must not reflow it — and because adfToText treats codeBlock as a
  // block node, so the flattened text is the block verbatim followed by "\n" and
  // then the prose, which is exactly what parseFixContractBlock expects
  // (contract first, `rest` = the prose). The dedupe path above returns the
  // existing issue untouched, so a retried create never re-prepends a second
  // block onto a description that already has one.
  const contractBlock = contract
    ? renderFixContractBlock(contract, { kind: fixKind, originId, phase: phaseStamp })
    : null;
  // TEAM-4740 FR-5/FR-12: the delivery banner leads the prose (it changes what the
  // assignee must DO) and the machine-parseable base_branch line trails it, each as
  // its OWN ADF block — adfToText separates block nodes with "\n", which is what
  // BASE_BRANCH_LINE_RE anchors on. Both are omitted entirely when absent, so an
  // ordinary ticket's description is byte-identical to before. The contract block
  // still comes first: parseFixContractBlock expects contract-then-prose.
  const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const bannerBlocks = autowire.banner ? [para(autowire.banner)] : [];
  const baseBranchBlocks = baseBranch ? [para(baseBranchLine(baseBranch))] : [];
  if (contractBlock) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [
        { type: "codeBlock", attrs: { language: "yaml" }, content: [{ type: "text", text: contractBlock }] },
        ...bannerBlocks,
        para(description || ""),
        ...baseBranchBlocks,
      ],
    };
  } else if (description || bannerBlocks.length > 0 || baseBranchBlocks.length > 0) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [
        ...bannerBlocks,
        ...(description ? [para(description)] : []),
        ...baseBranchBlocks,
      ],
    };
  }

  if (parent_key) {
    fields.parent = { key: parent_key };
  }

  // 1. Create in Jira. If the type/parent combo is still rejected, retry ONCE as
  // a Task while KEEPING the parent — never drop the parent, since an orphaned
  // ticket silently breaks the unblock cascade. Only drop the parent as a last
  // resort if even the parented Task is refused.
  let created;
  try {
    created = await jiraFetch("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    const isTypeParentErr = /issuetype|parent|subtask|hierarchy/i.test(err.message || "");
    // TEAM-5101/5122: under a parent read as standard (Bug/Story/Task) a Subtask —
    // requested or converted — is the only valid type; the Task retry is known-invalid
    // and would end at the parentless last resort, an orphan the caller would count
    // as created. Refuse instead.
    if (!isTypeParentErr || fields.issuetype.name === "Task" || subtaskOnly) throw err;
    console.warn(`[jira-tools] create failed (${err.message}); retrying as Task with parent ${parent_key} kept.`);
    fields.issuetype = { name: "Task" };
    try {
      created = await jiraFetch("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
    } catch (err2) {
      console.error(`[jira-tools] parented Task retry also failed (${err2.message}); creating parentless as last resort — this ticket will need manual linking.`);
      delete fields.parent;
      created = await jiraFetch("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
    }
  }

  const ticketId = created.key;

  // 2 + 3. Link blockers and set the initial status. Shared with the dedup path
  // so an interrupted-then-retried create still ends up fully wired.
  // TEAM-4740 FR-5: the caller's blockers PLUS the autowired CD edge. The
  // Array/scalar normalization happens once, inside autowireOpenGate, so the frozen
  // and unfrozen paths cannot disagree about the shape.
  const blockers = autowire.blockedBy;
  const status = await reconcileBlockersAndStatus(ticketId, blockers, assignee);

  const raced = await withdrawDuplicateAmendment({
    ticketId, labels: issueLabels, spawnedBy: spawn.value, phase: phaseStamp, parentId: parent_key,
  });
  if (raced) throw raced;

  // TEAM-4740 FR-5: audit the autowired edge — after the create, so the event never
  // describes a ticket that does not exist. Dark unless EVENTS_TABLE is set.
  if (autowire.autowired) {
    await emitJourneyEvent(workflow_id, "plan.autowired", {
      ticketId,
      ...autowire.autowired,
    });
  }

  console.log(`[jira-tools] Created ${ticketId} in Jira. Status: ${status}`);
  return {
    ticketId,
    status,
    message: `Created ${ticketId}: ${summary}`,
    // TEAM-4740 FR-12/FR-5: what was recorded and what it was frozen behind. Both
    // absent entirely when unset, so an ordinary create's response is unchanged.
    ...(baseBranch ? { base_branch: baseBranch } : {}),
    ...(autowire.autowired ? { autowired: autowire.autowired } : {}),
  };
}

// Bring a ticket to its intended blocker-links + initial status. Idempotent:
// safe to call on a freshly created ticket OR on one found via the dedup path
// whose original setup may have been interrupted. Jira issue links dedupe by
// (type, pair), and re-issuing a transition to the current status is a no-op,
// so repeated calls converge without side effects.
//   - blockers present → link each + transition to "Blocked" (prevents a
//     premature "Ready" webhook before dependencies are done)
//   - no blockers + has assignee → transition to "Ready" (tells orchestrator to
//     invoke)
// One "Blocks" issue link per blocker key (blocker → ticket). Additive: Jira
// keeps a single link per (type, pair), so re-linking an existing blocker is a
// logged 4xx, never a duplicate and never fatal. Shared by create_ticket
// (creation-time blockers) and transition_ticket's blocked_by (DL-024 agent
// self-park).
async function linkBlockers(ticketId, blockers) {
  for (const blockerKey of blockers) {
    try {
      await jiraFetch("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({
          type: { name: "Blocks" },
          inwardIssue: { key: blockerKey },
          outwardIssue: { key: ticketId },
        }),
      });
    } catch (err) {
      console.log(`Warning: could not link blocker ${blockerKey} -> ${ticketId}: ${err.message}`);
    }
  }
}

async function reconcileBlockersAndStatus(ticketId, blockers, assignee) {
  await linkBlockers(ticketId, blockers);

  const status = blockers.length > 0 ? "blocked" : "todo";
  if (blockers.length > 0) {
    try {
      const transitions = await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`);
      const blockedTransition = transitions.transitions.find(
        (t) => t.name.toLowerCase() === "blocked" || t.to.name.toLowerCase() === "blocked"
      );
      if (blockedTransition) {
        await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: blockedTransition.id } }),
        });
      } else {
        console.warn(`[jira-tools] No "Blocked" transition available for ${ticketId} — ticket stays in To Do. Orchestrator blockedBy guard will prevent premature invocation.`);
      }
    } catch (err) {
      console.warn(`[jira-tools] Could not transition ${ticketId} to Blocked: ${err.message}`);
    }
  } else if (assignee) {
    try {
      const transitions = await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`);
      const readyTransition = transitions.transitions.find(
        (t) => t.name.toLowerCase() === "ready" || t.to.name.toLowerCase() === "ready"
      );
      if (readyTransition) {
        await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: readyTransition.id } }),
        });
      }
    } catch (err) {
      console.log(`[jira-tools] Could not transition ${ticketId} to Ready: ${err.message}`);
    }
  }
  return status;
}

async function transitionTicket(params) {
  const { ticket_id, transition_id, reason, blocked_by, expected_status, claim_started_at, workflow_id } = params;
  // TEAM-5707: optional source-status precondition (the harness park sends
  // in_progress). Jira has no conditional transition, so this is best-effort: checked
  // on the first read (before any comment or link), re-read right before the POST,
  // and (TEAM-5721) read back from the changelog after it — a move that did not start
  // from expected_status is REFUSED and left where it landed (TEAM-5732: never undone;
  // see verifyExpectedSource). A refusal at the re-read can leave the reason comment
  // and blocker links written.
  // TEAM-5723: the read-back finds OUR move by a per-request nonce the POST carries in
  // `historyMetadata`, never by "newest move into the target". (TEAM-5729: the nonce is
  // minted with the park-claim label below — a park is stamped even when unfenced.)
  const expectedStatus = String(expected_status || "").trim().toLowerCase() || null;
  const checkPrecondition = (issue) => {
    const actual = mapStatusToInternal(issue?.fields?.status?.name);
    if (expectedStatus && actual !== expectedStatus) {
      throw new Error(`Status precondition failed: ${ticket_id} is ${actual}, expected ${expectedStatus} — not transitioned.`);
    }
  };
  // The re-read right before a transition POST — the first one, and (TEAM-5711)
  // the labels-screen fallback's second one, which used to go out unchecked.
  // TEAM-5716: set below for a claim-stamped park when WORKFLOWS_TABLE is configured.
  let claimFence = null;
  const recheckPrecondition = async () => {
    if (expectedStatus) checkPrecondition(await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=status`));
    if (claimFence) await checkClaim(ticket_id, claimFence);
  };
  // DL-024: an agent parks ITS OWN ticket behind the tickets it just filed.
  // Normalize CSV / array / single key; validate shape so a stray string can't
  // become a bogus issue-link call.
  const rawBlockers = Array.isArray(blocked_by)
    ? blocked_by
    : typeof blocked_by === "string" && blocked_by.trim()
    ? blocked_by.split(",")
    : [];
  const blockers = [...new Set(rawBlockers.map((b) => String(b).trim()).filter(Boolean))];
  const badBlocker = blockers.find((b) => !TICKET_KEY_RE.test(b));
  if (badBlocker) {
    throw new Error(`Invalid blocked_by entry ${JSON.stringify(badBlocker)} — expected an issue key like ${PROJECT_KEY}-123`);
  }

  const targetStatus = transition_id;
  const jiraStatusName = INTERNAL_TO_JIRA[targetStatus] || targetStatus;

  // Handle "skip" as transition to Done
  const isSkip = targetStatus === "skip";
  const effectiveStatus = isSkip ? "Done" : jiraStatusName;

  // TEAM-5421: cancelled is terminal and a done ticket is never cancelled. Read
  // first so a refused move leaves no comment, link or transition behind.
  const targetInternal = isSkip ? "done" : mapStatusToInternal(jiraStatusName);
  const current = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=status`);
  checkPrecondition(current);
  const terminal = terminalMoveRefusal(mapStatusToInternal(current?.fields?.status?.name), targetInternal);
  if (terminal) throw new Error(`Cannot move ${ticket_id} to ${targetInternal}: ${terminal}`);
  if (targetInternal === "cancelled") {
    throw new Error(`Cannot move ${ticket_id} to cancelled: only the hub's workflow cancel does that`);
  }

  // in_review is reserved for human-review-gate tickets (reviewer:<who> label).
  // An agent ticket parked there is never invoked → the workflow stalls. Reject.
  if (jiraStatusName.toLowerCase() === "in review") {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=labels`);
    const labels = issue?.fields?.labels || [];
    if (!labels.some((l) => l.startsWith("reviewer:"))) {
      throw new Error(`Cannot move ${ticket_id} to In Review: only human-review tickets can be sent to review.`);
    }
  }

  // TEAM-4706 (DL-030) + TEAM-4739: a ship-phase ticket cannot reach Done without
  // its completion record, and a typed GATE ticket cannot reach Done against a probe
  // read that contradicts the close. Placed before the reason comment and the blocker
  // links so a refused transition leaves NO trace in Jira. `effectiveStatus` (not the
  // raw transition_id) is what is tested, so a "skip" — which resolves to Done, and
  // is how a Blocked ticket reaches Done at all — cannot walk around either gate.
  // Labels carry the phase, the assignee AND the gate bindings in Jira mode, so one
  // read answers every half of the predicate; `description` rides along for the
  // advisory DECISION line. With ARTIFACT_BUCKET set every Done costs one S3 GetObject
  // of its completion record (TEAM-5832: the brief hold is read for every ticket).
  let gateVerification = null;
  let gateLabels = [];
  const admitted = {};
  if (effectiveStatus.toLowerCase() === "done") {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=labels,description`);
    gateLabels = issue?.fields?.labels || [];
    gateVerification = await gateConditionCleared(
      ticket_id,
      gateLabels,
      adfToText(issue?.fields?.description),
      admitted
    );
  }

  // Add the reason as a comment BEFORE the transition. The transition fires the
  // status webhook → orchestrator rejection handler reads the latest comment;
  // commenting first avoids a race where rework starts before the feedback lands.
  if (reason) {
    await addComment({ ticket_id, comment: isSkip ? `Skipped: ${reason}` : reason });
  }

  // Link the new blockers BEFORE the transition so the Blocked webhook the
  // orchestrator receives already carries the issuelinks it maps to blockedBy
  // (its claim release on agent self-park keys off "own blockers still open").
  // Then VERIFY every requested blocker is really an inward "Blocks" link
  // (Codex review on #452): linkBlockers logs-and-continues on a 4xx, which is
  // right for a duplicate link but would otherwise park the ticket Blocked with
  // no edge — a state nothing can cascade out of. A missing link aborts the
  // transition so the agent sees the error and can fix the key.
  if (blockers.length > 0) {
    await linkBlockers(ticket_id, blockers);
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=issuelinks`);
    const linked = new Set(
      (issue?.fields?.issuelinks || [])
        .filter((l) => l?.type?.name === "Blocks" && l.inwardIssue?.key)
        .map((l) => l.inwardIssue.key)
    );
    const missing = blockers.filter((b) => !linked.has(b));
    if (missing.length > 0) {
      throw new Error(
        `blocked_by: could not link ${missing.join(", ")} as blocker(s) of ${ticket_id} — ` +
        `ticket NOT transitioned. Check the key(s) exist and retry.`
      );
    }
  }

  // Transition in Jira
  const data = await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`);
  const match = data.transitions.find(
    (t) => t.name.toLowerCase() === effectiveStatus.toLowerCase() ||
           t.to.name.toLowerCase() === effectiveStatus.toLowerCase()
  );

  if (!match) {
    const available = data.transitions.map((t) => `${t.name} (-> ${t.to.name})`).join(", ");
    throw new Error(`No transition to "${effectiveStatus}" found. Available: ${available}`);
  }
  // TEAM-5719: a park of the invoking agent's own ticket carries its claim generation
  // as a `park-claim:<startedAt>:<nonce>` label (other generations' labels come off), so
  // the orchestrator releases only that claim. On the labelled POST it rides the
  // transition atomically; in the TEAM-4908 fallback it goes out in its own PUT first.
  // TEAM-5729 (R3-2 / R3-3): the label is a POINTER, not a credential. ONE nonce per
  // request serves both the TEAM-5723 fence and the label, and every transition POST of
  // the request carries it in historyMetadata — fenced or not — so the orchestrator
  // (lease.mjs parkGeneration) releases only on the changelog history Jira wrote for
  // OUR move. A label left behind by a failed POST (R3-2) has no such history and is
  // inert. Strip-prior spares same-generation siblings: an overlapping retry of this
  // park (R3-3) must not delete the label of the attempt that lands, and a sibling with
  // no history of its own can confirm nothing.
  // TEAM-5724: once the first POST has gone out, ANY throw before the move is verified
  // takes OUR label back off (removeParkClaimLabel) — hygiene now, not the safety line.
  const claimStartedAt = typeof claim_started_at === "string" ? claim_started_at.trim() : "";
  const isParkClaim = targetInternal === "blocked" && /^\S{1,200}$/.test(claimStartedAt);
  const fenceNonce = expectedStatus || isParkClaim ? randomUUID() : null;
  const parkClaimLabel = isParkClaim ? `${PARK_CLAIM_LABEL}${claimStartedAt}:${fenceNonce}` : null;
  const parkLabelOps = [];
  if (parkClaimLabel) {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=labels`);
    const sameGeneration = `${PARK_CLAIM_LABEL}${claimStartedAt}:`;
    for (const l of issue?.fields?.labels || []) if (String(l).startsWith(PARK_CLAIM_LABEL) && !String(l).startsWith(sameGeneration)) parkLabelOps.push({ remove: l });
    // Accepted residual: labels are not cleared on other moves (board moves bypass this Lambda); a stale one has no changelog history to confirm it.
    parkLabelOps.push({ add: parkClaimLabel });
    // TEAM-5716: fence the park on its claim generation (see checkClaim). The run is
    // the ticket's own `wf:` label; the dispatch-supplied workflow_id only fills a
    // ticket without one (it resolves via its epic). A mismatch or neither refuses.
    if (workflowsDdb) {
      const own = gateWorkflowIdOf(issue?.fields?.labels);
      const sent = typeof workflow_id === "string" ? workflow_id.trim() : "";
      if ((own && sent && own !== sent) || (!own && !sent)) {
        throw new Error(`Status precondition failed: ${ticket_id} claim generation unverifiable (workflow ${own || "none"} vs dispatch ${sent || "none"}), expected ${claimStartedAt} — not transitioned.`);
      }
      claimFence = { workflowId: own || sent, gen: claimStartedAt };
    }
  }
  await recheckPrecondition();
  // TEAM-5941: the Done-intent fence — the LAST awaited step before the transition POST
  // (everything between here and the POST is synchronous). The labels-screen fallback
  // below runs after it and needs no second fence: the intent is already on the record.
  if (effectiveStatus.toLowerCase() === "done") await fenceDoneIntent(ticket_id, admitted);

  // TEAM-4739: the verification stamp rides in the SAME request as the transition —
  // `POST /transitions` accepts `update.labels` alongside `transition` — so a gate
  // close can never be recorded without the verdict that admitted it, and
  // `gate:awaiting-console` comes off in the same call rather than in an adjacent one
  // that could be lost.
  const labelOps = [...(gateVerification ? planGateLabelOps(gateLabels, gateVerification) : []), ...parkLabelOps];
  const transitionBody = (withLabels) => JSON.stringify({
    transition: { id: match.id },
    ...(withLabels && labelOps.length ? { update: { labels: labelOps } } : {}),
    ...(fenceNonce ? { historyMetadata: fenceHistoryMetadata(fenceNonce, expectedStatus) } : {}),
  });
  const finalStatus = isSkip ? "done" : mapStatusToInternal(match.to.name);
  try {
    try {
      await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, { method: "POST", body: transitionBody(true) });
    } catch (err) {
      // TEAM-4908: a team-managed workflow whose transitions have no SCREEN rejects
      // `update.labels` on POST /transitions with 400 "Field 'labels' cannot be set.
      // It is not on the appropriate screen, or unknown." — while the same field IS
      // on the edit screen (editmeta lists it). Every human ✅ on a verified gate
      // 409'd for a day (2026-09-21). Fallback keeps the TEAM-4739 invariant "no
      // close without its stamp" the other way round: stamp through the edit
      // endpoint FIRST, then transition without labels. A gate stamp with no close is
      // recoverable (re-approve); a close with no stamp is not. The park-claim label
      // is the exception: TEAM-5724 takes it back off (outer catch).
      if (!(labelOps.length && isLabelsScreenRefusal(err))) throw err;
      console.warn(`[jira-tools] ${ticket_id}: transition screen has no labels field — stamping via PUT /issue, then transitioning without labels`);
      await jiraFetch(`/rest/api/3/issue/${ticket_id}`, { method: "PUT", body: JSON.stringify({ update: { labels: labelOps } }) });
      // TEAM-5711: the PUT is one more round-trip the status can move in. Re-check
      // before the second POST exactly as before the first; a refusal here leaves
      // the gate stamp with no close — the recoverable half, by the TEAM-4908
      // reasoning — and (TEAM-5724) the park-claim label removed again.
      await recheckPrecondition();
      await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, { method: "POST", body: transitionBody(false) });
    }
    if (expectedStatus) await verifyExpectedSource(ticket_id, expectedStatus, finalStatus, fenceNonce);
    // TEAM-5716: Jira has no conditional write, so the claim can still move between the
    // pre-POST read and Jira applying the POST. Detect it, say so on the ticket, and
    // refuse; the park is left where it landed (TEAM-5732: never undone) and the outer
    // catch takes our park-claim label off, so it is never attributed to the new claim.
    // TEAM-5785: this read can also THROW (transient DynamoDB error) rather than report
    // a moved claim — that is unknown, not moved. The park already landed, so it is kept:
    // log and move on, instead of falling into the outer catch's label removal.
    if (claimFence) {
      try {
        await checkClaim(ticket_id, claimFence);
      } catch (moved) {
        if (!moved.claimNow) {
          console.warn(`[jira-tools] ${ticket_id}: post-POST claim read failed, generation unknown — park kept: ${moved.message}`);
        } else {
          await addComment({ ticket_id, comment: `Fenced: parked by a stale invocation (claim ${claimFence.gen}); ${moved.claimNow} holds the claim now — left for a human.` });
          throw new Error(`Status precondition failed: ${ticket_id} claim generation moved under the write (now ${moved.claimNow}), expected ${claimFence.gen} — left where it landed.`);
        }
      }
    }
  } catch (err) {
    // TEAM-5724 (R2-2): from the first POST on, a request that may have applied the
    // park-claim label has been sent (a lost response is indistinguishable from a
    // refusal), and the move it was meant to attribute did not verify — the fallback
    // re-check refused, a POST failed, or the fence refused the move the label rode.
    // Remove ONLY the label we added (`remove` of an absent label is a no-op); stale
    // generations the ops stripped stay stripped. The original error propagates.
    if (parkClaimLabel) await removeParkClaimLabel(ticket_id, parkClaimLabel);
    // TEAM-5941: the Done did not verify — take the intent back off the record,
    // best-effort. (A throw after a LANDED POST clears it too; harmless, the ticket
    // reads Done and nothing reads the intent after that.)
    if (admitted.intent) await clearDoneIntent(ticket_id, admitted);
    throw err;
  }

  const conflict = finalStatus === "done" ? await flagDoneOverCancelled(ticket_id) : false;
  const hold = finalStatus === "done" && admitted.key ? await postCommitHoldCheck(ticket_id, admitted) : {};
  const warnings = [conflict ? DONE_OVER_CANCELLED_WARNING : null, hold.warning].filter(Boolean);
  console.log(`[jira-tools] Transitioned ${ticket_id} to ${finalStatus} in Jira${blockers.length ? ` (blocked_by +${blockers.join(",")})` : ""}`);
  return {
    ticketId: ticket_id,
    status: finalStatus,
    message: `Transitioned to ${finalStatus}`,
    // TEAM-6131: what was asked for, and which Jira transition answered it. `status` stays
    // the destination Jira actually landed in (the match above is by NAME or destination,
    // so a workflow whose "Done" lands in e.g. "Closed" reports `status:"closed"`); the hub's
    // provesTransitioned (src/lib/workflow/ticket-transition-refusal.ts) reads this pair to
    // tell that move apart from a move into one of the hub's own other columns. Additive:
    // the `message` literal above is pinned by deploy/runtime-agent/tests/test_park_gate.py.
    requested: targetInternal,
    matchedTransition: { id: match.id, name: match.name, to: match.to.name },
    ...(blockers.length ? { blockedByAdded: blockers } : {}),
    ...(gateVerification ? { gateVerification } : {}),
    ...(conflict ? { conflict: "done_over_cancelled" } : hold.conflict ? { conflict: hold.conflict } : {}),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * TEAM-5716: a strongly consistent read of the orchestrator's claim for this ticket
 * (`agentTasks[<ticket>]` on the workflows row). Throws the precondition refusal unless
 * it is still the generation the park was stamped with, and still running.
 */
async function checkClaim(ticketId, { workflowId, gen }) {
  const res = await workflowsDdb.send(
    new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      ConsistentRead: true,
      ProjectionExpression: "agentTasks.#tid",
      ExpressionAttributeNames: { "#tid": ticketId },
    })
  );
  const task = res?.Item?.agentTasks?.[ticketId] || {};
  if (task.startedAt === gen && task.status === "running") return;
  const now = `${task.startedAt || "none"}/${task.status || "missing"}`;
  const err = new Error(`Status precondition failed: ${ticketId} claim generation moved (now ${now}), expected ${gen} — not transitioned.`);
  err.claimNow = now;
  throw err;
}

/** Status changelog items, oldest first. Sorted on `created` (Jira's array order is not
 *  a contract); when any history lacks a parseable `created`, array order is kept. */
function statusMoves(issue) {
  const hs = (issue?.changelog?.histories || []).map((h, i) => ({ h, i, t: Date.parse(h?.created) }));
  if (hs.every((x) => Number.isFinite(x.t))) hs.sort((a, b) => a.t - b.t || a.i - b.i);
  return hs.flatMap(({ h }) => (h.items || []).filter((it) => it.field === "status"));
}

/**
 * TEAM-5723: the `historyMetadata` a fenced transition POST carries. Jira records it on
 * the changelog history the POST produces, so the read-back can find OUR move instead
 * of guessing from recency. `extraData` values must be strings (Jira's contract).
 * TEAM-5729: an unfenced park carries it too (expectedStatus ""), so the orchestrator
 * can attribute the park's changelog history to the request that made it.
 */
function fenceHistoryMetadata(nonce, expectedStatus) {
  // `op` is always the transition itself: TEAM-5732 removed the fence's revert POST, the
  // only other writer. The key stays so the wire shape read by lease.mjs is unchanged.
  return {
    type: "agentcore-hub-jira",
    description: "transition_ticket expected_status fence",
    extraData: { fenceNonce: nonce, expectedStatus: String(expectedStatus ?? ""), op: "transition" },
  };
}

/** Bounded walk of `GET /issue/{key}/changelog` pages; same bound as jiraSearchAll's loop. */
const CHANGELOG_MAX_PAGES = 5;
const CHANGELOG_PAGE_SIZE = 100;

/**
 * TEAM-5723: every changelog history of an issue, as far as Jira lets us see, plus the
 * live status from the same read. The `expand=changelog` page is one bounded page
 * (`startAt`/`maxResults`/`total`/`histories` — Jira's PageOfChangelogs carries no
 * `isLast`); unless it alone covers `total`, the dedicated endpoint is paged.
 * TEAM-5728 (R3-1): the two reads are ordered OPPOSITE ways — `expand=changelog` is
 * newest-first (at most 100), `GET /issue/{key}/changelog` pages oldest-first — so the
 * dedicated endpoint walks from ITS OWN cursor (startAt=0, stepping by what each page
 * returned) and the two are unioned by history id. Seeding its startAt from the expand
 * page's length re-read the newest entries, i.e. ours, and made one history look like
 * two carriers past 100 histories. A history with no id is never deduped (a real double
 * must still count as two). Result order is unspecified; callers compare on
 * `created`/`id`. Exhaustion is the caller's "unverified", never a guess.
 * TEAM-5732 (R4-2) / TEAM-5734: `complete` says whether the walk may vouch for "nothing
 * else exists", and it is POSITIVE evidence only: a dedicated page that literally says
 * `isLast:true`, or `total` is finite and the id-union holds at least `total` histories
 * (the expand page alone may do that; then nothing is paged). Nothing else counts. An
 * empty page or a page that adds no new id ends the walk — this cursor has nothing more
 * to teach — and leaves it incomplete while histories are outstanding (TEAM-5732 called
 * those complete and let the nonce test decide; with the carrier on the expand page that
 * certified a walk Jira said was short). A missing or non-numeric `total` is paged for an
 * `isLast:true` and is otherwise incomplete. CHANGELOG_MAX_PAGES is incomplete. A page's
 * own `startAt + maxResults >= total` is NOT evidence — it is arithmetic on Jira's claim,
 * not on what was collected (TEAM-5732 counted it; dropped). The caller treats
 * `complete:false` as unverified — fail closed, never "nothing newer". `collected`,
 * `total` and `pages` are for the refusal text.
 */
async function fetchChangelogHistories(ticket_id) {
  const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=status&expand=changelog`);
  const byId = new Map();
  let noId = 0;
  const add = (h) => byId.set(h?.id != null ? String(h.id) : `noid:${noId++}`, h);
  for (const h of issue?.changelog?.histories || []) add(h);
  const total = Number(issue?.changelog?.total);
  const covered = () => Number.isFinite(total) && byId.size >= total;
  let startAt = 0;
  let pages = 0;
  let isLast = false;
  while (!covered() && !isLast && pages < CHANGELOG_MAX_PAGES) {
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(CHANGELOG_PAGE_SIZE) });
    const data = await jiraFetch(`/rest/api/3/issue/${ticket_id}/changelog?${params.toString()}`);
    pages += 1;
    const values = Array.isArray(data?.values) ? data.values : [];
    const before = byId.size;
    for (const h of values) add(h);
    isLast = data?.isLast === true;
    if (byId.size === before) break; // empty or no-new-ids page: nothing more at this cursor; completeness is decided below
    startAt += values.length;
  }
  const complete = isLast || covered();
  return { status: mapStatusToInternal(issue?.fields?.status?.name), histories: [...byId.values()], complete,
    collected: byId.size, total: Number.isFinite(total) ? total : null, pages };
}

/**
 * TEAM-5721: the expected_status fence's last word. Jira has no compare-and-set on
 * POST /transitions — the body carries only a transition id, and a global transition
 * (Blocked) is offered from every status — so a move that lands after the pre-POST
 * re-read is transitioned anyway (Done → Blocked). Read the changelog back and find OUR
 * move; when it came from anywhere but expectedStatus, REFUSE. No proof of the source →
 * refuse as unverified (fail closed).
 * TEAM-5723 (R2-1): "our move" is the ONE history carrying this request's nonce in
 * `historyMetadata.extraData.fenceNonce` — never the newest move into the target,
 * which another actor's Blocked → In Progress → Blocked could supply after ours.
 * Zero or several carriers, a carrier with anything but one status item into the
 * target, or an unreadable changelog → unverified. A Blocked → Blocked POST records no
 * status item, so it is a zero-carrier refusal rather than a comparison against
 * someone else's entry.
 * TEAM-5732 (R4-2): the fence VERIFIES, it never compensates. TEAM-5721's inverse POST
 * ("transition back to where it came from") was a second unfenced write into the same
 * race: it read a snapshot, awaited GET /transitions and POSTed by destination, so a
 * cancel landing in that gap was overwritten with Done and reported as "reverted"; and
 * the TEAM-5728 withhold check trusted a changelog walk that could stop at the page cap
 * without saying so. Now a wrong source is refused and LEFT where the race put it, with
 * the Fenced comment for a human, under "Status precondition failed … revert withheld"
 * (never "reverted" or "transitioned": the harness's _ParkGate._moved keys on the
 * latter), and an incomplete walk (`complete:false`) is unverified (TEAM-5734: completeness
 * is positive evidence only, see fetchChangelogHistories). Both paths throw
 * through the caller's catch, so the TEAM-5724 park-claim cleanup still runs. Residual:
 * the ticket sits in the target status until a human moves it; the orchestrator's
 * claim release keys on the changelog, not on this result.
 */
async function verifyExpectedSource(ticket_id, expectedStatus, targetInternal, fenceNonce) {
  let from, status;
  try {
    const { status: live, histories, complete, collected, total, pages } = await fetchChangelogHistories(ticket_id);
    status = live;
    const ours = histories.filter((h) => h?.historyMetadata?.extraData?.fenceNonce === fenceNonce);
    if (ours.length !== 1) throw new Error(`fence nonce matched ${ours.length} changelog entries`);
    if (!complete) throw new Error(`changelog scan incomplete: ${collected} of ${total ?? "an unreported total of"} histories after ${pages} /changelog page${pages === 1 ? "" : "s"}, none saying isLast`);
    const moves = (ours[0].items || []).filter((it) => it?.field === "status");
    if (moves.length !== 1) throw new Error(`our changelog entry carries ${moves.length} status items`);
    if (mapStatusToInternal(moves[0].toString) !== targetInternal) {
      throw new Error(`our changelog entry moved to ${mapStatusToInternal(moves[0].toString)}, not ${targetInternal}`);
    }
    from = mapStatusToInternal(moves[0].fromString);
  } catch (err) {
    // Never "transitioned" in this text: the harness's _ParkGate._moved keys on it.
    throw new Error(`Status precondition unverified: ${ticket_id} was sent to ${targetInternal} but the move could not be attributed to this request (${err.message}), expected ${expectedStatus} — not reported as moved.`);
  }
  if (from === expectedStatus) return;
  // Wrong source: refuse, flag for a human, and write NOTHING else to the status.
  const outcome = `revert withheld (${ticket_id} is now ${status}; left for a human to resolve)`;
  try {
    await addComment({ ticket_id, comment: `Fenced: this ticket moved to ${from} before the ${targetInternal} move expected from ${expectedStatus} landed; ${outcome}.` });
  } catch (err) {
    console.warn(`[jira-tools] ${ticket_id}: fence refusal comment failed: ${err.message}`);
  }
  throw new Error(`Status precondition failed: ${ticket_id} moved under the write (was ${from}, expected ${expectedStatus}) — ${outcome}.`);
}

/**
 * TEAM-5413 (slim), reshaped by TEAM-5732 (R4-2 sibling): a Done POST that raced the
 * hub's cancel can land a Won't Do ticket in Done — the pre-POST read passed the
 * TEAM-5421 terminal guard, the cancel landed, our POST moved Won't Do → Done. This used
 * to POST the cancel back ("Superseded"). That was the R4-2 defect in its other seat: the
 * newest move into Done was attributed by recency, not to this request, and the cancel
 * went out unconditionally after a snapshot read plus a GET /transitions, so a human
 * reopening the ticket in that gap was cancelled over — and the "a done ticket is never
 * cancelled" rule (terminalMoveRefusal) was bypassed by a raw POST. Now DETECTION ONLY:
 * the Done stands, a Conflict comment flags it for a human, and the result carries
 * `conflict: "done_over_cancelled"` + `warning`. The DynamoDB twin never compensated (its
 * unfenced Done write has no status condition; the hub's cancel counts the race as
 * `raced`), and the orchestrator's cancel guard drops every event of a cancelled
 * workflow, so the leftover Done drives nothing. Best-effort: a read or comment failure
 * is logged, never thrown over the transition that already happened. Runs on every Done
 * POST, fenced or not, so there is no nonce to match; the recency read is only a flag
 * now, and its failure mode is a missing flag, never a false "transitioned".
 */
export const DONE_OVER_CANCELLED_WARNING =
  "Conflict: this run was cancelled before the ticket reached Done; the Done stands until a human resolves it — the hub does not undo moves.";
export async function flagDoneOverCancelled(ticket_id) {
  try {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=status&expand=changelog`);
    if (mapStatusToInternal(issue?.fields?.status?.name) !== "done") return false; // cancelled (or moved on): leave it
    const moves = statusMoves(issue);
    const last = moves[moves.length - 1];
    if (!last || mapStatusToInternal(last.fromString) !== "cancelled") return false;
    await addComment({ ticket_id, comment: DONE_OVER_CANCELLED_WARNING });
    return true;
  } catch (err) {
    console.warn(`[jira-tools] ${ticket_id}: done-over-cancelled check failed: ${err.message}`);
    return false;
  }
}

/**
 * TEAM-5926 (TEAM-5799 ship-review F1): the Done guard read the completion record,
 * then the reason comment and the provider calls ran before the Done committed. A
 * replay drain that CAS-stamped `briefPending:true` inside that window (or, on a ticket
 * the guard admitted through completionRecordProven, `followUpsPending:true`) is found here,
 * by re-reading the record after the commit (judgePostCommitHold in gate-contract.mjs).
 * DETECTION ONLY, like flagDoneOverCancelled: the Done stands, a Conflict comment flags
 * it, the result carries `conflict` + `warning`, and the drain's own post-stamp
 * re-read converges the record. A re-read S3 cannot answer (one retry) is a warning,
 * never a throw over the committed move.
 */
export async function postCommitHoldCheck(ticket_id, admitted) {
  const reread = async () => {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: admitted.key }));
      return { etag: res.ETag, absent: false, bodyText: await res.Body.transformToString() };
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) return { absent: true };
      return { error: `could not read ${admitted.key} (${err?.name || "S3Error"}${status ? ` ${status}` : ""})` };
    }
  };
  let now = await reread();
  if (now.error) now = await reread();
  const verdict = judgePostCommitHold(admitted.key, admitted, now);
  if (!verdict) return {};
  if (verdict.unchecked) {
    console.warn(`[jira-tools] ${ticket_id}: post-commit hold check could not run: ${verdict.why}`);
    return { warning: postCommitUncheckedWarning(verdict.why) };
  }
  const fields = postCommitHoldConflict(verdict);
  console.warn(`[jira-tools] ${ticket_id}: Done committed over a concurrent hold on ${admitted.key} (${verdict.kinds.join(", ")})`);
  try {
    await addComment({ ticket_id, comment: `Conflict: ${fields.warning}` });
  } catch (err) {
    console.warn(`[jira-tools] ${ticket_id}: ${fields.conflict} comment failed: ${err.message}`);
  }
  return fields;
}

async function updateTicket(params) {
  const { ticket_id, description, title } = params;

  const fields = {};
  if (title) fields.summary = clampSummary(title);
  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }

  await jiraFetch(`/rest/api/3/issue/${ticket_id}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });

  return { ticketId: ticket_id, message: "Updated" };
}

/**
 * Normalize a SYSTEM label (TEAM-4122 FR-5). Deliberately NOT sanitizeUserLabels:
 * that one maps ":" → "-" and refuses the reserved namespaces, which is exactly
 * right for an agent-supplied label and exactly wrong for `ci:uncertifiable`,
 * which the orchestrator owns. The one hard rule is Jira's: a label may not
 * contain whitespace (the API rejects the whole PUT). Returns "" when unusable.
 *
 * Kept local rather than added to fix-contract.mjs — that module is byte-compared
 * across three copies by CI, and `labels_add` needs no cross-Lambda contract.
 */
function normalizeSystemLabel(label) {
  if (typeof label !== "string") return "";
  const lowered = label.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(lowered)) return "";
  return lowered;
}

/**
 * Additively append labels to an issue. Uses Jira's `update: {labels:[{add}]}`
 * verb, NOT `fields: {labels: [...]}` — the field form is a whole-list REPLACE
 * that would drop every label the pipeline already set (`wf:`, `phase:`,
 * `fix:`…). `add` is idempotent server-side: adding a label the issue already
 * carries is a no-op, so a redelivered call is harmless.
 */
/**
 * TEAM-5724: take a park-claim label back off after a park that did not verify
 * (transitionTicket's outer catch). Never throws — the caller rethrows the error
 * that got us here, and a failed removal is a logged residual (a stale label that
 * matches only its own generation), not a second error.
 */
async function removeParkClaimLabel(ticket_id, label) {
  try {
    await jiraFetch(`/rest/api/3/issue/${ticket_id}`, { method: "PUT", body: JSON.stringify({ update: { labels: [{ remove: label }] } }) });
  } catch (err) {
    console.warn(`[jira-tools] ${ticket_id}: could not remove ${label} after a park that did not verify — a stale park-claim label may remain: ${err.message}`);
  }
}

/**
 * TEAM-5727: did a design-amendment withdrawal's Done transition actually land,
 * when the POST that was meant to confirm it threw? Read the issue back and ask
 * Jira directly, rather than trust the failed response. An unreadable issue (the
 * re-read itself throws) is treated as "not landed" — withdrawDuplicateAmendment's
 * caller then compensates, and a wrongly-restored label on a ticket that is
 * secretly Done is the smaller mistake than a ticket stranded half-withdrawn.
 */
async function withdrawalLanded(ticket_id) {
  try {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=status`);
    return mapStatusToInternal(issue?.fields?.status?.name) === "done";
  } catch (err) {
    console.warn(`[agentcore-hub-jira] ${ticket_id}: could not re-read status after a Done that did not confirm — assuming it did not land: ${err.message}`);
    return false;
  }
}

/**
 * TEAM-5727: take a design-amendment withdrawal's relabel back off after a Done
 * that did not confirm landing (withdrawDuplicateAmendment's catch). Re-adds the
 * `fix:`/`origin:` labels it stripped and removes `duplicate-of:<keeper>`. Never
 * throws — the caller's "keeping it" log is the record either way; a failed
 * restore here is a second, logged, known leftover (not a second error).
 */
async function restoreWithdrawnLabels(ticket_id, { restore, marker }) {
  try {
    await jiraFetch(`/rest/api/3/issue/${ticket_id}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [...restore.map((add) => ({ add })), { remove: marker }] } }),
    });
  } catch (err) {
    console.warn(`[agentcore-hub-jira] ${ticket_id}: could not restore ${restore.join(",")} after an unconfirmed Done — it may still carry ${marker} with its fix:/origin: labels stripped: ${err.message}`);
  }
}

/** Jira's "labels is not on this transition's screen" refusal (TEAM-4908). */
function isLabelsScreenRefusal(err) {
  const m = String(err?.message || "");
  return /Jira API 400/.test(m) && /labels/i.test(m) && /appropriate screen/i.test(m);
}

async function addLabels(params) {
  const ticketId = params.ticket_id || params.issue_key;
  if (!ticketId) throw new Error("'ticket_id' is required");

  const raw = Array.isArray(params.labels)
    ? params.labels
    : typeof params.labels === "string"
      ? params.labels.split(",")
      : params.labels
        ? [params.labels]
        : [];
  const wanted = [];
  const dropped = [];
  for (const item of raw) {
    const norm = normalizeSystemLabel(item);
    if (!norm) {
      if (item !== undefined && item !== null && String(item).trim() !== "") dropped.push(String(item));
      continue;
    }
    if (!wanted.includes(norm)) wanted.push(norm);
  }
  if (wanted.length === 0) throw new Error("no valid labels to add");

  await jiraFetch(`/rest/api/3/issue/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify({ update: { labels: wanted.map((add) => ({ add })) } }),
  });

  return {
    ticketId,
    status: "labels_added",
    added: wanted,
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

async function listTickets(params) {
  const { parent_id } = params;
  // F6: `parent_id` lands UNQUOTED in the JQL (it is an issue key, not a string
  // literal), so escaping cannot protect it — anything that is not a project key
  // is refused outright. Without this, a parent_id of `X ORDER BY created` or
  // `X OR project = OTHER` silently changes which tickets the caller gets back.
  if (!TICKET_KEY_RE.test(String(parent_id || ""))) {
    throw new Error(`Invalid 'parent_id' ${JSON.stringify(parent_id)} — expected an issue key like ${PROJECT_KEY}-123`);
  }
  const jql = `parent = ${parent_id} ORDER BY created ASC`;

  // TEAM-5168 (R2-05): every page, not the oldest 100. `complete:false` is the
  // explicit signal that the bound was hit; the caller must not read the absence
  // of a ticket from a truncated list (workflow-output holds its follow-up
  // creates and refuses an empty sweep on it).
  // TEAM-5426: `issuelinks` so each row carries blockedBy — workflow-output finds
  // the dev lanes a security review blocks off this listing.
  const search = await jiraSearchAll(jql, ["summary", "status", "labels", "assignee", "issuetype", "issuelinks"]);
  const tickets = search.issues.map(mapIssue);
  if (!search.complete) {
    const warning = `child listing under ${parent_id} truncated ${truncationClause(search)} (${tickets.length} tickets, oldest first); Jira reports more children`;
    console.warn(`[agentcore-hub-jira] list_tickets: ${warning}`);
    return { tickets, complete: false, scan_incomplete: true, warning };
  }
  return { tickets, complete: true };
}

async function addComment(params) {
  const { ticket_id, comment } = params;

  await jiraFetch(`/rest/api/3/issue/${ticket_id}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
      },
    }),
  });

  return { ticketId: ticket_id, message: "Comment added" };
}

async function searchIssues(params) {
  // Accept `jql` as an alias — agents regularly pass it and used to get an
  // opaque 400 (empty jql param) back.
  const { query, jql, max_results } = params;
  const q = query || jql;
  if (!q) throw new Error("search_issues requires a `query` (JQL string)");
  const data = await jiraSearch(q, ["summary", "status", "labels", "assignee", "issuetype", "parent"], max_results || 50);
  const tickets = (data.issues || []).map(mapIssue);
  return { tickets };
}

export async function getIssue(params) {
  // Accept both `issue_key` (agent-facing tool schema) and `ticket_id` (the
  // gateway tool schema for Tickets___get_issue exposes ONLY ticket_id). Without
  // this, a schema-conforming gateway-direct call hits Jira with `undefined`.
  const issue_key = params.issue_key || params.ticket_id;
  if (!issue_key) {
    throw new Error("get_issue requires an issue_key (or ticket_id)");
  }
  // Read only the fields mapIssue needs. Comments are NOT requested here: the
  // embedded `comment` container paginates ASCENDING, so on long threads the
  // NEWEST comments (where the release manager's DECISION lives) get cut off.
  const query = new URLSearchParams({
    fields: "summary,status,labels,assignee,issuetype,parent,issuelinks",
  });
  const issue = await jiraFetch(`/rest/api/3/issue/${issue_key}?${query.toString()}`);

  // Fetch comments via the dedicated endpoint newest-first so the latest/decision
  // comments are always in the first page, then reverse to chronological
  // (oldest→newest) — callers parse the LAST matching DECISION line, so ordering
  // matters. Comments are supplementary context: if the fetch fails, log and
  // return comments: [] rather than failing the whole getIssue.
  let comments = [];
  try {
    const commentQuery = new URLSearchParams({ orderBy: "-created", maxResults: "50" });
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/comment?${commentQuery.toString()}`);
    comments = (data?.comments || [])
      .map((c) => ({
        author: c.author?.displayName || null,
        body: adfToText(c.body),
        created: c.created,
      }))
      .reverse();
  } catch (err) {
    console.log(`[jira-tools] could not fetch comments for ${issue_key}: ${err.message}`);
  }

  return { ...mapIssue(issue), comments };
}

async function getTransitions(params) {
  const { issue_key } = params;
  const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/transitions`);
  const transitions = data.transitions.map((t) => ({
    id: t.id,
    name: t.name,
    to: t.to.name,
    toInternal: mapStatusToInternal(t.to.name),
  }));
  return { issue_key, transitions };
}

async function listProjects() {
  const data = await jiraFetch("/rest/api/3/project/search?maxResults=50");
  const projects = (data.values || []).map((p) => ({
    key: p.key,
    name: p.name,
    id: p.id,
  }));
  return { projects };
}

async function getProjectIssueTypes() {
  return {
    issueTypes: [
      { name: "Epic", description: "A large body of work" },
      { name: "Story", description: "User-facing feature" },
      { name: "Task", description: "A unit of work" },
      { name: "Bug", description: "A defect to fix" },
    ],
  };
}

async function lookupUser(params) {
  const { query } = params;
  // F6: `query` is agent-supplied free text inside a quoted JQL literal — escape
  // it (backslash first, then quote) so a name containing `"` cannot close the
  // literal and append clauses.
  const jql = `project = ${PROJECT_KEY} AND labels in ("agent:${escapeJql(query)}") ORDER BY created DESC`;

  try {
    const data = await jiraSearch(jql, ["labels"], 1);
    const agents = new Set();
    for (const issue of data.issues || []) {
      for (const label of issue.fields.labels || []) {
        if (label.startsWith("agent:") && label.toLowerCase().includes(query.toLowerCase())) {
          agents.add(label.replace("agent:", ""));
        }
      }
    }

    if (agents.size === 0) {
      const broadJql = `project = ${PROJECT_KEY} AND labels is not EMPTY ORDER BY created DESC`;
      const broadData = await jiraSearch(broadJql, ["labels"], 50);
      for (const issue of broadData.issues || []) {
        for (const label of issue.fields.labels || []) {
          if (label.startsWith("agent:") && label.toLowerCase().includes(query.toLowerCase())) {
            agents.add(label.replace("agent:", ""));
          }
        }
      }
    }

    return { users: [...agents].map((name) => ({ name, type: "agent" })) };
  } catch (err) {
    console.log(`lookupUser error: ${err.message}`);
    return { users: [], message: `No agents found matching "${query}"` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Flatten an Atlassian Document Format (ADF) node tree to plain text. Comment
// bodies come back as ADF; agents want readable text. Plain strings pass
// through unchanged.
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  // A hardBreak (Shift+Enter inside a comment) is a logical line break with no
  // content — without this it flattens to "" and two lines merge into one, which
  // can silently join an isolated `DECISION:` line to its rationale.
  if (node.type === "hardBreak") return "\n";
  const inner = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  // Block-level nodes each end on their own line so every logical line in the ADF
  // doc lands on its own line in the flattened text (the release manager parses an
  // isolated `DECISION: <value>` line). The endsWith guard avoids gratuitous double
  // blank lines when a block already ends in a newline (e.g. a listItem whose only
  // child is a paragraph that already added its own trailing "\n").
  if (BLOCK_NODES.has(node.type)) {
    return inner.endsWith("\n") ? inner : `${inner}\n`;
  }
  return inner;
}

// Block-level ADF node types that should each terminate a line when flattened.
// bulletList/orderedList are intentionally omitted: their separation comes from
// each child listItem's trailing newline, so listing them here would only add
// blank lines between lists.
const BLOCK_NODES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "codeBlock",
]);

/**
 * "is blocked by" = inward side of a Blocks link. Only present when the caller
 * requested `issuelinks` (getIssue does; the lean list field set does not) —
 * `undefined` then means "not asked for", which is NOT the same as "none", and the
 * difference is what keeps mapIssue from inventing an empty blockedBy.
 *
 * One rule, two readers (mapIssue and scanSiblingTickets): the gate-loop verdict
 * matches on blocked_by overlap, so a second copy of this filter would be a second
 * definition of "same target".
 */
function blockedByOfFields(fields) {
  return Array.isArray(fields?.issuelinks)
    ? fields.issuelinks
        .filter((l) => l?.type?.name === "Blocks" && l.inwardIssue?.key)
        .map((l) => l.inwardIssue.key)
    : undefined;
}

function mapIssue(issue) {
  const fields = issue.fields || {};
  const labels = fields.labels || [];
  const agentLabel = labels.find((l) => l.startsWith("agent:"));
  const reviewerLabel = labels.find((l) => l.startsWith("reviewer:"));
  const wfLabel = labels.find((l) => l.startsWith("wf:"));

  // Agent tickets: "agent:<id>". Human-review gates: "reviewer:<who>" →
  // "human:<who>" (matches the orchestrator + TS mappers).
  const assignee = agentLabel
    ? agentLabel.replace("agent:", "")
    : reviewerLabel
    ? `human:${reviewerLabel.replace("reviewer:", "")}`
    : fields.assignee?.displayName || null;

  const blockedBy = blockedByOfFields(fields);

  return {
    ticketId: issue.key,
    title: fields.summary || "",
    status: mapStatusToInternal(fields.status?.name || "To Do"),
    assignee,
    issueType: fields.issuetype?.name || "Task",
    parentKey: fields.parent?.key || null,
    workflowId: wfLabel ? wfLabel.replace("wf:", "") : null,
    labels,
    ...(blockedBy !== undefined ? { blockedBy } : {}),
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const TOOLS = {
  Tickets___create_ticket: createTicket,
  Tickets___transition_ticket: transitionTicket,
  Tickets___update_ticket: updateTicket,
  Tickets___labels_add: addLabels,
  Tickets___list_tickets: listTickets,
  Tickets___add_comment: addComment,
  Tickets___search_issues: searchIssues,
  Tickets___get_issue: getIssue,
  Tickets___get_transitions: getTransitions,
  Tickets___list_projects: listProjects,
  Tickets___get_project_issue_types: getProjectIssueTypes,
  Tickets___lookup_user: lookupUser,
  Tickets___list_reviewers: listReviewers,
  // Backward compat: accept old prefix during transition
  JiraIntegration___create_ticket: createTicket,
  JiraIntegration___transition_ticket: transitionTicket,
  JiraIntegration___update_ticket: updateTicket,
  JiraIntegration___list_tickets: listTickets,
  JiraIntegration___add_comment: addComment,
  JiraIntegration___search_issues: searchIssues,
  JiraIntegration___get_issue: getIssue,
  JiraIntegration___get_transitions: getTransitions,
  JiraIntegration___list_projects: listProjects,
  JiraIntegration___get_project_issue_types: getProjectIssueTypes,
  JiraIntegration___lookup_user: lookupUser,
  JiraIntegration___list_reviewers: listReviewers,
};

export const handler = async (event) => {
  // Load roster from S3 on first invocation (cached for warm starts)
  await loadValidAssignees();

  const toolName = event.tool_name;
  const params = event.parameters || {};

  console.log(`[jira-tools] tool=${toolName} params=${JSON.stringify(params)}`);

  const fn = TOOLS[toolName];
  if (!fn) {
    console.log(`[jira-tools] Unknown tool: ${toolName}`);
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    const result = await fn(params);
    console.log(`[jira-tools] tool=${toolName} result=${JSON.stringify(result).slice(0, 500)}`);
    return result;
  } catch (err) {
    console.error(`[jira-tools] tool=${toolName} ERROR: ${err.message}`);
    // TEAM-4706: a STRUCTURED refusal (the ship-phase completion-record gate)
    // carries the shape the agent has to read — `reason` to match on, `hint` to
    // act on — so it survives the throw→result boundary verbatim. `error` is kept
    // alongside it because that is the field every existing caller (the hub UI's
    // rejectedDetails, the orchestrator) recognizes as "the ticket did not move".
    if (err?.toolResult) return { ...err.toolResult, error: err.message };
    return { error: err.message };
  }
};
