/**
 * Shared event transformer — single source of truth for DynamoDB → UI event mapping.
 *
 * Used by both:
 *   - /api/workflow/[id]/stream (live SSE)
 *   - /api/workflow/[id]/events (replay JSON)
 *
 * Ensures live and replay modes produce identical UI event shapes.
 */

export interface TransformOptions {
  /** Include eventId in output (needed for replay scrubbing, not needed for live) */
  includeEventId?: boolean;
}

export function transformEvent(
  item: Record<string, unknown>,
  options: TransformOptions = {}
): Record<string, unknown> | null {
  const eventType = item.type as string;
  const detail = (item.detail || {}) as Record<string, unknown>;
  const agentId = detail.agentId as string;
  const timestamp = item.timestamp as string;
  const eventId = options.includeEventId ? (item.eventId as string | undefined) : undefined;

  // Helper to merge eventId only when present
  const base = (obj: Record<string, unknown>) =>
    eventId ? { ...obj, eventId } : obj;

  switch (eventType) {
    case "agent.streaming": {
      const subType = detail.type as string;
      if (subType === "text") {
        return base({ type: "agent_output", agentId, chunk: detail.content, ticketId: detail.ticketId, timestamp });
      }
      if (subType === "trace") {
        return base({ type: "tool_use", agentId, toolName: detail.toolName, timestamp });
      }
      if (subType === "heartbeat") {
        // TEAM-4100 F6 — a coding runtime emits an agent.streaming heartbeat while
        // a long silent claude_code/codex turn polls (main.py _publish_coding_
        // heartbeat). The orchestrator's lease counts ANY agent.streaming row, so a
        // heartbeat renews the backend lease; the UI must see the SAME signal or it
        // paints STUCK (and exposes the manual Restart → duplicate session, D1.5)
        // while the backend still holds a live lease. Map it to a liveness-only
        // event: it advances the idle clock (stale.ts LIVENESS_EVENT_TYPES) but is
        // NOT rendered as transcript text (no chunk; WorkflowBoard has no case).
        return base({ type: "agent_heartbeat", agentId, ticketId: detail.ticketId, timestamp });
      }
      return null;
    }

    case "agent.complete":
      return base({
        type: "agent_complete",
        agentId,
        output: detail.output,
        branch: detail.branch,
        commitSha: detail.commitSha,
        timestamp,
      });

    case "agent.error":
      return base({ type: "error", agentId, error: detail.error, timestamp });

    case "dead_session.shadow":
      // Dead-session detector running in shadow mode (its default): an
      // observation that the sweep WOULD have fired, not a failure and not a UI
      // event. Explicit case on purpose — the default branch would pass it
      // through as an unknown event type and leak it into the stream.
      return null;

    case "agent.started":
    case "agent.invoked":
      return base({
        type: "agent_status",
        agentId: agentId || (detail.assignee as string),
        status: "running",
        ticketId: detail.ticketId as string,
        timestamp,
      });

    case "workflow.report_completion":
      // Agent reported done via report_completion tool — emit agent_complete immediately
      if (detail.agentId) {
        return base({
          type: "agent_complete",
          agentId: detail.agentId as string,
          output: detail.summary,
          branch: detail.branch,
          timestamp,
        });
      }
      return null;

    case "workflow.phase_change":
      return base({ type: "phase_change", phase: detail.phase, timestamp });

    case "workflow.complete":
      return base({ type: "workflow_complete", timestamp });

    case "ticket.created":
      if (detail.ticket) {
        return base({ type: "ticket_created", ticket: detail.ticket, timestamp });
      }
      return null;

    case "workflow.nudge":
      return base({
        type: "nudge",
        nudged: detail.nudged,
        ticketsScanned: detail.ticketsScanned,
        timestamp,
      });

    case "manager.intervention":
      return base({
        type: "manager_intervention",
        action: detail.action,
        ticketId: detail.ticketId,
        note: detail.note,
        timestamp,
      });

    case "manager.escalation":
      return base({
        type: "manager_escalation",
        message: detail.message,
        timestamp,
      });

    case "operator.message":
      // Mailbox item for mid-flow agent messaging — consumed by the persona
      // runtime, not a UI event. (Delivery is surfaced as agent.streaming.)
      return null;

    default:
      return base({ type: eventType, ...detail, timestamp });
  }
}
