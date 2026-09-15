import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4695 — `invokeAgentRuntime` must forward frames AS THEY ARRIVE.
 *
 * The bug: this function did `await response.response.transformToString()`
 * inside `ReadableStream.start()`, draining the entire runtime response before
 * enqueuing a single frame. Combined with the runtime's own end-of-turn
 * buffering, an Agent Chat reply appeared only once the persona had finished —
 * the heartbeat comments existed purely to stop proxies dropping that silent
 * connection.
 *
 * The load-bearing test is the first one, and what makes it a regression test
 * rather than a smoke test is the ORDERING: it reads a forwarded frame off the
 * returned stream while the upstream body is still open, and only then closes
 * it. The mock deliberately provides BOTH `transformToWebStream` and
 * `transformToString`, with the latter resolving only after close — so the
 * pre-fix code runs happily and fails on the ordering assertion instead of
 * blowing up on a missing mock.
 */

/** Placeholder account id, per scripts/check-no-hardcoded-accounts.sh. */
const ACCT = "123456789012";
const ARN = `arn:aws:bedrock-agentcore:us-east-1:${ACCT}:runtime/agentcore_hub_code_reviewer-AbCdEf`;

const h = vi.hoisted(() => {
  const state: { send: (cmd: unknown) => Promise<unknown>; commands: unknown[] } = {
    send: async () => ({}),
    commands: [],
  };
  return { state };
});

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: class {
    send(cmd: unknown) {
      h.state.commands.push(cmd);
      return h.state.send(cmd);
    }
  },
  InvokeAgentRuntimeCommand: class {
    constructor(public input: unknown) {}
  },
  SearchRegistryRecordsCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { invokeAgentRuntime } = await import("@/lib/agentcore-sdk");

/** A source stream whose chunks, close and cancellation are driven by the test. */
function controllable() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let isClosed = false;
  let cancelCalls = 0;
  let cancelReason: unknown = undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    // TEAM-4704: whether the runtime body was released is the whole question, so
    // the source records it. A cancelled source is also a CLOSED one — Node
    // throws "Invalid state: Controller is already closed" on any later
    // enqueue/close — hence the settled guards on push/close below.
    cancel(reason) {
      cancelCalls += 1;
      cancelReason = reason ?? null;
      isClosed = true;
    },
  });
  return {
    stream,
    /** false = the chunk could not land because the body is already settled. */
    push: (s: string) => {
      if (isClosed) return false;
      ctrl.enqueue(encoder.encode(s));
      return true;
    },
    close: () => {
      if (isClosed) return;
      isClosed = true;
      ctrl.close();
    },
    error: (e: Error) => {
      isClosed = true;
      ctrl.error(e);
    },
    get isClosed() {
      return isClosed;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get cancelReason() {
      return cancelReason;
    },
  };
}

/**
 * Record every enqueue that throws, anywhere in the process, until `restore()`.
 *
 * TEAM-4704: an enqueue onto a closed controller throws inside
 * `ReadableStream.start()`, and the stream machinery HANDLES that rejection
 * (spec: `startPromise.then(_, r => ControllerError)`) — on an already-closed
 * stream it is a silent no-op. So an `unhandledRejection` listener sees nothing
 * and the only reliable observation point is `enqueue` itself.
 */
