import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
import reviewCompletion from "./__fixtures__/design-amendment/team-5357-completion.json";
import { fake, resetFake, seedTicket, PROVIDER_503, awsError } from "./__fixtures__/ticket-fakes.mjs";

/**
 * TEAM-6151 (TEAM-6094 review round 4) — the DL-039 FINALIZE write must be conditional on
 * exactly the provisional record this finalizer established.
 *
 * Three P1s on TEAM-6140's protocol, each reproduced with the REAL handler / drain over the
 * shared ticket fakes (a real ETag store: `fake.putError` runs BEFORE the fake's IfMatch
 * compare, so a concurrent writer B is landed inside it and A's PUT takes a GENUINE 412):
 *   F1  report_completion's finalizers went through the generic record write, which on a
 *       412 re-reads and re-applies the SAME stale decision (adoptHold ignores the re-read
 *       hold fields under deliveredNow, and carries no securityReview at all) — a stale
 *       finalize rebased an old authorization over a newer hold / revocation / delivery.
 *   F2  a non-PASS security review whose follow-ups could not be filed was queued with its
 *       admission still PROVISIONAL, and the drain never finalized it: every tick's Done
 *       was refused by the twins and retried until the queue gave up.
 *   F3  the replay's revocation of a FINALIZED admission was a compensating write: its
 *       notice was posted before the stamp, and a lost CAS left the trusted stamp behind.
 */

const FAKES = "./__fixtures__/ticket-fakes.mjs";

vi.mock("@aws-sdk/client-s3", async () => (await import(FAKES)).s3Module());
vi.mock("@aws-sdk/client-lambda", async () => (await import(FAKES)).lambdaModule());
vi.mock("@aws-sdk/client-sqs", async () => (await import(FAKES)).sqsModule());
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
}));

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/agentcore-hub-ticket-replay.fifo";
Object.assign(process.env, {
  ARTIFACT_BUCKET: "test-bucket", TICKET_PROVIDER: "jira", TICKET_REPLAY_QUEUE_URL: QUEUE_URL,
  FOLLOW_UP_CLAIM_WAIT_MS: "1", CLAIM_RETRY_WAIT_MS: "1", EVENTS_TABLE: "agentcore-hub-events", WORKFLOWS_TABLE: "agentcore-hub-workflows",
});
const output = await import("./index.mjs");
// Both ticket twins' DL-030 Done guard, judged on the record each scenario leaves behind.
const TWIN_GUARDS = [await import("../agentcore-hub-jira/gate-contract.mjs"), await import("../agentcore-hub-tickets/gate-contract.mjs")];

// ─── the db9sx9 operator ticket (merge brief, Merge Approval gate) ───
const EPIC = "TEAM-5600";
const BUILD = "TEAM-5601";
const GATE = "TEAM-5602";
const B_KEY = `completions/${BUILD}.json`;
const call0 = fixture.calls[0];
// ─── the rfq233 security review (non-PASS verdict, done design amendment, two dev lanes) ───
const EPIC_R = "TEAM-5353";
const REVIEW = "TEAM-5357";
const AMEND = "TEAM-5399";
const DEV1 = "TEAM-5358";
const DEV2 = "TEAM-5359";
const R_KEY = `completions/${REVIEW}.json`;

const result = (res) => JSON.parse(res.content[0].text);
const record = (key) => JSON.parse(fake.objects.get(key));
/** An external writer lands a new record version: the body and a NEW ETag. */
const setRecord = (key, obj) => {
  fake.objects.set(key, JSON.stringify(obj));
  fake.etags.set(key, `"e${++fake.etagSeq}"`);
};
const patchRecord = (key, patch) => setRecord(key, { ...record(key), ...patch });
const bodyOf = (p) => JSON.parse(typeof p.Body === "string" ? p.Body : Buffer.from(p.Body).toString("utf8"));
const keyPuts = (key) => fake.puts.filter((p) => p.Key === key);
const transitionsOf = (ticketId, from = 0) => fake.calls.slice(from).filter((c) => c.tool === "Tickets___transition_ticket" && c.params?.ticket_id === ticketId);
const PRECONDITION_FAILED = () => awsError("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");

