/**
 * Dead-session escalation tree (TEAM-4120 FR-3) — page → synthesize → park.
 *
 * TODAY: both exhausted-retry emitters (dead-session-detector.mjs
 * retryOrEscalate, cascade.mjs stealWithRetryBudget) end the same way — publish
 * agent.escalated, set the task to `error`, block the ticket, and append a
 * `manager_escalation` notification reading "Dead session (retry exhausted):
 * TEAM-x … needs a human". That notification carries no evidence: not the
 * agent's last words, not the tickets it had already spawned, not whether a
 * completion record already exists. So a human has to reconstruct the run by
 * hand before they can decide anything, and the ticket sits in `error` (held by
 * cascade.mjs escalationHeld) until they do — which on the observed runs is
 * where the run actually died.
 *
 * THIS MODULE decides, from evidence only, which of three things to do:
 *   (a) PAGE   — always (shadow and enforce). Reads the agent's last streamed
 *                text, the children it spawned inside the claim window, its
 *                completion record, and its PR, then appends ONE notification
 *                carrying all of it plus the disposition. Reads only + that one
 *                write.
 *   (b) SYNTHESIZE — the agent died after doing the work. A fresh
 *                evidence-bearing completion record → transition the ticket to
 *                done and let the EXISTING done handlers harvest it (TEAM-3976
 *                path). Spawned children but no record → block the ticket on
 *                those children and reset the retry budget, so the normal
 *                unblock cascade resumes it when they land. Never both.
 *   (c) PARK   — no evidence: create ONE human gate, block the ticket on it, and
 *                park the gate. The gate's own done cascade resumes the ticket.
 *
 * R3 INVARIANT (unchanged): this module NEVER steals a claim, NEVER invokes an
 * agent, and NEVER marks a ticket Done without a completion record that both
 * bears evidence AND was written during the claim we are burying. Liveness is
 * decided upstream (lease.mjs / the detector); by the time we run, the caller
 * has already published agent.escalated, set the task to `error`, and blocked
 * the ticket. We only add evidence and a resume path.
 *
 * FULLY DEPENDENCY-INJECTED: no AWS client construction, no process.env reads,
 * and every step wrapped so a failure degrades the disposition instead of
 * throwing — this runs inside a sweep that must finish its other candidates.
 * The only import is completion.mjs (the SHARED evidence predicate — deliberately
 * not forked, so "what counts as a deliverable" has one definition).
 */

import { completionRecordHasEvidence } from "./completion.mjs";

const MODES = new Set(["off", "shadow", "enforce"]);

/**
 * off | shadow | enforce. UNSET (or "") → "off": a fresh deploy is byte-
 * identical, because index.mjs never even constructs the module when off.
 * A PRESENT-but-unrecognized value → "shadow", the same fail-safe direction as
 * rework-loop-cap.mjs normalizeReworkLoopMode: somebody meant to turn this on,
 * and shadow observes without writing anything a human can't ignore. (The
 * opposite of the gate/ship guards, where the dangerous failure is acting.)
 */
export function normalizeEscalationMode(value) {
  if (value === undefined || value === null) return "off";
  const v = String(value).trim().toLowerCase();
  if (v === "") return "off";
  if (MODES.has(v)) return v;
  return "shadow";
}

/** Clip to n chars with an explicit ellipsis so a truncated page reads as one. */
export function clipText(s, n) {
  const str = typeof s === "string" ? s : "";
  if (n <= 0) return "";
  return str.length > n ? `${str.slice(0, Math.max(0, n - 1))}…` : str;
}

// ─── Redaction (security F8) ──────────────────────────────────────────────────

/**
 * ORDER MATTERS: the caller joins every fragment FIRST, then redacts the joined
 * string, then clips. Redacting per-fragment would let a secret split across two
 * streaming chunks through, and clipping first could cut a secret in half so no
 * pattern matches the halves.
 *
 * Self-contained on purpose (no imports, no closures over module state): the
 * same function body is copied verbatim into the Telegram Lambda, which cannot
 * import from this directory.
 */
