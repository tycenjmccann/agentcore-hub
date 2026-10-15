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
 *
 * TEAM-6152 (review round 5), below: the ETag alone does not identify THIS caller's provisional
 * write (S3's single-part SSE-S3 ETag is the MD5 of the body, so a byte-identical re-establishment
 * by another drain keeps the ETag) ⇒ every (re-)establishment carries a fresh `provisionalNonce`
 * and the finalize requires it; the record-write tripwire fires only on a real same-amendment
 * finalize (a provisional PASS and a PASS report both have no amendment); and a stale residual
 * replay acts only on the admission the record holds (its stamp's amendment, never a PASS).
 * The shared fake now defaults to content-hash ETags (`fake.etagMode`), which is what hid F1.
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
    expect(bodies.map((b) => typeof b.securityReview?.provisionalNonce), "TEAM-6152: the nonce lives exactly as long as the marker").toEqual(["string", "undefined", "undefined"]);
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
    expect(record(B_KEY).securityReview, "the marker landed BEFORE the confirm, so the lost compensation changes nothing").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND_B, provisional: true, provisionalNonce: expect.any(String) });
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
    expect(bodies.map((b) => typeof b.securityReview?.provisionalNonce), "TEAM-6152: the nonce lives exactly as long as the marker").toEqual(["string", "undefined", "undefined"]);
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
    // TEAM-6152: a provisional write carries the nonce that identifies it (what the ETag alone cannot).
    const provisional = () => ({ status: "complete", securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true, provisionalNonce: "nonce-A" } });
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
    put({ status: "complete_pending_brief", briefPending: true, briefHoldReason: "provisional", briefDisposition: { release: true, kind: "gate_settled", provisional: true, provisionalNonce: "nonce-B" } });
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

    // (g) TEAM-6152: a marker with NO nonce is not a write this caller made ⇒ refused, no PUT
    for (const base6152 of [
      { record: { status: "complete", securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true } }, what: "securityReview", apply: finalizeSecurityReview },
      { record: { briefPending: true, briefDisposition: { release: true, kind: "gate_settled", provisional: true } }, what: "brief", apply: (rec) => rec },
    ]) {
      put(base6152.record);
      puts = fake.puts.length;
      r = await finalizeProvisionalRecord({ key, base: base(), what: base6152.what, apply: base6152.apply });
      expect(r.ok, base6152.what).toBe(false);
      expect(r.superseded).toBeUndefined();
      expect(r.error).toMatch(/provisionalNonce/);
      expect(fake.puts.length, "no PUT").toBe(puts);
    }
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

// ─── TEAM-6152 (review round 5) ───
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The queued message with only its residual findings (no follow-ups, no brief): the shape whose step-6 write is byte-identical across drains.
 * TEAM-6164: a real message always carries its own report's follow-ups, so a drain now treats a record whose unfiled follow-ups the message
 * does not carry as a NEWER report's hold and is superseded by it; this fabricated shape keeps the record consistent with itself (the
 * outage report's follow-up hold comes off), so these tests stay about the admission.
 * TEAM-6224: likewise the brief - a record whose queued merge brief nothing recorded on the gate still owes it
 * (briefObligation), and the twins' Done guard now refuses that record; so the brief this shape omits is recorded
 * on its gate, as the earlier replay that carried it would have.
 */
const residualOnly = () => {
  if (fake.objects.has(B_KEY) && record(B_KEY).followUpsPending === true) {
    const cur = record(B_KEY);
    delete cur.followUpsMaterialized;
    setRecord(B_KEY, { ...cur, followUpsPending: false, status: "complete" });
  }
  if (fake.objects.has(B_KEY) && output.briefObligation(record(B_KEY))) {
    setRecord(B_KEY, output.clearBriefHoldOnGate({ ...record(B_KEY), briefDelivered: "gate", briefTargets: [GATE] }));
  }
  return { ...JSON.parse(fake.queue[0].Body), followUps: [], brief: undefined };
};

