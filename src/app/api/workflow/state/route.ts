import { NextResponse } from "next/server";
import type { WorkflowState } from "@/lib/workflow/types";

/**
 * GET /api/workflow/state
 * Returns the current workflow state. In production this reads from DynamoDB/S3.
 * For now, returns a demo state to drive the pipeline visualization.
 */
export async function GET() {
  const demoState: WorkflowState = getDemoWorkflowState();
  return NextResponse.json(demoState);
}

function getDemoWorkflowState(): WorkflowState {
  // Cycle through phases for demo purposes based on time
  const phases: WorkflowState["phase"][] = [
    "intake",
    "requirements",
    "design",
    "development",
    "review",
    "complete",
  ];

  // Each phase lasts 10 seconds in demo mode (60s full cycle)
  const cycleTime = 60_000;
  const elapsed = Date.now() % cycleTime;
  const phaseIdx = Math.min(
    Math.floor(elapsed / (cycleTime / phases.length)),
    phases.length - 1
  );
  const currentPhase = phases[phaseIdx];

  return {
    id: "wf_demo_001",
    phase: currentPhase,
    epicId: "TEAM-1",
    repoConfig: {
      layout: "monorepo",
      repos: [
        {
          url: "https://github.com/your-org/your-repo",
          defaultBranch: "main",
          platform: "shared",
        },
      ],
    },
    input: {
      title: "Pipeline Visualization Feature",
      description: "Replace WorkflowBoard with animated pipeline visualization",
      repoConfig: {
        layout: "monorepo",
        repos: [
          {
            url: "https://github.com/your-org/your-repo",
            defaultBranch: "main",
            platform: "shared",
          },
        ],
      },
      sources: [],
    },
    agentTasks: buildDemoAgentTasks(currentPhase),
    messages: [],
    humanNotifications: [],
    startedAt: new Date(Date.now() - elapsed).toISOString(),
    completedAt: currentPhase === "complete" ? new Date().toISOString() : undefined,
    featureBranch: "feature/TEAM-159-frontend-dev",
  };
}

function buildDemoAgentTasks(
  phase: WorkflowState["phase"]
): WorkflowState["agentTasks"] {
  const tasks: WorkflowState["agentTasks"] = {};

  const designAgents = [
    "agentcore_hub_ios_designer",
    "agentcore_hub_android_designer",
    "agentcore_hub_backend_designer",
    "agentcore_hub_security_reviewer",
    "agentcore_hub_analytics_designer",
    "agentcore_hub_localization",
    "agentcore_hub_legal_compliance",
  ];

  const devAgents = ["agentcore_hub_frontend_dev", "agentcore_hub_backend_dev", "agentcore_hub_api_dev"];

  if (
    phase === "requirements" ||
    phase === "design" ||
    phase === "development" ||
    phase === "review" ||
    phase === "complete"
  ) {
    tasks["agentcore_hub_requirements_analyst"] = {
      id: "task-req-1",
      agentId: "agentcore_hub_requirements_analyst",
      ticketId: "TEAM-1",
      status: phase === "requirements" ? "running" : "complete",
      input: "Analyze PRD and create tickets",
      startedAt: new Date().toISOString(),
      completedAt: phase !== "requirements" ? new Date().toISOString() : undefined,
    };
  }

  if (
    phase === "design" ||
    phase === "development" ||
    phase === "review" ||
    phase === "complete"
  ) {
    designAgents.forEach((agentId, idx) => {
      tasks[agentId] = {
        id: `task-design-${idx}`,
        agentId,
        ticketId: `TEAM-${idx + 10}`,
        status: phase === "design" ? "running" : "complete",
        input: "Create design document",
        startedAt: new Date().toISOString(),
        completedAt: phase !== "design" ? new Date().toISOString() : undefined,
      };
    });
  }

  if (phase === "development" || phase === "review" || phase === "complete") {
    devAgents.forEach((agentId, idx) => {
      tasks[agentId] = {
        id: `task-dev-${idx}`,
        agentId,
        ticketId: `TEAM-${idx + 20}`,
        status: phase === "development" ? "running" : "complete",
        input: "Implement feature",
        branch: `feature/TEAM-${idx + 20}`,
        startedAt: new Date().toISOString(),
        completedAt: phase !== "development" ? new Date().toISOString() : undefined,
      };
    });
  }

  return tasks;
}
