/**
 * decision-contract.mjs — the human-gate DECISION contract (TEAM-5322, FR-9,
 * TEAM-5318 F1/F4).
 *
 * A `human:*` gate whose description declares `DECISION OPTIONS: a | b | c` is
 * "decision-bound": it may close only on one of those options, chosen by a human
 * through an authenticated channel (the hub console or the Telegram bridge). The
 * channel proves it by presenting a DECISION TOKEN — an HMAC over the ticket id and
 * the chosen option, signed with a key only the hub, the bridge and the two ticket
 * twins can read (Secrets Manager `agentcore-hub-gate-decision-key`; the agent
 * runtime role has no read on it). Text an agent can write — a transition
 * `reason`, a plain `decision` parameter, a comment — is never an answer.
 *
 * ── THREE byte-identical copies ─────────────────────────────────────────────
 *   lambda/agentcore-hub-tickets/decision-contract.mjs   (canonical)
 *   lambda/agentcore-hub-jira/decision-contract.mjs
 *   deploy/telegram-bug-intake/decision-contract.mjs
 * Each ships in a self-contained single-directory zip, so the copies cannot share
 * a file; scripts/check-fix-kinds-parity.sh compares them byte-for-byte.
 * EDIT THE TICKETS COPY, THEN cp it over the other two.
 * The module imports ONLY node:crypto — no SDK, no sibling module — so the bridge
 * (whose zip carries no fix-contract.mjs) can mint with exactly the code the twins
 * verify with. Key LOADING is not here: it is I/O and lives with each holder
 * (gate-contract.mjs loadDecisionKeys for the twins).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

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
  let found = null;
  for (const line of unfencedLines(text)) {
    const m = DECISION_ANSWER_RE.exec(line);
    if (!m) continue;
    const option = m[2].toLowerCase();
    if (options.includes(option)) found = { option, override: Boolean(m[1]) };
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

/**
 * Mint a decision token. `key` is the raw secret string (the holder's AWSCURRENT).
 * The TTL is capped at 15 minutes: a token is minted at click time and presented
 * within the same request, so a long-lived token would only widen a replay window.
 */
export function mintDecisionToken({ ticketId, option, channel, by, workflowId = null, ttlSec = DECISION_TOKEN_MAX_TTL_SEC, now } = {}, key) {
  if (!key) throw new Error("decision key unavailable");
  if (!ticketId || !option || !channel) throw new Error("ticketId, option and channel are required");
  const iat = nowSec(now);
  const ttl = Math.max(1, Math.min(Number(ttlSec) || DECISION_TOKEN_MAX_TTL_SEC, DECISION_TOKEN_MAX_TTL_SEC));
  const payload = {
    t: String(ticketId),
    o: String(option).toLowerCase(),
    c: String(channel),
    by: String(by || "unknown"),
    w: workflowId ? String(workflowId) : null,
    iat,
    exp: iat + ttl,
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
 * @returns {{ok:true, option:string, override:true, channel:string, by:string, workflowId:string|null, iat:number, exp:number}
 *          |{ok:false, reason:"token_malformed"|"token_signature"|"token_expired"|"token_ticket_mismatch"}}
 */
export function verifyDecisionToken(token, { ticketId, keys, now, ignoreExpiry = false } = {}) {
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
  if (ticketId && payload.t !== String(ticketId)) return { ok: false, reason: "token_ticket_mismatch" };
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

// ── Telegram callback data ──────────────────────────────────────────────────
// One option button on a decision-bound gate message. Telegram caps callback_data
// at 64 bytes, so an option too long to carry by name is carried by its index in
// the declaration; the bridge re-reads the ticket's options on the callback and
// decodes against THEM, so a button from a stale message can only resolve to an
// option the gate still declares. The data names a choice, never proves one: the
// bridge still mints a token for it.
export const DECISION_CALLBACK_PREFIX = "gdc";
export const TELEGRAM_CALLBACK_MAX_BYTES = 64;
const CALLBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @returns {string|null} the callback_data, or null when even the index form does
 *   not fit (or the option is not declared).
 */
export function encodeDecisionCallback({ option, options, ticketId, workflowId = null } = {}) {
  if (!Array.isArray(options) || !options.includes(option)) return null;
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
export function decodeDecisionCallback(data, options) {
  if (typeof data !== "string" || !Array.isArray(options)) return null;
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
