/**
 * Orchestration Lambda — Event-Driven Workflow Engine
 *
 * Triggered by DynamoDB Streams on the `agentcore-hub-tickets` table.
 * Reacts to ticket status changes and drives the workflow forward:
 *
 *   ticket → "done"  → unblock dependents, check QA gate, check completion
 *   ticket → "ready" → invoke the assigned agent via AgentCore Harness
 *   ticket → "in_progress" → publish status event (UI notification)
 *
 * The Next.js app is read-only. It just visualizes state.
 * This Lambda is the SOLE orchestrator.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import * as store from "./workflow-store.mjs";
import {
  DEFAULT_TTL_MINUTES,
  STALE_CLAIM_MULTIPLIER,
  LEASE_TTL_MS,
  isLeaseLive,
  lastAgentActivity,
  stealClaim,
} from "./lease.mjs";
import { resolveWatchdog, setWatchdogSource } from "./watchdog.mjs";
import { createDetector } from "./dead-session-detector.mjs";
import { createCascade } from "./cascade.mjs";
import { createReconcileSweep } from "./reconcile-sweep.mjs";
import { createReviewCap } from "./review-cap.mjs";
import { isWorkflowComplete as evaluateWorkflowComplete, missingEvidenceTickets, evaluateShipVerdict, SHIP_PHASES, SHIP_BLOCKED_OUTCOMES } from "./completion.mjs";
import { isPipelineEnabled } from "./pipeline-enabled.mjs";

// ─── Config ────────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const GITHUB_LAMBDA = process.env.GITHUB_LAMBDA || "agentcore-hub-github-mcp";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const MAX_QA_RETRIES = 3;
// Dead-session detector rollout flag (TEAM-3618 D1.2; promoted to enforce by
// default in TEAM-3748 D4.1): off = skip the sweep, shadow = observe + metrics
// + shadow-flagged events but ZERO writes, enforce (the NEW DEFAULT — the
// silent-death watchdog now recovers for real) = steal/retry/escalate. The
// fail-safe coercion still holds: runSweep normalizes (trim+lowercase) and
// coerces anything not exactly off|shadow|enforce back to shadow, so a typo in
// the env var can only ever DOWNGRADE to observe-only, never grant a rogue mode.
const DEAD_SESSION_DETECTOR_MODE = process.env.DEAD_SESSION_DETECTOR_MODE || "enforce";
// Cascade extended-states rollout flag (TEAM-3618 D3 commit 4b; tri-state as of
// TEAM-3747 D1). off = the cascade only re-Readies {blocked, todo} dependents
// (commit-4a behavior); shadow (the NEW DEFAULT — ships dark-but-observing) =
// evaluate the extended-state path and emit would-nudge/would-steal/would-
// reawaken metrics but perform ZERO writes; enforce = an in_progress dependent
// whose last blocker resolves is lease-guarded (live → nudge only; stale → steal
// + re-dispatch through the claim CAS) and an in_review gate is re-woken for
// real. Same vocabulary + fail-safe default (shadow) as DEAD_SESSION_DETECTOR_MODE.
// Backwards compatible: the legacy boolean "true"/"1"/"on" maps to enforce; an
// unset or unrecognized value falls back to shadow (never silently enforces).
const CASCADE_EXTENDED_STATES_MODE = resolveCascadeMode(process.env.CASCADE_EXTENDED_STATES);
// Missed-unblock reconciliation sweep (TEAM-3747 D1). Same tri-state + fail-safe
// default; governed independently of the cascade's own mode (it is a separate
// safety-net rollout). Normalized inside reconcile-sweep.runSweep.
const RECONCILE_SWEEP_MODE = process.env.RECONCILE_SWEEP_MODE || "shadow";

/**
 * Resolve CASCADE_EXTENDED_STATES to off | shadow | enforce. Legacy truthies
 * ("true"/"1"/"on"/"enforce") → enforce; explicit "off" → off; unset, "false",
 * "0", "shadow", or anything unrecognized → shadow (the safe, observe-only
 * default). Trimmed + lowercased so a casing slip can never grant write access.
 */
function resolveCascadeMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "enforce" || v === "on" || v === "true" || v === "1") return "enforce";
  return "shadow"; // "", "shadow", "false", "0", or garbage → shadow
}
// TEAM-3686 Finding 3 / TEAM-3690: deliverable-evidence gate on the orchestrator
// completion path — same flag, same semantics as the HTTP complete route
// (TEAM-3619 D4a, design §X.5 step 6: "evidence check behind
// COMPLETION_EVIDENCE_REQUIRED flag (shadow-log first)"). The shadow-first
// observation step is now COMPLETE: per QA finding F2 (AC-D4.1) this DEFAULTS ON
// (ENFORCE) — a completion missing evidence aborts. Shadow mode remains ONLY as
// an explicit emergency opt-OUT: COMPLETION_EVIDENCE_REQUIRED=off|false|0
// (case-insensitive, trimmed) falls back to shadow-log-and-continue. Fail-closed:
// any other value — unset, empty, unrecognized garbage — ENFORCES, so an
// unparseable value can never silently disable the invariant. No force/bypass
// parameter either way.
const COMPLETION_EVIDENCE_REQUIRED = !/^(off|false|0)$/i.test(
  (process.env.COMPLETION_EVIDENCE_REQUIRED || "").trim()
);
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || (TICKET_PROVIDER === "jira" ? "agentcore-hub-jira" : "agentcore-hub-tickets");
const CLOUD_CODE_TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";

// Jira config (only used when TICKET_PROVIDER=jira)
const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_AUTH = JIRA_EMAIL && JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`
  : "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
store.initWorkflowStore(ddb, WORKFLOWS_TABLE);
const lambda = new LambdaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const events = new EventBridgeClient({ region: REGION });
const bedrockAgent = new BedrockAgentRuntimeClient({ region: REGION });

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_ROSTER = [
  { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
  { agentId: "agentcore_hub_frontend_designer", phase: "design" },
  { agentId: "agentcore_hub_ios_designer", phase: "design" },
  { agentId: "agentcore_hub_backend_designer", phase: "design" },
  { agentId: "agentcore_hub_android_designer", phase: "design" },
  { agentId: "agentcore_hub_security_reviewer", phase: "design" },
  { agentId: "agentcore_hub_legal_compliance", phase: "design" },
  { agentId: "agentcore_hub_localization", phase: "design" },
  { agentId: "agentcore_hub_analytics_designer", phase: "design" },
  { agentId: "agentcore_hub_backend_dev", phase: "development" },
  { agentId: "agentcore_hub_api_dev", phase: "development" },
  { agentId: "agentcore_hub_frontend_dev", phase: "development" },
  { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
  { agentId: "agentcore_hub_ci_agent", phase: "review" },
  { agentId: "agentcore_hub_release_manager", phase: "ship" },
];

let _agentRoster = null;

async function loadAgentRoster() {
  if (_agentRoster) return _agentRoster;
  if (!ARTIFACT_BUCKET) {
    console.warn("[orchestrator] No ARTIFACT_BUCKET — using fallback roster");
    _agentRoster = FALLBACK_ROSTER;
    return _agentRoster;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    // Feed the same S3 config to the watchdog resolver (D1.1) — per-agent +
    // defaults watchdog blocks, resolved without a second fetch.
    setWatchdogSource(config);
    _agentRoster = config.agents.map((a) => ({
      agentId: a.agentId,
      phase: a.phase,
      runtimeArn: a.runtimeArn || null,
      workflowDefId: a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID,
      // An agent may serve multiple pipelines (e.g. reviewer/QA/CI run in both
      // software-delivery and bug-fix). workflowDefIds is the multi-def list;
      // fall back to the single workflowDefId shorthand.
      workflowDefIds: a.workflowDefIds?.length ? a.workflowDefIds : [a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID],
    }));
    console.log(`[orchestrator] Loaded ${_agentRoster.length} agents from S3 config`);
  } catch (err) {
    console.warn(`[orchestrator] Failed to load roster from S3: ${err.message} — using fallback`);
    _agentRoster = FALLBACK_ROSTER;
  }
  return _agentRoster;
}

function getAgentDef(id) {
  const roster = _agentRoster || FALLBACK_ROSTER;
  return roster.find((a) => a.agentId === id);
}

// ─── Workflow Definitions (config-driven shapes, from S3) ─────────────────────

const DEFAULT_WORKFLOW_DEF_ID = "software-delivery";

// Reproduces the original hardcoded 14-agent pipeline exactly. Used as fallback
// and whenever a workflow has no (or an unknown) workflowDefId.
const FALLBACK_WORKFLOW_DEF = {
  id: DEFAULT_WORKFLOW_DEF_ID,
  intakeAgentId: "agentcore_hub_requirements_analyst",
  featureBranchPhase: "development",
  createsPullRequest: true,
  completionRequiresAgentPhases: ["development", "verification", "review"],
  reviewGates: [],
  // Mirror the config-derived order (agentPhases only). The CI agent's "review"
  // phase is not a pipeline phase, so it is intentionally absent — keeps the
  // fallback identical to the S3-config path for software-delivery.
  phaseOrder: ["intake", "requirements", "design", "development", "verification", "complete"],
};

let _workflowDefs = null;

// Exported for tests to seed a ship-phase def (completion-gates.test.mjs drives
// the TEAM-3721 merge gate, which only engages for defs whose
// completionRequiresAgentPhases includes "ship").
export async function loadWorkflowDefs() {
  if (_workflowDefs) return _workflowDefs;
  _workflowDefs = { [DEFAULT_WORKFLOW_DEF_ID]: FALLBACK_WORKFLOW_DEF };
  if (!ARTIFACT_BUCKET) return _workflowDefs;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/workflows.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const w of config.workflows || []) {
      // Derive the monotonic phase-advancement order from the def's phases.
      const order = ["intake"];
      for (const p of w.phases || []) {
        if (p.agentPhase && p.agentPhase !== "intake" && !order.includes(p.agentPhase)) {
          order.push(p.agentPhase);
        }
      }
      order.push("complete");
      _workflowDefs[w.id] = {
        id: w.id,
        intakeAgentId: w.intakeAgentId,
        featureBranchPhase: w.featureBranchPhase ?? null,
        createsPullRequest: w.createsPullRequest ?? false,
        completionRequiresAgentPhases: w.completionRequiresAgentPhases || [],
        reviewGates: w.reviewGates || [],
        phaseOrder: order,
      };
    }
    console.log(`[orchestrator] Loaded ${Object.keys(_workflowDefs).length} workflow definitions from S3`);
  } catch (err) {
    console.warn(`[orchestrator] Failed to load workflow defs from S3: ${err.message} — using fallback only`);
  }
  return _workflowDefs;
}

/** Resolve a workflow def by id with fallback to the default (software-delivery). */
function getWorkflowDef(id) {
  const defs = _workflowDefs || { [DEFAULT_WORKFLOW_DEF_ID]: FALLBACK_WORKFLOW_DEF };
  return defs[id] || defs[DEFAULT_WORKFLOW_DEF_ID] || FALLBACK_WORKFLOW_DEF;
}

// ─── Dead-session detector (TEAM-3618 D1.2) ──────────────────────────────────

/**
 * Re-dispatch a ticket through the NORMAL invocation path (claim CAS → invoke).
 * Used by the dead-session detector's retry-once step after it has stolen the
 * stale claim (status→ready). The claim CAS is the final arbiter — a live
 * concurrent claim wins and this returns false. Best-effort context build.
 */
async function redispatchTicket(workflow, ticket) {
  const agentDef = getAgentDef(ticket.assignee);
  if (!agentDef) return false;
  const claimed = await claimTicketInvocation(workflow, ticket.ticketId, ticket.assignee);
  if (!claimed) return false;
  const context = await buildAgentContext(ticket, workflow);
  await invokeAgent(agentDef, context, workflow, ticket.ticketId);
  return true;
}

// One detector per warm container so its per-agent median cache is reused
// across the 5-minute sweeps (rebuilt from scratch on a cold start).
let _detector = null;
function getDetector() {
  if (_detector) return _detector;
  _detector = createDetector({
    ddb,
    workflowsTable: WORKFLOWS_TABLE,
    eventsTable: EVENTS_TABLE,
    store,
    lease: { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS },
    getTicket,
    getAgentDef,
    publishEvent,
    redispatch: redispatchTicket,
    blockTicket: blockTicketForFailedInvoke,
  });
  return _detector;
}

// ─── Unblock cascade (TEAM-3618 D3) ──────────────────────────────────────────

// One shared cascade helper behind BOTH "ticket done" paths (Jira-webhook and
// DDB-stream), wired with the real provider/DDB/event effects. Lazy singleton
// so warm containers reuse it (mirrors getDetector()).
let _cascade = null;
function getCascade() {
  if (_cascade) return _cascade;
  _cascade = createCascade({
    ddb,
    ticketsTable: TICKETS_TABLE,
    provider: TICKET_PROVIDER,
    jiraTransition,
    getChildTickets,
    publishEvent,
    // Extended states (commit 4b) — off | shadow | enforce (TEAM-3747 D1).
    extendedStates: CASCADE_EXTENDED_STATES_MODE,
    lease: { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS },
    eventsTable: EVENTS_TABLE,
    workflowsTable: WORKFLOWS_TABLE,
    redispatch: redispatchTicket,
    reawakenGate: handleHumanReviewGate,
    // TEAM-3755 F9 — the strongly-consistent blocker confirm the extended-state
    // event path runs before it steals a lease and re-dispatches.
    getTicketConsistent,
  });
  return _cascade;
}

// ─── Missed-unblock reconciliation sweep (TEAM-3747 D1) ──────────────────────

// Periodic safety net for cascades that never fired (orchestrator crash, dropped
// stream/webhook delivery, or a stale-GSI miss past the cascade's one bounded
// retry). Reuses the cascade's reconcileDependent so the R3 invariant
// (live → nudge; stale → steal + re-dispatch) has exactly one implementation.
// Lazy singleton, same shape as getCascade()/getDetector().
let _reconcileSweep = null;
function getReconcileSweep() {
  if (_reconcileSweep) return _reconcileSweep;
  _reconcileSweep = createReconcileSweep({
    ddb,
    workflowsTable: WORKFLOWS_TABLE,
    cascade: getCascade(),
    getChildTickets,
    leaseTtlMs: LEASE_TTL_MS,
  });
  return _reconcileSweep;
}

// ─── Review-gate round cap (TEAM-3619 D2c) ───────────────────────────────────

// Bounds the review→rework loop: after `maxRounds` effective rounds the gate is
// handed to a human instead of re-opening the upstream work yet again. Lazy
// singleton, same shape as getCascade()/getDetector().
let _reviewCap = null;
function getReviewCap() {
  if (_reviewCap) return _reviewCap;
  _reviewCap = createReviewCap({
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate: addTicketComment,
    log: (msg) => console.log(`[orchestrator] ${msg}`),
  });
  return _reviewCap;
}

/**
 * Hand an escalated review gate to a human: owned by `assignee`, parked in
 * in_review, with the decision instructions on the ticket.
 *
 * The gate is the only exit from a capped loop, so the human has to be able to
 * find it AND to know the syntax that re-authorizes rework — hence the comment,
 * not just the in-app notification.
 *
 * Assignment is provider-limited: DynamoDB mode writes the assignee field for
 * real, Jira mode cannot (the ticket-tools Lambda's update_ticket only carries
 * summary/description, and Jira's assignee needs an accountId). In Jira the
 * ownership therefore lives in the comment + the review_needed notification.
 */
async function parkGateForHuman(gateTicketId, assignee, workflow) {
  if (TICKET_PROVIDER !== "jira") {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId: gateTicketId },
      UpdateExpression: "SET #s = :s, #a = :a, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#a": "assignee", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":s": "in_review",
        ":a": assignee,
        ":u": new Date().toISOString(),
      },
    }));
  }
  // Transition (idempotent), notification, review.needed event — the same path
  // the "ready" flow uses, so the board state is identical to a normal gate.
  await handleHumanReviewGate(gateTicketId, assignee, workflow);
}

/**
 * Post a comment on a ticket via the ticket-tools Lambda. Best-effort: a failed
 * comment must not fail the escalation that is already recorded and parked.
 */
async function addTicketComment(ticketId, comment) {
  if (TICKET_PROVIDER !== "jira") return false;
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      Payload: JSON.stringify({
        tool_name: "Tickets___add_comment",
        parameters: { ticket_id: ticketId, comment },
      }),
    }));
    return true;
  } catch (err) {
    console.warn(`[orchestrator] addTicketComment(${ticketId}) failed: ${err.message}`);
    return false;
  }
}

// ─── Handler (DDB Stream OR direct webhook invocation) ───────────────────────

export const handler = async (event) => {
  // Load roster + workflow defs from S3 on first invocation (cached for warm starts)
  await loadAgentRoster();
  await loadWorkflowDefs();

  // Scheduled dead-session sweep (TEAM-3618 D1.2). A rate(5 minutes) EventBridge
  // rule fires this sentinel. Branch BEFORE any stream/webhook parsing — it is a
  // synthetic invocation with no Records/source-webhook shape.
  if (event?.source === "orchestrator.sweep" && event?.action === "dead_session_sweep") {
    console.log(`[orchestrator] dead-session sweep (mode=${DEAD_SESSION_DETECTOR_MODE})`);
    return getDetector().runSweep(DEAD_SESSION_DETECTOR_MODE);
  }

  // Scheduled missed-unblock reconciliation sweep (TEAM-3747 D1). Same
  // sentinel-event pattern as the dead-session sweep above — a scheduled
  // EventBridge rule fires { source: "orchestrator.sweep",
  // action: "reconcile_sweep" }. Branch BEFORE any stream/webhook parsing.
  if (event?.source === "orchestrator.sweep" && event?.action === "reconcile_sweep") {
    console.log(`[orchestrator] reconcile sweep (mode=${RECONCILE_SWEEP_MODE})`);
    return getReconcileSweep().runSweep(RECONCILE_SWEEP_MODE);
  }

  // SQS FIFO command queue (R1 — docs/race-condition-study.md). One message
  // group per workflow root, so commands for a run arrive strictly in order
  // and never concurrently. Partial-batch failure reporting keeps a failed
  // command (and everything behind it in its group) on the queue for retry.
  if (event.Records?.[0]?.eventSource === "aws:sqs") {
    const batchItemFailures = [];
    for (let i = 0; i < event.Records.length; i++) {
      const record = event.Records[i];
      try {
        const cmd = JSON.parse(record.body);
        if (cmd.source === "jira-webhook") {
          if (TICKET_PROVIDER !== "jira") {
            console.log(`[orchestrator] Ignoring queued Jira command — TICKET_PROVIDER=${TICKET_PROVIDER}`);
            continue;
          }
          console.log(`[orchestrator] Command: ${cmd.ticketId} → ${cmd.newStatus} (group ${record.attributes?.MessageGroupId})`);
          await processStatusChange(cmd.ticketId, cmd.newStatus, cmd.oldStatus);
        } else {
          console.warn(`[orchestrator] Unknown command source "${cmd.source}" — dropping`);
        }
      } catch (err) {
        // FIFO: stop at the first failure and fail everything behind it too —
        // processing a later command past a failed one would break the very
        // per-group ordering this queue exists to provide.
        console.error(`[orchestrator] Command failed (will retry):`, err);
        for (let j = i; j < event.Records.length; j++) {
          batchItemFailures.push({ itemIdentifier: event.Records[j].messageId });
        }
        break;
      }
    }
    return { batchItemFailures };
  }

  // Direct invocation from Jira webhook (legacy path — installs without the
  // command queue; see WORKFLOW_COMMAND_QUEUE_URL on the app)
  if (event.source === "jira-webhook") {
    if (TICKET_PROVIDER !== "jira") {
      console.log(`[orchestrator] Ignoring Jira webhook — TICKET_PROVIDER=${TICKET_PROVIDER}, using DDB stream`);
      return;
    }
    console.log(`[orchestrator] Jira webhook: ${event.ticketId} → ${event.newStatus}`);
    await processStatusChange(event.ticketId, event.newStatus, event.oldStatus);
    return;
  }

  // DDB Stream invocation (TICKET_PROVIDER=dynamodb only)
  if (TICKET_PROVIDER === "jira") {
    console.log(`[orchestrator] Ignoring DDB stream — TICKET_PROVIDER=jira, using webhooks`);
    return;
  }

  console.log(`[orchestrator] Received ${event.Records.length} stream records`);

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(`[orchestrator] Error processing record:`, err);
    }
  }
};

/**
 * Unified status change handler — called from both DDB stream and Jira webhook paths.
 */
async function processStatusChange(ticketId, newStatus, oldStatus) {
  if (newStatus === oldStatus) return;

  console.log(`[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → ${newStatus}`);

  switch (newStatus) {
    case "done":
      await handleTicketDoneUnified(ticketId);
      break;
    case "blocked": {
      // A human-review gate moved to "blocked" = "Request changes". If the gate
      // is configured onReject:"rework", re-open the upstream work it reviewed.
      const rejected = await getTicket(ticketId);
      if (rejected && isHumanAssignee(rejected.assignee)) {
        await handleReviewRejection(rejected);
      }
      break;
    }
    case "todo": {
      // Ticket created — track it immediately, then route accordingly
      const todoTicket = await getTicket(ticketId);
      if (!todoTicket) return;

      // Bug bootstrap: a top-level Bug filed directly in Jira (no parent, no workflow row)
      // is a workflow root. Provision the workflow + analyst sub-task here, mirroring
      // what /api/workflow/start does for the in-app/programmatic intake path.
      if (
        TICKET_PROVIDER === "jira" &&
        todoTicket.issueType === "Bug" &&
        !todoTicket.parentId &&
        !todoTicket.workflowId
      ) {
        await bootstrapBugWorkflow(todoTicket);
        return;
      }

      // Track in agentTasks at creation time (both paths)
      await trackTicketCreation(ticketId, todoTicket.assignee, todoTicket.workflowId, todoTicket.parentId);

      if (TICKET_PROVIDER === "jira") {
        // Jira mode: the agentcore-hub-jira Lambda handles initial routing by transitioning
        // to "Ready" (no blockers) or "Blocked" (has blockers) AFTER creating links.
        // We do NOT auto-transition here — doing so races with the Lambda's link creation.
        // The "ready" webhook will arrive when the Lambda transitions the ticket.
        console.log(`[orchestrator] ${ticketId} → todo (Jira mode: waiting for Lambda to route)`);
      } else {
        // DynamoDB mode — todo with all blockers resolved means ready to go
        const blockers = todoTicket.blockedBy || [];
        const allBlockersResolved = blockers.length === 0 || await checkAllBlockersResolved(blockers);
        if (allBlockersResolved) {
          // ─── CANCEL GUARD (todo with no blockers) ───
          let guardWorkflow;
          try {
            guardWorkflow = await resolveWorkflow(todoTicket.workflowId, todoTicket.parentId);
          } catch (err) {
            console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
            return; // Fail closed
          }
          if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
            console.log(`[orchestrator] GUARD: ${ticketId} unblocked but workflow ${guardWorkflow?.id || "unknown"} is cancelled — skipping`);
            return;
          }
          // ─── END CANCEL GUARD ───
          await handleTicketReadyUnified(ticketId, todoTicket);
        }
      }
      break;
    }
    case "ready": {
      // Ticket is ready — invoke the agent
      const ticket = await getTicket(ticketId);
      if (!ticket) return;
      // ─── CANCEL GUARD (Jira webhook path) ───
      let guardWorkflow;
      try {
        guardWorkflow = await resolveWorkflow(ticket.workflowId, ticket.parentId);
      } catch (err) {
        console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
        return; // Fail closed
      }
      if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
        console.log(`[orchestrator] GUARD: Jira webhook for ${ticketId} ignored — workflow ${guardWorkflow?.id || "unknown"} is cancelled`);
        return;
      }
      // ─── END CANCEL GUARD ───
      await handleTicketReadyUnified(ticketId, ticket);
      break;
    }
    case "in_progress": {
      const ticket = await getTicket(ticketId);
      const assignee = ticket?.assignee;
      await publishEvent(ticketId, "agent.started", { ticketId, assignee, agentId: assignee });
      break;
    }
  }
}

/**
 * Unified "ticket done" handler — works with both DynamoDB and Jira backends.
 * Called from processStatusChange (Jira webhook path).
 *
 * Exported solely so done-handlers-cascade.test.mjs can drive the REAL handler
 * end-to-end through the REAL cascade (TEAM-3688). No behavior change.
 */
export async function handleTicketDoneUnified(ticketId) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;

  const parentId = ticket.parentId;
  const workflowId = ticket.workflowId;
  const assignee = ticket.assignee;

  if (!parentId) {
    console.log(`[orchestrator] ${ticketId} has no parent — likely an epic. Skipping cascade.`);
    return;
  }

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow found for ${ticketId}`);
    return;
  }

  // Dedup guard: if we already processed this ticket's completion, skip cascade.
  // Protects against double-transition (agent calls transition_ticket AND report_completion).
  if (workflow.agentTasks?.[ticketId]?.status === "complete") {
    console.log(`[orchestrator] ${ticketId} already marked complete — skipping duplicate cascade.`);
    return;
  }

  // Update agent task status — SCOPED write. A full-row put here races the
  // concurrent invocation claims of just-unblocked siblings and can resurrect
  // a pre-claim snapshot (double invocation).
  await markTaskComplete(workflow, ticketId, assignee);

  // Unblock dependents via the shared cascade (TEAM-3618 D3). The helper owns
  // the blocker predicate, provider branching, and orchestrator.unblocked
  // journal events — identical to the DDB-stream twin (handleTicketDone).
  //
  // TEAM-3684 Finding 1: guard the whole invocation. The cascade isolates
  // per-dependent errors internally, but an UNEXPECTED throw (e.g. getChildTickets
  // failing) must never skip the agent.complete publish or the completion check
  // below — otherwise a completed run could silently never be finalized. Treat a
  // cascade failure as "unblocked nothing" and proceed. (Symmetric with the
  // DDB-stream twin handleTicketDone.)
  let unblocked = [];
  try {
    unblocked = await getCascade().cascadeUnblock(ticketId, parentId, workflow);
  } catch (err) {
    console.error(`[orchestrator] cascade failed for ${ticketId} — publishing completion anyway: ${err?.message || err}`);
  }

  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // Always check workflow completion — the last ticket to close triggers this
  if (await isWorkflowComplete(parentId, workflow, assignee)) {
    await completeWorkflow(workflow);
  }
}

