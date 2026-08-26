/**
 * Artifact auto-detection for port.
 *
 * Port carries two channels today: the git bundle (code) and the transcript
 * (conversation). Anything a session *produced or used that isn't git-tracked* —
 * a generated PNG, a rendered MP4, an exported PDF, a downloaded dataset — is
 * left on the laptop. The resumed cloud session can talk about a file it just
 * made but can't open it.
 *
 * This module finds those files by parsing the same transcript bytes the port
 * already reads: every Write/Edit/NotebookEdit/Read tool call names a file_path.
 * The ones that (a) still exist locally and (b) are NOT git-tracked are exactly
 * the deliverables that fall through the bundle gap. Detection only — Phase 1
 * surfaces candidates; it ships nothing.
 *
 * CLI-agnostic by construction: claude / codex / kiro all serialize tool inputs
 * as JSON containing `file_path` / `notebook_path`, so a structured claude parse
 * plus a regex fallback covers every transcript shape without per-CLI branching.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, mkdir, copyFile, readFile, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

const exec = promisify(execFile);

const MB = 1024 * 1024;
const envMb = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v * MB : fallback;
};

// Caps are generous on purpose: a session's deliverables are often media —
// a rendered MP4, an exported deck, a WAV — so the per-file ceiling has to clear
// real video, not just a PNG. Streaming the upload (see uploadArtifact) keeps
// memory flat regardless of size, so the limits exist only to stop a runaway
// (an accidental multi-GB dataset / a whole node_modules), not to block media.
// All three are env-overridable for the rare legitimately-huge handoff.
export const DEFAULT_FILE_CAP_BYTES = envMb("CC_ARTIFACT_FILE_CAP_MB", 500 * MB); // 500 MB/file
export const DEFAULT_TOTAL_CAP_BYTES = envMb("CC_ARTIFACT_TOTAL_CAP_MB", 2048 * MB); // 2 GB total
export const DEFAULT_FILE_COUNT_CAP = Number(process.env.CC_ARTIFACT_COUNT_CAP) || 200;

export type ArtifactKind = "image" | "video" | "doc" | "data" | "audio" | "other";

export interface ArtifactCandidate {
  rel: string; // path relative to cwd (the on-the-wire identity)
  abs: string; // resolved absolute path on this laptop
  bytes: number;
  kind: ArtifactKind;
  tool: string; // harvesting tool (Write/Edit/Read/…) or "unknown" (regex-only)
  overCap: boolean; // bytes > cap → reported, excluded from auto-ship
}

export interface DetectResult {
  candidates: ArtifactCandidate[]; // under-cap, shippable (within count + total caps)
  overCap: ArtifactCandidate[]; // over the per-file cap — flagged, not shipped
  dropped: ArtifactCandidate[]; // dropped by the count / total-bytes cap — flagged
  count: number; // candidates.length
  totalBytes: number; // sum over candidates
  fileCapBytes: number; // the per-file cap actually applied (for reporting)
}

const EXT_KIND: Record<string, ArtifactKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
  ".webp": "image", ".svg": "image", ".bmp": "image", ".tiff": "image", ".heic": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".avi": "video", ".mkv": "video",
  ".mp3": "audio", ".wav": "audio", ".aac": "audio", ".flac": "audio", ".m4a": "audio",
  ".pdf": "doc", ".docx": "doc", ".pptx": "doc", ".xlsx": "doc", ".key": "doc", ".pages": "doc",
  ".csv": "data", ".parquet": "data", ".arrow": "data", ".feather": "data",
  ".npy": "data", ".npz": "data", ".pkl": "data", ".h5": "data", ".sqlite": "data", ".db": "data",
};

function classify(rel: string): ArtifactKind {
  return EXT_KIND[path.extname(rel).toLowerCase()] || "other";
}

// Only tools that PRODUCE a file make something worth carrying. A Read/Glob/Grep
// merely names a path the session looked at — including secrets a coding agent
// reads constantly (.env, a PEM, ~/.aws/credentials). Harvesting those would
// presign them an upload. Restrict the structured (claude) harvest to writers.
const PRODUCER_TOOLS = new Set([
  "Write", "Edit", "MultiEdit", "NotebookEdit", // claude
  "fs_write", "create_file", "str_replace", "apply_patch", // kiro / codex shapes
]);

// Secret denylist — defense in depth for the regex-fallback CLIs (codex/kiro)
// where we can't attribute the harvesting tool, and for the case where an agent
// writes then re-reads a secret. Matches unambiguous credential files only, so a
// real deliverable isn't caught. `.key` is intentionally absent (Keynote uses it).
const SECRET_EXTS = new Set([".pem", ".p12", ".pfx", ".keystore", ".jks", ".asc", ".gpg"]);
const SECRET_NAME_RE = /(^\.env($|\.)|(^|\.)npmrc$|(^|\.)netrc$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)$|(^|\.)pgpass$|(^|\/)credentials$|secrets?(\.|$)|\.secret$)/i;
function isSecretPath(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (SECRET_EXTS.has(path.extname(base))) return true;
  return SECRET_NAME_RE.test(base) || SECRET_NAME_RE.test(rel);
}

/** Harvest every file_path / notebook_path a PRODUCER tool call referenced.
 *  Structured claude/jsonl parse for tool attribution (writers only) + a regex
 *  sweep that catches codex/kiro shapes the structured parse misses. The regex
 *  pass can't attribute a tool, so secret-path filtering (see isSecretPath) is
 *  what protects it from read-only credential files. Union, deduped. */
