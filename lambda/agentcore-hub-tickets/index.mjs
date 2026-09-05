/**
 * agentcore-hub-tickets — Ticket tools Lambda backed by DynamoDB.
 *
 * Deploy this when TICKET_PROVIDER=dynamodb.
 * Agents call this Lambda to create/update/transition tickets stored in DynamoDB.
 *
 * Tools (matching existing gateway schema):
 *   - create_ticket: Create a new issue (story/task/bug/epic)
 *   - get_issue: Read a single issue by key
 *   - edit_issue: Update issue fields
 *   - search_issues: Search by JQL-like query
 *   - transition_issue: Move issue to new status
 *   - get_transitions: Get available transitions for an issue
 *   - add_comment: Add a comment to an issue
 *   - list_projects: List projects (returns our single project)
 *   - get_project_issue_types: Get issue types for a project
 *   - lookup_user: Look up agents by name
 *
 * DynamoDB Table Schema:
 *   PK: ticketId (e.g., "TEAM-42")
 *   GSI1: parentId-index (for listing children of an epic)
 *   GSI2: assignee-index (for listing tickets by agent)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const PROJECT_KEY = process.env.PROJECT_KEY || "TEAM";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

const COUNTER_KEY = { ticketId: "__COUNTER__" };

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_AGENTS = new Set([
  "agentcore_hub_requirements_analyst",
  "agentcore_hub_ios_designer",
  "agentcore_hub_frontend_designer",
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

let VALID_AGENTS = null;

async function loadValidAgents() {
  if (VALID_AGENTS) return VALID_AGENTS;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-tickets] No ARTIFACT_BUCKET — using fallback roster");
    VALID_AGENTS = FALLBACK_AGENTS;
    return VALID_AGENTS;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    VALID_AGENTS = new Set(config.agents.map((a) => a.agentId));
    console.log(`[agentcore-hub-tickets] Loaded ${VALID_AGENTS.size} agents from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] Failed to load roster from S3: ${err.message} — using fallback`);
    VALID_AGENTS = FALLBACK_AGENTS;
  }
  return VALID_AGENTS;
}

/**
 * TEAM-4100 F2 (layer 2, best-effort create-time check) — the set of assignees a
 * validated ticket plan authorized for a workflow. The plan is persisted by
 * workflow-output submitTicketPlan (only AFTER it validates against the def's
 * ticketDag in enforce/shadow mode) at shared/ticket-plan.json in the SAME
 * bucket this Lambda already reads the roster from — one cheap GetObject, no new
 * IAM. Returns null when no plan exists or on any read/parse failure: the check
 * fails OPEN because the orchestrator's realized-graph gate (layer 1) is the
 * hard gate. Layer 2 only tightens the analyst's create path when it provably can.
 */
async function planAssigneeSet(workflowId) {
  if (!workflowId || !ARTIFACT_BUCKET) return null;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: `workflows/${workflowId}/shared/ticket-plan.json`,
    }));
    const plan = JSON.parse(await res.Body.transformToString());
    const tickets = Array.isArray(plan?.tickets) ? plan.tickets : [];
    const set = new Set();
    for (const t of tickets) {
      const a = typeof t?.assignee === "string" ? t.assignee.trim() : "";
      if (a) set.add(a);
    }
    return set.size > 0 ? set : null;
  } catch {
    return null; // no plan persisted / unreadable → no create-time check
  }
}

// TEAM-3686: known workflow phases, for validating the `phase` stamp on
// fix-kind tickets. completion.mjs's open-fix gate matches fix tickets
// per-phase (`phaseOf(t) === p` for each required phase p), so a fix ticket
// stamped with a phase outside the known set is invisible to EVERY required
// phase's check — the workflow could complete with the fix still open. The
// valid set is derived from the same S3 configs the orchestrator reads:
// roster phases from config/agents.json (what getAgentPhase resolves) and
// each workflow def's agentPhases + completionRequiresAgentPhases from
// config/workflows.json. Fallback mirrors the orchestrator's FALLBACK_ROSTER.
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
    console.warn("[agentcore-hub-tickets] No ARTIFACT_BUCKET — using fallback phase set");
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
    console.warn(`[agentcore-hub-tickets] Failed to load agent phases from S3: ${err.message}`);
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
    console.warn(`[agentcore-hub-tickets] Failed to load workflow phases from S3: ${err.message}`);
  }
  if (phases.size === 0) {
    console.warn("[agentcore-hub-tickets] No phases loaded from S3 — using fallback phase set");
    VALID_PHASES = FALLBACK_PHASES;
  } else {
    VALID_PHASES = phases;
    console.log(`[agentcore-hub-tickets] Loaded ${phases.size} valid phases from S3 config`);
  }
  return VALID_PHASES;
}

