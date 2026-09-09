FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app
RUN apt-get update && apt-get install -y gcc g++ git curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex && \
    npx playwright install --with-deps chromium

# Bake curated Claude Code skills/plugins into the image so each fleet agent
# starts with domain expertise pre-loaded. See install-skills.sh for the full
# list and license sourcing notes.
COPY install-skills.sh .
RUN bash install-skills.sh && rm install-skills.sh

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Record the exact resolved versions in the build log: when a rebuild from the
# same source behaves differently, this is the diff to read.
RUN pip freeze
# Build-time smoke: the MCP transport import is lazy (inside a tool-mount
# function), so a dependency API break only surfaces when a persona cold-starts
# in prod (fleet v41, 2026-09-09: every session died in <1s at this import).
# Fail the image build instead — for the MCP transport and for every top-level
# package main.py imports.
RUN python -c "from mcp.client.streamable_http import streamablehttp_client" \
 || python -c "from mcp.client.streamable_http import streamable_http_client"
RUN python -c "import strands, strands.tools.mcp, strands_tools, bedrock_agentcore, boto3, httpx, nest_asyncio, playwright, aws_bedrock_token_generator, opentelemetry"
COPY main.py .
EXPOSE 8080
# Wrap with opentelemetry-instrument so the runtime emits GenAI-semantic OTel
# spans to CloudWatch. Without this, AgentCore online evaluations have no
# session/trace data to score and the Evaluations page stays empty even
# when eval configs are ACTIVE at 100% sampling.
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html
CMD ["opentelemetry-instrument", "python", "main.py"]
