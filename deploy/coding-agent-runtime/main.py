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

import glob
import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone

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

# ── Shared git object cache (bare mirrors) ──────────────────────────────────
# Every workflow task lands on a NEW runtimeSessionId, so a cold workspace meant a
# FULL `git clone` onto the shared EFS mount. Under burst load (many workflows,
# the same handful of repos) those concurrent clones blew the old 300s cap and
# faulted the mount mid-pack-index ("Bad file descriptor" / "invalid index-pack"),
# which surfaced to the agent as a tool timeout. Fix: keep ONE bare mirror per repo
# on EFS and have each session `clone --reference` it — a cold setup becomes a refs
# negotiation plus a small delta instead of a full object transfer, with near-zero
# object writes (the part that was faulting).
# Kill-switch: WORKSPACE_MIRROR_ENABLED=0 restores the plain-clone path and never
# touches .mirrors at all — an env flip, no code rollback.
WORKSPACE_MIRROR_ENABLED = os.environ.get("WORKSPACE_MIRROR_ENABLED", "1").lower() not in ("0", "false", "no")
MIRROR_ROOT = os.path.join(WORKSPACE_ROOT, ".mirrors")
# Per-session checkout cap. Was 300s — too tight for a big repo on a busy mount.
CLONE_TIMEOUT_S = int(os.environ.get("CLONE_TIMEOUT_S", "900"))
# Building a mirror is the one full download for that repo, ever — give it room.
MIRROR_BUILD_TIMEOUT_S = int(os.environ.get("MIRROR_BUILD_TIMEOUT_S", "1200"))
# How stale a mirror may be before a checkout refreshes it (`fetch --prune`).
MIRROR_REFRESH_TTL_S = int(os.environ.get("MIRROR_REFRESH_TTL_S", "3600"))
# Off by default: keeping the alternates link IS the win (borrowed objects are not
# rewritten). Set 1 to copy objects into the checkout and cut the link instead.
MIRROR_DISSOCIATE = os.environ.get("MIRROR_DISSOCIATE", "0").lower() not in ("0", "false", "no")
# Mirror create/refresh is serialized by a lock file; readers never lock.
_MIRROR_LOCK_WAIT_S = 60      # give up waiting → caller falls back to a plain clone
_MIRROR_LOCK_POLL_S = 1.0
# A lock older than this was orphaned by a microVM that died mid-build. It MUST
# stay above MIRROR_BUILD_TIMEOUT_S so a live build is never stolen.
_MIRROR_LOCK_STALE_S = 1800

DEFAULT_CLI = "claude"
CLAUDE_MODEL = os.environ.get("ANTHROPIC_MODEL") or os.environ.get(
    "CLAUDE_MODEL", "us.anthropic.claude-fable-5"
)
# A single coding turn can be long; cap so a wedged CLI can't pin the microVM.
TURN_TIMEOUT_S = int(os.environ.get("TURN_TIMEOUT_S", "1500"))
# Async (submit+poll) turns: journal heartbeat cadence and the staleness bar a
# poll uses to declare a running turn dead (VM crashed mid-turn). The heartbeat
# is written by the runner thread; 120s of silence >> one 15s beat, so a stale
# read means the thread is gone, not slow.
TURN_HEARTBEAT_S = int(os.environ.get("TURN_HEARTBEAT_S", "15"))
TURN_STALE_S = int(os.environ.get("TURN_STALE_S", "120"))

# Per-user coding-CLI config bundle (MCP servers, skills, custom agents, prefs).
# The app uploads a zip under the tenant prefix (see _tenant_root); we materialize
# it into the CLI config dirs on session start.
ARTIFACT_BUCKET = os.environ.get("ARTIFACT_BUCKET", "")

# Tenant boundary for S3 keys — MUST match src/lib/cloud-code/s3keys.ts. The
# "default" tenant (no-auth deploys) keeps the legacy unprefixed layout so
# pre-tenancy objects still resolve; real tenants get a `t/<tenantId>/` prefix.
DEFAULT_TENANT_ID = "default"


def _tenant_root(tenant_id: str | None) -> str:
    tid = tenant_id or DEFAULT_TENANT_ID
    return "cloud-code" if tid == DEFAULT_TENANT_ID else f"cloud-code/t/{tid}"
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
    # Best-effort: a degraded/stale EFS mount can make makedirs raise
    # FileExistsError even with exist_ok=True (path exists but isn't a dir). This
    # is bookkeeping for cwd recovery on resume — never worth failing a finished
    # turn over (the turn's output is already streamed by the time we get here).
    try:
        os.makedirs(WORKSPACE_ROOT, exist_ok=True)
        m = _load_session_map()
        m[claude_session_id] = {"repo": repo}
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


def _apply_config_bundle(user_id: str | None, version: str | None, tenant_id: str | None = None) -> None:
    """Materialize a user's coding-CLI config bundle into the CLI config dirs.

    The bundle is a zip at s3://{ARTIFACT_BUCKET}/{tenant_root}/configs/{userId}/{version}.zip
    laid out as `claude/...` (→ CLAUDE_CONFIG_DIR) and `codex/...` (→ CODEX_HOME).
    Idempotent per warm microVM via a marker file. The user's files land first;
    run-codex.sh / the launchers then re-assert our Bedrock provider on top, so a
    user config can add MCP/skills/agents but never break model access.
    """
    # The marker records {token, files[]} of the last applied bundle so we can
    # (a) skip re-applying the same one and (b) cleanly remove exactly those
    # files when the user disables their bundle (version unset).
    def _read_marker() -> dict:
        try:
            with open(_CONFIG_MARKER) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}

    def _remove_applied(files: list) -> None:
        for rel in files:
            try:
                os.remove(rel)
            except OSError:
                pass

    # Disable path: no version selected → strip any previously-applied bundle
    # files from the persistent EFS config dirs so defaults truly return.
    if not version:
        prev = _read_marker()
        if prev.get("files"):
            _remove_applied(prev["files"])
            try:
                os.remove(_CONFIG_MARKER)
            except OSError:
                pass
            logger.info("config_bundle_cleared", extra={"removed": len(prev["files"])})
        return
    if not (user_id and ARTIFACT_BUCKET):
        return

    token = f"{tenant_id or DEFAULT_TENANT_ID}:{user_id}:{version}"
    prev = _read_marker()
    if prev.get("token") == token:
        return  # already applied to this warm VM
    # Switching versions/disabling → clear the previous bundle's files first.
    if prev.get("files"):
        _remove_applied(prev["files"])

    key = f"{_tenant_root(tenant_id)}/configs/{user_id}/{version}.zip"
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
    applied_paths: list = []
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
                applied_paths.append(target)
    except zipfile.BadZipFile:
        logger.warning("config_bundle_bad_zip", extra={"key": key})
        return

    # Record token + the exact files written, so a later disable/switch removes
    # precisely this bundle (and nothing else in the shared config dirs).
    try:
        with open(_CONFIG_MARKER, "w") as f:
            json.dump({"token": token, "files": applied_paths}, f)
    except OSError:
        pass
    logger.info("config_bundle_applied", extra={"user": user_id, "version": version, "files": len(applied_paths)})


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


def _clear_github_insteadof() -> None:
    """Remove every `url.https://x-access-token:<token>@github.com/.insteadOf`
    section from ~/.gitconfig. Each minted token produced a distinct section key,
    so on a warm VM they accumulate and Git rewrites through the first (stale) one.
    We enumerate the section names via --get-regexp and --remove-section each."""
    res = subprocess.run(
        ["git", "config", "--global", "--get-regexp",
         r"^url\.https://x-access-token:.*@github\.com/\.insteadof"],
        capture_output=True, text=True, check=False,
    )
    sections = set()
    for line in res.stdout.splitlines():
        # Each line is "<section>.insteadof <value>"; strip the ".insteadof …" tail.
        name = line.split(" ", 1)[0]
        if name.lower().endswith(".insteadof"):
            sections.add(name[: -len(".insteadof")])
    for section in sections:
        subprocess.run(
            ["git", "config", "--global", "--remove-section", section],
            check=False, stderr=subprocess.DEVNULL,
        )


def _configure_git(github_token: str | None = None, app_connected: bool = False) -> None:
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
    # Prefer the per-session GitHub App installation token minted by the hub for
    # this session's owner: short-lived (~1h) and scoped to just this repo. Only
    # fall back to the shared GITHUB_PAT when the owner is NOT App-connected — a
    # connected owner whose scoped mint was denied must clone within their App
    # scope, never escalate to the operator's broad PAT.
    token = github_token
    if not token and not app_connected:
        token = os.environ.get("GITHUB_PAT")
    # A warm microVM outlives a ~1h installation token, so a turn re-runs this with
    # a DIFFERENT token. Each token makes a distinct `url.https://x-access-token:<t>@
    # github.com/.insteadOf` KEY, so a plain re-add leaves the OLD (expired) rule in
    # ~/.gitconfig. Git rewrites through the FIRST matching rule → clones/pushes use
    # the stale token and fail. Drop every prior github.com insteadOf rule first, so
    # only the current token's rule remains (also scrubs it on a token-less turn).
    _clear_github_insteadof()
    if not token:
        os.environ.pop("GH_TOKEN", None)
        os.environ.pop("GITHUB_TOKEN", None)
        return
    subprocess.run(
        ["git", "config", "--global",
         f"url.https://x-access-token:{token}@github.com/.insteadOf",
         "https://github.com/"],
        check=False,
    )
    subprocess.run(["git", "config", "--global", "user.email",
                    os.environ.get("GIT_AUTHOR_EMAIL", "agent@agentcore-hub.example.com")], check=False)
    subprocess.run(["git", "config", "--global", "user.name",
                    os.environ.get("GIT_AUTHOR_NAME", "AgentCore Hub Agent")], check=False)
    # Expose the token to the GitHub CLI so the agent can enumerate/inspect repos
    # (e.g. `gh repo list`, `gh api`) — not just clone a known URL.
    os.environ["GH_TOKEN"] = token
    os.environ["GITHUB_TOKEN"] = token


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


# The resume hint shell-init reads is CONTAINER-LOCAL (/tmp) — never at
# $WORKSPACE_ROOT. EFS is shared across every session's microVM, so a hint at the
# shared root would leak: a different session's Terminal would source it and
# `claude --resume` the wrong conversation. /tmp is private to this microVM (one
# per runtimeSessionId).
#
# But /tmp dies when the microVM is recycled, and a cold VM may be reached only
# by the config-only prepare path that doesn't recompute the hint. So we ALSO
# persist a durable copy in the per-session EFS dir — session-scoped
# (sessions/<id>/…), not the shared root, so it can't leak — and restore /tmp
# from it at the start of every invocation. Durable source of truth, private
# runtime copy.
RESUME_HINT_PATH = "/tmp/.resume-launch.sh"  # noqa: S108 — container-local, see above
RESUME_HINT_NAME = ".resume-launch.sh"


def _write_resume_launch_hint(workdir: str, resume_sid: str,
                              runtime_session_id: str | None,
                              cli: str = "claude") -> bool:
    """Write the hint the interactive shell reads on launch to
    `cd <workdir> && <cli> --resume <resume_sid>` itself — so the browser never
    types the resume command into an already-running TUI on reattach.

    Two distinct ids: `resume_sid` is the conversation id (the resume arg);
    `runtime_session_id` is the AgentCore runtimeSessionId that keys the
    per-session EFS dir AND is what _restore_resume_launch_hint looks up later.
    They differ, so the durable copy MUST be keyed by the runtime id or restore
    would miss it on a recycled VM."""
    body = (
        f"CC_RESUME_DIR={shlex.quote(os.path.realpath(workdir))}\n"
        f"CC_RESUME_SID={shlex.quote(resume_sid)}\n"
        f"CC_RESUME_CLI={shlex.quote(cli)}\n"
    )
    ok = False
    try:
        with open(RESUME_HINT_PATH, "w") as f:
            f.write(body)
        ok = True
    except OSError as exc:
        logger.warning("resume_launch_hint_failed", extra={"error": str(exc)[:200]})
    if runtime_session_id:
        try:
            sdir = _session_dir(runtime_session_id)
            os.makedirs(sdir, exist_ok=True)
            with open(os.path.join(sdir, RESUME_HINT_NAME), "w") as f:
                f.write(body)
        except OSError as exc:
            logger.warning("resume_hint_persist_failed", extra={"error": str(exc)[:200]})
    if ok:
        logger.info("resume_launch_hint_written", extra={"workdir": workdir})
    return ok


