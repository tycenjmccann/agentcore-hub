import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mintDecisionToken, parseDecisionAnswer } from "./decision-contract.mjs";
// TEAM-5390: the orchestrator's proof check, so a retained record is judged by the real reader.
import { gateDecisionStands, liveGateOf, closeoutOffenderIds } from "../orchestrator/proof-record-verify.mjs";

/**
 * TEAM-5322 replay — the human gates that closed on nothing a human chose.
 *
 * Same shape as replay-gate-binding.test.mjs: only the AWS seams are mocked
 * (DynamoDB doc client, S3, Secrets Manager, the pipeline-tools probe Lambda); the
 * guard, gate-contract.mjs, decision-contract.mjs and every refusal string are the
 * real ones. The DynamoDB mock is STATEFUL — a status / comment / gateVerify write
 * lands on the row — so each replay reads back what the twin actually left behind.
 * Ticket rows come from the `ticket.created` events in ./fixtures (README there);
 * the exports carry no description, so each row gets the `DECISION OPTIONS:` line
 * the chunk-D template declares for its gate type.
 *
 *   33rea7 / TEAM-5209   R-8: the empty sweep skipped its own Merge Approval gate
 *                        (one in_review → skip since TEAM-5340; block → skip in
 *                        #771). That path must SURVIVE the decision
 *                        guard; a `done` whose reason merely says "Skipped:" must not.
 *   TEAM-5259            TEAM-5273/5278/5279: three escalation gates closed by an
 *                        agent-reachable Done. ⇒ each unanswered done refused, each
 *                        signed close carries a DECISION comment, no ticket filed.
 *   1ykx9f / TEAM-4931   the deploy gate was approved and closed, TEAM-4932 was
 *                        unblocked, and the deploy had not happened (TEAM-4939).
 *                        ⇒ an unmet post-condition holds the gate in_review, so the
 *                        cascade has no done to dispatch on.
 *   znl7a4 / TEAM-5352,  TEAM-5391: escalation gates that declared nothing and closed
 *   o1l3to / TEAM-5314   on a bare Done. Read AS EXPORTED (no description) ⇒ refused
 *                        with the default `approve | reject`; a signed approve closes.
 *   TEAM-5148            the synthetic decision-bound fixture's expected[] rows.
 */

const h = vi.hoisted(() => ({
  state: {
    items: /** @type {Record<string, any>} */ ({}),
    puts: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    statusWrites: /** @type {any[]} */ ([]),
    counter: 0,
    s3Objects: /** @type {Record<string, object>} */ ({}),
    s3Puts: /** @type {any[]} */ ([]),
    /** TEAM-5387: the twin never deletes a gate-decision record; the mock throws and this stays empty. */
    s3Deletes: /** @type {any[]} */ ([]),
    probes: /** @type {any[]} */ ([]),
    probeBy: /** @type {Record<string, {result?: unknown}>} */ ({}),
    scanItems: /** @type {any[] | null} */ (null),
    /** TEAM-5347 F7: runs after a GetCommand has taken its snapshot — the test's way to
     * move the row (a human reopen) between the twin's read and its conditional write. */
    onGet: /** @type {((ticketId: string) => void) | null} */ (null),
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.state.probes.push({ tool: req.tool_name, args: req.parameters });
      const plan = h.state.probeBy[req.tool_name];
      if (!plan) {
        const err = new Error("connect ETIMEDOUT");
        err.name = "TimeoutError";
        throw err;
      }
      return {
        Payload: Buffer.from(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan.result, null, 2) }] })
        ),
      };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    async send() {
      const err = new Error("not authorized");
      err.name = "AccessDeniedException";
      throw err;
    }
  },
  GetSecretValueCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
