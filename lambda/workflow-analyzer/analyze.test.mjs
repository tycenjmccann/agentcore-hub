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
 * TEAM-5238 (review of TEAM-5226) adds: every attempt is time-budgeted and
 * abortable, the classifier covers max_output_tokens_exceeded and name-only
 * errors, the continuation still routes to ANALYZE mode, a rejected same-session
 * continuation rotates to a fresh session, and lookup/claim errors are recorded
 * with the claim released in a finally.
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
process.env.WM_ANALYZE_DELAY_MS = "0"; // auto-trigger tests must not sleep 30s

const mod = await import("./index.mjs");
const { analyze, isMaxTokensError, MAX_CONTINUATIONS } = mod;

const WF = "wf-maxtok-1";
const MAX_TOKENS_MSG =
  "Harness error: MaxTokensReachedException: Agent has reached an unrecoverable state due to max_tokens limit.";

/**
 * workflows Get/Update, events Query/Put, analyses Query — routed by table.
 * `getError` makes the workflow lookup throw; `onUpdate(input)` may throw to
 * fail a claim or a release. Every workflows UpdateCommand input is recorded.
 */
function fakeTables({ getError, onUpdate } = {}) {
  const analyses = new Set(["an-old"]);
  return {
    analyses,
    events: [],
    updates: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      const table = cmd.input.TableName;
      if (table === "test-workflows" && name === "GetCommand") {
        if (getError) throw getError;
        return { Item: { workflowId: WF, phase: "complete", input: { title: "t" } } };
      }
      if (table === "test-workflows" && name === "UpdateCommand") {
        this.updates.push(cmd.input);
        if (onUpdate) onUpdate(cmd.input);
        return {};
      }
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

  it("matches max_output_tokens_exceeded and a name-only MaxTokensReachedException (TEAM-5238)", () => {
    assert.equal(isMaxTokensError({ stopReason: "max_output_tokens_exceeded", text: "" }), true);
    const named = Object.assign(new Error("Model output stopped"), { name: "MaxTokensReachedException" });
    assert.equal(isMaxTokensError(named), true);
    assert.equal(isMaxTokensError(new Error("Agent has reached an unrecoverable state due to max_tokens limit.")), true);
    assert.equal(isMaxTokensError({ stopReason: "timeout_exceeded" }), false);
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
    // TEAM-5238 F3: the first line must still route to ANALYZE mode, not CHAT.
    assert.match(calls[1].prompt, /^ANALYZE wf-maxtok-1 \(continuation 1\/3, defId=software-delivery, outcome=complete, trigger=manual\)\n/);
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
    // Plenty of time for attempt 1; 100s left once it has burned its budget.
    const remainingMs = () => (n === 0 ? 800_000 : 100_000);
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs })));
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

/** The claim-release UpdateCommands the analyzer sent. */
const releases = (client) => client.updates.filter((u) => u.UpdateExpression === "REMOVE wmAutoAnalyzedAt");
const noSleep = async () => {};

describe("analyze — time budget on every attempt (TEAM-5238 F1)", () => {
  it("does not start attempt 1 without enough Lambda time: records the failure and releases the claim", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    await quiet(() =>
      assert.rejects(analyze(WF, "auto", { client, invoke, remainingMs: () => 100_000, releaseSleep: noSleep }), (err) => {
        assert.equal(err.name, "AnalyzeBudgetExceeded");
        return true;
      }),
    );
    assert.equal(n, 0, "no harness invocation when the budget cannot cover one");
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].type, "workflow.analysis_failed");
    assert.equal(client.events[0].detail.errorClass, "AnalyzeBudgetExceeded");
    assert.equal(client.events[0].detail.attempts, 0);
    assert.equal(releases(client).length, 1, "auto claim released");
  });

  it("aborts attempt 1 when it outlives its budget: records the failure and releases the claim", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const seen = [];
    // A harness stream that never ends on its own, like a long ANALYZE session.
    // The timer stands in for the open socket: it keeps the event loop alive,
    // so an unbounded attempt runs into the 5s test timeout instead of the
    // runner cancelling everything after it.
    const invoke = (prompt, session, opts) => {
      seen.push(opts);
      return new Promise((_, reject) => {
        const socket = setTimeout(() => {}, 8000);
        opts?.abortSignal?.addEventListener("abort", () => {
          clearTimeout(socket);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };
    await quiet(() =>
      assert.rejects(
        analyze(WF, "auto", {
          client,
          invoke,
          remainingMs: () => 50,
          limits: { reserveMs: 0, minAttemptMs: 0, harnessSlackS: 0 },
          releaseSleep: noSleep,
        }),
        (err) => {
          assert.equal(err.name, "AnalyzeBudgetExceeded");
          return true;
        },
      ),
    );
    assert.equal(seen.length, 1);
    assert.ok(Number.isFinite(seen[0]?.timeoutSeconds), "attempt 1 gets an explicit harness timeout");
    assert.ok(seen[0].abortSignal?.aborted, "the request was aborted, not left running");
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].detail.errorClass, "AnalyzeBudgetExceeded");
    assert.equal(client.events[0].detail.attempts, 1);
    assert.equal(releases(client).length, 1, "auto claim released");
  });

  it("gives attempt 1 a harness timeout that fits the remaining Lambda time", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const seen = [];
    const invoke = async (prompt, session, opts) => {
      seen.push(opts);
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 870_000 }));
    assert.equal(seen[0].timeoutSeconds, 870 - 60 - 15);
  });
});