def _restore_resume_launch_hint(session_id: str | None) -> None:
    """Repopulate the private /tmp hint from the durable per-session EFS copy if
    /tmp is missing (a recycled microVM). Lets a session resume in the Terminal
    even when it's reached only by the config-only prepare path. No-op if /tmp
    already has it or there's no durable copy."""
    if not session_id or os.path.exists(RESUME_HINT_PATH):
        return
    src = os.path.join(_session_dir(session_id), RESUME_HINT_NAME)
    try:
        if os.path.isfile(src):
            with open(src) as f:
                body = f.read()
            with open(RESUME_HINT_PATH, "w") as f:
                f.write(body)
            logger.info("resume_launch_hint_restored", extra={"session": session_id})
    except OSError as exc:
        logger.warning("resume_hint_restore_failed", extra={"error": str(exc)[:200]})


def _claude_project_slug(workdir: str) -> str:
    """Claude Code stores a conversation under
    {CLAUDE_CONFIG_DIR}/projects/<slug>/<sessionId>.jsonl where <slug> is the
    real (symlink-resolved) cwd with every non-alphanumeric char replaced by '-'.
    `claude --resume` looks up the transcript by that exact slug, so a ported
    session resumes ONLY if we place its .jsonl under the matching folder."""
    return re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(workdir))


def _install_resume_transcript(s3_key: str, session_id: str, workdir: str) -> bool:
    """Download a ported Claude transcript from S3 and place it where
    `claude --resume <session_id>` will find it (the workdir's project slug).

    This is how "port my laptop session to the cloud" achieves a LOSSLESS,
    native resume: we ship the real .jsonl, not a text summary. Idempotent — a
    marker per (session, key) means we download once per warm microVM.
    Returns True if the transcript is in place (freshly or already)."""
    if not (s3_key and session_id and ARTIFACT_BUCKET):
        return False
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    proj = os.path.join(config_dir, "projects", _claude_project_slug(workdir))
    dest = os.path.join(proj, f"{session_id}.jsonl")
    marker = os.path.join(_session_dir(session_id), ".resume-installed")
    try:
        if os.path.exists(dest) and os.path.exists(marker):
            with open(marker) as f:
                if f.read().strip() == s3_key:
                    return True  # this exact transcript already installed
    except OSError:
        pass
    try:
        os.makedirs(proj, exist_ok=True)
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        with open(dest, "wb") as f:
            f.write(obj["Body"].read())
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as f:
            f.write(s3_key)
        logger.info("resume_transcript_installed",
                    extra={"session": session_id, "slug": _claude_project_slug(workdir)})
        return True
    except Exception as exc:  # noqa: BLE001 — a missing transcript is non-fatal; fall back to a cold turn
        logger.warning("resume_transcript_install_failed", extra={"key": s3_key, "error": str(exc)[:200]})
        return False


def _sanitize_codex_rollout(raw: bytes) -> bytes:
    """Make a laptop-recorded codex rollout safe to resume against Bedrock Mantle.

    Codex records reasoning items with provider-bound `encrypted_content`. A
    rollout recorded on a laptop (model_provider "openai") carries OpenAI-encrypted
    blobs; replaying them to Mantle's Responses API fails hard with
    `validation_error: encrypted content missing recognized prefix (expected
    rsn_/smry_)` — codex exits 1 and the whole resume dies. We drop reasoning items
    whose encrypted blob doesn't carry a Mantle-recognized prefix (portable ones,
    e.g. a prior cloud turn's rsn_/smry_ content, are kept).

    We also drop a trailing unpaired `function_call` (no matching
    function_call_output) — the port tool-call is often the last row the laptop
    wrote before shipping, and the Responses API rejects a dangling call on replay.

    Cross-provider only: the pristine S3 copy is untouched, so a pull-home resume
    against the laptop's own OpenAI key still has its native encrypted reasoning."""
    lines = raw.split(b"\n")
    parsed: list[tuple[bytes, dict | None]] = []
    output_ids: set[str] = set()
    for ln in lines:
        s = ln.strip()
        if not s:
            parsed.append((ln, None)); continue
        try:
            obj = json.loads(s)
        except Exception:  # noqa: BLE001 — keep non-JSON lines verbatim
            parsed.append((ln, None)); continue
        parsed.append((ln, obj))
        p = obj.get("payload") or {}
        if obj.get("type") == "response_item" and p.get("type") == "function_call_output":
            cid = p.get("call_id")
            if cid:
                output_ids.add(cid)

    def _encrypted_portable(p: dict) -> bool:
        blobs: list[str] = []
        if p.get("encrypted_content"):
            blobs.append(p["encrypted_content"])
        for c in (p.get("content") or []):
            if isinstance(c, dict) and c.get("encrypted_content"):
                blobs.append(c["encrypted_content"])
        if not blobs:
            return True  # no encrypted payload → nothing provider-bound to reject
        return all(str(b).startswith(("rsn_", "smry_")) for b in blobs)

    kept: list[bytes] = []
    dropped_reasoning = dropped_calls = 0
    for ln, obj in parsed:
        if obj and obj.get("type") == "response_item":
            p = obj.get("payload") or {}
            t = p.get("type")
            if t == "reasoning" and not _encrypted_portable(p):
                dropped_reasoning += 1; continue
            if t == "function_call" and p.get("call_id") not in output_ids:
                dropped_calls += 1; continue
        kept.append(ln)

    if not (dropped_reasoning or dropped_calls):
        return raw
    logger.info("codex_rollout_sanitized",
                extra={"dropped_reasoning": dropped_reasoning, "dropped_calls": dropped_calls})
    return b"\n".join(kept)


def _find_codex_rollout(session_id: str) -> str | None:
    """Locate a codex session's rollout .jsonl by its thread uuid. Codex stores
    one file per session at {CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,
    so we glob the tree for the uuid anywhere in the filename and take the newest
    match (a resumed session keeps the same uuid)."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", session_id)
    matches: list[str] = []
    for cid in {session_id, safe}:
        matches += glob.glob(
            os.path.join(CODEX_HOME, "sessions", "**", f"*{glob.escape(cid)}*.jsonl"),
            recursive=True,
        )
    return max(matches, key=os.path.getmtime) if matches else None


def _install_codex_resume_transcript(s3_key: str, session_id: str) -> bool:
    """Codex analog of _install_resume_transcript. Download a ported codex rollout
    from S3 and place it under {CODEX_HOME}/sessions so `codex resume <uuid>`
    finds it. Codex locates a session by parsing BOTH a timestamp and the uuid out
    of the filename (rollout-<YYYY-MM-DDThh-mm-ss>-<uuid>.jsonl), so the name must
    match that shape or the scan skips it. Idempotent: if a rollout for this uuid
    is already on disk (e.g. a prior turn grew it), keep that grown copy.

    The downloaded bytes are sanitized (_sanitize_codex_rollout) before landing on
    disk: a laptop-recorded rollout's OpenAI-encrypted reasoning would otherwise
    make the first Mantle resume fail with a validation_error."""
    if not (s3_key and session_id and ARTIFACT_BUCKET):
        return False
    existing = _find_codex_rollout(session_id)
    if existing:
        # Already on disk (possibly grown by a prior cloud turn). Self-heal a
        # rollout installed before the sanitizer existed: re-sanitize in place —
        # no-op once clean, and portable rsn_/smry_ reasoning is preserved.
        try:
            with open(existing, "rb") as f:
                cur = f.read()
            fixed = _sanitize_codex_rollout(cur)
            if fixed != cur:
                with open(existing, "wb") as f:
                    f.write(fixed)
                logger.info("codex_rollout_resanitized", extra={"session": session_id})
        except Exception as exc:  # noqa: BLE001 — non-fatal
            logger.warning("codex_rollout_resanitize_failed", extra={"error": str(exc)[:200]})
        return True
    now = datetime.now(timezone.utc)
    dest_dir = os.path.join(CODEX_HOME, "sessions",
                            f"{now.year:04d}", f"{now.month:02d}", f"{now.day:02d}")
    ts = now.strftime("%Y-%m-%dT%H-%M-%S")
    dest = os.path.join(dest_dir, f"rollout-{ts}-{session_id}.jsonl")
    try:
        os.makedirs(dest_dir, exist_ok=True)
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        with open(dest, "wb") as f:
            f.write(_sanitize_codex_rollout(obj["Body"].read()))
        logger.info("codex_resume_transcript_installed", extra={"session": session_id})
        return True
    except Exception as exc:  # noqa: BLE001 — non-fatal; fall back to a cold turn
        logger.warning("codex_resume_transcript_install_failed",
                       extra={"key": s3_key, "error": str(exc)[:200]})
        return False


def _fetch_attachments(artifact_prefix: str, attachments: list, workdir: str) -> list[str]:
    """Download chat attachments (paths relative to the session's artifact
    prefix) into the workspace's .cloud-code/artifacts/ and return their absolute
    on-disk paths. Traversal-guarded; best-effort per file — one bad attachment
    never fails the turn."""
    if not (artifact_prefix and attachments and workdir and ARTIFACT_BUCKET):
        return []
    dest_root = os.path.join(workdir, ".cloud-code", "artifacts")
    real_root = os.path.realpath(dest_root)
    paths: list[str] = []
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        for rel in attachments[:20]:
            rel = str(rel or "").lstrip("/")
            if not rel or ".." in rel.split("/"):
                continue
            dest = os.path.join(dest_root, rel)
            real_dest = os.path.realpath(dest)
            if real_dest != real_root and not real_dest.startswith(real_root + os.sep):
                continue
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as fh:
                    s3.download_fileobj(ARTIFACT_BUCKET, artifact_prefix + rel, fh)
                paths.append(dest)
            except Exception as exc:  # noqa: BLE001
                logger.warning("attachment_fetch_failed", extra={"rel": rel, "error": str(exc)[:200]})
    except Exception as exc:  # noqa: BLE001
        logger.warning("attachments_fetch_failed", extra={"error": str(exc)[:200]})
    return paths


def _install_artifacts(artifact_prefix: str, workdir: str, session_id: str | None) -> int:
    """Restore a session's artifacts (uploaded via the web, or ported) into the
    workspace's .cloud-code/artifacts/ so the agent can open them on a turn.

    RE-LISTS s3://{ARTIFACT_BUCKET}/{artifact_prefix} every call (a cheap
    ListObjectsV2) rather than trusting a one-shot prefix marker: a file uploaded
    AFTER the first restore must still land. Only objects that are missing locally
    or whose size differs from the local copy are downloaded, so an unchanged
    prefix costs one list and no downloads. Path-traversal guarded. Best-effort —
    a single failed download never fails the turn. Returns the count downloaded."""
    if not (artifact_prefix and workdir and ARTIFACT_BUCKET):
        return 0
    dest_root = os.path.join(workdir, ".cloud-code", "artifacts")
    real_root = os.path.realpath(dest_root)
    restored = 0
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=ARTIFACT_BUCKET, Prefix=artifact_prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                rel = key[len(artifact_prefix):]
                if not rel or rel.endswith("/"):
                    continue  # the prefix placeholder / a dir marker
                dest = os.path.join(dest_root, rel)
                # Traversal guard: the resolved dest MUST stay under the artifacts root.
                real_dest = os.path.realpath(dest)
                if real_dest != real_root and not real_dest.startswith(real_root + os.sep):
                    logger.warning("artifact_path_escape_skipped", extra={"rel": rel})
                    continue
                # Skip a byte-identical local copy (same size) — cheap change check
                # without a per-object HEAD. A new or resized object re-downloads.
                remote_size = int(obj.get("Size", 0) or 0)
                try:
                    if os.path.isfile(dest) and os.path.getsize(dest) == remote_size:
                        continue
                except OSError:
                    pass
                try:
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "wb") as fh:
                        s3.download_fileobj(ARTIFACT_BUCKET, key, fh)
                    restored += 1
                except Exception as exc:  # noqa: BLE001 — one bad file is non-fatal
                    logger.warning("artifact_download_failed",
                                   extra={"key": key, "error": str(exc)[:200]})
        if restored:
            logger.info("artifacts_installed", extra={"prefix": artifact_prefix, "count": restored})
    except Exception as exc:  # noqa: BLE001 — listing/setup failure is non-fatal
        logger.warning("artifacts_install_failed",
                       extra={"prefix": artifact_prefix, "error": str(exc)[:200]})
    return restored


def _checkpoint_transcript(session_id: str, workdir: str, tenant_id: str | None = None) -> dict:
    """Reverse of install: read the (now-grown) Claude transcript off EFS and
    upload it to S3 so the laptop can pull it back and `claude --resume` locally.

    The transcript lives at {CLAUDE_CONFIG_DIR}/projects/<slug>/<session_id>.jsonl
    — the same file the cloud appended to during the session. Returns
    {key, bytes, branch?} for the caller to presign a GET. The branch (current
    checkout) lets the laptop pull the cloud's commits before resuming."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    src = os.path.join(config_dir, "projects", _claude_project_slug(workdir), f"{session_id}.jsonl")
    if not os.path.isfile(src):
        raise FileNotFoundError(f"no transcript at {src} (session never resumed on this VM?)")
    if not ARTIFACT_BUCKET:
        raise RuntimeError("ARTIFACT_BUCKET not set")
    key = f"{_tenant_root(tenant_id)}/checkpoint/{session_id}/{session_id}.jsonl"
    with open(src, "rb") as f:
        data = f.read()
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    s3.put_object(Bucket=ARTIFACT_BUCKET, Key=key, Body=data, ContentType="application/x-ndjson")
    branch = None
    try:
        res = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=workdir,
                             capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            branch = res.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    logger.info("checkpoint_uploaded", extra={"session": session_id, "bytes": len(data), "branch": branch})
    return {"key": key, "bytes": len(data), "branch": branch}


