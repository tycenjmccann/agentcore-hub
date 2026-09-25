/**
 * agentcore-hub-jira — Ticket tools Lambda for Jira Cloud.
 *
 * Deploy this when TICKET_PROVIDER=jira.
 * Agents call this Lambda to create/update/transition tickets in Jira.
 *
 * Env vars:
 *   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
// TEAM-4740 FR-5 (interim): the ONLY DynamoDB this Lambda touches is the events
// table, and only to audit an autowired blocker edge — the same write the DynamoDB
// twin makes, so the twins emit one event vocabulary instead of two. Dark unless
// EVENTS_TABLE is set (this Lambda's deploy env does not set it), and the client is
// built lazily inside emitJourneyEvent so an unconfigured deploy pays nothing.
// Both packages are provided by the nodejs20.x runtime, so the self-contained zip
// stays self-contained.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
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
  parseFixDecision,
  pipelineLabelOverflow,
  pipelineLabelRefusal,
  probedGateKindOf,
  publishJourneyEvent,
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
async function completionRecordProven(ticketId) {
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
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) {
      return { proven: false, why: `no ${key} in the artifact bucket` };
    }
    return { proven: false, why: `could not read ${key} (${err?.name || "S3Error"}${status ? ` ${status}` : ""})` };
  }
  return judgeCompletionRecord(key, bodyText);
}

/**
 * The refusal, in this Lambda's idiom: transitionTicket signals every other
 * failure by throwing, and the handler turns a throw into `{ error }`. The
 * structured payload rides on the Error so the handler can return `reason`/`hint`
 * verbatim ALONGSIDE `error` — the `error` field is what the hub UI's
 * rejectedDetails() recognizes as "the ticket did not move".
 */
