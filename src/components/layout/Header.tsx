"use client";

import { useState, useEffect } from "react";
import { Globe, ChevronDown, Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { invalidateCachePrefix } from "@/lib/client-cache";
import { PAGE_TITLES as pageTitles } from "@/config/modules";
import { BRAND_NAME } from "@/config/brand";
import { useSidebar } from "@/components/layout/sidebar/SidebarContext";
import ThemeToggle from "./ThemeToggle";

export default function Header() {
  const pathname = usePathname();
  const { setMobileOpen } = useSidebar();
  const [dynamicTitle, setDynamicTitle] = useState<string | null>(null);

  const baseTitle = pathname.startsWith("/agents/") && pathname !== "/agents"
    ? "Agent Detail"
    : pathname.startsWith("/workflow/") && pathname !== "/workflow"
    ? "Workflow Detail"
    : pageTitles[pathname] || BRAND_NAME;

  // Listen for dynamic title updates (e.g. selected workflow name)
  useEffect(() => {
    const handler = (e: Event) => {
      setDynamicTitle((e as CustomEvent).detail || null);
    };
    window.addEventListener("header-title", handler);
    return () => window.removeEventListener("header-title", handler);
  }, []);

  // Reset dynamic title on route change
  useEffect(() => {
    setDynamicTitle(null);
  }, [pathname]);

  const title = dynamicTitle || baseTitle;

  const [region, setRegion] = useState("us-east-1");

  // Sync from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    try {
      const stored = localStorage.getItem("aws-region");
      if (stored) setRegion(stored);
    } catch {}
  }, []);
  const [regions, setRegions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    // Fetch available regions from the server (just the list, no mutable state)
    fetch("/api/agentcore/region")
      .then((r) => r.json())
      .then((data) => {
        setRegions(data.available || []);
        // If localStorage doesn't have a region yet, use the server default
        if (!localStorage.getItem("aws-region") && data.current) {
          localStorage.setItem("aws-region", data.current);
          setRegion(data.current);
        }
      })
      .catch(() => {});
  }, []);

  const switchRegion = (newRegion: string) => {
    if (newRegion === region) {
      setShowDropdown(false);
      return;
    }
    // Store in localStorage — all future fetch calls will read from here
    localStorage.setItem("aws-region", newRegion);
    setRegion(newRegion);
    setShowDropdown(false);
    // Invalidate all cached data so it refetches with new region
    invalidateCachePrefix("/api/");
    // Reload page to refresh all data with new region
    window.location.reload();
  };

  return (
    <header className="h-14 bg-surface-1 border-b border-surface-4 flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2 min-w-0">
        {/* Mobile-only hamburger → opens the nav drawer */}
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          className="md:hidden p-2 -ml-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-surface-3"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h2 className="text-base md:text-lg font-semibold text-[var(--color-text-primary)] truncate">{title}</h2>
      </div>

      <div className="flex items-center gap-4">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* Region Selector */}
        <div className="relative">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-2 border border-surface-4 hover:border-brand-500/50 transition-colors text-xs"
          >
            <Globe className="w-3.5 h-3.5 text-brand-400" />
            <span className="text-[var(--color-text-secondary)] font-mono">
              {region || "loading..."}
            </span>
            <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)]" />
          </button>

          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface-2 border border-surface-4 rounded-lg shadow-xl z-50 py-1">
              {regions.map((r) => (
                <button
                  key={r}
                  onClick={() => switchRegion(r)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-surface-3 transition-colors ${
                    r === region ? "text-brand-400" : "text-[var(--color-text-secondary)]"
                  }`}
                >
                  {r}
                  {r === region && <span className="ml-2 text-[10px] text-gray-600">(active)</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
