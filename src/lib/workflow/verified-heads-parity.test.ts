import { describe, it, expect } from "vitest";
import {
  evaluateVerifiedHeads as evaluateTs,
  normalizeHeadSha as normalizeHeadShaTs,
  normalizeVerifiedHeadMode,
  GATE_PERSONA_IDS as GATE_PERSONA_IDS_TS,
  type HeadTaskLike,
  type HeadTicketLike,
} from "./verified-heads";
// The orchestrator (Lambda) original. Both copies MUST agree: the HTTP route is a
// second, human-driven way to close a run, so a drift here is a bypass of the gate
// — the same role lease-parity.test.ts and ship-review-parity.test.ts play.
import {
  evaluateVerifiedHeads as evaluateMjs,
  normalizeHeadSha as normalizeHeadShaMjs,
  GATE_PERSONA_IDS as GATE_PERSONA_IDS_MJS,
} from "../../../lambda/orchestrator/completion.mjs";
import { normalizeVerdictMode } from "../../../lambda/orchestrator/verdict-contract.mjs";

/**
 * TEAM-4246 D1 parity contract: feed the SAME (children × agentTasks × opts)
 * through both implementations and assert identical `{ ok, reason, heads }` —
 * plus offenders/stalePersonas, which are what the caller acts on.
 *
 * The table below is not arbitrary: every row is a branch of the predicate that
 * could plausibly be ported wrong (prefix equality, unknown-is-not-divergence,
 * heads.pr coming ONLY from the caller — TEAM-4264 F3 — newest-wins, the epic-wide
 * open-fix check, and the advisory label that must NOT excuse a fix).
 *
 * TEAM-4264 F3 note on the `opts` column: `heads.pr` is now the caller's
 * `prHeadSha` and nothing else, so a row that means to exercise a THREE-way
 * comparison has to say so. A row with no `opts` is the unknown-PR-head shape
 * (an expired PAT, a branch deleted by the merge), where the gate compares the two
 * verifiers to each other and refuses only if THEY disagree.
 */

const QA = "agentcore_hub_qa_verifier";
const CI = "agentcore_hub_ci_agent";
const DEV = "agentcore_hub_backend_dev";
const REVIEWER = "agentcore_hub_code_reviewer";

// Synthetic 40-hex heads (never a real SHA typed from memory) + the two real
// dowtdh heads, which are the reason this gate exists.
const A = "a".repeat(40);
const B = "b".repeat(40);
const QA_HEAD_DOWTDH = "12e9ac6ef5081343701945e8a3b39803d9c53cc6";
const PR_HEAD_DOWTDH = "001259dab7c1e5d2f3a49b8c6d0e1f2a3b4c5d6e";

type Row = {
  name: string;
  children: HeadTicketLike[];
  tasks: Record<string, HeadTaskLike>;
  opts?: { prHeadSha?: unknown };
};

const done = (ticketId: string, assignee: string, extra: Partial<HeadTicketLike> = {}): HeadTicketLike =>
  ({ ticketId, assignee, status: "done", type: "task", ...extra });

const task = (ticketId: string, fields: Partial<HeadTaskLike>): HeadTaskLike =>
  ({ ticketId, status: "complete", completedAt: "2026-09-06T23:00:00Z", ...fields } as HeadTaskLike);

