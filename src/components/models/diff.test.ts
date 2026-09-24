import { describe, it, expect } from "vitest";
import {
  adoptBlockedReason,
  dependentsOf,
  diffRegistry,
  isSelectable,
  rebaseChanges,
  selectableRows,
  stripMeta,
} from "./diff";
import {
  DEPLOYABLES,
  GROUP_ORDER,
  PINNED_GROUP,
  groupFor,
  isValidModelId,
  pathToControlTestId,
  type CatalogRow,
  type RegistryDoc,
} from "./types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FABLE = "us.anthropic.claude-fable-5-1";
const SONNET = "us.anthropic.claude-sonnet-5";
const OPUS = "us.anthropic.claude-opus-5";
const CANDIDATE = "us.anthropic.claude-opus-5-6";
const MANTLE = "openai.gpt-5.5";
const ASTRA = "us.openai.gpt-6-astra";
const JUDGE = "anthropic.claude-opus-5";

function row(over: Partial<CatalogRow> & { modelId: string }): CatalogRow {
  return {
    label: over.modelId,
    vendor: "anthropic",
    family: "claude",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 200_000,
    aliases: [],
    status: "active",
    price: { input: 11, output: 55, cacheReadInput: 0.275, cacheWrite: 13.75, source: "published", asOf: "2026-09-01" },
    ...over,
  };
}

