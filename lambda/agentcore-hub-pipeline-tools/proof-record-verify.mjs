/**
 * Proof-record verifier (TEAM-5367, DL-036) — the ONE read side of the records a
 * twin or the hub signs with the gate-decision key and an agent must never forge:
 *   - the close-out override  workflows/<id>/shared/closeout-override.json (hub);
 *   - a gate decision         pipeline-artifacts/gate-decisions/<wf>/gates/<tid>.json (twins);
 *   - the merge approval      pipeline-artifacts/gate-decisions/<wf>/merge-approval.json (twins).
 * Unverifiable = absent: every reader fails closed on a record it cannot verify.
 * It also owns THE completions-record ownership rule (recordOwnership, TEAM-5369),
 * the one every evidence reader of completions/<id>.json applies.
 *
 * Imports ONLY node:crypto and reads no env, so it is byte-copied (never imported)
 * into every Lambda that reads one: lambda/orchestrator (canonical), lambda/cost-report,
 * lambda/agentcore-hub-pipeline-tools. scripts/sibling-copies.json pins the copies.
 * Edit the orchestrator copy, then cp it over the rest.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ── Crypto: the contract of decision-contract.mjs (signVerifyRecord / canonicalJson) ──

export const DEFAULT_GATE_DECISION_SECRET_ID = "agentcore-hub-gate-decision-key";

/** JSON with keys sorted at every depth; undefined members dropped. */
export function canonicalJson(value) {
  if (value === undefined) return "";
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : !v || typeof v !== "object" ? v
    : Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])])));
  return JSON.stringify(sort(value));
}

function verifyRecordSig(fields, sig, keys) {
  if (typeof sig !== "string" || sig === "") return false;
  const got = Buffer.from(sig, "base64url");
  const text = fields.map((v) => (v === null || v === undefined ? "" : String(v))).join("|");
  return (Array.isArray(keys) ? keys : []).some((k) => {
    if (typeof k !== "string" || k === "") return false;
    const want = createHmac("sha256", k).update(text).digest();
    return want.length === got.length && timingSafeEqual(want, got);
  });
}

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * The accepted keys, newest first: [AWSCURRENT, AWSPREVIOUS?], cached `ttlMs`.
 * `readStage(stage)` is the caller's Secrets Manager read (SecretString or null).
 * NEVER THROWS; a failed read is not cached. @returns {() => Promise<{ok:true, keys:string[]}|{ok:false, why:string}>}
 */
export function createProofKeyLoader({ readStage, ttlMs = 300000, now = () => Date.now() }) {
  let cache = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return { ok: true, keys: cache.keys };
    try {
      const current = await readStage("AWSCURRENT");
      if (!current) return { ok: false, why: "decision_key_unavailable" };
      const previous = await readStage("AWSPREVIOUS").catch(() => null); // none until the first rotation
      cache = { keys: previous && previous !== current ? [current, previous] : [current], at: now() };
      return { ok: true, keys: cache.keys };
    } catch (err) {
      return { ok: false, why: `decision_key_unavailable (${err?.name || "Error"})` };
    }
  };
}

// ── The close-out override (src/lib/workflow/closeout-override.ts writes it) ──

/** sha256 hex of the canonical sorted, de-duplicated id list. */
export function offenderSetHash(ids) {
  return createHash("sha256").update(canonicalJson([...new Set(ids.map(String))].sort())).digest("hex");
}

/**
 * `{by, reason, offenders, at, offenderSetHash}` for `workflowId`, or null when `raw`
 * is absent, unparseable, unsigned, signed with another key, edited after signing,
 * or written for another run. Never throws.
 */
export function verifyCloseoutOverride(raw, keys, workflowId) {
  let r;
  try { r = typeof raw === "string" ? JSON.parse(raw) : null; } catch { return null; }
  if (!isObj(r) || !Array.isArray(r.offenders) || ![r.by, r.reason, r.at].every(nonEmpty)) return null;
  if (r.v !== 1 || r.kind !== "closeout-override" || !workflowId || r.workflowId !== workflowId) return null;
  if (r.offenderSetHash !== offenderSetHash(r.offenders)) return null;
  const { sig, ...rest } = r;
  if (!verifyRecordSig([canonicalJson(rest)], sig, keys)) return null;
  return { by: r.by, reason: r.reason, offenders: r.offenders.map(String), at: r.at, offenderSetHash: r.offenderSetHash };
}

/** The override names EXACTLY `ids` (DL-036: equality, never a superset). */
export function closeoutOverrideMatches(override, ids) {
  return Boolean(override) && override.offenderSetHash === offenderSetHash(ids);
}

// ── Gate decisions, bound to the LIVE gate ──

const FINDING_ID_RE = /^[A-Za-z0-9_-]+:[0-9a-f]{8}$/;

