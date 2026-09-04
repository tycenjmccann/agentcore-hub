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
