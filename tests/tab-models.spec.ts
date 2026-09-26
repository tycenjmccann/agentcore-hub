import { test, expect, type Page, type Route } from "@playwright/test";
import agentsConfig from "../src/config/agents.json";

/**
 * /models — the model registry console (TEAM-4996).
 *
 * Fully hermetic. Every /api/** call is intercepted in-page, so this spec needs no
 * AWS credentials, no registry in S3 and no admin session; it only needs the app
 * served at PLAYWRIGHT_BASE_URL (default http://localhost:3000). The registry mock
 * is STATEFUL — a POST bumps the version and later GETs serve the new document —
 * because the page re-reads after every write and a frozen fixture would make a
 * successful save look like it rolled back.
 *
 * What it is really guarding:
 *
 *  - The draft/save contract. One commit point, a POST body of exactly
 *    { baseVersion, registry } with no server-owned meta fields, a rollback body of
 *    exactly { baseVersion } on its own route, and polls that must never make the
 *    page dirty (a re-apply must not raise the save bar).
 *  - Every non-200 a write can return says what to do about it: 409 names both
 *    versions and reloads without a second request, 422 lights up the exact
 *    control, 207 says cost math is stale.
 *  - Nothing unselectable is ever offered: unpriced, candidate, retired and
 *    read-only judge models stay out of the selects, and an id that does not look
 *    like a model id never gets an "Add to catalog" button (TEAM-4994 finding 9).
 *
 * Deliberately imports NOTHING from src/components/models or src/app/models: those
 * two directories must be deletable with `tsc --noEmit` still green (AC8), so the
 * wire shapes are re-declared here as plain fixture types.
 *
 * Run: npx playwright test tests/tab-models.spec.ts
 */

// Under the gitignored playwright-screenshots/ (same convention as the workflow
// specs): a tracked path would dirty the tree on every `npm test`.
const SCREENSHOT_DIR = "playwright-screenshots/team-4996";

// ─── Model ids the fixture uses ─────────────────────────────────────────────

const FABLE = "us.anthropic.claude-fable-5-1";
const OPUS55 = "us.anthropic.claude-opus-5-5";
const OPUS5 = "us.anthropic.claude-opus-5";
const SONNET = "us.anthropic.claude-sonnet-5";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ASTRA = "us.openai.gpt-6-astra";
const SOL = "us.openai.gpt-6-sol";
const TERRA = "us.openai.gpt-5.6-terra";
const LUNA = "us.openai.gpt-6-luna";
const MANTLE = "openai.gpt-5.5";
/** Active and priced, so every codex select offers it — but never probed. */
const UNVERIFIED = "us.openai.gpt-6-vega";
const JUDGE = "anthropic.claude-opus-5";
/** A candidate with a price, a FAILED api probe and no cli probe — Adopt is blocked. */
const CANDIDATE = "us.anthropic.claude-opus-5-6";
const UNPRICED_CANDIDATE = "us.anthropic.claude-nova-preview";
const RETIRED = "us.anthropic.claude-sonnet-4-5";

const BUILDER = "agentcore_hub_builder";
const MANAGER = "agentcore_hub_workflow_manager";
const CI_AGENT = "agentcore_hub_ci_agent";
const PA = "personal_assistant_agent";
/** What PA runs in prod (TEAM-5067) — a re-pin from before the fable/opus persona move, still live. */
const PA_LIVE = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";

/** Seen in spans, absent from the catalog — the strip names it and points at Refresh. */
const SPAN_UNPRICED = "us.anthropic.claude-tiny-1";
/** Seen in spans and NOT a model id: rendered with a reason instead. */
const SPAN_EVIL = 'x"\n[evil]';
/** A valid id a sweep will never list (bare CLI short name) — TEAM-5011's third hint. */
const SPAN_BARE = "claude-opus-6";

/**
 * What a catalog refresh reports. The API names the ids, it does not count them —
 * WHICH model appeared is the thing an operator has to check — so the page's
 * "+2 added, 1 retired, 4 repriced" copy has to come from `.length`.
 */
const DISCOVERED = {
  added: [CANDIDATE, UNPRICED_CANDIDATE],
  retired: [RETIRED],
  repriced: [FABLE, OPUS5, SONNET, HAIKU],
  drifted: [],
};

// ─── Fixture types (local on purpose — see the docstring) ───────────────────

type Json = Record<string, unknown>;

interface FixturePrice {
  input: number;
  output: number;
  cacheReadInput?: number;
  cacheWrite?: number;
  source: "published" | "interim" | "manual";
  asOf: string;
}

interface FixtureProbe {
  ok: boolean;
  at: string;
  seconds?: number;
}

interface FixtureRow {
  modelId: string;
  label: string;
  vendor: "anthropic" | "openai";
  family: string;
  endpoint: "bedrock-runtime" | "bedrock-mantle";
  region: string;
  api: string;
  contextWindow: number;
  aliases: string[];
  price?: FixturePrice;
  probe?: { api?: FixtureProbe; cli?: FixtureProbe };
  status: "active" | "candidate" | "retired" | "quarantined";
  readOnly?: boolean;
  requiresMantle?: boolean;
}

interface FixtureDoc {
  version: number;
  updatedAt: string;
  updatedBy: string;
  defaults: Record<string, string>;
  tiers: { claude: Record<string, string>; codex: Record<string, string> };
  agents: Record<string, string>;
  autoAdopt?: Record<string, boolean>;
  quarantine: string[];
  legacyAliases: Record<string, string>;
  catalog: FixtureRow[];
}

// ─── Fixture ────────────────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 86_400_000;

function isoDay(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString().slice(0, 10);
}

const TODAY = isoDay(0);
/** 21 days is past the 14-day interim ceiling, so sol is reported overdue. */
const INTERIM_ASOF = isoDay(21 * DAY);

function price(
  input: number,
  output: number,
  cacheReadInput: number,
  cacheWrite: number,
  source: FixturePrice["source"] = "published",
  asOf = TODAY,
): FixturePrice {
  return { input, output, cacheReadInput, cacheWrite, source, asOf };
}

const PASSED: FixtureProbe = { ok: true, at: new Date(NOW - 2 * 3600_000).toISOString(), seconds: 3 };

function catalogFixture(): FixtureRow[] {
  const claude = (
    modelId: string,
    label: string,
    p: FixturePrice | undefined,
    extra: Partial<FixtureRow> = {},
  ): FixtureRow => ({
    modelId,
    label,
    vendor: "anthropic",
    family: "claude",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 200_000,
    aliases: [],
    price: p,
    probe: { api: PASSED, cli: PASSED },
    status: "active",
    ...extra,
  });
  const openai = (
    modelId: string,
    label: string,
    p: FixturePrice | undefined,
    extra: Partial<FixtureRow> = {},
  ): FixtureRow => ({
    modelId,
    label,
    vendor: "openai",
    family: "gpt",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "responses",
    contextWindow: 400_000,
    aliases: [],
    price: p,
    probe: { api: PASSED, cli: PASSED },
    status: "active",
    ...extra,
  });

  return [
    claude(FABLE, "Claude Fable 5.1", price(11, 55, 0.275, 13.75), { aliases: ["fable"] }),
    claude(OPUS55, "Claude Opus 5.5", price(4.4, 22, 0.22, 5.5)),
    claude(OPUS5, "Claude Opus 5", price(5.5, 27.5, 0.55, 6.875), { aliases: ["opus"] }),
    claude(SONNET, "Claude Sonnet 5", price(2.2, 11, 0.22, 2.75), { aliases: ["sonnet"] }),
    claude(HAIKU, "Claude Haiku 4.5", price(1.1, 5.5, 0.11, 1.375), { aliases: ["haiku"] }),
    openai(ASTRA, "GPT-6 astra", price(11, 55, 1.1, 13.75)),
    openai(SOL, "GPT-6 sol", price(4.4, 22, 0.44, 5.5, "interim", INTERIM_ASOF)),
    openai(TERRA, "GPT-5.6 terra", price(2.2, 13.2, 0.22, 2.75)),
    // Unpriced: the luna tier points at it, so the select has to show it as a
    // disabled, not-selectable option rather than silently re-pick.
    openai(LUNA, "GPT-6 luna", undefined),
    // Active, priced and therefore offered in every codex select — but with no probe
    // record, so adoptionErrors 422s it the moment it becomes a routing target. This
    // is the real TEAM-5038 journey: isSelectable never looks at probes.
    openai(UNVERIFIED, "GPT-6 vega", price(3.3, 16.5, 0.33, 4.125), { probe: {} }),
    openai(MANTLE, "GPT-5.5 (Mantle)", price(5.5, 33, 0.55, 6.875), {
      endpoint: "bedrock-mantle",
      region: "us-east-2",
      requiresMantle: true,
    }),
    claude(JUDGE, "Claude Opus 5 (judge)", price(5.5, 27.5, 0.55, 6.875), { readOnly: true }),
    claude(CANDIDATE, "Claude Opus 5.6", price(5.5, 27.5, 0.55, 6.875), {
      status: "candidate",
      probe: { api: { ok: false, at: new Date(NOW - 3600_000).toISOString(), seconds: 1 } },
    }),
    claude(UNPRICED_CANDIDATE, "Claude Nova preview", undefined, { status: "candidate", probe: {} }),
    claude(RETIRED, "Claude Sonnet 4.5", price(3, 15, 0.3, 3.75), { status: "retired" }),
  ];
}

