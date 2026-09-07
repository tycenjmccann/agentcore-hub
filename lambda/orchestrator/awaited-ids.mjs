/**
 * awaited-ids.mjs — the D1 "awaited-ids re-wake" decision module (TEAM-4166).
 *
 * PROBLEM (f50ucz / TEAM-4126): a release manager that parks its own ticket
 * `in_progress` on a sub-cap CHANGES-NEEDED, then files sibling fix tickets it
 * is waiting on, never re-wakes when those fixes close — its `blockedBy` was
 * frozen at def-time and the cascade / reconcile-sweep only re-dispatch when
 * ALL `blockedBy` are terminal. The awaited fix tickets are not in that list, so
 * nothing re-drives the parked ticket.
 *
 * DECISION (design TEAM-4165 Q2): represent an awaited id as a REAL `blockedBy`
 * edge, written through the ONE provider-aware seam (`addBlockers` /
 * applyBlockerEdge) with `preserveStatusIf: ["in_progress","in_review"]` so the
 * parked agent's status is never yanked to `blocked`. The parked ticket then
 * becomes a normal dependent: cascade.cascadeUnblock / reconcile-sweep's
 * allBlockersResolved re-drive it with ZERO predicate change. `applyBlockerEdge`
 * is idempotent ("present" on a second write), so a sweep re-run, a webhook
 * redelivery, and a tool+derived race all converge to the same edge.
 *
 * ── Why ZERO @aws-sdk imports ────────────────────────────────────────────────
 * Every effect is injected: the board write goes through the `addBlockers` seam
 * (whose DDB branch is applyBlockerEdge, whose jira branch is an issue link —
 * provider parity is the CALLER's job, this module just calls the seam), the
 * workflows-table CAS through `store` (R2), event publication through
 * `publishEvent`, ticket reads through `getTicket`. So the module loads in
 * isolation and its whole decision surface is unit-testable with plain fakes —
 * same DI shape as cascade.mjs / reconcile-sweep.mjs / dead-session-detector.mjs.
 *
 * The only imports are from the pure, zero-import fix-contract.mjs: the fix-kind
 * → origin-key table (KIND_TO_ORIGIN_KEY), the recognized kinds (FIX_KINDS), and
 * the ticket-id shape (TICKET_KEY_RE) — the same shape the fix-ticket origin ids
 * are validated against.
 *
 * Event contract — `orchestrator.await_timeout`
 * `{workflowId, ticketId, awaitingIds, waitedMs, timestamp, source, reason}`,
 * emitted at most once per ticket (store CAS) and NEVER accompanied by a
 * humanNotification (that would trip parkedOnHuman). `awaitingIds` lists only ids
 * PROVEN still non-terminal in the caller's sibling snapshot, `waitedMs` is the
 * real wait since the stamp (or the row's updatedAt), and `reason` is
 * "await_timeout" for a wait-SLA breach or "clean_exit_cap" for a ticket re-woken
 * to the clean-exit cap with nothing left awaited (empty `awaitingIds`) — TEAM-4184 F2.
 *
 * Modes (AWAITED_IDS_MODE): off (DEFAULT — this mutates ticket state, so a fresh
 * deploy changes nothing) = no-op; shadow = compute + log + EMF metrics, ZERO
 * writes; enforce = write the edge + stamp preconditionUnmet. Garbage coerces to
 * OFF (the safe default for a state-mutating flag), logged as awaited_ids.unknown_mode.
 */

import { KIND_TO_ORIGIN_KEY, FIX_KINDS, TICKET_KEY_RE } from "./fix-contract.mjs";

export const AWAITED_IDS_MODES = ["off", "shadow", "enforce"];

// The statuses whose presence keeps a parked agent's status where it is when the
// awaited edge is written (the release manager mid-run / a human gate in review).
const PRESERVE_STATUSES = ["in_progress", "in_review"];

// A blocker fan-out is capped so a buggy/hostile spawnedBy cannot append an
// unbounded edge list onto one origin (mirrors the fix-contract round cap ethos).
const MAX_AWAITED_IDS = 20;

const TERMINAL_TICKET_STATUSES = new Set(["done", "cancelled"]);

const DEFAULT_TIMEOUT_MINUTES = 120;

/** A non-empty string that looks like a ticket key (TEAM-4126). */
function isTicketId(v) {
  return typeof v === "string" && TICKET_KEY_RE.test(v.trim());
}

