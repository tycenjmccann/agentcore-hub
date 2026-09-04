"""Hermetic tests for plan-surfaces.py (no AWS). Run with pytest from repo root."""
import importlib.util
import json
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
    assert d == "lambda/cost-report" and npm == "0" and optional == "0" and files == "index.mjs"
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


def test_model_catalog_change_updates_builder_harness():
    actions = ps.plan(["src/lib/models/harness-models.json"], MANIFEST)
    assert [a[1] for a in kinds(actions, "HARNESS")] == ["agentcore_hub_builder"]
    assert kinds(actions, "HARNESS")[0][2] == "deploy/setup-builder-agent.mjs"


def test_runtime_image_change_is_a_handoff_but_prompts_are_not():
    actions = ps.plan([
        "deploy/runtime-agent/main.py",
        "deploy/runtime-agent/prompts/agentcore_hub_agent.txt",
        "deploy/coding-agent-runtime/main.py",
    ], MANIFEST)
    assert [a[1] for a in kinds(actions, "HANDOFF")] == [
        "deploy/runtime-agent/main.py",
        "deploy/coding-agent-runtime/main.py",
    ]


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
    assert kinds(actions, "HANDOFF") == [["HANDOFF", ps.SENTINEL]]


def test_app_only_change_yields_empty_plan():
    assert ps.plan(["src/app/page.tsx", "blueprints/ci-agent.md"], MANIFEST) == []


def test_manifest_covers_repo():
    root = HERE.parent.parent
    assert ps.check(root, MANIFEST) == []


def test_every_lambda_dir_is_a_surface_or_excluded():
    root = HERE.parent.parent
    listed = {l["dir"] for l in MANIFEST["lambdas"]} | set(MANIFEST["excluded"])
    for d in sorted(p for p in (root / "lambda").iterdir() if p.is_dir()):
        rel = f"lambda/{d.name}"
        assert rel in listed, f"{rel} is neither a lambda surface nor excluded"