# ─── Artifacts: touched-but-untracked deliverables the cloud session produced ─
# (generated media, exports, datasets). They don't travel home via the git branch
# (untracked) or the transcript (binary), so we harvest them to S3 on checkpoint
# and the web Artifacts tab lists them. Anything pre-staged under
# .cloud-code/artifacts/ is always included.
_ARTIFACT_FILE_CAP = int(os.environ.get("CC_ARTIFACT_FILE_CAP_MB", "500")) * 1024 * 1024
_ARTIFACT_TOTAL_CAP = int(os.environ.get("CC_ARTIFACT_TOTAL_CAP_MB", "2048")) * 1024 * 1024
_ARTIFACT_COUNT_CAP = int(os.environ.get("CC_ARTIFACT_COUNT_CAP", "200"))
_MEDIA_TOKEN_RE = re.compile(
    r"(?:[A-Za-z0-9_~][A-Za-z0-9_.~/-]*)?\.(?:png|jpe?g|gif|webp|svg|bmp|tiff|heic"
    r"|mp4|mov|webm|avi|mkv|mp3|wav|aac|flac|m4a|pdf|docx|pptx|xlsx"
    r"|csv|parquet|arrow|feather|npy|npz|pkl|h5|sqlite|db)\b",
    re.IGNORECASE,
)
# Credential files a turn may have written — never ship them out.
_SECRET_EXTS = {".pem", ".p12", ".pfx", ".keystore", ".jks", ".asc", ".gpg"}
_SECRET_NAME_RE = re.compile(
    r"(^\.env($|\.)|(^|\.)npmrc$|(^|\.)netrc$|(^|/)id_(rsa|ed25519|ecdsa|dsa)$"
    # `credentials` at end-of-path OR before an extension (credentials.csv is a
    # common AWS access-key export) — never ship either.
    r"|(^|\.)pgpass$|(^|/)credentials(\.|$)|secrets?(\.|$)|\.secret$)",
    re.IGNORECASE,
)


def _is_secret_path(rel: str) -> bool:
    base = os.path.basename(rel).lower()
    if os.path.splitext(base)[1] in _SECRET_EXTS:
        return True
    return bool(_SECRET_NAME_RE.search(base) or _SECRET_NAME_RE.search(rel))


def _git_tracked(repo_dir: str, abs_path: str) -> bool:
    try:
        r = subprocess.run(["git", "ls-files", "--error-unmatch", abs_path],
                           cwd=repo_dir, capture_output=True, timeout=15)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _detect_cloud_artifacts(workdir: str) -> list[dict]:
    """Deliverables that exist in the workspace, aren't git-tracked (so they don't
    already travel home via the branch), and aren't credential files — plus
    anything pre-staged under .cloud-code/artifacts/. A media sweep of any git
    'other' (untracked) files catches shell-produced outputs (a PNG a script
    rendered, an MP4 ffmpeg wrote). Deduped, capped smallest-first so the caps
    keep the most files. Returns [{rel, abs, bytes}]."""
    if not workdir or not os.path.isdir(workdir):
        return []
    cands: set[str] = set()
    artifacts_root = os.path.join(workdir, ".cloud-code", "artifacts")
    if os.path.isdir(artifacts_root):
        for root, _dirs, files in os.walk(artifacts_root):
            for fn in files:
                cands.add(os.path.join(root, fn))
    # Untracked + ignored files in the repo, filtered to media/deliverable exts.
    try:
        r = subprocess.run(
            ["git", "ls-files", "--others", "-z"],
            cwd=workdir, capture_output=True, text=True, timeout=30,
        )
        for rel in r.stdout.split("\0"):
            if rel and _MEDIA_TOKEN_RE.search(rel):
                cands.add(os.path.join(workdir, rel))
    except Exception:  # noqa: BLE001
        pass

    seen: set[str] = set()
    out: list[dict] = []
    real_wd = os.path.realpath(workdir)
    real_artifacts = os.path.realpath(artifacts_root)
    for raw in cands:
        abs_path = os.path.realpath(raw)
        if abs_path in seen:
            continue
        seen.add(abs_path)
        if abs_path != real_wd and not abs_path.startswith(real_wd + os.sep):
            continue  # must live inside the workspace
        if not os.path.isfile(abs_path):
            continue
        if _git_tracked(workdir, abs_path):
            continue  # already travels home via the branch
        try:
            size = os.path.getsize(abs_path)
        except OSError:
            continue
        if size > _ARTIFACT_FILE_CAP:
            continue
        # rel is relative to .cloud-code/artifacts/ for staged files (no double
        # nesting on restore), else relative to the workdir.
        if abs_path == real_artifacts or abs_path.startswith(real_artifacts + os.sep):
            rel = os.path.relpath(abs_path, real_artifacts)
        else:
            rel = os.path.relpath(abs_path, real_wd)
        if _is_secret_path(rel):
            continue
        out.append({"rel": rel, "abs": abs_path, "bytes": size})

    out.sort(key=lambda c: c["bytes"])
    kept: list[dict] = []
    running = 0
    for c in out:
        if len(kept) >= _ARTIFACT_COUNT_CAP or running + c["bytes"] > _ARTIFACT_TOTAL_CAP:
            continue
        kept.append(c)
        running += c["bytes"]
    return kept


def _sync_artifacts(prefix: str, workdir: str) -> dict:
    """Upload the session's touched-untracked deliverables to S3 under `prefix`.
    Best-effort: a failed file is skipped, never fatal. Returns {count, bytes,
    prefix, keys} — keys lets callers (workflow personas) fetch the deliverables
    without filesystem access to this microVM."""
    if not (workdir and ARTIFACT_BUCKET and prefix):
        return {"count": 0, "bytes": 0, "prefix": None, "keys": []}
    cands = _detect_cloud_artifacts(workdir)
    if not cands:
        return {"count": 0, "bytes": 0, "prefix": None, "keys": []}
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    count = 0
    total = 0
    keys: list[str] = []
    for c in cands:
        try:
            key = prefix + c["rel"].replace(os.sep, "/")
            with open(c["abs"], "rb") as fh:
                s3.upload_fileobj(fh, ARTIFACT_BUCKET, key)
            count += 1
            total += c["bytes"]
            keys.append(key)
        except Exception as exc:  # noqa: BLE001 — one bad file is non-fatal
            logger.warning("artifact_sync_failed",
                           extra={"rel": c["rel"], "error": str(exc)[:200]})
    logger.info("artifacts_synced", extra={"prefix": prefix, "count": count, "bytes": total})
    return {"count": count, "bytes": total, "prefix": prefix if count else None, "keys": keys}


def _sync_turn_artifacts(session_id: str, workdir: str, tenant_id: str | None = None) -> dict:
    """After every turn: harvest generated deliverables to the RESUME artifacts
    prefix (keyed by the cloud session id — exactly what the web Artifacts tab
    lists). This is what makes generated artifacts appear without a Claude-only
    pull-home checkpoint, so codex + non-checkpointed sessions populate too."""
    if not session_id:
        return {"count": 0, "bytes": 0, "prefix": None}
    return _sync_artifacts(f"{_tenant_root(tenant_id)}/resume/{session_id}/artifacts/", workdir)


def _checkpoint_return_bundle(session_id: str, workdir: str,
                              tenant_id: str | None = None) -> dict | None:
    """Return leg for bundle/selfContained sessions: the cloud's commits can't
    ride `git fetch origin` home (origin is read-only or absent), so bundle the
    workspace's full history and upload it. The laptop's pull leg fetches this
    bundle and fast-forwards its branch from it instead of origin. Best-effort:
    returns {key, bytes, branch} or None (no repo / bundle failed)."""
    if not (ARTIFACT_BUCKET and os.path.isdir(os.path.join(workdir, ".git"))):
        return None
    bundle_path = os.path.join(_session_dir(session_id), ".return.bundle")
    try:
        res = subprocess.run(["git", "bundle", "create", bundle_path, "--all", "HEAD"],
                             cwd=workdir, capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            logger.warning("return_bundle_create_failed", extra={"err": res.stderr.strip()[:200]})
            return None
        branch = None
        br = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=workdir,
                            capture_output=True, text=True, timeout=30)
        if br.returncode == 0 and br.stdout.strip() != "HEAD":
            branch = br.stdout.strip()
        key = f"{_tenant_root(tenant_id)}/checkpoint/{session_id}/return.bundle"
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        with open(bundle_path, "rb") as f:
            data = f.read()
        s3.put_object(Bucket=ARTIFACT_BUCKET, Key=key, Body=data,
                      ContentType="application/octet-stream")
        return {"key": key, "bytes": len(data), "branch": branch}
    except Exception as exc:  # noqa: BLE001 — best-effort return leg
        logger.warning("return_bundle_failed", extra={"error": str(exc)[:200]})
        return None
    finally:
        try:
            os.remove(bundle_path)
        except OSError:
            pass


def _checkpoint_artifacts(session_id: str, workdir: str, tenant_id: str | None = None) -> dict:
    """Pull-home leg: upload deliverables under the CHECKPOINT prefix (keyed by the
    resume/claude session id) so the laptop pull brings them home too."""
    return _sync_artifacts(f"{_tenant_root(tenant_id)}/checkpoint/{session_id}/artifacts/", workdir)


# Workflow-origin sessions mint one dir per agent-task, far faster than human
# sessions — without GC the EFS volume grows unbounded. Opportunistic sweep at
# turn start, WORKFLOW SESSIONS ONLY: a dir is eligible only if it carries the
# origin marker below, and the marker's mtime (refreshed every workflow turn)
# is the last-activity record. Human sessions are never touched.
SESSION_TTL_DAYS = int(os.environ.get("SESSION_TTL_DAYS", "14"))
_GC_MARKER = os.path.join(WORKSPACE_ROOT, ".last-session-gc")
_GC_INTERVAL_S = 6 * 3600  # at most one sweep per warm VM per 6h
_WF_ORIGIN_MARKER = ".workflow-session"


def _touch_workflow_marker(session_id: str | None) -> None:
    """Stamp a session dir as workflow-origin and record activity. Called on
    every workflow turn, so the marker's mtime is a reliable last-activity
    signal without walking the tree (EFS walks are too slow for a turn path)."""
    if not session_id:
        return
    try:
        base = _session_dir(session_id)
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, _WF_ORIGIN_MARKER), "w") as f:
            f.write(str(int(time.time())))
    except OSError as exc:
        logger.warning("wf_marker_failed", extra={"error": str(exc)[:200]})


def _gc_stale_sessions() -> None:
    """Best-effort TTL sweep of {WORKSPACE_ROOT}/sessions/*. Only dirs carrying
    the workflow-origin marker are candidates — human Cloud Code sessions must
    stay resumable indefinitely. Staleness = marker mtime older than the TTL.
    Never raises."""
    if SESSION_TTL_DAYS <= 0:
        return
    try:
        now = time.time()
        try:
            if now - os.path.getmtime(_GC_MARKER) < _GC_INTERVAL_S:
                return
        except OSError:
            pass
        with open(_GC_MARKER, "w") as f:
            f.write(str(int(now)))
        sessions_root = os.path.join(WORKSPACE_ROOT, "sessions")
        if not os.path.isdir(sessions_root):
            return
        cutoff = now - SESSION_TTL_DAYS * 86400
        removed = 0
        for name in os.listdir(sessions_root):
            path = os.path.join(sessions_root, name)
            if not os.path.isdir(path):
                continue
            marker = os.path.join(path, _WF_ORIGIN_MARKER)
            try:
                if not os.path.isfile(marker):
                    continue  # human session — never GC
                if os.path.getmtime(marker) < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
                    removed += 1
            except OSError:
                continue
        if removed:
            logger.info("session_gc", extra={"removed": removed, "ttl_days": SESSION_TTL_DAYS})
    except Exception as exc:  # noqa: BLE001 — GC must never affect a turn
        logger.warning("session_gc_failed", extra={"error": str(exc)[:200]})


