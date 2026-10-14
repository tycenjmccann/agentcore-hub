import { describe, it, expect } from "vitest";
import { provesTransitioned, jiraStatusToInternal } from "./ticket-transition-refusal";
import { ticketsSuccess, JIRA_DONE_SUCCESS, JIRA_NAME_MATCH_CLOSED } from "./__fixtures__/ticket-transition-success";

/**
 * TEAM-6123 — rejectedDetails is a deny-list: it answers null for ANY shape it
 * doesn't recognize as a refusal, including an unparseable payload, "null", "{}",
 * or an unknown object. Both callers (webhook/route.ts, [id]/tickets/transition/
 * route.ts) treated that null as "the ticket moved" and answered success. These
 * pin provesTransitioned, the SUCCESS allow-list that closes the gap: only the
 * two real success shapes — read verbatim off the Lambdas' only success returns —
 * count as proof.
 *
 * TEAM-6131 — proof is about THE ticket and THE status that were requested:
 *   F3: a bare `{status:"transitioned"}` (no `to`, no key) is not proof — the real
 *       tickets return always carries both; the key must name the requested ticket.
 *   F4: the jira twin matches a transition by NAME or destination, so a workflow whose
 *       "Done" lands in e.g. "Closed" reports `status:"closed"`. The Lambda now also
 *       reports `requested` + `matchedTransition`; that is proof ONLY when the landed
 *       status is not one of the hub's own other columns — an arbitrary status such
 *       as "in_progress" for a requested "done" is never proof.
 */

// Verbatim from the Lambdas' only success returns (see __fixtures__).
const TICKETS_SUCCESS = ticketsSuccess("TEAM-7", "done", "in_review");
const JIRA_SUCCESS = JIRA_DONE_SUCCESS;

describe("provesTransitioned — the real Lambda success shapes", () => {
  it("the real tickets-Lambda success shape proves done", () => {
    expect(provesTransitioned(TICKETS_SUCCESS, "done", "TEAM-7")).toBe(true);
  });

  it("the real jira-Lambda success shape proves done", () => {
    expect(provesTransitioned(JIRA_SUCCESS, "done", "TEAM-7")).toBe(true);
  });

  it("the pre-TEAM-6131 jira shape (no requested/matchedTransition) still proves done when status === target", () => {
    expect(provesTransitioned({ ticketId: "TEAM-7", status: "done", message: "Transitioned to done" }, "done", "TEAM-7")).toBe(true);
  });

  it("tickets shape landing in a DIFFERENT status than requested is not proof", () => {
    expect(provesTransitioned({ ...TICKETS_SUCCESS, to: "blocked" }, "done", "TEAM-7")).toBe(false);
  });

  it("jira shape landing in a DIFFERENT internal status than requested is not proof", () => {
    expect(provesTransitioned({ ...JIRA_SUCCESS, status: "in_progress" }, "done", "TEAM-7")).toBe(false);
  });

  it("status/target comparison is case- and whitespace-insensitive", () => {
    expect(provesTransitioned({ ticketId: "TEAM-7", status: " DONE " }, "done", "TEAM-7")).toBe(true);
    expect(provesTransitioned({ key: "TEAM-7", status: "transitioned", to: "DONE" }, "done", "TEAM-7")).toBe(true);
  });

  it("ticket id comparison is case- and whitespace-insensitive (the route accepts mixed-case ids)", () => {
    expect(provesTransitioned(TICKETS_SUCCESS, "done", " team-7 ")).toBe(true);
    expect(provesTransitioned(JIRA_SUCCESS, "done", "team-7")).toBe(true);
  });

  it("an explicit error field is never proof, even alongside a status field", () => {
    expect(provesTransitioned({ error: "nope", status: "transitioned", key: "TEAM-7", to: "done" }, "done", "TEAM-7")).toBe(false);
  });
});

