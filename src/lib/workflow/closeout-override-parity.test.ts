import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCloseoutOverride,
  closeoutOverrideMatches as matchesTs,
  offenderSetHash as hashTs,
  verifyCloseoutOverride as verifyTs,
} from "./closeout-override";
import { gateDecisionStands as standsTs, liveGateOf as liveTs } from "./gate-decision-record";
import { closeoutReview, type CloseoutTicket } from "./closeout-offenders";
import { completionRecordHasEvidence, COMPLETION_BLOCKED_NOTIF_RE } from "../../../lambda/orchestrator/completion.mjs";
// TEAM-5367 / DL-036: the orchestrator, cost-report and pipeline-tools cannot import
// the hub, so each verifies proof records with a byte copy of ONE zero-import module.
// A drift here means a run the hub would refuse completes at the orchestrator (or the
// reverse), or a forged record that one side rejects the other accepts.
import {
  closeoutOffenderIds,
  closeoutOverrideMatches as matchesMjs,
  gateDecisionStands as standsMjs,
  liveGateOf as liveMjs,
  offenderSetHash as hashMjs,
  verifyCloseoutOverride as verifyMjs,
} from "../../../lambda/orchestrator/proof-record-verify.mjs";
import { buildGateDecisionRecord } from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";

const KEY = "closeout-override-parity-key";
const WF = "wf_1";
const j = (v: unknown) => JSON.stringify(v);
const valid = buildCloseoutOverride({ workflowId: WF, by: "eng@example.com", reason: "known gap", offenders: ["T-2", "T-1"] }, KEY);
const other = buildCloseoutOverride({ workflowId: WF, by: "eng@example.com", reason: "known gap", offenders: ["T-1"] }, "another-key");
const { sig: _sig, ...unsigned } = valid;

describe("closeout override — TS buildCloseoutOverride verified by TS and .mjs alike", () => {
  const MATRIX: Array<[string, string | null, readonly string[] | null, string, boolean]> = [
    ["valid", j(valid), [KEY], WF, true],
    ["valid under a rotated key list", j(valid), ["old", KEY], WF, true],
    ["another key", j(other), [KEY], WF, false],
    ["another run", j(valid), [KEY], "wf_2", false],
    ["sig 'invalid'", j({ ...valid, sig: "invalid" }), [KEY], WF, false],
    ["unsigned", j(unsigned), [KEY], WF, false],
    ["offenders edited", j({ ...valid, offenders: ["T-1"] }), [KEY], WF, false],
    ["offenders edited, hash recomputed", j({ ...valid, offenders: ["T-1"], offenderSetHash: hashTs(["T-1"]) }), [KEY], WF, false],
    ["reason edited", j({ ...valid, reason: "other" }), [KEY], WF, false],
    ["wrong version", j({ ...valid, v: 2 }), [KEY], WF, false],
    ["wrong kind", j({ ...valid, kind: "gate-decision" }), [KEY], WF, false],
    ["legacy unsigned shape", j({ by: "x", reason: "y", offenders: ["T-1"], at: "z" }), [KEY], WF, false],
    ["unparseable", "{not json", [KEY], WF, false],
    ["absent", null, [KEY], WF, false],
    ["no keys", j(valid), null, WF, false],
    ["empty key list", j(valid), [], WF, false],
  ];

  it.each(MATRIX)("%s", (_name, raw, keys, wf, accepted) => {
    const ts = verifyTs(raw, keys, wf);
    const mjs = verifyMjs(raw, keys, wf);
    expect(Boolean(ts)).toBe(accepted);
    expect(mjs).toStrictEqual(ts);
  });

  it("offenderSetHash is the same function: order and duplicates ignored, numbers stringified", () => {
    for (const ids of [[], ["T-1"], ["T-2", "T-1", "T-2"], [5326, "TEAM-1"], ["a@review", "a"]]) {
      expect(hashMjs(ids)).toBe(hashTs(ids));
    }
    expect(hashTs(["T-2", "T-1"])).toBe(hashTs(["T-1", "T-2", "T-1"]));
  });

  it("closeoutOverrideMatches is equality on both sides (no superset, no subset)", () => {
    const v = verifyTs(j(valid), [KEY], WF);
    for (const ids of [["T-1", "T-2"], ["T-2", "T-1", "T-1"], ["T-1"], ["T-1", "T-2", "T-3"], []]) {
      expect(matchesMjs(v, ids)).toBe(matchesTs(v, ids));
    }
    expect(matchesTs(v, ["T-1", "T-2"])).toBe(true);
    expect(matchesTs(v, ["T-1"])).toBe(false);
    expect(matchesTs(v, ["T-1", "T-2", "T-3"])).toBe(false);
    expect(matchesMjs(null, [])).toBe(matchesTs(null, []));
  });
});