/** Whether an assignee refers to a human reviewer (review gate) vs an agent. */
function isHumanAssignee(assignee) {
  return typeof assignee === "string" && assignee.startsWith("human:");
}

/**
 * Atomically claim a ticket for invocation via a conditional write on
 * agentTasks[ticketId].status in the WORKFLOWS table. This is the ONE
 * invocation lock that works in both ticket providers — Jira transitions are
 * not atomic and concurrent webhook deliveries race straight through them —
 * the root cause of duplicate agent sessions and duplicate PRs (observed: the
 * same ticket invoked 3× within 3 seconds during a fix-ticket fan-out burst).
 *
 * Returns true when this caller won the claim; false when another invocation
 * already holds it (status=running). Sets status=running + startedAt in the
 * same write, so no follow-up save is needed for the task entry itself.
 */
/**
 * Mark a ticket's agentTasks entry complete with per-key writes (never a full
 * row put — completion cascades run concurrently with sibling claims).
 *
 * TEAM-3755 F3 — INVARIANT: a ticket-level "done" is NOT a lifecycle verdict.
 *
 * This function deliberately marks the task complete unconditionally, even when
 * the harvested completion record carries a SHIP_BLOCKED outcome
 * (deploy-blocked / static-ci-only). That is by design, not an oversight:
 *
 *   - A ticket status is the AGENT's report that its turn is over. The CD agent
 *     genuinely finished — it ran, it found the deploy blocked, and it said so.
 *     Diverting the ticket to a non-done status here would strand the run: the
 *     unblock cascade keys off `done` to release dependents, and completion's
 *     per-phase check requires a done agent ticket in every required phase, so a
 *     "blocked" CD ticket would wedge the epic open forever instead of closing
 *     it honestly.
 *   - The RUN-level verdict is the single enforcement point (FR-D2.1/FR-D2.2).
 *     harvestCompletionEvidence (called on the line below) lifts outcome +
 *     blockReason + mergeCommit off the S3 completion record onto
 *     agentTasks[ticketId] BEFORE completeWorkflow re-reads them, so
 *     evaluateShipVerdict sees the block in the SAME pass that this done
 *     triggered, and completeWorkflow closes the run on the honest terminal
 *     phase (claimTerminalOutcome → "deploy-blocked") instead of "complete".
 *
 * So the guarantee is: ticket done + a SHIP_BLOCKED outcome ALWAYS yields a
 * blocked terminal workflow phase, never "complete". That is what makes the
 * unconditional mark safe, and it depends on two things staying true — the
 * harvest running before the completion check, and shipVerdictOf treating only a
 * mergeCommit/explicit "shipped" as proof (TEAM-3755 F1; commitSha is the
 * unmerged branch HEAD and must never count). Both are pinned by
 * lambda/orchestrator/ticket-done-blocked-terminal.test.mjs — if you change this
 * function, that suite is the contract to keep green.
 */
async function markTaskComplete(workflow, ticketId, assignee) {
  const now = new Date().toISOString();
  const entry = {
    ...(workflow.agentTasks?.[ticketId] || {
      id: `task_${Date.now()}_${assignee}`,
      agentId: assignee,
      ticketId,
      createdAt: now,
    }),
    status: "complete",
    completedAt: now,
  };
  // Field-scoped: the webhook's metadata merge (branch/prUrl/output) can land
  // between our read and this write — a whole-entry put would erase it.
  await store.completeTaskEntry(workflow.id, ticketId, entry);
  if (!workflow.agentTasks) workflow.agentTasks = {};
  workflow.agentTasks[ticketId] = entry;
  await harvestCompletionEvidence(workflow, ticketId);
}

/**
 * Harvest deliverable evidence into agentTasks[ticketId] from the completion
 * record the agent's report_completion already writes to S3
 * (completions/{ticketId}.json — summary/branch/commit_sha/pr_url).
 *
 * The completion evidence gate (TEAM-3690, completion.mjs missingEvidenceTickets)
 * requires agentTasks output/artifactKey, but the only other writer of those
 * fields — the agent_completion webhook's metadata merge — has no live caller,
 * so every gated run stranded non-terminal with CompletionRejectedMissingEvidence
 * (first observed: wf coc7es/TEAM-3611). This closes the loop on the done
 * cascade itself: runs before completeWorkflow's fresh agentTasks re-read, so
 * the gate sees it in the same pass.
 *
 * Fills only when the entry has no evidence yet (a webhook merge that DID land
 * wins), and never throws — a missing record (human gates, legacy tickets)
 * just means the gate won't see harvested evidence for this ticket.
 */
async function harvestCompletionEvidence(workflow, ticketId) {
  if (!ARTIFACT_BUCKET) return;
  const entry = workflow.agentTasks?.[ticketId];
  const hasEvidence =
    (typeof entry?.output === "string" && entry.output.trim().length > 0) ||
    (typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0);
  // TEAM-3747 D2: the ship/CD merge-verdict gate needs the merge commit / outcome
  // signals, and a ship ticket almost ALWAYS has a summary (so hasEvidence is
  // true). Harvesting must therefore run when EITHER the deliverable evidence OR
  // the ship-verdict signal is still absent — a plain `if (hasEvidence) return`
  // would starve the ship gate and false-block every shipped run.
  const hasShipSignal =
    (typeof entry?.mergeCommit === "string" && entry.mergeCommit.trim().length > 0) ||
    (typeof entry?.commitSha === "string" && entry.commitSha.trim().length > 0) ||
    (typeof entry?.outcome === "string" && entry.outcome.trim().length > 0);
  if (hasEvidence && hasShipSignal) return;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: `completions/${ticketId}.json`,
    }));
    const record = JSON.parse(await res.Body.transformToString());
    const fields = {};
    // Deliverable evidence — only fill when absent (a webhook metadata merge that
    // DID land wins), exactly as before.
    if (!hasEvidence) {
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (summary) fields.output = summary.slice(0, 10000);
      if (record.branch) fields.branch = record.branch;
    }
    // Ship/CD verdict signals — harvested regardless of deliverable evidence,
    // each filled only when the entry doesn't already carry it (additive; legacy
    // records simply lack these keys). commit_sha/pr_url kept here too so the
    // ship gate + the final PR label can find them.
    if (record.commit_sha && !entry?.commitSha) fields.commitSha = record.commit_sha;
    if (record.pr_url && !entry?.prUrl) fields.prUrl = record.pr_url;
    if (record.merge_commit && !entry?.mergeCommit) fields.mergeCommit = record.merge_commit;
    if (typeof record.outcome === "string" && !entry?.outcome) {
      const oc = record.outcome.trim().toLowerCase();
      if (SHIP_BLOCKED_OUTCOMES.includes(oc) || oc === "shipped") fields.outcome = oc;
    }
    if (record.block_reason && !entry?.blockReason) {
      fields.blockReason = String(record.block_reason).slice(0, 500);
    }
    if (Object.keys(fields).length === 0) return;
    await store.mergeTaskMetadata(workflow.id, ticketId, fields);
    if (entry) Object.assign(entry, fields);
  } catch (err) {
    console.warn(`[orchestrator] evidence harvest skipped for ${ticketId}: ${err?.message || err}`);
  }
}

async function claimTicketInvocation(workflow, ticketId, assignee) {
  const now = new Date().toISOString();
  const taskId = workflow.agentTasks?.[ticketId]?.id || `task_${Date.now()}_${assignee}`;
  // Stale-claim escape hatch: a claim older than this is a crashed session, not
  // a live one — a human moving the ticket back to Ready on the board must be
  // able to re-dispatch without the retry endpoint. 2× the lease TTL (R3):
  // same knob as the lease-aware retry/dispatch endpoints, doubled because
  // this path has no activity signal — only the claim's age.
  const ttlMinutes = Number(process.env.WORKFLOW_LEASE_TTL_MINUTES);
  const leaseTtlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60_000;
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MULTIPLIER * leaseTtlMs).toISOString();
  // TEAM-3698: drop any deadSessionDetectedAt from the PRIOR generation — this
  // is a new claim (new startedAt), so a stamp carried over would make the
  // dead-session detector skip it as "already handled" forever. The store
  // strips it on the write too (R2, sole writer); this keeps the in-memory
  // snapshot handed back to the caller honest.
  const { deadSessionDetectedAt: _priorStamp, ...priorEntry } = workflow.agentTasks?.[ticketId] || {};
  const entry = {
    ...priorEntry,
    id: taskId,
    agentId: assignee,
    ticketId,
    status: "running",
    startedAt: now,
  };
  const claimed = await store.claimInvocation(workflow.id, ticketId, entry, staleBefore);
  if (claimed) {
    if (!workflow.agentTasks) workflow.agentTasks = {};
    workflow.agentTasks[ticketId] = entry;
  }
  return claimed;
}

/**
 * A review-gate ticket became ready (its upstream work is done). Instead of
 * invoking an agent, park it for a human and emit a review_needed notification.
 * The ticket sits in "in_review"; downstream tickets that list it in blockedBy
 * stay blocked until a person transitions it to "done" (approve) — the existing
 * cascade then continues. Returns true if the ticket was handled as a gate.
 */
