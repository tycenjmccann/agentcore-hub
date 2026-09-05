import { describe, it, expect } from "vitest";
import {
  completionRecordHasEvidence as hasEvidenceTs,
  evidenceBackfillFields as backfillTs,
  // TEAM-3991 D1.4 twins.
  openGateOf as openGateTs,
  parseCdEvidence as parseCdTs,
  blockReasonWithGate as blockReasonTs,
  shipVerdictOf as shipVerdictTs,
  SHIP_PROVEN_OUTCOMES as PROVEN_TS,
  ACCEPTED_SHIP_OUTCOMES as ACCEPTED_TS,
  // TEAM-3992 Q4/D3.2 twin.
  fixVerificationGaps as fixGapsTs,
} from "./completion-evidence";
import {
  // TEAM-3991 D1.3 twins (the merge-probe result mappings).
  mergeProbeFromPulls as mergeFromPullsTs,
  mergeProbeFromCompare as mergeFromCompareTs,
} from "./merge-probe";
// The orchestrator (Lambda) port. Both copies MUST agree — a drift means the HTTP
// complete route and the orchestrator twin disagree on whether a completions
// record proves a deliverable, and a run closable from one surface would 409 on
// the other (the exact split-brain TEAM-3976 closes).
import {
  completionRecordHasEvidence as hasEvidenceMjs,
  evidenceBackfillFields as backfillMjs,
  openGateOf as openGateMjs,
  parseCdEvidence as parseCdMjs,
  blockReasonWithGate as blockReasonMjs,
  shipVerdictOf as shipVerdictMjs,
  SHIP_PROVEN_OUTCOMES as PROVEN_MJS,
  ACCEPTED_SHIP_OUTCOMES as ACCEPTED_MJS,
  fixVerificationGaps as fixGapsMjs,
} from "../../../lambda/orchestrator/completion.mjs";
import {
  mergeProbeFromPulls as mergeFromPullsMjs,
  mergeProbeFromCompare as mergeFromCompareMjs,
} from "../../../lambda/orchestrator/evidence.mjs";

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

/**
 * TEAM-3991 D1.4 parity contract. These four functions decide, on BOTH surfaces,
 * whether a run closes green or blocked and what the terminal event reports. A
 * drift means the HTTP complete route and the orchestrator disagree about the same
 * run — the exact split-brain that let wf 1pl3h1 close `complete` over an open
 * escalation gate while the other twin would have refused.
 */
const CHILD_SETS: Array<[string, unknown]> = [
  ["empty", []],
  ["not an array", null],
  ["undefined", undefined],
  ["only agent tickets", [{ ticketId: "T-1", assignee: "agentcore_hub_backend_dev", status: "done" }]],
  [
    "agent ticket in_review (never a gate)",
    [{ ticketId: "T-1", assignee: "agentcore_hub_ci_agent", status: "in_review" }],
  ],
  [
    "escalation gate in_review",
    [
      { ticketId: "T-1", assignee: "agentcore_hub_backend_dev", status: "done" },
      { ticketId: "TEAM-3757", assignee: "human:r@x", status: "in_review", title: "Escalation #1: ship-review not converging" },
    ],
  ],
  ["merge gate todo", [{ ticketId: "TEAM-900", assignee: "human:r@x", status: "todo", title: "Merge Approval" }]],
  ["merge gate blocked", [{ ticketId: "TEAM-900", assignee: "human:r@x", status: "blocked", title: "Merge Approval" }]],
  ["gate done", [{ ticketId: "TEAM-900", assignee: "human:r@x", status: "done", title: "Merge Approval" }]],
  ["gate cancelled", [{ ticketId: "TEAM-900", assignee: "human:r@x", status: "cancelled", title: "Merge Approval" }]],
  ["human epic", [{ ticketId: "E-1", type: "epic", assignee: "human:r@x", status: "in_review" }]],
  [
    "two open gates (order must not matter)",
    [
      { ticketId: "TEAM-900", assignee: "human:r@x", status: "todo", title: "Merge Approval" },
      { ticketId: "TEAM-100", assignee: "human:r@x", status: "in_review", title: "Escalation #2: x" },
    ],
  ],
  ["gate with no title", [{ ticketId: "TEAM-901", assignee: "human:r@x", status: "in_review" }]],
  ["status MiXeD case", [{ ticketId: "TEAM-902", assignee: "human:r@x", status: "In_Review", title: "Merge Approval" }]],
  ["assignee not a string", [{ ticketId: "TEAM-903", assignee: 7, status: "in_review" }]],
  ["null entry", [null, { ticketId: "TEAM-904", assignee: "human:r@x", status: "todo", title: "Merge Approval" }]],
];

