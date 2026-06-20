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

/** Portability of one MCP server in the cloud microVM. */
export type ServerCategory = "works" | "needs-secret" | "unsupported";
export type ServerTransport =
  | "remote" // http/sse — runs anywhere
  | "npx"
  | "uvx"
  | "pipx" // registry launcher — self-installs in the cloud
  | "local-path" // command is an absolute/relative path — won't exist in cloud
  | "interpreter-script" // node/python pointed at a local script
  | "bare-binary"; // a binary expected on PATH but not in the image

export interface ClassifiedServer {
  name: string;
  category: ServerCategory;
  transport: ServerTransport;
  reason?: string; // unsupported: an actionable hint
  redactedEnv?: string[]; // env keys we blanked (secret-looking)
}

export interface GatherResult {
  zip: Buffer;
  files: string[]; // bundle-relative paths included (e.g. "claude/CLAUDE.md")
  redactedEnv: string[]; // "server.ENV_KEY" entries blanked for safety
  droppedServers: string[]; // servers excluded from the shipped config (unsupported)
  skipped: string[]; // sources that weren't found locally
  classified: ClassifiedServer[]; // every MCP server, with its cloud verdict
}

const SECRET_RE = /(token|secret|key|pat|password|passwd|api[-_]?key|access|bearer)/i;
const HOME = process.env.PORT_SESSION_HOME || homedir();

const LAUNCHERS = new Set(["npx", "uvx", "pipx"]);
const INTERPRETERS = new Set(["node", "python", "python3", "bash", "sh", "deno", "bun", "ruby"]);

// Servers that self-install via npx/uvx (so they LOOK portable) but can't function
// in a Linux cloud microVM — platform-locked to the host OS/toolchain. Matched as a
// substring of the package/command so registry name variants still catch.
const PLATFORM_LOCKED: { match: string; reason: string }[] = [
  { match: "xcodebuild", reason: "needs macOS + Xcode; can't run in a Linux cloud microVM" },
];

function platformLocked(srv: ServerDesc): string | undefined {
  const hay = `${srv.command || ""} ${(srv.args || []).join(" ")}`.toLowerCase();
  return PLATFORM_LOCKED.find((p) => hay.includes(p.match))?.reason;
}

interface ServerDesc {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function basenameCmd(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] || "";
  return first.split("/").pop() || first;
}

function looksLocal(s: string): boolean {
  return s.startsWith("/") || s.startsWith("~") || s.startsWith(".");
}

/**
 * Decide whether an MCP server can run in the cloud microVM. The contract:
 * remote (http/sse) and registry-launched (npx/uvx/pipx) servers self-install
 * and run; local-path / interpreter-script / bare-binary commands can't (their
 * binary or script isn't in the shared image) and are flagged with a fix hint.
 * A secret-looking env value tags an otherwise-runnable server "needs-secret".
 */
function classifyServer(name: string, srv: ServerDesc): ClassifiedServer {
  const redactedEnv: string[] = [];
  if (srv.env) {
    for (const k of Object.keys(srv.env)) {
      if (SECRET_RE.test(k) && srv.env[k]) redactedEnv.push(k);
    }
  }
  const env = redactedEnv.length ? redactedEnv : undefined;
  const okCategory: ServerCategory = redactedEnv.length ? "needs-secret" : "works";

  // Platform-locked servers self-install but can't function on Linux — flag first.
  const locked = platformLocked(srv);
  if (locked) {
    const base = basenameCmd(srv.command || "");
    const transport: ServerTransport = srv.url
      ? "remote"
      : LAUNCHERS.has(base)
      ? (base as ServerTransport)
      : "bare-binary";
    return { name, category: "unsupported", transport, reason: locked };
  }

  if (srv.type === "http" || srv.type === "sse" || srv.url) {
    return { name, category: okCategory, transport: "remote", redactedEnv: env };
  }
  const command = (srv.command || "").trim();
  if (!command) {
    return { name, category: "unsupported", transport: "bare-binary", reason: "no command or url" };
  }
  if (looksLocal(command)) {
    return {
      name,
      category: "unsupported",
      transport: "local-path",
      reason: "local path won't exist in the cloud; reconfigure as `uvx <pkg>` or `npx <pkg>`",
    };
  }
  const base = basenameCmd(command);
  const args = srv.args || [];
  if (LAUNCHERS.has(base) || (base === "uv" && args[0] === "run") || (base === "pipx" && args[0] === "run")) {
    const transport: ServerTransport = base === "npx" ? "npx" : base === "pipx" ? "pipx" : "uvx";
    return { name, category: okCategory, transport, redactedEnv: env };
  }
  if (INTERPRETERS.has(base)) {
    const hasScript = args.some((a) => looksLocal(a) || /\.(js|mjs|cjs|ts|py)$/.test(a));
    if (hasScript) {
      return {
        name,
        category: "unsupported",
        transport: "interpreter-script",
        reason: "runs a local script not in the cloud; reconfigure as `uvx <pkg>` or `npx <pkg>`",
      };
    }
  }
  return {
    name,
    category: "unsupported",
    transport: "bare-binary",
    reason: `'${base}' isn't in the cloud image; reconfigure as \`uvx <pkg>\` or \`npx <pkg>\``,
  };
}

