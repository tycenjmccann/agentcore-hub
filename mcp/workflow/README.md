# @agentcore-hub/workflow-mcp

A local stdio MCP server that exposes AgentCore Hub workflow operations as MCP tools. Any MCP-compatible client (Claude Code, Claude Desktop, Cursor) can use it to submit, monitor, and manage workflows without direct HTTP calls.

## Build

```bash
cd mcp/workflow
npm install
npm run build
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOYMENT_URL` | **Yes** | Base URL of the AgentCore Hub API (e.g., `https://hub.example.com`). Trailing slash is stripped. |
| `AUTH_TOKEN` | No | Bearer token, sent as `Authorization: Bearer <token>`. Use when the Hub reads a bearer token directly. |
| `CF_ACCESS_CLIENT_ID` | No | Cloudflare Access service-token client ID. **Required when the Hub runs with `AUTH_MODE=cloudflare-access`** — the middleware only accepts a verified `Cf-Access-Jwt-Assertion`, not `Authorization`. Sent as the `CF-Access-Client-Id` header. |
| `CF_ACCESS_CLIENT_SECRET` | No | Cloudflare Access service-token client secret. Pairs with `CF_ACCESS_CLIENT_ID`; sent as the `CF-Access-Client-Secret` header. |

## MCP Client Configuration

Add this block to your MCP client config (e.g., Claude Desktop `claude_desktop_config.json` or Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "workflow-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/workflow/dist/index.js"],
      "env": {
        "DEPLOYMENT_URL": "https://your-agentcore-hub.example.com",
        "AUTH_TOKEN": "your-optional-auth-token"
      }
    }
  }
}
```

## Available Tools

### `submit_workflow`
Submit a new workflow for processing.

**Required inputs:** `title` (string), `description` (string), `repoConfig` (object with `layout` and `repos` array)

**Optional inputs:** `sources`, `modelOverride`, `workflowType`, `workflowDefId`, `reviewGates`

**Endpoint:** `POST /api/workflow/start`

---

### `list_workflows`
List all workflows.

**Optional inputs:** `includeArchived` (boolean, default: false)

**Endpoint:** `GET /api/workflow/list`

---

### `list_workflow_definitions`
List available workflow definitions (templates).

**No inputs required.**

**Endpoint:** `GET /api/workflow/definitions`

---

### `get_workflow_status`
Get the current status and state of a workflow.

**Required inputs:** `workflowId` (string)

**Endpoint:** `GET /api/workflow/{workflowId}/state`

---

### `get_workflow_artifacts`
Retrieve artifacts produced by a workflow, optionally filtered by agent.

**Required inputs:** `workflowId` (string)

**Optional inputs:** `agentId` (string)

**Endpoint:** `GET /api/workflow/artifacts?workflowId=X&agentId=Y`

---

### `cancel_workflow`
Cancel a running workflow.

**Required inputs:** `workflowId` (string)

**Optional inputs:** `reason` (string)

**Endpoint:** `POST /api/workflow/{workflowId}/cancel`

---

### `nudge_workflow`
Send a nudge to a running workflow with optional guidance message.

**Required inputs:** `workflowId` (string)

**Optional inputs:** `message` (string)

**Endpoint:** `POST /api/workflow/{workflowId}/nudge`

---

### `create_routine`
Create a routine — a workflow that runs on a schedule (EventBridge Scheduler expression). The `workflowDefId` must already exist (see `list_workflow_definitions`). Minimum cadence is one fire per hour. `input.titleTemplate` may contain `{date}`, replaced with the fire date.

**Required inputs:** `name` (string, ≤120 chars), `workflowDefId` (string), `schedule` (object with `expression`, optional `timezone`), `input` (object with `titleTemplate`, `description`, `workflowDefId`; optional `repoConfig`, `sources`, `connectors`)

**Optional inputs:** `description` (string), `enabled` (boolean, default: true)

**Endpoint:** `POST /api/routines`

---

### `list_routines`
List all routines with schedule, enabled state, and last run.

**No inputs required.**

**Endpoint:** `GET /api/routines`

---

### `get_routine`
Get one routine including its full input template and last run.

**Required inputs:** `routineId` (string)

**Endpoint:** `GET /api/routines/{routineId}`

---

### `update_routine`
Enable/pause a routine, rename it, or change its schedule or input template. Only provided fields change.

**Required inputs:** `routineId` (string)

**Optional inputs:** `name`, `description`, `enabled`, `schedule`, `input` (partial, merged over existing)

**Endpoint:** `PATCH /api/routines/{routineId}`

---

### `delete_routine`
Delete a routine and its schedule. Stops firing immediately; cannot be undone.

**Required inputs:** `routineId` (string)

**Endpoint:** `DELETE /api/routines/{routineId}`

---

### `run_routine`
Fire a routine immediately without waiting for its schedule.

**Required inputs:** `routineId` (string)

**Endpoint:** `POST /api/routines/{routineId}/run`

---

## Error Handling

- All tool inputs are validated with Zod before HTTP calls
- Non-2xx HTTP responses are returned as tool errors: `{ isError: true, content: [{ type: "text", text: "HTTP {status}: {body}" }] }`
- Network errors and timeouts are clearly reported
- Response bodies in errors are truncated to 1000 characters
