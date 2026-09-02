import {
  LayoutDashboard,
  Bot,
  Hammer,
  GitPullRequest,
  History,
  BarChart3,
  Boxes,
  Cloud,
  CalendarClock,
  Plug,
  Rocket,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Module registry.
 *
 * AgentCore Hub is built as a small always-on core plus a set of optional
 * "bolt-on" feature modules. Each navigable surface declares which module it
 * belongs to here, so cherry-picking a module out of a deployment is a
 * single-place edit: delete the entries tagged with that module id (and the
 * matching files / infra listed in docs/MODULES.md) and the rest of the app
 * keeps working.
 *
 * Keep this list in display order — the Sidebar renders it top-to-bottom.
 */
export type ModuleId =
  | "core"
  | "builder"
  | "workflow"
  | "routines"
  | "connectors"
  | "evaluations"
  | "registry"
  | "cloud-code"
  | "pipeline";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Which feature module owns this nav entry. "core" is always present. */
  module: ModuleId;
  /**
   * When set, the nav entry is only rendered if this env var is truthy
   * ("1"/"true"). Used by bolt-on modules whose backing infra is optional and
   * deployed out-of-band — with the flag unset the surface is hidden and the
   * app behaves as if the module were removed. Only NEXT_PUBLIC_* vars are
   * readable client-side, so gated modules must use that prefix.
   */
  enabledBy?: string;
}

const RAW_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, module: "core" },
  { href: "/agents", label: "Agents", icon: Bot, module: "core" },
  { href: "/registry", label: "Registry", icon: Boxes, module: "registry" },
  { href: "/build", label: "Build", icon: Hammer, module: "builder" },
  { href: "/workflow", label: "Workflow", icon: GitPullRequest, module: "workflow" },
  { href: "/routines", label: "Routines", icon: CalendarClock, module: "routines" },
  { href: "/connectors", label: "Connectors", icon: Plug, module: "connectors" },
  { href: "/cloud-code", label: "Cloud Code", icon: Cloud, module: "cloud-code" },
  { href: "/evaluations", label: "Evaluations", icon: BarChart3, module: "evaluations" },
  // CI/CD Pipeline (bolt-on). Hidden unless NEXT_PUBLIC_PIPELINE_ENABLED is set,
  // because its backing infra (deploy/pipeline CDK stack) is deployed
  // out-of-band and entirely optional. See docs/cicd-pipeline-module-design.md.
  { href: "/pipeline", label: "Pipeline", icon: Rocket, module: "pipeline", enabledBy: "NEXT_PUBLIC_PIPELINE_ENABLED" },
  { href: "/tickets", label: "Ticket History", icon: History, module: "workflow" },
];

// TEAM-3739: NEXT_PUBLIC_PIPELINE_ENABLED is forwarded verbatim, so whitespace
// or casing variants ("1 ", " true", "TRUE") must not silently hide the nav
// tab. Mirrors isPipelineEnabled() in src/lib/pipeline/status.ts — kept local
// (not imported) because status.ts pulls in server-only AWS SDK clients.
export function isModuleFlagEnabled(v: string | undefined): boolean {
  const raw = (v ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function moduleEnabled(item: NavItem): boolean {
  if (!item.enabledBy) return true;
  // NEXT_PUBLIC_* are inlined at build time; read them by literal key so Next's
  // static replacement works (dynamic process.env[...] is not inlined).
  const flags: Record<string, string | undefined> = {
    NEXT_PUBLIC_PIPELINE_ENABLED: process.env.NEXT_PUBLIC_PIPELINE_ENABLED,
  };
  return isModuleFlagEnabled(flags[item.enabledBy]);
}

export const NAV_ITEMS: NavItem[] = RAW_NAV_ITEMS.filter(moduleEnabled);

/**
 * Path -> page title lookup used by the Header. Derived from the nav registry
 * plus surfaces that are reachable but not in the sidebar (e.g. /invoke).
 */
export const PAGE_TITLES: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label])),
  "/invoke": "Invoke",
};
