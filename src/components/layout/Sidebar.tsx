"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/layout/sidebar/SidebarContext";
import { NAV_ITEMS as navItems } from "@/config/modules";
import { BRAND_NAME } from "@/config/brand";

export default function Sidebar() {
  const pathname = usePathname();
  const { isCollapsed, toggle } = useSidebar();

  return (
    <aside className={cn("fixed left-0 top-0 h-screen bg-surface-1 border-r border-surface-4 flex flex-col z-50 transition-all duration-300 motion-reduce:transition-none", isCollapsed ? "w-16" : "w-64")}>
      <div className={cn("border-b border-surface-4", isCollapsed ? "p-4 flex justify-center" : "p-6")}>
        <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-3")}>
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shrink-0">
            <Bot className="w-5 h-5 text-white" />
          </div>
          {!isCollapsed && (
            <h1 className="text-lg font-bold text-[var(--color-text-primary)]">{BRAND_NAME}</h1>
          )}
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`nav-${item.label.toLowerCase()}`}
              className={cn(
                "relative group flex items-center rounded-lg text-sm font-medium transition-colors",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
                isActive
                  ? "bg-brand-600/20 text-brand-400 border border-brand-600/30"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-surface-3"
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {!isCollapsed && item.label}
              {isCollapsed && (
                <span className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 rounded-md border border-[var(--color-surface-4)] bg-[var(--color-surface-2)] px-2 py-1 text-xs font-medium text-[var(--color-text-primary)] whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity duration-150" role="tooltip">
                  {item.label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <button
        onClick={toggle}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn("mt-auto mx-3 mb-4 p-2.5 rounded-lg transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] flex items-center", isCollapsed ? "justify-center" : "gap-3")}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        {!isCollapsed && <span className="text-sm font-medium">Collapse</span>}
      </button>
    </aside>
  );
}
