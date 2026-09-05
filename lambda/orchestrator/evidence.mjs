/**
 * TEAM-3991 D1.2 — synthesized completion evidence.
 *
 * An agent that pushed a branch and opened a PR but died before calling
 * `report_completion` leaves no `completions/<ticketId>.json` and no
 * `agentTasks[tid].output` — the evidence gate then strands the run even though
 * the work is provably on GitHub (first observed: TEAM-3790, branch 3 commits
 * ahead with an open PR).
 *
 * This module harvests that proof from GitHub instead of asking the dead agent.
 * It is PURE: no AWS SDK clients, no DynamoDB commands (R2 — writes go through
 * the injected `store`), no fetch of its own (`deps.githubFetch` is index.mjs's
 * `githubApi`).
 *
 * NEVER FABRICATE: no branch and no PR ⇒ `{ synthesized: false }` and ZERO
 * writes. A synthesized record is always stamped `source: "synthesized"` /
 * `evidenceSource: "synthesized"` so no reader mistakes it for an agent report.
 */

function ticketIdOf(ticket) {
  return ticket?.id || ticket?.ticketId || ticket?.key || "";
}

function parseRepo(repoConfig) {
  const url = repoConfig?.repos?.[0]?.url || "";
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
}

// Every probe call is best-effort: a 404 (branch/compare absent) and a transient
// are both "no evidence from this call", never a throw out of the module.
async function attempt(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Reduce one branch probe to an evidence verdict. Evidence = the branch is at
 * least one commit ahead of the base, or a PR exists for it. A merged PR is the
 * strongest proof, then an open one, then whatever is there.
 */
export function evidenceFromBranchProbe({ branch = "", branchHead = null, compare = null, prs = [] } = {}) {
  const list = Array.isArray(prs) ? prs : [];
  const aheadBy = Number.isFinite(compare?.ahead_by) ? compare.ahead_by : 0;
  const pick = list.find((p) => p?.merged_at) || list.find((p) => p?.state === "open") || list[0] || null;
  return {
    hasEvidence: aheadBy >= 1 || list.length > 0,
    branch: branch || branchHead?.name || pick?.head?.ref || "",
    commitSha: branchHead?.commit?.sha || list[0]?.head?.sha || "",
    prUrl: pick?.html_url || "",
    prNumber: pick?.number ?? null,
    prState: pick ? (pick.merged_at ? "merged" : pick.state || "") : "",
    aheadBy,
  };
}

/**
 * TEAM-3991 D1.3/D1.4 — the PURE half of `featureBranchMergeProbe`, shared with
 * the console twin (src/lib/workflow/merge-probe.ts) and pinned by
 * src/lib/workflow/completion-evidence-parity.test.ts.
 *
 * `merged_at` is the ONLY authoritative merge signal on a pull request: `state`
 * goes to "closed" for an abandoned PR too, and `merge_commit_sha` is populated on
 * PRs that were never merged (GitHub keeps a test-merge sha there). Reading either
 * of those as proof is how an unshipped run gets a green close, so this reduces the
 * list on `merged_at` alone.
 *
 * Returns the proof, or null when NO pull request in the list has merged (the
 * caller then asks `compare` — a squash/rebase merge can leave the branch behind
 * the base with no merged PR attached to that head).
 */
export function mergeProbeFromPulls(prs) {
  const list = Array.isArray(prs) ? prs : [];
  const mergedPr = list.find((p) => p?.merged_at);
  if (!mergedPr) return null;
  return {
    merged: true,
    mergeCommit: mergedPr.merge_commit_sha || "",
    prUrl: mergedPr.html_url || "",
  };
}

/**
 * The compare half: identical/behind ⇒ the branch's commits are already in the
 * base (merged, however it landed); ahead/diverged ⇒ PROVABLY unmerged; anything
 * else (unknown status, no response) ⇒ `{ merged: null }` — unknown, fail OPEN
 * for the unmerged gate and NO proof for the shipped verdict.
 */
export function mergeProbeFromCompare(cmp, base = "main") {
  if (cmp?.status === "identical" || cmp?.status === "behind") {
    return { merged: true, mergeCommit: cmp?.base_commit?.sha || "", prUrl: "" };
  }
  if (cmp?.status === "ahead" || cmp?.status === "diverged") {
    return { merged: false, reason: `branch ${cmp.ahead_by} commit(s) ahead of ${base} (status=${cmp.status})` };
  }
  return { merged: null };
}

/** First candidate branch with evidence, else `{ hasEvidence: false }`. */
export async function probeTicketBranches(githubFetch, { owner, repo, base = "main", branches = [] } = {}) {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const tried = new Set();
  for (const branch of Array.isArray(branches) ? branches : []) {
    if (!branch || tried.has(branch)) continue;
    tried.add(branch);
    const b = encodeURIComponent(branch);

    const branchHead = await attempt(() => githubFetch(`/repos/${o}/${r}/branches/${b}`));
    if (!branchHead) continue; // 404 — the agent never pushed this one
    const compare = await attempt(() => githubFetch(`/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${b}`));
    const prs = await attempt(() =>
      githubFetch(`/repos/${o}/${r}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=20`)
    );

    const ev = evidenceFromBranchProbe({ branch, branchHead, compare, prs: Array.isArray(prs) ? prs : [] });
    if (ev.hasEvidence) return ev;
  }
  return { hasEvidence: false };
}

/**
 * TEAM-3991 D1.5 — the PR that already exists for a ticket, if any.
 *
 * ONE list call against the base branch, then a client-side match on the head
 * ref: a PR's head is `feature/<ticketId>-<something>` (the fleet's branch
 * convention) or the run's shared feature branch. Cheaper and more forgiving than
 * guessing the exact branch name, which is what made the dispatch guard worth
 * having — a re-dispatched agent that can't see its own merged PR redoes the work
 * (prod: TEAM-3790 investigated a finding it had already merged).
 *
 * Newest first, and a merged PR outranks an open one: the guard's decision differs
 * (synthesize vs resume), so the strongest state must win when both exist.
 * Returns null on any GitHub error — the caller FAILS OPEN and dispatches.
 */
export async function findTicketPullRequest(githubFetch, { owner, repo, base = "main", ticketId = "", featureBranch = "" } = {}) {
  if (!githubFetch || !owner || !repo || !ticketId) return null;
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const prs = await attempt(() =>
    githubFetch(`/repos/${o}/${r}/pulls?state=all&base=${encodeURIComponent(base)}&per_page=100&sort=updated&direction=desc`)
  );
  if (!Array.isArray(prs)) return null;

  const prefix = `feature/${ticketId}-`;
  const mine = prs.filter((p) => {
    const ref = p?.head?.ref || "";
    return ref === `feature/${ticketId}` || ref.startsWith(prefix) || (featureBranch && ref === featureBranch);
  });
  if (mine.length === 0) return null;
  const pick = mine.find((p) => p?.merged_at) || mine.find((p) => p?.state === "open") || mine[0];
  return {
    number: pick.number ?? null,
    url: pick.html_url || "",
    state: pick.merged_at ? "merged" : pick.state || "",
    merged: Boolean(pick.merged_at),
    headRef: pick.head?.ref || "",
  };
}

/**
 * Write the missing completion evidence for a ticket, from GitHub.
 *
 * Precondition: no `completions/<ticketId>.json` AND no `agentTasks[tid].output`
 * — otherwise the agent (or the webhook) already spoke and we defer to it.
 * Candidate branches: `feature/<ticketId>-<agentSlug>`, any `feature/<ticketId>-`
 * head found on a PR against the base, then the shared run branch.
 */
export async function synthesizeCompletion({ workflow, ticket, agentSlug = "", deps = {} }) {
  const {
    githubFetch,
    s3Get,
    s3Put,
    store,
    transitionTicket,
    publishEvent,
    now = () => Date.now(),
    log = console,
  } = deps;
  const ticketId = ticketIdOf(ticket);
  const key = `completions/${ticketId}.json`;

  try {
    if (!ticketId) return { synthesized: false, reason: "no_ticket" };

    // A throwing s3Get is the 404/NoSuchKey shape — treat as absent.
    const existing = await attempt(() => s3Get(key));
    if (existing) return { synthesized: false, reason: "evidence_exists" };
    if (workflow?.agentTasks?.[ticketId]?.output) return { synthesized: false, reason: "evidence_exists" };

    const { owner, repo } = parseRepo(workflow?.repoConfig);
    if (!owner || !repo) return { synthesized: false, reason: "no_repo" };
    const base = workflow?.repoConfig?.repos?.[0]?.defaultBranch || "main";

    const candidates = [];
    if (agentSlug) candidates.push(`feature/${ticketId}-${agentSlug}`);
    const prefix = `feature/${ticketId}-`;
    const sweep = await attempt(() =>
      githubFetch(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
          `?state=all&base=${encodeURIComponent(base)}&per_page=100`
      )
    );
    for (const pr of Array.isArray(sweep) ? sweep : []) {
      const ref = pr?.head?.ref || "";
      if (ref.startsWith(prefix)) candidates.push(ref);
    }
    if (workflow?.featureBranch) candidates.push(workflow.featureBranch);

    const ev = await probeTicketBranches(githubFetch, { owner, repo, base, branches: candidates });
    if (!ev.hasEvidence) return { synthesized: false, reason: "no_evidence" };

    const synthesizedAt = new Date(now()).toISOString();
    const summary = `[synthesized] ${ev.aheadBy} commit(s) on ${ev.branch}; PR ${ev.prUrl || "none"}`;

    await store.mergeTaskMetadataOrTrack(
      workflow.id,
      ticketId,
      {
        output: summary,
        branch: ev.branch,
        commitSha: ev.commitSha,
        prUrl: ev.prUrl,
        evidenceSource: "synthesized",
        synthesizedAt,
      },
      { agentId: ticket?.assignee }
    );

    await s3Put(
      key,
      JSON.stringify(
        {
          ticket_id: ticketId,
          agent_id: ticket?.assignee || "",
          workflow_id: workflow.id,
          source: "synthesized",
          branch: ev.branch,
          commit_sha: ev.commitSha,
          pr_url: ev.prUrl,
          summary,
          synthesized_at: synthesizedAt,
        },
        null,
        2
      )
    );

    if (String(ticket?.status || "").toLowerCase() !== "done") {
      await transitionTicket(ticketId, "done");
    }

    await publishEvent?.(ticketId, "agent.completion_synthesized", {
      workflowId: workflow.id,
      ticketId,
      agentId: ticket?.assignee || "",
      branch: ev.branch,
      commitSha: ev.commitSha,
      prUrl: ev.prUrl,
      prState: ev.prState,
      aheadBy: ev.aheadBy,
      synthesizedAt,
    });

    return {
      synthesized: true,
      branch: ev.branch,
      commitSha: ev.commitSha,
      prUrl: ev.prUrl,
      prNumber: ev.prNumber,
      aheadBy: ev.aheadBy,
      summary,
    };
  } catch (err) {
    log.warn?.(`[evidence] synthesize failed for ${workflow?.id}/${ticketId}: ${err?.message || err}`);
    return { synthesized: false, reason: "error" };
  }
}
