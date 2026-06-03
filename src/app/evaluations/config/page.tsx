"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Activity,
  ArrowLeft,
  ToggleLeft,
  ToggleRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  RefreshCw,
  X,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import agentsConfig from "@/config/agents.json";

// --- Types ---

interface AgentEvalApiResponse {
  agentId: string;
  enabled: boolean;
  sampleRate: number;
  batchSize: number;
  currentBufferLen: number;
  lastFlushedAt: string | null;
  lastUpdatedAt: string | null;
  lastUpdatedBy: string | null;
}

interface AgentEvalConfig extends AgentEvalApiResponse {
  name: string;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

// --- Build agent name lookup from config ---

const AGENT_NAME_MAP = new Map<string, string>(
  agentsConfig.agents.map((a) => [a.agentId, a.displayName])
);

function resolveAgentName(agentId: string): string {
  return AGENT_NAME_MAP.get(agentId) || agentId;
}

// One row per REAL deployed runtime, not per persona — mirrors the scorecard
// (src/app/evaluations/page.tsx). Personas sharing a runtimeArn collapse to the
// "anchor" persona whose agentId is embedded in the ARN (the runtime's actual
// name, where eval data is attributed). Personas with no runtimeArn (undeployed)
// are dropped. So 1-runtime mode shows 1 row, 4-runtime 4, 14-runtime 14.
const RUNTIME_ANCHOR_IDS = new Set<string>(
  (() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const a of agentsConfig.agents) {
      const arn = a.runtimeArn;
      if (!a.evaluationsEnabled || !arn || seen.has(arn)) continue;
      seen.add(arn);
      const anchor = agentsConfig.agents.find((p) => arn.includes(p.agentId)) ?? a;
      ids.push(anchor.agentId);
    }
    return ids;
  })()
);

// --- Constants ---

const POLL_INTERVAL = 30000; // 30s
const DEBOUNCE_DELAY = 500; // 500ms for slider

// --- Component ---

