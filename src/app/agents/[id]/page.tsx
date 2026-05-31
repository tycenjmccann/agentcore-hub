"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft, Bot, Brain, Cpu, Server, Wrench, Send, User, Plus, Clock,
  MessageSquare, Loader2, Terminal, Zap, ChevronRight, ChevronDown,
  Activity, CheckCircle2, Database, Code2, Play, AlertTriangle, ExternalLink, RefreshCw,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamAgentInvocation, AgentInfo, TraceEvent } from "@/lib/agentcore-stream";
import { cachedFetch, getCached, getClientRegion } from "@/lib/client-cache";

interface AgentDetail {
  id: string;
  name: string;
  arn: string;
  type: "harness" | "runtime";
  status: string;
  createdAt?: string;
  updatedAt?: string;
  memoryId?: string | null;
  logGroup?: string | null;
  model?: string;
  systemPrompt?: string;
  tools?: Array<{ type: string; name?: string }>;
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
  agent_name?: string;
}

interface Session {
  sessionId: string;
  actorId: string;
  createdAt: string;
}

interface TraceStep {
  id: string;
  event: string;
  name?: string;
  timestamp: string;
  duration?: number; // seconds
  details?: Record<string, unknown>;
}

interface TraceDiagnostics {
  matchMode: "anchored" | "fallback" | "none";
  queryStatus: "complete" | "timeout" | "failed";
  logGroupMissing?: boolean;
  sessionIdPropagationMissing?: boolean;
}

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const { id: agentId } = params;
  const cacheKey = `/api/agentcore/agents?id=${agentId}`;
  const [agent, setAgent] = useState<AgentDetail | null>(() => getCached<AgentDetail>(cacheKey));
  const [loading, setLoading] = useState(!getCached(cacheKey));

  useEffect(() => {
    cachedFetch<AgentDetail>(cacheKey)
      .then((data) => setAgent((data as any).error ? null : data))
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, [agentId, cacheKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <Link href="/agents" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300">
          <ArrowLeft className="w-4 h-4" /> Back to Agents
        </Link>
        <div className="card text-center py-8">
          <p className="text-sm text-gray-400">Agent not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/agents" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300">
        <ArrowLeft className="w-4 h-4" /> Back to Agents
      </Link>

      {/* Account-wide trace pipeline health */}
      <TraceHealthBanner />

      {/* Compact Agent Info Header */}
      <AgentInfoHeader agent={agent} />

      {/* Invoke UI - Sessions | Chat | Logs */}
      <InvokeUI agent={agent} />
    </div>
  );
}

function AgentInfoHeader({ agent }: { agent: AgentDetail }) {
  const [expanded, setExpanded] = useState(false);


  return (
    <div className="card !py-3 !px-4">
      <div className="flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
          agent.type === "harness" ? "bg-brand-600/20" : "bg-purple-600/20"
        }`}>
          {agent.type === "harness" ? (
            <Brain className="w-5 h-5 text-brand-400" />
          ) : (
            <Cpu className="w-5 h-5 text-purple-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white">{agent.name}</h2>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              agent.type === "harness"
                ? "bg-brand-600/10 text-brand-400 border-brand-600/30"
                : "bg-purple-600/10 text-purple-400 border-purple-600/30"
            }`}>
              {agent.type.toUpperCase()}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              agent.status === "ACTIVE" || agent.status === "READY"
                ? "bg-green-400/10 text-green-400 border-green-400/30"
                : "bg-gray-400/10 text-gray-400 border-gray-400/30"
            }`}>
              {agent.status}
            </span>
          </div>
          <p className="text-[10px] text-gray-600 font-mono">{agent.arn}</p>
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Details
        </button>
      </div>


      {expanded && (
        <div className="mt-3 pt-3 border-t border-surface-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          {agent.model && (
            <div>
              <span className="text-gray-500 flex items-center gap-1"><Bot className="w-3 h-3" /> Model</span>
              <p className="text-gray-300 mt-0.5 font-mono text-[10px]">{agent.model}</p>
            </div>
          )}
          {agent.memoryId && (
            <div>
              <span className="text-gray-500 flex items-center gap-1"><Database className="w-3 h-3" /> Memory</span>
              <p className="text-gray-300 mt-0.5 font-mono text-[10px] truncate">{agent.memoryId}</p>
            </div>
          )}
          {agent.logGroup && (
            <div>
              <span className="text-gray-500 flex items-center gap-1"><Terminal className="w-3 h-3" /> Log Group</span>
              <p className="text-gray-300 mt-0.5 font-mono text-[10px] truncate">{agent.logGroup}</p>
            </div>
          )}
          {agent.createdAt && (
            <div>
              <span className="text-gray-500">Created</span>
              <p className="text-gray-300 mt-0.5">{new Date(agent.createdAt).toLocaleDateString()}</p>
            </div>
          )}
          {agent.tools && agent.tools.length > 0 && (
            <div className="col-span-full">
              <span className="text-gray-500 flex items-center gap-1 mb-1.5"><Wrench className="w-3 h-3" /> Tools ({agent.tools.length})</span>
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((tool, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 bg-surface-3 rounded border border-surface-4 text-gray-300">
                    <Server className="w-2.5 h-2.5 inline mr-0.5" />
                    {tool.name || tool.type}
                  </span>
                ))}
              </div>
            </div>
          )}
          {agent.systemPrompt && (
            <div className="col-span-full">
              <span className="text-gray-500">System Prompt</span>
              <pre className="text-[10px] text-gray-400 mt-1 bg-surface-0 rounded p-2 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto">
                {agent.systemPrompt}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MemoryOption {
  id: string;
  status: string;
}

function InvokeUI({ agent }: { agent: AgentDetail }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [traceSessions, setTraceSessions] = useState<Session[]>([]);
  const [sessionSource, setSessionSource] = useState<"memory" | "traces">(agent.memoryId ? "memory" : "traces");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [availableMemories, setAvailableMemories] = useState<MemoryOption[]>([]);
  const [linkedMemory, setLinkedMemory] = useState<string>(agent.memoryId || "");
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceDiagnostics, setTraceDiagnostics] = useState<TraceDiagnostics | null>(null);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "active" | "complete">("idle");
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  // AgentCore InvokeAgentRuntime/InvokeHarness require session IDs >= 33 chars.
  // Sessions with shorter IDs (legacy data, direct-script invocations) can be viewed but not continued.
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [invokeMode, setInvokeMode] = useState<"chat" | "playground">("chat");
  const [playgroundPayload, setPlaygroundPayload] = useState(() => {
    if (agent.type === "runtime") {
      return JSON.stringify({ prompt: "Hello" }, null, 2);
    }
    return JSON.stringify({ prompt: "", sessionId: "", history: [] }, null, 2);
  });
  const [playgroundResponse, setPlaygroundResponse] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const traceEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!sessionId) {
      setSessionId(`sess_${crypto.randomUUID().replace(/-/g, "")}${Date.now()}`);
    }
  }, [sessionId]);

  // Fetch available memories for the selector
  useEffect(() => {
    fetch("/api/agentcore/memory/mapping", { headers: { "x-aws-region": getClientRegion() } })
      .then((r) => r.json())
      .then((data) => {
        setAvailableMemories(data.memories || []);
        // If there's a saved mapping for this agent, use it
        if (data.mappings?.[agent.id]) {
          setLinkedMemory(data.mappings[agent.id]);
        }
      })
      .catch(() => {});
  }, [agent.id]);

  const refreshSessions = useCallback(() => {
    fetch(`/api/agentcore/memory/sessions?agent_id=${agent.id}`, { headers: { "x-aws-region": getClientRegion() } })
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => {});
  }, [agent.id]);

  // Load memory sessions
  useEffect(() => {
    setLoadingSessions(true);
    fetch(`/api/agentcore/memory/sessions?agent_id=${agent.id}`, { headers: { "x-aws-region": getClientRegion() } })
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, [agent.id]);

  // Load trace-based sessions
  useEffect(() => {
    fetch(`/api/agentcore/traces/sessions?agent_id=${agent.id}`, { headers: { "x-aws-region": getClientRegion() } })
      .then((r) => r.json())
      .then((data) => setTraceSessions(data.sessions || []))
      .catch(() => setTraceSessions([]));
  }, [agent.id]);

  useEffect(() => {
    if (sessionStatus !== "active" || !sessionStartTime) return;
    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - sessionStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionStatus, sessionStartTime]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [traceSteps]);

  const handleMemoryChange = useCallback(async (memoryId: string) => {
    setLinkedMemory(memoryId);
    // Persist the mapping server-side
    await fetch("/api/agentcore/memory/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
      body: JSON.stringify({ agentId: agent.id, memoryId: memoryId || null }),
    });
    // Re-fetch sessions with the new memory
    setLoadingSessions(true);
    fetch(`/api/agentcore/memory/sessions?agent_id=${agent.id}`, { headers: { "x-aws-region": getClientRegion() } })
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, [agent.id]);

  const startNewSession = useCallback(() => {
    setSessionId(`sess_${crypto.randomUUID().replace(/-/g, "")}${Date.now()}`);
    setMessages([]);
    setTraceSteps([]);
    setTraceDiagnostics(null);
    setSessionStatus("idle");
    setSessionStartTime(null);
    setElapsedTime(0);
    setIsReadOnly(false);
  }, []);

  const resumeSession = useCallback(async (session: Session) => {
    // Keep the original session ID. If it's too short for AgentCore's invoke API (<33 chars),
    // we still load history but lock the chat — sending would either fail server-side or
    // silently fork into a new session, orphaning the loaded history.
    setSessionId(session.sessionId);
    setIsReadOnly(session.sessionId.length < 33);
    setLoadingHistory(true);
    setMessages([]);
    setTraceSteps([]);
    setTraceDiagnostics(null);
    setSessionStatus("complete");
    setSessionStartTime(null);
    setElapsedTime(0);

    try {
      const regionHeaders = { "x-aws-region": getClientRegion() };
      const [messagesRes, tracesRes] = await Promise.all([
        fetch(`/api/agentcore/memory/events?agent_id=${agent.id}&session_id=${session.sessionId}&actor_id=${session.actorId}`, { headers: regionHeaders }),
        fetch(`/api/agentcore/traces?session_id=${session.sessionId}&agent_id=${agent.id}`, { headers: regionHeaders }),
      ]);

      const messagesData = await messagesRes.json();
      const tracesData = await tracesRes.json();

      const rawMessages = messagesData.messages || [];
      const history: ChatMessage[] = rawMessages.map(
        (m: { role: string; content: string; timestamp: string }, i: number) => ({
          id: `hist_${i}`,
          role: m.role === "user" ? "user" : "agent",
          content: m.content,
          timestamp: m.timestamp,
          agent_name: m.role === "assistant" ? agent.name : undefined,
        })
      );
      setMessages(history);

      const persistedTraces = tracesData.traces || [];
      setTraceSteps(persistedTraces);
      setTraceDiagnostics(tracesData.diagnostics || null);
    } catch {
      // Failed to load history
    } finally {
      setLoadingHistory(false);
    }
  }, [agent.id, agent.name]);

  const resumeTraceSession = useCallback(async (session: Session) => {
    setSessionId(session.sessionId);
    setIsReadOnly(session.sessionId.length < 33);
    setLoadingHistory(true);
    setMessages([]);
    setTraceSteps([]);
    setTraceDiagnostics(null);
    setSessionStatus("complete");
    setSessionStartTime(null);
    setElapsedTime(0);

    try {
      const regionHeaders = { "x-aws-region": getClientRegion() };
      const tracesRes = await fetch(
        `/api/agentcore/traces?session_id=${session.sessionId}&agent_id=${agent.id}`,
        { headers: regionHeaders }
      );
      const tracesData = await tracesRes.json();
      setTraceSteps(tracesData.traces || []);
      setTraceDiagnostics(tracesData.diagnostics || null);
    } catch {
      // Failed to load traces
    } finally {
      setLoadingHistory(false);
    }
  }, [agent.id]);

  const storeInMemory = useCallback(
    (userMsg: string, assistantMsg: string) => {
      fetch("/api/agentcore/memory/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
        body: JSON.stringify({
          agent_id: agent.id,
          session_id: sessionId,
          user_message: userMsg,
          assistant_message: assistantMsg,
        }),
      })
        .then(() => refreshSessions())
        .catch(() => {});
    },
    [agent.id, sessionId, refreshSessions]
  );

  const persistTraces = useCallback(
    (traces: TraceStep[]) => {
      if (!sessionId || traces.length === 0) return;
      fetch("/api/agentcore/traces", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
        body: JSON.stringify({ session_id: sessionId, traces }),
      }).catch(() => {});
    },
    [sessionId]
  );

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming || isReadOnly) return;

    const userText = input;
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: userText,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);
    setSessionStatus("active");
    if (!sessionStartTime) setSessionStartTime(Date.now());

    const userTraceStep: TraceStep = {
      id: `trace_${Date.now()}`,
      event: "user_input",
      name: userText.slice(0, 60) + (userText.length > 60 ? "..." : ""),
      timestamp: new Date().toISOString(),
    };
    setTraceSteps((prev) => [...prev, userTraceStep]);
    const turnTraces: TraceStep[] = [userTraceStep];

    const agentMsgId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      { id: agentMsgId, role: "agent", content: "", timestamp: new Date().toISOString(), agent_name: agent.name },
    ]);

    let fullResponse = "";
    const history = messages
      .filter((m) => m.content.trim() && !m.content.startsWith("Error:"))
      .map((m) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      }));

    const agentInfo: AgentInfo = {
      id: agent.id,
      name: agent.name,
      arn: agent.arn,
      isHarness: agent.type === "harness",
      status: agent.status,
    };

    try {
      await streamAgentInvocation({
        agentId: agent.id,
        agentArn: agent.arn,
        isHarness: agent.type === "harness",
        prompt: userText,
        sessionId,
        systemPrompt: agent.systemPrompt,
        history,
        onChunk: (chunk) => {
          fullResponse += chunk;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === agentMsgId ? { ...msg, content: msg.content + chunk } : msg
            )
          );
        },
        onTrace: (trace: TraceEvent) => {
          const step: TraceStep = {
            id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            event: trace.event,
            name: trace.name,
            timestamp: trace.timestamp,
            details: trace.inputTokens ? { inputTokens: trace.inputTokens, outputTokens: trace.outputTokens } : undefined,
          };
          turnTraces.push(step);
          setTraceSteps((prev) => [...prev, step]);
        },
        onDone: () => {
          setIsStreaming(false);
          setSessionStatus("complete");
          storeInMemory(userText, fullResponse);
          const doneStep: TraceStep = {
            id: `trace_done_${Date.now()}`,
            event: "response",
            name: `Response complete (${fullResponse.length} chars)`,
            timestamp: new Date().toISOString(),
          };
          turnTraces.push(doneStep);
          setTraceSteps((prev) => [...prev, doneStep]);
          persistTraces(turnTraces);
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === agentMsgId ? { ...msg, content: `Error: ${err.message}` } : msg
            )
          );
          setIsStreaming(false);
          setTraceSteps((prev) => [...prev, {
            id: `trace_err_${Date.now()}`,
            event: "error",
            name: err.message,
            timestamp: new Date().toISOString(),
          }]);
        },
      });
    } catch {
      setIsStreaming(false);
    }
  }, [input, isStreaming, isReadOnly, agent, sessionId, storeInMemory, persistTraces, messages, sessionStartTime]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    const lineHeight = 20; // approx line height in px
    const maxHeight = lineHeight * 6; // 6 lines max
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  // Playground: send raw JSON payload
  const handlePlaygroundSend = useCallback(async () => {
    if (isStreaming || isReadOnly) return;
    let payload;
    try {
      payload = JSON.parse(playgroundPayload);
    } catch {
      setPlaygroundResponse("Error: Invalid JSON payload");
      return;
    }

    setIsStreaming(true);
    setPlaygroundResponse("");
    setSessionStatus("active");
    if (!sessionStartTime) setSessionStartTime(Date.now());

    // Send the raw payload as-is — the invoke route passes it directly to the agent
    const body = {
      agentRuntimeArn: agent.arn,
      agentId: agent.id,
      isHarness: agent.type === "harness",
      sessionId,
      rawPayload: payload,
    };

    try {
      const response = await fetch("/api/agentcore/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-aws-region": getClientRegion() },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setPlaygroundResponse(`Error ${response.status}: ${response.statusText}\n${await response.text()}`);
        setIsStreaming(false);
        setSessionStatus("complete");
        return;
      }

      if (!response.body) {
        setPlaygroundResponse("Error: No response body");
        setIsStreaming(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "text" && parsed.content) {
                fullText += parsed.content;
                setPlaygroundResponse(fullText);
              } else if (parsed.type === "trace") {
                const step: TraceStep = {
                  id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  event: parsed.event,
                  name: parsed.name,
                  timestamp: parsed.timestamp,
                };
                setTraceSteps((prev) => [...prev, step]);
              } else if (parsed.type === "done") {
                break;
              }
            } catch { /* skip unparseable */ }
          }
        }
      }

      setPlaygroundResponse(fullText || "(empty response)");
    } catch (err) {
      setPlaygroundResponse(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setIsStreaming(false);
      setSessionStatus("complete");
      // Fetch real OTEL traces from aws/spans after invocation completes
      fetchOtelTraces(sessionId);
    }
  }, [playgroundPayload, isStreaming, isReadOnly, agent, sessionId, sessionStartTime]);

  // Poll aws/spans for real OTEL traces (propagation can take 5-30s)
  const fetchOtelTraces = useCallback(async (sid: string) => {
    const regionHeaders = { "x-aws-region": getClientRegion() };
    // Try up to 4 times with increasing delays (5s, 10s, 15s, 20s)
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
      try {
        const res = await fetch(
          `/api/agentcore/traces?session_id=${sid}&agent_id=${agent.id}`,
          { headers: regionHeaders }
        );
        const data = await res.json();
        if (data.traces && data.traces.length > 0) {
          setTraceSteps(data.traces);
          setTraceDiagnostics(data.diagnostics || null);
          return;
        }
        // Surface diagnostics even when traces are empty — e.g. logGroupMissing tells the user
        // Transaction Search isn't enabled, no point continuing to poll
        if (data.diagnostics) {
          setTraceDiagnostics(data.diagnostics);
          if (data.diagnostics.logGroupMissing) return;
        }
      } catch {
        // Retry
      }
    }
  }, [agent.id]);

  function timeAgo(dateStr: string): string {
    if (!dateStr) return "";
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  const traceEventConfig: Record<string, { icon: typeof Terminal; color: string; label: string }> = {
    // Real OTEL span events from aws/spans
    agent_invoke: { icon: Bot, color: "text-brand-400", label: "Agent Invoke" },
    model_call: { icon: Brain, color: "text-purple-400", label: "LLM Call" },
    tool_call: { icon: Wrench, color: "text-yellow-400", label: "Tool" },
    cycle: { icon: Activity, color: "text-cyan-400", label: "Cycle" },
    request: { icon: Zap, color: "text-brand-400", label: "Request" },
    service_call: { icon: Database, color: "text-gray-400", label: "Service" },
    http: { icon: Server, color: "text-gray-500", label: "HTTP" },
    internal: { icon: Cpu, color: "text-gray-600", label: "Internal" },
    span: { icon: Activity, color: "text-gray-400", label: "Span" },
    // Streaming / real-time events
    user_input: { icon: User, color: "text-blue-400", label: "User Input" },
    message_start: { icon: Brain, color: "text-purple-400", label: "Thinking" },
    tool_start: { icon: Terminal, color: "text-yellow-400", label: "Tool Call" },
    block_stop: { icon: Zap, color: "text-gray-500", label: "Block Complete" },
    response: { icon: Bot, color: "text-green-400", label: "Response" },
    usage: { icon: Cpu, color: "text-cyan-400", label: "Token Usage" },
    error: { icon: Terminal, color: "text-red-400", label: "Error" },
    trace: { icon: Activity, color: "text-gray-400", label: "Trace" },
  };

  return (
    <div className="flex h-[calc(100vh-16rem)] gap-4 overflow-hidden">
      {/* Left — Sessions */}
      <div className="w-52 flex-shrink-0 flex flex-col border-r border-surface-4 pr-3">
        <button
          onClick={startNewSession}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-600/20 border border-brand-600/30 text-brand-400 text-xs font-medium hover:bg-brand-600/30 transition-colors mb-3"
        >
          <Plus className="w-3 h-3" />
          New Session
        </button>

        {/* Source Toggle */}
        <div className="flex items-center gap-1 mb-2 p-0.5 bg-surface-3 rounded-lg">
          <button
            onClick={() => setSessionSource("memory")}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
              sessionSource === "memory"
                ? "bg-surface-1 text-brand-400 shadow-sm"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            <Database className="w-2.5 h-2.5" />
            Memory
          </button>
          <button
            onClick={() => setSessionSource("traces")}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
              sessionSource === "traces"
                ? "bg-surface-1 text-brand-400 shadow-sm"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            <Terminal className="w-2.5 h-2.5" />
            Traces
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-medium mb-1">
            {sessionSource === "memory" ? "History" : "Trace Sessions"}
          </p>
          {loadingSessions ? (
            <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading...
            </div>
          ) : (sessionSource === "memory" ? sessions : traceSessions).length === 0 ? (
            <p className="text-xs text-gray-600 py-2">
              {sessionSource === "memory" ? "No previous sessions" : "No trace sessions found"}
            </p>
          ) : (
            (sessionSource === "memory" ? sessions : traceSessions).map((session) => (
              <button
                key={session.sessionId}
                onClick={() => sessionSource === "memory" ? resumeSession(session) : resumeTraceSession(session)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${
                  sessionId === session.sessionId
                    ? "bg-brand-600/20 border border-brand-600/30 text-brand-300"
                    : "hover:bg-surface-3 text-gray-400"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {sessionSource === "memory"
                    ? <MessageSquare className="w-2.5 h-2.5 flex-shrink-0" />
                    : <Terminal className="w-2.5 h-2.5 flex-shrink-0" />
                  }
                  <span className="truncate font-mono text-[10px]">
                    {session.sessionId.length > 16 ? session.sessionId.slice(0, 16) + "..." : session.sessionId}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-0.5 text-gray-600 text-[10px]">
                  <Clock className="w-2 h-2" />
                  <span>{timeAgo(session.createdAt)}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Memory Selector */}
        <div className="mt-3 pt-3 border-t border-surface-4">
          <label className="text-[10px] text-gray-500 uppercase tracking-wide font-medium flex items-center gap-1 mb-1.5">
            <Database className="w-3 h-3" /> Memory
          </label>
          <select
            value={linkedMemory}
            onChange={(e) => handleMemoryChange(e.target.value)}
            className="w-full bg-surface-3 border border-surface-4 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono focus:outline-none focus:border-brand-600/50"
          >
            <option value="">None</option>
            {availableMemories.map((mem) => (
              <option key={mem.id} value={mem.id}>
                {mem.id.replace(/-[A-Za-z0-9]{10,}$/, "")}
              </option>
            ))}
          </select>
          {linkedMemory && (
            <p className="text-[9px] text-gray-600 mt-1 truncate">{linkedMemory}</p>
          )}
        </div>
      </div>

      {/* Center — Chat / Playground */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with mode toggle */}
        <div className="flex items-center justify-between mb-2 pb-2 border-b border-surface-4">
          <div className="flex items-center gap-3">
            {/* Mode toggle */}
            <div className="flex items-center gap-0.5 p-0.5 bg-surface-3 rounded-lg">
              <button
                onClick={() => setInvokeMode("chat")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  invokeMode === "chat"
                    ? "bg-surface-1 text-brand-400 shadow-sm"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                <MessageSquare className="w-3 h-3" />
                Chat
              </button>
              <button
                onClick={() => setInvokeMode("playground")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  invokeMode === "playground"
                    ? "bg-surface-1 text-brand-400 shadow-sm"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                <Code2 className="w-3 h-3" />
                Playground
              </button>
            </div>
            <p className="text-[10px] text-gray-600 font-mono">{sessionId ? sessionId.slice(0, 24) + "..." : "..."}</p>
          </div>
          <div className="flex items-center gap-2">
            {sessionStatus === "active" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-600/10 border border-green-600/30">
                <Activity className="w-3 h-3 text-green-400 animate-pulse" />
                <span className="text-[10px] text-green-400 font-medium">Active</span>
                {elapsedTime > 0 && (
                  <span className="text-[10px] text-green-500/70 font-mono">
                    {elapsedTime >= 60 ? `${Math.floor(elapsedTime / 60)}m ${elapsedTime % 60}s` : `${elapsedTime}s`}
                  </span>
                )}
              </span>
            )}
            {sessionStatus === "complete" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-3 border border-surface-4">
                <CheckCircle2 className="w-3 h-3 text-gray-500" />
                <span className="text-[10px] text-gray-500 font-medium">Complete</span>
              </span>
            )}
          </div>
        </div>

        {invokeMode === "chat" ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin space-y-4 pb-4">
              {loadingHistory ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 text-brand-400 animate-spin mb-2" />
                  <p className="text-sm text-gray-500">Loading session history...</p>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <Bot className="w-10 h-10 text-gray-600 mb-3" />
                  <p className="text-sm text-gray-500">Send a message to start chatting with {agent.name}.</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`flex gap-3 min-w-0 ${msg.role === "user" ? "justify-end" : ""}`}>
                    {msg.role === "agent" && (
                      <div className="w-7 h-7 bg-brand-600/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                        <Bot className="w-3.5 h-3.5 text-brand-400" />
                      </div>
                    )}
                    <div className={`max-w-[80%] min-w-0 overflow-hidden ${
                      msg.role === "user"
                        ? "bg-brand-600/20 border border-brand-600/30 rounded-2xl rounded-tr-sm"
                        : "bg-surface-2 border border-surface-4 rounded-2xl rounded-tl-sm"
                    } px-4 py-3`}>
                      {msg.role === "agent" && msg.agent_name && (
                        <p className="text-xs text-brand-400 mb-1 font-medium">{msg.agent_name}</p>
                      )}
                      <div className="text-sm text-gray-200 prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-cyan-300 prose-code:bg-surface-1 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-surface-1 prose-pre:border prose-pre:border-surface-4 prose-a:text-brand-400 break-words [overflow-wrap:anywhere]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      </div>
                      {msg.role === "agent" && isStreaming && msg.id === messages[messages.length - 1]?.id && (
                        <div className="flex items-center gap-1 mt-1.5">
                          <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                          <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                          <div className="w-1.5 h-1.5 bg-brand-400/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      )}
                    </div>
                    {msg.role === "user" && (
                      <div className="w-7 h-7 bg-surface-3 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
                        <User className="w-3.5 h-3.5 text-gray-400" />
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input — auto-expanding textarea */}
            <div className="border-t border-surface-4 pt-3">
              {isReadOnly && (
                <div className="mb-2 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-yellow-600/10 border border-yellow-600/30">
                  <p className="text-[11px] text-yellow-300/90 leading-tight">
                    Read-only — this session ID is too short to continue (AgentCore requires ≥33 chars). Start a new session to chat.
                  </p>
                  <button
                    onClick={startNewSession}
                    className="text-[10px] px-2 py-1 rounded-md bg-yellow-600/20 border border-yellow-600/40 text-yellow-200 hover:bg-yellow-600/30 flex-shrink-0"
                  >
                    New Session
                  </button>
                </div>
              )}
              <div className="flex items-end gap-3">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={isReadOnly ? "Read-only — start a new session to chat" : `Message ${agent.name}...`}
                  rows={1}
                  className="flex-1 bg-surface-2 border border-surface-4 rounded-xl px-4 py-2.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-brand-500/50 resize-none overflow-y-auto disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ maxHeight: "120px" }}
                  disabled={isStreaming || isReadOnly}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming || isReadOnly}
                  className="btn-primary p-2.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[10px] text-gray-600 mt-1">Shift+Enter for new line</p>
            </div>
          </>
        ) : (
          <>
            {/* Playground Mode */}
            <div className="flex-1 flex flex-col gap-3 min-h-0">
              {/* Payload editor */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">Request Payload</span>
                  <span className="text-[10px] text-gray-600">
                    POST /api/agentcore/invoke • agent: {agent.name}
                  </span>
                </div>
                <textarea
                  value={playgroundPayload}
                  onChange={(e) => setPlaygroundPayload(e.target.value)}
                  className="flex-1 bg-surface-1 border border-surface-4 rounded-lg px-3 py-2.5 text-xs text-gray-300 font-mono focus:outline-none focus:border-brand-500/50 resize-none"
                  spellCheck={false}
                  disabled={isStreaming}
                />
              </div>

              {/* Response viewer */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">Response</span>
                  {isStreaming && <Loader2 className="w-3 h-3 text-brand-400 animate-spin" />}
                </div>
                <div className="flex-1 bg-surface-1 border border-surface-4 rounded-lg px-3 py-2.5 overflow-y-auto overflow-x-hidden">
                  {playgroundResponse ? (
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">{playgroundResponse}</pre>
                  ) : (
                    <p className="text-xs text-gray-600 italic">Response will appear here after invoking...</p>
                  )}
                </div>
              </div>

              {/* Send button */}
              <div className="border-t border-surface-4 pt-3">
                {isReadOnly && (
                  <div className="mb-2 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-yellow-600/10 border border-yellow-600/30">
                    <p className="text-[11px] text-yellow-300/90 leading-tight">
                      Read-only — this session ID is too short to continue (AgentCore requires ≥33 chars). Start a new session to invoke.
                    </p>
                    <button
                      onClick={startNewSession}
                      className="text-[10px] px-2 py-1 rounded-md bg-yellow-600/20 border border-yellow-600/40 text-yellow-200 hover:bg-yellow-600/30 flex-shrink-0"
                    >
                      New Session
                    </button>
                  </div>
                )}
                <button
                  onClick={handlePlaygroundSend}
                  disabled={isStreaming || isReadOnly}
                  className="w-full btn-primary flex items-center justify-center gap-2 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isStreaming ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Streaming...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Invoke Agent
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Right — Execution Trace */}
      <div className="w-64 flex-shrink-0 flex flex-col border-l border-surface-4 pl-3">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-surface-4">
          <Terminal className="w-4 h-4 text-gray-500" />
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Execution Trace</h3>
          {isStreaming && <span className="ml-auto w-2 h-2 bg-green-400 rounded-full animate-pulse" />}
        </div>

        <TraceDiagnosticBanner diagnostics={traceDiagnostics} traceCount={traceSteps.length} />

        <div className="flex-1 overflow-y-auto space-y-1">
          {traceSteps.length === 0 ? (
            <div className="text-center py-8">
              <Terminal className="w-6 h-6 text-gray-700 mx-auto mb-2" />
              <p className="text-xs text-gray-600">Trace events will appear here.</p>
            </div>
          ) : (
            traceSteps.map((step, idx) => {
              const config = traceEventConfig[step.event] || { icon: Zap, color: "text-gray-400", label: step.event };
              const Icon = config.icon;
              const isExpanded = expandedTrace === step.id;
              const dur = step.duration;
              const tokensIn = step.details?.tokensIn as number | undefined;
              const tokensOut = step.details?.tokensOut as number | undefined;

              return (
                <div key={step.id} className="rounded-md overflow-hidden bg-surface-2/50 border border-surface-4/50">
                  <button
                    onClick={() => setExpandedTrace(isExpanded ? null : step.id)}
                    className="w-full flex items-start gap-2 px-2 py-1.5 hover:bg-surface-3/50 transition-colors text-left"
                  >
                    {step.details ? (
                      isExpanded ? <ChevronDown className="w-3 h-3 text-gray-600 mt-0.5" /> : <ChevronRight className="w-3 h-3 text-gray-600 mt-0.5" />
                    ) : (
                      <span className="w-3 h-3 flex items-center justify-center text-gray-700 text-[9px] mt-0.5">{idx + 1}</span>
                    )}
                    <Icon className={`w-3 h-3 flex-shrink-0 mt-0.5 ${config.color}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] text-gray-300 block truncate">{step.name || config.label}</span>
                      {(dur !== undefined || tokensIn !== undefined) && (
                        <span className="text-[9px] text-gray-500 block">
                          {dur !== undefined && dur > 0 ? `${dur.toFixed(1)}s` : ""}
                          {tokensIn !== undefined && tokensIn > 0 && (
                            <span className="ml-1 text-purple-400/70">{tokensIn.toLocaleString()}→{(tokensOut || 0).toLocaleString()} tok</span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                  {isExpanded && step.details && (
                    <div className="px-2 pb-2 border-t border-surface-4/30">
                      <pre className="text-[10px] text-gray-500 mt-1 font-mono whitespace-pre-wrap">
                        {JSON.stringify(step.details, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div ref={traceEndRef} />
        </div>
      </div>
    </div>
  );
}

interface TraceHealth {
  region: string;
  checkedAt: string;
  healthy: boolean;
  transactionSearchEnabled: boolean;
  recentSpanCount: number | null;
  recentWindowMinutes: number;
  lastSpanTimestamp: string | null;
  issues: Array<{
    severity: "warning" | "error";
    code: string;
    title: string;
    body: string;
    actionUrl?: string;
    actionLabel?: string;
  }>;
  cached?: boolean;
}

function TraceHealthBanner() {
  const [health, setHealth] = useState<TraceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = useCallback(async (force = false) => {
    try {
      const url = force ? "/api/agentcore/traces/health?refresh=1" : "/api/agentcore/traces/health";
      const res = await fetch(url, { headers: { "x-aws-region": getClientRegion() } });
      if (!res.ok) return;
      const data = (await res.json()) as TraceHealth;
      setHealth(data);
    } catch {
      // Silent — banner just doesn't render
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchHealth().finally(() => setLoading(false));
  }, [fetchHealth]);

  if (loading || !health || dismissed) return null;
  // Don't render anything when fully healthy — silent success
  if (health.healthy && health.issues.length === 0) return null;

  const hasError = health.issues.some((i) => i.severity === "error");
  const accent = hasError
    ? "bg-red-600/10 border-red-600/30 text-red-200"
    : "bg-yellow-600/10 border-yellow-600/30 text-yellow-200";
  const iconColor = hasError ? "text-red-400" : "text-yellow-400";

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchHealth(true);
    setRefreshing(false);
  };

  return (
    <div className={`rounded-xl border px-4 py-3 ${accent}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0 space-y-2">
          {health.issues.map((issue) => (
            <div key={issue.code}>
              <p className="text-xs font-semibold">{issue.title}</p>
              <p className="text-[11px] mt-0.5 leading-snug opacity-90">{issue.body}</p>
              {issue.actionUrl && (
                <a
                  href={issue.actionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] mt-1 underline opacity-80 hover:opacity-100"
                >
                  {issue.actionLabel || "Learn more"}
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
            </div>
          ))}
          <p className="text-[10px] opacity-60 pt-1">
            Region {health.region} · checked {new Date(health.checkedAt).toLocaleTimeString()}
            {health.recentSpanCount !== null && health.recentSpanCount > 0 && (
              <> · {health.recentSpanCount} spans in last {health.recentWindowMinutes}m</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[10px] px-2 py-1 rounded-md border border-current opacity-70 hover:opacity-100 disabled:opacity-40 inline-flex items-center gap-1"
            title="Re-check trace pipeline health"
          >
            <RefreshCw className={`w-2.5 h-2.5 ${refreshing ? "animate-spin" : ""}`} />
            Recheck
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-[10px] px-2 py-1 rounded-md opacity-70 hover:opacity-100"
            title="Dismiss for this session"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function TraceDiagnosticBanner({
  diagnostics,
  traceCount,
}: {
  diagnostics: TraceDiagnostics | null;
  traceCount: number;
}) {
  if (!diagnostics) return null;

  // No banner needed when we got high-confidence matches
  if (diagnostics.matchMode === "anchored" && traceCount > 0) return null;

  let title: string;
  let body: string;
  let tone: "warning" | "info" = "info";

  if (diagnostics.logGroupMissing) {
    tone = "warning";
    title = "Transaction Search not enabled";
    body =
      "The aws/spans log group doesn't exist. Enable CloudWatch Transaction Search to ingest OTEL spans (one-time per account, ~10 min to propagate).";
  } else if (diagnostics.queryStatus === "timeout") {
    title = "Trace query timed out";
    body =
      "CloudWatch Logs Insights didn't return within the poll budget. Spans may exist — try resuming this session again in a few seconds.";
  } else if (diagnostics.queryStatus === "failed") {
    tone = "warning";
    title = "Trace query failed";
    body = "CloudWatch returned an error. Check the server logs and IAM permissions on logs:StartQuery / GetQueryResults.";
  } else if (diagnostics.sessionIdPropagationMissing) {
    tone = "warning";
    title = "session.id not propagated";
    body =
      "Spans exist in aws/spans but don't carry attributes.session.id, so we can't reliably attribute them to this session. The agent needs ADOT auto-instrumentation and session.id baggage propagation.";
  } else if (diagnostics.matchMode === "none" && traceCount === 0) {
    title = "No spans found for this session";
    body =
      "Common causes: Transaction Search sampling rate (default 1%), span propagation lag (5–30s after invocation), or the agent isn't instrumented with ADOT.";
  } else {
    return null;
  }

  const bg = tone === "warning" ? "bg-yellow-600/10 border-yellow-600/30" : "bg-surface-3/70 border-surface-4";
  const text = tone === "warning" ? "text-yellow-300/90" : "text-gray-400";

  return (
    <div className={`mb-3 px-2.5 py-2 rounded-lg border ${bg}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-wide ${text}`}>{title}</p>
      <p className={`text-[10px] mt-1 leading-snug ${text}`}>{body}</p>
    </div>
  );
}
