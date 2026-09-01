/**
 * POST /api/workflow/start — EVENT-DRIVEN VERSION
 *
 * Creates workflow metadata and a requirements ticket.
 * Supports two backends:
 *   - TICKET_PROVIDER=dynamodb → DynamoDB direct (mock Jira) + DDB Stream trigger
 *   - TICKET_PROVIDER=jira → Real Jira Cloud + webhook trigger
 *
 * The Next.js app does NOT invoke any agents directly.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { validateIntakeSources } from "@/lib/workflow/intake";
import type { WorkflowInput } from "@/lib/workflow/types";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";
import { resolveWorkflowDef } from "@/lib/workflow/defs-loader";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || process.env.PROJECT_KEY || "TEAM";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";

// TEAM-3335 F1: intakeChannel values reserved for internal callers. The
// anomaly-watcher Lambda counts its fleet-wide open-filing cap via a GSI on
// intakeChannel = "anomaly-detector", and FR-7 requires autonomous filings to be
// audit-distinguishable from external ones — so this route (which has no auth in
// the default AUTH_MODE=none) must not let an arbitrary caller spoof the value,
// which would poison the cap (DoS on genuine autonomous filings) and forge
// "autonomous" audit records. Reserved values require the shared-secret header.
const RESERVED_INTAKE_CHANNELS = new Set(["anomaly-detector"]);
const INTAKE_INTERNAL_SECRET_HEADER = "x-intake-internal-secret";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambda = new LambdaClient({ region: REGION });

const TERMINAL_PHASES = new Set(["complete", "error", "cancelled"]);

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function mintWorkflowId(): string {
  return `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * TEAM-3619 D4b: start idempotency on (sourceTicket, workflowDefId).
 *
 * A dedup marker row (`wfdedup_<sha256(sourceTicket:defId)>`) lives in the
 * workflows table itself and is claimed with `attribute_not_exists(workflowId)`
 * BEFORE any epic/workflow is created — so a redelivered start for the same
 * (sourceTicket, def) can't fork a second run. Returns one of:
 *   - { coalesce: workflowId }  → an existing non-terminal run owns this key;
 *                                 the caller should return it verbatim.
 *   - { proceed: workflowId }   → this caller owns the key (fresh claim, or the
 *                                 prior canonical run was terminal and we
 *                                 atomically re-pointed the marker); create with
 *                                 exactly this workflowId.
 * Works identically for both ticket providers (the marker is app state).
 */
