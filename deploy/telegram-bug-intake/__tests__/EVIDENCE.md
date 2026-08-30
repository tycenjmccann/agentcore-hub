# TEAM-3460 / TEAM-3464 — voice transcription evidence

`transcribeVoice()` in the deployed `telegram-bug-intake` Lambda opens an Amazon
Transcribe **streaming** session and then dumps the entire downloaded OGG/Opus
file into it in 16 KiB frames as fast as the socket accepts them, ending the
stream immediately afterwards. Transcribe streaming is a real-time service: it
expects audio at roughly wall-clock speed in uniform 50-200 ms chunks, terminated
by an empty audio event. Getting a whole clip at t=0 and then nothing trips the
service's insufficient-audio watchdog, which closes the session after ~20 s —
which is why the failure is length-independent (a 2:26 note fails exactly like a
2-second one):

> Failed to process: Your request timed out because not enough audio was received within 20 seconds

The offending stream, `deploy/telegram-bug-intake/index.mjs:722-727` (verbatim,
as deployed):

```js
  async function* audioStream() {
    const CHUNK = 16 * 1024;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      yield { AudioEvent: { AudioChunk: bytes.subarray(i, i + CHUNK) } };
    }
  }
```

16 KiB of Opus in this container is ~4 seconds of audio per frame, there is no
delay between frames, and no terminating empty `AudioChunk` is ever sent.

## Baseline (deployed code) — FAILING

Command:

```
npx vitest run deploy/telegram-bug-intake
```

Run against `deploy/telegram-bug-intake/index.mjs` exactly as deployed
(sha256 `5eb0bb40a824f57f0b86dfdef99dfeb26a9cabbc35b0bf95066cc74fbe762f81`, the
only delta being `export` on `transcribeVoice`), commit
`52bbd12` "TEAM-3464: import telegram-bug-intake Lambda source (verbatim
deployed) as baseline". Exit code **1**.

```
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v2.1.9 /mnt/efs/sessions/cc-03b3e727938b4822ac01de76b4f5f2c2/tycenjmccann-agentcore-hub

 ❯ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs (5 tests | 2 failed) 130ms
   × transcribeVoice — Transcribe streaming delivery contract > delivers the audio in real-time-sized chunks, paced to wall clock 31ms
     → 1/1 audio events exceed 1200 bytes (~250 ms at 4047 B/s); largest = 12140 bytes: expected [ 't=0ms: 12140B' ] to deeply equal []
   × transcribeVoice — Transcribe streaming delivery contract > terminates the stream with an explicit empty end-of-audio event 4ms
     → last AudioEvent carried 12140 bytes; Transcribe streaming needs a final empty AudioChunk to signal end-of-audio: expected 12140 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > delivers the audio in real-time-sized chunks, paced to wall clock
AssertionError: 1/1 audio events exceed 1200 bytes (~250 ms at 4047 B/s); largest = 12140 bytes: expected [ 't=0ms: 12140B' ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   "t=0ms: 12140B",
+ ]

 ❯ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs:207:7
    205|       `${oversized.length}/${audio.length} audio events exceed ${MAX_C…
    206|         `(~250 ms at ${BYTE_RATE.toFixed(0)} B/s); largest = ${Math.ma…
    207|     ).toEqual([]);
       |       ^
    208| 
    209|     // 2. Cumulative delivery must never run far ahead of real time.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > terminates the stream with an explicit empty end-of-audio event
AssertionError: last AudioEvent carried 12140 bytes; Transcribe streaming needs a final empty AudioChunk to signal end-of-audio: expected 12140 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 12140

 ❯ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs:235:7
    233|       `last AudioEvent carried ${last.bytes} bytes; Transcribe streami…
    234|         `empty AudioChunk to signal end-of-audio`,
    235|     ).toBe(0);
       |       ^
    236|   });
    237| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
   Start at  21:48:13
   Duration  2.99s (transform 198ms, setup 0ms, collect 142ms, tests 130ms, environment 0ms, prepare 187ms)
```

### What this proves

| Invariant | Result |
|---|---|
| 1. `MediaEncoding: "ogg-opus"`, `MediaSampleRateHertz: 48000`, delivered bytes byte-identical to the fixture | **PASS** — the declared format and the bytes are both correct, so this is not a transcoding/format bug |
| 2. every audio frame <= ~250 ms of audio, cumulative delivery never >0.5 s ahead of real time, drain takes >=60% of clip duration | **FAIL** — the entire 12,140-byte clip arrives as ONE frame at `t=0ms` |
| 3. stream terminated by an empty (0-byte) `AudioChunk` | **FAIL** — the last event carries 12,140 bytes; no end-of-audio marker is ever sent |
| 4. returns the final transcript | **PASS** — transcript assembly itself is fine |
| 5. partial-only results -> `""` | **PASS** — pre-existing behaviour, guarded against regression |

Invariants 1, 4 and 5 passing is the important part of the diagnosis: everything
around the audio delivery works. The defect is confined to *how* the bytes are
handed to the stream — pacing and termination — which is exactly what invariants
2 and 3 pin down.

## Fixed code — PASSING

`transcribeVoice(fileId, durationSec)` now derives a chunk size from the clip's
own byte rate, sleeps `CHUNK_MS` between frames, and closes the audio stream with
an explicit empty `AudioEvent`. Same command, exit code **0**:

```
npx vitest run deploy/telegram-bug-intake --reporter=verbose
```

```
The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

 RUN  v2.1.9 /mnt/efs/sessions/cc-03b3e727938b4822ac01de76b4f5f2c2/tycenjmccann-agentcore-hub

 ✓ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > declares the Telegram container natively and delivers the bytes intact
 ✓ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > delivers the audio in real-time-sized chunks, paced to wall clock
 ✓ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > terminates the stream with an explicit empty end-of-audio event
 ✓ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — Transcribe streaming delivery contract > returns the final transcript
 ✓ deploy/telegram-bug-intake/__tests__/transcribe-voice.test.mjs > transcribeVoice — transcript assembly > returns an empty string when only partial results arrive 2809ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  21:52:15
   Duration  7.93s (transform 198ms, setup 0ms, collect 144ms, tests 5.71s, environment 0ms, prepare 141ms)
```

### Delivery profile for the 3 s fixture

12,140 bytes / 3.0 s = 4,046.67 B/s, `CHUNK_MS = 200`:

| | |
|---|---|
| `chunkBytes` | `ceil(4046.67 * 200 / 1000)` = **810 B** = 200.2 ms of audio (inside the 50-200 ms window) |
| Audio frames | **15** (14 x 810 B + a 800 B remainder) |
| Total events | **16** — the 15 audio frames plus the empty end-of-audio `AudioChunk` |
| Sleeps | 14 x 200 ms = 2,800 ms expected |
| Measured delivery wall time | **2,809 ms** for a 3.0 s clip — 94% of real time |

The clamp `max(256, min(16 KiB, ...))` bounds the frame for pathological
durations: a bogus/zero `duration` falls back to a 4,000 B/s estimate (~32 kbps,
Telegram's usual voice bitrate) rather than to a full-file blast, and a very long
clip with a high byte rate still tops out at one 16 KiB frame per 200 ms.

Streaming now costs roughly the clip's own duration in Lambda wall time (a 10 min
note, the handler's cap, is ~10 min of streaming against a 900 s timeout — the
pre-existing 600 s guard in `routeMessage` keeps that inside the budget).
