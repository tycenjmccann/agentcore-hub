"""Hermetic tests for plan-surfaces.py (no AWS). Run with pytest from repo root."""
import copy
import importlib.util
import json
import posixpath
import re
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("plan_surfaces", HERE / "plan-surfaces.py")
ps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps)

MANIFEST = json.loads((HERE / "surfaces.json").read_text(encoding="utf-8"))


def kinds(actions, kind):
    return [a for a in actions if a[0] == kind]


def test_lambda_dir_change_deploys_that_function_only():
    actions = ps.plan(["lambda/cost-report/index.mjs"], MANIFEST)
    lambdas = kinds(actions, "LAMBDA")
    assert [a[1] for a in lambdas] == ["agentcore-hub-cost-report"]
    fn, d, npm, optional, files, note = lambdas[0][1:]
    assert d == "lambda/cost-report" and npm == "0" and optional == "0" and files == "index.mjs kpi.json"
    assert "REPORT_VERSION" in note
    assert not kinds(actions, "HANDOFF")


def test_tests_docs_and_lockfiles_never_trigger():
    actions = ps.plan([
        "lambda/anomaly-watcher/index.test.mjs",
        "lambda/anomaly-watcher/package-lock.json",
        "deploy/telegram-bug-intake/__tests__/deploy-approval.test.mjs",
        "deploy/telegram-bug-intake/README.md",
        "deploy/workflow-manager/toolkit/test_intervene.py",
        "deploy/runtime-agent/tests/test_x.py",
    ], MANIFEST)
    assert actions == []


def test_telegram_index_triggers_but_readme_does_not():
    actions = ps.plan(["deploy/telegram-bug-intake/index.mjs"], MANIFEST)
    assert [a[1] for a in kinds(actions, "LAMBDA")] == ["telegram-bug-intake"]


def test_npm_lambda_carries_node_modules_in_files():
    actions = ps.plan(["lambda/eval-packager/lib/classify.mjs"], MANIFEST)
    lam = kinds(actions, "LAMBDA")[0]
    assert lam[1] == "agentcore-hub-eval-packager" and lam[3] == "1"
    assert "node_modules/" in lam[5].split() and "lib/" in lam[5].split()


def test_optional_lambda_flagged():
    actions = ps.plan(["lambda/agentcore-hub-tickets/index.mjs"], MANIFEST)
    lam = kinds(actions, "LAMBDA")[0]
    assert lam[1] == "agentcore-hub-tickets" and lam[4] == "1"


def test_eval_packager_code_is_no_longer_a_handoff():
    actions = ps.plan(["lambda/eval-packager/index.mjs"], MANIFEST)
    assert kinds(actions, "LAMBDA") and not kinds(actions, "HANDOFF")


def test_wm_skills_change_syncs_s3_before_harness_update():
    actions = ps.plan(["deploy/workflow-manager/skills/watch-triage/SKILL.md"], MANIFEST)
    # SKILL.md is markdown but it is deployable content — the ignore list must
    # only drop README/EVIDENCE/DECISIONS/DEPLOY docs, never skills or prompts.
    assert kinds(actions, "S3SYNC"), "skills/*.md must sync (ignore list swallowed it)"
    assert kinds(actions, "HARNESS")
    order = [a[0] for a in actions]
    assert order.index("S3SYNC") < order.index("HARNESS")
    sync = kinds(actions, "S3SYNC")[0]
    assert sync[1] == "deploy/workflow-manager/skills/" and sync[2] == "workflow-manager/skills/"
    assert "--delete" in sync[3].split()


def test_wm_system_prompt_md_updates_harness():
    actions = ps.plan(["deploy/workflow-manager/system-prompt.md"], MANIFEST)
    assert [a[1] for a in kinds(actions, "HARNESS")] == ["agentcore_hub_workflow_manager"]


def test_pricing_json_is_an_s3_cp():
    actions = ps.plan(["src/config/pricing.json"], MANIFEST)
    assert kinds(actions, "S3CP") == [["S3CP", "src/config/pricing.json", "config/pricing.json"]]


