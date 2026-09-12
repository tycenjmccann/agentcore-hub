# Cloud Code — decisions & assumptions (autonomous session)

Recorded while working unattended. Sync points flagged with **[CONFIRM]**.

## Task 1 — MCP / Gateway wiring

**Goal:** make the coding runtime's CLIs (Claude, Codex) able to use MCP tools,
starting with the existing `agentis-gateway`.

Decisions:
- **Reuse the existing `agentis-gateway`** (READY, 3 targets: SkillLoader,
  JiraIntegration, S3Storage) rather than build a new one. URL:
  `https://agentis-gateway-xokvqlv5h6.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp`
- Wire it as a **default MCP server** the runtime lays down on session start, so
  every session gets the gateway tools without the user configuring anything.
  A user-uploaded config bundle still merges on top (adds their own MCP servers).
- **Auth:** the gateway is currently `authorizerType: NONE` (open). We connect
  with no auth header for now. **[CONFIRM]** tighten to IAM/JWT before this is
  multi-user/public — flagged, not done (would also require the CLIs to sign).
- Claude Code: remote MCP via `.mcp.json` `{type:"http"|"sse", url}` in
  CLAUDE_CONFIG_DIR. Codex: `[mcp_servers.*]` in config.toml. If a CLI version
  can't do remote/streamable-HTTP MCP, I note it here rather than fake it.
- The default MCP config is **opt-out-able**: env `DISABLE_DEFAULT_MCP=1` skips it.

## Task 2 — Mobile-friendly

**Scope decision (REVISED): fixed the global app shell, not just Cloud Code.**
On inspection the real blocker was the global shell — a `fixed w-64` sidebar +
`ml-64` content margin that eats a phone screen on EVERY tab. That's contained
chrome (3 files: Sidebar, MainContent, Header + SidebarContext), not a per-page
rewrite, so fixing it unblocks the whole app at low risk. Per-page content
(tables, cards) on other tabs is NOT audited — only the shell. **[CONFIRM]** if
you want a per-page mobile polish pass on the other tabs.

What changed:
- Global Sidebar → off-canvas drawer on mobile (hamburger in Header opens it,
  backdrop closes it; auto-closes on nav). Desktop unchanged (rail + collapse).
- MainContent: no left margin on mobile (`ml-0 md:ml-16/64`).
- Cloud Code page: its own session list is also a mobile drawer (in-page
  "Sessions" button + backdrop); chat/terminal go full-width; padding tightened.
- Verified live at 390px with the AgentCore cloud browser: shell + drawer +
  Cloud Code render correctly, nothing clipped.

Decisions:
- The hub's left nav (Sidebar) + the Cloud Code session sidebar both eat the
  screen on mobile. For the Cloud Code tab: collapse the session list into a
  **slide-in drawer** behind a hamburger; chat/terminal go full-width.
- A top bar on mobile shows: ☰ (sessions), current session title, New.
- Terminal stays usable (xterm fits container); on a phone it's cramped but
  functional — chat is the primary mobile surface.
- Use Tailwind responsive prefixes (`md:`) so desktop layout is unchanged.
- **[CONFIRM]** the global app shell/Sidebar on mobile is out of scope here; if
  the hub nav itself blocks the view, that's the full-app pass.

## Streaming chat (SSE) + shared reader

- Claude chat now streams token-by-token; Codex stays buffered (no stream-json
  resume story yet). `--include-partial-messages` is required for token deltas.
- Best-practice call: extracted the SSE byte/frame plumbing into ONE tested
  helper `src/lib/sse.ts` (`sseData`), and routed ALL consumers through it —
  Cloud Code chat, the message-route relay, and the existing agent-detail/builder
  streamers (`agentcore-stream.ts`). Event *schemas* stay per-feature (different
  upstreams); only the fragile transport is shared. 7 edge-case unit tests pass.
- Docs: docs/streaming-sse.md (new), coding-runtime README updated.

## Port-to-cloud: native `claude --resume` (not a text seed)

**Goal:** "I'm catching the train" — hand a live laptop coding session to Cloud
Code and pick it up on the phone with zero context lost.

Decision (after a wrong first cut): ship the **raw transcript** and use Claude
Code's own resume, not an extracted text summary.

- The local `port-session` MCP commits + pushes the in-flight work to a branch,
  then uploads the real `~/.claude/projects/<slug>/<sessionId>.jsonl` to
  `s3://<artifact-bucket>/cloud-code/resume/<sessionId>/<claudeSessionId>.jsonl`
  via a presigned PUT (no big body through the app; no DynamoDB size cap).
- On the first turn the runtime: checks out `branch`, downloads the transcript,
  drops it at `{CLAUDE_CONFIG_DIR}/projects/<workdir-slug>/<sessionId>.jsonl`,
  and runs `claude --resume <sessionId>`. Lossless continuation.
- **Verified empirically** (claude 2.1.170): a verbatim transcript renamed to a
  new id and placed under the matching cwd-slug resumes and recalls prior work.
  The slug = `re.sub(r'[^a-zA-Z0-9]','-', realpath(cwd))` — `--resume` 404s if it
  doesn't match exactly. (First attempt failed purely on slug mis-encoding.)
- The first auto-fired turn is just a short nudge (`firstPrompt` or a default);
  the context lives in the resumed transcript.
- **Claude only** — Codex resume is a different `thread_id` mechanism, deferred.
- **[CONFIRM]** terminal-tab auto-resume (`claude --resume` in the PTY) rides the
  same installed transcript; wired next.

## Turn state is VM-local; the caller waits via the command API

See DL-026 in `docs/architecture.md` for the full decision.
Short version, because it is the thing most likely to be "simplified" back:

- A turn's status is NOT on `/mnt/efs`. It is `TURNS_ROOT/<turn_id>/` on this
  microVM's disk. When the EFS access point lost write permission for 16 minutes
  on 2026-09-10, every turn on the VM 503'd purely because status lived there.
- There is no heartbeat. The previous design had the runner write `running` every
  15s and the fleet poll for staleness; a wedged CLI whose heartbeat thread was
  healthy advertised `running` for 2h40m. Liveness is now the CLI process, read by
  the caller from `/proc/<pid>/stat` through `InvokeAgentRuntimeCommand`.
- `kill -0` must never be used for that check. PID 1 here does not reap, so a
  SIGKILLed CLI lingers as a zombie and `kill -0` keeps answering "alive".
  `test_turn_probe_scripts.py` pins this against real processes.
- CLI stderr goes to a FILE, not a pipe. `proc.stderr.read()` after the CLI exits
  blocks forever if a grandchild that escaped the process-group kill still holds
  the write end.
- `meta.json` is written BEFORE workspace setup. A submit whose response is lost
  mid-clone must probe as `starting`; if it probed as "no such turn" the caller
  would resubmit and two clones would race in one checkout.
