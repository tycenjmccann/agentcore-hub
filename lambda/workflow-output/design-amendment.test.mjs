import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * TEAM-5426 — a non-PASS security review cannot close until its ONE design
 * amendment is done.
 *
 * Replayed from rfq233: TEAM-5357 reported "Verdict: FAIL (changes needed)",
 * report_completion wrote its record, moved it to Done, and the dev lanes it
 * blocked (TEAM-5358/5359) released onto the unamended design. Every case runs
 * against BOTH twins' row shapes (the fixtures carry each), because this Lambda
 * talks to whichever ticket backend is configured.
 *
 * Mocked: the AWS seams only. The ticket Lambda is a tiny fake board — `h.board`
 * answers get_issue / list_tickets, add_comment appends to `h.comments` (served
 * back on get_issue in each twin's own comment shape, which is what makes the
 * residual-comment dedupe a round trip). The rows themselves are the twins' real
 * serializer output — see the board fixture's `_provenance`.
 */

const fixture = (name) => JSON.parse(readFileSync(new URL(`./__fixtures__/design-amendment/${name}`, import.meta.url), "utf8"));
const COMPLETION = fixture("team-5357-completion.json");
const BOARD = fixture("team-5356-board.json");

const h = vi.hoisted(() => ({
  puts: [], calls: [], issue: null, siblings: [], comments: new Map(), listFails: false, listIncomplete: false,
  // TEAM-6124: what get_issue (the strong read) says, per ticket, when it differs
  // from the list_tickets row — `issueStatus` rewrites the status, `issueError`
  // answers `{ error }` in the jira twin's `Jira API <status>:` idiom.
  issueStatus: new Map(), issueError: new Map(),
  // TEAM-6130: flip the board at a seam — before an S3 PUT, or on the n-th get_issue of a ticket.
  beforePut: null, beforeGetIssue: null, getIssueCount: new Map(),
  // TEAM-6142: `h.calls.length` at each PutObject, so S3 writes order against ticket calls.
  putAtCall: [],
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd?.constructor?.name === "PutObjectCommand") { h.beforePut?.(cmd.input); h.puts.push(cmd.input); h.putAtCall.push(h.calls.length); return { ETag: '"e1"' }; }
      const err = new Error("NoSuchKey");
      err.name = cmd?.constructor?.name === "HeadObjectCommand" ? "NotFound" : "NoSuchKey";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  HeadObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
  DeleteObjectCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const call = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      const tool = call.tool_name;
      const params = call.parameters || {};
      h.calls.push({ tool, params });
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      const idOf = (r) => r.key || r.ticketId;
      const withComments = (row) => {
        const comments = (h.comments.get(idOf(row)) || []).map((body) => ({ author: "agent", body }));
        // tickets getIssue: fields.comment.comments[]; jira get_issue: top-level comments[].
        return row.fields ? { ...row, fields: { ...row.fields, comment: { total: comments.length, comments } } } : { ...row, comments };
      };
      if (tool === "Tickets___get_issue") {
        const nth = (h.getIssueCount.get(params.ticket_id) || 0) + 1;
        h.getIssueCount.set(params.ticket_id, nth);
        h.beforeGetIssue?.(params.ticket_id, nth);
        if (h.issueError.has(params.ticket_id)) return reply({ error: h.issueError.get(params.ticket_id) });
        let row = idOf(h.issue) === params.ticket_id ? h.issue : h.siblings.find((s) => idOf(s) === params.ticket_id);
        if (row && h.issueStatus.has(params.ticket_id)) {
          const st = h.issueStatus.get(params.ticket_id);
          row = row.fields ? { ...row, fields: { ...row.fields, status: { name: st } } } : { ...row, status: st };
        }
        return reply(row ? withComments(row) : { content: [{ type: "text", text: `Issue ${params.ticket_id} not found.` }] });
      }
      if (tool === "Tickets___list_tickets") {
        if (h.listFails) return reply({ content: [{ type: "text", text: "Error: list_tickets is unavailable" }] });
        return reply({ total: h.siblings.length, issues: h.siblings, tickets: h.siblings, ...(h.listIncomplete ? { complete: false } : {}) });
      }
      if (tool === "Tickets___add_comment") {
        h.comments.set(params.ticket_id, [...(h.comments.get(params.ticket_id) || []), params.comment]);
        return reply({ ticketId: params.ticket_id, message: "Comment added" });
      }
      return reply({ ok: true });
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
const { handler, parseReviewVerdict, countFindings, residualMarker } = await import("./index.mjs");
// TEAM-6130: both twins' Done guard, judged on the record a late refusal leaves behind.
const TWIN_GUARDS = [() => import("../agentcore-hub-jira/gate-contract.mjs"), () => import("../agentcore-hub-tickets/gate-contract.mjs")];

const report = (extra = {}) => handler({
  tool_name: "WorkflowOutput___report_completion",
  arguments: { ...COMPLETION, _comment: undefined, ...extra },
}).then((res) => JSON.parse(res.content[0].text));
const tools = () => h.calls.map((c) => c.tool);
const wroteRecord = () => h.puts.some((p) => p.Key?.startsWith("completions/"));
const record = () => JSON.parse(h.puts.find((p) => p.Key?.startsWith("completions/")).Body);
const transitioned = () => tools().includes("Tickets___transition_ticket");
const clone = (v) => JSON.parse(JSON.stringify(v));
/** A row with its status set, in its own twin's shape. */
const withStatus = (row, status) => (row.fields ? { ...row, fields: { ...row.fields, status: { name: status } } } : { ...row, status });

beforeEach(() => {
  h.puts.length = 0;
  h.calls.length = 0;
  h.comments = new Map();
  h.listFails = false;
  h.listIncomplete = false;
  h.issueStatus = new Map();
  h.issueError = new Map();
  h.beforePut = null;
  h.beforeGetIssue = null;
  h.getIssueCount = new Map();
  h.putAtCall.length = 0;
});

for (const twin of ["dynamodb", "jira"]) {
  const shape = BOARD[twin];
  const load = (amendmentStatus) => {
    h.issue = clone(shape.issue);
    h.siblings = clone(shape.siblings);
    if (amendmentStatus) h.siblings.push(withStatus(clone(shape.amendment), amendmentStatus));
  };

  describe(`TEAM-5426 [${twin} rows] — the review holds until its amendment is done`, () => {
    it("(a) the rfq233 completion is refused design_amendment_required: no record, no transition", async () => {
      load(null);
      const res = await report();
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", missing: ["design_amendment"], findings_count: 5 });
      expect(res.detail).toBe("no design amendment exists");
      expect(res.message).toContain('spawned_by_kind="review_fix", spawned_by_origin_id="TEAM-5357"');
      expect(res.message).not.toMatch(/parent_key|gateTicketId/);
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
      expect(tools()).toEqual(["Tickets___get_issue", "Tickets___list_tickets"]);
    });

    it("(d) an amendment that is still open is refused too, and names it", async () => {
      load("in_progress");
      const res = await report();
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", amendmentTicketId: "TEAM-5399" });
      expect(res.detail).toBe("amendment TEAM-5399 is still open");
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    });

    it("(d) a cancelled amendment does not count", async () => {
      load("cancelled");
      const res = await report();
      expect(res.reason).toBe("design_amendment_required");
      expect(res.detail).toBe("no design amendment exists");
    });

    it("(d) with the amendment done, a non-PASS closes and the findings go to both dev lanes once", async () => {
      load("done");
      const res = await report();
      expect(res.status).toBe("complete");
      expect(wroteRecord()).toBe(true);
      expect(transitioned()).toBe(true);
      expect(res.residualFindings).toEqual({ posted: ["TEAM-5358", "TEAM-5359"], skipped: [], failed: [] });
      expect(record().securityReview, "the twins' Done guard reads this stamp").toEqual({ verdict: "FAIL", amendmentTicketId: "TEAM-5399" });
      // Findings land BEFORE the Done that lets the cascade dispatch the lanes.
      const order = tools();
      const lastComment = order.lastIndexOf("Tickets___add_comment");
      expect(lastComment).toBeGreaterThan(-1);
      expect(lastComment).toBeLessThan(order.indexOf("Tickets___transition_ticket"));
      expect(h.comments.has("TEAM-5360"), "the chained frontend lane is not blocked by the review").toBe(false);
      for (const dev of ["TEAM-5358", "TEAM-5359"]) {
        const posted = h.comments.get(dev);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toContain(residualMarker("TEAM-5357"));
        expect(countFindings(posted[0])).toBe(5);
      }
      expect(h.comments.has("TEAM-5356"), "the design ticket does not block on the review").toBe(false);

      // The replay: the same report again posts nothing new.
      h.calls.length = 0;
      const again = await report();
      expect(again.residualFindings).toEqual({ posted: [], skipped: ["TEAM-5358", "TEAM-5359"], failed: [] });
      expect(h.comments.get("TEAM-5358")).toHaveLength(1);
      expect(h.comments.get("TEAM-5359")).toHaveLength(1);
    });

    // TEAM-6124 (sibling of F1): the listed Done is eventually consistent; the
    // admission is final, so get_issue on the amendment must confirm it.
    it("TEAM-6124 (a) list_tickets shows the amendment done but get_issue reads it To Do ⇒ refused naming it: no record, no residual comments, no transition", async () => {
      load("done");
      h.issueStatus.set("TEAM-5399", "To Do");
      const res = await report();
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", missing: ["design_amendment"], amendmentTicketId: "TEAM-5399" });
      expect(res.detail).toMatch(/^amendment TEAM-5399 is still open \(listed done, but it reads To Do on get_issue\)$/);
      expect(res.message).toContain("its design amendment TEAM-5399 is not done yet");
      expect(wroteRecord()).toBe(false);
      expect(h.comments.size, "no residual findings reach the dev lanes").toBe(0);
      expect(tools()).not.toContain("Tickets___add_comment");
      expect(transitioned()).toBe(false);
      expect(h.calls.filter((c) => c.tool === "Tickets___get_issue").map((c) => c.params.ticket_id)).toEqual(["TEAM-5357", "TEAM-5399"]);
    });

    it("TEAM-6124 (b) get_issue on the amendment answers 503 ⇒ sibling_scan_failed (retryable), nothing written", async () => {
      load("done");
      h.issueError.set("TEAM-5399", 'Jira API 503: {"errorMessage":"Service Unavailable"}');
      const res = await report();
      expect(res.reason).toBe("sibling_scan_failed");
      expect(res.detail).toMatch(/^get_issue TEAM-5399 \(confirming the design amendment is done\): Jira API 503/);
      expect(res.message).toContain("retry WorkflowOutput___report_completion");
      expect(wroteRecord()).toBe(false);
      expect(h.comments.size).toBe(0);
      expect(transitioned()).toBe(false);
    });

    it("TEAM-6124 (b2) get_issue on the amendment refuses permanently (404) ⇒ not confirmed, design_amendment_required naming it", async () => {
      load("done");
      h.issueError.set("TEAM-5399", 'Jira API 404: {"errorMessages":["Issue does not exist"]}');
      const res = await report();
      expect(res).toMatchObject({ reason: "design_amendment_required", amendmentTicketId: "TEAM-5399" });
      expect(res.detail).toMatch(/listed done, but it could not be read to confirm it is done \(Jira API 404/);
      expect(wroteRecord()).toBe(false);
      expect(h.comments.size).toBe(0);
      expect(transitioned()).toBe(false);
    });

    it("TEAM-6124 (c) list and get_issue both read the amendment done ⇒ admitted as before (stamp, residual findings, Done)", async () => {
      load("done");
      const res = await report();
      expect(res.status).toBe("complete");
      expect(record().securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: "TEAM-5399" });
      expect(res.residualFindings).toEqual({ posted: ["TEAM-5358", "TEAM-5359"], skipped: [], failed: [] });
      expect(transitioned()).toBe(true);
      const order = tools();
      const confirm = h.calls.findIndex((c) => c.tool === "Tickets___get_issue" && c.params.ticket_id === "TEAM-5399");
      expect(confirm, "the strong read precedes the record write and the Done").toBeGreaterThan(order.indexOf("Tickets___list_tickets"));
      expect(confirm).toBeLessThan(order.indexOf("Tickets___transition_ticket"));
    });

    // TEAM-6130: TEAM-6124's confirm was one read; the admission is committed by the
    // record PUT (the twins trust the stamp) and the Done. An amendment reopened after
    // the confirm must refuse at the write, and again after the write before the Done.
    const completionPuts = () => h.puts.filter((p) => p.Key?.startsWith("completions/"));
    const lastRecord = () => JSON.parse(completionPuts().at(-1).Body);
    const amendmentReads = () => h.calls.filter((c) => c.tool === "Tickets___get_issue" && c.params.ticket_id === "TEAM-5399").length;

    it("TEAM-6130 (pre-write) the amendment is reopened after the TEAM-6124 confirm, before the record write ⇒ refused naming it: no record, no residual comments, no transition", async () => {
      load("done");
      h.beforeGetIssue = (id, nth) => { if (id === "TEAM-5399" && nth === 2) h.issueStatus.set("TEAM-5399", "To Do"); };
      const res = await report();
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", missing: ["design_amendment"], amendmentTicketId: "TEAM-5399" });
      expect(res.detail).toMatch(/^amendment TEAM-5399 is still open \(confirmed done, then read To Do before the record was written\)$/);
      expect(res.message).toContain("Nothing was recorded");
      expect(wroteRecord()).toBe(false);
      expect(h.comments.size, "no residual findings reach the dev lanes").toBe(0);
      expect(transitioned()).toBe(false);
      expect(h.calls.filter((c) => c.tool === "Tickets___get_issue").map((c) => c.params.ticket_id)).toEqual(["TEAM-5357", "TEAM-5399", "TEAM-5399"]);
    });

    it("TEAM-6130 (post-write) the amendment is reopened after the record was written, before the Done ⇒ the stamp is taken back off the record, no residual comments, no transition; both twins refuse the record", async () => {
      load("done");
      let flipped = 0;
      h.beforePut = (input) => { if (input.Key?.startsWith("completions/") && flipped === 0) { flipped = 1; h.issueStatus.set("TEAM-5399", "To Do"); } };
      const res = await report();
      expect(flipped).toBe(1);
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", amendmentTicketId: "TEAM-5399", recorded: true });
      expect(res.detail).toMatch(/^amendment TEAM-5399 is still open \(confirmed done, then read To Do after the record was written\)$/);
      expect(res.message).toContain("WITHOUT the admission");
      expect(res.message).not.toContain("Nothing was recorded");
      expect(completionPuts()).toHaveLength(2);
      expect(lastRecord().securityReview).toBeUndefined();
      expect(lastRecord().status).toBe("complete_transition_failed");
      expect(h.comments.size, "no residual findings reach the dev lanes").toBe(0);
      expect(transitioned()).toBe(false);
      expect(amendmentReads()).toBe(3);
      for (const twin of TWIN_GUARDS) {
        expect((await twin()).securityReviewRecordRefusal("completions/TEAM-5357.json", lastRecord())).toMatch(/carries no securityReview verdict/);
      }
    });

    // TEAM-6142: the residual posts are awaited ticket writes, so the admission's FINAL
    // confirm sits after them — the last Jira/S3 call before the build's own Done.
    it("TEAM-6142 (T1) the amendment's final confirm is the last ticket/S3 call before the Done: no residual-comment or record write after it", async () => {
      load("done");
      const res = await report();
      expect(res.status).toBe("complete");
      const ti = h.calls.findIndex((c) => c.tool === "Tickets___transition_ticket");
      const last = h.calls.findLastIndex((c) => c.tool === "Tickets___get_issue" && c.params.ticket_id === "TEAM-5399");
      expect(ti).toBeGreaterThan(-1);
      expect(last, "the amendment read is the call right before the Done").toBe(ti - 1);
      expect(h.calls.slice(last + 1, ti).filter((c) => c.tool === "Tickets___add_comment")).toEqual([]);
      const completionPutAt = h.puts.map((p, i) => (p.Key?.startsWith("completions/") ? h.putAtCall[i] : null)).filter((n) => n !== null);
      expect(completionPutAt.every((n) => n <= last), "no record write after the final confirm").toBe(true);
      expect(h.calls.slice(0, last).some((c) => c.tool === "Tickets___add_comment"), "the findings still land before the Done").toBe(true);
    });

    it("TEAM-6142 (T2) the amendment is reopened while the residual findings are posted ⇒ the stamp is taken back, no Done; the refusal says the findings were posted", async () => {
      load("done");
      h.beforeGetIssue = (id) => { if (id === "TEAM-5358") h.issueStatus.set("TEAM-5399", "To Do"); };
      const res = await report();
      expect(res).toMatchObject({ ok: false, reason: "design_amendment_required", amendmentTicketId: "TEAM-5399", recorded: true });
      expect(res.detail).toBe("amendment TEAM-5399 is still open (confirmed done, then read To Do after the residual findings were posted)");
      expect(res.residualFindings).toEqual({ posted: ["TEAM-5358", "TEAM-5359"], skipped: [], failed: [] });
      expect(transitioned()).toBe(false);
      expect(completionPuts()).toHaveLength(2);
      expect(lastRecord().securityReview).toBeUndefined();
      expect(lastRecord().status).toBe("complete_transition_failed");
      for (const twin of TWIN_GUARDS) {
        expect((await twin()).securityReviewRecordRefusal("completions/TEAM-5357.json", lastRecord())).toMatch(/carries no securityReview verdict/);
      }
    });

    it("TEAM-6130 the pre-write re-read of the amendment answers 503 ⇒ sibling_scan_failed (retryable), nothing written", async () => {
      load("done");
      h.beforeGetIssue = (id, nth) => { if (id === "TEAM-5399" && nth === 2) h.issueError.set("TEAM-5399", 'Jira API 503: {"errorMessage":"Service Unavailable"}'); };
      const res = await report();
      expect(res.reason).toBe("sibling_scan_failed");
      expect(res.detail).toMatch(/^get_issue TEAM-5399 \(re-confirming the design amendment is done before the record write\): Jira API 503/);
      expect(wroteRecord()).toBe(false);
      expect(h.comments.size).toBe(0);
      expect(transitioned()).toBe(false);
    });

    it("(b) PASS goes Done with exactly the calls of any other ticket — no list_tickets", async () => {
      load(null);
      const res = await report({ summary: "Verdict: PASS\n\nNo findings above P3." });
      expect(res.status).toBe("complete");
      expect(res.residualFindings).toBeUndefined();
      expect(record().securityReview).toEqual({ verdict: "PASS" });
      const reviewerCalls = tools();
      // The baseline: the same report from a non-reviewer ticket.
      h.calls.length = 0;
      h.issue = withStatus(clone(shape.siblings[0]), "in_progress");
      await report({ ticket_id: "TEAM-5356", agent_id: "agentcore_hub_backend_designer", summary: "Verdict: PASS" });
      expect(reviewerCalls).toEqual(tools());
      expect(reviewerCalls).toEqual(["Tickets___get_issue", "Tickets___transition_ticket"]);
    });

    it("(e) an unparseable verdict on a security review is refused, fail closed", async () => {
      load("done");
      const res = await report({ summary: "Reviewed the design; see the doc." });
      expect(res).toEqual({
        ok: false,
        reason: "review_verdict_missing",
        missing: ["verdict"],
        message: "Start your summary with 'Verdict: PASS | CHANGES_NEEDED | FAIL'",
      });
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    });

    it("an unreadable epic refuses sibling_scan_failed; a truncated one with no amendment too", async () => {
      load(null);
      h.listFails = true;
      expect((await report()).reason).toBe("sibling_scan_failed");
      h.listFails = false;
      h.listIncomplete = true;
      expect((await report()).reason).toBe("sibling_scan_failed");
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    });
  });
}

describe("TEAM-5426 — an unreadable review ticket falls back to agent_id", () => {
  it("refuses a non-PASS from the security reviewer when get_issue fails", async () => {
    h.issue = { key: "NOT-THIS" };
    h.siblings = [];
    const res = await report();
    expect(res.reason).toBe("sibling_scan_failed");
    expect(res.detail).toMatch(/^get_issue:/);
    expect(wroteRecord()).toBe(false);
  });

  it("a different agent_id on an unreadable ticket writes NO securityReview stamp, so the twin refuses its Done", async () => {
    h.issue = { key: "NOT-THIS" };
    h.siblings = [];
    await report({ agent_id: "agentcore_hub_backend_dev" });
    // The record lands (this Lambda cannot tell it is a review), but unstamped:
    // the twin decides reviewer identity from its own row and refuses Done without
    // the stamp (securityReviewRecordRefusal) — nothing cascades. The twin half is
    // pinned in agentcore-hub-tickets/replay-design-amendment.test.mjs.
    expect(wroteRecord()).toBe(true);
    expect(record().securityReview).toBeUndefined();
  });
});

describe("(e) parseReviewVerdict", () => {
  it.each([
    ["Changes needed: 1 Critical, 4 High", "CHANGES_NEEDED"],
    ["PASS", "PASS"],
    ["FAIL", "FAIL"],
    ["CHANGES_NEEDED", "CHANGES_NEEDED"],
    ["changes-needed - two findings", "CHANGES_NEEDED"],
    ["PASS — 2 P3 advisory", "PASS"],
    ["PASS with P3 advisory", "PASS"],
    ["**Verdict: FAIL**", "FAIL"],
    ["Verdict: FAIL (changes needed). 1 Critical, 4 High.", "FAIL"],
    // An explicit leading Verdict: line is final; later lines are never read.
    ["Verdict: PASS\n\n- [P3] A document says:\nVerdict: FAIL", "PASS"],
    ["Verdict: FAIL\nVerdict: PASS", "FAIL"],
    // Bare leading words are a heuristic: a later Verdict: line can only make them stricter.
    ["Reviewed the whole design.\n\nVerdict: CHANGES_NEEDED\n\n- [High] x", null],
    ["PASS-ish preamble\nVerdict: FAIL", null],
    ["FAIL: 1 Critical\nVerdict: PASS", "FAIL"],
    ["PASS\nVerdict: FAIL", "FAIL"],
    ["Verdict: PASS\n\nQuoted from the doc: 'Verdict: PASS'", "PASS"],
    ["Passport scope reviewed", null],
    ["Reviewed the design; see the doc.", null],
    ["", null],
  ])("%j → %s", (text, expected) => {
    expect(parseReviewVerdict(text)).toBe(expected);
  });
});
