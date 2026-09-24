/**
 * Read-only client access to the model registry, for anything that just wants to
 * DISPLAY the model a deployable runs.
 *
 * Until now that answer lived in a `model` string in src/config/agents.json that
 * nothing read and nobody updated. The registry replaced it with a resolved answer
 * per agent, and this hook is how the rest of the console asks for it.
 *
 * Deliberately separate from src/components/models/**: the Models page is the
 * editor and owns drafts, conflicts and writes; this is a cached GET and a lookup.
 * Keeping them apart is what lets the whole /models surface be deleted without
 * breaking an agent card (and what the module-removal build check depends on) — so
 * this file declares the small slice of the response it needs rather than importing
 * the page's types.
 *
 * `resolve()` NEVER throws and never returns undefined. A console pointed at a
 * region whose fleet differs, a runtime deployed five minutes ago, a cached
 * document from before a rename: all of those are agents the registry has not heard
 * of, and every one of them must render as a dash, not a crash.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { cachedFetch } from "./client-cache";

/** One resolved deployable, as `/api/models/registry` reports it. */
export interface ResolvedModelEntry {
  modelId: string;
  label: string;
  shortLabel: string;
  /** False when a per-agent override is set; true when it comes from defaults. */
  inherited: boolean;
  /** What the live harness reports, when the deployable is a harness. */
  harnessModel?: string | null;
}

/** The answer a render site gets, including for an agent nobody knows about. */
export interface ResolvedModel extends ResolvedModelEntry {
  /** True when the registry has no entry for this key — render a dash. */
  unknown: boolean;
}

interface RegistrySlice {
  version: number;
  defaults?: Record<string, string>;
}

interface RegistryReadResponse {
  registry: RegistrySlice;
  resolved: Record<string, ResolvedModelEntry>;
}

const UNKNOWN: ResolvedModel = {
  modelId: "",
  label: "",
  shortLabel: "",
  inherited: true,
  unknown: true,
};

/**
 * AgentCore resource ids are `<name>-<random suffix>`, and harness ids are
 * sometimes prefixed. The registry is keyed by the roster agentId (the resource
 * NAME), so a caller handing over an id still gets the right row.
 */
function candidateKeys(key: string): string[] {
  const keys = [key];
  const unprefixed = key.replace(/^harness_/, "");
  if (unprefixed !== key) keys.push(unprefixed);
  for (const k of [...keys]) {
    const stripped = k.replace(/-[A-Za-z0-9]{6,}$/, "");
    if (stripped !== k) keys.push(stripped);
  }
  return keys;
}

/**
 * One request per page, not one per card. `cachedFetch` caches the RESULT but has no
 * in-flight dedupe, so twenty agent cards mounting together would each open their own
 * request before the first one landed. Sharing the promise collapses them; once it
 * settles, the cache serves everyone and this is cleared.
 */
let inflight: Promise<RegistryReadResponse> | null = null;

function loadRegistry(): Promise<RegistryReadResponse> {
  if (!inflight) {
    inflight = cachedFetch<RegistryReadResponse>("/api/models/registry", { ttl: 60_000 }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export interface UseModelsRegistry {
  registry: RegistrySlice | null;
  resolved: Record<string, ResolvedModelEntry>;
  loading: boolean;
  error: string | null;
  resolve: (key: string) => ResolvedModel;
}

/**
 * Cached read of the registry, shared by every render site on a page. A one-minute
 * TTL is right here: model assignments change at human speed, and the editor
 * invalidates this cache on every write, so an operator never sees their own change
 * lag behind.
 */
export function useModelsRegistry(): UseModelsRegistry {
  const [data, setData] = useState<RegistryReadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadRegistry()
      .then((body) => {
        if (!alive) return;
        setData(body);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A missing or failing registry is not a page failure: callers render a
        // dash. Record the reason for anyone who wants to show it.
        setError(e instanceof Error ? e.message : "Could not read the model registry");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const resolved = data?.resolved ?? {};

  // Stable across renders while the document is unchanged, so a caller can derive a
  // memo from it (the board rolls up one label set per phase) without recomputing on
  // every render.
  const resolve = useCallback(
    (key: string): ResolvedModel => {
      const table = data?.resolved ?? {};
      if (!key) return UNKNOWN;
      for (const candidate of candidateKeys(key)) {
        const hit = table[candidate];
        if (hit) return { ...hit, unknown: false };
      }
      return UNKNOWN;
    },
    [data],
  );

  return { registry: data?.registry ?? null, resolved, loading, error, resolve };
}
