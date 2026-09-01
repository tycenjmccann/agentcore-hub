/**
 * Review-gate round cap enforcement — TEAM-3619 D2c.
 *
 * A human who keeps clicking "request changes" on a review gate re-opens the
 * upstream agent tickets every time, and nothing ever stopped that loop: the
 * rework cycle could run forever, burning agent invocations on a diff that is
 * not converging. This module is the stop.
 *
 * It owns four things and nothing else:
 *   1. resolving the gate's cap config (the .mjs twin of resolveReviewGateCap
 *      in src/lib/workflow/workflow-defs.ts),
 *   2. recording one round per rejection cycle into the gate's history,
 *   3. deciding — via ship-review.mjs's effectiveRoundCount, the hand-port of
 *      the arithmetic the release-manager blueprint also follows — whether this
 *      cycle is still under the cap (rework proceeds) or has hit it (escalate
 *      to a human and STOP the loop),
 *   4. honoring the human's way back OUT of an escalation: an explicit
 *      `DECISION: continue` resets the count. Approving the gate is the other
 *      exit and needs no code here — the cap only ever suppresses the automatic
 *      re-open, never a human's own transition.
 *
 * Every effect is injected (store / event publisher / roster lookup / gate
 * parking / metric emitter / clock), so the decision logic is unit-testable
 * with stubs — same DI shape as cascade.mjs and dead-session-detector.mjs.
 *
 * WHERE THE LEDGER LIVES: on the workflow row, under
 * `reviewGateHistory[gateTicketId] = { rounds, authorizations, escalations }`,
 * written only through workflow-store.mjs (R2 — the store is the sole
 * workflows-table writer). This is the ORCHESTRATOR's ledger of what it
 * observed. It is deliberately NOT the same artifact as the release manager's
 * own `ship-review-state.json` in S3: that one is written by the agent and
 * carries structured per-file findings this Lambda never sees. The two agree on
 * the arithmetic (same ported function) but not on finding granularity — see
 * fingerprintFinding below.
 */

import { effectiveRoundCount } from "./ship-review.mjs";

/** Defaults for the convergence-cap fields of a ReviewGate. Keep in sync with
 * REVIEW_GATE_CAP_DEFAULTS in src/lib/workflow/workflow-defs.ts. */
export const REVIEW_GATE_CAP_DEFAULTS = {
  maxRounds: 3,
  regressionCountsDouble: true,
  onCapReached: "escalate",
};

/**
 * Resolve a review gate's convergence-cap settings, applying the defaults
 * (3 / true / "escalate"). The .mjs twin of resolveReviewGateCap in
 * src/lib/workflow/workflow-defs.ts — same fallback rules, including the
 * "only honor a finite maxRounds >= 1" guard, so a hand-edited workflows.json
 * cannot produce a cap that fires on round 1 or never fires at all.
 */
export function resolveReviewGateCap(gate) {
  const raw = gate?.maxRounds;
  const maxRounds =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 1
      ? Math.floor(raw)
      : REVIEW_GATE_CAP_DEFAULTS.maxRounds;
  return {
    maxRounds,
    regressionCountsDouble:
      gate?.regressionCountsDouble ?? REVIEW_GATE_CAP_DEFAULTS.regressionCountsDouble,
    onCapReached: gate?.onCapReached ?? REVIEW_GATE_CAP_DEFAULTS.onCapReached,
  };
}

/**
 * Stable 32-bit FNV-1a hash of a string, hex. Deliberately not crypto: this
 * only has to be deterministic across invocations so the same complaint about
 * the same ticket fingerprints identically two rounds apart.
 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Fingerprint one finding as the orchestrator can see it.
 *
 * The release-manager agent fingerprints findings by file/seam because it has
 * the diff. This Lambda has only what a human rejection carries: the gate's
 * feedback comment and which upstream tickets are being reworked. So a finding
 * here is "(this ticket, this complaint)", with the comment normalized so
 * whitespace and case churn don't fork the fingerprint.
 *
 * Consequence, and it is the SAFE direction: if the reviewer rewords the same
 * complaint each round, the fingerprints differ and the reappearance is not
 * seen as a regression, so the round weighs 1 instead of 2 and the cap trips
 * LATER — never earlier. An under-detected regression delays escalation; it
 * never escalates a healthy run.
 */
