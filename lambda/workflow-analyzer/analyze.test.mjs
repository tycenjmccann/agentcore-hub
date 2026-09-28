/**
 * lambda/workflow-analyzer/analyze.test.mjs
 *
 * TEAM-5226: ANALYZE died with MaxTokensReachedException mid tool call and left
 * nothing behind — no analysis row, no event, a silent UI. This suite pins the
 * two halves of the fix in the analyzer's invoke loop:
 *   - a max-tokens stop re-invokes the SAME session with a continuation prompt,
 *     at most MAX_CONTINUATIONS times (and never past the Lambda's time budget);
 *   - a final failure writes one `workflow.analysis_failed` event, then rethrows.
 *
 * Hermetic: analyze() takes `client` / `invoke` / `remainingMs`, and one fake
 * client routes by TableName (no module mocking — Node 20 has no mock.module).
 *
 * Run: `node --test lambda/workflow-analyzer/analyze.test.mjs` from the repo root.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.AWS_REGION = "us-east-1";
process.env.ANALYSES_TABLE = "test-analyses";
process.env.WORKFLOWS_TABLE = "test-workflows";
process.env.EVENTS_TABLE = "test-events";
process.env.WORKFLOW_MANAGER_ARN = "arn:test:harness";
delete process.env.HUB_REPO_URL; // keeps maybeSynthesize a no-op

const mod = await import("./index.mjs");
const { analyze, isMaxTokensError, MAX_CONTINUATIONS } = mod;

const WF = "wf-maxtok-1";
const MAX_TOKENS_MSG =
  "Harness error: MaxTokensReachedException: Agent has reached an unrecoverable state due to max_tokens limit.";

/** workflows Get, events Query/Put, analyses Query — routed by table. */
function fakeTables() {
  const analyses = new Set(["an-old"]);
  return {
    analyses,
    events: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      const table = cmd.input.TableName;
      if (table === "test-workflows" && name === "GetCommand") {
        return { Item: { workflowId: WF, phase: "complete", input: { title: "t" } } };
      }
      if (table === "test-workflows" && name === "UpdateCommand") return {};
      if (table === "test-events" && name === "QueryCommand") return { Items: [] };
      if (table === "test-events" && name === "PutCommand") {
        this.events.push(cmd.input.Item);
        return {};
      }
      if (table === "test-analyses" && name === "QueryCommand") {
        return { Items: [...analyses].map((analysisId) => ({ analysisId })) };
      }
      throw new Error(`fakeTables: unexpected ${name} on ${table}`);
    },
  };
}

async function quiet(fn) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, real);
  }
}

describe("isMaxTokensError", () => {
  it("matches the harness error text and a max_tokens stopReason", () => {
    assert.equal(isMaxTokensError(new Error(MAX_TOKENS_MSG)), true);
    assert.equal(isMaxTokensError(new Error("Model stopped generating due to maximum token limit")), true);
    assert.equal(isMaxTokensError({ stopReason: "max_tokens", text: "" }), true);
    assert.equal(isMaxTokensError(new Error("Harness error: ThrottlingException")), false);
    assert.equal(isMaxTokensError({ stopReason: "end_turn" }), false);
  });
});

describe("analyze — max-tokens continuation (TEAM-5226)", () => {
  it("continues the same session once after a max-tokens stop and completes", async () => {
    const client = fakeTables();
    const calls = [];
    const invoke = async (prompt, session, opts) => {
      calls.push({ prompt, session, opts });
      if (calls.length === 1) throw new Error(MAX_TOKENS_MSG);
      client.analyses.add("an-new"); // save_analysis.py ran on the continuation
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].session, calls[0].session, "continuation must reuse the session");
    assert.match(calls[0].prompt, /^ANALYZE wf-maxtok-1/);
    assert.match(calls[1].prompt, /^CONTINUE ANALYZE wf-maxtok-1/);
    assert.match(calls[1].prompt, /analysis\.d\/<key>\.json/);
    assert.ok(calls[1].opts.timeoutSeconds <= 740, "continuation timeout fits the remaining Lambda time");
    assert.deepEqual(out.analysisIds, ["an-new"]);
    assert.equal(out.attempts, 2);
    assert.equal(client.events.length, 0, "a recovered analysis writes no failure event");
  });

  it("stops after 1 + MAX_CONTINUATIONS invocations and records workflow.analysis_failed", async () => {
    assert.equal(MAX_CONTINUATIONS, 3);
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      throw new Error(MAX_TOKENS_MSG);
    };
    await quiet(() =>
      assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }), /MaxTokensReached/),
    );
    assert.equal(n, 4);
    assert.equal(client.events.length, 1);
    const ev = client.events[0];
    assert.equal(ev.type, "workflow.analysis_failed");
    assert.equal(ev.workflowId, WF);
    assert.match(ev.eventId, /^\d{13}-[a-z0-9]+$/, "eventId keeps the <ms>- prefix the stream cursor needs");
    assert.ok(ev.ttl > Date.now() / 1000);
    assert.equal(ev.detail.errorClass, "MaxTokensReachedException");
    assert.equal(ev.detail.attempts, 4);
    assert.equal(ev.detail.trigger, "manual");
    assert.equal(ev.detail.stopReason, "max_tokens");
  });

  it("treats a returned stopReason=max_tokens the same as the thrown error", async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      return { text: "", stopReason: "max_tokens" };
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 })));
    assert.equal(n, 4);
    assert.equal(client.events[0].detail.attempts, 4);
  });

  it("does not continue when the Lambda is out of time, but still records the failure", async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      throw new Error(MAX_TOKENS_MSG);
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs: () => 60_000 })));
    assert.equal(n, 1);
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].detail.attempts, 1);
  });

  it("does not retry a non-max-tokens error, and records it with its class", async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      throw new Error("Harness error: ThrottlingException");
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke }), /Throttling/));
    assert.equal(n, 1);
    assert.equal(client.events[0].detail.errorClass, "Error");
    assert.equal(client.events[0].detail.stopReason, undefined);
  });
});
