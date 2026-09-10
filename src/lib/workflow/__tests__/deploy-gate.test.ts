import { describe, it, expect } from "vitest";
import {
  matchDeployGate,
  mergeCommitOf,
  isAwaitingHuman,
  shaMatches,
  waitingApprovalShas,
  type DeployStageLike,
} from "../deploy-gate";

/**
 * TEAM-4403 — the deploy-gate banner is scoped to the RUN, not the repo.
 *
 * The bug: the board raised the amber banner whenever ANY stage of the run's repo
 * pipeline was awaiting approval, so one parked ManualApproval on
 * agentcore-hub-deploy appeared on every active hub run — including runs still in
 * development that had never merged. These are the pure helpers that fix it, so
 * the matching rule is pinned here rather than in a 4k-line component.
 */

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "ffeeddccbbaa99887766554433221100aabbccdd";

/** An awaiting-approval stage carrying `sourceSha`, as /api/pipeline/status ships it. */
function awaitingStage(sourceSha?: string, over: Partial<DeployStageLike> = {}): DeployStageLike {
  return {
    name: "Approval",
    awaitingApproval: true,
    approvalUrl: "https://console.aws.amazon.com/approve",
    executionId: "exec-1",
    sourceSha,
    ...over,
  };
}

describe("shaMatches", () => {
  it("full SHA vs itself matches", () => {
    expect(shaMatches(SHA_A, SHA_A)).toBe(true);
  });

  it("abbreviated vs full matches both ways (the RM may record a short SHA)", () => {
    expect(shaMatches(SHA_A.slice(0, 12), SHA_A)).toBe(true);
    expect(shaMatches(SHA_A, SHA_A.slice(0, 12))).toBe(true);
  });

  it("casing is irrelevant", () => {
    expect(shaMatches(SHA_A.toUpperCase(), SHA_A)).toBe(true);
  });

  it("different commits do not match", () => {
    expect(shaMatches(SHA_A, SHA_B)).toBe(false);
  });

  it("below the 7-char abbreviation floor is coincidence, not identity", () => {
    expect(shaMatches("a1b2c3", "a1b2c3")).toBe(false);
    expect(shaMatches(SHA_A, SHA_A.slice(0, 6))).toBe(false);
  });

  it("non-hex / empty / non-string values never match", () => {
    expect(shaMatches("not-a-sha-at-all", "not-a-sha-at-all")).toBe(false);
    expect(shaMatches("", "")).toBe(false);
    expect(shaMatches(undefined, SHA_A)).toBe(false);
    expect(shaMatches(SHA_A, null)).toBe(false);
    expect(shaMatches(42, SHA_A)).toBe(false);
  });

  it("whitespace around a real SHA is tolerated", () => {
    expect(shaMatches(`  ${SHA_A}\n`, SHA_A)).toBe(true);
  });
});

describe("mergeCommitOf", () => {
  it("finds the merge commit in a ticketId-keyed map (NOT agentId-keyed)", () => {
    // agentTasks is keyed by ticketId; entries carry agentId. A direct
    // agentTasks[releaseManagerId] lookup would find nothing.
    const tasks = {
      "TEAM-1/1": { agentId: "developer_1", commitSha: SHA_B },
      "TEAM-1/9": { agentId: "release_manager", mergeCommit: SHA_A },
    };
    expect(mergeCommitOf(tasks)).toBe(SHA_A);
  });

  it("prefers the release manager's entry over another persona's", () => {
    const tasks = {
      "TEAM-1/2": { agentId: "ci_agent", mergeCommit: SHA_B },
      "TEAM-1/9": { agentId: "release_manager", mergeCommit: SHA_A },
    };
    expect(mergeCommitOf(tasks)).toBe(SHA_A);
  });

  it("accepts the hyphenated release-manager agentId spelling too", () => {
    expect(
      mergeCommitOf({
        "TEAM-1/2": { agentId: "ci-agent", mergeCommit: SHA_B },
        "TEAM-1/9": { agentId: "release-manager", mergeCommit: SHA_A },
      })
    ).toBe(SHA_A);
  });

  it("falls back to any entry's merge commit when no RM entry has one", () => {
    expect(mergeCommitOf({ "TEAM-1/2": { agentId: "operator", mergeCommit: SHA_B } })).toBe(SHA_B);
  });

  it("IGNORES commitSha — the unmerged feature-branch HEAD is not a merge signal", () => {
    const tasks = {
      "TEAM-1/1": { agentId: "developer_1", commitSha: SHA_A },
      "TEAM-1/2": { agentId: "qa_1", commitSha: SHA_B },
    };
    expect(mergeCommitOf(tasks)).toBeUndefined();
  });

  it("empty / missing / blank-valued maps yield undefined (a run that never shipped)", () => {
    expect(mergeCommitOf({})).toBeUndefined();
    expect(mergeCommitOf(undefined)).toBeUndefined();
    expect(mergeCommitOf(null)).toBeUndefined();
    expect(mergeCommitOf({ "TEAM-1/9": { agentId: "release_manager", mergeCommit: "   " } })).toBeUndefined();
    expect(mergeCommitOf({ "TEAM-1/9": null })).toBeUndefined();
  });
});

