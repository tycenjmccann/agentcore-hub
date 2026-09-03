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
"never rewrite env" rule above — so we never do it.
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
    port = pc.get("containerPort", 8080)
    environment = pc.get("environment", []) or []

    primary = {"image": image, "containerPort": port, "environment": environment}
    sys.stdout.write(json.dumps(primary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
