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
    puts: [] as Array<{ Key: string; Body: string; IfMatch?: string; IfNoneMatch?: string }>,
    /** Errors to throw from the next PutObject calls, in order. */
    putErrors: [] as Array<Error | null>,
    /** Errors to throw from the next GetObject calls, in order. */
    getErrors: [] as Array<Error | null>,
    /**
     * Promises the next GetObject calls park on, in order (TEAM-5080). The GET
     * captures the store as it is when it STARTS, then waits — so a test can
     * interleave a second read or a Save while this one is still in flight.
     */
    getHolds: [] as Array<Promise<void> | null>,
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
        // Capture what this GET answers with BEFORE parking on its hold: S3 is
        // strongly consistent, so a late read carries the document that was
        // live when it started, not whatever the store holds when it lands.
        const hold = h.state.getHolds.shift();
        const forced = h.state.getErrors.shift();
        const key = cmd.input.Key as string;
        const body = h.state.objects[key];
        const etag = h.state.etag;
        if (hold) await hold;
        if (forced) throw forced;
        if (body === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { ETag: etag, Body: { transformToString: async () => body } };
      }
      if (name === "PutObjectCommand") {
        const next = h.state.putErrors.shift();
        h.state.puts.push({
          Key: cmd.input.Key as string,
          Body: cmd.input.Body as string,
          IfMatch: cmd.input.IfMatch as string | undefined,
          IfNoneMatch: cmd.input.IfNoneMatch as string | undefined,
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
    // Guards against a case being silently dropped from the loop below. Accounting,
    // not a hardcoded total: a count collides on every added case, and what has to
    // hold is that the fixture was not truncated, names are unique, and every kind
    // present is one the switch below actually asserts on. Mirrors the twin readers.
    expect(CASES.length).toBeGreaterThanOrEqual(29);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
    const HANDLED = ["resolveModel", "resolveAgentModel", "resolveCodingModel", "parse", "validate", "projection"];
    expect([...new Set(CASES.map((c) => c.input.kind))].filter((k) => !HANDLED.includes(k))).toEqual([]);
  });

  for (const c of CASES) {
    it(`${c.name}`, () => {
      const raw = rawRegistryFor(c);
      const parsed = raw ? mod.parseModelsRegistry(raw) : null;
      const registry = parsed?.registry ?? null;
      const env = c.input.env ?? {};

      switch (c.input.kind) {
        case "resolveModel": {
          const diagnostics: ResolveDiagnostic[] = [];
          const got = mod.resolveModel(registry, c.input.value, { cli: c.input.cli, diagnostics });
          if (c.expected.modelId === null) {
            // A rejected value returns null and NOTHING substitutes; the reason is
            // reported on the caller's sink, which is how the chain drops a step.
            expect(got, `${c.name} must be rejected, not substituted`).toBeNull();
            expect(diagnostics.map((d) => d.reason), c.name).toContain(c.expected.rejected);
            break;
          }
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
          // The READ-time verdict: would the loader serve this document? Defaults
          // to `ok` — only NON_FATAL_READ_REASONS make the two differ.
          const readable = (c.expected.readable ?? c.expected.ok) as boolean;
          expect(Object.keys(mod.fatalReadErrors(result.errors)).length === 0, `${c.name} readable`).toBe(readable);
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
          // `reseeded`: the live block failed carriedValid(), so the projection
          // took the bundled seed's copy instead (TEAM-5029). The twin asserts the
          // same list against its `seed:<key>` notes.
          for (const key of (c.expected.reseeded ?? []) as string[]) {
            expect(doc[key as keyof typeof doc], `reseeded ${key}`).toEqual(
              (bundledPricingJson as unknown as Record<string, unknown>)[key]
            );
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
    // The three harnesses are pinned EXPLICITLY, not left to defaults.persona
    // (TEAM-5034): once the deploy scripts could actually read the document, an
    // unpinned builder / routine builder would have followed the persona default
    // and changed model, which is exactly what "the seed encodes today's live
    // routing" forbids.
    expect(reg.agents).toEqual({
      agentcore_hub_workflow_manager: "us.anthropic.claude-fable-5-1",
      agentcore_hub_builder: "us.anthropic.claude-sonnet-5",
      agentcore_hub_routine_builder: "us.anthropic.claude-opus-5",
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
  });

  /**
   * TEAM-5008 finding 6. A `longContext` block on a `published` price claims the
   * long-context rate is published too, and for these rows it is not: no
   * long-context rate exists for gpt-6-astra, gpt-5.6-terra or gpt-5.5 on either
   * the Bedrock pricing page or OpenAI's. The one model OpenAI does publish both
   * tiers for (gpt-5.6-sol) is 2x on input and 1.5x on output — so the "2x
   * everything" derivation was not just unsourced, it was wrong in shape. An
   * `interim` row may still carry the derived tier; its label says it is a guess.
   */
  it("carries a long-context tier only where the rate is interim, never as a guess on a published row", () => {
    const openai = SEED().catalog.filter((r) => r.vendor === "openai");
    expect(openai.length).toBeGreaterThan(0);
    for (const row of openai) {
      if (row.price!.source === "published") {
        expect(row.price!.longContext, row.modelId).toBeUndefined();
        expect(row.price!.sourceNote, row.modelId).toContain("No long-context");
        continue;
      }
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

describe("fatalReadErrors", () => {
  it("drops exactly the two point-in-time reasons and keeps every other verdict", () => {
    expect([...mod.NON_FATAL_READ_REASONS].sort()).toEqual(["unknown_agent", "unprobed"]);
    expect(
      mod.fatalReadErrors({
        "agents.gone_agent": "unknown_agent",
        "defaults.persona": "unprobed",
        "tiers.codex.luna": "unpriced",
        "legacyAliases.claude-sonnet-45": "quarantined",
      })
    ).toEqual({ "tiers.codex.luna": "unpriced", "legacyAliases.claude-sonnet-45": "quarantined" });
    expect(mod.fatalReadErrors({})).toEqual({});
  });
});

describe("activateAdoptedTargets", () => {
  const green = { ok: true, at: "2026-09-20T00:00:00.000Z" };
  const candidateRow = () => ({
    modelId: "us.anthropic.claude-opus-6",
    label: "Claude Opus 6",
    vendor: "anthropic" as const,
    family: "opus",
    endpoint: "bedrock-runtime" as const,
    region: "us-east-1",
    api: "converse" as const,
    contextWindow: 200000,
    aliases: ["opus-6"],
    price: { input: 5.5, output: 27.5, source: "interim" as const, asOf: "2026-09-24" },
    status: "candidate" as const,
    probe: { api: green, cli: green },
  });

  it("flips a routed candidate to active — reached by id or by alias — and names it", () => {
    const reg = SEED();
    reg.catalog.push(candidateRow());
    reg.tiers.claude.opus = "opus-6"; // alias, resolved like the adoption gate does
    const { registry, activated } = mod.activateAdoptedTargets(reg);
    expect(activated).toEqual(["us.anthropic.claude-opus-6"]);
    expect(registry.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6")!.status).toBe("active");
    // Pure: the input is untouched.
    expect(reg.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6")!.status).toBe("candidate");
    // And the now-active row can fail a re-probe without ever reading as unprobed.
    registry.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6")!.probe!.cli = { ok: false, at: "x" };
    expect(mod.validateRegistry(registry).ok).toBe(true);
  });

  it("leaves a candidate alone when nothing routes to it, or only a legacyAlias does", () => {
    const reg = SEED();
    reg.catalog.push(candidateRow());
    expect(mod.activateAdoptedTargets(reg).activated).toEqual([]);
    reg.legacyAliases["claude-opus-6-old"] = "us.anthropic.claude-opus-6";
    const { registry, activated } = mod.activateAdoptedTargets(reg);
    expect(activated).toEqual([]);
    expect(registry.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6")!.status).toBe("candidate");
  });

  it("is a no-op on the seed — nothing there is a candidate", () => {
    const { registry, activated } = mod.activateAdoptedTargets(SEED());
    expect(activated).toEqual([]);
    expect(registry).toEqual(SEED());
  });
});

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
 * TEAM-5052. A background writer (probe outcomes, the catalog refresh) must only
 * build on the live S3 document: the cache's ETag is stale, and the seed has none,
 * so a PUT on top of either 412s forever or overwrites the live document.
 */
describe("requireLiveRegistry", () => {
  beforeEach(async () => {
    vi.resetModules();
    mod = await import("@/lib/models-registry");
  });

  it("requireLiveRegistry throws for cache and seed, passes s3 with etag", () => {
    const registry = mod.BUNDLED_REGISTRY;
    const live = { registry, etag: '"etag-1"', source: "s3" as const };
    expect(mod.requireLiveRegistry(live)).toBe(live);

    for (const meta of [
      { registry, etag: '"etag-stale"', source: "cache" as const },
      { registry, source: "seed" as const },
      // An s3 read with no ETag cannot be written conditionally either.
      { registry, source: "s3" as const },
    ]) {
      let thrown: unknown;
      try {
        mod.requireLiveRegistry(meta);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(mod.RegistryFallbackError);
      expect(thrown).toMatchObject({ code: "registry_unavailable", source: meta.source });
    }
  });
});

/**
 * TEAM-5073. An operator Save may write over exactly two non-live states, each
 * with its own S3 precondition: a live document the read gate REFUSED (IfMatch
 * = that document's real ETag, never the cache's), and a key that does not
 * exist yet (IfNoneMatch "*"). A read error or a missing bucket proves nothing
 * about what is live, so it throws the same RegistryFallbackError the
 * background writers use.
 */
describe("requireWritableRegistry (TEAM-5073)", () => {
  beforeEach(async () => {
    vi.resetModules();
    mod = await import("@/lib/models-registry");
  });

  it("live s3 → IfMatch its ETag", () => {
    const registry = mod.BUNDLED_REGISTRY;
    expect(mod.requireWritableRegistry({ registry, etag: '"etag-1"', source: "s3" })).toEqual({
      registry,
      mode: "live",
      ifMatch: '"etag-1"',
    });
  });

  it("a refused live document → IfMatch the REFUSED document's ETag, from seed or cache alike", () => {
    const registry = mod.BUNDLED_REGISTRY;
    const fallback = { reason: "invalid" as const, detail: "x", refusedVersion: 4, refusedEtag: '"etag-refused"' };
    for (const meta of [
      { registry, source: "seed" as const, fallback },
      { registry, etag: '"etag-stale-cache"', source: "cache" as const, fallback },
    ]) {
      expect(mod.requireWritableRegistry(meta)).toEqual({
        registry,
        mode: "repair",
        ifMatch: '"etag-refused"',
        refusedVersion: 4,
      });
    }
  });

  it("a missing key → IfNoneMatch '*'", () => {
    const registry = mod.BUNDLED_REGISTRY;
    expect(
      mod.requireWritableRegistry({ registry, source: "seed", fallback: { reason: "missing", detail: "404" } })
    ).toEqual({ registry, mode: "create", ifNoneMatch: "*" });
  });

  it("throws for a read error, no bucket, an unparseable refusal with no ETag, and a bare cache", () => {
    const registry = mod.BUNDLED_REGISTRY;
    for (const meta of [
      { registry, source: "seed" as const, fallback: { reason: "error" as const, detail: "InternalError" } },
      { registry, etag: '"c"', source: "cache" as const, fallback: { reason: "error" as const, detail: "Throttling" } },
      { registry, source: "seed" as const, fallback: { reason: "no_bucket" as const, detail: "unset" } },
      { registry, source: "seed" as const, fallback: { reason: "invalid" as const, detail: "invalid_json" } },
      { registry, etag: '"c"', source: "cache" as const },
      { registry, source: "s3" as const },
    ]) {
      let thrown: unknown;
      try {
        mod.requireWritableRegistry(meta);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(mod.RegistryFallbackError);
      expect(thrown).toMatchObject({ code: "registry_unavailable", source: meta.source });
    }
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

  it("records the refused document's real ETag on the fallback (TEAM-5073)", async () => {
    const refused = JSON.parse(GOOD()) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
    const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(refused);
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("seed");
    expect(meta.fallback).toMatchObject({ reason: "invalid", refusedVersion: 9, refusedEtag: '"etag-1"' });
  });

  it("omits refusedVersion when the refused document declared none (TEAM-5074)", async () => {
    const refused = JSON.parse(GOOD()) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
    delete refused.version;
    const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(refused);
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.fallback).toMatchObject({ reason: "invalid" });
    expect(meta.fallback).not.toHaveProperty("refusedVersion");
  });

  // TEAM-5080: the raw reader used the parser's tolerant `posNum`, so
  // `Number(true)` reported "live version 1 was refused" and `Number([2])`
  // reported version 2 — versions the document never declared. Only a JSON
  // number (or the numeric string the parser also takes) is a declared version.
  for (const bad of ["abc", 0, -3, null, true, false, [2], ["7"], [1, 2], {}, { n: 2 }, "", "  "]) {
    it(`omits refusedVersion when the refused document's version is invalid (${JSON.stringify(bad)}) (TEAM-5074)`, async () => {
      const refused = JSON.parse(GOOD()) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
      refused.version = bad as unknown as number;
      const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
      refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
      h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(refused);
      const meta = await mod.loadModelsRegistryMeta({ force: true });
      expect(meta.fallback).not.toHaveProperty("refusedVersion");
    });
  }

  for (const [raw, want] of [
    ["5", 5],
    [5.5, 5.5],
  ] as const) {
    it(`reports refusedVersion for a declared version the parser would also take (${JSON.stringify(raw)}) (TEAM-5080)`, async () => {
      const refused = JSON.parse(GOOD()) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
      refused.version = raw as unknown as number;
      const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
      refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
      h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(refused);
      const meta = await mod.loadModelsRegistryMeta({ force: true });
      expect(meta.fallback).toMatchObject({ reason: "invalid", refusedVersion: want });
    });
  }

  it("reports refusedVersion from the raw document on an empty catalog with an explicit version (TEAM-5074)", async () => {
    const refused = JSON.parse(GOOD()) as Record<string, unknown>;
    refused.version = 12;
    refused.catalog = [];
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(refused);
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.fallback).toMatchObject({ reason: "invalid", detail: "empty_catalog", refusedVersion: 12 });
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

  /**
   * TEAM-5016 finding 1. `unprobed` is the ADOPTION rule applied at a point in
   * time. A candidate adopted with two green probes, then re-probed and failed,
   * used to read as a corrupt document — every hub task fell to last-good/seed,
   * and rollback 422'd on the same rule. The read verdict now tolerates it (the
   * save verdict does not), and the state is reported, not hidden.
   */
  it("serves a document whose only fault is a routed candidate that failed a re-probe", async () => {
    const doc = JSON.parse(GOOD()) as { catalog: Array<Record<string, unknown>>; defaults: Record<string, string> };
    doc.catalog.push({
      modelId: "us.anthropic.claude-opus-6",
      label: "Claude Opus 6",
      vendor: "anthropic",
      family: "opus",
      endpoint: "bedrock-runtime",
      region: "us-east-1",
      api: "converse",
      contextWindow: 200000,
      aliases: [],
      price: { input: 5.5, output: 27.5, source: "interim", asOf: "2026-09-24" },
      status: "candidate",
      probe: { api: { ok: true, at: "2026-09-24T00:00:00Z" }, cli: { ok: false, at: "2026-09-24T00:00:00Z", error: "turn failed" } },
    });
    doc.defaults.persona = "us.anthropic.claude-opus-6";
    h.state.objects[mod.MODELS_REGISTRY_KEY] = JSON.stringify(doc);

    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("s3");
    expect(meta.registry.defaults.persona).toBe("us.anthropic.claude-opus-6");
    // The SAVE verdict still names it — the console cannot re-save this state.
    expect(mod.validateRegistry(meta.registry).errors).toEqual({ "defaults.persona": "unprobed" });
  });

  it("keeps the cached document when the key goes missing (TEAM-5016 finding 3)", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    const live = await mod.loadModelsRegistryMeta({ force: true });
    expect(live.source).toBe("s3");

    delete h.state.objects[mod.MODELS_REGISTRY_KEY];
    const meta = await mod.loadModelsRegistryMeta({ force: true });
    expect(meta.source).toBe("cache");
    expect(meta.registry.version).toBe(9);
    expect(meta.etag).toBe(live.etag);
  });

  it("stamps the TTL on every path, so a bad document is read once per minute", async () => {
    const gets = () => h.state.getCalls;

    // 1. corrupt body, cold cache → seed, and the seed is cached. The TTL hit
    // replays "seed" (TEAM-5074) — the entry only ever held the seed, so saying
    // "cache" here would claim a live copy was once read.
    h.state.objects[mod.MODELS_REGISTRY_KEY] = "not json at all";
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("seed");
    const afterSeed = gets();
    expect((await mod.loadModelsRegistryMeta()).source).toBe("seed");
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

/**
 * TEAM-5074 — a warm TTL hit used to answer `{source:"cache"}` with no
 * `fallback` no matter what filled the entry, so a healthy cache hit and a
 * last-good fallback looked identical on the wire (the banner keys on
 * `fallback`, see fallback-banner.ts). The cache entry now carries the
 * source+fallback it was filled with and a TTL hit replays it; a healthy read,
 * a repair, or a Save clears it.
 */
describe("loadModelsRegistryMeta warm-cache fallback provenance (TEAM-5074)", () => {
  const GOOD = () => JSON.stringify({ ...(clone(seedJson) as unknown as Record<string, unknown>), version: 9 });
  function refusedDoc(): string {
    const refused = JSON.parse(GOOD()) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
    const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
    return JSON.stringify(refused);
  }

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

  it("a TTL hit after a healthy read reports no fallback", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    const first = await mod.loadModelsRegistryMeta({ force: true });
    expect(first.source).toBe("s3");

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.source).toBe("cache");
    expect(hit.fallback).toBeUndefined();
  });

  it("a TTL hit on a cold cache (seed) after a refusal keeps reporting the fallback", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc();
    const first = await mod.loadModelsRegistryMeta({ force: true });
    expect(first.source).toBe("seed");
    const getsAfterFirst = h.state.getCalls;

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.source).toBe("seed");
    expect(hit.fallback).toMatchObject({ reason: "invalid", refusedVersion: 9, refusedEtag: '"etag-1"' });
    // Still a TTL hit — no extra S3 GET.
    expect(h.state.getCalls).toBe(getsAfterFirst);
  });

  it("a TTL hit on a warm cache (a live copy was once read) after a refusal keeps reporting the fallback", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    await mod.loadModelsRegistryMeta({ force: true });

    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc();
    const forced = await mod.loadModelsRegistryMeta({ force: true });
    expect(forced.source).toBe("cache");
    expect(forced.fallback).toMatchObject({ reason: "invalid", refusedVersion: 9 });

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.source).toBe("cache");
    expect(hit.fallback).toEqual(forced.fallback);
  });

  it("a repaired read clears the provenance, so the next TTL hit is a healthy cache hit again", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc();
    await mod.loadModelsRegistryMeta({ force: true });

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD();
    const repaired = await mod.loadModelsRegistryMeta({ force: true });
    expect(repaired.source).toBe("s3");

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.source).toBe("cache");
    expect(hit.fallback).toBeUndefined();
  });

  it("a Save over a refused live document clears the provenance too", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc();
    const seeded = await mod.loadModelsRegistryMeta({ force: true });
    expect(seeded.fallback?.refusedEtag).toBe('"etag-1"');

    await mod.saveModelsRegistry(SEED(), { ifMatch: seeded.fallback!.refusedEtag });

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.source).toBe("cache");
    expect(hit.fallback).toBeUndefined();
  });
});

/**
 * TEAM-5080 — `lastGoodRegistry` stamped the fallback it answered with onto
 * WHATEVER cache entry was current when the failing read finished. A read that
 * fetched a refused (or missing, or erroring) document and landed late — after a
 * healthy read or a Save had installed a newer entry — wrote its stale fallback
 * onto that newer entry, and every TTL hit for the next minute served a false
 * banner (and, for `invalid`, a stale refusedEtag). Same defect class: a late
 * HEALTHY read installed its older document over a newer entry, and a late
 * failing pricing read replaced a newer `_priceCache` with the bundled file. A
 * read now only touches the entry it started from; a late one returns its own
 * honest answer and leaves the newer entry alone.
 */
describe("a late read never rewrites a newer cache entry (TEAM-5080)", () => {
  const GOOD = (version = 9) => JSON.stringify({ ...(clone(seedJson) as unknown as Record<string, unknown>), version });
  function refusedDoc(version = 9): string {
    const refused = JSON.parse(GOOD(version)) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
    const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
    return JSON.stringify(refused);
  }
  function gate(): { p: Promise<void>; release: () => void } {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    return { p, release };
  }
  /** A forced registry read parked mid-GET with the store as it is NOW. */
  function startLateRead() {
    const g = gate();
    h.state.getHolds = [g.p];
    return { pending: mod.loadModelsRegistryMeta({ force: true }), release: g.release };
  }
  const slowDown = () => {
    const down = new Error("service unavailable") as Error & { $metadata?: { httpStatusCode: number } };
    down.name = "SlowDown";
    down.$metadata = { httpStatusCode: 503 };
    return down;
  };

  beforeEach(async () => {
    h.state.objects = {};
    h.state.puts = [];
    h.state.putErrors = [];
    h.state.getErrors = [];
    h.state.getHolds = [];
    h.state.getCalls = 0;
    h.state.etag = '"etag-1"';
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
    h.state.etag = '"etag-1"';
    vi.useRealTimers();
  });

  it("late refusal after a Save: the TTL hit serves the saved document with no fallback", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc(2);
    h.state.etag = '"old-refused"';
    const late = startLateRead();

    h.state.etag = '"etag-20"';
    await mod.saveModelsRegistry({ ...SEED(), version: 20 }, { ifNoneMatch: "*" });

    late.release();
    const answer = await late.pending;
    // The late read's OWN answer stays honest: it did fail, and what it can
    // offer is the last-good document plus its (stale) precondition — which a
    // Save built on it would 412 against, and a background writer refuses.
    expect(answer.source).toBe("cache");
    expect(answer.registry.version).toBe(20);
    expect(answer.fallback).toMatchObject({ reason: "invalid", refusedVersion: 2, refusedEtag: '"old-refused"' });
    expect(mod.requireWritableRegistry(answer)).toMatchObject({ mode: "repair", ifMatch: '"old-refused"' });
    expect(() => mod.requireLiveRegistry(answer)).toThrow(mod.RegistryFallbackError);

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.registry.version).toBe(20);
    expect(hit.fallback).toBeUndefined();
  });

  it("late refusal after a Save over a previously read live copy: no fallback on the TTL hit", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(19);
    h.state.etag = '"etag-19"';
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3");

    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc(2);
    h.state.etag = '"old-refused"';
    const late = startLateRead();

    h.state.etag = '"etag-20"';
    await mod.saveModelsRegistry({ ...SEED(), version: 20 }, { ifMatch: '"etag-19"' });

    late.release();
    await late.pending;

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.registry.version).toBe(20);
    expect(hit.fallback).toBeUndefined();
  });

  it("late refusal after a healthy read: the TTL hit serves the healthy document with no fallback", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc(2);
    h.state.etag = '"old-refused"';
    const late = startLateRead();

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(20);
    h.state.etag = '"etag-20"';
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3");

    late.release();
    const answer = await late.pending;
    expect(answer.fallback).toMatchObject({ reason: "invalid", refusedVersion: 2 });

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.registry.version).toBe(20);
    expect(hit.fallback).toBeUndefined();
  });

  it("late missing after a Save: no fallback on the TTL hit", async () => {
    delete h.state.objects[mod.MODELS_REGISTRY_KEY];
    const late = startLateRead();

    h.state.etag = '"etag-20"';
    await mod.saveModelsRegistry({ ...SEED(), version: 20 }, { ifNoneMatch: "*" });

    late.release();
    const answer = await late.pending;
    expect(answer.fallback).toMatchObject({ reason: "missing" });
    expect(answer.registry.version).toBe(20);

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit.registry.version).toBe(20);
    expect(hit.fallback).toBeUndefined();
  });

  it("late S3 error after a healthy read: no fallback on the TTL hit", async () => {
    h.state.getErrors = [slowDown()];
    const late = startLateRead();

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(20);
    h.state.etag = '"etag-20"';
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3");

    late.release();
    const answer = await late.pending;
    expect(answer.fallback).toMatchObject({ reason: "error", detail: "SlowDown" });
    expect(answer.registry.version).toBe(20);

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.fallback).toBeUndefined();
  });

  it("a late failing read does not extend the newer entry's TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-25T00:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc(2);
    const late = startLateRead();

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(20);
    h.state.etag = '"etag-20"';
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3"); // entry stamped at t0

    vi.setSystemTime(t0 + 50_000);
    late.release();
    await late.pending;

    // 61s after the healthy read the entry is stale, whatever the late read did.
    vi.setSystemTime(t0 + 61_000);
    const before = h.state.getCalls;
    expect((await mod.loadModelsRegistryMeta()).source).toBe("s3");
    expect(h.state.getCalls).toBe(before + 1);
  });

  it("a late HEALTHY read of an older document does not overwrite a newer Save", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(19);
    h.state.etag = '"etag-19"';
    const late = startLateRead();

    h.state.etag = '"etag-20"';
    await mod.saveModelsRegistry({ ...SEED(), version: 20 }, { ifNoneMatch: "*" });

    late.release();
    const answer = await late.pending;
    // Its own result is untouched — that IS what S3 held when it read.
    expect(answer).toMatchObject({ source: "s3", etag: '"etag-19"' });
    expect(answer.registry.version).toBe(19);

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.registry.version).toBe(20);
    expect(hit.fallback).toBeUndefined();
  });

  it("a late HEALTHY read of an older document does not overwrite a newer healthy read", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(19);
    h.state.etag = '"etag-19"';
    const late = startLateRead();

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(20);
    h.state.etag = '"etag-20"';
    expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3");

    late.release();
    expect((await late.pending).registry.version).toBe(19);

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.registry.version).toBe(20);
  });

  it("a healthy read still installs when nothing newer landed while it was in flight", async () => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = refusedDoc(2);
    await mod.loadModelsRegistryMeta({ force: true }); // seed entry, owned by the next read too

    h.state.objects[mod.MODELS_REGISTRY_KEY] = GOOD(20);
    h.state.etag = '"etag-20"';
    const late = startLateRead();
    late.release();
    expect((await late.pending).source).toBe("s3");

    const hit = await mod.loadModelsRegistryMeta();
    expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
    expect(hit.fallback).toBeUndefined();
  });

  it("a late failing pricing read does not replace a newer live projection with the bundled file", async () => {
    const live = { ...mod.pricingProjection(SEED(), bundledPricingJson as unknown as never), default: { input: 123, output: 456 } };

    h.state.objects[mod.PRICING_KEY] = "{not json";
    const g = gate();
    h.state.getHolds = [g.p];
    const late = mod.loadPricingProjectionMeta({ force: true });

    h.state.objects[mod.PRICING_KEY] = JSON.stringify(live);
    expect((await mod.loadPricingProjectionMeta({ force: true })).source).toBe("s3");

    g.release();
    expect(await late).toMatchObject({ source: "bundled", reason: "shape" });

    const hit = await mod.loadPricingProjectionMeta();
    expect(hit.source).toBe("cache");
    expect(hit.pricing.default).toEqual({ input: 123, output: 456 });
  });

  it("a late missing pricing read does not replace a newer savePricingProjection", async () => {
    const live = { ...mod.pricingProjection(SEED(), bundledPricingJson as unknown as never), default: { input: 123, output: 456 } };

    delete h.state.objects[mod.PRICING_KEY];
    const g = gate();
    h.state.getHolds = [g.p];
    const late = mod.loadPricingProjectionMeta({ force: true });

    await mod.savePricingProjection(live);

    g.release();
    expect(await late).toMatchObject({ source: "bundled", reason: "missing" });

    const hit = await mod.loadPricingProjectionMeta();
    expect(hit.source).toBe("cache");
    expect(hit.pricing.default).toEqual({ input: 123, output: 456 });
  });
});