// Valid status transitions
// Simplified flow: todo → ready → in_progress → done  (+blocked as escape hatch)
const TRANSITIONS = {
  todo: [
    { id: "ready", name: "Mark Ready", to: "ready" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  ready: [
    { id: "start", name: "Start Progress", to: "in_progress" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  in_progress: [
    { id: "done", name: "Done", to: "done" },
    { id: "in_review", name: "Send to Review", to: "in_review" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  // Human-review gate states: approve (→done) or request changes (→blocked).
  in_review: [
    { id: "done", name: "Approve", to: "done" },
    { id: "block", name: "Request Changes", to: "blocked" },
  ],
  blocked: [
    { id: "unblock", name: "Unblock", to: "todo" },
    { id: "ready", name: "Mark Ready", to: "ready" },
    { id: "start", name: "Start Progress", to: "in_progress" },
    { id: "in_review", name: "Send to Review", to: "in_review" },
    { id: "skip", name: "Skip", to: "done" },
  ],
  done: [
    { id: "reopen", name: "Reopen", to: "todo" },
  ],
};

/**
 * TEAM-4099 F3 — the callers allowed to DECIDE a human-review gate.
 *
 * The tool path carries no caller identity: `_invoke_lambda` in
 * deploy/runtime-agent/main.py sends only `{name, tool_name, arguments,
 * parameters}`, so this Lambda cannot tell a dev agent from the console. That made
 * `in_review → done` on a `human:*` gate ticket forgeable by any agent — and a
 * forged gate `done` is not just a wrong board state: gate-bypass.mjs used to read
 * a `done` gate with no ledger row as a `legacy_status` APPROVE, so an agent could
 * merge unapproved and then certify its own merge as clean.
 *
 * With no identity to authenticate, the floor is a capability marker that only
 * SERVER-SIDE invokers set. It is read from the event ROOT and only when the tool
 * arguments arrived NESTED (`parameters`/`arguments`/`input`), which every gateway
 * and main.py shape does — an agent controls the argument object, never the
 * envelope around it. When args are at the root (the `|| event` fallback in the
 * handler) the whole event is agent-supplied and nothing in it is trustworthy.
 *
 * Kept in lock-step with the Jira twin (lambda/agentcore-hub-jira/index.mjs).
 */
const TRUSTED_CALLERS = new Set(["console", "telegram", "orchestrator"]);

function trustedCallerOf(event) {
  const nested = event?.parameters || event?.arguments || event?.input;
  if (!nested || typeof nested !== "object") return null;
  return TRUSTED_CALLERS.has(event?._caller) ? event._caller : null;
}

export const handler = async (event) => {
  console.log("Jira MCP invoked:", JSON.stringify(event));

  // Load roster from S3 on first invocation (cached for warm starts)
  await loadValidAgents();

  // Gateway sends tool name via different field patterns
  let toolName = event._tool_name || event.tool_name || event.name || detectTool(event);
  // Strip prefix (agents call as "Tickets___create_ticket" → "create_ticket")
  if (toolName && toolName.includes("___")) {
    toolName = toolName.split("___").pop();
  }
  // Arguments may come nested under "arguments" or "input" or "parameters" or at top level
  const args = event.parameters || event.arguments || event.input || event;

  try {
    switch (toolName) {
      case "create_ticket":
        return await createTicket(args, { caller: trustedCallerOf(event) });
      case "get_issue":
        return await getIssue(args);
      case "edit_issue":
        return await editIssue(args);
      case "search_issues":
        return await searchIssues(args);
      case "list_tickets":
        return await listTickets(args);
      case "transition_issue":
      case "transition_ticket":
        return await transitionIssue(args, { caller: trustedCallerOf(event) });
      case "get_transitions":
        return await getTransitions(args);
      case "add_comment":
        return await addComment(args);
      case "add_blockers":
        return await addBlockers(args);
      case "list_projects":
        return await listProjects();
      case "get_project_issue_types":
        return await getProjectIssueTypes(args);
      case "lookup_user":
        return await lookupUser(args);
      default: {
        // Return an `error` field so callers (e.g. workflow-output) can tell a
        // no-op from a real result. Without this, an unrecognized tool name
        // looked like success and silently stalled the pipeline.
        const message = `Unknown tool: "${toolName}". Available: create_ticket, get_issue, edit_issue, search_issues, list_tickets, transition_issue (alias: transition_ticket), get_transitions, add_comment, add_blockers, list_projects, get_project_issue_types, lookup_user`;
        return { error: message, content: [{ text: message }] };
      }
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    return textResult(`Error: ${err.message}`);
  }
};

// ─── Tool Implementations ──────────────────────────────────────────────────

// TEAM-3619 D4c: the fix-ticket kinds the completion re-verify (completion.mjs
// condition iii) recognizes, and the origin-id keys each may carry. A fix ticket
// created by the QA verifier / code reviewer stamps this so an in-flight fix
// keeps the run from being declared complete. Kept in lockstep with
// completion.mjs's FIX_KINDS and index.mjs:816's review_fix shape.
const FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix"]);
const SPAWN_ORIGIN_KEYS = ["gateTicketId", "qaTicketId", "codexTicketId"];
// TEAM-3991 D2.2 — non-origin provenance fields (never used to resolve an edge).
const SPAWN_META_KEYS = ["by", "findingId"];
// TEAM-3992 D3.2 — re-arm provenance: rearmOf (the fix this re-verify pins to),
// headSha (the exact commit), role (which gate is re-verifying). Kept so the
// orchestrator can dedup re-arm tickets and the SHA-pinned completion gate can
// attribute a verification record to its fix.
const REARM_KEYS = ["rearmOf", "headSha", "role"];

/**
 * Normalize an agent-supplied `spawned_by` marker. Returns { value } for a clean
 * marker, { error } for a malformed one (unknown kind / not an object), or {}
 * when absent (backward-compatible — no field written). Only the known `kind`
 * and origin-id keys survive; arbitrary extra keys are dropped so agents can't
 * write junk onto the ticket record.
 */
function sanitizeSpawnedBy(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "'spawned_by' must be an object like { kind: 'qa_fix', qaTicketId: 'TEAM-42' }" };
  }
  if (!FIX_KINDS.has(raw.kind)) {
    return { error: `'spawned_by.kind' must be one of: ${[...FIX_KINDS].join(", ")}` };
  }
  const value = { kind: raw.kind };
  for (const k of SPAWN_ORIGIN_KEYS) {
    if (typeof raw[k] === "string" && raw[k]) value[k] = raw[k];
  }
  // TEAM-3991 D2.2 — allowlist extension only: `by` (which agent filed the fix)
  // and `findingId` (which finding it answers) so the parked→fix edge and the
  // metrics bucketing can attribute a fix without parsing its title.
  for (const k of SPAWN_META_KEYS) {
    if (typeof raw[k] === "string" && raw[k]) value[k] = raw[k];
  }
  // TEAM-3992 D3.2 — re-arm provenance (allowlist extension only).
  for (const k of REARM_KEYS) {
    if (typeof raw[k] === "string" && raw[k]) value[k] = raw[k];
  }
  return { value };
}

/**
 * Make the ORIGIN ticket blockedBy the fix ticket that answers it.
 *
 * Best-effort and idempotent: the condition refuses when the edge already exists
 * (a retried create) or when the origin is already closed (nothing to gate), and
 * a ConditionalCheckFailed is a no-op, never an error — a create must not fail
 * because its edge was redundant.
 */
async function linkFixToOrigin(fixTicketId, spawnedBy, nowIso) {
  const originId = spawnedBy
    ? SPAWN_ORIGIN_KEYS.map((k) => spawnedBy[k]).find((v) => typeof v === "string" && v)
    : null;
  if (!originId || originId === fixTicketId) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: originId },
      UpdateExpression:
        "SET blockedBy = list_append(if_not_exists(blockedBy, :empty), :fixList), updatedAt = :now",
      ConditionExpression:
        "(attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :fixId)) AND #s <> :done AND #s <> :cancelled",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":empty": [],
        ":fixList": [fixTicketId],
        ":fixId": fixTicketId,
        ":now": nowIso,
        ":done": "done",
        ":cancelled": "cancelled",
      },
    }));
    console.log(`[tickets] ${originId} now blockedBy ${fixTicketId} (${spawnedBy.kind})`);
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      console.log(`[tickets] ${originId} blockedBy ${fixTicketId} skipped (already linked or origin closed)`);
      return false;
    }
    console.warn(`[tickets] blockedBy edge ${originId} → ${fixTicketId} failed (non-fatal): ${err?.message || err}`);
    return false;
  }
}

