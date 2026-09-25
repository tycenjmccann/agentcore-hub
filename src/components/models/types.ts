/**
 * Local types for the Models page (TEAM-4996).
 *
 * DELIBERATELY self-contained: the server-side registry lives in
 * src/lib/models-registry.ts and the pipeline's model-override contract in
 * src/lib/workflow/model-config.ts, and this file imports NEITHER. The page is
 * core, src/lib/workflow is the Workflow module, and the registry lib pulls in
 * the AWS SDK — so the wire shape is re-declared here as plain data. Keep these
 * in step with GET/POST /api/models/registry by hand; a drift shows up as a
 * type error at the one seam (api.ts), not scattered through the components.
 *
 * The only shared config imported is src/config/agents.json, the roster's single
 * source of truth (see CLAUDE.md) — deriving the deployable list from it is what
 * keeps the page's 46 rows correct as the fleet changes. The one *lib* import is
 * src/lib/models/model-id.ts (TEAM-5011): it is a core lib with zero imports of
 * its own and no AWS SDK, so it does not reintroduce the dependency this file
 * otherwise avoids — it exists so MODEL_ID_RE has one definition, not two.
 */

import agentsConfig from "@/config/agents.json";

// ─── Registry document ──────────────────────────────────────────────────────

export type ModelVendor = "anthropic" | "openai";
export type ModelEndpoint = "bedrock-runtime" | "bedrock-mantle";
export type PriceSource = "published" | "interim" | "manual";
export type CatalogStatus = "active" | "candidate" | "retired" | "quarantined";

export interface LongContextPrice {
  thresholdInputTokens: number;
  input: number;
  output: number;
  cacheReadInput: number;
}

export interface Price {
  input: number;
  output: number;
  cacheReadInput?: number;
  cacheWrite?: number;
  cacheWriteTtl?: string;
  source: PriceSource;
  sourceNote?: string;
  asOf: string;
  longContext?: LongContextPrice;
}

export interface ProbeResult {
  ok: boolean;
  at: string;
  seconds?: number;
}

export interface HarnessLane {
  id: string;
  [k: string]: unknown;
}

export interface CatalogRow {
  modelId: string;
  label: string;
  vendor: ModelVendor;
  family: string;
  endpoint: ModelEndpoint;
  region: string;
  api: string;
  contextWindow: number;
  aliases: string[];
  price?: Price;
  probe?: { api?: ProbeResult; cli?: ProbeResult };
  status: CatalogStatus;
  readOnly?: boolean;
  harnessLanes?: HarnessLane[];
  priceDrift?: { input: number; output: number };
  requiresMantle?: boolean;
  notify?: { requestedAt: string };
}

export type ClaudeTier = "fable" | "opus" | "sonnet" | "haiku";
export type CodexTier = "astra" | "sol" | "terra" | "luna";

export const CLAUDE_TIERS: ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];
export const CODEX_TIERS: CodexTier[] = ["astra", "sol", "terra", "luna"];

/** The three fields of `defaults`, in render order. */
export type DefaultsField = "persona" | "codingClaude" | "codingCodex";
export const DEFAULTS_FIELDS: DefaultsField[] = ["persona", "codingClaude", "codingCodex"];

export interface RegistryDoc {
  version: number;
  updatedAt: string;
  updatedBy: string;
  defaults: Record<DefaultsField, string>;
  tiers: {
    claude: Record<ClaudeTier, string>;
    codex: Record<CodexTier, string>;
  };
  agents: Record<string, string>;
  autoAdopt?: Record<string, boolean>;
  quarantine: string[];
  legacyAliases: Record<string, string>;
  catalog: CatalogRow[];
}

/** The POST body's registry: the whole doc minus the server-owned meta fields. */
export type RegistryDraft = Omit<RegistryDoc, "version" | "updatedAt" | "updatedBy">;

// ─── Wire responses ─────────────────────────────────────────────────────────

export type ResolveSource =
  | "override"
  | "agents"
  | "defaults"
  | "env"
  | "literal"
  | "tier"
  | "legacyAlias"
  | "catalog"
  | "passthrough";

export interface ResolvedModel {
  modelId: string;
  source: ResolveSource;
  /** Present for harnesses — what the harness is REALLY running. */
  harnessModel?: string;
}

export interface RegistryResponse {
  registry: RegistryDoc;
  previous: { version: number; updatedAt: string } | null;
  resolved: Record<string, ResolvedModel>;
  interimOverdue: string[];
  /** Reserved: the GET does not return the full previous doc today (see PriorVersionPanel). */
  previousRegistry?: RegistryDoc;
}

export type ApplyStatus = "live" | "drift" | "applying" | "failed";

export interface AgentApplyResult {
  agentId: string;
  previous: string | null;
  current: string;
  status: ApplyStatus;
  error?: string;
}