async function handleHumanReviewGate(ticketId, assignee, workflow) {
  const reviewer = assignee.slice("human:".length);

  // Park the ticket in "in_review" (idempotent — setting it again is a no-op).
  if (TICKET_PROVIDER === "jira") {
    await jiraTransition(ticketId, "In Review");
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "in_review", ":u": new Date().toISOString() },
    }));
  }

  // Idempotency is tracked on the SIDE EFFECT (the notification), not the ticket
  // status — the status write and the notification aren't atomic, so a redelivery
  // after a status-write-but-save-failure must still create the missing one.
  // Only notify when no unacknowledged review_needed already exists.
  //
  // TEAM-3684 Finding 2: the open-notification check + append must be ATOMIC, not
  // a scan of the passed-in (possibly stale) snapshot. Concurrent last-blocker
  // completions re-wake the same gate from separate stale copies; the store's
  // appendReviewNotificationOnce runs the check under the notifVersion CAS so
  // exactly one caller appends. It returns whether THIS call notified, which the
  // cascade's re-wake uses to publish review.reawakened at most once.
  let notified = false;
  if (workflow) {
    // Review package: the upstream agent that closed the phase wrote a curated
    // summary/bullets/links file (blueprints/review-package.md). Best-effort —
    // a missing or malformed package must never delay the gate ping.
    const pkg = await loadReviewPackage(workflow, ticketId);

    const notification = {
      id: `notif_${ticketId}_${new Date().toISOString()}`,
      type: "review_needed",
      title: `Review needed: ${ticketId}`,
      details: pkg?.summary || `Ticket ${ticketId} is awaiting review by ${reviewer}.`,
      ticketId,
      reviewer,
      ...(pkg ? { summary: pkg.summary, bullets: pkg.bullets, links: pkg.links, gate: pkg.gate } : {}),
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };
    notified = await store.appendReviewNotificationOnce(workflow.id, ticketId, notification);
    if (notified && Array.isArray(workflow.humanNotifications)) {
      workflow.humanNotifications.push(notification); // keep the in-memory copy consistent
    }
    if (!notified) {
      console.log(`[orchestrator] ${ticketId} already has an open review notification — skipping duplicate.`);
      return false;
    }

    // Mirror the package onto the gate ticket so the dashboard reviewer sees
    // the same context when they open it (Jira: comment; DDB: comment row).
    // Only the caller that actually appended attaches — a losing CAS racer
    // returned above, so redeliveries can't double-comment the ticket.
    if (pkg) {
      try { await attachPackageToTicket(ticketId, pkg); }
      catch (err) { console.warn(`[orchestrator] could not attach review package to ${ticketId}: ${err.message}`); }
    }
  }

  await publishEvent(ticketId, "review.needed", {
    ticketId, reviewer, workflowId: workflow?.id,
  });
  console.log(`[orchestrator] ${ticketId} parked for human review (${reviewer}) — not invoking an agent.`);
  return notified;
}

/**
 * Load the review package the pre-gate agent wrote for this gate
 * (shared/review-package-<phase>.json). The gate's phase comes from the agent
 * tickets it is blockedBy — same resolution as handleReviewRejection. Returns
 * a validated {gate, summary, bullets, links} or null; never throws.
 */
async function loadReviewPackage(workflow, gateTicketId) {
  try {
    const gateTicket = await getTicket(gateTicketId);
    let phase;
    for (const upId of gateTicket?.blockedBy || []) {
      const up = await getTicket(upId);
      const def = up && getAgentDef(up.assignee);
      if (def?.phase) { phase = def.phase; break; }
    }
    if (!phase || !ARTIFACT_BUCKET) return null;

    // Parallel pre-gate agents (design) each write their own
    // review-package-<phase>.<agentId>.json — read-merge-write on one shared
    // object would lose updates. Merge every matching file here instead.
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACT_BUCKET,
      Prefix: `workflows/${workflow.id}/shared/review-package-${phase}`,
    }));
    const keys = (listed.Contents || [])
      .map((o) => o.Key)
      .filter((k) => k.endsWith(".json"))
      .sort(); // deterministic merge order across redeliveries
    const parts = [];
    for (const key of keys) {
      const raw = await readS3Artifact(workflow.id, key.replace(`workflows/${workflow.id}/`, ""));
      if (!raw) continue;
      try {
        const p = JSON.parse(raw);
        if (typeof p.summary === "string" && p.summary.trim()) parts.push(p);
      } catch { /* one malformed part must not sink the rest */ }
    }
    if (!parts.length) return null;

    const merged = {
      summary: parts.map((p) => p.summary.trim()).join(" · "),
      bullets: parts.flatMap((p) => (Array.isArray(p.bullets) ? p.bullets : [])),
      links: parts.flatMap((p) => (Array.isArray(p.links) ? p.links : [])),
    };
    // Clamp to the contract so a rambling agent can't flood the ping: bullets
    // are one-liners, links carry either an in-run artifactKey or an https url.
    // Multi-part merges get proportionally wider caps, still phone-sized.
    const maxBullets = Math.min(6 * parts.length, 10);
    const maxLinks = Math.min(4 * parts.length, 8);
    const seen = new Set();
    const bullets = merged.bullets
      .filter((b) => typeof b === "string" && b.trim())
      .map((b) => b.trim().slice(0, 200))
      .slice(0, maxBullets);
    const links = merged.links
      .filter((l) => l && typeof l.label === "string" &&
        (typeof l.url === "string" && /^https:\/\//.test(l.url) ||
         typeof l.artifactKey === "string" && l.artifactKey.startsWith(`workflows/${workflow.id}/`)))
      .map((l) => ({
        label: l.label.trim().slice(0, 60),
        ...(l.url ? { url: l.url } : { artifactKey: l.artifactKey }),
      }))
      .filter((l) => {
        const target = l.url || l.artifactKey;
        if (seen.has(target)) return false; // designers may all link the same shared doc
        seen.add(target);
        return true;
      })
      .slice(0, maxLinks);
    return { gate: phase, summary: merged.summary.slice(0, 500), bullets, links };
  } catch (err) {
    console.warn(`[orchestrator] review package load failed for ${gateTicketId}: ${err.message}`);
    return null;
  }
}

/** Post the review package onto the gate ticket as a comment (both providers). */
async function attachPackageToTicket(ticketId, pkg) {
  const lines = [
    `Review package — ${pkg.summary}`,
    ...pkg.bullets.map((b) => `• ${b}`),
    ...pkg.links.map((l) => `→ ${l.label}: ${l.url || l.artifactKey}`),
  ];
  const text = lines.join("\n");
  if (TICKET_PROVIDER === "jira") {
    await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
      body: {
        type: "doc", version: 1,
        content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
      },
    });
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :n), #u = :u",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":n": [{ id: `comment-${Date.now()}`, author: "orchestrator", content: text, timestamp: new Date().toISOString() }],
        ":empty": [],
        ":u": new Date().toISOString(),
      },
    }));
  }
}

/**
 * Post a plain-text comment on a ticket, either provider (TEAM-3756 F3b audit
 * trail). Same write shapes as attachPackageToTicket; throws to the caller —
 * every current caller treats the comment as best-effort and catches.
 */
async function commentOnTicket(ticketId, text) {
  const lines = String(text).split("\n");
  if (TICKET_PROVIDER === "jira") {
    await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
      body: {
        type: "doc", version: 1,
        content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
      },
    });
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :n), #u = :u",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":n": [{ id: `comment-${Date.now()}`, author: "orchestrator", content: String(text), timestamp: new Date().toISOString() }],
        ":empty": [],
        ":u": new Date().toISOString(),
      },
    }));
  }
}

/**
 * PR url for the change set under review (TEAM-3748 D3) — CONFIDENT matches
 * only (TEAM-3756 F2). Resolution order:
 *
 *   1. the gate ticket's own prUrl — the provider explicitly forwarded the PR
 *      this gate reviews;
 *   2. a task entry whose recorded head (commitSha/mergeCommit, harvested off
 *      the completion record) EQUALS the gate's reviewedHeadSha — that PR is
 *      the one whose head the reviewer looked at, by definition;
 *   3. the ship-phase ticket's PR (the integration PR the ship review is of),
 *      but only when it is UNAMBIGUOUS — exactly one distinct prUrl across the
 *      run's ship-phase task entries (reviewed-upstream ship entries preferred).
 *
 * The old "any task's prUrl" fallback is deliberately GONE: a stale per-ticket
 * feature-PR url harvested onto an upstream dev task could win over the actual
 * ship/integration PR, so the change set was computed from the WRONG diff —
 * genuine findings then classified out-of-diff and the reopen was suppressed.
 * Scoping against the wrong PR is strictly worse than not scoping at all:
 * returning "" fails OPEN (changeSet stays null → enforceDiffScope stays inert →
 * every finding gates), which can never suppress a genuine rework round.
 */
function resolvePrUrlForReview(workflow, gateTicket, upstream) {
  const direct =
    gateTicket.prUrl || gateTicket.metadata?.prUrl ||
    gateTicket.pr_url || gateTicket.metadata?.pr_url;
  if (typeof direct === "string" && direct) return direct;

  const tasks = workflow?.agentTasks || {};
  const upIds = new Set((upstream || []).map((u) => u.ticketId));
  const entries = Object.entries(tasks).filter(
    ([, e]) => e && typeof e.prUrl === "string" && e.prUrl
  );

  // 2. Head-SHA match — the PR whose recorded head IS what the reviewer reviewed.
  const reviewedHeadSha = gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null;
  if (reviewedHeadSha) {
    for (const preferUpstream of [true, false]) {
      for (const [tid, e] of entries) {
        if (preferUpstream !== upIds.has(tid)) continue;
        if (e.commitSha === reviewedHeadSha || e.mergeCommit === reviewedHeadSha) return e.prUrl;
      }
    }
  }

  // 3. The ship ticket's integration PR — only when there is exactly one to name.
  for (const upstreamOnly of [true, false]) {
    const shipUrls = new Set();
    for (const [tid, e] of entries) {
      if (upstreamOnly && !upIds.has(tid)) continue;
      if (getAgentDef(e.agentId)?.phase === "ship") shipUrls.add(e.prUrl);
    }
    if (shipUrls.size === 1) return [...shipUrls][0];
    if (shipUrls.size > 1) break; // ambiguous even among upstream → widening can't help
  }

  return "";
}

/**
 * Compute the PR's change set — the `--name-status`-equivalent file list the
 * diff-scoped ship review scopes against (TEAM-3748 D3, FR-D3.1). This is the
 * "gate plumbing" release-manager.md Step 4 waits on: it lets the deterministic
 * enforceDiffScope activate so review is scoped to what the PR actually changed
 * instead of the whole assembled repo.
 *
 * FAIL-OPEN by contract (R4): a missing/unrecognized PR url or ANY GitHub error
 * returns null. A null change set is passed to enforce as undefined, which keeps
 * enforceDiffScope inert and the rework loop byte-identical to its pre-guard
 * behavior — the diff-scope gate must never be able to WEDGE a review, only
 * narrow it when the diff is knowable. Renames contribute BOTH paths, matching
 * enforceDiffScope's rename handling.
 */
async function computeReviewChangeSet(prUrl) {
  const m = String(prUrl || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, number] = m;
  try {
    const files = await callGitHub("list_pr_files", { owner, repo, pull_number: Number(number) });
    if (!Array.isArray(files) || files.length === 0) return null;
    const paths = [];
    for (const f of files) {
      if (typeof f?.filename === "string" && f.filename) paths.push(f.filename);
      // A rename cites both endpoints; enforceDiffScope treats each as in-diff.
      if (typeof f?.previous_filename === "string" && f.previous_filename) paths.push(f.previous_filename);
    }
    return paths.length ? paths : null;
  } catch (err) {
    console.warn(`[orchestrator] change-set fetch skipped for ${prUrl}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Structured review findings are USABLE for diff-scoping only when every entry
 * is an object and at least ONE cites a resolvable file (TEAM-3756 F1). The
 * threshold matters because of which way each failure cuts: findings that gate
 * spuriously merely keep legacy behavior, but findings that classify all-advisory
 * SUPPRESS a reopen — so prose-only findings (nobody cited files) must never be
 * treated as a classification, or every human rejection would read as advisory.
 */
function usableReviewFindings(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  if (!arr.every((f) => f && typeof f === "object" && !Array.isArray(f))) return false;
  return arr.some((f) => {
    const files = Array.isArray(f.citedFiles) ? f.citedFiles : Array.isArray(f.files) ? f.files : [];
    return files.some((p) => typeof p === "string" && p.trim());
  });
}

/**
 * Derive the reviewer's classified findings when the gate ticket does not carry
 * them (TEAM-3756 F1) — the same "compute it in the Lambda" pattern as
 * computeReviewChangeSet, closing the gap that left the diff-scoped gate DORMANT
 * in production (nothing ever wrote gateTicket.reviewFindings, so `gated` was
 * always true and FR-D3.2/D3.3 never fired).
 *
 * Two sources, in order:
 *   1. a fenced JSON block in the rejection feedback itself — `{"findings": [...]}`
 *      or a bare findings array — for a reviewer/agent that pastes its
 *      classification into the comment;
 *   2. the release manager's own round ledger,
 *      workflows/{id}/shared/ship-review-state.json — blueprint Step 4.1 has it
 *      record every round's `findings` (each with `citedFiles`) precisely "so the
 *      ledger is already correct for when the deterministic layer is switched
 *      on". Only the LATEST round is trusted, only when its verdict is
 *      CHANGES-NEEDED (this rejection is that verdict's delivery), and only when
 *      its reviewedHeadSha does not CONTRADICT the gate's (both known and
 *      different = the ledger describes some other round — use nothing).
 *
 * Returns null when neither source yields usable findings: the caller passes
 * null through and the diff-scoped gate stays inert (fail-open, R4) — exactly
 * the pre-derivation behavior.
 */
async function deriveReviewFindings(workflow, gateTicket, feedback) {
  // 1. Fenced JSON in the feedback.
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(String(feedback || ""))) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : null;
      if (usableReviewFindings(arr)) return arr;
    } catch { /* not JSON — keep scanning */ }
  }

  // 2. The release manager's recorded round.
  const raw = await readS3Artifact(workflow.id, "shared/ship-review-state.json");
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  const rounds = (Array.isArray(state?.rounds) ? state.rounds : []).filter(
    (r) => r && typeof r === "object"
  );
  if (!rounds.length) return null;
  const latest = rounds.reduce((a, b) => (Number(b.round) > Number(a.round) ? b : a));
  if (latest.verdict !== "CHANGES-NEEDED") return null;
  const gateSha = gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null;
  if (gateSha && latest.reviewedHeadSha && latest.reviewedHeadSha !== gateSha) return null;
  return usableReviewFindings(latest.findings) ? latest.findings : null;
}

/**
 * A human "requested changes" on a review-gate ticket (moved it to blocked).
 * Look up the gate's config for the run; if onReject is "rework", re-open the
 * upstream agent tickets this gate reviewed (its blockedBy) so the agents redo
 * the work with the reviewer's comment as resume context. "hold" → just pause.
 */
export async function handleReviewRejection(gateTicket) {
  const workflow = await resolveWorkflow(gateTicket.workflowId, gateTicket.parentId);
  if (!workflow) return;

  // Acknowledge this gate's open review notification — the review concluded, and
  // clearing it lets a later cycle (after rework) create a fresh notification.
  // Persisted via CAS: the previous in-memory-only mutation never landed, so
  // every rework cycle was blocked from creating its fresh notification.
  if (Array.isArray(workflow.humanNotifications)) {
    for (const n of workflow.humanNotifications) {
      if (n.ticketId === gateTicket.ticketId && n.type === "review_needed") n.acknowledged = true;
    }
    await store.ackNotifications(
      workflow.id,
      (n) => n.ticketId === gateTicket.ticketId && n.type === "review_needed"
    );
  }

  // The gate's blockedBy lists the agent tickets it reviewed. Their shared agent
  // phase is the gate's `afterPhase` — match the SPECIFIC gate by phase (a
  // reviewer may guard multiple phases with different onReject policies).
  const upstreamIds = gateTicket.blockedBy || [];
  const upstream = [];
  for (const upId of upstreamIds) {
    const up = await getTicket(upId);
    if (up && getAgentDef(up.assignee)) upstream.push(up); // agent tickets only
  }
  const gatePhase = upstream.length ? getAgentDef(upstream[0].assignee)?.phase : undefined;

  const wfDef = getWorkflowDef(workflow.workflowDefId);
  const gateCfg =
    (wfDef.reviewGates || []).find((g) => g.afterPhase === gatePhase) || null;
  const onReject = gateCfg?.onReject || "rework"; // default keeps work moving

  if (onReject !== "rework") {
    console.log(`[orchestrator] Review gate ${gateTicket.ticketId} rejected (hold) — workflow paused.`);
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId, onReject, workflowId: workflow.id,
    });
    return;
  }

  // Reviewer feedback: persisted reviewComment (set at transition time) → latest
  // comment → generic fallback. Stash it in workflow.resumeContexts keyed by
  // ticket so BOTH backends surface it on re-invocation (Jira tickets can't carry
  // arbitrary columns; the workflow row always lives in DynamoDB).
  const feedback =
    gateTicket.reviewComment ||
    (gateTicket.comments || []).slice(-1)[0]?.content ||
    "Reviewer requested changes.";

  // Convergence cap (TEAM-3619 D2c) — BEFORE any rework side effect. Records
  // this rejection as a review round and, once the gate's effective round count
  // reaches its `maxRounds`, hands the gate to a human and stops the loop here:
  // no resume contexts, no re-open, no further automatic cycles. A human's own
  // transition still works (approving the gate continues the flow; an explicit
  // `DECISION: continue` in a later rejection re-authorizes rework), so this
  // suppresses only the AUTOMATIC re-open.
  //
  // reviewedHeadSha is best-effort: the orchestrator doesn't track the PR head,
  // so it is normally absent and every rejection is therefore its own round.
  // When a provider does carry it, re-reviewing the same SHA reuses that round.
  //
  // Diff-scoped gate (TEAM-3689 scaffolding, activated by TEAM-3748 D3): changeSet
  // is the PR's file list and reviewFindings are the reviewer's classified findings
  // (each with its cited files). Each comes off the gate ticket if a provider
  // forwarded it, ELSE the orchestrator computes/derives it itself — the change
  // set from the PR diff (D3), the findings from the feedback's JSON block or the
  // release manager's recorded round (TEAM-3756 F1). When BOTH are known,
  // review-cap downgrades out-of-diff findings and reports `gated: false` for a
  // rejection whose findings are ALL out-of-diff, which must neither count toward
  // the cap nor re-open upstream work. Absent either input the guard stays inert
  // and behavior is byte-identical to before (R4).
  let changeSet = gateTicket.changeSet || gateTicket.metadata?.changeSet || null;
  let reviewFindings = gateTicket.reviewFindings || gateTicket.metadata?.reviewFindings || null;
  // D3 (TEAM-3748, FR-D3.1): when the event carries no change set, compute it
  // from the PR diff so review is scoped to what the PR changed rather than the
  // whole assembled repo. Fail-open — no PR / GitHub error leaves changeSet null,
  // which keeps enforceDiffScope inert and the loop byte-identical to legacy (R4).
  if (!Array.isArray(changeSet)) {
    const prUrl = resolvePrUrlForReview(workflow, gateTicket, upstream);
    changeSet = (prUrl && (await computeReviewChangeSet(prUrl))) || null;
  }
  // TEAM-3756 F1: derive the classified findings the same way — but only when a
  // change set exists to scope against (without one the findings are never read,
  // so the S3 lookup would be a wasted call on every legacy rejection).
  if (!Array.isArray(reviewFindings) && Array.isArray(changeSet)) {
    reviewFindings = await deriveReviewFindings(workflow, gateTicket, feedback);
  }
  const capResult = await getReviewCap().enforce({
    workflow,
    gateTicket,
    gateCfg: gateCfg ? { ...gateCfg, afterPhase: gateCfg.afterPhase ?? gatePhase } : gateCfg,
    upstreamIds: upstream.map((up) => up.ticketId),
    feedback,
    reviewedHeadSha: gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null,
    changeSet,
    findings: reviewFindings,
  });
  if (capResult.escalated) {
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId,
      onReject,
      reopened: [],
      workflowId: workflow.id,
      capReached: true,
      effectiveRounds: capResult.effectiveRounds,
      maxRounds: capResult.maxRounds,
    });
    return;
  }

  // Diff-scoped gate (TEAM-3689): a CHANGES-NEEDED verdict whose only findings
  // cite files OUTSIDE the recorded change set is non-gating — it must NOT
  // re-open upstream work. `gated` is true whenever there is no change set to
  // scope against, so this branch is inert for old ledgers.
  //
  // TEAM-3756 F3b — the non-gating rejection gets a DEFINED next state:
  // APPROVE-WITH-ADVISORY. Before, this branch published the event and returned,
  // leaving the gate in `blocked` with nothing scheduled to touch it again — a
  // silent stall. Auto-approving is the blueprint's own verdict, not an
  // override of the human: with F3a, `gated:false` is reachable ONLY when every
  // finding AFFIRMATIVELY cites out-of-diff files (unattributed/prose findings
  // now gate), and Step 4's rule for exactly that state is
  // PASS-with-known-findings — "Never let an advisory finding flip PASS to
  // CHANGES NEEDED". Chosen over the cap-escalation primitive because
  // escalation means "a human must decide"; here the deterministic gate HAS
  // decided, and parking it would recreate the same stall one hop later. The
  // done transition takes the identical path a human approval takes (DDB
  // stream / Jira webhook → done cascade), so dependents unblock through the
  // one existing machinery. A reviewer who wants to force rework can: any
  // finding without out-of-diff citations gates.
  if (capResult.gated === false) {
    console.log(
      `[orchestrator] Review gate ${gateTicket.ticketId} rejected but all findings are out-of-diff (advisory) — ` +
        `approving with known findings instead of reopening.`
    );
    // Audit trail first: the advisory findings land on the ticket even if the
    // transition below fails (best-effort — a comment failure must not stall
    // the approval this branch exists to guarantee).
    const advisoryLines = (Array.isArray(reviewFindings) ? reviewFindings : []).map((f) => {
      const files = Array.isArray(f?.citedFiles) ? f.citedFiles : Array.isArray(f?.files) ? f.files : [];
      const label = f?.title || f?.summary || f?.severity || "finding";
      return `• ${label} — cites ${files.join(", ") || "(no files)"} (outside the PR change set)`;
    });
    try {
      await commentOnTicket(
        gateTicket.ticketId,
        `Auto-approved with known findings: the reviewer requested changes, but every finding cites ` +
          `files outside the PR change set (advisory — release-manager.md Step 4). ` +
          `No rework round was recorded and upstream work was not reopened.\n` +
          `Advisory findings (filed for audit, not gating):\n${advisoryLines.join("\n")}`
      );
    } catch (err) {
      console.warn(`[orchestrator] advisory audit comment failed for ${gateTicket.ticketId}: ${err?.message || err}`);
    }
    // Approve: the same transition a human approval makes, so the done cascade
    // (unblock dependents, completion checks) runs through the normal path.
    try {
      if (TICKET_PROVIDER === "jira") {
        await jiraTransition(gateTicket.ticketId, "Done");
      } else {
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId: gateTicket.ticketId },
          UpdateExpression: "SET #s = :s, #u = :u",
          ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
          ExpressionAttributeValues: { ":s": "done", ":u": new Date().toISOString() },
        }));
      }
      await publishEvent(gateTicket.ticketId, "review.approved_with_advisory", {
        ticketId: gateTicket.ticketId,
        workflowId: workflow.id,
        advisoryFindings: Array.isArray(reviewFindings) ? reviewFindings : [],
      });
    } catch (err) {
      // The approval could not land — surface loudly; the review.rejected event
      // below still records the non-gating verdict for observability.
      console.error(`[orchestrator] auto-approve failed for ${gateTicket.ticketId}: ${err?.message || err}`);
    }
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId,
      onReject,
      reopened: [],
      workflowId: workflow.id,
      noInDiffFindings: true,
    });
    return;
  }

  // Persist each ticket's feedback atomically (per-key, no full-row put) BEFORE
  // reopening, so a fast re-invocation always finds its resume context.
  const reopened = [];
  for (const up of upstream) {
    // Surface the agent's prior coding session so it can CHOOSE to continue
    // that conversation (claude_code/codex resume_session=...) instead of
    // rebuilding context. Scope, not a command — the resume decision is the
    // agent's (fresh may be right if the feedback says start over).
    const priorSession = await findCodingSession(workflow.id, up.assignee);
    const sessionHint = priorSession
      ? `\n\nYour previous coding session for this work: ${priorSession}. ` +
        `DEFAULT: pass it as resume_session on your first claude_code/codex/kiro call — it continues that ` +
        `conversation with its context intact. Start fresh only if the feedback demands a restart. Resume is best-effort.`
      : "";
    const resumeNote = `## Review feedback (changes requested)\n${feedback}\n\nAddress this feedback and redo your work.${sessionHint}`;
    await store.setResumeContext(workflow.id, up.ticketId, resumeNote);
    reopened.push(up.ticketId);
  }

  // Re-open each upstream ticket so its agent re-runs. Done has no direct path to
  // Ready — in Jira it must hop Done → To Do (Reopen) → Ready.
  //
  // TEAM-3684 Finding 3 (converse risk, ACCEPTED): the cascade reads the sibling
  // statuses from the eventually-consistent parentId-index GSI. A reopen here
  // (done → todo) that hasn't yet propagated to that GSI could let a racing
  // cascadeUnblock still observe this blocker as "done" and PREMATURELY Ready a
  // dependent. This is the mirror of the missed-last-unblock the cascade's
  // bounded re-fetch guards against, and it is deliberately NOT handled: a
  // premature Ready is self-correcting (the reopened blocker re-blocks and the
  // agent re-runs), whereas the missed unblock is terminal. Documented so the
  // asymmetry is a choice, not an oversight.
  //
  // TEAM-3619 D4c: stamp the re-opened ticket as a review-fix routed under the
  // gated phase (`spawnedBy` + `phase`). `isWorkflowComplete` then treats this
  // as an open fix under `gatePhase`, so the run cannot be declared complete
  // while a rework cycle is in flight — even if the gate ticket itself is done.
  // (Jira tickets can't carry arbitrary columns; the reopen path re-derives
  // phase from the assignee and the workflow row records the round, so the DDB
  // stamp is where this metadata lands.)
  const spawnedBy = { gateTicketId: gateTicket.ticketId, kind: "review_fix" };
  for (const up of upstream) {
    if (TICKET_PROVIDER === "jira") {
      await jiraReopenToReady(up.ticketId);
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId: up.ticketId },
        UpdateExpression: "SET #s = :s, #u = :u, spawnedBy = :sb" + (gatePhase ? ", #ph = :ph" : ""),
        ExpressionAttributeNames: {
          "#s": "status",
          "#u": "updatedAt",
          ...(gatePhase ? { "#ph": "phase" } : {}),
        },
        ExpressionAttributeValues: {
          ":s": "todo",
          ":u": new Date().toISOString(),
          ":sb": spawnedBy,
          ...(gatePhase ? { ":ph": gatePhase } : {}),
        },
      }));
    }
  }
  console.log(`[orchestrator] Review gate ${gateTicket.ticketId} rejected (rework) — re-opened: [${reopened.join(", ")}]`);
  await publishEvent(gateTicket.ticketId, "review.rejected", {
    ticketId: gateTicket.ticketId, onReject, reopened, workflowId: workflow.id,
  });
}