const CD_FILES: Array<[string, unknown]> = [
  ["deploy succeeded heading", "# DEPLOY SUCCEEDED - stack x\n\nbody"],
  ["preflight blocked heading", "# PREFLIGHT BLOCKED: PR #274 is not merged\nmore"],
  ["deploy blocked, no heading", "DEPLOY BLOCKED - CodeBuild denied"],
  ["blocked then succeeded (first wins)", "# PREFLIGHT BLOCKED: unmerged\n\nlater: DEPLOY SUCCEEDED"],
  ["succeeded then blocked (first wins)", "DEPLOY SUCCEEDED\nPREFLIGHT BLOCKED: ignore me"],
  ["lowercase + leading blanks", "\n\n   ## deploy succeeded  \n"],
  ["no verdict", "# CD run log\nramping traffic"],
  ["empty", ""],
  ["whitespace only", "   \n\t\n"],
  ["undefined", undefined],
  ["not a string", { outcome: "deployed" }],
  ["CRLF line endings", "# PREFLIGHT BLOCKED: windows\r\nnext"],
];

const SHIP_ENTRIES: Array<[string, unknown]> = [
  ["merge commit", { mergeCommit: "9f1c2ab" }],
  ["blank merge commit", { mergeCommit: "   " }],
  ["outcome shipped", { outcome: "shipped" }],
  ["outcome deployed", { outcome: "deployed" }],
  ["outcome DEPLOYED (case/space)", { outcome: "  DEPLOYED " }],
  ["outcome deploy-blocked", { outcome: "deploy-blocked" }],
  ["outcome static-ci-only", { outcome: "static-ci-only" }],
  ["commitSha only (never proof)", { commitSha: "abc123" }],
  ["output only", { output: "did the thing" }],
  ["blocked outcome + merge commit", { outcome: "deploy-blocked", mergeCommit: "9f1c2ab" }],
  ["empty", {}],
  ["undefined", undefined],
  ["null", null],
  ["string", "shipped"],
];

describe("TEAM-3991 D1.4 parity — openGateOf", () => {
  for (const [label, children] of CHILD_SETS) {
    it(`agrees on ${label}`, () => {
      expect(openGateTs(children)).toEqual(openGateMjs(children));
    });
  }
});

describe("TEAM-3991 D1.4 parity — parseCdEvidence", () => {
  for (const [label, body] of CD_FILES) {
    it(`agrees on ${label}`, () => {
      expect(parseCdTs(body)).toEqual(parseCdMjs(body));
    });
  }
});

