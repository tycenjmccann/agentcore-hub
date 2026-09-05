/**
 * TEAM-4111 — ship-head stability gate.
 *
 * A run's ship-review acts on a LIVE, moving branch head with no stabilization:
 * this run's own fix commits, ci_agent auto-remediation (prettier/eslint/lockfile),
 * and the coding CLI's discretionary `merge origin/main` all push to the one
 * shared feature branch during the "QA & Ship" stage. Every push re-queues CI
 * (~4 check-suites) and invalidates the last green build; the RM's SHA
 * cross-check then mismatches, files a CI-rerun, and the loop chases a head that
 * never settles — mechanical instability surfaced as a mislabeled "ship-review
 * not converging" escalation, burning CI cycles and RM sessions.
 *
 * This gate decides, at ship-ticket (re)dispatch time, WHETHER the RM should be
 * invoked yet: dispatch only when the PR head has been unchanged for >= stableMs
 * AND CI is green on THAT EXACT head. Otherwise defer (re-queue) instead of
 * invoking the RM on a head that is about to move again. It never masks a real
 * failure — CI red on the head passes straight through to the normal CI-fix
 * path — and a perpetually-moving head can't starve the run (maxDeferrals
 * fail-open).
 *
 * off | shadow | enforce, default off. off is byte-identical to today: the gate
 * returns dispatch WITHOUT probing GitHub (zero I/O, zero metrics). Because the
 * only dangerous failure mode of a DISPATCH-DEFERRING gate is wedging ship, mode
 * normalization is a strict allow-list — anything not exactly off|shadow|enforce
 * (including legacy "on"/"true"/"1") fails SAFE to off (always dispatch). This is
 * deliberately the OPPOSITE fail-safe direction from merge-on-green, whose
 * dangerous failure is an accidental merge and so fails unknown → shadow.
 */

const MODES = new Set(["off", "shadow", "enforce"]);

/** Strict allow-list. Unknown (incl. legacy truthy "on"/"true"/"1") → off. */
function normalizeMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return MODES.has(v) ? v : "off";
}

export function createShipHeadGate(deps = {}) {
  const {
    githubProbe,
    now = () => Date.now(),
    // Head must have been quiet this long before the RM is invoked.
    stableMs = 3 * 60 * 1000,
    // After this many consecutive deferrals for a run, fail open so a head that
    // never stabilizes cannot starve the run forever.
    maxDeferrals = 8,
    log = () => {},
  } = deps;
  const mode = normalizeMode(deps.mode);

  function emitMetrics(counter) {
    const m = { wouldDefer: 0, deferred: 0, deadlockForced: 0, probeErrors: 0 };
    if (counter) m[counter] = 1;
    console.log(JSON.stringify({
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: "AgentCoreHub/Orchestrator",
          Dimensions: [[]],
          Metrics: [
            { Name: "ShipHeadWouldDefer", Unit: "Count" },
            { Name: "ShipHeadDeferred", Unit: "Count" },
            { Name: "ShipHeadDeadlockForced", Unit: "Count" },
            { Name: "ShipHeadProbeErrors", Unit: "Count" },
          ],
        }],
      },
      ShipHeadWouldDefer: m.wouldDefer,
      ShipHeadDeferred: m.deferred,
      ShipHeadDeadlockForced: m.deadlockForced,
      ShipHeadProbeErrors: m.probeErrors,
    }));
  }

  /**
   * Decide whether the ship ticket may dispatch now.
   *
   * Returns `{ action: "dispatch"|"defer", reason, wouldDefer, ...detail }`.
   * `wouldDefer` is the raw stability verdict (what enforce WOULD do), reported
   * in every non-off mode so shadow can measure the real defer rate before the
   * lever is flipped. The caller MUST re-queue the ship dispatch when
   * `action === "defer"` and dispatch otherwise. Never throws — a stability
   * gate that crashes the Ready path is worse than a moving head.
   *
   * The current consecutive-deferral count is read off the workflow row
   * (`shipHeadDeferrals`); the caller persists it on each defer and clears it on
   * dispatch. In shadow nothing defers, so it stays 0 and the deadlock branch is
   * inert — shadow measures the un-forced would-defer rate.
   */
  async function evaluate(workflow, gateTicket) {
    if (mode === "off") return { action: "dispatch", reason: "off", wouldDefer: false };

    let probe;
    try {
      probe = await githubProbe(workflow, gateTicket);
    } catch (err) {
      // Fail OPEN — never wedge ship on a probe failure.
      log(`ship-head ${workflow?.id}: probe error (dispatching, fail-open): ${err?.message || err}`);
      emitMetrics("probeErrors");
      return { action: "dispatch", reason: "probe-error", wouldDefer: false, error: err?.message || String(err) };
    }

    const headSha = probe?.headSha || null;
    const ci = probe?.ci || {};
    const ciOnHead = !!headSha && ci.sha === headSha;
    const green = ciOnHead && ci.conclusion === "success";
    const red = ciOnHead && ci.conclusion === "failure";

    // Missing lastHeadMoveAt (probe couldn't determine) reads as stable: we never
    // hold a run on an unknowable head — the deadlock cap bounds any residual.
    const lastMove = probe?.lastHeadMoveAt;
    const stable = lastMove == null ? true : now() - lastMove >= stableMs;

    // A real red on the head is a CI failure, not instability — hand it straight
    // to the normal CI-fix path. Priority over every defer branch.
    if (red) {
      emitMetrics();
      return { action: "dispatch", reason: "ci-red-passthrough", wouldDefer: false, headSha };
    }

    const wouldDefer = !stable || !green;
    const detail = { headSha, ciSha: ci.sha || null, ciConclusion: ci.conclusion || "none", stable, green };

    if (!wouldDefer) {
      emitMetrics();
      return { action: "dispatch", reason: "stable-green", wouldDefer: false, ...detail };
    }

    if (mode === "shadow") {
      log(`ship-head ${workflow?.id}: WOULD defer (${!stable ? "head-unstable" : "ci-not-green-on-head"}) — shadow`);
      emitMetrics("wouldDefer");
      return { action: "dispatch", reason: !stable ? "head-unstable" : "ci-not-green-on-head", wouldDefer: true, ...detail };
    }

    // enforce
    const deferrals = Number(workflow?.shipHeadDeferrals) || 0;
    if (deferrals >= maxDeferrals) {
      log(`ship-head ${workflow?.id}: ${deferrals} consecutive deferrals >= ${maxDeferrals} — forcing dispatch (deadlock fail-open)`);
      emitMetrics("deadlockForced");
      return { action: "dispatch", reason: "deadlock-forced", wouldDefer: true, deferrals, ...detail };
    }

    log(`ship-head ${workflow?.id}: deferring (${!stable ? "head-unstable" : "ci-not-green-on-head"}), deferral ${deferrals + 1}/${maxDeferrals}`);
    emitMetrics("deferred");
    return { action: "defer", reason: !stable ? "head-unstable" : "ci-not-green-on-head", wouldDefer: true, deferrals, ...detail };
  }

  return { evaluate, mode };
}

