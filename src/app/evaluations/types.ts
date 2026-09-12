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
  tokensIn: number;   // full prompt tokens, cache reads/writes included
  tokensOut: number;
  cacheRead?: number;
  cacheWrite?: number;
  calls?: number;
  cost: number;
  costPerSession: number;
  models?: ModelCost[];
}

export interface EvalData {
  agents: string[];
  scorecard: Record<string, Record<string, ScorecardEntry>>;
  metrics: Record<string, AgentMetrics>;
  evaluators: string[];
  // Every row (sessions, scores, tokens, cost) covers this same rolling window.
  window?: { days: number; start: string; end: string; timezone: string };
  lastUpdated: string;
}
