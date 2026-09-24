/**
 * ONE model registry (epic TEAM-4990, ticket TEAM-4997) — server side.
 *
 * Model identity used to be spread across five files that nobody reconciled:
 * the harness lane catalog, the intake picker's hardcoded rows, pricing.json,
 * agents.json `model:` labels, and the deployed harness / MODEL_ID env. They
 * already disagreed, and a model missing from pricing.json was silently billed
 * at the `default` rate — a cost card could be wrong without ever looking wrong.
 *
 * This module owns the single document that replaces them:
 *   s3://$ARTIFACT_BUCKET/config/models.json   (live; edited on /models)
 *   src/config/models.json                     (bundled seed + offline fallback)
 * It carries ROUTING (defaults, per-CLI tiers, per-agent pins, legacy aliases,
 * quarantine) and the CATALOG (one row per model id: endpoint, region, api,
 * context window, price, probe results, harness lanes). `src/config/pricing.json`
 * is a GENERATED projection of the catalog — see `pricingProjection`.
 *
 * Load/cache/fallback follows `src/lib/cd-registry.ts` (bundled seed, 60s TTL,
 * last-good on error, NoSuchKey handled separately); the conditional-PUT error
 * taxonomy follows `src/app/api/workflow/[id]/tickets/transition/route.ts`
 * (412 is a real conflict, 409 is a race the SDK never retries for us).
 *
 * Core lib: no imports from an optional module. `@/config/agents.json` is
 * shared config, not a module surface, so reading it here keeps that rule.
 *
 * RESOLUTION IS TWO LAYERS, deliberately:
 *   `resolveModel`      pure lookup. Returns null for quarantined/retired/
 *                       unknown input and NEVER falls back on its own.
 *   `resolveAgentModel` / `resolveCodingModel`
 *                       own the fallback chain, so `source` tells you which
 *                       STEP supplied the value and `via` how that value was
 *                       looked up ("pinned via catalog", "default via tier").
 * Mixing the two is what let the old code answer "sonnet-5" and "fable-5-1" to
 * the same question depending on who asked.
 */

import agentsConfig from "@/config/agents.json";
import bundledRegistryJson from "@/config/models.json";
import bundledPricingJson from "@/config/pricing.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Every env-reading function takes its env as a parameter, so a test needs no
 * process.env mutation and no module reset. Looser than NodeJS.ProcessEnv on
 * purpose: that type requires NODE_ENV, which a two-key test fixture has no
 * business declaring.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

export type Vendor = "anthropic" | "openai";
export type ModelEndpoint = "bedrock-runtime" | "bedrock-mantle";
export type ModelApi = "converse" | "messages" | "responses";
export type PriceSource = "published" | "interim" | "manual";
export type RowStatus = "active" | "candidate" | "retired" | "quarantined";
export type HarnessApiFormat = "converse_stream" | "responses" | "chat_completions";
export type CodingCli = "claude" | "codex";

/** Rates above `thresholdInputTokens` prompt tokens (OpenAI long-context tier). */
export interface LongContextPrice {
  thresholdInputTokens: number;
  input: number;
  output: number;
  cacheReadInput: number;
}

/** USD per 1M tokens. `cacheWrite*` are absolute rates for display only — cost
 *  math uses the global `cacheWriteMultiplier`, so they are NOT projected. */
export interface Price {
  input: number;
  output: number;
  cacheReadInput?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheWriteTtl?: string;
  source: PriceSource;
  sourceNote?: string;
  asOf: string;
  longContext?: LongContextPrice;
  /** Published rate that drifted from ours. Recorded, never auto-applied. */
  priceDrift?: { input: number; output: number; seenAt: string };
}

export interface HarnessLane {
  id: string;
  apiFormat: HarnessApiFormat;
  requiresMantle?: boolean;
  apiKeyArn?: string;
  label?: string;
  description?: string;
}

export interface ProbeOutcome {
  ok: boolean;
  at: string;
  seconds?: number;
  error?: string;
}

export interface CatalogRow {
  modelId: string;
  label: string;
  vendor: Vendor;
  family: string;
  endpoint: ModelEndpoint;
  region: string;
  api: ModelApi;
  contextWindow: number;
  aliases: string[];
  price?: Price;
  probe?: { api?: ProbeOutcome; cli?: ProbeOutcome };
  status: RowStatus;
  readOnly?: boolean;
  requiresMantle?: boolean;
  retiredAt?: string;
  /** Set by discovery for the Price List `model` attribute filter. */
  pricingModelName?: string;
  harnessLanes?: HarnessLane[];
}

export interface ModelsRegistry {
  version: number;
  updatedAt: string;
  updatedBy: string;
  defaults: { persona: string; codingClaude: string; codingCodex: string };
  tiers: { claude: Record<string, string>; codex: Record<string, string> };
  /** agentId → pinned modelId. Keys are validated against agents.json. */
  agents: Record<string, string>;
  /**
   * Auto-adoption policy per family. The shape is not pinned by TEAM-4997 (the
   * seed ships `{}` and nothing reads it yet); it round-trips verbatim so the
   * sibling ticket that defines the policy does not need a migration.
   */
  autoAdopt: Record<string, unknown>;
  quarantine: string[];
  legacyAliases: Record<string, string>;
  catalog: CatalogRow[];
}

