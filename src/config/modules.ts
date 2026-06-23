import {
  LayoutDashboard,
  Bot,
  Hammer,
  GitPullRequest,
  History,
  BarChart3,
  Boxes,
  Cloud,
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
  | "evaluations"
  | "registry"
  | "cloud-code";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Which feature module owns this nav entry. "core" is always present. */
  module: ModuleId;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, module: "core" },
  { href: "/agents", label: "Agents", icon: Bot, module: "core" },
  { href: "/registry", label: "Registry", icon: Boxes, module: "registry" },
  { href: "/build", label: "Build", icon: Hammer, module: "builder" },
  { href: "/workflow", label: "Workflow", icon: GitPullRequest, module: "workflow" },
  { href: "/cloud-code", label: "Cloud Code", icon: Cloud, module: "cloud-code" },
  { href: "/evaluations", label: "Evaluations", icon: BarChart3, module: "evaluations" },
  { href: "/tickets", label: "Ticket History", icon: History, module: "workflow" },
];

/**
 * Path -> page title lookup used by the Header. Derived from the nav registry
 * plus surfaces that are reachable but not in the sidebar (e.g. /invoke).
 */
export const PAGE_TITLES: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label])),
  "/invoke": "Invoke",
};
