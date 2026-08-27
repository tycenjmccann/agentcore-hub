// battery:lint as CI runs it. lint-fixtures.mjs is a CLI that resolves its own
// battery dir, so these tests exercise the real tree in a subprocess and clean
// up the one file they add. No AWS, no network.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LINTER = join(REPO_ROOT, "evals/battery/lint-fixtures.mjs");
const CASES_DIR = join(REPO_ROOT, "evals/battery/cases");
const PROBE = join(CASES_DIR, "zz-duplicate-id-probe.json");

/** Run the linter; returns { code, output } instead of throwing. */
function lint(): { code: number; output: string } {
  try {
    // stdio: stderr piped, not inherited — a deliberate lint failure must not
    // look like a test-run error.
    return {
      code: 0,
      output: execFileSync(process.execPath, [LINTER], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

afterEach(() => {
  rmSync(PROBE, { force: true });
});

describe("battery:lint", () => {
  it("passes on the checked-in tree", () => {
    expect(existsSync(PROBE)).toBe(false);
    const { code, output } = lint();
    expect(output).toContain("battery:lint OK");
    expect(code).toBe(0);
  });

  it("fails on a duplicate case id, naming the id and both files (B4)", () => {
    const source = readdirSync(CASES_DIR).filter((n) => n.endsWith(".json") && !n.startsWith("_")).sort()[0];
    copyFileSync(join(CASES_DIR, source), PROBE);
    const { code, output } = lint();
    expect(code).toBe(1);
    expect(output).toContain("battery:lint FAILED");
    expect(output).toMatch(/duplicate case id '[a-z0-9-]+' declared by 2 case files/);
    expect(output).toContain(`evals/battery/cases/${source}`);
    expect(output).toContain("evals/battery/cases/zz-duplicate-id-probe.json");
  });
});
