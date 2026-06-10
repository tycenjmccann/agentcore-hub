"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, Loader2, Plus, Search } from "lucide-react";
import { getClientRegion, invalidateCachePrefix } from "@/lib/client-cache";
import {
  DESCRIPTOR_TYPES,
  DESCRIPTOR_LABELS,
  RECORD_STATUSES,
  type DescriptorType,
  type Registry,
  type RegistryRecord,
  type RegistryRecordDetail,
} from "@/components/registry/types";
import { StatusBadge, DescriptorChip } from "@/components/registry/badges";
import RegistryModal, {
  type RegistrySubmitPayload,
} from "@/components/registry/RegistryModal";
import RecordEditorModal, {
  type RecordSubmitPayload,
} from "@/components/registry/RecordEditorModal";
import RecordDetailDrawer, {
  type LifecycleAction,
} from "@/components/registry/RecordDetailDrawer";

// ─── Fetch helpers (region header per the existing route convention) ────────

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "x-aws-region": getClientRegion(), ...(extra || {}) };
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `Request failed: ${res.status}`);
  return body as T;
}

async function apiSend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data as T;
}

const REGISTRY_PREFIX = "/api/agentcore/registry";

/** Pull the raw inlineContent string out of a built descriptors union (for PATCH). */
function extractInlineContent(
  type: DescriptorType,
  descriptors: Record<string, unknown>
): string {
  const d = descriptors as Record<string, any>;
  switch (type) {
    case "MCP":
      return d?.mcp?.server?.inlineContent ?? "";
    case "A2A":
      return d?.a2a?.agentCard?.inlineContent ?? "";
    case "CUSTOM":
      return d?.custom?.inlineContent ?? "";
    case "AGENT_SKILLS":
      return d?.agentSkills?.skillMd?.inlineContent ?? "";
    default:
      return "";
  }
}

type TabValue = "ALL" | DescriptorType;

