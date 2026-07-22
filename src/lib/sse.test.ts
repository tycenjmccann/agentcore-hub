import { describe, it, expect } from "vitest";
import { sseData } from "./sse";

/**
 * The byte→frame plumbing every streaming surface rides on (Cloud Code chat, the
 * message-route relay, agent invoke). The hard cases are partial frames split
 * across chunk boundaries, multi-line data:, and a trailing frame with no final
 * blank line — a regression here silently truncates the last token of a reply.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const d of sseData(streamOf(chunks))) out.push(d);
  return out;
}

describe("sseData", () => {
  it("yields each data: payload of well-formed frames", async () => {
    expect(await collect(["data: a\n\ndata: b\n\n"])).toEqual(["a", "b"]);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    expect(await collect(["data: hel", "lo\n\n"])).toEqual(["hello"]);
  });

  it("splits when the blank-line delimiter itself straddles two chunks", async () => {
    expect(await collect(["data: a\n", "\ndata: b\n\n"])).toEqual(["a", "b"]);
  });

  it("joins multi-line data: within one event with \\n", async () => {
    expect(await collect(["data: line1\ndata: line2\n\n"])).toEqual(["line1\nline2"]);
  });

  it("flushes a trailing frame that has no final blank line", async () => {
    expect(await collect(["data: last"])).toEqual(["last"]);
  });

  it("strips exactly one optional space after the colon", async () => {
    // "data:x" (no space) and "data:  x" (two spaces → one preserved)
    expect(await collect(["data:x\n\n", "data:  y\n\n"])).toEqual(["x", " y"]);
  });

  it("ignores non-data lines (comments, event:, id:)", async () => {
    expect(await collect([": ping\nevent: msg\ndata: real\n\n"])).toEqual(["real"]);
  });

  it("carries the Cloud Code JSON schema through intact", async () => {
    const frames = await collect([
      `data: ${JSON.stringify({ type: "text", text: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "done", response: "hi there" })}\n\n`,
    ]);
    expect(frames.map((f) => JSON.parse(f))).toEqual([
      { type: "text", text: "hi" },
      { type: "done", response: "hi there" },
    ]);
  });
});
