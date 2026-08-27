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
import time
import uuid
from datetime import datetime, timezone

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
MODEL_ID = os.getenv("MODEL_ID", "us.anthropic.claude-fable-5")
READ_TIMEOUT = int(os.getenv("READ_TIMEOUT", "1200"))  # 20 minutes — agents need room for complex claude_code calls
MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "32000"))
GATEWAY_ARN = os.getenv("GATEWAY_ARN", "")
# NOTE: AgentCore reserves "ARTIFACT_BUCKET" as a system env var (points to CodeBuild source bucket).
# We use AGENTCORE_HUB_ARTIFACT_BUCKET to avoid the collision.
ARTIFACT_BUCKET = os.getenv("AGENTCORE_HUB_ARTIFACT_BUCKET", os.getenv("ARTIFACT_BUCKET", ""))
# AgentCore Memory (optional). When set, each invocation's user prompt +
# assistant response is saved as a conversational event, keyed by the runtime
# session id and the persona's agent_id as actor. The hub dashboard resolves
# this same MEMORY_ID env var to render session/chat history.
MEMORY_ID = os.getenv("MEMORY_ID", "")

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

# --- OTel telemetry init (TEAM-3102) ---------------------------------------
# Under the Dockerfile's `opentelemetry-instrument` wrapper, ADOT's
# aws_configurator has ALREADY installed the global TracerProvider + OTLP
# pipeline before this module imports. Strands' Tracer binds the global
# provider (strands/telemetry/tracer.py:119), so in that case we must attach
# NOTHING — a no-arg StrandsTelemetry() would log "Overriding of current
# TracerProvider is not allowed", orphan its own provider, and clobber the
# baggage,xray,tracecontext propagators (drops session.id stamping).
# The StrandsTelemetry fallback exists only for bare `python main.py`.

_TELEMETRY_INITIALIZED = False


def _init_telemetry() -> None:
    global _TELEMETRY_INITIALIZED
    if _TELEMETRY_INITIALIZED:
        return
    # TEAM-3313: this runs at module import — any exception here would abort
    # the import before `app = BedrockAgentCoreApp()` and turn a telemetry
    # failure into a total agent outage. Swallow and log instead.
    try:
        from opentelemetry import trace as _otel_trace_api

        provider = _otel_trace_api.get_tracer_provider()
        if hasattr(provider, "add_span_processor"):
            # Real SDK provider → opentelemetry-instrument/ADOT own the pipeline.
            logger.info(
                "telemetry: ADOT-managed TracerProvider active (%s) — Strands "
                "invoke_agent spans attach to it; no local exporter added",
                type(provider).__name__,
            )
        else:
            from strands.telemetry import StrandsTelemetry

            StrandsTelemetry().setup_otlp_exporter()
            logger.info(
                "telemetry: no SDK TracerProvider found — StrandsTelemetry "
                "fallback provider + OTLP exporter installed"
            )
    except Exception:
        logger.warning(
            "telemetry: init failed — continuing without telemetry",
            exc_info=True,
        )
    finally:
        # Mark initialized even on failure: a retry would run against
        # partially-mutated global OTel state, so one attempt only.
        _TELEMETRY_INITIALIZED = True


_init_telemetry()
# ---------------------------------------------------------------------------

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
    # Without an explicit cap, Bedrock's default (~4k) truncates multi-ticket
    # fan-out turns mid-JSON → MaxTokensReachedException kills the invocation.
    max_tokens=MAX_OUTPUT_TOKENS,
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
_CURRENT_TICKET_ID = ""

# ─── Remote coding runtime (Cloud Code) ──────────────────────────────────────
# When enabled, claude_code/codex delegate to the standalone coding-agent
# runtime instead of spawning the CLI in this microVM. The coding runtime keeps
# the workspace + transcript on EFS, so the session survives this container and
# is resumable from the Cloud Code tab (chat resume / `claude --resume`).
#
# Gate: CODING_AGENT_RUNTIME_ARN set AND the current persona listed in
# REMOTE_CODING_PERSONAS (comma-separated agent ids, or "all"). Off by default.
CODING_AGENT_RUNTIME_ARN = os.getenv("CODING_AGENT_RUNTIME_ARN", "")
REMOTE_CODING_PERSONAS = {
    p.strip() for p in os.getenv("REMOTE_CODING_PERSONAS", "").split(",") if p.strip()
}
CLOUD_CODE_TABLE = os.getenv("CLOUD_CODE_TABLE", "agentcore-hub-cloud-code-sessions")
# Submit and poll calls are all sub-second server-side; this only needs to cover
# submit's worst-case workspace setup: clone (300s cap) + branch fetch (120s) +
# checkout (60s) + config/artifact install. Submits are idempotent (turn_id is
# client-generated), so even a timeout here can't double-run a turn.
REMOTE_CODING_READ_TIMEOUT = int(os.getenv("REMOTE_CODING_READ_TIMEOUT", "600"))
# Poll cadence + overall turn budget. The budget must exceed the coding
# runtime's TURN_TIMEOUT_S (1500s) PLUS its post-CLI terminal work — artifact
# harvest (can be GBs) and the journal-write retry loop — so the runner's own
# verdict reaches us via the journal instead of us giving up first.
REMOTE_CODING_POLL_S = int(os.getenv("REMOTE_CODING_POLL_S", "20"))
REMOTE_CODING_TURN_BUDGET_S = int(os.getenv("REMOTE_CODING_TURN_BUDGET_S", "2700"))

# Tenant the workflow session rows belong to. Multi-tenant deployments must set
# this to the tenant that owns the fleet, or the Cloud Code tab (which scopes
# reads by the caller's tenant) won't show workflow sessions.
CLOUD_CODE_TENANT_ID = os.getenv("CLOUD_CODE_TENANT_ID", "default")

# Intelligence tiers the directing persona can pick per claude_code delegation
# (`model` arg). Bedrock inference-profile ids — bare model names 500 on Bedrock.
# Empty/unknown tier → the coding runtime's own CLAUDE_MODEL default (Fable 5).
CODING_MODEL_TIERS = {
    "fable": "us.anthropic.claude-fable-5",
    "opus": "us.anthropic.claude-opus-5",
    "sonnet": "us.anthropic.claude-sonnet-5",
    "haiku": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
}

# One coding session per agent-task: every claude_code/codex call in this
# invocation lands on the same warm EFS workspace and resumes the same CLI
# conversation. Conversation ids are per-CLI — claude and codex resume handles
# are not interchangeable. Reset by agent_invocation() alongside _CURRENT_*.
_CODING_SESSION = {
    "session_id": None,
    "conversation_ids": {},  # cli -> resume id
    "repo": None,
    "recorded": False,
    # Ported-session resume fields (a laptop session shipped to this workflow).
    # Forwarded to the coding runtime so it installs the S3 transcript + checks
    # out the ported branch — idempotent there, so sending every turn is safe.
    "resume_transcript": None,  # S3 key of the raw .jsonl
    "resume_session_id": None,  # conversation id inside that transcript
    "branch": None,
    "git_mode": None,
    "clone_url": None,
}


def _remote_coding_enabled() -> bool:
    if not CODING_AGENT_RUNTIME_ARN:
        return False
    return "all" in REMOTE_CODING_PERSONAS or _CURRENT_AGENT_ID in REMOTE_CODING_PERSONAS


