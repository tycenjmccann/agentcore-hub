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
  /**
   * TEAM-5958: awaited (with the parsed body) before ANY PutObject on KEY is applied — the
   * seam where a reopen lands "right before the record write", and where a second writer
   * can be started so a CAS attempt finds the record moved. Not one-shot: the hook decides.
   */
  beforeRecordPut: null,
  /** TEAM-5958 F6: the ticket is ship-phase (release manager, `phase:ship`) ⇒ completionRecordProven is the judge. */
  ship: false,
  /** TEAM-5958 F6: a definite refusal every Tickets___create_ticket answers (`{ error }`, the jira idiom). */
  createRefusal: null,
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
          if (Key === h.KEY && h.beforeRecordPut) await h.beforeRecordPut(body);
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
            return { Item: { ticketId: T, status: h.ticket.status, assignee: h.ship ? "agentcore_hub_release_manager" : "agentcore_hub_operator", phase: h.ship ? "ship" : "verification", parentKey: EPIC, workflowId: "wf_1" } };
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
          ? { key: T, fields: { summary: h.ship ? "Ship: release" : "Operator: verify", status: { name: jiraName(h.ticket.status) }, parent: { key: EPIC }, assignee: { displayName: h.ship ? "agentcore_hub_release_manager" : "agentcore_hub_operator" } }, comments: comments(T).map((body) => ({ body })) }
          : { key: p.ticket_id, fields: { summary: "Epic", status: { name: "In Progress" } }, comments: comments(p.ticket_id).map((body) => ({ body })) };
      } else if (tool === "Tickets___list_tickets") {
        out = { tickets: [], complete: true }; // no open Merge Approval gate ⇒ the brief goes off_gate ⇒ a hold
      } else if (tool === "Tickets___add_comment") {
        await h.beforeDrainComment?.(p);
        comments(p.ticket_id).push(p.comment);
        out = { ticketId: p.ticket_id, message: "Comment added" };
      } else if (tool === "Tickets___create_ticket") {
        // TEAM-5958 F6: report_completion's follow-up create — refused (a hold) or created.
        out = h.createRefusal ? { error: h.createRefusal } : { ticketId: `TEAM-9${String(comments("__created").push(p.summary)).padStart(3, "0")}`, status: "todo", message: "Created" };
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
    if (u.includes(`/issue/${T}?fields=labels`)) return json({ key: T, fields: { labels: h.ship ? ["agent:agentcore_hub_release_manager", "phase:ship", "wf:wf_1"] : ["agent:agentcore_hub_operator", "phase:verification", "wf:wf_1"], description: null } });
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
  h.beforeRecordPut = null;
  h.ship = false;
  h.createRefusal = null;
};
const TWIN_GATE_CONTRACTS = [() => import("../agentcore-hub-jira/gate-contract.mjs"), () => import("../agentcore-hub-tickets/gate-contract.mjs")];