const twinsRefuseBrief = (key) => {
  for (const twin of TWIN_GUARDS) expect(twin.judgeBriefHold(key, fake.objects.get(key))).toMatchObject({ proven: false });
};
const twinsAdmitBrief = (key) => {
  for (const twin of TWIN_GUARDS) expect(twin.judgeBriefHold(key, fake.objects.get(key))).toBeNull();
};
const twinsRefuseAdmission = (key, re = /PROVISIONAL securityReview admission/) => {
  for (const twin of TWIN_GUARDS) expect(twin.securityReviewRecordRefusal(key, record(key))).toMatch(re);
};
const twinsAdmitAdmission = (key) => {
  for (const twin of TWIN_GUARDS) expect(twin.judgeCompletionRecord(key, fake.objects.get(key), { securityReview: true })).toMatchObject({ proven: true });
};
/** The REAL twin's Done guard, composed onto the fake's transition tool (`completionRecordRequired` text: no `Jira API NNN:`, so not permanent). */
const realDoneGuard = (key) => (p) => {
  const j = TWIN_GUARDS[1].judgeCompletionRecord(key, fake.objects.get(key), { securityReview: true });
  return j.proven ? null : `Cannot move ${p.ticket_id} to done: a security-review ticket needs its completion record first — re-run WorkflowOutput___report_completion (${j.why})`;
};

/** The outage: the operator's report queues its writes (fixture flow). Leaves the provider UP. */
const seedBrief = async () => {
  for (const t of fixture.tickets) seedTicket(t);
  fake.objects.set(fixture.mergeBrief.s3Key, fixture.mergeBrief.body);
  fake.down = true;
  const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
  expect(res).toMatchObject(fixture.expectedResponse);
  expect(fake.queue).toHaveLength(1);
  fake.down = false;
};
const rerun = async () => result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
const drainQueued = async () => output.drainCompletion(JSON.parse(fake.queue[0].Body));
/** Two open Merge Approval gates, neither blocked by the ticket: the gate cannot be NAMED ⇒ the drain holds the brief. */
const gateUnidentifiable = () => {
  fake.tickets.get(GATE).blockedBy = [];
  seedTicket({ ticketId: "TEAM-5604", title: "Merge Approval: db9sx9 (hotfix)", status: "To Do", assignee: "human:approver", parentKey: EPIC });
};
const allGatesDone = () => { for (const t of fake.tickets.values()) if (/^Merge Approval:/.test(t.title)) t.status = "Done"; };
const holdUnnamed = async () => {
  gateUnidentifiable();
  const out = await drainQueued();
  expect(out.outcome).toBe("dropped");
  expect(record(B_KEY)).toMatchObject({ briefPending: true, undelivered: [expect.objectContaining({ part: "brief" })] });
};

const seedReview = () => {
  seedTicket({ ticketId: EPIC_R, title: "Epic: rfq233", status: "In Progress", assignee: "agentcore_hub_requirements_analyst" });
  seedTicket({ ticketId: REVIEW, title: "Security review: rfq233", status: "In Progress", assignee: "agentcore_hub_security_reviewer", parentKey: EPIC_R });
  seedTicket({ ticketId: AMEND, title: "Amend design: rfq233", status: "Done", assignee: "agentcore_hub_backend_designer", parentKey: EPIC_R, labels: ["fix:review_fix", "phase:design", `origin:${REVIEW}`] });
  seedTicket({ ticketId: DEV1, title: "Dev: rfq233 backend", status: "To Do", assignee: "agentcore_hub_backend_dev", parentKey: EPIC_R, blockedBy: [REVIEW] });
  seedTicket({ ticketId: DEV2, title: "Dev: rfq233 frontend", status: "To Do", assignee: "agentcore_hub_frontend_dev", parentKey: EPIC_R, blockedBy: [REVIEW] });
};
const reportReview = async (extra = {}) => result(await output.handler({
  tool_name: "WorkflowOutput___report_completion",
  arguments: { ...reviewCompletion, _comment: undefined, ...extra },
}));