/**
 * Most recent Cloud Code session for (workflow, agent) — the runtime records
 * one row per agent-task (origin "workflow"). Used only to HINT the reworking
 * agent about its prior session; null on any failure (hint is optional).
 */
async function findCodingSession(workflowId, agentId) {
  if (!workflowId || !agentId) return null;
  try {
    const res = await ddb.send(new ScanCommand({
      TableName: CLOUD_CODE_TABLE,
      FilterExpression: "workflowId = :w AND agentId = :a AND #or = :o",
      ExpressionAttributeNames: { "#or": "origin" },
      ExpressionAttributeValues: { ":w": workflowId, ":a": agentId, ":o": "workflow" },
      ProjectionExpression: "sessionId, updatedAt",
    }));
    const rows = (res.Items || []).sort((x, y) =>
      String(y.updatedAt || "").localeCompare(String(x.updatedAt || "")));
    return rows[0]?.sessionId || null;
  } catch (err) {
    console.warn(`[orchestrator] findCodingSession failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Consume any pending rework feedback for a ticket: returns the resume note and
 * clears it from the workflow's resumeContexts map. Backend-agnostic — the
 * workflow row lives in DynamoDB regardless of TICKET_PROVIDER.
 */
async function consumeResumeContext(workflow, ticketId) {
  const note = workflow.resumeContexts?.[ticketId];
  if (!note) return null;
  delete workflow.resumeContexts[ticketId];
  await store.removeResumeContext(workflow.id, ticketId);
  return note;
}

/**
 * Unified "ticket ready" handler — works with both backends.
 * Called from processStatusChange (Jira webhook path).
 */
async function handleTicketReadyUnified(ticketId, ticket) {
  const assignee = ticket.assignee;
  const parentId = ticket.parentId;
  const workflowId = ticket.workflowId;

  console.log(`[orchestrator] handleTicketReady: ${ticketId} assignee=${assignee} parentId=${parentId} workflowId=${workflowId}`);

  if (!assignee || ticket.type === "epic") return;

  // Human-review gate: park for a person instead of invoking an agent.
  if (isHumanAssignee(assignee)) {
    const gateWorkflow = await resolveWorkflow(workflowId, parentId);
    if (gateWorkflow && gateWorkflow.phase === "cancelled") return;
    await handleHumanReviewGate(ticketId, assignee, gateWorkflow);
    return;
  }

  const agentDef = getAgentDef(assignee);
  if (!agentDef) {
    console.warn(`[orchestrator] Unknown agent: ${assignee}`);
    return;
  }

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow for ticket ${ticketId}`);
    return;
  }

  // ─── CANCEL GUARD (defense-in-depth) ───
  if (workflow.phase === "cancelled") {
    console.log(`[orchestrator] GUARD (handleTicketReadyUnified): workflow ${workflow.id} is cancelled — not invoking ${assignee}`);
    return;
  }
  // ─── END CANCEL GUARD ───

  // Idempotency claim — ATOMIC, backend-agnostic. The workflow row lives in
  // DynamoDB in BOTH modes, so a conditional write on agentTasks[ticketId].status
  // is the real lock. Jira transitions are NOT a guard: concurrent webhook
  // deliveries each see "Ready" and each proceed — that is exactly how duplicate
  // agent sessions (and duplicate PRs) were spawned. Claim BEFORE any transition.
  const claimed = await claimTicketInvocation(workflow, ticketId, assignee);
  if (!claimed) {
    console.log(`[orchestrator] ${ticketId} already claimed (running) — skipping duplicate invocation`);
    return;
  }

  if (TICKET_PROVIDER === "jira") {
    await jiraTransition(ticketId, "In Progress");
  } else {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ConditionExpression: "#s <> :inprog",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "in_progress", ":inprog": "in_progress", ":u": new Date().toISOString() },
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`[orchestrator] ${ticketId} already in_progress — skipping duplicate invocation`);
        return;
      }
      throw err;
    }
  }

  // Initialize manifest if needed
  try { await initManifestIfNeeded(workflow); } catch (err) {
    console.warn(`[orchestrator] Manifest init failed (non-fatal): ${err.message}`);
  }

  // Phase advancement (workflow-def driven, with software-delivery fallback)
  const wfDef = getWorkflowDef(workflow.workflowDefId);
  const phaseOrder = wfDef.phaseOrder;
  const agentPhaseIdx = phaseOrder.indexOf(agentDef.phase);
  const currentPhaseIdx = phaseOrder.indexOf(workflow.phase);
  if (agentPhaseIdx > currentPhaseIdx) {
    workflow.phase = agentDef.phase;
    await publishEvent(ticketId, "workflow.phase_change", { phase: agentDef.phase, workflowId: workflow.id });

    // Feature branch on the def's branch phase entry (repo-backed workflows only)
    if (wfDef.featureBranchPhase && agentDef.phase === wfDef.featureBranchPhase && !workflow.featureBranch && workflow.repoConfig?.repos?.length > 0) {
      workflow.featureBranch = await ensureFeatureBranch(workflow);
    }

    await store.advancePhase(workflow.id, workflow.phase, workflow.featureBranch);
  }

  // Build context and invoke — SAME buildAgentContext for both paths
  let context = await buildAgentContext(ticket, workflow);

  // Prepend resume context if the agent is re-running: either from the retry
  // endpoint (ticket.resumeContext, DDB-only) or a review-gate rework (workflow
  // resumeContexts map, backend-agnostic). Both are one-time use.
  const reworkNote = await consumeResumeContext(workflow, ticketId);
  let resumed = false;
  if (ticket.resumeContext) {
    context = `${ticket.resumeContext}\n\n---\n\n${context}`;
    resumed = true;
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "REMOVE #rc",
      ExpressionAttributeNames: { "#rc": "resumeContext" },
    }));
  }
  if (reworkNote) {
    context = `${reworkNote}\n\n---\n\n${context}`;
    resumed = true;
  }

  console.log(`[orchestrator] Invoking agent ${assignee} for ticket ${ticketId}${resumed ? " (SESSION RESUME)" : ""}`);
  await publishEvent(ticketId, "agent.invoked", { ticketId, assignee, agentId: assignee, phase: agentDef.phase, workflowId: workflow.id });

  await invokeAgent(agentDef, context, workflow, ticketId);
}

/**
 * Transition a Jira issue to a target status. Returns true if the transition
 * was applied (HTTP ok), false otherwise — callers that chain transitions rely
 * on this to avoid leaving a ticket stranded mid-hop.
 */
