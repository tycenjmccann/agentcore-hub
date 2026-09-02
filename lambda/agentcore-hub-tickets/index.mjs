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
        return await createTicket(args);
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
        return await transitionIssue(args);
      case "get_transitions":
        return await getTransitions(args);
      case "add_comment":
        return await addComment(args);
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
        const message = `Unknown tool: "${toolName}". Available: create_ticket, get_issue, edit_issue, search_issues, list_tickets, transition_issue (alias: transition_ticket), get_transitions, add_comment, list_projects, get_project_issue_types, lookup_user`;
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
  return { value };
}

async function createTicket(args) {
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

async function transitionIssue(args) {
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
  if (transition.to === "in_review" && !String(current.Item.assignee || "").startsWith("human:")) {
    return textResult(
      `Cannot move ${issueKey} to in_review: only human-review tickets (assignee "human:*") can be sent to review.`
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
