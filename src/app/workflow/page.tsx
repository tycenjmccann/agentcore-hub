"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Plus, Play, Radio, Zap, ChevronLeft, ChevronRight, FlaskConical, Archive, Trash2 } from "lucide-react";
import WorkflowBoard from "@/components/workflow/WorkflowBoard";
import IntakeForm from "@/components/workflow/IntakeForm";
import type { WorkflowState, WorkflowInput } from "@/lib/workflow/types";
import { WORKFLOW_DEFS, DEFAULT_WORKFLOW_DEF_ID } from "@/lib/workflow/workflow-defs";
import DeleteConfirmationModal from "@/components/workflow/DeleteConfirmationModal";

interface WorkflowSummary {
  id: string;
  phase: string;
  epicId: string;
  input: { title: string; description: string };
  startedAt: string;
  completedAt?: string;
  workflowType?: "feature" | "bug";
}

function BugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
      <path clipRule="evenodd"
        d="m8 2.5c-.82843 0-1.5.67157-1.5 1.5h3c0-.82843-.67157-1.5-1.5-1.5zm3 1.52074v-.02074c0-1.65685-1.34315-3-3-3s-3 1.34315-3 3v.02074c-.29048.04873-.55266.18096-.761.37115l-.88669-.63334-.91695-2.06315-1.37072.6092.94464 2.12544c.09062.20389.23416.37981.41572.50949l1.325.94643v1.11404h-3.25v1.5h3.25v1.14872l-1.14979.95818c-.13248.1104-.24068.247-.3178.4012l-1.20323 2.4065 1.34164.6708 1.17984-2.3597.46058-.3838c.63558 1.5764 2.17703 2.6581 3.94022 2.6581h.24854c1.71908 0 3.1849-1.0844 3.7506-2.6066l.3987.3323 1.1799 2.3597 1.3416-.6708-1.2032-2.4065c-.0771-.1542-.1853-.2908-.3178-.4012l-1.1498-.95818v-1.14872h3.25v-1.5h-3.25v-1.11404l1.325-.94643c.1816-.12968.3251-.3056.4157-.50949l.9447-2.12544-1.3708-.6092-.9169 2.06315-.8867.63334c-.2083-.19019-.4705-.32242-.761-.37115zm-.25 5.97926v-4.5h-5.5v4.44265l.03488.22675c.20629 1.3408 1.35998 2.3306 2.71658 2.3306h.24854c1.38071 0 2.5-1.1193 2.5-2.5z"
        fill="#f15b50" fillRule="evenodd"/>
    </svg>
  );
}