describe.each(Object.keys(TWINS))("TEAM-5941 e2e — the %s twin's Done-intent fence vs the drain's brief-hold stamp", (name) => {
  const twin = TWINS[name];
  let handler;
  let drainCompletion;
  let judgeBriefHold;
  let isIntentOnlyReservation;

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
    ({ judgeBriefHold, isIntentOnlyReservation } = await import("../agentcore-hub-tickets/gate-contract.mjs"));
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

  it("(e5, TEAM-5959 F5) the guard reads NO record ⇒ the fence RESERVES the key create-only; a rival creator 412s, re-reads and writes IfMatch carrying the intent; the drain DEFERS its hold; the Done commits clean", async () => {
    // (1) the ticket has no completion record yet: the guard's briefHoldOf reads 404 and admits.
    h.objects.delete(KEY);
    h.history.length = 0;
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    // (2) the twin is paused right before its provider commit. On the base build
    //     fenceDoneIntent returned early on `admitted.absent` and nothing was on the key;
    //     now an intent-only reservation is.
    await commit.arrived;
    expect(h.objects.has(KEY), "the 404 admission reserved the key").toBe(true);
    expect(isIntentOnlyReservation(record())).toBe(true);
    expect(record().doneIntent).toMatchObject({ provider: name === "jira" ? "jira" : "dynamodb" });
    const reservedEtag = h.objects.get(KEY).etag;

    // (3) another writer (report_completion's first write, or the hub route) tries the
    //     create-only PUT — and loses: the key is taken.
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({});
    const clean = { ticketId: T, workflowId: "wf_1", status: "complete", followUpsPending: false, ticketWrites: "queued", summary: "operator done" };
    await expect(s3.send(new PutObjectCommand({ Bucket: "bkt", Key: KEY, ContentType: "application/json", IfNoneMatch: "*", Body: JSON.stringify(clean) })))
      .rejects.toMatchObject({ name: "PreconditionFailed" });
    //     So it does what every creator does on 412: re-read, write IfMatch, carry the
    //     intent verbatim (adoptHold / the hub route's spread) and drop the marker.
    await s3.send(new PutObjectCommand({ Bucket: "bkt", Key: KEY, ContentType: "application/json", IfMatch: reservedEtag, Body: JSON.stringify({ ...clean, doneIntent: record().doneIntent }) }));
    expect(isIntentOnlyReservation(record())).toBe(false);
    expect(record().reservation).toBeUndefined();

    // (4) the drain reads a record with a FRESH intent on a ticket not yet Done: the hold is
    //     not stamped (holdDeferredOnDoneIntent), no LEFT OPEN notice, retry.
    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/has a Done in flight \(doneIntent /) });
    expect(record().briefPending).toBeUndefined();
    for (const id of [T, EPIC]) expect(dropNotices(id)).toHaveLength(0);

    // (5) the twin resumes and commits over a record that still has no hold.
    commit.open();
    const res = await done;
    expect({
      ticketStatus: h.ticket.status,
      committed: twin.committed(res),
      briefPending: record().briefPending,
      conflict: res.conflict,
    }).toEqual({ ticketStatus: "done", committed: true, briefPending: undefined, conflict: undefined });
    expect(res.warning).toBeUndefined();

    // The next tick applies over the Done ticket with no hold; the record never carried one.
    const next = await drainCompletion(MSG);
    expect(next).toMatchObject({ outcome: "applied", alreadyDone: true });
    expect(record().briefPending).not.toBe(true);
    expect(h.history.every((b) => JSON.parse(b).briefPending !== true)).toBe(true);
  });

  it("(e5b, TEAM-5959 F5) the same interleaving with the drain as the only writer after the reservation ⇒ it defers on the reservation itself; the Done commits; the reservation stays", async () => {
    h.objects.delete(KEY);
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived;
    expect(isIntentOnlyReservation(record())).toBe(true);

    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/has a Done in flight/) });
    expect(isIntentOnlyReservation(record())).toBe(true); // untouched

    commit.open();
    const res = await done;
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined();
    expect(h.ticket.status).toBe("done");
    expect(isIntentOnlyReservation(record())).toBe(true); // a committed recordless Done leaves the reservation as audit
  });

  it("(e4-reservation, TEAM-5959) the commit fails on a reserved key ⇒ the clear leaves `{reservation, ticketId}`; the next Done on the build ticket is admitted, fenced IfMatch onto it, and commits", async () => {
    h.objects.delete(KEY);
    h.history.length = 0;
    h.failCommitOnce = true;
    const first = await twin.done(handler);
    expect(twin.committed(first)).toBe(false);
    expect(twin.refusal(first)).toMatch(twin.commitFailure);
    expect(h.ticket.status).toBe("in_progress");
    expect(record()).toEqual({ reservation: "done-intent", ticketId: T });
    expect(isIntentOnlyReservation(record())).toBe(true);
    expect(h.history.some((b) => JSON.parse(b).doneIntent)).toBe(true); // it had been written
    const clearedEtag = h.objects.get(KEY).etag;

    const second = await twin.done(handler);
    expect(twin.committed(second)).toBe(true);
    expect(second.conflict).toBeUndefined();
    expect(h.ticket.status).toBe("done");
    expect(h.objects.get(KEY).etag).not.toBe(clearedEtag); // one IfMatch fence onto the reservation
    expect(isIntentOnlyReservation(record())).toBe(true);
    expect(record().doneIntent).toMatchObject({ provider: name === "jira" ? "jira" : "dynamodb" });
    expect(h.history.filter((b) => JSON.parse(b).reservation === "done-intent")).toHaveLength(3); // reserve, clear, fence
  });

  it("(e7, TEAM-5959) the drain stamps its hold onto an intent-cleared reservation ⇒ the record is a HOLD, not a reservation: both twins refuse the next Done with the standard text", async () => {
    h.objects.delete(KEY);
    h.failCommitOnce = true;
    await twin.done(handler); // leaves {reservation, ticketId}
    expect(record()).toEqual({ reservation: "done-intent", ticketId: T });

    const drained = await drainCompletion(MSG); // no intent ⇒ nothing defers the stamp
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ reservation: "done-intent", briefPending: true, ticketWrites: "dropped" });
    expect(isIntentOnlyReservation(record())).toBe(false);

    const res = await twin.done(handler);
    expect(twin.committed(res)).toBe(false);
    expect(twin.refusal(res)).toMatch(HOLD_REFUSAL_RE);
    expect(h.ticket.status).toBe("in_progress");
    for (const gate of TWIN_GATE_CONTRACTS) {
      const m = await gate();
      expect(m.judgeBriefHold(KEY, h.objects.get(KEY).body)).toMatchObject({ proven: false });
      expect(m.judgeCompletionRecord(KEY, h.objects.get(KEY).body).why).toMatch(HOLD_REFUSAL_RE); // ship: hold first, never the reservation text
    }
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

  it("a reopen during the released-notice write ⇒ TEAM-5958: there is no clear left to race - the drain applies with the hold KEPT, both twins' judge still refuses a Done on the record, and a redelivery is a no-op", async () => {
    // After the pre-decision read saw Done, the drain posts the superseded notices. The
    // ticket is reopened while that notice is being written on it. TEAM-5940 fenced the
    // clear on a ticket re-read here (retry); the fence could not be honoured by the S3
    // condition, so TEAM-5958 removed the clear instead: an undelivered hold is never
    // released, and the record needs no fence to stay correct across the reopen.
    const reopenedAt = [];
    h.beforeDrainComment = async (p) => {
      if (p.ticket_id !== T || !p.comment.startsWith(`[brief-hold-released:${T}]`)) return;
      reopenedAt.push(h.ticket.status);
      h.ticket.status = "in_progress";
    };

    const drained = await drainCompletion(MSG);

    expect(reopenedAt).toEqual(["done"]); // the reopen landed after the pre-decision read
    expect(drained).toMatchObject({ outcome: "applied", alreadyDone: true }); // bounded: the message goes
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "applied", status: "complete" });
    expect(jiraName(h.ticket.status)).toBe("In Progress"); // the drain never moved it
    for (const gate of TWIN_GATE_CONTRACTS) {
      expect((await gate()).judgeBriefHold(KEY, h.objects.get(KEY).body)).toMatchObject({ proven: false, why: expect.stringMatching(HOLD_REFUSAL_RE) });
    }
    expect(released(T)).toHaveLength(1);
    expect(released(T)[0]).toMatch(/still holds briefPending:true/);

    // A redelivered message finds the record applied: nothing to do, no second notice.
    expect(await drainCompletion(MSG)).toMatchObject({ outcome: "dropped", reason: "already applied" });
    expect(released(T)).toHaveLength(1);
    expect(record().briefPending).toBe(true);
  });
  // The fourth TEAM-5940 case ("an unreadable fence read right before the clear") is gone
  // with the fence it exercised: TEAM-5958 removed the clear, so no ticket read decides it.
  // What it guarded — a reopen the drain cannot see never erases the hold — is the
  // TEAM-5958 F4 e2e below, against both real twins.
});

