"""TEAM-4739 FR-7 — the resume object: a cut-off turn is continued, not redone.

`agent.died` says a turn stopped being given time; the resume object is what makes
that survivable. Without it the whole cost of a mid-turn death was paid twice: the
next attempt on the same ticket started from an empty context and re-derived work
the dead turn had already done (and, worse, re-ran side effects it had already
performed, because it had no way to know they had happened).

Three halves, each with its own failure mode:

  * the WRITE, in `_run_agent_invocation`'s `finally` on a death or a park. It is
    best-effort by contract (R1.4): it runs on a path where the turn is already
    ending badly, and a resume write that raised would replace the death with an
    unrelated S3 error and skip the telemetry flush queued behind it. So "never
    propagates" is pinned harder here than the happy path is.
  * the READ, right after `_CURRENT_TICKET_ID` is set, prepending a
    `## Previous Attempt` block. A MISSING object is the normal case — first
    attempts are the overwhelming majority — so it must be silent, and it must
    never fail a turn that would otherwise have run.
  * the DELETE, on the completion gate's success path. A turn that reported
    completion has nothing to resume, and a stale object would prepend a dead
    attempt to whatever runs on this ticket next.

Hermetic: main.py cannot be imported (its module top-level installs Node.js,
fetches from S3 and chdirs), so the real functions are `ast`-located and exec'd
against a fake S3 client.
"""

from __future__ import annotations

import ast
import json
import logging
from typing import Any

import pytest

from test_telemetry_spans import MAIN_PY, _load_production_entrypoints, _module_scope_nodes

WF = "wf_resume"
AGENT = "agentcore_hub_backend_dev"
TICKET = "TEAM-4739"
KEY = f"workflows/{WF}/agents/{AGENT}/resume/{TICKET}.json"
PREFIX = f"workflows/{WF}/agents/{AGENT}/"


class _FakeS3:
    """A `boto3` S3 stand-in recording calls, with per-operation failure switches."""

    def __init__(self, stored: dict[str, bytes] | None = None) -> None:
        self.stored: dict[str, bytes] = dict(stored or {})
        self.puts: list[dict] = []
        self.deletes: list[dict] = []
        self.lists: list[dict] = []
        self.fail_put = False
        self.fail_list = False
        self.fail_get = False
        self.fail_delete = False
        self.listing: list[str] = []

    def put_object(self, **kwargs: Any) -> dict:
        if self.fail_put:
            raise RuntimeError("AccessDenied")
        self.puts.append(kwargs)
        self.stored[kwargs["Key"]] = kwargs["Body"]
        return {}

    def list_objects_v2(self, **kwargs: Any) -> dict:
        self.lists.append(kwargs)
        if self.fail_list:
            raise RuntimeError("SlowDown")
        max_keys = kwargs.get("MaxKeys") or len(self.listing)
        return {"Contents": [{"Key": k} for k in self.listing[:max_keys]]}

    def get_object(self, **kwargs: Any) -> dict:
        if self.fail_get:
            raise RuntimeError("SlowDown")
        body = self.stored.get(kwargs["Key"])
        if body is None:
            raise RuntimeError("NoSuchKey")
        return {"Body": _Body(body)}

    def delete_object(self, **kwargs: Any) -> dict:
        if self.fail_delete:
            raise RuntimeError("AccessDenied")
        self.deletes.append(kwargs)
        self.stored.pop(kwargs["Key"], None)
        return {}


class _Body:
    def __init__(self, raw: bytes) -> None:
        self._raw = raw

    def read(self) -> bytes:
        return self._raw


def _load(bucket: str = "test-artifacts", stored: dict[str, bytes] | None = None) -> tuple[dict, _FakeS3]:
    """The REAL resume functions, exec'd against a fake S3 client and bucket name."""
    tree = ast.parse(MAIN_PY.read_text())
    nodes = _module_scope_nodes(
        tree,
        [
            "_RESUME_ARTIFACT_KEY_CAP",
            "_RESUME_TEXT_LIMIT",
            "_resume_object_key",
            "_write_resume_object",
            "_read_resume_object",
            "_delete_resume_object",
            "_resume_prompt_block",
        ],
    )
    s3 = _FakeS3(stored)
    ns: dict[str, Any] = {
        "json": json,
        "logger": logging.getLogger("test-resume-object"),
        "s3_client": s3,
        "ARTIFACT_BUCKET": bucket,
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns, s3


def _body(s3: _FakeS3, key: str = KEY) -> dict:
    return json.loads(s3.stored[key].decode("utf-8"))


# ─── 1. the key shape ────────────────────────────────────────────────────────


def test_the_key_is_namespaced_under_the_agents_own_prefix() -> None:
    """One object per (run, agent, ticket). The prefix is the agent's existing
    artifact namespace, so a resume object is listed, swept and cost-attributed by
    everything that already understands that layout — and two personas working the
    same run can never overwrite each other's remnant."""
    ns, _ = _load()
    assert ns["_resume_object_key"](WF, AGENT, TICKET) == KEY


def test_the_write_lands_on_exactly_that_key_as_json() -> None:
    ns, s3 = _load()
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="half a thought",
                              last_stream_at="2026-09-17T12:34:56+00:00")
    assert len(s3.puts) == 1
    put = s3.puts[0]
    assert put["Bucket"] == "test-artifacts"
    assert put["Key"] == KEY
    assert put["ContentType"] == "application/json"
    assert _body(s3) == {
        "lastText": "half a thought",
        "lastStreamAt": "2026-09-17T12:34:56+00:00",
        "artifactKeys": [],
    }


