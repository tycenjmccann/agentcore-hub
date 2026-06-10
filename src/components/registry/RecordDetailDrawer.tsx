"use client";

import { useState } from "react";
import {
  X,
  Copy,
  Check,
  Loader2,
  Send,
  ThumbsUp,
  ThumbsDown,
  Archive,
  Pencil,
  Trash2,
} from "lucide-react";
import type { RegistryRecordDetail } from "./types";
import { StatusBadge, DescriptorChip } from "./badges";

export type LifecycleAction =
  | "submit"
  | "approve"
  | "reject"
  | "deprecate"
  | "edit"
  | "delete";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      title="Copy"
      className="text-muted hover:text-primary p-1 flex-shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success-fg" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// Pretty-print the descriptors payload: parse any inlineContent JSON string and
// re-stringify formatted; render AGENT_SKILLS skillMd markdown as plain text.
function DescriptorView({ detail }: { detail: RegistryRecordDetail }) {
  const d = detail.descriptors as Record<string, any> | undefined;
  if (!d) return <p className="text-xs text-muted">No descriptor payload.</p>;

  if (detail.descriptorType === "AGENT_SKILLS") {
    const md = d.agentSkills?.skillMd?.inlineContent ?? "";
    const def = d.agentSkills?.skillDefinition?.inlineContent;
    return (
      <div className="space-y-3">
        <Block label="Skill (markdown)">
          <pre className="whitespace-pre-wrap text-xs text-secondary font-mono">{md}</pre>
        </Block>
        {def && (
          <Block label="Skill definition">
            <pre className="whitespace-pre-wrap text-xs text-secondary font-mono">
              {prettyJson(def)}
            </pre>
          </Block>
        )}
      </div>
    );
  }

  // MCP / A2A / CUSTOM: locate the inlineContent string and pretty-print it.
  let inline: string | undefined;
  if (detail.descriptorType === "MCP") inline = d.mcp?.server?.inlineContent;
  else if (detail.descriptorType === "A2A") inline = d.a2a?.agentCard?.inlineContent;
  else if (detail.descriptorType === "CUSTOM") inline = d.custom?.inlineContent;

  return (
    <Block label="Descriptor">
      <pre className="whitespace-pre-wrap text-xs text-secondary font-mono">
        {inline !== undefined ? prettyJson(inline) : JSON.stringify(d, null, 2)}
      </pre>
    </Block>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted mb-1">{label}</p>
      <div className="rounded-lg bg-surface-2 border border-theme p-3 overflow-x-auto">
        {children}
      </div>
    </div>
  );
}

const actionBtn =
  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50";

export default function RecordDetailDrawer({
  detail,
  loading,
  busyAction,
  onClose,
  onAction,
}: {
  detail: RegistryRecordDetail | null;
  loading: boolean;
  busyAction: LifecycleAction | null;
  onClose: () => void;
  onAction: (action: LifecycleAction) => void;
}) {
  const status = detail ? String(detail.status).toUpperCase() : "";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-surface-1 border-l border-theme h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-surface-1 border-b border-theme p-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            {loading && !detail ? (
              <p className="text-sm text-muted">Loading record...</p>
            ) : detail ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-primary truncate">{detail.name}</h3>
                  <DescriptorChip type={detail.descriptorType} />
                  <StatusBadge status={detail.status} />
                </div>
                {detail.description && (
                  <p className="text-xs text-secondary mt-1">{detail.description}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">No record selected.</p>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading && !detail ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 text-accent-fg animate-spin" />
          </div>
        ) : detail ? (
          <div className="p-4 space-y-4">
            {/* Lifecycle actions, gated by status */}
            <div className="flex flex-wrap gap-2">
              {status === "DRAFT" && (
                <button
                  onClick={() => onAction("submit")}
                  disabled={!!busyAction}
                  data-testid="record-submit"
                  className={`${actionBtn} border-accent-fg/30 bg-accent-subtle text-accent-fg`}
                >
                  {busyAction === "submit" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  Submit for approval
                </button>
              )}
              {status === "PENDING_APPROVAL" && (
                <>
                  <button
                    onClick={() => onAction("approve")}
                    disabled={!!busyAction}
                    className={`${actionBtn} border-success-fg/30 bg-success-subtle text-success-fg`}
                  >
                    {busyAction === "approve" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ThumbsUp className="w-3.5 h-3.5" />
                    )}
                    Approve
                  </button>
                  <button
                    onClick={() => onAction("reject")}
                    disabled={!!busyAction}
                    className={`${actionBtn} border-danger-fg/30 bg-danger-subtle text-danger-fg`}
                  >
                    {busyAction === "reject" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ThumbsDown className="w-3.5 h-3.5" />
                    )}
                    Reject
                  </button>
                </>
              )}
              {status === "APPROVED" && (
                <button
                  onClick={() => onAction("deprecate")}
                  disabled={!!busyAction}
                  className={`${actionBtn} border-theme text-secondary hover:text-primary`}
                >
                  {busyAction === "deprecate" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Archive className="w-3.5 h-3.5" />
                  )}
                  Deprecate
                </button>
              )}
              <button
                onClick={() => onAction("edit")}
                disabled={!!busyAction}
                className={`${actionBtn} border-theme text-secondary hover:text-primary`}
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
              <button
                onClick={() => onAction("delete")}
                disabled={!!busyAction}
                className={`${actionBtn} border-danger-fg/30 text-danger-fg`}
              >
                {busyAction === "delete" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                Delete
              </button>
            </div>

            {/* Meta */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <Meta label="Version" value={detail.recordVersion || "—"} />
              <Meta label="Created" value={fmt(detail.createdAt)} />
              <Meta label="Updated" value={fmt(detail.updatedAt)} />
              <Meta label="Record ID" value={detail.recordId} mono />
            </div>

            {/* ARNs with copy */}
            {detail.recordArn && (
              <ArnRow label="Record ARN" value={detail.recordArn} />
            )}
            {detail.registryArn && (
              <ArnRow label="Registry ARN" value={detail.registryArn} />
            )}

            {/* Descriptors payload */}
            <DescriptorView detail={detail} />
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-muted">No record selected.</div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`text-secondary truncate ${mono ? "font-mono text-[11px]" : ""}`}>{value}</p>
    </div>
  );
}

function ArnRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted mb-1">{label}</p>
      <div className="flex items-center gap-1 rounded-lg bg-surface-2 border border-theme px-2 py-1.5">
        <code className="text-[11px] text-secondary font-mono truncate flex-1">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function fmt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}
