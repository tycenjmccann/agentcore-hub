"""
AgentCore Hub Pipeline Agent — Strands on AgentCore Runtime

Universal agent code deployed as 13 separate Runtime resources.
Each deployment gets its own SYSTEM_PROMPT env var baked in at deploy time,
making each agent a fully self-contained specialist.

The orchestrator is thin/dumb — it only passes the task prompt (ticket context).
Agent identity (system prompt, tools, model) is fixed at deploy time.

Key advantages over Harness:
  - We control botocore read_timeout (1200s) so Opus can think without being killed
  - OTel auto-instrumentation is enabled via the CMD in deployment
  - Streaming responses via async generator entrypoint
  - All gateway tools (Tickets, GitHub MCP, WorkflowOutput) via Lambda invocation
"""

import os
import subprocess
import signal
import threading
os.environ["BYPASS_TOOL_CONSENT"] = "true"  # Required for non-interactive strands_tools (shell, editor, etc.)
os.environ["HOME"] = "/tmp"  # Runtime /var/task is read-only; tools need writable HOME
os.environ["SHELL_DEFAULT_TIMEOUT"] = "300"  # 5 min — safety net for hung commands
os.environ["GIT_TERMINAL_PROMPT"] = "0"  # Never prompt for credentials — fail immediately instead of hanging
os.environ["GIT_PAGER"] = "cat"  # Never use less/pager — prevents hang on git log/diff output
os.environ["PAGER"] = "cat"  # Same for any tool that uses $PAGER
os.chdir("/tmp")  # python_repl, editor, shell all use cwd() for state — must be writable

# --- Fix Playwright driver permissions ---
# direct_code_deploy strips execute bit from pip package binaries.
# Playwright's bundled Node driver at /var/task/playwright/driver/node needs +x.
_pw_node = "/var/task/playwright/driver/node"
if os.path.exists(_pw_node) and not os.access(_pw_node, os.X_OK):
    try:
        os.chmod(_pw_node, 0o755)
    except OSError:
        # If /var/task is truly read-only, copy to /tmp and redirect
        subprocess.run(["cp", _pw_node, "/tmp/playwright-node"], capture_output=True)
        os.chmod("/tmp/playwright-node", 0o755)
        os.environ["PLAYWRIGHT_NODEJS_PATH"] = "/tmp/playwright-node"

# --- Install Node.js at startup (once per session) ---
# direct_code_deploy runtimes don't have Node.js pre-installed.
# This installs a standalone Node.js binary to /tmp so shell, claude_code, and npm work.
_node_marker = "/tmp/.node_installed"
if not os.path.exists(_node_marker):
    try:
        subprocess.run(
            ["bash", "-c", """
            cd /tmp && \
            curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-arm64.tar.gz | tar -xz && \
            ln -sf /tmp/node-v20.18.0-linux-arm64/bin/node /tmp/node && \
            ln -sf /tmp/node-v20.18.0-linux-arm64/bin/npm /tmp/npm && \
            ln -sf /tmp/node-v20.18.0-linux-arm64/bin/npx /tmp/npx && \
            export PATH="/tmp/node-v20.18.0-linux-arm64/bin:$PATH" && \
            npm install -g @anthropic-ai/claude-code @openai/codex 2>/dev/null && \
            touch /tmp/.node_installed
            """],
            capture_output=True, text=True, timeout=180,
            env={**os.environ, "PATH": f"/tmp/node-v20.18.0-linux-arm64/bin:{os.environ.get('PATH', '')}"},
        )
        os.environ["PATH"] = f"/tmp/node-v20.18.0-linux-arm64/bin:/tmp/.npm-global/bin:{os.environ.get('PATH', '')}"
    except Exception as e:
        print(f"[WARN] Node.js install failed: {e} — shell/claude_code may not work")
else:
    os.environ["PATH"] = f"/tmp/node-v20.18.0-linux-arm64/bin:/tmp/.npm-global/bin:{os.environ.get('PATH', '')}"

import json
import logging
import boto3

from strands import Agent, tool
from strands.models import BedrockModel
from botocore.config import Config as BotocoreConfig
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# Built-in Strands tools — lazy import to stay under 30s init limit
def _load_builtin_tools():
    """Import strands_tools at invocation time, not module load time.

    All built-in tools are loaded for every agent. AgentCore Runtime provides /tmp
    as writable space, and Code Interpreter / Browser run in separate sandboxes.
    """
    from strands_tools import (
        # Multi-modal
        image_reader,
        # Web & Network
        http_request,
        # Utilities
        current_time,
        calculator,
        # File Operations
        file_read,
        file_write,
        editor,
        # Shell & System
        shell,
        environment,
        # Code Interpretation
        python_repl,
        # RAG & Memory
        retrieve,
    )
    # AgentCore built-in services (Code Interpreter + Browser)
    from strands_tools.code_interpreter import AgentCoreCodeInterpreter
    from strands_tools.browser import AgentCoreBrowser

    code_interpreter_tool = AgentCoreCodeInterpreter(region=REGION)
    browser_tool = AgentCoreBrowser(region=REGION)

    return [
        # Multi-modal
        image_reader,
        # Web & Network
        http_request,
        # Utilities
        current_time,
        calculator,
        # File Operations
        file_read,
        file_write,
        editor,
        # Shell & System
        shell,
        environment,
        # Code Interpretation
        python_repl,
        # RAG & Memory
        retrieve,
        # AgentCore Services — sandboxed code execution & browser automation
        code_interpreter_tool.code_interpreter,
        browser_tool.browser,
    ]

# --- Configuration ---
REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("MODEL_ID", "us.anthropic.claude-opus-4-6-v1")
READ_TIMEOUT = int(os.getenv("READ_TIMEOUT", "1200"))  # 20 minutes — agents need room for complex claude_code calls
GATEWAY_ARN = os.getenv("GATEWAY_ARN", "")
# NOTE: AgentCore reserves "ARTIFACT_BUCKET" as a system env var (points to CodeBuild source bucket).
# We use AGENTCORE_HUB_ARTIFACT_BUCKET to avoid the collision.
ARTIFACT_BUCKET = os.getenv("AGENTCORE_HUB_ARTIFACT_BUCKET", os.getenv("ARTIFACT_BUCKET", ""))

