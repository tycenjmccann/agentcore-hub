import { describe, expect, it } from "vitest";
import {
  a2aFormToRaw,
  customFormToRaw,
  mcpFormToRaw,
  rawToA2aForm,
  rawToCustomForm,
  rawToMcpForm,
} from "./descriptors";
import { agentRawContent } from "./agent-registration";

const ARN = "arn:aws:bedrock-agentcore:eu-west-3:000011112222:runtime/fake_agent-AbC123";

describe("form <-> raw round-trip keeps fields the form has no input for", () => {
  it("A2A: an agent card survives rawToA2aForm -> a2aFormToRaw unchanged", () => {
    const raw = agentRawContent(
      { name: "fake_agent", arn: ARN, type: "runtime", tools: [{ type: "remote_mcp", name: "search" }] },
      "A2A"
    );
    const out = JSON.parse(a2aFormToRaw(rawToA2aForm(raw), raw));
    expect(out).toEqual(JSON.parse(raw));
    expect(out.url).toContain(encodeURIComponent(ARN));
    expect(out.protocolVersion).toBe("0.3.0");
    expect(out.metadata.agentArn).toBe(ARN);
  });

  it("A2A: form edits apply; kept skills keep their objects, new ones get unused ids", () => {
    const raw = JSON.stringify({
      name: "a",
      url: "https://x/a2a",
      skills: [{ id: "skill-1", name: "search", description: "d", tags: ["t"] }],
    });
    const f = { ...rawToA2aForm(raw), name: "b", skills: "search, write" };
    const out = JSON.parse(a2aFormToRaw(f, raw));
    expect(out.name).toBe("b");
    expect(out.url).toBe("https://x/a2a");
    expect(out.skills).toEqual([
      { id: "skill-1", name: "search", description: "d", tags: ["t"] },
      { id: "skill-2", name: "write", description: "" },
    ]);
  });

  it("MCP: transport survives a round-trip", () => {
    const raw = JSON.stringify({ name: "m", version: "1.0.0", transport: { type: "streamable-http", url: "https://x/mcp" } });
    const out = JSON.parse(mcpFormToRaw(rawToMcpForm(raw), raw));
    expect(out.transport).toEqual({ type: "streamable-http", url: "https://x/mcp" });
  });

  it("CUSTOM: extra top-level keys survive; data comes from the form", () => {
    const raw = JSON.stringify({ name: "c", description: "", data: { a: 1 }, owner: "team" });
    const f = { ...rawToCustomForm(raw), dataJson: '{"a":2}' };
    const out = JSON.parse(customFormToRaw(f, raw));
    expect(out).toEqual({ name: "c", description: "", data: { a: 2 }, owner: "team" });
  });

  it("no base / unparseable base: same output as before (form fields only)", () => {
    const f = { name: "n", description: "d", version: "1.0.0", skills: "x" };
    expect(JSON.parse(a2aFormToRaw(f))).toEqual({
      name: "n",
      description: "d",
      version: "1.0.0",
      skills: [{ id: "skill-1", name: "x", description: "" }],
    });
    expect(JSON.parse(mcpFormToRaw(f, "not json"))).toEqual({ name: "n", description: "d", version: "1.0.0" });
  });
});