// ─── AC1: only the run whose merge commit produced the execution sees the gate ──

describe("matchDeployGate", () => {
  it("matching source SHA → the gate, carrying the approval url + execution id", () => {
    const gate = matchDeployGate([awaitingStage(SHA_A)], SHA_A);
    expect(gate).not.toBeNull();
    expect(gate?.name).toBe("Approval");
    expect(gate?.approvalUrl).toBe("https://console.aws.amazon.com/approve");
    expect(gate?.executionId).toBe("exec-1");
    expect(gate?.sourceSha).toBe(SHA_A);
  });

  it("THE BUG: a different run's execution → null (this is the whole fix)", () => {
    // Same repo, same pipeline, genuinely awaiting a human — but the waiting
    // execution came from someone else's merge. Pre-4403 this rendered a banner.
    expect(matchDeployGate([awaitingStage(SHA_B)], SHA_A)).toBeNull();
  });

  it("a run with no merge commit never gets a banner, however loudly the pipeline waits", () => {
    expect(matchDeployGate([awaitingStage(SHA_A)], undefined)).toBeNull();
    expect(matchDeployGate([awaitingStage(SHA_A)], null)).toBeNull();
    expect(matchDeployGate([awaitingStage(SHA_A)], "")).toBeNull();
    expect(matchDeployGate([awaitingStage(SHA_A)], "   ")).toBeNull();
  });

  it("no stage awaiting approval → null even when the SHAs line up", () => {
    const stages = [{ name: "Deploy", awaitingApproval: false, sourceSha: SHA_A }];
    expect(matchDeployGate(stages, SHA_A)).toBeNull();
  });

  it("awaiting stage with an UNRESOLVABLE sourceSha → null (conservative, superseded execution)", () => {
    expect(matchDeployGate([awaitingStage(undefined)], SHA_A)).toBeNull();
    expect(matchDeployGate([awaitingStage("")], SHA_A)).toBeNull();
    // A truncated SHA of ANOTHER commit is still another commit. (That status.ts
    // never puts the 12-char revisionSummary in `sourceSha` at all is pinned
    // where it belongs, in src/lib/pipeline/status.test.ts — matching identity is
    // length-agnostic on purpose, see the abbreviation case below.)
    expect(matchDeployGate([awaitingStage(SHA_B.slice(0, 12))], SHA_A)).toBeNull();
  });

  it("an abbreviated SHA on either side still matches — same commit, fewer chars", () => {
    expect(matchDeployGate([awaitingStage(SHA_A)], SHA_A.slice(0, 12))?.sourceSha).toBe(SHA_A);
    expect(matchDeployGate([awaitingStage(SHA_A.slice(0, 12))], SHA_A)?.sourceSha).toBe(SHA_A.slice(0, 12));
  });

  it("normalizes the returned sourceSha to lowercase hex", () => {
    expect(matchDeployGate([awaitingStage(SHA_A.toUpperCase())], SHA_A)?.sourceSha).toBe(SHA_A);
  });

  it("picks the matching awaiting stage out of several stages", () => {
    const stages = [
      { name: "Source", awaitingApproval: false, sourceSha: SHA_B },
      awaitingStage(SHA_B, { name: "Approve_staging", executionId: "exec-other" }),
      awaitingStage(SHA_A, { name: "Approve_deploy", executionId: "exec-mine" }),
    ];
    const gate = matchDeployGate(stages, SHA_A);
    expect(gate?.name).toBe("Approve_deploy");
    expect(gate?.executionId).toBe("exec-mine");
  });

  it("missing / malformed stage lists are inert (pipeline module may be absent)", () => {
    expect(matchDeployGate(undefined, SHA_A)).toBeNull();
    expect(matchDeployGate(null, SHA_A)).toBeNull();
    expect(matchDeployGate([], SHA_A)).toBeNull();
  });
});

