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

const SOURCE = readFileSync(fileURLToPath(new URL("./index.mjs", import.meta.url)), "utf8");

test("the card's error count sums agent.error + error + agent.died", () => {
  const line = SOURCE.split("\n").find((l) => /^\s*errors:\s*count\(/.test(l));
  assert.ok(line, "buildCard no longer has an `errors: count(...)` row");
  for (const type of ["agent.error", "error", "agent.died"]) {
    assert.ok(
      line.includes(`count("${type}")`),
      `errors row must count ${type} — got: ${line.trim()}`
    );
  }
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
