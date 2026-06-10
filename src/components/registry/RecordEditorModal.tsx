"use client";

import { useState } from "react";
import { Loader2, X, Code2, ListChecks } from "lucide-react";
import {
  DESCRIPTOR_TYPES,
  DESCRIPTOR_LABELS,
  type DescriptorType,
  type RegistryRecordDetail,
} from "./types";
import {
  rawTemplate,
  buildDescriptors,
  validateRaw,
  emptyMcpForm,
  emptyA2aForm,
  emptyCustomForm,
  mcpFormToRaw,
  a2aFormToRaw,
  customFormToRaw,
  rawToMcpForm,
  rawToA2aForm,
  rawToCustomForm,
  type McpForm,
  type A2aForm,
  type CustomForm,
} from "./descriptors";

type EditorMode = "raw" | "form";

export interface RecordSubmitPayload {
  name: string;
  description: string;
  descriptorType: DescriptorType;
  recordVersion: string;
  descriptors: Record<string, unknown>;
}

const inputCls =
  "w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary placeholder:text-muted focus:outline-none focus:border-brand-600/50";
const labelCls = "block text-xs font-medium text-secondary mb-1";

/** Pull the raw inlineContent string out of an existing record's descriptors. */
function extractRaw(detail: RegistryRecordDetail): string {
  const d = detail.descriptors as Record<string, any> | undefined;
  if (!d) return rawTemplate(detail.descriptorType);
  try {
    switch (detail.descriptorType) {
      case "MCP":
        return d.mcp?.server?.inlineContent ?? rawTemplate("MCP");
      case "A2A":
        return d.a2a?.agentCard?.inlineContent ?? rawTemplate("A2A");
      case "CUSTOM":
        return d.custom?.inlineContent ?? rawTemplate("CUSTOM");
      case "AGENT_SKILLS":
        return d.agentSkills?.skillMd?.inlineContent ?? rawTemplate("AGENT_SKILLS");
    }
  } catch {
    /* fall through */
  }
  return rawTemplate(detail.descriptorType);
}

function extractSkillDef(detail: RegistryRecordDetail): string {
  const d = detail.descriptors as Record<string, any> | undefined;
  return d?.agentSkills?.skillDefinition?.inlineContent ?? "";
}

