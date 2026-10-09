"use client";

import { useEffect, useMemo, useState } from "react";
import agentsConfig from "@/config/agents.json";
import { getWorkflowDef } from "@/lib/workflow/workflow-defs";
import type { JiraTicket } from "@/lib/workflow/types";
import {
  FLOW_METRICS,
  layoutTicketFlow,
  type FlowKind,
  type FlowNode,
  type FlowTicket,
} from "@/lib/workflow/ticket-flow-layout";

// ─── Roster + phase presentation ────────────────────────────────────────────

const ROSTER = new Map(
  (agentsConfig.agents as Array<{ agentId: string; phase: string; displayName: string }>).map((a) => [
    a.agentId,
    { phase: a.phase, name: a.displayName },
  ])
);

const PHASE_LABEL: Record<string, string> = {
  intake: "Intake",
  requirements: "Req",
  design: "Design",
  development: "Dev",
  review: "Review",
  ci: "CI",
  verification: "QA",
  ship: "Ship",
  cd: "Merge · CD",
};

const PHASE_COLOR: Record<string, string> = {
  requirements: "#a78bfa",
  design: "#38bdf8",
  development: "#34d399",
  review: "#fbbf24",
  ci: "#fb923c",
  verification: "#e879f9",
  ship: "#22d3ee",
  cd: "#60a5fa",
};
const NEUTRAL = "#9ca3af";

const KIND_LABEL: Record<FlowKind, string> = {
  review_fix: "review fix",
  qa_fix: "QA fix",
  codex_fix: "review fix",
  ship_fix: "ship fix",
  ci_fix: "CI fix",
  sync_fix: "sync",
  recert: "re-cert",
  advisory: "advisory",
  fix: "fix",
};

const STATUS_DOT: Record<string, string> = {
  backlog: "#71717a",
  todo: "#a1a1aa",
  ready: "#facc15",
  in_progress: "#60a5fa",
  in_review: "#c084fc",
  done: "#4ade80",
  blocked: "#f87171",
  cancelled: "#52525b",
};

const phaseLabel = (p: string) => PHASE_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
const phaseColor = (p: string) => PHASE_COLOR[p] ?? NEUTRAL;

