import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Theme-variable presence guard (TEAM-3507).
 *
 * The "Create a routine" modal (and many other panels/modals) painted their
 * background with `bg-[var(--color-bg-secondary)]`, but that custom property
 * was never defined in globals.css — the theme only ships `--color-surface-*`.
 * An undefined CSS variable with no fallback makes `background-color` resolve
 * to `transparent`, so the modal rendered see-through and the cards behind it
 * bled through. This test fails if ANY `--color-*` variable referenced in the
 * source is missing from globals.css, so the class never regresses.
 *
 * Source-content convention (see SdlcBadge.presence.test.ts, TEAM-2141): we
 * run in a node environment with no DOM, so we scan files as text.
 */

const SRC_ROOT = path.resolve(__dirname, '../..'); // src/
const GLOBALS_CSS = path.resolve(SRC_ROOT, 'styles/globals.css');

/** All `--color-*` custom properties DECLARED in globals.css (LHS of `:`). */
function definedColorVars(css: string): Set<string> {
  const defined = new Set<string>();
  // A declaration is `--color-name:` — the property name immediately followed
  // by a colon. References like `var(--color-x)` are followed by `)`, so they
  // are not matched here.
  for (const m of css.matchAll(/(--color-[a-z0-9-]+)\s*:/g)) {
    defined.add(m[1]);
  }
  return defined;
}

/**
 * Recursively collect files under `dir` matching one of `exts`. Test files and
 * `__tests__` dirs are skipped: they hold illustrative fixture/regex strings
 * (e.g. `var(--color-x)`) that are never rendered as UI, so scanning them would
 * produce false positives.
 */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, out);
    } else if (
      exts.some((e) => entry.name.endsWith(e)) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every `var(--color-...)` reference across the source tree, with locations. */
function referencedColorVars(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const files = walk(SRC_ROOT, ['.tsx', '.ts', '.css']);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const m of content.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)) {
      const name = m[1];
      const rel = path.relative(SRC_ROOT, file);
      if (!refs.has(name)) refs.set(name, []);
      const locs = refs.get(name)!;
      if (!locs.includes(rel)) locs.push(rel);
    }
  }
  return refs;
}

describe('theme CSS variable presence (TEAM-3507)', () => {
  const css = fs.readFileSync(GLOBALS_CSS, 'utf-8');
  const defined = definedColorVars(css);
  const referenced = referencedColorVars();

  it('defines every --color-* variable referenced via var() in the source', () => {
    const undefinedRefs: string[] = [];
    for (const [name, locations] of referenced) {
      if (!defined.has(name)) {
        undefinedRefs.push(`  ${name}  — referenced in: ${locations.join(', ')}`);
      }
    }
    expect(
      undefinedRefs.length,
      `Found ${undefinedRefs.length} CSS variable(s) referenced but never defined in ` +
        `src/styles/globals.css (undefined vars render as transparent):\n${undefinedRefs.join('\n')}`
    ).toBe(0);
  });

  it('defines --color-bg-secondary (the routines "Create a routine" modal panel background)', () => {
    expect(defined.has('--color-bg-secondary')).toBe(true);
  });

  it('defines --color-bg-secondary in both the light (:root) and dark theme blocks', () => {
    // Two declarations — one per theme block — so the modal is opaque in both.
    const count = (css.match(/--color-bg-secondary\s*:/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
