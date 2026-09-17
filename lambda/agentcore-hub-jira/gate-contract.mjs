/**
 * gate-contract.mjs — the shared GATE contract for the two ticket Lambdas
 * (TEAM-4739).
 *
 * A "gate ticket" is one whose close asserts something about the world OUTSIDE
 * the pipeline: a human approved a production deploy, CI has no build for a SHA,
 * a blocker is gone. Historically nothing checked the assertion — a persona could
 * transition such a ticket `→ done` from memory, and the cascade would dispatch
 * downstream work over a gate nobody had proven. This module is the read side of
 * that check: the label grammar that binds a gate ticket to its evidence, the
 * probe that fetches the evidence, and the pure verdicts computed from it.
 *
 * ── Scope: the TWINS only ───────────────────────────────────────────────────
 * This is NOT an orchestrator module. It lives in lambda/agentcore-hub-tickets/
 * and lambda/agentcore-hub-jira/ only, it is not on lambda/orchestrator/deploy.sh's
 * zip line, and it is not counted against the DL-009 orchestrator budgets
 * (scripts/check-orchestrator-surface.sh). The orchestrator's half of the gate
 * vocabulary — GATE_KINDS / GATE_LABEL_RE / gateKindsOf — lives in fix-contract.mjs,
 * which all three Lambdas already carry; this module imports it from there rather
 * than re-deriving the grammar, because two spellings of the gate-kind list is
 * exactly the silent drift the parity guards exist to prevent.
 *
 * ── TWO byte-identical copies ───────────────────────────────────────────────
 * Each ticket Lambda ships as a self-contained single-directory zip, so the two
 * cannot share a file; the module is duplicated byte-for-byte and CI compares the
 * copies (scripts/check-fix-kinds-parity.sh §1b, plus the behavioural matrix in
 * src/lib/workflow/gate-contract-parity.test.ts).
 * EDIT THE TICKETS COPY, THEN: cp lambda/agentcore-hub-tickets/gate-contract.mjs \
 *                                lambda/agentcore-hub-jira/gate-contract.mjs
 * Unlike fix-contract.mjs this module is NOT import-free: it does I/O, so it
 * imports @aws-sdk/* (resolved from the nodejs20.x runtime — neither zip carries
 * node_modules) and the gate-kind grammar from ./fix-contract.mjs, which both
 * zips already pack. Nothing else.
 *
 * ── The fail direction (do not "fix" this to be stricter) ───────────────────
 * Everything here answers ONE question: "may this gate ticket close?" Its
 * dangerous failure mode is an UNLIFTABLE STALL — there is no escalation rung
 * above the human, so a gate the system refuses to let anyone close wedges the run
 * forever. So a caller may refuse only on a DEFINITE NEGATIVE: a *successful*
 * probe read whose content contradicts the close. Anything indeterminate — the
 * invoke threw, the timeout fired, the payload did not parse, the tool was not on
 * the allow-list — must ADMIT and be recorded as `gateVerification:"indeterminate"`.
 * That is why invokeProbe NEVER throws and never returns a verdict of its own: it
 * returns `{ok:true, result}` or `{ok:false, indeterminate:true, error}`, and the
 * `ok:false` branch is always an admit.
 *
 * DL-028 is a DIFFERENT question — "may I deploy?" — where the dangerous failure
 * is an unapproved production change and positive evidence is mandatory. That rule
 * is untouched here, and nothing in this module can approve a deploy: PROBE_TOOLS
 * is a read-only allow-list and the pipeline-tools Lambda has no approval call at
 * all.
 *
 * ── Why journey events written here carry a ttl ─────────────────────────────
 * lambda/workflow-output/index.mjs writes journey events with NO ttl, so the rows
 * this module writes are the first expiring ones in agentcore-hub-events (the
 * table's TTL attribute is `ttl`, enabled at create time by
 * scripts/create-dynamodb-tables.sh). The window must outlive every consumer's
 * reporting horizon: cost-report reads a run's events at report time, and the
 * Workflow tab replays a finished run's journey. 90 days is comfortably past both
 * and keeps a gate's paging history auditable for a full quarter.
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { GATE_KINDS, gateKindsOf } from "./fix-contract.mjs";

// ── Label grammar ───────────────────────────────────────────────────────────
// Labels arrive in two spellings and must read identically: agents write the
// canonical colon form, and the twins' sanitizeUserLabels rewrites
// [^a-z0-9._-] → "-", so the SAME gate can be stored as `head-<sha>` /
// `exec-<uuid>` / `gate-merge-approval`. Same `[:-]` rule as the Telegram
// bridge's parseDeployApprovalLabels and fix-contract.mjs's GATE_LABEL_RE.
export const HEAD_LABEL_RE = /^head[:-]([0-9a-f]{40})$/i;
export const EXEC_LABEL_RE = /^exec[:-]([0-9a-f-]{36})$/i;
export const MERGE_GATE_LABEL_RE = /^gate[:-]merge-approval$/;

function labelList(labels) {
  const list = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  return list.map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean);
}

function firstCapture(labels, re) {
  for (const l of labelList(labels)) {
    const m = re.exec(l);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** The commit SHA a gate ticket is bound to, from `head:<40hex>`. */