/** Copy of decision-contract.mjs parseGateScope: the LAST valid `gate-scope: {…}` line, or null. */
export function parseGateScope(description) {
  const lines = String(description ?? "").split(/\r?\n/).map((l) => /^\s*gate-scope:\s*(.*)$/.exec(l)).filter(Boolean);
  if (lines.length === 0) return null;
  let raw;
  try { raw = JSON.parse(lines.at(-1)[1]); } catch { return null; }
  if (!isObj(raw)) return null;
  const round = typeof raw.round === "number" ? raw.round : typeof raw.round === "string" && /^\s*\d+\s*$/.test(raw.round) ? Number(raw.round) : NaN;
  if (!Number.isInteger(round) || round < 1) return null;
  const headSha = typeof raw.headSha === "string" ? raw.headSha.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(headSha)) return null;
  if (!Array.isArray(raw.findingIds) || raw.findingIds.length === 0 || raw.findingIds.length > 50) return null;
  const ids = raw.findingIds.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (ids.some((id) => !FINDING_ID_RE.test(id))) return null;
  return { round, headSha, findingIds: [...new Set(ids)].sort() };
}

/**
 * Either twin's Tickets___get_issue answer (raw Lambda Payload bytes, text or object)
 * → `{ticketId, cycle, scope}`, or null when it is unreadable or a refusal. `cycle`
 * is `gateCycle` (null = never reset) and UNDEFINED when the twin omitted the key:
 * that is "cycle unknown", never "never reset".
 */
export function liveGateOf(payload) {
  let p = payload;
  try {
    if (p instanceof Uint8Array) p = new TextDecoder().decode(p);
    if (typeof p === "string") p = JSON.parse(p || "null");
  } catch { return null; }
  if (!isObj(p) || p.error || !(p.key || p.ticketId)) return null;
  const description = isObj(p.fields) && typeof p.fields.description === "string" ? p.fields.description : p.description;
  return { ticketId: p.key || p.ticketId, cycle: "gateCycle" in p ? p.gateCycle ?? null : undefined, scope: parseGateScope(description) };
}

/** v3 only (the hub's rule): sig over canonicalJson(record minus sig), status implied by option. */
function verifyGateDecisionRecord(r, keys) {
  if (!isObj(r) || r.kind !== "gate-decision" || r.v !== 3 || !isObj(r.decision)) return false;
  if (r.status !== (r.decision.option === "stopped" ? "cancelled" : "done")) return false;
  const { sig, ...rest } = r;
  return verifyRecordSig([canonicalJson(rest)], sig, keys);
}

/**
 * Does a gate-decision record stand for THIS run, THIS ticket and the gate as it is
 * NOW (`live` = liveGateOf)? Its sig verifies, it names both, it was signed in the
 * gate's current decision cycle and over the gate's current scope line.
 * @returns {{ok:true, record:object}|{ok:false, why:"unverified"|"wrong_run"|"cycle_unknown"|"stale_cycle"|"scope_moved"}}
 */
export function gateDecisionStands(rec, keys, { workflowId, ticketId, live }) {
  if (!verifyGateDecisionRecord(rec, keys)) return { ok: false, why: "unverified" };
  if (!workflowId || rec.workflowId !== workflowId || rec.ticketId !== ticketId) return { ok: false, why: "wrong_run" };
  if (!live || live.ticketId !== ticketId || live.cycle === undefined) return { ok: false, why: "cycle_unknown" };
  if ((live.cycle ?? null) !== (rec.cycle ?? null)) return { ok: false, why: "stale_cycle" };
  if (canonicalJson(rec.scope ?? null) !== canonicalJson(live.scope ?? null)) return { ok: false, why: "scope_moved" };
  return { ok: true, record: rec };
}

/** gate-contract.mjs buildMergeApprovalRecord's sig, for `workflowId`. */
export function verifyMergeApprovalRecord(r, keys, { workflowId }) {
  if (!isObj(r) || r.kind !== "merge-approval" || !workflowId || r.workflowId !== workflowId) return false;
  const d = r.decision;
  return verifyRecordSig([r.v, r.ticketId, r.workflowId, r.kind, r.status, d?.option, d?.channel, d?.by, r.decidedAt, r.headSha], r.sig, keys);
}

// ── ONE close-out offender set: port of src/lib/workflow/closeout-offenders.ts ──
// closeoutReview + completion-evidence.ts's gate-class helpers, same rules, same
// order; closeout-override-parity.test.ts runs one roster through both.

const GATE_CLASS_PHASES = ["review", "verification", "ship"];
const GATE_CLASS_EXTRA_AGENTS = ["agentcore_hub_security_reviewer"];
export const AGENT_IDENTITY_FIELDS = ["agent_id", "agentId", "agent"];

/**
 * THE completions-record ownership rule (TEAM-5369; TS mirror completion-evidence.ts
 * recordOwnership, record-ownership-cases.json pins both and the toolkit's Python):
 * every identity field the record carries must equal `assignee` exactly; a record
 * carrying none is a legacy record, accepted with a warning.
 * @returns {{ok:true, warning?:"legacy_no_agent_id"}|{ok:false, why:"agent_mismatch"}}
 */