/**
 * TEAM-3992 D3.2 — add blockers to an existing ticket (the orchestrator uses this
 * to block the Ship ticket on freshly-created re-arm tickets). Idempotent per id
 * (list_append only when NOT already contains) and refuses on a done/cancelled
 * target — a closed ticket cannot be re-blocked.
 */
async function addBlockers(args) {
  const ticketId = args.ticket_id || args.ticketId;
  const raw = Array.isArray(args.blocked_by) ? args.blocked_by : args.blocked_by ? [args.blocked_by] : [];
  const blockers = [...new Set(raw.filter((b) => typeof b === "string" && b && b !== ticketId))];
  if (!ticketId) return textResult("Error: 'ticket_id' is required");
  if (blockers.length === 0) return textResult("Error: 'blocked_by' must be a non-empty list of ticket ids");

  const now = new Date().toISOString();
  const added = [];
  for (const b of blockers) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ticketId },
        UpdateExpression:
          "SET blockedBy = list_append(if_not_exists(blockedBy, :empty), :one), updatedAt = :now",
        ConditionExpression:
          "(attribute_not_exists(blockedBy) OR NOT contains(blockedBy, :b)) AND #s <> :done AND #s <> :cancelled",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":empty": [],
          ":one": [b],
          ":b": b,
          ":now": now,
          ":done": "done",
          ":cancelled": "cancelled",
        },
      }));
      added.push(b);
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Either already linked (no-op) or the target is closed. Distinguish so a
        // refuse-on-closed is a real error, not a silent no-op.
        const cur = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { ticketId } }));
        const status = cur.Item?.status;
        if (status === "done" || status === "cancelled") {
          return textResult(`Error: ${ticketId} is ${status} — cannot add blockers to a closed ticket`);
        }
        // else already contains this blocker — idempotent skip
        continue;
      }
      throw err;
    }
  }
  return { status: "ok", ticket_id: ticketId, added };
}

