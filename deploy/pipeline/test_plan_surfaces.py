"""Hermetic tests for plan-surfaces.py (no AWS). Run with pytest from repo root."""
import copy
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


def test_pricing_json_no_longer_unconditional_s3cp():
    # TEAM-4995 / DL-033: pricing.json WAS an s3[] surface, so every deploy cp'd
    # the repo copy over the rates the nightly reconcile had refreshed in S3. It
    # is `excluded` now and seeded once, only alongside models.json, by the
    # head-object guard in Target 2 — so a change to it must plan NOTHING.
    actions = ps.plan(["src/config/pricing.json"], MANIFEST)
    assert actions == []
    assert "src/config/pricing.json" not in [s["src"] for s in MANIFEST["s3"]]
    assert "src/config/pricing.json" in MANIFEST["excluded"]


def test_models_json_seeded_only_when_absent():
    # The live registry is the S3 copy (POST /api/models/registry + the reconcile
    # write it), so the deploy must only SEED it. Assert the buildspec guard text
    # rather than the manifest: the whole point is that it is not a surface.
    buildspec = (HERE / "buildspec-deploy.yml").read_text(encoding="utf-8")
    guard = "if ! aws s3api head-object --bucket \"$ARTIFACT_BUCKET\" --key config/models.json"
    assert guard in buildspec, "seed-if-absent guard for config/models.json is missing"
    seed_block = buildspec.split(guard, 1)[1].split("\n        aws s3 cp \"s3://$ARTIFACT_BUCKET/config/agents.json\"", 1)[0]
    # Both files are seeded only INSIDE the absent branch, each behind a -f test
    # (their sources are TEAM-4997's and may not be on the branch yet).
    for key in ("models.json", "pricing.json"):
        assert f"[ -f src/config/{key} ] && aws s3 cp src/config/{key} " in seed_block, key
    # ...and nowhere else: no unconditional cp of either one.
    for key in ("models.json", "pricing.json"):
        assert buildspec.count(f"aws s3 cp src/config/{key}") == 1, key
    assert "src/config/models.json" in MANIFEST["excluded"]


def test_workflows_json_is_an_s3_cp():
    # TEAM-4259: workflows.json used to ship via a hardcoded `aws s3 cp` in
    # buildspec-deploy.yml Target 2, outside the manifest. It is a plain S3CP
    # surface now — the one remaining src/config/*.json that IS a deploy surface
    # (agents.json is merged, models/pricing.json are seed-if-absent).
    actions = ps.plan(["src/config/workflows.json"], MANIFEST)
    assert kinds(actions, "S3CP") == [["S3CP", "src/config/workflows.json", "config/workflows.json"]]


def test_models_registry_py_in_both_runtime_surfaces():
    # The Python twin is baked into BOTH images (deploy/runtime-agent/Dockerfile
    # and deploy/coding-agent-runtime/Dockerfile COPY it), so editing it must roll
    # every runtime — a change reaching only one image is a split-brain registry.
    fleet = ps.plan(["deploy/runtime-agent/models_registry.py"], MANIFEST)
    assert [a[1] for a in kinds(fleet, "RUNTIME")] == ["agentcore_hub_agent"]
    assert not kinds(fleet, "HANDOFF")
    coding = ps.plan(["deploy/coding-agent-runtime/models_registry.py"], MANIFEST)
    assert [a[1] for a in kinds(coding, "RUNTIME")] == [
        "agentcore_hub_coding_runtime",
        "agentcore_hub_coding_runtime_ec2",
    ]
    assert not kinds(coding, "HANDOFF")


def test_models_registry_py_in_the_routine_builder_toolkit_surface():
    # TEAM-5019: the third twin is downloaded by the Routine Builder harness from
    # the toolkit prefix, so it must ride that prefix's sync — a twin that never
    # reaches S3 leaves save_routine.py importing nothing.
    actions = ps.plan(["deploy/routine-builder/toolkit/models_registry.py"], MANIFEST)
    assert [(a[1], a[2]) for a in kinds(actions, "S3SYNC")] == [
        ("deploy/routine-builder/toolkit/", "routine-builder/toolkit/")]
    assert not kinds(actions, "HANDOFF")