def _scrub_git_url(text: str) -> str:
    """Strip `user:token@` userinfo out of any URL inside `text`.

    Git echoes the remote URL in its own error output, and a turn's global
    gitconfig rewrites github.com to an `x-access-token:<pat>@` form — so raw
    stderr can carry a credential. Every mirror/clone message goes through this
    before it reaches a log line or an exception. scp-style `git@host:path` has no
    `://` and is left alone (it carries no secret)."""
    return re.sub(r"(://)[^/@\s]*@", r"\1", text or "")


def _is_mirror(path: str) -> bool:
    """True if `path` looks like a usable bare repo (built, not half-built). A
    mirror is published by atomic rename, so this is belt-and-braces against a
    directory left behind by an older/killed build."""
    return os.path.isfile(os.path.join(path, "HEAD")) and os.path.isdir(os.path.join(path, "objects"))


def _acquire_mirror_lock(lock_path: str) -> bool:
    """Take this repo's mirror lock, or return False.

    O_CREAT|O_EXCL, deliberately NOT fcntl.flock: the lock is shared across
    microVMs through EFS and flock semantics over NFS are unreliable. Waits up to
    _MIRROR_LOCK_WAIT_S for the holder, then gives up so a turn is never stalled
    behind someone else's build (the caller falls back to a plain clone). A lock
    whose mtime exceeds _MIRROR_LOCK_STALE_S (> MIRROR_BUILD_TIMEOUT_S, so a live
    build is never stolen) was orphaned by a dead VM and is reclaimed — by atomic
    rename, so two racing waiters can't both believe they stole it."""
    deadline = time.time() + _MIRROR_LOCK_WAIT_S
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            try:
                os.write(fd, str(int(time.time())).encode())
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            pass
        except OSError as exc:
            logger.warning("mirror_lock_failed", extra={"error": str(exc)[:200]})
            return False
        try:
            if time.time() - os.path.getmtime(lock_path) > _MIRROR_LOCK_STALE_S:
                victim = f"{lock_path}.stale.{uuid.uuid4().hex[:8]}"
                os.rename(lock_path, victim)  # atomic — only one racer wins
                os.unlink(victim)
                logger.info("mirror_lock_stale_steal", extra={"lock": os.path.basename(lock_path)})
                continue
        except OSError:
            pass  # released or stolen between checks — just retry the create
        if time.time() >= deadline:
            return False
        time.sleep(_MIRROR_LOCK_POLL_S)


def _release_mirror_lock(lock_path: str) -> None:
    try:
        os.unlink(lock_path)
    except OSError:
        pass


def _ensure_mirror(url: str, slug: str) -> str | None:
    """Return this repo's shared bare mirror (building/refreshing it first), or
    None if the cache can't be used — the caller then does a plain clone.

    The mirror is an OBJECT CACHE, not a workspace: one per repo under
    {WORKSPACE_ROOT}/.mirrors, shared by every session on this EFS mount. Session
    checkouts borrow its objects via `git clone --reference`, so the only bytes on
    the wire are whatever origin has beyond the mirror.

    Never raises. Never `git gc`s the mirror: live checkouts reach its objects
    through .git/objects/info/alternates, so pruning objects would break them
    (`fetch --prune` prunes remote-tracking REFS only, which is safe)."""
    if not WORKSPACE_MIRROR_ENABLED:
        return None
    mirror = os.path.join(MIRROR_ROOT, f"{slug}.git")
    stamp = os.path.join(MIRROR_ROOT, f"{slug}.fetched")
    lock = os.path.join(MIRROR_ROOT, f"{slug}.lock")

    def _fresh() -> bool:
        try:
            return time.time() - os.path.getmtime(stamp) < MIRROR_REFRESH_TTL_S
        except OSError:
            return False

    def _stamp() -> None:
        try:
            with open(stamp, "w") as f:
                f.write(str(int(time.time())))
        except OSError:
            pass  # a missing stamp only costs an extra refresh next time

    try:
        os.makedirs(MIRROR_ROOT, exist_ok=True)
    except OSError as exc:
        logger.info("mirror_fallback", extra={"slug": slug, "reason": f"mkdir: {str(exc)[:120]}"})
        return None

    # Fast path: a built mirror refreshed within the TTL needs no lock at all.
    if _is_mirror(mirror) and _fresh():
        return mirror

    if not _acquire_mirror_lock(lock):
        logger.info("mirror_fallback", extra={"slug": slug, "reason": "lock_timeout"})
        return None
    try:
        # Double-check under the lock: the holder we waited on may have just done
        # the exact work we were about to redo.
        if _is_mirror(mirror):
            if _fresh():
                return mirror
            res = subprocess.run(["git", "-C", mirror, "fetch", "--prune"],
                                 capture_output=True, text=True, timeout=MIRROR_BUILD_TIMEOUT_S)
            if res.returncode != 0:
                logger.info("mirror_fallback", extra={
                    "slug": slug, "reason": f"fetch: {_scrub_git_url(res.stderr.strip())[:160]}"})
                return None
            _stamp()
            logger.info("mirror_refresh", extra={"slug": slug})
            return mirror
        # Build it. Clone to a temp path and publish by atomic rename so a killed
        # build can never leave a half-written mirror that looks valid.
        tmp = f"{mirror}.tmp.{uuid.uuid4().hex[:8]}"
        try:
            res = subprocess.run(["git", "clone", "--mirror", url, tmp],
                                 capture_output=True, text=True, timeout=MIRROR_BUILD_TIMEOUT_S)
            if res.returncode != 0:
                logger.info("mirror_fallback", extra={
                    "slug": slug, "reason": f"build: {_scrub_git_url(res.stderr.strip())[:160]}"})
                return None
            os.rename(tmp, mirror)
            _stamp()
            logger.info("mirror_build", extra={"slug": slug})
            return mirror
        finally:
            if os.path.exists(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
    except Exception as exc:  # noqa: BLE001 — the cache is an optimization, never a failure mode
        logger.info("mirror_fallback", extra={
            "slug": slug, "reason": f"{type(exc).__name__}: {_scrub_git_url(str(exc))[:160]}"})
        return None
    finally:
        _release_mirror_lock(lock)


def _reset_workdir(wd: str) -> None:
    """Clear a partial checkout. `git clone` refuses a non-empty target, so any
    failed attempt must be swept before the next one."""
    if os.path.exists(wd):
        shutil.rmtree(wd, ignore_errors=True)


# Faults seen when many sessions cloned the same repo onto one EFS mount at once.
# They are transient by nature (the mount, not the repo), so one retry is worth it.
_TRANSIENT_CLONE_ERRS = (
    "bad file descriptor", "invalid index-pack", "index-pack failed",
    "input/output error", "early eof", "unable to read", "remote end hung up",
    "connection reset", "timed out",
)


def _plain_clone(url: str, wd: str, slug: str) -> str:
    """The pre-mirror clone path, kept as the always-available fallback so a mirror
    problem can never be worse than today. One retry on the transient mount-fault
    class above; anything else fails fast."""
    last = ""
    for attempt in (1, 2):
        try:
            res = subprocess.run(["git", "clone", url, wd], capture_output=True, text=True,
                                 timeout=CLONE_TIMEOUT_S)
            if res.returncode == 0:
                return wd
            last = res.stderr.strip()
        except subprocess.TimeoutExpired:
            last = f"timed out after {CLONE_TIMEOUT_S}s"
        low = last.lower()
        if attempt == 2 or not any(e in low for e in _TRANSIENT_CLONE_ERRS):
            break
        logger.warning("workspace_clone_retry",
                       extra={"slug": slug, "error": _scrub_git_url(last)[:200]})
        _reset_workdir(wd)
    raise RuntimeError(f"git clone failed: {_scrub_git_url(last)[:400]}")


def _ensure_workspace(repo: str | None, session_id: str | None = None,
                      clone_url: str | None = None) -> str:
    """Return the working dir for this session. If repo given and not yet cloned,
    clone it under the session's own dir (on EFS, so a re-invoke with the same
    runtimeSessionId finds it warm — no re-clone).

    clone_url overrides the URL derived from repo — used by the port handoff so
    the cloud clones the laptop's exact origin (which may be a public upstream the
    account has no push rights to; bundle mode then layers the laptop's commits)."""
    base = _session_dir(session_id)
    # A non-github / self-hosted port can ship clone_url WITHOUT an owner/name
    # repo. Treat clone_url as the clonable target then (slug derived from it).
    if not repo and not clone_url:
        # A chat resume with no repo just needs a cwd. Tolerate a degraded EFS
        # mount (makedirs can raise FileExistsError when the path exists but isn't
        # a dir) — fall back to any usable existing dir rather than 500 the turn.
        try:
            os.makedirs(base, exist_ok=True)
            return base
        except OSError as exc:
            logger.warning("workspace_mkdir_failed", extra={"base": base, "error": str(exc)[:200]})
            if os.path.isdir(base):
                return base
            return WORKSPACE_ROOT if os.path.isdir(WORKSPACE_ROOT) else "/tmp"
    if repo and not _valid_repo(repo):
        raise ValueError(
            f"'{repo}' is not a valid repository. Use 'owner/name' or a full "
            f"clone URL. (A bare owner can't be cloned — leave repo empty and "
            f"ask the agent to 'gh repo list {repo}' instead.)"
        )
    slug = _slugify_repo(repo or clone_url or "default")
    wd = os.path.join(base, slug)
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("workspace_warm", extra={"slug": slug})
        return wd
    os.makedirs(base, exist_ok=True)
    url = clone_url or (repo if repo.startswith(("http://", "https://", "git@")) else f"https://github.com/{repo}.git")
    logger.info("workspace_cloning", extra={"slug": slug, "url": url.split("@")[-1]})
    # Borrow objects from this repo's shared bare mirror when we have one. The
    # mirror is fed the credential-stripped URL so no token is ever persisted in
    # its remote config (the turn's global insteadOf rewrite supplies auth); the
    # session clone keeps the caller's URL verbatim, exactly as before.
    mirror = _ensure_mirror(_scrub_git_url(url), slug)
    if mirror:
        cmd = ["git", "clone", "--reference", mirror]
        if MIRROR_DISSOCIATE:
            cmd.append("--dissociate")
        cmd += [url, wd]
        reason = ""
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=CLONE_TIMEOUT_S)
            if res.returncode == 0:
                logger.info("mirror_hit", extra={"slug": slug, "dissociate": MIRROR_DISSOCIATE})
                return wd
            reason = f"reference_clone: {_scrub_git_url(res.stderr.strip())[:160]}"
        except subprocess.TimeoutExpired:
            reason = f"reference_clone timed out after {CLONE_TIMEOUT_S}s"
        except OSError as exc:
            reason = f"reference_clone: {type(exc).__name__}: {str(exc)[:120]}"
        logger.info("mirror_fallback", extra={"slug": slug, "reason": reason})
        _reset_workdir(wd)  # a failed attempt can leave a partial dir; clone needs it clean
    return _plain_clone(url, wd, slug)


def _safe_branch_name(name: str | None) -> str:
    """A git-legal local branch name. Falls back to a stable default so bundle
    mode always lands on a NAMED branch (never detached HEAD) — that's what lets
    pull-home bring cloud commits back via a real branch."""
    cand = (name or "").strip()
    if re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", cand) and not cand.startswith("-"):
        return cand
    return "cloud-code/ported-work"


