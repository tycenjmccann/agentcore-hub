"use client";

import type { TicketStatus } from "@/lib/workflow/types";

interface TicketStatusBadgeProps {
  status: TicketStatus;
  ticketId?: string;
  ticketTitle?: string;
  onClick?: () => void;
  size?: "sm" | "md";
}

const STATUS_CONFIG: Record<TicketStatus, { dot: string; label: string; pulse: boolean }> = {
  backlog: { dot: "bg-zinc-500", label: "Backlog", pulse: false },
  todo: { dot: "bg-zinc-400", label: "To Do", pulse: false },
  ready: { dot: "bg-yellow-400", label: "Ready", pulse: false },
  in_progress: { dot: "bg-blue-400", label: "In Progress", pulse: true },
  in_review: { dot: "bg-purple-400", label: "In Review", pulse: true },
  done: { dot: "bg-green-400", label: "Done", pulse: false },
  blocked: { dot: "bg-red-400", label: "Blocked", pulse: false },
  cancelled: { dot: "bg-zinc-600", label: "Cancelled", pulse: false },
};

const BORDER_COLOR: Record<TicketStatus, string> = {
  backlog: "border-zinc-500/30",
  todo: "border-zinc-400/30",
  ready: "border-yellow-400/30",
  in_progress: "border-blue-400/30",
  in_review: "border-purple-400/30",
  done: "border-green-400/30",
  blocked: "border-red-400/30",
  cancelled: "border-zinc-600/30",
};

const TEXT_COLOR: Record<TicketStatus, string> = {
  backlog: "text-zinc-400",
  todo: "text-zinc-300",
  ready: "text-yellow-300",
  in_progress: "text-blue-300",
  in_review: "text-purple-300",
  done: "text-green-300",
  blocked: "text-red-300",
  cancelled: "text-zinc-500",
};

export default function TicketStatusBadge({
  status,
  ticketTitle,
  onClick,
  size = "sm",
}: TicketStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const border = BORDER_COLOR[status];
  const text = TEXT_COLOR[status];

  const sizeClasses =
    size === "sm"
      ? "text-[10px] px-1.5 py-0.5"
      : "text-xs px-2 py-1";

  const interactiveClasses = onClick
    ? "cursor-pointer hover:ring-1 hover:ring-current/30 focus-visible:ring-1 focus-visible:ring-current/30 focus-visible:outline-none"
    : "";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border leading-none ${border} ${text} ${sizeClasses} ${interactiveClasses}`}
      title={ticketTitle}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? "animate-pulse" : ""}`}
      />
      <span>{config.label}</span>
    </span>
  );
}
