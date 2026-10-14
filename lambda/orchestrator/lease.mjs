/**
 * Invocation leases — orchestrator (Lambda) port of src/lib/workflow/lease.ts.
 *
 * TEAM-3618: hand-port of isLeaseLive / lastAgentActivity / stealClaim with
 * IDENTICAL semantics to the app-side module (R3 of docs/race-condition-study.md
 * — never re-implement lease semantics). The parity contract test
 * (src/lib/workflow/lease-parity.test.ts) feeds identical fixtures through both
 * copies of isLeaseLive and asserts identical booleans.
 *
 * Both copies read the SAME constants file (src/config/lease-constants.json) —
 * one source of truth, no forked values. In the repo it lives two directories
 * up; the orchestrator deploy zip (deploy.sh) copies it in beside this module,
 * so the deployed copy is preferred and the repo path is the fallback.
 */

import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadLeaseConstants() {
  const candidates = ["./lease-constants.json", "../../src/config/lease-constants.json"];
  let lastErr;
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(HERE, rel), "utf8"));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`lease-constants.json not found (tried ${candidates.join(", ")}): ${lastErr?.message}`);
}

const { defaultTtlMinutes, staleClaimMultiplier, heartbeatEventTypes, liveClaimStatuses } = loadLeaseConstants();
const [HEARTBEAT_TYPE_1, HEARTBEAT_TYPE_2] = heartbeatEventTypes;

// Re-exported for the orchestrator's claim-stale escape hatch
// (index.mjs claimTicketInvocation), so it reads the same knob + multiple as
// the lease-aware endpoints instead of re-hardcoding them.
export const DEFAULT_TTL_MINUTES = defaultTtlMinutes;
export const STALE_CLAIM_MULTIPLIER = staleClaimMultiplier;

/** A nonnumeric/zero/negative env value must not silently disable leases. */
function resolveTtlMs() {
  const minutes = Number(process.env.WORKFLOW_LEASE_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultTtlMinutes) * 60_000;
}

export const LEASE_TTL_MS = resolveTtlMs();

/**
 * Pure liveness check. A claim is live when it is running AND the newer of
 * (claim start, last observed agent activity) is within the TTL.
 */
export function isLeaseLive(task, lastActivityIso, nowMs, ttlMs = LEASE_TTL_MS) {
  if (!task) return false;
  if (!task.status || !liveClaimStatuses.includes(task.status)) return false;
  const started = task.startedAt ? Date.parse(task.startedAt) : 0;
  const lastActivity = lastActivityIso ? Date.parse(lastActivityIso) : 0;
  const freshest = Math.max(started, lastActivity);
  if (!freshest) return false; // no start, no activity — nothing to protect
  return nowMs - freshest < ttlMs;
}

/**
 * A recent work event this agent published for this workflow (its heartbeat).
 * Only agent.streaming/agent.started prove ongoing work — terminal events
 * (agent.error, agent.retry, workflow.*) must not renew a lease, or a crash
 * report would block recovery for a full TTL.
 * Paginates the partition with a server-side filter (heartbeat type + agentId
 * + inside the lease window) — a busy sibling agent flooding the event stream
 * can no longer push a live heartbeat past a fixed page size. The sort key is
 * eventId whose format differs per writer, so the window bound lives in the
 * filter, not the key condition; any in-window heartbeat proves liveness, so
 * the first match suffices.
 *
 * `ticketId`: when given, events stamped with a DIFFERENT ticketId are
 * ignored; unstamped events still count (older runtimes don't stamp — err on
 * protecting a possibly-live agent).
 */