export function fingerprintFinding(ticketId, feedback) {
  const normalized = String(feedback || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `${ticketId || "gate"}:${hash32(normalized)}`;
}

/**
 * The gate's still-open cap escalation, or null.
 *
 * "Open" is derived, not stored: an escalation is resolved when an
 * authorization records `forEscalationAtRound` equal to its round. Deriving it
 * means the escalations list is strictly append-only — no read-modify-write to
 * flip a flag inside a DynamoDB list, which is the clobber class R2 exists to
 * prevent. The `decision == null` check is kept as well so an entry closed in
 * place (by a future writer, or by hand) also reads as resolved.
 */
export function openEscalation(ledger) {
  const escalations = Array.isArray(ledger?.escalations) ? ledger.escalations : [];
  const auths = Array.isArray(ledger?.authorizations) ? ledger.authorizations : [];
  const resolved = new Set(
    auths.map((a) => a?.forEscalationAtRound).filter((v) => typeof v === "number")
  );
  const open = escalations.filter(
    (e) => e && e.decision == null && !resolved.has(e.escalatedAtRound)
  );
  return open.length ? open[open.length - 1] : null;
}

const DECISIONS = ["continue", "merge-with-known-findings", "cancel"];

/**
 * Parse a human DECISION out of gate feedback, FAIL-CLOSED (TEAM-3595 /
 * 40d6dcc): only an explicit, well-formed line authorizes anything. Returns the
 * decision string, or null for missing/malformed/ambiguous input — a bare
 * "looks fine, keep going" is NOT authorization, and this function must never
 * default to "continue".
 *
 * Same syntax the release-manager blueprint tells the human to use ("After the
 * escalation gate"): the LAST line that is nothing but `DECISION: <option>`,
 * case-insensitive. Markdown noise a human or Jira renderer adds around it
 * (list bullet, blockquote, bold, trailing period) is tolerated; anything else
 * on the line is not, because a DECISION buried in a sentence is as likely to
 * be a quote of the options as an instruction.
 */
export function parseDecision(text) {
  const line = /^[\s>*-]*(?:\*\*)?\s*decision\s*:\s*([a-z][a-z-]*)\s*(?:\*\*)?\s*\.?\s*$/i;
  let found = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    const candidate = m[1].toLowerCase();
    if (DECISIONS.includes(candidate)) found = candidate; // last one wins
  }
  return found;
}

/** Rounds deduped by round number (last entry per round wins) and sorted
 * ascending — the same dedupe effectiveRoundCount applies internally, needed
 * here to identify "the immediately preceding round". */
