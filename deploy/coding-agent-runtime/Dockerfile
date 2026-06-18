FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    CLAUDE_CODE_USE_BEDROCK=1 \
    CLAUDE_CODE_ENABLE_TELEMETRY=1 \
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 \
    OTEL_LOG_TOOL_DETAILS=1 \
    HOME=/home/bedrock_agentcore \
    PATH=/home/bedrock_agentcore/.local/bin:$PATH

# System deps — git for repo ops, Node.js for the Node-based CLIs (Claude, Codex)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates bash nodejs npm openssh-client jq unzip \
    && rm -rf /var/lib/apt/lists/*

# OpenTelemetry Collector Contrib — sidecar that SigV4-signs the CLIs' OTLP
# telemetry and forwards it to CloudWatch. Includes sigv4auth + transform (OTTL)
# processors that ADOT lacks.
ARG OTELCOL_VERSION=0.104.0
RUN curl -fsSL -o /tmp/otelcol-contrib.deb \
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_$(dpkg --print-architecture).deb" \
    && dpkg -i /tmp/otelcol-contrib.deb \
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
COPY run-codex.sh /app/
RUN chmod +x /app/run-codex.sh

USER bedrock_agentcore

# AgentCore Runtime service contract ports
EXPOSE 8080 8000 9000

CMD ["python", "main.py"]