export function gateHeadOf(labels) {
  return firstCapture(labels, HEAD_LABEL_RE);
}

/** The pipeline execution a gate ticket is bound to, from `exec:<uuid>`. */
export function gateExecOf(labels) {
  return firstCapture(labels, EXEC_LABEL_RE);
}

// ── DECISION lines ──────────────────────────────────────────────────────────
// The options a human (or an agent acting on a human's instruction) can record on
// a gate ticket to lift an environmental stall. A DECISION is ADVISORY: it can
// admit a close that would otherwise stall, and it can NEVER manufacture
// "verified" — the caller records `indeterminate` with sub-reason
// `decision_advisory`.
export const FIX_DECISIONS = ["repaired", "accept-proxy", "abort"];

// Same grammar as lambda/orchestrator/review-cap.mjs parseDecision (the LAST line
// that is nothing but `DECISION: <option>`, markdown noise tolerated), with two
// deliberate divergences:
//   - review-cap's leading class is `[\s>*-]*`, which tolerates a BLOCKQUOTED
//     decision on purpose (a human replying inline in Jira). Here a quoted line is
//     usually the OPTIONS being repeated back, or text quoted from somewhere else,
//     so `>` is not in the class and a quoted DECISION does not count;
//   - lines inside a fenced ``` / ~~~ block are skipped entirely, for the same
//     reason: a fenced DECISION is documentation of the syntax, not a use of it.
const DECISION_LINE_RE =
  /^[\s*-]*(?:\*\*)?\s*decision\s*:\s*([a-z][a-z-]*)\s*(?:\*\*)?\s*\.?\s*$/i;
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * The DECISION recorded in a gate ticket's description, or null.
 * Fail-closed: only an explicit, well-formed, unquoted, unfenced line counts.
 * @returns {"repaired"|"accept-proxy"|"abort"|null}
 */
export function parseFixDecision(text) {
  let fenced = false;
  let found = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = DECISION_LINE_RE.exec(raw);
    if (!m) continue;
    const candidate = m[1].toLowerCase();
    if (FIX_DECISIONS.includes(candidate)) found = candidate; // last one wins
  }
  return found;
}

// ── Journey events ──────────────────────────────────────────────────────────
export const JOURNEY_EVENT_TTL_SEC = 90 * 24 * 60 * 60; // 90 days — see header

/**
 * Append one event to a run's journey. Port of lambda/workflow-output/index.mjs's
 * publishJourneyEvent, plus the `ttl` the header explains.
 *
 * Best-effort exactly like its model: it NEVER throws into the caller, because a
 * gate refusal that is correct must not become a tool error just because the
 * events table was unavailable. Returns whether the row was written, so a caller
 * can log the miss.
 *
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} table  EVENTS_TABLE (absent env ⇒ no-op)
 * @param {string} workflowId  MUST come from the ticket/epic row, never from a
 *   caller-supplied argument (SEC-16): a persona must not choose which run's
 *   journey its event lands in.
 */
export async function publishJourneyEvent(ddb, table, workflowId, type, detail) {
  if (!ddb || !table || !workflowId || !type) return false;
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          workflowId,
          eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type,
          detail,
          timestamp: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + JOURNEY_EVENT_TTL_SEC,
        },
      })
    );
    return true;
  } catch {
    return false; /* non-fatal */
  }
}

// ── The console deep link ───────────────────────────────────────────────────
/**
 * The CodePipeline console URL a refusal points the human at.
 *
 * `stage`/`action` are accepted so a caller can pass the probe's `waitingOn`
 * straight through, but they do not appear in the URL: the console has no
 * per-action deep link. Name them in the comment body instead.
 *
 * @returns {string} the URL, or "" when the ticket is not bound to a pipeline.
 */
export function consoleApprovalUrl({ pipeline, region } = {}, _waitingOn = {}) {
  const name = String(pipeline || "").trim();
  if (!name) return "";
  const r = String(region || process.env.AWS_REGION || "us-east-1").trim();
  return (
    "https://console.aws.amazon.com/codesuite/codepipeline/pipelines/" +
    `${encodeURIComponent(name)}/view?region=${encodeURIComponent(r)}`
  );
}

// ── The probe ───────────────────────────────────────────────────────────────
// A READ-ONLY allow-list, enforced before an InvokeCommand is even constructed
// (SEC-3). The twins forward a tool name that came from a gate ticket's labels;
// without this, the same seam would be a general-purpose "invoke any tool on the
// pipeline Lambda" primitive reachable from ticket data. Deliberately no
// deploy/approve tool: nothing in the ticket path may trigger or approve CD.
export const PROBE_TOOLS = [
  "Pipeline___get_state",
  "Pipeline___get_build_status",
  "Pipeline___capabilities",
];

