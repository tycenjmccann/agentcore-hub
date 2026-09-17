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
import type { HumanNotification, JiraTicket, TicketStatus, TicketType } from "@/lib/workflow/types";
import type { TicketTiming } from "./TicketFlowDag";
import TicketFlowDag from "./TicketFlowDag";

// ─── Props ──────────────────────────────────────────────────────────────────

interface TicketDetailModalProps {
  ticketId: string;
  workflowId: string;
  isOpen: boolean;
  onClose: () => void;
  /** review_needed notification for this ticket, when it's a human gate —
   *  renders the review package (summary/bullets/links) above the description. */
  reviewNotification?: HumanNotification | null;
  /** Orders def-specific phases in the ticket flow after the SDLC ones. */
  workflowDefId?: string | null;
  /** Clicking a card in the ticket flow refocuses the modal on that ticket. */
  onNavigate?: (ticketId: string) => void;
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

// ─── Ticket flow ────────────────────────────────────────────────────────────
// The dependency graph lives in TicketFlowDag (layout: lib/workflow/ticket-flow-layout.ts).

// ─── Component ──────────────────────────────────────────────────────────────

export default function TicketDetailModal({
  ticketId,
  workflowId,
  isOpen,
  onClose,
  reviewNotification,
  workflowDefId,
  onNavigate,
}: TicketDetailModalProps) {
  const [ticket, setTicket] = useState<JiraTicket | null>(null);
  const [allTickets, setAllTickets] = useState<JiraTicket[]>([]);
  const [timings, setTimings] = useState<Record<string, TicketTiming>>({});
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
      .then((data: { tickets: Record<string, unknown>[]; browseBaseUrl?: string | null; timings?: Record<string, TicketTiming> }) => {
        const raw = data.tickets ?? [];
        if (data.browseBaseUrl) setBrowseBaseUrl(data.browseBaseUrl);
        setTimings(data.timings ?? {});
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

    // "Request changes" at a review gate (in_review → blocked) must carry the
    // reviewer's feedback — it's passed as the transition comment so the
    // reworked agents actually receive it. Require the Notes field.
    const isRequestChanges = ticket.status === "in_review" && targetStatus === "blocked";
    const feedback = newNote.trim();
    if (isRequestChanges && !feedback) {
      setStatusOpen(false);
      setTransitionError("Add a note with the requested changes before rejecting.");
      return;
    }

    setIsTransitioning(true);
    setTransitionError(null);
    setStatusOpen(false);

    try {
      const res = await fetch(`/api/workflow/${workflowId}/tickets/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId: ticket.id,
          targetStatus,
          ...(isRequestChanges ? { comment: feedback } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setTicket((prev) => prev ? { ...prev, status: targetStatus as TicketStatus } : prev);
      if (isRequestChanges) setNewNote("");
      setAnnouncement(`Status changed to ${STATUS_STYLES[targetStatus]?.label ?? targetStatus}`);
    } catch (err: unknown) {
      setTransitionError(err instanceof Error ? err.message : "Transition failed");
    } finally {
      setIsTransitioning(false);
    }
  }, [ticket, workflowId, newNote]);

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
        className={`relative z-[201] w-full max-w-5xl mx-4 max-h-[85vh] bg-surface-1 border border-theme rounded-xl shadow-2xl flex flex-col overflow-hidden ${isClosing ? "modal-card-exit" : "modal-card-enter"}`}
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
              {allTickets.length > 1 && (
                <div className="px-5 pt-4 pb-3 border-b border-theme">
                  <p className="text-[9px] uppercase tracking-wider text-muted mb-2">Ticket Flow</p>
                  <TicketFlowDag
                    tickets={allTickets}
                    currentTicketId={ticketId}
                    timings={timings}
                    workflowDefId={workflowDefId}
                    onSelect={onNavigate}
                  />
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

              {/* ─── Review package (human gate) ─── */}
              {reviewNotification?.summary && (
                <div className="px-5 py-3 border-b border-theme bg-purple-500/5">
                  <p className="text-[10px] uppercase tracking-wider text-purple-600 dark:text-purple-300 mb-1.5">
                    Review package
                  </p>
                  <p className="text-[12px] text-secondary leading-relaxed mb-1.5">
                    {reviewNotification.summary}
                  </p>
                  {(reviewNotification.bullets?.length ?? 0) > 0 && (
                    <ul className="text-[12px] text-secondary space-y-0.5 mb-2 list-disc pl-4">
                      {reviewNotification.bullets!.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  )}
                  {(reviewNotification.links?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {reviewNotification.links!.map((l, i) => (
                        <a
                          key={i}
                          href={l.url || `/workflow?id=${encodeURIComponent(workflowId)}&artifact=${encodeURIComponent(l.artifactKey || "")}`}
                          target={l.url ? "_blank" : undefined}
                          rel={l.url ? "noopener noreferrer" : undefined}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-theme text-[11px] text-secondary hover:text-primary hover:border-purple-400 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {l.label}
                        </a>
                      ))}
                    </div>
                  )}
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