describe("TEAM-3991 D1.4 parity — shipVerdictOf", () => {
  for (const [label, entry] of SHIP_ENTRIES) {
    it(`agrees on ${label}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(shipVerdictTs(entry as any)).toBe(shipVerdictMjs(entry));
    });
  }

  it("both twins share the same accepted/proven outcome vocabulary", () => {
    expect([...PROVEN_TS]).toEqual([...PROVEN_MJS]);
    expect([...ACCEPTED_TS]).toEqual([...ACCEPTED_MJS]);
  });
});

describe("TEAM-3991 D1.4 parity — blockReasonWithGate", () => {
  const GATES = [
    null,
    undefined,
    { ticketId: "TEAM-3757", kind: "escalation", status: "in_review", title: "" },
    { ticketId: "TEAM-900", kind: "merge_gate", status: "todo", title: "Merge Approval" },
    { ticketId: "", kind: "merge_gate", status: "todo", title: "" },
  ];
  const REASONS = ["PR #274 is not merged", "", "   ", null, undefined, 42];
  for (const gate of GATES) {
    for (const reason of REASONS) {
      it(`agrees on ${JSON.stringify(reason)} × ${gate ? gate.ticketId || "(blank id)" : String(gate)}`, () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(blockReasonTs(reason as any, gate as any)).toBe(blockReasonMjs(reason, gate));
      });
    }
  }
});

/**
 * TEAM-3991 D1.3 parity — the merge-probe result mappings.
 *
 * The console twin (src/lib/workflow/merge-probe.ts) and the orchestrator
 * (lambda/orchestrator/evidence.mjs, called by index.mjs featureBranchMergeProbe)
 * must reduce the SAME GitHub payload to the same verdict. A drift here is the
 * worst kind available on this path: one surface closes a run green while the other
 * calls the very same branch unmerged.
 */
describe("TEAM-3991 D1.3 parity — mergeProbeFromPulls / mergeProbeFromCompare", () => {
  const PR_LISTS: Array<[string, unknown]> = [
    ["empty", []],
    ["not an array", null],
    ["undefined", undefined],
    ["one open PR", [{ state: "open", html_url: "u1", merge_commit_sha: "test-merge-sha" }]],
    // The trap: GitHub fills merge_commit_sha with a TEST-merge sha on unmerged PRs.
    ["closed-but-never-merged with a merge_commit_sha", [{ state: "closed", merge_commit_sha: "deadbeef", html_url: "u2" }]],
    ["one merged PR", [{ merged_at: "2026-09-01T10:00:00Z", merge_commit_sha: "abc123", html_url: "u3" }]],
    ["merged PR missing its sha", [{ merged_at: "2026-09-01T10:00:00Z", html_url: "u4" }]],
    ["merged PR missing its url", [{ merged_at: "2026-09-01T10:00:00Z", merge_commit_sha: "abc123" }]],
    ["open first, merged second", [{ state: "open" }, { merged_at: "x", merge_commit_sha: "s2", html_url: "u5" }]],
    ["two merged — first wins", [{ merged_at: "a", merge_commit_sha: "s1" }, { merged_at: "b", merge_commit_sha: "s2" }]],
    ["null entries", [null, { merged_at: "a", merge_commit_sha: "s1" }]],
    ["merged_at null", [{ merged_at: null, merge_commit_sha: "s1" }]],
  ];
  for (const [label, prs] of PR_LISTS) {
    it(`agrees on pulls: ${label}`, () => {
      expect(mergeFromPullsTs(prs)).toEqual(mergeFromPullsMjs(prs));
    });
  }

  const COMPARES: Array<[string, unknown]> = [
    ["identical", { status: "identical", base_commit: { sha: "base1" } }],
    ["behind", { status: "behind", base_commit: { sha: "base2" } }],
    ["behind with no base sha", { status: "behind" }],
    ["ahead", { status: "ahead", ahead_by: 3 }],
    ["diverged", { status: "diverged", ahead_by: 7 }],
    ["ahead with no count", { status: "ahead" }],
    ["unknown status", { status: "whatever" }],
    ["no status", {}],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [label, cmp] of COMPARES) {
    for (const base of ["main", "develop"]) {
      it(`agrees on compare: ${label} vs ${base}`, () => {
        expect(mergeFromCompareTs(cmp, base)).toEqual(mergeFromCompareMjs(cmp, base));
      });
    }
  }

  it("agrees on the default base", () => {
    expect(mergeFromCompareTs({ status: "ahead", ahead_by: 1 })).toEqual(
      mergeFromCompareMjs({ status: "ahead", ahead_by: 1 })
    );
  });

  it("merged_at is the ONLY merge signal — a test-merge sha proves nothing", () => {
    // Pinned explicitly, not just for parity: both twins must return null here, or
    // an abandoned PR would stamp a merge proof onto an unshipped run.
    const abandoned = [{ state: "closed", merge_commit_sha: "deadbeef", html_url: "u" }];
    expect(mergeFromPullsTs(abandoned)).toBeNull();
    expect(mergeFromPullsMjs(abandoned)).toBeNull();
  });
});

/**
 * TEAM-3992 Q4/D3.2 parity — the SHA-pinned fix-verification gate.
 *
 * The HTTP complete route (fix_unverified 409) and the orchestrator's
 * completeWorkflow must agree, on the SAME children × agentTasks × fixRearm
 * matrix, on exactly which done fix tickets were NOT re-verified at their final
 * commit SHA. A drift means one surface closes a run green while the other holds
 * it open on a fix whose re-review never landed at the code that shipped.
 */
describe("TEAM-3992 Q4/D3.2 parity — fixVerificationGaps", () => {
  const REARM = { review_fix: ["review", "ci"], qa_fix: ["review", "ci", "verification"], codex_fix: ["review", "ci"] };
  const SHA_LONG = "abcdef1234567890abcdef1234567890abcdef12";
  const SHA_SHORT = "abcdef1";
  const SHA_OTHER = "9999999";

  // A verifier task carrying a verification record for a target fix.
  const v = (targetTicketId: string, headSha: string, kind: string, verdict: string) => ({
    ticketId: `V-${kind}`,
    verification: { targetTicketId, headSha, kind, verdict },
  });

  const CASES: Array<[string, unknown, Record<string, unknown>, Record<string, string[]> | null | undefined]> = [
    ["no fixRearm → inert", [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }], {}, null],
    ["fixRearm not object", [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }], {}, undefined],
    ["children not array", null, {}, REARM],
    [
      "review_fix fully re-verified (short↔long sha)",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }],
      {
        F1: { ticketId: "F1", commitSha: SHA_LONG },
        va: v("F1", SHA_SHORT, "review", "pass"),
        vb: v("F1", SHA_LONG, "ci", "pass"),
      },
      REARM,
    ],
    [
      "review_fix missing ci",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }],
      { F1: { ticketId: "F1", commitSha: SHA_LONG }, va: v("F1", SHA_LONG, "review", "pass") },
      REARM,
    ],
    [
      "review_fix verified at WRONG sha",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }],
      {
        F1: { ticketId: "F1", commitSha: SHA_LONG },
        va: v("F1", SHA_OTHER, "review", "pass"),
        vb: v("F1", SHA_OTHER, "ci", "pass"),
      },
      REARM,
    ],
    [
      "review verdict fail (not pass)",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }],
      {
        F1: { ticketId: "F1", commitSha: SHA_LONG },
        va: v("F1", SHA_LONG, "review", "fail"),
        vb: v("F1", SHA_LONG, "ci", "pass"),
      },
      REARM,
    ],
    [
      "fix with no commitSha",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }],
      { F1: { ticketId: "F1" } },
      REARM,
    ],
    [
      "fix not done yet",
      [{ ticketId: "F1", status: "in_progress", spawnedBy: { kind: "review_fix" } }],
      { F1: { ticketId: "F1", commitSha: SHA_LONG } },
      REARM,
    ],
    [
      "re-arm ticket itself is not a fix",
      [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix", rearmOf: "F0" } }],
      { F1: { ticketId: "F1", commitSha: SHA_LONG } },
      REARM,
    ],
    [
      "non-fix done ticket ignored",
      [{ ticketId: "T1", status: "done", assignee: "agentcore_hub_backend_dev" }],
      { T1: { ticketId: "T1", commitSha: SHA_LONG } },
      REARM,
    ],
    [
      "qa_fix needs review+ci+verification, has all (verification kind = qa)",
      [{ ticketId: "F2", status: "done", spawnedBy: { kind: "qa_fix" } }],
      {
        F2: { ticketId: "F2", commitSha: SHA_LONG },
        va: v("F2", SHA_LONG, "review", "pass"),
        vb: v("F2", SHA_LONG, "ci", "pass"),
        vc: v("F2", SHA_LONG, "qa", "pass"),
      },
      REARM,
    ],
    [
      "qa_fix missing qa record",
      [{ ticketId: "F2", status: "done", spawnedBy: { kind: "qa_fix" } }],
      {
        F2: { ticketId: "F2", commitSha: SHA_LONG },
        va: v("F2", SHA_LONG, "review", "pass"),
        vb: v("F2", SHA_LONG, "ci", "pass"),
      },
      REARM,
    ],
    [
      "epic child skipped",
      [{ ticketId: "E", type: "epic", status: "done", spawnedBy: { kind: "review_fix" } }],
      { E: { ticketId: "E", commitSha: SHA_LONG } },
      REARM,
    ],
    [
      "two fixes, one green one gapped",
      [
        { ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } },
        { ticketId: "F3", status: "done", spawnedBy: { kind: "codex_fix" } },
      ],
      {
        F1: { ticketId: "F1", commitSha: SHA_LONG },
        va: v("F1", SHA_LONG, "review", "pass"),
        vb: v("F1", SHA_LONG, "ci", "pass"),
        F3: { ticketId: "F3", commitSha: SHA_OTHER },
      },
      REARM,
    ],
    ["null entries in agentTasks tolerated", [{ ticketId: "F1", status: "done", spawnedBy: { kind: "review_fix" } }], { x: null as unknown as Record<string, unknown>, F1: { ticketId: "F1", commitSha: SHA_LONG } }, REARM],
  ];

  for (const [label, children, agentTasks, fixRearm] of CASES) {
    it(`agrees on ${label}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ts = fixGapsTs(children as any, agentTasks as any, fixRearm as any);
      const mjs = fixGapsMjs(children, agentTasks, fixRearm);
      expect(mjs).toEqual(ts);
    });
  }

  it("pins the gap truth for the mixed two-fix case", () => {
    const [, children, agentTasks, fixRearm] = CASES.find((c) => c[0] === "two fixes, one green one gapped")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gaps = fixGapsTs(children as any, agentTasks as any, fixRearm as any);
    expect(gaps).toEqual([{ ticketId: "F3", commitSha: SHA_OTHER, missingKinds: ["review", "ci"] }]);
  });
});
