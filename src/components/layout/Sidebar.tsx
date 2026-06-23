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
  const { isCollapsed, toggle, mobileOpen, setMobileOpen } = useSidebar();

  return (
    <>
    {/* Mobile backdrop — tap to close the drawer */}
    {mobileOpen && (
      <div
        className="fixed inset-0 z-40 bg-black/50 md:hidden"
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />
    )}
    <aside className={cn(
      "fixed left-0 top-0 h-screen bg-surface-1 border-r border-surface-4 flex flex-col z-50 transition-transform duration-300 motion-reduce:transition-none",
      // Desktop: in-flow rail, width toggles. Mobile: full drawer that slides in.
      isCollapsed ? "md:w-16" : "md:w-64",
      "w-64",
      mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
    )}>
      {/* isCollapsed only narrows on desktop (md:); the mobile drawer is full-width
          and always shows labels. */}
      <div className={cn("border-b border-surface-4 p-6", isCollapsed && "md:p-4 md:flex md:justify-center")}>
        <div className={cn("flex items-center gap-3", isCollapsed && "md:justify-center md:gap-0")}>
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shrink-0">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <h1 className={cn("text-lg font-bold text-[var(--color-text-primary)]", isCollapsed && "md:hidden")}>{BRAND_NAME}</h1>
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
              onClick={() => setMobileOpen(false)}
              className={cn(
                "relative group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isCollapsed && "md:justify-center md:gap-0 md:p-2.5",
                isActive
                  ? "bg-brand-600/20 text-brand-400 border border-brand-600/30"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-surface-3"
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className={cn(isCollapsed && "md:hidden")}>{item.label}</span>
              {isCollapsed && (
                <span className="hidden md:block pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 rounded-md border border-[var(--color-surface-4)] bg-[var(--color-surface-2)] px-2 py-1 text-xs font-medium text-[var(--color-text-primary)] whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity duration-150" role="tooltip">
                  {item.label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Desktop-only collapse toggle (mobile uses the backdrop / nav tap). */}
      <button
        onClick={toggle}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn("hidden md:flex mt-auto mx-3 mb-4 p-2.5 rounded-lg transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] items-center", isCollapsed ? "md:justify-center" : "gap-3")}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        {!isCollapsed && <span className="text-sm font-medium">Collapse</span>}
      </button>
    </aside>
    </>
  );
}
