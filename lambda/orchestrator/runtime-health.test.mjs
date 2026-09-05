import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRuntimeHealth, outageKey, probeSessionId, parseBackoffMinutes } from "./runtime-health.mjs";

/**
 * TEAM-3992 D4.2 — the coding-runtime health gate + auto-resume.
 *
 * Every effect is injected, so these run with a fake InvokeAgentRuntime, an
 * in-memory S3 that honours ETag / IfNoneMatch / IfMatch (the exactly-once
 * primitive the outage object rides on), a fake publishEvent, and a fake clock.
 * They pin the HARD invariants:
 *   - a healthy probe is cached (no second invoke, no second probe event);
 *   - CONFIRM consecutive failures declare an outage — one miss does NOT;
 *   - the outage is announced EXACTLY once even under a create race (IfNoneMatch);
 *   - every subsequent coding ticket is parked blocked:runtime + deduped;
 *   - the recovery sweep respects the backoff timer, advances backoff (last step
 *     repeats), and on recovery routes each parked ticket through the cascade
 *     exactly once and deletes the object;
 *   - a burst of failures collapses to ONE outage, not N.
 */

const ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/coding-abc";
const KEY = outageKey(ARN);
const START = Date.parse("2026-09-05T12:00:00Z");

/** In-memory S3 honouring IfNoneMatch:"*" (create) and IfMatch:<etag> (CAS). */
function makeS3() {
  const store = new Map();
  let seq = 0;
  const precondition = (msg) => { const e = new Error(msg); e.name = "PreconditionFailed"; return e; };
  return {
    store,
    getObject: vi.fn(async (key) => (store.has(key) ? { ...store.get(key) } : null)),
    putObject: vi.fn(async (key, body, opts = {}) => {
      const cur = store.get(key);
      if (opts.ifNoneMatch === "*" && cur) throw precondition("already exists");
      if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw precondition("etag mismatch");
      const etag = `etag-${++seq}`;
      store.set(key, { body, etag });
      return { etag };
    }),
    deleteObject: vi.fn(async (key) => { store.delete(key); }),
  };
}

function harness(overrides = {}) {
  const s3 = overrides.s3 || makeS3();
  const clock = { ms: START };
  const now = () => clock.ms;
  const events = [];
  const publishEvent = vi.fn(async (subject, type, detail) => { events.push({ subject, type, detail }); });
  const blockTicketRuntime = vi.fn(async () => {});
  const appendNotificationOnce = vi.fn(async () => true);
  const invokeRuntime = overrides.invokeRuntime || vi.fn(async () => ({ statusCode: 200, json: { status: "unknown" } }));
  const cascade = overrides.cascade || {
    reconcileDependent: vi.fn(async () => ({ outcome: "redispatched", reason: "dispatchable" })),
    transitionToReady: vi.fn(async () => {}),
  };
  const loadWorkflow = overrides.loadWorkflow || vi.fn(async (id) => ({ id, epicId: "EPIC-1" }));
  const loadTicket = overrides.loadTicket || vi.fn(async (wf, ticketId) => ({ ticketId, status: "blocked", assignee: "agentcore_hub_backend_dev" }));
  const env = {
    CODING_AGENT_RUNTIME_ARN: ARN,
    TICKET_PROVIDER: "dynamodb",
    RUNTIME_PROBE_CONFIRM: "2",
    RUNTIME_PROBE_CACHE_MS: "60000",
    RUNTIME_OUTAGE_BACKOFF_MIN: "5,15,30",
    ...overrides.env,
  };
  const rh = createRuntimeHealth({
    invokeRuntime, s3, publishEvent, now, env,
    blockTicketRuntime, appendNotificationOnce, cascade, loadWorkflow, loadTicket,
  });
  const outage = () => (s3.store.has(KEY) ? JSON.parse(s3.store.get(KEY).body) : null);
  const eventsOfType = (t) => events.filter((e) => e.type === t);
  return { rh, s3, clock, now, events, eventsOfType, publishEvent, blockTicketRuntime, appendNotificationOnce, invokeRuntime, cascade, outage, env };
}

