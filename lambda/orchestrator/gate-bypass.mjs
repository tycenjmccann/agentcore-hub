/**
 * TEAM-3991 D1.1 — merge-without-approval detection (gate bypass).
 *
 * A run whose def declares a "Merge Approval" review gate must not have code
 * merged before a human APPROVE row exists in the gate ledger. wf sffzti shipped
 * four PRs (#327/#341/#342/#345) with the gate ticket still open and nobody ever
 * learned: the orchestrator only ever asked "is the gate ticket done?", never
 * "did the merge happen BEFORE the approval?".
 *
 * This module answers the second question. It is PURE: no AWS SDK clients, no
 * DynamoDB commands (R2 — every workflows-table write goes through the injected
 * `store`, i.e. workflow-store.mjs), no fetch of its own (the caller injects
 * `githubFetch`, normally index.mjs's `githubApi`, so auth lives in one place).
 *
 * SECURITY (F6): this module NEVER writes APPROVE rows. It only reads the ledger
 * that human-authenticated paths (console transition route, Telegram gate
 * decision) append via `store.appendGateDecision`.
 */

export const GATE_BYPASS_GRACE_MS = 180000; // 3 min — clock skew between GitHub and the ledger

/**
 * TEAM-4099 F3 — when the gate-decision ledger began recording human approvals.
 *
 * Derived from b56f1ae (2026-09-05T02:10:25Z), the commit that added
 * `recordGateDecision` to the console transition route — the first point at which
 * a human APPROVE could be written to `reviewGateHistory[gate].decisions` at all.
 * (`reviewGateHistory` itself predates it, shipping on main in dc39094 with
 * `rounds`/`escalations`/`authorizations` only — no `decisions`.) Runs created
 * before this could not possibly carry a decision row, so for them a gate ticket
 * sitting in `done` is the only surviving evidence of an approval. Runs created
 * after it have no such excuse.
 *
 * `GATE_LEDGER_EPOCH` overrides it — an operator who deploys the ledger later than
 * it was committed must be able to say so, or the detector would judge their real
 * legacy runs as bypasses.
 */
export const GATE_LEDGER_EPOCH_DEFAULT = "2026-09-05T02:10:25Z";

export function gateLedgerEpoch() {
  const raw = String(process.env.GATE_LEDGER_EPOCH || "").trim();
  return Number.isFinite(Date.parse(raw)) ? raw : GATE_LEDGER_EPOCH_DEFAULT;
}

const APPROVE = "APPROVE";
const REJECT_RE = /^(REQUEST_CHANGES|REJECT|REJECTED)$/i;

function ticketIdOf(ticket) {
  return ticket?.id || ticket?.ticketId || ticket?.key || "";
}

function isHuman(assignee) {
  return /^human:/i.test(String(assignee || ""));
}

function parseRepo(repoConfig) {
  const url = repoConfig?.repos?.[0]?.url || "";
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
}

function normalizePr(pr) {
  return {
    mergeCommit: pr.merge_commit_sha || "",
    prUrl: pr.html_url || "",
    mergedAt: pr.merged_at || "",
    number: pr.number,
    headSha: pr.head?.sha || "",
    headRef: pr.head?.ref || "",
  };
}

/**
 * Locate the Merge Approval gate for a run: the def gate plus the child ticket
 * that guards it.
 *
 * Gate tickets are identified by GUARDED PHASE, not title — `buildAgentContext`
 * tells the intake agent to name the ticket after the def gate and assign it to
 * `human:<reviewer from the Jira roster>`, so neither the title nor the assignee
 * string is canonical in production. `gatePhaseOf` is the same resolver
 * `isWorkflowComplete` uses (ticket.phase, else the agent phase of the first
 * in-batch blockedBy upstream); a title match is only the fallback.
 *
 * Returns null when the def declares no merge gate — the detector is then inert
 * (defs `marketing`/`sales` have no gates; `legal`'s Counsel Sign-off is not one).
 */
