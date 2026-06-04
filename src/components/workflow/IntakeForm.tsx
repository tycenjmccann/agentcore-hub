"use client";

import { useState, useEffect } from "react";
import type { WorkflowInput, IntakeSource, RepoConfig, RepoLayout } from "@/lib/workflow/types";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";
import { modelOptionToOverride } from "@/lib/workflow/model-config";

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

      {/* Repo Config */}
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
      </div>

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
            Select AI model for development agents. Defaults to Claude Sonnet 4.5.
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
