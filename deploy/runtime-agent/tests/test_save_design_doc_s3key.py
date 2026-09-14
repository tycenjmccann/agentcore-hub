"""TEAM-4569 — `WorkflowOutput___save_design_doc` must be able to register a doc
by REFERENCE, and must send a byte-identical payload when it isn't asked to.

Both halves matter. A 97 KB design doc killed backend_designer with
MaxTokensReachedException four times over, because the only way to register a
document was to re-emit the whole thing as a tool argument — while the document
was already sitting in S3. So the harness has to forward an `s3Key` when the
agent supplies one. And it must NOT start sending `s3Key`/`content` always — as
"" — because the Lambda treats blank and absent identically only if the harness
never invents the key: a payload that always carried `s3Key: ""` would make
"the agent passed nothing" indistinguishable from "the agent passed a blank key",
and every content-only call would change shape at once.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_report_completion_evidence.py — the REAL shipped
function is located with `ast` and exec'd in isolation against a stub
`_invoke_lambda`.
"""

import ast
import inspect
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "WorkflowOutput___save_design_doc"
WORKFLOW_OUTPUT_LAMBDA = "agentcore-hub-workflow-output"


def _save_design_doc():
    """The real save_design_doc body, exec'd with stubbed module globals.

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
        "WORKFLOW_OUTPUT_LAMBDA": WORKFLOW_OUTPUT_LAMBDA,
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


BASE = dict(workflow_id="wf_1", agent_id="agentcore_hub_backend_designer")
DOC = "# Backend design\n\nOne paragraph.\n"
STAGED = "workflows/wf_1/agentcore_hub_backend_designer/backend-design.md"

# Exactly the payload a pre-4569 harness sent. Asserted WHOLE (not key-by-key) so
# an accidental extra field fails here rather than in the Lambda.
PRE_4569_PAYLOAD = {
    "workflow_id": "wf_1",
    "agent_id": "agentcore_hub_backend_designer",
    "content": DOC,
    "doc_type": "design",
}


def _payload(**kwargs):
    fn, calls = _save_design_doc()
    result = fn(**{**BASE, **kwargs})
    return result, (calls[0][2] if calls else None)


# ─── content-only → byte-identical to the pre-4569 payload ────────────────────

def test_content_only_sends_exactly_the_pre_4569_payload():
    _, payload = _payload(content=DOC)
    assert payload == PRE_4569_PAYLOAD


def test_content_only_key_set_is_exactly_the_four_original_keys():
    _, payload = _payload(content=DOC)
    assert set(payload) == {"workflow_id", "agent_id", "content", "doc_type"}
    assert "s3Key" not in payload


def test_content_is_forwarded_unstripped():
    """The document's own leading/trailing whitespace is not the harness's to
    edit — only the "did the agent say anything" test strips."""
    _, payload = _payload(content="\n# Design\n\n")
    assert payload["content"] == "\n# Design\n\n"


def test_doc_type_override_still_rides_along():
    _, payload = _payload(content=DOC, doc_type="spec")
    assert payload["doc_type"] == "spec"


# ─── s3Key → forwarded, and no content key at all ─────────────────────────────

def test_s3key_only_forwards_the_key_and_no_content_key():
    _, payload = _payload(s3Key=STAGED)
    assert payload["s3Key"] == STAGED
    assert "content" not in payload
    assert set(payload) == {"workflow_id", "agent_id", "doc_type", "s3Key"}


def test_s3key_is_trimmed():
    _, payload = _payload(s3Key=f"  {STAGED}  ")
    assert payload["s3Key"] == STAGED


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_blank_s3key_is_the_same_as_omitted(blank):
    _, payload = _payload(content=DOC, s3Key=blank)
    assert payload == PRE_4569_PAYLOAD


def test_blank_content_with_an_s3key_sends_no_content_key():
    _, payload = _payload(content="   ", s3Key=STAGED)
    assert "content" not in payload
    assert payload["s3Key"] == STAGED


def test_both_forwarded_because_the_lambda_owns_precedence():
    """The harness does not decide which one wins — the workflow-output Lambda
    does (s3Key takes precedence, with a warning), and it must be the one place
    that decides, so the same rule applies whether the call arrives from a
    runtime agent or a gateway."""
    _, payload = _payload(content=DOC, s3Key=STAGED)
    assert payload["content"] == DOC
    assert payload["s3Key"] == STAGED


def test_neither_forwards_neither_and_lets_the_lambda_reject():
    _, payload = _payload()
    assert "content" not in payload
    assert "s3Key" not in payload


# ─── routing + signature ──────────────────────────────────────────────────────

def test_lambda_and_tool_name_unchanged():
    fn, calls = _save_design_doc()
    fn(**BASE, s3Key=STAGED)
    assert len(calls) == 1
    assert calls[0][0] == WORKFLOW_OUTPUT_LAMBDA
    assert calls[0][1] == TOOL_NAME


def test_signature_parameters_and_defaults():
    """Pins two decisions at once. `content` became optional and `s3Key` was
    APPENDED, so doc_type keeps its position and default — a positional caller is
    unaffected. And there is deliberately no `title`/`format`: the destination
    filename is derived from `title`, so adding it would rename every file this
    tool has ever produced.
    """
    fn, _ = _save_design_doc()
    params = inspect.signature(fn).parameters
    assert list(params) == ["workflow_id", "agent_id", "content", "doc_type", "s3Key"]
    assert params["workflow_id"].default is inspect.Parameter.empty
    assert params["agent_id"].default is inspect.Parameter.empty
    assert params["content"].default == ""
    assert params["doc_type"].default == "design"
    assert params["s3Key"].default == ""


def test_docstring_tells_the_model_to_write_first_and_never_re_emit():
    """The docstring IS the tool description the model reads; if it does not say
    to stage the doc and pass the key, the token blowup this ticket fixes simply
    keeps happening with an unused parameter available."""
    fn, _ = _save_design_doc()
    doc = fn.__doc__ or ""
    assert "S3Storage___write_object" in doc
    assert "workflows/{workflow_id}/{agent_id}/<slug>.md" in doc
    assert "s3Key" in doc
