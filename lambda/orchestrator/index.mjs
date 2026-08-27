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
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

// ─── Config ────────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const GITHUB_LAMBDA = process.env.GITHUB_LAMBDA || "agentcore-hub-github-mcp";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const MAX_QA_RETRIES = 3;
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

async function loadWorkflowDefs() {
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

// ─── Handler (DDB Stream OR direct webhook invocation) ───────────────────────

export const handler = async (event) => {
  // Load roster + workflow defs from S3 on first invocation (cached for warm starts)
  await loadAgentRoster();
  await loadWorkflowDefs();

  // Direct invocation from Jira webhook (TICKET_PROVIDER=jira ONLY)
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
 * Called from processStatusChange (Jira webhook path). Exported for tests —
 * the webhook route to it is gated on TICKET_PROVIDER=jira at module load.
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

  // ── gate approved → close its open review notification ──
  if (isHumanAssignee(assignee)) {
    await ackReviewNotifications(workflow, ticketId); // never throws
  }

  // Unblock dependents
  const siblings = await getChildTickets(parentId);
  const unblocked = [];

  for (const sibling of siblings) {
    if (sibling.ticketId === ticketId) continue;
    const blockers = sibling.blockedBy || [];
    if (blockers.includes(ticketId)) {
      // Check if all blockers are now resolved (done) — keep blockedBy intact like Jira does
      const allResolved = blockers.every(bid => {
        if (bid === ticketId) return true; // this one is done
        const blocker = siblings.find(s => s.ticketId === bid);
        return blocker && (blocker.status === "done" || blocker.status === "cancelled");
      });
      if (allResolved && (sibling.status === "blocked" || sibling.status === "todo")) {
        // All blockers resolved — transition to ready (keep blockedBy as historical record)
        if (TICKET_PROVIDER === "jira") {
          await jiraTransition(sibling.ticketId, "Ready");
        } else {
          await ddb.send(new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { ticketId: sibling.ticketId },
            UpdateExpression: "SET #s = :s, #u = :u",
            ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
            ExpressionAttributeValues: { ":s": "todo", ":u": new Date().toISOString() },
          }));
        }
        unblocked.push(sibling.ticketId);
      }
      // blockedBy array is never modified — it's a permanent record of dependencies
    }
  }

  console.log(`[orchestrator] ${ticketId} done. Unblocked: [${unblocked.join(", ")}]`);
  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // Journey log: record each unblock for at-a-glance traceability
  for (const unblockedId of unblocked) {
    await publishEvent(unblockedId, "orchestrator.unblocked", {
      ticketId: unblockedId, unblockedBy: ticketId, workflowId: workflow?.id,
    });
  }

  // Always check workflow completion — the last ticket to close triggers this
  if (await isWorkflowComplete(parentId, workflow)) {
    await completeWorkflow(workflow);
  }
}

/** Whether an assignee refers to a human reviewer (review gate) vs an agent. */
function isHumanAssignee(assignee) {
  return typeof assignee === "string" && assignee.startsWith("human:");
}

/**
 * Indices of open review_needed notifications for a ticket.
 * Exported for tests. Pure — no I/O.
 */
export function reviewAckIndices(workflow, ticketId) {
  const list = workflow?.humanNotifications;
  if (!Array.isArray(list)) return [];
  const idx = [];
  list.forEach((n, i) => {
    if (n?.ticketId === ticketId && n?.type === "review_needed" && n?.acknowledged !== true) {
      idx.push(i);
    }
  });
  return idx;
}

/**
 * Acknowledge all open review_needed notifications for a resolved gate ticket.
 * SCOPED per-index write on workflow.humanNotifications — never a full-row put
 * (see the race warning at markTaskComplete / handleTicketDoneUnified).
 * Mutates the in-memory snapshot too, so a later full save in the same cascade
 * (e.g. completeWorkflow's saveWorkflow) can't resurrect acknowledged:false.
 * Never throws — ack failure must not break the done/reject cascade.
 */
