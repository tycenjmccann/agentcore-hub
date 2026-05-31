/**
 * Jira Cloud read helpers for the event-driven workflow UI.
 * Used when TICKET_PROVIDER=jira to fetch tickets directly from Jira
 * instead of DynamoDB. Uses plain fetch() — no AWS SDK needed.
 */

const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";

function getAuthHeader(): string {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;
}

function getBaseUrl(): string {
  return `https://${JIRA_SITE_URL}`;
}

// ─── Status Mapping ─────────────────────────────────────────────────────────

const JIRA_TO_INTERNAL_STATUS: Record<string, string> = {
  "To Do": "todo",
  "Ready": "ready",
  "In Progress": "in_progress",
  "In Review": "in_review",
  "Blocked": "blocked",
  "Done": "done",
  "Backlog": "backlog",
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get all tickets for a workflow from Jira.
 * Workflow children are labeled `wf:<workflowId>`; the epic itself is only
 * labeled `agentcore-hub-workflow`, so we fetch it separately by its parent key
 * (which every child references via `parent.key`).
 */
export async function getTicketsForWorkflowFromJira(workflowId: string) {
  const jql = `project = ${JIRA_PROJECT_KEY} AND labels = "wf:${workflowId}" ORDER BY created ASC`;
  const params = new URLSearchParams({
    jql,
    fields: "summary,status,issuetype,parent,labels,issuelinks,assignee,created,updated,description",
    maxResults: "100",
  });

  const response = await fetch(`${getBaseUrl()}/rest/api/3/search/jql?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Jira search failed: ${response.status} ${response.statusText}: ${errorText}`);
  }

  const data = await response.json();
  const issues = (data.issues || []) as Array<Record<string, unknown>>;
  const tickets = issues.map(mapIssueToTicket);

  // Fetch the epic — children point at it via parent.key; pull the unique parent
  // key (epic) and resolve it directly.
  const epicKeys = new Set<string>();
  for (const t of tickets) {
    if (t.parentId) epicKeys.add(t.parentId);
  }
  const epicTickets = await Promise.all(
    [...epicKeys].map(async (key) => {
      try {
        return await getIssueByKey(key);
      } catch {
        return null;
      }
    })
  );
  for (const epic of epicTickets) {
    if (epic && !tickets.some((t) => t.ticketId === epic.ticketId)) {
      tickets.push(epic);
    }
  }

  return tickets;
}

async function getIssueByKey(key: string) {
  const fields = "summary,status,issuetype,parent,labels,issuelinks,assignee,created,updated,description";
  const response = await fetch(`${getBaseUrl()}/rest/api/3/issue/${key}?fields=${fields}`, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Jira get issue ${key} failed: ${response.status}`);
  }
  return mapIssueToTicket(await response.json());
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapIssueToTicket(issue: Record<string, unknown>) {
  const fields = issue.fields as Record<string, unknown>;
  const status = fields?.status as Record<string, unknown> | undefined;
  const statusName = (status?.name as string) || "To Do";
  const issuetype = fields?.issuetype as Record<string, unknown> | undefined;
  const parent = fields?.parent as Record<string, unknown> | undefined;
  const issueLinks = (fields?.issuelinks as Array<Record<string, unknown>>) || [];
  const labels = (fields?.labels as string[]) || [];

  // Extract blockedBy from issue links
  const blockedBy: string[] = [];
  for (const link of issueLinks) {
    const linkType = link.type as Record<string, unknown> | undefined;
    if (linkType?.name === "Blocks" && link.inwardIssue) {
      const inward = link.inwardIssue as Record<string, unknown>;
      blockedBy.push(inward.key as string);
    }
  }

  // Extract assignee from labels (agent:<name>)
  const agentLabel = labels.find((l) => l.startsWith("agent:"));
  const assignee = agentLabel ? agentLabel.replace("agent:", "") : undefined;

  // Extract workflowId from labels
  const wfLabel = labels.find((l) => l.startsWith("wf:"));
  const workflowId = wfLabel ? wfLabel.replace("wf:", "") : undefined;

  const issueTypeName = (issuetype?.name as string)?.toLowerCase() || "task";

  return {
    ticketId: issue.key as string,
    title: (fields?.summary as string) || "",
    description: adfToPlainText(fields?.description),
    status: JIRA_TO_INTERNAL_STATUS[statusName] || "todo",
    assignee,
    parentId: parent?.key as string | undefined,
    blockedBy: blockedBy.length > 0 ? blockedBy.join(",") : "",
    workflowId,
    type: issueTypeName,
    createdAt: (fields?.created as string) || new Date().toISOString(),
    updatedAt: (fields?.updated as string) || new Date().toISOString(),
  };
}

/**
 * Flatten Atlassian Document Format (ADF) JSON into plain text.
 * Walks the content tree and concatenates text nodes, inserting newlines
 * between paragraph-like blocks.
 */
function adfToPlainText(adf: unknown): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (typeof adf !== "object") return "";

  const blockTypes = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "blockquote"]);
  const lines: string[] = [];

  const walk = (node: Record<string, unknown>, currentLine: string[]): void => {
    if (node.type === "text" && typeof node.text === "string") {
      currentLine.push(node.text);
      return;
    }
    const children = Array.isArray(node.content) ? (node.content as Array<Record<string, unknown>>) : [];
    if (blockTypes.has(node.type as string)) {
      const buf: string[] = [];
      for (const child of children) walk(child, buf);
      lines.push(buf.join(""));
    } else {
      for (const child of children) walk(child, currentLine);
    }
  };

  walk(adf as Record<string, unknown>, []);
  return lines.join("\n").trim();
}
