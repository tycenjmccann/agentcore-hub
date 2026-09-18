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


# ─── DL-024 / ship verdict: merge_commit, outcome, block_reason ───────────────

def test_ship_verdict_fields_forwarded():
    _, payload = _payload(merge_commit=" 0ef5892abc ", outcome=" Shipped ", block_reason="")
    assert payload["merge_commit"] == "0ef5892abc"
    assert payload["outcome"] == "shipped"  # lower-cased; the Lambda owns the allow-list
    assert "block_reason" not in payload


def test_block_reason_rides_with_a_blocked_outcome():
    _, payload = _payload(outcome="deploy-blocked", block_reason="Deploy stage failed twice")
    assert payload["outcome"] == "deploy-blocked"
    assert payload["block_reason"] == "Deploy stage failed twice"
    assert "merge_commit" not in payload


def test_ship_verdict_fields_omitted_keep_the_pre_4121_payload():
    _, payload = _payload(merge_commit="", outcome="   ", block_reason="")
    assert payload == PRE_4121_PAYLOAD


# ─── TEAM-4708: pipeline_execution_id / pipeline_name reach the Lambda ────────
#
# PR #618 taught the workflow-output Lambda to REFUSE outcome="shipped" without
# `pipeline_execution_id` on the pipeline path, but never added the parameter to
# this tool — so no agent could satisfy the rail and the live release manager got
# `shipped_requires_execution_and_merge_commit, missing ["pipeline_execution_id"]`
# with no way to comply. These tests pin the two names to the ones
# lambda/workflow-output/index.mjs destructures; a rename on either side fails
# here instead of at ship time.

EXECUTION_ID = "b7f3c0de-1a2b-4c3d-8e9f-0a1b2c3d4e5f"


def test_pipeline_execution_id_and_name_forwarded():
    _, payload = _payload(
        merge_commit="2c4781221b41a10974d564da9a27e50004c800dd",
        outcome="shipped",
        pipeline_execution_id=EXECUTION_ID,
        pipeline_name="hub-agentcore-hub-deploy",
    )
    assert payload["pipeline_execution_id"] == EXECUTION_ID
    assert payload["pipeline_name"] == "hub-agentcore-hub-deploy"
    # the pair the shipped rail needs travels together with the merge commit
    assert payload["merge_commit"] == "2c4781221b41a10974d564da9a27e50004c800dd"
    assert payload["outcome"] == "shipped"


def test_pipeline_fields_trimmed():
    _, payload = _payload(
        pipeline_execution_id=f"  {EXECUTION_ID}  ",
        pipeline_name="  hub-agentcore-hub-deploy  ",
    )
    assert payload["pipeline_execution_id"] == EXECUTION_ID
    assert payload["pipeline_name"] == "hub-agentcore-hub-deploy"


def test_malformed_execution_id_still_forwarded_for_lambda_side_rejection():
    """The harness does not own the execution-id shape check — the Lambda's
    PIPELINE_EXECUTION_ID_RE does, and it must stay the one place that drops, so
    the same rule applies from a runtime agent or a gateway. Silently swallowing
    it here would turn a loud refusal into a report with no execution at all."""
    _, payload = _payload(pipeline_execution_id="not-a-uuid")
    assert payload["pipeline_execution_id"] == "not-a-uuid"


def test_pipeline_name_alone_is_forwarded_without_an_execution_id():
    """This is the combination that MUST reach the Lambda unaltered: naming the
    pipeline is what proves the run took the pipeline path, so the rail can
    demand the execution id instead of excusing it as a legacy DEPLOY.md ship."""
    _, payload = _payload(outcome="shipped", pipeline_name="hub-agentcore-hub-deploy")
    assert payload["pipeline_name"] == "hub-agentcore-hub-deploy"
    assert "pipeline_execution_id" not in payload


def test_pipeline_fields_omitted_keep_the_pre_4121_payload():
    _, payload = _payload(pipeline_execution_id="", pipeline_name="   ")
    assert payload == PRE_4121_PAYLOAD


def test_tool_signature_exposes_the_two_ship_contract_params():
    """The defect in #618 was a missing PARAMETER, not missing forwarding: the
    body could never run because Strands would reject the keyword argument. Pin
    the signature itself."""
    import inspect

    fn, _ = _report_completion()
    params = inspect.signature(fn).parameters
    for name in ("pipeline_execution_id", "pipeline_name"):
        assert name in params, f"{TOOL_NAME} has no {name} parameter"
        assert params[name].default == "", f"{name} must default to \"\" (absent stays absent)"


