/**
 * Pipeline Configuration
 *
 * This file defines HOW to DISPLAY the pipeline — purely visual/UI concerns.
 * Agent data (who exists, what tools they have, what skills they load) comes from
 * agents.json (single source of truth). Per-phase skill lists, models, and
 * evaluations-enabled flags are derived by aggregating across the agents in each phase.
 *
 * To customize for your environment:
 * 1. Deploy your AgentCore agents
 * 2. Update src/config/agents.json (agentId, tools, skills, blueprints)
 * 3. Update TOOL_ICON_MAP below if you add custom gateway tools
 * 4. Update PHASE_DISPLAY_META if you change phase identity / config / outputs labels
 */

import agentsConfig from "@/config/agents.json";

// ─── Tool → Icon Mapping ────────────────────────────────────────────────────
// Derived from agents.json tool arrays. Maps tool names to icon categories.
//
// TOOL_CATEGORIES: prefix or exact name → { icon, labelPrefix }
// The full TOOL_ICON_MAP is built by scanning all tools declared in agents.json.

// Tool categories: maps tool name patterns to icon + display label.
// `cardLabel` is what shows on the phase card. Tools sharing an icon are one card.
// `hidden` tools contribute to flash matching but don't generate a card.
const TOOL_CATEGORIES: Array<{ match: string; icon: string; cardLabel: string; hidden?: boolean }> = [
  { match: "S3Storage___",          icon: "s3",        cardLabel: "S3 Storage" },
  { match: "SkillLoader___",        icon: "skill",     cardLabel: "Skills", hidden: true }, // shown in Skills section
  { match: "Tickets___",            icon: "jira",      cardLabel: "Jira" },
  { match: "WorkflowOutput___",     icon: "agentcore", cardLabel: "AgentCore (Strands)" },
  { match: "get_file_contents",     icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "create_or_update_file", icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "create_branch",         icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "create_pull_request",   icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "search_code",           icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "push_files",            icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "list_commits",          icon: "github",    cardLabel: "GitHub (MCP)" },
  { match: "code_interpreter",      icon: "agentcore", cardLabel: "AgentCore (Strands)" },
  { match: "browser",               icon: "agentcore", cardLabel: "AgentCore (Strands)" },
  { match: "gateway",               icon: "agentcore", cardLabel: "AgentCore (Strands)" },
  { match: "claude_code",           icon: "claude",    cardLabel: "Claude Code" },
  { match: "invoke_team_agent",     icon: "agentcore", cardLabel: "AgentCore (Strands)" },
];

function categorize(toolName: string): { icon: string; cardLabel: string; hidden?: boolean } {
  for (const cat of TOOL_CATEGORIES) {
    if (cat.match.includes("___")) {
      if (toolName.startsWith(cat.match)) {
        return { icon: cat.icon, cardLabel: cat.cardLabel, hidden: cat.hidden };
      }
    } else {
      if (toolName === cat.match) {
        return { icon: cat.icon, cardLabel: cat.cardLabel, hidden: cat.hidden };
      }
    }
  }
  // Default: any unrecognized tool → Strands built-in
  return { icon: "agentcore", cardLabel: "AgentCore (Strands)" };
}

// Build the map from all tools declared across agents in agents.json
export const TOOL_ICON_MAP: Record<string, { icon: string; label: string }> = Object.fromEntries(
  [...new Set(agentsConfig.agents.flatMap((a) => a.tools))].map((tool) => {
    const cat = categorize(tool);
    return [tool, { icon: cat.icon, label: cat.cardLabel }];
  })
);

// ─── Phase Display Order ────────────────────────────────────────────────────
// Defines the left-to-right ordering of phases in the visualization.

export type PipelinePhaseId = "intake" | "requirements" | "design" | "development" | "qa";

export const PHASE_DISPLAY_ORDER: PipelinePhaseId[] = [
  "intake",
  "requirements",
  "design",
  "development",
  "qa",
];

// ─── Phase Display Metadata ─────────────────────────────────────────────────
// Per-phase UI metadata: how to render each phase visually.
// Agent lists are NOT here — they are derived from agents.json.

export interface PipelineIdentityItem {
  icon: string;
  label: string;
}

export interface PipelineConfigItem {
  key: string;
  val: string;
}

