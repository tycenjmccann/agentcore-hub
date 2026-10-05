"""TEAM-5321 FR-15: the Deploy stage loads every ticket/workflow-output zip before
it replaces live code, and checks the live functions after.

A ticket-Lambda zip without gate-contract.mjs deployed green because nothing
imported it; every tool call then died with ERR_MODULE_NOT_FOUND. These tests pin:

  * lambda-import-smoke.mjs passes the twins' REAL zips (built from
    deploy/pipeline/surfaces.json files[], exactly what the Deploy stage zips),
    including the in-process get_transitions canary;
  * the same zip minus gate-contract.mjs fails with the module error
    (Acceptance 11), as do a handler that is not a function and one that hangs;
  * lambda-live-smoke.sh fails on a FunctionError or module-error text, against
    a fake `aws`;
  * buildspec-deploy.yml runs the import smoke after the rollback trap is armed
    and before update-function-code, and the live smoke before the trap is
    disarmed.

Needs `node` and the repo's root node_modules (CI runs `npm ci` first); skipped
otherwise.
"""

import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SMOKE = REPO / "deploy" / "pipeline" / "lambda-import-smoke.mjs"
LIVE_SMOKE = REPO / "deploy" / "pipeline" / "lambda-live-smoke.sh"
SURFACES = REPO / "deploy" / "pipeline" / "surfaces.json"
BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-deploy.yml"
TWINS = ("agentcore-hub-tickets", "agentcore-hub-jira")
CANARY = '{"tool_name":"Tickets___get_transitions","parameters":{"issue_key":"CANARY-SMOKE","ticket_id":"CANARY-SMOKE"}}'

needs_node = pytest.mark.skipif(
    shutil.which("node") is None or not (REPO / "node_modules" / "@aws-sdk" / "client-dynamodb").exists(),
    reason="needs node + the repo's root node_modules (npm ci)",
)


def surface(fn):
    rows = json.loads(SURFACES.read_text())["lambdas"]
    return next(r for r in rows if r["function"] == fn)


def build_zip(tmp_path, fn, drop=()):
    """Mirror the Deploy stage's `cd $DIR && zip -rq /tmp/surface.zip $FILES`."""
    row = surface(fn)
    src = REPO / row["dir"]
    out = tmp_path / f"{fn}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in row["files"]:
            if f in drop:
                continue
            p = src / f
            if p.is_dir():
                for sub in sorted(p.rglob("*")):
                    if sub.is_file():
                        z.write(sub, sub.relative_to(src).as_posix())
            else:
                z.write(p, f)
    return out


def fixture_zip(tmp_path, name, source):
    out = tmp_path / f"{name}.zip"
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("index.mjs", source)
    return out


def smoke(*args):
    return subprocess.run(
        ["node", str(SMOKE), *map(str, args)], capture_output=True, text=True, timeout=120
    )


@needs_node
@pytest.mark.parametrize("fn", TWINS)
def test_twin_zip_passes_smoke(tmp_path, fn):
    r = smoke(build_zip(tmp_path, fn), "index.mjs", "--canary", "get_transitions")
    assert r.returncode == 0, r.stderr
    assert "import-smoke OK index.mjs" in r.stdout
    assert "canary=" in r.stdout


@needs_node
@pytest.mark.parametrize("fn", TWINS)
def test_missing_gate_contract_fails(tmp_path, fn):
    """Acceptance 11: the outage zip must not pass."""
    zip_path = build_zip(tmp_path, fn, drop=("gate-contract.mjs",))
    r = smoke(zip_path, "index.mjs", "--canary", "get_transitions")
    assert r.returncode != 0
    assert "IMPORT SMOKE FAILED" in r.stderr
    assert "ERR_MODULE_NOT_FOUND" in r.stderr or "Cannot find module" in r.stderr
    assert "gate-contract.mjs" in r.stderr


@needs_node
def test_sdk_link_does_not_mask_a_missing_local_module(tmp_path):
    """The SDK is linked beside the extract dir, never into it: a relative import
    of a file absent from the zip still fails even though the repo has one."""
    zip_path = fixture_zip(
        tmp_path, "rel",
        'import "@aws-sdk/client-s3";\nimport "./gate-contract.mjs";\nexport const handler = async () => ({});\n',
    )
    r = smoke(zip_path, "index.mjs")
    assert r.returncode != 0
    assert "gate-contract.mjs" in r.stderr


@needs_node
def test_handler_not_a_function_fails(tmp_path):
    r = smoke(fixture_zip(tmp_path, "nohandler", "export const handle = async () => ({});\n"), "index.mjs")
    assert r.returncode != 0
    assert "handler is not a function" in r.stderr


@needs_node
def test_canary_module_error_text_fails(tmp_path):
    src = 'export const handler = async () => ({ content: [{ text: "Error: Cannot find module \'./x.mjs\'" }] });\n'
    r = smoke(fixture_zip(tmp_path, "texterr", src), "index.mjs", "--canary", "get_transitions")
    assert r.returncode != 0
    assert "module error" in r.stderr