/**
 * TEAM-5113 — the TEAM-5080 ownership test compared cache entries by IDENTITY,
 * and a fallback install (the cold-path seed, every bundled pricing fill) is a
 * new object. So a fallback that landed while a healthy read was in flight
 * looked like a "newer" entry, and the healthy read — the only one that had
 * actually seen the live document — was refused the cache: a cold registry
 * served the seed with a false `invalid` banner for a whole TTL, and pricing
 * served the bundled rates (cold or warm) labelled `cache`.
 *
 * The rule now (mayInstall): an empty or fallback entry yields to anything; a
 * live entry yields only to a read or Save that STARTED no earlier than it was
 * installed. A late refusal never clobbers live; a refusal that started after
 * the live entry still stamps it (TEAM-5074 replay, TEAM-5008 TTL).
 */
describe("a fallback never keeps a healthy read out of the cache (TEAM-5113)", () => {
  const GOOD = (version: number) => JSON.stringify({ ...(clone(seedJson) as unknown as Record<string, unknown>), version });
  function refusedDoc(version = 2): string {
    const refused = JSON.parse(GOOD(version)) as Record<string, unknown> & { catalog: Array<Record<string, unknown>> };
    const owner = refused.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    refused.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], harnessLanes: undefined });
    return JSON.stringify(refused);
  }
  /**
   * Start a read parked mid-GET. The GET captures the store as it is NOW (see
   * the S3 mock), so reads started in sequence see successive S3 states and
   * resolve in whatever order the test releases them.
   */
  function park<T>(start: () => Promise<T>): { pending: Promise<T>; release: () => void } {
    let release!: () => void;
    h.state.getHolds.push(new Promise<void>((r) => (release = r)));
    return { pending: start(), release };
  }
  const regRead = () => park(() => mod.loadModelsRegistryMeta({ force: true }));
  const priceRead = () => park(() => mod.loadPricingProjectionMeta({ force: true }));
  const putRegistry = (body: string, etag: string) => {
    h.state.objects[mod.MODELS_REGISTRY_KEY] = body;
    h.state.etag = etag;
  };
  const LIVE_DEFAULT = { input: 123, output: 456 };
  const livePricing = (def = LIVE_DEFAULT) => ({
    ...mod.pricingProjection(SEED(), bundledPricingJson as unknown as never),
    default: def,
  });

  beforeEach(async () => {
    h.state.objects = {};
    h.state.puts = [];
    h.state.putErrors = [];
    h.state.getErrors = [];
    h.state.getHolds = [];
    h.state.getCalls = 0;
    h.state.etag = '"etag-1"';
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    mod = await import("@/lib/models-registry");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
    h.state.etag = '"etag-1"';
  });

  describe("registry", () => {
    it("(a) cold: the refusal resolves first, the healthy v20 read second → the TTL hit serves live v20, no banner", async () => {
      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead();
      putRegistry(GOOD(20), '"etag-20"');
      const healthy = regRead();

      refused.release();
      const r = await refused.pending;
      // The refusal's own answer is unchanged: nothing was cached yet, so seed.
      expect(r).toMatchObject({ source: "seed", fallback: { reason: "invalid", refusedVersion: 2 } });
      healthy.release();
      expect(await healthy.pending).toMatchObject({ source: "s3", etag: '"etag-20"' });

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
      expect(hit.registry.version).toBe(20);
      expect(hit.fallback).toBeUndefined();
    });

    it("(a) cold, healthy read started first: the refusal still resolves first → live v20 cached", async () => {
      putRegistry(GOOD(20), '"etag-20"');
      const healthy = regRead();
      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead();

      refused.release();
      await refused.pending;
      healthy.release();
      await healthy.pending;

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
      expect(hit.fallback).toBeUndefined();
    });

    it("(b) cold, reverse order: the healthy read resolves first, the refusal that started before it second → live v20 kept", async () => {
      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead();
      putRegistry(GOOD(20), '"etag-20"');
      const healthy = regRead();

      healthy.release();
      await healthy.pending;
      refused.release();
      const r = await refused.pending;
      // Answers from the entry now cached, with its own honest fallback.
      expect(r).toMatchObject({ source: "cache", etag: '"etag-20"', fallback: { reason: "invalid", refusedEtag: '"refused"' } });

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
      expect(hit.fallback).toBeUndefined();
    });

    it("(c) warm: a late refusal that started before the healthy read does not clobber live", async () => {
      putRegistry(GOOD(10), '"etag-10"');
      expect((await mod.loadModelsRegistryMeta({ force: true })).source).toBe("s3");

      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead();
      putRegistry(GOOD(20), '"etag-20"');
      const healthy = regRead();
      healthy.release();
      await healthy.pending;
      refused.release();
      expect((await refused.pending).fallback).toMatchObject({ reason: "invalid" });

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
      expect(hit.registry.version).toBe(20);
      expect(hit.fallback).toBeUndefined();
    });

    it("(c) warm: a late refusal that started before a Save does not clobber the saved entry", async () => {
      putRegistry(GOOD(10), '"etag-10"');
      await mod.loadModelsRegistryMeta({ force: true });

      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead();
      h.state.etag = '"etag-20"';
      await mod.saveModelsRegistry({ ...SEED(), version: 20 }, { ifMatch: '"refused"' });
      refused.release();
      await refused.pending;

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"' });
      expect(hit.fallback).toBeUndefined();
    });

    it("a refusal that started AFTER the live entry was read still stamps it (TEAM-5074 replay kept)", async () => {
      putRegistry(GOOD(20), '"etag-20"');
      const healthy = regRead();
      putRegistry(refusedDoc(2), '"refused"');
      const refused = regRead(); // saw the newer S3 state

      healthy.release();
      await healthy.pending;
      refused.release();
      await refused.pending;

      const hit = await mod.loadModelsRegistryMeta();
      expect(hit).toMatchObject({ source: "cache", etag: '"etag-20"', fallback: { reason: "invalid", refusedEtag: '"refused"' } });
    });
  });

  describe("pricing", () => {
    it("(a) cold: the failing read resolves first, the healthy read second → the TTL hit serves the live rates", async () => {
      h.state.objects[mod.PRICING_KEY] = "{not json";
      const failing = priceRead();
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing());
      const healthy = priceRead();

      failing.release();
      expect(await failing.pending).toMatchObject({ source: "bundled", reason: "shape" });
      healthy.release();
      expect((await healthy.pending).source).toBe("s3");

      const hit = await mod.loadPricingProjectionMeta();
      expect(hit.source).toBe("cache");
      expect(hit.pricing.default).toEqual(LIVE_DEFAULT);
    });

    it("(a) warm: over an older live projection, same interleave → the newer live rates are cached", async () => {
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing({ input: 1, output: 2 }));
      expect((await mod.loadPricingProjectionMeta({ force: true })).source).toBe("s3");

      h.state.objects[mod.PRICING_KEY] = "{not json";
      const failing = priceRead();
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing());
      const healthy = priceRead();
      failing.release();
      await failing.pending;
      healthy.release();
      await healthy.pending;

      const hit = await mod.loadPricingProjectionMeta();
      expect(hit.pricing.default).toEqual(LIVE_DEFAULT);
    });

    it("(b) cold, reverse order: the healthy read resolves first, the failing read that started before it second → live kept", async () => {
      h.state.objects[mod.PRICING_KEY] = "{not json";
      const failing = priceRead();
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing());
      const healthy = priceRead();

      healthy.release();
      await healthy.pending;
      failing.release();
      expect(await failing.pending).toMatchObject({ source: "bundled", reason: "shape" });

      const hit = await mod.loadPricingProjectionMeta();
      expect(hit.pricing.default).toEqual(LIVE_DEFAULT);
    });

    it("(c) warm: a late failing read that started before the healthy read does not clobber live", async () => {
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing({ input: 1, output: 2 }));
      await mod.loadPricingProjectionMeta({ force: true });

      delete h.state.objects[mod.PRICING_KEY];
      const failing = priceRead();
      h.state.objects[mod.PRICING_KEY] = JSON.stringify(livePricing());
      const healthy = priceRead();
      healthy.release();
      await healthy.pending;
      failing.release();
      expect(await failing.pending).toMatchObject({ source: "bundled", reason: "missing" });

      const hit = await mod.loadPricingProjectionMeta();
      expect(hit.pricing.default).toEqual(LIVE_DEFAULT);
    });
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

  it("sends IfNoneMatch '*' for a first write, and no IfMatch (TEAM-5073)", async () => {
    await mod.saveModelsRegistry(SEED(), { ifNoneMatch: "*" });
    expect(h.state.puts[0]).toMatchObject({ IfNoneMatch: "*" });
    expect(h.state.puts[0].IfMatch).toBeUndefined();
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