export interface PipelineDisplayItem {
  icon?: string;
  dot?: "skill" | "ext";
  label: string;
}

interface PhaseDisplayMeta {
  name: string;
  type: "app" | "agent";
  /** Maps phase ID to the agentPhase key used in workflow state */
  agentPhase: string;
  identity: PipelineIdentityItem[];
  config: PipelineConfigItem[];
  tools: PipelineDisplayItem[];
  outputs: PipelineDisplayItem[];
}

export const PHASE_DISPLAY_META: Record<PipelinePhaseId, PhaseDisplayMeta> = {
  intake: {
    name: "Intake",
    type: "app",
    agentPhase: "intake",
    identity: [{ icon: "", label: "Next.js 14 / App Router" }],
    config: [
      { key: "Host", val: "localhost:3000" },
      { key: "Storage", val: "S3 multipart upload" },
      { key: "Trigger", val: "EventBridge on epic create" },
    ],
    tools: [
      { dot: "ext", label: "Upload PRD / Mockup / Figma" },
      { dot: "ext", label: "Set Target Git Repo" },
      { icon: "s3", label: "S3 Artifact Storage" },
    ],
    outputs: [{ icon: "eventbridge", label: "Jira Epic Created (EventBridge)" }],
  },
  requirements: {
    name: "Requirements",
    type: "agent",
    agentPhase: "requirements",
    identity: [
      { icon: "agentcore", label: "AgentCore Runtime" },
      { icon: "bedrock", label: "Claude Opus 4 (via Bedrock)" },
    ],
    config: [
      { key: "Model", val: "us.anthropic.claude-opus-4-0-v1" },
      { key: "Max turns", val: "50" },
      { key: "Timeout", val: "15 min" },
    ],
    tools: [
      { icon: "agentcore", label: "AgentCore (Strands)" },
      { icon: "s3", label: "S3 Storage" },
      { icon: "jira", label: "Jira" },
      { icon: "github", label: "GitHub (MCP)" },
      { icon: "claude", label: "Claude Code" },
    ],
    outputs: [
      { icon: "s3", label: "S3 Artifacts" },
      { icon: "agentcore", label: "report_completion" },
    ],
  },
  design: {
    name: "Design",
    type: "agent",
    agentPhase: "design",
    identity: [
      { icon: "agentcore", label: "AgentCore Runtime (x8 parallel)" },
      { icon: "bedrock", label: "Claude Opus 4 / Sonnet 4" },
    ],
    config: [
      { key: "Dispatch", val: "parallel fan-out, 8 runtimes" },
      { key: "Branch", val: "feature/{ticket}-{role}" },
    ],
    tools: [
      { icon: "agentcore", label: "AgentCore (Strands)" },
      { icon: "s3", label: "S3 Storage" },
      { icon: "github", label: "GitHub (MCP)" },
      { icon: "claude", label: "Claude Code" },
    ],
    outputs: [
      { icon: "s3", label: "S3 Artifacts" },
      { icon: "agentcore", label: "save_design_doc" },
    ],
  },
  development: {
    name: "Development",
    type: "agent",
    agentPhase: "development",
    identity: [
      { icon: "agentcore", label: "AgentCore Runtime (x3 parallel)" },
      { icon: "bedrock", label: "Claude Opus 4 / Sonnet 4" },
    ],
    config: [
      { key: "Dispatch", val: "parallel fan-out, 3 runtimes" },
      { key: "Branch", val: "feature/{ticket}-{role}" },
    ],
    tools: [
      { icon: "agentcore", label: "AgentCore (Strands)" },
      { icon: "s3", label: "S3 Storage" },
      { icon: "github", label: "GitHub (MCP)" },
      { icon: "claude", label: "Claude Code" },
    ],
    outputs: [
      { icon: "s3", label: "S3 Artifacts" },
      { icon: "github", label: "Git Commits / PRs" },
      { icon: "agentcore", label: "report_completion" },
    ],
  },
  qa: {
    name: "QA & Ship",
    type: "agent",
    agentPhase: "verification",
    identity: [
      { icon: "agentcore", label: "AgentCore Runtime (x2 parallel)" },
      { icon: "bedrock", label: "Claude Opus 4 / Sonnet 4" },
    ],
    config: [
      { key: "Dispatch", val: "sequential then parallel" },
      { key: "Retry", val: "3x fix cycles before escalation" },
    ],
    tools: [
      { icon: "agentcore", label: "AgentCore (Strands)" },
      { icon: "s3", label: "S3 Storage" },
      { icon: "jira", label: "Jira" },
      { icon: "github", label: "GitHub (MCP)" },
      { icon: "claude", label: "Claude Code" },
    ],
    outputs: [
      { icon: "s3", label: "S3 Artifacts" },
      { icon: "agentcore", label: "report_completion" },
    ],
  },
};