// ── gate decisions: a record the twin signs, judged against the live gate ──

const SHA = "a".repeat(40);
const SCOPE_LINE = `gate-scope: ${j({ round: 2, headSha: SHA, findingIds: ["F:0badc0de", "E:12345678"] })}`;
const gateRec = (over: { ticketId?: string; workflowId?: string; cycle?: string | null; description?: string; option?: string } = {}, key = KEY) =>
  buildGateDecisionRecord(
    {
      ticketId: over.ticketId ?? "G-1",
      workflowId: over.workflowId ?? WF,
      decision: { option: over.option ?? "approve", override: false, channel: "hub", by: "eng@example.com" },
      labels: ["human-review"],
      description: over.description ?? `Approve the ship\n${SCOPE_LINE}`,
      cycle: over.cycle === undefined ? "c-2" : over.cycle,
    },
    key
  );
/** What the tickets twin's get_issue returns (fields.description) and the jira twin's (top-level). */
const ticketsIssue = (over: Record<string, unknown> = {}) => ({ key: "G-1", fields: { description: `Approve the ship\n${SCOPE_LINE}` }, gateCycle: "c-2", ...over });
const jiraIssue = (over: Record<string, unknown> = {}) => ({ key: "G-1", description: `Approve the ship\n${SCOPE_LINE}`, gateCycle: "c-2", ...over });

describe("gateDecisionStands — TS × .mjs on a gate-contract.mjs record", () => {
  const { gateCycle: _gc, ...noCycle } = ticketsIssue();
  const ROWS: Array<[string, unknown, unknown, string | true]> = [
    ["stands (tickets twin shape)", gateRec(), ticketsIssue(), true],
    ["stands (jira twin shape, Lambda bytes)", gateRec(), new TextEncoder().encode(j(jiraIssue())), true],
    ["stands (text payload)", gateRec(), j(ticketsIssue()), true],
    ["never-reset cycle on both sides", gateRec({ cycle: null }), ticketsIssue({ gateCycle: null }), true],
    ["stopped stands too", gateRec({ option: "stopped" }), ticketsIssue(), true],
    ["forged sig", { ...gateRec(), sig: "invalid" }, ticketsIssue(), "unverified"],
    ["another key", gateRec({}, "another-key"), ticketsIssue(), "unverified"],
    ["another run", gateRec({ workflowId: "wrong" }), ticketsIssue(), "wrong_run"],
    ["another ticket's record", gateRec({ ticketId: "G-9" }), ticketsIssue(), "wrong_run"],
    ["gateCycle omitted", gateRec(), noCycle, "cycle_unknown"],
    ["get_issue refused", gateRec(), { error: "not found" }, "cycle_unknown"],
    ["get_issue unreadable", gateRec(), "{not json", "cycle_unknown"],
    ["get_issue for another ticket", gateRec(), ticketsIssue({ key: "G-9" }), "cycle_unknown"],
    ["no live read", gateRec(), null, "cycle_unknown"],
    ["earlier cycle", gateRec({ cycle: "c-1" }), ticketsIssue(), "stale_cycle"],
    ["record never reset, gate reset since", gateRec({ cycle: null }), ticketsIssue(), "stale_cycle"],
    ["scope moved", gateRec({ description: "gate-scope: " + j({ round: 1, headSha: SHA, findingIds: ["F:0badc0de"] }) }), ticketsIssue(), "scope_moved"],
    ["scope line removed", gateRec(), ticketsIssue({ fields: { description: "Approve the ship" } }), "scope_moved"],
  ];

  it.each(ROWS)("%s", (_name, rec, payload, want) => {
    const ctx = (live: unknown) => ({ workflowId: WF, ticketId: "G-1", live });
    const lt = liveTs(payload);
    expect(liveMjs(payload)).toStrictEqual(lt);
    const ts = standsTs(rec, [KEY], ctx(lt) as Parameters<typeof standsTs>[2]);
    const mjs = standsMjs(rec, [KEY], ctx(lt));
    expect(mjs).toStrictEqual(ts);
    expect(ts.ok ? true : ts.why).toBe(want);
  });
});