const wf = { id: "wf_1", epicId: "EPIC-1" };
const ticket = (id) => ({ ticketId: id, assignee: "agentcore_hub_backend_dev", status: "ready" });

describe("probeSessionId / parseBackoffMinutes", () => {
  it("mints a stable session id ≥33 chars", () => {
    const sid = probeSessionId(ARN);
    expect(sid.startsWith("probe-orchestrator-")).toBe(true);
    expect(sid.length).toBeGreaterThanOrEqual(33);
    expect(probeSessionId(ARN)).toBe(sid); // stable
  });
  it("parses a backoff list and falls back on garbage", () => {
    expect(parseBackoffMinutes("5,15,30")).toEqual([5, 15, 30]);
    expect(parseBackoffMinutes("")).toEqual([5, 15, 30]);
    expect(parseBackoffMinutes("junk")).toEqual([5, 15, 30]);
    expect(parseBackoffMinutes("2,4")).toEqual([2, 4]);
  });
});

describe("runtimeHealthGuard — healthy path", () => {
  it("a healthy probe passes and is cached (no second invoke, no second probe event)", async () => {
    const h = harness();
    expect(await h.rh.runtimeHealthGuard(wf, ticket("T-1"))).toEqual({ ok: true });
    expect(h.invokeRuntime).toHaveBeenCalledTimes(1);
    expect(h.eventsOfType("runtime.probe")).toHaveLength(1);

    // Second dispatch within the cache window: cached healthy, no work.
    expect(await h.rh.runtimeHealthGuard(wf, ticket("T-2"))).toEqual({ ok: true });
    expect(h.invokeRuntime).toHaveBeenCalledTimes(1);
    expect(h.eventsOfType("runtime.probe")).toHaveLength(1);
    expect(h.outage()).toBeNull();
  });

  it("fails OPEN when no runtime ARN is configured (gate dark)", async () => {
    const h = harness({ env: { CODING_AGENT_RUNTIME_ARN: "" } });
    expect(await h.rh.runtimeHealthGuard(wf, ticket("T-1"))).toEqual({ ok: true });
    expect(h.invokeRuntime).not.toHaveBeenCalled();
  });

  it("treats any poll status in the vocabulary at HTTP 200 as healthy", async () => {
    for (const status of ["unknown", "done", "running", "dead", "transient"]) {
      const h = harness({ invokeRuntime: vi.fn(async () => ({ statusCode: 200, json: { status } })) });
      expect(await h.rh.runtimeHealthGuard(wf, ticket("T-1"))).toEqual({ ok: true });
    }
  });
});

describe("runtimeHealthGuard — CONFIRM before declaring outage", () => {
  it("one failure is suspect (dispatch proceeds); the CONFIRMth declares an outage", async () => {
    const invokeRuntime = vi.fn(async () => { throw new Error("connect timeout"); });
    const h = harness({ invokeRuntime });

    // 1st failure: below CONFIRM=2 → let dispatch proceed, no outage yet.
    expect(await h.rh.runtimeHealthGuard(wf, ticket("T-1"))).toEqual({ ok: true });
    expect(h.outage()).toBeNull();
    expect(h.eventsOfType("runtime.outage")).toHaveLength(0);

    // 2nd consecutive failure: declare the outage.
    const verdict = await h.rh.runtimeHealthGuard(wf, ticket("T-2"));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("runtime_outage");
    const obj = h.outage();
    expect(obj).toMatchObject({ state: "outage", runtimeArn: ARN, backoffIdx: 0 });
    expect(obj.blockedTickets).toEqual([{ workflowId: "wf_1", ticketId: "T-2" }]);
    expect(h.eventsOfType("runtime.outage")).toHaveLength(1);
    expect(h.blockTicketRuntime).toHaveBeenCalledWith("T-2", wf);
    expect(h.appendNotificationOnce).toHaveBeenCalledTimes(1);
    // nextProbeAt is now + 5 min (backoff[0]).
    expect(Date.parse(obj.nextProbeAt)).toBe(START + 5 * 60000);
  });

  it("a healthy probe between failures resets the consecutive-failure count", async () => {
    let healthy = false;
    const invokeRuntime = vi.fn(async () => (healthy ? { statusCode: 200, json: { status: "unknown" } } : Promise.reject(new Error("down"))));
    const h = harness({ invokeRuntime });
    await h.rh.runtimeHealthGuard(wf, ticket("T-1")); // fail 1
    healthy = true;
    h.clock.ms += 61000; // expire the healthy cache so it re-probes
    await h.rh.runtimeHealthGuard(wf, ticket("T-2")); // healthy → reset
    healthy = false;
    h.clock.ms += 61000;
    expect(await h.rh.runtimeHealthGuard(wf, ticket("T-3"))).toEqual({ ok: true }); // fail 1 again, not 2
    expect(h.outage()).toBeNull();
  });
});

