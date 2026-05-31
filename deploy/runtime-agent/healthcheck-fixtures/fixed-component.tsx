import React, { useState, useEffect } from "react";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  // FIX: Use a safe default for SSR, then hydrate from localStorage in useEffect
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved) setTheme(saved);
  }, []);

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
