FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    CLAUDE_CODE_USE_BEDROCK=1 \
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
    OTEL_LOG_TOOL_DETAILS=1 \
    CODEX_SQLITE_HOME=/tmp/codex-sqlite \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    HOME=/home/bedrock_agentcore \
    PATH=/home/bedrock_agentcore/.local/bin:$PATH

# System deps — git for repo ops, Node.js for the Node-based CLIs (Claude, Codex).
# chromium: so npx/uvx-launched puppeteer/playwright MCP servers use a system
# browser instead of downloading one per session (PUPPETEER_EXECUTABLE_PATH below).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates bash nodejs npm openssh-client jq unzip bubblewrap \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# uv / uvx — the universal Python launcher most MCP servers ship as
# (`uvx <pkg>`). Installed to /usr/local/bin so BOTH the /invocations subprocess
# and the interactive PTY shell (PATH includes /usr/local/bin) can launch them;
# servers self-install on first run, so the image carries the launcher, not any
# specific server. One shared image serves every engineer's synced config.
RUN pip install --no-cache-dir uv

# GitHub CLI — lets the agent enumerate/inspect repos it has access to
# (authenticated via GH_TOKEN, which the server exports from GITHUB_PAT).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# OpenTelemetry Collector Contrib — sidecar that SigV4-signs the CLIs' OTLP
# telemetry and forwards it to CloudWatch. Includes sigv4auth + transform (OTTL)
# processors that ADOT lacks.
ARG OTELCOL_VERSION=0.104.0
# The .deb postinst registers a systemd service, which fails under buildkit
# ("System has not been booted with systemd"). We only need the unpacked binary
# (main.py runs /usr/bin/otelcol-contrib directly), so tolerate the postinst
# failure and assert the binary landed.
RUN curl -fsSL -o /tmp/otelcol-contrib.deb \
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_$(dpkg --print-architecture).deb" \
    && (dpkg -i /tmp/otelcol-contrib.deb || true) \
    && test -x /usr/bin/otelcol-contrib \
    && rm /tmp/otelcol-contrib.deb

# Codex CLI (Node-based). Pinned for reproducibility.
ARG CODEX_VERSION=0.137.0
RUN npm install -g @openai/codex@${CODEX_VERSION}

# Non-root runtime user (AgentCore convention) — owns the workspace mount.
# Create the home dir explicitly and chown it: on some base images a
# /home/bedrock_agentcore already exists owned by root, which would block the
# user-scoped CLI install below from writing ~/.claude.
RUN useradd -m -u 1000 bedrock_agentcore || useradd -u 1000 bedrock_agentcore \
    && mkdir -p /home/bedrock_agentcore \
    && chown -R bedrock_agentcore:bedrock_agentcore /home/bedrock_agentcore

# Claude Code CLI — installed as the runtime user so it lands on its PATH
# (~/.local/bin). Downloaded separately for auditability.
USER bedrock_agentcore
RUN curl -fsSL -o /tmp/claude-install.sh https://claude.ai/install.sh \
    && bash /tmp/claude-install.sh \
    && rm /tmp/claude-install.sh

# Kiro CLI — standalone Rust binaries (no Node). The aarch64 Linux zip carries
# kiro-cli + kiro-cli-chat + kiro-cli-term; `kiro-cli chat` dispatches to the
# chat binary, so all three must land on PATH — install.sh handles that, dropping
# them in ~/.local/bin. KIRO_CLI_SKIP_SETUP=1 skips the interactive shell-
# integration setup we don't want in a headless container. Base is glibc >= 2.34
# (Debian trixie-slim), so the standard (non-musl) build is correct. Installed as
# the runtime user. (Adds ~840 MB to the image — the chat binary is large.)
ARG KIRO_CLI_URL=https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-aarch64-linux.zip
RUN curl --proto '=https' --tlsv1.2 -fsSL -o /tmp/kirocli.zip "${KIRO_CLI_URL}" \
    && unzip -q /tmp/kirocli.zip -d /tmp/kirocli-extract \
    && KIRO_CLI_SKIP_SETUP=1 bash /tmp/kirocli-extract/kirocli/install.sh \
    && rm -rf /tmp/kirocli.zip /tmp/kirocli-extract \
    && "$HOME/.local/bin/kiro-cli" --version
# Every CLI the server can launch must at least start — a broken install is a
# fleet-wide "coding turn vanished", not a build failure, unless asserted here.
RUN "$HOME/.local/bin/claude" --version && codex --version
USER root

# Playwright's own Chromium build, baked once so dev/QA coding turns never
# download a browser mid-run. The apt `chromium` above is only for puppeteer/MCP
# (via PUPPETEER_EXECUTABLE_PATH); Playwright's node client ignores a system
# browser without a `channel`, so `npm test` used to `playwright install` on
# every fresh checkout. Pinned to the version the hub repo locks (package-lock
# @playwright/test 1.60.0) so a checked-out `playwright test` finds the exact
# browser revision and skips the download. Installed to a world-readable path
# (PLAYWRIGHT_BROWSERS_PATH) so the non-root runtime user can use it.
# NO `--with-deps`: it shells out to apt, which re-configures the half-installed
# otelcol-contrib package whose systemd postinstall fails in a Docker build (no
# PID 1) and aborts the whole install (exit 100). The apt `chromium` above
# already pulls chromium's shared libs (libnss3/libatk/…), so Playwright's own
# browser binary runs against them — we only need the browser download here.
# npm_config_cache: this runs as root with HOME=/home/bedrock_agentcore, so a bare
# npx would leave root-owned files in the runtime user's ~/.npm and every later
# `npm ci`/`npx` as that user fails with "cache folder contains root-owned files".
RUN mkdir -p /opt/pw-browsers \
 && npm_config_cache=/tmp/npm-cache-build npx --yes playwright@1.60.0 install chromium \
 && rm -rf /tmp/npm-cache-build \
 && chmod -R a+rx /opt/pw-browsers

# Python deps (health server + OTel + codex bedrock token generator)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Exact resolved versions in the build log + import assertion, so a dependency
# API break fails the image build rather than the first /invocations (the fleet
# runtime learned this the hard way on 2026-09-09).
RUN pip freeze \
 && python -c "import fastapi, uvicorn, boto3, requests, aws_bedrock_token_generator"

# Resumable /invocations server, OTel config, structured logging. The server
# runs `claude` directly; Codex still goes through its Mantle launcher script.
COPY otel-collector-config.yaml log.py main.py ./
COPY run-codex.sh merge-codex-config.py shell-init.sh /app/
RUN chmod +x /app/run-codex.sh /app/merge-codex-config.py /app/shell-init.sh

# Make the interactive Terminal-tab shell pre-load Bedrock auth for both CLIs so
# bare `claude`/`codex` skip their login screens (matches the chat experience).
# Write to BOTH the system-wide rc (read by every interactive bash, which the
# PTY's non-login shell honors) and the user rc (login shells / belt-and-braces).
RUN SRC='[ -f /app/shell-init.sh ] && source /app/shell-init.sh' \
    && echo "$SRC" >> /etc/bash.bashrc \
    && echo "$SRC" >> /home/bedrock_agentcore/.bashrc \
    && echo "$SRC" >> /home/bedrock_agentcore/.profile \
    && chown bedrock_agentcore:bedrock_agentcore /home/bedrock_agentcore/.bashrc /home/bedrock_agentcore/.profile

USER bedrock_agentcore

# AgentCore Runtime service contract ports
EXPOSE 8080 8000 9000

CMD ["python", "main.py"]
