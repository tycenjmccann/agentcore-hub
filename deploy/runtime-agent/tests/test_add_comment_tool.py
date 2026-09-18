"""TEAM-4749 sibling sweep — `Tickets___add_comment` must reach BOTH ticket twins.

The two ticket Lambdas are meant to expose one identical `Tickets___*` interface
(CLAUDE.md), but they disagreed on the wire name for a comment's text:

  - Jira twin      `lambda/agentcore-hub-jira/index.mjs` addComment:
                   `const { ticket_id, comment } = params;`   → reads `comment`
  - DynamoDB twin  `lambda/agentcore-hub-tickets/index.mjs` addComment:
                   `const body = args.body || args.content;`  → reads `body`

The wrapper sent only `comment`, so on the DDB twin every comment came back
`Error: 'body' is required` and nothing was written. That twin is what
`TICKET_PROVIDER=dynamodb` deploys, and dynamodb is the CODE default when the var
is unset (`deploy/setup-tickets-lambda.mjs:44`), so the tool was dead for anyone
running the documented DynamoDB mode.

The fix is the one `Tickets___get_issue` already uses for the same disagreement
about the ticket key (`ticket_id` + `issue_key`, main.py): send both spellings.
`args.body` is read in exactly ONE place across both twins and neither twin
rejects unknown keys, so the extra key is inert on Jira rather than a second
behaviour to reason about.

main.py cannot be imported (module top-level installs Node.js, fetches from S3,
chdirs), so — matching test_create_ticket_tool.py / test_get_issue_tool.py — the
REAL shipped function is located with `ast` and exec'd against a stub
`_invoke_lambda`. That runs the actual body, not a copy that could drift.
"""

import ast
import textwrap
from pathlib import Path

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
TOOL_NAME = "Tickets___add_comment"


def _add_comment():
    """The real add_comment body, exec'd with stubbed module globals.

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
        "TICKET_TOOLS_LAMBDA": "agentcore-hub-tickets",
    }
    exec(compile(src, str(MAIN_PY), "exec"), ns)
    return ns[TOOL_NAME], calls


def _payload(**kwargs):
    fn, calls = _add_comment()
    result = fn(**kwargs)
    assert calls, "add_comment must invoke the ticket-tools Lambda"
    return result, calls[0]


# ─── the text reaches both twins ─────────────────────────────────────────────


def test_comment_text_is_sent_under_both_wire_names():
    """The defect and its fix, stated once: whatever the persona wrote must be
    readable by a twin looking for `comment` AND by a twin looking for `body`."""
    _, (_, tool, payload) = _payload(ticket_id="TEAM-42", comment="LGTM, shipping")
    assert tool == TOOL_NAME
    assert payload["comment"] == "LGTM, shipping"
    assert payload["body"] == "LGTM, shipping"


def test_the_two_spellings_never_disagree():
    """A twin picks ONE of these keys and never sees the other, so if they could
    ever carry different text the same comment would read differently depending
    on which provider was deployed. They are one value by construction."""
    for text in ("plain", "with 'quotes' and \"doubles\"", "multi\nline\ntext", "  padded  "):
        _, (_, _, payload) = _payload(ticket_id="TEAM-1", comment=text)
        assert payload["comment"] == payload["body"] == text


def test_ticket_id_is_sent_under_the_key_both_twins_accept():
    """`ticket_id` needs no twin: Jira destructures it directly and the DDB twin
    reads `issue_key || ticket_id`, so one spelling already satisfies both."""
    _, (_, _, payload) = _payload(ticket_id="TEAM-99", comment="c")
    assert payload["ticket_id"] == "TEAM-99"


def test_no_other_keys_are_invented():
    """The payload is exactly what the two twins read between them. A stray key
    would be silently dropped by both, which is how the original defect hid."""
    _, (_, _, payload) = _payload(ticket_id="TEAM-7", comment="c")
    assert set(payload) == {"ticket_id", "comment", "body"}


def test_it_still_targets_the_ticket_tools_lambda():
    _, (lambda_name, _, _) = _payload(ticket_id="TEAM-7", comment="c")
    assert lambda_name == "agentcore-hub-tickets"


# ─── the twins' read sites, asserted against the shipped Lambda source ────────
#
# Read-only. TEAM-4749 owns neither Lambda; these two tests are what make the
# dual-key payload above provably right rather than defensive guesswork, and they
# fail if a future change to either twin makes one of the spellings unnecessary
# or insufficient.

LAMBDA_DIR = MAIN_PY.parent.parent.parent / "lambda"


def _lambda_function_source(path: Path, name: str) -> str:
    """One `async function <name>(…)` slice, to the next top-level declaration."""
    text = path.read_text()
    start = text.index(f"async function {name}(")
    rest = text[start:]
    end = rest.find("\nasync function ", 1)
    return rest if end == -1 else rest[:end]


def test_ddb_twin_still_reads_body_and_not_comment():
    src = _lambda_function_source(
        LAMBDA_DIR / "agentcore-hub-tickets" / "index.mjs", "addComment"
    )
    assert "args.body" in src, "the DDB twin stopped reading `body` — re-check the payload"
    assert "args.comment" not in src, (
        "the DDB twin now reads `comment` too; `body` may no longer be needed"
    )


def test_jira_twin_still_reads_comment():
    src = _lambda_function_source(LAMBDA_DIR / "agentcore-hub-jira" / "index.mjs", "addComment")
    assert "comment" in src, "the Jira twin stopped reading `comment` — re-check the payload"
