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

TEAM-5337 adds (lambda-smoke-contract.mjs):
  * the smoke's dependency list is DERIVED from each zip's bare imports — never a
    hardcoded list — and a node_modules holding only that list passes the smoke,
    while the old hardcoded list fails on @aws-sdk/client-secrets-manager;
  * the canary passes only on a positive envelope shape, one rule for the import
    smoke and the live canary, so a TypeError envelope fails both.

TEAM-5346 (review r2 of TEAM-5325) adds the bundle contract:
  * a zip that ships node_modules/ is scanned too, and `deps` refuses it unless
    every bare import resolves inside the bundle AND is declared in the zip's own
    package.json dependencies (workflow-output declared 2 of its 6 imports and
    failed the Deploy stage's import smoke on a clean `npm ci --omit=dev`);
  * every npm:true surface in the manifest is pinned both statically (imports
    are a subset of dependencies) and for real (npm ci in a temp copy, zip from
    files[], `deps` + import smoke) behind SMOKE_NPM_INSTALL=1, which both CI
    rails set;
  * the Deploy stage runs `deps` for every NPM=1 row before the import smoke.

The twin tests need the repo's root node_modules (`needs_node`; CI runs `npm ci`
first). The bundle tests need only system node/npm - a bundled zip brings its
own node_modules and the smoke itself imports builtins only.
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
CONTRACT = REPO / "deploy" / "pipeline" / "lambda-smoke-contract.mjs"
LIVE_SMOKE = REPO / "deploy" / "pipeline" / "lambda-live-smoke.sh"
SURFACES = REPO / "deploy" / "pipeline" / "surfaces.json"
BUILDSPEC = REPO / "deploy" / "pipeline" / "buildspec-deploy.yml"
TWINS = ("agentcore-hub-tickets", "agentcore-hub-jira")
CANARY = "get_transitions"
# The list Target 1b installed before TEAM-5337 — what a clean install got.
OLD_HARDCODED_DEPS = ("@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-s3", "@aws-sdk/client-lambda")
TYPEERROR_ENVELOPE = {"isError": True, "error": "TypeError: Cannot read properties of undefined (reading 'getTransitions')"}

needs_node = pytest.mark.skipif(
    shutil.which("node") is None or not (REPO / "node_modules" / "@aws-sdk" / "client-dynamodb").exists(),
    reason="needs node + the repo's root node_modules (npm ci)",
)
needs_node_only = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
real_install = pytest.mark.skipif(
    os.environ.get("SMOKE_NPM_INSTALL") != "1" or shutil.which("npm") is None or shutil.which("node") is None,
    reason="real registry install; set SMOKE_NPM_INSTALL=1",
)

_ROWS = json.loads(SURFACES.read_text())["lambdas"]
BUNDLED = [r["function"] for r in _ROWS if r.get("npm")]
WITH_INDEX = [r["function"] for r in _ROWS if (REPO / r["dir"] / "index.mjs").exists()]


def surface(fn):
    rows = json.loads(SURFACES.read_text())["lambdas"]
    return next(r for r in rows if r["function"] == fn)


def build_zip(tmp_path, fn, drop=(), node_modules=None):
    """Mirror the Deploy stage's `cd $DIR && zip -rq /tmp/surface.zip $FILES`.

    A listed dir that is not in the checkout (node_modules/ is gitignored) is
    skipped, so an npm:true row zips as its sources alone; pass `node_modules`
    (a dir produced by a real `npm ci`) to bundle it the way Target 1b does."""
    row = surface(fn)
    src = REPO / row["dir"]
    out = tmp_path / f"{fn}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in row["files"]:
            if f in drop:
                continue
            p = src / f
            if f.endswith("/") and f.rstrip("/") == "node_modules" and node_modules is not None:
                p = Path(node_modules)
                for sub in sorted(p.rglob("*")):
                    if sub.is_file():
                        z.write(sub, ("node_modules" / sub.relative_to(p)).as_posix())
                continue
            if f.endswith("/") and not p.is_dir():
                continue
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
  invoke) prev=""; for a; do [ "$prev" = "--payload" ] && printf '%s' "$a" > "$FAKE_PAYLOAD_LOG"; prev="$a"; out="$a"; done
          printf '%s' "$FAKE_BODY" > "$out"; printf '%s' "$FAKE_META" ;;
