import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-5321 FR-7 — one name for the "reviewer cap resolved" event.
 *
 * Three places must agree: the WM toolkit counts it (compute_metrics.py), the
 * cost-report card counts it (`loops`), and the workflow-output Lambda emits it.
 * A rename in any one silently zeroes the loop count. Sources are read as text so
 * neither the Python module nor cost-report's AWS SDK graph is loaded.
 *
 * The emitter lands separately (TEAM-5323): until then workflow-output holds no
 * `review.cap_*` literal and that half passes vacuously; once it does, any such
 * literal must be exactly the shared name.
 */

const EVENT = "review.cap_resolved";
const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const TOOLKIT = read("deploy/workflow-manager/toolkit/compute_metrics.py");
const COST_REPORT = read("lambda/cost-report/index.mjs");
const WORKFLOW_OUTPUT = read("lambda/workflow-output/index.mjs");

describe("review.cap_resolved event-name parity", () => {
  it("the toolkit and cost-report each declare the constant exactly once", () => {
    expect(TOOLKIT.match(/^CAP_RESOLVED_EVENT\s*=/gm)).toHaveLength(1);
    expect(COST_REPORT.match(/^export const CAP_RESOLVED_EVENT\s*=/gm)).toHaveLength(1);
  });

  it("toolkit == cost-report == review.cap_resolved", () => {
    const toolkit = TOOLKIT.match(/^CAP_RESOLVED_EVENT\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const costReport = COST_REPORT.match(/^export const CAP_RESOLVED_EVENT\s*=\s*"([^"]+)";/m)?.[1];
    expect(toolkit).toBe(EVENT);
    expect(costReport).toBe(EVENT);
  });

  it("every review.cap_* literal in workflow-output is exactly review.cap_resolved", () => {
    const literals = [...WORKFLOW_OUTPUT.matchAll(/["'`](review\.cap_[a-z_]+)["'`]/g)].map((m) => m[1]);
    for (const name of literals) expect(name).toBe(EVENT);
  });
});