function docFixture(): FixtureDoc {
  return {
    version: 12,
    updatedAt: new Date(NOW - 4 * 60_000).toISOString(),
    updatedBy: "ops@example.com",
    defaults: { persona: FABLE, codingClaude: FABLE, codingCodex: MANTLE },
    tiers: {
      claude: { fable: FABLE, opus: OPUS5, sonnet: SONNET, haiku: HAIKU },
      codex: { astra: ASTRA, sol: SOL, terra: TERRA, luna: LUNA },
    },
    agents: { [MANAGER]: FABLE, telegram_intake: SONNET },
    autoAdopt: { patch: true },
    quarantine: [],
    legacyAliases: {},
    catalog: catalogFixture(),
  };
}

const ROSTER_IDS: string[] = agentsConfig.agents.map((a) => a.agentId);
const ALL_DEPLOYABLE_IDS: string[] = [...ROSTER_IDS, "telegram_intake"];
const HARNESS_IDS: string[] = agentsConfig.agents.filter((a) => a.type === "harness").map((a) => a.agentId);

/**
 * `resolved` as GET /api/models/registry reports it, for all 46 deployables.
 *
 * ONLY the fields the API sends: {modelId, source, via?, harnessModel?}. It used to
 * also carry label/shortLabel/inherited, which the API has never sent — so this spec
 * passed while every agent card, agent-detail cell and board phase roll-up rendered a
 * dash (TEAM-5010 finding 1). Those three are DERIVED on the client from `source`
 * plus `registry.catalog`; deriveResolved's unit test
 * (src/lib/model-label.test.ts) is where they are asserted.
 *
 * `harnessOverrides` (TEAM-5067): what a harness OTHER than the builder reports it
 * is running, when it is not the registry's model — the same shape `drift`s, just
 * for the harnesses that never go through the apply-then-poll dance the builder
 * lane exercises (personal_assistant_agent, most notably, which has no apply path
 * at all).
 */
function resolvedFixture(doc: FixtureDoc, builderHarnessModel: string, harnessOverrides: Record<string, string> = {}): Json {
  const out: Json = {};
  const persona = doc.defaults.persona;
  for (const agentId of ALL_DEPLOYABLE_IDS) {
    const override = doc.agents[agentId];
    const modelId = override ?? persona;
    const entry: Json = { modelId, source: override ? "agents" : "defaults", via: "catalog" };
    if (HARNESS_IDS.includes(agentId)) {
      entry.harnessModel = agentId === BUILDER ? builderHarnessModel : (harnessOverrides[agentId] ?? modelId);
    }
    out[agentId] = entry;
  }
  return out;
}

/** Terminal runs, as /api/workflow/performance reports them to the unpriced strip. */
function runsFixture(): Json[] {
  return [
    {
      workflowId: "wf-models-4996",
      completedAt: new Date(NOW - 3600_000).toISOString(),
      cost: { unpricedModels: [SPAN_UNPRICED, SPAN_EVIL, SPAN_BARE] },
    },
    {
      workflowId: "wf-models-4995",
      completedAt: new Date(NOW - 2 * 3600_000).toISOString(),
      cost: { unpricedModels: [FABLE] },
    },
  ];
}

// ─── Mock harness ───────────────────────────────────────────────────────────

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

interface Responded {
  status: number;
  body?: unknown;
}

// May return a Promise: TEAM-5070's "held-open save" tests await a gate before
// resolving, so a response can be made to land after the operator has already
// edited the draft again.
type Responder = (req: { body: Json; mock: RegistryMock }) => Responded | Promise<Responded>;

interface RegistryMock {
  doc: FixtureDoc;
  previous: { version: number; updatedAt: string } | null;
  interimOverdue: string[];
  runs: Json[];
  /** What the builder harness reports it is running; differs from the registry = drift. */
  builderHarnessModel: string;
  /** What other harnesses report, when it is not the registry's model (TEAM-5067). */
  harnessOverrides: Record<string, string>;
  /** From this GET number on, the builder harness reports the registry's model. */
  settleOnGet: number | null;
  /** The `agents` array the default write responder returns. */
  applyResults: Json[];
  counts: { get: number; post: number; reapply: number; rollback: number; catalogGet: number; catalogPost: number; probe: number };
  bodies: { post: Json[]; reapply: Json[]; rollback: Json[]; catalogPost: Json[]; probe: Json[] };
  save: Responder | null;
  reapply: Responder | null;
  rollback: Responder | null;
  probe: Responder | null;
}

function newMock(overrides: Partial<RegistryMock> = {}): RegistryMock {
  return {
    doc: docFixture(),
    previous: { version: 11, updatedAt: "2026-09-22T14:07:00Z" },
    interimOverdue: [SOL],
    runs: runsFixture(),
    builderHarnessModel: SONNET,
    harnessOverrides: {},
    settleOnGet: null,
    applyResults: [],
    counts: { get: 0, post: 0, reapply: 0, rollback: 0, catalogGet: 0, catalogPost: 0, probe: 0 },
    bodies: { post: [], reapply: [], rollback: [], catalogPost: [], probe: [] },
    save: null,
    reapply: null,
    rollback: null,
    probe: null,
    ...overrides,
  };
}

/** What the server does on a successful write: keep the old version, publish a new one. */
function commit(mock: RegistryMock, registry?: Json): FixtureDoc {
  const base = (registry ?? mock.doc) as unknown as FixtureDoc;
  mock.previous = { version: mock.doc.version, updatedAt: mock.doc.updatedAt };
  mock.doc = {
    ...base,
    version: mock.doc.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "tester@example.com",
  };
  return mock.doc;
}

function writeBody(mock: RegistryMock, extra: Json = {}): Json {
  return {
    ok: true,
    registry: mock.doc,
    pricing: { status: "projected", version: mock.doc.version },
    agents: mock.applyResults,
    ...extra,
  };
}

function parseBody(route: Route): Json {
  const raw = route.request().postData();
  if (!raw) return {};
  return JSON.parse(raw) as Json;
}

/**
 * Registers every route the page can reach. Order matters: the catch-all goes in
 * FIRST because Playwright checks the most-recently-registered match first, and the
 * sub-paths of /api/models/registry go in AFTER it so `**\/registry**` never
 * swallows a reapply or a rollback.
 */
