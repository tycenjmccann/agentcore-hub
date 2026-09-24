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
 *    { baseVersion, registry } with no server-owned meta fields, and polls that
 *    must never make the page dirty (a re-apply must not raise the save bar).
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
const JUDGE = "anthropic.claude-opus-5";
/** A candidate with a price, a FAILED api probe and no cli probe — Adopt is blocked. */
const CANDIDATE = "us.anthropic.claude-opus-5-6";
const UNPRICED_CANDIDATE = "us.anthropic.claude-nova-preview";
const RETIRED = "us.anthropic.claude-sonnet-4-5";

const BUILDER = "agentcore_hub_builder";
const MANAGER = "agentcore_hub_workflow_manager";
const CI_AGENT = "agentcore_hub_ci_agent";

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
 */
function resolvedFixture(doc: FixtureDoc, builderHarnessModel: string): Json {
  const out: Json = {};
  const persona = doc.defaults.persona;
  for (const agentId of ALL_DEPLOYABLE_IDS) {
    const override = doc.agents[agentId];
    const modelId = override ?? persona;
    const entry: Json = { modelId, source: override ? "agents" : "defaults", via: "catalog" };
    if (HARNESS_IDS.includes(agentId)) {
      entry.harnessModel = agentId === BUILDER ? builderHarnessModel : modelId;
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

type Responder = (req: { body: Json; mock: RegistryMock }) => Responded;

interface RegistryMock {
  doc: FixtureDoc;
  previous: { version: number; updatedAt: string } | null;
  interimOverdue: string[];
  runs: Json[];
  /** What the builder harness reports it is running; differs from the registry = drift. */
  builderHarnessModel: string;
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
        resolved: resolvedFixture(mock.doc, mock.builderHarnessModel),
        interimOverdue: mock.interimOverdue,
      });
    }
    const body = parseBody(route);
    mock.counts.post += 1;
    mock.bodies.post.push(body);
    if (mock.save) {
      const r = mock.save({ body, mock });
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
      const r = mock.reapply({ body, mock });
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
      const r = mock.rollback({ body, mock });
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
      const r = mock.probe({ body, mock });
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
    await expect(page.getByText("46 deployables, 14 catalog rows.")).toBeVisible();
    await expect(page.getByTestId("catalog-section")).toContainText("12 live rows, 1 retired");
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
    expect(codex).toEqual([ASTRA, SOL, TERRA, MANTLE]);
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
      "Adopt needs both probes green. api: failed, cli: never run.",
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
    await expect(page.getByTestId(`unpriced-row-${SPAN_BARE}`)).toContainText("cannot edit yet");

    // The strip reaching the catalog route at all is the bug this pins.
    expect(mock.counts.catalogPost).toBe(0);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/13-unpriced.png` });
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
      "Roll back to v11? This writes v11's content as version 13. Catalog prices and probe results from v12 are rolled back too.",
    );

    await page.getByTestId("confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("models-meta")).toContainText("version 12");
    expect(mock.counts.rollback).toBe(0);
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
    await expect(page.locator("[aria-live=polite]")).toHaveText(`api probe passed for ${CANDIDATE}.`);
    expect(mock.bodies.probe).toEqual([{ modelId: CANDIDATE, mode: "api" }]);
    // The Adopt reason is recomputed from the polled document, so it now names the
    // one probe still missing instead of the two it started with.
    await expect(page.locator(`[id="catalog-adopt-reason-${CANDIDATE}"]`)).toHaveText(
      "Adopt needs both probes green. api: passed, cli: never run.",
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
});