/**
 * off | shadow | enforce. Unset/blank → "off" (a fresh deploy changes nothing,
 * silently). A PRESENT-but-unrecognized value → "off" too, but LOUDLY
 * (awaited_ids.unknown_mode): this flag mutates ticket state (writes blocker
 * edges, stamps preconditionUnmet), so the dangerous failure direction is acting
 * on a typo'd env var — same asymmetry as SYNC_MAIN_BEFORE_CI / CI_CHECK_MODE.
 */
export function normalizeAwaitedIdsMode(v, log = (msg) => console.warn(msg)) {
  if (v === undefined || v === null) return "off";
  const s = String(v).trim().toLowerCase();
  if (s === "") return "off";
  if (AWAITED_IDS_MODES.includes(s)) return s;
  log(`awaited_ids.unknown_mode — AWAITED_IDS_MODE=${JSON.stringify(v)} is not off|shadow|enforce; coercing to OFF (state-mutating flag, fail safe)`);
  return "off";
}

/**
 * Fold one `addBlockers` seam return into { written, present, failed } counts.
 *
 * The seam is tolerated in BOTH the shapes it can answer in:
 *   - the per-id token form (index.mjs addBlockers with `detailed: true`,
 *     TEAM-4185 F5) — an array of "added"/"blocked"/"preserved" | "present" |
 *     "failed"/"error" | "skipped" (or a single such string for one id);
 *   - the LEGACY addBlockers return — an array of the ID STRINGS that were newly
 *     added, with idempotent-present ids OMITTED entirely.
 *
 * So: an explicit write/present/failed token is counted as such; a returned id
 * string that we asked for is a write; and — only when the result carried no
 * status tokens at all (i.e. it was the id-string form) — a requested id ABSENT
 * from the result is treated as the idempotent "present" no-op the legacy seam
 * signals by omission.
 *
 * TEAM-4185 F5 — `failed` is why the token form exists. The id-array shape signals
 * BOTH "already linked" and "the write blew up" by omission, so applyAwaitedEdges
 * could not tell them apart and stamped a fresh park for an edge that never
 * landed. A failed write must leave the stamp (and its clock) alone.
 */
export function tallyBlockerResult(res, requestedIds) {
  const WRITE_TOKENS = new Set(["added", "blocked", "preserved", "written"]);
  const FAIL_TOKENS = new Set(["failed", "error"]);
  const requested = new Set(requestedIds);
  const arr = Array.isArray(res) ? res : res === undefined || res === null ? [] : [res];

  let written = 0;
  let present = 0;
  let failed = 0;
  let sawToken = false;
  const writtenIds = new Set();

  for (const el of arr) {
    if (typeof el !== "string") continue;
    const norm = el.trim().toLowerCase();
    if (WRITE_TOKENS.has(norm)) { written++; sawToken = true; continue; }
    if (norm === "present") { present++; sawToken = true; continue; }
    if (FAIL_TOKENS.has(norm)) { failed++; sawToken = true; continue; }
    if (norm === "skipped") { sawToken = true; continue; }
    // Otherwise it's an id string: a write iff it is one of the ids we asked for
    // (or at least looks like a ticket id).
    if (requested.has(el.trim()) || TICKET_KEY_RE.test(el.trim())) {
      written++;
      writtenIds.add(el.trim());
    }
  }

  // The LEGACY seam shape OMITS idempotent-present ids. When the answer was purely
  // id-shaped (no tokens), any requested id we didn't see written is a present
  // no-op — the only signal that shape gives for "the edge was already there".
  // (Under `detailed: true` every id answers with a token, so this never fires and
  // a failure is never mistaken for an idempotent no-op.)
  if (!sawToken) {
    for (const id of requested) if (!writtenIds.has(id)) present++;
  }

  return { written, present, failed };
}

/**
 * PURE. The raw awaited union — preconditionUnmet.awaitingIds ∪ blockedBy, minus
 * the ticket itself — with no notion of siblings/status at all. The one place
 * the union's SHAPE is defined; both nonTerminalAwaitedIds (below) and
 * parkEvidence's no-snapshot branch build off it.
 */
