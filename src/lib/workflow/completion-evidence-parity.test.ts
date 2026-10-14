import { describe, it, expect } from "vitest";
import {
  completionRecordHasEvidence as hasEvidenceTs,
  evidenceBackfillFields as backfillTs,
  isIntentOnlyReservation as isReservationTs,
  RESERVATION_FIELD as RESERVATION_FIELD_TS,
  DONE_INTENT_RESERVATION as DONE_INTENT_RESERVATION_TS,
} from "./completion-evidence";
// The orchestrator (Lambda) port. Both copies MUST agree — a drift means the HTTP
// complete route and the orchestrator twin disagree on whether a completions
// record proves a deliverable, and a run closable from one surface would 409 on
// the other (the exact split-brain TEAM-3976 closes).
import {
  completionRecordHasEvidence as hasEvidenceMjs,
  evidenceBackfillFields as backfillMjs,
} from "../../../lambda/orchestrator/completion.mjs";

/**
 * TEAM-3976 parity contract: feed the SAME record × entry matrix through both
 * completionRecordHasEvidence and evidenceBackfillFields implementations and
 * assert identical results. This is the guard that keeps the hand-port honest.
 */

const RECORDS: Array<[string, unknown]> = [
  ["summary + pr_url", { summary: "did it", pr_url: "https://github.com/x/y/pull/1" }],
  ["pr_url only", { pr_url: "https://github.com/x/y/pull/1" }],
  ["commit_sha only", { commit_sha: "abc123" }],
  ["artifacts string", { artifacts: "a.md" }],
  ["artifacts array", { artifacts: ["a.md"] }],
  ["null", null],
  ["undefined", undefined],
  ["empty object", {}],
  ["whitespace summary", { summary: "   " }],
  ["all blank", { summary: "", artifacts: "", pr_url: null, commit_sha: null }],
  ["empty artifacts array", { artifacts: [] }],
  ["array of blanks", { artifacts: ["", "  "] }],
  ["string record", "summary"],
  ["array record", ["a.md"]],
  ["numeric fields", { summary: 42, pr_url: 7, commit_sha: 1, artifacts: 3 }],
  [
    "full record incl. ship signals",
    {
      summary: "Fixed it",
      branch: "feature/x",
      commit_sha: "abc",
      pr_url: "https://github.com/x/y/pull/1",
      merge_commit: "9f1c2ab",
      outcome: "shipped",
      block_reason: "none",
    },
  ],
  ["oversized summary", { summary: "x".repeat(20000), branch: "b" }],
  ["blank branch", { summary: "s", branch: "" }],
  // TEAM-5959: the ticket twins' Done-intent reservation is NOT evidence (nor a record).
  ["Done-intent reservation", { reservation: "done-intent", ticketId: "T-1", doneIntent: { at: "2026-10-14T06:00:00.000Z", provider: "jira", nonce: "n" } }],
  ["Done-intent reservation, intent cleared", { reservation: "done-intent", ticketId: "T-1" }],
  ["reservation a hold was stamped onto", { reservation: "done-intent", ticketId: "T-1", briefPending: true, ticketWrites: "dropped" }],
  ["reservation a real writer filled", { reservation: "done-intent", ticketId: "T-1", summary: "did it", doneIntent: { at: "x" } }],
];

/** TEAM-5959: isIntentOnlyReservation rows — marker AND no key outside {reservation, ticketId, doneIntent}. */
const RESERVATIONS: Array<[string, unknown, boolean]> = [
  ["bare reservation", { reservation: "done-intent", ticketId: "T-1", doneIntent: { at: "x", provider: "jira", nonce: "n" } }, true],
  ["intent cleared", { reservation: "done-intent", ticketId: "T-1" }, true],
  ["marker only", { reservation: "done-intent" }, true],
  ["+ briefPending (a hold)", { reservation: "done-intent", ticketId: "T-1", briefPending: true }, false],
  ["+ followUpsPending (a hold)", { reservation: "done-intent", ticketId: "T-1", followUpsPending: true }, false],
  ["+ summary (a real writer)", { reservation: "done-intent", ticketId: "T-1", summary: "s" }, false],
  ["+ ticketWrites (the drain)", { reservation: "done-intent", ticketId: "T-1", ticketWrites: "dropped" }, false],
  ["wrong marker value", { reservation: "other", ticketId: "T-1" }, false],
  ["no marker, intent only", { ticketId: "T-1", doneIntent: { at: "x" } }, false],
  ["blank record", {}, false],
  ["null", null, false],
  ["array", [], false],
  ["string", "reservation", false],
];

