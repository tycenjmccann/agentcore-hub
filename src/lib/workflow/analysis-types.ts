/**
 * Workflow Manager analysis record — shared by API routes and UI.
 *
 * Written by the Workflow Manager harness agent via the schema-validating
 * toolkit (deploy/workflow-manager/toolkit/save_analysis.py) into DynamoDB
 * `agentcore-hub-workflow-analyses` (PK workflowId, SK analysisId).
 * `metrics` is computed deterministically by compute_metrics.py; the rest is
 * authored by the agent.
 */

import type { ShipBlockedOutcome } from "./types";

export type AnalysisTrigger = "auto" | "manual" | "watch";
// TEAM-3747 D2 — additively includes the lifecycle-integrity terminal outcomes
// ("deploy-blocked" | "static-ci-only") so a blocked run is analyzed HONESTLY
// rather than recorded as "complete". Legacy analyses (only complete/cancelled/
// error) are unaffected. Parity: save_analysis.py RUN_OUTCOMES + WorkflowPhase.
export type RunOutcome = "complete" | "cancelled" | "error" | ShipBlockedOutcome;
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
  /** TEAM-4121 FR-10 — the human was ASKED outside WM_BUSINESS_HOURS/TZ (weekend
   * or outside the local window). Optional: metrics.json files written before
   * that change do not carry it. */
  outsideHours?: boolean | null;
}

/** TEAM-4121 FR-10 — one fix ticket's lineage. `tag` is why the run filed it:
 * `new` (a defect nobody had filed for), `resurfacing` (same place/invariant as
 * an earlier fix — an earlier fix did not hold), `fix-induced` (a previous fix
 * broke it), `environmental` (red build / stale branch, nobody's disagreement). */
export interface FixTicketEntry {
  ticketId: string;
  kind: string;
  originTicketId: string | null;
  round: number;
  tag: "new" | "resurfacing" | "fix-induced" | "environmental";
  createdAt: string | null;
  title: string;
  reverify?: boolean;
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
  /** count/ticketIds are unchanged; entries/byKind/byTag are FR-10 additions and
   * absent from metrics.json files written before it. */
  fixTickets: {
    count: number;
    ticketIds: string[];
    entries?: FixTicketEntry[];
    byKind?: Record<string, number>;
    byTag?: Record<"new" | "resurfacing" | "fix-induced" | "environmental", number>;
  };
  /** How many human reviews were requested outside business hours (FR-10). */
  humanReviewsOutsideHours?: number;
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
  /** All analyses for this run (newest first, full records — the panel renders
   * metrics + full report for whichever entry the user selects). */
  history: WorkflowAnalysis[];
  /** Def-level trend across runs (newest first). */
  trend: AnalysisTrendPoint[];
}
