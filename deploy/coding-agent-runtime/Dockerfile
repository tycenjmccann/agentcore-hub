FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    CLAUDE_CODE_USE_BEDROCK=1 \
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
    OTEL_LOG_TOOL_DETAILS=1 \
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
USER root

# Python deps (health server + OTel + codex bedrock token generator)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

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
