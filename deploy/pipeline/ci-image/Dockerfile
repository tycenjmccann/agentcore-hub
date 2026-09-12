# ─── AgentCore Hub CI build image (TEAM-4448 R11) ─────────────────────────────
#
# WHY THIS EXISTS. The INSTALL phase of buildspec-ci.yml used to run
# `npx playwright install --with-deps chromium`, which shells out as root to
# `apt-get update && apt-get install -y <libs>`. `apt-get update` reads EVERY
# configured source and exits 100 if ANY of them fails to fetch, so a single
# broken third-party repo fails INSTALL before a browser is even downloaded --
# which is exactly how a dl.google.com "Hash Sum mismatch" on 2026-09-09 killed
# two deploy builds (TEAM-4311). TEAM-4311 pruned the offending sources; R11
# removes apt from the CI hot path altogether by baking Chromium and its shared
# libraries into the image, so the steady-state INSTALL phase is a verified cache
# hit: no apt, no CDN.
#
# WHO USES IT. The `ci` project (PR checks) and the deploy pipeline's `build`
# project. The Deploy-stage project and the ARM runtime-image project keep their
# managed CodeBuild images -- see deploy/pipeline/lib/pipeline-stack.ts.
#
# HOW IT IS BUILT. As a CDK asset (`LinuxBuildImage.fromAsset`) by
# ./deploy/pipeline/deploy.sh, so Docker is a prerequisite for running that
# script. PLAYWRIGHT_VERSION is passed in by the stack, read from the REPO ROOT
# package-lock.json (@playwright/test), so a lockfile bump changes the asset hash
# and rebuilds the image on the next deploy. See README.md in this directory.
#
# Base: the official Node 20 image on Debian bookworm. Not a
# public.ecr.aws/codebuild/* image -- AWS publishes only the Amazon Linux curated
# images there, so `ubuntu-standard:7.0` is not pullable as a base.

ARG PLAYWRIGHT_VERSION
FROM public.ecr.aws/docker/library/node:20-bookworm

# FROM resets build args; re-declare the ones the layers below need.
ARG PLAYWRIGHT_VERSION
ARG DOCKER_VERSION=27.5.1
ARG BUILDX_VERSION=0.20.1
RUN : "${PLAYWRIGHT_VERSION:?PLAYWRIGHT_VERSION build-arg is required}"

ENV DEBIAN_FRONTEND=noninteractive

# The tools buildspec-ci.yml's own commands need: git (checkout metadata + the
# merge-verify probes), zip/unzip (the orchestrator bundle and the awscli
# installer), python3 (the guard scripts under scripts/), jq + curl (GitHub API
# calls in post_build). apt runs HERE, at image-build time -- rare, human-driven
# and retryable -- never during a CI build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq zip unzip \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 from the official installer (Debian has no v2 package). The
# buildspec calls `aws` for ECR login, S3 artifact sync and the events-table
# marker.
RUN curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/awscliv2.zip /tmp/aws

# Docker engine + CLI + buildx, from the static bundle. CodeBuild only starts a
# daemon for its OWN curated images, so a custom image has to carry the engine
# and start it itself (buildspec-ci.yml's post_build bootstraps dockerd in the
# BUILD_APP_IMAGE branch). containerd/runc/the shim are all required by dockerd.
RUN curl -fsSL -o /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
 && tar -xzf /tmp/docker.tgz -C /tmp \
 && install -m 0755 /tmp/docker/docker /tmp/docker/dockerd /tmp/docker/containerd \
      /tmp/docker/containerd-shim-runc-v2 /tmp/docker/runc /tmp/docker/ctr /usr/local/bin/ \
 && rm -rf /tmp/docker.tgz /tmp/docker \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx \
      "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-amd64" \
 && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-buildx

# Playwright's Chromium + the OS libs it links against, baked once. This is the
# ONLY place `--with-deps` (and therefore apt) still runs, and it runs at image
# build time. PLAYWRIGHT_BROWSERS_PATH is an ENV so the CI build inherits it:
# buildspec-ci.yml's install phase globs $PLAYWRIGHT_BROWSERS_PATH/chromium-* to
# decide whether it is on a baked image at all. World-readable (a+rX) because
# CodeBuild may run the build as a non-root user.
#
# The npm cache this leaves in /root/.npm (including _npx) is deliberately KEPT,
# not pruned: it is what lets the `--network none` smoke check in README.md run
# `npx --yes playwright@<ver> install chromium` offline and prove the browser is
# baked. There is no non-root user in this image, so a root-owned cache cannot
# poison anyone's later `npm ci`.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright \
 && npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
 && chmod -R a+rX /ms-playwright

# Everything the buildspec assumes must at least run. A broken layer has to fail
# the image build here, not turn into a mystery CI failure weeks later.
RUN node --version \
 && npm --version \
 && aws --version \
 && docker --version \
 && docker buildx version \
 && dockerd --version \
 && python3 --version \
 && git --version \
 && jq --version \
 && zip --version >/dev/null \
 && ls -d /ms-playwright/chromium-*

# CodeBuild overrides CMD with its own agent; this is only for local `docker run`.
CMD ["bash"]
