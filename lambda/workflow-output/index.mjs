/**
 * Workflow Output Lambda — receives structured work products from agents.
 * Stores to S3, marks tickets done in DynamoDB, and returns a confirmation.
 *
 * Tools: submit_ticket_plan, save_design_doc, report_completion
 */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const BUCKET = process.env.ARTIFACT_BUCKET || "";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "jira";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA ||
  (TICKET_PROVIDER === "jira" ? "agentcore-hub-jira" : "agentcore-hub-tickets");
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

async function publishJourneyEvent(workflowId, type, detail) {
  if (!EVENTS_TABLE || !workflowId) return;
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        workflowId,
        eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        detail,
        timestamp: new Date().toISOString(),
      },
    }));
  } catch { /* non-fatal */ }
}

async function submitTicketPlan({ workflow_id, requirements, tickets }) {
  const key = `workflows/${workflow_id}/shared/ticket-plan.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify({ requirements, tickets }, null, 2),
    ContentType: "application/json",
  }));
  return {
    status: "saved",
    location: `s3://${BUCKET}/${key}`,
    ticket_count: tickets.length,
    message: `Ticket plan saved with ${tickets.length} tickets as a record. NEXT: you must call Tickets___create_ticket once per ticket to actually create them under the epic in the ticket system. submit_ticket_plan only persists the plan — it does not create tickets.`,
  };
}

async function saveDesignDoc({ workflow_id, agent_id, title, content, format = "markdown", doc_type }) {
  const ext = format === "json" ? "json" : "md";
  // Deterministic filename: an agent re-saving (retry, crash recovery, duplicate
  // ticket) overwrites its own doc in place instead of accreting a new
  // design-doc-<timestamp> copy on every call.
  const slug = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : ["design-doc", agent_id, doc_type && doc_type !== "design" ? doc_type : null]
        .filter(Boolean).join("-");
  const filename = `${slug}.${ext}`;
  const key = `workflows/${workflow_id}/${agent_id}/${filename}`;
  const sharedKey = `workflows/${workflow_id}/shared/${filename}`;

  // Detect pre-existing docs so the caller knows whether it is updating its own
  // doc or about to add a doc alongside another agent's — dup-ticket guard.
  let existed = false;
  let otherDocs = [];
  try {
    const sharedPrefix = `workflows/${workflow_id}/shared/`;
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: sharedPrefix }));
    const docs = (r.Contents || [])
      .map((o) => o.Key.slice(sharedPrefix.length))
      .filter((k) => /\.(md|json)$/.test(k) && /design|spec/i.test(k));
    existed = docs.includes(filename);
    otherDocs = docs.filter((f) => f !== filename);
  } catch { /* non-fatal */ }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: content,
    ContentType: format === "json" ? "application/json" : "text/markdown",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: sharedKey,
    Body: content,
    ContentType: format === "json" ? "application/json" : "text/markdown",
  }));
  // Update manifest with design doc reference (skip when overwriting — the
  // existing manifest entry already points at this key)
  if (workflow_id && agent_id && !existed) {
    try {
      await updateManifest(workflow_id, agent_id, [{
        type: "design-doc", format: format === "json" ? "json" : "markdown",
        description: title || "Design document", s3Key: sharedKey, addedBy: agent_id, critical: true,
      }]);
    } catch { /* non-fatal */ }
  }

  return {
    status: existed ? "updated" : "saved",
    location: `s3://${BUCKET}/${key}`,
    shared_location: `s3://${BUCKET}/${sharedKey}`,
    existing_design_docs: otherDocs,
    message: existed
      ? `Updated your existing design doc in place (${filename} overwritten).`
      : `Design doc saved. Other agents can read it from the shared location.` +
        (otherDocs.length
          ? ` NOTE: other design docs already exist for this workflow (${otherDocs.join(", ")}). If your ticket duplicates one of them, reference/update the existing doc instead of authoring a parallel one.`
          : ""),
  };
}

