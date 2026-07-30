#!/bin/bash
# install-skills.sh — bake curated Claude Code skills into the runtime image at build time.
#
# Strategy:
#   1. Clone each curated upstream repo into a temp dir
#   2. Copy SKILL.md trees into ~/.claude/skills/<persona>/<name>/ for auto-discovery
#   3. For Anthropic's official marketplace, also register it via known_marketplaces.json
#      + settings.json so plugins' slash commands and subagents are available
#
# Curated by 14 parallel research agents on 2026-06-01. See:
#   - .claude-plugin/skills.json (machine-readable manifest)
#   - docs/skills-research-report.md (research notes)
#
# License scope: Apache-2.0 / MIT / MIT-0 / BSD only. Repos declared MIT in
# README/SKILL.md frontmatter without a top-level LICENSE file are included
# (vercel-labs, amplitude, posthog, crowdin) per project decision.
#
# Skipped (license-blocked):
#   - dpearson2699/swift-ios-skills (PolyForm Perimeter — non-OSI, non-redistributable)
#   - deanpeters/Product-Manager-Skills (CC BY-NC-SA 4.0 — NonCommercial)
#   - figma/mcp-server-guide (Figma Developer Terms — not OSS)
#   - grafana/pyroscope-skills (AGPL-3.0)

set -e

CLAUDE_HOME="${CLAUDE_HOME:-/root/.claude}"
SKILLS_DIR="$CLAUDE_HOME/skills"
MARKETS_DIR="$CLAUDE_HOME/plugins/marketplaces"
TMP_DIR="$(mktemp -d)"

mkdir -p "$SKILLS_DIR" "$MARKETS_DIR"

# clone_skill <repo_url> <persona> <name> [subdir]
#   Shallow-clones repo and copies <subdir> (or whole repo) into
#   ~/.claude/skills/<persona>/<name>/. Idempotent; cleans up after itself.
clone_skill() {
  local repo="$1" persona="$2" name="$3" subdir="${4:-}"
  local clone_dir="$TMP_DIR/$persona-$name"
  local dest="$SKILLS_DIR/$persona/$name"

  echo "  [$persona] $name <- $repo${subdir:+ ($subdir)}"
  rm -rf "$clone_dir"
  # A single upstream skill repo moving/renaming a path must NOT kill the whole
  # fleet build — warn and skip that one skill instead of aborting under set -e.
  if ! git clone --depth 1 --quiet "$repo" "$clone_dir"; then
    echo "  WARN: clone failed for $persona/$name ($repo) — skipping" >&2
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  if [ -n "$subdir" ]; then
    if [ ! -e "$clone_dir/$subdir" ]; then
      echo "  WARN: subdir '$subdir' not found in $repo — skipping $persona/$name" >&2
      return 0
    fi
    cp -r "$clone_dir/$subdir" "$dest"
  else
    cp -r "$clone_dir" "$dest"
    rm -rf "$dest/.git"
  fi
}

