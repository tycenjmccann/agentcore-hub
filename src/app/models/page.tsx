"use client";

/**
 * /models — the model registry console.
 *
 * Before this page, "which model does this agent run" had no single answer: a
 * display string in agents.json that nothing read, a pinned model on each
 * harness, defaults in env vars, and prices in a separate file. This is the one
 * surface where that whole document is read and changed.
 *
 * The page is the single state owner. Its components are presentational — props in,
 * callbacks out — because the interesting logic is all about one document:
 *
 *  - ONE draft, ONE commit point. Every edit stages a change against the loaded
 *    document; nothing reaches S3 until Save. The save bar is therefore the
 *    complete answer to "have I changed anything", and the diff it lists is the
 *    same dotted-path vocabulary the server speaks back in a 422.
 *  - Polls must never make the page dirty. Probe results and harness applies land
 *    by re-reading the registry, and each read REBASES the staged changes onto the
 *    newer document (diff.ts) instead of replacing the draft. Probe state is
 *    outside the diff, so a probe finishing mid-edit is invisible.
 *  - A save has seven outcomes and each says what to do next. 207 in particular is
 *    saved-but-cost-math-is-stale, which is worse than a plain failure precisely
 *    because it looks like success.
 *
 * Writes require admin server-side; a 403 is reported here rather than pre-empted,
 * because the client cannot be the authority on that.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import {
  getRegistry,
  reapplyAgent,
  reapplyPricing,
  refreshCatalog,
  rollbackRegistry,
  saveRegistry,
  startProbe,
} from "@/components/models/api";
import { AlertBanner, ConflictBanner, PricingFailedBanner, writeErrorMessage } from "@/components/models/Banners";
import { ConfirmDialog } from "@/components/models/ConfirmDialog";
import { SaveBar } from "@/components/models/SaveBar";
import { DefaultsCard } from "@/components/models/DefaultsCard";
import { TiersCard } from "@/components/models/TiersCard";
import { AgentsSection } from "@/components/models/AgentsSection";
import { CatalogTable } from "@/components/models/CatalogTable";
import { JudgesCard } from "@/components/models/JudgesCard";
import { UnpricedStrip } from "@/components/models/UnpricedStrip";
import { PriorVersionPanel, rollbackConfirmBody } from "@/components/models/PriorVersionPanel";
import { dependentsOf, diffRegistry, rebaseChanges, stripMeta } from "@/components/models/diff";
import { absoluteUtc, invalidFieldUi, probeModeLabel, relativeTime } from "@/components/models/format";
import {
  DEPLOYABLES,
  groupFor,
  pathToControlTestId,
  type ConflictResponse,
  type DefaultsField,
  type Deployable,
  type InvalidFields,
  type InvalidRegistryResponse,
  type InvalidReason,
  type Price,
  type ProbeMode,
  type RegistryDoc,
  type RegistryResponse,
  type ResolvedModel,
  type WriteResponse,
} from "@/components/models/types";

/** A harness reports its new model within a few seconds; give it a minute, then say so. */
const APPLY_POLL_MS = 5_000;
const APPLY_MAX_MS = 60_000;

/** The cli probe runs a real turn, so it gets far more polls than the api probe. */
const PROBE_MAX_POLLS: Record<ProbeMode, number> = { api: 4, cli: 12 };

interface Docs {
  server: RegistryDoc;
  draft: RegistryDoc;
}

interface Confirmation {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => void | Promise<void>;
}

const DISPLAY_NAMES = new Map(DEPLOYABLES.map((d) => [d.agentId, d.displayName]));

/** The model a rejected path points at, for the 422 copy. */
function subjectFor(path: string, draft: RegistryDoc): string {
  const parts = path.split(".");
  if (parts[0] === "defaults" && parts[1]) return draft.defaults?.[parts[1] as DefaultsField] ?? path;
  if (parts[0] === "tiers" && parts[1] && parts[2]) {
    const family = (draft.tiers as unknown as Record<string, Record<string, string>>)[parts[1]];
    return family?.[parts[2]] ?? path;
  }
  if (parts[0] === "agents" && parts[1]) return draft.agents?.[parts.slice(1).join(".")] ?? path;
  if (parts[0] === "catalog" && parts.length >= 2) {
    const tail = parts[parts.length - 1];
    return (tail === "price" || tail === "status" || tail === "aliases" ? parts.slice(1, -1) : parts.slice(1)).join(".");
  }
  return parts[parts.length - 1] ?? path;
}