export async function lastAgentActivity(ddb, eventsTable, workflowId, agentId, ticketId, ttlMs = LEASE_TTL_MS) {
  const windowStart = new Date(Date.now() - ttlMs).toISOString();
  let lastKey;
  // 20 pages × 500 scanned items bounds the read on pathological partitions
  // while covering hours of the busiest observed event volume.
  for (let page = 0; page < 20; page++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: eventsTable,
        KeyConditionExpression: "workflowId = :w",
        FilterExpression: "#t IN (:hb1, :hb2) AND detail.agentId = :aid AND #ts >= :cutoff",
        ExpressionAttributeNames: { "#t": "type", "#ts": "timestamp" },
        ExpressionAttributeValues: {
          ":w": workflowId,
          ":hb1": HEARTBEAT_TYPE_1,
          ":hb2": HEARTBEAT_TYPE_2,
          ":aid": agentId,
          ":cutoff": windowStart,
        },
        ScanIndexForward: false,
        Limit: 500,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const e of res.Items || []) {
      const detail = e.detail || {};
      if (ticketId && detail.ticketId && detail.ticketId !== ticketId) continue;
      if (typeof e.timestamp === "string") return e.timestamp;
    }
    lastKey = res.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return null;
}

/**
 * TEAM-4120 FR-3 — the dead agent's LAST WORDS, newest-first-collected and
 * returned oldest-first. READ-ONLY (check-workflow-writes.sh allows exactly one
 * write in this module, stealClaim); it lives here rather than in the escalation
 * module so every events-table query keeps ONE shape and one paging bound.
 *
 * Same QueryCommand shape as lastAgentActivity: partition on workflowId, newest
 * first, ≤20 pages × 500. Selects `agent.streaming` frames whose payload type is
 * text or reasoning (the streamed model output; tool frames are noise for a
 * human page). ticketId is honored the same way as in lastAgentActivity — an
 * event stamped with a DIFFERENT ticketId is skipped, an unstamped one counts.
 *
 * Returns the RAW joined string: redaction + clipping belong to the caller,
 * which must join FIRST so a secret split across two chunks still matches.
 *
 * TEAM-4739: `{withTimestamp:true}` returns `{text, at}` instead, where `at` is
 * the NEWEST matching frame's timestamp - the read-shape a liveness check needs
 * (how long since this agent last said anything), which the joined string alone
 * cannot answer. Every existing caller keeps the bare-string shape.
 */
export async function lastStreamedText(ddb, eventsTable, workflowId, agentId, ticketId, maxChars = 600, { withTimestamp = false } = {}) {
  const chunks = [];
  let at = "";
  let collected = 0;
  let lastKey;
  for (let page = 0; page < 20 && collected < maxChars; page++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: eventsTable,
        KeyConditionExpression: "workflowId = :w",
        FilterExpression: "#t = :streaming AND detail.agentId = :aid AND detail.#dt IN (:text, :reasoning)",
        ExpressionAttributeNames: { "#t": "type", "#dt": "type" },
        ExpressionAttributeValues: {
          ":w": workflowId,
          ":streaming": "agent.streaming",
          ":aid": agentId,
          ":text": "text",
          ":reasoning": "reasoning",
        },
        ScanIndexForward: false,
        Limit: 500,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const e of res.Items || []) {
      const detail = e.detail || {};
      if (ticketId && detail.ticketId && detail.ticketId !== ticketId) continue;
      const content = detail.content;
      if (typeof content !== "string" || !content) continue;
      chunks.push(content);
      if (!at) at = e.timestamp || ""; // newest-first, so the first match is the latest
      collected += content.length;
      if (collected >= maxChars) break;
    }
    lastKey = res.LastEvaluatedKey;
    if (!lastKey) break;
  }
  const text = chunks.reverse().join("");
  return withTimestamp ? { text, at } : text;
}

