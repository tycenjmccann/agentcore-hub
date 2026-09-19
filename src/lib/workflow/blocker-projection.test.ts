import { describe, it, expect } from "vitest";

// The pure half of TEAM-4740 FR-4, imported straight out of the Lambda. Safe: the
// module has no top-level throw and constructs only AWS clients (no network at
// construction), and this is the same trick fix-contract-parity.test.ts uses to
// hold a Lambda's exported contract to a test outside its own zip.
import { blockerFromWaitingOn } from "../../../lambda/agentcore-hub-pipeline-tools/index.mjs";

/**
 * The projection's contract, restated for the type checker: the .mjs carries no
 * declarations, so TS widens `blocker` to `object` and every field read below
 * becomes an error. Spelling the seven keys out here is not a second source of
 * truth — BLOCKER_KEYS and the assertions are still what enforce it at runtime —
 * it just lets `npx tsc --noEmit` read the same shape the tests do.
 */
type Blocker = {
  executionId: string | null;
  sourceSha: string | null;
  pr: string | null;
  pendingSince: string | null;
  stage: string | null;
  action: string | null;
  supersedable: boolean;
};
const project = blockerFromWaitingOn as (
  waitingOn?: unknown,
  opts?: { ours?: string; sourceSha?: string; pr?: string; pendingSince?: string }
) => { blocker: Blocker | null; remedy: string | null };

/**
 * TEAM-4740 FR-4 — the deploy-gate blocker projection, as a truth table.
 *
 * `waitingOn` (TEAM-4706) says WHO holds the human deploy gate. That is
 * observational: an agent reading it still has to work out whether "someone holds
 * the gate" means "wait for your human" or "your run is behind a gate it will
 * never reach". `blockerFromWaitingOn` is that decision, and it lives here — pure,
 * exported, no I/O — precisely so it can be read as a table rather than inferred
 * from two call sites in a 2500-line Lambda.
 *
 * What each case is defending:
 *   - `blocker` non-null for "older" and NOTHING else. A false blocker refuses a
 *     legitimate deploy; a missed one is the invisible queueing this ticket fixes.
 *     "unknown" is not evidence of a blocker, and "this" is the normal case.
 *   - exactly SEVEN keys, always present, explicit nulls. JSON.stringify drops
 *     undefined, so a field a blueprint is told to branch on must never appear and
 *     disappear with an unnamed stage or an unreadable revision.
 *   - `remedy` is a SIBLING, never a key inside `blocker`.
 *   - the projection never says "abandon". Only start_deploy may, and only after it
 *     has actually proven ancestry and confirmed a Stop.
 */

const OLDER = "347b9bcb-6c02-4b0e-9b3e-1f2a4d5c6e70";
const OURS = "9f6a9e0d-1c3b-4f5a-8d7e-2b1c0a9f8e7d";
const SUCCESSOR = "c1d2e3f4-5566-4778-99aa-bbccddeeff00";

/** Only the fields the projection reads; the real waitingOn has seven keys. */
function waitingOn(over: Record<string, unknown> = {}) {
  return {
    kind: "human_approval",
    stage: "Deploy",
    action: "Approve_deploy",
    executionId: OLDER,
    holdsGate: "older",
    queuedBehind: OLDER,
    supersededBy: null,
    ...over,
  };
}

const BLOCKER_KEYS = [
  "action",
  "executionId",
  "pendingSince",
  "pr",
  "sourceSha",
  "stage",
  "supersedable",
];

describe("blockerFromWaitingOn — nothing is in front of us", () => {
  it("returns a null blocker and a null remedy when waitingOn is null", () => {
    expect(project(null)).toEqual({ blocker: null, remedy: null });
  });

  it("returns a null blocker when waitingOn is absent entirely", () => {
    expect(project(undefined)).toEqual({ blocker: null, remedy: null });
  });

  it('holdsGate "this" is the NORMAL case — our own gate, not a blocker', () => {
    // The single most important false positive to avoid: refusing a deploy whose
    // own approval is pending would break every ship run.
    expect(project(waitingOn({ holdsGate: "this" }))).toEqual({
      blocker: null,
      remedy: null,
    });
  });

  it('holdsGate "unknown" is NOT evidence of a blocker', () => {
    // "We could not establish a relationship" is not "someone is in front of you".
    expect(project(waitingOn({ holdsGate: "unknown" }))).toEqual({
      blocker: null,
      remedy: null,
    });
  });

  it('a "this"/"unknown" gate stays clear even when supersededBy is set', () => {
    // remedy is null when blocker is null, and that ordering is deliberate: there
    // is nothing to follow if nothing is in front of us.
    for (const holdsGate of ["this", "unknown"]) {
      expect(
        project(waitingOn({ holdsGate, supersededBy: SUCCESSOR }))
      ).toEqual({ blocker: null, remedy: null });
    }
  });
});