# System prompt: prefer S3 (for large prompts), fall back to env var
_prompt_s3_key = os.getenv("SYSTEM_PROMPT_S3_KEY", "")
if _prompt_s3_key:
    import boto3 as _b3
    try:
        _s3 = _b3.client("s3", region_name=REGION)
        _obj = _s3.get_object(Bucket=ARTIFACT_BUCKET, Key=_prompt_s3_key)
        SYSTEM_PROMPT = _obj["Body"].read().decode("utf-8")
    except Exception as _e:
        SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "You are a helpful AI agent on a development team.")
        print(f"[WARN] Failed to load prompt from S3 ({_prompt_s3_key}): {_e}, using env var fallback")
else:
    SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "You are a helpful AI agent on a development team.")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agentcore-hub-pipeline-agent")

# Per-invocation prompt cache for shared-runtime topologies (1 or 4 runtimes
# hosting many personas). First call for an agent_id reads
# s3://{ARTIFACT_BUCKET}/prompts/{agent_id}.txt; subsequent calls in the same
# microVM are dict lookups. A new runtimeSessionId starts a new microVM with
# an empty cache, so prompt edits in S3 propagate on the next session without
# redeploying the runtime. In 14-runtime mode, the deploy-time SYSTEM_PROMPT
# already matches the requested agent_id and the cache is bypassed.
_PROMPT_CACHE: dict[str, str] = {}


def _load_prompt_for_agent(agent_id: str) -> str:
    if not agent_id or agent_id == "unknown":
        return SYSTEM_PROMPT
    if _agent_name_from_prompt_key and agent_id == _agent_name_from_prompt_key:
        return SYSTEM_PROMPT
    cached = _PROMPT_CACHE.get(agent_id)
    if cached is not None:
        return cached
    if not ARTIFACT_BUCKET:
        return SYSTEM_PROMPT
    key = f"prompts/{agent_id}.txt"
    try:
        body = (
            boto3.client("s3", region_name=REGION)
            .get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"]
            .read()
            .decode("utf-8")
        )
        _PROMPT_CACHE[agent_id] = body
        logger.info(f"[{agent_id}] Loaded prompt from s3://{ARTIFACT_BUCKET}/{key}")
        return body
    except Exception as e:
        logger.warning(
            f"[{agent_id}] Prompt load failed (s3://{ARTIFACT_BUCKET}/{key}): {e} — falling back to deployed SYSTEM_PROMPT"
        )
        return SYSTEM_PROMPT

# Claude Code skills/plugins are baked into the image at build time
# (deploy/runtime-agent/install-skills.sh) — no runtime sync needed.
_agent_name_from_prompt_key = os.path.basename(_prompt_s3_key).replace(".txt", "") if _prompt_s3_key else ""

# --- Model with custom timeout (THE FIX) ---
boto_config = BotocoreConfig(
    read_timeout=READ_TIMEOUT,
    connect_timeout=30,
    retries={"max_attempts": 2},
)

model = BedrockModel(
    model_id=MODEL_ID,
    region_name=REGION,
    boto_client_config=boto_config,
    streaming=True,
)

# --- Lambda client for invoking tool backends ---
lambda_client = boto3.client("lambda", region_name=REGION)

# Tool Lambda function names (the gateway targets are backed by these)
TICKET_TOOLS_LAMBDA = os.getenv("TICKET_TOOLS_LAMBDA", "agentcore-hub-tickets")
BUILDER_TOOLS_LAMBDA = os.getenv("BUILDER_TOOLS_LAMBDA", "agentcore-hub-builder-tools")
WORKFLOW_OUTPUT_LAMBDA = os.getenv("WORKFLOW_OUTPUT_LAMBDA", "agentcore-hub-workflow-output")

# Set per-invocation by agent_invocation() — used by tools to pass context to Lambdas
_CURRENT_WORKFLOW_ID = "unknown"
_CURRENT_AGENT_ID = "unknown"

# ARTIFACT_BUCKET is set near the top of this file (line ~135) via AGENTCORE_HUB_ARTIFACT_BUCKET env var.

# MCP Servers — connect agents to external tools (GitHub, GitLab, Jira, Asana, etc.)
# Configured via MCP_SERVERS env var (JSON array) or legacy GITHUB_PAT shorthand.
#
# Format: [{"url": "https://...", "headers": {"Authorization": "Bearer xxx"}}]
#
# Examples:
#   GitHub:   {"url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ghp_xxx"}}
#   GitLab:   {"url": "https://gitlab.com/-/mcp", "headers": {"PRIVATE-TOKEN": "glpat-xxx"}}
#   Custom:   {"url": "https://my-tools.company.com/mcp"}
#
MCP_SERVERS_JSON = os.getenv("MCP_SERVERS", "")

# Legacy shorthand: GITHUB_PAT auto-creates a GitHub MCP entry
GITHUB_PAT = os.getenv("GITHUB_PAT", "")
GITHUB_MCP_URL = os.getenv("GITHUB_MCP_URL", "https://api.githubcopilot.com/mcp/")

# Configure git to use GITHUB_PAT for HTTPS auth — enables git push/clone via shell & claude_code
if GITHUB_PAT:
    subprocess.run(
        ["git", "config", "--global", "url.https://x-access-token:" + GITHUB_PAT + "@github.com/.insteadOf", "https://github.com/"],
        capture_output=True,
    )
    subprocess.run(["git", "config", "--global", "user.email", "agent@agentcore-hub.example.com"], capture_output=True)
    subprocess.run(["git", "config", "--global", "user.name", "AgentCore Hub Agent"], capture_output=True)

def _parse_mcp_servers():
    """Parse MCP server config from env. Returns list of {url, headers} dicts."""
    servers = []
    # Parse JSON config if provided
    if MCP_SERVERS_JSON:
        try:
            servers = json.loads(MCP_SERVERS_JSON)
        except json.JSONDecodeError:
            logger.warning("MCP_SERVERS env var is not valid JSON — ignoring")
    # Legacy: GITHUB_PAT shorthand adds GitHub MCP automatically
    if GITHUB_PAT and not any(s.get("url", "").startswith("https://api.githubcopilot.com") for s in servers):
        servers.append({
            "url": GITHUB_MCP_URL,
            "headers": {"Authorization": f"Bearer {GITHUB_PAT}"},
        })
    return servers