/**
 * TEAM-4120 FR-3 — did the AGENT report a real failure on this ticket since the
 * claim started? READ-ONLY. `dead_session` is excluded because that reason is
 * the detector's own death announcement: counting it would make every dead
 * session look like a self-reported agent error and suppress synthesis for all
 * of them.
 *
 * TEAM-4739: `{types}` widens WHICH event types count, defaulting to today's
 * single `agent.error` so every existing call is unchanged. The `dead_session`
 * exclusion stays scoped to `agent.error` alone - `agent.died` (FR-7) is the
 * runtime's own positive proof that a turn stopped being given time, so applying
 * the detector's-own-announcement filter to it would hide the exact row a
 * positive-death caller asked for.
 *
 * TEAM-5784: `{claimGeneration}` is an opt-in fence on the `agent.died` arm
 * only — a stale fail-closed park (TEAM-5716's claim fence) can be refused
 * AFTER the ticket is re-claimed, so its death row lands with a timestamp
 * past the NEW claim's startedAt and would otherwise be read as that new
 * claim's own death. When passed, only an agent.died row with no
 * `detail.claimStartedAt` (a legacy/older-harness death — read as before) or
 * one whose `claimStartedAt` equals this exact generation counts; a death
 * stamped with a DIFFERENT generation is filtered out server-side. Omitted
 * (the default), every existing call — `agent.error`, or `agent.died`
 * without this option — is byte-identical to before.
 *
 * TEAM-5977: two more opt-ins, also on the `agent.died` arm only and in the
 * same FilterExpression. `strictGeneration` drops the legacy allowance (the
 * row MUST be stamped with `claimGeneration`; without one the arm matches
 * nothing), and `reason` requires `detail.reason` to equal it.
 */
export async function hasAgentErrorSince(ddb, eventsTable, workflowId, ticketId, sinceIso, { types = ["agent.error"], claimGeneration, strictGeneration = false, reason } = {}) {
  if (!sinceIso) return false;
  const vals = { ":w": workflowId, ":tid": ticketId, ":since": sinceIso };
  const ors = [];
  if (types.includes("agent.error")) {
    vals[":err"] = "agent.error";
    vals[":dead"] = "dead_session";
    ors.push("(#t = :err AND (attribute_not_exists(detail.reason) OR detail.reason <> :dead))");
  }
  if (types.includes("agent.died") && (claimGeneration || !strictGeneration)) {
    vals[":died"] = "agent.died";
    let arm = "#t = :died";
    if (claimGeneration) {
      vals[":gen"] = claimGeneration;
      arm += strictGeneration
        ? " AND detail.claimStartedAt = :gen"
        : " AND (attribute_not_exists(detail.claimStartedAt) OR detail.claimStartedAt = :gen)";
    }
    if (reason) { vals[":dreason"] = reason; arm += " AND detail.reason = :dreason"; }
    ors.push(arm === "#t = :died" ? arm : `(${arm})`);
  }
  if (!ors.length) return false;
  let lastKey;
  for (let page = 0; page < 20; page++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: eventsTable,
        KeyConditionExpression: "workflowId = :w",
        FilterExpression: `(${ors.join(" OR ")}) AND detail.ticketId = :tid AND #ts >= :since`,
        ExpressionAttributeNames: { "#t": "type", "#ts": "timestamp" },
        ExpressionAttributeValues: vals,
        ScanIndexForward: false,
        Limit: 500,
        ExclusiveStartKey: lastKey,
      })
    );
    if ((res.Items || []).length > 0) return true;
    lastKey = res.LastEvaluatedKey;
    if (!lastKey) break;
  }
  return false;
}

/** TEAM-5719 (R1-3): the CURRENT claim's startedAt iff this park is attributed to it, else null (third-party
 * or replayed park). DDB: parkClaim {startedAt, at === updatedAt}; Jira: jiraParkGeneration (TEAM-5729 / TEAM-5731:
 * `changelogId` is the webhook's own changelog id when the caller has it; the DDB branch never reads it). */
