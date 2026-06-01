# Workflow Pipeline — Architecture & Decision Log

> **Purpose**: Single source of truth for architecture decisions in the workflow pipeline. Prevents circular revisiting of solved problems.
>
> **Component**: `src/components/workflow/WorkflowBoard.tsx` + backend event system
> **Runtime**: `deploy/runtime-agent/main.py` (all 14 agents)
> **Orchestrator**: `lambda/orchestrator/index.mjs` (handles both DynamoDB Stream events and Jira webhook invocations)
> **Provider switch**: `TICKET_PROVIDER=dynamodb|jira` (env var on the orchestrator Lambda)

---

## Current Architecture (as of 2026-05-19)

### Mode: DynamoDB (TICKET_PROVIDER=dynamodb)

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js)                        │
│                                                                   │
│  WorkflowBoard.tsx ─── polls /api/workflow/[id]/stream (1s) ──┐  │
│       │                                                        │  │
│       └── Applies CSS classes: .working, .trigger, .done       │  │
└────────────────────────────────────────────────────────────────┼──┘
                                                                 │
                              DynamoDB                            │
                         ┌─────────────────┐                     │
                         │  agentcore-hub-events  │ ◄──── polled ──────┘
                         └────────┬────────┘
                                  │ written by:
                    ┌─────────────┼─────────────────┐
                    │             │                   │
              Runtime Agent   Runtime Agent     Orchestrator
              (agent.started) (agent.streaming)  (agent.complete)
              (tool_use)      (trace events)     (workflow.*)
```

### Mode: Jira (TICKET_PROVIDER=jira)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          FRONTEND (Next.js) — READ ONLY                       │
│  WorkflowBoard.tsx ─── polls agentcore-hub-events table (1s) ───────────────────┐  │
│  /api/workflow/start ─── creates skeletons + writes to agentcore-hub-workflows   │  │
└────────────────────────────────────────────────────────────────────────────┼──┘
                                                                             │
         ┌───────────── DynamoDB ────────────────┐                           │
         │                                        │                           │
         │  agentcore-hub-tickets (+ Stream enabled)    │                           │
         │  ┌──────────────────────────────────┐  │                           │
         │  │ TEAM-1 epic (in_progress)         │  │                           │
         │  │ TEAM-2 requirements (todo) ─────────────► Stream fires           │
         │  │ TEAM-3 backend-designer (blocked) │  │         │                 │
         │  │ TEAM-4 security-reviewer (blocked)│  │         │                 │
         │  │ ...                               │  │         ▼                 │
         │  └──────────────────────────────────┘  │  ┌──────────────────┐     │
         │                                        │  │ Orchestrator      │     │
         │  agentcore-hub-workflows                     │  │ Lambda (index.mjs)│     │
         │  ┌──────────────────────────────────┐  │  │                  │     │
         │  │ wf_xxx: epicId, agentTasks, ...   │  │  │ • handleTicketDone│     │
         │  └──────────────────────────────────┘  │  │ • handleTicketReady    │
         │                                        │  │ • unblock deps    │     │
         │  agentcore-hub-events ◄───────────────────────────── publish events─┼─────┘
         │  ┌──────────────────────────────────┐  │  └────────┬─────────┘
         │  │ agent.started, agent.complete,    │  │           │
         │  │ workflow.phase_change, ...        │  │           │ async invoke
         │  └──────────────────────────────────┘  │           ▼
         └────────────────────────────────────────┘  ┌──────────────────┐
                                                     │ Agent Invoker     │
                                                     │ Lambda            │
                                                     │ (agent-invoker.mjs)
                                                     │                  │
                                                     │ • invoke Runtime │
                                                     │ • write output S3│
                                                     │ • mark "done" ───┼──► Stream fires again
                                                     └──────────────────┘
```

**Key difference**: In Lambda mode, the Next.js app is READ-ONLY after the initial `startWorkflow` call. It only:
1. Creates ticket skeletons + workflow metadata (one-time write)
2. Polls events table for UI updates (read-only)

All orchestration decisions happen in the Lambda, triggered by DynamoDB Streams.

### Mode: Replay (completed workflows)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js)                             │
│                                                                       │
│  WorkflowBoard.tsx ─── GET /api/workflow/[id]/events (one-shot) ──┐  │
│       │                                                            │  │
│       ├── replayEvents[] = full event array (ordered)              │  │
│       ├── replayIndex = current position in timeline               │  │
│       ├── applyEventToState(0→replayIndex) → reconstruct state    │  │
│       ├── fireReplayVisuals(event) → tool flashes, connectors     │  │
│       └── Scrubber: play/pause, seek, speed (1x–50x)              │  │
└────────────────────────────────────────────────────────────────────┼──┘
                                                                     │
                              DynamoDB                                │
                         ┌─────────────────┐                         │
                         │  agentcore-hub-events  │ ◄──── one-shot fetch ──┘
                         │  (all events     │       (paginated, no SSE)
                         │   for workflow)  │
                         └─────────────────┘
```

**Key**: No SSE, no polling. Single fetch of all events, then client-side replay with timestamp-based pacing.

### Mode: Catch-Up Replay (live/in-progress workflows)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js)                                   │
│                                                                             │
│  WorkflowBoard.tsx                                                          │
│       │                                                                     │
│       ├── Phase 1: GET /api/workflow/[id]/events (one-shot, all history)    │
│       │   └── replayEvents[] + lastEventId stored                          │
│       │                                                                     │
│       ├── Phase 2: Catch-up replay at 20x (same logic as completed replay) │
│       │   └── "Catching up..." indicator, progress bar                     │
│       │                                                                     │
│       └── Phase 3: SSE connects with ?cursor=lastEventId (live mode)       │
│           └── handleEvent() applies new events on top of catch-up state    │
└────────────────────────────────────────────────────────────────────────────┘
```

**Key**: Two-phase load — fast visual catch-up using historical events, then seamless handoff to live SSE. No duplicate events because SSE starts from the last replayed eventId cursor.

### Event Flow

1. **Orchestrator Lambda** invokes Runtime agent via `invoke_async` (non-streaming HTTPS)
2. **Runtime agent** publishes `agent.started` immediately on invocation (DynamoDB direct)
3. **Runtime agent** uses `ToolTrackingHandler` callback to publish `agent.streaming` trace events (tool_use) directly to DynamoDB on each tool invocation
4. **Runtime agent** completes → returns final response to orchestrator
5. **Orchestrator** publishes `agent.complete` event to DynamoDB
6. **Frontend** polls events table every 1s, applies CSS animations

### Event Types

| Event | Published By | Triggers |
|-------|-------------|----------|
| `agent.started` | Runtime agent (main.py) | Agent box → `.working` (pulsing) |
| `agent.streaming` (type=trace) | Runtime agent callback | Tool item → `.trigger` (flash) |
| `agent.complete` | Orchestrator Lambda | Agent box → `.done` (green) |
| `workflow.phase_change` | Orchestrator Lambda | Phase transition animation |
| `workflow.complete` | Orchestrator Lambda | Celebration burst |

---

## Decision Log

### DL-001: Non-Streaming Agent Invocation

**Date**: 2026-05-12 (commit `f311ed5`)
**Decision**: Switch from streaming SSE to `invoke_async` (non-streaming buffered invocation)
**Status**: ACTIVE

**Context**: Agents were originally invoked with streaming SSE responses. When an agent calls a tool (e.g., GitHub MCP, S3), the agent pauses output while waiting for the tool response. During this pause, no bytes flow on the SSE connection.

**Problem**: AgentCore's load balancer enforces a ~120-second idle timeout on SSE connections. When an agent calls a tool that takes >120s (common with Opus 4.6 doing complex code generation via GitHub MCP), the LB kills the connection. The orchestrator sees a `ReadTimeoutError` and retries, causing duplicate work or failures.

**Solution**: Use `invoke_async` which buffers the entire agent response internally. The agent still streams internally (tool calls happen normally), but the response is delivered as one final payload. No idle connection = no LB timeout.

**Why not just increase the timeout?**: The 120s idle timeout is infrastructure-level (AgentCore LB), not configurable by customers. Even if it were, tool calls can legitimately take 5-10 minutes (complex code generation, large file reads).

**Trade-off**: We lose real-time streaming of agent "thinking" text. Accepted because:
- Tool events are the primary UI signal (handled separately via DL-002)
- Agent text output is consumed after completion anyway (written to S3/tickets)
- Close-laptop-reconnect is more important than live text streaming

---

### DL-002: DynamoDB Events Table for State Persistence

**Date**: 2026-05-14
**Decision**: Add `agentcore-hub-events` DynamoDB table as the single source of truth for all pipeline events
**Status**: ACTIVE

**Context**: Original architecture used in-memory SSE subscribers (see `route-in-process.ts`). If the browser disconnected or the Next.js server restarted, all event history was lost. Users closing their laptop and reopening would see a blank state.

**Problem**:
1. No reconnection — close laptop, lose all context
2. No replay — can't reconstruct what happened during disconnect
3. Stateful server — Next.js process holds subscriber state, can't scale horizontally

**Solution**: All events written to DynamoDB with `workflowId` (partition key) + `eventId` (sort key, timestamp-based). Frontend polls with `lastEventId` cursor to get only new events. On reconnect, fetches all events from beginning and replays them to reconstruct UI state.

**Architecture properties**:
- **Stateless frontend**: Any browser can poll and reconstruct full state
- **Stateless backend**: Next.js API route is a pure DynamoDB read proxy
- **Durable history**: Complete audit trail of every agent action
- **Scalable**: Multiple frontends can poll simultaneously

**Table schema**:
```
PK: workflowId (S)
SK: eventId (S) — format: "{timestamp_ms}-{random_4char}"
GSI: none (single-workflow queries only)
TTL: expiresAt (7 days)
```

---

### DL-003: Runtime Agent Self-Publishing Events

**Date**: 2026-05-19
**Decision**: Runtime agents publish `agent.started` and `tool_use` events directly to DynamoDB (not via orchestrator)
**Status**: ACTIVE

**Context**: With non-streaming invocation (DL-001), the orchestrator only receives the final response. It cannot publish real-time events during execution because it's blocked waiting for the response.

**Problem**: UI showed no activity between agent start and completion. No pulsing, no tool flashes. Made it look frozen/broken.

**Solution**: The Runtime agent code (`main.py`) publishes events directly to DynamoDB:
1. `_publish_agent_started()` — called immediately when agent begins processing
2. `ToolTrackingHandler` callback — publishes `agent.streaming` trace event on every tool invocation

**Implementation**:
```python
class ToolTrackingHandler:
    def __call__(self, **kwargs):
        current_tool_use = kwargs.get("current_tool_use", {})
        if current_tool_use and current_tool_use.get("name"):
            # Publish directly to DynamoDB events table
            _ddb_events_client.put_item(...)
```

**Trade-off**: Agents need DynamoDB write permissions + EVENTS_TABLE env var. Accepted because agents already have IAM roles with DynamoDB access for ticket operations.

---

### DL-004: Close-Laptop-Reconnect Architecture

**Date**: 2026-05-14
**Decision**: Frontend is fully stateless and reconstructs from events table on reconnect
**Status**: ACTIVE

**Behavior**:
1. User closes laptop (SSE poll stops)
2. Agents continue running (fire-and-forget Lambda invocations)
3. Events accumulate in DynamoDB
4. User reopens laptop → frontend reconnects
5. Frontend fetches ALL events for workflow from DynamoDB
6. Replays events in order → reconstructs exact current state
7. Resumes live polling from latest cursor

**Why this works**: Every state transition is an event. The UI is a pure function of events. No server-side session needed.

---

