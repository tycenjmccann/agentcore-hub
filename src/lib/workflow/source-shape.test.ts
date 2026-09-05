import { describe, it, expect } from "vitest";
import { validateSourcesShape, formatSourceDisplay } from "./source-shape";

/**
 * TEAM-4078 regression suite.
 *
 * F1: POST /api/workflow/start accepted `sources:[{ type:"upload", value:null }]`
 *     (no shape check on req.json()), persisted it verbatim, and the workflow
 *     board then threw "Cannot read properties of null (reading 'length')"
 *     reading src.value.length. A non-string `type` threw "Objects are not valid
 *     as a React child".
 * F2: the board built its visible text from the RAW value —
 *     slice(0,40)+"…"+slice(-23) — so the last 23 characters of a presigned URL
 *     (the tail of X-Amz-Signature) were rendered, and a URL of ≤64 chars was
 *     rendered whole.
 *
 * The board itself is not rendered here: vitest runs environment:"node" with no
 * jsdom and no @testing-library/react in the repo (see vitest.config.ts), so the
 * render logic lives in formatSourceDisplay and is pinned directly.
 */

// A realistic presigned URL. SECRETSIG… is the signature; SIGHEX is the tail
// slice(-23) used to lift out of the raw string.
const SIGNATURE = "SECRETSIG0123456789abcdef";
const PRESIGNED =
  "https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=" + SIGNATURE;

describe("validateSourcesShape — the start-route front door (F1a)", () => {
  it("accepts an absent sources field (the route coalesces it to [])", () => {
    expect(validateSourcesShape(undefined)).toBeNull();
    expect(validateSourcesShape(null)).toBeNull();
    expect(validateSourcesShape([])).toBeNull();
  });

  it("accepts the shapes the MCP IntakeSourceSchema accepts", () => {
    expect(
      validateSourcesShape([
        { type: "url", value: "https://example.com/x" },
        { type: "s3", value: "s3://bucket/key", label: "spec", contentType: "application/json" },
        // verification is output-only; the server discards it, so any shape is fine here.
        { type: "upload", value: "upload-1", verification: { status: "verified" } },
      ])
    ).toBeNull();
  });

  it("rejects a non-array sources", () => {
    expect(validateSourcesShape("not-an-array")).toMatch(/must be an array/);
    expect(validateSourcesShape({ type: "url", value: "https://x/y" })).toMatch(/must be an array/);
    expect(validateSourcesShape(7)).toMatch(/must be an array/);
  });

  it("rejects a null value — the exact payload that crashed the board", () => {
    const err = validateSourcesShape([{ type: "upload", value: null }]);
    expect(err).toBe('sources[0].value must be a non-empty string');
  });

  it("rejects an empty-string value (mirrors z.string().min(1))", () => {
    expect(validateSourcesShape([{ type: "url", value: "" }])).toMatch(/non-empty string/);
  });

  it("rejects a non-string value of any other type", () => {
    for (const value of [0, 42, true, {}, [], undefined]) {
      expect(validateSourcesShape([{ type: "url", value }])).toMatch(/sources\[0\]\.value/);
    }
  });

  it("rejects a non-string type — the 'Objects are not valid as a React child' payload", () => {
    expect(validateSourcesShape([{ type: {}, value: "https://x/y" }])).toMatch(/sources\[0\]\.type/);
    expect(validateSourcesShape([{ value: "https://x/y" }])).toMatch(/sources\[0\]\.type/);
  });

  it("rejects a type outside the enum, mirroring z.enum(['url','upload','s3'])", () => {
    const err = validateSourcesShape([{ type: "ftp", value: "ftp://x/y" }]);
    expect(err).toBe('sources[0].type must be one of "url" | "upload" | "s3"');
  });

  it("rejects a non-object item", () => {
    expect(validateSourcesShape(["https://example.com/x"])).toMatch(/sources\[0\] must be an object/);
    expect(validateSourcesShape([null])).toMatch(/sources\[0\] must be an object/);
    expect(validateSourcesShape([["url", "https://x/y"]])).toMatch(/sources\[0\] must be an object/);
  });

  it("rejects non-string optional fields", () => {
    expect(validateSourcesShape([{ type: "url", value: "https://x/y", label: {} }])).toMatch(/label/);
    expect(validateSourcesShape([{ type: "url", value: "https://x/y", contentType: 5 }])).toMatch(/contentType/);
  });

  it("names the offending index so a batch submission is debuggable", () => {
    const err = validateSourcesShape([
      { type: "url", value: "https://ok/1" },
      { type: "url", value: "https://ok/2" },
      { type: "upload", value: null },
    ]);
    expect(err).toMatch(/^sources\[2\]\./);
  });
});

