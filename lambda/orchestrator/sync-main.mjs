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
 * Conflict ROUNDS (TEAM-4131 F1): a recorded fix ticket is reused only while it
 * is still OPEN. A dev who closes the fix ticket without actually resolving the
 * conflict must not leave CI blocked on a closed ticket — no `done` event will
 * ever fire for it again, so that blocker edge is a permanent, silent wedge (or,
 * with the reconcile sweep re-readying CI, an invisible loop). Instead the next
 * round is filed, carrying `priorFixTicketId` + `round`, and after
 * MAX_SYNC_FIX_ROUNDS the run PARKS for a human instead of filing a fourth.
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

// The one provider-agnostic reader of a create_ticket response (TEAM-4156 F1).
// ticket-blockers.mjs has zero imports of its own, so this cannot cycle.
import { createdTicketId } from "./ticket-blockers.mjs";

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

/**
 * How many sync_fix tickets ONE CI ticket may accumulate against the SAME
 * default-branch head before the run parks for a human (TEAM-4131 F1). Round 1 is
 * the first ticket; a round is only ever consumed by a fix ticket that was CLOSED
 * while the branch still would not merge, so three rounds means three devs (or
 * three attempts by one) closed the ticket without fixing the conflict. At that
 * point filing a fourth identical ticket is just noise.
 *
 * Exported as a default + overridable per call (`deps.maxSyncFixRounds`) rather
 * than read from an env var — same shape as REWORK_LOOP_CAP_DEFAULT_MAX in
 * rework-loop-cap.mjs, and one less deploy-surface knob to document.
 */
export const MAX_SYNC_FIX_ROUNDS = 3;

/**
 * Statuses that mean "nobody will ever work this ticket again". Blocking CI on a
 * ticket in one of these is the wedge TEAM-4131 F1 fixes: the cascade clears a
 * blocker edge on the blocker's `done` TRANSITION, and a ticket that is already
 * closed never transitions again.
 *
 * `done` and `cancelled` are the two the board actually stores — the same pair
 * every other closed-check in the orchestrator uses (cascade.mjs
 * RESOLVED_BLOCKER_STATUSES, completion.mjs isOpen, ship-dispatch-gate.mjs). The
 * tickets Lambda's `skip` transition resolves to `done`, so `skipped` is never
 * stored as a ticket status; it is accepted here defensively because a provider
 * that DID store it would otherwise be read as "still open".
 */
const CLOSED_FIX_STATUSES = new Set(["done", "cancelled", "skipped"]);

/**
 * Which round the recorded conflict is on. A pre-TEAM-4131 record carries no
 * `round` but does carry a `fixTicketId`, and one filed ticket IS round 1 — so a
 * record written by the old code converges instead of restarting the count.
 */
