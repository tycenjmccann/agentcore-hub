import { describe, it, expect, vi } from "vitest";
import { createCascade } from "./cascade.mjs";

/**
 * TEAM-5426 replay — rfq233's dev lanes, against the REAL cascade.
 *
 * The orchestrator is not changed by TEAM-5426 (DL-009): what changed is WHEN the
 * security review TEAM-5357 can reach Done (workflow-output's
 * design_amendment_required + the twins' completion-record guard). This file pins
 * the half the fix relies on: TEAM-5358/5359 are blocked by the review, and the
 * cascade releases them only once it is done — so a review held behind its
 * amendment TEAM-5360 holds the lanes, and its Done releases both in one call.
 *
 * Test only; cascade.mjs is exercised as shipped, in both providers.
 */

const EPIC = "TEAM-5355";
const DESIGN = "TEAM-5356";
const REVIEW = "TEAM-5357";
const LANES = ["TEAM-5358", "TEAM-5359"];
const AMEND = "TEAM-5360";
const workflow = { id: "rfq233", workflowId: "rfq233" };

const board = ({ review, amendment }) => [
  { ticketId: DESIGN, status: "done", blockedBy: [] },
  { ticketId: REVIEW, status: review, blockedBy: [DESIGN, ...(amendment ? [AMEND] : [])] },
  ...LANES.map((ticketId) => ({ ticketId, status: "blocked", blockedBy: [DESIGN, REVIEW] })),
  ...(amendment ? [{ ticketId: AMEND, status: amendment, blockedBy: [], spawnedBy: { kind: "review_fix", gateTicketId: REVIEW }, phase: "design" }] : []),
];

function cascadeOver(siblings, provider) {
  const { cascadeUnblock } = createCascade({
    ddb: { send: vi.fn(async () => ({})) },
    ticketsTable: "tickets",
    provider,
    jiraTransition: vi.fn(async () => {}),
    getChildTickets: vi.fn(async () => siblings),
    publishEvent: vi.fn(async () => {}),
    now: () => Date.parse("2026-10-01T12:00:00Z"),
    log: () => {},
    sleep: vi.fn(async () => {}),
  });
  return cascadeUnblock;
}

for (const provider of ["dynamodb", "jira"]) {
  describe(`TEAM-5426 replay [${provider}] — the review holds the dev lanes`, () => {
    it("(a) the review parked behind its open amendment: a cascade releases neither lane", async () => {
      const cascade = cascadeOver(board({ review: "blocked", amendment: "in_progress" }), provider);
      const unblocked = await cascade(DESIGN, EPIC, workflow);
      for (const lane of LANES) expect(unblocked).not.toContain(lane);
      expect(unblocked).not.toContain(REVIEW);
    });

    it("the amendment going done re-dispatches the review — and still not the lanes", async () => {
      const cascade = cascadeOver(board({ review: "blocked", amendment: "done" }), provider);
      const unblocked = await cascade(AMEND, EPIC, workflow);
      expect(unblocked).toEqual([REVIEW]);
    });

    it("(b) the review going done releases both lanes in one cascade call", async () => {
      const cascade = cascadeOver(board({ review: "done", amendment: "done" }), provider);
      const unblocked = await cascade(REVIEW, EPIC, workflow);
      expect([...unblocked].sort()).toEqual(LANES);
    });

    it("(b) a PASS review with no amendment releases both lanes the same way", async () => {
      const cascade = cascadeOver(board({ review: "done" }), provider);
      const unblocked = await cascade(REVIEW, EPIC, workflow);
      expect([...unblocked].sort()).toEqual(LANES);
    });
  });
}
