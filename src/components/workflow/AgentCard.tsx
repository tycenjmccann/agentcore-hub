"use client";

import type { AgentTaskStatus, TicketStatus } from "@/lib/workflow/types";
import TicketStatusBadge from "./TicketStatusBadge";

interface AgentCardProps {
  agentId: string;
  name: string;
  role: string;
  status: AgentTaskStatus | "idle";
  ticketId?: string;
  ticketStatus?: TicketStatus;
  ticketTitle?: string;
  outputPreview?: string;
  branch?: string;
  error?: string;
  workflowId?: string;
  onExpand?: () => void;
  onOpenTicketModal?: (ticketId: string) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  idle: { bg: "bg-surface-1", text: "text-secondary", label: "Idle" },
  pending: { bg: "bg-yellow-900/30", text: "text-yellow-400", label: "Pending" },
  running: { bg: "bg-blue-900/30", text: "text-blue-400", label: "Running" },
  waiting_response: { bg: "bg-purple-900/30", text: "text-purple-400", label: "Waiting" },
  complete: { bg: "bg-green-900/30", text: "text-green-400", label: "Done" },
  error: { bg: "bg-red-900/30", text: "text-red-400", label: "Error" },
};

export default function AgentCard({
  agentId,
  name,
  role,
  status,
  ticketId,
  ticketStatus,
  ticketTitle,
  outputPreview,
  branch,
  error,
  workflowId,
  onExpand,
  onOpenTicketModal,
}: AgentCardProps) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.idle;

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!workflowId) return;
    try {
      await fetch(`/api/workflow/${workflowId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
    } catch {
      // Retry request failed — user will see error status remains
    }
  };

  return (
    <div
      className={`rounded-lg border border-theme p-3 ${style.bg} cursor-pointer hover:border-brand-500/50 transition-colors`}
      onClick={onExpand}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-primary">{name}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${style.text} bg-[color-mix(in_srgb,var(--color-surface-0)_50%,transparent)]`}>
          {style.label}
        </span>
      </div>

      <p className="text-xs text-secondary mb-2">{role}</p>

      {ticketId && (
        <div className="text-xs text-muted mb-1 flex items-center gap-1.5">
          <span>Ticket:</span>
          {ticketStatus ? (
            <TicketStatusBadge
              status={ticketStatus}
              ticketId={ticketId}
              ticketTitle={ticketTitle}
              size="sm"
              onClick={onOpenTicketModal ? () => onOpenTicketModal(ticketId) : undefined}
            />
          ) : (
            <span className="text-secondary font-mono">{ticketId}</span>
          )}
        </div>
      )}

      {status === "running" && (
        <div className="flex items-center gap-1 mt-2">
          <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
          <span className="text-xs text-blue-400">Working...</span>
        </div>
      )}

      {status === "error" && (
        <div className="mt-2 space-y-1">
          {error && (
            <p className="text-xs text-red-400 line-clamp-2">{error}</p>
          )}
          <button
            onClick={handleRetry}
            className="px-2 py-1 text-xs bg-red-900/50 text-red-300 rounded hover:bg-red-800/50 border border-red-700/50"
          >
            Retry
          </button>
        </div>
      )}

      {outputPreview && status === "complete" && (
        <p className="text-xs text-secondary mt-2 line-clamp-2 italic">
          {outputPreview.slice(0, 120)}...
        </p>
      )}

      {branch && (
        <div className="text-xs text-green-400 mt-1 font-mono">
          {branch}
        </div>
      )}
    </div>
  );
}