describe("runtimeHealthGuard — outage fan-out + dedupe", () => {
  it("once an outage object exists, tickets are parked without re-probing, deduped", async () => {
    const invokeRuntime = vi.fn(async () => { throw new Error("down"); });
    const h = harness({ invokeRuntime, env: { RUNTIME_PROBE_CONFIRM: "1" } });

    // Declare the outage on the first coding ticket.
    await h.rh.runtimeHealthGuard(wf, ticket("T-1"));
    expect(h.outage()).not.toBeNull();
    const probeCalls = invokeRuntime.mock.calls.length;

    // Subsequent tickets: parked, recorded, NO further probe.
    const v = await h.rh.runtimeHealthGuard(wf, ticket("T-2"));
    expect(v).toMatchObject({ ok: false, reason: "runtime_outage" });
    expect(invokeRuntime.mock.calls.length).toBe(probeCalls); // no re-probe
    expect(h.outage().blockedTickets.map((b) => b.ticketId)).toEqual(["T-1", "T-2"]);

    // Same ticket again → deduped (no duplicate entry).
    await h.rh.runtimeHealthGuard(wf, ticket("T-2"));
    expect(h.outage().blockedTickets.map((b) => b.ticketId)).toEqual(["T-1", "T-2"]);
    expect(h.eventsOfType("runtime.outage")).toHaveLength(1);
  });

  it("exactly ONE runtime.outage under a create race (both PUT IfNoneMatch, one 412s)", async () => {
    // Two probers sharing ONE S3, driven concurrently with Promise.all so both
    // pass the step-1 "is there an outage?" read (store empty) BEFORE either
    // creates — the genuine race the IfNoneMatch create defends against. The
    // loser's PutObject then 412s and it falls to the recordBlockedTicket path.
    const s3 = makeS3();
    const a = harness({ s3, invokeRuntime: vi.fn(async () => { throw new Error("down"); }), env: { RUNTIME_PROBE_CONFIRM: "1" } });
    const b = harness({ s3, invokeRuntime: vi.fn(async () => { throw new Error("down"); }), env: { RUNTIME_PROBE_CONFIRM: "1" } });
    // Share ONE event sink so we can count across both probers.
    const events = [];
    a.publishEvent.mockImplementation(async (s, t) => events.push({ t }));
    b.publishEvent.mockImplementation(async (s, t) => events.push({ t }));

    const [va, vb] = await Promise.all([
      a.rh.runtimeHealthGuard({ id: "wf_a", epicId: "E" }, ticket("A-1")),
      b.rh.runtimeHealthGuard({ id: "wf_b", epicId: "E" }, ticket("B-1")),
    ]);
    expect(va.ok).toBe(false);
    expect(vb.ok).toBe(false);
    // Exactly one create won → exactly one outage event, and the loser's 412
    // fell through to recordBlockedTicket, so BOTH tickets are parked.
    expect(events.filter((e) => e.t === "runtime.outage")).toHaveLength(1);
    const putAttempts = s3.putObject.mock.calls.filter((c) => c[2]?.ifNoneMatch === "*").length;
    expect(putAttempts).toBe(2); // both attempted the create (shared S3)
    const obj = JSON.parse(s3.store.get(KEY).body);
    expect(obj.blockedTickets.map((x) => x.ticketId).sort()).toEqual(["A-1", "B-1"]);
  });

  it("a burst of 25 failing coding tickets collapses to ONE outage, not 25", async () => {
    const invokeRuntime = vi.fn(async () => { throw new Error("down"); });
    const h = harness({ invokeRuntime, env: { RUNTIME_PROBE_CONFIRM: "1" } });
    for (let i = 0; i < 25; i++) {
      const v = await h.rh.runtimeHealthGuard(wf, ticket(`T-${i}`));
      expect(v.ok).toBe(false);
    }
    expect(h.eventsOfType("runtime.outage")).toHaveLength(1);
    expect(h.outage().blockedTickets).toHaveLength(25);
    // Only the first CONFIRM probe(s) actually invoked the runtime — the rest
    // short-circuit on the existing outage object.
    expect(invokeRuntime).toHaveBeenCalledTimes(1);
  });
});

