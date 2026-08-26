#!/usr/bin/env node
/**
 * port-session-mcp — a local stdio MCP server that hands your in-flight laptop
 * coding session off to Cloud Code, so you can close the laptop and pick the
 * exact same session back up from your phone on the train.
 *
 * One tool: `port_session_to_cloud`. When called it:
 *   1. reads git state in your project (cwd)
 *   2. commits + pushes the in-flight work to a branch (Cloud Code can only see
 *      the remote)
 *   3. extracts a compact context from the local Claude Code transcript
 *   4. POSTs it to the Cloud Code `/api/cloud-code/sessions/port` endpoint
 *   5. returns a deep link — open it on any device and the cloud agent clones,
 *      checks out the branch, and resumes from your context.
 *
 * Config via env (set in the MCP server registration):
 *   CLOUD_CODE_URL  — base URL of the deployed app (required)
 *   PROJECT_CWD     — project dir; defaults to process.cwd()
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readState, prepareGitHandoff, pullBranch } from "./git.js";
import { newestTranscript, sessionIdForTranscript, installLocalTranscript } from "./transcript.js";
import { detectArtifacts, uploadArtifact, stageArtifactLocally, downloadArtifact, ensureCloudCodeExcluded, fmtBytes } from "./artifacts.js";
import { gatherBundle, type Cli } from "./config.js";

const CLOUD_CODE_URL = (process.env.CLOUD_CODE_URL || "").replace(/\/$/, "");

const InputSchema = z.object({
  title: z
    .string()
    .optional()
    .describe("Short name for the session — used as the sidebar title and as a one-line hint to the cloud agent about what you're working on."),
  branch: z
    .string()
    .optional()
    .describe("Branch to push the in-flight work to. Defaults to the current branch."),
  firstPrompt: z
    .string()
    .optional()
    .describe("Optional first instruction for the cloud agent on resume, e.g. 'focus on the scroll bug first'."),
  cli: z.enum(["claude", "codex"]).optional().describe("Which cloud CLI to resume with. Default: claude."),
  view: z
    .enum(["chat", "terminal"])
    .optional()
    .describe("Which surface the deep link opens. Default chat (mobile-friendly). 'terminal' auto-runs `claude --resume` in a live shell."),
  commitMessage: z.string().optional().describe("Commit message for the in-flight snapshot."),
  cwd: z.string().optional().describe("Project directory. Defaults to the server's cwd."),
  preferBundle: z
    .boolean()
    .optional()
    .describe("Force bundle mode (ship a git bundle instead of pushing) even when origin is writable."),
  artifacts: z
    .enum(["y", "n", "auto"])
    .optional()
    .describe("Ship session-touched untracked files (images/exports/data/media) to the cloud. auto/y=detect+ship, n=skip. Default auto."),
});

const server = new Server(
  { name: "port-session-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

const TOOL = {
  name: "port_session_to_cloud",
  description:
    "Hand off the current in-flight coding session to Cloud Code so it can be " +
    "resumed from any device. Commits and pushes your work to a branch, packages " +
    "this conversation's context, and starts a cloud session that picks up where " +
    "you left off. Returns a link to open on your phone. Use when you want to " +
    "stop working locally (e.g. 'port this to the cloud, I'm catching the train').",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short session name — sidebar title + one-line hint to the agent." },
      branch: { type: "string", description: "Branch to push to. Defaults to the current branch." },
      firstPrompt: { type: "string", description: "First instruction for the resumed cloud agent (optional)." },
      view: { type: "string", enum: ["chat", "terminal"], description: "Deep-link surface. Default chat; 'terminal' auto-runs claude --resume in a shell." },
      cli: { type: "string", enum: ["claude", "codex"], description: "Cloud CLI to resume with. Default claude." },
      commitMessage: { type: "string", description: "Commit message for the in-flight snapshot." },
      cwd: { type: "string", description: "Project directory. Defaults to the server cwd." },
      preferBundle: { type: "boolean", description: "Force bundle mode even when origin is writable." },
      artifacts: { type: "string", enum: ["y", "n", "auto"], description: "Ship session-touched untracked files to the cloud. Default auto." },
    },
  },
};

const PULL_TOOL = {
  name: "pull_session_from_cloud",
  description:
    "Bring a Cloud Code session back to this laptop (the round trip). Asks the " +
    "cloud to checkpoint the session's transcript, pulls the cloud's branch + " +
    "the grown transcript down, and places it so `claude --resume <id>` continues " +
    "locally right where the cloud left off. Use when you're back at your desk " +
    "after working from your phone. Provide the session id (from the deep link) " +
    "or the Cloud Code session URL.",
  inputSchema: {
    type: "object",
    properties: {
      session: { type: "string", description: "Cloud Code session id (cc-...) or the full session URL." },
      cwd: { type: "string", description: "Project directory to resume into. Defaults to the server cwd." },
    },
    required: ["session"],
  },
};

const SYNC_TOOL = {
  name: "sync_cli_config",
  description:
    "One-time setup: mirror this laptop's coding-CLI configuration to Cloud Code " +
    "so cloud sessions are a clone of your local setup (CLAUDE.md / AGENTS.md, " +
    "skills, custom agents, MCP servers). Run once per CLI — `cli:\"claude\"` " +
    "uploads your Claude Code config, `cli:\"codex\"` your Codex config; run twice " +
    "for both. Not part of porting — config is reused by every future session. " +
    "Local-only MCP servers (absolute-path commands) are dropped (they can't run " +
    "in the cloud) and secret env values are redacted before upload.",
  inputSchema: {
    type: "object",
    properties: {
      cli: { type: "string", enum: ["claude", "codex"], description: "Which CLI's config to sync. Required — one at a time." },
    },
    required: ["cli"],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL, PULL_TOOL, SYNC_TOOL] }));

// Slash-command surface: a `port` prompt shows up as
// /mcp__port-session__port. Selecting it tells Claude to call the tool now.
const PORT_PROMPT = {
  name: "port",
  description: "Port this coding session to Cloud Code (commit + push, then resume in the cloud).",
  // One free-text arg so spaces don't split across placeholders. Comma-separated:
  //   view (chat|terminal), title, first prompt, new branch — all optional.
  arguments: [
    {
      name: "view, title, first prompt, new branch",
      description: "Comma-separated, all optional. view=chat|terminal (default chat). e.g. \"terminal, fix scroll, start on the terminal bug, wip/train\"",
      required: false,
    },
  ],
};

const PULL_PROMPT = {
  name: "pull",
  description: "Pull a Cloud Code session back to this laptop (round trip) and resume locally.",
  arguments: [
    { name: "session id or URL", description: "The cc-... id or the Cloud Code session link.", required: true },
  ],
};

const SYNC_PROMPT = {
  name: "sync-config",
  description: "Mirror this laptop's CLI config (skills, agents, MCP) to Cloud Code. One CLI at a time.",
  arguments: [{ name: "cli", description: "claude or codex (required).", required: true }],
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [PORT_PROMPT, PULL_PROMPT, SYNC_PROMPT] }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === "sync-config") {
    const cli = (Object.values((req.params.arguments ?? {}) as Record<string, string>)[0] || "claude").trim();
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Sync my local ${cli} CLI configuration to Cloud Code by calling the ` +
              `sync_cli_config tool now with cli="${cli}". After it returns, show me ` +
              `what was uploaded and anything that was dropped or redacted.`,
          },
        },
      ],
    };
  }
  if (req.params.name === "pull") {
    const v = Object.values((req.params.arguments ?? {}) as Record<string, string>)[0] || "";
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Pull my Cloud Code session "${v}" back to this laptop by calling the ` +
              `pull_session_from_cloud tool now. After it returns, show me the ` +
              `\`claude --resume\` command to continue locally.`,
          },
        },
      ],
    };
  }
  const a = (req.params.arguments ?? {}) as Record<string, string>;
  // The single arg's name is a human label; read it positionally regardless.
  const raw = Object.values(a)[0] || "";
  const [view, title, firstPrompt, branch] = raw.split(",").map((s) => s.trim());
  const extras: string[] = [];
  if (view === "terminal" || view === "chat") extras.push(`Open in the ${view} view.`);
  if (title) extras.push(`Use session title: "${title}".`);
  if (firstPrompt) extras.push(`First instruction for the cloud agent on resume: "${firstPrompt}".`);
  if (branch) extras.push(`Push to branch: "${branch}".`);
  const text =
    "Port my current coding session to Cloud Code by calling the " +
    "port_session_to_cloud tool now. " +
    (extras.length ? extras.join(" ") + " " : "") +
    "After it returns, show me the deep link so I can open it on my phone.";
  return {
    messages: [{ role: "user", content: { type: "text", text } }],
  };
});

const PullSchema = z.object({
  session: z.string(),
  cwd: z.string().optional(),
});

async function runPull(rawArgs: unknown) {
  if (!CLOUD_CODE_URL) throw new Error("CLOUD_CODE_URL is not set in the MCP server environment.");
  const args = PullSchema.parse(rawArgs ?? {});
  const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();
  // Accept a raw id or a full deep link.
  const m = args.session.match(/cc-[a-f0-9]+/i);
  const sid = m ? m[0] : args.session.trim();

  // 1. checkpoint: cloud uploads the grown transcript + returns a presigned GET.
  const res = await fetch(`${CLOUD_CODE_URL}/api/cloud-code/sessions/${sid}/checkpoint`, {
    method: "POST",
    signal: AbortSignal.timeout(110_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    transcriptUrl?: string;
    claudeSessionId?: string;
    branch?: string;
    repo?: string;
    bytes?: number;
    artifacts?: { rel: string; url: string; bytes: number }[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `checkpoint returned ${res.status}`);
  if (!data.transcriptUrl || !data.claudeSessionId) {
    throw new Error("checkpoint did not return a transcript URL / session id");
  }

  // 2. download the transcript bytes.
  const dl = await fetch(data.transcriptUrl, { signal: AbortSignal.timeout(60_000) });
  if (!dl.ok) throw new Error(`transcript download failed: ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());

  // 3. write it where `claude --resume` will find it. The cloud copy is the
  //    canonical latest (same session, grown) so we overwrite; a differing local
  //    copy is backed up to .bak-<stamp> first.
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const placed = await installLocalTranscript(cwd, data.claudeSessionId, bytes, { stamp });

  // 4. pull the cloud's branch home so local code matches the transcript.
  //    Exclude .cloud-code/ first: a prior port staged artifacts there, and
  //    pullBranch refuses a dirty tree.
  let gitNote = "no branch reported";
  if (data.branch) {
    try {
      await ensureCloudCodeExcluded(cwd).catch(() => {});
      gitNote = await pullBranch(cwd, data.branch);
    } catch (e) {
      gitNote = `branch pull failed: ${(e as Error).message}`;
    }
  }

  // 5. bring home the cloud session's artifacts (touched-untracked deliverables
  //    it produced — media, exports, data). Streamed into local .cloud-code/artifacts/.
  const pulledArtifacts: string[] = [];
  const failedArtifacts: string[] = [];
  let artifactBytes = 0;
  if (data.artifacts?.length) {
    await Promise.all(
      data.artifacts.map(async (a) => {
        try {
          await downloadArtifact(cwd, a.rel, a.url);
          pulledArtifacts.push(a.rel);
          artifactBytes += a.bytes || 0;
        } catch {
          failedArtifacts.push(a.rel);
        }
      })
    );
  }
  const artifactLine =
    pulledArtifacts.length > 0
      ? `Artifacts: ${pulledArtifacts.length} pulled (${fmtBytes(artifactBytes)}) → .cloud-code/artifacts/ — ${pulledArtifacts.slice(0, 8).join(", ")}`
      : "";
  const artifactFailLine =
    failedArtifacts.length > 0 ? `⚠️ ${failedArtifacts.length} artifact(s) failed: ${failedArtifacts.join(", ")}` : "";

  const sizeMb = (bytes.length / 1_048_576).toFixed(1);
  const summary = [
    `✅ Pulled session home.`,
    ``,
    data.repo ? `Repo: ${data.repo}` : "",
    data.branch ? `Branch: ${gitNote}` : "",
    `Transcript: ${sizeMb} MB → ${placed.path}${placed.overwrote ? " (overwrote local)" : ""}`,
    placed.backup ? `Prior local copy backed up → ${placed.backup}` : "",
    artifactLine,
    artifactFailLine,
    ``,
    `Now exit this session and resume the pulled one:`,
    `  /exit`,
    `  claude --resume ${data.claudeSessionId}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { content: [{ type: "text", text: summary }] };
}

const SyncSchema = z.object({ cli: z.enum(["claude", "codex"]) });

async function runSync(rawArgs: unknown) {
  if (!CLOUD_CODE_URL) throw new Error("CLOUD_CODE_URL is not set in the MCP server environment.");
  const { cli } = SyncSchema.parse(rawArgs ?? {});

  // 1. gather this CLI's local config into a bundle zip (claude/... or codex/...).
  const g = await gatherBundle(cli as Cli);
  if (g.files.length === 0) {
    throw new Error(`No local ${cli} config found to sync (looked under ~/.${cli}).`);
  }

  // 2. upload to /config with scope=<cli> so the server MERGES this CLI's subtree
  //    into the current bundle — syncing one CLI never wipes the other.
  const form = new FormData();
  form.set("bundle", new Blob([new Uint8Array(g.zip)], { type: "application/zip" }), `${cli}-config.zip`);
  form.set("label", `${cli} config sync`);
  form.set("scope", cli);
  const res = await fetch(`${CLOUD_CODE_URL}/api/cloud-code/config`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    version?: { version?: string; fileCount?: number };
    currentVersion?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `config upload returned ${res.status}`);

  const sizeKb = (g.zip.length / 1024).toFixed(0);

  // MCP servers split into three buckets so the engineer knows exactly what will
  // and won't run in the cloud, and how to fix the ones that won't.
  const works = g.classified.filter((c) => c.category === "works");
  const needsSecret = g.classified.filter((c) => c.category === "needs-secret");
  const unsupported = g.classified.filter((c) => c.category === "unsupported");

  const lines: string[] = [
    `✅ Synced ${cli} config to Cloud Code.`,
    ``,
    `Uploaded ${g.files.length} files (${sizeKb} KB) — now the active config bundle.`,
    `Included: ${g.files.map((f) => f.replace(`${cli}/`, "")).join(", ")}`,
  ];

  if (g.classified.length) {
    lines.push(``, `MCP servers:`);
    if (works.length)
      lines.push(`  ✅ Works (${works.length}): ${works.map((c) => `${c.name} [${c.transport}]`).join(", ")}`);
    if (needsSecret.length) {
      lines.push(`  🔑 Needs a secret (${needsSecret.length}) — ships but inactive until you set the token in Cloud Code:`);
      for (const c of needsSecret) lines.push(`     • ${c.name}: ${(c.redactedEnv || []).join(", ")}`);
    }
    if (unsupported.length) {
      lines.push(`  🚫 Won't run in the cloud (${unsupported.length}) — dropped:`);
      for (const c of unsupported) lines.push(`     • ${c.name}: ${c.reason || c.transport}`);
    }
  }

  if (g.skipped.length) lines.push(``, `Not present locally (skipped): ${g.skipped.join(", ")}`);
  lines.push(
    ``,
    cli === "codex"
      ? `Note: codex/config.toml shipped verbatim — check it for any inline secrets.`
      : `Run \`/mcp__port-session__sync-config codex\` too if you use Codex in the cloud.`
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === SYNC_TOOL.name) {
    try {
      return await runSync(req.params.arguments);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Sync failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name === PULL_TOOL.name) {
    try {
      return await runPull(req.params.arguments);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Pull failed: ${(err as Error).message}` }] };
    }
  }
  if (req.params.name !== TOOL.name) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    if (!CLOUD_CODE_URL) {
      throw new Error("CLOUD_CODE_URL is not set in the MCP server environment.");
    }
    const args = InputSchema.parse(req.params.arguments ?? {});
    const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();

    // 1. locate the live transcript FIRST — it's the only hard requirement. Its
    //    filename IS the Claude session id we'll resume natively in the cloud.
    const file = await newestTranscript(cwd);
    if (!file) {
      throw new Error(`No Claude Code transcript found for ${cwd}. Run this from inside a Claude Code session.`);
    }
    const claudeSessionId = sessionIdForTranscript(file);
    const transcript = await readFile(file); // raw .jsonl bytes (verbatim → native --resume)

    // 1b. artifact detection. The files this session touched that exist locally
    //     and aren't git-tracked are exactly the deliverables the code bundle
    //     misses. 'n' skips; 'auto'/'y' detect and (below) ship them.
    const artifactMode = args.artifacts ?? "auto";
    const detected =
      artifactMode === "n"
        ? null
        : await detectArtifacts({ cwd, repoDir: cwd, transcript }).catch(() => null);

    // 2. git handoff — best-effort, flexible. The transcript ships regardless;
    //    git just determines whether (and how) the cloud also gets your code:
    //    pushed (writable origin), bundle (read-only origin), selfContained
    //    (no usable remote — bundle --all), or none (empty dir).
    const state = await readState(cwd);
    let bundleBytes: Buffer | null = null;
    const handoff = await prepareGitHandoff(cwd, state, {
      branch: args.branch,
      message: args.commitMessage,
      preferBundle: args.preferBundle,
      writeArtifacts: async ({ bundle }) => { bundleBytes = bundle; },
      writeSelfContained: async (bundle) => { bundleBytes = bundle; },
    });

    // 3. create the cloud session + presigned upload URLs (transcript always;
    //    bundle only when we produced one).
    const res = await fetch(`${CLOUD_CODE_URL}/api/cloud-code/sessions/port`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: handoff.mode === "none" ? undefined : state.remoteRepo,
        cloneUrl: handoff.mode === "none" || handoff.mode === "selfContained"
          ? undefined
          : state.originUrl,
        gitMode: handoff.mode, // pushed | bundle | selfContained | none
        branch: handoff.mode === "none" ? undefined : handoff.branch,
        wantBundleUpload: Boolean(bundleBytes),
        claudeSessionId,
        firstPrompt: args.firstPrompt,
        cli: args.cli || "claude",
        view: args.view || "chat",
        title: args.title,
        // Artifact manifest → the route presigns a PUT per file. rel is the
        // on-the-wire identity (validated server-side against path traversal).
        artifacts: detected
          ? detected.candidates.map((c) => ({ rel: c.rel, bytes: c.bytes }))
          : undefined,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      uploadUrl?: string;
      bundleUploadUrl?: string;
      artifactUploads?: { rel: string; url: string }[];
      error?: string;
      session?: { sessionId?: string };
    };
    if (!res.ok) throw new Error(data.error || `port endpoint returned ${res.status}`);
    if (!data.uploadUrl) throw new Error("port endpoint did not return an upload URL");

    // 4. upload the raw transcript straight to S3 (presigned PUT — no big body
    //    through the app, no DynamoDB size cap).
    const up = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" },
      body: transcript,
    });
    if (!up.ok) throw new Error(`transcript upload failed: ${up.status} ${up.statusText}`);

    // 4b. upload the git bundle if we have one (bundle / selfContained modes).
    if (bundleBytes && data.bundleUploadUrl) {
      const ub = await fetch(data.bundleUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bundleBytes),
      });
      if (!ub.ok) throw new Error(`bundle upload failed: ${ub.status} ${ub.statusText}`);
    }

    // 4c. stream each detected artifact to its presigned PUT. Per-file failure is
    //     NON-fatal — the port already succeeded (code + transcript shipped); we
    //     count + NAME failures so the summary never reads a silent "0/N". Files
    //     also copy into local .cloud-code/artifacts so pull is symmetric.
    const uploadedArtifacts: string[] = [];
    const failedArtifacts: { rel: string; error: string }[] = [];
    if (detected && data.artifactUploads?.length) {
      // Exclude .cloud-code/ locally BEFORE staging so the staged copies can't
      // leave the tree dirty (which would block pull's checkout of cloud code).
      await ensureCloudCodeExcluded(cwd);
      const byRel = new Map(detected.candidates.map((c) => [c.rel, c]));
      await Promise.all(
        data.artifactUploads.map(async (u) => {
          const cand = byRel.get(u.rel);
          if (!cand) return;
          try {
            await uploadArtifact(u.url, cand.abs, cand.bytes);
            uploadedArtifacts.push(u.rel);
            await stageArtifactLocally(cwd, u.rel, cand.abs).catch(() => {});
          } catch (e) {
            failedArtifacts.push({ rel: u.rel, error: (e as Error).message });
          }
        })
      );
    }

    // 6. pre-warm the microVM now (clone + checkout + install transcript) so the
    //    session is hot the instant the user opens the link. Best-effort: we wait
    //    briefly but don't fail the port if warming is slow or errors.
    const sid = data.session?.sessionId;
    let warmed = false;
    if (sid) {
      try {
        const w = await fetch(`${CLOUD_CODE_URL}/api/cloud-code/sessions/${sid}/warm`, {
          method: "POST",
          signal: AbortSignal.timeout(60_000),
        });
        warmed = w.ok && Boolean((await w.json().catch(() => ({}))).warmed);
      } catch {
        /* warming is an optimization; the first turn clones on demand */
      }
    }

    // Deep link — built from CLOUD_CODE_URL (the server's DEPLOYMENT_URL may be unset).
    const viewQ = args.view === "terminal" ? "&view=terminal" : "";
    const link =
      sid ? `${CLOUD_CODE_URL}/cloud-code?session=${sid}${viewQ}` : data.url || "(no url returned)";

    const sizeMb = (transcript.length / 1_048_576).toFixed(1);

    // Mode-aware "what shipped / why / how" so a read-only or no-repo handoff is
    // never silently degraded — the user knows exactly what the cloud has.
    const codeLines: string[] = [];
    if (handoff.mode === "pushed") {
      codeLines.push(
        `Repo: ${state.remoteRepo || state.originUrl}`,
        `Branch: ${handoff.branch}${handoff.committed ? " (in-flight work committed + pushed)" : " (pushed)"}`
      );
    } else if (handoff.mode === "bundle") {
      codeLines.push(
        `Repo: ${state.remoteRepo || state.originUrl} (origin is read-only — no push needed)`,
        `Code: shipped as a git bundle${bundleBytes ? ` (${fmtBytes((bundleBytes as Buffer).length)})` : " (nothing laptop-only — clean clone matches)"}; the cloud clones the upstream and layers your commits on branch \`${handoff.branch}\`.`
      );
    } else if (handoff.mode === "selfContained") {
      codeLines.push(
        `Code: no usable remote — shipped the WHOLE repo as a self-contained bundle${bundleBytes ? ` (${fmtBytes((bundleBytes as Buffer).length)})` : ""}${handoff.initialized ? " (git init'd it for you)" : ""}. The cloud rebuilt it standalone on branch \`${handoff.branch}\`; nothing left your AWS account.`
      );
    } else {
      codeLines.push(`Code: none shipped (${handoff.reason}) — the conversation resumes in a bare workspace.`);
    }
    const artifactLine =
      uploadedArtifacts.length > 0
        ? `Artifacts: ${uploadedArtifacts.length} untracked deliverable(s) shipped → .cloud-code/artifacts/ — ${uploadedArtifacts.slice(0, 8).join(", ")}`
        : "";
    const artifactFailLine =
      failedArtifacts.length > 0
        ? `⚠️ ${failedArtifacts.length} artifact(s) failed to upload: ${failedArtifacts.map((f) => f.rel).join(", ")}`
        : "";

    const summary = [
      `✅ Ported to Cloud Code (native resume).`,
      ``,
      ...codeLines,
      `Transcript: ${sizeMb} MB uploaded — the cloud agent resumes this exact session (claude --resume).`,
      artifactLine,
      artifactFailLine,
      warmed
        ? `Workspace: pre-warmed — open and it's instant.`
        : `Workspace: warms on first open (clone happens then).`,
      ``,
      `Open on any device:`,
      link,
      ``,
      `When you're back at this machine, pull the cloud's work home:`,
      `  /mcp__port-session__pull ${sid}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Port failed: ${(err as Error).message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("port-session-mcp ready (stdio)");
