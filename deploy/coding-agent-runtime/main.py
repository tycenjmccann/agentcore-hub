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

import json
import os
import re
import shlex
import socket
import subprocess
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from log import get_logger, redact

logger = get_logger("coding-agent-runtime")

WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/mnt/workspace")
DEFAULT_CLI = "claude"
CLAUDE_MODEL = os.environ.get("ANTHROPIC_MODEL") or os.environ.get(
    "CLAUDE_MODEL", "us.anthropic.claude-opus-4-6-v1"
)
# A single coding turn can be long; cap so a wedged CLI can't pin the microVM.
TURN_TIMEOUT_S = int(os.environ.get("TURN_TIMEOUT_S", "1500"))

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


def _ensure_workspace(repo: str | None) -> str:
    """Return the working dir. If repo given and not yet cloned, clone it.
    The dir lives on persistent session storage, so a re-invoke with the same
    runtimeSessionId finds it warm (no re-clone)."""
    if not repo:
        wd = WORKSPACE_ROOT
        os.makedirs(wd, exist_ok=True)
        return wd
    slug = _slugify_repo(repo)
    wd = os.path.join(WORKSPACE_ROOT, slug)
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("workspace_warm", extra={"slug": slug})
        return wd
    os.makedirs(WORKSPACE_ROOT, exist_ok=True)
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
    args = [
        "claude", "--print", "--dangerously-skip-permissions",
        "--output-format", "json", "--model", CLAUDE_MODEL,
        "--max-turns", os.environ.get("MAX_TURNS", "100"),
    ]
    if claude_session_id:
        args += ["--resume", claude_session_id]
    args.append(prompt)

    env = {**os.environ, "CLAUDE_CODE_USE_BEDROCK": "1",
           "CLAUDE_CONFIG_DIR": os.environ.get("CLAUDE_CONFIG_DIR", "/mnt/workspace/.claude-data")}
    os.makedirs(env["CLAUDE_CONFIG_DIR"], exist_ok=True)

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


def _run_codex(prompt: str, workdir: str) -> dict:
    """Run one Codex turn via the Mantle launcher (GPT-5.5). Codex resume is not
    yet wired — each turn is independent for now."""
    env = {**os.environ, "WORKSPACE_DIR": workdir}
    proc = subprocess.run(["/app/run-codex.sh", prompt], cwd=workdir, env=env,
                          capture_output=True, text=True, timeout=TURN_TIMEOUT_S,
                          stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"codex exited {proc.returncode}: {proc.stderr.strip()[:600]}")
    # codex exec --json emits JSONL. The final assistant text arrives as
    #   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    # (older builds used {"msg":{"type":"agent_message","message":"..."}}).
    # Take the last agent_message; fall back to raw stdout.
    text = proc.stdout.strip()
    for line in reversed(proc.stdout.splitlines()):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = obj.get("item") or obj.get("msg") or obj
        if item.get("type") == "agent_message":
            msg = item.get("text") or item.get("message")
            if msg:
                text = msg
                break
    return {"response": text, "claude_session_id": None}


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

    Payload: { prompt (required), repo?, cli? (claude|codex), claude_session_id? }
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

    # On resume, recover the repo the conversation was started in (so we land in
    # the same cwd Claude Code scoped the session to) when the caller omits it.
    if claude_session_id and not repo:
        repo = _load_session_map().get(claude_session_id, {}).get("repo")

    logger.info("turn_start", extra=redact(
        {"cli": cli, "repo": repo, "resume": bool(claude_session_id), "prompt_head": prompt[:120]}))

    try:
        _configure_git()
        workdir = _ensure_workspace(repo)
        if cli == "codex":
            result = _run_codex(prompt, workdir)
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


if __name__ == "__main__":
    _bootstrap_collector()
    logger.info("server_starting", extra={"port": 8080, "workspace_root": WORKSPACE_ROOT})
    uvicorn.run(app, host="0.0.0.0", port=8080)
