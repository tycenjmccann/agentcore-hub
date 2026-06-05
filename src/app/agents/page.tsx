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
  const [metricsLoading, setMetricsLoading] = useState(!getCached(metricsCacheKey));
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
      })
      .finally(() => setLoading(false));

    cachedFetch<MetricsResponse>(metricsCacheKey)
      .then((metricsData) => {
        if (metricsData?.agentMetrics) {
          setMetricsMap(Object.fromEntries(metricsData.agentMetrics.map((m) => [m.id, m])));
        }
      })
      .catch(() => {})
      .finally(() => setMetricsLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent-fg animate-spin" />
        <span className="ml-2 text-sm text-muted">Discovering agents...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-primary">Agents</h2>
          <p className="text-xs text-muted mt-0.5">
            {agents.length} agent{agents.length !== 1 ? "s" : ""} discovered in your account
          </p>
        </div>
      </div>

      {error ? (
        <div className="card border-danger-subtle text-center py-12">
          <Bot className="w-10 h-10 text-danger-fg mx-auto mb-3" />
          <p className="text-sm text-danger-fg">Failed to discover agents</p>
          <p className="text-xs text-muted mt-2 max-w-md mx-auto">{error}</p>
          <div className="mt-4 text-xs text-muted space-y-1">
            <p>Common causes:</p>
            <ul className="list-disc list-inside text-left max-w-sm mx-auto space-y-0.5">
              <li>AWS credentials not configured or expired</li>
              <li>Region mismatch — agents are deployed in a different region (check the region selector above)</li>
              <li>Missing IAM permissions: <code className="text-muted">bedrock-agentcore:ListHarnesses</code>, <code className="text-muted">bedrock-agentcore:ListAgentRuntimes</code></li>
              <li>No agents deployed to Bedrock AgentCore in this account</li>
            </ul>
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="card text-center py-12">
          <Bot className="w-10 h-10 text-muted mx-auto mb-3" />
          <p className="text-sm text-secondary">No agents found in this region.</p>
          <p className="text-xs text-muted mt-1">
            Deploy a harness or runtime to Bedrock AgentCore, or try switching the region in the header.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {agents.map((agent) => {
            const m = metricsMap[agent.id] || { sessions: 0, tokensIn: 0, tokensOut: 0, avgDuration: 0, totalDuration: 0, invocations: 0 };
            // While the slow metrics fetch is still in flight and this agent
            // has no metrics yet, show a placeholder instead of real-looking
            // zeros so users can tell "no data yet" from "genuinely zero".
            const pending = metricsLoading && !metricsMap[agent.id];
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
                    agent.type === "harness" ? "bg-accent-subtle" : "bg-violet-subtle"
                  }`}>
                    {agent.type === "harness" ? (
                      <Brain className="w-6 h-6 text-accent-fg" />
                    ) : (
                      <Cpu className="w-6 h-6 text-violet-fg" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-base font-bold text-primary truncate">
                        {agent.name}
                      </p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
                        agent.type === "harness"
                          ? "bg-accent-subtle text-accent-fg border-accent-fg/30"
                          : "bg-violet-subtle text-violet-fg border-violet-fg/30"
                      }`}>
                        {agent.type.toUpperCase()}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                        agent.status === "ACTIVE" || agent.status === "READY"
                          ? "bg-success-subtle text-success-fg border-success-fg/30"
                          : "bg-surface-3 text-muted border-theme"
                      }`}>
                        {agent.status}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted font-mono mt-0.5">{agent.id}</p>
                    {agent.description && (
                      <p className="text-xs text-secondary mt-1.5 line-clamp-2">{agent.description}</p>
                    )}
                  </div>
                </div>

                {/* Model & Tools row */}
                {(agent.model || (agent.tools && agent.tools.length > 0)) && (
                  <div className="mt-3 pt-3 border-t border-theme flex items-center gap-4 text-[11px]">
                    {agent.model && (
                      <span className="text-muted flex items-center gap-1 truncate">
                        <Bot className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{agent.model.split("/").pop()?.split(":")[0] || agent.model}</span>
                      </span>
                    )}
                    {agent.tools && agent.tools.length > 0 && (
                      <span className="text-muted flex items-center gap-1">
                        <Wrench className="w-3 h-3 flex-shrink-0" />
                        {agent.tools.length} tool{agent.tools.length !== 1 ? "s" : ""}
                        {agent.tools.slice(0, 2).map((t, i) => (
                          <span key={i} className="text-muted ml-1 hidden md:inline">
                            {i > 0 && "·"} {t.name || t.type}
                          </span>
                        ))}
                      </span>
                    )}
                    {agent.memoryId && (
                      <span className="text-muted flex items-center gap-1">
                        <Server className="w-3 h-3 flex-shrink-0" /> Memory
                      </span>
                    )}
                  </div>
                )}

                {/* Metrics row */}
                <div className="mt-3 pt-3 border-t border-theme grid grid-cols-3 md:grid-cols-6 gap-3">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <MessageSquare className="w-3 h-3 text-accent-fg" />
                      <span className="text-[10px] text-muted">Sessions</span>
                    </div>
                    <p className="text-lg font-bold text-primary">{pending ? "—" : m.sessions}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Zap className="w-3 h-3 text-info-fg" />
                      <span className="text-[10px] text-muted">Tokens</span>
                    </div>
                    {pending ? (
                      <p className="text-sm font-semibold text-muted">—</p>
                    ) : (
                      <p className="text-sm font-semibold">
                        <span className="text-info-fg">{formatNumber(m.tokensIn)}</span>
                        <span className="text-muted mx-0.5">/</span>
                        <span className="text-violet-fg">{formatNumber(m.tokensOut)}</span>
                      </p>
                    )}
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <CheckCircle2 className="w-3 h-3 text-success-fg" />
                      <span className="text-[10px] text-muted">Invocations</span>
                    </div>
                    <p className="text-lg font-bold text-success-fg">{pending ? "—" : m.invocations}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Timer className="w-3 h-3 text-warning-fg" />
                      <span className="text-[10px] text-muted">Avg</span>
                    </div>
                    <p className="text-sm font-semibold text-secondary">{pending ? "—" : formatDuration(m.avgDuration)}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <Clock className="w-3 h-3 text-success-fg" />
                      <span className="text-[10px] text-muted">Total</span>
                    </div>
                    <p className="text-lg font-bold text-success-fg">{pending ? "—" : formatDuration(m.totalDuration)}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <span className="text-[10px] text-muted">Updated</span>
                    </div>
                    <p className="text-xs text-secondary">
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
