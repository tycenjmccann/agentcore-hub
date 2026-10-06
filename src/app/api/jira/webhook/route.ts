/**
 * POST /api/jira/webhook — Jira Cloud Webhook Receiver
 *
 * Thin adapter: receives Jira webhook, extracts the status change, and
 * enqueues a command on the workflow FIFO queue (WORKFLOW_COMMAND_QUEUE_URL).
 * MessageGroupId = the workflow's root issue key, so all commands for one
 * workflow are processed strictly in order by the orchestrator — concurrent
 * webhook deliveries for the same run can no longer race each other
 * (R1 of docs/race-condition-study.md). Content-based dedup on
 * (issueKey, status, Jira event timestamp) absorbs at-least-once redeliveries.
 *
 * The orchestrator handles ALL logic (context building, agent invocation,
 * cascade, phase advancement). This route just translates the Jira event
 * into the orchestrator's input format.
 *
 * TEAM-5322 F7 — the one exception to "thin": a human closing a gate to Done in the
 * Jira UI bypasses the ticket twin, so a decision-bound gate could close on no
 * decision. A human-gate Done made by anyone but the service account is RATIFIED
 * through the twin (Tickets___transition_ticket on an already-Done issue runs the
 * same guards and records what they admit). If the twin answers decision_required
 * the route reopens the gate to In Review, says why, re-pages it
 * (gate:awaiting-console) and forwards in_review instead of done. When the ratify
 * itself FAILS (throws, or answers anything that is neither an admission nor a held
 * close) on a gate whose description declares DECISION OPTIONS, the route fails
 * closed the same way: a human re-answering is the safe direction. Only a gate KNOWN
 * to be unbound passes through on a failed ratify. The decision itself still lives
 * in the twin; nothing here decides what work happens next.
 *
 * TEAM-5338 F7 — every unknown fails closed too. An unresolvable service account
 * (the twin's own close cannot be told from a human's) and an unreadable
 * description (bound or not cannot be told) both reopen the gate rather than
 * forward Done; the only cost is a human re-closing it. A reopen whose transition
 * fails forwards NOTHING and answers 503, so Jira redelivers and the reopen is
 * retried. RESIDUAL: while the issue sits Done in Jira un-forwarded, the
 * orchestrator's reconcile sweep (Jira mode reads sibling status from Jira,
 * orchestrator getChildTickets) can treat it as a resolved blocker and re-drive a
 * dependent once it has been parked past the lease TTL. Closing that needs an
 * orchestrator-side change and is a recorded follow-up
 * (docs/workflow/gate-verify-lifecycle.md). Re-pages (comment + gate:awaiting-console) are throttled to
 * one per issue per REPAGE_THROTTLE_MS, per task, so a redelivery storm or a
 * Jira outage cannot flood the human.
 *
 * Fallback: when WORKFLOW_COMMAND_QUEUE_URL is unset, invokes the
 * orchestrator Lambda directly (pre-R1 behavior) so the app keeps working
 * against an install that hasn't created the queue yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { JiraClient, mapJiraStatusToInternal } from "@/lib/workflow/jira-client";
import { commandGroupId, commandDedupId } from "@/lib/workflow/command-queue";
import { adfToPlainText } from "@/lib/workflow/jira-read";
import { parseDecisionOptions } from "@/lib/workflow/decision-contract";

const REGION = process.env.AWS_REGION || "us-east-1";
const ORCHESTRATOR_LAMBDA = process.env.ORCHESTRATOR_LAMBDA || "agentcore-hub-orchestrator";
const COMMAND_QUEUE_URL = process.env.WORKFLOW_COMMAND_QUEUE_URL || "";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";

const lambda = new LambdaClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

interface JiraWebhookPayload {
  webhookEvent?: string;
  timestamp?: number;
  issue?: {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      parent?: { key: string };
      labels: string[];
      [key: string]: unknown;
    };
  };
  // The Jira user who made the change (absent on some system events).
  user?: { accountId?: string };
  changelog?: {
    items: Array<{
      field: string;
      fromString: string;
      toString: string;
    }>;
  };
}

async function dispatchCommand(
  payload: JiraWebhookPayload,
  issueKey: string,
  newStatus: string,
  oldStatus: string
) {
  const command = { source: "jira-webhook", ticketId: issueKey, newStatus, oldStatus };

  if (COMMAND_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: COMMAND_QUEUE_URL,
        MessageBody: JSON.stringify(command),
        MessageGroupId: commandGroupId(issueKey, payload.issue?.fields?.parent?.key),
        MessageDeduplicationId: commandDedupId(issueKey, newStatus, payload.timestamp),
      })
    );
    return;
  }

  // Legacy direct invoke (no queue configured).
  await lambda.send(
    new InvokeCommand({
      FunctionName: ORCHESTRATOR_LAMBDA,
      InvocationType: "Event",
      Payload: JSON.stringify(command),
    })
  );
}

// The service account is the identity every twin/hub transition is made as. Cached
// per container: it never changes without a redeploy of the credentials.
let serviceAccountCache: string | null = null;
async function serviceAccountId(): Promise<string | null> {
  if (serviceAccountCache) return serviceAccountCache;
  try {
    serviceAccountCache = (await JiraClient.fromEnv().myself()).accountId || null;
  } catch (err) {
    console.warn(`[jira-webhook] could not resolve the service account: ${(err as Error).message}`);
  }
  return serviceAccountCache;
}

/** Human-review gates carry `reviewer:<who>` (jira-read.ts surfaces it as human:*). */
function isHumanGate(labels: unknown): boolean {
  return Array.isArray(labels) && labels.some((l) => typeof l === "string" && l.startsWith("reviewer:"));
}

