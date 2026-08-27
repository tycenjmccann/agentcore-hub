/**
 * Jira Cloud API Client
 *
 * Reusable client for interacting with Jira Cloud REST API v3.
 * Shared between the Jira webhook route and ticket-provider-jira.ts.
 */

// ─── Status Mapping ────────────────────────────────────────────────────────────

/** Maps Jira status display names (case-insensitive) to internal status values */
export const JIRA_STATUS_TO_INTERNAL: Record<string, string> = {
  "to do": "todo",
  "todo": "todo",
  "ready": "ready",
  "open": "todo",
  "in progress": "in_progress",
  "in review": "in_review",
  "done": "done",
  "closed": "done",
  "resolved": "done",
  "blocked": "blocked",
};

/** Maps internal status values to Jira transition names */
export const INTERNAL_STATUS_TO_JIRA: Record<string, string> = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
};

/**
 * Normalize a Jira status name to an internal status string.
 * Falls back to the lowercased input if no mapping found.
 */
export function mapJiraStatusToInternal(jiraStatus: string): string {
  const normalized = jiraStatus.toLowerCase().trim();
  return JIRA_STATUS_TO_INTERNAL[normalized] || normalized;
}

/**
 * Extract the "blocked by" issue keys from an issue's links. A "Blocks" link's
 * inwardIssue is the blocker. Shared by the ticket reader and the nudge route so
 * both compute blockers identically.
 */
export function blockersFromLinks(links: JiraIssueLink[] | undefined): string[] {
  const out: string[] = [];
  for (const link of links || []) {
    if (link.type?.name === "Blocks" && link.inwardIssue) {
      out.push(link.inwardIssue.key);
    }
  }
  return out;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface JiraClientConfig {
  siteUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string;
    status: { name: string; id: string };
    parent?: { key: string; id: string };
    labels: string[];
    issuelinks: JiraIssueLink[];
    issuetype: { name: string };
    [key: string]: unknown;
  };
}

export interface JiraIssueLink {
  id: string;
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: { key: string; fields: { status: { name: string } } };
  outwardIssue?: { key: string; fields: { status: { name: string } } };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; id: string };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

// ─── Client ────────────────────────────────────────────────────────────────────

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(config: JiraClientConfig) {
    // Normalize site URL: ensure https:// prefix, remove trailing slash
    const url = config.siteUrl.replace(/\/$/, "");
    this.baseUrl = url.startsWith("http") ? url : `https://${url}`;
    // Basic auth: email:api_token base64-encoded
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  /**
   * Create a JiraClient from environment variables.
   * Throws if required env vars are missing.
   */
  static fromEnv(): JiraClient {
    const siteUrl = process.env.JIRA_SITE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;

    if (!siteUrl || !email || !apiToken) {
      throw new Error(
        "Missing Jira configuration. Set JIRA_SITE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables."
      );
    }

    return new JiraClient({ siteUrl, email, apiToken });
  }

  // ─── Core HTTP ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Jira API error: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // ─── Issue Operations ──────────────────────────────────────────────────────

  /**
   * Get a single issue by key (e.g., "TEAM-123")
   */
  async getIssue(issueKey: string, fields?: string[]): Promise<JiraIssue> {
    const params = fields ? `?fields=${fields.join(",")}` : "";
    return this.request<JiraIssue>("GET", `/issue/${issueKey}${params}`);
  }

  /**
   * Get all links for an issue (inward and outward).
   * Returns the issuelinks field from the issue.
   */
  async getIssueLinks(issueKey: string): Promise<JiraIssueLink[]> {
    const issue = await this.getIssue(issueKey, [
      "issuelinks",
      "status",
      "summary",
    ]);
    return issue.fields.issuelinks || [];
  }

  /**
   * Search issues using JQL.
   * Uses the new /search/jql endpoint (the old /search POST was deprecated).
   */
  async searchIssues(
    jql: string,
    fields?: string[],
    maxResults = 50
  ): Promise<JiraSearchResult> {
    const fieldList = fields || [
      "summary",
      "status",
      "labels",
      "parent",
      "issuelinks",
      "issuetype",
    ];
    const params = new URLSearchParams({
      jql,
      fields: fieldList.join(","),
      maxResults: String(maxResults),
    });
    return this.request<JiraSearchResult>("GET", `/search/jql?${params.toString()}`);
  }

  /**
   * Get all child issues (subtasks) of an epic or parent issue.
   */
  async getChildIssues(parentKey: string): Promise<JiraIssue[]> {
    const result = await this.searchIssues(
      `parent = "${parentKey}" ORDER BY created ASC`,
      ["summary", "status", "labels", "issuelinks", "issuetype"],
      100
    );
    return result.issues;
  }

  // ─── Transitions ───────────────────────────────────────────────────────────

  /**
   * Get available transitions for an issue.
   */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      "GET",
      `/issue/${issueKey}/transitions`
    );
    return result.transitions;
  }

  /**
   * Transition an issue to a new status.
   * Finds the matching transition by target status name.
   */
  async transitionIssue(issueKey: string, targetStatus: string): Promise<void> {
    const transitions = await this.getTransitions(issueKey);
    const transition = transitions.find(
      (t) => t.to.name.toLowerCase() === targetStatus.toLowerCase() ||
        t.name.toLowerCase() === targetStatus.toLowerCase()
    );

    if (!transition) {
      const available = transitions.map((t) => `${t.name} → ${t.to.name}`).join(", ");
      throw new Error(
        `No transition to "${targetStatus}" for ${issueKey}. Available: [${available}]`
      );
    }

    await this.request("POST", `/issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });
  }

  /**
   * Transition an issue using internal status name.
   * Maps internal status → Jira status name, then transitions.
   */
  async transitionToInternalStatus(
    issueKey: string,
    internalStatus: string
  ): Promise<void> {
    const jiraStatus = INTERNAL_STATUS_TO_JIRA[internalStatus];
    if (!jiraStatus) {
      throw new Error(`Unknown internal status: ${internalStatus}`);
    }
    await this.transitionIssue(issueKey, jiraStatus);
  }

  /**
   * Create an issue from raw Jira fields (project, issuetype, summary, labels,
   * ADF description, ...). Returns { key }. Used for top-level issues that the
   * typed provider methods don't cover (e.g. programmatic Bug filing).
   */
  async createIssue(fields: Record<string, unknown>): Promise<{ key: string }> {
    return this.request<{ key: string }>("POST", "/issue", { fields });
  }

  /**
   * Add a comment to an issue. Wraps the text in ADF (Atlassian Document
   * Format) and prefixes the author, matching JiraCloudProvider.addComment.
   */
  async addComment(issueKey: string, author: string, content: string): Promise<void> {
    await this.request("POST", `/issue/${issueKey}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `[${author}]: ${content}` }],
          },
        ],
      },
    });
  }

  // ─── Label Helpers ─────────────────────────────────────────────────────────

  /**
   * Extract agent ID from issue labels.
   * Looks for labels in format "agent:<agent-id>"
   */
  static extractAgentFromLabels(labels: string[]): string | null {
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    return agentLabel ? agentLabel.replace("agent:", "") : null;
  }

  /**
   * Extract workflow ID from issue labels.
   * Looks for labels in format "wf:<workflow-id>"
   */
  static extractWorkflowFromLabels(labels: string[]): string | null {
    const wfLabel = labels.find((l) => l.startsWith("wf:"));
    return wfLabel ? wfLabel.replace("wf:", "") : null;
  }
}
