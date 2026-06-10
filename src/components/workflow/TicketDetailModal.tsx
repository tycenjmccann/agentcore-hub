"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronDown,
  Loader2,
  AlertCircle,
  Send,
  ExternalLink,
} from "lucide-react";
import type { JiraTicket, TicketStatus, TicketType } from "@/lib/workflow/types";

// ─── Props ──────────────────────────────────────────────────────────────────

interface TicketDetailModalProps {
  ticketId: string;
  workflowId: string;
  isOpen: boolean;
  onClose: () => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Status-specific colors use dark: prefixes — see TicketStatusBadge.tsx for rationale.
const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  backlog:     { dot: "bg-zinc-500", text: "text-zinc-600 dark:text-zinc-400", label: "Backlog" },
  todo:        { dot: "bg-zinc-400", text: "text-zinc-600 dark:text-zinc-300", label: "To Do" },
  ready:       { dot: "bg-yellow-400", text: "text-yellow-700 dark:text-yellow-300", label: "Ready" },
  in_progress: { dot: "bg-blue-400", text: "text-blue-700 dark:text-blue-300", label: "In Progress" },
  in_review:   { dot: "bg-purple-400", text: "text-purple-700 dark:text-purple-300", label: "In Review" },
  done:        { dot: "bg-green-400", text: "text-green-700 dark:text-green-300", label: "Done" },
  blocked:     { dot: "bg-red-400", text: "text-red-700 dark:text-red-300", label: "Blocked" },
  cancelled:   { dot: "bg-zinc-600", text: "text-zinc-500", label: "Cancelled" },
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "in_review", "blocked"],
  in_progress: ["done", "in_review", "blocked"],
  in_review: ["done", "blocked"],
  blocked: ["todo", "ready", "in_progress", "in_review", "done"],
  done: ["todo"],
};

