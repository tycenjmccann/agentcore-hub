/**
 * POST /api/workflow/[id]/cancel — cancel a run and close it out:
 * 1. Phase CAS to "cancelled" + the `cancelCloseoutPending` / `cancelEventPending`
 *    markers. A cancelled row with `cancelCloseoutPending` is RESUMED (stored
 *    cancelledAt / cancelReason stand); every other terminal row is 409.
 * 2. Close-out lease (`cancelCloseoutLeaseUntil`, 5 min); a held lease is 409.
 * 3. Follow-ups blocked only by the CD ticket move under `Post-run follow-ups <id>`.
 * 4. Sweep the other open children, skipping ones with a completion record or a
 *    live agent session (`ticketsLeftRunning`). Done is never touched.
 * 5. Close the run epic when clean. 6. Publish workflow.cancelled.
 * 7. Clear the markers only when all of that finished; else keep them with
 *    `cancelCloseoutError` so a re-POST resumes.
 * Every answer after the CAS is 200 (the board reads !ok as "not cancelled").
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SHIP_BLOCKED_OUTCOMES } from "@/lib/workflow/types";
import { JQL_SEARCH_CAP, searchJqlAll } from "@/lib/workflow/jira-search-paginate";
import { blockersFromLinks, mapJiraStatusToInternal, type JiraIssueLink } from "@/lib/workflow/jira-client";
import agentsConfig from "@/config/agents.json";
import leaseConstants from "@/config/lease-constants.json";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const JIRA = (process.env.TICKET_PROVIDER || "dynamodb") === "jira";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const EVENT_BUS = process.env.EVENT_BUS || "default";

// TEAM-3755 — the ship-blocked outcomes are ALSO terminal: cancelling a run
// that already closed deploy-blocked / static-ci-only would overwrite its
// honest verdict with "cancelled". PARITY with TERMINAL_PHASES in
// complete/route.ts and completion.mjs; the F6 UI fix (WorkflowBoard hiding
// Cancel) only removes the button — this route is the actual enforcement.
const TERMINAL_PHASES = ["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES] as const;

/** How long one attempt owns a cancelled run's close-out; a crashed attempt's lease just expires. */
const CANCEL_CLOSEOUT_LEASE_MS = 5 * 60_000;
/** An agent session that is still working (lease-constants + the board's active set). */
const LIVE_TASK_STATUSES = new Set<string>([...leaseConstants.liveClaimStatuses, "pending", "waiting_response"]);
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

/**
 * TEAM-3755 — the "not already terminal" ConditionExpression from the ONE list
 * above, mirroring terminalPhaseGuard() in complete/route.ts. Positional
 * placeholders (:tp0…) never collide with the write's own values.
 */
function terminalPhaseGuard(): { condition: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const condition = TERMINAL_PHASES.map((phase, i) => {
    values[`:tp${i}`] = phase;
    return `#phase <> :tp${i}`;
  }).join(" AND ");
  return { condition, values };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });
const eventBridge = new EventBridgeClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

export const dynamic = "force-dynamic";

/** One conditional UpdateCommand. */
const update = (TableName: string, Key: Record<string, unknown>, UpdateExpression: string, ConditionExpression: string,
  ExpressionAttributeValues: Record<string, unknown>, ExpressionAttributeNames?: Record<string, string>) =>
  ddb.send(new UpdateCommand({ TableName, Key, UpdateExpression, ConditionExpression, ExpressionAttributeValues,
    ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}) }));
const isCCF = (err: unknown) => (err as { name?: string })?.name === "ConditionalCheckFailedException";
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One child ticket, provider-neutral. `jira` carries what a Jira move needs. */
type RunTicket = {
  ticketId: string; status: string; assignee?: string; labels: string[]; title: string; description: string;
  blockedBy: string[]; parentId?: string; createdAt?: string;
  jira?: { statusName: string; links: JiraIssueLink[]; descriptionAdf: unknown };
};

type JiraAuth = { baseUrl: string; authHeader: string };
type Ctx = { workflowId: string; workflow: Record<string, unknown>; reason?: string; jira: JiraAuth | null };

// ─── Jira ───────────────────────────────────────────────────────────────────

