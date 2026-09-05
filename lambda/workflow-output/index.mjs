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
import { validateTicketPlan } from "./dag.mjs";

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
// TEAM-3992 D3.4: structural validation of a submitted ticket plan against the
// def's ticketDag. enforce → reject an invalid plan (nothing created); shadow →
// accept but report `dagViolations`; off → skip. Default enforce.
const DAG_VALIDATION_MODE = (process.env.DAG_VALIDATION_MODE || "enforce").toLowerCase();
const DEFAULT_WORKFLOW_DEF_ID = "software-delivery";

// config/workflows.json + config/agents.json are the same S3 objects the tickets
// Lambda's loadValidPhases and the orchestrator's loadWorkflowDefs read; cache
// per cold start. A load failure degrades to "no dag" (validation skipped) rather
// than blocking a legitimate plan on an S3 blip.
let _workflowsConfig = null;
async function loadWorkflowsConfig() {
  if (_workflowsConfig) return _workflowsConfig;
  if (!BUCKET) return (_workflowsConfig = { workflows: [] });
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "config/workflows.json" }));
    _workflowsConfig = JSON.parse(await r.Body.transformToString());
  } catch (err) {
    console.warn(`[submit_ticket_plan] could not load config/workflows.json: ${err.message}`);
    _workflowsConfig = { workflows: [] };
  }
  return _workflowsConfig;
}

let _roster = null;
async function loadRoster() {
  if (_roster) return _roster;
  if (!BUCKET) return (_roster = { agents: [] });
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "config/agents.json" }));
    _roster = JSON.parse(await r.Body.transformToString());
  } catch (err) {
    console.warn(`[submit_ticket_plan] could not load config/agents.json: ${err.message}`);
    _roster = { agents: [] };
  }
  return _roster;
}

/**
 * The plan payload is the only reliable def signal submit_ticket_plan receives:
 * the workflows table isn't wired into this Lambda and the S3 manifest doesn't
 * record a def id. A run that names its def (workflow_def_id / def_id) wins;
 * otherwise default to the code pipeline (software-delivery). `workflow_type`
 * ("feature"/"bug") is intentionally NOT treated as a def id — it is a label,
 * not a selector.
 */
function resolveDefId(args) {
  return args.workflow_def_id || args.def_id || DEFAULT_WORKFLOW_DEF_ID;
}

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

async function submitTicketPlan(args) {
  const { workflow_id, requirements, tickets } = args;

  // TEAM-3992 D3.4 — validate the plan's structure against the def's ticketDag
  // BEFORE persisting anything, so an enforced rejection leaves no partial state.
  let dagViolations = null;
  if (DAG_VALIDATION_MODE !== "off") {
    const [cfg, roster] = await Promise.all([loadWorkflowsConfig(), loadRoster()]);
    const defId = resolveDefId(args);
    const dag = (cfg.workflows || []).find((w) => w.id === defId)?.ticketDag;
    if (dag) {
      const result = validateTicketPlan({ tickets }, dag, roster);
      if (!result.ok) {
        if (DAG_VALIDATION_MODE === "enforce") {
          const err = new Error("ticket_plan_invalid");
          err.mcpBody = {
            status: "rejected",
            error: "ticket_plan_invalid",
            violations: result.violations,
            hint: "Fix the plan and resubmit; nothing was created.",
          };
          throw err;
        }
        dagViolations = result.violations; // shadow: report but proceed
      }
    }
  }

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
    ...(dagViolations ? { dagViolations } : {}),
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

/**
 * TEAM-3991 F17 — look up the ticket this report claims to be closing.
 *
 * Reuses the SAME Tickets Lambda invoke the transition below uses, so this works
 * against whichever provider is configured and needs no new IAM or table access.
 * Returns the ticket-ish shape, or `null` when the lookup is unavailable
 * (Lambda unreachable, tool error, ticket absent) — the caller then skips the
 * ownership check rather than blocking a legitimate completion on an infra blip.
 */
async function lookupTicketOwner(ticket_id) {
  try {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({
        tool_name: "Tickets___get_issue",
        parameters: { ticket_id },
      })),
    }));
    const payload = JSON.parse(new TextDecoder().decode(resp.Payload));
    if (!payload || payload.error) return null;
    // The tickets Lambda answers in the Jira issue shape; a "not found" comes back
    // as a plain text result with no fields.
    const assignee = payload.fields?.assignee?.displayName ?? payload.assignee ?? null;
    const status = payload.fields?.status?.name ?? payload.status ?? null;
    if (assignee === null && status === null) return null;
    return { assignee: assignee ? String(assignee) : "", status: status ? String(status) : "" };
  } catch (err) {
    console.warn(`[report_completion] ticket lookup failed for ${ticket_id}: ${err.message}`);
    return null;
  }
}

