import { normalizeExtendedMode } from "./cascade.mjs";

/**
 * TEAM-4110 — merge-on-green. A human-approved, clean+green final PR is never
 * merged automatically today: the RM's CD ticket couples the merge to a deploy
 * target and BLOCKS (no merge) when there is none, and SHIP_MERGE_VERIFY only
 * PROVES the branch unmerged (emits workflow.cd_unmerged + returns) — it never
 * performs the merge. No consumer of cd_unmerged exists, so the run sits
 * green-but-unmerged forever (the juno #501 symptom).
 *
 * This module finishes the human's decision from the one always-running,
 * idempotent place that already holds GITHUB_PAT and already probes merge state
 * every completion attempt (featureBranchMergeProbe). It fires ONLY after the
 * human "Merge Approval" gate is done, ONLY when GitHub reports the PR
 * mergeable_state:"clean", and merges with the exact head SHA so a moved head
 * (or an RM racing `gh pr merge`) makes GitHub refuse — never a force merge.
 * Merge is decoupled from deploy: it lands on approval+green; the RM CD ticket
 * keeps owning deploy and may still BLOCK/hand-off without holding the PR hostage.
 *
 * off | shadow | enforce, default off. off is byte-identical to pre-4110: the
 * caller's cd_unmerged + return path is unchanged. Normalized exactly like
 * CASCADE_EXTENDED_STATES (reused normalizeExtendedMode): an unrecognized value
 * fails SAFE to shadow — observe-only, never an accidental merge.
 */

const REFUSAL_STATUSES = new Set([405, 409, 422]);

/** The run's human Merge-Approval gate: human:* assignee + a "Merge Approval" title. */
function findMergeApprovalGate(children) {
  return (
    (children || []).find(
      (t) =>
        typeof t?.assignee === "string" &&
        t.assignee.startsWith("human:") &&
        typeof t?.title === "string" &&
        /merge approval/i.test(t.title)
    ) || null
  );
}

/**
 * The SHA the human approved. Prefer the gate's own recorded head; else the
 * run's ship-phase task head — but ONLY when it is unambiguous (exactly one
 * distinct SHA across ship-phase task entries). Ambiguous/absent → null, which
 * makes head-drift un-checkable, so we fall back to GitHub's own `sha`-param
 * guard on the merge PUT (a moved head fails the merge regardless).
 */
function resolveGateApprovedSha(workflow, gateTicket, getAgentPhase) {
  const direct = gateTicket?.reviewedHeadSha || gateTicket?.metadata?.headSha;
  if (typeof direct === "string" && direct) return direct;
  const tasks = workflow?.agentTasks || {};
  const shipShas = new Set();
  for (const e of Object.values(tasks)) {
    if (!e) continue;
    if (getAgentPhase?.(e.agentId) === "ship") {
      const sha = e.commitSha || e.mergeCommit;
      if (typeof sha === "string" && sha) shipShas.add(sha);
    }
  }
  return shipShas.size === 1 ? [...shipShas][0] : null;
}

