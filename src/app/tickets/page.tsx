"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Search,
  Clock,
  Bot,
  Cpu,
  Wrench,
  Zap,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Loader2,
  Brain,
  Terminal,
  Activity,
  Database,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getClientRegion } from "@/lib/client-cache";

// --- Types ---

interface SessionItem {
  sessionId: string;
  agentName: string;
  startTime: string;
  endTime: string;
  spanCount: number;
  ticketId?: string;
}

interface TraceSpan {
  id: string;
  event: string;
  name?: string;
  timestamp: string;
  duration?: number; // seconds
  details?: Record<string, unknown>;
}

// --- Helpers ---

function extractTicketId(sessionId: string): string | null {
  // Matches patterns like PROJ-1042, ABC-123, etc. at the start of session ID
  const match = sessionId.match(/^([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  // Handle unix timestamps (milliseconds) or ISO date strings
  const ts = /^\d+$/.test(dateStr) ? parseInt(dateStr, 10) : new Date(dateStr).getTime();
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function getPhaseBadge(agentName: string | undefined): { label: string; color: string } {
  if (!agentName) return { label: "Unknown", color: "bg-gray-600/20 text-gray-400 border-gray-600/30" };
  const lower = agentName.toLowerCase();
  if (lower.includes("requirement")) return { label: "Requirements", color: "bg-orange-600/20 text-orange-400 border-orange-600/30" };
  if (lower.includes("design")) return { label: "Design", color: "bg-purple-600/20 text-purple-400 border-purple-600/30" };
  if (lower.includes("frontend_dev") || lower.includes("backend_dev") || lower.includes("api_dev")) return { label: "Development", color: "bg-green-600/20 text-green-400 border-green-600/30" };
  if (lower.includes("qa") || lower.includes("verif")) return { label: "QA", color: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30" };
  if (lower.includes("security")) return { label: "Security", color: "bg-red-600/20 text-red-400 border-red-600/30" };
  if (lower.includes("ci")) return { label: "CI/CD", color: "bg-cyan-600/20 text-cyan-400 border-cyan-600/30" };
  if (lower.includes("legal") || lower.includes("compliance")) return { label: "Compliance", color: "bg-pink-600/20 text-pink-400 border-pink-600/30" };
  if (lower.includes("locali")) return { label: "Localization", color: "bg-indigo-600/20 text-indigo-400 border-indigo-600/30" };
  if (lower.includes("analytics")) return { label: "Analytics", color: "bg-teal-600/20 text-teal-400 border-teal-600/30" };
  if (lower.includes("dev")) return { label: "Development", color: "bg-green-600/20 text-green-400 border-green-600/30" };
  return { label: "Agent", color: "bg-blue-600/20 text-blue-400 border-blue-600/30" };
}

function formatAgentName(raw: string | undefined): string {
  if (!raw) return "Unknown Agent";
  // Strip ".DEFAULT" suffix and "agentcore_hub_" prefix from OTEL service name
  return raw.replace(/\.DEFAULT$/i, "").replace(/^agentcore_hub_/i, "").replace(/_/g, " ");
}

// --- Trace event config (reused pattern from agent detail) ---

const traceEventConfig: Record<string, { icon: typeof Terminal; color: string; label: string }> = {
  agent_invoke: { icon: Bot, color: "text-brand-400", label: "Agent Invoke" },
  model_call: { icon: Brain, color: "text-blue-400", label: "LLM Call" },
  tool_call: { icon: Wrench, color: "text-purple-400", label: "Tool Call" },
  cycle: { icon: Activity, color: "text-cyan-400", label: "Cycle" },
  request: { icon: Zap, color: "text-brand-400", label: "Request" },
  service_call: { icon: Database, color: "text-gray-400", label: "Service Call" },
  http: { icon: Server, color: "text-gray-500", label: "HTTP" },
  internal: { icon: Cpu, color: "text-gray-600", label: "Internal" },
  span: { icon: Activity, color: "text-gray-400", label: "Span" },
  user_input: { icon: Terminal, color: "text-blue-400", label: "User Input" },
  message_start: { icon: Brain, color: "text-blue-400", label: "Thinking" },
  tool_start: { icon: Terminal, color: "text-purple-400", label: "Tool Call" },
  block_stop: { icon: Zap, color: "text-gray-500", label: "Block Complete" },
  response: { icon: Bot, color: "text-green-400", label: "Response" },
  usage: { icon: Cpu, color: "text-cyan-400", label: "Token Usage" },
  error: { icon: AlertCircle, color: "text-red-400", label: "Error" },
  trace: { icon: Activity, color: "text-gray-400", label: "Trace" },
};

function getSpanColor(event: string): string {
  if (event === "tool_call" || event === "tool_start") return "border-l-purple-500";
  if (event === "model_call" || event === "message_start") return "border-l-blue-500";
  if (event === "service_call" || event === "http") return "border-l-gray-500";
  if (event === "error") return "border-l-red-500";
  return "border-l-gray-700";
}

// --- Main Page Component ---

export default function TicketHistoryPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [traceSpans, setTraceSpans] = useState<TraceSpan[]>([]);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);

  // Fetch sessions on mount
  useEffect(() => {
    const region = getClientRegion();
    fetch("/api/agentcore/traces/sessions", {
      headers: { "x-aws-region": region },
    })
      .then((r) => r.json())
      .then((data) => {
        setSessions(data.sessions || []);
      })
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, []);

  // Filter sessions — single source of truth for both count and list
  const q = searchQuery.trim().toLowerCase();
  const displaySessions: SessionItem[] = (() => {
    // Step 1: Filter
    const filtered = q
      ? sessions.filter((s) => {
          const text = [
            s.sessionId,
            s.agentName,
            s.ticketId,
            extractTicketId(s.sessionId),
            getPhaseBadge(s.agentName).label,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return text.includes(q);
        })
      : sessions;

    // Step 2: Sort by most recent
    const sorted = [...filtered].sort(
      (a, b) => parseInt(b.startTime || "0", 10) - parseInt(a.startTime || "0", 10)
    );

    // Step 3: Group by ticket
    const ticketGroups = new Map<string, SessionItem[]>();
    const noTicket: SessionItem[] = [];
    for (const session of sorted) {
      const ticket = extractTicketId(session.sessionId);
      if (ticket) {
        if (!ticketGroups.has(ticket)) ticketGroups.set(ticket, []);
        ticketGroups.get(ticket)!.push(session);
      } else {
        noTicket.push(session);
      }
    }
    const groupEntries = [...ticketGroups.entries()].sort((a, b) => {
      const aTime = parseInt(a[1][0].startTime || "0", 10);
      const bTime = parseInt(b[1][0].startTime || "0", 10);
      return bTime - aTime;
    });
    const result: SessionItem[] = [];
    for (const [, group] of groupEntries) {
      result.push(...group);
    }
    result.push(...noTicket);
    return result;
  })();

  // Fetch trace detail when a session is selected
  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setTraceSpans([]);
    setLoadingTrace(true);
    setExpandedSpanId(null);

    const region = getClientRegion();
    fetch(`/api/agentcore/traces?session_id=${sessionId}`, {
      headers: { "x-aws-region": region },
    })
      .then((r) => r.json())
      .then((data) => {
        setTraceSpans(data.traces || []);
      })
      .catch(() => setTraceSpans([]))
      .finally(() => setLoadingTrace(false));
  }, []);

  // Compute summary for selected session
  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId);
  const traceSummary = useMemo(() => {
    if (traceSpans.length === 0) return null;
    let totalDuration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const span of traceSpans) {
      if (span.duration) totalDuration += span.duration;
      const details = span.details;
      if (details) {
        if (typeof details.inputTokens === "number") totalInputTokens += details.inputTokens;
        if (typeof details.outputTokens === "number") totalOutputTokens += details.outputTokens;
        if (typeof details.tokensIn === "number") totalInputTokens += details.tokensIn;
        if (typeof details.tokensOut === "number") totalOutputTokens += details.tokensOut;
      }
    }
    return { totalDuration, totalInputTokens, totalOutputTokens };
  }, [traceSpans]);

  return (
    <div className="flex h-[calc(100vh-6rem)] gap-0 overflow-hidden">
      {/* Left Panel - Sessions List */}
      <div className="w-[380px] flex-shrink-0 flex flex-col border-r border-surface-4 bg-surface-1">
        {/* Header */}
        <div className="p-4 border-b border-surface-4">
          <h1 className="text-lg font-semibold text-white mb-3">Ticket History</h1>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by ticket, agent, stage..."
              className="w-full bg-surface-2 border border-surface-4 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-brand-500/50"
            />
            {searchQuery.trim() && (
              <p className="mt-1.5 text-[10px] text-gray-500">
                {displaySessions.length} of {sessions.length} sessions
              </p>
            )}
          </div>
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loadingSessions ? (
            <div className="flex flex-col items-center justify-center h-48">
              <Loader2 className="w-5 h-5 text-brand-400 animate-spin mb-2" />
              <p className="text-xs text-gray-500">Loading sessions...</p>
            </div>
          ) : displaySessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4">
              <Clock className="w-8 h-8 text-gray-700 mb-3" />
              <p className="text-sm text-gray-500">
                {searchQuery ? "No sessions match your search." : "No sessions found."}
              </p>
            </div>
          ) : (
            displaySessions.map((session, idx) => {
              const ticketId = extractTicketId(session.sessionId);
              const prevTicketId = idx > 0 ? extractTicketId(displaySessions[idx - 1].sessionId) : null;
              const showGroupHeader = ticketId && ticketId !== prevTicketId;
              const phase = getPhaseBadge(session.agentName);
              const isSelected = selectedSessionId === session.sessionId;

              return (
                <div key={`${session.sessionId}_${session.agentName}_${idx}`}>
                  {showGroupHeader && (
                    <div className="px-2 pt-4 pb-1 flex items-center gap-2">
                      <span className="text-xs font-bold text-white">
                        {ticketId}
                      </span>
                      <div className="flex-1 border-t border-surface-4" />
                    </div>
                  )}
                  <button
                    onClick={() => selectSession(session.sessionId)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg transition-all",
                      isSelected
                        ? "bg-brand-600/20 border border-brand-600/30"
                        : "hover:bg-surface-2 border border-transparent"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", phase.color)}>
                          {phase.label}
                        </span>
                      </div>
                      <span className="text-[10px] text-gray-500 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        {timeAgo(session.startTime)}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Bot className="w-3 h-3 text-gray-500 flex-shrink-0" />
                      <span className="text-xs text-gray-300 truncate">
                        {formatAgentName(session.agentName)}
                      </span>
                      {session.spanCount > 0 && (
                        <span className="text-[10px] text-gray-600 ml-auto flex-shrink-0">
                          {session.spanCount} spans
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Panel - Trace Detail */}
      <div className="flex-1 flex flex-col min-w-0 bg-surface-1">
        {!selectedSessionId ? (
          // Empty state
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-surface-4 flex items-center justify-center mb-4">
              <Activity className="w-8 h-8 text-gray-700" />
            </div>
            <p className="text-sm text-gray-400 mb-1">Select a session to view trace details</p>
            <p className="text-xs text-gray-600">Click on a session from the left panel to inspect its execution trace.</p>
          </div>
        ) : (
          <>
            {/* Agent Info Card */}
            <div className="p-4 border-b border-surface-4">
              <div className="bg-surface-2 rounded-xl border border-surface-4 p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-600/20 flex items-center justify-center">
                    <Bot className="w-5 h-5 text-brand-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-white">
                      {selectedSession?.agentName || "Agent"}
                    </h3>
                    <p className="text-[10px] text-gray-500 font-mono truncate">
                      {selectedSessionId}
                    </p>
                  </div>
                  {extractTicketId(selectedSessionId) && (
                    <span className="text-xs font-semibold text-brand-400 bg-brand-600/10 border border-brand-600/30 px-2 py-0.5 rounded">
                      {extractTicketId(selectedSessionId)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-4 gap-4">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Start Time</p>
                    <p className="text-xs text-gray-300">
                      {selectedSession?.startTime
                        ? new Date(parseInt(selectedSession.startTime, 10)).toLocaleString()
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Duration</p>
                    <p className="text-xs text-gray-300">
                      {traceSummary && traceSummary.totalDuration > 0
                        ? `${traceSummary.totalDuration.toFixed(1)}s`
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Input Tokens</p>
                    <p className="text-xs text-gray-300">
                      {traceSummary && traceSummary.totalInputTokens > 0
                        ? traceSummary.totalInputTokens.toLocaleString()
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Output Tokens</p>
                    <p className="text-xs text-gray-300">
                      {traceSummary && traceSummary.totalOutputTokens > 0
                        ? traceSummary.totalOutputTokens.toLocaleString()
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Trace Timeline */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="w-4 h-4 text-gray-500" />
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Trace Timeline
                </h3>
                <span className="text-[10px] text-gray-600">
                  {traceSpans.length} span{traceSpans.length !== 1 ? "s" : ""}
                </span>
              </div>

              {loadingTrace ? (
                <div className="flex flex-col items-center justify-center h-48">
                  <Loader2 className="w-5 h-5 text-brand-400 animate-spin mb-2" />
                  <p className="text-xs text-gray-500">Loading trace data...</p>
                </div>
              ) : traceSpans.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center">
                  <Terminal className="w-8 h-8 text-gray-700 mb-3" />
                  <p className="text-sm text-gray-500">No trace spans found for this session.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {traceSpans.map((span) => {
                    const config = traceEventConfig[span.event] || {
                      icon: Zap,
                      color: "text-gray-400",
                      label: span.event,
                    };
                    const Icon = config.icon;
                    const isExpanded = expandedSpanId === span.id;
                    const borderColor = getSpanColor(span.event);

                    return (
                      <div
                        key={span.id}
                        className={cn(
                          "rounded-lg overflow-hidden bg-surface-2 border border-surface-4 border-l-2",
                          borderColor
                        )}
                      >
                        <button
                          onClick={() => setExpandedSpanId(isExpanded ? null : span.id)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-surface-3/50 transition-colors text-left"
                        >
                          {span.details ? (
                            isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
                            )
                          ) : (
                            <span className="w-3.5 h-3.5 flex-shrink-0" />
                          )}
                          <Icon className={cn("w-4 h-4 flex-shrink-0", config.color)} />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-gray-300 truncate block">
                              {span.name || config.label}
                            </span>
                          </div>
                          {span.duration !== undefined && span.duration > 0 && (
                            <span className="text-[10px] text-gray-500 bg-surface-3 px-2 py-0.5 rounded-full flex-shrink-0">
                              {span.duration >= 1
                                ? `${span.duration.toFixed(1)}s`
                                : `${Math.round(span.duration * 1000)}ms`}
                            </span>
                          )}
                        </button>

                        {isExpanded && span.details && (
                          <div className="px-4 pb-3 border-t border-surface-4/50">
                            <pre className="text-[10px] text-gray-500 mt-2 font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                              {JSON.stringify(span.details, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