// ─── a residual-findings replay on the db9sx9 ticket (ticket-probe's withResidual idiom) ───
const DEV = "TEAM-5599";
const AMEND_B = "TEAM-5698";
const withResidual = async () => {
  await seedBrief();
  seedTicket({ ticketId: DEV, title: "Dev: db9sx9 backend", status: "To Do", assignee: "agentcore_hub_backend_dev", parentKey: EPIC, blockedBy: [BUILD] });
  seedTicket({ ticketId: AMEND_B, title: "Amend design: db9sx9", status: "Done", assignee: "agentcore_hub_backend_designer", parentKey: EPIC });
  fake.queue[0].Body = JSON.stringify({ ...JSON.parse(fake.queue[0].Body), residual: { verdict: "FAIL", summary: "R1: rotate the probe role key", artifacts: "", amendmentTicketId: AMEND_B } });
};
const reopenAmendmentOnResidualPost = () => {
  fake.beforeTool = (tool, params) => { if (tool === "Tickets___add_comment" && params.ticket_id === DEV) fake.tickets.get(AMEND_B).status = "To Do"; };
};

beforeEach(() => {
  resetFake();
});

describe("TEAM-6151 F1 — a stale finalizer must not rebase its decision over a newer record", () => {
  it("T1 report brief finalize vs a drain re-hold: the finalize loses its CAS, the hold stands, no Done, both twins refuse", async () => {
    await seedBrief();
    await holdUnnamed();
    allGatesDone();
    const putsBefore = keyPuts(B_KEY).length;
    const callsBefore = fake.calls.length;
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== B_KEY) return null;
      if (++n === 2) {
        // Between A's post-write confirm and A's FINALIZE PUT: the gate reopens and drain B
        // re-holds the brief on the record (the off-gate hold, TEAM-6140 D1 shape).
        fake.tickets.get(GATE).status = "To Do";
        const cur = record(B_KEY);
        delete cur.briefDisposition;
        delete cur.briefHoldReason;
        setRecord(B_KEY, {
          ...cur, briefPending: true, briefFallbackReason: `not on the gate: the Merge Approval gate ${GATE} reads To Do`,
          undelivered: [{ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: "not on the gate: reopened", postedOn: [BUILD, EPIC] }],
        });
      }
      return null;
    };
    const res = await rerun();
    expect(fake.tickets.get(BUILD).status, "no Done with the gate open and the brief off it").toBe("In Progress");
    expect(transitionsOf(BUILD, callsBefore)).toHaveLength(0);
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    const r = record(B_KEY);
    expect(r.briefPending, "B's hold stands").toBe(true);
    expect(r.briefDisposition?.release, "A's release was NOT rebased over the hold").toBeUndefined();
    expect(r.undelivered).toEqual([expect.objectContaining({ part: "brief" })]);
    twinsRefuseBrief(B_KEY);
    expect(n, "A wrote the provisional release, then attempted exactly ONE finalize").toBe(2);
    expect(keyPuts(B_KEY).length - putsBefore).toBe(2);
  });

  it("T2 report admission finalize vs a provisional revocation: the finalize loses its CAS, the stamp stays PROVISIONAL, no Done, both twins refuse", async () => {
    seedReview();
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== R_KEY) return null;
      if (++n === 2) {
        // Between A's final amendment confirm and A's FINALIZE PUT: the amendment reopens and
        // writer B (the drain's replay, or a re-run) persists a PROVISIONAL admission.
        fake.tickets.get(AMEND).status = "To Do";
        patchRecord(R_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND, provisional: true } });
      }
      return null;
    };
    const res = await reportReview();
    expect(fake.tickets.get(REVIEW).status, "no Done while the amendment is To Do").toBe("In Progress");
    expect(transitionsOf(REVIEW)).toHaveLength(0);
    expect(record(R_KEY).securityReview, "B's provisional admission stands").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true });
    twinsRefuseAdmission(R_KEY);
    expect(res).toMatchObject({ ok: false, reason: "completion_record_contended", next_action: "retry_report_completion", recorded: true });
    expect(n, "exactly ONE finalize attempt").toBe(2);
  });

  it("T3 report brief finalize vs a drain gate delivery: the delivery stands (briefDelivered:gate), no off_gate release is written over it; the re-run converges", async () => {
    await seedBrief();
    await holdUnnamed();
    allGatesDone();
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== B_KEY) return null;
      if (++n === 2) {
        // Drain B put the brief ON the gate and cleared the hold (step 6, clearBriefHoldOnGate).
        const cur = record(B_KEY);
        for (const f of ["briefDisposition", "briefHoldReason", "briefFallbackReason", "undelivered"]) delete cur[f];
        setRecord(B_KEY, { ...cur, briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
      }
      return null;
    };
    const res = await rerun();
    const r = record(B_KEY);
    expect(r.briefDisposition, "A's gate_settled release was NOT written over B's delivery").toBeUndefined();
    expect(r).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(res.status).toBe("complete_pending_brief");
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(n, "exactly ONE finalize attempt").toBe(2);
    // Convergence: the identical retry reads the delivered record and closes the ticket.
    fake.putError = null;
    expect((await rerun()).status).toBe("complete");
    expect(record(B_KEY)).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    twinsAdmitBrief(B_KEY);
  });
});