/** Best-effort scan of a codex config.toml for [mcp_servers.<name>] tables, for
 *  the REPORT only — the toml still ships verbatim. */
function classifyCodexServers(toml: string): ClassifiedServer[] {
  const out: ClassifiedServer[] = [];
  let cur: (ServerDesc & { name: string }) | null = null;
  const flush = () => {
    if (cur) out.push(classifyServer(cur.name, cur));
    cur = null;
  };
  for (const raw of toml.split(/\r?\n/)) {
    const t = raw.trim();
    const sec = t.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (sec) {
      flush();
      cur = { name: sec[1].replace(/^["']|["']$/g, "") };
      continue;
    }
    if (t.startsWith("[")) {
      flush();
      continue;
    }
    if (!cur) continue;
    const kv = t.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (key === "command") cur.command = val.replace(/^["']|["']$/g, "");
    else if (key === "url") cur.url = val.replace(/^["']|["']$/g, "");
    else if (key === "args") {
      const m = val.match(/\[(.*)\]/);
      cur.args = m
        ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
    }
  }
  flush();
  return out;
}

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

/** Pull mcpServers out of ~/.claude.json, classify each for cloud portability,
 *  and build the shipped map: only `works`/`needs-secret` servers are included
 *  (so the cloud never advertises a dead server), with secret env blanked.
 *  Records the classification + redactions into `res` for the sync report. */
async function sanitizeClaudeMcp(res: GatherResult): Promise<Record<string, unknown> | null> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(await readFile(path.join(HOME, ".claude.json"), "utf8"));
  } catch {
    return null;
  }
  const servers = (doc.mcpServers || {}) as Record<string, ServerDesc>;
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (name === "port-session") continue; // the laptop-only handoff tool itself
    const verdict = classifyServer(name, raw);
    res.classified.push(verdict);
    for (const k of verdict.redactedEnv || []) res.redactedEnv.push(`${name}.${k}`);

    if (verdict.category === "unsupported") {
      res.droppedServers.push(name);
      continue; // don't ship it — the cloud would just fail to launch it
    }
    // Ship it, blanking any secret-looking env value (set in the cloud later).
    const srv: ServerDesc = { ...raw };
    if (srv.env) {
      const env = { ...srv.env };
      for (const k of verdict.redactedEnv || []) env[k] = "";
      srv.env = env;
    }
    out[name] = srv;
  }
  return { mcpServers: out };
}

function emptyResult(): GatherResult {
  return { zip: Buffer.alloc(0), files: [], redactedEnv: [], droppedServers: [], skipped: [], classified: [] };
}

async function gatherClaude(): Promise<GatherResult> {
  const zip = new JSZip();
  const res = emptyResult();
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
  const res = emptyResult();
  const root = path.join(HOME, ".codex");

  // Codex MCP servers + provider live in config.toml; we ship it verbatim
  // (TOML secret redaction is out of scope — flagged in the tool output) but
  // classify its [mcp_servers.*] tables for the report.
  const tomlPath = path.join(root, "config.toml");
  if (await addFile(zip, tomlPath, "codex/config.toml", res.files)) {
    try {
      const verdicts = classifyCodexServers(await readFile(tomlPath, "utf8"));
      res.classified.push(...verdicts);
      for (const v of verdicts) {
        if (v.category === "unsupported") res.droppedServers.push(v.name);
        for (const k of v.redactedEnv || []) res.redactedEnv.push(`${v.name}.${k}`);
      }
    } catch {
      /* report-only; shipping the toml verbatim is unaffected */
    }
  } else {
    res.skipped.push("~/.codex/config.toml");
  }
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
