/**
 * Git helpers for the port handoff. Cloud Code can only see what's on the
 * remote, so before porting we must commit + push the in-flight work to a
 * branch. All commands run in the user's project cwd.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface GitState {
  isRepo: boolean;
  branch: string;
  remoteRepo?: string; // owner/name parsed from origin
  dirty: boolean;
}

/** Parse owner/name from a github remote URL (https or ssh). */
export function parseRepo(remoteUrl: string): string | undefined {
  const m = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : undefined;
}

export async function readState(cwd: string): Promise<GitState> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let remoteRepo: string | undefined;
  try {
    remoteRepo = parseRepo(await git(cwd, ["remote", "get-url", "origin"]));
  } catch {
    /* no origin */
  }
  const status = await git(cwd, ["status", "--porcelain"]);
  return { isRepo: true, branch, remoteRepo, dirty: status.length > 0 };
}

/**
 * Ensure the in-flight work is on a pushed branch.
 * - If clean and already on a non-default branch with an upstream, just push.
 * - If dirty, commit everything to `branch` (creating it if needed), then push.
 * Returns the branch name that now holds the work on the remote.
 */
export async function commitAndPush(
  cwd: string,
  opts: { branch?: string; message?: string; dirty: boolean; currentBranch: string }
): Promise<{ branch: string; pushed: boolean; committed: boolean }> {
  let committed = false;
  const target = opts.branch || opts.currentBranch;

  if (opts.branch && opts.branch !== opts.currentBranch) {
    await git(cwd, ["checkout", "-B", opts.branch]);
  }

  if (opts.dirty) {
    await git(cwd, ["add", "-A"]);
    const msg = opts.message || `wip: port session to cloud (${new Date().toISOString()})`;
    // --no-verify: skip local hooks; this is a snapshot for handoff, not a reviewed commit.
    await git(cwd, ["commit", "--no-verify", "-m", msg]);
    committed = true;
  }

  await git(cwd, ["push", "--no-verify", "-u", "origin", target]);
  return { branch: target, pushed: true, committed };
}

/**
 * Pull the cloud's work home: fetch + check out the branch, fast-forward to the
 * cloud's commits. Best-effort and non-destructive — if the local tree is dirty
 * or diverged we report it rather than clobber. Returns a status note.
 */
export async function pullBranch(cwd: string, branch: string): Promise<string> {
  const status = await git(cwd, ["status", "--porcelain"]);
  await git(cwd, ["fetch", "origin", branch]);
  if (status.length > 0) {
    // Don't risk local uncommitted work — just fetch and tell the user.
    return `local tree is dirty; fetched origin/${branch} but did NOT check out. Stash/commit, then \`git checkout ${branch} && git pull\`.`;
  }
  await git(cwd, ["checkout", branch]);
  try {
    await git(cwd, ["merge", "--ff-only", `origin/${branch}`]);
    return `pulled origin/${branch} (fast-forward).`;
  } catch {
    return `on ${branch}, but it diverged from origin/${branch}; resolve manually (\`git pull\`).`;
  }
}