def _record_coding_session(cli: str) -> None:
    """Best-effort: upsert this agent-task's coding session into the Cloud Code
    sessions table so the run is visible + resumable from the Cloud Code tab.
    Row shape matches src/lib/cloud-code/types.ts (CloudCodeSession) plus
    origin/workflowId/agentId so the UI can badge/filter workflow sessions."""
    try:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        ticket = f" {_CURRENT_TICKET_ID}" if _CURRENT_TICKET_ID else ""
        conversation_id = _CODING_SESSION["conversation_ids"].get(cli)
        item = {
            "sessionId": {"S": _CODING_SESSION["session_id"]},
            "userId": {"S": "workflow"},
            "tenantId": {"S": CLOUD_CODE_TENANT_ID},
            "title": {"S": f"[wf]{ticket} {_CURRENT_AGENT_ID}"[:120]},
            "cli": {"S": cli},
            "createdAt": {"S": now},
            "updatedAt": {"S": now},
            "turns": {"L": []},
            "origin": {"S": "workflow"},
            "workflowId": {"S": _CURRENT_WORKFLOW_ID},
            "agentId": {"S": _CURRENT_AGENT_ID},
        }
        if _CODING_SESSION.get("repo"):
            item["repo"] = {"S": _CODING_SESSION["repo"]}
        if conversation_id:
            item["claudeSessionId"] = {"S": conversation_id}
        if _CODING_SESSION.get("recorded"):
            # Row exists — only refresh the resume handle + timestamp, never
            # clobber fields the UI may have touched (title edits, turns).
            expr = "SET updatedAt = :u"
            vals = {":u": {"S": now}}
            if conversation_id:
                expr += ", claudeSessionId = :c, cli = :cli"
                vals[":c"] = {"S": conversation_id}
                vals[":cli"] = {"S": cli}
            boto3.client("dynamodb", region_name=REGION).update_item(
                TableName=CLOUD_CODE_TABLE,
                Key={"sessionId": {"S": _CODING_SESSION["session_id"]}},
                UpdateExpression=expr,
                ExpressionAttributeValues=vals,
            )
        else:
            boto3.client("dynamodb", region_name=REGION).put_item(
                TableName=CLOUD_CODE_TABLE, Item=item
            )
            _CODING_SESSION["recorded"] = True
    except Exception as e:  # noqa: BLE001 — session bookkeeping must never fail a turn
        logger.warning(f"[remote-coding] session record failed (non-fatal): {e}")


def _localize_repo_task(task: str, repo: str, working_directory: str) -> str:
    """Local-CLI fallback: blueprints pass repo= instead of putting clone
    instructions in the task text, so when the remote gate is off we restore
    that context here — otherwise the local CLI has no repository to work in."""
    if not repo:
        return task
    clone_url = repo if repo.startswith(("http://", "https://", "git@")) else f"https://github.com/{repo}"
    return (
        f"First: if {working_directory}/repo is not already a git checkout of "
        f"{clone_url}, clone it there (git clone {clone_url} {working_directory}/repo). "
        f"Then cd into it and do the following task in that repository.\n\n{task}"
    )


def _maybe_resume_session(resume_session: str) -> None:
    """Seed this task's coding session from a PRIOR agent-task's session (rework:
    the reviewer rejected, the ticket came back, and the agent chose to continue
    its earlier conversation instead of rebuilding context).

    Only applies before the first coding call of this invocation — once a
    session exists, later calls already share it. Conversation handles are
    recovered from the Cloud Code sessions table; if the row is gone (reaped),
    we still pin the runtimeSessionId — a warm workspace may survive — and the
    CLI simply starts a new conversation there."""
    if not resume_session or _CODING_SESSION["session_id"]:
        return
    _CODING_SESSION["session_id"] = resume_session
    _CODING_SESSION["recorded"] = True  # row exists (or existed) — update, don't re-put
    try:
        row = boto3.client("dynamodb", region_name=REGION).get_item(
            TableName=CLOUD_CODE_TABLE,
            Key={"sessionId": {"S": resume_session}},
        ).get("Item")
        if row:
            cli = row.get("cli", {}).get("S")
            conv = row.get("claudeSessionId", {}).get("S")
            if cli and conv:
                _CODING_SESSION["conversation_ids"][cli] = conv
            if row.get("repo", {}).get("S"):
                _CODING_SESSION["repo"] = row["repo"]["S"]
            # Ported laptop session (ship_session_to_workflow): the transcript
            # lives in S3, not on the coding runtime's EFS yet. Forward the
            # install fields so the first turn restores the exact conversation
            # and checks out the ported branch (idempotent on the runtime).
            if row.get("resumeTranscriptKey", {}).get("S"):
                _CODING_SESSION["resume_transcript"] = row["resumeTranscriptKey"]["S"]
                _CODING_SESSION["resume_session_id"] = conv
                _CODING_SESSION["branch"] = row.get("branch", {}).get("S")
                _CODING_SESSION["git_mode"] = row.get("gitMode", {}).get("S")
                _CODING_SESSION["clone_url"] = row.get("cloneUrl", {}).get("S")
            logger.info(f"[remote-coding] resuming prior session {resume_session} "
                        f"(cli={cli}, conversation={'yes' if conv else 'no'}, "
                        f"ported={'yes' if _CODING_SESSION['resume_transcript'] else 'no'})")
        else:
            logger.info(f"[remote-coding] resume requested but no session row for "
                        f"{resume_session} — pinning workspace only")
    except Exception as e:  # noqa: BLE001 — resume is best-effort, never fail the turn
        logger.warning(f"[remote-coding] session lookup failed (non-fatal): {e}")


def _coding_invoke(client, payload: dict) -> dict:
    """One short InvokeAgentRuntime round-trip to the coding runtime (JSON in,
    JSON out). Both submit and poll ride this — every call closes in seconds,
    so nothing here can hit the platform's ~15-min idle-connection kill."""
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=CODING_AGENT_RUNTIME_ARN,
        runtimeSessionId=_CODING_SESSION["session_id"],
        payload=json.dumps(payload).encode("utf-8"),
        accept="application/json",
    )
    return json.loads(resp["response"].read().decode("utf-8"))