describe("TEAM-6152 F1 — a byte-identical re-establishment keeps the ETag (MD5), so the finalize needs a per-write nonce", () => {
  /**
   * Two REAL drains on one residual-only message. A writes its step-6 provisional stamp, re-confirms
   * the amendment done, and is held at its FINALIZE PUT; there the amendment reopens and drain B runs
   * end to end (step 0 reads A's provisional record, step 6 re-establishes the marker, step 7 sees the
   * amendment open and drops - its drop stamp 503s). A then resumes with its single CAS.
   */
  const twoDrains = async () => {
    await withResidual();
    patchRecord(B_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND_B } });
    const msg = residualOnly();
    const seen = { b: null, etagAfterA: null, etagAfterB: null };
    let inB = false;
    let paused = false;
    fake.beforePut = async (input) => {
      if (inB || paused || input.Key !== B_KEY) return;
      const body = bodyOf(input);
      if (body.securityReview && body.securityReview.provisional === undefined) {
        paused = true;
        seen.etagAfterA = fake.etags.get(B_KEY);
        fake.tickets.get(AMEND_B).status = "To Do";
        inB = true;
        fake.putError = (i) => (i.Key === B_KEY && bodyOf(i).ticketWrites === "dropped" ? awsError("InternalError", 503, "We encountered an internal error") : null);
        seen.b = await output.drainCompletion(msg);
        fake.putError = null;
        inB = false;
        seen.etagAfterB = fake.etags.get(B_KEY);
      }
    };
    const a = await output.drainCompletion(msg);
    fake.beforePut = null;
    return { a, ...seen };
  };

  it("T10 content ETags: B re-marks A's provisional stamp between A's confirm and A's finalize, the amendment reopened ⇒ A's finalize LOSES, no Done, both twins refuse; the next tick drops", async () => {
    const r = await twoDrains();
    expect(r.b.outcome, "B saw the amendment reopen; its drop stamp 503'd").toBe("retry");
    expect(fake.tickets.get(BUILD).status, "no Done while the amendment is To Do").toBe("In Progress");
    expect(transitionsOf(BUILD)).toHaveLength(0);
    expect(r.a.outcome, `A: ${r.a.reason || ""}`).toBe("retry");
    expect(r.a.reason).toMatch(/could not be FINALIZED/);
    expect(r.etagAfterB, "B's re-establishment is a DIFFERENT write (fresh nonce ⇒ different bytes ⇒ different MD5)").not.toBe(r.etagAfterA);
    const sr = record(B_KEY).securityReview;
    expect(sr).toMatchObject({ verdict: "FAIL", amendmentTicketId: AMEND_B, provisional: true });
    expect(sr.provisionalNonce).toMatch(NONCE_RE);
    twinsRefuseAdmission(B_KEY, /PROVISIONAL securityReview admission on amendment TEAM-5698/);
    const again = await output.drainCompletion(residualOnly());
    expect(again).toMatchObject({ outcome: "dropped", permanent: true });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("T11 sequence ETags (the pre-6152 fake): the same interleaving was always safe - every PUT a new ETag - which is what hid F1", async () => {
    fake.etagMode = "sequence";
    const r = await twoDrains();
    expect(r.b.outcome).toBe("retry");
    expect(r.a.outcome).toBe("retry");
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  it("T12 the brief twin: two drains release the SAME gate_settled brief with the same timestamp (identical bodies) ⇒ A's finalize must lose to B's re-establishment; no Done with the gate open", async () => {
    await seedBrief();
    await holdUnnamed();
    allGatesDone();
    // Both drains stamp `briefDisposition.at` / `by` identically: the timestamp is pinned so the only
    // thing that can make the two step-6 bodies differ is the nonce.
    const iso = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-14T12:00:00.000Z");
    try {
      const msg = { ...JSON.parse(fake.queue[0].Body), followUps: [] };
      const seen = { b: null, etagAfterA: null, etagAfterB: null, bStepSix: false };
      let inB = false;
      let paused = false;
      fake.beforeTool = (tool, params) => {
        // B's post-write confirm: the gate reopened after B's step-6 write.
        if (inB && seen.bStepSix && tool === "Tickets___get_issue" && params.ticket_id === GATE) fake.tickets.get(GATE).status = "To Do";
      };
      fake.beforePut = async (input) => {
        if (input.Key !== B_KEY) return;
        const body = bodyOf(input);
        if (inB) { if (body.briefDisposition?.provisional === true) seen.bStepSix = true; return; }
        if (paused) return;
        if (body.briefPending === false && body.briefDisposition?.release === true) {
          paused = true;
          seen.etagAfterA = fake.etags.get(B_KEY);
          inB = true;
          // B's off-gate re-hold cannot be stamped (503): the record it leaves is its step-6 write.
          fake.putError = (i) => (i.Key === B_KEY && bodyOf(i).briefPending === true && bodyOf(i).briefDisposition === undefined ? awsError("InternalError", 503, "We encountered an internal error") : null);
          seen.b = await output.drainCompletion(msg);
          fake.putError = null;
          inB = false;
          seen.etagAfterB = fake.etags.get(B_KEY);
        }
      };
      const a = await output.drainCompletion(msg);
      fake.beforePut = null;
      fake.beforeTool = null;
      expect(seen.bStepSix, "B re-established the provisional release").toBe(true);
      expect(seen.b.outcome, `B: ${seen.b.reason || ""}`).toBe("retry");
      expect(fake.tickets.get(BUILD).status, "no Done with the gate open").toBe("In Progress");
      expect(a.outcome, `A: ${a.reason || ""}`).toBe("retry");
      expect(seen.etagAfterB, "B's re-establishment is a different write").not.toBe(seen.etagAfterA);
      const r = record(B_KEY);
      expect(r.briefPending).toBe(true);
      expect(r.briefDisposition).toMatchObject({ release: true, kind: "gate_settled", provisional: true });
      expect(r.briefDisposition.provisionalNonce).toMatch(NONCE_RE);
      twinsRefuseBrief(B_KEY);
    } finally {
      iso.mockRestore();
    }
  });
});

describe("TEAM-6152 F2 — a legitimate PASS must recover from a stale FAIL replay", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };

  // TEAM-6158: the PASS re-report is its OWN message (the dedup id carries the residual's
  // identity), the stale FAIL replay is dropped SILENTLY as superseded (no notice, no drop
  // stamp, no alarm), and the PASS message Dones the ticket - no manual re-run, which the
  // agent was told not to make ("do NOT retry"). Before: the PASS was deduped onto the FAIL
  // message (pinned here as a precondition), the drop posted a false "PROVISIONAL again"
  // notice, and only a hand-driven PASS retry closed the ticket.
  it("T13 FAIL queued (Done 503) → PASS re-review (Done 503) is its own message → the amendment reopens: the stale FAIL drops as superseded, the PASS message Dones through the drain alone", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    expect(await reportReview()).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(record(R_KEY).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND });
    expect(await reportReview(PASS)).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(record(R_KEY).securityReview).toEqual({ verdict: "PASS" });
    expect(fake.queue, "the PASS re-report is its own message, not deduped onto the FAIL").toHaveLength(2);
    expect(JSON.parse(fake.queue[0].Body).residual.verdict).toBe("FAIL");
    expect(JSON.parse(fake.queue[1].Body).residual).toBeNull();
    fake.failTool = null;
    fake.tickets.get(AMEND).status = "To Do";
    const callsBefore = fake.calls.length;
    const stale = await drainQueued();
    expect(stale, stale.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(stale.permanent, "not a surfaced drop: no TicketReplayDropped alarm").toBeUndefined();
    expect(record(R_KEY).securityReview, "a stale residual replay never re-marks a newer PASS admission").toEqual({ verdict: "PASS" });
    expect(record(R_KEY).ticketWrites, "no drop stamp").toBe("queued");
    expect(record(R_KEY).replayDropped).toBeUndefined();
    expect(fake.calls.slice(callsBefore).filter((c) => c.tool === "Tickets___add_comment" && /PROVISIONAL again|replay-dropped/.test(String(c.params.comment))), "no notice").toHaveLength(0);
    twinsAdmitAdmission(R_KEY);
    const pass = await output.drainCompletion(JSON.parse(fake.queue[1].Body));
    expect(pass, pass.reason).toMatchObject({ outcome: "applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", securityReview: { verdict: "PASS" } });
    twinsAdmitAdmission(R_KEY);
  });

  it("T14 the record-write tripwire fires only on a real same-amendment finalize: a PASS report over a provisional PASS, or over a provisional FAIL, is a different admission and writes", async () => {
    seedReview();
    setRecord(R_KEY, { ticket_id: REVIEW, status: "complete", securityReview: { verdict: "PASS", provisional: true } });
    expect(await reportReview(PASS)).toMatchObject({ status: "complete" });
    expect(record(R_KEY).securityReview).toEqual({ verdict: "PASS" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    fake.tickets.get(REVIEW).status = "In Progress";
    setRecord(R_KEY, { ticket_id: REVIEW, status: "complete", securityReview: { verdict: "FAIL", amendmentTicketId: AMEND, provisional: true, provisionalNonce: "n-1" } });
    expect(await reportReview(PASS)).toMatchObject({ status: "complete" });
    expect(record(R_KEY).securityReview).toEqual({ verdict: "PASS" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
  });
});

describe("TEAM-6152 sibling — a stale residual replay acts only on the admission the record holds", () => {
  const AMEND_B2 = "TEAM-5699";
  /** The message names round 1's amendment (AMEND_B); the record's admission is round 2's (AMEND_B2), deduped onto the same message. */
  const roundTwo = async () => {
    await withResidual();
    seedTicket({ ticketId: AMEND_B2, title: "Amend design: db9sx9 (round 2)", status: "Done", assignee: "agentcore_hub_backend_designer", parentKey: EPIC });
    // TEAM-6217 (R3-03): a pre-`residual` record under a FAIL stamp must be able to state its findings
    // (legacyResidualOf: its summary's verdict line is the stamp's) or step 5 holds the Done as a surfaced
    // drop before the admission logic these tests exercise. The operator fixture's summary names no verdict.
    patchRecord(B_KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: AMEND_B2 }, summary: "Verdict: FAIL (changes needed). R1: rotate the probe role key.\n\nNo tool failures." });
  };

  it("T15 the record's (newer) amendment reopened while the message's is Done ⇒ the replay confirms the RECORD's amendment, drops, and marks that stamp provisional; no Done", async () => {
    await roundTwo();
    fake.tickets.get(AMEND_B2).status = "To Do";
    const out = await output.drainCompletion(residualOnly());
    expect(out, out.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(transitionsOf(BUILD)).toHaveLength(0);
    expect(fake.calls.some((c) => c.tool === "Tickets___get_issue" && c.params?.ticket_id === AMEND_B2), "the record's amendment was re-read").toBe(true);
    expect(record(B_KEY).securityReview).toMatchObject({ verdict: "FAIL", amendmentTicketId: AMEND_B2, provisional: true, provisionalNonce: expect.any(String) });
    twinsRefuseAdmission(B_KEY, /on amendment TEAM-5699/);
  });

  it("T16 the message's amendment reopened but the record's (newer) admission is Done ⇒ that stamp is re-marked, re-confirmed and finalized on ITS amendment; Done", async () => {
    await roundTwo();
    fake.tickets.get(AMEND_B).status = "To Do";
    const out = await output.drainCompletion(residualOnly());
    expect(out.outcome, out.reason).toBe("applied");
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record(B_KEY).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND_B2 });
    twinsAdmitAdmission(B_KEY);
  });
});