function getJiraAuth(): JiraAuth | null {
  const { JIRA_SITE_URL: site, JIRA_EMAIL: email, JIRA_API_TOKEN: token } = process.env;
  if (!site || !email || !token) return null;
  return { baseUrl: `https://${site}`, authHeader: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
}

function needJira(ctx: Ctx): JiraAuth {
  if (!ctx.jira) throw new Error("Jira credentials not configured");
  return ctx.jira;
}

function jiraFetch(auth: JiraAuth, path: string, method = "GET", body?: unknown) {
  return fetch(`${auth.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: auth.authHeader,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function jiraFail(resp: Response, what: string): Promise<never> {
  const body = await resp.text().catch(() => "");
  throw new Error(`${what}: HTTP ${resp.status} ${body.slice(0, 200)}`);
}

type JiraTransition = { id: string; name?: string; to?: { name?: string; statusCategory?: { key?: string } } };
const toName = (t: JiraTransition) => String(t.to?.name || "").trim().toLowerCase();

async function jiraTransitions(auth: JiraAuth, key: string): Promise<JiraTransition[]> {
  const resp = await jiraFetch(auth, `/rest/api/3/issue/${key}/transitions`);
  if (!resp.ok) await jiraFail(resp, `Transitions read failed for ${key}`);
  return ((await resp.json()) as { transitions?: JiraTransition[] }).transitions || [];
}

const CANCEL_DESTINATIONS = new Set(["won't do", "wont do", "cancelled", "canceled"]);

/**
 * Transition one Jira issue to cancelled. A transition whose DESTINATION is
 * Won't Do / Cancelled wins (one merely NAMED "Cancel" can end anywhere); else
 * any Done-category transition, with resolution Won't Do. Tried with the
 * resolution field, then bare (it may not be on the screen). Throws
 * "No cancel transition" when neither exists.
 */
async function cancelOneIssueJira(auth: JiraAuth, key: string) {
  const all = await jiraTransitions(auth, key);
  const trans = all.find((t) => CANCEL_DESTINATIONS.has(toName(t))) || all.find((t) => t.to?.statusCategory?.key === "done");
  if (!trans) throw new Error(`No cancel transition for ${key}`);
  const path = `/rest/api/3/issue/${key}/transitions`;
  let resp = await jiraFetch(auth, path, "POST", { transition: { id: trans.id }, fields: { resolution: { name: "Won't Do" } } });
  if (!resp.ok) resp = await jiraFetch(auth, path, "POST", { transition: { id: trans.id } });
  if (!resp.ok) await jiraFail(resp, `Transition failed for ${key}`);
}

/** Flatten ADF to plain text (enough to find the follow-up banner and the MOVED marker). */
function adfToText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text || "";
  const inner = (Array.isArray(n.content) ? n.content : []).map(adfToText).join("");
  return ["paragraph", "heading", "codeBlock", "blockquote", "listItem"].includes(String(n.type)) ? `${inner}\n` : inner;
}

/** `text` as ADF paragraphs prepended to the issue's existing ADF description. */
function prependAdf(text: string, existing: unknown): Record<string, unknown> {
  const para = (t: string) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
  const head = text.split("\n").filter((l) => l.trim()).map(para);
  const rest = Array.isArray((existing as { content?: unknown })?.content)
    ? (existing as { content: unknown[] }).content
    : typeof existing === "string" && existing.trim() ? [para(existing)] : [];
  return { type: "doc", version: 1, content: [...head, ...rest] };
}

type JiraIssue = {
  key: string;
  fields?: {
    status?: { name?: string }; labels?: string[]; summary?: string; description?: unknown;
    issuelinks?: JiraIssueLink[]; created?: string; parent?: { key?: string };
  };
};

/**
 * EVERY non-done child of `epicKey`, collected before any transition: each
 * transition drops an issue out of `status != Done`, so paging mid-sweep skips.
 */
async function listTicketsJira(auth: JiraAuth, epicKey: string): Promise<{ tickets: RunTicket[]; truncated: boolean }> {
  const { issues, truncated } = await searchJqlAll<JiraIssue>({
    fetchPage: async (params) => {
      const resp = await jiraFetch(auth, `/rest/api/3/search/jql?${params.toString()}`);
      if (!resp.ok) await jiraFail(resp, "search");
      return resp.json();
    },
    jql: `parent = ${epicKey} AND status != Done`,
    fields: "summary,status,labels,issuelinks,created,description,parent",
  });
  const tickets = issues.map((issue): RunTicket => {
    const f = issue.fields || {};
    const labels = Array.isArray(f.labels) ? f.labels : [];
    const statusName = f.status?.name || "To Do";
    return {
      ticketId: issue.key,
      status: mapJiraStatusToInternal(statusName),
      assignee: labels.find((l) => l.startsWith("agent:"))?.slice("agent:".length),
      labels,
      title: f.summary || "",
      description: adfToText(f.description),
      blockedBy: [...new Set(blockersFromLinks(f.issuelinks))],
      parentId: f.parent?.key || epicKey,
      createdAt: f.created,
      jira: { statusName, links: f.issuelinks || [], descriptionAdf: f.description },
    };
  });
  return { tickets, truncated };
}

// ─── DynamoDB / S3 ──────────────────────────────────────────────────────────

async function listTicketsDynamoDB(epicId: string): Promise<RunTicket[]> {
  const out: RunTicket[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TICKETS_TABLE,
        IndexName: "parentId-index",
        KeyConditionExpression: "parentId = :pid",
        ExpressionAttributeValues: { ":pid": epicId },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      })
    );
    for (const i of page.Items || []) {
      const blocked = Array.isArray(i.blockedBy) ? i.blockedBy.map(String) : str(i.blockedBy)?.split(",") || [];
      out.push({
        ticketId: String(i.ticketId),
        status: String(i.status || ""),
        assignee: str(i.assignee),
        labels: Array.isArray(i.labels) ? i.labels.map(String) : [],
        title: str(i.title) || "",
        description: str(i.description) || "",
        blockedBy: [...new Set(blocked.map((s: string) => s.trim()).filter(Boolean))],
        parentId: str(i.parentId) || epicId,
        createdAt: str(i.createdAt),
      });
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

const listChildren = async (ctx: Ctx, epicKey: string) =>
  JIRA ? (await listTicketsJira(needJira(ctx), epicKey)).tickets : listTicketsDynamoDB(epicKey);

/**
 * Cancel one ticket in the active provider. DynamoDB: iff still in the status
 * the sweep read (`from`), or — for an epic — iff still open; a CCF means it
 * moved under us. Jira: by transition (cancelOneIssueJira).
 */
async function cancelTicket(ctx: Ctx, ticketId: string, cond: { from: string } | "open") {
  if (JIRA) return cancelOneIssueJira(needJira(ctx), ticketId);
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :cancelled, cancelledAt = :ts, #u = :ts",
      ConditionExpression: cond === "open" ? "#s <> :done AND #s <> :cancelled" : "#s = :from",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":ts": now,
        ...(cond === "open" ? { ":done": "done" } : { ":from": cond.from }),
      },
    })
  );
}

/** Parsed JSON at `key`; null when absent (or no bucket); {} when unreadable. Throws on any other failure. */
async function readArtifactJson(key: string): Promise<unknown> {
  if (!ARTIFACT_BUCKET) return null;
  let body: string | undefined;
  try {
    body = await (await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }))).Body?.transformToString();
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {}; // exists, unreadable: still a record
  }
}

// ─── Follow-ups waiting only on the CD ticket ───────────────────────────────
//
// report_completion (lambda/workflow-output/index.mjs) materializes an agent's
// follow_ups[] as tickets parented on the run epic and blocked_by the run's CD
// ticket, with the description `followUpBanner(origin)` + the finding text. A
// cancelled run never deploys, so that blocker never clears: the follow-ups would
// sit blocked under a cancelled epic forever. The cancel moves them instead.

const FOLLOWUP_ORIGIN_RE = /AGENT-AUTHORED FOLLOW-UP \(materialized by report_completion from ([^;\s)]+);/;
const FOLLOWUP_TITLE_RE = /\s*\[fu:([0-9a-f]{8})\]\s*$/;
const FOLLOWUP_LABEL_RE = /^followup-([0-9a-f]{8})$/;
/** The banner a move prepends; also how a resume knows this run already moved the ticket. */
const MOVED_BANNER = (workflowId: string) => `MOVED on cancel of ${workflowId}:`;

const AGENT_PHASE_BY_ID: Record<string, string> = Object.fromEntries(
  (agentsConfig.agents as Array<{ agentId: string; phase?: string }>).map((a) => [a.agentId, a.phase || ""])
);

/**
 * Port of workflow-output's findCdTicket — the newest (by createdAt) child whose
 * agent's roster phase is "ship" (human assignees are never in the roster) —
 * and every open child whose blockers are EXACTLY [that CD ticket].
 */
function cdBlockedFollowUps(tickets: RunTicket[]): { cdId: string | null; followUps: RunTicket[] } {
  let cd: RunTicket | null = null;
  for (const t of tickets) {
    if (AGENT_PHASE_BY_ID[t.assignee || ""] !== "ship") continue;
    if (!cd || !cd.createdAt || !t.createdAt || t.createdAt >= cd.createdAt) cd = t;
  }
  if (!cd) return { cdId: null, followUps: [] };
  const cdId = cd.ticketId;
  const followUps = tickets.filter(
    (t) => t.ticketId !== cdId && !CLOSED_STATUSES.has(t.status) && t.blockedBy.length === 1 && t.blockedBy[0] === cdId
  );
  return { cdId, followUps };
}

/** The MOVED banner block: banner + security note + origin finding text (completions/<origin>.json) + originating ticket. */
async function movedBannerText(workflowId: string, t: RunTicket, cdId: string | null): Promise<string> {
  const origin = FOLLOWUP_ORIGIN_RE.exec(t.description)?.[1] ?? null;
  let finding: string | null = null;
  if (origin) {
    try {
      const rec = (await readArtifactJson(`completions/${origin}.json`)) as {
        followUps?: Array<{ hash?: string; title?: string; detail?: unknown }>;
      } | null;
      const entries = Array.isArray(rec?.followUps) ? rec!.followUps : [];
      const hash = FOLLOWUP_TITLE_RE.exec(t.title)?.[1] || t.labels.map((l) => FOLLOWUP_LABEL_RE.exec(l)?.[1]).find(Boolean);
      const bare = t.title.replace(FOLLOWUP_TITLE_RE, "").trim();
      const entry =
        (hash ? entries.find((e) => e?.hash === hash) : undefined) ||
        entries.find((e) => typeof e?.title === "string" && e.title.trim() === bare) ||
        (entries.length === 1 ? entries[0] : undefined);
      finding = typeof entry?.detail === "string" && entry.detail.trim() ? entry.detail.trim() : null;
    } catch (err) {
      console.warn(`[cancel] completions/${origin}.json read failed: ${errMsg(err)}`);
    }
  }
  const security = /^\s*security\b/i.test(t.title) || t.labels.some((l) => /security/i.test(l));
  return [
    `${MOVED_BANNER(workflowId)} this ticket was waiting only on CD ticket ${cdId || "unknown"}, which will never run because the run was cancelled.`,
    security ? "SECURITY follow-up: the finding is still open after the cancel and needs an engineer." : "",
    finding ? `Original finding: ${finding}` : "",
    `Originating ticket: ${origin || "unknown"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Invoke one Tickets___* tool on the active ticket Lambda (the jira twin only dispatches prefixed names). */
async function invokeTicketTool(toolName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets",
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ tool_name: toolName, parameters })),
    })
  );
  const raw = response.Payload ? Buffer.from(response.Payload).toString() : "";
  if (response.FunctionError) throw new Error(`${toolName} failed: ${raw.slice(0, 300) || response.FunctionError}`);
  let p: unknown = null;
  try {
    p = JSON.parse(raw);
    if (typeof p === "string") p = JSON.parse(p);
  } catch {
    /* falls through to unreadable */
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${toolName}: unreadable payload`);
  const out = p as Record<string, unknown>;
  if (typeof out.error === "string" && out.error.trim()) throw new Error(`${toolName}: ${out.error.trim()}`);
  return out;
}

/**
 * The run's post-run epic, created at most once. A stored `postRunEpicKey` is
 * reused; otherwise create it through the ticket Lambda, then claim the row with
 * attribute_not_exists. A writer that lost the claim reads the winner and
 * cancels its own epic (the Jira twin dedupes by summary, so they may match).
 */
async function ensurePostRunEpic(ctx: Ctx): Promise<string> {
  const existing = str(ctx.workflow.postRunEpicKey);
  if (existing) return existing;
  const created = await invokeTicketTool("Tickets___create_ticket", {
    summary: `Post-run follow-ups ${ctx.workflowId}`,
    issue_type: "epic",
    workflow_id: ctx.workflowId,
    description:
      `Follow-ups moved out of cancelled run ${ctx.workflowId}` +
      (ctx.reason ? ` (cancel reason: ${ctx.reason})` : "") +
      `. They were waiting on the run's CD ticket, which will never run.`,
  });
  // tickets twin returns `key`, jira twin `ticketId`; refusals have neither.
  const mine = str(created.key) || str(created.ticketId);
  if (!mine) throw new Error("post-run epic not created: no key in the create_ticket result");
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId: ctx.workflowId },
        UpdateExpression: "SET postRunEpicKey = :k",
        ConditionExpression: "attribute_not_exists(postRunEpicKey)",
        ExpressionAttributeValues: { ":k": mine },
      })
    );
    return mine;
  } catch (err) {
    if (!isCCF(err)) throw err;
  }
  const row = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId: ctx.workflowId }, ConsistentRead: true }));
  const winner = str(row.Item?.postRunEpicKey);
  if (!winner) throw new Error("postRunEpicKey claim lost but the row carries none");
  if (winner !== mine) {
    await cancelTicket(ctx, mine, "open").catch((err) =>
      console.warn(`[cancel] ${ctx.workflowId}: duplicate post-run epic ${mine} not cancelled: ${errMsg(err)}`)
    );
  }
  return winner;
}

