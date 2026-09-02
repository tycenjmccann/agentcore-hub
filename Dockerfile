# Next.js App Runner Deployment
FROM node:22-alpine AS base

# Install dependencies only
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Build the application
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ENV TICKET_PROVIDER=jira
# NEXT_PUBLIC_* are inlined at build time, so the pipeline module's nav flag must
# be a build ARG — setting it only on the running service can't change the
# already-baked client bundle (Codex PR #263 P2). Off by default; the pipeline's
# Build stage passes --build-arg NEXT_PUBLIC_PIPELINE_ENABLED=1 when enabling it.
ARG NEXT_PUBLIC_PIPELINE_ENABLED=""
ENV NEXT_PUBLIC_PIPELINE_ENABLED=${NEXT_PUBLIC_PIPELINE_ENABLED}
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
# IMPORTANT: App Runner (and some ECS/Fargate configs) inject their own HOSTNAME
# env var at container launch, overriding this value. Next.js standalone binds to
# whatever HOSTNAME is set, so the health check on 127.0.0.1:8080 will fail if
# HOSTNAME resolves to the instance's internal hostname instead of 0.0.0.0.
# Fix: always set HOSTNAME=0.0.0.0 as a runtime env var in the service config.
# deploy/apprunner/deploy.sh does this automatically.
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Ensure Next.js cache directory is writable by the non-root user
RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next/cache

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