async function invokeTicketTool(toolName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ tool_name: toolName, parameters })),
    })
  );
  if (res.FunctionError || !res.Payload) return null;
  try {
    return JSON.parse(Buffer.from(res.Payload).toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The options a gate's description declares: `{ok:true, options}` (null options =
 * the gate binds nothing), or `{ok:false}` when the description could not be read,
 * which is never mistaken for unbound. The webhook's description may be a string or
 * ADF; absent, it is fetched.
 */
async function declaredOptions(issueKey: string, description: unknown): Promise<{ ok: true; options: string[] | null } | { ok: false }> {
  let text = description === undefined ? null : adfToPlainText(description);
  if (text === null) {
    try {
      text = adfToPlainText((await JiraClient.fromEnv().getIssue(issueKey, ["description"])).fields?.description);
    } catch (err) {
      console.warn(`[jira-webhook] ${issueKey}: could not read the description (${(err as Error).name})`);
      return { ok: false };
    }
  }
  return { ok: true, options: parseDecisionOptions(text) };
}

// TEAM-5338 F7: one re-page per issue per window, per task. Bounded: entries past
// the window are dropped once the map grows.
const REPAGE_THROTTLE_MS = 10 * 60 * 1000;
const lastRepage = new Map<string, number>();
function repageAllowed(issueKey: string, now = Date.now()): boolean {
  const last = lastRepage.get(issueKey);
  if (last !== undefined && now - last < REPAGE_THROTTLE_MS) return false;
  if (lastRepage.size > 500) {
    for (const [k, t] of lastRepage) if (now - t >= REPAGE_THROTTLE_MS) lastRepage.delete(k);
  }
  lastRepage.set(issueKey, now);
  return true;
}

type ReopenOutcome = "in_review" | "reopen_failed";

/**
 * Put a refused/unratifiable gate back: In Review, say why, re-page it. Answers
 * "in_review" only when the transition landed; "reopen_failed" otherwise, and the
 * caller then forwards nothing. The re-page is throttled (repageAllowed).
 */
async function reopenGate(issueKey: string, options: string[] | null, why: string): Promise<ReopenOutcome> {
  console.warn(`[jira-webhook] ${issueKey}: ${why} - reopening to In Review`);
  const jira = JiraClient.fromEnv();
  let outcome: ReopenOutcome = "in_review";
  try {
    await jira.transitionToInternalStatus(issueKey, "in_review");
  } catch (err) {
    console.error(`[jira-webhook] ${issueKey}: could not reopen the gate: ${(err as Error).message}`);
    outcome = "reopen_failed";
  }
  if (!repageAllowed(issueKey)) {
    console.warn(JSON.stringify({ event: "jira_webhook_repage_throttled", issueKey, outcome }));
    return outcome;
  }
  const pick = options?.length
    ? `Pick one of: ${options.join(" | ")} - from the hub console or the Telegram gate message.`
    : `Decide it again from the hub console or the Telegram gate message.`;
  try {
    await jira.addComment(
      issueKey,
      "gate-guard",
      outcome === "in_review"
        ? `Reopened: this gate was closed in the Jira UI without a decision the ticket service could ratify. ${pick}`
        : `This gate was closed in the Jira UI without a decision the ticket service could ratify, and could not be reopened; it is NOT treated as done. ${pick}`
    );
  } catch (err) {
    console.warn(`[jira-webhook] ${issueKey}: could not comment the reopen (${(err as Error).name})`);
  }
  try {
    await invokeTicketTool("Tickets___labels_add", { ticket_id: issueKey, labels: ["gate:awaiting-console"] });
  } catch (err) {
    console.warn(`[jira-webhook] ${issueKey}: could not re-page the gate (${(err as Error).name})`);
  }
  return outcome;
}

/**
 * Reopen unless the gate is KNOWN to bind no decision. An unreadable description
 * is not known-unbound, so it reopens.
 */
async function reopenUnlessUnbound(issueKey: string, description: unknown, why: string): Promise<"done" | ReopenOutcome> {
  const declared = await declaredOptions(issueKey, description);
  if (declared.ok && !declared.options) {
    console.warn(`[jira-webhook] ${issueKey}: ${why} on an unbound gate - forwarding done`);
    return "done";
  }
  return reopenGate(issueKey, declared.ok ? declared.options : null, declared.ok ? `${why} on a decision-bound gate` : `${why}; description unreadable`);
}

/**
 * TEAM-5322 F7 — ratify a human's Jira-UI Done through the twin. Returns the status
 * to forward: "done" when the twin admits it, "in_review" when the gate was put back,
 * "reopen_failed" when it could not be (forward nothing). A ratify that fails
 * (throws / any non-admission, non-held answer) fails closed unless the gate is
 * known to be unbound.
 */
async function ratifyJiraUiDone(issueKey: string, accountId: string, description: unknown): Promise<"done" | ReopenOutcome> {
  let result: Record<string, unknown> | null = null;
  let failure: string;
  try {
    result = await invokeTicketTool("Tickets___transition_ticket", {
      ticket_id: issueKey,
      transition_id: "done",
      reason: `ratify: Jira UI close by ${accountId}`,
    });
    failure = result ? `ratify answered ${String(result.reason || result.error || "an unrecognised envelope")}` : "ratify failed";
  } catch (err) {
    failure = `ratify invoke failed (${(err as Error).name})`;
  }
  // Admitted: the twin recorded the decision on the already-Done issue.
  if (result && result.ok !== false && result.status === "done") return "done";
  // A held close (post-condition unmet): the twin already moved it back itself.
  if (result?.status === "verifying") return "in_review";
  if (result?.reason === "decision_required") {
    const options = Array.isArray(result.options) ? (result.options as string[]) : [];
    return reopenGate(issueKey, options, "Jira-UI Done without a decision");
  }
  return reopenUnlessUnbound(issueKey, description, failure);
}

export async function POST(req: NextRequest) {
  let payload: JiraWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload.issue) {
    return NextResponse.json({ received: true, ignored: true, reason: "no issue" });
  }

  const issueKey = payload.issue.key;

  // Handle issue_created — new ticket, treat as status=todo with no old status
  if (payload.webhookEvent === "jira:issue_created") {
    const newStatus = mapJiraStatusToInternal(payload.issue.fields.status.name);
    console.log(`[jira-webhook] ${issueKey}: CREATED (${newStatus})`);

    try {
      await dispatchCommand(payload, issueKey, newStatus, "new");
      return NextResponse.json({ received: true, processed: true, issueKey, newStatus });
    } catch (err) {
      console.error(`[jira-webhook] Error dispatching command for ${issueKey}:`, err);
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // Handle issue_updated — requires changelog with status change
  if (!payload.changelog) {
    return NextResponse.json({ received: true, ignored: true, reason: "no changelog" });
  }

  const statusChange = payload.changelog.items.find(
    (item) => item.field === "status"
  );
  if (!statusChange) {
    return NextResponse.json({ received: true, ignored: true, reason: "no status change" });
  }

  const mapped = mapJiraStatusToInternal(statusChange.toString || "");
  const oldStatus = mapJiraStatusToInternal(statusChange.fromString || "");
  let newStatus: string = mapped;

  const actor = payload.user?.accountId;
  if (mapped === "done" && actor && isHumanGate(payload.issue.fields.labels)) {
    const svc = await serviceAccountId();
    // TEAM-5338 F7: unknown service account ⇒ the twin's own close cannot be told
    // apart from a human's. Fail closed: a decision-bound (or unreadable) gate is
    // reopened, and a twin close that gets caught this way is re-decided by the
    // human. Only a gate known to bind nothing passes.
    if (!svc) {
      console.warn(JSON.stringify({ event: "jira_webhook_ratify_unavailable", issueKey, actor, why: "service_account_unresolved" }));
      newStatus = await reopenUnlessUnbound(issueKey, payload.issue.fields.description, "service account unresolved");
    } else if (actor !== svc) {
      newStatus = await ratifyJiraUiDone(issueKey, actor, payload.issue.fields.description);
    }
  }

  if (newStatus === "reopen_failed") {
    // Never forward a Done we could not ratify nor undo; 503 makes Jira redeliver.
    console.error(JSON.stringify({ event: "jira_webhook_reopen_failed", issueKey, actor }));
    return NextResponse.json({ error: "gate_reopen_failed", issueKey, forwarded: false }, { status: 503 });
  }

  console.log(`[jira-webhook] ${issueKey}: "${statusChange.fromString}" → "${statusChange.toString}" (${oldStatus} → ${newStatus})`);

  try {
    await dispatchCommand(payload, issueKey, newStatus, oldStatus);
    return NextResponse.json({
      received: true,
      processed: true,
      issueKey,
      newStatus,
    });
  } catch (err) {
    console.error(`[jira-webhook] Error dispatching command for ${issueKey}:`, err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
