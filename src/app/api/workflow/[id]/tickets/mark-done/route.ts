/**
 * POST /api/workflow/[id]/tickets/mark-done   (TEAM-3991 D1.3)
 *
 * The Workflow Manager's honest `mark_done`. Its predecessor flipped a ticket's
 * board status and nothing else, which is how runs ended up complete-but-empty:
 * the completion gate later found an agentTasks entry with no output, refused,
 * and the human who "fixed" the run had to fix it again — or worse, the run
 * closed green over work nobody could point at.
 *
 * So a mark-done here must LEAVE EVIDENCE, in this order of preference:
 *   1. `completions/<ticketId>.json` — the agent DID report, the cascade just
 *      missed it. Use the agent's own words.
 *   2. GitHub — the agent pushed a branch / opened a PR and died before
 *      reporting. Harvest the proof (evidence.ts, shared with the orchestrator).
 *   3. The `evidence` text the human typed. A human vouching IS evidence.
 * Nothing at all ⇒ 409 NO_EVIDENCE. We never mark a ticket done on a hunch:
 * that is precisely the phantom-deliverable the completion gate exists to catch.
 *
 * SECURITY (TEAM-3991 F16):
 *   - `markedDoneBy` comes from the middleware-verified identity header, NEVER
 *     from the body. This row is the audit trail for a human overriding a gate.
 *   - This route NEVER writes `mergeCommit`, `outcome`, or `blockReason`. Those
 *     are ship/CD verdicts — a human clicking "done" on a dev ticket must not be
 *     able to manufacture proof that something merged or deployed. The
 *     `evidenceSource: "manager"` stamp keeps the provenance legible downstream.
 *   - `refuse_if_protected`: a human-assigned ticket (a review/merge gate) or a
 *     ticket in `in_review` is a DECISION someone else owes. Marking it done from
 *     here would forge that decision — 409 PROTECTED_TICKET. Gate decisions go
 *     through the transition route, which records them in the gate ledger.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { JiraClient } from "@/lib/workflow/jira-client";
import { githubApi, parseRepo, probeTicketBranches, type BranchEvidence } from "@/lib/workflow/evidence";
import { getIdentity } from "@/lib/auth/identity";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

type Row = Record<string, unknown>;

/** The completions record the agent may already have written. */
async function readCompletionRecord(ticketId: string): Promise<Row | null> {
  if (!ARTIFACT_BUCKET) return null;
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: `completions/${ticketId}.json` })
    );
    const body = await obj.Body?.transformToString();
    return body ? (JSON.parse(body) as Row) : null;
  } catch {
    return null; // absent or unreadable — fall through to the next source
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The ticket row, whichever provider owns it. */
async function loadTicket(workflowId: string, ticketId: string): Promise<Row | null> {
  if (TICKET_PROVIDER === "jira") {
    const tickets = (await getTicketsForWorkflowFromJira(workflowId)) as unknown as Row[];
    return tickets.find((t) => t.ticketId === ticketId) || null;
  }
  const got = await ddb.send(new GetCommand({ TableName: TICKETS_TABLE, Key: { ticketId } }));
  return got.Item || null;
}

/** Move the ticket to done through whichever backend is configured. */
async function transitionToDone(ticketId: string, by: string): Promise<void> {
  if (TICKET_PROVIDER === "jira") {
    await JiraClient.fromEnv().transitionIssue(ticketId, "Done");
    return;
  }
  const lambda = new LambdaClient({ region: REGION });
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets",
      InvocationType: "RequestResponse",
      Payload: Buffer.from(
        JSON.stringify({
          tool_name: "Tickets___transition_ticket",
          parameters: { ticket_id: ticketId, transition_id: "done", reason: `Marked done by ${by}` },
        })
      ),
    })
  );
  if (res.FunctionError) {
    throw new Error(res.Payload ? Buffer.from(res.Payload).toString() : "tickets Lambda failed");
  }
}

/**
 * Merge evidence into `agentTasks.<ticketId>`, creating the entry when the agent
 * died before any claim landed (hand-port of workflow-store.mjs
 * mergeTaskMetadataOrTrack: scoped conditional merge, seed, re-merge). Every
 * write is field-scoped — never a whole-map rewrite, so a concurrent
 * orchestrator write to another ticket cannot be clobbered (R2).
 */