export const PROBE_TIMEOUT_MS = 4000;

let probeLambda = null;

/**
 * Invoke one read-only pipeline tool and return its parsed result.
 *
 * NEVER THROWS and never retries: the whole body is inside one try/catch, so an
 * SDK throw, the 4s abort, a Lambda FunctionError, a non-JSON payload and a
 * disallowed tool all come back as `{ok:false, indeterminate:true, error}`. That
 * totality is what makes the callers' admit-on-indeterminate rule total (header).
 *
 * The tools Lambda answers with the MCP envelope
 * `{content:[{type:"text", text: JSON.stringify(obj)}]}`, so the payload needs a
 * DOUBLE parse; a shape that does not double-parse is indeterminate, never a
 * verdict.
 *
 * @param {string} fnName  PIPELINE_TOOLS_LAMBDA (absent env ⇒ indeterminate)
 * @param {string} tool  one of PROBE_TOOLS
 * @param {Record<string, unknown>} args  the tool's parameters
 * @returns {Promise<{ok:true, result:any}|{ok:false, indeterminate:true, error:string}>}
 */
export async function invokeProbe(fnName, tool, args) {
  if (!PROBE_TOOLS.includes(tool)) {
    return { ok: false, indeterminate: true, error: "tool_not_allowed" };
  }
  if (!fnName) return { ok: false, indeterminate: true, error: "probe_not_configured" };
  try {
    if (!probeLambda) {
      // maxAttempts: 1 == one attempt, zero retries. A gate close must not sit
      // behind the SDK's default backoff; an unreachable probe is an admit.
      probeLambda = new LambdaClient({
        region: process.env.AWS_REGION || "us-east-1",
        maxAttempts: 1,
      });
    }
    const res = await probeLambda.send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ tool_name: tool, parameters: args || {} })),
      }),
      { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
    );
    if (res.FunctionError) {
      return { ok: false, indeterminate: true, error: `function_error:${res.FunctionError}` };
    }
    const raw = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
    const envelope = JSON.parse(raw);
    const text = envelope?.content?.[0]?.text;
    if (typeof text !== "string") {
      return { ok: false, indeterminate: true, error: "probe_payload_shape" };
    }
    return { ok: true, result: JSON.parse(text) };
  } catch (err) {
    const name = err?.name || err?.code || "";
    return { ok: false, indeterminate: true, error: String(name || err?.message || err) };
  }
}

// ── The gate-loop verdict ───────────────────────────────────────────────────
// Priors needed before a re-file is a loop: two already exist, so the THIRD
// attempt refuses.
export const GATE_LOOP_THRESHOLD = 2;

function idList(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Is this new gate ticket the third of its kind against the same target?
 *
 * PURE, and the reason the verdict lives here rather than in either twin: the two
 * providers cannot gather siblings the same way (the DynamoDB twin queries
 * parentId-index; the jira twin must ask for `issuelinks` explicitly, since
 * listTickets does not request that field and so returns no `blockedBy` at all),
 * but they MUST refuse identically. Each twin gathers in its own idiom and hands
 * the rows here.
 *
 * @param {Array<{id?:string, key?:string, labels?:string[]|string, blockedBy?:string[]|string}>} siblings
 *   the epic's other children
 * @param {{gateKind?:string, blockedBy?:string[]|string, head?:string}} opts  the
 *   NEW ticket's gate kind and target
 * @returns {{loop:boolean, priorCount:number, priors:string[], reason:string|null}}
 */
export function gateLoopVerdict(siblings, opts = {}) {
  const gateKind = String(opts.gateKind || "").trim().toLowerCase();
  const blockedBy = idList(opts.blockedBy);
  const head = String(opts.head || "").trim().toLowerCase();
  const out = { loop: false, priorCount: 0, priors: [], reason: null };
  if (!GATE_KINDS.includes(gateKind)) return out;

  for (const s of Array.isArray(siblings) ? siblings : []) {
    if (!s) continue;
    if (!gateKindsOf(s.labels).includes(gateKind)) continue;
    // Same TARGET, read three ways because not every gate has every binding:
    // the same head SHA, an overlapping blocked_by set, or — when neither side
    // carries any binding at all — the kind alone under one epic.
    const sib = idList(s.blockedBy);
    const sameHead = Boolean(head) && gateHeadOf(s.labels) === head;
    const sharesTarget = blockedBy.length > 0 && sib.some((b) => blockedBy.includes(b));
    const untargeted = !head && blockedBy.length === 0 && sib.length === 0;
    if (!sameHead && !sharesTarget && !untargeted) continue;
    out.priors.push(String(s.id || s.key || s.ticketId || ""));
  }

  out.priorCount = out.priors.length;
  out.loop = out.priorCount >= GATE_LOOP_THRESHOLD;
  out.reason = out.loop ? "gate_loop_environmental" : null;
  return out;
}
