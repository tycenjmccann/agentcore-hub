/**
 * cancelRun — cancel one workflow run (TEAM-5358 FR-3, F2/F8/F9).
 *
 * The body of POST /api/workflow/[id]/cancel, lifted here so the stop route
 * (Turn 3f) cancels through the same code. The route only parses and identifies.
 *
 *  1. Lists the run's tickets (DynamoDB parentId-index, or one Jira JQL over the
 *     epic and its children) BEFORE any write, because two decisions need them:
 *     - F9: `cancelDecision:"stopped"` is persisted only for a human caller, or
 *       when every not-done human gate carries a verified `stopped` gate decision
 *       record (gate-decision-record.ts). A run with no such gate is not "stopped"
 *       by a non-human.
 *     - F2: the sweep leaves a human gate without a verified stopped record open
 *       (`humanGatesLeftOpen`), and an in_progress ticket whose agent session is
 *       live or finished keeps its real status (`ticketsLeftRunning`).
 *  2. CAS on the workflow row: phase cancelled, cancelReason, cancelledBy
 *     (+ cancelDecision, claimedCaller). Refuses every terminal phase and an
 *     already-set cancelledAt. completeReason is never touched.
 *  3. Sweeps the rest to cancelled. Jira never falls back to a Done-category
 *     transition: no Won't Do / Cancelled transition → `cancelStatusMissing`, the
 *     issue (or the epic) stays open and is reported.
 *  4. FR-5: follow-ups that wait only on the CD ticket are taken out of the run
 *     before 1's checks and the sweep (status untouched), then moved under a
 *     once-created post-run epic with `blocked_by: []` (moveFollowUpsOnCancel).
 *  5. workflow.cancelled goes to EventBridge AND the events table, same detail.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { SHIP_BLOCKED_OUTCOMES } from "./types";
import { JQL_SEARCH_CAP, searchJqlAll } from "./jira-search-paginate";
import { mapJiraStatusToInternal } from "./jira-client";
import { blockersFromLinks, type JiraIssueLink } from "./jira-client";
import { adfToPlainText } from "./jira-read";
import { isHumanGateTicket } from "./completion-evidence";
import { phaseOfTicket } from "./closeout-offenders";
import { gateDecisionRecordKey, verifyGateDecisionRecord } from "./gate-decision-record";
import { loadDecisionKeys } from "./decision-keys";
import { invokeTicketTool, ticketKeyOf } from "./ticket-tools";
import leaseConstants from "../../config/lease-constants.json";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

// TEAM-3755 — the ship-blocked outcomes are ALSO terminal: cancelling a run
// that already closed deploy-blocked / static-ci-only would overwrite its
// honest verdict with "cancelled". PARITY with TERMINAL_PHASES in
// complete/route.ts and completion.mjs; the F6 UI fix (WorkflowBoard hiding
// Cancel) only removes the button — this is the actual enforcement.
export const TERMINAL_PHASES = ["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES] as const;

/** The only decision a cancel can carry (TEAM-5358 FR-6). */
export const CANCEL_DECISION = "stopped";
export const CANCEL_REASON_MAX = 1000;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** An agent session that is still working (lease-constants + the board's active set). */
const LIVE_TASK_STATUSES = new Set<string>([...leaseConstants.liveClaimStatuses, "pending", "waiting_response"]);
const COMPLETE_TASK_STATUS = "complete";

/** Control chars stripped, trimmed. Empty → reason_required; over the max → reason_too_long (never clamped). */
export function sanitizeCancelReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: "reason_required" | "reason_too_long" } {
  const reason = (typeof raw === "string" ? raw : "").replace(CONTROL_CHARS, "").trim();
  if (!reason) return { ok: false, error: "reason_required" };
  if (reason.length > CANCEL_REASON_MAX) return { ok: false, error: "reason_too_long" };
  return { ok: true, reason };
}

/**
 * TEAM-3755 — the "not already terminal" ConditionExpression from the ONE list
 * above, mirroring terminalPhaseGuard() in complete/route.ts. Positional
 * placeholders (:tp0…) so they never collide with the write's own values.
 */
function terminalPhaseGuard(): { condition: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const condition = TERMINAL_PHASES.map((phase, i) => {
    const key = `:tp${i}`;
    values[key] = phase;
    return `#phase <> ${key}`;
  }).join(" AND ");
  return { condition, values };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });
const eventBridge = new EventBridgeClient({ region: REGION });

// ─── Types ────────────────────────────────────────────────────────────────────

