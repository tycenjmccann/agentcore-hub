#!/usr/bin/env python3
"""Unit tests for intervene.py `start` and `file-bug` — hermetic, no AWS/network.

TEAM-3911: `start` gained a mutually-exclusive --def/--type pipeline selector and
`file-bug` gained a free-form mode (no --agent → a plain bug with an
`origin: "workflow-manager"` marker instead of crash-rca labels + dedupe). These
tests drive the REAL argparse main() so the mutually-exclusive group and the
optional `workflow_id` positional (nargs="?") are exercised end-to-end, and pin
the exact POST body each mode sends and which partition key the intervention
event lands under.

The network/AWS seams are mocked at the module boundary: `intervene.api_post`
(the only HTTP write) records (path, body) and `intervene.publish_intervention`
(the only events-table write) records (workflowId, action, extra). boto3 is
stubbed in sys.modules BEFORE import (intervene builds a dynamodb resource at
module load and the CI toolkit job installs no boto3); WORKFLOW_API_URL is set
before import for good measure though api_post is fully mocked.

Run: python3 -m pytest deploy/workflow-manager/toolkit/test_intervene.py -v
"""

import os
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))

# intervene imports boto3 and builds a dynamodb resource at module load, and
# reads env at import time — satisfy both before importing so the test needs
# neither the boto3 wheel nor any AWS credentials/network.
sys.modules["boto3"] = mock.MagicMock()
os.environ.setdefault("WORKFLOW_API_URL", "http://test.local")
os.environ.setdefault("EVENTS_TABLE", "test-events")

import intervene  # noqa: E402


class Recorder:
    """Captures the two side-effecting seams cmd_start / cmd_file_bug reach."""

    def __init__(self):
        self.posts = []   # list of (path, body)
        self.events = []  # list of (workflow_id, action, extra)

    def api_post(self, path, body=None):
        self.posts.append((path, body))
        return {"ticketId": "TEAM-1", "deduped": False}

    def publish_intervention(self, workflow_id, action, extra):
        self.events.append((workflow_id, action, extra))


@pytest.fixture
def rec(monkeypatch):
    r = Recorder()
    monkeypatch.setattr(intervene, "api_post", r.api_post)
    monkeypatch.setattr(intervene, "publish_intervention", r.publish_intervention)
    return r


def run(argv):
    """Invoke the REAL argparse main() with argv patched (no leading progname)."""
    with mock.patch.object(sys, "argv", ["intervene.py"] + argv):
        intervene.main()


def only_post(rec):
    """The single (path, body) a successful command posts."""
    assert len(rec.posts) == 1, f"expected exactly one POST, got {rec.posts}"
    return rec.posts[0]


# --------------------------------------------------------------------------
# start
# --------------------------------------------------------------------------

def test_start_def_sends_workflow_def_id_and_no_workflow_type(rec):
    # AC-1.1
    run(["start", "--title", "T", "--def", "routine-foo"])
    path, body = only_post(rec)
    assert path == "/api/workflow/start"
    assert body["workflowDefId"] == "routine-foo"
    assert "workflowType" not in body


def test_start_type_bug_sends_workflow_type_and_no_def(rec):
    # AC-1.2
    run(["start", "--title", "T", "--type", "bug"])
    _, body = only_post(rec)
    assert body["workflowType"] == "bug"
    assert "workflowDefId" not in body


def test_start_type_feature_body_is_exact(rec):
    # AC-1.3 (explicit --type feature)
    run(["start", "--title", "My title", "--type", "feature"])
    _, body = only_post(rec)
    assert body == {
        "title": "My title",
        "description": "",
        "workflowType": "feature",
        "sources": [],
    }


def test_start_no_flags_body_is_byte_identical_to_today(rec):
    # AC-1.3 (no flag == unchanged historical default)
    run(["start", "--title", "My title"])
    _, body = only_post(rec)
    assert body == {
        "title": "My title",
        "description": "",
        "workflowType": "feature",
        "sources": [],
    }