function dedupedSortedRounds(rounds) {
  const byRound = new Map();
  for (const r of Array.isArray(rounds) ? rounds : []) {
    if (r && typeof r.round === "number") byRound.set(r.round, r);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

const fingerprintsOf = (round) =>
  new Set(
    (Array.isArray(round?.findings) ? round.findings : [])
      .map((f) => f?.fingerprint)
      .filter(Boolean)
  );

/**
 * Build this rejection cycle's round record.
 *
 * Round numbering follows the blueprint rule (release-manager.md Step 4.1): a
 * re-run of the SAME reviewed head SHA reuses that round's number; any new SHA
 * is a new round. Because the store append is append-only, a reused number
 * lands as a duplicate entry — harmless, because effectiveRoundCount dedupes by
 * round number keeping the last. That is exactly why the TEAM-3546 dedupe
 * exists.
 *
 * The same-SHA check requires BOTH SHAs to be non-empty. Without that guard a
 * provider that supplies no SHA (DynamoDB mode, or a gate with no PR) would
 * compare null === null, reuse round 1 forever, and the cap would never trip.
 *
 * A finding is marked as a REGRESSION when its fingerprint appeared in some
 * earlier round but was ABSENT from the immediately preceding one — i.e. it was
 * fixed and has come back, which is the "passed in round N-1, failing again
 * now" rule the cap's double-weighting is for.
 */
export function buildRoundRecord({ priorRounds, upstreamIds, feedback, reviewedHeadSha, nowIso }) {
  const prior = dedupedSortedRounds(priorRounds);
  const latest = prior[prior.length - 1];
  const sameSha =
    !!reviewedHeadSha && !!latest?.reviewedHeadSha && latest.reviewedHeadSha === reviewedHeadSha;
  const round = latest ? (sameSha ? latest.round : latest.round + 1) : 1;

  // "Passed in the previous round" = absent from the previous round's findings.
  const previous = sameSha ? prior[prior.length - 2] : latest;
  const previousFps = fingerprintsOf(previous);
  const earlierFps = new Map(); // fingerprint → the round it last appeared in
  for (const r of prior) {
    if (previous && r.round === previous.round) continue;
    for (const fp of fingerprintsOf(r)) earlierFps.set(fp, r.round);
  }

  const ids = Array.isArray(upstreamIds) && upstreamIds.length ? upstreamIds : [null];
  const findings = ids.map((ticketId) => {
    const fingerprint = fingerprintFinding(ticketId, feedback);
    const finding = { fingerprint, ...(ticketId ? { ticketId } : {}) };
    if (earlierFps.has(fingerprint) && !previousFps.has(fingerprint)) {
      // Mirrors the blueprint's regressionOf shape. Presence (not the contents)
      // is what effectiveRoundCount weighs.
      finding.regressionOf = { round: earlierFps.get(fingerprint), fingerprint };
    }
    return finding;
  });

  return {
    round,
    reviewedHeadSha: reviewedHeadSha || null,
    verdict: "CHANGES-NEEDED",
    findings,
    recordedAt: nowIso,
  };
}

/**
 * Emit the cap decision as a single EMF record (AgentCoreHub/Orchestrator) —
 * same emitter shape as the detector's emitMetrics and cascade's
 * emitCascadeMetrics. Emitted on EVERY rejection cycle, with an explicit 0 when
 * the cycle stayed under the cap, so "no escalations" is distinguishable from
 * "enforcement never ran".
 */
export function emitReviewCapMetrics(m) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [[]],
        Metrics: [
          { Name: "ReviewCapEscalations", Unit: "Count" },
          { Name: "ReviewEffectiveRounds", Unit: "Count" },
          { Name: "ReviewRegressionRounds", Unit: "Count" },
        ],
      }],
    },
    ReviewGateTicket: m.gateTicketId,
    ReviewGatePhase: m.afterPhase || "unknown",
    ReviewCapEscalations: m.escalated ? 1 : 0,
    ReviewEffectiveRounds: m.effectiveRounds,
    ReviewRegressionRounds: m.regressionRounds,
    ReviewMaxRounds: m.maxRounds,
  }));
}

