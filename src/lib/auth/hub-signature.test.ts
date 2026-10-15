import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHubSignature } from "./hub-signature";

/**
 * TEAM-6121 — Jira's admin-webhook "secret" field signs the raw request body
 * as WebSub's X-Hub-Signature: "<method>=<hex hmac>" (Atlassian "Secure admin
 * webhooks": https://developer.atlassian.com/cloud/jira/platform/webhooks/).
 * The published test vector: secret "It's a Secret to Everybody", payload
 * "Hello World!", sha256 → a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9.
 */
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello World!";
const VECTOR_HEX = "a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";

describe("verifyHubSignature", () => {
  it("matches the Atlassian-published test vector", () => {
    expect(verifyHubSignature(BODY, `sha256=${VECTOR_HEX}`, SECRET)).toBe(true);
  });

  it("is case-insensitive on the hex digest", () => {
    expect(verifyHubSignature(BODY, `sha256=${VECTOR_HEX.toUpperCase()}`, SECRET)).toBe(true);
  });

  it("rejects a one-byte change to the body", () => {
    expect(verifyHubSignature("Hello World?", `sha256=${VECTOR_HEX}`, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyHubSignature(BODY, `sha256=${VECTOR_HEX}`, "wrong secret")).toBe(false);
  });

  it("rejects a non-sha256 method even with a correct HMAC for that method", () => {
    const sha1 = createHmac("sha1", SECRET).update(BODY, "utf8").digest("hex");
    expect(verifyHubSignature(BODY, `sha1=${sha1}`, SECRET)).toBe(false);
  });

  it("rejects an empty hex digest", () => {
    expect(verifyHubSignature(BODY, "sha256=", SECRET)).toBe(false);
  });

  it("rejects a header with no '=' separator", () => {
    expect(verifyHubSignature(BODY, "sha256deadbeef", SECRET)).toBe(false);
  });

  it("rejects a null header", () => {
    expect(verifyHubSignature(BODY, null, SECRET)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(verifyHubSignature(BODY, "", SECRET)).toBe(false);
  });

  it("does not throw on garbage input", () => {
    expect(() => verifyHubSignature(BODY, "garbage", SECRET)).not.toThrow();
    expect(verifyHubSignature(BODY, "garbage", SECRET)).toBe(false);
  });
});