describe("waitingApprovalShas", () => {
  it("collects every parked execution's SHA across all CD targets, deduped", () => {
    const pipelines = [
      { stages: [awaitingStage(SHA_A), { name: "Deploy", awaitingApproval: false, sourceSha: SHA_B }] },
      { stages: [awaitingStage(SHA_A), awaitingStage(SHA_B)] },
    ];
    expect(waitingApprovalShas(pipelines).sort()).toEqual([SHA_A, SHA_B].sort());
  });

  it("skips awaiting stages with no resolvable SHA, and tolerates absent payloads", () => {
    expect(waitingApprovalShas([{ stages: [awaitingStage(undefined)] }])).toEqual([]);
    expect(waitingApprovalShas([{}])).toEqual([]);
    expect(waitingApprovalShas(undefined)).toEqual([]);
  });
});

// ─── AC2: the sidebar's "waiting on a human" predicate ────────────────────────

describe("isAwaitingHuman", () => {
  const open = { id: "n1", type: "review_needed", acknowledged: false };

  it("an unacknowledged review_needed → true (the Telegram bridge pings on this)", () => {
    expect(isAwaitingHuman({ humanNotifications: [open] }, [])).toBe(true);
  });

  it("acknowledged → false, so the card returns to its real phase", () => {
    expect(isAwaitingHuman({ humanNotifications: [{ ...open, acknowledged: true }] }, [])).toBe(false);
  });

  it("other notification types are not human gates", () => {
    const others = ["escalation", "dead_session", "gate_blocked"].map((type) => ({ type, acknowledged: false }));
    expect(isAwaitingHuman({ humanNotifications: others }, [])).toBe(false);
  });

  it("one open review among acknowledged ones still counts", () => {
    expect(
      isAwaitingHuman(
        { humanNotifications: [{ ...open, acknowledged: true }, { type: "escalation" }, open] },
        []
      )
    ).toBe(true);
  });

  it("the run's OWN parked deploy execution → true (signal b)", () => {
    expect(isAwaitingHuman({ mergeCommit: SHA_A }, [SHA_A])).toBe(true);
    expect(isAwaitingHuman({ mergeCommit: SHA_A.slice(0, 12) }, [SHA_A])).toBe(true);
  });

  it("ANOTHER run's parked execution → false (the repo-scoped leak, in the sidebar)", () => {
    expect(isAwaitingHuman({ mergeCommit: SHA_A }, [SHA_B])).toBe(false);
  });

  it("no merge commit → false however many executions are parked", () => {
    expect(isAwaitingHuman({}, [SHA_A, SHA_B])).toBe(false);
  });

  it("a Set of SHAs works as well as an array, and absent inputs are inert", () => {
    expect(isAwaitingHuman({ mergeCommit: SHA_A }, new Set([SHA_A]))).toBe(true);
    expect(isAwaitingHuman({ mergeCommit: SHA_A }, null)).toBe(false);
    expect(isAwaitingHuman(undefined, [SHA_A])).toBe(false);
    expect(isAwaitingHuman(null, null)).toBe(false);
  });
});