async function createTicket(args, { caller } = {}) {
  const { summary, project_key, issue_type, description, assignee, priority, parent_key, blocked_by, workflow_id, spawned_by, phase } = args;
  if (!summary) return textResult("Error: 'summary' is required");

  // TEAM-3619 D4c: optional fix-ticket provenance. Validate before minting so a
  // bad marker is a clear error, not a silently-dropped/garbage field.
  const spawn = sanitizeSpawnedBy(spawned_by);
  if (spawn.error) return textResult(`Error: ${spawn.error}`);
  const phaseStamp = typeof phase === "string" && phase.trim() ? phase.trim() : undefined;

  // TEAM-3686: a fix-kind ticket's `phase` stamp is trusted FIRST by
  // completion.mjs's phaseOf(), and its open-fix gate only blocks completion
  // when the stamp matches a required phase exactly. An unknown phase (e.g.
  // "zz_nonexistent") therefore bypasses the gate entirely — the run can be
  // declared complete while the fix is still open. Reject rather than
  // normalize so the caller learns immediately which phases are legal.
  if (spawn.value && phaseStamp) {
    const validPhases = await loadValidPhases();
    if (!validPhases.has(phaseStamp)) {
      return textResult(
        `Error: 'phase' "${phaseStamp}" is not a known workflow phase — a fix ticket ` +
        `with an unknown phase would be invisible to the completion open-fix gate. ` +
        `Valid phases: ${[...validPhases].sort().join(", ")}`
      );
    }
  }

  // Validate assignee against known agent roster. "human:<who>" assignees are
  // human-review gates — not agents — and are always allowed (the orchestrator
  // parks them for a person instead of invoking an agent).
  const isHumanReviewer = typeof assignee === "string" && assignee.startsWith("human:");
  if (assignee && !isHumanReviewer && !VALID_AGENTS.has(assignee)) {
    return textResult(
      `Error: Invalid assignee "${assignee}". Valid agents are: ${[...VALID_AGENTS].join(", ")}. ` +
      `Note: There is NO "agentcore_hub_ios_dev" agent. iOS/SwiftUI development goes to "agentcore_hub_frontend_dev".`
    );
  }

  // TEAM-4100 F2 (layer 2) — when a validated plan exists for this workflow, the
  // analyst may only create AGENT tickets for assignees the plan authorized.
  // Trusted server-side callers (orchestrator fix/re-verify spawns, console,
  // telegram) bypass — the orchestrator's tickets are created AFTER the plan and
  // are exempt from the topology contract (see enforceRealizedGraphGate). Human
  // gates (human:*) and no-plan runs are not checked. Layer 1 remains the hard
  // gate; this only tightens the create path when a plan is provably present.
  if (!caller && assignee && !isHumanReviewer) {
    const planSet = await planAssigneeSet(workflow_id);
    if (planSet && !planSet.has(assignee)) {
      return textResult(
        `Error: TICKET_NOT_IN_PLAN — assignee "${assignee}" is not in the validated ticket plan ` +
        `for ${workflow_id}. The plan authorizes: ${[...planSet].sort().join(", ")}. ` +
        `Update and resubmit the plan (submit_ticket_plan) before creating tickets for a new assignee.`
      );
    }
  }

  const ticketId = await nextTicketId(project_key);
  const now = new Date().toISOString();
  const type = (issue_type || "Task").toLowerCase();
  const blockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
  const status = blockers.length > 0 ? "blocked" : "todo";

  // DynamoDB GSI keys cannot be null — omit fields entirely if empty
  const item = {
    ticketId,
    type,
    title: summary,
    description: description || "",
    status,
    ...(assignee ? { assignee } : {}),
    ...(parent_key ? { parentId: parent_key } : {}),
    workflowId: workflow_id || null,
    priority: priority || "Medium",
    comments: [],
    artifacts: [],
    blockedBy: blockers,
    createdAt: now,
    updatedAt: now,
    // TEAM-3619 D4c: fix-ticket provenance, persisted in the exact shape the
    // orchestrator's completion re-verify reads (completion.mjs condition iii)
    // and index.mjs handleReviewRejection writes. Omitted entirely when absent,
    // so a plain ticket is byte-for-byte what it was before.
    ...(spawn.value ? { spawnedBy: spawn.value } : {}),
    ...(phaseStamp ? { phase: phaseStamp } : {}),
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  // TEAM-3991 D2.2 — the parked→fix edge. A QA/review/codex fix ticket answers an
  // ORIGIN ticket (the gate or the verification ticket that filed it), and until
  // that origin actually blocks on the fix, the board shows an origin that looks
  // dispatchable while its fix is still open — so the reconcile sweep re-drives
  // the origin and the agent re-investigates a finding it already answered
  // (prod 1pl3h1: TEAM-3727 re-dispatched twice with TEAM-3737 open).
  await linkFixToOrigin(ticketId, spawn.value, now);

  return {
    key: ticketId,
    self: `https://your-domain.atlassian.net/browse/${ticketId}`,
    status: "created",
    ticket: {
      key: ticketId,
      summary,
      description: description || "",
      type: issue_type || "Task",
      status,
      assignee: assignee || "unassigned",
      priority: priority || "Medium",
      parent: parent_key || null,
      blocked_by: blockers,
      created: now,
      ...(spawn.value ? { spawned_by: spawn.value } : {}),
      ...(phaseStamp ? { phase: phaseStamp } : {}),
    },
  };
}

async function getIssue(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );

  if (!result.Item) return textResult(`Issue ${issueKey} not found.`);

  const t = result.Item;
  return {
    key: t.ticketId,
    self: `https://your-domain.atlassian.net/browse/${t.ticketId}`,
    fields: {
      summary: t.title,
      description: t.description || "",
      issuetype: { name: t.type },
      status: { name: t.status },
      assignee: t.assignee ? { displayName: t.assignee } : null,
      priority: { name: t.priority || "Medium" },
      parent: t.parentId ? { key: t.parentId } : null,
      created: t.createdAt,
      updated: t.updatedAt,
      comment: {
        total: (t.comments || []).length,
        comments: (t.comments || []).map((c) => ({
          author: { displayName: c.author },
          body: c.content,
          created: c.timestamp,
        })),
      },
    },
    blockedBy: t.blockedBy || [],
  };
}