def _apply_resume_bundle(s3_key: str, workdir: str, session_id: str | None,
                         branch: str | None = None) -> bool:
    """Bundle mode: download the laptop's git bundle from S3 and layer its commits
    onto the freshly-cloned upstream. The bundle holds base..HEAD (the laptop's
    in-flight commits); we fetch all its refs and check out its tip ON A NAMED
    BRANCH so the workspace matches the laptop without push access to origin —
    and so checkpoint/pull-home can return cloud commits on a real branch (a
    detached HEAD would make pull try origin/HEAD and lose them).

    Idempotent per warm microVM via a marker. Best-effort: a bad/missing bundle
    leaves the clean clone in place (the agent can still work) rather than failing
    the turn. Returns True if the bundle's work was checked out."""
    if not (s3_key and ARTIFACT_BUCKET and os.path.isdir(os.path.join(workdir, ".git"))):
        return False
    marker = os.path.join(_session_dir(session_id), ".bundle-applied")
    try:
        if os.path.exists(marker):
            with open(marker) as f:
                if f.read().strip() == s3_key:
                    return True  # already applied on this warm VM
    except OSError:
        pass
    try:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001 — missing bundle is non-fatal
        logger.warning("bundle_fetch_failed", extra={"key": s3_key, "error": str(exc)[:200]})
        return False

    bundle_path = os.path.join(workdir, ".cloud-code-work.bundle")
    try:
        with open(bundle_path, "wb") as f:
            f.write(raw)
        # Verify it's a real bundle before fetching (clean error if not).
        verify = subprocess.run(["git", "bundle", "verify", bundle_path], cwd=workdir,
                                capture_output=True, text=True, timeout=60)
        if verify.returncode != 0:
            logger.warning("bundle_verify_failed", extra={"err": verify.stderr.strip()[:200]})
            return False
        # Fetch every ref the bundle carries into a namespace, then check out its tip.
        fetch = subprocess.run(
            ["git", "fetch", bundle_path, "+refs/heads/*:refs/remotes/cc-port/*", "HEAD"],
            cwd=workdir, capture_output=True, text=True, timeout=120)
        if fetch.returncode != 0:
            logger.warning("bundle_fetch_refs_failed", extra={"err": fetch.stderr.strip()[:200]})
            return False
        # FETCH_HEAD is the bundle's HEAD (the laptop's tip). Land it on a NAMED
        # branch (-B = create or reset) so the workspace isn't on a detached HEAD —
        # checkpoint reads a real branch name and pull-home can fast-forward it.
        local_branch = _safe_branch_name(branch)
        co = subprocess.run(["git", "checkout", "-B", local_branch, "FETCH_HEAD"], cwd=workdir,
                            capture_output=True, text=True, timeout=60)
        if co.returncode != 0:
            logger.warning("bundle_checkout_failed", extra={"err": co.stderr.strip()[:200]})
            return False
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w") as f:
            f.write(s3_key)
        logger.info("bundle_applied", extra={"key": s3_key, "branch": local_branch})
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("bundle_apply_failed", extra={"error": str(exc)[:200]})
        return False
    finally:
        try:
            os.remove(bundle_path)
        except OSError:
            pass


def _purge_session(session_id: str, conversation_id: str | None = None,
                   cli: str = "claude", tenant_id: str | None = None) -> dict:
    """Reclaim everything a session left on disk, so deleting it in the UI also
    frees the backend storage it was paying for. Three stores:

      • EFS  — the session's isolated dir (clone, resume hint, markers) at
               sessions/<id>/. The big one: a full clone can be 100s of MB.
      • EFS  — the conversation transcript, which lives OUTSIDE that dir:
                 claude → $CLAUDE_CONFIG_DIR/projects/<workdir-slug>/<id>.jsonl
                 codex  → $CODEX_HOME/sessions/**/<...id...>  (rollout files)
               We don't know the claude slug here, but the id is a unique filename,
               so we glob for it; for codex we match files whose name carries the id.
      • S3   — the ported transcript + git bundle (resume/<sessionId>/) and any
               checkpoint uploads. Checkpoints are keyed by the CONVERSATION id
               (checkpoint/<conversationId>/), not the runtime session id — purge
               both forms so a checkpointed session doesn't leak its transcript.

    Idempotent: a missing dir / already-deleted key is success, so a double-delete
    or a purge of a session that never warmed a VM is harmless. But a FAILED
    operation (EFS unavailable, S3 AccessDenied) is reported via ok=False so the
    reaper raises and the stream redelivers — returning success on a swallowed
    failure would permanently leak the storage (the lifecycle backstop doesn't
    cover EFS or tenant-scoped keys). The live microVM is NOT torn down here —
    the caller stops the runtime session separately."""
    removed = {"efs": False, "s3_objects": 0, "transcripts": 0, "ok": True}
    # EFS: rm -rf the per-session dir. _session_dir sanitizes the id, and we re-check
    # the result stays under sessions/ so a crafted id can't escape the namespace.
    sdir = _session_dir(session_id)
    sessions_root = os.path.join(WORKSPACE_ROOT, "sessions")
    if os.path.realpath(sdir).startswith(os.path.realpath(sessions_root) + os.sep):
        try:
            if os.path.isdir(sdir):
                shutil.rmtree(sdir)
                removed["efs"] = True
        except OSError as exc:
            removed["ok"] = False
            logger.warning("purge_efs_failed", extra={"session": session_id, "error": str(exc)[:200]})
    # EFS transcript: the conversation log lives OUTSIDE sessions/<id> (keyed by
    # the cwd slug for claude, by the rollout path for codex), so rmtree above
    # misses it. The conversation id is unique, so glob for files carrying it.
    if conversation_id:
        safe_cid = re.sub(r"[^A-Za-z0-9._-]", "-", conversation_id)
        # Escape the id before embedding it in a glob: a raw id containing glob
        # metacharacters (e.g. a ported session with claudeSessionId "*") would
        # otherwise expand and delete EVERY session's transcript. The directory
        # components stay literal; only the id substring is escaped.
        glob_cid = glob.escape(conversation_id)
        if cli == "codex":
            # Codex rollout files persist under $CODEX_HOME/sessions/**; the id is
            # embedded in the filename (rollout-...-<uuid>.jsonl). Match it
            # anywhere in the tree, and also try the sanitized id form.
            patterns = [
                os.path.join(CODEX_HOME, "sessions", "**", f"*{glob_cid}*"),
                os.path.join(CODEX_HOME, "sessions", "**", f"*{glob.escape(safe_cid)}*"),
            ]
        else:
            # Claude: $CLAUDE_CONFIG_DIR/projects/<workdir-slug>/<id>.jsonl. The
            # slug derives from the workdir's realpath — and the SAME conversation
            # id can be ported into MULTIPLE cloud sessions, each with its own
            # per-session workdir. Only delete transcripts whose slug belongs to
            # THIS session's dir (sessions/<sid>/...), so purging one cloud
            # session can't destroy a sibling's still-active transcript.
            session_slug_prefix = _claude_project_slug(sdir)
            patterns = [os.path.join(CLAUDE_CONFIG_DIR, "projects",
                                     f"{session_slug_prefix}*",
                                     f"{glob.escape(safe_cid)}.jsonl")]
        try:
            seen: set[str] = set()
            for pat in patterns:
                for path in glob.glob(pat, recursive=True):
                    if path in seen or not os.path.isfile(path):
                        continue
                    seen.add(path)
                    try:
                        os.remove(path)
                        removed["transcripts"] += 1
                    except OSError:
                        pass
        except OSError as exc:
            removed["ok"] = False
            logger.warning("purge_transcript_failed",
                           extra={"session": session_id, "cli": cli, "error": str(exc)[:200]})
    # S3: delete every object under the session's resume + checkpoint prefixes.
    # Keys are tenant-scoped; "default" resolves to the legacy unprefixed layout
    # (see _tenant_root), so pre-tenancy sessions are reclaimed by the same pass.
    if ARTIFACT_BUCKET:
        s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        tp = _tenant_root(tenant_id)
        prefixes = [
            f"{tp}/resume/{session_id}/",
            f"{tp}/checkpoint/{session_id}/",
        ]
        if conversation_id:
            prefixes.append(f"{tp}/checkpoint/{conversation_id}/")
        for prefix in prefixes:
            try:
                paginator = s3.get_paginator("list_objects_v2")
                for page in paginator.paginate(Bucket=ARTIFACT_BUCKET, Prefix=prefix):
                    keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                    if keys:
                        s3.delete_objects(Bucket=ARTIFACT_BUCKET, Delete={"Objects": keys, "Quiet": True})
                        removed["s3_objects"] += len(keys)
            except Exception as exc:  # noqa: BLE001 — recorded so the reaper retries
                removed["ok"] = False
                logger.warning("purge_s3_failed", extra={"prefix": prefix, "error": str(exc)[:200]})
    logger.info("session_purged", extra={"session": session_id, **removed})
    return removed


def _selfcontained_workspace(session_id: str | None) -> str | None:
    """Path of an already-rebuilt self-contained repo for this session, or None.

    Self-contained ports live at `<session>/workspace` (a fixed name, NOT a
    repo-slug), set by _rebuild_from_bundle. Later turns/checkpoint omit
    git_mode + resume_bundle and carry no repo, so we detect the warm workspace
    by its .git rather than relying on the caller re-sending the handoff fields."""
    if not session_id:
        return None
    wd = os.path.join(_session_dir(session_id), "workspace")
    return wd if os.path.isdir(os.path.join(wd, ".git")) else None


def _rebuild_from_bundle(s3_key: str, session_id: str | None,
                         branch: str | None = None) -> str:
    """Self-contained mode: rebuild a STANDALONE repo from a `git bundle --all`
    the laptop shipped (no origin, no clone). `git clone <bundle>` reconstructs
    every branch + the full history into the session's EFS workspace; we then land
    on a named branch so the agent works on a real branch (and pull-home works).

    Idempotent + warm-safe: if the workspace already has a .git (a warm microVM, or
    the pre-warm pass already rebuilt it), reuse it. Returns the workdir.

    Raises on a missing/corrupt bundle — unlike bundle mode (which can fall back to
    the clean clone), self-contained has NO other source for the code, so a failure
    here is a real setup error the caller surfaces as 500."""
    base = _session_dir(session_id)
    wd = os.path.join(base, "workspace")
    if os.path.isdir(os.path.join(wd, ".git")):
        logger.info("selfcontained_warm")
        return wd
    if not (s3_key and ARTIFACT_BUCKET):
        raise RuntimeError("self-contained port is missing its bundle (no resume_bundle/bucket)")
    os.makedirs(base, exist_ok=True)

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    obj = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=s3_key)
    raw = obj["Body"].read()
    bundle_path = os.path.join(base, ".cloud-code-all.bundle")
    try:
        with open(bundle_path, "wb") as f:
            f.write(raw)
        # Clone the bundle → a real repo with all refs; HEAD is the laptop's tip.
        # (No separate `git bundle verify`: that needs to run inside a repo, which
        # the runtime cwd isn't — and clone validates the bundle anyway, failing
        # cleanly with the same diagnostic on a corrupt/truncated file.)
        clone = subprocess.run(["git", "clone", bundle_path, wd],
                               capture_output=True, text=True, timeout=300)
        if clone.returncode != 0:
            raise RuntimeError(f"bundle clone failed: {clone.stderr.strip()[:300]}")
        # Drop the 'origin' the clone set to the local bundle file (it's gone after
        # this function) so the workspace is truly standalone — `git remote add`
        # later won't collide, and nothing points at a vanished path.
        subprocess.run(["git", "remote", "remove", "origin"], cwd=wd,
                       capture_output=True, text=True, timeout=30)
        # Land on a NAMED branch (the bundle clone may be detached on HEAD).
        local_branch = _safe_branch_name(branch)
        subprocess.run(["git", "checkout", "-B", local_branch], cwd=wd,
                       capture_output=True, text=True, timeout=60)
        logger.info("selfcontained_rebuilt", extra={"branch": local_branch})
        return wd
    finally:
        try:
            os.remove(bundle_path)
        except OSError:
            pass