esac
"""


def live(tmp_path, *args, body="{}", meta='{"StatusCode": 200}', missing=False):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    (bindir / "aws").write_text(FAKE_AWS)
    (bindir / "aws").chmod(0o755)
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "FAKE_BODY": body, "FAKE_META": meta,
           "FAKE_MISSING": "1" if missing else "0", "FAKE_PAYLOAD_LOG": str(tmp_path / "payload.b64")}
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
    assert "unexpected get_transitions envelope" in r.stderr


def test_live_smoke_optional_missing_skips_required_missing_fails(tmp_path):
    ok = live(tmp_path, "--optional", "agentcore-hub-tickets", "us-east-1", CANARY, missing=True)
    assert ok.returncode == 0 and "skipped" in ok.stdout
    bad = live(tmp_path, "agentcore-hub-workflow-output", "us-east-1", "unknown_tool", missing=True)
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


def test_buildspec_live_smoke_passes_kinds_not_payloads():
    """TEAM-5337: payloads live in lambda-smoke-contract.mjs, next to the rule."""
    text = BUILDSPEC.read_text()
    assert "CANARY_PAYLOAD" not in text
    calls = [l.split() for l in text.splitlines() if l.strip().startswith("bash deploy/pipeline/lambda-live-smoke.sh")]
    kinds = {(c[3] if c[2] == "--optional" else c[2]): c[-1] for c in calls}
    assert kinds == {"agentcore-hub-tickets": "get_transitions", "agentcore-hub-jira": "get_transitions",
                     "agentcore-hub-workflow-output": "unknown_tool"}


# ── TEAM-5337: smoke dependencies derived from the zip ──────────────────────

# An independent scanner (Python, not the module under test): every bare
# specifier a source file imports, comments stripped. Deliberately simple — the
# assertion is derived ⊇ this, so a miss in either one shows up.
# A specifier has no whitespace: that keeps a prose string concatenation such as
# `'... from ' +\n '...'` (eval-packager index.mjs) out of the set.
_PY_IMPORT = __import__("re").compile(
    r"""(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)["']([^"'./\s][^"'\s]*)["']""")
_PY_COMMENT = __import__("re").compile(r"/\*.*?\*/|(?<![:\"'])//[^\n]*", __import__("re").S)


_IGNORE = [__import__("re").compile(p) for p in json.loads(SURFACES.read_text())["ignore"]]


def py_bare_imports(zip_path):
    found = set()
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name.startswith("node_modules/") or not name.endswith((".mjs", ".js", ".cjs")):
                continue
            # The manifest's ignore list (tests, fixtures) is not deployable source,
            # even when a files[] dir entry drags it into the zip (eval-packager's lib/).
            if any(p.search(name) for p in _IGNORE):
                continue
            src = _PY_COMMENT.sub("", z.read(name).decode())
            for spec in _PY_IMPORT.findall(src):
                if spec.startswith("node:"):
                    continue
                parts = spec.split("/")
                found.add("/".join(parts[:2]) if spec.startswith("@") else parts[0])
    builtins = set(json.loads(subprocess.run(
        ["node", "-e", "console.log(JSON.stringify(require('node:module').builtinModules))"],
        capture_output=True, text=True, check=True).stdout))
    return {f for f in found if f not in builtins}


def contract(*args):
    return subprocess.run(["node", str(CONTRACT), *map(str, args)], capture_output=True, text=True, timeout=120)


def derived_deps(zip_path):
    r = contract("deps", zip_path)
    assert r.returncode == 0, r.stderr
    return [l for l in r.stdout.splitlines() if l]


def names(specs):
    return {s.rsplit("@", 1)[0] for s in specs}


SDK_LESS = [r["function"] for r in _ROWS if not any(f.startswith("node_modules") for f in r["files"])]


@needs_node_only
@pytest.mark.parametrize("fn", WITH_INDEX)
def test_scan_covers_every_bare_import_of_every_manifest_zip(tmp_path, fn):
    """The scanner the derivation rides on misses nothing, on every zip in the
    manifest - SDK-less and bundled alike (TEAM-5346: bundled rows used to be
    excluded because build_zip could not skip the gitignored node_modules/)."""
    zip_path = build_zip(tmp_path, fn)
    r = contract("imports", zip_path)
    assert r.returncode == 0, r.stderr
    assert set(r.stdout.split()) >= py_bare_imports(zip_path)