export async function ackReviewNotifications(workflow, ticketId) {
  try {
    const indices = reviewAckIndices(workflow, ticketId);
    if (indices.length === 0) return; // silent no-op — NO DynamoDB call
    const setClauses = indices.map((i) => `humanNotifications[${i}].acknowledged = :true`);
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeValues: { ":true": true },
    }));
    // Keep the snapshot consistent — completeWorkflow() does a full
    // saveWorkflow(workflow) later in the same cascade and must not
    // write acknowledged:false back.
    for (const i of indices) workflow.humanNotifications[i].acknowledged = true;
    console.log(`[orchestrator] Acknowledged ${indices.length} review notification(s) for ${ticketId}`);
  } catch (err) {
    console.error(`[orchestrator] ackReviewNotifications failed for ${ticketId} (non-fatal):`, err.message);
  }
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
  await ddb.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: workflow.id },
    UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await ddb.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: workflow.id },
    UpdateExpression: "SET agentTasks.#tid = :task",
    ExpressionAttributeNames: { "#tid": ticketId },
    ExpressionAttributeValues: { ":task": entry },
  }));
  if (!workflow.agentTasks) workflow.agentTasks = {};
  workflow.agentTasks[ticketId] = entry;
}

async function claimTicketInvocation(workflow, ticketId, assignee) {
  const now = new Date().toISOString();
  const taskId = workflow.agentTasks?.[ticketId]?.id || `task_${Date.now()}_${assignee}`;
  // Stale-claim escape hatch: a claim older than this is a crashed session, not
  // a live one — a human moving the ticket back to Ready on the board must be
  // able to re-dispatch without the retry endpoint. Longest legitimate agent
  // session is ~25 min (claude_code hard-caps at 15); 60 min is safely past it.
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    // Ensure the map + entry exist without disturbing a concurrent claim.
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :empty)",
      ExpressionAttributeValues: { ":empty": {} },
    }));
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: "SET agentTasks.#tid = :task",
      ConditionExpression:
        "attribute_not_exists(agentTasks.#tid) OR agentTasks.#tid.#st <> :running OR agentTasks.#tid.startedAt < :staleBefore",
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: {
        ":task": {
          ...(workflow.agentTasks?.[ticketId] || {}),
          id: taskId,
          agentId: assignee,
          ticketId,
          status: "running",
          startedAt: now,
        },
        ":running": "running",
        ":staleBefore": staleBefore,
      },
    }));
    if (!workflow.agentTasks) workflow.agentTasks = {};
    workflow.agentTasks[ticketId] = {
      ...(workflow.agentTasks[ticketId] || {}),
      id: taskId, agentId: assignee, ticketId, status: "running", startedAt: now,
    };
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
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
  // Only skip when an unacknowledged review_needed notification already exists.
  if (workflow) {
    if (!Array.isArray(workflow.humanNotifications)) workflow.humanNotifications = [];
    const alreadyNotified = workflow.humanNotifications.some(
      (n) => n.ticketId === ticketId && n.type === "review_needed" && !n.acknowledged
    );
    if (alreadyNotified) {
      console.log(`[orchestrator] ${ticketId} already has an open review notification — skipping duplicate.`);
      return;
    }
    workflow.humanNotifications.push({
      id: `notif_${ticketId}_${new Date().toISOString()}`,
      type: "review_needed",
      title: `Review needed: ${ticketId}`,
      details: `Ticket ${ticketId} is awaiting review by ${reviewer}.`,
      ticketId,
      reviewer,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
    await saveWorkflow(workflow);
  }

  await publishEvent(ticketId, "review.needed", {
    ticketId, reviewer, workflowId: workflow?.id,
  });
  console.log(`[orchestrator] ${ticketId} parked for human review (${reviewer}) — not invoking an agent.`);
}

/**
 * A human "requested changes" on a review-gate ticket (moved it to blocked).
 * Look up the gate's config for the run; if onReject is "rework", re-open the
 * upstream agent tickets this gate reviewed (its blockedBy) so the agents redo
 * the work with the reviewer's comment as resume context. "hold" → just pause.
 */
async function handleReviewRejection(gateTicket) {
  const workflow = await resolveWorkflow(gateTicket.workflowId, gateTicket.parentId);
  if (!workflow) return;

  // Acknowledge this gate's open review notification — the review concluded, and
  // clearing it lets a later cycle (after rework) create a fresh notification.
  await ackReviewNotifications(workflow, gateTicket.ticketId);

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
        `You MAY pass it as resume_session on your first claude_code/codex call to continue that ` +
        `conversation with its context intact — or omit it to start fresh. Resume is best-effort.`
      : "";
    const resumeNote = `## Review feedback (changes requested)\n${feedback}\n\nAddress this feedback and redo your work.${sessionHint}`;
    await setResumeContext(workflow.id, up.ticketId, resumeNote);
    reopened.push(up.ticketId);
  }

  // Re-open each upstream ticket so its agent re-runs. Done has no direct path to
  // Ready — in Jira it must hop Done → To Do (Reopen) → Ready.
  for (const up of upstream) {
    if (TICKET_PROVIDER === "jira") {
      await jiraReopenToReady(up.ticketId);
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId: up.ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "todo", ":u": new Date().toISOString() },
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
  // Atomic per-key REMOVE on the resumeContexts map — NOT a full-object put.
  // Multiple reworked tickets re-run concurrently; a full put here would clobber
  // sibling updates. Scoping the write to one map key keeps them independent.
  delete workflow.resumeContexts[ticketId];
  try {
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: "REMOVE resumeContexts.#k",
      ExpressionAttributeNames: { "#k": ticketId },
    }));
  } catch (err) {
    // Fall back to a full save if the map attribute doesn't exist yet.
    console.warn(`[orchestrator] atomic resumeContext remove failed (${ticketId}): ${err.message}`);
    await saveWorkflow(workflow);
  }
  return note;
}