describe("provesTransitioned — TEAM-6131 F3: the bare tickets shape names neither ticket nor destination", () => {
  it('a bare {status:"transitioned"} is NOT proof for any target', () => {
    expect(provesTransitioned({ status: "transitioned" }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ status: "transitioned" }, "blocked", "TEAM-7")).toBe(false);
  });

  it("a tickets shape with `to` but no key is not proof", () => {
    const { key: _key, ...noKey } = TICKETS_SUCCESS;
    void _key;
    expect(provesTransitioned(noKey, "done", "TEAM-7")).toBe(false);
  });

  it("a tickets shape with a key but no `to` is not proof", () => {
    const { to: _to, ...noTo } = TICKETS_SUCCESS;
    void _to;
    expect(provesTransitioned(noTo, "done", "TEAM-7")).toBe(false);
  });

  it("a tickets shape for a DIFFERENT ticket is not proof", () => {
    expect(provesTransitioned(ticketsSuccess("TEAM-8", "done"), "done", "TEAM-7")).toBe(false);
  });

  it("a jira shape for a DIFFERENT ticket is not proof", () => {
    expect(provesTransitioned({ ...JIRA_SUCCESS, ticketId: "TEAM-8" }, "done", "TEAM-7")).toBe(false);
  });
});

describe("provesTransitioned — TEAM-6131 F4: a Jira transition matched by NAME whose destination is not the target", () => {
  it("the real name≠destination shape (Done → Closed) proves done", () => {
    expect(provesTransitioned(JIRA_NAME_MATCH_CLOSED, "done", "TEAM-7")).toBe(true);
  });

  it("…but not for another ticket", () => {
    expect(provesTransitioned(JIRA_NAME_MATCH_CLOSED, "done", "TEAM-8")).toBe(false);
  });

  it("…and not when the landed status is one of the hub's OWN other columns (arbitrary status)", () => {
    for (const landed of ["todo", "ready", "in_progress", "in_review", "blocked", "cancelled"]) {
      expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, status: landed }, "done", "TEAM-7")).toBe(false);
    }
    // and the plain pre-TEAM-6131 shape with an arbitrary status stays unproven
    expect(provesTransitioned({ ticketId: "TEAM-7", status: "in_progress", message: "Transitioned to in_progress" }, "done", "TEAM-7")).toBe(false);
  });

  it("…and not when `requested` is not the target", () => {
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, requested: "blocked" }, "done", "TEAM-7")).toBe(false);
  });

  it("…and not without the matched transition the Lambda echoes (requested alone is not evidence)", () => {
    const { matchedTransition: _mt, ...noMatch } = JIRA_NAME_MATCH_CLOSED;
    void _mt;
    expect(provesTransitioned(noMatch, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, matchedTransition: { id: "", name: "Done", to: "Closed" } }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, matchedTransition: "31" }, "done", "TEAM-7")).toBe(false);
  });
});

describe("provesTransitioned — unproven shapes (the P2 false-ack gap)", () => {
  it.each([
    ["JSON null", null],
    ["empty object", {}],
    ["a refusal-shaped-but-unrecognized object", { ok: true, status: "blocked" }],
    ["a bare array", []],
    ["a bare string", "not json"],
    ["a bare number", 42],
    ["undefined", undefined],
  ])("%s is not proof", (_label, payload) => {
    expect(provesTransitioned(payload as unknown, "done", "TEAM-7")).toBe(false);
  });
});

/**
 * TEAM-6141 (review fix round 3, P2) — the TEAM-6131 F4 pair proved too much. An
 * absent/empty `status` normalizes to "" — neither the target nor a hub column — so it
 * fell into the fallback, which only checked that `requested` was the target and that
 * `matchedTransition` had three non-empty strings: nothing tied the LANDED status to
 * the destination the Lambda echoed, and nothing tied the transition's NAME to the
 * requested action. The rule now mirrors the Lambda's own match
 * (lambda/agentcore-hub-jira/index.mjs transitionTicket: name or destination equals the
 * target's Jira display name) and its own status map (mapStatusToInternal): a landed
 * status must be non-empty, the matched transition must be NAMED for the target, and the
 * landed status must be the Lambda's mapping of the destination it echoed.
 */
