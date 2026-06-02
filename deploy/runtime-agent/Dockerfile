FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app
RUN apt-get update && apt-get install -y gcc g++ git curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code && \
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
CMD ["python", "main.py"]