async function jiraTransition(issueKey, targetStatusName) {
  try {
    const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
    const match = data.transitions.find(
      t => t.name.toLowerCase() === targetStatusName.toLowerCase() ||
           t.to.name.toLowerCase() === targetStatusName.toLowerCase()
    );
    if (!match) {
      console.warn(`[orchestrator] No transition to "${targetStatusName}" for ${issueKey}`);
      return false;
    }
    const url = `https://${JIRA_SITE_URL}/rest/api/3/issue/${issueKey}/transitions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!resp.ok) {
      console.warn(`[orchestrator] Jira transition to "${targetStatusName}" for ${issueKey} returned ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[orchestrator] Jira transition failed for ${issueKey}: ${err.message}`);
    return false;
  }
}

/**
 * Reopen a Done Jira ticket to Ready as a verified two-hop (Done → To Do →
 * Ready). Jira fires a webhook per hop and ordering isn't guaranteed, so we only
 * proceed to Ready after To Do is confirmed, and retry Ready briefly. Returns
 * true once the ticket is Ready. Avoids a silent stall when the 2nd hop fails.
 */
async function jiraReopenToReady(issueKey) {
  // Hop 1: Done → To Do. Retry a couple times in case the transition list is
  // momentarily stale right after the gate's own transition.
  let toTodo = false;
  for (let i = 0; i < 3 && !toTodo; i++) {
    toTodo = await jiraTransition(issueKey, "To Do");
    if (!toTodo) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!toTodo) {
    console.error(`[orchestrator] Reopen ${issueKey}: could not reach To Do — ticket left as-is.`);
    return false;
  }
  // Hop 2: To Do → Ready. This fires the "ready" webhook that re-invokes the agent.
  let toReady = false;
  for (let i = 0; i < 3 && !toReady; i++) {
    toReady = await jiraTransition(issueKey, "Ready");
    if (!toReady) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!toReady) {
    console.error(`[orchestrator] Reopen ${issueKey}: reached To Do but not Ready — STALLED, manual nudge needed.`);
    return false;
  }
  return true;
}

// ─── DynamoDB Stream Processing (legacy DynamoDB path) ────────────────────────

async function processRecord(record) {
  const eventName = record.eventName; // INSERT, MODIFY, REMOVE
  if (eventName === "REMOVE") return;

  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;
  if (!newImage) return;

  const ticketId = unwrapDdbValue(newImage.ticketId);
  const newStatus = unwrapDdbValue(newImage.status);
  const oldStatus = oldImage ? unwrapDdbValue(oldImage.status) : null;

  // Skip counter item
  if (ticketId === "__COUNTER__") return;

  // Only react to status changes (or new inserts with actionable status)
  if (eventName === "MODIFY" && newStatus === oldStatus) return;

  console.log(`[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → ${newStatus}`);

  // Track ticket in workflow.agentTasks at creation time (INSERT = new ticket)
  if (eventName === "INSERT") {
    const insertAssignee = unwrapDdbValue(newImage.assignee);
    const insertWorkflowId = unwrapDdbValue(newImage.workflowId);
    const insertParentId = unwrapDdbValue(newImage.parentId);
    await trackTicketCreation(ticketId, insertAssignee, insertWorkflowId, insertParentId);
  }

  switch (newStatus) {
    case "done":
      await handleTicketDone(ticketId, newImage);
      break;
    case "ready":
    case "todo":
      // "todo" with all blockers resolved = ready to invoke
      const blockedBy = unwrapDdbValue(newImage.blockedBy) || [];
      const streamBlockersResolved = blockedBy.length === 0 || await checkAllBlockersResolved(blockedBy);
      if (streamBlockersResolved) {
        // ─── CANCEL GUARD (DDB Stream path) ───
        const guardTicket = await getTicket(ticketId);
        if (guardTicket) {
          let guardWorkflow;
          try {
            guardWorkflow = await resolveWorkflow(guardTicket.workflowId, guardTicket.parentId);
          } catch (err) {
            console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
            return; // Fail closed — do not invoke if we can't verify state
          }
          if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
            console.log(`[orchestrator] GUARD: Skipping invocation for ${ticketId} — workflow ${guardWorkflow?.id || "unknown"} is cancelled or not found`);
            return;
          }
        }
        // ─── END CANCEL GUARD ───
        await handleTicketReady(ticketId, newImage);
      }
      break;
    case "in_progress":
      const startedAssignee = unwrapDdbValue(newImage.assignee);
      await publishEvent(ticketId, "agent.started", { ticketId, assignee: startedAssignee, agentId: startedAssignee });
      break;
    case "blocked": {
      // Human-review gate "Request changes" → re-open upstream work if configured.
      const blockedAssignee = unwrapDdbValue(newImage.assignee);
      if (isHumanAssignee(blockedAssignee)) {
        const rejected = await getTicket(ticketId);
        if (rejected) await handleReviewRejection(rejected);
      }
      break;
    }
  }
}

// ─── Ticket Tracking at Creation ────────────────────────────────────────────────

/**
 * Track a ticket in workflow.agentTasks as soon as it's created.
 * This ensures the orchestrator knows about ALL tickets in a workflow from the start,
 * not just when they're invoked. Prevents invisible tickets blocking completion.
 *
 * Called from both Jira and DynamoDB paths when a ticket first appears.
 */
async function trackTicketCreation(ticketId, assignee, workflowId, parentId) {
  if (!assignee || !parentId) return;

  // Skip epics — they're containers, not agent tasks
  const agentDef = getAgentDef(assignee);
  if (!agentDef) return;

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) return;

  // Already tracked (e.g., from a retry/re-delivery) — don't overwrite
  if (workflow.agentTasks?.[ticketId]) return;

  const entry = {
    id: `task_${Date.now()}_${assignee}`,
    agentId: assignee,
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const created = await store.trackTicket(workflow.id, ticketId, entry);
  if (!created) return; // concurrently tracked — keep the existing entry
  if (!workflow.agentTasks) workflow.agentTasks = {};
  workflow.agentTasks[ticketId] = entry;
  console.log(`[orchestrator] Tracked new ticket ${ticketId} (${assignee}) in workflow ${workflow.id}`);

  // Fan out a ticket.created event so the UI can render the badge without polling.
  // Keep the publish best-effort — failure here must not block tracking.
  try {
    const t = await getTicket(ticketId);
    await publishEvent(ticketId, "ticket.created", {
      workflowId: workflow.id,
      ticket: {
        id: ticketId,
        title: t?.title || ticketId,
        status: t?.status || "todo",
        assignee,
        parent: parentId,
        type: t?.type || "task",
        updatedAt: t?.updatedAt || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn(`[orchestrator] ticket.created publish failed for ${ticketId}:`, err.message);
  }
}

// ─── Core Handlers ─────────────────────────────────────────────────────────────

/**
 * A ticket was marked "done". Unblock dependents, check QA gate, check completion.
 *
 * Exported solely so done-handlers-cascade.test.mjs can drive the REAL handler
 * end-to-end through the REAL cascade (TEAM-3688). No behavior change.
 */
export async function handleTicketDone(ticketId, image) {
  const parentId = unwrapDdbValue(image.parentId);
  const workflowId = unwrapDdbValue(image.workflowId);
  const assignee = unwrapDdbValue(image.assignee);

  if (!parentId) {
    console.log(`[orchestrator] ${ticketId} has no parent — likely an epic. Skipping cascade.`);
    return;
  }

  // Get the workflow metadata (resilient to bad workflowId from agent-created tickets)
  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow found for ${ticketId} (parent: ${parentId}, wf: ${workflowId})`);
    return;
  }

  // Update agent task status — scoped write (see handleTicketDoneUnified).
  await markTaskComplete(workflow, ticketId, assignee);

  // Unblock dependents via the shared cascade (TEAM-3618 D3). Same helper as the
  // Jira-webhook twin (handleTicketDoneUnified) — this path previously matched
  // only "blocked" dependents and emitted no orchestrator.unblocked events; the
  // shared helper fixes both divergences (now {blocked, todo} → Ready + journal).
  //
  // TEAM-3684 Finding 1: guard the invocation (symmetric with the webhook twin).
  // An unexpected throw must never skip the agent.complete publish or the
  // completion check below — treat a cascade failure as "unblocked nothing" so
  // the last ticket to close can still finalize the run.
  let unblocked = [];
  try {
    unblocked = await getCascade().cascadeUnblock(ticketId, parentId, workflow);
  } catch (err) {
    console.error(`[orchestrator] cascade failed for ${ticketId} — publishing completion anyway: ${err?.message || err}`);
  }

  // Publish event for UI
  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // Check if workflow is complete (all tickets done)
  if (unblocked.length === 0) {
    if (await isWorkflowComplete(parentId, workflow, assignee)) {
      await completeWorkflow(workflow);
    }
  }

}

/**
 * A ticket is ready (status=todo/ready, no blockers). Invoke the assigned agent.
 */
async function handleTicketReady(ticketId, image) {
  const assignee = unwrapDdbValue(image.assignee);
  const parentId = unwrapDdbValue(image.parentId);
  const workflowId = unwrapDdbValue(image.workflowId);
  const ticketType = unwrapDdbValue(image.type);

  if (!assignee || ticketType === "epic") return;

  // Human-review gate: park for a person instead of invoking an agent.
  if (isHumanAssignee(assignee)) {
    const gateWorkflow = await resolveWorkflow(workflowId, parentId);
    if (gateWorkflow && gateWorkflow.phase === "cancelled") return;
    await handleHumanReviewGate(ticketId, assignee, gateWorkflow);
    return;
  }

  const agentDef = getAgentDef(assignee);
  if (!agentDef) {
    console.warn(`[orchestrator] Unknown agent: ${assignee}`);
    return;
  }

  // Get workflow metadata (resilient to bad workflowId from agent-created tickets)
  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow for ticket ${ticketId} (workflowId=${workflowId}, parent=${parentId})`);
    return;
  }

  // Idempotency claim — same atomic workflow-row lock as the Jira path.
  const claimed = await claimTicketInvocation(workflow, ticketId, assignee);
  if (!claimed) {
    console.log(`[orchestrator] ${ticketId} already claimed (running) — skipping duplicate invocation`);
    return;
  }

  // Belt & suspenders: also claim the ticket row (stream re-deliveries).
  try {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ConditionExpression: "#s <> :inprog",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "in_progress", ":inprog": "in_progress", ":u": new Date().toISOString() },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`[orchestrator] ${ticketId} already in_progress — skipping duplicate invocation`);
      return;
    }
    throw err; // unexpected error — re-throw
  }

  // Ensure manifest exists (initializes on first agent invocation)
  try { await initManifestIfNeeded(workflow); } catch (err) {
    console.warn(`[orchestrator] Manifest init failed (non-fatal): ${err.message}`);
  }

  // Advance phase if needed (workflow-def driven, with software-delivery fallback)
  const wfDef = getWorkflowDef(workflow.workflowDefId);
  const phaseOrder = wfDef.phaseOrder;
  const agentPhaseIdx = phaseOrder.indexOf(agentDef.phase);
  const currentPhaseIdx = phaseOrder.indexOf(workflow.phase);
  if (agentPhaseIdx > currentPhaseIdx) {
    workflow.phase = agentDef.phase;
    await publishEvent(ticketId, "workflow.phase_change", { phase: agentDef.phase, workflowId: workflow.id });

    // Create shared feature branch on the def's branch phase (repo-backed workflows only)
    if (wfDef.featureBranchPhase && agentDef.phase === wfDef.featureBranchPhase && !workflow.featureBranch && workflow.repoConfig?.repos?.length > 0) {
      workflow.featureBranch = await ensureFeatureBranch(workflow);
    }

    await store.advancePhase(workflow.id, workflow.phase, workflow.featureBranch);
  }

  // Build context and invoke agent
  const ticket = await getTicket(ticketId);
  let context = await buildAgentContext(ticket, workflow);

  // Prepend resume context on re-run: retry endpoint (ticket.resumeContext) or
  // review-gate rework (workflow.resumeContexts map). Both one-time use.
  const reworkNote = await consumeResumeContext(workflow, ticketId);
  let resumed = false;
  if (ticket?.resumeContext) {
    context = `${ticket.resumeContext}\n\n---\n\n${context}`;
    resumed = true;
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "REMOVE #rc",
      ExpressionAttributeNames: { "#rc": "resumeContext" },
    }));
  }
  if (reworkNote) {
    context = `${reworkNote}\n\n---\n\n${context}`;
    resumed = true;
  }

  console.log(`[orchestrator] Invoking agent ${assignee} for ticket ${ticketId}${resumed ? " (SESSION RESUME)" : ""}`);
  await publishEvent(ticketId, "agent.invoked", { ticketId, assignee, agentId: assignee, phase: agentDef.phase, workflowId: workflow.id });

  // Fire-and-forget: invoke agent via AgentCore Harness
  // The agent will call report_completion when done → writes "done" to DynamoDB → triggers this Lambda again
  await invokeAgent(agentDef, context, workflow, ticketId);
}

// ─── QA Gate ───────────────────────────────────────────────────────────────────

// TEAM-3686 Finding 4: completion can race a just-filed fix ticket. The
// children read behind the completion verdict goes through the eventually-
// consistent parentId-index GSI (Jira search is likewise lagged), so a
// reviewer/QA/ship agent that files a fix ticket and then reports its own
// ticket done can trigger a completion check against a snapshot where the fix
// isn't visible yet. When the trigger ticket belongs to a kind that spawns
// fixes (roster phases below, or a human review gate), a passing verdict is
// re-verified once after a short bounded delay before completion proceeds.
const FIX_SPAWNING_PHASES = new Set(["verification", "review", "ship"]);
const COMPLETION_RECHECK_DELAY_MS = 1500;

function mayHaveJustSpawnedFixes(assignee) {
  if (isHumanAssignee(assignee)) return true;
  const phase = getAgentDef(assignee)?.phase;
  return phase !== undefined && FIX_SPAWNING_PHASES.has(phase);
}

// Exported solely so completion-gates.test.mjs can drive the re-check seam.
export async function isWorkflowComplete(epicId, workflow, triggerAssignee) {
  if (!(await evaluateCompletionSnapshot(epicId, workflow))) return false;
  if (mayHaveJustSpawnedFixes(triggerAssignee)) {
    await new Promise((r) => setTimeout(r, COMPLETION_RECHECK_DELAY_MS));
    if (!(await evaluateCompletionSnapshot(epicId, workflow))) {
      console.warn(
        `[orchestrator] CompletionRecheckFlipped ${workflow?.id}: verdict after ` +
          `${triggerAssignee} did not hold on re-read — a just-spawned fix ticket ` +
          `was invisible to the first snapshot; completion deferred.`
      );
      return false;
    }
  }
  return true;
}

async function evaluateCompletionSnapshot(epicId, workflow) {
  const children = await getChildTickets(epicId);
  if (children.length === 0) return false;

  const wfDef = getWorkflowDef(workflow?.workflowDefId);

  // Resolve a gate ticket's guarded phase the same way handleReviewRejection
  // does — from the agent phase of the upstream tickets it blocks. Prefer any
  // in-memory child (no fetch); fall back to a lookup for out-of-batch upstreams.
  const childById = new Map(children.map((t) => [t.ticketId, t]));
  const gatePhaseOf = (gateTicket) => {
    if (typeof gateTicket.phase === "string" && gateTicket.phase) return gateTicket.phase;
    for (const upId of gateTicket.blockedBy || []) {
      const up = childById.get(upId);
      const phase = up && getAgentDef(up.assignee)?.phase;
      if (phase) return phase;
    }
    return undefined;
  };

  // TEAM-3619 D4c: per-phase re-verify (done work + approved gates + no open
  // fixes), or the legacy heuristic when the def declares no required phases.
  return evaluateWorkflowComplete(children, wfDef, {
    getAgentPhase: (assignee) => getAgentDef(assignee)?.phase,
    gatePhaseOf,
    requestedGates: workflow?.input?.reviewGates || [],
  });
}

// Exported solely so completion-gates.test.mjs can drive the evidence gate.
export async function completeWorkflow(workflow) {
  if (workflow.phase === "complete") return;

  // TEAM-3686 Finding 3: deliverable-evidence gate — same semantics as the HTTP
  // complete route (TEAM-3619 D4a). Every done ticket in a completion-required
  // phase must have real work behind it (non-empty agentTasks output or an
  // artifact). Enforced by default (TEAM-3690): missing evidence → abort
  // completion. Only the explicit opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0
  // falls back to shadow-log-and-continue. Read-only (R2): children via the provider read,
  // agentTasks via a consistent workflow re-read (the in-memory copy can lag
  // the webhook's output merge). Mirroring the route, a FAILURE of the check
  // itself never blocks a legitimate completion — it only tightens when it can
  // prove a phantom deliverable.
  try {
    const wfDef = getWorkflowDef(workflow?.workflowDefId);
    const requiredPhases = wfDef.completionRequiresAgentPhases || [];
    if (requiredPhases.length > 0) {
      const children = await getChildTickets(workflow.epicId);
      const freshWf = await store.getWorkflow(workflow.id);
      const missing = missingEvidenceTickets(
        children,
        freshWf?.agentTasks || workflow.agentTasks || {},
        requiredPhases,
        { getAgentPhase: (assignee) => getAgentDef(assignee)?.phase }
      );
      if (missing.length > 0) {
        const offenders = missing.map((m) => `${m.ticketId}@${m.phase}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          console.error(
            `[orchestrator] CompletionRejectedMissingEvidence ${workflow.id}: ${offenders}`
          );
          return;
        }
        console.warn(
          `[orchestrator] ${workflow.id} would be blocked for missing evidence (shadow opt-out): ${offenders}`
        );
      }
    }
  } catch (err) {
    console.warn(`[orchestrator] evidence check skipped for ${workflow.id}: ${err?.message || err}`);
  }

  // ── TEAM-3760: TWO ship gates run here, in this order, both at full strength.
  //   1. TEAM-3747 D2 ship-verdict gate (below): INTERNAL evidence, fail-CLOSED.
  //      A done ship ticket with no merge/deploy verdict closes the run on an
  //      honest TERMINAL outcome (deploy-blocked / static-ci-only).
  //   2. TEAM-3721 SHIP_MERGE_VERIFY gate (after it): EXTERNAL GitHub ground
  //      truth, fail-OPEN. A branch PROVABLY unmerged leaves the run OPEN
  //      (workflow.cd_unmerged) for the RM/WM to repair.
  // D2 must run first: it terminally closes the "nothing recorded shipped" runs,
  // so merge-verify only ever sees runs whose recorded evidence CLAIMS a ship —
  // and then cross-checks that claim against GitHub. Reversed, an unmerged run
  // with no ship verdict would be left open by gate 2 and never reach gate 1 —
  // exactly the silent CD dead-zone stall D2 exists to kill. (D2 first is also
  // free: local reads, no GitHub call, for runs that will terminally close.)

  // TEAM-3747 D2 — ship/CD merge-verdict gate: NO green close over unshipped work.
  // If the def has a ship phase, a done ship ticket must carry a merge/deploy
  // verdict (merge commit) OR an explicit deploy-blocked outcome. When neither is
  // present the run did NOT actually ship, so we close it on the HONEST terminal
  // outcome (deploy-blocked when a block was recorded, else static-ci-only) and
  // emit a TERMINAL verdict event — never a silent stall, never a fake "complete".
  // Reuses COMPLETION_EVIDENCE_REQUIRED (fail-closed: enforce by default; a
  // fail-open here would defeat the whole deliverable). The explicit opt-out
  // COMPLETION_EVIDENCE_REQUIRED=off|false|0 only shadow-logs and proceeds.
  try {
    const wfDef = getWorkflowDef(workflow?.workflowDefId);
    const requiredPhases = wfDef.completionRequiresAgentPhases || [];
    const shipPhases = requiredPhases.filter((p) => SHIP_PHASES.has(p));
    if (shipPhases.length > 0) {
      const children = await getChildTickets(workflow.epicId);
      const freshWf = await store.getWorkflow(workflow.id);
      const verdict = evaluateShipVerdict(
        children,
        freshWf?.agentTasks || workflow.agentTasks || {},
        shipPhases,
        { getAgentPhase: (assignee) => getAgentDef(assignee)?.phase }
      );
      if (verdict.required && !verdict.shipped) {
        const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          await closeWorkflowBlocked(workflow, verdict);
          return;
        }
        console.warn(
          `[orchestrator] ${workflow.id} would close as ${verdict.outcome} (shadow opt-out) — ship verdict missing: ${offenders}`
        );
      }
    }
  } catch (err) {
    // Never let the ship-verdict resolution itself turn a legitimate completion
    // into a stall — it only diverts when it can prove work never shipped.
    console.warn(`[orchestrator] ship-verdict check skipped for ${workflow.id}: ${err?.message || err}`);
  }

  // Ship-phase merge gate (TEAM-3721 CD dead-zone): a def with a "ship" phase
  // has the release manager own the merge, and the CD ticket can be marked done
  // even though the PR was never actually merged (RM BLOCKs in preflight, or the
  // merge step silently no-ops). Trusting ticket status alone let such a run
  // finalize as "complete" with main untouched — the exact false-complete we hit.
  // Before claiming completion, verify against GitHub that the feature branch is
  // truly merged. Not merged → abort completion so the run stays open (the CD
  // ticket / WM surfaces it) instead of lying. Best-effort: a GitHub/API failure
  // (or no PAT) never blocks a legitimate completion — it only tightens when it
  // can PROVE the branch is unmerged. Opt-out: SHIP_MERGE_VERIFY=off.
  const shipMergeVerify = !["off", "false", "0"].includes(
    String(process.env.SHIP_MERGE_VERIFY || "").trim().toLowerCase()
  );
  if (
    shipMergeVerify &&
    defHasShipPhase(workflow) &&
    workflow.featureBranch &&
    workflow.repoConfig &&
    process.env.GITHUB_PAT
  ) {
    const unmerged = await featureBranchUnmerged(workflow);
    if (unmerged) {
      console.error(
        `[orchestrator] CompletionRejectedUnmergedBranch ${workflow.id}: ` +
          `feature branch ${workflow.featureBranch} is not merged into the base ` +
          `(${unmerged}). CD did not land the merge — leaving run open.`
      );
      await publishEvent(workflow.epicId, "workflow.cd_unmerged", {
        workflowId: workflow.id,
        featureBranch: workflow.featureBranch,
        reason: unmerged,
      });
      return;
    }
  }

  // Atomic completion claim FIRST — only the winner runs the side effects
  // (PR creation, epic roll-up, the workflow.complete event). Previously the
  // guard was the stale in-memory phase + a full-row put: two concurrent
  // "last ticket done" cascades both passed it, double-firing the side
  // effects and clobbering concurrent scoped writes (study P1).
  const completedAt = new Date().toISOString();
  const won = await store.completeWorkflow(workflow.id, completedAt);
  if (!won) {
    // A previous completer may have died between the claim and its side
    // effects (Lambda timeout/kill). If the row is complete but never
    // finalized and the claim is old, take over finalization exactly once.
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const takeover = await store.claimFinalization(workflow.id, staleBefore);
    if (!takeover) {
      console.log(`[orchestrator] Workflow ${workflow.id} already completed/terminal — skipping duplicate completion.`);
      return;
    }
    console.log(`[orchestrator] Workflow ${workflow.id} complete but unfinalized — taking over side effects.`);
  }
  console.log(`[orchestrator] Workflow ${workflow.id} complete!`);

  workflow.phase = "complete";
  workflow.completedAt = completedAt;

  // Create unified PR if feature branch exists — unless the def has a "ship"
  // phase: there the release manager owns the PR, and by completion time the
  // branch is already merged (create_pr here would 422 "no commits between").
  const defHasShip = (getWorkflowDef(workflow?.workflowDefId).completionRequiresAgentPhases || []).includes("ship");
  let prUrl = "";
  if (!defHasShip && workflow.featureBranch && workflow.repoConfig) {
    try {
      const { owner, repo } = parseRepoUrl(workflow.repoConfig);
      const baseBranch = workflow.repoConfig.repos?.[0]?.defaultBranch || "main";
      const prResult = await callGitHub("create_pr", {
        owner,
        repo,
        title: `feat: ${workflow.input.title} (${workflow.epicId})`,
        body: `Automated implementation by agentic team workflow (${workflow.epicId}).`,
        head: workflow.featureBranch,
        base: baseBranch,
      });
      prUrl = prResult?.html_url || "";
      console.log(`[orchestrator] Created PR: ${prUrl}`);
    } catch (err) {
      console.warn(`[orchestrator] PR creation failed: ${err.message}`);
    }
  }

  // Roll the epic ticket up so the board reflects the closure. Without this the
  // run shows phase=complete while its epic sits in To Do/In Progress forever —
  // the exact gap that leaves runs "open" and drives the watch loop. Best-effort:
  // a board with no Done transition just logs and moves on.
  if (TICKET_PROVIDER === "jira" && workflow.epicId) {
    const rolled = await jiraTransition(workflow.epicId, "Done");
    if (!rolled) {
      console.warn(`[orchestrator] epic ${workflow.epicId} roll-up to Done skipped (no transition)`);
    }
  }

  await publishEvent(workflow.epicId, "workflow.complete", {
    workflowId: workflow.id,
    featureBranch: workflow.featureBranch,
    prUrl,
  });

  // Durable marker that the side effects above all ran — the takeover path's
  // claim checks this so a completer killed mid-finalization gets resumed.
  await store.markFinalized(workflow.id);
}

