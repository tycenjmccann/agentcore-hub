/**
 * The human-gate DECISION contract, TS mirror (TEAM-5322 FR-9, TEAM-5318 F1).
 *
 * Canonical source: lambda/agentcore-hub-tickets/decision-contract.mjs (byte-copied
 * to the jira twin and the Telegram bridge). This file is a PORT, not a copy, for
 * the hub route and the console. The grammar half lives in ./decision-grammar
 * (TEAM-5324, a pure move) and is re-exported below, so every name stays stable.
 * src/lib/workflow/decision-contract-parity.test.ts pushes one truth table through
 * all four and cross-mints tokens between this file and the .mjs copies, so a
 * drift fails `npm run test:unit`.
 *
 * A `human:*` gate whose description declares `DECISION OPTIONS: a | b` closes only
 * on a signed decision token. Text an agent can write is never an answer.
 *
 * The token half needs node's crypto, so a client component imports
 * @/lib/workflow/decision-grammar, never this file; the hub mints and verifies
 * server-side (decision-keys.ts holds the key, never the browser).
 */

import { createHmac, timingSafeEqual } from "crypto";

// The grammar half (options/answer parsing, isDecisionBound, the 409 body type)
// lives in ./decision-grammar, which imports nothing; re-exported unchanged here.
export * from "./decision-grammar";

export const DECISION_TOKEN_PREFIX = "gd1.";
export const DECISION_TOKEN_MAX_TTL_SEC = 900;
export const DEFAULT_GATE_DECISION_SECRET_ID = "agentcore-hub-gate-decision-key";

export type DecisionTokenClaims = {
  ok: true;
  option: string;
  override: true;
  channel: string;
  by: string;
  workflowId: string | null;
  iat: number;
  exp: number;
};

export type DecisionTokenFailure = {
  ok: false;
  reason: "token_malformed" | "token_signature" | "token_expired" | "token_ticket_mismatch";
};

// ── Tokens ──────────────────────────────────────────────────────────────────
function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function hmac(key: string, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

function nowSec(now?: Date | number): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  return Math.floor(ms / 1000);
}

export function mintDecisionToken(
  {
    ticketId,
    option,
    channel,
    by,
    workflowId = null,
    ttlSec = DECISION_TOKEN_MAX_TTL_SEC,
    now,
  }: {
    ticketId: string;
    option: string;
    channel: string;
    by?: string;
    workflowId?: string | null;
    ttlSec?: number;
    now?: Date | number;
  },
  key: string
): string {
  if (!key) throw new Error("decision key unavailable");
  if (!ticketId || !option || !channel) throw new Error("ticketId, option and channel are required");
  const iat = nowSec(now);
  const ttl = Math.max(1, Math.min(Number(ttlSec) || DECISION_TOKEN_MAX_TTL_SEC, DECISION_TOKEN_MAX_TTL_SEC));
  // Key order is part of the signed bytes — it must match the .mjs payload literal.
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

/** Verify against every accepted key (AWSCURRENT, AWSPREVIOUS). Never throws. */
export function verifyDecisionToken(
  token: unknown,
  {
    ticketId,
    keys,
    now,
    ignoreExpiry = false,
  }: { ticketId?: string; keys: readonly string[] | null | undefined; now?: Date | number; ignoreExpiry?: boolean }
): DecisionTokenClaims | DecisionTokenFailure {
  if (typeof token !== "string" || !token.startsWith(DECISION_TOKEN_PREFIX)) {
    return { ok: false, reason: "token_malformed" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= DECISION_TOKEN_PREFIX.length) return { ok: false, reason: "token_malformed" };
  const head = token.slice(0, dot);
  let sig: Buffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
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

// ── Telegram callback data (the bridge's buttons; see the .mjs for the why) ──
export const DECISION_CALLBACK_PREFIX = "gdc";
export const TELEGRAM_CALLBACK_MAX_BYTES = 64;
const CALLBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeDecisionCallback({
  option,
  options,
  ticketId,
  workflowId = null,
}: {
  option: string;
  options: readonly string[];
  ticketId: string;
  workflowId?: string | null;
}): string | null {
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

export function decodeDecisionCallback(
  data: unknown,
  options: readonly string[]
): { option: string; ticketId: string; workflowId: string | null } | null {
  if (typeof data !== "string" || !Array.isArray(options)) return null;
  const parts = data.split("|");
  if (parts.length !== 4 || parts[0] !== DECISION_CALLBACK_PREFIX) return null;
  const [, token, ticketId, workflowId] = parts;
  if (!CALLBACK_ID_RE.test(ticketId) || (workflowId !== "" && !CALLBACK_ID_RE.test(workflowId))) return null;
  let option: string | undefined = token;
  const idx = /^#(\d{1,2})$/.exec(token);
  if (idx) option = options[Number(idx[1])];
  if (typeof option !== "string" || !options.includes(option)) return null;
  return { option, ticketId, workflowId: workflowId || null };
}
