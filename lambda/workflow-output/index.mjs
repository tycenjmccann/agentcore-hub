/**
 * Workflow Output Lambda — receives structured work products from agents.
 * Stores to S3, marks tickets done in DynamoDB, and returns a confirmation.
 *
 * Tools: submit_ticket_plan, save_design_doc, report_completion
 */

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
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

// TEAM-4589: no s3Key here — main.py's WorkflowOutput___submit_ticket_plan wrapper
// forwards no `requirements` body at all, so there is no document body to pass by
// reference; `tickets` is a short JSON array the agent has to author anyway.
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

// ─── save_design_doc: pass-by-reference (TEAM-4589) ────────────────────────────
// A design doc used to reach this tool only as an inline `content` string, so an
// agent had to re-emit the whole document as a tool argument — pure output
// tokens. A 97 KB doc killed backend_designer with MaxTokensReachedException
// four times, on a document that was ALREADY in S3. So the doc may now arrive by
// key: the agent writes it once with S3Storage___write_object and passes s3Key,
// and this Lambda reads the bytes itself.

// FOOTGUN GUARD — NOT a security boundary, and NOT an authorization check. Do not
// harden it into one. The calling agent already has bucket-wide read through
// S3Storage___read_object, and this Lambda's role already holds s3:GetObject on
// the whole artifact bucket (deploy/setup-lambda-role.sh, Sid "ObjectRW"), so
// nothing here restricts what an agent can reach. The guard exists only so a
// model that pastes an s3:// URL, a leading-slash path, or a ../ traversal gets a
// legible error naming the shape it should have sent instead of an opaque
// NoSuchKey. A future reader looking for the access-control boundary will not
// find it here — there isn't one at this layer, by design.
function assertPlainWorkflowKey(s3Key) {
  const shape = `expected a plain object key under workflows/ (e.g. "workflows/<workflow_id>/<agent_id>/design.md") - no s3:// URL, no leading "/", no ".." segment`;
  const bad = (why) => new Error(`save_design_doc rejected s3Key "${s3Key}": ${why}. ${shape}.`);
  if (/^s3:\/\//i.test(s3Key)) throw bad("it is an s3:// URL, not an object key");
  if (s3Key.startsWith("/")) throw bad("it starts with \"/\"");
  // Exact-segment test, not a substring test: "workflows/wf_1/a..b.md" is a fine key.
  if (s3Key.split("/").includes("..")) throw bad("it contains a \"..\" path segment");
  if (!s3Key.startsWith("workflows/")) throw bad("it is outside the workflows/ prefix");
}

/**
 * Resolve the document body for save_design_doc — the ONE place the
 * by-reference path lives, so the persist path below stays untouched.
 * Returns { content, sourceKey }; sourceKey is null on the inline path.
 */
async function resolveDesignDocContent({ content, s3Key }) {
  const key = typeof s3Key === "string" ? s3Key.trim() : "";
  const inline = typeof content === "string" ? content : "";

  if (!key) {
    if (!inline.trim()) {
      throw new Error("content or s3Key is required - pass the document inline, or write it to S3 first and pass its key.");
    }
    return { content: inline, sourceKey: null };
  }

  // Validate BEFORE reading anything: a rejected key must not fall back to
  // `content` either, or a typo'd key would silently save the wrong document.
  assertPlainWorkflowKey(key);
  if (inline.trim()) {
    console.warn(`[save_design_doc] both content and s3Key were supplied; s3Key "${key}" takes precedence and the inline content is ignored`);
  }

  let body;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    body = await r.Body.transformToString();
  } catch (err) {
    throw new Error(`save_design_doc could not read s3Key "${key}" from the artifact bucket (${err.name}: ${err.message}) - that object is missing or unreadable, so nothing was saved.`);
  }
  // An empty source is an error, not an empty save. A stranded ticket is
  // recoverable by re-running the agent; a critical:true manifest entry pointing
  // at an empty canonical design doc is not — it silently poisons every
  // downstream reader, which sees a registered ★ design doc and reads nothing.
  if (!body || !body.trim()) {
    throw new Error(`save_design_doc read s3Key "${key}" but it is empty - nothing was saved. Write the document to that key first, then register it.`);
  }
  return { content: body, sourceKey: key };
}