export default function RecordEditorModal({
  initial,
  onClose,
  onSubmit,
}: {
  initial?: RegistryRecordDetail; // present => edit mode
  onClose: () => void;
  onSubmit: (payload: RecordSubmitPayload) => Promise<void>;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [descriptorType, setDescriptorType] = useState<DescriptorType>(
    initial?.descriptorType ?? "MCP"
  );
  const [recordVersion, setRecordVersion] = useState(initial?.recordVersion ?? "1.0.0");
  const [mode, setMode] = useState<EditorMode>("raw");

  const initialRaw = initial ? extractRaw(initial) : rawTemplate(descriptorType);
  const [raw, setRaw] = useState(initialRaw);
  const [skillDef, setSkillDef] = useState(initial ? extractSkillDef(initial) : "");

  // Form-mode state per type
  const [mcpForm, setMcpForm] = useState<McpForm>(() =>
    initial && initial.descriptorType === "MCP" ? rawToMcpForm(initialRaw) : emptyMcpForm()
  );
  const [a2aForm, setA2aForm] = useState<A2aForm>(() =>
    initial && initial.descriptorType === "A2A" ? rawToA2aForm(initialRaw) : emptyA2aForm()
  );
  const [customForm, setCustomForm] = useState<CustomForm>(() =>
    initial && initial.descriptorType === "CUSTOM"
      ? rawToCustomForm(initialRaw)
      : emptyCustomForm()
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching descriptor type resets the raw template + form (only in create mode).
  function handleTypeChange(t: DescriptorType) {
    setDescriptorType(t);
    if (!isEdit) {
      setRaw(rawTemplate(t));
      setMcpForm(emptyMcpForm());
      setA2aForm(emptyA2aForm());
      setCustomForm(emptyCustomForm());
      setSkillDef("");
    }
  }

  // Mode toggle: form -> raw regenerates JSON; raw -> form best-effort parse.
  function toggleMode() {
    if (mode === "form") {
      // serialize current form into raw
      if (descriptorType === "MCP") setRaw(mcpFormToRaw(mcpForm));
      else if (descriptorType === "A2A") setRaw(a2aFormToRaw(a2aForm));
      else if (descriptorType === "CUSTOM") setRaw(customFormToRaw(customForm));
      setMode("raw");
    } else {
      if (descriptorType === "MCP") setMcpForm(rawToMcpForm(raw));
      else if (descriptorType === "A2A") setA2aForm(rawToA2aForm(raw));
      else if (descriptorType === "CUSTOM") setCustomForm(rawToCustomForm(raw));
      setMode("form");
    }
  }

  // Compute the effective raw content to submit (serializing from form if active).
  function effectiveRaw(): string {
    if (mode === "form" && descriptorType !== "AGENT_SKILLS") {
      if (descriptorType === "MCP") return mcpFormToRaw(mcpForm);
      if (descriptorType === "A2A") return a2aFormToRaw(a2aForm);
      if (descriptorType === "CUSTOM") return customFormToRaw(customForm);
    }
    return raw;
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const content = effectiveRaw();
    const v = validateRaw(descriptorType, content);
    if (v) {
      setError(v);
      return;
    }
    if (descriptorType === "AGENT_SKILLS" && skillDef.trim()) {
      try {
        JSON.parse(skillDef);
      } catch {
        setError("Skill definition must be valid JSON (or left empty).");
        return;
      }
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        descriptorType,
        recordVersion: recordVersion.trim() || "1.0.0",
        descriptors: buildDescriptors(descriptorType, content, skillDef),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record.");
    } finally {
      setSubmitting(false);
    }
  }

  const formSupported = descriptorType !== "AGENT_SKILLS";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-primary">
            {isEdit ? "Edit Record" : "New Record"}
          </h3>
          <button onClick={onClose} className="text-muted hover:text-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Name</label>
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-record"
              />
            </div>
            <div>
              <label className={labelCls}>Version</label>
              <input
                className={inputCls}
                value={recordVersion}
                onChange={(e) => setRecordVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <input
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this record describes"
            />
          </div>

          <div>
            <label className={labelCls}>Descriptor type</label>
            <select
              className={inputCls}
              value={descriptorType}
              onChange={(e) => handleTypeChange(e.target.value as DescriptorType)}
              disabled={isEdit}
            >
              {DESCRIPTOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DESCRIPTOR_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center justify-between">
            <label className={labelCls + " mb-0"}>Descriptor content</label>
            <button
              type="button"
              onClick={toggleMode}
              disabled={!formSupported && mode === "raw"}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-theme text-secondary hover:border-brand-600/40 disabled:opacity-40"
              title={
                formSupported
                  ? "Toggle between raw JSON and a structured form"
                  : "Agent Skills uses a markdown editor"
              }
            >
              {mode === "raw" ? (
                <>
                  <ListChecks className="w-3.5 h-3.5" /> Form
                </>
              ) : (
                <>
                  <Code2 className="w-3.5 h-3.5" /> Raw JSON
                </>
              )}
            </button>
          </div>

          {/* Editor body */}
          {mode === "raw" || !formSupported ? (
            <div className="space-y-3">
              <textarea
                className={inputCls + " font-mono text-xs min-h-[220px]"}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                spellCheck={false}
              />
              {descriptorType === "AGENT_SKILLS" && (
                <div>
                  <label className={labelCls}>Skill definition JSON (optional)</label>
                  <textarea
                    className={inputCls + " font-mono text-xs min-h-[100px]"}
                    value={skillDef}
                    onChange={(e) => setSkillDef(e.target.value)}
                    placeholder='{"version":"1.0"}'
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
          ) : descriptorType === "MCP" ? (
            <div className="space-y-3">
              <FormRow label="Server name">
                <input
                  className={inputCls}
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                />
              </FormRow>
              <FormRow label="Description">
                <input
                  className={inputCls}
                  value={mcpForm.description}
                  onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value })}
                />
              </FormRow>
              <FormRow label="Version">
                <input
                  className={inputCls}
                  value={mcpForm.version}
                  onChange={(e) => setMcpForm({ ...mcpForm, version: e.target.value })}
                />
              </FormRow>
              <FormRow label="Tools JSON (optional)">
                <textarea
                  className={inputCls + " font-mono text-xs min-h-[80px]"}
                  value={mcpForm.toolsJson}
                  onChange={(e) => setMcpForm({ ...mcpForm, toolsJson: e.target.value })}
                  placeholder="[]"
                  spellCheck={false}
                />
              </FormRow>
            </div>
          ) : descriptorType === "A2A" ? (
            <div className="space-y-3">
              <FormRow label="Agent card name">
                <input
                  className={inputCls}
                  value={a2aForm.name}
                  onChange={(e) => setA2aForm({ ...a2aForm, name: e.target.value })}
                />
              </FormRow>
              <FormRow label="Description">
                <input
                  className={inputCls}
                  value={a2aForm.description}
                  onChange={(e) => setA2aForm({ ...a2aForm, description: e.target.value })}
                />
              </FormRow>
              <FormRow label="Version">
                <input
                  className={inputCls}
                  value={a2aForm.version}
                  onChange={(e) => setA2aForm({ ...a2aForm, version: e.target.value })}
                />
              </FormRow>
              <FormRow label="Skills (comma-separated)">
                <input
                  className={inputCls}
                  value={a2aForm.skills}
                  onChange={(e) => setA2aForm({ ...a2aForm, skills: e.target.value })}
                  placeholder="summarize, translate"
                />
              </FormRow>
            </div>
          ) : (
            <div className="space-y-3">
              <FormRow label="Name">
                <input
                  className={inputCls}
                  value={customForm.name}
                  onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                />
              </FormRow>
              <FormRow label="Description">
                <input
                  className={inputCls}
                  value={customForm.description}
                  onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })}
                />
              </FormRow>
              <FormRow label="Data JSON">
                <textarea
                  className={inputCls + " font-mono text-xs min-h-[120px]"}
                  value={customForm.dataJson}
                  onChange={(e) => setCustomForm({ ...customForm, dataJson: e.target.value })}
                  spellCheck={false}
                />
              </FormRow>
            </div>
          )}

          {error && <p className="text-xs text-danger-fg">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-lg border border-theme text-secondary hover:text-primary"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="record-submit"
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}