def _checkout_branch(workdir: str, branch: str) -> None:
    """Fetch + check out the branch the laptop pushed its in-flight work to.
    Best-effort: a fresh clone lands on the default branch, so we move to the
    ported branch before the agent resumes. Non-fatal if it fails (agent can
    recover via its own git tools)."""
    if not os.path.isdir(os.path.join(workdir, ".git")):
        return
    safe = branch.strip()
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", safe or ""):
        logger.warning("checkout_branch_rejected", extra={"branch": branch[:60]})
        return
    subprocess.run(["git", "fetch", "origin", safe], cwd=workdir,
                   capture_output=True, text=True, timeout=120)
    res = subprocess.run(["git", "checkout", safe], cwd=workdir,
                         capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        logger.warning("checkout_branch_failed", extra={"branch": safe, "err": res.stderr.strip()[:200]})
    else:
        logger.info("checkout_branch_ok", extra={"branch": safe})


# ─── CLI runners ──────────────────────────────────────────────────────────────


def _otel_turn_env(session_id: str | None) -> dict:
    """Resource attributes for one turn's telemetry. session.id (the
    runtimeSessionId) rides at resource level; the collector's
    transform/normalize copies it down to every span/log attribute so the
    dashboard groups CLI usage by runtime session — same convention as the
    fleet agents' ADOT spans."""
    if not session_id:
        return {}
    return {"OTEL_RESOURCE_ATTRIBUTES": f"session.id={session_id}"}


def _run_claude(prompt: str, workdir: str, claude_session_id: str | None,
                session_id: str | None = None, model: str | None = None) -> dict:
    """Run one Claude Code turn. Resume the conversation when a prior
    claude_session_id is supplied (same microVM keeps its ~/.claude state)."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)

    # `claude --print` does NOT auto-load a project .mcp.json (needs interactive
    # approval). _build_claude_args passes --mcp-config explicitly; it's variadic,
    # so the positional prompt must come last (appended here).
    args = _build_claude_args(config_dir, claude_session_id, stream=False, model=model) + [prompt]
    env = {**os.environ, "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CONFIG_DIR": config_dir,
           **_otel_turn_env(session_id)}

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


def _build_claude_args(config_dir: str, claude_session_id: str | None, stream: bool,
                       model: str | None = None) -> list:
    """Shared argv for a Claude turn. stream=True emits realtime stream-json.
    model overrides CLAUDE_MODEL for this turn (pipeline personas carry their
    own per-persona model)."""
    args = ["claude", "--print"]
    mcp_config = os.path.join(config_dir, ".mcp.json")
    if os.path.isfile(mcp_config):
        args += ["--mcp-config", mcp_config]
    args += ["--dangerously-skip-permissions",
             "--model", model or CLAUDE_MODEL, "--max-turns", os.environ.get("MAX_TURNS", "100")]
    if stream:
        # --include-partial-messages emits token-level content_block_delta frames
        # (without it, claude sends whole message blocks → one chunk at the end).
        args += ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    else:
        args += ["--output-format", "json"]
    if claude_session_id:
        args += ["--resume", claude_session_id]
    return args


def _stream_claude(prompt: str, workdir: str, claude_session_id: str | None, repo: str | None = None,
                   session_id: str | None = None, tenant_id: str | None = None,
                   model: str | None = None):
    """Generator yielding SSE lines for a Claude turn as it runs.

    Parses claude stream-json line-by-line: assistant text deltas → 'text'
    events, the final 'result' → a terminal 'done' event carrying the full text
    and the claude session id (for resume). The UI renders text incrementally.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(WORKSPACE_ROOT, ".claude-data"))
    os.makedirs(config_dir, exist_ok=True)
    args = _build_claude_args(config_dir, claude_session_id, stream=True, model=model) + [prompt]
    env = {**os.environ, "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CONFIG_DIR": config_dir,
           **_otel_turn_env(session_id)}

    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    proc = subprocess.Popen(args, cwd=workdir, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL, bufsize=1)
    # Same watchdog as _stream_codex: the loop blocks on readline, so a wedged
    # claude (or a command it spawned holding stdout) would pin the microVM
    # HealthyBusy forever — and now that workflow personas ride this path, it
    # would strand their agent-task claim too. Kill at the cap so the loop
    # unwinds and a terminal frame reaches the caller.
    timed_out = threading.Event()

    def _kill_on_timeout():
        timed_out.set()
        proc.kill()
    watchdog = threading.Timer(TURN_TIMEOUT_S, _kill_on_timeout)
    watchdog.start()
    new_session_id: str | None = claude_session_id
    full_text: list[str] = []
    block_has_text = False  # did the current text block emit anything?
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
                et = ev.get("type")
                if et == "content_block_delta":
                    delta = ev.get("delta", {})
                    txt = delta.get("text")  # ignore thinking deltas
                    if txt:
                        full_text.append(txt)
                        block_has_text = True
                        yield sse({"type": "text", "text": txt})
                elif et == "content_block_stop" and block_has_text:
                    # Each text block is a distinct assistant message (often with
                    # a tool call between them). Separate with a blank line so the
                    # UI renders paragraphs, not run-on sentences.
                    block_has_text = False
                    full_text.append("\n\n")
                    yield sse({"type": "text", "text": "\n\n"})
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
    finally:
        watchdog.cancel()
    if timed_out.is_set():
        err = f"claude timed out after {TURN_TIMEOUT_S}s"
        yield sse({"type": "error", "error": err})
        yield sse({"type": "done", "response": f"⚠ {err}", "claude_session_id": new_session_id})
        return
    if proc.returncode not in (0, None):
        err = (proc.stderr.read() or "")[:600] if proc.stderr else ""
        yield sse({"type": "error", "error": f"claude exited {proc.returncode}: {err}"})
        return
    # Persist {claude_session_id → repo} so a later resume recovers the cwd.
    _remember_session(new_session_id, repo)
    # Update the Terminal resume hint now the id is known (new chats learn it
    # here), so opening the Terminal auto-resumes this conversation server-side.
    if new_session_id:
        _write_resume_launch_hint(workdir, new_session_id, session_id)
    # Harvest deliverables to the resume prefix so the Artifacts tab populates
    # without a pull-home. Best-effort — never breaks the stream's done frame.
    artifact_keys: list = []
    try:
        artifact_keys = _sync_turn_artifacts(session_id, workdir, tenant_id).get("keys") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("turn_artifact_sync_failed", extra={"error": str(exc)[:200]})
    done = {"type": "done", "response": "".join(full_text), "claude_session_id": new_session_id}
    if artifact_keys:
        done["artifacts"] = artifact_keys
    logger.info("turn_done", extra={"cli": "claude", "chars": len(done["response"]), "stream": True})
    yield sse(done)