async function mockModels(page: Page, mock: RegistryMock) {
  await page.route("**/api/models/registry**", async (route) => {
    if (route.request().method() !== "POST") {
      mock.counts.get += 1;
      if (mock.settleOnGet != null && mock.counts.get >= mock.settleOnGet) {
        mock.builderHarnessModel = mock.doc.defaults.persona;
      }
      return json(route, {
        registry: mock.doc,
        previous: mock.previous,
        resolved: resolvedFixture(mock.doc, mock.builderHarnessModel, mock.harnessOverrides),
        interimOverdue: mock.interimOverdue,
      });
    }
    const body = parseBody(route);
    mock.counts.post += 1;
    mock.bodies.post.push(body);
    if (mock.save) {
      const r = await mock.save({ body, mock });
      return json(route, r.body ?? {}, r.status);
    }
    commit(mock, body.registry as Json);
    return json(route, writeBody(mock));
  });

  await page.route("**/api/models/registry/reapply", async (route) => {
    const body = parseBody(route);
    mock.counts.reapply += 1;
    mock.bodies.reapply.push(body);
    if (mock.reapply) {
      const r = await mock.reapply({ body, mock });
      return json(route, r.body ?? {}, r.status);
    }
    // A re-apply re-pins a harness; it does not publish a new registry version,
    // so the page must stay clean.
    return json(route, writeBody(mock, { agents: [{ agentId: body.agentId, previous: SONNET, current: FABLE, status: "applying" }] }));
  });

  await page.route("**/api/models/registry/rollback", async (route) => {
    const body = parseBody(route);
    mock.counts.rollback += 1;
    mock.bodies.rollback.push(body);
    if (mock.rollback) {
      const r = await mock.rollback({ body, mock });
      return json(route, r.body ?? {}, r.status);
    }
    commit(mock);
    return json(route, writeBody(mock));
  });

  // A refresh is a POST {refresh:true} and nothing else: `GET ?refresh=1` answers 405
  // server-side and a bare GET is the read-only view, so a page that still GETs to
  // refresh would silently discover nothing. Anything but {refresh:true} 400s here,
  // the same as the real route, so a wrong body cannot pass as a success.
  await page.route("**/api/models/catalog**", async (route) => {
    if (route.request().method() === "POST") {
      const body = parseBody(route);
      mock.counts.catalogPost += 1;
      mock.bodies.catalogPost.push(body);
      if (body.refresh !== true) {
        return json(route, { error: "bad_request", detail: "expected {refresh:true}" }, 400);
      }
      commit(mock);
      mock.doc = { ...mock.doc, updatedBy: "discovery" };
      return json(route, {
        ok: true,
        catalog: mock.doc.catalog,
        version: mock.doc.version,
        discovered: { ...DISCOVERED, errors: [] },
        pricing: { status: "projected", version: mock.doc.version },
      });
    }
    mock.counts.catalogGet += 1;
    return json(route, { catalog: mock.doc.catalog, version: mock.doc.version, source: "s3" });
  });

  await page.route("**/api/models/probe", async (route) => {
    const body = parseBody(route);
    mock.counts.probe += 1;
    mock.bodies.probe.push(body);
    if (mock.probe) {
      const r = await mock.probe({ body, mock });
      return json(route, r.body ?? {}, r.status);
    }
    // Accepted, and the result lands on the catalog row — which is what the page
    // polls for, so stamp it now and let the first poll find it.
    const modelId = String(body.modelId);
    const mode = String(body.mode) as "api" | "cli";
    mock.doc = {
      ...mock.doc,
      catalog: mock.doc.catalog.map((r) =>
        r.modelId === modelId
          ? { ...r, probe: { ...r.probe, [mode]: { ok: true, at: new Date().toISOString(), seconds: 2 } } }
          : r,
      ),
    };
    return json(route, { accepted: true, modelId, mode, pollAfterMs: 300 }, 202);
  });

  await page.route("**/api/workflow/performance**", (route) => json(route, { runs: mock.runs }));
}

/** Opens /models and waits for the document to have rendered. */
async function openModels(page: Page) {
  await page.goto("/models");
  await expect(page.getByTestId("models-meta")).toBeVisible({ timeout: 15_000 });
}

function optionValues(page: Page, testId: string) {
  return page
    .getByTestId(testId)
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
}

function optionLabels(page: Page, testId: string) {
  return page
    .getByTestId(testId)
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).textContent ?? ""));
}

/** Opens every collapsed group so the whole 46-row list is in the DOM. */
async function expandAllGroups(page: Page) {
  const headers = page.locator('[data-testid^="agents-group-"]');
  const count = await headers.count();
  for (let i = 0; i < count; i++) {
    const header = headers.nth(i);
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  }
}

