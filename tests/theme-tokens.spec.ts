import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * Regression test: Ensure workflow components do NOT contain hardcoded
 * zinc/gray/slate neutral color classes (except in semantic status mappings).
 *
 * This test prevents reintroduction of theme-breaking hardcoded dark colors.
 * It should FAIL on the pre-fix codebase and PASS after the theme token migration.
 */

// Files to scan
const WORKFLOW_DIR = path.join(__dirname, "..", "src", "components", "workflow");

// Forbidden patterns: hardcoded neutral color classes that break light mode
const FORBIDDEN_PATTERNS = [
  /\bbg-zinc-\d/,
  /\btext-zinc-\d/,
  /\bborder-zinc-\d/,
  /\bbg-gray-\d/,
  /\btext-gray-\d/,
  /\bborder-gray-\d/,
  /\bbg-slate-\d/,
  /\btext-slate-\d/,
  /\bborder-slate-\d/,
  /\bplaceholder-zinc-\d/,
  /\bplaceholder-gray-\d/,
];

/**
 * Lines are exempt if they are inside a semantic status mapping object.
 * We detect this by checking if the line is:
 * 1. Inside a const/let/var that maps status → styles (STATUS_CONFIG, STATUS_STYLES, etc.)
 * 2. Part of a status-specific color (status dot, status text, status border)
 * 3. A fallback for unknown status (?? "bg-zinc-...")
 * 4. Inside an SVG fill/stroke attribute
 * 5. A stream status indicator (idle/connecting semantic state)
 */
function isExemptLine(line: string, fileName: string): boolean {
  const trimmed = line.trim();

  // Exempt: lines inside STATUS object definitions (status mapping objects)
  if (
    /STATUS_CONFIG|STATUS_STYLES|BORDER_COLOR|TEXT_COLOR/.test(trimmed) ||
    /status.*:.*\{/.test(trimmed) ||
    /^\s*(backlog|todo|ready|in_progress|in_review|done|blocked|cancelled|idle|pending|running|waiting_response|complete|error)\s*[:=]/.test(trimmed)
  ) {
    return true;
  }

  // Exempt: lines that are key-value pairs inside status mapping objects
  // (e.g., { dot: "bg-zinc-500", text: "text-zinc-400", label: "..." })
  if (/^\s*\{?\s*(dot|text|bg|borderClass|dotClass)\s*:\s*"/.test(trimmed)) {
    return true;
  }

  // Exempt: fallback status dot colors (?? "bg-zinc-...")
  if (/\?\?\s*"(bg|text|border)-zinc-/.test(trimmed)) {
    return true;
  }

  // Exempt: stream status ternary (semantic idle state)
  if (/streamStatus/.test(trimmed)) {
    return true;
  }

  // Exempt: SVG fill/stroke attributes using hex colors
  if (/fill=|stroke=/.test(trimmed)) {
    return true;
  }

  // Exempt: TicketStatusBadge.tsx — all zinc in this file is semantic status coloring
  if (fileName === "TicketStatusBadge.tsx") {
    return true;
  }

  // Exempt: comments
  if (/^\s*(\/\/|\/\*|\*)/.test(trimmed)) {
    return true;
  }

  return false;
}

test.describe("Theme Token Regression", () => {
  test("workflow components must not contain hardcoded zinc/gray/slate neutral classes", () => {
    const tsxFiles = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".tsx"));
    const violations: string[] = [];

    for (const file of tsxFiles) {
      const filePath = path.join(WORKFLOW_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      // Track if we're inside a status mapping object
      let insideStatusObject = false;
      let braceDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect entry into status mapping objects
        if (/const\s+(STATUS_CONFIG|STATUS_STYLES|BORDER_COLOR|TEXT_COLOR|VALID_TRANSITIONS)\s*[=:]/.test(line)) {
          insideStatusObject = true;
          braceDepth = 0;
        }

        if (insideStatusObject) {
          for (const ch of line) {
            if (ch === "{") braceDepth++;
            if (ch === "}") braceDepth--;
          }
          if (braceDepth <= 0 && line.includes(";")) {
            insideStatusObject = false;
          }
          continue; // Skip all lines inside status objects
        }

        // Check each forbidden pattern
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            if (!isExemptLine(line, file)) {
              violations.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
              break; // One violation per line is enough
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        `Found ${violations.length} hardcoded neutral color class(es) in workflow components.`,
        "These break light mode. Use theme-aware tokens instead:",
        "  bg-zinc-800/900 → bg-surface-1/bg-surface-2",
        "  text-zinc-100/200 → text-primary",
        "  text-zinc-300/400 → text-secondary",
        "  text-zinc-500/600 → text-muted",
        "  border-zinc-700/600 → border-theme",
        "",
        "Violations:",
        ...violations.map((v) => `  ${v}`),
      ].join("\n");
      expect(violations.length, message).toBe(0);
    }
  });
});