/**
 * TEAM-5958 (TEAM-5799 F4 residual) — the drain's `releasedHold` clear was fenced on a
 * ticket-status read (TEAM-5940), but the clear itself was an S3 PUT conditioned only on
 * the record's ETag: a reopen between that read and the PUT erased an UNDELIVERED hold,
 * for good — nothing re-stamps it (a reopen never touches the record; on Jira it never
 * reaches a twin at all). TEAM-5866's invariant: `briefPending:true` goes false only on
 * proof the brief is on the gate. The fix does not fence better; it stops clearing.
 *
 * Real: `drainCompletion` and either twin's Done handler. The reopen is injected at the
 * S3 seam, right before the drain's record write (after its last status read on the
 * base build), and the twin then tries the Done a human (or the cascade) would retry.
 */
describe.each(Object.keys(TWINS))("TEAM-5958 F4 e2e — a reopen after the drain's final status read never erases an undelivered hold (%s twin)", (name) => {
  const twin = TWINS[name];
  let handler;
  let drainCompletion;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // The TEAM-5926 state: a hold stamped, then a Done landed over it (a human, or a
    // writer around the fence). The brief has no gate (no Merge Approval sibling).
    resetWorld("done");
    put(KEY, JSON.stringify({
      ticketId: T, workflowId: "wf_1", status: "complete", followUpsPending: false, ticketWrites: "dropped",
      briefPending: true, briefDelivered: "off_gate", briefTargets: [T, EPIC], briefFallbackReason: "no open Merge Approval gate",
      replayDropped: { step: "brief", error: "merge brief is not on the Merge Approval gate" }, summary: "operator done",
    }));
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
  });

  it("(h0) no reopen: the Done stands, the drain applies with the hold KEPT, the superseded notice is posted once, a redelivery is a no-op", async () => {
    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "applied", alreadyDone: true });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "applied", status: "complete", followUpsPending: false });
    for (const id of [T, EPIC]) {
      expect(released(id)).toHaveLength(1);
      expect(released(id)[0]).toMatch(/still holds briefPending:true/);
      expect(released(id)[0]).not.toMatch(/no longer holds/);
    }
    expect(h.ticket.status).toBe("done");
    expect(await drainCompletion(MSG)).toMatchObject({ outcome: "dropped", reason: "already applied" });
    for (const id of [T, EPIC]) expect(released(id)).toHaveLength(1);
  });

  it("(h1) the ticket is reopened right before the drain's record write ⇒ briefPending stays true, the drain still terminates, and the twin REFUSES the next Done", async () => {
    // The base build's fenceRelease read the ticket Done just before this PUT; the
    // reopen lands after that read and before the write — the window no ticket read closes.
    const flipped = [];
    h.beforeRecordPut = async (body) => {
      if (released(T).length === 0 || flipped.length > 0) return; // the superseded notice is posted after the last status read
      flipped.push({ status: h.ticket.status, briefPending: body.briefPending });
      h.ticket.status = "in_progress"; // a human reopened it
    };

    const drained = await drainCompletion(MSG);

    expect(flipped).toHaveLength(1);
    expect(flipped[0].status).toBe("done"); // the reopen happened inside the window
    expect(h.ticket.status).toBe("in_progress"); // the drain never moved it
    expect(drained.outcome).not.toBe("retry"); // bounded: no fence to retry on
    expect(drained).toMatchObject({ outcome: "applied" });
    const rec = record();
    expect(rec.briefDelivered).toBe("off_gate"); // the brief is still NOT on the gate ...
    expect(rec.briefPending).toBe(true); // ... so the hold MUST survive (TEAM-5866 invariant)
    expect(flipped[0].briefPending).toBe(true); // and the write itself never carried a clear

    // The hold does its job on the reopened ticket: the twin refuses the re-close.
    const res = await twin.done(handler);
    expect(twin.committed(res)).toBe(false);
    expect(twin.refusal(res)).toMatch(HOLD_REFUSAL_RE);
    expect(h.ticket.status).toBe("in_progress");
    expect(record().briefPending).toBe(true);

    // A redelivered message is a no-op; the remedy is report_completion's re-delivery.
    expect(await drainCompletion(MSG)).toMatchObject({ outcome: "dropped", reason: "already applied" });
    expect(released(T)).toHaveLength(1);
  });
});