// Roster display names are too long for a 118px card; the tooltip keeps the full id.
const SHORT_WORD: Record<string, string> = {
  Backend: "BE", Frontend: "FE", Developer: "Dev", Requirements: "Req", Manager: "Mgr", Security: "Sec",
};
function agentName(assignee: string | undefined, isHuman: boolean, title: string): string {
  if (!assignee) return "Unassigned";
  if (isHuman) {
    // "Merge Approval: <feature>" → "Merge Approval"
    const head = title.split(/[:(]/)[0].trim();
    return head && head.length <= 24 ? head : "Human";
  }
  const full =
    ROSTER.get(assignee)?.name ??
    assignee.replace(/^agentcore_hub_/, "").split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return full
    .replace(/^CI Validation Agent$/, "CI Agent")
    .split(" ")
    .map((w) => SHORT_WORD[w] ?? w)
    .join(" ");
}

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ─── Component ──────────────────────────────────────────────────────────────

/** Per-ticket slice of the run's agentTasks (from /api/workflow/[id]/tickets). */
export interface TicketTiming {
  agentId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TicketFlowDagProps {
  tickets: JiraTicket[];
  currentTicketId: string;
  /** Per-ticket timing — powers the card's active time. Optional: without it cards show no duration. */
  timings?: Record<string, TicketTiming> | null;
  /** Workflow definition id — orders any def-specific phases after the SDLC ones. */
  workflowDefId?: string | null;
  /** Click a card to refocus the modal on that ticket. */
  onSelect?: (ticketId: string) => void;
}

export default function TicketFlowDag({ tickets, currentTicketId, timings, workflowDefId, onSelect }: TicketFlowDagProps) {
  const epic = tickets.find((t) => t.type === "epic");

  const layout = useMemo(() => {
    const def = getWorkflowDef(workflowDefId);
    const phaseOrder = def.phases.flatMap((p) => [p.agentPhase, ...(p.extraAgentPhases || [])]);
    const flow: FlowTicket[] = tickets.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      assignee: t.assignee,
      blockedBy: t.blockedBy || [],
      phase: t.phase,
      spawnedBy: t.spawnedBy ?? null,
      labels: t.labels,
      createdAt: t.createdAt,
    }));
    return layoutTicketFlow(flow, {
      agentPhaseOf: (id) => ROSTER.get(id)?.phase,
      phaseOrder,
    });
  }, [tickets, workflowDefId]);

  const taskByTicket = useMemo(() => new Map(Object.entries(timings || {})), [timings]);
  const hasLive = layout.nodes.some((n) => {
    const task = taskByTicket.get(n.id);
    return !!task?.startedAt && !task.completedAt && (n.ticket.status === "in_progress" || n.ticket.status === "in_review");
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [hasLive]);

  // Neighbourhood of the focused ticket: it, its blockers, its dependents, and what it filed.
  const related = useMemo(() => {
    const s = new Set<string>([currentTicketId]);
    for (const e of layout.edges) {
      if (e.from === currentTicketId) s.add(e.to);
      if (e.to === currentTicketId) s.add(e.from);
    }
    return s;
  }, [layout, currentTicketId]);

  if (layout.nodes.length === 0 && !epic) return null;
  const M = FLOW_METRICS;
  // Only recede the rest when a ticket ON the graph is focused (not the epic).
  const dimOthers = layout.nodes.some((n) => n.id === currentTicketId);

  const renderCard = (n: FlowNode) => {
    const t = n.ticket;
    const isCur = n.id === currentTicketId;
    const lit = related.has(n.id);
    const task = taskByTicket.get(n.id);
    const live = !!task?.startedAt && !task.completedAt && (t.status === "in_progress" || t.status === "in_review");
    const active = task?.startedAt
      ? (task.completedAt ? Date.parse(task.completedAt) : live ? now : NaN) - Date.parse(task.startedAt)
      : NaN;
    const name = agentName(t.assignee, n.isHuman, t.title);
    const accent = n.isHuman ? NEUTRAL : phaseColor(n.phase);
    const tip = [
      `${t.id} — ${t.title}`,
      `${n.isHuman ? "human gate" : t.assignee ?? "unassigned"} · ${phaseLabel(n.phase)}${n.kind ? ` · ${KIND_LABEL[n.kind]}` : ""}`,
      `${t.status.replace("_", " ")}${Number.isFinite(active) ? ` · ${fmtDur(active)} active` : ""}`,
    ].join("\n");
    return (
      <button
        key={n.id}
        type="button"
        title={tip}
        onClick={() => onSelect?.(n.id)}
        data-ticket-id={n.id}
        aria-current={isCur ? "true" : undefined}
        className={`absolute text-left rounded-md border flex flex-col justify-center gap-px px-1.5 py-[3px] transition-[opacity,box-shadow] duration-150 hover:!opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
          n.kind ? "border-dashed" : ""
        } ${
          isCur
            ? "border-blue-500 bg-blue-500/10 ring-2 ring-blue-500"
            : "border-theme bg-[color-mix(in_srgb,var(--color-surface-2)_85%,transparent)]"
        } ${dimOthers && !isCur && !lit ? "opacity-40" : ""} ${onSelect ? "cursor-pointer" : "cursor-default"}`}
        style={{
          left: n.x,
          top: n.y,
          width: M.nodeW,
          height: M.nodeH,
          borderLeftWidth: 3,
          borderLeftStyle: "solid",
          borderLeftColor: isCur ? "#3b82f6" : accent,
          ...(n.isHuman
            ? { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, rgba(156,163,175,0.18) 3px 5px)" }
            : {}),
        }}
      >
        <span className="flex items-center gap-1.5 min-w-0 leading-[1.15]">
          <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ backgroundColor: STATUS_DOT[t.status] ?? STATUS_DOT.todo }} />
          <span className={`font-mono text-[9px] whitespace-nowrap ${isCur ? "text-blue-600 dark:text-blue-300" : "text-secondary"}`}>{t.id}</span>
          {n.kind && (
            <span
              className={`absolute -top-[7px] right-1.5 text-[7.5px] leading-[11px] px-[5px] rounded-full border whitespace-nowrap bg-surface-1 ${
                n.kind === "advisory"
                  ? "border-theme text-muted"
                  : "border-amber-500/50 text-amber-700 dark:text-amber-300"
              }`}
            >
              {KIND_LABEL[n.kind]}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 min-w-0 leading-[1.15]">
          <span className="text-[9.5px] font-semibold text-primary truncate">{name}</span>
          {Number.isFinite(active) && (
            <span className={`ml-auto shrink-0 text-[8.5px] whitespace-nowrap ${live ? "text-blue-600 dark:text-blue-300" : "text-muted"}`}>
              {fmtDur(active)}{live ? " ●" : ""}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-2">
      {epic && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSelect?.(epic.id)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-mono ${
              epic.id === currentTicketId
                ? "border-blue-500/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300"
            } ${onSelect ? "cursor-pointer" : "cursor-default"}`}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: epic.id === currentTicketId ? (STATUS_DOT[epic.status] ?? NEUTRAL) : "#d946ef" }} />
            {epic.id}
          </button>
          <span className="text-[9px] text-muted">Epic</span>
          {layout.nodes.length > 0 && (
            <span className="ml-auto text-[9px] text-muted">
              {layout.nodes.length} tickets · {layout.nodes.filter((n) => n.ticket.status === "done").length} done
              {layout.fixes ? ` · ${layout.fixes} fix${layout.fixes === 1 ? "" : "es"}` : ""}
            </span>
          )}
        </div>
      )}

      {layout.nodes.length > 0 && (
        <div className="overflow-x-auto overflow-y-hidden pb-2 -mx-1 px-1">
          <div className="relative" style={{ width: layout.width, height: layout.height }} aria-label="Ticket dependency graph" role="img">
            <svg width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible pointer-events-none">
              {layout.edges.map((e) => {
                const hot = e.from === currentTicketId || e.to === currentTicketId;
                const color = hot ? "#3b82f6" : e.resolved ? "#22c55e" : "#ef4444";
                return (
                  <g key={`${e.from}->${e.to}`}>
                    <path d={e.path} fill="none" stroke={color} strokeWidth={hot ? 1.8 : 1.4} strokeDasharray={e.resolved ? undefined : "4 2"} opacity={hot ? 0.95 : 0.5} />
                    <polygon points={e.head} fill={color} opacity={hot ? 0.95 : 0.65} />
                  </g>
                );
              })}
            </svg>

            {layout.captions.map((c) => (
              <div key={c.phase} className="absolute top-0 text-[8.5px] tracking-wider uppercase font-semibold text-muted whitespace-nowrap" style={{ left: c.x, width: c.width }}>
                <span className="block h-[2px] rounded-sm mb-[3px] opacity-85" style={{ backgroundColor: phaseColor(c.phase) }} />
                {phaseLabel(c.phase)}
              </div>
            ))}

            {layout.bandY !== null && (
              <div className="absolute -left-5 -right-5 border-t border-dashed border-theme" style={{ top: layout.bandY }}>
                <span className="absolute left-5 top-[3px] text-[8.5px] tracking-wider uppercase font-semibold text-muted whitespace-nowrap">
                  Rework
                  <span className="ml-1.5 tracking-normal normal-case font-medium">
                    {layout.fixes} fix{layout.fixes === 1 ? "" : "es"}{layout.advisories ? ` · ${layout.advisories} advisor${layout.advisories === 1 ? "y" : "ies"}` : ""}
                  </span>
                </span>
              </div>
            )}

            {layout.nodes.map(renderCard)}
          </div>
        </div>
      )}
    </div>
  );
}
