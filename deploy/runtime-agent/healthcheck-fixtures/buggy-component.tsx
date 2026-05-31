import React, { useState } from "react";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  // BUG: localStorage is not available during SSR (server-side rendering).
  // This causes a hydration mismatch because the server renders with undefined
  // but the client renders with the stored value.
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("theme") || "light";
  });

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("theme", next);
  };

  return (
    <button className={className} onClick={toggle}>
      {theme === "light" ? "🌙" : "☀️"} {theme} mode
    </button>
  );
}
