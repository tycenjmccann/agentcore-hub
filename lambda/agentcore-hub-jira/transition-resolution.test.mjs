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
 * Run: `node --test lambda/agentcore-hub-jira` from the repo root.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { handler } from "./index.mjs";

const DONE_TRANSITIONS = { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] };
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  const { result, warns } = await withStubs({
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
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
  // The POST carried the resolution — set only, no other fields touched.
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].fields, { resolution: { name: "Done" } });
  assert.deepEqual(Object.keys(posts[0]).sort(), ["fields", "transition"]);
  // No fallback fired on the happy path.
  assert.ok(!warns.some((w) => w.includes("jira.resolution_unsupported")));
});

test("FR-3.2 Jira: a 400 on the resolution body retries ONCE without it, logs, and still succeeds", async () => {
  const posts = [];
  const { result, warns } = await withStubs({
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
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
    },
  }, transitionDone);

  assert.equal(result.error, undefined, `transition must not fail over resolution: ${result.error}`);
  assert.equal(result.status, "done");
  assert.match(result.resolvedAt, ISO_RE);
  // Exactly one retry: first body had fields.resolution, the second did not.
  assert.equal(posts.length, 2);
  assert.ok(posts[0].fields, "first attempt carried the resolution field");
  assert.equal(posts[1].fields, undefined, "retry dropped the resolution field");
  assert.ok(warns.some((w) => w.includes("jira.resolution_unsupported")), "logged the fallback");
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
