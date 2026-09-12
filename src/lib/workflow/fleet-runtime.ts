/**
 * Which deployed runtime a persona actually rides, in any fleet topology
 * (TEAM-4498 review fix).
 *
 * `WORKFLOW_RUNTIME_COUNT` is 1, 4 or 14 (`deploy/runtime-agent/deploy-topology.sh`)
 * and the deployed runtime NAMES differ in each mode:
 *
 *   14 → one runtime per persona, named after it (`deploy-fleet.sh` AGENTS list)
 *    4 → four phase anchors: agentcore_hub_requirements | _design | _development | _qaci
 *    1 → a single host named agentcore_hub_agent
 *
 * `agentcore_hub_agent` therefore exists ONLY in 1-runtime mode, and 14 is the
 * default — so resolving the fleet by that one name finds nothing on a normal
 * deployment. This module mirrors `arn_for()` in deploy-topology.sh (including
 * its "unknown phase → requirements anchor" fallback) and returns the candidate
 * names newest-topology-first, so one ordered lookup covers all three modes.
 *
 * Workflow-module local on purpose: core has no need for it, and the
 * module-removal build must stay a one-directory delete.
 */

import agentsConfig from "@/config/agents.json";
import { discoverAgents } from "@/lib/agentcore-sdk";

/** The single-host name — only deployed when WORKFLOW_RUNTIME_COUNT=1. */
export const FLEET_HOST_RUNTIME = "agentcore_hub_agent";

/** 4-runtime mode: phase → anchor. Mirrors arn_for() in deploy-topology.sh. */
const PHASE_ANCHOR: Record<string, string> = {
  requirements: "agentcore_hub_requirements",
  design: "agentcore_hub_design",
  development: "agentcore_hub_development",
  verification: "agentcore_hub_qaci",
  review: "agentcore_hub_qaci",
};

/** deploy-topology.sh sends every unrecognised phase to the requirements anchor. */
const DEFAULT_ANCHOR = "agentcore_hub_requirements";

/**
 * Runtime names that could be hosting this persona, most-specific first:
 * its own runtime (14-mode), its phase anchor (4-mode), the single host (1-mode).
 */
export function fleetRuntimeNames(agentId: string): string[] {
  const phase = agentsConfig.agents.find(a => a.agentId === agentId)?.phase;
  const anchor = (phase && PHASE_ANCHOR[phase]) || DEFAULT_ANCHOR;
  // Deduped, because in 4-mode a persona named like its anchor would repeat.
  return [...new Set([agentId, anchor, FLEET_HOST_RUNTIME])];
}

/** A runtime ARN's name segment: arn:…:runtime/<name>-<suffix> → <name>-<suffix>. */
function runtimeNameFromArn(arn: string): string | null {
  const m = /^arn:aws[\w-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/([\w-]+)$/.exec(arn);
  return m ? m[1] : null;
}

/** Deployed runtimes carry a `-XYZ` suffix the roster name does not. */
function nameMatches(deployed: string, candidate: string): boolean {
  return deployed === candidate || deployed.startsWith(`${candidate}-`);
}

/**
 * Is this ARN one of the runtimes this persona could legitimately run on?
 *
 * The ARN the route invokes is read back out of a DynamoDB event row, so it is
 * checked against the roster rather than trusted. Nothing today lets a client
 * write that row — but this makes "chat can only reach the fleet" a property of
 * this code instead of a property of the current set of event writers.
 */
export function isPersonaRuntimeArn(arn: string | null | undefined, agentId: string): boolean {
  if (!arn) return false;
  const deployed = runtimeNameFromArn(arn);
  if (!deployed) return false;
  return fleetRuntimeNames(agentId).some(c => nameMatches(deployed, c));
}

/**
 * The deployed runtimes that could host this persona, candidate order preserved
 * (own runtime → phase anchor → single host) and absent ones dropped.
 */
async function matchingFleetRuntimes(agentId: string, region: string) {
  const agents = await discoverAgents(region).catch(() => []);
  const runtimes = agents.filter(a => a.type === "runtime");
  return fleetRuntimeNames(agentId)
    .map(candidate => runtimes.find(a => nameMatches(a.name, candidate)))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
}

/**
 * The ARN to invoke this persona on, discovered from the live account.
 * Returns null when no runtime in the fleet matches any candidate name.
 */
export async function resolveFleetRuntimeArn(
  agentId: string,
  region: string
): Promise<string | null> {
  const hits = await matchingFleetRuntimes(agentId, region);
  return hits.find(a => a.arn)?.arn || null;
}

/**
 * Agent ids to try against `/api/agentcore/memory/events` for this persona's
 * history, best candidate first.
 *
 * These are DISCOVERED ids, not roster names, and the difference is the whole
 * point of this function. `findMemoryForAgent` (core) resolves the fleet's single
 * shared memory by `agents.find(a => a.id === agentId)` and then reading the
 * runtime's `MEMORY_ID` env var — and a discovered runtime's `id` is its
 * `agentRuntimeId` (`agentcore_hub_qaci-a1B2c3D4e5`), while its `name` is the
 * bare `agentcore_hub_qaci` (`discoverAgents`: `id: r.agentRuntimeId`,
 * `name: r.agentRuntimeName`). Handing core a bare name matches no agent, and the
 * name-based fallbacks then look for `<name>_mem*` while the fleet's memory is
 * `agentcore_hub_fleet_memory-<suffix>` — so every candidate resolved to null and
 * history came back empty in ALL topologies, 14-runtime included.
 *
 * Resolution stays in core; only the name → id step lives here, because only this
 * module knows which runtimes a persona can ride. Empty when discovery fails or
 * the fleet is not deployed: the caller then falls back to the bare agentId,
 * which is exactly the (harmless) no-history path.
 */
export async function resolveFleetMemoryAgentIds(
  agentId: string,
  region: string
): Promise<string[]> {
  const hits = await matchingFleetRuntimes(agentId, region);
  return [...new Set(hits.map(a => a.id).filter(Boolean))];
}