describe("provesTransitioned — TEAM-6141: the Jira pair proves only a move it can account for", () => {
  const START_PROGRESS = { id: "21", name: "Start Progress", to: "In Progress" };
  const START_REVIEW = { id: "51", name: "Start Review", to: "Waiting for review" };

  it("(a) no landed status at all is not proof, whatever the metadata says", () => {
    expect(provesTransitioned({ ticketId: "TEAM-7", requested: "done", matchedTransition: START_PROGRESS }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ticketId: "TEAM-7", status: null, requested: "done", matchedTransition: START_PROGRESS }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ticketId: "TEAM-7", requested: "done", matchedTransition: JIRA_NAME_MATCH_CLOSED.matchedTransition }, "done", "TEAM-7")).toBe(false);
  });

  it("(b) an empty / blank landed status is not proof, even with the real Done → Closed transition", () => {
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, status: "" }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, status: "   " }, "done", "TEAM-7")).toBe(false);
  });

  it("(c) a transition whose NAME is unrelated to the requested action is not proof, even when `to` ↔ `status` agree", () => {
    const landedElsewhere = { ticketId: "TEAM-7", status: "waiting_for_review", requested: "done" };
    expect(provesTransitioned({ ...landedElsewhere, matchedTransition: START_REVIEW }, "done", "TEAM-7")).toBe(false);
    // …and the ticket's literal shape, with no id, stays unproven too.
    expect(provesTransitioned({ ...landedElsewhere, matchedTransition: { name: "Start Review", to: "Waiting for review" } }, "done", "TEAM-7")).toBe(false);
  });

  it("the landed status must be the Lambda's own mapping of the destination it echoed", () => {
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, matchedTransition: { id: "31", name: "Done", to: "Resolved" } }, "done", "TEAM-7")).toBe(false);
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, status: "resolved" }, "done", "TEAM-7")).toBe(false);
  });

  it("the name must be the TARGET's Jira display name — a destination-only match cannot land elsewhere", () => {
    // The Lambda would never have matched "Close it" for a requested done.
    expect(provesTransitioned({ ...JIRA_NAME_MATCH_CLOSED, matchedTransition: { id: "31", name: "Close it", to: "Closed" } }, "done", "TEAM-7")).toBe(false);
  });

  it("the real Done → Closed shape is still proof, case- and whitespace-insensitively", () => {
    expect(provesTransitioned(JIRA_NAME_MATCH_CLOSED, "done", "TEAM-7")).toBe(true);
    expect(
      provesTransitioned(
        { ticketId: "TEAM-7", status: "CLOSED", requested: " Done ", matchedTransition: { id: "31", name: "DONE", to: " closed " } },
        "done",
        "TEAM-7"
      )
    ).toBe(true);
  });

  it("works for a target whose Jira display name has a space (in_progress ↔ \"In Progress\")", () => {
    const doing = { ticketId: "TEAM-7", status: "doing", requested: "in_progress" };
    expect(provesTransitioned({ ...doing, matchedTransition: { id: "4", name: "In Progress", to: "Doing" } }, "in_progress", "TEAM-7")).toBe(true);
    expect(provesTransitioned({ ...doing, matchedTransition: { id: "4", name: "Start Progress", to: "Doing" } }, "in_progress", "TEAM-7")).toBe(false);
  });
});

describe("jiraStatusToInternal — the TS mirror of the jira Lambda's mapStatusToInternal", () => {
  it.each([
    ["To Do", "todo"],
    ["Ready", "ready"],
    ["In Progress", "in_progress"],
    ["In Review", "in_review"],
    ["Blocked", "blocked"],
    ["Done", "done"],
    ["Won't Do", "cancelled"],
    ["wont do", "cancelled"],
    ["Cancelled", "cancelled"],
    ["Canceled", "cancelled"],
    ["Closed", "closed"],
    ["Resolved", "resolved"],
    ["Waiting for review", "waiting_for_review"],
    ["  In Progress ", "in_progress"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("%j → %j", (name, internal) => {
    expect(jiraStatusToInternal(name)).toBe(internal);
  });
});