export function findMergeApprovalGate(children, workflowDef, { gatePhaseOf } = {}) {
  const gate = (workflowDef?.reviewGates || []).find((g) => /merge approval/i.test(String(g?.name || "")));
  if (!gate) return null;

  const humanChildren = (Array.isArray(children) ? children : []).filter((c) => isHuman(c?.assignee));
  let ticket = null;
  if (typeof gatePhaseOf === "function") {
    ticket = humanChildren.find((c) => gatePhaseOf(c) === gate.afterPhase) || null;
  }
  if (!ticket) {
    ticket = humanChildren.find((c) => /merge approval/i.test(String(c?.title || c?.summary || ""))) || null;
  }
  return { gate, ticket: ticket || null };
}

/**
 * TEAM-4099 F3 — is a `done` gate ticket with no ledger row allowed to STAND IN
 * for an approval on this run?
 *
 * Only for runs that predate the ledger. The board status of a ticket is not an
 * authorization: `Tickets___transition_ticket` is an ordinary agent tool, it carries
 * no caller identity, and `in_review → done` was a legal transition on it — so any
 * dev or fix agent could move its own merge gate to `done` and have this detector
 * then certify the merge it had just performed as `clean`. (The tool path is now
 * closed too — see the trusted-caller guard in the tickets/Jira Lambdas — but a
 * defence that lives only in one Lambda is not an authz floor: this is the second
 * half, and it is the half that also covers a status set before that guard shipped,
 * or set by any future writer that forgets it.)
 *
 * "Predates the ledger" is deliberately strict on BOTH counts: the run must carry
 * no `reviewGateHistory` attribute at all (a run with a ledger demonstrably had one
 * available to write to), AND have been created before `GATE_LEDGER_EPOCH`.
 */
export function gateDoneWithoutLedger(workflow, gateTicket, { epoch = gateLedgerEpoch() } = {}) {
  if (!gateTicket || String(gateTicket.status || "").toLowerCase() !== "done") return false;
  const gateId = ticketIdOf(gateTicket);
  if ((workflow?.reviewGateHistory?.[gateId]?.decisions || []).length > 0) return false;
  return !legacyStatusEligible(workflow, { epoch });
}

function legacyStatusEligible(workflow, { epoch = gateLedgerEpoch() } = {}) {
  if (workflow?.reviewGateHistory !== undefined && workflow?.reviewGateHistory !== null) return false;
  const createdMs = Date.parse(workflow?.createdAt || "");
  const epochMs = Date.parse(epoch);
  // An unparseable/absent createdAt is NOT evidence of age — a run that cannot
  // prove it predates the ledger does not get the ledger's exemption.
  return Number.isFinite(createdMs) && Number.isFinite(epochMs) && createdMs < epochMs;
}

/**
 * The ordered gate decisions for a gate ticket.
 *
 * Runs that predate the ledger (TEAM-3987) have no `reviewGateHistory` rows at
 * all — for those a gate ticket sitting in `done` IS the approval, stamped
 * `approvalSource: "legacy_status"` so the escalation can say so honestly.
 * Anything else carries `approvalSource: "ledger"`.
 *
 * TEAM-4099 F3: the `legacy_status` stand-in is fenced to those runs only (see
 * gateDoneWithoutLedger). On a post-epoch run a `done` gate with no APPROVE row is
 * simply no approval — which is what makes the merge it was supposed to authorize
 * a bypass.
 */
export function approvalsFor(workflow, gateTicket, { epoch = gateLedgerEpoch() } = {}) {
  const gateId = ticketIdOf(gateTicket);
  const rows = (gateId && workflow?.reviewGateHistory?.[gateId]?.decisions) || [];
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map((r) => ({ ...r, approvalSource: r.approvalSource || "ledger" }));
  }
  if (
    gateTicket &&
    String(gateTicket.status || "").toLowerCase() === "done" &&
    legacyStatusEligible(workflow, { epoch })
  ) {
    return [{
      decision: APPROVE,
      decidedAt: gateTicket.updatedAt || gateTicket.completedAt || null,
      approvalSource: "legacy_status",
    }];
  }
  return [];
}

/**
 * Per merged PR: was it approved BEFORE it merged?
 *
 *   clean    — the latest APPROVE at or before the merge is still standing (no
 *              REQUEST_CHANGES landed between that approve and the merge).
 *   deferred — no approval yet, but the merge is inside the grace window: the
 *              ledger row may still be in flight. Re-evaluated later (F10).
 *   bypass   — merged with no standing approval. Everything else.
 */