function recordedRound(record) {
  const n = Number(record?.round);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * A ticket ROW's id, under any provider's spelling — the DynamoDB list answers
 * `ticketId`, Jira's mapIssue answers `ticketId` too but a raw issue carries
 * `key`. Same shape-tolerant helper live-reverify.mjs and
 * dead-session-escalation.mjs use for their own sibling scans.
 */
const idOf = (t) => t?.ticketId || t?.key || t?.id || null;

/** The board's status of a ticket row, folded the way CLOSED_FIX_STATUSES stores it. */
const statusOf = (t) => (typeof t?.status === "string" ? t.status.trim().toLowerCase() : "");

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

function conflictDescription({ base, head, files, truncated, ciTicketId, round = 1, priorFixTicketId = null, priorStatus = null }) {
  const lines = [
    `The orchestrator tried to merge \`${head}\` into the run's integration branch \`${base}\` before CI certification and GitHub reported a MERGE CONFLICT.`,
    "",
  ];
  if (round > 1 && priorFixTicketId) {
    lines.push(
      `**This is round ${round}.** ${priorFixTicketId} was filed for the same conflict and closed (status \`${priorStatus || "closed"}\`) WITHOUT resolving it — \`${head}\` still does not merge into \`${base}\`. Please actually land the merge commit on \`${base}\` before closing this ticket; closing it again with the branch unmerged will only park the run for a human.`,
      "",
    );
  }
  lines.push(
    `Why this blocks CI: the CI agent certifies the head SHA of \`${base}\`. Until \`${head}\` merges cleanly, that SHA is not the code that would land, so a green build on it would be misleading. CI ticket ${ciTicketId} is blocked on this ticket and re-dispatches automatically when you close it.`,
    "",
  );
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
 *   baseHeadSha?:string|null, files?:string[], round?:number,
 *   priorFixTicketId?:string|null}>}
 *   Only `conflict` means "do not dispatch CI" — including `reason:"round_cap"`,
 *   where there is no fix ticket to wait on and a human has to step in. Never throws.
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
    // TEAM-4131 F1 — (id) => Promise<string|null>: the CURRENT status of one
    // ticket, read consistently. Wired to index.mjs's getTicketConsistent, which
    // is provider-agnostic (Jira's REST GET is already authoritative). Omitted =
    // "cannot tell", which fails open to the pre-4131 reuse behaviour.
    getTicketStatus,
    // TEAM-4156 F2 — (epicId) => Promise<ticket[]>: every ticket under the run's
    // epic. Used ONLY on the 409 path with no recorded fix ticket, to notice a
    // sync_fix that is already on the board (the record write can fail, or a
    // container can die, AFTER create_ticket succeeded). Omitted = "cannot tell",
    // which fails open to the pre-4156 behaviour: file a fresh ticket.
    getChildTickets,
    maxSyncFixRounds = MAX_SYNC_FIX_ROUNDS,
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
    // A PARKED record is the one conflict state that DOES short-circuit
    // (TEAM-4131 F1): the round cap was reached, there is deliberately no open fix
    // ticket, and every redelivery from here must be a pure no-op — no GitHub
    // merge attempt, no new ticket, and above all no blocker edge onto the closed
    // ticket that got us here (that edge is the wedge this finding is about).
    //
    // WHAT UNBLOCKS A PARKED RUN: a human. Either they merge `head` into the
    // feature branch by hand (which makes the next dispatch a 204/noop and the
    // record converge on its own), or they move `main` (a new baseHeadSha makes
    // `samePrior` false and the rounds start over), or they cancel the run.
    //
    // The CI ticket is left un-dispatched and NOT blocked, but its claim IS
    // released on every redelivery (an idempotent write of the same "ready"
    // value) — the caller takes the claim BEFORE calling syncBeforeCi, so without
    // this the entry would read "running" forever with no agent ever invoked,
    // exactly the misleading state blockOnFix's own comment warns about.
    if (samePrior && prior.status === "parked") {
      warn(
        `${workflowId}: ${ticketId} is PARKED on the ${base} ↔ ${head} conflict after ` +
        `${recordedRound(prior)} sync_fix round(s) — a human must merge ${head} by hand`
      );
      await releaseClaim();
      return {
        outcome: "conflict", reason: "round_cap", baseHeadSha,
        round: recordedRound(prior),
        priorFixTicketId: prior.priorFixTicketId || prior.fixTicketId || null,
        files: prior.files || [],
        parked: true,
      };
    }
    // A recorded conflict against THIS head, on the other hand, is NOT a reason
    // to stop: the ordinary unblock is the dev resolving it and CI re-dispatching
    // against the same main head, so short-circuiting here would wedge the run
    // permanently. Re-attempt the merge — but remember the ticket we already
    // filed, so a redelivery (or the re-dispatch of a still-conflicting branch)
    // can never produce a SECOND identical fix ticket for the dev to look at.
    // Whether that ticket is still a legal thing to block on is decided in
    // handleConflict, where a 409 has actually happened and the status read is
    // worth paying for.
    const priorConflict = samePrior && prior.status === "conflict";
    const knownFixTicketId = priorConflict ? prior.fixTicketId || null : null;
    const knownRound = knownFixTicketId ? recordedRound(prior) : 0;

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

    /**
     * @returns {Promise<boolean>} whether the DURABLE write landed. Still
     *   best-effort — a failed record must never change the outcome — but the
     *   conflict path now reports the failure instead of only warning about it
     *   (TEAM-4156 F2): the record is the only pointer from this run back to the
     *   fix ticket, so losing it is what makes a redelivery file a duplicate.
     *   No store seam wired at all counts as "nothing to lose" → true.
     */
    async function persist(record) {
      if (workflow) workflow.syncMain = record; // keep this container's snapshot honest
      try { await store?.setSyncMain?.(workflowId, record); return true; }
      catch (err) {
        warn(`setSyncMain(${workflowId}) failed: ${err?.message || err}`);
        return false;
      }
    }

    async function handleConflict() {
      // ── is the ticket we already filed still a legal thing to block on? ──────
      // (TEAM-4131 F1.) Reusing it unconditionally was a silent permanent wedge:
      // a fix ticket the dev CLOSED without resolving the conflict will never fire
      // another `done` event, so the blocker edge added below would never clear.
      // Either CI waits forever, or the reconcile sweep re-readies it and we come
      // straight back here — an invisible loop that files nothing and says nothing.
      let reuseFixTicketId = null;
      let reusedUnverified = false;
      let reusedFromSibling = false;
      let closedFixTicketId = null;
      let closedFixStatus = null;
      if (knownFixTicketId) {
        const { known, status } = await readFixStatus(knownFixTicketId);
        if (!known) {
          // Fail open to the pre-4131 behaviour: a ticket-store blip must not start
          // filing duplicate tickets at a dev. `reusedUnverified` rides on the
          // event and the record so the timeline says the reuse was never confirmed.
          reuseFixTicketId = knownFixTicketId;
          reusedUnverified = true;
          warn(`${workflowId}: could not read the status of ${knownFixTicketId} — reusing it UNVERIFIED`);
        } else if (CLOSED_FIX_STATUSES.has(status)) {
          closedFixTicketId = knownFixTicketId;
          closedFixStatus = status;
        } else {
          reuseFixTicketId = knownFixTicketId;
        }
      }

      // ── the record is not the only witness (TEAM-4156 F2) ────────────────────
      // `fixTicketId` is written AFTER create_ticket, so every failure between the
      // two — a throttled `setSyncMain`, a container that dies, a stream redelivery
      // that overlaps — loses the only pointer we had to a ticket that really
      // exists on the board. The old code then filed a second identical ticket at
      // the same dev, every redelivery, and blocked CI on the newest one while the
      // earlier ones sat open forever.
      //
      // So ask the board. Provenance match (`spawnedBy`), never summary text, and
      // only an OPEN sibling is reusable — reusing a CLOSED one is exactly the
      // permanent wedge TEAM-4131 F1 fixed, so a closed sibling is ignored here and
      // the ordinary round-1 create below files the ticket the dev can actually
      // work. Same scan live-reverify.mjs runs before its own create.
      if (!reuseFixTicketId && !closedFixTicketId) {
        const sibling = await findOpenSyncFixSibling();
        if (sibling) {
          reuseFixTicketId = sibling;
          reusedFromSibling = true;
          warn(`${workflowId}: no recorded sync_fix for ${ticketId}, but ${sibling} is already on the board — reusing it`);
        }
      }

      // Already ticketed against this same head, and still open: reuse the ticket
      // and the file list persisted with it, which also spares two more compares.
      if (reuseFixTicketId) {
        const files = prior?.files || [];
        // A sibling found by the scan is round 1 as far as anyone can tell — the
        // record that would have said otherwise is the thing that went missing.
        const round = knownFixTicketId ? knownRound : 1;
        const marks = {
          ...(reusedUnverified ? { reusedUnverified: true } : {}),
          ...(reusedFromSibling ? { reusedFromSibling: true } : {}),
        };
        // Persist FIRST on the sibling-reuse path for the same reason as the create
        // path below: this may be the only chance to record the pointer.
        const persisted = await persist({
          at: now().toISOString(), baseHeadSha, status: "conflict",
          ciTicketId: ticketId, fixTicketId: reuseFixTicketId, files, round,
          ...marks,
        });
        await blockOnFix(reuseFixTicketId);
        await emit("workflow.sync_conflict", {
          ticketId, fixTicketId: reuseFixTicketId, files, base, head, baseHeadSha, alreadyTicketed: true,
          round, reusedUnverified, ...marks,
          ...(persisted ? {} : { persistFailed: true }),
        });
        return {
          outcome: "conflict", fixTicketId: reuseFixTicketId, baseHeadSha, files,
          reason: "already_ticketed", round, ...marks,
        };
      }

      // The recorded fix is closed and the branch STILL will not merge, so the
      // conflict outlived its ticket. File the next round rather than block on a
      // corpse — but only up to the cap.
      const round = closedFixTicketId ? knownRound + 1 : 1;
      const cap =
        Number.isFinite(Number(maxSyncFixRounds)) && Number(maxSyncFixRounds) >= 1
          ? Math.floor(Number(maxSyncFixRounds))
          : MAX_SYNC_FIX_ROUNDS;
      if (round > cap) return await park({ priorFixTicketId: closedFixTicketId, priorStatus: closedFixStatus, cap });

      const { files, truncated } = await conflictCandidates();
      const n = files.length;
      const summary =
        `Fix (sync-main): merge conflict with ${head} in ${n ? `${n} file(s)` : "unknown files"}` +
        // The round suffix is not decoration: without it round 2 is an identical
        // summary to round 1 on the same epic, which is indistinguishable in a
        // board view and in any summary-based dedupe.
        (round > 1 ? ` (round ${round})` : "");
      const assignee = resolveConflictAssignee(workflow, getAgentDef);

      let fixTicketId = null;
      try {
        const created = await invokeTickets?.("create_ticket", {
          summary,
          description: conflictDescription({
            base, head, files, truncated, ciTicketId: ticketId,
            round, priorFixTicketId: closedFixTicketId, priorStatus: closedFixStatus,
          }),
          assignee,
          parent_key: workflow?.epicId,
          workflow_id: workflowId,
          blocked_by: [],
          phase: "development",
          spawned_by: {
            kind: "sync_fix",
            ciTicketId: ticketId,
            // Lineage for round >= 2. Both keys are allow-listed in
            // fix-contract.mjs's SPAWN_EXTRA_KEYS; anything else would be dropped
            // by sanitizeSpawnedBy without a word.
            ...(closedFixTicketId ? { priorFixTicketId: closedFixTicketId, round } : {}),
          },
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
        // Both providers' shapes, one accessor (TEAM-4156 F1). Reading `key` alone
        // meant that under TICKET_PROVIDER=jira this was ALWAYS null: the ticket was
        // filed, and the fail-open branch below then let CI certify a branch that
        // provably cannot merge.
        fixTicketId = createdTicketId(created);
      } catch (err) {
        warn(`${workflowId}: could not file the sync_fix ticket: ${err?.message || err}`);
      }

      if (!fixTicketId) {
        // No ticket = nothing to block on and nobody assigned. Blocking CI anyway
        // would strand the run with no path forward, so fail open: CI dispatches
        // against the un-synced head (exactly the pre-FR-6 behaviour) and the
        // event is the record that the branch cannot merge.
        // No `round` on this record on purpose: no ticket was filed, so no round
        // was consumed, and the next attempt starts at 1 again. A create failure
        // fails open by design and must not burn the human-escalation budget.
        await persist({
          at: now().toISOString(), baseHeadSha, status: "conflict", ciTicketId: ticketId, fixTicketId: null,
          ...(closedFixTicketId ? { priorFixTicketId: closedFixTicketId } : {}),
        });
        return await skip("conflict_unticketed", { base, head, baseHeadSha, files });
      }

      // Record the ticket BEFORE the blocker edge and the event (TEAM-4156 F2).
      // Ordering is the whole fix: the write that says "this run already has a
      // sync_fix" has to be attempted at the first possible moment, because
      // everything after it can throw, time out, or be interrupted by the stream
      // redelivering this same event. `files` is persisted so a redelivery can
      // answer with the same candidate list without paying two more compares, and
      // `round` because this record is the only place the count lives — the next
      // redelivery reads it back.
      const persisted = await persist({
        at: now().toISOString(), baseHeadSha, status: "conflict", ciTicketId: ticketId, fixTicketId, files, round,
        ...(closedFixTicketId ? { priorFixTicketId: closedFixTicketId } : {}),
      });
      await blockOnFix(fixTicketId);
      await emit("workflow.sync_conflict", {
        ticketId, fixTicketId, files, base, head, baseHeadSha, round,
        ...(closedFixTicketId ? { priorFixTicketId: closedFixTicketId, priorStatus: closedFixStatus } : {}),
        // The ticket exists but this run may not remember it. The sibling scan
        // above is the recovery path; this flag is how a human (or the anomaly
        // watcher) sees that it was needed.
        ...(persisted ? {} : { persistFailed: true }),
      });
      return {
        outcome: "conflict", fixTicketId, baseHeadSha, files, round,
        ...(closedFixTicketId ? { priorFixTicketId: closedFixTicketId } : {}),
      };
    }

    /**
     * Round cap reached: stop filing tickets and hand the branch to a human.
     *
     * Deliberately NO create_ticket and NO addBlockers. The only ticket left to
     * block on is closed, and pointing a blocker edge at a closed ticket is the
     * exact wedge TEAM-4131 F1 is about. The CI claim IS released, so the entry is
     * not left "running" forever: the reconcile sweep may re-ready and re-dispatch
     * CI, which walks into the `status === "parked"` short-circuit above and
     * returns without a single write or GitHub call. See that block for what a
     * human does to unblock it.
     */
    async function park({ priorFixTicketId, priorStatus, cap }) {
      warn(
        `${workflowId}: ${knownRound} sync_fix round(s) closed without resolving the ${base} ↔ ${head} ` +
        `conflict — PARKING ${ticketId} for a human instead of filing round ${knownRound + 1}`
      );
      await emit("workflow.sync_conflict_parked", {
        ticketId, base, head, baseHeadSha, priorFixTicketId, priorStatus,
        round: knownRound, maxRounds: cap,
      });
      // Persist BEFORE releasing the claim: if the write lands and the release
      // does not, the run is merely stuck holding a claim (visible, and the stuck-
      // task sweep sees it). The other order could re-dispatch CI into a state
      // with no parked record and file round 4 after all.
      await persist({
        at: now().toISOString(), baseHeadSha, status: "parked", ciTicketId: ticketId,
        fixTicketId: null, priorFixTicketId, round: knownRound,
        files: prior?.files || [],
      });
      await releaseClaim();
      return {
        outcome: "conflict", reason: "round_cap", baseHeadSha,
        round: knownRound, priorFixTicketId,
        files: prior?.files || [], parked: true,
      };
    }

    /**
     * The recorded fix ticket's current status, lowercased — or `{known:false}`
     * when we cannot tell (no seam wired, a throw, or an empty answer). A MISSING
     * ticket (null/"") counts as unknown rather than closed on purpose: the
     * fail-open direction is "keep today's behaviour", not "file another ticket".
     */
    async function readFixStatus(id) {
      if (typeof getTicketStatus !== "function") return { known: false, status: null };
      try {
        const raw = await getTicketStatus(id);
        const st = typeof raw === "string" ? raw.trim().toLowerCase() : "";
        return st ? { known: true, status: st } : { known: false, status: null };
      } catch (err) {
        warn(`getTicketStatus(${id}) failed: ${err?.message || err}`);
        return { known: false, status: null };
      }
    }

    /**
     * An OPEN `sync_fix` ticket already on the board for THIS CI ticket, or null
     * (TEAM-4156 F2).
     *
     * Matched on `spawnedBy` provenance — `{kind:"sync_fix", ciTicketId}` is what
     * this module sends as `spawned_by`, both providers persist it, and it is
     * exact. Never on summary text: round 2's summary differs by design, and the
     * Jira provider's own summary dedupe is a different mechanism with a different
     * (per-epic) scope.
     *
     * Degrades to null on ANY problem — no seam, a throw, a non-array answer. This
     * is a duplicate-suppression optimisation on a fail-open path; refusing to
     * file the ticket because the scan failed would be strictly worse than filing
     * a second one.
     */
    async function findOpenSyncFixSibling() {
      if (typeof getChildTickets !== "function") return null;
      let siblings;
      try {
        siblings = await getChildTickets(workflow?.epicId);
      } catch (err) {
        warn(`getChildTickets(${workflow?.epicId}) failed: ${err?.message || err}`);
        return null;
      }
      if (!Array.isArray(siblings)) return null;
      for (const t of siblings) {
        if (t?.spawnedBy?.kind !== "sync_fix") continue;
        if (t?.spawnedBy?.ciTicketId !== ticketId) continue;
        const id = idOf(t);
        // A closed sibling is deliberately NOT reusable (TEAM-4131 F1): it can
        // never fire another `done`, so a blocker edge onto it never clears. An
        // UNKNOWN status ("" / missing) is treated as open, matching
        // readFixStatus's fail-open direction.
        if (!id || CLOSED_FIX_STATUSES.has(statusOf(t))) continue;
        return id;
      }
      return null;
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
      await releaseClaim();
    }

    /** The claim release on its own — the park path needs it WITHOUT a blocker. */
    async function releaseClaim() {
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
