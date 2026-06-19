"""
Amazon Bedrock AgentCore Runtime — resumable coding agent server.

Hosts Claude Code (and Codex) behind the AgentCore `/invocations` data-plane
contract. This is the official "safe to close your laptop" pattern from
awslabs/agentcore-samples (04-coding-agents/01-claude-code-with-s3-files): the
CLI runs server-side in a per-session microVM, the workspace persists on session
storage at /mnt/workspace, and a conversation is resumed by invoking again with
the SAME runtimeSessionId.

Interaction loop (per turn):
  client → invoke_agent_runtime(runtimeSessionId, {prompt, repo?, cli?, claude_session_id?})
         → this server runs the CLI in /mnt/workspace/<repo-slug>
         → returns {response, claude_session_id, workspace, cli}
  resume → same runtimeSessionId (→ same microVM, warm /mnt/workspace)
           + pass back claude_session_id → claude --resume <id>

Two endpoints:
  - GET  /ping, /health  — AgentCore lifecycle. HealthyBusy while a CLI runs so
    the session is not reaped mid-turn; the time_of_last_update field is REQUIRED.
  - POST /invocations     — run one coding turn and return the result.

The OTel collector sidecar (otel-collector-config.yaml) forwards each CLI's
telemetry to CloudWatch (aws/spans) so every tool call is a trace.
"""

import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import time
import zipfile

import boto3
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from log import get_logger, redact

logger = get_logger("coding-agent-runtime")

# Workspace lives on the EFS mount (/mnt/efs) — elastic + POSIX + persists across
# cold microVMs, so repo clones + node_modules don't hit the ~1 GB sessionStorage
# cap (ENOSPC) and survive for true warm resume. deploy.py sets WORKSPACE_ROOT.
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/mnt/efs")
DEFAULT_CLI = "claude"
CLAUDE_MODEL = os.environ.get("ANTHROPIC_MODEL") or os.environ.get(
    "CLAUDE_MODEL", "us.anthropic.claude-opus-4-6-v1"
)
# A single coding turn can be long; cap so a wedged CLI can't pin the microVM.
TURN_TIMEOUT_S = int(os.environ.get("TURN_TIMEOUT_S", "1500"))

# Per-user coding-CLI config bundle (MCP servers, skills, custom agents, prefs).
# The app uploads a zip to s3://{ARTIFACT_BUCKET}/cloud-code/configs/{userId}/
# {version}.zip; we materialize it into the CLI config dirs on session start.
ARTIFACT_BUCKET = os.environ.get("ARTIFACT_BUCKET", "")
CLAUDE_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.join(WORKSPACE_ROOT, ".codex"))
# Marker so we only materialize a given (user, version) once per warm microVM.
_CONFIG_MARKER = os.path.join(WORKSPACE_ROOT, ".config-applied")
BEDROCK_MANTLE_REGION = os.environ.get("BEDROCK_MANTLE_REGION", "us-east-2")
CODEX_MODEL = os.environ.get("CODEX_MODEL", "openai.gpt-5.5")

_CODING_PROC_NAMES = ("claude", "codex", "node")
COLLECTOR_BIN = "/usr/bin/otelcol-contrib"
COLLECTOR_CFG = "/app/otel-collector-config.yaml"

# Claude Code scopes a conversation to the directory it ran in. On resume the
# caller passes claude_session_id but may not re-send the repo, so we persist a
# {claude_session_id → repo} map on session storage and recover the cwd from it.
SESSION_MAP = os.path.join(WORKSPACE_ROOT, ".sessions.json")


def _load_session_map() -> dict:
    try:
        with open(SESSION_MAP) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _remember_session(claude_session_id: str | None, repo: str | None) -> None:
    if not claude_session_id:
        return
    os.makedirs(WORKSPACE_ROOT, exist_ok=True)
    m = _load_session_map()
    m[claude_session_id] = {"repo": repo}
    try:
        with open(SESSION_MAP, "w") as f:
            json.dump(m, f)
    except OSError as exc:
        logger.warning("session_map_write_failed", extra={"error": str(exc)[:200]})


# ─── Default MCP gateway ──────────────────────────────────────────────────────