async function resolveDedup(
  sourceTicket: string,
  defId: string
): Promise<{ coalesce?: string; proceed?: string }> {
  const idemKey = createHash("sha256").update(`${sourceTicket}:${defId}`).digest("hex");
  const markerId = `wfdedup_${idemKey}`;
  const candidateWorkflowId = mintWorkflowId();

  try {
    await ddb.send(
      new PutCommand({
        TableName: WORKFLOWS_TABLE,
        Item: {
          workflowId: markerId,
          canonicalWorkflowId: candidateWorkflowId,
          sourceTicket,
          defId,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(workflowId)",
      })
    );
    return { proceed: candidateWorkflowId };
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
  }

  // The marker already exists — inspect the canonical run it points to.
  const markerRes = await ddb.send(
    new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId: markerId }, ConsistentRead: true })
  );
  const priorCanonical = markerRes.Item?.canonicalWorkflowId as string | undefined;
  if (priorCanonical) {
    const canonRes = await ddb.send(
      new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId: priorCanonical }, ConsistentRead: true })
    );
    const canon = canonRes.Item;
    // A live (non-terminal) canonical run owns this key — coalesce onto it.
    if (canon && !TERMINAL_PHASES.has(String(canon.phase)) && canon.deleted !== true) {
      return { coalesce: priorCanonical };
    }
  }

  // The prior run is terminal (or gone). Atomically re-point the marker at a
  // fresh run, guarded on the exact canonical id we just read so a concurrent
  // racer can't double-claim. If that guard loses, re-read and coalesce.
  try {
    await ddb.send(
      new PutCommand({
        TableName: WORKFLOWS_TABLE,
        Item: {
          workflowId: markerId,
          canonicalWorkflowId: candidateWorkflowId,
          sourceTicket,
          defId,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: priorCanonical
          ? "canonicalWorkflowId = :old"
          : "attribute_not_exists(canonicalWorkflowId)",
        ...(priorCanonical ? { ExpressionAttributeValues: { ":old": priorCanonical } } : {}),
      })
    );
    return { proceed: candidateWorkflowId };
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    const reread = await ddb.send(
      new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId: markerId }, ConsistentRead: true })
    );
    const winner = reread.Item?.canonicalWorkflowId as string | undefined;
    return winner ? { coalesce: winner } : { proceed: candidateWorkflowId };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: WorkflowInput = await req.json();

    if (!body.title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    if (body.intakeChannel !== undefined && !/^[a-z][a-z0-9-]{1,31}$/.test(body.intakeChannel)) {
      return NextResponse.json({ error: "intakeChannel must match ^[a-z][a-z0-9-]{1,31}$" }, { status: 400 });
    }

    // TEAM-3335 F1: reserved values need proof of internal origin. FAIL CLOSED:
    // with ANOMALY_INTAKE_SECRET unset on the server, every reserved-value request
    // is rejected. 403 is a 4xx, which the watcher's postStart treats as terminal —
    // a misconfiguration degrades loudly to a "FILING FAILED" page, never a silent
    // retry loop. Requests without intakeChannel are untouched by this branch.
    if (body.intakeChannel !== undefined && RESERVED_INTAKE_CHANNELS.has(body.intakeChannel)) {
      const expected = process.env.ANOMALY_INTAKE_SECRET || "";
      const provided = req.headers.get(INTAKE_INTERNAL_SECRET_HEADER) || "";
      if (!expected || !secretMatches(provided, expected)) {
        return NextResponse.json(
          { error: `intakeChannel "${body.intakeChannel}" is reserved for internal callers` },
          { status: 403 }
        );
      }
    }

    // Resolve the def from the LIVE S3 config (same doc the orchestrator runs),
    // so routine defs created by the Routine Builder resolve here. An unknown id
    // is a HARD 400 — never silently fall back to software-delivery, which would
    // run the full dev pipeline with the wrong intake agent on a schedule.
    // An absent id means the caller wants the default (checked-in) pipeline.
    let def: WorkflowDef | null;
    if (body.workflowDefId) {
      def = await resolveWorkflowDef(body.workflowDefId);
      if (!def) {
        return NextResponse.json(
          { error: `Unknown workflowDefId "${body.workflowDefId}" — not found in config/workflows.json` },
          { status: 400 }
        );
      }
    } else {
      def = await resolveWorkflowDef("software-delivery");
      if (!def) {
        return NextResponse.json({ error: "Default workflow def unavailable" }, { status: 500 });
      }
    }

    // repoConfig is only required for defs that actually check out a repo
    // (requiresRepo). Marketing/legal/sales and most routines don't touch code.
    if (def.requiresRepo && !body.repoConfig) {
      return NextResponse.json(
        { error: `repoConfig is required for the "${def.id}" workflow` },
        { status: 400 }
      );
    }
    if (!body.repoConfig) {
      body.repoConfig = { layout: "multi-repo", repos: [] };
    }

    if (!body.sources) body.sources = [];
    if (!body.description) body.description = "";

    // Validate sources are reachable
    if (body.sources.length > 0) {
      const errors = await validateIntakeSources(body.sources);
      if (errors.length > 0) {
        return NextResponse.json({ error: "Source validation failed", details: errors }, { status: 422 });
      }
    }

    // TEAM-3619 D4b: idempotency on (sourceTicket, defId). Only requests that
    // carry a sourceTicket are deduplicated — human/API callers keep the plain
    // mint-a-new-run behavior. The marker is claimed before any epic/workflow
    // exists, so a redelivery coalesces instead of forking a duplicate run.
    let workflowId: string | undefined;
    if (body.sourceTicket) {
      const dedup = await resolveDedup(body.sourceTicket, def.id);
      if (dedup.coalesce) {
        return NextResponse.json({ workflowId: dedup.coalesce, deduplicated: true });
      }
      workflowId = dedup.proceed;
    }

    if (TICKET_PROVIDER === "jira") {
      return await startWithJira(body, def, workflowId);
    } else {
      return await startWithDynamoDB(body, def, workflowId);
    }
  } catch (err) {
    console.error("Workflow start error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ─── Jira Cloud Backend ────────────────────────────────────────────────────────

async function startWithJira(body: WorkflowInput, def: WorkflowDef, presetWorkflowId?: string) {
  const { JiraCloudProvider } = await import("@/lib/workflow/ticket-provider-jira");
  const jira = new JiraCloudProvider();

  const intakePhase = def.phases.find((p) => p.type === "agent")?.agentPhase || "requirements";
  const workflowId = presetWorkflowId || mintWorkflowId();

  // 1. Create epic in Jira
  const epic = await jira.createEpic({ title: body.title, description: body.description });
  const epicId = epic.id;

  // 2. Create workflow metadata in DynamoDB (this is app state, not tickets —
  //    the orchestrator needs it for context building regardless of ticket backend)
  await ddb.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: {
      workflowId,
      id: workflowId,
      phase: intakePhase,
      epicId,
      repoConfig: body.repoConfig,
      // Routine-scoped connectors (if any) — forwarded to each agent invoke so
      // the runtime loads their creds/tools for this workflow's run only.
      connectors: body.connectors,
      input: body,
      agentTasks: {},
      messages: [],
      humanNotifications: [],
      startedAt: new Date().toISOString(),
      ticketProvider: "jira",
      workflowType: body.workflowType || "feature",
      workflowDefId: def.id,
      ...(body.intakeChannel ? { intakeChannel: body.intakeChannel } : {}),
    },
  }));

  // 3. Create the intake ticket in Jira (assigned to the workflow's intake agent)
  const reqTicket = await jira.createTicket({
    parentId: epicId,
    title: `${def.phases.find((p) => p.type === "agent")?.name || "Intake"}: ${def.intakeAgentId} — ${body.title}`,
    description: `Analyze the request and create tickets for the relevant agents.\n\nTitle: ${body.title}\nDescription: ${body.description}`,
    assignee: def.intakeAgentId,
    blockedBy: [],
    // wfdef stamp keeps the ticket classifiable on the dashboard even if the
    // workflow row is later deleted.
    extraLabels: [`wfdef:${def.id}`],
  }, workflowId);

  // Requirements ticket has no blockers — transition to "Ready" so the webhook fires
  // and the orchestrator invokes the agent (same flow as all other tickets in the pipeline)
  await jira.transitionTo(reqTicket.id, "Ready");
  console.log(`[start/jira] Workflow ${workflowId} created. Epic: ${epicId}. Req ticket: ${reqTicket.id} → Ready.`);

  return NextResponse.json({ workflowId, epicId });
}