function awaitedUnion(ticket) {
  const union = new Set();
  const pu = ticket?.preconditionUnmet;
  if (pu && Array.isArray(pu.awaitingIds)) for (const id of pu.awaitingIds) if (isTicketId(id)) union.add(id.trim());
  if (Array.isArray(ticket?.blockedBy)) for (const id of ticket.blockedBy) if (isTicketId(id)) union.add(id.trim());
  return [...union].filter((id) => id !== ticket?.ticketId);
}

/**
 * PURE. The awaited union restricted to ids PROVEN still non-terminal in
 * `siblings`. An id absent from the snapshot counts as non-terminal (we cannot
 * prove it closed), so a caller that has no snapshot at all must get none back:
 * a non-array `siblings` yields [] rather than "everything is open", mirroring
 * the direction cascade.unionBlockersResolved(t, undefined) already fails in
 * (resolved). checkAwaitTimeout reads it here — its no-snapshot behaviour
 * (report nothing awaited) is exactly this contract.
 *
 * parkEvidence does NOT reuse this for its own no-snapshot case (TEAM-4184): its
 * decision is escalate/don't-escalate, and "can't see the board" must fail
 * toward NOT escalating — the opposite of "nothing is open". See its own
 * docblock.
 */
export function nonTerminalAwaitedIds(ticket, siblings) {
  if (!ticket || typeof ticket !== "object") return [];
  if (!Array.isArray(siblings)) return [];
  const statusOf = (id) => {
    const s = siblings.find((x) => x && x.ticketId === id);
    return s ? s.status : undefined;
  };
  return awaitedUnion(ticket).filter((id) => !TERMINAL_TICKET_STATUSES.has(statusOf(id)));
}

/**
 * PURE. Was this preconditionUnmet stamp written by the claim generation that is
 * under inspection — i.e. is it evidence about THIS session, or a leftover from a
 * previous one?
 *
 * Fail-safe directions, both chosen to preserve the pre-TEAM-4184 behaviour when
 * the comparison cannot be made:
 *   - no parseable claimStartedAt → TRUE. We cannot prove the stamp is stale, and
 *     a legacy/odd task row must not become escalatable just because its claim
 *     lacks a timestamp.
 *   - no parseable reportedAt → FALSE. Not provably current (jira rows stamped
 *     before the precondition-at label existed land here). Those are still held
 *     by parkEvidence's other two terms, so a stamp is never judged stale on the
 *     strength of a missing clock alone.
 */
export function isStampCurrent(preconditionUnmet, claimStartedAt) {
  const claimMs = Date.parse(claimStartedAt ?? "");
  if (!Number.isFinite(claimMs)) return true;
  const stampMs = Date.parse(preconditionUnmet?.reportedAt ?? "");
  if (!Number.isFinite(stampMs)) return false;
  return stampMs >= claimMs;
}

/**
 * PURE. How long this ticket has been waiting, in ms: since the stamp's
 * `reportedAt` when it has one, else since the row's `updatedAt` (the D1 §5 SLA
 * definition). 0 when neither is parseable — an unknown wait is reported as no
 * wait rather than as an invented one — and never negative (a clock skew that puts
 * the stamp in the future is 0, not a negative "wait").
 *
 * TEAM-4184 F2: the cap path needs this WITHOUT checkAwaitTimeout, because when
 * every awaited id has already landed checkAwaitTimeout returns null (nothing is
 * awaited) and the caller still has a real wait to report.
 */
export function awaitedWaitedMs(ticket, nowMs) {
  const pu = ticket?.preconditionUnmet;
  const since = Date.parse((pu && pu.reportedAt) || ticket?.updatedAt || "");
  if (!Number.isFinite(since) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - since);
}

