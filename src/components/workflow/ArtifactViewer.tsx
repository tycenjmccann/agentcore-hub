"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Download,
  Loader2,
  AlertCircle,
  Pencil,
  Eye,
  Save,
  FileText,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import Lightbox from "@/components/cloud-code/Lightbox";

// ─── File-type detection ─────────────────────────────────────────────────────

export type ArtifactKind = "image" | "video" | "audio" | "pdf" | "markdown" | "text" | "binary";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "ogg"]);
const TEXT_EXT = new Set([
  "txt", "json", "yaml", "yml", "csv", "html", "css", "xml", "log",
  "ts", "tsx", "js", "jsx", "py", "sh", "toml",
]);

export function artifactKind(filename: string): ArtifactKind {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "md") return "markdown";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ArtifactViewerProps {
  s3Key: string;
  filename: string;
  onClose: () => void;
}

/**
 * Full-screen viewer for a single workflow artifact, opened from the S3
 * artifacts modal. Media (image/video/audio/pdf) streams via a presigned URL
 * so video seeking works; text/markdown loads inline through the content API.
 * Markdown and text files are editable — Save writes back to the same S3 key
 * (versioned buckets keep the prior copy).
 */
export default function ArtifactViewer({ s3Key, filename, onClose }: ArtifactViewerProps) {
  const kind = artifactKind(filename);
  const isTextual = kind === "markdown" || kind === "text";

  const [content, setContent] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url = isTextual
      ? `/api/workflow/artifacts/content?key=${encodeURIComponent(s3Key)}`
      : `/api/workflow/artifacts/content?key=${encodeURIComponent(s3Key)}&presign=1`;
    fetch(url, { signal: controller.signal })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        if (isTextual) {
          setContent(d.content ?? "");
          setDraft(d.content ?? "");
        } else {
          setMediaUrl(d.url);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message || "Failed to load artifact");
        setLoading(false);
      });
    return () => controller.abort();
  }, [s3Key, isTextual]);

  // Escape closes (but not while editing, to avoid losing a draft on reflex).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, editing]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch("/api/workflow/artifacts/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: s3Key, content: draft }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setContent(draft);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [s3Key, draft]);

  const downloadUrl = `/api/workflow/artifacts/download?key=${encodeURIComponent(s3Key)}`;

  // Images get the dedicated pinch-zoom lightbox once the presigned URL is in.
  if (kind === "image" && mediaUrl) {
    return <Lightbox src={mediaUrl} alt={filename} downloadName={filename} onClose={onClose} />;
  }

  const dirty = editing && draft !== content;

  const overlay = (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80"
      onClick={() => !dirty && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`Artifact: ${filename}`}
    >
      <div
        className="artifact-viewer"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="s3-modal-header">
          <FileText size={16} className="text-brand-400 shrink-0" />
          <h2 className="s3-modal-title" title={s3Key}>{filename}</h2>
          {saved && <span className="text-[11px] text-emerald-400">Saved</span>}
          <div className="flex items-center gap-1 ml-auto">
            {isTextual && !loading && !error && (
              editing ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-medium transition-colors"
                    type="button"
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                    Save
                  </button>
                  <button
                    onClick={() => { setEditing(false); setDraft(content ?? ""); setSaveError(null); }}
                    className="px-2.5 py-1 rounded-md text-[11px] text-[var(--pipeline-text-secondary)] hover:text-[var(--pipeline-text)] transition-colors"
                    type="button"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-[var(--pipeline-text-secondary)] hover:text-[var(--pipeline-text)] hover:bg-[rgba(100,116,139,0.15)] transition-colors"
                  aria-label="Edit file"
                  type="button"
                >
                  <Pencil size={12} /> Edit
                </button>
              )
            )}
            <a
              href={downloadUrl}
              download={filename}
              className="p-1.5 rounded-md hover:bg-[rgba(100,116,139,0.2)] text-[var(--pipeline-text-secondary)] hover:text-[var(--pipeline-text)] transition-colors"
              aria-label={`Download ${filename}`}
            >
              <Download size={15} />
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[rgba(100,116,139,0.2)] text-[var(--pipeline-text-secondary)] hover:text-[var(--pipeline-text)] transition-colors"
              aria-label="Close viewer"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="artifact-viewer-body">
          {loading && (
            <div className="flex flex-col items-center justify-center h-48">
              <Loader2 size={24} className="text-brand-400 animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <AlertCircle size={20} className="text-red-400 mb-2" />
              <p className="text-[13px] text-[var(--pipeline-text-secondary)]">{error}</p>
              <a href={downloadUrl} download={filename} className="mt-2 text-[11px] text-brand-400 underline underline-offset-2">
                Download instead
              </a>
            </div>
          )}

          {!loading && !error && kind === "video" && mediaUrl && (
            <video src={mediaUrl} controls autoPlay className="w-full max-h-[70vh] bg-black rounded-lg" />
          )}

          {!loading && !error && kind === "audio" && mediaUrl && (
            <audio src={mediaUrl} controls className="w-full mt-4" />
          )}

          {!loading && !error && kind === "pdf" && mediaUrl && (
            <iframe src={mediaUrl} title={filename} className="w-full h-[70vh] rounded-lg bg-white" />
          )}

          {!loading && !error && kind === "binary" && (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <Eye size={20} className="text-[var(--pipeline-text-muted)] mb-2" />
              <p className="text-[13px] text-[var(--pipeline-text-secondary)]">No inline preview for this file type</p>
              <a href={downloadUrl} download={filename} className="mt-2 text-[11px] text-brand-400 underline underline-offset-2">
                Download
              </a>
            </div>
          )}

          {!loading && !error && isTextual && !editing && (
            kind === "markdown" ? (
              <MarkdownRenderer content={content ?? ""} />
            ) : (
              <pre className="artifact-viewer-pre">{content}</pre>
            )
          )}

          {!loading && !error && isTextual && editing && (
            <div className="flex flex-col h-full">
              {saveError && (
                <p className="text-[11px] text-red-400 mb-2">{saveError}</p>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="artifact-viewer-editor"
                aria-label={`Edit ${filename}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
