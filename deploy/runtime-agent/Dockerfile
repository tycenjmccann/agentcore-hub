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
COPY main.py .
EXPOSE 8080
# Wrap with opentelemetry-instrument so the runtime emits GenAI-semantic OTel
# spans to CloudWatch. Without this, AgentCore online evaluations have no
# session/trace data to score and the Evaluations page stays empty even
# when eval configs are ACTIVE at 100% sampling.
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html
CMD ["opentelemetry-instrument", "python", "main.py"]
