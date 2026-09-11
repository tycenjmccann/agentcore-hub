# Backend / web pipeline (`hub-<slug>-deploy`)

The pipeline the hub triggers to deploy your AWS surfaces. Source → Build →
ManualApproval (human deploy gate) → Deploy. Runs in **your** account on **your**
deploy role; the hub only ever assumes the read+trigger role.

> Deploy the shared trust role first: [`../hub-cd-trigger-role.cfn.yaml`](../hub-cd-trigger-role.cfn.yaml).

## Steps (in your own account/region)

**0. One-time: a GitHub CodeConnections link.** Console → Developer Tools →
Connections → create a GitHub connection, complete the handshake (status
**Available**). Copy its ARN.

**1. Commit the buildspecs** to your repo at `.hub/`:
- `.hub/buildspec-ci.yml`     (from `buildspec-ci.example.yml`)
- `.hub/buildspec-build.yml`  (from `buildspec-build.example.yml`)
- `.hub/buildspec-deploy.yml` (from `buildspec-deploy.example.yml`)

Fill them from your DEPLOY.md. The deploy buildspec MUST deploy every surface in
DEPLOY.md order, run a cold-start smoke, and roll back on failure.

**2. Pipeline.**
```bash
aws cloudformation deploy \
  --template-file hub-repo-pipeline.cfn.yaml \
  --stack-name hub-<slug>-pipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <your-region> \
  --parameter-overrides \
      Slug=<slug> \
      GitHubOwner=<owner> GitHubRepo=<repo> GitHubBranch=main \
      GitHubConnectionArn=<your connection ARN> \
      ApprovalEmail=<optional>
```

**3. TIGHTEN the deploy role.** `hub-<slug>-deploy-role` ships with broad deploy
permissions wildcarded on resource. Scope them to your real stack/cluster/repo/
bucket ARNs before production. This is the only broad identity in the setup — the
hub never touches it.

**4. Register** the `pipeline` name (`hub-<slug>-deploy`) + `region` (+
`account`/`roleArn`/`externalId` if cross-account) with the hub owner. See
[`../README.md`](../README.md#the-registry-entry).