/** 200 and 207 share this shape; 207 carries ok:false + pricing.status "failed". */
export interface WriteResponse {
  ok: boolean;
  registry: RegistryDoc;
  pricing: { status: "projected" | "failed"; version?: number; error?: string };
  agents: AgentApplyResult[];
}

export interface ConflictResponse {
  error: "version_conflict";
  live: RegistryDoc;
}

/** 422: dotted registry path -> machine-readable reason. */
export type InvalidReason =
  | "unpriced"
  | "inactive"
  | "quarantined"
  | "unprobed"
  | "read_only"
  | "duplicate_alias"
  | "bad_model_id";

export interface InvalidRegistryResponse {
  error: "invalid_registry";
  fields: Record<string, InvalidReason>;
}

/**
 * POST /api/models/catalog {refresh:true}. 200, or 207 when the catalog saved but
 * the pricing projection did not — same split as a registry save.
 *
 * `discovered` names the model ids, it does not count them: "2 added" is a number
 * the page can compute, while WHICH two is the thing an operator has to check.
 */
export interface CatalogRefreshResponse {
  ok: boolean;
  catalog: CatalogRow[];
  version: number;
  discovered: {
    added: string[];
    retired: string[];
    repriced: string[];
    /** Published rate moved but was NOT applied — a refresh never changes a price silently. */
    drifted: string[];
    errors: string[];
  };
  pricing: { status: "projected" | "failed"; version?: number; error?: string };
}

export type ProbeMode = "api" | "cli";

export interface ProbeAcceptedResponse {
  accepted: boolean;
  modelId: string;
  mode: ProbeMode;
  pollAfterMs: number;
}

// ─── Draft diff ─────────────────────────────────────────────────────────────

/**
 * One staged edit. `path` is the dotted registry path (the same vocabulary the
 * 422 response speaks, so a rejected field maps straight back to its control);
 * `from`/`to` are already-formatted display strings for the save bar.
 */
export interface Change {
  path: string;
  label: string;
  from: string;
  to: string;
}

/**
 * Which `<select>` is asking whether a catalog row is offerable. The vendor and
 * endpoint rules differ per field; everything else about selectability does not.
 */
export type SelectField =
  | "persona"
  | "codingClaude"
  | "codingCodex"
  | "claudeTier"
  | "codexTier"
  | "agent";

// ─── Deployables (46 rows) ──────────────────────────────────────────────────

export type DeployableType = "runtime" | "harness" | "lambda";

export interface Deployable {
  agentId: string;
  displayName: string;
  type: DeployableType;
  /** The agents.json `phase`; "platform" for the static Lambda row. */
  phase: string;
}

/**
 * The Telegram bug-intake Lambda runs a model but is not an AgentCore
 * deployable, so it has no agents.json row — yet it IS registry-managed
 * (`agents.telegram_intake`), so it has to be listed or its override would be
 * invisible. The one static row on this page.
 */
export const TELEGRAM_INTAKE: Deployable = {
  agentId: "telegram_intake",
  displayName: "Telegram intake Lambda",
  type: "lambda",
  phase: "platform",
};

interface RawRosterAgent {
  agentId: string;
  displayName: string;
  type?: string;
  phase: string;
}

/**
 * Every deployable the registry can point at: the roster (45) + the intake
 * Lambda = 46. Derived from agents.json rather than hardcoded so a fleet change
 * shows up here without a second edit.
 */
export const DEPLOYABLES: Deployable[] = [
  ...(agentsConfig as unknown as { agents: RawRosterAgent[] }).agents.map((a) => ({
    agentId: a.agentId,
    displayName: a.displayName,
    type: (a.type === "harness" ? "harness" : "runtime") as DeployableType,
    phase: a.phase,
  })),
  TELEGRAM_INTAKE,
];

// ─── Phase grouping ─────────────────────────────────────────────────────────

export const OTHER_ROSTERS = "Other rosters";
export const PINNED_GROUP = "Pinned deployables";

/** Display order of the groups. */
export const GROUP_ORDER = [
  PINNED_GROUP,
  "Intake",
  "Requirements",
  "Design",
  "Development",
  "Review and QA",
  "Ship",
  "Platform runtimes",
  OTHER_ROSTERS,
] as const;

export type GroupName = (typeof GROUP_ORDER)[number];

/**
 * agents.json `phase` -> group. Any phase missing here falls into
 * "Other rosters", so a new roster phase degrades to a visible group rather
 * than vanishing. Note `management` (the Workflow Manager's phase) is absent on
 * purpose: that agent is pinned, and pinning is decided before this map.
 */
