#!/usr/bin/env python3
"""Throwaway fixture battery for the TEAM-4579 prototype. Builds every fixture case
the design doc's section 7 specifies into a temp dir and runs the prototype on it,
printing exit code + FAIL lines so the doc's expectations can be copied verbatim.
Non-normative."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROTO = HERE / "reference-check-pipeline-contract.py"

BASE_STACK = '''// fixture stack excerpt (.txt so deploy/pipeline/tsconfig.json never compiles it)
const commonEnvVars: Record<string, codebuild.BuildEnvironmentVariable> = {
  AWS_REGION_HUB: { value: region },
  ARTIFACT_BUCKET: { value: artifactBucketName },
};
const buildProject = new codebuild.PipelineProject(this, "BuildProject", {
  projectName: "fixture-build",
  buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
  environmentVariables: {
    ...commonEnvVars,
    // a project-level arg; the URL below has // inside a template literal
    ECR_REPO: { value: `${repoBase}/fixture-repo` },
  },
});
const deployProject = new codebuild.PipelineProject(this, "DeployProject", {
  projectName: "fixture-deploy",
  buildSpec: codebuild.BuildSpec.fromSourceFilename("deploy.yml"),
  environmentVariables: commonEnvVars,
});
new cpactions.CodeBuildAction({
  actionName: "Build_and_gate",
  project: buildProject,
  variablesNamespace: "BuildVars",
});
new cpactions.CodeBuildAction({
  actionName: "Deploy_it",
  project: deployProject,
  environmentVariables: {
    DEPLOY_PREAPPROVED: { value: "#{BuildVars.DEPLOY_PREAPPROVED}" },
  },
});
'''

def entry(source, absence=None):
    e = {"source": source, "since": "fixture", "comment": "fixture"}
    if absence:
        e["absence"] = absence
    return e

BASE_CONTRACT = {
    "$comment": "fixture",
    "stack": "stack.txt",
    "namespaces": {
        "BuildVars": {"exporter": "buildspec.yml", "action": "Build_and_gate"},
        "codepipeline": {"builtin": True},
    },
    "buildspecs": {
        "buildspec.yml": {
            "providedBy": ["fixture-build", "Build_and_gate"],
            "provides": {
                "AWS_REGION_HUB": entry("common"),
                "ARTIFACT_BUCKET": entry("common"),
                "ECR_REPO": entry("project"),
            },
        },
        "deploy.yml": {
            "providedBy": ["fixture-deploy", "Deploy_it"],
            "provides": {
                "AWS_REGION_HUB": entry("common"),
                "ARTIFACT_BUCKET": entry("common"),
            },
        },
    },
    "allow": {"PLAYWRIGHT_BROWSERS_PATH": "baked into the CI image"},
}
DEPLOY_YML = '''version: 0.2
env:
  shell: bash
phases:
  build:
    commands:
      - "echo deploy $AWS_REGION_HUB ${ARTIFACT_BUCKET}"
'''

BASE_BUILDSPEC = '''version: 0.2
env:
  shell: bash
  exported-variables:
    - DEPLOY_PREAPPROVED
phases:
  build:
    commands:
      - "echo region $AWS_REGION_HUB bucket ${ARTIFACT_BUCKET} repo ${ECR_REPO:-}"
      - |
        DEPLOY_PREAPPROVED=0
        export DEPLOY_PREAPPROVED
'''

def bs_entry(provided_by=("fixture-build", "Build_and_gate"), provides=None):
    c = json.loads(json.dumps(BASE_CONTRACT))
    c["buildspecs"]["buildspec.yml"] = {"providedBy": list(provided_by), "provides": provides if provides is not None else BASE_CONTRACT["buildspecs"]["buildspec.yml"]["provides"]}
    return c

def deploy_entry(provided_by=("fixture-deploy", "Deploy_it"), provides=None):
    c = json.loads(json.dumps(BASE_CONTRACT))
    c["buildspecs"]["deploy.yml"] = {"providedBy": list(provided_by), "provides": provides if provides is not None else BASE_CONTRACT["buildspecs"]["deploy.yml"]["provides"]}
    return c

def contract_with(**changes):
    c = json.loads(json.dumps(BASE_CONTRACT))
    for k, v in changes.items():
        c[k] = v
    return c

def bs_with(extra_cmds):
    return BASE_BUILDSPEC + "".join("      %s\n" % l for l in extra_cmds)

CASES = []

def case(name, stack=BASE_STACK, contract=None, buildspec=BASE_BUILDSPEC, args=(), expect=None, want=None, setup=None, deploy=None):
    CASES.append(dict(name=name, stack=stack, contract=contract if contract is not None else BASE_CONTRACT,
                      buildspec=buildspec, args=list(args), expect=expect, want=want, setup=setup, deploy=deploy))

# ── the cases ────────────────────────────────────────────────────────────────
case("head-pass", expect=0, want="OK: pipeline contract - ")  # handled specially (real repo)
case("fixture-pass", expect=0, want="OK: pipeline contract - 2 buildspecs, 5 provided vars, 1 namespace refs checked")
case("regression-576", deploy=DEPLOY_YML + '      - "bash gate.sh \\"${DEPLOY_PREAPPROVED:-}\\""\n',
     expect=1, want="FAIL: deploy.yml:8 reads DEPLOY_PREAPPROVED which pipeline-contract.json does not declare for [fixture-deploy/Deploy_it] - declared in pipeline-stack.ts but not in pipeline-contract.json: deploy the stack (./deploy/pipeline/deploy.sh) then add it to the contract, or make the read tolerate absence (${DEPLOY_PREAPPROVED:-})")
case("regression-576-fixed-by-advancing-contract", deploy=DEPLOY_YML + '      - "bash gate.sh \\"${DEPLOY_PREAPPROVED:-}\\""\n',
     contract=deploy_entry(provides={"AWS_REGION_HUB": entry("common"), "ARTIFACT_BUCKET": entry("common"), "DEPLOY_PREAPPROVED": entry("action", "tolerated")}),
     expect=0, want="OK: pipeline contract - 2 buildspecs, 6 provided vars, 1 namespace refs checked")
case("contract-not-in-stack",
     contract=bs_entry(provides=dict(BASE_CONTRACT["buildspecs"]["buildspec.yml"]["provides"], INVENTED_ARG=entry("project"))),
     expect=1, want="FAIL: pipeline-contract.json declares INVENTED_ARG for buildspec.yml but stack.txt provides it to none of [fixture-build, Build_and_gate] - fix: remove it from the contract or add it to the stack (which is a HANDOFF)")
case("namespace-not-exported",
     buildspec=BASE_BUILDSPEC.replace("    - DEPLOY_PREAPPROVED\n", "    - SOMETHING_ELSE\n"),
     expect=1, want="FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but buildspec.yml env.exported-variables does not export DEPLOY_PREAPPROVED - fix: add DEPLOY_PREAPPROVED to exported-variables or remove the reference")
case("namespace-not-declared", contract=contract_with(namespaces={"codepipeline": {"builtin": True}}),
     expect=1, want="FAIL: stack.txt:29 references #{BuildVars.DEPLOY_PREAPPROVED} but BuildVars is not in pipeline-contract.json namespaces - fix: add the namespace (exporter + action, or builtin: true) or remove the reference")
case("exporter-action-mismatch",
     contract=contract_with(namespaces={"BuildVars": {"exporter": "buildspec.yml", "action": "Deploy_it"}}),
     expect=1, want="FAIL: stack.txt declares variablesNamespace \"BuildVars\" on action Build_and_gate but pipeline-contract.json says action Deploy_it - fix: correct namespaces[\"BuildVars\"].action")
case("fail-closed-missing-contract", setup="rm_contract", expect=2, want="contract file missing")
case("fail-closed-unparseable-json", setup="bad_json", expect=2, want="unparseable JSON")
case("fail-closed-buildspec-missing", setup="rm_buildspec", expect=2, want="buildspec file missing")
case("fail-closed-missing-stack", setup="rm_stack", expect=2, want="stack file missing")
case("fail-closed-unknown-top-key", contract=contract_with(extra="x"), expect=2, want="unknown top-level key 'extra'")
case("fail-closed-unknown-entry-key",
     contract=bs_entry(provides={"AWS_REGION_HUB": dict(entry("common"), bogus=1), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project")}),
     expect=2, want="unknown key 'bogus'")
case("fail-closed-bad-absence",
     contract=bs_entry(provides={"AWS_REGION_HUB": entry("common", "maybe"), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project")}),
     expect=2, want='absence must be "required" or "tolerated"')
case("fail-closed-unknown-buildspec-arg", args=["--buildspec", "nope.yml"], expect=1, want="FAIL: nope.yml has no contract entry in pipeline-contract.json buildspecs - fix: add buildspecs[\"nope.yml\"] (providedBy + provides) or remove the file")
case("fail-closed-globbed-not-in-contract", setup="extra_glob", expect=1, want="FAIL: buildspec-extra.yml has no contract entry in pipeline-contract.json buildspecs - fix:")
case("fail-closed-multiline-quoted-scalar", buildspec=bs_with(['- "echo this scalar', '  continues here"']),
     expect=2, want="unsupported multi-line quoted scalar at")
case("fail-closed-unterminated-heredoc", buildspec=bs_with(["- |", "  cat <<'EOF'", "  never closed"]),
     expect=2, want="unterminated heredoc <<EOF")
case("fail-closed-stack-unknown-spread", stack=BASE_STACK.replace("...commonEnvVars,", "...otherVars,"),
     expect=2, want="spread of otherVars in environmentVariables block")
case("fail-closed-stack-two-commons", stack=BASE_STACK + BASE_STACK.split("\n", 1)[1].split("};")[0] + "};\n",
     expect=2, want="expected exactly one `const commonEnvVars = {` block, found 2")
case("fail-closed-stack-nonliteral-projectName", stack=BASE_STACK.replace('projectName: "fixture-build"', "projectName: name"),
     expect=2, want="projectName is not a string literal")
case("fail-closed-stack-env-identifier", stack=BASE_STACK.replace("environmentVariables: {\n    ...commonEnvVars,\n    // a project-level arg; the URL below has // inside a template literal\n    ECR_REPO: { value: `${repoBase}/fixture-repo` },\n  },", "environmentVariables: someOtherVars,"),
     expect=2, want="environmentVariables bound to 'someOtherVars'")
case("tolerant-declared-pass", buildspec=bs_with(['- "echo ${EXTRA_DECLARED:-none}"']),
     contract=bs_entry(provides={"AWS_REGION_HUB": entry("common"), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project"), "EXTRA_DECLARED": entry("project", "tolerated")}),
     stack=BASE_STACK.replace("    ECR_REPO:", '    EXTRA_DECLARED: { value: "1" },\n    ECR_REPO:'),
     expect=0, want="OK: pipeline contract - 2 buildspecs, 6 provided vars")
case("builtin-pass", buildspec=bs_with(['- "echo ${CODEBUILD_RESOLVED_SOURCE_VERSION:-} $CODEBUILD_BUILD_ID"']), expect=0, want="OK:")
case("lowercase-pass", buildspec=bs_with(['- "echo $rc ${attempt} $Account $lower_case"']), expect=0, want="OK:")
case("self-referential-read", buildspec=bs_with(["- |", '  UNDECL_SELF="${UNDECL_SELF:-default}"', '  echo "$UNDECL_SELF"']),
     expect=1, want="FAIL: buildspec.yml:14 reads UNDECL_SELF which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix: if the deployed stack provides it (./deploy/pipeline/deploy.sh has run), add it under buildspecs[\"buildspec.yml\"].provides; otherwise make the read tolerate absence or drop it, or add it to allow with a reason")
case("self-referential-events-table-companion",
     buildspec=bs_with(["- |", '  GIT_SHA=abc', '  GIT_SHA="$GIT_SHA" EVENTS_TABLE="${EVENTS_TABLE:-agentcore-hub-events}" \\', '    python3 deploy.py']),
     expect=1, want="reads EVENTS_TABLE which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix:")
case("self-referential-defined-elsewhere-pass",
     buildspec=bs_with(["- |", '  X_VAR=1', '  X_VAR="$(printf %s "$X_VAR" | cut -c1-12)"']), expect=0, want="OK:")
case("comment-not-definition", buildspec=bs_with(["# UNDECL_C=true is only a comment", "- |", "  # UNDECL_C=1", '  echo "$UNDECL_C"']),
     expect=1, want="reads UNDECL_C which pipeline-contract.json does not declare")
case("quoted-scalar-definition", buildspec=bs_with(['- "QS_VAR=\\"$(aws sts get-caller-identity --query Account --output text)\\""', '- "echo $QS_VAR"']),
     expect=0, want="OK:")
case("heredoc-literal-quoted-pass", buildspec=bs_with(["- |", "  python3 - <<'PY' || true", "  print('$UNDECL_H')", "  PY"]), expect=0, want="OK:")
case("heredoc-unquoted-read-counts", buildspec=bs_with(["- |", "  cat <<EOF", "  $UNDECL_H", "  EOF"]), expect=1, want="reads UNDECL_H which pipeline-contract.json does not declare")
case("heredoc-unquoted-body-not-definition", buildspec=bs_with(["- |", "  cat <<EOF", "  UNDECL_H2=1", "  EOF", '  echo "$UNDECL_H2"']), expect=1, want="reads UNDECL_H2 which pipeline-contract.json does not declare")
case("escaped-dollar", buildspec=bs_with(['- "echo \\\\$UNDECL_E"', "- |", "  printf '\\$UNDECL_E2'"]), expect=0, want="OK:")
case("double-backslash-dollar-reads", buildspec=bs_with(["- |", '  echo "\\\\$UNDECL_E3"']), expect=1, want="reads UNDECL_E3 which pipeline-contract.json does not declare")
case("undeclared-plain-read-temp-copy", setup="temp_copy", expect=1, want="reads FOO_BAR which pipeline-contract.json does not declare for [fixture-build/Build_and_gate] - fix:")
case("stack-extra-not-in-contract-pass", stack=BASE_STACK.replace("    ECR_REPO:", '    NOT_YET_DEPLOYED: { value: "1" },\n    ECR_REPO:'), expect=0, want="OK:")
case("unknown-provider", contract=contract_with(buildspecs={"buildspec.yml": {"providedBy": ["fixture-build", "Build_and_gate", "Deploy_it", "Ghost_action"], "provides": BASE_CONTRACT["buildspecs"]["buildspec.yml"]["provides"]}}),
     expect=1, want="FAIL: buildspec.yml providedBy names Ghost_action, which is neither a projectName nor an actionName in stack.txt - fix: correct the name or remove it from providedBy")
case("source-mismatch", contract=bs_entry(provides={"AWS_REGION_HUB": entry("project"), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project")}),
     expect=1, want="FAIL: pipeline-contract.json says AWS_REGION_HUB source=project for buildspec.yml but stack.txt declares it as common for fixture-build - fix: set source to common")
case("provider-binding", contract=deploy_entry(provided_by=("fixture-deploy",)),
     expect=1, want="FAIL: stack.txt action Deploy_it (project fixture-deploy) runs deploy.yml but is missing from its providedBy - fix: add Deploy_it to buildspecs[\"deploy.yml\"].providedBy")
case("provider-binding-wrong-buildspec", stack=BASE_STACK.replace('fromSourceFilename("buildspec.yml")', 'fromSourceFilename("other.yml")'),
     expect=1, want="FAIL: buildspec.yml providedBy project fixture-build runs other.yml, not this buildspec - fix: move fixture-build to the entry for other.yml or fix the stack's fromSourceFilename")
case("missing-provider", contract=bs_entry(provided_by=("Build_and_gate",)),
     expect=1, want="FAIL: stack.txt project fixture-build runs buildspec.yml but is missing from its providedBy - fix: add fixture-build to buildspecs[\"buildspec.yml\"].providedBy")
case("single-quoted-read-counts", buildspec=bs_with(["- |", "  echo '$UNDECL_SQ'"]), expect=1, want="FAIL: buildspec.yml:14 reads UNDECL_SQ which pipeline-contract.json does not declare")
case("trap-body-read", buildspec=bs_with(["- |", "  trap 'echo $UNDECL_T' EXIT"]), expect=1, want="FAIL: buildspec.yml:14 reads UNDECL_T which pipeline-contract.json does not declare")
case("bare-export-is-read", buildspec=bs_with(["- |", "  export UNDECL_X"]), expect=1, want="FAIL: buildspec.yml:14 reads UNDECL_X which pipeline-contract.json does not declare")
case("bare-export-of-provided-pass", buildspec=bs_with(["- |", "  export AWS_REGION_HUB ARTIFACT_BUCKET ECR_REPO"]), expect=0, want="OK:")
case("declare-without-eq-is-definition", buildspec=bs_with(["- |", "  declare -A DECL_MAP", "  local LOC_V", '  echo "${DECL_MAP[x]:-} $LOC_V"']), expect=0, want="OK:")
case("read-for-select-definitions", buildspec=bs_with(["- |", "  while IFS=$'\\t' read -r K1 K2 <&3; do echo $K1 $K2; done 3< f", "  read -d '' -t 5 K3 <<<x; for K4 in a b; do echo $K3 $K4; done", "  mapfile -t K5 < f; echo ${K5[0]}"]), expect=0, want="OK:")
case("command-prefix-and-build-arg", buildspec=bs_with(["- |", '  PFX_A=1 PFX_B="$AWS_REGION_HUB" node x.js', '  docker build --build-arg UNDECL_BA="${UNDECL_BA:-}" .']), expect=1, want="FAIL: buildspec.yml:15 reads UNDECL_BA which pipeline-contract.json does not declare")
case("strict-absence-bare-read", buildspec=bs_with(['- "echo $ECR_REPO"']),
     contract=bs_entry(provides={"AWS_REGION_HUB": entry("common"), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project", "tolerated")}),
     args=["--strict-absence"], expect=1, want="FAIL: buildspec.yml:13 reads ECR_REPO bare but it is marked absence=tolerated - fix: read it as ${ECR_REPO:-} because the deployed pipeline may not provide it yet")
case("strict-absence-same-fixture-passes-without-flag", buildspec=bs_with(['- "echo $ECR_REPO"']),
     contract=bs_entry(provides={"AWS_REGION_HUB": entry("common"), "ARTIFACT_BUCKET": entry("common"), "ECR_REPO": entry("project", "tolerated")}),
     expect=0, want="OK:")
case("strict-absence-per-provider", deploy=DEPLOY_YML + '      - "echo $DEPLOY_ONLY"\n',
     stack=BASE_STACK.replace("    DEPLOY_PREAPPROVED:", '    DEPLOY_ONLY: { value: "1" },\n    DEPLOY_PREAPPROVED:'),
     contract=deploy_entry(provides={"AWS_REGION_HUB": entry("common"), "ARTIFACT_BUCKET": entry("common"), "DEPLOY_ONLY": entry("action")}),
     args=["--strict-absence"], expect=1, want="FAIL: deploy.yml:8 reads DEPLOY_ONLY bare but it is not provided by fixture-deploy - fix: read it as ${DEPLOY_ONLY:-} because the deployed pipeline may not provide it yet")
case("explain-format", args=["--explain"], expect=0, want="EXPLAIN: buildspec.yml providedBy=[Build_and_gate,fixture-build] provides=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] consumed=[ARTIFACT_BUCKET,AWS_REGION_HUB,ECR_REPO] allow=[] builtin=[] defined=[DEPLOY_PREAPPROVED]")
case("determinism-two-violations-sorted",
     buildspec=bs_with(['- "echo $ZZ_UNDECL $AA_UNDECL"']), expect=1, want="FAIL: buildspec.yml:13 reads AA_UNDECL which pipeline-contract.json does not declare")


def run(cmd, cwd):
    return subprocess.run([sys.executable] + cmd, cwd=cwd, capture_output=True, text=True)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="pc-fixtures-"))
    bad = 0
    for c in CASES:
        d = tmp / c["name"]
        d.mkdir()
        (d / "stack.txt").write_text(c["stack"])
        (d / "contract.json").write_text(json.dumps(c["contract"], indent=2))
        (d / "buildspec.yml").write_text(c["buildspec"])
        (d / "deploy.yml").write_text(c.get("deploy") or DEPLOY_YML)
        cmd = [str(PROTO), "--root", str(d), "--contract", str(d / "contract.json")] + c["args"]
        if c["name"] == "head-pass":
            cmd = [str(PROTO), "--root", str(REPO), "--contract", str(HERE / "pipeline-contract.json")]
        s = c["setup"]
        if s == "rm_contract":
            (d / "contract.json").unlink()
        elif s == "bad_json":
            (d / "contract.json").write_text("{ not json")
        elif s == "rm_buildspec":
            (d / "buildspec.yml").unlink()
        elif s == "rm_stack":
            (d / "stack.txt").unlink()
        elif s == "extra_glob":
            (d / "buildspec-extra.yml").write_text("version: 0.2\n")
        elif s == "temp_copy":
            tc = d / "tmpcopy" / "buildspec.yml"
            tc.parent.mkdir()
            tc.write_text(c["buildspec"] + '      - "echo \\"$FOO_BAR\\""\n')
            cmd += ["--buildspec", str(tc)]
        r = run(cmd, cwd=str(d))
        r2 = run(cmd, cwd=str(d))
        det = (r.stdout, r.stderr, r.returncode) == (r2.stdout, r2.stderr, r2.returncode)
        out = (r.stdout + r.stderr)
        ok = (r.returncode == c["expect"]) and (c["want"] in out) and det
        if not ok:
            bad += 1
        print("%s %-48s exit=%d (want %d) det=%s" % ("PASS" if ok else "XXXX", c["name"], r.returncode, c["expect"], det))
        for line in (r.stdout + r.stderr).rstrip("\n").split("\n"):
            if line:
                print("      " + line)
    print("\n%d cases, %d unexpected" % (len(CASES), bad))
    shutil.rmtree(tmp)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