// TEAM-4121 FR-9 — how the agent knows the work is done. "live" is the one the
// orchestrator acts on (live-reverify.mjs): a fix that claimed live evidence and
// closed without it is re-verified at the PR head. Anything else is dropped
// rather than stored, so a downstream reader never has to guess what a novel
// value meant.
const EVIDENCE_KINDS = ["static", "unit", "live"];

// TEAM-4122 FR-4 §7.5 — how the CI agent's completion record proves a head SHA
// was actually built. "certified" requires a real CodeBuild build id proven
// against the head (Pipeline___get_build_status / start_ci_build); it must
// never be set from GitHub check-runs alone. Same drop-rather-than-store rule
// as EVIDENCE_KINDS, for the same reason: a downstream reader (release manager,
// orchestrator) must never have to guess what a novel value meant.
const CI_STATUSES = ["certified", "github-actions-proxy", "unverified"];
const CI_FIELD_MAX_LEN = 128;

async function reportCompletion({ ticket_id, summary, artifacts = "", branch, commit_sha, pr_url, workflow_id, agent_id, evidence_kind, evidence_keys, ci_status, ci_build_id, ci_head_sha }) {
  const key = `completions/${ticket_id}.json`;
  const report = {
    ticket_id,
    summary,
    artifacts,
    branch: branch || null,
    commit_sha: commit_sha || null,
    pr_url: pr_url || null,
    completed_at: new Date().toISOString(),
  };
  // Additive and only when supplied: a record written without them keeps exactly
  // the pre-4121 key set, so every existing consumer is unaffected.
  const kind = typeof evidence_kind === "string" ? evidence_kind.trim().toLowerCase() : "";
  if (kind) {
    if (EVIDENCE_KINDS.includes(kind)) report.evidence_kind = kind;
    else console.warn(`[report_completion] dropping unknown evidence_kind "${kind}" (expected ${EVIDENCE_KINDS.join("|")})`);
  }
  const keys = typeof evidence_keys === "string" ? evidence_keys.trim() : Array.isArray(evidence_keys) ? evidence_keys.join(",") : "";
  if (keys) report.evidence_keys = keys;

  // TEAM-4122 FR-4: same additive-only rule as the evidence pair above.
  const status = typeof ci_status === "string" ? ci_status.trim().toLowerCase() : "";
  if (status) {
    if (CI_STATUSES.includes(status)) report.ci_status = status;
    else console.warn(`[report_completion] dropping unknown ci_status "${status}" (expected ${CI_STATUSES.join("|")})`);
  }
  const buildId = typeof ci_build_id === "string" ? ci_build_id.trim() : "";
  if (buildId && buildId.length <= CI_FIELD_MAX_LEN) report.ci_build_id = buildId;
  else if (buildId) console.warn(`[report_completion] dropping oversized ci_build_id (${buildId.length} chars)`);
  const headSha = typeof ci_head_sha === "string" ? ci_head_sha.trim() : "";
  if (headSha && headSha.length <= CI_FIELD_MAX_LEN) report.ci_head_sha = headSha;
  else if (headSha) console.warn(`[report_completion] dropping oversized ci_head_sha (${headSha.length} chars)`);

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(report, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[report_completion] Saved s3://${BUCKET}/${key}`);

  // Journey log: report_completion received — includes agentId so UI can immediately mark agent done
  await publishJourneyEvent(workflow_id || ticket_id, "workflow.report_completion", {
    ticketId: ticket_id, agentId: agent_id || null, summary: summary.slice(0, 200), branch: branch || null, pr_url: pr_url || null,
  });

  // Transition ticket to Done in Jira — this triggers the webhook cascade
  // (orchestrator unblocks downstream tickets when it sees "done")
  if (ticket_id && !ticket_id.startsWith("HEALTHCHECK-") && !ticket_id.startsWith("TEST-")) {
    try {
      const resp = await lambda.send(new InvokeCommand({
        FunctionName: TICKET_TOOLS_LAMBDA,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({
          tool_name: "Tickets___transition_ticket",
          parameters: { ticket_id, transition_id: "done" },
        })),
      }));
      const payload = JSON.parse(new TextDecoder().decode(resp.Payload));
      if (payload.error) {
        console.error(`[report_completion] Failed to transition ${ticket_id} to Done:`, payload.error);
      } else {
        console.log(`[report_completion] Transitioned ${ticket_id} → Done`);
      }
    } catch (err) {
      console.error(`[report_completion] Error transitioning ${ticket_id}:`, err.message);
    }
  }

  return {
    status: "complete",
    message: `Completion saved for ${ticket_id}. Ticket transitioned to Done.`,
  };
}