/** One child ticket, provider-neutral. */
export type RunTicket = {
  ticketId: string;
  status: string;
  assignee?: string;
  labels?: string[];
  title?: string;
  description?: string;
  blockedBy?: string[];
  createdAt?: string;
};

type AgentTaskLike = { status?: string };

/** `incomplete` + `error` when some children could not be found or reached (TEAM-5171). */
export type CancelResults = {
  cancelled: number;
  skipped: number;
  failed: number;
  incomplete?: boolean;
  error?: string;
};

/** What the follow-up hook (FR-5) reports; folded into the response and the event. */
export type FollowUpResult = { followUpsMoved: number; followUpsError?: string; postRunEpicKey?: string };

/** Context the follow-up hook gets once the sweep is done. */
export type FollowUpContext = {
  workflowId: string;
  workflow: Record<string, unknown>;
  reason: string;
  /** Every child as read before the sweep (pre-sweep statuses). */
  tickets: RunTicket[];
  /** The CD ticket (findCdTicket) and the follow-ups waiting only on it; the sweep left these alone. */
  cdTicket: RunTicket | null;
  followUps: RunTicket[];
  ticketProvider: string;
};

// ─── FR-5: CD-blocked follow-ups ──────────────────────────────────────────────
//
// report_completion (lambda/workflow-output/index.mjs) materializes an agent's
// follow_ups[] as tickets titled `<title> [fu:<hash>]`, labelled
// `followup-<hash>`, parented on the run epic and blocked_by the run's CD ticket,
// with the description `followUpBanner(origin)` + "\n\n" + the finding text. A
// cancelled run never deploys, so that blocker never clears: the follow-ups would
// sit blocked under a cancelled epic forever. The cancel moves them instead.

const FOLLOWUP_TITLE_RE = /\[fu:([0-9a-f]{8})\]\s*$/;
const FOLLOWUP_LABEL_RE = /^followup-([0-9a-f]{8})$/;
/** workflow-output's followUpBanner(ticketId): the origin is the ticket that reported it. */
const FOLLOWUP_ORIGIN_RE = /AGENT-AUTHORED FOLLOW-UP \(materialized by report_completion from ([^;\s)]+);/;
/** workflow-output FOLLOW_UP_HUMAN_ASSIGNEE. */
export const FOLLOW_UP_HUMAN_ASSIGNEE = "human:engineer";
/** "Security-labelled": any label naming security (workflow-output never adds one; an agent or a human does). */
const SECURITY_LABEL_RE = /security/i;
export const POST_RUN_EPIC_SUMMARY = (workflowId: string) => `Post-run follow-ups ${workflowId}`;
export const FOLLOWUP_SECURITY_NOTIF_ID = (ticketId: string) => `notif_followup_security_${ticketId}`;

const CLOSED_STATUSES = new Set(["done", "cancelled"]);

/** The follow-up hash, from the title suffix or the followup-<hash> label; null when not a follow-up. */
export function followUpHashOf(t: RunTicket): string | null {
  const fromTitle = FOLLOWUP_TITLE_RE.exec(t.title || "")?.[1];
  if (fromTitle) return fromTitle;
  for (const l of t.labels || []) {
    const m = FOLLOWUP_LABEL_RE.exec(String(l));
    if (m) return m[1];
  }
  return null;
}

/**
 * Port of workflow-output's findCdTicket: the newest non-human ship-phase child.
 * Phase from the bundled roster by assignee, as there.
 */
export function findCdTicket(siblings: RunTicket[], { exclude }: { exclude?: string } = {}): RunTicket | null {
  const candidates = (siblings || []).filter(
    (s) => s.ticketId !== exclude && !String(s.assignee || "").startsWith("human:") && phaseOfTicket({ assignee: s.assignee }) === "ship"
  );
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (a.createdAt && b.createdAt ? String(a.createdAt).localeCompare(String(b.createdAt)) : 0));
  return sorted[sorted.length - 1];
}

/**
 * Open follow-ups whose blockers, minus closed tickets, are exactly the CD ticket.
 * One blocked by anything still live (an agent ticket, a gate) is not CD-blocked:
 * it is left to the sweep like any other child.
 */
export function cdBlockedFollowUps(tickets: RunTicket[]): { cdTicket: RunTicket | null; followUps: RunTicket[] } {
  const cdTicket = findCdTicket(tickets);
  if (!cdTicket) return { cdTicket: null, followUps: [] };
  const statusOf = new Map(tickets.map((t) => [t.ticketId, t.status]));
  const followUps = tickets.filter((t) => {
    if (t.ticketId === cdTicket.ticketId || CLOSED_STATUSES.has(t.status) || !followUpHashOf(t)) return false;
    const open = [...new Set(t.blockedBy || [])].filter((b) => !CLOSED_STATUSES.has(statusOf.get(b) || ""));
    return open.length === 1 && open[0] === cdTicket.ticketId;
  });
  return { cdTicket, followUps };
}