function doc(over: Partial<RegistryDoc> = {}): RegistryDoc {
  return {
    version: 12,
    updatedAt: "2026-09-24T10:00:00Z",
    updatedBy: "tycen",
    defaults: { persona: FABLE, codingClaude: FABLE, codingCodex: MANTLE },
    tiers: {
      claude: { fable: FABLE, opus: OPUS, sonnet: SONNET, haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
      codex: { astra: ASTRA, sol: "us.openai.gpt-6-sol", terra: "us.openai.gpt-5.6-terra", luna: "us.openai.gpt-6-luna" },
    },
    agents: { agentcore_hub_workflow_manager: FABLE, telegram_intake: SONNET },
    quarantine: [],
    legacyAliases: {},
    catalog: [
      row({ modelId: FABLE, label: "Fable 5.1" }),
      row({ modelId: SONNET, label: "Sonnet 5", price: { input: 2.2, output: 11, source: "published", asOf: "2026-09-01" } }),
      row({ modelId: OPUS, label: "Opus 5", price: { input: 5.5, output: 27.5, source: "published", asOf: "2026-09-01" } }),
      row({ modelId: MANTLE, label: "GPT-5.5", vendor: "openai", family: "gpt", endpoint: "bedrock-mantle", region: "us-east-2", requiresMantle: true, price: { input: 5.5, output: 33, source: "published", asOf: "2026-09-01" } }),
      row({ modelId: ASTRA, label: "GPT-6 Astra", vendor: "openai", family: "gpt" }),
      row({ modelId: JUDGE, label: "Opus 5 (judge)", readOnly: true, price: { input: 5.5, output: 27.5, source: "published", asOf: "2026-09-01" } }),
      row({ modelId: CANDIDATE, label: "Opus 5.6", status: "candidate", probe: { api: { ok: true, at: "2026-09-23T00:00:00Z" } } }),
      row({ modelId: "us.anthropic.claude-unpriced", label: "Unpriced", status: "candidate", price: undefined }),
      row({ modelId: "us.anthropic.claude-old", label: "Retired", status: "retired" }),
    ],
    ...over,
  };
}

// ─── stripMeta ──────────────────────────────────────────────────────────────

describe("stripMeta", () => {
  it("drops the three server-owned fields and keeps everything else", () => {
    const stripped = stripMeta(doc()) as Record<string, unknown>;
    expect(stripped.version).toBeUndefined();
    expect(stripped.updatedAt).toBeUndefined();
    expect(stripped.updatedBy).toBeUndefined();
    expect(Object.keys(stripped).sort()).toEqual(
      ["agents", "catalog", "defaults", "legacyAliases", "quarantine", "tiers"],
    );
  });
});

// ─── diffRegistry ───────────────────────────────────────────────────────────

describe("diffRegistry", () => {
  it("sees no change between a document and itself", () => {
    const d = doc();
    expect(diffRegistry(d, d)).toEqual([]);
  });

  it("stages a defaults change with formatted from/to", () => {
    const changes = diffRegistry(doc(), doc({ defaults: { persona: OPUS, codingClaude: FABLE, codingCodex: MANTLE } }));
    expect(changes).toEqual([
      { path: "defaults.persona", label: "Persona default", from: FABLE, to: OPUS },
    ]);
  });

  it("stages claude and codex tier changes under distinct paths", () => {
    const draft = doc();
    draft.tiers.claude.opus = CANDIDATE;
    draft.tiers.codex.luna = ASTRA;
    const paths = diffRegistry(doc(), draft).map((c) => c.path);
    expect(paths).toEqual(["tiers.claude.opus", "tiers.codex.luna"]);
  });

  it("stages a per-agent override, and reports a removal as inherit", () => {
    const added = doc();
    added.agents.agentcore_hub_ci_agent = SONNET;
    expect(diffRegistry(doc(), added)).toEqual([
      { path: "agents.agentcore_hub_ci_agent", label: "CI Validation Agent", from: "inherit", to: SONNET },
    ]);

    const removed = doc({ agents: { telegram_intake: SONNET } });
    const one = diffRegistry(doc(), removed);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ path: "agents.agentcore_hub_workflow_manager", to: "inherit" });
  });

  it("collapses a reset-all-to-inherit into one change", () => {
    const changes = diffRegistry(doc(), doc({ agents: {} }));
    expect(changes).toEqual([
      { path: "agents", label: "Agent overrides", from: "2 overrides", to: "inherit" },
    ]);
  });

  it("does not collapse when a single override is cleared", () => {
    const changes = diffRegistry(doc({ agents: { telegram_intake: SONNET } }), doc({ agents: {} }));
    expect(changes.map((c) => c.path)).toEqual(["agents.telegram_intake"]);
  });

  it("stages catalog price and status separately, and a new row as one change", () => {
    const draft = doc();
    draft.catalog = draft.catalog.map((r) =>
      r.modelId === SONNET
        ? { ...r, price: { input: 3, output: 12, source: "manual", asOf: "2026-09-24" }, status: "quarantined" }
        : r,
    );
    draft.catalog.push(row({ modelId: "us.anthropic.claude-brand-new", label: "Brand new", status: "candidate" }));

    const changes = diffRegistry(doc(), draft);
    expect(changes.map((c) => c.path)).toEqual([
      `catalog.${SONNET}.price`,
      `catalog.${SONNET}.status`,
      "catalog.us.anthropic.claude-brand-new",
    ]);
    expect(changes[0].from).toBe("$2.20 / $11.00 per 1M (published)");
    expect(changes[0].to).toBe("$3.00 / $12.00 per 1M (manual)");
    expect(changes[2]).toMatchObject({ from: "not in catalog", to: "candidate" });
  });

  it("reports the whole quarantine list as a single change", () => {
    const changes = diffRegistry(doc(), doc({ quarantine: [SONNET, OPUS] }));
    expect(changes).toEqual([
      { path: "quarantine", label: "Quarantine", from: "none", to: `${OPUS}, ${SONNET}` },
    ]);
  });

  it("ignores list order inside quarantine", () => {
    expect(diffRegistry(doc({ quarantine: [SONNET, OPUS] }), doc({ quarantine: [OPUS, SONNET] }))).toEqual([]);
  });

  it("stages autoAdopt toggles", () => {
    const changes = diffRegistry(doc({ autoAdopt: { haiku: false } }), doc({ autoAdopt: { haiku: true } }));
    expect(changes).toEqual([{ path: "autoAdopt.haiku", label: "Auto-adopt haiku", from: "off", to: "on" }]);
  });

  // The page polls the registry while probes and applies run; if a probe result
  // counted as an edit, the save bar would appear on its own.
  it("never treats a probe result or a meta bump as a change", () => {
    const polled = doc({ version: 13, updatedAt: "2026-09-24T11:00:00Z", updatedBy: "someone-else" });
    polled.catalog = polled.catalog.map((r) =>
      r.modelId === CANDIDATE
        ? { ...r, probe: { api: { ok: true, at: "2026-09-24T11:00:00Z" }, cli: { ok: true, at: "2026-09-24T11:01:00Z", seconds: 74 } } }
        : r,
    );
    expect(diffRegistry(doc(), polled)).toEqual([]);
  });

  it("emits paths that every control can be found from", () => {
    const draft = doc({ defaults: { persona: OPUS, codingClaude: FABLE, codingCodex: MANTLE }, quarantine: [SONNET] });
    draft.tiers.codex.luna = ASTRA;
    draft.agents.agentcore_hub_ci_agent = SONNET;
    draft.catalog = draft.catalog.map((r) => (r.modelId === OPUS ? { ...r, status: "retired" } : r));

    for (const change of diffRegistry(doc(), draft)) {
      expect(pathToControlTestId(change.path), change.path).not.toBeNull();
    }
  });
});