async function mergeTaskEvidence(
  workflowId: string,
  ticketId: string,
  fields: Record<string, unknown>,
  seed: Record<string, unknown>
): Promise<boolean> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return false;
  const names: Record<string, string> = { "#tid": ticketId };
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  entries.forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
  });
  const merge = async () => {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "attribute_exists(agentTasks.#tid)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      );
      return true;
    } catch (err) {
      if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
      return false;
    }
  };
  if (await merge()) return true;
  // No tracked entry: seed one (first-writer-wins, so a concurrent tracker is
  // harmless) and merge again.
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks = if_not_exists(agentTasks, :emptyMap)",
      ExpressionAttributeValues: { ":emptyMap": {} },
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: "SET agentTasks.#tid = if_not_exists(agentTasks.#tid, :seed)",
      ExpressionAttributeNames: { "#tid": ticketId },
      ExpressionAttributeValues: {
        ":seed": { ticketId, status: "pending", createdAt: new Date().toISOString(), ...seed },
      },
    })
  );
  return await merge();
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  let body: Row;
  try {
    body = (await req.json()) as Row;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ticketId = str(body.ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  }
  // SECURITY F16: the actor is the authenticated caller, never the body.
  const markedDoneBy = getIdentity(req).userId;

  try {
    const wf = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }));
    const workflow = wf.Item;
    if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

    const ticket = await loadTicket(workflowId, ticketId);
    if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

    // refuse_if_protected — a decision someone else owes is not ours to make.
    const assignee = str(ticket.assignee);
    const status = str(ticket.status).toLowerCase();
    if (assignee.startsWith("human:") || status === "in_review") {
      return NextResponse.json(
        {
          code: "PROTECTED_TICKET",
          error:
            assignee.startsWith("human:")
              ? `${ticketId} is assigned to ${assignee} — a human gate is a decision, not a status. Use the transition endpoint so the decision is recorded in the gate ledger.`
              : `${ticketId} is in_review — approve or request changes through the transition endpoint.`,
          ticketId,
          assignee,
          status,
        },
        { status: 409 }
      );
    }

    // ── Harvest, best first ────────────────────────────────────────────────
    let evidenceSource = "";
    let output = "";
    let branch = "";
    let commitSha = "";
    let prUrl = "";

    const record = await readCompletionRecord(ticketId);
    if (record) {
      output = str(record.summary) || str(record.output);
      branch = str(record.branch);
      commitSha = str(record.commit_sha);
      prUrl = str(record.pr_url);
      if (output || branch || commitSha || prUrl) evidenceSource = "record";
    }

    if (!evidenceSource) {
      // The agent pushed but never reported: ask GitHub, not the human.
      const { owner, repo } = parseRepo(workflow.repoConfig);
      if (owner && repo && process.env.GITHUB_PAT) {
        const base =
          str((workflow.repoConfig as { repos?: Array<{ defaultBranch?: string }> })?.repos?.[0]?.defaultBranch) ||
          "main";
        const candidates = [
          `feature/${ticketId}-${assignee}`,
          `feature/${ticketId}`,
          str(workflow.featureBranch),
        ].filter(Boolean);
        let ev: BranchEvidence = { hasEvidence: false };
        try {
          ev = await probeTicketBranches(githubApi(), { owner, repo, base, branches: candidates });
        } catch (err) {
          console.warn(`[mark-done] ${ticketId}: GitHub probe failed: ${(err as Error).message}`);
        }
        if (ev.hasEvidence) {
          branch = ev.branch || "";
          commitSha = ev.commitSha || "";
          prUrl = ev.prUrl || "";
          output = `[manager] ${ev.aheadBy ?? 0} commit(s) on ${branch}; PR ${prUrl || "none"}`;
          evidenceSource = "github";
        }
      }
    }

    if (!evidenceSource) {
      const typed = str(body.evidence);
      if (typed) {
        output = typed;
        evidenceSource = "typed";
      }
    }

    if (!evidenceSource) {
      // NEVER FABRICATE. Say exactly what would satisfy the gate.
      return NextResponse.json(
        {
          code: "NO_EVIDENCE",
          error:
            `No evidence for ${ticketId}: no completions record, no branch or PR on GitHub, and no ` +
            `evidence text supplied. Marking it done would create the phantom deliverable the ` +
            `completion gate refuses. Pass { evidence: "<what you verified>" } to vouch for it yourself.`,
          ticketId,
        },
        { status: 409 }
      );
    }

    const markedDoneAt = new Date().toISOString();

    // 1. The evidence, on the run record. SECURITY F16: no mergeCommit, no
    //    outcome, no blockReason — a manager override never forges a ship verdict.
    await mergeTaskEvidence(
      workflowId,
      ticketId,
      { output, branch, commitSha, prUrl, evidenceSource: "manager", markedDoneBy, markedDoneAt },
      { agentId: assignee }
    );

    // 2. The durable record, so the orchestrator's own re-harvest (and the
    //    completion route's) find it too. `source: "manager"` — never "agent".
    if (ARTIFACT_BUCKET) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: `completions/${ticketId}.json`,
            Body: JSON.stringify(
              {
                source: "manager",
                ticket_id: ticketId,
                workflow_id: workflowId,
                agent_id: assignee,
                summary: output,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                marked_done_by: markedDoneBy,
                marked_done_at: markedDoneAt,
              },
              null,
              2
            ),
            ContentType: "application/json",
          })
        );
      } catch (err) {
        // The agentTasks write already landed, which is what the gate reads.
        console.warn(`[mark-done] ${ticketId}: completions record write failed: ${(err as Error).message}`);
      }
    }

    // 3. Only now the board. Evidence first, status second: the reverse order is
    //    how a done-but-empty ticket gets created in the first place.
    await transitionToDone(ticketId, markedDoneBy);

    // 4. Announce the intervention — a human closing an agent's ticket is exactly
    //    the kind of thing a replay must show.
    try {
      await ddb.send(
        new PutCommand({
          TableName: EVENTS_TABLE,
          Item: {
            workflowId,
            eventId: `${Date.now()}-mark-done-${Math.random().toString(36).slice(2, 6)}`,
            type: "manager.intervention",
            timestamp: markedDoneAt,
            detail: {
              workflowId,
              ticketId,
              action: "mark_done",
              evidenceSource,
              by: markedDoneBy,
              branch,
              commitSha,
              prUrl,
            },
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    console.log(`[mark-done] ${workflowId}/${ticketId}: done by ${markedDoneBy} (evidence: ${evidenceSource})`);
    return NextResponse.json({ ok: true, ticketId, evidenceSource, branch, commitSha, prUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[mark-done] ${workflowId}/${ticketId}:`, message);
    return NextResponse.json({ error: `Failed to mark ${ticketId} done: ${message}` }, { status: 500 });
  }
}
