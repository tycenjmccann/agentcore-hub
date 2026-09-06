"""TEAM-4121 FR-9 — `WorkflowOutput___report_completion` must forward the
`evidence_kind` / `evidence_keys` pair when the agent supplies it, and send a
byte-identical payload when it doesn't.

Both halves matter. The orchestrator now reads the completion record to decide
whether a fix that declared `evidence_source=live` actually produced live
evidence (live-reverify.mjs); if the harness silently dropped the fields, every
live fix would look unverified. And if it started sending them always — as ""
— every pre-4121 record would gain two empty keys, so "absent" would no longer
be distinguishable from "the agent said nothing".

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py — the REAL shipped function is
located with `ast` and exec'd in isolation against a stub `_invoke_lambda`.
"""

import ast
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "WorkflowOutput___report_completion"


def _report_completion():
    """The real report_completion body, exec'd with stubbed module globals.

    Returns (fn, calls) where `calls` collects (lambda, tool, payload) tuples.
    """
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn_node = next(
        (
            n
            for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == TOOL_NAME
        ),
        None,
    )
    assert fn_node is not None, f"{TOOL_NAME} function def not found in main.py"
    # drop the @tool decorator — strands would wrap the callable in a ToolSpec
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "WORKFLOW_OUTPUT_LAMBDA": "agentcore-hub-workflow-output",
        "_CURRENT_WORKFLOW_ID": "wf-ctx",
        "_CURRENT_AGENT_ID": "agentcore_hub_qa_verifier",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


BASE = dict(ticket_id="TEAM-4200", summary="Re-ran the expired-token repro at HEAD; 401 as expected.")

# Exactly the payload a pre-4121 harness sent. Asserted whole (not key-by-key) so
# an accidental extra field fails here rather than in whatever reads the record.
PRE_4121_PAYLOAD = {
    "ticket_id": "TEAM-4200",
    "summary": "Re-ran the expired-token repro at HEAD; 401 as expected.",
    "artifacts": "",
    "branch": "",
    "commit_sha": "",
    "pr_url": "",
    "workflow_id": "wf-ctx",
    "agent_id": "agentcore_hub_qa_verifier",
}


def _payload(**kwargs):
    fn, calls = _report_completion()
    result = fn(**{**BASE, **kwargs})
    return result, (calls[0][2] if calls else None)


# ─── forwarded when supplied ──────────────────────────────────────────────────

def test_evidence_fields_forwarded():
    _, payload = _payload(
        evidence_kind="live",
        evidence_keys="workflows/wf-ctx/qa-evidence/401.png,workflows/wf-ctx/qa-evidence/run.log",
    )
    assert payload["evidence_kind"] == "live"
    assert payload["evidence_keys"] == (
        "workflows/wf-ctx/qa-evidence/401.png,workflows/wf-ctx/qa-evidence/run.log"
    )


@pytest.mark.parametrize("kind", ["static", "unit", "live"])
def test_all_three_kinds_pass_through(kind):
    _, payload = _payload(evidence_kind=kind)
    assert payload["evidence_kind"] == kind


def test_kind_normalized_to_lowercase_and_trimmed():
    _, payload = _payload(evidence_kind="  LIVE  ")
    assert payload["evidence_kind"] == "live"


def test_unknown_kind_still_forwarded_for_lambda_side_rejection():
    """The harness does not own the kind allow-list — the workflow-output Lambda
    does (EVIDENCE_KINDS), and it must be the one place that drops, so the same
    rule applies whether the call arrives from a runtime agent or a gateway."""
    _, payload = _payload(evidence_kind="vibes")
    assert payload["evidence_kind"] == "vibes"


def test_keys_alone_are_forwarded_without_a_kind():
    _, payload = _payload(evidence_keys="qa-evidence/a.png")
    assert payload["evidence_keys"] == "qa-evidence/a.png"
    assert "evidence_kind" not in payload


# ─── absent → byte-identical ──────────────────────────────────────────────────

def test_omitted_fields_give_the_pre_4121_payload_exactly():
    _, payload = _payload()
    assert payload == PRE_4121_PAYLOAD


def test_blank_and_whitespace_only_are_the_same_as_omitted():
    _, payload = _payload(evidence_kind="   ", evidence_keys="")
    assert payload == PRE_4121_PAYLOAD


def test_dev_agent_fields_still_ride_along():
    """The evidence pair is additive next to the dev-agent fields, not instead of
    them — a dev filing a fix sends branch/sha AND, when it ran the system, live
    evidence, and the orchestrator needs the sha to key the re-verify ticket."""
    _, payload = _payload(
        branch="feature/TEAM-4200",
        commit_sha="abc1234def",
        pr_url="https://github.com/o/r/pull/1",
        evidence_kind="live",
        evidence_keys="qa-evidence/run.log",
    )
    assert payload["commit_sha"] == "abc1234def"
    assert payload["evidence_kind"] == "live"
    assert payload["evidence_keys"] == "qa-evidence/run.log"


def test_lambda_and_tool_name_unchanged():
    fn, calls = _report_completion()
    fn(**BASE, evidence_kind="live")
    assert len(calls) == 1
    assert calls[0][0] == "agentcore-hub-workflow-output"
    assert calls[0][1] == TOOL_NAME


# ─── TEAM-4122 FR-4 §7.5: ci_status / ci_build_id / ci_head_sha ───────────────

def test_ci_fields_forwarded():
    _, payload = _payload(
        ci_status="certified",
        ci_build_id="agentcore-hub-ci:abc123",
        ci_head_sha="deadbeef",
    )
    assert payload["ci_status"] == "certified"
    assert payload["ci_build_id"] == "agentcore-hub-ci:abc123"
    assert payload["ci_head_sha"] == "deadbeef"


@pytest.mark.parametrize("status", ["certified", "github-actions-proxy", "unverified"])
def test_all_three_statuses_pass_through(status):
    _, payload = _payload(ci_status=status)
    assert payload["ci_status"] == status


def test_ci_status_normalized_to_lowercase_and_trimmed():
    _, payload = _payload(ci_status="  CERTIFIED  ")
    assert payload["ci_status"] == "certified"


def test_ci_fields_omitted_give_the_pre_4122_payload_exactly():
    _, payload = _payload()
    assert payload == PRE_4121_PAYLOAD


def test_ci_fields_blank_are_the_same_as_omitted():
    _, payload = _payload(ci_status="   ", ci_build_id="", ci_head_sha="")
    assert payload == PRE_4121_PAYLOAD
