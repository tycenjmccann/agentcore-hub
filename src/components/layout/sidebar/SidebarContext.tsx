"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface SidebarContextType {
  isCollapsed: boolean;
  toggle: () => void;
  /** Mobile off-canvas drawer open state (ignored on desktop). */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextType>({
  isCollapsed: false,
  toggle: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
});

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Sync from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    try {
      const stored = localStorage.getItem("sidebar-collapsed") === "true" ||
        document.documentElement.dataset.sidebarCollapsed === "true";
      if (stored) setIsCollapsed(true);
    } catch {}
  }, []);

  const toggle = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
      return next;
    });
  };

  return (
    <SidebarContext.Provider value={{ isCollapsed, toggle, mobileOpen, setMobileOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
