"use client";

import { useState, useEffect } from "react";
import type { WorkflowInput, IntakeSource, RepoConfig, RepoLayout } from "@/lib/workflow/types";
import type { CdRegistry, CdRegistryEntry } from "@/lib/cd-registry";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";
import { modelOptionToOverride } from "@/lib/workflow/model-config";

interface ReviewGateOption {
  afterPhase: string;
  name?: string;
  blocking: boolean;
  condition: "always" | "flagged";
}

interface WorkflowDefOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  requiresRepo: boolean;
  phases: { id: string; name: string; type: string }[];
  reviewGates?: ReviewGateOption[];
}

interface IntakeFormProps {
  onSubmit: (input: WorkflowInput) => void;
  isLoading?: boolean;
}

export default function IntakeForm({ onSubmit, isLoading }: IntakeFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sources, setSources] = useState<IntakeSource[]>([]);
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [repoLayout, setRepoLayout] = useState<RepoLayout>("monorepo");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  // CD registry: is this repo one the hub merges + deploys (full ship phase),
  // or a HANDOFF (run ends at an open PR for the owning team)?
  const [cdStatus, setCdStatus] = useState<{ repo: string | null; registered: boolean; entry: CdRegistryEntry | null } | null>(null);
  const [cdRegistry, setCdRegistry] = useState<CdRegistry | null>(null);
  const [showCdManager, setShowCdManager] = useState(false);
  const [cdPipeline, setCdPipeline] = useState("");
  const [cdBusy, setCdBusy] = useState(false);
  const [cdError, setCdError] = useState<string | null>(null);


  // Workflow definition (shape) selection
  const [workflowDefs, setWorkflowDefs] = useState<WorkflowDefOption[]>([]);
  const [selectedDefId, setSelectedDefId] = useState<string>("");
  // Phases the requester opted into a human-review gate for (flagged gates).
  const [enabledGatePhases, setEnabledGatePhases] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/workflow/definitions")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.workflows) return;
        setWorkflowDefs(data.workflows);
        setSelectedDefId(data.defaultWorkflowDefId || data.workflows[0]?.id || "");
      })
      .catch(() => { /* selector hidden on failure → default workflow used */ });
  }, []);

  const selectedDef = workflowDefs.find((w) => w.id === selectedDefId);
  const requiresRepo = selectedDef?.requiresRepo ?? true;

  useEffect(() => {
    if (!requiresRepo || !repoUrl.trim()) { setCdStatus(null); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/workflow/cd-registry?repo=${encodeURIComponent(repoUrl.trim())}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setCdStatus({ repo: d.repo, registered: !!d.registered, entry: d.entry ?? null }); })
        .catch(() => { /* status line is advisory */ });
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [repoUrl, requiresRepo]);

  const refreshCdRegistry = async () => {
    try {
      const r = await fetch("/api/workflow/cd-registry?fresh=1");
      if (r.ok) setCdRegistry(await r.json());
    } catch { /* advisory */ }
  };
  useEffect(() => { if (showCdManager) void refreshCdRegistry(); }, [showCdManager]);

  const cdMutate = async (method: "POST" | "DELETE", body: Record<string, unknown>) => {
    setCdBusy(true); setCdError(null);
    try {
      const r = await fetch("/api/workflow/cd-registry", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      if (d.registry) setCdRegistry(d.registry);
      if (repoUrl.trim()) {
        const s = await fetch(`/api/workflow/cd-registry?repo=${encodeURIComponent(repoUrl.trim())}&fresh=1`);
        if (s.ok) { const sd = await s.json(); setCdStatus({ repo: sd.repo, registered: !!sd.registered, entry: sd.entry ?? null }); }
      }
      setCdPipeline("");
    } catch (err) {
      setCdError(err instanceof Error ? err.message : "CD registry update failed");
    } finally { setCdBusy(false); }
  };

  // Model selection state
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Fetch available models on mount
  useEffect(() => {
    const fetchModels = async () => {
      try {
        setModelsLoading(true);
        setModelsError(null);
        
        const response = await fetch("/api/models");
        if (!response.ok) {
          throw new Error(`Failed to fetch models: ${response.status}`);
        }
        
        const data: ModelsApiResponse = await response.json();
        setModels(data.models);
        
        // Pre-select the default model
        const defaultModel = data.models.find((m) => m.isDefault);
        if (defaultModel) {
          setSelectedModelId(defaultModel.id);
        } else if (data.models.length > 0) {
          setSelectedModelId(data.models[0].id);
        }
      } catch (err) {
        console.error("[IntakeForm] Failed to load models:", err);
        setModelsError(err instanceof Error ? err.message : "Failed to load models");
        // Graceful degradation: hide dropdown, use default model
      } finally {
        setModelsLoading(false);
      }
    };

    fetchModels();
  }, []);

  const addUrlSource = () => {
    if (!newSourceUrl.trim()) return;
    setSources([...sources, { type: "url", value: newSourceUrl.trim() }]);
    setNewSourceUrl("");
  };

  const removeSource = (index: number) => {
    setSources(sources.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const repoConfig: RepoConfig = {
      layout: repoLayout,
      repos: repoUrl
        ? [{ url: repoUrl, defaultBranch, platform: "shared" }]
        : [],
    };

    // Get selected model and convert to override format
    const selectedModel = models.find((m) => m.id === selectedModelId);
    const modelOverride = modelOptionToOverride(selectedModel);

    onSubmit({
      title: title.trim(),
      description: description.trim(),
      repoConfig,
      sources,
      // Only include modelOverride if a non-default model is selected
      ...(modelOverride && { modelOverride }),
      ...(selectedDefId && { workflowDefId: selectedDefId }),
      ...(enabledGatePhases.length > 0 && { reviewGates: enabledGatePhases }),
    });
  };

  // Get the currently selected model for description display
  const selectedModel = models.find((m) => m.id === selectedModelId);

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-primary mb-1">
          Start Team Workflow
        </h2>
        <p className="text-sm text-secondary">
          Provide product input and the agent team will handle requirements, design, and implementation.
        </p>
      </div>

      {/* Workflow Definition (shape) selector — only when >1 definition exists */}
      {workflowDefs.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">
            Workflow
          </label>
          <p className="text-xs text-muted mb-2">
            Choose which agent pipeline runs this request.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {workflowDefs.map((def) => {
              const active = def.id === selectedDefId;
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => { setSelectedDefId(def.id); setEnabledGatePhases([]); }}
                  data-testid={`workflow-def-${def.id}`}
                  className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    active
                      ? "border-brand-500 bg-blue-600/10"
                      : "border-theme bg-surface-1 hover:border-brand-500/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-primary">{def.name}</span>
                    {active && <span className="text-[10px] text-blue-400 font-semibold uppercase">Selected</span>}
                  </div>
                  <p className="text-xs text-muted mt-0.5 line-clamp-2">{def.description}</p>
                  <p className="text-[10px] text-secondary mt-1.5 font-mono">
                    {def.phases.map((p) => p.name).join(" → ")}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Human review gates — opt-in for any "flagged" gates the selected def offers */}
      {(() => {
        const flaggedGates = (selectedDef?.reviewGates || []).filter((g) => g.condition === "flagged");
        if (flaggedGates.length === 0) return null;
        return (
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">
              Human review gates
            </label>
            <p className="text-xs text-muted mb-2">
              Pause for a person to approve before the next phase starts.
            </p>
            <div className="space-y-1.5">
              {flaggedGates.map((g) => {
                const checked = enabledGatePhases.includes(g.afterPhase);
                return (
                  <label
                    key={g.afterPhase}
                    className="flex items-center gap-2 text-sm text-secondary cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setEnabledGatePhases((prev) =>
                          e.target.checked
                            ? [...prev, g.afterPhase]
                            : prev.filter((p) => p !== g.afterPhase)
                        )
                      }
                      className="rounded border-theme"
                    />
                    {g.name || `Review after ${g.afterPhase}`}
                    {g.blocking && <span className="text-[10px] text-muted">(blocking)</span>}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-secondary mb-1">
          Feature Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., Add profile photo carousel"
          className="w-full px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary placeholder-muted focus:outline-none focus:border-brand-500"
          required
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-secondary mb-1">
          Description / PRD
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the feature, user stories, or paste your PRD content..."
          rows={6}
          className="w-full px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary placeholder-muted focus:outline-none focus:border-brand-500 resize-y"
        />
      </div>

      {/* Input Sources */}
      <div>
        <label className="block text-sm font-medium text-secondary mb-1">
          Input Sources
        </label>
        <p className="text-xs text-muted mb-2">
          Add URLs to mockups, one-pagers, demo sites, or S3 locations
        </p>

        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newSourceUrl}
            onChange={(e) => setNewSourceUrl(e.target.value)}
            placeholder="https://... or s3://bucket/key"
            className="flex-1 px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary placeholder-muted text-sm focus:outline-none focus:border-brand-500"
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addUrlSource())}
          />
          <button
            type="button"
            onClick={addUrlSource}
            className="px-3 py-2 bg-surface-3 text-primary rounded-lg text-sm hover:bg-surface-4"
          >
            Add
          </button>
        </div>

        {sources.length > 0 && (
          <div className="space-y-1">
            {sources.map((source, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1 bg-surface-1 rounded text-xs">
                <span className="text-muted uppercase w-8">{source.type}</span>
                <span className="text-secondary truncate flex-1">{source.value}</span>
                <button
                  type="button"
                  onClick={() => removeSource(i)}
                  className="text-muted hover:text-red-400"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Repo Config — only for workflows that touch a git repo */}
      {requiresRepo && (
      <div>
        <label className="block text-sm font-medium text-secondary mb-1">
          Target Repository
        </label>

        <div className="flex gap-4 mb-2">
          <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
            <input
              type="radio"
              name="repo-layout"
              value="monorepo"
              checked={repoLayout === "monorepo"}
              onChange={(e) => setRepoLayout(e.target.value as RepoLayout)}
              className="accent-blue-500"
            />
            Monorepo
          </label>
          <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
            <input
              type="radio"
              name="repo-layout"
              value="multi-repo"
              checked={repoLayout === "multi-repo"}
              onChange={(e) => setRepoLayout(e.target.value as RepoLayout)}
              className="accent-blue-500"
            />
            Multi-repo
          </label>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
            className="flex-1 px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary placeholder-muted text-sm focus:outline-none focus:border-brand-500"
          />
          <input
            type="text"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            placeholder="main"
            className="w-24 px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary placeholder-muted text-sm focus:outline-none focus:border-brand-500"
          />
        </div>

        {/* CD registry status — what happens at the end of this run */}
        {repoUrl.trim() && cdStatus && (
          <div className="mt-2 text-xs" data-testid="cd-registry-status">
            {cdStatus.registered ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">
                  CD registered
                </span>
                <span className="text-secondary">
                  The hub merges + deploys this repo after the Merge Approval gate
                  {cdStatus.entry?.pipeline ? ` via ${cdStatus.entry.pipeline}` : " per its DEPLOY.md"}.
                </span>
                <button type="button" disabled={cdBusy} onClick={() => cdMutate("DELETE", { repo: cdStatus.repo })}
                  className="text-muted hover:text-primary underline disabled:opacity-50">
                  Unregister
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                  Handoff
                </span>
                <span className="text-secondary">
                  Not in the CD registry: the run ends with an open PR after review, QA and CI — the owning team merges and deploys.
                </span>
                <input
                  type="text"
                  value={cdPipeline}
                  onChange={(e) => setCdPipeline(e.target.value)}
                  placeholder="pipeline name (optional)"
                  className="w-44 px-2 py-1 bg-surface-1 border border-theme rounded text-primary placeholder-muted text-xs focus:outline-none focus:border-brand-500"
                />
                <button type="button" disabled={cdBusy || !cdStatus.repo} onClick={() => cdMutate("POST", { repo: cdStatus.repo, pipeline: cdPipeline })}
                  className="px-2 py-1 rounded bg-brand-500/20 text-brand-300 hover:bg-brand-500/30 disabled:opacity-50">
                  Register for CD
                </button>
              </div>
            )}
            {cdError && <div className="mt-1 text-red-400">{cdError}</div>}
          </div>
        )}

        <button type="button" onClick={() => setShowCdManager((v) => !v)} className="mt-2 text-xs text-muted hover:text-primary underline">
          {showCdManager ? "Hide CD registry" : "CD registry…"}
        </button>
        {showCdManager && (
          <div className="mt-2 p-3 rounded-lg border border-theme bg-surface-1 text-xs" data-testid="cd-registry-manager">
            <div className="text-secondary mb-2">
              Repos the hub is allowed to <strong>merge and deploy</strong>. Every other repo is a handoff (PR left open).
            </div>
            {cdRegistry === null ? (
              <div className="text-muted">Loading…</div>
            ) : cdRegistry.repos.length === 0 ? (
              <div className="text-muted">No repos registered — every run is a handoff.</div>
            ) : (
              <ul className="space-y-1">
                {cdRegistry.repos.map((e) => (
                  <li key={e.repo} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-primary">{e.repo}</span>
                    <span className="text-muted flex-1 truncate">{e.pipeline ? `pipeline: ${e.pipeline}${e.region ? ` (${e.region})` : ""}` : `deploy doc: ${e.deployDoc || "DEPLOY.md"}`}</span>
                    <button type="button" disabled={cdBusy} onClick={() => cdMutate("DELETE", { repo: e.repo })} className="text-muted hover:text-red-400 underline disabled:opacity-50">remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      )}

      {/* Model Selection - only show if models loaded successfully */}
      {!modelsError && (
        <div>
          <label
            htmlFor="model-select"
            className="block text-sm font-medium text-secondary mb-1"
          >
            Model Selection (Optional)
          </label>
          <p className="text-xs text-muted mb-2">
            Select AI model for development agents. Defaults to Claude Sonnet 5.
          </p>

          {modelsLoading ? (
            <div className="w-full px-3 py-2 bg-surface-1 border border-theme rounded-lg text-muted text-sm">
              Loading models...
            </div>
          ) : (
            <>
              <select
                id="model-select"
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                aria-label="Select AI model for development agents"
                aria-describedby="model-description"
                className="w-full px-3 py-2 bg-surface-1 border border-theme rounded-lg text-primary focus:outline-none focus:border-brand-500 cursor-pointer appearance-none"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23a1a1aa'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 0.75rem center",
                  backgroundSize: "1.25rem",
                  paddingRight: "2.5rem",
                }}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.isDefault ? `⭐ ${model.label}` : model.label}
                  </option>
                ))}
              </select>

              {/* Description / helper text for selected model */}
              {selectedModel?.description && (
                <p
                  id="model-description"
                  className="mt-1.5 text-xs text-muted flex items-center gap-1"
                >
                  <span className="text-muted">ℹ️</span>
                  {selectedModel.description}
                  {selectedModel.isDefault && (
                    <span className="ml-1 text-green-500">(Recommended)</span>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!title.trim() || isLoading}
        className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? "Starting workflow..." : "Start Team Workflow"}
      </button>
    </form>
  );
}
