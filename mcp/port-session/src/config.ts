/**
 * Gather a CLI's *local* config into a Cloud Code config bundle (a zip laid out
 * as `claude/...` or `codex/...`) so the cloud session is a clone of your laptop
 * setup — same CLAUDE.md / AGENTS.md, skills, custom agents, and MCP servers.
 *
 * This is a one-time (or whenever-you-change-it) sync, NOT part of every port.
 * One CLI at a time: `cli="claude"` grabs the Claude Code setup, `cli="codex"`
 * the Codex setup. The server-side `/config` route merges the subtree into the
 * current bundle, so syncing one CLI never wipes the other.
 *
 * Two things never ship verbatim:
 *   - MCP servers whose `command` is an absolute local path (a binary that
 *     doesn't exist in the cloud microVM) are dropped — only registry-launched
 *     servers (`npx`/`uvx`/PATH commands) self-install there.
 *   - secret-looking `env` values (token/key/secret/pat/password) are redacted to
 *     "" and reported, so we don't dump credentials into S3.
 */
import JSZip from "jszip";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Cli = "claude" | "codex";

export interface GatherResult {
  zip: Buffer;
  files: string[]; // bundle-relative paths included (e.g. "claude/CLAUDE.md")
  redactedEnv: string[]; // "server.ENV_KEY" entries blanked for safety
  droppedServers: string[]; // local-path MCP servers we couldn't ship
  skipped: string[]; // sources that weren't found locally
}

const SECRET_RE = /(token|secret|key|pat|password|passwd|api[-_]?key|access|bearer)/i;
const HOME = process.env.PORT_SESSION_HOME || homedir();

/** Recursively add a directory's files to the zip under a bundle prefix. */
async function addDir(
  zip: JSZip,
  absDir: string,
  bundlePrefix: string,
  out: string[]
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(absDir, { recursive: true });
  } catch {
    return false;
  }
  let added = false;
  for (const rel of entries) {
    const abs = path.join(absDir, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const bundlePath = path.posix.join(bundlePrefix, rel.split(path.sep).join("/"));
    zip.file(bundlePath, await readFile(abs));
    out.push(bundlePath);
    added = true;
  }
  return added;
}

/** Add a single file if it exists. Returns whether it was added. */
async function addFile(
  zip: JSZip,
  abs: string,
  bundlePath: string,
  out: string[]
): Promise<boolean> {
  try {
    zip.file(bundlePath, await readFile(abs));
    out.push(bundlePath);
    return true;
  } catch {
    return false;
  }
}

/** Pull mcpServers out of ~/.claude.json, dropping unshippable ones + redacting
 *  secret env. Returns the sanitized map plus what we changed (for the report). */
async function sanitizeClaudeMcp(
  res: Pick<GatherResult, "redactedEnv" | "droppedServers">
): Promise<Record<string, unknown> | null> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await readFile(path.join(HOME, ".claude.json"), "utf8"));
  } catch {
    return null;
  }
  const servers = (doc.mcpServers || {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (name === "port-session") continue; // the laptop-only handoff tool itself
    const srv = { ...raw };
    const command = typeof srv.command === "string" ? srv.command : "";
    // Absolute-local-path stdio servers can't run in the cloud microVM. Remote
    // (http/sse) and registry-launched (npx/uvx/PATH) servers can.
    if (command.startsWith("/") || command.startsWith("~") || command.startsWith(".")) {
      res.droppedServers.push(name);
      continue;
    }
    if (srv.env && typeof srv.env === "object") {
      const env = { ...(srv.env as Record<string, string>) };
      for (const k of Object.keys(env)) {
        if (SECRET_RE.test(k) && env[k]) {
          env[k] = "";
          res.redactedEnv.push(`${name}.${k}`);
        }
      }
      srv.env = env;
    }
    out[name] = srv;
  }
  return { mcpServers: out };
}

async function gatherClaude(): Promise<GatherResult> {
  const zip = new JSZip();
  const res: GatherResult = { zip: Buffer.alloc(0), files: [], redactedEnv: [], droppedServers: [], skipped: [] };
  const root = path.join(HOME, ".claude");

  if (!(await addFile(zip, path.join(root, "CLAUDE.md"), "claude/CLAUDE.md", res.files)))
    res.skipped.push("~/.claude/CLAUDE.md");
  for (const dir of ["agents", "skills", "commands", "output-styles"]) {
    if (!(await addDir(zip, path.join(root, dir), `claude/${dir}`, res.files)))
      res.skipped.push(`~/.claude/${dir}/`);
  }
  const mcp = await sanitizeClaudeMcp(res);
  if (mcp) {
    zip.file("claude/.mcp.json", JSON.stringify(mcp, null, 2));
    res.files.push("claude/.mcp.json");
  } else {
    res.skipped.push("~/.claude.json (mcpServers)");
  }

  res.zip = await zip.generateAsync({ type: "nodebuffer" });
  return res;
}

async function gatherCodex(): Promise<GatherResult> {
  const zip = new JSZip();
  const res: GatherResult = { zip: Buffer.alloc(0), files: [], redactedEnv: [], droppedServers: [], skipped: [] };
  const root = path.join(HOME, ".codex");

  // Codex MCP servers + provider live in config.toml; we ship it verbatim
  // (TOML secret redaction is out of scope — flagged in the tool output).
  if (!(await addFile(zip, path.join(root, "config.toml"), "codex/config.toml", res.files)))
    res.skipped.push("~/.codex/config.toml");
  if (!(await addFile(zip, path.join(root, "AGENTS.md"), "codex/AGENTS.md", res.files)))
    res.skipped.push("~/.codex/AGENTS.md");
  if (!(await addDir(zip, path.join(root, "prompts"), "codex/prompts", res.files)))
    res.skipped.push("~/.codex/prompts/");

  res.zip = await zip.generateAsync({ type: "nodebuffer" });
  return res;
}

export async function gatherBundle(cli: Cli): Promise<GatherResult> {
  return cli === "codex" ? gatherCodex() : gatherClaude();
}
