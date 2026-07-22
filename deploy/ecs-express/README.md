# ECS Express Mode deploy (recommended)

One idempotent script deploys the AgentCore Hub frontend to **Amazon ECS Express
Mode** — AWS's named successor to App Runner, which is closed to new customers
and being sunset (April 30, 2026): [availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).

Express Mode provisions a Fargate service, an Application Load Balancer, auto
scaling, networking, and a public `https://<service>.ecs.<region>.on.aws` URL
from a single API call.

## Usage

```bash
# Prereqs:
#   - AWS CLI v2 >= 2.34 (ships the *-express-gateway-service commands)
#   - Docker running
#   - A default VPC with public subnets in AWS_REGION
#   - .env.local populated (runtime env vars are forwarded into the container)
./deploy/ecs-express/deploy.sh
```

Re-run any time — it rebuilds the image and updates the existing service in place
(found by name in the `default` cluster), then writes the public URL back to
`.env.local` as `DEPLOYMENT_URL`.

## What it creates

| Resource | Purpose |
|----------|---------|
| ECR repo `agentcore-hub-frontend` | Holds the image (scan-on-push) |
| `ecsTaskExecutionRole` | ECS pulls the image + writes logs (`AmazonECSTaskExecutionRolePolicy`) |
| `ecsInfrastructureRoleForExpressServices` | ECS provisions the ALB + scaling (`AmazonECSInfrastructureRoleforExpressGatewayServices`) |
| `agentcore-hub-ecs-task` | The **app's own** runtime perms — DynamoDB, S3, Bedrock, AgentCore, Secrets Manager, CloudWatch (successor to the App Runner instance role) |
| ECS Express service `agentcore-hub` | Fargate + ALB + auto scaling + public URL |

Execution role ≠ task role: the execution role is for ECS to start the container;
the task role is what the running app assumes to call AWS. Do not merge them.

## Tuning (optional env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `EXPRESS_CPU` | `1` | vCPU (whole units) |
| `EXPRESS_MEMORY` | `2` | GB |
| `EXPRESS_CLUSTER` | `default` | Cluster the service lives in |
| `EXPRESS_SUBNETS` | — | Comma-separated subnet IDs (only if no usable default VPC) |
| `EXPRESS_SECURITY_GROUPS` | — | Comma-separated SG IDs (pairs with the above) |
| `EXPECTED_ACCOUNT_ID` | — | Guard: refuse to deploy unless creds resolve to this account |

## Notes

- **Redeploys replace running tasks.** `update-express-gateway-service` rolls out
  a new task set; env var / secret changes take effect only on that new
  deployment (no hot-reload).
- **SSE:** the workflow UI streams over SSE through the managed ALB. Raise the
  ALB `idle_timeout` to `>= 3600` (default 60s) on the Express service's load
  balancer, or long streams get cut. See the root README's SSE section.
- The container is identical to the App Runner path (same `Dockerfile`, same
  `HOSTNAME=0.0.0.0` + `PORT=8080`); only the hosting control plane differs.

## Migrating an existing App Runner deployment

Run both services and cut over with DNS: point a Route 53 weighted record at the
new Express ALB, shift traffic gradually, then delete the App Runner service. AWS
documents the blue/green steps in the [App Runner migration guide](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).
The legacy script stays at `deploy/apprunner/deploy.sh`.