// ─── DynamoDB Backend (via ticket tools Lambda) ──────────────────────────────

async function startWithDynamoDB(body: WorkflowInput, def: WorkflowDef, presetWorkflowId?: string) {
  const intakePhase = def.phases.find((p) => p.type === "agent")?.agentPhase || "requirements";
  const intakePhaseName = def.phases.find((p) => p.type === "agent")?.name || "Intake";
  const workflowId = presetWorkflowId || mintWorkflowId();

  // 1. Create the epic via ticket tools Lambda
  const epicResult = await invokeTicketLambda("Tickets___create_ticket", {
    summary: body.title,
    description: body.description || "",
    issue_type: "Epic",
    workflow_id: workflowId,
  });

  if (epicResult.error) {
    throw new Error(`Failed to create epic in Jira: ${epicResult.error}`);
  }

  const epicId = (epicResult.key || epicResult.ticketId) as string;

  // 2. Transition epic to in_progress in both systems
  await invokeTicketLambda("Tickets___transition_ticket", {
    ticket_id: epicId,
    transition_id: "in_progress",
  });

  // 3. Create workflow metadata in workflows table
  await ddb.send(new PutCommand({
    TableName: WORKFLOWS_TABLE,
    Item: {
      workflowId,
      id: workflowId,
      phase: intakePhase,
      epicId,
      repoConfig: body.repoConfig,
      // Routine-scoped connectors (if any) — forwarded to each agent invoke so
      // the runtime loads their creds/tools for this workflow's run only.
      connectors: body.connectors,
      input: body,
      agentTasks: {},
      messages: [],
      humanNotifications: [],
      startedAt: new Date().toISOString(),
      workflowType: body.workflowType || "feature",
      workflowDefId: def.id,
      ...(body.intakeChannel ? { intakeChannel: body.intakeChannel } : {}),
    },
  }));

  // 4. Create the intake ticket via ticket tools Lambda
  //    DDB write triggers Stream → orchestrator Lambda picks it up
  const reqResult = await invokeTicketLambda("Tickets___create_ticket", {
    summary: `${intakePhaseName}: ${def.intakeAgentId} — ${body.title}`,
    description: `Analyze the request and create tickets for the relevant agents.\n\nTitle: ${body.title}\nDescription: ${body.description}`,
    issue_type: "Task",
    parent_key: epicId,
    assignee: def.intakeAgentId,
    workflow_id: workflowId,
  });

  if (reqResult.error) {
    throw new Error(`Failed to create requirements ticket: ${reqResult.error}`);
  }

  const reqTicketId = (reqResult.key || reqResult.ticketId) as string;

  console.log(`[start] Workflow ${workflowId} created. Epic: ${epicId}. Requirements ticket ${reqTicketId} will trigger first.`);

  return NextResponse.json({ workflowId, epicId });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function invokeTicketLambda(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await lambda.send(new InvokeCommand({
    FunctionName: TICKET_TOOLS_LAMBDA,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({
      tool_name: toolName,
      parameters: params,
    })),
  }));

  const payload = JSON.parse(new TextDecoder().decode(resp.Payload));
  // Lambda may return the result directly or wrapped in a body
  if (typeof payload === "string") return JSON.parse(payload);
  return payload;
}
