import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TEAM-6123 (P3) — the pre-fix secretMatches returned early on a buffer-length
 * mismatch, BEFORE calling timingSafeEqual, so the comparison took a different
 * code path (and different time) depending on whether `provided.length ===
 * expected.length`. That is exactly the side channel timingSafeEqual exists to
 * remove: an attacker who can measure response time can binary-search the
 * secret's length for free, then brute-force byte-by-byte.
 *
 * The fix hashes both inputs to a fixed-length (32-byte) SHA-256 digest first, so
 * timingSafeEqual always runs, on equal-length buffers, regardless of the inputs'
 * own lengths. These tests pin both the observable behavior (unequal lengths
 * return false without throwing — unchanged) and the actual mechanism (spy on
 * node:crypto's timingSafeEqual to prove it is reached, every time, on 32-byte
 * buffers) — the second is the one that actually fails pre-fix, since the
 * observable behavior was already correct, just for the wrong reason.
 */

const timingSafeEqualSpy = vi.fn();

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    timingSafeEqual: (...args: Parameters<typeof actual.timingSafeEqual>) => {
      timingSafeEqualSpy(...args);
      return actual.timingSafeEqual(...args);
    },
  };
});

let secretMatches: typeof import("./secret-match").secretMatches;

beforeEach(async () => {
  timingSafeEqualSpy.mockClear();
  vi.resetModules();
  ({ secretMatches } = await import("./secret-match"));
});

describe("secretMatches — observable behavior (unchanged)", () => {
  it("equal strings match", () => {
    expect(secretMatches("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("unequal lengths return false, without throwing", () => {
    expect(() => secretMatches("a", "abcdef")).not.toThrow();
    expect(secretMatches("a", "abcdef")).toBe(false);
    expect(secretMatches("abcdef", "a")).toBe(false);
  });

  it("same-length wrong value returns false", () => {
    expect(secretMatches("s3cr3tX", "s3cr3tY")).toBe(false);
  });

  it("both empty returns true (unchanged semantics)", () => {
    expect(secretMatches("", "")).toBe(true);
  });

  it("one empty, one not, returns false", () => {
    expect(secretMatches("", "x")).toBe(false);
  });
});

describe("secretMatches — no length leak (TEAM-6123 P3)", () => {
  it("timingSafeEqual runs on EVERY comparison, even mismatched lengths — the early-return length leak is gone", () => {
    secretMatches("a", "abcdefghijklmnop");
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it("timingSafeEqual always receives two fixed-length (32-byte, SHA-256) buffers, regardless of input length", () => {
    secretMatches("a", "abcdefghijklmnop");
    const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it("mismatched-length inputs produce DIFFERENT digests (not padded/truncated to equal)", () => {
    secretMatches("a", "abcdefghijklmnop");
    const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
    expect(a.equals(b)).toBe(false);
  });

  it("equal-length wrong-value inputs still go through timingSafeEqual once", () => {
    secretMatches("s3cr3tX", "s3cr3tY");
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });
});