describe("TEAM-6151 F2 — a queued non-PASS review's admission is finalized by the drain", () => {
  it("T4 follow-ups 503 ⇒ queued with a PROVISIONAL stamp and 'do NOT retry'; the drain finalizes (provisional → final) and Dones", async () => {
    seedReview();
    fake.failTool = { Tickets___create_ticket: PROVIDER_503 };
    const res = await reportReview({ follow_ups: call0.arguments.follow_ups });
    expect(res).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(res.message).toMatch(/do NOT retry report_completion/);
    expect(record(R_KEY)).toMatchObject({ status: "complete_pending_follow_ups", followUpsPending: true, ticketWrites: "queued", securityReview: { verdict: "FAIL", amendmentTicketId: AMEND, provisional: true } });
    expect(fake.queue).toHaveLength(1);
    expect(JSON.parse(fake.queue[0].Body).residual).toMatchObject({ amendmentTicketId: AMEND });
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");

    // The provider is back; the twin's REAL Done guard judges the record on every Done.
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    const putsBefore = keyPuts(R_KEY).length;
    let seenAtDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) seenAtDone = record(R_KEY); };
    const out = await drainQueued();
    expect(out.outcome, `drain: ${out.reason || ""}`).toBe("applied");
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect([...fake.tickets.values()].some((t) => /Grant the probe role/.test(t.title)), "the follow-up was filed by the drain").toBe(true);
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", followUpsPending: false });
    expect(record(R_KEY).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND });
    const bodies = keyPuts(R_KEY).slice(putsBefore).map(bodyOf);
    expect(bodies.map((b) => b.securityReview?.provisional), "provisional (step 6), finalized, applied").toEqual([true, undefined, undefined]);
    expect(bodies[2]).toMatchObject({ ticketWrites: "applied" });
    expect(seenAtDone?.securityReview?.provisional, "never a Done on a provisional record").toBeUndefined();
    twinsAdmitAdmission(R_KEY);
  });
});

