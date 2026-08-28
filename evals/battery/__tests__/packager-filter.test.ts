// TEAM-3090 defense-in-depth: the eval-packager Lambda must skip any record
// whose session id carries the battery prefix — battery runs emit nothing by
// design (direct Converse, no OTEL), this is belt-and-suspenders. The module
// requires ARTIFACTS_BUCKET at import time, so set a synthetic one first; no
// AWS client is ever exercised (isBatterySession is pure).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BATTERY_TENANT } from "../lib/agent-runner.mjs";

process.env.ARTIFACTS_BUCKET ||= "unit-test-bucket";
const { isBatterySession } = await import("../../../lambda/eval-packager/index.mjs");

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("eval-packager battery guard (TEAM-3090)", () => {
  it("recognizes battery-prefixed session ids and nothing else", () => {
    expect(isBatterySession("battery-abc123-triage-crash-chain-001")).toBe(true);
    expect(isBatterySession(`${BATTERY_TENANT}-anything`)).toBe(true); // tenant shares the prefix
    expect(isBatterySession("prod-run-42")).toBe(false);
    expect(isBatterySession("my-battery-session")).toBe(false); // prefix, not substring
    expect(isBatterySession(null)).toBe(false);
    expect(isBatterySession(undefined)).toBe(false);
    expect(isBatterySession(42 as any)).toBe(false);
  });

  it("guards extractSessionData before any buffering (source-level wiring check)", () => {
    const src = readFileSync(join(REPO_ROOT, "lambda/eval-packager/index.mjs"), "utf8");
    // the skip must run before the sid is counted toward the batch
    const guardAt = src.indexOf("if (isBatterySession(sid))");
    const countAt = src.indexOf("sessionIds.add(sid)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(countAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(countAt);
  });
});