describe("blockerFromWaitingOn — someone else holds the gate", () => {
  it('"older" with an id and no superseder → a full blocker, remedy "wait"', () => {
    const { blocker, remedy } = project(waitingOn(), {
      ours: OURS,
      sourceSha: "1111111111111111111111111111111111111111",
      pr: "https://github.com/acme/widget/pull/7",
      pendingSince: "2026-09-14T17:33:00.000Z",
    });

    expect(blocker).toEqual({
      executionId: OLDER,
      sourceSha: "1111111111111111111111111111111111111111",
      pr: "https://github.com/acme/widget/pull/7",
      pendingSince: "2026-09-14T17:33:00.000Z",
      stage: "Deploy",
      action: "Approve_deploy",
      supersedable: false,
    });
    expect(remedy).toBe("wait");
  });

  it('"older" with a superseder → supersedable, remedy "follow_superseder"', () => {
    // Our OWN run was superseded, so the successor inherited our commit and will
    // inherit the gate. Following it is strictly better than starting a third run.
    const { blocker, remedy } = project(
      waitingOn({ supersededBy: SUCCESSOR }),
      { ours: OURS }
    );
    expect(blocker?.supersedable).toBe(true);
    expect(remedy).toBe("follow_superseder");
  });

  it("a superseder that is OURSELVES is not a superseder", () => {
    // Telling a caller to follow itself is a spin loop. findSupersedingExecution
    // already excludes the caller's id; this projection is the contract and does
    // not depend on that, and the safe direction for a capability flag is off.
    const { blocker, remedy } = project(
      waitingOn({ supersededBy: OURS }),
      { ours: OURS }
    );
    expect(blocker?.supersedable).toBe(false);
    expect(remedy).toBe("wait");
  });

  it("C8: holdsGate older with NO parked execution id is still a real blocker", () => {
    // The stage named OUR execution as inbound but exposed no parked execution id.
    // Something is genuinely in front of us; we simply cannot name it — which is
    // exactly why it can never be abandoned.
    const { blocker, remedy } = project(
      waitingOn({ executionId: null, queuedBehind: null }),
      { ours: OURS }
    );
    expect(blocker).not.toBeNull();
    expect(blocker?.executionId).toBeNull();
    expect(blocker?.supersedable).toBe(false);
    expect(remedy).toBe("wait");
  });

  it("carries stage and action through verbatim from waitingOn", () => {
    // A blueprint that files a gate ticket names the stage/action it is waiting on.
    // Renaming either of these on the way through would misfile that ticket.
    const wo = waitingOn({ stage: "ShipGate", action: "HumanApproval" });
    const { blocker } = project(wo, { ours: OURS });
    expect(blocker?.stage).toBe(wo.stage);
    expect(blocker?.action).toBe(wo.action);
  });
});

describe("blockerFromWaitingOn — the shape is the contract", () => {
  it("has EXACTLY seven keys, with explicit nulls, when nothing was enriched", () => {
    // Called with no opts at all: every enrichment is null and PRESENT. A consumer
    // must never have to tell "absent" from "unknown".
    const { blocker, remedy } = project(waitingOn());
    expect(Object.keys(blocker as object).sort()).toEqual(BLOCKER_KEYS);
    expect(blocker).toEqual({
      executionId: OLDER,
      sourceSha: null,
      pr: null,
      pendingSince: null,
      stage: "Deploy",
      action: "Approve_deploy",
      supersedable: false,
    });
    expect(remedy).toBe("wait");
    // Survives the wire: JSON.stringify drops undefined, so an "absent" key here
    // would silently vanish between the Lambda and the agent reading it.
    expect(Object.keys(JSON.parse(JSON.stringify(blocker))).sort()).toEqual(BLOCKER_KEYS);
  });

  it("keeps all seven keys on every non-null branch", () => {
    for (const over of [
      {},
      { supersededBy: SUCCESSOR },
      { executionId: null },
      { stage: null, action: null },
    ]) {
      const { blocker } = project(waitingOn(over), { ours: OURS });
      expect(Object.keys(blocker as object).sort(), JSON.stringify(over)).toEqual(
        BLOCKER_KEYS
      );
    }
  });

  it("never puts remedy inside blocker, and never invents an unknown value", () => {
    for (const over of [{}, { supersededBy: SUCCESSOR }, { holdsGate: "this" }]) {
      const out = project(waitingOn(over), { ours: OURS });
      expect(Object.keys(out).sort()).toEqual(["blocker", "remedy"]);
      if (out.blocker) expect(out.blocker).not.toHaveProperty("remedy");
      // "abandon" is start_deploy's word, and only AFTER it proved ancestry and
      // confirmed a Stop. The pure projection may never speculate it.
      expect([null, "wait", "follow_superseder"]).toContain(out.remedy);
    }
  });

  it("does not mutate the waitingOn it was handed", () => {
    // get_state returns the SAME waitingOn object on the response; the projection
    // reading it must leave TEAM-4706's shape byte-identical.
    const wo = waitingOn({ supersededBy: SUCCESSOR });
    const before = JSON.stringify(wo);
    project(wo, { ours: OURS, sourceSha: "abc", pendingSince: "now" });
    expect(JSON.stringify(wo)).toBe(before);
  });

  it("is pure: identical inputs give a deep-equal, non-shared result", () => {
    const a = project(waitingOn(), { ours: OURS });
    const b = project(waitingOn(), { ours: OURS });
    expect(a).toEqual(b);
    expect(a.blocker).not.toBe(b.blocker);
  });
});