export default function ModelsPage() {
  const [docs, setDocs] = useState<Docs | null>(null);
  const [resolved, setResolved] = useState<Record<string, ResolvedModel>>({});
  const [previous, setPrevious] = useState<{ version: number; updatedAt: string } | null>(null);
  const [previousRegistry, setPreviousRegistry] = useState<RegistryDoc | undefined>(undefined);
  const [interimOverdue, setInterimOverdue] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [invalidFields, setInvalidFields] = useState<InvalidFields>({});
  const [conflict, setConflict] = useState<{ live: RegistryDoc; loadedVersion: number } | null>(null);
  const [pricingFailed, setPricingFailed] = useState<{ version: number; error: string } | null>(null);
  const [reapplyingPricing, setReapplyingPricing] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [applying, setApplying] = useState<Set<string>>(new Set());
  // The apply poll runs on a timer, outside any render, and has to read the set it
  // is polling for. React state would be a stale closure there (and a state updater
  // cannot hand a value back to the caller), so the set is mirrored in a ref and
  // every writer goes through updateApplying().
  const applyingRef = useRef<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [reapplying, setReapplying] = useState<Set<string>>(new Set());

  const [probesRunning, setProbesRunning] = useState<Set<string>>(new Set());
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  const [agentQuery, setAgentQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({ "Pinned deployables": true });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
    return id;
  }, []);

  const changes = useMemo(() => (docs ? diffRegistry(docs.server, docs.draft) : []), [docs]);

  const updateApplying = useCallback((next: Set<string>) => {
    applyingRef.current = next;
    setApplying(next);
  }, []);

  /**
   * Take a fresh registry read without throwing the draft away: the new document
   * becomes the base, and the staged changes are re-applied on top of it. With no
   * staged changes this is just a refresh; with changes it is what lets applies and
   * probes poll underneath an open edit.
   */
  const absorb = useCallback((next: RegistryResponse) => {
    setResolved(next.resolved ?? {});
    setPrevious(next.previous ?? null);
    setPreviousRegistry(next.previousRegistry);
    setInterimOverdue(next.interimOverdue ?? []);
    setDocs((prev) => {
      if (!prev) return { server: next.registry, draft: next.registry };
      const staged = diffRegistry(prev.server, prev.draft);
      return { server: next.registry, draft: rebaseChanges(staged, next.registry, prev.draft) };
    });
  }, []);

  // ─── Load ─────────────────────────────────────────────────────────────────

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      const { status, body } = await getRegistry({ fresh: true });
      if (!opts?.silent) setLoading(false);
      if (status === 200 && body?.registry) {
        setLoadError(null);
        absorb(body);
        return body;
      }
      if (!opts?.silent) {
        setLoadError(
          status === 403
            ? "You need admin rights to view the model registry."
            : `Could not load the model registry (status ${status || "no response"}).`,
        );
      }
      return null;
    },
    [absorb],
  );

  // StrictMode double-invokes mount effects in dev, and a ref (unlike a dep-array
  // flag) survives that simulated unmount/remount, so this still runs exactly once
  // per real mount — one initial GET, not two (TEAM-5120).
  const initialLoad = useRef(false);
  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    void load();
  }, [load]);

  // A /models#agent-<id> link from an agent card lands on a row inside a collapsed
  // group, so the group has to open before the browser can scroll to it.
  const hashHandled = useRef(false);
  useEffect(() => {
    if (!docs || hashHandled.current) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    hashHandled.current = true;
    const agentId = hash.startsWith("agent-") ? hash.slice("agent-".length) : null;
    if (agentId) {
      const deployable: Deployable | undefined = DEPLOYABLES.find((d) => d.agentId === agentId);
      if (deployable) setExpandedGroups((prev) => ({ ...prev, [groupFor(deployable)]: true }));
    }
    later(() => document.getElementById(hash)?.scrollIntoView({ block: "center" }), 60);
  }, [docs, later]);

  // ─── Draft mutation ───────────────────────────────────────────────────────

  const mutate = useCallback((fn: (draft: RegistryDoc) => RegistryDoc) => {
    setDocs((prev) => (prev ? { ...prev, draft: fn(prev.draft) } : prev));
  }, []);

  /** An edited field is no longer "the field the server rejected". */
  const clearInvalid = useCallback((path: string) => {
    setInvalidFields((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const setDefault = (field: DefaultsField, modelId: string) => {
    clearInvalid(`defaults.${field}`);
    mutate((d) => ({ ...d, defaults: { ...d.defaults, [field]: modelId } }));
  };

  const setTier = (family: "claude" | "codex", tier: string, modelId: string) => {
    clearInvalid(`tiers.${family}.${tier}`);
    mutate((d) => ({
      ...d,
      tiers: { ...d.tiers, [family]: { ...(d.tiers[family] as Record<string, string>), [tier]: modelId } },
    }));
  };

  const setAgentModel = (agentId: string, modelId: string) => {
    clearInvalid(`agents.${agentId}`);
    mutate((d) => {
      const agents = { ...d.agents };
      if (modelId) agents[agentId] = modelId;
      else delete agents[agentId];
      return { ...d, agents };
    });
  };

  const resetAllAgents = () => {
    setInvalidFields({});
    mutate((d) => ({ ...d, agents: {} }));
  };

  const setCatalogPrice = (modelId: string, price: Price) => {
    clearInvalid(`catalog.${modelId}.price`);
    setEditingPrice(null);
    mutate((d) => ({ ...d, catalog: d.catalog.map((r) => (r.modelId === modelId ? { ...r, price } : r)) }));
  };

  const adopt = (modelId: string) => {
    mutate((d) => ({ ...d, catalog: d.catalog.map((r) => (r.modelId === modelId ? { ...r, status: "active" } : r)) }));
  };

  const liftQuarantine = (modelId: string) => {
    mutate((d) => ({ ...d, quarantine: (d.quarantine ?? []).filter((id) => id !== modelId) }));
  };

  const requestQuarantine = (modelId: string) => {
    if (!docs) return;
    const { tiers, agents } = dependentsOf(docs.draft, modelId);
    setConfirmation({
      title: "Quarantine model",
      body: `Quarantine ${modelId}? It leaves every select. ${tiers.length} tier${tiers.length === 1 ? "" : "s"} and ${agents.length} agent${agents.length === 1 ? "" : "s"} point at it and need a new model before you can save.`,
      confirmLabel: "Quarantine",
      run: () => {
        mutate((d) => ({ ...d, quarantine: [...new Set([...(d.quarantine ?? []), modelId])] }));
        setConfirmation(null);
      },
    });
  };

  const discard = () => {
    setInvalidFields({});
    setDocs((prev) => (prev ? { ...prev, draft: prev.server } : prev));
  };

  // ─── Apply polling ────────────────────────────────────────────────────────

  /**
   * Watch the harnesses the last write left `applying`. A row settles when the
   * harness reports the model the registry asked for; if the deadline passes with
   * rows still pending, say so rather than spinning forever — the apply might have
   * failed somewhere this page cannot see.
   */
  const startApplyPoll = useCallback(
    (deadline: number) => {
      const tick = async () => {
        const next = await load({ silent: true });
        if (applyingRef.current.size === 0) return;
        const remaining = new Set<string>();
        for (const agentId of applyingRef.current) {
          const entry = next?.resolved?.[agentId];
          const settled = entry?.harnessModel && entry.modelId && entry.harnessModel === entry.modelId;
          if (!settled) remaining.add(agentId);
        }
        updateApplying(remaining);

        if (remaining.size === 0) return;
        if (Date.now() >= deadline) {
          setAnnouncement("Still applying, check again");
          return;
        }
        later(tick, APPLY_POLL_MS);
      };
      later(tick, APPLY_POLL_MS);
    },
    [later, load, updateApplying],
  );

  const absorbWrite = useCallback(
    (body: WriteResponse) => {
      setDocs({ server: body.registry, draft: body.registry });
      setInvalidFields({});
      setConflict(null);

      const applyingNow = new Set((body.agents ?? []).filter((a) => a.status === "applying").map((a) => a.agentId));
      const failed: Record<string, string> = {};
      for (const a of body.agents ?? []) {
        if (a.status === "failed") failed[a.agentId] = a.error || "The apply failed.";
      }
      updateApplying(applyingNow);
      setFailures(failed);
      if (applyingNow.size > 0) startApplyPoll(Date.now() + APPLY_MAX_MS);
      // The registry itself is authoritative for `resolved`; re-read so the rows
      // show the harness state that the write just kicked off.
      void load({ silent: true });
      return applyingNow;
    },
    [load, startApplyPoll, updateApplying],
  );

  // ─── Save ─────────────────────────────────────────────────────────────────

  const applyInvalid = (fields: Record<string, InvalidReason>, draft: RegistryDoc) => {
    const mapped: InvalidFields = {};
    // Message and action are resolved together, from the draft the save was made
    // from — not the live draft, which may have moved on by the time the 422 lands
    // (TEAM-5070), and not in two places that can disagree (TEAM-5077).
    for (const [path, reason] of Object.entries(fields)) {
      mapped[path] = { reason, ...invalidFieldUi(reason, subjectFor(path, draft), draft.catalog) };
    }
    setInvalidFields(mapped);

    const firstPath = Object.keys(fields)[0];
    const testId = firstPath ? pathToControlTestId(firstPath) : null;
    if (testId) {
      later(() => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        el?.scrollIntoView({ block: "center" });
        el?.focus();
      }, 0);
    }
  };

  const save = async () => {
    if (!docs) return;
    setSaving(true);
    setAlert(null);
    const { status, body } = await saveRegistry<unknown>(docs.server.version, stripMeta(docs.draft));
    setSaving(false);

    if (status === 200 || status === 207) {
      const write = body as WriteResponse;
      const applyingNow = absorbWrite(write);
      if (status === 207) {
        setPricingFailed({ version: write.registry.version, error: write.pricing?.error || "unknown error" });
      } else {
        setPricingFailed(null);
      }
      setAnnouncement(
        `Saved version ${write.registry.version}. ${applyingNow.size} deployable${applyingNow.size === 1 ? "" : "s"} re-applying.`,
      );
      return;
    }

    if (status === 409) {
      const live = (body as ConflictResponse)?.live;
      if (live) setConflict({ live, loadedVersion: docs.server.version });
      else setAlert(writeErrorMessage(status));
      return;
    }

    if (status === 422) {
      const fields = (body as InvalidRegistryResponse)?.fields ?? {};
      applyInvalid(fields, docs.draft);
      setAnnouncement(`The save was rejected: ${Object.keys(fields).length} field(s) need attention.`);
      return;
    }

    setAlert(writeErrorMessage(status, (body as { error?: string })?.error));
  };

  /**
   * The 409 response already carried the live document, so reloading is a swap in
   * memory — no second request. The staged edits are dropped, which the banner says
   * before this runs.
   */
  const reloadFromConflict = () => {
    if (!conflict) return;
    setDocs({ server: conflict.live, draft: conflict.live });
    setInvalidFields({});
    setConflict(null);
    setAnnouncement(`Reloaded version ${conflict.live.version}.`);
  };

  // ─── Row actions ──────────────────────────────────────────────────────────

  const reapplyOne = async (agentId: string) => {
    if (!docs) return;
    setReapplying((prev) => new Set(prev).add(agentId));
    setAnnouncement(`Re-applying ${DISPLAY_NAMES.get(agentId) ?? agentId}.`);
    const { status, body } = await reapplyAgent<unknown>(docs.server.version, agentId);
    setReapplying((prev) => {
      const next = new Set(prev);
      next.delete(agentId);
      return next;
    });

    if (status === 200 || status === 207) {
      const write = body as WriteResponse;
      const result = (write.agents ?? []).find((a) => a.agentId === agentId);
      if (result?.status === "failed") {
        setFailures((prev) => ({ ...prev, [agentId]: result.error || "The apply failed." }));
        return;
      }
      setFailures((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
      updateApplying(new Set(applyingRef.current).add(agentId));
      startApplyPoll(Date.now() + APPLY_MAX_MS);
      return;
    }
    if (status === 409) {
      const live = (body as ConflictResponse)?.live;
      if (live) setConflict({ live, loadedVersion: docs.server.version });
      return;
    }
    setAlert(writeErrorMessage(status, (body as { error?: string })?.error));
  };

  const retryPricing = async () => {
    if (!docs || !pricingFailed) return;
    setReapplyingPricing(true);
    const { status, body } = await reapplyPricing<unknown>(pricingFailed.version);
    setReapplyingPricing(false);
    if (status === 200) {
      setPricingFailed(null);
      setAnnouncement("Pricing re-applied.");
      void load({ silent: true });
      return;
    }
    if (status === 207) {
      const write = body as WriteResponse;
      setPricingFailed({ version: pricingFailed.version, error: write?.pricing?.error || "unknown error" });
      return;
    }
    setAlert(writeErrorMessage(status, (body as { error?: string })?.error));
  };

  const requestRollback = (toVersion: number) => {
    if (!docs) return;
    setConfirmation({
      title: `Roll back to v${toVersion}`,
      body: rollbackConfirmBody(toVersion, docs.server.version),
      confirmLabel: `Roll back to v${toVersion}`,
      run: async () => {
        setConfirmBusy(true);
        const { status, body } = await rollbackRegistry<unknown>(docs.server.version);
        setConfirmBusy(false);
        setConfirmation(null);
        if (status === 200 || status === 207) {
          absorbWrite(body as WriteResponse);
          setAnnouncement(`Rolled back to v${toVersion} as version ${(body as WriteResponse).registry.version}.`);
          return;
        }
        setAlert(writeErrorMessage(status, (body as { error?: string })?.error));
      },
    });
  };

  // ─── Catalog ──────────────────────────────────────────────────────────────

  /**
   * A refresh writes a new registry version, so 207 is "saved, pricing projection
   * failed" exactly as on a save — same banner, same re-apply. Treating it as a
   * failure would report an unchanged catalog while the server had in fact replaced
   * it, which is the one outcome an operator must not be told.
   */
  const runRefresh = async () => {
    setRefreshing(true);
    setRefreshMessage(null);
    const { status, body } = await refreshCatalog();
    setRefreshing(false);
    if ((status !== 200 && status !== 207) || !body) {
      setRefreshMessage("Catalog discovery failed. The stored catalog is unchanged.");
      return;
    }
    const { added = [], retired = [], repriced = [] } = body.discovered ?? {};
    setRefreshMessage(
      added.length || retired.length || repriced.length
        ? `+${added.length} added, ${retired.length} retired, ${repriced.length} repriced`
        : "No catalog changes.",
    );
    if (status === 207) {
      setPricingFailed({ version: body.version, error: body.pricing?.error || "unknown error" });
    }
    void load({ silent: true });
  };

  // ─── Probes ───────────────────────────────────────────────────────────────

  const runProbe = async (modelId: string, mode: ProbeMode) => {
    if (!docs) return;
    const before = docs.draft.catalog.find((r) => r.modelId === modelId)?.probe?.[mode]?.at ?? null;
    const key = `${modelId}:${mode}`;
    const label = probeModeLabel(mode);

    const { status, body } = await startProbe(modelId, mode);
    if (status !== 202 || !body?.accepted) {
      setAlert(
        status === 409
          ? `The ${label} for ${modelId} is already running.`
          : `The ${label} for ${modelId} could not be started (status ${status || "no response"}).`,
      );
      return;
    }

    setProbesRunning((prev) => new Set(prev).add(key));
    setAnnouncement(`${label} started for ${modelId}.`);

    const stop = () =>
      setProbesRunning((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

    let polls = 0;
    const tick = async () => {
      polls += 1;
      const next = await load({ silent: true });
      const result = next?.registry.catalog.find((r) => r.modelId === modelId)?.probe?.[mode];
      if (result && result.at !== before) {
        stop();
        setAnnouncement(`${label} ${result.ok ? "passed" : "failed"} for ${modelId}.`);
        return;
      }
      if (polls >= PROBE_MAX_POLLS[mode]) {
        stop();
        setAnnouncement(`${label} still running for ${modelId}.`);
        return;
      }
      later(tick, body.pollAfterMs);
    };
    later(tick, body.pollAfterMs);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-accent-fg animate-spin motion-reduce:animate-none" />
        <span className="ml-2 text-sm text-muted">Loading model registry...</span>
      </div>
    );
  }

  if (loadError || !docs) {
    return (
      <div className="space-y-6">
        <AlertBanner message={loadError ?? "The model registry is unavailable."} testId="models-load-error" />
      </div>
    );
  }

  const { server, draft } = docs;
  const refreshBlocked =
    changes.length > 0
      ? `Save or discard your ${changes.length} change${changes.length === 1 ? "" : "s"} first; refresh rewrites the catalog on the server.`
      : null;

  return (
    <div className="space-y-6 pb-24" data-testid="models-page">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-primary flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-accent-fg" aria-hidden />
            Models
          </h2>
          <p className="text-xs text-muted mt-0.5">
            One registry for every model the fleet runs. {DEPLOYABLES.length} deployables, {draft.catalog.length} catalog
            rows.
          </p>
        </div>
        <p className="text-xs text-muted" data-testid="models-meta">
          version {server.version}, updated{" "}
          <time dateTime={server.updatedAt} title={absoluteUtc(server.updatedAt)}>
            {relativeTime(server.updatedAt)}
          </time>{" "}
          by {server.updatedBy}
        </p>
      </div>

      <SaveBar changes={changes} saving={saving} onSave={save} onDiscard={discard} />

      {conflict && (
        <ConflictBanner
          serverVersion={conflict.live.version}
          loadedVersion={conflict.loadedVersion}
          onReload={reloadFromConflict}
        />
      )}
      {pricingFailed && (
        <PricingFailedBanner
          version={pricingFailed.version}
          error={pricingFailed.error}
          busy={reapplyingPricing}
          onReapply={retryPricing}
        />
      )}
      {alert && <AlertBanner message={alert} />}

      <DefaultsCard draft={draft} invalidFields={invalidFields} onChange={setDefault} />

      <TiersCard
        draft={draft}
        interimOverdue={interimOverdue}
        invalidFields={invalidFields}
        onChange={setTier}
      />

      <AgentsSection
        draft={draft}
        resolved={resolved}
        query={agentQuery}
        expanded={expandedGroups}
        invalidFields={invalidFields}
        applying={applying}
        failures={failures}
        reapplying={reapplying}
        onQueryChange={setAgentQuery}
        onToggleGroup={(group) =>
          setExpandedGroups((prev) => ({ ...prev, [group]: !(prev[group] ?? Boolean(agentQuery.trim())) }))
        }
        onChange={setAgentModel}
        onReapply={reapplyOne}
        onResetAll={resetAllAgents}
      />

      <CatalogTable
        draft={draft}
        interimOverdue={interimOverdue}
        probesRunning={probesRunning}
        editingPrice={editingPrice}
        refreshing={refreshing}
        refreshMessage={refreshMessage}
        refreshBlockedMessage={refreshBlocked}
        showRetired={showRetired}
        onToggleRetired={() => setShowRetired((v) => !v)}
        onRefresh={runRefresh}
        onEdit={setEditingPrice}
        onEditCancel={() => setEditingPrice(null)}
        onPrice={setCatalogPrice}
        onAdopt={adopt}
        onQuarantine={requestQuarantine}
        onLiftQuarantine={liftQuarantine}
        onProbe={runProbe}
      />

      <JudgesCard draft={draft} />

      <UnpricedStrip knownModelIds={draft.catalog.map((r) => r.modelId)} />

      <PriorVersionPanel
        previous={previous}
        currentVersion={server.version}
        previousRegistry={previousRegistry}
        serverDoc={server}
        onRequestRollback={requestRollback}
      />

      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          body={confirmation.body}
          confirmLabel={confirmation.confirmLabel}
          busy={confirmBusy}
          onConfirm={() => void confirmation.run()}
          onCancel={() => {
            setConfirmBusy(false);
            setConfirmation(null);
          }}
        />
      )}

      <p className="text-[11px] text-muted">
        Changes are staged locally and written as one new version when you save. Nothing here edits an agent directly.
      </p>
    </div>
  );
}