def test_lambda_side_destructures_exactly_these_names():
    """Parity with the consumer: lambda/workflow-output/index.mjs is the only
    reader, and a name that does not match is a field the rail cannot see."""
    lambda_src = (
        MAIN_PY.resolve().parent.parent.parent / "lambda" / "workflow-output" / "index.mjs"
    ).read_text()
    for name in ("pipeline_execution_id", "pipeline_name"):
        assert f"{name} }}" in lambda_src or f"{name}," in lambda_src, (
            f"workflow-output Lambda no longer destructures {name}"
        )


# ─── TEAM-4739: follow_ups ────────────────────────────────────────────────────
#
# The thread a ticket surfaced but does not own (a post-deploy verification, a
# console or IAM handoff, a docs gap) had nowhere to go: a persona either closed
# its own ticket over the loose end or filed the follow-up itself, reaching across
# ticket boundaries. `follow_ups` is the declaration; the workflow-output Lambda
# (TEAM-4740) owns the schema, the allow-lists and the dropping of unknown
# entries, exactly as it owns EVIDENCE_KINDS. Same additive rule as every
# parameter above: blank is byte-identical to absent, so a pre-4739 record stays
# distinguishable from "the agent said there was nothing to follow up on".

FOLLOW_UPS = (
    '[{"kind":"post_deploy_verification","owner":"agent",'
    '"title":"Re-check the gate ping after deploy",'
    '"detail":"Tap-to-approve path was never exercised on prod.",'
    '"base_branch":"main"}]'
)


def test_follow_ups_forwarded_when_supplied():
    _, payload = _payload(follow_ups=FOLLOW_UPS)
    assert payload["follow_ups"] == FOLLOW_UPS


def test_follow_ups_trimmed_but_not_parsed():
    """The harness must not parse, validate or re-serialise the array — the
    Lambda owns the schema, and a harness that dropped a malformed entry would
    silently swallow the one signal telling an author their JSON was wrong."""
    _, payload = _payload(follow_ups=f"  {FOLLOW_UPS}  ")
    assert payload["follow_ups"] == FOLLOW_UPS
    _, payload = _payload(follow_ups="not json at all")
    assert payload["follow_ups"] == "not json at all"


def test_follow_ups_omitted_keeps_the_pre_4739_payload_exactly():
    _, payload = _payload()
    assert payload == PRE_4121_PAYLOAD
    assert "follow_ups" not in payload


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_follow_ups_blank_is_the_same_as_omitted(blank):
    _, payload = _payload(follow_ups=blank)
    assert payload == PRE_4121_PAYLOAD


def test_follow_ups_rides_along_with_a_ship_verdict():
    """The combination that motivated it: the release manager ships AND declares
    the post-deploy verification it is deliberately not doing itself."""
    _, payload = _payload(
        outcome="shipped",
        merge_commit="2c4781221b41a10974d564da9a27e50004c800dd",
        follow_ups=FOLLOW_UPS,
    )
    assert payload["outcome"] == "shipped"
    assert payload["follow_ups"] == FOLLOW_UPS


def test_follow_ups_is_a_signature_parameter_defaulting_to_blank():
    """Same failure mode as #618's missing parameter: without it in the signature
    Strands rejects the keyword argument and the body can never run."""
    import inspect

    fn, _ = _report_completion()
    params = inspect.signature(fn).parameters
    assert "follow_ups" in params, f"{TOOL_NAME} has no follow_ups parameter"
    assert params["follow_ups"].default == "", 'follow_ups must default to ""'


def test_follow_ups_docstring_names_the_kinds_and_owners():
    """The docstring IS the tool spec Strands ships to the model — a parameter the
    model is never told the shape of is a parameter it never fills."""
    fn, _ = _report_completion()
    doc = fn.__doc__ or ""
    assert "follow_ups" in doc
    for kind in ("post_deploy_verification", "console_handoff", "iam_handoff", "fix", "docs"):
        assert kind in doc, f"docstring does not name the {kind} follow-up kind"
    assert "agent" in doc and "human" in doc