/**
 * Closed enum. The first five are CHAIN STEPS — only `resolveAgentModel` /
 * `resolveCodingModel` emit them. The last four are LOOKUP KINDS — only
 * `resolveModel` emits them, and a chain result carries one as `via`. An alias
 * hit reports "catalog": the row was found, and how is not the caller's
 * business. There is no "alias", "legacy", "agent" or "default".
 */
export type ModelSource =
  | "override"
  | "agents"
  | "defaults"
  | "env"
  | "literal"
  | "tier"
  | "legacyAlias"
  | "catalog"
  | "passthrough";

export type ChainStep = "override" | "agents" | "defaults" | "env" | "literal";
export type LookupKind = "tier" | "legacyAlias" | "catalog" | "passthrough";

export const CHAIN_STEPS: readonly ChainStep[] = ["override", "agents", "defaults", "env", "literal"];
export const LOOKUP_KINDS: readonly LookupKind[] = ["tier", "legacyAlias", "catalog", "passthrough"];
export const MODEL_SOURCES: readonly ModelSource[] = [...CHAIN_STEPS, ...LOOKUP_KINDS];

export type RejectReason = "quarantined" | "inactive" | "unknown";

export interface ResolveDiagnostic {
  /** The chain step whose candidate was rejected, or "value" for a bare resolveModel call. */
  step: ChainStep | "value";
  value: string;
  reason: RejectReason;
}

export interface ResolvedModel {
  modelId: string;
  source: ModelSource;
  /** How the supplying step's value was looked up. Absent on a bare resolveModel result. */
  via?: LookupKind;
  row?: CatalogRow;
  diagnostics?: ResolveDiagnostic[];
}

export interface ResolvedCodingModel extends ResolvedModel {
  endpoint: ModelEndpoint;
  region: string;
  api: ModelApi;
}

export interface ResolveContext {
  /** Enables bare tier words ("opus", "sol"). */
  cli?: CodingCli;
  /** Labels rejections in `diagnostics`. */
  step?: ChainStep | "value";
  /** Caller-owned sink; rejections are appended in order. */
  diagnostics?: ResolveDiagnostic[];
}

export interface ParseWarning {
  reason: string;
  modelId?: string;
  field?: string;
}

export interface ParsedRegistry {
  registry: ModelsRegistry;
  warnings: ParseWarning[];
}

export interface ValidationResult {
  ok: boolean;
  /** field path → reason. One 4xx body, every problem at once. */
  errors: Record<string, string>;
  warnings: ParseWarning[];
}

export class VersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(message: string) {
    super(message);
    this.name = "VersionConflictError";
  }
}

export interface PricingEntry {
  input: number;
  output: number;
  cacheReadInput?: number;
  longContext?: LongContextPrice;
}