describe("TEAM-6152 — the provisionalNonce lifecycle and the readers that must ignore it", () => {
  it("T17 writers mint a FRESH nonce per (re-)establishment; the finalize helpers remove it with the marker; the caller's disposition is not mutated", () => {
    const { holdSecurityReviewProvisional, finalizeSecurityReview, holdBriefOnProvisionalRelease, clearBriefHoldOnRelease } = output;
    const rec = { securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1" } };
    holdSecurityReviewProvisional(rec);
    const first = rec.securityReview.provisionalNonce;
    expect(rec.securityReview.provisional).toBe(true);
    expect(first).toMatch(NONCE_RE);
    holdSecurityReviewProvisional(rec);
    expect(rec.securityReview.provisionalNonce, "a re-establishment is a NEW write").not.toBe(first);
    expect(rec.securityReview.provisionalNonce).toMatch(NONCE_RE);
    finalizeSecurityReview(rec);
    expect(rec.securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: "TEAM-1" });
    expect(holdSecurityReviewProvisional({ status: "complete" })).toEqual({ status: "complete" });
    expect(holdSecurityReviewProvisional({ securityReview: "PASS" }).securityReview).toBe("PASS");

    const disposition = { release: true, kind: "gate_settled", observed: [{ ticketId: "G" }], at: "2026-10-14T12:00:00.000Z", by: "drain" };
    const b1 = holdBriefOnProvisionalRelease({ briefPending: true }, disposition);
    const b2 = holdBriefOnProvisionalRelease({ briefPending: true }, disposition);
    expect(b1.briefDisposition).toMatchObject({ ...disposition, provisional: true });
    expect(b1.briefDisposition.provisionalNonce).toMatch(NONCE_RE);
    expect(b2.briefDisposition.provisionalNonce).not.toBe(b1.briefDisposition.provisionalNonce);
    expect(disposition.provisional, "the caller's disposition is not mutated").toBeUndefined();
    expect(disposition.provisionalNonce).toBeUndefined();
    clearBriefHoldOnRelease(b1, disposition);
    expect(b1.briefDisposition).toEqual(disposition);
    expect(b1.briefPending).toBe(false);
  });

  it("T18 both twins' Done guards ignore the nonce: a finalized stamp beside a stray nonce is admitted, a marked one is refused; the brief hold reads as before", () => {
    for (const twin of TWIN_GUARDS) {
      expect(twin.securityReviewRecordRefusal("k", { securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisionalNonce: "n-1" } })).toBeNull();
      expect(twin.securityReviewRecordRefusal("k", { securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true, provisionalNonce: "n-1" } })).toMatch(/PROVISIONAL securityReview admission on amendment TEAM-1/);
      expect(twin.securityReviewRecordRefusal("k", { securityReview: { verdict: "PASS", provisionalNonce: "n-1" } })).toBeNull();
      expect(twin.judgeBriefHold("k", JSON.stringify({ briefPending: true, briefDisposition: { release: true, kind: "gate_settled", provisional: true, provisionalNonce: "n-1" } }))).toMatchObject({ proven: false });
      expect(twin.judgeBriefHold("k", JSON.stringify({ briefPending: false, briefDisposition: { release: true, kind: "gate_settled", provisionalNonce: "n-1" } }))).toBeNull();
    }
  });
});

// ─── TEAM-6158 (review round 6 on #967) ───
/**
 * F1: the record write's tripwire compared AMENDMENT IDS, so a trusted stamp on X was rebased over
 * a newer provisional stamp on Y (and a trusted PASS over any provisional FAIL) by the failed-Done
 * rewrite - the drain then confirmed X and Doned the ticket while round Y was open. The rule is now
 * ownership in TIME: once this call has landed its own stamp, a provisional re-markable admission
 * (reMarkableAdmission, the drain's one predicate) on the record is newer and wins.
 * F2: the drop notice claimed "PROVISIONAL again" when nothing was re-marked; and the dedup id
 * omitted the residual, so a PASS re-report was collapsed onto the FAIL message (T13).
 */
describe("TEAM-6158 F1 — a trusted stamp never lands over a provisional admission established after this call's own", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };
  const AMEND2 = "TEAM-5400";
  const Y_STAMP = { verdict: "FAIL", amendmentTicketId: AMEND2, provisional: true, provisionalNonce: "n-y" };

  it("T19 cross-amendment: a newer provisional FAIL on amendment Y lands before the failed-Done rewrite ⇒ the rewrite is refused, Y's stamp stands, both twins refuse", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: "Jira API 400: stuck" };
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== R_KEY) return null;
      // PUT 1 = the provisional first write (X), PUT 2 = the finalize, PUT 3 = the failed-Done
      // rewrite. Writer B (round Y's report, or a drain) lands a provisional stamp on Y just
      // before PUT 3, which therefore 412s; the re-read must REFUSE, not re-apply trusted X.
      if (++n === 3) patchRecord(R_KEY, { securityReview: Y_STAMP });
      return null;
    };
    const res = await reportReview();
    expect(res).toMatchObject({ status: "complete_transition_failed", next_action: "retry_report_completion" });
    expect(n, "no fourth write: the 412'd rewrite was refused on re-read, not re-applied").toBe(3);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY).securityReview, "Y's newer provisional admission was NOT overwritten by trusted X").toEqual(Y_STAMP);
    twinsRefuseAdmission(R_KEY, /on amendment TEAM-5400/);
  });

  it("T20 the PASS variant: a PASS report's first write landed, Done failed, and a newer provisional FAIL lands before the rewrite ⇒ refused; the PASS is not rebased over it", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: "Jira API 400: stuck" };
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== R_KEY) return null;
      // PUT 1 = the PASS first write (a PASS is never provisional, so no finalize), PUT 2 = the rewrite.
      if (++n === 2) patchRecord(R_KEY, { securityReview: Y_STAMP });
      return null;
    };
    const res = await reportReview(PASS);
    expect(res).toMatchObject({ status: "complete_transition_failed", next_action: "retry_report_completion" });
    expect(n, "no third write").toBe(2);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY).securityReview, "the newer provisional FAIL was NOT overwritten by the PASS").toEqual(Y_STAMP);
    twinsRefuseAdmission(R_KEY, /on amendment TEAM-5400/);
  });
});