def test_the_second_write_replaces_the_first() -> None:
    """Deliberately one object, not a history: the next turn wants the LATEST
    remnant, and an append-style layout would prepend three dead attempts."""
    ns, s3 = _load()
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="first")
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="second")
    assert _body(s3)["lastText"] == "second"


@pytest.mark.parametrize(
    "args",
    [
        ("", AGENT, TICKET),
        (WF, "", TICKET),
        (WF, AGENT, ""),
        (WF, AGENT, "   ".strip()),
    ],
    ids=["no-workflow", "no-agent", "no-ticket", "blank-ticket"],
)
def test_an_unbound_turn_writes_nothing(args: tuple) -> None:
    """An unbound turn has no ticket to resume, and a key with an empty segment
    (`.../resume/.json`) would collide across every unbound turn in the run."""
    ns, s3 = _load()
    ns["_write_resume_object"](*args, last_text="something")
    assert s3.puts == []


def test_no_bucket_configured_writes_nothing() -> None:
    ns, s3 = _load(bucket="")
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="something")
    assert s3.puts == []
    assert ns["_read_resume_object"](WF, AGENT, TICKET) is None


# ─── 2. the ≤2KB clip ────────────────────────────────────────────────────────


def test_last_text_is_clipped_to_the_documented_limit() -> None:
    """The remnant is a hint, not a transcript. It is prepended to the NEXT turn's
    prompt, so an unbounded one would push the persona's actual ticket out of the
    context it is supposed to be working from."""
    ns, s3 = _load()
    limit = ns["_RESUME_TEXT_LIMIT"]
    assert limit <= 2048, f"the resume text must stay at or under 2KB; got {limit}"
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="x" * (limit * 5))
    assert len(_body(s3)["lastText"]) == limit


def test_the_clip_keeps_the_start_not_the_end() -> None:
    """A truncation is only useful if it is the beginning of the thought — the
    persona reads it as "what I had established", which is front-loaded."""
    ns, s3 = _load()
    limit = ns["_RESUME_TEXT_LIMIT"]
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="HEAD" + "y" * (limit * 2))
    assert _body(s3)["lastText"].startswith("HEAD")


@pytest.mark.parametrize("last_text", ["", None])
def test_an_empty_remnant_still_writes_the_object(last_text: Any) -> None:
    """The artifact list alone is worth resuming from: a turn killed after writing
    files but before saying anything must not make the next turn redo the files."""
    ns, s3 = _load()
    s3.listing = [f"{PREFIX}patch.diff"]
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text=last_text)
    assert _body(s3) == {
        "lastText": "",
        "lastStreamAt": "",
        "artifactKeys": [f"{PREFIX}patch.diff"],
    }


# ─── 3. the artifact listing ─────────────────────────────────────────────────


def test_artifact_keys_come_from_the_agents_prefix_and_are_capped() -> None:
    ns, s3 = _load()
    cap = ns["_RESUME_ARTIFACT_KEY_CAP"]
    s3.listing = [f"{PREFIX}file-{i}.txt" for i in range(cap * 3)]
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t")
    assert s3.lists[0]["Prefix"] == PREFIX
    assert s3.lists[0]["MaxKeys"] == cap
    keys = _body(s3)["artifactKeys"]
    assert len(keys) == cap, f"the listing must be capped at {cap}; got {len(keys)}"


def test_a_failed_listing_still_writes_the_text() -> None:
    """The text is the point and the keys are a bonus, so a throttled ListObjectsV2
    must degrade the object rather than lose it."""
    ns, s3 = _load()
    s3.fail_list = True
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="what I had reached")
    assert _body(s3) == {"lastText": "what I had reached", "lastStreamAt": "", "artifactKeys": []}