export interface PricingDoc {
  _comment?: string;
  models: Record<string, PricingEntry>;
  default: { input: number; output: number };
  cachedInputDiscount?: number;
  cacheWriteMultiplier?: Record<string, number | string>;
  kiro?: Record<string, number | string>;
  agentcore?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MODELS_REGISTRY_KEY = "config/models.json";
export const MODELS_PREV_KEY = "config/models.prev.json";
export const PRICING_KEY = "config/pricing.json";

/**
 * A model id is an opaque token we hand to an AWS API, an env var and a shell
 * command line. Anchored and character-bounded so an injected `;` or space can
 * never reach any of the three.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

/** Deployable agent ids that are not rows in agents.json. */
export const EXTRA_DEPLOYABLE_IDS = ["telegram_intake"] as const;

/** Compiled-in floors: what an agent gets with no registry and no env. */
export const LITERAL_PERSONA_DEFAULT = "us.anthropic.claude-fable-5-1";
export const LITERAL_CODING_CLAUDE = "us.anthropic.claude-fable-5-1";
export const LITERAL_CODING_CODEX = "openai.gpt-5.5";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

/** Carried straight from the live pricing document, never regenerated. */
const CARRIED_PRICING_KEYS = ["default", "cachedInputDiscount", "cacheWriteMultiplier", "kiro", "agentcore"] as const;
type CarriedPricingKey = (typeof CARRIED_PRICING_KEYS)[number];

/** `<base>-YYYYMMDD` with an optional `-vN[:M]` suffix — a dated snapshot id. */
const DATED_ID_RE = /^(.*)-\d{8}(?:-v\d+(?::\d+)?)?$/;

const VENDORS = new Set<string>(["anthropic", "openai"]);
const ENDPOINTS = new Set<string>(["bedrock-runtime", "bedrock-mantle"]);
const APIS = new Set<string>(["converse", "messages", "responses"]);
const STATUSES = new Set<string>(["active", "candidate", "retired", "quarantined"]);
const API_FORMATS = new Set<string>(["converse_stream", "responses", "chat_completions"]);
const SECRET_ARN_RE = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/**
 * Env is a parameter purely so the unit test needs no process.env mutation and
 * no module reset (same trick as `resolveRegistryTtlMs`, cd-registry.ts:79).
 */
export function resolveModelsRegistryTtlMs(env: EnvLike = process.env): number {
  const n = Number(env.MODELS_REGISTRY_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

const TTL_MS = resolveModelsRegistryTtlMs();

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const posNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const nonNegNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function parsePrice(raw: unknown): Price | undefined {
  if (!isObj(raw)) return undefined;
  const input = nonNegNum(raw.input);
  const output = nonNegNum(raw.output);
  if (input === null || output === null) return undefined;
  const source = str(raw.source);
  const price: Price = {
    input,
    output,
    source: (["published", "interim", "manual"].includes(source) ? source : "manual") as PriceSource,
    asOf: str(raw.asOf),
  };
  const cacheRead = nonNegNum(raw.cacheReadInput);
  if (cacheRead !== null) price.cacheReadInput = cacheRead;
  const cw = nonNegNum(raw.cacheWrite);
  if (cw !== null) price.cacheWrite = cw;
  const cw1h = nonNegNum(raw.cacheWrite1h);
  if (cw1h !== null) price.cacheWrite1h = cw1h;
  if (str(raw.cacheWriteTtl)) price.cacheWriteTtl = str(raw.cacheWriteTtl);
  if (str(raw.sourceNote)) price.sourceNote = str(raw.sourceNote);
  if (isObj(raw.longContext)) {
    const lc = raw.longContext;
    const threshold = posNum(lc.thresholdInputTokens);
    const lcIn = nonNegNum(lc.input);
    const lcOut = nonNegNum(lc.output);
    const lcRead = nonNegNum(lc.cacheReadInput);
    if (threshold !== null && lcIn !== null && lcOut !== null && lcRead !== null) {
      price.longContext = { thresholdInputTokens: threshold, input: lcIn, output: lcOut, cacheReadInput: lcRead };
    }
  }
  if (isObj(raw.priceDrift)) {
    const dIn = nonNegNum(raw.priceDrift.input);
    const dOut = nonNegNum(raw.priceDrift.output);
    if (dIn !== null && dOut !== null) {
      price.priceDrift = { input: dIn, output: dOut, seenAt: str(raw.priceDrift.seenAt) };
    }
  }
  return price;
}

function parseProbeOutcome(raw: unknown): ProbeOutcome | undefined {
  if (!isObj(raw) || typeof raw.ok !== "boolean") return undefined;
  const out: ProbeOutcome = { ok: raw.ok, at: str(raw.at) };
  const seconds = nonNegNum(raw.seconds);
  if (seconds !== null) out.seconds = seconds;
  if (str(raw.error)) out.error = str(raw.error);
  return out;
}

function parseLanes(raw: unknown, warnings: ParseWarning[], modelId: string): HarnessLane[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lanes: HarnessLane[] = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    const apiFormat = str(item.apiFormat);
    if (!id || !MODEL_ID_RE.test(id) || !API_FORMATS.has(apiFormat)) {
      warnings.push({ reason: "malformed_lane", modelId, field: id || "harnessLanes" });
      continue;
    }
    const lane: HarnessLane = { id, apiFormat: apiFormat as HarnessApiFormat };
    if (item.requiresMantle === true) lane.requiresMantle = true;
    if (str(item.apiKeyArn)) lane.apiKeyArn = str(item.apiKeyArn);
    if (str(item.label)) lane.label = str(item.label);
    if (str(item.description)) lane.description = str(item.description);
    lanes.push(lane);
  }
  return lanes.length ? lanes : undefined;
}

function parseRow(raw: unknown, warnings: ParseWarning[]): CatalogRow | null {
  if (!isObj(raw)) {
    warnings.push({ reason: "malformed_row" });
    return null;
  }
  const modelId = str(raw.modelId);
  const vendor = str(raw.vendor);
  const endpoint = str(raw.endpoint);
  const api = str(raw.api);
  const status = str(raw.status);
  if (!modelId || !MODEL_ID_RE.test(modelId) || !VENDORS.has(vendor) || !ENDPOINTS.has(endpoint) || !APIS.has(api)) {
    warnings.push({ reason: "malformed_row", modelId: modelId || undefined });
    return null;
  }
  const aliases: string[] = [];
  for (const a of Array.isArray(raw.aliases) ? raw.aliases : []) {
    const alias = str(a);
    if (!alias) continue;
    if (!MODEL_ID_RE.test(alias)) {
      warnings.push({ reason: "bad_alias", modelId, field: alias });
      continue;
    }
    if (!aliases.includes(alias)) aliases.push(alias);
  }
  const row: CatalogRow = {
    modelId,
    label: str(raw.label) || modelId,
    vendor: vendor as Vendor,
    family: str(raw.family) || "unknown",
    endpoint: endpoint as ModelEndpoint,
    region: str(raw.region) || REGION,
    api: api as ModelApi,
    contextWindow: posNum(raw.contextWindow) ?? 200_000,
    aliases,
    status: (STATUSES.has(status) ? status : "candidate") as RowStatus,
  };
  const price = parsePrice(raw.price);
  if (price) row.price = price;
  if (isObj(raw.probe)) {
    const api2 = parseProbeOutcome(raw.probe.api);
    const cli = parseProbeOutcome(raw.probe.cli);
    if (api2 || cli) row.probe = { ...(api2 ? { api: api2 } : {}), ...(cli ? { cli } : {}) };
  }
  if (raw.readOnly === true) row.readOnly = true;
  if (raw.requiresMantle === true) row.requiresMantle = true;
  if (str(raw.retiredAt)) row.retiredAt = str(raw.retiredAt);
  if (str(raw.pricingModelName)) row.pricingModelName = str(raw.pricingModelName);
  const lanes = parseLanes(raw.harnessLanes, warnings, modelId);
  if (lanes) row.harnessLanes = lanes;
  return row;
}

function parseStringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    const val = str(v);
    if (key && val) out[key] = val;
  }
  return out;
}