// TEAM-4166 §1.2 — the structured "I can't finish yet" channel. An agent that
// finds its ticket blocked on sibling work that isn't done reports the ids it is
// waiting on instead of either lying via report_completion (which would Done the
// ticket) or spinning silently. This is a NON-terminal signal: it stamps
// preconditionUnmet on the ticket — the evidence the orchestrator's D1 re-wake
// and D2 liveness clock read — via the SAME tickets-Lambda invoke path
// report_completion uses, but with the annotate action, which NEVER transitions
// the ticket and NEVER writes a completions/<id>.json record.
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const AWAITING_CAP = 20;
const NOTE_MAX = 2000;

async function reportPreconditionUnmet({ ticket_id, awaiting_ids, note = "", workflow_id, agent_id }) {
  const self = typeof ticket_id === "string" ? ticket_id.trim() : "";
  if (!TICKET_KEY_RE.test(self)) {
    return { status: "error", message: "invalid ticket_id" };
  }
  // Split on whitespace OR commas (agents pass "TEAM-1, TEAM-2" or "TEAM-1 TEAM-2"),
  // keep only ticket-shaped ids that aren't the reporter itself, dedupe, cap.
  const raw = Array.isArray(awaiting_ids)
    ? awaiting_ids
    : typeof awaiting_ids === "string"
      ? awaiting_ids.split(/[\s,]+/)
      : [];
  const awaitingIds = [];
  for (const item of raw) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!TICKET_KEY_RE.test(id) || id === self || awaitingIds.includes(id)) continue;
    awaitingIds.push(id);
    if (awaitingIds.length >= AWAITING_CAP) break;
  }
  if (awaitingIds.length === 0) {
    return { status: "error", message: "no valid awaiting_ids" };
  }

  const noteText = typeof note === "string" ? note.slice(0, NOTE_MAX) : "";
  const reportedAt = new Date().toISOString();
  const agentId = agent_id || null;

  // Same LambdaClient.invoke path report_completion uses for the Done transition,
  // but the annotate action only STAMPS preconditionUnmet — no status change.
  if (self && !self.startsWith("HEALTHCHECK-") && !self.startsWith("TEST-")) {
    try {
      const resp = await lambda.send(new InvokeCommand({
        FunctionName: TICKET_TOOLS_LAMBDA,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({
          tool_name: "Tickets___annotate_precondition_unmet",
          parameters: { ticket_id: self, awaitingIds, note: noteText, reportedAt, agentId, source: "tool" },
        })),
      }));
      const payload = JSON.parse(new TextDecoder().decode(resp.Payload));
      if (payload.error) {
        console.error(`[report_precondition_unmet] annotate failed for ${self}:`, payload.error);
      } else {
        console.log(`[report_precondition_unmet] ${self} awaiting ${awaitingIds.join(", ")}`);
      }
    } catch (err) {
      console.error(`[report_precondition_unmet] Error annotating ${self}:`, err.message);
    }
  }

  // Journey log: dossier-only. The derivation trigger is the ticket stamp above
  // (read by the orchestrator), NOT this event.
  await publishJourneyEvent(workflow_id || self, "agent.precondition_unmet", {
    workflowId: workflow_id || null, ticketId: self, awaitingIds, note: noteText, agentId, reportedAt,
  });

  return {
    status: "waiting",
    message: `precondition unmet; awaiting ${awaitingIds.join(", ")}`,
    awaitingIds,
  };
}