## Research: Can Streaming Be Re-Enabled?

**Date**: 2026-05-19
**Conclusion**: NO. Streaming cannot replace the current approach. The 120s idle timeout is a hard infrastructure constraint that cannot be worked around with keepalives or any client-side technique. The current architecture (non-streaming + DynamoDB side-channel) is the minimal correct solution.

---

### The Core Question

Can we simplify by enabling streaming on Runtime agents and letting the orchestrator parse tool events from the stream (like it already does for Harness agents) — eliminating the custom `ToolTrackingHandler` callback and direct DynamoDB writes from the agent?

### Answer: No, because of what happens during tool execution

```
Timeline of a streaming agent calling a tool:

0s     ─── Agent starts, yields tokens ("Let me check the repo...") ───► bytes flowing
3s     ─── Agent decides to call github.get_file_contents ───► last byte sent
3s-180s ─── Agent WAITING for tool response ───► ZERO bytes on stream
120s   ─── AgentCore LB idle timeout fires ───► CONNECTION KILLED
180s   ─── Tool responds, agent wants to continue ───► stream is dead
```

### What exactly does the 120s timeout kill?

**Critical finding: It kills the HTTP/SSE connection ONLY, not the agent process.**

| Component | What happens at 120s |
|-----------|---------------------|
| AgentCore LB | Kills the TCP connection between orchestrator and Runtime agent |
| Agent process (microVM) | **Keeps running** — governed by `idleRuntimeSessionTimeout` (900s) and `max-lifetime` (3600s) |
| Orchestrator Lambda | Gets `ReadTimeoutError`, thinks agent died |
| Tool execution | **Completes normally** — the agent still gets the tool response |
| Agent output after tool | **Produced but lost** — no one is listening anymore |

So the agent finishes its work, but the orchestrator never receives the output. This causes:
- Orchestrator retries → duplicate agent invocations
- Or orchestrator reports failure → ticket stuck as "running"
- Either way: broken pipeline

**Ref**: `demo/bug-reports/agentcore-harness-read-timeout.md` — 56 timeout events in 24h on security-reviewer agent, same root cause

### Why keepalive pings won't work

**Attempt 1: Yield keepalives from the entrypoint generator**

The entrypoint is an async generator:
```python
@app.entrypoint
async def agent_invocation(payload, context):
    result = await agent.invoke_async(prompt)  # ← SUSPENDED HERE
    yield {"event": ...}  # can only yield AFTER await completes
```

When `await` is active, the generator is suspended. You cannot yield from a suspended coroutine. There is no mechanism in Python's async model to "interrupt" an await to yield a keepalive.

**Attempt 2: Use `stream_async` instead of `invoke_async`**

With `stream_async`, you'd get events as an async iterator. But events only fire when:
- The LLM produces tokens (during generation) ✓
- Tool execution starts (one event) ✓
- Tool execution completes (one event) ✓

During the actual tool wait (Lambda running for 2-5 min), **no events fire**. The stream goes silent. Same timeout.

**Attempt 3: Background task yielding keepalives + agent running concurrently**

```python
async def agent_invocation(payload, context):
    task = asyncio.create_task(run_agent(prompt))
    while not task.done():
        yield ": keepalive\n\n"  # SSE comment
        await asyncio.sleep(30)
    result = task.result()
    yield {"event": ...}
```

Problems:
1. No guarantee AgentCore Runtime framework handles interleaved keepalive yields correctly
2. The Strands callback_handler fires in a **different execution context** — it cannot trigger a yield from the generator
3. Untested pattern with no documentation or examples in AgentCore/Strands

**Attempt 4: Use OTel traces or CloudWatch Logs instead of DynamoDB**

| Alternative | Latency | Real-time enough? | Complexity |
|-------------|---------|-------------------|------------|
| CloudWatch Logs | 5-15s delivery | NO — tool flashes would lag badly | High (subscription filters, log parsing) |
| OTel/X-Ray traces | Seconds to minutes | NO — designed for dashboards | High (custom span processors, query API) |
| Bedrock model invocation logging | Minutes | NO | Captures model I/O only, not tool flow |
| DynamoDB direct write (current) | <100ms | YES | Low (single `put_item`) |

### Why can't we just use the Harness path for everything?

The Harness path (`invokeHarnessAgent` in `agent-invoker.mjs:156-217`) DOES stream and the orchestrator DOES parse tool events from it. This is simpler — no custom agent code needed.

**But Harness has a separate fatal bug**: It has a hardcoded 120s `read_timeout` on its **internal** botocore connection to `bedrock-runtime`. This kills the agent's own model call (not just the stream to the orchestrator). After 3-5 tool calls, context grows large enough that model TTFT exceeds 120s → `ReadTimeoutError` → agent crashes.

**Ref**: `demo/bug-reports/agentcore-harness-read-timeout.md`
- Affects even Sonnet 4.5 (not just Opus)
- 100% failure rate on agents with 8+ tools and complex prompts
- No customer-configurable workaround
- This is why we moved to Runtime (where we control `read_timeout=600s`)

### Comparison: Harness vs Runtime event publishing

| | Harness | Runtime (current) |
|---|---|---|
| Who publishes tool events? | Orchestrator (parses stream) | Agent (callback → DDB) |
| Custom agent code needed? | No | Yes (`ToolTrackingHandler`) |
| Works with Opus + many tools? | **NO** (120s internal timeout) | **YES** (600s configurable) |
| Extra agent permissions? | No | Yes (DDB write) |
| Extra env vars? | No | Yes (`EVENTS_TABLE`) |

**If/when AWS fixes the Harness internal timeout**, we could switch back and simplify. Until then, Runtime + callback is the only working option for complex agents.

### The events table is not optional

Even if streaming worked perfectly, the events table would still be needed for:
1. **Close-laptop-reconnect** — replay events to reconstruct UI state
2. **Multi-client support** — multiple browsers can observe the same workflow
3. **Audit trail** — complete history of what every agent did
4. **Decoupled architecture** — frontend doesn't need a live connection to the orchestrator

The events table is the **single communication channel** between backend and frontend. The only question was WHO writes to it — and the answer is: agents write real-time events directly, orchestrator writes lifecycle events.

### Final Comparison of Approaches

| Approach | Real-time tool events? | Real-time text? | Survives tool waits? | Survives disconnect? | Works with Opus? |
|----------|----------------------|-----------------|---------------------|---------------------|-----------------|
| SSE streaming (original) | Yes | Yes | **NO** (120s LB timeout) | **NO** | Yes (if tools fast) |
| Harness streaming | Yes (via orchestrator) | Yes | **NO** (120s internal timeout) | **NO** | **NO** (crashes) |
| Non-streaming + DDB events (current) | Yes | No | **YES** | **YES** | **YES** |
| Hypothetical keepalive streaming | Maybe | Yes | **UNPROVEN** | Partially | Unknown |

### If we ever want live text streaming