const gateEtags = /** @type {Record<string, string>} */ ({});
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.__type === "PutObject") {
        h.state.s3Puts.push(cmd.input);
        // TEAM-5372: a gate-decision record is claimed before the status write
        // (create-once, IfNoneMatch; an older cycle replaced by IfMatch on this ETag).
        // TEAM-5387: it is never deleted, whatever happens to that status write.
        if (String(cmd.input.Key).includes("/gates/")) {
          if (cmd.input.IfNoneMatch === "*" && h.state.s3Objects[cmd.input.Key] !== undefined) {
            throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          if (cmd.input.IfMatch && gateEtags[cmd.input.Key] !== cmd.input.IfMatch) {
            throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          h.state.s3Objects[cmd.input.Key] = JSON.parse(cmd.input.Body);
          gateEtags[cmd.input.Key] = `"etag-${h.state.s3Puts.length}"`;
          return { ETag: gateEtags[cmd.input.Key] };
        }
        return {};
      }
      if (cmd.__type === "DeleteObject") {
        // TEAM-5387: a gate-decision record is never deleted; any regression fails loudly.
        h.state.s3Deletes.push(cmd.input);
        throw new Error(`DeleteObject must never be issued by the tickets twin (TEAM-5387): ${cmd.input.Key}`);
      }
      const record = h.state.s3Objects[cmd.input.Key];
      if (record === undefined) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return { Body: { transformToString: async () => JSON.stringify(record) }, ETag: gateEtags[cmd.input.Key] };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; this.__type = "HeadObject"; } },
  DeleteObjectCommand: class { constructor(i) { this.input = i; this.__type = "DeleteObject"; } },
  PutObjectCommand: class { constructor(i) { this.input = i; this.__type = "PutObject"; } },
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }

  const conditionalFailure = () => {
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    return err;
  };

  /** Apply the parts of an UpdateCommand the twin's gate paths use to the row. */
  function apply(input) {
    const row = h.state.items[input.Key.ticketId];
    const v = input.ExpressionAttributeValues || {};
    const expr = input.UpdateExpression || "";
    if (!row) return;
    if (/#s = :cur/.test(input.ConditionExpression || "") && row.status !== v[":cur"]) throw conditionalFailure();
    // TEAM-5338: the single-use jti set, conditions and ADD alike.
    const used = new Set(row.decisionJtisUsed || []);
    for (const term of String(input.ConditionExpression || "").split(" AND ")) {
      if (term === "NOT contains(#jti, :jti)" && used.has(v[":jti"])) throw conditionalFailure();
      if (term === "contains(#jti, :jti)" && !used.has(v[":jti"])) throw conditionalFailure();
      // TEAM-5347 F7: the decision-cycle pin.
      if (term === "attribute_not_exists(#gcr)" && row.gateCycleResetAt != null) throw conditionalFailure();
      if (term === "#gcr = :gcr" && row.gateCycleResetAt !== v[":gcr"]) throw conditionalFailure();
    }
    if (v[":jset"] instanceof Set) row.decisionJtisUsed = new Set([...used, ...v[":jset"]]);
    if (/REMOVE .*#auvAt/.test(expr)) delete row.approvedUnverifiedAt;
    if (expr.includes("#auvAt = :u")) row.approvedUnverifiedAt = v[":u"];
    if (expr.includes("#gcr = :u")) row.gateCycleResetAt = v[":u"];
    if (v[":s"] !== undefined) {
      h.state.statusWrites.push(input);
      row.status = v[":s"];
    }
    for (const k of [":dcm", ":cmts", ":comment"]) {
      if (Array.isArray(v[k])) row.comments = [...(row.comments || []), ...v[k]];
    }
    if (v[":gv"] !== undefined) row.gateVerification = v[":gv"];
    if (v[":gvr"] !== undefined) row.gateVerify = v[":gvr"];
    if (Array.isArray(v[":vfy"])) row.labels = [...(row.labels || []), ...v[":vfy"]];
    // Indexed label writes (the reprobe's stamps, a cycle reset's removes).
    const [setPart, removePart = ""] = expr.split(" REMOVE ");
    for (const m of setPart.matchAll(/#l\[(\d+)\] = (:\w+)/g)) {
      row.labels = [...(row.labels || [])];
      row.labels[Number(m[1])] = v[m[2]];
    }
    for (const i of [...removePart.matchAll(/#l\[(\d+)\]/g)].map((m) => Number(m[1])).sort((a, b) => b - a)) {
      row.labels = (row.labels || []).filter((_, n) => n !== i);
    }
    if (/REMOVE .*#gvr/.test(expr)) delete row.gateVerify;
  }

  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "UpdateCommand") {
            const v = cmd.input.ExpressionAttributeValues || {};
            if (v[":label"] !== undefined) return {};
            if (
              v[":s"] !== undefined || v[":gvr"] !== undefined ||
              v[":comment"] !== undefined || v[":cmts"] !== undefined
            ) {
              apply(cmd.input);
              // editIssue's park asks for ALL_NEW.
              const after = h.state.items[cmd.input.Key.ticketId];
              return cmd.input.ReturnValues && after ? { Attributes: structuredClone(after) } : {};
            }
            // `nextTicketId`'s counter bump: "a ticket is about to exist".
            h.state.counter += 1;
            return { Attributes: { nextNum: h.state.counter } };
          }
          if (name === "GetCommand") {
            const row = h.state.items[cmd.input.Key.ticketId];
            const snapshot = row ? structuredClone(row) : undefined;
            if (h.state.onGet) h.state.onGet(cmd.input.Key.ticketId);
            return { Item: snapshot };
          }
          if (name === "PutCommand") {
            if (cmd.input.Item?.eventId) h.state.events.push(cmd.input.Item);
            else h.state.puts.push(cmd.input.Item);
            return {};
          }
          if (name === "ScanCommand") {
            const items = h.state.scanItems ??
              Object.values(h.state.items).filter((r) => r.gateVerify && r.status === "in_review");
            return { Items: items.map((r) => structuredClone(r)) };
          }
          if (name === "QueryCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

const KEY = "replay-gate-decision-key-0123456789abcdef";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** The ticket row a `ticket.created` event describes, as the twin stores it. */
function rowFromEvents(events, ticketId, over = {}) {
  const ev = events.find((e) => e.type === "ticket.created" && e.detail?.ticket?.id === ticketId);
  if (!ev) throw new Error(`fixture has no ticket.created for ${ticketId}`);
  const t = ev.detail.ticket;
  return {
    ticketId,
    title: t.title,
    assignee: t.assignee,
    parentId: t.parent,
    workflowId: ev.workflowId,
    status: "in_review",
    description: t.description || "",
    comments: [],
    labels: [],
    ...over,
  };
}

const sign = (ticketId, option, workflowId, over = {}) =>
  // TEAM-5358 F3: signed over the scope the human sees — the row as it stands.
  mintDecisionToken({ ticketId, option, channel: "telegram", by: "chat:replay", workflowId, description: h.state.items[ticketId]?.description, ...over }, KEY);

let handler;
const transition = (args) => handler({ name: "Tickets___transition_ticket", arguments: args });

beforeEach(async () => {
  const s = h.state;
  s.items = {};
  s.puts.length = 0;
  s.events.length = 0;
  s.statusWrites.length = 0;
  s.counter = 0;
  s.s3Objects = {};
  s.s3Puts.length = 0;
  s.s3Deletes.length = 0;
  s.probes.length = 0;
  s.probeBy = {};
  s.scanItems = null;
  s.onGet = null;
  process.env.GATE_DECISION_KEY = KEY;
  process.env.ARTIFACT_BUCKET = "hub-artifacts";
  process.env.PIPELINE_TOOLS_LAMBDA = "hub-pipeline-tools";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.AWS_REGION = "us-east-1";
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

describe("R-8 replay 33rea7 / TEAM-5209 — the empty sweep skips its own Merge Approval gate", () => {
  const events = fixture("events-33rea7.gates.json");
  const GATE = "TEAM-5209";
  const SWEEPER = "TEAM-5204";
  const WF = "wf_1790592080841_33rea7";
  // operator.md B7 merge brief `## Decision` (chunk D).
  const DESC = "Merge brief for the dead code sweep.\nDECISION OPTIONS: approve | approve-with-known-findings";

  beforeEach(() => {
    h.state.items[GATE] = rowFromEvents(events, GATE, { description: DESC });
    // The sweeper is still in_progress when it skips its siblings (it Dones last),
    // with its own non-skipped completion record already written.
    h.state.items[SWEEPER] = rowFromEvents(events, SWEEPER, { status: "in_progress" });
    h.state.s3Objects[`completions/${SWEEPER}.json`] = {
      ticketId: SWEEPER, workflowId: WF, evidence_kind: "static",
      summary: "EMPTY SWEEP — 0 verified removals, 115 kept.",
    };
  });

  it("fixture sanity: the gate is the human Merge Approval of the sweeper's run", () => {
    const gate = h.state.items[GATE];
    expect(gate).toMatchObject({ assignee: "human:engineer", parentId: "TEAM-5202", workflowId: WF });
    expect(gate.title).toMatch(/^Merge Approval:/);
    expect(h.state.items[SWEEPER]).toMatchObject({ assignee: "agentcore_hub_code_sweeper", parentId: "TEAM-5202" });
  });

  it("in_review → skip with the sweep's skip record succeeds with the decision guard ON, never via blocked (TEAM-5340 F7)", async () => {
    h.state.s3Objects[`completions/${GATE}.json`] = {
      ticketId: GATE, workflowId: WF, evidence_kind: "skipped", skipped: true,
      reason: "empty_sweep", summary: `Skipped: empty_sweep — no removals found by ${SWEEPER}`,
    };

    const res = await transition({ ticket_id: GATE, transition_id: "skip", reason: "Skipped: empty_sweep" });

    expect(res).toMatchObject({ status: "transitioned", from: "in_review", to: "done" });
    expect(res.decision, "a sweep skip is not a human decision").toBeUndefined();
    expect(h.state.items[GATE].status).toBe("done");
    // No decision ⇒ no DECISION comment, no merge-approval record and no
    // gate-decision record: a skipped gate can never become a ship-approval proof
    // or a human acceptance (TEAM-5340 F1).
    expect(h.state.items[GATE].comments.some((c) => /DECISION:/.test(c.content))).toBe(false);
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("a done whose reason merely says Skipped: is refused, and so is a skip record from another run", async () => {
    const res = await transition({ ticket_id: GATE, transition_id: "done", reason: "Skipped: empty_sweep" });
    expect(res).toMatchObject({ ok: false, reason: "decision_required", options: ["approve", "approve-with-known-findings"] });
    expect(h.state.items[GATE].status).toBe("in_review");

    h.state.s3Objects[`completions/${GATE}.json`] = {
      ticketId: GATE, workflowId: "wf_someone_else", evidence_kind: "skipped", skipped: true,
      summary: `Skipped: empty_sweep — no removals found by ${SWEEPER}`,
    };
    await transition({ ticket_id: GATE, transition_id: "block" });
    expect(await transition({ ticket_id: GATE, transition_id: "skip" })).toMatchObject({ reason: "decision_required" });
    expect(h.state.items[GATE].status).toBe("blocked");
  });
});

// TEAM-5391 F1 (FR-6, acceptance #5): both escalation gates closed on a bare Done,
// because neither declared DECISION OPTIONS and an undeclared gate was not bound.
// The rows are read AS EXPORTED — no description is added — so this is the case the
// default set exists for.
describe.each([
  { file: "events-znl7a4.gates.json", id: "TEAM-5352", wf: "wf_1791220686225_znl7a4", owner: "TEAM-5325" },
  { file: "events-o1l3to.gates.json", id: "TEAM-5314", wf: "wf_1791197897608_o1l3to", owner: "TEAM-5305" },
])("replay $wf / $id — an UNDECLARED escalation gate admits only the default set (TEAM-5391)", ({ file, id, wf, owner }) => {
  const events = fixture(file);
  const DEFAULT = ["approve", "reject"];
  const recordKey = `pipeline-artifacts/gate-decisions/${wf}/gates/${id}.json`;

  beforeEach(() => {
    h.state.items[id] = rowFromEvents(events, id);
  });

  it("fixture sanity: a human:engineer escalation gate with no description, filed by the run's review loop", () => {
    expect(h.state.items[id]).toMatchObject({ assignee: "human:engineer", workflowId: wf, description: "" });
    expect(h.state.items[id].title).toMatch(/^Escalation/);
    expect(events.some((e) => e.type === "ticket.created" && e.detail.ticket.id === owner)).toBe(true);
  });

  it("a bare done is refused decision_required with the default options, and nothing is written", async () => {
    const res = await transition({ ticket_id: id, transition_id: "done" });
    expect(res).toMatchObject({ ok: false, reason: "decision_required", ticketId: id, options: DEFAULT, detail: "no_decision" });
    expect(h.state.items[id].status).toBe("in_review");
    expect(h.state.statusWrites).toHaveLength(0);
    expect(h.state.s3Puts).toHaveLength(0);
    // The refusal is answered on the ticket, naming what the human may pick.
    expect(h.state.items[id].comments.at(-1).content).toContain("Pick one of: approve | reject");
  });

  it("agent-writable text is never an answer: a reason line or a plain decision is ignored", async () => {
    for (const args of [{ reason: "unblocking the run\nDECISION: continue" }, { reason: "ok\nDECISION: approve" }, { decision: "approve" }]) {
      expect(await transition({ ticket_id: id, transition_id: "done", ...args })).toMatchObject({
        ok: false, reason: "decision_required", options: DEFAULT,
      });
    }
    expect(h.state.items[id].status).toBe("in_review");
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("a SIGNED option outside the default set is refused decision_token_option_undeclared", async () => {
    // `continue` is what the release manager's escalation reader parses — an
    // undeclared gate does not admit it; the template must declare it.
    const res = await transition({ ticket_id: id, transition_id: "done", decision: "continue", decision_token: sign(id, "continue", wf) });
    expect(res).toMatchObject({ ok: false, reason: "decision_required", options: DEFAULT, detail: "decision_token_option_undeclared" });
    expect(h.state.items[id].status).toBe("in_review");
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("a signed approve closes it with a gate-guard DECISION comment and a signed gate-decision record", async () => {
    const res = await transition({ ticket_id: id, transition_id: "done", decision: "approve", decision_token: sign(id, "approve", wf) });
    expect(res).toMatchObject({ status: "transitioned", to: "done", decision: { option: "approve", override: true, channel: "telegram" } });
    const row = h.state.items[id];
    expect(row.status).toBe("done");
    expect(row.decisionJtisUsed?.size, "the token is spent in the status write").toBe(1);
    const last = row.comments.at(-1);
    expect(last.author).toBe("gate-guard");
    expect(parseDecisionAnswer(last.content, DEFAULT)).toEqual({ option: "approve", override: true });
    expect(h.state.s3Puts.map((p) => p.Key)).toEqual([recordKey]);
    expect(JSON.parse(h.state.s3Puts[0].Body)).toMatchObject({
      kind: "gate-decision", ticketId: id, workflowId: wf, status: "done", decision: { option: "approve", channel: "telegram" },
    });
  });

  it("a signed stopped never closes it done; it cancels it", async () => {
    expect(await transition({ ticket_id: id, transition_id: "done", decision: "stopped", decision_token: sign(id, "stopped", wf) }))
      .toMatchObject({ ok: false, reason: "decision_required", detail: "stopped_cancels_not_closes" });
    expect(h.state.items[id].status).toBe("in_review");

    const res = await transition({ ticket_id: id, transition_id: "cancel", decision: "stopped", decision_token: sign(id, "stopped", wf), reason: "operator stopped the run" });
    expect(res).toMatchObject({ status: "transitioned", to: "cancelled", decision: { option: "stopped" } });
    expect(h.state.items[id].status).toBe("cancelled");
    expect(parseDecisionAnswer(h.state.items[id].comments.at(-1).content, DEFAULT)).toEqual({ option: "stopped", override: true });
    expect(JSON.parse(h.state.s3Puts.at(-1).Body)).toMatchObject({ kind: "gate-decision", ticketId: id, status: "cancelled", decision: { option: "stopped" } });
  });

  it("a sweep skip proven by the run's own skip record is still the one exemption", async () => {
    // Synthetic: an in_progress sweeper sibling with its own record (the R-8 shape
    // above), so the proof is exercised on an undeclared gate.
    const SWEEPER = "TEAM-9001";
    h.state.items[SWEEPER] = { ticketId: SWEEPER, status: "in_progress", assignee: "agentcore_hub_code_sweeper", parentId: h.state.items[id].parentId, workflowId: wf };
    h.state.s3Objects[`completions/${SWEEPER}.json`] = { ticketId: SWEEPER, workflowId: wf, evidence_kind: "static", summary: "EMPTY SWEEP" };
    h.state.s3Objects[`completions/${id}.json`] = {
      ticketId: id, workflowId: wf, evidence_kind: "skipped", skipped: true,
      reason: "empty_sweep", summary: `Skipped: empty_sweep — no removals found by ${SWEEPER}`,
    };
    const res = await transition({ ticket_id: id, transition_id: "skip", reason: "Skipped: empty_sweep" });
    expect(res).toMatchObject({ status: "transitioned", to: "done" });
    expect(res.decision).toBeUndefined();
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("without a skip record a skip is refused like a bare done", async () => {
    expect(await transition({ ticket_id: id, transition_id: "skip" })).toMatchObject({ ok: false, reason: "decision_required", options: DEFAULT });
    expect(h.state.items[id].status).toBe("in_review");
  });
});

describe("replay TEAM-5259 — TEAM-5273/5278/5279 escalation gates", () => {
  const events = fixture("events-TEAM-5259.gates.json");
  const WF = "wf_bug_TEAM-5259";
  // code-reviewer.md / qa-verifier.md escalation templates (chunk D).
  const GATES = {
    "TEAM-5273": { options: ["continue", "accept-as-known"], pick: "continue" },
    "TEAM-5278": { options: ["access-granted", "proceed-without-live", "abort"], pick: "access-granted" },
    "TEAM-5279": { options: ["access-granted", "proceed-without-live", "abort"], pick: "proceed-without-live" },
  };

  beforeEach(() => {
    for (const [id, g] of Object.entries(GATES)) {
      h.state.items[id] = rowFromEvents(events, id, {
        description: `Escalation brief.\nDECISION OPTIONS: ${g.options.join(" | ")}`,
      });
    }
  });

  it("each unanswered done is refused, each signed close carries a DECISION comment, and no ticket is created", async () => {
    for (const [id, g] of Object.entries(GATES)) {
      const row = h.state.items[id];
      expect(row).toMatchObject({ assignee: "human:engineer", parentId: "TEAM-5259", workflowId: WF });

      // What actually happened: an agent-reachable Done with no human choice.
      const refused = await transition({ ticket_id: id, transition_id: "done", reason: "unblocking the run" });
      expect(refused).toMatchObject({ ok: false, reason: "decision_required", ticketId: id, options: g.options });
      expect(h.state.items[id].status).toBe("in_review");

      const ok = await transition({ ticket_id: id, transition_id: "done", decision: g.pick, decision_token: sign(id, g.pick, WF) });
      expect(ok).toMatchObject({ status: "transitioned", to: "done", decision: { option: g.pick, override: true, channel: "telegram" } });
      const last = h.state.items[id].comments.at(-1);
      expect(last.author).toBe("gate-guard");
      expect(parseDecisionAnswer(last.content, g.options)).toEqual({ option: g.pick, override: true });
    }
    // Acceptance 6: a refusal is answered on the ticket itself, never by filing one.
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter, "no ticket id was minted").toBe(0);
    // Not a Merge Approval gate ⇒ no merge-approval record; but every decided close
    // leaves its signed gate-decision record (TEAM-5340 F1), one per gate.
    expect(h.state.s3Puts.some((p) => p.Key.endsWith("/merge-approval.json"))).toBe(false);
    expect(h.state.s3Puts.map((p) => p.Key)).toEqual(
      Object.keys(GATES).map((id) => `pipeline-artifacts/gate-decisions/${WF}/gates/${id}.json`)
    );
    for (const [i, id] of Object.keys(GATES).entries()) {
      expect(JSON.parse(h.state.s3Puts[i].Body)).toMatchObject({ kind: "gate-decision", ticketId: id, workflowId: WF, status: "done", decision: { option: GATES[id].pick, channel: "telegram" } });
    }
  });
});

describe("replay 1ykx9f / TEAM-4931 — a deploy gate approved before the deploy happened", () => {
  const events = fixture("events-1ykx9f.gates.json");
  const GATE = "TEAM-4931";
  const WF = "wf_1790014803133_1ykx9f";
  const PC = { kind: "cfn_stack", target: "codebuild-ios-mcp", expect: { stackStatus: "UPDATE_COMPLETE" } };

  beforeEach(() => {
    h.state.items[GATE] = rowFromEvents(events, GATE, {
      description: "Deploy codebuild-ios-mcp PR #8.\nDECISION OPTIONS: approve | reject",
      postCondition: PC,
    });
  });

  it("fixture sanity: closing TEAM-4931 is what unblocked TEAM-4932 in the original run", () => {
    const unblocked = events.find((e) => e.type === "orchestrator.unblocked" && e.detail.unblockedBy === GATE);
    expect(unblocked.detail.ticketId).toBe("TEAM-4932");
    expect(events.some((e) => e.type === "ticket.created" && /not deployed after TEAM-4931 approval/.test(e.detail.ticket.title))).toBe(true);
  });

  it("an unmet post-condition leaves the gate in_review behind gate:verifying, so no dependant is unblocked", async () => {
    h.state.probeBy.Pipeline___verify_postcondition = {
      result: { ok: true, met: false, observed: { stackStatus: "UPDATE_IN_PROGRESS" } },
    };

    const res = await transition({ ticket_id: GATE, transition_id: "done", decision: "approve", decision_token: sign(GATE, "approve", WF) });

    expect(res).toMatchObject({ status: "verifying", requested: "done", to: "in_review", decision: { option: "approve" } });
    expect(h.state.probes).toEqual([{ tool: "Pipeline___verify_postcondition", args: PC }]);
    const row = h.state.items[GATE];
    expect(row.status).toBe("in_review");
    expect(row.labels).toContain("gate:verifying");
    expect(row.gateVerify).toMatchObject({ ticketId: GATE, workflowId: WF, verifyUntil: res.verifyUntil });
    // Acceptance 7: the cascade fires on a status write to done. There is none.
    expect(h.state.statusWrites).toHaveLength(0);
    expect(h.state.puts).toHaveLength(0);
  });

  it("once the stack reports UPDATE_COMPLETE the reprobe closes it as verified", async () => {
    h.state.probeBy.Pipeline___verify_postcondition = { result: { ok: true, met: false, observed: { stackStatus: "UPDATE_IN_PROGRESS" } } };
    await transition({ ticket_id: GATE, transition_id: "done", decision: "approve", decision_token: sign(GATE, "approve", WF) });

    h.state.probeBy.Pipeline___verify_postcondition = { result: { ok: true, met: true, observed: { stackStatus: "UPDATE_COMPLETE" } } };
    const sweep = await handler({ mode: "reprobe" });

    expect(sweep).toMatchObject({ mode: "reprobe", ok: true, results: [{ ticketId: GATE, outcome: expect.any(String) }] });
    const row = h.state.items[GATE];
    expect(row.status).toBe("done");
    expect(row.gateVerification).toMatchObject({ result: "verified", reason: "post_condition_met" });
    expect(row.gateVerify).toBeUndefined();
  });

  describe("TEAM-5338 F3: the hold's token is spent", () => {
    afterEach(() => vi.useRealTimers());

    it("replaying the hold token after the window lapses is refused; only a token minted after the timeout is the second word", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
      const unmet = { result: { ok: true, met: false, observed: { stackStatus: "UPDATE_IN_PROGRESS" } } };
      h.state.probeBy.Pipeline___verify_postcondition = unmet;
      const held = sign(GATE, "approve", WF);
      expect(await transition({ ticket_id: GATE, transition_id: "done", decision_token: held })).toMatchObject({ status: "verifying" });
      expect([...h.state.items[GATE].decisionJtisUsed]).toHaveLength(1);

      vi.setSystemTime(new Date("2026-10-05T12:11:00.000Z"));
      expect((await handler({ mode: "reprobe" })).results).toEqual([{ ticketId: GATE, outcome: "unverified" }]);
      const row = h.state.items[GATE];
      expect(row.labels).toContain("gate:approved-unverified");
      expect(row.approvedUnverifiedAt).toBe("2026-10-05T12:11:00.000Z");

      // The original token — still inside its own 15-minute TTL — is not a second word.
      const replay = await transition({ ticket_id: GATE, transition_id: "done", decision_token: held });
      expect(replay).toMatchObject({ ok: false, reason: "decision_required" });
      expect(replay.detail).toMatch(/^decision_token_(stale|consumed)$/);
      expect(h.state.statusWrites).toHaveLength(0);

      vi.setSystemTime(new Date("2026-10-05T12:12:00.000Z"));
      const again = await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "approve", WF) });
      expect(again).toMatchObject({ to: "done", gateVerification: { result: "unverified" } });
      expect([...h.state.items[GATE].decisionJtisUsed]).toHaveLength(2);
    });

    it("two concurrent closes with one token: exactly one wins", async () => {
      delete h.state.items[GATE].postCondition;
      const t = sign(GATE, "approve", WF);
      const results = await Promise.all([
        transition({ ticket_id: GATE, transition_id: "done", decision_token: t }),
        transition({ ticket_id: GATE, transition_id: "done", decision_token: t }),
      ]);
      expect(results.filter((r) => r.status === "transitioned")).toHaveLength(1);
      expect(results.filter((r) => r.detail === "decision_token_consumed")).toHaveLength(1);
      expect(h.state.statusWrites.filter((w) => w.ExpressionAttributeValues[":s"] === "done")).toHaveLength(1);
    });

    it("two different tokens across a reopen: the one minted before the reopen is stale, the one minted after is the new word", async () => {
      delete h.state.items[GATE].postCondition;
      expect(await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "approve", WF) })).toMatchObject({ status: "transitioned", to: "done" });
      // The human reopens it: a new cycle, stamped to the millisecond.
      const reopenMs = Date.now();
      Object.assign(h.state.items[GATE], { status: "in_review", gateCycleResetAt: new Date(reopenMs).toISOString() });
      const before = await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "reject", WF, { now: reopenMs - 1500 }) });
      expect(before).toMatchObject({ ok: false, reason: "decision_required", detail: "decision_token_stale" });
      expect(h.state.items[GATE].status).toBe("in_review");
      const after = await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "reject", WF, { now: reopenMs + 1000 }) });
      expect(after).toMatchObject({ status: "transitioned", to: "done", decision: { option: "reject" } });
    });
  });

  // TEAM-5347 F7: every gate-lifecycle write is pinned to the status AND the decision
  // cycle the twin read. `onGet` moves the row right after that read, so the
  // conditional write meets a different row than the one it was planned against.
  describe("TEAM-5347 F7: a write planned against one cycle never lands on the next", () => {
    const moveAfterRead = (patch) => {
      h.state.onGet = (id) => {
        if (id !== GATE) return;
        Object.assign(h.state.items[GATE], patch);
        h.state.onGet = null;
      };
    };

    it("a close whose read predates a reopen (gateCycleResetAt moved) is refused ticket_moved and writes nothing", async () => {
      delete h.state.items[GATE].postCondition;
      moveAfterRead({ status: "blocked", gateCycleResetAt: new Date().toISOString() });
      const res = await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "approve", WF) });
      expect(res).toMatchObject({ ok: false, reason: "decision_required", detail: "ticket_moved", status: "blocked" });
      expect(h.state.statusWrites.filter((w) => w.ExpressionAttributeValues[":s"] === "done")).toHaveLength(0);
      const row = h.state.items[GATE];
      expect(row.status).toBe("blocked");
      expect(row.decisionJtisUsed ?? new Set()).toEqual(new Set(), "the token is not spent by a refused write");
      // TEAM-5372: the record is claimed before the status write. TEAM-5387: a refused
      // close never deletes it - the ticket's status and cycle, not the record, say
      // whether the decision landed. So (a) the one create-once claim this close made
      // against the cycle it READ is still there, byte-for-byte, and nothing else is.
      const RECORD_KEY = `pipeline-artifacts/gate-decisions/${WF}/gates/${GATE}.json`;
      expect(h.state.s3Puts.map((p) => p.Key)).toEqual([RECORD_KEY]);
      expect(h.state.s3Puts[0].IfNoneMatch, "a create-once claim cannot have overwritten anything").toBe("*");
      expect(h.state.s3Deletes).toEqual([]);
      expect(Object.keys(h.state.s3Objects).filter((k) => k.includes("/gates/"))).toEqual([RECORD_KEY]);
      const retained = h.state.s3Objects[RECORD_KEY];
      expect(retained).toEqual(JSON.parse(h.state.s3Puts[0].Body));
      expect(retained).toMatchObject({ kind: "gate-decision", ticketId: GATE, workflowId: WF, status: "done", cycle: null });
      expect(row.gateCycleResetAt).toEqual(expect.any(String));

      // (b) The retained old-cycle record does NOT authorize the new cycle. Judged by the
      // orchestrator's proof check, fed the twin's own get_issue answer, as
      // lambda/orchestrator/index.mjs does at completion time.
      const getIssue = (id) => handler({ name: "Tickets___get_issue", arguments: { issue_key: id } });
      const live = liveGateOf(await getIssue(GATE));
      expect(live).toMatchObject({ ticketId: GATE, cycle: row.gateCycleResetAt });
      expect(gateDecisionStands(retained, [KEY], { workflowId: WF, ticketId: GATE, live })).toEqual({ ok: false, why: "stale_cycle" });
      // ...and it is the cycle, not the signature or the scope, that fails it.
      expect(gateDecisionStands(retained, [KEY], { workflowId: WF, ticketId: GATE, live: { ...live, cycle: null } })).toMatchObject({ ok: true });
      // Were this gate ever reported done in its new cycle, the completion predicate
      // would not take the stale record as its backing: the gate is an offender.
      const offenders = await closeoutOffenderIds([{ ...row, status: "done" }], {
        workflowId: WF, keys: [KEY], phaseOf: () => "ship", hasEvidence: () => true,
        readJson: async (k) => h.state.s3Objects[k] ?? null, liveGate: getIssue,
      });
      expect(offenders).toEqual([GATE]);
    });

    it("a hold on a gate whose cycle reset under it is refused; the token is not spent", async () => {
      h.state.probeBy.Pipeline___verify_postcondition = { result: { ok: true, met: false, observed: { stackStatus: "UPDATE_IN_PROGRESS" } } };
      moveAfterRead({ gateCycleResetAt: new Date().toISOString() });
      const res = await transition({ ticket_id: GATE, transition_id: "done", decision_token: sign(GATE, "approve", WF) });
      expect(res).toMatchObject({ ok: false, reason: "decision_required", detail: "ticket_moved", status: "in_review" });
      const row = h.state.items[GATE];
      expect(row.gateVerify).toBeUndefined();
      expect(row.labels ?? []).not.toContain("gate:verifying");
      expect(row.decisionJtisUsed ?? new Set()).toEqual(new Set());
    });

    it("a park (edit_issue blocked_by) on a gate that went Done under it is refused and resets nothing", async () => {
      moveAfterRead({ status: "done" });
      const res = await handler({ name: "Tickets___edit_issue", arguments: { issue_key: GATE, blocked_by: ["TEAM-4932"] } });
      expect(res).toMatchObject({ ok: false, reason: "decision_required", detail: "ticket_moved", status: "done" });
      const row = h.state.items[GATE];
      expect(row.status).toBe("done");
      expect(row.gateCycleResetAt).toBeUndefined();
      expect(row.blockedBy).toBeUndefined();
    });

    it("a park whose gate did NOT move lands, pinned to the status and cycle it read", async () => {
      const res = await handler({ name: "Tickets___edit_issue", arguments: { issue_key: GATE, blocked_by: ["TEAM-4932"] } });
      expect(res).toMatchObject({ status: "updated", fields: { status: { name: "blocked" } } });
      const park = h.state.statusWrites.at(-1);
      expect(park.ConditionExpression).toBe("#s = :cur AND attribute_not_exists(#gcr)");
      expect(h.state.items[GATE].gateCycleResetAt).toBeDefined();
    });
  });
});

