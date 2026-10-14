/**
 * TEAM-6091: token-less create_ticket is atomic in the Jira twin.
 *
 * Personas cannot pass `client_token`, and the twin's search-before-create guard cannot
 * see an issue a concurrent invocation is still POSTing (nor one Jira's search index has
 * not caught up with) — so two personas that each check-then-create the post-merge
 * follow-up chain both missed it and filed two copies. The create-only S3 claim
 * (ticket-claims/<derived token>.json, gate-contract.mjs) makes exactly one of them POST.
 *
 * Mocked: Jira (globalThis.fetch — the search ALWAYS misses, i.e. the index-lag race)
 * and S3 as an in-memory bucket that honours IfNoneMatch:"*" / IfMatch atomically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import "./hermetic-s3.mjs";

process.env.JIRA_CREATE_CLAIM_POLL_MS = "5";
let loadSeq = 0;

const SUMMARY = "CD: follow-up PR https://github.com/acme/hub/pull/941";
const PARAMS = { summary: SUMMARY, description: "deploy the follow-up PR", parent_key: "TEAM-1", workflow_id: "run1" };

/** A fresh twin wired to a fake Jira + an in-memory bucket. */
async function load({ bucket = "test-bucket", s3Fault = null } = {}) {
  if (bucket) process.env.ARTIFACT_BUCKET = bucket;
  else delete process.env.ARTIFACT_BUCKET;
  const mod = await import(`./index.mjs?claim-race=${loadSeq++}`);
  const objects = new Map();
  const etagOf = (body) => `"${createHash("md5").update(String(body)).digest("hex")}"`;
  const s3Error = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  const tick = () => new Promise((r) => setImmediate(r));
  mod.s3.send = async (cmd) => {
    await tick(); // let concurrent calls interleave; each condition is then atomic
    const key = cmd.input.Key;
    const fault = s3Fault?.(cmd);
    if (fault) throw fault;
    if (cmd.constructor.name === "PutObjectCommand") {
      const cur = objects.get(key);
      if (cmd.input.IfNoneMatch === "*" && cur !== undefined) throw s3Error("PreconditionFailed", 412);
      if (cmd.input.IfMatch !== undefined && cur === undefined) throw s3Error("NoSuchKey", 404);
      if (cmd.input.IfMatch !== undefined && etagOf(cur) !== cmd.input.IfMatch) throw s3Error("PreconditionFailed", 412);
      objects.set(key, String(cmd.input.Body));
      return { ETag: etagOf(cmd.input.Body) };
    }
    if (!objects.has(key)) throw s3Error("NoSuchKey", 404);
    const body = objects.get(key);
    return { ETag: etagOf(body), Body: { transformToString: async () => body } };
  };

  const jira = { posts: 0, issues: new Map(), next: 500 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || "GET";
    await tick();
    if (u.includes("/rest/api/3/search/jql")) return json({ issues: [] }); // the index never has it yet
    if (u.endsWith("/rest/api/3/issue") && method === "POST") {
      jira.posts += 1;
      const key = `TEAM-${jira.next++}`;
      const { fields } = JSON.parse(options.body);
      await tick(); // a POST takes a while — the loser must not create meanwhile
      jira.issues.set(key, { key, fields: { ...fields, status: { name: "To Do" } } });
      return json({ key }, 201);
    }
    const m = u.match(/\/rest\/api\/3\/issue\/(TEAM-\d+)(?:\?|$)/);
    if (m && method === "GET" && jira.issues.has(m[1])) return json(jira.issues.get(m[1]));
    if (m && method === "GET" && m[1] !== "TEAM-1") return json({ errorMessages: ["Issue does not exist"] }, 404);
    if (u.includes("/transitions")) return json({ transitions: [] });
    return json({});
  };
  const create = (params = PARAMS) => mod.handler({ tool_name: "Tickets___create_ticket", parameters: params });
  return { mod, objects, jira, create };
}

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ARTIFACT_BUCKET;
});