describe("TEAM-6151 F3 — a replayed admission is re-established PROVISIONALLY before it is re-confirmed", () => {
  it("T5 the amendment reopens during the replay and the drop stamp loses its CAS ⇒ the record is ALREADY provisional (both twins refuse); the next tick drops", async () => {
    await withResidual();
    patchRecord(B_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND_B } });
    reopenAmendmentOnResidualPost();
    let n = 0;
    fake.putError = (input) => (input.Key === B_KEY && ++n > 1 ? PRECONDITION_FAILED() : null);
    const out = await drainQueued();
    expect(out.outcome).toBe("retry");
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(transitionsOf(BUILD)).toHaveLength(0);
    expect(record(B_KEY).securityReview, "the marker landed BEFORE the confirm, so the lost compensation changes nothing").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND_B, provisional: true });
    twinsRefuseAdmission(B_KEY, /PROVISIONAL securityReview admission on amendment TEAM-5698/);
    fake.putError = null;
    const again = await drainQueued();
    expect(again).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record(B_KEY)).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "amendment" } });
    expect(record(B_KEY).securityReview.provisional).toBe(true);
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("T6 the 'admission is PROVISIONAL again' notice is posted only AFTER the provisional marker is durable", async () => {
    await withResidual();
    patchRecord(B_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND_B } });
    const seq = [];
    fake.beforeTool = (tool, params) => {
      if (tool === "Tickets___add_comment" && params.ticket_id === DEV) fake.tickets.get(AMEND_B).status = "To Do";
      if (tool === "Tickets___add_comment" && String(params.comment).startsWith(`[replay-dropped:${BUILD}:amendment]`)) seq.push("notice");
    };
    fake.putError = (input) => {
      if (input.Key === B_KEY && bodyOf(input).securityReview?.provisional === true) seq.push("put:provisional");
      return null;
    };
    const out = await drainQueued();
    expect(out).toMatchObject({ outcome: "dropped", permanent: true });
    expect(seq.indexOf("notice")).toBeGreaterThan(-1);
    expect(seq.indexOf("put:provisional")).toBeGreaterThan(-1);
    expect(seq.indexOf("put:provisional"), `order: ${seq.join(" → ")}`).toBeLessThan(seq.indexOf("notice"));
    expect(record(B_KEY).securityReview.provisional).toBe(true);
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("T8 a replayed admission on a done amendment: provisional (step 6) → finalized → Done → applied; never a Done on a provisional record", async () => {
    await withResidual();
    patchRecord(B_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND_B } });
    const putsBefore = keyPuts(B_KEY).length;
    let seenAtDone = null;
    fake.onTransition = (t) => { if (t.ticketId === BUILD) seenAtDone = record(B_KEY); };
    const out = await drainQueued();
    expect(out.outcome, `drain: ${out.reason || ""}`).toBe("applied");
    const bodies = keyPuts(B_KEY).slice(putsBefore).map(bodyOf);
    expect(bodies.map((b) => b.securityReview?.provisional), "provisional (step 6), finalized, applied").toEqual([true, undefined, undefined]);
    expect(bodies[2]).toMatchObject({ ticketWrites: "applied" });
    expect(seenAtDone?.securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND_B });
    expect(record(B_KEY).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND_B });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    twinsAdmitAdmission(B_KEY);
  });
});

