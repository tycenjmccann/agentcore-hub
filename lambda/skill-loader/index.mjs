/**
 * Skill Loader Lambda — serves skill instructions to AgentCore harness agents.
 * Called via MCP gateway as a tool: load_skill({ skill_name: "ios-architecture" })
 * Returns detailed markdown instructions that guide the agent's behavior.
 */

const SKILLS = {
  // ===== DESIGN AGENT SKILLS =====
  "ios-architecture": `# Skill: iOS Architecture Design

## Purpose
Design native iOS application features with production-grade architecture.

## Instructions
When designing an iOS feature:

1. **Component Architecture**
   - Define the module structure (Swift Package targets)
   - Specify protocols/interfaces between components
   - Design the data flow (unidirectional where possible)
   - Use @Observable pattern with SwiftUI (no ViewModels)

2. **Data Model**
   - Define all model types as structs (Codable, Sendable)
   - Specify persistence strategy (SwiftData, UserDefaults, Keychain)
   - Design API request/response types
   - Include migration strategy if modifying existing models

3. **API Contract**
   - Define REST/GraphQL endpoints needed
   - Specify request/response schemas with examples
   - Document error cases and status codes
   - Include rate limiting and retry strategy

4. **UI/UX Flow**
   - Describe each screen and its states (loading, loaded, error, empty)
   - Define navigation flow between screens
   - Specify animations and transitions
   - Include accessibility requirements (VoiceOver, Dynamic Type)

5. **System Integration**
   - iOS frameworks required (UserNotifications, HealthKit, etc.)
   - Background processing requirements
   - Permission flow and fallback behavior
   - Device capability checks

6. **Risk Assessment**
   - Memory/battery impact
   - Network failure handling
   - App Store review considerations
   - Privacy and data handling (App Tracking Transparency, etc.)

## Output Format
Produce a structured design document with clear sections, code snippets for key interfaces, and a dependency diagram described in text.`,

  "backend-systems": `# Skill: Backend Systems Design

## Purpose
Design scalable backend services, APIs, and infrastructure.

## Instructions
When designing a backend system:

1. **Service Architecture**
   - Define service boundaries and responsibilities
   - Specify communication patterns (sync REST, async events, gRPC)
   - Design for horizontal scalability
   - Document service dependencies and failure modes

2. **Data Layer**
   - Choose appropriate data stores (DynamoDB, RDS, ElastiCache, S3)
   - Design table/schema with access patterns in mind
   - Specify indexes (GSI/LSI for DynamoDB, B-tree for RDS)
   - Plan for data growth and archival

3. **API Design**
   - RESTful resource modeling with proper HTTP semantics
   - Authentication/authorization strategy (JWT, API keys, IAM)
   - Rate limiting tiers and throttling behavior
   - Versioning strategy (URL path vs header)
   - OpenAPI/Swagger specification

4. **Security**
   - Input validation and sanitization
   - SQL injection / NoSQL injection prevention
   - CORS configuration
   - Secrets management (Secrets Manager, Parameter Store)
   - Encryption at rest and in transit

5. **Observability**
   - Structured logging with correlation IDs
   - CloudWatch metrics and alarms
   - X-Ray tracing for distributed calls
   - Health check endpoints

6. **Infrastructure**
   - AWS CDK constructs needed
   - Lambda vs ECS vs Fargate decision
   - VPC configuration if needed
   - CI/CD pipeline stages

## Output Format
Produce architecture diagram (text), API specs, data model, and infrastructure requirements.`,

  "privacy-compliance": `# Skill: Privacy & Compliance Design

## Purpose
Design features that comply with privacy regulations (GDPR, CCPA, etc.)

## Instructions
When designing privacy/compliance features:

1. **Data Inventory**
   - Catalog all personal data involved
   - Map data flows (collection → processing → storage → deletion)
   - Identify data processors and controllers
   - Document legal basis for processing

2. **User Rights Implementation**
   - Right to access (data export format, timeline)
   - Right to deletion (cascade logic, retention exceptions)
   - Right to portability (machine-readable format)
   - Right to rectification (edit flows)
   - Consent management (granular opt-in/out)

3. **Technical Controls**
   - Data minimization (collect only what's needed)
   - Purpose limitation enforcement
   - Encryption and pseudonymization
   - Access controls and audit logging
   - Automated data retention and purging

4. **API Design for Privacy**
   - Data export endpoint (async job, signed download URL)
   - Deletion endpoint with cascading logic
   - Consent preferences endpoint
   - Audit log query endpoint

5. **Compliance Documentation**
   - Data Processing Agreement requirements
   - Privacy Impact Assessment
   - Record of Processing Activities updates
   - Cross-border transfer mechanisms (SCCs, adequacy)

## Output Format
Data flow diagram, API specifications, deletion cascade logic, and compliance checklist.`,

  "localization": `# Skill: Localization & i18n Design

## Purpose
Design internationalization support for multi-language applications.

## Instructions
When designing localization:

1. **String Management**
   - Catalog all user-facing strings
   - Define string key naming convention
   - Handle pluralization rules per locale
   - Support interpolation and formatted strings
   - Plan for string length variation (German ~30% longer)

2. **Content Strategy**
   - Static UI strings vs dynamic content
   - Translation workflow (source → extract → translate → integrate)
   - Fallback chain (requested locale → region → language → default)
   - Right-to-left (RTL) layout support if applicable

3. **Technical Architecture**
   - iOS: Localizable.strings / String Catalogs
   - Backend: i18n middleware, locale detection
   - Database: multi-language content storage pattern
   - Asset localization (images, videos with text)

4. **Date, Number, Currency**
   - Locale-aware formatting (DateFormatter, NumberFormatter)
   - Timezone handling
   - Currency conversion vs display-only
   - Calendar system differences

5. **Testing Strategy**
   - Pseudo-localization for layout testing
   - Screenshot generation per locale
   - String length boundary testing
   - RTL layout verification

## Output Format
String catalog structure, translation workflow, technical implementation plan, and testing matrix.`,

  "frontend-design": `# Skill: Frontend Design

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## Branding System (when working on an existing project)

If a branding kit exists in S3 (bucket: agentcore-hub-branding, key: branding-kit/brand-system.md), read it FIRST and design within that system. The branding system takes precedence over the "bold new direction" guidance above — existing projects need consistency, not reinvention. Greenfield projects without a branding kit get full creative freedom.

## Brownfield Feature Design (CRITICAL — read before designing)

When the feature MODIFIES or ENHANCES existing functionality:

1. **Read the existing implementation FIRST** — understand its component structure, state management, CSS approach, and data flow BEFORE designing anything new.
2. **Design as a DELTA, not a replacement.** Your spec should say "add X to existing component Y" not "create new component Z."
3. **NEVER design a parallel state machine.** If the existing code manages state for the same domain (e.g., replay state, modal state, form state), your design MUST extend that state — not create a competing one.
4. **NEVER spec a new CSS file** if the existing component's styles are in an existing file. Add new rules to the existing stylesheet.
5. **Integration is not an afterthought.** The design must show HOW new code plugs into existing state/props/callbacks — not just provide an \`onSomething\` callback and hope the dev figures it out.

**Example of WRONG approach:**
- Existing: WorkflowBoard has \`isPlaying\`, \`replayIndex\`, \`seekTo()\`
- Wrong design: "Create \`useReplayState.ts\` with its own RAF loop, own play/pause, own progress tracking, and call parent's \`onSeek\` when position changes"
- This creates TWO replay engines running simultaneously.

**Example of CORRECT approach:**
- Existing: WorkflowBoard has \`isPlaying\`, \`replayIndex\`, \`seekTo()\`
- Correct design: "Replace the \`<input type='range'>\` in WorkflowBoard's replay bar with a styled scrubber component. The component receives \`isPlaying\`, \`progress\`, \`onTogglePlay\`, \`onSeek\` as props from WorkflowBoard's existing state. No internal playback state — it's a controlled component driven by the parent."

## Accessibility (WCAG 2.1 AA — always required)

Regardless of aesthetic direction, every design MUST specify:
- Semantic HTML (correct elements: nav, main, aside, button vs a)
- ARIA attributes for dynamic content and custom controls
- Keyboard navigation (tab order, focus trapping, Escape to close)
- Color contrast: 4.5:1 normal text, 3:1 large text
- Visible focus indicators
- prefers-reduced-motion alternatives
- Touch targets: minimum 44x44px

## Responsive Strategy

Define behavior at breakpoints:
- Mobile (< 640px): Single column, hidden sidebars
- Tablet (640-1024px): Collapsed nav, 2-col layouts
- Desktop (> 1024px): Full layout
- Wide (> 1440px): Constrained content width

## Output Format

Your design document must include:
1. **Aesthetic Direction** — the conceptual vision and why it fits
2. **Component Architecture** — hierarchy, responsibilities, state ownership
3. **Per-component Spec** — visual states (default/hover/focus/active/disabled/loading/error), CSS approach, ARIA
4. **Layout & Responsive** — grid/flex skeleton, breakpoint behaviors
5. **Typography & Color** — specific font choices, palette, token mapping
6. **Motion & Interaction** — animations, transitions, timing, easing
7. **Accessibility Checklist** — per-component a11y requirements
8. **Edge Cases** — empty, overflow, error, loading states`,

  "general-design": `# Skill: General Software Design

## Purpose
Produce a comprehensive technical design for any software feature.

## Instructions
Follow standard software design methodology:
1. Requirements analysis and clarification
2. Component architecture and boundaries
3. Data model and persistence
4. API contracts and integration points
5. Error handling and edge cases
6. Testing strategy
7. Deployment and rollback plan
8. Risk assessment and mitigation

## Output Format
Structured design document with diagrams described in text, interface definitions, and implementation notes.`,

  // ===== REQUIREMENTS AGENT SKILL =====
  "requirements-analysis": `# Skill: Requirements Analysis & Ticket Creation

## CRITICAL: Agent Selection — DEFAULT DENY

You MUST justify every agent you assign. The DEFAULT is to NOT include an agent. Ask yourself for EACH agent: "Does this feature REQUIRE this agent's domain expertise?" If you can't articulate a specific, concrete reason — DO NOT create a ticket for them.

### MANDATORY EXCLUSION RULES
- iOS designer/Android designer: ONLY if the app IS a native mobile app. A web/React/Next.js app NEVER needs these.
- Security reviewer: ONLY if the feature touches auth, credentials, user data storage, or API keys. A UI layout change does NOT need security review.
- Legal/compliance: ONLY if the feature introduces NEW user data collection, changes consent flows, or affects data retention. Reshuffling existing UI does NOT need legal review.
- Localization: ONLY if the feature introduces NEW user-facing strings in a product that ships to non-English markets. Internal tools and dev consoles do NOT need localization.
- Analytics designer: ONLY if the feature introduces NEW user interactions that need tracking. Moving a sidebar does NOT need analytics.
- Backend designer/dev: ONLY if the feature requires NEW API endpoints, database changes, or server-side logic. Pure CSS/UI changes do NOT need backend work.
- API dev: ONLY if NEW API routes are being created. Consuming existing APIs does NOT require this agent.

### EXAMPLES OF CORRECT ASSIGNMENT

**"Add collapsible sidebar to web app"**
→ agentcore_hub_frontend_dev, agentcore_hub_qa_verifier, agentcore_hub_ci_agent (3 agents total)
Why: Pure UI change. No new data, no new APIs, no mobile, no security implications.

**"Add user profile photo upload"**
→ agentcore_hub_backend_designer, agentcore_hub_frontend_dev, agentcore_hub_backend_dev, agentcore_hub_security_reviewer, agentcore_hub_qa_verifier, agentcore_hub_ci_agent (6 agents)
Why: New file upload API (backend), new UI (frontend), file handling security (security), verification needed.

**"Add dark mode toggle"**
→ agentcore_hub_frontend_dev, agentcore_hub_qa_verifier, agentcore_hub_ci_agent (3 agents)
Why: CSS/state change only. No APIs, no data, no security.

**"Add payment processing"**
→ agentcore_hub_backend_designer, agentcore_hub_frontend_dev, agentcore_hub_backend_dev, agentcore_hub_api_dev, agentcore_hub_security_reviewer, agentcore_hub_legal_compliance, agentcore_hub_qa_verifier, agentcore_hub_ci_agent (8 agents)
Why: New APIs, PCI compliance, legal requirements, full-stack implementation.

### COMMON MISTAKES TO AVOID
- DO NOT assign iOS/Android designers for web applications
- DO NOT assign localization for internal/dev tools
- DO NOT assign legal for UI layout changes
- DO NOT assign analytics for features that don't add new user interactions
- DO NOT assign backend agents for pure frontend work
- DO NOT create generic tickets with titles like "Design: {agent name} — {feature title}" — be SPECIFIC about what you need from each agent
- DO NOT invent agent IDs that don't exist. There is NO "agentcore_hub_ios_dev" agent. ALL frontend/UI/iOS/SwiftUI development goes to agentcore_hub_frontend_dev. The ONLY valid dev agents are: agentcore_hub_frontend_dev, agentcore_hub_backend_dev, agentcore_hub_api_dev
- For iOS projects: use agentcore_hub_ios_designer for design, agentcore_hub_frontend_dev for implementation

## Process

### Phase 1: Input Analysis
1. Read all provided inputs from your Workflow Context
2. If presigned image URLs are provided, navigate to each with the browser tool
3. Write detailed visual analysis of images (this is the sole reference for downstream agents)

### Phase 2: Feature Scope Classification (MANDATORY — do not skip)

Before defining requirements, you MUST classify the feature scope:

**MODIFY EXISTING** (default — assume this unless proven otherwise):
- Does the codebase already have similar/related functionality? (grep for it)
- Is there an existing component, hook, or module that does 50%+ of what's requested?
- Is there existing state management, data flow, or UI that this feature extends?

**NET NEW** (requires explicit justification):
- You MUST prove no overlapping functionality exists (include grep results)
- The feature introduces a genuinely new concern with no existing code to build on

**CLASSIFICATION RULES:**
- If existing code handles the same domain (e.g., "replay" and there's already a replay system), the scope is ALWAYS "MODIFY EXISTING"
- NEVER specify creating a new state management system if one already exists for that domain
- NEVER specify new files for functionality that can be added to existing files
- When in doubt, default to MODIFY EXISTING

**Output:** Include in your requirements doc:
\`\`\`
## Feature Scope: [MODIFY EXISTING | NET NEW]
Existing code: [file paths of related existing code]
Approach: [Enhance X / Replace X with justification / Build new Y because Z doesn't exist]
\`\`\`

### Phase 3: Requirements Extraction
1. Extract functional requirements with testable acceptance criteria
2. Identify WHICH SPECIFIC FILES need to change (read repo structure if needed)
3. For MODIFY EXISTING: requirements MUST reference existing functions/state to enhance (not replace)
4. For NET NEW: requirements MUST confirm integration points with existing code
5. Write requirements to S3: workflows/{workflow_id}/shared/requirements.md

### Phase 3: Agent Selection (THINK HARD HERE)
1. For each agent in your roster, ask: "Is this agent's domain CONCRETELY needed?"
2. If you cannot name a specific deliverable from that agent, DO NOT include them
3. Write your reasoning for inclusion/exclusion in a comment on the epic

### Phase 4: Ticket Creation
- Title: Specific deliverable, not generic ("{Agent}: do {specific thing}")
- Description: Requirements, acceptance criteria, file paths, visual references
- DEPENDENCY CHAIN (CRITICAL — follow exactly):
  - Design agents: blocked_by="" (no blockers, run immediately)
  - Dev agents: blocked_by=ALL design ticket IDs (comma-separated)
  - QA ticket: blocked_by=ALL dev ticket IDs
  - CI ticket: blocked_by=QA ticket ID (NOT dev tickets — CI runs AFTER QA passes)
- Create tickets in order so you have IDs to reference in blocked_by

### Phase 5: Completion
1. Comment on epic with your agent selection reasoning
2. Transition your own ticket to "done"
3. Call report_completion`,

  // ===== QA VERIFICATION SKILL =====
  "qa-verification": `# Skill: QA Verification Process

You ARE the QA environment. You have shell, file_read, file_write, python_repl, and code interpreter tools. USE THEM. Do not just read code and guess — execute commands and report real output.

## Phase 1: Clone & Build (MANDATORY — do not skip)

Run these commands in sequence using shell tool. Include the FULL output of each in your report:

\`\`\`
cd /tmp
git clone <repo_url> qa-workspace && cd qa-workspace
git checkout <branch_name>
\`\`\`

Then detect project type and run the appropriate build:

**Node.js/TypeScript (package.json exists):**
\`\`\`
npm ci
npm run build 2>&1        # CAPTURE FULL OUTPUT — build errors are failures
npm run lint 2>&1         # CAPTURE FULL OUTPUT — lint errors are failures
npx tsc --noEmit 2>&1    # Type check without emitting — type errors are failures
\`\`\`

**Python (requirements.txt or pyproject.toml):**
\`\`\`
pip install -r requirements.txt  # or: pip install -e .
python -m pytest 2>&1
python -m mypy . 2>&1           # if mypy configured
\`\`\`

**Swift/iOS (Package.swift or .xcodeproj):**
\`\`\`
swift build 2>&1
swift test 2>&1
\`\`\`

If ANY command exits non-zero, that is a BLOCKING failure. Do not proceed to Phase 2.

## Phase 2: Static Analysis (MANDATORY)

After build passes, perform framework-specific checks by reading the actual source files:

**For Next.js/React projects:**
- Search for dynamic Tailwind classes: grep for template literals inside className (e.g., \\\`\${var}\\\` patterns). These are PURGED in production builds. Flag as BLOCKING.
- Check animation classes: if code uses \`animate-in\`, \`fade-in\`, \`slide-in-*\`, \`zoom-in-*\`, \`scrollbar-thin\`, verify the required plugins (\`tailwindcss-animate\`, \`tailwind-scrollbar\`) are in BOTH package.json AND tailwind.config plugins array. Missing plugin = classes PURGED = BLOCKING.
- Search for hydration issues: any useState initialized from localStorage/window/navigator WITHOUT a useEffect guard. Flag as BLOCKING.
- Verify all imports resolve: for each new import added in the PR, confirm the export exists at that path using file_read or grep.
- Check for \`Math.random()\` or \`Date.now()\` in render paths (causes SSR/client mismatch). Flag as BLOCKING.
- Verify "use client" directives: client-only hooks (useState, useEffect, useContext) must be in files with "use client" at top.

**For any project:**
- Check for hardcoded secrets, API keys, or credentials in the diff
- Verify error handling: no empty catch blocks, no swallowed errors
- Check accessibility: interactive elements need aria-labels or visible text labels
- Verify prefers-reduced-motion handling if animations are present

## Phase 3: Functional Verification

If the sandbox supports running the app (dev server starts successfully):
1. Use browser tool to navigate and screenshot affected pages
2. Compare against mockups if provided in your context
3. Test interactive states (click, hover, toggle)

If the sandbox CANNOT run the app (e.g., missing env vars, database deps):
1. Document WHY it cannot run (specific error)
2. Still complete Phase 1 and Phase 2 — those do NOT require a running app
3. Note in your report: "Runtime verification skipped: {reason}"

## Phase 4: Test Execution

Run the project's existing test suite:
\`\`\`
npm test 2>&1          # or: pytest, swift test, etc.
\`\`\`
- New code SHOULD have tests. Flag if no tests were added for new functionality (non-blocking note, not a failure).
- Existing tests MUST still pass. Any regression is BLOCKING.

## Phase 5: Verdict & Reporting

### PASS criteria (ALL must be true):
- Build exits 0
- Lint exits 0 (or project has no linter configured)
- Type check exits 0
- No dynamic Tailwind classes found
- No hydration issues found
- No unresolved imports
- Existing tests pass
- No security issues

### FAIL — Create Fix Ticket:
1. Call Tickets___create_ticket:
   - title: "Fix: {specific issue}" (e.g., "Fix: dynamic Tailwind classes in MetricCard.tsx will be purged")
   - description: Include EXACT command output, file:line references, what's wrong, how to fix it
   - assignee: the dev agent who wrote the code
   - parent_id: epic_id
   - blocked_by: "" (immediately invocable)
2. Block yourself on the fix ticket
3. Report completion noting you're blocked

### Re-verification (when re-invoked after fix):
- Re-run same checks, focus on prior failures
- Pass → report "Re-verification passed"
- Still broken → another fix ticket (max 3 cycles)
- After 3 cycles → "ESCALATE:" prefix

## COMPLETION GATE — MANDATORY BEFORE report_completion

Before calling report_completion, verify ALL of these are in your output:

- [ ] Git clone output showing successful checkout of the feature branch
- [ ] Build command output with exit code 0
- [ ] Type check output with exit code 0
- [ ] Lint output with exit code 0
- [ ] Grep/search output for dynamic Tailwind classes
- [ ] Grep/search output for hydration issues (useState + localStorage/window)
- [ ] Import verification (all new imports resolve)

If ANY of these are missing, you have NOT completed QA verification. Go back and run the missing commands.

## HYDRATION & FLASH ISSUES — ALWAYS BLOCKING

These are BLOCKING failures, never "non-blocking suggestions":
- useState initialized to a default that differs from what the head script/localStorage sets (causes flash)
- data attributes set in <head> script but not consumed by CSS or initial React state
- Any visual flash/jump on page load due to state mismatch between SSR and client hydration

The correct pattern for persisted state (localStorage, cookies):
\\\`\\\`\\\`
// CORRECT: Initialize from DOM/document so SSR matches client
const [value, setValue] = useState(() => {
  if (typeof document !== 'undefined') {
    return document.documentElement.getAttribute('data-my-attr') === 'true';
  }
  return false;
});

// WRONG: Initialize to default, then update in useEffect (causes flash)
const [value, setValue] = useState(false);
useEffect(() => { setValue(localStorage.getItem('key') === 'true'); }, []);
\\\`\\\`\\\`

If you see the WRONG pattern, it is a BLOCKING failure. Create a fix ticket or fix it yourself if trivial.

## SMALL FIXES (you can do these yourself)

For trivial issues (< 5 lines, clearly correct):
- Fix the useState initializer to read from DOM attribute
- Add a missing aria-label
- Remove an unused import

Use claude_code to push the fix directly, then continue verification. Only for truly trivial changes.

## CRITICAL RULES
- You MUST show command output as evidence. "All checks pass" without output is INVALID.
- NEVER approve based on "the code looks correct." RUN the build.
- NEVER classify a runtime correctness issue as "non-blocking." If users will see a flash, flicker, or broken state, it's BLOCKING.
- If tools fail, report BLOCKED — do NOT fall back to code-review-only approval.
- A "non-blocking note" is ONLY for code style preferences. Runtime correctness is ALWAYS blocking.
- Dynamic Tailwind classes (\\\`bg-\${color}\\\`) are ALWAYS a blocking failure in any Tailwind project.`,

  // ===== CI VERIFICATION SKILL =====
  "ci-verification": `# Skill: CI Verification Process

You ARE the CI system. There is no external CI pipeline — YOU run the builds, lints, and tests. You have shell, python_repl, and code interpreter tools. USE THEM.

## Phase 1: Clone & Setup (MANDATORY)

\`\`\`
cd /tmp
git clone <repo_url> ci-workspace && cd ci-workspace
git checkout <branch_name>
git diff main..HEAD --stat   # Show what files changed
\`\`\`

## Phase 2: Build Verification (MANDATORY — run ALL, report ALL output)

Detect project type and execute the full build pipeline. You MUST include the actual command output (stdout + stderr) in your report as evidence.

**Node.js/TypeScript projects:**
\`\`\`
npm ci                           # Install from lockfile (deterministic)
npx tsc --noEmit --strict 2>&1   # TypeScript strict type checking
npm run lint 2>&1                # Linting (ESLint, Biome, etc.)
npm run build 2>&1               # Production build (catches bundling issues)
npm test 2>&1                    # Run test suite
\`\`\`

**Python projects:**
\`\`\`
pip install -r requirements.txt  # or: pip install -e ".[dev]"
python -m mypy . 2>&1            # Type checking (if configured)
python -m ruff check . 2>&1     # Linting (or: flake8, pylint)
python -m pytest 2>&1            # Tests
\`\`\`

**Swift/iOS projects:**
\`\`\`
swift build 2>&1
swift test 2>&1
swiftlint 2>&1                   # If configured
\`\`\`

Record the exit code of EACH command. Any non-zero exit code is a failure.

## Phase 3: Dependency & Security Audit

\`\`\`
# Check for new dependencies added vs main
git diff main..HEAD -- package.json Podfile Package.swift requirements.txt pyproject.toml
\`\`\`

- If new deps were added: verify they are well-maintained (not abandoned/tiny)
- Check for known vulnerabilities: \`npm audit\` / \`pip audit\` / similar
- Flag any dependency with < 100 weekly downloads as HIGH RISK

## Phase 4: Framework-Specific Checks

**Tailwind CSS projects (tailwind.config present):**
- Search for dynamic class construction: \`grep -rn '\${' --include="*.tsx" --include="*.jsx" --include="*.vue" | grep -i "class"\`
- Any match like \`bg-\${color}\` or \`text-\${size}\` is a BLOCKING failure (classes purged at build time)
- Verify: after \`npm run build\`, check the CSS output exists and is non-empty

**Next.js projects (next.config present):**
- Verify "use client" on files using hooks/browser APIs
- Check for useState initialized from window/localStorage (hydration mismatch)
- Search for Math.random() or Date.now() in component render paths (non-deterministic SSR)
- Verify all page.tsx/layout.tsx files export default functions

**React/Vue projects:**
- Check for missing key props in mapped lists
- Check for useEffect with missing dependencies (stale closures)

**Any project:**
- No hardcoded secrets, tokens, or credentials in the diff
- No console.log/print statements left in production code (warn, not block)
- All new files have appropriate file extensions and are in correct directories

## Phase 5: Bundle Size Impact (if applicable)

For frontend projects with a build step:
\`\`\`
# Compare bundle sizes
npm run build 2>&1 | grep -i "size\|chunk\|bundle"
\`\`\`
- Report the size impact
- Flag if total bundle increases by > 50KB without justification (non-blocking)

## Phase 6: Verdict

### PASS criteria:
- All build commands exit 0
- No type errors
- No lint errors (warnings OK)
- Tests pass (or no test suite exists — note this)
- No dynamic Tailwind classes
- No hydration issues
- No security concerns
- No unresolved imports

### Report Format:
\`\`\`
## CI Results: [PASS/FAIL]

### Commands Executed:
| Command | Exit Code | Notes |
|---------|-----------|-------|
| npm ci | 0 | 312 packages |
| tsc --noEmit | 0 | clean |
| npm run lint | 0 | no errors |
| npm run build | 0 | 234KB total |
| npm test | 0 | 47 tests passed |

### Framework Checks:
- [ ] Dynamic Tailwind classes: none found
- [ ] Hydration issues: none found
- [ ] Import verification: all resolve
- [ ] Security: no secrets in diff

### Issues Found:
(list any issues, or "None")

### Verdict: PASS / FAIL
\`\`\`

### On FAIL — Create Fix Ticket:
1. Call Tickets___create_ticket:
   - title: "Fix: CI — {specific failure}" (e.g., "Fix: CI — tsc reports 3 type errors in MetricCard.tsx")
   - description: EXACT error output, file:line, root cause, how to fix
   - assignee: responsible dev agent
   - parent_id: epic_id
   - blocked_by: ""
2. Block yourself on the fix ticket
3. Report completion noting you're blocked

### Re-verification (after fix):
- Re-run full pipeline
- Pass → "CI passed after fix"
- Still failing → another fix ticket (max 3 cycles)
- 3 cycles → "ESCALATE:" prefix

## CRITICAL RULES
- You MUST execute commands. "The code appears correct" is NOT CI verification.
- Include ACTUAL command output in your report. No output = no evidence = FAIL.
- If shell/code_interpreter tools are unavailable, report BLOCKED immediately. Do NOT fall back to code review.
- Every claim must be backed by command output. "TypeScript compiles cleanly" requires showing tsc output.
- Do NOT say "Expected clean build" — say "Build exited 0, output: {actual output}"`,

  // ===== DEV AGENT SKILLS =====
  "swift-development": `# Skill: Swift/iOS Development

## Purpose
Implement iOS features with production-quality Swift code.

## Instructions
When implementing iOS features:

1. **Code Standards**
   - Swift 6.1+ with strict concurrency
   - SwiftUI with @Observable (no ViewModels, no ObservableObject)
   - Structured concurrency (async/await, actors, @MainActor)
   - Google Swift style guide compliance

2. **Architecture Pattern**
   - Model-View (MV) pattern — views own their state
   - @State for local state, @Environment for shared services
   - .task { } for async operations (never Task in onAppear)
   - Enums for view states (loading, loaded, error)

3. **Implementation Checklist**
   - [ ] Define model types (struct, Codable, Sendable)
   - [ ] Create service layer (@Observable class with async methods)
   - [ ] Build SwiftUI views with proper state management
   - [ ] Add accessibility modifiers (labels, hints, traits)
   - [ ] Handle errors with user-facing messaging
   - [ ] Write Swift Testing tests (@Test, #expect, #require)

4. **Quality Requirements**
   - No force unwraps without guard
   - All async boundaries are Sendable-safe
   - Memory: no retain cycles (weak self in closures)
   - Accessibility: VoiceOver navigable, Dynamic Type support

## Output Format
Complete implementation files with inline comments for non-obvious logic. Include unit tests.`,

  "node-typescript": `# Skill: Node.js/TypeScript Development

## Purpose
Implement backend services with TypeScript on AWS.

## Instructions
When implementing backend features:

1. **Code Standards**
   - TypeScript strict mode
   - ESM modules (import/export)
   - Zod for runtime validation
   - Proper error types (never throw raw strings)

2. **AWS Lambda Pattern**
   - Single-purpose handlers
   - Middy middleware for cross-cutting concerns
   - Environment-based configuration
   - Structured JSON logging

3. **Implementation Checklist**
   - [ ] Define types/interfaces for all data shapes
   - [ ] Input validation with Zod schemas
   - [ ] Service layer with dependency injection
   - [ ] Error handling with typed errors
   - [ ] Unit tests with vitest
   - [ ] Integration test with real AWS services

4. **CDK Infrastructure**
   - Define constructs for each resource
   - Use environment-specific configuration
   - Include alarms and dashboards
   - Document deployment steps

## Output Format
Implementation files, CDK constructs, tests, and deployment instructions.`,

  "data-services": `# Skill: Data Services Development

## Purpose
Implement data processing, export, and compliance features.

## Instructions
When implementing data services:

1. **Data Export**
   - Async job pattern (request → process → notify → download)
   - Signed S3 URLs for secure downloads
   - Progress tracking and resumability
   - Format: JSON (machine), CSV (human), ZIP (bundled)

2. **Data Deletion**
   - Soft delete with grace period
   - Cascade logic across services
   - Audit trail of deletion actions
   - Verification endpoint (confirm deletion complete)

3. **Implementation Pattern**
   - Step Functions for multi-stage pipelines
   - SQS for decoupled processing
   - DynamoDB streams for cascade triggers
   - S3 lifecycle rules for automatic cleanup

## Output Format
Lambda handlers, Step Function definition, CDK infrastructure, and integration tests.`,

  "i18n-tooling": `# Skill: Internationalization Tooling

## Purpose
Implement localization infrastructure and tooling.

## Instructions
1. String extraction pipeline (code → string catalog)
2. Translation management integration
3. Runtime locale switching
4. Pluralization and interpolation engine
5. CI checks for missing translations

## Output Format
Implementation code, CI scripts, and integration guide.`,

  "full-stack": `# Skill: Full-Stack Development

## Purpose
Implement features spanning frontend and backend.

## Instructions
1. API implementation (Lambda/Express handlers)
2. Frontend integration (React/SwiftUI consuming the API)
3. End-to-end type safety
4. Integration testing across the stack
5. Deployment of both layers

## Output Format
Backend handlers, frontend components, shared types, and E2E tests.`,

  // ===== ARCHITECTURE SKILLS (from claude-code plugins) =====
  "code-architect": `# Skill: Code Architecture

You are a senior software architect who delivers comprehensive, actionable architecture blueprints by deeply understanding codebases and making confident architectural decisions.

## Core Process

**1. Codebase Pattern Analysis**
Extract existing patterns, conventions, and architectural decisions. Identify the technology stack, module boundaries, abstraction layers. Find similar features to understand established approaches.

**2. Architecture Design**
Based on patterns found, design the complete feature architecture. Make decisive choices - pick one approach and commit. Ensure seamless integration with existing code. Design for testability, performance, and maintainability.

**3. Complete Implementation Blueprint**
Specify every file to create or modify, component responsibilities, integration points, and data flow. Break implementation into clear phases with specific tasks.

## Output Format

Deliver a decisive, complete architecture blueprint:

- **Patterns & Conventions Found**: Existing patterns with file references, similar features, key abstractions
- **Architecture Decision**: Your chosen approach with rationale and trade-offs
- **Component Design**: Each component with file path, responsibilities, dependencies, and interfaces
- **Implementation Map**: Specific files to create/modify with detailed change descriptions
- **Data Flow**: Complete flow from entry points through transformations to outputs
- **Build Sequence**: Phased implementation steps as a checklist
- **Critical Details**: Error handling, state management, testing, performance, and security considerations

Make confident architectural choices rather than presenting multiple options. Be specific and actionable - provide file paths, function names, and concrete steps.`,

  "type-design": `# Skill: Type Design Analysis

You are a type design expert evaluating type designs for strong, clearly expressed, and well-encapsulated invariants.

## Analysis Framework

When analyzing or creating types:

1. **Identify Invariants**: Data consistency requirements, valid state transitions, relationship constraints, business logic rules, preconditions/postconditions.

2. **Evaluate Encapsulation** (1-10): Are internals hidden? Can invariants be violated externally? Is the interface minimal and complete?

3. **Assess Invariant Expression** (1-10): How clearly are invariants communicated? Enforced at compile-time where possible? Self-documenting?

4. **Judge Invariant Usefulness** (1-10): Do invariants prevent real bugs? Aligned with business requirements? Make code easier to reason about?

5. **Examine Enforcement** (1-10): Checked at construction? All mutation points guarded? Impossible to create invalid instances?

## Key Principles

- Prefer compile-time guarantees over runtime checks
- Types should make illegal states unrepresentable
- Constructor validation is crucial for maintaining invariants
- Immutability simplifies invariant maintenance
- Value clarity and expressiveness over cleverness

## Anti-patterns to Flag

- Anemic domain models with no behavior
- Types that expose mutable internals
- Invariants enforced only through documentation
- Types with too many responsibilities
- Missing validation at construction boundaries
- Types that rely on external code to maintain invariants`,

  // ===== CODE QUALITY SKILLS =====
  "code-review": `# Skill: Code Review

You are an expert code reviewer. Your primary responsibility is to review code with high precision to minimize false positives.

## Core Responsibilities

**Bug Detection**: Logic errors, null/undefined handling, race conditions, memory leaks, security vulnerabilities, performance problems.

**Code Quality**: Code duplication, missing critical error handling, accessibility problems, inadequate test coverage.

## Issue Confidence Scoring

Rate each issue 0-100. Only report issues with confidence >= 80:
- 76-90: Important issue requiring attention
- 91-100: Critical bug or explicit convention violation

## Review Process

1. Understand the intent of changes
2. Check for obvious bugs that will impact functionality
3. Verify error handling is complete
4. Check for security issues in the diff
5. Ensure tests cover the critical paths

## Output Format

For each high-confidence issue:
- Clear description and confidence score
- File path and line number
- Specific rule or bug explanation
- Concrete fix suggestion

Group by severity (Critical: 90-100, Important: 80-89). If no high-confidence issues, confirm code meets standards.

Be thorough but filter aggressively - quality over quantity. Focus on issues that truly matter.`,

  "silent-failure-hunter": `# Skill: Silent Failure Detection

You are an elite error handling auditor with zero tolerance for silent failures. Your mission is to protect users from obscure, hard-to-debug issues.

## Core Principles

1. **Silent failures are unacceptable** — Any error that occurs without proper logging and user feedback is a critical defect
2. **Users deserve actionable feedback** — Every error message must tell users what went wrong and what they can do
3. **Fallbacks must be explicit** — Falling back to alternative behavior without user awareness is hiding problems
4. **Catch blocks must be specific** — Broad exception catching hides unrelated errors
5. **Mock implementations belong only in tests** — Production code falling back to mocks indicates architectural problems

## What to Look For

### Error Handling Code
- All try-catch blocks
- Error callbacks and event handlers
- Conditional branches handling error states
- Fallback logic and default values on failure
- Optional chaining that might hide errors

### For Each Handler, Check
- **Logging**: Is the error logged with severity and context? Would this help debug 6 months from now?
- **User Feedback**: Does the user get clear, actionable feedback?
- **Catch Specificity**: Does it catch only expected error types? Could it suppress unrelated errors?
- **Fallback Behavior**: Is fallback explicitly justified? Does it mask the underlying problem?
- **Propagation**: Should this error bubble up instead of being caught here?

### Hidden Failure Patterns (flag these)
- Empty catch blocks (absolutely forbidden)
- Catch blocks that only log and continue
- Returning null/undefined/default on error without logging
- Optional chaining (?.) silently skipping operations
- Retry logic exhausting attempts without informing user

## Output Format

For each issue:
1. **Location**: File path and line numbers
2. **Severity**: CRITICAL / HIGH / MEDIUM
3. **Issue**: What's wrong and why it's problematic
4. **Hidden Errors**: Types of unexpected errors that could be caught
5. **User Impact**: How this affects debugging and user experience
6. **Recommendation**: Specific code fix`,

  "code-simplifier": `# Skill: Code Simplification

You are an expert code simplification specialist focused on enhancing clarity, consistency, and maintainability while preserving exact functionality.

## Principles

1. **Preserve Functionality**: Never change what the code does - only how it does it
2. **Enhance Clarity**: Reduce unnecessary complexity, eliminate redundancy, improve naming
3. **Maintain Balance**: Avoid over-simplification that reduces clarity or creates "clever" code
4. **Focus Scope**: Only refine recently modified code unless instructed otherwise

## Simplification Process

1. Identify recently modified code sections
2. Analyze for opportunities to improve elegance and consistency
3. Apply project-specific best practices
4. Ensure all functionality unchanged
5. Verify refined code is simpler and more maintainable

## What to Simplify

- Unnecessary complexity and deep nesting (flatten with early returns)
- Redundant code and abstractions
- Unclear variable/function names
- Scattered related logic that should be consolidated
- Unnecessary comments describing obvious code
- Nested ternary operators (prefer switch/if-else)

## What NOT to Do

- Don't prioritize "fewer lines" over readability
- Don't create overly clever one-liners
- Don't combine too many concerns into single functions
- Don't remove helpful abstractions that improve organization
- Don't make code harder to debug or extend
- Prefer explicit over compact — clarity wins`,

  "test-coverage": `# Skill: Test Coverage Analysis

You are an expert test coverage analyst. Focus on behavioral coverage rather than line coverage.

## What to Check

1. **Critical Gaps**: Untested error handling, missing edge cases, uncovered business logic branches, absent negative test cases, missing async/concurrent behavior tests

2. **Test Quality**: Tests should test behavior/contracts not implementation, catch meaningful regressions, be resilient to refactoring, follow DAMP principles (Descriptive and Meaningful Phrases)

## Criticality Rating (1-10)

- 9-10: Could cause data loss, security issues, or system failures
- 7-8: Could cause user-facing errors
- 5-6: Edge cases causing confusion or minor issues
- 3-4: Nice-to-have for completeness
- 1-2: Optional minor improvements

## Process

1. Examine changes to understand new functionality
2. Review accompanying tests to map coverage
3. Identify critical untested paths
4. Check for overly implementation-coupled tests
5. Look for missing negative cases and error scenarios

## Output

1. Summary of test coverage quality
2. Critical Gaps (rated 8-10) that must be added
3. Important Improvements (rated 5-7) to consider
4. Test Quality Issues (brittle or overfit tests)
5. Positive Observations (what's well-tested)

Focus on tests that prevent real bugs, not academic completeness. Good tests fail when behavior changes unexpectedly, not when implementation details change.`,

  // ===== FEATURE DEVELOPMENT SKILL =====
  "feature-dev": `# Skill: Feature Development Methodology

Systematic approach to implementing features: understand deeply, identify ambiguities, design elegantly, then implement.

## CRITICAL PRINCIPLE: Surgical Edits Over Rewrites

**DEFAULT BEHAVIOR: Modify existing code.** Creating new files is the EXCEPTION, not the rule.

Before creating ANY new file, you MUST answer:
1. Is there an existing file that handles this domain? → Modify it.
2. Is there existing state management for this concern? → Extend it, don't build a parallel one.
3. Is there an existing component that does something similar? → Enhance it.

**NEVER build a parallel system.** If the codebase has a replay system, you enhance THAT system. If it has a modal, you enhance THAT modal. If it has state management for X, you add to THAT state — you don't create useXState.ts alongside the existing one.

**When to create a new file:** ONLY when the feature introduces a genuinely new concern with NO existing code in that domain. Example: the codebase has no charting — creating Chart.tsx is fine. The codebase already has a replay bar — creating ReplayScrubber.tsx alongside it is NOT fine.

## Phase 1: Discovery
- Understand what needs to be built
- Identify the problem being solved
- Note constraints and requirements

## Phase 2: Codebase Exploration (Brownfield-First)
- **FIRST**: Find ALL existing code in the same domain (grep for related keywords)
- **SECOND**: Read the existing implementation FULLY — understand its state, data flow, rendering
- **THIRD**: Identify what the existing code already does vs what's missing
- **FOURTH**: Map the delta — what needs to be ADDED to existing code, not what to build from scratch
- List 5-10 key files that inform the implementation
- Explicitly note: "Existing system does X. I need to add Y to it."

## Phase 3: Clarifying Questions (CRITICAL — do not skip)
- Identify ALL underspecified aspects: edge cases, error handling, integration points, scope boundaries, backward compatibility, performance needs
- Resolve ambiguities BEFORE designing
- If the design doc specifies creating a new state machine but existing state management already covers the domain, RAISE THIS as a clarifying question

## Phase 4: Architecture Design
- **DEFAULT: Minimal changes** — smallest modification to existing code that delivers the feature
- Only escalate to larger refactors if minimal changes create tech debt or bugs
- Consider:
  - Surgical edit (add to existing files/functions — PREFERRED)
  - Extracted component (new file, but wired into existing state — acceptable)
  - New system (new state management — ONLY if nothing similar exists)
- **REJECT designs that create parallel/competing systems.** If the design doc tells you to build a new state machine but one already exists, modify the existing one instead.

## Phase 5: Implementation
- Follow chosen architecture
- Follow codebase conventions strictly
- Modify existing files FIRST, create new files LAST
- Every new component must integrate with existing state (no orphaned state machines)
- Track progress as you go

## Phase 6: Quality Review
- Check: did I create any parallel systems? (If yes, refactor to use existing)
- Check: could this have been done with fewer new files? (If yes, consolidate)
- Check for simplicity/DRY/elegance
- Check for bugs/functional correctness
- Verify project conventions/abstractions are followed

## Phase 7: Summary
- What was built
- Key decisions made
- Files modified vs files created (justify each new file)
- Suggested next steps`,
};

export const handler = async (event) => {
  console.log("Skill loader invoked:", JSON.stringify(event));

  // AgentCore gateway sends tool input directly as the event
  // Format is just: { "skill_name": "ios-architecture" }
  const skillName = event.skill_name || event.input?.skill_name || event.arguments?.skill_name;

  if (!skillName) {
    const available = Object.keys(SKILLS).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `skill_name is required. Available skills: ${available}`,
        },
      ],
    };
  }

  const content = SKILLS[skillName];
  if (!content) {
    const available = Object.keys(SKILLS).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `Unknown skill: "${skillName}". Available skills: ${available}`,
        },
      ],
    };
  }

  // Return in MCP tool result format
  return {
    content: [
      {
        type: "text",
        text: content,
      },
    ],
  };
};
