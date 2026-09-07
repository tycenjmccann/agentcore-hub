/**
 * Deterministic event ids (TEAM-4120 FR-2) — the producer-side half of the
 * events-table double-write fix.
 *
 * Every orchestrator/agent-invoker event reaches the events table TWICE: the
 * publisher PutItems it directly, and the same event goes to EventBridge, whose
 * `agentcore-hub-workflow-events` rule fans out to events-writer.mjs, which
 * PutItems it AGAIN under a different eventId. The table's key is
 * (workflowId, eventId), so the two copies land as two rows and every consumer
 * that counts rows double-counts (cost-report already pays for this with a
 * content-key dedupe pass; anomaly-watcher pays for it with dropStaleItems).
 *
 * The fix: derive the eventId from the event's CONTENT rather than from the
 * writer's clock + a random suffix. Both writers then compute the SAME
 * (workflowId, eventId), and the second Put simply overwrites the first — one
 * row per event, no consumer-side dedupe needed. That's benign here: the table
 * has no GSI, neither writer stamps `ttl`, and the two items differ only in the
 * `source` attribute (the EventBridge copy carries it).
 *
 * Rollout: EVENT_DEDUPE_MODE = off | enforce. As of TEAM-4167 D3 (FR-3.4) the
 * DEFAULT is enforce: an unset (or garbage) value collapses the twin write,
 * because leaving it off silently double-counts every consumer that reads row
 * counts. `off` is the byte-identical pre-4120 escape hatch — eventIdFor then
 * delegates straight to the caller's legacy generator. Only an EXACT "off"
 * disables; instant rollback = set off. The flag must agree across ALL THREE
 * writers (orchestrator, agent-invoker, events-writer) for the overwrite to
 * happen, which is why deploy.sh forwards enforce to all three explicitly.
 *
 * The content key is deliberately the SAME string the consumer side already
 * dedupes by (lambda/cost-report/index.mjs dedupeEvents): collapsing on the
 * producer side must not disagree with the collapsing the consumers already do.
 *
 * Only node:crypto is imported, so this module is safe to pull into any of the
 * three entrypoints without dragging AWS clients into a cold start.
 */
import { createHash } from "node:crypto";

/**
 * STRICT allow-list: exactly "off" | "enforce" (case- and whitespace-
 * insensitive). Everything the allow-list does not recognize — unset/empty,
 * legacy truthy spellings ("on"/"true"/"1"), the never-implemented "shadow",
 * a typo — resolves to `defaultMode`.
 *
 * `defaultMode` (TEAM-4167 D3 FR-3.4): the value a MISSING/garbage env var takes.
 *   - Historical single-arg callers keep the pre-4167 default of "off"
 *     (byte-identical): only an explicit "enforce" turned collapse on.
 *   - The three event producers now pass "enforce", so an unset var collapses
 *     the twin write by default; only an EXACT "off" opts out (instant rollback).
 * A non-empty unrecognized value is a real typo and is logged either way, so a
 * misconfigured flag never silently picks a mode without saying which way it fell.
 */
export function normalizeEventDedupeMode(v, defaultMode = "off") {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "enforce") return "enforce";
  if (s === "off") return "off";
  if (s !== "") {
    console.warn(`[event-id] EVENT_DEDUPE_MODE="${v}" is not "off" or "enforce" — using default "${defaultMode}".`);
  }
  return defaultMode === "enforce" ? "enforce" : "off";
}

/** Recursive key-sorted JSON — byte-identical to cost-report/index.mjs stableJson. */
export function stableJson(v) {
  if (v == null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

/**
 * The identity of an event, as a string. Byte-for-byte the key
 * cost-report/index.mjs dedupeEvents computes for the same row (its `ts`
 * fallback to the row timestamp doesn't apply here: the producer always has
 * detail.timestamp, since publishEvent/publishAgentEvent stamp it themselves).
 *
 * Absent/null fields normalize to "" so `ticketId: null` and a missing
 * ticketId hash identically — the two copies of one event must never be able
 * to disagree on the key because of a nullish spelling.
 */
export function contentKey(type, detail) {
  const d = detail || {};
  const tid = d.ticketId || d.ticket?.id || "";
  const ts = d.timestamp || "";
  return tid
    ? `${type}|${ts}|${tid}|${d.agentId || d.assignee || ""}`
    : `${type}|${ts}|${stableJson(d)}`;
}

/**
 * `<ms>-<sha1(contentKey) first 8 hex>`. The 13-digit decimal ms prefix keeps
 * these ids in the SAME lexicographic ordering class as today's direct-write
 * ids (`${Date.now()}-${random}`), so range queries and cursors that compare
 * eventIds as strings (anomaly-watcher readEvents) behave as before.
 *
 * detail.timestamp is the shared clock both writers see; without a parseable
 * one there is nothing deterministic to key on, so we fall back to the legacy
 * random shape (the event is still stored — twice — never dropped) and say so.
 */
export function deterministicEventId(type, detail) {
  const ms = Date.parse(detail?.timestamp);
  if (!Number.isFinite(ms)) {
    console.warn(`[event-id] ${type}: detail.timestamp missing/invalid — falling back to a random id`);
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const hash = createHash("sha1").update(contentKey(type, detail)).digest("hex").slice(0, 8);
  return `${ms}-${hash}`;
}

/**
 * agent.streaming is exempt: many chunks share (type, timestamp-second,
 * ticketId, agentId) and their detail differs only in a partial-text payload,
 * so collapsing them would silently drop heartbeats the dead-session detector
 * reads. Every consumer already skips agent.streaming when deduping.
 */
export const RANDOM_ID_TYPES = new Set(["agent.streaming"]);

/** The one call site shape: off (or an exempt type) → legacy generator, verbatim. */
export function eventIdFor(mode, type, detail, legacyFn) {
  if (mode !== "enforce" || RANDOM_ID_TYPES.has(type)) return legacyFn();
  return deterministicEventId(type, detail);
}