/** Atomically set resumeContexts[ticketId] without overwriting the whole row. */
async function setResumeContext(workflowId, ticketId, note) {
  // Ensure the map exists (no-op if already present), then set just our key.
  // Two scoped updates avoid clobbering concurrent sibling writes.
  await ddb.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
    UpdateExpression: "SET resumeContexts = if_not_exists(resumeContexts, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  await ddb.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
    UpdateExpression: "SET resumeContexts.#k = :note",
    ExpressionAttributeNames: { "#k": ticketId },
    ExpressionAttributeValues: { ":note": note },
  }));
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

    // Scoped write — a full-row put here would clobber concurrent sibling
    // claims (many tickets of the same phase go ready in the same second).
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: workflow.featureBranch
        ? "SET phase = :p, featureBranch = if_not_exists(featureBranch, :fb)"
        : "SET phase = :p",
      ExpressionAttributeValues: {
        ":p": workflow.phase,
        ...(workflow.featureBranch ? { ":fb": workflow.featureBranch } : {}),
      },
    }));
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

  await invokeAgent(agentDef, context, workflow);
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

  // Scoped per-key write — tickets are created in bursts concurrent with
  // sibling invocation claims; a full-row put here would clobber them.
  const entry = {
    id: `task_${Date.now()}_${assignee}`,
    agentId: assignee,
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new UpdateCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId: workflow.id },
    UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :empty)",
    ExpressionAttributeValues: { ":empty": {} },
  }));
  try {
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: "SET agentTasks.#tid = :task",
      ConditionExpression: "attribute_not_exists(agentTasks.#tid)",
      ExpressionAttributeNames: { "#tid": ticketId },
      ExpressionAttributeValues: { ":task": entry },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    return; // concurrently tracked — keep the existing entry
  }
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
 */
