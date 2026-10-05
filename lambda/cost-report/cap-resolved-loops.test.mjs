// TEAM-5321 FR-7 — each `review.cap_resolved` is exactly one loop on the card.
//
// A reviewer cap resolved with follow-ups ends the review loop without another
// rejection, so neither changeRequests nor fixTickets sees it. The WM toolkit's
// compute_change_requests counts it as one loop; `quality.loops` mirrors that.
//
// buildCard() is not exported and needs the full AWS surface, so (as in
// agent-died-count.test.mjs) the sum is pinned on the source, and the event
// name through the exported constant.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAP_RESOLVED_EVENT } from "./index.mjs";

const SOURCE = readFileSync(fileURLToPath(new URL("./index.mjs", import.meta.url)), "utf8");

test("the cap-resolved event name is review.cap_resolved", () => {
  assert.equal(CAP_RESOLVED_EVENT, "review.cap_resolved");
});

test("capResolved counts the event, once per event", () => {
  assert.match(SOURCE, /const capResolved = count\(CAP_RESOLVED_EVENT\);/);
});

test("loops = changeRequests + fixTickets + capResolved; changeRequests is unchanged", () => {
  const line = SOURCE.split("\n").find((l) => /^\s*loops:/.test(l));
  assert.ok(line, "buildCard no longer has a `loops:` row");
  assert.match(line, /loops:\s*changeRequests \+ fixTickets \+ capResolved,/);
  const cr = SOURCE.split("\n").find((l) => /^\s*const changeRequests = /.test(l));
  assert.ok(cr && !cr.includes("CAP_RESOLVED"), "a cap resolution is a loop, not a change request");
});
