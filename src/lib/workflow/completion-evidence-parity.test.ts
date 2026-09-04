import { describe, it, expect } from "vitest";
import {
  completionRecordHasEvidence as hasEvidenceTs,
  evidenceBackfillFields as backfillTs,
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
    };
    for (const [label, record] of RECORDS) {
      expect(hasEvidenceTs(record), label).toBe(expected[label]);
    }
  });
});