# ─── 4. S3 failure never propagates (R1.4) ───────────────────────────────────


def test_a_failed_write_never_raises() -> None:
    """It is called from the `finally` that publishes the death. A raise there
    would replace `agent.died` with an unrelated S3 error and skip the telemetry
    flush queued behind it — the run would lose both the death and its spans."""
    ns, s3 = _load()
    s3.fail_put = True
    assert ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t") is None


def test_a_failed_delete_never_raises() -> None:
    """It runs inside the completion gate's hook. A raise would take down a turn
    that had just SUCCEEDED, over cleanup."""
    ns, s3 = _load()
    s3.fail_delete = True
    assert ns["_delete_resume_object"](WF, AGENT, TICKET) is None


@pytest.mark.parametrize("switch", ["fail_get", "fail_put", "fail_delete", "fail_list"])
def test_an_unusable_client_never_propagates_from_any_entry_point(switch: str) -> None:
    ns, s3 = _load()
    setattr(s3, switch, True)
    assert ns["_read_resume_object"](WF, AGENT, TICKET) is None
    assert ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t") is None
    assert ns["_delete_resume_object"](WF, AGENT, TICKET) is None


def test_a_client_that_is_not_a_client_at_all_never_propagates() -> None:
    ns, _ = _load()
    for broken in (None, object()):
        ns["s3_client"] = broken
        assert ns["_read_resume_object"](WF, AGENT, TICKET) is None
        assert ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t") is None
        assert ns["_delete_resume_object"](WF, AGENT, TICKET) is None


# ─── 5. the read ─────────────────────────────────────────────────────────────


def test_a_written_object_reads_back_whole() -> None:
    ns, s3 = _load()
    s3.listing = [f"{PREFIX}notes.md"]
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t", last_stream_at="2026-09-17T00:00:00Z")
    assert ns["_read_resume_object"](WF, AGENT, TICKET) == {
        "lastText": "t",
        "lastStreamAt": "2026-09-17T00:00:00Z",
        "artifactKeys": [f"{PREFIX}notes.md"],
    }


def test_a_missing_object_is_none_and_silent() -> None:
    """The normal case by a wide margin — every first attempt on every ticket."""
    ns, _ = _load()
    assert ns["_read_resume_object"](WF, AGENT, TICKET) is None


@pytest.mark.parametrize(
    "raw",
    [b"not json", b"", b"[1, 2, 3]", b'"a string"', b"null"],
    ids=["garbage", "empty", "json-array", "json-string", "json-null"],
)
def test_an_unreadable_object_is_none_not_a_crash(raw: bytes) -> None:
    """A corrupt remnant must cost the run a fresh start, never the turn itself."""
    ns, _ = _load(stored={KEY: raw})
    assert ns["_read_resume_object"](WF, AGENT, TICKET) is None


def test_a_read_for_the_wrong_ticket_finds_nothing() -> None:
    """Scoping is the whole point: a stale remnant leaking onto a different ticket
    would tell a persona it had already done work it has never touched."""
    ns, s3 = _load()
    ns["_write_resume_object"](WF, AGENT, TICKET, last_text="t")
    assert ns["_read_resume_object"](WF, AGENT, "TEAM-9999") is None
    assert ns["_read_resume_object"](WF, "agentcore_hub_qa_verifier", TICKET) is None
    assert ns["_read_resume_object"]("wf_other", AGENT, TICKET) is None
    assert s3.stored.keys() == {KEY}


# ─── 6. the prompt block ─────────────────────────────────────────────────────


def test_the_prompt_block_names_the_previous_attempt_and_its_parts() -> None:
    ns, _ = _load()
    block = ns["_resume_prompt_block"]({
        "lastText": "I had cloned the repo and run the failing test.",
        "lastStreamAt": "2026-09-17T12:34:56+00:00",
        "artifactKeys": [f"{PREFIX}patch.diff"],
    })
    assert block.startswith("## Previous Attempt")
    assert "I had cloned the repo and run the failing test." in block
    assert "2026-09-17T12:34:56+00:00" in block
    assert f"- {PREFIX}patch.diff" in block
    assert block.endswith("\n\n---\n\n"), (
        "the block must close with a separator, or it runs into the real prompt"
    )
    # It tells the persona to CONTINUE and to distrust the remnant: a turn that
    # died mid-thought may have been wrong, and a resumed turn that treats the
    # remnant as established fact inherits the error that killed it.
    assert "verify" in block.lower()


