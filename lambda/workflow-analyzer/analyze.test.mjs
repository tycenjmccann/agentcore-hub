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
const { analyze, isMaxTokensError, harnessErrorClass, readHarnessStream, MAX_CONTINUATIONS, persistedSince } = mod;

const WF = "wf-maxtok-1";
const MAX_TOKENS_MSG =
  "Harness error: MaxTokensReachedException: Agent has reached an unrecoverable state due to max_tokens limit.";

/** An async-iterable stream of InvokeHarnessCommand frames, for readHarnessStream. */
async function* frames(events) {
  for (const e of events) yield e;
}

/**
 * workflows Get/Update, events Query/Put, analyses Query — routed by table.
 * `getError` makes the workflow lookup throw; `onUpdate(input)` may throw to
 * fail a claim or a release. Every workflows UpdateCommand input is recorded.
 * `onAnalysesQuery(n)` sees each analyses read (n = 1-based ordinal) and may
 * throw to fail it (TEAM-5242: a read failure must never read as "saved").
 */
function fakeTables({ getError, onUpdate, onAnalysesQuery } = {}) {
  const analyses = new Set(["an-old"]);
  return {
    analyses,
    events: [],
    updates: [],
    analysesReads: 0,
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
        this.analysesReads++;
        if (onAnalysesQuery) onAnalysesQuery(this.analysesReads);
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

describe("harnessErrorClass / readHarnessStream (TEAM-5244)", () => {
  it("pulls the leading <Name>Exception|Error out of a harness message", () => {
    assert.equal(harnessErrorClass("ValidationException: too many toolUse ids"), "ValidationException");
    assert.equal(harnessErrorClass("ThrottlingException"), "ThrottlingException");
    assert.equal(harnessErrorClass("FooError: x"), "FooError");
  });

  it("falls back to RuntimeClientError when the message has no recognizable class", () => {
    assert.equal(harnessErrorClass("something broke"), "RuntimeClientError");
    assert.equal(harnessErrorClass(""), "RuntimeClientError");
    assert.equal(harnessErrorClass(undefined), "RuntimeClientError");
  });

  it("a runtimeClientError frame becomes an Error named after its class", async () => {
    await assert.rejects(
      readHarnessStream(frames([{ runtimeClientError: { message: "ValidationException: bad history" } }])),
      (err) => {
        assert.equal(err.name, "ValidationException");
        assert.equal(err.message, "Harness error: ValidationException: bad history");
        return true;
      },
    );
  });

  it("a runtimeClientError frame with no recognizable class becomes RuntimeClientError", async () => {
    await assert.rejects(
      readHarnessStream(frames([{ runtimeClientError: { message: "something broke" } }])),
      (err) => {
        assert.equal(err.name, "RuntimeClientError");
        return true;
      },
    );
  });

  it("isMaxTokensError still matches a max-tokens runtimeClientError frame by name", async () => {
    await assert.rejects(
      readHarnessStream(frames([{
        runtimeClientError: { message: "MaxTokensReachedException: Agent has reached an unrecoverable state due to max_tokens limit." },
      }])),
      (err) => {
        assert.equal(isMaxTokensError(err), true);
        return true;
      },
    );
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
    // TEAM-5239: the continuation is where superseded parts are born, so it
    // names the generation marker save_analysis.py merges by.
    assert.match(calls[1].prompt, /analysis\.d\/manifest\.json/);
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

  // TEAM-5240: the UI matches a failure to the attempt it is polling, so every
  // failure event names its attempt — the caller's id, or one minted here for
  // callers that cannot pass one (the EventBridge auto path, anomaly-watcher).
  it("records the caller's attemptId on workflow.analysis_failed", async () => {
    const client = fakeTables();
    const invoke = async () => { throw new Error("Harness error: ThrottlingException"); };
    await quiet(() =>
      assert.rejects(analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000, attemptId: "att-1" })),
    );
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].detail.attemptId, "att-1");
  });

  it("mints an attemptId when the caller passes none", async () => {
    const client = fakeTables();
    const invoke = async () => { throw new Error("Harness error: ThrottlingException"); };
    await quiet(() => assert.rejects(analyze(WF, "auto", { client, invoke, remainingMs: () => 800_000 })));
    assert.equal(client.events.length, 1);
    assert.match(String(client.events[0].detail.attemptId), /^[0-9a-f-]{36}$/);
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

  it("does not retry a non-max-tokens runtimeClientError, and records its class (TEAM-5244)", async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      return readHarnessStream(frames([{ runtimeClientError: { message: "ValidationException: too many toolUse ids without a toolResult" } }]));
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke }), /ValidationException/));
    assert.equal(n, 1);
    assert.equal(client.events[0].detail.errorClass, "ValidationException");
    assert.equal(client.events[0].detail.stopReason, undefined);
  });

  it("records RuntimeClientError when a runtimeClientError frame has no recognizable class (TEAM-5244)", async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      return readHarnessStream(frames([{ runtimeClientError: { message: "something broke" } }]));
    };
    await quiet(() => assert.rejects(analyze(WF, "manual", { client, invoke })));
    assert.equal(n, 1);
    assert.equal(client.events[0].detail.errorClass, "RuntimeClientError");
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