@needs_node_only
@pytest.mark.parametrize("fn", SDK_LESS)
def test_sdkless_surface_imports_are_pinned_by_root_package_json(tmp_path, fn):
    """Every SDK-less row (not only the twins): `deps` succeeds, i.e. root
    package.json pins every bare import - the one place the Deploy stage's smoke
    installs from. pipeline-tools' dynamic import of @aws-sdk/client-cloudformation
    was undeclared there (same defect class as the bundled gaps, TEAM-5346)."""
    zip_path = build_zip(tmp_path, fn)
    r = contract("deps", zip_path)
    assert r.returncode == 0, f"{fn}: {r.stderr}"
    imports = set(contract("imports", zip_path).stdout.split())
    assert names(r.stdout.split()) == imports


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
@pytest.mark.parametrize("fn", TWINS)
def test_twin_deps_are_every_import_pinned_by_root_package_json(tmp_path, fn):
    zip_path = build_zip(tmp_path, fn)
    specs = derived_deps(zip_path)
    assert names(specs) >= py_bare_imports(zip_path)
    pkg = json.loads((REPO / "package.json").read_text())
    pins = {**pkg.get("devDependencies", {}), **pkg["dependencies"]}
    assert all(s == f"{s.rsplit('@', 1)[0]}@{pins[s.rsplit('@', 1)[0]]}" for s in specs)
    assert "@aws-sdk/client-secrets-manager" in names(specs)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_deps_ignore_builtins_comments_and_relative(tmp_path):
    src = (
        '/** @param {import("@aws-sdk/lib-dynamodb").X} x */\n'
        '// import "left-pad";\n'
        'import { readFileSync } from "node:fs";\n'
        'import path from "path";\n'
        'import "./local.mjs";\n'
        'import { S3Client } from "@aws-sdk/client-s3/dist-cjs/index.js";\n'
        'export { x } from "@aws-sdk/client-lambda";\n'
        'const m = await import("@aws-sdk/client-sts");\n'
        'export const handler = async () => ({});\n'
    )
    specs = derived_deps(fixture_zip(tmp_path, "mixed", src))
    assert names(specs) == {"@aws-sdk/client-s3", "@aws-sdk/client-lambda", "@aws-sdk/client-sts"}


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_deps_fail_on_an_undeclared_package(tmp_path):
    r = contract("deps", fixture_zip(tmp_path, "undeclared", 'import "not-a-root-dependency-5337";\n'))
    assert r.returncode == 1
    assert "not-a-root-dependency-5337" in r.stderr


# ── TEAM-5346: the bundle contract ───────────────────────────────────────────

BUNDLE_SRC = 'import "@aws-sdk/client-s3";\nexport const handler = async () => ({});\n'


def bundled_zip(tmp_path, *, declared=("@aws-sdk/client-s3",), dev=(), installed=("@aws-sdk/client-s3",),
                package_json=True, source=BUNDLE_SRC):
    """A zip that ships node_modules/: `installed` packages have a package.json in
    the bundle, `declared` sit in dependencies, `dev` in devDependencies."""
    out = tmp_path / "bundled.zip"
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("index.mjs", source)
        z.writestr("node_modules/.keep", "")
        for pkg in installed:
            z.writestr(f"node_modules/{pkg}/package.json", json.dumps({"name": pkg, "version": "0.0.0"}))
        if package_json:
            z.writestr("package.json", json.dumps({
                "name": "fixture",
                "dependencies": {p: "0.0.0" for p in declared},
                "devDependencies": {p: "0.0.0" for p in dev},
            }))
    return out


@needs_node_only
def test_bundled_zip_whole_passes_deps_with_nothing_to_install(tmp_path):
    out = bundled_zip(tmp_path)
    assert derived_deps(out) == []
    r = contract("imports", out)
    assert r.returncode == 0 and r.stdout.split() == ["@aws-sdk/client-s3"], "imports lists bundled zips too"


@needs_node_only
def test_bundled_zip_missing_the_package_from_node_modules_fails(tmp_path):
    """The P1: declared but not installed (stale lockfile / failed install)."""
    r = contract("deps", bundled_zip(tmp_path, installed=()))
    assert r.returncode == 1
    assert "not in the bundled node_modules: @aws-sdk/client-s3" in r.stderr