export const PARK_CLAIM_LABEL = "park-claim:";
export function parkGeneration(ticket, task, changelogId) {
  const pc = ticket?.parkClaim;
  const gen = pc && typeof pc === "object" ? pc.at && pc.at === ticket.updatedAt && pc.startedAt : jiraParkGeneration(ticket, task?.startedAt, changelogId);
  return typeof gen === "string" && gen && gen === task?.startedAt ? gen : null;
}
/** TEAM-5729 (R3-2 / R3-3): Jira — a `park-claim:<gen>:<nonce>` label is a POINTER; the evidence is the changelog
 * history carrying that nonce (historyMetadata.extraData.fenceNonce) with exactly one status item, into Blocked — the
 * Jira Lambda's own verifyExpectedSource rule, on the `expand=changelog` page the blocked-case read fetched. A label
 * alone (failed POST, failed cleanup), a legacy nonce-less label, a reverted park (two carriers) or no changelog on
 * the ticket (the caller did not fetch it) all fail CLOSED. Any confirmed label of the live generation releases.
 * TEAM-5731 (R4-1): confirmed also means the carrier IS the Blocked move being processed, not a park from earlier in
 * this generation that a later un-park and a foreign Block have overtaken: the ticket is still Blocked; the carrier is
 * the NEWEST status-changing history by `created` (array order is not a contract — the expand page is newest-first,
 * the dedicated endpoint oldest-first); every status history has a parseable `created` and none ties the carrier; the
 * changelog getTicketFromJira assembled (expand page + /changelog pages, TEAM-5792) covers Jira's `total` (`changelogTotal`); and when
 * the webhook named its changelog id, the carrier is that entry. Anything unproven fails CLOSED (claim kept). */
function jiraParkGeneration(ticket, gen, changelogId) {
  if (typeof gen !== "string" || !gen || ticket?.status !== "blocked") return null;
  const prefix = `${PARK_CLAIM_LABEL}${gen}:`, histories = Array.isArray(ticket?.changelog) ? ticket.changelog : [];
  if (ticket?.changelogTotal != null && !(Number(ticket.changelogTotal) <= histories.length)) return null;
  const statusItems = (h) => (h?.items || []).filter((it) => it?.field === "status");
  const carriers = (nonce) => histories.filter((h) => h?.historyMetadata?.extraData?.fenceNonce === nonce);
  const intoBlocked = (h) => { const st = statusItems(h); return st.length === 1 && String(st[0].toString).toLowerCase() === "blocked"; };
  const newest = (ours) => { const t = Date.parse(ours?.created); return Number.isFinite(t) && histories.every((h) => h === ours || !statusItems(h).length || Date.parse(h?.created) < t); };
  const announced = (h) => changelogId == null || String(h?.id) === String(changelogId);
  const confirmed = (label) => { const c = carriers(String(label).slice(prefix.length)); return c.length === 1 && intoBlocked(c[0]) && newest(c[0]) && announced(c[0]); };
  return (ticket?.labels || []).some((l) => String(l).startsWith(prefix) && confirmed(l)) ? gen : null;
}

/**
 * Atomically steal a running claim: flip status→ready ONLY IF the entry still
 * holds the generation we inspected (same startedAt, still running). One
 * winner under concurrent stealers; never clobbers a re-issued claim.
 * Returns false when the claim moved (completed, re-claimed, already stolen).
 */
export async function stealClaim(ddb, workflowsTable, workflowId, ticketId, expectedStartedAt) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: workflowsTable,
        Key: { workflowId },
        UpdateExpression: "SET agentTasks.#tid.#st = :ready",
        ConditionExpression: expectedStartedAt
          ? "agentTasks.#tid.#st IN (:running, :inprog) AND agentTasks.#tid.startedAt = :exp"
          : "agentTasks.#tid.#st IN (:running, :inprog) AND attribute_not_exists(agentTasks.#tid.startedAt)",
        ExpressionAttributeNames: { "#tid": ticketId, "#st": "status" },
        ExpressionAttributeValues: {
          ":ready": "ready",
          ":running": liveClaimStatuses[0],
          ":inprog": liveClaimStatuses[1],
          ...(expectedStartedAt ? { ":exp": expectedStartedAt } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
