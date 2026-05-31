"use client";

import type { WorkflowPhase } from "@/lib/workflow/types";

interface StatusBarProps {
  phase: WorkflowPhase;
  isConnected: boolean;
}

const PHASE_DISPLAY: Record<WorkflowPhase, { label: string; description: string }> = {
  intake: { label: "Intake", description: "Processing input sources" },
  requirements: { label: "Requirements", description: "Analyzing & creating tickets" },
  design: { label: "Design", description: "Designing architecture & UI" },
  development: { label: "Development", description: "Implementing features" },
  verification: { label: "Verification", description: "Testing & QA" },
  review: { label: "Review", description: "Verifying & validating" },
  complete: { label: "Complete", description: "Workflow finished successfully" },
  error: { label: "Error", description: "Workflow encountered an error" },
  cancelled: { label: "Cancelled", description: "Workflow was manually cancelled" },
};

export default function StatusBar({ phase, isConnected }: StatusBarProps) {
  const display = PHASE_DISPLAY[phase] || { label: phase, description: "" };

  const phaseNameClass = [
    "status-phase-name",
    phase === "complete" ? "complete" : "",
    phase === "error" ? "error" : "",
    phase === "cancelled" ? "cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="pipeline-status-bar">
      <div className="flex items-center gap-3">
        <span className={phaseNameClass}>{display.label}</span>
        <span className="status-description">{display.description}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            isConnected ? "bg-green-400" : "bg-yellow-400 animate-pulse"
          }`}
        />
        <span className="text-[11px] text-[var(--pipeline-text-dim)]">
          {isConnected ? "Live" : "Reconnecting..."}
        </span>
      </div>
    </div>
  );
}
