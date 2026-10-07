import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * TEAM-5376 — doc drift for the "State items" table in
 * docs/workflow/closeout-lifecycle.md. A row missing a column counts as a missing
 * row (code review TEAM-5361 finding 10), so this pins:
 *   - every row has all seven cells, none blank;
 *   - the rows the close-out depends on are all there;
 *   - every `path` › "title" (or `path` › `test_name`) in the section names a file
 *     that exists and a test title that file still contains;
 *   - every backticked `path:line` names a file that exists (the line is not checked:
 *     it moves with every edit, the file does not).
 */

const ROOT = resolve(__dirname, "../../..");
const DOC = readFileSync(resolve(ROOT, "docs/workflow/closeout-lifecycle.md"), "utf8");
const SECTION = DOC.slice(DOC.indexOf("## State items"), DOC.indexOf("\n## ", DOC.indexOf("## State items") + 1));

const COLUMNS = ["State", "WRITERS", "READERS", "DELETE-OR-EXPIRE", "ORDERING", "Failure mode", "The one test"];

/** One table row's cells; a `|` inside backticks is not a separator. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let code = false;
  for (const ch of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (ch === "`") code = !code;
    if (ch === "|" && !code) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const tableLines = SECTION.split("\n").filter((l) => l.startsWith("|"));
const header = cells(tableLines[0]);
const rows = tableLines.slice(2).map(cells);

const REQUIRED_ROWS = [
  "closeout-override.json",
  "`cancelledBy`",
  "`closedBy`",
  "`cancelCloseoutPending`",
  "`postRunEpicKey`",
  "Moved follow-up ticket",
  "`notif_followup_security_<ticket>`",
  "`notif_completion_",
  "Ticket status `cancelled`",
  "/gates/<ticket>.json",
  "merge-approval.json",
  "`completions/<ticket>.json`",
];

const repoFiles = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const basenames = new Set(repoFiles.map((f) => f.slice(f.lastIndexOf("/") + 1)));

describe("closeout-lifecycle.md state table (TEAM-5376)", () => {
  it("has the seven columns", () => {
    expect(header).toEqual(COLUMNS);
  });

  it("every row fills every column", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.length, row[0]).toBe(COLUMNS.length);
      row.forEach((cell, i) => expect(cell, `${row[0]} / ${COLUMNS[i]}`).not.toBe(""));
    }
  });

  it("carries every required row", () => {
    for (const want of REQUIRED_ROWS) {
      expect(rows.some((r) => r[0].includes(want)), want).toBe(true);
    }
  });

  it("every named test exists in the file it names", () => {
    const refs = [...SECTION.matchAll(/`([^`\s]+)` › (?:"((?:[^"\\]|\\.)*)"|`([^`]+)`)/g)];
    expect(refs.length).toBeGreaterThan(rows.length);
    for (const [, path, quoted, bare] of refs) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
      const src = readFileSync(resolve(ROOT, path), "utf8");
      const title = quoted ?? bare;
      // The doc keeps the source's escapes (\"), so either spelling counts.
      const found = src.includes(title) || src.includes(title.replace(/\\"/g, '"'));
      expect(found, `${path} › ${title}`).toBe(true);
    }
  });

  it("every `file:line` ref names a file that exists", () => {
    const refs = [...SECTION.matchAll(/`([\w./[\]-]+\.(?:ts|tsx|mjs|py|sh|json)):\d+(?:-\d+)?`/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const ok = ref.includes("/") ? existsSync(resolve(ROOT, ref)) : basenames.has(ref);
      expect(ok, ref).toBe(true);
    }
  });
});
