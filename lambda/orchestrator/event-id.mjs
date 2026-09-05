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
 * Rollout: EVENT_DEDUPE_MODE = off (default) | enforce. `off` is byte-identical
 * to pre-4120 — eventIdFor delegates straight to the caller's legacy generator.
 * Instant rollback = set off. Note that the flag must agree across ALL THREE
 * writers (orchestrator, agent-invoker, events-writer) for the overwrite to
 * happen, which is why deploy.sh forwards it to all three.
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
 * STRICT allow-list, same fail-safe direction as the ship gates: only an exact
 * "enforce" (case- and whitespace-insensitive) turns the collapse on. Legacy
 * truthy spellings ("on"/"true"/"1") and the mode word "shadow" — which this
 * flag deliberately does NOT implement, since there is nothing to observe
 * without writing — all coalesce to off. A typo can never change what gets
 * written to the events table.
 */
export function normalizeEventDedupeMode(v) {
  return String(v ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "off";
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
