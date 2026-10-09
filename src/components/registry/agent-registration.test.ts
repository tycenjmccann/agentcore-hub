import { describe, it, expect } from "vitest";
import {
  A2A_SCHEMA_VERSION,
  a2aInvocationUrl,
  agentDescription,
  agentDescriptors,
  agentToRecordDraft,
  defaultDescriptorType,
  extractInlineRaw,
  findRegisteredRecord,
  rawReferencesArn,
  regionFromArn,
  type AgentForRegistration,
  type RegistrationCandidate,
} from "./agent-registration";
import { validateRaw } from "./descriptors";
import type { RegistryRecord } from "./types";

/**
 * TEAM-5452: register a discovered agent in the Registry. Covers the
 * agent -> record-draft mapping and "is this agent already registered?"
 * detection. All ARNs are obviously fake.
 */

const FAKE_ARN = "arn:aws:bedrock-agentcore:eu-west-3:000011112222:runtime/fake_agent-AbC123";
const OTHER_ARN = "arn:aws:bedrock-agentcore:eu-west-3:000011112222:runtime/fake_agent-AbC1234";

const runtime: AgentForRegistration = {
  name: "fake_agent",
  arn: FAKE_ARN,
  type: "runtime",
  systemPrompt: "You are a fake agent. You do fake things.",
  tools: [{ type: "browser", name: "Web Browser" }, { type: "code_interpreter" }],
};

function rec(name: string, status = "APPROVED", id = name): RegistryRecord {
  return { recordId: id, name, descriptorType: "CUSTOM", status };
}

function customRawFor(arn: string, name = "x"): string {
  return JSON.stringify({ name, description: "", data: { agentArn: arn } });
}

describe("defaultDescriptorType", () => {
  it("is CUSTOM for both harness and runtime", () => {
    expect(defaultDescriptorType({ type: "harness" })).toBe("CUSTOM");
    expect(defaultDescriptorType({ type: "runtime" })).toBe("CUSTOM");
  });
});

