"""TEAM-4121 FR-8 — `Tickets___create_ticket` must forward the fix-contract
fields, map every one of the six fix kinds to its origin key, and refuse a fix
ticket with no origin id.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_get_issue_tool.py / test_completion_gate.py — the
REAL shipped function is located with `ast` and exec'd in isolation against a
stub `_invoke_lambda`. That runs the actual body (not a copy that could drift)
while touching neither AWS nor the module's import side effects.
"""

import ast
import textwrap
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "Tickets___create_ticket"


def _create_ticket():
    """The real create_ticket body, exec'd with stubbed module globals.

    Returns (fn, calls) where `calls` collects (lambda, tool, payload) tuples.
    """
    tree = ast.parse(MAIN_PY.read_text())
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
    src = textwrap.dedent(ast.get_source_segment(MAIN_PY.read_text(), fn_node))

    calls = []

    def _invoke_lambda(lambda_name, tool, payload):
        calls.append((lambda_name, tool, payload))
        return "ok"

    ns = {
        "_invoke_lambda": _invoke_lambda,
        "TICKET_TOOLS_LAMBDA": "agentcore-hub-tickets",
        "_CURRENT_WORKFLOW_ID": "wf-ctx",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


BASE = dict(title="Fix login", description="prose", assignee="agentcore_hub_backend_dev")


def _payload(**kwargs):
    fn, calls = _create_ticket()
    result = fn(**{**BASE, **kwargs})
    return result, (calls[0][2] if calls else None)


# ─── contract params are forwarded ───────────────────────────────────────────

def test_contract_fields_forwarded_as_fix_contract():
    _, payload = _payload(
        spawned_by_kind="qa_fix",
        spawned_by_origin_id="TEAM-4089",
        phase="development",
        invariant="login test passes 20x in a row",
        evidence_source="unit",
        evidence_repro="npm test -- -g login",
        cited_location="tests/login.spec.ts:44, src/auth.ts:12-30",
        sibling_scope="none",
    )
    assert payload["fix_contract"] == {
        "invariant": "login test passes 20x in a row",
        "evidence_source": "unit",
        "evidence_repro": "npm test -- -g login",
        # comma-split AND per-item trimmed — the agent types "a:1, b:2"
        "cited_location": ["tests/login.spec.ts:44", "src/auth.ts:12-30"],
        "sibling_scope": "none",
    }
    assert payload["phase"] == "development"
    assert payload["spawned_by"] == {"kind": "qa_fix", "qaTicketId": "TEAM-4089"}


def test_no_fix_contract_key_when_no_contract_field_supplied():
    """A plain ticket must not carry an all-empty contract — the Lambda would
    report every field missing and (under enforce) refuse an ordinary ticket."""
    _, payload = _payload()
    assert "fix_contract" not in payload
    assert "labels" not in payload
    assert "spawned_by" not in payload


def test_partial_contract_still_forwarded_for_shadow_mode():
    """One field is enough to send the block: shadow mode records what's missing."""
    _, payload = _payload(spawned_by_kind="ci_fix", spawned_by_origin_id="TEAM-70", invariant="build is green")
    assert payload["fix_contract"]["invariant"] == "build is green"
    assert payload["fix_contract"]["evidence_source"] == ""
    assert payload["fix_contract"]["cited_location"] == []


def test_labels_split_and_trimmed():
    _, payload = _payload(labels=" advisory , follow-up ,, ")
    assert payload["labels"] == ["advisory", "follow-up"]


def test_blank_labels_omitted():
    _, payload = _payload(labels="  ,  ")
    assert "labels" not in payload


# ─── origin map: all six kinds ───────────────────────────────────────────────

@pytest.mark.parametrize(
    "kind,origin_key",
    [
        ("review_fix", "gateTicketId"),
        ("qa_fix", "qaTicketId"),
        ("codex_fix", "codexTicketId"),
        ("ship_fix", "shipTicketId"),
        ("ci_fix", "ciTicketId"),
        ("sync_fix", "ciTicketId"),
    ],
)
def test_origin_map_covers_every_fix_kind(kind, origin_key):
    _, payload = _payload(spawned_by_kind=kind, spawned_by_origin_id="TEAM-500")
    assert payload["spawned_by"] == {"kind": kind, origin_key: "TEAM-500"}


def test_unknown_kind_still_forwarded_for_lambda_side_rejection():
    """The harness does not own the kind allow-list — sanitizeSpawnedBy in the
    Lambda does, and it must be the one place that rejects, so its error text
    reaches the agent unchanged."""
    _, payload = _payload(spawned_by_kind="bogus_fix", spawned_by_origin_id="TEAM-500")
    assert payload["spawned_by"] == {"kind": "bogus_fix"}


# ─── missing origin id is refused by the harness ─────────────────────────────

def test_missing_origin_id_returns_error_and_calls_no_lambda():
    fn, calls = _create_ticket()
    result = fn(**BASE, spawned_by_kind="qa_fix")
    assert result == "Error: spawned_by_origin_id is required when spawned_by_kind is set"
    assert calls == [], "must not create a fix ticket with no lineage"


def test_whitespace_only_origin_id_is_also_refused():
    fn, calls = _create_ticket()
    result = fn(**BASE, spawned_by_kind="ship_fix", spawned_by_origin_id="   ")
    assert result.startswith("Error: spawned_by_origin_id is required")
    assert calls == []


def test_missing_origin_id_is_fine_on_a_non_fix_ticket():
    _, payload = _payload(spawned_by_origin_id="TEAM-1")
    assert "spawned_by" not in payload


# ─── TEAM-4749 A1a: base_branch ───────────────────────────────────────────────
#
# The signature had no `base_branch` while blueprints/release-manager.md already
# told the release manager to pass it, so Strands rejected the keyword and a
# hub-infra fix ticket was unfileable. Both ticket twins already read and
# validate the key; only the harness half was missing. Name parity across the
# Lambda boundary is asserted in src/lib/workflow/tool-signature-parity.test.ts —
# what is left for here is the payload behaviour.

def test_base_branch_forwarded_when_supplied():
    _, payload = _payload(base_branch="main")
    assert payload["base_branch"] == "main"


def test_base_branch_is_trimmed():
    """The Lambda validates the value against a ref-name pattern before minting an
    id, so a stray space would be refused as an invalid branch rather than
    ignored."""
    _, payload = _payload(base_branch="  main\n")
    assert payload["base_branch"] == "main"


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n  "])
def test_blank_base_branch_omitted(blank):
    """Absent means "no branch was stated" — the run's own integration branch is
    the default. Sending "" would make every ordinary ticket look like it named a
    branch and got an empty one."""
    _, payload = _payload(base_branch=blank)
    assert "base_branch" not in payload


def test_all_blank_equals_the_pre_4749_payload():
    """A call that passes nothing new must be byte-identical to what shipped
    before, which is what makes this an additive change rather than a payload
    change for every persona in the fleet."""
    _, payload = _payload(base_branch="", labels="", phase="")
    assert payload == {
        "summary": "Fix login",
        "description": "prose",
        "parent_key": "",
        "assignee": "agentcore_hub_backend_dev",
        "issue_type": "task",
        "blocked_by": [],
        "workflow_id": "wf-ctx",
    }