describe("TEAM-6158 F2 — the drop notice says only what was written; the dedup id carries the residual's identity", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };

  it("T21 a stale FAIL replay over a trusted PASS posts no 'PROVISIONAL again' notice and stamps no drop", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    expect(await reportReview()).toMatchObject({ ticketWrites: "queued" });
    expect(await reportReview(PASS)).toMatchObject({ ticketWrites: "queued" });
    fake.failTool = null;
    fake.tickets.get(AMEND).status = "To Do";
    const callsBefore = fake.calls.length;
    expect(JSON.parse(fake.queue[0].Body).residual.verdict).toBe("FAIL");
    const out = await output.drainCompletion(JSON.parse(fake.queue[0].Body));
    expect(out.outcome, out.reason).toBe("dropped");
    const notices = fake.calls.slice(callsBefore).filter((c) => c.tool === "Tickets___add_comment" && /PROVISIONAL again|replay-dropped/.test(String(c.params.comment)));
    expect(notices, "no notice claims a marker that was not written").toHaveLength(0);
    expect(record(R_KEY).securityReview).toEqual({ verdict: "PASS" });
    expect(record(R_KEY).ticketWrites).not.toBe("dropped");
    expect(record(R_KEY).replayDropped).toBeUndefined();
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
  });

  it("T22 the dedup id: identical retries collapse into one message; a PASS re-report (no residual) and a FAIL on another amendment are their own", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    expect(await reportReview()).toMatchObject({ ticketWrites: "queued" });
    expect(await reportReview()).toMatchObject({ ticketWrites: "queued" });
    expect(fake.queue, "an identical re-report is one message").toHaveLength(1);
    expect(new Set(fake.sends.map((s) => s.MessageDeduplicationId)).size).toBe(1);
    expect(await reportReview(PASS)).toMatchObject({ ticketWrites: "queued" });
    expect(fake.queue, "a PASS re-report is a different admission: its own message").toHaveLength(2);
    expect(new Set(fake.sends.map((s) => s.MessageDeduplicationId)).size).toBe(2);
    // The pure rule, for the three residual shapes a message can carry.
    const { ticketWritesDedupId } = output;
    const failX = ticketWritesDedupId({ ticketId: REVIEW, residual: { verdict: "FAIL", amendmentTicketId: AMEND } });
    expect(ticketWritesDedupId({ ticketId: REVIEW, residual: { verdict: "fail", amendmentTicketId: AMEND } })).toBe(failX);
    expect(ticketWritesDedupId({ ticketId: REVIEW, residual: { verdict: "FAIL", amendmentTicketId: "TEAM-5400" } })).not.toBe(failX);
    expect(ticketWritesDedupId({ ticketId: REVIEW, residual: null })).not.toBe(failX);
    expect(ticketWritesDedupId({ ticketId: REVIEW, residual: { verdict: "CHANGES_NEEDED", amendmentTicketId: AMEND } })).not.toBe(failX);
  });

  it("T23 no record to re-mark: the drop notice says nothing was written, never 'PROVISIONAL again'; the ticket is left open", async () => {
    await withResidual();
    fake.objects.delete(B_KEY);
    fake.etags.delete(B_KEY);
    fake.tickets.get(AMEND_B).status = "To Do";
    const out = await output.drainCompletion(residualOnly());
    expect(out, out.reason).toMatchObject({ outcome: "dropped", permanent: true });
    const notices = fake.calls.filter((c) => c.tool === "Tickets___add_comment" && String(c.params.comment).startsWith(`[replay-dropped:${BUILD}:amendment]`));
    expect(notices.length, "the drop IS surfaced: nobody else will close this ticket").toBeGreaterThan(0);
    for (const c of notices) {
      expect(String(c.params.comment)).not.toMatch(/PROVISIONAL again/);
      expect(String(c.params.comment)).toMatch(/does not exist \(nothing written\)/);
    }
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(fake.objects.has(B_KEY), "no record was conjured by the drop").toBe(false);
  });
});

// ─── TEAM-6164 F1 (ship review on #969) ───
/**
 * The drain keyed every amendment-side transition off `msg.residual` (the re-mark in step 6,
 * the confirm/finalize/drop in step 7). A residual-less PASS message - the report whose Done
 * 503'd FIRST - drained over a record whose NEWER admission is a trusted FAIL stamp went
 * straight to the Done: no re-mark, zero amendment reads, both twins admitting the trusted
 * stamp, while the amendment was reopened or unreadable. The admission the drain acts on is
 * now the RECORD's non-PASS stamp (drainAdmission), the message's residual only a fallback.
 * Both FIFO orders, each with a reopened and an unreadable amendment, under the REAL twin
 * Done guard; the FAIL-then-PASS pair re-pins T13/TEAM-6158 (the stale FAIL is superseded).
 */
