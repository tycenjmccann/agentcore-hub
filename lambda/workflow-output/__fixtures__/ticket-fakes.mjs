/**
 * TEAM-5592: in-memory stand-ins for the I/O behind report_completion's replay path,
 * shared by provider-outage.test.mjs and ticket-probe.test.mjs.
 *
 *   s3Module          an object map with S3's conditional writes (IfNoneMatch / IfMatch)
 *   lambdaModule      the jira twin, in its own idiom: every failure is
 *                     `{ error: "Jira API <status>: ..." }`, `down` makes every tool 503,
 *                     and a status change is the ONLY thing that emits a webhook (as Jira);
 *                     `lambdaFail[tool]` fails the INVOKE itself instead (a thrown SDK
 *                     error, or a `{ FunctionError, Payload }` response)
 *   sqsModule         a FIFO queue: 5-minute dedup, one in-flight batch per group
 *   cloudwatchModule  PutMetricData, captured
 *
 * One singleton `fake`, so every vi.mock factory and the test read the same state.
 * Each factory is used as `vi.mock(id, async () => (await import(<this>)).<factory>())`.
 */

/**
 * The 2026-10-08 answer (.operator live capture: 503, "Your Jira Cloud subscription has
 * been deactivated due to inactivity", errorCode SUSPENDED_INACTIVITY) as the jira
 * twin's jiraFetch renders it: a body with no errorMessages/errors falls through to
 * JSON.stringify(body) after the `Jira API <status>: ` prefix.
 */
export const SUSPENDED_BODY = { message: "Your Jira Cloud subscription has been deactivated due to inactivity", errorCode: "SUSPENDED_INACTIVITY" };
export const PROVIDER_503 = `Jira API 503: ${JSON.stringify(SUSPENDED_BODY)}`;

export const fake = {};

export function resetFake() {
  Object.assign(fake, {
    objects: new Map(), etags: new Map(), etagSeq: 0, puts: [],
    tickets: new Map(), nextKey: 5700, calls: [], webhooks: [],
    down: false, downError: PROVIDER_503, failTool: null, lambdaFail: null, putError: null, getError: null, beforeTool: null,
    queue: [], sends: [], dedup: new Map(), sendError: null, receiptSeq: 0,
    metrics: [], events: [], lambdaInvokes: [],
  });
  return fake;
}
resetFake();

const err = (name, status, message) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
/** An AWS SDK error as the SDK throws it: `name` and `$metadata.httpStatusCode`. */
export const awsError = err;
const text = (body) => (typeof body === "string" ? body : Buffer.from(body).toString("utf8"));
// Named, because every fake dispatches on `constructor.name`.
const cmd = (name) => ({ [name]: class { constructor(input) { this.input = input; } } })[name];

