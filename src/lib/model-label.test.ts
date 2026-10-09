/**
 * The derivation behind every "which model does this run?" cell.
 *
 * Its whole reason to exist: `GET /api/models/registry` sends the resolution chain
 * (`{modelId, source, via?}`) and the catalog, NOT display strings. A frontend that
 * expects `label`/`shortLabel`/`inherited` on the wire reads undefined off every
 * entry and renders a dash for the entire fleet — which is exactly what shipped
 * (TEAM-5010 finding 1). So the fixtures below are the REAL response shape, and a
 * regression that reintroduces the invented fields fails here rather than in a
 * screenshot.
 */

import { describe, expect, it } from "vitest";
import { deriveResolved, provenanceCaption, shortModelId } from "./model-label";
import type { CatalogLabelRow, ResolvedModelEntry } from "./model-label";

const FABLE = "us.anthropic.claude-fable-5-1";
const OPUS5 = "us.anthropic.claude-opus-5";
const SONNET = "us.anthropic.claude-sonnet-5";
const UNLISTED = "us.anthropic.claude-nova-preview";

/** Mirrors the catalog labels in the src/config/models.json seed. */
const CATALOG: CatalogLabelRow[] = [
  { modelId: FABLE, label: "Claude Fable 5.1" },
  { modelId: OPUS5, label: "Claude Opus 5" },
  { modelId: SONNET, label: "Claude Sonnet 5" },
  // A row with no label at all — tolerated documents exist.
  { modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
];

// Mirrors the assertions in src/app/api/models/registry/route.test.ts:189-202 on
// feature/TEAM-4997-api-dev (agentcore_hub_workflow_manager / telegram_intake /
// agentcore_hub_qa_verifier), hand-copied because the API files are not on this branch.
const RESOLVED: Record<string, ResolvedModelEntry> = {
  agentcore_hub_workflow_manager: {
    modelId: FABLE,
    source: "agents",
    via: "catalog",
    // The registry says fable-5.1, the harness runs opus-5 — visible, not hidden.
    harnessModel: OPUS5,
  },
  telegram_intake: { modelId: SONNET, source: "agents" },
  agentcore_hub_qa_verifier: { modelId: FABLE, source: "defaults", via: "catalog" },
};

describe("deriveResolved — the fields the wire does not carry", () => {
  it("labels a per-agent pin with the catalog name and marks it NOT inherited", () => {
    const got = deriveResolved(RESOLVED.agentcore_hub_workflow_manager, CATALOG);
    expect(got).toEqual({ label: "Claude Fable 5.1", shortLabel: "Claude Fable 5.1", inherited: false });
  });

  it("a pin with no `via` is still a pin — source alone decides inheritance", () => {
    // telegram_intake is pinned in defaults.agents but the GET omitted `via`.
    expect(deriveResolved(RESOLVED.telegram_intake, CATALOG)).toEqual({
      label: "Claude Sonnet 5",
      shortLabel: "Claude Sonnet 5",
      inherited: false,
    });
  });

  it("the persona default is inherited, even though it is the same model as a pin", () => {
    const pinned = deriveResolved(RESOLVED.agentcore_hub_workflow_manager, CATALOG);
    const inherited = deriveResolved(RESOLVED.agentcore_hub_qa_verifier, CATALOG);
    // Same modelId, same label — only the provenance differs, which is the whole
    // point of `inherited`: it describes WHY, not WHAT.
    expect(inherited.label).toBe(pinned.label);
    expect(inherited.inherited).toBe(true);
  });

  it("an explicit override is not inherited", () => {
    expect(deriveResolved({ modelId: OPUS5, source: "override", via: "tier" }, CATALOG).inherited).toBe(false);
  });

  it.each(["env", "literal"] as const)("a %s fallback is inherited — nobody pinned it", (source) => {
    expect(deriveResolved({ modelId: FABLE, source }, CATALOG).inherited).toBe(true);
  });

  it("an id with no catalog row falls back to the id, never to nothing", () => {
    // The passthrough case: MODEL_ID names something the catalog has not adopted.
    // A bare id is a worse label than "Claude Nova preview" and a far better one
    // than the dash this used to render.
    expect(deriveResolved({ modelId: UNLISTED, source: "env", via: "passthrough" }, CATALOG)).toEqual({
      label: UNLISTED,
      shortLabel: UNLISTED,
      inherited: true,
    });
  });

  it("a catalog row with no label behaves like no row at all", () => {
    const haiku = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const got = deriveResolved({ modelId: haiku, source: "defaults", via: "catalog" }, CATALOG);
    expect(got.label).toBe(haiku);
    // shortModelId drops the `:0` version suffix.
    expect(got.shortLabel).toBe("us.anthropic.claude-haiku-4-5-20251001-v1");
  });

  it("a missing catalog is a worse label, not an exception", () => {
    // A half-failed read or a cached pre-catalog document must still render.
    expect(() => deriveResolved(RESOLVED.telegram_intake, undefined)).not.toThrow();
    expect(deriveResolved(RESOLVED.telegram_intake, undefined)).toEqual({
      label: SONNET,
      shortLabel: SONNET,
      inherited: false,
    });
  });

  it("an empty modelId derives empty labels — the dash case the hook renders", () => {
    // `resolve()` returns its UNKNOWN sentinel for an agent id the registry has
    // never heard of; this is the other half, a row whose id is blank.
    expect(deriveResolved({ modelId: "", source: "literal" }, CATALOG)).toEqual({
      label: "",
      shortLabel: "",
      inherited: true,
    });
  });
});

describe("provenanceCaption — say where the model came from, honestly", () => {
  it.each([
    ["agents", "Override"],
    ["override", "Override"],
    ["defaults", "Inherited from defaults.persona"],
    ["env", "Resolved via env"],
    ["literal", "Resolved via literal"],
  ] as const)("%s → %s", (source, expected) => {
    expect(provenanceCaption(source)).toBe(expected);
  });

  it("never claims defaults.persona for a fallback", () => {
    // The pre-fix caption was `inherited ? "Inherited from defaults.persona" : …`,
    // which told an operator to go look at a defaults.persona they never set.
    for (const source of ["env", "literal"] as const) {
      expect(provenanceCaption(source)).not.toContain("defaults.persona");
    }
  });
});

describe("shortModelId", () => {
  it("returns a dotted id unchanged — there is nothing to strip", () => {
    expect(shortModelId(FABLE)).toBe(FABLE);
  });

  it("drops an ARN-ish path prefix", () => {
    expect(shortModelId(`arn:aws:bedrock:us-east-1::foundation-model/${OPUS5}`)).toBe(OPUS5);
  });

  it("drops a :version suffix", () => {
    expect(shortModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1",
    );
  });

  it("is empty for an empty id, so a caller can test it for truthiness", () => {
    expect(shortModelId("")).toBe("");
  });
});