test("TEAM-6091: two CONCURRENT creates (same parent + summary, no client_token) create ONE issue and both return its key", async () => {
  const { jira, create } = await load();
  const [a, b] = await Promise.all([create(), create()]);
  assert.equal(jira.posts, 1, `exactly one issue POST, got ${jira.posts}`);
  assert.match(String(a.ticketId), /^TEAM-\d+$/, JSON.stringify(a));
  assert.equal(b.ticketId, a.ticketId, `both calls return the same key: ${JSON.stringify([a, b])}`);
  assert.equal([a.deduplicated, b.deduplicated].filter(Boolean).length, 1, "the loser answers deduplicated");
});

test("TEAM-6091: parent-only scope (no workflow_id) is deduped by the claim too", async () => {
  const { jira, create } = await load();
  const { workflow_id: _wf, ...parentOnly } = PARAMS;
  const [a, b] = await Promise.all([create(parentOnly), create(parentOnly)]);
  assert.equal(jira.posts, 1);
  assert.equal(b.ticketId, a.ticketId);
});

test("TEAM-6091: a claim naming a SETTLED issue is taken over — a legitimate re-file creates a new issue", async () => {
  const { jira, create } = await load();
  const first = await create();
  jira.issues.get(first.ticketId).fields.status = { name: "Done" };
  const [x, y] = await Promise.all([create(), create()]);
  assert.equal(jira.posts, 2, "one new issue for the re-file, not two");
  assert.notEqual(x.ticketId, first.ticketId);
  assert.equal(y.ticketId, x.ticketId);
});

test("TEAM-6091: a key-less claim older than CREATE_CLAIM_STALE_MS (a dead winner) is taken over", async () => {
  const { mod, objects, jira, create } = await load();
  const { deriveCreateDedupeToken, createClaimKey, CREATE_CLAIM_STALE_MS } = await import("./gate-contract.mjs");
  assert.equal(CREATE_CLAIM_STALE_MS, 2 * 60_000, "the documented stale window");
  const key = createClaimKey(deriveCreateDedupeToken({ workflowId: "run1", parentId: "TEAM-1", summary: SUMMARY }));
  objects.set(key, JSON.stringify({ state: "creating", at: new Date(Date.now() - CREATE_CLAIM_STALE_MS - 1000).toISOString() }));
  const res = await create();
  assert.equal(jira.posts, 1);
  assert.equal(JSON.parse(objects.get(key)).key, res.ticketId, "the claim is finalized with the new key");
  assert.ok(mod);
});

test("TEAM-6091: a failed POST abandons the claim, so an immediate retry is not wedged behind it", async () => {
  const { objects, jira, create } = await load();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/rest/api/3/issue") && options.method === "POST") {
      return new Response(JSON.stringify({ errorMessages: ["boom"] }), { status: 500 });
    }
    return realFetch(url, options);
  };
  const failed = await create();
  assert.match(String(failed.error), /Jira API 500/, JSON.stringify(failed));
  globalThis.fetch = realFetch;
  const res = await create();
  assert.equal(jira.posts, 1);
  assert.match(String(res.ticketId), /^TEAM-\d+$/);
  assert.equal([...objects.values()].filter((b) => JSON.parse(b).key === res.ticketId).length, 1);
});

test("TEAM-6091: an S3 claim write that is DENIED fails open — the ticket is still created", async () => {
  const denied = Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  const { jira, create } = await load({ s3Fault: (cmd) => (String(cmd.input.Key).startsWith("ticket-claims/") ? denied : null) });
  const res = await create();
  assert.equal(jira.posts, 1);
  assert.match(String(res.ticketId), /^TEAM-\d+$/);
});

test("TEAM-6091: no scope (no workflow_id, no parent) takes no claim", async () => {
  const { objects, jira, create } = await load();
  await create({ summary: SUMMARY });
  assert.equal(jira.posts, 1);
  assert.equal([...objects.keys()].filter((k) => k.startsWith("ticket-claims/")).length, 0);
});
