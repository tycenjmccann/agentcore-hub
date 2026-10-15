import { describe, it, expect } from "vitest";
import { verifyHubSignature } from "./hub-signature";

/**
 * TEAM-6324. Known-answer vector from the Atlassian docs (secure webhooks):
 * https://developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks
 * secret "It's a Secret to Everybody", payload "Hello World!" →
 * sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9
 * Kept independent of the implementation (not generated via node:crypto here).
 */
const SECRET = "It's a Secret to Everybody";
const PAYLOAD = "Hello World!";
const VALID_HEADER = "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";

describe("verifyHubSignature", () => {
  it("accepts the Atlassian known-answer vector", () => {
    expect(verifyHubSignature(PAYLOAD, VALID_HEADER, SECRET)).toBe(true);
  });

  it("accepts uppercase hex in the header", () => {
    expect(verifyHubSignature(PAYLOAD, VALID_HEADER.toUpperCase().replace("SHA256", "sha256"), SECRET)).toBe(true);
  });

  it("rejects the wrong secret", () => {
    expect(verifyHubSignature(PAYLOAD, VALID_HEADER, "wrong secret")).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyHubSignature("Hello World?", VALID_HEADER, SECRET)).toBe(false);
  });

  it("rejects a null header", () => {
    expect(verifyHubSignature(PAYLOAD, null, SECRET)).toBe(false);
  });

  it("rejects an undefined header", () => {
    expect(verifyHubSignature(PAYLOAD, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(verifyHubSignature(PAYLOAD, "", SECRET)).toBe(false);
  });

  it("rejects an empty secret even with a well-formed header", () => {
    expect(verifyHubSignature(PAYLOAD, VALID_HEADER, "")).toBe(false);
  });

  it("rejects a sha1 algorithm", () => {
    expect(verifyHubSignature(PAYLOAD, "sha1=" + "a".repeat(40), SECRET)).toBe(false);
  });

  it("rejects a sha512 algorithm", () => {
    expect(verifyHubSignature(PAYLOAD, "sha512=" + "a".repeat(128), SECRET)).toBe(false);
  });

  it("rejects bare hex with no algorithm prefix", () => {
    expect(verifyHubSignature(PAYLOAD, "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9", SECRET)).toBe(false);
  });

  it("rejects hex that is one character short", () => {
    expect(verifyHubSignature(PAYLOAD, "sha256=" + "a".repeat(63), SECRET)).toBe(false);
  });

  it("rejects hex that is one character too long", () => {
    expect(verifyHubSignature(PAYLOAD, "sha256=" + "a".repeat(65), SECRET)).toBe(false);
  });

  it("rejects sha256= with nothing after it", () => {
    expect(verifyHubSignature(PAYLOAD, "sha256=", SECRET)).toBe(false);
  });

  it("tolerates surrounding whitespace in the header", () => {
    expect(verifyHubSignature(PAYLOAD, `  ${VALID_HEADER}  `, SECRET)).toBe(true);
  });
});
