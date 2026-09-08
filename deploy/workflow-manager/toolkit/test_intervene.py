#!/usr/bin/env python3
"""Unit tests for intervene.py `start`, `file-bug` and `mark-done` — hermetic, no
AWS/network.

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

TEAM-4283 adds a third seam for mark-done's completion-record verification:
`intervene.fetch_completion_record` (the only S3 read) plus
`intervene.ARTIFACT_BUCKET`, both patched by the `record_fetch` fixture with
`raising=False` so this suite still RUNS against the pre-fix module (where
neither name exists) and fails on its assertions rather than erroring at setup —
that is what makes the fail-on-base proof meaningful.

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


# --------------------------------------------------------------------------
# mark-done — TEAM-4266: the transition body must carry the evidence
# --------------------------------------------------------------------------
#
# The bug: mark-done recorded the operator's proof as prose only (a ticket
# comment + a manager.intervention event) and transitioned the ticket. Nothing
# ever wrote completions/{ticketId}.json, the record BOTH completion evidence
# gates read, so a run whose agent died before report_completion emitted
# workflow.completion_blocked reason=missing_evidence forever. The route now
# writes that record — but only if mark-done actually SENDS the evidence, which
# is what these pin.


@pytest.fixture
def open_ticket(monkeypatch):
    """A plain unprotected ticket, so refuse_if_protected passes on a real dict
    rather than on whatever the boto3 MagicMock happens to return."""
    monkeypatch.setattr(
        intervene, "get_ticket",
        lambda tid: {"ticketId": tid, "status": "in_progress", "assignee": "agentcore_hub_backend_dev"},
    )


class RecordFetch:
    """Counting stub for the ONE S3 read mark-done makes. `.result` is returned
    (or raised, when it is an exception); `.calls` records the ticket ids."""

    def __init__(self, result=None):
        self.result = result
        self.calls = []

    def __call__(self, ticket_id):
        self.calls.append(ticket_id)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


@pytest.fixture
def record_fetch(monkeypatch):
    # raising=False: on the pre-fix intervene.py neither name exists, and the
    # new tests must fail on their assertions, not error in fixture setup.
    fetch = RecordFetch({"ticket_id": "TEAM-X", "summary": "PR #87"})
    monkeypatch.setattr(intervene, "ARTIFACT_BUCKET", "test-artifacts", raising=False)
    monkeypatch.setattr(intervene, "fetch_completion_record", fetch, raising=False)
    return fetch


def transition_returns(rec, payload):
    """api_post that answers `payload` for the transition and a plain ack for the
    audit comment, while still recording both posts."""
    def api_post(path, body=None):
        rec.posts.append((path, body))
        return dict(payload) if path.endswith("/tickets/transition") else {"success": True}
    return api_post


def test_mark_done_transition_body_carries_evidence(rec, open_ticket, record_fetch, capsys):
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])

    # Two posts, in order: the audit comment, then the transition.
    assert [p for p, _ in rec.posts] == [
        "/api/workflow/wf_1/tickets/comment",
        "/api/workflow/wf_1/tickets/transition",
    ]
    # only_post() assumes a single POST — mark-done makes two, so index directly.
    assert rec.posts[1][1] == {
        "ticketId": "TEAM-X",
        "targetStatus": "done",
        "comment": "Closed by Workflow Manager (agent finished, no report_completion). Evidence: PR #87",
        "evidence": "PR #87",
    }
    # The evidence still lands in the comment + the intervention event too — the
    # record is additive, not a replacement for the audit trail.
    assert "PR #87" in rec.posts[0][1]["content"]
    assert rec.events[0][1] == "mark_done"
    assert rec.events[0][2]["evidence"] == "PR #87"


def test_mark_done_reports_whether_the_record_was_written(rec, open_ticket, monkeypatch, capsys):
    # The route answers `completionRecordWritten`; the printed summary splats
    # **result, so the operator sees it without any extra plumbing.
    monkeypatch.setattr(
        intervene, "api_post",
        lambda path, body=None: {"success": True, "completionRecordWritten": True},
    )
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert '"completionRecordWritten": true' in capsys.readouterr().out


@pytest.mark.parametrize("evidence", ["", "   "])
def test_mark_done_blank_evidence_refuses_before_any_post(rec, open_ticket, evidence):
    # Unchanged guard — no evidence means no proof, so nothing is sent and no
    # completion record can be minted from an empty string.
    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-X", "--evidence", evidence])
    assert "REFUSED: mark-done requires --evidence" in str(exc.value)
    assert rec.posts == []
    assert rec.events == []


# --------------------------------------------------------------------------
# mark-done — TEAM-4283: verify the record when the route did not write it
# --------------------------------------------------------------------------
#
# Post-TEAM-4282 the route fails CLOSED on a write failure (502 → api_post
# raises), so completionRecordWritten=false inside a 2xx is the route's "kept"
# outcome — and two of its three sub-cases (the record vanished between the
# create-only PUT and the read-back; a concurrent writer won the refill's
# IfMatch, contents unknown) leave nothing the completion gate can use. The
# response cannot distinguish them, so mark-done reads the record itself and
# reports `completionRecordCheck`. A legitimate kept record must stay exit 0 —
# exiting non-zero there would read as a failed intervention and escalate.


def test_mark_done_written_true_skips_the_s3_verification(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (a) The route wrote the record this call — nothing to verify, no S3 read.
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": True}))
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert '"completionRecordCheck": "written"' in capsys.readouterr().out
    assert record_fetch.calls == []


def test_mark_done_kept_existing_evidence_record_is_a_success(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (b) Route outcome "kept" where the existing record DOES prove the
    # deliverable (usually the agent's own report_completion landing first).
    # A real success: exit 0, and the intervention is still recorded.
    record_fetch.result = {"ticket_id": "TEAM-X", "summary": "agent record", "pr_url": "https://x/pr/87"}
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": False}))
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert '"completionRecordCheck": "kept-existing"' in capsys.readouterr().out
    assert record_fetch.calls == ["TEAM-X"]
    assert rec.events[0][1] == "mark_done"


def test_mark_done_missing_record_warns_and_exits_nonzero(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (c) The "vanished between the PUT and the read-back" race: the ticket is
    # done and NO record exists, so the completion gate will 409 forever and
    # done → done blocks a retry. Exit non-zero with the create-only remedy —
    # but the summary is still printed and the intervention still published,
    # because the transition itself DID land.
    record_fetch.result = None
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": False}))
    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    message = str(exc.value)
    assert "WARNING" in message
    assert "IfNoneMatch" in message
    assert "TEAM-X" in message
    assert "completions/TEAM-X.json" in message
    assert "missing_evidence" in message
    assert '"completionRecordCheck": "missing"' in capsys.readouterr().out
    assert rec.events[0][1] == "mark_done"


def test_mark_done_blank_record_warns_and_exits_nonzero(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (d) A record exists but is not evidence per completionRecordHasEvidence
    # (the concurrent-writer race can leave exactly this). Same answer as (c).
    record_fetch.result = {"ticket_id": "TEAM-X", "summary": ""}
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": False}))
    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert "WARNING" in str(exc.value)
    assert "IfNoneMatch" in str(exc.value)
    assert '"completionRecordCheck": "blank"' in capsys.readouterr().out


def test_mark_done_absent_written_key_still_verifies(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (e) Version skew: an older route that answers no completionRecordWritten
    # at all must NOT be read as "written". The toolkit ships to S3 before the
    # app rolls, and deploy/workflow-manager/deploy.sh can be hand-run alone, so
    # this skew is not merely transient.
    record_fetch.result = None
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True}))
    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert "WARNING" in str(exc.value)
    assert record_fetch.calls == ["TEAM-X"]
    assert '"completionRecordCheck": "missing"' in capsys.readouterr().out


def test_mark_done_unset_artifact_bucket_is_unverified_not_a_failure(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # (f) No bucket configured = inconclusive, NOT a failed intervention: the
    # transition succeeded, so warn on stderr and exit 0.
    monkeypatch.setattr(intervene, "ARTIFACT_BUCKET", "", raising=False)
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": False}))
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    captured = capsys.readouterr()
    assert '"completionRecordCheck": "unverified"' in captured.out
    assert "WARNING" in captured.err
    assert record_fetch.calls == []


def test_mark_done_s3_error_is_unverified_not_a_failure(rec, open_ticket, record_fetch, monkeypatch, capsys):
    # Same reasoning as (f) for a transient S3/permission failure.
    record_fetch.result = RuntimeError("throttled")
    monkeypatch.setattr(intervene, "api_post", transition_returns(rec, {"success": True, "completionRecordWritten": False}))
    run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    captured = capsys.readouterr()
    assert '"completionRecordCheck": "unverified"' in captured.out
    assert "WARNING" in captured.err


def test_mark_done_evidence_write_failure_publishes_no_event(rec, open_ticket, monkeypatch):
    # (g) PIN — passes on the pre-fix module too. The route fails closed on a
    # failed evidence write (502), api_post raises before publish_intervention,
    # so nothing is recorded for a ticket that never moved. The audit comment
    # posted first still stands.
    def api_post(path, body=None):
        rec.posts.append((path, body))
        if path.endswith("/tickets/transition"):
            raise SystemExit('API 502: {"error":"completion evidence record write failed"}')
        return {"success": True}

    monkeypatch.setattr(intervene, "api_post", api_post)
    with pytest.raises(SystemExit) as exc:
        run(["mark-done", "wf_1", "TEAM-X", "--evidence", "PR #87"])
    assert "completion evidence record write failed" in str(exc.value)
    assert rec.events == []
    assert [p for p, _ in rec.posts] == [
        "/api/workflow/wf_1/tickets/comment",
        "/api/workflow/wf_1/tickets/transition",
    ]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
