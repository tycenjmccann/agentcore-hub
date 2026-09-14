/**
 * Jira Cloud read helpers for the event-driven workflow UI.
 * Used when TICKET_PROVIDER=jira to fetch tickets directly from Jira
 * instead of DynamoDB. Uses plain fetch() — no AWS SDK needed.
 */

import { blockersFromLinks, type JiraIssueLink } from "./jira-client";

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
  const labels = (fields?.labels as string[]) || [];

  // Extract blockedBy from issue links (shared with the nudge route)
  const blockedBy = blockersFromLinks(fields?.issuelinks as JiraIssueLink[] | undefined);

  // Extract assignee from labels. Agent tickets use "agent:<id>"; human-review
  // gates use "reviewer:<who>" → surface as "human:<who>" so the UI shows the
  // Approve / Request-changes actions and gates the in_review transition.
  const agentLabel = labels.find((l) => l.startsWith("agent:"));
  const reviewerLabel = labels.find((l) => l.startsWith("reviewer:"));
  const assignee = agentLabel
    ? agentLabel.replace("agent:", "")
    : reviewerLabel
    ? `human:${reviewerLabel.replace("reviewer:", "")}`
    : undefined;

  // Extract workflowId from labels
  const wfLabel = labels.find((l) => l.startsWith("wf:"));
  const workflowId = wfLabel ? wfLabel.replace("wf:", "") : undefined;

  // Jira has no columns: the ticket Lambda stamps `phase:<p>`, `fix:<kind>` and
  // `origin:<ticket>` as labels (same carriers the orchestrator's
  // mapJiraIssueToTicket reads). Surface them so the UI can tell a planned
  // ticket from a fix filed mid-run and place it under the ticket it unblocks.
  const { phase, spawnedBy, userLabels } = ticketMetaFromLabels(labels);

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
    ...(phase ? { phase } : {}),
    ...(spawnedBy ? { spawnedBy } : {}),
    ...(userLabels.length ? { labels: userLabels } : {}),
  };
}

// Mirror of lambda/orchestrator/fix-contract.mjs KIND_TO_ORIGIN_KEY — which
// spawnedBy field the `origin:` label fills for each fix kind.
const KIND_TO_ORIGIN_KEY: Record<string, string> = {
  review_fix: "gateTicketId",
  qa_fix: "qaTicketId",
  codex_fix: "codexTicketId",
  ship_fix: "shipTicketId",
  ci_fix: "ciTicketId",
  sync_fix: "ciTicketId",
};

const SYSTEM_LABEL_PREFIXES = ["wf:", "agent:", "reviewer:", "fix:", "origin:", "evidence:", "phase:", "reverify:", "contract:"];

/**
 * Rebuild the structured ticket fields the Jira provider carries as labels.
 * Exported for tests.
 */
export function ticketMetaFromLabels(labels: string[]): {
  phase?: string;
  spawnedBy?: { kind: string; [key: string]: string | boolean };
  userLabels: string[];
} {
  const phaseLabel = labels.find((l) => l.startsWith("phase:"));
  const fixLabel = labels.find((l) => l.startsWith("fix:"));
  const originLabel = labels.find((l) => l.startsWith("origin:"));
  const reverifyLabel = labels.find((l) => l.startsWith("reverify:"));
  const kind = fixLabel ? fixLabel.slice("fix:".length) : "";
  let spawnedBy: { kind: string; [key: string]: string | boolean } | undefined;
  if (kind && KIND_TO_ORIGIN_KEY[kind]) {
    spawnedBy = { kind };
    if (originLabel) spawnedBy[KIND_TO_ORIGIN_KEY[kind]] = originLabel.slice("origin:".length);
    if (reverifyLabel) {
      spawnedBy.reverify = true;
      spawnedBy.rearmOf = reverifyLabel.slice("reverify:".length);
    }
  }
  const userLabels = labels.filter(
    (l) => l !== "human-review" && !SYSTEM_LABEL_PREFIXES.some((p) => l.startsWith(p))
  );
  return { ...(phaseLabel ? { phase: phaseLabel.slice("phase:".length) } : {}), ...(spawnedBy ? { spawnedBy } : {}), userLabels };
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
