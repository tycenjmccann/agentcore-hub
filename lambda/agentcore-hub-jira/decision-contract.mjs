/**
 * decision-contract.mjs — the human-gate DECISION contract (TEAM-5322, FR-9,
 * TEAM-5318 F1/F4).
 *
 * Every human gate is "decision-bound" (TEAM-5391): it may close only on one of
 * the options its description declares (`DECISION OPTIONS: a | b | c`) or, when it
 * declares none, on one of DEFAULT_DECISION_OPTIONS (`approve | reject`), chosen by a human
 * through an authenticated channel (the hub console or the Telegram bridge). The
 * channel proves it by presenting a DECISION TOKEN — an HMAC over the ticket id and
 * the chosen option, signed with a key only the hub, the bridge and the two ticket
 * twins can read (Secrets Manager `agentcore-hub-gate-decision-key`; the agent
 * runtime role has no read on it). Text an agent can write — a transition
 * `reason`, a plain `decision` parameter, a comment — is never an answer.
 *
 * ── FOUR byte-identical copies ──────────────────────────────────────────────
 *   lambda/agentcore-hub-tickets/decision-contract.mjs   (canonical)
 *   lambda/agentcore-hub-jira/decision-contract.mjs
 *   deploy/telegram-bug-intake/decision-contract.mjs
 *   lambda/workflow-output/decision-contract.mjs         (TEAM-5340: gate-contract's
 *                                                         import, verify side only)
 * Each ships in a self-contained single-directory zip, so the copies cannot share
 * a file; scripts/check-fix-kinds-parity.sh compares them byte-for-byte.
 * EDIT THE TICKETS COPY, THEN cp it over the other three.
 * The module imports ONLY node:crypto — no SDK, no sibling module — so the bridge
 * (whose zip carries no fix-contract.mjs) can mint with exactly the code the twins
 * verify with. Key LOADING is not here: it is I/O and lives with each holder
 * (gate-contract.mjs loadDecisionKeys for the twins).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DECISION_REQUIRED = "decision_required";
export const DECISION_TOKEN_PREFIX = "gd1.";
export const DECISION_TOKEN_MAX_TTL_SEC = 900;

// The default secret id every key holder falls back to when GATE_DECISION_SECRET_ID
// is unset. CD only runs update-function-code (env is never touched), so a default
// is what makes a code-only deploy work as soon as the secret and its IAM grant
// exist (docs/pipeline/design.md "TEAM-5322 provisioning").
export const DEFAULT_GATE_DECISION_SECRET_ID = "agentcore-hub-gate-decision-key";

// ── Grammar ─────────────────────────────────────────────────────────────────
// A declaration is one whole line, at least two lowercase tokens separated by `|`.
// An answer is one whole line `DECISION: <opt>` or `DECISION: override:<opt>`,
// tolerating the markdown bullets/bold an LLM or a human wraps it in.
// Neither collides with fix-contract's `DECISION: <fix|no-fix>` reader nor the
// review-cap `DECISION:` reader: both of those only run on tickets that are not
// decision-bound, and a declaration (`DECISION OPTIONS:`) never matches either.
export const DECISION_OPTIONS_RE =
  /^\s*DECISION OPTIONS:\s*([a-z0-9][a-z0-9-]{0,39}(?:\s*\|\s*[a-z0-9][a-z0-9-]{0,39})+)\s*$/;
export const DECISION_ANSWER_RE =
  /^[\s*-]*(?:\*\*)?\s*DECISION\s*:\s*(override:)?([a-z0-9][a-z0-9-]{0,39})\s*(?:\*\*)?\s*\.?\s*$/i;

const FENCE_RE = /^\s*(```|~~~)/;

// The twin-owned verification state labels (TEAM-5318 F4). Only these are
// reserved: the gate KIND labels (`gate:deploy-approval`, …) must stay writable,
// because gateShapeRefusal requires them on every agent-created gate ticket.
export const RESERVED_STATE_LABEL_RE = /^gate[:-](verifying|approved-unverified)$|^gateverify[:-]/;

// TEAM-5358 FR-6: options every human gate admits whatever its DECISION OPTIONS
// line says. `stopped` is the human's "stop the run here": it never closes a gate
// as done, it is what a human:* gate needs to end `cancelled` (F2).
export const UNIVERSAL_DECISION_OPTIONS = Object.freeze(["stopped"]);

/** The declared options plus the universal ones, declared first, deduped. */
export function admittedOptions(declared) {
  return [...new Set([...(Array.isArray(declared) ? declared : []), ...UNIVERSAL_DECISION_OPTIONS])];
}