// ─── Manifest Updates ──────────────────────────────────────────────────────────

const PHASE_MAP = {
  "agentcore_hub_requirements_analyst": "requirements",
  "agentcore_hub_frontend_designer": "design", "agentcore_hub_ios_designer": "design",
  "agentcore_hub_backend_designer": "design", "agentcore_hub_android_designer": "design",
  "agentcore_hub_security_reviewer": "design", "agentcore_hub_legal_compliance": "design",
  "agentcore_hub_localization": "design", "agentcore_hub_analytics_designer": "design",
  "agentcore_hub_frontend_dev": "development", "agentcore_hub_backend_dev": "development",
  "agentcore_hub_api_dev": "development",
  "agentcore_hub_qa_verifier": "verification", "agentcore_hub_ci_agent": "verification",
  "agentcore_hub_release_manager": "ship",
};

async function updateManifest(workflowId, agentId, entries) {
  if (!workflowId || !entries || entries.length === 0) return;
  const manifestKey = `workflows/${workflowId}/shared/manifest.json`;
  let manifest;
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: manifestKey }));
    manifest = JSON.parse(await result.Body.transformToString());
  } catch {
    manifest = {
      workflowId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phases: { intake: [], requirements: [], design: [], development: [], verification: [], ship: [] },
    };
  }

  const phase = PHASE_MAP[agentId] || "development";
  const now = new Date().toISOString();
  const newEntries = entries.map((e, i) => ({ id: `${phase}-${Date.now().toString(36)}-${i}`, addedAt: now, ...e }));
  manifest.phases[phase] = [...(manifest.phases[phase] || []), ...newEntries];
  manifest.updatedAt = now;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[manifest] Added ${newEntries.length} entries to ${phase} for ${workflowId}`);
}

// ─── S3 Storage tools ──────────────────────────────────────────────────────────
// Folded in from the (no-longer-shipped) agentcore-hub-s3-tools Lambda. Runtime
// agents call these via S3Storage___read_object / write_object / list_objects.

async function s3ReadObject({ bucket, key, encoding }) {
  const targetBucket = bucket || BUCKET;
  if (!targetBucket) throw new Error("bucket is required (no ARTIFACT_BUCKET configured)");
  if (!key) throw new Error("key is required");
  const r = await s3.send(new GetObjectCommand({ Bucket: targetBucket, Key: key }));
  // Binary objects can't survive transformToString (mangles bytes > 0x7F) —
  // callers requesting base64 get the raw bytes back intact.
  if (encoding === "base64") {
    const bytes = await r.Body.transformToByteArray();
    return { status: "ok", bucket: targetBucket, key, encoding: "base64",
      content: Buffer.from(bytes).toString("base64"), content_type: r.ContentType };
  }
  const body = await r.Body.transformToString();
  return { status: "ok", bucket: targetBucket, key, content: body };
}

// Presigned URLs let agents stream files of ANY size and media type straight to
// or from S3 with a plain HTTP PUT/GET — bypassing the ~6MB Lambda-invoke
// payload ceiling that caps the inline base64 write path. Use for large
// video/audio/image assets.
async function s3PresignUrl({ bucket, key, operation, content_type, expires_in }) {
  const targetBucket = bucket || BUCKET;
  if (!targetBucket) throw new Error("bucket is required (no ARTIFACT_BUCKET configured)");
  if (!key) throw new Error("key is required");
  const op = (operation || "put").toLowerCase();
  const cmd = op === "get"
    ? new GetObjectCommand({ Bucket: targetBucket, Key: key })
    : new PutObjectCommand({ Bucket: targetBucket, Key: key, ContentType: content_type || "application/octet-stream" });
  const url = await getSignedUrl(s3, cmd, { expiresIn: Math.min(expires_in || 3600, 86400) });
  return { status: "ok", operation: op, bucket: targetBucket, key, url,
    content_type: content_type || "application/octet-stream",
    hint: op === "put"
      ? "HTTP PUT the raw file bytes to this url; set header Content-Type to match content_type."
      : "HTTP GET this url to download the raw file bytes." };
}

async function s3WriteObject({ bucket, key, content, content_type, encoding }) {
  const targetBucket = bucket || BUCKET;
  if (!targetBucket) throw new Error("bucket is required (no ARTIFACT_BUCKET configured)");
  if (!key) throw new Error("key is required");
  // Binary artifacts (images, PDFs, zips) can't survive as a UTF-8 string — the
  // S3 SDK re-encodes any byte > 0x7F. Agents deliver them base64-encoded with
  // encoding:"base64"; decode back to raw bytes here so the stored object is a
  // real PNG/PDF, not corrupted text.
  const body = encoding === "base64" ? Buffer.from(content || "", "base64") : (content || "");
  await s3.send(new PutObjectCommand({
    Bucket: targetBucket,
    Key: key,
    Body: body,
    ContentType: content_type || "text/plain",
  }));
  return { status: "saved", location: `s3://${targetBucket}/${key}`, bytes: body.length };
}