def test_start_def_and_type_together_exits_before_any_post(rec):
    # AC-1.4 — mutually-exclusive group rejected by argparse (exit code 2).
    with pytest.raises(SystemExit) as exc:
        run(["start", "--title", "T", "--def", "d", "--type", "bug"])
    assert exc.value.code != 0
    assert rec.posts == []


@pytest.mark.parametrize("def_value", ["", "   "])
def test_start_explicit_empty_def_refuses_no_post(rec, def_value):
    # TEAM-3924 finding R1-F3 (P2): an explicit but empty/whitespace --def
    # must NOT silently fall through to the --type/feature default (that
    # would start the WRONG pipeline with no indication anything went wrong).
    # It is a hard refusal instead, distinct from --def being absent entirely.
    with pytest.raises(SystemExit) as exc:
        run(["start", "--title", "T", "--def", def_value])
    assert "REFUSED" in str(exc.value)
    assert "--def" in str(exc.value)
    assert rec.posts == []
    assert rec.events == []


def test_start_omitted_def_body_is_unchanged(rec):
    # TEAM-3924 — omitted --def must keep today's behavior byte-identical
    # (same golden body as test_start_no_flags_body_is_byte_identical_to_today).
    run(["start", "--title", "My title"])
    _, body = only_post(rec)
    assert body == {
        "title": "My title",
        "description": "",
        "workflowType": "feature",
        "sources": [],
    }


def test_start_real_def_still_sends_workflow_def_id_no_type(rec):
    # TEAM-3924 — a real --def value is unaffected by the empty-value guard.
    run(["start", "--title", "T", "--def", "real-id"])
    _, body = only_post(rec)
    assert body["workflowDefId"] == "real-id"
    assert "workflowType" not in body


def test_start_empty_title_refuses_without_post(rec):
    # AC-1.5
    with pytest.raises(SystemExit) as exc:
        run(["start", "--description", "d"])
    assert "REFUSED: start requires --title" in str(exc.value)
    assert rec.posts == []


def test_start_repo_and_branch_build_repo_config(rec):
    # AC-1.6 — repoConfig shape unchanged.
    run(["start", "--title", "T", "--repo", "owner/name", "--branch", "dev"])
    _, body = only_post(rec)
    assert body["repoConfig"] == {
        "layout": "multi-repo",
        "repos": [{"url": "https://github.com/owner/name", "defaultBranch": "dev"}],
    }


# --------------------------------------------------------------------------
# file-bug — crash mode (--agent given)
# --------------------------------------------------------------------------

def test_file_bug_crash_mode_golden_body(rec):
    # AC-2.1 / AC-5.2 — byte-identical to the historical crash filing, no origin.
    run(["file-bug", "WF-1", "--title", "T", "--description", "D", "--agent", "persona_x"])
    path, body = only_post(rec)
    assert path == "/api/bugs"
    assert body == {
        "title": "T",
        "description": "D",
        "labels": ["crash-rca", "agent:persona_x", "crashed-in:WF-1"],
        "dedupeLabels": ["crash-rca", "agent:persona_x"],
    }
    assert "origin" not in body
    # Intervention event lands under the run.
    assert rec.events[0][0] == "WF-1"


def test_file_bug_crash_mode_adds_repo_when_given(rec):
    # AC-2.1 variant — --repo threads through unchanged.
    run(["file-bug", "WF-1", "--title", "T", "--description", "D",
         "--agent", "persona_x", "--repo", "owner/name"])
    _, body = only_post(rec)
    assert body["repo"] == "owner/name"
    assert body["dedupeLabels"] == ["crash-rca", "agent:persona_x"]
    assert "origin" not in body


def test_file_bug_crash_mode_without_workflow_id_refuses(rec):
    # AC-2.5 — crash mode still requires the run id; no POST.
    with pytest.raises(SystemExit) as exc:
        run(["file-bug", "--title", "T", "--description", "D", "--agent", "persona_x"])
    assert "workflowId" in str(exc.value)
    assert rec.posts == []