test.describe("Models page (TEAM-4996)", () => {
  let mock: RegistryMock;

  test.beforeEach(async ({ page }) => {
    // Catch-all FIRST: Playwright checks the most-recently-registered matching
    // route first, so this (oldest) catches anything the per-case mocks below
    // don't cover, and never lets a call reach a live backend.
    await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.addInitScript(() => {
      localStorage.setItem("theme", "dark");
    });
    mock = newMock();
  });

  // ─── Rendering ────────────────────────────────────────────────────────────

  test("1. renders every section, the version header and the catalog counts", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockModels(page, mock);
    await openModels(page);

    await expect(page.getByTestId("models-page")).toBeVisible();

    for (const id of [
      "defaults-card",
      "tiers-card",
      "agents-section",
      "catalog-section",
      "judges-card",
      "unpriced-strip",
      "prior-version-panel",
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }

    const meta = page.getByTestId("models-meta");
    await expect(meta).toContainText("version 12");
    await expect(meta).toContainText("by ops@example.com");
    await expect(page.getByText("46 deployables, 15 catalog rows.")).toBeVisible();
    await expect(page.getByTestId("catalog-section")).toContainText("13 live rows, 1 retired");
    // Nothing is staged on load: the save bar is the whole answer to "am I dirty".
    await expect(page.getByTestId("save-bar")).toHaveCount(0);
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-page.png`, fullPage: true });
  });

  test("2. defaults offer only active, priced, non-judge models", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await expect(page.getByTestId("defaults-select-persona")).toHaveValue(FABLE);
    const persona = await optionValues(page, "defaults-select-persona");
    expect(persona).toEqual([FABLE, OPUS55, OPUS5, SONNET, HAIKU]);
    // The three reasons a row is withheld, each represented in the fixture.
    expect(persona).not.toContain(UNPRICED_CANDIDATE);
    expect(persona).not.toContain(JUDGE);
    expect(persona).not.toContain(CANDIDATE);
    expect(persona).not.toContain(RETIRED);
    for (const label of await optionLabels(page, "defaults-select-persona")) {
      expect(label).toContain("per 1M");
      expect(label).not.toContain("no price on record");
    }

    // codex takes OpenAI models only — including the Mantle-only row, which is
    // valid here and in the codex tiers and nowhere else.
    const codex = await optionValues(page, "defaults-select-codingCodex");
    expect(codex).toEqual([ASTRA, SOL, TERRA, UNVERIFIED, MANTLE]);
    await expect(page.getByTestId("defaults-card")).toContainText("bedrock-mantle, us-east-2");
  });

  test("3. tiers show the four-part rate, the overdue interim badge and an unselectable current value", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const tiers = page.getByTestId("tiers-card");
    await expect(page.getByTestId("tier-select-claude-opus")).toHaveValue(OPUS5);
    await expect(tiers).toContainText("$5.50 / $27.50 / $0.55 / $6.875 per 1M");

    // The AC9 literal: haiku's $1.375 cache-write is a real 3-decimal rate ABOVE the
    // old formatter's $1 gate, so this is the assertion F3a was failing.
    await expect(page.getByTestId("tier-select-claude-haiku")).toHaveValue(HAIKU);
    await expect(tiers).toContainText("$1.10 / $5.50 / $0.11 / $1.375 per 1M");

    // sol's interim price is 21 days old: past the ceiling, so the plain "interim"
    // badge gets a separate "interim <N>d" age chip alongside it (AC10).
    await expect(page.getByTestId("tier-select-codex-sol")).toHaveValue(SOL);
    await expect(tiers).toContainText("interim 21d");

    // luna points at an unpriced row, so the value stays visible but cannot be re-picked.
    const luna = page.getByTestId("tier-select-codex-luna");
    await expect(luna).toHaveValue(LUNA);
    await expect(luna.locator("option[disabled]")).toHaveText("GPT-6 luna - active (not selectable)");
    await expect(tiers).toContainText("no price on record");
  });

  test("4. lists all 46 deployables, grouped, with the intake Lambda pinned", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);
    await expandAllGroups(page);

    await expect(page.locator('[data-testid^="agent-row-"]')).toHaveCount(46);
    const counts = await page.locator('[data-testid^="agents-group-"] span:last-child').allTextContents();
    expect(counts.reduce((sum, n) => sum + Number(n), 0)).toBe(46);

    const pinned = page.getByTestId("agents-group-pinned-deployables");
    await expect(pinned).toContainText("Pinned deployables");
    await expect(pinned.locator("span:last-child")).toHaveText("5");
    await expect(page.getByTestId("agent-row-telegram_intake")).toBeVisible();
    await expect(page.getByTestId(`agent-row-${BUILDER}`)).toBeVisible();
    await expect(page.getByTestId("agents-overrides-count")).toHaveText("2 overrides");
    await expect(page.getByTestId(`agent-source-${MANAGER}`)).toHaveText("via override");
    await expect(page.getByTestId(`agent-source-${CI_AGENT}`)).toHaveText("via defaults");
  });

  test("5. search narrows the list and says so when nothing matches", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("agents-search").fill("ci_agent");
    await expect(page.getByTestId(`agent-row-${CI_AGENT}`)).toBeVisible();
    await expect(page.getByTestId("agent-row-telegram_intake")).toHaveCount(0);

    await page.getByTestId("agents-search").fill("zzz");
    await expect(page.getByTestId("agents-section")).toContainText('No deployable matches "zzz".');
  });

  // ─── Draft and save ───────────────────────────────────────────────────────

  test("6. an override raises the save bar, and Discard puts it back", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    // A search brings the row out of its collapsed group, which is how anyone
    // reaching for one deployable out of 46 actually gets to it.
    await page.getByTestId("agents-search").fill("ci_agent");
    await page.getByTestId(`agent-select-${CI_AGENT}`).selectOption(OPUS5);
    const bar = page.getByTestId("save-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("1 unsaved change");

    await page.getByTestId("save-discard").click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId(`agent-select-${CI_AGENT}`)).toHaveValue("");
    expect(mock.counts.post).toBe(0);
  });

  test("7. save posts { baseVersion, registry } with no server-owned fields and lands a new version", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("defaults-select-persona").selectOption(OPUS55);
    await page.getByTestId("save-button").click();

    await expect(page.getByTestId("models-meta")).toContainText("version 13");
    await expect(page.getByTestId("save-bar")).toHaveCount(0);

    expect(mock.bodies.post).toHaveLength(1);
    const body = mock.bodies.post[0];
    expect(Object.keys(body).sort()).toEqual(["baseVersion", "registry"]);
    expect(body.baseVersion).toBe(12);
    const registry = body.registry as Json;
    // The server owns these three; sending them back would invite a forged version.
    expect(registry).not.toHaveProperty("version");
    expect(registry).not.toHaveProperty("updatedAt");
    expect(registry).not.toHaveProperty("updatedBy");
    expect((registry.defaults as Json).persona).toBe(OPUS55);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-saved.png` });
  });

  test("8. a drifted harness re-applies by version+agentId and never makes the page dirty", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const pill = page.getByTestId(`agent-status-${BUILDER}`);
    await expect(pill).toHaveText("drift");
    await expect(pill).toHaveAttribute("title", `Running ${SONNET}, registry says ${FABLE}.`);
    // TEAM-5067: the live model shows next to the select, not just in the tooltip.
    await expect(page.getByTestId(`agent-harness-model-${BUILDER}`)).toContainText(SONNET);

    await page.getByTestId(`agent-reapply-${BUILDER}`).click();
    await expect(pill).toHaveText("applying");

    expect(mock.bodies.reapply).toEqual([{ version: 12, agentId: BUILDER }]);
    // A re-apply is not an edit: no staged change, so no save bar.
    await expect(page.getByTestId("save-bar")).toHaveCount(0);
    expect(mock.counts.post).toBe(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-drift.png` });
  });

  // ─── Catalog ──────────────────────────────────────────────────────────────

  test("9. a catalog row carries both probes and its actions", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const row = page.getByTestId(`catalog-row-${FABLE}`);
    await expect(row).toContainText("$11.00 / $55.00 / $0.275 / $13.75 per 1M");
    await expect(row).toContainText("aliases: fable");
    await expect(page.getByTestId(`catalog-probe-api-${FABLE}`)).toContainText("passed");
    await expect(page.getByTestId(`catalog-probe-cli-${FABLE}`)).toContainText("passed");
    await expect(page.getByTestId(`catalog-setprice-${FABLE}`)).toBeVisible();
    await expect(page.getByTestId(`catalog-test-${FABLE}`)).toBeVisible();
    await expect(page.getByTestId(`catalog-quarantine-${FABLE}`)).toBeVisible();
    // Active rows have nothing to adopt.
    await expect(page.getByTestId(`catalog-adopt-${FABLE}`)).toHaveCount(0);
  });

  test("9c. an alias edit is staged, saved through the registry POST, and lands on the row (TEAM-5065)", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId(`catalog-editaliases-${SONNET}`).click();
    const input = page.getByTestId(`catalog-aliases-input-${SONNET}`);
    await expect(input).toHaveValue("sonnet");
    await input.fill("sonnet, claude-sonnet-5, sonnet");
    await page.getByTestId(`catalog-aliases-save-${SONNET}`).click();

    await expect(page.getByTestId(`catalog-alias-editor-${SONNET}`)).toHaveCount(0);
    await expect(page.getByTestId("save-bar")).toContainText("1 unsaved change");
    await page.getByTestId("save-button").click();
    await expect(page.getByTestId("models-meta")).toContainText("version 13");

    const catalog = (mock.bodies.post[0].registry as Json).catalog as Json[];
    expect(catalog.find((r) => r.modelId === SONNET)?.aliases).toEqual(["sonnet", "claude-sonnet-5"]);
    await expect(page.getByTestId(`catalog-row-${SONNET}`)).toContainText("aliases: sonnet, claude-sonnet-5");
  });

  test("9d. a malformed alias is refused in the editor and never staged", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId(`catalog-editaliases-${SONNET}`).click();
    await page.getByTestId(`catalog-aliases-input-${SONNET}`).fill("sonnet, a b");
    await page.getByTestId(`catalog-aliases-save-${SONNET}`).click();

    await expect(page.getByTestId(`catalog-alias-editor-${SONNET}`)).toContainText("a b is not a valid model name");
    await expect(page.getByTestId("save-bar")).toHaveCount(0);
  });

  test("9e. a duplicate_alias 422 lands on the row's alias input and names the fix", async ({ page }) => {
    mock.save = () => ({
      status: 422,
      body: { error: "invalid_registry", fields: { [`catalog.${SONNET}.aliases.fable`]: "duplicate_alias" } },
    });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId(`catalog-editaliases-${SONNET}`).click();
    await page.getByTestId(`catalog-aliases-input-${SONNET}`).fill("sonnet, fable");
    await page.getByTestId(`catalog-aliases-save-${SONNET}`).click();
    await page.getByTestId("save-button").click();

    await expect(page.getByTestId(`catalog-alias-errors-${SONNET}`)).toHaveText(
      "fable is claimed by 2 catalog rows. Remove the alias from one row before saving.",
    );
    await expect(page.getByTestId(`catalog-aliases-input-${SONNET}`)).toBeFocused();
    await expect(page.getByTestId("save-bar")).toBeVisible();
  });

  test("9b. an overdue interim catalog row gets a badge, an age chip and a tinted row (AC10)", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    // sol: interim, 21 days old — past the 14-day ceiling. The plain "interim"
    // PriceSourceBadge stays warning-toned (never danger), and a SEPARATE
    // "interim <N>d" chip carries the overdue call-out, alongside the badge
    // rather than replacing its text.
    const sol = page.getByTestId(`catalog-row-${SOL}`);
    await expect(sol).toContainText("interim");
    await expect(sol).toContainText(/interim \d+d/);
    await expect(sol.getByText(/^interim$/)).toBeVisible();
    expect(await sol.getAttribute("class")).toContain("bg-warning-subtle/40");

    // luna carries no price at all, so it never renders a PriceSourceBadge in the
    // first place — the control case for "neither the chip nor the tint appear
    // unless a row is actually flagged overdue".
    const luna = page.getByTestId(`catalog-row-${LUNA}`);
    await expect(luna).not.toContainText(/interim \d+d/);
    expect(await luna.getAttribute("class")).not.toContain("bg-warning-subtle/40");
  });

  test("10. a candidate's Adopt is aria-disabled and says which probe is missing", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const adopt = page.getByTestId(`catalog-adopt-${CANDIDATE}`);
    await expect(adopt).toHaveAttribute("aria-disabled", "true");
    await expect(adopt).toHaveAttribute("aria-describedby", `catalog-adopt-reason-${CANDIDATE}`);
    await expect(page.locator(`[id="catalog-adopt-reason-${CANDIDATE}"]`)).toHaveText(
      "Adopt needs both smoke tests green. API smoke test: failed, CLI smoke test: never run.",
    );
    await expect(page.getByTestId(`catalog-probe-cli-${CANDIDATE}`)).toContainText("never run");

    // aria-disabled rather than disabled, so the reason stays reachable: the button
    // still takes focus, and Playwright's own actionability check refuses it the way
    // an assistive client would. Forcing the click through changes nothing.
    await adopt.focus();
    await expect(adopt).toBeFocused();
    await adopt.click({ force: true });
    await expect(page.getByTestId("save-bar")).toHaveCount(0);
  });

  test("11. retired rows stay collapsed until asked for", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await expect(page.getByTestId(`catalog-row-${RETIRED}`)).toHaveCount(0);
    const toggle = page.getByTestId("catalog-show-retired");
    await expect(toggle).toHaveText("Show 1 retired row");
    await toggle.click();
    await expect(page.getByTestId(`catalog-row-${RETIRED}`)).toBeVisible();
    await expect(toggle).toHaveText("Hide 1 retired row");
  });

  test("11b. Refresh catalog POSTs a discovery request and reports what changed", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("catalog-refresh").click();

    // The one shape the route accepts. A bare GET (what this used to send) reads the
    // stored catalog back and discovers nothing, so the button would "succeed" while
    // doing no work at all.
    await expect.poll(() => mock.bodies.catalogPost).toEqual([{ refresh: true }]);
    expect(mock.counts.catalogGet).toBe(0);

    // The counts are rendered from the returned id ARRAYS, not from numbers the
    // response never carried.
    await expect(page.getByTestId("catalog-refresh-result")).toContainText("+2 added, 1 retired, 4 repriced");

    // Discovery publishes a new registry version, so the header has to move with it.
    const meta = page.getByTestId("models-meta");
    await expect(meta).toContainText("version 13");
    await expect(meta).toContainText("by discovery");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/11b-refresh.png` });
  });

  test("12. judges are listed read-only, with no select and no catalog row", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const judges = page.getByTestId("judges-card");
    await expect(judges).toContainText("deploy/evaluations/dependency_chain_evaluator.json");
    await expect(judges).toContainText("deploy/evaluations/eval-config-ids.json");
    await expect(page.getByTestId(`judge-row-${JUDGE}`)).toContainText("$5.50 / $27.50");
    await expect(judges.locator("select")).toHaveCount(0);
    // Read-only rows are not in the catalog table: Adopt/Quarantine would be lies.
    await expect(page.getByTestId(`catalog-row-${JUDGE}`)).toHaveCount(0);
  });

  test("13. unpriced spans are reported as inert text — telemetry never writes the catalog", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const strip = page.getByTestId("unpriced-strip");
    // FABLE is in the catalog, so only the three unknown ids are reported.
    await expect(strip).toContainText("3 unpriced models seen in spans");
    await expect(strip).toContainText(SPAN_UNPRICED);
    // The second id is SPAN_EVIL, whose own characters make it unusable as a
    // selector — the row count plus its reason is the honest way to assert it.
    await expect(strip.locator("[data-testid^='unpriced-row-']")).toHaveCount(3);
    await expect(strip).toContainText("not a valid model id");

    // There is no route that adopts a model id out of a span attribute, so there is
    // no button either: a valid-looking id gets the discover-then-price hint instead.
    await expect(strip.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId(`unpriced-row-${SPAN_UNPRICED}`)).toContainText(
      "Not in the catalog. Press Refresh catalog to discover it, then set a price.",
    );
    // SPAN_BARE is a valid id shape, but discovery never lists a bare CLI short
    // name — TEAM-5011's third hint says so instead of implying Refresh would help.
    await expect(page.getByTestId(`unpriced-row-${SPAN_BARE}`)).toContainText(
      "Refresh catalog will not find this id",
    );
    await expect(page.getByTestId(`unpriced-row-${SPAN_BARE}`)).toContainText(
      "Add it as an alias on the catalog row that serves this model, then save.",
    );

    // The strip reaching the catalog route at all is the bug this pins.
    expect(mock.counts.catalogPost).toBe(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/13-unpriced.png` });
  });

  test("13b. a span naming a model by an EXISTING alias is not reported as unpriced (TEAM-5065)", async ({ page }) => {
    // "fable" is FABLE's alias, not its id — knownModelNames must resolve it too,
    // or an aliased span would be flagged missing forever even though pricing
    // already resolves it (pricingProjection writes every alias into pricing.json).
    mock.runs = [
      {
        workflowId: "wf-models-5065",
        completedAt: new Date(NOW - 3600_000).toISOString(),
        cost: { unpricedModels: [SPAN_UNPRICED, "fable"] },
      },
    ];
    await mockModels(page, mock);
    await openModels(page);

    const strip = page.getByTestId("unpriced-strip");
    await expect(strip).toContainText("1 unpriced model seen in spans");
    await expect(strip.locator("[data-testid^='unpriced-row-']")).toHaveCount(1);
    await expect(page.getByTestId(`unpriced-row-${SPAN_UNPRICED}`)).toBeVisible();
    await expect(page.getByTestId("unpriced-row-fable")).toHaveCount(0);
  });

  // ─── Rollback ─────────────────────────────────────────────────────────────

  test("14. rollback asks first, and cancelling changes nothing", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    const panel = page.getByTestId("prior-version-panel");
    await expect(panel).toContainText("Previous version (v11, saved 2026-09-22 14:07 UTC)");
    await page.getByTestId("rollback-button").click();

    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "Roll back to v11? This writes v11's content as version 13. Catalog prices and smoke test results from v12 are rolled back too.",
    );

    await page.getByTestId("confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("models-meta")).toContainText("version 12");
    expect(mock.counts.rollback).toBe(0);
  });

  /**
   * The confirmed half of case 14. The body is `{ baseVersion }` and nothing else
   * because the server always rolls back to models.prev.json — WHICH version is the
   * target is the dialog's business, not the request's — and a rollback is its own
   * route, never a save. Case 14 only ever cancelled, so until this case the whole
   * wire shape was asserted by rollbackRegistry's TypeScript signature (TEAM-5010
   * finding 2d).
   */
  test("14b. a confirmed rollback POSTs { baseVersion } only and lands the previous content as a new version", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("rollback-button").click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("confirm-accept").click();

    // toEqual is exact on keys: this fails on an extra `toVersion`, and on a
    // `registry`/`version` that would mean the page took the save path instead.
    await expect.poll(() => mock.bodies.rollback).toEqual([{ baseVersion: 12 }]);
    expect(Object.keys(mock.bodies.rollback[0])).toEqual(["baseVersion"]);
    expect(mock.counts.rollback).toBe(1);
    // The catch-all registry route would have recorded a `post` for a save.
    expect(mock.counts.post).toBe(0);

    // What the operator is left looking at: the dialog gone, a new version in the
    // header, nothing staged, and v12 now the version you could roll back to.
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("models-meta")).toContainText("version 13");
    await expect(page.getByTestId("save-bar")).toHaveCount(0);
    await expect(page.getByTestId("prior-version-panel")).toContainText("Previous version (v12");
    await expect(page.locator("[aria-live=polite]")).toHaveText("Rolled back to v11 as version 13.");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/14b-rolled-back.png` });
  });

  // ─── Write failures ───────────────────────────────────────────────────────

  test("15. a 409 names both versions and reloads without a second request", async ({ page }) => {
    mock.save = ({ mock: m }) => ({
      status: 409,
      body: { error: "version_conflict", live: { ...m.doc, version: 14, updatedBy: "someone-else@example.com" } },
    });
    await mockModels(page, mock);
    await openModels(page);
    expect(mock.counts.get).toBe(1);

    await page.getByTestId("defaults-select-persona").selectOption(OPUS55);
    await page.getByTestId("save-button").click();

    const banner = page.getByTestId("conflict-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("The server is on version 14, you loaded version 12");

    await page.getByTestId("conflict-reload").click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("models-meta")).toContainText("version 14");
    // The 409 already carried the live document, so reloading is a swap in memory.
    expect(mock.counts.get).toBe(1);
    await expect(page.getByTestId("save-bar")).toHaveCount(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/15-conflict.png` });
  });

  test("16. a 422 marks the exact control it rejected and says how to fix it", async ({ page }) => {
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unpriced" } } });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("defaults-select-persona").selectOption(OPUS55);
    await page.getByTestId("save-button").click();

    const luna = page.getByTestId("tier-select-codex-luna");
    await expect(luna).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#tier-codex-luna-error")).toHaveText(
      `${LUNA} has no published or manual price. Set a price in the catalog, then save again.`,
    );
    await expect(luna).toBeFocused();
    // Rejected, so nothing was published and the draft is still staged.
    await expect(page.getByTestId("models-meta")).toContainText("version 12");
    await expect(page.getByTestId("save-bar")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/16-invalid.png` });
  });

  test("16b. an unprobed tier says what to do and links to the Catalog row's Test menu", async ({ page }) => {
    // The shape the real server returns for a never-probed model newly routed to a
    // tier (src/app/api/models/registry/route.test.ts, "422s a model promoted...").
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unprobed" } } });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();

    const error = page.locator("#tier-codex-luna-error");
    await expect(error).toContainText("Test menu");
    await expect(error).toContainText(UNVERIFIED);
    await expect(error).not.toContainText(/probe/i);

    const action = page.getByTestId("tier-codex-luna-error-action");
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);
    await action.click();

    await expect(page.getByTestId(`catalog-test-${UNVERIFIED}`)).toBeFocused();
    await expect(page.getByTestId(`catalog-row-${UNVERIFIED}`)).toBeInViewport();

    // The destination speaks the same language as the message that sent them there.
    await page.getByTestId(`catalog-test-${UNVERIFIED}`).click();
    await expect(page.getByTestId(`catalog-test-api-${UNVERIFIED}`)).toContainText("API smoke test");
    await expect(page.getByTestId(`catalog-test-cli-${UNVERIFIED}`)).toContainText("CLI smoke test (~2 min)");
    await expect(page.getByRole("menu", { name: `Test ${UNVERIFIED}` })).not.toContainText(/probe/i);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/16b-unprobed.png` });
  });

  test("16h. an unprobed tier's message and action stay on-screen at 390px (TEAM-5120)", async ({ page }) => {
    // Below md the row used to be a fixed 2-column grid with 3 children: the
    // price/badge div wrapped into an `auto` column sized by its own max-content,
    // squeezing the select/message/action column down to a sliver. Assert on the
    // geometry, not `toBeVisible` — a 0-width message is still "visible" enough to
    // pass that check, and it's the width that regressed.
    await page.setViewportSize({ width: 390, height: 844 });
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unprobed" } } });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();

    const error = page.locator("#tier-codex-luna-error");
    await expect(error).toHaveCount(1);

    const wrapper = error.locator("..");
    const overflow = await wrapper.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    // Catches the collapsed-to-0 case: a wrapper that's technically non-overflowing
    // because it has no width at all would otherwise slip past the check above.
    expect(overflow.clientWidth).toBeGreaterThan(200);

    const wrapperBox = await wrapper.boundingBox();
    expect(wrapperBox).not.toBeNull();
    expect(wrapperBox!.x + wrapperBox!.width).toBeLessThanOrEqual(390);

    const action = page.getByTestId("tier-codex-luna-error-action");
    const actionBox = await action.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(390);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/16h-unprobed-mobile.png` });
  });

  test("16i. the Deployables header and every agent row fit at 390px (TEAM-5139)", async ({ page }) => {
    // The header's right-hand group (search input + Reset all) used to be a
    // non-wrapping flex row with a fixed w-72 input, wider than the 390px
    // viewport on its own. AgentRow's below-md grid gave the select an `auto`
    // column sized by its own max-content, squeezing the name/id column to a
    // sliver. Assert on the geometry, not visibility, for the same reason as 16h.
    await page.setViewportSize({ width: 390, height: 844 });
    await mockModels(page, mock);
    await openModels(page);
    await expandAllGroups(page);

    // Soft assertions so a single run surfaces every violation at once (both
    // the header overflow and the per-row squeeze), instead of stopping at
    // the first failure.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    // On failure, name the actual offending element instead of just the number —
    // a bare "459 > 390" tells you the page overflows, not which of the ~46 rows
    // or which header control is responsible.
    const culprits =
      scrollWidth > 390
        ? await page.evaluate(() => {
            const out: { tag: string; testid: string | null; cls: string; right: number }[] = [];
            document.querySelectorAll("*").forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.right > 391) {
                out.push({
                  tag: el.tagName,
                  testid: el.getAttribute("data-testid"),
                  cls: (el as HTMLElement).className,
                  right: Math.round(r.right),
                });
              }
            });
            return out.sort((a, b) => b.right - a.right).slice(0, 5);
          })
        : [];
    expect
      .soft(scrollWidth, `document.documentElement.scrollWidth; widest offenders: ${JSON.stringify(culprits)}`)
      .toBeLessThanOrEqual(390);

    const searchBox = await page.getByTestId("agents-search").boundingBox();
    expect(searchBox).not.toBeNull();
    expect.soft(searchBox!.x + searchBox!.width, "agents-search right edge").toBeLessThanOrEqual(390);

    const resetBox = await page.getByTestId("agents-reset-all").boundingBox();
    expect(resetBox).not.toBeNull();
    expect.soft(resetBox!.x + resetBox!.width, "agents-reset-all right edge").toBeLessThanOrEqual(390);

    const rows = page.locator('[data-testid^="agent-row-"]');
    await expect(rows).toHaveCount(46);
    const nameWidths = await rows.evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute("data-testid"),
        width: (el.firstElementChild as HTMLElement).getBoundingClientRect().width,
      })),
    );
    const tooNarrow = nameWidths.filter((r) => r.width < 120);
    expect.soft(tooNarrow, `name columns under 120px: ${JSON.stringify(tooNarrow)}`).toEqual([]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/16i-deployables-mobile.png` });
  });

  test("16j. desktop Deployables layout is unchanged (TEAM-5139)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockModels(page, mock);
    await openModels(page);
    await expandAllGroups(page);

    const searchBox = await page.getByTestId("agents-search").boundingBox();
    expect(searchBox).not.toBeNull();
    expect(Math.round(searchBox!.width)).toBe(288);

    const row = page.getByTestId(`agent-row-${MANAGER}`);
    const geometry = await row.evaluate((el) => {
      const style = getComputedStyle(el);
      const children = Array.from(el.children) as HTMLElement[];
      return {
        columns: style.gridTemplateColumns.split(" ").length,
        // Row uses items-center, so children of different heights land at
        // different `top`s even laid out correctly; a strictly increasing
        // `left` across children is what actually proves "one horizontal
        // row, not stacked".
        lefts: rects(children).map((r) => Math.round(r.left)),
        selectWidth: Math.round(rects(children)[1].width),
      };

      function rects(els: HTMLElement[]) {
        return els.map((c) => c.getBoundingClientRect());
      }
    });
    expect(geometry.columns).toBe(4);
    expect(geometry.lefts.length).toBe(4);
    for (let i = 1; i < geometry.lefts.length; i++) {
      expect(geometry.lefts[i]).toBeGreaterThan(geometry.lefts[i - 1]);
    }
    expect(geometry.selectWidth).toBe(288);
  });

  test("16c. a 422 held open still names the model that was actually saved, not one picked afterward", async ({ page }) => {
    // TEAM-5070 finding 1: the message is built from the draft captured at save
    // time; the action has to be built from that SAME snapshot, not from whatever
    // the draft has become by the time the response lands.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.save = async () => {
      await gate;
      return { status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unprobed" } } };
    };
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();
    await expect.poll(() => mock.counts.post).toBe(1);

    // The operator does not wait for the response: they point the same tier at a
    // second model while the (held-open) save is still in flight.
    await page.getByTestId("tier-select-codex-luna").selectOption(SOL);
    release();

    const error = page.locator("#tier-codex-luna-error");
    await expect(error).toContainText(UNVERIFIED);
    await expect(error).not.toContainText(SOL);

    const action = page.getByTestId("tier-codex-luna-error-action");
    await expect(action).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);
    await action.click();
    await expect(page.getByTestId(`catalog-test-${UNVERIFIED}`)).toBeFocused();
  });

  test("16d. the action's highlight ring lasts 2s from the most recent click, not the first", async ({ page }) => {
    // TEAM-5070 finding 2: ModelSelect's highlight timer was never cleared, so a
    // second click inside the 2s window still had its ring stripped by the first
    // click's timer.
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unprobed" } } });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();

    const action = page.getByTestId("tier-codex-luna-error-action");
    await expect(action).toBeVisible();
    // Attribute selector, not `#id`: the model id's dots would otherwise be read
    // as class delimiters by a literal CSS id selector.
    const target = page.getByTestId(`catalog-row-${UNVERIFIED}`);

    await action.click();
    await expect(target).toHaveClass(/ring-2/);

    await page.waitForTimeout(1400);
    await action.click(); // re-clicked before the first timer would have fired

    await page.waitForTimeout(700); // ~2.1s since the FIRST click alone
    await expect(target).toHaveClass(/ring-2/);

    await page.waitForTimeout(1600); // ~2.3s since the SECOND click
    await expect(target).not.toHaveClass(/ring-2/);
  });

  test("16e. a rejected field with no live row says so and offers the Catalog, not a phantom row", async ({ page }) => {
    // TEAM-5070 finding 3 made the action null when the row is not on the page;
    // TEAM-5077 finding 2: the sentence then still said "from the Test menu on its
    // Catalog row" — message and action disagreed. The server only says unprobed
    // about a candidate it can see, so no live row HERE means this catalog is stale:
    // both the sentence and the button now point at the Catalog's Refresh.
    const UNKNOWN = "us.openai.gpt-6-ghost";
    mock.doc.defaults.persona = RETIRED;
    mock.doc.tiers.codex.luna = UNKNOWN;
    mock.save = () => ({
      status: 422,
      body: { error: "invalid_registry", fields: { "defaults.persona": "unprobed", "tiers.codex.luna": "unprobed" } },
    });
    await mockModels(page, mock);
    await openModels(page);

    // An unrelated change so the save bar appears; neither rejected field is touched.
    await page.getByTestId("tier-select-claude-opus").selectOption(SONNET);
    await page.getByTestId("save-button").click();

    for (const [errorId, actionId, subject] of [
      ["#defaults-persona-error", "defaults-persona-error-action", RETIRED],
      ["#tier-codex-luna-error", "tier-codex-luna-error-action", UNKNOWN],
    ] as const) {
      const error = page.locator(errorId);
      await expect(error).toContainText(subject);
      await expect(error).toContainText("Refresh catalog");
      await expect(error).not.toContainText("on its Catalog row");
      await expect(error).not.toContainText(/probe/i);

      const action = page.getByTestId(actionId);
      await expect(action).toBeVisible();
      await expect(action).toHaveText("Open the Catalog");
      await expect(action).toHaveAttribute("data-target", "catalog-section");
    }

    // The button lands the operator at the Catalog's Refresh. It is disabled while
    // the draft is dirty (a 422 leaves it dirty), and its own note says what to do
    // first — which is the order the sentence above gave.
    await page.getByTestId("defaults-persona-error-action").click();
    await expect(page.getByTestId("catalog-section")).toBeInViewport();
    await expect(page.getByTestId("catalog-refresh")).toBeInViewport();
    await expect(page.getByTestId("catalog-refresh")).toBeDisabled();
    await expect(page.locator("#catalog-refresh-blocked")).toContainText("discard");
    // TEAM-5142 finding 1: Refresh is disabled here, so focus() on it was a no-op.
    // The Catalog section itself is now the fallback focus target.
    await expect(page.getByTestId("catalog-refresh")).not.toBeFocused();
    await expect(page.getByTestId("catalog-section")).toBeFocused();
  });

  test("16i. a row that vanishes between render and click still gets a real focus target", async ({ page }) => {
    // TEAM-5142 finding 1, second half: the action was built against a row that was
    // still on the page, but a probe poll landing between render and click absorbed
    // a fresh registry that no longer has it (rebaseChanges takes the server's
    // catalog wholesale). revealTarget's missing-target branch scrolled to the
    // Catalog and returned without focusing anything.
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { "tiers.codex.luna": "unprobed" } } });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();

    const action = page.getByTestId("tier-codex-luna-error-action");
    await expect(action).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);

    // The row disappears from the server's catalog. Starting a probe on an
    // unrelated row is what makes the page poll and absorb it (test 18's pattern);
    // absorb() rebuilds the draft's whole catalog from the polled server document.
    mock.doc = { ...mock.doc, catalog: mock.doc.catalog.filter((r) => r.modelId !== UNVERIFIED) };
    await page.getByTestId(`catalog-test-${CANDIDATE}`).click();
    await page.getByTestId(`catalog-test-api-${CANDIDATE}`).click();
    await expect(page.getByTestId(`catalog-row-${UNVERIFIED}`)).toHaveCount(0);

    // The action is still on-screen, still naming the row that is now gone.
    await expect(action).toBeVisible();
    await action.click();
    await expect(page.getByTestId("catalog-section")).toBeInViewport();
    await expect(page.getByTestId("catalog-section")).toBeFocused();
  });

  test("16j. a catalog-row 422 with no dedicated action focuses the row it names", async ({ page }) => {
    // Sibling site: applyInvalid's own auto-focus (independent of the action
    // button) resolves a rejected `catalog.<id>.price` path straight to the row via
    // pathToControlTestId, which was a plain, unfocusable div.
    mock.save = () => ({ status: 422, body: { error: "invalid_registry", fields: { [`catalog.${CANDIDATE}.price`]: "unpriced" } } });
    await mockModels(page, mock);
    await openModels(page);

    // An unrelated change so the save bar appears; the rejected field is untouched.
    await page.getByTestId("tier-select-claude-opus").selectOption(SONNET);
    await page.getByTestId("save-button").click();

    await expect(page.getByTestId(`catalog-row-${CANDIDATE}`)).toBeFocused();
  });

  test("16f. the highlight ring is one per page, not one per select", async ({ page }) => {
    // TEAM-5077 finding 1: each ModelSelect owned its own highlight timer, so a
    // second select's click could not cancel the first select's timer — the first
    // timer then stripped the ring the second click had just re-armed.
    await page.clock.install();
    mock.save = () => ({
      status: 422,
      body: { error: "invalid_registry", fields: { "defaults.codingCodex": "unprobed", "tiers.codex.luna": "unprobed" } },
    });
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("defaults-select-codingCodex").selectOption(UNVERIFIED);
    await page.getByTestId("tier-select-codex-luna").selectOption(UNVERIFIED);
    await page.getByTestId("save-button").click();

    const a = page.getByTestId("defaults-codingCodex-error-action");
    const b = page.getByTestId("tier-codex-luna-error-action");
    await expect(a).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);
    await expect(b).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);
    const target = page.getByTestId(`catalog-row-${UNVERIFIED}`);

    // Nothing is pending once the 422 has rendered, so freezing the page clock here
    // makes the two timers below the only things that can move.
    await page.clock.pauseAt(Date.now() + 2_000);

    await a.click();
    await expect(target).toHaveClass(/ring-2/);
    await page.clock.runFor(1_000);

    await b.click(); // a DIFFERENT select, same row, inside A's 2s window
    await page.clock.runFor(1_500); // 2.5s since A, 1.5s since B
    await expect(target).toHaveClass(/ring-2/);

    await page.clock.runFor(700); // 2.2s since B
    await expect(target).not.toHaveClass(/ring-2/);
  });

  test("16g. a select unmounting does not cancel a highlight it started", async ({ page }) => {
    // TEAM-5077 finding 1, other half: ModelSelect's unmount cleanup cleared the
    // timer AND stripped the ring — off a Catalog row the select never owned.
    await page.clock.install();
    mock.doc.agents[BUILDER] = UNVERIFIED;
    mock.save = () => ({
      status: 422,
      body: { error: "invalid_registry", fields: { [`agents.${BUILDER}`]: "unprobed" } },
    });
    await mockModels(page, mock);
    await openModels(page);
    await expandAllGroups(page);

    // An unrelated change so the save bar appears.
    await page.getByTestId("tier-select-claude-opus").selectOption(SONNET);
    await page.getByTestId("save-button").click();

    const action = page.getByTestId(`agent-${BUILDER}-select-error-action`);
    await expect(action).toHaveAttribute("data-target", `catalog-row-${UNVERIFIED}`);
    const target = page.getByTestId(`catalog-row-${UNVERIFIED}`);

    await page.clock.pauseAt(Date.now() + 2_000);
    await action.click();
    await expect(target).toHaveClass(/ring-2/);

    // Collapse the group: the AgentRow and its ModelSelect unmount mid-window.
    await page.getByTestId("agents-group-pinned-deployables").click();
    await expect(page.getByTestId(`agent-select-${BUILDER}`)).toHaveCount(0);
    await page.clock.runFor(1_000);
    await expect(target).toHaveClass(/ring-2/);

    await page.clock.runFor(1_100); // past 2s since the click
    await expect(target).not.toHaveClass(/ring-2/);
  });

  test("17. a 207 says the registry saved but cost math is stale, and re-applies pricing", async ({ page }) => {
    mock.save = ({ body, mock: m }) => {
      commit(m, body.registry as Json);
      return {
        status: 207,
        body: {
          ok: false,
          registry: m.doc,
          pricing: { status: "failed", error: "price list fetch timed out" },
          agents: [],
        },
      };
    };
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId("defaults-select-persona").selectOption(OPUS55);
    await page.getByTestId("save-button").click();

    const banner = page.getByTestId("pricing-failed-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Registry saved as version 13, but the pricing projection failed: price list fetch timed out.");
    await expect(banner).toContainText("Cost math is using the previous prices until you re-apply.");
    // The registry itself did land.
    await expect(page.getByTestId("models-meta")).toContainText("version 13");

    await page.getByTestId("pricing-reapply").click();
    await expect(banner).toHaveCount(0);
    // `version` is the whole body: the route reads `version` (and an optional
    // `agentId`) and drops anything else, so a `pricing` flag only implied a
    // narrowing the API does not offer.
    expect(mock.bodies.reapply).toEqual([{ version: 13 }]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/17-pricing-failed.png` });
  });

  // ─── Polls ────────────────────────────────────────────────────────────────

  test("18. starting an api probe polls the registry and announces the result", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await expect(page.getByTestId(`catalog-probe-api-${CANDIDATE}`)).toContainText("failed");
    await page.getByTestId(`catalog-test-${CANDIDATE}`).click();
    await page.getByTestId(`catalog-test-api-${CANDIDATE}`).click();

    await expect(page.getByTestId(`catalog-probe-api-${CANDIDATE}`)).toContainText("passed", { timeout: 10_000 });
    await expect(page.locator("[aria-live=polite]")).toHaveText(`API smoke test passed for ${CANDIDATE}.`);
    expect(mock.bodies.probe).toEqual([{ modelId: CANDIDATE, mode: "api" }]);
    // The Adopt reason is recomputed from the polled document, so it now names the
    // one probe still missing instead of the two it started with.
    await expect(page.locator(`[id="catalog-adopt-reason-${CANDIDATE}"]`)).toHaveText(
      "Adopt needs both smoke tests green. API smoke test: passed, CLI smoke test: never run.",
    );
    // TEAM-5070 finding 4: the badge's own tooltip speaks the same vocabulary.
    await expect(page.getByTestId(`catalog-probe-cli-${CANDIDATE}`).locator("span[title]")).toHaveAttribute(
      "title",
      "CLI smoke test never run",
    );
  });

  test("19. an applying harness keeps polling until it reports the registry's model", async ({ page }) => {
    test.setTimeout(60_000);
    mock.applyResults = [{ agentId: BUILDER, previous: SONNET, current: FABLE, status: "applying" }];
    // GET 1 is the initial load and 2 the post-save read; the harness settles on
    // the SECOND poll, so a poll that stopped after one tick would hang here.
    mock.settleOnGet = 4;
    await mockModels(page, mock);
    await openModels(page);

    await page.getByTestId(`agent-select-${BUILDER}`).selectOption(FABLE);
    await page.getByTestId("save-button").click();

    const pill = page.getByTestId(`agent-status-${BUILDER}`);
    await expect(pill).toHaveText("applying");
    await expect(pill).toHaveText("live", { timeout: 30_000 });
    expect(mock.counts.get).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId(`agent-reapply-${BUILDER}`)).toBeVisible();
  });

  // ─── personal_assistant_agent drift (TEAM-5067) ────────────────────────────

  test("20. a drifted harness outside the apply path says drift, names both models and offers no re-apply", async ({ page }) => {
    mock.harnessOverrides = { [PA]: PA_LIVE };
    await mockModels(page, mock);
    await openModels(page);

    const pill = page.getByTestId(`agent-status-${PA}`);
    await expect(pill).toHaveText("drift");
    await expect(pill).not.toHaveText("live");
    const title = await pill.getAttribute("title");
    expect(title).toContain(PA_LIVE);
    expect(title).toContain(mock.doc.defaults.persona);

    await expect(page.getByTestId(`agent-harness-model-${PA}`)).toContainText(PA_LIVE);
    await expect(page.getByTestId(`agent-reapply-${PA}`)).toHaveCount(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/20-pa-drift.png` });
  });

  test("20b. an in-sync personal_assistant_agent stays live with no harness line and no re-apply", async ({ page }) => {
    await mockModels(page, mock);
    await openModels(page);

    await expect(page.getByTestId(`agent-status-${PA}`)).toHaveText("live");
    await expect(page.getByTestId(`agent-harness-model-${PA}`)).toHaveCount(0);
    await expect(page.getByTestId(`agent-reapply-${PA}`)).toHaveCount(0);
  });
});
