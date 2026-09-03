#!/usr/bin/env python3
"""Build the --primary-container JSON for an ECS Express roll, reusing the LIVE
service's container port + environment and swapping ONLY the image to the
promoted digest. Roll-by-digest: what the human approved is byte-identical to
what deploys, and the runtime env (Jira/GitHub/Telegram creds already on the
service) is preserved untouched — mirrors deploy/ecs-express/deploy.sh's
"never rewrite env" rule.

Usage: ecs-primary-container.py '<describe-json>' '<ecr_uri@digest>'
Prints the primary-container JSON to stdout on success.

Fail-closed: if the describe JSON yields no live primaryContainer (or is
malformed), print NOTHING to stdout and return non-zero. Synthesizing a
default spec would emit an EMPTY environment and wipe the live runtime env
(Jira/GitHub/Telegram creds) on the next roll — the opposite of the
"never rewrite env" rule above — so we never do it. The same refusal applies
to a candidate whose containerPort or environment is missing/null, or whose
environment is an empty list: prod always carries both, so a partial spec can
only be a degraded describe read (TEAM-3846).
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ecs-primary-container.py <describe-json> <image>", file=sys.stderr)
        return 2
    describe_json, image = sys.argv[1], sys.argv[2]

    try:
        d = json.loads(describe_json)
    except (ValueError, TypeError) as exc:
        print(f"could not parse describe JSON: {exc}", file=sys.stderr)
        return 1
    svc = d.get("service", {}) if isinstance(d, dict) else {}

    # Find the live primary container's port + environment across the shapes the
    # describe API returns (activeConfigurations[].primaryContainer, or a
    # top-level primaryContainer).
    candidates = []
    for cfg in svc.get("activeConfigurations", []) or []:
        if cfg.get("primaryContainer"):
            candidates.append(cfg["primaryContainer"])
    if svc.get("primaryContainer"):
        candidates.append(svc["primaryContainer"])
    if not candidates:
        # No live container to roll onto — fail closed rather than synthesize a
        # default spec with an empty environment (which would wipe runtime env).
        print("no live primaryContainer in describe JSON — refusing to synthesize an env-wiping fallback", file=sys.stderr)
        return 1

    pc = candidates[0]
    # A candidate that EXISTS but lacks containerPort or environment is a
    # degraded/partial describe response, not a legitimate spec — the prod
    # service always carries both. Fail closed rather than default the port or
    # emit an env-wiping empty environment (TEAM-3846).
    port = pc.get("containerPort")
    if not isinstance(port, int) or isinstance(port, bool):
        print(f"primaryContainer has missing/invalid containerPort ({port!r}) — degraded describe response, refusing", file=sys.stderr)
        return 1
    environment = pc.get("environment")
    if not isinstance(environment, list):
        print(f"primaryContainer has missing/invalid environment ({type(environment).__name__}) — degraded describe response, refusing", file=sys.stderr)
        return 1
    # Explicit `"environment": []` is treated as suspicious too: prod always
    # carries env vars (JIRA_*, GITHUB_PAT, TELEGRAM_*), so an empty list can
    # only be a partial read — rolling with it would wipe the runtime env.
    if not environment:
        print("primaryContainer has empty environment — prod always carries env vars, refusing to emit an env-wiping spec", file=sys.stderr)
        return 1

    primary = {"image": image, "containerPort": port, "environment": environment}
    sys.stdout.write(json.dumps(primary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