def _poll_coding_turn(client, turn_id: str) -> dict:
    """Poll an async coding turn to its terminal state. Returns the done record
    ({response, claude_session_id, artifacts?} or {error}).

    Long silent stretches (builds, big writes) are NORMAL for coding turns — the
    connection-per-turn transport died on exactly those (idle >15 min = silent
    kill, stuck-fleet postmortems 2026-08-27 ×2). Each poll here is a fresh
    sub-second invocation, so wall-clock turn length no longer matters. A poll
    also confirms the microVM is alive: 'dead' (stale heartbeat) and 'unknown'
    (journal gone) both mean the turn will never finish — fail fast, don't wait
    out the budget."""
    deadline = time.time() + REMOTE_CODING_TURN_BUDGET_S
    # Live heartbeats extend the deadline (terminal work is unbounded), but a
    # wedged-yet-heartbeating runner must not pin this persona forever.
    hard_stop = time.time() + 2 * REMOTE_CODING_TURN_BUDGET_S
    unknowns = 0
    while time.time() < min(deadline, hard_stop):
        time.sleep(REMOTE_CODING_POLL_S)
        try:
            status = _poll_once(client, turn_id)
        except Exception as e:  # noqa: BLE001
            # Throttle / network / AgentCore blip — says nothing about the
            # runner, which may be mid-turn writing heartbeats. Never terminal:
            # bailing here would make the persona resubmit into a workspace
            # where the original turn is still executing. Keep polling until
            # the budget expires or the journal renders a verdict.
            logger.warning(f"[remote-coding] poll error (non-terminal): {str(e)[:200]}")
            continue
        state = status.get("status")
        if state == "done":
            return status
        if state == "dead":
            # Heartbeat provably stale — the runner is gone. Only this and a
            # repeatedly-absent journal may trigger a resubmit: anything softer
            # risks racing a still-live runner and executing the task twice.
            return {"error": f"coding turn died mid-run (heartbeat stale "
                             f"{status.get('stale_s')}s — microVM likely recycled)",
                    "retryable_vm_death": True}
        if state == "unknown":
            # Journal missing. It's seeded before submit returns and lives on
            # shared EFS, so this should be definitive — but demand consecutive
            # confirmations before declaring death, in case the read raced a
            # slow first write or a flaky mount.
            unknowns += 1
            if unknowns >= 3:
                return {"error": "coding turn vanished (no journal across 3 "
                                 "consecutive polls)",
                        "retryable_vm_death": True}
            continue
        unknowns = 0
        # "running" or "transient" (degraded EFS read / torn read racing the
        # journal's tmp+rename): the turn may still be live — keep polling.
        # A provably-live runner (fresh heartbeat / in-memory answer) extends
        # the deadline: terminal work after the CLI (artifact harvest can be
        # GBs) has no fixed bound, and expiring against a live runner would
        # push the persona toward re-running work that already happened. The
        # runner's own watchdog (TURN_TIMEOUT_S) bounds the CLI; a runner that
        # dies mid-harvest stops heartbeating and the dead verdict fires.
        if state == "running":
            deadline = max(deadline,
                           time.time() + max(3 * REMOTE_CODING_POLL_S, 120))
    # Budget spent with no live heartbeat seen recently and no verdict. The
    # turn may STILL have completed its work — a blind re-run is not safe.
    # Probe once more, then tell the persona to VERIFY STATE WITHOUT running a
    # coding turn (a fresh CLI call would race a still-live runner in the same
    # workspace).
    try:
        final = _poll_once(client, turn_id)
        if final.get("status") == "done":
            return final
    except Exception:  # noqa: BLE001
        pass
    return {"error": f"coding turn exceeded {REMOTE_CODING_TURN_BUDGET_S}s budget "
                     f"with no verdict. Its work may already exist and a runner "
                     f"may still be finishing. Do NOT re-run the task and do NOT "
                     f"start another coding call yet: wait a few minutes, then "
                     f"check the branch on GitHub (get_file_contents / list "
                     f"commits) to see whether the work landed before deciding "
                     f"anything",
            "no_retry_hint": True}


_POLL_CLIENT = None


def _poll_once(client, turn_id: str) -> dict:
    """client is the submit client (600s read timeout, sized for cold-clone
    setup). Polls answer in under a second server-side, so they get their own
    short-timeout client — otherwise one accepted-but-silent poll connection
    blocks 600s and blows straight past the loop's hard stop."""
    global _POLL_CLIENT
    if _POLL_CLIENT is None:
        _POLL_CLIENT = boto3.client(
            "bedrock-agentcore", region_name=REGION,
            config=BotocoreConfig(read_timeout=30, connect_timeout=10,
                                  retries={"max_attempts": 0}),
        )
    return _coding_invoke(_POLL_CLIENT, {
        "action": "poll",
        "turn_id": turn_id,
        "session_id": _CODING_SESSION["session_id"],
    })


def _recover_lost_submit(client, payload: dict):
    """The submit's response was lost client-side. What the server did is
    unknown — AND the server itself may be a legacy build that ignores
    mode/turn_id and is still executing the turn synchronously (no dedupe, so a
    blind resubmit would double-run it). Probe with a poll on the turn_id we
    sent:
      - async runtime that accepted the submit → running/done → treat as
        submitted and let the normal poll loop take over;
      - async runtime that never started it → unknown (journal seeded pre-return
        means accepted turns always journal) → resubmit same id (deduped);
      - legacy runtime → poll comes back an error/no-status → NOT safe to
        resubmit; give up with an explicit error (the persona's retry guidance
        stands, and the workspace is preserved).
    Returns a submit-shaped dict, or None when recovery is unsafe."""
    probe = None
    for attempt in range(5):  # a throttled probe is transient — keep asking
        try:
            probe = _poll_once(client, payload["turn_id"])
            break
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[remote-coding] recovery probe failed "
                           f"({attempt + 1}/5): {str(e)[:200]}")
            time.sleep(REMOTE_CODING_POLL_S)
    if probe is None:
        # Every probe hit a transient failure — still zero evidence about the
        # runner. The poll loop tolerates transient errors until its budget, so
        # hand it the turn_id rather than abandoning (abandoning advises a
        # fresh-id retry that could race an accepted runner).
        return {"submitted": True, "turn_id": payload["turn_id"]}
    state = probe.get("status")
    if state in ("running", "done", "transient"):
        return {"submitted": True, "turn_id": payload["turn_id"]}
    if state == "unknown":
        try:
            return _coding_invoke(client, payload)  # deduped server-side
        except Exception as e:  # noqa: BLE001
            # The resubmit may have been ACCEPTED with only its response lost —
            # the same ambiguity we're recovering from. Accepted turns journal
            # before the response is sent, so hand the turn_id to the poll loop
            # to resolve: running/done if it started, three consecutive
            # 'unknown's → the retryable death verdict if it never did. Never
            # abandon here — that advises a fresh-id retry that could race an
            # accepted runner.
            logger.warning(f"[remote-coding] recovery resubmit response lost — "
                           f"polling turn_id anyway: {str(e)[:200]}")
            return {"submitted": True, "turn_id": payload["turn_id"]}
    # No parseable status → legacy runtime mid-synchronous-turn. Resubmitting
    # would run the task twice; surface the loss instead.
    logger.warning(f"[remote-coding] recovery probe unrecognized: {str(probe)[:200]}")
    return None


def _submit_and_poll(client, payload: dict) -> dict:
    """Submit one async coding turn and poll it to a terminal record.

    The turn_id is generated HERE and sent with the submit, making submission
    idempotent: if the submit's response is lost client-side (read timeout on a
    slow cold-clone setup) while the server accepted and started the turn, the
    re-submit with the same id is acknowledged as a dedupe instead of running
    the prompt a second time in the same workspace."""
    payload = {**payload, "turn_id": f"turn-{uuid.uuid4().hex}"}
    try:
        submitted = _coding_invoke(client, payload)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[remote-coding] submit response lost: {str(e)[:200]}")
        submitted = _recover_lost_submit(client, payload)
        if submitted is None:
            return {"error": "submit response lost and could not be safely "
                             "recovered (see logs)"}
    if submitted.get("error"):
        return submitted  # setup failure (bad repo, clone) — synchronous
    if not submitted.get("turn_id"):
        # Runtime predates async mode (or ran a legacy path) and executed the
        # turn synchronously — its result is already complete.
        return submitted
    return _poll_coding_turn(client, submitted["turn_id"])


