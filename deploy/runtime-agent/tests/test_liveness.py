"""Regression tests for the TEAM-3202 liveness watchdog + heartbeat.

Run with:  cd deploy/runtime-agent && python3 -m pytest tests/ -v

The watchdog trip decision uses an injected time source (fake clock) — no real
sleeps anywhere near the minute scale. On pre-fix code (main before
TEAM-3211) this file fails at collection: the liveness module does not exist,
because the runtime had no heartbeat and no silence detection at all.
"""

import asyncio

import pytest

from liveness import (
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_SILENCE_TIMEOUT_SECONDS,
    LivenessMonitor,
    heartbeat_loop,
    read_positive_float_env,
)

THRESHOLD = 300.0


class FakeClock:
    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_monitor(clock, emit_event=None, release_ticket=None):
    events, releases = [], []
    monitor = LivenessMonitor(
        silence_timeout=THRESHOLD,
        emit_event=emit_event or (lambda t, d: events.append((t, d))),
        release_ticket=release_ticket or releases.append,
        time_source=clock,
    )
    return monitor, events, releases


def terminal_errors(events):
    return [e for e in events if e[0] == "agent.error"]


# ─── Failure path: silent loop past the threshold ────────────────────────────

def test_watchdog_trips_on_silence_emits_error_once_and_releases_ticket():
    clock = FakeClock()
    monitor, events, releases = make_monitor(clock)

    clock.advance(THRESHOLD + 1)
    assert monitor.check() is True

    errors = terminal_errors(events)
    assert len(errors) == 1
    _, detail = errors[0]
    assert detail["reason"] == "liveness_timeout"
    assert detail["silenceSeconds"] >= THRESHOLD
    assert detail["thresholdSeconds"] == int(THRESHOLD)
    assert len(releases) == 1
    assert "liveness timeout" in releases[0]

    # Further polls must never emit a second terminal event or release again.
    clock.advance(10_000)
    assert monitor.check() is False
    assert len(terminal_errors(events)) == 1
    assert len(releases) == 1


def test_trip_still_releases_ticket_when_event_emit_fails():
    clock = FakeClock()

    def broken_emit(_type, _detail):
        raise RuntimeError("DDB down")

    monitor, _events, releases = make_monitor(clock, emit_event=broken_emit)
    clock.advance(THRESHOLD + 5)
    assert monitor.check() is True
    assert len(releases) == 1


# ─── Negative path: healthy loop never trips ─────────────────────────────────

def test_healthy_loop_with_regular_beats_never_trips():
    clock = FakeClock()
    monitor, events, releases = make_monitor(clock)

    for _ in range(20):
        clock.advance(THRESHOLD - 10)
        monitor.beat()
        assert monitor.check() is False

    assert events == []
    assert releases == []
    assert monitor.tripped is False


def test_normal_completion_blocks_watchdog_even_after_long_silence():
    clock = FakeClock()
    monitor, events, releases = make_monitor(clock)

    # The loop completed normally (finally-path claims the terminal slot).
    assert monitor.claim_terminal() is True

    clock.advance(THRESHOLD * 10)
    assert monitor.check() is False
    assert events == []
    assert releases == []


def test_no_double_terminal_when_watchdog_and_completion_race():
    clock = FakeClock()
    monitor, events, releases = make_monitor(clock)

    # Watchdog wins the race...
    clock.advance(THRESHOLD + 1)
    assert monitor.check() is True
    # ...so the completion/exception path must be told NOT to emit a terminal.
    assert monitor.claim_terminal() is False
    assert len(terminal_errors(events)) == 1
    assert len(releases) == 1


def test_watchdog_thread_starts_and_joins_cleanly():
    clock = FakeClock()
    monitor, _events, _releases = make_monitor(clock)
    monitor.start()
    assert monitor._thread.is_alive()
    thread = monitor._thread
    monitor.stop()
    assert not thread.is_alive()
    assert monitor._thread is None


# ─── Heartbeat task ──────────────────────────────────────────────────────────

def test_heartbeat_keeps_ticking_past_emit_failures_and_stops_after_terminal():
    clock = FakeClock()
    monitor, _events, _releases = make_monitor(clock)
    emits = []

    def flaky_emit():
        emits.append(1)
        if len(emits) <= 2:
            raise RuntimeError("DDB write failed")

    async def scenario():
        task = asyncio.create_task(heartbeat_loop(monitor, 0.005, flaky_emit))
        while len(emits) < 4:  # survived the two failures and kept emitting
            await asyncio.sleep(0.005)
        monitor.claim_terminal()
        await asyncio.wait_for(task, timeout=1.0)  # exits on its own after terminal

    asyncio.run(scenario())
    assert len(emits) >= 4


def test_heartbeat_beats_monitor_before_emitting():
    clock = FakeClock()
    monitor, _events, _releases = make_monitor(clock)
    clock.advance(THRESHOLD - 1)  # one tick away from tripping

    async def scenario():
        task = asyncio.create_task(heartbeat_loop(
            monitor, 0.005, lambda: (_ for _ in ()).throw(RuntimeError("DDB down"))))
        await asyncio.sleep(0.05)
        task.cancel()

    asyncio.run(scenario())
    # The heartbeat tick alone (despite every emit failing) counts as liveness.
    clock.advance(THRESHOLD - 1)
    assert monitor.check() is False


# ─── Config parsing ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw", ["garbage", "-5", "0", "", "nan"])
def test_env_parsing_falls_back_to_default_on_bad_values(monkeypatch, raw):
    monkeypatch.setenv("AGENT_HEARTBEAT_INTERVAL_SECONDS", raw)
    assert read_positive_float_env(
        "AGENT_HEARTBEAT_INTERVAL_SECONDS", DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    ) == DEFAULT_HEARTBEAT_INTERVAL_SECONDS


def test_env_parsing_accepts_valid_values(monkeypatch):
    monkeypatch.setenv("AGENT_SILENCE_TIMEOUT_SECONDS", "120.5")
    assert read_positive_float_env(
        "AGENT_SILENCE_TIMEOUT_SECONDS", DEFAULT_SILENCE_TIMEOUT_SECONDS
    ) == 120.5


def test_env_parsing_uses_default_when_unset(monkeypatch):
    monkeypatch.delenv("AGENT_SILENCE_TIMEOUT_SECONDS", raising=False)
    assert read_positive_float_env(
        "AGENT_SILENCE_TIMEOUT_SECONDS", DEFAULT_SILENCE_TIMEOUT_SECONDS
    ) == DEFAULT_SILENCE_TIMEOUT_SECONDS