@pytest.mark.parametrize("agent_value", ["", "   "])
def test_file_bug_explicit_empty_agent_refuses_no_post(rec, agent_value):
    # TEAM-3919 finding 1 (P2): an explicit but empty/whitespace --agent must
    # NOT silently fall through to free-form mode (that would skip the
    # crash-rca dedupe + family cap the caller almost certainly wanted). It is
    # a hard refusal instead, distinct from --agent being absent entirely.
    with pytest.raises(SystemExit) as exc:
        run(["file-bug", "WF-1", "--title", "T", "--description", "D", "--agent", agent_value])
    assert "REFUSED" in str(exc.value)
    assert "--agent" in str(exc.value)
    assert rec.posts == []
    assert rec.events == []


# --------------------------------------------------------------------------
# file-bug — free-form mode (no --agent)
# --------------------------------------------------------------------------

def test_file_bug_free_form_body_exact_with_repo_no_workflow_id(rec):
    # AC-2.2 — origin marker, no crash labels / dedupe.
    run(["file-bug", "--title", "T", "--description", "D", "--repo", "owner/name"])
    path, body = only_post(rec)
    assert path == "/api/bugs"
    assert body == {
        "title": "T",
        "description": "D",
        "origin": "workflow-manager",
        "repo": "owner/name",
    }
    assert "labels" not in body
    assert "dedupeLabels" not in body


def test_file_bug_free_form_with_workflow_id_event_under_that_run(rec):
    # AC-2.3 — same free-form body shape (no repo); event under the given run.
    run(["file-bug", "WF-1", "--title", "T", "--description", "D"])
    _, body = only_post(rec)
    assert body == {
        "title": "T",
        "description": "D",
        "origin": "workflow-manager",
    }
    assert rec.events[0][0] == "WF-1"


def test_file_bug_free_form_without_workflow_id_event_under_wm_adhoc(rec):
    # AC-2.4 — no run id → intervention event lands under the "wm-adhoc" sentinel.
    run(["file-bug", "--title", "T", "--description", "D"])
    _, body = only_post(rec)
    assert body["origin"] == "workflow-manager"
    assert "labels" not in body
    assert "dedupeLabels" not in body
    assert rec.events[0][0] == "wm-adhoc"


# --------------------------------------------------------------------------
# file-bug — required fields in BOTH modes (AC-2.6)
# --------------------------------------------------------------------------

@pytest.mark.parametrize("argv", [
    # crash mode
    ["file-bug", "WF-1", "--description", "D", "--agent", "persona_x"],   # no title
    ["file-bug", "WF-1", "--title", "T", "--agent", "persona_x"],         # no description
    # free-form mode
    ["file-bug", "--description", "D"],                                    # no title
    ["file-bug", "--title", "T"],                                          # no description
])
def test_file_bug_missing_title_or_description_refuses(rec, argv):
    with pytest.raises(SystemExit) as exc:
        run(argv)
    assert "REFUSED: file-bug requires" in str(exc.value)
    assert rec.posts == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# --------------------------------------------------------------------------
# mark-done (TEAM-3991 D1.3) — ONE call to the server-side endpoint that owns
# the harvest, the evidence write and the transition.
# --------------------------------------------------------------------------

@pytest.fixture
def no_ddb(monkeypatch):
    """Neutralise the DynamoDB seams `mark-done` still touches for its LOCAL
    human-gate guard, and record whether the command reached for the table at
    all. The evidence write itself must never come from here: `markedDoneBy` is
    stamped from the request identity server-side, which a direct table write
    would silently bypass."""
    calls = {"get_ticket": 0}

    def fake_get_ticket(ticket_id):
        calls["get_ticket"] += 1
        return {"ticketId": ticket_id, "status": "in_progress", "assignee": "backend_dev"}

    monkeypatch.setattr(intervene, "get_ticket", fake_get_ticket)
    return calls