describe("TEAM-6164 F1 — the older message in the FIFO group never Dones over the record's newer non-PASS admission", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };
  const callsSince = (from, tool, pred = () => true) => fake.calls.slice(from).filter((c) => c.tool === tool && pred(c.params || {}));
  /** Two Done-503'd reports in `order`; the record ends holding the SECOND report's admission; the REAL twin guard then judges every Done. */
  const queueTwo = async (order) => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    for (const which of order) expect(which === "PASS" ? await reportReview(PASS) : await reportReview()).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.queue, "one message per report (the dedup id carries the residual)").toHaveLength(2);
    expect(record(R_KEY).securityReview).toEqual(order[1] === "PASS" ? { verdict: "PASS" } : { verdict: "FAIL", amendmentTicketId: AMEND });
    expect(JSON.parse(fake.queue[0].Body).residual?.verdict ?? null).toBe(order[0] === "PASS" ? null : "FAIL");
    expect(JSON.parse(fake.queue[1].Body).residual?.verdict ?? null).toBe(order[1] === "PASS" ? null : "FAIL");
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
  };
  const amendmentUnreadable = () => { fake.failTool = { ...fake.failTool, Tickets___get_issue: (p) => (p.ticket_id === AMEND ? PROVIDER_503 : null) }; };
  const amendmentReadable = () => { fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) }; };
  const drainMsg = (i) => output.drainCompletion(JSON.parse(fake.queue[i].Body));

  it("T24 PASS queued, then FAIL queued (record: FAIL on AMEND); AMEND reopened; the older PASS message drains ⇒ the record's amendment is re-read, a surfaced drop, the stamp PROVISIONAL again, no Done; the FAIL message behind it drops the same way", async () => {
    await queueTwo(["PASS", "FAIL"]);
    fake.tickets.get(AMEND).status = "To Do";
    const from = fake.calls.length;
    const out = await drainMsg(0);
    expect(out, out.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(out.reason).toMatch(/^amendment: design amendment TEAM-5399 reads To Do - the security review's admission is PROVISIONAL again/);
    expect(callsSince(from, "Tickets___get_issue", (p) => p.ticket_id === AMEND).length, "the RECORD's amendment was re-read").toBeGreaterThan(0);
    expect(transitionsOf(REVIEW, from)).toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "amendment" } });
    expect(record(R_KEY).securityReview, "the record's FAIL stamp is re-marked, never overwritten with the message's PASS").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true, provisionalNonce: expect.any(String) });
    twinsRefuseAdmission(R_KEY, /on amendment TEAM-5399/);
    const second = await drainMsg(1);
    expect(second, second.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    twinsRefuseAdmission(R_KEY);
  });

  it("T25 PASS queued, then FAIL queued; AMEND unreadable (503); the older PASS message drains ⇒ retry, no Done, the stamp re-marked and refused; readable + Done ⇒ the same message finalizes the FAIL stamp and Dones", async () => {
    await queueTwo(["PASS", "FAIL"]);
    amendmentUnreadable();
    const from = fake.calls.length;
    const held = await drainMsg(0);
    expect(held, held.reason).toMatchObject({ outcome: "retry" });
    expect(held.reason).toMatch(/get_issue TEAM-5399 \(re-confirming the design amendment is done before the Done\)/);
    expect(transitionsOf(REVIEW, from)).toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY).securityReview).toMatchObject({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true });
    twinsRefuseAdmission(R_KEY);
    amendmentReadable();
    const out = await drainMsg(0);
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    expect(record(R_KEY).securityReview.provisional).toBeUndefined();
    twinsAdmitAdmission(R_KEY);
  });

  it("T26 PASS queued, then FAIL queued; AMEND Done ⇒ the older PASS message re-marks the record's FAIL stamp, confirms ITS amendment, finalizes, Dones - three writes, the stamp stays FAIL", async () => {
    await queueTwo(["PASS", "FAIL"]);
    const from = fake.calls.length;
    const putsBefore = keyPuts(R_KEY).length;
    let seenAtDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) seenAtDone = record(R_KEY); };
    const out = await drainMsg(0);
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(callsSince(from, "Tickets___get_issue", (p) => p.ticket_id === AMEND).length).toBeGreaterThan(0);
    const bodies = keyPuts(R_KEY).slice(putsBefore).map(bodyOf);
    expect(bodies).toHaveLength(3); // re-mark (provisional), finalize, applied
    expect(bodies[0].securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true, provisionalNonce: expect.any(String) });
    expect(bodies[1].securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND });
    expect(bodies[2]).toMatchObject({ ticketWrites: "applied", securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    expect(seenAtDone.securityReview, "never a Done on a provisional record").toEqual({ verdict: "FAIL", amendmentTicketId: AMEND });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    twinsAdmitAdmission(R_KEY);
  });

  it("T27 FAIL queued, then PASS queued (record: PASS); AMEND reopened; the older FAIL drains under the real guard ⇒ superseded (no notice, no stamp); the PASS message Dones (T13 kept)", async () => {
    await queueTwo(["FAIL", "PASS"]);
    fake.tickets.get(AMEND).status = "To Do";
    const from = fake.calls.length;
    const stale = await drainMsg(0);
    expect(stale, stale.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(stale.permanent).toBeUndefined();
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "queued", securityReview: { verdict: "PASS" } });
    expect(record(R_KEY).replayDropped).toBeUndefined();
    expect(callsSince(from, "Tickets___add_comment", (p) => /PROVISIONAL again|replay-dropped/.test(String(p.comment)))).toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    const pass = await drainMsg(1);
    expect(pass, pass.reason).toMatchObject({ outcome: "applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", securityReview: { verdict: "PASS" } });
    twinsAdmitAdmission(R_KEY);
  });

  it("T28 (TEAM-6205 R2-03c) FAIL queued, then PASS queued; AMEND unreadable ⇒ the older FAIL is SUPERSEDED at once by the record's trusted PASS (no amendment read, no retry, nothing posted); the PASS message Dones", async () => {
    await queueTwo(["FAIL", "PASS"]);
    amendmentUnreadable();
    const from = fake.calls.length;
    const stale = await drainMsg(0);
    expect(stale, stale.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(stale.permanent).toBeUndefined();
    expect(callsSince(from, "Tickets___get_issue", (p) => p.ticket_id === AMEND), "a superseded message reads no amendment").toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY).securityReview, "a trusted PASS is never re-marked").toEqual({ verdict: "PASS" });
    expect(record(R_KEY).replayDropped).toBeUndefined();
    amendmentReadable();
    expect((await drainMsg(1)).outcome).toBe("applied");
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    twinsAdmitAdmission(R_KEY);
  });

  // ─── TEAM-6205 R2-03 (ship review round 2 on #970): residual delivery follows the CURRENT admission ───
  // Admission re-mark/confirm/finalize used drainAdmission (the record's stamp first), but step 5 still
  // posted msg.residual and the sibling scan was gated on it: the older PASS message (residual null) over
  // the record's newer FAIL Doned the review with NO residual findings on the dev lanes, and the FAIL
  // message behind it died on step 0's "already applied". The reverse posted a stale FAIL's findings over
  // a trusted PASS and retried on an unreadable amendment it no longer owned (T28, above). The record
  // now carries `residual` beside its stamp (same PUT), and currentResidual() delivers the record's
  // findings / supersedes a contradicted message before step 6.
  const residualComments = (id) => fake.tickets.get(id).comments.filter((c) => c.includes(output.residualMarker(REVIEW)));
  /** queueTwo, but the FAIL report's own residual posts 503'd (so the queued message is what owes them). */
  const queueTwoFindingsUnposted = async (order) => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503, Tickets___add_comment: (p) => ([DEV1, DEV2].includes(p.ticket_id) ? PROVIDER_503 : null) };
    for (const which of order) expect(which === "PASS" ? await reportReview(PASS) : await reportReview()).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.queue).toHaveLength(2);
    expect(residualComments(DEV1)).toHaveLength(0);
    expect(residualComments(DEV2)).toHaveLength(0);
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
  };

  it("TEAM-6205 R2-03a PASS queued, then FAIL queued (record: FAIL); the older PASS message Dones on the record's FAIL ⇒ the FAIL's residual findings are on DEV1 and DEV2 BEFORE the Done; the FAIL message behind is 'already applied' and posts nothing new", async () => {
    await queueTwoFindingsUnposted(["PASS", "FAIL"]);
    let atDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) atDone = [residualComments(DEV1).length, residualComments(DEV2).length]; };
    const out = await drainMsg(0);
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(atDone, "the findings were on both dev lanes when the Done was made").toEqual([1, 1]);
    expect(residualComments(DEV1)[0]).toContain("verdict FAIL");
    expect(residualComments(DEV1)[0]).toContain(reviewCompletion.summary.split("\n")[0]);
    expect(record(R_KEY).securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND });
    const second = await drainMsg(1);
    expect(second).toMatchObject({ outcome: "dropped", reason: "already applied" });
    expect(residualComments(DEV1)).toHaveLength(1);
    expect(residualComments(DEV2)).toHaveLength(1);
    twinsAdmitAdmission(R_KEY);
  });

  it("TEAM-6205 R2-03b FAIL queued, then PASS queued (record: trusted PASS); the stale FAIL message posts NO residual findings on the dev lanes and is superseded", async () => {
    await queueTwoFindingsUnposted(["FAIL", "PASS"]);
    fake.tickets.get(AMEND).status = "To Do";
    const stale = await drainMsg(0);
    expect(stale, stale.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(residualComments(DEV1), "a superseded admission's findings are not posted").toHaveLength(0);
    expect(residualComments(DEV2)).toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect((await drainMsg(1)).outcome).toBe("applied");
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(residualComments(DEV1)).toHaveLength(0);
  });

  it("TEAM-6205 R2-03d the record carries `residual` beside the stamp in the same PUT, identical to the queued message's; a PASS re-report replaces it", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    const putsBefore = keyPuts(R_KEY).length;
    expect(await reportReview()).toMatchObject({ ticketWrites: "queued" });
    const queued = JSON.parse(fake.queue[0].Body).residual;
    expect(queued).toMatchObject({ verdict: "FAIL", amendmentTicketId: AMEND, summary: expect.any(String) });
    expect(record(R_KEY).residual).toEqual(queued);
    const bodies = keyPuts(R_KEY).slice(putsBefore).map(bodyOf);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.residual, "every PUT of the report carries the residual beside its stamp").toEqual(queued);
      expect(`${body.residual.verdict}|${body.residual.amendmentTicketId}`).toBe(`${body.securityReview.verdict}|${body.securityReview.amendmentTicketId}`);
    }
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    expect(await reportReview(PASS)).toMatchObject({ status: "complete" });
    expect(record(R_KEY).residual).toBeUndefined();
    expect(record(R_KEY).securityReview).toEqual({ verdict: "PASS" });
    twinsAdmitAdmission(R_KEY);
  });

  it("TEAM-6205 R2-03e / TEAM-6217 R3-03: a record written before `residual` existed under its FAIL admission ⇒ the older PASS message delivers the findings REBUILT from the record's own summary to both dev lanes before the Done; nothing is recorded undelivered", async () => {
    await queueTwoFindingsUnposted(["PASS", "FAIL"]);
    const cur = record(R_KEY);
    delete cur.residual;
    setRecord(R_KEY, cur);
    let atDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) atDone = [residualComments(DEV1).length, residualComments(DEV2).length]; };
    const out = await drainMsg(0);
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(atDone, "the rebuilt findings were on both dev lanes when the Done was made").toEqual([1, 1]);
    expect(residualComments(DEV1)[0]).toContain("verdict FAIL");
    expect(residualComments(DEV1)[0]).toContain(reviewCompletion.summary.split("\n")[0]);
    expect((record(R_KEY).undelivered || []).filter((u) => u.part === "residual_findings"), "nothing recorded undelivered").toEqual([]);
    expect(record(R_KEY).residual, "the drain never writes `residual`").toBeUndefined();
    twinsAdmitAdmission(R_KEY);
  });

  // ─── TEAM-6217 R3-03 (ship review round 3 on #970) - red on f4ef506: R2-03e asserted the wrong behaviour ───
  // For a current FAIL admission on a pre-`residual` record, currentResidual returns missingText;
  // the drain records the dev lanes undelivered and Dones, then the FAIL message behind it is dropped
  // "already applied" - the findings never reach DEV1/DEV2 although the record still holds the
  // original summary and artifacts (report.summary / report.artifacts) they can be rebuilt from
  // (legacyResidualOf, valid when the summary's verdict line is the stamp's). When they cannot be,
  // an open ticket is a surfaced drop at step 5 - never a Done with zero findings (R3-03b).
  it("TEAM-6217 R3-03 a pre-`residual` record under its FAIL admission: by the time the review is Done, the FAIL findings are on both dev lanes (rebuilt from the record, or delivered by the FAIL message) - never Done with zero findings", async () => {
    await queueTwoFindingsUnposted(["PASS", "FAIL"]);
    const cur = record(R_KEY);
    delete cur.residual;
    setRecord(R_KEY, cur);
    expect(record(R_KEY)).toMatchObject({ summary: reviewCompletion.summary, securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    let atDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) atDone = [residualComments(DEV1).length, residualComments(DEV2).length]; };
    const first = await drainMsg(0);
    const second = await drainMsg(1);
    expect(first, first.reason).toMatchObject({ outcome: "applied" });
    expect(second).toMatchObject({ outcome: "dropped", reason: "already applied" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(atDone, "the findings were on both dev lanes when the Done was made").toEqual([1, 1]);
    expect(residualComments(DEV1)).toHaveLength(1);
    expect(residualComments(DEV2)).toHaveLength(1);
    expect(residualComments(DEV1)[0]).toContain("verdict FAIL");
    twinsAdmitAdmission(R_KEY);
  });

  it("TEAM-6217 R3-03b a pre-`residual` record whose summary does NOT state its FAIL verdict (a same-session resubmit kept the PASS text) ⇒ the older PASS message is a surfaced drop at step 5 (no Done, nothing posted); the FAIL's own message delivers and Dones", async () => {
    await queueTwoFindingsUnposted(["PASS", "FAIL"]);
    const cur = record(R_KEY);
    delete cur.residual;
    cur.summary = PASS.summary;
    setRecord(R_KEY, cur);
    const from = fake.calls.length;
    const first = await drainMsg(0);
    expect(first, first.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(first.reason).toMatch(/^residual_findings: .*carries no residual text for its FAIL admission on TEAM-5399/);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(transitionsOf(REVIEW, from)).toHaveLength(0);
    expect(residualComments(DEV1)).toHaveLength(0);
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "residual_findings" } });
    expect(fake.tickets.get(REVIEW).comments.some((c) => c.startsWith(`[replay-dropped:${REVIEW}:residual_findings]`)), "the drop is said on the ticket").toBe(true);
    let atDone = null;
    fake.onTransition = (t) => { if (t.ticketId === REVIEW) atDone = [residualComments(DEV1).length, residualComments(DEV2).length]; };
    const second = await drainMsg(1);
    expect(second, second.reason).toMatchObject({ outcome: "applied" });
    expect(atDone, "the FAIL message's own findings were on both dev lanes when the Done was made").toEqual([1, 1]);
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    twinsAdmitAdmission(R_KEY);
  });
});