async function editIssue(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const updates = [];
  const names = {};
  const values = {};

  if (args.summary !== undefined) {
    updates.push("#t = :t");
    names["#t"] = "title";
    values[":t"] = args.summary;
  }
  if (args.description !== undefined) {
    updates.push("#d = :d");
    names["#d"] = "description";
    values[":d"] = args.description;
  }
  if (args.assignee !== undefined) {
    updates.push("#a = :a");
    names["#a"] = "assignee";
    values[":a"] = args.assignee;
  }
  if (args.priority !== undefined) {
    updates.push("#p = :p");
    names["#p"] = "priority";
    values[":p"] = args.priority;
  }
  if (args.blocked_by !== undefined) {
    const blockers = Array.isArray(args.blocked_by) ? args.blocked_by : args.blocked_by ? [args.blocked_by] : [];
    updates.push("#bb = :bb");
    names["#bb"] = "blockedBy";
    values[":bb"] = blockers;
    // If adding blockers, also set status to blocked
    if (blockers.length > 0) {
      updates.push("#s = :s");
      names["#s"] = "status";
      values[":s"] = "blocked";
    }
  }

  if (updates.length === 0) return textResult("Error: no fields to update");

  updates.push("#u = :u");
  names["#u"] = "updatedAt";
  values[":u"] = new Date().toISOString();

  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: issueKey },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );

  const ticket = result.Attributes;
  return {
    key: issueKey,
    status: "updated",
    fields: {
      summary: ticket.title,
      status: { name: ticket.status },
      assignee: ticket.assignee ? { displayName: ticket.assignee } : null,
      priority: { name: ticket.priority },
      updated: ticket.updatedAt,
    },
  };
}