/** Every id the routing layer points at — the set that keeps a row alive. */
export function routingTargets(reg: ModelsRegistry): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(reg.defaults || {})) if (v) out.add(v);
  for (const tierMap of Object.values(reg.tiers || {})) for (const v of Object.values(tierMap || {})) if (v) out.add(v);
  for (const v of Object.values(reg.agents || {})) if (v) out.add(v);
  for (const v of Object.values(reg.legacyAliases || {})) if (v) out.add(v);
  return out;
}

/**
 * Tolerant parse: a malformed row is dropped with a warning, never thrown — one
 * bad row an operator pasted must not take the whole console offline.
 *
 * Discovery returns both the stable id and the dated snapshot of the same
 * model (`…-sonnet-5` and `…-sonnet-5-20260101-v1:0`). The dated row is noise,
 * so it is dropped when its base id is present — UNLESS routing points at it,
 * because a resolvable target outranks tidiness.
 */
export function parseModelsRegistry(input: string | Record<string, unknown>): ParsedRegistry {
  const warnings: ParseWarning[] = [];
  let raw: Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      raw = isObj(parsed) ? parsed : {};
      if (!isObj(parsed)) warnings.push({ reason: "not_an_object" });
    } catch {
      warnings.push({ reason: "invalid_json" });
      raw = {};
    }
  } else {
    raw = isObj(input) ? input : {};
  }

  const defaultsRaw = isObj(raw.defaults) ? raw.defaults : {};
  const tiersRaw = isObj(raw.tiers) ? raw.tiers : {};
  const registry: ModelsRegistry = {
    version: posNum(raw.version) ?? 1,
    updatedAt: str(raw.updatedAt),
    updatedBy: str(raw.updatedBy) || "unknown",
    defaults: {
      persona: str(defaultsRaw.persona),
      codingClaude: str(defaultsRaw.codingClaude),
      codingCodex: str(defaultsRaw.codingCodex),
    },
    tiers: { claude: parseStringMap(tiersRaw.claude), codex: parseStringMap(tiersRaw.codex) },
    agents: parseStringMap(raw.agents),
    autoAdopt: isObj(raw.autoAdopt) ? { ...raw.autoAdopt } : {},
    quarantine: (Array.isArray(raw.quarantine) ? raw.quarantine : []).map(str).filter(Boolean),
    legacyAliases: parseStringMap(raw.legacyAliases),
    catalog: [],
  };

  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.catalog) ? raw.catalog : []) {
    const row = parseRow(item, warnings);
    if (!row) continue;
    if (seen.has(row.modelId)) {
      warnings.push({ reason: "duplicate_row", modelId: row.modelId });
      continue;
    }
    seen.add(row.modelId);
    rows.push(row);
  }

  const targets = routingTargets(registry);
  registry.catalog = rows.filter((row) => {
    const base = DATED_ID_RE.exec(row.modelId)?.[1];
    if (!base || !seen.has(base) || targets.has(row.modelId)) return true;
    warnings.push({ reason: "dated_duplicate", modelId: row.modelId });
    return false;
  });

  return { registry, warnings };
}

/** The bundled seed: first-deploy contents and the offline fallback. */
export const BUNDLED_REGISTRY: ModelsRegistry = parseModelsRegistry(
  bundledRegistryJson as unknown as Record<string, unknown>
).registry;

const BUNDLED_PRICING = bundledPricingJson as unknown as PricingDoc;

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export interface RegistryIndex {
  byId: Map<string, CatalogRow>;
  byAlias: Map<string, CatalogRow>;
  quarantined: Set<string>;
}

export function indexRegistry(reg: ModelsRegistry): RegistryIndex {
  const byId = new Map<string, CatalogRow>();
  const byAlias = new Map<string, CatalogRow>();
  for (const row of reg.catalog) {
    byId.set(row.modelId, row);
    for (const alias of row.aliases) if (!byAlias.has(alias)) byAlias.set(alias, row);
  }
  return { byId, byAlias, quarantined: new Set(reg.quarantine) };
}