/** The finding text report_completion recorded for this follow-up (completions/<origin>.json followUps[]). */
async function originFindingText(origin: string | null, hash: string | null): Promise<string | null> {
  if (!origin || !hash) return null;
  const rec = (await readArtifactJson(`completions/${origin}.json`)) as { followUps?: Array<{ hash?: string; detail?: unknown }> } | null;
  const entry = Array.isArray(rec?.followUps) ? rec!.followUps.find((f) => f?.hash === hash) : undefined;
  return typeof entry?.detail === "string" && entry.detail.trim() ? entry.detail.trim() : null;
}

/**
 * The run's post-run epic, created at most once. An existing `postRunEpicKey` is
 * reused; otherwise create, then claim the row with attribute_not_exists. A
 * writer that lost the claim re-reads the winner and cancels its own epic (the
 * Jira twin's create dedupes by summary in the run, so the two may be the same
 * issue — then there is nothing to cancel).
 */
async function ensurePostRunEpic(ctx: FollowUpContext): Promise<string> {
  const existing = ctx.workflow.postRunEpicKey;
  if (typeof existing === "string" && existing) return existing;

  const created = await invokeTicketTool("Tickets___create_ticket", {
    summary: POST_RUN_EPIC_SUMMARY(ctx.workflowId),
    issue_type: "epic",
    workflow_id: ctx.workflowId,
    description:
      `Follow-ups moved out of cancelled run ${ctx.workflowId} (cancel reason: ${ctx.reason}). ` +
      `They were waiting on the run's CD ticket, which will never run.`,
  });
  if (!created.ok) throw new Error(`post-run epic not created: ${created.error}`);
  const mine = ticketKeyOf(created.result);
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
  const winner = row.Item?.postRunEpicKey;
  if (typeof winner !== "string" || !winner) throw new Error("postRunEpicKey claim lost but the row carries none");
  if (winner !== mine) {
    const dropped = await invokeTicketTool("Tickets___transition_ticket", {
      ticket_id: mine,
      transition_id: "cancelled",
      reason: `Duplicate post-run epic for ${ctx.workflowId}; ${winner} is the run's postRunEpicKey`,
    });
    if (!dropped.ok) console.warn(`[cancel] ${ctx.workflowId}: duplicate post-run epic ${mine} not cancelled: ${dropped.error}`);
  }
  return winner;
}

/** One manager_escalation per security follow-up, in the orchestrator's shape; skipped when its id is already there. */
async function escalateSecurityFollowUp(ctx: FollowUpContext, t: RunTicket, epicKey: string) {
  const id = FOLLOWUP_SECURITY_NOTIF_ID(t.ticketId);
  const notifs = Array.isArray(ctx.workflow.humanNotifications) ? (ctx.workflow.humanNotifications as Array<{ id?: string }>) : [];
  if (notifs.some((n) => n?.id === id)) return;
  const notification = {
    id,
    type: "manager_escalation",
    title: "Security follow-up needs an engineer",
    details:
      `Run ${ctx.workflowId} was cancelled before deploy. Security follow-up ${t.ticketId}` +
      (t.title ? ` ("${t.title}")` : "") +
      ` moved to post-run epic ${epicKey} and reassigned to ${FOLLOW_UP_HUMAN_ASSIGNEE}.`,
    reviewer: "close-out",
    timestamp: new Date().toISOString(),
    acknowledged: false,
  };
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId: ctx.workflowId },
      UpdateExpression:
        "SET humanNotifications = list_append(if_not_exists(humanNotifications, :empty), :n), notifVersion = if_not_exists(notifVersion, :zero) + :one",
      ExpressionAttributeValues: { ":empty": [], ":n": [notification], ":zero": 0, ":one": 1 },
    })
  );
}

/**
 * TEAM-5358 FR-5: move every CD-blocked follow-up under the post-run epic with
 * `blocked_by: []` and a MOVED banner (plus the origin finding text when the
 * description lacks it). Status is never touched. A security-labelled one also
 * goes to human:engineer with one manager_escalation. Never throws for one
 * ticket: failures are counted into followUpsError.
 */
