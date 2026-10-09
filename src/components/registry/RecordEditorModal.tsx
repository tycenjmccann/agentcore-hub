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

/** Create-mode seed values for the editor (see `prefill` prop). */
export interface RecordEditorPrefill {
  name?: string;
  description?: string;
  descriptorType?: DescriptorType;
  recordVersion?: string;
  raw?: string;
}

export interface RecordEditorModalProps {
  initial?: RegistryRecordDetail; // present => edit mode
  onClose: () => void;
  onSubmit: (payload: RecordSubmitPayload) => Promise<void>;
  /** Create-mode seed values (ignored when `initial` is set). */
  prefill?: RecordEditorPrefill;
  /** Descriptor types offered in the select (default DESCRIPTOR_TYPES). */
  descriptorTypes?: DescriptorType[];
  /** Create-mode template for a type when the user switches type (falls back to rawTemplate). */
  rawForType?: (t: DescriptorType) => string | undefined;
  /** Header title override (default "Edit Record"/"New Record"). */
  title?: string;
  /** Rendered at the top of the form body, above Name (e.g. a registry picker). */
  headerSlot?: React.ReactNode;
  /** Submit button label override (default "Save"/"Create"). */
  submitLabel?: string;
}

export default function RecordEditorModal({
  initial,
  onClose,
  onSubmit,
  prefill,
  descriptorTypes,
  rawForType,
  title,
  headerSlot,
  submitLabel,
}: RecordEditorModalProps) {
  const isEdit = !!initial;
  // Create-mode seed: prefill only applies when there is no record to edit.
  const seed = initial ? undefined : prefill;
  const [name, setName] = useState(initial?.name ?? seed?.name ?? "");
  const [description, setDescription] = useState(
    initial?.description ?? seed?.description ?? ""
  );
  const initialType: DescriptorType = initial?.descriptorType ?? seed?.descriptorType ?? "MCP";
  const [descriptorType, setDescriptorType] = useState<DescriptorType>(initialType);
  const [recordVersion, setRecordVersion] = useState(
    initial?.recordVersion ?? seed?.recordVersion ?? "1.0.0"
  );
  const [mode, setMode] = useState<EditorMode>("raw");

  const initialRaw = initial ? extractRaw(initial) : seed?.raw ?? rawTemplate(initialType);
  const [raw, setRaw] = useState(initialRaw);
  const [skillDef, setSkillDef] = useState(initial ? extractSkillDef(initial) : "");

  // Form-mode state per type (seeded from the record or a prefilled raw; empty otherwise)
  const seedForms = !!initial || seed?.raw !== undefined;
  const [mcpForm, setMcpForm] = useState<McpForm>(() =>
    seedForms && initialType === "MCP" ? rawToMcpForm(initialRaw) : emptyMcpForm()
  );
  const [a2aForm, setA2aForm] = useState<A2aForm>(() =>
    seedForms && initialType === "A2A" ? rawToA2aForm(initialRaw) : emptyA2aForm()
  );
  const [customForm, setCustomForm] = useState<CustomForm>(() =>
    seedForms && initialType === "CUSTOM" ? rawToCustomForm(initialRaw) : emptyCustomForm()
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching descriptor type resets the raw template + form (only in create mode).
  // A caller-supplied rawForType template seeds the matching form; otherwise forms start empty.
  function handleTypeChange(t: DescriptorType) {
    setDescriptorType(t);
    if (!isEdit) {
      const custom = rawForType?.(t);
      const next = custom ?? rawTemplate(t);
      setRaw(next);
      setMcpForm(custom !== undefined && t === "MCP" ? rawToMcpForm(next) : emptyMcpForm());
      setA2aForm(custom !== undefined && t === "A2A" ? rawToA2aForm(next) : emptyA2aForm());
      setCustomForm(
        custom !== undefined && t === "CUSTOM" ? rawToCustomForm(next) : emptyCustomForm()
      );
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
      <div
        className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        data-testid="record-editor-modal"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-primary">
            {title ?? (isEdit ? "Edit Record" : "New Record")}
          </h3>
          <button onClick={onClose} className="text-muted hover:text-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {headerSlot}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Name</label>
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-record"
                data-testid="record-editor-name"
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
              data-testid="record-editor-type"
            >
              {(descriptorTypes ?? DESCRIPTOR_TYPES).map((t) => (
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
                data-testid="record-editor-raw"
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
              data-testid="record-editor-submit"
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitLabel ?? (isEdit ? "Save" : "Create")}
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
