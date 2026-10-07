import { describe, it, expect } from "vitest";
import cases from "./record-ownership-cases.json";
import { gateClassRecordSatisfies, recordOwnership as ownershipTs } from "./completion-evidence";
// The canonical .mjs rule and its byte-copies (scripts/sibling-copies.json). A drift
// means /complete and the orchestrator disagree on whose record proves a ticket
// (TEAM-5369, the FR-1/FR-2 one-predicate rule). The toolkit's Python port runs the
// same fixture in deploy/workflow-manager/toolkit/test_intervene.py.
import { recordOwnership as ownershipMjs, closeoutOffenderIds } from "../../../lambda/orchestrator/proof-record-verify.mjs";
import { recordOwnership as ownershipCostReport } from "../../../lambda/cost-report/proof-record-verify.mjs";
import { completionRecordHasEvidence } from "../../../lambda/orchestrator/completion.mjs";

type Case = { name: string; record: unknown; assignee: unknown; ok: boolean; warning?: string };
const CASES = (cases as { cases: Case[] }).cases;

describe("record ownership parity: completion-evidence.ts ≡ proof-record-verify.mjs ≡ fixture", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const want = c.ok ? (c.warning ? { ok: true, warning: c.warning } : { ok: true }) : { ok: false, why: "agent_mismatch" };
    expect(ownershipTs(c.record, c.assignee)).toEqual(want);
    expect(ownershipMjs(c.record, c.assignee)).toEqual(want);
    expect(ownershipCostReport(c.record, c.assignee)).toEqual(want);
  });

  it("the gate-class rule agrees on an evidence-bearing variant of every row (TS gateClassRecordSatisfies ≡ closeoutOffenderIds)", async () => {
    for (const c of CASES) {
      if (!c.record || typeof c.record !== "object" || Array.isArray(c.record)) continue;
      const record = { summary: "did it", ...(c.record as Record<string, unknown>) };
      const ticket = { ticketId: "C-1", status: "done", phase: "review", assignee: c.assignee };
      expect(gateClassRecordSatisfies(record, ticket).ok, c.name).toBe(c.ok);
      const ids = await closeoutOffenderIds([ticket], {
        workflowId: "wf_1", keys: [], phaseOf: (t: { phase?: string }) => t.phase,
        readJson: async (key: string) => (key === "completions/C-1.json" ? record : null),
        hasEvidence: completionRecordHasEvidence, liveGate: async () => null,
      });
      expect(ids, c.name).toEqual(c.ok ? [] : ["C-1"]);
    }
  });
});
