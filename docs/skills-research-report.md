# Fleet Skills Research Report

**Date:** 2026-06-01
**Method:** 14 parallel research agents, one per fleet persona. Each agent verified candidates against the Anthropic-official marketplace (`anthropics/claude-plugins-official`, 205 plugins), `vercel-labs/agent-skills`, GitHub topic searches, and vendor-specific repos. License/star/last-commit data fetched live via GitHub API on the same day.

**Output:** `.claude-plugin/skills.json` (machine-readable manifest, edit freely).

**Goal:** Bake curated, license-clean Claude Code skills into the runtime Docker image so each fleet agent spawns with domain expertise pre-loaded.

---

## Headline findings

1. **The Anthropic-official marketplace is the most reliable source.** ~10 plugins from `anthropics/claude-plugins-official` show up as "strong include" across 9+ personas (`feature-dev`, `pr-review-toolkit`, `code-review`, `commit-commands`, `github`, `frontend-design`, `security-guidance`, `pyright-lsp`, `typescript-lsp`, `playwright`). All Apache-2.0, all from the 29k-star Anthropic repo.

2. **AWS coverage is excellent.** `aws/agent-toolkit-for-aws/plugins/aws-core` + `awslabs/agent-plugins` cover backend, API, CI, and serverless personas comprehensively — all Apache-2.0, official AWS, actively maintained.

3. **Vendor-specific skill quality varies wildly.** MongoDB, ClickHouse, Apollo, Honeycomb, Sentry, Auth0 ship genuine schema/design content. Most others (Vanta, LegalZoom, Semgrep, Sonarqube, Snyk) are MCP-server wrappers requiring vendor accounts — useless when baked into a generic Docker image.

4. **Niche personas have thin ecosystems.**
   - **localization**: Best picks all <10 stars and <6 months old.
   - **legal_compliance**: Anthropic marketplace has only 2 plugins (legalzoom, vanta) and both are MCP-dependent.
   - **android_designer**: Google's `android/skills` is excellent (Apache-2.0, 5.5k stars), but most community Android skill repos are 0–4 stars with no LICENSE.

5. **License risks worth flagging now:**
   - `vercel-labs/agent-skills` — declared MIT in README+frontmatter but **no top-level LICENSE file**. Used by frontend_designer, frontend_dev, ios_designer.
   - `dpearson2699/swift-ios-skills` — **PolyForm Perimeter** (NOT OSI-approved). Best iOS content available; legal review needed before bundling in public Docker image.
   - `deanpeters/Product-Manager-Skills` — **CC BY-NC-SA 4.0** (NonCommercial). Best epic-splitting content; cannot be bundled in commercial open-source product.
   - `figma/mcp-server-guide` — Figma Developer Terms (not OSS).
   - `grafana/pyroscope-skills` — AGPL-3.0.
   - `amplitude/mcp-marketplace`, `PostHog/ai-plugin`, `crowdin/skills` — declare MIT in README but no LICENSE file.

6. **Skills to actively skip (anti-patterns):**
   - `aihip/android-claude-code-skills` — figma-to-android skill explicitly forbids Jetpack Compose. Actively contradicts persona.
   - All vendor SAST plugins (semgrep/aikido/sonarqube/snyk) for security_reviewer — they need a code artifact AND vendor account, neither of which the persona has at design-review time.
   - `joshchaotang/claude-code-i18n` and similar — these translate Claude Code's *own UI* into Chinese/Japanese, not target apps.

---

## Recommended baseline (cross-cutting, every persona)

| Plugin | Source | License |
|--------|--------|---------|
| `github` | `anthropics/claude-plugins-official/external_plugins/github` | Apache-2.0 |
| `commit-commands` | `anthropics/claude-plugins-official/plugins/commit-commands` | Apache-2.0 |

---

## Per-persona top picks

| Persona | Top 3 |
|---------|-------|
| **requirements_analyst** | `atlassian/spec-to-backlog`, `feature-dev`, `addyosmani/agent-skills` |
| **frontend_designer** | `frontend-design`, `vercel/web-design-guidelines`, `vercel/react-best-practices` |
| **ios_designer** | `twostraws/SwiftUI-Pro`, `vabole/apple-skills`, `Wholiver/swiftui-design-skill` |
| **android_designer** | `android/skills` (Google), `rcosteira79/android-skills` |
| **backend_designer** | `aws-core`, `feature-dev`, `mongodb` or `clickhouse` |
| **security_reviewer** | `security-guidance` (Anthropic) |
| **legal_compliance** | `mrKanoh/wcag-accessibility`, `twilio/compliance-traffic`, `fsch/soc2-startup` |
| **localization** | `flutter-localization-audit`, `crowdin/skills`, `xcstrings-localizer` |
| **analytics_designer** | `amplitude`, `posthog`, `sentry-for-claude`, `honeycomb` |
| **frontend_dev** | `vercel/react-best-practices`, `vercel/web-design-guidelines`, `chrome-devtools-mcp`, `frontend-design`, `context7` |
| **backend_dev** | `aws-core`, `aws-serverless`, `databases-on-aws`, `aws-dev-toolkit`, `github` |
| **api_dev** | `apollo-skills`, `aws-serverless`, `42crunch-api-security`, `postman` |
| **qa_verifier** | `pr-review-toolkit`, `superpowers`, `playwright`, `code-review` |
| **ci_agent** | `commit-commands`, `pr-review-toolkit`, `code-review`, `github`, `aws-core` |

---

## License followup queue (before Dockerfile bake)

These need confirmation before redistribution in a public Docker image:

1. **vercel-labs/agent-skills** — file issue requesting top-level LICENSE matching SKILL.md frontmatter (MIT).
2. **amplitude/mcp-marketplace** — file issue requesting LICENSE.
3. **PostHog/ai-plugin** — file issue requesting LICENSE.
4. **crowdin/skills** — file issue requesting LICENSE.
5. **42Crunch-AI/claude-plugins** — confirm baking only `plugins/api-security-testing/` subdir is acceptable (subdir is Apache-2.0, root has no LICENSE).
6. **dpearson2699/swift-ios-skills** — legal review of PolyForm Perimeter for our redistribution context, OR substitute with `twostraws/SwiftUI-Agent-Skill` (MIT) as primary.

---

## What's NOT in the manifest

- Speculative skills the agent couldn't verify a real link for.
- MCP servers requiring vendor accounts (no value when baked into a generic image).
- Repos with no LICENSE that don't have license data in SKILL.md/README.
- Platform-specific skills outside our fleet's scope (UI5, Wix, Liquid, Power Platform Dataverse).

---

## Next step

User reviews `.claude-plugin/skills.json`, edits/removes/adds entries, and signals approval. Only then do we bake into the Dockerfile via `npx skills add ... --agent claude-code -g -y` between the `npm install -g @anthropic-ai/claude-code` and `COPY requirements.txt` lines in `deploy/runtime-agent/Dockerfile`.