/**
 * TEAM-3747 D2 — close a run on an HONEST terminal ship outcome instead of a fake
 * "complete". Mirrors completeWorkflow's side-effect discipline: an ATOMIC,
 * idempotent phase claim (store.claimTerminalOutcome CASes off any terminal phase,
 * so concurrent cascades and stream re-deliveries yield exactly one winner), then
 * — winner only — a best-effort PR label, a TERMINAL verdict event, and the
 * finalized marker. The event type is workflow.deploy_blocked / workflow.static_ci_only
 * but ALSO carries an `outcome` field, so a consumer that only knows
 * "workflow.complete" can still branch on `outcome` — the close is never silent.
 */
async function closeWorkflowBlocked(workflow, verdict) {
  const outcome = verdict.outcome; // one of SHIP_BLOCKED_OUTCOMES
  const completedAt = new Date().toISOString();
  const won = await store.claimTerminalOutcome(workflow.id, outcome, completedAt, verdict.blockReason);
  if (!won) {
    console.log(`[orchestrator] Workflow ${workflow.id} already terminal — skipping duplicate ${outcome} close.`);
    return;
  }
  const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
  console.error(`[orchestrator] Workflow ${workflow.id} closed ${outcome} (not shipped): ${offenders}`);

  workflow.phase = outcome;
  workflow.completedAt = completedAt;
  if (verdict.blockReason) workflow.blockReason = verdict.blockReason;

  // Find a PR to label — prefer a prUrl harvested onto an offending ship ticket
  // (harvestCompletionEvidence stashes record.pr_url there). Re-read for freshness.
  let prUrl = "";
  try {
    const freshWf = await store.getWorkflow(workflow.id);
    const tasks = freshWf?.agentTasks || workflow.agentTasks || {};
    for (const o of verdict.offenders) {
      const entry = tasks[o.ticketId];
      if (entry && typeof entry.prUrl === "string" && entry.prUrl) { prUrl = entry.prUrl; break; }
    }
  } catch { /* best-effort */ }

  // Surface the block on the review surface via a PR label. Best-effort by
  // contract: a missing PAT / label / PR must never turn the terminal close
  // into a throw (that would leave the run wedged, the exact failure we fix).
  if (prUrl) {
    try {
      await labelPullRequest(prUrl, outcome);
    } catch (err) {
      console.warn(`[orchestrator] PR label ${outcome} skipped for ${prUrl}: ${err?.message || err}`);
    }
  }

  await publishEvent(
    workflow.epicId,
    outcome === "deploy-blocked" ? "workflow.deploy_blocked" : "workflow.static_ci_only",
    {
      workflowId: workflow.id,
      outcome,
      reason: verdict.blockReason || null,
      offenders: verdict.offenders,
      prUrl,
      featureBranch: workflow.featureBranch,
    }
  );

  await store.markFinalized(workflow.id);
}

/**
 * TEAM-3747 D2 — add a label to the PR behind a github.com/{owner}/{repo}/pull/{N}
 * URL (issues + PRs share the labels endpoint). Validates the URL so a malformed
 * prUrl throws to the caller's warn rather than hitting the wrong endpoint; the
 * label is created on demand by GitHub if it doesn't exist yet.
 */
async function labelPullRequest(prUrl, label) {
  const m = String(prUrl || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`unrecognized PR url: ${prUrl}`);
  const [, owner, repo, number] = m;
  await githubApi(`/repos/${owner}/${repo}/issues/${number}/labels`, "POST", { labels: [label] });
}

// ─── Agent Invocation ──────────────────────────────────────────────────────────

/**
 * Discover harness ARN and invoke the agent.
 * Fire-and-forget: agent runs asynchronously. When done, it calls report_completion
 * which writes "done" to DynamoDB, triggering this Lambda again via the stream.
 */
async function invokeAgent(agentDef, context, workflow, ticketId) {
  // Discover agent ARN — prefer runtimeArn from roster, then env var lookup
  const runtimeEnvKey = `RUNTIME_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessEnvKey = `HARNESS_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessArn = agentDef.runtimeArn || process.env[runtimeEnvKey] || process.env[harnessEnvKey];
  if (!harnessArn) {
    console.error(`[orchestrator] No ARN for agent: ${agentDef.agentId}. Tried ${runtimeEnvKey} and ${harnessEnvKey}. Marking ticket blocked.`);
    // Publish the error FIRST — the ticket-blocking below can fail (e.g. the
    // tickets table doesn't exist in Jira mode) and the Workflow Manager needs
    // an agent.error event to distinguish "never started" from "hung".
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: ticketId || "",
      error: `No runtime ARN configured. Set ${runtimeEnvKey} env var on orchestrator Lambda.`,
    });
    await releaseClaimOnFailure(workflow.id, ticketId);
    await blockTicketForFailedInvoke(ticketId, "no runtime ARN configured");
    return;
  }
  console.log(`[orchestrator] Using ${harnessArn.includes("/runtime/") ? "Runtime" : "Harness"} for ${agentDef.agentId}`);

  // Determine model override
  let modelConfig = undefined;
  if (workflow.input?.modelOverride) {
    let override = workflow.input.modelOverride;
    if (typeof override === "string") {
      const modelMap = {
        "opus": "us.anthropic.claude-opus-4-6-v1",
        "sonnet": "us.anthropic.claude-sonnet-4-6",
        "claude-opus-47": "us.anthropic.claude-opus-4-7",
        "claude-opus-46": "us.anthropic.claude-opus-4-6-v1",
        "claude-sonnet-46": "us.anthropic.claude-sonnet-4-6",
        "claude-sonnet-45": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      };
      override = { bedrockModelConfig: { modelId: modelMap[override] || override } };
    }
    modelConfig = override;
  }

  try {
    // Use BedrockAgentRuntime InvokeAgent — fire and forget
    // The agent stream will run to completion. When done, the agent's report_completion
    // tool writes "done" status to DynamoDB, which triggers this Lambda via stream.
    // Prefix with ticketId so OTEL traces are discoverable by Jira ticket in the Ticket History page
    const ticketPrefix = ticketId ? `${ticketId}_` : "";
    const sessionId = `${ticketPrefix}${workflow.id}-${agentDef.agentId}-${Date.now()}`;

    const command = new InvokeAgentCommand({
      agentAliasId: "TSTALIASID", // placeholder — real ARN used via agentId
      agentId: harnessArn.split("/").pop(),
      sessionId,
      inputText: context,
      ...(modelConfig?.bedrockModelConfig ? { bedrockModelArn: modelConfig.bedrockModelConfig.modelId } : {}),
    });

    // Note: In production, we'd use the AgentCore Harness SDK's invokeHarnessAgent
    // For now, invoke as a separate async Lambda that handles the streaming
    await lambda.send(new InvokeCommand({
      FunctionName: "agentcore-hub-agent-invoker",
      InvocationType: "Event", // async — don't wait for response
      Payload: JSON.stringify({
        harnessArn,
        sessionId,
        prompt: context,
        workflowId: workflow.id,
        agentId: agentDef.agentId,
        ticketId: ticketId || "",
        modelOverride: modelConfig,
        // Routine-scoped connectors travel with the workflow → each agent invoke.
        connectors: workflow.connectors,
        // Fleet-wide watchdog knobs (D1.1), resolved from the S3 agents.json
        // config: heartbeat cadence + tool/turn deadlines the runtime enforces.
        watchdog: resolveWatchdog(agentDef.agentId),
      }),
    }));

    console.log(`[orchestrator] Async invoke sent for ${agentDef.agentId} (session: ${sessionId})`);

    // Journey log: agent invocation dispatched
    await publishEvent(ticketId || agentDef.agentId, "orchestrator.agent_invoked", {
      ticketId: ticketId || "", agentId: agentDef.agentId, sessionId,
      workflowId: workflow.id, runtimeArn: harnessArn,
    });

    // Persist session info to the workflow manifest (S3) for health probes and traceability
    try {
      await updateManifestSession(workflow.id, agentDef.agentId, {
        sessionId,
        runtimeArn: harnessArn,
        invokedAt: new Date().toISOString(),
        ticketId,
      });
    } catch (err) {
      console.warn(`[orchestrator] Manifest session write failed (non-fatal): ${err.message}`);
    }
  } catch (err) {
    console.error(`[orchestrator] Failed to invoke ${agentDef.agentId}:`, err);
    // Error event first — see the no-ARN path above for why.
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: ticketId || "",
      error: `Invoke failed: ${err.message}`,
    });
    await releaseClaimOnFailure(workflow.id, ticketId);
    await blockTicketForFailedInvoke(ticketId, `invoke failed: ${err.message}`);
  }
}

/**
 * Reset agentTasks[ticketId].status after a failed invoke so the atomic claim
 * doesn't block the retry (manual "Ready" transition or WM dispatch). Without
 * this the entry stays "running" forever and every retry is rejected as a
 * duplicate. Best-effort.
 */
async function releaseClaimOnFailure(workflowId, ticketId) {
  if (!ticketId) return;
  try {
    await store.setTaskStatus(workflowId, ticketId, "error");
  } catch (err) {
    console.warn(`[orchestrator] releaseClaimOnFailure(${ticketId}): ${err.message}`);
  }
}

/**
 * Park a ticket whose agent invoke failed, provider-aware. In Jira mode the
 * DynamoDB tickets table is optional/absent — the old direct DDB write threw
 * ResourceNotFoundException, which killed the handler and left the ticket
 * showing In Progress forever with no error event (the TEAM-2229 stall). Jira
 * mode transitions the issue to Blocked (fallback To Do) and leaves a comment
 * so the failure is visible on the board. Best-effort: never throws.
 */
async function blockTicketForFailedInvoke(ticketId, reason) {
  if (!ticketId) return;
  try {
    if (TICKET_PROVIDER === "jira") {
      const moved = (await jiraTransition(ticketId, "Blocked")) || (await jiraTransition(ticketId, "To Do"));
      if (!moved) console.warn(`[orchestrator] Could not park ${ticketId} after failed invoke`);
      await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `AgentCore Hub: agent invoke failed (${reason}). Move this ticket back to Ready to retry once the cause is fixed.` }] }] },
      });
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "blocked", ":u": new Date().toISOString() },
      }));
    }
  } catch (err) {
    console.warn(`[orchestrator] blockTicketForFailedInvoke(${ticketId}) failed: ${err.message}`);
  }
}

// ─── Context Builder ───────────────────────────────────────────────────────────

