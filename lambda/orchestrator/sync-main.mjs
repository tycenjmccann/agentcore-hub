/**
 * Sync the default branch INTO the run's integration branch before CI dispatch
 * (TEAM-4122 FR-6, design §8).
 *
 * The problem: three dev agents push to one shared `feature/{EPIC}-…` branch and
 * the CI agent then certifies its head SHA. Meanwhile `main` has moved. CodeBuild
 * builds the feature head, so a green build says "this branch is green", NOT
 * "this branch is green ON TOP OF what is on main now" — and the human merge
 * approver reads it as the latter. Every conflict and every semantic clash with
 * a sibling merge surfaces AFTER the approval, on the merge itself, where no
 * agent is watching. Merging main in FIRST makes the SHA the CI agent certifies
 * the SHA that will actually land.
 *
 * Modes (SYNC_MAIN_BEFORE_CI):
 *   off     — never called. Zero GitHub calls, zero writes, byte-identical.
 *   shadow  — one `compare` read; publishes `workflow.sync_dry_run` with how far
 *             behind the branch is and whether a sync WOULD happen. It cannot
 *             tell you whether the merge would CONFLICT (that needs the merge
 *             attempt itself), so `conflictKnown` is always false. No writes.
 *   enforce — POST /merges. 201 → synced, 204 → already up to date, 409 →
 *             conflict: file a `Fix (sync-main)` sync_fix ticket, block the CI
 *             ticket on it, release the CI ticket's claim, and let the normal
 *             cascade re-dispatch CI once the dev has resolved it.
 *
 * Fail-open by construction: every unexpected status, every network error and
 * every internal throw returns `{ outcome: "skipped" }`. A sync we could not do
 * must never wedge CI — the pre-4122 behaviour (certify the un-synced head) is
 * strictly better than not certifying at all. The ONE outcome that stops the
 * dispatch is `conflict`, because there the branch provably cannot merge and a
 * human/dev has to touch it.
 *
 * Security pins (design F9), asserted in code before any write:
 *   - the merge direction is fixed: base = the run's feature branch, head = the
 *     repo's default branch. This function can NEVER write to the default
 *     branch — a reversed base/head would be a push to main.
 *   - owner/repo are URL-encoded into every path, and both refs are validated
 *     against a strict charset (no `%`, `?`, `#`, whitespace, no `..`) so a
 *     hostile branch name cannot escape the intended endpoint.
 *   - refuses to touch an `-advisory` branch, a run with no feature branch, or a
 *     run whose feature branch IS the default branch.
 *
 * Pure-ish + DI: every seam arrives in `deps`, so the whole matrix is unit
 * testable with plain objects (same split as repo-check.mjs / ci-check.mjs).
 */

const MODES = ["off", "shadow", "enforce"];

/**
 * Strict allow-list. A PRESENT-but-garbage value coalesces to OFF, not shadow:
 * enforce PUSHES A COMMIT to a shared branch and can file a real ticket, so a
 * typo'd env var must never be able to start mutating branches. (Same asymmetry
 * as LIVE_REVERIFY / CI_CHECK_MODE, opposite of REWORK_LOOP_CAP.)
 */
export function normalizeSyncMode(v) {
  if (v === undefined || v === null) return "off";
  const s = String(v).trim().toLowerCase();
  return MODES.includes(s) ? s : "off";
}

// A git ref we are willing to interpolate into a URL path. Deliberately narrower
// than git's own rules: no `%` (double-encoding), no `?`/`#` (query/fragment
// injection), no whitespace, and `..` is rejected separately (path traversal AND
// an illegal git ref).
const SAFE_REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;

const ADVISORY_SUFFIX = "-advisory";

// GitHub's compare endpoint returns at most 300 files. Past that the file list is
// truncated, so the conflict-candidate intersection is a hint, not a set.
const COMPARE_FILE_LIMIT = 300;

// cited_location anchors on the fix ticket. Capped so a 200-file drift does not
// produce an unreadable contract.
const MAX_CITED = 20;

const DEFAULT_ASSIGNEE = "agentcore_hub_backend_dev";

