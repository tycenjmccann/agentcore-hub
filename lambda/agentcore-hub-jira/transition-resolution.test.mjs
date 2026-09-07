/**
 * TEAM-4167 D3 FR-3.2 — the Jira provider's Done-transition contract.
 *
 * A TEAM-4156-class contract test: it drives the REAL handler with a stubbed
 * `fetch`, so what it asserts is the actual response shape the orchestrator /
 * workflow-output see — not a hand-rolled fake. Two things are pinned:
 *   1. a Done transition sets a Jira `resolution` in the POST body AND returns a
 *      top-level `resolvedAt` ISO string (the cross-provider parity field the DDB
 *      Lambda also returns — see agentcore-hub-tickets/index.test.mjs);
 *   2. the guarded fallback: if Jira 400s the body carrying `fields.resolution`
 *      (the field isn't on that project's transition screen), the handler retries
 *      ONCE without it, logs jira.resolution_unsupported, and STILL succeeds — a
 *      Done transition must never fail over the resolution field.
 *
 * TEAM-4262 (ship-review r2-F3) adds the honesty half: the response must
 * distinguish "status transitioned" from "resolution actually set", because
 * stamping resolvedAt on every done transition made the fallback path
 * indistinguishable from the accepted one — the issue closed with no resolution and
 * no resolutiondate while the response claimed a precise resolution instant. Four
 * branches are now pinned:
 *   (1) happy — Jira accepted fields.resolution → resolvedAt ISO,
 *       resolutionSet true, NO resolutionFallback, and ZERO read-back GETs (the
 *       happy path must not pay for the fallback's verification);
 *   (2) fallback-unset — 400 → bare retry, read-back shows resolution null →
 *       resolvedAt NULL (key still present, for parity with the DDB provider),
 *       resolutionSet false, resolutionFallback true, jira.resolution_unset warn;
 *   (3) fallback-confirmed — the read-back shows a resolution after all (a
 *       team-managed project can auto-set it) → resolutionSet true with resolvedAt
 *       normalised from Jira's `resolutiondate`;
 *   (4) fallback-readback-error — the verification GET itself fails → UNCONFIRMED,
 *       never confirmed, and never an error: the transition already succeeded.
 *
 * Run: `node --test lambda/agentcore-hub-jira` from the repo root.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { handler } from "./index.mjs";

const DONE_TRANSITIONS = { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] };
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The TEAM-4262 read-back: GET /issue/{key}?fields=resolution,resolutiondate. */
const isReadback = (url) => String(url).includes("fields=resolution");

/** Run the handler with a stubbed fetch + captured console.warn; always restore. */
async function withStubs({ fetch }, body) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  globalThis.fetch = fetch;
  try {
    const result = await handler(body);
    return { result, warns };
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

const transitionDone = { tool_name: "Tickets___transition_ticket", parameters: { ticket_id: "TEAM-1", transition_id: "done" } };

test("FR-3.2 Jira: a Done transition sets resolution and returns a resolvedAt ISO string", async () => {
  const posts = [];
  let readbacks = 0;
  const { result, warns } = await withStubs({
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      if (isReadback(url)) {
        readbacks += 1;
        return new Response(JSON.stringify({ fields: { resolution: null, resolutiondate: null } }), { status: 200 });
      }
      if (String(url).includes("/transitions") && method === "GET") {
        return new Response(JSON.stringify(DONE_TRANSITIONS), { status: 200 });
      }
      if (String(url).includes("/transitions") && method === "POST") {
        posts.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  }, transitionDone);

  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.status, "done");
  // The parity field the caller reads identically across providers.
  assert.match(result.resolvedAt, ISO_RE);
  // TEAM-4262 — Jira accepted the resolution-bearing body, so the resolution is set
  // BY CONSTRUCTION: claimed true, and no fallback key at all.
  assert.equal(result.resolutionSet, true);
  assert.equal("resolutionFallback" in result, false);
  // The POST carried the resolution — set only, no other fields touched.
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].fields, { resolution: { name: "Done" } });
  assert.deepEqual(Object.keys(posts[0]).sort(), ["fields", "transition"]);
  // No fallback fired on the happy path.
  assert.ok(!warns.some((w) => w.includes("jira.resolution_unsupported")));
  // TEAM-4262 — and the happy path does NOT pay for the fallback's verification:
  // the read-back is one extra GET, spent only when the resolution is in doubt.
  assert.equal(readbacks, 0, "happy path must not issue a read-back GET");
});

/**
 * A fetch stub for the fallback path: the resolution-bearing POST is rejected, the
 * bare retry is accepted, and the read-back answers with whatever `readback`
 * returns. Records the POST bodies and counts the read-backs.
 */
