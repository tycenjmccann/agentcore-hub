"use client";

import { useCallback, useEffect, useState } from "react";
import { Rocket, Loader2, RefreshCw, ExternalLink, CheckCircle2, XCircle, Clock, CircleDashed } from "lucide-react";

interface CiBuild {
  id: string;
  status: string;
  sourceVersion?: string;
  startedAt?: string;
  endedAt?: string;
  logUrl?: string;
}
interface StageState {
  name: string;
  status: string;
  lastUpdated?: string;
  revisionSummary?: string;
}
interface PipelineStatus {
  enabled: boolean;
  region: string;
  ciProject: string;
  deployPipeline: string;
  recentBuilds: CiBuild[];
  stages: StageState[];
  error?: string;
}

function statusIcon(s: string) {
  const v = s.toLowerCase();
  if (v.includes("succeed")) return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (v.includes("fail") || v.includes("fault") || v.includes("timed")) return <XCircle className="w-4 h-4 text-red-400" />;
  if (v.includes("progress")) return <Loader2 className="w-4 h-4 text-brand-400 animate-spin" />;
  return <CircleDashed className="w-4 h-4 text-[var(--color-text-muted)]" />;
}

export default function PipelinePage() {
  const [data, setData] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/pipeline/status", { cache: "no-store" });
      setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Rocket className="w-6 h-6 text-brand-400" />
          <div>
            <h1 className="text-xl font-bold text-[var(--color-text-primary)]">CI/CD Pipeline</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">
              CodeBuild PR checks + CodePipeline deploy. AWS-native, build-once/promote-by-digest.
            </p>
          </div>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-surface-3 hover:bg-surface-4 text-[var(--color-text-primary)]"
        >
          <RefreshCw className={loading ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading pipeline state…
        </div>
      )}

      {data?.error && (
        <div className="mb-6 rounded-lg border border-yellow-600/30 bg-yellow-600/10 p-4 text-sm text-yellow-300">
          Pipeline infra not reachable in <code>{data.region}</code>: {data.error}
          <div className="mt-1 text-[var(--color-text-muted)]">
            Deploy it with <code>deploy/pipeline/deploy.sh</code> (optional module).
          </div>
        </div>
      )}

      {data && (
        <>
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide mb-3">
              Deploy pipeline — {data.deployPipeline}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {data.stages.length === 0 && (
                <div className="text-sm text-[var(--color-text-muted)]">No stage state yet.</div>
              )}
              {data.stages.map((s) => (
                <div key={s.name} className="rounded-lg border border-surface-4 bg-surface-2 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-[var(--color-text-primary)]">{s.name}</span>
                    {statusIcon(s.status)}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{s.status}</div>
                  {s.revisionSummary && (
                    <div className="text-xs text-[var(--color-text-muted)] mt-1 font-mono">{s.revisionSummary}</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide mb-3">
              CI checks — {data.ciProject}
            </h2>
            <div className="rounded-lg border border-surface-4 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-3 text-[var(--color-text-secondary)]">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Source</th>
                    <th className="text-left px-4 py-2 font-medium">Started</th>
                    <th className="text-left px-4 py-2 font-medium">Log</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentBuilds.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                        No builds yet.
                      </td>
                    </tr>
                  )}
                  {data.recentBuilds.map((b) => (
                    <tr key={b.id} className="border-t border-surface-4">
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2">{statusIcon(b.status)} {b.status}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
                        {b.sourceVersion || "—"}
                      </td>
                      <td className="px-4 py-2 text-[var(--color-text-muted)] text-xs">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {b.logUrl ? (
                          <a href={b.logUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-brand-400 hover:underline text-xs">
                            <ExternalLink className="w-3 h-3" /> logs
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
