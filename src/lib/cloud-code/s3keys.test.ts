import { describe, it, expect } from "vitest";
import {
  tenantRoot,
  configKey,
  resumeTranscriptKey,
  artifactPrefix,
  artifactKey,
  checkpointArtifactPrefix,
  safeRelPath,
} from "./s3keys";
import { DEFAULT_TENANT_ID } from "@/lib/auth/identity";

/**
 * The S3 key layout IS the multi-tenant isolation boundary — a future per-tenant
 * IAM role gets scoped to `…/t/<tenantId>/*`, so a bug that drops the prefix or
 * lets a `..` escape it would silently let one tenant read another's bytes. These
 * lock the two invariants that make that policy expressible: default tenant keeps
 * the legacy unprefixed path (zero migration), real tenants are always prefixed.
 */
describe("s3keys — tenant prefixing", () => {
  it("default tenant keeps the legacy unprefixed root (zero migration)", () => {
    expect(tenantRoot(DEFAULT_TENANT_ID)).toBe("cloud-code");
    expect(tenantRoot()).toBe("cloud-code"); // default arg == default tenant
  });

  it("a real tenant is always under t/<tenantId>/", () => {
    expect(tenantRoot("acme")).toBe("cloud-code/t/acme");
  });

  it("every key kind inherits the tenant root", () => {
    expect(configKey("acme", "u1", "v3")).toBe("cloud-code/t/acme/configs/u1/v3.zip");
    expect(resumeTranscriptKey("acme", "s1", "c1")).toBe("cloud-code/t/acme/resume/s1/c1.jsonl");
    expect(artifactPrefix("acme", "s1")).toBe("cloud-code/t/acme/resume/s1/artifacts/");
    expect(checkpointArtifactPrefix("acme", "r1")).toBe("cloud-code/t/acme/checkpoint/r1/artifacts/");
  });

  it("default-tenant keys are byte-identical to the pre-tenancy layout", () => {
    expect(configKey(DEFAULT_TENANT_ID, "u1", "v3")).toBe("cloud-code/configs/u1/v3.zip");
    expect(artifactPrefix(DEFAULT_TENANT_ID, "s1")).toBe("cloud-code/resume/s1/artifacts/");
  });

  it("artifactKey nests a rel path under the session's prefix", () => {
    expect(artifactKey("acme", "s1", "out/report.pdf")).toBe(
      "cloud-code/t/acme/resume/s1/artifacts/out/report.pdf"
    );
  });
});

describe("s3keys — safeRelPath traversal guard", () => {
  it("accepts ordinary relative paths", () => {
    expect(safeRelPath("report.pdf")).toBe("report.pdf");
    expect(safeRelPath("out/nested/report.pdf")).toBe("out/nested/report.pdf");
  });

  it("normalizes backslashes to POSIX separators", () => {
    expect(safeRelPath("out\\win\\report.pdf")).toBe("out/win/report.pdf");
  });

  it("rejects absolute paths", () => {
    expect(safeRelPath("/etc/passwd")).toBeNull();
  });

  it("rejects any .. traversal segment", () => {
    expect(safeRelPath("../secret")).toBeNull();
    expect(safeRelPath("out/../../secret")).toBeNull();
    expect(safeRelPath("a/b/../../../etc")).toBeNull();
    // backslash-disguised traversal is normalized first, then caught
    expect(safeRelPath("..\\..\\secret")).toBeNull();
  });

  it("rejects empty segments and empty/non-string input", () => {
    expect(safeRelPath("out//report.pdf")).toBeNull(); // empty middle segment
    expect(safeRelPath("")).toBeNull();
    // @ts-expect-error — guarding runtime callers, not just the type
    expect(safeRelPath(null)).toBeNull();
  });
});