async function buildAgentContext(ticket, workflow) {
  let context = `# Your Assignment: ${ticket.title}\n\n`;
  context += `## Ticket\nID: ${ticket.ticketId}\nDescription: ${ticket.description}\n\n`;

  // Workflow identifiers
  context += `## Workflow Context\n`;
  context += `workflow_id: ${workflow.id}\n`;
  context += `epic_id: ${workflow.epicId}\n`;
  context += `ticket_id: ${ticket.ticketId}\n\n`;

  // Shipped laptop session: the requester planned this work in a live coding
  // session and shipped it here. Visible to EVERY agent — the transcript is the
  // authoritative context, and the branch already carries in-flight work.
  const ported = workflow.input?.portedSession;
  if (ported?.sessionId) {
    context += `## Ported Session\n`;
    context += `The requester pre-planned this work in a live coding session and shipped it to this workflow. `;
    context += `The session transcript contains the research, decisions, and constraints — it is the authoritative context for this run.\n`;
    context += `coding_session_id: ${ported.sessionId}\n`;
    context += `cli: ${ported.cli || "claude"}\n`;
    if (ported.repo) context += `repo: ${ported.repo}\n`;
    context += `ported_branch: ${ported.branch} (already contains the requester's in-flight work — build on it, never discard it)\n`;
    context += `To resume the session, pass resume_session="${ported.sessionId}" on your FIRST ${ported.cli === "codex" ? "codex" : "claude_code"} call — it continues the requester's exact conversation and workspace.\n`;
    context += `Intake/requirements: resume it to read the plan out of the conversation before writing tickets. `;
    context += `Dev agents: resume it and continue the work in place. `;
    context += `Review/QA: verify the branch independently — do NOT resume the dev conversation; inspect the code and run your own checks.\n\n`;
  }

  // This agent's OWN prior coding session in this workflow (fix tickets,
  // re-reviews, serially-chained tickets). Default = resume: the conversation
  // already holds the repo context, findings, and decisions — rebuilding it
  // from scratch every loop burns tokens and loses what the agent knew.
  // findCodingSession is per (workflow, agentId), so a reviewer only ever gets
  // its own review session back, never the dev's conversation.
  try {
    const priorSession = await findCodingSession(workflow.id, ticket.assignee);
    if (priorSession) {
      context += `## Prior Coding Session (resume by DEFAULT)\n`;
      context += `You already have a coding session in this workflow: ${priorSession}\n`;
      context += `Pass resume_session="${priorSession}" on your FIRST claude_code/codex/kiro call — it restores YOUR prior conversation and workspace (the code you wrote or reviewed, your findings, your decisions) instead of rebuilding that context from scratch.\n`;
      context += `- Fix ticket from review/QA: ALWAYS resume — you are continuing the same work.\n`;
      context += `- Re-review / re-verify after fixes: resume — you know what you found; verify it was fixed.\n`;
      context += `- Start fresh ONLY if the ticket explicitly calls for a clean-slate redo of a rejected approach.\n`;
      context += `Resume is best-effort: if the session is gone you start fresh automatically. This supersedes any Ported Session instruction above — your own session already contains it.\n\n`;
    }
  } catch { /* hint is optional */ }

  // For the intake agent only: provide the valid agent roster (registry data),
  // scoped to agents belonging to this workflow definition.
  const wfDef = getWorkflowDef(workflow.workflowDefId);
  if (ticket.assignee === wfDef.intakeAgentId) {
    const roster = (_agentRoster || FALLBACK_ROSTER)
      .filter(a => a.agentId !== wfDef.intakeAgentId)
      .filter(a => (a.workflowDefIds || [a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID]).includes(wfDef.id))
      .map(a => `  - "${a.agentId}" (${a.phase})`)
      .join("\n");
    context += `## Available Agents\n${roster}\n\n`;

    // Human-review gates active for this run. The intake agent must insert one
    // review ticket per gate (assignee "human:<who>"), blocked by all the agent
    // tickets of the gate's afterPhase, and — for blocking gates — make the next
    // phase's tickets blockedBy the gate ticket. The orchestrator parks human
    // tickets for a person instead of invoking an agent.
    const requestedGates = workflow.input?.reviewGates || [];
    const activeGates = (wfDef.reviewGates || []).filter(
      (g) => g.condition === "always" || requestedGates.includes(g.afterPhase)
    );
    if (activeGates.length > 0) {
      const gateLines = [];
      for (const g of activeGates) {
        const block = g.blocking ? "BLOCKING (next phase waits for approval)" : "advisory (non-blocking)";
        // Pull the domain-appropriate reviewer roster from Jira (by project role).
        // The agent CHOOSES one — like it chooses agents from ## Available Agents.
        const reviewers = await listReviewers(g.reviewerRole);
        if (reviewers.length > 0) {
          const choices = reviewers
            .map((r) => `      • assignee "human:${r.email || r.accountId}" — ${r.displayName}${r.roles?.length ? ` [${r.roles.join(", ")}]` : ""}`)
            .join("\n");
          gateLines.push(
            `  - After phase "${g.afterPhase}": create a "${g.name || "Review"}" ticket, blocked_by ALL "${g.afterPhase}" agent tickets. ${block}.\n` +
            `    Assign it to ONE of these reviewers (pick the best fit for the work; honor any reviewer named in the request):\n${choices}`
          );
        } else {
          // No roster (DynamoDB mode, or no users) → fall back to the config ref.
          const who = g.assignee || "human:reviewer";
          gateLines.push(
            `  - After phase "${g.afterPhase}": create a "${g.name || "Review"}" ticket assigned to "${who}", blocked_by ALL "${g.afterPhase}" agent tickets. ${block}.`
          );
        }
      }
      context += `## Human Review Gates (REQUIRED)\nInsert these human-review tickets into your ticket plan:\n${gateLines.join("\n")}\nUse the EXACT "human:<…>" assignee string shown. For BLOCKING gates, the downstream phase's tickets must list the gate ticket in their blocked_by. A human approves (status → done) or requests changes (status → blocked).\n\n`;
    }

    // Bug-fix is a SCOPE distinction (different blueprint), not a HOW.
    try {
      const epic = await getTicket(workflow.epicId);
      if ((epic?.issueType || "").toLowerCase() === "bug") {
        context += `## Workflow Type\nbug-fix (workflow root ${workflow.epicId} is a Jira Bug)\n\n`;
      }
    } catch (err) {
      console.warn(`[orchestrator] could not check epic issue type: ${err.message}`);
    }
  }

  // Requirements artifact (from epic) — scope, not HOW
  try {
    const epic = await getTicket(workflow.epicId);
    const reqArtifact = (epic?.artifacts || []).find((a) => a.type === "requirements");
    if (reqArtifact) {
      context += `## Requirements\n${reqArtifact.content}\n\n`;
    }
  } catch { /* no requirements yet */ }

  // Repo identity — scope only
  if (workflow.repoConfig?.repos?.length > 0) {
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const defaultBranch = workflow.repoConfig.repos[0]?.defaultBranch || "main";
    context += `## Repository\nowner: ${owner}\nrepo: ${repo}\ndefault_branch: ${defaultBranch}\n\n`;
  }

  // CI/CD pipeline mode signal (PR #263). The CI/QA/release-manager blueprints
  // branch on this: set → read CodeBuild/CodePipeline results instead of shelling
  // builds/deploys; absent → legacy self-run. An env var alone is invisible to
  // the model, so surface it EXPLICITLY in the task context (Codex #263 round-5).
  if (isPipelineEnabled(process.env.PIPELINE_ENABLED)) {
    context += `## Pipeline Mode\nPIPELINE_ENABLED: true\n`;
    context += `A CodeBuild PR-check + CodePipeline deploy own this repo's `;
    context += `deterministic build/test/deploy. Follow the PIPELINE_ENABLED path `;
    context += `in your blueprint (read CI/pipeline results; do NOT shell builds or `;
    context += `run DEPLOY.md yourself).\n\n`;
  }

  // S3 workspace paths (scope)
  const agentDef = getAgentDef(ticket.assignee);
  context += `## S3 Workspace\n`;
  context += `shared: workflows/${workflow.id}/shared/\n`;
  context += `your_workspace: workflows/${workflow.id}/agents/${ticket.assignee}/\n\n`;

  // Manifest — upstream artifacts (scope only)
  try {
    const manifest = await readManifest(workflow.id);
    if (manifest) {
      context += buildManifestContext(manifest, agentDef?.phase || "development", workflow, ticket);
    }
  } catch { /* manifest read failed — non-fatal */ }

  // Dev agents: branch identity (scope, not HOW)
  if (agentDef?.phase === "development") {
    const baseBranch = workflow.featureBranch || workflow.repoConfig?.repos?.[0]?.defaultBranch || "main";
    context += `## Branch\n`;
    context += `feature_branch: feature/${ticket.ticketId}-${agentDef.agentId.replace(/^agentcore_hub_/, "").replace(/_/g, "-")}\n`;
    context += `base_branch: ${baseBranch}\n`;
    if (workflow.featureBranch) {
      context += `NOTE: base_branch is this run's SHARED integration branch. Branch from it, target your PR at it (never the repo default branch), and merge your PR into it when your evidence is complete — one unified PR to the default branch is opened by the orchestrator at run completion.\n`;
    }
    context += `\n`;

    // Design artifacts content (scope)
    try {
      const designDoc = await readS3Artifact(workflow.id, "shared/output.md");
      if (designDoc) {
        context += `## Design Artifacts\n${designDoc.slice(0, 8000)}\n\n`;
      }
    } catch { /* no design docs yet */ }
  }

  // Original request + input sources for the workflow's intake agent (any def).
  // Scoped by intakeAgentId, not phase: non-software intakes use strategy /
  // qualification / triage phases, so a "requirements"-only check starved them
  // of the URLs and uploaded contract/RFP inputs.
  if (ticket.assignee === wfDef.intakeAgentId && workflow.input) {
    context += `## Request\nTitle: ${workflow.input.title}\nDescription: ${workflow.input.description}\n\n`;
    if (workflow.input.sources?.length > 0) {
      context += `## Input Sources\n`;
      for (const src of workflow.input.sources) {
        context += `- [${src.type}] ${src.label || src.value}\n`;
      }
      context += "\n";
    }
  }

  return context;
}

// ─── DynamoDB Helpers ──────────────────────────────────────────────────────────

async function getWorkflow(id) {
  return store.getWorkflow(id);
}

/**
 * Resolve workflow for a ticket — handles cases where workflowId is missing/invalid.
 * Falls back to looking up the parent epic's workflowId.
 */
async function resolveWorkflow(workflowId, parentId) {
  // Try direct lookup if workflowId is a valid string
  if (typeof workflowId === "string" && workflowId.startsWith("wf_")) {
    const wf = await getWorkflow(workflowId);
    if (wf) return wf;
  }

  // Fallback: look up the parent (epic) ticket to get the workflowId
  if (parentId) {
    const parent = await getTicket(parentId);
    if (parent && typeof parent.workflowId === "string" && parent.workflowId.startsWith("wf_")) {
      return await getWorkflow(parent.workflowId);
    }
    // If parent itself has a parentId, go one level up (task → story → epic)
    if (parent && parent.parentId) {
      const grandparent = await getTicket(parent.parentId);
      if (grandparent && typeof grandparent.workflowId === "string") {
        return await getWorkflow(grandparent.workflowId);
      }
    }
  }

  // Jira fallback: scan workflows table for epicId match
  // (Jira epics don't store workflowId — it lives in our workflows table)
  if (parentId && TICKET_PROVIDER === "jira") {
    try {
      const result = await ddb.send(new QueryCommand({
        TableName: WORKFLOWS_TABLE,
        IndexName: "epicId-index",
        KeyConditionExpression: "epicId = :eid",
        ExpressionAttributeValues: { ":eid": parentId },
      }));
      if (result.Items?.length > 0) return result.Items[0];
    } catch {
      // epicId-index may not exist — fall through
    }
  }

  return null;
}

/**
 * Bootstrap a workflow when a Bug is filed directly in Jira (not via /api/workflow/start).
 * The Bug ticket itself is the workflow root — there is no separate Epic wrapper.
 * Mirrors startWithJira() in src/app/api/workflow/start/route.ts.
 *
 * Steps:
 *   1. Idempotency check: if a workflow already exists for this bug key, do nothing.
 *   2. Create workflow row in DDB (epicId = bug.key).
 *   3. Label the Bug with `wf:<workflow_id>` and `agentcore-hub-workflow` so the analyst sub-task
 *      will inherit the workflow context via the same labels.
 *   4. Create a requirements-analyst sub-task under the Bug.
 *   5. The analyst sub-task is created without blockers, so the agentcore-hub-jira Lambda
 *      transitions it to Ready on creation, which fires the orchestrator's normal
 *      "ready" path → invokes the analyst → bug-fix blueprint.
 */
async function bootstrapBugWorkflow(bugTicket) {
  const bugKey = bugTicket.ticketId;

  // Idempotency: scan workflows table for an existing workflow with this epicId
  try {
    const existing = await ddb.send(new QueryCommand({
      TableName: WORKFLOWS_TABLE,
      IndexName: "epicId-index",
      KeyConditionExpression: "epicId = :eid",
      ExpressionAttributeValues: { ":eid": bugKey },
    }));
    if (existing.Items?.length > 0) {
      console.log(`[orchestrator] Bug ${bugKey} already has workflow ${existing.Items[0].id} — skipping bootstrap`);
      return;
    }
  } catch (err) {
    console.warn(`[orchestrator] Bootstrap idempotency check failed (continuing): ${err.message}`);
  }

  // Deterministic id keyed by the bug: concurrent duplicate deliveries mint
  // the SAME id, so createWorkflow's attribute_not_exists condition is a real
  // once-per-bug lock (the epicId-index scan above is eventually consistent
  // and can miss a just-created row).
  const workflowId = `wf_bug_${bugKey}`;
  console.log(`[orchestrator] Bootstrapping bug workflow ${workflowId} for ${bugKey}`);

  // 1. Create workflow row. The target repo travels ON the Bug ticket as a
  //    `repo:owner/name` label (optional `branch:<name>`, defaults to "main").
  //    This is what lets one hub serve bugs across many repos without any
  //    per-repo config. DEFAULT_BUG_REPO_URL is an optional single-repo fallback
  //    for simple setups. With neither, we fail loud rather than open a branch
  //    on the wrong repo.
  const repoLabel = repoConfigFromLabels(bugTicket.labels);
  let repoConfig;
  if (repoLabel.status === "ok") {
    repoConfig = repoLabel.repoConfig;
  } else if (repoLabel.status === "invalid") {
    // The ticket explicitly named a repo but it is malformed. Do NOT fall back to
    // DEFAULT_BUG_REPO_URL — a typo like `repo:acme/service/api` must not silently
    // open a PR on an unrelated repo. Fail loud and tell the reporter how to retry.
    console.error(`[orchestrator] Bug ${bugKey} has a malformed repo label "repo:${repoLabel.slug}" — expected repo:<owner>/<name>. Not bootstrapping.`);
    await commentOnBug(bugKey, `AgentCore Hub: the repo label \`repo:${repoLabel.slug}\` is not a valid \`owner/name\` (e.g. \`repo:acme/checkout-api\`). Fix the label, then move this ticket to any other status and back to "To Do" to retry.`);
    return;
  } else {
    // No repo label at all — the single-repo fallback (if configured) applies.
    repoConfig = defaultBugRepoConfig();
    if (!repoConfig) {
      console.error(`[orchestrator] Bug ${bugKey} has no "repo:owner/name" label and no DEFAULT_BUG_REPO_URL — cannot bootstrap.`);
      await commentOnBug(bugKey, `AgentCore Hub: no target repo. Add a label \`repo:<owner>/<name>\` (e.g. \`repo:acme/checkout-api\`), then move this ticket to any other status and back to "To Do" to retry.`);
      return;
    }
  }
  const workflow = {
    id: workflowId,
    workflowId,
    phase: "requirements",
    epicId: bugKey,
    repoConfig,
    // Bugs run the dedicated 4-phase bug-fix pipeline (triage → fix → verify → CI),
    // not the full 5-phase software-delivery flow. Top-level drives orchestrator
    // phase advancement + roster scoping; input.workflowDefId drives the board.
    workflowDefId: "bug-fix",
    input: {
      title: bugTicket.title || `Bug fix: ${bugKey}`,
      description: bugTicket.description || "",
      sources: [],
      repoConfig,
      workflowDefId: "bug-fix",
    },
    agentTasks: {},
    messages: [],
    humanNotifications: [],
    startedAt: new Date().toISOString(),
    ticketProvider: "jira",
    intakeChannel: "jira-webhook",
    workflowType: "bug",
  };
  // Create-once on the deterministic row key — the atomic dedup for
  // concurrent duplicate deliveries.
  const created = await store.createWorkflow(workflow);
  if (!created) {
    console.log(`[orchestrator] Workflow ${workflowId} already exists — skipping duplicate bootstrap.`);
    return;
  }

  // 2. Label the Bug ticket itself with `wf:<id>` so future webhooks can resolve the workflow
  try {
    await jiraFetch(`/rest/api/3/issue/${bugKey}`, "PUT", {
      update: {
        labels: [{ add: `wf:${workflowId}` }, { add: "agentcore-hub-workflow" }],
      },
    });
  } catch (err) {
    console.warn(`[orchestrator] Could not label Bug ${bugKey}: ${err.message}`);
  }

  // 3. Create requirements-analyst sub-task under the Bug
  // Jira hard-caps issue summary at 255 chars — long bug titles (users paste the
  // whole complaint) otherwise 400 the create and the workflow never starts.
  const analystSummary = `Requirements: requirements analyst — ${bugTicket.title || bugKey}`.slice(0, 255);
  const analystDescription = `Analyze the bug report (${bugKey}) and create the bug-fix sub-task chain (Fix → QA → CI). The orchestrator has injected a "THIS IS A BUG REPORT" directive — load the bug-fix-requirements blueprint.\n\n${bugTicket.description || ""}`;

  const subtaskFields = {
    project: { key: process.env.JIRA_PROJECT_KEY || "TEAM" },
    summary: analystSummary,
    issuetype: { name: "Subtask" },
    parent: { key: bugKey },
    labels: ["agentcore-hub-workflow", `wf:${workflowId}`, "agent:agentcore_hub_requirements_analyst"],
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: analystDescription }] }],
    },
  };

  let analystKey;
  try {
    const created = await jiraFetch(`/rest/api/3/issue`, "POST", { fields: subtaskFields });
    analystKey = created.key;
    console.log(`[orchestrator] Created analyst sub-task ${analystKey} under bug ${bugKey}`);
  } catch (err) {
    console.error(`[orchestrator] Failed to create analyst sub-task for bug ${bugKey}: ${err.message}`);
    return;
  }

  // 4. Transition analyst sub-task to Ready (no blockers) — this fires the webhook → orchestrator → invoke
  try {
    await jiraTransition(analystKey, "Ready");
  } catch (err) {
    console.warn(`[orchestrator] Could not transition ${analystKey} to Ready (will rely on Jira webhook fallback): ${err.message}`);
  }
}

async function checkAllBlockersResolved(blockerIds) {
  // Check if all tickets in the blockedBy list are done/cancelled
  for (const bid of blockerIds) {
    const blocker = await getTicket(bid);
    if (!blocker || (blocker.status !== "done" && blocker.status !== "cancelled")) {
      return false;
    }
  }
  return true;
}

async function getTicket(ticketId) {
  if (TICKET_PROVIDER === "jira") {
    return await getTicketFromJira(ticketId);
  }
  const result = await ddb.send(new GetCommand({ TableName: TICKETS_TABLE, Key: { ticketId } }));
  if (!result.Item) return null;
  // Normalize: DDB tickets store the raw Jira issue type as `type` (e.g., "Bug", "Task").
  // Mirror it onto `issueType` so callers can branch on it the same way as the Jira path.
  if (result.Item.type && !result.Item.issueType) {
    result.Item.issueType = result.Item.type;
  }
  return result.Item;
}

/**
 * TEAM-3755 F9 — one ticket read by KEY with ConsistentRead, for callers that
 * must not act on the eventually-consistent parentId-index snapshot (the cascade's
 * blocker confirm). Jira has no read-consistency knob: its REST GET is already a
 * fresh authoritative read, so the provider branch is the same shape as getTicket.
 */
async function getTicketConsistent(ticketId) {
  if (TICKET_PROVIDER === "jira") {
    return await getTicketFromJira(ticketId);
  }
  const result = await ddb.send(new GetCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    ConsistentRead: true,
  }));
  return result.Item || null;
}

async function getChildTickets(parentId) {
  if (TICKET_PROVIDER === "jira") {
    return await getChildTicketsFromJira(parentId);
  }
  const result = await ddb.send(new QueryCommand({
    TableName: TICKETS_TABLE,
    IndexName: "parentId-index",
    KeyConditionExpression: "parentId = :pid",
    ExpressionAttributeValues: { ":pid": parentId },
  }));
  return result.Items || [];
}

// ─── Jira Ticket Provider ─────────────────────────────────────────────────────

async function jiraFetch(path, method = "GET", body = null) {
  const url = `https://${JIRA_SITE_URL}${path}`;
  const headers = {
    Authorization: JIRA_AUTH,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return null;
  if (!resp.ok) throw new Error(`Jira API ${method} ${path} ${resp.status}: ${await resp.text()}`);
  if (resp.status === 201 || resp.status === 200) {
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return text; }
  }
  return null;
}

function mapJiraStatus(name) {
  const map = { "to do": "todo", "ready": "ready", "in progress": "in_progress", "in review": "in_review", "blocked": "blocked", "done": "done", "backlog": "backlog" };
  return map[name.toLowerCase()] || name.toLowerCase().replace(/\s+/g, "_");
}

function mapJiraIssueToTicket(issue) {
  const f = issue.fields || {};
  const labels = f.labels || [];
  const agentLabel = labels.find(l => l.startsWith("agent:"));
  const reviewerLabel = labels.find(l => l.startsWith("reviewer:"));
  const wfLabel = labels.find(l => l.startsWith("wf:"));

  // Extract blockedBy from issue links
  // From this ticket's perspective: if it has an inwardIssue with type "is blocked by",
  // that inwardIssue is what blocks this ticket.
  const blockedBy = [];
  for (const link of (f.issuelinks || [])) {
    if (link.type?.inward === "is blocked by" && link.inwardIssue) {
      blockedBy.push(link.inwardIssue.key);
    }
  }

  // Latest comment (when the comment field was requested) — carries reviewer
  // "request changes" feedback for the rework flow in Jira mode.
  const jiraComments = (f.comment?.comments || []).map((c) => ({
    author: c.author?.displayName || "human",
    content: extractAdfText(c.body),
    timestamp: c.created,
  }));
  const reviewComment = jiraComments.length ? jiraComments[jiraComments.length - 1].content : undefined;

  const rawIssueType = f.issuetype?.name || "Task";
  return {
    ticketId: issue.key,
    title: f.summary || "",
    description: extractAdfText(f.description),
    status: mapJiraStatus(f.status?.name || "To Do"),
    // Human-review gates carry a reviewer:<who> label → assignee "human:<who>".
    assignee: agentLabel
      ? agentLabel.replace("agent:", "")
      : reviewerLabel
      ? `human:${reviewerLabel.replace("reviewer:", "")}`
      : null,
    parentId: f.parent?.key || null,
    workflowId: wfLabel ? wfLabel.replace("wf:", "") : null,
    type: rawIssueType.toLowerCase() === "epic" ? "epic" : "task",
    issueType: rawIssueType,
    labels,
    blockedBy,
    comments: jiraComments,
    ...(reviewComment ? { reviewComment } : {}),
    artifacts: [],
  };
}

