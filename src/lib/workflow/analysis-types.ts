/**
 * Workflow Manager analysis record — shared by API routes and UI.
 *
 * Written by the Workflow Manager harness agent via the schema-validating
 * toolkit (deploy/workflow-manager/toolkit/save_analysis.py) into DynamoDB
 * `agentcore-hub-workflow-analyses` (PK workflowId, SK analysisId).
 * `metrics` is computed deterministically by compute_metrics.py; the rest is
 * authored by the agent.
 */

export type AnalysisTrigger = "auto" | "manual" | "watch";
export type RunOutcome = "complete" | "cancelled" | "error";
export type FindingKind = "bottleneck" | "failure" | "success" | "risk";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type RecommendationPriority = "P0" | "P1" | "P2";
export type RecommendationType =
  | "workflow-def"
  | "prompt"
  | "gate-config"
  | "process"
  | "tooling";

export interface PhaseMetric {
  phase: string;
  enteredAt: string | null;
  exitedAt: string | null;
  durationMs: number | null;
  taskCount: number;
}

export interface AgentTaskMetric {
  ticketId: string;
  agentId: string;
  phase: string | null;
  invokedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  reworkCount: number;
}

export interface HumanReviewMetric {
  gateTicketId: string;
  reviewer: string;
  gateName: string;
  requestedAt: string | null;
  resolvedAt: string | null;
  waitMs: number | null;
  outcome: "approved" | "rejected" | "unresolved";
  cycle: number;
}

export interface ChangeRequestCycle {
  gateTicketId: string;
  rejectedAt: string | null;
  reopenedTickets: string[];
  reworkDurationMs: number | null;
}

export interface ManagerIntervention {
  action: string;
  ticketId?: string | null;
  at: string;
  note?: string | null;
}

export interface WorkflowMetrics {
  startedAt: string | null;
  completedAt: string | null;
  totalDurationMs: number | null;
  phases: PhaseMetric[];
  agentTasks: AgentTaskMetric[];
  humanReviews: HumanReviewMetric[];
  humanWaitTotalMs: number;
  changeRequests: { count: number; cycles: ChangeRequestCycle[] };
  fixTickets: { count: number; ticketIds: string[] };
  nudgeCount: number;
  managerInterventions: ManagerIntervention[];
  errors: Array<{ agentId: string | null; error: string; at: string }>;
  tokens: {
    totalInput: number;
    totalOutput: number;
    byAgent: Record<string, { input: number; output: number }>;
  } | null;
  evalSummaries: Array<{
    agentId: string;
    sessionCount: number;
    avgScores: Record<string, number>;
  }>;
  counts: { tickets: number; events: number; artifacts: number; completions: number };
  dataQuality: {
    ticketProvider: string;
    missingSignals: string[];
    notes: string[];
  };
}

export interface AnalysisScores {
  overall: number;
  planning: number;
  execution: number;
  reviewEfficiency: number;
  reworkDiscipline: number;
}

export interface AnalysisFinding {
  title: string;
  kind: FindingKind;
  severity: FindingSeverity;
  phase?: string | null;
  agentId?: string | null;
  evidence: string;
}

export interface AnalysisRecommendation {
  title: string;
  priority: RecommendationPriority;
  type: RecommendationType;
  target?: string | null;
  description: string;
  expectedImpact: string;
}

export interface AnalysisTrend {
  priorRunsCompared: number;
  deltas: {
    totalDurationMs: number | null;
    humanWaitTotalMs: number | null;
    changeRequests: number | null;
    overallScore: number | null;
  };
  notes: string;
}

export interface WorkflowAnalysis {
  workflowId: string;
  analysisId: string;
  schemaVersion: number;
  workflowDefId: string;
  epicId: string | null;
  analyzedAt: string;
  trigger: AnalysisTrigger;
  runOutcome: RunOutcome;
  model: string;
  s3Prefix: string;
  metrics: WorkflowMetrics;
  scores: AnalysisScores;
  verdict: string;
  findings: AnalysisFinding[];
  recommendations: AnalysisRecommendation[];
  trend: AnalysisTrend;
  summaryMarkdown: string;
}

/** Compact row for def-level trend history (GET /api/workflow/[id]/analysis). */
export interface AnalysisTrendPoint {
  analysisId: string;
  workflowId: string;
  analyzedAt: string;
  runOutcome: RunOutcome;
  overallScore: number | null;
  totalDurationMs: number | null;
  humanWaitTotalMs: number | null;
  changeRequestCount: number | null;
}

export interface AnalysisResponse {
  latest: WorkflowAnalysis | null;
  /** All analyses for this run (newest first, compact — no summaryMarkdown). */
  history: Array<Omit<WorkflowAnalysis, "summaryMarkdown" | "metrics">>;
  /** Def-level trend across runs (newest first). */
  trend: AnalysisTrendPoint[];
}
