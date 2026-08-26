/**
 * Git helpers for the port handoff.
 *
 * The cloud needs the repo state, but it can reach it three different ways
 * depending on what the laptop can do — so port is FLEXIBLE about git instead of
 * demanding a writable origin:
 *
 *   pushed         — origin is writable: commit + push a branch, cloud clones it.
 *   bundle         — repo exists but origin is read-only (e.g. an aws-samples
 *                    clone you don't own): ship a `git bundle` of your in-flight
 *                    commits; the cloud clones the PUBLIC origin and applies the
 *                    bundle on top. No push rights needed.
 *   selfContained  — NO usable remote (no origin, unreachable, or not even a git
 *                    repo yet): we `git init` if needed, commit everything, and
 *                    ship a `git bundle --all` (whole history + all branches). The
 *                    cloud reconstructs a standalone repo from the bundle in its
 *                    own EFS workspace — nothing leaves your AWS account, no
 *                    GitHub, no push rights. This is the "I'm in a hurry and never
 *                    set up a remote" path: it just works; wire a real remote later.
 *   none           — nothing to ship as code (truly empty dir): transcript only.
 *
 * The transcript always ships regardless of git mode — it's just a file.
 * All commands run in the user's project cwd.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** git that returns {ok, stdout} instead of throwing — for probes. */
async function gitTry(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args) };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

export interface GitState {
  isRepo: boolean;
  branch: string;
  remoteRepo?: string; // owner/name parsed from origin
  originUrl?: string; // full origin URL (https/ssh) for the cloud to clone
  dirty: boolean;
}

/** Parse owner/name from a github remote URL (https or ssh). */
export function parseRepo(remoteUrl: string): string | undefined {
  const m = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : undefined;
}

/**
 * Produce a clone URL the CLOUD can use. The runtime only configures HTTPS PAT
 * rewriting, so an `git@host:org/repo.git` SSH origin would fail there — convert
 * it to `https://host/org/repo.git`. Also strip any embedded userinfo
 * (`https://user:token@host/...`) so we never persist/return a credential.
 * Returns undefined if there's nothing usable.
 */
export function normalizeCloneUrl(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined;
  const url = remoteUrl.trim();
  // scp-like SSH: git@host:org/repo(.git)
  const ssh = url.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
  // ssh:// or https:// — drop userinfo (anything before @ in the authority).
  const m = url.match(/^(https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) {
    // An ssh:// URL's port (e.g. :22) is the SSH port — meaningless over HTTPS,
    // so drop it. Keep an explicit port on an https:// origin.
    const host = m[1] === "ssh" ? m[2].replace(/:\d+$/, "") : m[2];
    return `https://${host}/${m[3]}.git`;
  }
  // Unknown shape (e.g. a local path) — return as-is, no credential to strip.
  return url;
}

export async function readState(cwd: string): Promise<GitState> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let remoteRepo: string | undefined;
  let originUrl: string | undefined;
  try {
    const raw = await git(cwd, ["remote", "get-url", "origin"]);
    remoteRepo = parseRepo(raw);
    // Normalize for the cloud: SSH→HTTPS, strip embedded credentials. Push still
    // uses the local `origin` remote (this URL is only what the cloud clones).
    originUrl = normalizeCloneUrl(raw);
  } catch {
    /* no origin */
  }
  const status = await git(cwd, ["status", "--porcelain"]);
  return { isRepo: true, branch, remoteRepo, originUrl, dirty: status.length > 0 };
}

/** Can we push to origin? Probe with a dry-run push (no refs written). */
export async function canPushToOrigin(cwd: string): Promise<boolean> {
  // `--dry-run` performs auth + ref negotiation but writes nothing. A read-only
  // remote (no write grant) fails here; a writable one succeeds.
  const r = await gitTry(cwd, ["push", "--dry-run", "origin", "HEAD"]);
  return r.ok;
}

export type GitHandoff =
  | { mode: "pushed"; branch: string; committed: boolean; cloneUrl?: string }
  | { mode: "bundle"; branch: string; committed: boolean; cloneUrl?: string; baseRef: string }
  | { mode: "selfContained"; branch: string; committed: boolean; initialized: boolean }
  | { mode: "none"; reason: string };

/** Does the dir contain anything worth shipping (ignoring .git)? */
async function dirHasFiles(cwd: string): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(cwd);
    return entries.some((e) => e !== ".git");
  } catch {
    return false;
  }
}

/**
 * Self-contained handoff: bundle the WHOLE repo (--all: every branch + tag + the
 * current HEAD) into one file the cloud reconstructs standalone — no origin, no
 * push. `git init`s + commits first if the dir isn't a repo yet. Returns the
 * handoff descriptor, invoking writeAll with the bundle bytes for the caller to
 * upload. Returns null only if there's genuinely nothing to ship (empty dir).
 */
type SelfContained = Extract<GitHandoff, { mode: "selfContained" }>;

