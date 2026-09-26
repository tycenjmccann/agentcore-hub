import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * report_completion's completion RECORD (TEAM-4121 FR-9).
 *
 * completions/<ticket>.json is the only durable statement of how an agent knows
 * its work is done, and the orchestrator now acts on it: a fix ticket that
 * declared evidence_source=live but whose record carries no live evidence is
 * marked `unverified` and re-verified at the PR head (live-reverify.mjs). So the
 * two new fields have to be BOTH additive — a record written without them must
 * keep exactly the pre-4121 key set, or every existing consumer changes shape at
 * once — and closed: an unrecognized evidence_kind is dropped rather than stored,
 * because a downstream reader must never have to guess what a novel value meant.
 */

/**
 * save_design_doc's by-reference path (TEAM-4589) is also covered here, which is
 * why the S3 mock below is backed by an in-test object map rather than returning
 * a bare {}: reading a doc by key, the shared/ dedupe listing and the manifest
 * round-trip are all the SAME bucket, so a test that writes then re-saves has to
 * see its own bytes. `h.puts` still records PutObjectCommand inputs verbatim, so
 * every report_completion assertion above/below is untouched by the redesign.
 */
/**
 * `heads` / `headError` back the DL-030 cd-ledger probe (TEAM-4706). The probe's
 * whole point is that a definite 404 and a failed look are DIFFERENT answers, so
 * the stub has to be able to produce each on demand: by default HeadObject
 * answers from the same object map (absent key → NotFound + 404), and a test can
 * set `h.headError` to any other AWS error to simulate the indeterminate case.
 */
/**
 * TEAM-4740 adds a SECOND consumer of the ticket-tools Lambda: report_completion
 * now reads the ticket (for its epic and its base_branch line) and creates the
 * follow-up tickets a report hands on. So the blanket `{ok:true}` stub becomes a
 * tiny fake ticket system — `h.issue` is what get_issue answers, `h.siblings` is
 * the epic's children, `h.ticketFail` makes a named tool fail — and `h.calls`
 * records every (tool, params) pair, which is what most of the new assertions
 * read. `h.created` rows are appended to `h.siblings` on create, because that is
 * the state a RE-invocation of the same report actually sees; it is what makes
 * the idempotency test a real round trip rather than a mock reading its own stub.
 */
const h = vi.hoisted(() => ({
  puts: [], warns: [], gets: [], heads: [], headError: null, invokes: [], objects: new Map(),
  // TEAM-4754: a GetObject that fails for a reason OTHER than "not there" — the
  // whole point of the three-outcome cd-ledger read. Mirrors `headError`.
  getError: null,
  calls: [], events: [], issue: undefined, siblings: [], created: [], ticketFail: new Set(),
  // FR-10: per-CALL transition control, which `ticketFail` (keyed on the tool) cannot
  // express — the skip walk's whole shape is "skip, and if THAT one is refused, block
  // then skip", so a test has to be able to refuse one ticket or one transition_id.
  transitionGate: null,
  // TEAM-4754 N2: per-CALL create control, for the same reason `transitionGate`
  // exists — "the second of two follow-ups fails" is the case the transition gate
  // is actually about, and `ticketFail` (keyed on the tool) fails both or neither.
  createGate: null,
  // TEAM-5101: comments per ticket id, appended by add_comment and served back on
  // get_issue in the jira twin's shape — what makes the notice dedupe a round trip.
  comments: new Map(),
  // TEAM-5123: what get_issue shows of those comments — `true` hides them all (the
  // jira twin's silent `comments: []` on a failed comment fetch), a number serves only
  // the newest N (its single newest-first page of 50). Null serves every comment.
  commentsHidden: false, commentWindow: null,
  // FR-11: the workflows-table row `submit_ticket_plan` reads `featureBranch` off,
  // plus every Get it issued and an optional throw (the fail-open path).
  workflow: null, workflowGets: [], workflowGetError: null,
  // TEAM-4756 R3-2: `h.calls.length` at the moment of each PutObject, one entry per
  // `h.puts` entry. The R3-2 invariant is an ORDERING one — the record lands after the
  // follow-up creates and before the Done transition — and S3 and the ticket Lambda are
  // separate mocks, so there is otherwise nothing that relates their two arrays.
  putAtCall: [],
  // TEAM-4756 R3-2: `(input) => Error|null`, consulted on every PutObject after it has
  // been recorded on `h.puts` (so a gate can count what it has already seen). The status
  // rewrite on a failed transition is BEST-EFFORT, and "best-effort" is only a claim if
  // a test can make it fail and watch the response stay the same.
  putGate: null,
  // TEAM-5155: every DeleteObject input, and an optional throw for all of them — the
  // claim release is best-effort, so a test has to be able to make it fail.
  deletes: [], deleteError: null,
  // TEAM-5162: one ETag per stored key, bumped on every write — what an IfMatch
  // (the stale follow-up claim takeover) is checked against, as S3 does.
  etags: new Map(), etagSeq: 0,
  // TEAM-5167: per-CALL DeleteObject control (like `putGate`), consulted after the
  // delete is recorded — a release is now `IfMatch`-conditional, and "conditional" is
  // only a claim if a test can move the ETag under it and watch the delete 412.
  deleteGate: null,
  // TEAM-5167: S3's LastModified per key, set by every PUT and served on GetObject.
  // Absent for a body a test seeds straight into `h.objects` — the "claim nobody can
  // date" case the stale rule has to treat as stale.
  lastModified: new Map(),
  // TEAM-5167: `(rows, nthCall) => rows | false`, consulted on every list_tickets, so a
  // test can make ONE scan lag (Jira's search index) or fail while the others answer.
  listGate: null, listCalls: 0,
  // TEAM-5167: overrides the SDK conditional-header probe — null runs the real one
  // (which is inconclusive against this mocked S3Client), a function is its verdict.
  probe: null,
}));

const asString = (body) => (typeof body === "string" ? body : Buffer.from(body).toString("utf8"));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd?.constructor?.name;
      const input = cmd?.input || {};
      if (name === "PutObjectCommand") {
        h.puts.push(input);
        h.putAtCall.push(h.calls.length);
        // TEAM-4756 R3-2: per-CALL, like `transitionGate`, because the case under test is
        // "the FIRST write of this key lands and the SECOND fails" — a key-scoped throw
        // would fail both and there would be no record to leave standing.
        if (h.putGate) {
          const err = h.putGate(input);
          if (err) throw err;
        }
        // TEAM-5167: an IfMatch PUT against a key that is GONE is a 404, not a 412 — the
        // S3 user guide's "concurrent delete before a conditional write" case.
        if (input.IfMatch !== undefined && !h.objects.has(input.Key)) {
          const err = new Error(`The specified key does not exist: ${input.Key}`);
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        // TEAM-5155: S3's conditional write. Checked and set with no await in between,
        // so two handlers racing under Promise.all see exactly one winner, as S3 does.
        if ((input.IfNoneMatch === "*" && h.objects.has(input.Key))
          || (input.IfMatch !== undefined && h.etags.get(input.Key) !== input.IfMatch)) {
          const err = new Error("At least one of the pre-conditions you specified did not hold");
          err.name = "PreconditionFailed";
          err.$metadata = { httpStatusCode: 412 };
          throw err;
        }
        h.objects.set(input.Key, asString(input.Body));
        h.lastModified.set(input.Key, new Date());
        const ETag = `"e${++h.etagSeq}"`;
        h.etags.set(input.Key, ETag);
        return { ETag };
      }
      if (name === "DeleteObjectCommand") {
        h.deletes.push(input);
        if (h.deleteError) throw h.deleteError;
        if (h.deleteGate) {
          const err = h.deleteGate(input);
          if (err) throw err;
        }
        // TEAM-5167: S3's conditional delete (If-Match, general purpose buckets): a
        // mismatched ETag is a 412; a missing key is a 204 no-op, as on real S3.
        if (input.IfMatch !== undefined && h.objects.has(input.Key) && h.etags.get(input.Key) !== input.IfMatch) {
          const err = new Error("At least one of the pre-conditions you specified did not hold");
          err.name = "PreconditionFailed";
          err.$metadata = { httpStatusCode: 412 };
          throw err;
        }
        h.objects.delete(input.Key);
        h.etags.delete(input.Key);
        h.lastModified.delete(input.Key);
        return {};
      }
      if (name === "GetObjectCommand") {
        h.gets.push(input);
        // Keyed so a test can break ONE object's read without breaking the design
        // docs and manifests every other test reads back.
        if (h.getError && (!h.getError.key || h.getError.key === input.Key)) throw h.getError.err;
        if (!h.objects.has(input.Key)) {
          // Real S3 surfaces a missing object this way, and the Lambda's error
          // message quotes err.name — so the stub has to carry the same name.
          const err = new Error(`The specified key does not exist: ${input.Key}`);
          err.name = "NoSuchKey";
          throw err;
        }
        const body = h.objects.get(input.Key);
        return {
          ContentType: "text/markdown",
          ETag: h.etags.get(input.Key),
          LastModified: h.lastModified.get(input.Key),
          Body: {
            transformToString: async () => body,
            transformToByteArray: async () => Buffer.from(body),
          },
        };
      }
      if (name === "HeadObjectCommand") {
        h.heads.push(input);
        if (h.headError) throw h.headError;
        if (!h.objects.has(input.Key)) {
          const err = new Error(`Not Found: ${input.Key}`);
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { ContentLength: h.objects.get(input.Key).length };
      }
      if (name === "ListObjectsV2Command") {
        const prefix = input.Prefix || "";
        return {
          Contents: [...h.objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ Key: k, Size: h.objects.get(k).length, LastModified: new Date(0) })),
        };
      }
      return {};
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  HeadObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
  DeleteObjectCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
/** A DynamoDB-twin-shaped ticket row (the shape normalizeIssue reads). */
const ticketRow = ({ key, summary = "Work", assignee = "agentcore_hub_api_dev", status = "todo", parent = "TEAM-4100", created = "2026-09-17T09:00:00.000Z", description = "", blockedBy = [] }) => ({
  key,
  fields: {
    summary, description, status: { name: status }, assignee: { displayName: assignee },
    parent: parent ? { key: parent } : undefined, created,
  },
  blockedBy,
});

vi.mock("@aws-sdk/client-lambda", () => ({
  // The Done transition itself is not under test — a plain success keeps the log
  // quiet — but `h.invokes` records every call, because the DL-030 refusals below
  // are only meaningful if the ticket was NOT transitioned.
  LambdaClient: class {
    async send(cmd) {
      const input = cmd?.input || {};
      h.invokes.push(input);
      let call = {};
      try { call = JSON.parse(Buffer.from(input.Payload).toString("utf8")); } catch { /* not JSON: leave blank */ }
      const tool = call.tool_name || null;
      const params = call.parameters || {};
      h.calls.push({ tool, params });
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      // The DynamoDB twin reports failure as a textResult, not a throw — the shape
      // ticketTool's toolFailure() has to recognize.
      if (h.ticketFail.has(tool)) return reply({ content: [{ type: "text", text: `Error: ${tool} is unavailable` }] });
      // TEAM-4756 R3-1 widens the gate's verdict vocabulary, because "a refused
      // transition" has FOUR real shapes and the fix is about telling them apart:
      // `false` keeps the pre-4756 canned "Error: ..." text (every existing caller
      // returns only true/false and is untouched), a STRING is that exact text as the
      // DynamoDB twin's bare textResult, an OBJECT is the payload verbatim (a
      // structured `ok:false` refusal, or a `{errorMessage}` FunctionError), and a
      // gate that THROWS is an invoke-level throw — the throttle/timeout case.
      if (tool === "Tickets___transition_ticket" && h.transitionGate) {
        const verdict = h.transitionGate(params);
        if (verdict === false) {
          return reply({ content: [{ type: "text", text: `Error: transition ${params.transition_id} is not available from the current status` }] });
        }
        if (typeof verdict === "string") return reply({ content: [{ type: "text", text: verdict }] });
        if (verdict && typeof verdict === "object") return reply(verdict);
      }
      if (tool === "Tickets___get_issue") {
        // `h.issue` is the REPORTED ticket's answer. Since FR-10 the sweep also reads
        // blockedBy off each SIBLING by id, so a single canned answer would make
        // every sibling look like a leaf and quietly pass the ordering test — hence
        // the per-id lookup, which only applies to ids that are not the reported one.
        const id = params.ticket_id;
        const reportedId = h.issue?.key || h.issue?.ticketId || null;
        const sibling = id !== reportedId ? h.siblings.find((s) => s.key === id) : null;
        // TEAM-5101: comments only when a test has put some there, so every other
        // get_issue answer is byte-identical to before.
        const visible = (list) => (h.commentsHidden ? [] : h.commentWindow ? list.slice(-h.commentWindow) : list);
        const withComments = (obj) => (h.comments.has(id) && obj && typeof obj === "object"
          ? { ...obj, comments: visible(h.comments.get(id)).map((body) => ({ author: "agent", body })) } : obj);
        if (sibling) return reply(withComments(sibling));
        return reply(withComments(h.issue === undefined ? ticketRow({ key: id, summary: "The ticket under report" }) : h.issue));
      }
      if (tool === "Tickets___add_comment") {
        const list = h.comments.get(params.ticket_id) || [];
        list.push(params.comment);
        h.comments.set(params.ticket_id, list);
        return reply({ ticketId: params.ticket_id, message: "Comment added" });
      }
      if (tool === "Tickets___list_tickets") {
        // TEAM-5167: `listGate` lets one scan lag or fail while the others answer.
        let rows = h.siblings;
        if (h.listGate) {
          const verdict = h.listGate(rows, ++h.listCalls);
          if (verdict === false) return reply({ content: [{ type: "text", text: "Error: list_tickets is unavailable" }] });
          rows = verdict;
        }
        return reply({ total: rows.length, issues: rows });
      }
      if (tool === "Tickets___create_ticket") {
        // TEAM-4754 N2: a per-call refusal. `null` from the gate throws a
        // NON-Error, which is the only way to reach reportCompletion's OUTER catch:
        // ticketTool's own catch reads `err.name`, so a nullish throw raises a
        // TypeError inside it and escapes. A thrown Error would just come back as a
        // per-entry `failed[]` row, which the `false` verdict already covers.
        if (h.createGate) {
          const verdict = h.createGate(params);
          if (verdict === null) throw null; // eslint-disable-line no-throw-literal
          if (verdict === false) return reply({ content: [{ type: "text", text: `Error: create_ticket refused ${params.summary}` }] });
          // TEAM-5123: a REAL Lambda FunctionError — the invoke response carries the
          // `FunctionError` header and the payload is the runtime's error object.
          if (verdict && typeof verdict === "object" && verdict.FunctionError) {
            return { FunctionError: verdict.FunctionError, Payload: new TextEncoder().encode(JSON.stringify(verdict.Payload)) };
          }
          // TEAM-5101: an OBJECT is the payload verbatim — the jira twin's
          // `{ error: "Jira API <status>: ..." }` idiom.
          if (verdict && typeof verdict === "object") return reply(verdict);
        }
        const key = `TEAM-49${String(h.created.length + 1).padStart(2, "0")}`;
        h.created.push({ key, params });
        // A created follow-up IS a sibling from that moment on. Appending it is what
        // makes the idempotency assertion a real round trip: the second report reads
        // back the [fu:<hash>] summary this create wrote.
        h.siblings.push(ticketRow({ key, summary: params.summary, assignee: params.assignee, created: "2026-09-17T12:00:00.000Z" }));
        return reply({ key, self: `https://tickets/${key}`, status: "created", ticket: { key, summary: params.summary } });
      }
      return reply({ ok: true });
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  // Journey events are the only DynamoDB WRITE this Lambda makes (FR-14's
  // delivery.prState event is asserted off `h.events`); TEAM-4740 FR-11 adds one
  // read — GetItem on the workflows table for `featureBranch`.
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd) => {
        if (cmd?.constructor?.name === "GetCommand") {
          h.workflowGets.push(cmd.input);
          if (h.workflowGetError) throw h.workflowGetError;
          return { Item: h.workflow || undefined };
        }
        if (cmd?.input?.Item) h.events.push(cmd.input.Item);
        return {};
      },
    }),
  },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
// TEAM-5162: the contested follow-up claim's re-check interval — one macrotask, which
// is after every microtask-only mock chain of the claim's owner has settled.
process.env.FOLLOW_UP_CLAIM_WAIT_MS = "1";
// TEAM-5167: the back-off between retries of a conditional PUT that hit a 409 — one
// macrotask, for the same reason.
process.env.CLAIM_RETRY_WAIT_MS = "1";
// FR-11 templating is skipped when this is unset, so every plan test below would
// assert the no-op path if it were absent.
process.env.WORKFLOWS_TABLE = "agentcore-hub-workflows";
// TEAM-5167: the SDK conditional-header probe, at its module seam. The real probe
// runs by default and is INCONCLUSIVE here (the mocked S3Client has no middleware
// stack to serialize through), which is exactly the verdict a mocked suite must get;
// `h.probe` lets one test hand it a "missing" verdict and watch the claims fail closed.
vi.mock("./s3-conditional.mjs", async (importOriginal) => {
  // Tolerant of the module being absent, so the RED run on the pre-fix code fails
  // test-by-test instead of at file load.
  let real;
  try { real = await importOriginal(); } catch { real = { probeConditionalHeaders: async () => ({ verdict: "inconclusive", reason: "module absent" }) }; }
  return { ...real, probeConditionalHeaders: (...args) => (h.probe ? h.probe(...args) : real.probeConditionalHeaders(...args)) };
});
const { handler, inferToolFromArgs, followUpHash, followUpBanner, sweepSkipOrder, toolFailure, isAlreadyDoneRefusal } = await import("./index.mjs");
/** TEAM-5167: age a stored claim — rewrite every timestamp in its body to `ms` ago. */
const age = (key, ms) => {
  const body = JSON.parse(h.objects.get(key));
  const then = new Date(Date.now() - ms).toISOString();
  for (const k of ["claimedAt", "uncertainAt", "deliveredAt"]) if (k in body) body[k] = then;
  h.objects.set(key, JSON.stringify(body));
  h.lastModified.set(key, new Date(Date.now() - ms));
};

/** The completion record the call wrote, parsed. */
const record = () => JSON.parse(h.puts.find((p) => p.Key?.startsWith("completions/")).Body);

const report = (extra) =>
  handler({
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: "TEAM-4200",
      summary: "Re-ran the expired-token repro at HEAD; 401 as expected.",
      workflow_id: "wf_1",
      agent_id: "agentcore_hub_qa_verifier",
      ...extra,
    },
  });

// Every key a pre-4121 record carries — asserted as a SET so an accidental
// addition (or rename) fails here rather than in whatever reads the record.
//
// TEAM-4740 FR-14 adds exactly one: `delivery` is on EVERY record (it is derived
// from the report, so it is always computable), which is why it belongs in the
// base set rather than in the additive-field tests. That "plus only delivery" is
// itself the assertion — the hirhfw regression is that nothing ELSE moved.
//
// TEAM-4756 R3-2 adds exactly two more, on the same "every record carries them"
// footing: `followUpsPending` and `status` are computable on every completion and
// are what the twins' existence-only DL-030 guard has to read.
const BASE_KEYS = ["ticket_id", "summary", "artifacts", "branch", "commit_sha", "pr_url", "completed_at", "delivery", "followUpsPending", "status"];

// TEAM-4706 fixtures, shared with the ship-report-contract block at the bottom.
const EXEC_ID = "b3a1c0de-1234-4f56-89ab-cdef01234567"; // 36 chars, [0-9a-f-] only
const PIPELINE = "hub-agentcore-hub-deploy";
const MERGE_COMMIT = "0ef5892abc";
const PR_URL = "https://github.com/owner/repo/pull/42";
/** The tool's parsed result payload (success OR refusal — both are values). */
const result = (res) => JSON.parse(res.content[0].text);
/** Did the call write a completion record at all? */
const wroteRecord = () => h.puts.some((p) => p.Key?.startsWith("completions/"));
/**
 * Did the call ask the ticket-tools Lambda to transition the ticket?
 *
 * Keyed on the TOOL, not on "any invoke happened" — since TEAM-4740 a report also
 * reads the ticket and may create follow-ups, so `h.invokes.length > 0` would now
 * read every refusal as a transition and quietly pass the DL-030 tests below.
 */
const transitioned = () => h.calls.some((c) => c.tool === "Tickets___transition_ticket");
/** Params of every call to one tool, in order. */
const calls = (tool) => h.calls.filter((c) => c.tool === tool).map((c) => c.params);
/** Journey events of one type, most recent last. */
const events = (type) => h.events.filter((e) => e.type === type);

beforeEach(() => {
  h.puts.length = 0;
  h.putAtCall.length = 0;
  h.putGate = null;
  h.deletes.length = 0;
  h.deleteError = null;
  h.warns.length = 0;
  h.gets.length = 0;
  h.heads.length = 0;
  h.invokes.length = 0;
  h.calls.length = 0;
  h.events.length = 0;
  h.created.length = 0;
  h.siblings.length = 0;
  h.ticketFail.clear();
  h.transitionGate = null;
  h.createGate = null;
  h.comments.clear();
  h.commentsHidden = false;
  h.commentWindow = null;
  h.issue = undefined;
  h.headError = null;
  h.getError = null;
  h.objects.clear();
  h.etags.clear();
  h.lastModified.clear();
  h.deleteGate = null;
  h.listGate = null;
  h.listCalls = 0;
  h.probe = null;
  h.workflowGets.length = 0;
  h.workflow = null;
  h.workflowGetError = null;
  // TEAM-4752 D3: unset by default, so no test can reach the real GitHub API just
  // because the developer running it happens to have a token exported. The D3 block
  // below sets it explicitly and stubs `fetch` alongside.
  delete process.env.GITHUB_TOKEN;
  vi.spyOn(console, "warn").mockImplementation((...args) => h.warns.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => h.warns.push(args.join(" ")));
});