export async function moveFollowUpsOnCancel(ctx: FollowUpContext): Promise<FollowUpResult> {
  if (!ctx.cdTicket || ctx.followUps.length === 0) return { followUpsMoved: 0 };
  const postRunEpicKey = await ensurePostRunEpic(ctx);
  const cd = ctx.cdTicket.ticketId;

  let followUpsMoved = 0;
  const errors: string[] = [];
  for (const t of ctx.followUps) {
    const existing = t.description || "";
    const origin = FOLLOWUP_ORIGIN_RE.exec(existing)?.[1] ?? null;
    const finding = await originFindingText(origin, followUpHashOf(t));
    const security = (t.labels || []).some((l) => SECURITY_LABEL_RE.test(String(l)));
    const description = [
      `MOVED on cancel of ${ctx.workflowId}: was blocked by CD ${cd} (origin ${origin || "unknown"})`,
      existing,
      finding && !existing.includes(finding) ? finding : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const moved = await invokeTicketTool("Tickets___update_ticket", {
      ticket_id: t.ticketId,
      parent: postRunEpicKey,
      blocked_by: [],
      description,
      ...(security && t.assignee !== FOLLOW_UP_HUMAN_ASSIGNEE ? { assignee: FOLLOW_UP_HUMAN_ASSIGNEE } : {}),
    });
    if (!moved.ok) {
      errors.push(`${t.ticketId}: ${moved.error}`);
      continue;
    }
    followUpsMoved++;
    if (security) {
      try {
        await escalateSecurityFollowUp(ctx, t, postRunEpicKey);
      } catch (err) {
        errors.push(`${t.ticketId}: escalation not recorded: ${(err as Error).message}`);
      }
    }
  }
  if (errors.length) console.warn(`[cancel] ${ctx.workflowId}: follow-up moves: ${errors.join("; ")}`);
  return { followUpsMoved, postRunEpicKey, ...(errors.length ? { followUpsError: errors.join("; ") } : {}) };
}

export type CancelRunInput = {
  workflowId: string;
  reason: string;
  decision?: typeof CANCEL_DECISION;
  /** The verified actor (verifiedActor(req, "cancel")): email/userId, svc:*, or unauthenticated:cancel. */
  cancelledBy: string;
  /** True only for requireHumanIdentity().ok. */
  humanIdentity: boolean;
  claimedCaller?: string;
  /** Test/3e seam; defaults to moveFollowUpsOnCancel. */
  moveFollowUps?: (ctx: FollowUpContext) => Promise<FollowUpResult>;
};

export type CancelRunResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 404 | 409; body: Record<string, unknown> };

type Sweep = CancelResults & {
  humanGatesLeftOpen: string[];
  ticketsLeftRunning: string[];
  cancelStatusMissing: string[];
};

// ─── Reads ────────────────────────────────────────────────────────────────────

const is404 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

