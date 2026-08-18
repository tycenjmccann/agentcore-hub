"use client";

/**
 * Routines tab — scheduled, user-defined workflows.
 *
 * Lists the tenant's routines as cards (enable/disable, run-now, delete) and opens
 * the Routine Builder chat to create new ones. Creation happens conversationally in
 * the harness (it writes the workflow def + persona blueprints and saves the
 * routine record), so this page owns list + lifecycle actions, not a create form.
 */

import { useCallback, useEffect, useState } from "react";
import { Plus, CalendarClock, Sparkles, FormInput, MessageSquare } from "lucide-react";
import RoutineCard from "@/components/routines/RoutineCard";
import RoutineBuilderChat from "@/components/routines/RoutineBuilderChat";
import RoutineForm from "@/components/routines/RoutineForm";
import type { RoutineSummary } from "@/lib/routines/types";

export default function RoutinesPage() {
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  const flash = (message: string, type: "success" | "error" | "info" = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchRoutines = useCallback(async () => {
    try {
      const res = await fetch("/api/routines");
      if (!res.ok) return;
      const data = await res.json();
      setRoutines(data.routines || []);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRoutines();
    const interval = setInterval(fetchRoutines, 8000);
    return () => clearInterval(interval);
  }, [fetchRoutines]);

  const handleToggle = async (routine: RoutineSummary, enabled: boolean) => {
    setBusyId(routine.routineId);
    // Optimistic flip.
    setRoutines((rs) => rs.map((r) => (r.routineId === routine.routineId ? { ...r, enabled } : r)));
    try {
      const res = await fetch(`/api/routines/${routine.routineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error();
      flash(enabled ? "Routine enabled" : "Routine paused", "success");
    } catch {
      setRoutines((rs) => rs.map((r) => (r.routineId === routine.routineId ? { ...r, enabled: !enabled } : r)));
      flash("Failed to update routine", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (routine: RoutineSummary) => {
    setBusyId(routine.routineId);
    try {
      const res = await fetch(`/api/routines/${routine.routineId}/run`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "run failed");
      flash(`Started ${data.workflowId || "workflow"}`, "success");
      setTimeout(fetchRoutines, 1000);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Run failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (routine: RoutineSummary) => {
    if (!confirm(`Delete routine "${routine.name}"? This removes its schedule.`)) return;
    setBusyId(routine.routineId);
    setRoutines((rs) => rs.filter((r) => r.routineId !== routine.routineId));
    try {
      const res = await fetch(`/api/routines/${routine.routineId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      flash("Routine deleted", "success");
    } catch {
      flash("Delete failed", "error");
      fetchRoutines();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-[#8b5cf6]" />
            Routines
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            Schedule your agents to run on a cadence — dead-code sweeps, refactors, weekly reports, and more.
          </p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#8b5cf6] hover:bg-[#7c3aed] text-white text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New routine
        </button>
      </div>

      {loading ? (
        <div className="text-center text-sm text-[var(--color-text-muted)] py-16">Loading routines…</div>
      ) : routines.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 border border-dashed border-[var(--color-border)] rounded-xl">
          <div className="w-14 h-14 rounded-full bg-[#8b5cf6]/10 flex items-center justify-center mb-4">
            <Sparkles className="w-6 h-6 text-[#8b5cf6]" />
          </div>
          <h3 className="text-base font-semibold text-[var(--color-text-primary)] mb-1">No routines yet</h3>
          <p className="text-sm text-[var(--color-text-muted)] max-w-md mb-4">
            Describe a recurring task to the Routine Builder — who does it, what it does, and how often — and it&apos;ll set up the schedule for you.
          </p>
          <button
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#8b5cf6] hover:bg-[#7c3aed] text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Create your first routine
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {routines.map((r) => (
            <RoutineCard
              key={r.routineId}
              routine={r}
              busy={busyId === r.routineId}
              onToggle={handleToggle}
              onRunNow={handleRunNow}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setPickerOpen(false)}>
          <div
            className="w-full max-w-md rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-1">Create a routine</h2>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Use the quick form to schedule an existing workflow, or chat with the builder to design a new one.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setPickerOpen(false); setFormOpen(true); }}
                className="flex flex-col items-center gap-2 rounded-lg border border-[var(--color-border)] hover:border-[#8b5cf6] p-4 text-center transition-colors"
              >
                <FormInput className="w-5 h-5 text-[#8b5cf6]" />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">Quick form</span>
                <span className="text-[11px] text-[var(--color-text-muted)]">Existing workflow + schedule + repo</span>
              </button>
              <button
                onClick={() => { setPickerOpen(false); setChatOpen(true); }}
                className="flex flex-col items-center gap-2 rounded-lg border border-[var(--color-border)] hover:border-[#8b5cf6] p-4 text-center transition-colors"
              >
                <MessageSquare className="w-5 h-5 text-[#8b5cf6]" />
                <span className="text-sm font-medium text-[var(--color-text-primary)]">Chat builder</span>
                <span className="text-[11px] text-[var(--color-text-muted)]">Design a new pipeline conversationally</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {formOpen && (
        <RoutineForm
          onClose={() => setFormOpen(false)}
          onCreated={() => { setFormOpen(false); flash("Routine created", "success"); fetchRoutines(); }}
        />
      )}

      <RoutineBuilderChat
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onTurnComplete={fetchRoutines}
      />

      {toast && (
        <div
          className={`fixed right-5 bottom-5 z-50 px-3 py-2 rounded-lg shadow-lg text-xs font-medium max-w-[280px] ${
            toast.type === "success"
              ? "bg-green-600 text-white"
              : toast.type === "error"
              ? "bg-red-600 text-white"
              : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] border border-[var(--color-border)]"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