export function recordOwnership(record, assignee) {
  const r = isObj(record) ? record : {};
  const carried = AGENT_IDENTITY_FIELDS.filter((f) => r[f] !== undefined && r[f] !== null && r[f] !== "");
  if (carried.length === 0) return { ok: true, warning: "legacy_no_agent_id" };
  return typeof assignee === "string" && carried.every((f) => r[f] === assignee) ? { ok: true } : { ok: false, why: "agent_mismatch" };
}

function labelListOf(labels) {
  const list = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  return list.map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean);
}

/** TEAM-5371: THE human-gate rule (fix-contract.mjs isHumanGate) — human: assignee, or a
 * human-review / reviewer:<who> label. */
function isHumanGateTicket(t) {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return labelListOf(t?.labels).some((l) => l === "human-review" || l.startsWith("reviewer:"));
}

/** TEAM-5371: completion-evidence.ts owesNoDeliverable — exactly the pre-TEAM-5371 human-gate
 * set, so a reviewer:-only gate is a human gate yet still owes the record it owed before. */
function owesNoDeliverable(t) {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return labelListOf(t?.labels).includes("human-review");
}

export function isGateClassTicket(t, phaseOf) {
  if (!t || t.type === "epic") return false;
  if (isHumanGateTicket(t) || GATE_CLASS_EXTRA_AGENTS.includes(t.assignee)) return true;
  return GATE_CLASS_PHASES.includes(phaseOf(t));
}

/** The sweeper a `skipped` completions record for THIS run names (not the ticket itself), or null. */
function sweepSkipSweeperOf(r, ticketId, workflowId) {
  if (!isObj(r) || r.evidence_kind !== "skipped" || r.skipped !== true) return null;
  if ((r.ticketId && r.ticketId !== ticketId) || !workflowId || r.workflowId !== workflowId) return null;
  const sweeper = (typeof r.sweeperTicketId === "string" && r.sweeperTicketId) || /\bby ([A-Z][A-Z0-9]*-\d+)\b/.exec(String(r.summary || ""))?.[1] || null;
  return sweeper && sweeper !== ticketId ? sweeper : null;
}

/** An agent gate's own completions record: not the console's, evidence, every identity field = assignee. */
function gateClassRecordSatisfies(r, t, hasEvidence) {
  if (!isObj(r) || r.source === "workflow-manager" || r.evidence_kind === "skipped" || r.skipped === true) return false;
  return hasEvidence(r) && recordOwnership(r, t.assignee).ok;
}

/**
 * The ids an override must name: `missingIds` (the caller's missing-evidence
 * offenders) ∪ every done gate-class ticket not backed by its owner's evidence —
 * a human gate by a standing gate decision (gateDecisionStands), an agent gate by
 * its own completions record, either by a sweep skip a same-parent sweeper proves.
 * `readJson(key)` → parsed or null (a failed read is null: the ticket stays an
 * offender); `liveGate(ticketId)` → a get_issue payload for liveGateOf. Sorted.
 */
export async function closeoutOffenderIds(children, { workflowId, missingIds = [], keys, phaseOf, readJson, hasEvidence, liveGate }) {
  const record = (tid) => readJson(`completions/${tid}.json`);
  const sweepProvesSkip = async (t, r) => {
    const sweeperId = sweepSkipSweeperOf(r, t.ticketId, workflowId);
    const s = sweeperId && children.find((x) => x.ticketId === sweeperId);
    if (!s || !t.parentId || s.parentId !== t.parentId || (s.workflowId && s.workflowId !== workflowId)) return false;
    const status = String(s.status || "").toLowerCase();
    if (status === "done") return true;
    const own = status === "in_progress" ? await record(sweeperId) : null;
    return isObj(own) && own.workflowId === workflowId && own.evidence_kind !== "skipped" && own.skipped !== true;
  };
  const backed = async (t) => {
    if (isHumanGateTicket(t)) {
      const rec = await readJson(`pipeline-artifacts/gate-decisions/${workflowId}/gates/${t.ticketId}.json`);
      const stands = rec ? gateDecisionStands(rec, keys, { workflowId, ticketId: t.ticketId, live: liveGateOf(await liveGate(t.ticketId)) }) : null;
      if (stands?.ok) return stands.record.status === "done";
      // TEAM-5371 (no loosening): a gate that was not exempt before (reviewer:-only) still
      // passes on the completion record it owed then, falling through below.
      if (owesNoDeliverable(t)) return sweepProvesSkip(t, await record(t.ticketId));
    }
    const r = await record(t.ticketId);
    return (await sweepProvesSkip(t, r)) || gateClassRecordSatisfies(r, t, hasEvidence);
  };
  const out = new Set(missingIds.map(String));
  for (const t of children || []) {
    if (String(t.status || "").toLowerCase() !== "done" || !isGateClassTicket(t, phaseOf)) continue;
    if (!(await backed(t))) out.add(String(t.ticketId || ""));
  }
  return [...out].sort();
}
