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

**Scope decision: Cloud Code tab only, not a full-app mobile rework.**
Rationale: the user uses this tab on mobile now; a full-app responsive pass is a
much larger, riskier change across every page. Make Cloud Code genuinely usable
on a phone; leave other tabs as-is. **[CONFIRM]** whether to extend to the whole
app later.

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