/**
 * Move one follow-up under `epicKey`. DynamoDB: ONE conditional write
 * (`#s = :from`) re-parents, detaches, unblocks and banners, so it is fully
 * moved or untouched. Jira: idempotent steps — PUT parent + banner, DELETE the
 * Blocks link from the CD, transition to To Do — throwing on the first failure.
 */
async function moveFollowUp(ctx: Ctx, t: RunTicket, epicKey: string, cdId: string | null) {
  const hasBanner = t.description.includes(MOVED_BANNER(ctx.workflowId));
  const banner = hasBanner ? "" : await movedBannerText(ctx.workflowId, t, cdId);
  if (!JIRA) {
    const unblock = t.status === "blocked";
    await ddb.send(
      new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId: t.ticketId },
        UpdateExpression: "SET parentId = :epic, blockedBy = :none, description = :desc, #u = :u" + (unblock ? ", #s = :todo" : ""),
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: {
          ":epic": epicKey,
          ":none": [],
          ":desc": [banner, t.description].filter(Boolean).join("\n\n"),
          ":u": new Date().toISOString(),
          ":from": t.status,
          ...(unblock ? { ":todo": "todo" } : {}),
        },
      })
    );
    return;
  }
  const auth = needJira(ctx);
  if (t.parentId !== epicKey || !hasBanner) {
    const fields = { parent: { key: epicKey }, ...(banner ? { description: prependAdf(banner, t.jira?.descriptionAdf) } : {}) };
    const resp = await jiraFetch(auth, `/rest/api/3/issue/${t.ticketId}`, "PUT", { fields });
    if (!resp.ok) await jiraFail(resp, `re-parent of ${t.ticketId} failed`);
  }
  for (const link of t.jira?.links || []) {
    if (link.type?.name !== "Blocks" || !cdId || link.inwardIssue?.key !== cdId) continue;
    const resp = await jiraFetch(auth, `/rest/api/3/issueLink/${link.id}`, "DELETE");
    if (!resp.ok && resp.status !== 404) await jiraFail(resp, `detach of ${t.ticketId} from ${cdId} failed`);
  }
  if (String(t.jira?.statusName || "").trim().toLowerCase() !== "to do") {
    const toDo = (await jiraTransitions(auth, t.ticketId)).find((tr) => toName(tr) === "to do");
    if (!toDo) throw new Error(`unblock of ${t.ticketId} failed: no transition to To Do`);
    const resp = await jiraFetch(auth, `/rest/api/3/issue/${t.ticketId}/transitions`, "POST", { transition: { id: toDo.id } });
    if (!resp.ok) await jiraFail(resp, `unblock of ${t.ticketId} failed`);
  }
}