def _invoke_lambda(function_name: str, tool_name: str, arguments: dict) -> str:
    """Invoke a Lambda-backed tool and return its response text."""
    # Send both field-name conventions so all Lambdas work:
    # - Jira Lambda: reads event.tool_name + event.parameters
    # - S3/WorkflowOutput: reads event.name + event.arguments
    payload = {
        "name": tool_name, "tool_name": tool_name,
        "arguments": arguments, "parameters": arguments,
    }
    response = lambda_client.invoke(
        FunctionName=function_name,
        Payload=json.dumps(payload).encode(),
    )
    result = json.loads(response["Payload"].read())
    # Lambda tools return {content: [{type: "text", text: "..."}]}
    if isinstance(result, dict) and "content" in result:
        texts = [c.get("text", "") for c in result["content"] if c.get("type") == "text"]
        return "\n".join(texts)
    if isinstance(result, dict) and "errorMessage" in result:
        return f"Error: {result['errorMessage']}"
    return json.dumps(result)


# ─── S3 File Download (for image_reader integration) ─────────────────────────

s3_client = boto3.client("s3", region_name=REGION)

@tool
def download_s3_file(key: str, bucket: str = "") -> str:
    """Download a file from S3 to local /tmp directory so it can be read by image_reader or other tools.
    Use this for images (PNG, JPG, etc.) that need visual analysis.

    Args:
        key: Object key/path in the bucket
        bucket: S3 bucket name (defaults to the team artifact bucket)

    Returns:
        Local file path where the file was saved (e.g., /tmp/filename.png)
    """
    import os
    actual_bucket = bucket or ARTIFACT_BUCKET
    filename = os.path.basename(key)
    local_path = f"/tmp/{filename}"
    s3_client.download_file(actual_bucket, key, local_path)
    size = os.path.getsize(local_path)
    return f"Downloaded to {local_path} ({size} bytes). Use image_reader tool with this path to view the image."


# ─── S3 Storage Tools ─────────────────────────────────────────────────────────

@tool
def S3Storage___read_object(key: str, bucket: str = "") -> str:
    """Read a TEXT object from S3. Returns the object content as text. For images/binary files, use download_s3_file instead.

    Args:
        key: Object key/path in the bucket
        bucket: S3 bucket name (defaults to the team artifact bucket)
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___read_object", {"bucket": bucket or ARTIFACT_BUCKET, "key": key})


@tool
def S3Storage___write_object(key: str, content: str, bucket: str = "", content_type: str = "text/plain") -> str:
    """Write content to an S3 object.

    Args:
        key: Object key/path in the bucket
        content: Content to write
        bucket: S3 bucket name (defaults to the team artifact bucket)
        content_type: MIME type of the content
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___write_object", {
        "bucket": bucket or ARTIFACT_BUCKET, "key": key, "content": content, "content_type": content_type
    })


@tool
def S3Storage___list_objects(prefix: str = "", bucket: str = "") -> str:
    """List objects in an S3 bucket under a prefix.

    Args:
        prefix: Key prefix to filter by
        bucket: S3 bucket name (defaults to the team artifact bucket)
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___list_objects", {"bucket": bucket or ARTIFACT_BUCKET, "prefix": prefix})


# ─── Ticket Tools ────────────────────────────────────────────────────────────

@tool
def Tickets___create_ticket(title: str, description: str, parent_id: str = "", assignee: str = "", ticket_type: str = "task", blocked_by: str = "", workflow_id: str = "") -> str:
    """Create a new ticket in the project tracker.

    MANDATORY TICKETS (create these for EVERY workflow, no exceptions):
      - agentcore_hub_qa_verifier: "QA: Verify [feature]" — blocked_by=ALL dev ticket IDs
      - agentcore_hub_ci_agent: "CI: Validate build and tests for [feature]" — blocked_by=QA ticket ID

    Example complete ticket set for a frontend feature:
      1. create_ticket(assignee="agentcore_hub_frontend_designer", blocked_by="")
      2. create_ticket(assignee="agentcore_hub_frontend_dev", blocked_by="TEAM-101")
      3. create_ticket(assignee="agentcore_hub_qa_verifier", blocked_by="TEAM-102")  ← ALWAYS
      4. create_ticket(assignee="agentcore_hub_ci_agent", blocked_by="TEAM-103")     ← ALWAYS

    Args:
        title: Ticket title/summary
        description: Detailed description with requirements and acceptance criteria
        parent_id: Parent ticket key (e.g., "TEAM-1492"). Required for child tickets.
            For bug-fix flows this must be the parent Bug's key — Jira requires
            sub-tasks of a Bug to use issue_type=subtask, not task.
        assignee: Agent ID to assign to (e.g., agentcore_hub_frontend_dev, agentcore_hub_backend_dev, agentcore_hub_qa_verifier, agentcore_hub_ci_agent)
        ticket_type: One of "epic", "story", "task", or "subtask".
            Use "subtask" + a parent_id when the parent is a Bug (Jira rejects task→bug).
        blocked_by: Comma-separated list of ticket IDs this ticket is blocked by (e.g., "TEAM-401,TEAM-402")
        workflow_id: Workflow ID this ticket belongs to
    """
    blockers = [b.strip() for b in blocked_by.split(",") if b.strip()] if blocked_by else []
    # Auto-inject workflow_id from invocation context if agent didn't pass one —
    # without the wf:<id> label, the ticket is invisible to the workflow UI.
    effective_workflow_id = workflow_id or _CURRENT_WORKFLOW_ID
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___create_ticket", {
        "summary": title, "description": description, "parent_key": parent_id,
        "assignee": assignee, "issue_type": ticket_type, "blocked_by": blockers,
        "workflow_id": effective_workflow_id
    })


@tool
def Tickets___transition_ticket(ticket_id: str, transition_id: str, reason: str = "") -> str:
    """Transition a ticket to a new status (e.g., done, skip, blocked).

    Args:
        ticket_id: The ticket ID to transition
        transition_id: Target status (done, skip, blocked, in_progress, todo)
        reason: Reason for the transition
    """
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___transition_ticket", {
        "ticket_id": ticket_id, "transition_id": transition_id, "reason": reason
    })


@tool
def Tickets___update_ticket(ticket_id: str, description: str = "", title: str = "") -> str:
    """Update an existing ticket's title or description.

    Args:
        ticket_id: The ticket ID to update
        description: New description (optional)
        title: New title (optional)
    """
    args = {"ticket_id": ticket_id}
    if description:
        args["description"] = description
    if title:
        args["title"] = title
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___update_ticket", args)


@tool
def Tickets___list_tickets(parent_id: str) -> str:
    """List all child tickets under a parent (epic or story).

    Args:
        parent_id: Parent ticket ID to list children of
    """
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___list_tickets", {"parent_id": parent_id})


@tool
def Tickets___add_comment(ticket_id: str, comment: str) -> str:
    """Add a comment to a ticket.

    Args:
        ticket_id: The ticket ID to comment on
        comment: Comment text to add
    """
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___add_comment", {
        "ticket_id": ticket_id, "comment": comment
    })


@tool
def Tickets___search_issues(query: str, max_results: int = 20) -> str:
    """Search for tickets matching a query.

    Args:
        query: Search query string
        max_results: Maximum number of results to return
    """
    return _invoke_lambda(TICKET_TOOLS_LAMBDA, "Tickets___search_issues", {
        "query": query, "max_results": max_results
    })


# ─── Workflow Output Tools ────────────────────────────────────────────────────

@tool
def WorkflowOutput___report_completion(ticket_id: str, summary: str, artifacts: str = "", branch: str = "", commit_sha: str = "", pr_url: str = "") -> str:
    """Report that your work is complete. This saves your completion summary to S3 AND automatically transitions your Jira ticket to Done. Do NOT call Tickets___transition_ticket to mark your own ticket done — this tool handles that for you.

    Args:
        ticket_id: Your assigned ticket ID
        summary: A concise summary of what you accomplished and the outcome. Use whatever format best communicates the results — prose, bullets, or a short list. Keep it brief and scannable.
        artifacts: Comma-separated list of artifact paths in S3
        branch: Git branch name (for dev agents)
        commit_sha: Git commit SHA (for dev agents)
        pr_url: Pull request URL (for dev agents)
    """
    # Include workflow_id and agent_id from invocation context for journey logging (not exposed to agent)
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "WorkflowOutput___report_completion", {
        "ticket_id": ticket_id, "summary": summary,
        "artifacts": artifacts, "branch": branch, "commit_sha": commit_sha, "pr_url": pr_url,
        "workflow_id": _CURRENT_WORKFLOW_ID,
        "agent_id": _CURRENT_AGENT_ID,
    })


@tool
def WorkflowOutput___save_design_doc(workflow_id: str, agent_id: str, content: str, doc_type: str = "design") -> str:
    """Save a design document or artifact for the workflow.

    Args:
        workflow_id: Workflow ID this belongs to
        agent_id: Your agent ID
        content: Document content (markdown)
        doc_type: Type of document (design, requirements, spec)
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "WorkflowOutput___save_design_doc", {
        "workflow_id": workflow_id, "agent_id": agent_id, "content": content, "doc_type": doc_type
    })