// ─── TEAM-6164 F1 sibling: step 6 cleared followUpsPending off the MESSAGE's entries ───
/**
 * An older queued message with no follow-ups (a report whose Done 503'd) drained after a newer
 * report_completion stamped followUpsPending:true (its follow-up refused with a retryable, non-outage
 * 429, so it was NOT queued and the agent was told to retry) wrote followUpsPending:false and Doned
 * the ticket with the follow-up unfiled. The record's unfiled set (followUpsMaterialized.failed) is
 * now what every drain write honours: a message that does not carry it is superseded (TEAM-6158
 * shape), and on a ticket already Done the hold stays true.
 */
describe("TEAM-6164 sibling — a stale message never clears a followUpsPending hold a newer report stamped", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };
  const followUpTickets = () => [...fake.tickets.values()].filter((t) => t.parentKey === EPIC_R && /\[fu:[0-9a-f]{8}\]\s*$/.test(t.title));
  const twinsRefuseRecord = (key) => { for (const twin of TWIN_GUARDS) expect(twin.judgeCompletionRecord(key, fake.objects.get(key), { securityReview: true })).toMatchObject({ proven: false }); };
  /** PASS queued with no follow-ups; then a re-report whose follow-up 429s (retryable, not queued) stamps the hold. */
  const staleThenHeld = async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    expect(await reportReview(PASS)).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.queue).toHaveLength(1);
    expect(JSON.parse(fake.queue[0].Body).followUps).toEqual([]);
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503, Tickets___create_ticket: "Jira API 429: rate limited" };
    const held = await reportReview({ ...PASS, follow_ups: call0.arguments.follow_ups });
    expect(held).toMatchObject({ status: "complete_pending_follow_ups" });
    expect(fake.queue, "a retryable non-outage refusal is the agent's retry, not a queued message").toHaveLength(1);
    expect(record(R_KEY)).toMatchObject({ status: "complete_pending_follow_ups", followUpsPending: true, followUpsMaterialized: { failed: [expect.objectContaining({ hash: expect.any(String), retryable: true })] } });
    expect(followUpTickets()).toHaveLength(0);
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
  };

  it("S1 the older message drains over the newer hold ⇒ superseded (no notice, no stamp), no Done, followUpsPending stays true, twins refuse; the agent's retry files the follow-up and Dones", async () => {
    await staleThenHeld();
    const from = fake.calls.length;
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(out.permanent).toBeUndefined();
    expect(out.reason).toMatch(/followUpsPending:true for 1 follow-up\(s\) this message does not carry/);
    expect(transitionsOf(REVIEW, from)).toHaveLength(0);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY)).toMatchObject({ followUpsPending: true, status: "complete_pending_follow_ups" });
    expect(record(R_KEY).ticketWrites).not.toBe("applied");
    expect(record(R_KEY).replayDropped).toBeUndefined();
    expect(fake.calls.slice(from).filter((c) => c.tool === "Tickets___add_comment" && /replay-dropped/.test(String(c.params.comment)))).toHaveLength(0);
    expect(followUpTickets(), "the drain filed nothing it could not name").toHaveLength(0);
    twinsRefuseRecord(R_KEY);
    // The hold's own report_completion retry files the follow-up and closes the ticket.
    expect(await reportReview({ ...PASS, follow_ups: call0.arguments.follow_ups })).toMatchObject({ status: "complete" });
    expect(followUpTickets()).toHaveLength(1);
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ followUpsPending: false, status: "complete" });
  });

  it("S2 the ticket is already Done when the older message drains ⇒ applied, but the newer hold stays followUpsPending:true for the human who files it", async () => {
    await staleThenHeld();
    fake.tickets.get(REVIEW).status = "Done";
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", followUpsPending: true, status: "complete_pending_follow_ups" });
    expect(followUpTickets()).toHaveLength(0);
  });
});