function harvestPaths(transcript: Buffer): Map<string, string> {
  const byPath = new Map<string, string>(); // raw path → tool (first seen wins)
  const text = transcript.toString("utf8");

  // Structured pass: claude .jsonl — one record per line, tool_use blocks live
  // in message.content[]. Gives us the real tool name → drop non-producers.
  for (const line of text.split("\n")) {
    if (!line.includes("tool_use")) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use" || !b.input) continue;
      const name = String(b.name || "");
      if (!PRODUCER_TOOLS.has(name)) continue; // a Read/Glob/Grep is not a deliverable
      const p = b.input.file_path || b.input.notebook_path;
      if (typeof p === "string" && p) {
        if (!byPath.has(p)) byPath.set(p, name);
      }
    }
  }

  // Regex fallback: any `"file_path":"…"` / `"notebook_path":"…"` in the raw
  // bytes (codex serializes tool args as a JSON string, kiro as one value blob —
  // both still contain these keys). No tool attribution here, so the secret
  // denylist (applied in detectArtifacts) is the guard for read-only secrets.
  const re = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let p: string;
    try {
      p = JSON.parse(`"${m[1]}"`); // unescape JSON string body
    } catch {
      continue;
    }
    if (p && !byPath.has(p)) byPath.set(p, "unknown");
  }

  // Media sweep: deliverables are routinely produced by SHELL commands (a python
  // script rendering a PNG, ffmpeg writing an MP4) — no Write tool, no file_path
  // key, so both passes above miss them. Sweep the raw transcript for any token
  // carrying a known artifact extension; detectArtifacts' existence / in-cwd /
  // untracked / secret filters discard the noise, so a false match costs nothing.
  const mediaRe = /(?:[A-Za-z0-9_~][A-Za-z0-9_.~/-]*)?\.(?:png|jpe?g|gif|webp|svg|bmp|tiff|heic|mp4|mov|webm|avi|mkv|mp3|wav|aac|flac|m4a|pdf|docx|pptx|xlsx|csv|parquet|arrow|feather|npy|npz|pkl|h5|sqlite|db)\b/gi;
  while ((m = mediaRe.exec(text)) !== null) {
    const p = m[0];
    if (p && !byPath.has(p)) byPath.set(p, "shell");
  }

  return byPath;
}

/** True if `abs` is tracked by git OR git-ignored-but-tracked. A path that
 *  `git ls-files` knows = code; it already travels in the bundle, so skip it. */
async function isGitTracked(repoDir: string, abs: string): Promise<boolean> {
  try {
    await exec("git", ["ls-files", "--error-unmatch", abs], { cwd: repoDir });
    return true; // exit 0 → tracked
  } catch {
    return false; // non-zero → not tracked (kept as a candidate)
  }
}

