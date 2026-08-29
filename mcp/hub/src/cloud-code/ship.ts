/**
 * ship_session_to_workflow — hand an in-flight laptop coding session to the
 * AGENT PIPELINE (not an interactive Cloud Code tab).
 *
 * Same packaging as port_session_to_cloud (commit + push branch, raw transcript
 * to S3, untracked artifacts shipped), but the destination is workflow intake:
 * the requirements analyst RESUMES this exact session to derive the plan, dev
 * agents resume it to inherit the full context and build on the ported branch,
 * review/QA verify independently, and the run ends in a PR. Fire and forget —
 * the next thing the requester looks at is the pull request.
 *
 * Flow:
 *   1. locate the live Claude transcript (its filename = the conversation id)
 *   2. commit + push the in-flight work to a branch (pipeline devs need a
 *      clonable branch on origin — bundle/selfContained handoffs are rejected)
 *   3. POST /api/cloud-code/sessions/port → cloud session + presigned uploads
 *   4. upload transcript (+ session-touched untracked artifacts), pre-warm
 *   5. POST /api/workflow/start with portedSession → the run's shared
 *      integration branch IS the ported branch; agents resume the session
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config } from "../config.js";
import { hubFetch } from "../auth.js";
import { readState, prepareGitHandoff } from "./git.js";
import { newestTranscript, sessionIdForTranscript } from "./transcript.js";
import { detectArtifacts, uploadArtifact, stageArtifactLocally, ensureCloudCodeExcluded } from "./artifacts.js";

const ShipSchema = z.object({
  title: z.string().min(1),
  // Imperative directive for the intake agent. `description` kept as a
  // back-compat alias for older callers; instructions wins when both are set.
  instructions: z.string().optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  commitMessage: z.string().optional(),
  workflowDefId: z.string().optional(),
  platform: z.enum(["ios", "backend", "android", "shared"]).optional(),
  cli: z.enum(["claude", "codex"]).optional(),
  cwd: z.string().optional(),
  artifacts: z.enum(["y", "n", "auto"]).optional(),
});

export const SHIP_TOOL = {
  name: "ship_session_to_workflow",
  description:
    "Hand the current in-flight coding session to the agent workflow pipeline " +
    "for autonomous execution — the 'I planned it locally, now build it without " +
    "me' move. Packages everything exactly like port_session_to_cloud (commits + " +
    "pushes your branch, ships this conversation's transcript and untracked " +
    "artifacts), then starts a workflow whose agents RESUME this session: the " +
    "requirements analyst derives the plan from it, devs continue it on your " +
    "branch, QA verifies independently, and the run produces a pull request. " +
    "Use when the research/planning is done and you don't want to babysit the " +
    "build. Requires a pushable origin (the pipeline clones your branch).",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", description: "Workflow title — one line describing what to build." },
      instructions: {
        type: "string",
        description:
          "Imperative directive to the intake agent — tell it what to do, not just what happened: " +
          "goal, decisions already locked, hard constraints, done-when, and whether to deploy or stop at a PR. " +
          "The full context travels in the session transcript; this is the marching order on top of it.",
      },
      branch: { type: "string", description: "Branch to push the in-flight work to. Defaults to the current branch (or feat/ship-<id> when on the default branch)." },
      commitMessage: { type: "string", description: "Commit message for the in-flight snapshot." },
      workflowDefId: { type: "string", description: "Workflow definition to run. Default software-delivery." },
      platform: { type: "string", enum: ["ios", "backend", "android", "shared"], description: "Repo platform for the pipeline (drives iOS gateway wiring). Default backend." },
      cli: { type: "string", enum: ["claude", "codex"], description: "Cloud CLI the agents resume with. Default claude." },
      cwd: { type: "string", description: "Project directory. Defaults to the server cwd." },
      artifacts: { type: "string", enum: ["y", "n", "auto"], description: "Ship session-touched untracked files. Default auto." },
    },
  },
};

async function gitDefaultBranch(cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return "main";
}

export async function runShip(rawArgs: unknown) {
  const args = ShipSchema.parse(rawArgs ?? {});
  const cwd = args.cwd || process.env.PROJECT_CWD || process.cwd();
  const cli = args.cli || "claude";

  // 1. the live transcript is the whole point — hard requirement.
  const file = await newestTranscript(cwd);
  if (!file) {
    throw new Error(`No Claude Code transcript found for ${cwd}. Run this from inside a Claude Code session.`);
  }
  const claudeSessionId = sessionIdForTranscript(file);
  const transcript = await readFile(file);

  const artifactMode = args.artifacts ?? "auto";
  const detected =
    artifactMode === "n"
      ? null
      : await detectArtifacts({ cwd, repoDir: cwd, transcript }).catch(() => null);

  // 2. git handoff — the pipeline is stricter than Cloud Code: dev agents clone
  //    the repo from origin and open PRs, so only a PUSHED branch works. Never
  //    ship the work on the default branch — the run's final PR targets it.
  const state = await readState(cwd);
  if (!state.isRepo) {
    throw new Error("Not a git repository — the workflow pipeline needs a repo with a pushable origin.");
  }
  const defaultBranch = await gitDefaultBranch(cwd);
  let targetBranch = args.branch || state.branch;
  if (!args.branch && (targetBranch === defaultBranch || targetBranch === "HEAD")) {
    targetBranch = `feat/ship-${claudeSessionId.slice(0, 8)}`;
  }
  const handoff = await prepareGitHandoff(cwd, state, {
    branch: targetBranch,
    message: args.commitMessage,
  });
  if (handoff.mode !== "pushed") {
    const why = handoff.mode === "none" ? handoff.reason : `origin is not pushable (handoff mode: ${handoff.mode})`;
    throw new Error(
      `The workflow pipeline needs your branch pushed to origin — ${why}. ` +
      `Fix the remote/auth and retry, or use port_session_to_cloud for an interactive session instead.`
    );
  }

  // 3. create the cloud session (same endpoint as port — this is what the
  //    pipeline personas resume) + presigned uploads.
  const portRes = await hubFetch(`/api/cloud-code/sessions/port`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: state.remoteRepo,
      cloneUrl: state.originUrl,
      gitMode: "pushed",
      branch: handoff.branch,
      claudeSessionId,
      cli,
      view: "chat",
      title: `[shipped→workflow] ${args.title}`.slice(0, 120),
      firstPrompt:
        "This session was shipped to the agent workflow pipeline — its agents are resuming it. " +
        "If a human opened this, summarize where things stand; do not start new work here.",
      artifacts: detected ? detected.candidates.map((c) => ({ rel: c.rel, bytes: c.bytes })) : undefined,
    }),
  });
  const port = (await portRes.json().catch(() => ({}))) as {
    uploadUrl?: string;
    artifactUploads?: { rel: string; url: string }[];
    session?: { sessionId?: string };
    error?: string;
  };
  if (!portRes.ok) throw new Error(port.error || `port endpoint returned ${portRes.status}`);
  const ccSessionId = port.session?.sessionId;
  if (!port.uploadUrl || !ccSessionId) throw new Error("port endpoint did not return an upload URL / session id");

  // 4. transcript straight to S3.
  const up = await fetch(port.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/x-ndjson" },
    body: transcript,
  });
  if (!up.ok) throw new Error(`transcript upload failed: ${up.status} ${up.statusText}`);

  // 4b. artifacts — per-file failures are non-fatal, but named.
  const uploadedArtifacts: string[] = [];
  const failedArtifacts: string[] = [];
  if (detected && port.artifactUploads?.length) {
    await ensureCloudCodeExcluded(cwd);
    const byRel = new Map(detected.candidates.map((c) => [c.rel, c]));
    await Promise.all(
      port.artifactUploads.map(async (u) => {
        const cand = byRel.get(u.rel);
        if (!cand) return;
        try {
          await uploadArtifact(u.url, cand.abs, cand.bytes);
          uploadedArtifacts.push(u.rel);
          await stageArtifactLocally(cwd, u.rel, cand.abs).catch(() => {});
        } catch {
          failedArtifacts.push(u.rel);
        }
      })
    );
  }

  // 4c. pre-warm so the transcript is installed on the coding runtime's EFS
  //     before the first persona resumes. Best-effort — the runtime-agent also
  //     forwards the resume fields on every turn.
  try {
    await hubFetch(`/api/cloud-code/sessions/${ccSessionId}/warm`, { method: "POST" }, 60_000);
  } catch { /* first resumed turn installs on demand */ }

  // 5. start the workflow. portedSession makes the ported branch the run's
  //    shared integration branch and tells every persona how to resume.
  const wfRes = await hubFetch(`/api/workflow/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: args.title,
      description:
        (args.instructions ?? args.description ?? "").trim() ||
        `Pre-planned in a live coding session (resume it for the full context). Continue the work on branch ${handoff.branch}.`,
      repoConfig: {
        layout: "monorepo",
        repos: [
          {
            url: state.originUrl,
            defaultBranch,
            platform: args.platform || "backend",
          },
        ],
      },
      sources: [],
      ...(args.workflowDefId ? { workflowDefId: args.workflowDefId } : {}),
      portedSession: {
        sessionId: ccSessionId,
        claudeSessionId,
        cli,
        repo: state.remoteRepo,
        branch: handoff.branch,
      },
    }),
  }, 120_000);
  const wf = (await wfRes.json().catch(() => ({}))) as { workflowId?: string; epicId?: string; error?: string };
  if (!wfRes.ok) {
    throw new Error(
      `${wf.error || `workflow start returned ${wfRes.status}`} ` +
      `(the session itself ported fine — resume it interactively at ${config.hubUrl}/cloud-code?session=${ccSessionId})`
    );
  }

  const sizeMb = (transcript.length / 1_048_576).toFixed(1);
  const summary = [
    `✅ Shipped to the workflow pipeline — you can walk away.`,
    ``,
    `Workflow: ${wf.workflowId}${wf.epicId ? ` (epic ${wf.epicId})` : ""}`,
    `Track it: ${config.hubUrl}/workflow?id=${wf.workflowId}`,
    ``,
    `Repo: ${state.remoteRepo || state.originUrl}`,
    `Branch: ${handoff.branch}${handoff.committed ? " (in-flight work committed + pushed)" : " (pushed)"} — the run builds on it; the final PR targets ${defaultBranch}.`,
    `Session: ${ccSessionId} — transcript ${sizeMb} MB uploaded; the intake + dev agents resume this exact conversation.`,
    uploadedArtifacts.length ? `Artifacts: ${uploadedArtifacts.length} untracked deliverable(s) shipped — ${uploadedArtifacts.slice(0, 8).join(", ")}` : "",
    failedArtifacts.length ? `⚠️ ${failedArtifacts.length} artifact(s) failed to upload: ${failedArtifacts.join(", ")}` : "",
    ``,
    `Next human touchpoint: the pull request (review/QA run without you).`,
  ]
    .filter(Boolean)
    .join("\n");

  return { content: [{ type: "text" as const, text: summary }] };
}
