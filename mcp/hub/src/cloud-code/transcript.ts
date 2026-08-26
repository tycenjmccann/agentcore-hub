/**
 * Extract a compact conversation context from the local Claude Code transcript.
 *
 * Claude Code stores one .jsonl per session under
 *   ~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl
 * The raw file is large (tool calls, file snapshots, attachments, mode records).
 * For the cloud handoff we only need the human↔assistant thread, so we keep
 * `user` and `assistant` text and drop everything else, then tail it to a budget.
 */
import { readdir, readFile, stat, realpath, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** cwd → the on-disk project dir name Claude Code uses.
 *  Claude slugifies the REAL (symlink-resolved) path with EVERY non-alphanumeric
 *  char → '-' (not just slashes). So a path with spaces/dots ("Q Projects",
 *  "my.app") must be encoded the same way or the lookup misses. */
export function slugForPath(realCwd: string): string {
  return realCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function projectDirFor(cwd: string): Promise<string> {
  // Resolve symlinks (e.g. macOS /var → /private/var) before slugifying.
  let real = cwd;
  try {
    real = await realpath(cwd);
  } catch {
    /* path may not exist yet; fall back to the given cwd */
  }
  return path.join(homedir(), ".claude", "projects", slugForPath(real));
}

/** Newest transcript .jsonl in a project dir (= the current/most recent session). */
export async function newestTranscript(cwd: string): Promise<string | null> {
  const dir = await projectDirFor(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonls.length === 0) return null;
  const withMtime = await Promise.all(
    jsonls.map(async (f) => ({ f, m: (await stat(path.join(dir, f))).mtimeMs }))
  );
  withMtime.sort((a, b) => b.m - a.m);
  return path.join(dir, withMtime[0].f);
}

/** Local path where `claude --resume <sessionId>` expects this session's file. */
export async function localTranscriptPath(cwd: string, sessionId: string): Promise<string> {
  return path.join(await projectDirFor(cwd), `${sessionId}.jsonl`);
}

/**
 * Write a pulled cloud transcript to the local project slug so `claude --resume`
 * picks it up. The cloud copy IS the canonical latest after a round trip (it's
 * this same session, grown), so we always overwrite the stale local file — that's
 * the whole point. We back the old one up to `<id>.jsonl.bak-<stamp>` first so a
 * divergent local branch (rare: you also kept working locally) is recoverable.
 * Returns the written path + any backup made.
 */
export async function installLocalTranscript(
  cwd: string,
  sessionId: string,
  data: Buffer | Uint8Array,
  opts: { force?: boolean; stamp?: string } = {}
): Promise<{ path: string; overwrote: boolean; backup?: string }> {
  const dest = await localTranscriptPath(cwd, sessionId);
  await mkdir(path.dirname(dest), { recursive: true });

  let overwrote = false;
  let backup: string | undefined;
  try {
    const existing = await readFile(dest);
    overwrote = true;
    // Only bother backing up if the local copy differs from what we're writing.
    if (!Buffer.from(existing).equals(Buffer.from(data))) {
      backup = `${dest}.bak-${opts.stamp || "prev"}`;
      await writeFile(backup, existing);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await writeFile(dest, data);
  return { path: dest, overwrote, backup };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Assistant content is blocks; keep text blocks, summarize tool_use briefly.
    return content
      .map((b: any) => {
        if (b?.type === "text") return b.text || "";
        if (b?.type === "tool_use") return `[used tool: ${b.name}]`;
        if (b?.type === "tool_result") return ""; // tool output is noise for handoff
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The Claude session id for a transcript = its filename (verified: the
 *  filename always equals the `sessionId` field inside the records). */
export function sessionIdForTranscript(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, "");
}

export interface ExtractOptions {
  maxChars?: number; // budget for the returned context (default 120k)
}

export interface ExtractResult {
  context: string;
  turns: number;
  truncated: boolean;
  sourceFile: string;
}

/**
 * Read a transcript file and produce a compact "User:/Assistant:" thread,
 * tailed to maxChars (most recent turns win — that's where the live work is).
 */
export async function extractContext(file: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const maxChars = opts.maxChars ?? 120_000;
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  const turns: string[] = [];
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (rec.isMeta) continue; // injected reminders, not real turns
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;
    const text = textFromContent(msg.content).trim();
    if (!text) continue;
    const who = rec.type === "user" ? "User" : "Assistant";
    turns.push(`${who}: ${text}`);
  }

  // Tail to budget: keep the most recent turns.
  let truncated = false;
  let joined = turns.join("\n\n");
  if (joined.length > maxChars) {
    truncated = true;
    // Walk back from the end accumulating turns until we hit the budget.
    const kept: string[] = [];
    let total = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      total += turns[i].length + 2;
      if (total > maxChars) break;
      kept.unshift(turns[i]);
    }
    joined = `[…earlier turns trimmed…]\n\n${kept.join("\n\n")}`;
  }

  return { context: joined, turns: turns.length, truncated, sourceFile: file };
}