/**
 * TEAM-5958 (TEAM-5799 F6) — report_completion carried the twins' Done-intent fence
 * (adoptHold, TEAM-5941) but never acted on it: with a follow-up it could not file it
 * CAS-wrote `followUpsPending:true` over a FENCED record, the twin's commit then landed
 * over the hold, and the twin could only flag it afterwards (done_over_follow_ups_hold).
 * Now every hold writer defers while a fresh intent is on the record and the ticket is
 * not Done (holdDeferredOnDoneIntent — the drain's drop() rule), answering a retryable
 * `completion_record_done_in_flight` instead of writing.
 *
 * Real: either twin's Done (the ticket is ship-phase, so completionRecordProven judges
 * `followUpsPending`) and the REAL WorkflowOutput___report_completion handler, whose
 * follow-up create is refused with a definite 400 (not retryable ⇒ a hold, never queued).
 */
describe.each(Object.keys(TWINS))("TEAM-5958 F6 e2e — the %s twin's Done-intent fence vs report_completion's follow-ups hold", (name) => {
  const twin = TWINS[name];
  let handler;
  let output;
  const REPORT = {
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: T, workflow_id: "wf_1", agent_id: "agentcore_hub_release_manager",
      summary: "Shipped; one IAM grant needs a human.",
      follow_ups: JSON.stringify([{ kind: "iam_handoff", owner: "human", title: "Grant the probe role sqs:ReceiveMessage in prod", detail: "The deploy role cannot attach this policy; a human must apply it in the console." }]),
    },
  };
  const answer = (res) => JSON.parse(res.content[0].text);
  const holdEverWritten = () => h.history.some((b) => JSON.parse(b).followUpsPending === true);

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetWorld();
    h.ship = true;
    h.createRefusal = "Jira API 400: Field 'labels' is invalid";
    put(KEY, JSON.stringify({ ticket_id: T, workflowId: "wf_1", status: "complete", followUpsPending: false, summary: "release done", ticketWrites: "applied" }));
    for (const k of ["TICKET_PROVIDER", "JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "EVENTS_TABLE"]) delete process.env[k];
    Object.assign(process.env, { ARTIFACT_BUCKET: "bkt", ...twin.env });
    vi.stubGlobal("fetch", jiraFetch());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    handler = await twin.load();
    output = await import("./index.mjs");
  });

  it("(f1) the twin fenced its Done and is committing ⇒ report_completion DEFERS (no hold written, retryable answer); the Done commits clean with no conflict; the retry then records the hold over the Done ticket", async () => {
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived; // the fence is on the record; the commit has not happened
    expect(record().doneIntent).toMatchObject({ provider: name === "jira" ? "jira" : "dynamodb" });
    const etagFenced = h.objects.get(KEY).etag;

    const first = answer(await output.handler(REPORT));
    expect(first).toMatchObject({ ok: false, reason: "completion_record_done_in_flight", next_action: "retry_report_completion" });
    expect(first.status).toBeUndefined();
    expect(h.objects.get(KEY).etag).toBe(etagFenced); // not one record write
    expect(holdEverWritten()).toBe(false);
    expect(h.ticket.status).toBe("in_progress");

    commit.open();
    const res = await done;
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined(); // SAFE: no Done over a hold, nothing to flag
    expect(res.warning).toBeUndefined();
    expect(h.ticket.twinComments.filter((c) => c.startsWith("Conflict: "))).toHaveLength(0);
    expect(h.ticket.status).toBe("done");
    expect(record().followUpsPending).toBe(false);

    // The retry: the ticket reads Done, so the fresh intent is a committed Done's audit and
    // the unfiled follow-up is recorded against the Done ticket for the human who files it
    // — drop()'s already-Done rule. Done is not attempted (it is Done).
    const second = answer(await output.handler(REPORT));
    expect(second).toMatchObject({ status: "complete_pending_follow_ups", next_action: "retry_report_completion" });
    expect(record()).toMatchObject({ followUpsPending: true, status: "complete_pending_follow_ups" });
    expect(record().doneIntent).toBeTruthy(); // carried, never erased
    expect(h.ticket.status).toBe("done");
  });

  it("(e6, TEAM-5959 F5) the ticket has NO record: the twin reserves the key on its 404 admission ⇒ report_completion's create-only write 412s, re-reads the reservation and DEFERS its hold; the Done commits clean; the retry writes the real record with the marker gone", async () => {
    // A build ticket (not ship-phase): on the base build its 404 admission skipped the
    // fence and report_completion's first write could create a held record in the window.
    h.ship = false;
    h.objects.delete(KEY);
    h.history.length = 0;
    const { isIntentOnlyReservation } = await import("../agentcore-hub-tickets/gate-contract.mjs");
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived;
    expect(isIntentOnlyReservation(record())).toBe(true);
    const reservedEtag = h.objects.get(KEY).etag;

    const first = answer(await output.handler({ ...REPORT, arguments: { ...REPORT.arguments, agent_id: "agentcore_hub_operator" } }));
    expect(first).toMatchObject({ ok: false, reason: "completion_record_done_in_flight", next_action: "retry_report_completion" });
    expect(h.objects.get(KEY).etag).toBe(reservedEtag); // not one record write
    expect(holdEverWritten()).toBe(false);
    expect(isIntentOnlyReservation(record())).toBe(true);
    expect(h.ticket.status).toBe("in_progress");

    commit.open();
    const res = await done;
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined();
    expect(h.ticket.status).toBe("done");

    const second = answer(await output.handler({ ...REPORT, arguments: { ...REPORT.arguments, agent_id: "agentcore_hub_operator" } }));
    expect(second).toMatchObject({ status: "complete_pending_follow_ups", next_action: "retry_report_completion" });
    expect(record()).toMatchObject({ followUpsPending: true, status: "complete_pending_follow_ups", summary: REPORT.arguments.summary });
    expect(record().reservation).toBeUndefined(); // the real writer's record carries no marker
    expect(isIntentOnlyReservation(record())).toBe(false);
    expect(record().doneIntent).toBeTruthy(); // carried, never erased
  });

  it("(f2) report_completion read the record BEFORE the fence and writes after it ⇒ its CAS re-read sees the fresh intent and DEFERS; the Done commits clean", async () => {
    const commit = barrier();
    h.beforeCommit = commit.wait;
    let done = null;
    h.beforeRecordPut = async (body) => {
      // report_completion's hold write is about to land on the ETag it read: a twin reads
      // the still-clean record, fences it, and parks before its commit.
      if (body?.followUpsPending !== true || done) return;
      done = twin.done(handler);
      await commit.arrived;
    };

    const first = answer(await output.handler(REPORT));
    expect(done, "the hold write must have been intercepted").not.toBeNull();
    expect(first).toMatchObject({ ok: false, reason: "completion_record_done_in_flight" });
    expect(holdEverWritten()).toBe(false); // the 412'd write never landed, and the re-read deferred
    expect(record().doneIntent).toBeTruthy();

    commit.open();
    const res = await done;
    expect(twin.committed(res)).toBe(true);
    expect(res.conflict).toBeUndefined();
    expect(h.ticket.twinComments.filter((c) => c.startsWith("Conflict: "))).toHaveLength(0);
    expect(h.ticket.status).toBe("done");
  });

  it("(f3) the commit failed and the intent could not be cleared ⇒ report_completion defers while it is fresh, then (TTL) records the hold; the next Done is refused on it", async () => {
    h.failCommitOnce = true;
    h.failClearOnce = true;
    const failed = await twin.done(handler);
    expect(twin.committed(failed)).toBe(false);
    expect(h.ticket.status).toBe("in_progress");
    expect(record().doneIntent).toBeTruthy(); // the clear failed: the intent stays

    const waiting = answer(await output.handler(REPORT));
    expect(waiting).toMatchObject({ ok: false, reason: "completion_record_done_in_flight" });
    expect(holdEverWritten()).toBe(false);

    // Past the TTL the intent is stale: the twin that wrote it is gone.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 11 * 60_000);
    const later = answer(await output.handler(REPORT));
    expect(later).toMatchObject({ status: "complete_pending_follow_ups", next_action: "retry_report_completion" });
    expect(record().followUpsPending).toBe(true);

    const refused = await twin.done(handler);
    expect(twin.committed(refused)).toBe(false);
    expect(twin.refusal(refused)).toMatch(/has followUpsPending:true/);
    expect(h.ticket.status).toBe("in_progress");
  });
});