# AgentCore Gateway exposing shared MCP tools (Jira, S3, SkillLoader). Wired as
# a default MCP server so every session gets these tools with zero config; a
# user-uploaded config bundle merges its own servers on top. Set DISABLE_DEFAULT_MCP=1
# to skip. Auth is currently NONE on the gateway (internal); revisit before
# multi-user/public (would add an Authorization header here).
MCP_GATEWAY_URL = os.environ.get("MCP_GATEWAY_URL", "")
MCP_GATEWAY_NAME = os.environ.get("MCP_GATEWAY_NAME", "agentis_gateway")


def _apply_default_mcp() -> None:
    """Write the gateway as a default MCP server for both CLIs, without
    clobbering a user's own MCP entries.

    - Claude Code: a streamable-HTTP server in {CLAUDE_CONFIG_DIR}/.mcp.json
      under key MCP_GATEWAY_NAME (we own that key; user keys are preserved).
    - Codex: a [mcp_servers.<name>] table appended to config.toml only if absent
      (merge-codex-config already guards our provider block)."""
    if not MCP_GATEWAY_URL or os.environ.get("DISABLE_DEFAULT_MCP") == "1":
        return

    # Claude — .mcp.json (merge: keep user servers, set/overwrite only ours).
    try:
        os.makedirs(CLAUDE_CONFIG_DIR, exist_ok=True)
        mcp_path = os.path.join(CLAUDE_CONFIG_DIR, ".mcp.json")
        try:
            with open(mcp_path) as f:
                doc = json.load(f)
        except (OSError, json.JSONDecodeError):
            doc = {}
        servers = doc.get("mcpServers") or {}
        servers[MCP_GATEWAY_NAME] = {"type": "http", "url": MCP_GATEWAY_URL}
        doc["mcpServers"] = servers
        with open(mcp_path, "w") as f:
            json.dump(doc, f, indent=2)
    except OSError as exc:
        logger.warning("default_mcp_claude_failed", extra={"error": str(exc)[:200]})

    # Codex — append [mcp_servers.<name>] if not already present.
    try:
        os.makedirs(CODEX_HOME, exist_ok=True)
        toml_path = os.path.join(CODEX_HOME, "config.toml")
        existing = ""
        if os.path.exists(toml_path):
            with open(toml_path) as f:
                existing = f.read()
        if f"[mcp_servers.{MCP_GATEWAY_NAME}]" not in existing:
            block = (
                f'\n[mcp_servers.{MCP_GATEWAY_NAME}]\n'
                f'url = "{MCP_GATEWAY_URL}"\n'
            )
            with open(toml_path, "a") as f:
                f.write(block)
    except OSError as exc:
        logger.warning("default_mcp_codex_failed", extra={"error": str(exc)[:200]})

    logger.info("default_mcp_applied", extra={"gateway": MCP_GATEWAY_NAME})


# ─── Per-user config bundle ───────────────────────────────────────────────────


def _apply_config_bundle(user_id: str | None, version: str | None) -> None:
    """Materialize a user's coding-CLI config bundle into the CLI config dirs.

    The bundle is a zip at s3://{ARTIFACT_BUCKET}/cloud-code/configs/{userId}/{version}.zip
    laid out as `claude/...` (→ CLAUDE_CONFIG_DIR) and `codex/...` (→ CODEX_HOME).
    Idempotent per warm microVM via a marker file. The user's files land first;
    run-codex.sh / the launchers then re-assert our Bedrock provider on top, so a
    user config can add MCP/skills/agents but never break model access.
    """
    if not (user_id and version and ARTIFACT_BUCKET):
        return
    token = f"{user_id}:{version}"
    try:
        with open(_CONFIG_MARKER) as f:
            if f.read().strip() == token:
                return  # already applied to this warm VM
    except OSError:
        pass

    key = f"cloud-code/configs/{user_id}/{version}.zip"
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001 — missing/forbidden bundle is non-fatal
        logger.warning("config_bundle_fetch_failed", extra={"key": key, "error": str(exc)[:200]})
        return

    dests = {"claude": CLAUDE_CONFIG_DIR, "codex": CODEX_HOME}
    for d in dests.values():
        os.makedirs(d, exist_ok=True)
    applied = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for member in zf.namelist():
                if member.endswith("/"):
                    continue
                top, _, rel = member.partition("/")
                dest_root = dests.get(top)
                if not dest_root or not rel:
                    continue  # ignore anything outside claude/ or codex/
                # Path-traversal guard.
                target = os.path.normpath(os.path.join(dest_root, rel))
                if not target.startswith(os.path.normpath(dest_root) + os.sep):
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
                applied += 1
    except zipfile.BadZipFile:
        logger.warning("config_bundle_bad_zip", extra={"key": key})
        return

    try:
        with open(_CONFIG_MARKER, "w") as f:
            f.write(token)
    except OSError:
        pass
    logger.info("config_bundle_applied", extra={"user": user_id, "version": version, "files": applied})