describe("report_completion — evidence_kind / evidence_keys", () => {
  it("persists both when the agent supplies them", async () => {
    await report({ evidence_kind: "live", evidence_keys: "workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log" });
    const r = record();
    expect(r.evidence_kind).toBe("live");
    expect(r.evidence_keys).toBe("workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log");
  });

  it("a record written without them keeps exactly the pre-4121 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("blank values are the same as absent", async () => {
    await report({ evidence_kind: "   ", evidence_keys: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("normalizes case and whitespace", async () => {
    await report({ evidence_kind: " LIVE " });
    expect(record().evidence_kind).toBe("live");
  });

  it("accepts the other two kinds", async () => {
    await report({ evidence_kind: "static" });
    expect(record().evidence_kind).toBe("static");
    h.puts.length = 0;
    await report({ evidence_kind: "unit" });
    expect(record().evidence_kind).toBe("unit");
  });

  it("drops an unknown kind with a warning instead of storing it", async () => {
    await report({ evidence_kind: "vibes", evidence_keys: "qa-evidence/a.png" });
    const r = record();
    expect("evidence_kind" in r).toBe(false);
    // The keys still land — they are the weaker signal, but they are real.
    expect(r.evidence_keys).toBe("qa-evidence/a.png");
    expect(h.warns.join("\n")).toMatch(/unknown evidence_kind "vibes"/);
  });

  it("accepts an array of keys (the harness sends a comma string; a gateway may not)", async () => {
    await report({ evidence_kind: "live", evidence_keys: ["qa-evidence/a.png", "qa-evidence/b.har"] });
    expect(record().evidence_keys).toBe("qa-evidence/a.png,qa-evidence/b.har");
  });
});

// TEAM-4122 FR-4 §7.5 — the CI agent's proof that a head SHA was actually built,
// same additive-and-closed contract as evidence_kind above.
describe("report_completion — ci_status / ci_build_id / ci_head_sha", () => {
  it("persists all three when the CI agent supplies them", async () => {
    await report({ ci_status: "certified", ci_build_id: "agentcore-hub-ci:abc123", ci_head_sha: "deadbeef" });
    const r = record();
    expect(r.ci_status).toBe("certified");
    expect(r.ci_build_id).toBe("agentcore-hub-ci:abc123");
    expect(r.ci_head_sha).toBe("deadbeef");
  });

  it("a record written without them keeps exactly the pre-4122 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("accepts the other two statuses and normalizes case/whitespace", async () => {
    await report({ ci_status: "  GITHUB-ACTIONS-PROXY  " });
    expect(record().ci_status).toBe("github-actions-proxy");
    h.puts.length = 0;
    await report({ ci_status: "unverified" });
    expect(record().ci_status).toBe("unverified");
  });

  it("drops an unknown status with a warning instead of storing it", async () => {
    await report({ ci_status: "definitely-passed", ci_build_id: "abc123" });
    const r = record();
    expect("ci_status" in r).toBe(false);
    // The build id still lands — it's the weaker signal, but it's real.
    expect(r.ci_build_id).toBe("abc123");
    expect(h.warns.join("\n")).toMatch(/unknown ci_status "definitely-passed"/);
  });

  it("drops an oversized build id / head sha with a warning instead of storing it", async () => {
    await report({ ci_build_id: "x".repeat(129), ci_head_sha: "y".repeat(129) });
    const r = record();
    expect("ci_build_id" in r).toBe(false);
    expect("ci_head_sha" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/oversized ci_build_id/);
    expect(h.warns.join("\n")).toMatch(/oversized ci_head_sha/);
  });
});

// DL-024 / ship verdict — the release manager's CD ticket reports how the run
// ended. The orchestrator's completion evidence harvest already reads these
// keys (completion.mjs SHIP_BLOCKED_OUTCOMES); same additive-and-closed contract.
describe("report_completion — merge_commit / outcome / block_reason", () => {
  it("persists all three when the release manager supplies them", async () => {
    await report({ merge_commit: "0ef5892abc", outcome: "shipped", block_reason: "" });
    const r = record();
    expect(r.merge_commit).toBe("0ef5892abc");
    expect(r.outcome).toBe("shipped");
    expect("block_reason" in r).toBe(false);
  });

  it("a record written without them keeps exactly the base key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("normalizes outcome case/whitespace and accepts every allowed value", async () => {
    // TEAM-4706: two of the four outcomes now have to satisfy the ship-report
    // contract (see the last describe), so each is given the fields IT requires.
    // The assertion is unchanged: all four values are accepted and normalized.
    const REQUIRED = {
      shipped: { merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID },
      "deploy-blocked": {},
      "static-ci-only": {},
      handoff: { pr_url: PR_URL },
    };
    for (const oc of ["shipped", "deploy-blocked", "static-ci-only", "handoff"]) {
      h.puts.length = 0;
      await report({ outcome: ` ${oc.toUpperCase()} `, ...REQUIRED[oc] });
      expect(record().outcome).toBe(oc);
    }
  });

  it("drops an unknown outcome with a warning but keeps block_reason", async () => {
    await report({ outcome: "kinda-shipped", block_reason: "pipeline stage Deploy failed" });
    const r = record();
    expect("outcome" in r).toBe(false);
    expect(r.block_reason).toBe("pipeline stage Deploy failed");
    expect(h.warns.join("\n")).toMatch(/unknown outcome "kinda-shipped"/);
  });

  it("clips block_reason to 500 chars and drops an oversized merge_commit", async () => {
    await report({ merge_commit: "x".repeat(129), block_reason: "y".repeat(600) });
    const r = record();
    expect("merge_commit" in r).toBe(false);
    expect(r.block_reason).toHaveLength(500);
    expect(h.warns.join("\n")).toMatch(/oversized merge_commit/);
  });
});

// TEAM-4525 AC-3 — the head SHA a human approved at the Merge Approval gate is
// recorded on the ship record, so the deploy gate's "is this the merge of what a
// human approved?" question has a durable answer. Same additive contract as
// merge_commit, but stricter: anything that is not a full 40-hex git SHA is
// dropped, because a half-recorded SHA would be read as an approval it isn't.
describe("report_completion — approved_head_sha", () => {
  const SHA = "1f0c3b8ad4e5f60718293a4b5c6d7e8f90a1b2c3";

  it("persists a valid 40-hex sha alongside merge_commit", async () => {
    await report({ approved_head_sha: SHA, merge_commit: "0ef5892abc", outcome: "shipped" });
    const r = record();
    expect(r.approved_head_sha).toBe(SHA);
    expect(r.merge_commit).toBe("0ef5892abc");
  });

  it("trims and lowercases", async () => {
    await report({ approved_head_sha: `  ${SHA.toUpperCase()}  ` });
    expect(record().approved_head_sha).toBe(SHA);
  });

  it("drops a value that is not a git sha with a warning", async () => {
    await report({ approved_head_sha: "abc", merge_commit: "0ef5892abc" });
    const r = record();
    expect("approved_head_sha" in r).toBe(false);
    // The merge commit still lands — the malformed field is dropped alone.
    expect(r.merge_commit).toBe("0ef5892abc");
    expect(h.warns.join("\n")).toMatch(/malformed approved_head_sha/);
  });

  it("drops an oversized value with a warning", async () => {
    await report({ approved_head_sha: "a".repeat(129) });
    expect("approved_head_sha" in record()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/malformed approved_head_sha/);
  });

  it("an absent value produces no key at all", async () => {
    await report({});
    const r = record();
    expect("approved_head_sha" in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("a blank value is the same as absent — no key, no warning", async () => {
    await report({ approved_head_sha: "   " });
    expect("approved_head_sha" in record()).toBe(false);
    expect(h.warns.join("\n")).not.toMatch(/approved_head_sha/);
  });
});

// ─── TEAM-4706 / DL-030: the ship-report contract ─────────────────────────────
//
// `outcome:"shipped"` is the only durable claim that production changed, and the
// tool used to take it on trust — a record with no merge commit and no deploy
// execution still closed the ticket, so "we shipped" and "we never reached CD"
// were the same bytes. Now a shipped report must NAME what it shipped, and a
// handoff must name the PR it handed off; a report that cannot is refused as a
// VALUE (the agent can read the reason and act), and refusal means NOTHING is
// written and the ticket is NOT transitioned.
//
// The conditional half is where the care is. This Lambda cannot know whether the
// repo is CD-registered (no repo on the wire, no registry, no workflows table),
// and the legacy DEPLOY.md ship path legitimately ships with no pipeline
// execution at all. So the execution id is required UNLESS the run is *provably*
// legacy: no pipeline_name argument AND a definite 404 on the run's cd-ledger.
// An indeterminate S3 answer (AccessDenied, throttle, timeout) is NOT proof and
// therefore refuses — DL-028's rule, "the licence to proceed must be positive
// evidence". Refusing costs a human gate ticket; accepting silently claims a
// deploy that may never have happened.
const CD_LEDGER_KEY = "workflows/wf_1/shared/cd-ledger.json";

describe("report_completion — ship-report contract (pipeline_execution_id / pipeline_name)", () => {
  it("(1) refuses shipped with no pipeline_execution_id, writing nothing and transitioning nothing", async () => {
    // Two ways the pipeline path is known to have been used: the caller named the
    // pipeline, or the run's cd-ledger exists. Both make the id mandatory.
    const cases = [
      { pipeline_name: PIPELINE },
      { ledger: true },
    ];
    for (const c of cases) {
      h.puts.length = 0;
      h.invokes.length = 0;
      h.calls.length = 0;
      h.objects.clear();
      if (c.ledger) h.objects.set(CD_LEDGER_KEY, JSON.stringify({ execution_id: EXEC_ID }));
      const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, ...(c.pipeline_name ? { pipeline_name: PIPELINE } : {}) }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
      expect(r.missing).toEqual(["pipeline_execution_id"]);
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    }
  });

  it("(2) refuses shipped with no merge_commit, writing nothing and transitioning nothing", async () => {
    const r = result(await report({ outcome: "shipped", pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
    expect(r.missing).toEqual(["merge_commit"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("(3) accepts shipped with both, storing them and transitioning the ticket", async () => {
    const res = await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE });
    expect(result(res).status).toBe("complete");
    const r = record();
    expect(r.pipeline_execution_id).toBe(EXEC_ID);
    expect(r.pipeline_name).toBe(PIPELINE);
    expect(r.merge_commit).toBe(MERGE_COMMIT);
    expect(r.outcome).toBe("shipped");
    expect(transitioned()).toBe(true);
  });

  it("(3b) trims and lowercases an execution id, and drops an oversized pipeline_name", async () => {
    await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: `  ${EXEC_ID.toUpperCase()}  `, pipeline_name: "p".repeat(129) });
    const r = record();
    expect(r.pipeline_execution_id).toBe(EXEC_ID);
    expect("pipeline_name" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/oversized pipeline_name/);
  });

  it("(4) refuses handoff with no pr_url, transitioning nothing", async () => {
    for (const extra of [{}, { pr_url: "   " }]) {
      h.puts.length = 0;
      h.invokes.length = 0;
      h.calls.length = 0;
      const r = result(await report({ outcome: "handoff", ...extra }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("handoff_requires_pr_url");
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
    }
    // …and accepts it the moment the PR exists.
    const res = await report({ outcome: "handoff", pr_url: PR_URL });
    expect(result(res).status).toBe("complete");
    expect(record().outcome).toBe("handoff");
  });

  it("(5) accepts the legacy DEPLOY.md ship: no pipeline_name, cd-ledger definitively absent", async () => {
    // THE regression that must not break: a registered repo with no CodePipeline
    // ships via DEPLOY.md and has no execution id to report, ever.
    const res = await report({ outcome: "shipped", merge_commit: MERGE_COMMIT });
    expect(result(res).status).toBe("complete");
    const r = record();
    expect(r.outcome).toBe("shipped");
    expect("pipeline_execution_id" in r).toBe(false);
    expect(transitioned()).toBe(true);
    // The licence came from a real probe, not from an assumption.
    expect(h.heads.map((x) => x.Key)).toContain(CD_LEDGER_KEY);
  });

  it("(5b) a NoSuchKey-flavoured 404 is the same positive evidence as NotFound", async () => {
    const err = new Error("The specified key does not exist.");
    err.name = "NoSuchKey";
    h.headError = err;
    expect(result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT })).status).toBe("complete");
  });

  it("(6) refuses when the cd-ledger probe is indeterminate (AccessDenied), not just when it finds a ledger", async () => {
    const err = new Error("Access Denied");
    err.name = "AccessDenied";
    err.$metadata = { httpStatusCode: 403 };
    h.headError = err;
    const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
    expect(r.missing).toEqual(["pipeline_execution_id"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/indeterminate/);
  });

  it("(7) deploy-blocked and static-ci-only still succeed, and log DEPRECATED (DL-030)", async () => {
    for (const oc of ["deploy-blocked", "static-ci-only"]) {
      h.puts.length = 0;
      h.warns.length = 0;
      h.invokes.length = 0;
      h.calls.length = 0;
      const res = await report({ outcome: oc, block_reason: "pipeline stage Deploy failed" });
      expect(result(res).status).toBe("complete");
      expect(record().outcome).toBe(oc);
      expect(transitioned()).toBe(true);
      expect(h.warns.join("\n")).toContain(`[report_completion] DEPRECATED outcome ${oc} (DL-030)`);
    }
  });

  it("(8) a malformed execution id is dropped with a warning — and for shipped that counts as missing", async () => {
    // Not stored on a non-ship report…
    await report({ pipeline_execution_id: "not-a-pipeline-execution-id" });
    expect("pipeline_execution_id" in record()).toBe(false);
    expect(h.warns.join("\n")).toMatch(/malformed pipeline_execution_id/);
    // …and a shipped report that supplied only that is refused, because a mangled
    // id reads as proof of a deploy nobody can look up.
    h.puts.length = 0;
    h.invokes.length = 0;
    h.calls.length = 0;
    const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_name: PIPELINE, pipeline_execution_id: EXEC_ID.replace("b", "z") }));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["pipeline_execution_id"]);
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("(9) a record written without the new fields keeps exactly the pre-4706 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    // Blank values are the same as absent — no keys, no warnings.
    h.puts.length = 0;
    h.warns.length = 0;
    await report({ pipeline_execution_id: "  ", pipeline_name: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    expect(h.warns.join("\n")).not.toMatch(/pipeline_/);
  });
});

// ─── TEAM-4740 FR-14: delivery.prState ────────────────────────────────────────
//
// Every completion record now says what happened to the PR. It is DERIVED from the
// report — this Lambda has no GitHub token and no client, deliberately, because
// every agent can invoke it — so the contract is narrow on purpose: "merged" only
// when the report names a merge commit or claims `shipped`, "open" when there is a
// PR, and "unknown" otherwise. A derived state can lag reality by one merge; the
// thing it must never do is LEAD it, which is why absence maps to unknown rather
// than to "open".
describe("report_completion — FR-14 delivery.prState", () => {
  it("derives merged / open / unknown, and puts delivery on EVERY record", async () => {
    const cases = [
      [{ merge_commit: MERGE_COMMIT }, "merged", null],
      [{ outcome: "shipped", merge_commit: MERGE_COMMIT }, "merged", null],
      // A ship with a PR still reads merged: the merge commit is the stronger claim.
      [{ merge_commit: MERGE_COMMIT, pr_url: PR_URL }, "merged", PR_URL],
      [{ pr_url: PR_URL }, "open", PR_URL],
      [{}, "unknown", null],
      // A blank PR url is the same as absent, here as everywhere else.
      [{ pr_url: "   " }, "unknown", null],
    ];
    for (const [extra, prState, prUrl] of cases) {
      h.puts.length = 0;
      await report(extra);
      expect(record().delivery, JSON.stringify(extra)).toEqual({ prUrl, prState });
    }
  });

  it("emits a delivery.prState event of its own, beside workflow.report_completion", async () => {
    // A separate event, not a field on the completion event: the delivery view
    // reads prState per TICKET and a run has many completions.
    await report({ pr_url: PR_URL });
    expect(events("workflow.report_completion")).toHaveLength(1);
    const [ev] = events("delivery.prState");
    expect(ev.workflowId).toBe("wf_1");
    expect(ev.detail).toEqual({
      workflowId: "wf_1",
      ticketId: "TEAM-4200",
      prUrl: PR_URL,
      prState: "open",
      observedAt: record().completed_at,
    });
  });

  it("a refused report emits NO delivery event and writes no record", async () => {
    // The FR-14 stamp is downstream of the DL-030 gate, so a refusal cannot leak a
    // delivery claim for a completion that did not happen.
    expect(result(await report({ outcome: "handoff" })).reason).toBe("handoff_requires_pr_url");
    expect(events("delivery.prState")).toHaveLength(0);
    expect(wroteRecord()).toBe(false);
  });
});

// ─── TEAM-4740 FR-13: follow_ups ──────────────────────────────────────────────
//
// The failure this exists to remove: a run ends with real work still outstanding —
// a post-deploy re-check, an IAM step only a human can do, a hub-infra commit that
// still needs its own PR to main — recorded only in the summary prose. The epic
// closes GREEN and the work evaporates.
//
// So a report may hand that work on as STRUCTURE, and each surviving entry becomes
// one ticket under the epic, blocked on the CD ticket. Two rules shape every test
// below. (1) The vocabulary is CLOSED and the caps are hard: an entry that does not
// fit is dropped and REPORTED, never stored half-understood. (2) The fail direction
// is always "complete anyway" — a completion must never be held hostage by its own
// bookkeeping, so every materialization failure is a value on the response and the
// ticket still transitions.
const FU = (extra) => JSON.stringify([{ kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Document the new flag", ...extra }]);
/** The CD ticket of the run — the sibling whose assignee owns the ship phase. */
/**
 * TEAM-5162: a test that wipes the fake ticket system to model a FRESH world must wipe
 * the follow-up create claims too — they are S3 state, and a surviving `created` claim
 * is (correctly) what dedupes the same follow-up on the next report.
 */
const clearFollowUpClaims = () => {
  for (const k of [...h.objects.keys()]) if (k.startsWith("completion-followups/")) h.objects.delete(k);
};
const CD = ticketRow({ key: "TEAM-4199", summary: "Ship it", assignee: "agentcore_hub_release_manager", created: "2026-09-17T10:00:00.000Z" });

describe("report_completion — FR-13 follow_ups: the record and the response", () => {
  it("stores the surviving entries on the record and materializes one ticket each", async () => {
    h.siblings.push(CD);
    const res = result(await report({ follow_ups: FU() }));
    const r = record();
    expect(r.followUps).toHaveLength(1);
    expect(r.followUps[0]).toEqual({
      kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev",
      title: "Document the new flag", detail: "",
      hash: followUpHash("TEAM-4200", "docs", "Document the new flag"),
    });
    expect(h.created).toHaveLength(1);
    const p = h.created[0].params;
    expect(p.summary).toBe(`Document the new flag [fu:${r.followUps[0].hash}]`);
    expect(p.parent_key).toBe("TEAM-4100");
    expect(p.blocked_by).toEqual(["TEAM-4199"]);
    expect(p.description.startsWith(followUpBanner("TEAM-4200"))).toBe(true);
    // The completion is a completion: still ok, still transitioned.
    expect(res.status).toBe("complete");
    expect(res.followUpsMaterialized.created).toEqual([{
      ticketId: "TEAM-4901", hash: r.followUps[0].hash, kind: "docs",
      title: "Document the new flag", assignee: "agentcore_hub_api_dev", blockedBy: ["TEAM-4199"],
    }]);
    expect(transitioned()).toBe(true);
  });

  it("clamps title to 120 and detail to 1000, and flattens newlines out of the title", async () => {
    h.siblings.push(CD);
    await report({ follow_ups: JSON.stringify([{ kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: `A\nvery ${"long ".repeat(40)}title`, detail: "d".repeat(2000) }]) });
    const [fu] = record().followUps;
    expect(fu.title).toHaveLength(120);
    expect(fu.title).not.toMatch(/\n/);
    expect(fu.detail).toHaveLength(1000);
  });

  it("keeps a valid baseBranch and omits — but does not drop the ENTRY for — an invalid one", async () => {
    h.siblings.push(CD);
    await report({ follow_ups: FU({ baseBranch: "release/2026.09" }) });
    expect(record().followUps[0].baseBranch).toBe("release/2026.09");
    expect(h.created[0].params.base_branch).toBe("release/2026.09");

    // An unusable branch name loses the FIELD only: the work is still real, it just
    // has no stated target — exactly a pre-FR-12 ticket.
    h.puts.length = 0;
    h.created.length = 0;
    h.siblings.length = 0;
    clearFollowUpClaims();
    h.siblings.push(CD);
    await report({ follow_ups: FU({ baseBranch: "-bad..name/" }) });
    const [fu] = record().followUps;
    expect("baseBranch" in fu).toBe(false);
    expect("base_branch" in h.created[0].params).toBe(false);
    expect(h.warns.join("\n")).toMatch(/dropping invalid baseBranch/);
  });

  it("an absent follow_ups arg leaves the record at exactly the base key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    // …and the response carries neither of the two additive keys.
    const res = result(await report({}));
    expect("droppedFollowUps" in res).toBe(false);
    expect("followUpsMaterialized" in res).toBe(false);
  });
});

describe("report_completion — FR-13 the closed vocabulary and the SEC-11 caps", () => {
  it("unparseable JSON drops the whole arg — additively, and never as a refusal", async () => {
    // THE regression: a malformed hint is not a false claim, so it must not refuse.
    // The record it produces has to be byte-identical to one written without the arg.
    // Byte-for-byte, with only the wall-clock stamp normalized.
    const body = () => h.puts.find((p) => p.Key?.startsWith("completions/")).Body.replace(/"completed_at": "[^"]+"/, '"completed_at": "T"');
    await report({});
    const clean = body();
    for (const raw of ["{not json", '{"kind":"docs"}', "[[", "null", "42"]) {
      h.puts.length = 0;
      h.created.length = 0;
      const res = result(await report({ follow_ups: raw }));
      expect(res.status, raw).toBe("complete");
      expect(body(), raw).toBe(clean);
      expect(res.droppedFollowUps, raw).toEqual([{ reason: "unparseable" }]);
      expect(h.created, raw).toHaveLength(0);
      expect(transitioned(), raw).toBe(true);
    }
  });

  it("an oversized arg is dropped whole, reporting the byte count it exceeded", async () => {
    const huge = JSON.stringify([{ kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "T", detail: "x".repeat(9000) }]);
    const res = result(await report({ follow_ups: huge }));
    expect(res.status).toBe("complete");
    expect(res.droppedFollowUps[0].reason).toBe("oversized");
    expect(res.droppedFollowUps[0].bytes).toBeGreaterThan(8 * 1024);
    expect("followUps" in record()).toBe(false);
    expect(h.created).toHaveLength(0);
  });

  it("drops an unknown kind, an unknown owner and an owner/kind contradiction — each with its reason", async () => {
    h.siblings.push(CD);
    const res = result(await report({
      follow_ups: JSON.stringify([
        { kind: "vibes", owner: "agent", title: "Something" },
        { kind: "docs", owner: "robot", title: "Something else" },
        // A console handoff no human owns is a contradiction, not a typo: forcing
        // either direction would file the work with the wrong actor and gate.
        { kind: "console_handoff", owner: "agent", title: "Flip the flag" },
        { kind: "fix", owner: "human", title: "Fix the thing" },
        { kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "The one good entry" },
      ]),
    }));
    expect(res.droppedFollowUps.map((d) => [d.index, d.reason])).toEqual([
      [0, "unknown_kind"], [1, "unknown_owner"], [2, "owner_kind_mismatch"], [3, "owner_kind_mismatch"],
    ]);
    expect(record().followUps.map((f) => f.title)).toEqual(["The one good entry"]);
    expect(h.created).toHaveLength(1);
  });

  it("drops a titleless entry, a non-object entry and a duplicate (kind,title)", async () => {
    h.siblings.push(CD);
    const res = result(await report({
      follow_ups: JSON.stringify([
        "just a string",
        { kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "   " },
        { kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Write it up" },
        { kind: "docs", owner: "agent", assignee: "agentcore_hub_backend_dev", title: " Write it up " },
      ]),
    }));
    expect(res.droppedFollowUps.map((d) => d.reason)).toEqual(["not_an_object", "missing_title", "duplicate"]);
    expect(h.created).toHaveLength(1);
  });

  it("caps at 5 entries, keeping the first five VALID ones", async () => {
    h.siblings.push(CD);
    const entries = [
      { kind: "docs", owner: "nobody", title: "junk first" },
      ...Array.from({ length: 7 }, (_, i) => ({ kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: `Entry ${i}` })),
    ];
    const res = result(await report({ follow_ups: JSON.stringify(entries) }));
    // The cap counts entries that PASSED validation, so junk never displaces a good
    // entry — the first item above is dropped for its owner, not counted.
    expect(record().followUps.map((f) => f.title)).toEqual(["Entry 0", "Entry 1", "Entry 2", "Entry 3", "Entry 4"]);
    expect(res.droppedFollowUps.map((d) => d.reason)).toEqual(["unknown_owner", "over_entry_cap", "over_entry_cap"]);
    expect(h.created).toHaveLength(5);
  });

  it("forces the assignee per kind, and refuses a fix aimed at a non-dev persona", async () => {
    h.siblings.push(CD);
    const res = result(await report({
      follow_ups: JSON.stringify([
        // Forced: the queue this work lands in is not the caller's call.
        { kind: "post_deploy_verification", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Re-check /health" },
        { kind: "iam_handoff", owner: "human", assignee: "agentcore_hub_operator", title: "Grant AccessAnalyzer" },
        // Restricted: a release manager can't land a code fix, so the ENTRY goes.
        { kind: "fix", owner: "agent", assignee: "agentcore_hub_release_manager", title: "Repair the parser" },
        { kind: "fix", owner: "agent", title: "No assignee at all" },
      ]),
    }));
    expect(record().followUps.map((f) => [f.kind, f.assignee])).toEqual([
      ["post_deploy_verification", "agentcore_hub_qa_verifier"],
      ["iam_handoff", "human:engineer"],
    ]);
    expect(res.droppedFollowUps.map((d) => [d.reason, d.assignee])).toEqual([
      ["invalid_assignee", "agentcore_hub_release_manager"],
      ["invalid_assignee", null],
    ]);
  });
});

describe("report_completion — FR-13 materialization", () => {
  it("stamps an agent-owned entry as a real fix ticket, and a human one as a plain task", async () => {
    h.siblings.push(CD);
    await report({
      follow_ups: JSON.stringify([
        { kind: "post_deploy_verification", owner: "agent", title: "Re-check /health after deploy" },
        { kind: "fix", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Repair the parser" },
        { kind: "console_handoff", owner: "human", title: "Enable the feature flag" },
      ]),
    });
    const [qa, fix, handoff] = h.created.map((c) => c.params);
    // The marker + phase stamp are what make the ticket GATE the epic
    // (completion.mjs rule (iii)); the origin is the CD ticket it waits on.
    expect(qa.spawned_by).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-4199" });
    expect(qa.phase).toBe("verification");
    expect(qa.assignee).toBe("agentcore_hub_qa_verifier");
    expect(fix.spawned_by).toEqual({ kind: "ship_fix", shipTicketId: "TEAM-4199" });
    expect(fix.phase).toBe("ship");
    // The only anchor this Lambda can cite honestly is the record that asked.
    expect(fix.fix_contract).toEqual({
      invariant: "Repair the parser", evidence_source: "static",
      cited_location: ["completions/TEAM-4200.json:1"], sibling_scope: "none",
    });
    // A human gate is already a first-class blocker; stamping it as a fix would
    // enrol it in rework loop-cap counters it has nothing to do with.
    expect("spawned_by" in handoff).toBe(false);
    expect("fix_contract" in handoff).toBe(false);
    expect("phase" in handoff).toBe(false);
    expect(handoff.assignee).toBe("human:engineer");
  });

  it("picks the NEWEST ship-phase sibling as the CD ticket, ignoring humans and itself", async () => {
    h.siblings.push(
      ticketRow({ key: "TEAM-4150", summary: "Old ship", assignee: "agentcore_hub_release_manager", created: "2026-09-16T08:00:00.000Z" }),
      ticketRow({ key: "TEAM-4198", summary: "Merge Approval", assignee: "human:engineer", created: "2026-09-17T09:30:00.000Z" }),
      CD,
      ticketRow({ key: "TEAM-4200", summary: "This very ticket", assignee: "agentcore_hub_release_manager", created: "2026-09-17T11:00:00.000Z" }),
    );
    await report({ follow_ups: FU() });
    expect(h.created[0].params.blocked_by).toEqual(["TEAM-4199"]);
  });

  it("creates the follow-up UNBLOCKED when the run has no CD ticket, or its CD ticket is done", async () => {
    // "Nothing to wait for" must not become "blocked on a guess": an unblocked
    // follow-up is workable, a follow-up blocked on the wrong ticket is a wedge.
    for (const siblings of [[], [ticketRow({ key: "TEAM-4199", summary: "Ship it", assignee: "agentcore_hub_release_manager", status: "Done" })]]) {
      h.created.length = 0;
      h.siblings.length = 0;
      clearFollowUpClaims();
      h.siblings.push(...siblings);
      const res = result(await report({ follow_ups: FU() }));
      expect("blocked_by" in h.created[0].params).toBe(false);
      expect(res.followUpsMaterialized.created[0].blockedBy).toEqual([]);
    }
  });

  it("is idempotent: a re-invocation of the same report creates nothing new", async () => {
    h.siblings.push(CD);
    await report({ follow_ups: FU() });
    expect(h.created).toHaveLength(1);
    // The [fu:<hash>] suffix in the summary is the marker, because list_tickets
    // returns summaries and the DynamoDB twin's formatter drops labels.
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created).toEqual([]);
    expect(res.followUpsMaterialized.skipped).toEqual([{
      hash: followUpHash("TEAM-4200", "docs", "Document the new flag"),
      kind: "docs", title: "Document the new flag", reason: "already_materialized",
      ticketId: "TEAM-4901", // TEAM-5129: carried from the prior record's created row
    }]);
  });

  // TEAM-4754 N2 — this test asserted the DEFECT in its own title: the completion
  // "still succeeded" and the ticket went Done on top of a follow-up that does not
  // exist. The record is still durable; what is withheld is the cascade.
  it("a create failure is reported per entry and WITHHOLDS the Done transition", async () => {
    h.siblings.push(CD);
    h.ticketFail.add("Tickets___create_ticket");
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(transitioned()).toBe(false);
    expect(res.followUpsMaterialized.created).toEqual([]);
    expect(res.followUpsMaterialized.failed[0].reason).toMatch(/unavailable/);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
    // The record still names the work, so nothing is lost but the transition.
    expect(wroteRecord()).toBe(true);
    expect(record().followUps).toHaveLength(1);
  });

  // TEAM-4752 D1 — this test asserted the DEFECT: it created the follow-up on a
  // roster it had failed to read. The dedupe set is built from that roster, so the
  // create was blind, and a redelivered report (the orchestrator retries) filed a
  // second copy of every entry — the exact duplicate FR-13's (ticketId, kind,
  // title) key exists to prevent.
  it("a failed sibling scan creates NOTHING — the record stands, the transition does not", async () => {
    h.siblings.push(CD);
    h.ticketFail.add("Tickets___list_tickets");
    const res = result(await report({ follow_ups: FU() }));
    // The completion record is durable — the work WAS done, and refusing the whole
    // report would throw that away. TEAM-4754 N2: the Done transition is what waits,
    // because it CASCADES and the follow-up it would cascade past does not exist.
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(wroteRecord()).toBe(true);
    expect(transitioned()).toBe(false);
    // The record still NAMES the work, so nothing is lost but the transition.
    expect(record().followUps).toHaveLength(1);
    // Nothing was created, and every entry says exactly why.
    expect(h.created).toHaveLength(0);
    expect(res.followUpsMaterialized.created).toEqual([]);
    expect(res.followUpsMaterialized.failed).toEqual([{
      hash: followUpHash("TEAM-4200", "docs", "Document the new flag"),
      kind: "docs", title: "Document the new flag", reason: "sibling_scan_failed", retryable: true, commentedOn: [],
    }]);
    expect(h.warns.join("\n")).toMatch(/sibling scan under TEAM-4100 FAILED/);
    expect(h.warns.join("\n")).toMatch(/a duplicate cannot be ruled out/);
    expect(h.warns.join("\n")).toMatch(/Done WITHHELD/);
  });

  it("retrying after a failed scan then materializes exactly once, and THEN goes Done", async () => {
    // What makes fail-closed safe: the persona is TOLD to retry, and the retry is
    // idempotent because the [fu:<hash>] dedupe now runs against a roster that is
    // either right or absent — never wrongly empty.
    h.siblings.push(CD);
    h.ticketFail.add("Tickets___list_tickets");
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete_pending_follow_ups");
    expect(h.created).toHaveLength(0);
    expect(transitioned()).toBe(false);
    h.ticketFail.delete("Tickets___list_tickets");
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created[0].blockedBy).toEqual(["TEAM-4199"]);
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
  });

  it("an unresolvable epic fails every entry rather than filing a parentless ticket, and still goes Done", async () => {
    // A ticket with no parent is invisible to the run: it gates nothing and shows
    // up in no phase, so telling the agent beats filing it. TEAM-4754 N2: this is
    // the ONE non-retryable reason — get_issue ANSWERED and the answer was "no
    // parent", so no retry can produce an epic and withholding Done would strand
    // finished work forever.
    h.issue = ticketRow({ key: "TEAM-4200", parent: null });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect("next_action" in res).toBe(false);
    expect(transitioned()).toBe(true);
    expect(h.created).toHaveLength(0);
    expect(res.followUpsMaterialized.failed.map((f) => f.reason)).toEqual(["epic_unresolved"]);
    expect(res.followUpsMaterialized.failed.map((f) => f.retryable)).toEqual([false]);
    expect(calls("Tickets___list_tickets")).toHaveLength(0);
  });

  it("reads the ticket once and reuses it for both the base_branch check and the epic", async () => {
    h.siblings.push(CD);
    await report({ follow_ups: FU() });
    expect(calls("Tickets___get_issue")).toEqual([{ ticket_id: "TEAM-4200" }]);
  });

  it("skips the get_issue for a SYNTHETIC id — the only report with no ticket to read", async () => {
    // TEAM-4752 D3 removed the other short-circuit. A report that carries a PR used
    // to skip the read, which is exactly the report FR-5 has to inspect: the base
    // branch lives only on the ticket, so "it carries a PR" cannot be the reason not
    // to look at which branch that PR targets.
    await report({ pr_url: PR_URL });
    expect(calls("Tickets___get_issue")).toHaveLength(1);
    // A synthetic id has no ticket at all, so it still costs nothing.
    await handler({ tool_name: "WorkflowOutput___report_completion", arguments: { ticket_id: "HEALTHCHECK-1", summary: "ping", workflow_id: "wf_1" } });
    expect(calls("Tickets___get_issue")).toHaveLength(1);
    await handler({ tool_name: "WorkflowOutput___report_completion", arguments: { ticket_id: "TEST-1", summary: "ping", workflow_id: "wf_1" } });
    expect(calls("Tickets___get_issue")).toHaveLength(1);
  });
});

// ─── TEAM-4754 N2: a failed follow-up write withholds the Done transition ───────
//
// TEAM-4752 D2 moved materialization BEFORE the transition. That fixed the order
// and left the hole one step down: the transition happened anyway. For the run's
// LAST ticket (the CD ticket) that means the create throws, the ticket goes Done,
// the orchestrator's isWorkflowComplete rolls the epic to complete, and the
// follow-up never exists — with the only trace in a nested `failed[]` nothing
// reads. So the transition is now a CONSEQUENCE of the dependent write, not a
// sibling of it.
describe("report_completion — N2: a retryable follow-up failure withholds Done", () => {
  const TWO = JSON.stringify([
    { kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Document the new flag" },
    { kind: "post_deploy_verification", owner: "agent", title: "Re-check /health after deploy" },
  ]);

  it("1 of 2 created, the second fails: pending, no transition — and the retry files exactly the missing one", async () => {
    // The whole point of withholding rather than refusing: the first create is
    // durable, so the retry must NOT duplicate it. That is the `[fu:<8hex>]` dedupe
    // running against a roster the create itself appended to.
    h.siblings.push(CD);
    h.createGate = (p) => !/health/.test(p.summary);
    const first = result(await report({ follow_ups: TWO }));
    expect(first.status).toBe("complete_pending_follow_ups");
    expect(first.next_action).toBe("retry_report_completion");
    expect(first.message).toMatch(/was NOT transitioned to Done/);
    expect(first.message).toMatch(/SAME arguments/);
    expect(wroteRecord()).toBe(true);
    expect(transitioned()).toBe(false);
    expect(first.followUpsMaterialized.created).toHaveLength(1);
    expect(first.followUpsMaterialized.failed).toHaveLength(1);
    expect(first.followUpsMaterialized.failed[0].kind).toBe("post_deploy_verification");
    expect(first.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(h.created).toHaveLength(1);
    // TEAM-4754: the UI marks the agent's card done off this event, and
    // cost-report/anomaly-watcher treat it as terminal — none of that is true
    // yet, so it must not fire while the ticket is still open. delivery.prState
    // states a fact the durable record already carries, so it is unaffected.
    expect(events("workflow.report_completion")).toHaveLength(0);
    expect(events("delivery.prState")).toHaveLength(1);
    // TEAM-4756 R3-2: and the record SAYS so, which is the whole contract — the
    // twins' DL-030 guard is existence-only, so a record that does not state this is
    // indistinguishable from a finished one and licenses a direct done.
    expect(record().followUpsPending).toBe(true);
    expect(record().status).toBe("complete_pending_follow_ups");
    // TEAM-5123 W1: the per-entry outcomes are PERSISTED, not only answered.
    expect(record().followUpsMaterialized).toEqual(first.followUpsMaterialized);

    // The retry, with the SAME arguments the message told the agent to send.
    h.puts.length = 0;
    h.putAtCall.length = 0; // kept in lockstep with h.puts - they are index-aligned
    h.createGate = null;
    const res = result(await report({ follow_ups: TWO }));
    expect(h.created).toHaveLength(2); // exactly ONE more
    expect(res.followUpsMaterialized.created.map((c) => c.kind)).toEqual(["post_deploy_verification"]);
    expect(res.followUpsMaterialized.skipped.map((s) => [s.kind, s.reason])).toEqual([["docs", "already_materialized"]]);
    expect(res.followUpsMaterialized.failed).toEqual([]);
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    // The retry is what finally gets the ticket to Done, so this is the ONE call
    // that publishes the event.
    expect(events("workflow.report_completion")).toHaveLength(1);
    expect(events("delivery.prState")).toHaveLength(2);
    // …and the record is no longer provisional. `h.puts` was cleared above, so this
    // reads the RETRY's record, not the first attempt's.
    expect(record().followUpsPending).toBe(false);
    expect(record().status).toBe("complete");
  });

  it("the outer catch also withholds it — a THROW is not a licence to cascade", async () => {
    // Reaches reportCompletion's own try/catch (not ticketTool's) by throwing a
    // non-Error; see the createGate note in the Lambda mock.
    h.siblings.push(CD);
    h.createGate = () => null;
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    expect(wroteRecord()).toBe(true);
    expect(res.followUpsMaterialized.failed).toHaveLength(1);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(h.warns.join("\n")).toMatch(/materialization threw/);
    expect(h.warns.join("\n")).toMatch(/the record STANDS but the ticket is NOT transitioned/);
  });

  it("an UNREADABLE ticket is ticket_unreadable, not epic_unresolved — and holds the transition", async () => {
    // The distinction D1 already drew for empty_sweep. "The ticket says it has no
    // parent" is a definite negative; "we could not read the ticket" is a transient
    // failure that must not be spelled the same way.
    h.ticketFail.add("Tickets___get_issue");
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(transitioned()).toBe(false);
    expect(h.created).toHaveLength(0);
    expect(res.followUpsMaterialized.failed.map((f) => f.reason)).toEqual(["ticket_unreadable"]);
    expect(res.followUpsMaterialized.failed.map((f) => f.retryable)).toEqual([true]);
    // No epic ⇒ nothing to scan; and mainFixRefusal returns null on a null issue,
    // so nothing refused the report before this point.
    expect(calls("Tickets___list_tickets")).toHaveLength(0);
    expect(h.warns.join("\n")).toMatch(/its epic \(parent\) is UNKNOWN/);
  });

  it("a report with no follow_ups is byte-identical to pre-4754", async () => {
    const res = result(await report({}));
    expect(Object.keys(res).sort()).toEqual(["message", "status"]);
    expect(res.status).toBe("complete");
    expect(res.message).toBe("Completion saved for TEAM-4200. Ticket transitioned to Done.");
    expect(transitioned()).toBe(true);
    // TEAM-4756: the RESPONSE stays byte-identical — the two new states are the only
    // thing 4756 adds to it, and neither applies here. The RECORD gains exactly two
    // keys, both stating the uneventful answer.
    expect(record().followUpsPending).toBe(false);
    expect(record().status).toBe("complete");
  });

  it("follow-ups that ALL land are also unchanged: complete, no next_action, Done", async () => {
    h.siblings.push(CD);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect("next_action" in res).toBe(false);
    expect(res.message).toBe("Completion saved for TEAM-4200. Ticket transitioned to Done.");
    expect(res.followUpsMaterialized.failed).toEqual([]);
    expect(transitioned()).toBe(true);
  });
});

// ─── TEAM-4756 R3-1: a failed Done transition is not "complete" ────────────────
//
// The same rule N2 applied to the follow-up write, applied to the LAST dependent
// write: a transition that did not happen must not be reported as one that did. The
// raw invoke this replaces read only `payload.error` — the one failure shape the
// DynamoDB twin never uses — and both of its failure branches fell through to
// `status: "complete"`. That answer is load-bearing: the harness's completion gate
// (deploy/runtime-agent/main.py `_reports_done`) treats exactly "complete" as done and
// deletes the resume object, so a swallowed refusal left the ticket in_progress with
// no live session and nothing owning the work.
//
// Every test below therefore asserts on the STATUS, not on a log line: a CloudWatch
// console.error is precisely what the old code already did, and it changed nothing.
describe("report_completion — R3-1: a refused or failed Done transition", () => {
  /** Every transition the call attempted, in order. */
  const dones = () => calls("Tickets___transition_ticket").filter((p) => p.transition_id === "done");

  it("an invoke THROW is complete_transition_failed — and the retry closes the ticket", async () => {
    // The throttle/timeout case: `lambda.send` rejects, which the old catch logged and
    // then reported as a success.
    h.transitionGate = () => { throw new Error("TooManyRequestsException: Rate exceeded"); };
    const first = result(await report({}));
    expect(first.status).not.toBe("complete");
    expect(first.status).toBe("complete_transition_failed");
    expect(first.next_action).toBe("retry_report_completion");
    expect(first.transition).toEqual({ ok: false, error: expect.stringContaining("Rate exceeded") });
    expect(first.message).toMatch(/SAME arguments/);
    expect(first.message).toMatch(/report BLOCKED/);
    // The record IS durable — that is what makes the retry cheap and what the message
    // promises the agent.
    expect(wroteRecord()).toBe(true);
    expect(dones()).toHaveLength(1);

    // The retry, with the SAME arguments the message told the agent to send.
    h.transitionGate = null;
    const res = result(await report({}));
    expect(res.status).toBe("complete");
    expect(Object.keys(res).sort()).toEqual(["message", "status"]);
    // Exactly one Done attempt per invocation — the retry does not double-transition.
    expect(dones()).toHaveLength(2);
  });

  it("a FunctionError is a failure, not a success", async () => {
    h.transitionGate = () => ({ errorMessage: "Task timed out after 60.00 seconds" });
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    expect(res.transition.error).toMatch(/timed out/);
  });

  it("the twin's already-done refusal is idempotent SUCCESS, not a failure", async () => {
    // The retry path's own footgun: the first attempt DID close the ticket and only its
    // reply was lost, so the twin now refuses the second `done`. Reporting that as a
    // failure would loop the persona forever on a ticket that is already closed.
    h.transitionGate = () => 'Invalid transition "done" from status "done". Available: reopen (→ todo)';
    const res = result(await report({}));
    expect(res.status).toBe("complete");
    expect("transition" in res).toBe(false);
    expect(Object.keys(res).sort()).toEqual(["message", "status"]);
    expect(h.warns.join("\n")).not.toMatch(/transition FAILED/);
    // Recognized from the refusal text alone — no second read needed.
    expect(calls("Tickets___get_issue")).toHaveLength(1);
  });

  it("a DL-030 refusal is a failure even though it never says \"Error:\"", async () => {
    // The shape the old toolFailure returned null for: the DynamoDB twin RETURNS this,
    // with the machine-readable `ok:false` beside the prose. Reported as "complete", it
    // meant a ship ticket whose record the twin could not see closed the run anyway.
    h.transitionGate = () => ({
      ok: false,
      reason: "completion_record_required",
      content: [{ type: "text", text: "Cannot move TEAM-4200 to done: a ship-phase ticket needs its completion record first — call WorkflowOutput___report_completion(ticket_id=…) (no completions/TEAM-4200.json in the artifact bucket)" }],
    });
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    expect(res.transition.error).toMatch(/needs its completion record first/);
  });

  it("the typed-gate refusal is a failure too — prose the classifier cannot know", async () => {
    // Same structured shape, arbitrary hint text: `ok:false` is what catches it, which
    // is why the classifier keys on that rather than on a growing list of prefixes.
    h.transitionGate = () => ({
      ok: false,
      reason: "gate_condition_unmet",
      content: [{ type: "text", text: "The deploy approval for exec 1234 is still parked; this gate cannot close against it." }],
    });
    expect(result(await report({})).status).toBe("complete_transition_failed");
  });

  it("a Jira-style AMBIGUOUS refusal re-reads the ticket: Done ⇒ complete", async () => {
    // 'No transition to "Done" found' is the same text a stuck ticket and an
    // already-closed ticket both produce, so there is nothing to match on — ask the
    // ticket instead of parsing the prose.
    h.issue = ticketRow({ key: "TEAM-4200", summary: "The ticket under report", status: "done" });
    h.transitionGate = () => ({ error: 'No transition to "Done" found. Available: Start Progress (-> In Progress)' });
    const res = result(await report({}));
    expect(res.status).toBe("complete");
    // The up-front read plus the re-read.
    expect(calls("Tickets___get_issue")).toHaveLength(2);
  });

  it("…and the same refusal with the ticket still in_progress stays FAILED", async () => {
    h.issue = ticketRow({ key: "TEAM-4200", summary: "The ticket under report", status: "in_progress" });
    h.transitionGate = () => ({ error: 'No transition to "Done" found. Available: Start Progress (-> In Progress)' });
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    expect(calls("Tickets___get_issue")).toHaveLength(2);
  });

  it("an UNREADABLE re-read stays FAILED — \"we could not look\" is not \"it is done\"", async () => {
    // The same positive-evidence rule completionRecordProven applies: only an answer
    // the twin actually gave may license the success.
    h.ticketFail.add("Tickets___get_issue");
    h.transitionGate = () => ({ error: 'No transition to "Done" found. Available: Start Progress (-> In Progress)' });
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    expect(h.warns.join("\n")).toMatch(/could not re-read the ticket/);
  });

  it("the TERMINAL journey event fires only once the ticket is actually Done", async () => {
    // The UI's done card, cost-report's duration and compute_metrics' TERMINAL_TASK_EVENTS
    // all read workflow.report_completion as "this ticket's work ended". Publishing it
    // before a transition that then fails is the same falsehood N2 removed.
    h.transitionGate = () => { throw new Error("TooManyRequestsException: Rate exceeded"); };
    await report({});
    expect(events("workflow.report_completion")).toHaveLength(0);
    // delivery.prState is NOT terminal — it states a fact the durable record already
    // carries — so it is unaffected, exactly as in the pending case.
    expect(events("delivery.prState")).toHaveLength(1);

    h.transitionGate = null;
    await report({});
    expect(events("workflow.report_completion")).toHaveLength(1);
    expect(events("delivery.prState")).toHaveLength(2);
  });

  it("a SYNTHETIC id has no transition to wait for, so it still announces itself", async () => {
    // The healthcheck path: no ticket, so no transition — the report itself is terminal.
    const res = result(await report({ ticket_id: "HEALTHCHECK-1" }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(false);
    expect(events("workflow.report_completion")).toHaveLength(1);
  });
});

// ─── TEAM-4756 R3-1: the ONE failure classifier ───────────────────────────────
//
// Both twins are exercised through the handler above; this pins the classifier
// directly because the shapes are the whole bug and a table says which is which.
describe("toolFailure — every failure shape both twins actually produce", () => {
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  it("detects all of them", () => {
    // jira twin: the handler turns every throw into `{error}` (plus the structured
    // refusal keys when there are any).
    expect(toolFailure({ error: "Jira API 400: bad request" })).toMatch(/Jira API 400/);
    expect(toolFailure({ ok: false, reason: "completion_record_required", error: "Cannot move X to done: …" })).toBeTruthy();
    expect(toolFailure({ errorMessage: "Task timed out after 60.00 seconds" })).toMatch(/timed out/);
    // DynamoDB twin, STRUCTURED: `ok:false` with the prose in content.
    expect(toolFailure({ ok: false, reason: "gate_condition_unmet", ...text("anything at all") })).toBe("anything at all");
    // …and with no content at all, the reason is still an answer.
    expect(toolFailure({ ok: false, reason: "gate_condition_unmet" })).toBe("gate_condition_unmet");
    expect(toolFailure({ ok: false })).toBe("refused");
    // DynamoDB twin, BARE textResults.
    expect(toolFailure(text("Error: 'issue_key' is required"))).toMatch(/issue_key/);
    expect(toolFailure(text("Issue TEAM-1 not found."))).toMatch(/not found/);
    // The two TEAM-4756 additions — neither starts "Error:" nor ends "not found.".
    expect(toolFailure(text('Invalid transition "done" from status "done". Available: reopen (→ todo)'))).toMatch(/^Invalid transition/);
    expect(toolFailure(text('Invalid transition "skip" from status "in_progress". Available: done (→ done)'))).toMatch(/^Invalid transition/);
    expect(toolFailure(text("Cannot move TEAM-1 to in_review: only human-review tickets (assignee \"human:*\") can be sent to review."))).toMatch(/^Cannot move/);
    expect(toolFailure(text("Cannot move TEAM-1 to done: a ship-phase ticket needs its completion record first — …"))).toMatch(/^Cannot move/);
    // Absent / unparseable is a failure, not a silent success.
    expect(toolFailure(null)).toBe("empty response");
    expect(toolFailure("nope")).toBe("empty response");
  });

  it("and calls a real success a success", () => {
    expect(toolFailure({ ok: true })).toBeNull();
    expect(toolFailure({ key: "TEAM-1", status: "created" })).toBeNull();
    expect(toolFailure(text("Transitioned TEAM-1 to done"))).toBeNull();
    expect(toolFailure({ total: 0, issues: [] })).toBeNull();
    // A ROW that merely mentions a not-found-ish summary is not a failure: the match is
    // anchored at the end of the text, as it always was.
    expect(toolFailure(text("Moved TEAM-1: the not found. banner was removed from the page"))).toBeNull();
  });

  it("isAlreadyDoneRefusal matches both spellings and NOT Jira's ambiguous one", () => {
    expect(isAlreadyDoneRefusal('Invalid transition "done" from status "done". Available: reopen (→ todo)')).toBe(true);
    expect(isAlreadyDoneRefusal('Invalid transition from "done" to "done"')).toBe(true);
    // Jira's refusal is the SAME text a genuinely stuck ticket produces, so it proves
    // nothing about the current status and must stay a failure here — the ticket re-read
    // is what covers that provider.
    expect(isAlreadyDoneRefusal('No transition to "Done" found. Available: Start Progress (-> In Progress)')).toBe(false);
    expect(isAlreadyDoneRefusal('Invalid transition "done" from status "in_progress"')).toBe(false);
    expect(isAlreadyDoneRefusal(null)).toBe(false);
  });
});

// ─── TEAM-4756 R3-2: the record states followUpsPending and status ─────────────
//
// N2 made the TOOL's answer honest about a pending follow-up, but the record it wrote
// said nothing. Both twins' DL-030 guard (`completionRecordProven`) is existence-only —
// a HeadObject — so a `complete_pending_follow_ups` record satisfied it exactly as well
// as a finished one, and a direct `Tickets___transition_ticket(done)` on that ticket
// closed the run over follow-ups that were never filed. The record is the only artefact
// that guard can see, so the record has to carry the answer.
//
// THE INVARIANT, at every instant: a record that exists with `followUpsPending !== true`
// means every RETRYABLE follow-up is materialized. The tests below are that invariant
// read from both ends — the value, and the ordering that makes the value true.
describe("report_completion — R3-2: the completion record states its own state", () => {
  const KEY = "completions/TEAM-4200.json";
  /** `h.calls.length` when the reported ticket's own record was written, per write. */
  const recordWrites = () => h.puts.map((p, i) => [p, h.putAtCall[i]]).filter(([p]) => p.Key === KEY);
  const lastIndexOfCall = (tool, pred = () => true) =>
    h.calls.reduce((at, c, i) => (c.tool === tool && pred(c.params) ? i : at), -1);

  it("the write lands AFTER the follow-up creates and BEFORE the Done transition", async () => {
    // Both halves of the invariant's placement, in one assertion chain: after the
    // creates is what makes `followUpsPending` knowable, before the transition is what
    // DL-030 requires of a ship-phase ticket.
    h.siblings.push(CD);
    expect(result(await report({ follow_ups: FU() })).status).toBe("complete");
    const writes = recordWrites();
    expect(writes).toHaveLength(1);
    const [, at] = writes[0];
    const lastCreate = lastIndexOfCall("Tickets___create_ticket");
    const done = lastIndexOfCall("Tickets___transition_ticket", (p) => p.transition_id === "done");
    expect(lastCreate).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(lastCreate);
    expect(at).toBeGreaterThan(lastCreate);
    expect(at).toBeLessThanOrEqual(done);
  });

  it("a pending record exists and says so — the guard's whole problem", async () => {
    // The scenario the existence-only guard could not tell apart: the record IS there
    // (HeadObject succeeds, so a direct done still passes today) but the run is not
    // finished. Now the bytes say which of the two it is.
    h.siblings.push(CD);
    h.createGate = () => false;
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(h.objects.has(KEY)).toBe(true);
    expect(record().followUpsPending).toBe(true);
    expect(record().status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
  });

  it("a NON-retryable failure is not pending: epic_unresolved still goes Done", async () => {
    // `followUpsPending` tracks exactly what withholds Done, not "did anything go
    // wrong": a ticket that provably has no parent is a definite negative no retry can
    // change, so it stays disclosed on the response and the record is final.
    h.issue = ticketRow({ key: "TEAM-4200", summary: "The ticket under report", parent: null });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.followUpsMaterialized.failed.map((f) => [f.reason, f.retryable])).toEqual([["epic_unresolved", false]]);
    expect(res.status).toBe("complete");
    expect(record().followUpsPending).toBe(false);
    expect(record().status).toBe("complete");
  });

  it("a failed transition rewrites ONLY status — the content is produced once", async () => {
    // Two writes are unavoidable on this path (DL-030 wants the record before the
    // transition; this status is only knowable after it), so what is pinned is the
    // intended meaning of "written once": the record's content is computed once and
    // the rewrite differs in `status` alone.
    h.transitionGate = () => { throw new Error("TooManyRequestsException: Rate exceeded"); };
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    const writes = recordWrites();
    expect(writes).toHaveLength(2);
    const [first, second] = writes.map(([p]) => JSON.parse(p.Body));
    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete_transition_failed");
    // followUpsPending stays FALSE: the follow-ups ARE filed and only the Done write
    // failed, so a human closing this ticket by hand is a legitimate recovery the
    // reader must not refuse.
    expect(second.followUpsPending).toBe(false);
    expect({ ...first, status: null }).toEqual({ ...second, status: null });
    // …and the durable object is the rewritten one.
    expect(JSON.parse(h.objects.get(KEY)).status).toBe("complete_transition_failed");
  });

  it("the rewrite is BEST-EFFORT: if it fails the record stands and the answer does not change", async () => {
    // The response already tells the agent to retry, and the retry restamps the record,
    // so a failed relabel must cost a label rather than turn a durable completion into
    // a thrown tool error.
    h.transitionGate = () => { throw new Error("TooManyRequestsException: Rate exceeded"); };
    // The FIRST write of the key lands; the second — the relabel — does not.
    let seen = 0;
    h.putGate = (input) => (input.Key === KEY && ++seen > 1 ? Object.assign(new Error("connection reset"), { name: "NetworkingError" }) : null);
    const res = result(await report({}));
    expect(res.status).toBe("complete_transition_failed");
    expect(res.next_action).toBe("retry_report_completion");
    expect(JSON.parse(h.objects.get(KEY)).status).toBe("complete");
    expect(h.warns.join("\n")).toMatch(/could not rewrite the record's status/);
  });

  it("an idempotent already-Done transition leaves the record final, with one write", async () => {
    h.transitionGate = () => 'Invalid transition "done" from status "done". Available: reopen (→ todo)';
    expect(result(await report({})).status).toBe("complete");
    expect(recordWrites()).toHaveLength(1);
    expect(record().status).toBe("complete");
    expect(record().followUpsPending).toBe(false);
  });

  it("a synthetic id gets a final record too — there is no transition to fail", async () => {
    const res = result(await report({ ticket_id: "HEALTHCHECK-1" }));
    expect(res.status).toBe("complete");
    const write = h.puts.find((p) => p.Key === "completions/HEALTHCHECK-1.json");
    expect(JSON.parse(write.Body).status).toBe("complete");
    expect(JSON.parse(write.Body).followUpsPending).toBe(false);
  });
});

// ─── TEAM-4740 FR-5: the run whose hub-infra work never reached main ───────────
//
// Two halves of one failure. The MATERIALIZER half reads the run's cd-ledger: an
// `unmerged` marker means commits that need their own PR to main, which is an
// AGENT's job — filing it as a human handoff is precisely how it sat unnoticed —
// and a `handoff[]` list means console/IAM steps only a person can do. The REFUSAL
// half closes the other direction: a fix whose base branch IS main is not delivered
// until the PR to main exists, so a completion without one is refused as a value.
// ─── TEAM-5101: a follow-up under a Jira Bug, and non-retryable create refusals ─
//
// On a bug-fix run the reporting ticket is a Subtask under the Bug, so `epicKey` IS
// the Bug. The Task->Subtask choice belongs to the jira twin's resolver (see
// lambda/agentcore-hub-jira child-issue-type tests); what this Lambda owns is what
// happens when a create is REFUSED: a deterministic Jira 4xx is a definite negative,
// so the ticket goes Done (exactly like epic_unresolved) and the unfiled entry is
// commented onto the ticket and its root — while anything transient still withholds.
const { followUpRetryable } = await import("./index.mjs");

describe("report_completion — TEAM-5101: follow-ups under a Bug, and 4xx refusals", () => {
  const BUG = "TEAM-5000";
  const PARENT_REFUSED = { error: "Jira API 400: Please select valid parent issue." };
  const bugRooted = () => {
    h.issue = ticketRow({ key: "TEAM-4200", summary: "Fix the crash", parent: BUG });
    h.siblings.push(CD);
  };
  const FU_DETAIL = () => FU({ detail: "Explain the new retry flag in the README." });

  it("(a) a Bug-rooted report files its follow-up under the Bug and the ticket reaches Done", async () => {
    bugRooted();
    const res = result(await report({ follow_ups: FU() }));
    // The parent is the Bug and the requested type stays "Task": the jira twin's
    // resolveChildIssueType turns it into a Subtask, so the Epic path is untouched.
    expect(h.created).toHaveLength(1);
    expect(h.created[0].params.parent_key).toBe(BUG);
    expect(h.created[0].params.issue_type).toBe("Task");
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(calls("Tickets___add_comment")).toHaveLength(0);
  });

  it("(b) Jira 400 'Please select valid parent issue' is NOT retryable: Done, and the entry is commented on the ticket AND its root", async () => {
    bugRooted();
    // TEAM-5123 W5: a Jira double, not a blanket refusal — it rejects exactly what
    // real Jira rejects (a Task whose parent is a Bug) and would accept anything else.
    h.createGate = (p) => (p.parent_key === BUG && p.issue_type === "Task" ? PARENT_REFUSED : undefined);
    const res = result(await report({ follow_ups: FU_DETAIL() }));
    expect(res.status).toBe("complete");
    expect("next_action" in res).toBe(false);
    expect(transitioned()).toBe(true);
    expect(record().followUpsPending).toBe(false);
    expect(record().status).toBe("complete");
    const hash = followUpHash("TEAM-4200", "docs", "Document the new flag");
    expect(res.followUpsMaterialized.failed).toEqual([{
      hash, kind: "docs", title: "Document the new flag",
      reason: "Jira API 400: Please select valid parent issue.", retryable: false,
      commentedOn: ["TEAM-4200", BUG],
    }]);
    // TEAM-5123 W1: and the RECORD says so, not only the response.
    expect(record().followUpsMaterialized.failed).toEqual(res.followUpsMaterialized.failed);
    const comments = calls("Tickets___add_comment");
    expect(comments.map((c) => c.ticket_id)).toEqual(["TEAM-4200", BUG]);
    for (const c of comments) {
      // Both twins' parameter names: jira reads `comment`, DynamoDB reads `body`.
      expect(c.body).toBe(c.comment);
      expect(c.comment).toContain(`[fu-unfiled:${hash}]`);
      expect(c.comment).toContain("kind: docs");
      expect(c.comment).toContain("assignee: agentcore_hub_api_dev");
      expect(c.comment).toContain("title: Document the new flag");
      expect(c.comment).toContain("Explain the new retry flag in the README.");
      expect(c.comment).toContain("Please select valid parent issue");
      expect(c.comment.startsWith(followUpBanner("TEAM-4200"))).toBe(true);
    }
    // The notice lands BEFORE the cascade.
    const order = h.calls.map((c) => c.tool);
    expect(order.lastIndexOf("Tickets___add_comment")).toBeLessThan(order.indexOf("Tickets___transition_ticket"));
  });

  it.each([403, 404, 422])("(b) Jira %i on the create is NOT retryable either", async (status) => {
    bugRooted();
    h.createGate = () => ({ error: `Jira API ${status}: refused` });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(false);
  });

  it("(b) idempotent re-call: the same refusal again answers complete with NO second notice", async () => {
    bugRooted();
    h.createGate = () => PARENT_REFUSED;
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    // The create IS re-attempted (nothing was filed, so there is no [fu:] sibling)...
    expect(h.calls.filter((c) => c.tool === "Tickets___create_ticket")).toHaveLength(2);
    // ...but the [fu-unfiled:<hash>] marker already on both targets suppresses the notice.
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(h.comments.get("TEAM-4200")).toHaveLength(1);
    expect(h.comments.get(BUG)).toHaveLength(1);
    expect(second.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  it("(b) a notice that cannot be posted never withholds Done", async () => {
    bugRooted();
    h.createGate = () => PARENT_REFUSED;
    h.ticketFail.add("Tickets___add_comment");
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual([]);
    expect(record().followUps).toHaveLength(1);
  });

  it("epic_unresolved is commented on the source ticket only (it has no root)", async () => {
    h.issue = ticketRow({ key: "TEAM-4200", parent: null });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(calls("Tickets___add_comment").map((c) => c.ticket_id)).toEqual(["TEAM-4200"]);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200"]);
  });

  it.each([
    ["Jira 503", { error: "Jira API 503: Service Unavailable" }],
    ["Jira 500", { error: "Jira API 500: boom" }],
    ["Jira 429", { error: "Jira API 429: Rate limit exceeded" }],
    ["Jira 401", { error: "Jira API 401: Unauthorized" }],
    ["a Lambda FunctionError", { errorMessage: "Task timed out after 30.00 seconds" }],
  ])("guard: %s stays RETRYABLE and withholds Done, with no notice", async (_label, verdict) => {
    bugRooted();
    h.createGate = () => verdict;
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(transitioned()).toBe(false);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(calls("Tickets___add_comment")).toHaveLength(0);
  });

  it("guard: an invoke-level throw (timeout/network) stays RETRYABLE and withholds Done", async () => {
    bugRooted();
    h.createGate = () => { throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" }); };
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    expect(res.followUpsMaterialized.failed[0].reason).toMatch(/^TimeoutError: socket hang up/);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
  });

  // TEAM-5122: the jira twin refuses a child create whose parent type it could not
  // read (a transient GET failure) — nothing was created, so the ticket must NOT go Done.
  const PARENT_UNREADABLE = {
    ok: false, reason: "parent_type_unreadable",
    error: "parent_type_unreadable: could not read parent TEAM-5000's issue type (Jira API 503: Service Unavailable); nothing was created. Retry the call.",
  };

  it("TEAM-5122: parent_type_unreadable is RETRYABLE and withholds Done, with no notice", async () => {
    bugRooted();
    h.createGate = () => PARENT_UNREADABLE;
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(transitioned()).toBe(false);
    expect(res.followUpsMaterialized.failed[0].reason).toBe(PARENT_UNREADABLE.error);
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(calls("Tickets___add_comment")).toHaveLength(0);
  });

  it("TEAM-5122: followUpRetryable names parent_type_unreadable as retryable explicitly", async () => {
    const { FOLLOW_UP_PARENT_TYPE_UNREADABLE } = await import("./index.mjs");
    expect(FOLLOW_UP_PARENT_TYPE_UNREADABLE).toBe("parent_type_unreadable");
    expect(followUpRetryable(PARENT_UNREADABLE.error)).toBe(true);
    expect(followUpRetryable("parent_type_unreadable")).toBe(true);
  });

  it("followUpRetryable reads the status ONLY off the anchored jira prefix", () => {
    expect(followUpRetryable("Jira API 400: Please select valid parent issue.")).toBe(false);
    expect(followUpRetryable("Jira API 403: forbidden")).toBe(false);
    expect(followUpRetryable("Jira API 404: not found")).toBe(false);
    expect(followUpRetryable("Jira API 422: unprocessable")).toBe(false);
    expect(followUpRetryable("epic_unresolved")).toBe(false);
    for (const r of ["Jira API 429: slow down", "Jira API 500: x", "Jira API 502: x", "Jira API 401: x", "Jira API 409: x",
      "Unhandled: Jira API 400: x", "Error: Jira API 400: x", "jira api 400: x", "Error: create_ticket is unavailable",
      "sibling_scan_failed", "ticket_unreadable", "", undefined, null]) {
      expect(followUpRetryable(r)).toBe(true);
    }
  });
});

// ─── TEAM-5123: outcomes persisted; notices truthful and deduped on the record ─
//
// W1 persists `followUpsMaterialized` on the completion record whether or not Done
// is attempted. W3 posts the unfiled notice only when Done WILL be attempted, so it
// never claims a close that a retryable sibling row is withholding. W2 dedupes the
// notice on the PRIOR record's `commentedOn` first and the comment marker second, so
// a comment page that no longer shows the notice cannot cause a duplicate.
describe("report_completion — TEAM-5123: persisted follow-up outcomes and unfiled notices", () => {
  const BUG = "TEAM-5000";
  const REFUSED = { error: "Jira API 400: Please select valid parent issue." };
  const bugRooted = () => {
    h.issue = ticketRow({ key: "TEAM-4200", summary: "Fix the crash", parent: BUG });
    h.siblings.push(CD);
  };
  const DOCS = { kind: "docs", owner: "agent", assignee: "agentcore_hub_api_dev", title: "Document the new flag" };
  const PDV = { kind: "post_deploy_verification", owner: "agent", title: "Re-check /health after deploy" };
  const TWO = JSON.stringify([DOCS, PDV]);
  const docsHash = followUpHash("TEAM-4200", "docs", DOCS.title);
  const pdvHash = followUpHash("TEAM-4200", "post_deploy_verification", PDV.title);
  /** The LAST completion record written — re-calls overwrite the key. */
  const lastRecord = () => JSON.parse([...h.puts].reverse().find((p) => p.Key === "completions/TEAM-4200.json").Body);
  /** Unfiled-notice comments on one target. */
  const notices = (target) => (h.comments.get(target) || []).filter((c) => c.includes("[fu-unfiled:"));

  it("(a) two non-retryable 400s: Done, both outcomes in the response AND the record, one notice per target naming both", async () => {
    bugRooted();
    h.createGate = () => REFUSED;
    const res = result(await report({ follow_ups: TWO }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    const rows = [
      { hash: docsHash, kind: "docs", title: DOCS.title, reason: REFUSED.error, retryable: false, commentedOn: ["TEAM-4200", BUG] },
      { hash: pdvHash, kind: "post_deploy_verification", title: PDV.title, reason: REFUSED.error, retryable: false, commentedOn: ["TEAM-4200", BUG] },
    ];
    expect(res.followUpsMaterialized.failed).toEqual(rows);
    const rec = lastRecord();
    expect(rec.followUpsMaterialized).toEqual({ created: [], skipped: [], failed: rows });
    expect(rec.status).toBe("complete");
    expect(rec.followUpsPending).toBe(false);
    for (const target of ["TEAM-4200", BUG]) {
      expect(notices(target)).toHaveLength(1);
      expect(notices(target)[0]).toContain(`[fu-unfiled:${docsHash}]`);
      expect(notices(target)[0]).toContain(`[fu-unfiled:${pdvHash}]`);
      expect(notices(target)[0]).toContain("TEAM-4200 is being closed without them");
    }
  });

  it("(b) mixed 400+503: pending and NO notice; the re-call that goes Done posts once, naming only the 400; a third call posts nothing", async () => {
    bugRooted();
    h.createGate = (p) => (/health/.test(p.summary) ? { error: "Jira API 503: Service Unavailable" } : REFUSED);
    const first = result(await report({ follow_ups: TWO }));
    expect(first.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    // W3: Done is withheld, so a notice saying the ticket is being closed would be false.
    expect(calls("Tickets___add_comment")).toHaveLength(0);
    expect(lastRecord().status).toBe("complete_pending_follow_ups");
    expect(lastRecord().followUpsMaterialized.failed.map((f) => [f.hash, f.retryable, f.commentedOn])).toEqual([
      [docsHash, false, []],
      [pdvHash, true, []],
    ]);

    // The 503 clears (the /health entry is created); the 400 is still refused.
    h.createGate = (p) => (/health/.test(p.summary) ? undefined : REFUSED);
    const second = result(await report({ follow_ups: TWO }));
    expect(second.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(second.followUpsMaterialized.created.map((c) => c.hash)).toEqual([pdvHash]);
    for (const target of ["TEAM-4200", BUG]) {
      expect(notices(target)).toHaveLength(1);
      expect(notices(target)[0]).toContain(`[fu-unfiled:${docsHash}]`);
      expect(notices(target)[0]).not.toContain(`[fu-unfiled:${pdvHash}]`);
      expect(notices(target)[0]).toContain("is being closed without them");
    }
    expect(lastRecord().followUpsMaterialized.failed).toEqual([
      { hash: docsHash, kind: "docs", title: DOCS.title, reason: REFUSED.error, retryable: false, commentedOn: ["TEAM-4200", BUG] },
    ]);

    const third = result(await report({ follow_ups: TWO }));
    expect(third.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(third.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  it("(c) the re-call dedupes on the persisted record even when get_issue shows NO comments", async () => {
    bugRooted();
    h.createGate = () => REFUSED;
    result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    h.commentsHidden = true;
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(second.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
    expect(lastRecord().followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  it("(c) …and when the notice has scrolled out of Jira's newest-50 comment page", async () => {
    bugRooted();
    h.createGate = () => REFUSED;
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) {
      for (let i = 0; i < 60; i++) h.comments.get(target).push(`status chatter ${i}`);
    }
    h.commentWindow = 50;
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  it("(e) a notice that could not be posted is persisted as not posted, and the next call posts it once", async () => {
    bugRooted();
    h.createGate = () => REFUSED;
    h.ticketFail.add("Tickets___add_comment");
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    expect(lastRecord().followUpsMaterialized.failed[0].commentedOn).toEqual([]);
    h.ticketFail.delete("Tickets___add_comment");
    const second = result(await report({ follow_ups: FU() }));
    expect(second.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  it("(g) a REAL Lambda FunctionError on the create is a retryable failure, never a phantom create", async () => {
    bugRooted();
    // No errorMessage: only the invoke response's FunctionError says this failed.
    h.createGate = () => ({ FunctionError: "Unhandled", Payload: { errorType: "Runtime.ExitError" } });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    expect(res.followUpsMaterialized.created).toEqual([]);
    expect(res.followUpsMaterialized.failed[0].reason).toBe("Unhandled: unhandled error");
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(calls("Tickets___add_comment")).toHaveLength(0);
  });

  it("(g) …and its reason carries the FunctionError kind ahead of the runtime's message", async () => {
    bugRooted();
    h.createGate = () => ({ FunctionError: "Unhandled", Payload: { errorMessage: "Task timed out after 30.00 seconds", errorType: "Sandbox.Timedout" } });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.followUpsMaterialized.failed[0].reason).toBe("Unhandled: Task timed out after 30.00 seconds");
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
  });

  it("(j) an unreadable prior record still completes, and the comment marker still dedupes", async () => {
    bugRooted();
    h.createGate = () => REFUSED;
    const unreadable = Object.assign(new Error("We encountered an internal error"), { name: "InternalError" });
    h.getError = { key: "completions/TEAM-4200.json", err: unreadable };
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(h.warns.join("\n")).toMatch(/prior completion record completions\/TEAM-4200\.json was unreadable \(InternalError/);
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(second.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  // TEAM-5129 N1: the record write REPLACES the key, so a call that reads nothing back
  // from the prior record erases what an earlier call posted. A withheld call (a
  // retryable row holding Done) used to be exactly that call: no notice, no prior read,
  // `commentedOn: []` persisted over the `[T, BUG]` call 1 had written - and the next
  // Done-attempting call, unable to see the marker, posted the notice again.
  it("(k) TEAM-5129 N1: a withheld re-call keeps the prior record's commentedOn, so the Done-attempting call does not re-post", async () => {
    bugRooted();
    // Call 1: both 400 - Done is attempted, notices land on both targets, then the transition fails.
    h.createGate = () => REFUSED;
    h.transitionGate = () => { throw new Error("TooManyRequestsException: Rate exceeded"); };
    const first = result(await report({ follow_ups: TWO }));
    expect(first.status).toBe("complete_transition_failed");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(lastRecord().followUpsMaterialized.failed.map((f) => f.commentedOn)).toEqual([["TEAM-4200", BUG], ["TEAM-4200", BUG]]);

    // Call 2: DOCS still 400, PDV 503 - Done WITHHELD. No notice, and the record must still carry the prior's targets.
    h.transitionGate = null;
    h.createGate = (p) => (/health/.test(p.summary) ? { error: "Jira API 503: Service Unavailable" } : REFUSED);
    const second = result(await report({ follow_ups: TWO }));
    expect(second.status).toBe("complete_pending_follow_ups");
    // Counted, not `transitioned()`: call 1 already attempted (and failed) a transition.
    expect(calls("Tickets___transition_ticket")).toHaveLength(1);
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    expect(lastRecord().followUpsMaterialized.failed.map((f) => [f.hash, f.retryable, f.commentedOn])).toEqual([
      [docsHash, false, ["TEAM-4200", BUG]],
      [pdvHash, true, ["TEAM-4200", BUG]],
    ]);

    // Call 3: PDV creates, DOCS still 400, and get_issue shows NO comments (the marker fallback cannot see the notice).
    h.createGate = (p) => (/health/.test(p.summary) ? undefined : REFUSED);
    h.commentsHidden = true;
    const third = result(await report({ follow_ups: TWO }));
    expect(third.status).toBe("complete");
    expect(calls("Tickets___transition_ticket")).toHaveLength(2);
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
    expect(third.followUpsMaterialized.failed).toEqual([
      { hash: docsHash, kind: "docs", title: DOCS.title, reason: REFUSED.error, retryable: false, commentedOn: ["TEAM-4200", BUG] },
    ]);
  });

  // TEAM-5129, same defect class: a follow-up CREATED on call N is `skipped:
  // already_materialized` on call N+1, and the replaced record no longer named the
  // ticket it became. The prior record's created/skipped row for the same hash does.
  it("(l) TEAM-5129 sibling: a re-call's already_materialized row keeps the ticketId the prior record's created row had", async () => {
    bugRooted();
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    expect(first.followUpsMaterialized.created[0].ticketId).toBe("TEAM-4901");
    expect(lastRecord().followUpsMaterialized.created[0].ticketId).toBe("TEAM-4901");

    // Call 2: the roster shows [fu:<hash>], so nothing is created - and the record must still name the ticket.
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(calls("Tickets___create_ticket")).toHaveLength(1);
    expect(second.followUpsMaterialized.skipped).toEqual([
      { hash: docsHash, kind: "docs", title: DOCS.title, reason: "already_materialized", ticketId: "TEAM-4901" },
    ]);
    expect(lastRecord().followUpsMaterialized.skipped[0].ticketId).toBe("TEAM-4901");

    // Call 3: carried from a prior SKIPPED row, not only from a created one.
    await report({ follow_ups: FU() });
    expect(lastRecord().followUpsMaterialized.skipped[0].ticketId).toBe("TEAM-4901");
  });
});

// TEAM-5155: both earlier layers read and then write. Two overlapping calls both see
// nothing, and a re-report with no follow-ups replaces the record without the rows, so
// neither layer can stop a second notice. The claim is a conditional PUT on a key the
// record write never touches.
describe("report_completion — TEAM-5155: unfiled-notice delivery claim", () => {
  const BUG = "TEAM-5000";
  const REFUSED = { error: "Jira API 400: Please select valid parent issue." };
  const bugRooted = () => {
    h.issue = ticketRow({ key: "TEAM-4200", summary: "Fix the crash", parent: BUG });
    h.siblings.push(CD);
    h.createGate = () => REFUSED;
  };
  const hash = followUpHash("TEAM-4200", "docs", "Document the new flag");
  const claimKey = (target) => `completion-notices/TEAM-4200/${hash}-${target}.json`;
  const notices = (target) => (h.comments.get(target) || []).filter((c) => c.includes("[fu-unfiled:"));
  const lastRecord = () => JSON.parse([...h.puts].reverse().find((p) => p.Key === "completions/TEAM-4200.json").Body);
  const awsError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it("S1: two concurrent reports of the same refused follow-up post exactly ONE notice per target", async () => {
    bugRooted();
    const [a, b] = (await Promise.all([report({ follow_ups: FU() }), report({ follow_ups: FU() })])).map(result);
    expect(a.status).toBe("complete");
    expect(b.status).toBe("complete");
    for (const target of ["TEAM-4200", BUG]) {
      expect(notices(target)).toHaveLength(1);
      expect(h.objects.has(claimKey(target))).toBe(true);
    }
  });

  it("S2: a re-report with no follow-ups erases commentedOn, and the next re-report still does not re-post", async () => {
    bugRooted();
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
    result(await report({ follow_ups: "[]" }));
    expect(lastRecord().followUpsMaterialized).toBeUndefined();
    h.commentsHidden = true;
    const third = result(await report({ follow_ups: FU() }));
    expect(third.status).toBe("complete");
    expect(calls("Tickets___add_comment")).toHaveLength(2);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  it("writer: the claim is a conditional PUT per target, landing BEFORE that target's add_comment, outside completions/", async () => {
    bugRooted();
    result(await report({ follow_ups: FU() }));
    const order = h.calls.map((c) => [c.tool, c.params.ticket_id]);
    for (const target of ["TEAM-4200", BUG]) {
      const i = h.puts.findIndex((p) => p.Key === claimKey(target));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(h.puts[i].IfNoneMatch).toBe("*");
      const post = order.findIndex(([tool, id]) => tool === "Tickets___add_comment" && id === target);
      expect(h.putAtCall[i]).toBeLessThanOrEqual(post);
    }
    // The record helpers still find the RECORD, not a claim.
    expect(record().ticket_id).toBe("TEAM-4200");
    expect(record().followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  it("reader: an existing FRESH claim (412) skips that target, and the target is NOT recorded as commented", async () => {
    bugRooted();
    // TEAM-5167: a live owner's claim — fresh, and still mid-post.
    h.objects.set(claimKey(BUG), JSON.stringify({ ticketId: "TEAM-4200", hash, target: BUG, owner: "other", state: "claimed", claimedAt: new Date().toISOString() }));
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(notices("TEAM-4200")).toHaveLength(1);
    expect(notices(BUG)).toHaveLength(0);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200"]);
    // Nothing overwrote the owner's claim.
    expect(JSON.parse(h.objects.get(claimKey(BUG))).owner).toBe("other");
  });

  it("reader: a claim body that says nothing is dated by S3's LastModified — fresh ⇒ still someone else's", async () => {
    bugRooted();
    h.objects.set(claimKey(BUG), "{}");
    h.lastModified.set(claimKey(BUG), new Date());
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(notices(BUG)).toHaveLength(0);
    expect(h.puts.filter((p) => p.Key === claimKey(BUG) && p.IfMatch !== undefined)).toHaveLength(0);
  });

  // TEAM-5167 R2-01: per the S3 user guide a 409 on a conditional PUT is a CONCURRENT
  // operation racing it (a delete finishing first), and "uploads may be retried"; only
  // a 412 means another owner holds the key. Treating 409 as lost dropped the notice.
  it("R2-01: one 409 ConditionalRequestConflict on the claim is retried — the notice is posted and the claim lands", async () => {
    bugRooted();
    let conflicts = 0;
    h.putGate = (input) => (input.Key === claimKey(BUG) && conflicts++ === 0 ? awsError("ConditionalRequestConflict", 409) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(notices("TEAM-4200")).toHaveLength(1);
    expect(notices(BUG)).toHaveLength(1);
    expect(h.objects.has(claimKey(BUG))).toBe(true);
    expect(h.puts.filter((p) => p.Key === claimKey(BUG) && p.IfNoneMatch === "*")).toHaveLength(2);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });

  it("R2-01: a 409 that never clears is an ERROR after the retry budget, never a lost claim — the notice still posts", async () => {
    bugRooted();
    h.putGate = (input) => (input.Key === claimKey(BUG) ? awsError("ConditionalRequestConflict", 409) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(notices(BUG)).toHaveLength(1);
    expect(h.puts.filter((p) => p.Key === claimKey(BUG))).toHaveLength(3);
    expect(h.warns.join("\n")).toMatch(/could not claim completion-notices\/TEAM-4200\/[^\n]*ConditionalRequestConflict/);
  });

  // TEAM-5167 R2-02: a Lambda that dies between the claim and the add_comment used to
  // strand the claim forever — every later call saw a 412 and skipped. The claim body
  // now records its state, and a `claimed` one older than the Lambda's own timeout
  // (plus margin) is a dead owner's, takeable with IfMatch on its ETag.
  it("R2-02: the reviewer's repro — a 10-minute-old claim in the OLD body format (no state) is taken over; two reports post exactly ONE notice", async () => {
    bugRooted();
    // Written by the pre-5167 claimNotice: no `state`, no `owner`, just a timestamp.
    h.objects.set(claimKey(BUG), JSON.stringify({ ticketId: "TEAM-4200", hash, target: BUG, claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
    h.etags.set(claimKey(BUG), '"legacy"');
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    expect(notices(BUG)).toHaveLength(1);
    expect(h.puts.some((p) => p.Key === claimKey(BUG) && p.IfMatch === '"legacy"')).toBe(true);
    expect(JSON.parse(h.objects.get(claimKey(BUG)))).toMatchObject({ state: "delivered" });
    h.commentsHidden = true;
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(notices(BUG)).toHaveLength(1);
    expect(notices("TEAM-4200")).toHaveLength(1);
  });

  it("R2-02: a 10-minute-old `claimed` claim with no timestamp at all is stale too (a claim nobody can date must not wedge)", async () => {
    bugRooted();
    h.objects.set(claimKey(BUG), JSON.stringify({ ticketId: "TEAM-4200", hash, target: BUG, state: "claimed" }));
    h.etags.set(claimKey(BUG), '"undated"');
    result(await report({ follow_ups: FU() }));
    expect(notices(BUG)).toHaveLength(1);
    expect(h.puts.some((p) => p.Key === claimKey(BUG) && p.IfMatch === '"undated"')).toBe(true);
  });

  it("R2-02: a FRESH `claimed` claim is a live owner mid-post — skipped, body untouched", async () => {
    bugRooted();
    const body = { ticketId: "TEAM-4200", hash, target: BUG, owner: "live", state: "claimed", claimedAt: new Date().toISOString() };
    h.objects.set(claimKey(BUG), JSON.stringify(body));
    const res = result(await report({ follow_ups: FU() }));
    expect(notices(BUG)).toHaveLength(0);
    expect(JSON.parse(h.objects.get(claimKey(BUG)))).toEqual(body);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200"]);
  });

  it("R2-02: a `delivered` claim is never taken over, however old", async () => {
    bugRooted();
    h.objects.set(claimKey(BUG), JSON.stringify({ ticketId: "TEAM-4200", hash, target: BUG, state: "delivered", claimedAt: "2020-01-01T00:00:00.000Z", deliveredAt: "2020-01-01T00:00:01.000Z" }));
    result(await report({ follow_ups: FU() }));
    expect(notices(BUG)).toHaveLength(0);
    expect(h.puts.filter((p) => p.Key === claimKey(BUG))).toHaveLength(1); // the create-only attempt, nothing else
  });

  it("R2-02: a posted notice marks its claim `delivered` with IfMatch on the ETag it won", async () => {
    bugRooted();
    const seen = [];
    h.putGate = (input) => { if (input.IfMatch !== undefined) seen.push([input.Key, h.etags.get(input.Key), input.IfMatch]); return null; };
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) {
      expect(JSON.parse(h.objects.get(claimKey(target)))).toMatchObject({ state: "delivered", target });
      const puts = h.puts.filter((p) => p.Key === claimKey(target));
      expect(puts).toHaveLength(2);
      expect(puts[0].IfNoneMatch).toBe("*");
      expect(puts[1].IfMatch).toBeDefined();
      const row = seen.find(([key]) => key === claimKey(target));
      expect(row[2]).toBe(row[1]); // IfMatch = the ETag current at that moment = the one the create-only PUT returned
    }
  });

  it("R2-02: a failed `delivered` mark is best-effort — the notice stays posted once and Done is not withheld", async () => {
    bugRooted();
    h.putGate = (input) => (input.Key === claimKey(BUG) && input.IfMatch !== undefined ? awsError("InternalError", 500) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(notices(BUG)).toHaveLength(1);
    expect(JSON.parse(h.objects.get(claimKey(BUG))).state).toBe("claimed");
    expect(h.warns.join("\n")).toMatch(new RegExp(`could not mark ${claimKey(BUG).replace(/[.]/g, "\\.")} delivered`));
  });

  it("any other claim error still posts, and never withholds Done", async () => {
    bugRooted();
    h.putGate = (input) => (input.Key?.startsWith("completion-notices/") ? awsError("InternalError", 500) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
    expect(h.warns.join("\n")).toMatch(/could not claim completion-notices\/TEAM-4200\//);
  });

  it("retry after partial failure: a failed post releases its claim, and the next call posts once", async () => {
    bugRooted();
    h.ticketFail.add("Tickets___add_comment");
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete");
    for (const target of ["TEAM-4200", BUG]) {
      expect(h.deletes.map((d) => d.Key)).toContain(claimKey(target));
      expect(h.objects.has(claimKey(target))).toBe(false);
    }
    h.ticketFail.delete("Tickets___add_comment");
    h.commentsHidden = true;
    const second = result(await report({ follow_ups: FU() }));
    expect(second.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  // TEAM-5167 R2-03: releasing was an unconditional DeleteObject, so a caller whose
  // claim PUT errored could delete ANOTHER caller's winning claim, and a third call
  // then re-claimed and posted again. A release now proves ownership first.
  it("a claim that errored but LANDED is released too when the post fails — after a read proves it is OURS, with IfMatch on its ETag", async () => {
    bugRooted();
    h.putGate = (input) => {
      if (!input.Key?.startsWith("completion-notices/")) return null;
      // S3 committed OUR body; the response was lost.
      h.objects.set(input.Key, asString(input.Body));
      h.etags.set(input.Key, `"landed-${input.Key}"`);
      return awsError("TimeoutError", 500);
    };
    h.ticketFail.add("Tickets___add_comment");
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) {
      expect(h.gets.some((g) => g.Key === claimKey(target))).toBe(true);
      const del = h.deletes.find((d) => d.Key === claimKey(target));
      expect(del?.IfMatch).toBe(`"landed-${claimKey(target)}"`);
      expect(h.objects.has(claimKey(target))).toBe(false);
    }
    h.putGate = null;
    h.ticketFail.delete("Tickets___add_comment");
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  it("R2-03: the reviewer's repro — a caller whose claim PUT errored never deletes another owner's claim; the run ends with ONE source notice", async () => {
    bugRooted();
    // B holds fresh claims on both targets and has already posted; its comment is on the
    // ticket but hidden from get_issue (the jira twin's silent `comments: []`).
    for (const target of ["TEAM-4200", BUG]) {
      h.objects.set(claimKey(target), JSON.stringify({ ticketId: "TEAM-4200", hash, target, owner: "B", state: "claimed", claimedAt: new Date().toISOString() }));
      h.etags.set(claimKey(target), `"B-${target}"`);
      h.comments.set(target, [`[fu-unfiled:${hash}] kind: docs (posted by B)`]);
    }
    h.commentsHidden = true;
    // Call A: its claim PUT errors WITHOUT landing, it posts anyway, and its post fails.
    h.putGate = (input) => (input.Key?.startsWith("completion-notices/") ? awsError("TimeoutError", 500) : null);
    h.ticketFail.add("Tickets___add_comment");
    const a = result(await report({ follow_ups: FU() }));
    expect(a.status).toBe("complete");
    for (const target of ["TEAM-4200", BUG]) {
      expect(h.objects.has(claimKey(target))).toBe(true);
      expect(JSON.parse(h.objects.get(claimKey(target))).owner).toBe("B");
    }
    expect(h.deletes.filter((d) => d.Key.startsWith("completion-notices/"))).toHaveLength(0);
    expect(h.warns.join("\n")).toMatch(/not ours - not released/);
    // Call C: B still owns both claims, so C posts nothing.
    h.putGate = null;
    h.ticketFail.delete("Tickets___add_comment");
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) expect(notices(target)).toHaveLength(1);
  });

  it("R2-03: a won claim is released with IfMatch on its ETag; one another taker has since re-written survives the release", async () => {
    bugRooted();
    h.ticketFail.add("Tickets___add_comment");
    // Between our claim and our release, another taker re-wrote the BUG claim.
    h.deleteGate = (input) => { if (input.Key === claimKey(BUG)) h.etags.set(claimKey(BUG), '"taken-over"'); return null; };
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    const dels = h.deletes.filter((d) => d.Key.startsWith("completion-notices/"));
    expect(dels).toHaveLength(2);
    for (const d of dels) expect(d.IfMatch).toMatch(/^"e\d+"$/);
    expect(h.objects.has(claimKey("TEAM-4200"))).toBe(false);
    expect(h.objects.has(claimKey(BUG))).toBe(true);
    expect(h.warns.join("\n")).toMatch(new RegExp(`${claimKey(BUG).replace(/[.]/g, "\\.")} was taken over by another call - not released`));
  });

  it("R2-03: an errored claim whose post SUCCEEDED is marked delivered once ownership is proven", async () => {
    bugRooted();
    h.putGate = (input) => {
      if (!input.Key?.startsWith("completion-notices/") || input.IfMatch !== undefined) return null;
      h.objects.set(input.Key, asString(input.Body));
      h.etags.set(input.Key, `"landed-${input.Key}"`);
      return awsError("TimeoutError", 500);
    };
    result(await report({ follow_ups: FU() }));
    for (const target of ["TEAM-4200", BUG]) {
      expect(notices(target)).toHaveLength(1);
      expect(JSON.parse(h.objects.get(claimKey(target)))).toMatchObject({ state: "delivered" });
      expect(h.puts.some((p) => p.Key === claimKey(target) && p.IfMatch === `"landed-${claimKey(target)}"`)).toBe(true);
    }
  });

  it("a release that fails is logged with its key and never withholds Done", async () => {
    bugRooted();
    h.ticketFail.add("Tickets___add_comment");
    h.deleteError = awsError("AccessDenied", 403);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(transitioned()).toBe(true);
    expect(h.warns.join("\n")).toContain(`could not release ${claimKey(BUG)} (AccessDenied`);
    expect(h.warns.join("\n")).toContain("will NOT be retried until that key is deleted");
  });

  it("a notice posted before TEAM-5155 (marker in comments, no claim object) is not claimed or re-posted", async () => {
    bugRooted();
    for (const target of ["TEAM-4200", BUG]) h.comments.set(target, [`[fu-unfiled:${hash}] kind: docs`]);
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(h.puts.some((p) => p.Key?.startsWith("completion-notices/"))).toBe(false);
    expect(calls("Tickets___add_comment")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed[0].commentedOn).toEqual(["TEAM-4200", BUG]);
  });
});

// TEAM-5162: materializeFollowUps read the sibling list and then created, with no
// claim, so two overlapping reports of the same ticket (or a JQL search that has not
// caught up yet) both missed the [fu:<hash>] title and both created. A create-only
// claim at completion-followups/<ticket>/<hash>.json now sits between the two.
describe("report_completion — TEAM-5162: follow-up create claim", () => {
  const hash = followUpHash("TEAM-4200", "docs", "Document the new flag");
  const claimKey = `completion-followups/TEAM-4200/${hash}.json`;
  const claimBody = () => JSON.parse(h.objects.get(claimKey));
  const seedClaim = (body) => h.objects.set(claimKey, JSON.stringify({ ticketId: "TEAM-4200", hash, ...body }));
  const awsError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it("1: two concurrent reports of the same follow-up with an empty sibling list create exactly ONE ticket", async () => {
    const [a, b] = (await Promise.all([report({ follow_ups: FU() }), report({ follow_ups: FU() })])).map(result);
    expect(calls("Tickets___create_ticket")).toHaveLength(1);
    const [winner, loser] = a.followUpsMaterialized.created.length ? [a, b] : [b, a];
    expect(winner.followUpsMaterialized.created).toHaveLength(1);
    expect(loser.followUpsMaterialized.created).toHaveLength(0);
    expect(loser.followUpsMaterialized.skipped).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "already_materialized", ticketId: "TEAM-4901" },
    ]);
    expect(a.status).toBe("complete");
    expect(b.status).toBe("complete");
    expect(claimBody()).toMatchObject({ ticketId: "TEAM-4200", hash, state: "created", key: "TEAM-4901" });
  });

  it("writer: the claim is a create-only PUT that lands BEFORE the create, outside completions/", async () => {
    result(await report({ follow_ups: FU() }));
    const i = h.puts.findIndex((p) => p.Key === claimKey);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.puts[i].IfNoneMatch).toBe("*");
    expect(JSON.parse(h.puts[i].Body)).toMatchObject({ ticketId: "TEAM-4200", hash, state: "claimed" });
    expect(h.putAtCall[i]).toBeLessThanOrEqual(h.calls.findIndex((c) => c.tool === "Tickets___create_ticket"));
    expect(record().ticket_id).toBe("TEAM-4200");
  });

  it("2: a failed create releases the claim, and the retry creates exactly once", async () => {
    h.createGate = () => false; // "Error: create_ticket refused ..." — retryable
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete_pending_follow_ups");
    expect(first.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(h.deletes.map((d) => d.Key)).toContain(claimKey);
    expect(h.objects.has(claimKey)).toBe(false);
    h.createGate = null;
    const second = result(await report({ follow_ups: FU() }));
    expect(second.status).toBe("complete");
    expect(h.created).toHaveLength(1);
    expect(claimBody()).toMatchObject({ state: "created", key: "TEAM-4901" });
  });

  // TEAM-5167 R2-04: a throw AFTER the invoke cannot prove Jira created nothing, so the
  // claim is kept as `uncertain` (reconciled by the next call), not released. The test
  // also asserts POSITIVELY that the create was reached — before, a claim that failed
  // for any other reason would have passed it vacuously.
  it("2b: a create that THROWS keeps the claim as uncertain, and the outer catch still withholds Done", async () => {
    h.createGate = () => null;
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    // The create WAS reached, once, and the claim landed before it.
    expect(calls("Tickets___create_ticket")).toHaveLength(1);
    const i = h.puts.findIndex((p) => p.Key === claimKey);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.putAtCall[i]).toBeLessThanOrEqual(h.calls.findIndex((c) => c.tool === "Tickets___create_ticket"));
    expect(h.deletes.map((d) => d.Key)).not.toContain(claimKey);
    expect(claimBody()).toMatchObject({ state: "uncertain" });
    expect(res.followUpsMaterialized.failed[0].retryable).toBe(true);
  });

  // TEAM-5167 R2-04: every `!r.ok` used to release the create claim — including an
  // invoke/network error or a Jira 5xx, which do not prove Jira created nothing. A
  // create succeeded, its response was lost, the claim was released, and the retry's
  // sibling search (Jira's index lags) missed the new ticket: two tickets.
  it("R2-04: the reviewer's repro — create succeeds, response lost, sibling search stale ⇒ ONE ticket, not two", async () => {
    // Jira created the ticket (it is in h.created) but the invoke died on the way back,
    // and the search index has not caught up: the new ticket is not yet a sibling.
    h.createGate = (params) => {
      h.created.push({ key: "TEAM-4901", params });
      return { FunctionError: "Unhandled", Payload: { errorType: "Error", errorMessage: "Task timed out after 60.00 seconds" } };
    };
    const first = result(await report({ follow_ups: FU() }));
    expect(first.status).toBe("complete_pending_follow_ups");
    expect(first.followUpsMaterialized.failed[0].retryable).toBe(true);
    expect(h.created).toHaveLength(1);
    expect(h.deletes.map((d) => d.Key)).not.toContain(claimKey);
    expect(claimBody()).toMatchObject({ state: "uncertain" });
    // A retry right away: the search still does not show it, and a FRESH uncertain claim
    // is not a licence to create — the entry waits, retryable.
    h.createGate = null;
    const second = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(second.followUpsMaterialized.failed[0].reason).toBe("claim_in_flight");
    expect(second.status).toBe("complete_pending_follow_ups");
    // Later: the index caught up, and the claim has aged past the stale threshold. The
    // first scan of the third call still lags; the reconcile scan sees the ticket.
    const created = h.created[0].params;
    const row = ticketRow({ key: "TEAM-4901", summary: created.summary, assignee: created.assignee, created: "2026-09-17T12:00:00.000Z" });
    let scans = 0;
    h.listGate = (rows) => (++scans === 1 ? rows : [...rows, row]);
    age(claimKey, 10 * 60 * 1000);
    const third = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(third.followUpsMaterialized.skipped).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "already_materialized", ticketId: "TEAM-4901" },
    ]);
    expect(third.status).toBe("complete");
    expect(claimBody()).toMatchObject({ state: "created", key: "TEAM-4901" });
  });

  it("R2-04: a STALE uncertain claim whose ticket is provably absent is taken over and created once", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), uncertainAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "uncertain", error: "Error: socket hang up" });
    h.etags.set(claimKey, '"u"');
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created).toHaveLength(1);
    expect(h.puts.some((p) => p.Key === claimKey && p.IfMatch === '"u"')).toBe(true);
    expect(claimBody()).toMatchObject({ state: "created", key: "TEAM-4901" });
    // The reconcile scan ran before the takeover.
    expect(calls("Tickets___list_tickets").length).toBeGreaterThanOrEqual(2);
  });

  it("R2-04: an uncertain claim whose reconcile scan FAILS is sibling_scan_failed — no create, retryable", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), uncertainAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "uncertain" });
    let scans = 0;
    h.listGate = (rows) => (++scans === 1 ? rows : false);
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed[0]).toMatchObject({ reason: "sibling_scan_failed", retryable: true });
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(claimBody().state).toBe("uncertain");
  });

  it("R2-04: a DEFINITE refusal (Jira 4xx or 503, the DynamoDB twin's Error: text, a structured ok:false, parent_type_unreadable) still releases the claim", async () => {
    const refusals = [
      false,
      { error: "Jira API 400: Please select valid parent issue." },
      { error: "Jira API 404: project not found" },
      { error: "Jira API 503: Service Unavailable" },
      { ok: false, reason: "typed_gate", content: [{ type: "text", text: "Cannot create: refused" }] },
      { error: "parent_type_unreadable: Jira API 503 on GET /issue/TEAM-5000" },
    ];
    for (const refusal of refusals) {
      h.deletes.length = 0;
      h.objects.delete(claimKey);
      h.createGate = () => refusal;
      result(await report({ follow_ups: FU() }));
      const del = h.deletes.find((d) => d.Key === claimKey);
      expect(del, JSON.stringify(refusal)).toBeDefined();
      expect(del.IfMatch, JSON.stringify(refusal)).toMatch(/^"e\d+"$/);
      expect(h.objects.has(claimKey), JSON.stringify(refusal)).toBe(false);
    }
    expect(h.created).toHaveLength(0);
  });

  it("R2-04: an AMBIGUOUS failure (Jira 5xx, a FunctionError, an invoke-level throw) keeps the claim as uncertain", async () => {
    const ambiguous = [
      { error: "Jira API 502: Bad Gateway" },
      { FunctionError: "Unhandled", Payload: { errorType: "Error", errorMessage: "Task timed out after 60.00 seconds" } },
      () => { throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" }); },
    ];
    for (const verdict of ambiguous) {
      h.deletes.length = 0;
      h.objects.delete(claimKey);
      h.createGate = typeof verdict === "function" ? verdict : () => verdict;
      const res = result(await report({ follow_ups: FU() }));
      const label = typeof verdict === "function" ? "throw" : JSON.stringify(verdict);
      expect(res.status, label).toBe("complete_pending_follow_ups");
      expect(res.followUpsMaterialized.failed[0].retryable, label).toBe(true);
      expect(h.deletes.map((d) => d.Key), label).not.toContain(claimKey);
      expect(claimBody(), label).toMatchObject({ state: "uncertain", hash });
      expect(typeof claimBody().uncertainAt, label).toBe("string");
    }
    expect(h.created).toHaveLength(0);
  });

  // TEAM-5167 R2-01 on the follow-up side: the IfMatch takeover met the same 409/404
  // blind spots — a 409 broke out to claim_in_flight, a 404 (the key deleted between our
  // GET and PUT, per the S3 user guide) read as an S3 error.
  it("R2-01: a 409 on the stale-claim takeover is retried, and the follow-up is created once", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "claimed" });
    h.etags.set(claimKey, '"stale"');
    let conflicts = 0;
    h.putGate = (input) => (input.Key === claimKey && input.IfMatch !== undefined && conflicts++ === 0 ? awsError("ConditionalRequestConflict", 409) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created).toHaveLength(1);
    expect(h.puts.filter((p) => p.Key === claimKey && p.IfMatch === '"stale"')).toHaveLength(2);
    expect(res.status).toBe("complete");
  });

  it("R2-01: a 404 on the takeover (the stale claim was released under us) re-claims create-only and creates once", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "claimed" });
    h.etags.set(claimKey, '"stale"');
    let released = false;
    h.putGate = (input) => {
      if (input.Key !== claimKey || input.IfMatch === undefined || released) return null;
      released = true;
      h.objects.delete(claimKey); h.etags.delete(claimKey); // its owner released it between our GET and our PUT
      return null;
    };
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created).toHaveLength(1);
    expect(res.status).toBe("complete");
    expect(claimBody()).toMatchObject({ state: "created", key: "TEAM-4901" });
    // The re-claim after the 404 was create-only, not another IfMatch attempt.
    expect(h.puts.filter((p) => p.Key === claimKey && p.IfNoneMatch === "*")).toHaveLength(2);
  });

  it("3: a lost claim whose owner already created is skipped as already_materialized with its key, no create", async () => {
    seedClaim({ claimedAt: new Date().toISOString(), state: "created", key: "TEAM-4999" });
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.skipped).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "already_materialized", ticketId: "TEAM-4999" },
    ]);
    expect(res.status).toBe("complete");
  });

  it("4: a STALE claimed claim (its owner died) is taken over with IfMatch and created once", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "claimed" });
    h.etags.set(claimKey, '"stale"');
    const res = result(await report({ follow_ups: FU() }));
    expect(h.created).toHaveLength(1);
    expect(res.followUpsMaterialized.created).toHaveLength(1);
    expect(h.puts.some((p) => p.Key === claimKey && p.IfMatch === '"stale"')).toBe(true);
    expect(claimBody()).toMatchObject({ state: "created", key: "TEAM-4901" });
  });

  it("4b: a FRESH claimed claim that never resolves is claim_in_flight — retryable, no create, Done withheld", async () => {
    seedClaim({ claimedAt: new Date().toISOString(), state: "claimed" });
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "claim_in_flight", retryable: true, commentedOn: [] },
    ]);
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    // Every attempt re-read the claim; nothing overwrote it.
    expect(claimBody().state).toBe("claimed");
  });

  it("4c: a takeover that loses the IfMatch race is claim_in_flight, not a second create", async () => {
    seedClaim({ claimedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), state: "claimed" });
    h.etags.set(claimKey, '"stale"');
    h.putGate = (input) => {
      if (input.Key !== claimKey || input.IfMatch === undefined) return null;
      h.etags.set(claimKey, '"someone-else"'); // another taker won between our Get and our Put
      return null;
    };
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed[0].reason).toBe("claim_in_flight");
  });

  it("5: an S3 error on the claim fails CLOSED — claim_unavailable, retryable, no create, not transitioned", async () => {
    h.putGate = (input) => (input.Key?.startsWith("completion-followups/") ? awsError("InternalError", 500) : null);
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "claim_unavailable", retryable: true, commentedOn: [] },
    ]);
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
  });

  it("5b: a lost claim that cannot be READ is claim_unavailable too", async () => {
    seedClaim({ claimedAt: new Date().toISOString(), state: "claimed" });
    h.getError = { key: claimKey, err: awsError("InternalError", 500) };
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed[0].reason).toBe("claim_unavailable");
  });

  it("6: under a Bug the create still sends parent_key=<Bug> and issue_type Task (the jira twin maps Task-under-Bug to Subtask)", async () => {
    h.issue = ticketRow({ key: "TEAM-4200", summary: "Fix the crash", parent: "TEAM-5000" });
    result(await report({ follow_ups: FU() }));
    const [params] = calls("Tickets___create_ticket");
    expect(params.parent_key).toBe("TEAM-5000");
    expect(params.issue_type).toBe("Task");
    expect(claimBody().state).toBe("created");
  });
});

// TEAM-5167 R2-06: the claims are only claims if the SDK actually serializes
// If-None-Match / If-Match. The Lambda used to rely on the runtime-provided
// @aws-sdk/client-s3, whose minor version varies by runtime and region; an older one
// drops the headers and every claim silently "wins". client-s3 is now bundled AND the
// serializer is probed once per cold start — a conclusive "header missing" fails the
// claims closed (follow-ups: claim_unavailable; notices: post unclaimed, as any other
// claim error), while a probe that cannot run (this mocked SDK) changes nothing.
describe("report_completion — TEAM-5167: SDK conditional-header probe", () => {
  const hash = followUpHash("TEAM-4200", "docs", "Document the new flag");
  const claimKey = `completion-followups/TEAM-4200/${hash}.json`;

  it("the default probe is inconclusive against the mocked SDK, and the claims behave as before", async () => {
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(h.created).toHaveLength(1);
    expect(h.puts.some((p) => p.Key === claimKey && p.IfNoneMatch === "*")).toBe(true);
  });

  it("a conclusive MISSING verdict fails the follow-up claim closed and names the SDK version", async () => {
    h.probe = async () => ({ verdict: "missing", missing: ["PutObject If-None-Match"], sdkVersion: "3.600.0" });
    const res = result(await report({ follow_ups: FU() }));
    expect(calls("Tickets___create_ticket")).toHaveLength(0);
    expect(res.followUpsMaterialized.failed).toEqual([
      { hash, kind: "docs", title: "Document the new flag", reason: "claim_unavailable", retryable: true, commentedOn: [] },
    ]);
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(transitioned()).toBe(false);
    // No conditional PUT was even attempted — the claim would not have been one.
    expect(h.puts.some((p) => p.Key === claimKey)).toBe(false);
    expect(h.warns.join("\n")).toMatch(/If-None-Match[^\n]*3\.600\.0|3\.600\.0[^\n]*If-None-Match/);
  });

  it("a MISSING verdict still posts an unfiled notice — unclaimed, like any other claim error", async () => {
    h.probe = async () => ({ verdict: "missing", missing: ["PutObject If-None-Match"], sdkVersion: "3.600.0" });
    // epic_unresolved needs no create claim: the ticket provably has no epic, so the
    // entry is non-retryable and its notice goes on the source ticket.
    h.issue = ticketRow({ key: "TEAM-4200", summary: "Fix the crash", parent: null });
    const res = result(await report({ follow_ups: FU() }));
    expect(res.status).toBe("complete");
    expect(res.followUpsMaterialized.failed[0].reason).toBe("epic_unresolved");
    expect((h.comments.get("TEAM-4200") || []).filter((c) => c.includes("[fu-unfiled:"))).toHaveLength(1);
    expect(h.puts.some((p) => p.Key?.startsWith("completion-notices/"))).toBe(false);
    expect(h.warns.join("\n")).toMatch(/posting the unfiled-follow-up notice without the claim/);
  });
});

describe("report_completion — FR-5 cd-ledger derived follow-ups (amendment A3)", () => {
  const ledger = (body) => h.objects.set(CD_LEDGER_KEY, JSON.stringify(body));

  it("an unmerged marker becomes ONE agent-owned fix ticket with base_branch main", async () => {
    h.siblings.push(CD);
    ledger({ execution_id: EXEC_ID, unmerged: { commits: ["a1b2c3d"], files: ["deploy/config.sh"] } });
    const res = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE }));
    expect(res.status).toBe("complete");
    const [fu] = record().followUps;
    expect(fu.kind).toBe("fix");
    expect(fu.owner).toBe("agent");
    expect(fu.assignee).toBe("agentcore_hub_bug_fixer");
    expect(fu.baseBranch).toBe("main");
    expect(fu.detail).toContain("a1b2c3d");
    expect(fu.detail).toContain("deploy/config.sh");
    const p = h.created[0].params;
    expect(p.base_branch).toBe("main");
    expect(p.spawned_by).toEqual({ kind: "ship_fix", shipTicketId: "TEAM-4199" });
    // Never a human handoff — that is the whole point of A3.
    expect(p.assignee).not.toMatch(/^human:/);
  });

  it("the older cd_unmerged spelling is read the same way", async () => {
    h.siblings.push(CD);
    ledger({ cd_unmerged: { commits: ["deadbee"] } });
    await report({ merge_commit: MERGE_COMMIT });
    expect(record().followUps[0].baseBranch).toBe("main");
  });

  it("a handoff[] of three steps collapses into ONE human:engineer ticket", async () => {
    // Three tickets in one person's queue, for one sitting at one console, is three
    // chances to close two and forget the third.
    h.siblings.push(CD);
    ledger({ handoff: ["Enable the flag in the console", { step: "Attach the IAM policy" }, "Re-run the smoke test"] });
    await report({ merge_commit: MERGE_COMMIT });
    const followUps = record().followUps;
    expect(followUps).toHaveLength(1);
    expect(followUps[0].kind).toBe("console_handoff");
    expect(followUps[0].assignee).toBe("human:engineer");
    expect(followUps[0].title).toBe("Post-merge console/IAM handoff (3 steps)");
    expect(followUps[0].detail).toBe("1. Enable the flag in the console\n2. Attach the IAM policy\n3. Re-run the smoke test");
    expect(h.created).toHaveLength(1);
    expect(h.created[0].params.assignee).toBe("human:engineer");
  });

  it("the ledger's entries share the agent's caps and dedupe, not a second budget", async () => {
    h.siblings.push(CD);
    ledger({ handoff: ["Enable the flag"] });
    await report({
      merge_commit: MERGE_COMMIT,
      // The agent already reported the same handoff by hand.
      follow_ups: JSON.stringify([{ kind: "console_handoff", owner: "human", title: "Post-merge console/IAM handoff (1 steps)" }]),
    });
    expect(record().followUps).toHaveLength(1);
    expect(h.created).toHaveLength(1);
  });

  it("is not read at all for an ordinary dev completion, and an ABSENT one is not fatal", async () => {
    // No outcome and no merge commit ⇒ no ship claim ⇒ no reason to pay the GET.
    await report({ pr_url: PR_URL });
    expect(h.gets.map((g) => g.Key)).not.toContain(CD_LEDGER_KEY);

    // A ledger that provably does not exist (NoSuchKey) is a DEFINITE negative: it
    // contributes nothing and refuses nothing. TEAM-4754 splits this from the other
    // half — an unreadable one now refuses; see the block below.
    h.puts.length = 0;
    const res = result(await report({ merge_commit: MERGE_COMMIT, pr_url: PR_URL }));
    expect(res.status).toBe("complete");
    expect("followUps" in record()).toBe(false);
  });
});

// ─── TEAM-4754: an UNREADABLE cd-ledger refuses the ship report ────────────────
//
// The same defect N2 fixes, one read earlier. `readCdLedger` returned `null` for
// both "there is no ledger" and "we could not read it", and `ledgerFollowUps(null)`
// is `[]` — so an AccessDenied or a truncated body made FR-5's console/IAM handoffs
// and its unmerged-to-main fix evaporate while the CD ticket closed green.
//
// It takes D1's shape, not N2's, and the reason is ordering: this read is BEFORE
// the S3 write, so nothing durable exists yet and refuse-and-retry costs nothing.
describe("report_completion — cd_ledger_unreadable (three-outcome ledger read)", () => {
  const failGet = (name, extra = {}) => {
    const err = new Error(`${name} on the ledger`);
    err.name = name;
    Object.assign(err, extra);
    h.getError = { key: CD_LEDGER_KEY, err };
  };
  const shipReport = (extra) => report({
    outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_execution_id: EXEC_ID, pipeline_name: PIPELINE, ...extra,
  });

  for (const [label, name, extra] of [
    ["AccessDenied", "AccessDenied", {}],
    ["a 503", "ServiceUnavailable", { $metadata: { httpStatusCode: 503 } }],
  ]) {
    it(`refuses on ${label}: nothing recorded, nothing transitioned, nothing announced`, async () => {
      // DL-030 has to pass FIRST, or this would be asserting the wrong refusal.
      h.objects.set(CD_LEDGER_KEY, JSON.stringify({ execution_id: EXEC_ID }));
      failGet(name, extra);
      const r = result(await shipReport({}));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("cd_ledger_unreadable");
      expect(r.missing).toEqual([]);
      expect(r.message).toMatch(/could not be read/);
      expect(r.message).toMatch(/Nothing was recorded and the ticket was NOT transitioned\. Retry the call\./);
      expect(wroteRecord()).toBe(false);
      expect(transitioned()).toBe(false);
      expect(events("delivery.prState")).toHaveLength(0);
      // It refuses BEFORE the ticket read, so a refusal costs one GET and nothing else.
      expect(calls("Tickets___get_issue")).toHaveLength(0);
      expect(h.created).toHaveLength(0);
      expect(h.warns.join("\n")).toMatch(/cd-ledger body .* was UNREADABLE/);
      expect(h.warns.join("\n")).toMatch(/REFUSED TEAM-4200: cd_ledger_unreadable/);
    });
  }

  it("refuses on a body that is present but not JSON — a body we cannot parse is a body we did not read", async () => {
    h.objects.set(CD_LEDGER_KEY, "{ this is truncated");
    const r = result(await shipReport({}));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cd_ledger_unreadable");
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("a DEFINITE NoSuchKey proceeds exactly as before", async () => {
    // The whole point of three outcomes: only this one licenses proceeding.
    h.siblings.push(CD);
    const r = result(await shipReport({}));
    expect(r.status).toBe("complete");
    expect(wroteRecord()).toBe(true);
    expect(transitioned()).toBe(true);
    expect("followUps" in record()).toBe(false);
  });

  it("a readable ledger still contributes its follow-ups", async () => {
    h.siblings.push(CD);
    h.objects.set(CD_LEDGER_KEY, JSON.stringify({ handoff: ["Enable the flag in the console"] }));
    const r = result(await shipReport({}));
    expect(r.status).toBe("complete");
    expect(record().followUps).toHaveLength(1);
    expect(h.created).toHaveLength(1);
  });

  it("an ordinary dev completion is UNAFFECTED — only a ship-shaped report pays", async () => {
    // The gate is `report.outcome || report.merge_commit`, so a dev completion never
    // reads the ledger and therefore cannot be refused by a ledger it never touched.
    failGet("AccessDenied");
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(wroteRecord()).toBe(true);
    expect(transitioned()).toBe(true);
    expect(h.gets.map((g) => g.Key)).not.toContain(CD_LEDGER_KEY);
  });

  it("sits with the other pre-write refusals: DL-030 still refuses FIRST", async () => {
    // Ordering matters because both are pre-write: a ship claim missing its execution
    // id must report THAT, not a ledger problem it never got far enough to have.
    // `pipeline_name` with no execution id is the case DL-030 refuses outright (a
    // named pipeline cannot be the legacy DEPLOY.md path).
    failGet("AccessDenied");
    const r = result(await report({ outcome: "shipped", merge_commit: MERGE_COMMIT, pipeline_name: PIPELINE }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("shipped_requires_execution_and_merge_commit");
    // The ledger body is never even fetched, so the refusal costs nothing extra.
    expect(h.gets.map((g) => g.Key)).not.toContain(CD_LEDGER_KEY);
  });

  it("refuses BEFORE mainFixRefusal, which is the next pre-write gate", async () => {
    // Both refuse before anything durable; this one is first because it is the one
    // that already spent its read. A base_branch=main ticket with no PR would be
    // refused by FR-5 — but the ledger failure is what the agent must retry.
    h.issue = ticketRow({ key: "TEAM-4200", description: "base_branch: main" });
    failGet("AccessDenied");
    const r = result(await shipReport({ pr_url: "" }));
    expect(r.reason).toBe("cd_ledger_unreadable");
    expect(wroteRecord()).toBe(false);
  });
});

describe("report_completion — FR-5 main_fix_requires_pr", () => {
  // The line both twins write into the description (FR-12) and this Lambda parses.
  const withBase = (branch) => ticketRow({ key: "TEAM-4200", description: `Fix the expired-token path.\n\nbase_branch: ${branch}` });

  it("refuses a base_branch=main completion with no PR, writing nothing and transitioning nothing", async () => {
    h.issue = withBase("main");
    const r = result(await report({}));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("main_fix_requires_pr");
    expect(r.detail).toBe("no_pr_url");
    expect(r.missing).toEqual(["pr_url"]);
    expect(r.message).toContain("Nothing was recorded and the ticket was NOT transitioned.");
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    expect(events("delivery.prState")).toHaveLength(0);
    // The log names WHICH negative fired, so the four are distinguishable in
    // CloudWatch — it used to print a hardcoded "(base_branch: main, no pr_url)"
    // that would have been a lie for three of them.
    expect(h.warns.join("\n")).toContain("main_fix_requires_pr (no_pr_url)");
  });

  it("accepts it the moment the PR to main exists — but says the acceptance is UNVERIFIED", async () => {
    // TEAM-4752 D3: the ticket IS read now (base_branch lives nowhere else), and
    // with no GITHUB_TOKEN configured the acceptance rests on the report's word —
    // which the response now says out loud instead of implying GitHub agreed.
    h.issue = withBase("main");
    const res = await report({ pr_url: PR_URL });
    expect(result(res).status).toBe("complete");
    expect(result(res).prBaseVerification).toBe("unverified");
    expect(record().delivery.prState).toBe("open");
    expect(calls("Tickets___get_issue")).toHaveLength(1);
  });

  it("refuses a pr_url that is not a GitHub pull-request URL at all — with no fetch", async () => {
    // The defect: `asText(pr_url).trim()` accepted anything non-blank, so "TBD" or a
    // branch name satisfied "a completion must carry the PR to main".
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const bad of ["TBD", "feature/TEAM-4200-fix", "https://github.com/owner/repo/pulls/42", "https://gitlab.com/o/r/pull/1", "https://github.com/owner/repo/pull/42?x=1", "https://github.com/./r/pull/1"]) {
        h.puts.length = 0;
        h.calls.length = 0;
        h.issue = withBase("main");
        const r = result(await report({ pr_url: bad }));
        expect(r.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
        expect(r.reason).toBe("main_fix_requires_pr");
        expect(r.detail).toBe("pr_url_not_a_github_pr");
        expect(r.message).toContain(JSON.stringify(bad));
        expect(r.message).toContain("Nothing was recorded and the ticket was NOT transitioned.");
        expect(wroteRecord()).toBe(false);
        expect(transitioned()).toBe(false);
      }
      // A definite negative needs no network: it is provable from the report.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not fire for any other base branch", async () => {
    h.issue = withBase("feature/TEAM-4734-integration");
    expect(result(await report({})).status).toBe("complete");
    expect(transitioned()).toBe(true);
  });

  it("FAILS OPEN when the ticket cannot be read, or carries no base_branch line", async () => {
    // An unreadable ticket is not evidence that the branch is main; refusing on a
    // failed look would wedge every completion whenever the ticket Lambda throttles.
    h.ticketFail.add("Tickets___get_issue");
    expect(result(await report({})).status).toBe("complete");
    expect(h.warns.join("\n")).toMatch(/get_issue was unreadable/);
    expect(transitioned()).toBe(true);

    // Same for the Jira twin's shape, whose get_issue returns no description at
    // all — a stated limitation of this check, not a silent one.
    h.ticketFail.clear();
    h.issue = { ticketId: "TEAM-4200", title: "Fix it", status: "in_progress", assignee: "agentcore_hub_api_dev", parentKey: "TEAM-4100" };
    expect(result(await report({})).status).toBe("complete");
  });
});

// ─── TEAM-4752 D3: the base branch of the PR, asked of GitHub ──────────────────
//
// `main_fix_requires_pr` used to be satisfied by any non-blank `pr_url`, so a fix
// to main "delivered" by a PR to the integration branch passed the very check that
// exists to catch it — that PR is superseded the moment the integration branch
// merges, which is the TEAM-4663 failure the FR-5 refusal was written for.
//
// The rule: refuse only on an answer GITHUB GAVE. Everything else — no token, a
// 500, a timeout — is accepted and LABELLED, because a check that wedges every
// completion whenever GitHub is slow would be removed within a week.
describe("report_completion — FR-5 verifies the PR's base branch (D3)", () => {
  const withBase = (branch) => ticketRow({ key: "TEAM-4200", description: `Fix the expired-token path.\n\nbase_branch: ${branch}` });

  /** Stub GitHub's one GET. `reply` gets the URL and returns a Response-ish. */
  const stubGitHub = (reply) => {
    const spy = vi.fn(async (url, init) => reply(String(url), init));
    vi.stubGlobal("fetch", spy);
    return spy;
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status) => ({ ok: false, status, json: async () => ({ message: "nope" }) });

  beforeEach(() => { process.env.GITHUB_TOKEN = "ghp_test_token_value"; });
  afterEach(() => { delete process.env.GITHUB_TOKEN; vi.unstubAllGlobals(); });

  it("200 + base.ref main ⇒ accepted and stamped `verified`, from the right URL", async () => {
    h.issue = withBase("main");
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r.prBaseVerification).toBe("verified");
    expect(transitioned()).toBe(true);
    // Derived from the parsed URL, never pasted: owner/repo/number only.
    expect(spy.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/pulls/42");
    const init = spy.mock.calls[0][1];
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    // Bounded, and by less than the Lambda's own budget.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("200 + base.ref anything else ⇒ REFUSED, and the message names the base observed", async () => {
    h.issue = withBase("main");
    stubGitHub(() => ok({ base: { ref: "feature/TEAM-4734--si-x" } }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("main_fix_requires_pr");
    expect(r.detail).toBe("pr_base_not_main");
    expect(r.message).toContain(JSON.stringify("feature/TEAM-4734--si-x"));
    expect(r.message).toContain("Nothing was recorded and the ticket was NOT transitioned.");
    // A refusal leaves NO trace: no record, no events, no transition.
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    expect(events("delivery.prState")).toHaveLength(0);
    expect(events("workflow.report_completion")).toHaveLength(0);
    expect(r).not.toHaveProperty("prBaseVerification");
  });

  it("404 ⇒ REFUSED: a PR the hub cannot see is not evidence", async () => {
    h.issue = withBase("main");
    stubGitHub(() => fail(404));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("pr_not_found");
    expect(r.message).toContain("owner/repo#42");
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
  });

  it("no GITHUB_TOKEN ⇒ accepted, stamped `unverified`, and NO call attempted", async () => {
    delete process.env.GITHUB_TOKEN;
    h.issue = withBase("main");
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r.prBaseVerification).toBe("unverified");
    expect(spy).not.toHaveBeenCalled();
    expect(h.warns.join("\n")).toContain("pr base UNVERIFIED (no GITHUB_TOKEN)");
  });

  it.each([500, 502, 403, 401, 429])("GitHub %i ⇒ accepted, stamped `indeterminate` (fail-open)", async (status) => {
    h.issue = withBase("main");
    stubGitHub(() => fail(status));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r.prBaseVerification).toBe("indeterminate");
    expect(transitioned()).toBe(true);
    expect(h.warns.join("\n")).toContain(`pr base INDETERMINATE for owner/repo#42 (GitHub ${status})`);
  });

  it("a timeout ⇒ accepted, stamped `indeterminate` — a slow GitHub cannot wedge a run", async () => {
    h.issue = withBase("main");
    stubGitHub(() => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; });
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r.prBaseVerification).toBe("indeterminate");
    expect(transitioned()).toBe(true);
    expect(h.warns.join("\n")).toContain("pr base INDETERMINATE for owner/repo#42 (TimeoutError");
  });

  it("200 with no base.ref at all ⇒ indeterminate, not 'verified'", async () => {
    // A body we cannot read is not a body that said "main".
    h.issue = withBase("main");
    stubGitHub(() => ok({ number: 42 }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r.prBaseVerification).toBe("indeterminate");
  });

  it("makes NO call, and stamps nothing, when the ticket's base branch is not main", async () => {
    h.issue = withBase("feature/TEAM-4734-integration");
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(r).not.toHaveProperty("prBaseVerification");
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes NO call when the ticket states no base branch at all — the ordinary report", async () => {
    // The shape almost every completion in the fleet has. It must not acquire a
    // GitHub dependency.
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const r = result(await report({ pr_url: PR_URL }));
    expect(r.status).toBe("complete");
    expect(Object.keys(r).sort()).toEqual(["message", "status"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never puts the token anywhere but the Authorization header", async () => {
    h.issue = withBase("main");
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const res = await report({ pr_url: PR_URL });
    const TOKEN = "ghp_test_token_value";
    expect(spy.mock.calls[0][1].headers.Authorization).toBe(`token ${TOKEN}`);
    // Not in the URL, not in a log line, not on the response, not in the record.
    expect(spy.mock.calls[0][0]).not.toContain(TOKEN);
    expect(h.warns.join("\n")).not.toContain(TOKEN);
    expect(res.content[0].text).not.toContain(TOKEN);
    expect(JSON.stringify(record())).not.toContain(TOKEN);
  });

  it("accepts the api.github.com form of the URL too", async () => {
    // Blueprints paste whichever form the merge worker returned.
    h.issue = withBase("main");
    const spy = stubGitHub(() => ok({ base: { ref: "main" } }));
    const r = result(await report({ pr_url: "https://api.github.com/repos/owner/repo/pulls/42" }));
    expect(r.prBaseVerification).toBe("verified");
    expect(spy.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/pulls/42");
  });
});

// ─── TEAM-4740 FR-10: the empty sweep ─────────────────────────────────────────
//
// A dead-code sweep that finds nothing has no diff, no PR and nothing to merge —
// but it has a full downstream chain (dev, review, CI, QA, ship, CD) sitting on it.
// Before FR-10 the run either faked a ship or left those tickets open forever. Now
// the sweeper closes them itself, each with a record saying why, and the ORDER it
// closes them in is the part that can go silently wrong: a done ticket cascades, so
// closing a blocker before its dependent hands a live agent a ticket for a diff
// that does not exist.

/** The skip record written for `key`, parsed (undefined if none was written). */
const skipRecord = (key) => {
  const put = h.puts.find((p) => p.Key === `completions/${key}.json`);
  return put ? JSON.parse(put.Body) : undefined;
};
/** Every ticket a skip record was written for, in write order. */
const skipRecordOrder = () =>
  h.puts.filter((p) => p.Key?.startsWith("completions/") && p.Key !== "completions/TEAM-4640.json")
    .map((p) => p.Key.replace("completions/", "").replace(".json", ""));

const sweep = (extra) =>
  report({
    ticket_id: "TEAM-4640", agent_id: "agentcore_hub_api_dev",
    summary: "Swept 41 modules; every candidate is still referenced. No removals.",
    outcome: "empty_sweep", ...extra,
  });

describe("report_completion — FR-10 empty_sweep", () => {
  // The fz514x chain: the sweeper (4640) then dev (4643) → review (4644) → ship
  // (4645). Reverse topological order is 4645, 4644, 4643.
  beforeEach(() => {
    h.issue = ticketRow({ key: "TEAM-4640", summary: "Sweep dead code", assignee: "agentcore_hub_api_dev", status: "in_progress" });
    h.siblings.push(
      ticketRow({ key: "TEAM-4640", summary: "Sweep dead code", assignee: "agentcore_hub_api_dev", status: "in_progress", created: "2026-09-17T09:00:00.000Z" }),
      ticketRow({ key: "TEAM-4643", summary: "Remove the dead modules", assignee: "agentcore_hub_api_dev", created: "2026-09-17T09:01:00.000Z", blockedBy: ["TEAM-4640"] }),
      ticketRow({ key: "TEAM-4644", summary: "Review the removals", assignee: "agentcore_hub_code_reviewer", created: "2026-09-17T09:02:00.000Z", blockedBy: ["TEAM-4643"] }),
      ticketRow({ key: "TEAM-4645", summary: "Ship the sweep", assignee: "agentcore_hub_release_manager", created: "2026-09-17T09:03:00.000Z", blockedBy: ["TEAM-4644"] }),
    );
  });

  it("skips every open sibling, DEPENDENTS FIRST, and reports them in that order", async () => {
    const res = result(await sweep());
    expect(res.status).toBe("complete");
    // Deepest dependent first. Get this backwards and the run dispatches the dev
    // ticket for a sweep that removed nothing.
    expect(res.emptySweepSkipped).toEqual(["TEAM-4645", "TEAM-4644", "TEAM-4643"]);
    expect(res).not.toHaveProperty("emptySweepFailed");
    // The records were written in the same order as the transitions.
    expect(skipRecordOrder()).toEqual(["TEAM-4645", "TEAM-4644", "TEAM-4643"]);
  });

  it("writes a real completion record for each — the harvest reads `summary`", async () => {
    await sweep();
    expect(skipRecord("TEAM-4644")).toEqual({
      ticketId: "TEAM-4644",
      workflowId: "wf_1",
      summary: "Skipped: empty_sweep — no removals found by TEAM-4640",
      evidence_kind: "skipped",
      skipped: true,
      reason: "empty_sweep",
    });
    // "skipped" has to be IN the closed vocabulary or the record's own
    // evidence_kind would be dropped by the check that guards every other field.
    expect(skipRecord("TEAM-4643").evidence_kind).toBe("skipped");
  });

  it("writes each record BEFORE that ticket's transition — the DL-030 ship guard", async () => {
    // The tickets twin refuses `done` on a ship-phase ticket with no completion
    // record. Record-second would make the sweep unable to close TEAM-4645 at all.
    // The gate is used here purely as an observer: it reports, at the instant of
    // each transition, whether that ticket's record already existed.
    const at = [];
    h.transitionGate = (params) => {
      at.push({ id: params.ticket_id, hadRecord: h.objects.has(`completions/${params.ticket_id}.json`) });
      return true;
    };
    await sweep();
    expect(at.map((a) => a.id)).toEqual(["TEAM-4645", "TEAM-4644", "TEAM-4643", "TEAM-4640"]);
    for (const a of at) expect(a.hadRecord, a.id).toBe(true);
  });

  it("skips them BEFORE the sweeper's own transition, so the cascade finds them done", async () => {
    await sweep();
    const transitions = calls("Tickets___transition_ticket").map((p) => p.ticket_id);
    // The sweeper is LAST. Its Done is what cascades; by then every dependent is
    // already closed.
    expect(transitions[transitions.length - 1]).toBe("TEAM-4640");
    expect(transitions.slice(0, -1)).toEqual(["TEAM-4645", "TEAM-4644", "TEAM-4643"]);
  });

  it("falls back to block→skip when the provider only offers skip from blocked", async () => {
    // The DynamoDB twin's transition map has `skip` only on `blocked`. The Jira twin
    // maps skip→Done from anywhere. Trying skip first needs no knowledge of either
    // provider's status NAMES — the part that would rot.
    let firstSkip = true;
    h.siblings.length = 0;
    h.siblings.push(ticketRow({ key: "TEAM-4643", summary: "Remove the dead modules", created: "2026-09-17T09:01:00.000Z" }));
    h.transitionGate = (params) => {
      if (params.transition_id === "skip" && firstSkip) { firstSkip = false; return false; }
      return true;
    };
    const res = result(await sweep());
    expect(res.emptySweepSkipped).toEqual(["TEAM-4643"]);
    expect(calls("Tickets___transition_ticket").filter((p) => p.ticket_id === "TEAM-4643").map((p) => p.transition_id))
      .toEqual(["skip", "block", "skip"]);
    h.transitionGate = null;
  });

  it("carries the reason onto the transition, so a skipped ticket explains itself", async () => {
    await sweep();
    const skip = calls("Tickets___transition_ticket").find((p) => p.ticket_id === "TEAM-4645");
    expect(skip).toEqual({ ticket_id: "TEAM-4645", transition_id: "skip", reason: "empty_sweep — no removals found by TEAM-4640" });
  });

  it("leaves human gates and already-done siblings alone", async () => {
    h.siblings.push(
      ticketRow({ key: "TEAM-4646", summary: "Merge Approval", assignee: "human:engineer", status: "in_review", created: "2026-09-17T09:04:00.000Z" }),
      ticketRow({ key: "TEAM-4641", summary: "Requirements", assignee: "agentcore_hub_requirements_analyst", status: "done", created: "2026-09-17T08:59:00.000Z" }),
    );
    const res = result(await sweep());
    // A human's queue is not ours to clear, and a done ticket needs nothing.
    expect(res.emptySweepSkipped).not.toContain("TEAM-4646");
    expect(res.emptySweepSkipped).not.toContain("TEAM-4641");
    expect(skipRecord("TEAM-4646")).toBeUndefined();
    expect(skipRecord("TEAM-4641")).toBeUndefined();
    // …and never itself.
    expect(res.emptySweepSkipped).not.toContain("TEAM-4640");
  });

  it("the sweeper's OWN record is an honest terminal outcome, not a ship", async () => {
    await sweep();
    const own = JSON.parse(h.puts.find((p) => p.Key === "completions/TEAM-4640.json").Body);
    expect(own.outcome).toBe("empty_sweep");
    expect(own.pr_url).toBeNull();
    // Nothing was merged and nothing is open, so neither "merged" nor "open" would
    // be true.
    expect(own.delivery).toEqual({ prUrl: null, prState: "unknown" });
  });

  it("keeps going when one skip fails, and reports which", async () => {
    h.transitionGate = (params) => params.ticket_id !== "TEAM-4644";
    const res = result(await sweep());
    // Partial closure with no record of which is the worst of the three states.
    expect(res.emptySweepSkipped).toEqual(["TEAM-4645", "TEAM-4643"]);
    expect(res.emptySweepFailed).toEqual([{ ticketId: "TEAM-4644", reason: expect.stringContaining("Error") }]);
    expect(res.status).toBe("complete");
    h.transitionGate = null;
  });

  it("orders a row whose blockedBy is unreadable as a leaf", () => {
    // list_tickets omits blockedBy in BOTH twins, so the order comes from one
    // get_issue per sibling — and a failed read leaves the row a leaf. Skipping a
    // ticket too EARLY only risks a cascade touching something about to be skipped;
    // skipping a blocker too early hands its dependent to a live agent. So a leaf
    // must sort first, which is what this pins.
    expect(sweepSkipOrder([
      { ticketId: "A", blockedBy: [] },
      { ticketId: "B", blockedBy: ["A"] },
      { ticketId: "C", blockedBy: [] },
      { ticketId: "D", blockedBy: ["B"] },
    ]).map((r) => r.ticketId)).toEqual(["D", "B", "A", "C"]);
    // A blocker outside the set is not a dependency we are ordering against, and a
    // cycle (never valid, never trusted) must not recurse forever.
    expect(sweepSkipOrder([{ ticketId: "A", blockedBy: ["TEAM-OUTSIDE"] }]).map((r) => r.ticketId)).toEqual(["A"]);
    expect(sweepSkipOrder([
      { ticketId: "A", blockedBy: ["B"] },
      { ticketId: "B", blockedBy: ["A"] },
    ])).toHaveLength(2);
  });

  // ── TEAM-4752 D1: an unknown roster REFUSES the report ────────────────────────
  //
  // These two replace "says so out loud when the epic is unreadable, rather than
  // passing as done", which accepted the report, warned, and transitioned the
  // sweeper anyway. Warning is not enough here: the sweeper's Done is what
  // CASCADES, so accepting it hands every downstream ticket to a live agent for a
  // diff that does not exist — the FR-10 failure this feature exists to prevent.
  it("REFUSES the report when the sweeper's own ticket is unreadable — its epic is unknown", async () => {
    h.ticketFail.add("Tickets___get_issue");
    const res = result(await sweep());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sibling_scan_failed");
    // Nothing durable, nothing announced, nothing transitioned — the persona retries.
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    expect(events("workflow.report_completion")).toHaveLength(0);
    expect(events("delivery.prState")).toHaveLength(0);
    expect(res.message).toContain("the ticket was NOT transitioned");
    expect(res.message).toContain("Retry the call");
    expect(h.warns.join("\n")).toMatch(/REFUSED TEAM-4640: sibling_scan_failed \(get_issue:/);
  });

  it("REFUSES the report when the sibling scan under a known epic fails", async () => {
    h.ticketFail.add("Tickets___list_tickets");
    const res = result(await sweep());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sibling_scan_failed");
    expect(res.message).toContain("the sibling scan under TEAM-4100 failed");
    expect(res.message).toContain("cascade the run onto a diff that does not exist");
    expect(wroteRecord()).toBe(false);
    expect(transitioned()).toBe(false);
    // No sibling was touched either — a refusal leaves no partial sweep behind.
    expect(h.puts.filter((p) => p.Key?.startsWith("completions/"))).toHaveLength(0);
  });

  it("still ACCEPTS a sweeper that provably has no parent — that is a definite negative", async () => {
    // "We looked and there is no epic" is knowledge; "we could not look" is not.
    // Only the second refuses. This keeps the pre-4752 warn-and-proceed path for a
    // parentless sweeper, which has no siblings to close by construction.
    h.issue = ticketRow({ key: "TEAM-4640", summary: "Sweep dead code", parent: null });
    const res = result(await sweep());
    expect(res.status).toBe("complete");
    expect(res).not.toHaveProperty("emptySweepSkipped");
    expect(transitioned()).toBe(true);
    expect(calls("Tickets___list_tickets")).toHaveLength(0);
    expect(h.warns.join("\n")).toContain("the ticket has no parent");
  });

  it("ACCEPTS a readable but EMPTY roster, and says which it was", async () => {
    h.siblings.length = 0;
    const res = result(await sweep());
    expect(res.status).toBe("complete");
    expect(res).not.toHaveProperty("emptySweepSkipped");
    expect(h.warns.join("\n")).toContain("the sibling roster is readable but EMPTY under TEAM-4100");
  });

  it("an ordinary completion runs no sweep at all", async () => {
    h.siblings.push(ticketRow({ key: "TEAM-4643", summary: "Remove the dead modules" }));
    const res = result(await report({ pr_url: PR_URL }));
    expect(res).not.toHaveProperty("emptySweepSkipped");
    expect(calls("Tickets___transition_ticket")).toHaveLength(1);
    expect(skipRecord("TEAM-4643")).toBeUndefined();
  });
});

// ─── TEAM-4740 FR-11: submit_ticket_plan normalization ────────────────────────
//
// This tool creates nothing — the agent then calls Tickets___create_ticket per
// ticket — so the only thing it can fix is the text the agent copies FROM. Two
// things in that text have cost real runs: a branch name the analyst invented (the
// devs end up on different branches), and a plan whose first tickets name no
// blocker at all (the orchestrator dispatches them before the requirements they
// were planned from are done).

const PLAN = [
  { title: "Requirements", description: "Analyse the request.", assignee: "agentcore_hub_requirements_analyst", blockedBy: [] },
  { title: "API work", description: "Build it on feature/my-own-branch-name.", assignee: "agentcore_hub_api_dev", blockedBy: [] },
  { title: "Spec Approval", description: "Approve the spec.", assignee: "human:product-owner", blockedBy: [] },
];
const BRANCH = "feature/TEAM-4100-add-retry";

const plan = (extra) =>
  handler({
    tool_name: "WorkflowOutput___submit_ticket_plan",
    arguments: { workflow_id: "wf_1", epic_id: "TEAM-4100", tickets: JSON.stringify(PLAN), ...extra },
  });
/** The persisted plan, parsed. */
const savedPlan = () => JSON.parse(h.puts.find((p) => p.Key === "workflows/wf_1/shared/ticket-plan.json").Body);
const planTicket = (tickets, title) => tickets.find((t) => t.title === title);

describe("submit_ticket_plan — FR-11 normalization", () => {
  beforeEach(() => {
    h.workflow = { workflowId: "wf_1", featureBranch: BRANCH };
    h.siblings.push(
      ticketRow({ key: "TEAM-4101", summary: "Requirements", assignee: "agentcore_hub_requirements_analyst", created: "2026-09-17T09:00:00.000Z" }),
      ticketRow({ key: "TEAM-4102", summary: "Spec Approval", assignee: "human:product-owner", created: "2026-09-17T08:00:00.000Z" }),
    );
  });

  it("parses the JSON-array STRING main.py sends, and fixes ticket_count", async () => {
    const res = result(await plan());
    // Was `tickets.length` on a STRING before 4740 — a character count.
    expect(res.ticket_count).toBe(3);
    expect(res.tickets).toHaveLength(3);
    expect(savedPlan().tickets).toHaveLength(3);
  });

  it("accepts a real array too", async () => {
    const res = result(await plan({ tickets: PLAN }));
    expect(res.ticket_count).toBe(3);
  });

  it("replaces a coined branch name with the run's recorded featureBranch", async () => {
    const res = result(await plan());
    const api = planTicket(res.tickets, "API work");
    expect(api.description).toContain(BRANCH);
    expect(api.description).not.toContain("feature/my-own-branch-name");
    expect(res.integration_branch).toBe(BRANCH);
    // Read from the workflows table, by key, for that one field only.
    expect(h.workflowGets).toEqual([{
      TableName: "agentcore-hub-workflows", Key: { workflowId: "wf_1" }, ProjectionExpression: "featureBranch",
    }]);
  });

  it("appends the integration-branch note to every description, exactly once", async () => {
    const res = result(await plan());
    const note = `Integration branch: ${BRANCH} (orchestrator-provided; do not coin branch names)`;
    for (const t of res.tickets) expect(t.description).toContain(note);
    // Re-submitting the normalized plan must not accrete a second copy.
    const again = result(await plan({ tickets: JSON.stringify(res.tickets) }));
    for (const t of again.tickets) {
      expect(t.description.split(note)).toHaveLength(2);
    }
  });

  it("blocks every unblocked AGENT ticket on the run's root ticket", async () => {
    const res = result(await plan());
    // Root = earliest-created NON-human sibling: the analyst's own ticket. Not the
    // Spec Approval gate, which was created earlier but is a human's.
    expect(res.autowired).toEqual({ reason: "no_root_blocker", rootTicketId: "TEAM-4101", tickets: ["API work"] });
    expect(planTicket(res.tickets, "API work").blockedBy).toEqual(["TEAM-4101"]);
    // Never the root itself (matched by title), and never a human gate — a gate
    // waiting on the work it gates is a deadlock.
    expect(planTicket(res.tickets, "Requirements").blockedBy).toEqual([]);
    expect(planTicket(res.tickets, "Spec Approval").blockedBy).toEqual([]);
  });

  it("emits plan.autowired ONCE for the whole plan", async () => {
    await plan();
    expect(events("plan.autowired")).toHaveLength(1);
    expect(events("plan.autowired")[0].detail).toEqual({
      workflowId: "wf_1", reason: "no_root_blocker", rootTicketId: "TEAM-4101", tickets: ["API work"],
    });
  });

  it("leaves an explicit blockedBy alone — the analyst's chain is authoritative", async () => {
    const res = result(await plan({
      tickets: JSON.stringify([{ title: "QA", description: "Verify.", assignee: "agentcore_hub_qa_verifier", blockedBy: ["API work"] }]),
    }));
    expect(planTicket(res.tickets, "QA").blockedBy).toEqual(["API work"]);
    expect(res).not.toHaveProperty("autowired");
    expect(events("plan.autowired")).toHaveLength(0);
  });

  it("tells the agent the returned plan is the authoritative one", async () => {
    const res = result(await plan());
    expect(res.message).toContain("EXACTLY as returned");
    expect(res.message).toContain("does not create tickets");
  });

  it("persists what normalization DID, so the plan record is auditable", async () => {
    await plan();
    // "No branch was recorded" and "the branch was already right" are different
    // facts, so each additive key is present only when known.
    expect(savedPlan()).toMatchObject({
      epic_id: "TEAM-4100",
      featureBranch: BRANCH,
      autowired: { reason: "no_root_blocker", rootTicketId: "TEAM-4101", tickets: ["API work"] },
    });
    expect(savedPlan().tickets[1].blockedBy).toEqual(["TEAM-4101"]);
  });

  it("FAILS OPEN on an unparseable plan: persisted verbatim, nothing normalized", async () => {
    const res = result(await plan({ tickets: "[{title: 'not json'}" }));
    expect(res.status).toBe("saved");
    expect(res.ticket_count).toBeNull();
    expect(res.warning).toContain("not a JSON array");
    expect(res).not.toHaveProperty("tickets");
    // The bytes are what arrived — normalizing half a plan we cannot read would be
    // worse than leaving it alone.
    expect(savedPlan().tickets).toBe("[{title: 'not json'}");
    expect(h.workflowGets).toHaveLength(0);
  });

  it("FAILS OPEN when the branch is unreadable: no templating, autowire still runs", async () => {
    h.workflowGetError = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    const res = result(await plan());
    const api = planTicket(res.tickets, "API work");
    // The coined name survives — wrong, but recoverable, and the alternative is
    // refusing a plan over a throttled read.
    expect(api.description).toContain("feature/my-own-branch-name");
    expect(res).not.toHaveProperty("integration_branch");
    expect(api.blockedBy).toEqual(["TEAM-4101"]);
    expect(h.warns.join("\n")).toContain("branch templating SKIPPED");
  });

  it("FAILS OPEN when no root sibling resolves: no invented blocker", async () => {
    // Only a validated real ticket KEY may be inserted — the jira twin refuses a
    // blocked_by that is not a ticket key outright.
    h.siblings.length = 0;
    const res = result(await plan());
    expect(planTicket(res.tickets, "API work").blockedBy).toEqual([]);
    expect(res).not.toHaveProperty("autowired");
  });

  it("skips the sibling scan entirely with no epic_id", async () => {
    const res = result(await plan({ epic_id: "" }));
    expect(calls("Tickets___list_tickets")).toHaveLength(0);
    expect(res.ticket_count).toBe(3);
  });

  // TEAM-4752 D1 — the ONE sibling-scan consumer that stays fail-open. This tool
  // creates nothing; the ENFORCING half of the freeze rule is the twins'
  // create-time autowire, which 4752 makes fail-closed. So refusing the plan would
  // strand the analyst's whole output over one throttled Query, for an edge that is
  // re-derived at create time anyway. What changes is that it is no longer SILENT.
  it("FAILS OPEN on a failed sibling scan — but says so on the response", async () => {
    h.ticketFail.add("Tickets___list_tickets");
    const res = result(await plan());
    expect(res.status).toBe("saved");
    expect(res.ticket_count).toBe(3);
    // No invented blocker: only a validated real ticket key may ever be inserted.
    expect(planTicket(res.tickets, "API work").blockedBy).toEqual([]);
    expect(res).not.toHaveProperty("autowired");
    // The visible part — the agent that has to copy this plan can see the edge is
    // missing instead of trusting a plan that was silently degraded.
    expect(res.warning).toContain("root-blocker autowire SKIPPED");
    expect(res.warning).toContain("TEAM-4100");
    expect(h.warns.join("\n")).toMatch(/sibling scan under TEAM-4100 FAILED .* root-blocker autowire SKIPPED/);
    // Still persisted, and the branch templating still ran.
    expect(savedPlan().tickets).toHaveLength(3);
    expect(res.integration_branch).toBe(BRANCH);
  });

  it("adds no warning key at all on the ordinary path", async () => {
    // Additive: an existing caller's response is byte-identical to pre-4752.
    expect(result(await plan())).not.toHaveProperty("warning");
  });
});

// ─── TEAM-4589: save_design_doc pass-by-reference ─────────────────────────────
//
// The doc used to reach this tool only as an inline `content` string, so an agent
// had to re-emit the whole document as a tool argument. A 97 KB design doc killed
// backend_designer with MaxTokensReachedException four times — on a document that
// was ALREADY in S3. So `s3Key` lets the agent register bytes it already wrote.
//
// Two properties carry the weight. (1) Nothing may be written before the key
// validates and the GET succeeds: a half-saved doc leaves a critical:true
// manifest entry pointing at garbage, which silently poisons every downstream
// reader, whereas a hard error just strands a recoverable ticket. (2) The inline
// path must be untouched — same writes, same response key set — because every
// small-doc caller still uses it.

const WF = "wf_1";
const DESIGNER = "agentcore_hub_backend_designer";
// The destination keys saveDesignDoc computes for that agent (no title/format is
// sent by main.py, so the slug is deterministic).
const DEST = `workflows/${WF}/${DESIGNER}/design-doc-${DESIGNER}.md`;
const SHARED_DEST = `workflows/${WF}/shared/design-doc-${DESIGNER}.md`;
// Where a designer stages a large doc per its blueprint: its OWN agent_id folder,
// deliberately NOT shared/ — a staging file under shared/ would be picked up by
// this tool's own dup-doc listing and reported back as a rival design doc.
const STAGED = `workflows/${WF}/${DESIGNER}/backend-design.md`;
const BIG_DOC = `# Backend design\n\n${"Section body.\n".repeat(50)}`;

const saveDoc = (args) =>
  handler({
    tool_name: "WorkflowOutput___save_design_doc",
    arguments: { workflow_id: WF, agent_id: DESIGNER, ...args },
  });

/** The tool's parsed success payload. */
const saved = (res) => JSON.parse(res.content[0].text);
const errorText = (res) => res.content[0].text;
/** Bodies written to the two destination keys, in write order. */
const written = (key) => h.puts.filter((p) => p.Key === key).map((p) => p.Body);
/** Design-doc entries the manifest's design phase carries after the last write. */
const manifestDesignEntries = () => {
  const put = [...h.puts].reverse().find((p) => p.Key === `workflows/${WF}/shared/manifest.json`);
  if (!put) return [];
  return (JSON.parse(put.Body).phases.design || []).filter((e) => e.type === "design-doc");
};

// The exact response key set an inline save returned before TEAM-4589.
const PRE_4589_RESPONSE_KEYS = ["status", "location", "shared_location", "existing_design_docs", "message"];

describe("save_design_doc — s3Key reads the doc instead of taking it inline", () => {
  it("(a) writes BOTH destination keys with the source object's body", async () => {
    h.objects.set(STAGED, BIG_DOC);
    await saveDoc({ s3Key: STAGED });
    expect(written(DEST)).toEqual([BIG_DOC]);
    expect(written(SHARED_DEST)).toEqual([BIG_DOC]);
    // The source is registered, never consumed — no delete, no move.
    expect(h.objects.get(STAGED)).toBe(BIG_DOC);
  });

  it("(b) returns the five pre-change keys plus source_s3_key", async () => {
    h.objects.set(STAGED, BIG_DOC);
    const r = saved(await saveDoc({ s3Key: STAGED }));
    expect(Object.keys(r).sort()).toEqual([...PRE_4589_RESPONSE_KEYS, "source_s3_key"].sort());
    expect(r.source_s3_key).toBe(STAGED);
    expect(r.status).toBe("saved");
    expect(r.location).toBe(`s3://test-bucket/${DEST}`);
    expect(r.shared_location).toBe(`s3://test-bucket/${SHARED_DEST}`);
    expect(r.existing_design_docs).toEqual([]);
  });

  it("(c) registers ONE critical manifest entry, and a re-save adds no second one", async () => {
    h.objects.set(STAGED, BIG_DOC);
    await saveDoc({ s3Key: STAGED });
    const entries = manifestDesignEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].critical).toBe(true);
    // The entry must point at the SHARED copy — that is the key downstream
    // agents are handed in their context, not the per-agent one.
    expect(entries[0].s3Key).toBe(SHARED_DEST);

    // Re-save over the doc that now exists in shared/: an update in place, and
    // crucially not a duplicate ★ entry in the next phase's prompt.
    h.puts.length = 0;
    h.objects.set(STAGED, `${BIG_DOC}\n## Revised\n`);
    const r = saved(await saveDoc({ s3Key: STAGED }));
    expect(r.status).toBe("updated");
    expect(manifestDesignEntries()).toHaveLength(0); // no manifest write at all
    expect(written(SHARED_DEST)).toEqual([`${BIG_DOC}\n## Revised\n`]);
  });

  it("(d) both supplied: s3Key wins, content is ignored, and a warning says so", async () => {
    h.objects.set(STAGED, BIG_DOC);
    const res = await saveDoc({ s3Key: STAGED, content: "# The stale inline copy\n" });
    expect(res.isError).toBeFalsy();
    expect(written(SHARED_DEST)).toEqual([BIG_DOC]);
    expect(h.warns.join("\n")).toMatch(/both content and s3Key/);
    expect(h.warns.join("\n")).toMatch(/precedence/);
    expect(saved(res).source_s3_key).toBe(STAGED);
  });

  it("(e) neither, and both blank, is an error that writes nothing", async () => {
    for (const args of [{}, { content: "", s3Key: "" }, { content: "   ", s3Key: "  \n " }]) {
      h.puts.length = 0;
      const res = await saveDoc(args);
      expect(res.isError).toBe(true);
      expect(errorText(res)).toMatch(/content or s3Key is required/);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(f) a missing object names the key and writes nothing", async () => {
    const res = await saveDoc({ s3Key: STAGED });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain(STAGED);
    expect(errorText(res)).toMatch(/NoSuchKey/);
    expect(h.puts).toHaveLength(0);
  });

  it("(g) an empty or whitespace-only object names the key and writes nothing", async () => {
    for (const body of ["", "   \n\t  "]) {
      h.puts.length = 0;
      h.objects.set(STAGED, body);
      const res = await saveDoc({ s3Key: STAGED });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain(STAGED);
      expect(errorText(res)).toMatch(/empty/);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(h) the footgun guard rejects a malformed key with zero reads and zero writes", async () => {
    const rejected = [
      [`s3://bucket/workflows/${WF}/x.md`, /s3:\/\/ URL/],
      [`/workflows/${WF}/x.md`, /starts with/],
      [`workflows/${WF}/../../secrets.md`, /path segment/],
      ["blueprints/backend-designer.md", /outside the workflows\/ prefix/],
    ];
    for (const [key, why] of rejected) {
      h.puts.length = 0;
      h.gets.length = 0;
      const res = await saveDoc({ s3Key: key });
      expect(res.isError).toBe(true);
      expect(errorText(res)).toContain(key);
      expect(errorText(res)).toMatch(why);
      // Names the expected shape, not just the rejection.
      expect(errorText(res)).toMatch(/plain object key under workflows\//);
      expect(h.gets).toHaveLength(0);
      expect(h.puts).toHaveLength(0);
    }
  });

  it("(h2) an invalid key never falls back to the inline content", async () => {
    const res = await saveDoc({ s3Key: "/etc/passwd", content: "# a perfectly good doc\n" });
    expect(res.isError).toBe(true);
    expect(h.puts).toHaveLength(0);
  });

  it("(i) the inline path is unchanged — both keys written, no source_s3_key", async () => {
    const res = await saveDoc({ content: "# Small design\n\nOne paragraph.\n" });
    expect(written(DEST)).toEqual(["# Small design\n\nOne paragraph.\n"]);
    expect(written(SHARED_DEST)).toEqual(["# Small design\n\nOne paragraph.\n"]);
    const r = saved(res);
    expect(Object.keys(r).sort()).toEqual([...PRE_4589_RESPONSE_KEYS].sort());
    expect("source_s3_key" in r).toBe(false);
    expect(h.gets.some((g) => g.Key === STAGED)).toBe(false);
  });

  it("format decides the extension — never the source key's", async () => {
    // A doc staged as .json but registered as markdown is stored as the markdown
    // the caller declared. Inferring from the source key would rename the file
    // and change its ContentType behind the caller's back.
    const jsonStaged = `workflows/${WF}/${DESIGNER}/spec.json`;
    h.objects.set(jsonStaged, '{"ok":true}');
    await saveDoc({ s3Key: jsonStaged });
    expect(written(SHARED_DEST)).toEqual(['{"ok":true}']);
    expect(h.puts.find((p) => p.Key === SHARED_DEST).ContentType).toBe("text/markdown");
  });
});

describe("inferToolFromArgs — (j) flat-args routing", () => {
  it("routes a by-reference save with no content at all", () => {
    expect(inferToolFromArgs({ s3Key: STAGED, workflow_id: WF, agent_id: DESIGNER })).toBe("save_design_doc");
  });

  // Every pre-4589 outcome, asserted so the new rule cannot have shadowed one.
  it("keeps every existing rule's outcome", () => {
    expect(inferToolFromArgs({ ticket_id: "TEAM-1", summary: "done" })).toBe("report_completion");
    expect(inferToolFromArgs({ content: "# doc", workflow_id: WF })).toBe("save_design_doc");
    expect(inferToolFromArgs({ requirements: "r", tickets: "[]" })).toBe("submit_ticket_plan");
    expect(inferToolFromArgs({ tickets: "[]" })).toBe("submit_ticket_plan");
    expect(inferToolFromArgs({ title: "T", content: "# doc", agent_id: DESIGNER })).toBe("save_design_doc");
    expect(inferToolFromArgs({ nothing: "useful" })).toBe(null);
  });
});

// ─── Writing-standard lint at the write tools (blueprints/writing-standard.md) ───
// The pure rules live in deliverables-lint.test.mjs; this block pins the SEAM:
// which tools consult the lint, that a refusal writes nothing, and that a
// missing config fails open. The registry is the real src/config/workflows.json.
import { readFileSync as _readFileSync } from "node:fs";
const { resetDeliverableIndexForTests } = await import("./index.mjs");
const REAL_CONFIG = _readFileSync(new URL("../../src/config/workflows.json", import.meta.url), "utf8");
const BRIEF_EXAMPLE = (() => {
  const md = _readFileSync(new URL("../../blueprints/template-brief.md", import.meta.url), "utf8");
  return /## Example[^\n]*\n\n```\n([\s\S]*?)\n```/.exec(md)[1];
})();
const write = (key, content) => handler({ tool_name: "S3Storage___write_object", arguments: { key, content, content_type: "text/markdown" } });

describe("writing-standard lint — S3Storage___write_object", () => {
  beforeEach(() => { resetDeliverableIndexForTests(); h.objects.set("config/workflows.json", REAL_CONFIG); });

  it("refuses a registered deliverable that breaks the standard and writes nothing", async () => {
    const res = result(await write("workflows/wf_1/shared/merge-brief.md", "DECISION: approve\n\nWHAT HAPPENED\n• stuff"));
    expect(res.status).toBe("refused");
    expect(res.reason).toBe("writing_standard");
    expect(res.template).toBe("template-brief");
    expect(h.puts.some((p) => p.Key === "workflows/wf_1/shared/merge-brief.md")).toBe(false);
    expect(h.warns.some((w) => w.includes("REFUSED write workflows/wf_1/shared/merge-brief.md"))).toBe(true);
  });
  it("writes a conforming deliverable", async () => {
    const res = result(await write("workflows/wf_1/shared/merge-brief.md", BRIEF_EXAMPLE));
    expect(res.status).toBe("saved");
    expect(h.objects.get("workflows/wf_1/shared/merge-brief.md")).toBe(BRIEF_EXAMPLE);
  });
  it("leaves unregistered keys, agent folders and non-markdown alone", async () => {
    expect(result(await write("workflows/wf_1/shared/plan.md", "free-form plan")).status).toBe("saved");
    expect(result(await write("workflows/wf_1/agentcore_hub_operator/merge-brief.md", "staging copy")).status).toBe("saved");
    expect(result(await write("workflows/wf_1/shared/cd-ledger.json", "{}")).status).toBe("saved");
  });
  it("fails open when config/workflows.json is unavailable", async () => {
    h.objects.delete("config/workflows.json");
    resetDeliverableIndexForTests();
    expect(result(await write("workflows/wf_1/shared/merge-brief.md", "no structure at all")).status).toBe("saved");
    expect(h.warns.some((w) => w.includes("lint disabled"))).toBe(true);
  });
});

describe("writing-standard lint — save_design_doc", () => {
  beforeEach(() => { resetDeliverableIndexForTests(); h.objects.set("config/workflows.json", REAL_CONFIG); });
  const save = (content, extra = {}) => handler({
    tool_name: "WorkflowOutput___save_design_doc",
    arguments: { workflow_id: "wf_1", agent_id: "agentcore_hub_backend_designer", title: "Backend design", content, ...extra },
  });
  it("refuses a markdown design doc that is not a spec, before either copy is written", async () => {
    const res = result(await save("Architecture\n\nWe will do things.\n"));
    expect(res.status).toBe("refused");
    expect(res.family).toBe("spec");
    expect(h.puts.some((p) => p.Key.endsWith("backend-design.md"))).toBe(false);
  });
  it("saves a conforming spec to both keys", async () => {
    const md = _readFileSync(new URL("../../blueprints/template-spec.md", import.meta.url), "utf8");
    const spec = /## Example[^\n]*\n\n```\n([\s\S]*?)\n```/.exec(md)[1];
    const res = result(await save(spec));
    expect(res.status).not.toBe("refused");
    expect(h.objects.has("workflows/wf_1/shared/backend-design.md")).toBe(true);
    expect(h.objects.has("workflows/wf_1/agentcore_hub_backend_designer/backend-design.md")).toBe(true);
  });
  it("does not lint a JSON design doc", async () => {
    const res = result(await save('{"a":1}', { format: "json" }));
    expect(res.status).not.toBe("refused");
  });
});

// ─── config/ is not agent-writable (TEAM-5009) ────────────────────────────────
// The key is agent-supplied and was never checked, so a persona could point the
// write tool at config/models.json — the document that decides which model that
// persona runs on. The role's DenyRegistryWrite is the real boundary; this block
// pins the readable refusal in front of it, and that a read of the same prefix
// still works (the lint above reads config/workflows.json through it).
describe("protected config/ prefix — S3Storage write tools", () => {
  const presign = (key, operation) => handler({
    tool_name: "S3Storage___presign_url", arguments: { key, operation },
  });

  it("refuses a write to the model registry and puts nothing", async () => {
    const res = result(await write("config/models.json", '{"catalog":[]}'));
    expect(res.status).toBe("refused");
    expect(res.reason).toBe("protected_key");
    expect(h.puts.some((p) => p.Key === "config/models.json")).toBe(false);
    expect(h.warns.some((w) => w.includes("REFUSED write config/models.json"))).toBe(true);
  });
  it("refuses every other config/ key too, not just the registry", async () => {
    for (const key of ["config/agents.json", "config/cd-registry.json", "config/nested/x.json"]) {
      expect(result(await write(key, "{}")).reason).toBe("protected_key");
    }
    expect(h.puts.some((p) => p.Key?.startsWith("config/"))).toBe(false);
  });
  it("refuses a presigned PUT onto config/, which would write with our credentials", async () => {
    const res = result(await presign("config/models.json", "put"));
    expect(res.reason).toBe("protected_key");
    // ...and the default operation is put, so omitting it must not slip through.
    expect(result(await presign("config/models.json")).reason).toBe("protected_key");
  });
  it("still presigns a GET and still writes everywhere else", async () => {
    expect(result(await presign("config/models.json", "get")).status).toBe("ok");
    expect(result(await write("workflows/wf_1/notes.md", "fine")).status).toBe("saved");
    expect(result(await write("pipeline-artifacts/x.txt", "fine")).status).toBe("saved");
  });
});
