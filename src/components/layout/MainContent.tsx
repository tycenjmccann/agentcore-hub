"use client";

import { useSidebar } from "@/components/layout/sidebar/SidebarContext";

export default function MainContent({ children }: { children: React.ReactNode }) {
  const { isCollapsed } = useSidebar();

  // Mobile: sidebar is an off-canvas drawer → no left margin. Desktop: rail width.
  return (
    <div className={`flex-1 min-w-0 transition-all duration-300 motion-reduce:transition-none ml-0 ${isCollapsed ? "md:ml-16" : "md:ml-64"}`}>
      {children}
    </div>
  );
}
