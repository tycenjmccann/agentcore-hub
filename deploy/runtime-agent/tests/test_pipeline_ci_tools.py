"""TEAM-4122 FR-4 / TEAM-4338 — `Pipeline___start_ci_build` / `Pipeline___capabilities`
harness wrappers must forward exactly what the Lambda contract expects:
commit_sha always, source_version and project only when the agent supplied one
(never as ""), and all six Pipeline___* tools must be registered in
LAMBDA_TOOLS so the fleet actually gets them.

TEAM-4338 (Multi-CD Lane 2) taught the pipeline-tools Lambda to serve more than
one CodePipeline: `start_ci_build` gained a `project` argument and
`capabilities` gained `pipeline_name`, both omitted from the payload when
blank exactly like the pre-existing `source_version` omission — a blank
project/pipeline_name must read the Lambda's env-default target, not an
explicit-but-empty one.

TEAM-4525 (conditional deploy gate) widened `start_deploy` with the merge
attestation the pipeline verifies before skipping the human deploy gate
(`approved_head_sha`, `ci_build_id` + audit context) and `report_completion`
with `approved_head_sha`. Both follow the same omit-when-blank rule: the gate is
fail-closed, so a blank must be ABSENT from the payload rather than sent as ""
which would look like an attestation of nothing.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py / test_report_completion_evidence.py
— the REAL shipped function is located with `ast` and exec'd in isolation
against a stub `_invoke_lambda`.
"""

import ast
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"


def _load_tool(tool_name):
    """The real tool body, exec'd with stubbed module globals.

    Returns (fn, calls) where `calls` collects (lambda, tool, payload) tuples.
    """
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    fn_node = next(
        (
            n
            for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == tool_name
        ),
        None,
    )
    assert fn_node is not None, f"{tool_name} function def not found in main.py"
    # drop the @tool decorator — strands would wrap the callable in a ToolSpec
    src = textwrap.dedent(ast.get_source_segment(source, fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "PIPELINE_TOOLS_LAMBDA": "agentcore-hub-pipeline-tools",
        "WORKFLOW_OUTPUT_LAMBDA": "agentcore-hub-workflow-output",
        "_CURRENT_WORKFLOW_ID": "wf-ctx",
        "_CURRENT_AGENT_ID": "agentcore_hub_release_manager",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[tool_name], calls


# ─── start_ci_build ───────────────────────────────────────────────────────────

def test_forwards_commit_sha_only_when_source_version_omitted():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234")
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-pipeline-tools"
    assert tool == "Pipeline___start_ci_build"
    assert payload == {"commit_sha": "abc1234"}
    assert "source_version" not in payload


def test_forwards_source_version_when_supplied():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", source_version="pr/42")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234", "source_version": "pr/42"}


def test_blank_source_version_is_omitted_like_default():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", source_version="")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234"}


def test_forwards_project_when_supplied():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", project="hub-widget-ci")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234", "project": "hub-widget-ci"}


def test_blank_project_is_omitted_like_default():
    fn, calls = _load_tool("Pipeline___start_ci_build")
    fn(commit_sha="abc1234", project="")
    _, _, payload = calls[0]
    assert payload == {"commit_sha": "abc1234"}  # equals the no-project payload


# ─── capabilities ─────────────────────────────────────────────────────────────

def test_capabilities_forwards_no_args():
    fn, calls = _load_tool("Pipeline___capabilities")
    fn()
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-pipeline-tools"
    assert tool == "Pipeline___capabilities"
    assert payload == {}


def test_capabilities_forwards_pipeline_name_when_supplied():
    fn, calls = _load_tool("Pipeline___capabilities")
    fn(pipeline_name="hub-widget-deploy")
    _, _, payload = calls[0]
    assert payload == {"pipeline_name": "hub-widget-deploy"}


def test_capabilities_blank_pipeline_name_is_omitted_like_default():
    fn, calls = _load_tool("Pipeline___capabilities")
    fn(pipeline_name="")
    _, _, payload = calls[0]
    assert payload == {}


# ─── TEAM-4525: start_deploy merge-attestation fields ─────────────────────────
# The conditional deploy gate is skipped only when the pipeline can VERIFY that
# the deployed commit is the merge of a human-approved head SHA. The wrapper's
# only job is to forward that evidence when the agent has it and to stay silent
# when it doesn't — an empty-but-present field would read as an attestation of
# nothing, so blanks must be absent from the payload entirely (fail-closed).

def test_start_deploy_forwards_only_what_was_supplied():
    fn, calls = _load_tool("Pipeline___start_deploy")
    fn(pipeline_name="hub-widget-deploy", commit_sha="0ef5892")
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-pipeline-tools"
    assert tool == "Pipeline___start_deploy"
    # pre-4525 payload, byte-identical
    assert payload == {"pipeline_name": "hub-widget-deploy", "commit_sha": "0ef5892"}