type FollowUpResult = { followUpsMoved: number; followUpsError?: string; postRunEpicKey?: string };

/**
 * Move every CD-blocked follow-up under the post-run epic. One counts only once
 * re-parented, detached AND unblocked. Idempotent for a resume: the post-run
 * epic's children already carrying this run's banner count without a rewrite,
 * and a half-moved one gets only its missing steps.
 */
async function moveFollowUpsOnCancel(ctx: Ctx, cdId: string | null, followUps: RunTicket[]): Promise<FollowUpResult> {
  const stored = str(ctx.workflow.postRunEpicKey);
  if (followUps.length === 0 && !stored) return { followUpsMoved: 0 };
  let epicKey: string;
  try {
    epicKey = await ensurePostRunEpic(ctx);
  } catch (err) {
    return { followUpsMoved: 0, followUpsError: `post-run epic: ${errMsg(err)}` };
  }
  const banner = MOVED_BANNER(ctx.workflowId);
  const candidates = new Map(followUps.map((t) => [t.ticketId, t]));
  const errors: string[] = [];
  if (stored) {
    try {
      for (const c of await listChildren(ctx, epicKey)) {
        // Re-blocked on something other than the CD: a human did that on purpose.
        if (CLOSED_STATUSES.has(c.status) || candidates.has(c.ticketId) || !c.description.includes(banner) || c.blockedBy.some((b) => b !== cdId)) continue;
        candidates.set(c.ticketId, c);
      }
    } catch (err) {
      errors.push(`post-run epic ${epicKey}: children not listed: ${errMsg(err)}`);
    }
  }
  let followUpsMoved = 0;
  for (const t of candidates.values()) {
    const done = t.description.includes(banner) && t.parentId === epicKey && !(cdId && t.blockedBy.includes(cdId)) && t.status !== "blocked";
    try {
      if (!done) await moveFollowUp(ctx, t, epicKey, cdId);
      followUpsMoved++;
    } catch (err) {
      errors.push(`${t.ticketId}: ${isCCF(err) ? "status changed during the move" : errMsg(err)}`);
    }
  }
  return { followUpsMoved, postRunEpicKey: epicKey, ...(errors.length ? { followUpsError: errors.join("; ") } : {}) };
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

type Sweep = {
  cancelled: number; skipped: number; failed: number; raced: number; ticketsLeftRunning: string[];
  /** Open children kept as they are because completions/<id>.json exists. */
  keptByRecord: string[];
  /** TEAM-5171: some children could not be found or reached — the run is cancelled, its tickets not all closed. */
  incomplete?: boolean;
  error?: string;
};

/**
 * Cancel every open child left after the follow-up move. Skipped: done/cancelled,
 * a child with a completion record (its status is the agent's), and an
 * in_progress child whose agent session is live (ticketsLeftRunning — a re-POST
 * finishes it once the claim is released). A record read error leaves the child
 * and counts as failed; a CCF (moved under us) is skipped + raced.
 */
async function sweepTickets(ctx: Ctx, tickets: RunTicket[], sweep: Sweep) {
  const tasks = (ctx.workflow.agentTasks || {}) as Record<string, { status?: string } | undefined>;
  const open = tickets.filter((t) => {
    if (CLOSED_STATUSES.has(t.status)) sweep.skipped++;
    else if (t.status === "in_progress" && LIVE_TASK_STATUSES.has(String(tasks[t.ticketId]?.status || ""))) sweep.ticketsLeftRunning.push(t.ticketId);
    else return true;
    return false;
  });
  const batchSize = JIRA ? 5 : 10; // Jira rate limits
  for (let i = 0; i < open.length; i += batchSize) {
    const batch = open.slice(i, i + batchSize);
    const records = await Promise.allSettled(batch.map((t) => readArtifactJson(`completions/${t.ticketId}.json`)));
    const toCancel = batch.filter((t, j) => {
      const r = records[j];
      if (r.status === "rejected") {
        sweep.failed++;
        console.warn(`[cancel] completions/${t.ticketId}.json read failed: ${errMsg(r.reason)}`);
      } else if (r.value !== null) {
        sweep.skipped++;
        sweep.keptByRecord.push(t.ticketId);
      } else return true;
      return false;
    });
    for (const r of await Promise.allSettled(toCancel.map((t) => cancelTicket(ctx, t.ticketId, { from: t.status })))) {
      if (r.status === "fulfilled") sweep.cancelled++;
      else if (isCCF(r.reason)) {
        sweep.skipped++;
        sweep.raced++;
      } else {
        sweep.failed++;
        console.warn(`[cancel] Failed to cancel ticket: ${errMsg(r.reason)}`);
      }
    }
  }
}

// ─── Lease + event ──────────────────────────────────────────────────────────

/** Take the close-out lease: free when absent or expired. False when another attempt holds it. */
async function claimCloseoutLease(workflowId: string, lease: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: "SET cancelCloseoutLeaseUntil = :lease",
        ConditionExpression: "attribute_not_exists(cancelCloseoutLeaseUntil) OR cancelCloseoutLeaseUntil < :now",
        ExpressionAttributeValues: { ":lease": lease, ":now": new Date().toISOString() },
      })
    );
    return true;
  } catch (err) {
    if (isCCF(err)) return false;
    throw err;
  }
}