function completionRecordRequiredError(ticketId, why) {
  const err = new Error(
    `Cannot move ${ticketId} to Done: a ship-phase ticket needs its completion record first — ` +
    `${COMPLETION_RECORD_REQUIRED.hint} (${why})`
  );
  err.toolResult = { ...COMPLETION_RECORD_REQUIRED };
  return err;
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
 * @returns {Promise<object|null>} the verification to stamp, or null when this
 *   ticket is not a probed gate. Throws to refuse.
 */
async function gateConditionCleared(ticketId, labels, description) {
  // TEAM-4706 (DL-030), unchanged: a ship-phase ticket cannot reach Done without
  // its completion record.
  if (await isShipPhaseTicket(labels)) {
    const proof = await completionRecordProven(ticketId);
    if (!proof.proven) {
      console.warn(
        `[agentcore-hub-jira] ${ticketId}: refusing done on a ship-phase ticket — ${proof.why}`
      );
      throw completionRecordRequiredError(ticketId, proof.why);
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

  // ONE sibling scan per create, shared with autowireOpenGate below. Its maxResults
  // is deliberately the same 50 that autowireOpenGate reads: one scan, one bound,
  // one fail direction.
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

const INTERNAL_TO_JIRA = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

const JIRA_TO_INTERNAL = Object.fromEntries(
  Object.entries(INTERNAL_TO_JIRA).map(([k, v]) => [v.toLowerCase(), k])
);

function mapStatusToInternal(jiraStatus) {
  return JIRA_TO_INTERNAL[jiraStatus.toLowerCase()] || jiraStatus.toLowerCase().replace(/\s+/g, "_");
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
  const search = await jiraSearch(
    `parent = ${key} ORDER BY created ASC`,
    ["summary", "status", "labels", "assignee", "issuetype", "created", "issuelinks"],
    50
  );
  return (search?.issues || []).map((iss) => {
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

async function createTicket(params) {
  const { summary: rawSummary, description, parent_key, assignee, issue_type, blocked_by, workflow_id, spawned_by, fix_contract, phase, labels, base_branch } = params;
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
        return internal === "done" || internal === "closed";
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
  let coercedToSubtask = false;
  if ((canonicalType === "Subtask" || canonicalType === "Task") && parent_key) {
    const requested = canonicalType;
    let parentIssueType = null;
    try {
      const parent = await jiraFetch(`/rest/api/3/issue/${parent_key}?fields=issuetype`);
      parentIssueType = parent?.fields?.issuetype || null;
    } catch (err) {
      console.warn(`[jira-tools] could not read parent ${parent_key} issuetype (${err.message})${requested === "Subtask" ? "; coercing Subtask -> Task to avoid orphaning." : "."}`);
    }
    canonicalType = resolveChildIssueType(requested, parentIssueType);
    if (parentIssueType && requested === "Subtask" && canonicalType === "Task") {
      console.log(`[jira-tools] parent ${parent_key} is an Epic — coercing Subtask -> Task (Jira forbids subtask-of-Epic) so the child isn't orphaned.`);
    }
    if (requested === "Task" && canonicalType === "Subtask") {
      coercedToSubtask = true;
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
    // TEAM-5101: a Subtask WE resolved from a read parent is the only valid type
    // there — the Task retry is known-invalid and would end at the parentless last
    // resort, an orphan the caller would count as created. Refuse instead.
    if (!isTypeParentErr || fields.issuetype.name === "Task" || coercedToSubtask) throw err;
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
  const { ticket_id, transition_id, reason, blocked_by } = params;
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
  // advisory DECISION line, and only a ship-phase ticket costs an S3 call.
  let gateVerification = null;
  let gateLabels = [];
  if (effectiveStatus.toLowerCase() === "done") {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=labels,description`);
    gateLabels = issue?.fields?.labels || [];
    gateVerification = await gateConditionCleared(
      ticket_id,
      gateLabels,
      adfToText(issue?.fields?.description)
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

  // TEAM-4739: the verification stamp rides in the SAME request as the transition —
  // `POST /transitions` accepts `update.labels` alongside `transition` — so a gate
  // close can never be recorded without the verdict that admitted it, and
  // `gate:awaiting-console` comes off in the same call rather than in an adjacent one
  // that could be lost.
  const labelOps = gateVerification ? planGateLabelOps(gateLabels, gateVerification) : [];
  const transitionBody = (withLabels) => JSON.stringify({
    transition: { id: match.id },
    ...(withLabels && labelOps.length ? { update: { labels: labelOps } } : {}),
  });
  try {
    await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, { method: "POST", body: transitionBody(true) });
  } catch (err) {
    // TEAM-4908: a team-managed workflow whose transitions have no SCREEN rejects
    // `update.labels` on POST /transitions with 400 "Field 'labels' cannot be set.
    // It is not on the appropriate screen, or unknown." — while the same field IS
    // on the edit screen (editmeta lists it). Every human ✅ on a verified gate
    // 409'd for a day (2026-09-21). Fallback keeps the TEAM-4739 invariant "no
    // close without its stamp" the other way round: stamp through the edit
    // endpoint FIRST, then transition without labels. A stamp with no close is
    // recoverable (re-approve); a close with no stamp is not.
    if (!(labelOps.length && isLabelsScreenRefusal(err))) throw err;
    console.warn(`[jira-tools] ${ticket_id}: transition screen has no labels field — stamping via PUT /issue, then transitioning without labels`);
    await jiraFetch(`/rest/api/3/issue/${ticket_id}`, { method: "PUT", body: JSON.stringify({ update: { labels: labelOps } }) });
    await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, { method: "POST", body: transitionBody(false) });
  }

  const finalStatus = isSkip ? "done" : mapStatusToInternal(match.to.name);
  console.log(`[jira-tools] Transitioned ${ticket_id} to ${finalStatus} in Jira${blockers.length ? ` (blocked_by +${blockers.join(",")})` : ""}`);
  return {
    ticketId: ticket_id,
    status: finalStatus,
    message: `Transitioned to ${finalStatus}`,
    ...(blockers.length ? { blockedByAdded: blockers } : {}),
    ...(gateVerification ? { gateVerification } : {}),
  };
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

  const data = await jiraSearch(jql, ["summary", "status", "labels", "assignee", "issuetype"], 100);
  const tickets = (data.issues || []).map(mapIssue);
  return { tickets };
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