async function readArtifactJson(key: string): Promise<unknown> {
  if (!ARTIFACT_BUCKET) return null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    const body = await obj.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (is404(err)) return null;
    console.warn(`[cancel] read ${key} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Ids of the human gates whose verified gate decision record says `stopped` (status cancelled). */
async function verifiedStoppedGates(workflowId: string, gates: RunTicket[]): Promise<Set<string>> {
  const stopped = new Set<string>();
  if (gates.length === 0) return stopped;
  const keys = await loadDecisionKeys();
  if (!keys.ok) {
    console.warn(`[cancel] ${workflowId}: gate decision key unavailable - no gate counts as stopped`);
    return stopped;
  }
  await Promise.all(
    gates.map(async (g) => {
      const rec = await readArtifactJson(gateDecisionRecordKey(workflowId, g.ticketId));
      if (
        verifyGateDecisionRecord(rec, keys.keys) &&
        rec.status === "cancelled" &&
        rec.ticketId === g.ticketId &&
        rec.workflowId === workflowId
      ) {
        stopped.add(g.ticketId);
      }
    })
  );
  return stopped;
}

/**
 * in_progress tickets whose agent session is live, or finished (agentTasks says
 * complete, or completions/<id>.json exists). Cancelling those would overwrite a
 * running or done agent's real status.
 */
async function ticketsWithAgentSession(workflow: Record<string, unknown>, tickets: RunTicket[]): Promise<Set<string>> {
  const tasks = (workflow.agentTasks || {}) as Record<string, AgentTaskLike>;
  const keep = new Set<string>();
  await Promise.all(
    tickets
      .filter((t) => t.status === "in_progress")
      .map(async (t) => {
        const st = String(tasks[t.ticketId]?.status || "");
        if (LIVE_TASK_STATUSES.has(st) || st === COMPLETE_TASK_STATUS) {
          keep.add(t.ticketId);
          return;
        }
        if (await readArtifactJson(`completions/${t.ticketId}.json`)) keep.add(t.ticketId);
      })
  );
  return keep;
}

// ─── DynamoDB ─────────────────────────────────────────────────────────────────

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
      out.push({
        ticketId: String(i.ticketId),
        status: String(i.status || ""),
        assignee: typeof i.assignee === "string" ? i.assignee : undefined,
        labels: Array.isArray(i.labels) ? (i.labels as string[]) : undefined,
        title: typeof i.title === "string" ? i.title : undefined,
        description: typeof i.description === "string" ? i.description : undefined,
        blockedBy: Array.isArray(i.blockedBy) ? (i.blockedBy as unknown[]).map(String) : undefined,
        createdAt: typeof i.createdAt === "string" ? i.createdAt : undefined,
      });
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** Cancel one DDB ticket iff it is still in the status the sweep read (else skipped). */
async function cancelOneTicketDynamoDB(ticketId: string, condition: { from: string } | "open") {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :cancelled, cancelledAt = :ts, #u = :u",
      ConditionExpression: condition === "open" ? "#s <> :done AND #s <> :cancelled" : "#s = :from",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":ts": now,
        ":u": now,
        ...(condition === "open" ? { ":done": "done" } : { ":from": condition.from }),
      },
    })
  );
}

const isCCF = (err: unknown) => (err as { name?: string })?.name === "ConditionalCheckFailedException";

async function sweepDynamoDB(epicId: string, toCancel: RunTicket[], base: Omit<Sweep, keyof CancelResults>, alreadyClosed: number): Promise<Sweep> {
  let cancelled = 0;
  let skipped = alreadyClosed;
  let failed = 0;
  const batchSize = 10;
  for (let i = 0; i < toCancel.length; i += batchSize) {
    const batch = toCancel.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((t) => cancelOneTicketDynamoDB(t.ticketId, { from: t.status })));
    for (const r of results) {
      if (r.status === "fulfilled") cancelled++;
      else if (isCCF(r.reason)) skipped++;
      else {
        failed++;
        console.warn(`[cancel] Failed to cancel ticket: ${r.reason?.message || "unknown"}`);
      }
    }
  }
  // Close the epic itself — the child query excludes it (an epic has no parentId) —
  // unless something under it stays open (same rule as the Jira sweep).
  if (base.humanGatesLeftOpen.length + base.ticketsLeftRunning.length > 0) {
    return { cancelled, skipped: skipped + 1, failed, ...base };
  }
  try {
    await cancelOneTicketDynamoDB(epicId, "open");
    cancelled++;
  } catch (err) {
    if (isCCF(err)) skipped++;
    else {
      failed++;
      console.warn(`[cancel] Failed to cancel epic ${epicId}: ${(err as Error).message}`);
    }
  }
  return { cancelled, skipped, failed, ...base };
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

type JiraAuth = { baseUrl: string; authHeader: string };

function getJiraAuth(): JiraAuth | null {
  const siteUrl = process.env.JIRA_SITE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!siteUrl || !email || !apiToken) return null;
  return {
    baseUrl: `https://${siteUrl}`,
    authHeader: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
  };
}

/** The issue has no Won't Do / Cancelled transition. Never answered with a Done one. */
export class CancelStatusMissingError extends Error {
  constructor(readonly issueKey: string) {
    super(`No Won't Do / Cancelled transition for ${issueKey}`);
    this.name = "CancelStatusMissingError";
  }
}

const CANCEL_TRANSITION_NAMES = new Set(["won't do", "wont do", "cancelled", "canceled", "cancel"]);