@needs_node_only
def test_bundled_zip_with_an_undeclared_import_fails(tmp_path):
    """Installed (transitively, by accident) but not in dependencies: the next
    `npm ci --omit=dev` is free to drop it."""
    r = contract("deps", bundled_zip(tmp_path, declared=()))
    assert r.returncode == 1
    assert "not declared in the zip's package.json dependencies: @aws-sdk/client-s3" in r.stderr


@needs_node_only
def test_bundled_zip_devdependency_does_not_count(tmp_path):
    r = contract("deps", bundled_zip(tmp_path, declared=(), dev=("@aws-sdk/client-s3",)))
    assert r.returncode == 1
    assert "not declared" in r.stderr and "@aws-sdk/client-s3" in r.stderr


@needs_node_only
def test_bundled_zip_without_package_json_fails(tmp_path):
    r = contract("deps", bundled_zip(tmp_path, package_json=False))
    assert r.returncode == 1
    assert "ships no package.json" in r.stderr
    assert "@aws-sdk/client-s3" in r.stderr


@needs_node_only
def test_bundled_zip_ignores_imports_of_test_files(tmp_path):
    """eval-packager ships lib/*.test.mjs via files: ["lib/"]; a test's `vitest`
    is not a dependency (the manifest's ignore list says what is not source)."""
    out = tmp_path / "bundled.zip"
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("index.mjs", BUNDLE_SRC)
        z.writestr("lib/thing.test.mjs", 'import { test } from "vitest";\n')
        z.writestr("node_modules/@aws-sdk/client-s3/package.json", "{}")
        z.writestr("package.json", json.dumps({"dependencies": {"@aws-sdk/client-s3": "0.0.0"}}))
    assert derived_deps(out) == []


@needs_node_only
@pytest.mark.parametrize("fn", BUNDLED)
def test_bundled_surface_imports_are_declared(tmp_path, fn):
    """Static pin for every npm:true row: the bare imports of the files the
    Deploy stage zips are a subset of that dir's package.json dependencies.
    workflow-output imported 6 and declared 2; workflow-analyzer's dynamic
    import of client-s3 was undeclared."""
    row = surface(fn)
    r = contract("imports", build_zip(tmp_path, fn))
    assert r.returncode == 0, r.stderr
    imports = set(r.stdout.split())
    declared = set(json.loads((REPO / row["dir"] / "package.json").read_text()).get("dependencies", {}))
    assert imports, f"{fn} imports nothing bare?"
    assert imports <= declared, f"{fn} imports {sorted(imports - declared)} but does not declare them"


@needs_node_only
@pytest.mark.parametrize("fn", BUNDLED)
def test_bundled_surface_ships_its_package_json(fn):
    """verifyBundledImports reads the declarations from inside the zip."""
    assert "package.json" in surface(fn)["files"], f"{fn} must list package.json in files[]"


def clean_install(tmp_path, fn):
    """`npm ci --omit=dev` of the surface's own manifest+lockfile in a temp copy -
    exactly what buildspec-deploy.yml Target 1b does before zipping."""
    row = surface(fn)
    work = tmp_path / "install"
    work.mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copy(REPO / row["dir"] / name, work / name)
    subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"],
                   cwd=work, check=True, capture_output=True, timeout=900)
    return work / "node_modules"


@real_install
@pytest.mark.parametrize("fn", BUNDLED)
def test_bundled_surface_passes_smoke_after_a_real_clean_install(tmp_path, fn):
    """The ticket's repro, for every bundled surface: clean install, zip from
    files[], `deps` (the bundle is whole and declared), then load it the way
    Lambda will. Before TEAM-5346 workflow-output died here with
    ERR_MODULE_NOT_FOUND @aws-sdk/client-lambda."""
    zip_path = build_zip(tmp_path, fn, node_modules=clean_install(tmp_path, fn))
    assert derived_deps(zip_path) == []
    r = smoke(zip_path, "index.mjs")
    assert r.returncode == 0, r.stderr
    assert "import-smoke OK index.mjs" in r.stdout


def clean_sdk_dir(tmp_path, packages):
    """A node_modules holding ONLY `packages` (symlinks into the repo's install).
    Node resolves a symlinked package by its realpath, so its own transitive deps
    still load — but the zip itself can reach nothing else."""
    root = tmp_path / "clean" / "node_modules"
    for name in packages:
        dest = root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.symlink_to(REPO / "node_modules" / name, target_is_directory=True)
    return root


