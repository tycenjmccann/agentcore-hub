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
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
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
    { id: "block", name: "Block", to: "blocked" },
  ],
  blocked: [
    { id: "unblock", name: "Unblock", to: "todo" },
    { id: "ready", name: "Mark Ready", to: "ready" },
    { id: "start", name: "Start Progress", to: "in_progress" },
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
      default:
        return textResult(
          `Unknown tool: "${toolName}". Available: create_ticket, get_issue, edit_issue, search_issues, list_tickets, transition_issue, get_transitions, add_comment, list_projects, get_project_issue_types, lookup_user`
        );
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    return textResult(`Error: ${err.message}`);
  }
};

// ─── Tool Implementations ──────────────────────────────────────────────────

async function createTicket(args) {
  const { summary, project_key, issue_type, description, assignee, priority, parent_key, blocked_by, workflow_id } = args;
  if (!summary) return textResult("Error: 'summary' is required");

  // Validate assignee against known agent roster
  if (assignee && !VALID_AGENTS.has(assignee)) {
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
  const { jql, max_results } = args;
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
    { id: "agentcore_hub_qa_verifier", name: "QA Verifier", role: "verification" },
    { id: "agentcore_hub_ci_agent", name: "CI Agent", role: "review" },
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