/**
 * PURE. THE D2 evidence predicate (TEAM-4166 §2.3, corrected by TEAM-4184 F1):
 * once a ticket's dead-session retry budget is spent, is its `preconditionUnmet`
 * stamp live evidence that the session parked itself CLEANLY on work it is
 * waiting for — in which case it gets re-woken, capped, never escalated — or is
 * it stale residue from a claim that has since been re-dispatched and died?
 *
 * The bug this replaces tested mere PRESENCE of the stamp. Because nothing ever
 * clears `preconditionUnmet`, a ticket that parked once could never again be
 * escalated: after its awaited fixes closed and it was correctly re-woken, a
 * genuinely dead re-woken session still read "parked clean" on the old stamp, so
 * it burned the clean-exit cap and then reported "awaiting" forever — no
 * escalation, no error status, no page. §2.3's timestamp rule always required an
 * UNRESOLVED stamp; this is that rule.
 *
 * Three independent reasons a stamp is still live evidence, in order (plus a
 * fourth, checked first: no sibling snapshot at all → `awaited-open` — an
 * unwired reader or a failed fetch proves nothing closed, so it is scored the
 * same as "something is still open", never falls through toward stale-stamp):
 *   awaited-open      — something in the awaited union is still non-terminal.
 *                       The ordinary "parked and waiting" case (FR-2.1), and the
 *                       one that carries a legitimate RE-park on both providers.
 *   stamp-current     — the stamp was written at/after this claim started, so it
 *                       is this session's own report (a re-park whose awaited
 *                       fixes happen to have closed already).
 *   unconsumed-stamp  — no clean-exit re-dispatch has been spent on this ticket
 *                       yet, so the stamp has not yet been acted on. This is the
 *                       benefit of the doubt FR-2.1b requires, and it is what
 *                       covers stamps written before a reportedAt was recorded.
 * All three false → the stamp is spent evidence about a previous claim, and the
 * caller falls through to its genuine dead-session branch.
 *
 * `cleanRedispatches` is the workflow row's cleanExitRedispatches[ticketId] — no
 * new state: a clean re-dispatch mints a fresh claim (a new agentTasks[].startedAt),
 * so the counter and claimStartedAt together already say "the stamp was used".
 *
 * Returns { parkedClean, reason, awaitingIds } — `reason` rides the escalation
 * evidence block so an operator can see WHICH term decided.
 */
export function parkEvidence(ticket, { siblings, claimStartedAt, cleanRedispatches = 0 } = {}) {
  const pu = ticket?.preconditionUnmet;
  const hasStamp = !!(pu && Array.isArray(pu.awaitingIds) && pu.awaitingIds.length);
  if (!hasStamp) return { parkedClean: false, reason: "no-stamp", awaitingIds: [] };

  // TEAM-4184: an unavailable snapshot (unwired reader, or a failed fetch the
  // caller degraded to null/undefined) proves NOTHING closed. That is the
  // OPPOSITE polarity from nonTerminalAwaitedIds's own non-array contract,
  // which exists for checkAwaitTimeout / unionBlockersResolved — callers that
  // are safe treating "can't see the board" as "nothing to report" (advisory
  // wait-SLA, or a resolution check that is defense-in-depth behind a gate
  // that already ran). parkEvidence gates escalation itself: reading a fetch
  // failure as "resolved" turns a transient DDB/Jira error into a false
  // dead-session escalation of a legitimately parked ticket — the very bug
  // class this predicate exists to prevent. Fail toward NOT escalating.
  if (!Array.isArray(siblings)) {
    return { parkedClean: true, reason: "awaited-open", awaitingIds: awaitedUnion(ticket) };
  }

  const awaitingIds = nonTerminalAwaitedIds(ticket, siblings);
  if (awaitingIds.length) return { parkedClean: true, reason: "awaited-open", awaitingIds };
  if (isStampCurrent(pu, claimStartedAt)) return { parkedClean: true, reason: "stamp-current", awaitingIds };
  if (!(Number(cleanRedispatches) > 0)) return { parkedClean: true, reason: "unconsumed-stamp", awaitingIds };
  return { parkedClean: false, reason: "stale-stamp", awaitingIds };
}

/**
 * Build the awaited-ids decision surface bound to its dependencies. Stateless
 * across logical batches except for the metrics accumulator, which newMetrics()
 * resets: a caller runs newMetrics() → does its edge/timeout work →
 * emitAwaitedMetrics() to flush one EMF record.
 */
