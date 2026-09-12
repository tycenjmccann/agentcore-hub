/**
 * Which roster entries are chattable Strands personas (TEAM-4498).
 *
 * Idle persona chat targets the pipeline personas that actually run a ticket on
 * the shared fleet runtime. Three groups are deliberately excluded:
 *  - harness agents (Workflow Manager, Builder, Routine Builder, Personal
 *    Assistant) — each already owns a purpose-built chat surface;
 *  - `phase: "platform"` runtimes — `agentcore_hub_agent` is the fleet *host*
 *    (no persona behind it), `agentcore_hub_coding_runtime` is where the coding
 *    CLIs live (Cloud Code is that surface), and the fleet improver is not a
 *    run participant;
 *  - anything not in agents.json at all — notably the `human:*` gate entries the
 *    board renders as tasks, which are people, not agents.
 *
 * One predicate shared by the route (authorization) and the modal (whether to
 * render the composer) so the two can never disagree about who is chattable.
 */

import agentsConfig from "@/config/agents.json";

const FLEET_HOST_AGENT_ID = "agentcore_hub_agent";

export function isChatablePersona(agentId: string | undefined | null): boolean {
  if (!agentId) return false;
  const agent = agentsConfig.agents.find(a => a.agentId === agentId);
  if (!agent) return false;
  return agent.type === "runtime" && agent.phase !== "platform" && agent.agentId !== FLEET_HOST_AGENT_ID;
}

export function personaDisplayName(agentId: string | undefined | null): string {
  const agent = agentId ? agentsConfig.agents.find(a => a.agentId === agentId) : undefined;
  return agent?.displayName || agentId || "agent";
}