def test_mark_done_posts_evidence_endpoint(rec, no_ddb, monkeypatch):
    """The whole operation is ONE POST to /tickets/mark-done — not the old
    comment-then-transition pair, which could half-fail and left the evidence in a
    comment the orchestrator never reads."""
    monkeypatch.setattr(intervene, "api_post", lambda path, body=None: (
        rec.posts.append((path, body)) or
        {"ok": True, "evidenceSource": "record", "branch": "feature/TEAM-7-backend-dev",
         "commitSha": "abc1234", "prUrl": "https://github.com/acme/hub/pull/9"}
    ))

    run(["mark-done", "wf_1", "TEAM-7", "--evidence", "PR #9 is merged"])

    path, body = only_post(rec)
    assert path == "/api/workflow/wf_1/tickets/mark-done"
    assert body == {"ticketId": "TEAM-7", "evidence": "PR #9 is merged"}
    # The client never asks to transition, comment, or stamp an actor — the server
    # owns all three (and takes `markedDoneBy` from the authenticated identity).
    assert "targetStatus" not in body and "by" not in body and "markedDoneBy" not in body


def test_mark_done_writes_evidence_from_text(rec, no_ddb, monkeypatch):
    """The typed --evidence is the LAST-resort source; when the server reports it
    used that text (evidenceSource "manager"), the operator sees so."""
    monkeypatch.setattr(intervene, "api_post", lambda path, body=None: (
        rec.posts.append((path, body)) or {"ok": True, "evidenceSource": "manager"}
    ))

    run(["mark-done", "wf_1", "TEAM-7", "--evidence", "streamed PASS verdict"])

    _, body = only_post(rec)
    assert body["evidence"] == "streamed PASS verdict"
    # The source the server chose is carried into the intervention record, so the
    # run analysis can tell a harvested deliverable from an operator's assertion.
    assert rec.events[-1][1] == "mark_done"
    assert rec.events[-1][2]["evidenceSource"] == "manager"


def test_mark_done_never_touches_dynamodb_for_the_write(rec, no_ddb, monkeypatch):
    """No boto3 table write anywhere in the path: a direct write would skip the
    identity stamp AND the scoped conditional update the store owns (R2)."""
    monkeypatch.setattr(intervene, "api_post", lambda path, body=None: (
        rec.posts.append((path, body)) or {"ok": True, "evidenceSource": "branch"}
    ))
    table = mock.MagicMock()
    monkeypatch.setattr(intervene.dynamodb, "Table", table)

    run(["mark-done", "wf_1", "TEAM-7", "--evidence", "branch pushed"])

    # publish_intervention is mocked, so the ONLY table use left would be a write
    # by mark-done itself. There is none.
    assert table.call_count == 0
    assert only_post(rec)[0].endswith("/tickets/mark-done")


def test_mark_done_refuses_human_gate(rec, monkeypatch):
    """Client-side guard: a human review gate is refused BEFORE the network call,
    so an operator pointed at the wrong ticket is told immediately."""
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "todo", "assignee": "human:lead@example.com"})

    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-GATE", "--evidence", "looks done to me"])

    assert "human review gate" in str(exc.value)
    assert rec.posts == []


def test_mark_done_refuses_in_review(rec, monkeypatch):
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "in_review", "assignee": "qa"})

    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-R", "--evidence", "e"])

    assert "in_review" in str(exc.value)
    assert rec.posts == []


def test_mark_done_surfaces_409_no_evidence(rec, no_ddb, monkeypatch):
    """The server refuses when it can find NO evidence at all. That refusal must
    reach the operator verbatim — it is the anti-false-green guard, not a glitch to
    retry around."""
    def refusing_post(path, body=None):
        rec.posts.append((path, body))
        raise SystemExit(
            "REFUSED (NO_EVIDENCE): no completion record, no branch or PR, and no "
            "usable evidence text for TEAM-7"
        )

    monkeypatch.setattr(intervene, "api_post", refusing_post)

    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-7", "--evidence", "   "])

    # The local --evidence guard fires first for blank text (no POST at all).
    assert "requires --evidence" in str(exc.value)
    assert rec.posts == []