@needs_node
@pytest.mark.parametrize("fn", TWINS)
def test_twin_smoke_passes_with_only_the_derived_deps(tmp_path, fn):
    zip_path = build_zip(tmp_path, fn)
    sdk = clean_sdk_dir(tmp_path, names(derived_deps(zip_path)))
    r = smoke(zip_path, "index.mjs", "--canary", "get_transitions", "--sdk-dir", sdk)
    assert r.returncode == 0, r.stderr


@needs_node
@pytest.mark.parametrize("fn", TWINS)
def test_twin_smoke_fails_with_the_old_hardcoded_list(tmp_path, fn):
    """The P1: a clean install of the pre-TEAM-5337 list aborts CD."""
    zip_path = build_zip(tmp_path, fn)
    sdk = clean_sdk_dir(tmp_path, OLD_HARDCODED_DEPS)
    r = smoke(zip_path, "index.mjs", "--canary", "get_transitions", "--sdk-dir", sdk)
    assert r.returncode != 0
    assert "@aws-sdk/client-secrets-manager" in r.stderr


@real_install
@pytest.mark.parametrize("fn", TWINS)
def test_twin_smoke_passes_after_a_real_clean_install(tmp_path, fn):
    """Exactly the buildspec's Target 1b: npm install the derived list into an
    empty dir, then smoke against it."""
    zip_path = build_zip(tmp_path, fn)
    deps_dir = tmp_path / "smokedeps"
    deps_dir.mkdir()
    subprocess.run(["npm", "init", "-y"], cwd=deps_dir, check=True, capture_output=True)
    subprocess.run(["npm", "install", "--no-audit", "--no-fund", "--silent", *derived_deps(zip_path)],
                   cwd=deps_dir, check=True, capture_output=True, timeout=600)
    r = smoke(zip_path, "index.mjs", "--canary", "get_transitions", "--sdk-dir", deps_dir / "node_modules")
    assert r.returncode == 0, r.stderr


def test_buildspec_derives_the_smoke_deps_from_the_zip():
    lines = BUILDSPEC.read_text().splitlines()
    zip_line = next(i for i, l in enumerate(lines) if "zip -rq /tmp/surface.zip $FILES" in l)
    update = next(i for i in range(zip_line, len(lines)) if "--zip-file fileb:///tmp/surface.zip" in lines[i])
    block = lines[zip_line:update]
    derives = [i for i, l in enumerate(block) if "lambda-smoke-contract.mjs deps /tmp/surface.zip" in l]
    # TEAM-5346: two derivations - the unconditional import check for EVERY row
    # before `case "$FN"` (bundle whole + declared, or root-pinned for SDK-less
    # zips), and the twins' install list inside it. Both abort on the same line.
    assert len(derives) == 2, block
    bundle_check, derive = derives
    case = next(i for i, l in enumerate(block) if 'case "$FN" in' in l)
    assert 0 < bundle_check < case < derive
    assert "if " not in block[bundle_check].split("node ")[0], "the import check must run for every row, not only NPM=1"
    assert "|| exit 1" in block[bundle_check]
    install = next(i for i, l in enumerate(block) if "npm install" in l and "$SMOKE_PKGS" in l)
    twin_smoke = next(i for i, l in enumerate(block) if "--canary get_transitions" in l)
    assert derive < install < twin_smoke
    assert "|| exit 1" in block[derive]
    # No hardcoded package list anywhere in Target 1b (Target 2b's harness list
    # is for deploy scripts, not zips, and is out of scope here).
    start = next(i for i, l in enumerate(lines) if "Target 1b surface Lambdas" in l)
    end = next(i for i, l in enumerate(lines) if "Target 2/3 config + blueprints" in l)
    assert not any('["@aws-sdk/' in l for l in lines[start:end])


# ── TEAM-5337: one positive-shape canary rule ───────────────────────────────

def judge(tmp_path, kind, body, *flags):
    f = tmp_path / "body.json"
    f.write_text(json.dumps(body))
    return contract("judge", kind, *flags, f)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
