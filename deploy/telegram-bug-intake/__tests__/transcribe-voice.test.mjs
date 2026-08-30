/**
 * transcribeVoice() — Amazon Transcribe *streaming* delivery contract.
 *
 * Transcribe streaming is a real-time service, not a file API. Per AWS's
 * streaming docs the audio must arrive at roughly wall-clock speed in uniform
 * 50–200 ms chunks, and the stream must be terminated with an empty audio
 * event. If a whole clip is dumped into the socket at once and the stream then
 * just ends, the service's insufficient-audio watchdog kills the session after
 * ~20 s — producing "Your request timed out because not enough audio was
 * received within 20 seconds" for EVERY voice note, regardless of length
 * (TEAM-3460).
 *
 * So these tests assert the *behaviour of the audio delivery* — chunk size,
 * pacing against real time, and the end-of-audio terminator — not the
 * implementation that produces it. The TranscribeStreamingClient mock stands in
 * for the service seam: it consumes `input.AudioStream` exactly as the real
 * client would and records when each event actually arrives.
 *
 * Real timers on purpose: pacing is the thing under test. A correctly paced
 * 3-second fixture therefore takes ~3 seconds of wall clock.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "fixtures", "voice-note.oga"));

// Fixture ground truth: a real Telegram voice note — OGG/Opus, 48 kHz mono,
// 3.0 s, 12140 bytes → ~4047 bytes of container per second of audio.
const CLIP_SECONDS = 3.0;
const BYTE_RATE = FIXTURE.length / CLIP_SECONDS;
// 250 ms of audio, plus slack for Ogg page granularity.
const MAX_CHUNK_BYTES = 1200;
// How far ahead of real time cumulative delivery may run.
const MAX_LEAD_SECONDS = 0.5;

const TG_TOKEN = "111111:test-bot-token";
const VOICE_PATH = "voice/file_1.oga";

/**
 * Recorder shared with the hoisted vi.mock factories. `events` is the arrival
 * log of the audio stream as the service seam saw it.
 */
const rec = vi.hoisted(() => ({
  mode: "final",
  input: null,
  events: [], // { tMs, bytes }
  chunks: [], // raw AudioChunk buffers, in order
  consumeMs: 0,
}));

vi.mock("@aws-sdk/client-transcribe-streaming", () => {
  class StartStreamTranscriptionCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class TranscribeStreamingClient {
    async send(command) {
      const input = command.input;
      rec.input = input;

      // Consume the caller's audio stream the way the real client does: in the
      // background, concurrently with the transcript stream being awaited.
      const t0 = Date.now();
      const consumed = (async () => {
        for await (const event of input.AudioStream) {
          const chunk = event?.AudioEvent?.AudioChunk;
          rec.events.push({ tMs: Date.now() - t0, bytes: chunk ? chunk.length : 0 });
          rec.chunks.push(chunk ? Buffer.from(chunk) : Buffer.alloc(0));
        }
        rec.consumeMs = Date.now() - t0;
      })();

      const results =
        rec.mode === "partial-only"
          ? [{ IsPartial: true, Alternatives: [{ Transcript: "partial words" }] }]
          : [{ IsPartial: false, Alternatives: [{ Transcript: "test transcript" }] }];

      return {
        TranscriptResultStream: (async function* () {
          // The final transcript only exists once the service has all the audio.
          await consumed;
          yield { TranscriptEvent: { Transcript: { Results: results } } };
        })(),
      };
    }
  }
  return { TranscribeStreamingClient, StartStreamTranscriptionCommand };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send() {
      throw new Error("Bedrock must not be called from the voice path");
    }
  },
  ConverseCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = class {
    constructor(input) {
      this.input = input;
    }
  };
  return {
    DynamoDBClient: class {
      async send() {
        throw new Error("DynamoDB must not be called from the voice path");
      }
    },
    GetItemCommand: cmd,
    PutItemCommand: cmd,
    DeleteItemCommand: cmd,
    ScanCommand: cmd,
  };
});

// index.mjs resolves every credential at import time via requireEnv().
const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net",
  JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "test-jira-token",
  JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "test-github-token",
  GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table",
  HUB_API_URL: "https://hub.example.invalid",
};