export default function EvaluationsPage() {
  const [agents, setAgents] = useState<AgentEvalConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bulkEnabled, setBulkEnabled] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mutatingAgents, setMutatingAgents] = useState<Set<string>>(new Set());
  const [flushingAgents, setFlushingAgents] = useState<Set<string>>(new Set());
  const debounceTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Toast helper
  const addToast = useCallback((message: string, type: "success" | "error") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Fetch agents data
  const fetchAgents = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/evaluations/agents");
      if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
      const data = await res.json();
      const agentList: AgentEvalApiResponse[] = data.agents || [];
      const enriched: AgentEvalConfig[] = agentList
        .filter((a) => RUNTIME_ANCHOR_IDS.has(a.agentId))
        .map((a) => ({
          ...a,
          name: resolveAgentName(a.agentId),
        }));
      setAgents(enriched);
      // Derive bulk toggle state
      const allEnabled =
        enriched.length > 0 && enriched.every((a) => a.enabled);
      setBulkEnabled(allEnabled);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchAgents(true);
    const interval = setInterval(() => fetchAgents(false), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  // Update a single agent config
  const updateAgent = useCallback(
    async (
      agentId: string,
      updates: Partial<Pick<AgentEvalConfig, "enabled" | "sampleRate" | "batchSize">>
    ) => {
      setMutatingAgents((prev) => new Set(prev).add(agentId));
      try {
        const res = await fetch(`/api/evaluations/agents/${agentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        if (!res.ok) throw new Error(`Update failed (${res.status})`);
        const updated = await res.json();
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === agentId
              ? { ...a, ...updated, name: resolveAgentName(agentId) }
              : a
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        addToast(`Failed to update agent: ${msg}`, "error");
      } finally {
        setMutatingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [addToast]
  );

  // Toggle agent enabled
  const handleToggle = useCallback(
    (agentId: string, currentEnabled: boolean) => {
      // Optimistic update
      setAgents((prev) =>
        prev.map((a) =>
          a.agentId === agentId ? { ...a, enabled: !currentEnabled } : a
        )
      );
      updateAgent(agentId, { enabled: !currentEnabled });
    },
    [updateAgent]
  );

  // Debounced sample rate change
  const handleSampleRateChange = useCallback(
    (agentId: string, value: number) => {
      // Immediate UI update
      setAgents((prev) =>
        prev.map((a) =>
          a.agentId === agentId ? { ...a, sampleRate: value } : a
        )
      );
      // Debounced API call
      const existing = debounceTimers.current.get(`rate-${agentId}`);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        updateAgent(agentId, { sampleRate: value });
        debounceTimers.current.delete(`rate-${agentId}`);
      }, DEBOUNCE_DELAY);
      debounceTimers.current.set(`rate-${agentId}`, timer);
    },
    [updateAgent]
  );

  // Batch size change (on blur/enter)
  const handleBatchSizeCommit = useCallback(
    (agentId: string, value: number) => {
      const clamped = Math.max(1, Math.min(100, value));
      setAgents((prev) =>
        prev.map((a) =>
          a.agentId === agentId ? { ...a, batchSize: clamped } : a
        )
      );
      updateAgent(agentId, { batchSize: clamped });
    },
    [updateAgent]
  );

  // Flush buffer
  const handleFlush = useCallback(
    async (agentId: string) => {
      setFlushingAgents((prev) => new Set(prev).add(agentId));
      try {
        const res = await fetch(`/api/evaluations/agents/${agentId}/flush`, {
          method: "POST",
        });
        if (res.status === 409) {
          addToast("Buffer is empty", "error");
          return;
        }
        if (!res.ok) throw new Error(`Flush failed (${res.status})`);
        addToast("Buffer flushed successfully", "success");
        // Refresh buffer count
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === agentId ? { ...a, currentBufferLen: 0 } : a
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        addToast(`Flush failed: ${msg}`, "error");
      } finally {
        setFlushingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [addToast]
  );

  // Bulk toggle
  const handleBulkToggle = useCallback(async () => {
    const newState = !bulkEnabled;
    setBulkLoading(true);
    setBulkEnabled(newState);
    // Optimistic update
    setAgents((prev) => prev.map((a) => ({ ...a, enabled: newState })));
    try {
      const res = await fetch("/api/evaluations/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newState }),
      });
      if (!res.ok) throw new Error(`Bulk toggle failed (${res.status})`);
      addToast(
        newState ? "All agents enabled" : "All agents disabled",
        "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      addToast(`Bulk toggle failed: ${msg}`, "error");
      // Revert
      setBulkEnabled(!newState);
      fetchAgents(false);
    } finally {
      setBulkLoading(false);
    }
  }, [bulkEnabled, addToast, fetchAgents]);

  // Buffer color helper
  function getBufferColor(currentBufferLen: number, batchSize: number): string {
    if (currentBufferLen === 0)
      return "bg-green-400/20 text-green-400 border-green-400/30";
    const ratio = currentBufferLen / batchSize;
    if (ratio >= 0.8)
      return "bg-amber-400/20 text-amber-400 border-amber-400/30";
    if (ratio >= 0.5)
      return "bg-yellow-400/20 text-yellow-400 border-yellow-400/30";
    return "bg-green-400/20 text-green-400 border-green-400/30";
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        <span className="ml-2 text-sm text-gray-500">
          Loading evaluation config...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "flex items-center gap-2 px-4 py-3 rounded-lg border shadow-lg animate-in fade-in slide-in-from-top-2 duration-200",
              toast.type === "success"
                ? "bg-green-900/90 border-green-500/30 text-green-200"
                : "bg-red-900/90 border-red-500/30 text-red-200"
            )}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            )}
            <span className="text-sm">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="ml-2 text-gray-400 hover:text-white"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/evaluations"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-2 border border-surface-4 hover:border-brand-500/50 hover:text-brand-400 transition-colors text-[var(--color-text-muted)]"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Activity className="w-5 h-5 text-brand-400" />
              Self-Improvement Settings
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Configure per-agent evaluation settings for the improvement loop
            </p>
          </div>
        </div>
        <button
          onClick={() => fetchAgents(false)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-surface-2 border border-surface-4 rounded-lg transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Error State */}
      {error && (
        <div className="card border-red-500/20 text-center py-8">
          <AlertCircle className="w-8 h-8 text-red-400/60 mx-auto mb-3" />
          <p className="text-sm text-red-400">
            Failed to load evaluation config
          </p>
          <p className="text-xs text-gray-500 mt-1">{error}</p>
          <button
            onClick={() => fetchAgents(true)}
            className="mt-4 btn-primary text-sm"
          >
            Retry
          </button>
        </div>
      )}

      {/* Bulk Toggle */}
      {!error && (
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-white">
                Self-Improvement Loop
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Master toggle — enable or disable evaluations for all agents at
                once
              </p>
            </div>
            <button
              onClick={handleBulkToggle}
              disabled={bulkLoading}
              className="flex items-center gap-2 transition-colors"
              aria-label={
                bulkEnabled ? "Disable all agents" : "Enable all agents"
              }
            >
              {bulkLoading ? (
                <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
              ) : bulkEnabled ? (
                <ToggleRight className="w-8 h-8 text-brand-400" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-500" />
              )}
              <span
                className={cn(
                  "text-sm font-medium",
                  bulkEnabled ? "text-brand-400" : "text-gray-500"
                )}
              >
                {bulkEnabled ? "All Enabled" : "All Disabled"}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Agent Config Matrix */}
      {!error && agents.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-4">
                  <th className="text-left px-6 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Agent
                  </th>
                  <th className="text-center px-4 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Enabled
                  </th>
                  <th className="text-center px-4 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider min-w-[180px]">
                    Sample Rate
                  </th>
                  <th className="text-center px-4 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Batch Size
                  </th>
                  <th className="text-center px-4 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Buffer
                  </th>
                  <th className="text-center px-4 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-4">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.agentId}
                    agent={agent}
                    isMutating={mutatingAgents.has(agent.agentId)}
                    isFlushing={flushingAgents.has(agent.agentId)}
                    onToggle={handleToggle}
                    onSampleRateChange={handleSampleRateChange}
                    onBatchSizeCommit={handleBatchSizeCommit}
                    onFlush={handleFlush}
                    getBufferColor={getBufferColor}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!error && !loading && agents.length === 0 && (
        <div className="card text-center py-12">
          <Activity className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400">
            No agents configured for evaluation.
          </p>
          <p className="text-xs text-gray-600 mt-1">
            Agents will appear here once the evaluation system is initialized.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Agent Row Component ---

interface AgentRowProps {
  agent: AgentEvalConfig;
  isMutating: boolean;
  isFlushing: boolean;
  onToggle: (agentId: string, currentEnabled: boolean) => void;
  onSampleRateChange: (agentId: string, value: number) => void;
  onBatchSizeCommit: (agentId: string, value: number) => void;
  onFlush: (agentId: string) => void;
  getBufferColor: (currentBufferLen: number, batchSize: number) => string;
}

function AgentRow({
  agent,
  isMutating,
  isFlushing,
  onToggle,
  onSampleRateChange,
  onBatchSizeCommit,
  onFlush,
  getBufferColor,
}: AgentRowProps) {
  const [localBatchSize, setLocalBatchSize] = useState(
    String(agent.batchSize)
  );

  // Sync local batch size when agent data changes externally
  useEffect(() => {
    setLocalBatchSize(String(agent.batchSize));
  }, [agent.batchSize]);

  const handleBatchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const value = parseInt(localBatchSize, 10);
      if (!isNaN(value)) {
        onBatchSizeCommit(agent.agentId, value);
      }
    }
  };

  const handleBatchBlur = () => {
    const value = parseInt(localBatchSize, 10);
    if (!isNaN(value)) {
      onBatchSizeCommit(agent.agentId, value);
    } else {
      setLocalBatchSize(String(agent.batchSize));
    }
  };

  return (
    <tr
      className={cn("transition-colors", !agent.enabled && "opacity-50")}
    >
      {/* Agent Name */}
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center flex-shrink-0">
            <Activity className="w-4 h-4 text-brand-400" />
          </div>
          <div>
            <p className="font-medium text-white text-sm">{agent.name}</p>
            <p className="text-xs text-gray-500 font-mono">
              {agent.agentId}
            </p>
          </div>
        </div>
      </td>

      {/* Enabled Toggle */}
      <td className="px-4 py-4 text-center">
        <button
          onClick={() => onToggle(agent.agentId, agent.enabled)}
          disabled={isMutating}
          className="inline-flex items-center justify-center"
          aria-label={
            agent.enabled
              ? `Disable ${agent.name}`
              : `Enable ${agent.name}`
          }
        >
          {isMutating ? (
            <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
          ) : agent.enabled ? (
            <ToggleRight className="w-7 h-7 text-brand-400 cursor-pointer" />
          ) : (
            <ToggleLeft className="w-7 h-7 text-gray-500 cursor-pointer" />
          )}
        </button>
      </td>

      {/* Sample Rate Slider */}
      <td className="px-4 py-4">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="100"
            value={agent.sampleRate}
            onChange={(e) =>
              onSampleRateChange(
                agent.agentId,
                parseInt(e.target.value, 10)
              )
            }
            disabled={!agent.enabled}
            className="flex-1 h-1.5 bg-surface-4 rounded-lg appearance-none cursor-pointer accent-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="text-xs font-mono text-gray-300 w-10 text-right">
            {agent.sampleRate}%
          </span>
        </div>
      </td>

      {/* Batch Size Input */}
      <td className="px-4 py-4 text-center">
        <input
          type="number"
          min="1"
          max="100"
          value={localBatchSize}
          onChange={(e) => setLocalBatchSize(e.target.value)}
          onBlur={handleBatchBlur}
          onKeyDown={handleBatchKeyDown}
          disabled={!agent.enabled}
          className="w-16 bg-surface-1 border border-surface-4 rounded-md px-2 py-1 text-center text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </td>

      {/* Buffer Indicator */}
      <td className="px-4 py-4 text-center">
        <span
          className={cn(
            "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-mono font-medium border",
            getBufferColor(agent.currentBufferLen, agent.batchSize)
          )}
        >
          {agent.currentBufferLen}/{agent.batchSize}
        </span>
      </td>

      {/* Flush Action */}
      <td className="px-4 py-4 text-center">
        <button
          onClick={() => onFlush(agent.agentId)}
          disabled={
            agent.currentBufferLen === 0 || isFlushing || !agent.enabled
          }
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            agent.currentBufferLen === 0 || !agent.enabled
              ? "bg-surface-3 text-gray-600 cursor-not-allowed"
              : "bg-red-600/20 text-red-300 border border-red-500/30 hover:bg-red-600/30 cursor-pointer"
          )}
        >
          {isFlushing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
          Flush
        </button>
      </td>
    </tr>
  );
}
