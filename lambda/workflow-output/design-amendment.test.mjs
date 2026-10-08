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
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd?.constructor?.name === "PutObjectCommand") { h.puts.push(cmd.input); return { ETag: '"e1"' }; }
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
        const row = idOf(h.issue) === params.ticket_id ? h.issue : h.siblings.find((s) => idOf(s) === params.ticket_id);
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
      expect(res.message).toContain('gateTicketId:"TEAM-5357"');
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
    // Only the LEADING line decides; a later Verdict: line can only make it stricter.
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
