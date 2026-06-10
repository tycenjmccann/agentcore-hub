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

// ─── Jira Config ─────────────────────────────────────────────────────────────

const SITE = process.env.JIRA_SITE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";

const BASE_URL = `https://${SITE}`;
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

// ─── S3 Config (for agent roster) ────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const s3 = new S3Client({ region: REGION });

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
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
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
    const msg = body?.errorMessages?.join("; ") || body?.errors
      ? JSON.stringify(body.errors)
      : typeof body === "string" ? body : JSON.stringify(body);
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

// ─── Tool Implementations ────────────────────────────────────────────────────

async function createTicket(params) {
  const { summary, description, parent_key, assignee, issue_type, blocked_by, workflow_id } = params;

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

  // Assignee is carried as a label (Jira's assignee field needs an accountId).
  // Human-review gates use a "reviewer:<who>" label + a "human-review" marker so
  // the orchestrator recognizes them and parks instead of invoking an agent.
  const labels = [];
  if (isHumanReviewer) {
    labels.push("human-review");
    labels.push(`reviewer:${assignee.slice("human:".length)}`);
  } else if (assignee) {
    labels.push(`agent:${assignee}`);
  }
  if (workflow_id) labels.push(`wf:${workflow_id}`);

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
  const canonicalType = ISSUE_TYPE_ALIASES[requestedType.toLowerCase()] || requestedType;

  const fields = {
    project: { key: PROJECT_KEY },
    summary,
    issuetype: { name: canonicalType },
    labels,
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

  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }

  if (parent_key) {
    fields.parent = { key: parent_key };
  }

  // 1. Create in Jira
  const created = await jiraFetch("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });

  const ticketId = created.key;

  // 2. Create blocking links in Jira
  const blockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
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

  // 3. Transition in Jira to the correct initial status.
  //    - If blockers exist: transition to "Blocked" (prevents premature "Ready" webhooks)
  //    - If no blockers + has assignee: transition to "Ready" (tells orchestrator to invoke)
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

  console.log(`[jira-tools] Created ${ticketId} in Jira. Status: ${status}`);
  return { ticketId, status, message: `Created ${ticketId}: ${summary}` };
}

async function transitionTicket(params) {
  const { ticket_id, transition_id, reason } = params;

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

  // Add the reason as a comment BEFORE the transition. The transition fires the
  // status webhook → orchestrator rejection handler reads the latest comment;
  // commenting first avoids a race where rework starts before the feedback lands.
  if (reason) {
    await addComment({ ticket_id, comment: isSkip ? `Skipped: ${reason}` : reason });
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

  await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  const finalStatus = isSkip ? "done" : mapStatusToInternal(match.to.name);
  console.log(`[jira-tools] Transitioned ${ticket_id} to ${finalStatus} in Jira`);
  return { ticketId: ticket_id, status: finalStatus, message: `Transitioned to ${finalStatus}` };
}

async function updateTicket(params) {
  const { ticket_id, description, title } = params;

  const fields = {};
  if (title) fields.summary = title;
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

async function listTickets(params) {
  const { parent_id } = params;
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
  const { query, max_results } = params;
  const data = await jiraSearch(query, ["summary", "status", "labels", "assignee", "issuetype", "parent"], max_results || 50);
  const tickets = (data.issues || []).map(mapIssue);
  return { tickets };
}

async function getIssue(params) {
  const { issue_key } = params;
  const issue = await jiraFetch(`/rest/api/3/issue/${issue_key}`);
  return mapIssue(issue);
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
  const jql = `project = ${PROJECT_KEY} AND labels in ("agent:${query}") ORDER BY created DESC`;

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

  return {
    ticketId: issue.key,
    title: fields.summary || "",
    status: mapStatusToInternal(fields.status?.name || "To Do"),
    assignee,
    issueType: fields.issuetype?.name || "Task",
    parentKey: fields.parent?.key || null,
    workflowId: wfLabel ? wfLabel.replace("wf:", "") : null,
    labels,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const TOOLS = {
  Tickets___create_ticket: createTicket,
  Tickets___transition_ticket: transitionTicket,
  Tickets___update_ticket: updateTicket,
  Tickets___list_tickets: listTickets,
  Tickets___add_comment: addComment,
  Tickets___search_issues: searchIssues,
  Tickets___get_issue: getIssue,
  Tickets___get_transitions: getTransitions,
  Tickets___list_projects: listProjects,
  Tickets___get_project_issue_types: getProjectIssueTypes,
  Tickets___lookup_user: lookupUser,
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
    return { error: err.message };
  }
};
