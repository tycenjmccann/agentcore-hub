import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-5941 (TEAM-5799 ship-review r2 F1) — a twin's Done racing the replay drain's
 * brief-hold stamp, end to end through the REAL modules. Supersedes the TEAM-5926 cases,
 * which asserted the UNSAFE outcome (a Done committed over a held record, then flagged).
 *
 * The twin's Done guard reads completions/<id>.json, then awaits the provider (the
 * reason comment on Jira, nothing on DynamoDB) and — as the LAST step before its commit —
 * writes `doneIntent` onto the record with IfMatch on the ETag it admitted (the fence).
 * The drain CAS-stamps `briefPending:true` on the same record with IfMatch on its own
 * read. Both write one key conditionally, so exactly one of them wins:
 *
 *   e1  the drain stamps before the fence ⇒ the fence 412s, the twin re-reads, re-judges
 *       and REFUSES with the standard hold text; the ticket stays open under the hold.
 *   e2  the fence lands before the drain reads ⇒ the drain sees a FRESH intent on a
 *       ticket not yet Done and backs off (retry, no stamp, no LEFT OPEN notice); the Done
 *       commits with no conflict; the next tick applies with no hold over a Done ticket.
 *   e3  the drain read the record BEFORE the fence and stamps AFTER it ⇒ its stamp 412s
 *       (retry); the Done commits clean; the record never carried a hold.
 *   e4  the twin's commit fails after the fence ⇒ the intent is cleared and the drain's
 *       hold lands as if there had been no Done; e4b: the clear fails too ⇒ the drain waits
 *       out the TTL, then stamps and strips the stale intent.
 *
 * Real: either twin's `handler` (the Done) and workflow-output's `drainCompletion`.
 * Mocked: S3 (one store with ETag/IfMatch/IfNoneMatch semantics — IfMatch on a missing
 * key answers 404, as S3 does — shared by both), the twins' own storage (fetch for Jira,
 * lib-dynamodb for the tickets table), and the drain's Tickets___* invoke, answered from
 * the same ticket state the twin writes. The drain never transitions on these paths
 * (the ticket is either held or already Done), so its provider needs no transition; the
 * drain's own Done path is covered by ticket-probe.test.mjs.
 */

const h = vi.hoisted(() => ({
  objects: new Map(), // key -> { body, etag }
  /** Every body ever stored under KEY, in order — so "never carried a hold" is assertable. */
  history: [],
  etagSeq: 0,
  ticket: { status: "in_progress", twinComments: [], drainComments: new Map() },
  /** Awaited at the twin's provider commit (the Jira transition POST / the DynamoDB status write). */
  beforeCommit: null,
  /** Awaited before the twin's fence PUT (a body carrying doneIntent) is applied. One-shot. */
  beforeFencePut: null,
  /** Awaited before the drain's hold stamp (a body with briefPending:true) is applied. One-shot. */
  beforeDrainStamp: null,
  /** The next provider commit fails (Jira 500 / a thrown UpdateCommand). One-shot. */
  failCommitOnce: false,
  /** The next PUT that takes doneIntent OFF the record (the twin's clear) fails with a 500. One-shot. */
  failClearOnce: false,
  /**
   * Awaited before the drain's get_issue of the build ticket is answered. TEAM-5940: a
   * string it returns is the provider's failure for THAT read (`{ error }`, the jira idiom).
   */
  beforeDrainRead: null,
  /** TEAM-5940 repro: awaited before the drain's add_comment on a ticket is applied. */
  beforeDrainComment: null,
}));

