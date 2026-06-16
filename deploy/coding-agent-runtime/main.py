"""
Amazon Bedrock AgentCore Runtime — multi-CLI coding worker.

Health server for a dedicated coding runtime hosting Claude Code and Codex. The
CLIs are NOT invoked through this server — they are launched via the AgentCore
commands API (InvokeAgentRuntimeCommand) by the orchestrating Strands fleet
agent, which shells `/app/run-{cli}.sh` into this microVM.

This server provides:
  - /ping + /health for AgentCore lifecycle management. Reports HealthyBusy
    while any CLI process is alive (so AgentCore does not reap the session at
    the idle timeout mid-run) and Healthy when idle.
  - OTel collector sidecar bootstrap — forwards each CLI's OTel telemetry to
    CloudWatch (aws/spans) via SigV4-signed OTLP, so every tool call the CLI
    makes appears as a trace alongside the fleet agents' traces.

Architecture matches aws-samples/sample-agent-assisted-sdlc and
awslabs/agentcore-samples (code-agents-competition-e2e).
"""

import os
import socket
import subprocess
import time

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from log import get_logger

logger = get_logger("coding-agent-runtime")

# argv[0] basenames that mean "a CLI is actively working in this microVM".
# Each CLI launcher execs its tool; `node` covers Claude Code + Codex (Node
# based) and any MCP gateway subprocess. The health walk matches the exe name.
_CODING_PROC_NAMES = ("claude", "codex", "node")

COLLECTOR_BIN = "/usr/bin/otelcol-contrib"
COLLECTOR_CFG = "/app/otel-collector-config.yaml"


def _wire_log_headers() -> None:
    """Parse OTEL_EXPORTER_OTLP_LOGS_HEADERS (AgentCore-injected, comma-separated
    key=value pairs) and re-export the two values the collector config references
    via ${env:AWS_OTEL_LOG_GROUP} / ${env:AWS_OTEL_LOG_STREAM}."""
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


def _start_collector() -> "subprocess.Popen | None":
    if not os.path.exists(COLLECTOR_BIN):
        logger.warning("otel_collector_missing", extra={"bin": COLLECTOR_BIN})
        return None
    if not os.path.exists(COLLECTOR_CFG):
        logger.warning("otel_collector_config_missing", extra={"cfg": COLLECTOR_CFG})
        return None
    logger.info("otel_collector_starting", extra={"config": COLLECTOR_CFG})
    return subprocess.Popen(
        [COLLECTOR_BIN, "--config", COLLECTOR_CFG],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _bootstrap_collector() -> None:
    """Wire log headers and start the OTel collector sidecar.

    Called from __main__ only so the module imports cleanly in unit tests
    without spawning the collector subprocess.
    """
    _wire_log_headers()
    collector_proc = _start_collector()
    if collector_proc is None:
        return
    if _wait_for_collector():
        logger.info("otel_collector_ready", extra={"endpoint": "127.0.0.1:4318"})
    else:
        logger.warning("otel_collector_bind_timeout", extra={"timeout_s": 10})
        if collector_proc.poll() is not None:
            out = collector_proc.stdout.read().decode(errors="replace") if collector_proc.stdout else ""
            logger.error(
                "otel_collector_exited",
                extra={"returncode": collector_proc.returncode, "output_head": out[:2000]},
            )


app = FastAPI()


def _cli_is_running(proc_root: str = "/proc") -> bool:
    """True if any known coding-CLI process is alive in this microVM.

    Walks /proc and matches each process's argv[0] basename against
    _CODING_PROC_NAMES. Skips PIDs that exit mid-walk (the listdir/open race).
    proc_root is injectable only for unit tests; production uses /proc.
    """
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
            continue  # process exited between listdir and open — benign race
        if not raw:
            continue
        argv0 = raw.split(b"\x00", 1)[0].decode(errors="replace")
        exe = argv0.rsplit("/", 1)[-1]
        if exe in _CODING_PROC_NAMES:
            return True
    return False


@app.get("/ping")
@app.get("/health")
async def health():
    """AgentCore Runtime health endpoint.

    Reports HealthyBusy while a CLI is running so AgentCore does NOT reap the
    session at the idle timeout mid-run, and Healthy when idle so normal idle-out
    applies. The time_of_last_update field is REQUIRED — without it AgentCore
    fires the idle timeout even when status is HealthyBusy.

    Contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html
    """
    status = "HealthyBusy" if _cli_is_running() else "Healthy"
    return JSONResponse({"status": status, "time_of_last_update": int(time.time())})


@app.post("/invocations")
async def invocations():
    """Placeholder — CLIs are launched via the commands API, not here."""
    return JSONResponse({"status": "ok"})


if __name__ == "__main__":
    _bootstrap_collector()
    logger.info("health_server_starting", extra={"port": 8080})
    uvicorn.run(app, host="0.0.0.0", port=8080)
