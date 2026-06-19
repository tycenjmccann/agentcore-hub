# port-session-mcp

Local **stdio MCP server** that ports your in-flight laptop coding session to
**Cloud Code**, so you can close the laptop and resume the same session from your
phone.

```
you (local Claude Code): "port this to the cloud, I'm catching the train"
        │
        ▼  port_session_to_cloud
  1. commit + push in-flight work to a branch   (Cloud Code only sees the remote)
  2. POST → /api/cloud-code/sessions/port        (creates a cloud session)
  3. upload this session's raw transcript (.jsonl) to a presigned S3 URL
  4. return a deep link
        │
        ▼
  open link on phone → cloud agent clones, checks out the branch,
  drops the transcript into the workspace, and runs `claude --resume`.
  Native, lossless continuation — you don't miss a beat.
```

## How the handoff works

- **Push first.** The cloud runtime can only access what's on the remote, so the
  tool commits everything (`git add -A` + commit, `--no-verify`) and pushes the
  branch before porting. Clean tree → just pushes the current branch.
- **Native resume, not a summary.** The tool ships the *raw* Claude transcript
  (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`) straight to S3 via a
  presigned PUT. The runtime downloads it, places it under the cloud workspace's
  project slug, and runs `claude --resume <sessionId>`. This is the CLI's own
  resume path — the full conversation continues losslessly, no re-reading a
  trimmed summary, no size cap.
- **First prompt.** The session's first auto-fired turn is a short nudge
  (`firstPrompt`, or a default "confirm where things stand and continue"). The
  context comes from the resumed transcript, not this prompt.
- **Why the filename is the id.** Claude names each transcript `<sessionId>.jsonl`
  and that equals the `sessionId` inside the records, so the filename alone is
  the resume handle — we ship the file verbatim.

## Build

```bash
cd mcp/port-session
npm install
npm run build
```

## Register with your local Claude Code

Add to your Claude Code MCP config (e.g. `~/.claude/mcp.json` or project
`.mcp.json`):

```json
{
  "mcpServers": {
    "port-session": {
      "command": "node",
      "args": ["/Users/tycenj/Desktop/agentcore-hub-fresh/mcp/port-session/dist/index.js"],
      "env": {
        "CLOUD_CODE_URL": "https://vksk2fjig2.us-east-1.awsapprunner.com"
      }
    }
  }
}
```

`CLOUD_CODE_URL` = the deployed app base URL. The tool reads the transcript for
whatever project directory it's launched in (its `cwd`), so run Claude Code from
inside the repo you're porting.

## Tool: `port_session_to_cloud`

| Arg | Default | Notes |
|---|---|---|
| `title` | `Ported: <repo>` | Session name shown in the sidebar. |
| `branch` | current branch | Branch to push the in-flight work to (and check out in the cloud). |
| `firstPrompt` | a default nudge | First instruction to the resumed agent. |
| `cli` | `claude` | Cloud CLI to resume with (`claude` or `codex`). |
| `commitMessage` | auto | Message for the in-flight snapshot commit. |
| `cwd` | server cwd | Project dir (transcript + git are read here). |

Slash command (`/mcp__port-session__port`) takes one comma-separated arg:
`title, first prompt (optional), new branch (optional)`.

Returns a deep link: `<CLOUD_CODE_URL>/cloud-code?session=<id>`.

## Limits / future

- **Claude only.** `--resume` is a Claude Code mechanism. Codex resume uses a
  different `thread_id` and isn't wired through the transcript path yet.
- **Single-user.** Uses the app's `userId: "default"`. Multi-user waits on the
  app-wide SSO work; this server would then send an auth token.
- **No auth on the port endpoint / presigned URL yet** — same posture as the
  rest of Cloud Code today. Tighten before exposing publicly.
