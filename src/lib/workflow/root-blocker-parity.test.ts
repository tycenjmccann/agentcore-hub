import { describe, it, expect } from "vitest";

// The two ticket twins, imported directly — same trick as sibling-scan-parity.test.ts
// and base-branch-parity.test.ts (both modules are import-side-effect free, so one
// vitest process can hold BOTH providers to the same contract).
import * as tickets from "../../../lambda/agentcore-hub-tickets/index.mjs";
import * as jira from "../../../lambda/agentcore-hub-jira/index.mjs";

/**
 * TEAM-4763 P2 parity contract — the root-blocker autowire across the twins.
 *
 * FR-11's plan-time half (workflow-output's `normalizePlan`) only ever sees the batch
 * an intake agent submitted in one call; seam 7b covers every ticket minted after it.
 * Because the two twins ship as separate zips and are hand-mirrored, "both providers
 * wire the same edge" is a property nothing enforces except this file — and a run
 * whose mid-run tickets wait for different things depending on the backend is exactly
 * the class of defect the ticket was filed about.
 *
 * Two layers, because "equal today" is weaker than "cannot drift":
 *   1. identical OUTPUT over a shared roster matrix, deep-equal;
 *   2. identical SOURCE — `Function.prototype.toString()` byte for byte — so a
 *      reworded guard in one twin fails CI even if no case in the matrix happens to
 *      distinguish them.
 *
 * The matrix is expressed in the INTERNAL sibling shape both twins' scans normalize
 * to (`{ ticketId, assignee, status, createdAt }`); how each provider gets there
 * (parentId-index Query vs `parent = … ORDER BY created ASC` JQL) is asserted in the
 * twins' own suites.
 */

type Sibling = { ticketId: string; assignee: string; status: string; createdAt: string };

const sib = (ticketId: string, over: Partial<Sibling> = {}): Sibling => ({
  ticketId,
  assignee: "agentcore_hub_requirements_analyst",
  status: "in_progress",
  createdAt: "2026-09-14T10:00:00.000Z",
  ...over,
});

const ANALYST = sib("TEAM-4735");
const LATER = sib("TEAM-4750", { createdAt: "2026-09-14T18:00:00.000Z", assignee: "agentcore_hub_backend_dev" });
const GATE = sib("TEAM-4668", { assignee: "human:tycen", status: "in_review", createdAt: "2026-09-14T09:00:00.000Z" });

type Args = { assignee: string; blockedBy: string[]; siblings: Sibling[]; ticketIdIfKnown: string | null };

const CASES: Array<[string, Args]> = [
  ["the ordinary mid-run create", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [LATER, ANALYST], ticketIdIfKnown: null }],
  // The gate is the EARLIEST sibling here, so a twin that forgot the human filter
  // would pick it and deadlock the run — a divergence this case can see.
  ["a human gate that predates the root", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [GATE, ANALYST], ticketIdIfKnown: null }],
  ["a human assignee", { assignee: "human:tycen", blockedBy: [], siblings: [ANALYST], ticketIdIfKnown: null }],
  ["blockers the caller named", { assignee: "agentcore_hub_backend_dev", blockedBy: ["TEAM-4700"], siblings: [ANALYST], ticketIdIfKnown: null }],
  ["the run's first ticket (nothing scanned)", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [], ticketIdIfKnown: null }],
  ["a roster of gates only", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [GATE], ticketIdIfKnown: null }],
  ["a done root", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4735", { status: "done" })], ticketIdIfKnown: null }],
  ["a closed root", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4735", { status: "closed" })], ticketIdIfKnown: null }],
  ["a skipped root", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4735", { status: "skipped" })], ticketIdIfKnown: null }],
  ["a cancelled root", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4735", { status: "cancelled" })], ticketIdIfKnown: null }],
  ["the root IS this ticket (a dedupe reconcile)", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [ANALYST], ticketIdIfKnown: "TEAM-4735" }],
  // Degenerate rosters: a createdAt-less row (a pre-feature ticket) and ties. Neither
  // may make the two twins disagree, whatever they each decide.
  ["siblings with no createdAt", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4740", { createdAt: "" }), sib("TEAM-4735", { createdAt: "" })], ticketIdIfKnown: null }],
  ["two siblings created in the same millisecond", { assignee: "agentcore_hub_backend_dev", blockedBy: [], siblings: [sib("TEAM-4740"), sib("TEAM-4735")], ticketIdIfKnown: null }],
];

describe("autowireRootBlocker — identical wiring under either provider", () => {
  it.each(CASES)("agrees on %s", (_why, args) => {
    const t = (tickets as any).autowireRootBlocker(args);
    const j = (jira as any).autowireRootBlocker(args);
    expect(j).toEqual(t);
    // The response key, the status write and the journey event are all derived from
    // `autowired`, so its JSON is what actually has to match.
    expect(JSON.stringify(j.autowired)).toBe(JSON.stringify(t.autowired));
    // Neither twin writes a banner here: DELIVERY CONSTRAINT is the open-gate freeze.
    expect(t.banner).toBe("");
    expect(j.banner).toBe("");
  });

  it("agrees on which sibling is the root", () => {
    for (const [, args] of CASES) {
      const t = (tickets as any).findRootTicket(args.siblings);
      const j = (jira as any).findRootTicket(args.siblings);
      expect(j).toEqual(t);
    }
  });

  it("is byte-identical SOURCE, so neither guard can drift alone", () => {
    for (const fn of ["findRootTicket", "autowireRootBlocker"]) {
      const t = (tickets as any)[fn].toString();
      const j = (jira as any)[fn].toString();
      expect(Buffer.from(j, "utf8").equals(Buffer.from(t, "utf8"))).toBe(true);
    }
  });

  it("wires the earliest non-human sibling, and marks it as such", () => {
    // The positive case stated once, on the shared shape, so the matrix above is
    // about agreement and this is about the rule itself.
    const wired = (tickets as any).autowireRootBlocker({
      assignee: "agentcore_hub_backend_dev",
      blockedBy: [],
      siblings: [LATER, GATE, ANALYST],
      ticketIdIfKnown: null,
    });
    expect(wired.blockedBy).toEqual(["TEAM-4735"]);
    expect(wired.autowired).toEqual({
      reason: "no_root_blocker",
      rootTicketId: "TEAM-4735",
      blockedBy: ["TEAM-4735"],
    });
  });

  it("returns the caller's own blockers unchanged when it declines", () => {
    // "Unwired" must mean "the autowire added nothing", never "the caller's ordering
    // was dropped" — both twins turn this list straight into blocker edges.
    for (const mod of [tickets, jira]) {
      const res = (mod as any).autowireRootBlocker({
        assignee: "agentcore_hub_backend_dev",
        blockedBy: ["TEAM-4700", "TEAM-4701"],
        siblings: [ANALYST],
        ticketIdIfKnown: null,
      });
      expect(res.blockedBy).toEqual(["TEAM-4700", "TEAM-4701"]);
      expect(res.autowired).toBe(null);
    }
  });
});