def _run_codex(prompt: str, workdir: str, codex_session_id: str | None,
               session_id: str | None = None, model: str | None = None) -> dict:
    """Run one Codex turn via the Mantle launcher (GPT-5.5). Resumes the prior
    conversation when codex_session_id (a codex thread_id) is supplied.

    We surface codex's thread_id through the same `claude_session_id` field the
    server returns, so the caller's resume handle is CLI-agnostic."""
    env = {**os.environ, "WORKSPACE_DIR": workdir, **_otel_turn_env(session_id)}
    if model:
        env["CODEX_MODEL"] = model  # run-codex.sh reads CODEX_MODEL
    args = ["/app/run-codex.sh", prompt]
    if codex_session_id:
        args.append(codex_session_id)
    proc = subprocess.run(args, cwd=workdir, env=env, capture_output=True,
                          text=True, timeout=TURN_TIMEOUT_S, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        # codex exec --json writes its real failure to STDOUT (a {"type":"error"}
        # / {"type":"turn.failed"} JSONL frame), not stderr — stderr only carries
        # run-codex.sh's banner. Surface the last error frame so the turn error is
        # diagnosable instead of an opaque "codex exited 1: <banner>".
        detail = ""
        for line in reversed(proc.stdout.splitlines()):
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("type") in ("error", "turn.failed"):
                detail = str(o.get("message") or (o.get("error") or {}).get("message") or "")[:400]
                break
        banner = proc.stderr.strip()[:200]
        raise RuntimeError(f"codex exited {proc.returncode}: {detail or banner}")
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


def _stream_codex(prompt: str, workdir: str, codex_session_id: str | None,
                  repo: str | None = None, session_id: str | None = None,
                  tenant_id: str | None = None):
    """Generator yielding SSE lines for a Codex turn as it runs.

    codex exec --json emits per-STEP JSONL (not token deltas): thread.started,
    item.started/completed (command_execution, reasoning, agent_message), and a
    final turn.completed/turn.failed. We map those to the same {type:text|done|
    error} SSE frames _stream_claude uses:
      • agent_message text            → 'text' (the reply itself)
      • command_execution / reasoning → 'text' as a dim status line so the user
                                        sees live progress instead of a spinner
      • turn.completed                → 'done' carrying the full reply + thread_id
    Streaming also keeps the connection alive, so a long codex turn no longer
    trips the front-end proxy's idle timeout (the old buffered-path failure)."""
    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    env = {**os.environ, "WORKSPACE_DIR": workdir}
    args = ["/app/run-codex.sh", prompt]
    if codex_session_id:
        args.append(codex_session_id)

    proc = subprocess.Popen(args, cwd=workdir, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL, bufsize=1)
    # Watchdog: the buffered runner enforced TURN_TIMEOUT_S via subprocess.run;
    # this loop blocks on readline, so a codex (or an invoked command) that wedges
    # without closing stdout would pin the microVM HealthyBusy forever. Kill the
    # process at the cap so the loop unwinds and a terminal frame is emitted.
    timed_out = threading.Event()

    def _kill_on_timeout():
        timed_out.set()
        proc.kill()
    watchdog = threading.Timer(TURN_TIMEOUT_S, _kill_on_timeout)
    watchdog.start()
    thread_id: str | None = codex_session_id
    reply_parts: list[str] = []          # only agent_message text = the actual reply
    emitted_any_reply = False            # did we stream reply text (vs only status)?
    fail_detail: str | None = None
    try:
        for line in proc.stdout:  # line-buffered: yields as codex emits each frame
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "thread.started" and obj.get("thread_id"):
                thread_id = obj["thread_id"]
                # A fresh thread.started after an error frame is run-codex.sh
                # RETRYING (cold-engine Mantle errors). The prior attempt's
                # failure must not poison a successful retry's result.
                fail_detail = None
                continue
            if t in ("error", "turn.failed"):
                fail_detail = str(obj.get("message") or (obj.get("error") or {}).get("message") or "")[:400]
                continue
            if t == "turn.completed":
                fail_detail = None  # a completed turn supersedes any earlier attempt's error
                continue
            # item.started/completed carry the step payload. Older codex builds
            # wrap it as {"msg":{...}} with NO top-level type — treat a msg-shaped
            # agent_message as completed (there are no partial frames there).
            item = obj.get("item") or obj.get("msg") or {}
            itype = item.get("type")
            if itype == "agent_message":
                # The reply. completed frame has the whole message; stream it once.
                if t == "item.completed" or (t is None and "msg" in obj):
                    msg = item.get("text") or item.get("message") or ""
                    if msg:
                        reply_parts.append(msg)
                        emitted_any_reply = True
                        yield sse({"type": "text", "text": msg})
            elif itype == "command_execution" and t == "item.started":
                cmd = str(item.get("command") or "").strip()
                if cmd:
                    yield sse({"type": "text", "text": f"\n`$ {cmd[:200]}`\n"})
            elif itype == "reasoning" and t == "item.completed":
                note = str(item.get("text") or "").strip()
                if note:
                    yield sse({"type": "text", "text": f"\n_{note[:300]}_\n"})
        proc.wait(timeout=30)
    except Exception as exc:  # noqa: BLE001
        yield sse({"type": "error", "error": str(exc)[:600]})
        return
    finally:
        watchdog.cancel()
    if timed_out.is_set():
        err = f"codex timed out after {TURN_TIMEOUT_S}s"
        yield sse({"type": "error", "error": err})
        yield sse({"type": "done", "response": f"⚠ {err}", "claude_session_id": thread_id})
        return
    if proc.returncode not in (0, None) or fail_detail:
        banner = ((proc.stderr.read() or "")[:200] if proc.stderr else "")
        err = fail_detail or banner or f"codex exited {proc.returncode}"
        yield sse({"type": "error", "error": f"codex: {err}"})
        yield sse({"type": "done", "response": f"⚠ codex: {err}",
                   "claude_session_id": thread_id})
        return
    _remember_session(thread_id, repo)
    # Update the Terminal resume hint now the thread id is known, so opening the
    # Terminal auto-resumes this codex conversation server-side.
    if thread_id:
        _write_resume_launch_hint(workdir, thread_id, session_id, cli="codex")
    artifact_keys: list = []
    try:
        artifact_keys = _sync_turn_artifacts(session_id, workdir, tenant_id).get("keys") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("turn_artifact_sync_failed", extra={"error": str(exc)[:200]})
    done = {"type": "done",
            "response": "".join(reply_parts) if emitted_any_reply else "",
            "claude_session_id": thread_id}
    if artifact_keys:
        done["artifacts"] = artifact_keys
    logger.info("turn_done", extra={"cli": "codex", "chars": len(done["response"]), "stream": True})
    yield sse(done)


# ─── Async turns (submit + poll) ──────────────────────────────────────────────
#
# Workflow personas used to hold ONE InvokeAgentRuntime open for the whole coding
# turn. That connection dies silently when no bytes flow for ~15 min (proved
# 2026-08-27: a 17-min turn emitting text every 60s survives; the same turn
# silent through two `sleep 500`s finishes server-side but the caller never gets
# a frame). Long quiet stretches — builds, big writes — are normal for coding
# turns, so the connection itself is the wrong transport. Submit+poll replaces
# it: submit returns a turn_id immediately, a runner thread journals the result
# to EFS, and each sub-second poll reads the journal. No long-lived connection
# exists, and a result written just before a microVM recycle is still collected
# by the next poll off the shared EFS.


# Authoritative liveness for turns on THIS microVM. Session affinity routes a
# session's polls to the same VM as its submits, so membership here is ground
# truth for "the runner thread is still executing" — independent of EFS, whose
# write failures can make a journal look stale while the CLI is alive. A VM
# recycle empties it, which is precisely the case where "dead" is true.
_ACTIVE_TURNS: dict = {}


def _turn_journal_path(session_id: str | None, turn_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", turn_id)[:80]
    return os.path.join(_session_dir(session_id), ".turns", f"{safe}.json")


def _journal_write(path: str, record: dict) -> bool:
    """Atomic-enough journal write (tmp + rename; EFS rename is atomic within a
    directory). Never raises — a failed beat must not kill the runner thread —
    but reports success so the submit path can refuse to start a turn whose
    journal can't be seeded (an accepted turn with no journal reads as 'unknown'
    and would get resubmitted while still running)."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w") as f:
            json.dump(record, f)
        os.replace(tmp, path)
        return True
    except OSError as exc:
        logger.warning("turn_journal_write_failed", extra={"error": str(exc)[:200]})
        return False


def _run_turn_async(turn_id: str, journal: str, cli: str, prompt: str, workdir: str,
                    claude_session_id: str | None, repo: str | None,
                    session_id: str | None, tenant_id: str | None,
                    model: str | None) -> None:
    """Runner thread body: drive one CLI turn via the existing streaming
    generators (they carry the watchdog, artifact harvest, and session-id
    bookkeeping), heartbeat the journal while it runs, then journal the terminal
    frame. The generator's SSE framing is an implementation detail here — we
    consume frames directly, no HTTP involved."""
    # Prune finished entries older than an hour so a long-lived VM doesn't
    # accumulate every done record it ever served.
    cutoff = int(time.time()) - 3600
    for tid in [t for t, r in _ACTIVE_TURNS.items()
                if r.get("status") == "done" and int(r.get("finished_at") or 0) < cutoff]:
        _ACTIVE_TURNS.pop(tid, None)
    _ACTIVE_TURNS[turn_id] = {"status": "running", "turn_id": turn_id, "cli": cli,
                              "started_at": int(time.time())}
    beat = {"status": "running", "turn_id": turn_id, "cli": cli,
            "started_at": int(time.time()), "heartbeat": int(time.time())}
    stop_beating = threading.Event()
    # Serializes heartbeat vs terminal writes: once `finished` flips under the
    # lock, a delayed beat can never overwrite the done record with "running"
    # (which a poll would later read as a stale heartbeat → dead → duplicate
    # resubmit of a completed turn). A bounded join can't guarantee that
    # ordering — an EFS write can outlast any timeout we'd pick.
    journal_lock = threading.Lock()
    finished = threading.Event()

    def _heartbeat():
        while not stop_beating.wait(TURN_HEARTBEAT_S):
            with journal_lock:
                if finished.is_set():
                    return
                beat["heartbeat"] = int(time.time())
                _journal_write(journal, beat)

    beater = threading.Thread(target=_heartbeat, daemon=True)
    beater.start()

    result: dict = {}
    last_error = ""
    try:
        gen = (_stream_codex(prompt, workdir, claude_session_id, repo, session_id, tenant_id)
               if cli == "codex"
               else _stream_claude(prompt, workdir, claude_session_id, repo,
                                   session_id, tenant_id, model))
        for line in gen:
            if not line.startswith("data:"):
                continue
            try:
                frame = json.loads(line[5:].strip())
            except (json.JSONDecodeError, ValueError):
                continue
            ftype = frame.get("type")
            if ftype == "error":
                last_error = str(frame.get("error") or "")[:600]
            elif ftype == "done":
                result = frame
    except Exception as exc:  # noqa: BLE001 — journal the failure, never raise
        last_error = str(exc)[:600]

    done = {"status": "done", "turn_id": turn_id, "cli": cli,
            "finished_at": int(time.time()),
            "response": result.get("response") or "",
            "claude_session_id": result.get("claude_session_id")}
    if result.get("artifacts"):
        done["artifacts"] = result["artifacts"]
    if not result:
        done["error"] = last_error or "turn produced no done frame"
    elif last_error and not (done["response"] or "").strip():
        done["error"] = last_error
    # Heartbeats stay alive UNTIL the terminal record is durably written: if
    # this write fails transiently (degraded EFS) and beats had already
    # stopped, the last durable record would go stale → dead → the caller
    # resubmits a turn that actually completed. Retry under liveness; only a
    # persistent failure (result truly undeliverable) lets the journal go
    # stale, and then a resubmit IS the right outcome.
    for _ in range(15):
        with journal_lock:
            if _journal_write(journal, done):
                finished.set()
                break
        time.sleep(4)
    else:
        logger.error("turn_done_write_failed", extra={"turn_id": turn_id})
    stop_beating.set()
    # Keep the result reachable in memory even if EFS never accepted the done
    # record — a poll on this VM serves it from here (see _poll_turn).
    _ACTIVE_TURNS[turn_id] = done
    logger.info("turn_done", extra={"cli": cli, "chars": len(done["response"]),
                                    "async": True, "turn_id": turn_id})


def _poll_turn(session_id: str | None, turn_id: str) -> dict:
    """Classify a turn. Read-only — a poll can never touch the CLI process or
    start work.

    Order of authority: the in-process _ACTIVE_TURNS table first (session
    affinity means a live runner is on THIS VM — its word beats any EFS state,
    including a journal gone stale because EFS write attempts are failing while
    the CLI is alive), then the EFS journal (which is what survives a VM
    recycle — the case where 'dead'/'unknown' verdicts are actually true)."""
    live = _ACTIVE_TURNS.get(turn_id)
    if live is not None:
        if live.get("status") == "done":
            return live  # terminal result, even if EFS never accepted it
        return {"status": "running", "turn_id": turn_id, "source": "memory"}
    journal = _turn_journal_path(session_id, turn_id)
    try:
        with open(journal) as f:
            record = json.load(f)
    except FileNotFoundError:
        # Not in memory and no journal: the VM recycled before the seed was
        # durable, or the runner died pre-write. Either way the turn is gone.
        return {"status": "unknown", "turn_id": turn_id}
    except (OSError, json.JSONDecodeError) as exc:
        # Degraded EFS read or a torn read racing the tmp+rename — the turn may
        # well still be running on another incarnation's clock. NOT death:
        # callers must keep polling, never resubmit off this.
        return {"status": "transient", "turn_id": turn_id, "detail": str(exc)[:200]}
    if record.get("status") == "running":
        # Journal says running but the turn is NOT in this VM's memory: with
        # session affinity that means the VM restarted mid-turn. The stale bar
        # guards the brief window where a poll raced the submit on a healthy VM.
        age = int(time.time()) - int(record.get("heartbeat") or 0)
        if age > TURN_STALE_S:
            return {"status": "dead", "turn_id": turn_id, "stale_s": age}
        return {"status": "running", "turn_id": turn_id, "heartbeat_age_s": age}
    return record  # done record verbatim (response / error / artifacts)


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

    # Pre-warm: clone + checkout + install the transcript on the microVM NOW, so
    # opening the session later is instant (no prompt runs). Fired by the port
    # route right after the transcript is uploaded.
    warm = bool(payload.get("warm"))
    # Checkpoint: upload the grown transcript back to S3 so the laptop can pull
    # the session home (the round-trip / "unpark"). No prompt, no clone needed
    # beyond locating the existing workspace.
    checkpoint = bool(payload.get("checkpoint"))
    # Prepare: config-only. Materialize the user's bundle (skills/agents/.mcp.json)
    # + default MCP into the shared config dir, then return. No clone, no CLI. The
    # /shell route fires this before handing the browser a presigned PTY URL, so a
    # terminal-only session (which never hits a chat turn) still gets skills + MCP.
    prepare = bool(payload.get("prepare"))
    # Purge: the session-reaper Lambda's cleanup action. Runs on a FRESH microVM
    # that re-mounts the shared EFS (the original VM was stopped first), so the
    # rmtree can't be torn down mid-flight. Reclaims the session's EFS dir,
    # transcript files, and S3 resume/checkpoint objects.
    purge = bool(payload.get("purge"))
    if purge:
        sid = payload.get("session_id")
        if not sid:
            return JSONResponse({"error": "purge needs a session id"}, status_code=400)
        result = _purge_session(
            sid, payload.get("claude_session_id"), (payload.get("cli") or "claude").lower(),
            payload.get("tenant_id"))
        if not result.get("ok"):
            # Partial failure → non-2xx + purged:false so the reaper raises and
            # the stream redelivers, instead of acknowledging a leak as success.
            return JSONResponse({"purged": False, **result}, status_code=500)
        return JSONResponse({"purged": True, **result})

    # Poll: read-only status check on an async turn. Handled before prompt
    # validation (polls carry no prompt) and before any workspace/config work —
    # it must stay sub-second and side-effect-free.
    if payload.get("action") == "poll":
        turn_id = payload.get("turn_id") or ""
        if not turn_id:
            return JSONResponse({"error": "poll needs a turn_id"}, status_code=400)
        return JSONResponse(_poll_turn(payload.get("session_id"), turn_id))

    prompt = (payload.get("prompt") or "").strip()
    if not prompt and not warm and not checkpoint and not prepare:
        return JSONResponse({"error": "prompt is required"}, status_code=400)

    cli = (payload.get("cli") or DEFAULT_CLI).lower()
    repo = payload.get("repo")
    claude_session_id = payload.get("claude_session_id")
    # Per-turn model override (pipeline personas run on their own model).
    model = (payload.get("model") or "").strip() or None
    user_id = payload.get("user_id")
    tenant_id = payload.get("tenant_id")  # S3 isolation boundary (see _tenant_root)
    config_version = payload.get("config_version")
    session_id = payload.get("session_id")  # isolates this session's checkout
    origin = payload.get("origin")  # "workflow" = fleet-driven session, GC-eligible
    # Repopulate the private /tmp resume hint from the durable per-session copy if
    # this microVM was recycled — so even a config-only prepare leaves the
    # Terminal able to auto-resume the conversation.
    _restore_resume_launch_hint(session_id)
    stream = bool(payload.get("stream"))  # SSE incremental output (claude only)
    # "Port to cloud": a real laptop transcript shipped via S3 for a native,
    # lossless `claude --resume`. resume_session_id is the id INSIDE that file.
    resume_transcript = payload.get("resume_transcript")  # s3 key
    resume_session_id = payload.get("resume_session_id")
    branch = payload.get("branch")  # checkout this branch before the turn
    # Flexible git handoff (hub MCP): git_mode is pushed|bundle|selfContained|none.
    #   clone_url     — explicit origin to clone (may be an upstream we can't push to)
    #   resume_bundle — s3 key of a git bundle: commits-on-top (bundle mode) OR a
    #                   whole-repo `bundle --all` (selfContained mode)
    git_mode = payload.get("git_mode")
    clone_url = payload.get("clone_url")
    resume_bundle = payload.get("resume_bundle")
    # Short-lived GitHub App installation token minted by the hub for this
    # session's owner (scoped to the repo). Never logged. When app_connected is
    # true, a MISSING token means the scoped mint was denied — do NOT fall back to
    # GITHUB_PAT (that would clone beyond the owner's App scope).
    github_token = payload.get("github_token")
    github_app_connected = bool(payload.get("github_app_connected"))
    # Chat attachments: paths (relative to the session's artifact prefix, e.g.
    # uploads/x/shot.png) the user uploaded in the composer. Downloaded into
    # .cloud-code/artifacts/ and appended to the prompt so the CLI can open them.
    attachments = payload.get("attachments") or []

    # On resume, recover the repo the conversation was started in (so we land in
    # the same cwd Claude Code scoped the session to) when the caller omits it.
    if claude_session_id and not repo:
        repo = _load_session_map().get(claude_session_id, {}).get("repo")

    logger.info("turn_start", extra=redact(
        {"cli": cli, "repo": repo, "resume": bool(claude_session_id),
         "stream": stream, "prompt_head": prompt[:120]}))

    # Workflow turns stamp their session dir (origin marker + activity mtime) so
    # the GC below can distinguish them from human sessions, which it never touches.
    if origin == "workflow":
        _touch_workflow_marker(session_id)

    # Opportunistic stale-session GC off the turn path (EFS listdir can be slow).
    import threading as _threading
    _threading.Thread(target=_gc_stale_sessions, daemon=True).start()

    # Config materialization is BEST-EFFORT — never turn-fatal. A degraded EFS
    # mount or unwritable config dir would otherwise 500 an otherwise-runnable
    # turn (the CLI can still run against whatever's already on disk). Order:
    # user bundle FIRST (may ship its own .mcp.json / config.toml), THEN our
    # default gateway on top so the always-advertised gateway tools survive.
    config_ok = True
    config_err = ""
    try:
        _apply_config_bundle(user_id, config_version, tenant_id)
        _apply_default_mcp()
    except Exception as exc:  # noqa: BLE001 — config is non-fatal
        config_ok = False
        config_err = str(exc)[:300]
        logger.warning("config_apply_failed", extra={"error": config_err})

    # Config-only prepare: the bundle + default MCP are the whole job. Report
    # success/failure but always 200 so the /shell best-effort caller never errors
    # (a stale-mount VM will be replaced; the next turn retries).
    if prepare:
        # A terminal-only session reaches the VM ONLY through prepare (no chat turn
        # runs _configure_git), so install/refresh/clear the GitHub credential
        # helper here too — otherwise Terminal `git`/`gh` on a private repo has no
        # App token, or keeps a prior turn's stale/expired one. Passing None (user
        # disconnected / mint failed) scrubs it.
        _configure_git(github_token, app_connected=github_app_connected)
        # resume_ready: a restored (or still-live) /tmp hint means shell-init will
        # auto-resume this conversation when the PTY opens — the /shell route
        # relays it so the browser knows whether to fire its first-prompt seed.
        resume_ready = os.path.exists(RESUME_HINT_PATH)
        logger.info("prepare_done", extra={"user": user_id, "version": config_version,
                                           "ok": config_ok, "resume_ready": resume_ready})
        return JSONResponse({"prepared": config_ok, "config_error": config_err or None,
                             "resume_ready": resume_ready})

    # Workspace setup IS fatal — no workdir, no turn.
    try:
        _configure_git(github_token, app_connected=github_app_connected)
        # Self-contained: no origin — rebuild a standalone repo from the laptop's
        # `bundle --all` (the no-remote / not-a-repo port). The bundle IS the only
        # source of the code, so this replaces the clone entirely.
        if git_mode == "selfContained" and resume_bundle:
            workdir = _rebuild_from_bundle(resume_bundle, session_id, branch=branch)
        elif _selfcontained_workspace(session_id) and not repo and not clone_url:
            # Warm self-contained session on a LATER turn (or checkpoint): the
            # caller only sends git_mode/resume_bundle on the seed turn, and there's
            # no repo to re-derive a slug from. Reuse the standalone repo already on
            # EFS — otherwise _ensure_workspace(None,…) returns the bare session root
            # and the CLI runs OUTSIDE the shipped code (and checkpoint reads the
            # wrong project slug).
            workdir = _selfcontained_workspace(session_id)
            logger.info("selfcontained_warm_reuse")
        else:
            # The repo clone / branch checkout is best-effort WHEN we have a
            # conversation to resume: the resume only needs the transcript placed
            # at the cwd's project slug, not a working clone. A clone can
            # legitimately fail — an origin the cloud can't reach, a lost
            # upstream, an auth failure. Letting that abort the whole setup means
            # the resume hint is never written and the Terminal opens to a bare
            # shell (the conversation is stranded). So on failure, fall back to a
            # bare per-session workspace and still resume the chat. Later turns
            # reuse the same per-session dir where the transcript was installed
            # instead of re-attempting the doomed clone and 500ing the live chat.
            can_fallback = cli == "claude" and bool(
                (resume_transcript and resume_session_id) or claude_session_id
            )
            try:
                workdir = _ensure_workspace(repo, session_id, clone_url=clone_url)
                # Bundle mode: clone the upstream (above), then layer the laptop's
                # commits from the uploaded git bundle. Do this BEFORE branch
                # checkout — the bundle lands on the laptop's tip, which is the
                # state we want to resume on.
                if git_mode == "bundle" and resume_bundle:
                    _apply_resume_bundle(resume_bundle, workdir, session_id, branch=branch)
                # Land on the ported branch (pushed mode: the laptop's branch on origin).
                elif branch:
                    _checkout_branch(workdir, branch)
            except Exception as exc:  # noqa: BLE001
                if not can_fallback:
                    raise
                workdir = _ensure_workspace(None, session_id)
                logger.warning("workspace_clone_failed_resume_fallback",
                               extra={"clone_url": clone_url, "repo": repo,
                                      "error": str(exc)[:300], "workdir": workdir})
        # Install a ported transcript and resume it natively. On success the turn
        # runs as `claude --resume` / `codex resume` — true continuation.
        if resume_transcript and resume_session_id:
            if cli == "codex":
                if _install_codex_resume_transcript(resume_transcript, resume_session_id):
                    claude_session_id = claude_session_id or resume_session_id
            elif _install_resume_transcript(resume_transcript, resume_session_id, workdir):
                claude_session_id = claude_session_id or resume_session_id
        # Restore uploaded/ported artifacts into .cloud-code/artifacts/ so the agent
        # can open them (keyed by the cloud session id under the resume prefix).
        if session_id:
            _install_artifacts(
                f"{_tenant_root(tenant_id)}/resume/{session_id}/artifacts/", workdir, session_id
            )
        # Chat attachments: fetch the user's uploads for THIS turn and point the
        # CLI at them (appended paths — the CLI reads them with its file tools).
        if attachments and session_id and not warm and not checkpoint:
            fetched = _fetch_attachments(
                f"{_tenant_root(tenant_id)}/resume/{session_id}/artifacts/", attachments, workdir
            )
            if fetched:
                listing = "\n".join(f"- {p}" for p in fetched)
                prompt = (prompt + "\n\nAttached file(s) for this message "
                          "(already downloaded locally):\n" + listing)
        # Hand the interactive Terminal a one-shot launch hint: which dir to cd
        # into and which conversation to `claude --resume`. shell-init.sh reads it
        # on a FRESH shell only (run-once guard — a PTY reattach to an
        # already-running claude never re-fires), so the resume launches
        # server-side instead of the browser typing it into a live TUI input box.
        resume_ready = False
        if claude_session_id and cli in ("claude", "codex"):
            resume_ready = _write_resume_launch_hint(workdir, claude_session_id,
                                                     session_id, cli=cli)
    except ValueError as ve:  # bad repo field — caller error, not a 500
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        logger.error("turn_setup_failed", extra={"cli": cli, "error": str(exc)[:600]})
        return JSONResponse({"error": str(exc)[:600]}, status_code=500)

    # Checkpoint: upload the grown transcript back to S3 for the laptop to pull.
    # The session id to checkpoint is the resume id (the conversation's real id).
    if checkpoint:
        cp_id = resume_session_id or claude_session_id
        if not cp_id:
            return JSONResponse({"error": "checkpoint needs a session id"}, status_code=400)
        try:
            info = _checkpoint_transcript(cp_id, workdir, tenant_id)
        except FileNotFoundError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        except Exception as exc:  # noqa: BLE001
            logger.error("checkpoint_failed", extra={"error": str(exc)[:600]})
            return JSONResponse({"error": str(exc)[:600]}, status_code=500)
        # Harvest touched-untracked deliverables too (best-effort — never fails the
        # checkpoint). They surface in the web Artifacts tab under the same cp_id.
        artifacts = _checkpoint_artifacts(cp_id, workdir, tenant_id)
        # bundle/selfContained sessions have no writable origin — the laptop
        # can't `git fetch origin` the cloud's commits home. Ship them as a
        # return bundle instead (the pull leg fetches from it directly).
        return_bundle = None
        if git_mode in ("bundle", "selfContained") or _selfcontained_workspace(session_id):
            return_bundle = _checkpoint_return_bundle(cp_id, workdir, tenant_id)
        return JSONResponse({"checkpointed": True, **info, "artifacts": artifacts,
                             "return_bundle": return_bundle})

    # Pre-warm done: workspace cloned, branch checked out, transcript installed.
    # No CLI runs — the first real turn (on open) will be instant + warm.
    if warm:
        logger.info("warm_done", extra={"repo": repo, "workspace": workdir,
                                        "resume_ready": resume_ready})
        return JSONResponse({"warmed": True, "workspace": workdir, "cli": cli,
                             "resume_ready": resume_ready})

    # Async path (workflow personas): kick the CLI off on a runner thread and
    # return a turn_id immediately. The caller polls with {action:"poll",
    # turn_id, session_id} — no connection stays open during the turn, so the
    # ~15-min idle-stream kill can't strand anyone. Setup errors above still
    # fail THIS call synchronously (bad repo, clone failure), which is what the
    # caller can act on.
    if payload.get("mode") == "async" and cli in ("claude", "codex"):
        # Idempotency: the caller supplies turn_id so a client-side timeout +
        # resubmit of the same turn can't double-run it — if this id is already
        # live (or already finished), acknowledge the existing turn instead of
        # starting a second runner on the same workspace.
        turn_id = payload.get("turn_id") or f"turn-{uuid.uuid4().hex}"
        if turn_id in _ACTIVE_TURNS:
            logger.info("turn_submit_dedupe", extra={"turn_id": turn_id})
            return JSONResponse({"submitted": True, "turn_id": turn_id, "cli": cli,
                                 "workspace": workdir, "deduped": True})
        journal = _turn_journal_path(session_id, turn_id)
        # Same id journaled on EFS (this VM already ran it, possibly pre-recycle
        # with a durable result): acknowledge, let the caller's poll collect it.
        if os.path.exists(journal):
            logger.info("turn_submit_dedupe_journal", extra={"turn_id": turn_id})
            return JSONResponse({"submitted": True, "turn_id": turn_id, "cli": cli,
                                 "workspace": workdir, "deduped": True})
        # Seed the journal BEFORE returning so an immediate poll can never see
        # "unknown" for a turn we accepted. If the seed can't be written the
        # turn must NOT start: an accepted-but-unjournaled turn polls as
        # "unknown" and gets resubmitted while the original still runs.
        seeded = _journal_write(journal, {"status": "running", "turn_id": turn_id,
                                          "cli": cli, "started_at": int(time.time()),
                                          "heartbeat": int(time.time())})
        if not seeded:
            logger.error("turn_submit_seed_failed", extra={"turn_id": turn_id})
            return JSONResponse(
                {"error": "turn journal unwritable (EFS degraded) — turn not started"},
                status_code=503)
        threading.Thread(
            target=_run_turn_async,
            args=(turn_id, journal, cli, prompt, workdir, claude_session_id,
                  repo, session_id, tenant_id, model),
            daemon=True,
        ).start()
        logger.info("turn_submitted", extra={"cli": cli, "turn_id": turn_id})
        return JSONResponse({"submitted": True, "turn_id": turn_id, "cli": cli,
                             "workspace": workdir})

    # Streaming path: yield SSE as the turn runs. The runtime forwards an
    # async/sync generator response as text/event-stream through InvokeAgentRuntime.
    if stream and cli in ("claude", "codex"):
        gen = (
            _stream_codex(prompt, workdir, claude_session_id, repo, session_id, tenant_id)
            if cli == "codex"
            else _stream_claude(prompt, workdir, claude_session_id, repo, session_id, tenant_id, model)
        )
        return StreamingResponse(gen, media_type="text/event-stream")

    try:
        if cli == "codex":
            result = _run_codex(prompt, workdir, claude_session_id, session_id, model)
        elif cli == "claude":
            result = _run_claude(prompt, workdir, claude_session_id, session_id, model)
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

    # A brand-new chat learns its claude_session_id only now (it was unset on
    # entry, so the pre-run hint above was skipped). Write it here too, so opening
    # the Terminal for this session also auto-resumes the conversation.
    if result.get("claude_session_id") and cli in ("claude", "codex"):
        _write_resume_launch_hint(workdir, result["claude_session_id"], session_id, cli=cli)

    # Harvest any deliverables this turn produced to the resume prefix so they show
    # in the web Artifacts tab immediately — no pull-home required. Best-effort.
    # The harvested keys ride the response so remote callers (workflow personas)
    # can fetch deliverables they have no filesystem path to.
    try:
        synced = _sync_turn_artifacts(session_id, workdir, tenant_id)
        if synced.get("keys"):
            result["artifacts"] = synced["keys"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("turn_artifact_sync_failed", extra={"error": str(exc)[:200]})

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
