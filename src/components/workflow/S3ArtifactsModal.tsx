"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  FolderOpen,
  X,
  FileText,
  FileCode,
  Download,
  Archive,
  AlertCircle,
  Loader2,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface S3Artifact {
  key: string;
  filename: string;
  size: number;
  lastModified: string | null;
}

interface S3ArtifactsModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  workflowId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return "";
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "json", "py", "css", "html", "yaml", "yml", "sh", "md",
]);

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return CODE_EXTENSIONS.has(ext) ? FileCode : FileText;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function S3ArtifactsModal({
  isOpen,
  onClose,
  agentId,
  agentName,
  workflowId,
}: S3ArtifactsModalProps) {
  const [artifacts, setArtifacts] = useState<S3Artifact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Mount tracking for portal
  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch artifacts on open
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    fetch(`/api/workflow/artifacts?workflowId=${encodeURIComponent(workflowId)}&agentId=${encodeURIComponent(agentId)}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setArtifacts(data.artifacts ?? []);
        setIsLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message || "Failed to load artifacts");
        setIsLoading(false);
      });
    return () => controller.abort();
  }, [isOpen, workflowId, agentId]);

  // Focus close button on open
  useEffect(() => {
    if (isOpen && !isClosing) {
      setTimeout(() => closeButtonRef.current?.focus(), 100);
    }
  }, [isOpen, isClosing]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (!isOpen || isClosing) return;
    const modal = modalRef.current;
    if (!modal) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, isClosing]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 180);
  }, [onClose]);

  const handleDownload = useCallback((artifact: S3Artifact) => {
    setDownloadingFile(artifact.key);
    const url = `/api/workflow/artifacts/download?key=${encodeURIComponent(artifact.key)}`;
    // Create anchor for download
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setDownloadingFile(null), 1500);
  }, []);

  const handleDownloadAll = useCallback(() => {
    setDownloadingAll(true);
    const url = `/api/workflow/artifacts/download?workflowId=${encodeURIComponent(workflowId)}&agentId=${encodeURIComponent(agentId)}&zip=true`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agentId}-artifacts.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setDownloadingAll(false), 2000);
  }, [workflowId, agentId]);

  const retry = useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetch(`/api/workflow/artifacts?workflowId=${encodeURIComponent(workflowId)}&agentId=${encodeURIComponent(agentId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setArtifacts(data.artifacts ?? []);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load artifacts");
        setIsLoading(false);
      });
  }, [workflowId, agentId]);

  const totalSize = artifacts.reduce((sum, a) => sum + a.size, 0);

  if (!mounted || !isOpen) return null;

  const modal = (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center`}
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 ${isClosing ? "modal-backdrop-exit" : "modal-backdrop-enter"}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="s3-modal-title"
        className={`s3-artifacts-modal ${isClosing ? "modal-card-exit" : "modal-card-enter"}`}
      >
        {/* Header */}
        <div className="s3-modal-header">
          <FolderOpen size={16} className="text-brand-400 shrink-0" />
          <h2 id="s3-modal-title" className="s3-modal-title">
            Artifacts — {agentName}
          </h2>
          {!isLoading && !error && artifacts.length > 0 && (
            <span className="s3-modal-count">
              {artifacts.length} file{artifacts.length !== 1 ? "s" : ""}
            </span>
          )}
          <button
            ref={closeButtonRef}
            onClick={handleClose}
            className="p-1 rounded-md hover:bg-[rgba(100,116,139,0.2)] text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label="Close artifacts panel"
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="s3-modal-content">
          {/* ARIA live region */}
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {isLoading && "Loading artifacts..."}
            {artifacts.length > 0 && `${artifacts.length} artifact${artifacts.length > 1 ? "s" : ""} found.`}
            {error && `Error loading artifacts: ${error}`}
          </div>

          {/* Loading */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center h-48">
              <Loader2 size={24} className="text-brand-400 animate-spin" />
              <p className="text-[12px] text-zinc-500 mt-3">Loading artifacts...</p>
            </div>
          )}

          {/* Error */}
          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center mb-3">
                <AlertCircle size={20} className="text-red-400" />
              </div>
              <p className="text-[13px] text-zinc-400">Failed to load artifacts</p>
              <p className="text-[11px] text-zinc-600 mt-1">{error}</p>
              <button
                onClick={retry}
                className="mt-3 text-[11px] text-brand-400 hover:text-brand-300 underline underline-offset-2"
                type="button"
              >
                Try again
              </button>
            </div>
          )}

          {/* Empty */}
          {!isLoading && !error && artifacts.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center mb-3">
                <FolderOpen size={20} className="text-zinc-500" />
              </div>
              <p className="text-[13px] text-zinc-400">No artifacts yet</p>
              <p className="text-[11px] text-zinc-600 mt-1">
                Artifacts will appear here as the agent produces output.
              </p>
            </div>
          )}

          {/* File list — grouped by agent/folder */}
          {!isLoading && !error && artifacts.length > 0 && (() => {
            // Group artifacts by their agent namespace or "shared"
            // Paths: workflows/{wfId}/shared/..., workflows/{wfId}/agents/{agentId}/..., workflows/{wfId}/{agentId}/...
            const groups: Record<string, S3Artifact[]> = {};
            for (const artifact of artifacts) {
              const parts = artifact.key.split("/");
              const relParts = parts.slice(2); // skip "workflows" and workflow_id
              let folder: string;
              if (relParts[0] === "agents" && relParts.length > 2) {
                // Pattern: agents/{agentId}/filename — group by agentId
                folder = relParts[1];
              } else if (relParts.length > 1) {
                // Pattern: shared/filename or {agentId}/filename
                folder = relParts[0];
              } else {
                folder = "root";
              }
              if (!groups[folder]) groups[folder] = [];
              groups[folder].push(artifact);
            }

            // Deduplicate: remove shared files that also exist in an agent folder
            if (groups["shared"]) {
              const agentFilenames = new Set<string>();
              for (const [folder, files] of Object.entries(groups)) {
                if (folder !== "shared" && folder !== "root") {
                  for (const f of files) agentFilenames.add(f.filename);
                }
              }
              groups["shared"] = groups["shared"].filter((f) => !agentFilenames.has(f.filename));
              if (groups["shared"].length === 0) delete groups["shared"];
            }

            // Sort: "shared" first, then alphabetical
            const sortedFolders = Object.keys(groups).sort((a, b) => {
              if (a === "shared") return -1;
              if (b === "shared") return 1;
              return a.localeCompare(b);
            });

            return (
              <div className="space-y-3">
                {sortedFolders.map((folder) => {
                  const folderLabel = folder === "shared"
                    ? "Shared Workspace"
                    : folder.replace(/^agentcore_hub_/, "").split(/[_-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
                  return (
                    <div key={folder}>
                      <div className="flex items-center gap-2 mb-1 px-1">
                        <FolderOpen size={12} className="text-zinc-500" />
                        <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                          {folderLabel}
                        </span>
                        <span className="text-[10px] text-zinc-600">
                          ({groups[folder].length})
                        </span>
                      </div>
                      <ul role="list" className="space-y-0.5">
                        {groups[folder].map((artifact) => {
                          const IconComponent = getFileIcon(artifact.filename);
                          const isDownloading = downloadingFile === artifact.key;
                          return (
                            <li key={artifact.key} className="s3-file-row group">
                              <IconComponent size={16} className="text-zinc-500 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p
                                  className="text-[12px] font-medium text-zinc-200 truncate"
                                  title={artifact.key}
                                >
                                  {artifact.filename}
                                </p>
                                <p className="text-[10px] text-zinc-500 mt-0.5">
                                  <span className="font-mono">{formatFileSize(artifact.size)}</span>
                                  {artifact.lastModified && (
                                    <> · {formatRelativeTime(artifact.lastModified)}</>
                                  )}
                                </p>
                              </div>
                              <button
                                onClick={() => handleDownload(artifact)}
                                className="s3-download-btn"
                                aria-label={`Download ${artifact.filename}`}
                                type="button"
                                disabled={isDownloading}
                              >
                                {isDownloading ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Download size={14} />
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        {!isLoading && !error && artifacts.length > 0 && (
          <div className="s3-modal-footer">
            <span className="text-[11px] text-zinc-500">
              Total: <span className="font-mono">{formatFileSize(totalSize)}</span>
            </span>
            <button
              onClick={handleDownloadAll}
              disabled={downloadingAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12px] font-medium transition-colors"
              type="button"
            >
              {downloadingAll ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Archive size={14} />
              )}
              {downloadingAll ? "Preparing..." : "Download All as ZIP"}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
