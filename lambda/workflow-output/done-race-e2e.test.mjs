import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-5926 (TEAM-5799 ship-review F1) — a twin's Done racing the replay drain's
 * brief-hold stamp, end to end through the REAL modules.
 *
 * The twin's Done guard reads completions/<id>.json, then awaits the provider (the
 * reason comment on Jira, the status write on DynamoDB) before the Done commits. The
 * drain CAS-stamps `briefPending:true` on the same record. Before the fix either order
 * ended with a Done ticket under a held record and nobody told. Now:
 *
 *   e1  the drain finishes (stamp, then its re-read sees the ticket still open) before
 *       the Done commits ⇒ the TWIN's post-commit re-read flags `done_over_brief_hold`
 *       with a Conflict comment; the drain's drop stands. The record is converged by
 *       the re-run the warning names (a re-delivered message here).
 *   e2  the Done commits between the stamp and the drain's re-read ⇒ BOTH detect: the
 *       twin flags it, the drain retries, and its next pass converges the record.
 *
 * Real: either twin's `handler` (the Done) and workflow-output's `drainCompletion`.
 * Mocked: S3 (one store with ETag/IfMatch semantics, shared by both), the twins' own
 * storage (fetch for Jira, lib-dynamodb for the tickets table), and the drain's
 * Tickets___* invoke, answered from the same ticket state the twin writes. The drain
 * never transitions on these paths, so its provider needs no transition.
 */

const h = vi.hoisted(() => ({
  objects: new Map(), // key -> { body, etag }
  etagSeq: 0,
  ticket: { status: "in_progress", twinComments: [], drainComments: new Map() },
  /** Awaited at the twin's last step before its commit. */
  beforeCommit: null,
  /** Awaited before the drain's get_issue of the build ticket is answered. */
  beforeDrainRead: null,
}));

const notFound = (k) => Object.assign(new Error(`NoSuchKey ${k}`), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });

vi.mock("@aws-sdk/client-s3", () => {
  const named = (n) => ({ [n]: class { constructor(input) { this.input = input; } } })[n];
  return {
    S3Client: class {
      async send(c) {
        const name = c.constructor.name;
        const { Key, IfMatch, IfNoneMatch, Body } = c.input;
        const cur = h.objects.get(Key);
        if (name === "GetObjectCommand") {
          if (!cur) throw notFound(Key);
          return { ETag: cur.etag, Body: { transformToString: async () => cur.body } };
        }
        if (name === "PutObjectCommand") {
          if ((IfMatch !== undefined && (!cur || cur.etag !== IfMatch)) || (IfNoneMatch === "*" && cur)) {
            throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          const etag = `"e${++h.etagSeq}"`;
          h.objects.set(Key, { body: String(Body), etag });
          return { ETag: etag };
        }
        if (name === "HeadObjectCommand") {
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
        if (p.ticket_id === T) await h.beforeDrainRead?.();
        out = p.ticket_id === T
          ? { key: T, fields: { summary: "Operator: verify", status: { name: jiraName(h.ticket.status) }, parent: { key: EPIC }, assignee: { displayName: "agentcore_hub_operator" } }, comments: comments(T).map((body) => ({ body })) }
          : { key: p.ticket_id, fields: { summary: "Epic", status: { name: "In Progress" } }, comments: comments(p.ticket_id).map((body) => ({ body })) };
      } else if (tool === "Tickets___list_tickets") {
        out = { tickets: [], complete: true }; // no open Merge Approval gate ⇒ the brief goes off_gate ⇒ a hold
      } else if (tool === "Tickets___add_comment") {
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
  let reasonCommentSeen = false;
  return async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || "GET").toUpperCase();
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (u.includes(`/issue/${T}/comment`) && m === "POST") {
      // The reason comment is the await between the guard read and the Done POST.
      if (!reasonCommentSeen) { reasonCommentSeen = true; await h.beforeCommit?.(); }
      const body = JSON.parse(init.body).body;
      h.ticket.twinComments.push(body.content.map((p) => p.content.map((t) => t.text).join("")).join("\n"));
      return json({ id: "c1" }, 201);
    }
    if (u.includes(`/issue/${T}/transitions`) && m === "GET") return json({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
    if (u.includes(`/issue/${T}/transitions`) && m === "POST") { h.ticket.status = "done"; return new Response(null, { status: 204 }); }
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
  },
  tickets: {
    env: { TICKET_PROVIDER: "dynamodb" },
    load: async () => (await import("../agentcore-hub-tickets/index.mjs")).handler,
    done: (handler) => handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: T, transition_id: "done" } }),
  },
};

const MSG = { ticketId: T, workflowId: "wf_1", reportKey: KEY, epicKey: EPIC, agentId: "agentcore_hub_operator", brief: { s3Key: BRIEF } };
const record = () => JSON.parse(h.objects.get(KEY).body);
const released = (id) => (h.ticket.drainComments.get(id) || []).filter((c) => c.startsWith(`[brief-hold-released:${T}]`));
const put = (k, body) => h.objects.set(k, { body, etag: `"e${++h.etagSeq}"` });
/** A barrier: `wait()` parks the caller until `open()`. */
const barrier = () => {
  let open;
  let reached;
  const opened = new Promise((r) => (open = r));
  const arrived = new Promise((r) => (reached = r));
  return { wait: async () => { reached(); await opened; }, open, arrived };
};

describe.each(Object.keys(TWINS))("TEAM-5926 e2e — the %s twin's Done races the drain's brief-hold stamp", (name) => {
  const twin = TWINS[name];
  let handler;
  let drainCompletion;

  beforeEach(async () => {
    h.objects.clear();
    h.etagSeq = 0;
    h.ticket = { status: "in_progress", twinComments: [], drainComments: new Map() };
    h.beforeCommit = null;
    h.beforeDrainRead = null;
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
  });

  it("(e1) the drain finishes before the Done commits ⇒ the twin flags the conflict; a re-run converges the record", async () => {
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived; // the guard read the unheld record; the Done is not committed yet

    const drained = await drainCompletion(MSG);
    expect(drained).toMatchObject({ outcome: "dropped", permanent: true });
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });

    commit.open();
    const res = await done;
    expect(h.ticket.status).toBe("done");
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ conflict: "done_over_brief_hold", warning: expect.stringMatching(/re-run WorkflowOutput___report_completion/) });
    expect(h.ticket.twinComments.filter((c) => c.startsWith("Conflict: "))).toHaveLength(1);

    // What the warning tells a human to do: the replay runs again and converges.
    const again = await drainCompletion(MSG);
    expect(again).toMatchObject({ outcome: "applied" });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "off_gate", ticketWrites: "applied" });
    expect(released(T)).toHaveLength(1);
  });

  it("(e2) the Done commits between the stamp and the drain's re-read ⇒ both detect; the drain's next pass converges", async () => {
    const commit = barrier();
    h.beforeCommit = commit.wait;
    const done = twin.done(handler);
    await commit.arrived;

    // The drain's post-stamp re-read is the first get_issue of the build ticket after
    // the hold is on the record: let the twin's Done commit (and finish) right then.
    let twinRes = null;
    h.beforeDrainRead = async () => {
      if (twinRes || JSON.parse(h.objects.get(KEY).body).briefPending !== true) return;
      commit.open();
      twinRes = await done;
    };
    const drained = await drainCompletion(MSG);
    expect(twinRes).not.toBeNull();
    expect(h.ticket.status).toBe("done");
    expect(twinRes).toMatchObject({ conflict: "done_over_brief_hold" });
    expect(drained).toMatchObject({ outcome: "retry", reason: expect.stringMatching(/reached Done concurrently/) });
    expect(record()).toMatchObject({ briefPending: true });

    h.beforeDrainRead = null;
    const next = await drainCompletion(MSG);
    expect(next).toMatchObject({ outcome: "applied" });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "off_gate", ticketWrites: "applied" });
    for (const id of [T, EPIC]) expect(released(id)).toHaveLength(1);
  });
});