/** Every deployable agent id: agents.json ∪ the ids that live only in env. */
export function deployableAgentIds(): string[] {
  const ids = (agentsConfig as { agents: Array<{ agentId?: string }> }).agents
    .map((a) => str(a.agentId))
    .filter(Boolean);
  for (const extra of EXTRA_DEPLOYABLE_IDS) if (!ids.includes(extra)) ids.push(extra);
  return ids;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function reject(ctx: ResolveContext, value: string, reason: RejectReason): null {
  ctx.diagnostics?.push({ step: ctx.step ?? "value", value, reason });
  console.warn(`[models] resolve.rejected value=${value} step=${ctx.step ?? "value"} reason=${reason}`);
  return null;
}

/**
 * Pure lookup. Order: quarantine → tier (only with `ctx.cli`) → legacyAliases →
 * catalog modelId → catalog alias → passthrough.
 *
 * Returns **null** — never a substitute — when the value is quarantined, the
 * matched row is retired/quarantined, or the value is an unknown non-model
 * string. Choosing a replacement is the caller's chain's job; doing it here is
 * how a rejected override used to become an invisible model change.
 */
export function resolveModel(
  reg: ModelsRegistry | null | undefined,
  value: string | null | undefined,
  ctx: ResolveContext = {}
): ResolvedModel | null {
  const raw = str(value);
  if (!raw) return null;

  let modelId = raw;
  let source: LookupKind = "passthrough";
  let row: CatalogRow | undefined;

  if (reg) {
    if (reg.quarantine.includes(raw)) return reject(ctx, raw, "quarantined");
    const index = indexRegistry(reg);
    const tierTarget = ctx.cli ? reg.tiers?.[ctx.cli]?.[raw] : undefined;
    const legacyTarget = reg.legacyAliases?.[raw];
    if (tierTarget) {
      modelId = tierTarget;
      source = "tier";
    } else if (legacyTarget) {
      modelId = legacyTarget;
      source = "legacyAlias";
    } else if (index.byId.has(raw)) {
      source = "catalog";
    } else if (index.byAlias.has(raw)) {
      modelId = index.byAlias.get(raw)!.modelId;
      source = "catalog";
    }
    row = index.byId.get(modelId);
    if (index.quarantined.has(modelId)) return reject(ctx, raw, "quarantined");
    if (row?.status === "quarantined") return reject(ctx, raw, "quarantined");
    if (row?.status === "retired") return reject(ctx, raw, "inactive");
  }

  if (!MODEL_ID_RE.test(modelId)) return reject(ctx, raw, "unknown");
  // A bare word with no tier and no row is a typo, not a model id.
  if (source === "passthrough" && !modelId.includes(".")) return reject(ctx, raw, "unknown");

  return row ? { modelId, source, row } : { modelId, source };
}

/** One tier lookup, no fallback. */
export function resolveTier(
  reg: ModelsRegistry | null | undefined,
  cli: CodingCli,
  tier: string
): string | null {
  return reg?.tiers?.[cli]?.[str(tier)] || null;
}

function runChain(
  reg: ModelsRegistry | null | undefined,
  steps: Array<[ChainStep, string | undefined]>,
  literal: string,
  cli?: CodingCli
): ResolvedModel {
  const diagnostics: ResolveDiagnostic[] = [];
  for (const [step, value] of steps) {
    if (!str(value)) continue;
    const hit = resolveModel(reg, value, { cli, step, diagnostics });
    if (!hit) continue;
    return {
      modelId: hit.modelId,
      source: step,
      via: hit.source as LookupKind,
      ...(hit.row ? { row: hit.row } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }
  // The floor: even a quarantined literal still boots the agent, because a
  // modelless agent is strictly worse than one on a known-good older model.
  return {
    modelId: literal,
    source: "literal",
    via: "passthrough",
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/**
 * Owns the persona fallback chain: override → agents[agentId] →
 * defaults.persona → env.MODEL_ID → LITERAL_PERSONA_DEFAULT. `source` is the
 * step that supplied the value; `via` is how that value was looked up.
 */
export function resolveAgentModel(
  reg: ModelsRegistry | null | undefined,
  agentId: string,
  override?: string | null,
  env: EnvLike = process.env
): ResolvedModel {
  return runChain(
    reg,
    [
      ["override", str(override) || undefined],
      ["agents", reg?.agents?.[str(agentId)]],
      ["defaults", reg?.defaults?.persona],
      ["env", str(env.MODEL_ID) || undefined],
      ["literal", LITERAL_PERSONA_DEFAULT],
    ],
    LITERAL_PERSONA_DEFAULT
  );
}

/**
 * Endpoint tuple for an id with no catalog row: `openai.*` is Mantle-only,
 * `us.openai.*` is a Bedrock inference profile that still speaks Responses.
 */
function deriveEndpoint(
  modelId: string,
  env: EnvLike
): { endpoint: ModelEndpoint; region: string; api: ModelApi } {
  if (modelId.startsWith("openai.")) {
    return { endpoint: "bedrock-mantle", region: env.BEDROCK_MANTLE_REGION || "us-east-2", api: "responses" };
  }
  return {
    endpoint: "bedrock-runtime",
    region: env.AWS_REGION || "us-east-1",
    api: modelId.includes(".openai.") ? "responses" : "converse",
  };
}

/**
 * Coding-CLI chain: explicit tier/id → defaults.codingClaude|codingCodex →
 * the env var the runtime itself reads → literal. Env names are the exact ones
 * deploy/coding-agent-runtime/main.py reads today.
 */
export function resolveCodingModel(
  reg: ModelsRegistry | null | undefined,
  tierOrId: string | null | undefined,
  cli: CodingCli,
  env: EnvLike = process.env
): ResolvedCodingModel {
  const literal = cli === "claude" ? LITERAL_CODING_CLAUDE : LITERAL_CODING_CODEX;
  const envValue =
    cli === "claude" ? str(env.ANTHROPIC_MODEL) || str(env.CLAUDE_MODEL) : str(env.CODEX_MODEL);
  const hit = runChain(
    reg,
    [
      ["override", str(tierOrId) || undefined],
      ["defaults", cli === "claude" ? reg?.defaults?.codingClaude : reg?.defaults?.codingCodex],
      ["env", envValue || undefined],
      ["literal", literal],
    ],
    literal,
    cli
  );
  const tuple = hit.row
    ? { endpoint: hit.row.endpoint, region: hit.row.region, api: hit.row.api }
    : deriveEndpoint(hit.modelId, env);
  return { ...hit, ...tuple };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function pricedOk(price: Price | undefined): boolean {
  return !!price && Number.isFinite(price.input) && Number.isFinite(price.output) && price.input >= 0 && price.output >= 0;
}

/**
 * Why a routing target is unusable, most specific first. An unpriced target is
 * an ERROR, not a warning: it would bill at the pricing default, which is the
 * exact silent-wrongness this epic exists to remove.
 */
function targetReason(reg: ModelsRegistry, index: RegistryIndex, value: string): string | null {
  if (!MODEL_ID_RE.test(value)) return "bad_model_id";
  if (index.quarantined.has(value)) return "quarantined";
  const row = index.byId.get(value) || index.byAlias.get(value);
  if (!row) return "unknown_model";
  if (row.readOnly) return "read_only";
  if (row.status === "quarantined") return "quarantined";
  if (row.status === "retired") return "inactive";
  if (!pricedOk(row.price)) return "unpriced";
  if (row.status === "candidate" && !row.probe?.api?.ok && !row.probe?.cli?.ok) return "unprobed";
  return null;
}

/**
 * Every problem at once, as `field path → reason`, so one 4xx tells the
 * operator everything. Paths are modelId-keyed, never index-keyed, so
 * reordering the catalog in the UI cannot mislabel an error.
 */
export function validateRegistry(reg: ModelsRegistry): ValidationResult {
  const errors: Record<string, string> = {};
  const warnings: ParseWarning[] = [];
  const index = indexRegistry(reg);
  const deployable = new Set(deployableAgentIds());

  // Catalog integrity. An alias that collides with another row's id or alias
  // makes the lookup order decide the price — unacceptable either way.
  const claimed = new Map<string, string>();
  for (const row of reg.catalog) claimed.set(row.modelId, row.modelId);
  for (const row of reg.catalog) {
    if (!MODEL_ID_RE.test(row.modelId)) errors[`catalog.${row.modelId}.modelId`] = "bad_model_id";
    for (const alias of row.aliases) {
      if (!MODEL_ID_RE.test(alias)) {
        errors[`catalog.${row.modelId}.aliases.${alias}`] = "bad_model_id";
        continue;
      }
      const owner = claimed.get(alias);
      if (owner && owner !== row.modelId) {
        errors[`catalog.${row.modelId}.aliases.${alias}`] = "duplicate_alias";
        continue;
      }
      claimed.set(alias, row.modelId);
    }
    if (!pricedOk(row.price) && row.status !== "retired") {
      warnings.push({ reason: "unpriced", modelId: row.modelId });
    }
    for (const lane of row.harnessLanes || []) {
      if (lane.apiKeyArn && !SECRET_ARN_RE.test(lane.apiKeyArn)) {
        errors[`catalog.${row.modelId}.harnessLanes.${lane.id}.apiKeyArn`] = "bad_api_key_arn";
      }
    }
  }

  // A lane id must be unique across the whole catalog: it is the harness's
  // primary key, and two rows claiming one lane silently repins a harness.
  const laneOwner = new Map<string, string>();
  for (const row of reg.catalog) {
    for (const lane of row.harnessLanes || []) {
      const owner = laneOwner.get(lane.id);
      if (owner) errors[`catalog.${row.modelId}.harnessLanes.${lane.id}`] = "duplicate_lane";
      else laneOwner.set(lane.id, row.modelId);
    }
  }

  // Routing targets.
  for (const [key, value] of Object.entries(reg.defaults || {})) {
    if (!value) {
      errors[`defaults.${key}`] = "unknown_model";
      continue;
    }
    const reason = targetReason(reg, index, value);
    if (reason) errors[`defaults.${key}`] = reason;
  }
  for (const [cli, tierMap] of Object.entries(reg.tiers || {})) {
    for (const [tier, value] of Object.entries(tierMap || {})) {
      const reason = targetReason(reg, index, value);
      if (reason) errors[`tiers.${cli}.${tier}`] = reason;
    }
  }
  for (const [agentId, value] of Object.entries(reg.agents || {})) {
    if (!deployable.has(agentId)) {
      errors[`agents.${agentId}`] = "unknown_agent";
      continue;
    }
    const reason = targetReason(reg, index, value);
    if (reason) errors[`agents.${agentId}`] = reason;
  }
  for (const [from, to] of Object.entries(reg.legacyAliases || {})) {
    if (!MODEL_ID_RE.test(from)) {
      errors[`legacyAliases.${from}`] = "bad_model_id";
      continue;
    }
    const reason = targetReason(reg, index, to);
    if (reason) errors[`legacyAliases.${from}`] = reason;
  }
  for (const value of reg.quarantine) {
    if (!MODEL_ID_RE.test(value)) errors[`quarantine.${value}`] = "bad_model_id";
  }

  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Pricing projection
// ---------------------------------------------------------------------------

function entryFor(price: Price): PricingEntry {
  const entry: PricingEntry = { input: price.input, output: price.output };
  if (typeof price.cacheReadInput === "number") entry.cacheReadInput = price.cacheReadInput;
  if (price.longContext) entry.longContext = { ...price.longContext };
  return entry;
}

function carriedValid(key: CarriedPricingKey, value: unknown): boolean {
  switch (key) {
    case "default":
      return isObj(value) && posNum(value.input) !== null && posNum(value.output) !== null;
    case "cachedInputDiscount": {
      const n = typeof value === "number" ? value : NaN;
      return Number.isFinite(n) && n > 0 && n <= 1;
    }
    case "cacheWriteMultiplier":
      return (
        isObj(value) &&
        Object.entries(value).every(([k, v]) => k.startsWith("_") || posNum(v) !== null) &&
        posNum(value.default) !== null
      );
    case "kiro":
      return isObj(value) && posNum(value.usdPerCredit) !== null;
    case "agentcore":
      return isObj(value) && posNum(value.runtimeGbHourUsd) !== null && posNum(value.runtimeVcpuHourUsd) !== null;
  }
}

/**
 * `src/config/pricing.json` as a pure function of the catalog.
 *
 * One key per catalog `modelId` PLUS every alias, in catalog order, retired
 * rows included — a span from a model we no longer route to must still price.
 * `legacyAliases` are NOT emitted: they are routing sugar, not ids that ever
 * appear in a span. `cacheWrite` is never per-key; it stays the global
 * `cacheWriteMultiplier`.
 *
 * The non-model keys are OPERATOR-OWNED and carried from `previousPricing`
 * byte-for-byte, so a catalog edit cannot revert a tuned multiplier. Each is
 * validated on its own and falls back to the bundled copy INDIVIDUALLY — one
 * corrupt key must not discard the other four.
 */
export function pricingProjection(
  reg: ModelsRegistry,
  previousPricing?: PricingDoc | null,
  bundled: PricingDoc = BUNDLED_PRICING
): PricingDoc {
  const models: Record<string, PricingEntry> = {};
  for (const row of reg.catalog) {
    if (!pricedOk(row.price)) continue;
    const entry = entryFor(row.price!);
    models[row.modelId] = entry;
    for (const alias of row.aliases) {
      if (!Object.prototype.hasOwnProperty.call(models, alias)) models[alias] = { ...entry };
    }
  }

  const carried: Partial<Record<CarriedPricingKey, unknown>> = {};
  for (const key of CARRIED_PRICING_KEYS) {
    const candidate = previousPricing ? (previousPricing as unknown as Record<string, unknown>)[key] : undefined;
    if (carriedValid(key, candidate)) {
      carried[key] = candidate;
      continue;
    }
    carried[key] = (bundled as unknown as Record<string, unknown>)[key];
    console.warn(`[models] pricing.projected prevSource=seed:${key}`);
  }

  const doc: PricingDoc = {
    _comment: `Generated from config/models.json version ${reg.version} at ${reg.updatedAt} by ${reg.updatedBy}. Do not edit; edit the catalog on /models.`,
    models,
    default: carried.default as PricingDoc["default"],
    cachedInputDiscount: carried.cachedInputDiscount as number,
    cacheWriteMultiplier: carried.cacheWriteMultiplier as PricingDoc["cacheWriteMultiplier"],
    kiro: carried.kiro as PricingDoc["kiro"],
    agentcore: carried.agentcore as PricingDoc["agentcore"],
  };
  console.log(`[models] pricing.projected version=${reg.version} keys=${Object.keys(models).length}`);
  return doc;
}

// ---------------------------------------------------------------------------
// S3 load / save
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A 412 means the document really changed under us — a genuine conflict. */
const is412 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
};
const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};
/**
 * A 409 ConditionalRequestConflict is a RACE, not a conflict: two conditional
 * PUTs overlapped. It is not a modelled exception class (it arrives via
 * @smithy/core's throwDefaultError, named from the parsed body) and the SDK
 * never retries it (409 is not in TRANSIENT_ERROR_STATUS_CODES and it is
 * $fault: "client"), so both arms and the manual retry are required.
 */
const is409 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "ConditionalRequestConflict" || e?.$metadata?.httpStatusCode === 409;
};
const CONFLICT_ATTEMPTS = 3;
const CONFLICT_BACKOFF_MS = [25, 75];

interface RegistryCache {
  registry: ModelsRegistry;
  etag?: string;
  at: number;
}
let _regCache: RegistryCache | null = null;
let _priceCache: { pricing: PricingDoc; at: number } | null = null;

export interface RegistryMeta {
  registry: ModelsRegistry;
  etag?: string;
  source: "s3" | "cache" | "seed";
}

/**
 * Live document with a 60s TTL, the bundled seed when S3 has no copy yet, and
 * last-good on any read/parse failure. A missing key seeds rather than empties:
 * a registry with no models is not a state the app can serve.
 */
export async function loadModelsRegistryMeta(opts: { force?: boolean } = {}): Promise<RegistryMeta> {
  if (!opts.force && _regCache && Date.now() - _regCache.at < TTL_MS) {
    return { registry: _regCache.registry, etag: _regCache.etag, source: "cache" };
  }
  if (!ARTIFACT_BUCKET) return { registry: BUNDLED_REGISTRY, source: "seed" };
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: MODELS_REGISTRY_KEY }));
    const { registry, warnings } = parseModelsRegistry(await obj.Body!.transformToString());
    _regCache = { registry, etag: obj.ETag, at: Date.now() };
    console.log(
      `[models] registry.loaded version=${registry.version} rows=${registry.catalog.length} warnings=${warnings.length}`
    );
    return { registry, etag: obj.ETag, source: "s3" };
  } catch (err) {
    if (isNotFound(err)) {
      _regCache = { registry: BUNDLED_REGISTRY, at: Date.now() };
      console.log("[models] registry.fallback reason=missing");
      return { registry: BUNDLED_REGISTRY, source: "seed" };
    }
    const reason = (err as Error)?.name || "error";
    console.warn(`[models] registry.fallback reason=${reason}`);
    if (_regCache) return { registry: _regCache.registry, etag: _regCache.etag, source: "cache" };
    return { registry: BUNDLED_REGISTRY, source: "seed" };
  }
}