@needs_node
def test_hanging_handler_times_out(tmp_path):
    src = "export const handler = () => new Promise(() => { setInterval(() => {}, 1000); });\n"
    r = smoke(fixture_zip(tmp_path, "hang", src), "index.mjs", "--canary", "get_transitions", "--timeout-ms", "1500")
    assert r.returncode != 0
    assert "timed out" in r.stderr


# ── lambda-live-smoke.sh against a fake `aws` ────────────────────────────────

FAKE_AWS = """#!/bin/bash
# get-function-configuration: exit $FAKE_MISSING (0 = exists). invoke: write
# $FAKE_BODY to the outfile (last arg) and $FAKE_META to stdout.
case "$2" in
  get-function-configuration) [ "${FAKE_MISSING:-0}" = "1" ] && exit 254; echo '{}' ;;
  invoke) for a; do out="$a"; done; printf '%s' "$FAKE_BODY" > "$out"; printf '%s' "$FAKE_META" ;;
esac
"""


def live(tmp_path, *args, body="{}", meta='{"StatusCode": 200}', missing=False):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "aws").write_text(FAKE_AWS)
    (bindir / "aws").chmod(0o755)
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "FAKE_BODY": body, "FAKE_META": meta,
           "FAKE_MISSING": "1" if missing else "0"}
    return subprocess.run(["bash", str(LIVE_SMOKE), *args], capture_output=True, text=True, env=env, timeout=60)


def test_live_smoke_clean_passes(tmp_path):
    r = live(tmp_path, "agentcore-hub-tickets", "us-east-1", CANARY,
             body='{"content":[{"text":"Issue CANARY-SMOKE not found."}]}')
    assert r.returncode == 0, r.stderr
    assert "live smoke OK" in r.stdout


def test_live_smoke_function_error_fails(tmp_path):
    r = live(tmp_path, "agentcore-hub-jira", "us-east-1", CANARY,
             body='{"errorType":"Runtime.ImportModuleError"}',
             meta='{"StatusCode": 200, "FunctionError": "Unhandled"}')
    assert r.returncode != 0
    assert "FunctionError" in r.stderr


def test_live_smoke_module_error_text_fails(tmp_path):
    r = live(tmp_path, "agentcore-hub-tickets", "us-east-1", CANARY,
             body='{"content":[{"text":"Error: Cannot find module \'/var/task/gate-contract.mjs\'"}]}')
    assert r.returncode != 0
    assert "module error" in r.stderr


def test_live_smoke_optional_missing_skips_required_missing_fails(tmp_path):
    ok = live(tmp_path, "--optional", "agentcore-hub-tickets", "us-east-1", CANARY, missing=True)
    assert ok.returncode == 0 and "skipped" in ok.stdout
    bad = live(tmp_path, "agentcore-hub-workflow-output", "us-east-1", "{}", missing=True)
    assert bad.returncode != 0


# ── buildspec wiring ────────────────────────────────────────────────────────

def test_buildspec_runs_import_smoke_under_the_trap_before_update():
    lines = BUILDSPEC.read_text().splitlines()
    idx = lambda pred: next(i for i, l in enumerate(lines) if pred(l))  # noqa: E731
    trap = idx(lambda l: l.strip().startswith("trap 'rc=$?"))
    loop = idx(lambda l: "while IFS=$'\\t' read -r KIND FN DIR NPM OPTIONAL FILES NOTE" in l)
    zip_line = idx(lambda l: "zip -rq /tmp/surface.zip $FILES" in l)
    update = next(i for i in range(zip_line, len(lines)) if "--zip-file fileb:///tmp/surface.zip" in lines[i])
    smokes = [i for i, l in enumerate(lines) if "lambda-import-smoke.mjs /tmp/surface.zip" in l]
    assert len(smokes) == 2
    assert all(trap < loop < zip_line < i < update for i in smokes)
    case = "\n".join(lines[zip_line:update])
    assert "agentcore-hub-tickets|agentcore-hub-jira)" in case
    assert case.count("--canary get_transitions") == 1
    assert "agentcore-hub-workflow-output)" in case


def test_buildspec_runs_live_smoke_before_the_trap_is_disarmed():
    lines = BUILDSPEC.read_text().splitlines()
    trap = next(i for i, l in enumerate(lines) if l.strip().startswith("trap 'rc=$?"))
    disarm = next(i for i, l in enumerate(lines) if l.strip() == "trap - EXIT")
    live_calls = {l.split()[2] if l.split()[2] != "--optional" else l.split()[3]: i
                  for i, l in enumerate(lines) if "lambda-live-smoke.sh" in l and l.strip().startswith("bash ")}
    assert set(live_calls) == {"agentcore-hub-tickets", "agentcore-hub-jira", "agentcore-hub-workflow-output"}
    assert all(trap < i < disarm for i in live_calls.values())