// ─── rebaseChanges ──────────────────────────────────────────────────────────

describe("rebaseChanges", () => {
  it("keeps the draft edit on a higher-version server document", () => {
    const server = doc();
    const draft = doc({ defaults: { persona: OPUS, codingClaude: FABLE, codingCodex: MANTLE } });
    const changes = diffRegistry(server, draft);

    const newServer = doc({ version: 14, updatedBy: "someone-else" });
    const rebased = rebaseChanges(changes, newServer, draft);

    expect(rebased.version).toBe(14);
    expect(rebased.defaults.persona).toBe(OPUS);
    // Still exactly one staged change, now against the newer base.
    expect(diffRegistry(newServer, rebased)).toEqual(changes);
  });

  it("adopts server-side facts the draft never touched", () => {
    const server = doc();
    const draft = doc();
    draft.agents.agentcore_hub_ci_agent = SONNET;
    const changes = diffRegistry(server, draft);

    // Someone else quarantined a model and a probe landed while we were editing.
    const newServer = doc({ version: 15, quarantine: [ASTRA] });
    const rebased = rebaseChanges(changes, newServer, draft);

    expect(rebased.quarantine).toEqual([ASTRA]);
    expect(rebased.agents.agentcore_hub_ci_agent).toBe(SONNET);
  });

  it("carries a collapsed reset-all across a rebase", () => {
    const draft = doc({ agents: {} });
    const changes = diffRegistry(doc(), draft);
    const rebased = rebaseChanges(changes, doc({ version: 13 }), draft);
    expect(rebased.agents).toEqual({});
  });

  it("carries a price edit but drops one whose row the server retired away", () => {
    const draft = doc();
    draft.catalog = draft.catalog.map((r) =>
      r.modelId === SONNET ? { ...r, price: { input: 3, output: 12, source: "manual", asOf: "2026-09-24" } } : r,
    );
    const changes = diffRegistry(doc(), draft);

    const kept = rebaseChanges(changes, doc({ version: 13 }), draft);
    expect(kept.catalog.find((r) => r.modelId === SONNET)?.price?.input).toBe(3);

    const gone = doc({ version: 13 });
    gone.catalog = gone.catalog.filter((r) => r.modelId !== SONNET);
    const rebased = rebaseChanges(changes, gone, draft);
    expect(rebased.catalog.find((r) => r.modelId === SONNET)).toBeUndefined();
    expect(diffRegistry(gone, rebased)).toEqual([]);
  });

  it("does not mutate the server document it rebases onto", () => {
    const newServer = doc({ version: 14 });
    const draft = doc({ defaults: { persona: OPUS, codingClaude: FABLE, codingCodex: MANTLE } });
    rebaseChanges(diffRegistry(doc(), draft), newServer, draft);
    expect(newServer.defaults.persona).toBe(FABLE);
  });
});

// ─── isSelectable ───────────────────────────────────────────────────────────

