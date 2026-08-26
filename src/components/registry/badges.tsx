import type { RecordStatus, DescriptorType } from "./types";
import { DESCRIPTOR_LABELS } from "./types";

// APPROVED=green, DRAFT/PENDING=muted, REJECTED/FAILED=danger, others (CREATING/UPDATING)=info.
function statusClasses(status: RecordStatus): string {
  const s = String(status).toUpperCase();
  if (s === "APPROVED") return "bg-success-subtle text-success-fg border-success-fg/30";
  if (s === "REJECTED" || s.endsWith("FAILED"))
    return "bg-danger-subtle text-danger-fg border-danger-fg/30";
  if (s === "CREATING" || s === "UPDATING")
    return "bg-info-subtle text-info-fg border-info-fg/30";
  // DRAFT, PENDING_APPROVAL, DEPRECATED, unknown
  return "bg-surface-3 text-muted border-theme";
}

export function StatusBadge({ status }: { status: RecordStatus }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 font-medium ${statusClasses(
        status
      )}`}
    >
      {String(status).replace(/_/g, " ")}
    </span>
  );
}

export function DescriptorChip({ type }: { type: DescriptorType }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-accent-fg/30 bg-accent-subtle text-accent-fg flex-shrink-0 font-medium">
      {DESCRIPTOR_LABELS[type]}
    </span>
  );
}