function extractAdfText(adf) {
  if (!adf || !adf.content) return "";
  return adf.content.map(block => {
    if (block.content) return block.content.map(n => n.text || "").join("");
    return "";
  }).join("\n");
}

async function getTicketFromJira(ticketId) {
  const issue = await jiraFetch(`/rest/api/3/issue/${ticketId}?fields=summary,description,status,issuetype,parent,labels,issuelinks,assignee,comment`);
  if (!issue) return null;
  return mapJiraIssueToTicket(issue);
}

async function getChildTicketsFromJira(parentId) {
  const jql = encodeURIComponent(`parent = ${parentId} ORDER BY created ASC`);
  const data = await jiraFetch(`/rest/api/3/search/jql?jql=${jql}&fields=summary,status,labels,issuetype,parent,issuelinks,assignee,description&maxResults=100`);
  return (data?.issues || []).map(mapJiraIssueToTicket);
}

async function nextTicketId() {
  const projectKey = process.env.PROJECT_KEY || "TEAM";
  const result = await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId: "__COUNTER__" },
    UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
    ExpressionAttributeNames: { "#n": "nextNum" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    ReturnValues: "UPDATED_NEW",
  }));
  return `${projectKey}-${result.Attributes.nextNum}`;
}

// ─── S3 Helpers ────────────────────────────────────────────────────────────────

async function readS3Artifact(workflowId, path) {
  if (!ARTIFACT_BUCKET) return null;
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: `workflows/${workflowId}/${path}`,
    }));
    return await result.Body.transformToString();
  } catch {
    return null;
  }
}

// ─── Manifest Helpers ──────────────────────────────────────────────────────────

async function readManifest(workflowId) {
  const raw = await readS3Artifact(workflowId, "shared/manifest.json");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function initManifestIfNeeded(workflow) {
  if (!ARTIFACT_BUCKET) return;
  const existing = await readManifest(workflow.id);
  if (existing) return; // Already initialized

  const manifest = {
    workflowId: workflow.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repoConfig: workflow.repoConfig,
    phases: { intake: [], requirements: [], design: [], development: [], verification: [], ship: [] },
  };

  // Seed intake entries from workflow input sources (if any)
  if (workflow.input?.sources?.length > 0) {
    manifest.phases.intake = workflow.input.sources
      .filter(s => s.s3Key)
      .map((src, i) => ({
        id: `intake-${i}-${Date.now().toString(36)}`,
        type: "source",
        format: src.contentType?.includes("html") ? "html" : "text",
        description: src.label || src.value || `Source ${i}`,
        s3Key: src.s3Key,
        addedBy: "intake-processor",
        addedAt: manifest.createdAt,
        critical: true,
      }));
  }

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET,
    Key: `workflows/${workflow.id}/shared/manifest.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[orchestrator] Initialized manifest for ${workflow.id}`);
}

async function updateManifestSession(workflowId, agentId, sessionInfo) {
  if (!ARTIFACT_BUCKET) return;
  const manifestKey = `workflows/${workflowId}/shared/manifest.json`;
  let manifest;
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: manifestKey }));
    manifest = JSON.parse(await result.Body.transformToString());
  } catch {
    // Manifest doesn't exist yet — create minimal one
    manifest = { workflowId, createdAt: new Date().toISOString(), sessions: {} };
  }
  if (!manifest.sessions) manifest.sessions = {};
  manifest.sessions[agentId] = sessionInfo;
  manifest.updatedAt = new Date().toISOString();
  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[orchestrator] Recorded session for ${agentId} in manifest`);
}

function buildManifestContext(manifest, agentPhase, workflow, ticket) {
  if (!manifest) return "";

  const phaseOrder = ["intake", "requirements", "design", "development", "verification", "ship"];
  const currentIdx = phaseOrder.indexOf(agentPhase);
  if (currentIdx < 0) return "";

  let ctx = `## Workflow Manifest — Upstream Artifacts\n\n`;

  // Canonical repo info from manifest (single source of truth)
  if (manifest.repoConfig?.repos?.length > 0) {
    const url = manifest.repoConfig.repos[0].url || "";
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      ctx += `### Repository\n`;
      ctx += `- owner: "${match[1]}"\n- repo: "${match[2]}"\n`;
      ctx += `- default_branch: "${manifest.repoConfig.repos[0].defaultBranch || "main"}"\n\n`;
    }
  }

  // List upstream artifacts by phase
  for (const phase of phaseOrder) {
    if (phaseOrder.indexOf(phase) >= currentIdx) break;
    const entries = manifest.phases?.[phase] || [];
    if (entries.length === 0) continue;

    ctx += `### ${phase.charAt(0).toUpperCase() + phase.slice(1)} Phase Outputs\n`;
    for (const entry of entries) {
      const tag = entry.critical ? "★ " : "";
      ctx += `- ${tag}${entry.description}`;
      if (entry.s3Key) ctx += ` → s3://${ARTIFACT_BUCKET}/${entry.s3Key}`;
      ctx += `\n`;
    }
    ctx += `\n`;
  }

  // For QA/CI agents: inject upstream dev agent PR/branch info directly
  if (agentPhase === "verification" || agentPhase === "review") {
    const devEntries = manifest.phases?.development || [];
    const prEntries = devEntries.filter(e => e.description?.includes("Pull Request"));
    const branchEntries = devEntries.filter(e => e.description?.includes("Branch:"));
    if (prEntries.length > 0 || branchEntries.length > 0) {
      ctx += `### Code to Review (from Development Phase)\n`;
      for (const e of prEntries) ctx += `- ${e.description}\n`;
      for (const e of branchEntries) ctx += `- ${e.description}\n`;
      ctx += `\n`;
    }
  }

  return ctx;
}

// ─── Ticket-tools Lambda helper (reviewer roster) ──────────────────────────────

/**
 * Fetch the human-reviewer roster from the ticket-tools Lambda, optionally
 * filtered to a Jira project role (= domain). Returns [] on any failure or in
 * DynamoDB mode (no real users) so gate injection degrades gracefully.
 */
async function listReviewers(role) {
  if (TICKET_PROVIDER !== "jira") return [];
  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      Payload: JSON.stringify({ tool_name: "Tickets___list_reviewers", parameters: role ? { role } : {} }),
    }));
    const payload = JSON.parse(new TextDecoder().decode(res.Payload));
    return payload?.reviewers || [];
  } catch (err) {
    console.warn(`[orchestrator] listReviewers(${role}) failed: ${err.message}`);
    return [];
  }
}

// ─── GitHub Helpers ────────────────────────────────────────────────────────────
//
// Direct GitHub REST calls with GITHUB_PAT (already on this Lambda). The old
// path proxied through a `agentcore-hub-github-mcp` Lambda that is not part of
// any deploy script — in every real install callGitHub threw "Function not
// found", the shared feature branch was never created, and the unified PR at
// completion silently failed. That single silent WARN is what degraded runs
// into one-branch-per-ticket + one-PR-per-ticket. The Lambda proxy is kept as
// a fallback for installs that do deploy it.

// True when this workflow's def declares a "ship" completion phase (the release
// manager owns the merge). Used by the ship-phase merge gate in completeWorkflow.
function defHasShipPhase(workflow) {
  return (
    getWorkflowDef(workflow?.workflowDefId).completionRequiresAgentPhases || []
  ).includes("ship");
}

// Ship-phase merge gate helper (TEAM-3721). Returns a short reason string when
// the feature branch is PROVABLY not merged into the base branch, else "" (merged
// or can't-tell). Squash merges leave the branch commits absent from base, so we
// trust the PR's `merged` flag first (authoritative for both squash and merge
// commits); only if no PR is found do we fall back to the compare API. Any API
// error returns "" (fail-open — never block a legitimate completion on a transient).
async function featureBranchUnmerged(workflow) {
  try {
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const base = workflow.repoConfig.repos?.[0]?.defaultBranch || "main";
    const head = workflow.featureBranch;

    // 1) Authoritative: any PR from this head that is merged?
    const prs = await githubApi(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=all&per_page=20`
    );
    if (Array.isArray(prs) && prs.length > 0) {
      if (prs.some((p) => p.merged_at)) return ""; // merged — clean
      // PRs exist but none merged. Still cross-check compare in case the branch
      // was merged via a differently-headed PR / direct push.
    }

    // 2) Fallback: does base already contain the head? compare status
    //    "identical" or "behind" means head is an ancestor of base (merged).
    const cmp = await githubApi(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    // status is head-relative to base: "behind"/"identical" → head ⊆ base (merged);
    // "ahead"/"diverged" → head has commits not in base (not merged).
    if (cmp?.status === "identical" || cmp?.status === "behind") return "";
    if (cmp?.status === "ahead" || cmp?.status === "diverged") {
      return `branch ${cmp.ahead_by} commit(s) ahead of ${base} (status=${cmp.status})`;
    }
    return ""; // unknown status — fail open
  } catch (err) {
    console.warn(`[orchestrator] merge-verify skipped for ${workflow.id}: ${err.message}`);
    return ""; // fail open
  }
}

async function githubApi(path, method = "GET", body = null) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT not configured on orchestrator");
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentcore-hub-orchestrator",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!resp.ok) {
    const msg = json?.message || text.slice(0, 300);
    const err = new Error(`GitHub ${method} ${path} ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.githubMessage = msg;
    throw err;
  }
  return json;
}

async function callGitHub(toolName, args) {
  if (process.env.GITHUB_PAT) {
    if (toolName === "create_branch") {
      const { owner, repo, branch_name, from_branch } = args;
      const base = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
      try {
        return await githubApi(`/repos/${owner}/${repo}/git/refs`, "POST", {
          ref: `refs/heads/${branch_name}`,
          sha: base.object.sha,
        });
      } catch (err) {
        // Concurrent claim already created it — that IS the desired state.
        if (err.status === 422 && /already exists/i.test(err.githubMessage || "")) {
          return { ref: `refs/heads/${branch_name}`, existed: true };
        }
        throw err;
      }
    }
    if (toolName === "create_pr") {
      const { owner, repo, title, body, head, base } = args;
      try {
        return await githubApi(`/repos/${owner}/${repo}/pulls`, "POST", { title, body, head, base });
      } catch (err) {
        // "A pull request already exists" → return the existing one (idempotent).
        if (err.status === 422 && /already exists/i.test(err.githubMessage || "")) {
          const existing = await githubApi(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open`);
          if (existing?.length > 0) return existing[0];
        }
        throw err;
      }
    }
    if (toolName === "list_pr_files") {
      // The PR's changed-file list (TEAM-3748 D3): what the diff-scoped ship
      // review scopes against. Paginate — files come 100/page — but cap the walk
      // so a pathological PR can't spin the Lambda; the change set is a scoping
      // hint, not an audit, and any short read just fails open at the caller.
      const { owner, repo, pull_number } = args;
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await githubApi(
          `/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100&page=${page}`
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return files;
    }
  }
  // Legacy fallback: proxy through the github-mcp Lambda if an install has one.
  const result = await lambda.send(new InvokeCommand({
    FunctionName: GITHUB_LAMBDA,
    Payload: JSON.stringify({ name: toolName, arguments: args }),
  }));
  const payload = JSON.parse(new TextDecoder().decode(result.Payload));
  if (payload.content?.[0]?.text) {
    return JSON.parse(payload.content[0].text);
  }
  return payload;
}

/**
 * Idempotently create (or adopt) the run's shared feature branch and persist it
 * on the workflow row with if_not_exists — safe under the concurrent bursts
 * that happen when a whole phase of tickets goes ready in the same second.
 * Returns the branch name, or null when creation failed (callers must treat
 * null as "no shared branch": agents then base on the default branch).
 */
async function ensureFeatureBranch(workflow) {
  if (workflow.featureBranch) return workflow.featureBranch;
  // Shipped-session runs: the laptop already pushed its in-flight work to a
  // branch — ADOPT it as the run's shared integration branch so the pipeline
  // builds on the requester's work (and the final PR carries it) instead of
  // starting a parallel branch off the default.
  const ported = workflow.input?.portedSession;
  if (ported?.branch) {
    try {
      await store.adoptFeatureBranch(workflow.id, ported.branch);
      console.log(`[orchestrator] Adopted ported-session branch as shared feature branch: ${ported.branch}`);
      return ported.branch;
    } catch (err) {
      console.error(`[orchestrator] failed to adopt ported branch ${ported.branch}: ${err.message}`);
      // fall through to normal creation
    }
  }
  if (!workflow.repoConfig?.repos?.length) return null;
  try {
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const baseBranch = workflow.repoConfig?.repos?.[0]?.defaultBranch || "main";
    const slug = (workflow.input?.title || workflow.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "");
    const branchName = `feature/${workflow.epicId}-${slug}`;
    await callGitHub("create_branch", { owner, repo, branch_name: branchName, from_branch: baseBranch });
    await store.adoptFeatureBranch(workflow.id, branchName);
    console.log(`[orchestrator] Shared feature branch ready: ${branchName}`);
    return branchName;
  } catch (err) {
    // LOUD failure — a missing shared branch silently degrades the whole run
    // into per-ticket branches off main. Surface it like an agent error.
    console.error(`[orchestrator] FEATURE BRANCH CREATION FAILED for ${workflow.id}: ${err.message}`);
    await publishEvent(workflow.epicId, "workflow.branch_error", {
      workflowId: workflow.id,
      error: `Shared feature branch creation failed: ${err.message}. Dev agents will branch from the default branch.`,
    });
    return null;
  }
}

// ─── EventBridge Publishing ────────────────────────────────────────────────────

async function publishEvent(ticketId, detailType, detail) {
  // ONE timestamp for both writes (and inside detail): the anomaly-watcher
  // dedupes the EventBridge copy against the direct copy by
  // (workflowId, type, timestamp, ticketId, agentId) — two generated
  // timestamps would give the copies different keys and double every sample.
  const timestamp = new Date().toISOString();
  const stamped = { ...detail, ticketId, timestamp };
  try {
    await events.send(new PutEventsCommand({
      Entries: [{
        Source: "agentcore-hub.orchestrator",
        DetailType: detailType,
        Detail: JSON.stringify(stamped),
        EventBusName: EVENT_BUS,
      }],
    }));
  } catch (err) {
    console.warn(`[orchestrator] Failed to publish event:`, err.message);
  }

  // Also write to events table for dashboard polling
  if (EVENTS_TABLE) {
    try {
      await ddb.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          workflowId: detail.workflowId || ticketId,
          eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: detailType,
          detail: stamped,
          timestamp,
        },
      }));
    } catch { /* non-fatal */ }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function parseRepoUrl(repoConfig) {
  const url = repoConfig?.repos?.[0]?.url || "";
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return match ? { owner: match[1], repo: match[2] } : { owner: "", repo: "" };
}

/**
 * Resolve the target repo from a Jira ticket's labels. The repo rides on the
 * Bug as `repo:owner/name`; branch is optional via `branch:<name>` (default
 * "main"). This is what lets a single hub route bug fixes to many repositories
 * with zero per-repo configuration.
 *
 * Returns a tri-state so the caller can tell "no label" from "bad label":
 *   { status: "none" }                    → no repo: label at all (fallback OK)
 *   { status: "invalid", slug }           → repo: label present but malformed
 *                                            (must NOT fall back — the ticket
 *                                            explicitly named a repo; a typo
 *                                            routing to DEFAULT_BUG_REPO_URL
 *                                            would open a PR on the wrong repo)
 *   { status: "ok", repoConfig }          → valid repo:owner/name
 */
function repoConfigFromLabels(labels) {
  const repoLabel = (labels || []).find((l) => l.startsWith("repo:"));
  if (!repoLabel) return { status: "none" };
  const slug = repoLabel.slice("repo:".length).trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return { status: "invalid", slug }; // must be exactly owner/name
  const branchLabel = (labels || []).find((l) => l.startsWith("branch:"));
  const defaultBranch = branchLabel ? branchLabel.slice("branch:".length).trim() : "main";
  return {
    status: "ok",
    repoConfig: { repos: [{ platform: "github", url: `https://github.com/${slug}`, defaultBranch }] },
  };
}

/**
 * Optional single-repo fallback for simple deployments that only ever fix bugs
 * in one repo. Set DEFAULT_BUG_REPO_URL to enable; unset → null (label required).
 */
function defaultBugRepoConfig() {
  const url = process.env.DEFAULT_BUG_REPO_URL;
  if (!url) return null;
  return { repos: [{ platform: "github", url, defaultBranch: process.env.DEFAULT_BUG_REPO_BRANCH || "main" }] };
}

/**
 * Post a plain-text comment on a Bug (best-effort). Used to tell a reporter why
 * bootstrap was skipped and how to retry: transitioning the Bug back to "To Do"
 * re-fires the jira webhook → processStatusChange("todo") → bootstrap re-runs
 * (idempotent), which is the supported retry path since issue_updated events
 * without a status change are not acted on.
 */
async function commentOnBug(bugKey, text) {
  try {
    await jiraFetch(`/rest/api/3/issue/${bugKey}/comment`, "POST", {
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    });
  } catch { /* comment is best-effort */ }
}

/**
 * Unwrap DynamoDB AttributeValue from stream format.
 * Stream records use {"S": "value"}, {"N": "123"}, {"L": [...]}, etc.
 */
function unwrapDdbValue(attr) {
  if (!attr) return undefined;
  if (attr.S !== undefined) return attr.S;
  if (attr.N !== undefined) return Number(attr.N);
  if (attr.BOOL !== undefined) return attr.BOOL;
  if (attr.NULL) return null;
  if (attr.L) return attr.L.map(unwrapDdbValue);
  if (attr.M) {
    const obj = {};
    for (const [k, v] of Object.entries(attr.M)) {
      obj[k] = unwrapDdbValue(v);
    }
    return obj;
  }
  // Already unwrapped (e.g., from DocumentClient format)
  if (typeof attr === "string" || typeof attr === "number" || typeof attr === "boolean") return attr;
  if (Array.isArray(attr)) return attr;
  return attr;
}