let transcribeVoice;
let realFetch;

beforeAll(async () => {
  Object.assign(process.env, ENV);
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u === `https://api.telegram.org/bot${TG_TOKEN}/getFile`) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: VOICE_PATH } }) };
    }
    if (u === `https://api.telegram.org/file/bot${TG_TOKEN}/${VOICE_PATH}`) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => FIXTURE.buffer.slice(FIXTURE.byteOffset, FIXTURE.byteOffset + FIXTURE.byteLength),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  ({ transcribeVoice } = await import("../index.mjs"));
});

afterAll(() => {
  global.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

function resetRecorder(mode = "final") {
  rec.mode = mode;
  rec.input = null;
  rec.events = [];
  rec.chunks = [];
  rec.consumeMs = 0;
}

describe("transcribeVoice — Transcribe streaming delivery contract", () => {
  // One transcription, many invariants: the run happens once and every test
  // below inspects the same recorded stream. Snapshotted so nothing that runs
  // later can disturb what is being asserted.
  let result;
  let run;

  beforeAll(async () => {
    resetRecorder();
    result = await transcribeVoice("FILE_ID", CLIP_SECONDS);
    run = { input: rec.input, events: [...rec.events], chunks: [...rec.chunks], consumeMs: rec.consumeMs };
  }, 30_000);

  it("declares the Telegram container natively and delivers the bytes intact", () => {
    expect(run.input.MediaEncoding).toBe("ogg-opus");
    expect(run.input.MediaSampleRateHertz).toBe(48000);

    const delivered = Buffer.concat(run.chunks.filter((c) => c.length > 0));
    expect(delivered.length).toBe(FIXTURE.length);
    expect(Buffer.compare(delivered, FIXTURE)).toBe(0);
  });

  it("delivers the audio in real-time-sized chunks, paced to wall clock", () => {
    const audio = run.events.filter((e) => e.bytes > 0);
    expect(audio.length).toBeGreaterThan(0);

    // 1. No frame may carry more than ~250 ms of audio.
    const oversized = audio.filter((e) => e.bytes > MAX_CHUNK_BYTES);
    expect(
      oversized.map((e) => `t=${e.tMs}ms: ${e.bytes}B`),
      `${oversized.length}/${audio.length} audio events exceed ${MAX_CHUNK_BYTES} bytes ` +
        `(~250 ms at ${BYTE_RATE.toFixed(0)} B/s); largest = ${Math.max(0, ...audio.map((e) => e.bytes))} bytes`,
    ).toEqual([]);

    // 2. Cumulative delivery must never run far ahead of real time.
    let cumulative = 0;
    const ahead = [];
    for (const e of run.events) {
      cumulative += e.bytes;
      const allowed = BYTE_RATE * (e.tMs / 1000 + MAX_LEAD_SECONDS);
      if (cumulative > allowed) {
        ahead.push(`t=${e.tMs}ms: sent ${cumulative}B, real-time budget ${Math.round(allowed)}B`);
      }
    }
    expect(ahead, `delivery ran ahead of real time:\n  ${ahead.join("\n  ")}`).toEqual([]);

    // 3. Streaming a 3 s clip must take roughly 3 s, not zero.
    expect(
      run.consumeMs,
      `whole clip drained in ${run.consumeMs}ms — Transcribe streaming expects ~${CLIP_SECONDS * 1000}ms`,
    ).toBeGreaterThanOrEqual(CLIP_SECONDS * 1000 * 0.6);
  });

  it("terminates the stream with an explicit empty end-of-audio event", () => {
    const last = run.events.at(-1);
    expect(last, "no audio events were sent at all").toBeDefined();
    expect(
      last.bytes,
      `last AudioEvent carried ${last.bytes} bytes; Transcribe streaming needs a final ` +
        `empty AudioChunk to signal end-of-audio`,
    ).toBe(0);
  });

  it("returns the final transcript", () => {
    expect(result).toBe("test transcript");
  });
});

describe("transcribeVoice — transcript assembly", () => {
  it("returns an empty string when only partial results arrive", async () => {
    resetRecorder("partial-only");
    await expect(transcribeVoice("FILE_ID", CLIP_SECONDS)).resolves.toBe("");
  }, 30_000);
});
