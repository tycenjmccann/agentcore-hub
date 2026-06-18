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
