import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  canonicalJson, createProofKeyLoader, offenderSetHash, verifyCloseoutOverride, closeoutOverrideMatches,
  liveGateOf, gateDecisionStands, verifyMergeApprovalRecord, closeoutOffenderIds, standingGateDecision,
} from "./proof-record-verify.mjs";
import { completionRecordHasEvidence } from "./completion.mjs";
// The twins' writers: what they sign, this verifier must accept (and nothing else).
import { buildGateDecisionRecord, buildMergeApprovalRecord } from "../agentcore-hub-tickets/gate-contract.mjs";
import { parseGateScope as twinParseGateScope } from "../agentcore-hub-tickets/decision-contract.mjs";
import { parseGateScope } from "./proof-record-verify.mjs";

/**
 * TEAM-5367 / DL-036 — the shared proof-record verifier (byte-copied into
 * cost-report and pipeline-tools; scripts/sibling-copies.json). Unverifiable =
 * absent, for all three records.
 */
const KEY = "test-gate-key";
const PREV = "rotated-out-key";
const sign = (rec, key = KEY) => ({ ...rec, sig: createHmac("sha256", key).update(canonicalJson(rec)).digest("base64url") });
const override = (offenders, { key = KEY, ...extra } = {}) => JSON.stringify(sign({
  by: "human:ops", reason: "stopped run", offenders: [...new Set(offenders)].sort(), at: "2026-10-06T00:00:00Z",
  v: 1, kind: "closeout-override", workflowId: "wf_1", offenderSetHash: offenderSetHash(offenders), ...extra,
}, key));

describe("createProofKeyLoader", () => {
  it("returns [current, previous], caches for ttl, and does not cache a failure", async () => {
    let t = 0;
    let fail = true;
    const reads = [];
    const load = createProofKeyLoader({
      ttlMs: 10, now: () => t,
      readStage: async (stage) => { reads.push(stage); if (fail) throw Object.assign(new Error("x"), { name: "AccessDeniedException" }); return stage === "AWSCURRENT" ? KEY : PREV; },
    });
    expect(await load()).toEqual({ ok: false, why: "decision_key_unavailable (AccessDeniedException)" });
    fail = false;
    expect(await load()).toEqual({ ok: true, keys: [KEY, PREV] });
    const n = reads.length;
    expect(await load()).toEqual({ ok: true, keys: [KEY, PREV] });
    expect(reads).toHaveLength(n); // cached
    t = 11;
    await load();
    expect(reads.length).toBeGreaterThan(n);
  });

  it("no AWSPREVIOUS yet is not a failure; an empty AWSCURRENT is", async () => {
    const one = createProofKeyLoader({ readStage: async (s) => { if (s !== "AWSCURRENT") throw new Error("none"); return KEY; } });
    expect(await one()).toEqual({ ok: true, keys: [KEY] });
    const none = createProofKeyLoader({ readStage: async () => null });
    expect((await none()).ok).toBe(false);
  });
});