def test_workflows_json_is_an_s3_cp():
    # TEAM-4259: workflows.json used to ship via a hardcoded `aws s3 cp` in
    # buildspec-deploy.yml Target 2, outside the manifest. It is a plain S3CP
    # surface now, exactly like pricing.json above.
    actions = ps.plan(["src/config/workflows.json"], MANIFEST)
    assert kinds(actions, "S3CP") == [["S3CP", "src/config/workflows.json", "config/workflows.json"]]


def test_model_catalog_change_updates_builder_harness():
    actions = ps.plan(["src/lib/models/harness-models.json"], MANIFEST)
    assert [a[1] for a in kinds(actions, "HARNESS")] == ["agentcore_hub_builder"]
    assert kinds(actions, "HARNESS")[0][2] == "deploy/setup-builder-agent.mjs"


def test_baked_runtime_source_emits_runtime_row_not_handoff():
    # PR 2: a change to baked tool code (main.py) rebuilds + image-swaps the
    # runtime via the parallel arm64 action — it is NOT a human handoff anymore.
    CODING = ["coding-agent-runtime", "deploy/coding-agent-runtime"]
    for f, expected in [
        ("deploy/runtime-agent/main.py", [["RUNTIME", "agentcore_hub_agent", "runtime-agent", "deploy/runtime-agent"]]),
        ("deploy/runtime-agent/Dockerfile", [["RUNTIME", "agentcore_hub_agent", "runtime-agent", "deploy/runtime-agent"]]),
        # The coding runtime and its Instances twin share one image: both roll
        # (the buildspec builds once per repo|context and swaps the digest twice).
        ("deploy/coding-agent-runtime/main.py", [["RUNTIME", "agentcore_hub_coding_runtime", *CODING],
                                                 ["RUNTIME", "agentcore_hub_coding_runtime_ec2", *CODING]]),
        ("deploy/coding-agent-runtime/run-codex.sh", [["RUNTIME", "agentcore_hub_coding_runtime", *CODING],
                                                      ["RUNTIME", "agentcore_hub_coding_runtime_ec2", *CODING]]),
    ]:
        actions = ps.plan([f], MANIFEST)
        assert kinds(actions, "RUNTIME") == expected, f
        assert not kinds(actions, "HANDOFF"), f


def test_prompt_only_change_is_neither_runtime_nor_handoff():
    # Prompts ship via Target 2's unconditional S3 sync + load at cold start,
    # so a prompt-only change must NOT trigger a costly image rebuild.
    actions = ps.plan(["deploy/runtime-agent/prompts/agentcore_hub_agent.txt"], MANIFEST)
    assert not kinds(actions, "RUNTIME") and not kinds(actions, "HANDOFF")


def test_runtime_deploy_and_build_scripts_stay_handoffs():
    # The create/build/setup scripts still need a human (iam:*, privileged build).
    for f in [
        "deploy/runtime-agent/deploy-one-robust.py",
        "deploy/runtime-agent/build-and-push.sh",
        "deploy/coding-agent-runtime/deploy.py",
        "deploy/coding-agent-runtime/setup-coding-runtime-role.sh",
        "deploy/coding-agent-runtime/cfn-vpc-efs.yaml",
    ]:
        actions = ps.plan([f], MANIFEST)
        assert [a[1] for a in kinds(actions, "HANDOFF")] == [f], f
        assert not kinds(actions, "RUNTIME"), f


def test_infra_scripts_are_handoffs_not_code_deploys():
    actions = ps.plan(["lambda/cost-report/deploy.sh", "deploy/setup-pipeline-tools-lambda.mjs"], MANIFEST)
    assert not kinds(actions, "LAMBDA")
    assert [a[1] for a in kinds(actions, "HANDOFF")] == [
        "lambda/cost-report/deploy.sh",
        "deploy/setup-pipeline-tools-lambda.mjs",
    ]


def test_unknown_range_sentinel_deploys_everything_and_hands_off():
    actions = ps.plan([ps.SENTINEL], MANIFEST)
    assert len(kinds(actions, "LAMBDA")) == len(MANIFEST["lambdas"])
    assert len(kinds(actions, "HARNESS")) == len(MANIFEST["harnesses"])
    assert len(kinds(actions, "S3SYNC")) + len(kinds(actions, "S3CP")) == len(MANIFEST["s3"])
    assert len(kinds(actions, "RUNTIME")) == len(MANIFEST["runtimes"])
    assert kinds(actions, "HANDOFF") == [["HANDOFF", ps.SENTINEL]]


