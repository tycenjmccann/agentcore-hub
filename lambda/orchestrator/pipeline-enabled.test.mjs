import { describe, it, expect } from "vitest";
import { isPipelineEnabled } from "./pipeline-enabled.mjs";

/**
 * TEAM-3738 (same defect class as TEAM-3723): deploy.sh forwards PIPELINE_ENABLED
 * verbatim, so a strict === "1"/"true" comparison silently disabled pipeline
 * mode on whitespace-padded or case-variant values.
 */

describe("isPipelineEnabled", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" true", true],
    ["1 ", true],
    ["True", true],
    ["0", false],
    ["", false],
    [undefined, false],
    ["false", false],
    ["yes", false],
  ])("%p -> %p", (input, expected) => {
    expect(isPipelineEnabled(input)).toBe(expected);
  });
});