export default function WorkflowPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showIntake, setShowIntake] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nudgeToast, setNudgeToast] = useState<{ message: string; type: "success" | "info" | "error" } | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [testDefId, setTestDefId] = useState<string>(DEFAULT_WORKFLOW_DEF_ID);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('workflow-history-collapsed');
    if (stored !== null) setHistoryCollapsed(stored === 'true');
  }, []);

  const toggleHistory = () => {
    const next = !historyCollapsed;
    setHistoryCollapsed(next);
    localStorage.setItem('workflow-history-collapsed', String(next));
  };

  // Update header with selected workflow title
  useEffect(() => {
    const selected = workflows.find((w) => w.id === selectedId);
    const title = selected ? `Workflow: ${selected.input.title}` : null;
    window.dispatchEvent(new CustomEvent("header-title", { detail: title }));
  }, [selectedId, workflows]);

  // Load workflow list
  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch("/api/workflow/list");
      if (!res.ok) return;
      const data = await res.json();
      const list: WorkflowSummary[] = (data.workflows || []).map((w: WorkflowState) => ({
        id: w.id,
        phase: w.phase,
        epicId: w.epicId,
        input: { title: w.input.title, description: w.input.description },
        startedAt: w.startedAt,
        completedAt: w.completedAt,
        workflowType: w.workflowType,
      }));
      // Sort: active first, then by date descending
      list.sort((a, b) => {
        const aActive = a.phase !== "complete" && a.phase !== "error" && a.phase !== "cancelled";
        const bActive = b.phase !== "complete" && b.phase !== "error" && b.phase !== "cancelled";
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      });
      setWorkflows(list);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchWorkflows();
    const interval = setInterval(fetchWorkflows, 5000);
    return () => clearInterval(interval);
  }, [fetchWorkflows]);

  // Check URL for pre-selected workflow
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) {
      setSelectedId(id);
      setShowIntake(false);
    }
  }, []);

  // Handle new workflow submission
  const handleSubmit = async (input: WorkflowInput) => {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/workflow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error("Failed to start workflow");
      const data = await res.json();
      const newId = data.workflowId || data.id;
      if (newId) {
        setSelectedId(newId);
        setShowIntake(false);
        // Update URL without reload
        window.history.pushState({}, "", `/workflow?id=${newId}`);
        // Refresh list
        setTimeout(fetchWorkflows, 1000);
      }
    } catch (err) {
      console.error("Failed to start workflow:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter workflows by search
  const filtered = workflows.filter((w) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      w.input.title.toLowerCase().includes(q) ||
      w.epicId.toLowerCase().includes(q) ||
      w.id.toLowerCase().includes(q)
    );
  });

  const activeWorkflows = filtered.filter((w) => w.phase !== "complete" && w.phase !== "error" && w.phase !== "cancelled");
  const pastWorkflows = filtered.filter((w) => w.phase === "complete" || w.phase === "error" || w.phase === "cancelled");

  const handleSelectWorkflow = (id: string) => {
    setSelectedId(id);
    setShowIntake(false);
    window.history.pushState({}, "", `/workflow?id=${id}`);
  };

  const handleNewWorkflow = () => {
    setSelectedId(null);
    setShowIntake(true);
    window.history.pushState({}, "", "/workflow");
  };

  const handleTestWorkflow = async () => {
    setIsSubmitting(true);
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const def = WORKFLOW_DEFS.find((w) => w.id === testDefId) ?? WORKFLOW_DEFS[0];
      const res = await fetch("/api/workflow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${def.name} Connectivity Check ${hhmm}`,
          description: E2E_TEST_DESCRIPTION,
          workflowDefId: def.id,
          sources: [],
          repoConfig: {
            repos: [{ url: TEST_REPO_URL, defaultBranch: "main" }],
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to start test workflow");
      const data = await res.json();
      const newId = data.workflowId || data.id;
      if (newId) {
        setSelectedId(newId);
        setShowIntake(false);
        window.history.pushState({}, "", `/workflow?id=${newId}`);
        setTimeout(fetchWorkflows, 1000);
      }
    } catch (err) {
      console.error("Failed to start test workflow:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNudge = async (id: string) => {
    try {
      const res = await fetch(`/api/workflow/${id}/nudge`, { method: "POST" });
      const data = await res.json();
      if (data.nudged?.length > 0) {
        setNudgeToast({ message: `Fixed ${data.nudged.length} stuck ticket(s)`, type: "success" });
      } else {
        setNudgeToast({ message: "All tickets healthy — nothing to fix", type: "info" });
      }
    } catch {
      setNudgeToast({ message: "Nudge failed — check connection", type: "error" });
    }
    setTimeout(() => setNudgeToast(null), 4000);
  };

  const handleArchive = async (id: string) => {
    try {
      const res = await fetch(`/api/workflow/${id}/archive`, { method: "PATCH" });
      if (res.ok) {
        await fetchWorkflows();
      }
    } catch {
      /* silent */
    }
  };

  const handleDeleteWorkflow = async () => {
    if (!deleteTargetId) return;
    setDeleteLoading(true);
    setDeleteError(null);

    // Save the workflow for potential rollback
    const targetWorkflow = workflows.find((w) => w.id === deleteTargetId);

    // Optimistic update: remove from list immediately
    setWorkflows((prev) => prev.filter((w) => w.id !== deleteTargetId));

    // Clear selection if the deleted workflow was selected
    if (selectedId === deleteTargetId) {
      setSelectedId(null);
      window.history.pushState({}, "", "/workflow");
    }

    try {
      const res = await fetch(`/api/workflow/${deleteTargetId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Delete failed" }));
        throw new Error(data.error || "Delete failed");
      }

      // Success
      setDeleteTargetId(null);
      setNudgeToast({ message: "Workflow deleted", type: "success" });
      setTimeout(() => setNudgeToast(null), 4000);
    } catch (err) {
      // Rollback: re-add the workflow
      if (targetWorkflow) {
        setWorkflows((prev) => {
          const updated = [...prev, targetWorkflow];
          // Re-sort: active first, then by date descending
          updated.sort((a, b) => {
            const aActive = a.phase !== "complete" && a.phase !== "error" && a.phase !== "cancelled";
            const bActive = b.phase !== "complete" && b.phase !== "error" && b.phase !== "cancelled";
            if (aActive && !bActive) return -1;
            if (!aActive && bActive) return 1;
            return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
          });
          return updated;
        });
      }
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setNudgeToast({ message: "Delete failed — workflow may still be running", type: "error" });
      setTimeout(() => setNudgeToast(null), 4000);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-64px)] -m-6">
      {/* Left Sidebar — Epic History */}
      <div className={`${historyCollapsed ? 'w-8' : 'w-72'} transition-all duration-300 border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex flex-col flex-shrink-0 overflow-hidden`}>
        {historyCollapsed ? (
          <div className="flex flex-col items-center pt-3 h-full">
            <button onClick={toggleHistory} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]" aria-label="Expand workflow history sidebar">
              <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)]" />
            </button>
            <span className="mt-4 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider" style={{ writingMode: 'vertical-rl' }}>
              Workflows
            </span>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="p-4 border-b border-[var(--color-border)]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1">
                  <button onClick={toggleHistory} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]" aria-label="Collapse workflow history sidebar">
                    <ChevronLeft className="w-4 h-4 text-[var(--color-text-muted)]" />
                  </button>
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Workflows</h2>
                </div>
                <button
                  onClick={handleNewWorkflow}
                  className="p-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                  title="New Workflow"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search epics..."
                  className="w-full pl-8 pr-3 py-1.5 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* Workflow List */}
            <div className="flex-1 overflow-y-auto">
              {/* Active Runs */}
              {activeWorkflows.length > 0 && (
                <div className="p-2">
                  <p className="px-2 py-1 text-[10px] font-semibold text-green-400 uppercase tracking-wider">
                    Active
                  </p>
                  {activeWorkflows.map((w) => (
                    <WorkflowListItem
                      key={w.id}
                      workflow={w}
                      isSelected={selectedId === w.id}
                      isActive
                      onClick={() => handleSelectWorkflow(w.id)}
                      onNudge={handleNudge}
                      onArchive={handleArchive}
                    />
                  ))}
                </div>
              )}

              {/* Past Runs */}
              {pastWorkflows.length > 0 && (
                <div className="p-2">
                  <p className="px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    Completed
                  </p>
                  {pastWorkflows.map((w) => (
                    <WorkflowListItem
                      key={w.id}
                      workflow={w}
                      isSelected={selectedId === w.id}
                      onClick={() => handleSelectWorkflow(w.id)}
                      onArchive={handleArchive}
                      onDelete={(id) => { setDeleteTargetId(id); setDeleteError(null); }}
                    />
                  ))}
                </div>
              )}

              {filtered.length === 0 && (
                <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                  {searchQuery ? "No matching workflows" : "No workflows yet"}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {showIntake ? (
          <div className="p-8">
            <IntakeForm onSubmit={handleSubmit} isLoading={isSubmitting} />
          </div>
        ) : selectedId ? (
          <WorkflowBoard key={selectedId} workflowId={selectedId} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-16 h-16 rounded-full bg-blue-600/10 flex items-center justify-center mb-4">
              <Play className="w-7 h-7 text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
              Select a workflow or start a new one
            </h3>
            <p className="text-sm text-[var(--color-text-muted)] max-w-md mb-4">
              Choose a past run from the sidebar to view its pipeline state, or create a new workflow to watch agents work in real-time.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleNewWorkflow}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors"
              >
                New Workflow
              </button>
              <div className="flex items-center rounded-lg overflow-hidden border border-amber-600/40">
                <select
                  value={testDefId}
                  onChange={(e) => setTestDefId(e.target.value)}
                  disabled={isSubmitting}
                  aria-label="Workflow to test"
                  className="px-3 py-2 bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] text-sm font-medium border-r border-amber-600/40 focus:outline-none disabled:opacity-50"
                >
                  {WORKFLOW_DEFS.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleTestWorkflow}
                  disabled={isSubmitting}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600/80 text-white text-sm font-medium hover:bg-amber-500 transition-colors disabled:opacity-50"
                >
                  <FlaskConical className="w-4 h-4" />
                  Test Workflow
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={deleteTargetId !== null}
        onClose={() => { setDeleteTargetId(null); setDeleteError(null); }}
        onConfirm={handleDeleteWorkflow}
        isLoading={deleteLoading}
        error={deleteError}
      />

      {/* Nudge Toast — positioned in the sidebar near the nudge buttons */}
      {nudgeToast && (
        <div className={`absolute left-4 bottom-4 px-3 py-2 rounded-lg shadow-lg text-xs font-medium z-50 max-w-[260px] ${
          nudgeToast.type === "success" ? "bg-green-600 text-white" :
          nudgeToast.type === "error" ? "bg-red-600 text-white" :
          "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] border border-[var(--color-border)]"
        }`}>
          {nudgeToast.type === "success" && "⚡ "}
          {nudgeToast.message}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar List Item ──────────────────────────────────────────────────────

function WorkflowListItem({
  workflow,
  isSelected,
  isActive,
  onClick,
  onNudge,
  onArchive,
  onDelete,
}: {
  workflow: WorkflowSummary;
  isSelected: boolean;
  isActive?: boolean;
  onClick: () => void;
  onNudge?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const isBug = workflow.workflowType === "bug";
  const isRunning = workflow.phase !== "complete" && workflow.phase !== "error" && workflow.phase !== "cancelled";
  const timeStr = formatRelativeTime(workflow.startedAt);

  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 py-2.5 rounded-lg mb-1 transition-all cursor-pointer ${
        isSelected
          ? "bg-blue-600/15 border border-blue-500/30"
          : "hover:bg-[var(--color-bg-tertiary)] border border-transparent"
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Status indicator */}
        <div className="mt-1 flex-shrink-0">
          {isRunning ? (
            <div className="relative">
              <Radio className="w-3.5 h-3.5 text-green-400" />
              <div className="absolute inset-0 animate-ping">
                <Radio className="w-3.5 h-3.5 text-green-400 opacity-30" />
              </div>
            </div>
          ) : workflow.phase === "error" ? (
            <div className="w-2 h-2 rounded-full bg-red-500 mt-0.5" />
          ) : workflow.phase === "cancelled" ? (
            <div className="w-2 h-2 rounded-full bg-amber-500/60 mt-0.5" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-green-500/60 mt-0.5" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isBug && <BugIcon className="w-3.5 h-3.5 flex-shrink-0" />}
            <p className="text-xs font-medium text-[var(--color-text-primary)] truncate">
              {workflow.input.title}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-blue-400 font-mono">{workflow.epicId}</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">{timeStr}</span>
          </div>
          {isRunning && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 font-medium uppercase tracking-wider">
                {workflow.phase}
              </span>
              {onNudge && (
                <button
                  onClick={(e) => { e.stopPropagation(); onNudge(workflow.id); }}
                  className="p-0.5 rounded hover:bg-amber-500/20 text-[var(--color-text-muted)] hover:text-amber-400 transition-colors"
                  title="Nudge — unstick any stuck tickets"
                >
                  <Zap className="w-3 h-3" />
                </button>
              )}
              {/* No archive while running — archiving hides a workflow mid-flight
                  while its agents keep working. Cancel it first, then archive. */}
            </div>
          )}
          {!isRunning && workflow.phase === "cancelled" && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium uppercase tracking-wider">
                Cancelled
              </span>
              {onArchive && (
                <button
                  onClick={(e) => { e.stopPropagation(); onArchive(workflow.id); }}
                  className="p-0.5 rounded hover:bg-orange-500/20 text-[var(--color-text-muted)] hover:text-orange-400 transition-colors"
                  title="Archive workflow"
                >
                  <Archive className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {!isRunning && workflow.phase !== "cancelled" && onArchive && (
            <div className="mt-1 flex items-center gap-1.5">
              <button
                onClick={(e) => { e.stopPropagation(); onArchive(workflow.id); }}
                className="p-0.5 rounded hover:bg-orange-500/20 text-[var(--color-text-muted)] hover:text-orange-400 transition-colors"
                title="Archive workflow"
              >
                <Archive className="w-3 h-3" />
              </button>
            </div>
          )}
          {!isRunning && onDelete && (
            <div className="flex justify-end mt-1">
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(workflow.id); }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-[var(--color-text-muted)] hover:text-red-400 transition-all"
                title="Delete workflow"
                aria-label={`Delete workflow: ${workflow.input.title}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  if (!isoString) return "";
  const now = Date.now();
  const then = new Date(isoString).getTime();
  if (isNaN(then)) return "";
  const diff = now - then;

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(isoString).toLocaleDateString();
}

// ─── E2E Test Workflow Description ─────────────────────────────────────────
// Mirror of scripts/test-ticket-flow.sh DESC. Keep in sync — the button is the
// in-app version of that curl call.

const TEST_REPO_URL =
  process.env.NEXT_PUBLIC_TEST_REPO_URL || "https://github.com/octocat/Hello-World";

const E2E_TEST_DESCRIPTION = `## Workflow End-to-End Connectivity Test

This is a workflow end-to-end test. Do NOT do any real work for the workflow's normal purpose — the only goal is to prove every agent in THIS workflow can be reached, can load its skill, can touch its tools, and can complete its ticket.

You are the intake agent. Look at the \`## Available Agents\` list in your context — those are the agents in this workflow, each with its phase. Design and run a connectivity check FOR THIS WORKFLOW using exactly that roster. Do not assume any specific set of agents; use the ones you were actually given.

---

## YOUR STEPS (intake agent):

1. Load your own skill.
2. For EACH agent in \`## Available Agents\`, create one ticket with \`Tickets___create_ticket\`:
   - summary = "<phase>: <agentId> — connectivity check"
   - assignee = that agentId
   - blocked_by = wire the dependency graph by phase order: the earliest phase's tickets are blocked only by YOUR intake ticket; each later phase's tickets are blocked by the ticket(s) of the immediately preceding phase. (This recreates the natural pipeline order for whatever workflow this is.)
   - description = the per-agent connectivity instructions below (fill in {agentId} and {skill}).
3. Save artifact to S3: \`workflows/{workflowId}/agents/{yourAgentId}/test-pass.md\` with content "Intake connectivity check — created N tickets".
4. Call \`WorkflowOutput___report_completion\`.

If a downstream agent's normal job is to CREATE tickets for a later phase (e.g. a QA/verifier that opens a follow-up ticket), instruct it to do that small ticket-creation as its task rather than skipping the phase.

---

## PER-AGENT TICKET DESCRIPTION TEMPLATE (put this in each ticket you create):

\`\`\`
Connectivity check — {agentId}:
1. Load your skill ({skill}).
2. Touch ONE of your tools to prove access and capture a short proof:
   - If you have GitHub/git tools: run \`git ls-remote ${TEST_REPO_URL}\` and capture the first few refs.
   - Otherwise touch any one tool you have (e.g. current_time, http_request, an S3 list) and capture its output.
3. Save to S3: workflows/{workflowId}/agents/{agentId}/test-pass.md — include the proof output and "connectivity confirmed".
4. Call WorkflowOutput___report_completion.
Do not do real work. Do not write code. Do not clone repos. Keep it to one tiny task.
\`\`\`

---

## EXPECTED FLOW:
Intake → (each phase in order, fanned out per the roster) → final phase → Complete`;