async function handleTicketDone(ticketId, image) {
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

  // ── gate approved → close its open review notification ──
  if (isHumanAssignee(assignee)) {
    await ackReviewNotifications(workflow, ticketId); // never throws
  }

  // Unblock dependents: find tickets blocked by this one
  const siblings = await getChildTickets(parentId);
  const unblocked = [];

  for (const sibling of siblings) {
    if (sibling.ticketId === ticketId) continue;
    const blockers = sibling.blockedBy || [];
    if (blockers.includes(ticketId)) {
      // Check if all blockers are now resolved — keep blockedBy intact (like Jira issue links)
      const allResolved = blockers.every(bid => {
        if (bid === ticketId) return true; // this one is done
        const blocker = siblings.find(s => s.ticketId === bid);
        return blocker && (blocker.status === "done" || blocker.status === "cancelled");
      });
      if (allResolved && sibling.status === "blocked") {
        // All blockers resolved — transition to todo (keep blockedBy as historical record)
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId: sibling.ticketId },
          UpdateExpression: "SET #s = :s, #u = :u",
          ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
          ExpressionAttributeValues: { ":s": "todo", ":u": new Date().toISOString() },
        }));
        unblocked.push(sibling.ticketId);
      }
      // blockedBy array is never modified — it's a permanent record of dependencies
    }
  }

  console.log(`[orchestrator] ${ticketId} done. Unblocked: [${unblocked.join(", ")}]`);

  // Publish event for UI
  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // Check if workflow is complete (all tickets done)
  if (unblocked.length === 0) {
    if (await isWorkflowComplete(parentId, workflow)) {
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

    // Scoped write — full-row put would clobber concurrent sibling claims.
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: workflow.featureBranch
        ? "SET phase = :p, featureBranch = if_not_exists(featureBranch, :fb)"
        : "SET phase = :p",
      ExpressionAttributeValues: {
        ":p": workflow.phase,
        ...(workflow.featureBranch ? { ":fb": workflow.featureBranch } : {}),
      },
    }));
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
  await invokeAgent(agentDef, context, workflow);
}

// ─── QA Gate ───────────────────────────────────────────────────────────────────

async function shouldCreateQaTicket(epicId, workflow) {
  const children = await getChildTickets(epicId);

  // Check if QA ticket already exists (active OR done — never create more than one)
  const hasQaTicket = children.some(
    (t) => t.assignee === "agentcore_hub_qa_verifier" && t.status !== "blocked"
  );
  if (hasQaTicket) return false;

  // Check if all dev tickets are done
  const devTickets = children.filter(
    (t) => t.assignee && (t.assignee.endsWith("_dev") || t.assignee.endsWith("_frontend"))
  );
  if (devTickets.length === 0) return false;
  const allDevsDone = devTickets.every((t) => t.status === "done");
  if (!allDevsDone) return false;

  // Check if design tickets are done
  const designTickets = children.filter((t) => t.assignee && t.assignee.endsWith("_designer"));
  const allDesignDone = designTickets.every((t) => t.status === "done");

  return allDevsDone && allDesignDone;
}

async function isWorkflowComplete(epicId, workflow) {
  const children = await getChildTickets(epicId);
  if (children.length === 0) return false;

  // Gate: at least one ticket in a "terminal" agent phase must be done — so a
  // workflow isn't declared complete after only requirements/design finish.
  const wfDef = getWorkflowDef(workflow?.workflowDefId);
  const terminalPhases = wfDef.completionRequiresAgentPhases || [];

  let hasTerminalDone;
  if (terminalPhases.length > 0) {
    // Config-driven: map each ticket's assignee → agent phase via the roster.
    hasTerminalDone = children.some((t) => {
      if (t.status !== "done" || !t.assignee) return false;
      const def = getAgentDef(t.assignee);
      return def && terminalPhases.includes(def.phase);
    });
  } else {
    // Legacy suffix heuristic (software-delivery shape) — preserved as fallback.
    hasTerminalDone = children.some((t) => {
      const assignee = t.assignee || "";
      const isDevOrQa = assignee.endsWith("_dev") || assignee.includes("_qa") || assignee.includes("_ci");
      return isDevOrQa && t.status === "done";
    });
  }
  if (!hasTerminalDone) return false;
  return children.every((t) => t.status === "done");
}