export function evaluateGateBypass({
  mergedPrs = [],
  decisions = [],
  nowMs = Date.now(),
  graceMs = GATE_BYPASS_GRACE_MS,
  // TEAM-4099 F3 — why there is no approval, when we know: `gate_done_without_ledger`
  // means the gate ticket IS `done` but nobody recorded a decision, on a run new
  // enough that its status cannot stand in for one. Provenance only; a bypass is a
  // bypass either way.
  noApprovalReason = null,
} = {}) {
  const rows = (Array.isArray(decisions) ? decisions : [])
    .map((d) => ({ ...d, ms: Date.parse(d?.decidedAt || "") }))
    .filter((d) => Number.isFinite(d.ms));
  const approvals = rows
    .filter((d) => String(d.decision || "").toUpperCase() === APPROVE)
    .sort((a, b) => a.ms - b.ms);
  const rejections = rows.filter((d) => REJECT_RE.test(String(d.decision || "")));

  return (Array.isArray(mergedPrs) ? mergedPrs : []).map((pr) => {
    const mergedMs = Date.parse(pr?.mergedAt || "");
    const base = {
      mergeCommit: pr?.mergeCommit || "",
      prUrl: pr?.prUrl || "",
      mergedAt: pr?.mergedAt || "",
      number: pr?.number,
    };
    // NaN mergedAt makes every comparison false → no approval, past grace → bypass.
    const eligible = approvals.filter((a) => a.ms <= mergedMs);
    const approve = eligible.length ? eligible[eligible.length - 1] : null;
    if (approve && !rejections.some((r) => r.ms > approve.ms && r.ms <= mergedMs)) {
      return {
        ...base,
        verdict: "clean",
        approvedAt: approve.decidedAt || null,
        approvalSource: approve.approvalSource || "ledger",
      };
    }
    if (!approve && mergedMs >= nowMs - graceMs) {
      return { ...base, verdict: "deferred", approvedAt: null, approvalSource: null };
    }
    return {
      ...base,
      verdict: "bypass",
      approvedAt: null,
      approvalSource: approve ? approve.approvalSource || "ledger" : noApprovalReason ? "none" : null,
      ...(approve ? {} : noApprovalReason ? { reason: noApprovalReason } : {}),
    };
  });
}

/**
 * Every merged PR for the given heads. `featureBranchMergeProbe` takes ONE page
 * of 20 and `.find()`s the first merged PR — fine for "did anything merge?",
 * useless here: the bypass detector must see ALL of them or it under-reports.
 *
 * `githubFetch(path)` is index.mjs's `githubApi` shape: parsed JSON, throws on
 * !ok. Any throw yields `{ error, prs: [] }` — the caller must treat that as
 * "unknown", never as "nothing merged".
 */