@pytest.mark.parametrize("body,offline,ok", [
    ({"key": "T-1", "currentStatus": "todo", "transitions": []}, False, True),
    ({"content": [{"text": "Issue CANARY-SMOKE not found."}]}, False, True),
    ({"error": "Jira API 404: Issue does not exist or you do not have permission to see it."}, False, True),
    # The real offline envelopes (captured 2026-10-06), accepted offline only.
    ({"content": [{"text": "Error: connect ECONNREFUSED 127.0.0.1:1"}]}, True, True),
    ({"error": "fetch failed"}, True, True),
    ({"content": [{"text": "Error: connect ECONNREFUSED 127.0.0.1:1"}]}, False, False),
    ({"error": "fetch failed"}, False, False),
    # The P2 case and its relatives.
    (TYPEERROR_ENVELOPE, True, False),
    (TYPEERROR_ENVELOPE, False, False),
    ({"content": [{"text": "Error: Issue CANARY-SMOKE not found."}]}, False, False),
    ({"error": "Jira API 401: Unauthorized"}, False, False),
    ({"error": "Unknown tool: Tickets___get_transitions"}, False, False),
    ({"content": [{"text": "Issue CANARY-SMOKE not found."}, {"text": "TypeError: x"}]}, False, False),
    ({}, True, False),
    ([], True, False),
])
def test_get_transitions_shapes(tmp_path, body, offline, ok):
    r = judge(tmp_path, "get_transitions", body, *(["--offline"] if offline else []))
    assert (r.returncode == 0) is ok, r.stdout + r.stderr


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_unknown_tool_kind_requires_the_unknown_tool_envelope(tmp_path):
    ok = {"content": [{"type": "text", "text": 'Unknown tool: "undefined". Available: report_completion'}]}
    assert judge(tmp_path, "unknown_tool", ok).returncode == 0
    assert judge(tmp_path, "unknown_tool", TYPEERROR_ENVELOPE).returncode != 0
    assert judge(tmp_path, "unknown_tool", {"content": [{"text": "{}"}]}).returncode != 0


@needs_node
def test_import_smoke_fails_on_the_typeerror_envelope(tmp_path):
    src = f"export const handler = async () => ({json.dumps(TYPEERROR_ENVELOPE)});\n"
    r = smoke(fixture_zip(tmp_path, "typeerr", src), "index.mjs", "--canary", "get_transitions")
    assert r.returncode != 0
    assert "unexpected get_transitions envelope" in r.stderr


@needs_node
def test_import_smoke_fails_on_unexpected_text(tmp_path):
    src = 'export const handler = async () => ({ content: [{ text: "Error: something else broke" }] });\n'
    r = smoke(fixture_zip(tmp_path, "othertext", src), "index.mjs", "--canary", "get_transitions")
    assert r.returncode != 0


def test_live_smoke_fails_on_the_typeerror_envelope(tmp_path):
    r = live(tmp_path, "agentcore-hub-jira", "us-east-1", CANARY, body=json.dumps(TYPEERROR_ENVELOPE))
    assert r.returncode != 0
    assert "unexpected get_transitions envelope" in r.stderr


def test_live_smoke_fails_on_a_transport_error(tmp_path):
    """Offline-only shapes never pass live: a live twin that cannot reach its
    backend fails the deploy."""
    r = live(tmp_path, "agentcore-hub-jira", "us-east-1", CANARY, body='{"error":"fetch failed"}')
    assert r.returncode != 0


def test_live_smoke_jira_not_found_passes_and_sends_the_contract_payload(tmp_path):
    r = live(tmp_path, "agentcore-hub-jira", "us-east-1", CANARY,
             body='{"error":"Jira API 404: Issue does not exist or you do not have permission to see it."}')
    assert r.returncode == 0, r.stderr
    import base64
    sent = json.loads(base64.b64decode((tmp_path / "payload.b64").read_text()))
    assert sent == {"tool_name": "Tickets___get_transitions",
                    "parameters": {"issue_key": "CANARY-SMOKE", "ticket_id": "CANARY-SMOKE"}}


def test_live_smoke_workflow_output_unknown_tool_passes(tmp_path):
    r = live(tmp_path, "agentcore-hub-workflow-output", "us-east-1", "unknown_tool",
             body='{"content":[{"type":"text","text":"Unknown tool: \\"undefined\\". Available: x"}]}')
    assert r.returncode == 0, r.stderr


def test_live_smoke_rejects_an_unknown_kind(tmp_path):
    r = live(tmp_path, "agentcore-hub-tickets", "us-east-1", '{"tool_name":"x"}')
    assert r.returncode != 0