@tool
def WorkflowOutput___submit_ticket_plan(workflow_id: str, epic_id: str, tickets: str) -> str:
    """Persist your ticket plan as a record. This does NOT create tickets.

    After calling this, you MUST call Tickets___create_ticket once per ticket
    in the plan to actually create them under the epic. The orchestration
    engine reacts to ticket status changes — it does not expand plans.

    Args:
        workflow_id: Workflow ID
        epic_id: Epic ticket ID to create children under
        tickets: JSON array of ticket objects [{title, description, assignee, blockedBy}]
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "WorkflowOutput___submit_ticket_plan", {
        "workflow_id": workflow_id, "epic_id": epic_id, "tickets": tickets
    })


# ─── Blueprint Loader Tool ────────────────────────────────────────────────────
# Blueprints are process/workflow instructions that tell the agent HOW to do its job.
# Stored in S3 at: s3://{ARTIFACT_BUCKET}/blueprints/{name}.md
# This is distinct from Claude Code skills (domain knowledge for code generation).

@tool
def load_blueprint(blueprint_name: str) -> str:
    """Load a process blueprint with step-by-step workflow instructions for your role.

    Call this FIRST when starting a new ticket to get your detailed process instructions.
    Blueprints tell you HOW to approach your work (e.g., what tools to use, what order
    to follow, what artifacts to produce). They are different from domain knowledge —
    domain expertise is handled by Claude Code's pre-loaded skills.

    Args:
        blueprint_name: Name of the blueprint to load (e.g., 'ios-designer', 'backend-dev')
    """
    if not ARTIFACT_BUCKET:
        return "ERROR: No artifact bucket configured. Cannot load blueprint."
    s3_key = f"blueprints/{blueprint_name}.md"
    try:
        s3 = boto3.client("s3", region_name=REGION)
        resp = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        return resp["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        # List available blueprints so the agent knows what's there
        try:
            objs = s3.list_objects_v2(Bucket=ARTIFACT_BUCKET, Prefix="blueprints/", Delimiter="/")
            available = [o["Key"].replace("blueprints/", "").replace(".md", "") for o in objs.get("Contents", [])]
            return f"Blueprint '{blueprint_name}' not found. Available: {', '.join(available)}"
        except Exception:
            return f"Blueprint '{blueprint_name}' not found at s3://{ARTIFACT_BUCKET}/{s3_key}"
    except Exception as e:
        return f"ERROR loading blueprint: {e}"


# ─── External Tool Integration (via MCP — GitHub, GitLab, Jira, etc.) ────────

# AgentCore Gateways authorize with AWS_IAM, so requests must be SigV4-signed —
# bearer headers won't work. The QA persona reaches the codebuild-ios-mcp gateway
# (ios_test / ios_build_status / list_schemes / get_test_logs) this way. The
# runtime signs with its own execution-role creds, which need
# bedrock-agentcore:InvokeGateway on the gateway ARN.
IOS_TEST_GATEWAY_URL = os.getenv("IOS_TEST_GATEWAY_URL", "")


import httpx as _httpx  # SigV4 MCP-gateway auth subclasses httpx.Auth (also a mcp dep)


class _SigV4HttpxAuth(_httpx.Auth):
    """httpx.Auth that SigV4-signs each request against bedrock-agentcore."""

    requires_request_body = True

    def __init__(self, region):
        from botocore.session import Session
        self._session = Session()
        self._creds = self._session.get_credentials()
        self._region = region or self._session.get_config_variable("region") or REGION

    def auth_flow(self, request):
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        aws_req = AWSRequest(
            method=request.method, url=str(request.url),
            data=request.content, headers=dict(request.headers),
        )
        SigV4Auth(
            self._creds.get_frozen_credentials(), "bedrock-agentcore", self._region
        ).add_auth(aws_req)
        request.headers.update(dict(aws_req.headers))
        yield request


def _create_mcp_clients():
    """Create MCPClient instances for each configured MCP server."""
    from strands.tools.mcp import MCPClient
    from mcp.client.streamable_http import streamablehttp_client

    servers = _parse_mcp_servers()
    clients = []

    for server in servers:
        url = server.get("url", "")
        headers = server.get("headers", {})
        if not url:
            continue
        # Capture url/headers in closure
        clients.append(MCPClient(
            (lambda u, h: lambda: streamablehttp_client(url=u, headers=h, timeout=60))(url, headers)
        ))
        logger.info(f"MCP server configured: {url}")

    # AWS_IAM gateways (SigV4-signed). Region parsed from the gateway hostname.
    if IOS_TEST_GATEWAY_URL:
        gw_url = IOS_TEST_GATEWAY_URL
        try:
            gw_region = gw_url.split(".bedrock-agentcore.")[1].split(".amazonaws.com")[0]
        except IndexError:
            gw_region = REGION
        clients.append(MCPClient(
            (lambda u, r: lambda: streamablehttp_client(
                url=u, auth=_SigV4HttpxAuth(r), timeout=120
            ))(gw_url, gw_region)
        ))
        logger.info(f"MCP gateway (SigV4) configured: {gw_url}")

    return clients


# ─── Claude Code SDK Tool ────────────────────────────────────────────────────
# Agents that write code delegate to Claude Code for higher-quality implementation.
# Claude Code reads CLAUDE.md in the repo, follows project conventions, and handles
# complex multi-file edits better than raw shell/editor tool usage.

# All agents get claude_code — even non-dev agents benefit from it for
# reading repos, analyzing code structure, generating docs from source, etc.

@tool
def claude_code(task: str, working_directory: str = "/tmp") -> str:
    """Delegate a coding task to Claude Code — a specialized AI coding agent.

    Claude Code excels at:
    - Cloning repos and understanding existing codebases (reads CLAUDE.md automatically)
    - Multi-file code implementation with proper imports and types
    - Running tests and iteratively fixing failures
    - Git operations (branch, commit, push)
    - Following project conventions from CLAUDE.md

    WHEN TO USE: Any time you need to write/edit code, run tests, or interact with a git repo.
    Let Claude Code handle the HOW while you handle the WHAT and WHY.

    Args:
        task: Complete description of what to implement. Include:
              - Repo URL and branch name
              - What to build (specific files, endpoints, features)
              - Acceptance criteria (what success looks like)
              - Any constraints (don't modify X, use library Y)
        working_directory: Directory to operate in (default: /tmp)
    """
    import subprocess
    import shutil

    logger.info(f"[claude_code] Delegating task: {task[:150]}...")

    # Ensure claude CLI is available (install if needed — first invocation only)
    claude_bin = shutil.which("claude")
    if not claude_bin:
        logger.info("[claude_code] Installing Claude Code CLI...")
        try:
            subprocess.run(
                ["npm", "install", "-g", "@anthropic-ai/claude-code"],
                capture_output=True, text=True, timeout=120,
                env={**os.environ, "HOME": "/tmp"},
            )
            claude_bin = shutil.which("claude") or "/tmp/.npm-global/bin/claude"
        except Exception as e:
            return f"ERROR: Failed to install Claude Code CLI: {e}. Use shell/editor tools directly instead."

    # Determine model for Claude Code (check both env vars Claude Code recognizes)
    cc_model = os.environ.get("ANTHROPIC_MODEL") or os.environ.get("CLAUDE_MODEL") or "us.anthropic.claude-opus-4-6-v1"

    try:
        # Use Popen + start_new_session to create a new process group.
        # This ensures we can kill claude AND all its grandchildren (Node, git, LSP)
        # on timeout. Without this, grandchildren inherit pipe FDs and keep them open,
        # causing communicate() to block forever even after timeout fires.
        proc = subprocess.Popen(
            [
                claude_bin,
                "--print",
                "--dangerously-skip-permissions",
                "--output-format", "text",
                "--model", cc_model,
                "--max-turns", "100",
                task,
            ],
            cwd=working_directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,  # New process group — enables killpg
            env={
                **os.environ,
                "CLAUDE_CODE_ENTRYPOINT": "agentcore-hub-pipeline",
                "HOME": "/tmp",
                # The robust container runs as root; Claude Code refuses
                # --dangerously-skip-permissions as root unless IS_SANDBOX=1.
                "IS_SANDBOX": "1",
            },
        )

        # Independent watchdog thread enforces the deadline. We can't rely on
        # proc.communicate(timeout=...) alone because on AgentCore the calling
        # thread can wedge in the selector (OTEL + asyncio + tool wrapper) and
        # never raise TimeoutExpired. threading.Event.wait sits on a pthread
        # condvar that wakes regardless of selector state, so it always fires.
        # Once we killpg the process group, pipe EOF unblocks communicate().
        # Deadline kept under AgentCore's 900s idleSessionTimeout.
        DEADLINE_SECS = 600
        watchdog_done = threading.Event()
        watchdog_fired = {"value": False}

        def _watchdog():
            if not watchdog_done.wait(timeout=DEADLINE_SECS):
                # Deadline expired — kill the whole process group.
                watchdog_fired["value"] = True
                try:
                    pgid = os.getpgid(proc.pid)
                    logger.warning(f"[claude_code] WATCHDOG firing after {DEADLINE_SECS}s — killing pgid={pgid}")
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    try:
                        proc.kill()
                    except OSError:
                        pass

        watchdog = threading.Thread(target=_watchdog, daemon=True)
        watchdog.start()

        try:
            # Belt-and-suspenders: also pass a timeout slightly past the
            # watchdog so if communicate ever DOES wake, we don't hang here.
            stdout, stderr = proc.communicate(timeout=DEADLINE_SECS + 30)
        except subprocess.TimeoutExpired:
            # Watchdog should have killed it; force-kill in case it didn't.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                proc.kill()
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                stdout, stderr = "", ""
        finally:
            watchdog_done.set()

        if watchdog_fired["value"]:
            return (
                f"ERROR: Claude Code timed out after {DEADLINE_SECS} seconds (10 min limit). "
                "Break this into smaller, focused claude_code calls — each should do ONE thing "
                "(implement, test, or fix). For large content generation, chunk into ~50-item batches."
            )

        output = stdout.strip()
        if proc.returncode != 0 and stderr:
            output += f"\n\nSTDERR: {stderr[-500:]}"

        logger.info(f"[claude_code] Complete. {len(output)} chars, exit code: {proc.returncode}")
        if proc.returncode != 0:
            logger.warning(f"[claude_code] FAILED — stdout: {stdout[:200]!r}")
            logger.warning(f"[claude_code] FAILED — stderr: {stderr[:200]!r}")
        return output if output else f"Claude Code exited with code {proc.returncode}. Stderr: {stderr[-300:]}"
    except FileNotFoundError:
        return "ERROR: 'claude' CLI not found in this environment. Falling back — use shell, editor, and file_write tools directly."
    except Exception as e:
        return f"ERROR invoking Claude Code: {str(e)}"


# ─── Codex CLI Tool ──────────────────────────────────────────────────────────
# OpenAI Codex as an alternative coding agent, running GPT-5.5 via Amazon Bedrock
# "Mantle" (OpenAI-compatible endpoint) — no OpenAI key. Auth is a short-term
# Bedrock bearer token minted from the runtime IAM role. Mirrors claude_code's
# subprocess + watchdog pattern so it's a drop-in peer.

# Bedrock Mantle config — GPT-5.5 is served on the /openai/v1 path in us-east-2
# and requires the OpenAI-Project header (its absence yields "Engine not found").
_MANTLE_REGION = os.getenv("BEDROCK_MANTLE_REGION", "us-east-2")
_CODEX_MODEL = os.getenv("CODEX_MODEL", "openai.gpt-5.5")
_MANTLE_PROJECT = os.getenv("BEDROCK_MANTLE_PROJECT", "default")


def _ensure_codex_config() -> str | None:
    """Write ~/.codex/config.toml pointing at Bedrock Mantle and mint a bearer
    token into OPENAI_API_KEY. Returns an error string on failure, else None."""
    codex_home = os.path.join(os.environ.get("HOME", "/tmp"), ".codex")
    os.makedirs(codex_home, exist_ok=True)
    base_url = f"https://bedrock-mantle.{_MANTLE_REGION}.api.aws/openai/v1"
    with open(os.path.join(codex_home, "config.toml"), "w") as f:
        f.write(
            f'model = "{_CODEX_MODEL}"\n'
            'model_provider = "bedrock-mantle"\n\n'
            "[model_providers.bedrock-mantle]\n"
            'name = "Amazon Bedrock Mantle (OpenAI-compatible)"\n'
            f'base_url = "{base_url}"\n'
            'env_key = "OPENAI_API_KEY"\n'
            'wire_api = "responses"\n\n'
            "[model_providers.bedrock-mantle.http_headers]\n"
            f'OpenAI-Project = "{_MANTLE_PROJECT}"\n'
        )
    if not os.environ.get("OPENAI_API_KEY"):
        try:
            from aws_bedrock_token_generator import provide_token
            os.environ["OPENAI_API_KEY"] = provide_token(region=_MANTLE_REGION)
        except Exception as e:
            return f"ERROR: could not mint Bedrock token for Codex: {e}"
    return None


@tool
def codex(task: str, working_directory: str = "/tmp") -> str:
    """Delegate a coding task to OpenAI Codex (GPT-5.5 via Amazon Bedrock).

    A peer to claude_code — same contract, different engine. Useful for a second
    opinion, code review, or when you want GPT-5.5 to implement/verify. No OpenAI
    key required; inference routes through Amazon Bedrock using the runtime role.

    Args:
        task: Complete description of what to do (repo URL/branch, what to build
              or review, acceptance criteria, constraints).
        working_directory: Directory to operate in (default: /tmp)
    """
    import subprocess
    import shutil

    logger.info(f"[codex] Delegating task: {task[:150]}...")

    codex_bin = shutil.which("codex")
    if not codex_bin:
        logger.info("[codex] Installing Codex CLI...")
        try:
            subprocess.run(
                ["npm", "install", "-g", "@openai/codex"],
                capture_output=True, text=True, timeout=180,
                env={**os.environ, "HOME": "/tmp"},
            )
            codex_bin = shutil.which("codex") or "/tmp/.npm-global/bin/codex"
        except Exception as e:
            return f"ERROR: Failed to install Codex CLI: {e}. Use claude_code or shell tools instead."

    cfg_err = _ensure_codex_config()
    if cfg_err:
        return cfg_err

    # GPT-5.5 on Mantle (preview) intermittently 404s "Engine not found" when its
    # on-demand engine is cold — retry the run on that signal, with backoff to
    # give the engine time to warm (it can take several attempts over ~30-60s).
    import time as _time
    import re as _re_codex
    DEADLINE_SECS = 600
    ATTEMPTS = int(os.getenv("CODEX_ENGINE_RETRIES", "20"))
    BACKOFF_SECS = int(os.getenv("CODEX_ENGINE_BACKOFF", "8"))
    last_output = ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            proc = subprocess.Popen(
                [codex_bin, "exec", "--json", "--model", _CODEX_MODEL,
                 "--yolo", "--skip-git-repo-check", task],
                cwd=working_directory,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                start_new_session=True,
                env={**os.environ, "HOME": os.environ.get("HOME", "/tmp")},
            )
            watchdog_done = threading.Event()
            watchdog_fired = {"value": False}

            def _watchdog():
                if not watchdog_done.wait(timeout=DEADLINE_SECS):
                    watchdog_fired["value"] = True
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, OSError):
                        try:
                            proc.kill()
                        except OSError:
                            pass

            wd = threading.Thread(target=_watchdog, daemon=True)
            wd.start()
            try:
                stdout, stderr = proc.communicate(timeout=DEADLINE_SECS + 30)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
                stdout, stderr = proc.communicate(timeout=5)
            finally:
                watchdog_done.set()

            if watchdog_fired["value"]:
                return (f"ERROR: Codex timed out after {DEADLINE_SECS}s. Break the task "
                        "into smaller, focused codex calls.")

            # codex exec --json emits JSONL; the final answer is the last
            # agent_message item. Fall back to raw stdout if nothing parses.
            answer = ""
            for line in stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                item = obj.get("item") if isinstance(obj, dict) else None
                if isinstance(item, dict) and item.get("type") in ("agent_message", "assistant_message", "message"):
                    txt = item.get("text") or item.get("message")
                    if isinstance(txt, str) and txt:
                        answer = txt
            output = (answer or stdout).strip()
            last_output = output

            # GPT-5.5 on Mantle (preview) returns two transient, retryable signals
            # that Codex surfaces as turn errors without retrying itself:
            #   - "Engine not found" — on-demand engine is cold (warming up)
            #   - "rate limit exceeded. Retry after Ns." — throttled; honor the hint
            blob = stdout + "\n" + (stderr or "")
            cold = "Engine not found" in blob
            rl = _re_codex.search(r"[Rr]ate limit exceeded\.?\s*Retry after\s*(\d+)", blob)
            if (cold or rl) and attempt < ATTEMPTS:
                if rl:
                    # Respect the server's backoff hint (+1s slack), capped.
                    wait = min(int(rl.group(1)) + 1, 60)
                    logger.warning(f"[codex] rate limited (attempt {attempt}/{ATTEMPTS}) — waiting {wait}s...")
                else:
                    wait = BACKOFF_SECS
                    logger.warning(f"[codex] cold engine (attempt {attempt}/{ATTEMPTS}) — backing off {wait}s...")
                _time.sleep(wait)
                continue

            logger.info(f"[codex] Complete. {len(output)} chars, exit code: {proc.returncode}")
            if proc.returncode != 0 and stderr:
                output += f"\n\nSTDERR: {stderr[-500:]}"
            return output if output else f"Codex exited with code {proc.returncode}. Stderr: {stderr[-300:]}"
        except FileNotFoundError:
            return "ERROR: 'codex' CLI not found. Use claude_code or shell tools instead."
        except Exception as e:
            return f"ERROR invoking Codex: {str(e)}"
    return last_output or "ERROR: Codex unavailable after retries (Bedrock Mantle preview — cold engine or rate limit)."


# ─── All pipeline tools ───────────────────────────────────────────────────────

LAMBDA_TOOLS = [
    # S3 file download (for images → image_reader)
    download_s3_file,
    # S3 (Lambda-backed)
    S3Storage___read_object,
    S3Storage___write_object,
    S3Storage___list_objects,
    # Tickets (Lambda-backed)
    Tickets___create_ticket,
    Tickets___transition_ticket,
    Tickets___update_ticket,
    Tickets___list_tickets,
    Tickets___add_comment,
    Tickets___search_issues,
    # Workflow (Lambda-backed)
    WorkflowOutput___report_completion,
    WorkflowOutput___save_design_doc,
    WorkflowOutput___submit_ticket_plan,
    # Blueprint (Lambda-backed) — process/workflow instructions for the agent's role
    load_blueprint,
    # GitHub tools come from MCPClient (remote MCP) — not Lambda-backed
]

logger.info(f"Loaded {len(LAMBDA_TOOLS)} Lambda-backed tools + GitHub MCP (built-in tools loaded at invocation time)")

# --- DynamoDB client for real-time event publishing ---
_ddb_events_client = boto3.client("dynamodb", region_name=REGION)
_EVENTS_TABLE = os.getenv("EVENTS_TABLE", "agentcore-hub-events")


def _publish_agent_started(workflow_id: str, agent_id: str):
    """Publish agent.started event so UI immediately shows this agent as running."""
    import time, random, string
    try:
        event_id = f"{int(time.time() * 1000)}-{''.join(random.choices(string.ascii_lowercase, k=4))}"
        _ddb_events_client.put_item(
            TableName=_EVENTS_TABLE,
            Item={
                "workflowId": {"S": workflow_id},
                "eventId": {"S": event_id},
                "type": {"S": "agent.started"},
                "detail": {"M": {
                    "agentId": {"S": agent_id},
                    "workflowId": {"S": workflow_id},
                    "timestamp": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                }},
                "timestamp": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            },
        )
        logger.info(f"[{agent_id}] Published agent.started event")
    except Exception as e:
        logger.warning(f"[{agent_id}] Failed to publish agent.started: {e}")


# --- App entrypoint (streaming enabled) ---
app = BedrockAgentCoreApp()


@app.entrypoint
async def agent_invocation(payload, context):
    """
    Handler for agent invocations — streaming responses.

    Expected payload:
    {
        "prompt": "The task context (ticket description, workflow metadata)",
        "workflow_id": "wf_xxx",
        "agent_id": "agentcore_hub_security_reviewer",
        "model_override": "us.anthropic.claude-opus-4-6-v1" (optional)
    }

    The system prompt is NOT in the payload — it's baked into the agent at deploy time
    via the SYSTEM_PROMPT env var. The orchestrator is dumb and only passes task context.
    """
    global _CURRENT_WORKFLOW_ID, _CURRENT_AGENT_ID
    prompt = payload.get("prompt", "")
    workflow_id = payload.get("workflow_id", "unknown")
    agent_id = payload.get("agent_id", "unknown")
    model_override = payload.get("model_override")
    _CURRENT_WORKFLOW_ID = workflow_id
    _CURRENT_AGENT_ID = agent_id

    logger.info(f"[{agent_id}] Starting invocation for workflow {workflow_id}")
    logger.info(f"[{agent_id}] Model: {model_override or MODEL_ID}, read_timeout: {READ_TIMEOUT}s")

    # Publish "agent started" event so UI immediately shows this agent as running/pulsing
    _publish_agent_started(workflow_id, agent_id)

    # Use model override if provided (orchestrator can specify per-agent)
    MODEL_ALIASES = {
        "opus": "us.anthropic.claude-opus-4-6-v1",
        "sonnet": "us.anthropic.claude-sonnet-4-6",
        "haiku": "us.anthropic.claude-haiku-4-5-20251001",
        "claude-opus-46": "us.anthropic.claude-opus-4-6-v1",
        "claude-sonnet-46": "us.anthropic.claude-sonnet-4-6",
    }
    active_model = model
    if model_override and model_override != MODEL_ID:
        resolved_model_id = MODEL_ALIASES.get(model_override, model_override)
        override_config = BotocoreConfig(
            read_timeout=READ_TIMEOUT,
            connect_timeout=30,
            retries={"max_attempts": 2},
        )
        active_model = BedrockModel(
            model_id=resolved_model_id,
            region_name=REGION,
            boto_client_config=override_config,
            streaming=True,
        )
        logger.info(f"[{agent_id}] Model override: {model_override} → {resolved_model_id}")

    # Load built-in tools (lazy — avoids 30s init timeout)
    builtin_tools = _load_builtin_tools()
    all_tools = builtin_tools + LAMBDA_TOOLS + [claude_code, codex]

    # External tools via MCP (GitHub, GitLab, Jira, Asana, etc.)
    # Strands Agent manages MCPClient lifecycle internally (start/stop)
    mcp_clients = _create_mcp_clients()
    if mcp_clients:
        all_tools.extend(mcp_clients)
        logger.info(f"[{agent_id}] {len(mcp_clients)} MCP server(s) attached")
    else:
        logger.warning(f"[{agent_id}] No MCP servers configured — external tools unavailable")

    # Collect tool_use events via callback handler AND publish them in real-time to the
    # events table so the UI can flash tool icons as they happen (not just at the end).
    tool_events = []

    class ToolTrackingHandler:
        """Callback handler that records tool invocations and text output, publishing to DynamoDB for real-time UI."""
        def __init__(self):
            self.previous_tool_use = None
            self._seq = 0

        def _publish_event(self, event_type: str, detail: dict):
            """Publish an event to the DynamoDB events table (fire-and-forget).
            Skips writing if no workflow context (chat/ad-hoc invocations).
            IMPORTANT: Table sort key is `timestamp` — must be unique per item."""
            if not workflow_id or workflow_id == "unknown":
                return
            try:
                import time
                self._seq += 1
                event_id = f"{int(time.time() * 1000)}-{self._seq:06d}"
                # Unique timestamp with sequence suffix (sort key must never collide)
                unique_ts = f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())}.{self._seq:04d}Z"
                detail_map = {}
                for k, v in detail.items():
                    if v is not None:
                        detail_map[k] = {"S": str(v)}
                _ddb_events_client.put_item(
                    TableName=_EVENTS_TABLE,
                    Item={
                        "workflowId": {"S": workflow_id},
                        "eventId": {"S": event_id},
                        "type": {"S": event_type},
                        "detail": {"M": detail_map},
                        "timestamp": {"S": unique_ts},
                    },
                )
            except Exception as e:
                logger.warning(f"[{agent_id}] Failed to publish {event_type} event: {e}")

        def __call__(self, **kwargs):
            current_tool_use = kwargs.get("current_tool_use", {})
            data = kwargs.get("data", "")
            reasoning_text = kwargs.get("reasoningText", "")

            # Tool use events
            if current_tool_use and current_tool_use.get("name"):
                if self.previous_tool_use != current_tool_use:
                    self.previous_tool_use = current_tool_use
                    tool_name = current_tool_use["name"]
                    tool_events.append(tool_name)
                    logger.info(f"[{agent_id}] Tool call: {tool_name}")
                    self._publish_event("agent.streaming", {
                        "agentId": agent_id,
                        "type": "trace",
                        "toolName": tool_name,
                        "workflowId": workflow_id,
                    })

            # Text output events (agent's visible response text)
            if data:
                self._publish_event("agent.streaming", {
                    "agentId": agent_id,
                    "type": "text",
                    "content": data,
                    "workflowId": workflow_id,
                })

            # Reasoning/thinking events
            if reasoning_text:
                self._publish_event("agent.streaming", {
                    "agentId": agent_id,
                    "type": "reasoning",
                    "content": reasoning_text,
                    "workflowId": workflow_id,
                })

    # Create agent — we publish events from stream_async loop directly.
    # Prompt resolves per-invocation: shared-runtime topologies (1 or 4 runtimes)
    # need the right persona prompt for the agent_id in this payload; 14-runtime
    # mode short-circuits to the deployed SYSTEM_PROMPT.
    tracker = ToolTrackingHandler()
    persona_prompt = _load_prompt_for_agent(agent_id)
    agent = Agent(
        model=active_model,
        system_prompt=persona_prompt,
        tools=all_tools,
        callback_handler=None,
    )

    # Iterate stream_async — write events to DDB in real-time as they arrive.
    # Each event gets a unique timestamp (ISO second + sequence suffix) to avoid
    # sort key collisions. Text is buffered briefly to reduce DDB writes.
    final_text = ""
    result = None
    _text_buffer = ""
    _FLUSH_THRESHOLD = 200  # chars before flushing text to DDB

    def _flush_text_buffer():
        nonlocal _text_buffer
        if _text_buffer:
            tracker._publish_event("agent.streaming", {
                "agentId": agent_id,
                "type": "text",
                "content": _text_buffer,
                "workflowId": workflow_id,
            })
            _text_buffer = ""

    async for event in agent.stream_async(prompt):
        if "data" in event and event["data"]:
            final_text += event["data"]
            _text_buffer += event["data"]
            if len(_text_buffer) >= _FLUSH_THRESHOLD:
                _flush_text_buffer()
        elif "current_tool_use" in event:
            _flush_text_buffer()  # flush pending text before tool event
            current_tool_use = event["current_tool_use"]
            if current_tool_use and current_tool_use.get("name"):
                if tracker.previous_tool_use != current_tool_use:
                    tracker.previous_tool_use = current_tool_use
                    tool_name = current_tool_use["name"]
                    tool_events.append(tool_name)
                    logger.info(f"[{agent_id}] Tool call: {tool_name}")
                    tracker._publish_event("agent.streaming", {
                        "agentId": agent_id,
                        "type": "trace",
                        "toolName": tool_name,
                        "workflowId": workflow_id,
                    })
        elif "reasoningText" in event and event["reasoningText"]:
            _flush_text_buffer()  # flush pending text before reasoning event
            tracker._publish_event("agent.streaming", {
                "agentId": agent_id,
                "type": "reasoning",
                "content": event["reasoningText"],
                "workflowId": workflow_id,
            })
        if "result" in event:
            result = event["result"]

    # Flush any remaining buffered text after stream ends
    _flush_text_buffer()

    # Extract final text from result if stream didn't produce text (fallback)
    if not final_text and result:
        msg = getattr(result, "message", None) or (result if isinstance(result, dict) else None)
        if msg:
            content = msg.get("content", []) if isinstance(msg, dict) else getattr(msg, "content", [])
            for block in (content or []):
                if isinstance(block, dict) and "text" in block:
                    final_text += block["text"]

    logger.info(f"[{agent_id}] Invocation complete for workflow {workflow_id}, output: {len(final_text)} chars, tools used: {len(tool_events)}")

    # Emit tool_use events FIRST so the agent-invoker can publish them for real-time UI flashing.
    for tool_name in tool_events:
        yield {"event": {"contentBlockStart": {"start": {"toolUse": {"name": tool_name}}}}}

    # Then emit the final text as a single contentBlockDelta event
    yield {"event": {"contentBlockDelta": {"delta": {"text": final_text}}}}


if __name__ == "__main__":
    app.run()
