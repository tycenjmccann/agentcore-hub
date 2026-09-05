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
    log = () => {},
  } = deps;

  const cacheMs = Number(env.RUNTIME_PROBE_CACHE_MS) || DEFAULT_PROBE_CACHE_MS;
  const confirm = Math.max(1, Number(env.RUNTIME_PROBE_CONFIRM) || DEFAULT_PROBE_CONFIRM);
  const backoff = parseBackoffMinutes(env.RUNTIME_OUTAGE_BACKOFF_MIN);
  const provider = env.TICKET_PROVIDER || "dynamodb";

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
    const existing = await s3.getObject(key);
    if (existing) {
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
   * Called from the 5-minute orchestrator.sweep. When an outage object exists and
   * its backoff timer has elapsed, re-probe. Still unhealthy → advance backoff.
   * Healthy → emit runtime.recovered, delete the object, and route every parked
   * ticket back through the ONE cascade R3 implementation.
   *
   * Returns { probed, healthy, resumed, skipped:[...] }.
   */
  async function runtimeHealthSweep() {
    const arn = codingArn();
    const out = { probed: 0, healthy: null, resumed: 0, skipped: [] };
    if (!arn) return out;
    const key = outageKey(arn);
    const cur = await s3.getObject(key);
    if (!cur) return out; // no outage in progress
    const obj = JSON.parse(cur.body);

    if (now() < Date.parse(obj.nextProbeAt || 0)) {
      return out; // still backing off — do not probe
    }

    out.probed = 1;
    const probe = await probeRuntime({ arn }); // sweep probe is never cached
    await publishEvent(`runtime:${arnTag(arn)}`, "runtime.probe", {
      runtimeArn: arn,
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

    // Recovered. Capture the parked list, announce, then DELETE the object BEFORE
    // resuming — otherwise each resume re-enters runtimeHealthGuard, sees the
    // still-present object, and re-parks the very ticket we are freeing.
    const blocked = Array.isArray(obj.blockedTickets) ? obj.blockedTickets : [];
    const durationMs = now() - Date.parse(obj.since || now());
    _healthyUntil.set(arn, now() + cacheMs);
    _failures.set(arn, 0);
    await publishEvent(`runtime:${arnTag(arn)}`, "runtime.recovered", {
      runtimeArn: arn,
      since: obj.since,
      durationMs,
      resumed: blocked.map((b) => b.ticketId),
    });
    await s3.deleteObject(key);

    for (const { workflowId, ticketId } of blocked) {
      try {
        const wf = loadWorkflow ? await loadWorkflow(workflowId) : null;
        const ticket = wf && loadTicket ? await loadTicket(wf, ticketId) : null;
        if (!wf || !ticket) {
          out.skipped.push({ ticketId, reason: "not_found" });
          continue;
        }
        // Un-block the board first (blocked → todo/Ready), then route through the
        // ONE R3 implementation (claim CAS, liveness — never re-implemented here).
        await cascade.transitionToReady(ticket);
        ticket.status = provider === "jira" ? "ready" : "todo";
        await cascade.reconcileDependent(ticket, "runtime-recovered", wf, newCascadeMetrics(), "enforce");
        out.resumed++;
      } catch (err) {
        out.skipped.push({ ticketId, reason: err?.message || String(err) });
        log(`[runtime-health] resume of ${ticketId} failed (non-fatal): ${err?.message || err}`);
      }
    }
    return out;
  }

  return { probeRuntime, probeCached, runtimeHealthGuard, runtimeHealthSweep, outageKey, probeSessionId };
}
