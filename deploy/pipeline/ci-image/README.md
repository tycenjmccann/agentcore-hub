# CI build image (TEAM-4448 R11)

The custom CodeBuild image used by the **`agentcore-hub-ci`** project (PR checks) and the
deploy pipeline's **`agentcore-hub-build`** project. It bakes Playwright's Chromium and the
shared libraries it links against into the image, so the `install:` phase of
`../buildspec-ci.yml` no longer runs `apt-get` or downloads a browser.

## Why

`npx playwright install --with-deps chromium` shells out as root to
`apt-get update && apt-get install -y <libs>`. `apt-get update` reads **every** configured
source and exits 100 if **any** of them fails to fetch, so one broken third-party repo fails
the whole INSTALL phase before a browser is even downloaded. On 2026-09-09 `dl.google.com`
served an inconsistent `Packages.gz` ("Hash Sum mismatch") and killed the deploy pipeline's
Build stage twice. TEAM-4311 pruned the third-party sources; R11 removes apt from the CI hot
path entirely. Steady state, the INSTALL phase is a **verified cache hit**: no apt, no CDN.

Projects that keep their managed CodeBuild image: the Deploy-stage project
(`buildspec-deploy.yml` has no `install:` phase, no Playwright and no apt) and the ARM
runtime-image project. See `../lib/pipeline-stack.ts`.

## How it is built

It is a **CDK asset**, not a hand-pushed image. `LinuxBuildImage.fromAsset(...)` in
`../lib/pipeline-stack.ts` points at this directory, so `./deploy/pipeline/deploy.sh` builds
and pushes it to the CDK asset ECR repo (`cdk-hnb659fds-container-assets-<account>-<region>`)
as part of `cdk deploy`.

- **Docker is a prerequisite for `deploy.sh`** from now on. `cdk synth` is *not* affected —
  a `DockerImageAsset` is fingerprinted from directory contents + build args at synth time,
  and only `cdk deploy` runs `docker build`.
- The CDK bootstrap in the target account/region must be v2 (it needs the container-assets
  repo above). `cdk bootstrap` again if `deploy.sh` reports a missing asset repository.
- `PLAYWRIGHT_VERSION` is a required build arg, supplied by the stack from the **repo-root**
  `package-lock.json` (`packages["node_modules/@playwright/test"].version`). A `@playwright/test`
  bump therefore changes the asset hash and the image rebuilds on the next `deploy.sh`.
- `DOCKER_VERSION` / `BUILDX_VERSION` are pinned defaults in the Dockerfile. The engine is
  bundled because CodeBuild starts a daemon only for its own curated images; the buildspec's
  `post_build` bootstraps `dockerd` itself in the `BUILD_APP_IMAGE=true` branch.

## Roll-out order

1. Merge, then run `./deploy/pipeline/deploy.sh` from a host with Docker. This builds and
   pushes the asset and repoints the `ci` and `build` projects at it.
2. Open (or re-run) any PR. Read the **INSTALL** phase of the CI log — see below.
3. Watch the first deploy-pipeline Build stage too: that is the only place `dockerd` gets
   bootstrapped, and `BUILD_APP_IMAGE=true` never runs on PR checks. (2026-09-12: the first
   such Build failed - the static bundle lacks `docker-proxy` and the image had no `iptables`,
   so dockerd exited at config validation. The buildspec now starts it with
   `--userland-proxy=false --iptables=false --ip6tables=false --bridge=none` and builds with
   `--network=host`; the image also ships both binaries so a default daemon works.)

### Reading the INSTALL log

On the baked image, the install phase prints:

```
playwright: baked chromium present (/ms-playwright/chromium-1234) - no apt, no CDN
```

That line is the R11 evidence. Confirm all three of the following in the same phase:

- the `baked chromium present` line appears (the fallback prints
  `playwright: browser NOT baked` instead — that means the project is still on the managed
  image, i.e. `deploy.sh` has not run);
- **no `apt-get` output at all** (no `Get:` / `Reading package lists` / `Hash Sum mismatch`);
- **no `Downloading Chromium`** from the Playwright CDN.

If you instead see a `WARNING playwright: baked chromium revision drifted` line, the
checked-out `@playwright/test` wants a browser revision this image does not carry (someone
bumped the lockfile without redeploying). The build still passes — Playwright downloads the
missing revision from the CDN, apt is never reached — but run
`./deploy/pipeline/deploy.sh` to rebuild this image and get the cache hit back.

## Local smoke check (`--network none`)

The whole claim is "the browser is present without touching the network", so prove it with
the network switched off:

```bash
docker build --platform linux/amd64 \
  --build-arg PLAYWRIGHT_VERSION=1.60.0 \
  -t agentcore-hub-ci-image:smoke deploy/pipeline/ci-image

docker run --rm --network none agentcore-hub-ci-image:smoke bash -lc \
  'ls -d $PLAYWRIGHT_BROWSERS_PATH/chromium-* && npx --yes playwright@1.60.0 install chromium && echo SMOKE_OK'
```

`SMOKE_OK` means the glob found a baked revision **and** Playwright agreed it had nothing to
download — with no network available, any download attempt fails the command instead of
silently succeeding. Use the `PLAYWRIGHT_VERSION` the root `package-lock.json` pins; passing a
different one to `npx` is the drift case and is expected to fail under `--network none`.

Extra assertions worth running once, with the network on:

```bash
docker run --rm agentcore-hub-ci-image:smoke bash -lc \
  'node --version && aws --version && docker buildx version && python3 --version'
```

## Rollback

One line in `../lib/pipeline-stack.ts`: set `buildEnvironment.buildImage` back to
`codebuild.LinuxBuildImage.STANDARD_7_0` and re-run `./deploy/pipeline/deploy.sh`. The
buildspec's install phase detects the missing baked browser and takes the legacy
`--with-deps` path on its own, so no other edit is needed.
