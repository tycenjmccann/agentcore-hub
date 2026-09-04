"use client";

/**
 * Per-run performance card (terminal runs). Renders the Lambda-written
 * workflows/{id}/shared/performance-card.json: cost / time / quality and the
 * run's anomaly bands against its def baseline.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gauge, Coins, Clock, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { formatKpi, type BandStatus, type KpiUnit } from "@/lib/workflow/performance";

interface RunCard {
  reportVersion: number;
  workflowId: string;
  epicId: string | null;
  workflowDefId: string;
  title: string | null;
  run: { outcome: string; startedAt: string | null; completedAt: string | null; prUrl: string | null };
  cost: {
    totalUsd: number; personaUsd: number; codingUsd: number; perTaskUsd: number | null;
    tokens: { input: number; output: number; cached: number; total: number };
    byEngine: Record<string, { usd: number }>;
  };
  time: {
    wallMs: number | null; humanWaitMs: number; activeMs: number | null; agentWorkMs: number;
    busyMs?: number; idleMs: number | null; agentUtilization: number | null; humanGates: number;
    phases: { phase: string; durationMs: number }[];
  };
  quality: {
    outcome: string; tasks: number; tasksCompleted: number; reworkRounds: number; changeRequests: number;
    fixTickets: number; gateRounds: number; loops: number; nudges: number; interventions: number;
    errors: number; retries: number; firstPassYield: number | null; prUrl: string | null;
  };
  agents: Record<string, { usd: number; workMs: number; tasks: number; reworkRounds: number }>;
  bands: {
    status: BandStatus;
    baseline: { n: number; windowDays: number; minSamples: number };
    anomalies: { kpi: string; label: string; status: BandStatus; value: number; median: number; z: number }[];
    kpis: Record<string, { label: string; unit: KpiUnit; status: BandStatus; value: number | null; median?: number; warnAbove?: number; z?: number | null }>;
  } | null;
  dataQuality: { gaps: string[] };
}

const STATUS_STYLE: Record<BandStatus, string> = {
  ok: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  alert: "bg-red-500/15 text-red-400 border-red-500/30",
  insufficient: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  unknown: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

function Row({ label, value, band, hint }: { label: string; value: string; band?: BandStatus; hint?: string }) {
  const dot = band === "alert" ? "bg-red-400" : band === "warn" ? "bg-amber-400" : band === "ok" ? "bg-emerald-400" : "bg-slate-500/50";
  return (
    <div className="flex items-center justify-between gap-2 text-xs" title={hint}>
      <span className="text-[var(--color-text-muted)] flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />{label}
      </span>
      <span className="font-medium text-[var(--color-text-primary)] tabular-nums">{value}</span>
    </div>
  );
}

export default function RunPerformanceCard({ workflowId }: { workflowId: string }) {
  const [card, setCard] = useState<RunCard | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setState("loading");
    fetch(`/api/workflow/performance?workflowId=${encodeURIComponent(workflowId)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 404) { setState("missing"); return; }
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setCard(j.card as RunCard);
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => { alive = false; };
  }, [workflowId]);

  if (state === "missing") return null;
  const b = card?.bands;
  const k = (path: string) => b?.kpis?.[path]?.status;

  return (
    <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[var(--color-border)]">
        <Gauge className="w-4 h-4 text-sky-400" />
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Performance Card</h3>
        {state === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)]" />}
        {b && (
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status]}`}>
            {b.status === "ok" ? "within bands" : b.status === "insufficient" ? `no baseline (${b.baseline.n}/${b.baseline.minSamples} runs)` : b.status}
          </span>
        )}
        {card && (
          <span className="text-xs text-[var(--color-text-muted)]">
            {card.workflowDefId}{b?.baseline?.n ? ` · baseline ${b.baseline.n} runs / ${b.baseline.windowDays}d` : ""}
          </span>
        )}
        <Link href={`/workflow?id=${workflowId}&artifact=${encodeURIComponent(`workflows/${workflowId}/shared/performance-card.md`)}`}
          className="ml-auto inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300">
          Full card <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {state === "error" && <div className="px-4 py-3 text-xs text-red-400">Could not load the performance card.</div>}

      {card && (
        <div className="p-4 space-y-3">
          {b?.anomalies?.length ? (
            <div className="flex flex-wrap gap-2">
              {b.anomalies.map((a) => (
                <span key={a.kpi} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${STATUS_STYLE[a.status]}`}>
                  {a.label}: {formatKpi(b.kpis[a.kpi]?.unit ?? "count", a.value)} vs median {formatKpi(b.kpis[a.kpi]?.unit ?? "count", a.median)} (z={a.z})
                </span>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1.5">
              <div className="flex items-center gap-2 mb-1"><Coins className="w-4 h-4 text-amber-400" /><span className="text-sm font-medium text-[var(--color-text-primary)]">Cost</span><span className="ml-auto text-base font-semibold tabular-nums">{formatKpi("usd", card.cost.totalUsd)}</span></div>
              <Row label="Persona LLM" value={formatKpi("usd", card.cost.personaUsd)} band={k("cost.personaUsd")} />
              <Row label="Coding CLIs" value={formatKpi("usd", card.cost.codingUsd)} band={k("cost.codingUsd")} hint={Object.entries(card.cost.byEngine).filter(([e]) => e !== "persona").map(([e, v]) => `${e}: ${formatKpi("usd", v.usd)}`).join(", ")} />
              <Row label="Per agent task" value={formatKpi("usd", card.cost.perTaskUsd)} />
              <Row label="Tokens (in / out / cached)" value={`${formatKpi("tokens", card.cost.tokens.input)} / ${formatKpi("tokens", card.cost.tokens.output)} / ${formatKpi("tokens", card.cost.tokens.cached)}`} band={k("cost.tokens.total")} />
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1.5">
              <div className="flex items-center gap-2 mb-1"><Clock className="w-4 h-4 text-sky-400" /><span className="text-sm font-medium text-[var(--color-text-primary)]">Time</span><span className="ml-auto text-base font-semibold tabular-nums">{formatKpi("ms", card.time.wallMs)}</span></div>
              <Row label={`Human wait (${card.time.humanGates} gates)`} value={formatKpi("ms", card.time.humanWaitMs)} band={k("time.humanWaitMs")} />
              <Row label="Active (wall − human)" value={formatKpi("ms", card.time.activeMs)} band={k("time.activeMs")} />
              <Row label="Agent work (Σ tasks)" value={formatKpi("ms", card.time.agentWorkMs)} band={k("time.agentWorkMs")} />
              <Row label="Agents busy (union)" value={formatKpi("ms", card.time.busyMs ?? null)} hint="wall time with at least one agent running" />
              <Row label="Orchestration idle" value={formatKpi("ms", card.time.idleMs)} hint="active − busy: time nothing was running" />
              <Row label="Agent utilization" value={formatKpi("ratio", card.time.agentUtilization)} hint="busy ÷ active" />
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-1.5">
              <div className="flex items-center gap-2 mb-1"><CheckCircle2 className="w-4 h-4 text-emerald-400" /><span className="text-sm font-medium text-[var(--color-text-primary)]">Quality</span><span className="ml-auto text-base font-semibold tabular-nums">{card.quality.loops} loop{card.quality.loops === 1 ? "" : "s"}</span></div>
              <Row label="Outcome" value={card.quality.outcome} />
              <Row label="Agent tasks (done)" value={`${card.quality.tasks} (${card.quality.tasksCompleted})`} band={k("quality.tasks")} />
              <Row label="First-pass yield" value={formatKpi("ratio", card.quality.firstPassYield)} band={k("quality.firstPassYield")} hint="tasks that needed no rework" />
              <Row label="Rework rounds" value={String(card.quality.reworkRounds)} band={k("quality.reworkRounds")} />
              <Row label="Change requests / fix tickets" value={`${card.quality.changeRequests} / ${card.quality.fixTickets}`} band={k("quality.loops")} />
              <Row label="Nudges / interventions" value={`${card.quality.nudges} / ${card.quality.interventions}`} band={k("quality.nudges")} />
              <Row label="Errors / retries" value={`${card.quality.errors} / ${card.quality.retries}`} band={k("quality.errors")} />
              {card.quality.prUrl && (
                <div className="text-xs"><a href={card.quality.prUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1">PR <ExternalLink className="w-3 h-3" /></a></div>
              )}
            </div>
          </div>

          {Object.keys(card.agents).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(card.agents).sort((a, c) => c[1].usd - a[1].usd).map(([id, a]) => (
                <span key={id} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
                  <span className="font-mono text-[var(--color-text-primary)]">{id.replace(/^agentcore_hub_/, "")}</span>
                  {formatKpi("usd", a.usd)} · {formatKpi("ms", a.workMs, true)} · {a.tasks} task{a.tasks === 1 ? "" : "s"}{a.reworkRounds ? ` · ${a.reworkRounds} rework` : ""}
                </span>
              ))}
            </div>
          )}

          {card.dataQuality.gaps.length > 0 && (
            <p className="text-[10px] text-amber-400/80">Data gaps: {card.dataQuality.gaps.join("; ")}</p>
          )}
        </div>
      )}
    </section>
  );
}