describe("verifyCloseoutOverride", () => {
  it("a record signed with the current or the previous key verifies to the shared fields", () => {
    for (const key of [KEY, PREV]) {
      expect(verifyCloseoutOverride(override(["T-2", "T-1"], { key }), [KEY, PREV], "wf_1")).toEqual({
        by: "human:ops", reason: "stopped run", offenders: ["T-1", "T-2"], at: "2026-10-06T00:00:00Z", offenderSetHash: offenderSetHash(["T-1", "T-2"]),
      });
    }
  });

  const good = JSON.parse(override(["T-1"]));
  it.each([
    ["absent", null],
    ["an object, not raw text", good],
    ["unparseable", "{nope"],
    ["unsigned (the TEAM-5359 shape)", JSON.stringify({ by: "h", reason: "r", offenders: [], at: "t" })],
    ["sig \"invalid\"", JSON.stringify({ ...good, sig: "invalid" })],
    ["signed with another key", override(["T-1"], { key: "other" })],
    ["workflowId \"wrong\"", override(["T-1"], { workflowId: "wrong" })],
    ["offenders edited after signing", JSON.stringify({ ...good, offenders: ["T-1", "T-2"] })],
    ["a hash that is not its own offenders'", override(["T-1"], { offenderSetHash: offenderSetHash(["T-9"]) })],
    ["another kind", override(["T-1"], { kind: "gate-decision" })],
    ["another version", override(["T-1"], { v: 2 })],
    ["blank reason", override(["T-1"], { reason: " " })],
  ])("%s → null", (_n, raw) => {
    expect(verifyCloseoutOverride(raw, [KEY], "wf_1")).toBeNull();
  });

  it("no keys → null", () => {
    expect(verifyCloseoutOverride(override(["T-1"]), [], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(override(["T-1"]), null, "wf_1")).toBeNull();
  });

  it("closeoutOverrideMatches is set EQUALITY (order and duplicates ignored)", () => {
    const o = verifyCloseoutOverride(override(["T-1", "T-2"]), [KEY], "wf_1");
    expect(closeoutOverrideMatches(o, ["T-2", "T-1", "T-1"])).toBe(true);
    expect(closeoutOverrideMatches(o, ["T-1"])).toBe(false); // the override is a superset
    expect(closeoutOverrideMatches(o, ["T-1", "T-2", "T-3"])).toBe(false); // a subset
    expect(closeoutOverrideMatches(null, [])).toBe(false);
  });
});

describe("gate decisions: verify against the twin's own builder, bound to the live gate", () => {
  const SCOPE = `gate-scope: {"round":2,"headSha":"${"b".repeat(40)}","findingIds":["T-1:0123abcd"]}`;
  const CYCLE = "2026-10-05T00:00:00.000Z";
  const build = (p = {}, key = KEY) => buildGateDecisionRecord({
    ticketId: "G-1", workflowId: "wf_1", decision: { option: "approve", channel: "console", by: "human:ops" },
    labels: [], description: SCOPE, cycle: CYCLE, ...p,
  }, key);
  const live = (p = {}) => liveGateOf(JSON.stringify({ key: "G-1", fields: { description: SCOPE }, gateCycle: CYCLE, ...p }));

  it("parseGateScope is the twin's", () => {
    for (const d of [SCOPE, "", "gate-scope: {bad", `${SCOPE}\ngate-scope: {"round":0}`]) expect(parseGateScope(d)).toEqual(twinParseGateScope(d));
  });

  it("a record the twin signed in the current cycle over the current scope stands", () => {
    expect(gateDecisionStands(build(), [KEY], { workflowId: "wf_1", ticketId: "G-1", live: live() })).toMatchObject({ ok: true });
    const stopped = build({ decision: { option: "stopped", channel: "console", by: "human:ops" } });
    expect(gateDecisionStands(stopped, [KEY], { workflowId: "wf_1", ticketId: "G-1", live: live() })).toMatchObject({ ok: true, record: { status: "cancelled" } });
  });

  it("a never-reset gate (gateCycle null) matches a record with cycle null", () => {
    expect(gateDecisionStands(build({ cycle: null }), [KEY], { workflowId: "wf_1", ticketId: "G-1", live: live({ gateCycle: null }) }).ok).toBe(true);
  });

  it.each([
    ["forged", { ...build(), sig: "AAAA" }, {}, "unverified"],
    ["signed with another key", build({}, "other"), {}, "unverified"],
    ["status edited to done on a stopped record", { ...build({ decision: { option: "stopped", channel: "c", by: "h" } }), status: "done" }, {}, "unverified"],
    ["another run's", build({ workflowId: "wf_other" }), {}, "wrong_run"],
    ["another ticket's", build({ ticketId: "G-2" }), {}, "wrong_run"],
    ["a stale cycle", build(), { gateCycle: "2026-10-06T00:00:00.000Z" }, "stale_cycle"],
    ["a reset since a never-reset record", build({ cycle: null }), {}, "stale_cycle"],
    ["a moved scope", build(), { fields: { description: "" } }, "scope_moved"],
  ])("%s → %s", (_n, rec, liveOver, why) => {
    expect(gateDecisionStands(rec, [KEY], { workflowId: "wf_1", ticketId: "G-1", live: live(liveOver) })).toEqual({ ok: false, why: expect.stringContaining(why) });
  });

  it("an unknown cycle (gateCycle omitted, or get_issue unreadable / refusing) → cycle_unknown", () => {
    const { gateCycle, ...noCycle } = { key: "G-1", fields: { description: SCOPE }, gateCycle: CYCLE };
    for (const p of [liveGateOf(noCycle), liveGateOf(null), liveGateOf("{x"), liveGateOf({ content: [{ text: "Issue G-1 not found." }] }), liveGateOf({ error: "boom" })]) {
      expect(gateDecisionStands(build(), [KEY], { workflowId: "wf_1", ticketId: "G-1", live: p }).why).toBe("cycle_unknown");
    }
  });

  it("liveGateOf reads raw Lambda Payload bytes too", () => {
    expect(liveGateOf(new TextEncoder().encode(JSON.stringify({ key: "G-1", gateCycle: null })))).toEqual({ ticketId: "G-1", cycle: null, scope: null });
  });
});

describe("verifyMergeApprovalRecord", () => {
  const build = (p = {}, key = KEY) => buildMergeApprovalRecord({
    ticketId: "M-1", workflowId: "wf_1", decision: { option: "approve", channel: "console", by: "human:ops" },
    labels: [`gate-head:${"c".repeat(40)}`], ...p,
  }, key);
  it("the twin's record verifies; forged, other-key, edited head or another run's does not", () => {
    expect(verifyMergeApprovalRecord(build(), [KEY], { workflowId: "wf_1" })).toBe(true);
    expect(verifyMergeApprovalRecord({ ...build(), sig: "invalid" }, [KEY], { workflowId: "wf_1" })).toBe(false);
    expect(verifyMergeApprovalRecord(build({}, "other"), [KEY], { workflowId: "wf_1" })).toBe(false);
    expect(verifyMergeApprovalRecord({ ...build(), headSha: "d".repeat(40) }, [KEY], { workflowId: "wf_1" })).toBe(false);
    expect(verifyMergeApprovalRecord(build({ workflowId: "wf_other" }), [KEY], { workflowId: "wf_1" })).toBe(false);
    expect(verifyMergeApprovalRecord(build(), [], { workflowId: "wf_1" })).toBe(false);
  });
});

describe("closeoutOffenderIds (port of closeout-offenders.ts closeoutReview)", () => {
  const PHASES = { agentcore_hub_backend_dev: "development", agentcore_hub_qa_verifier: "verification", agentcore_hub_ci_agent: "review" };
  const deps = (objects, live = {}) => ({
    workflowId: "wf_1", keys: [KEY], phaseOf: (t) => t.phase || PHASES[t.assignee], hasEvidence: completionRecordHasEvidence,
    readJson: async (k) => objects[k] ?? null, liveGate: async (tid) => live[tid] ?? null,
  });
  const roster = [
    { ticketId: "T-1", parentId: "E", assignee: "agentcore_hub_backend_dev", status: "done" },
    { ticketId: "T-2", parentId: "E", assignee: "agentcore_hub_qa_verifier", status: "done" },
    { ticketId: "T-3", parentId: "E", assignee: "agentcore_hub_ci_agent", status: "done" },
    { ticketId: "T-4", parentId: "E", assignee: "agentcore_hub_security_reviewer", status: "done" },
    { ticketId: "T-5", parentId: "E", assignee: "agentcore_hub_ci_agent", status: "cancelled" },
    { ticketId: "E", type: "epic", assignee: "agentcore_hub_ci_agent", status: "done" },
  ];

  it("missing ∪ unbacked done gate-class tickets, sorted; non-gate, cancelled and epics never", async () => {
    expect(await closeoutOffenderIds(roster, { ...deps({}), missingIds: ["T-1"] })).toEqual(["T-1", "T-2", "T-3", "T-4"]);
  });

  it("an agent gate is backed by its own record; a console record or another agent's is not", async () => {
    const objects = {
      "completions/T-2.json": { summary: "ok", agent_id: "agentcore_hub_qa_verifier" },
      "completions/T-3.json": { summary: "ok", source: "workflow-manager" },
      "completions/T-4.json": { summary: "ok", agentId: "agentcore_hub_ci_agent" },
    };
    expect(await closeoutOffenderIds(roster, deps(objects))).toEqual(["T-3", "T-4"]);
  });

  it("a sweep skip is backed only by a same-parent sweeper that is done", async () => {
    const skip = { evidence_kind: "skipped", skipped: true, workflowId: "wf_1", summary: "skipped by T-1" };
    expect(await closeoutOffenderIds(roster, deps({ "completions/T-2.json": skip }))).toEqual(["T-3", "T-4"]);
    expect(await closeoutOffenderIds(roster, deps({ "completions/T-2.json": { ...skip, summary: "skipped by T-9" } }))).toContain("T-2");
  });

  it("a human gate is backed only by a decision record that stands now", async () => {
    const gate = { ticketId: "G-1", parentId: "E", assignee: "human:ops", status: "done" };
    const rec = buildGateDecisionRecord({ ticketId: "G-1", workflowId: "wf_1", decision: { option: "approve", channel: "console", by: "human:ops" }, labels: [], cycle: null }, KEY);
    const objects = { "pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json": rec };
    const ids = (live) => closeoutOffenderIds([gate], deps(objects, { "G-1": live }));
    expect(await ids({ key: "G-1", gateCycle: null })).toEqual([]);
    expect(await ids({ key: "G-1", gateCycle: "2026-10-06T00:00:00.000Z" })).toEqual(["G-1"]);
    expect(await ids({ key: "G-1" })).toEqual(["G-1"]);
    const stopped = buildGateDecisionRecord({ ticketId: "G-1", workflowId: "wf_1", decision: { option: "stopped", channel: "console", by: "human:ops" }, labels: [] }, KEY);
    expect(await closeoutOffenderIds([gate], deps({ "pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json": stopped }, { "G-1": { key: "G-1", gateCycle: null } }))).toEqual(["G-1"]);
  });

  it("no gate record → no get_issue call", async () => {
    const calls = [];
    const d = { ...deps({}), liveGate: async (t) => { calls.push(t); return null; } };
    expect(await closeoutOffenderIds([{ ticketId: "G-1", assignee: "human:ops", status: "done" }], d)).toEqual(["G-1"]);
    expect(calls).toEqual([]);
  });
});

describe("standingGateDecision (TEAM-5395 F6: the one read close-out and the blocker rule share)", () => {
  const KEY_OF = "pipeline-artifacts/gate-decisions/wf_1/gates/G-1.json";
  const rec = (option = "approve") => buildGateDecisionRecord({ ticketId: "G-1", workflowId: "wf_1", decision: { option, channel: "console", by: "human:ops" }, labels: [], cycle: null }, KEY);
  const run = (objects, live = { key: "G-1", gateCycle: null }, calls = []) => standingGateDecision("G-1", {
    workflowId: "wf_1", keys: [KEY], readJson: async (k) => objects[k] ?? null, liveGate: async (t) => { calls.push(t); return live; },
  });

  it("absent record → absent, and the live gate is never read", async () => {
    const calls = [];
    expect(await run({}, undefined, calls)).toEqual({ ok: false, why: "absent" });
    expect(calls).toEqual([]);
  });

  it("a signed record in the current cycle stands (approve → done, stopped → cancelled)", async () => {
    expect(await run({ [KEY_OF]: rec() })).toMatchObject({ ok: true, record: { status: "done" } });
    expect(await run({ [KEY_OF]: rec("stopped") })).toMatchObject({ ok: true, record: { status: "cancelled" } });
  });

  it("stale cycle / unreadable live gate / forged record do not stand", async () => {
    expect(await run({ [KEY_OF]: rec() }, { key: "G-1", gateCycle: "2026-10-06T00:00:00.000Z" })).toEqual({ ok: false, why: "stale_cycle" });
    expect(await run({ [KEY_OF]: rec() }, null)).toEqual({ ok: false, why: "cycle_unknown" });
    expect(await run({ [KEY_OF]: { ...rec(), sig: "AAAA" } })).toEqual({ ok: false, why: "unverified" });
  });

  it("a read error propagates (the caller's catch = does not stand)", async () => {
    await expect(standingGateDecision("G-1", { workflowId: "wf_1", keys: [KEY], readJson: async () => { throw new Error("S3 down"); }, liveGate: async () => null }))
      .rejects.toThrow("S3 down");
  });
});
