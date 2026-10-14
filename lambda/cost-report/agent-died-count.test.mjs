// TEAM-4739 — a killed persona must show up in the card's error count.
//
// WP4 gave the runtime a DISTINCT event for "the process vanished mid-turn":
// `agent.died` is published INSTEAD of `agent.error`, never alongside it (that is
// what lets the detector tell a retryable death from an exhausted model call).
// The consequence for this Lambda is blunt: before this change a run whose
// personas were all killed reported `errors: 0` and scored as clean, because the
// card summed only `agent.error` + `error`.
//
// buildCard() is not exported and needs the full AWS surface (spans, S3, DDB), so
// this pins the two halves that are reachable offline:
//   1. the sum in buildCard() names all three event types (source assertion — the
//      only way to catch a future edit that drops one);
//   2. an `agent.died` row survives dedupeEvents() and matches the same
//      `e.type === type` predicate `count()` uses, including the de-dup of the
//      double-published copy the events table can hold.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dedupeEvents } from "./index.mjs";
// Namespace import (TEAM-5977): on a tree without countErrors each test below
// fails on its own instead of the whole file failing to load.
import * as costReport from "./index.mjs";

const SOURCE = readFileSync(fileURLToPath(new URL("./index.mjs", import.meta.url)), "utf8");

test("the card's error count is countErrors, which names agent.error + error + agent.died + agent.retry", () => {
  const line = SOURCE.split("\n").find((l) => /^\s*errors:\s*/.test(l) && l.includes("count"));
  assert.ok(line, "buildCard no longer has an `errors:` row");
  assert.match(line, /errors:\s*countErrors\(events\)/, `errors row must use countErrors — got: ${line.trim()}`);
  const body = SOURCE.slice(SOURCE.indexOf("export function countErrors"));
  assert.ok(SOURCE.includes("export function countErrors"), "countErrors is gone");
  const types = body.slice(0, body.indexOf("\n}\n"));
  for (const type of ["agent.error", "error", "agent.died", "agent.retry"]) {
    assert.ok(types.includes(`"${type}"`), `countErrors must count ${type}`);
  }
});

// TEAM-5977 — one death is one error. A transient-exhaustion turn (TEAM-5963)
// publishes the runtime's agent.error AND agent.died{reason:"transient_exhaustion"},
// and the reaper then announces the same claim as agent.error{reason:"dead_session"}.
const AGENT = "backend_dev";
const runtimeErr = (ticketId, ts) => ({
  type: "agent.error", timestamp: ts,
  detail: { workflowId: "wf1", agentId: AGENT, ticketId, error: "stream failed after 10 attempt(s): ServiceUnavailableException" },
});
const exhaustionDeath = (ticketId, ts, gen) => ({
  type: "agent.died", timestamp: ts,
  detail: { workflowId: "wf1", agentId: AGENT, ticketId, sessionId: "s1", claimStartedAt: gen, reason: "transient_exhaustion" },
});
const reaperErr = (ticketId, ts, gen) => ({
  type: "agent.error", timestamp: ts,
  detail: { workflowId: "wf1", agentId: AGENT, ticketId, reason: "dead_session", detectorMeta: { claimStartedAt: gen, positiveDeath: true } },
});

test("countErrors: an exhaustion triple (runtime error + exhaustion death + reaper dead_session) is ONE error", () => {
  const G = "2026-10-14T10:00:00.000Z";
  const rows = dedupeEvents([
    runtimeErr("TEAM-1", "2026-10-14T10:20:00.111111Z"),
    exhaustionDeath("TEAM-1", "2026-10-14T10:20:01.222222Z", G),
    reaperErr("TEAM-1", "2026-10-14T10:55:00.000Z", G),
  ]);
  assert.equal(costReport.countErrors(rows), 1);
});