export default function RegistryPage() {
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [selectedRegistryId, setSelectedRegistryId] = useState<string>("");
  const [registriesLoading, setRegistriesLoading] = useState(true);
  const [registriesError, setRegistriesError] = useState<string | null>(null);

  const [records, setRecords] = useState<RegistryRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  const [tab, setTab] = useState<TabValue>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const [showRegistryModal, setShowRegistryModal] = useState(false);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [editTarget, setEditTarget] = useState<RegistryRecordDetail | null>(null);

  const [detail, setDetail] = useState<RegistryRecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<LifecycleAction | null>(null);

  // ─── Load registries ──────────────────────────────────────────────────────
  const loadRegistries = useCallback(async (autoSelect?: string) => {
    setRegistriesError(null);
    try {
      const data = await apiGet<{ registries: Registry[] }>(REGISTRY_PREFIX);
      const list = data.registries || [];
      setRegistries(list);
      setSelectedRegistryId((prev) => {
        if (autoSelect) return autoSelect;
        if (prev && list.some((r) => r.registryId === prev)) return prev;
        return list[0]?.registryId || "";
      });
    } catch (e) {
      setRegistriesError(e instanceof Error ? e.message : "Failed to load registries.");
    } finally {
      setRegistriesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRegistries();
  }, [loadRegistries]);

  // ─── Load records (list or search) ─────────────────────────────────────────
  const loadRecords = useCallback(async () => {
    if (!selectedRegistryId) {
      setRecords([]);
      return;
    }
    setRecordsLoading(true);
    setRecordsError(null);
    const trimmed = query.trim();
    try {
      if (trimmed) {
        setSearching(true);
        const data = await apiSend<{ registryRecords?: RegistryRecord[]; records?: RegistryRecord[] }>(
          `${REGISTRY_PREFIX}/${selectedRegistryId}/search`,
          "POST",
          { query: trimmed, descriptorType: tab === "ALL" ? undefined : tab }
        );
        setRecords(data.registryRecords || data.records || []);
      } else {
        setSearching(false);
        const params = new URLSearchParams();
        if (tab !== "ALL") params.set("descriptorType", tab);
        if (statusFilter) params.set("status", statusFilter);
        const qs = params.toString();
        const data = await apiGet<{ registryRecords?: RegistryRecord[]; records?: RegistryRecord[] }>(
          `${REGISTRY_PREFIX}/${selectedRegistryId}/records${qs ? `?${qs}` : ""}`
        );
        setRecords(data.registryRecords || data.records || []);
      }
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : "Failed to load records.");
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }, [selectedRegistryId, query, tab, statusFilter]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  // Client-side status filter for search results (search route doesn't filter status).
  const visibleRecords = useMemo(() => {
    if (!statusFilter || !searching) return records;
    return records.filter((r) => String(r.status).toUpperCase() === statusFilter);
  }, [records, statusFilter, searching]);

  function refetchRecords() {
    invalidateCachePrefix(REGISTRY_PREFIX);
    loadRecords();
  }

  // ─── Create registry ────────────────────────────────────────────────────────
  async function handleCreateRegistry(payload: RegistrySubmitPayload) {
    const data = await apiSend<{ registry?: { registryId?: string }; registryId?: string }>(
      REGISTRY_PREFIX,
      "POST",
      {
        name: payload.name,
        description: payload.description || undefined,
        authorizerType: payload.authorizerType,
        approvalConfiguration: { autoApproval: payload.autoApproval },
      }
    );
    await loadRegistries(data.registry?.registryId || data.registryId);
  }

  // ─── Create / edit record ───────────────────────────────────────────────────
  async function handleSubmitRecord(payload: RecordSubmitPayload) {
    if (!selectedRegistryId) throw new Error("No registry selected.");
    if (editTarget) {
      // PATCH route updates name + descriptors.inlineContent only; it needs the
      // descriptorType + the raw inlineContent string (not the nested union).
      await apiSend(
        `${REGISTRY_PREFIX}/${selectedRegistryId}/records/${editTarget.recordId}`,
        "PATCH",
        {
          name: payload.name,
          descriptorType: payload.descriptorType,
          inlineContent: extractInlineContent(payload.descriptorType, payload.descriptors),
        }
      );
    } else {
      await apiSend(`${REGISTRY_PREFIX}/${selectedRegistryId}/records`, "POST", {
        name: payload.name,
        description: payload.description || undefined,
        descriptorType: payload.descriptorType,
        recordVersion: payload.recordVersion,
        descriptors: payload.descriptors,
      });
    }
    setEditTarget(null);
    refetchRecords();
  }

  // ─── Open detail drawer ─────────────────────────────────────────────────────
  async function openRecord(recordId: string) {
    if (!selectedRegistryId) return;
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await apiGet<
        | RegistryRecordDetail
        | { record: RegistryRecordDetail }
        | { registryRecord: RegistryRecordDetail }
      >(`${REGISTRY_PREFIX}/${selectedRegistryId}/records/${recordId}`);
      const rec =
        "record" in data
          ? data.record
          : "registryRecord" in data
            ? data.registryRecord
            : data;
      setDetail(rec as RegistryRecordDetail);
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : "Failed to load record.");
      setDetailLoading(false);
    } finally {
      setDetailLoading(false);
    }
  }

  // ─── Lifecycle actions from drawer ──────────────────────────────────────────
  async function handleDrawerAction(action: LifecycleAction) {
    if (!detail || !selectedRegistryId) return;
    const base = `${REGISTRY_PREFIX}/${selectedRegistryId}/records/${detail.recordId}`;

    if (action === "edit") {
      setEditTarget(detail);
      setShowRecordModal(true);
      return;
    }

    setBusyAction(action);
    try {
      if (action === "submit") {
        await apiSend(`${base}/approval`, "POST", { action: "submit" });
      } else if (action === "approve") {
        await apiSend(`${base}/approval`, "POST", {
          action: "approve",
          statusReason: "Approved via console",
        });
      } else if (action === "reject") {
        await apiSend(`${base}/approval`, "POST", {
          action: "reject",
          statusReason: "Rejected via console",
        });
      } else if (action === "deprecate") {
        await apiSend(`${base}/approval`, "POST", {
          action: "deprecate",
          statusReason: "Deprecated via console",
        });
      } else if (action === "delete") {
        await apiSend(base, "DELETE");
        setDetail(null);
        refetchRecords();
        return;
      }
      // Refetch the record + list to reflect the (async) status change.
      refetchRecords();
      await openRecord(detail.recordId);
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  const selectedRegistry = registries.find((r) => r.registryId === selectedRegistryId);

  // ─── Render ──────────────────────────────────────────────────────────────────
  if (registriesLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent-fg animate-spin" />
        <span className="ml-2 text-sm text-muted">Loading registries...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header / top bar */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-primary flex items-center gap-2">
            <BookMarked className="w-5 h-5 text-accent-fg" /> Registry
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Catalog and govern MCP servers, A2A agents, and skills in the AgentCore Registry.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedRegistryId}
            onChange={(e) => {
              setSelectedRegistryId(e.target.value);
              setQuery("");
              setTab("ALL");
              setStatusFilter("");
            }}
            data-testid="registry-select"
            disabled={registries.length === 0}
            className="px-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary focus:outline-none focus:border-brand-600/50 disabled:opacity-50"
          >
            {registries.length === 0 ? (
              <option value="">No registries</option>
            ) : (
              registries.map((r) => (
                <option key={r.registryId} value={r.registryId}>
                  {r.name}
                </option>
              ))
            )}
          </select>
          <button
            onClick={() => setShowRegistryModal(true)}
            data-testid="registry-new"
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500"
          >
            <Plus className="w-4 h-4" /> New Registry
          </button>
        </div>
      </div>

      {registriesError && (
        <div className="card border-danger-subtle">
          <p className="text-sm text-danger-fg">{registriesError}</p>
        </div>
      )}

      {/* Empty: no registries */}
      {!registriesError && registries.length === 0 ? (
        <div className="card text-center py-16">
          <BookMarked className="w-10 h-10 text-muted mx-auto mb-3" />
          <p className="text-sm text-secondary">No registries yet — create one to get started.</p>
          <button
            onClick={() => setShowRegistryModal(true)}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500"
          >
            <Plus className="w-4 h-4" /> New Registry
          </button>
        </div>
      ) : selectedRegistry ? (
        <>
          {/* Search + controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Semantic search records (empty = list all)..."
                data-testid="registry-search"
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary placeholder:text-muted focus:outline-none focus:border-brand-600/50"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              data-testid="registry-status-filter"
              className="px-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary focus:outline-none focus:border-brand-600/50"
            >
              <option value="">All statuses</option>
              {RECORD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {String(s).replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                setEditTarget(null);
                setShowRecordModal(true);
              }}
              data-testid="record-new"
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500"
            >
              <Plus className="w-4 h-4" /> New Record
            </button>
          </div>

          {/* Descriptor type tabs */}
          <div className="flex flex-wrap gap-2">
            {(["ALL", ...DESCRIPTOR_TYPES] as TabValue[]).map((t) => {
              const active = tab === t;
              const label = t === "ALL" ? "All" : DESCRIPTOR_LABELS[t];
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  data-testid={`registry-tab-${t}`}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    active
                      ? "bg-accent-subtle text-accent-fg border-accent-fg/30"
                      : "bg-surface-2 text-secondary border-theme hover:border-brand-600/40"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Record list */}
          {recordsError && (
            <div className="card border-danger-subtle">
              <p className="text-sm text-danger-fg">{recordsError}</p>
            </div>
          )}

          {recordsLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 text-accent-fg animate-spin" />
              <span className="ml-2 text-sm text-muted">
                {searching ? "Searching records..." : "Loading records..."}
              </span>
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="card text-center py-16">
              <Search className="w-10 h-10 text-muted mx-auto mb-3" />
              <p className="text-sm text-secondary">No records match.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {visibleRecords.map((r) => (
                <button
                  key={r.recordId}
                  onClick={() => openRecord(r.recordId)}
                  data-testid={`registry-record-${r.recordId}`}
                  className="card card-hover text-left"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-primary truncate">{r.name}</p>
                        <DescriptorChip type={r.descriptorType} />
                        <StatusBadge status={r.status} />
                      </div>
                      {r.description && (
                        <p className="text-xs text-secondary mt-1.5 line-clamp-2">
                          {r.description}
                        </p>
                      )}
                      <p className="text-[10px] text-muted font-mono mt-1 truncate">
                        {r.recordId}
                      </p>
                    </div>
                    {r.recordVersion && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-muted border border-theme flex-shrink-0">
                        v{r.recordVersion}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}

      {/* Modals + drawer */}
      {showRegistryModal && (
        <RegistryModal
          onClose={() => setShowRegistryModal(false)}
          onSubmit={handleCreateRegistry}
        />
      )}
      {showRecordModal && (
        <RecordEditorModal
          initial={editTarget ?? undefined}
          onClose={() => {
            setShowRecordModal(false);
            setEditTarget(null);
          }}
          onSubmit={handleSubmitRecord}
        />
      )}
      {(detail || detailLoading) && (
        <RecordDetailDrawer
          detail={detail}
          loading={detailLoading}
          busyAction={busyAction}
          onClose={() => setDetail(null)}
          onAction={handleDrawerAction}
        />
      )}
    </div>
  );
}
