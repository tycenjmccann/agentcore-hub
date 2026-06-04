"use client";

import { FolderOpen } from "lucide-react";
import type { AgentTaskStatus, TicketStatus } from "@/lib/workflow/types";
import TicketStatusBadge from "./TicketStatusBadge";

interface PipelineAgentCardProps {
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
  isCelebrating: boolean;
  suppressAnimation: boolean;
  onExpand?: () => void;
  onViewArtifacts?: () => void;
  onOpenTicketModal?: (ticketId: string) => void;
}

const STATUS_CONFIG: Record<string, {
  borderClass: string;
  dotClass: string;
  label: string;
}> = {
  idle: {
    borderClass: "border-surface-4",
    dotClass: "bg-zinc-500",
    label: "Idle",
  },
  pending: {
    borderClass: "border-yellow-500/40",
    dotClass: "bg-yellow-400",
    label: "Pending",
  },
  running: {
    borderClass: "border-brand-500",
    dotClass: "bg-brand-500",
    label: "Working",
  },
  waiting_response: {
    borderClass: "border-purple-500/60",
    dotClass: "bg-purple-400",
    label: "Waiting",
  },
  complete: {
    borderClass: "border-green-500/50",
    dotClass: "bg-green-500",
    label: "Done",
  },
  error: {
    borderClass: "border-red-500/60",
    dotClass: "bg-red-400",
    label: "Error",
  },
};

export default function PipelineAgentCard({
  name,
  role,
  status,
  ticketId,
  ticketStatus,
  ticketTitle,
  outputPreview,
  branch,
  error,
  isCelebrating,
  suppressAnimation,
  onExpand,
  onViewArtifacts,
  onOpenTicketModal,
}: PipelineAgentCardProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.idle;

  const isWorking = status === "running";
  const isDone = status === "complete";
  const isError = status === "error";

  return (
    <div
      onClick={onExpand}
      className={`
        relative rounded-lg border p-3 cursor-pointer
        bg-surface-1 hover:bg-surface-2
        ${config.borderClass}
        ${isWorking && !suppressAnimation ? "pipeline-agent-pulse" : ""}
        ${isCelebrating && !suppressAnimation ? "pipeline-celebrate" : ""}
        ${isDone ? "opacity-80" : ""}
        ${!suppressAnimation ? "transition-all duration-300" : ""}
      `}
    >
      <div className="flex items-center gap-2">
        {/* Status dot */}
        <div className={`w-2 h-2 rounded-full shrink-0 ${config.dotClass} ${
          isWorking && !suppressAnimation ? "animate-pulse" : ""
        }`} />

        {/* Agent info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-primary truncate">
              {name}
            </span>
            {/* S3 artifacts button — only for non-idle agents */}
            {status !== "idle" && onViewArtifacts && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewArtifacts();
                }}
                className="p-0.5 rounded hover:bg-surface-3 text-muted hover:text-brand-400 transition-colors shrink-0"
                aria-label={`View S3 artifacts for ${name}`}
                title="View artifacts"
                type="button"
              >
                <FolderOpen size={12} />
              </button>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              isWorking
                ? "bg-brand-500/20 text-brand-400"
                : isDone
                ? "bg-green-500/20 text-green-400"
                : isError
                ? "bg-red-500/20 text-red-400"
                : "bg-surface-3 text-muted"
            }`}>
              {config.label}
            </span>
          </div>
          <p className="text-[10px] text-muted truncate mt-0.5">{role}</p>
        </div>
      </div>

      {/* Ticket reference */}
      {ticketId && (
        <div className="mt-1.5 flex items-center gap-1">
          {ticketStatus ? (
            <TicketStatusBadge
              status={ticketStatus}
              ticketId={ticketId}
              ticketTitle={ticketTitle}
              size="sm"
              onClick={onOpenTicketModal ? () => onOpenTicketModal(ticketId) : undefined}
            />
          ) : (
            <span className="text-[10px] text-muted font-mono">{ticketId}</span>
          )}
        </div>
      )}

      {/* Branch info */}
      {branch && isDone && (
        <div className="text-[10px] text-green-500/70 mt-1 font-mono truncate">
          {branch}
        </div>
      )}

      {/* Error message */}
      {isError && error && (
        <p className="text-[10px] text-red-400/80 mt-1.5 line-clamp-2">
          {error}
        </p>
      )}

      {/* Output preview */}
      {isDone && outputPreview && (
        <p className="text-[10px] text-muted mt-1.5 line-clamp-1 italic">
          {outputPreview.slice(0, 80)}...
        </p>
      )}
    </div>
  );
}