describe("formatSourceDisplay — the board read path (F1b + F2)", () => {
  it("(i) value:null does not throw and renders a placeholder", () => {
    const d = formatSourceDisplay({ type: "upload", value: null });
    expect(d.text).toBe("(invalid)");
    expect(d.full).toBe("(invalid)");
    expect(typeof d.text).toBe("string");
  });

  it("(i) an entirely missing/garbage source does not throw", () => {
    for (const src of [undefined, null, {}, 5, "x", []]) {
      expect(() => formatSourceDisplay(src)).not.toThrow();
      expect(typeof formatSourceDisplay(src).text).toBe("string");
    }
  });

  it("(ii) type:{} does not throw and yields a string, never an object", () => {
    const d = formatSourceDisplay({ type: {}, value: "s3://b/k" });
    expect(typeof d.type).toBe("string");
    expect(d.type).toBe("[object Object]");
  });

  it("(ii) a missing type still yields a string", () => {
    expect(formatSourceDisplay({ value: "s3://b/k" }).type).toBe("undefined");
  });

  it("(iii) a presigned URL never puts the signature on screen or in an attribute", () => {
    const d = formatSourceDisplay({ type: "url", value: PRESIGNED });

    // The whole display object is what reaches the DOM (text + every title=).
    const rendered = JSON.stringify(d);
    expect(rendered).not.toContain("SECRETSIG");
    expect(rendered).not.toContain(SIGNATURE);
    // ...including the tail the old slice(-23) exposed.
    expect(rendered).not.toContain(PRESIGNED.slice(-23));

    // Parameter NAMES survive — "it was presigned" is the useful diagnostic.
    expect(d.full).toContain("X-Amz-Signature=REDACTED");
    expect(d.full).toContain("X-Amz-Algorithm=REDACTED");
    expect(d.full).toContain("https://b.s3.amazonaws.com/k");
  });

  it("(iii) a SHORT presigned URL (≤64 chars) is redacted too — the old code printed it whole", () => {
    const short = "https://b.s3.aws/k?X-Amz-Signature=" + SIGNATURE;
    expect(short.length).toBeLessThanOrEqual(64); // the old untruncated branch
    const d = formatSourceDisplay({ type: "url", value: short });
    expect(d.text).not.toContain("SECRETSIG");
    expect(d.text).toBe("https://b.s3.aws/k?X-Amz-Signature=REDACTED");
  });

  it("(iii) a redacted verification detail carries no signature either", () => {
    const d = formatSourceDisplay({
      type: "url",
      value: PRESIGNED,
      verification: { status: "unverified", detail: `URL unreachable — GET -> 403: ${PRESIGNED}` },
    });
    expect(d.unverified).toBe(true);
    expect(d.detail).toBeDefined();
    expect(d.detail).not.toContain("SECRETSIG");
  });

  it("(iv) a long value is truncated AFTER redaction", () => {
    const long =
      "https://bucket.s3.us-east-1.amazonaws.com/very/deep/path/to/a/design/document/spec.pdf" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=" + SIGNATURE;
    const d = formatSourceDisplay({ type: "url", value: long });

    expect(d.text).toContain("…");
    expect(d.text.length).toBeLessThan(long.length);
    expect(d.text).not.toContain("SECRETSIG");
    // The head is the identifying part of the URL; the tail can only ever be a
    // slice of "…X-Amz-Signature=REDACTED".
    expect(d.text.startsWith("https://bucket.s3.us-east-1.amazonaws.co")).toBe(true);
    expect(d.text.endsWith("REDACTED")).toBe(true);
    // full is the untruncated-but-redacted string behind the tooltip.
    expect(d.full).toContain("X-Amz-Signature=REDACTED");
    expect(d.full).not.toContain("…");
  });

  it("(iv) a value at the truncation boundary is left whole", () => {
    const v = "s3://bucket/" + "a".repeat(52); // exactly 64
    expect(v).toHaveLength(64);
    expect(formatSourceDisplay({ type: "s3", value: v }).text).toBe(v);
  });

  it("(v) a plain non-URL value passes through unchanged", () => {
    for (const v of [
      "s3://agentcore-hub-artifacts-838829463875-us-east-1/uploads/spec.pdf",
      "designs/mockup.png",
      "upload-7f3a9c",
      "a plain sentence with an = sign & an ampersand",
    ]) {
      const d = formatSourceDisplay({ type: "s3", value: v });
      expect(d.full).toBe(v);
      if (v.length <= 64) expect(d.text).toBe(v);
    }
  });

  it("flags unverified only on the exact marker, and redacts the label", () => {
    expect(formatSourceDisplay({ type: "s3", value: "s3://b/k" }).unverified).toBe(false);
    expect(
      formatSourceDisplay({ type: "s3", value: "s3://b/k", verification: { status: "verified" } }).unverified
    ).toBe(false);

    const labelled = formatSourceDisplay({ type: "url", value: "https://x/y", label: `see ${PRESIGNED}` });
    expect(labelled.label).not.toContain("SECRETSIG");
    // A non-string label must not reach a title attribute.
    expect(formatSourceDisplay({ type: "url", value: "https://x/y", label: {} }).label).toBeUndefined();
    expect(formatSourceDisplay({ type: "url", value: "https://x/y" }).label).toBeUndefined();
  });

  it("a non-string verification.detail is dropped rather than rendered", () => {
    const d = formatSourceDisplay({ type: "url", value: "https://x/y", verification: { status: "unverified", detail: {} } });
    expect(d.unverified).toBe(true);
    expect(d.detail).toBeUndefined();
  });
});