The correct path (doesn't fight the LB timeout):
1. Keep `invoke_async` as the primary invocation method (DL-001 stays)
2. Add a `text_delta` event type to the Strands callback_handler (it fires on text generation too)
3. Publish text deltas to DynamoDB alongside tool events (same `put_item` pattern)
4. Frontend already handles replay — text would just be another event type

This gives "streaming" UX without actual SSE streaming to the agent. The DynamoDB polling (1s interval) provides near-real-time display. The 1s latency is imperceptible for a pipeline that runs 5-30 minutes.

**Bottom line**: We already HAVE real-time event delivery — just through DynamoDB instead of SSE. The architecture is correct. The only enhancement worth pursuing is publishing `text_delta` events for live "thinking" text, using the same side-channel pattern we already have.

---

### What if AWS fixes the Harness internal timeout?

Even if Harness fixes its internal 120s `read_timeout` (the bug in `agentcore-harness-read-timeout.md`), the **external LB idle timeout still applies to the stream back to the caller**. The fix would help but not fully solve streaming:

| Scenario after internal fix | Tool time + Model TTFT | Stream works? |
|---|---|---|
| Sonnet, 3-5 tools, moderate context | ~30-60s gaps | Likely YES |
| Sonnet, 8+ tools, large context | ~60-120s gaps | RISKY |
| Opus, 5+ tools, large context | ~120-300s gaps | **NO** (LB kills it) |

**Two separate bugs at two separate layers:**

| Bug | Layer | Filed |
|-----|-------|-------|
| Internal read_timeout (Harness) | Agent → Bedrock model | `demo/bug-reports/agentcore-harness-read-timeout.md` |
| External LB idle timeout | Caller → AgentCore stream | `demo/bug-reports/agentcore-lb-idle-timeout.md` |

Fixing the internal bug makes Harness viable for simple agents. Fixing the LB timeout (or adding SSE keepalives) would make streaming viable for ALL agents. Until both are fixed, our non-streaming + DDB side-channel architecture remains the only reliable pattern for complex Opus agents.

**AWS's expected fix**: The correct solution is SSE comment keepalives (`: keepalive\n\n`) emitted by the AgentCore service during idle periods. This is industry standard for long-lived SSE and resets LB timers transparently. See bug report for full proposal.

---

### DL-005: DynamoDB as Sole State Machine (Lambda Orchestration Mode)

**Date**: 2026-05-19
**Decision**: Implement `TICKET_PROVIDER=dynamodb` — DynamoDB ticket status is the state machine, DynamoDB Streams drive all orchestration
**Status**: IMPLEMENTED (not yet deployed)

**Context**: The current architecture uses a hybrid model: DynamoDB stores tickets, but the Next.js engine syncs them to an in-memory store and drives orchestration inline (`processReadyTickets`). This has two problems:
1. **Race condition (P1)**: Requirements agent marks tickets "skip" but the engine fires design agents before skips propagate (documented in `demo/bug-reports/pipeline-retro-run2-2026-05-19.md`)
2. **Not Jira-swappable**: The customer wants to use Jira + webhooks for production. The in-memory orchestration can't be swapped for external webhooks.

**Solution — Two-mode architecture**:

| Mode | Env Var | Who Orchestrates | Trigger |
|------|---------|-----------------|---------|
| DynamoDB | `TICKET_PROVIDER=dynamodb` | DynamoDB Streams → orchestrator Lambda | Automatic on ticket table writes |
| Jira | `TICKET_PROVIDER=jira` | Jira webhook → orchestrator Lambda | Jira Cloud webhook on status change |

**Lambda mode flow**:
```
1. startWorkflow() creates ticket skeletons in DynamoDB:
   - Epic (in_progress)
   - Requirements ticket (todo, no blockers) → Stream fires immediately
   - 7 Design tickets (blocked by requirements)
   - 3 Dev tickets (blocked by all design)
   - QA ticket (blocked by all dev)
   - CI ticket (blocked by QA)

2. Stream fires for requirements ticket → orchestrator Lambda invokes agent

3. Requirements agent reviews tickets:
   - Skips irrelevant (transitions to "done") → Stream fires → unblocks nothing
   - Updates relevant with details
   - Marks itself "done" → Stream fires → unblocks design tickets

4. Each design ticket unblocked → Stream fires → Lambda invokes design agent
   (Only tickets that become "todo" with empty blockedBy get invoked)

5. Design agents complete → mark "done" → Stream cascades to dev agents
   ... and so on through QA → CI → workflow complete
```

**Race condition fix (free)**:
In lambda mode, each ticket's status is authoritative. The orchestrator only invokes agents for tickets that are `status="todo"` with `blockedBy=[]`. If Requirements marks a design ticket "done" (skip), it never transitions to "todo", so it never fires. No race possible.

**Jira swap path**:
```
DynamoDB table         → Jira project
DynamoDB Streams       → Jira webhooks
Ticket status in DDB   → Jira ticket status
Thin webhook handler   → Same (already handles jira_transition events)
```

Switch: disable Streams, point Jira webhooks at `/api/workflow/webhook`, set `TICKET_PROVIDER=jira`.

**Files created/modified**:
- `src/lib/workflow/dynamo-workflow-store.ts` — DynamoDB workflows table read/write
- `src/lib/workflow/ticket-skeletons.ts` — Pre-creates all 13 tickets with dependency chains
- `src/lib/workflow/engine.ts` — Added `startWorkflowLambdaMode`, mode checks in `handleRequirementsCompletion`
- `src/app/api/workflow/webhook/route.ts` — Unified mode-aware webhook (thin in lambda, full in in-process)
- `lambda/orchestrator/index.mjs` — Stream-triggered orchestrator (already existed)
- `lambda/orchestrator/agent-invoker.mjs` — Async agent runner (already existed)
- `lambda/orchestrator/template.yaml` — SAM deployment template (already existed)

**Trade-off**: Two modes adds complexity, but allows:
- Local dev continues to work without AWS infra (in-process mode)
- Production uses the scalable, race-free Lambda architecture
- Customer can demo either mode

---

### DL-006: Requirements Agent Creates Tickets (No Skeletons)

**Date**: 2026-05-19 (initial skeleton approach), **REVERSED 2026-05-20**
**Decision**: Requirements agent creates tickets dynamically for only the relevant agents
**Status**: ACTIVE (replaces skeleton approach)

**Context**: The skeleton approach pre-created ALL 13 agent tickets at workflow start, then expected the requirements agent to "skip" irrelevant ones. This was backwards — it meant all agents fired regardless of scope (e.g., iOS/Android designers running on a web-only change). The requirements agent's "skip" triage never worked reliably because:
1. The Jira tools were routed to the wrong Lambda (never executed)
2. Even conceptually, "subtract from a full set" is more error-prone than "add what's needed"

**Solution**: Workflow start creates ONLY epic + requirements ticket. The requirements agent:
- Analyzes the feature scope
- Creates tickets for ONLY the agents whose domains are relevant
- Sets `blocked_by` dependencies between phases (design → dev → QA → CI)
- Each ticket INSERT fires the DynamoDB Stream → orchestrator invokes that agent

**Key principle**: Ticket = work assignment. No ticket = no work. The requirements agent is the PM.

**Why this is better for Jira swap**: In Jira, a PM creates tickets for the team members who need to do work. They don't pre-create 13 tickets and close 10 of them.

---

### DL-009: Orchestrator is a Thin Event Router

**Date**: 2026-05-20
**Decision**: Orchestrator Lambda does ONLY event routing — no business logic
**Status**: ACTIVE (cleanup TODO)

**Context**: The orchestrator accumulated business logic that belongs in agents:
- Feature branch creation (should be requirements agent via GitHub MCP)
- QA gate/retry logic (should be QA agent's decision)
- Workflow phase advancement (UI concern — derive from ticket state)

**Current state**: Phase advancement is still in the orchestrator (acceptable for now — it's a UI metadata write). Feature branch creation needs to be moved to agents.

**Target state**: Orchestrator does exactly two things:
1. Ticket goes `todo` (no blockers) → async invoke `agentcore-hub-agent-invoker`
2. Ticket goes `done` → remove from siblings' `blockedBy`, flip unblocked to `todo`

**TODO**: Move branch creation to requirements agent prompt.

**Cleaned up (2026-05-21)**:
- ~~Move QA retry logic to QA agent.~~ ✅ Done (DL-011)
- ~~"Fix: QA findings" title-matching re-trigger in `handleTicketDone`~~ ✅ Removed — was dead code that contradicted DL-011's agent-driven fix cycle and could have caused duplicate QA tickets if a fix title happened to match the prefix

---

### DL-010: Pure Event-Driven — No Inline Invocations or Concurrency Limits

**Date**: 2026-05-20
**Decision**: Remove all inline agent invocations and concurrency throttling from orchestrator
**Status**: ACTIVE

**Context**: The orchestrator had a "deferred ticket pickup" path that scanned for `todo` tickets and invoked agents directly inline (bypassing the Stream). This created two invocation paths and caused cascading invocations when tickets were manually marked done. A concurrency limit (`MAX_CONCURRENT=4`) was added as a workaround for the in-process engine.

**Problem**: With two invocation paths, ticket status was not the single source of truth. Marking a ticket "done" triggered cascading unblocks AND inline invocations simultaneously.

**Solution**: Removed all inline invocation logic. Removed concurrency limit. Single invocation path:
- Ticket status changes → Stream fires → `handleTicketReady` → invoke agent
- All same-phase agents run in parallel (Bedrock/AgentCore handles scaling)

**Trade-off**: No concurrency protection against Bedrock rate limits. Accepted because:
- Runtime agents are independent Lambda invocations (no shared resource)
- AgentCore handles per-account throttling
- If rate limiting becomes an issue, add it back as a simple counter in `handleTicketReady`

---

### DL-011: Agent-Driven Fix Cycle (QA/CI → Dev → Re-verify)

**Date**: 2026-05-19
**Decision**: QA and CI agents drive the fix cycle using ticket creation + self-blocking — no orchestrator logic
**Status**: ACTIVE

**Context**: When QA or CI finds issues, the dev agent needs to fix them and QA needs to re-verify. Originally this was modeled as a `WorkflowOutput___request_fix` tool that called a webhook, which had orchestrator logic to create fix tickets and manage retry counts. This violated the "dumb orchestrator" principle (DL-009).

**Problem**: Business logic (retry tracking, fix routing, re-verification triggers) was accumulating in the orchestrator webhook handler instead of living in the agents.

**Solution — Agents drive it with existing ticket tools**:

```
QA finds issues
  ↓
QA calls Tickets___create_ticket:
  - title: "Fix: {what's broken}"
  - description: findings + evidence + S3 paths for prior work
  - assignee: target dev agent
  - blocked_by: [] (immediately invocable)
  ↓
QA calls Tickets___transition_ticket on ITSELF:
  - transition_id: "block"
  - blocked_by: [fix-ticket-id]
  ↓
QA calls report_completion (signals it's waiting)
  ↓
DDB Stream fires → orchestrator invokes dev agent (dumb routing)
  ↓
Dev agent reads fix ticket description + its own S3 output
Dev agent fixes on feature branch, marks fix ticket "done"
  ↓
Orchestrator removes fix ticket from QA's blockedBy
QA flips to "todo" → Stream fires → QA re-invoked
  ↓
QA re-verifies (same checks)
  - Pass → report_completion
  - Fail → create another fix ticket (up to 3 cycles)
  - 3 cycles exhausted → report_completion with "ESCALATE:" prefix
```

**Key design decisions**:
1. **No new tools needed** — `create_ticket` + `transition_ticket` + `report_completion` already exist
2. **No orchestrator changes** — it already does "done → unblock siblings"
3. **Context via reference, not payload** — fix ticket tells dev WHERE to find its prior work (S3 path), not what it contained. Agent reads its own context.
4. **Self-tracking retries** — QA counts fix tickets under the epic via `list_tickets`. No external counter.
5. **`invoke_team_agent` removed** — not needed for this pattern. True A2A (synchronous agent-to-agent invocation) deferred for future.

**Session resume**:
- No actual session persistence (AgentCore sessions are infrastructure routing, not conversation memory)
- "Context resume" via reference: dev agent's prior output is in S3 (`workflows/{wfId}/agents/{agentId}/output.md`), its commits are on the feature branch, and the fix ticket description tells it exactly what broke
- If true session resume is needed later: store Strands Agent `messages` array to S3 after each invocation, load as `conversation_history` on re-invocation

**Files modified**:
- `src/config/agent-prompts.ts` — QA and CI prompts rewritten for ticket-driven fix cycle
- `src/config/agents.json` — Removed `invoke_team_agent`, added Jira tools to QA/CI

**Removed**:
- `WorkflowOutput___request_fix` tool (was referenced in prompts but never implemented — no longer needed)
- `request_fix` webhook handler logic (dead code after this change — cleanup TODO)

---

### DL-012: System Prompts Baked at Deploy Time (Not Passed at Invocation)

**Date**: 2026-05-19
**Decision**: Each Runtime agent deploys with its system prompt as an env var (`SYSTEM_PROMPT`). The orchestrator does NOT pass system prompts — it only passes task context (ticket description + workflow metadata).
**Status**: ACTIVE

**Context**: The universal `main.py` originally accepted `system_prompt` from the invocation payload, with the orchestrator responsible for looking up and passing the correct prompt per agent. This violated the "dumb orchestrator" principle (DL-009) and meant agent identity was managed externally rather than being intrinsic to the deployed agent.

**Problem**: The orchestrator was never actually passing `system_prompt` — every agent was running with a generic fallback (`"You are a helpful AI agent on a development team"`). The prompts in `src/config/agent-prompts.ts` were dead code that never reached the Runtime agents.

**Solution**:
1. Per-agent prompt files: `deploy/runtime-agent/prompts/{agent_name}.txt`
2. `deploy-one.sh` reads the prompt file and passes `--env SYSTEM_PROMPT=...` at deploy time
3. `main.py` reads `os.getenv("SYSTEM_PROMPT")` — agent identity is fixed at deployment
4. Orchestrator only passes: `{ prompt: taskContext, workflow_id, agent_id }`
5. Redeploy = prompt update goes live (version bump in AgentCore console)

**Architecture alignment**:
- Matches AgentCore's design: each Runtime is a self-contained agent with model + tools + prompt
- Matches Strands SDK pattern: `Agent(model=..., system_prompt=..., tools=[...])`
- Orchestrator stays thin: `ticket.status → invoke(agentArn, taskContext)`

**Future target (DL-012b)**: Remove `buildAgentContext` from orchestrator entirely. Requirements agent writes rich ticket descriptions with all needed context. Dev/QA agents use their own tools (S3, GitHub) to discover design artifacts, branches, etc. Orchestrator becomes: `prompt: ticket.description`. Agents are smart enough (Opus) to self-serve.

**Files modified**:
- `deploy/runtime-agent/main.py` — reads `SYSTEM_PROMPT` from env, removed payload-based prompt
- `deploy/runtime-agent/deploy-one.sh` — reads prompt file, passes as `--env`
- `deploy/runtime-agent/deploy-fleet.sh` — updated comments
- `deploy/runtime-agent/prompts/*.txt` — 14 per-agent prompt files (source of truth)
- `lambda/orchestrator/agent-invoker.mjs` — updated comment (system_prompt not in payload)

**Source of truth for prompts**: `deploy/runtime-agent/prompts/` (NOT `src/config/agent-prompts.ts` — that file is now legacy/dead code for the in-process engine only)

---

### DL-007: Timeline-Based Replay System for Completed Workflows

**Date**: 2026-05-19
**Decision**: Completed workflows replay from a pre-fetched event array with client-side pacing, not SSE
**Status**: ACTIVE

**Context**: When a user clicks on a completed workflow, the original behavior would dump all events at once (reconstructing final state instantly). This loses the narrative of what happened — you can't see which agents ran in what order, which tools they used, or how the pipeline progressed through phases.

**Problem**:
1. No visibility into past workflow execution order
2. Dumping all events at once makes all agents appear "done" simultaneously
3. No way to scrub through history or replay at different speeds

**Solution — Timeline-based replay system**:

1. **New API endpoint** `GET /api/workflow/[id]/events` fetches ALL events for a workflow as a single JSON array (paginates through DynamoDB's `LastEvaluatedKey` internally)
2. Events stored in `replayEvents[]` array, ordered by timestamp/eventId
3. Client-side replay engine steps through events one at a time using the same visual logic as live mode
4. Scrubber bar provides play/pause, seeking, and speed control (1x, 3x, 5x, 10x, 20x, 50x)

**Architecture**:

| Component | Responsibility |
|-----------|---------------|
| `GET /api/workflow/[id]/events` | One-shot paginated fetch of all events, applies `transformEvent()` |
| `replayMode` flag | True when workflow was already "complete" on first load |
| `applyEventToState(0→N)` | Reconstructs phase + agentTasks state from scratch for any position N |
| `fireReplayVisuals(event)` | Triggers tool flashes and connector animations WITHOUT calling setState |
| Scrubber UI | Range slider + play/pause + speed selector + counter (e.g., "59 / 1304") |

**Pacing**: Delays between events use actual DynamoDB timestamps, compressed by speed multiplier. Max 2s gap (prevents long waits between phases), min 50ms between events.

**Intake phase handling**: No DynamoDB events exist for the Intake phase (it's user-triggered). Replay starts with `phase="requirements"` (first actual event). Intake is hardcoded as "done" from the start. The Intake→Requirements connector animates once on replay start (300ms delay, 700ms animation).

**Key design decisions**:
1. **No SSE for completed workflows** — replay mode skips the SSE stream entirely. State polling also stops once replay mode activates.
2. **State reconstruction from scratch on every seek** — simple and correct. No delta/undo tracking needed. For 1304 events, `applyEventToState` loop is trivially fast (<1ms).
3. **Separated visual effects from state** — `fireReplayVisuals()` only does tool flashes and connector animations. `handleEvent()` is only used for live workflows (it calls setState which would conflict with replay reconstruction).
4. **Real timestamps for pacing** — gives natural rhythm. Bursts of tool calls replay fast, long gaps between phases are compressed to max 2s.

**Response format**:
```json
{ "events": WorkflowEvent[], "count": number }
```
Each event includes `eventId` (DynamoDB sort key) used as a cursor for SSE catch-up (see DL-008).

**Files created/modified**:
- `src/app/api/workflow/[id]/events/route.ts` — New endpoint (paginated DynamoDB fetch + transformEvent), returns `eventId` per event
- `src/components/workflow/WorkflowBoard.tsx` — Replay logic, scrubber UI, `applyEventToState`, `fireReplayVisuals`
- `src/lib/workflow/types.ts` — Added `timestamp?: string` and `eventId?: string` to WorkflowEvent union type

**Trade-off**: Fetching all events upfront means a larger initial payload (~100-500KB for 1000+ events). Accepted because:
- It's a one-time fetch (not polling)
- Events are small JSON objects
- Client-side replay is instant after fetch
- Alternative (streaming replay via SSE) adds unnecessary server complexity for historical data

---

### DL-008: Catch-Up Replay for Live Workflows

**Date**: 2026-05-19
**Decision**: When clicking on a live/in-progress workflow, visually replay historical events at dynamic speed (auto-scaled to ~4s) before transitioning to live SSE
**Status**: ACTIVE

**Context**: When a user clicks on a live workflow that's been running for 10+ minutes, the original behavior dumps all historical events instantly via SSE (the stream starts from `lastEventId=""` and delivers everything). This floods the UI — all past phases appear complete simultaneously with no visual narrative.

**Problem**:
1. No visual sense of "what happened before I opened this" — everything appears done instantly
2. If the workflow is in the development phase, you can't see how it got there
3. Inconsistent with the replay experience for completed workflows (which has scrubber + pacing)

**Solution — Catch-up replay with SSE handoff**:

1. On first load of a live workflow (`phase !== "complete"`):
   - Fetch ALL historical events from `GET /api/workflow/[id]/events` (same endpoint as replay)
   - Store the `eventId` of the last fetched event (for SSE cursor)
   - Calculate dynamic playback speed so catch-up completes in ~4 seconds:
     - `speed = max(20, totalTimeSpan / 4000ms)` — e.g., 18min run → ~270x, 2min run → 20x floor
     - Per-event delay floor: `max(3ms, 4000ms / eventCount)` — adapts to event density
     - Per-event delay ceiling: 200ms (vs 2s in normal replay) — time gaps don't stall catch-up
   - Enter catch-up mode using `applyEventToState` + `fireReplayVisuals` logic
   - Show "Catching up..." pulsing indicator in the replay bar

2. When replay reaches end of fetched events:
   - `catchingUp` flag clears → `replayMode` set to false
   - SSE stream connects with `?cursor=<lastEventId>` to skip already-replayed events
   - UI transitions seamlessly to live mode (scrubber bar disappears, live polling resumes)
   - New events from SSE layer on top of the catch-up state via `handleEvent()`

3. SSE stream now accepts `?cursor=` query parameter:
   - If provided, starts DynamoDB query from `eventId > cursor`
   - Prevents duplicate events during handoff

**State management**:
- `catchingUp: boolean` — true while fast-replaying history
- `lastEventIdRef` — stores the DynamoDB `eventId` of the last replayed event (used as SSE cursor)
- `catchUpCompleteRef` — guards against double-transition
- `originalOutputsRef` — preserves DDB agent outputs before replay overwrites state (events often have empty output fields)
- `playbackSpeed` — dynamically calculated for catch-up; user-selectable for manual replay
- SSE effect depends on `[workflowId, replayMode, catchingUp]` — only connects when both are false

**Dynamic speed scaling** (catch-up only):
- Target: ~4 seconds total catch-up time regardless of workflow duration or event count
- Speed formula: `max(20x, totalEventTimeSpan / 4000ms)`
- Delay floor adapts: `max(3ms, 4000ms / eventCount)` — prevents 50ms × 1000 events = 50s problem
- Delay ceiling: 200ms during catch-up (vs 2000ms in normal replay)
- Normal replay retains 50ms floor + user-controlled speed selector for smooth scrubbing

**Component remount on workflow switch**:
`<WorkflowBoard key={selectedId} .../>` ensures full component remount when switching between workflows. This gives each workflow a clean slate of state, refs, and timers. Without `key`, React reuses the instance and state from the previous workflow leaks.

**Connector animation fix** (related):
`fireReplayVisuals` now handles `agent_status` events (not just `phase_change`). A "high-water mark" ref tracks the highest animated phase index — when an agent starts in a new phase, the connector fires. This fixes the dev→QA transition which had no explicit `phase_change` event in DynamoDB (QA agents just start running).

**Files modified**:
- `src/app/api/workflow/[id]/events/route.ts` — Added `eventId` field to transformed events
- `src/app/api/workflow/[id]/stream/route.ts` — Added `?cursor=` query param support
- `src/components/workflow/WorkflowBoard.tsx` — Catch-up logic, `replayPhaseHighWaterRef`, agent_status connector animation
- `src/app/workflow/page.tsx` — Added `key={selectedId}` to WorkflowBoard
- `src/lib/workflow/types.ts` — Added `eventId?: string` to WorkflowEvent type

**Trade-off**: 20x replay of 1000+ events still takes ~10-30 seconds for a full workflow. Accepted because:
- It provides the same visual narrative as the completed replay
- Users see the pipeline "catch up" which confirms the system is working
- The alternative (instant dump) is confusing and gives no sense of progression
- If needed, speed could be increased to 50x or events could be pre-filtered

---

### DL-013: Skills System — Dynamic System Prompt Injection via Tool Call

**Date**: 2026-05-19
**Decision**: Implement a custom skills system using `agentcore-hub-skill-loader` Lambda for dynamic prompt injection at agent runtime
**Status**: ACTIVE

**Context**: Agents need domain-specific expertise (e.g., code architecture patterns, code review checklists, test coverage strategies) that shouldn't bloat the base system prompt. Neither Strands SDK nor AgentCore has a native skills/plugins mechanism — validated against both official docs.

**Problem**:
1. System prompts grow unwieldy when every specialized behavior is baked in at deploy time (DL-012)
2. Multiple agents share the same skills (e.g., `code-architect` used by 3 designers)
3. Skills evolve independently of agent prompts — updating a skill shouldn't require agent redeploy
4. No native pattern exists in Strands or AgentCore for on-demand prompt augmentation

**Solution — "Dynamic system prompt injection via tool call" pattern**:

```
Agent prompt says "load skill X"
  ↓
Agent calls SkillLoader___load_skill tool (MCP tool on the agent's Runtime)
  ↓
Lambda (agentcore-hub-skill-loader) looks up skill name in SKILLS map
  ↓
Lambda returns markdown instructions as tool response
  ↓
Agent incorporates skill content into its working context
  ↓
Agent proceeds with skill-augmented behavior
```

**Implementation**: Skills are defined inline in `lambda/skill-loader/index.mjs` as a `SKILLS` map (key → markdown string). Not S3, not Bedrock Knowledge Bases, not a plugin system. Simple, deterministic, and cheap ($0 beyond Lambda invocation cost).

**Skills deployed** (7 new, sourced from Anthropic claude-code plugins repo):
| Skill | Purpose |
|-------|---------|
| `code-architect` | System design patterns, component decomposition |
| `type-design` | Type system design, interface contracts |
| `code-review` | Review checklists, quality gates |
| `silent-failure-hunter` | Find swallowed errors, missing error handling |
| `code-simplifier` | Reduce complexity, eliminate dead code |
| `test-coverage` | Coverage strategy, edge case identification |
| `feature-dev` | Feature implementation workflow, incremental delivery |

**Agent-to-skill mapping**:

| Agent | Skills |
|-------|--------|
| `frontend-designer` | frontend-design + code-architect |
| `backend-designer` | backend-systems + code-architect + type-design |
| `ios-designer` | ios-architecture + code-architect + type-design |
| `frontend-dev` | full-stack + code-simplifier + feature-dev |
| `backend-dev` | node-typescript + code-simplifier + feature-dev |
| `api-dev` | node-typescript + code-simplifier + feature-dev |
| `qa-verifier` | qa-verification + code-review + silent-failure-hunter + test-coverage |
| `ci-agent` | ci-verification + code-review |
| `security-reviewer` | privacy-compliance + silent-failure-hunter |

**Why not alternatives?**:

| Alternative | Why rejected |
|-------------|-------------|
| Bake into system prompt (DL-012) | Bloats prompt, shared skills duplicate across agents, update = redeploy |
| S3 file per skill | Adds latency (S3 GET), needs IAM, no advantage over inline map |
| Bedrock Knowledge Base | Overkill (vector search for known-key lookup), adds cost + latency |
| Plugin/extension system | Over-engineered for deterministic skill loading — we always know which skill we want |

**Properties**:
- **Deterministic**: Agent asks for skill X, gets skill X (no retrieval ambiguity)
- **Cheap**: Single Lambda invocation (~$0.0000002 per load)
- **Updateable without redeploy**: Edit `index.mjs`, deploy Lambda only (not agents)
- **Composable**: Agents load multiple skills per invocation
- **Auditable**: Tool call appears in agent trace events (DL-003)

**Also deployed**: New Runtime agent `agentcore_hub_frontend_designer` for design-phase web UI architecture work.

**Branding system**: S3 bucket `agentcore-hub-branding` stores `brand-system.md` (design tokens, component library, color palette). The `frontend-designer` agent reads it via `S3Storage___read_object` tool at invocation start — separate from skills (branding is project-specific data, not reusable expertise).

**Files created/modified**:
- `lambda/skill-loader/index.mjs` — Skill loader Lambda (SKILLS map + handler)
- `deploy/runtime-agent/prompts/frontend-designer.txt` — New agent prompt (loads skills + branding)
- `deploy/runtime-agent/deploy-one.sh` — Updated for frontend-designer deployment

**Validation**: Confirmed against Strands SDK source (`strands-tools-src/`) and AgentCore docs — neither provides a native skills, plugins, or dynamic prompt injection mechanism. Our Lambda-based tool call pattern is the correct approach for this requirement.

---

## Deployment Requirements

### Runtime Agents (DL-003)

After the 2026-05-19 changes, all 14 Runtime agents need redeployment:

```bash
# Required env vars (added):
EVENTS_TABLE=agentcore-hub-events

# Required IAM permissions (verify on role):
dynamodb:PutItem on arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/agentcore-hub-events

# Deploy command:
cd deploy/runtime-agent && ./deploy-fleet.sh
```

### Lambda Orchestration Stack (DL-005)

To enable Lambda orchestration mode:

```bash
# 0. Create DynamoDB tables (run ONCE per account — skip if tables exist)
#    CRITICAL: agentcore-hub-workflows PK MUST be "workflowId" (NOT "id")
#    See scripts/create-dynamodb-tables.sh for full table definitions
./scripts/create-dynamodb-tables.sh

# 1. Enable DynamoDB Streams on agentcore-hub-tickets table (if not already)
aws dynamodb update-table \
  --table-name agentcore-hub-tickets \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --region us-east-1

# 2. Deploy the Lambda functions (orchestrator + agent-invoker + events-writer)
#    CRITICAL: Must run npm install BEFORE zipping — @smithy/signature-v4 is required
#    for Runtime agent invocation. Without it, agents fall back to Harness mode silently.
./lambda/orchestrator/deploy.sh

# Alternative: SAM deploy (creates functions + event source mapping from scratch)
# cd lambda/orchestrator && sam build && sam deploy --guided

# 3. Set env vars on BOTH Lambdas (agentcore-hub-orchestrator AND agentcore-hub-agent-invoker):
#    TICKETS_TABLE=agentcore-hub-tickets    (NOT "UNUSED" or any placeholder!)
#    WORKFLOWS_TABLE=agentcore-hub-workflows
#    EVENTS_TABLE=agentcore-hub-events
#    JIRA_API_TOKEN=<your-token>      (must match App Runner token)
#    JIRA_SITE_URL=<your-site>.atlassian.net
#    JIRA_EMAIL=<your-email>
#    TICKET_PROVIDER=jira              (or "dynamodb")
#    RUNTIME_ARN_AGENTCORE_HUB_*=<arns>     (orchestrator only — one per agent)

# 3. Set env vars on Next.js app:
TICKET_PROVIDER=dynamodb
TICKET_PROVIDER=dynamodb
WORKFLOWS_TABLE=agentcore-hub-workflows
TICKETS_TABLE=agentcore-hub-tickets

# 4. Set Runtime agent ARNs as env vars on orchestrator Lambda:
# (one per agent — format: RUNTIME_ARN_AGENTCORE_HUB_{AGENT_NAME_UPPER})
RUNTIME_ARN_AGENTCORE_HUB_REQUIREMENTS_ANALYST=arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/xxx
RUNTIME_ARN_AGENTCORE_HUB_BACKEND_DESIGNER=arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:runtime/xxx
# ... etc for all 13 agents
```

### Jira Swap (Future — after Lambda mode is stable)

```bash
# 1. Disable DynamoDB Streams
aws dynamodb update-table \
  --table-name agentcore-hub-tickets \
  --stream-specification StreamEnabled=false

# 2. Configure Jira webhook to POST to /api/workflow/webhook
#    Event: issue_updated (status field changes)
#    URL: https://your-app.com/api/workflow/webhook
#    Secret: set WEBHOOK_SECRET env var to match

# 3. Switch ticket provider
TICKET_PROVIDER=jira

# 4. The webhook route already handles Jira-native format (DL-005)
```

---

## File Map

| File | Role |
|------|------|
| `src/components/workflow/WorkflowBoard.tsx` | Pipeline UI + CSS animations + replay logic + S3 modal integration |
| `src/components/workflow/S3ArtifactsModal.tsx` | S3 artifact browser modal (portal, focus trap, download) |
| `src/app/api/workflow/artifacts/route.ts` | List S3 objects for a workflow/agent |
| `src/app/api/workflow/artifacts/download/route.ts` | Download single file or ZIP of all artifacts |
| `src/app/api/workflow/[id]/stream/route.ts` | DynamoDB poll → SSE to frontend (live mode), accepts `?cursor=` for catch-up handoff |
| `src/app/api/workflow/[id]/events/route.ts` | One-shot paginated fetch of all events + eventIds (replay + catch-up) |
| `src/app/workflow/page.tsx` | Workflow page — renders WorkflowBoard with `key={selectedId}` for clean remount |
| `src/app/api/workflow/webhook/route.ts` | Mode-aware webhook (thin in lambda, full in in-process) |
| `src/lib/workflow/engine.ts` | Orchestration engine (mode-aware: in-process or lambda) |
| `src/lib/workflow/dynamo-workflow-store.ts` | DynamoDB workflows table read/write |
| `src/lib/workflow/ticket-skeletons.ts` | Creates epic + requirements ticket only (agents create their own tickets) |
| `src/lib/workflow/ticket-provider-dynamodb.ts` | DynamoDB ticket CRUD (shared with Lambda) |
| `src/lib/workflow/ticket-provider.ts` | Provider interface + selection (memory/dynamodb/jira) |
| `lambda/orchestrator/index.mjs` | Stream-triggered orchestrator Lambda |
| `lambda/orchestrator/agent-invoker.mjs` | Async agent invocation Lambda (15min timeout) |
| `lambda/orchestrator/events-writer.mjs` | EventBridge → events table writer |
| `lambda/orchestrator/template.yaml` | SAM template for full Lambda stack |
| `deploy/runtime-agent/main.py` | Agent code (all 13 agents) |
| `deploy/runtime-agent/prompts/*.txt` | Per-agent system prompts (source of truth) |
| `deploy/runtime-agent/deploy-one.sh` | Single agent deploy script |
| `deploy/runtime-agent/deploy-fleet.sh` | Fleet deploy (all agents) |
| `lambda/workflow-output/index.mjs` | Workflow output Lambda (S3 write + DynamoDB "done" write) |
| `scripts/start-test-workflow.sh` | **Standard test workflow launcher** (curl to `/api/workflow/start`) |

---

### DL-014: Completion Write Fix, Event TTL Removal, and Nudge System

**Date**: 2026-05-19
**Decision**: Fix three interconnected issues preventing reliable pipeline cascade and user recovery from stuck states
**Status**: ACTIVE

**Issue 1 — report_completion DynamoDB Write Fix**

**Problem**: `agentcore-hub-workflow-output` Lambda saved completion reports to S3 but never wrote `status: "done"` to the `agentcore-hub-tickets` DynamoDB table. The orchestrator's Stream trigger only fires on DynamoDB changes, so ticket completions were invisible — the cascade never continued past the first agent.

**Fix**: Lambda now writes `status: "done"` to the tickets table after S3 write. This fires the DynamoDB Stream → orchestrator sees completion → unblocks downstream tickets.

**Source**: `lambda/workflow-output/index.mjs`

---

**Issue 2 — Event TTL Removed**

**Problem**: Events in `agentcore-hub-events` table had a 1-hour TTL (`expiresAt`). Replay data expired before users could watch completed workflows (DL-007 relies on all events being available indefinitely for timeline replay).

**Fix**: Removed TTL entirely. Events persist forever. Cost is negligible (small JSON objects, single-digit KB per event, workflows produce ~1000-2000 events total).

**Note**: DL-002 documented `TTL: expiresAt (7 days)` — that was the original design. The actual deployed value was 1 hour (bug). Now removed completely.

---

**Issue 3 — Nudge System (client-side auto-nudge + manual button)**

**Problem**: Pipelines occasionally stall (agent timeout, missed Stream event, ticket stuck in wrong state). No recovery mechanism existed — users had to manually inspect DynamoDB.

**Solution — Two-layer nudge**:

1. **Auto-nudge**: `WorkflowBoard` detects idle >90s with no active agent (no `.working` status). Automatically calls nudge endpoint. Silent — no user action needed.

2. **Manual nudge**: Button in UI with toast feedback ("Nudged! Checking for stuck tickets..."). For when users notice a stall before the 90s threshold.

**Nudge endpoint**: `POST /api/workflow/[id]/nudge`

**Behavior** (no time thresholds — just fixes whatever's wrong):
- `todo` → `ready` (should have been picked up)
- `blocked` → `ready` (if all blockers are done)
- ~~`in_progress` → `ready` (agent timed out or crashed)~~ **REMOVED in DL-021** — caused duplicate agent sessions

**Critical detail**: Nudge sets `status: "ready"` (not just touching `updatedAt`). This is required because of the orchestrator's Stream filter.

---

**Issue 4 — Orchestrator Stream Filter (related to nudge)**

**Problem**: Orchestrator Lambda (line ~104 in `index.mjs`) skips MODIFY events where `newStatus === oldStatus`. The original nudge implementation only touched `updatedAt` without changing status (e.g., `todo` → `todo`). These events were invisible to the orchestrator — nudge did nothing.

**Fix**: Nudge transitions tickets to `status: "ready"` which is a genuine status change. The orchestrator sees `MODIFY` with `oldStatus !== newStatus` and processes the ticket normally via `handleTicketReady`.

**Implication**: Any recovery mechanism that touches tickets MUST change the `status` field to be visible to the orchestrator. Touching only `updatedAt` or other fields is a no-op from the orchestrator's perspective.

---

**Files modified**:
- `lambda/workflow-output/index.mjs` — Added DynamoDB `status: "done"` write
- `agentcore-hub-events` table — TTL attribute removed (no code change, infra-level)
- `src/components/workflow/WorkflowBoard.tsx` — Auto-nudge logic (90s idle detection)
- `src/app/api/workflow/[id]/nudge/route.ts` — Nudge endpoint (status fix logic)

---

## Starting Test Workflows

**IMPORTANT**: All workflows MUST be created through the `/api/workflow/start` API endpoint. This is the only path that correctly initializes all required fields (`startedAt`, `epicId`, ticket skeletons, etc.). Direct DynamoDB writes or other shortcuts will produce broken records (e.g., "Invalid Date" in the UI).

### Standard Script: `scripts/start-test-workflow.sh`

The canonical way to start a test workflow from the command line:

```bash
# Default test (StatusBadge component)
./scripts/start-test-workflow.sh

# Pre-defined scopes (increasing complexity)
./scripts/start-test-workflow.sh --scope minimal    # Single-file /health endpoint (~5 min)
./scripts/start-test-workflow.sh --scope sidebar    # Multi-component sidebar (~20 min)
./scripts/start-test-workflow.sh --scope full       # Data table with sorting/filtering (~30 min)

# Custom workflow
./scripts/start-test-workflow.sh --title "My Feature" --desc "Build X that does Y"

# Use Sonnet for faster/cheaper runs (Opus is default)
./scripts/start-test-workflow.sh --scope minimal --model sonnet
```

**Requirements**:
- Next.js dev server running on `localhost:3000` (or set `BASE_URL`)
- AWS credentials configured (DynamoDB access)
- `jq` installed (for JSON parsing)

**What it does**:
1. POSTs to `/api/workflow/start` with the specified title/description
2. Returns the `workflowId` and `epicId`
3. Prints a direct link to the workflow UI

### Via curl (manual)

```bash
curl -s -X POST http://localhost:3000/api/workflow/start \
  -H "Content-Type: application/json" \
  -d '{"title":"My Test","description":"Build something","sources":[],"repoConfig":{"repos":[{"url":"https://github.com/your-org/your-repo","defaultBranch":"main"}]}}' \
  | jq .
```

### Via the UI

Navigate to `http://localhost:3000/workflow` → click "New Workflow" → fill the intake form.

### What NOT to do

- Do NOT write directly to the `agentcore-hub-workflows` DynamoDB table
- Do NOT invoke agents without going through the workflow start route
- Do NOT use inline curl/scripts that bypass `/api/workflow/start`

Any workflow created without the start route will be missing `startedAt`, `epicId`, and ticket skeletons — causing UI display bugs and broken pipeline orchestration.

---

### DL-015: Fire-and-Forget Agent Invocation

**Date**: 2026-05-20
**Decision**: Agent invoker Lambda returns immediately after Runtime accepts the request (HTTP 200). Does not wait for agent completion.
**Status**: ACTIVE

**Context**: The invoker Lambda held open an HTTP connection for up to 840s (14 min) waiting for the agent to finish. This caused:
1. Lambda billed for entire agent runtime (~$0.50+ per invocation at 512MB)
2. Timeouts when agents ran longer than 840s (CI agent doing npm ci + build)
3. Redundant "done" write — agent already calls `report_completion` which marks ticket done

**Solution**: `fireAndForgetRuntime()` sends the request, confirms HTTP 200 (accepted), then `res.destroy()` and returns. Total Lambda duration: ~8 seconds vs ~840 seconds.

**Agent lifecycle is self-managed**:
- Agent writes `agent.streaming` events directly to DynamoDB (DL-003)
- Agent calls `report_completion` when done → `workflow-output` Lambda → marks ticket "done" → DDB Stream → orchestrator cascade
- If agent crashes without calling `report_completion` → ticket stays "in_progress" → nudge system detects 90s idle → triggers recovery

**What was removed from the invoker**:
- S3 output archiving (agent handles via `report_completion`)
- Backup "done" write to DDB (redundant — agent does it)
- `updateWorkflowTask()` (moved to `workflow-output` Lambda)
- EventBridge `agent.complete` event (orchestrator publishes equivalent in `handleTicketDone`)

**Legacy harness agents** still use synchronous invocation (they don't have `report_completion`). Will be migrated to Runtime containers.

**Trade-off**: If agent crashes silently, the ticket stays `in_progress` indefinitely (auto-nudge no longer resets it — see DL-021). Recovery requires manual nudge button or a future timed-recovery system. Accepted because crash-without-reporting is rare and the cost of duplicate sessions (the old auto-recovery) was worse than delayed detection.

---

### DL-016: Eliminate `agentcore-hub-workflows` Table (PLANNED)

**Date**: 2026-05-20
**Decision**: Consolidate all workflow state into the epic ticket on `agentcore-hub-tickets`. Delete `agentcore-hub-workflows` table.
**Status**: PLANNED (backlog)

**Context**: The `agentcore-hub-workflows` table stores:
- `workflowId`, `epicId`, `repoConfig`, `startedAt`, `status`, `phase`
- `agentTasks` map (output, branch, status per agent — powers UI output panel)

All of this data either already exists on the epic ticket + children, or can trivially be added as fields on the epic.

**Why eliminate**:
- Minimal infra principle — fewer tables = less to manage, less IAM, less cost
- Data is duplicated — children tickets already have `output`, `branch`, `status`, `assignee`
- The `agentTasks` map is just a denormalized cache of children ticket data
- Simplifies the mental model (ticket = single source of truth)

**Migration plan**:
1. Move `repoConfig`, `input`, `phase` to fields on the epic ticket
2. UI state endpoint: query epic + children via `parentId-index` instead of reading workflows table
3. Remove `agentTasks` map — derive from children tickets
4. Update orchestrator to read/write epic ticket instead of workflows table
5. Delete `agentcore-hub-workflows` table

**~5 places to update**: orchestrator Lambda, workflow-output Lambda, dynamo-read.ts, start route, state route.

**Estimated effort**: 2-hour refactor. Not urgent — current system works fine.

---

### DL-017: Container Deployment for Tool-Heavy Agents

**Date**: 2026-05-20
**Decision**: Deploy agents that need npm/Node.js/Playwright as container images instead of CodeZip
**Status**: ACTIVE (CI agent deployed as container)

**Context**: CodeZip deployment only supports Python. Agents that need Node.js tools (Claude Code CLI, npm for builds, Playwright for browser testing) had to install them at runtime — adding 2-5 minutes of setup per invocation and sometimes hanging.

**Solution**: Pre-built ARM64 Docker image with all tools baked in:
- Python 3.13 + agent code
- Node.js 20 + npm
- `@anthropic-ai/claude-code` CLI
- Playwright + Chromium

Image pushed to ECR, deployed via `update_agent_runtime` API with `container_uri`.

**Key learning**: Cannot switch a runtime from CodeZip → Container in-place. Must create a new runtime. The `agentcore` CLI handles this via `agentcore configure -dt container` + `agentcore deploy --local-build`.

**Trade-off**: Larger image (~1GB compressed). Accepted because cold start is still fast on AgentCore (microVM boots in <3s regardless of image size).

---

### DL-018: Dual-Write Ticket Lambda — Jira-First, Same ID in DynamoDB

**Date**: 2026-05-20
**Decision**: The agent tool Lambda (`agentcore-hub-tickets`) ALWAYS writes tickets to BOTH Jira Cloud AND DynamoDB, using Jira's auto-generated key as the canonical ID in both systems.
**Status**: ACTIVE (deployed 2026-05-20)

**Context**: The system supports two deployment modes via `TICKET_PROVIDER` flag on the orchestrator Lambda:
- `jira` → orchestrator listens to Jira webhooks only (ignores DDB stream)
- `dynamodb` → orchestrator listens to DDB stream only (ignores webhooks)

Both modes need ticket data to exist. The agents have ONE tool Lambda — it can't conditionally write to "the right one" because it doesn't know which mode the orchestrator is in (and shouldn't need to).

**Problem solved**: Without dual-write, switching `TICKET_PROVIDER` breaks the pipeline because tickets only exist in one system.

**Solution — Jira-first, then DDB with same key**:

```
Agent calls Tickets___create_ticket
  ↓
1. Create in Jira Cloud → get TEAM-XX key (Jira auto-generates)
2. Write to DynamoDB with ticketId = TEAM-XX (same key)
3. Return TEAM-XX to agent
  ↓
Agent uses TEAM-XX for all references (blocked_by, transitions, comments)
  ↓
Both systems have the ticket under the same ID
```

**Why Jira-first (not parallel with our own ID)**:
- You CANNOT set Jira's issue key — it auto-generates from project counter
- Agent uses the returned ID for `blocked_by` references
- If DDB has TEAM-85 but Jira has TEAM-90, the Jira-mode orchestrator can't find TEAM-85
- Same ID in both = orchestrator works regardless of which system it reads from

**What dual-writes**:
| Operation | Jira | DynamoDB |
|-----------|------|----------|
| `create_ticket` | Creates issue, gets key | PutItem with same key |
| `transition_ticket` | Jira transition API | UpdateCommand status |
| `update_ticket` | PUT issue fields | UpdateCommand fields |
| `add_comment` | POST comment | Append to comments array |

**What does NOT dual-write** (read-only operations):
- `list_tickets` — reads from Jira only (source of truth for the tool)
- `get_issue` — reads from Jira only
- `search_issues` — reads from Jira only
- `get_transitions` — reads from Jira only

**DDB writes are best-effort**: If DDB write fails, the operation still succeeds (Jira is primary). Logged as warning. In the production Jira setup, no DynamoDB tickets table is provisioned — DDB writes silently fail and that's expected. The orchestrator reads/writes tickets via Jira API only.

**Orchestrator behavior by mode**:

| Mode | Listens to | Reads tickets from | DDB Stream mapping | Webhook route |
|------|-----------|-------------------|-------------------|---------------|
| `dynamodb` | DDB Stream (agentcore-hub-tickets) | DynamoDB | Enabled | Ignored |
| `jira` | Jira webhooks (via App Runner) | Jira API | Disabled/ignored | Active |

**CRITICAL**: These are mutually exclusive at runtime. ONE orchestrator Lambda, ONE `TICKET_PROVIDER` value. Deploy-time choice. You cannot run both modes simultaneously on the same Lambda.

**Why this is the correct architecture**:
1. Agents are mode-agnostic — they just call their tool, get a ticket ID back
2. Orchestrator is mode-aware — picks its event source based on flag
3. Both systems always have the data — switching modes never requires data migration
4. Ticket IDs are consistent — no cross-reference mapping needed

**Files**:
- `lambda/agentcore-hub-jira/index.mjs` — The dual-write tool Lambda (source of truth)
- `lambda/jira-unified/index.mjs` — DEPRECATED (old approach: DDB-first with Jira mirror, different IDs). Scheduled for deletion in cleanup.

**Env vars on `agentcore-hub-tickets` Lambda**:
- `JIRA_SITE_URL` — Jira Cloud site (e.g., your-domain.atlassian.net)
- `JIRA_EMAIL` — Auth email
- `JIRA_API_TOKEN` — API token
- `JIRA_PROJECT_KEY` — Project key (TEAM)
- `TICKETS_TABLE` — DynamoDB table (agentcore-hub-tickets)
- `AWS_REGION` — Region (us-east-1)

**DO NOT**:
- Deploy `lambda/jira-unified/index.mjs` to this Lambda (wrong approach — DDB-first, different IDs)
- Remove the DDB write from this Lambda (breaks DDB-mode orchestration)
- Remove the Jira write from this Lambda (breaks Jira-mode orchestration)
- Add `TICKET_PROVIDER` logic to this Lambda (it ALWAYS writes both, unconditionally)

---

### DL-019: Symmetric Event Source Guards (Anti-Double-Invocation)

**Date**: 2026-05-21
**Decision**: Orchestrator rejects events from the WRONG source based on `TICKET_PROVIDER` flag. Both directions guarded symmetrically.
**Status**: ACTIVE (deployed 2026-05-21)

**Context**: The dual-write Lambda (DL-018) writes tickets to BOTH Jira and DynamoDB. This means BOTH event sources fire for every ticket operation:
- DynamoDB INSERT/MODIFY → DDB Stream → triggers orchestrator
- Jira issue_created/issue_updated → Webhook → App Runner → invokes orchestrator

Without guards, the orchestrator processes BOTH triggers, invoking agents twice per ticket.

**Bug discovered**: We had a one-directional guard (DDB stream ignored when `TICKET_PROVIDER=jira`) but NOT the reverse. Webhook invocations were processed regardless of mode. This caused:
- Requirements agent invoked 2x simultaneously
- Both instances created tickets (duplicates + wrong features)
- All downstream agents fired on both sets of tickets
- 7509 events, 15 tickets (should be ~5-6), workflow stuck

**Root cause timeline**:
1. `agentcore-hub-tickets` dual-write deployed (DL-018) — writes to Jira + DDB for every ticket operation
2. In DDB mode: DDB stream fires → orchestrator invokes agent ✓
3. Jira issue_created webhook ALSO fires → App Runner route invokes orchestrator → agent invoked AGAIN ✗
4. Two requirements agents run simultaneously, interleave output, create duplicate/wrong tickets

**Fix — Symmetric guards in handler** (lines 84-97 of `index.mjs`):

```javascript
// Webhook invocation — only process if TICKET_PROVIDER=jira
if (event.source === "jira-webhook") {
  if (TICKET_PROVIDER !== "jira") {
    console.log(`[orchestrator] Ignoring Jira webhook — TICKET_PROVIDER=${TICKET_PROVIDER}, using DDB stream`);
    return;
  }
  await processStatusChange(event.ticketId, event.newStatus, event.oldStatus);
  return;
}

// DDB Stream invocation — only process if TICKET_PROVIDER=dynamodb
if (TICKET_PROVIDER === "jira") {
  console.log(`[orchestrator] Ignoring DDB stream — TICKET_PROVIDER=jira, using webhooks`);
  return;
}
```

**Result — Event source routing matrix**:

| Event Source | TICKET_PROVIDER=dynamodb | TICKET_PROVIDER=jira |
|---|---|---|
| DDB Stream | ✅ Processes | ❌ Rejects (existing guard) |
| Jira Webhook | ❌ Rejects (NEW guard) | ✅ Processes |

**Why this is necessary with dual-write**: Before DL-018, only ONE system received writes, so only ONE event source fired. Now that both always receive writes, both event sources ALWAYS fire. The guards ensure only the configured path processes events.

**Relationship to other DLs**:
- DL-018 (dual-write) creates the problem — both systems always have data, both always fire events
- DL-019 (this) solves it — orchestrator only listens to ONE source per mode
- Together they form the complete architecture: write everywhere, listen to one

**Files modified**:
- `lambda/orchestrator/index.mjs` — Added webhook rejection guard for non-jira modes (line 86-89)

---

### DL-020: Remaining Reliability Issues

**Date**: 2026-05-21
**Decision**: Document known remaining issues for future fixes
**Status**: PARTIALLY RESOLVED (Issue 1 fixed in DL-021)

**Issue 1 — No Idempotency Guard on Agent Invocation** → ✅ FIXED (DL-021)

~~DynamoDB Streams has at-least-once delivery. The same record CAN be delivered more than once. If the orchestrator processes a duplicate delivery, it will invoke the agent twice (because it doesn't check if the ticket is already `in_progress`).~~

**Fixed in DL-021**: Conditional write `ConditionExpression: "#s <> :inprog"` in both `handleTicketReady` and `handleTicketReadyUnified`. Only the first invocation wins.

---

**Issue 2 — No Validation on Ticket blocked_by Field**

If an agent creates a ticket without proper `blocked_by` references, it fires immediately. The orchestrator has no sanity check like "this is a dev ticket but no design tickets are done yet."

**Proposed fix**: In `handleTicketReadyUnified`, validate that the agent's phase makes sense given the workflow state. E.g., don't invoke a dev agent if no design agents have completed for this workflow.

**Priority**: LOW — primarily a prompt engineering problem. The requirements agent should always set `blocked_by`. With DL-019 fixing the double-invocation (which caused the confused agent output), this may self-resolve.

---

### DL-021: Remove Nudge Case 3 + Idempotency Guard (Anti-Duplicate Sessions)

**Date**: 2026-05-21
**Decision**: Remove the `in_progress → ready` nudge case and add atomic conditional writes to prevent duplicate agent invocations
**Status**: ACTIVE (implemented, pending deploy)

**Context**: Workflow `wf_1779389900490_mujlb7` spawned 3 parallel QA verifier sessions for the same ticket. OTEL traces confirmed 3 distinct `invoke_agent` spans with different session IDs, all running simultaneously. This wasted compute and produced conflicting outputs.

**Root cause — Nudge Case 3 + phase transition race**:

DL-014 added Case 3 (`in_progress → ready`) to handle crashed agents. DL-015 explicitly relied on it for crash recovery. But it had no staleness check — it reset tickets IMMEDIATELY, even if an agent session was actively running.

The race condition:
1. Dev agents complete → orchestrator creates QA ticket (status: `todo`, blockedBy: `[]`)
2. DDB Stream fires → `handleTicketReady` → sets `in_progress` → invokes QA Session 1
3. Phase transitions from `development` → `verification` → `nudgeKey` changes in WorkflowBoard
4. Auto-nudge (15s interval) now eligible to fire again (new nudgeKey)
5. Nudge Case 3 sees QA ticket `in_progress` → resets to `ready`
6. DDB Stream fires on status change → `handleTicketReady` → invokes QA Session 2
7. Repeat → Session 3

Each reset-to-ready creates a new Stream event, which the orchestrator interprets as "new ticket ready, invoke agent." The orchestrator had no guard against invoking an already-running ticket.

**Fix — Two layers**:

**Layer 1: Remove the dangerous nudge case**

Nudge endpoint now only handles two cases:
- Case 1: `todo` with no blockers → `ready` (missed stream event recovery)
- Case 2: `blocked` with all blockers done → `ready` (missed unblock recovery)

`in_progress` tickets are **never touched**. An actively running agent is not "stuck" — it's working. If an agent truly crashes (never calls `report_completion`), that's a different problem with a different solution (agent-level timeout + alerting, not nudge-level reset).

**Layer 2: Atomic conditional write (idempotency guard)**

Both `handleTicketReady` (DDB stream path) and `handleTicketReadyUnified` (Jira webhook path) now use a DynamoDB conditional write to claim the ticket:

```javascript
await ddb.send(new UpdateCommand({
  TableName: TICKETS_TABLE,
  Key: { ticketId },
  UpdateExpression: "SET #s = :s, #u = :u",
  ConditionExpression: "#s <> :inprog",  // Only succeeds if NOT already in_progress
  ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
  ExpressionAttributeValues: { ":s": "in_progress", ":inprog": "in_progress", ":u": now },
}));
```

If the condition fails (`ConditionalCheckFailedException`), the invocation returns early. Only the first Lambda execution wins — all subsequent attempts (from stream re-delivery, nudges, or any other source) are rejected.

**Why conditional write instead of just checking status?**:

A simple `if (ticket.status === "in_progress") return` has a TOCTOU race: two Lambda invocations read `todo` simultaneously, both pass the check, both invoke. The conditional write is atomic at the DynamoDB level — exactly one succeeds.

**Crash recovery without Case 3**:

| Scenario | Recovery |
|----------|----------|
| Agent finishes normally | Calls `report_completion` → ticket → done → cascade |
| Agent crashes mid-work | Runtime session timeout (540s) → session ends → ticket stays `in_progress` |
| Ticket stuck `in_progress` forever | Manual nudge button (user action) + future: alert on tickets `in_progress` > 15min |

The manual nudge button still exists for human-initiated recovery. The key difference: humans can judge "this has been stuck for 20 minutes" — the auto-nudge (15s interval) cannot.

**Future enhancement (not implemented)**: Add a timestamp-guarded auto-recovery for truly crashed agents (e.g., `in_progress` for > 10 minutes with no events in agentcore-hub-events table for that ticket). This is a better signal than "15 seconds with no UI activity."

**Relationship to other DLs**:
- DL-014 added Case 3 — **superseded by this DL**
- DL-015 relied on Case 3 for crash recovery — **partially invalidated** (crash recovery is now manual or needs future enhancement)
- DL-020 proposed the conditional write — **implemented here**
- DL-019 fixed the dual-event-source double-invocation — this DL fixes the nudge-induced double-invocation (different root cause, same symptom)

**Files modified**:
- `src/app/api/workflow/[id]/nudge/route.ts` — Removed Case 3, added explanatory comment
- `lambda/orchestrator/index.mjs` — Added conditional write in both `handleTicketReady` and `handleTicketReadyUnified`

---

### DL-022: S3 Artifacts Modal + Dynamic Header + Pipeline UI Polish

**Date**: 2026-05-21
**Decision**: Add interactive S3 artifact browsing, dynamic header title, and pipeline visual cleanup
**Status**: ACTIVE (merged to main, commit `b4f0f6b`)

**Context**: The pipeline phases all write artifacts to S3 (`workflows/{workflowId}/agents/{agentId}/`) but there was no way to browse or download them from the UI. Additionally, the pipeline header ("AgentCore Hub") was static and didn't reflect which workflow was being viewed.

**Changes implemented**:

1. **S3 Artifacts Modal** (`S3ArtifactsModal.tsx`)
   - Portal-rendered modal with focus trap, escape-to-close, fade animation
   - Lists all S3 objects under the workflow prefix, grouped by agent namespace
   - Per-file download + "Download All as ZIP" (server-side ZIP generation via jszip)
   - Security: `key.startsWith("workflows/")` guard prevents arbitrary bucket traversal
   - AbortController on fetch prevents race conditions on rapid open/close

2. **Clickable S3 output pills** (WorkflowBoard.tsx inline rendering)
   - Items with `icon: "s3"` in pipeline config get `.clickable` class
   - Hover effect: blue border glow + translateY(-1px)
   - Click opens the S3ArtifactsModal for the entire workflow

3. **S3 outputs added to ALL agent phases** (pipeline-config.ts)
   - Development: `{ icon: "s3", label: "Implementation artifacts to S3" }`
   - QA: `{ icon: "s3", label: "QA reports to S3" }`
   - (Requirements and Design already had S3 outputs)

4. **Dynamic header title** (Header.tsx + workflow/page.tsx)
   - Workflow page dispatches `CustomEvent("header-title", { detail: "Workflow: {title}" })`
   - Header listens and shows dynamic title (resets on route change)
   - No title/subtitle on the pipeline itself (CSS: `.pipeline-title{display:none}`)

5. **Legend repositioned**
   - Horizontal flex row above the phase canvas, left-aligned with Intake column
   - Not fixed/absolute — scrolls with the page content
   - Shows: Active, Working, Done, S3 Write, Gateway/MCP, Skill Load indicators

**Files created**:
- `src/components/workflow/S3ArtifactsModal.tsx`
- `src/app/api/workflow/artifacts/route.ts`
- `src/app/api/workflow/artifacts/download/route.ts`

**Files modified**:
- `src/components/workflow/WorkflowBoard.tsx` — S3 modal state, clickable pills, legend, title removal
- `src/components/layout/Header.tsx` — CustomEvent listener for dynamic title
- `src/app/workflow/page.tsx` — Emits header-title event on workflow selection
- `src/lib/pipeline-config.ts` — Added S3 outputs to development and qa phases

**Trade-off**: Modal shows ALL workflow artifacts (not scoped per-phase) because the S3 prefix structure doesn't cleanly map 1:1 to pipeline phases. Accepted because users typically want to see everything an agent produced in one place.

---

### DL-023: Config-Driven Agent Roster (S3-Loaded, Single Source of Truth)

**Date**: 2026-05-25
**Decision**: All Lambdas load the agent roster from `s3://{ARTIFACT_BUCKET}/config/agents.json` at cold start instead of maintaining hardcoded copies
**Status**: ACTIVE (deployed 2026-05-25)

**Context**: The agent roster was hardcoded in 3 separate Lambda files:
- `lambda/orchestrator/index.mjs` → `AGENT_ROSTER` array (id, phase, harnessName)
- `lambda/agentcore-hub-tickets/index.mjs` → `VALID_AGENTS` Set (id only)
- `lambda/agentcore-hub-jira/index.mjs` → `VALID_ASSIGNEES` Set (id only)

These drifted independently and didn't match the canonical source (`src/config/agents.json`). When a new agent was added to the frontend config, the Lambdas silently rejected it. Root cause of TEAM-73 stuck workflow: requirements agent assigned to `team-ios-dev` which existed in no roster.

**Problem**:
1. **Triple maintenance** — add an agent = edit 4 files (config + 3 Lambdas)
2. **Silent drift** — no mechanism to detect roster mismatch between Lambdas
3. **Multi-fleet blocker** — hardcoded rosters prevent running multiple fleets with different agent compositions

**Solution — S3 config loading on cold start**:

```
Deploy pipeline syncs agents.json to S3
    ↓
Lambda cold starts → loadRoster() reads s3://{BUCKET}/config/agents.json
    ↓
Roster cached in module scope (warm invocations skip S3 read)
    ↓
If S3 read fails → falls back to hardcoded FALLBACK_ROSTER (no outage)
```

**Implementation per Lambda**:

| Lambda | Loader function | Cache variable | What it extracts |
|--------|----------------|---------------|-----------------|
| `agentcore-hub-orchestrator` | `loadAgentRoster()` | `_agentRoster` | `{agentId, phase, runtimeArn}` per agent |
| `agentcore-hub-tickets` | `loadValidAgents()` | `VALID_AGENTS` | `Set` of agent IDs |
| `agentcore-hub-jira` | `loadValidAssignees()` | `VALID_ASSIGNEES` | `Set` of agent IDs |

**S3 path**: `config/agents.json` (synced by `deploy-all.sh` alongside prompts)

**Bucket**: `agentcore-artifacts-<ACCOUNT_ID>-us-east-1` (same bucket used for prompts, eval packages, agent output)

**IAM**: All three Lambdas need `s3:GetObject` on `arn:aws:s3:::{BUCKET}/config/*`. The orchestrator's role already had this. The ticket Lambdas' shared role (`agentcore-hub-jira-JiraFunctionRole-*`) got an inline policy `s3-config-read` added.

**Env var**: `ARTIFACT_BUCKET` added to `agentcore-hub-tickets` and `agentcore-hub-jira` Lambda configurations.

**Multi-fleet path**: When running multiple fleets, use different S3 keys per fleet (e.g., `config/fleet-a/agents.json`) and pass `FLEET_ID` env var to select the right config path.

**Updating the roster**:
```bash
# Edit src/config/agents.json (add/remove agents)
# Then sync to S3:
aws s3 cp src/config/agents.json s3://agentcore-artifacts-<ACCOUNT_ID>-us-east-1/config/agents.json

# Lambdas pick up changes on next cold start (no redeployment needed)
# To force immediate pickup: update any env var on the Lambda to trigger a new cold start
```

**Verified**:
- Orchestrator logs: `[orchestrator] Loaded 14 agents from S3 config`
- agentcore-hub-tickets logs: `[agentcore-hub-tickets] Loaded 14 agents from S3 config`
- Invalid assignee correctly rejected from S3-loaded roster
- Fallback works when S3 is unreachable (tested before IAM fix)

**Files modified**:
- `lambda/orchestrator/index.mjs` — `AGENT_ROSTER` → `FALLBACK_ROSTER` + `loadAgentRoster()`
- `lambda/agentcore-hub-tickets/index.mjs` — Added S3Client, `loadValidAgents()`, `ARTIFACT_BUCKET` env var
- `lambda/agentcore-hub-jira/index.mjs` — Added S3Client, `loadValidAssignees()`, `ARTIFACT_BUCKET` env var
- `deploy/continuous-improvement/deploy-all.sh` — Step 7 now syncs `agents.json` to S3
- `deploy/setup-tickets-lambda.mjs` — Adds `ARTIFACT_BUCKET` env var on Lambda creation

**Single source of truth chain**:
```
src/config/agents.json (repo)
    ↓ deploy-all.sh / manual s3 cp
s3://{BUCKET}/config/agents.json
    ↓ cold start read
orchestrator._agentRoster / tickets.VALID_AGENTS / jira.VALID_ASSIGNEES
```

Frontend (`src/lib/pipeline-config.ts`) imports `agents.json` directly at build time. Lambdas read from S3 at runtime. Same source file, two consumption paths.

---

## Session Change Log (2026-05-21)

### Changes Made This Session

| # | What | Why | File(s) |
|---|------|-----|---------|
| 1 | Deployed dual-write `agentcore-hub-tickets` Lambda | Agents always write to BOTH Jira + DDB with same ticket ID (DL-018) | `lambda/agentcore-hub-jira/index.mjs` |
| 2 | Added symmetric webhook guard to orchestrator | Prevents double agent invocation when dual-write fires both event sources (DL-019) | `lambda/orchestrator/index.mjs` |
| 3 | Documented DL-018 (dual-write architecture) | Cement the decision — never revisit | This file |
| 4 | Documented DL-019 (symmetric guards) | Explain the double-invocation root cause and fix | This file |
| 5 | Documented DL-020 (remaining TODOs) | Idempotency guard + blocked_by validation for future | This file |

### Deployments

| Lambda | Version | What Changed |
|--------|---------|-------------|
| `agentcore-hub-tickets` | 2026-05-21T02:02:35Z | Dual-write: Jira-first → DDB with same key |
| `agentcore-hub-orchestrator` | 2026-05-21T05:54:49Z | Webhook guard: reject when TICKET_PROVIDER≠jira |

### Current State (as of 2026-05-23)

| Setting | Value | Notes |
|---------|-------|-------|
| `TICKET_PROVIDER` on App Runner | `jira` | Production path — Jira is ticket authority |
| `TICKET_PROVIDER` on App Runner | Must match orchestrator Lambda | Ensures consistent ticket backend |
| `TICKET_PROVIDER` on orchestrator Lambda | `jira` | Reads/writes via Jira API |
| DDB Stream mapping | Enabled | Fires orchestrator on ticket status changes |
| App Runner URL | *(set DEPLOYMENT_URL in deploy/config.sh)* | Your deployed instance |
| `agentcore-hub-tickets` | Writes to Jira (primary). DDB writes are best-effort — no tickets table is provisioned, so they silently fail. This is expected. |

**DynamoDB tables required:** `agentcore-hub-workflows`, `agentcore-hub-events` only. No tickets table needed — Jira is the sole ticket store.

---

### DL-019: Remove Legacy Ticket-from-Text Path (CRITICAL FIX)

**Date**: 2026-05-22
**Decision**: Remove the fallback code path that parsed agent text output to create tickets
**Status**: ACTIVE

**Context**: `handleRequirementsCompletion()` in `engine.ts` had two paths:
1. `TICKET_PROVIDER === "dynamodb"` → trusted that agent already created tickets via tools
2. `else` → parsed agent's text output, extracted a "ticket plan", created tickets with title-based blocker resolution

**The Bug**: App Runner deployed with `TICKET_PROVIDER=jira`. The code checked `=== "dynamodb"` which didn't match `"jira"`, so it fell into the legacy `else` path. This caused:
1. **Duplicate ticket creation** — agent created tickets via Jira tools (correct), then the engine ALSO created tickets from parsed text (broken)
2. **Broken dependency chain** — text-parsed tickets used title strings for `blockedBy` references. If titles didn't match exactly, `titleToId.get(title)` returned undefined → tickets had no blockers → everything ran in parallel
3. **Premature phase advancement** — with no blockers, QA/CI tickets were "ready" immediately → engine advanced phases without waiting for dev
4. **Stuck workflows** — agents invoked before prerequisites completed, failed silently, never reported completion

**Fix**:
- Added `"jira"` to the condition: `if (providerType === "dynamodb" || providerType === "jira")`
- Then removed the `else` path entirely — dead code that should never execute
- Removed all supporting dead code: `parseRequirementsOutput()`, `createTicketsFromPlan()`, `readTicketPlanFromS3()`, `resolveAssignee()`, `buildKeywordMap()`, `TicketPlan` interface

**Principle**: There is ONE path for ticket creation — the agent calls `Tickets___create_ticket` sequentially, gets real IDs back, and passes them as `blocked_by` in subsequent calls. The engine never creates tickets.

**Files modified**:
- `src/lib/workflow/engine.ts` — removed ~250 lines of dead code

---

### DL-020: Model Override Support for Runtime Agents

**Date**: 2026-05-22
**Decision**: Runtime agents accept `model_override` in the invocation payload to switch models at runtime
**Status**: ACTIVE

**Context**: All agents deploy with `MODEL_ID=us.anthropic.claude-opus-4-6-v1` baked in. For testing/cost optimization, we need to run workflows with Sonnet without redeploying the fleet.

**Implementation**:
- `main.py` has a `MODEL_ALIASES` dict that resolves short names to full Bedrock model IDs:
  ```python
  MODEL_ALIASES = {
      "opus": "us.anthropic.claude-opus-4-6-v1",
      "sonnet": "us.anthropic.claude-sonnet-4-6",
      "haiku": "us.anthropic.claude-haiku-4-5-20251001",
  }
  ```
- If `model_override` in payload differs from the deployed `MODEL_ID`, a new `BedrockModel` instance is created with the resolved ID
- Orchestrator (`index.mjs`) also has an alias map to resolve before passing to agents

**Critical model IDs**:
- Opus: `us.anthropic.claude-opus-4-6-v1` (has `-v1` suffix)
- Sonnet: `us.anthropic.claude-sonnet-4-6` (NO `-v1` suffix)
- Passing an invalid ID causes `ValidationException: The provided model identifier is invalid`

**Usage**: Pass `"modelOverride": "sonnet"` in the workflow start payload.

---

### DL-021: Buffered Event Streaming (Token Loss Fix)

**Date**: 2026-05-22
**Decision**: Buffer text tokens before writing to DynamoDB to prevent event loop blocking
**Status**: ACTIVE

**Context**: The `ToolTrackingHandler` callback in `main.py` was doing a synchronous `put_item` to DynamoDB for every single text token. With rapid model output (~100+ tokens/sec), the blocking I/O caused 95%+ token loss — only ~18 fragments captured out of hundreds.

**Fix**: Buffer text in the callback, flush when buffer exceeds 50 chars or on tool/completion boundaries. Reduces DDB writes from hundreds to ~20-30 chunked writes with coherent text.

**Guard**: Event writes are gated on `workflow_id` presence — ad-hoc chat invocations (no workflow context) don't pollute the events table.

---

## Critical Setup Notes (for new deployments)

### Environment Variables That MUST Match

| Env Var | App Runner | Orchestrator Lambda | What breaks if wrong |
|---------|-----------|-------------------|---------------------|
| `TICKET_PROVIDER` | `jira` | `jira` | Engine falls into legacy text-parsing path, creates duplicate broken tickets |
| `TICKET_PROVIDER` | Must match on App Runner AND orchestrator Lambda | Mismatch causes missed events | App reads tickets from one source while orchestrator writes to another |
| `TICKETS_TABLE` | Not set (or any value) | N/A | Not needed in Jira mode. The `agentcore-hub-tickets` Lambda may attempt DDB writes which silently fail — this is expected. |
| `MODEL_ID` (on agents) | N/A | N/A | Must be valid Bedrock model ID. Opus has `-v1`, Sonnet does NOT |

### The Flow (authoritative)

```
1. User submits workflow via UI → POST /api/workflow/start
2. App Runner creates epic in Jira (via agentcore-hub-tickets Lambda)
3. App Runner creates requirements ticket (status=todo, no blockers)
4. Jira webhook fires → Orchestrator Lambda receives it
5. Orchestrator invokes reqs agent (Runtime) with task context
6. Reqs agent analyzes scope, calls Tickets___create_ticket for each needed ticket
   - Gets real TEAM-XXX IDs back from each call
   - Passes those IDs in blocked_by for downstream tickets
7. Reqs agent marks its own ticket "done"
8. Jira webhook fires for each new ticket + done transition
9. Orchestrator processes webhooks:
   - "done" → removes from siblings' blockedBy
   - ticket with empty blockedBy → invokes assigned agent
10. Dev agents run → mark done → QA unblocked → QA runs → CI unblocked → CI runs → complete
```

### What the App Runner does NOT do

- Does NOT orchestrate (Lambda does that)
- Does NOT create tickets (agents do that)
- Does NOT parse agent output for ticket plans (removed in DL-019)
- ONLY serves the UI + syncs workflow state for display