// TEAM-5391 FR-6: a human gate that declares no DECISION OPTIONS is still a human
// decision. It admits this default set (plus the universal `stopped`), so no human
// gate ever closes on a bare Done. `parseDecisionOptions` stays the RAW reader:
// scopeHash and the freeze rule mean "what was declared", not "what is admitted".
export const DEFAULT_DECISION_OPTIONS = Object.freeze(["approve", "reject"]);

/** The options a human gate admits as a close: the declared ones, else the default set. */
export function effectiveDecisionOptions(description) {
  return parseDecisionOptions(description) ?? [...DEFAULT_DECISION_OPTIONS];
}

function unfencedLines(text) {
  if (typeof text !== "string" || text === "") return [];
  const out = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

/**
 * The options a ticket description declares, or null when it declares none.
 * The LAST unfenced declaration wins (an edited brief appends a corrected line).
 * Fewer than two distinct options is not a choice, so it is not a declaration.
 *
 * @param {string|null|undefined} description
 * @returns {string[]|null}
 */
export function parseDecisionOptions(description) {
  let found = null;
  for (const line of unfencedLines(description)) {
    const m = DECISION_OPTIONS_RE.exec(line);
    if (m) found = m[1];
  }
  if (found === null) return null;
  const opts = [...new Set(found.split("|").map((s) => s.trim()).filter(Boolean))];
  return opts.length >= 2 ? opts : null;
}

/**
 * The answer a text carries for a set of options, or null. The LAST unfenced line
 * whose option is one of `options` wins; a DECISION line naming an undeclared
 * option is ignored (it is not an answer to THIS gate).
 *
 * @param {string|null|undefined} text
 * @param {readonly string[]} options
 * @returns {{option:string, override:boolean}|null}
 */
export function parseDecisionAnswer(text, options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const admitted = admittedOptions(options);
  let found = null;
  for (const line of unfencedLines(text)) {
    const m = DECISION_ANSWER_RE.exec(line);
    if (!m) continue;
    const option = m[2].toLowerCase();
    if (admitted.includes(option)) found = { option, override: Boolean(m[1]) };
  }
  return found;
}

/**
 * The refusal a twin returns when a decision-bound gate is closed without a
 * valid decision. `payload` is the tool result, `comment` is what the twin posts
 * so the human sees the choices on the ticket itself.
 */
export function decisionRefusal({ ticketId, options, detail }) {
  const list = Array.isArray(options) ? options : [];
  const why = detail ? ` (${detail})` : "";
  const message =
    `${ticketId} is a decision-bound human gate: it closes only on one of ` +
    `[${list.join(", ")}], chosen in the hub console or Telegram${why}.`;
  return {
    payload: { ok: false, reason: DECISION_REQUIRED, ticketId, options: list, detail: detail || null },
    message,
    comment:
      `Gate close refused: ${DECISION_REQUIRED}${why}.\n` +
      `Pick one of: ${list.join(" | ")} - from the hub console or the Telegram gate message. ` +
      `A DECISION written by an agent is ignored.`,
  };
}

// ── Gate scope ──────────────────────────────────────────────────────────────
// TEAM-5358 F3: moved here from gate-contract.mjs (which re-exports them) so the
// scope a token is bound to (`s`) is computed by the module every minter carries.

/** `<ticket>:<8 hex>` — residualFindingId's shape (workflow-output) and the ledger's. */
export const FINDING_ID_RE = /^[A-Za-z0-9_-]+:[0-9a-f]{8}$/;
/** As many findings as one acceptance may carry (workflow-output RESIDUAL_MAX_ENTRIES). */
export const GATE_SCOPE_MAX_FINDINGS = 50;
const GATE_SCOPE_LINE_RE = /^\s*gate-scope:\s*(.*)$/;
const GATE_SCOPE_HEAD_RE = /^[0-9a-f]{40}$/i;

/**
 * The LAST `gate-scope: {…}` line of a gate description, validated, or null.
 * `{round: int >= 1, headSha: 40 hex (lowercased), findingIds: [FINDING_ID_RE…]}`,
 * findingIds deduped and sorted so the signed canonical form does not depend on the
 * author's order. Anything malformed is null — never a partial scope. PURE.
 * @returns {{round:number, headSha:string, findingIds:string[]}|null}
 */
export function parseGateScope(description) {
  const lines = String(description ?? "").split(/\r?\n/).map((l) => GATE_SCOPE_LINE_RE.exec(l)).filter(Boolean);
  if (lines.length === 0) return null;
  let raw;
  try { raw = JSON.parse(lines.at(-1)[1]); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const round = typeof raw.round === "number" ? raw.round : typeof raw.round === "string" && /^\s*\d+\s*$/.test(raw.round) ? Number(raw.round) : NaN;
  if (!Number.isInteger(round) || round < 1) return null;
  const headSha = typeof raw.headSha === "string" ? raw.headSha.trim().toLowerCase() : "";
  if (!GATE_SCOPE_HEAD_RE.test(headSha)) return null;
  if (!Array.isArray(raw.findingIds) || raw.findingIds.length === 0 || raw.findingIds.length > GATE_SCOPE_MAX_FINDINGS) return null;
  const ids = raw.findingIds.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (ids.some((id) => !FINDING_ID_RE.test(id))) return null;
  return { round, headSha, findingIds: [...new Set(ids)].sort() };
}

/**
 * What a decision answers, as one hex digest: the gate's parsed scope and declared
 * options. A token carries it as `s`, so a token minted for one scope is refused
 * once either line has changed (`decision_scope_changed`). A description with
 * neither line hashes to a fixed value, so it still binds. RAW on purpose (TEAM-5391):
 * it signs what was declared, so a token minted under the default set is refused once
 * a DECISION OPTIONS line is added.
 */
export function scopeHash(description) {
  return createHash("sha256")
    .update(canonicalJson({ scope: parseGateScope(description), options: parseDecisionOptions(description) }))
    .digest("hex");
}

// ── Tokens ──────────────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function hmac(key, text) {
  return createHmac("sha256", key).update(text).digest();
}

function nowSec(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  return Math.floor(ms / 1000);
}

// TEAM-5338 F3: every token carries a single-use id (`j`). The twins record it when
// they act on the token and refuse it the second time, so a token cannot be
// replayed as a later decision. `jti` is a test seam; production mints a random one.
export const DECISION_TOKEN_JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Mint a decision token. `key` is the raw secret string (the holder's AWSCURRENT).
 * The TTL is capped at 15 minutes: a token is minted at click time and presented
 * within the same request, so a long-lived token would only widen a replay window.
 * TEAM-5358 F3: `description` is the gate's description as the human saw it; its
 * scopeHash is signed as `s`.
 */
export function mintDecisionToken({ ticketId, option, channel, by, workflowId = null, description, ttlSec = DECISION_TOKEN_MAX_TTL_SEC, now, jti } = {}, key) {
  if (!key) throw new Error("decision key unavailable");
  if (!ticketId || !option || !channel) throw new Error("ticketId, option and channel are required");
  const iat = nowSec(now);
  const ttl = Math.max(1, Math.min(Number(ttlSec) || DECISION_TOKEN_MAX_TTL_SEC, DECISION_TOKEN_MAX_TTL_SEC));
  const j = jti === undefined ? b64url(randomBytes(16)) : String(jti);
  if (!DECISION_TOKEN_JTI_RE.test(j)) throw new Error("jti has an unexpected format");
  const payload = {
    t: String(ticketId),
    o: String(option).toLowerCase(),
    c: String(channel),
    by: String(by || "unknown"),
    w: workflowId ? String(workflowId) : null,
    iat,
    exp: iat + ttl,
    j,
    s: scopeHash(description),
  };
  const head = DECISION_TOKEN_PREFIX + b64url(JSON.stringify(payload));
  return `${head}.${b64url(hmac(key, head))}`;
}

/**
 * Verify a decision token against every accepted key (AWSCURRENT, AWSPREVIOUS —
 * rotation never strands a token in flight). Never throws.
 * `ignoreExpiry` is for the re-probe, which re-checks a token that was valid when
 * the human clicked; its bound is the stored verifyUntil, not the token's exp.
 *
 * TEAM-5338 F3: `workflowId`, when the key is PRESENT in the options, must equal
 * the token's signed `w` (a token with no `w` never matches). `notBeforeMs` is the
 * start of the gate's current decision cycle: a token minted before it belongs to
 * an earlier cycle and is `token_stale`. An authentic token with no single-use id
 * predates the id and is `token_malformed`. Consumption is the holder's job.
 *
 * `s` is the signed scopeHash, or null for a token minted before it existed (the
 * caller compares it; resolveDecision refuses a mismatch).
 *
 * @returns {{ok:true, option:string, override:true, channel:string, by:string, workflowId:string|null, iat:number, exp:number, jti:string, s:string|null}
 *          |{ok:false, reason:"token_malformed"|"token_signature"|"token_expired"|"token_ticket_mismatch"|"token_workflow_mismatch"|"token_stale"}}
 */
export function verifyDecisionToken(token, { ticketId, keys, now, ignoreExpiry = false, notBeforeMs, ...opts } = {}) {
  if (typeof token !== "string" || !token.startsWith(DECISION_TOKEN_PREFIX)) {
    return { ok: false, reason: "token_malformed" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= DECISION_TOKEN_PREFIX.length) return { ok: false, reason: "token_malformed" };
  const head = token.slice(0, dot);
  let sig;
  let payload;
  try {
    sig = Buffer.from(token.slice(dot + 1), "base64url");
    payload = JSON.parse(Buffer.from(head.slice(DECISION_TOKEN_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "token_malformed" };
  }
  if (
    !payload || typeof payload !== "object" ||
    typeof payload.t !== "string" || typeof payload.o !== "string" || typeof payload.c !== "string" ||
    !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) ||
    payload.exp - payload.iat > DECISION_TOKEN_MAX_TTL_SEC
  ) {
    return { ok: false, reason: "token_malformed" };
  }
  const usable = (Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string" && k !== "");
  const signed = usable.some((k) => {
    const want = hmac(k, head);
    return want.length === sig.length && timingSafeEqual(want, sig);
  });
  if (!signed) return { ok: false, reason: "token_signature" };
  if (typeof payload.j !== "string" || !DECISION_TOKEN_JTI_RE.test(payload.j)) return { ok: false, reason: "token_malformed" };
  if (ticketId && payload.t !== String(ticketId)) return { ok: false, reason: "token_ticket_mismatch" };
  if ("workflowId" in opts && (typeof payload.w !== "string" || payload.w !== String(opts.workflowId ?? ""))) {
    return { ok: false, reason: "token_workflow_mismatch" };
  }
  // TEAM-5347 F8: `iat` is whole seconds, the cut-off is milliseconds. A token minted in
  // the SAME second as the cut-off cannot be proven newer than it (a reopen 1 ms after
  // the click would otherwise keep the click), so same-second is stale: `<=`.
  if (Number.isFinite(notBeforeMs) && payload.iat <= Math.floor(notBeforeMs / 1000)) return { ok: false, reason: "token_stale" };
  if (!ignoreExpiry && nowSec(now) > payload.exp) return { ok: false, reason: "token_expired" };
  return {
    ok: true,
    option: payload.o,
    override: true,
    channel: payload.c,
    by: typeof payload.by === "string" ? payload.by : "unknown",
    workflowId: typeof payload.w === "string" ? payload.w : null,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.j,
    s: typeof payload.s === "string" ? payload.s : null,
  };
}

// ── Signed twin records ─────────────────────────────────────────────────────
// The gateVerify row map and the merge-approval S3 record are written by a twin
// to storage the agent runtime role can also write, so a reader trusts one only
// when its sig verifies. The canonical string is the listed fields joined by `|`
// in the given order — never JSON.stringify, whose key order is not a contract.

export function canonicalRecordString(fields) {
  return (Array.isArray(fields) ? fields : []).map((v) => (v === null || v === undefined ? "" : String(v))).join("|");
}

/**
 * TEAM-5338 F6: a signed field that is itself an object (a gate's postCondition)
 * enters the canonical string as JSON with keys sorted at every depth, so the same
 * value always signs to the same bytes whatever order a writer built it in.
 * Not for cyclic values. undefined members are dropped, like JSON.stringify.
 */
export function canonicalJson(value) {
  if (value === undefined) return "";
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] !== undefined) out[k] = sortKeysDeep(v[k]);
  }
  return out;
}

export function signVerifyRecord(fields, key) {
  if (!key) throw new Error("decision key unavailable");
  return b64url(hmac(key, canonicalRecordString(fields)));
}

export function verifyRecordSig(fields, sig, keys) {
  if (typeof sig !== "string" || sig === "") return false;
  let got;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  const text = canonicalRecordString(fields);
  return (Array.isArray(keys) ? keys : []).some((k) => {
    if (typeof k !== "string" || k === "") return false;
    const want = hmac(k, text);
    return want.length === got.length && timingSafeEqual(want, got);
  });
}

// ── Log redaction ───────────────────────────────────────────────────────────
// TEAM-5338 F10: a decision token is a bearer credential for ~15 minutes, so no
// holder may log one. redactForLog returns a copy of `value` with every member
// whose KEY names a credential, and every string that IS a decision token,
// replaced by "[redacted]" (numbers such as token COUNTS are kept). Use it on
// anything a handler logs from its event.
const REDACT_KEY_RE = /token|secret|authorization|password|credential|api[-_]?key/i;
const REDACTED = "[redacted]";

export function redactForLog(value, depth = 0) {
  if (typeof value === "string") return value.includes(DECISION_TOKEN_PREFIX) ? redactTokens(value) : value;
  if (!value || typeof value !== "object") return value;
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEY_RE.test(k) && typeof v === "string" && v !== "" ? REDACTED : redactForLog(v, depth + 1);
  }
  return out;
}

function redactTokens(text) {
  return text.replace(/gd1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, REDACTED);
}

// ── Telegram callback data ──────────────────────────────────────────────────
// One option button on a decision-bound gate message. Telegram caps callback_data
// at 64 bytes, so an option too long to carry by name is carried by its index in
// the declaration; the bridge re-reads the ticket's options on the callback and
// decodes against THEM, so a button from a stale message can only resolve to an
// option the gate still declares. The data names a choice, never proves one: the
// bridge still mints a token for it.
// The index runs over admittedOptions (declared, then `stopped`) on both sides.
export const DECISION_CALLBACK_PREFIX = "gdc";
export const TELEGRAM_CALLBACK_MAX_BYTES = 64;
const CALLBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @returns {string|null} the callback_data, or null when even the index form does
 *   not fit (or the option is not declared).
 */
export function encodeDecisionCallback({ option, options: declared, ticketId, workflowId = null } = {}) {
  if (!Array.isArray(declared)) return null;
  const options = admittedOptions(declared);
  if (!options.includes(option)) return null;
  if (!CALLBACK_ID_RE.test(String(ticketId || ""))) return null;
  if (workflowId && !CALLBACK_ID_RE.test(String(workflowId))) return null;
  const tail = `${ticketId}|${workflowId || ""}`;
  for (const token of [option, `#${options.indexOf(option)}`]) {
    const data = `${DECISION_CALLBACK_PREFIX}|${token}|${tail}`;
    if (Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_MAX_BYTES) return data;
  }
  return null;
}

/**
 * @returns {{option:string, ticketId:string, workflowId:string|null}|null} null for
 *   anything that is not a decision callback naming one of `options`.
 */
export function decodeDecisionCallback(data, declared) {
  if (typeof data !== "string" || !Array.isArray(declared)) return null;
  const options = admittedOptions(declared);
  const parts = data.split("|");
  if (parts.length !== 4 || parts[0] !== DECISION_CALLBACK_PREFIX) return null;
  const [, token, ticketId, workflowId] = parts;
  if (!CALLBACK_ID_RE.test(ticketId) || (workflowId !== "" && !CALLBACK_ID_RE.test(workflowId))) return null;
  let option = token;
  const idx = /^#(\d{1,2})$/.exec(token);
  if (idx) option = options[Number(idx[1])];
  if (typeof option !== "string" || !options.includes(option)) return null;
  return { option, ticketId, workflowId: workflowId || null };
}