describe("TEAM-5148 decision-bound fixture — expected[] rows", () => {
  const fx = fixture("TEAM-5148-decision-bound-gate.synthetic.json");
  const GATE = fx.ticket.ticketId;
  const WF = "wf_bug_TEAM-5038";

  /** The fixture's ticket with its first `n` comments, as a DynamoDB row. */
  const rowWith = (n, over = {}) => ({
    ticketId: GATE,
    title: fx.ticket.title,
    assignee: fx.ticket.assignee,
    status: fx.ticket.status,
    parentId: fx.ticket.parent,
    workflowId: WF,
    description: fx.ticket.description,
    labels: [],
    comments: fx.ticket.comments.slice(0, n).map((c, i) => ({ id: `c${i}`, author: c.author, content: c.body })),
    ...over,
  });

  it("row 1: done with no answer is refused with the declared options", async () => {
    const row = fx.expected[0];
    h.state.items[GATE] = rowWith(row.comments);
    const res = await transition({ ticket_id: GATE, transition_id: row.transition, ...row.args });
    expect(res).toMatchObject(row.result);
  });

  it("row 2: the human's DECISION is admitted through a signed token (documented deviation)", async () => {
    const row = fx.expected[1];
    // DEVIATION from the fixture's literal row: on the DynamoDB twin a comment's
    // author is whatever the add_comment caller asserted (TEAM-5318 F11), so the
    // comment `DECISION: override:approve` alone is NEVER an answer here.
    h.state.items[GATE] = rowWith(row.comments);
    expect(await transition({ ticket_id: GATE, transition_id: row.transition, ...row.args }))
      .toMatchObject({ ok: false, reason: "decision_required", detail: "unsigned_decision_ignored" });
    // The same human choice made through an authenticated channel is admitted.
    const res = await transition({
      ticket_id: GATE, transition_id: row.transition, ...row.args,
      decision: row.result.decision, decision_token: sign(GATE, row.result.decision, WF, { channel: "hub" }),
    });
    expect(res).toMatchObject({ status: "transitioned", to: "done", decision: { option: row.result.decision, override: row.result.override } });
  });

  it("row 3: skip without a skip record is refused decision_required", async () => {
    const row = fx.expected[2];
    // From the fixture's own in_review (skip is offered there since TEAM-5340 F7)
    // and from blocked: the guard refuses both, and neither status moves.
    expect(row.skipRecord).toBe(false);
    for (const status of ["in_review", "blocked"]) {
      h.state.items[GATE] = rowWith(0, { status });
      expect(await transition({ ticket_id: GATE, transition_id: row.transition, ...row.args }), status).toMatchObject(row.result);
      expect(h.state.items[GATE].status).toBe(status);
    }
  });
});
