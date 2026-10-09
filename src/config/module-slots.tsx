import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { NAV_ITEMS, type ModuleId, type NavItem } from "./modules";

/**
 * Module slots: the one place a core page reaches an optional module's UI.
 *
 * Core pages render the slot list and never import a module directly; each
 * entry is lazy-loaded and kept only while its module has a nav entry in
 * NAV_ITEMS (src/config/modules.ts). Deleting the module's nav entry hides the
 * slot; removing the module entirely means deleting its entry here too (see
 * docs/MODULES.md), and the core page still compiles.
 */

/** Props every Agent Detail action receives (a subset of the page's AgentDetail). */
export interface AgentDetailActionProps {
  agent: {
    name: string;
    arn: string;
    type: "harness" | "runtime";
    description?: string;
    systemPrompt?: string;
    model?: string;
    tools?: Array<{ type: string; name?: string }>;
  };
  /** Model id resolved from the models registry (runtimes carry none in detail). */
  modelId?: string;
}

export interface ModuleSlot<P> {
  id: string;
  module: ModuleId;
  Component: ComponentType<P>;
}

const RAW_AGENT_DETAIL_ACTIONS: ModuleSlot<AgentDetailActionProps>[] = [
  // TEAM-5452: register the viewed agent as an AgentCore Registry record.
  {
    id: "registry-register-agent",
    module: "registry",
    Component: dynamic(() => import("@/components/registry/RegisterAgentAction"), { ssr: false }),
  },
];

/** Slots whose module is present in `navItems`. Exported for tests. */
export function agentDetailActions(
  navItems: NavItem[],
  slots: ModuleSlot<AgentDetailActionProps>[] = RAW_AGENT_DETAIL_ACTIONS
): ModuleSlot<AgentDetailActionProps>[] {
  const present = new Set(navItems.map((i) => i.module));
  return slots.filter((s) => present.has(s.module));
}

export const AGENT_DETAIL_ACTIONS = agentDetailActions(NAV_ITEMS);