@pytest.mark.parametrize(
    "resume",
    [None, {}, "a string", [1], {"lastText": "", "artifactKeys": []},
     {"lastText": "   ", "lastStreamAt": "2026-09-17T00:00:00Z"}],
    ids=["none", "empty-dict", "string", "list", "empty-fields", "whitespace-text"],
)
def test_nothing_to_resume_prepends_nothing(resume: Any) -> None:
    """An empty block must be falsy, not a stray heading: `if _resume_block:` at the
    call site is what keeps a first attempt's prompt byte-identical to today's."""
    ns, _ = _load()
    assert ns["_resume_prompt_block"](resume) == ""


def test_the_prompt_block_clips_the_text_it_prepends() -> None:
    """Defence in depth: the write clips, but the object may predate the clip (or
    have been written by an older harness), and the prompt is where an oversized
    remnant actually costs the persona its context."""
    ns, _ = _load()
    limit = ns["_RESUME_TEXT_LIMIT"]
    block = ns["_resume_prompt_block"]({"lastText": "z" * (limit * 4)})
    assert block.count("z") == limit


def test_artifact_keys_alone_are_worth_a_block() -> None:
    ns, _ = _load()
    block = ns["_resume_prompt_block"]({"artifactKeys": [f"{PREFIX}a.txt"]})
    assert block and f"- {PREFIX}a.txt" in block


# ─── 7. the wiring in the shipped turn ───────────────────────────────────────
#
# The functions above are useless if `_run_agent_invocation` does not call them,
# and the call SITES are what the brief specifies: read right after the ticket id
# is bound, write in the `finally` on death or park, delete on the completion
# gate's success path. Pinned as source structure because the sites are inside a
# 400-line function that the exec loader stubs the S3 halves of.


def test_the_read_happens_right_after_the_ticket_id_is_bound() -> None:
    """Any later and part of the prompt has already been assembled without it."""
    source = MAIN_PY.read_text()
    bind = source.index('_CURRENT_TICKET_ID = payload.get("ticket_id"')
    read = source.index("_read_resume_object(", bind)
    between = source[bind:read]
    assert between.count("\n") <= 8, (
        "the resume read drifted away from the ticket-id binding; the prompt may "
        f"already be assembled:\n{between}"
    )
    assert "_resume_prompt_block(" in source[read: read + 400]
    assert "prompt = _resume_block + prompt" in source[read: read + 600], (
        "the block must be PREPENDED — appending it buries the resume context "
        "under the ticket description"
    )


def test_the_delete_is_wired_to_the_completion_gates_success_path() -> None:
    """Not called from the `finally`: the gate is the only place that knows the
    turn reported completion, and a `finally`-side delete would race the write."""
    source = MAIN_PY.read_text()
    # From inside the turn, not from the class's own docstring above it.
    gate_ctor = source.index("_CompletionGate(", source.index("async def _run_agent_invocation"))
    assert "_delete_resume_object(" in source[gate_ctor: gate_ctor + 300], (
        "the completion gate is not wired to delete the resume object"
    )
    assert "on_success" in source[gate_ctor: gate_ctor + 300]


def test_the_write_is_on_the_death_or_park_path_only() -> None:
    """Not on completion (the gate deletes it) and not on a crash (that turn failed
    for a reason and gets a fresh attempt, not a continuation)."""
    source = MAIN_PY.read_text()
    write = source.index("_write_resume_object(", source.index("async def _run_agent_invocation"))
    guard = source[source.rindex("if ", 0, write): write]
    assert "_parked" in guard and "_accounted" in guard, (
        f"the resume write is not guarded by the park/unaccounted condition: {guard!r}"
    )
    assert "_bound" in guard, "an unbound turn must not write a resume object"


@pytest.mark.asyncio
async def test_a_turn_runs_normally_when_there_is_nothing_to_resume() -> None:
    """The regression that would hurt most: a broken resume read on the FIRST
    attempt at every ticket in the fleet. The loader stubs `_read_resume_object` to
    return None, which is exactly the production first-attempt case."""
    from types import SimpleNamespace

    class _Agent:
        def __init__(self, **kwargs: Any) -> None:
            self.prompts: list[str] = []

        async def stream_async(self, prompt: str):
            self.prompts.append(prompt)
            yield {"data": "hello"}

    ns = _load_production_entrypoints(overrides={"Agent": _Agent})
    frames = [
        f
        async for f in ns["_run_agent_invocation"](
            {"prompt": "the ticket body", "agent_id": "agentcore_hub_backend_dev"},
            SimpleNamespace(session_id="sess-resume"),
        )
    ]
    assert any("contentBlockDelta" in f.get("event", {}) for f in frames)