/** Transition one issue to Won't Do / Cancelled. Throws CancelStatusMissingError when the workflow has neither. */
async function cancelOneIssueJira(jiraAuth: JiraAuth, issueKey: string) {
  const transUrl = `${jiraAuth.baseUrl}/rest/api/3/issue/${issueKey}/transitions`;
  const transResp = await fetch(transUrl, {
    headers: { Authorization: jiraAuth.authHeader, Accept: "application/json" },
  });
  if (!transResp.ok) throw new Error(`Transitions read failed for ${issueKey}: HTTP ${transResp.status}`);
  const transData = await transResp.json();

  // TEAM-5358 FR-3: only a cancel status. The old fallback to "any Done-category
  // transition" closed cancelled work as Done, which close-out then read as shipped.
  const trans = (transData.transitions || []).find(
    (t: { name?: string; to?: { name?: string } }) =>
      CANCEL_TRANSITION_NAMES.has(String(t.name || "").toLowerCase()) ||
      CANCEL_TRANSITION_NAMES.has(String(t.to?.name || "").toLowerCase())
  );
  if (!trans) throw new CancelStatusMissingError(issueKey);

  const doTransition = (withResolution: boolean) =>
    fetch(transUrl, {
      method: "POST",
      headers: { Authorization: jiraAuth.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        transition: { id: trans.id },
        ...(withResolution ? { fields: { resolution: { name: "Won't Do" } } } : {}),
      }),
    });

  let resp = await doTransition(true);
  if (!resp.ok) {
    // Resolution may not be on the transition screen — retry the bare transition.
    resp = await doTransition(false);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Transition failed for ${issueKey}: HTTP ${resp.status} ${body.slice(0, 200)}`);
  }
}

type JiraIssue = {
  key: string;
  fields?: {
    status?: { name?: string };
    labels?: string[];
    summary?: string;
    description?: unknown;
    issuelinks?: JiraIssueLink[];
    created?: string;
  };
};

function jiraTicketOf(issue: JiraIssue): RunTicket {
  const labels = Array.isArray(issue.fields?.labels) ? issue.fields!.labels! : [];
  const reviewer = labels.find((l) => l.startsWith("reviewer:"));
  const agent = labels.find((l) => l.startsWith("agent:"));
  return {
    ticketId: issue.key,
    status: mapJiraStatusToInternal(issue.fields?.status?.name || "To Do"),
    assignee: agent ? agent.slice("agent:".length) : reviewer ? `human:${reviewer.slice("reviewer:".length)}` : undefined,
    labels,
    title: issue.fields?.summary,
    description: issue.fields?.description ? adfToPlainText(issue.fields.description) : undefined,
    blockedBy: blockersFromLinks(issue.fields?.issuelinks),
    createdAt: issue.fields?.created,
  };
}

/**
 * The epic and EVERY child, collected before any transition (each transition
 * changes what a status-filtered JQL would return, so paging mid-sweep skips).
 * All children, not only open ones: F9 judges the human gates a stop already
 * cancelled too.
 */
async function listTicketsJira(jiraAuth: JiraAuth, epicId: string) {
  return searchJqlAll<JiraIssue>({
    fetchPage: async (params) => {
      const resp = await fetch(`${jiraAuth.baseUrl}/rest/api/3/search/jql?${params.toString()}`, {
        headers: { Authorization: jiraAuth.authHeader, Accept: "application/json" },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`);
      }
      return resp.json();
    },
    jql: `parent = ${epicId} OR key = ${epicId}`,
    fields: "summary,status,labels,issuelinks,created,description",
  });
}

async function sweepJira(
  jiraAuth: JiraAuth,
  epic: RunTicket | null,
  toCancel: RunTicket[],
  base: Omit<Sweep, keyof CancelResults>,
  alreadyClosed: number,
  truncated: boolean
): Promise<Sweep> {
  let cancelled = 0;
  let skipped = alreadyClosed;
  let failed = 0;
  const cancelStatusMissing: string[] = [];

  const settle = (key: string, r: PromiseSettledResult<void>) => {
    if (r.status === "fulfilled") cancelled++;
    else if (r.reason instanceof CancelStatusMissingError) {
      skipped++;
      cancelStatusMissing.push(key);
    } else {
      failed++;
      console.warn(`[cancel] Jira ticket cancel failed: ${r.reason?.message || "unknown"}`);
    }
  };

  const batchSize = 5; // Jira rate limits
  for (let i = 0; i < toCancel.length; i += batchSize) {
    const batch = toCancel.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((t) => cancelOneIssueJira(jiraAuth, t.ticketId)));
    results.forEach((r, j) => settle(batch[j].ticketId, r));
  }

  if (truncated) {
    return {
      cancelled,
      skipped,
      failed,
      ...base,
      cancelStatusMissing,
      incomplete: true,
      error: `More than ${JQL_SEARCH_CAP} tickets; ${toCancel.length} processed, the rest left uncancelled and the epic left open`,
    };
  }

  // Close the epic, unless something under it stays open (a gate or a live agent:
  // the epic is not over while they are; same rule as the DynamoDB sweep), or it
  // is already closed.
  const leftOpen = base.humanGatesLeftOpen.length + base.ticketsLeftRunning.length > 0;
  if (epic && !leftOpen && epic.status !== "done" && epic.status !== "cancelled") {
    const [r] = await Promise.allSettled([cancelOneIssueJira(jiraAuth, epic.ticketId)]);
    settle(epic.ticketId, r);
  } else if (epic) {
    skipped++;
  }
  return { cancelled, skipped, failed, ...base, cancelStatusMissing };
}

// ─── cancelRun ────────────────────────────────────────────────────────────────

