import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import fixtureFile from "@/config/__fixtures__/models-registry.case.json";
import seedJson from "@/config/models.json";
import bundledPricingJson from "@/config/pricing.json";
import type { ResolveDiagnostic } from "@/lib/models-registry";

/**
 * TEAM-4997 — the model registry's contract.
 *
 * Two layers of coverage, deliberately:
 *  1. Every case in src/config/__fixtures__/models-registry.case.json, which is
 *     the LANGUAGE-NEUTRAL contract the sibling Python/Lambda twin imports. A
 *     case that passes here and fails there (or vice versa) is the bug this
 *     epic exists to kill, so the fixture is iterated whole — no cherry-picking.
 *  2. Literal pins on the seed itself, because the seed's job is to encode
 *     TODAY'S live routing exactly. If a value here changes, some agent's model
 *     changed, and that must be a deliberate diff.
 *
 * REGENERATING src/config/pricing.json:
 *     REGEN_PRICING_JSON=1 npx vitest run src/lib/models-registry.test.ts
 * writes the projection instead of asserting against it. Then re-run WITHOUT
 * the env var — the byte-equality test is what keeps the generated file and the
 * catalog from drifting, and it is the only sanctioned way to edit pricing.json.
 */

const h = vi.hoisted(() => ({
  state: {
    /** S3 key → body. `undefined` = NoSuchKey. */
    objects: {} as Record<string, string>,
    puts: [] as Array<{ Key: string; Body: string; IfMatch?: string }>,
    /** Errors to throw from the next PutObject calls, in order. */
    putErrors: [] as Array<Error | null>,
    /** Errors to throw from the next GetObject calls, in order. */
    getErrors: [] as Array<Error | null>,
    /** How many GetObject calls reached S3 — the TTL's observable effect. */
    getCalls: 0,
    etag: '"etag-1"',
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      if (name === "GetObjectCommand") {
        h.state.getCalls++;
        const forced = h.state.getErrors.shift();
        if (forced) throw forced;
        const key = cmd.input.Key as string;
        const body = h.state.objects[key];
        if (body === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { ETag: h.state.etag, Body: { transformToString: async () => body } };
      }
      if (name === "PutObjectCommand") {
        const next = h.state.putErrors.shift();
        h.state.puts.push({
          Key: cmd.input.Key as string,
          Body: cmd.input.Body as string,
          IfMatch: cmd.input.IfMatch as string | undefined,
        });
        if (next) throw next;
        h.state.objects[cmd.input.Key as string] = cmd.input.Body as string;
        return { ETag: h.state.etag };
      }
      throw new Error(`unexpected S3 command ${name}`);
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

type Reg = typeof import("@/lib/models-registry");

let mod: Reg;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("@/lib/models-registry");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

interface FixturePatch {
  defaults?: Record<string, string>;
  tiers?: { claude?: Record<string, string>; codex?: Record<string, string> };
  agents?: Record<string, string>;
  legacyAliases?: Record<string, string>;
  quarantine?: string[];
  addRows?: Array<Record<string, unknown>>;
  dropRowFields?: Array<{ modelId: string; fields: string[] }>;
}

interface FixtureCase {
  name: string;
  note?: string;
  registry: "seed" | null;
  patch?: FixturePatch;
  input: {
    kind: "resolveModel" | "resolveAgentModel" | "resolveCodingModel" | "parse" | "validate" | "projection";
    value?: string;
    cli?: "claude" | "codex";
    agentId?: string;
    override?: string;
    env?: Record<string, string>;
    previousPricing?: Record<string, unknown> | null;
  };
  expected: Record<string, unknown>;
}

const CASES = (fixtureFile as unknown as { cases: FixtureCase[] }).cases;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Typed patch ops rather than dotted paths: model ids contain dots, so
 * "catalog.us.anthropic.claude-opus-5.price" would be ambiguous.
 */
function rawRegistryFor(c: FixtureCase): Record<string, unknown> | null {
  if (c.registry === null) return null;
  const raw = clone(seedJson) as unknown as Record<string, unknown>;
  const p = c.patch;
  if (!p) return raw;
  if (p.defaults) Object.assign(raw.defaults as object, p.defaults);
  if (p.tiers) {
    const tiers = raw.tiers as Record<string, Record<string, string>>;
    for (const [cli, map] of Object.entries(p.tiers)) Object.assign(tiers[cli], map);
  }
  if (p.agents) Object.assign(raw.agents as object, p.agents);
  if (p.legacyAliases) Object.assign(raw.legacyAliases as object, p.legacyAliases);
  if (p.quarantine) raw.quarantine = clone(p.quarantine);
  if (p.addRows) (raw.catalog as unknown[]).push(...clone(p.addRows));
  for (const drop of p.dropRowFields || []) {
    const row = (raw.catalog as Array<Record<string, unknown>>).find((r) => r.modelId === drop.modelId);
    expect(row, `dropRowFields target ${drop.modelId} must exist in the seed`).toBeTruthy();
    for (const field of drop.fields) delete row![field];
  }
  return raw;
}

const SEED = () => mod.parseModelsRegistry(clone(seedJson) as unknown as Record<string, unknown>).registry;

// ---------------------------------------------------------------------------
// 1. The language-neutral fixture, whole
// ---------------------------------------------------------------------------

describe("models-registry fixture contract", () => {
  it("exercises every case in the fixture file", () => {
    // Guards against a case being silently dropped from the loop below.
    expect(CASES.length).toBe(26);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  for (const c of CASES) {
    it(`${c.name}`, () => {
      const raw = rawRegistryFor(c);
      const parsed = raw ? mod.parseModelsRegistry(raw) : null;
      const registry = parsed?.registry ?? null;
      const env = c.input.env ?? {};

      switch (c.input.kind) {
        case "resolveModel": {
          const got = mod.resolveModel(registry, c.input.value, { cli: c.input.cli });
          expect(got, `${c.name} must resolve`).not.toBeNull();
          expect(got!.modelId).toBe(c.expected.modelId);
          expect(got!.source).toBe(c.expected.source);
          expect(mod.LOOKUP_KINDS).toContain(got!.source);
          break;
        }
        case "resolveAgentModel": {
          const got = mod.resolveAgentModel(registry, c.input.agentId!, c.input.override ?? null, env);
          expect(got.modelId).toBe(c.expected.modelId);
          expect(got.source).toBe(c.expected.source);
          expect(mod.CHAIN_STEPS).toContain(got.source);
          if (c.expected.via !== undefined) expect(got.via).toBe(c.expected.via);
          if (c.expected.diagnostics !== undefined) {
            expect((got.diagnostics ?? []).map((d) => ({ step: d.step, reason: d.reason }))).toEqual(
              c.expected.diagnostics
            );
          }
          break;
        }
        case "resolveCodingModel": {
          const got = mod.resolveCodingModel(registry, c.input.value ?? null, c.input.cli!, env);
          expect(got.modelId).toBe(c.expected.modelId);
          expect(got.endpoint).toBe(c.expected.endpoint);
          expect(got.region).toBe(c.expected.region);
          expect(got.api).toBe(c.expected.api);
          expect(got.source).toBe(c.expected.source);
          if (c.expected.via !== undefined) expect(got.via).toBe(c.expected.via);
          break;
        }
        case "parse": {
          const ids = parsed!.registry.catalog.map((r) => r.modelId);
          for (const id of c.expected.catalogIdsInclude as string[]) expect(ids).toContain(id);
          for (const id of c.expected.catalogIdsExclude as string[]) expect(ids).not.toContain(id);
          expect(parsed!.warnings.map((w) => ({ modelId: w.modelId, reason: w.reason }))).toEqual(
            c.expected.warnings
          );
          break;
        }
        case "validate": {
          const result = mod.validateRegistry(registry!);
          expect(result.ok).toBe(c.expected.ok);
          expect(result.errors).toEqual(c.expected.errors);
          break;
        }
        case "projection": {
          const prev = (c.input.previousPricing ?? null) as unknown as typeof bundledPricingJson | null;
          const doc = mod.pricingProjection(
            registry!,
            prev as never,
            bundledPricingJson as unknown as never
          );
          if (c.expected.keyOrder) expect(Object.keys(doc.models)).toEqual(c.expected.keyOrder);
          if (c.expected.topLevelKeyOrder) expect(Object.keys(doc)).toEqual(c.expected.topLevelKeyOrder);
          for (const [id, entry] of Object.entries((c.expected.spot ?? {}) as Record<string, unknown>)) {
            expect(doc.models[id], `spot ${id}`).toEqual(entry);
          }
          for (const key of (c.expected.carried ?? []) as string[]) {
            expect(doc[key as keyof typeof doc], `carried ${key}`).toBeDefined();
          }
          for (const key of (c.expected.carriedEqualsPrevious ?? []) as string[]) {
            expect(doc[key as keyof typeof doc], `carried ${key}`).toEqual(
              (c.input.previousPricing as Record<string, unknown>)[key]
            );
          }
          for (const id of (c.expected.modelsExclude ?? []) as string[]) {
            expect(doc.models[id]).toBeUndefined();
          }
          break;
        }
      }
    });
  }

  it("every fixture source/via is in the closed enum", () => {
    // A stray "alias" / "default" / "legacy" would break the Python twin and the
    // /models UI silently; it fails the suite instead.
    for (const c of CASES) {
      for (const key of ["source", "via"] as const) {
        const v = c.expected[key];
        if (v === undefined) continue;
        expect(mod.MODEL_SOURCES, `${c.name}.${key}`).toContain(v);
      }
    }
    expect(mod.MODEL_SOURCES).toEqual([
      "override",
      "agents",
      "defaults",
      "env",
      "literal",
      "tier",
      "legacyAlias",
      "catalog",
      "passthrough",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. The seed encodes today's live routing
// ---------------------------------------------------------------------------

describe("seed", () => {
  it("parses with no warnings and 21 rows", () => {
    const { registry, warnings } = mod.parseModelsRegistry(clone(seedJson) as unknown as Record<string, unknown>);
    expect(warnings).toEqual([]);
    expect(registry.catalog).toHaveLength(21);
    expect(registry.version).toBe(1);
    expect(registry.updatedBy).toBe("seed");
  });

  it("pins the live routing literally", () => {
    const reg = SEED();
    expect(reg.defaults).toEqual({
      persona: "us.anthropic.claude-fable-5-1",
      codingClaude: "us.anthropic.claude-fable-5-1",
      codingCodex: "openai.gpt-5.5",
    });
    expect(reg.tiers.claude).toEqual({
      fable: "us.anthropic.claude-fable-5-1",
      opus: "us.anthropic.claude-opus-5",
      sonnet: "us.anthropic.claude-sonnet-5",
      haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(reg.tiers.codex).toEqual({
      astra: "us.openai.gpt-6-astra",
      sol: "us.openai.gpt-6-sol",
      terra: "us.openai.gpt-5.6-terra",
      luna: "us.openai.gpt-6-luna",
    });
    expect(reg.agents).toEqual({
      agentcore_hub_workflow_manager: "us.anthropic.claude-fable-5-1",
      telegram_intake: "us.anthropic.claude-sonnet-5",
    });
    expect(reg.legacyAliases).toEqual({
      "claude-opus-46": "us.anthropic.claude-opus-5",
      "claude-opus-47": "us.anthropic.claude-opus-5",
      "claude-sonnet-45": "us.anthropic.claude-sonnet-5",
      "claude-sonnet-46": "us.anthropic.claude-sonnet-5",
    });
    expect(reg.quarantine).toEqual([]);
    expect(reg.autoAdopt).toEqual({});
  });

  it("validates clean", () => {
    const result = mod.validateRegistry(SEED());
    expect(result.errors).toEqual({});
    expect(result.ok).toBe(true);
  });

  it("carries every harness lane id exactly once", () => {
    // The 8 lane ids live harness configs already reference. Lanes on RETIRED
    // rows must stay resolvable, or a deployed harness loses its model.
    const lanes = SEED().catalog.flatMap((r) => (r.harnessLanes || []).map((l) => `${l.id}|${r.modelId}`));
    expect(lanes.sort()).toEqual(
      [
        "claude-fable-5-1|us.anthropic.claude-fable-5-1",
        "claude-fable-5|us.anthropic.claude-fable-5",
        "claude-opus-4-6|us.anthropic.claude-opus-4-6",
        "claude-opus-4-8-mantle-chat|us.anthropic.claude-opus-4-8",
        "claude-opus-4-8-mantle|us.anthropic.claude-opus-4-8",
        "claude-opus-5|us.anthropic.claude-opus-5",
        "claude-sonnet-4-6|us.anthropic.claude-sonnet-4-6",
        "claude-sonnet-5|us.anthropic.claude-sonnet-5",
      ].sort()
    );
  });

  it("prices the rows whose rates the ticket repriced or called out", () => {
    const byId = new Map(SEED().catalog.map((r) => [r.modelId, r]));
    // Repriced from 1.25/10 — the one intentional cost-math change.
    expect(byId.get("openai.gpt-5.5")!.price).toMatchObject({ input: 5.5, output: 33, cacheReadInput: 0.55 });
    // Fable 5.1 bills cache reads at 2.5% of input, not the 10% default.
    expect(byId.get("us.anthropic.claude-fable-5-1")!.price).toMatchObject({ input: 11, output: 55, cacheReadInput: 0.275 });
    // Opus 5.5 is an EXPLICIT 5%; Opus 5 has none and takes the 10% default.
    expect(byId.get("us.anthropic.claude-opus-5-5")!.price).toMatchObject({ input: 4.4, output: 22, cacheReadInput: 0.22 });
    expect(byId.get("us.anthropic.claude-opus-5")!.price!.cacheReadInput).toBeUndefined();
    // global.* rates genuinely differ from us.*, which is why they are rows.
    expect(byId.get("global.anthropic.claude-opus-5")!.price).toMatchObject({ input: 5, output: 25, cacheReadInput: 0.5 });
    expect(byId.get("global.anthropic.claude-fable-5-1")!.price).toMatchObject({ input: 10, output: 50, cacheReadInput: 0.25 });
    // Every OpenAI row carries the >272k long-context tier at 2x.
    for (const row of SEED().catalog.filter((r) => r.vendor === "openai")) {
      expect(row.price!.longContext, row.modelId).toMatchObject({ thresholdInputTokens: 272_000 });
      expect(row.price!.longContext!.input).toBeCloseTo(row.price!.input * 2, 6);
      expect(row.price!.longContext!.output).toBeCloseTo(row.price!.output * 2, 6);
    }
  });

  it("refuses the read-only eval-judge row as a routing target", () => {
    const reg = SEED();
    reg.agents = { agentcore_hub_agent: "anthropic.claude-opus-5" };
    expect(mod.validateRegistry(reg).errors["agents.agentcore_hub_agent"]).toBe("read_only");
  });
});

// ---------------------------------------------------------------------------
// 3. Resolution
// ---------------------------------------------------------------------------

describe("resolveModel is pure", () => {
  it("returns null — never a substitute — for quarantined, retired and unknown input", () => {
    const reg = SEED();
    reg.quarantine = ["us.anthropic.claude-opus-5"];

    const diag: ResolveDiagnostic[] = [];
    expect(mod.resolveModel(reg, "us.anthropic.claude-opus-5", { diagnostics: diag })).toBeNull();
    expect(mod.resolveModel(reg, "us.anthropic.claude-fable-5", { diagnostics: diag })).toBeNull();
    expect(mod.resolveModel(reg, "totally-new-word", { diagnostics: diag })).toBeNull();
    expect(diag.map((d) => d.reason)).toEqual(["quarantined", "inactive", "unknown"]);
  });

  it("rejects a quarantined TARGET reached through a tier, with or without an explicit cli", () => {
    const reg = SEED();
    reg.quarantine = ["us.anthropic.claude-opus-5"];
    expect(mod.resolveModel(reg, "opus", { cli: "claude" })).toBeNull();
    // DD3: tiers.claude applies with no cli at all, same as cli:"claude".
    expect(mod.resolveModel(reg, "opus")).toBeNull();
  });

  it("DD3 — tiers.claude applies when ctx.cli is undefined, tiers.codex only with cli:\"codex\"", () => {
    const reg = SEED();
    // "sol" is a codex tier word; with no cli (the persona chain's call shape)
    // it must not resolve through tiers.codex.
    expect(mod.resolveModel(reg, "sol")).toBeNull();
    expect(mod.resolveModel(reg, "sol", { cli: "codex" })?.source).toBe("tier");
    // "opus" is a Claude tier word; with no cli it resolves via tiers.claude.
    const viaNoCli = mod.resolveModel(reg, "opus");
    expect(viaNoCli?.source).toBe("tier");
    expect(viaNoCli?.modelId).toBe("us.anthropic.claude-opus-5");
  });

  it("passes an undiscovered vendor-qualified id through but rejects a bare word", () => {
    const reg = SEED();
    expect(mod.resolveModel(reg, "vendor.model-x")!.source).toBe("passthrough");
    expect(mod.resolveModel(reg, "totally-new-model")).toBeNull();
  });

  it("rejects an injected model id instead of passing it to an AWS API", () => {
    const reg = SEED();
    for (const bad of [
      "us.anthropic.claude-opus-5; rm -rf /",
      "us.anthropic.claude-opus-5\nMODEL_ID=evil",
      'us.anthropic.claude-opus-5"',
      "us.anthropic.claude-opus-5 --flag",
      "$(whoami).model",
      "../../etc/passwd",
    ]) {
      expect(mod.MODEL_ID_RE.test(bad), bad).toBe(false);
      expect(mod.resolveModel(reg, bad), bad).toBeNull();
    }
    expect(mod.MODEL_ID_RE.test("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
    expect(mod.MODEL_ID_RE.test("us.openai.gpt-5.6-terra")).toBe(true);
  });
});

describe("resolveAgentModel owns the chain", () => {
  it("never returns modelless, even with everything quarantined", () => {
    const reg = SEED();
    reg.quarantine = [...reg.catalog.map((r) => r.modelId)];
    const got = mod.resolveAgentModel(reg, "agentcore_hub_backend_dev", null, {});
    expect(got.modelId).toBe(mod.LITERAL_PERSONA_DEFAULT);
    expect(got.source).toBe("literal");
  });

  it("resolves every deployable agent id", () => {
    const reg = SEED();
    const ids = mod.deployableAgentIds();
    expect(ids).toContain("agentcore_hub_workflow_manager");
    expect(ids).toContain("telegram_intake");
    expect(ids.length).toBeGreaterThan(40);
    for (const id of ids) {
      const got = mod.resolveAgentModel(reg, id, null, {});
      expect(mod.MODEL_ID_RE.test(got.modelId), id).toBe(true);
      expect(mod.CHAIN_STEPS).toContain(got.source);
    }
  });
});

describe("validateRegistry", () => {
  it("rejects an agents key that is not a deployable agent", () => {
    const reg = SEED();
    reg.agents = {
      personal_assistant_agent: "us.anthropic.claude-sonnet-5",
      telegram_intake: "us.anthropic.claude-sonnet-5",
      not_an_agent: "us.anthropic.claude-sonnet-5",
    };
    const result = mod.validateRegistry(reg);
    expect(result.errors).toEqual({ "agents.not_an_agent": "unknown_agent" });
  });

  it("rejects two rows claiming one harness lane id", () => {
    const reg = SEED();
    reg.catalog.push({
      ...reg.catalog.find((r) => r.modelId === "us.anthropic.claude-sonnet-5")!,
      modelId: "us.anthropic.claude-sonnet-5-copy",
      aliases: [],
    });
    expect(mod.validateRegistry(reg).errors["catalog.us.anthropic.claude-sonnet-5-copy.harnessLanes.claude-sonnet-5"]).toBe(
      "duplicate_lane"
    );
  });

  it("rejects a lane apiKeyArn that is not a Secrets Manager ARN", () => {
    const reg = SEED();
    const row = reg.catalog.find((r) => r.modelId === "us.anthropic.claude-fable-5-1")!;
    row.harnessLanes![0].apiKeyArn = "not-an-arn";
    expect(mod.validateRegistry(reg).errors["catalog.us.anthropic.claude-fable-5-1.harnessLanes.claude-fable-5-1.apiKeyArn"]).toBe(
      "bad_api_key_arn"
    );
  });

  it("refuses a candidate target with only one green probe — both planes or neither", () => {
    const green = { ok: true, at: "2026-09-20T00:00:00.000Z" };
    const reg = SEED();
    const row = reg.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!;
    row.status = "candidate";
    reg.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5-5";

    row.probe = { api: green };
    expect(mod.validateRegistry(reg).errors["agents.agentcore_hub_workflow_manager"]).toBe("unprobed");
    row.probe = { cli: green };
    expect(mod.validateRegistry(reg).errors["agents.agentcore_hub_workflow_manager"]).toBe("unprobed");
    row.probe = { api: green, cli: green };
    expect(mod.validateRegistry(reg).errors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3b. Adoption — the rule that needs BOTH documents
// ---------------------------------------------------------------------------

describe("adoptionErrors", () => {
  const green = { ok: true, at: "2026-09-20T00:00:00.000Z" };

  it("passes a document whose routing did not change, probes or no probes", () => {
    expect(mod.adoptionErrors(SEED(), SEED())).toEqual({});
  });

  it("names every field that points a routing target at an unprobed model", () => {
    const next = SEED();
    next.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5-5";
    next.defaults.persona = "us.anthropic.claude-opus-5-5";
    expect(mod.adoptionErrors(SEED(), next)).toEqual({
      "agents.agentcore_hub_workflow_manager": "unprobed",
      "defaults.persona": "unprobed",
    });
  });

  it("adopts a model once both planes are green", () => {
    const next = SEED();
    next.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!.probe = { api: green, cli: green };
    next.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5-5";
    expect(mod.adoptionErrors(SEED(), next)).toEqual({});
  });

  it("compares models, not spellings: re-pointing a field at an alias of a live target is not an adoption", () => {
    const next = SEED();
    next.agents.agentcore_hub_workflow_manager = "claude-opus-5";
    expect(mod.adoptionErrors(SEED(), next)).toEqual({});
  });

  it("grandfathers a model the live document already routed to, wherever the new field is", () => {
    const live = SEED();
    live.defaults.persona = "us.anthropic.claude-opus-5-5";
    const next = SEED();
    // Same unprobed model, now pinned per-agent instead of as the default: it was
    // already carrying production traffic, so this is a move, not an adoption.
    next.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5-5";
    expect(mod.adoptionErrors(live, next)).toEqual({});
  });

  it("leaves an uncatalogued target to validateRegistry rather than calling it unprobed", () => {
    const next = SEED();
    next.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-nobody-has-heard-of";
    expect(mod.adoptionErrors(SEED(), next)).toEqual({});
    expect(mod.validateRegistry(next).errors["agents.agentcore_hub_workflow_manager"]).toBe("unknown_model");
  });

  it("ignores legacyAliases — a compat shim is not a way to adopt a model", () => {
    const next = SEED();
    next.legacyAliases["claude-opus-46"] = "us.anthropic.claude-opus-5-5";
    expect(mod.adoptionErrors(SEED(), next)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 4. The pricing projection
// ---------------------------------------------------------------------------

const PRICING_PATH = resolve(process.cwd(), "src/config/pricing.json");

/**
 * Every pricing key that existed before this ticket. A model id that falls out
 * of the projection silently reprices its whole history to the `default` rate —
 * the exact failure mode TEAM-4990 exists to remove — so this list is a
 * one-way ratchet: entries may be added, never dropped.
 */
const LEGACY_PRICING_KEYS = [
  "claude-fable-5",
  "us.anthropic.claude-fable-5",
  "claude-fable-5-1",
  "us.anthropic.claude-fable-5-1",
  "claude-opus-5",
  "us.anthropic.claude-opus-5",
  "claude-opus-4-8",
  "us.anthropic.claude-opus-4-8",
  "us.anthropic.claude-opus-4-7",
  "us.anthropic.claude-opus-4-6-v1",
  "claude-sonnet-5",
  "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-haiku-4-5",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-haiku-4-5-20251001",
  "openai.gpt-5.5",
  "openai.gpt-5.5-codex",
];

/** Every modelId the pre-registry harness catalog could pin a harness to. */
const FORMER_HARNESS_MODEL_IDS = [
  "us.anthropic.claude-fable-5",
  "us.anthropic.claude-fable-5-1",
  "us.anthropic.claude-opus-4-6",
  "us.anthropic.claude-opus-5",
  "us.anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-opus-4-8",
];

describe("pricingProjection", () => {
  it("is byte-identical to the committed src/config/pricing.json", () => {
    const doc = mod.pricingProjection(
      SEED(),
      bundledPricingJson as unknown as never,
      bundledPricingJson as unknown as never
    );
    const body = JSON.stringify(doc, null, 2) + "\n";
    if (process.env.REGEN_PRICING_JSON === "1") {
      writeFileSync(PRICING_PATH, body);
      return;
    }
    expect(body).toBe(readFileSync(PRICING_PATH, "utf8"));
  });

  it("prices every id that can reach the cost math — zero default hits", () => {
    const reg = SEED();
    const doc = mod.pricingProjection(reg, bundledPricingJson as unknown as never);
    const ids = new Set<string>([
      ...reg.catalog.map((r) => r.modelId),
      ...reg.catalog.flatMap((r) => r.aliases),
      ...LEGACY_PRICING_KEYS,
      ...FORMER_HARNESS_MODEL_IDS,
      ...Object.values(reg.defaults),
      ...Object.values(reg.tiers.claude),
      ...Object.values(reg.tiers.codex),
      ...Object.values(reg.agents),
      ...Object.keys(reg.legacyAliases),
      ...Object.values(reg.legacyAliases),
    ]);
    const missing = [...ids].filter((id) => !Object.prototype.hasOwnProperty.call(doc.models, id));
    // legacyAliases KEYS are routing sugar, never span ids, so they are the one
    // family the projection deliberately omits.
    expect(missing.sort()).toEqual(Object.keys(reg.legacyAliases).sort());
    for (const id of [...ids].filter((i) => !(i in reg.legacyAliases))) {
      expect(doc.models[id], `unpriced: ${id}`).toBeDefined();
    }
  });

  it("emits one key per row plus every alias, and never a cacheWrite", () => {
    const reg = SEED();
    const doc = mod.pricingProjection(reg, bundledPricingJson as unknown as never);
    const expectedCount = reg.catalog.length + reg.catalog.reduce((s, r) => s + r.aliases.length, 0);
    expect(Object.keys(doc.models)).toHaveLength(expectedCount);
    expect(Object.keys(doc.models)).toHaveLength(32);
    // cacheWrite stays a GLOBAL multiplier; a per-key absolute rate here would
    // be double-counted by modelCost.
    for (const [id, entry] of Object.entries(doc.models)) {
      for (const key of Object.keys(entry)) {
        expect(["input", "output", "cacheReadInput", "longContext"], `${id}.${key}`).toContain(key);
      }
    }
    // An alias prices identically to its row — that is the whole point.
    expect(doc.models["claude-fable-5-1"]).toEqual(doc.models["us.anthropic.claude-fable-5-1"]);
    expect(doc.models["openai.gpt-5.5-codex"]).toEqual(doc.models["openai.gpt-5.5"]);
  });

  it("names its provenance in _comment so nobody hand-edits it", () => {
    const reg = SEED();
    const doc = mod.pricingProjection(reg, bundledPricingJson as unknown as never);
    expect(doc._comment).toContain("Generated from config/models.json version 1");
    expect(doc._comment).toContain("Do not edit");
  });

  it("falls back PER KEY when the live document's carried keys are corrupt", () => {
    const reg = SEED();
    const bundled = bundledPricingJson as unknown as Record<string, unknown>;
    const prev = {
      models: {},
      default: { input: 0, output: 27.5 }, // zero rate — invalid
      cachedInputDiscount: 4, // > 1 — invalid
      cacheWriteMultiplier: { "5m": 1.3, "1h": 2.1, default: 1.3, _basis: "operator-tuned" }, // valid
      kiro: { usdPerCredit: "banana" }, // invalid
      agentcore: { runtimeGbHourUsd: 0.02, runtimeVcpuHourUsd: 0.1 }, // valid
    };
    const doc = mod.pricingProjection(reg, prev as never, bundled as never);
    // One corrupt key must not discard the other four.
    expect(doc.default).toEqual(bundled.default);
    expect(doc.cachedInputDiscount).toEqual(bundled.cachedInputDiscount);
    expect(doc.kiro).toEqual(bundled.kiro);
    expect(doc.cacheWriteMultiplier).toEqual(prev.cacheWriteMultiplier);
    expect(doc.agentcore).toEqual(prev.agentcore);
  });

  it("carries the operator's keys unchanged when they are valid", () => {
    const reg = SEED();
    const prev = clone(bundledPricingJson) as unknown as Record<string, unknown>;
    (prev.cacheWriteMultiplier as Record<string, number>)["5m"] = 1.4;
    const doc = mod.pricingProjection(reg, prev as never, bundledPricingJson as unknown as never);
    expect(doc.cacheWriteMultiplier!["5m"]).toBe(1.4);
  });
});

// ---------------------------------------------------------------------------
// 5. S3 load / save
// ---------------------------------------------------------------------------

describe("loadModelsRegistry", () => {
  beforeEach(async () => {
    h.state.objects = {};
    h.state.puts = [];
    h.state.putErrors = [];
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  it("seeds from the bundled copy when S3 has no document yet", async () => {
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("seed");
    expect(meta.registry.catalog).toHaveLength(21);
  });

  it("reads the live document and exposes its ETag for the conditional PUT", async () => {
    const live = { ...(clone(seedJson) as unknown as Record<string, unknown>), version: 7 };
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(live);
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("s3");
    expect(meta.registry.version).toBe(7);
    expect(meta.etag).toBe('"etag-1"');
  });

  it("serves the last good document when S3 starts failing", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify({
      ...(clone(seedJson) as unknown as Record<string, unknown>),
      version: 9,
    });
    expect((await mod.loadModelsRegistryMeta({ force: true })).registry.version).toBe(9);

    const throttled = new Error("Please reduce your request rate.") as Error & {
      $metadata?: { httpStatusCode: number };
    };
    throttled.name = "SlowDown";
    throttled.$metadata = { httpStatusCode: 503 };
    h.state.getErrors = [throttled];
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("cache");
    expect(meta.registry.version).toBe(9);
  });

  it("never throws on a malformed live document — it falls back instead", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify({ version: 3, catalog: "not-an-array" });
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    // A registry with no models is not a state the app can serve, so the read
    // failed and the seed answers — loudly, never as `source:"s3"`.
    expect(meta.source).toBe("seed");
    expect(mod.validateRegistry(meta.registry).ok).toBe(true);
  });
});

/**
 * TEAM-5008 finding 3. `parseModelsRegistry` is tolerant by design (security
 * finding 13: warn, never throw), and the loader used to cache whatever came
 * back. Truncated JSON therefore became an EMPTY registry, cached as last-good
 * for 60s, reported as `source:"s3"` — every agent silently routing off the
 * literal default with nothing in the response saying so.
 */
describe("loadModelsRegistryMeta refuses a corrupt document", () => {
  const GOOD = () => JSON.stringify({ ...(clone(seedJson) as unknown as Record<string, unknown>), version: 9 });

  beforeEach(async () => {
    h.state.objects = {};
    h.state.getErrors = [];
    h.state.getCalls = 0;
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  it("serves the previous good document when the body is not JSON", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    expect((await mod.loadModelsRegistryMeta({ force: true })).registry.version).toBe(9);

    h.state.objects[mod.MODELS_REGISTRY_KEY] = '{"version": 10, "catalog": [';
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("cache");
    expect(meta.registry.version).toBe(9);
    expect(meta.registry.catalog).toHaveLength(21);
  });

  it("serves the seed, not an empty registry, when there is no cached copy", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = "<html>403 Forbidden</html>";
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("seed");
    expect(meta.registry.catalog).toHaveLength(21);
    expect(meta.etag).toBeUndefined();
  });

  it("treats a JSON array body as corrupt", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = "[]";
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("seed");
  });

  it("treats a well-formed document that fails validateRegistry as corrupt", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    expect((await mod.loadModelsRegistryMeta({ force: true })).registry.version).toBe(9);

    const broken = JSON.parse(GOOD()) as { version: number; agents: Record<string, string>; quarantine: string[] };
    broken.version = 10;
    broken.quarantine = [broken.agents.agentcore_hub_workflow_manager];
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(broken);

    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("cache");
    expect(meta.registry.version).toBe(9);
  });

  it("serves a document that only pins an agent the roster no longer has", async () => {
    // A stale `agents` key is not corruption: reverting ALL routing to the seed
    // because one agent was deleted would be the worse failure.
    const stale = JSON.parse(GOOD()) as { agents: Record<string, string> };
    stale.agents.retired_agent_from_a_past_deploy = "us.anthropic.claude-sonnet-5";
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(stale);

    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("s3");
    expect(meta.registry.version).toBe(9);
  });

  it("stamps the TTL on every path, so a bad document is read once per minute", async () => {
    const gets = () => h.state.getCalls;

    // 1. corrupt body, cold cache → seed, and the seed is cached.
    h.state.objects[mod.MODELS_REGISTRY_KEY] = "not json at all";
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("seed");
    const afterSeed = gets();
    expect((await mod.loadModelsRegistryMeta()).source).toBe("cache");
    expect(gets()).toBe(afterSeed);

    // 2. corrupt body, warm cache → the cached copy, TTL re-stamped.
    mod.__resetModelsCaches();
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    await mod.loadModelsRegistryMeta({ force: true });
    h.state.objects[mod.MODELS_REGISTRY_KEY] = "not json at all";
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("cache");
    const afterCorrupt = gets();
    await mod.loadModelsRegistryMeta();
    expect(gets()).toBe(afterCorrupt);

    // 3. S3 erroring on a cold cache → seed, also cached.
    mod.__resetModelsCaches();
    const down = new Error("service unavailable") as Error & { $metadata?: { httpStatusCode: number } };
    down.name = "SlowDown";
    down.$metadata = { httpStatusCode: 503 };
    h.state.getErrors = [down];
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("seed");
    const afterOutage = gets();
    await mod.loadModelsRegistryMeta();
    expect(gets()).toBe(afterOutage);
  });
});

describe("saveModelsRegistry", () => {
  beforeEach(async () => {
    h.state.objects = {};
    h.state.puts = [];
    h.state.putErrors = [];
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  const err = (name: string, status: number) => {
    const e = new Error(name) as Error & { $metadata?: { httpStatusCode: number } };
    e.name = name;
    e.$metadata = { httpStatusCode: status };
    return e;
  };

  it("writes pretty-printed JSON with a trailing newline and the IfMatch guard", async () => {
    const res = await mod.saveModelsRegistry(SEED(), { ifMatch: '"etag-1"' });
    expect(res.version).toBe(1);
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.puts[0].Key).toBe(mod.MODELS_REGISTRY_KEY);
    expect(h.state.puts[0].IfMatch).toBe('"etag-1"');
    expect(h.state.puts[0].Body.endsWith("\n")).toBe(true);
    expect(h.state.puts[0].Body).toBe(JSON.stringify(JSON.parse(h.state.puts[0].Body), null, 2) + "\n");
  });

  it("turns a 412 into a version conflict without retrying", async () => {
    h.state.putErrors = [err("PreconditionFailed", 412)];
    await expect(mod.saveModelsRegistry(SEED(), { ifMatch: '"stale"' })).rejects.toThrow(mod.VersionConflictError);
    expect(h.state.puts).toHaveLength(1);
  });

  it("retries a 409 ConditionalRequestConflict, since the SDK never will", async () => {
    h.state.putErrors = [err("ConditionalRequestConflict", 409), null];
    const res = await mod.saveModelsRegistry(SEED(), { ifMatch: '"etag-1"' });
    expect(res.version).toBe(1);
    expect(h.state.puts).toHaveLength(2);
  });

  it("gives up on a 409 after three attempts", async () => {
    h.state.putErrors = [
      err("ConditionalRequestConflict", 409),
      err("ConditionalRequestConflict", 409),
      err("ConditionalRequestConflict", 409),
    ];
    await expect(mod.saveModelsRegistry(SEED(), { ifMatch: '"etag-1"' })).rejects.toThrow(mod.VersionConflictError);
    expect(h.state.puts).toHaveLength(3);
  });

  it("rethrows an unrelated error untouched", async () => {
    h.state.putErrors = [err("AccessDenied", 403)];
    await expect(mod.saveModelsRegistry(SEED(), {})).rejects.toThrow("AccessDenied");
    expect(h.state.puts).toHaveLength(1);
  });
});

describe("loadPricingProjection", () => {
  beforeEach(async () => {
    h.state.objects = {};
    h.state.puts = [];
    h.state.putErrors = [];
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
  });

  it("returns the live projection when its shape is trustworthy", async () => {
    const doc = mod.pricingProjection(SEED(), bundledPricingJson as unknown as never);
    h.state.objects[mod.PRICING_KEY] = JSON.stringify(doc);
    const got = await mod.loadPricingProjection({ force: true });
    expect(Object.keys(got.models)).toHaveLength(32);
  });

  it("falls back to the bundled file rather than reprice every card to the default", async () => {
    for (const bad of [
      { models: {}, default: { input: 5.5, output: 27.5 } }, // empty map
      { models: { "a.b": { input: 1, output: 2 } } }, // no default
      { models: { "a.b": { input: 1, output: 2 } }, default: { input: 0, output: 0 } }, // zero default
      [], // not an object
    ]) {
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(bad);
      const got = await mod.loadPricingProjection({ force: true });
      expect(got).toEqual(bundledPricingJson);
    }
  });

  it("falls back on a missing key and on unparseable JSON", async () => {
    delete h.state.objects[mod.PRICING_KEY];
    expect(await mod.loadPricingProjection({ force: true })).toEqual(bundledPricingJson);
    h.state.objects[mod.PRICING_KEY] = "{not json";
    expect(await mod.loadPricingProjection({ force: true })).toEqual(bundledPricingJson);
  });
});

describe("resolveModelsRegistryTtlMs", () => {
  it("coalesces a missing or nonsense TTL to 60s", () => {
    expect(mod.resolveModelsRegistryTtlMs({})).toBe(60_000);
    expect(mod.resolveModelsRegistryTtlMs({ MODELS_REGISTRY_TTL_MS: "0" })).toBe(60_000);
    expect(mod.resolveModelsRegistryTtlMs({ MODELS_REGISTRY_TTL_MS: "-5" })).toBe(60_000);
    expect(mod.resolveModelsRegistryTtlMs({ MODELS_REGISTRY_TTL_MS: "banana" })).toBe(60_000);
    expect(mod.resolveModelsRegistryTtlMs({ MODELS_REGISTRY_TTL_MS: "1500" })).toBe(1500);
  });
});
