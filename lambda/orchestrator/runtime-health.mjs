/**
 * TEAM-3992 D4.2 — coding-runtime health gate + auto-resume.
 *
 * The fleet's dev/QA/CI agents delegate `claude_code`/`codex`/`kiro` to a single
 * separate coding-agent runtime (deploy/coding-agent-runtime/). When that microVM
 * is wedged or recycling, every coding ticket the orchestrator dispatches burns a
 * full agent invocation only to die mid-turn — in prod one outage produced dozens
 * of identical `agent.error`s and no operator signal. This module turns that into
 * ONE observable outage: a cheap read-only probe gates dispatch, a single S3 CAS
 * object fans the outage out to every coding ticket (parked `blocked:runtime`
 * instead of dispatched), and a 5-minute sweep re-probes with backoff and, on
 * recovery, routes each parked ticket back through the ONE cascade R3
 * implementation (never a re-implemented steal/liveness).
 *
 * WHY probe via `poll`, not `/health`: the fleet reaches the coding runtime ONLY
 * through `bedrock-agentcore:InvokeAgentRuntime` (deploy/runtime-agent/main.py
 * `_coding_invoke`). `/ping` + `/health` are FastAPI control-plane routes NOT
 * reachable that way. The runtime's `action=="poll"` path (`_poll_turn`) is
 * read-only and side-effect-free: polling a turn_id that never existed returns
 * `{"status":"unknown"}` at HTTP 200, which PROVES the runtime is reachable and
 * its poll path works WITHOUT starting any work. So healthy ⟺ HTTP 200 AND
 * body.status ∈ the poll vocabulary; a thrown SDK error / timeout / 503 (turn
 * journal unwritable) / malformed body is unhealthy.
 *
 * Every effect is injected (invokeRuntime, s3, publishEvent, now, env, and the
 * effectful transition/escalation/cascade seams), so the whole module runs
 * hermetically in runtime-health.test.mjs with a fake InvokeAgentRuntime, an
 * in-memory S3 that honors ETag / IfNoneMatch / IfMatch, and a fake clock.
 */

import { createHash } from "node:crypto";
import { newMetrics as newCascadeMetrics } from "./cascade.mjs";

/**
 * The poll status vocabulary from deploy/coding-agent-runtime/main.py
 * `_poll_turn`. ANY of these at HTTP 200 means the runtime is reachable and its
 * poll path is alive — including "unknown" (the probe turn_id doesn't exist) and
 * "dead" (a DIFFERENT turn is stale; the runtime itself still answered us).
 */
export const VALID_POLL_STATUSES = Object.freeze(["unknown", "done", "running", "dead", "transient"]);

const DEFAULT_PROBE_CACHE_MS = 60000;
const DEFAULT_PROBE_CONFIRM = 2;
const DEFAULT_BACKOFF_MIN = Object.freeze([5, 15, 30]);
// Hard ceiling on a single probe. Cold start of the coding microVM is 5-20s; a
// probe that hangs past this is itself evidence the runtime is unreachable.
const PROBE_OVERALL_BUDGET_MS = 45000;
// F3 — recovery is a lease held on the outage object itself (state:"recovering"
// + recoveringAt). A sweep that finds a FRESH recovering marker stands down (a
// peer owns the active drain); one older than this window is treated as a
// crashed/timed-out owner and re-claimed. Kept well under the 5-minute sweep
// cadence so the next scheduled sweep always continues a stranded recovery.
const DEFAULT_RECOVERING_STALE_MS = 120000;
// F3 — persist resume progress (shrink blockedTickets) to the outage object
// every N resumed tickets. 1 = per-ticket (crash-exact; M is small — bounded by
// the fleet's concurrent coding-ticket parallelism, ~24). Raise to batch writes.
const DEFAULT_RESUME_PERSIST_EVERY = 1;