export interface DetectOptions {
  cwd: string; // where the CLI ran — paths resolve against this
  repoDir?: string; // git root, if it differs from cwd
  transcript: Buffer; // raw transcript bytes (already read by the port)
  fileCapBytes?: number; // per-file ceiling (default 500 MB)
  totalCapBytes?: number; // aggregate ceiling across shipped files (default 2 GB)
  countCap?: number; // max number of files shipped (default 200)
}

/**
 * Detect touched-untracked artifacts for a ported session. Pure read —
 * resolves, stats, and git-checks each transcript-referenced path; ships
 * nothing. Returns a deduped, classified candidate list split by the size cap.
 */
export async function detectArtifacts(opts: DetectOptions): Promise<DetectResult> {
  const cwd = opts.cwd;
  const repoDir = opts.repoDir || cwd;
  const cap = opts.fileCapBytes ?? DEFAULT_FILE_CAP_BYTES;
  const totalCap = opts.totalCapBytes ?? DEFAULT_TOTAL_CAP_BYTES;
  const countCap = opts.countCap ?? DEFAULT_FILE_COUNT_CAP;
  const artifactsDir = path.join(cwd, ".cloud-code", "artifacts");

  const harvested = harvestPaths(opts.transcript);
  const seen = new Set<string>(); // dedupe by resolved abs path
  const underCap: ArtifactCandidate[] = []; // passed the per-file cap; count/total applied below
  const overCap: ArtifactCandidate[] = [];

  for (const [raw, tool] of harvested) {
    // 1. resolve to absolute against cwd (leaves an already-absolute path alone).
    const abs = path.resolve(cwd, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);

    // 2. must exist and be a regular file (skip deleted/renamed/dirs).
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    // 3. don't double-ship what's already staged under .cloud-code/artifacts/.
    if (abs === artifactsDir || abs.startsWith(artifactsDir + path.sep)) continue;

    // 4. must live within cwd. A transcript records ABSOLUTE paths (claude logs
    //    them for Read), so a file the session merely read outside the project —
    //    /etc/passwd, ~/.aws/credentials — would otherwise resolve to a `..`-rel
    //    candidate. Those aren't deliverables; drop them so neither their bytes
    //    NOR their path/size ever leave the laptop (defense in depth — the server
    //    re-validates rels too, but detection shouldn't surface them at all).
    const rel = path.relative(cwd, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

    // 5. never ship a credential file. A producer-only harvest already drops
    //    Read-logged secrets for claude, but the codex/kiro regex pass can't
    //    attribute a tool, and an agent can write-then-read a secret — so match
    //    unambiguous credential names/extensions and skip them regardless.
    if (isSecretPath(rel)) continue;

    // 6. never ship git-tracked files — code travels in the bundle.
    if (await isGitTracked(repoDir, abs)) continue;

    const cand: ArtifactCandidate = {
      rel,
      abs,
      bytes: st.size,
      kind: classify(rel),
      tool,
      overCap: st.size > cap,
    };
    (cand.overCap ? overCap : underCap).push(cand);
  }

  // Stable, human-friendly ordering: SMALLEST first so the count/total caps keep
  // the most files (a runaway is usually one giant outlier, not many small ones).
  underCap.sort((a, b) => a.bytes - b.bytes);
  overCap.sort((a, b) => b.bytes - a.bytes);

  // Apply the aggregate guards (count + total bytes). What spills is reported as
  // `dropped` — never silently swallowed.
  const candidates: ArtifactCandidate[] = [];
  const dropped: ArtifactCandidate[] = [];
  let running = 0;
  for (const c of underCap) {
    if (candidates.length >= countCap || running + c.bytes > totalCap) {
      dropped.push(c);
      continue;
    }
    candidates.push(c);
    running += c.bytes;
  }
  candidates.sort((a, b) => b.bytes - a.bytes); // present largest-first
  dropped.sort((a, b) => b.bytes - a.bytes);

  return {
    candidates,
    overCap,
    dropped,
    count: candidates.length,
    totalBytes: running,
    fileCapBytes: cap,
  };
}

/** Compact, human-readable bytes for the port summary. */
export function fmtBytes(n: number): string {
  if (n >= 1024 * MB) return `${(n / 1024 / MB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Stream one artifact to its presigned S3 PUT URL. Streaming (not buffering) is
 * what makes large media safe: a 400 MB MP4 flows file → socket without ever
 * sitting whole in the MCP's heap. Returns nothing on success; throws on a
 * non-2xx so the caller can count + name the failure.
 */
export async function uploadArtifact(url: string, abs: string, bytes: number): Promise<void> {
  const nodeStream = createReadStream(abs);
  const res = await fetch(url, {
    method: "PUT",
    // S3 presigned PUT needs an explicit length for a streamed body.
    headers: { "Content-Length": String(bytes), "Content-Type": "application/octet-stream" },
    body: Readable.toWeb(nodeStream) as ReadableStream,
    // @ts-expect-error — Node's fetch requires duplex for a streaming request body.
    duplex: "half",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/** Make sure `.cloud-code/` is git-ignored in `repoDir` BEFORE anything is staged
 *  there. We write `.git/info/exclude` (local, not the tracked `.gitignore`) so
 *  we never dirty a committed file. Without this, staging into `.cloud-code/artifacts`
 *  leaves the tree dirty, and pull's `pullBranch` refuses to check out / fast
 *  forward against a non-empty `git status --porcelain` — the cloud code would
 *  never come home. Idempotent + best-effort. */
export async function ensureCloudCodeExcluded(repoDir: string): Promise<void> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoDir });
    const excludeFile = path.resolve(repoDir, stdout.trim());
    let body = "";
    try {
      body = await readFile(excludeFile, "utf8");
    } catch {
      /* file may not exist yet — append creates it */
    }
    const hasRule = body
      .split("\n")
      .some((l) => l.trim().replace(/\/$/, "") === ".cloud-code" || l.trim() === "/.cloud-code");
    if (hasRule) return;
    const prefix = body.length && !body.endsWith("\n") ? "\n" : "";
    await mkdir(path.dirname(excludeFile), { recursive: true });
    await appendFile(excludeFile, `${prefix}# Cloud Code session staging (not tracked)\n.cloud-code/\n`);
  } catch {
    /* not a git repo / git missing — staging just risks a dirty tree, non-fatal */
  }
}