export async function loadModelsRegistry(opts: { force?: boolean } = {}): Promise<ModelsRegistry> {
  return (await loadModelsRegistryMeta(opts)).registry;
}

/**
 * Conditional PUT. 412 is a real version conflict; 409 is a race, retried up
 * to three times before it becomes one.
 */
export async function saveModelsRegistry(
  registry: ModelsRegistry,
  opts: { ifMatch?: string; key?: string } = {}
): Promise<{ etag?: string; version: number }> {
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET is not set");
  const key = opts.key || MODELS_REGISTRY_KEY;
  const body = JSON.stringify(registry, null, 2) + "\n";
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
    try {
      const res = await s3.send(
        new PutObjectCommand({
          Bucket: ARTIFACT_BUCKET,
          Key: key,
          Body: body,
          ContentType: "application/json",
          ...(opts.ifMatch ? { IfMatch: opts.ifMatch } : {}),
        })
      );
      if (key === MODELS_REGISTRY_KEY) _regCache = { registry, etag: res.ETag, at: Date.now() };
      console.log(`[models] registry.saved key=${key} version=${registry.version} bytes=${body.length}`);
      return { etag: res.ETag, version: registry.version };
    } catch (err) {
      if (is412(err)) throw new VersionConflictError(`${key} changed under us (precondition failed)`);
      if (is409(err)) {
        if (attempt < CONFLICT_ATTEMPTS - 1) {
          await sleep(CONFLICT_BACKOFF_MS[attempt] ?? CONFLICT_BACKOFF_MS[CONFLICT_BACKOFF_MS.length - 1]);
          continue;
        }
        throw new VersionConflictError(`${key} lost ${CONFLICT_ATTEMPTS} conditional-write races`);
      }
      throw err;
    }
  }
  throw new VersionConflictError(`${key} lost ${CONFLICT_ATTEMPTS} conditional-write races`);
}