export async function listMergedPrsForRun(githubFetch, { owner, repo, branches = [], perPage = 100, maxPages = 5 } = {}) {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const seen = new Map();
  try {
    for (const branch of Array.isArray(branches) ? branches : []) {
      if (!branch) continue;
      for (let page = 1; page <= maxPages; page++) {
        const list = await githubFetch(
          `/repos/${o}/${r}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${branch}`)}` +
            `&per_page=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}`
        );
        const arr = Array.isArray(list) ? list : [];
        for (const pr of arr) {
          if (!pr?.merged_at || seen.has(pr.number)) continue;
          seen.set(pr.number, normalizePr(pr));
        }
        if (arr.length < perPage) break; // short page — last one
      }
    }
  } catch (err) {
    return { error: err?.message || String(err), prs: [] };
  }
  return { prs: [...seen.values()] };
}

/** `off` | `shadow` | `enforce` (default enforce; anything unrecognised coerces). */
export function gateBypassMode() {
  const raw = String(process.env.GATE_BYPASS_MODE || "").trim().toLowerCase();
  return raw === "off" || raw === "shadow" || raw === "enforce" ? raw : "enforce";
}

/**
 * GitHub's `head=` filter needs an exact ref, but agents merge from per-ticket
 * branches (`feature/<ticketId>-<agentSlug>`) whose slug the orchestrator does
 * not know. So: exact-head lookup for the run branch, plus a base-filtered sweep
 * whose heads are matched by prefix.
 */
async function collectMergedPrs(githubFetch, { owner, repo, base, featureBranch, ticketId, perPage = 100, maxPages = 3 }) {
  const byHead = await listMergedPrsForRun(githubFetch, {
    owner,
    repo,
    branches: featureBranch ? [featureBranch] : [],
  });
  if (byHead.error) return { merged: null, error: byHead.error };

  const seen = new Map(byHead.prs.map((p) => [p.number, p]));
  const prefix = ticketId ? `feature/${ticketId}-` : "";
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  try {
    for (let page = 1; page <= maxPages; page++) {
      const list = await githubFetch(
        `/repos/${o}/${r}/pulls?state=closed&base=${encodeURIComponent(base)}` +
          `&per_page=${encodeURIComponent(perPage)}&page=${encodeURIComponent(page)}`
      );
      const arr = Array.isArray(list) ? list : [];
      for (const pr of arr) {
        if (!pr?.merged_at || seen.has(pr.number)) continue;
        const ref = pr.head?.ref || "";
        if (!((prefix && ref.startsWith(prefix)) || (featureBranch && ref === featureBranch))) continue;
        seen.set(pr.number, normalizePr(pr));
      }
      if (arr.length < perPage) break;
    }
  } catch (err) {
    return { merged: null, error: err?.message || String(err) };
  }
  const merged = [...seen.values()].sort((a, b) => Date.parse(a.mergedAt || 0) - Date.parse(b.mergedAt || 0));
  return { merged };
}

/**
 * The detector. Runs on the done cascade of a NON-human ticket in a run whose
 * def declares a Merge Approval gate (F7 — scope is the def's gate, not
 * `phase === "development"`).
 *
 * enforce: `store.claimGateBypassFlag` (the CAS that stamps `gateBypassFlaggedAt`,
 *          which F8 makes un-reclaimable) and THEN, only for the caller that won
 *          it, EventBridge `workflow.gate_bypass` + task back to `in_review` +
 *          ONE `manager_escalation` notification per offending mergeCommit (F9) +
 *          a ticket comment. A caller that loses the CAS is a no-op
 *          (`alreadyFlagged`) — TEAM-4099 F2.
 * shadow:  the event only — measure before enforcing (its claim stamps the
 *          shadow-scoped fields, so shadow never trips the F8 veto).
 * off:     inert.
 *
 * Never throws: a detector that can break the cascade is worse than no detector.
 */
export async function runGateBypassCheck({ workflow, ticket, children, workflowDef, deps = {} }) {
  const {
    githubFetch,
    store,
    publishEvent,
    addTicketComment,
    gatePhaseOf,
    now = () => Date.now(),
    log = console,
    graceMs = GATE_BYPASS_GRACE_MS,
  } = deps;
  const mode = deps.mode || gateBypassMode();
  const ticketId = ticketIdOf(ticket);

  try {
    if (mode === "off") return { checked: false, reason: "mode_off" };
    if (isHuman(ticket?.assignee)) return { checked: false, reason: "human_ticket" };
    // TEAM-4099 F1/F2 — an already-flagged ticket with its escalation on record is
    // settled: a human owns it. Re-Doning it (the flag flips the task to in_review,
    // so the done-cascade dedup guard no longer short-circuits and any later "Done"
    // re-enters this path) must not re-publish the event or re-park the ticket.
    // Cheap short-circuit ahead of the GitHub calls; claimGateBypassFlag below is
    // the actual barrier for concurrent callers. The escalation half of the
    // condition matters: flagged-but-not-escalated (a flagger that died mid-way) has
    // to fall through, or nothing would ever hold the run open.
    if (mode === "enforce" && workflow?.agentTasks?.[ticketId]?.gateBypassFlaggedAt &&
        hasGateBypassEscalationFor(workflow, ticketId)) {
      return { checked: false, reason: "already_flagged", flagged: true, alreadyFlagged: true };
    }

    const found = findMergeApprovalGate(children, workflowDef, { gatePhaseOf });
    if (!found) return { checked: false, reason: "no_merge_gate" };

    const { owner, repo } = parseRepo(workflow?.repoConfig);
    if (!owner || !repo) return { checked: false, reason: "no_repo" };
    // Resolved default branch, passed by the caller (TEAM-3992 D4.1); the local
    // repoConfig read is the fallback for callers that do not resolve it.
    const base = deps.baseBranch || workflow?.repoConfig?.repos?.[0]?.defaultBranch || "main";

    const { merged, error } = await collectMergedPrs(githubFetch, {
      owner,
      repo,
      base,
      featureBranch: workflow?.featureBranch || "",
      ticketId,
    });
    if (merged === null) {
      log.warn?.(`[gate-bypass] ${workflow?.id}/${ticketId}: GitHub unreachable — no verdict (${error})`);
      return { checked: false, reason: "github_unreachable" };
    }

    const nowMs = now();
    const gateTicketId = ticketIdOf(found.ticket);
    const decisions = approvalsFor(workflow, found.ticket);
    // TEAM-4099 F3: a `done` gate on a post-epoch run with no decision row is not
    // an approval — record WHY the merge is unapproved so the escalation can say
    // "the gate is done but nobody signed it" rather than "nobody touched it".
    const noApprovalReason = gateDoneWithoutLedger(workflow, found.ticket) ? "gate_done_without_ledger" : null;
    const verdicts = evaluateGateBypass({ mergedPrs: merged, decisions, nowMs, graceMs, noApprovalReason });

    const bypassing = verdicts.filter((v) => v.verdict === "bypass");
    const deferrals = verdicts.filter((v) => v.verdict === "deferred");
    const summary = { checked: true, verdicts, bypasses: bypassing.length, deferred: deferrals.length };

    for (const v of deferrals) {
      // F10: re-checked synchronously inside completeWorkflow once the window
      // has passed, so a truly-unapproved merge can't slip out on a deferral.
      await store?.mergeTaskMetadataOrTrack?.(workflow.id, ticketId, {
        gateBypassCheckAt: new Date(nowMs + graceMs).toISOString(),
        gateBypassMergeCommit: v.mergeCommit,
      });
    }
    if (bypassing.length === 0) return summary;

    // TEAM-4099 F2 — the flag claim is the idempotency barrier for the WHOLE
    // side-effect set (event, status flip, escalation, comment), so it lands
    // FIRST, before anything observable. Scope is the ticket, not the merge
    // commit: a re-Done of an already-flagged ticket loses the CAS and returns
    // silently instead of re-publishing `workflow.gate_bypass` and re-parking a
    // ticket a human is already looking at. Shadow keeps its own (harmless)
    // stamp so measurement isn't double-counted either — see claimGateBypassFlag.
    const flaggedAt = new Date(nowMs).toISOString();
    const claim = await store?.claimGateBypassFlag?.(workflow.id, ticketId, {
      mergeCommit: bypassing[0].mergeCommit,
      flaggedAt,
      shadow: mode !== "enforce",
    });
    // A store without the fn (or a caller that injects a partial one) keeps the
    // pre-TEAM-4099 behaviour rather than silently going dark.
    const won = !claim || claim.won !== false;
    if (!won) log.log?.(`[gate-bypass] ${workflow.id}/${ticketId}: already flagged — no re-announce`);

    for (const v of bypassing) {
      if (won) {
        await publishEvent?.(ticketId, "workflow.gate_bypass", {
          workflowId: workflow.id,
          ticketId,
          mergeCommit: v.mergeCommit,
          prUrl: v.prUrl,
          mergedAt: v.mergedAt,
          gateTicketId,
          approvedAt: null,
          approvalSource: v.approvalSource,
          reason: v.reason || null,
          mode,
        });
      }
      if (mode !== "enforce") continue;

      // Once per invocation, not once per PR: the task has one status.
      if (won && v === bypassing[0]) await store.setTaskStatus(workflow.id, ticketId, "in_review");
      const message =
        `Merge without approval: PR #${v.number} (${v.prUrl || "no url"}) merged at ${v.mergedAt} ` +
        `as ${v.mergeCommit || "unknown commit"}, but the Merge Approval gate` +
        `${gateTicketId ? ` (${gateTicketId})` : ""} has no APPROVE recorded at or before that time.` +
        // TEAM-4099 F3: name the "done but unsigned" shape explicitly — a gate whose
        // board status says approved while the ledger says nobody decided is the exact
        // thing a forged transition looks like, and the human needs to hear it.
        (v.reason === "gate_done_without_ledger"
          ? ` The gate ticket is marked done, but no human decision was recorded for it — a board status is not an approval.`
          : "");
      // F1 (TEAM-4099): `type`, not `kind` — the escalations route, the Telegram
      // intake and the WM watch gate all select on `type === "manager_escalation"`,
      // so a `kind`-shaped notification was invisible and could never be acked,
      // which left `hasUnackedGateBypass` blocking completion forever.
      //
      // This runs even for a caller that LOST the claim: it is id-idempotent
      // (appendNotificationOnce stands down on a duplicate), and the escalation is
      // the thing that holds the run open — a winner that died between its claim
      // and this append would otherwise leave a flagged run with nothing to block
      // it, i.e. a green close over an unapproved merge. Nothing else re-runs.
      await store.appendNotificationOnce(workflow.id, {
        id: `notif_gate_bypass_${workflow.id}_${v.mergeCommit}`,
        type: "manager_escalation",
        title: "Merge without approval (gate bypass)",
        details: message,
        reviewer: "gate-bypass",
        timestamp: flaggedAt,
        acknowledged: false,
        ticketId,
        mergeCommit: v.mergeCommit,
        prUrl: v.prUrl,
      });
      if (won) await addTicketComment?.(ticketId, `[gate-bypass] ${message}`);
    }

    return won
      ? { ...summary, flagged: mode === "enforce" }
      : { ...summary, flagged: true, alreadyFlagged: true };
  } catch (err) {
    log.warn?.(`[gate-bypass] ${workflow?.id}/${ticketId}: check failed — ${err?.message || err}`);
    return { checked: false, reason: "error" };
  }
}