describe("TEAM-6151 — the ONE conditional finalize", () => {
  it("T7 finalizeProvisionalRecord: no marker ⇒ no PUT; one CAS on the provisional ETag; 412/404 ⇒ superseded with nothing written; 5xx ⇒ error; the base is never mutated", async () => {
    const { finalizeProvisionalRecord, finalizeSecurityReview } = output;
    expect(typeof finalizeProvisionalRecord, "exported").toBe("function");
    const key = "completions/UNIT-6151.json";
    const put = (obj) => { setRecord(key, obj); return fake.etags.get(key); };
    const provisional = () => ({ status: "complete", securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true } });
    const base = () => ({ record: record(key), etag: fake.etags.get(key) });

    // (a) no marker on the record this caller wrote ⇒ refused, no PUT at all
    put({ status: "complete", securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1" } });
    let puts = fake.puts.length;
    let r = await finalizeProvisionalRecord({ key, base: base(), what: "securityReview", apply: finalizeSecurityReview });
    expect(r.ok).toBe(false);
    expect(fake.puts.length).toBe(puts);

    // (b) success: one PUT, the marker is gone on S3 and in the result, the base is untouched
    put(provisional());
    const b = base();
    puts = fake.puts.length;
    r = await finalizeProvisionalRecord({ key, base: b, what: "securityReview", apply: finalizeSecurityReview });
    expect(r).toMatchObject({ ok: true, etag: fake.etags.get(key) });
    expect(fake.puts.length).toBe(puts + 1);
    expect(fake.puts.at(-1).IfMatch).toBe(b.etag);
    expect(r.record.securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: "TEAM-1" });
    expect(record(key).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: "TEAM-1" });
    expect(b.record.securityReview.provisional, "the caller's record is not mutated").toBe(true);

    // (c) the record moved since the provisional write ⇒ ONE PUT, superseded, nothing written
    put(provisional());
    const stale = base();
    fake.etags.set(key, '"moved-by-B"');
    puts = fake.puts.length;
    r = await finalizeProvisionalRecord({ key, base: stale, what: "securityReview", apply: finalizeSecurityReview });
    expect(r).toMatchObject({ ok: false, superseded: true });
    expect(fake.puts.length).toBe(puts + 1);
    expect(record(key).securityReview.provisional, "B's record stands").toBe(true);
    expect(stale.record.securityReview.provisional).toBe(true);

    // (d) the key vanished (404 on an IfMatch write) ⇒ superseded
    put(provisional());
    const gone = base();
    fake.objects.delete(key);
    fake.etags.delete(key);
    r = await finalizeProvisionalRecord({ key, base: gone, what: "securityReview", apply: finalizeSecurityReview });
    expect(r).toMatchObject({ ok: false, superseded: true });
    expect(fake.objects.has(key)).toBe(false);

    // (e) S3 5xx ⇒ error, not superseded
    put(provisional());
    fake.putError = (input) => (input.Key === key ? awsError("InternalError", 500, "We encountered an internal error") : null);
    r = await finalizeProvisionalRecord({ key, base: base(), what: "securityReview", apply: finalizeSecurityReview });
    expect(r.ok).toBe(false);
    expect(r.superseded).toBeUndefined();
    expect(r.error).toMatch(/InternalError/);
    fake.putError = null;

    // (f) the brief marker: the same helper, the release becomes trusted in one CAS
    put({ status: "complete_pending_brief", briefPending: true, briefHoldReason: "provisional", briefDisposition: { release: true, kind: "gate_settled", provisional: true } });
    r = await finalizeProvisionalRecord({ key, base: base(), what: "brief", apply: (rec) => { rec.briefPending = false; delete rec.briefDisposition.provisional; delete rec.briefHoldReason; rec.status = "complete"; return rec; } });
    expect(r.ok).toBe(true);
    expect(record(key)).toMatchObject({ status: "complete", briefPending: false, briefDisposition: { release: true, kind: "gate_settled" } });
    expect(record(key).briefDisposition.provisional).toBeUndefined();
    // and a brief record whose hold is not provisional is refused without a PUT
    put({ briefPending: true, briefDisposition: { release: false, kind: "gate_reopened" } });
    puts = fake.puts.length;
    r = await finalizeProvisionalRecord({ key, base: base(), what: "brief", apply: (rec) => rec });
    expect(r.ok).toBe(false);
    expect(fake.puts.length).toBe(puts);
  });

  it("T9 the record write refuses to act as an admission finalizer: a failed-Done rewrite that re-reads a newer PROVISIONAL stamp leaves it standing", async () => {
    seedReview();
    // A plain failed transition (a 4xx is not a provider outage, so nothing is queued).
    fake.failTool = { Tickets___transition_ticket: "Jira API 400: stuck" };
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== R_KEY) return null;
      // PUT 1 = the provisional first write, PUT 2 = the finalize, PUT 3 = the post-failure
      // rewrite. Writer B re-marks the admission PROVISIONAL just before the rewrite.
      if (++n === 3) patchRecord(R_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND, provisional: true } });
      return null;
    };
    const res = await reportReview();
    expect(n).toBeGreaterThanOrEqual(3);
    expect(res).toMatchObject({ status: "complete_transition_failed", next_action: "retry_report_completion" });
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY).securityReview, "B's provisional stamp was NOT rewritten away").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true });
    twinsRefuseAdmission(R_KEY);
  });
});
