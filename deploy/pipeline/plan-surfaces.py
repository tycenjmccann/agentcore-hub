#!/usr/bin/env python3
"""plan-surfaces.py — turn the Build stage's changed-file list into a deploy plan.

Reads deploy/pipeline/surfaces.json (the deploy-surface manifest) and
pipeline-out/changed-files.txt, and prints one tab-separated action per line
for buildspec-deploy.yml to execute, grouped in execution order:

  LAMBDA   <function> <dir> <npm 0|1> <optional 0|1> <files, space-separated> <note>
  S3SYNC   <src dir>  <dst key prefix> <extra aws s3 sync args, space-separated>
  S3CP     <src file> <dst key>
  HARNESS  <harness name> <setup script>
  HANDOFF  <changed file that only a human/infra script can deploy>

Rules:
  - A surface deploys when any changed file starts with one of its `paths`
    (default for a Lambda: its `dir` + "/"). Files matching an `ignore` regex
    (tests, docs, lockfiles) never trigger anything.
  - The Build stage's FORCE-UNKNOWN-RANGE sentinel (no known last-deployed SHA)
    deploys EVERY surface — code pushes are idempotent, so over-deploying is
    safe — and still emits a HANDOFF so the release manager confirms scope.
  - S3 syncs are ordered before harness updates on purpose: the Workflow
    Manager's UpdateHarness points at s3://.../skills/, so the skills must land
    first.

`--check` mode (scripts/check-deploy-surfaces.sh) verifies the manifest covers
every tracked file under lambda/ and deploy/ — a new Lambda or deploy script
that nobody added to surfaces.json fails CI instead of silently drifting.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SENTINEL = "deploy/runtime-agent/FORCE-UNKNOWN-RANGE"
HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "surfaces.json"


def load_manifest(path: Path | str = DEFAULT_MANIFEST) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _ignored(path: str, patterns: list[re.Pattern]) -> bool:
    return any(p.search(path) for p in patterns)


def _hits(changed: list[str], prefixes: list[str]) -> bool:
    return any(f.startswith(p) for f in changed for p in prefixes)


def lambda_paths(entry: dict) -> list[str]:
    return list(entry.get("paths") or [entry["dir"].rstrip("/") + "/"])


def plan(changed_files: list[str], manifest: dict, force_all: bool = False) -> list[list[str]]:
    ignore = [re.compile(p) for p in manifest.get("ignore", [])]
    handoff = manifest.get("handoff", [])
    exempt = manifest.get("handoff_exempt", [])
    raw = [f.strip() for f in changed_files if f.strip()]
    unknown_range = SENTINEL in raw
    everything = force_all or unknown_range

    def is_handoff(f: str) -> bool:
        if any(f.startswith(e) for e in exempt):
            return False
        return any(f.startswith(p) for p in handoff)

    # A handoff file (infra script) never triggers a code deploy even when it
    # sits inside a surface dir — lambda/cost-report/deploy.sh must not redeploy
    # the cost-report code, it must be reported for a human to run.
    changed = [f for f in raw if not _ignored(f, ignore) and not is_handoff(f)]

    actions: list[list[str]] = []

    for lam in manifest.get("lambdas", []):
        if everything or _hits(changed, lambda_paths(lam)):
            actions.append([
                "LAMBDA",
                lam["function"],
                lam["dir"].rstrip("/"),
                "1" if lam.get("npm") else "0",
                "1" if lam.get("optional") else "0",
                " ".join(lam["files"]),
                lam.get("note", ""),
            ])

    for s3 in manifest.get("s3", []):
        if everything or _hits(changed, s3["paths"]):
            if s3["src"].endswith("/"):
                actions.append(["S3SYNC", s3["src"], s3["dst"], " ".join(s3.get("args", []))])
            else:
                actions.append(["S3CP", s3["src"], s3["dst"]])

    for h in manifest.get("harnesses", []):
        if everything or _hits(changed, h["paths"]):
            actions.append(["HARNESS", h["name"], h["script"]])

    for f in raw:
        if f == SENTINEL:
            actions.append(["HANDOFF", f])
        elif not _ignored(f, ignore) and is_handoff(f):
            actions.append(["HANDOFF", f])

    return actions


# ─── --check: manifest coverage of lambda/ and deploy/ ───────────────────────

def _tracked_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "lambda", "deploy"],
            check=True, capture_output=True, text=True,
        ).stdout
        files = [l for l in out.splitlines() if l.strip()]
        if files:
            return files
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    files = []
    for top in ("lambda", "deploy"):
        for dirpath, dirnames, filenames in os.walk(root / top):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__", "cdk.out")]
            for fn in filenames:
                files.append(os.path.relpath(os.path.join(dirpath, fn), root))
    return sorted(files)


def coverage_prefixes(manifest: dict) -> list[str]:
    prefixes: list[str] = []
    for lam in manifest.get("lambdas", []):
        prefixes.append(lam["dir"].rstrip("/") + "/")
        prefixes.extend(lambda_paths(lam))
    for s3 in manifest.get("s3", []):
        prefixes.append(s3["src"])
    for h in manifest.get("harnesses", []):
        prefixes.extend(h["paths"])
    prefixes.extend(manifest.get("handoff", []))
    for k in manifest.get("excluded", {}):
        prefixes.append(k if (k.endswith("/") or "." in Path(k).name) else k + "/")
    return prefixes


def check(root: Path, manifest: dict) -> list[str]:
    ignore = [re.compile(p) for p in manifest.get("ignore", [])]
    prefixes = coverage_prefixes(manifest)
    uncovered = []
    for f in _tracked_files(root):
        if f.endswith("function.zip") or "/node_modules/" in f:
            continue
        if _ignored(f, ignore):
            continue
        if any(f.startswith(p) for p in prefixes):
            continue
        uncovered.append(f)
    return uncovered


def main(argv: list[str]) -> int:
    if "--check" in argv:
        root = HERE.parent.parent
        manifest = load_manifest()
        missing = check(root, manifest)
        if missing:
            print("FAIL: files under lambda/ or deploy/ not covered by deploy/pipeline/surfaces.json:", file=sys.stderr)
            for f in missing:
                print(f"  - {f}", file=sys.stderr)
            print("Add the surface (lambdas / s3 / harnesses), list it under handoff (infra script), "
                  "or add it to excluded with a reason.", file=sys.stderr)
            return 1
        print(f"deploy-surface manifest covers lambda/ and deploy/ "
              f"({len(manifest.get('lambdas', []))} lambdas, {len(manifest.get('harnesses', []))} harnesses, "
              f"{len(manifest.get('s3', []))} s3 surfaces)")
        return 0

    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print("usage: plan-surfaces.py <changed-files.txt> [surfaces.json] [--all] | --check", file=sys.stderr)
        return 2
    changed_path = Path(args[0])
    manifest = load_manifest(args[1] if len(args) > 1 else DEFAULT_MANIFEST)
    changed = changed_path.read_text(encoding="utf-8").splitlines() if changed_path.exists() else []
    actions = plan(changed, manifest, force_all="--all" in argv)
    for a in actions:
        print("\t".join(a))
    kinds: dict[str, int] = {}
    for a in actions:
        kinds[a[0]] = kinds.get(a[0], 0) + 1
    summary = ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())) or "nothing beyond the app targets"
    print(f"plan: {len(changed)} changed file(s) → {summary}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