function trackEnqueueErrors() {
  let proto!: { enqueue: (chunk: unknown) => void };
  // start() runs synchronously during construction.
  new ReadableStream({
    start(c) {
      proto = Object.getPrototypeOf(c);
    },
  });
  const original = proto.enqueue;
  const errors: string[] = [];
  proto.enqueue = function (chunk: unknown) {
    try {
      return original.call(this, chunk);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  return {
    errors,
    restore: () => {
      proto.enqueue = original;
    },
  };
}

/** Read SSE frames off the returned stream until `match` is seen, or it ends. */
async function readUntil(
  stream: ReadableStream,
  match: (frame: string) => boolean,
): Promise<{ frames: string[]; found: string | null }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value as Uint8Array, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        if (!part) continue;
        frames.push(part);
        if (match(part)) return { frames, found: part };
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { frames, found: null };
}

/** Drain a whole stream into its "\n\n"-delimited frames. */
async function drain(stream: ReadableStream): Promise<string[]> {
  const { frames } = await readUntil(stream, () => false);
  return frames;
}

const invoke = () =>
  invokeAgentRuntime({
    agentRuntimeArn: ARN,
    prompt: "hi",
    sessionId: "session-team-4695-000000000000",
    region: "us-east-1",
  });

beforeEach(() => {
  h.state.send = async () => ({});
  h.state.commands = [];
});

describe("invokeAgentRuntime forwards SSE frames before the body closes", () => {
  it("emits a frame split across two chunks while the source is still open", async () => {
    const src = controllable();
    let stringResolved = false;
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: {
        transformToWebStream: () => src.stream,
        // The pre-fix path. It cannot resolve until the body closes — which is
        // exactly the behaviour that made the reply arrive all at once.
        transformToString: async () => {
          while (!src.isClosed) await new Promise((r) => setTimeout(r, 5));
          stringResolved = true;
          return 'data: {"event":{"contentBlockDelta":{"delta":{"text":"hello"}}}}\n\n';
        },
      },
    });

    const out = await invoke();

    // One logical frame, deliberately split mid-JSON: proves the line buffer
    // holds the partial tail rather than forwarding a truncated frame.
    src.push('data: {"event":{"contentBlockDelta":{"delta":{"text":"hel');
    src.push('lo"}}}}\n\n');

    const { found } = await readUntil(out, (f) => f.includes("contentBlockDelta"));

    expect(found, "no contentBlockDelta frame was forwarded").not.toBeNull();
    // THE regression assertion: the frame reached the consumer while the runtime
    // body was still open, i.e. it was streamed rather than buffered.
    expect(
      src.isClosed,
      "the delta frame only arrived after the body closed — the response is still being buffered",
    ).toBe(false);
    expect(stringResolved, "transformToString was used instead of the web stream").toBe(false);
    // Forwarded verbatim and intact across the chunk boundary.
    expect(found).toBe('data: {"event":{"contentBlockDelta":{"delta":{"text":"hello"}}}}');

    src.close();
    const rest = await drain(out);
    expect(rest.at(-1)).toBe('data: {"type":"done"}');
  });

  it("forwards several frames arriving in one chunk, in order", async () => {
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.push('data: {"type":"text","content":"a"}\n\ndata: {"type":"text","content":"b"}\n\n');
    src.close();

    const frames = await drain(out);
    const texts = frames.filter((f) => f.includes('"type":"text"'));
    expect(texts).toEqual([
      'data: {"type":"text","content":"a"}',
      'data: {"type":"text","content":"b"}',
    ]);
  });

  it("emits the model_call trace on the first bytes, before any forwarded frame", async () => {
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.push('data: {"type":"text","content":"a"}\n\n');

    const { frames } = await readUntil(out, (f) => f.includes('"content":"a"'));
    const kinds = frames.map((f) => {
      try {
        const o = JSON.parse(f.slice(6));
        return o.event ?? o.type;
      } catch {
        return f;
      }
    });
    // agent_invoke start trace, then "Response received", then the payload.
    expect(kinds).toEqual(["agent_invoke", "model_call", "text"]);

    src.close();
    await drain(out);
  });

  it("still traces 'Response received' when the SSE body closes with zero chunks", async () => {
    // TEAM-4704: `contentType: text/event-stream` pre-seeds sse=true, so a body
    // that closes without a single chunk left the read loop before
    // traceReceived() and then took the SSE tail-flush branch, which used to be
    // the one branch that never called it — the UI lost its first sign of life.
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.close(); // zero chunks

    const frames = await drain(out);
    const kinds = frames.map((f) => {
      try {
        const o = JSON.parse(f.slice(6));
        return o.event ?? o.type;
      } catch {
        return f;
      }
    });
    expect(kinds).toEqual(["agent_invoke", "model_call", "response", "done"]);
  });
});