describe("analyze — classifier covers every max-tokens shape (TEAM-5238 F2)", () => {
  it("continues after a returned stopReason=max_output_tokens_exceeded", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      if (n === 1) return { text: "", stopReason: "max_output_tokens_exceeded" };
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(n, 2);
    assert.equal(out.attempts, 2);
    assert.deepEqual(out.analysisIds, ["an-new"]);
  });

  it("continues after a thrown error that carries only the MaxTokensReachedException name", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      if (n === 1) throw Object.assign(new Error("Model output stopped"), { name: "MaxTokensReachedException" });
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(n, 2);
    assert.equal(out.attempts, 2);
  });

  it("records the real stop reason, not a hard-coded one", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const invoke = async () => ({ text: "", stopReason: "max_output_tokens_exceeded" });
    await quiet(() =>
      assert.rejects(
        analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }),
        /MaxTokensReachedException: stopReason=max_output_tokens_exceeded/,
      ),
    );
    const { detail } = client.events[0];
    assert.equal(detail.errorClass, "MaxTokensReachedException");
    assert.equal(detail.stopReason, "max_output_tokens_exceeded");
    assert.equal(detail.attempts, 4);
  });
});

describe("analyze — fresh-session fallback (TEAM-5238 F4)", () => {
  it("restarts in a new session with a restart prompt when the same-session continuation is rejected", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const calls = [];
    const invoke = async (prompt, session) => {
      calls.push({ prompt, session });
      if (calls.length === 1) throw new Error(MAX_TOKENS_MSG);
      if (calls.length === 2) {
        throw Object.assign(new Error("toolUse ids without toolResult blocks"), { name: "ValidationException" });
      }
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    // Frozen clock: the fresh session must differ even within one millisecond.
    const realNow = Date.now;
    Date.now = () => 1_790_000_000_000;
    let out;
    try {
      out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.length, 3);
    assert.equal(calls[1].session, calls[0].session, "first continuation reuses the session");
    assert.notEqual(calls[2].session, calls[0].session, "the fallback is a fresh session");
    assert.match(calls[2].prompt, /^ANALYZE wf-maxtok-1 \(restart/);
    assert.match(calls[2].prompt, /workspace is empty/);
    assert.equal(out.attempts, 3);
    assert.equal(client.events.length, 0);
  });

  it("rotates at most once, then records the failure", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      if (n === 1) throw new Error(MAX_TOKENS_MSG);
      throw Object.assign(new Error("bad history"), { name: "ValidationException" });
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }), /bad history/));
    assert.equal(n, 3);
    assert.equal(client.events[0].detail.errorClass, "ValidationException");
  });
});

describe("analyze — errors before the invoke and claim release (TEAM-5238 F6)", () => {
  it("records a workflow lookup error as analysis_failed (stage=lookup) and releases nothing", { timeout: 5000 }, async () => {
    const getError = Object.assign(new Error("Rate exceeded"), { name: "ProvisionedThroughputExceededException" });
    const client = fakeTables({ getError });
    let n = 0;
    const invoke = async () => {
      n++;
      return { text: "", stopReason: "end_turn" };
    };
    await quiet(() => assert.rejects(analyze(WF, "auto", { client, invoke, releaseSleep: noSleep }), /Rate exceeded/));
    assert.equal(n, 0);
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].type, "workflow.analysis_failed");
    assert.equal(client.events[0].detail.errorClass, "ProvisionedThroughputExceededException");
    assert.equal(client.events[0].detail.stage, "lookup");
    assert.equal(releases(client).length, 0, "nothing was claimed, nothing to release");
  });

  it("records a non-conditional claim error (stage=claim) and does not release a claim it never took", { timeout: 5000 }, async () => {
    const client = fakeTables({
      onUpdate: (u) => {
        if (u.UpdateExpression.startsWith("SET wmAutoAnalyzedAt")) {
          throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
        }
      },
    });
    await quiet(() => assert.rejects(analyze(WF, "auto", { client, invoke: async () => ({}), releaseSleep: noSleep }), /Throttled/));
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].detail.stage, "claim");
    assert.equal(releases(client).length, 0);
  });

  it("retries the claim release, and a final release failure still surfaces the original error", { timeout: 5000 }, async () => {
    const client = fakeTables({
      onUpdate: (u) => {
        if (u.UpdateExpression === "REMOVE wmAutoAnalyzedAt") throw new Error("release blip");
      },
    });
    const invoke = async () => {
      throw new Error("Harness error: ThrottlingException");
    };
    const errors = [];
    const realError = console.error;
    await quiet(async () => {
      console.error = (...a) => errors.push(a.join(" "));
      try {
        await assert.rejects(
          analyze(WF, "auto", { client, invoke, remainingMs: () => 800_000, releaseSleep: noSleep }),
          /ThrottlingException/,
        );
      } finally {
        console.error = realError;
      }
    });
    assert.equal(releases(client).length, 3, "release attempted 3 times");
    assert.ok(errors.some((l) => /CLAIM RELEASE FAILED/.test(l) && /wmAutoAnalyzedAt left set/.test(l)));
    assert.equal(client.events.length, 1, "the failure event was still written");
  });

  it("recovers when a release attempt fails once", { timeout: 5000 }, async () => {
    let fails = 1;
    const client = fakeTables({
      onUpdate: (u) => {
        if (u.UpdateExpression === "REMOVE wmAutoAnalyzedAt" && fails-- > 0) throw new Error("release blip");
      },
    });
    const invoke = async () => {
      throw new Error("Harness error: ThrottlingException");
    };
    await quiet(() => assert.rejects(analyze(WF, "auto", { client, invoke, remainingMs: () => 800_000, releaseSleep: noSleep })));
    assert.equal(releases(client).length, 2);
  });
});