def test_mark_done_omits_force_unless_asked(rec, no_ddb, monkeypatch):
    """TEAM-4099 F6 — the default mark-done is FILL-ONLY: no `force` key, so the
    server's `attribute_not_exists(output)` condition protects the agent's own
    report. An accidental clobber must require typing the flag."""
    monkeypatch.setattr(intervene, "api_post", lambda path, body=None: (
        rec.posts.append((path, body)) or {"ok": True, "evidenceSource": "manager"}
    ))

    run(["mark-done", "wf_1", "TEAM-7", "--evidence", "streamed PASS"])

    _, body = only_post(rec)
    assert "force" not in body
    assert "forced" not in rec.events[-1][2]


def test_mark_done_force_sends_the_override_and_records_it(rec, no_ddb, monkeypatch):
    """--force is the deliberate override: it reaches the endpoint as
    `force: true`, and the intervention event is marked `forced` so a replay can
    tell an override apart from a fill."""
    monkeypatch.setattr(intervene, "api_post", lambda path, body=None: (
        rec.posts.append((path, body)) or {"ok": True, "evidenceSource": "manager", "forced": True}
    ))

    run(["mark-done", "wf_1", "TEAM-7", "--evidence", "the recorded output is from the wrong run",
         "--force"])

    path, body = only_post(rec)
    assert path == "/api/workflow/wf_1/tickets/mark-done"
    assert body["force"] is True
    assert rec.events[-1][1] == "mark_done"
    assert rec.events[-1][2]["forced"] is True


def test_mark_done_evidence_exists_409_names_both_ways_out(capsys):
    """api_post's typed-409 handling for EVIDENCE_EXISTS: it must name the kept
    source, and point at the transition endpoint for a stale board vs --force for
    a genuine override — the JSON `{ force: true }` in the server message is not
    something an operator can type."""
    err = _http_error(409, {
        "code": "EVIDENCE_EXISTS",
        "error": "TEAM-7 already carries evidence",
        "evidenceSource": "record",
    })
    with mock.patch.object(intervene.urllib.request, "urlopen", side_effect=err):
        with pytest.raises(SystemExit) as exc:
            intervene.api_post("/api/workflow/wf_1/tickets/mark-done", {"ticketId": "TEAM-7"})
    msg = str(exc.value)
    assert "already carries evidence" in msg
    assert "evidenceSource=record" in msg
    assert "--force" in msg
    assert "Transition the ticket" in msg


def test_mark_done_no_evidence_409_is_reported_as_a_refusal(capsys):
    """api_post's typed-409 handling for the server's NO_EVIDENCE code."""
    err = _http_error(409, {"code": "NO_EVIDENCE", "error": "nothing to prove TEAM-7 shipped"})
    with mock.patch.object(intervene.urllib.request, "urlopen", side_effect=err):
        with pytest.raises(SystemExit) as exc:
            intervene.api_post("/api/workflow/wf_1/tickets/mark-done", {"ticketId": "TEAM-7"})
    assert "NO_EVIDENCE" in str(exc.value)
    assert "nothing to prove TEAM-7 shipped" in str(exc.value)


# --------------------------------------------------------------------------
# --resume / PR_EXISTS (TEAM-3991 D1.5)
# --------------------------------------------------------------------------

def _http_error(code, payload):
    """A urllib HTTPError whose body is the API's JSON refusal."""
    import io
    return intervene.urllib.error.HTTPError(
        "http://test.local", code, "Conflict", {},
        io.BytesIO(__import__("json").dumps(payload).encode()),
    )


