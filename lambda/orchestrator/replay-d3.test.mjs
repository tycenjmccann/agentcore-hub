import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3748 D3 — AC-D3.1 replay: ztc61f ship-review non-convergence.
 *
 * The mirror image of the replay-d1 / replay-d2 fixtures. There the assertion is
 * "0 manual interventions" — a stalled run recovers itself. Here the assertion is
 * the OPPOSITE and equally important: a ship review that genuinely CANNOT
 * converge must NOT spin the rework loop forever — after `maxRounds` diff-scoped
 * CHANGES-NEEDED rounds it stops re-opening the upstream work and routes the gate
 * to a human, exactly once.
 *
 * ztc61f is a real run whose release-manager kept returning CHANGES-NEEDED on the
 * same seam in the PR diff. The old loop re-opened the dev tickets every round
 * without bound. This replays three IN-DIFF rejections through the REAL
 * review-cap (review-cap.mjs is NOT mocked — only index.mjs's I/O seams and the
 * workflow-store ledger are) and pins three things at the round the cap trips:
 *
 *   1. the cap-reached escalation event fires (review.cap_reached), once;
 *   2. the upstream re-open is SUPPRESSED — no `todo` write lands on the dev
 *      ticket the way it did on rounds 1 and 2;
 *   3. there is NO round-4 auto-dispatch — a further rejection with no
 *      `DECISION: continue` stays escalated and re-opens nothing.
 *
 * A round's findings are IN-DIFF (they cite the changed file), so the diff-scoped
 * gate does not downgrade them — each of the three rounds is a genuine, gating
 * rework round. That is what makes this a non-convergence, not a stream of
 * out-of-diff nits (AC-D3.2 covers the downgrade path).
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    // The gate's cap ledger, shared by reference with workflow.reviewGateHistory
    // so the REAL cap accumulates rounds across replayed rejections.
    ledger: /** @type {any} */ (null),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession → none
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "QueryCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class {}, InvokeCommand: class { constructor(i) { this.input = i; } } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  // index.mjs imports ListObjectsV2Command (loadReviewPackage). Native-ESM
  // strict-linking needs every imported name present on the mock; harmless in
  // vitest, required to run this suite under the node shim.
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

// The REAL review-cap is used (its escalation is the whole point of this
// replay). Only the workflow-store ledger is stubbed — appendReviewRound
// accumulates rounds and returns the post-write ledger, exactly as the store's
// list_append does, so the cap's effective-round count really climbs.
vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  ackNotifications: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  appendReviewRound: vi.fn(async (_wfId, _gateId, round) => {
    h.state.ledger.rounds = [...h.state.ledger.rounds, round];
    return { ...h.state.ledger };
  }),
  appendReviewCapEscalation: vi.fn(async (_wfId, _gateId, e) => {
    h.state.ledger.escalations = [...h.state.ledger.escalations, e];
  }),
  appendReviewAuthorization: vi.fn(async (_wfId, _gateId, a) => {
    h.state.ledger.authorizations = [...h.state.ledger.authorizations, a];
  }),
  appendReviewNotificationOnce: vi.fn(async () => true),
}));

let handleReviewRejection;

const GATE_ID = "TEAM-900";
const UPSTREAM = "TEAM-10"; // the reworked dev ticket (agentcore_hub_api_dev)
const CHANGED_FILE = "src/parser.ts";

/**
 * One rejection of the ztc61f ship gate, carrying an IN-DIFF finding (it cites
 * the file the PR changed) so the diff-scoped gate keeps it CHANGES-NEEDED. The
 * feedback differs per round so each is a genuine new round, not a redelivery of
 * one rejection (the cap's null-SHA content fingerprint would otherwise collapse
 * identical feedback onto a single round).
 *
 * TEAM-3756 F1: the gate ticket deliberately does NOT carry reviewFindings —
 * nothing in production ever wrote that field, so a replay that pre-populated it
 * proved a path that could not occur. The findings ride as the JSON block in the
 * rejection comment (the release manager's structured classification), and the
 * orchestrator DERIVES them — the same end-to-end path production takes.
 */
const findingsBlock = (files) =>
  "\n```json\n" + JSON.stringify({ findings: files.map((f) => ({ citedFiles: [f] })) }) + "\n```";
const rejection = (comment, citedFile = CHANGED_FILE) => ({
  ticketId: GATE_ID,
  workflowId: "wf_1",
  parentId: "TEAM-1",
  blockedBy: [UPSTREAM],
  reviewComment: comment + findingsBlock([citedFile]),
  changeSet: [CHANGED_FILE],
});

// A `todo` write on the upstream dev ticket == the rework loop re-opening it.
const reopenUpdates = () =>
  h.state.updates.filter(
    (u) => u.Key.ticketId === UPSTREAM && u.ExpressionAttributeValues?.[":s"] === "todo"
  );
// A park write on the gate ticket == the gate handed to a human.
const gateParkUpdates = () =>
  h.state.updates.filter(
    (u) => u.Key.ticketId === GATE_ID && u.ExpressionAttributeValues?.[":s"] === "in_review"
  );
const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);

beforeEach(async () => {
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.ledger = { rounds: [], authorizations: [], escalations: [] };
  // agentcore_hub_api_dev is a "development"-phase agent in the fallback roster,
  // so the gate's onReject resolves to "rework" and the cap is exercised.
  h.state.tickets = {
    [UPSTREAM]: { ticketId: UPSTREAM, assignee: "agentcore_hub_api_dev", type: "task", status: "done" },
  };
  h.state.workflow = {
    id: "wf_1",
    workflowDefId: "software-delivery",
    humanNotifications: [],
    resumeContexts: {},
    reviewGateHistory: { [GATE_ID]: h.state.ledger }, // shared reference
  };
  vi.resetModules();
  ({ handleReviewRejection } = await import("./index.mjs"));
});