export function s3Module() {
  return {
    S3Client: class {
      async send(c) {
        const name = c?.constructor?.name;
        const input = c?.input || {};
        const has = fake.objects.has(input.Key);
        if (name === "PutObjectCommand") {
          fake.puts.push(input);
          const refused = fake.putError?.(input);
          if (refused) throw refused;
          if (input.IfMatch !== undefined && !has) throw err("NoSuchKey", 404, input.Key);
          if ((input.IfNoneMatch === "*" && has) || (input.IfMatch !== undefined && fake.etags.get(input.Key) !== input.IfMatch)) {
            throw err("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");
          }
          fake.objects.set(input.Key, text(input.Body));
          const ETag = `"e${++fake.etagSeq}"`;
          fake.etags.set(input.Key, ETag);
          return { ETag };
        }
        if (name === "GetObjectCommand") {
          // TEAM-5830: `(input) => Error | null`, a read S3 refuses (AccessDenied, throttle).
          const unreadable = fake.getError?.(input);
          if (unreadable) throw unreadable;
          if (!has) throw err("NoSuchKey", 404, `The specified key does not exist: ${input.Key}`);
          const body = fake.objects.get(input.Key);
          return { ETag: fake.etags.get(input.Key), LastModified: new Date(), Body: { transformToString: async () => body } };
        }
        if (name === "HeadObjectCommand") {
          if (!has) throw err("NotFound", 404, input.Key);
          return { ContentLength: fake.objects.get(input.Key).length };
        }
        if (name === "DeleteObjectCommand") {
          if (input.IfMatch !== undefined && has && fake.etags.get(input.Key) !== input.IfMatch) throw err("PreconditionFailed", 412, "precondition");
          fake.objects.delete(input.Key);
          fake.etags.delete(input.Key);
          return {};
        }
        if (name === "ListObjectsV2Command") {
          return { Contents: [...fake.objects.keys()].filter((k) => k.startsWith(input.Prefix || "")).map((Key) => ({ Key })) };
        }
        return {};
      }
    },
    PutObjectCommand: cmd("PutObjectCommand"), GetObjectCommand: cmd("GetObjectCommand"), HeadObjectCommand: cmd("HeadObjectCommand"),
    DeleteObjectCommand: cmd("DeleteObjectCommand"), ListObjectsV2Command: cmd("ListObjectsV2Command"),
  };
}

/** Seed one ticket, in the jira twin's get_issue shape. */
export function seedTicket(t) {
  fake.tickets.set(t.ticketId, { status: "To Do", labels: [], blockedBy: [], comments: [], description: "", ...t });
}

const row = (t) => ({
  ticketId: t.ticketId, title: t.title, status: t.status, assignee: t.assignee,
  parentKey: t.parentKey || null, labels: t.labels, blockedBy: t.blockedBy,
});

/** The jira twin's tool handlers. A return value is the payload; `{error}` is its failure idiom. */
function jiraTool(tool, p) {
  if (fake.down) return { error: fake.downError };
  // A string fails every call of the tool; a function picks the call (`(params) => error | null`).
  const fail = fake.failTool?.[tool];
  const failure = typeof fail === "function" ? fail(p) : fail;
  if (failure) return { error: failure };
  const t = fake.tickets.get(p.ticket_id);
  switch (tool) {
    case "Tickets___get_issue":
      if (!t) return { error: `Jira API 404: Issue ${p.ticket_id} does not exist` };
      return { ...row(t), description: t.description, comments: t.comments.map((body) => ({ author: "agent", body })) };
    case "Tickets___list_tickets":
      return { tickets: [...fake.tickets.values()].filter((x) => x.parentKey === p.parent_id).map(row), complete: true };
    case "Tickets___create_ticket": {
      const ticketId = `TEAM-${fake.nextKey++}`;
      seedTicket({ ticketId, title: p.summary, assignee: p.assignee, parentKey: p.parent_key, blockedBy: p.blocked_by || [], labels: p.labels || [], description: p.description || "" });
      return { ticketId, key: ticketId, message: "Created" };
    }
    case "Tickets___add_comment":
      if (!t) return { error: `Jira API 404: Issue ${p.ticket_id} does not exist` };
      t.comments.push(p.comment);
      return { ticketId: p.ticket_id, message: "Comment added" };
    case "Tickets___update_ticket":
      if (!t) return { error: `Jira API 404: Issue ${p.ticket_id} does not exist` };
      if (p.description) t.description = p.description;
      return { ticketId: p.ticket_id, message: "Updated" };
    case "Tickets___transition_ticket":
      if (!t) return { error: `Jira API 404: Issue ${p.ticket_id} does not exist` };
      // The jira twin's ambiguous answer for a ticket already in the target status.
      if (/^done$/i.test(t.status)) return { error: 'No transition to "Done" found. Available: Reopen' };
      t.status = "Done";
      // Jira fires jira:issue_updated only on a REAL change, which is what makes the
      // orchestrator's cascade a function of transitions rather than of attempts.
      fake.webhooks.push({ ticketId: t.ticketId, status: "Done" });
      return { ticketId: t.ticketId, status: "Done", message: "Transitioned" };
    default:
      return { ok: true };
  }
}

