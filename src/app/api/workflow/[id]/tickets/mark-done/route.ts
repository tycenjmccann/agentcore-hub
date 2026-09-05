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
 *
 * TEAM-4099 F6 — FILL-ONLY, never a clobber. The three sources above chose what
 * this route WRITES; nothing protected what was already on the row, so a typed
 * `--evidence` replaced an agent's real `output` (and the S3 record overwrote the
 * agent's own completions record). Now the row write is `if_not_exists` per field
 * under `attribute_not_exists(...output)` (workflow-store.markDoneEvidence) and
 * the record is a conditional create (`IfNoneMatch: "*"`). Real evidence wins;
 * a caller who means to replace it must say `force: true` and is logged doing so.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { markDoneEvidence } from "@/lib/workflow/workflow-store";
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
 * Write the completions record, creating it only if absent unless the caller
 * forced the mark-done. TEAM-4099 F6: this used to be an unconditional
 * PutObject, so a manager mark-done overwrote the agent's OWN record — the same
 * clobber F4 fixed on the synthesis path, in the other direction. `IfNoneMatch:
 * "*"` makes it a conditional create; a 412 means the agent (or the salvage
 * path) already wrote one and theirs stands.
 *
 * Returns "written" | "exists" | "failed" — "failed" is non-fatal by design:
 * the agentTasks row write is what the completion gate reads.
 */
async function writeCompletionRecord(
  ticketId: string,
  body: string,
  force: boolean
): Promise<"written" | "exists" | "failed"> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: `completions/${ticketId}.json`,
        Body: body,
        ContentType: "application/json",
        ...(force ? {} : { IfNoneMatch: "*" }),
      })
    );
    return "written";
  } catch (err) {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "PreconditionFailed" || e?.Code === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412) {
      return "exists";
    }
    console.warn(`[mark-done] ${ticketId}: completions record write failed: ${(err as Error).message}`);
    return "failed";
  }
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
  // F6: an explicit "yes, replace the evidence that is already there". Not a
  // security boundary (the actor is still authenticated and stamped) — it is the
  // difference between a manager filling a gap and a manager overruling an agent.
  const force = body.force === true;

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

    // 1. The evidence, on the run record — FILL-ONLY (F6). SECURITY F16: no
    //    mergeCommit, no outcome, no blockReason — a manager override never
    //    forges a ship verdict.
    const row = await markDoneEvidence(
      workflowId,
      ticketId,
      { output, branch, commitSha, prUrl, evidenceSource: "manager", markedDoneBy, markedDoneAt },
      { force, seed: { agentId: assignee } }
    );
    if (!row.applied) {
      // Real evidence is already on the row and we were not told to replace it.
      // Refuse the WHOLE mark-done — no record write, no transition — and say
      // which of the two things the caller probably wanted: a stale board moves
      // through the transition endpoint (evidence untouched), an actual override
      // needs force:true with this actor's name on it. `evidenceSource` comes
      // from the pre-read snapshot: informational, not the CAS the refusal rests
      // on (that one is `attribute_not_exists(agentTasks.<tid>.output)`).
      const existing = ((workflow.agentTasks as Record<string, Row> | undefined)?.[ticketId] || {}) as Row;
      return NextResponse.json(
        {
          code: "EVIDENCE_EXISTS",
          error:
            `${ticketId} already carries evidence (evidenceSource: ${str(existing.evidenceSource) || "unknown"}) — ` +
            `a mark-done fills gaps, it never replaces an agent's own report. If the board is merely stale, move ` +
            `the ticket with the transition endpoint and leave the evidence alone. If you really mean to overrule ` +
            `it, repeat this call with { force: true } and your name goes on the override.`,
          ticketId,
          evidenceSource: str(existing.evidenceSource),
          reason: row.reason,
        },
        { status: 409 }
      );
    }

    // 2. The durable record, so the orchestrator's own re-harvest (and the
    //    completion route's) find it too. `source: "manager"` — never "agent".
    //    Conditional create unless forced (F6): an existing record is the
    //    agent's, and D1.3's own precedence says the agent's record outranks us.
    let recordState: "written" | "exists" | "failed" | "skipped" = "skipped";
    if (ARTIFACT_BUCKET) {
      recordState = await writeCompletionRecord(
        ticketId,
        JSON.stringify(
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
            ...(force ? { forced: true } : {}),
          },
          null,
          2
        ),
        force
      );
      if (recordState === "exists") {
        // Their record stands; ours is dropped. The row write DID apply (the gate
        // reads that), and the board still moves — the ticket is done either way,
        // and stopping here would leave a done-in-fact ticket open on the board.
        console.log(
          `[mark-done] ${workflowId}/${ticketId}: completions record already exists — keeping it, row evidence applied`
        );
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
              // F6: an override is a different act from a fill, and a replay must
              // be able to tell them apart.
              ...(force ? { forced: true } : {}),
              recordState,
            },
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    console.log(
      `[mark-done] ${workflowId}/${ticketId}: done by ${markedDoneBy} ` +
        `(evidence: ${evidenceSource}${force ? ", FORCED" : ""}, record: ${recordState})`
    );
    return NextResponse.json({
      ok: true,
      ticketId,
      evidenceSource,
      branch,
      commitSha,
      prUrl,
      ...(force ? { forced: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[mark-done] ${workflowId}/${ticketId}:`, message);
    return NextResponse.json({ error: `Failed to mark ${ticketId} done: ${message}` }, { status: 500 });
  }
}
