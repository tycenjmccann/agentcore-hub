"use client";

import type { AgentTask } from "@/lib/workflow/types";

interface AgentItemProps {
  task: AgentTask;
  isCelebrating: boolean;
  onClick: () => void;
}

/** Format agent ID to display name: "agentcore_hub_ios_designer" -> "iOS Designer" */
function formatAgentName(agentId: string): string {
  return agentId
    .replace(/^agentcore_hub_/, "")
    .split(/[_-]/)
    .map((word) => {
      const upper = word.toUpperCase();
      if (["IOS", "API", "UI", "QA"].includes(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export default function AgentItem({ task, isCelebrating, onClick }: AgentItemProps) {
  const statusClass = (() => {
    switch (task.status) {
      case "running":
      case "waiting_response":
        return "working";
      case "complete":
        return "done";
      case "error":
        return "error";
      default:
        return "";
    }
  })();

  const itemClassName = [
    "agent-item",
    statusClass,
    isCelebrating ? "celebrate" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const dotClassName = [
    "agent-status-dot",
    statusClass,
    isCelebrating ? "celebrate" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const nameClassName = ["agent-name", statusClass].filter(Boolean).join(" ");

  return (
    <div
      className={itemClassName}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      title={`${formatAgentName(task.agentId)} — ${task.status}`}
    >
      <span className={dotClassName} />
      <span className={nameClassName}>{formatAgentName(task.agentId)}</span>
      {task.status === "running" && (
        <span className="text-[10px] text-[var(--pipeline-active)] ml-auto">
          running
        </span>
      )}
      {task.status === "complete" && (
        <span className="text-[10px] text-[var(--pipeline-done)] ml-auto">
          done
        </span>
      )}
      {task.status === "error" && (
        <span className="text-[10px] text-[var(--pipeline-error)] ml-auto">
          error
        </span>
      )}
    </div>
  );
}