function fallbackStubs(readback) {
  const posts = [];
  const state = { posts, readbacks: 0 };
  state.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (isReadback(url)) {
      state.readbacks += 1;
      return readback();
    }
    if (String(url).includes("/transitions") && method === "GET") {
      return new Response(JSON.stringify(DONE_TRANSITIONS), { status: 200 });
    }
    if (String(url).includes("/transitions") && method === "POST") {
      const parsed = JSON.parse(options.body);
      posts.push(parsed);
      // First attempt (with the resolution field) is rejected; the bare retry
      // is accepted. Mirrors a project whose transition screen omits resolution.
      if (parsed.fields) {
        return new Response(JSON.stringify({ errors: { resolution: "Field 'resolution' cannot be set." } }), { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return state;
}

/** The retry contract, identical on every fallback branch. */
function assertRetriedOnce(state) {
  assert.equal(state.posts.length, 2);
  assert.ok(state.posts[0].fields, "first attempt carried the resolution field");
  assert.equal(state.posts[1].fields, undefined, "retry dropped the resolution field");
  assert.equal(state.readbacks, 1, "exactly one read-back GET");
}

test("FR-3.2 Jira: a 400 on the resolution body retries ONCE without it, logs, and still succeeds", async () => {
  // TEAM-4262 (r2-F3) — this test used to assert `resolvedAt` matched an ISO string
  // here, which PINNED the dishonesty: the retry dropped fields.resolution, so the
  // issue is Done with NO resolution, yet the response named a resolution instant.
  // The read-back confirms resolution is still null, and the response says so.
  const state = fallbackStubs(() =>
    new Response(JSON.stringify({ fields: { resolution: null, resolutiondate: null } }), { status: 200 })
  );
  const { result, warns } = await withStubs({ fetch: state.fetch }, transitionDone);

  assert.equal(result.error, undefined, `transition must not fail over resolution: ${result.error}`);
  // The STATUS change really happened — that half must never regress.
  assert.equal(result.status, "done");
  // …but the resolution did not, and the response no longer pretends otherwise.
  assert.equal(result.resolvedAt, null);
  // The key is still PRESENT (holding null), so a caller can distinguish "Done,
  // resolution unconfirmed" from "not a Done transition" — parity with the DDB
  // provider, whose non-done responses omit the key entirely.
  assert.equal("resolvedAt" in result, true);
  assert.equal(result.resolutionSet, false);
  assert.equal(result.resolutionFallback, true);
  assertRetriedOnce(state);
  assert.ok(warns.some((w) => w.includes("jira.resolution_unsupported")), "logged the fallback");
  // The operator-facing signal: named, and naming the ticket.
  const unset = warns.find((w) => w.includes("jira.resolution_unset"));
  assert.ok(unset, "warned that the resolution is unset");
  assert.ok(unset.includes("TEAM-1"), "the warn names the ticket");
});

test("FR-3.2 Jira: a fallback whose read-back FINDS a resolution reports it set, with the Jira resolutiondate", async () => {
  // A team-managed project can auto-set the resolution even though the transition
  // screen rejected the field — the fallback fired, but the resolution is real, so
  // resolutionSet is true and resolvedAt comes from Jira's own clock rather than ours.
  const state = fallbackStubs(() =>
    new Response(JSON.stringify({
      fields: { resolution: { name: "Done" }, resolutiondate: "2026-09-07T18:00:00.000+0000" },
    }), { status: 200 })
  );
  const { result, warns } = await withStubs({ fetch: state.fetch }, transitionDone);

  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.status, "done");
  assert.equal(result.resolutionSet, true);
  // The fallback still happened — callers can tell this ran the guarded path.
  assert.equal(result.resolutionFallback, true);
  // Jira's `+0000` offset form is normalised to the same ISO shape every other
  // resolvedAt uses, so a consumer never has to parse two formats.
  assert.equal(result.resolvedAt, "2026-09-07T18:00:00.000Z");
  assert.match(result.resolvedAt, ISO_RE);
  assertRetriedOnce(state);
  // Nothing to warn about: the resolution IS set.
  assert.ok(!warns.some((w) => w.includes("jira.resolution_unset")));
});

test("FR-3.2 Jira: a failed read-back is UNCONFIRMED, never confirmed, and never an error", async () => {
  // The transition already succeeded, so losing a real status change over a
  // verification GET would be strictly worse than an unconfirmed resolution. The
  // honest answer to "did it resolve?" when we could not check is "no evidence".
  const state = fallbackStubs(() =>
    new Response(JSON.stringify({ errorMessages: ["Jira exploded"] }), { status: 500 })
  );
  const { result, warns } = await withStubs({ fetch: state.fetch }, transitionDone);

  assert.equal(result.error, undefined, "a failed read-back must not fail the transition");
  assert.equal(result.status, "done");
  assert.equal(result.resolvedAt, null);
  assert.equal(result.resolutionSet, false);
  assert.equal(result.resolutionFallback, true);
  assertRetriedOnce(state);
  const unset = warns.find((w) => w.includes("jira.resolution_unset"));
  assert.ok(unset, "warned that the resolution is unset");
  assert.ok(unset.includes("TEAM-1"), "the warn names the ticket");
  // …and says WHY it is unconfirmed, so ops can tell "confirmed unset" from
  // "could not check".
  assert.ok(unset.includes("read-back failed"), "the warn names the read-back failure");
  assert.ok(unset.includes("500"), "the warn carries Jira's own error");
});

test("FR-3.2 Jira: a non-400 error on the transition still throws (no silent swallow)", async () => {
  const { result } = await withStubs({
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      if (String(url).includes("/transitions") && method === "GET") {
        return new Response(JSON.stringify(DONE_TRANSITIONS), { status: 200 });
      }
      if (String(url).includes("/transitions") && method === "POST") {
        return new Response(JSON.stringify({ errorMessages: ["Jira exploded"] }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  }, transitionDone);

  // handler() catches and surfaces the error rather than masking it as success.
  assert.match(result.error, /500/);
  assert.equal(result.status, undefined);
});