async function saveDesignDoc({ workflow_id, agent_id, title, content, format = "markdown", doc_type, s3Key }) {
  // Resolve the body BEFORE anything below reads or writes: on the by-reference
  // path a bad key must leave the bucket exactly as it was. Everything after
  // this line is the pre-4589 persist path, unchanged and shared by both paths.
  const source = await resolveDesignDocContent({ content, s3Key });
  content = source.content;

  // `format` decides ext + ContentType — never the source key's extension: a doc
  // staged as spec.json is still registered as the markdown the caller declared.
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
    // TEAM-4589: only on the by-reference path, so an inline save's response keeps
    // exactly its pre-4589 key set.
    ...(source.sourceKey ? { source_s3_key: source.sourceKey } : {}),
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

// DL-024 / ship verdict — the release manager's CD ticket reports how the run
// ended. The orchestrator's completion evidence harvest already reads these
// three keys from the record (completion.mjs SHIP_BLOCKED_OUTCOMES); this is the
// writer side. Same drop-rather-than-store rule as CI_STATUSES.
const SHIP_OUTCOMES = ["shipped", "deploy-blocked", "static-ci-only", "handoff"];
const BLOCK_REASON_MAX_LEN = 500;

// ─── DL-030 ship-report contract (TEAM-4706) ──────────────────────────────────
// A ship report is a claim that production changed, and this tool used to take
// that claim entirely on trust: `outcome:"shipped"` with no merge commit and no
// deploy execution recorded still wrote the record and closed the ticket, so a
// run that never reached CD was indistinguishable from one that shipped. So a
// `shipped` report must now NAME what it shipped (merge_commit) and, on the
// pipeline path, the CodePipeline execution that shipped it; a `handoff` must
// name the PR it handed off. A report that cannot is REFUSED as a value — see
// shipContractRefusal below.
const PIPELINE_EXECUTION_ID_RE = /^[0-9a-f-]{36}$/;

// Still in SHIP_OUTCOMES, still accepted, still transition the ticket. DL-030
// only deprecates them in the log so a blueprint that keeps emitting one is
// visible; removing them would break existing records and the orchestrator's
// evidence harvest (completion.mjs SHIP_BLOCKED_OUTCOMES), which reads them.
const DEPRECATED_SHIP_OUTCOMES = ["deploy-blocked", "static-ci-only"];

const CD_LEDGER_PRESENT = "present";
const CD_LEDGER_ABSENT = "absent";
const CD_LEDGER_INDETERMINATE = "indeterminate";

/**
 * Probe workflows/<workflow_id>/shared/cd-ledger.json — the record the release
 * manager blueprint writes the moment Pipeline___start_deploy returns.
 *
 * THREE outcomes, never two, for the DL-028 reason (docs/architecture.md, "the
 * licence to proceed must be positive evidence"): "no ledger" has to mean *we
 * looked and S3 said 404*, never *we did not manage to find one*. AccessDenied,
 * a throttle, a connect timeout, an unset ARTIFACT_BUCKET and a call carrying no
 * workflow_id are all INDETERMINATE, and indeterminate keeps the execution id
 * REQUIRED — refusing is cheap and recoverable (the agent files a human gate
 * ticket), whereas accepting silently claims a deploy that may not exist.
 *
 * No IAM change: this Lambda's role already holds s3:GetObject on the whole
 * artifact bucket (deploy/setup-lambda-role.sh, Sid "ObjectRW").
 */
async function probeCdLedger(workflowId) {
  if (!BUCKET || !workflowId) {
    console.warn(`[report_completion] cd-ledger probe not attempted (${BUCKET ? "no workflow_id on the call" : "no ARTIFACT_BUCKET configured"}) - indeterminate`);
    return CD_LEDGER_INDETERMINATE;
  }
  const key = `workflows/${workflowId}/shared/cd-ledger.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return CD_LEDGER_PRESENT;
  } catch (err) {
    // A definite not-found is the ONLY positive evidence of "this run never
    // started a pipeline deploy". Everything else is a failed look.
    if (err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return CD_LEDGER_ABSENT;
    }
    console.warn(`[report_completion] cd-ledger probe for ${key} was indeterminate (${err?.name || "Error"}: ${err?.message || "no message"}) - the pipeline execution id stays required`);
    return CD_LEDGER_INDETERMINATE;
  }
}

/**
 * The gate. Returns a refusal VALUE (never throws) when the report may not be
 * written, or null when it may.
 *
 * Deliberately not "is this repo CD-registered?": this Lambda has no repo on the
 * wire, no CD-registry access and no workflows-table read, so it cannot know. It
 * asks the question it CAN answer instead:
 *   - merge_commit is required for EVERY `shipped`, no exceptions;
 *   - pipeline_execution_id is additionally required UNLESS the run is *provably*
 *     the legacy DEPLOY.md ship path, which means BOTH (a) no pipeline_name
 *     argument was passed AND (b) a definite 404 on the cd-ledger.
 */
async function shipContractRefusal(report, { pipelineName, workflowId }) {
  const outcome = report.outcome;
  const prUrl = typeof report.pr_url === "string" ? report.pr_url.trim() : "";

  if (outcome === "handoff" && !prUrl) {
    return {
      ok: false,
      reason: "handoff_requires_pr_url",
      missing: ["pr_url"],
      message: `outcome "handoff" was refused: a handoff is only real once the PR the owning team will review exists. Open the PR, then call report_completion again with pr_url set. Nothing was recorded and the ticket was NOT transitioned.`,
    };
  }
  if (outcome !== "shipped") return null;

  const missing = [];
  if (!report.merge_commit) missing.push("merge_commit");
  if (!report.pipeline_execution_id) {
    const named = typeof pipelineName === "string" && pipelineName.trim() !== "";
    const ledger = named ? null : await probeCdLedger(workflowId);
    if (!named && ledger === CD_LEDGER_ABSENT) {
      console.log(`[report_completion] ${report.ticket_id}: "shipped" with no pipeline_execution_id ACCEPTED as the legacy DEPLOY.md path - no pipeline_name argument and cd-ledger.json is definitively absent for ${workflowId || "(no workflow_id)"}`);
    } else {
      missing.push("pipeline_execution_id");
      console.warn(`[report_completion] ${report.ticket_id}: pipeline_execution_id is REQUIRED (${named ? "pipeline_name was supplied, so this run used the pipeline path" : `cd-ledger probe result: ${ledger}`})`);
    }
  }
  if (missing.length === 0) return null;

  return {
    ok: false,
    reason: "shipped_requires_execution_and_merge_commit",
    missing,
    message: `outcome "shipped" was refused: missing ${missing.join(" and ")}. A shipped report must name the merge commit, and the CodePipeline execution that deployed it whenever this run used the pipeline path. If the deploy genuinely did not happen, do NOT report "shipped" - file a human deploy-gate ticket and report the outcome that is true. Nothing was recorded and the ticket was NOT transitioned.`,
  };
}

async function reportCompletion({ ticket_id, summary, artifacts = "", branch, commit_sha, pr_url, workflow_id, agent_id, evidence_kind, evidence_keys, ci_status, ci_build_id, ci_head_sha, merge_commit, approved_head_sha, outcome, block_reason, pipeline_execution_id, pipeline_name }) {
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

  // DL-024 ship verdict: additive-only, closed vocabulary.
  const mergeCommit = typeof merge_commit === "string" ? merge_commit.trim() : "";
  if (mergeCommit && mergeCommit.length <= CI_FIELD_MAX_LEN) report.merge_commit = mergeCommit;
  else if (mergeCommit) console.warn(`[report_completion] dropping oversized merge_commit (${mergeCommit.length} chars)`);
  // TEAM-4525: `approved_head_sha` = the PR head SHA a human approved at the
  // Merge Approval gate, recorded so a ship run's single human approval is
  // auditable. Same additive drop-rather-than-store rule as merge_commit, plus a
  // shape check — only a full 40-hex git SHA is stored, lowercased.
  const approvedHeadSha = typeof approved_head_sha === "string" ? approved_head_sha.trim() : "";
  if (approvedHeadSha && approvedHeadSha.length <= CI_FIELD_MAX_LEN && /^[0-9a-f]{40}$/i.test(approvedHeadSha)) {
    report.approved_head_sha = approvedHeadSha.toLowerCase();
  } else if (approvedHeadSha) {
    console.warn(`[report_completion] dropping malformed approved_head_sha (${approvedHeadSha.length} chars; expected a 40-hex git SHA)`);
  }
  // TEAM-4706: the deploy the ship report is claiming. Same additive
  // drop-rather-than-store rule as merge_commit above, plus a shape check on the
  // id — a mangled execution id is worse than none, because it reads as proof of
  // a deploy nobody can look up. Lowercased before the test so an upper-case
  // UUID normalises rather than being thrown away.
  const pipelineExecutionId = typeof pipeline_execution_id === "string" ? pipeline_execution_id.trim().toLowerCase() : "";
  if (pipelineExecutionId && pipelineExecutionId.length <= CI_FIELD_MAX_LEN && PIPELINE_EXECUTION_ID_RE.test(pipelineExecutionId)) {
    report.pipeline_execution_id = pipelineExecutionId;
  } else if (pipelineExecutionId) {
    console.warn(`[report_completion] dropping malformed pipeline_execution_id (${pipelineExecutionId.length} chars; expected a 36-char CodePipeline execution id matching ${PIPELINE_EXECUTION_ID_RE})`);
  }
  const pipelineName = typeof pipeline_name === "string" ? pipeline_name.trim() : "";
  if (pipelineName && pipelineName.length <= CI_FIELD_MAX_LEN) report.pipeline_name = pipelineName;
  else if (pipelineName) console.warn(`[report_completion] dropping oversized pipeline_name (${pipelineName.length} chars)`);

  const shipOutcome = typeof outcome === "string" ? outcome.trim().toLowerCase() : "";
  if (shipOutcome) {
    if (SHIP_OUTCOMES.includes(shipOutcome)) {
      report.outcome = shipOutcome;
      // Accepted, transitions as before — logged only so a blueprint still
      // emitting a DL-030-deprecated verdict is visible in CloudWatch.
      if (DEPRECATED_SHIP_OUTCOMES.includes(shipOutcome)) {
        console.warn(`[report_completion] DEPRECATED outcome ${shipOutcome} (DL-030)`);
      }
    } else console.warn(`[report_completion] dropping unknown outcome "${shipOutcome}" (expected ${SHIP_OUTCOMES.join("|")})`);
  }
  const blockReason = typeof block_reason === "string" ? block_reason.trim() : "";
  if (blockReason) report.block_reason = blockReason.slice(0, BLOCK_REASON_MAX_LEN);

  // DL-030 gate — BEFORE the S3 write, the journey event and the Done
  // transition, so a refused report leaves no trace of a completion that did not
  // happen. Refusals are returned, not thrown: the handler JSON-stringifies this
  // object into the tool result, so the agent reads a legible reason instead of
  // an "Error: ..." string it cannot act on. Note the gate reads `report.*`, so
  // a field that was dropped above (a malformed pipeline_execution_id) counts as
  // missing here — which is the point.
  const refusal = await shipContractRefusal(report, { pipelineName, workflowId: workflow_id });
  if (refusal) {
    console.warn(`[report_completion] REFUSED ${ticket_id}: ${refusal.reason} (missing ${refusal.missing.join(", ")}) - no record written, ticket not transitioned`);
    return refusal;
  }

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
 * Exported for unit tests: routing is pure, and driving it through handler()
 * with a flat event would run the persist path just to observe a route.
 */
export function inferToolFromArgs(args) {
  if (args.requirements && args.tickets) return "submit_ticket_plan";
  if (args.title && args.content && args.agent_id) return "save_design_doc";
  if (args.ticket_id && args.summary) return "report_completion";
  if (args.tickets) return "submit_ticket_plan";
  if (args.content && args.workflow_id) return "save_design_doc";
  // TEAM-4589: a by-reference save carries no `content` at all, so the rule above
  // can never match it. `s3Key` appears in no other tool's argument set, so this
  // leaves every rule before it with exactly its previous outcome.
  if (args.s3Key && args.workflow_id) return "save_design_doc";
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