/**
 * TEAM-3991 F17/F18 — an agent reporting its OWN ticket's completion.
 *
 * Two things were trust-by-default here and are now enforced:
 *
 *  F18 `source` is SERVER-STAMPED as "agent". The completion record is the
 *      evidence a later gate reads, and `source` is what distinguishes an agent's
 *      own deliverable from a human manager's mark-done. A caller that could set
 *      `source: "manager"` could launder its own claim into an operator's
 *      attestation, so the field is overwritten, never merged.
 *
 *  F17 The report must come from the ticket's OWN assignee. Without this, any
 *      agent holding this tool could close ANY ticket in the run — including a
 *      `human:*` review gate, which is precisely the false-green the gate exists
 *      to prevent. Two refusals, both before any write or transition:
 *        - the ticket is assigned to a human → refuse outright;
 *        - `agent_id` is present and differs from the assignee → refuse.
 *      An ABSENT `agent_id` is allowed (older fleet callers omit it) but logged:
 *      it cannot be checked, so it must at least be visible.
 */
/** verification.kind values a verifier may stamp (review/qa/ci gates). */
const VERIFICATION_KINDS = new Set(["review", "qa", "ci"]);
/** verification.verdict values. */
const VERIFICATION_VERDICTS = new Set(["pass", "fail", "blocked"]);
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

/**
 * TEAM-3992 Q4 — validate a caller-supplied `verification` block before it is
 * persisted or turned into a durable record. Returns a NORMALIZED copy (kind /
 * verdict lower-cased, sha lower-cased) or throws a specific error naming the bad
 * field. A malformed block must never be silently dropped — a fix that reports a
 * garbage verification would otherwise look re-verified to the SHA-pinned gate.
 */
function validateVerification(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("verification must be an object");
  }
  const target = typeof v.target_ticket_id === "string" ? v.target_ticket_id.trim() : "";
  if (!target) throw new Error("verification.target_ticket_id is required");
  const kind = typeof v.kind === "string" ? v.kind.trim().toLowerCase() : "";
  if (!VERIFICATION_KINDS.has(kind)) {
    throw new Error(`verification.kind must be one of review|qa|ci (got ${JSON.stringify(v.kind)})`);
  }
  const verdict = typeof v.verdict === "string" ? v.verdict.trim().toLowerCase() : "";
  if (!VERIFICATION_VERDICTS.has(verdict)) {
    throw new Error(`verification.verdict must be one of pass|fail|blocked (got ${JSON.stringify(v.verdict)})`);
  }
  const headSha = typeof v.head_sha === "string" ? v.head_sha.trim().toLowerCase() : "";
  if (!SHA_RE.test(headSha)) {
    throw new Error(`verification.head_sha must be a hex sha of length >= 7 (got ${JSON.stringify(v.head_sha)})`);
  }
  const out = { target_ticket_id: target, head_sha: headSha, kind, verdict };
  if (v.build_id != null) out.build_id = String(v.build_id);
  if (v.evidence_key != null) out.evidence_key = String(v.evidence_key);
  return out;
}