export function redactText(s) {
  let t = typeof s === "string" ? s : "";
  if (!t) return "";
  const R = "[REDACTED]";

  // Private keys first — the multi-line blob would otherwise be shredded by the
  // whitespace collapse below and never match.
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R);

  // Presigned-URL query strings: keep the path (it identifies the artifact),
  // redact every value (SigV4 signature/credential live here).
  t = t.replace(/([a-zA-Z][\w+.-]*:\/\/[^\s?]+\?)([^\s]*)/g, (_m, head, qs) =>
    head + qs.replace(/([^&=]+)=([^&]*)/g, (__, k) => `${k}=${R}`)
  );
  // …and bare SigV4 params that arrive without a host (log lines, curl echoes).
  // The value stops at `&` so a param list keeps every KEY NAME visible instead
  // of a single greedy match swallowing the rest of the query.
  t = t.replace(/X-Amz-(Signature|Credential|Security-Token|Algorithm|Date|Expires|SignedHeaders)=[^\s&]+/gi,
    (_m, p) => `X-Amz-${p}=${R}`);

  // Provider tokens — longest/most specific patterns first.
  t = t.replace(/github_pat_[A-Za-z0-9_]{20,}/g, R);
  t = t.replace(/ghp_[A-Za-z0-9]{36}/g, R);
  t = t.replace(/gh[osur]_[A-Za-z0-9]{36}/g, R);
  t = t.replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, R);
  t = t.replace(/aws_secret_access_key\s*[=:]\s*\S+/gi, `aws_secret_access_key=${R}`);
  t = t.replace(/xox[abprs]-[A-Za-z0-9-]+/g, R);
  t = t.replace(/hooks\.slack\.com\/services\/\S+/g, `hooks.slack.com/services/${R}`);
  t = t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, R);              // JWT
  t = t.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, R);          // Telegram bot token
  t = t.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, R);
  t = t.replace(/sk-[A-Za-z0-9]{20,}/g, R);
  t = t.replace(/ATATT[A-Za-z0-9_-]{20,}/g, R);                 // Jira API token
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${R}`);
  // `Authorization: <scheme> <credential>` — the scheme name is not the secret,
  // so step OVER a known one and redact what follows. A bare `Authorization: xyz`
  // (no scheme) still matches via the optional group.
  t = t.replace(/Authorization:\s*(?:(Bearer|Basic|Token|Digest|AWS4-HMAC-SHA256)\s+)?\S+/gi,
    (_m, scheme) => `Authorization: ${scheme ? `${scheme} ` : ""}${R}`);

  // Generic key=value — keep the KEY NAME (it tells the human what leaked) and
  // redact the value. Runs last so the specific patterns above win.
  t = t.replace(/(api[_-]?key|password|passwd|secret|token)(\s*[=:]\s*)(\S+)/gi,
    (_m, k, sep) => `${k}${sep}${R}`);

  // Emails: a page goes to a chat channel, so PII gets a placeholder, not [REDACTED].
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");

  // Finally make it one readable line: drop ANSI + code fences/backticks, collapse
  // whitespace. (After redaction, so a fence can't hide a pattern boundary.)
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\[[0-9;]*[A-Za-z]/g, "");
  t = t.replace(/```+/g, " ").replace(/`/g, "");
  return t.replace(/\s+/g, " ").trim();
}

// ─── Child selection ──────────────────────────────────────────────────────────

/** The spawn-provenance keys a spawned ticket may carry back to its parent. */
const SPAWN_ORIGIN_KEYS = ["gateTicketId", "qaTicketId", "codexTicketId", "shipTicketId", "ciTicketId"];
const TERMINAL_FOR_SELECTION = new Set(["cancelled"]);

const msOf = (v) => {
  const ms = Date.parse(v || "");
  return Number.isFinite(ms) ? ms : null;
};
const idOf = (t) => t?.ticketId || t?.key || t?.id || null;

/**
 * Which sibling tickets did the dead agent spawn? Pure so the selection rule is
 * testable against real dossier slices without any I/O.
 *
 * PRIMARY: explicit provenance — a sibling whose spawnedBy names this ticket.
 * That is exact when it exists, but only the tickets Lambda's own spawn paths
 * stamp it (SPAWN_ORIGIN_KEYS), so an agent that filed tickets directly has none.
 *
 * FALLBACK (primary empty): the DEPENDENCY-CLOSED set of tickets created inside
 * the claim window. Not the design's literal "blockedBy is empty" rule: on the
 * real yteqfl slice that rule yields {TEAM-4101, TEAM-4105} and MISSES TEAM-4102
 * (blockedBy [TEAM-4101]) — i.e. it drops the chain the dead release manager had
 * just built, which is exactly the evidence a human needs. The closure yields the
 * whole chain 4101→4102→4103→4104 plus 4105/4106, the fixes concurrent QA/CI
 * agents filed in the same window. Including those is correct rather than sloppy:
 * all of them must reach done before the Ship ticket may resume, which is the
 * Workflow Manager's own stated resume condition for that run — so blocking the
 * held ticket on the closure is the resume condition, not an over-approximation.
 *
 * HARD INVARIANT (TEAM-4129 F1): a dead-session-held ticket can NEVER be blocked
 * on a ticket that transitively depends on it. The caller's enforce path (b) does
 * addBlockers(ticketId, children) with no park and no human page, so one bad
 * member of this set is a permanent blocker cycle that reconcileDependent can
 * never release. Two independent barriers, because the cost of a miss is a wedged
 * run and the cost of a false exclusion is only a narrower page:
 *
 *   1. A REAL closure, iterated to a fixpoint: a candidate is admitted only when
 *      every one of its blockers is ITSELF an admitted candidate (empty blockedBy
 *      is the base case). The pre-4129 rule only asked whether each blocker was
 *      in the window, which is one level deep: with held TEAM-1, QA-1 blockedBy
 *      [TEAM-1] is correctly dropped (TEAM-1 is not in the window) but DEV-1
 *      blockedBy [QA-1] was still admitted, giving TEAM-1→DEV-1→QA-1→TEAM-1.
 *      Under the fixpoint, QA-1's disqualification propagates to DEV-1 and to
 *      anything that depends on DEV-1.
 *   2. An explicit transitive-reachability check over ALL siblings (not just the
 *      in-window ones, and cycle-guarded by a visited set): any candidate whose
 *      blockedBy graph reaches ticketId is dropped. Barrier 1 already implies
 *      this today — an admitted candidate's whole transitive blocker set is
 *      in-window and admitted, and the held ticket is never in the window — but
 *      barrier 2 does not depend on the window rule, so the invariant survives
 *      any future loosening of it, and it also covers the PRIMARY provenance path
 *      where no window rule applies at all.
 *
 * If both barriers empty the set, selectChildren returns [] — escalateExhausted's
 * `children.length > 0` is then false, so it falls through to path (c) PARK and a
 * human gets paged. That flow needs no other change.
 *
 * createdAt is parsed with Date.parse because real tickets carry offsets
 * (`…T04:38:39.251-0700`), not just Z.
 */
export function selectChildren({ siblings, ticketId, claim, now } = {}) {
  const all = Array.isArray(siblings) ? siblings : [];

  // Blocker adjacency over EVERY sibling, so barrier 2 can walk a chain that
  // leaves the claim window (a pre-window ticket) and still reaches the held one.
  const byId = new Map();
  for (const s of all) {
    const sid = idOf(s);
    if (sid && !byId.has(sid)) byId.set(sid, s);
  }
  const blockersOf = (id) => {
    const b = byId.get(id)?.blockedBy;
    return Array.isArray(b) ? b : [];
  };
  /** Barrier 2: does startId's transitive blockedBy reach the held ticket? */
  const dependsOnHeld = (startId) => {
    const seen = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue; // visited set = cycle guard
      seen.add(cur);
      for (const b of blockersOf(cur)) {
        if (b === ticketId) return true;
        stack.push(b);
      }
    }
    return false;
  };

  const primary = all.filter((s) => {
    const sid = idOf(s);
    if (!sid || sid === ticketId) return false;
    const sp = s.spawnedBy;
    if (!sp || !SPAWN_ORIGIN_KEYS.some((k) => sp[k] === ticketId)) return false;
    return !dependsOnHeld(sid);
  });
  if (primary.length) return primary.map(idOf).filter(Boolean);

  const from = msOf(claim?.startedAt);
  const to = Number.isFinite(now) ? now : Date.now();
  if (from === null) return [];

  const inWindow = all.filter((s) => {
    const sid = idOf(s);
    if (!sid || sid === ticketId) return false;
    if (TERMINAL_FOR_SELECTION.has(s.status)) return false;
    const created = msOf(s.createdAt);
    return created !== null && created >= from && created <= to;
  });

  // Barrier 1: fixpoint closure. Start from the tickets with no blockers at all
  // and keep admitting candidates whose blockers are already admitted, until a
  // pass admits nothing. Anything left out is (transitively) waiting on something
  // outside the window — the held ticket included.
  const admitted = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of inWindow) {
      const sid = idOf(s);
      if (!sid || admitted.has(sid)) continue;
      const blockers = Array.isArray(s.blockedBy) ? s.blockedBy : [];
      if (blockers.every((b) => admitted.has(b))) {
        admitted.add(sid);
        changed = true;
      }
    }
  }

  return inWindow
    .map(idOf)
    .filter((sid) => sid && admitted.has(sid) && !dependsOnHeld(sid));
}

// ─── The tree ─────────────────────────────────────────────────────────────────

const LAST_TEXT_CHARS = 600;
const DETAILS_CHARS = 700;

const DISPOSITION_LABEL = {
  parked: "parked on a human gate",
  synthesized_completion: "completed from its completion record",
  synthesized_children: "blocked on the tickets it spawned",
  shadow: "shadow (no action taken)",
};

export function createDeadSessionEscalation(deps = {}) {
  const {
    mode = "off",
    store,
    lease,
    ddb,
    eventsTable,
    getChildTickets,
    getTicket,
    invokeTickets,
    s3Get,
    githubApi,
    addBlockers,
    parkGateForHuman,
    publishEvent,
    transitionTicket,
    now = () => Date.now(),
    log = console,
  } = deps;

  const warn = (msg, err) =>
    (log.warn || log.log || (() => {}))(`[orchestrator] dead-session-escalation: ${msg}${err ? ` — ${err?.message || err}` : ""}`);
  const info = (msg) => (log.log || (() => {}))(`[orchestrator] dead-session-escalation: ${msg}`);

  /** Every read is best-effort: a missing signal narrows the disposition, never throws. */
  const safe = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      warn(`${label} failed (non-fatal)`, err);
      return fallback;
    }
  };

  /**
   * The agent's last words, RAW (redaction is the caller's, so the raw text can
   * be length-budgeted before any pattern is applied to the joined string).
   */
  async function readLastText(workflow, agentId, ticketId) {
    if (!lease?.lastStreamedText || !ddb || !eventsTable) return "";
    return await safe("lastStreamedText", () =>
      lease.lastStreamedText(ddb, eventsTable, workflow.id, agentId, ticketId, LAST_TEXT_CHARS), "");
  }

  /**
   * Is there a REAL agent-side failure since the claim started? A real error
   * means the agent tried and failed, so its half-finished children are not
   * evidence of success — page and park instead of synthesizing. The detector's
   * own `dead_session` announcement is excluded (that is us, not the agent).
   */
  async function readRealError(workflow, ticketId, claim) {
    if (!lease?.hasAgentErrorSince || !ddb || !eventsTable) return false;
    return await safe("hasAgentErrorSince", () =>
      lease.hasAgentErrorSince(ddb, eventsTable, workflow.id, ticketId, claim?.startedAt), false);
  }

  /**
   * A completion record is evidence ONLY when it bears a deliverable AND was
   * written during the claim we are burying (security F4): attempt 1 leaves a
   * record behind, and closing attempt 2 on it would mark a ticket Done for work
   * the second agent never did.
   */
  async function readCompletionRecord(ticketId, claim) {
    if (!s3Get) return { present: false, fresh: false, record: null };
    const record = await safe("completion record read", () => s3Get(`completions/${ticketId}.json`), null);
    if (!record) return { present: false, fresh: false, record: null };
    const bears = completionRecordHasEvidence(record);
    const startedMs = msOf(claim?.startedAt);
    const completedMs = msOf(record.completed_at);
    const fresh = bears && startedMs !== null && completedMs !== null && completedMs >= startedMs;
    return { present: bears, fresh, record };
  }

  /** The dead agent's PR, if it opened one. Never fatal (no PAT, private repo, …). */
  async function readPrUrl(workflow, ticketId) {
    if (!githubApi) return null;
    const url = workflow?.repoConfig?.repos?.[0]?.url || "";
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!m) return null;
    return await safe("PR lookup", async () => {
      const prs = await githubApi(`/repos/${m[1]}/${m[2]}/pulls?state=all&per_page=50`);
      if (!Array.isArray(prs)) return null;
      const prefix = `feature/${ticketId}-`;
      const hit = prs.find((p) => typeof p?.head?.ref === "string" && p.head.ref.startsWith(prefix));
      return hit?.html_url || null;
    }, null);
  }

  function buildDetails({ ticketId, agentId, disposition, evidence, children, gateTicketId }) {
    const bits = [
      `Agent ${agentId} went silent on ${ticketId} (claim started ${evidence.claim?.startedAt || "unknown"}, last heartbeat ${evidence.claim?.lastHeartbeatAt || "unknown"}); auto-retry exhausted.`,
      `Disposition: ${DISPOSITION_LABEL[disposition] || disposition}${gateTicketId ? ` (${gateTicketId})` : ""}.`,
      evidence.completionRecord
        ? "A completion record from this attempt exists — the work landed."
        : evidence.completionRecordStale
          ? "A completion record exists but predates this attempt — NOT evidence."
          : "No completion record.",
      children.length ? `Spawned ${children.length}: ${children.join(", ")}.` : "Spawned nothing.",
      evidence.prUrl ? `PR ${evidence.prUrl}.` : "",
      evidence.realError ? "An agent error was reported during this attempt." : "",
      evidence.lastText ? `Last words: ${evidence.lastText}` : "",
    ].filter(Boolean);
    return clipText(bits.join(" "), DETAILS_CHARS);
  }

  /**
   * Called by BOTH exhausted-retry emitters INSTEAD of their appendNotification
   * block. The caller has already published agent.escalated, set the task to
   * `error`, and blocked the ticket — so a throw here would lose the page
   * entirely; nothing below is allowed to escape.
   */
  async function escalateExhausted({ workflow, ticketId, agentId, claim = {} } = {}) {
    const nowMs = now();
    const at = new Date(nowMs).toISOString();
    const result = { disposition: "shadow", evidence: {}, children: [] };
    if (!workflow?.id || !ticketId) {
      warn(`called with no workflow/ticketId — skipping (ticketId=${ticketId})`);
      return result;
    }

    try {
      // ── (a) PAGE: gather evidence. Reads only. ──
      const rawLastText = await readLastText(workflow, agentId, ticketId);
      const siblings = await safe("getChildTickets", () => getChildTickets?.(workflow.epicId), []);
      const children = selectChildren({ siblings: siblings || [], ticketId, claim, now: nowMs });
      const completion = await readCompletionRecord(ticketId, claim);
      const prUrl = await readPrUrl(workflow, ticketId);
      const realError = await readRealError(workflow, ticketId, claim);
      const ticket = await safe("getTicket", () => getTicket?.(ticketId), null);

      const evidence = {
        claim,
        // Join → redact → clip, in that order (see redactText).
        lastText: clipText(redactText(rawLastText), LAST_TEXT_CHARS),
        completionRecord: completion.fresh,
        completionRecordStale: completion.present && !completion.fresh,
        prUrl,
        realError,
      };
      result.evidence = evidence;
      result.children = children;

      // ── decide ──
      const canSynthesize = !realError && (completion.fresh || children.length > 0);
      const evidenceSource = completion.fresh ? "completion_record" : "children";
      let gateTicketId;

      if (mode !== "enforce") {
        // shadow: report the decision, write nothing but the page.
        await safe("publish escalation_decided", () =>
          publishEvent?.(ticketId, "dead_session.escalation_decided", {
            workflowId: workflow.id, ticketId, agentId, shadow: true,
            ...(canSynthesize
              ? { wouldSynthesize: true, evidenceSource }
              : { wouldPark: true }),
            children,
          }));
        result.disposition = "shadow";
        result.wouldSynthesize = canSynthesize;
        result.wouldPark = !canSynthesize;
      } else if (canSynthesize && completion.fresh) {
        // ── (b) SYNTHESIZE from the completion record ──
        // Mark the provenance, then hand the ticket to the NORMAL done path:
        // transitionTicket → the done handlers → markTaskComplete →
        // harvestCompletionEvidence (TEAM-3976) writes agentTasks.output from the
        // record. We never write output ourselves — one harvester, one shape.
        await safe("mergeTaskMetadata", () =>
          store?.mergeTaskMetadata(workflow.id, ticketId, { synthesized: true, evidenceSource: "completion_record" }));
        await safe("transitionTicket(done)", () => transitionTicket?.(ticketId, "done"));
        result.disposition = "synthesized_completion";
      } else if (canSynthesize) {
        // ── (b) SYNTHESIZE from spawned children ──
        // Security F5: ONE automatic synthesis per ticket, ever. Without the CAS
        // a ticket that keeps dying gets re-blocked on a fresh child set every
        // sweep and never reaches a human.
        const admitted = await safe("claimDeadSessionSynthesis",
          () => store?.claimDeadSessionSynthesis(workflow.id, ticketId), false);
        if (!admitted) {
          info(`${ticketId}: children-synthesis already spent — parking instead`);
          gateTicketId = await park({ workflow, ticketId, agentId, evidence, children });
          result.disposition = gateTicketId ? "parked" : "shadow";
          result.gateTicketId = gateTicketId;
        } else {
          await safe("mergeTaskMetadata", () =>
            store?.mergeTaskMetadata(workflow.id, ticketId, { synthesized: true, evidenceSource: "children", children }));
          await safe("addBlockers", () => addBlockers?.(ticketId, children));
          // The human decision the ticket was waiting on is now encoded as
          // blockers, so its next silence is a NEW episode: give back the one
          // automatic re-dispatch.
          await safe("resetDeadSessionRetry", () => store?.resetDeadSessionRetry(workflow.id, ticketId));
          await safe("publish escalation_synthesized", () =>
            publishEvent?.(ticketId, "agent.escalation_synthesized", {
              workflowId: workflow.id, ticketId, evidenceSource: "children", children,
            }));
          result.disposition = "synthesized_children";
        }
      } else {
        // ── (c) PARK on a human gate ──
        gateTicketId = await park({ workflow, ticketId, agentId, evidence, children });
        result.disposition = gateTicketId ? "parked" : "shadow";
        result.gateTicketId = gateTicketId;
      }

      // The notification is appended LAST so every field (disposition, gate id)
      // is final. Same id scheme as the notification it replaces, so the Telegram
      // bot's claim keys are unchanged.
      await safe("appendNotification", () =>
        store?.appendNotification(workflow.id, {
          id: `notif_dead_session_${ticketId}_${at}`,
          type: "manager_escalation",
          title: `Dead session: ${ticketId} — ${DISPOSITION_LABEL[result.disposition] || result.disposition}`,
          details: buildDetails({ ticketId, agentId, disposition: result.disposition, evidence, children, gateTicketId: result.gateTicketId }),
          reviewer: "dead-session-escalation",
          source: claim?.source || "unknown",
          ticketId,
          agentId,
          ticketTitle: ticket?.title || ticket?.summary || "",
          lastText: evidence.lastText,
          children,
          artifacts: { completionRecord: evidence.completionRecord, prUrl: evidence.prUrl || null },
          disposition: result.disposition,
          ...(result.wouldSynthesize !== undefined ? { wouldSynthesize: result.wouldSynthesize } : {}),
          ...(result.wouldPark !== undefined ? { wouldPark: result.wouldPark } : {}),
          ...(result.gateTicketId ? { gateTicketId: result.gateTicketId } : {}),
          timestamp: at,
          acknowledged: false,
        }));

      info(`${ticketId} agent=${agentId} → ${result.disposition} (children=${children.length} record=${evidence.completionRecord} realError=${realError} mode=${mode})`);
      return result;
    } catch (err) {
      // Unreachable by design (every step is wrapped) — but this runs inside a
      // sweep, so a bug here must not cost the other candidates their decisions.
      warn(`${ticketId}: escalation tree failed`, err);
      return result;
    }
  }

  /**
   * Create ONE human gate, block the held ticket on it, and park it. The gate is
   * in the held ticket's blockedBy, so the gate's own done cascade resumes the
   * ticket — no bespoke re-drive, and index.mjs's wake hook resets the retry
   * budget when the human decides.
   */
  async function park({ workflow, ticketId, agentId, evidence, children }) {
    const description = [
      `Agent ${agentId} went silent on ${ticketId} and the automatic re-dispatch budget is spent.`,
      `Claim started ${evidence.claim?.startedAt || "unknown"}; last heartbeat ${evidence.claim?.lastHeartbeatAt || "unknown"}.`,
      evidence.completionRecord ? "A completion record from this attempt exists." : "No completion record from this attempt.",
      evidence.completionRecordStale ? "(An OLDER completion record exists — it belongs to a previous attempt.)" : "",
      children.length ? `Tickets created during the dead claim: ${children.join(", ")}.` : "No tickets were created during the claim.",
      evidence.prUrl ? `PR: ${evidence.prUrl}` : "",
      evidence.realError ? "An agent error was reported during this attempt." : "",
      evidence.lastText ? `Last streamed output (redacted): ${evidence.lastText}` : "",
      "",
      `Approving this gate (move it to Done) clears ${ticketId}'s retry budget and unblocks it, so the normal cascade re-dispatches the agent with one fresh automatic retry. If the work is actually finished, close ${ticketId} instead.`,
    ].filter(Boolean).join("\n");

    const gateId = await safe("create escalation gate", async () => {
      const res = await invokeTickets?.("create_ticket", {
        summary: `Escalation: dead session on ${ticketId} (${agentId})`,
        description,
        assignee: "human:engineer",
        parent_key: workflow.epicId,
        workflow_id: workflow.id,
        blocked_by: [],
      });
      return res?.key || res?.ticket?.key || null;
    }, null);
    if (!gateId) {
      warn(`${ticketId}: could not create the escalation gate — the ticket stays in error for the existing manager_escalation page`);
      return null;
    }
    await safe("addBlockers(gate)", () => addBlockers?.(ticketId, [gateId]));
    await safe("parkGateForHuman", () => parkGateForHuman?.(gateId, "human:engineer", workflow));
    return gateId;
  }

  return { escalateExhausted };
}