/** Copy a shipped artifact into the local `.cloud-code/artifacts/<rel>` staging dir so
 *  the pull round trip stays symmetric (the cloud lands files in the same place).
 *  Call ensureCloudCodeExcluded(repoDir) once before staging so the copy can't dirty
 *  the tree. Best-effort: a copy failure must not fail the port. */
export async function stageArtifactLocally(cwd: string, rel: string, abs: string): Promise<void> {
  const dest = path.join(cwd, ".cloud-code", "artifacts", rel);
  if (path.resolve(dest) === path.resolve(abs)) return; // already there
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(abs, dest);
}

/** Validate a workspace-relative artifact path from the server (defense in depth
 *  for the pull leg): reject absolute / `..`-traversing rels so a presigned-GET
 *  manifest can't write outside the local .cloud-code/artifacts/. Returns a safe POSIX
 *  rel or null. */
export function safeRelPath(rel: string): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/")) return null;
  if (norm.split("/").some((s) => s === ".." || s === "")) return null;
  return norm;
}

/** Download one pulled artifact from its presigned GET URL into the local
 *  workspace's .cloud-code/artifacts/<rel>. Streams response → file so large media
 *  never buffers whole. Throws on a non-2xx / unsafe rel so the caller can count
 *  + name failures. */
export async function downloadArtifact(cwd: string, rel: string, url: string): Promise<void> {
  const safe = safeRelPath(rel);
  if (!safe) throw new Error("unsafe artifact path");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
  const dest = path.join(cwd, ".cloud-code", "artifacts", safe);
  await mkdir(path.dirname(dest), { recursive: true });
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}