const notFound = (k) => Object.assign(new Error(`NoSuchKey ${k}`), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
const s3Err = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

vi.mock("@aws-sdk/client-s3", () => {
  const named = (n) => ({ [n]: class { constructor(input) { this.input = input; } } })[n];
  const parse = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };
  return {
    S3Client: class {
      async send(c) {
        const name = c.constructor.name;
        const { Key, IfMatch, IfNoneMatch, Body } = c.input;
        if (name === "GetObjectCommand") {
          const cur = h.objects.get(Key);
          if (!cur) throw notFound(Key);
          return { ETag: cur.etag, Body: { transformToString: async () => cur.body } };
        }
        if (name === "PutObjectCommand") {
          const body = parse(Body);
          if (Key === h.KEY && body?.doneIntent !== undefined && h.beforeFencePut) {
            const wait = h.beforeFencePut;
            h.beforeFencePut = null;
            await wait();
          }
          if (Key === h.KEY && body?.briefPending === true && h.beforeDrainStamp) {
            const wait = h.beforeDrainStamp;
            h.beforeDrainStamp = null;
            await wait();
          }
          // Read the current object AFTER the hooks: they are where a concurrent writer lands.
          const cur = h.objects.get(Key);
          if (Key === h.KEY && h.failClearOnce && cur && parse(cur.body)?.doneIntent !== undefined && body && body.doneIntent === undefined) {
            h.failClearOnce = false;
            throw s3Err("InternalError", 500);
          }
          if (IfMatch !== undefined && !cur) throw notFound(Key);
          if ((IfMatch !== undefined && cur.etag !== IfMatch) || (IfNoneMatch === "*" && cur)) {
            throw s3Err("PreconditionFailed", 412);
          }
          const etag = `"e${++h.etagSeq}"`;
          h.objects.set(Key, { body: String(Body), etag });
          if (Key === h.KEY) h.history.push(String(Body));
          return { ETag: etag };
        }
        if (name === "HeadObjectCommand") {
          const cur = h.objects.get(Key);
          if (!cur) throw notFound(Key);
          return { ETag: cur.etag };
        }
        return {};
      }
    },
    GetObjectCommand: named("GetObjectCommand"), PutObjectCommand: named("PutObjectCommand"),
    HeadObjectCommand: named("HeadObjectCommand"), ListObjectsV2Command: named("ListObjectsV2Command"),
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

const T = "TEAM-100";
const EPIC = "TEAM-1";
const KEY = `completions/${T}.json`;
h.KEY = KEY;
const BRIEF = "workflows/wf_1/shared/merge-brief.md";
const jiraName = (s) => ({ in_progress: "In Progress", done: "Done", todo: "To Do" })[s] || s;

// The tickets twin's table: the one row, and its comment appends.
vi.mock("@aws-sdk/lib-dynamodb", () => {
  const named = (n) => ({ [n]: class { constructor(input) { this.input = input; } } })[n];
  return {
    GetCommand: named("GetCommand"), PutCommand: named("PutCommand"), UpdateCommand: named("UpdateCommand"),
    QueryCommand: named("QueryCommand"), ScanCommand: named("ScanCommand"),
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (c) => {
          const name = c.constructor.name;
          const i = c.input;
          if (name === "GetCommand" && i.Key?.ticketId === T) {
            return { Item: { ticketId: T, status: h.ticket.status, assignee: "agentcore_hub_operator", phase: "verification", parentKey: EPIC, workflowId: "wf_1" } };
          }
          if (name === "UpdateCommand" && i.Key?.ticketId === T && i.ExpressionAttributeValues?.[":s"] !== undefined) {
            await h.beforeCommit?.();
            if (h.failCommitOnce) {
              h.failCommitOnce = false;
              throw Object.assign(new Error("ProvisionedThroughputExceededException"), { name: "ProvisionedThroughputExceededException" });
            }
            h.ticket.status = i.ExpressionAttributeValues[":s"];
            return {};
          }
          if (name === "UpdateCommand" && i.Key?.ticketId === T && i.ExpressionAttributeValues?.[":comment"]) {
            h.ticket.twinComments.push(i.ExpressionAttributeValues[":comment"][0].content);
            return {};
          }
          return {};
        },
      }),
    },
  };
});