export const PHASE_GROUPS: Record<string, GroupName> = {
  triage: "Intake",
  qualification: "Intake",
  requirements: "Requirements",
  design: "Design",
  development: "Development",
  review: "Review and QA",
  verification: "Review and QA",
  ship: "Ship",
  strategy: OTHER_ROSTERS,
  creative: OTHER_ROSTERS,
  generation: OTHER_ROSTERS,
  scheduling: OTHER_ROSTERS,
  drafting: OTHER_ROSTERS,
  approval: OTHER_ROSTERS,
  redline: OTHER_ROSTERS,
  signoff: OTHER_ROSTERS,
};

/** The intake Lambda is pinned by name; every harness is pinned by type. */
export const ALWAYS_PINNED = new Set([TELEGRAM_INTAKE.agentId]);

/**
 * The group a deployable belongs to.
 *
 * Harnesses lead the list because they are the rows with something to do: a
 * harness holds a pinned model that the apply path has to rewrite, so it is the
 * only kind of row that can drift, go `applying`, or fail. Runtimes read the
 * registry at the start of every run and are always already live — interesting
 * to see, never actionable. Grouping on type (rather than on whether a given
 * response happened to carry `harnessModel`) keeps the layout stable across
 * polls and across a registry that has never heard of an agent.
 */
export function groupFor(d: Deployable): GroupName {
  if (d.type === "harness" || ALWAYS_PINNED.has(d.agentId)) return PINNED_GROUP;
  if (d.phase === "platform") return "Platform runtimes";
  return PHASE_GROUPS[d.phase] ?? OTHER_ROSTERS;
}

// ─── Judges (DD8) ───────────────────────────────────────────────────────────

/**
 * Judge models are pinned in eval configs, NOT in this registry: moving one
 * breaks score comparability across history, so it is a deploy-time edit.
 * These paths are displayed, never fetched.
 */
export const JUDGE_PIN_FILES = [
  "deploy/evaluations/dependency_chain_evaluator.json",
  "deploy/evaluations/eval-config-ids.json",
];

// ─── Validation ─────────────────────────────────────────────────────────────

// The unpriced strip reads ids out of span attributes, i.e. data the fleet
// wrote, not the operator. There is no route that turns one into a catalog
// row (TEAM-5011): discovery is the only intake, because a span-derived string
// staged as a candidate row was TEAM-4994 finding 9's injection origin. So the
// shape check below only decides which of two inert-text messages a row gets,
// never whether a write happens. The shape itself is defined once, in the
// zero-dependency sibling lib, and re-exported here.
export { MODEL_ID_RE, isValidModelId } from "@/lib/models/model-id";

// ─── Path -> control ────────────────────────────────────────────────────────

export type CatalogField = "price" | "status" | "aliases";
const CATALOG_FIELDS: readonly CatalogField[] = ["price", "status", "aliases"];

/**
 * `catalog.<modelId>[.price|.status|.aliases[.<alias>]]`, split once. Model ids
 * contain dots, so the id is everything after "catalog" minus a recognised
 * field tail; a per-alias error path (`….aliases.<alias>`, validateRegistry's
 * shape) also carries the alias. The ONE parser for these paths — diff/rebase,
 * the 422 handler and the control map all go through it.
 */
export function parseCatalogPath(path: string): { modelId: string; field?: CatalogField; alias?: string } | null {
  if (!path.startsWith("catalog.")) return null;
  const rest = path.slice("catalog.".length);
  const at = rest.indexOf(".aliases.");
  if (at > 0) return { modelId: rest.slice(0, at), field: "aliases", alias: rest.slice(at + ".aliases.".length) };
  for (const field of CATALOG_FIELDS) {
    if (rest.length > field.length + 1 && rest.endsWith(`.${field}`)) {
      return { modelId: rest.slice(0, -(field.length + 1)), field };
    }
  }
  return rest ? { modelId: rest } : null;
}

/**
 * The ONE map from a dotted registry path to the control that owns it. Both
 * diffRegistry (which produces the paths) and the 422 handler (which receives
 * them from the server) go through this, so a field the server rejects is always
 * the field that lights up red.
 */
export function pathToControlTestId(path: string): string | null {
  const parts = path.split(".");
  if (parts[0] === "defaults" && parts[1]) return `defaults-select-${parts[1]}`;
  if (parts[0] === "tiers" && parts[1] && parts[2]) return `tier-select-${parts[1]}-${parts[2]}`;
  if (parts[0] === "agents" && parts[1]) return `agent-select-${parts[1]}`;
  const catalog = parseCatalogPath(path);
  if (catalog) {
    // An alias error lands on the row's alias input (the page opens the editor).
    return catalog.field === "aliases" ? `catalog-aliases-input-${catalog.modelId}` : `catalog-row-${catalog.modelId}`;
  }
  if (parts[0] === "quarantine") return "catalog-section";
  if (parts[0] === "autoAdopt" && parts[1]) return `autoadopt-${parts[1]}`;
  return null;
}
