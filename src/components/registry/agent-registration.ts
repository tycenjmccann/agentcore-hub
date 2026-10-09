// Maps a discovered AgentCore agent (harness or runtime) onto a Registry record
// draft, and detects whether an agent is already registered.
//
// Pure module: no React, no AWS SDK, no fetch. Everything about the agent's
// location (region, account) is derived from its ARN; nothing is hardcoded.

import { buildDescriptors } from "./descriptors";
import type { DescriptorType, RegistryRecord } from "./types";

export interface AgentForRegistration {
  name: string;
  arn: string;
  type: "harness" | "runtime";
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: Array<{ type: string; name?: string }>;
}

export type AgentDescriptorType = Extract<DescriptorType, "CUSTOM" | "A2A">;

export const AGENT_DESCRIPTOR_TYPES: AgentDescriptorType[] = ["CUSTOM", "A2A"];

// Agent card schema version the registry accepts (see scripts/seed-registry.sh).
export const A2A_SCHEMA_VERSION = "0.3";

// Records in these states do not count as "this agent is registered".
export const NOT_REGISTERED_STATUSES: readonly string[] = [
  "REJECTED",
  "CREATE_FAILED",
  "DEPRECATED",
];

const SOURCE = "agentcore-hub";
const RECORD_VERSION = "1.0.0";
const DESCRIPTION_MAX = 200;

// CUSTOM for both: neither harnesses nor runtimes speak A2A by default.
export function defaultDescriptorType(
  _agent: Pick<AgentForRegistration, "type">
): AgentDescriptorType {
  return "CUSTOM";
}

// arn:partition:service:REGION:account:resource
export function regionFromArn(arn: string): string | undefined {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  return parts[3] || undefined;
}

// Data-plane invocation URL for the agent. The runtime path matches the
// InvokeAgentRuntime REST shape; the harness path is best-effort and the user
// can edit the card before submitting. Without a region in the ARN we fall back
// to the region-less host rather than guessing one.
export function a2aInvocationUrl(agent: Pick<AgentForRegistration, "arn" | "type">): string {
  const region = regionFromArn(agent.arn);
  const host = region
    ? `https://bedrock-agentcore.${region}.amazonaws.com`
    : "https://bedrock-agentcore.amazonaws.com";
  const collection = agent.type === "harness" ? "harnesses" : "runtimes";
  return `${host}/${collection}/${encodeURIComponent(agent.arn)}/invocations`;
}

function firstSentence(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  const sentence = m ? m[1] : line;
  return sentence.length > DESCRIPTION_MAX
    ? sentence.slice(0, DESCRIPTION_MAX - 1).trimEnd() + "…"
    : sentence;
}

// description -> first sentence of the system prompt -> generic label.
export function agentDescription(
  agent: Pick<AgentForRegistration, "name" | "type" | "description" | "systemPrompt">
): string {
  const d = agent.description?.trim();
  if (d) return d;
  const s = agent.systemPrompt ? firstSentence(agent.systemPrompt) : "";
  if (s) return s;
  return `${agent.type} agent ${agent.name}`;
}

function toolNames(agent: AgentForRegistration): string[] {
  return (agent.tools ?? []).map((t) => t.name || t.type).filter(Boolean);
}

function slug(s: string, fallback: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || fallback;
}