describe("regionFromArn / a2aInvocationUrl", () => {
  it("reads the region from the ARN and falls back to the region-less host", () => {
    expect(regionFromArn(FAKE_ARN)).toBe("eu-west-3");
    expect(regionFromArn("not-an-arn")).toBeUndefined();
    expect(a2aInvocationUrl({ arn: "arn:aws:bedrock-agentcore::000011112222:runtime/x", type: "runtime" }))
      .toMatch(/^https:\/\/bedrock-agentcore\.amazonaws\.com\/runtimes\//);
    expect(a2aInvocationUrl({ arn: FAKE_ARN, type: "harness" })).toContain("/harnesses/");
  });
});

describe("agentToRecordDraft", () => {
  it("CUSTOM draft passes validateRaw, carries the ARN and falls back to opts.modelId", () => {
    const d = agentToRecordDraft(runtime, "CUSTOM", { modelId: "fake.model-v1" });
    expect(d.recordVersion).toBe("1.0.0");
    expect(d.descriptorType).toBe("CUSTOM");
    expect(validateRaw("CUSTOM", d.raw)).toBeNull();
    const o = JSON.parse(d.raw);
    expect(o.data.agentArn).toBe(FAKE_ARN);
    expect(o.data.source).toBe("agentcore-hub");
    expect(o.data.model).toBe("fake.model-v1");
    expect(o.data.tools).toEqual(["Web Browser", "code_interpreter"]);

    const own = JSON.parse(agentToRecordDraft({ ...runtime, model: "own" }, "CUSTOM", { modelId: "x" }).raw);
    expect(own.data.model).toBe("own");
    const none = JSON.parse(agentToRecordDraft(runtime, "CUSTOM").raw);
    expect("model" in none.data).toBe(false);
  });

  it("A2A draft has url/protocolVersion/skills; url decodes to the ARN in the ARN's region", () => {
    const d = agentToRecordDraft(runtime, "A2A");
    expect(validateRaw("A2A", d.raw)).toBeNull();
    const o = JSON.parse(d.raw);
    expect(o.protocolVersion).toBe("0.3.0");
    expect(o.skills).toHaveLength(2);
    expect(o.skills[0]).toEqual({ id: "web-browser", name: "Web Browser", description: "", tags: ["browser"] });
    expect(o.metadata.agentArn).toBe(FAKE_ARN);
    expect(o.url).toMatch(/^https:\/\/bedrock-agentcore\.eu-west-3\.amazonaws\.com\/runtimes\//);
    expect(decodeURIComponent(o.url)).toContain(`/${FAKE_ARN}/invocations`);

    const bare = JSON.parse(agentToRecordDraft({ ...runtime, tools: [] }, "A2A").raw);
    expect(bare.skills).toEqual([
      { id: "invoke", name: "Invoke", description: "You are a fake agent.", tags: ["runtime"] },
    ]);
  });
});

describe("agentDescriptors / extractInlineRaw", () => {
  it("CUSTOM -> {custom:{inlineContent}}", () => {
    expect(agentDescriptors("CUSTOM", "{}")).toEqual({ custom: { inlineContent: "{}" } });
  });

  it("A2A -> {a2a:{agentCard:{inlineContent, schemaVersion}}}", () => {
    const d = agentDescriptors("A2A", "{}");
    expect(d).toEqual({ a2a: { agentCard: { inlineContent: "{}", schemaVersion: "0.3" } } });
    expect(A2A_SCHEMA_VERSION).toBe("0.3");
  });

  it("extracts inline content for every type", () => {
    expect(extractInlineRaw("CUSTOM", { custom: { inlineContent: "a" } })).toBe("a");
    expect(extractInlineRaw("A2A", { a2a: { agentCard: { inlineContent: "b" } } })).toBe("b");
    expect(extractInlineRaw("MCP", { mcp: { server: { inlineContent: "c" } } })).toBe("c");
    expect(extractInlineRaw("AGENT_SKILLS", { agentSkills: { skillMd: { inlineContent: "d" } } })).toBe("d");
    expect(extractInlineRaw("CUSTOM", undefined)).toBeUndefined();
  });
});

describe("agentDescription", () => {
  it("falls back description -> first sentence of system prompt (<=200) -> generic", () => {
    expect(agentDescription({ ...runtime, description: "  Explicit.  " })).toBe("Explicit.");
    expect(agentDescription(runtime)).toBe("You are a fake agent.");
    expect(agentDescription({ ...runtime, systemPrompt: "\n\nFirst line\nsecond line" })).toBe("First line");
    expect(agentDescription({ ...runtime, systemPrompt: "a".repeat(500) }).length).toBeLessThanOrEqual(200);
    expect(agentDescription({ name: "h1", type: "harness" })).toBe("harness agent h1");
  });
});

describe("findRegisteredRecord", () => {
  const agent = { name: "fake_agent", arn: FAKE_ARN };

  it("matches by ARN inside CUSTOM content", () => {
    const m = findRegisteredRecord(agent, [{ registryId: "r1", record: rec("renamed"), raw: customRawFor(FAKE_ARN) }]);
    expect(m).toMatchObject({ registryId: "r1", matchedBy: "arn" });
  });

  it("matches by ARN via the A2A url", () => {
    const raw = JSON.stringify({ name: "card", url: a2aInvocationUrl({ arn: FAKE_ARN, type: "runtime" }) });
    expect(rawReferencesArn(raw, FAKE_ARN)).toBe(true);
    const m = findRegisteredRecord(agent, [{ registryId: "r1", record: rec("card"), raw }]);
    expect(m?.matchedBy).toBe("arn");
  });

  it("ARN match beats a different record with the same name", () => {
    const candidates: RegistrationCandidate[] = [
      { registryId: "r1", record: rec("fake_agent", "APPROVED", "same-name"), raw: customRawFor(OTHER_ARN) },
      { registryId: "r2", record: rec("other", "APPROVED", "by-arn"), raw: customRawFor(FAKE_ARN) },
    ];
    const m = findRegisteredRecord(agent, candidates);
    expect(m).toMatchObject({ registryId: "r2", matchedBy: "arn" });
    expect(m?.record.recordId).toBe("by-arn");
  });

  it("falls back to exact name when no raw is available", () => {
    const m = findRegisteredRecord(agent, [
      { registryId: "r1", record: rec("fake") },
      { registryId: "r2", record: rec("fake_agent") },
    ]);
    expect(m).toMatchObject({ registryId: "r2", matchedBy: "name" });
  });

  it("does not match a different ARN sharing a prefix", () => {
    const url = a2aInvocationUrl({ arn: OTHER_ARN, type: "runtime" });
    expect(rawReferencesArn(customRawFor(OTHER_ARN), FAKE_ARN)).toBe(false);
    expect(rawReferencesArn(JSON.stringify({ url }), FAKE_ARN)).toBe(false);
    expect(rawReferencesArn("not json", FAKE_ARN)).toBe(false);
    expect(rawReferencesArn(customRawFor(FAKE_ARN), "")).toBe(false);
    expect(findRegisteredRecord(agent, [{ registryId: "r1", record: rec("x"), raw: customRawFor(OTHER_ARN) }])).toBeNull();
  });

  it("ignores REJECTED, DEPRECATED and CREATE_FAILED records", () => {
    const candidates = ["REJECTED", "DEPRECATED", "CREATE_FAILED"].map((s) => ({
      registryId: "r1",
      record: rec("fake_agent", s),
      raw: customRawFor(FAKE_ARN),
    }));
    expect(findRegisteredRecord(agent, candidates)).toBeNull();
  });

  it("returns null when nothing matches; empty arn never matches", () => {
    expect(findRegisteredRecord(agent, [])).toBeNull();
    expect(findRegisteredRecord(agent, [{ registryId: "r1", record: rec("nope"), raw: customRawFor("") }])).toBeNull();
    expect(
      findRegisteredRecord({ name: "zzz", arn: "" }, [{ registryId: "r1", record: rec("a"), raw: customRawFor("") }])
    ).toBeNull();
  });
});

describe("no hardcoding", () => {
  it("serialized drafts carry only the fake ARN's account and region", () => {
    for (const type of ["CUSTOM", "A2A"] as const) {
      for (const t of ["runtime", "harness"] as const) {
        const raw = agentToRecordDraft({ ...runtime, type: t }, type).raw;
        const text = raw + decodeURIComponent(JSON.parse(raw).url ?? "");
        const accounts = new Set(text.match(/(?<!\d)\d{12}(?!\d)/g) ?? []);
        expect([...accounts]).toEqual(["000011112222"]);
        const regions = new Set(text.match(/\b[a-z]{2}(?:-gov)?-[a-z]+-\d\b/g) ?? []);
        expect([...regions]).toEqual(["eu-west-3"]);
      }
    }
  });
});
