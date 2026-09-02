#!/usr/bin/env python3
"""Parse `aws ecs describe-express-gateway-service` JSON → print "STATUS URL".

Used by buildspec-deploy.yml to poll an ECS Express rollout to health before
declaring the deploy complete (mirrors deploy/ecs-express/deploy.sh's readiness
loop). STATUS is the service statusCode (ACTIVE/INACTIVE/...); URL is the first
ingress endpoint, or empty while none is published yet.

Usage: ecs-health.py '<describe-json>'  ->  "ACTIVE d3xyz.ecs.us-east-1.on.aws"
"""
import json
import sys


def main() -> int:
    try:
        d = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception:
        d = {}
    svc = d.get("service", {})
    status = (svc.get("status") or {}).get("statusCode", "UNKNOWN")
    url = ""
    for cfg in svc.get("activeConfigurations", []) or []:
        for ing in cfg.get("ingressPaths", []) or []:
            ep = ing.get("endpoint")
            if ep:
                url = ep
                break
        if url:
            break
    sys.stdout.write(f"{status} {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