async function searchIssues(args) {
  // The runtime tool sends `query`; accept `jql` too so both providers match.
  const { query, jql: jqlArg, max_results } = args;
  const jql = query || jqlArg;
  const limit = max_results || 50;

  // Simple JQL parsing — supports common patterns:
  // "project = TEAM", "assignee = agentcore_hub_frontend_dev", "parent = TEAM-42", "status = todo"
  let filterExpression = null;
  let exprNames = {};
  let exprValues = {};

  if (jql) {
    const lower = jql.toLowerCase();

    if (lower.includes("parent =") || lower.includes("parent=")) {
      const parentMatch = jql.match(/parent\s*=\s*["']?([^"'\s,]+)/i);
      if (parentMatch) {
        // Use GSI query for parent
        const result = await ddb.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "parentId-index",
            KeyConditionExpression: "parentId = :pid",
            ExpressionAttributeValues: { ":pid": parentMatch[1] },
            Limit: limit,
          })
        );
        const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
        return formatSearchResults(items);
      }
    }

    if (lower.includes("assignee =") || lower.includes("assignee=")) {
      const assigneeMatch = jql.match(/assignee\s*=\s*["']?([^"'\s,]+)/i);
      if (assigneeMatch) {
        const result = await ddb.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "assignee-index",
            KeyConditionExpression: "assignee = :a",
            ExpressionAttributeValues: { ":a": assigneeMatch[1] },
            Limit: limit,
          })
        );
        const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
        return formatSearchResults(items);
      }
    }

    if (lower.includes("status =") || lower.includes("status=")) {
      const statusMatch = jql.match(/status\s*=\s*["']?([^"'\s,]+)/i);
      if (statusMatch) {
        filterExpression = "#s = :s";
        exprNames["#s"] = "status";
        exprValues[":s"] = statusMatch[1].toLowerCase();
      }
    }
  }

  // Fallback: scan with optional filter
  const scanParams = { TableName: TABLE_NAME, Limit: limit };
  if (filterExpression) {
    scanParams.FilterExpression = filterExpression;
    scanParams.ExpressionAttributeNames = exprNames;
    scanParams.ExpressionAttributeValues = exprValues;
  }

  const result = await ddb.send(new ScanCommand(scanParams));
  const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  return formatSearchResults(items);
}

async function listTickets(args) {
  const { parent_id, assignee, workflow_id, status } = args;

  let items = [];

  if (parent_id) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "parentId-index",
        KeyConditionExpression: "parentId = :pid",
        ExpressionAttributeValues: { ":pid": parent_id },
      })
    );
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  } else if (assignee) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "assignee-index",
        KeyConditionExpression: "assignee = :a",
        ExpressionAttributeValues: { ":a": assignee },
      })
    );
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  } else {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, Limit: 50 }));
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  }

  // Apply optional filters
  if (workflow_id) items = items.filter((i) => i.workflowId === workflow_id);
  if (status) items = items.filter((i) => i.status === status);

  return formatSearchResults(items);
}