/**
 * End this attempt's lease. Complete → the close-out marker goes and
 * cancelCloseoutCompletedAt is stamped; otherwise the marker stays with
 * cancelCloseoutError. `event` is this attempt's workflow.cancelled: its detail
 * is stored, and the event marker clears only when delivered.
 */
async function releaseCloseoutLease(
  workflowId: string,
  lease: string,
  error: string | undefined,
  event?: { delivered: boolean; detail: Record<string, unknown> }
) {
  const remove = ["cancelCloseoutLeaseUntil"];
  const set: string[] = [];
  const values: Record<string, unknown> = { ":lease": lease, ":now": new Date().toISOString() };
  if (error) {
    set.push("cancelCloseoutError = :err");
    values[":err"] = error.slice(0, 1000);
  } else {
    remove.push("cancelCloseoutPending", "cancelCloseoutError");
    set.push("cancelCloseoutCompletedAt = :now");
  }
  if (event) {
    set.push("cancelEventDetail = :detail");
    values[":detail"] = event.detail;
    if (event.delivered) {
      remove.push("cancelEventPending");
      set.push("cancelEventDeliveredAt = :now");
    }
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression: `SET ${set.join(", ")} REMOVE ${remove.join(", ")}`,
        ConditionExpression: "cancelCloseoutLeaseUntil = :lease",
        ExpressionAttributeValues: values,
      })
    );
  } catch (err) {
    // Lost lease (expired and taken) or a failed write: the marker stays pending — the resumable direction.
    console.warn(`[cancel] ${workflowId}: close-out lease not released: ${errMsg(err)}`);
  }
}

