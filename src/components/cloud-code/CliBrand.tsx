import type { CloudCodeCli } from "@/lib/cloud-code/types";

// Brand palette for the two coding agents. Centralized so the sidebar row,
// session header, new-session modal, and agent-turn label all stay in sync.
//   Claude  → Anthropic coral/clay (#D97757)
//   Codex   → OpenAI monochrome; on a dark theme that reads as near-white/neutral
// TODO(brand): the marks below are hand-built approximations. Swap in the
// official Anthropic / OpenAI SVG assets before shipping externally.
export const CLI_BRAND: Record<
  CloudCodeCli,
  { label: string; chip: string; dot: string }
> = {
  claude: {
    label: "Claude",
    // coral text on a faint coral wash
    chip: "bg-[#D97757]/15 text-[#E08B6E]",
    dot: "text-[#D97757]",
  },
  codex: {
    label: "Codex",
    chip: "bg-white/10 text-[var(--color-text-secondary)]",
    dot: "text-[var(--color-text-secondary)]",
  },
};

// Anthropic "sunburst" mark — radial spokes. Approximation; see TODO above.
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M5.5 16.3 9.9 4.4h2.3l4.4 11.9h-2.4l-.9-2.6H8.8l-.9 2.6H5.5Zm3.9-4.5h3.3l-1.6-4.7-1.7 4.7Z" />
      <path d="M14.6 16.3 19 4.4h-2.3l-4.4 11.9h2.3Z" opacity="0.55" />
    </svg>
  );
}

// OpenAI knot mark — simplified single-stroke approximation. See TODO above.
function CodexMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3.2a4 4 0 0 1 3.8 2.7 4 4 0 0 1 1.2 7 4 4 0 0 1-3.8 5.9 4 4 0 0 1-6.4-1.6 4 4 0 0 1-1.2-7A4 4 0 0 1 9.4 4 4 4 0 0 1 12 3.2Z" />
      <path d="M12 8.2v3.8l3.2 1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CliMark({ cli, className = "w-3.5 h-3.5" }: { cli: CloudCodeCli; className?: string }) {
  return cli === "claude" ? <ClaudeMark className={className} /> : <CodexMark className={className} />;
}

// Small brand chip: logo mark + name, brand-tinted. `size` toggles padding.
export function CliBadge({ cli, className = "" }: { cli: CloudCodeCli; className?: string }) {
  const b = CLI_BRAND[cli];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold ${b.chip} ${className}`}
    >
      <CliMark cli={cli} className="w-3 h-3" />
      {b.label}
    </span>
  );
}
