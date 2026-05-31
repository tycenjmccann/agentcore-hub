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
  idle: { bg: "bg-zinc-800", text: "text-zinc-400", label: "Idle" },
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
      className={`rounded-lg border border-zinc-700 p-3 ${style.bg} cursor-pointer hover:border-zinc-500 transition-colors`}
      onClick={onExpand}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-zinc-100">{name}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${style.text} bg-zinc-900/50`}>
          {style.label}
        </span>
      </div>

      <p className="text-xs text-zinc-400 mb-2">{role}</p>

      {ticketId && (
        <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1.5">
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
            <span className="text-zinc-300 font-mono">{ticketId}</span>
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
        <p className="text-xs text-zinc-400 mt-2 line-clamp-2 italic">
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