/**
 * Aggregate a commit's check-RUNS into one conclusion the gate can reason about.
 *   none    — no checks reported for this head (unknowable → gate treats as
 *             not-green; the deadlock cap bounds any resulting hold).
 *   pending — at least one run has not COMPLETED.
 *   failure — all completed but at least one is a hard-negative conclusion.
 *   success — all completed and none hard-negative (neutral/skipped count green).
 * Kept pure + exported so the aggregation is unit-tested without GitHub.
 */
const CHECK_HARD_NEGATIVE = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);
export function aggregateCheckConclusion(checkRuns) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  if (runs.length === 0) return "none";
  if (runs.some((r) => r?.status !== "completed")) return "pending";
  if (runs.some((r) => CHECK_HARD_NEGATIVE.has(r?.conclusion))) return "failure";
  return "success";
}

/**
 * Build the injected `githubProbe` the gate needs from the orchestrator's
 * `githubApi` + `parseRepoUrl`. Reads the open PR for the run's feature branch,
 * its head SHA, the head commit's committer time (→ lastHeadMoveAt), and the
 * aggregate check-runs conclusion ON that exact head. All I/O is through the
 * injected `githubApi`, so this is stub-testable. A missing repo/branch/PR
 * yields a null head — the gate reads that as "can't determine", and (since it
 * never holds a run on an unknowable head) dispatches.
 */
export function createGitHubShipHeadProbe({ githubApi, parseRepoUrl }) {
  return async function probe(workflow) {
    const { owner, repo } = parseRepoUrl(workflow?.repoConfig) || {};
    const head = workflow?.featureBranch;
    if (!owner || !repo || !head) return { headSha: null, lastHeadMoveAt: null, ci: {} };

    const prs = await githubApi(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open&per_page=20`
    );
    const pr = Array.isArray(prs) ? prs[0] : null;
    const headSha = pr?.head?.sha || null;
    if (!headSha) return { headSha: null, lastHeadMoveAt: null, ci: {} };

    const [commit, checks] = await Promise.all([
      githubApi(`/repos/${owner}/${repo}/commits/${headSha}`),
      githubApi(`/repos/${owner}/${repo}/commits/${headSha}/check-runs`),
    ]);
    const dateStr = commit?.commit?.committer?.date || commit?.commit?.author?.date || null;
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    const lastHeadMoveAt = Number.isNaN(parsed) ? null : parsed;
    return { headSha, lastHeadMoveAt, ci: { sha: headSha, conclusion: aggregateCheckConclusion(checks?.check_runs) } };
  };
}