describe("analyze — non-finite / oversized time budget (TEAM-5247)", () => {
  it("succeeds with no remainingMs (the handler's own no-context default of Infinity)", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const seen = [];
    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on("warning", onWarning);
    const invoke = async (prompt, session, opts) => {
      seen.push(opts);
      // Stands in for a real harness call that takes a little time, unlike
      // every other test's invoke which resolves on the same tick.
      await new Promise((r) => setTimeout(r, 20));
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    try {
      const out = await quiet(() => analyze(WF, "manual", { client, invoke }));
      assert.deepEqual(out.analysisIds, ["an-new"]);
    } finally {
      process.off("warning", onWarning);
    }
    assert.equal(seen.length, 1);
    // Infinity remainingMs must still produce a real, harness-side timeout —
    // Math.min(900, ...) clamps it to the Lambda's 900s ceiling.
    assert.equal(seen[0].timeoutSeconds, 900);
    assert.equal(client.events.length, 0, "no analysis_failed written");
    assert.ok(
      !warnings.some((w) => /TimeoutOverflowWarning/.test(w?.name || w?.message || "")),
      "setTimeout must never be armed with a non-finite delay",
    );
  });

  it("succeeds with a finite remainingMs above the 2^31-1 setTimeout ceiling", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const seen = [];
    const invoke = async (prompt, session, opts) => {
      seen.push(opts);
      await new Promise((r) => setTimeout(r, 20));
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    // 2**31 + 120_000 ms of "remaining time" is not realistic for a real Lambda
    // context, but remainingMs is a caller-supplied function — nothing stops a
    // huge value, and setTimeout silently clamps anything over 2**31-1 to 1ms.
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 2 ** 31 + 120_000 }));
    assert.deepEqual(out.analysisIds, ["an-new"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].timeoutSeconds, 900);
    assert.equal(client.events.length, 0, "no analysis_failed written");
  });
});