async function reportCompletion({ ticket_id, summary, artifacts = "", branch, commit_sha, pr_url, workflow_id, agent_id, verification, findings }) {
  const owner = await lookupTicketOwner(ticket_id);
  if (!owner) {
    console.warn(`[report_completion] ownership_unverified — could not read ${ticket_id}; proceeding without the assignee check`);
  } else if (owner.assignee.startsWith("human:")) {
    throw new Error(
      `REFUSED: ${ticket_id} is assigned to ${owner.assignee} — a human review gate. ` +
      `Only a human can close it; report_completion cannot. If your work is what the gate is ` +
      `waiting on, say so in a comment and let the reviewer decide.`
    );
  } else if (agent_id && owner.assignee && String(agent_id) !== owner.assignee) {
    throw new Error(
      `REFUSED: ${ticket_id} is assigned to ${owner.assignee}, not ${agent_id}. ` +
      `An agent may only report completion for its OWN ticket — closing someone else's ` +
      `would mark work done that you did not do.`
    );
  } else if (!agent_id) {
    console.warn(`[report_completion] ownership_unverified — no agent_id supplied for ${ticket_id} (assignee ${owner.assignee || "none"}); cannot verify the caller`);
  }

  // TEAM-3992 Q4 — validate the optional verification block BEFORE any write, so
  // a malformed block is a hard rejection (never a half-written record). findings
  // are advisory metadata, persisted as-is when they are an array.
  const verified = verification != null ? validateVerification(verification) : null;
  const findingsList = Array.isArray(findings) ? findings : null;

  const completedAt = new Date().toISOString();
  const key = `completions/${ticket_id}.json`;
  const report = {
    ticket_id,
    summary,
    artifacts,
    branch: branch || null,
    commit_sha: commit_sha || null,
    pr_url: pr_url || null,
    completed_at: completedAt,
    // Server-stamped, LAST, so a caller-supplied `source` cannot survive (F18).
    source: "agent",
    reported_by: agent_id || null,
  };
  if (verified) report.verification = verified;
  if (findingsList) report.findings = findingsList;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(report, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[report_completion] Saved s3://${BUCKET}/${key}`);

  // TEAM-3992 Q4 — durable, SHA-pinned verification record the completion gate
  // reads without racing the agentTasks harvest. Keyed by target ticket + HEAD sha
  // + kind, so re-verifying the same fix at the same SHA is idempotent and a later
  // fix (new SHA) never satisfies an older gate. Requires workflow_id to place it.
  if (verified && workflow_id) {
    const recordKey = `workflows/${workflow_id}/shared/verifications/${verified.target_ticket_id}/${verified.head_sha}.${verified.kind}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: recordKey,
      Body: JSON.stringify(
        {
          ...verified,
          findings: findingsList || undefined,
          verifier_ticket_id: ticket_id,
          reported_by: agent_id || null,
          source: "agent",
          at: completedAt,
        },
        null,
        2
      ),
      ContentType: "application/json",
    }));
    console.log(`[report_completion] Saved verification record s3://${BUCKET}/${recordKey}`);
  } else if (verified && !workflow_id) {
    console.warn(`[report_completion] verification supplied for ${ticket_id} but no workflow_id — durable record NOT written`);
  }

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
  // Full prefixed names (sent by main.py @tool functions)
  "WorkflowOutput___submit_ticket_plan": submitTicketPlan,
  "WorkflowOutput___save_design_doc": saveDesignDoc,
  "WorkflowOutput___report_completion": reportCompletion,
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
    // A structured rejection (e.g. D3.4 ticket_plan_invalid) carries its own MCP
    // body so the agent gets the machine-readable violations, not just a string.
    if (err.mcpBody) {
      return {
        content: [{ type: "text", text: JSON.stringify(err.mcpBody, null, 2) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
};
