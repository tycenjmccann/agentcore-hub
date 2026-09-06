/**
 * Jira Cloud Ticket Provider
 *
 * Full implementation that calls Jira Cloud REST API v3.
 * Set TICKET_PROVIDER=jira and configure JIRA_* env vars to use.
 *
 * Required environment variables:
 *   JIRA_SITE_URL   — e.g., "your-domain.atlassian.net"
 *   JIRA_EMAIL      — admin email for Basic auth
 *   JIRA_API_TOKEN  — API token from id.atlassian.com
 *   JIRA_PROJECT_KEY — e.g., "TEAM"
 */

import type { TicketProvider, CreateEpicInput, CreateTicketInput } from "./ticket-provider";
import type { JiraTicket, JiraComment, Artifact, TicketStatus } from "./types";

// ─── Status Mapping ─────────────────────────────────────────────────────────

const JIRA_TO_INTERNAL_STATUS: Record<string, TicketStatus> = {
  "To Do": "todo",
  "Ready": "ready",
  "In Progress": "in_progress",
  "In Review": "in_review",
  "Blocked": "blocked",
  "Done": "done",
  "Backlog": "backlog",
};

const INTERNAL_TO_JIRA_STATUS: Record<string, string> = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  backlog: "Backlog",
};

// ─── Provider Implementation ────────────────────────────────────────────────

export class JiraCloudProvider implements TicketProvider {
  private baseUrl: string;
  private authHeader: string;
  private projectKey: string;

  constructor() {
    const siteUrl = process.env.JIRA_SITE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;
    const projectKey = process.env.JIRA_PROJECT_KEY;

    if (!siteUrl || !email || !apiToken || !projectKey) {
      throw new Error(
        "Jira Cloud provider requires JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT_KEY environment variables."
      );
    }

    this.baseUrl = `https://${siteUrl}`;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    this.projectKey = projectKey;
  }

  // ─── Public Methods ─────────────────────────────────────────────────────

  async createEpic(input: CreateEpicInput): Promise<JiraTicket> {
    const body = {
      fields: {
        project: { key: this.projectKey },
        summary: input.title,
        description: this.toADF(input.description),
        issuetype: { name: "Epic" },
        labels: ["agentcore-hub-workflow"],
      },
    };

    const data = await this.request("POST", "/rest/api/3/issue", body);
    const issue = await this.getIssue(data.key as string);
    return this.mapIssueToTicket(issue);
  }

  async createTicket(input: CreateTicketInput, workflowId?: string): Promise<JiraTicket> {
    const body: Record<string, unknown> = {
      fields: {
        project: { key: this.projectKey },
        summary: input.title,
        description: this.toADF(input.description),
        issuetype: { name: "Task" },
        parent: { key: input.parentId },
        labels: [
          "agentcore-hub-workflow",
          ...(workflowId ? [`wf:${workflowId}`] : []),
          ...(input.extraLabels || []),
        ],
      },
    };

    if (input.assignee) {
      // Jira expects accountId; assignees are carried as labels instead.
      // "human:<who>" = a human approval gate — stamp the same human-review +
      // reviewer:<who> labels the agentcore-hub-jira Lambda uses, so every
      // gate is discoverable by the dashboard's dwell mining regardless of
      // which path created it. Anything else is an agent assignee.
      const gateLabels = input.assignee.startsWith("human:")
        ? ["human-review", `reviewer:${input.assignee.slice("human:".length)}`]
        : [`agent:${input.assignee}`];
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        labels: [
          ...((body.fields as Record<string, unknown>).labels as string[]),
          ...gateLabels,
        ],
      };
    }

    const data = await this.request("POST", "/rest/api/3/issue", body);
    const issueKey = data.key as string;

    // Create "Blocks" issue links for dependencies
    // Jira "Blocks" link: inwardIssue "blocks" outwardIssue
    // So blockerId blocks issueKey → inward=blocker, outward=new ticket
    if (input.blockedBy && input.blockedBy.length > 0) {
      for (const blockerId of input.blockedBy) {
        await this.request("POST", "/rest/api/3/issueLink", {
          type: { name: "Blocks" },
          inwardIssue: { key: blockerId },
          outwardIssue: { key: issueKey },
        });
      }
    }