export function createAwaitedIds(deps = {}) {
  const {
    // send / ticketsTable / provider / getChildTickets / leaseTtlMs are accepted
    // for parity with the sibling factories and the reconcile-sweep wiring; the
    // board write itself goes exclusively through the injected `addBlockers`
    // seam, so this module never touches a raw command (and this file stays free
    // of @aws-sdk imports — DI only).
    //
    // TEAM-4185 F5 — the `addBlockers` seam SHOULD answer in the per-id token form
    // ("added"/"blocked"/"preserved" | "present" | "failed"), which the orchestrator
    // adapter gets by passing `detailed: true`. The legacy added-id-array shape is
    // still accepted (tallyBlockerResult infers present-by-omission), but it cannot
    // distinguish a failed write from an already-present edge, so a seam stuck on
    // that shape will stamp preconditionUnmet for edges that never landed.
    addBlockers,               // (ticketId, ids, { preserveStatusIf, source }) → seam result
    annotatePreconditionUnmet, // (originId, { awaitingIds, source, reportedAt }) — merges ids
                               // TEAM-4185 F3(b): called ONLY when a write landed.
    publishEvent,              // (ticketId, type, detail)
    getTicket,                 // (ticketId) → ticket row | null
    store,                     // workflow-store (markAwaitTimeoutEmitted CAS)
    now = () => Date.now(),
    log = (msg) => console.log(`[orchestrator] ${msg}`),
    mode: rawMode,
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  } = deps;

  const mode = normalizeAwaitedIdsMode(rawMode, log);
  const timeoutMs = (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
    ? timeoutMinutes
    : DEFAULT_TIMEOUT_MINUTES) * 60000;

  function freshMetrics() {
    // TEAM-4185 F5 — `failed` is a first-class outcome, not the absence of one.
    return { mode, derived: 0, fromTool: 0, written: 0, present: 0, failed: 0, timeouts: 0 };
  }
  let metrics = freshMetrics();
  function newMetrics() {
    metrics = freshMetrics();
    return metrics;
  }

  /**
   * PURE. Map a fix ticket's `spawnedBy` to the origin it should re-wake.
   * `spawnedBy.kind` → KIND_TO_ORIGIN_KEY[kind] → that key's origin id. Returns
   * { originId, ids: [fixTicketId] } or null (not a fix ticket / no origin key /
   * unshaped id / would self-reference).
   */
  function deriveAwaitedIds(fixTicket) {
    const spawnedBy = fixTicket && typeof fixTicket === "object" ? fixTicket.spawnedBy : null;
    const kind = spawnedBy && typeof spawnedBy === "object" ? spawnedBy.kind : null;
    if (!kind || !FIX_KINDS.includes(kind)) return null;
    const originKey = KIND_TO_ORIGIN_KEY[kind];
    if (!originKey) return null;
    const originId = spawnedBy[originKey];
    const fixTicketId = fixTicket.ticketId;
    if (!isTicketId(originId) || !isTicketId(fixTicketId)) return null;
    const origin = originId.trim();
    const fix = fixTicketId.trim();
    if (origin === fix) return null; // never self-reference
    return { originId: origin, ids: [fix] };
  }

  /** Dedupe, drop self-reference + unshaped ids, cap at MAX_AWAITED_IDS. */
  function normalizeIds(originId, ids) {
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if (typeof id !== "string") continue;
      const t = id.trim();
      if (!TICKET_KEY_RE.test(t)) continue;
      if (t === originId) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_AWAITED_IDS) break;
    }
    return out;
  }

  /**
   * Write awaited `ids` as blocker edges on `originId` and stamp its
   * preconditionUnmet (the D2 evidence). off → no-op; shadow → count derivation
   * metrics + log, ZERO writes; enforce → write via the seam, then annotate IFF a
   * write actually landed. Returns { written, present, failed, ids }.
   *
   * TEAM-4185 F3(b)/F5 — the annotate is gated on `written > 0`. Two paths used to
   * re-stamp `reportedAt` for a write that changed nothing:
   *   - the level-triggered "tool" pickup re-reporting an edge that is ALREADY on
   *     the board (present). Re-stamping reset the wait clock every sweep, so
   *     awaitedWaitedMs never grew and the D1 wait-SLA could not fire — a ticket
   *     could sit awaiting a fix forever without one await_timeout.
   *   - a wholly-FAILED write (F5). Stamping there is worse than useless: it claims
   *     evidence of a park that has no edge behind it, and the D2 evidence guard
   *     reads that phantom stamp as a clean park.
   * Neither is silent — both are logged with `failed=N` — and the recovery for a
   * failed derived write is the F4 fix-side sweep backstop (handleSpawnedFix in
   * reconcile-sweep.mjs), which re-derives the edge from the fix ticket precisely
   * because no stamp was left behind to find it by.
   *
   * Never throws: an awaited edge is advisory bookkeeping on the done cascade, so a
   * seam throw is folded into the normal return as `failed = clean.length`.
   */
  async function applyAwaitedEdges(originId, ids, source = "tool") {
    const clean = normalizeIds(originId, ids);
    if (!clean.length) return { skipped: "no-ids" };

    const isTool = source === "tool";
    for (let i = 0; i < clean.length; i++) {
      if (isTool) metrics.fromTool++;
      else metrics.derived++;
    }

    if (mode === "off") return { skipped: "off" };
    if (mode === "shadow") {
      log(`awaited.would_apply (shadow) — origin=${originId} += [${clean.join(", ")}] source=${source}`);
      return { skipped: "shadow", ids: clean };
    }

    // enforce — the ONE provider-aware write seam. A seam THROW is not a special
    // return shape: it is every requested id failing, folded into the normal path
    // so the caller has exactly one outcome vocabulary to read.
    let res;
    let threw = null;
    try {
      res = await addBlockers(originId, clean, { preserveStatusIf: PRESERVE_STATUSES, source });
    } catch (err) {
      threw = err;
      log(`awaited.addBlockers_error — origin=${originId}: ${err?.message || err}`);
    }
    const { written, present, failed } = threw
      ? { written: 0, present: 0, failed: clean.length }
      : tallyBlockerResult(res, clean);
    metrics.written += written;
    metrics.present += present;
    metrics.failed += failed;

    // Stamp the origin's preconditionUnmet (merging ids if already present) —
    // this is what the D2 evidence guard reads to tell a clean park from a dead
    // session. Best-effort: a failed stamp must not undo the edge that landed.
    //
    // TEAM-4185 F3(b) — ONLY when a write landed. `written === 0` means either the
    // edge was already there (present) or nothing landed at all (failed); in both
    // cases there is no new fact to record, and re-stamping would move `reportedAt`
    // forward and reset the wait clock awaitedWaitedMs / checkAwaitTimeout read.
    if (written > 0) {
      try {
        await annotatePreconditionUnmet?.(originId, {
          awaitingIds: clean,
          // TEAM-4184 — honor the caller's source. This was hard-coded "derived",
          // so an agent's OWN report (the level-triggered "tool" pickup) was
          // recorded as an orchestrator inference, losing the distinction the
          // provenance field exists to make.
          source: isTool ? "tool" : "derived",
          reportedAt: new Date(now()).toISOString(),
        });
      } catch (err) {
        log(`awaited.annotate_error — origin=${originId}: ${err?.message || err}`);
      }
    }

    log(`awaited.apply — origin=${originId} += [${clean.join(", ")}] source=${source} written=${written} present=${present} failed=${failed}`);
    return { written, present, failed, ids: clean };
  }

  /**
   * Derive the origin from a freshly-created fix ticket's spawnedBy and, when the
   * origin is present and non-terminal, write the awaited edge. off → no-op
   * returning { skipped: "off" } BEFORE any dependency call (so off is provably
   * zero-I/O). deriveAwaitedIds is pure, so it runs first regardless.
   */
  async function applyAwaitedEdgesForSpawn(fixTicketId, spawnedBy, source = "spawnedBy") {
    const derived = deriveAwaitedIds({ ticketId: fixTicketId, spawnedBy });
    if (!derived) return { skipped: "no-origin" };
    if (mode === "off") return { skipped: "off" };

    let origin;
    try {
      origin = await getTicket(derived.originId);
    } catch (err) {
      log(`awaited.origin_read_error — ${derived.originId}: ${err?.message || err}`);
      return { skipped: "origin-error" };
    }
    if (!origin) return { skipped: "origin-missing" };
    if (TERMINAL_TICKET_STATUSES.has(origin.status)) return { skipped: "origin-terminal" };

    return applyAwaitedEdges(derived.originId, derived.ids, source);
  }

  /**
   * PURE. Decide whether a ticket's awaited ids have breached the wait SLA.
   * Awaited ids = the union of ticket.preconditionUnmet.awaitingIds and
   * ticket.blockedBy that are STILL non-terminal in `siblings`. Returns null when
   * there are no such ids (nothing awaited, or all awaited ids already terminal);
   * else { timedOut, waitedMs, awaitingIds }.
   */
  function checkAwaitTimeout(ticket, siblings, nowMs) {
    if (!ticket || typeof ticket !== "object") return null;
    // TEAM-4184: the union lives in the module-level nonTerminalAwaitedIds, shared
    // with parkEvidence, so the two can never disagree about what "awaited" means.
    // NOTE the deliberate `siblings || []` — a caller with no snapshot gets
    // "nothing is provably terminal", the conservative direction for a wait SLA.
    const awaitingIds = nonTerminalAwaitedIds(ticket, siblings || []);
    if (!awaitingIds.length) return null;

    const waitedMs = awaitedWaitedMs(ticket, nowMs);
    return { timedOut: waitedMs >= timeoutMs, waitedMs, awaitingIds };
  }

  /**
   * Emit the advisory `orchestrator.await_timeout` event AT MOST ONCE per ticket,
   * gated by the store CAS (markAwaitTimeoutEmitted returns truthy only for the
   * first writer). Deliberately NO humanNotification — an advisory event only, so
   * a genuinely-stuck await never trips parkedOnHuman. off → nothing; shadow →
   * log the decision, no store write, no event; enforce → CAS then event + metric.
   * Returns true only when THIS caller emitted.
   *
   * TEAM-4184 F2: `reason` distinguishes the two situations that share this event.
   * "await_timeout" (default) = the wait SLA on ids that are genuinely still open.
   * "clean_exit_cap" = a ticket re-woken to the clean-exit cap with NOTHING left
   * awaited, so `awaitingIds` is legitimately empty; without the field an operator
   * reading an empty list could not tell it from a malformed SLA breach.
   */
  async function emitAwaitTimeoutOnce(workflow, ticketId, awaitingIds, waitedMs, source = "sweep", { reason = "await_timeout" } = {}) {
    if (mode === "off") return false;
    if (mode === "shadow") {
      log(`awaited.await_timeout (shadow) — ${ticketId} awaiting=[${(awaitingIds || []).join(", ")}] waitedMs=${waitedMs} reason=${reason}`);
      return false;
    }
    const at = new Date(now()).toISOString();
    const won = await store.markAwaitTimeoutEmitted(workflow.id, ticketId, at);
    if (!won) return false;
    await publishEvent(ticketId, "orchestrator.await_timeout", {
      workflowId: workflow.id,
      ticketId,
      awaitingIds: awaitingIds || [],
      waitedMs,
      timestamp: at,
      source,
      reason,
    });
    metrics.timeouts++;
    log(`awaited.await_timeout — ${ticketId} awaiting=[${(awaitingIds || []).join(", ")}] waitedMs=${waitedMs} source=${source} reason=${reason}`);
    return true;
  }

  /**
   * Emit the awaited-ids summary as a single EMF record (AgentCoreHub/Orchestrator
   * namespace) — same emitter shape as emitReconcileMetrics / emitCascadeMetrics.
   * Explicit 0s so a silent batch is distinguishable from a healthy one; the
   * AwaitedMode field records which mode produced these counts.
   */
  function emitAwaitedMetrics(m = metrics) {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: "AgentCoreHub/Orchestrator",
          Dimensions: [[]],
          Metrics: [
            { Name: "AwaitedEdgesDerived", Unit: "Count" },
            { Name: "AwaitedEdgesFromTool", Unit: "Count" },
            { Name: "AwaitedEdgesWritten", Unit: "Count" },
            { Name: "AwaitedEdgesPresent", Unit: "Count" },
            // TEAM-4185 F5 — a wholly-failed write leaves NO stamp, so this metric
            // is the only signal that a re-wake edge silently did not land.
            { Name: "AwaitedEdgesFailed", Unit: "Count" },
            { Name: "AwaitTimeouts", Unit: "Count" },
          ],
        }],
      },
      AwaitedMode: m.mode || mode,
      AwaitedEdgesDerived: m.derived || 0,
      AwaitedEdgesFromTool: m.fromTool || 0,
      AwaitedEdgesWritten: m.written || 0,
      AwaitedEdgesPresent: m.present || 0,
      AwaitedEdgesFailed: m.failed || 0,
      AwaitTimeouts: m.timeouts || 0,
    }));
  }

  return {
    deriveAwaitedIds,
    applyAwaitedEdgesForSpawn,
    applyAwaitedEdges,
    checkAwaitTimeout,
    emitAwaitTimeoutOnce,
    emitAwaitedMetrics,
    newMetrics,
    mode,
  };
}
