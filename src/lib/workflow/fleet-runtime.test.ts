import { describe, it, expect, vi } from "vitest";

/**
 * Topology-aware fleet runtime resolution (TEAM-4498 review fix).
 *
 * `agentcore_hub_agent` is deployed ONLY when WORKFLOW_RUNTIME_COUNT=1, and 14 is
 * the default — so resolving the fleet by that single name found nothing on a
 * normal deployment and idle chat answered 503 with the fleet fully deployed.
 */

vi.mock("@/lib/agentcore-sdk", () => ({
  DEFAULT_REGION: "us-east-1",
  discoverAgents: async () => discovered,
}));

let discovered: Array<{ id: string; name: string; arn: string; type: string }> = [];

const { fleetRuntimeNames, isPersonaRuntimeArn, resolveFleetRuntimeArn } = await import(
  "./fleet-runtime"
);

const arn = (name: string) =>
  `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}-AbCdEf`;
const runtime = (name: string) => ({ id: name, name, arn: arn(name), type: "runtime" });

describe("fleetRuntimeNames", () => {
  it.each([
    ["agentcore_hub_requirements_analyst", "agentcore_hub_requirements"],
    ["agentcore_hub_frontend_designer", "agentcore_hub_design"],
    ["agentcore_hub_backend_dev", "agentcore_hub_development"],
    ["agentcore_hub_qa_verifier", "agentcore_hub_qaci"], // verification
    ["agentcore_hub_code_reviewer", "agentcore_hub_qaci"], // review
  ])("maps %s to the %s anchor, mirroring deploy-topology.sh arn_for()", (agentId, anchor) => {
    expect(fleetRuntimeNames(agentId)).toEqual([agentId, anchor, "agentcore_hub_agent"]);
  });

  it("sends a phase the topology script does not know to the requirements anchor", () => {
    // arn_for()'s own `return anchor_req` fallback — the roster has phases like
    // "ship" and "triage" that predate the 4-anchor split.
    expect(fleetRuntimeNames("agentcore_hub_release_manager")[1]).toBe(
      "agentcore_hub_requirements"
    );
  });

  it("never repeats a name", () => {
    const names = fleetRuntimeNames("agentcore_hub_agent");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("isPersonaRuntimeArn", () => {
  const persona = "agentcore_hub_code_reviewer";

  it.each([
    ["its own runtime (14-mode)", arn(persona)],
    ["its phase anchor (4-mode)", arn("agentcore_hub_qaci")],
    ["the single host (1-mode)", arn("agentcore_hub_agent")],
  ])("accepts %s", (_label, value) => {
    expect(isPersonaRuntimeArn(value, persona)).toBe(true);
  });

  it.each([
    ["another persona's runtime", arn("agentcore_hub_backend_dev")],
    ["a different phase anchor", arn("agentcore_hub_design")],
    ["the coding runtime", arn("agentcore_hub_coding_runtime")],
    ["a lambda ARN", "arn:aws:lambda:us-east-1:123456789012:function:evil"],
    ["a URL", "https://evil.example/hook"],
    ["a runtime ARN with a bogus account", "arn:aws:bedrock-agentcore:us-east-1:x:runtime/agentcore_hub_agent-A"],
    ["empty", ""],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(isPersonaRuntimeArn(value, persona)).toBe(false);
  });

  it("accepts a name-prefix match but not a name that merely starts the same", () => {
    // agentcore_hub_qaci-XYZ is the deployed anchor; agentcore_hub_qaci_shadow is not.
    expect(isPersonaRuntimeArn(arn("agentcore_hub_qaci"), persona)).toBe(true);
    expect(
      isPersonaRuntimeArn(
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agentcore_hub_qaci_shadow",
        persona
      )
    ).toBe(false);
  });
});

describe("resolveFleetRuntimeArn", () => {
  const persona = "agentcore_hub_code_reviewer";

  it("prefers the persona's own runtime when the fleet is 14 runtimes", async () => {
    discovered = [runtime("agentcore_hub_qaci"), runtime(persona), runtime("agentcore_hub_agent")];
    expect(await resolveFleetRuntimeArn(persona, "us-east-1")).toBe(arn(persona));
  });

  it("uses the phase anchor when the fleet is 4 runtimes", async () => {
    discovered = [runtime("agentcore_hub_requirements"), runtime("agentcore_hub_qaci")];
    expect(await resolveFleetRuntimeArn(persona, "us-east-1")).toBe(arn("agentcore_hub_qaci"));
  });

  it("uses the single host when the fleet is 1 runtime", async () => {
    discovered = [runtime("agentcore_hub_agent")];
    expect(await resolveFleetRuntimeArn(persona, "us-east-1")).toBe(arn("agentcore_hub_agent"));
  });

  it("ignores harness entries and unrelated runtimes", async () => {
    discovered = [
      { ...runtime("agentcore_hub_code_reviewer"), type: "harness" },
      runtime("something_else"),
    ];
    expect(await resolveFleetRuntimeArn(persona, "us-east-1")).toBeNull();
  });
});