def test_model_catalog_change_updates_builder_harness():
    # TEAM-4997: the builder's harness lanes moved off harness-models.json and
    # onto the model registry seed (src/config/models.json) — a lane change
    # there still re-runs setup-builder-agent.mjs, same as before.
    actions = ps.plan(["src/config/models.json"], MANIFEST)
    assert [a[1] for a in kinds(actions, "HARNESS")] == ["agentcore_hub_builder"]
    assert kinds(actions, "HARNESS")[0][2] == "deploy/setup-builder-agent.mjs"


def test_models_registry_change_updates_every_harness():
    # TEAM-5020: all three harness setup scripts resolve models through
    # src/lib/models/models-registry.mjs (reached via harness-model.mjs's
    # `new URL(..., import.meta.url)`, not a plain import), so a change there
    # alone must re-run every harness, not just the builder's.
    actions = ps.plan(["src/lib/models/models-registry.mjs"], MANIFEST)
    assert sorted(a[1] for a in kinds(actions, "HARNESS")) == sorted(
        h["name"] for h in MANIFEST["harnesses"]
    )
    assert not kinds(actions, "HANDOFF")


def test_harness_model_helpers_update_every_harness():
    # Same sibling-sweep fix as above, for the two deploy/pipeline/harness-*.mjs
    # helpers every harness script imports directly.
    for f in ["deploy/pipeline/harness-model.mjs", "deploy/pipeline/harness-snapshot.mjs"]:
        actions = ps.plan([f], MANIFEST)
        assert sorted(a[1] for a in kinds(actions, "HARNESS")) == sorted(
            h["name"] for h in MANIFEST["harnesses"]
        ), f
        assert not kinds(actions, "HANDOFF"), f


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


def test_check_catches_a_local_import_missing_from_files():
    # TEAM-4825: #640 added `import ... from "./gate-contract.mjs"` to both ticket
    # Lambdas and to setup-tickets-lambda.mjs's zip line but not to files[] here,
    # so the pipeline shipped agentcore-hub-jira without it and every Tickets___*
    # call died with ERR_MODULE_NOT_FOUND. Drop the file from files[] → the guard
    # must name it.
    root = HERE.parent.parent
    m = copy.deepcopy(MANIFEST)
    jira = next(l for l in m["lambdas"] if l["function"] == "agentcore-hub-jira")
    jira["files"] = [f for f in jira["files"] if f != "gate-contract.mjs"]
    gaps = ps.check(root, m)
    assert any(g.startswith("lambda/agentcore-hub-jira/gate-contract.mjs") for g in gaps), gaps


def test_check_catches_a_harness_import_missing_from_paths():
    # TEAM-5020: harness-model.mjs imports models-registry.mjs via
    # `new URL(..., import.meta.url)`, not a plain import — the module is
    # reachable no other way, so this also pins that specifier form. Drop it
    # from one harness's paths[] → the guard must name both the module and the
    # harness.
    root = HERE.parent.parent
    m = copy.deepcopy(MANIFEST)
    builder = next(h for h in m["harnesses"] if h["name"] == "agentcore_hub_builder")
    builder["paths"] = [p for p in builder["paths"] if p != "src/lib/models/models-registry.mjs"]
    gaps = ps.check(root, m)
    assert any(
        "src/lib/models/models-registry.mjs" in g and "agentcore_hub_builder" in g for g in gaps
    ), gaps


def test_import_closure_accepts_listed_dir_prefix():
    # eval-packager imports ./lib/*.mjs and lists "lib/" — a directory ships whole.
    root = HERE.parent.parent
    pk = next(l for l in MANIFEST["lambdas"] if l["function"] == "agentcore-hub-eval-packager")
    assert ps.import_closure_gaps(root, pk) == []


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