// ─── Agent Config Interface ─────────────────────────────────────────────────

export interface PipelineAgentConfig {
  /** Agent ID — must match agents.json agentId and WorkflowState.agentTasks keys */
  agentId: string;
  /** Display name shown in pipeline */
  displayName: string;
  /** Agent type: "runtime" (AgentCore Runtime) or "harness" (AgentCore Harness) */
  type: "runtime" | "harness";
  /** Model used by this agent (e.g. "Claude Opus 4.6") */
  model: string;
  /** Whether evaluations are enabled for this agent */
  evaluationsEnabled: boolean;
  /** Tools this agent has access to (used to determine which icons to flash) */
  tools: string[];
  /** Claude Code skill slugs loaded for this agent */
  skills: string[];
}

// ─── Pipeline Phase Config (derived) ────────────────────────────────────────

export interface PipelinePhaseConfig {
  id: PipelinePhaseId;
  name: string;
  num: number;
  type: "app" | "agent";
  typeLabel: string;
  agentPhase: string;
  identity: PipelineIdentityItem[];
  config: PipelineConfigItem[];
  tools: PipelineDisplayItem[];
  agents: PipelineAgentConfig[];
  skills: string[];
  outputs: PipelineDisplayItem[];
  models: string[];
  evaluationsEnabled: boolean;
  runtimeAgentCount: number;
  harnessAgentCount: number;
}

// ─── Phase-to-agentPhase mapping ────────────────────────────────────────────
// Maps agents.json phase values to pipeline phase IDs.
// agents.json uses "verification" and "review" for QA agents.

const AGENT_PHASE_TO_PIPELINE_PHASE: Record<string, PipelinePhaseId> = {
  requirements: "requirements",
  design: "design",
  development: "development",
  verification: "qa",
  review: "qa",
};

// ─── Helper: Phase-level counts ─────────────────────────────────────────────

const EXCLUDED_TOOLS = new Set(["gateway", "browser", "invoke_team_agent"]);

/** Count unique tools for a phase, excluding "gateway", "browser", "invoke_team_agent" */
export function getPhaseToolCount(phaseId: PipelinePhaseId): number {
  const tools = new Set<string>();
  for (const agent of agentsConfig.agents) {
    const mappedPhase = AGENT_PHASE_TO_PIPELINE_PHASE[agent.phase];
    if (mappedPhase === phaseId) {
      for (const tool of agent.tools) {
        if (!EXCLUDED_TOOLS.has(tool)) {
          tools.add(tool);
        }
      }
    }
  }
  return tools.size;
}

/** Count runtime agents (total agents in this phase) */
export function getPhaseRuntimeAgentCount(phaseId: PipelinePhaseId): number {
  return agentsConfig.agents.filter((a) => {
    const mappedPhase = AGENT_PHASE_TO_PIPELINE_PHASE[a.phase];
    return mappedPhase === phaseId;
  }).length;
}

/** Count harness agents (agents with type === "harness") */
export function getPhaseHarnessAgentCount(phaseId: PipelinePhaseId): number {
  return agentsConfig.agents.filter((a) => {
    const mappedPhase = AGENT_PHASE_TO_PIPELINE_PHASE[a.phase];
    return mappedPhase === phaseId && a.type === "harness";
  }).length;
}

// ─── Derive PIPELINE_PHASES from agents.json + display metadata ─────────────

/** Convert a kebab-case skill slug into a Title Case display label. */
const SKILL_ACRONYMS = new Set(["api", "aws", "ci", "cd", "hig", "i18n", "qa", "ux", "ui"]);

function humanizeSkillSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => {
      if (part.length === 0) return part;
      if (SKILL_ACRONYMS.has(part)) return part === "i18n" ? "i18n" : part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function buildPipelinePhases(): PipelinePhaseConfig[] {
  return PHASE_DISPLAY_ORDER.map((phaseId, idx) => {
    const meta = PHASE_DISPLAY_META[phaseId];

    // Derive agents for this phase from agents.json
    const agents: PipelineAgentConfig[] = agentsConfig.agents
      .filter((a) => {
        const mappedPhase = AGENT_PHASE_TO_PIPELINE_PHASE[a.phase];
        return mappedPhase === phaseId;
      })
      .map((a) => ({
        agentId: a.agentId,
        displayName: a.displayName,
        type: (a.type || "runtime") as "runtime" | "harness",
        model: a.model || "",
        evaluationsEnabled: a.evaluationsEnabled ?? false,
        tools: a.tools.filter((t) => t !== "invoke_team_agent"),
        skills: a.skills ?? [],
      }));

    // Generate typeLabel dynamically
    let typeLabel: string;
    if (meta.type === "app") {
      typeLabel = "Web Application";
    } else {
      const runtimeCount = agents.filter((a) => a.type === "runtime").length;
      const harnessCount = agents.filter((a) => a.type === "harness").length;
      const parts: string[] = [];
      if (runtimeCount > 0) parts.push(`${runtimeCount} Runtime Agent${runtimeCount !== 1 ? "s" : ""}`);
      if (harnessCount > 0) parts.push(`${harnessCount} Harness Agent${harnessCount !== 1 ? "s" : ""}`);
      typeLabel = parts.join(" + ") || `${agents.length} Agents`;
    }

    // Derive tool cards from agents' declared tools + TOOL_CATEGORIES config
    const phaseTools: PipelineDisplayItem[] = meta.type === "app"
      ? meta.tools
      : (() => {
          const seen = new Set<string>();
          const items: PipelineDisplayItem[] = [];
          for (const agent of agents) {
            for (const toolName of agent.tools) {
              const cat = categorize(toolName);
              if (cat.hidden || seen.has(cat.icon)) continue;
              seen.add(cat.icon);
              items.push({ icon: cat.icon, label: cat.cardLabel });
            }
          }
          return items;
        })();

    // Derive skills from union of agent.skills, deduped, humanized for display
    const skillSlugs = [...new Set(agents.flatMap((a) => a.skills))];
    const phaseSkills = skillSlugs.map(humanizeSkillSlug);

    return {
      id: phaseId,
      name: meta.name,
      num: idx + 1,
      type: meta.type,
      typeLabel,
      agentPhase: meta.agentPhase,
      identity: meta.identity,
      config: meta.config,
      tools: phaseTools,
      agents,
      skills: phaseSkills,
      outputs: meta.outputs,
      models: [...new Set(agents.map((a) => a.model).filter(Boolean))],
      evaluationsEnabled: agents.some((a) => a.evaluationsEnabled),
      runtimeAgentCount: agents.filter((a) => a.type === "runtime").length,
      harnessAgentCount: agents.filter((a) => a.type === "harness").length,
    };
  });
}

export const PIPELINE_PHASES: PipelinePhaseConfig[] = buildPipelinePhases();

// ─── Helper: Resolve tool name to icon ──────────────────────────────────────

/**
 * Given a tool name from a tool_use event, resolve which icon category it maps to.
 * Returns the icon key (for aws-icons.json) or "skill"/"ext" for dot indicators.
 */
export function resolveToolIcon(toolName: string): { icon: string; label: string } | null {
  if (!toolName) return null;

  // Direct match from derived map
  if (TOOL_ICON_MAP[toolName]) {
    return TOOL_ICON_MAP[toolName];
  }

  // Dynamic categorization for tool names not in agents.json
  // (e.g., runtime reports "load_blueprint" instead of "SkillLoader___load_skill")
  const cat = categorize(toolName);
  return { icon: cat.icon, label: cat.cardLabel };
}

// ─── Helper: Find which phase an agent belongs to ───────────────────────────

export function findAgentPhase(agentId: string): PipelinePhaseConfig | undefined {
  return PIPELINE_PHASES.find((phase) =>
    phase.agents.some((a) => a.agentId === agentId)
  );
}

// ─── Helper: Get all agent IDs from config ──────────────────────────────────

export function getAllAgentIds(): string[] {
  return PIPELINE_PHASES.flatMap((phase) => phase.agents.map((a) => a.agentId));
}