// ─── TEAM-6205 R2-01 / R2-05 (ship review round 2 on #970) ───
/**
 * R2-01: drop() and step 6 kept `followUpsPending:true` off the record's unresolved set
 * (unresolvedRecordFollowUps) but then REPLACED `followUpsMaterialized` with the message's own rows,
 * so the record forgot the follow-up B a newer report held; on redelivery A filed, nothing named B,
 * the hold cleared and the ticket Doned with B unfiled. Every drain write now persists the merged
 * breakdown (mergeRecordFollowUps): this message's rows plus the record's unresolved rows, verbatim.
 * R2-05: a hollow breakdown (`followUpsPending:true`, `failed:[]`, or rows without a hash) read as
 * resolved; it is a hold nobody can name and fails closed.
 */
describe("TEAM-6205 R2-01 / R2-05 — a drain write carries the record's unresolved follow-ups; a hollow breakdown is a hold", () => {
  const PASS = { summary: "Verdict: PASS. Design reviewed against main and the feature branch, read-only; no blocking findings.\n\nNo tool failures." };
  const FU_A = JSON.parse(call0.arguments.follow_ups)[0];
  const FU_B = { kind: "iam_handoff", owner: "human", title: "Grant the probe role sqs:DeleteMessage in the prod account", detail: "The deploy role cannot attach this policy either; a human must apply it in the console." };
  const hashOf = (e) => output.followUpHash(REVIEW, e.kind, e.title);
  const failedHashes = () => (record(R_KEY).followUpsMaterialized?.failed || []).map((f) => f.hash);
  const followUpTickets = () => [...fake.tickets.values()].filter((t) => t.parentKey === EPIC_R && /\[fu:[0-9a-f]{8}\]\s*$/.test(t.title));
  const twinsRefuseRecord = (key) => { for (const twin of TWIN_GUARDS) expect(twin.judgeCompletionRecord(key, fake.objects.get(key), { securityReview: true })).toMatchObject({ proven: false }); };
  /** Older report: A's create and the Done 503'd (queued, the message carries A). Newer report: A+B both 429 (retryable, the agent's retry - not queued) ⇒ record failed=[A,B], followUpsPending:true. */
  const olderQueuedNewerHeld = async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503, Tickets___create_ticket: PROVIDER_503 };
    expect(await reportReview({ ...PASS, follow_ups: JSON.stringify([FU_A]) })).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.queue).toHaveLength(1);
    expect(JSON.parse(fake.queue[0].Body).followUps.map((e) => e.hash)).toEqual([hashOf(FU_A)]);
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503, Tickets___create_ticket: "Jira API 429: rate limited" };
    expect(await reportReview({ ...PASS, follow_ups: JSON.stringify([FU_A, FU_B]) })).toMatchObject({ status: "complete_pending_follow_ups" });
    expect(fake.queue, "a retryable non-outage refusal is the agent's retry, not a queued message").toHaveLength(1);
    expect(new Set(failedHashes())).toEqual(new Set([hashOf(FU_A), hashOf(FU_B)]));
    expect(followUpTickets()).toHaveLength(0);
  };

  it("R2-01a drop() on A's permanent refusal keeps B (the record's unresolved row) in the persisted breakdown; followUpsPending stays true", async () => {
    await olderQueuedNewerHeld();
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY), Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "dropped", followUpsPending: true, status: "complete_pending_follow_ups" });
    expect(new Set(failedHashes()), "B is still on the record").toEqual(new Set([hashOf(FU_A), hashOf(FU_B)]));
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    twinsRefuseRecord(R_KEY);
  });

  it("R2-01b redelivery files A ⇒ superseded on B (no Done, hold kept); the newer report's retry files B and Dones", async () => {
    await olderQueuedNewerHeld();
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY), Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    expect((await drainQueued()).outcome).toBe("dropped");
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(fake.tickets.get(REVIEW).status, "no Done over B").toBe("In Progress");
    expect(followUpTickets(), "A was filed").toHaveLength(1);
    expect(record(R_KEY).followUpsPending).toBe(true);
    expect(failedHashes()).toContain(hashOf(FU_B));
    twinsRefuseRecord(R_KEY);
    expect(await reportReview({ ...PASS, follow_ups: JSON.stringify([FU_A, FU_B]) })).toMatchObject({ status: "complete" });
    expect(followUpTickets()).toHaveLength(2);
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    expect(record(R_KEY)).toMatchObject({ followUpsPending: false, status: "complete" });
  });

  it("R2-01c the ticket is already Done when the older message (A) drains and A files ⇒ applied, but B's row and followUpsPending:true stay on the record", async () => {
    await olderQueuedNewerHeld();
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    fake.tickets.get(REVIEW).status = "Done";
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "applied" });
    expect(record(R_KEY)).toMatchObject({ ticketWrites: "applied", followUpsPending: true });
    expect(failedHashes(), "B's row survives the already-Done write").toEqual([hashOf(FU_B)]);
    expect(followUpTickets()).toHaveLength(1);
  });

  it("R2-05c a hollow breakdown (followUpsPending:true, failed:[]) is a hold nobody can name: a hold-less message is superseded, the hold stays, twins refuse", async () => {
    seedReview();
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    expect(await reportReview(PASS)).toMatchObject({ ticketWrites: "queued" });
    patchRecord(R_KEY, { followUpsPending: true, status: "complete_pending_follow_ups", followUpsMaterialized: { created: [], skipped: [], failed: [], rerouted: [] } });
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    const out = await drainQueued();
    expect(out, out.reason).toMatchObject({ outcome: "dropped", superseded: true });
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(record(R_KEY)).toMatchObject({ followUpsPending: true, followUpsMaterialized: { failed: [] } });
    twinsRefuseRecord(R_KEY);
  });

  // ─── TEAM-6217 R3-02 (ship review round 3 on #970) - red on f4ef506: a malformed breakdown row vanished from the persisted breakdown ───
  // unresolvedRecordFollowUps makes a sentinel for a row with no hash (R2-05), but mergeRecordFollowUps
  // keeps only record rows with a non-empty string hash, so the malformed obligation is dropped from
  // the breakdown drop()/step 6 persist. Once the only well-formed row (A) is filed on redelivery the
  // record says failed:[] / [A-created] and the hold clears. Now a hash-less failed row is persisted as a durable
  // unresolved marker ({ hash:null, unresolved:true, retryable:false, reason, raw }) - its lifecycle, one test per
  // row: WRITER (a), READER (b), DELETE (c: only a report_completion re-run rewrites the breakdown), ORDERING (d).
  /** failed=[null, A] on the record (a malformed row beside A); the queued message carries A; A's create is a permanent 400 ⇒ drop(). */
  const dropWithMalformedRow = async () => {
    await olderQueuedNewerHeld();
    const cur = record(R_KEY);
    const rowA = cur.followUpsMaterialized.failed.find((f) => f.hash === hashOf(FU_A));
    patchRecord(R_KEY, { followUpsMaterialized: { ...cur.followUpsMaterialized, failed: [null, rowA] } });
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY), Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const dropped = await drainQueued();
    expect(dropped, dropped.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record(R_KEY).followUpsPending).toBe(true);
  };
  const markers = () => (record(R_KEY).followUpsMaterialized?.failed || []).filter((f) => f?.unresolved === true);

  it("TEAM-6217 R3-02a (WRITER) failed=[null, A] ⇒ drop() persists the malformed obligation as a durable unresolved marker beside A, never failed=[A] alone", async () => {
    await dropWithMalformedRow();
    const failed = record(R_KEY).followUpsMaterialized.failed;
    expect(failed.length, "the malformed row survives the drop stamp as a marker").toBe(2);
    expect(failedHashes()).toContain(hashOf(FU_A));
    expect(markers()).toEqual([{ hash: null, unresolved: true, retryable: false, reason: expect.stringMatching(/^followUpsMaterialized\.failed\[0\] has no hash/), raw: "null" }]);
  });

  it("TEAM-6217 R3-02b (READER) after that drop, redelivery files A ⇒ the unknown obligation still holds: no applied, no Done, followUpsPending:true, twins refuse", async () => {
    await dropWithMalformedRow();
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    const out = await drainQueued();
    expect(followUpTickets(), "A was filed").toHaveLength(1);
    expect(record(R_KEY).followUpsPending, "the unknown obligation still holds the ticket").toBe(true);
    expect(fake.tickets.get(REVIEW).status).toBe("In Progress");
    expect(out).toMatchObject({ outcome: "dropped", superseded: true });
    expect(out.reason).toMatch(/has no hash - an obligation nobody can name/);
    expect(markers(), "the marker rides through the redelivery").toHaveLength(1);
    twinsRefuseRecord(R_KEY);
  });

  it("TEAM-6217 R3-02c (DELETE) only the record's author clears a marker: a report_completion re-run with the full follow_ups list rewrites the breakdown, files A and B, and Dones; nothing throws on the marker", async () => {
    await dropWithMalformedRow();
    expect(markers()).toHaveLength(1);
    fake.failTool = { Tickets___transition_ticket: realDoneGuard(R_KEY) };
    expect(await reportReview({ ...PASS, follow_ups: JSON.stringify([FU_A, FU_B]) })).toMatchObject({ status: "complete" });
    expect(followUpTickets()).toHaveLength(2);
    expect(markers(), "the re-run's own materialization replaced the breakdown").toEqual([]);
    expect(record(R_KEY)).toMatchObject({ followUpsPending: false, status: "complete" });
    expect(fake.tickets.get(REVIEW).status).toBe("Done");
    for (const twin of TWIN_GUARDS) expect(twin.judgeCompletionRecord(R_KEY, fake.objects.get(R_KEY), { securityReview: true })).toMatchObject({ proven: true });
  });

  it("TEAM-6217 R3-02d (ORDERING) a marker rides verbatim through every later drain write: a second drop over the same record leaves exactly one marker", async () => {
    await dropWithMalformedRow();
    const before = markers();
    const again = await drainQueued();
    expect(again, again.reason).toMatchObject({ outcome: "dropped", permanent: true });
    expect(markers(), "no growth, no re-wrapping").toEqual(before);
    expect(record(R_KEY).followUpsMaterialized.failed).toHaveLength(2);
    expect(record(R_KEY).followUpsPending).toBe(true);
  });
});