/**
 * workflow.cancelled to EventBridge and the events table (stable eventId, so a
 * resend is one row). Delivered only when PutEvents reports FailedEntryCount 0;
 * the table row is best-effort.
 */
async function publishCancelled(workflowId: string, cancelledAt: string, detail: Record<string, unknown>): Promise<boolean> {
  let delivered = false;
  try {
    const resp = await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "agentcore-hub.orchestrator",
            DetailType: "workflow.cancelled",
            Detail: JSON.stringify({ ...detail, timestamp: cancelledAt }),
            EventBusName: EVENT_BUS,
          },
        ],
      })
    );
    delivered = resp?.FailedEntryCount === 0;
    if (!delivered) console.warn(`[cancel] EventBridge rejected workflow.cancelled for ${workflowId}`);
  } catch (err) {
    console.warn(`[cancel] EventBridge publish failed: ${errMsg(err)}`);
  }
  await ddb
    .send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: { workflowId, eventId: `${Date.parse(cancelledAt) || 0}-cancelled`, timestamp: cancelledAt, type: "workflow.cancelled", detail },
      })
    )
    .catch(() => undefined);
  return delivered;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  // Optional audit reason; the body itself is optional.
  let reason: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.reason === "string" && body.reason.trim()) reason = body.reason.trim().slice(0, 500);
  } catch {
    /* no body */
  }

  let workflow: Record<string, unknown>;
  let cancelledAt: string;
  let resume: boolean;
  try {
    const wf = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId }, ConsistentRead: true }));
    if (!wf.Item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    workflow = wf.Item as Record<string, unknown>;
    const terminal = () => NextResponse.json({ error: "Workflow already in terminal state", phase: workflow.phase }, { status: 409 });

    // A cancelled run whose close-out is still pending is resumed (the original cancel stands).
    resume = workflow.phase === "cancelled" && workflow.cancelCloseoutPending === true;
    if (resume) {
      cancelledAt = String(workflow.cancelledAt || new Date().toISOString());
      reason = str(workflow.cancelReason) || undefined;
    } else {
      if (TERMINAL_PHASES.includes(workflow.phase as (typeof TERMINAL_PHASES)[number])) return terminal();
      // Phase + the close-out and event markers in one write, so a committed cancel is always resumable.
      cancelledAt = new Date().toISOString();
      const guard = terminalPhaseGuard();
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: WORKFLOWS_TABLE,
            Key: { workflowId },
            UpdateExpression:
              "SET #phase = :cancelled, cancelledAt = :ts, previousPhase = :prev, cancelCloseoutPending = :pending, cancelEventPending = :pending" +
              (reason ? ", cancelReason = :reason" : ""),
            ConditionExpression: guard.condition,
            ExpressionAttributeNames: { "#phase": "phase" },
            ExpressionAttributeValues: {
              ":cancelled": "cancelled",
              ":ts": cancelledAt,
              ":prev": workflow.phase,
              ":pending": true,
              ...guard.values,
              ...(reason ? { ":reason": reason } : {}),
            },
          })
        );
      } catch (err) {
        if (isCCF(err)) return terminal();
        throw err;
      }
    }
  } catch (err) {
    console.error("[cancel] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const ctx: Ctx = { workflowId, workflow, reason, jira: JIRA ? getJiraAuth() : null };
  const epicId = String(workflow.epicId || "");
  const sweep: Sweep = { cancelled: 0, skipped: 0, failed: 0, raced: 0, ticketsLeftRunning: [], keptByRecord: [] };
  let followUps: FollowUpResult = { followUpsMoved: 0 };
  let eventDelivered = resume && workflow.cancelEventPending !== true;
  let closeoutError: string | undefined;

  // From here every answer is 200, except a lease another attempt holds.
  const lease = new Date(Date.now() + CANCEL_CLOSEOUT_LEASE_MS).toISOString();
  let leased = false;
  try {
    leased = await claimCloseoutLease(workflowId, lease);
    if (!leased) return NextResponse.json({ error: "Cancel closeout already in progress" }, { status: 409 });

    // List the run's children before any write.
    let tickets: RunTicket[] | null = null;
    let truncated = false;
    if (!epicId) {
      sweep.incomplete = true;
      sweep.error = "the run has no epicId, so its tickets cannot be listed";
    } else if (JIRA && !ctx.jira) {
      sweep.incomplete = true;
      sweep.error = "Jira credentials not configured (JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN)";
    } else {
      try {
        if (JIRA) ({ tickets, truncated } = await listTicketsJira(needJira(ctx), epicId));
        else tickets = await listTicketsDynamoDB(epicId);
      } catch (err) {
        console.error(`[cancel] ticket listing failed:`, err);
        sweep.incomplete = true;
        sweep.error = `${JIRA ? "Jira search" : "Ticket query"} failed: ${errMsg(err)}`;
      }
    }

    if (tickets) {
      // Follow-ups waiting only on the CD ticket leave the run; the sweep never sees them.
      const { cdId, followUps: moving } = cdBlockedFollowUps(tickets);
      followUps = await moveFollowUpsOnCancel(ctx, cdId, moving);
      const moved = new Set(moving.map((t) => t.ticketId));
      await sweepTickets(ctx, tickets.filter((t) => !moved.has(t.ticketId)), sweep);
      if (truncated) {
        sweep.incomplete = true;
        sweep.error = `More than ${JQL_SEARCH_CAP} open children; ${tickets.length} processed, the rest left uncancelled and the epic left open`;
      }
      // The run epic (not in the child listing) closes only when nothing under it stays open or failed.
      if (!sweep.incomplete && !sweep.failed && !sweep.raced && !sweep.ticketsLeftRunning.length && !followUps.followUpsError) {
        try {
          await cancelTicket(ctx, epicId, "open");
          sweep.cancelled++;
        } catch (err) {
          if (isCCF(err) || errMsg(err).startsWith("No cancel transition")) sweep.skipped++;
          else {
            sweep.failed++;
            console.warn(`[cancel] Failed to cancel epic ${epicId}: ${errMsg(err)}`);
          }
        }
      }
    }

    // workflow.cancelled. A resume re-sends the stored original only while it is still pending.
    let event: { delivered: boolean; detail: Record<string, unknown> } | undefined;
    if (!resume || workflow.cancelEventPending === true) {
      const stored = workflow.cancelEventDetail;
      const detail =
        resume && stored && typeof stored === "object"
          ? (stored as Record<string, unknown>)
          : {
              workflowId,
              cancelledAt,
              previousPhase: resume ? workflow.previousPhase : workflow.phase,
              ...(reason ? { reason } : {}),
              ticketsCancelled: sweep.cancelled,
              ticketsSkipped: sweep.skipped,
              ticketsFailed: sweep.failed,
              ...(sweep.incomplete ? { ticketsIncomplete: true, ticketsError: sweep.error } : {}),
              ticketsLeftRunning: sweep.ticketsLeftRunning,
              followUpsMoved: followUps.followUpsMoved,
              ...(followUps.postRunEpicKey ? { postRunEpicKey: followUps.postRunEpicKey } : {}),
            };
      eventDelivered = await publishCancelled(workflowId, cancelledAt, detail);
      event = { delivered: eventDelivered, detail };
    }

    // Fully closed only when nothing was left open, nothing failed and the event went out.
    closeoutError =
      [
        sweep.incomplete ? `tickets incomplete: ${sweep.error}` : "",
        sweep.failed ? `${sweep.failed} ticket cancel(s) failed` : "",
        sweep.raced ? `${sweep.raced} ticket(s) changed status during the sweep` : "",
        sweep.ticketsLeftRunning.length ? `left running: ${sweep.ticketsLeftRunning.join(", ")}` : "",
        followUps.followUpsError ? `follow-ups: ${followUps.followUpsError}` : "",
        eventDelivered ? "" : "workflow.cancelled not delivered",
      ]
        .filter(Boolean)
        .join("; ") || undefined;
    await releaseCloseoutLease(workflowId, lease, closeoutError, event);
  } catch (err) {
    console.error(`[cancel] ${workflowId}: close-out threw:`, err);
    closeoutError = `${leased ? "close-out threw" : "close-out lease claim failed"}: ${errMsg(err)}`;
    if (leased) await releaseCloseoutLease(workflowId, lease, closeoutError);
  }

  (closeoutError ? console.error : console.log)(
    `[cancel] Workflow ${workflowId} ${resume ? "close-out resumed" : `cancelled (was: ${workflow.phase})`}. Tickets: ${sweep.cancelled} cancelled, ${sweep.skipped} skipped, ${sweep.failed} failed; follow-ups moved: ${followUps.followUpsMoved}` +
      (closeoutError ? ` — close-out pending: ${closeoutError}` : "")
  );

  const incomplete = sweep.incomplete ? { incomplete: true, error: sweep.error } : {};
  return NextResponse.json({
    status: "cancelled",
    cancelledAt,
    ...(reason ? { reason } : {}),
    ...(resume ? { resumed: true } : {}),
    tickets: {
      cancelled: sweep.cancelled,
      skipped: sweep.skipped,
      failed: sweep.failed,
      ...incomplete,
      ...(sweep.keptByRecord.length ? { keptByRecord: sweep.keptByRecord } : {}),
    },
    ...(sweep.incomplete ? { ticketsIncomplete: true, error: sweep.error } : {}),
    followUpsMoved: followUps.followUpsMoved,
    ...(followUps.followUpsError ? { followUpsError: followUps.followUpsError } : {}),
    ...(followUps.postRunEpicKey ? { postRunEpicKey: followUps.postRunEpicKey } : {}),
    ticketsLeftRunning: sweep.ticketsLeftRunning,
    closeoutPending: Boolean(closeoutError),
    ...(closeoutError ? { closeoutError } : {}),
    eventDelivered,
  });
}
