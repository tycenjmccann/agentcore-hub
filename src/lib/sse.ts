/**
 * Shared Server-Sent Events (SSE) reader.
 *
 * Every streaming surface in the app (Cloud Code chat, agent-detail invoke,
 * builder chat, the message-route relay) reads an SSE body the same way: pull
 * bytes from a ReadableStream, decode incrementally, buffer across chunk
 * boundaries, and surface each `data:` payload. That byte/frame plumbing is the
 * easy-to-get-wrong part (partial frames split across chunks, multi-line data,
 * trailing buffer), so it lives here ONCE and is unit-tested.
 *
 * What stays per-feature: interpreting each payload (the event schema differs —
 * Cloud Code emits {type:text|done}, Strands agents emit contentBlockDelta,
 * etc.). Callers parse the yielded string themselves.
 *
 * Usage:
 *   for await (const data of sseData(response.body)) {
 *     if (data === "[DONE]") break;
 *     const obj = JSON.parse(data);   // caller owns the schema
 *   }
 */

/**
 * Async-iterate the `data:` payloads of an SSE stream.
 *
 * Yields the string after each `data:` prefix (trimmed of the prefix only).
 * Frames are delimited by a blank line per the SSE spec; multi-line `data:`
 * within one event are joined with "\n". Handles partial frames spanning chunk
 * boundaries and flushes any trailing partial frame at end-of-stream.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const framesFrom = function* (chunkTerminated: boolean): Generator<string> {
    // Split on blank-line event boundaries. Keep the last (possibly partial)
    // piece in `buffer` unless we're flushing at end-of-stream.
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = chunkTerminated ? (parts.pop() ?? "") : "";
    for (const frame of parts) {
      const dataLines = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, "")); // strip "data:" + one optional space
      if (dataLines.length) yield dataLines.join("\n");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* framesFrom(true);
    }
    buffer += decoder.decode();
    yield* framesFrom(false); // flush trailing frame
  } finally {
    reader.releaseLock();
  }
}