export function createReviewCap(deps) {
  const {
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate = async () => false,
    emitMetrics = emitReviewCapMetrics,
    now = () => new Date(),
    log = () => {},
  } = deps;

  /**
   * Pick the human who owns the escalation, using the gate's existing fallback
   * chain: reviewerRole roster → gate.assignee → "human:reviewer" (the same
   * chain buildAgentContext offers the intake agent). The orchestrator has to
   * pick deterministically where the intake agent gets to choose, so it takes
   * the first roster entry.
   */
  async function resolveEscalationAssignee(gateCfg) {
    try {
      const reviewers = (await listReviewers(gateCfg?.reviewerRole)) || [];
      const first = reviewers[0];
      if (first && (first.email || first.accountId)) {
        return `human:${first.email || first.accountId}`;
      }
    } catch (err) {
      log(`[review-cap] roster lookup failed, falling back to config: ${err.message}`);
    }
    return gateCfg?.assignee || "human:reviewer";
  }

  /**
   * If a cap escalation is open, an explicit `DECISION: continue` in THIS
   * rejection's feedback is the human's override: it authorizes another
   * maxRounds of rework, resetting the count from the escalated round (the same
   * contract as the release manager's escalation gate). Anything else — no
   * DECISION line, a malformed one, or merge-with-known-findings / cancel —
   * authorizes nothing and leaves the gate escalated.
   *
   * merge-with-known-findings and cancel are deliberately NOT actioned here:
   * merging is the release manager's job and cancelling is the workflow's, and
   * both are reached by the human resolving this gate normally (approve → the
   * ship flow continues) rather than by re-rejecting it.
   */
  async function authorizeIfDecided({ workflow, gateTicketId, ledger, feedback }) {
    const open = openEscalation(ledger);
    if (!open) return null;
    const decision = parseDecision(feedback);
    if (decision !== "continue") {
      log(
        `[review-cap] ${gateTicketId}: escalation from round ${open.escalatedAtRound} still open ` +
          `(DECISION ${decision ? `"${decision}" is not an override` : "missing or malformed"}) — staying escalated.`
      );
      return null;
    }
    const authorization = {
      decision: "continue",
      // The next round is escalatedAtRound + 1, so resetting AT the escalated
      // round makes that next round the first of the new allowance.
      resetAtRound: open.escalatedAtRound,
      forEscalationAtRound: open.escalatedAtRound,
      decidedAt: now().toISOString(),
      source: gateTicketId,
    };
    await store.appendReviewAuthorization(workflow.id, gateTicketId, authorization);
    await publishEvent(gateTicketId, "review.cap_authorized", {
      workflowId: workflow.id,
      gateTicketId,
      decision: "continue",
      resetAtRound: authorization.resetAtRound,
    });
    log(
      `[review-cap] ${gateTicketId}: human authorized DECISION: continue — count resets at round ${authorization.resetAtRound}.`
    );
    return authorization;
  }

  /**
   * Record this rejection cycle and decide whether the rework loop may run.
   *
   * Returns `{ escalated }` — the caller MUST skip its re-open loop when
   * `escalated` is true. Everything else in the return value is for logging and
   * tests.
   *
   * Fails OPEN on an unexpected error: if the ledger write or the arithmetic
   * blows up we let the rework proceed rather than wedging every review gate in
   * the fleet on a bug in the cap. The cap is a safety rail, not a gate of
   * record — the release manager's own escalation (blueprint Step 4) is the
   * belt to this suspenders.
   */
  async function enforce({ workflow, gateTicket, gateCfg, upstreamIds, feedback, reviewedHeadSha }) {
    const cap = resolveReviewGateCap(gateCfg);
    const gateTicketId = gateTicket.ticketId;
    const afterPhase = gateCfg?.afterPhase;

    let history;
    let round;
    let authorization = null;
    try {
      const ledger = workflow?.reviewGateHistory?.[gateTicketId] || null;
      // Before recording anything: a pending escalation the human just
      // authorized has to reset the count, or this cycle would re-trip the cap
      // it was just released from.
      authorization = await authorizeIfDecided({ workflow, gateTicketId, ledger, feedback });
      round = buildRoundRecord({
        priorRounds: ledger?.rounds || [],
        upstreamIds,
        feedback,
        reviewedHeadSha,
        nowIso: now().toISOString(),
      });
      // The append RETURNS the post-write history, so the count is computed
      // from what actually landed rather than from the possibly-stale snapshot
      // this invocation read — two concurrent rejection cycles both see their
      // own round included.
      history = await store.appendReviewRound(workflow.id, gateTicketId, round);
    } catch (err) {
      log(`[review-cap] ledger write failed for ${gateTicketId} — allowing rework: ${err.message}`);
      return { escalated: false, error: err.message };
    }

    const rounds = history?.rounds?.length ? history.rounds : [round];
    const authorizations = history?.authorizations || [];
    const effectiveRounds = effectiveRoundCount(rounds, authorizations, {
      regressionCountsDouble: cap.regressionCountsDouble,
    });
    const regressionRounds = dedupedSortedRounds(rounds).filter(
      (r) => Array.isArray(r.findings) && r.findings.some((f) => f?.regressionOf != null)
    ).length;

    const escalated = effectiveRounds >= cap.maxRounds;
    emitMetrics({
      gateTicketId,
      afterPhase,
      escalated,
      effectiveRounds,
      regressionRounds,
      maxRounds: cap.maxRounds,
    });

    if (!escalated) {
      log(
        `[review-cap] ${gateTicketId} round ${round.round}: effective ${effectiveRounds}/${cap.maxRounds} — rework proceeds.`
      );
      return { escalated: false, effectiveRounds, maxRounds: cap.maxRounds, round, authorization };
    }

    if (cap.onCapReached !== "escalate") {
      // Only "escalate" is defined. An unknown value still stops the loop —
      // stopping is the safe direction for an unrecognized policy.
      log(
        `[review-cap] ${gateTicketId}: unknown onCapReached "${cap.onCapReached}" — escalating anyway.`
      );
    }

    // Idempotency: an escalation already open for this gate means a previous
    // cycle escalated and no human decision has landed yet. Re-park the gate
    // (the rejection just moved it to blocked) but do not re-publish the event
    // or re-append the escalation record.
    const alreadyOpen = !!openEscalation(history);
    const lastFindings = round.findings;

    if (!alreadyOpen) {
      await publishEvent(gateTicketId, "review.cap_reached", {
        workflowId: workflow.id,
        gateTicketId,
        afterPhase,
        effectiveRounds,
        maxRounds: cap.maxRounds,
        lastFindings,
      });
    }

    const assignee = await resolveEscalationAssignee(gateCfg);
    // Leave the gate in_review owned by a human: the rejection had moved it to
    // blocked, and the human decision is now the ONLY exit from the loop.
    await parkGateForHuman(gateTicketId, assignee, workflow);

    if (!alreadyOpen) {
      // Put the exit instructions where the decision is made. Without this the
      // human sees a gate that stopped responding to "request changes" and no
      // statement of what does work. Best-effort — the escalation is already
      // recorded and parked, so a comment failure must not undo it.
      try {
        await commentOnGate(
          gateTicketId,
          `Review round cap reached: ${effectiveRounds} effective rework rounds of a maximum of ` +
            `${cap.maxRounds} (a round that regressed an earlier fix counts double). ` +
            `Requesting changes again will NOT re-open the upstream work — this gate is now the only exit.\n\n` +
            `Choose one:\n` +
            `- Approve this gate (transition it to Done) to accept the change set as it stands.\n` +
            `- To authorize another ${cap.maxRounds} rounds of rework, request changes again with a line ` +
            `containing exactly "DECISION: continue" (nothing else on that line).\n` +
            `- Cancel the workflow if the change set should be abandoned.\n\n` +
            `Anything else is treated as no authorization: the gate stays here.`
        );
      } catch (err) {
        log(`[review-cap] could not comment on ${gateTicketId}: ${err.message}`);
      }
    }

    if (!alreadyOpen) {
      try {
        await store.appendReviewCapEscalation(workflow.id, gateTicketId, {
          escalatedAtRound: round.round,
          effectiveRounds,
          maxRounds: cap.maxRounds,
          assignee,
          createdAt: now().toISOString(),
          decision: null,
        });
      } catch (err) {
        // The event fired and the gate is parked; losing the audit record is
        // not worth failing the escalation over.
        log(`[review-cap] could not record escalation for ${gateTicketId}: ${err.message}`);
      }
    }

    log(
      `[review-cap] ${gateTicketId} HIT THE CAP: effective ${effectiveRounds} >= ${cap.maxRounds} ` +
        `— rework loop stopped, escalated to ${assignee}${alreadyOpen ? " (already open)" : ""}.`
    );
    return {
      escalated: true,
      effectiveRounds,
      maxRounds: cap.maxRounds,
      round,
      assignee,
      alreadyOpen,
      authorization,
    };
  }

  return { enforce, resolveEscalationAssignee };
}