def _remote_coding_turn(task: str, cli: str, repo: str = "", model: str = "") -> str:
    """Run one coding turn on the Cloud Code runtime. Returns the CLI's text
    response with a session footer, or an ERROR string (never raises).

    model: intelligence tier the persona chose ("fable"/"opus"/"sonnet"/"haiku"
    or a full Bedrock inference-profile id). Claude only — codex is pinned by
    the coding runtime. Empty = the runtime's default (Fable 5)."""
    if not _CODING_SESSION["session_id"]:
        _CODING_SESSION["session_id"] = f"cc-{uuid.uuid4().hex}"  # >=33 chars for AgentCore
    if repo and not _CODING_SESSION.get("repo"):
        _CODING_SESSION["repo"] = repo
    # Resume handle is per-CLI: a codex thread id means nothing to `claude
    # --resume` and vice versa (an agent may use both engines in one task).
    conversation_id = _CODING_SESSION["conversation_ids"].get(cli)

    tier = (model or "").strip().lower()
    resolved_model = CODING_MODEL_TIERS.get(tier) or (model.strip() if "." in (model or "") else "")

    payload = {
        "prompt": task,
        "cli": cli,
        "session_id": _CODING_SESSION["session_id"],
        "model": resolved_model if cli == "claude" else "",
        "origin": "workflow",  # coding runtime exempts human sessions from GC
    }
    if _CODING_SESSION.get("repo"):
        payload["repo"] = _CODING_SESSION["repo"]
    if conversation_id:
        payload["claude_session_id"] = conversation_id
    # Ported laptop session: tell the coding runtime to install the S3
    # transcript + check out the ported branch. Idempotent runtime-side
    # (.resume-installed marker), so forwarding on every turn is safe.
    if _CODING_SESSION.get("resume_transcript"):
        payload["resume_transcript"] = _CODING_SESSION["resume_transcript"]
        payload["resume_session_id"] = _CODING_SESSION.get("resume_session_id")
        if _CODING_SESSION.get("branch"):
            payload["branch"] = _CODING_SESSION["branch"]
        if _CODING_SESSION.get("git_mode"):
            payload["git_mode"] = _CODING_SESSION["git_mode"]
        if _CODING_SESSION.get("clone_url"):
            payload["clone_url"] = _CODING_SESSION["clone_url"]

    # Submit + poll instead of one long-lived call: ANY invocation whose
    # response goes quiet for ~15 min is killed silently by the platform, and
    # coding turns are routinely silent that long (builds, big writes) — both
    # the sync AND the SSE transport died this way (stuck-fleet postmortems
    # 2026-08-27 ×2). Submit returns a turn_id in seconds; the turn journals to
    # EFS; each poll is a fresh sub-second invocation. No connection lives long
    # enough to idle out, and a result written right before a microVM recycle
    # is still collected from the journal.
    payload["mode"] = "async"

    logger.info(
        f"[remote-coding] {cli} turn on {_CODING_SESSION['session_id']} "
        f"(resume={bool(conversation_id)}, repo={_CODING_SESSION.get('repo')}, mode=async)"
    )
    try:
        client = boto3.client(
            "bedrock-agentcore", region_name=REGION,
            config=BotocoreConfig(read_timeout=REMOTE_CODING_READ_TIMEOUT,
                                  retries={"max_attempts": 0}),
        )
        result = _submit_and_poll(client, payload)
        # A dead/vanished verdict means the microVM recycled mid-turn — the
        # workspace and transcript are on EFS, so one automatic resubmit (same
        # conversation id) is cheap and usually completes. A second death is a
        # real failure the persona should see.
        if result.get("retryable_vm_death"):
            logger.warning(f"[remote-coding] {result.get('error')} — resubmitting once")
            result = _submit_and_poll(client, payload)
            result.pop("retryable_vm_death", None)
    except Exception as e:  # noqa: BLE001
        # Do NOT fall back to a local CLI run: the session's workspace lives on
        # the coding runtime, and a local run would fork it (split-brain).
        logger.warning(f"[remote-coding] turn failed: {str(e)[:300]}")
        return (f"ERROR: remote {cli} turn failed: {str(e)[:300]}. "
                f"Retry this same {cli} call — the session workspace is preserved.")

    if result.get("error"):
        if result.get("no_retry_hint"):
            # The turn's work may already exist in the workspace — the error
            # text itself carries the verify-first instructions.
            return f"ERROR: remote {cli} turn: {result['error']}"
        return (f"ERROR: remote {cli} turn failed: {result['error']}. "
                f"Retry this same {cli} call — the session workspace is preserved.")

    if result.get("claude_session_id"):
        _CODING_SESSION["conversation_ids"][cli] = result["claude_session_id"]
    _record_coding_session(cli)

    footer = (f"\n\n[coding-session: {_CODING_SESSION['session_id']} cli={cli}"
              f" conversation={_CODING_SESSION['conversation_ids'].get(cli) or 'n/a'}]")
    # Deliverables the turn produced (mockups, screenshots, diagrams) are
    # harvested to S3 by the coding runtime — these keys are how you reach files
    # in the remote workspace: download_s3_file(key) → image_reader / file ops.
    if result.get("artifacts"):
        keys = "\n".join(f"  - {k}" for k in result["artifacts"])
        footer += f"\n[coding-artifacts — S3 keys, fetch with download_s3_file:\n{keys}\n]"
    return (result.get("response") or "").strip() + footer


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
def upload_file_to_s3(local_path: str, key: str, bucket: str = "", content_type: str = "") -> str:
    """Upload a LOCAL FILE of ANY media type (image, video, audio, PDF, zip, text)
    to S3, directly usable — this is the ONE tool to deliver binary artifacts.

    It handles everything for you: detects the MIME type from the extension,
    and picks the right transport by size (small files go base64 inline; large
    files stream over a presigned URL, bypassing the Lambda payload limit). Do
    NOT hand-roll base64 or write ".b64" sidecar files — just give the local
    path and the destination key.

    Args:
        local_path: Path to the file on the local filesystem (e.g. /tmp/thumb.png)
        key: Destination S3 object key (e.g. workflows/<wf>/shared/thumb.png)
        bucket: S3 bucket (defaults to the team artifact bucket)
        content_type: Optional MIME override; inferred from extension if omitted

    Returns:
        A confirmation string with the s3:// location and byte count.
    """
    import os, base64, mimetypes, json as _json
    if not os.path.exists(local_path):
        return f"ERROR: local file not found: {local_path}"
    ct = content_type or mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    size = os.path.getsize(local_path)
    tgt = bucket or ARTIFACT_BUCKET
    # base64 inflates ~33%; keep inline writes well under the 6MB Lambda-invoke
    # ceiling. Larger files go over a presigned PUT (no size limit).
    if size <= 3_500_000:
        with open(local_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___write_object", {
            "bucket": tgt, "key": key, "content": b64, "content_type": ct, "encoding": "base64"})
    resp = _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___presign_url", {
        "bucket": tgt, "key": key, "operation": "put", "content_type": ct})
    try:
        url = _json.loads(resp)["url"] if isinstance(resp, str) else resp["url"]
    except Exception:
        url = resp if isinstance(resp, str) and resp.startswith("http") else None
    if not url:
        return f"ERROR: could not obtain presigned URL: {resp}"
    # PUT the bytes to the presigned URL. boto3 is the only guaranteed dependency
    # (requirements.txt), so use urllib from the stdlib rather than httpx/requests
    # — no NameError if the optional client isn't installed in the image.
    import urllib.request
    with open(local_path, "rb") as f:
        req = urllib.request.Request(url, data=f.read(), method="PUT",
                                     headers={"Content-Type": ct})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            return f"ERROR: presigned PUT failed ({e.code}): {e.read().decode('utf-8', 'replace')[:300]}"
        except Exception as e:
            return f"ERROR: presigned PUT failed: {e}"
    if code not in (200, 201):
        return f"ERROR: presigned PUT failed ({code})"
    return f"Uploaded s3://{tgt}/{key} ({size} bytes, {ct}) via presigned URL."