// Human-friendly labels for the review-gate transitions (in_review → done/blocked).
const TRANSITION_LABELS: Record<string, string> = {
  done: "Approve",
  blocked: "Request changes",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatAgentName(agentId: string): string {
  return agentId
    .replace(/^agentcore_hub_/, "")
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

// ─── DAG Component ──────────────────────────────────────────────────────────

interface DagNode {
  id: string;
  status: string;
  type: string;
  blockedBy: string[];
  parent: string;
}

function TicketDag({ tickets, currentTicketId }: { tickets: DagNode[]; currentTicketId: string }) {
  if (tickets.length === 0) return null;

  const ticketMap = new Map(tickets.map((t) => [t.id, t]));

  // Separate epic from children
  const epic = tickets.find((t) => t.type === "epic");
  const children = tickets.filter((t) => t.type !== "epic");

  // Check if children have internal edges (blockedBy refs pointing to other children)
  const hasEdges = children.some((t) => t.blockedBy.some((b) => ticketMap.has(b)));

  return (
    <div className="space-y-2">
      {/* Epic row */}
      {epic && (
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-mono ${
              epic.id === currentTicketId
                ? "border-blue-500/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300"
            }`}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: epic.id === currentTicketId ? getComputedDotColor(epic.status) : "#d946ef" }}
            />
            {epic.id}
          </span>
          <span className="text-[9px] text-muted">Epic</span>
        </div>
      )}

      {/* Children flow */}
      {!hasEdges ? (
        // No dependencies — horizontal chip wrap
        <div className="flex flex-wrap gap-1.5">
          {children.map((t) => {
            const isCurrent = t.id === currentTicketId;
            return (
              <span
                key={t.id}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-mono ${
                  isCurrent
                    ? "border-blue-500/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                    : "border-surface-4 bg-[color-mix(in_srgb,var(--color-surface-1)_60%,transparent)] text-secondary"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: getComputedDotColor(t.status) }}
                />
                {t.id}
              </span>
            );
          })}
        </div>
      ) : (
        // Has dependencies — SVG DAG with horizontal flow
        <DagSvg tickets={children} currentTicketId={currentTicketId} ticketMap={ticketMap} />
      )}
    </div>
  );
}

function DagSvg({ tickets, currentTicketId, ticketMap }: { tickets: DagNode[]; currentTicketId: string; ticketMap: Map<string, DagNode> }) {
  // Topological layering
  const placed = new Set<string>();
  const layers: string[][] = [];
  const remaining = new Set(tickets.map((t) => t.id));

  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const id of remaining) {
      const t = ticketMap.get(id)!;
      const allDepsPlaced = t.blockedBy.every((b) => placed.has(b) || !ticketMap.has(b));
      if (allDepsPlaced) layer.push(id);
    }
    if (layer.length === 0) {
      layers.push([...remaining]);
      break;
    }
    layer.forEach((id) => { placed.add(id); remaining.delete(id); });
    layers.push(layer);
  }

  const nodeW = 76;
  const nodeH = 26;
  const layerGap = 40;
  const nodeGap = 6;

  const positions: Record<string, { x: number; y: number }> = {};
  let totalWidth = 0;
  layers.forEach((layer, li) => {
    const x = li * (nodeW + layerGap);
    layer.forEach((id, ni) => {
      positions[id] = { x, y: ni * (nodeH + nodeGap) };
    });
    totalWidth = x + nodeW;
  });

  const maxY = Math.max(...Object.values(positions).map((p) => p.y)) + nodeH;
  const svgWidth = totalWidth + 8;
  const svgHeight = maxY + 8;

  return (
    <div className="overflow-x-auto pb-1">
      <svg width={svgWidth} height={svgHeight} className="min-w-fit" aria-label="Ticket dependency graph">
        {/* Edges */}
        {tickets.map((t) =>
          t.blockedBy
            .filter((bid) => positions[bid])
            .map((bid) => {
              const from = positions[bid];
              const to = positions[t.id];
              if (!from || !to) return null;
              const x1 = from.x + nodeW + 2;
              const y1 = from.y + nodeH / 2;
              const x2 = to.x - 2;
              const y2 = to.y + nodeH / 2;
              const resolved = ticketMap.get(bid)?.status === "done";
              const color = resolved ? "#22c55e" : "#ef4444";
              const midX = (x1 + x2) / 2;
              const d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
              return (
                <g key={`${bid}->${t.id}`}>
                  <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={resolved ? undefined : "4 2"} opacity={0.5} />
                  <polygon points={`${x2},${y2} ${x2 - 5},${y2 - 3} ${x2 - 5},${y2 + 3}`} fill={color} opacity={0.6} />
                </g>
              );
            })
        )}
        {/* Nodes */}
        {tickets.map((t) => {
          const pos = positions[t.id];
          if (!pos) return null;
          const isCurrent = t.id === currentTicketId;
          return (
            <g key={t.id}>
              <rect
                x={pos.x} y={pos.y} width={nodeW} height={nodeH} rx={5}
                fill={isCurrent ? "rgba(59,130,246,0.15)" : "rgba(30,41,59,0.8)"}
                stroke={isCurrent ? "#3b82f6" : "rgba(51,65,85,0.5)"}
                strokeWidth={isCurrent ? 1.5 : 1}
              />
              <circle cx={pos.x + 10} cy={pos.y + nodeH / 2} r={3} fill={getComputedDotColor(t.status)} />
              <text x={pos.x + 18} y={pos.y + nodeH / 2 + 3.5} fontSize={9} fontFamily="monospace" fill={isCurrent ? "#93c5fd" : "#94a3b8"}>
                {t.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function getComputedDotColor(status: string): string {
  const colors: Record<string, string> = {
    backlog: "#71717a",
    todo: "#a1a1aa",
    ready: "#facc15",
    in_progress: "#60a5fa",
    in_review: "#c084fc",
    done: "#4ade80",
    blocked: "#f87171",
    cancelled: "#52525b",
  };
  return colors[status] || "#a1a1aa";
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function TicketDetailModal({
  ticketId,
  workflowId,
  isOpen,
  onClose,
}: TicketDetailModalProps) {
  const [ticket, setTicket] = useState<JiraTicket | null>(null);
  const [allTickets, setAllTickets] = useState<JiraTicket[]>([]);
  const [browseBaseUrl, setBrowseBaseUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Status dropdown
  const [statusOpen, setStatusOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Notes
  const [newNote, setNewNote] = useState("");
  const [isAddingNote, setIsAddingNote] = useState(false);

  const [announcement, setAnnouncement] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  // Mount tracking
  useEffect(() => { setMounted(true); }, []);

  // Fetch tickets
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    setTicket(null);
    setStatusOpen(false);
    setTransitionError(null);

    fetch(`/api/workflow/${workflowId}/tickets`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { tickets: Record<string, unknown>[]; browseBaseUrl?: string | null }) => {
        const raw = data.tickets ?? [];
        if (data.browseBaseUrl) setBrowseBaseUrl(data.browseBaseUrl);
        const normalized = raw.map((t) => ({
          ...t,
          id: (t.ticketId || t.id) as string,
          title: (t.title || t.summary || t.ticketId || t.id) as string,
          type: (t.type || t.issueType || "task") as TicketType,
          children: (t.children || []) as string[],
          blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : (t.blockedBy ? String(t.blockedBy).split(",").filter(Boolean) : []),
          comments: (t.comments || []) as JiraTicket["comments"],
          artifacts: (t.artifacts || []) as JiraTicket["artifacts"],
          parent: (t.parentId || t.parent || "") as string,
        })) as unknown as JiraTicket[];
        setAllTickets(normalized);
        const found = normalized.find((t) => t.id === ticketId);
        if (found) setTicket(found);
        else setError(`Ticket ${ticketId} not found`);
        setIsLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message || "Failed to load ticket");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, workflowId, ticketId]);

  // Focus + Escape
  useEffect(() => {
    if (isOpen && !isClosing) setTimeout(() => closeButtonRef.current?.focus(), 100);
  }, [isOpen, isClosing]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Close status dropdown on outside click
  useEffect(() => {
    if (!statusOpen) return;
    const handler = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [statusOpen]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => { setIsClosing(false); onClose(); }, 180);
  }, [onClose]);

  const handleTransition = useCallback(async (targetStatus: string) => {
    if (!ticket) return;
    setIsTransitioning(true);
    setTransitionError(null);
    setStatusOpen(false);

    try {
      const res = await fetch(`/api/workflow/${workflowId}/tickets/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticket.id, targetStatus }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setTicket((prev) => prev ? { ...prev, status: targetStatus as TicketStatus } : prev);
      setAnnouncement(`Status changed to ${STATUS_STYLES[targetStatus]?.label ?? targetStatus}`);
    } catch (err: unknown) {
      setTransitionError(err instanceof Error ? err.message : "Transition failed");
    } finally {
      setIsTransitioning(false);
    }
  }, [ticket, workflowId]);

  const handleAddNote = useCallback(async () => {
    if (!ticket || !newNote.trim()) return;
    setIsAddingNote(true);
    try {
      // Post comment via the tickets Lambda (through our API)
      // For now we'll just add it locally since we don't have a dedicated comment endpoint in the UI API
      const comment = {
        id: `comment-${Date.now()}`,
        author: "user",
        content: newNote.trim(),
        timestamp: new Date().toISOString(),
      };
      setTicket((prev) => prev ? { ...prev, comments: [...prev.comments, comment] } : prev);
      setNewNote("");
    } finally {
      setIsAddingNote(false);
    }
  }, [ticket, newNote]);

  // Build DAG data from all tickets in this workflow
  const dagNodes: DagNode[] = allTickets.map((t) => ({
    id: t.id,
    status: t.status,
    type: t.type,
    blockedBy: t.blockedBy || [],
    parent: t.parent || "",
  }));

  // "in_review" is a human-review-gate state: only offer it for human:* tickets,
  // otherwise an agent ticket could be parked there and never invoked.
  const isHumanReview = !!ticket?.assignee?.startsWith("human:");
  const validTransitions = ticket
    ? (VALID_TRANSITIONS[ticket.status] ?? []).filter(
        (s) => s !== "in_review" || isHumanReview
      )
    : [];

  if (!mounted || !isOpen) return null;

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" role="presentation">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 ${isClosing ? "modal-backdrop-exit" : "modal-backdrop-enter"}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-modal-title"
        className={`relative z-[201] w-full max-w-2xl mx-4 max-h-[85vh] bg-surface-1 border border-theme rounded-xl shadow-2xl flex flex-col overflow-hidden ${isClosing ? "modal-card-exit" : "modal-card-enter"}`}
      >
        {/* ARIA live */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

        {/* Close button */}
        <button
          ref={closeButtonRef}
          onClick={handleClose}
          className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-surface-3 text-secondary hover:text-primary transition-colors z-10"
          aria-label="Close"
          type="button"
        >
          <X size={18} />
        </button>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center h-48">
              <Loader2 size={24} className="animate-spin text-muted" />
            </div>
          )}

          {/* Error */}
          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center h-48 text-center p-6">
              <AlertCircle size={20} className="text-red-400 mb-2" />
              <p className="text-[13px] text-secondary">{error}</p>
            </div>
          )}

          {/* Loaded */}
          {!isLoading && !error && ticket && (
            <div className="flex flex-col">
              {/* ─── DAG Section ─── */}
              {dagNodes.length > 1 && (
                <div className="px-5 pt-4 pb-3 border-b border-theme">
                  <p className="text-[9px] uppercase tracking-wider text-muted mb-2">Ticket Flow</p>
                  <TicketDag tickets={dagNodes} currentTicketId={ticketId} />
                </div>
              )}

              {/* ─── Header: Status | ID | Title ─── */}
              <div className="px-5 pt-4 pb-3 border-b border-theme flex items-center gap-3">
                {/* Status with dropdown */}
                <div ref={statusRef} className="relative">
                  <button
                    onClick={() => validTransitions.length > 0 && setStatusOpen(!statusOpen)}
                    disabled={isTransitioning || validTransitions.length === 0}
                    className={`inline-flex items-center gap-1.5 rounded-full border border-theme px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      STATUS_STYLES[ticket.status]?.text ?? "text-secondary"
                    } ${validTransitions.length > 0 ? "cursor-pointer hover:border-brand-500/50" : "cursor-default"}`}
                    type="button"
                    aria-expanded={statusOpen}
                    aria-haspopup="listbox"
                  >
                    <span className={`w-2 h-2 rounded-full ${STATUS_STYLES[ticket.status]?.dot ?? "bg-zinc-500"}`} />
                    {STATUS_STYLES[ticket.status]?.label ?? ticket.status}
                    {validTransitions.length > 0 && (
                      <ChevronDown size={12} className={`transition-transform ${statusOpen ? "rotate-180" : ""}`} />
                    )}
                    {isTransitioning && <Loader2 size={10} className="animate-spin ml-1" />}
                  </button>

                  {/* Dropdown */}
                  {statusOpen && (
                    <div className="absolute top-full left-0 mt-1 bg-surface-0 border border-theme rounded-lg shadow-xl py-1 z-10 min-w-[140px]">
                      {validTransitions.map((s) => (
                        <button
                          key={s}
                          onClick={() => handleTransition(s)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-secondary hover:bg-surface-2 transition-colors"
                          type="button"
                        >
                          <span className={`w-2 h-2 rounded-full ${STATUS_STYLES[s]?.dot ?? "bg-zinc-500"}`} />
                          {/* At a review gate, label the choices Approve / Request changes. */}
                          {ticket.status === "in_review"
                            ? TRANSITION_LABELS[s] ?? STATUS_STYLES[s]?.label ?? s
                            : STATUS_STYLES[s]?.label ?? s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Ticket ID — links to Jira if configured */}
                {browseBaseUrl ? (
                  <a
                    href={`${browseBaseUrl}/${ticket.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[12px] text-blue-400 hover:text-blue-300 shrink-0 transition-colors"
                  >
                    {ticket.id}
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  <span className="font-mono text-[12px] text-muted shrink-0">{ticket.id}</span>
                )}

                {/* Title */}
                <h2 id="ticket-modal-title" className="text-[14px] font-semibold text-primary truncate flex-1">
                  {ticket.title}
                </h2>
              </div>

              {/* Transition error */}
              {transitionError && (
                <div className="px-5 py-2 bg-red-900/20 border-b border-red-500/20">
                  <p className="text-[11px] text-red-400">{transitionError}</p>
                </div>
              )}

              {/* ─── Assignee ─── */}
              {ticket.assignee && (
                <div className="px-5 pt-3 pb-2 flex items-center gap-2 text-[11px]">
                  <span className="text-muted">Assigned to</span>
                  <span className="text-secondary font-medium">{formatAgentName(ticket.assignee)}</span>
                </div>
              )}

              {/* ─── Description ─── */}
              {ticket.description && (
                <div className="px-5 py-3 border-b border-theme">
                  <p className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Description</p>
                  <div className="text-[12px] text-secondary whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                    {ticket.description}
                  </div>
                </div>
              )}

              {/* ─── Notes / Comments ─── */}
              <div className="px-5 py-3">
                <p className="text-[10px] uppercase tracking-wider text-muted mb-2">Notes</p>

                {ticket.comments.length === 0 && (
                  <p className="text-[12px] text-muted italic mb-3">No notes yet</p>
                )}

                {ticket.comments.length > 0 && (
                  <div className="space-y-2.5 max-h-48 overflow-y-auto mb-3">
                    {ticket.comments.map((comment) => (
                      <div key={comment.id} className="text-[12px]">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-medium text-secondary">
                            {formatAgentName(comment.author)}
                          </span>
                          <span className="text-muted text-[10px]">
                            {formatRelativeTime(comment.timestamp)}
                          </span>
                        </div>
                        <p className="text-secondary leading-relaxed">{comment.content}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add note input */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && newNote.trim()) handleAddNote(); }}
                    placeholder="Add a note..."
                    className="flex-1 bg-surface-0 border border-theme rounded-md px-3 py-1.5 text-[12px] text-primary placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                    disabled={isAddingNote}
                  />
                  <button
                    onClick={handleAddNote}
                    disabled={!newNote.trim() || isAddingNote}
                    className="p-1.5 rounded-md text-secondary hover:text-blue-400 disabled:opacity-30 disabled:cursor-default transition-colors"
                    type="button"
                    aria-label="Send note"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