    const issue = await this.getIssue(issueKey);
    return this.mapIssueToTicket(issue);
  }

  async markDone(ticketId: string, _workflowId: string): Promise<string[]> {
    await this.transitionTo(ticketId, "Done");

    // Find tickets that this ticket blocks and check if they're now unblocked
    const unblockedIds: string[] = [];
    const issue = await this.getIssue(ticketId);
    const fields = issue.fields as Record<string, unknown> | undefined;
    const issueLinks = (fields?.issuelinks as Array<Record<string, unknown>>) || [];

    for (const link of issueLinks) {
      const linkType = link.type as Record<string, unknown> | undefined;
      // "outwardIssue" when this ticket "blocks" another
      if (linkType?.name === "Blocks" && link.outwardIssue) {
        const outward = link.outwardIssue as Record<string, unknown>;
        const blockedKey = outward.key as string;
        const allBlockersResolved = await this.areAllBlockersDone(blockedKey);
        if (allBlockersResolved) {
          await this.transitionTo(blockedKey, "Ready");
          unblockedIds.push(blockedKey);
        }
      }
    }

    return unblockedIds;
  }

  async markInProgress(ticketId: string, _workflowId: string): Promise<void> {
    await this.transitionTo(ticketId, "In Progress");
  }

  async markBlocked(ticketId: string, reason: string, _workflowId: string): Promise<void> {
    await this.transitionTo(ticketId, "Blocked");
    // Add a comment explaining why it's blocked
    await this.addComment(ticketId, "system", `Blocked: ${reason}`);
  }

  async addArtifact(
    ticketId: string,
    artifact: Omit<Artifact, "id" | "timestamp">
  ): Promise<Artifact> {
    const timestamp = new Date().toISOString();
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const commentBody = [
      `[ARTIFACT] ${artifact.title}`,
      `Type: ${artifact.type}`,
      `Produced by: ${artifact.producedBy}`,
      `---`,
      artifact.content,
    ].join("\n");

    await this.request("POST", `/rest/api/3/issue/${ticketId}/comment`, {
      body: this.toADF(commentBody),
    });

    return {
      id,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      producedBy: artifact.producedBy,
      timestamp,
    };
  }

  async addComment(ticketId: string, author: string, content: string): Promise<JiraComment> {
    const commentContent = `[${author}]: ${content}`;

    const data = await this.request("POST", `/rest/api/3/issue/${ticketId}/comment`, {
      body: this.toADF(commentContent),
    });

    return {
      id: data.id as string,
      author,
      content,
      timestamp: (data.created as string) || new Date().toISOString(),
    };
  }

  /**
   * TEAM-3705: hard-delete an issue. Used only for compensating cleanup of an
   * orphan epic created by a start that then lost the dedup ownership fence —
   * at that point the epic has no children and no workflow row references it,
   * so deletion is safe. Requires the Jira "Delete issues" permission; callers
   * treat failure as best-effort (log, never fail the request).
   */
  async deleteIssue(issueKey: string): Promise<void> {
    await this.request("DELETE", `/rest/api/3/issue/${issueKey}`);
  }

  async isWorkflowComplete(epicId: string): Promise<boolean> {
    // Search for all child issues of the epic using new /search/jql endpoint
    const jql = `parent = ${epicId} AND project = ${this.projectKey}`;
    const params = new URLSearchParams({ jql, fields: "status", maxResults: "100" });
    const data = await this.request("GET", `/rest/api/3/search/jql?${params.toString()}`);

    const issues = (data.issues as Array<Record<string, unknown>>) || [];
    if (issues.length === 0) return false;

    return issues.every((issue) => {
      const issueFields = issue.fields as Record<string, unknown> | undefined;
      const issueStatus = issueFields?.status as Record<string, unknown> | undefined;
      return issueStatus?.name === "Done";
    });
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    if (body && method !== "GET") {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Jira API error ${response.status} ${response.statusText} on ${method} ${path}: ${errorText}`
      );
    }

    // Some endpoints return no body: 204 No Content, and POST /issueLink
    // answers 201 Created with an EMPTY body. Parse from text so an empty
    // success never throws "Unexpected end of JSON input" (that error aborted
    // the first sdlc-playbook start at the gate → intake-ticket link).
    if (response.status === 204) {
      return {};
    }
    const text = await response.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  private async getIssue(issueKey: string): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/rest/api/3/issue/${issueKey}?fields=summary,description,status,issuetype,parent,labels,issuelinks,subtasks,comment,assignee`
    );
  }

  async transitionTo(issueKey: string, targetStatusName: string): Promise<void> {
    // Get available transitions
    const data = await this.request("GET", `/rest/api/3/issue/${issueKey}/transitions`);
    const transitions = (data.transitions || []) as Array<{ id: string; name: string; to?: { name?: string } }>;

    // Find transition matching target status
    const transition = transitions.find(
      (t) => t.name === targetStatusName || t.to?.name === targetStatusName
    );

    if (!transition) {
      const available = transitions.map((t) => `${t.name} (→${t.to?.name})`).join(", ");
      throw new Error(
        `No transition to "${targetStatusName}" available for ${issueKey}. Available: ${available}`
      );
    }

    await this.request("POST", `/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });
  }

  private async areAllBlockersDone(issueKey: string): Promise<boolean> {
    const issue = await this.getIssue(issueKey);
    const issueLinks = (issue.fields as Record<string, unknown>)?.issuelinks as Array<Record<string, unknown>> || [];

    for (const link of issueLinks) {
      const linkType = link.type as Record<string, unknown> | undefined;
      // "inwardIssue" when another ticket "blocks" this one
      if (linkType?.name === "Blocks" && link.inwardIssue) {
        const blockerIssue = link.inwardIssue as Record<string, unknown>;
        const blockerFields = blockerIssue.fields as Record<string, unknown> | undefined;
        const blockerStatus = blockerFields?.status as Record<string, unknown> | undefined;
        if (blockerStatus?.name !== "Done") {
          return false;
        }
      }
    }

    return true;
  }

  private mapIssueToTicket(issue: Record<string, unknown>): JiraTicket {
    const fields = issue.fields as Record<string, unknown>;
    const status = fields?.status as Record<string, unknown> | undefined;
    const statusName = (status?.name as string) || "To Do";
    const issuetype = fields?.issuetype as Record<string, unknown> | undefined;
    const parent = fields?.parent as Record<string, unknown> | undefined;
    const issueLinks = (fields?.issuelinks as Array<Record<string, unknown>>) || [];
    const subtasks = (fields?.subtasks as Array<Record<string, unknown>>) || [];
    const commentData = fields?.comment as Record<string, unknown> | undefined;
    const comments = (commentData?.comments as Array<Record<string, unknown>>) || [];
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

    // Map children from subtasks
    const children = subtasks.map((s) => s.key as string);

    // Map comments
    const mappedComments: JiraComment[] = comments
      .filter((c) => {
        const body = c.body as Record<string, unknown> | undefined;
        return body !== undefined;
      })
      .map((c) => ({
        id: c.id as string,
        author: ((c.author as Record<string, unknown>)?.displayName as string) || "unknown",
        content: this.extractTextFromADF(c.body as Record<string, unknown>),
        timestamp: (c.created as string) || new Date().toISOString(),
      }));

    // Separate artifacts from comments
    const artifacts: Artifact[] = [];
    const regularComments: JiraComment[] = [];
    for (const comment of mappedComments) {
      if (comment.content.startsWith("[ARTIFACT]")) {
        const lines = comment.content.split("\n");
        const title = lines[0].replace("[ARTIFACT] ", "");
        const typeLine = lines.find((l) => l.startsWith("Type: "));
        const producedByLine = lines.find((l) => l.startsWith("Produced by: "));
        const contentStart = lines.indexOf("---");
        const content = contentStart >= 0 ? lines.slice(contentStart + 1).join("\n") : "";

        artifacts.push({
          id: comment.id,
          type: (typeLine?.replace("Type: ", "") || "other") as Artifact["type"],
          title,
          content,
          producedBy: producedByLine?.replace("Produced by: ", "") || "unknown",
          timestamp: comment.timestamp,
        });
      } else {
        regularComments.push(comment);
      }
    }

    // Determine ticket type
    const issueTypeName = (issuetype?.name as string)?.toLowerCase() || "task";
    let ticketType: JiraTicket["type"] = "task";
    if (issueTypeName === "epic") ticketType = "epic";
    else if (issueTypeName === "story") ticketType = "story";

    // Extract assignee from labels. Agent tickets: "agent:<id>". Human-review
    // gates: "reviewer:<who>" → surfaced as "human:<who>".
    const agentLabel = labels.find((l) => l.startsWith("agent:"));
    const reviewerLabel = labels.find((l) => l.startsWith("reviewer:"));
    const assignee = agentLabel
      ? agentLabel.replace("agent:", "")
      : reviewerLabel
      ? `human:${reviewerLabel.replace("reviewer:", "")}`
      : undefined;

    return {
      id: issue.key as string,
      type: ticketType,
      title: (fields?.summary as string) || "",
      description: this.extractTextFromADF(fields?.description as Record<string, unknown>),
      status: JIRA_TO_INTERNAL_STATUS[statusName] || "todo",
      assignee,
      parent: parent?.key as string | undefined,
      children,
      blockedBy,
      comments: regularComments,
      artifacts,
      createdAt: (fields as Record<string, unknown>)?.created as string || new Date().toISOString(),
      updatedAt: (fields as Record<string, unknown>)?.updated as string || new Date().toISOString(),
    };
  }

  /**
   * Convert plain text to Atlassian Document Format (ADF).
   */
  private toADF(text: string): Record<string, unknown> {
    return {
      type: "doc",
      version: 1,
      content: text.split("\n").map((line) => ({
        type: "paragraph",
        content: line
          ? [{ type: "text", text: line }]
          : [],
      })),
    };
  }

  /**
   * Extract plain text from an ADF document.
   */
  private extractTextFromADF(adf: Record<string, unknown> | undefined | null): string {
    if (!adf) return "";
    const content = adf.content as Array<Record<string, unknown>> | undefined;
    if (!content) return "";

    const lines: string[] = [];
    for (const block of content) {
      const blockContent = block.content as Array<Record<string, unknown>> | undefined;
      if (blockContent) {
        const text = blockContent
          .map((node) => (node.text as string) || "")
          .join("");
        lines.push(text);
      } else {
        lines.push("");
      }
    }
    return lines.join("\n");
  }
}
