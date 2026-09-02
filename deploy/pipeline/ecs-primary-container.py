#!/usr/bin/env python3
"""Build the --primary-container JSON for an ECS Express roll, reusing the LIVE
service's container port + environment and swapping ONLY the image to the
promoted digest. Roll-by-digest: what the human approved is byte-identical to
what deploys, and the runtime env (Jira/GitHub/Telegram creds already on the
service) is preserved untouched — mirrors deploy/ecs-express/deploy.sh's
"never rewrite env" rule.

Usage: ecs-primary-container.py '<describe-json>' '<ecr_uri@digest>'
Prints the primary-container JSON to stdout.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ecs-primary-container.py <describe-json> <image>", file=sys.stderr)
        return 2
    describe_json, image = sys.argv[1], sys.argv[2]

    d = json.loads(describe_json)
    svc = d.get("service", {})

    # Find the live primary container's port + environment across the shapes the
    # describe API returns (activeConfigurations[].primaryContainer, or a
    # top-level primaryContainer).
    port = 8080
    environment = []
    candidates = []
    for cfg in svc.get("activeConfigurations", []) or []:
        if cfg.get("primaryContainer"):
            candidates.append(cfg["primaryContainer"])
    if svc.get("primaryContainer"):
        candidates.append(svc["primaryContainer"])
    if candidates:
        pc = candidates[0]
        port = pc.get("containerPort", port)
        environment = pc.get("environment", []) or []

    primary = {"image": image, "containerPort": port, "environment": environment}
    sys.stdout.write(json.dumps(primary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
