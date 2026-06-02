"use client";

import { useState, useEffect } from "react";
import {
  Bot, Brain, Cpu, Loader2, MessageSquare, Zap, Clock,
  Timer, CheckCircle2, Wrench, Server,
} from "lucide-react";
import Link from "next/link";
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
  description?: string;
  tools?: Array<{ type: string; name?: string }>;
}

interface AgentMetrics {
  id: string;
  name: string;
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  avgDuration: number;
  totalDuration: number;
  invocations: number;
}

interface MetricsResponse {
  usage: Record<string, unknown>;
  agentMetrics: AgentMetrics[];
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export default function AgentsPage() {
  const cacheKey = "/api/agentcore/agents";
  const metricsCacheKey = "/api/agentcore/metrics";
  const [agents, setAgents] = useState<AgentDetail[]>(() => getCached<AgentDetail[]>(cacheKey) || []);
  const [metricsMap, setMetricsMap] = useState<Record<string, AgentMetrics>>(() => {
    const cached = getCached<MetricsResponse>(metricsCacheKey);
    if (cached?.agentMetrics) {
      return Object.fromEntries(cached.agentMetrics.map((m) => [m.id, m]));
    }
    return {};
  });
  const [loading, setLoading] = useState(!getCached(cacheKey));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Agent discovery is fast; per-agent detail enrichment and the metrics
    // endpoint (slow CloudWatch Logs Insights queries, ~15s cold) are not.
    // Render the cards as soon as discovery returns, then enrich + fill in
    // metrics independently so neither blocks the initial paint.
    cachedFetch<AgentDetail[] | { error: string }>(cacheKey)
      .then((data) => {
        if (data && typeof data === "object" && "error" in data) {
          setError((data as { error: string }).error);
          setAgents([]);
          return;
        }
        const list = Array.isArray(data) ? data : [];
        setAgents(list);
        setLoading(false);

        // Enrich each agent with detail (model, tools, description) in the
        // background — cards are already visible by now.
        list.forEach(async (agent: AgentDetail) => {
          try {
            const detail = await cachedFetch<AgentDetail>(`/api/agentcore/agents?id=${agent.id}`);
            setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, ...detail } : a)));
          } catch { /* keep basic info */ }
        });
      })
      .catch((err) => {
        setError(err.message);
        setAgents([]);
        setLoading(false);
      });

    cachedFetch<MetricsResponse>(metricsCacheKey)
      .then((metricsData) => {
        if (metricsData?.agentMetrics) {
          setMetricsMap(Object.fromEntries(metricsData.agentMetrics.map((m) => [m.id, m])));
        }
      })
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        <span className="ml-2 text-sm text-gray-500">Discovering agents...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Agents</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {agents.length} agent{agents.length !== 1 ? "s" : ""} discovered in your account
          </p>
        </div>
      </div>

      {error ? (
        <div className="card border-red-500/20 text-center py-12">
          <Bot className="w-10 h-10 text-red-400/60 mx-auto mb-3" />
          <p className="text-sm text-red-400">Failed to discover agents</p>
          <p className="text-xs text-gray-500 mt-2 max-w-md mx-auto">{error}</p>
          <div className="mt-4 text-xs text-gray-600 space-y-1">
            <p>Common causes:</p>
            <ul className="list-disc list-inside text-left max-w-sm mx-auto space-y-0.5">
              <li>AWS credentials not configured or expired</li>
              <li>Region mismatch — agents are deployed in a different region (check the region selector above)</li>
              <li>Missing IAM permissions: <code className="text-gray-500">bedrock-agentcore:ListHarnesses</code>, <code className="text-gray-500">bedrock-agentcore:ListAgentRuntimes</code></li>
              <li>No agents deployed to Bedrock AgentCore in this account</li>
            </ul>
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="card text-center py-12">
          <Bot className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400">No agents found in this region.</p>
          <p className="text-xs text-gray-600 mt-1">
            Deploy a harness or runtime to Bedrock AgentCore, or try switching the region in the header.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {agents.map((agent) => {
            const m = metricsMap[agent.id] || { sessions: 0, tokensIn: 0, tokensOut: 0, avgDuration: 0, totalDuration: 0, invocations: 0 };
            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="card hover:border-brand-600/40 transition-colors group"
                data-testid={`agent-card-${agent.id}`}
              >
                {/* Header row: icon, name, type, status */}
                <div className="flex items-start gap-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    agent.type === "harness" ? "bg-brand-600/20" : "bg-purple-600/20"
                  }`}>
                    {agent.type === "harness" ? (
                      <Brain className="w-6 h-6 text-brand-400" />
                    ) : (
                      <Cpu className="w-6 h-6 text-purple-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-base font-bold text-gray-100 group-hover:text-white truncate">
                        {agent.name}
                      </p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
                        agent.type === "harness"
                          ? "bg-brand-600/10 text-brand-400 border-brand-600/30"
                          : "bg-purple-600/10 text-purple-400 border-purple-600/30"
                      }`}>
                        {agent.type.toUpperCase()}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                        agent.status === "ACTIVE" || agent.status === "READY"
                          ? "bg-green-400/10 text-green-400 border-green-400/30"
                          : "bg-gray-400/10 text-gray-400 border-gray-400/30"
                      }`}>
                        {agent.status}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-600 font-mono mt-0.5">{agent.id}</p>
                    {agent.description && (
                      <p className="text-xs text-gray-400 mt-1.5 line-clamp-2">{agent.description}</p>
                    )}
                  </div>
                </div>

                {/* Model & Tools row */}
                {(agent.model || (agent.tools && agent.tools.length > 0)) && (
                  <div className="mt-3 pt-3 border-t border-surface-4/50 flex items-center gap-4 text-[11px]">
                    {agent.model && (
                      <span className="text-gray-500 flex items-center gap-1 truncate">
                        <Bot className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{agent.model.split("/").pop()?.split(":")[0] || agent.model}</span>
                      </span>
                    )}
                    {agent.tools && agent.tools.length > 0 && (
                      <span className="text-gray-500 flex items-center gap-1">
                        <Wrench className="w-3 h-3 flex-shrink-0" />
                        {agent.tools.length} tool{agent.tools.length !== 1 ? "s" : ""}
                        {agent.tools.slice(0, 2).map((t, i) => (
                          <span key={i} className="text-gray-600 ml-1 hidden md:inline">
                            {i > 0 && "·"} {t.name || t.type}
                          </span>
                        ))}
                      </span>
                    )}
                    {agent.memoryId && (
                      <span className="text-gray-500 flex items-center gap-1">
                        <Server className="w-3 h-3 flex-shrink-0" /> Memory
                      </span>
                    )}
                  </div>
                )}

                {/* Metrics row */}
                <div className="mt-3 pt-3 border-t border-surface-4/50 grid grid-cols-3 md:grid-cols-6 gap-3">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <MessageSquare className="w-3 h-3 text-brand-400" />
                      <span className="text-[10px] text-gray-500">Sessions</span>
                    </div>
                    <p className="text-lg font-bold text-white">{m.sessions}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Zap className="w-3 h-3 text-cyan-400" />
                      <span className="text-[10px] text-gray-500">Tokens</span>
                    </div>
                    <p className="text-sm font-semibold">
                      <span className="text-cyan-300">{formatNumber(m.tokensIn)}</span>
                      <span className="text-gray-600 mx-0.5">/</span>
                      <span className="text-purple-300">{formatNumber(m.tokensOut)}</span>
                    </p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <CheckCircle2 className="w-3 h-3 text-green-400" />
                      <span className="text-[10px] text-gray-500">Invocations</span>
                    </div>
                    <p className="text-lg font-bold text-green-400">{m.invocations}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Timer className="w-3 h-3 text-yellow-400" />
                      <span className="text-[10px] text-gray-500">Avg</span>
                    </div>
                    <p className="text-sm font-semibold text-gray-200">{formatDuration(m.avgDuration)}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Clock className="w-3 h-3 text-emerald-400" />
                      <span className="text-[10px] text-gray-500">Total</span>
                    </div>
                    <p className="text-lg font-bold text-emerald-300">{formatDuration(m.totalDuration)}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <span className="text-[10px] text-gray-500">Updated</span>
                    </div>
                    <p className="text-xs text-gray-400">
                      {agent.updatedAt ? new Date(agent.updatedAt).toLocaleDateString() : "—"}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