test("countErrors: an unrelated agent.error and an unrelated agent.died still count 2", () => {
  const rows = dedupeEvents([
    runtimeErr("TEAM-A", "2026-10-14T10:20:00.111111Z"),
    { type: "agent.died", timestamp: "2026-10-14T10:30:00.333333Z",
      detail: { workflowId: "wf1", agentId: AGENT, ticketId: "TEAM-B", claimStartedAt: "2026-10-14T10:00:00.000Z" } },
  ]);
  assert.equal(costReport.countErrors(rows), 2);
});

test("countErrors: two separate exhaustions on the same ticket are TWO errors", () => {
  const G1 = "2026-10-14T10:00:00.000Z";
  const G2 = "2026-10-14T11:00:00.000Z";
  const rows = dedupeEvents([
    runtimeErr("TEAM-1", "2026-10-14T10:20:00.111111Z"),
    exhaustionDeath("TEAM-1", "2026-10-14T10:20:01.222222Z", G1),
    reaperErr("TEAM-1", "2026-10-14T10:55:00.000Z", G1),
    runtimeErr("TEAM-1", "2026-10-14T11:20:00.444444Z"),
    exhaustionDeath("TEAM-1", "2026-10-14T11:20:01.555555Z", G2),
    reaperErr("TEAM-1", "2026-10-14T11:55:00.000Z", G2),
  ]);
  assert.equal(costReport.countErrors(rows), 2);
});

test("countErrors: an exhaustion death whose agent.error publish was lost is still ONE error", () => {
  const rows = dedupeEvents([exhaustionDeath("TEAM-1", "2026-10-14T10:20:01.222222Z", "2026-10-14T10:00:00.000Z")]);
  assert.equal(costReport.countErrors(rows), 1);
});

test("an agent.died row is countable: it survives dedupe and matches by type", () => {
  // The shape _publish_agent_died writes (deploy/runtime-agent/main.py): a
  // detail-carried ticketId/agentId + its own numeric-fraction timestamp, which
  // is the key dedupeEvents uses to collapse the double-publish.
  const died = (ms) => ({
    type: "agent.died",
    timestamp: `2026-09-15T00:41:08.${ms}Z`,
    detail: { workflowId: "wf1", ticketId: "TEAM-4700", agentId: "backend_dev", timestamp: "2026-09-15T00:41:08.123456Z" },
  });
  const rows = dedupeEvents([
    died("123"),
    died("187"), // same detail clock, row timestamp ms apart → one event
    { type: "agent.error", timestamp: "2026-09-15T00:10:00Z", detail: { ticketId: "TEAM-4701" } },
    { type: "agent.streaming", timestamp: "2026-09-15T00:41:00Z", detail: { ticketId: "TEAM-4700" } },
  ]);
  const count = (type) => rows.filter((e) => e.type === type).length;
  assert.equal(count("agent.died"), 1, "the double-published death must count once");
  assert.equal(count("agent.error"), 1);
  assert.equal(count("agent.died") + count("agent.error") + count("error"), 2);
});

// TEAM-6044 — the runtime fills a timestamp's fraction with UUID digits, not
// elapsed time, and the exhaustion path writes its agent.error and agent.died in
// the same second. So the error's timestamp sorts AFTER the death's about half
// the time; pairing on that string order counted one exhaustion as 2 (or 3).
// eventId's 13-digit prefix is the real epoch-ms, and a stamped error carries
// the claim generation, so neither depends on the fraction.
const T12 = 1791979200000; // 2026-10-14T12:00:00Z
const T13 = 1791982800000; // 2026-10-14T13:00:00Z
const withId = (row, ms, tag) => ({ ...row, eventId: `${ms}-${tag}-${row.timestamp.slice(20, 26)}` });
const stampedErr = (ticketId, ts, gen) => {
  const e = runtimeErr(ticketId, ts);
  return { ...e, detail: { ...e.detail, reason: "transient_exhaustion", claimStartedAt: gen } };
};

