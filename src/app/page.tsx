"use client";

import { useState, useEffect } from "react";
import { Brain, Cpu, ArrowRight } from "lucide-react";
import Link from "next/link";
import { cachedFetch, getCached } from "@/lib/client-cache";
import TicketsFlowPanel from "@/components/dashboard/TicketsFlowPanel";

interface Agent {
  id: string;
  name: string;
  type: "harness" | "runtime";
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

interface MetricsData {
  usage: {
    totalSessions: number;
    totalTokensIn: number;
    totalTokensOut: number;
    avgSessionDuration: number;
    totalDuration: number;
    totalInvocations: number;
    activeAgents: number;
    totalAgents: number;
  };
  agentMetrics: Array<{
    id: string;
    name: string;
    sessions: number;
    tokensIn: number;
    tokensOut: number;
    avgDuration: number;
    totalDuration: number;
    invocations: number;
  }>;
}

function formatNumber(n: number): string {
  const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("en-US", opts)}M`;
  if (n >= 10_000) return `${(n / 1_000).toLocaleString("en-US", opts)}K`;
  return n.toLocaleString("en-US");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export default function DashboardPage() {
  // Initialize from cache for instant render on back-navigation
  const [agents, setAgents] = useState<Agent[]>(() => getCached<Agent[]>("/api/agentcore/agents") || []);
  const [metrics, setMetrics] = useState<MetricsData | null>(() => getCached<MetricsData>("/api/agentcore/metrics"));
  const [loading, setLoading] = useState(!getCached("/api/agentcore/agents"));
  const [metricsLoading, setMetricsLoading] = useState(!getCached("/api/agentcore/metrics"));

  useEffect(() => {
    // Agent discovery is fast (~0.5s); metrics runs slow CloudWatch Logs
    // Insights queries (~15s cold). Fetch them independently so the agent
    // table renders as soon as discovery returns instead of waiting on metrics.
    cachedFetch<Agent[]>("/api/agentcore/agents")
      .then((agentsData) => setAgents(Array.isArray(agentsData) ? agentsData : []))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));

    cachedFetch<MetricsData>("/api/agentcore/metrics")
      .then((metricsData) => {
        if (metricsData && !(metricsData as any).error) setMetrics(metricsData);
      })
      .catch(() => {})
      .finally(() => setMetricsLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      {/* Agent Activity Section */}
      <div className="card">
        <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-4">Agent Activity</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <BigMetric
            label="Invocations"
            value={metricsLoading ? "—" : (metrics?.usage.totalInvocations ?? 0).toLocaleString("en-US")}
            sub={`${(metrics?.usage.totalSessions ?? 0).toLocaleString("en-US")} sessions`}
          />
          <BigMetric
            label="Tokens"
            value={metricsLoading ? "—" : `${formatNumber(metrics?.usage.totalTokensIn ?? 0)} / ${formatNumber(metrics?.usage.totalTokensOut ?? 0)}`}
            sub="in / out"
          />
          <BigMetric
            label="Avg Duration"
            value={metricsLoading ? "—" : formatDuration(metrics?.usage.avgSessionDuration ?? 0)}
            sub="per session"
          />
          <BigMetric
            label="Total Duration"
            value={metricsLoading ? "—" : formatDuration(metrics?.usage.totalDuration ?? 0)}
            sub="autonomous work time"
          />
          <BigMetric
            label="Active Agents"
            value={metricsLoading ? "—" : (metrics?.usage.activeAgents ?? agents.filter((a) => a.status === "ACTIVE" || a.status === "READY").length).toString()}
            sub={`of ${metrics?.usage.totalAgents ?? agents.length} total`}
          />
        </div>
      </div>

      {/* Ticket flow section */}
      <TicketsFlowPanel />

      {/* Agent Performance Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Agent Performance</h3>
          <Link href="/agents" className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1">
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        {loading ? (
          <div className="text-sm text-[var(--color-text-muted)] py-4">Discovering agents...</div>
        ) : agents.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)] py-4">No agents found. Ensure your AWS credentials have access to Bedrock AgentCore.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-4">
                  <th className="text-left py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Agent</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Sessions</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Tokens (in/out)</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Invocations</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Avg Duration</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Total Duration</th>
                  <th className="text-right py-3 px-3 text-xs text-[var(--color-text-muted)] font-semibold uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const am = metrics?.agentMetrics.find((m) => m.id === agent.id);
                  // Metrics load separately from agent discovery; show a
                  // placeholder rather than real-looking zeros until the slow
                  // metrics fetch resolves.
                  const pending = metricsLoading && !am;
                  return (
                    <tr key={agent.id} className="border-b border-surface-4/50 hover:bg-surface-3/30 transition-colors">
                      <td className="py-4 px-3">
                        <Link href={`/agents/${agent.id}`} className="flex items-center gap-3 hover:text-[var(--color-text-primary)]">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                            agent.type === "harness" ? "bg-accent-subtle" : "bg-violet-subtle"
                          }`}>
                            {agent.type === "harness" ? (
                              <Brain className="w-4 h-4 text-accent-fg" />
                            ) : (
                              <Cpu className="w-4 h-4 text-violet-fg" />
                            )}
                          </div>
                          <span className="text-sm text-[var(--color-text-primary)] font-semibold truncate max-w-[200px]">{agent.name}</span>
                        </Link>
                      </td>
                      <td className="text-right py-4 px-3">
                        <span className="text-lg font-bold text-[var(--color-text-primary)]">{pending ? "—" : (am?.sessions || 0)}</span>
                      </td>
                      <td className="text-right py-4 px-3">
                        {pending ? (
                          <span className="text-base font-semibold text-[var(--color-text-muted)]">—</span>
                        ) : (
                          <>
                            <span className="text-base font-semibold text-info-fg">{formatNumber(am?.tokensIn || 0)}</span>
                            <span className="text-[var(--color-text-muted)] mx-1.5">|</span>
                            <span className="text-base font-semibold text-violet-fg">{formatNumber(am?.tokensOut || 0)}</span>
                          </>
                        )}
                      </td>
                      <td className="text-right py-4 px-3">
                        <span className="text-lg font-bold text-success-fg">{pending ? "—" : (am?.invocations || 0)}</span>
                      </td>
                      <td className="text-right py-4 px-3">
                        <span className="text-base font-semibold text-[var(--color-text-primary)]">{pending ? "—" : formatDuration(am?.avgDuration || 0)}</span>
                      </td>
                      <td className="text-right py-4 px-3">
                        <span className="text-lg font-bold text-success-fg">{pending ? "—" : formatDuration(am?.totalDuration || 0)}</span>
                      </td>
                      <td className="text-right py-4 px-3">
                        <span className={`px-2 py-1 rounded-full border text-xs font-medium ${
                          agent.status === "ACTIVE" || agent.status === "READY"
                            ? "bg-success-subtle text-success-fg border-success-fg/30"
                            : "bg-surface-3 text-muted border-theme"
                        }`}>
                          {agent.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function BigMetric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-0.5">{value}</p>
      {sub && <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">{sub}</p>}
    </div>
  );
}
