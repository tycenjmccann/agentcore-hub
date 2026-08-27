"""
Liveness supervision for the runtime agent's streaming event loop (TEAM-3202).

The runtime previously emitted NO liveness signal while the stream loop ran,
and nothing detected silence: a mid-loop death produced no terminal
agent.error event and left the Jira ticket in_progress forever (TEAM-3211).
This module provides the two missing halves:

  - heartbeat_loop(): an asyncio task on the runtime's event loop that emits a
    periodic `agent.heartbeat` lifecycle event. Because tools execute in worker
    threads, the loop stays free during a long tool call and heartbeats keep
    flowing — but if the event loop wedges or the handler dies, the beats stop.

  - LivenessMonitor: a plain OS thread (the watchdog) keyed on an in-memory
    last-liveness timestamp fed by stream events AND heartbeat ticks. It is
    deliberately NOT an asyncio task: it must survive exactly the failure it
    detects (the asyncio loop going silent while the process lingers — the
    observed telemetry kept its final DynamoDB span open, i.e. the process
    outlived the loop). On trip it emits a terminal `agent.error` event and
    releases the stuck ticket via the same paths the rest of the runtime uses.

Placement / residual gaps (documented per TEAM-3211):
  - A hard SIGKILL of the whole microVM kills the watchdog thread too — that
    case still needs an external (orchestrator-side) watchdog, which would
    require new scheduled infrastructure and is out of scope here.
  - If the handler task is abandoned without cancellation while the event loop
    stays healthy, the heartbeat task keeps beating and the watchdog cannot
    distinguish that from progress; downstream monitors can, because heartbeats
    flow with no completion.
"""

import logging
import os
import threading
import time

logger = logging.getLogger("agentcore-hub-pipeline-agent.liveness")

DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 45.0
DEFAULT_SILENCE_TIMEOUT_SECONDS = 300.0


def read_positive_float_env(name: str, default: float) -> float:
    """Parse a positive float env var, falling back to `default` on missing,
    non-numeric, or non-positive values — a bad env value must never take the
    fleet down."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning(f"{name}={raw!r} is not a number — using default {default}")
        return default
    if not value > 0:  # also rejects NaN
        logger.warning(f"{name}={raw!r} must be > 0 — using default {default}")
        return default
    return value


class LivenessMonitor:
    """Silence watchdog for one agent invocation.

    Holds the last-liveness timestamp in process memory (never gated on an
    eventually-consistent datastore read). `beat()` is called from the stream
    loop and the heartbeat task; a background thread polls for silence. The
    `_terminal` flag is the single atomic guard shared by the watchdog and the
    normal completion/error paths, so exactly one terminal outcome is ever
    emitted no matter how the two race.
    """

    def __init__(
        self,
        *,
        silence_timeout: float,
        emit_event,
        release_ticket,
        time_source=time.monotonic,
        poll_interval: float = 5.0,
    ):
        self._silence_timeout = silence_timeout
        self._emit_event = emit_event  # callable(event_type: str, detail: dict)
        self._release_ticket = release_ticket  # callable(reason: str)
        self._time = time_source
        self._poll_interval = poll_interval
        self._lock = threading.Lock()
        self._terminal = False
        self._tripped = False
        self._last_liveness = time_source()
        self._stop = threading.Event()
        self._thread = None

    def beat(self):
        """Record loop progress (stream event or heartbeat tick)."""
        with self._lock:
            self._last_liveness = self._time()

    def claim_terminal(self) -> bool:
        """Atomically claim the single terminal slot. Returns True exactly once
        across all callers (watchdog trip, loop exception, normal completion);
        a False return means another path already went terminal — do NOT emit
        a second terminal event."""
        with self._lock:
            if self._terminal:
                return False
            self._terminal = True
            return True

    @property
    def terminal(self) -> bool:
        with self._lock:
            return self._terminal

    @property
    def tripped(self) -> bool:
        with self._lock:
            return self._tripped

    def check(self) -> bool:
        """One watchdog poll. Trips (emits terminal agent.error + releases the
        ticket) if the loop has been silent past the threshold and no other
        path has gone terminal. Returns True only on the poll that trips."""
        with self._lock:
            if self._terminal:
                return False
            silence = self._time() - self._last_liveness
            if silence < self._silence_timeout:
                return False
            self._terminal = True
            self._tripped = True
        self._trip(silence)
        return True

    def _trip(self, silence: float):
        reason = (
            f"liveness timeout: agent event loop silent for {int(silence)}s "
            f"(threshold {int(self._silence_timeout)}s) — no heartbeat or stream progress"
        )
        logger.error(f"[liveness] WATCHDOG TRIPPED — {reason}")
        # Both halves are best-effort and independent: a failed event write must
        # not skip the ticket release, and vice versa.
        try:
            self._emit_event("agent.error", {
                "error": reason,
                "reason": "liveness_timeout",
                "silenceSeconds": int(silence),
                "thresholdSeconds": int(self._silence_timeout),
            })
        except Exception as e:  # noqa: BLE001
            logger.error(f"[liveness] failed to emit terminal agent.error: {e}")
        try:
            self._release_ticket(reason)
        except Exception as e:  # noqa: BLE001
            logger.error(f"[liveness] failed to release stuck ticket: {e}")

    def start(self):
        self._thread = threading.Thread(
            target=self._run, name="agent-liveness-watchdog", daemon=True
        )
        self._thread.start()

    def _run(self):
        while not self._stop.wait(self._poll_interval):
            if self.check() or self.terminal:
                return

    def stop(self):
        """Stop and join the watchdog thread — no leaked threads on normal exit."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._poll_interval + 5)
            if self._thread.is_alive():
                logger.warning("[liveness] watchdog thread did not join in time")
            self._thread = None


async def heartbeat_loop(monitor: LivenessMonitor, interval: float, emit_heartbeat):
    """Emit `agent.heartbeat` every `interval` seconds while the invocation is
    alive. Each tick also beats the monitor BEFORE attempting the event write:
    the tick itself proves the event loop is alive, and the watchdog decision
    must not depend on DynamoDB availability. Emission failures are logged and
    swallowed; heartbeats stop as soon as any path goes terminal."""
    import asyncio

    try:
        while True:
            await asyncio.sleep(interval)
            if monitor.terminal:
                return
            monitor.beat()
            try:
                emit_heartbeat()
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[liveness] heartbeat emit failed (non-fatal): {e}")
    except asyncio.CancelledError:
        return