describe("analyze — invalid time budget fails closed (TEAM-5250)", () => {
  // Only +Infinity means "no deadline". NaN (or undefined, which becomes NaN
  // after `- reserveMs`) used to slip past the budget guard, disable the JS
  // deadline and send the harness timeoutSeconds: NaN.
  async function assertFailsClosed(remainingMs) {
    const client = fakeTables();
    const seen = [];
    const invoke = async (prompt, session, opts) => {
      seen.push(opts);
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    await quiet(() =>
      assert.rejects(analyze(WF, "auto", { client, invoke, remainingMs, releaseSleep: noSleep }), (err) => {
        assert.equal(err.name, "AnalyzeBudgetExceeded");
        return true;
      }),
    );
    assert.equal(seen.length, 0, "no harness invocation without a valid deadline");
    assert.ok(
      seen.every((o) => Number.isFinite(o?.timeoutSeconds) && o.timeoutSeconds <= 900),
      "never invoke with a non-finite timeoutSeconds",
    );
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].type, "workflow.analysis_failed");
    assert.equal(client.events[0].detail.errorClass, "AnalyzeBudgetExceeded");
    assert.equal(client.events[0].detail.attempts, 0);
    assert.equal(releases(client).length, 1, "auto claim released");
  }

  it("rejects a NaN remainingMs with AnalyzeBudgetExceeded before invoking", { timeout: 5000 }, async () => {
    await assertFailsClosed(() => NaN);
  });

  it("rejects an undefined-returning remainingMs with AnalyzeBudgetExceeded before invoking", { timeout: 5000 }, async () => {
    await assertFailsClosed(() => undefined);
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
    assert.match(calls[2].session, /^wmr-/, "TEAM-5242: a no-save rotation still happens, on the rotation prefix");
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

/**
 * TEAM-5242 (review round 2 of TEAM-5226): save_analysis.py mints a NEW
 * analysisId per run, so re-invoking the harness after a save — a same-session
 * continuation, a fresh-session rotation — writes a second row, and a terminal
 * max-tokens throw after a save records analysis_failed beside a good analysis
 * and releases the auto claim. Before every continuation, rotation or terminal
 * throw the loop now re-reads the analyses; a new row since `before` ends the
 * run on the success path. A read failure (null) changes nothing.
 */
describe("analyze — a save that already landed ends the run (TEAM-5242)", () => {
  const THROTTLED = () => new Error("Harness error: ThrottlingException");

  it("N1: save on attempt 1, then max tokens — does not continue, does not rotate, one row", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const calls = [];
    const invoke = async (prompt, session) => {
      calls.push({ prompt, session });
      if (calls.length === 1) {
        client.analyses.add("an-1"); // save_analysis.py ran, then step 5 hit the cap
        throw new Error(MAX_TOKENS_MSG);
      }
      if (calls.length === 2) throw THROTTLED(); // the continuation would be rejected…
      client.analyses.add("an-2"); // …and a rotated fresh session would save AGAIN
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(calls.length, 1, "no continuation after a save");
    assert.ok(!calls.some((c) => /^wmr-/.test(c.session)), "no rotation after a save");
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.deepEqual([...client.analyses].sort(), ["an-1", "an-old"], "exactly one row was written");
    assert.equal(out.attempts, 1);
    assert.equal(out.stopReason, "max_tokens", "reports what actually stopped the harness");
    assert.equal(client.events.length, 0, "no analysis_failed beside a good analysis");
  });

  it("N1 (catch site): save lands during the continuation, which is then rejected — no rotation", { timeout: 5000 }, async () => {
    const client = fakeTables();
    const calls = [];
    const invoke = async (prompt, session) => {
      calls.push({ prompt, session });
      if (calls.length === 1) throw new Error(MAX_TOKENS_MSG);
      if (calls.length === 2) {
        client.analyses.add("an-1");
        throw Object.assign(new Error("toolUse ids without toolResult blocks"), { name: "ValidationException" });
      }
      client.analyses.add("an-2");
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(calls.length, 2, "the rejected continuation ends the run instead of rotating");
    assert.equal(calls[1].session, calls[0].session);
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.equal(out.attempts, 2);
    assert.equal(client.events.length, 0);
  });

  it("N2: save on attempt 1, then max tokens on every attempt — success, no failure event, auto claim kept", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      if (n === 1) client.analyses.add("an-1");
      throw new Error(MAX_TOKENS_MSG);
    };
    const out = await quiet(() => analyze(WF, "auto", { client, invoke, remainingMs: () => 800_000, releaseSleep: noSleep }));
    assert.equal(n, 1);
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.equal(out.trigger, "auto");
    assert.equal(client.events.length, 0, "no workflow.analysis_failed");
    assert.equal(client.updates.filter((u) => u.UpdateExpression.startsWith("SET wmAutoAnalyzedAt")).length, 1, "claimed");
    assert.equal(releases(client).length, 0, "the claim is kept: a redelivered event must not re-analyse");
  });

  it("save on attempt 1, then a non-max-tokens harness error — still a success (no result to report from)", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      client.analyses.add("an-1");
      throw THROTTLED();
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(n, 1);
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.equal(out.attempts, 1);
    assert.equal(typeof out.stopReason, "string");
    assert.equal(out.summary, "");
    assert.equal(client.events.length, 0);
  });

  it("reports the persisting attempt, not an earlier returned max-tokens result (TEAM-5229 N4)", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      if (n === 1) return { text: "attempt-1 text", stopReason: "max_tokens" };
      client.analyses.add("an-1");
      throw Object.assign(new Error("stream reset"), { name: "ModelStreamErrorException" });
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(n, 2);
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.equal(out.attempts, 2);
    assert.notEqual(out.stopReason, "max_tokens", "not attempt 1's stale stop reason");
    assert.equal(out.stopReason, "ModelStreamErrorException");
    assert.equal(out.summary, "", "not attempt 1's text");
    assert.equal(client.events.length, 0);
  });

  it("a failed analyses read never turns a harness error into a success", { timeout: 5000 }, async () => {
    // `before` (read 1) succeeds; every later read is throttled.
    const client = fakeTables({
      onAnalysesQuery: (n) => {
        if (n > 1) throw Object.assign(new Error("Rate exceeded"), { name: "ProvisionedThroughputExceededException" });
      },
    });
    let n = 0;
    const invoke = async () => {
      n++;
      client.analyses.add("an-1"); // saved for real, but the Lambda cannot see it
      throw THROTTLED();
    };
    await quiet(() =>
      assert.rejects(analyze(WF, "auto", { client, invoke, remainingMs: () => 800_000, releaseSleep: noSleep }), /ThrottlingException/),
    );
    assert.equal(n, 1);
    assert.equal(client.events.length, 1, "today's failure path, untouched");
    assert.equal(client.events[0].detail.errorClass, "Error");
    assert.equal(releases(client).length, 1, "today's claim semantics, untouched");
  });

  it("a failed analyses read leaves the no-save continuation + rotation path as it was", { timeout: 5000 }, async () => {
    const client = fakeTables({
      onAnalysesQuery: (n) => {
        if (n > 1) throw new Error("throttled");
      },
    });
    const calls = [];
    const invoke = async (prompt, session) => {
      calls.push({ session });
      if (calls.length === 1) throw new Error(MAX_TOKENS_MSG);
      if (calls.length === 2) throw Object.assign(new Error("bad history"), { name: "ValidationException" });
      client.analyses.add("an-new");
      return { text: "done", stopReason: "end_turn" };
    };
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs: () => 800_000 }));
    assert.equal(calls.length, 3, "continued, then rotated, exactly as before");
    assert.match(calls[2].session, /^wmr-/);
    assert.equal(out.analysisIds, null, "D5 tolerates an unreadable table as before");
    assert.equal(client.events.length, 0);
  });

  it("a save is checked before the Lambda-budget throw, so a saved run out of time is not a failure", { timeout: 5000 }, async () => {
    const client = fakeTables();
    let n = 0;
    const invoke = async () => {
      n++;
      client.analyses.add("an-1");
      throw new Error(MAX_TOKENS_MSG);
    };
    // Plenty of time for attempt 1; not enough for a continuation afterwards.
    const remainingMs = () => (n === 0 ? 800_000 : 100_000);
    const out = await quiet(() => analyze(WF, "manual", { client, invoke, remainingMs }));
    assert.equal(n, 1);
    assert.deepEqual(out.analysisIds, ["an-1"]);
    assert.equal(client.events.length, 0);
  });

  describe("persistedSince", () => {
    const withIds = (ids) => ({ async send() { return { Items: ids.map((analysisId) => ({ analysisId })) }; } });
    const failing = { async send() { throw new Error("throttled"); } };

    it("is the ids this run added when a new row exists", async () => {
      assert.deepEqual(await persistedSince(WF, new Set(["old"]), { client: withIds(["old", "new"]) }), ["new"]);
    });
    it("is null when nothing new exists", async () => {
      assert.equal(await persistedSince(WF, new Set(["old"]), { client: withIds(["old"]) }), null);
    });
    it("is null — never throws — when the read fails, and when `before` itself failed", async () => {
      const { value: a } = await quiet(async () => ({ value: await persistedSince(WF, new Set(["old"]), { client: failing }) }));
      assert.equal(a, null);
      assert.equal(await persistedSince(WF, null, { client: withIds(["old", "new"]) }), null);
    });
  });
});