/** Shape gate: a document without models or a usable default is not pricing. */
function pricingShapeOk(doc: unknown): doc is PricingDoc {
  if (!isObj(doc)) return false;
  if (!isObj(doc.models) || Object.keys(doc.models).length === 0) return false;
  return isObj(doc.default) && posNum(doc.default.input) !== null && posNum(doc.default.output) !== null;
}

/**
 * The generated projection, live copy first. Falls back to the bundled file on
 * a missing key, a read error OR a document whose shape we do not trust — an
 * empty `models` map would silently reprice every card to the default.
 */
export async function loadPricingProjection(opts: { force?: boolean } = {}): Promise<PricingDoc> {
  if (!opts.force && _priceCache && Date.now() - _priceCache.at < TTL_MS) return _priceCache.pricing;
  if (!ARTIFACT_BUCKET) return BUNDLED_PRICING;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: PRICING_KEY }));
    const parsed = JSON.parse(await obj.Body!.transformToString()) as unknown;
    if (!pricingShapeOk(parsed)) {
      console.warn("[models] pricing.fallback reason=shape");
      _priceCache = { pricing: BUNDLED_PRICING, at: Date.now() };
      return BUNDLED_PRICING;
    }
    _priceCache = { pricing: parsed, at: Date.now() };
    return parsed;
  } catch (err) {
    console.warn(`[models] pricing.fallback reason=${isNotFound(err) ? "missing" : "error"}`);
    _priceCache = { pricing: BUNDLED_PRICING, at: Date.now() };
    return BUNDLED_PRICING;
  }
}

export async function savePricingProjection(doc: PricingDoc): Promise<void> {
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET is not set");
  const body = JSON.stringify(doc, null, 2) + "\n";
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  await s3.send(
    new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: PRICING_KEY, Body: body, ContentType: "application/json" })
  );
  _priceCache = { pricing: doc, at: Date.now() };
}

/** Test seam: drop the module-level caches. */
export function __resetModelsCaches(): void {
  _regCache = null;
  _priceCache = null;
}