test("countErrors: a same-second triple whose error fraction sorts after the death is ONE error (TEAM-6044)", () => {
  const G = "2026-10-14T11:00:00.000Z";
  const rows = dedupeEvents([
    withId(runtimeErr("TEAM-1", "2026-10-14T12:00:00.900000Z"), T12 + 400, "err"),
    withId(exhaustionDeath("TEAM-1", "2026-10-14T12:00:00.100000Z", G), T12 + 450, "died"),
    reaperErr("TEAM-1", "2026-10-14T12:35:00.000Z", G),
  ]);
  assert.equal(costReport.countErrors(rows), 1);
});

test("countErrors: the same-second triple with no eventId (legacy rows) is still ONE error (TEAM-6044)", () => {
  const G = "2026-10-14T11:00:00.000Z";
  const rows = dedupeEvents([
    runtimeErr("TEAM-1", "2026-10-14T12:00:00.900000Z"),
    exhaustionDeath("TEAM-1", "2026-10-14T12:00:00.100000Z", G),
    reaperErr("TEAM-1", "2026-10-14T12:35:00.000Z", G),
  ]);
  assert.equal(costReport.countErrors(rows), 1);
});

test("countErrors: two same-second-reversed exhaustions on one ticket are TWO errors (TEAM-6044)", () => {
  const G1 = "2026-10-14T11:00:00.000Z";
  const G2 = "2026-10-14T12:30:00.000Z";
  const rows = dedupeEvents([
    withId(runtimeErr("TEAM-1", "2026-10-14T12:00:00.900000Z"), T12 + 400, "err"),
    withId(exhaustionDeath("TEAM-1", "2026-10-14T12:00:00.100000Z", G1), T12 + 450, "died"),
    reaperErr("TEAM-1", "2026-10-14T12:35:00.000Z", G1),
    withId(runtimeErr("TEAM-1", "2026-10-14T13:00:00.800000Z"), T13 + 200, "err"),
    withId(exhaustionDeath("TEAM-1", "2026-10-14T13:00:00.200000Z", G2), T13 + 260, "died"),
    reaperErr("TEAM-1", "2026-10-14T13:35:00.000Z", G2),
  ]);
  assert.equal(costReport.countErrors(rows), 2);
});

test("countErrors: an unrelated error and an exhaustion death in the same second still count 2 (TEAM-6044)", () => {
  // Same second, error ordered first — but on another ticket, so it is not this
  // death's error.
  const rows = dedupeEvents([
    withId(runtimeErr("TEAM-A", "2026-10-14T12:00:00.050000Z"), T12 + 50, "err"),
    withId(exhaustionDeath("TEAM-B", "2026-10-14T12:00:00.100000Z", "2026-10-14T11:00:00.000Z"), T12 + 100, "died"),
  ]);
  assert.equal(costReport.countErrors(rows), 2);
});

test("countErrors: a stamped exhaustion error folds by claimStartedAt whatever its order (TEAM-6044)", () => {
  const G = "2026-10-14T11:00:00.000Z";
  const rows = dedupeEvents([
    // Written after the death by every clock the row has — only identity pairs it.
    withId(stampedErr("TEAM-1", "2026-10-14T12:00:01.900000Z", G), T12 + 1900, "err"),
    withId(exhaustionDeath("TEAM-1", "2026-10-14T12:00:00.100000Z", G), T12 + 100, "died"),
    reaperErr("TEAM-1", "2026-10-14T12:35:00.000Z", G),
  ]);
  assert.equal(costReport.countErrors(rows), 1);
});

test("countErrors: a stamped error from ANOTHER claim is not folded into this death (TEAM-6044)", () => {
  const rows = dedupeEvents([
    withId(stampedErr("TEAM-1", "2026-10-14T12:00:00.050000Z", "2026-10-14T10:00:00.000Z"), T12 + 50, "err"),
    withId(exhaustionDeath("TEAM-1", "2026-10-14T12:00:00.100000Z", "2026-10-14T11:00:00.000Z"), T12 + 100, "died"),
  ]);
  assert.equal(costReport.countErrors(rows), 2);
});
