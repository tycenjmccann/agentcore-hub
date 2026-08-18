"use client";

/**
 * New Routine — structured intake form (the fast path for the common case:
 * "same cleanup routine across many repos"). Complements the chat builder, which
 * is for novel pipelines that need new personas/connectors. This form only COMPOSES
 * an existing workflow def onto a schedule + input — it does not create agents.
 *
 * Fields: name, description, workflow def, frequency + time, repo (when the def
 * requires one), and connectors to attach. It POSTs to /api/routines just like the
 * builder's save_routine, so both paths converge on the same record + schedule.
 */

import { useEffect, useState } from "react";
import { X, CalendarClock } from "lucide-react";
import { DOW, toScheduleExpression, describeForm, type Frequency, type ScheduleForm } from "@/lib/routines/cron";

interface DefOption {
  id: string;
  name: string;
  description?: string;
  requiresRepo?: boolean;
}
interface ConnOption {
  id: string;
  name: string;
  status: string;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export default function RoutineForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [defs, setDefs] = useState<DefOption[]>([]);
  const [connectors, setConnectors] = useState<ConnOption[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workflowDefId, setWorkflowDefId] = useState("");
  const [freq, setFreq] = useState<Frequency>("weekly");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [pickedConnectors, setPickedConnectors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/routines/definitions")
      .then((r) => r.json())
      .then((d) => {
        setDefs(d.workflows || []);
        if (d.workflows?.[0]) setWorkflowDefId(d.workflows[0].id);
      })
      .catch(() => {});
    fetch("/api/connectors")
      .then((r) => r.json())
      .then((d) => setConnectors(d.connectors || []))
      .catch(() => {});
  }, []);

  const selectedDef = defs.find((d) => d.id === workflowDefId);
  const needsRepo = selectedDef?.requiresRepo;
  const form: ScheduleForm = { frequency: freq, hour, minute, dayOfWeek, dayOfMonth };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const repoConfig = needsRepo && repoUrl.trim()
        ? {
            layout: "multi-repo",
            repos: [{ url: repoUrl.trim(), defaultBranch: branch.trim() || "main", platform: "backend" }],
          }
        : undefined;

      const res = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          workflowDefId,
          schedule: { expression: toScheduleExpression(form), timezone: TZ },
          connectors: pickedConnectors,
          input: {
            titleTemplate: `${name} {date}`,
            description: description || `${name} (scheduled routine)`,
            workflowDefId,
            repoConfig,
            sources: [],
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create routine");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const fieldCls =
    "mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[#8b5cf6]";
  const labelCls = "text-xs font-medium text-[var(--color-text-secondary)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-secondary)]">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-[#8b5cf6]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">New routine</h2>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className={labelCls}>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dead-code sweep" className={fieldCls} />
          </label>

          <label className="block">
            <span className={labelCls}>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Find and remove unused code"
              className={fieldCls}
            />
          </label>

          <label className="block">
            <span className={labelCls}>What it does (workflow)</span>
            <select value={workflowDefId} onChange={(e) => setWorkflowDefId(e.target.value)} className={fieldCls}>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {selectedDef?.description && (
              <span className="text-[11px] text-[var(--color-text-muted)] mt-1 block">{selectedDef.description}</span>
            )}
          </label>

          {/* Frequency + time */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={labelCls}>Frequency</span>
              <select value={freq} onChange={(e) => setFreq(e.target.value as Frequency)} className={fieldCls}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="biweekly">Every other week</option>
                <option value="monthly">Once a month</option>
              </select>
            </label>
            <label className="block">
              <span className={labelCls}>Time ({TZ})</span>
              <div className="mt-1 flex items-center gap-1">
                <select value={hour} onChange={(e) => setHour(+e.target.value)} className={fieldCls}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                  ))}
                </select>
                <span className="text-[var(--color-text-muted)]">:</span>
                <select value={minute} onChange={(e) => setMinute(+e.target.value)} className={fieldCls}>
                  {[0, 15, 30, 45].map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                  ))}
                </select>
              </div>
            </label>
          </div>

          {(freq === "weekly" || freq === "biweekly") && (
            <label className="block">
              <span className={labelCls}>Day of week</span>
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(+e.target.value)} className={fieldCls} disabled={freq === "biweekly"}>
                {DOW.map((d, i) => (
                  <option key={d} value={i}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]}</option>
                ))}
              </select>
            </label>
          )}
          {freq === "monthly" && (
            <label className="block">
              <span className={labelCls}>Day of month (1-28)</span>
              <input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(+e.target.value)}
                className={fieldCls}
              />
            </label>
          )}

          <p className="text-[11px] text-[#8b5cf6]">{describeForm(form)}</p>

          {needsRepo && (
            <div className="grid grid-cols-3 gap-3">
              <label className="block col-span-2">
                <span className={labelCls}>Repository URL</span>
                <input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className={fieldCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Branch</span>
                <input value={branch} onChange={(e) => setBranch(e.target.value)} className={fieldCls} />
              </label>
            </div>
          )}

          {connectors.length > 0 && (
            <div>
              <span className={labelCls}>Connectors (optional)</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {connectors.map((c) => {
                  const on = pickedConnectors.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() =>
                        setPickedConnectors((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))
                      }
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        on
                          ? "bg-[#8b5cf6] text-white border-[#8b5cf6]"
                          : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border-[var(--color-border)]"
                      }`}
                    >
                      {c.name}
                      {c.status === "needs_credentials" && <span className="ml-1 text-amber-400">•</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)] sticky bottom-0 bg-[var(--color-bg-secondary)]">
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!name.trim() || !workflowDefId || (needsRepo && !repoUrl.trim()) || saving}
            className="px-4 py-2 rounded-lg bg-[#8b5cf6] hover:bg-[#7c3aed] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {saving ? "Creating…" : "Create routine"}
          </button>
        </div>
      </div>
    </div>
  );
}