describe("runtimeHealthSweep — backoff + recovery", () => {
  async function armOutage(confirm = "1") {
    const invokeRuntime = vi.fn(async () => { throw new Error("down"); });
    const h = harness({ invokeRuntime, env: { RUNTIME_PROBE_CONFIRM: confirm } });
    await h.rh.runtimeHealthGuard(wf, ticket("T-1"));
    await h.rh.runtimeHealthGuard({ id: "wf_2", epicId: "EPIC-1" }, ticket("T-2"));
    return h;
  }

  it("does not probe before nextProbeAt", async () => {
    const h = await armOutage();
    h.invokeRuntime.mockClear();
    const res = await h.rh.runtimeHealthSweep(); // now < nextProbeAt (5 min out)
    expect(res).toEqual({ probed: 0, healthy: null, resumed: 0, skipped: [] });
    expect(h.invokeRuntime).not.toHaveBeenCalled();
  });

  it("advances the backoff 5→15→30→30 while still unhealthy (last step repeats)", async () => {
    const h = await armOutage();
    const expected = [15, 30, 30]; // after idx 0→1→2→2
    let base = START;
    for (let i = 0; i < 3; i++) {
      const obj = h.outage();
      h.clock.ms = Date.parse(obj.nextProbeAt); // jump to the scheduled probe
      base = h.clock.ms;
      const res = await h.rh.runtimeHealthSweep();
      expect(res.probed).toBe(1);
      expect(res.healthy).toBe(false);
      const after = h.outage();
      expect(Date.parse(after.nextProbeAt)).toBe(base + expected[i] * 60000);
    }
    expect(h.outage().backoffIdx).toBe(2);
  });

  it("on recovery: emits runtime.recovered, resumes each ticket once, deletes the object", async () => {
    const h = await armOutage();
    // Flip the runtime healthy for the sweep probe.
    h.invokeRuntime.mockImplementation(async () => ({ statusCode: 200, json: { status: "unknown" } }));
    const obj = h.outage();
    h.clock.ms = Date.parse(obj.nextProbeAt);

    const res = await h.rh.runtimeHealthSweep();
    expect(res.healthy).toBe(true);
    expect(res.resumed).toBe(2);
    expect(res.skipped).toEqual([]);
    expect(h.eventsOfType("runtime.recovered")).toHaveLength(1);
    expect(h.eventsOfType("runtime.recovered")[0].detail.resumed.sort()).toEqual(["T-1", "T-2"]);
    // Each parked ticket routed through the ONE cascade implementation, once.
    expect(h.cascade.reconcileDependent).toHaveBeenCalledTimes(2);
    expect(h.cascade.transitionToReady).toHaveBeenCalledTimes(2);
    // Object deleted BEFORE resume so the guard can't re-park a freed ticket.
    expect(h.outage()).toBeNull();
  });

  it("a no-op sweep is a single S3 head when no outage is open", async () => {
    const h = harness();
    const res = await h.rh.runtimeHealthSweep();
    expect(res).toEqual({ probed: 0, healthy: null, resumed: 0, skipped: [] });
    expect(h.s3.getObject).toHaveBeenCalledTimes(1);
    expect(h.invokeRuntime).not.toHaveBeenCalled();
  });
});
