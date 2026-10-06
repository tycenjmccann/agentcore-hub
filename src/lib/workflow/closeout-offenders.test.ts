import { describe, it, expect } from "vitest";
import { closeoutOffenders, type CloseoutTicket } from "./closeout-offenders";
import { canonicalJson, signVerifyRecord } from "./decision-contract";

/** TEAM-5358 FR-1 / F4 / F7 — the one offender evaluator /complete and the override route share. */
const KEY = "closeout-offenders-test-key";
const WF = "wf_1";

function run(tickets: CloseoutTicket[], objects: Record<string, unknown>, opts: { keys?: string[] | null; fail?: string[] } = {}) {
  return closeoutOffenders({
    workflowId: WF,
    tickets,
    phaseOf: (t) => (typeof t.phase === "string" ? t.phase : undefined),
    readJson: async (key) => {
      if (opts.fail?.includes(key)) throw new Error("AccessDenied");
      return key in objects ? objects[key] : null;
    },
    decisionKeys: opts.keys === undefined ? [KEY] : opts.keys,
  });
}

const CI = { ticketId: "C-1", status: "done", phase: "review", assignee: "agentcore_hub_ci_agent", parentId: "E-1", title: "CI" };
const QA = { ticketId: "Q-1", status: "done", phase: "verification", assignee: "agentcore_hub_qa_verifier", parentId: "E-1" };
const DEV = { ticketId: "D-1", status: "done", phase: "development", assignee: "agentcore_hub_backend_dev", parentId: "E-1" };
const GATE = { ticketId: "G-1", status: "done", phase: "ship", assignee: "human:engineer", parentId: "E-1" };
const skip = (ticketId: string, sweeper: string) => ({
  ticket_id: ticketId, evidence_kind: "skipped", skipped: true, workflowId: WF, sweeperTicketId: sweeper, summary: `Skipped by ${sweeper}`,
});
function decision(ticketId: string, over: Record<string, unknown> = {}) {
  const u = {
    v: 3, ticketId, workflowId: WF, kind: "gate-decision", status: "done",
    decision: { option: "approve", override: false, channel: "hub", by: "eng@example.com" },
    decidedAt: "2026-10-01T00:00:00Z", scope: null, cycle: null, labels: [], ...over,
  };
  return { ...u, sig: signVerifyRecord([canonicalJson(u)], KEY) };
}

describe("closeoutOffenders", () => {
  it("non-gate, non-done and epic tickets are never offenders", async () => {
    const tickets = [DEV, { ...CI, status: "in_progress" }, { ...CI, ticketId: "E-1", type: "epic" }];
    expect(await run(tickets, {})).toEqual([]);
  });

  it("names each offender with its why, in roster order", async () => {
    const out = await run([CI, QA, GATE], { "completions/Q-1.json": { summary: "ok", agent_id: "someone_else" } });
    expect(out).toEqual([
      { ticketId: "C-1", title: "CI", phase: "review", assignee: "agentcore_hub_ci_agent", why: "no_record" },
      { ticketId: "Q-1", title: "", phase: "verification", assignee: "agentcore_hub_qa_verifier", why: "agent_mismatch" },
      { ticketId: "G-1", title: "", phase: "ship", assignee: "human:engineer", why: "no_decision_record" },
    ]);
  });

  it("a record with no evidence is no_evidence even from the assignee", async () => {
    const out = await run([CI], { "completions/C-1.json": { summary: "  ", agent_id: CI.assignee } });
    expect(out[0].why).toBe("no_evidence");
  });

  it("a human gate's verified decision for this run and ticket satisfies it; another run's does not", async () => {
    const key = `pipeline-artifacts/gate-decisions/${WF}/gates/G-1.json`;
    expect(await run([GATE], { [key]: decision("G-1") })).toEqual([]);
    expect((await run([GATE], { [key]: decision("G-1", { workflowId: "wf_other" }) }))[0].why).toBe("no_decision_record");
  });

  it("a decision record that exists but no key can verify -> decision_key_unavailable", async () => {
    const key = `pipeline-artifacts/gate-decisions/${WF}/gates/G-1.json`;
    expect((await run([GATE], { [key]: decision("G-1") }, { keys: null }))[0].why).toBe("decision_key_unavailable");
  });

  it("sweep skip proof: a done same-parent sweeper proves the skip", async () => {
    const sweeper = { ...DEV, ticketId: "D-2", status: "done" };
    expect(await run([CI, sweeper], { "completions/C-1.json": skip("C-1", "D-2") })).toEqual([]);
  });

  it("sweep skip proof: a sweeper under another parent, or absent from the roster, proves nothing", async () => {
    const other = { ...DEV, ticketId: "D-2", parentId: "E-9" };
    // The skip record then stands as an ordinary record, which its assignee did not write.
    expect((await run([CI, other], { "completions/C-1.json": skip("C-1", "D-2") }))[0].why).toBe("agent_mismatch");
    expect((await run([CI], { "completions/C-1.json": skip("C-1", "D-404") }))[0].why).toBe("agent_mismatch");
  });

  it("sweep skip proof: an in_progress sweeper counts only with its own non-skip record for this run", async () => {
    const sweeper = { ...DEV, ticketId: "D-2", status: "in_progress" };
    const objects: Record<string, unknown> = { "completions/C-1.json": skip("C-1", "D-2") };
    expect(await run([CI, sweeper], objects)).toHaveLength(1);
    objects["completions/D-2.json"] = { summary: "did the work", workflowId: WF };
    expect(await run([CI, sweeper], objects)).toEqual([]);
    objects["completions/D-2.json"] = skip("D-2", "D-3");
    expect(await run([CI, sweeper], objects)).toHaveLength(1);
  });

  it("a skip record for a human gate needs the same proof", async () => {
    const sweeper = { ...DEV, ticketId: "D-2", status: "done" };
    expect(await run([GATE, sweeper], { "completions/G-1.json": skip("G-1", "D-2") })).toEqual([]);
  });

  it("a read that fails with anything but not-found -> record_unreadable (fail-closed)", async () => {
    expect((await run([CI], {}, { fail: ["completions/C-1.json"] }))[0].why).toBe("record_unreadable");
    expect((await run([GATE], {}, { fail: [`pipeline-artifacts/gate-decisions/${WF}/gates/G-1.json`] }))[0].why).toBe("record_unreadable");
  });
});