describe("AC-D3.1 replay — ztc61f (ship review that never converges is capped, not spun)", () => {
  it("3 in-diff CHANGES-NEEDED rounds → human decision gate; re-open suppressed; no round 4", async () => {
    // ── Round 1: genuine rework. The dev ticket is re-opened. ──
    await handleReviewRejection(rejection("Round 1: null deref in the new parser path."));
    expect(reopenUpdates()).toHaveLength(1);
    expect(eventsOfType("review.cap_reached")).toHaveLength(0);
    expect(h.state.ledger.rounds).toHaveLength(1);

    // ── Round 2: still broken, still in-diff. Re-opened again. ──
    await handleReviewRejection(rejection("Round 2: the retry test still fails on the same seam."));
    expect(reopenUpdates()).toHaveLength(2);
    expect(eventsOfType("review.cap_reached")).toHaveLength(0);
    expect(h.state.ledger.rounds).toHaveLength(2);

    // ── Round 3: the cap (maxRounds 3) trips. This is the non-convergence stop. ──
    await handleReviewRejection(rejection("Round 3: same seam, the diff still does not converge."));

    // 1. cap-reached escalation event emitted, exactly once.
    const capReached = eventsOfType("review.cap_reached");
    expect(capReached).toHaveLength(1);
    expect(capReached[0].detail).toMatchObject({
      gateTicketId: GATE_ID,
      effectiveRounds: 3,
      maxRounds: 3,
    });

    // 2. upstream re-open SUPPRESSED — no new `todo` write on the dev ticket
    //    (still 2, from rounds 1 and 2 only).
    expect(reopenUpdates()).toHaveLength(2);

    // ...instead the caller announces the cap and re-opens nothing.
    const capRejected = eventsOfType("review.rejected").find((e) => e.detail?.capReached);
    expect(capRejected).toBeTruthy();
    expect(capRejected.detail.reopened).toEqual([]);

    // ...and the gate is handed to a human (parked in_review) with the escalation
    // recorded on the ledger for idempotency.
    expect(gateParkUpdates().length).toBeGreaterThan(0);
    expect(h.state.ledger.escalations).toHaveLength(1);
    expect(h.state.ledger.escalations[0]).toMatchObject({ escalatedAtRound: 3, decision: null });

    // ── Round 4: NO auto-dispatch. A further rejection with no DECISION line
    //    stays escalated: it re-opens nothing and does not re-publish the event. ──
    const updatesBefore = h.state.updates.length;
    await handleReviewRejection(rejection("Round 4: please just fix it already."));

    expect(reopenUpdates()).toHaveLength(2); // still no upstream re-open
    expect(eventsOfType("review.cap_reached")).toHaveLength(1); // not re-published (already open)
    expect(h.state.ledger.escalations).toHaveLength(1); // not re-appended
    // The only writes round 4 makes are the idempotent gate re-park, never an
    // upstream dispatch.
    for (const u of h.state.updates.slice(updatesBefore)) {
      expect(u.Key.ticketId).toBe(GATE_ID);
    }
  });
});

describe("AC-D3.2 replay — an out-of-diff rejection with DERIVED findings gates nothing (TEAM-3756 F1)", () => {
  it("no reopen, no recorded round, and the advisory cycle never advances the cap", async () => {
    // Round 1: a genuine in-diff rejection — counts and reopens.
    await handleReviewRejection(rejection("Round 1: null deref in the new parser path."));
    expect(reopenUpdates()).toHaveLength(1);
    expect(h.state.ledger.rounds).toHaveLength(1);
    // FR-D3.3: the recorded round carries its diff-scope inputs — derived, not
    // pre-populated — so recounting can re-classify it later.
    expect(h.state.ledger.rounds[0].changeSet).toEqual([CHANGED_FILE]);
    expect(h.state.ledger.rounds[0].findings[0].citedFiles).toEqual([CHANGED_FILE]);

    // Round 2: the reviewer complains about a file the PR never touched. The
    // orchestrator derives that classification from the comment's JSON block
    // (gateTicket.reviewFindings is ABSENT) and must treat the cycle as advisory.
    await handleReviewRejection(
      rejection("Nit: vendor code style could be nicer.", "vendor/untouched-legacy.ts")
    );

    expect(reopenUpdates()).toHaveLength(1);          // no new reopen
    expect(h.state.ledger.rounds).toHaveLength(1);    // no round recorded — the cap did not advance
    // TEAM-3790: the findings were DERIVED from the comment's JSON block —
    // prose provenance. Prose-derived findings may suppress the reopen (diff
    // scope), but they may NOT auto-approve the gate: the gate is PARKED for
    // the human instead (a misparse must never close a gate someone tried to
    // hold open). No done transition, no approved-with-advisory.
    const gateDone = h.state.updates.filter(
      (u) => u.Key.ticketId === GATE_ID && u.ExpressionAttributeValues?.[":s"] === "done"
    );
    expect(gateDone).toHaveLength(0);
    expect(eventsOfType("review.approved_with_advisory")).toHaveLength(0);
    const parked = eventsOfType("review.parked_advisory");
    expect(parked).toHaveLength(1);
    expect(parked[0].detail.reason).toBe("prose_derived_findings");

    // Round 3: back in-diff — the loop resumes exactly where it left off (round 2,
    // not 3: the advisory cycle left no trace in the count).
    await handleReviewRejection(rejection("Round 2 for real: the parser seam still fails."));
    expect(reopenUpdates()).toHaveLength(2);
    expect(h.state.ledger.rounds).toHaveLength(2);
    expect(eventsOfType("review.cap_reached")).toHaveLength(0); // 2 of 3 — under the cap
  });
});