# ─── OTel collector sidecar ───────────────────────────────────────────────────


def _wire_log_headers() -> None:
    raw = os.environ.get("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "")
    for kv in raw.split(","):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        if k.strip() == "x-aws-log-group":
            os.environ["AWS_OTEL_LOG_GROUP"] = v.strip()
        elif k.strip() == "x-aws-log-stream":
            os.environ["AWS_OTEL_LOG_STREAM"] = v.strip()


def _wait_for_collector(host: str = "127.0.0.1", port: int = 4318, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _bootstrap_collector() -> None:
    if not (os.path.exists(COLLECTOR_BIN) and os.path.exists(COLLECTOR_CFG)):
        logger.warning("otel_collector_unavailable")
        return
    _wire_log_headers()
    logger.info("otel_collector_starting", extra={"config": COLLECTOR_CFG})
    proc = subprocess.Popen(
        [COLLECTOR_BIN, "--config", COLLECTOR_CFG],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if _wait_for_collector():
        logger.info("otel_collector_ready")
    elif proc.poll() is not None:
        out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
        logger.error("otel_collector_exited", extra={"rc": proc.returncode, "head": out[:1500]})


# ─── Workspace + git ──────────────────────────────────────────────────────────


def _slugify_repo(repo: str) -> str:
    """owner/name or a URL → a stable, filesystem-safe per-repo slug."""
    s = repo.strip()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^git@", "", s)
    s = re.sub(r"\.git$", "", s)
    s = s.replace(":", "/")
    # Keep the last two path components (owner/name) when present.
    tail = [p for p in s.split("/") if p][-2:]
    slug = "-".join(tail) if tail else "default"
    return re.sub(r"[^A-Za-z0-9._-]", "-", slug) or "default"


def _configure_git() -> None:
    # Session storage mounts under a uid that may differ from the runtime user,
    # so Git refuses to operate ("dubious ownership"). Trust the workspace tree.
    subprocess.run(
        ["git", "config", "--global", "--replace-all",
         "safe.directory", WORKSPACE_ROOT],
        check=False,
    )
    subprocess.run(
        ["git", "config", "--global", "--add", "safe.directory", "*"],
        check=False,
    )
    pat = os.environ.get("GITHUB_PAT")
    if not pat:
        return
    subprocess.run(
        ["git", "config", "--global",
         f"url.https://x-access-token:{pat}@github.com/.insteadOf",
         "https://github.com/"],
        check=False,
    )
    subprocess.run(["git", "config", "--global", "user.email",
                    os.environ.get("GIT_AUTHOR_EMAIL", "agent@agentcore-hub.example.com")], check=False)
    subprocess.run(["git", "config", "--global", "user.name",
                    os.environ.get("GIT_AUTHOR_NAME", "AgentCore Hub Agent")], check=False)
    # Expose the PAT to the GitHub CLI so the agent can enumerate/inspect repos
    # (e.g. `gh repo list`, `gh api`) — not just clone a known URL.
    os.environ.setdefault("GH_TOKEN", pat)
    os.environ.setdefault("GITHUB_TOKEN", pat)


def _valid_repo(repo: str) -> bool:
    """A clonable target: a full URL, or owner/name (>= 2 path segments).
    A bare owner like 'tycenjmccann' is NOT clonable — reject it early so we
    return a clean error instead of a 404 git clone."""
    r = repo.strip()
    if r.startswith(("http://", "https://", "git@")):
        return True
    return len([p for p in r.split("/") if p]) >= 2


def _session_dir(session_id: str | None) -> str:
    """Per-session root under the workspace. Each session gets an isolated
    checkout so two sessions on the same repo can't clobber each other's branch
    or edits. Falls back to a shared 'default' dir when no session id is given."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", (session_id or "default"))[:80]
    return os.path.join(WORKSPACE_ROOT, "sessions", safe)


def _ensure_workspace(repo: str | None, session_id: str | None = None) -> str:
    """Return the working dir for this session. If repo given and not yet cloned,
    clone it under the session's own dir (on EFS, so a re-invoke with the same
    runtimeSessionId finds it warm — no re-clone)."""
    base = _session_dir(session_id)
    if not repo:
        os.makedirs(base, exist_ok=True)
        return base
    if not _valid_repo(repo):
        raise ValueError(
            f"'{repo}' is not a valid repository. Use 'owner/name' or a full "
            f"clone URL. (A bare owner can't be cloned — leave repo empty and "
            f"ask the agent to 'gh repo list {repo}' instead.)"
        )
    slug = _slugify_repo(repo)
    wd = os.path.join(base, slug)
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("workspace_warm", extra={"slug": slug})
        return wd
    os.makedirs(base, exist_ok=True)
    clone_url = repo if repo.startswith(("http://", "https://", "git@")) else f"https://github.com/{repo}.git"
    logger.info("workspace_cloning", extra={"slug": slug, "url": clone_url.split("@")[-1]})
    res = subprocess.run(["git", "clone", clone_url, wd], capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise RuntimeError(f"git clone failed: {res.stderr.strip()[:400]}")
    return wd


# ─── CLI runners ──────────────────────────────────────────────────────────────


def _run_claude(prompt: str, workdir: str, claude_session_id: str | None) -> dict:
    """Run one Claude Code turn. Resume the conversation when a prior
    claude_session_id is supplied (same microVM keeps its ~/.claude state)."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)

    # `claude --print` does NOT auto-load a project .mcp.json (needs interactive
    # approval). _build_claude_args passes --mcp-config explicitly; it's variadic,
    # so the positional prompt must come last (appended here).
    args = _build_claude_args(config_dir, claude_session_id, stream=False) + [prompt]
    env = {**os.environ, "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CONFIG_DIR": config_dir}

    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    try:
        parsed = json.loads(proc.stdout)
        return {"response": parsed.get("result", proc.stdout.strip()),
                "claude_session_id": parsed.get("session_id")}
    except json.JSONDecodeError:
        return {"response": proc.stdout.strip(), "claude_session_id": None}


def _build_claude_args(config_dir: str, claude_session_id: str | None, stream: bool) -> list:
    """Shared argv for a Claude turn. stream=True emits realtime stream-json."""
    args = ["claude", "--print"]
    mcp_config = os.path.join(config_dir, ".mcp.json")
    if os.path.isfile(mcp_config):
        args += ["--mcp-config", mcp_config]
    args += ["--dangerously-skip-permissions",
             "--model", CLAUDE_MODEL, "--max-turns", os.environ.get("MAX_TURNS", "100")]
    if stream:
        # --include-partial-messages emits token-level content_block_delta frames
        # (without it, claude sends whole message blocks → one chunk at the end).
        args += ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    else:
        args += ["--output-format", "json"]
    if claude_session_id:
        args += ["--resume", claude_session_id]
    return args


def _stream_claude(prompt: str, workdir: str, claude_session_id: str | None, repo: str | None = None):
    """Generator yielding SSE lines for a Claude turn as it runs.

    Parses claude stream-json line-by-line: assistant text deltas → 'text'
    events, the final 'result' → a terminal 'done' event carrying the full text
    and the claude session id (for resume). The UI renders text incrementally.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)
    args = _build_claude_args(config_dir, claude_session_id, stream=True) + [prompt]
    env = {**os.environ, "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CONFIG_DIR": config_dir}

    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    proc = subprocess.Popen(args, cwd=workdir, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL, bufsize=1)
    new_session_id: str | None = claude_session_id
    full_text: list[str] = []
    try:
        for line in proc.stdout:  # line-buffered: yields as claude emits
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "system" and obj.get("subtype") == "init" and obj.get("session_id"):
                new_session_id = obj["session_id"]
            elif t == "stream_event":
                ev = obj.get("event", {})
                if ev.get("type") == "content_block_delta":
                    delta = ev.get("delta", {})
                    txt = delta.get("text")  # ignore thinking deltas
                    if txt:
                        full_text.append(txt)
                        yield sse({"type": "text", "text": txt})
            elif t == "result":
                if not full_text and isinstance(obj.get("result"), str):
                    full_text.append(obj["result"])
                    yield sse({"type": "text", "text": obj["result"]})
                if obj.get("session_id"):
                    new_session_id = obj["session_id"]
        proc.wait(timeout=30)
    except Exception as exc:  # noqa: BLE001
        yield sse({"type": "error", "error": str(exc)[:600]})
        return
    if proc.returncode not in (0, None):
        err = (proc.stderr.read() or "")[:600] if proc.stderr else ""
        yield sse({"type": "error", "error": f"claude exited {proc.returncode}: {err}"})
        return
    # Persist {claude_session_id → repo} so a later resume recovers the cwd.
    _remember_session(new_session_id, repo)
    yield sse({"type": "done", "response": "".join(full_text), "claude_session_id": new_session_id})


def _run_codex(prompt: str, workdir: str, codex_session_id: str | None) -> dict:
    """Run one Codex turn via the Mantle launcher (GPT-5.5). Resumes the prior
    conversation when codex_session_id (a codex thread_id) is supplied.

    We surface codex's thread_id through the same `claude_session_id` field the
    server returns, so the caller's resume handle is CLI-agnostic."""
    env = {**os.environ, "WORKSPACE_DIR": workdir}
    args = ["/app/run-codex.sh", prompt]
    if codex_session_id:
        args.append(codex_session_id)
    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"codex exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    # codex exec --json emits JSONL. Pull the thread_id (resume handle) and the
    # final assistant text. New shape:
    #   {"type":"thread.started","thread_id":"..."}
    #   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    # Older builds: {"msg":{"type":"agent_message","message":"..."}}.
    text = proc.stdout.strip()
    thread_id: str | None = codex_session_id
    found_text = False
    for line in proc.stdout.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "thread.started" and obj.get("thread_id"):
            thread_id = obj["thread_id"]
        item = obj.get("item") or obj.get("msg") or obj
        if item.get("type") == "agent_message":
            msg = item.get("text") or item.get("message")
            if msg:
                text = msg
                found_text = True
    if not found_text:
        text = proc.stdout.strip()
    return {"response": text, "claude_session_id": thread_id}


# ─── Server ───────────────────────────────────────────────────────────────────

app = FastAPI()


def _cli_is_running(proc_root: str = "/proc") -> bool:
    try:
        pids = os.listdir(proc_root)
    except OSError:
        return False
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            with open(os.path.join(proc_root, pid, "cmdline"), "rb") as f:
                raw = f.read()
        except OSError:
            continue
        if not raw:
            continue
        exe = raw.split(b"\x00", 1)[0].decode(errors="replace").rsplit("/", 1)[-1]
        if exe in _CODING_PROC_NAMES:
            return True
    return False


@app.get("/ping")
@app.get("/health")
async def health():
    status = "HealthyBusy" if _cli_is_running() else "Healthy"
    return JSONResponse({"status": status, "time_of_last_update": int(time.time())})


@app.post("/invocations")
async def invocations(request: Request):
    """Run one coding turn.

    Payload: { prompt (required), repo?, cli? (claude|codex), claude_session_id?,
               user_id?, config_version? }
    Returns: { response, claude_session_id, cli, workspace }  (or { error })
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "prompt is required"}, status_code=400)

    cli = (payload.get("cli") or DEFAULT_CLI).lower()
    repo = payload.get("repo")
    claude_session_id = payload.get("claude_session_id")
    user_id = payload.get("user_id")
    config_version = payload.get("config_version")
    session_id = payload.get("session_id")  # isolates this session's checkout
    stream = bool(payload.get("stream"))  # SSE incremental output (claude only)

    # On resume, recover the repo the conversation was started in (so we land in
    # the same cwd Claude Code scoped the session to) when the caller omits it.
    if claude_session_id and not repo:
        repo = _load_session_map().get(claude_session_id, {}).get("repo")

    logger.info("turn_start", extra=redact(
        {"cli": cli, "repo": repo, "resume": bool(claude_session_id),
         "stream": stream, "prompt_head": prompt[:120]}))

    # Shared setup for both streaming and buffered paths.
    try:
        _apply_default_mcp()
        _apply_config_bundle(user_id, config_version)
        _configure_git()
        workdir = _ensure_workspace(repo, session_id)
    except ValueError as ve:  # bad repo field — caller error, not a 500
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        logger.error("turn_setup_failed", extra={"cli": cli, "error": str(exc)[:600]})
        return JSONResponse({"error": str(exc)[:600]}, status_code=500)

    # Streaming path (claude): yield SSE as the turn runs. The runtime forwards
    # an async/sync generator response as text/event-stream through InvokeAgentRuntime.
    if stream and cli == "claude":
        return StreamingResponse(
            _stream_claude(prompt, workdir, claude_session_id, repo),
            media_type="text/event-stream",
        )

    try:
        if cli == "codex":
            result = _run_codex(prompt, workdir, claude_session_id)
        elif cli == "claude":
            result = _run_claude(prompt, workdir, claude_session_id)
        else:
            return JSONResponse({"error": f"unknown cli '{cli}'"}, status_code=400)
    except subprocess.TimeoutExpired:
        logger.error("turn_timeout", extra={"cli": cli, "timeout_s": TURN_TIMEOUT_S})
        return JSONResponse({"error": f"{cli} timed out after {TURN_TIMEOUT_S}s"}, status_code=504)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the caller
        logger.error("turn_failed", extra={"cli": cli, "error": str(exc)[:600]})
        return JSONResponse({"error": str(exc)[:600]}, status_code=500)

    # Persist {claude_session_id → repo} so a later resume recovers the cwd.
    _remember_session(result.get("claude_session_id"), repo)

    result.update({"cli": cli, "workspace": workdir})
    logger.info("turn_done", extra={"cli": cli, "chars": len(result.get("response") or "")})
    return JSONResponse(result)


def _export_runtime_env() -> None:
    """Persist AgentCore-injected env vars to a file the interactive PTY shell
    can source. The PTY spawns as a fresh process that does NOT inherit this
    server process's environment, so GITHUB_PAT / model ids / bucket would be
    empty in the Terminal tab. shell-init.sh sources this file.

    The EFS mount can lag the server's startup by a few seconds (writes fail
    with EACCES until it's ready), so retry in a background thread rather than
    block boot or give up on the first failure."""
    import threading

    keys = [
        "GITHUB_PAT", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME",
        "AWS_REGION", "BEDROCK_MANTLE_REGION", "ANTHROPIC_MODEL", "CLAUDE_MODEL",
        "CODEX_MODEL", "ARTIFACT_BUCKET", "WORKSPACE_ROOT",
    ]
    body = "".join(
        f"export {k}={shlex.quote(os.environ[k])}\n" for k in keys if os.environ.get(k)
    )
    path = os.path.join(WORKSPACE_ROOT, ".runtime-env.sh")

    def _writer() -> None:
        for attempt in range(30):  # ~60s of retries for the EFS mount to appear
            try:
                os.makedirs(WORKSPACE_ROOT, exist_ok=True)
                with open(path, "w") as f:
                    f.write(body)
                logger.info("runtime_env_exported", extra={"path": path, "attempt": attempt})
                return
            except OSError:
                time.sleep(2)
        logger.warning("runtime_env_export_failed", extra={"path": path})

    threading.Thread(target=_writer, daemon=True).start()


if __name__ == "__main__":
    _export_runtime_env()
    _bootstrap_collector()
    logger.info("server_starting", extra={"port": 8080, "workspace_root": WORKSPACE_ROOT})
    uvicorn.run(app, host="0.0.0.0", port=8080)