const CASES: Row[] = [
  {
    name: "dowtdh: QA+CI at the evidence commit, the fix landed at another head",
    children: [
      done("TEAM-4181", QA),
      done("TEAM-4182", CI),
      done("TEAM-4183", DEV, { spawnedBy: { kind: "review_fix" } }),
    ],
    tasks: {
      "TEAM-4181": task("TEAM-4181", { testedHead: QA_HEAD_DOWTDH, completedAt: "2026-09-06T23:36:28Z" }),
      "TEAM-4182": task("TEAM-4182", { ci_head_sha: QA_HEAD_DOWTDH, completedAt: "2026-09-06T23:42:09Z" }),
      "TEAM-4183": task("TEAM-4183", { commitSha: PR_HEAD_DOWTDH, completedAt: "2026-09-06T23:46:55Z" }),
    },
    // The fix landed this head and the branch pointed at it; the caller supplies it.
    opts: { prHeadSha: PR_HEAD_DOWTDH },
  },
  {
    name: "everything at one head → clean",
    children: [done("T-1", QA), done("T-2", CI), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: A }),
      "T-2": task("T-2", { testedHead: A }),
      "T-3": task("T-3", { commitSha: A }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "the merge case (TEAM-4264 F3): QA+CI at the merge commit, dev one parent back",
    children: [done("T-1", QA), done("T-2", CI), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: B }),
      "T-2": task("T-2", { testedHead: B }),
      "T-3": task("T-3", { commitSha: A }), // the parent — what the old proxy used
    },
    opts: { prHeadSha: B },
  },
  {
    name: "prefix equality: short QA head vs full PR head",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: A.slice(0, 7) }),
      "T-3": task("T-3", { commitSha: A }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "only one known head → unknown is not divergence",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-3": task("T-3", {}) },
  },
  {
    name: "no caller head at all (TEAM-4264 F3): agreeing verifiers still pass",
    children: [done("T-1", QA), done("T-2", CI), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: A }),
      "T-2": task("T-2", { testedHead: A }),
      "T-3": task("T-3", { commitSha: B }), // ignored: nothing derives heads.pr
    },
  },
  {
    name: "no heads recorded at all (the pre-4246 shape) → clean",
    children: [done("T-1", QA), done("T-2", CI), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { commitSha: A }),
      "T-2": task("T-2", { commitSha: A }),
      "T-3": task("T-3", {}),
    },
  },
  {
    name: "QA stale, CI current → only QA is named",
    children: [done("T-1", QA), done("T-2", CI), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: B }),
      "T-2": task("T-2", { testedHead: A }),
      "T-3": task("T-3", { commitSha: A }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "no PR head: two verifiers disagree, both are stale",
    children: [done("T-1", QA), done("T-2", CI)],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-2": task("T-2", { testedHead: B }) },
  },
  {
    name: "neither commitSha nor mergeCommit becomes the PR head (TEAM-4264 F3)",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: A }),
      "T-3": task("T-3", { commitSha: A, mergeCommit: B } as Partial<HeadTaskLike>),
    },
  },
  {
    name: "a gate persona's own commitSha never becomes the PR head either",
    children: [done("T-1", QA), done("T-0", REVIEWER)],
    tasks: {
      "T-1": task("T-1", { testedHead: A }),
      "T-0": task("T-0", { commitSha: B }),
    },
  },
  {
    name: "newest-wins: QA re-ran at the shipped head",
    children: [done("T-1", QA), done("T-1b", QA), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: B, completedAt: "2026-09-06T10:00:00Z" }),
      "T-1b": task("T-1b", { testedHead: A, completedAt: "2026-09-06T20:00:00Z" }),
      "T-3": task("T-3", { commitSha: A, completedAt: "2026-09-06T19:00:00Z" }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "a later head-less QA round does not erase the proven head",
    children: [done("T-1", QA), done("T-1b", QA), done("T-3", DEV)],
    tasks: {
      "T-1": task("T-1", { testedHead: A, completedAt: "2026-09-06T10:00:00Z" }),
      "T-1b": task("T-1b", { completedAt: "2026-09-06T20:00:00Z" }),
      "T-3": task("T-3", { commitSha: A }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "an open fix under the epic, in no required phase → open-fix",
    children: [
      done("T-1", QA),
      done("T-3", DEV),
      { ticketId: "T-9", assignee: DEV, status: "in_progress", type: "task", spawnedBy: { kind: "qa_fix" } },
    ],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-3": task("T-3", { commitSha: A }) },
  },
  {
    name: "an `advisory` label does not excuse an open fix (TEAM-4131 F2)",
    children: [
      done("T-3", DEV),
      { ticketId: "T-9", assignee: DEV, status: "todo", type: "task", labels: ["advisory"], spawnedBy: { kind: "review_fix" } },
    ],
    tasks: { "T-3": task("T-3", { commitSha: A }) },
  },
  {
    name: "an advisory NON-fix open ticket is ignored",
    children: [
      done("T-1", QA),
      done("T-3", DEV),
      { ticketId: "T-8", assignee: DEV, status: "todo", type: "task", labels: ["advisory"] },
    ],
    tasks: { "T-1": task("T-1", { testedHead: B }), "T-3": task("T-3", { commitSha: A }) },
  },
  {
    name: "open-fix is reported ahead of divergence",
    children: [
      done("T-1", QA),
      done("T-3", DEV),
      { ticketId: "T-9", assignee: DEV, status: "todo", type: "task", spawnedBy: { kind: "ci_fix" } },
    ],
    tasks: { "T-1": task("T-1", { testedHead: B }), "T-3": task("T-3", { commitSha: A }) },
  },
  {
    name: "the caller-supplied PR head is the only source of heads.pr",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-3": task("T-3", { commitSha: A }) },
    opts: { prHeadSha: B },
  },
  {
    name: "a non-SHA prHeadSha is UNKNOWN, never a fallback to the derivation",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-3": task("T-3", { commitSha: A }) },
    opts: { prHeadSha: "HEAD" },
  },
  {
    name: "an explicitly null prHeadSha is the same unknown",
    children: [done("T-1", QA), done("T-2", CI)],
    tasks: { "T-1": task("T-1", { testedHead: A }), "T-2": task("T-2", { testedHead: B }) },
    opts: { prHeadSha: null },
  },
  {
    name: "task entries keyed by task id with a ticketId field",
    children: [done("T-1", QA), done("T-3", DEV)],
    tasks: {
      task_a: task("T-1", { testedHead: B }),
      task_b: task("T-3", { commitSha: A }),
    },
    opts: { prHeadSha: A },
  },
  {
    name: "cancelled fix + done work → clean",
    children: [
      done("T-3", DEV),
      { ticketId: "T-9", assignee: DEV, status: "cancelled", type: "task", spawnedBy: { kind: "qa_fix" } },
    ],
    tasks: { "T-3": task("T-3", { commitSha: A }) },
  },
  {
    name: "no children at all",
    children: [],
    tasks: {},
  },
];

describe("verified-head gate parity (TS route twin vs orchestrator .mjs)", () => {
  for (const row of CASES) {
    it(`agrees: ${row.name}`, () => {
      const ts = evaluateTs(row.children, row.tasks, row.opts || {});
      const mjs = evaluateMjs(row.children, row.tasks, row.opts || {});
      expect(ts).toEqual(mjs);
      // Spelled out separately so a failure says WHICH half drifted.
      expect(ts.ok).toBe(mjs.ok);
      expect(ts.reason).toBe(mjs.reason);
      expect(ts.heads).toEqual(mjs.heads);
      expect(ts.offenders).toEqual(mjs.offenders);
      expect(ts.stalePersonas).toEqual(mjs.stalePersonas);
    });
  }

  it("covers both refusals and the clean case (the table is not all one branch)", () => {
    const reasons = new Set(CASES.map((row) => evaluateMjs(row.children, row.tasks, row.opts || {}).reason));
    expect(reasons).toEqual(new Set([null, "open-fix", "head-divergence"]));
  });

  it("normalizeHeadSha agrees over every shape a head field can hold", () => {
    const inputs: unknown[] = [
      A, B, QA_HEAD_DOWTDH, PR_HEAD_DOWTDH, A.slice(0, 7), "  ABC1234  ", "abc123", "HEAD",
      "main", "z".repeat(40), "a".repeat(41), "", "   ", null, undefined, 12345, {}, [],
    ];
    for (const raw of inputs) {
      expect(normalizeHeadShaTs(raw)).toBe(normalizeHeadShaMjs(raw));
    }
  });

  it("the gate-persona id sets are identical", () => {
    expect([...GATE_PERSONA_IDS_TS].sort()).toEqual([...GATE_PERSONA_IDS_MJS].sort());
  });

  it("the mode normalizers agree (unset → shadow, garbage → off)", () => {
    for (const raw of [undefined, null, "", "  ", "off", "OFF", "shadow", " Shadow ", "enforce", "ENFORCE", "enforc", "1", "true"]) {
      expect(normalizeVerifiedHeadMode(raw)).toBe(normalizeVerdictMode(raw));
    }
  });
});