async function prepareSelfContained(
  cwd: string,
  state: GitState,
  opts: {
    branch?: string;
    message?: string;
    writeAll?: (bundle: Buffer) => Promise<void>;
  }
): Promise<SelfContained | null> {
  let initialized = false;
  let committed = false;

  if (!state.isRepo) {
    if (!(await dirHasFiles(cwd))) return null; // nothing to ship
    await git(cwd, ["init"]);
    // A repo with no commits can't be bundled; ensure an identity for the commit.
    await ensureCommitIdentity(cwd);
    initialized = true;
  }

  const startBranch = state.isRepo ? state.branch : await currentBranch(cwd);
  const target = opts.branch || startBranch || "main";
  if (target && target !== startBranch) {
    await git(cwd, ["checkout", "-B", target]);
  }

  // Commit everything so the bundle is a complete snapshot. On a fresh init this
  // is the first commit; on an existing repo it captures in-flight work.
  const dirty = (await git(cwd, ["status", "--porcelain"])).length > 0;
  const hasCommit = (await gitTry(cwd, ["rev-parse", "HEAD"])).ok;
  if (dirty || !hasCommit) {
    await git(cwd, ["add", "-A"]);
    const msg = opts.message || `wip: port session to cloud (${new Date().toISOString()})`;
    // --allow-empty so a repo with only ignored/empty content still gets a HEAD
    // to bundle, rather than failing the whole port.
    await git(cwd, ["commit", "--no-verify", "--allow-empty", "-m", msg]);
    committed = true;
  }

  if (opts.writeAll) {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const tmp = await mkdtemp(pathMod.join(os.tmpdir(), "cc-bundle-"));
    const bundlePath = pathMod.join(tmp, "all.bundle");
    try {
      // --all = every ref; add HEAD so a detached/odd state is still captured.
      await git(cwd, ["bundle", "create", bundlePath, "--all", "HEAD"]);
      await opts.writeAll(await readFile(bundlePath));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  return { mode: "selfContained", branch: target, committed, initialized };
}

async function currentBranch(cwd: string): Promise<string> {
  const r = await gitTry(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out : "main";
}

/** Ensure user.name/email exist for the commit (fresh `git init` may lack them).
 *  Probed independently: a machine with a global user.name but no user.email
 *  would otherwise skip both and the snapshot commit dies with "Author identity
 *  unknown". */
async function ensureCommitIdentity(cwd: string): Promise<void> {
  const name = await gitTry(cwd, ["config", "user.name"]);
  if (!name.ok || !name.out) {
    await git(cwd, ["config", "user.name", "Cloud Code Port"]);
  }
  const email = await gitTry(cwd, ["config", "user.email"]);
  if (!email.ok || !email.out) {
    await git(cwd, ["config", "user.email", "cloud-code@localhost"]);
  }
}

/**
 * Prepare the repo for handoff, choosing the best available mode.
 *
 * @param writeBundle  called with the bundle bytes when mode==="bundle" (the
 *                     caller uploads them); receives {bundle, patch} buffers.
 */
export async function prepareGitHandoff(
  cwd: string,
  state: GitState,
  opts: {
    branch?: string;
    message?: string;
    preferBundle?: boolean; // force bundle even if origin is writable
    writeArtifacts?: (a: { bundle: Buffer; patch: Buffer; baseRef: string }) => Promise<void>;
    // Self-contained bundle (--all) bytes for the no-remote / not-a-repo path.
    writeSelfContained?: (bundle: Buffer) => Promise<void>;
  }
): Promise<GitHandoff> {
  // Not a git repo yet → self-contained: git init + commit + bundle --all (or
  // 'none' if the dir is genuinely empty). Removes the "I never set up a repo"
  // blocker — the cloud gets a real standalone repo from a bundle in your S3.
  if (!state.isRepo) {
    const sc = await prepareSelfContained(cwd, state, {
      branch: opts.branch,
      message: opts.message,
      writeAll: opts.writeSelfContained,
    });
    return sc ?? { mode: "none", reason: "empty workspace (no files to ship)" };
  }

  const target = opts.branch || state.branch;
  let committed = false;

  // Snapshot in-flight work onto the target branch so HEAD captures everything.
  if (opts.branch && opts.branch !== state.branch) {
    await git(cwd, ["checkout", "-B", opts.branch]);
  }
  if (state.dirty) {
    await git(cwd, ["add", "-A"]);
    const msg = opts.message || `wip: port session to cloud (${new Date().toISOString()})`;
    await git(cwd, ["commit", "--no-verify", "-m", msg]);
    committed = true;
  }

  // Mode selection keys off originUrl (what the cloud actually clones), not the
  // parsed github owner/name — a non-github or SSH origin is still clonable.
  // pushed if we can push and aren't forced to bundle; else bundle if the origin
  // is READABLE (the cloud must clone it before layering the bundle); else
  // self-contained (unreachable/laptop-local origins can't seed a cloud clone).
  const writable = !opts.preferBundle && state.originUrl
    ? await canPushToOrigin(cwd)
    : false;

  if (writable) {
    await git(cwd, ["push", "--no-verify", "-u", "origin", target]);
    return { mode: "pushed", branch: target, committed, cloneUrl: state.originUrl };
  }

  // Bundle mode needs an origin the cloud can CLONE (the public upstream) AND a
  // base commit present there, so the bundle only carries OUR commits on top.
  // A configured-but-unreachable origin (laptop-local path, dead host, revoked
  // read access) fails the reachability probe → fall through to self-contained,
  // otherwise the cloud's mandatory upstream clone fails and the user's code
  // never arrives (runtime falls back to a bare workspace). Same for unrelated
  // histories: a base..HEAD bundle without a shared root can't verify against
  // the upstream clone, so ship the whole repo instead.
  const originReadable = state.originUrl
    ? (await gitTry(cwd, ["ls-remote", "--heads", "origin"])).ok
    : false;
  let baseRef = "";
  if (state.originUrl && originReadable) {
    for (const cand of [
      "origin/HEAD",
      `origin/${target}`,
      "@{upstream}",
    ]) {
      const r = await gitTry(cwd, ["merge-base", "HEAD", cand]);
      if (r.ok && r.out) { baseRef = r.out; break; }
    }
  }
  if (state.originUrl && originReadable && baseRef) {

    if (opts.writeArtifacts) {
      // git bundle of base..HEAD (our commits), plus a patch of anything still
      // uncommitted (should be empty after the commit above, but cheap insurance).
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const os = await import("node:os");
      const pathMod = await import("node:path");
      const tmp = await mkdtemp(pathMod.join(os.tmpdir(), "cc-bundle-"));
      const bundlePath = pathMod.join(tmp, "work.bundle");
      try {
        // Are there any commits in base..HEAD? An empty range means HEAD is
        // already on origin (nothing laptop-only to ship) — `git bundle` refuses
        // an empty bundle, so skip the artifact: the cloud's clean clone already
        // has this state. We still report bundle mode (origin is read-only) but
        // with no bundle to apply.
        const ahead = baseRef
          ? (await gitTry(cwd, ["rev-list", "--count", `${baseRef}..HEAD`])).out.trim()
          : "1";
        if (ahead && ahead !== "0") {
          const range = baseRef ? `${baseRef}..HEAD` : "HEAD";
          await git(cwd, ["bundle", "create", bundlePath, range, "HEAD"]);
          const bundle = await readFile(bundlePath);
          const patch = Buffer.from(await git(cwd, ["diff", "HEAD"]), "utf8"); // usually empty
          await opts.writeArtifacts({ bundle, patch, baseRef });
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    return { mode: "bundle", branch: target, committed, cloneUrl: state.originUrl, baseRef };
  }

  // Repo with NO usable origin (none configured, or unreachable) → self-contained:
  // bundle --all to S3, cloud rebuilds standalone. The in-flight commit above
  // already happened, so prepareSelfContained just bundles + reports.
  const sc = await prepareSelfContained(cwd, state, {
    branch: opts.branch,
    message: opts.message,
    writeAll: opts.writeSelfContained,
  });
  if (sc) return { ...sc, committed: committed || sc.committed };
  return { mode: "none", reason: state.originUrl ? "origin not reachable" : "no origin remote" };
}

/**
 * Pull the cloud's commits from a RETURN BUNDLE (bundle/selfContained sessions —
 * no writable origin to fetch from). Fetches the bundle's refs and fast-forwards
 * the named branch, with the same dirty/diverged safety as pullBranch.
 */
export async function pullFromBundle(cwd: string, bundleBytes: Buffer, branch: string): Promise<string> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const tmp = await mkdtemp(pathMod.join(os.tmpdir(), "cc-return-"));
  const bundlePath = pathMod.join(tmp, "return.bundle");
  try {
    await writeFile(bundlePath, bundleBytes);
    const verify = await gitTry(cwd, ["bundle", "verify", bundlePath]);
    if (!verify.ok) return `return bundle failed verification; cloud commits not applied.`;
    const fetch_ = await gitTry(cwd, ["fetch", bundlePath, `+refs/heads/*:refs/remotes/cc-cloud/*`, "HEAD"]);
    if (!fetch_.ok) return `return bundle fetch failed; cloud commits not applied.`;
    const status = await git(cwd, ["status", "--porcelain"]);
    if (status.length > 0) {
      return `local tree is dirty; cloud commits fetched to cc-cloud/* but NOT checked out. Stash/commit, then \`git checkout -B ${branch} cc-cloud/${branch}\`.`;
    }
    const co = await gitTry(cwd, ["checkout", "-B", branch, `cc-cloud/${branch}`]);
    if (!co.ok) {
      const co2 = await gitTry(cwd, ["checkout", "-B", branch, "FETCH_HEAD"]);
      if (!co2.ok) return `cloud commits fetched to cc-cloud/*, but checkout failed; run \`git checkout -B ${branch} FETCH_HEAD\`.`;
    }
    return `pulled the cloud's commits from its return bundle onto \`${branch}\`.`;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
