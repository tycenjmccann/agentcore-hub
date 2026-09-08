/**
 * Ship-review parking — the release manager's wait protocol, made board-visible.
 *
 * THE HOLE: on CHANGES NEEDED the release manager files `ship_fix` tickets and
 * exits without report_completion, expecting to be re-invoked once the fixes
 * land. Nothing on the board carried that expectation: the fix tickets did not
 * block the Ship ticket, so their Done never cascaded back to it, and a Ship
 * ticket left in_progress behind a finished session is exactly what the
 * dead-session detector calls dead — steal, retry, exhaust, escalation-hold,
 * run dark. Three hub SI runs (TEAM-4160 / 4243 / 4266) stalled this way; one
 * burned 14 release-manager invocations doing interim checks.
 *
 * THIS MODULE closes it at the FIX ticket's own dispatch: the moment a
 * `ship_fix` ticket is claimed, the Ship ticket it answers to is parked Blocked
 * on that fix and on every other open ship_fix sibling in the same phase. The
 * CI re-certification ticket is filed Blocked behind the fixes, so waiting for
 * its own Ready would let the release manager re-review before CI certifies
 * the head — hence "every open sibling", not just the one dispatching. From
 * there the EXISTING machinery does the rest: the unblock cascade re-Readies
 * the Ship ticket when its last blocker closes, the detector never looks at a
 * Blocked ticket, and the release manager's stale `running` claim is released
 * so the re-dispatch's claim CAS admits it.
 *
 * Resolving "the Ship ticket": `spawnedBy.shipTicketId` when the fix carries
 * its origin (FIX_TICKET_CONTRACT on stamps the `origin:` label); otherwise the
 * single non-terminal, non-fix agent ticket in the fix's phase that is not
 * itself waiting behind a human gate (the CD ticket sits behind Merge Approval
 * and is excluded by that rule). Two equally-ranked candidates = ambiguous =
 * do nothing — a wrong park is worse than today's behaviour.
 *
 * FULLY DEPENDENCY-INJECTED (no AWS clients, no process.env) and onFixReady
 * NEVER throws: it runs inside the dispatch path, which must go on to invoke
 * the fix's developer whatever happens here.
 */

export const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
export const PARK_FIX_KINDS = new Set(["ship_fix"]);
const MODES = new Set(["off", "enforce"]);

/** off | enforce. Default ENFORCE: unset/blank → enforce; "off" is the kill switch. */
export function normalizeShipFixParkMode(value) {
  if (value === undefined || value === null) return "enforce";
  const v = String(value).trim().toLowerCase();
  if (v === "") return "enforce";
  return MODES.has(v) ? v : "enforce";
}

const idOf = (t) => t?.ticketId || t?.id || t?.key || null;
const statusOf = (t) => String(t?.status || "").toLowerCase();
const isTerminal = (t) => TERMINAL_STATUSES.has(statusOf(t));
const defaultIsHuman = (a) => typeof a === "string" && a.startsWith("human:");

// Which waiting posture is most likely the parked reviewer. in_progress first:
// that is where the release manager leaves its own ticket today.
const WAIT_RANK = { in_progress: 0, todo: 1, ready: 2, blocked: 3 };

/**
 * The reviewer ticket a fix answers to, or null.
 *   { ticket, via: "origin" | "phase" }
 */
export function resolveReviewerTicket({ fixTicket, siblings, getAgentPhase, isHumanAssignee } = {}) {
  const fixId = idOf(fixTicket);
  const kids = (Array.isArray(siblings) ? siblings : []).filter(
    (t) => t && t.type !== "epic" && idOf(t) && idOf(t) !== fixId
  );
  const originId = fixTicket?.spawnedBy?.shipTicketId;
  if (originId) {
    const found = kids.find((t) => idOf(t) === originId);
    if (found) return { ticket: found, via: "origin" };
  }
  const phase = fixTicket?.phase;
  if (!phase) return null;
  const isHuman = typeof isHumanAssignee === "function" ? isHumanAssignee : defaultIsHuman;
  const humanIds = new Set(kids.filter((t) => isHuman(t.assignee)).map(idOf));
  const candidates = kids.filter(
    (t) =>
      t.assignee &&
      !isHuman(t.assignee) &&
      !t.spawnedBy?.kind &&
      getAgentPhase?.(t.assignee) === phase &&
      !isTerminal(t) &&
      !(t.blockedBy || []).some((b) => humanIds.has(b))
  );
  if (candidates.length === 0) return null;
  const rank = (t) => WAIT_RANK[statusOf(t)] ?? 9;
  candidates.sort((a, b) => rank(a) - rank(b));
  if (candidates.length > 1 && rank(candidates[0]) === rank(candidates[1])) return null;
  return { ticket: candidates[0], via: "phase" };
}

