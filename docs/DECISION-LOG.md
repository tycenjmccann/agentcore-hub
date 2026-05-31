# Decision Log

Architectural decisions and their rationale. Newest first.

---

## DL-009: Consolidate Ticket Lambdas into Single Router

**Date:** 2026-05-26
**Status:** PROPOSED
**Context:** We currently have two separate Lambdas implementing the same tool interface (`Tickets___create_ticket`, `Tickets___transition_ticket`, etc.):
- `agentcore-hub-jira` — routes to Jira Cloud API
- `agentcore-hub-tickets` — routes to DynamoDB

Every upstream service (runtime agents, workflow-output Lambda, orchestrator) must be configured with `TICKET_TOOLS_LAMBDA` env var pointing to the correct one. Missing this config on even one service causes silent failures (e.g., workflow-output Lambda was missing it, causing `report_completion` to fail to transition tickets).

**Decision:** Consolidate into a single Lambda (`agentcore-hub-tickets`) that reads `TICKET_PROVIDER` env var and routes internally to the correct adapter. Callers never need to know which provider is in use.

**Architecture:**
```
agentcore-hub-tickets (single entry point)
  ├── TICKET_PROVIDER=jira     → jira-adapter.mjs (Jira Cloud API)
  ├── TICKET_PROVIDER=dynamodb → ddb-adapter.mjs (DynamoDB)
  ├── TICKET_PROVIDER=asana    → asana-adapter.mjs (future)
  └── TICKET_PROVIDER=linear   → linear-adapter.mjs (future)
```

**Benefits:**
- Eliminates per-service `TICKET_TOOLS_LAMBDA` config (one fewer env var to miss)
- Adding new providers = adding an adapter file, not a new Lambda + reconfiguring all upstreams
- Agents don't change at all — same tool interface regardless of provider

**Risks:**
- Migration: need to update all deployed services to point to the consolidated Lambda
- Single point of failure (mitigated: Lambda is stateless, auto-scales)

---

## DL-008: Catch-Up Replay (Live)

**Date:** 2026-05-19
**Status:** IMPLEMENTED
**Context:** Users joining mid-workflow need to see what happened before they opened the page.
**Decision:** Implemented live catch-up replay via events table polling.

---

## DL-007: Timeline Replay (Completed Workflows)

**Date:** 2026-05-19
**Status:** IMPLEMENTED
**Context:** Need to review completed workflows step-by-step.
**Decision:** Timeline replay reads from events table with playback controls.

---