@tool
def S3Storage___read_object(key: str, bucket: str = "", encoding: str = "text") -> str:
    """Read an object from S3. Text by default. For binary files (images, PDFs,
    audio, video) either set encoding="base64" to get the raw bytes back
    base64-encoded, or use download_s3_file to save it locally for image_reader.

    Args:
        key: Object key/path in the bucket
        bucket: S3 bucket name (defaults to the team artifact bucket)
        encoding: "text" (default) or "base64" for binary-safe reads
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___read_object",
        {"bucket": bucket or ARTIFACT_BUCKET, "key": key, "encoding": encoding})


@tool
def S3Storage___write_object(key: str, content: str, bucket: str = "", content_type: str = "text/plain", encoding: str = "text") -> str:
    """Write content to an S3 object. Handles both text and binary (images, PDFs, zips).

    For BINARY files (PNG/JPG/PDF/etc.): base64-encode the raw bytes, pass that
    string as `content`, set `encoding="base64"`, and set the real MIME type
    (e.g. content_type="image/png"). The bytes are decoded back to binary before
    storage, so the object is a real, directly-usable file — NOT a .b64 sidecar.
    Do NOT write raw binary as text; the string transport corrupts any byte > 0x7F.

    Args:
        key: Object key/path in the bucket
        content: Text content, OR base64 of the raw bytes when encoding="base64"
        bucket: S3 bucket name (defaults to the team artifact bucket)
        content_type: MIME type of the object (e.g. "image/png", "application/pdf")
        encoding: "text" (default) or "base64" for binary files
    """
    return _invoke_lambda(WORKFLOW_OUTPUT_LAMBDA, "S3Storage___write_object", {
        "bucket": bucket or ARTIFACT_BUCKET, "key": key, "content": content,
        "content_type": content_type, "encoding": encoding,
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
      - agentcore_hub_code_reviewer: "Review: [feature]" — blocked_by=ALL dev ticket IDs
      - agentcore_hub_qa_verifier: "QA: Verify [feature]" — blocked_by=code reviewer ticket ID
      - agentcore_hub_ci_agent: "CI: Validate build and tests for [feature]" — blocked_by=QA ticket ID

    Example complete ticket set for a frontend feature:
      1. create_ticket(assignee="agentcore_hub_frontend_designer", blocked_by="")
      2. create_ticket(assignee="agentcore_hub_frontend_dev", blocked_by="TEAM-101")
      3. create_ticket(assignee="agentcore_hub_code_reviewer", blocked_by="TEAM-102") ← ALWAYS
      4. create_ticket(assignee="agentcore_hub_qa_verifier", blocked_by="TEAM-103")   ← ALWAYS
      5. create_ticket(assignee="agentcore_hub_ci_agent", blocked_by="TEAM-104")      ← ALWAYS

    TICKET TYPE — pick by what the PARENT is (this is the #1 thing to get right):
      - Parent is an EPIC  → ticket_type="task"     (the DEFAULT — almost every run)
      - Parent is a BUG    → ticket_type="subtask"   (bug-fix runs ONLY)
    Every feature/marketing/legal/sales workflow is rooted on an Epic, so its
    phase tickets are ALWAYS "task". Only a bug-fix workflow is rooted on a Bug,
    and only then are its children "subtask". Jira REJECTS the wrong pairing
    (task→Bug and subtask→Epic both fail), which silently orphans the ticket and
    wedges the whole run. When unsure, the parent is an Epic → use "task".

    Args:
        title: Ticket title/summary
        description: Detailed description with requirements and acceptance criteria
        parent_id: Parent ticket key (e.g., "TEAM-1492"). Required for child tickets.
        assignee: Agent ID to assign to (e.g., agentcore_hub_frontend_dev, agentcore_hub_backend_dev, agentcore_hub_qa_verifier, agentcore_hub_ci_agent)
        ticket_type: "task" when the parent is an Epic (default, use this unless the
            parent is a Bug). "subtask" ONLY when the parent is a Bug. Also valid:
            "epic", "story". Do NOT use "subtask" under an Epic.
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


# ─── Connectors ──────────────────────────────────────────────────────────────
# A connector gives this agent external tools + credentials (Meta Ads, a private
# MCP server, a SigV4 gateway) that are bound to the persona in config/agents.json
# under `connectors: [ids]`. The registry (config/connectors.json in S3) holds only
# metadata + secret-key NAMES; the values live in Secrets Manager under
# connectors/<id> and are fetched HERE, with this runtime's own role — they never
# ride in the invoke payload, the orchestrator, or a trace. Resolution is by
# agent_id so it works identically for pipeline, chat, and direct invokes.
#
# Delivery by kind:
#   env     → export secret keys as environment variables (http_request/shell/
#             claude_code read them). The general REST-API path (Meta Graph, etc.).
#   mcp     → attach a streamable-HTTP MCP server, filling {KEY} placeholders in
#             the url/header templates from the secret.
#   gateway → attach a SigV4-signed AgentCore gateway (no secret; IAM is the cred).

def _load_connector_registry():
    """Read config/connectors.json from S3 fresh per invocation.

    Deliberately NOT cached across the microVM: a warm container is reused across
    sessions, and a connector created (or credentialed) between two invokes must be
    visible on the next one — same hot-reload contract as prompts/agents.json. It's
    one small S3 GET per run that uses connectors.
    """
    registry = {}
    if ARTIFACT_BUCKET:
        try:
            body = (
                boto3.client("s3", region_name=REGION)
                .get_object(Bucket=ARTIFACT_BUCKET, Key="config/connectors.json")["Body"]
                .read()
            )
            for c in (json.loads(body).get("connectors") or []):
                registry[c.get("id")] = c
        except Exception as e:
            logger.info(f"No connector registry loaded: {e}")
    return registry


def _roster_connector_ids(agent_id: str) -> list:
    """Connector ids bound to this agent in the agents.json roster."""
    if not ARTIFACT_BUCKET or not agent_id or agent_id == "unknown":
        return []
    try:
        body = (
            boto3.client("s3", region_name=REGION)
            .get_object(Bucket=ARTIFACT_BUCKET, Key="config/agents.json")["Body"]
            .read()
        )
        doc = json.loads(body)
        agents = doc if isinstance(doc, list) else doc.get("agents", [])
        entry = next((a for a in agents if a.get("agentId") == agent_id), None)
        return list(entry.get("connectors", [])) if entry else []
    except Exception as e:
        logger.info(f"[{agent_id}] connector lookup failed: {e}")
        return []


def _connector_ids_for_agent(agent_id: str, payload_connectors) -> list:
    """Resolve the connector ids to activate for this invoke.

    SECURITY: a per-invoke `payload_connectors` list may only NARROW the set of
    connectors already bound to this agent in the roster (agents.json) — it can
    never ADD one. This means an untrusted invoke payload (the workflow-start API
    is reachable behind the app's auth gate, but we defend in depth) cannot load
    an arbitrary connector's Secrets-Manager creds onto an agent that has shell/
    claude_code. If the payload names a connector the agent isn't bound to, it's
    dropped with a warning. No payload → use the full roster binding.
    """
    roster = _roster_connector_ids(agent_id)
    if not payload_connectors:
        return roster
    roster_set = set(roster)
    allowed, rejected = [], []
    for cid in payload_connectors:
        (allowed if cid in roster_set else rejected).append(cid)
    if rejected:
        logger.warning(
            f"[{agent_id}] ignoring payload connector(s) not bound to this agent: {rejected}"
        )
    return allowed


def _fetch_connector_secret(connector_id: str) -> dict:
    """Read connectors/<id> from Secrets Manager with this runtime's role."""
    try:
        sm = boto3.client("secretsmanager", region_name=REGION)
        resp = sm.get_secret_value(SecretId=f"connectors/{connector_id}")
        return json.loads(resp.get("SecretString") or "{}")
    except Exception as e:
        logger.warning(f"connector secret connectors/{connector_id} unavailable: {e}")
        return {}


# Env keys exported by the PREVIOUS invoke's connectors. A warm microVM is reused
# across invokes (different workflows, possibly untrusted repo code), so we MUST
# wipe a prior run's connector creds before the next agent runs — otherwise the
# next agent (with shell/claude_code) could read secrets it was never bound to.
_CONNECTOR_ENV_KEYS: set = set()


def _clear_prior_connector_env():
    """Remove env vars exported by the previous invoke's env-kind connectors."""
    global _CONNECTOR_ENV_KEYS
    for k in _CONNECTOR_ENV_KEYS:
        os.environ.pop(k, None)
    if _CONNECTOR_ENV_KEYS:
        logger.info(f"cleared {len(_CONNECTOR_ENV_KEYS)} connector env var(s) from prior invoke")
    _CONNECTOR_ENV_KEYS = set()


def _apply_connectors(agent_id: str, payload_connectors):
    """Resolve this agent's connectors. Exports env for kind=env and returns a
    list of extra MCP server dicts (kind=mcp) + gateway urls (kind=gateway) for
    _create_mcp_clients to attach.

    Always clears the prior invoke's connector env first (warm-microVM isolation).
    """
    global _CONNECTOR_ENV_KEYS
    _clear_prior_connector_env()

    ids = _connector_ids_for_agent(agent_id, payload_connectors)
    if not ids:
        return {"mcp_servers": [], "gateways": []}
    registry = _load_connector_registry()
    mcp_servers, gateways = [], []
    exported_keys = set()
    for cid in ids:
        conn = registry.get(cid)
        if not conn:
            logger.warning(f"[{agent_id}] connector '{cid}' not in registry — skipping")
            continue
        # Only load creds for a connector whose credential was actually entered.
        # A "needs_credentials" connector must not connect (its urlTemplate could
        # point anywhere and its secret is empty) — skip until a human activates it.
        if conn.get("status") == "needs_credentials":
            logger.warning(f"[{agent_id}] connector '{cid}' needs credentials — skipping")
            continue
        kind = conn.get("kind")
        secret = _fetch_connector_secret(cid) if kind in ("env", "mcp") else {}

        def _fill(s: str) -> str:
            for k, v in secret.items():
                s = s.replace("{" + k + "}", str(v))
            return s

        if kind == "env":
            for k, v in secret.items():
                os.environ[k] = str(v)
                exported_keys.add(k)
            logger.info(f"[{agent_id}] connector '{cid}' (env): {len(secret)} var(s) exported")
        elif kind == "mcp":
            url = _fill(conn.get("urlTemplate", ""))
            headers = {k: _fill(v) for k, v in (conn.get("headerTemplate") or {}).items()}
            if url:
                mcp_servers.append({"url": url, "headers": headers})
                # Log the TEMPLATE, never the filled url — query-param tokens must
                # not land in CloudWatch.
                logger.info(f"[{agent_id}] connector '{cid}' (mcp): {conn.get('urlTemplate', '')}")
        elif kind == "gateway":
            gw = conn.get("gatewayUrl", "")
            if gw:
                gateways.append(gw)
                logger.info(f"[{agent_id}] connector '{cid}' (gateway): {gw}")
    _CONNECTOR_ENV_KEYS = exported_keys
    return {"mcp_servers": mcp_servers, "gateways": gateways}


def _create_mcp_clients(extra_servers=None, extra_gateways=None):
    """Create MCPClient instances for each configured MCP server."""
    from strands.tools.mcp import MCPClient
    from mcp.client.streamable_http import streamablehttp_client

    servers = _parse_mcp_servers() + list(extra_servers or [])
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
    # The deploy-time iOS test gateway plus any connector gateways for this agent.
    gateway_urls = [IOS_TEST_GATEWAY_URL] if IOS_TEST_GATEWAY_URL else []
    gateway_urls += list(extra_gateways or [])
    for gw_url in gateway_urls:
        if not gw_url:
            continue
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
def claude_code(task: str, working_directory: str = "/tmp", repo: str = "", model: str = "", resume_session: str = "") -> str:
    """Delegate a coding task to Claude Code — a specialized AI coding agent.

    Claude Code excels at:
    - Cloning repos and understanding existing codebases (reads CLAUDE.md automatically)
    - Multi-file code implementation with proper imports and types
    - Running tests and iteratively fixing failures
    - Git operations (branch, commit, push)
    - Following project conventions from CLAUDE.md

    WHEN TO USE: Any time you need to write/edit code, run tests, or interact with a git repo.
    Let Claude Code handle the HOW while you handle the WHAT and WHY.

    All your claude_code calls in this task share ONE workspace and ONE
    conversation — a later call remembers the earlier calls and their files.
    Do NOT reference absolute paths like /tmp/... across calls; say "in the
    same workspace as the previous call" instead.

    The workspace is REMOTE — you cannot file_read/image_reader its files
    directly. Files it produces (screenshots, mockups, diagrams) are harvested
    to S3 and listed in a [coding-artifacts: ...] footer on the result; fetch
    them with download_s3_file(key), then image_reader / upload_file_to_s3.

    Args:
        task: Complete description of what to implement. Include:
              - Repo URL and branch name
              - What to build (specific files, endpoints, features)
              - Acceptance criteria (what success looks like)
              - Any constraints (don't modify X, use library Y)
        working_directory: Directory to operate in (default: /tmp; ignored when
              the coding runtime hosts the session)
        repo: Repository as owner/name or clone URL. Pass on your FIRST call so
              the workspace is cloned; later calls reuse it automatically.
        model: Intelligence tier for THIS delegation — "fable" (default; top
              reasoning), "opus" (deep/complex implementation), "sonnet"
              (routine coding, faster/cheaper), "haiku" (trivial mechanical
              edits). YOU decide per call: match the tier to the difficulty of
              the task. Leave empty for the default.
        resume_session: A PRIOR task's coding-session id (the "cc-..." value
              from a [coding-session: ...] footer in your ticket history) to
              continue that conversation instead of starting fresh. Use on
              REWORK — when a reviewer rejected your recent work and you are
              revising it: the session already holds the repo, your changes,
              and your reasoning, so revision is faster and better informed.
              Start fresh (leave empty) when the task differs from the prior
              one, the feedback says start over, or a resumed session errors —
              resume is best-effort and falls back to a fresh workspace.
              Only honored on your FIRST coding call of this task.
    """
    import subprocess
    import shutil

    if _remote_coding_enabled():
        _maybe_resume_session(resume_session)
        return _remote_coding_turn(task, "claude", repo, model)

    task = _localize_repo_task(task, repo, working_directory)
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
    cc_model = (
        CODING_MODEL_TIERS.get((model or "").strip().lower())
        or os.environ.get("ANTHROPIC_MODEL")
        or os.environ.get("CLAUDE_MODEL")
        or "us.anthropic.claude-fable-5"
    )

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
def codex(task: str, working_directory: str = "/tmp", repo: str = "", resume_session: str = "") -> str:
    """Delegate a coding task to OpenAI Codex (GPT-5.5 via Amazon Bedrock).

    A peer to claude_code — same contract, different engine. Useful for a second
    opinion, code review, or when you want GPT-5.5 to implement/verify. No OpenAI
    key required; inference routes through Amazon Bedrock using the runtime role.

    All your codex calls in this task share ONE workspace and ONE conversation —
    a later call remembers the earlier calls and their files. Do NOT reference
    absolute paths like /tmp/... across calls.

    The workspace is REMOTE — you cannot file_read/image_reader its files
    directly. Files it produces are harvested to S3 and listed in a
    [coding-artifacts: ...] footer on the result; fetch with download_s3_file(key).

    Args:
        task: Complete description of what to do (repo URL/branch, what to build
              or review, acceptance criteria, constraints).
        working_directory: Directory to operate in (default: /tmp; ignored when
              the coding runtime hosts the session)
        repo: Repository as owner/name or clone URL. Pass on your FIRST call so
              the workspace is cloned; later calls reuse it automatically.
        resume_session: A PRIOR task's coding-session id ("cc-..." from a
              [coding-session: ...] footer in your ticket history) to continue
              that conversation on rework instead of rebuilding context. Leave
              empty for a fresh session; best-effort. Only honored on your
              FIRST coding call of this task.
    """
    import subprocess
    import shutil

    if _remote_coding_enabled():
        _maybe_resume_session(resume_session)
        return _remote_coding_turn(task, "codex", repo)

    task = _localize_repo_task(task, repo, working_directory)
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
    # Upload any-media-type local file to S3 (the one binary-delivery tool)
    upload_file_to_s3,
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


def _publish_operator_delivery(workflow_id: str, agent_id: str, message: str):
    """Surface a consumed operator message in the agent's output stream so the
    UI shows the hand-off (rides the same agent.streaming path as model text)."""
    import time, random, string
    try:
        event_id = f"{int(time.time() * 1000)}-opmsg-{''.join(random.choices(string.ascii_lowercase, k=4))}"
        _ddb_events_client.put_item(
            TableName=_EVENTS_TABLE,
            Item={
                "workflowId": {"S": workflow_id},
                "eventId": {"S": event_id},
                "type": {"S": "agent.streaming"},
                "detail": {"M": {
                    "agentId": {"S": agent_id},
                    "type": {"S": "text"},
                    "content": {"S": f"\n\n> 📨 **Operator:** {message}\n\n"},
                    "workflowId": {"S": workflow_id},
                }},
                "timestamp": {"S": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            },
        )
    except Exception as e:
        logger.warning(f"[{agent_id}] Failed to publish operator delivery: {e}")


class _OperatorMailbox:
    """Mid-flow operator messaging (Claude Code-style queued messages).

    The UI queues a message via POST /api/workflow/{id}/message, which writes a
    mailbox item to the events table under eventId "0#mailbox#<agentId>#<id>".
    This hook checks the mailbox after each tool call and appends any pending
    messages to that tool's result, so the model reads them on its very next
    reasoning step — no interruption, no restart. Consumption is an atomic
    DeleteItem, so a zombie duplicate of a retried agent can't double-deliver.

    Best-effort by design: mailbox failures must never break a run. Messages
    left unconsumed (agent finished first) are invisible to the UI and get
    picked up by a retry of the same agent, which is the desired behavior.

    Every tool boundary checks the mailbox — deliberately unthrottled. Any
    boundary can be the run's LAST one, and skipping it would strand a message
    the UI already reported as delivered-on-next-tool-call. One Query per tool
    call is noise next to the model call that follows it.
    """

    def __init__(self, workflow_id: str, agent_id: str):
        self._wf = workflow_id
        self._agent = agent_id
        self._prefix = f"0#mailbox#{agent_id}#"

    def register_hooks(self, registry, **kwargs):
        from strands.hooks import AfterToolCallEvent
        registry.add_callback(AfterToolCallEvent, self._on_tool_result)

    def _consume_pending(self) -> list:
        resp = _ddb_events_client.query(
            TableName=_EVENTS_TABLE,
            KeyConditionExpression="workflowId = :wid AND begins_with(eventId, :pfx)",
            ExpressionAttributeValues={
                ":wid": {"S": self._wf},
                ":pfx": {"S": self._prefix},
            },
            Limit=10,
        )
        messages = []
        for item in resp.get("Items", []):
            deleted = _ddb_events_client.delete_item(
                TableName=_EVENTS_TABLE,
                Key={"workflowId": item["workflowId"], "eventId": item["eventId"]},
                ReturnValues="ALL_OLD",
            )
            attrs = deleted.get("Attributes") or {}
            text = attrs.get("detail", {}).get("M", {}).get("message", {}).get("S", "")
            if text:
                messages.append(text)
        return messages

    def _on_tool_result(self, event):
        if not self._wf or self._wf == "unknown":
            return
        # Only inject into a well-formed ToolResult — if the tool raised, skip
        # (nothing consumed; the message waits for the next tool boundary).
        result = getattr(event, "result", None)
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            return
        try:
            messages = self._consume_pending()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{self._agent}] mailbox check failed (non-fatal): {e}")
            return
        if not messages:
            return
        joined = "\n".join(f"- {m}" for m in messages)
        result["content"].append({"text": (
            "\n\n[OPERATOR MESSAGE — the human operator watching this run just "
            "sent you the following. Read it now, acknowledge it in your next "
            f"output, and adjust your work accordingly before continuing:\n{joined}\n]"
        )})
        logger.info(f"[{self._agent}] delivered {len(messages)} operator message(s) mid-flow")
        for m in messages:
            _publish_operator_delivery(self._wf, self._agent, m)


def _save_memory_event(agent_id: str, session_id: str, user_text: str, assistant_text: str):
    """Persist the invocation turn to AgentCore Memory (no-op if MEMORY_ID unset).

    Actor = agent_id so the dashboard's memory browser groups history per persona
    in shared-runtime topologies. Best-effort: memory must never fail a run.
    """
    if not MEMORY_ID or not session_id:
        return
    try:
        payload = [
            {"conversational": {"role": "USER", "content": {"text": user_text[:9000]}}},
        ]
        if assistant_text:
            payload.append(
                {"conversational": {"role": "ASSISTANT", "content": {"text": assistant_text[:9000]}}}
            )
        boto3.client("bedrock-agentcore", region_name=REGION).create_event(
            memoryId=MEMORY_ID,
            actorId=agent_id or "unknown",
            sessionId=session_id,
            eventTimestamp=datetime.now(timezone.utc),
            payload=payload,
        )
        logger.info(f"[{agent_id}] Saved memory event to {MEMORY_ID} (session {session_id})")
    except Exception as e:
        logger.warning(f"[{agent_id}] Failed to save memory event: {e}")


# --- App entrypoint (streaming enabled) ---
app = BedrockAgentCoreApp()

# Strong refs to detached persona runs — the asyncio event loop only weak-refs
# its tasks, so without this a suspended run can be GC'd mid-await.
_DETACHED_TASKS: set = set()


@app.entrypoint
async def agent_invocation(payload, context):
    """Route an invocation: workflow runs detach to a background task, chat runs
    stay synchronous.

    WHY DETACH: the platform silently kills ANY invocation whose response stream
    is idle ~15 min — and this entrypoint yields nothing until the agent loop
    finishes. Workflow personas are invoked fire-and-forget (agent-invoker
    destroys the connection without reading), so for them the open invocation
    buys nothing and costs everything: every persona run longer than ~16 min
    died mid-flight (2026-08-27 stuck fleet, all 19 re-kicked personas dead at
    exactly 16.5 min). Workflow runs therefore ack immediately and do the real
    work in an asyncio task registered via add_async_task — ping reports
    HealthyBusy so the microVM isn't reaped, progress/results flow through
    DynamoDB events + report_completion exactly as before, and no connection
    exists for the idle kill to take.

    Detachment is OPT-IN via payload {"detach": true} — only the orchestrator's
    agent-invoker sends it. Anything that reads the response synchronously
    (chat, verify-fleet-invoke.py healthchecks, ad-hoc invokes) keeps the
    streaming path by default."""
    workflow_id = payload.get("workflow_id", "unknown")
    agent_id = payload.get("agent_id", "unknown")

    if payload.get("detach") and workflow_id and workflow_id != "unknown":
        import asyncio

        task_id = app.add_async_task(
            "persona_run", {"workflow_id": workflow_id, "agent_id": agent_id}
        )

        async def _run_detached():
            try:
                async for _ in _run_agent_invocation(payload, context):
                    pass  # events already flow to DDB inside the loop
            except Exception as exc:  # noqa: BLE001 — must never die silently
                logger.error(f"[{agent_id}] detached run failed: {str(exc)[:500]}")
                try:
                    _publish_agent_error(workflow_id, agent_id, str(exc)[:500])
                except Exception:  # noqa: BLE001
                    pass
            finally:
                app.complete_async_task(task_id)
                _DETACHED_TASKS.discard(asyncio.current_task())

        # The event loop holds only weak refs to tasks; without a strong ref a
        # suspended persona (awaiting a model/tool call) can be garbage
        # collected mid-run. Pin it until its own finally removes it.
        _DETACHED_TASKS.add(asyncio.get_event_loop().create_task(_run_detached()))
        logger.info(f"[{agent_id}] accepted for workflow {workflow_id} — detached "
                    f"as async task {task_id}")
        yield {"event": {"contentBlockDelta": {"delta": {"text": (
            f"[accepted: {agent_id} running detached for {workflow_id}]"
        )}}}}
        return

    async for event in _run_agent_invocation(payload, context):
        yield event


def _publish_agent_error(workflow_id: str, agent_id: str, error: str) -> None:
    """Surface a detached-run crash to the events table so the workflow board
    and nudge system can see it (a detached task has no caller to error to)."""
    import time as _t
    # Random suffix on both keys: two personas failing in the same millisecond
    # (shared-outage case) must not overwrite each other's error item. The
    # timestamp's fractional part must stay NUMERIC — workflow-analyzer
    # Date.parse()s it, so hex there would poison lastSignificantEventAge().
    digits = f"{uuid.uuid4().int % 10**6:06d}"
    _ddb_events_client.put_item(
        TableName=_EVENTS_TABLE,
        Item={
            "workflowId": {"S": workflow_id},
            "eventId": {"S": f"{int(_t.time() * 1000)}-err-{digits}"},
            "type": {"S": "agent.error"},
            "detail": {"M": {"agentId": {"S": agent_id}, "error": {"S": error}}},
            "timestamp": {"S": _t.strftime("%Y-%m-%dT%H:%M:%S", _t.gmtime())
                          + f".{digits}Z"},
        },
    )


async def _run_agent_invocation(payload, context):
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
    global _CURRENT_WORKFLOW_ID, _CURRENT_AGENT_ID, _CURRENT_TICKET_ID
    prompt = payload.get("prompt", "")
    workflow_id = payload.get("workflow_id", "unknown")
    agent_id = payload.get("agent_id", "unknown")
    model_override = payload.get("model_override")
    # Optional per-invoke connector override; otherwise resolved from agents.json.
    payload_connectors = payload.get("connectors")
    _CURRENT_WORKFLOW_ID = workflow_id
    _CURRENT_AGENT_ID = agent_id
    _CURRENT_TICKET_ID = payload.get("ticket_id", "")
    # Fresh coding session per agent-task: a warm microVM reuses this module, so
    # without a reset the next task would resume the PREVIOUS task's workspace.
    _CODING_SESSION.update(
        {"session_id": None, "conversation_ids": {}, "repo": None, "recorded": False,
         "resume_transcript": None, "resume_session_id": None, "branch": None,
         "git_mode": None, "clone_url": None}
    )

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
            max_tokens=MAX_OUTPUT_TOKENS,
        )
        # NOTE: the persona's board model governs its own reasoning only. The
        # coding CLI's model is chosen per-delegation via claude_code(model=...)
        # or falls back to the coding runtime's CLAUDE_MODEL default.
        logger.info(f"[{agent_id}] Model override: {model_override} → {resolved_model_id}")

    # Load built-in tools (lazy — avoids 30s init timeout)
    builtin_tools = _load_builtin_tools()
    all_tools = builtin_tools + LAMBDA_TOOLS + [claude_code, codex]

    # Connectors bound to this agent: export env creds + collect MCP/gateway targets.
    conn = _apply_connectors(agent_id, payload_connectors)

    # External tools via MCP (GitHub, GitLab, Jira, Asana, etc.) + connectors.
    # Strands Agent manages MCPClient lifecycle internally (start/stop)
    mcp_clients = _create_mcp_clients(
        extra_servers=conn["mcp_servers"], extra_gateways=conn["gateways"]
    )
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

    _session_id = getattr(context, "session_id", None)
    _trace_attributes = {
        "agent.id": agent_id,
        "gen_ai.agent.id": agent_id,
        "workflow.id": workflow_id,
    }
    if _session_id:
        _trace_attributes["session.id"] = _session_id
    if _CURRENT_TICKET_ID:
        _trace_attributes["ticket.id"] = _CURRENT_TICKET_ID

    agent = Agent(
        model=active_model,
        system_prompt=persona_prompt,
        tools=all_tools,
        callback_handler=None,
        hooks=[_OperatorMailbox(workflow_id, agent_id)],
        name=agent_id,
        trace_attributes=_trace_attributes,
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

    # Persist this turn to AgentCore Memory (no-op without MEMORY_ID env var)
    _save_memory_event(agent_id, getattr(context, "session_id", None), prompt, final_text)

    # Emit tool_use events FIRST so the agent-invoker can publish them for real-time UI flashing.
    for tool_name in tool_events:
        yield {"event": {"contentBlockStart": {"start": {"toolUse": {"name": tool_name}}}}}

    # Then emit the final text as a single contentBlockDelta event
    yield {"event": {"contentBlockDelta": {"delta": {"text": final_text}}}}


if __name__ == "__main__":
    app.run()