export function agentRawContent(
  agent: AgentForRegistration,
  type: AgentDescriptorType,
  opts?: { modelId?: string }
): string {
  const description = agentDescription(agent);
  const model = agent.model ?? opts?.modelId;
  const provenance: Record<string, unknown> = {
    source: SOURCE,
    agentType: agent.type,
    agentArn: agent.arn,
  };
  if (model) provenance.model = model;

  if (type === "CUSTOM") {
    return JSON.stringify(
      {
        name: agent.name,
        description,
        data: { ...provenance, tools: toolNames(agent) },
      },
      null,
      2
    );
  }

  const tools = agent.tools ?? [];
  const seen = new Set<string>();
  const skills = tools.length
    ? tools.map((t, i) => {
        const name = t.name || t.type;
        let id = slug(name, `skill-${i + 1}`);
        if (seen.has(id)) id = `${id}-${i + 1}`;
        seen.add(id);
        return { id, name, description: "", tags: [t.type] };
      })
    : [{ id: "invoke", name: "Invoke", description, tags: [agent.type] }];

  return JSON.stringify(
    {
      name: agent.name,
      description,
      version: RECORD_VERSION,
      protocolVersion: "0.3.0",
      url: a2aInvocationUrl(agent),
      capabilities: {},
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["application/json"],
      skills,
      metadata: provenance,
    },
    null,
    2
  );
}

export interface RecordDraft {
  name: string;
  description: string;
  recordVersion: string;
  descriptorType: AgentDescriptorType;
  raw: string;
}

export function agentToRecordDraft(
  agent: AgentForRegistration,
  type: AgentDescriptorType,
  opts?: { modelId?: string }
): RecordDraft {
  return {
    name: agent.name,
    description: agentDescription(agent),
    recordVersion: RECORD_VERSION,
    descriptorType: type,
    raw: agentRawContent(agent, type, opts),
  };
}

// buildDescriptors, plus the A2A agent-card schemaVersion the service expects
// (same as scripts/seed-registry.sh).
export function agentDescriptors(type: DescriptorType, raw: string): Record<string, unknown> {
  const d = buildDescriptors(type, raw);
  if (type === "A2A") {
    const card = (d.a2a as { agentCard: Record<string, unknown> }).agentCard;
    card.schemaVersion = A2A_SCHEMA_VERSION;
  }
  return d;
}

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Inverse of buildDescriptors: the inline content string, if present.
export function extractInlineRaw(type: DescriptorType, descriptors: unknown): string | undefined {
  const paths: Record<DescriptorType, string[]> = {
    CUSTOM: ["custom", "inlineContent"],
    A2A: ["a2a", "agentCard", "inlineContent"],
    MCP: ["mcp", "server", "inlineContent"],
    AGENT_SKILLS: ["agentSkills", "skillMd", "inlineContent"],
  };
  const v = pick(descriptors, paths[type]);
  return typeof v === "string" ? v : undefined;
}

export interface RegistrationCandidate {
  registryId: string;
  record: RegistryRecord;
  raw?: string;
}

export interface RegistrationMatch {
  registryId: string;
  record: RegistryRecord;
  matchedBy: "arn" | "name";
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// True when any string leaf of the JSON raw is the ARN, or a URL containing it
// as a whole path segment (so a different ARN sharing a prefix never matches).
export function rawReferencesArn(raw: string, arn: string): boolean {
  if (!arn) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const visit = (v: unknown): boolean => {
    if (typeof v === "string") {
      if (v === arn) return true;
      const decoded = safeDecode(v);
      return decoded.includes(`/${arn}/`) || decoded.endsWith(`/${arn}`);
    }
    if (Array.isArray(v)) return v.some(visit);
    if (v && typeof v === "object") return Object.values(v).some(visit);
    return false;
  };
  return visit(parsed);
}

// ARN match anywhere beats a name match; failed/retired records are ignored.
export function findRegisteredRecord(
  agent: Pick<AgentForRegistration, "name" | "arn">,
  candidates: RegistrationCandidate[]
): RegistrationMatch | null {
  const live = candidates.filter((c) => !NOT_REGISTERED_STATUSES.includes(c.record.status));
  if (agent.arn) {
    const byArn = live.find((c) => c.raw !== undefined && rawReferencesArn(c.raw, agent.arn));
    if (byArn) return { registryId: byArn.registryId, record: byArn.record, matchedBy: "arn" };
  }
  const byName = live.find((c) => c.record.name === agent.name);
  if (byName) return { registryId: byName.registryId, record: byName.record, matchedBy: "name" };
  return null;
}
