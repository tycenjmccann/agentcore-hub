"use client";

/**
 * A single routine on the Routines tab: name, cadence, target workflow, last run,
 * an enable/disable toggle, Run-now, and delete. Presentational — all mutations go
 * through callbacks the page owns.
 */

import { CalendarClock, Play, Loader2, Trash2, GitPullRequest } from "lucide-react";
import type { RoutineSummary } from "@/lib/routines/types";
import { describeSchedule } from "@/lib/routines/format";

interface Props {
  routine: RoutineSummary;
  busy?: boolean;
  onToggle: (routine: RoutineSummary, enabled: boolean) => void;
  onRunNow: (routine: RoutineSummary) => void;
  onDelete: (routine: RoutineSummary) => void;
}

export default function RoutineCard({ routine, busy, onToggle, onRunNow, onDelete }: Props) {
  const cadence = describeSchedule(routine.schedule.expression, routine.schedule.timezone);
  const last = routine.lastRun;

  return (
    <div className="rc-card">
      <style>{CARD_STYLES}</style>
      <div className="rc-top">
        <div className="rc-title-wrap">
          <CalendarClock size={15} className="rc-icon" />
          <span className="rc-name">{routine.name}</span>
        </div>
        <label className="rc-switch" title={routine.enabled ? "Enabled" : "Paused"}>
          <input
            type="checkbox"
            checked={routine.enabled}
            disabled={busy}
            onChange={(e) => onToggle(routine, e.target.checked)}
          />
          <span className="rc-slider" />
        </label>
      </div>

      {routine.description && <p className="rc-desc">{routine.description}</p>}

      <div className="rc-meta">
        <span className="rc-badge"><CalendarClock size={11} /> {cadence}</span>
        <span className="rc-badge rc-muted"><GitPullRequest size={11} /> {routine.workflowDefId}</span>
      </div>

      <div className="rc-lastrun">
        {last ? (
          last.status === "started" ? (
            <span className="rc-ok">Last run {relTime(last.at)} → {last.workflowId || "started"}</span>
          ) : (
            <span className="rc-err">Last run {relTime(last.at)} failed{last.error ? `: ${last.error}` : ""}</span>
          )
        ) : (
          <span className="rc-muted-text">Not run yet</span>
        )}
      </div>

      <div className="rc-actions">
        <button className="rc-btn rc-run" disabled={busy} onClick={() => onRunNow(routine)}>
          {busy ? <Loader2 size={13} className="rc-spin" /> : <Play size={13} />} Run now
        </button>
        <button className="rc-btn rc-del" disabled={busy} onClick={() => onDelete(routine)} aria-label={`Delete routine ${routine.name}`}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return "";
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const CARD_STYLES = `
.rc-card{border:1px solid var(--color-border);border-radius:12px;padding:14px 16px;
  background:var(--color-bg-secondary);display:flex;flex-direction:column;gap:10px}
.rc-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rc-title-wrap{display:flex;align-items:center;gap:8px;min-width:0}
.rc-icon{color:#8b5cf6;flex-shrink:0}
.rc-name{font-weight:600;font-size:14px;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-desc{font-size:12px;color:var(--color-text-muted);margin:0;line-height:1.4}
.rc-meta{display:flex;flex-wrap:wrap;gap:6px}
.rc-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:6px;
  background:rgba(139,92,246,0.1);color:#a78bfa;border:1px solid rgba(139,92,246,0.25)}
.rc-badge.rc-muted{background:rgba(255,255,255,0.04);color:var(--color-text-muted);border-color:var(--color-border)}
.rc-lastrun{font-size:11px}
.rc-ok{color:#4ade80}
.rc-err{color:#f87171}
.rc-muted-text{color:var(--color-text-muted)}
.rc-actions{display:flex;gap:8px;align-items:center}
.rc-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;padding:6px 12px;
  border-radius:8px;border:1px solid var(--color-border);background:var(--color-bg-tertiary);
  color:var(--color-text-primary);cursor:pointer}
.rc-btn:disabled{opacity:0.5;cursor:default}
.rc-run{border-color:rgba(139,92,246,0.4);background:rgba(139,92,246,0.12);color:#a78bfa}
.rc-run:hover:not(:disabled){background:rgba(139,92,246,0.2)}
.rc-del{margin-left:auto;color:var(--color-text-muted)}
.rc-del:hover:not(:disabled){color:#f87171;border-color:rgba(248,113,113,0.4)}
.rc-spin{animation:rcspin 1s linear infinite}
@keyframes rcspin{to{transform:rotate(360deg)}}
/* toggle */
.rc-switch{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0}
.rc-switch input{opacity:0;width:0;height:0}
.rc-slider{position:absolute;inset:0;cursor:pointer;background:var(--color-bg-tertiary);
  border:1px solid var(--color-border);border-radius:20px;transition:.2s}
.rc-slider:before{content:"";position:absolute;height:14px;width:14px;left:2px;top:2px;
  background:var(--color-text-muted);border-radius:50%;transition:.2s}
.rc-switch input:checked + .rc-slider{background:rgba(139,92,246,0.3);border-color:rgba(139,92,246,0.5)}
.rc-switch input:checked + .rc-slider:before{transform:translateX(16px);background:#a78bfa}
.rc-switch input:disabled + .rc-slider{opacity:0.5;cursor:default}
`;