export function createMergeOnGreen(deps) {
  const {
    githubApi,
    getChildTickets,
    parseRepoUrl,
    publishEvent = async () => {},
    getAgentPhase = () => undefined,
    log = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    mergeMethod = "squash",
    // GitHub computes `mergeable`/`mergeable_state` async — a fresh PR read can
    // return "unknown". Bounded re-poll so a still-computing PR is not misread as
    // not-mergeable; capped so a pathological PR can't spin the Lambda.
    mergeablePollMs = 800,
    mergeablePolls = 5,
  } = deps;
  const mode = normalizeExtendedMode(deps.mode);

  function emitMetrics(counter) {
    const m = {
      merged: 0, wouldMerge: 0, refused: 0,
      gateNotApproved: 0, notMergeable: 0, headDrift: 0,
    };
    if (counter) m[counter] = 1;
    console.log(JSON.stringify({
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: "AgentCoreHub/Orchestrator",
          Dimensions: [[]],
          Metrics: [
            { Name: "MergeOnGreenMerged", Unit: "Count" },
            { Name: "MergeOnGreenWouldMerge", Unit: "Count" },
            { Name: "MergeOnGreenRefused", Unit: "Count" },
            { Name: "MergeOnGreenGateNotApproved", Unit: "Count" },
            { Name: "MergeOnGreenNotMergeable", Unit: "Count" },
            { Name: "MergeOnGreenHeadDrift", Unit: "Count" },
          ],
        }],
      },
      MergeOnGreenMerged: m.merged,
      MergeOnGreenWouldMerge: m.wouldMerge,
      MergeOnGreenRefused: m.refused,
      MergeOnGreenGateNotApproved: m.gateNotApproved,
      MergeOnGreenNotMergeable: m.notMergeable,
      MergeOnGreenHeadDrift: m.headDrift,
    }));
  }

  function finish(outcome, counter, extra = {}) {
    if (counter) emitMetrics(counter);
    return { outcome, ...extra };
  }

  /**
   * Called from completeWorkflow's `probe.merged === false` branch BEFORE
   * cd_unmerged + return. Any outcome other than "merged" leaves the caller's
   * today-behavior unchanged. Never throws — merge-on-green must never turn a
   * legitimate completion into a crash.
   */
  async function mergeApprovedGreenPr(workflow, _probe) {
    if (mode === "off") return { outcome: "skip" };
    try {
      // (b) The human must have approved the Merge-Approval gate.
      const children = await getChildTickets(workflow.epicId);
      const gate = findMergeApprovalGate(children);
      if (!gate || String(gate.status).toLowerCase() !== "done") {
        log(`merge-on-green ${workflow.id}: merge-approval gate not done — not merging`);
        return finish("gate-not-approved", "gateNotApproved");
      }

      // (c) An OPEN PR for the feature branch that GitHub reports clean.
      const { owner, repo } = parseRepoUrl(workflow.repoConfig);
      const head = workflow.featureBranch;
      if (!owner || !repo || !head) return { outcome: "skip" };

      const prs = await githubApi(
        `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open&per_page=20`
      );
      let pr = Array.isArray(prs) ? prs.find((p) => p && !p.merged_at) : null;
      if (!pr) {
        log(`merge-on-green ${workflow.id}: no open PR for ${head}`);
        return { outcome: "no-open-pr" };
      }

      // The LIST endpoint (`GET /pulls?head=`) never populates `mergeable`/
      // `mergeable_state` — GitHub computes those on demand and returns them ONLY
      // on the single-PR read (`GET /pulls/{n}`). Always fetch by number first so
      // `state` is authoritative; the first single read can still be "unknown"
      // while GitHub computes, so the bounded re-poll below handles that too.
      pr = await githubApi(`/repos/${owner}/${repo}/pulls/${pr.number}`);
      let state = pr?.mergeable_state;
      for (let i = 0; state === "unknown" && i < mergeablePolls; i++) {
        await sleep(mergeablePollMs);
        pr = await githubApi(`/repos/${owner}/${repo}/pulls/${pr.number}`);
        state = pr?.mergeable_state;
      }
      if (state !== "clean") {
        log(`merge-on-green ${workflow.id}: PR #${pr?.number} mergeable_state=${state} — not merging`);
        return finish("not-mergeable", "notMergeable", { reason: state });
      }

      const headSha = pr.head?.sha;
      const approvedSha = resolveGateApprovedSha(workflow, gate, getAgentPhase);
      if (approvedSha && headSha && approvedSha !== headSha) {
        log(`merge-on-green ${workflow.id}: PR head ${headSha} != approved ${approvedSha} — not merging`);
        return finish("head-drift", "headDrift", { headSha, approvedSha });
      }

      if (mode === "shadow") {
        log(`merge-on-green ${workflow.id}: WOULD merge PR #${pr.number} (${headSha}) — shadow`);
        return finish("would-merge", "wouldMerge", { prUrl: pr.html_url, headSha });
      }

      // enforce — merge with the exact head SHA so a moved head (or an RM racing
      // `gh pr merge`) makes GitHub refuse. 405/409/422 = refused (not mergeable /
      // already merged / sha mismatch) → non-fatal, caller falls through.
      try {
        const res = await githubApi(
          `/repos/${owner}/${repo}/pulls/${pr.number}/merge`,
          "PUT",
          { merge_method: mergeMethod, sha: headSha }
        );
        const mergeCommit = res?.sha || "";
        await publishEvent(workflow.epicId, "workflow.merged_on_green", {
          workflowId: workflow.id,
          featureBranch: head,
          prUrl: pr.html_url || "",
          mergeCommit,
        });
        log(`merge-on-green ${workflow.id}: MERGED PR #${pr.number} → ${mergeCommit}`);
        return finish("merged", "merged", { mergeCommit, prUrl: pr.html_url || "" });
      } catch (err) {
        const reason = err?.githubMessage || err?.message || String(err);
        if (!REFUSAL_STATUSES.has(err?.status)) {
          log(`merge-on-green ${workflow.id}: merge PUT error (non-fatal): ${reason}`);
        }
        return finish("merge-refused", "refused", { reason });
      }
    } catch (err) {
      // Fail-open: any unexpected error leaves the caller's cd_unmerged/return
      // path intact — merge-on-green never crashes completion.
      log(`merge-on-green ${workflow.id}: skipped (${err?.message || err})`);
      return { outcome: "error", reason: err?.message || String(err) };
    }
  }

  return { mergeApprovedGreenPr, mode };
}