def test_start_deploy_forwards_attestation_fields_when_supplied():
    fn, calls = _load_tool("Pipeline___start_deploy")
    fn(
        pipeline_name="hub-widget-deploy",
        commit_sha="0ef5892",
        approved_head_sha="deadbeef",
        ci_build_id="hub-widget-ci:abc-123",
        pr_url="https://github.com/o/r/pull/7",
        workflow_id="wf-1",
        ticket_id="TEAM-4525",
    )
    _, _, payload = calls[0]
    assert payload == {
        "pipeline_name": "hub-widget-deploy",
        "commit_sha": "0ef5892",
        "approved_head_sha": "deadbeef",
        "ci_build_id": "hub-widget-ci:abc-123",
        "pr_url": "https://github.com/o/r/pull/7",
        "workflow_id": "wf-1",
        "ticket_id": "TEAM-4525",
    }


def test_start_deploy_attestation_fields_are_trimmed():
    fn, calls = _load_tool("Pipeline___start_deploy")
    fn(commit_sha="0ef5892", approved_head_sha="  deadbeef  ", ci_build_id=" p:1 ")
    _, _, payload = calls[0]
    assert payload["approved_head_sha"] == "deadbeef"
    assert payload["ci_build_id"] == "p:1"


@pytest.mark.parametrize(
    "field",
    ["approved_head_sha", "ci_build_id", "pr_url", "workflow_id", "ticket_id"],
)
@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_start_deploy_blank_attestation_field_is_absent_not_empty(field, blank):
    fn, calls = _load_tool("Pipeline___start_deploy")
    fn(commit_sha="0ef5892", **{field: blank})
    _, _, payload = calls[0]
    assert field not in payload
    assert payload == {"commit_sha": "0ef5892"}


def test_start_deploy_all_blank_equals_the_pre_4525_payload():
    fn, calls = _load_tool("Pipeline___start_deploy")
    fn(
        pipeline_name="hub-widget-deploy",
        commit_sha="0ef5892",
        approved_head_sha="",
        ci_build_id="  ",
        pr_url="",
        workflow_id="",
        ticket_id="   ",
    )
    _, _, payload = calls[0]
    assert payload == {"pipeline_name": "hub-widget-deploy", "commit_sha": "0ef5892"}


def test_start_deploy_has_no_approval_argument():
    """No tool may approve the human deploy gate — the wrapper must not grow an
    approve/PutApprovalResult surface alongside the attestation fields."""
    import inspect

    fn, _ = _load_tool("Pipeline___start_deploy")
    params = set(inspect.signature(fn).parameters)
    assert not any("approv" in p and p != "approved_head_sha" for p in params)
    assert "putApprovalResult" not in (fn.__doc__ or "")


# ─── TEAM-4525: report_completion records the approved head SHA ────────────────

def test_report_completion_forwards_approved_head_sha_with_merge_commit():
    fn, calls = _load_tool("WorkflowOutput___report_completion")
    fn(
        ticket_id="TEAM-4525",
        summary="Merged and deployed.",
        merge_commit=" 0ef5892 ",
        approved_head_sha=" deadbeef ",
        outcome="shipped",
    )
    assert len(calls) == 1
    lambda_name, tool, payload = calls[0]
    assert lambda_name == "agentcore-hub-workflow-output"
    assert tool == "WorkflowOutput___report_completion"
    assert payload["merge_commit"] == "0ef5892"
    assert payload["approved_head_sha"] == "deadbeef"


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_report_completion_blank_approved_head_sha_is_absent(blank):
    fn, calls = _load_tool("WorkflowOutput___report_completion")
    fn(ticket_id="TEAM-4525", summary="Merged.", merge_commit="0ef5892", approved_head_sha=blank)
    _, _, payload = calls[0]
    assert "approved_head_sha" not in payload
    assert payload["merge_commit"] == "0ef5892"


def test_report_completion_omitted_approved_head_sha_is_absent():
    fn, calls = _load_tool("WorkflowOutput___report_completion")
    fn(ticket_id="TEAM-4525", summary="Nothing to ship.")
    _, _, payload = calls[0]
    assert "approved_head_sha" not in payload


# ─── LAMBDA_TOOLS registration ────────────────────────────────────────────────

def test_all_six_pipeline_tools_registered_in_lambda_tools():
    source = MAIN_PY.read_text()
    tree = ast.parse(source)
    lambda_tools_node = next(
        (
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "LAMBDA_TOOLS" for t in n.targets)
        ),
        None,
    )
    assert lambda_tools_node is not None, "LAMBDA_TOOLS assignment not found in main.py"
    names = {elt.id for elt in lambda_tools_node.value.elts if isinstance(elt, ast.Name)}
    for tool_name in (
        "Pipeline___get_state",
        "Pipeline___start_deploy",
        "Pipeline___get_build_status",
        "Pipeline___get_build_log",
        "Pipeline___start_ci_build",
        "Pipeline___capabilities",
    ):
        assert tool_name in names