describe("isSelectable", () => {
  const q: string[] = [];

  it("offers an active, priced, runtime Anthropic model to the persona default", () => {
    expect(isSelectable(row({ modelId: FABLE }), "persona", q)).toBe(true);
  });

  it("refuses an unpriced model", () => {
    expect(isSelectable(row({ modelId: FABLE, price: undefined }), "persona", q)).toBe(false);
    expect(isSelectable(row({ modelId: FABLE, price: { input: 11, output: undefined as unknown as number, source: "manual", asOf: "x" } }), "persona", q)).toBe(false);
  });

  it("refuses anything not active", () => {
    for (const status of ["candidate", "retired", "quarantined"] as const) {
      expect(isSelectable(row({ modelId: FABLE, status }), "persona", q)).toBe(false);
    }
  });

  it("refuses a read-only judge model everywhere", () => {
    const judge = row({ modelId: JUDGE, readOnly: true });
    expect(isSelectable(judge, "persona", q)).toBe(false);
    expect(isSelectable(judge, "claudeTier", q)).toBe(false);
    expect(isSelectable(judge, "agent", q)).toBe(false);
  });

  it("refuses a quarantined model even while its row still says active", () => {
    expect(isSelectable(row({ modelId: FABLE }), "persona", [FABLE])).toBe(false);
  });

  it("splits Anthropic and OpenAI by field", () => {
    const claude = row({ modelId: FABLE });
    const openai = row({ modelId: ASTRA, vendor: "openai", family: "gpt" });
    for (const field of ["persona", "codingClaude", "claudeTier", "agent"] as const) {
      expect(isSelectable(claude, field, q), field).toBe(true);
      expect(isSelectable(openai, field, q), field).toBe(false);
    }
    for (const field of ["codingCodex", "codexTier"] as const) {
      expect(isSelectable(openai, field, q), field).toBe(true);
      expect(isSelectable(claude, field, q), field).toBe(false);
    }
  });

  // codingCodex's endpoint comes from the catalog row, so Mantle-only models are
  // valid there and in the Codex tiers, and nowhere else.
  it("accepts a Mantle-only OpenAI model for codex, rejects a Mantle Anthropic model for persona", () => {
    const mantleOpenai = row({ modelId: MANTLE, vendor: "openai", family: "gpt", endpoint: "bedrock-mantle", requiresMantle: true });
    expect(isSelectable(mantleOpenai, "codingCodex", q)).toBe(true);
    expect(isSelectable(mantleOpenai, "codexTier", q)).toBe(true);

    const mantleClaude = row({ modelId: "mantle.claude", endpoint: "bedrock-mantle" });
    expect(isSelectable(mantleClaude, "persona", q)).toBe(false);
  });

  it("selectableRows never offers the unpriced, judge, candidate or retired rows", () => {
    const ids = selectableRows(doc().catalog, "persona").map((r) => r.modelId);
    expect(ids).toContain(FABLE);
    expect(ids).not.toContain(JUDGE);
    expect(ids).not.toContain(CANDIDATE);
    expect(ids).not.toContain("us.anthropic.claude-unpriced");
    expect(ids).not.toContain("us.anthropic.claude-old");
    expect(ids).not.toContain(MANTLE);
  });
});

// ─── adoptBlockedReason / dependentsOf ──────────────────────────────────────

describe("adoptBlockedReason", () => {
  it("names the state of each probe when either is not green", () => {
    expect(adoptBlockedReason(row({ modelId: CANDIDATE, probe: { api: { ok: true, at: "x" } } })))
      .toBe("Adopt needs both probes green. api: passed, cli: never run.");
    expect(adoptBlockedReason(row({ modelId: CANDIDATE, probe: { api: { ok: false, at: "x" }, cli: { ok: true, at: "y" } } })))
      .toBe("Adopt needs both probes green. api: failed, cli: passed.");
    expect(adoptBlockedReason(row({ modelId: CANDIDATE })))
      .toBe("Adopt needs both probes green. api: never run, cli: never run.");
  });

  it("returns null once both probes pass", () => {
    expect(adoptBlockedReason(row({ modelId: CANDIDATE, probe: { api: { ok: true, at: "x" }, cli: { ok: true, at: "y" } } }))).toBeNull();
  });
});

describe("dependentsOf", () => {
  it("finds every default, tier and agent pointing at a model", () => {
    expect(dependentsOf(doc(), FABLE)).toEqual({
      tiers: ["claude.fable", "defaults.persona", "defaults.codingClaude"],
      agents: ["agentcore_hub_workflow_manager"],
    });
  });

  it("finds nothing for an unreferenced model", () => {
    expect(dependentsOf(doc(), CANDIDATE)).toEqual({ tiers: [], agents: [] });
  });
});