async function transitionIssue(args, { caller = null } = {}) {
  const issueKey = args.issue_key || args.ticket_id;
  const transitionId = args.transition_id || args.to_status;
  if (!issueKey) return textResult("Error: 'issue_key' is required");
  if (!transitionId) return textResult("Error: 'transition_id' is required");

  // Get current ticket to determine valid transitions
  const current = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );
  if (!current.Item) return textResult(`Issue ${issueKey} not found.`);

  const currentStatus = current.Item.status || "todo";
  const available = TRANSITIONS[currentStatus] || [];

  // Find the transition by ID or by target status name
  const transition = available.find(
    (t) => t.id === transitionId || t.to === transitionId || t.name.toLowerCase() === transitionId.toLowerCase()
  );

  if (!transition) {
    return textResult(
      `Invalid transition "${transitionId}" from status "${currentStatus}". ` +
      `Available: ${available.map((t) => `${t.id} (→ ${t.to})`).join(", ")}`
    );
  }

  // "in_review" is a human-review-gate state. Only tickets assigned to a human
  // reviewer (assignee "human:*") may enter it — an agent ticket parked there
  // would never be invoked and would stall forever.
  const isHumanGate = String(current.Item.assignee || "").startsWith("human:");
  if (transition.to === "in_review" && !isHumanGate) {
    return textResult(
      `Cannot move ${issueKey} to in_review: only human-review tickets (assignee "human:*") can be sent to review.`
    );
  }

  // TEAM-4099 F3 — the other direction, and the one that actually matters: moving a
  // human gate OUT of in_review (approve/request-changes) or to a terminal done
  // (including `skip`) IS the gate decision. Only a trusted server-side caller may
  // record one, so the decision also lands in the gate ledger; an agent doing it
  // from the tool path is forging its reviewer's signature.
  if (isHumanGate && !caller && (currentStatus === "in_review" || transition.to === "done")) {
    return textResult(
      `Cannot transition ${issueKey}: it is assigned to ${current.Item.assignee}, a human-review gate, ` +
      `and "${transition.id}" (→ ${transition.to}) is that reviewer's decision to make. Gate decisions are ` +
      `only accepted from the console or Telegram, where they are recorded in the gate ledger. ` +
      `Report your work and leave the gate alone — moving it yourself does not approve anything.`
    );
  }

  // Build update expression — include skipReason if "skip" transition with a reason
  const now = new Date().toISOString();
  const reason = args.reason || args.skip_reason;
  let updateExpr = "SET #s = :s, #u = :u";
  let exprNames = { "#s": "status", "#u": "updatedAt" };
  let exprValues = { ":s": transition.to, ":u": now };

  if (transition.id === "skip" && reason) {
    updateExpr += ", #sr = :sr";
    exprNames["#sr"] = "skipReason";
    exprValues[":sr"] = reason;
  }

  // Persist the reason as reviewComment when leaving a review gate, so the
  // orchestrator can feed "request changes" feedback back to the reworked agent.
  if (currentStatus === "in_review" && reason) {
    updateExpr += ", #rvc = :rvc";
    exprNames["#rvc"] = "reviewComment";
    exprValues[":rvc"] = reason;
  }

  // Support setting blockedBy (e.g., QA blocks itself on a fix ticket)
  const blockers = args.blocked_by;
  if (blockers) {
    const blockerList = Array.isArray(blockers) ? blockers : [blockers];
    updateExpr += ", #bb = :bb";
    exprNames["#bb"] = "blockedBy";
    exprValues[":bb"] = blockerList;
  }

  // TEAM-3992 D4.2 — a "block" transition may carry a machine-readable
  // `block_reason` (e.g. "runtime" when the coding-agent runtime is unreachable),
  // persisted as `blockReason` so the board can label WHY a ticket is blocked
  // ("Blocked: runtime outage") and the recovery sweep can find its own parks.
  if (transition.to === "blocked" && args.block_reason) {
    updateExpr += ", #brs = :brs";
    exprNames["#brs"] = "blockReason";
    exprValues[":brs"] = String(args.block_reason).slice(0, 200);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: issueKey },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );

  return {
    key: issueKey,
    status: "transitioned",
    from: currentStatus,
    to: transition.to,
    transition: transition.name,
    ...(reason ? { skipReason: reason } : {}),
  };
}

async function getTransitions(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );
  if (!result.Item) return textResult(`Issue ${issueKey} not found.`);

  const currentStatus = result.Item.status || "todo";
  const available = TRANSITIONS[currentStatus] || [];

  return {
    key: issueKey,
    currentStatus,
    transitions: available.map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to,
    })),
  };
}