// The drain's ticket provider, over the same ticket state the twin writes.
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(c) {
      const { tool_name: tool, parameters: p = {} } = JSON.parse(Buffer.from(c.input.Payload).toString("utf8"));
      const comments = (id) => h.ticket.drainComments.get(id) || h.ticket.drainComments.set(id, []).get(id);
      let out;
      if (tool === "Tickets___get_issue") {
        const fail = p.ticket_id === T ? await h.beforeDrainRead?.(p) : null;
        out = fail ? { error: fail }
          : p.ticket_id === T
          ? { key: T, fields: { summary: "Operator: verify", status: { name: jiraName(h.ticket.status) }, parent: { key: EPIC }, assignee: { displayName: "agentcore_hub_operator" } }, comments: comments(T).map((body) => ({ body })) }
          : { key: p.ticket_id, fields: { summary: "Epic", status: { name: "In Progress" } }, comments: comments(p.ticket_id).map((body) => ({ body })) };
      } else if (tool === "Tickets___list_tickets") {
        out = { tickets: [], complete: true }; // no open Merge Approval gate ⇒ the brief goes off_gate ⇒ a hold
      } else if (tool === "Tickets___add_comment") {
        await h.beforeDrainComment?.(p);
        comments(p.ticket_id).push(p.comment);
        out = { ticketId: p.ticket_id, message: "Comment added" };
      } else {
        throw new Error(`the drain called ${tool}`);
      }
      return { Payload: new TextEncoder().encode(JSON.stringify(out)) };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

// The Jira twin's REST, over the same ticket state.
function jiraFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || "GET").toUpperCase();
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (u.includes(`/issue/${T}/comment`) && m === "POST") {
      const body = JSON.parse(init.body).body;
      h.ticket.twinComments.push(body.content.map((p) => p.content.map((t) => t.text).join("")).join("\n"));
      return json({ id: "c1" }, 201);
    }
    if (u.includes(`/issue/${T}/transitions`) && m === "GET") return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
    if (u.includes(`/issue/${T}/transitions`) && m === "POST") {
      // The commit. TEAM-5941: the fence is the last awaited step before this POST.
      await h.beforeCommit?.();
      if (h.failCommitOnce) {
        h.failCommitOnce = false;
        return json({ errorMessages: ["boom"] }, 500);
      }
      h.ticket.status = "done";
      return new Response(null, { status: 204 });
    }
    if (u.includes(`/issue/${T}?fields=labels`)) return json({ key: T, fields: { labels: ["agent:agentcore_hub_operator", "phase:verification", "wf:wf_1"], description: null } });
    if (u.includes(`/issue/${T}?fields=status`)) return json({ key: T, fields: { status: { name: jiraName(h.ticket.status) } }, changelog: { histories: [], total: 0 } });
    throw new Error(`unexpected Jira ${m} ${u}`);
  };
}

const TWINS = {
  jira: {
    env: { TICKET_PROVIDER: "jira", JIRA_SITE_URL: "https://x.atlassian.net", JIRA_EMAIL: "a@b", JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM" },
    load: async () => (await import("../agentcore-hub-jira/index.mjs")).handler,
    done: (handler) => handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: T, transition_id: "done", reason: "verified" } }),
    committed: (res) => res.status === "done" && res.error === undefined,
    refusal: (res) => res.error || "",
    commitFailure: /Jira API 500/,
  },
  tickets: {
    env: { TICKET_PROVIDER: "dynamodb" },
    load: async () => (await import("../agentcore-hub-tickets/index.mjs")).handler,
    done: (handler) => handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: T, transition_id: "done" } }),
    committed: (res) => res.status === "transitioned",
    refusal: (res) => res.error || res.content?.[0]?.text || "",
    commitFailure: /ProvisionedThroughputExceededException/,
  },
};

