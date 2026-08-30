/**
 * Ticket Provider Interface
 *
 * Type definitions for the ticket provider abstraction.
 * The actual implementations are:
 *   - Jira:     ticket-provider-jira.ts (used when TICKET_PROVIDER=jira)
 *   - DynamoDB: Ticket operations go through the agentcore-hub-tickets Lambda
 *               (agents call it via gateway tools, UI calls it via API routes)
 */

import type { JiraTicket, JiraComment, Artifact, TicketStatus } from "./types";

// ─── Interface ──────────────────────────────────────────────────────────────

export interface CreateEpicInput {
  title: string;
  description: string;
}

export interface CreateTicketInput {
  parentId: string;
  title: string;
  description: string;
  assignee: string;
  blockedBy?: string[];
  /** Extra labels to stamp on the ticket (e.g. `wfdef:<id>` for metrics type resolution). */
  extraLabels?: string[];
}

export interface TicketProvider {
  /** Create an epic (top-level ticket for the workflow) */
  createEpic(input: CreateEpicInput): JiraTicket | Promise<JiraTicket>;

  /** Create a child ticket (story/task) */
  createTicket(input: CreateTicketInput, workflowId?: string): JiraTicket | Promise<JiraTicket>;

  /** Mark ticket done. Returns IDs of tickets that became "ready" (unblocked). */
  markDone(ticketId: string, workflowId: string): string[] | Promise<string[]>;

  /** Mark ticket in-progress */
  markInProgress(ticketId: string, workflowId: string): void | Promise<void>;

  /** Mark ticket blocked */
  markBlocked(ticketId: string, reason: string, workflowId: string): void | Promise<void>;

  /** Add an artifact to a ticket */
  addArtifact(ticketId: string, artifact: Omit<Artifact, "id" | "timestamp">): Artifact | Promise<Artifact>;

  /** Add a comment to a ticket */
  addComment(ticketId: string, author: string, content: string): JiraComment | Promise<JiraComment>;

  /** Check if all tickets in the workflow are done */
  isWorkflowComplete(epicId: string): boolean | Promise<boolean>;
}