const isGateBypassNotif = (n) => typeof n?.id === "string" && n.id.startsWith("notif_gate_bypass_");

/**
 * Is this ticket's bypass already ON RECORD for a human (acked or not)? The flag
 * stamp alone is not enough: it is written first (TEAM-4099 F2), so a flagger that
 * died in between leaves a flagged task with no escalation, and it is the
 * escalation — not the stamp — that holds the run open.
 */
export function hasGateBypassEscalationFor(workflow, ticketId) {
  return (workflow?.humanNotifications || []).some((n) => isGateBypassNotif(n) && n.ticketId === ticketId);
}

/** True while any gate-bypass escalation is still un-acked (blocks a clean close). */
export function hasUnackedGateBypass(workflow) {
  return (workflow?.humanNotifications || []).some((n) => isGateBypassNotif(n) && !n.acknowledged);
}

/**
 * TEAM-4099 F1 — the ACCEPTED-bypass state.
 *
 * An unacked gate-bypass escalation holds the run open (that is the point). But
 * acking it must MEAN something: before, ack simply removed the block and the run
 * closed GREEN over a merge nobody approved, while an escalation that could never
 * be acked (the `kind`-shaped notification) deadlocked the run forever. The third
 * state is: a human saw the bypass and accepted it — the code IS merged, so the
 * run is finished, but it closes on an honest blocked outcome that names the PR,
 * never `complete`.
 */
export function ackedGateBypasses(workflow) {
  return (workflow?.humanNotifications || []).filter((n) => isGateBypassNotif(n) && n.acknowledged);
}

/** The blockReason for an accepted bypass: names the PR and the merge commit. */
export function gateBypassBlockReason(notifications = []) {
  const list = Array.isArray(notifications) ? notifications : [];
  const first = list[0] || {};
  const sha7 = String(first.mergeCommit || "").slice(0, 7) || "unknown commit";
  const pr = first.prUrl || "unknown PR";
  const more = list.length > 1 ? ` (+${list.length - 1} more merge(s))` : "";
  return `gate bypass accepted: PR ${pr} merged ${sha7} before approval${more}`;
}
