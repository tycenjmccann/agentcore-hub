// Helpers for building, templating, and (best-effort) parsing the descriptors
// payload that CreateRegistryRecord / UpdateRegistryRecord expect.
//
// The control-plane API wants a union keyed by the lowercased descriptorType,
// where the actual content lives in an `inlineContent` field as a JSON string
// (or markdown string for AGENT_SKILLS skillMd). We assemble that shape from
// either a raw textarea or simple structured form fields.

import type { DescriptorType } from "./types";

// ─── Per-type raw templates (the textarea pre-fill) ─────────────────────────

export function rawTemplate(type: DescriptorType): string {
  switch (type) {
    case "MCP":
      return JSON.stringify(
        {
          name: "my-mcp-server",
          description: "An MCP server.",
          version: "1.0.0",
          transport: { type: "streamable-http", url: "https://example.com/mcp" },
        },
        null,
        2
      );
    case "A2A":
      return JSON.stringify(
        {
          name: "my-agent",
          description: "An A2A agent.",
          version: "1.0.0",
          url: "https://example.com/a2a",
          skills: [{ id: "skill-1", name: "Example skill", description: "" }],
        },
        null,
        2
      );
    case "CUSTOM":
      return JSON.stringify(
        { name: "my-resource", description: "A custom registry resource.", data: {} },
        null,
        2
      );
    case "AGENT_SKILLS":
      return `# My Agent Skill

A short description of what this skill does and when to use it.

## Instructions

1. Step one.
2. Step two.
`;
  }
}

// ─── Form field shapes (mode B) ─────────────────────────────────────────────

export interface McpForm {
  name: string;
  description: string;
  version: string;
}
export interface A2aForm {
  name: string;
  description: string;
  version: string;
  skills: string; // comma-separated skill names
}
export interface CustomForm {
  name: string;
  description: string;
  dataJson: string;
}
export interface SkillsForm {
  markdown: string;
  definitionJson: string; // optional skill definition JSON
}

export function emptyMcpForm(): McpForm {
  return { name: "", description: "", version: "1.0.0" };
}
export function emptyA2aForm(): A2aForm {
  return { name: "", description: "", version: "1.0.0", skills: "" };
}
export function emptyCustomForm(): CustomForm {
  return { name: "", description: "", dataJson: "{}" };
}

// ─── Form -> raw inlineContent string ───────────────────────────────────────

export function mcpFormToRaw(f: McpForm): string {
  return JSON.stringify(
    { name: f.name, description: f.description, version: f.version },
    null,
    2
  );
}
export function a2aFormToRaw(f: A2aForm): string {
  const skills = f.skills
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name, i) => ({ id: `skill-${i + 1}`, name, description: "" }));
  return JSON.stringify(
    { name: f.name, description: f.description, version: f.version, skills },
    null,
    2
  );
}
export function customFormToRaw(f: CustomForm): string {
  let data: unknown = {};
  try {
    data = f.dataJson.trim() ? JSON.parse(f.dataJson) : {};
  } catch {
    /* keep empty on parse failure; caller validates */
  }
  return JSON.stringify({ name: f.name, description: f.description, data }, null, 2);
}

// ─── Raw -> form (best effort) ──────────────────────────────────────────────

export function rawToMcpForm(raw: string): McpForm {
  const f = emptyMcpForm();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.name === "string") f.name = o.name;
    if (typeof o.description === "string") f.description = o.description;
    if (typeof o.version === "string") f.version = o.version;
  } catch {
    /* leave defaults */
  }
  return f;
}
export function rawToA2aForm(raw: string): A2aForm {
  const f = emptyA2aForm();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.name === "string") f.name = o.name;
    if (typeof o.description === "string") f.description = o.description;
    if (typeof o.version === "string") f.version = o.version;
    if (Array.isArray(o.skills)) {
      f.skills = (o.skills as Array<Record<string, unknown>>)
        .map((s) => (typeof s?.name === "string" ? s.name : ""))
        .filter(Boolean)
        .join(", ");
    }
  } catch {
    /* leave defaults */
  }
  return f;
}
export function rawToCustomForm(raw: string): CustomForm {
  const f = emptyCustomForm();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.name === "string") f.name = o.name;
    if (typeof o.description === "string") f.description = o.description;
    if (o.data !== undefined) f.dataJson = JSON.stringify(o.data, null, 2);
  } catch {
    /* leave defaults */
  }
  return f;
}

// ─── Build the API `descriptors` union from a raw inlineContent string ──────

export function buildDescriptors(
  type: DescriptorType,
  raw: string,
  skillsDefinitionJson?: string
): Record<string, unknown> {
  switch (type) {
    case "MCP":
      return { mcp: { server: { inlineContent: raw } } };
    case "A2A":
      return { a2a: { agentCard: { inlineContent: raw } } };
    case "CUSTOM":
      return { custom: { inlineContent: raw } };
    case "AGENT_SKILLS": {
      const agentSkills: Record<string, unknown> = {
        skillMd: { inlineContent: raw },
      };
      if (skillsDefinitionJson && skillsDefinitionJson.trim()) {
        agentSkills.skillDefinition = { inlineContent: skillsDefinitionJson };
      }
      return { agentSkills };
    }
  }
}

// Validate the raw payload for a given type. AGENT_SKILLS markdown is free-form;
// everything else must be valid JSON. Returns an error string or null.
export function validateRaw(type: DescriptorType, raw: string): string | null {
  if (type === "AGENT_SKILLS") {
    return raw.trim() ? null : "Skill markdown cannot be empty.";
  }
  if (!raw.trim()) return "Descriptor content cannot be empty.";
  try {
    JSON.parse(raw);
    return null;
  } catch (e) {
    return `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`;
  }
}