# clone_marketplace <repo_url> <name>
#   Clones a Claude Code plugin marketplace into ~/.claude/plugins/marketplaces/<name>/.
#   Caller must add an entry to known_marketplaces.json + settings.json.
clone_marketplace() {
  local repo="$1" name="$2"
  local dest="$MARKETS_DIR/$name"
  echo "  [marketplace] $name <- $repo"
  rm -rf "$dest"
  git clone --depth 1 --quiet "$repo" "$dest"
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Installing curated Claude Code skills (Apache-2.0/MIT only)"
echo "═══════════════════════════════════════════════════════════════"

# ─── Plugin marketplaces (full plugins with agents/commands/hooks) ─────────
# Cloned as marketplaces so /plugin install works and slash commands register.
clone_marketplace "https://github.com/anthropics/claude-plugins-official.git" "claude-plugins-official"
clone_marketplace "https://github.com/aws/agent-toolkit-for-aws.git"          "agent-toolkit-for-aws"
clone_marketplace "https://github.com/awslabs/agent-plugins.git"              "awslabs-agent-plugins"

# ─── Shared baseline (every persona benefits) ──────────────────────────────
# These come from the Anthropic marketplace — no separate clone needed.
# Listed here for documentation; they're enabled via settings.json below.

# ─── requirements_analyst ──────────────────────────────────────────────────
clone_skill "https://github.com/atlassian/atlassian-mcp-server.git" \
            "requirements_analyst" "atlassian-skills" "skills"
clone_skill "https://github.com/addyosmani/agent-skills.git" \
            "requirements_analyst" "planning-and-task-breakdown" \
            "skills/planning-and-task-breakdown"
clone_skill "https://github.com/addyosmani/agent-skills.git" \
            "requirements_analyst" "spec-driven-development" \
            "skills/spec-driven-development"

# ─── frontend_designer / frontend_dev (shared) ─────────────────────────────
# vercel-labs/agent-skills: declared MIT in SKILL.md frontmatter, no top-level LICENSE.
# Baked in per project decision (vendor-published, intent is clear).
clone_skill "https://github.com/vercel-labs/agent-skills.git" \
            "frontend" "react-best-practices" "skills/react-best-practices"
clone_skill "https://github.com/vercel-labs/agent-skills.git" \
            "frontend" "web-design-guidelines" "skills/web-design-guidelines"
clone_skill "https://github.com/vercel-labs/agent-skills.git" \
            "frontend" "composition-patterns" "skills/composition-patterns"
clone_skill "https://github.com/vercel-labs/agent-skills.git" \
            "frontend" "react-view-transitions" "skills/react-view-transitions"

# ─── ios_designer ──────────────────────────────────────────────────────────
clone_skill "https://github.com/twostraws/SwiftUI-Agent-Skill.git" \
            "ios_designer" "swiftui-pro" ""
clone_skill "https://github.com/vabole/apple-skills.git" \
            "ios_designer" "apple-skills" ""
clone_skill "https://github.com/Wholiver/swiftui-design-skill.git" \
            "ios_designer" "swiftui-design" ""
clone_skill "https://github.com/twostraws/Swift-Concurrency-Agent-Skill.git" \
            "ios_designer" "swift-concurrency-pro" ""

# ─── android_designer ──────────────────────────────────────────────────────
clone_skill "https://github.com/android/skills.git" \
            "android_designer" "android-google" ""
clone_skill "https://github.com/rcosteira79/android-skills.git" \
            "android_designer" "android-community" "plugins/android-skills"

# ─── backend_designer / backend_dev (shared via Anthropic + AWS marketplaces) ─
# aws-core, aws-serverless, databases-on-aws come from the AWS marketplaces above.
clone_skill "https://github.com/mongodb/agent-skills.git" \
            "backend" "mongodb" ""
clone_skill "https://github.com/ClickHouse/agent-skills.git" \
            "backend" "clickhouse" ""

# ─── api_dev ───────────────────────────────────────────────────────────────
clone_skill "https://github.com/apollographql/skills.git" \
            "api_dev" "apollo" ""
clone_skill "https://github.com/Postman-Devrel/postman-claude-code-plugin.git" \
            "api_dev" "postman" "skills"

# ─── security_reviewer ─────────────────────────────────────────────────────
# security-guidance is in the Anthropic marketplace (enabled below).

# ─── legal_compliance ──────────────────────────────────────────────────────
clone_skill "https://github.com/mrKanoh/claude-wcag-accessibility-skill.git" \
            "legal_compliance" "wcag-accessibility" ""
clone_skill "https://github.com/twilio/ai.git" \
            "legal_compliance" "twilio-compliance-traffic" \
            "skills/twilio/twilio-compliance-traffic"
clone_skill "https://github.com/twilio/ai.git" \
            "legal_compliance" "twilio-hipaa" \
            "skills/twilio/twilio-security-compliance-hipaa"
clone_skill "https://github.com/twilio/ai.git" \
            "legal_compliance" "twilio-regulatory" \
            "skills/twilio/twilio-regulatory-compliance-bundles"

# ─── localization ──────────────────────────────────────────────────────────
# crowdin/skills: no LICENSE file, declared free-to-use. Baked per project decision.
clone_skill "https://github.com/NoaTubic/flutter-localization-audit-skill.git" \
            "localization" "flutter-l10n-audit" ""
clone_skill "https://github.com/crowdin/skills.git" \
            "localization" "crowdin-context-extraction" "context-extraction"
clone_skill "https://github.com/nevinchanyi/claude-code-xcstrings-localizer.git" \
            "localization" "xcstrings-localizer" "skills/xcstrings-localizer"

# ─── analytics_designer ────────────────────────────────────────────────────
# amplitude + posthog: declared MIT in README, no LICENSE file. Baked per project decision.
clone_skill "https://github.com/amplitude/mcp-marketplace.git" \
            "analytics_designer" "amplitude" "plugins/amplitude"
clone_skill "https://github.com/PostHog/ai-plugin.git" \
            "analytics_designer" "posthog" ""
clone_skill "https://github.com/getsentry/sentry-for-claude.git" \
            "analytics_designer" "sentry" ""
clone_skill "https://github.com/honeycombio/agent-skill.git" \
            "analytics_designer" "honeycomb" "honeycomb"

# ─── qa_verifier ───────────────────────────────────────────────────────────
clone_skill "https://github.com/obra/superpowers.git" \
            "qa_verifier" "superpowers" ""

# ci_agent uses Anthropic + AWS marketplaces — no extra clones.

# ─── Register marketplaces and enable plugins ──────────────────────────────
echo ""
echo "  Registering plugin marketplaces in ~/.claude/plugins/known_marketplaces.json"

mkdir -p "$CLAUDE_HOME/plugins"
cat > "$CLAUDE_HOME/plugins/known_marketplaces.json" <<JSON
{
  "claude-plugins-official": {
    "source": {"source": "github", "repo": "anthropics/claude-plugins-official"},
    "installLocation": "$MARKETS_DIR/claude-plugins-official",
    "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  },
  "agent-toolkit-for-aws": {
    "source": {"source": "github", "repo": "aws/agent-toolkit-for-aws"},
    "installLocation": "$MARKETS_DIR/agent-toolkit-for-aws",
    "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  },
  "awslabs-agent-plugins": {
    "source": {"source": "github", "repo": "awslabs/agent-plugins"},
    "installLocation": "$MARKETS_DIR/awslabs-agent-plugins",
    "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  }
}
JSON

echo "  Enabling curated plugins in ~/.claude/settings.json"
cat > "$CLAUDE_HOME/settings.json" <<'JSON'
{
  "enabledPlugins": {
    "feature-dev@claude-plugins-official": true,
    "frontend-design@claude-plugins-official": true,
    "code-review@claude-plugins-official": true,
    "pr-review-toolkit@claude-plugins-official": true,
    "commit-commands@claude-plugins-official": true,
    "security-guidance@claude-plugins-official": true,
    "github@claude-plugins-official": true,
    "playwright@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true,
    "pyright-lsp@claude-plugins-official": true,
    "context7@claude-plugins-official": true,
    "chrome-devtools-mcp@claude-plugins-official": true,
    "aws-core@agent-toolkit-for-aws": true,
    "aws-serverless@awslabs-agent-plugins": true,
    "databases-on-aws@awslabs-agent-plugins": true,
    "deploy-on-aws@awslabs-agent-plugins": true
  }
}
JSON

# ─── Cleanup ────────────────────────────────────────────────────────────────
rm -rf "$TMP_DIR"

echo ""
echo "  Skills installed to: $SKILLS_DIR"
echo "  Marketplaces:        $MARKETS_DIR"
echo "  Settings:            $CLAUDE_HOME/settings.json"
echo "═══════════════════════════════════════════════════════════════"