describe("invokeAgentRuntime still buffers a non-SSE body", () => {
  it("turns a single JSON document into exactly one text frame, then done", async () => {
    const src = controllable();
    h.state.send = async () => ({
      contentType: "application/json",
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.push('{"result":{"content":[{"text":"hi"}]}}');
    src.close();

    const frames = await drain(out);
    const texts = frames.filter((f) => f.includes('"type":"text"'));
    expect(texts).toEqual(['data: {"type":"text","content":"hi"}']);
    expect(frames.at(-1)).toBe('data: {"type":"done"}');
    // The JSON must not also leak through as a raw passthrough frame.
    expect(frames.filter((f) => f.includes('"result"'))).toEqual([]);
  });

  it("emits a usage trace from JSON token metadata", async () => {
    const src = controllable();
    h.state.send = async () => ({
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.push(
      JSON.stringify({
        result: { content: [{ text: "hi" }], metadata: { usage: { inputTokens: 3, outputTokens: 4 } } },
      }),
    );
    src.close();

    const frames = await drain(out);
    const usage = frames.find((f) => f.includes('"event":"usage"'));
    expect(usage).toContain("Tokens: 3 in → 4 out");
  });

  it("falls back to transformToString when no web stream is available", async () => {
    h.state.send = async () => ({
      response: { transformToString: async () => '{"output":{"text":"legacy"}}' },
    });

    const frames = await drain(await invoke());
    expect(frames.filter((f) => f.includes('"type":"text"'))).toEqual([
      'data: {"type":"text","content":"legacy"}',
    ]);
    expect(frames.at(-1)).toBe('data: {"type":"done"}');
  });
});

describe("invokeAgentRuntime error and lifecycle frames are unchanged", () => {
  it("rejects (rather than framing) when the invoke call itself fails", async () => {
    // `client.send` is awaited BEFORE the stream is constructed, so an invoke
    // failure surfaces as a rejected promise. Callers rely on this: the
    // agent-chat route catches it and answers 502 with an opaque message.
    h.state.send = async () => {
      throw new Error("AccessDeniedException: not authorized");
    };

    await expect(invoke()).rejects.toThrow("AccessDeniedException: not authorized");
  });

  it("emits an error trace frame and an error frame when the body read fails", async () => {
    // Once the stream exists, a mid-read failure must be framed rather than
    // thrown — the consumer is already reading and has no catch left.
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });

    const out = await invoke();
    src.push('data: {"type":"text","content":"a"}\n\n');
    const { frames: seen } = await readUntil(out, (f) => f.includes('"content":"a"'));
    expect(seen.at(-1)).toBe('data: {"type":"text","content":"a"}');

    src.error(new Error("connection reset mid-turn"));
    const rest = await drain(out);

    // The error trace lands first, then the error frame, then the stream ends —
    // there is no `done` frame on the failure path.
    expect(rest.length).toBe(2);
    expect(rest[0]).toContain('"event":"error"');
    expect(rest[1]).toBe('data: {"type":"error","content":"connection reset mid-turn"}');
  });

  it("clears the heartbeat when the consumer cancels", async () => {
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const out = await invoke();
    src.push('data: {"type":"text","content":"a"}\n\n');
    await readUntil(out, (f) => f.includes('"content":"a"'));
    await out.cancel();

    // cancel() must clear the keep-alive interval, or it ticks forever against a
    // dead controller (the reason `closed` lives outside start()).
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    src.close();
  });

  it("cancels the runtime body and stops the pump when the consumer cancels", async () => {
    // TEAM-4704: both callers hand this stream straight to a Response body, so a
    // closed tab cancels it. cancel() used to only flip a flag: the runtime
    // connection stayed open until the persona finished, and the persona's next
    // chunk drove an enqueue onto the already-closed controller (TypeError,
    // twice — the outer catch re-enqueued onto the same dead controller).
    const src = controllable();
    h.state.send = async () => ({
      contentType: "text/event-stream",
      response: { transformToWebStream: () => src.stream },
    });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const enqueue = trackEnqueueErrors();

    const out = await invoke();
    src.push('data: {"type":"text","content":"a"}\n\n');
    await readUntil(out, (f) => f.includes('"content":"a"'));

    await out.cancel();

    // Soft, so a regression reports BOTH symptoms (leaked body AND the crash)
    // rather than stopping at the first.
    expect.soft(src.cancelCalls, "the runtime response body was not cancelled").toBe(1);

    // The persona keeps talking into a body nobody is reading.
    const landed = src.push('data: {"type":"text","content":"b"}\n\n');
    await new Promise((r) => setTimeout(r, 20));

    expect.soft(landed, "the cancelled body still accepted a chunk").toBe(false);
    expect
      .soft(enqueue.errors, "the pump enqueued onto the closed controller")
      .toEqual([]);
    expect(clearSpy).toHaveBeenCalled();

    enqueue.restore();
    clearSpy.mockRestore();
    src.close();
  });
});
