import { describe, it, expect } from "vitest";
import { validateSourcesShape, MAX_INTAKE_SOURCES } from "./source-shape";

/**
 * TEAM-4078 regression suite.
 *
 * F1: POST /api/workflow/start accepted `sources:[{ type:"upload", value:null }]`
 *     (no shape check on req.json()), persisted it verbatim, and the workflow
 *     board then threw "Cannot read properties of null (reading 'length')"
 *     reading src.value.length. A non-string `type` threw "Objects are not valid
 *     as a React child".
 *
 * The board no longer renders sources at all (they belong to the PRD package),
 * so only the front-door validator is pinned here.
 */

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

  // TEAM-4091 F3: validateIntakeSources fans every source out CONCURRENTLY, each
  // costing up to two 10s outbound GETs or an S3 HeadObject, on a route with no
  // auth — so the count itself has to be bounded at the front door.
  it("rejects more than MAX_INTAKE_SOURCES sources, even when every one is well-formed", () => {
    const sources = Array.from({ length: MAX_INTAKE_SOURCES + 1 }, (_, i) => ({
      type: "url",
      value: `https://example.com/${i}`,
    }));
    expect(validateSourcesShape(sources)).toBe(`sources must have at most ${MAX_INTAKE_SOURCES} items`);
  });

  it("accepts exactly MAX_INTAKE_SOURCES sources", () => {
    const sources = Array.from({ length: MAX_INTAKE_SOURCES }, (_, i) => ({
      type: "url",
      value: `https://example.com/${i}`,
    }));
    expect(validateSourcesShape(sources)).toBeNull();
  });

  it("reports the count before the per-item scan, so an oversized batch fails fast", () => {
    // Item 0 is also malformed; the length message wins because the cap is
    // checked first (nothing here should walk 10k items to find that out).
    const sources = [{ type: "upload", value: null }, ...Array.from({ length: 10_000 }, () => ({}))];
    expect(validateSourcesShape(sources)).toBe(`sources must have at most ${MAX_INTAKE_SOURCES} items`);
  });
});