const ENTRIES: Array<[string, Record<string, unknown> | undefined | null]> = [
  ["undefined", undefined],
  ["null", null],
  ["empty", {}],
  ["complete, evidence-less", { ticketId: "T-1", status: "complete" }],
  ["has output", { output: "webhook merge landed first" }],
  ["blank output", { output: "   " }],
  ["has artifactKey only", { artifactKey: "workflows/wf/x.md" }],
  ["has commitSha/prUrl/branch", { commitSha: "already", prUrl: "https://already", branch: "already" }],
  ["has everything", { output: "o", branch: "b", commitSha: "c", prUrl: "p", mergeCommit: "m", outcome: "shipped" }],
];

describe("completion-evidence parity: completion-evidence.ts ≡ completion.mjs", () => {
  // TEAM-5959: the orchestrator copy carries NO reservation predicate on purpose (DL-009:
  // its line budget is at the limit, and it needs none — completionRecordHasEvidence's
  // field rule already reads a reservation as "no evidence", asserted below for BOTH
  // copies). The TS predicate is what the hub routes (cancel sweep, transition refill) use;
  // gate-contract-parity.test.ts pins its literals to the twins' canonical copy.
  it("TEAM-5959: the Done-intent reservation marker literals match the twins' gate-contract", () => {
    expect(RESERVATION_FIELD_TS).toBe("reservation");
    expect(DONE_INTENT_RESERVATION_TS).toBe("done-intent");
  });

  it("TEAM-5959: isIntentOnlyReservation answers every row, and a reservation is never evidence in EITHER copy", () => {
    for (const [label, record, expected] of RESERVATIONS) {
      expect(isReservationTs(record), `ts: ${label}`).toBe(expected);
      if (expected) {
        expect(hasEvidenceTs(record), `ts evidence: ${label}`).toBe(false);
        expect(hasEvidenceMjs(record), `mjs evidence: ${label}`).toBe(false);
        expect(backfillTs(record, {}), `ts backfill: ${label}`).toEqual({});
        expect(backfillMjs(record, {}), `mjs backfill: ${label}`).toEqual({});
      }
    }
  });

  it("completionRecordHasEvidence agrees on every record fixture", () => {
    let compared = 0;
    for (const [label, record] of RECORDS) {
      expect(hasEvidenceMjs(record), `mismatch for record=${label}`).toBe(hasEvidenceTs(record));
      compared++;
    }
    expect(compared).toBe(RECORDS.length);
  });

  it("evidenceBackfillFields agrees on every record × entry combination", () => {
    let compared = 0;
    for (const [rLabel, record] of RECORDS) {
      for (const [eLabel, entry] of ENTRIES) {
        const ts = backfillTs(record, entry);
        const mjs = backfillMjs(record, entry);
        expect(mjs, `mismatch for record=${rLabel} entry=${eLabel}`).toEqual(ts);
        compared++;
      }
    }
    expect(compared).toBe(RECORDS.length * ENTRIES.length);
  });

  it("pins the fixture table's expected truth values (so a shared bug cannot hide behind agreement)", () => {
    const expected: Record<string, boolean> = {
      "summary + pr_url": true,
      "pr_url only": true,
      "commit_sha only": true,
      "artifacts string": true,
      "artifacts array": true,
      null: false,
      undefined: false,
      "empty object": false,
      "whitespace summary": false,
      "all blank": false,
      "empty artifacts array": false,
      "array of blanks": false,
      "string record": false,
      "array record": false,
      "numeric fields": false,
      "full record incl. ship signals": true,
      "oversized summary": true,
      "blank branch": true,
      // TEAM-5959: a reservation is never evidence; one a real writer filled is (summary).
      "Done-intent reservation": false,
      "Done-intent reservation, intent cleared": false,
      "reservation a hold was stamped onto": false,
      "reservation a real writer filled": true,
    };
    for (const [label, record] of RECORDS) {
      expect(hasEvidenceTs(record), label).toBe(expected[label]);
    }
  });
});