const MSG = { ticketId: T, workflowId: "wf_1", reportKey: KEY, epicKey: EPIC, agentId: "agentcore_hub_operator", brief: { s3Key: BRIEF } };
const record = () => JSON.parse(h.objects.get(KEY).body);
const released = (id) => (h.ticket.drainComments.get(id) || []).filter((c) => c.startsWith(`[brief-hold-released:${T}]`));
const dropNotices = (id) => (h.ticket.drainComments.get(id) || []).filter((c) => c.startsWith(`[replay-dropped:${T}:`));
const offGateNotices = (id) => (h.ticket.drainComments.get(id) || []).filter((c) => /MERGE BRIEF NOT ON THE GATE/.test(c));
const HOLD_REFUSAL_RE = /\bhas briefPending:true \(brief /;
const PROVIDER_503 = 'Jira API 503: {"message":"Your Jira Cloud subscription has been deactivated due to inactivity","errorCode":"SUSPENDED_INACTIVITY"}';
const put = (k, body) => h.objects.set(k, { body, etag: `"e${++h.etagSeq}"` });
/** A barrier: `wait()` parks the caller until `open()`. */
const barrier = () => {
  let open;
  let reached;
  const opened = new Promise((r) => (open = r));
  const arrived = new Promise((r) => (reached = r));
  return { wait: async () => { reached(); await opened; }, open, arrived };
};
const resetWorld = (status = "in_progress") => {
  h.objects.clear();
  h.history.length = 0;
  h.etagSeq = 0;
  h.ticket = { status, twinComments: [], drainComments: new Map() };
  h.beforeCommit = null;
  h.beforeFencePut = null;
  h.beforeDrainStamp = null;
  h.failCommitOnce = false;
  h.failClearOnce = false;
  h.beforeDrainRead = null;
  h.beforeDrainComment = null;
};

describe.each(Object.keys(TWINS))("TEAM-5941 e2e — the %s twin's Done-intent fence vs the drain's brief-hold stamp", (name) => {
  const twin = TWINS[name];
  let handler;
  let drainCompletion;
  let judgeBriefHold;

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetWorld();
    put(KEY, JSON.stringify({ ticketId: T, workflowId: "wf_1", status: "complete", followUpsPending: false, ticketWrites: "queued", summary: "operator done" }));
    put(BRIEF, "# Merge brief\n\n## Decision\nmerge");
    for (const k of ["TICKET_PROVIDER", "JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "EVENTS_TABLE"]) delete process.env[k];
    Object.assign(process.env, { ARTIFACT_BUCKET: "bkt", ...twin.env });
    vi.stubGlobal("fetch", jiraFetch());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    handler = await twin.load();
    ({ drainCompletion } = await import("./index.mjs"));
    ({ judgeBriefHold } = await import("../agentcore-hub-tickets/gate-contract.mjs"));
  });

  it("(e1) the drain stamps the hold before the fence ⇒ the Done is REFUSED with the hold text; the ticket stays open under the hold; no conflict, no intent", async () => {
    const fence = barrier();
    h.beforeFencePut = fence.wait;
    const done = twin.done(handler);
    // The guard admitted the unheld record; the fence is not written yet. (On a build with
    // no fence the Done simply commits — say so instead of hanging on the barrier.)
    const reached = await Promise.race([fence.arrived.then(() => "fence"), done.then(() => "committed")]);
    expect(reached, "the twin must fence the record before its commit").toBe("fence");

    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(1);

    fence.open();
    const res = await done;
    expect(h.ticket.status).toBe("in_progress"); // SAFE: never Done over the hold
    expect(twin.committed(res)).toBe(false);
    expect(twin.refusal(res)).toMatch(HOLD_REFUSAL_RE);
    expect(res.reason).toBe("completion_record_required");
    expect(res.conflict).toBeUndefined();
    expect(h.ticket.twinComments.filter((c) => c.startsWith("Conflict: "))).toHaveLength(0);
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    expect(record().doneIntent).toBeUndefined(); // a lost fence writes nothing
    expect(judgeBriefHold(KEY, h.objects.get(KEY).body)).toMatchObject({ proven: false });

    // The hold holds: a second Done is refused the same way, and a redelivered message is
    // an idempotent final drop (notices deduped), still no Done.
    expect(twin.refusal(await twin.done(handler))).toMatch(HOLD_REFUSAL_RE);
    expect(await drainCompletion(MSG)).toMatchObject({ outcome: "dropped", permanent: true });
    expect(h.ticket.status).toBe("in_progress");
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(1);
    expect(released(T)).toHaveLength(0);
  });

  it("(e2) the fence lands before the drain reads ⇒ the drain backs off (retry, no stamp, no notice); the Done commits clean; the next tick applies with no hold", async () => {
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived; // the fence is on the record; the commit has not happened
    expect(record().doneIntent).toMatchObject({ provider: name === "jira" ? "jira" : "dynamodb" });
    expect(h.ticket.status).toBe("in_progress");
    const etagAfterFence = h.objects.get(KEY).etag;

    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/has a Done in flight \(doneIntent /) });
    expect(h.objects.get(KEY).etag).toBe(etagAfterFence); // not one record write
    expect(record().briefPending).toBeUndefined();
    for (const id of [T, EPIC]) {
      expect(dropNotices(id)).toHaveLength(0); // nothing is "LEFT OPEN"
      expect(offGateNotices(id)).toHaveLength(1); // the brief's own fallback notice is the human's cue
    }

    commit.open();
    const res = await done;
    expect(h.ticket.status).toBe("done");
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined();
    expect(res.warning).toBeUndefined();

    const next = await drainCompletion(MSG);
    expect(next).toMatchObject({ outcome: "applied", alreadyDone: true });
    expect(record()).toMatchObject({ briefDelivered: "off_gate", ticketWrites: "applied", status: "complete" });
    expect(record().briefPending).not.toBe(true);
    expect(record().doneIntent).toBeTruthy(); // carried, never a hold
    expect(judgeBriefHold(KEY, h.objects.get(KEY).body)).toBeNull();
    for (const id of [T, EPIC]) {
      expect(released(id)).toHaveLength(0); // there was no hold to release
      expect(offGateNotices(id)).toHaveLength(1); // deduped
    }
    expect(h.history.every((b) => JSON.parse(b).briefPending !== true)).toBe(true);
  });

  it("(e3) the drain read the record before the fence and stamps after it ⇒ its stamp loses the CAS (retry); the Done commits clean; the record never carried a hold", async () => {
    const stamp = barrier();
    h.beforeDrainStamp = stamp.wait;
    const drainP = drainCompletion(MSG);
    await stamp.arrived; // step 0 read the pre-fence ETag; the hold stamp is about to be written

    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived; // the fence landed on the record the drain is about to stamp over
    expect(record().doneIntent).toBeTruthy();

    stamp.open();
    const drained = await drainP;
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/changed since the drain read it/) });
    expect(record().briefPending).toBeUndefined();

    commit.open();
    const res = await done;
    expect(h.ticket.status).toBe("done");
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined();

    const next = await drainCompletion(MSG);
    expect(next).toMatchObject({ outcome: "applied", alreadyDone: true });
    expect(record()).toMatchObject({ briefDelivered: "off_gate", ticketWrites: "applied" });
    expect(judgeBriefHold(KEY, h.objects.get(KEY).body)).toBeNull();
    expect(h.history.every((b) => JSON.parse(b).briefPending !== true)).toBe(true); // never a hold, not even transiently
    expect(released(T)).toHaveLength(0);
    // Documented residual: the drop's LEFT OPEN notice was posted before its stamp lost
    // (TEAM-5866 posts notices first so a drop is never silent); the Done that followed
    // supersedes it, and the off-gate brief notice stays the human's cue.
    expect(dropNotices(T)).toHaveLength(1);
  });

  it("(e4) the commit fails after the fence ⇒ the error propagates, the intent is cleared, and the drain's hold lands as if no Done had been tried", async () => {
    h.failCommitOnce = true;
    const res = await twin.done(handler);
    expect(twin.committed(res)).toBe(false);
    expect(twin.refusal(res)).toMatch(twin.commitFailure);
    expect(h.ticket.status).toBe("in_progress");
    expect(record().doneIntent).toBeUndefined(); // cleared
    expect(h.history.some((b) => JSON.parse(b).doneIntent)).toBe(true); // ... but it had been written

    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    expect(record().doneIntent).toBeUndefined();
    expect(twin.refusal(await twin.done(handler))).toMatch(HOLD_REFUSAL_RE);
  });

  it("(e4b) the commit fails and the clear fails too ⇒ the drain waits (retry) while the intent is fresh, then stamps the hold and strips the stale intent", async () => {
    h.failCommitOnce = true;
    h.failClearOnce = true;
    const res = await twin.done(handler);
    expect(twin.committed(res)).toBe(false);
    expect(h.ticket.status).toBe("in_progress");
    expect(record().doneIntent).toBeTruthy(); // the clear failed: the intent stays

    const waiting = await drainCompletion(MSG);
    expect(waiting).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/Done in flight/) });
    expect(record().briefPending).toBeUndefined();
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(0);

    // Past the TTL the intent is stale: the twin that wrote it is gone.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60_000);
    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    expect(record().doneIntent).toBeUndefined(); // stripped with the stamp
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(1);
    expect(h.ticket.status).toBe("in_progress");
  });
});