function safeRef(ref) {
  const s = String(ref ?? "").trim();
  if (!s || !SAFE_REF_RE.test(s)) return null;
  if (s.includes("..") || s.startsWith("/") || s.endsWith("/")) return null;
  return s;
}

/** owner/repo from the run's first repo — same shape index.mjs's parseRepoUrl reads. */
function parseOwnerRepo(url) {
  const m = String(url || "").match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * The dev-phase agent that most recently finished on this run — the person whose
 * branch this is, and therefore the right owner of a conflict with main. Falls
 * back to the backend dev (always on the roster) rather than leaving the fix
 * ticket unassigned, which would never dispatch.
 */
function resolveConflictAssignee(workflow, getAgentDef) {
  const tasks = workflow?.agentTasks || {};
  let best = null;
  for (const entry of Object.values(tasks)) {
    const agentId = entry?.agentId;
    if (!agentId || !entry?.completedAt) continue;
    let phase;
    try { phase = getAgentDef?.(agentId)?.phase; } catch { phase = undefined; }
    if (phase !== "development") continue;
    if (!best || String(entry.completedAt) > String(best.completedAt)) best = entry;
  }
  return best?.agentId || DEFAULT_ASSIGNEE;
}

function conflictDescription({ base, head, files, truncated, ciTicketId }) {
  const lines = [
    `The orchestrator tried to merge \`${head}\` into the run's integration branch \`${base}\` before CI certification and GitHub reported a MERGE CONFLICT.`,
    "",
    `Why this blocks CI: the CI agent certifies the head SHA of \`${base}\`. Until \`${head}\` merges cleanly, that SHA is not the code that would land, so a green build on it would be misleading. CI ticket ${ciTicketId} is blocked on this ticket and re-dispatches automatically when you close it.`,
    "",
  ];
  if (files.length) {
    lines.push(
      `Conflict candidates — files changed on BOTH sides since the merge base${truncated ? " (list truncated by GitHub at 300 files per side, so there may be more)" : ""}:`,
      ...files.map((f) => `- ${f}`),
      ""
    );
  } else {
    lines.push(
      "GitHub's compare could not be read, so there is no candidate file list — see `git merge` output for the real conflict set.",
      ""
    );
  }
  lines.push(
    "How to resolve:",
    "```",
    `git fetch origin`,
    `git checkout ${base}`,
    `git merge origin/${head}`,
    `# resolve the conflicts, keeping BOTH sides' intent`,
    `git commit`,
    `git push origin ${base}`,
    "```",
    "",
    "Resolve ONLY the conflicts. This is not the ticket to refactor on: any behaviour change here is invisible to the reviews that already passed on this branch.",
  );
  return lines.join("\n");
}

/**
 * Merge the repo's default branch into the run's integration branch, before the
 * CI agent is dispatched.
 *
 * @returns {Promise<{outcome:"synced"|"noop"|"conflict"|"skipped"|"dry-run",
 *   sha?:string|null, fixTicketId?:string|null, reason?:string,
 *   baseHeadSha?:string|null, files?:string[]}>}
 *   Only `conflict` means "do not dispatch CI". Never throws.
 */
export async function syncBeforeCi(workflow, ticket, deps = {}) {
  const {
    githubApi,
    githubApiRaw,
    store,
    invokeTickets,
    addBlockers,
    publishEvent,
    getAgentDef,
    now = () => new Date(),
    mode = "off",
    log = console,
  } = deps;

  const warn = (msg) => log?.warn?.(`[sync-main] ${msg}`);
  const ticketId = ticket?.ticketId;
  const workflowId = workflow?.id || workflow?.workflowId;

  // Best-effort event: an unpublishable event must not change the outcome.
  const emit = async (type, detail) => {
    try { await publishEvent?.(ticketId, type, { workflowId, ...detail }); }
    catch (err) { warn(`publishEvent(${type}) failed: ${err?.message || err}`); }
  };
  const skip = async (reason, extra = {}) => {
    await emit("workflow.sync_skipped", { reason, ...extra });
    return { outcome: "skipped", reason, ...extra };
  };

  try {
    if (mode === "off") return { outcome: "skipped", reason: "mode_off" };
    // No PAT → no GitHub. Silent (no event): this is a configuration state of the
    // whole install, not a fact about this run.
    if (typeof githubApi !== "function") return { outcome: "skipped", reason: "no_pat" };

    const repoEntry = workflow?.repoConfig?.repos?.[0];
    const parsed = parseOwnerRepo(repoEntry?.url);
    if (!parsed) return { outcome: "skipped", reason: "no_repo" };
    const { owner, repo } = parsed;

    // ── F9: the merge direction is FIXED here and nowhere else ────────────────
    // base = where the merge commit lands = the run's own feature branch.
    // head = what gets merged in = the repo's default branch, read-only.
    const base = safeRef(workflow?.featureBranch);
    const head = safeRef(repoEntry?.defaultBranch || "main");
    if (!base) return { outcome: "skipped", reason: "no_feature_branch" };
    if (!head) return { outcome: "skipped", reason: "unsafe_head_ref" };
    if (base === head) return { outcome: "skipped", reason: "base_equals_head" };
    if (base.endsWith(ADVISORY_SUFFIX)) return { outcome: "skipped", reason: "advisory_branch" };
    // ── boundary: base/head are validated, non-equal refs from here down ──────

    const rp = repoPath(owner, repo);

    // The default branch's head — the idempotency key. Two dispatches of the same
    // CI ticket against the same main head must do the work once.
    let baseHeadSha = null;
    try {
      const branch = await githubApi(`${rp}/branches/${encodeURIComponent(head)}`);
      baseHeadSha = branch?.commit?.sha || null;
    } catch (err) {
      warn(`${workflowId}: could not read ${head} (${err?.status || "error"}) — skipping the sync`);
      return await skip("base_head_unavailable", { base, head, status: err?.status });
    }
    if (!baseHeadSha) return await skip("base_head_unavailable", { base, head });

    // ── idempotency: this CI ticket, against this default-branch head ─────────
    // The claim does NOT protect this. On a conflict we RELEASE the claim (the
    // CI agent is not running), so a stream redelivery or a webhook twin re-claims
    // cleanly and walks straight back in here.
    const prior = workflow?.syncMain;
    const samePrior = !!prior && prior.ciTicketId === ticketId && prior.baseHeadSha === baseHeadSha;
    if (samePrior && (prior.status === "synced" || prior.status === "noop")) {
      // Zero writes, no event: a redelivery of an already-synced dispatch is not
      // news, and an event per redelivery would drown the run's timeline.
      return { outcome: "skipped", reason: "already_synced", baseHeadSha };
    }
    // A recorded conflict against THIS head, on the other hand, is NOT a reason
    // to stop: the ordinary unblock is the dev resolving it and CI re-dispatching
    // against the same main head, so short-circuiting here would wedge the run
    // permanently. Re-attempt the merge — but remember the ticket we already
    // filed, so a redelivery (or the re-dispatch of a still-conflicting branch)
    // can never produce a SECOND identical fix ticket for the dev to look at.
    const knownFixTicketId =
      samePrior && prior.status === "conflict" ? prior.fixTicketId || null : null;

    // Same encoding as index.mjs's ship merge-verify compare (percent-encoded
    // refs, literal `...`), on top of the charset validation above.
    const compare = async (a, b) =>
      githubApi(`${rp}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`);

    // ── shadow: one read, one event, zero writes ─────────────────────────────
    if (mode === "shadow") {
      let behindBy = null;
      let status = null;
      try {
        const cmp = await compare(base, head);
        behindBy = Number(cmp?.ahead_by) || 0;
        status = cmp?.status || null;
      } catch (err) {
        warn(`${workflowId}: compare ${base}...${head} failed (${err?.status || "error"})`);
        return await skip(`compare_unavailable`, { base, head, baseHeadSha, status: err?.status });
      }
      await emit("workflow.sync_dry_run", {
        ticketId, base, head, baseHeadSha,
        behindBy,
        compareStatus: status,
        wouldSync: behindBy > 0,
        // A merge is the only way to learn whether it conflicts, and shadow does
        // not merge. Never report "no conflict" from a compare.
        conflictKnown: false,
        shadow: true,
      });
      return { outcome: "dry-run", baseHeadSha, reason: behindBy > 0 ? "would_sync" : "up_to_date" };
    }

    // ── enforce ──────────────────────────────────────────────────────────────
    const commitMessage = `chore(sync): merge ${head} into ${base} before CI (${ticketId})`;
    let res;
    try {
      res = typeof githubApiRaw === "function"
        ? await githubApiRaw(`${rp}/merges`, "POST", { base, head, commit_message: commitMessage })
        // Without the raw seam a 204 is indistinguishable from a 201 by status,
        // but not by body: the 201 carries the merge commit, the 204 is empty.
        : await githubApi(`${rp}/merges`, "POST", { base, head, commit_message: commitMessage })
          .then((body) => ({ status: body ? 201 : 204, body }));
    } catch (err) {
      const status = err?.status;
      if (status === 409) {
        return await handleConflict();
      }
      warn(`${workflowId}: merge ${head} → ${base} failed (${status || "network"}): ${err?.message || err}`);
      return await skip(`merge_failed`, { base, head, baseHeadSha, status: status ?? null });
    }

    // A raw seam reports 409 as a status rather than a throw — handle both.
    if (res?.status === 409) return await handleConflict();
    if (res?.status !== 201 && res?.status !== 204) {
      return await skip("merge_unexpected_status", { base, head, baseHeadSha, status: res?.status ?? null });
    }

    const noop = res.status === 204;
    // 204 = "already up to date": there is no new merge commit, so there is no
    // sha of our own to report. baseHeadSha already says which main head the
    // branch is level with.
    const sha = noop ? null : res.body?.sha || null;
    await emit("workflow.branch_synced", { ticketId, base, head, sha, baseHeadSha, noop });
    await persist({
      at: now().toISOString(),
      sha,
      baseHeadSha,
      status: noop ? "noop" : "synced",
      ciTicketId: ticketId,
    });
    return { outcome: noop ? "noop" : "synced", sha, baseHeadSha };

    // ── helpers that close over the validated refs ───────────────────────────

    async function persist(record) {
      if (workflow) workflow.syncMain = record; // keep this container's snapshot honest
      try { await store?.setSyncMain?.(workflowId, record); }
      catch (err) { warn(`setSyncMain(${workflowId}) failed: ${err?.message || err}`); }
    }

    async function handleConflict() {
      // Already ticketed against this same head: reuse the ticket and the file
      // list persisted with it, which also spares two more compares.
      if (knownFixTicketId) {
        await blockOnFix(knownFixTicketId);
        const files = prior?.files || [];
        await emit("workflow.sync_conflict", {
          ticketId, fixTicketId: knownFixTicketId, files, base, head, baseHeadSha, alreadyTicketed: true,
        });
        await persist({
          at: now().toISOString(), baseHeadSha, status: "conflict",
          ciTicketId: ticketId, fixTicketId: knownFixTicketId, files,
        });
        return { outcome: "conflict", fixTicketId: knownFixTicketId, baseHeadSha, files, reason: "already_ticketed" };
      }

      const { files, truncated } = await conflictCandidates();
      const n = files.length;
      const summary = `Fix (sync-main): merge conflict with ${head} in ${n ? `${n} file(s)` : "unknown files"}`;
      const assignee = resolveConflictAssignee(workflow, getAgentDef);

      let fixTicketId = null;
      try {
        const created = await invokeTickets?.("create_ticket", {
          summary,
          description: conflictDescription({ base, head, files, truncated, ciTicketId: ticketId }),
          assignee,
          parent_key: workflow?.epicId,
          workflow_id: workflowId,
          blocked_by: [],
          phase: "development",
          spawned_by: { kind: "sync_fix", ciTicketId: ticketId },
          fix_contract: {
            invariant: `the integration branch ${base} merges cleanly with ${head}`,
            // `static`: the evidence is the merge attempt itself, not a test run.
            // The repro is a SINGLE command on purpose — the contract validator
            // rejects shell composition (`&&`, `;`, `|`), so `git fetch` rides in
            // the description instead.
            evidence_source: "static",
            evidence_repro: `git merge origin/${head}`,
            cited_location: files
              // The contract's anchor shape is `path:line`, so a path containing
              // whitespace or a colon would make the WHOLE field invalid and, in
              // enforce mode, reject the ticket. Drop those rather than lose the fix.
              .filter((f) => /^[^\s:]+$/.test(f))
              .slice(0, MAX_CITED)
              .map((f) => `${f}:1`),
            sibling_scope: "conflict resolution only",
          },
        });
        fixTicketId = created?.key || created?.ticket?.key || null;
      } catch (err) {
        warn(`${workflowId}: could not file the sync_fix ticket: ${err?.message || err}`);
      }

      if (!fixTicketId) {
        // No ticket = nothing to block on and nobody assigned. Blocking CI anyway
        // would strand the run with no path forward, so fail open: CI dispatches
        // against the un-synced head (exactly the pre-FR-6 behaviour) and the
        // event is the record that the branch cannot merge.
        await persist({ at: now().toISOString(), baseHeadSha, status: "conflict", ciTicketId: ticketId, fixTicketId: null });
        return await skip("conflict_unticketed", { base, head, baseHeadSha, files });
      }

      await blockOnFix(fixTicketId);
      await emit("workflow.sync_conflict", { ticketId, fixTicketId, files, base, head, baseHeadSha });
      // `files` is persisted so a redelivery can answer with the same candidate
      // list without paying two more compares.
      await persist({ at: now().toISOString(), baseHeadSha, status: "conflict", ciTicketId: ticketId, fixTicketId, files });
      return { outcome: "conflict", fixTicketId, baseHeadSha, files };
    }

    /**
     * Block the CI ticket on the fix and release the CI ticket's claim. Both are
     * idempotent (a repeated blocker is a no-op, a repeated status write is the
     * same value), which is what lets the redelivery path re-run them.
     *
     * The claim release matters: the caller took it before this ran and the CI
     * agent is NOT being invoked, so without this the entry stays "running" and
     * the cascade's re-dispatch (once the fix closes) is rejected as a duplicate.
     * "ready" is the value lease.mjs's stealClaim writes for a released claim;
     * "error" is reserved for a FAILED INVOKE and is read as an escalation hold
     * (cascade.mjs escalationHeld) plus rendered as "agent encountered an error"
     * in the UI — neither is true here, the agent never ran.
     */
    async function blockOnFix(fixTicketId) {
      try { await addBlockers?.(ticketId, [fixTicketId]); }
      catch (err) { warn(`addBlockers(${ticketId} ← ${fixTicketId}) failed: ${err?.message || err}`); }
      try { await store?.setTaskStatus?.(workflowId, ticketId, "ready"); }
      catch (err) { warn(`releasing the claim on ${ticketId} failed: ${err?.message || err}`); }
      const entry = workflow?.agentTasks?.[ticketId];
      if (entry) entry.status = "ready";
    }

    /**
     * Files plausibly in conflict = changed on BOTH sides since the merge base.
     * Two compares, intersected. Best-effort: an unreadable compare yields an
     * empty list and the ticket says "see git merge" instead.
     */
    async function conflictCandidates() {
      try {
        const [ours, theirs] = await Promise.all([compare(head, base), compare(base, head)]);
        const oursFiles = (ours?.files || []).map((f) => f?.filename).filter(Boolean);
        const theirsFiles = new Set((theirs?.files || []).map((f) => f?.filename).filter(Boolean));
        const truncated =
          oursFiles.length >= COMPARE_FILE_LIMIT || theirsFiles.size >= COMPARE_FILE_LIMIT;
        return { files: oursFiles.filter((f) => theirsFiles.has(f)).sort(), truncated };
      } catch (err) {
        warn(`${workflowId}: conflict compare failed (${err?.status || "error"}) — filing without a file list`);
        return { files: [], truncated: false };
      }
    }
  } catch (err) {
    // Belt and braces: the CI dispatch must survive any bug in here.
    warn(`${workflow?.id || "?"}: unexpected failure — CI proceeds un-synced: ${err?.message || err}`);
    return { outcome: "skipped", reason: `error:${err?.name || "Error"}` };
  }
}
