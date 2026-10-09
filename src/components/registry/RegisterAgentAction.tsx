"use client";

// Agent Detail's "Register" / "Registered ✓" action (TEAM-5452). Owned by the
// Registry module and reached from core only through src/config/module-slots.tsx,
// so Agent Detail never imports this file and removing the Registry module just
// drops the slot. Detection + mapping live in ./agent-registration (pure, tested).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Loader2, Plus } from "lucide-react";
import { getClientRegion } from "@/lib/client-cache";
import RecordEditorModal, { type RecordSubmitPayload } from "./RecordEditorModal";
import type { DescriptorType, Registry, RegistryRecord } from "./types";
import {
  AGENT_DESCRIPTOR_TYPES,
  agentDescriptors,
  agentRawContent,
  agentToRecordDraft,
  defaultDescriptorType,
  extractInlineRaw,
  findRegisteredRecord,
  type AgentDescriptorType,
  type AgentForRegistration,
  type RegistrationCandidate,
  type RegistrationMatch,
} from "./agent-registration";

const REGISTRY_PREFIX = "/api/agentcore/registry";
// One GetRegistryRecord per candidate is the price of ARN detection (list
// summaries carry no descriptors). Past this many per registry we fall back to
// name matching for the rest.
const DETAIL_FETCH_CAP = 50;
const DETAIL_CONCURRENCY = 4;
// CreateRegistryRecord is async (202, CREATING): the new record can be missing
// from the next list. After a submit we show it as submitted (no re-submit)
// and re-detect on this cadence until the record is listed.
const PENDING_POLL_MS = 3000;
const PENDING_POLL_MAX = 20;

export interface RegisterAgentActionProps {
  agent: AgentForRegistration;
  /** Model id the page already resolved from the models registry (runtimes). */
  modelId?: string;
}

function regionHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "x-aws-region": getClientRegion(), ...(extra || {}) };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: regionHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Request failed: ${res.status}`);
  return body as T;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every CUSTOM/A2A record across all registries, with descriptors where affordable. */
async function loadCandidates(registries: Registry[]): Promise<RegistrationCandidate[]> {
  const perRegistry = await Promise.all(
    registries.map(async (reg) => {
      const lists = await Promise.all(
        AGENT_DESCRIPTOR_TYPES.map((t) =>
          getJson<{ records: RegistryRecord[] }>(
            `${REGISTRY_PREFIX}/${reg.registryId}/records?descriptorType=${t}`
          ).then((d) => d.records || [])
        )
      );
      const records = lists.flat();
      return mapLimited(records, DETAIL_CONCURRENCY, async (record, idx) => {
        let raw: string | undefined;
        if (idx < DETAIL_FETCH_CAP) {
          try {
            const d = await getJson<{ descriptors?: unknown; record?: { descriptors?: unknown } }>(
              `${REGISTRY_PREFIX}/${reg.registryId}/records/${record.recordId}`
            );
            raw = extractInlineRaw(record.descriptorType, d.record?.descriptors ?? d.descriptors);
          } catch {
            /* name fallback still applies */
          }
        }
        return { registryId: reg.registryId, record, raw } satisfies RegistrationCandidate;
      });
    })
  );
  return perRegistry.flat();
}

export default function RegisterAgentAction({ agent, modelId }: RegisterAgentActionProps) {
  const [registries, setRegistries] = useState<Registry[] | null>(null);
  const [match, setMatch] = useState<RegistrationMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [targetRegistryId, setTargetRegistryId] = useState("");
  // Set from the 202 of our own POST; cleared once detection lists the record.
  const [pending, setPending] = useState<{ registryId: string; recordId: string; status: string } | null>(null);

  const detect = useCallback(async (): Promise<RegistrationMatch | null> => {
    setLoading(true);
    setError(null);
    try {
      const { registries: list = [] } = await getJson<{ registries: Registry[] }>(REGISTRY_PREFIX);
      setRegistries(list);
      setTargetRegistryId((prev) => (prev && list.some((r) => r.registryId === prev) ? prev : list[0]?.registryId || ""));
      const found = list.length ? findRegisteredRecord(agent, await loadCandidates(list)) : null;
      setMatch(found);
      return found;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check the registry.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    detect();
  }, [detect]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      for (let i = 0; i < PENDING_POLL_MAX && !cancelled; i++) {
        if (await detect()) {
          if (!cancelled) setPending(null);
          return;
        }
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PENDING_POLL_MS);
        });
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending, detect]);

  async function handleSubmit(payload: RecordSubmitPayload) {
    if (!targetRegistryId) throw new Error("No registry selected.");
    const raw = extractInlineRaw(payload.descriptorType, payload.descriptors) ?? "";
    const res = await fetch(`${REGISTRY_PREFIX}/${targetRegistryId}/records`, {
      method: "POST",
      headers: regionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name: payload.name,
        description: payload.description || undefined,
        descriptorType: payload.descriptorType,
        recordVersion: payload.recordVersion,
        descriptors: agentDescriptors(payload.descriptorType, raw),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `Request failed: ${res.status}`);
    // Route returns createRegistryRecord's { recordId, recordArn, status }.
    setPending({
      registryId: targetRegistryId,
      recordId: String(body?.recordId || ""),
      status: String(body?.status || "CREATING"),
    });
  }

  const btnCls =
    "flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-colors";

  if (loading && !registries) {
    return (
      <span data-testid="register-agent-loading" className="text-xs text-muted flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Registry
      </span>
    );
  }

  if (match) {
    return (
      <Link
        data-testid="register-agent-registered"
        href={`/registry?registry=${encodeURIComponent(match.registryId)}&record=${encodeURIComponent(match.record.recordId)}`}
        className={`${btnCls} border-success-fg/30 bg-success-subtle text-success-fg hover:underline`}
        title={`Registry record ${match.record.name} (${match.record.status}, matched by ${match.matchedBy})`}
      >
        <CheckCircle2 className="w-3 h-3" /> Registered ✓
        <span className="text-[10px] opacity-80">{match.record.status}</span>
      </Link>
    );
  }

  if (pending) {
    // Submitted but not listed yet: no Register button, so no duplicate submit.
    return (
      <Link
        data-testid="register-agent-pending"
        href={`/registry?registry=${encodeURIComponent(pending.registryId)}&record=${encodeURIComponent(pending.recordId)}`}
        className={`${btnCls} border-theme text-secondary hover:underline`}
        title="Registration submitted - waiting for the registry to list the record"
      >
        <Clock className="w-3 h-3" /> Registration submitted
        <span className="text-[10px] opacity-80">{pending.status}</span>
      </Link>
    );
  }

  const noRegistry = !registries || registries.length === 0;
  const disabledReason = error
    ? `Registry unavailable: ${error}`
    : noRegistry
      ? "No registry yet - create one in the Registry tab"
      : undefined;
  const draft = agentToRecordDraft(agent, defaultDescriptorType(agent), { modelId });

  return (
    <>
      <button
        data-testid="register-agent-button"
        onClick={() => setOpen(true)}
        disabled={!!disabledReason}
        title={disabledReason}
        className={`${btnCls} border-brand-600/40 text-accent-fg hover:bg-surface-3 disabled:opacity-50`}
      >
        <Plus className="w-3 h-3" /> Register
      </button>
      {noRegistry && !error && (
        // Nothing to register into yet: the hint (not the button) points at the Registry tab.
        <Link data-testid="register-agent-hint" href="/registry" className="text-[10px] text-muted hover:underline">
          Create a registry
        </Link>
      )}
      {open && (
        <RecordEditorModal
          title={`Register ${agent.name}`}
          submitLabel="Register"
          prefill={draft}
          descriptorTypes={AGENT_DESCRIPTOR_TYPES}
          rawForType={(t: DescriptorType) =>
            (AGENT_DESCRIPTOR_TYPES as DescriptorType[]).includes(t)
              ? agentRawContent(agent, t as AgentDescriptorType, { modelId })
              : undefined
          }
          headerSlot={
            registries && registries.length > 1 ? (
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Registry</label>
                <select
                  data-testid="register-agent-registry"
                  className="w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary focus:outline-none focus:border-brand-600/50"
                  value={targetRegistryId}
                  onChange={(e) => setTargetRegistryId(e.target.value)}
                >
                  {registries.map((r) => (
                    <option key={r.registryId} value={r.registryId}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : undefined
          }
          onClose={() => setOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </>
  );
}
