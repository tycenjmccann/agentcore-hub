# Streaming (SSE) in the console

Every live-text surface in the app streams Server-Sent Events (SSE). To keep the
fragile part correct in one place, the **byte→frame plumbing is shared**; each
feature only interprets its own event payloads.

## The shared reader — `src/lib/sse.ts`

```ts
for await (const data of sseData(response.body)) {
  if (data === "[DONE]") break;
  const obj = JSON.parse(data);   // caller owns the schema
}
```

`sseData(body)` async-iterates the `data:` payloads of an SSE `ReadableStream`.
It handles the things that are easy to get wrong and were previously duplicated:

- partial frames split across network chunks,
- multi-line `data:` within one event (joined with `\n`),
- `\r\n` and `\n` line endings,
- flushing a trailing frame with no terminating blank line.

Unit-tested for: simple frames, split-frame, trailing flush, multiline, comments/
`[DONE]`, CRLF, byte-by-byte delivery.

**Rule:** never hand-roll a `getReader()` + `split("\n")` loop in a new feature.
Use `sseData`. The per-feature code only does `JSON.parse(data)` and switches on
its own event types.

## Consumers (all on `sseData`)

| Surface | File | Event schema it parses |
|---|---|---|
| Agent detail / invoke | `src/lib/agentcore-stream.ts` (`streamAgentInvocation`) | `{type:text,content}`, `{type:trace}`, Strands `event.contentBlockDelta.delta.text`, tool-use starts |
| Builder chat | `src/lib/agentcore-stream.ts` (`streamBuilderChat`) | `{type:text\|config\|done}` |
| Cloud Code chat | `src/app/cloud-code/page.tsx` | `{type:text\|done\|error}` |
| Cloud Code relay (server) | `src/app/api/cloud-code/sessions/[id]/message/route.ts` | tees `text`/`done` to persist, relays each frame verbatim |

The event *schemas* differ on purpose (different upstreams: Strands async
generators vs. Claude `stream-json`), so they are NOT unified — only the
transport is.

## How Cloud Code streaming works end to end

Claude streams; Codex is buffered (no `stream-json` resume story yet).

```
browser (page.tsx)
  └─ POST /api/cloud-code/sessions/[id]/message?stream=1
       └─ invokeCodingTurnStream → InvokeAgentRuntime(accept: text/event-stream)
            └─ coding runtime /invocations (stream:true)
                 └─ claude --print --output-format stream-json --include-partial-messages --verbose
                      → content_block_delta frames → SSE {type:text}
                      → final → SSE {type:done, response, claude_session_id}
```

- **`--include-partial-messages` is required** — without it Claude emits whole
  message blocks (one chunk at the end), not token-level deltas.
- The Next.js relay route persists the turn on the `done` frame (full text +
  `claude_session_id` for resume) while passing frames through unbuffered.
- App Runner forwards the stream without buffering (verified incremental live).

## Adding a new streaming surface

1. Server returns `text/event-stream`, writing `data: {json}\n\n` per event
   (terminate with a `done` event; optional `[DONE]` sentinel also handled).
2. Client: `for await (const data of sseData(res.body)) { JSON.parse(data) … }`.
3. Define a small event schema; don't reuse another feature's unless it matches.