PR_EXISTS_BODY = {
    "code": "PR_EXISTS",
    "number": 274,
    "prUrl": "https://github.com/acme/hub/pull/274",
    "state": "open",
    "merged": False,
    "ticketId": "TEAM-7",
    "message": "PR #274 exists — resume, don't re-investigate.",
}


def test_dispatch_refuses_when_pr_exists(capsys, monkeypatch):
    """A cold re-dispatch onto a ticket that already has a PR makes the agent redo
    work that is on GitHub (prod TEAM-3790). Exit code 2 marks it as RESUMABLE, so
    a caller can branch on it instead of parsing prose."""
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "in_progress", "assignee": "backend_dev"})
    monkeypatch.setattr(intervene, "publish_intervention", lambda *a, **k: None)
    with mock.patch.object(intervene.urllib.request, "urlopen",
                           side_effect=_http_error(409, PR_EXISTS_BODY)):
        with pytest.raises(SystemExit) as exc:
            run(["dispatch", "wf_1", "TEAM-7"])

    assert exc.value.code == 2
    err = capsys.readouterr().err
    assert "PR #274 exists — resume, don't re-investigate" in err
    assert "https://github.com/acme/hub/pull/274" in err
    assert "--resume" in err


def test_retry_refuses_when_pr_exists(capsys, monkeypatch):
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "in_progress", "assignee": "backend_dev"})
    monkeypatch.setattr(intervene, "publish_intervention", lambda *a, **k: None)
    monkeypatch.setattr(intervene, "dynamodb", mock.MagicMock())
    intervene.dynamodb.Table.return_value.get_item.return_value = {
        "Item": {"workflowId": "wf_1", "agentTasks": {}}
    }
    with mock.patch.object(intervene.urllib.request, "urlopen",
                           side_effect=_http_error(409, PR_EXISTS_BODY)):
        with pytest.raises(SystemExit) as exc:
            run(["retry", "wf_1", "backend_dev"])

    assert exc.value.code == 2
    assert "resume, don't re-investigate" in capsys.readouterr().err


def test_dispatch_resume_flag_proceeds(rec, monkeypatch):
    """--resume puts `resume: true` in the body; the endpoint then dispatches and
    hands the agent a resume context pointing at the PR."""
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "in_progress", "assignee": "backend_dev"})

    run(["dispatch", "wf_1", "TEAM-7", "--resume"])

    _, body = only_post(rec)
    assert body["resume"] is True
    assert body["ticketId"] == "TEAM-7"


def test_retry_resume_flag_proceeds(rec, monkeypatch):
    monkeypatch.setattr(intervene, "dynamodb", mock.MagicMock())
    intervene.dynamodb.Table.return_value.get_item.return_value = {
        "Item": {"workflowId": "wf_1", "agentTasks": {}}
    }

    run(["retry", "wf_1", "backend_dev", "--resume"])

    _, body = only_post(rec)
    assert body["resume"] is True
    assert body["agentId"] == "backend_dev"


def test_dispatch_without_resume_sends_no_resume_key(rec, monkeypatch):
    """The default is unchanged — no `resume` key at all, so the guard applies."""
    monkeypatch.setattr(intervene, "get_ticket",
                        lambda tid: {"ticketId": tid, "status": "in_progress", "assignee": "backend_dev"})

    run(["dispatch", "wf_1", "TEAM-7"])

    assert "resume" not in only_post(rec)[1]


def test_lease_live_409_still_reported_as_lease_live(capsys):
    """The typed-refusal refactor must not blur LEASE_LIVE into the generic path —
    it is the one refusal with a --force escape."""
    err = _http_error(409, {"code": "LEASE_LIVE", "error": "agent holds a live lease"})
    with mock.patch.object(intervene.urllib.request, "urlopen", side_effect=err):
        with pytest.raises(SystemExit) as exc:
            intervene.api_post("/api/workflow/wf_1/retry", {"agentId": "dev"})
    assert "lease live" in str(exc.value)
    assert "--force" in str(exc.value)