/**
 * Every OTHER open ship_fix sibling the reviewer must also wait on (same phase,
 * same origin when both sides know it). Excludes the reviewer and the fix itself.
 */
export function openFixSiblings({ reviewerId, fixTicket, siblings } = {}) {
  const fixId = idOf(fixTicket);
  const phase = fixTicket?.phase;
  return (Array.isArray(siblings) ? siblings : [])
    .filter((t) => {
      const id = idOf(t);
      if (!t || !id || id === reviewerId || id === fixId) return false;
      const kind = t.spawnedBy?.kind;
      if (!kind || !PARK_FIX_KINDS.has(kind)) return false;
      if (phase && t.phase && t.phase !== phase) return false;
      const origin = t.spawnedBy?.shipTicketId;
      if (origin && origin !== reviewerId) return false;
      return !isTerminal(t);
    })
    .map(idOf);
}

/**
 * @param deps.getChildTickets  (parentId) → sibling tickets (mapped shape)
 * @param deps.addBlockers      (ticketId, ids) → ids added; parks Blocked (index.mjs addBlockers)
 * @param deps.releaseClaim     (workflowId, ticketId) → releases the reviewer's stale claim
 * @param deps.publishEvent     (ticketId, type, detail)
 * @param deps.getAgentPhase    (assignee) → phase
 * @param deps.isHumanAssignee  (assignee) → boolean
 */
export function createShipFixPark(deps = {}) {
  const {
    mode = "enforce",
    getChildTickets,
    addBlockers,
    releaseClaim,
    publishEvent,
    getAgentPhase,
    isHumanAssignee,
    log = console,
  } = deps;

  async function onFixReady({ workflow, fixTicket, siblings = null } = {}) {
    try {
      if (mode === "off") return { action: "skip", reason: "mode-off" };
      const kind = fixTicket?.spawnedBy?.kind;
      if (!kind || !PARK_FIX_KINDS.has(kind)) return { action: "skip", reason: "not-ship-fix" };
      const fixId = idOf(fixTicket);
      const parentId = fixTicket?.parentId || workflow?.epicId;
      const kids = siblings || (parentId ? await getChildTickets(parentId) : []);

      const resolved = resolveReviewerTicket({ fixTicket, siblings: kids, getAgentPhase, isHumanAssignee });
      if (!resolved) {
        log.log?.(`[orchestrator] ship-fix-park: ${fixId} — no unambiguous reviewer ticket to park, skipping`);
        return { action: "skip", reason: "no-reviewer" };
      }
      const reviewer = resolved.ticket;
      const reviewerId = idOf(reviewer);
      if (isTerminal(reviewer)) return { action: "skip", reason: "reviewer-terminal", reviewerId };

      const wanted = [...new Set([fixId, ...openFixSiblings({ reviewerId, fixTicket, siblings: kids })])].filter(Boolean);
      // addBlockers is idempotent per edge (Jira dedupes the link; DDB CCFE) and
      // re-asserts Blocked — so a reviewer already linked but still in_progress
      // gets parked all the same.
      const added = await addBlockers(reviewerId, wanted);
      let claimReleased = false;
      try {
        await releaseClaim(workflow?.id, reviewerId);
        claimReleased = true;
      } catch (err) {
        log.warn?.(`[orchestrator] ship-fix-park: claim release for ${reviewerId} failed (non-fatal): ${err?.message || err}`);
      }
      log.log?.(
        `[orchestrator] ship-fix-park: ${reviewerId} parked Blocked on [${wanted.join(", ")}] (via ${resolved.via}, added=${(added || []).length}, fix=${fixId}, claimReleased=${claimReleased})`
      );
      try {
        await publishEvent?.(reviewerId, "orchestrator.ship_review_parked", {
          ticketId: reviewerId,
          workflowId: workflow?.id,
          fixTicketId: fixId,
          blockers: wanted,
          added: added || [],
          via: resolved.via,
          claimReleased,
        });
      } catch (err) {
        log.warn?.(`[orchestrator] ship-fix-park: event publish failed (non-fatal): ${err?.message || err}`);
      }
      return { action: "parked", reviewerId, via: resolved.via, blockers: wanted, added: added || [], claimReleased };
    } catch (err) {
      log.warn?.(`[orchestrator] ship-fix-park failed (non-fatal): ${err?.message || err}`);
      return { action: "error", error: err?.message || String(err) };
    }
  }

  return { onFixReady };
}
