"use client";

/**
 * Shared per-run performance-card fetch (TEAM-4482).
 *
 * Three components render the same card on a terminal run — the hero KPI strip,
 * the full performance card further down the board, and the Workflow Manager
 * panel's deterministic-score chip. They must issue ONE GET between them, and
 * when Compute now lands a card all three must flip to it without another
 * request. Hence a module-level cache whose entries are ref-counted by their
 * live subscribers:
 *
 *   - first subscriber for an id creates the entry and starts the GET; later
 *     subscribers in the same commit join the in-flight promise (one request);
 *   - the last unsubscribe schedules eviction on a macrotask and re-checks
 *     subs.size before deleting, so React StrictMode's synchronous
 *     setup -> cleanup -> setup keeps the entry (still one request);
 *   - because nothing survives the last unmount, navigating run A -> B -> A
 *     re-fetches A instead of serving a card from the previous visit. There is
 *     no TTL to reason about and no invalidation to get wrong.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BandStatus, KpiUnit } from "@/lib/workflow/performance";
import type { Grade } from "./band-style";

/** Deterministic KPI block — v5 cards only (`kpi` is absent on v4). */
export interface RunCardKpi {
  version: number;
  computedAt: string;
  cost: { usd: number | null; band: BandStatus; z: number | null };
  time: {
    wallMs: number | null;
    activeMs: number | null;
    humanWaitMs: number;
    band: BandStatus;
    z: number | null;
  };
  quality: {
    score: number | null;
    grade: Grade | null;
    confidence: "full" | "partial" | "insufficient";
    /** Points of evidence actually available, out of 100. */
    evidenceWeight: number;
    outcome: string;
    band: BandStatus;
    z: number | null;
    components: {
      key: string;
      label: string;
      weight: number;
      raw: number | string | null;
      normalized: number | null;
      points: number | null;
      included: boolean;
      note: string | null;
    }[];
    excluded: string[];
    capsApplied: { kind: "outcome"; outcome: string; cap: number }[];
  };
}

export interface RunCard {
  reportVersion: number;
  workflowId: string;
  epicId: string | null;
  workflowDefId: string;
  title: string | null;
  run: { outcome: string; startedAt: string | null; completedAt: string | null; prUrl: string | null };
  cost: {
    totalUsd: number; personaUsd: number; codingUsd: number; perTaskUsd: number | null;
    tokens: { input: number; output: number; cached: number; total: number; cacheRead?: number; cacheWrite?: number };
    cacheHitRate?: number | null; personaCacheHitRate?: number | null;
    byEngine: Record<string, { usd: number }>;
  };
  time: {
    wallMs: number | null; humanWaitMs: number; activeMs: number | null; agentWorkMs: number;
    busyMs?: number; idleMs: number | null; agentUtilization: number | null; humanGates: number;
    phases: { phase: string; durationMs: number }[];
  };
  quality: {
    outcome: string; tasks: number; tasksCompleted: number; reworkRounds: number; changeRequests: number;
    fixTickets: number; gateRounds: number; loops: number; nudges: number; interventions: number;
    errors: number; retries: number; firstPassYield: number | null; prUrl: string | null;
  };
  agents: Record<string, { usd: number; workMs: number; tasks: number; reworkRounds: number }>;
  bands: {
    status: BandStatus;
    baseline: { workflowDefId?: string; n: number; nCost?: number; windowDays: number; minSamples: number };
    anomalies: { kpi: string; label: string; status: BandStatus; value: number; median: number; z: number }[];
    kpis: Record<string, { label: string; unit: KpiUnit; status: BandStatus; value: number | null; median?: number; warnAbove?: number; z?: number | null }>;
  } | null;
  /** v5: cost/time/quality with a deterministic quality score. Absent on v4 cards. */
  kpi?: RunCardKpi;
  dataQuality: { gaps: string[]; costMissing?: boolean };
}

export type CardState = "loading" | "missing" | "ready" | "error";

interface Snapshot {
  card: RunCard | null;
  state: CardState;
}

type Listener = (snap: Snapshot) => void;

interface Entry extends Snapshot {
  promise: Promise<void> | null;
  subs: Set<Listener>;
}

const CACHE = new Map<string, Entry>();

function publish(entry: Entry) {
  const snap: Snapshot = { card: entry.card, state: entry.state };
  for (const listener of entry.subs) listener(snap);
}

/** Mirrors RunPerformanceCard's original effect exactly: 404 -> missing, !ok -> error. */
function startFetch(workflowId: string, entry: Entry) {
  entry.card = null;
  entry.state = "loading";
  entry.promise = fetch(`/api/workflow/performance?workflowId=${encodeURIComponent(workflowId)}`, { cache: "no-store" })
    .then(async (r) => {
      if (r.status === 404) { entry.state = "missing"; return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      entry.card = j.card as RunCard;
      entry.state = "ready";
    })
    .catch(() => { entry.state = "error"; })
    .then(() => { entry.promise = null; publish(entry); });
  publish(entry);
}

function ensure(workflowId: string): Entry {
  let entry = CACHE.get(workflowId);
  if (!entry) {
    entry = { card: null, state: "loading", promise: null, subs: new Set() };
    CACHE.set(workflowId, entry);
  }
  return entry;
}

function subscribe(workflowId: string, listener: Listener): Entry {
  const existing = CACHE.get(workflowId);
  if (existing) {
    existing.subs.add(listener);
    return existing;
  }
  const entry = ensure(workflowId);
  entry.subs.add(listener);
  startFetch(workflowId, entry);
  return entry;
}

function unsubscribe(workflowId: string, listener: Listener) {
  const entry = CACHE.get(workflowId);
  if (!entry) return;
  entry.subs.delete(listener);
  if (entry.subs.size > 0) return;
  // Deferred so a StrictMode (or React-internal) remount inside the same commit
  // re-subscribes before the check runs — that keeps one GET. Once the run really
  // is gone from the screen the entry is dropped, so coming back re-fetches.
  setTimeout(() => {
    const current = CACHE.get(workflowId);
    if (current === entry && current.subs.size === 0) CACHE.delete(workflowId);
  }, 0);
}

export interface UsePerformanceCard extends Snapshot {
  /** Publish a freshly computed card to every consumer (no extra request). */
  setCard: (card: RunCard) => void;
  /** Discard and re-read — the error state's Retry. */
  refetch: () => void;
}

export function usePerformanceCard(workflowId: string): UsePerformanceCard {
  const [snap, setSnap] = useState<Snapshot>(() => {
    const entry = CACHE.get(workflowId);
    // A late mounter in a run whose card is already loaded skips the skeleton.
    return entry ? { card: entry.card, state: entry.state } : { card: null, state: "loading" };
  });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const listener: Listener = (next) => { if (alive.current) setSnap(next); };
    const entry = subscribe(workflowId, listener);
    // The entry may have been created (or resolved) between render and effect.
    if (alive.current) setSnap({ card: entry.card, state: entry.state });
    return () => {
      alive.current = false;
      unsubscribe(workflowId, listener);
    };
  }, [workflowId]);

  const setCard = useCallback((card: RunCard) => {
    const entry = ensure(workflowId);
    entry.card = card;
    entry.state = "ready";
    entry.promise = null;
    publish(entry);
  }, [workflowId]);

  const refetch = useCallback(() => {
    startFetch(workflowId, ensure(workflowId));
  }, [workflowId]);

  return { card: snap.card, state: snap.state, setCard, refetch };
}