// ─── The roster (46 deployables) ────────────────────────────────────────────

describe("deployables", () => {
  it("is the 45-row roster plus the intake Lambda", () => {
    expect(DEPLOYABLES).toHaveLength(46);
    expect(DEPLOYABLES.filter((d) => d.agentId === "telegram_intake")).toHaveLength(1);
    expect(new Set(DEPLOYABLES.map((d) => d.agentId)).size).toBe(46);
  });

  it("puts every deployable in exactly one known group", () => {
    const counts: Record<string, number> = {};
    for (const d of DEPLOYABLES) {
      const group = groupFor(d);
      expect(GROUP_ORDER, d.agentId).toContain(group);
      counts[group] = (counts[group] ?? 0) + 1;
    }
    expect(counts).toEqual({
      [PINNED_GROUP]: 5,
      Intake: 2,
      Requirements: 1,
      Design: 8,
      Development: 6,
      "Review and QA": 9,
      Ship: 1,
      "Platform runtimes": 3,
      "Other rosters": 11,
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(46);
  });

  it("pins every harness and the intake Lambda, and no runtime", () => {
    for (const d of DEPLOYABLES) {
      expect(groupFor(d) === PINNED_GROUP, d.agentId).toBe(d.type !== "runtime");
    }
  });

  // agents.json carries phase "management" for the Workflow Manager, which is in
  // no group -> it must reach Pinned by being a harness, not via PHASE_GROUPS.
  it("groups the workflow manager even though its phase maps nowhere", () => {
    const wm = DEPLOYABLES.find((d) => d.agentId === "agentcore_hub_workflow_manager");
    expect(wm?.phase).toBe("management");
    expect(groupFor(wm!)).toBe(PINNED_GROUP);
  });

  it("falls back to Other rosters for an unknown phase rather than dropping the row", () => {
    expect(groupFor({ agentId: "x", displayName: "X", type: "runtime", phase: "brand-new-phase" })).toBe("Other rosters");
  });
});

// ─── Guards ─────────────────────────────────────────────────────────────────

describe("isValidModelId", () => {
  it("accepts the real ids the catalog holds", () => {
    for (const id of [FABLE, MANTLE, "us.anthropic.claude-haiku-4-5-20251001-v1:0", ASTRA]) {
      expect(isValidModelId(id), id).toBe(true);
    }
  });

  // The unpriced strip reads ids out of span attributes, i.e. fleet-written data,
  // and turns them into a one-click catalog write (TEAM-4994 finding 9).
  it("rejects ids that could not be a model", () => {
    for (const id of ["", "-leading-dash", "has space", "a", "slash/path", "semi;colon", "quote\"d", `${"x".repeat(129)}`]) {
      expect(isValidModelId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe("pathToControlTestId", () => {
  it("maps each path family to its control", () => {
    expect(pathToControlTestId("defaults.codingCodex")).toBe("defaults-select-codingCodex");
    expect(pathToControlTestId("tiers.codex.luna")).toBe("tier-select-codex-luna");
    expect(pathToControlTestId("agents.agentcore_hub_ci_agent")).toBe("agent-select-agentcore_hub_ci_agent");
    expect(pathToControlTestId("quarantine")).toBe("catalog-section");
    expect(pathToControlTestId("autoAdopt.haiku")).toBe("autoadopt-haiku");
  });

  // Model ids contain dots, so the id is everything between the first and last segment.
  it("keeps a dotted model id intact in a catalog path", () => {
    expect(pathToControlTestId(`catalog.${FABLE}.price`)).toBe(`catalog-row-${FABLE}`);
    expect(pathToControlTestId("catalog.openai.gpt-5.5.status")).toBe("catalog-row-openai.gpt-5.5");
  });

  it("answers null for a path it does not own", () => {
    expect(pathToControlTestId("legacyAliases.old")).toBeNull();
    expect(pathToControlTestId("")).toBeNull();
  });
});