def test_app_only_change_yields_empty_plan():
    assert ps.plan(["src/app/page.tsx", "blueprints/ci-agent.md"], MANIFEST) == []


def test_manifest_covers_repo():
    root = HERE.parent.parent
    assert ps.check(root, MANIFEST) == []


def test_check_would_catch_an_unmanifested_src_config_json():
    # The TEAM-4259 drift itself: workflows.json deployed via a hardcoded cp in
    # buildspec-deploy.yml with no manifest entry, and --check walked only lambda/
    # + deploy/ so it could not see it. Drop the entry → the guard must report it.
    root = HERE.parent.parent
    m = copy.deepcopy(MANIFEST)
    m["s3"] = [s for s in m["s3"] if s["src"] != "src/config/workflows.json"]
    assert "src/config/workflows.json" in ps.check(root, m)


def test_check_covers_json_under_src_config_but_not_ts():
    # .ts in src/config is app source (compiled into the image by Target 3), not a
    # deploy surface — widening the guard must not demand a manifest entry for it.
    tracked = ps._tracked_files(HERE.parent.parent)
    assert "src/config/workflows.json" in tracked and "src/config/agents.json" in tracked
    assert [f for f in tracked if f.startswith("src/config/") and not f.endswith(".json")] == []


def test_every_lambda_dir_is_a_surface_or_excluded():
    root = HERE.parent.parent
    listed = {l["dir"] for l in MANIFEST["lambdas"]} | set(MANIFEST["excluded"])
    for d in sorted(p for p in (root / "lambda").iterdir() if p.is_dir()):
        rel = f"lambda/{d.name}"
        assert rel in listed, f"{rel} is neither a lambda surface nor excluded"


# ─── The zip must carry each entrypoint's whole local-import closure ──────────

_LOCAL_IMPORT = re.compile(r"""(?:from|import)\s+["'](\./[\w./-]+\.mjs)["']""")


def _import_closure(lambda_dir: Path, entries: list[str]) -> set[str]:
    """Every ./x.mjs reachable from `entries`, as paths relative to lambda_dir."""
    seen: set[str] = set()
    queue = list(entries)
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        src = lambda_dir / name
        if not src.exists():
            continue
        for imp in _LOCAL_IMPORT.findall(src.read_text(encoding="utf-8")):
            queue.append(posixpath.normpath(posixpath.join(posixpath.dirname(name), imp)))
    return seen


def _unpacked(entry: dict, root: Path) -> list[str]:
    """Modules the entry imports that its `files` list would not put in the zip."""
    files = entry["files"]
    closure = _import_closure(root / entry["dir"].rstrip("/"), [f for f in files if f.endswith(".mjs")])
    return sorted(m for m in closure
                  if m not in files and not any(f.endswith("/") and m.startswith(f) for f in files))


def test_every_lambda_ships_its_whole_local_import_closure():
    # PR #640 added gate-contract.mjs to both ticket twins as a local import of
    # index.mjs and to deploy/setup-tickets-lambda.mjs's zip line — but not to
    # `files` here. Deploy runs `zip -rq /tmp/surface.zip $FILES`, so CD shipped
    # index.mjs without it and every Tickets___* call died at cold start with
    # ERR_MODULE_NOT_FOUND. check-lambda-zip-manifest.sh walks the same closure
    # against the hand-run deploy script's zip line; nothing checked this manifest.
    root = HERE.parent.parent
    for lam in MANIFEST["lambdas"]:
        assert _unpacked(lam, root) == [], f"{lam['function']}: imported but absent from files[]"


def test_closure_guard_would_catch_a_dropped_module():
    # The #640 drift itself: drop the entry → the guard must name it.
    root = HERE.parent.parent
    lam = copy.deepcopy(next(l for l in MANIFEST["lambdas"] if l["function"] == "agentcore-hub-tickets"))
    lam["files"] = [f for f in lam["files"] if f != "gate-contract.mjs"]
    assert _unpacked(lam, root) == ["gate-contract.mjs"]
