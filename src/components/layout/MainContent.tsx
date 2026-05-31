"use client";

import { useSidebar } from "@/components/layout/sidebar/SidebarContext";

export default function MainContent({ children }: { children: React.ReactNode }) {
  const { isCollapsed } = useSidebar();

  return (
    <div className={`flex-1 transition-all duration-300 motion-reduce:transition-none ${isCollapsed ? "ml-16" : "ml-64"}`}>
      {children}
    </div>
  );
}