export function lambdaModule() {
  return {
    LambdaClient: class {
      async send(c) {
        const input = c?.input || {};
        let call = {};
        try { call = JSON.parse(text(input.Payload)); } catch { /* not a tool call */ }
        if (typeof call.tool_name !== "string") {
          fake.lambdaInvokes.push(input);
          return {};
        }
        fake.calls.push({ tool: call.tool_name, params: call.parameters || {} });
        // TEAM-5830: awaited before the tool runs, so a test can hold one actor at a barrier
        // (or move S3 under it) while another runs.
        if (fake.beforeTool) await fake.beforeTool(call.tool_name, call.parameters || {});
        const fail = fake.lambdaFail?.[call.tool_name];
        if (fail) {
          if (fail instanceof Error) throw fail;
          return { FunctionError: fail.FunctionError, Payload: new TextEncoder().encode(JSON.stringify(fail.Payload ?? null)) };
        }
        return { Payload: new TextEncoder().encode(JSON.stringify(jiraTool(call.tool_name, call.parameters || {}))) };
      }
    },
    InvokeCommand: cmd("InvokeCommand"),
  };
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export function sqsModule() {
  return {
    SQSClient: class {
      async send(c) {
        const name = c?.constructor?.name;
        const input = c?.input || {};
        if (name === "SendMessageCommand") {
          fake.sends.push(input);
          if (fake.sendError) throw fake.sendError;
          const seen = fake.dedup.get(input.MessageDeduplicationId);
          if (seen && Date.now() - seen.at < DEDUP_WINDOW_MS) return { MessageId: seen.id };
          const id = `m${fake.sends.length}`;
          fake.dedup.set(input.MessageDeduplicationId, { id, at: Date.now() });
          fake.queue.push({ MessageId: id, Body: input.MessageBody, group: input.MessageGroupId, inFlight: null, receives: 0 });
          return { MessageId: id };
        }
        if (name === "ReceiveMessageCommand") {
          // FIFO: a group with a message in flight yields nothing more until it settles.
          const busy = new Set(fake.queue.filter((m) => m.inFlight).map((m) => m.group));
          const out = [];
          for (const m of fake.queue) {
            if (out.length >= (input.MaxNumberOfMessages || 1)) break;
            if (m.inFlight || busy.has(m.group)) continue;
            m.inFlight = `r${++fake.receiptSeq}`;
            m.receives++;
            out.push(m);
          }
          return { Messages: out.map((m) => ({ MessageId: m.MessageId, Body: m.Body, ReceiptHandle: m.inFlight, Attributes: { MessageGroupId: m.group } })) };
        }
        if (name === "DeleteMessageCommand") {
          fake.queue = fake.queue.filter((m) => m.inFlight !== input.ReceiptHandle);
          return {};
        }
        if (name === "ChangeMessageVisibilityCommand") {
          const m = fake.queue.find((x) => x.inFlight === input.ReceiptHandle);
          if (m && input.VisibilityTimeout === 0) m.inFlight = null;
          return {};
        }
        return {};
      }
    },
    SendMessageCommand: cmd("SendMessageCommand"), ReceiveMessageCommand: cmd("ReceiveMessageCommand"), DeleteMessageCommand: cmd("DeleteMessageCommand"), ChangeMessageVisibilityCommand: cmd("ChangeMessageVisibilityCommand"),
  };
}

/** The visibility timeout running out on every in-flight message (between probe ticks). */
export function expireVisibility() {
  for (const m of fake.queue) m.inFlight = null;
}

export function cloudwatchModule() {
  return {
    CloudWatchClient: class {
      async send(c) {
        fake.metrics.push(c?.input || {});
        return {};
      }
    },
    PutMetricDataCommand: cmd("PutMetricDataCommand"),
  };
}