// ── one roster, one offender set ──

describe("closeout offender set — orchestrator closeoutOffenderIds × hub closeoutReview", () => {
  const T = (ticketId: string, over: Partial<CloseoutTicket> = {}): CloseoutTicket => ({ ticketId, status: "done", parentId: "E-1", ...over });
  const ROSTER: CloseoutTicket[] = [
    T("E-1", { type: "epic", phase: "review" }),
    T("D-1", { phase: "development", assignee: "agentcore_hub_backend_dev" }), // not gate-class
    T("C-1", { phase: "review", assignee: "agentcore_hub_ci_agent" }), // own record -> backed
    T("C-2", { phase: "review", assignee: "agentcore_hub_ci_agent" }), // no record
    T("C-3", { phase: "review", assignee: "agentcore_hub_ci_agent" }), // console record
    T("C-4", { phase: "review", assignee: "agentcore_hub_ci_agent" }), // another agent's record
    T("C-5", { phase: "review", assignee: "agentcore_hub_ci_agent" }), // skip proven by done D-1
    T("C-6", { phase: "review", assignee: "agentcore_hub_ci_agent", status: "in_progress" }), // not done
    T("SR-1", { phase: "design", assignee: "agentcore_hub_security_reviewer" }), // gate-class, no record
    T("Q-1", { phase: "verification", assignee: "agentcore_hub_qa_verifier" }), // legacy record -> backed
    T("G-1", { phase: "ship", assignee: "human:eng" }), // standing decision
    T("G-2", { phase: "ship", assignee: "human:eng" }), // stale cycle
    T("G-3", { phase: "ship", assignee: "human:eng" }), // forged
    T("G-4", { phase: "ship", assignee: "human:eng" }), // stopped
    T("G-5", { phase: "ship", labels: ["human-review"] }), // label-only: no gateCycle -> cycle unknown
    T("G-6", { phase: "ship", assignee: "human:eng" }), // another run's record
    T("G-7", { phase: "ship", assignee: "human:eng" }), // no record
  ];
  const gid = (ticketId: string, over: Parameters<typeof gateRec>[0] = {}, key = KEY) => gateRec({ ticketId, ...over }, key);
  const OBJECTS: Record<string, unknown> = {
    "completions/C-1.json": { ticket_id: "C-1", summary: "ran", agent_id: "agentcore_hub_ci_agent" },
    "completions/C-3.json": { ticket_id: "C-3", summary: "marked done", source: "workflow-manager" },
    "completions/C-4.json": { ticket_id: "C-4", summary: "ran", agent_id: "agentcore_hub_backend_dev" },
    "completions/C-5.json": { ticket_id: "C-5", evidence_kind: "skipped", skipped: true, workflowId: WF, sweeperTicketId: "D-1", summary: "Skipped by D-1" },
    "completions/Q-1.json": { ticket_id: "Q-1", summary: "ran", pr_url: "https://x/pull/1" },
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-1.json`]: gid("G-1"),
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-2.json`]: gid("G-2", { cycle: "c-1" }),
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-3.json`]: gid("G-3", {}, "another-key"),
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-4.json`]: gid("G-4", { option: "stopped" }),
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-5.json`]: gid("G-5"),
    [`pipeline-artifacts/gate-decisions/${WF}/gates/G-6.json`]: gid("G-6", { workflowId: "wf_other" }),
  };
  /** The twin's get_issue: gateCycle only on a human:-assigned gate (tickets twin rule). */
  const getIssue = (ticketId: string) => {
    const t = ROSTER.find((x) => x.ticketId === ticketId)!;
    const base = { key: ticketId, fields: { description: `Approve the ship\n${SCOPE_LINE}` } };
    return String(t.assignee || "").startsWith("human:") ? { ...base, gateCycle: "c-2" } : base;
  };
  const readJson = async (key: string) => (key in OBJECTS ? OBJECTS[key] : null);
  const phaseOf = (t: { phase?: unknown }) => (typeof t.phase === "string" ? t.phase : undefined);

  it("both name the same offenders", async () => {
    const orch = await closeoutOffenderIds(ROSTER, {
      workflowId: WF, missingIds: [], keys: [KEY], phaseOf, readJson, hasEvidence: completionRecordHasEvidence,
      liveGate: async (tid: string) => getIssue(tid),
    });
    const hub = await closeoutReview({
      workflowId: WF, tickets: ROSTER, phaseOf, readJson, decisionKeys: [KEY],
      liveGate: async (tid) => liveTs(getIssue(tid)),
    });
    const hubIds = hub.offenders.map((o) => o.ticketId).sort();
    expect(orch).toEqual(hubIds);
    expect(hubIds).toEqual(["C-2", "C-3", "C-4", "G-2", "G-3", "G-4", "G-5", "G-6", "G-7", "SR-1"]);
    // ...so the override the hub would sign for that set is the one the orchestrator accepts.
    const ov = verifyMjs(j(buildCloseoutOverride({ workflowId: WF, by: "eng@example.com", reason: "r", offenders: hubIds }, KEY)), [KEY], WF);
    expect(matchesMjs(ov, orch)).toBe(true);
    expect(matchesMjs(ov, orch.slice(1))).toBe(false);
  });

  it("a failed read is an offender on both sides", async () => {
    const failing = async (key: string) => {
      if (key === "completions/C-1.json") throw new Error("AccessDenied");
      return readJson(key);
    };
    const orch = await closeoutOffenderIds(ROSTER, {
      workflowId: WF, missingIds: [], keys: [KEY], phaseOf, hasEvidence: completionRecordHasEvidence,
      // the orchestrator's reader turns a failed read into null (its readArtifactJson)
      readJson: (k: string) => failing(k).catch(() => null), liveGate: async (tid: string) => getIssue(tid),
    });
    const hub = await closeoutReview({ workflowId: WF, tickets: ROSTER, phaseOf, readJson: failing, decisionKeys: [KEY], liveGate: async (tid) => liveTs(getIssue(tid)) });
    expect(orch).toContain("C-1");
    expect(orch).toEqual(hub.offenders.map((o) => o.ticketId).sort());
  });
});

// ── the completion-blocked notice prefix, shared with completion.mjs ──

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

describe("completion-blocked notice prefix", () => {
  it("completion-evidence.ts declares the same regex as completion.mjs", () => {
    const src = readFileSync(repo("src/lib/workflow/completion-evidence.ts"), "utf8");
    const m = /COMPLETION_BLOCKED_NOTIF_RE\s*(?::[^=]+)?=\s*(\/.+?\/[a-z]*)\s*;/.exec(src);
    expect(m?.[1]).toBe(String(COMPLETION_BLOCKED_NOTIF_RE));
  });

  it("the orchestrator prefix is the one the ticket specifies", () => {
    expect(String(COMPLETION_BLOCKED_NOTIF_RE)).toBe("/^notif_completion_/");
  });

  it("the override route writes the key every reader verifies", () => {
    const route = "src/app/api/workflow/[id]/closeout-override/route.ts";
    expect(existsSync(repo(route))).toBe(true);
    expect(readFileSync(repo("src/lib/workflow/closeout-override.ts"), "utf8")).toContain("closeout-override.json");
  });
});