export async function cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
  const { workflowId, reason, decision, cancelledBy, humanIdentity, claimedCaller } = input;
  const moveFollowUps = input.moveFollowUps ?? moveFollowUpsOnCancel;

  // 1. Read current workflow with ConsistentRead
  const wfResult = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId }, ConsistentRead: true }));
  if (!wfResult.Item) return { ok: false, status: 404, body: { error: "Workflow not found" } };
  const workflow = wfResult.Item as Record<string, unknown>;

  // 2. Terminal state guard
  if (workflow.cancelledAt || TERMINAL_PHASES.includes(workflow.phase as (typeof TERMINAL_PHASES)[number])) {
    return { ok: false, status: 409, body: { error: "Workflow already in terminal state", phase: workflow.phase } };
  }
  const epicId = String(workflow.epicId || "");

  // 3. List the tickets BEFORE the write: F9 and the sweep's keep-lists need them.
  const jiraAuth = TICKET_PROVIDER === "jira" ? getJiraAuth() : null;
  let tickets: RunTicket[] = [];
  let epic: RunTicket | null = null;
  let listError: string | undefined;
  let truncated = false;
  try {
    if (TICKET_PROVIDER === "jira") {
      if (jiraAuth && epicId) {
        const res = await listTicketsJira(jiraAuth, epicId);
        truncated = res.truncated;
        const all = res.issues.map(jiraTicketOf);
        // Not listed (search scope or permissions): status unknown, the sweep still tries it.
        epic = all.find((t) => t.ticketId === epicId) || { ticketId: epicId, status: "unknown" };
        tickets = all.filter((t) => t.ticketId !== epicId);
      }
    } else if (epicId) {
      tickets = await listTicketsDynamoDB(epicId);
    }
  } catch (err) {
    listError = TICKET_PROVIDER === "jira" ? `Jira search failed: ${(err as Error).message}` : `Ticket query failed: ${(err as Error).message}`;
    console.error(`[cancel] ${workflowId}: ${listError}`);
  }

  // FR-5: CD-blocked follow-ups leave the run (they are moved, not swept). Every
  // check below judges what remains — a human:engineer handoff follow-up is not
  // a gate the cancel has to stop.
  const { cdTicket, followUps: followUpTickets } = cdBlockedFollowUps(tickets);
  const moving = new Set(followUpTickets.map((t) => t.ticketId));
  const runTickets = tickets.filter((t) => !moving.has(t.ticketId));

  // Human gates not closed done: open ones, and ones a stop already cancelled.
  const humanGates = runTickets.filter((t) => t.status !== "done" && isHumanGateTicket(t));
  const stopped = await verifiedStoppedGates(workflowId, humanGates);

  // F9: a non-human caller's `stopped` stands only on a verified stop per gate.
  const decisionProven = humanIdentity || (humanGates.length > 0 && humanGates.every((g) => stopped.has(g.ticketId)));
  const cancelDecision = decision === CANCEL_DECISION && decisionProven && !listError ? CANCEL_DECISION : undefined;
  const decisionDropped = decision === CANCEL_DECISION && !cancelDecision;
  if (decisionDropped) {
    console.warn(`[cancel] ${workflowId}: decision stopped NOT persisted (${cancelledBy} is not a human and not every human gate has a verified stop)`);
  }

  // 4. Conditional write — phase cancelled, with who and why. completeReason untouched.
  const cancelledAt = new Date().toISOString();
  const guard = terminalPhaseGuard();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :cancelled, cancelledAt = :ts, previousPhase = :prev, cancelReason = :reason, cancelledBy = :by" +
          (cancelDecision ? ", cancelDecision = :decision" : "") +
          (claimedCaller ? ", claimedCaller = :cc" : ""),
        ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":ts": cancelledAt,
          ":prev": workflow.phase,
          ":reason": reason,
          ":by": cancelledBy,
          ...guard.values,
          ...(cancelDecision ? { ":decision": cancelDecision } : {}),
          ...(claimedCaller ? { ":cc": claimedCaller } : {}),
        },
      })
    );
  } catch (err) {
    if (isCCF(err)) {
      return { ok: false, status: 409, body: { error: "Workflow already in terminal state", phase: workflow.phase } };
    }
    throw err;
  }

  // 5. Sweep. Done/cancelled children are skipped; open human gates without a
  //    verified stop and in_progress tickets with an agent session are kept.
  const keepRunning = await ticketsWithAgentSession(workflow, runTickets);
  const humanGatesLeftOpen = humanGates.filter((g) => g.status !== "cancelled" && !stopped.has(g.ticketId)).map((g) => g.ticketId);
  const ticketsLeftRunning = [...keepRunning];
  const closed = runTickets.filter((t) => t.status === "done" || t.status === "cancelled");
  const toCancel = runTickets.filter(
    (t) => t.status !== "done" && t.status !== "cancelled" && !humanGatesLeftOpen.includes(t.ticketId) && !keepRunning.has(t.ticketId)
  );
  const base = { humanGatesLeftOpen, ticketsLeftRunning, cancelStatusMissing: [] as string[] };

  let sweep: Sweep;
  if (listError) {
    sweep = { cancelled: 0, skipped: 0, failed: 0, ...base, incomplete: true, error: listError };
  } else if (TICKET_PROVIDER === "jira") {
    sweep = jiraAuth
      ? await sweepJira(jiraAuth, epic, toCancel, base, closed.length, truncated)
      : { cancelled: 0, skipped: 0, failed: 0, ...base };
  } else {
    sweep = epicId ? await sweepDynamoDB(epicId, toCancel, base, closed.length) : { cancelled: 0, skipped: 0, failed: 0, ...base };
  }

  // 6. FR-5: move the CD-blocked follow-ups. Runs whatever the sweep reported
  //    (cancelStatusMissing included). Never fails the cancel.
  let followUps: FollowUpResult;
  try {
    followUps = await moveFollowUps({
      workflowId,
      workflow,
      reason,
      tickets,
      cdTicket,
      followUps: followUpTickets,
      ticketProvider: TICKET_PROVIDER,
    });
  } catch (err) {
    followUps = { followUpsMoved: 0, followUpsError: (err as Error).message };
  }

  (sweep.incomplete ? console.error : console.log)(
    `[cancel] Workflow ${workflowId} cancelled by ${cancelledBy} (was: ${workflow.phase}). Tickets: ${sweep.cancelled} cancelled, ${sweep.skipped} skipped, ${sweep.failed} failed` +
      (sweep.humanGatesLeftOpen.length ? `; human gates left open: ${sweep.humanGatesLeftOpen.join(", ")}` : "") +
      (sweep.ticketsLeftRunning.length ? `; left running: ${sweep.ticketsLeftRunning.join(", ")}` : "") +
      (sweep.cancelStatusMissing.length ? `; no Won't Do status: ${sweep.cancelStatusMissing.join(", ")}` : "") +
      (sweep.incomplete ? ` — INCOMPLETE: ${sweep.error}` : "")
  );

  // 7. workflow.cancelled — EventBridge and the events table carry the same detail.
  const detail: Record<string, unknown> = {
    workflowId,
    cancelledAt,
    previousPhase: workflow.phase,
    cancelledBy,
    ...(claimedCaller ? { claimedCaller } : {}),
    reason,
    ...(cancelDecision ? { decision: cancelDecision } : {}),
    ...(decisionDropped ? { decisionDropped: true } : {}),
    ticketsCancelled: sweep.cancelled,
    ticketsSkipped: sweep.skipped,
    ticketsFailed: sweep.failed,
    humanGatesLeftOpen: sweep.humanGatesLeftOpen,
    ticketsLeftRunning: sweep.ticketsLeftRunning,
    ...(sweep.cancelStatusMissing.length ? { cancelStatusMissing: sweep.cancelStatusMissing } : {}),
    ...(sweep.incomplete ? { ticketsIncomplete: true, ticketsError: sweep.error } : {}),
    ...followUps,
  };
  try {
    await eventBridge.send(
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
  } catch (err) {
    console.warn(`[cancel] EventBridge publish failed: ${(err as Error).message}`);
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          workflowId,
          eventId: `${Date.now()}-cancel-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: cancelledAt,
          type: "workflow.cancelled",
          detail,
        },
      })
    );
  } catch {
    /* event publish is non-fatal */
  }

  // Still 200: the phase CAS has committed, and the board reads !ok as "not
  // cancelled". Unclosed tickets are reported in the body instead.
  const { humanGatesLeftOpen: hg, ticketsLeftRunning: lr, cancelStatusMissing: csm, incomplete, error, ...counts } = sweep;
  return {
    ok: true,
    body: {
      status: "cancelled",
      cancelledAt,
      cancelledBy,
      reason,
      ...(cancelDecision ? { decision: cancelDecision } : {}),
      ...(decisionDropped ? { decisionDropped: true } : {}),
      tickets: { ...counts, ...(incomplete ? { incomplete, error } : {}) },
      humanGatesLeftOpen: hg,
      ticketsLeftRunning: lr,
      ...(csm.length ? { cancelStatusMissing: csm } : {}),
      ...(incomplete ? { ticketsIncomplete: true, error } : {}),
      ...followUps,
    },
  };
}
