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
import { readState, commitAndPush } from "./git.js";
import { newestTranscript, sessionIdForTranscript } from "./transcript.js";

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
  commitMessage: z.string().optional().describe("Commit message for the in-flight snapshot."),
  cwd: z.string().optional().describe("Project directory. Defaults to the server's cwd."),
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
      cli: { type: "string", enum: ["claude", "codex"], description: "Cloud CLI to resume with. Default claude." },
      commitMessage: { type: "string", description: "Commit message for the in-flight snapshot." },
      cwd: { type: "string", description: "Project directory. Defaults to the server cwd." },
    },
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

// Slash-command surface: a `port` prompt shows up as
// /mcp__port-session__port. Selecting it tells Claude to call the tool now.
const PORT_PROMPT = {
  name: "port",
  description: "Port this coding session to Cloud Code (commit + push, then resume in the cloud).",
  // One free-text arg so spaces don't split across placeholders. Comma-separated:
  //   title, first prompt (optional), new branch (optional)
  arguments: [
    {
      name: "title, first prompt, new branch",
      description: "Comma-separated, all optional — e.g. \"fix scroll, start on the terminal bug, wip/train\"",
      required: false,
    },
  ],
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [PORT_PROMPT] }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, string>;
  // The single arg's name is a human label; read it positionally regardless.
  const raw = Object.values(a)[0] || "";
  const [title, firstPrompt, branch] = raw.split(",").map((s) => s.trim());
  const extras: string[] = [];
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL.name) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    if (!CLOUD_CODE_URL) {
      throw new Error("CLOUD_CODE_URL is not set in the MCP server environment.");
    }
    const args = InputSchema.parse(req.params.arguments ?? {});
    const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();

    // 1. git state
    const state = await readState(cwd);
    if (!state.isRepo) throw new Error(`${cwd} is not a git repository.`);
    if (!state.remoteRepo) {
      throw new Error("No GitHub 'origin' remote — Cloud Code can only resume from a pushed repo.");
    }

    // 2. commit + push the in-flight work
    const push = await commitAndPush(cwd, {
      branch: args.branch,
      message: args.commitMessage,
      dirty: state.dirty,
      currentBranch: state.branch,
    });

    // 3. locate the live transcript — its filename IS the Claude session id we'll
    //    resume natively in the cloud.
    const file = await newestTranscript(cwd);
    if (!file) {
      throw new Error(`No Claude Code transcript found for ${cwd}. Run this from inside a Claude Code session.`);
    }
    const claudeSessionId = sessionIdForTranscript(file);
    const transcript = await readFile(file); // raw .jsonl bytes (verbatim → native --resume)

    // 4. create the cloud session + get a presigned URL to upload the transcript.
    const res = await fetch(`${CLOUD_CODE_URL}/api/cloud-code/sessions/port`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: state.remoteRepo,
        branch: push.branch,
        claudeSessionId,
        firstPrompt: args.firstPrompt,
        cli: args.cli || "claude",
        title: args.title,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      uploadUrl?: string;
      error?: string;
      session?: { sessionId?: string };
    };
    if (!res.ok) throw new Error(data.error || `port endpoint returned ${res.status}`);
    if (!data.uploadUrl) throw new Error("port endpoint did not return an upload URL");

    // 5. upload the raw transcript straight to S3 (presigned PUT — no big body
    //    through the app, no DynamoDB size cap).
    const up = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" },
      body: transcript,
    });
    if (!up.ok) throw new Error(`transcript upload failed: ${up.status} ${up.statusText}`);

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
    const link =
      sid ? `${CLOUD_CODE_URL}/cloud-code?session=${sid}` : data.url || "(no url returned)";

    const sizeMb = (transcript.length / 1_048_576).toFixed(1);
    const summary = [
      `✅ Ported to Cloud Code (native resume).`,
      ``,
      `Repo: ${state.remoteRepo}`,
      `Branch: ${push.branch}${push.committed ? " (in-flight work committed + pushed)" : " (pushed)"}`,
      `Transcript: ${sizeMb} MB uploaded — the cloud agent resumes this exact session (claude --resume).`,
      warmed
        ? `Workspace: pre-warmed (repo cloned + branch checked out) — open and it's instant.`
        : `Workspace: warms on first open (clone happens then).`,
      ``,
      `Open on any device:`,
      link,
      ``,
      `It will continue from where you left off — no context lost.`,
    ].join("\n");

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Port failed: ${(err as Error).message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("port-session-mcp ready (stdio)");
