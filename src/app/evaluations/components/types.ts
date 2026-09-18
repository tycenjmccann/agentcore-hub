/**
 * Shared client types for the Evaluations surfaces (overview + drilldown).
 *
 * Everything here mirrors the evaluations API contract. Every field the UI does
 * not strictly need is optional on purpose: a missing value must render as "—",
 * never crash a page, because the routes evolve independently of this UI.
 */

// ─── Window ──────────────────────────────────────────────────────────────────

export type EvalWindow = "7" | "30" | "90" | "all";

// ─── GET /api/evaluations ────────────────────────────────────────────────────

export interface ScorecardEntry {
  avg: number;
  count: number;
  passing: number;
}

export interface ModelCost {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  calls?: number;
  cost: number;
}

export interface AgentMetrics {
  sessions: number;
  tokensIn: number; // full prompt tokens, cache reads/writes included
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
  calls?: number;
  cost: number;
  costPerSession: number;
  models?: ModelCost[];
}

/**
 * A persona of a shared-runtime agent. `scores` is tolerated in both shapes the
 * route may emit (a full ScorecardEntry or a bare average).
 */
export interface PersonaRow {
  persona: string;
  sessions?: number;
  scores?: Record<string, ScorecardEntry | number>;
  scorecard?: Record<string, ScorecardEntry | number>;
  metrics?: Partial<AgentMetrics>;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cost?: number;
  costPerSession?: number;
  models?: ModelCost[];
}

export interface EvalData {
  agents: string[];
  /** Column universe (agents that own their runtime), roster order. */
  columns?: { agentId: string; displayName: string }[];
  /** persona agentId → host agentId for personas sharing a host's runtime. */
  hosted?: Record<string, string>;
  scorecard: Record<string, Record<string, ScorecardEntry>>;
  metrics: Record<string, AgentMetrics>;
  evaluators: string[];
  /** Per agent display name → its personas (shared-runtime agents only). */
  personas?: Record<string, PersonaRow[]>;
  /** Every row (sessions, scores, tokens, cost) covers this same window. */
  window?: { days: number; start: string; end: string; timezone: string };
  windowLabel?: string;
  lastUpdated: string;
}

/** Persona rows may also ride along inside `metrics[agent]`. */
export type AgentMetricsWithPersonas = AgentMetrics & { personas?: PersonaRow[] };

// ─── GET /api/evaluations/timeseries ─────────────────────────────────────────

export interface TimeseriesPoint {
  day: string;
  sessions?: number;
  evaluators?: Record<string, { avg: number; count: number }>;
}

export interface TimeseriesResponse {
  series?: TimeseriesPoint[];
  window?: unknown;
}

/** evaluator (normalized, no `Builtin.` prefix) → ascending points. */
export type EvaluatorSeries = Record<string, { day: string; avg: number; count: number }[]>;

// ─── GET /api/evaluations/results ────────────────────────────────────────────

export interface SessionScore {
  score?: number | null;
  scoreLabel?: string | null;
  status?: string | null;
}

export interface SessionRow {
  sessionId: string;
  persona?: string;
  workflowId?: string;
  ticketId?: string;
  evaluatedAt?: string;
  evaluators?: Record<string, SessionScore>;
}

export interface ResultsResponse {
  sessions?: SessionRow[];
  cursor?: string | null;
}

// ─── GET /api/evaluations/sessions/<id> ──────────────────────────────────────

export interface SessionResult {
  evaluator: string;
  score?: number | null;
  scoreLabel?: string | null;
  explanation?: string | null;
  explanationTruncated?: boolean;
  errorType?: string | null;
  errorMessage?: string | null;
  status?: string | null;
  statusReason?: string | null;
  evaluatedAt?: string;
  traceId?: string;
  spanId?: string;
}

export interface SessionDetail {
  sessionId: string;
  agentId?: string;
  persona?: string;
  workflowId?: string;
  ticketId?: string;
  results?: SessionResult[];
  tracesHref?: string;
  workflowHref?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** `Builtin.Correctness` → `Correctness`; anything else is passed through. */
export function normalizeEvaluator(name: string): string {
  return name.startsWith("Builtin.") ? name.slice(8) : name;
}

/**
 * Pull a scorecard out of a persona row whichever shape it arrived in
 * (`scores` or `scorecard`, entry objects or bare averages).
 */
export function personaScores(row: PersonaRow): Record<string, ScorecardEntry> {
  const raw = row.scores ?? row.scorecard ?? {};
  const out: Record<string, ScorecardEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry =
      typeof value === "number"
        ? { avg: value, count: row.sessions ?? 0, passing: 0 }
        : value;
    if (entry && typeof entry.avg === "number") out[normalizeEvaluator(key)] = entry;
  }
  return out;
}

/**
 * Timeseries rows → per-evaluator ascending point lists (normalized names).
 * Days without a score for an evaluator are simply absent from its list.
 */
export function toEvaluatorSeries(series: TimeseriesPoint[] | undefined): EvaluatorSeries {
  const out: EvaluatorSeries = {};
  for (const point of series ?? []) {
    for (const [rawName, value] of Object.entries(point.evaluators ?? {})) {
      if (!value || typeof value.avg !== "number") continue;
      const name = normalizeEvaluator(rawName);
      (out[name] ??= []).push({ day: point.day, avg: value.avg, count: value.count ?? 0 });
    }
  }
  return out;
}

/** Persona ops metrics, flat on the row or nested under `metrics`. */
export function personaMetrics(row: PersonaRow): Partial<AgentMetrics> {
  return {
    sessions: row.metrics?.sessions ?? row.sessions,
    tokensIn: row.metrics?.tokensIn ?? row.tokensIn,
    tokensOut: row.metrics?.tokensOut ?? row.tokensOut,
    cacheRead: row.metrics?.cacheRead ?? row.cacheRead,
    cost: row.metrics?.cost ?? row.cost,
    costPerSession: row.metrics?.costPerSession ?? row.costPerSession,
    models: row.metrics?.models ?? row.models,
  };
}

// ─── GET /api/evaluations/si-ledger ──────────────────────────────────────────

/**
 * The SI ledger, as the "SI impact" panel consumes it. Structural types only —
 * the authoritative row shape lives in `src/lib/si-ledger.ts` (server side) and
 * is re-exported here so the client bundle never imports the AWS SDK. Keep the
 * two in step; every field stays optional for the reason in this file's header.
 */
export type {
  SiAttempt,
  SiCoverageDay,
  SiExpected,
  SiLedgerRow,
  SiOccurrence,
  SiStatus,
  SiVerdict,
  SiVerdictValue,
} from "@/lib/si-ledger";

import type { SiAttempt, SiExpected, SiStatus, SiVerdict } from "@/lib/si-ledger";

/** Hero tiles. `analysisCoverage` is null when the daily verify has not measured yet. */
export interface SiSummary {
  patterns: number;
  openPatterns: number;
  verifiedFixes: number;
  noEffectFixes: number;
  inRun: number;
  occurrences: number;
  analysisCoverage: number | null;
  analysisCoverageDay: string | null;
}

/** One table row: counts, not histories — the drill-down fetches the full row. */
export interface SiPatternSummary {
  patternKey: string;
  title: string | null;
  status: SiStatus | null;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrences: number;
  attempts: number;
  source: string | null;
  latestAttempt: SiAttempt | null;
  latestVerdict: SiVerdict | null;
  expected: SiExpected[];
}