async function addComment(args) {
  const issueKey = args.issue_key || args.ticket_id;
  const body = args.body || args.content;
  if (!issueKey) return textResult("Error: 'issue_key' is required");
  if (!body) return textResult("Error: 'body' is required");

  const comment = {
    id: `comment-${Date.now()}`,
    author: args.author || "agent",
    content: body,
    timestamp: new Date().toISOString(),
  };

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: issueKey },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :comment), #u = :now",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":comment": [comment],
        ":empty": [],
        ":now": new Date().toISOString(),
      },
    })
  );

  return {
    key: issueKey,
    status: "comment_added",
    comment: {
      id: comment.id,
      author: comment.author,
      body: comment.content,
      created: comment.timestamp,
    },
  };
}

async function listProjects() {
  return {
    projects: [
      {
        key: PROJECT_KEY,
        name: "AgentCore Hub Team",
        description: "Agentic development pipeline project",
        issueTypes: ["Epic", "Story", "Task", "Bug"],
      },
    ],
  };
}

async function getProjectIssueTypes(args) {
  return {
    project_key: args.project_key || PROJECT_KEY,
    issueTypes: [
      { id: "epic", name: "Epic", description: "Feature container" },
      { id: "story", name: "Story", description: "User story" },
      { id: "task", name: "Task", description: "Development task" },
      { id: "bug", name: "Bug", description: "Defect" },
    ],
  };
}

async function lookupUser(args) {
  const query = (args.query || "").toLowerCase();

  // Return matching agents from roster
  const agents = [
    { id: "agentcore_hub_requirements_analyst", name: "Requirements Analyst", role: "requirements" },
    { id: "agentcore_hub_ios_designer", name: "iOS Designer", role: "design" },
    { id: "agentcore_hub_backend_designer", name: "Backend Designer", role: "design" },
    { id: "agentcore_hub_android_designer", name: "Android Designer", role: "design" },
    { id: "agentcore_hub_security_reviewer", name: "Security Reviewer", role: "design" },
    { id: "agentcore_hub_legal_compliance", name: "Legal & Compliance", role: "design" },
    { id: "agentcore_hub_localization", name: "Localization", role: "design" },
    { id: "agentcore_hub_analytics_designer", name: "Analytics Designer", role: "design" },
    { id: "agentcore_hub_backend_dev", name: "Backend Developer", role: "development" },
    { id: "agentcore_hub_api_dev", name: "API Developer", role: "development" },
    { id: "agentcore_hub_frontend_dev", name: "Frontend Developer", role: "development" },
    { id: "agentcore_hub_code_reviewer", name: "Code Reviewer", role: "review" },
    { id: "agentcore_hub_qa_verifier", name: "QA Verifier", role: "verification" },
    { id: "agentcore_hub_ci_agent", name: "CI Agent", role: "review" },
    { id: "agentcore_hub_release_manager", name: "Release Manager", role: "ship" },
  ];

  const matches = agents.filter(
    (a) => a.id.includes(query) || a.name.toLowerCase().includes(query) || a.role.includes(query)
  );

  return {
    users: matches.map((a) => ({
      accountId: a.id,
      displayName: a.name,
      emailAddress: `${a.id}@agentcore-hub.example.com`,
      active: true,
    })),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function nextTicketId(projectKey) {
  const prefix = projectKey || PROJECT_KEY;
  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: COUNTER_KEY,
      UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
      ExpressionAttributeNames: { "#n": "nextNum" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return `${prefix}-${result.Attributes.nextNum}`;
}

function formatSearchResults(items) {
  return {
    total: items.length,
    issues: items.map((t) => ({
      key: t.ticketId,
      self: `https://your-domain.atlassian.net/browse/${t.ticketId}`,
      fields: {
        summary: t.title,
        status: { name: t.status },
        assignee: t.assignee ? { displayName: t.assignee } : null,
        issuetype: { name: t.type },
        priority: { name: t.priority || "Medium" },
        parent: t.parentId ? { key: t.parentId } : null,
        created: t.createdAt,
      },
    })),
  };
}

function detectTool(event) {
  const key = event.issue_key || event.ticket_id;
  if (key && event.body) return "add_comment";
  if (key && (event.transition_id || event.to_status)) return "transition_issue";
  if (key && (event.summary || event.description || event.assignee)) return "edit_issue";
  if (key && !event.parent_id) return "get_issue";
  if (event.jql) return "search_issues";
  if (event.parent_id || (event.assignee && !key && !event.summary)) return "list_tickets";
  if (event.summary) return "create_ticket";
  if (event.query) return "lookup_user";
  if (event.project_key && !event.summary) return "get_project_issue_types";
  return "list_projects";
}

function textResult(text) {
  return { content: [{ text }] };
}