/** sha1 hex of a string (Node built-in; no extra dependency). */
function sha1hex(s) {
  return createHash("sha1").update(String(s)).digest("hex");
}

/**
 * Probe session id: stable per-arn so a probe never spawns a fresh runtime
 * session per invocation, and ≥33 chars (AgentCore's minimum — see
 * runtime-agent's `cc-<uuid4hex>` convention). "probe-orchestrator-" (19) +
 * 24 hex = 43 chars.
 */
export function probeSessionId(arn) {
  return "probe-orchestrator-" + sha1hex(arn).slice(0, 24);
}

/** Bucket-level key for the per-arn outage state object. */
export function outageKey(arn) {
  return `runtime-health/${sha1hex(arn)}.json`;
}

/** Short stable id fragment shared by the outage event + escalation notif. */
function arnTag(arn) {
  return sha1hex(arn).slice(0, 12);
}

/** ISO minute — dedupes probe turn_ids within a minute without a clock read race. */
function isoMinute(ms) {
  return new Date(ms).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

/** Parse "5,15,30" → [5,15,30]; fall back to the default on anything unusable. */
export function parseBackoffMinutes(raw) {
  if (!raw) return [...DEFAULT_BACKOFF_MIN];
  const parts = String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts : [...DEFAULT_BACKOFF_MIN];
}

/** True when an S3 conditional write lost its race (412 Precondition Failed). */
function isPreconditionFailed(err) {
  const n = err?.name || err?.code || "";
  return n === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

/** Promise.race a work promise against a rejecting timer; always clears the timer. */
function withBudget(promise, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe exceeded ${ms}ms budget`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Build a runtime-health gate bound to its dependencies.
 *
 * deps:
 *   invokeRuntime({ arn, sessionId, payload }) -> { statusCode, json } | throws
 *   s3: { getObject(key)->{body,etag}|null, putObject(key,body,{ifNoneMatch?,ifMatch?})->{etag}|throws412, deleteObject(key) }
 *   publishEvent(subject, type, detail)
 *   now() -> epoch ms
 *   env  (process.env or a stub)
 *   blockTicketRuntime(ticketId, workflow) -> park a coding ticket blocked:runtime
 *   appendNotificationOnce(workflowId, notification) -> bool (store CAS)
 *   cascade: { reconcileDependent, transitionToReady }
 *   loadWorkflow(workflowId) -> workflow | null      (sweep resume only)
 *   loadTicket(workflow, ticketId) -> ticket | null  (sweep resume only)
 *   findRuntimeBlockedTickets() -> [{workflowId, ticketId}]  (F3 backstop; bounded scan)
 *   log (optional)
 */
export function createRuntimeHealth(deps) {
  const {
    invokeRuntime,
    s3,
    publishEvent,
    now = () => Date.now(),
    env = {},
    blockTicketRuntime,
    appendNotificationOnce,
    cascade,
    loadWorkflow,
    loadTicket,
    findRuntimeBlockedTickets = async () => [],
    log = () => {},
  } = deps;

  const cacheMs = Number(env.RUNTIME_PROBE_CACHE_MS) || DEFAULT_PROBE_CACHE_MS;
  const confirm = Math.max(1, Number(env.RUNTIME_PROBE_CONFIRM) || DEFAULT_PROBE_CONFIRM);
  const backoff = parseBackoffMinutes(env.RUNTIME_OUTAGE_BACKOFF_MIN);
  const provider = env.TICKET_PROVIDER || "dynamodb";
  const recoveringStaleMs = Number(env.RUNTIME_RECOVERING_STALE_MS) || DEFAULT_RECOVERING_STALE_MS;
  const resumePersistEvery = Math.max(1, Number(env.RUNTIME_RESUME_PERSIST_EVERY) || DEFAULT_RESUME_PERSIST_EVERY);

  // Per-container warm state (this factory is a singleton in index.mjs). Keyed by
  // arn so a multi-runtime future needs no rework; today there is one arn.
  const _healthyUntil = new Map(); // arn -> ms; a cached-healthy probe result
  const _failures = new Map(); // arn -> consecutive unhealthy probe count

  const codingArn = () => env.CODING_AGENT_RUNTIME_ARN || "";

  // ── Probe ──────────────────────────────────────────────────────────────────

  /** Single read-only poll probe. Never throws — a throw IS an unhealthy verdict. */
  async function probeRuntime({ arn }) {
    const t0 = now();
    const sessionId = probeSessionId(arn);
    const payload = { action: "poll", turn_id: `probe-${isoMinute(now())}`, session_id: sessionId };
    try {
      const res = await withBudget(invokeRuntime({ arn, sessionId, payload }), PROBE_OVERALL_BUDGET_MS);
      const status = res?.json?.status;
      const healthy = res?.statusCode === 200 && VALID_POLL_STATUSES.includes(status);
      return {
        healthy,
        latencyMs: now() - t0,
        status: status ?? null,
        error: healthy ? null : `unexpected probe response (http=${res?.statusCode ?? "?"}, status=${status ?? "?"})`,
      };
    } catch (err) {
      return { healthy: false, latencyMs: now() - t0, status: null, error: err?.message || String(err) };
    }
  }

  /**
   * Probe with the in-container healthy cache. Emits `runtime.probe` at most once
   * per REAL probe (never on a cached hit). Returns { healthy, cached, ... }.
   */
  async function probeCached(arn) {
    const until = _healthyUntil.get(arn) || 0;
    if (now() < until) return { healthy: true, cached: true, latencyMs: 0, status: null, error: null };
    const res = await probeRuntime({ arn });
    if (res.healthy) {
      _healthyUntil.set(arn, now() + cacheMs);
      _failures.set(arn, 0);
    } else {
      _healthyUntil.delete(arn);
    }
    await publishEvent(`runtime:${arnTag(arn)}`, "runtime.probe", {
      runtimeArn: arn,
      healthy: res.healthy,
      latencyMs: res.latencyMs,
      cached: false,
    });
    return { ...res, cached: false };
  }

  // ── Outage-state object (S3 CAS) ─────────────────────────────────────────────

  /** Read-modify-write the outage object under IfMatch; re-read + retry once on 412. */
  async function casUpdate(key, mutate) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await s3.getObject(key);
      if (!cur) return null; // recovered/deleted out from under us — nothing to do
      const obj = JSON.parse(cur.body);
      const next = mutate(obj);
      if (next == null) return obj; // no change needed
      try {
        await s3.putObject(key, JSON.stringify(next), { ifMatch: cur.etag });
        return next;
      } catch (err) {
        if (isPreconditionFailed(err) && attempt === 0) continue;
        throw err;
      }
    }
    return null;
  }

  /** Append {workflowId, ticketId} to blockedTickets, deduped, under CAS. */
  async function recordBlockedTicket(key, workflowId, ticketId) {
    await casUpdate(key, (obj) => {
      const list = Array.isArray(obj.blockedTickets) ? obj.blockedTickets : [];
      if (list.some((b) => b.ticketId === ticketId)) return null; // dedupe → no write
      return { ...obj, blockedTickets: [...list, { workflowId, ticketId }] };
    });
  }

  // ── Dispatch guard ───────────────────────────────────────────────────────────

  /**
   * Gate a coding-ticket dispatch on runtime health. Returns
   *   { ok: true }                       — dispatch may proceed
   *   { ok: false, reason: "runtime_outage" } — parked; do NOT dispatch
   *
   * The CALLER decides this ticket needs a coding runtime (roster tools) — this
   * function does not re-check that. Fail-open only when no arn is configured.
   */
  async function runtimeHealthGuard(workflow, ticket) {
    const arn = codingArn();
    if (!arn) return { ok: true }; // no coding runtime configured → nothing to gate
    const key = outageKey(arn);
    const ticketId = ticket?.ticketId || ticket?.id;
    const workflowId = workflow?.id;

    // 1. Known outage → fan it out: record + park this ticket, refuse. One S3 read.
    //    EXCEPTION: an object in `recovering` state means a sweep already re-probed
    //    the runtime HEALTHY and is draining the parked list back through the
    //    cascade (F3). The recovery no longer deletes the object up-front, so a
    //    resumed ticket's re-dispatch can re-enter this guard while the object is
    //    still present — treat recovering as "runtime is up" and let it proceed,
    //    never re-park a ticket we are actively freeing.
    const existing = await s3.getObject(key);
    if (existing) {
      let state = "outage";
      try { state = JSON.parse(existing.body)?.state || "outage"; } catch { /* treat unparseable as outage */ }
      if (state === "recovering") {
        _healthyUntil.set(arn, now() + cacheMs);
        return { ok: true };
      }
      await recordBlockedTicket(key, workflowId, ticketId);
      await blockTicketRuntime(ticketId, workflow);
      return { ok: false, reason: "runtime_outage", detail: "coding runtime outage — ticket parked" };
    }

    // 2. No known outage → probe (cached). Healthy proceeds.
    const probe = await probeCached(arn);
    if (probe.healthy) {
      _failures.set(arn, 0);
      return { ok: true };
    }

    // 3. Unhealthy — CONFIRM consecutive failures before declaring an outage
    //    (a single miss during the microVM's 5-20s cold start must not park work).
    const fails = (_failures.get(arn) || 0) + 1;
    _failures.set(arn, fails);
    if (fails < confirm) {
      log(`[runtime-health] ${ticketId}: probe unhealthy (${fails}/${confirm}) — dispatching, not yet an outage`);
      return { ok: true }; // suspect, not confirmed → let dispatch proceed
    }

    // 4. Confirmed. Exactly one prober wins the IfNoneMatch create → emits the
    //    single runtime.outage + escalation; losers just record their ticket.
    const since = new Date(now()).toISOString();
    const outageEventId = `outage-${arnTag(arn)}-${now()}`;
    const obj = {
      runtimeArn: arn,
      state: "outage",
      since,
      probes: fails,
      backoffIdx: 0,
      nextProbeAt: new Date(now() + backoff[0] * 60000).toISOString(),
      lastError: probe.error || null,
      blockedTickets: [{ workflowId, ticketId }],
      outageEventId,
    };
    let created = false;
    try {
      await s3.putObject(key, JSON.stringify(obj), { ifNoneMatch: "*" });
      created = true;
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      // Lost the create race — another prober owns the outage. Record our ticket.
      await recordBlockedTicket(key, workflowId, ticketId);
    }
    if (created) {
      await publishEvent(ticketId, "runtime.outage", {
        workflowId,
        runtimeArn: arn,
        since,
        lastError: obj.lastError,
        outageEventId,
      });
      if (appendNotificationOnce && workflowId) {
        await appendNotificationOnce(workflowId, {
          id: `notif_runtime_outage_${arnTag(arn)}`,
          type: "manager_escalation",
          title: "Coding runtime outage — coding tickets are parked",
          details:
            `The coding-agent runtime is unreachable (${obj.lastError || "probe failed"}). ` +
            `Coding tickets are parked blocked:runtime and will auto-resume when a probe succeeds ` +
            `(re-probed with backoff ${backoff.join("/")} min). No human action is required unless the outage persists.`,
          reviewer: "runtime-health",
          ticketId,
          timestamp: since,
          acknowledged: false,
        });
      }
      log(`[runtime-health] OUTAGE declared for ${arn} (${obj.lastError})`);
    }
    await blockTicketRuntime(ticketId, workflow);
    return { ok: false, reason: "runtime_outage", detail: "coding runtime outage — ticket parked" };
  }

  // ── Recovery sweep ───────────────────────────────────────────────────────────

  /**
   * Route ONE parked ticket back onto the board and through the ONE cascade R3
   * implementation. Never throws — every per-ticket error is caught and reported
   * so the caller can record it and move on (a resume is idempotent: a ticket
   * already re-dispatched is `running`, which reconcileDependent leaves alone).
   *
   *   { ok:true }                          resumed
   *   { ok:false, terminal:true, reason }  the run/ticket is gone — drop it
   *   { ok:false, terminal:false, reason } transient — keep it for a later retry
   */
  async function resumeTicket(workflowId, ticketId) {
    let wf, ticket;
    try {
      wf = loadWorkflow ? await loadWorkflow(workflowId) : null;
      ticket = wf && loadTicket ? await loadTicket(wf, ticketId) : null;
    } catch (err) {
      return { ok: false, terminal: false, reason: err?.message || String(err) };
    }
    if (!wf || !ticket) return { ok: false, terminal: true, reason: "not_found" };
    try {
      // Un-block the board first (blocked → todo/Ready), then route through the
      // ONE R3 implementation (claim CAS, liveness — never re-implemented here).
      await cascade.transitionToReady(ticket);
      ticket.status = provider === "jira" ? "ready" : "todo";
      await cascade.reconcileDependent(ticket, "runtime-recovered", wf, newCascadeMetrics(), "enforce");
      return { ok: true };
    } catch (err) {
      return { ok: false, terminal: false, reason: err?.message || String(err) };
    }
  }

  /**
   * Claim the recovery lease on the outage object: CAS `state:"recovering"` +
   * a fresh `recoveringAt` under IfMatch on the etag the caller just read. The
   * conditional write IS the lease — two sweeps that both read the same etag
   * both attempt this; exactly one wins, the loser 412s and stands down. Returns
   * { obj, etag } on success, null on a lost race / object gone.
   */
  async function claimRecovering(key, obj, etag) {
    const iso = new Date(now()).toISOString();
    const next = { ...obj, state: "recovering", recoveringAt: iso, recoverStartedAt: obj.recoverStartedAt || iso };
    try {
      const { etag: newEtag } = await s3.putObject(key, JSON.stringify(next), { ifMatch: etag });
      return { obj: next, etag: newEtag };
    } catch (err) {
      if (isPreconditionFailed(err)) return null;
      throw err;
    }
  }

  /**
   * Drain the outage object's blockedTickets, one at a time, holding the recovery
   * lease. After each resumed/dropped ticket the object is re-persisted (IfMatch)
   * so its blockedTickets always reflects the true remainder — if this Lambda
   * crashes or times out mid-drain, whatever was persisted last is exactly the
   * work left, and the recovering marker (+ its refreshed recoveringAt) lets a
   * later sweep continue once the marker goes stale. The object is DELETED and
   * `runtime.recovered` emitted EXACTLY once, only when blockedTickets empties.
   * Transient per-ticket failures are KEPT in blockedTickets (retried by a later
   * recovery); terminal `not_found` tickets are dropped. A non-empty remainder at
   * loop end flips the object back to `state:"outage"` with a short backoff so the
   * runtime is re-probed and the remainder re-driven.
   */
  async function drainResumes(key, claim, out) {
    let etag = claim.etag;
    let remaining = Array.isArray(claim.obj.blockedTickets) ? [...claim.obj.blockedTickets] : [];
    const since = claim.obj.since;
    const resumedIds = [];
    let sincePersist = 0;

    // Persist the current remainder (+ heartbeat recoveringAt) under IfMatch.
    // Returns true on success; false if we lost the lease (a peer re-claimed) —
    // the caller aborts. Throws on infra error → the sweep aborts, object intact.
    const persist = async (extra = {}) => {
      const iso = new Date(now()).toISOString();
      const next = {
        ...claim.obj,
        state: "recovering",
        recoveringAt: iso,
        blockedTickets: remaining,
        ...extra,
      };
      try {
        const { etag: e2 } = await s3.putObject(key, JSON.stringify(next), { ifMatch: etag });
        etag = e2;
        claim.obj = next;
        return true;
      } catch (err) {
        if (isPreconditionFailed(err)) return false; // lost the lease
        throw err;
      }
    };

    let i = 0;
    while (i < remaining.length) {
      const { workflowId, ticketId } = remaining[i];
      const r = await resumeTicket(workflowId, ticketId);
      if (r.ok) {
        resumedIds.push(ticketId);
        out.resumed++;
        remaining.splice(i, 1); // resumed → drop from the remainder
      } else if (r.terminal) {
        out.skipped.push({ ticketId, reason: r.reason });
        remaining.splice(i, 1); // gone → drop (never retry a missing run)
      } else {
        out.skipped.push({ ticketId, reason: r.reason });
        i++; // transient → keep in place, advance past it this pass
        log(`[runtime-health] resume of ${ticketId} deferred (transient): ${r.reason}`);
      }
      if (++sincePersist >= resumePersistEvery) {
        if (!(await persist())) { out.recovering = true; return out; }
        sincePersist = 0;
      }
    }

    if (remaining.length === 0) {
      // Fully drained → the recovery is complete. Delete + announce exactly once.
      await s3.deleteObject(key);
      _healthyUntil.set(codingArn(), now() + cacheMs);
      _failures.set(codingArn(), 0);
      await publishEvent(`runtime:${arnTag(codingArn())}`, "runtime.recovered", {
        runtimeArn: codingArn(),
        since,
        durationMs: now() - Date.parse(since || now()),
        resumed: resumedIds,
      });
      out.recovered = true;
    } else {
      // Transient failures remain → hand back to the outage path with a short
      // backoff so the runtime is re-probed and the remainder re-driven later.
      await persist({ state: "outage", backoffIdx: 0, nextProbeAt: new Date(now() + backoff[0] * 60000).toISOString() });
      out.recovering = false;
      log(`[runtime-health] recovery partial: ${remaining.length} ticket(s) deferred for retry`);
    }
    return out;
  }

  /**
   * F3 backstop: find `blocked:runtime` tickets that have NO outage object driving
   * them (e.g. a prior recovery deleted the object before resuming, or a park
   * outlived its outage), and — only when the runtime probes HEALTHY — resume
   * them. `findRuntimeBlockedTickets` is a BOUNDED scan of the tickets table
   * (index.mjs; there is no status/blockReason GSI). Resumes are idempotent, so a
   * rare concurrent backstop double-run is harmless. Never resumes while the probe
   * is unhealthy (that would just re-park); leaves those for a later healthy sweep.
   */
  async function backstopResume(out) {
    const a = codingArn();
    let stranded = [];
    try {
      stranded = (await findRuntimeBlockedTickets()) || [];
    } catch (err) {
      log(`[runtime-health] backstop scan failed (non-fatal): ${err?.message || err}`);
      return out;
    }
    if (!stranded.length) return out; // nothing stranded → true no-op

    out.probed = 1;
    const probe = await probeRuntime({ arn: a });
    await publishEvent(`runtime:${arnTag(a)}`, "runtime.probe", {
      runtimeArn: a,
      healthy: probe.healthy,
      latencyMs: probe.latencyMs,
      cached: false,
    });
    out.healthy = probe.healthy;
    if (!probe.healthy) {
      out.backstop = { found: stranded.length, resumed: 0, reason: "runtime_unhealthy" };
      return out; // still down — resuming now would only re-park; wait for health
    }

    const resumedIds = [];
    for (const { workflowId, ticketId } of stranded) {
      const r = await resumeTicket(workflowId, ticketId);
      if (r.ok) { out.resumed++; resumedIds.push(ticketId); }
      else out.skipped.push({ ticketId, reason: r.reason });
    }
    out.backstop = { found: stranded.length, resumed: out.resumed };
    if (resumedIds.length) {
      _healthyUntil.set(a, now() + cacheMs);
      _failures.set(a, 0);
      await publishEvent(`runtime:${arnTag(a)}`, "runtime.backstop_resumed", {
        runtimeArn: a,
        resumed: resumedIds,
      });
    }
    return out;
  }

  /**
   * Called from the 5-minute orchestrator.sweep. Three paths:
   *  - No outage object → the F3 BACKSTOP: sweep the tickets table for stranded
   *    `blocked:runtime` tickets and, when the runtime is healthy, resume them.
   *  - Object in `outage` state → honour the backoff, re-probe; still unhealthy
   *    advances the backoff, healthy CLAIMS the recovery lease and drains.
   *  - Object in `recovering` state → a peer sweep owns an active drain; stand
   *    down unless the marker is STALE (crashed/timed-out owner), then re-claim
   *    and continue the remainder.
   *
   * Returns { probed, healthy, resumed, skipped:[...] } (+ recovered/recovering/backstop).
   */
  async function runtimeHealthSweep() {
    const a = codingArn();
    const out = { probed: 0, healthy: null, resumed: 0, skipped: [] };
    if (!a) return out;
    const key = outageKey(a);
    const cur = await s3.getObject(key);
    if (!cur) return await backstopResume(out); // no outage object → backstop
    const obj = JSON.parse(cur.body);

    // Recovery already in progress (F3 lease). Fresh marker → a peer owns it,
    // stand down (idempotency). Stale marker → prior owner crashed; re-claim and
    // continue draining the remainder from where it left off.
    if (obj.state === "recovering") {
      const age = now() - Date.parse(obj.recoveringAt || 0);
      if (age < recoveringStaleMs) {
        out.recovering = true;
        return out;
      }
      const claim = await claimRecovering(key, obj, cur.etag);
      if (!claim) { out.recovering = true; return out; } // lost the re-claim race
      log(`[runtime-health] re-claiming stale recovery for ${a} (age ${age}ms)`);
      return await drainResumes(key, claim, out);
    }

    if (now() < Date.parse(obj.nextProbeAt || 0)) {
      return out; // still backing off — do not probe
    }

    out.probed = 1;
    const probe = await probeRuntime({ arn: a }); // sweep probe is never cached
    await publishEvent(`runtime:${arnTag(a)}`, "runtime.probe", {
      runtimeArn: a,
      healthy: probe.healthy,
      latencyMs: probe.latencyMs,
      cached: false,
    });
    out.healthy = probe.healthy;

    if (!probe.healthy) {
      // Still down — advance the backoff index (last step repeats) under CAS.
      const nextIdx = Math.min((obj.backoffIdx || 0) + 1, backoff.length - 1);
      await casUpdate(key, (o) => ({
        ...o,
        backoffIdx: nextIdx,
        nextProbeAt: new Date(now() + backoff[nextIdx] * 60000).toISOString(),
        lastError: probe.error || o.lastError || null,
        probes: (o.probes || 0) + 1,
      }));
      return out;
    }

    // Recovered. CLAIM the recovery lease (outage→recovering) under IfMatch — the
    // object is NOT deleted up-front any more; it drives the drain and survives a
    // crash. Losing the CAS means a peer sweep already owns the recovery.
    const claim = await claimRecovering(key, obj, cur.etag);
    if (!claim) { out.recovering = true; return out; }
    _healthyUntil.set(a, now() + cacheMs);
    _failures.set(a, 0);
    await publishEvent(`runtime:${arnTag(a)}`, "runtime.recovering", {
      runtimeArn: a,
      since: obj.since,
      blocked: (claim.obj.blockedTickets || []).length,
    });
    return await drainResumes(key, claim, out);
  }

  return { probeRuntime, probeCached, runtimeHealthGuard, runtimeHealthSweep, outageKey, probeSessionId };
}
