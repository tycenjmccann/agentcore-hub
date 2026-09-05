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
 * The ordered gate decisions for a gate ticket.
 *
 * Runs that predate the ledger (TEAM-3987) have no `reviewGateHistory` rows at
 * all — for those a gate ticket sitting in `done` IS the approval, stamped
 * `approvalSource: "legacy_status"` so the escalation can say so honestly.
 * Anything else carries `approvalSource: "ledger"`.
 */
export function approvalsFor(workflow, gateTicket) {
  const gateId = ticketIdOf(gateTicket);
  const rows = (gateId && workflow?.reviewGateHistory?.[gateId]?.decisions) || [];
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map((r) => ({ ...r, approvalSource: r.approvalSource || "ledger" }));
  }
  if (gateTicket && String(gateTicket.status || "").toLowerCase() === "done") {
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
export function evaluateGateBypass({ mergedPrs = [], decisions = [], nowMs = Date.now(), graceMs = GATE_BYPASS_GRACE_MS } = {}) {
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
      approvalSource: approve ? approve.approvalSource || "ledger" : null,
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
 * enforce: EventBridge `workflow.gate_bypass` + task back to `in_review` +
 *          `gateBypassFlaggedAt` (which F8 makes un-reclaimable) + ONE
 *          `manager_escalation` notification per offending mergeCommit (F9) +
 *          a ticket comment.
 * shadow:  the event only — measure before enforcing.
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

    const found = findMergeApprovalGate(children, workflowDef, { gatePhaseOf });
    if (!found) return { checked: false, reason: "no_merge_gate" };

    const { owner, repo } = parseRepo(workflow?.repoConfig);
    if (!owner || !repo) return { checked: false, reason: "no_repo" };
    const base = workflow?.repoConfig?.repos?.[0]?.defaultBranch || "main";

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
    const verdicts = evaluateGateBypass({ mergedPrs: merged, decisions, nowMs, graceMs });

    let bypasses = 0;
    let deferred = 0;
    for (const v of verdicts) {
      if (v.verdict === "clean") continue;

      if (v.verdict === "deferred") {
        deferred++;
        // F10: re-checked synchronously inside completeWorkflow once the window
        // has passed, so a truly-unapproved merge can't slip out on a deferral.
        await store?.mergeTaskMetadataOrTrack?.(workflow.id, ticketId, {
          gateBypassCheckAt: new Date(nowMs + graceMs).toISOString(),
          gateBypassMergeCommit: v.mergeCommit,
        });
        continue;
      }

      bypasses++;
      await publishEvent?.(ticketId, "workflow.gate_bypass", {
        workflowId: workflow.id,
        ticketId,
        mergeCommit: v.mergeCommit,
        prUrl: v.prUrl,
        mergedAt: v.mergedAt,
        gateTicketId,
        approvedAt: null,
        approvalSource: v.approvalSource,
        mode,
      });
      if (mode !== "enforce") continue;

      const flaggedAt = new Date(nowMs).toISOString();
      await store.setTaskStatus(workflow.id, ticketId, "in_review");
      await store.mergeTaskMetadataOrTrack(workflow.id, ticketId, {
        gateBypassFlaggedAt: flaggedAt,
        gateBypassMergeCommit: v.mergeCommit,
      });
      const message =
        `Merge without approval: PR #${v.number} (${v.prUrl || "no url"}) merged at ${v.mergedAt} ` +
        `as ${v.mergeCommit || "unknown commit"}, but the Merge Approval gate` +
        `${gateTicketId ? ` (${gateTicketId})` : ""} has no APPROVE recorded at or before that time.`;
      await store.appendNotificationOnce(workflow.id, {
        id: `notif_gate_bypass_${workflow.id}_${v.mergeCommit}`,
        kind: "manager_escalation",
        ticketId,
        mergeCommit: v.mergeCommit,
        prUrl: v.prUrl,
        message,
        createdAt: flaggedAt,
      });
      await addTicketComment?.(ticketId, `[gate-bypass] ${message}`);
    }

    return { checked: true, verdicts, bypasses, deferred };
  } catch (err) {
    log.warn?.(`[gate-bypass] ${workflow?.id}/${ticketId}: check failed — ${err?.message || err}`);
    return { checked: false, reason: "error" };
  }
}

/** True while any gate-bypass escalation is still un-acked (blocks a clean close). */
export function hasUnackedGateBypass(workflow) {
  return (workflow?.humanNotifications || []).some(
    (n) => typeof n?.id === "string" && n.id.startsWith("notif_gate_bypass_") && !n.acknowledged
  );
}