async function s3ListObjects({ bucket, prefix }) {
  const targetBucket = bucket || BUCKET;
  if (!targetBucket) throw new Error("bucket is required (no ARTIFACT_BUCKET configured)");
  const r = await s3.send(new ListObjectsV2Command({
    Bucket: targetBucket,
    Prefix: prefix || "",
  }));
  const keys = (r.Contents || []).map((o) => ({ key: o.Key, size: o.Size, last_modified: o.LastModified }));
  return { status: "ok", bucket: targetBucket, prefix: prefix || "", count: keys.length, objects: keys };
}

const TOOLS = {
  submit_ticket_plan: submitTicketPlan,
  save_design_doc: saveDesignDoc,
  report_completion: reportCompletion,
  report_precondition_unmet: reportPreconditionUnmet,
  // Full prefixed names (sent by main.py @tool functions)
  "WorkflowOutput___submit_ticket_plan": submitTicketPlan,
  "WorkflowOutput___save_design_doc": saveDesignDoc,
  "WorkflowOutput___report_completion": reportCompletion,
  "WorkflowOutput___report_precondition_unmet": reportPreconditionUnmet,
  // S3 storage tools (folded in from defunct agentcore-hub-s3-tools)
  "S3Storage___read_object": s3ReadObject,
  "S3Storage___write_object": s3WriteObject,
  "S3Storage___list_objects": s3ListObjects,
  "S3Storage___presign_url": s3PresignUrl,
};

/**
 * Infer tool from flat args when gateway doesn't include tool name.
 */
function inferToolFromArgs(args) {
  if (args.requirements && args.tickets) return "submit_ticket_plan";
  if (args.title && args.content && args.agent_id) return "save_design_doc";
  // awaiting_ids is the discriminant for the non-terminal precondition channel —
  // checked BEFORE report_completion so a call carrying both never Dones the ticket.
  if (args.ticket_id && args.awaiting_ids) return "report_precondition_unmet";
  if (args.ticket_id && args.summary) return "report_completion";
  if (args.tickets) return "submit_ticket_plan";
  if (args.content && args.workflow_id) return "save_design_doc";
  return null;
}

export const handler = async (event) => {
  console.log("Workflow output event:", JSON.stringify(event));

  // Method 1: Explicit tool name
  let toolName = event.name || event.tool_name;
  let args = event.arguments || event.input;

  if (toolName && args) {
    console.log(`Routing via explicit name: ${toolName}`);
  } else {
    // Method 2: Gateway flat args
    args = event;
    toolName = inferToolFromArgs(args);
    console.log(`Routing via inference: ${toolName}`);
  }

  if (!toolName || !TOOLS[toolName]) {
    return {
      content: [{
        type: "text",
        text: `Unknown tool: "${toolName}". Available: ${Object.keys(TOOLS).join(", ")}. Keys: ${JSON.stringify(Object.keys(event))}`,
      }],
    };
  }

  try {
    const result = await TOOLS[toolName](args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    console.error(`[workflow-output] Error in ${toolName}:`, err);
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
};