/**
 * TEAM-5940 (TEAM-5799) REPRODUCTION — the releasedHold path trusts the step-1
 * `alreadyDone` snapshot across the awaited provider calls of steps 2-6. A ticket a
 * human reopens in that window (Done → In Progress, e.g. while the drain is writing the
 * off-gate fallback comment on it) is open again, with its merge brief still NOT on the
 * gate — yet the drain clears briefPending, skips the Done (stale alreadyDone) and marks
 * the record applied. judgeBriefHold then admits a later Done with no brief on the gate:
 * TEAM-5866's invariant (briefPending stays true until gate delivery is proven) is broken.
 */
describe("TEAM-5940 repro — a ticket reopened during the drain's fallback-comment write", () => {
  let drainCompletion;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // The state a Done landing under a stamped hold leaves behind (a writer that walked
    // around the fence; the fence itself makes this unreachable for the hub's writers).
    resetWorld("done");
    put(KEY, JSON.stringify({
      ticketId: T, workflowId: "wf_1", status: "complete", followUpsPending: false, ticketWrites: "dropped",
      briefPending: true, briefDelivered: "off_gate", briefTargets: [T, EPIC], briefFallbackReason: "no open Merge Approval gate",
      summary: "operator done",
    }));
    put(BRIEF, "# Merge brief\n\n## Decision\nmerge");
    for (const k of ["TICKET_PROVIDER", "JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "EVENTS_TABLE"]) delete process.env[k];
    Object.assign(process.env, { ARTIFACT_BUCKET: "bkt", TICKET_PROVIDER: "jira" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    ({ drainCompletion } = await import("./index.mjs"));
  });

  it("keeps the hold: briefPending stays true, the record is not applied as a released hold, and the drain does not skip the Done on a stale snapshot", async () => {
    // The brief has no gate (no Merge Approval sibling), so postQueuedBrief posts the
    // fallback comment on the ticket and its epic. The ticket is reopened WHILE that
    // fallback comment on the ticket is being written - after step 1 read it Done.
    const sawFallbackOnTicket = [];
    h.beforeDrainComment = async (p) => {
      if (p.ticket_id !== T || !/MERGE BRIEF NOT ON THE GATE/.test(p.comment)) return;
      sawFallbackOnTicket.push(h.ticket.status);
      h.ticket.status = "in_progress"; // a human reopened it
    };

    const drained = await drainCompletion(MSG);

    expect(sawFallbackOnTicket).toEqual(["done"]); // the reopen happened inside the window
    expect(jiraName(h.ticket.status)).toBe("In Progress"); // the drain never moved it
    const rec = record();
    expect(rec.briefDelivered).toBe("off_gate"); // the brief is still NOT on the gate ...
    expect(rec.briefPending).toBe(true); // ... so the hold MUST survive (TEAM-5866 invariant)
    expect(rec.ticketWrites).not.toBe("applied"); // and the record is not closed as a released hold
    expect(drained.outcome).not.toBe("applied");
    // No "hold released" notice: nothing released it - the ticket is open with no brief on the gate.
    for (const id of [T, EPIC]) expect(released(id)).toHaveLength(0);
    // The fresh read made it the held path: the drop is final, the LEFT OPEN notice is on
    // the ticket and its epic, and the twins' Done guard refuses the next Done.
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(rec).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "brief" } });
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(1);
  });

  it("an unreadable fresh read before the hold decision ⇒ retry; the record is untouched and no notice is posted", async () => {
    // The read right after the brief's fallback comments is the pre-decision read: fail it.
    let failed = 0;
    h.beforeDrainRead = (p) => {
      const fallbackPosted = (h.ticket.drainComments.get(T) || []).some((c) => /MERGE BRIEF NOT ON THE GATE/.test(c));
      if (fallbackPosted && failed === 0) { failed++; return PROVIDER_503; }
      return null;
    };
    const etagBefore = h.objects.get(KEY).etag;

    const drained = await drainCompletion(MSG);

    expect(failed).toBe(1);
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/re-read of TEAM-100 before the hold decision failed/) });
    expect(h.objects.get(KEY).etag).toBe(etagBefore); // not one record write
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped" });
    for (const id of [T, EPIC]) expect(released(id)).toHaveLength(0);
    expect(jiraName(h.ticket.status)).toBe("Done");
  });

  it("a reopen during the released-notice write ⇒ the fence before the clear catches it: retry, hold kept; the next drain converges to the held path", async () => {
    // After the pre-decision read saw Done, the drain posts the released notices. The
    // ticket is reopened while that notice is being written on it.
    const reopenedAt = [];
    h.beforeDrainComment = async (p) => {
      if (p.ticket_id !== T || !p.comment.startsWith(`[brief-hold-released:${T}]`)) return;
      reopenedAt.push(h.ticket.status);
      h.ticket.status = "in_progress";
    };
    const etagBefore = h.objects.get(KEY).etag;

    const drained = await drainCompletion(MSG);

    expect(reopenedAt).toEqual(["done"]); // the reopen landed after the pre-decision read
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/reopened after the brief-hold-released notice/) });
    expect(h.objects.get(KEY).etag).toBe(etagBefore); // the clear never reached S3
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped" });
    expect(jiraName(h.ticket.status)).toBe("In Progress");

    // The next tick reads the ticket open at step 1 and takes the held path: final drop,
    // hold stamped, no second released notice.
    h.beforeDrainComment = null;
    const next = await drainCompletion(MSG);
    expect(next).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped", replayDropped: { step: "brief" } });
    expect(released(T)).toHaveLength(1);
    expect(jiraName(h.ticket.status)).toBe("In Progress");
  });

  it("an unreadable fence read right before the clear ⇒ retry; the hold is kept and the record untouched", async () => {
    let failed = 0;
    h.beforeDrainRead = (p) => {
      // The first get_issue of the ticket after the released notice landed on it is the fence.
      if (released(T).length > 0 && failed === 0) { failed++; return PROVIDER_503; }
      return null;
    };
    const etagBefore = h.objects.get(KEY).etag;

    const drained = await drainCompletion(MSG);

    expect(failed).toBe(1);
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/before releasing the brief hold failed/) });
    expect(h.objects.get(KEY).etag).toBe(etagBefore);
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped" });
    expect(jiraName(h.ticket.status)).toBe("Done");
  });
});
