"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Download, RefreshCw, FileBox, Upload } from "lucide-react";
import Lightbox from "./Lightbox";

interface Artifact {
  path: string;
  url: string;
  bytes: number;
  contentType: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Gallery of a session's artifacts: generated outputs the session produced
 * (touched-but-untracked deliverables), plus files the user uploads here (e.g. a
 * screenshot from their phone). Inline preview for media; download otherwise.
 * Uploads go straight to S3 via a presigned PUT and land in the same prefix the
 * runtime rehydrates, so the agent can see them on the next turn.
 */
export default function ArtifactsPanel({ sessionId }: { sessionId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/cloud-code/sessions/${sessionId}/artifacts`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `list failed (${r.status})`);
      setArtifacts(d.artifacts || []);
    } catch (e) {
      setError((e as Error).message);
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Upload selected files: presign a PUT per file, upload straight to S3, then
  // refresh. Best-effort per file — one failure surfaces but the rest proceed.
  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        for (const file of Array.from(files)) {
          const presign = await fetch(`/api/cloud-code/sessions/${sessionId}/artifacts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name }),
          });
          const d = await presign.json();
          if (!presign.ok) throw new Error(d.error || `presign failed (${presign.status})`);
          const put = await fetch(d.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": d.contentType || file.type || "application/octet-stream" },
            body: file,
          });
          if (!put.ok) throw new Error(`upload failed (${put.status})`);
        }
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [sessionId, load]
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto px-3.5 md:px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-[13px] font-semibold text-[var(--color-text-secondary)] flex items-center gap-1.5">
          <FileBox className="w-4 h-4" /> Artifacts
        </div>
        <div className="flex items-center gap-3">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 text-[12px] text-brand-400 hover:text-brand-300 disabled:opacity-50 transition-colors"
            aria-label="Upload a file"
          >
            <Upload className={`w-3.5 h-3.5 ${uploading ? "animate-pulse" : ""}`} /> {uploading ? "Uploading…" : "Upload"}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1 text-[12px] text-brand-400 hover:text-brand-300 transition-colors"
            aria-label="Refresh artifacts"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[13px] text-[var(--color-text-secondary)] px-3 py-2 rounded-xl mb-3 bg-[var(--color-bg-tertiary)]">
          {error}
        </div>
      )}

      {artifacts && artifacts.length === 0 && !error && (
        <div className="mx-auto mt-6 max-w-sm text-center">
          <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed px-4 py-3 rounded-2xl inline-block bg-[var(--color-bg-tertiary)]">
            No artifacts yet. Files this session generated (images, videos, exports) appear here after a checkpoint — or upload one from this device.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(artifacts || []).map((a) => (
          <div key={a.path} className="rounded-2xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
            {a.contentType.startsWith("video/") ? (
              <video src={a.url} controls className="w-full max-h-72 bg-black" />
            ) : a.contentType.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.url}
                alt={a.path}
                onClick={() => setLightbox({ url: a.url, name: a.path.split("/").pop() || a.path })}
                className="w-full max-h-72 object-contain bg-black cursor-zoom-in"
              />
            ) : a.contentType.startsWith("audio/") ? (
              <audio src={a.url} controls className="w-full px-3 pt-3" />
            ) : (
              <div className="h-24 flex items-center justify-center text-[var(--color-text-muted)]">
                <FileBox className="w-8 h-8 opacity-50" />
              </div>
            )}
            <div className="flex items-center justify-between px-3 py-2 gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate">{a.path}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{humanSize(a.bytes)}</div>
              </div>
              <a
                href={a.url}
                download={a.path.split("/").pop()}
                className="shrink-0 flex items-center gap-1 text-[12px] text-brand-400 hover:text-brand-300 transition-colors"
                aria-label={`Download ${a.path}`}
              >
                <Download className="w-4 h-4" />
              </a>
            </div>
          </div>
        ))}
      </div>

      {lightbox && (
        <Lightbox src={lightbox.url} alt={lightbox.name} downloadName={lightbox.name} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