async function createQaVerificationTicket(workflow) {
  console.log(`[orchestrator] All dev agents complete. Creating QA ticket...`);

  workflow.phase = "verification";
  await saveWorkflow(workflow);
  await publishEvent(workflow.epicId, "workflow.phase_change", { phase: "verification", workflowId: workflow.id });

  const children = await getChildTickets(workflow.epicId);
  const devTickets = children.filter((t) => t.assignee && t.assignee.endsWith("_dev"));
  const devSummaries = devTickets.map((t) => `- ${t.title} (${t.assignee}): ${t.status}`).join("\n");
  const inputSources = (workflow.input?.sources || []).map((s) => `- ${s.type}: ${s.value}`).join("\n");

  const qaDescription = `## QA Verification: ${workflow.input.title}

### What was built:
${devSummaries}

### Feature branch: \`${workflow.featureBranch || "unknown"}\`

### Original input/mockups:
${inputSources}

### Your job:
1. Build and run the app on the feature branch
2. Visually compare EVERY affected page against the original mockups
3. Run functional tests
4. Run regression tests
5. If all passes → report_completion
6. If anything fails → request_fix back to the dev agent with evidence`;

  // Create QA ticket (status=todo, no blockers → stream will fire handleTicketReady)
  const ticketId = await nextTicketId();
  await ddb.send(new PutCommand({
    TableName: TICKETS_TABLE,
    Item: {
      ticketId,
      type: "task",
      title: "QA: Visual & functional verification",
      description: qaDescription,
      status: "todo",
      assignee: "agentcore_hub_qa_verifier",
      parentId: workflow.epicId,
      workflowId: workflow.id,
      comments: [],
      artifacts: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }));

  console.log(`[orchestrator] Created QA ticket ${ticketId}`);
}

async function completeWorkflow(workflow) {
  if (workflow.phase === "complete") return;
  console.log(`[orchestrator] Workflow ${workflow.id} complete!`);

  workflow.phase = "complete";
  workflow.completedAt = new Date().toISOString();

  // Create unified PR if feature branch exists
  let prUrl = "";
  if (workflow.featureBranch && workflow.repoConfig) {
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

  await saveWorkflow(workflow);
  await publishEvent(workflow.epicId, "workflow.complete", {
    workflowId: workflow.id,
    featureBranch: workflow.featureBranch,
    prUrl,
  });
}

// ─── Agent Invocation ──────────────────────────────────────────────────────────

/**
 * Discover harness ARN and invoke the agent.
 * Fire-and-forget: agent runs asynchronously. When done, it calls report_completion
 * which writes "done" to DynamoDB, triggering this Lambda again via the stream.
 */
async function invokeAgent(agentDef, context, workflow) {
  // Discover agent ARN — prefer runtimeArn from roster, then env var lookup
  const runtimeEnvKey = `RUNTIME_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessEnvKey = `HARNESS_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessArn = agentDef.runtimeArn || process.env[runtimeEnvKey] || process.env[harnessEnvKey];
  if (!harnessArn) {
    console.error(`[orchestrator] No ARN for agent: ${agentDef.agentId}. Tried ${runtimeEnvKey} and ${harnessEnvKey}. Marking ticket blocked.`);
    const task = Object.values(workflow.agentTasks || {}).find(t => t.agentId === agentDef.agentId && t.status === "running");
    // Publish the error FIRST — the ticket-blocking below can fail (e.g. the
    // tickets table doesn't exist in Jira mode) and the Workflow Manager needs
    // an agent.error event to distinguish "never started" from "hung".
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: task?.ticketId || "",
      error: `No runtime ARN configured. Set ${runtimeEnvKey} env var on orchestrator Lambda.`,
    });
    await releaseClaimOnFailure(workflow.id, task?.ticketId);
    await blockTicketForFailedInvoke(task?.ticketId, "no runtime ARN configured");
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
    const task = Object.values(workflow.agentTasks || {}).find(t => t.agentId === agentDef.agentId && t.status === "running");
    const ticketPrefix = task?.ticketId ? `${task.ticketId}_` : "";
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
        ticketId: task?.ticketId || "",
        modelOverride: modelConfig,
        // Routine-scoped connectors travel with the workflow → each agent invoke.
        connectors: workflow.connectors,
      }),
    }));

    console.log(`[orchestrator] Async invoke sent for ${agentDef.agentId} (session: ${sessionId})`);

    // Journey log: agent invocation dispatched
    await publishEvent(task?.ticketId || agentDef.agentId, "orchestrator.agent_invoked", {
      ticketId: task?.ticketId || "", agentId: agentDef.agentId, sessionId,
      workflowId: workflow.id, runtimeArn: harnessArn,
    });

    // Persist session info to the workflow manifest (S3) for health probes and traceability
    try {
      await updateManifestSession(workflow.id, agentDef.agentId, {
        sessionId,
        runtimeArn: harnessArn,
        invokedAt: new Date().toISOString(),
        ticketId: Object.values(workflow.agentTasks || {}).find(t => t.agentId === agentDef.agentId && t.status === "running")?.ticketId,
      });
    } catch (err) {
      console.warn(`[orchestrator] Manifest session write failed (non-fatal): ${err.message}`);
    }
  } catch (err) {
    console.error(`[orchestrator] Failed to invoke ${agentDef.agentId}:`, err);
    const task = Object.values(workflow.agentTasks || {}).find(t => t.agentId === agentDef.agentId && t.status === "running");
    // Error event first — see the no-ARN path above for why.
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: task?.ticketId || "",
      error: `Invoke failed: ${err.message}`,
    });
    await releaseClaimOnFailure(workflow.id, task?.ticketId);
    await blockTicketForFailedInvoke(task?.ticketId, `invoke failed: ${err.message}`);
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
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid.#st = :s",
      ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
      ExpressionAttributeValues: { ":s": "error" },
      ConditionExpression: "attribute_exists(agentTasks.#tid)",
    }));
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
  if (!id || typeof id !== "string") return null;
  const result = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId: id }, ConsistentRead: true }));
  return result.Item || null;
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

async function saveWorkflow(workflow) {
  await ddb.send(new PutCommand({ TableName: WORKFLOWS_TABLE, Item: { ...workflow, workflowId: workflow.id } }));
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

  const workflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  await saveWorkflow(workflow);

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
    phases: { intake: [], requirements: [], design: [], development: [], verification: [] },
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

  const phaseOrder = ["intake", "requirements", "design", "development", "verification"];
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
      await ddb.send(new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId: workflow.id },
        UpdateExpression: "SET featureBranch = if_not_exists(featureBranch, :fb)",
        ExpressionAttributeValues: { ":fb": ported.branch },
      }));
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
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: workflow.id },
      UpdateExpression: "SET featureBranch = if_not_exists(featureBranch, :fb)",
      ExpressionAttributeValues: { ":fb": branchName },
    }));
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
  try {
    await events.send(new PutEventsCommand({
      Entries: [{
        Source: "agentcore-hub.orchestrator",
        DetailType: detailType,
        Detail: JSON.stringify({ ...detail, ticketId, timestamp: new Date().toISOString() }),
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
          detail,
          timestamp: new Date().toISOString(),
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
