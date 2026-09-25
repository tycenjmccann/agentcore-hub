/**
 * Pure draft logic for the Models page: what changed, how to carry those changes
 * onto a newer server document, and which catalog rows a given select may offer.
 *
 * All of it is deliberately free of React and fetch so the rules that decide
 * whether a save is even legal are unit-testable (diff.test.ts) instead of being
 * discovered in a browser.
 *
 * Two invariants the rest of the page leans on:
 *
 *  - `probe.*` and every server-owned meta field are OUTSIDE the diff. The page
 *    polls the registry while probes and harness applies run, and each poll
 *    replaces `serverDoc`; if probe results counted as changes, the page would
 *    go dirty on its own and the save bar would appear without the user
 *    touching anything.
 *  - the dotted `path` vocabulary here is the SAME one the 422 response uses, so
 *    a field the server rejects is mapped back to its control by
 *    pathToControlTestId() with no second translation table.
 */

import { probeModeLabel, ratePair } from "./format";
import {
  CLAUDE_TIERS,
  CODEX_TIERS,
  DEFAULTS_FIELDS,
  DEPLOYABLES,
  type CatalogRow,
  type Change,
  type ClaudeTier,
  type CodexTier,
  type RegistryDoc,
  type RegistryDraft,
  type SelectField,
} from "./types";

const INHERIT = "inherit";
const NONE = "none";

const DEFAULTS_LABELS: Record<string, string> = {
  persona: "Persona default",
  codingClaude: "Coding default (Claude)",
  codingCodex: "Coding default (Codex)",
};

const DISPLAY_NAMES = new Map(DEPLOYABLES.map((d) => [d.agentId, d.displayName]));

/** Strip the three fields the server owns; what remains is the POST's `registry`. */
export function stripMeta(doc: RegistryDoc): RegistryDraft {
  const { version: _version, updatedAt: _updatedAt, updatedBy: _updatedBy, ...rest } = doc;
  return rest;
}

function catalogById(doc: RegistryDoc): Map<string, CatalogRow> {
  return new Map(doc.catalog.map((r) => [r.modelId, r]));
}

function priceText(row: CatalogRow | undefined): string {
  if (!row?.price) return "no price";
  return `${ratePair(row.price)} (${row.price.source})`;
}

/**
 * Every staged edit between the loaded document and the working draft, in the
 * order the page renders the sections.
 *
 * One collapse rule: "Reset all to inherit" drops every per-agent override at
 * once, which would otherwise flood the save bar with 20+ near-identical lines.
 * When the draft has no overrides left and the server had more than one, the
 * whole map becomes a single `agents` change. rebaseChanges() understands that
 * path, so the collapse survives a rebase.
 */
export function diffRegistry(server: RegistryDoc, draft: RegistryDoc): Change[] {
  const changes: Change[] = [];

  // defaults.*
  for (const field of DEFAULTS_FIELDS) {
    const from = server.defaults?.[field] ?? "";
    const to = draft.defaults?.[field] ?? "";
    if (from !== to) {
      changes.push({
        path: `defaults.${field}`,
        label: DEFAULTS_LABELS[field] ?? field,
        from: from || INHERIT,
        to: to || INHERIT,
      });
    }
  }

  // tiers.claude.* then tiers.codex.*
  for (const tier of CLAUDE_TIERS) {
    const from = server.tiers?.claude?.[tier] ?? "";
    const to = draft.tiers?.claude?.[tier] ?? "";
    if (from !== to) {
      changes.push({
        path: `tiers.claude.${tier}`,
        label: `Claude ${tier} tier`,
        from: from || INHERIT,
        to: to || INHERIT,
      });
    }
  }
  for (const tier of CODEX_TIERS) {
    const from = server.tiers?.codex?.[tier] ?? "";
    const to = draft.tiers?.codex?.[tier] ?? "";
    if (from !== to) {
      changes.push({
        path: `tiers.codex.${tier}`,
        label: `Codex ${tier} tier`,
        from: from || INHERIT,
        to: to || INHERIT,
      });
    }
  }

  // agents.<id>
  const serverAgents = server.agents ?? {};
  const draftAgents = draft.agents ?? {};
  const agentIds = [...new Set([...Object.keys(serverAgents), ...Object.keys(draftAgents)])].sort();
  const agentChanges: Change[] = [];
  for (const id of agentIds) {
    const from = serverAgents[id] ?? "";
    const to = draftAgents[id] ?? "";
    if (from !== to) {
      agentChanges.push({
        path: `agents.${id}`,
        label: DISPLAY_NAMES.get(id) ?? id,
        from: from || INHERIT,
        to: to || INHERIT,
      });
    }
  }
  const serverOverrides = Object.keys(serverAgents).length;
  const clearedAll = Object.keys(draftAgents).length === 0 && serverOverrides > 1;
  if (clearedAll && agentChanges.length > 1) {
    changes.push({
      path: "agents",
      label: "Agent overrides",
      from: `${serverOverrides} override${serverOverrides === 1 ? "" : "s"}`,
      to: INHERIT,
    });
  } else {
    changes.push(...agentChanges);
  }

  // catalog.<id>.price / .status, plus whole rows added by "Add to catalog"
  const serverCatalog = catalogById(server);
  const draftCatalog = catalogById(draft);
  for (const [modelId, draftRow] of draftCatalog) {
    const serverRow = serverCatalog.get(modelId);
    if (!serverRow) {
      changes.push({
        path: `catalog.${modelId}`,
        label: `${draftRow.label || modelId} (new row)`,
        from: "not in catalog",
        to: draftRow.status,
      });
      continue;
    }
    if (JSON.stringify(serverRow.price ?? null) !== JSON.stringify(draftRow.price ?? null)) {
      changes.push({
        path: `catalog.${modelId}.price`,
        label: `${draftRow.label || modelId} price`,
        from: priceText(serverRow),
        to: priceText(draftRow),
      });
    }
    if (serverRow.status !== draftRow.status) {
      changes.push({
        path: `catalog.${modelId}.status`,
        label: `${draftRow.label || modelId} status`,
        from: serverRow.status,
        to: draftRow.status,
      });
    }
  }

  // autoAdopt.<tier>
  const serverAdopt = server.autoAdopt ?? {};
  const draftAdopt = draft.autoAdopt ?? {};
  for (const tier of [...new Set([...Object.keys(serverAdopt), ...Object.keys(draftAdopt)])].sort()) {
    const from = serverAdopt[tier] === true;
    const to = draftAdopt[tier] === true;
    if (from !== to) {
      changes.push({
        path: `autoAdopt.${tier}`,
        label: `Auto-adopt ${tier}`,
        from: from ? "on" : "off",
        to: to ? "on" : "off",
      });
    }
  }

  // quarantine — one change for the whole list, because that is how it reads
  const serverQ = [...(server.quarantine ?? [])].sort();
  const draftQ = [...(draft.quarantine ?? [])].sort();
  if (serverQ.join("\u0000") !== draftQ.join("\u0000")) {
    changes.push({
      path: "quarantine",
      label: "Quarantine",
      from: serverQ.length ? serverQ.join(", ") : NONE,
      to: draftQ.length ? draftQ.join(", ") : NONE,
    });
  }

  return changes;
}

/**
 * Carry the staged changes onto a newer server document.
 *
 * The page polls while applies and probes run, so `serverDoc` can move under an
 * editor mid-edit. Rather than throw the draft away (or silently keep editing a
 * stale base and then lose the race at save time), each change re-applies its
 * own draft value on top of the fresh document. Everything not named by a change
 * — including probe results and freshly discovered catalog rows — comes from the
 * new document, which is exactly what makes the poll invisible to the user.
 *
 * A path the new document no longer has a home for (a catalog row retired
 * server-side while it was being repriced) is dropped rather than resurrected;
 * diffRegistry() on the result is the source of truth for what is still staged,
 * so a dropped change simply disappears from the save bar.
 */
export function rebaseChanges(changes: Change[], newServer: RegistryDoc, oldDraft: RegistryDoc): RegistryDoc {
  const next: RegistryDoc = {
    ...newServer,
    defaults: { ...newServer.defaults },
    tiers: { claude: { ...newServer.tiers?.claude }, codex: { ...newServer.tiers?.codex } } as RegistryDoc["tiers"],
    agents: { ...newServer.agents },
    autoAdopt: newServer.autoAdopt ? { ...newServer.autoAdopt } : undefined,
    quarantine: [...(newServer.quarantine ?? [])],
    legacyAliases: { ...newServer.legacyAliases },
    catalog: newServer.catalog.map((r) => ({ ...r })),
  };

  for (const change of changes) {
    const parts = change.path.split(".");

    if (parts[0] === "defaults" && parts[1]) {
      const field = parts[1] as keyof RegistryDoc["defaults"];
      next.defaults[field] = oldDraft.defaults[field];
      continue;
    }

    if (parts[0] === "tiers" && parts[1] && parts[2]) {
      if (parts[1] === "claude") {
        const tier = parts[2] as ClaudeTier;
        next.tiers.claude[tier] = oldDraft.tiers.claude[tier];
      } else if (parts[1] === "codex") {
        const tier = parts[2] as CodexTier;
        next.tiers.codex[tier] = oldDraft.tiers.codex[tier];
      }
      continue;
    }

    // The collapsed "reset all" form replaces the whole map.
    if (change.path === "agents") {
      next.agents = { ...oldDraft.agents };
      continue;
    }
    if (parts[0] === "agents" && parts[1]) {
      const id = parts.slice(1).join(".");
      const value = oldDraft.agents?.[id];
      if (value == null) delete next.agents[id];
      else next.agents[id] = value;
      continue;
    }

    if (parts[0] === "autoAdopt" && parts[1]) {
      const tier = parts.slice(1).join(".");
      next.autoAdopt = { ...(next.autoAdopt ?? {}) };
      const value = oldDraft.autoAdopt?.[tier];
      if (value == null) delete next.autoAdopt[tier];
      else next.autoAdopt[tier] = value;
      continue;
    }

    if (change.path === "quarantine") {
      next.quarantine = [...(oldDraft.quarantine ?? [])];
      continue;
    }

    if (parts[0] === "catalog" && parts.length >= 2) {
      const tail = parts[parts.length - 1];
      const isField = tail === "price" || tail === "status";
      const modelId = isField ? parts.slice(1, -1).join(".") : parts.slice(1).join(".");
      const draftRow = oldDraft.catalog.find((r) => r.modelId === modelId);
      if (!draftRow) continue;
      const index = next.catalog.findIndex((r) => r.modelId === modelId);
      if (index === -1) {
        // A row this draft added itself is re-added; one the server retired is not.
        if (!isField) next.catalog = [...next.catalog, { ...draftRow }];
        continue;
      }
      if (tail === "price") next.catalog[index] = { ...next.catalog[index], price: draftRow.price };
      else if (tail === "status") next.catalog[index] = { ...next.catalog[index], status: draftRow.status };
      continue;
    }
  }

  return next;
}

/**
 * The ONE predicate behind every model select on the page.
 *
 * A model is offerable only when pointing an agent at it cannot break cost math
 * or a run: it has to be adopted (`active`), priced on both sides (an unpriced
 * model makes every downstream dollar figure a lie), not a read-only judge
 * (priced for accounting, never for running), and not quarantined. Only then
 * does the per-field vendor/endpoint rule apply.
 *
 * The server re-checks all of this and answers 422, so this predicate is the
 * courtesy of not offering a choice that would bounce — never the enforcement.
 */
export function isSelectable(row: CatalogRow, field: SelectField, quarantine: string[] = []): boolean {
  if (row.status !== "active") return false;
  if (row.readOnly) return false;
  if (row.price?.input == null || row.price?.output == null) return false;
  if (quarantine.includes(row.modelId)) return false;

  switch (field) {
    // Codex runs OpenAI models, and its endpoint comes from the catalog row —
    // so a Mantle-only model is valid here and in the Codex tiers, nowhere else.
    case "codingCodex":
    case "codexTier":
      return row.vendor === "openai";
    default:
      return row.vendor === "anthropic" && row.endpoint === "bedrock-runtime";
  }
}

/** The rows a given select may offer, in catalog order. */
export function selectableRows(catalog: CatalogRow[], field: SelectField, quarantine: string[] = []): CatalogRow[] {
  return catalog.filter((r) => isSelectable(r, field, quarantine));
}

/**
 * Both smoke tests green is the bar for adopting a candidate. Returned as a
 * reason string (not a boolean) because the button stays visible and explains
 * itself rather than disappearing.
 */
export function adoptBlockedReason(row: CatalogRow): string | null {
  const api = row.probe?.api;
  const cli = row.probe?.cli;
  if (api?.ok && cli?.ok) return null;
  const describe = (p: { ok: boolean } | undefined) => (!p ? "never run" : p.ok ? "passed" : "failed");
  return `Adopt needs both smoke tests green. ${probeModeLabel("api")}: ${describe(api)}, ${probeModeLabel("cli")}: ${describe(cli)}.`;
}

/** Every tier and agent pointing at a model — what a quarantine would strand. */
export function dependentsOf(doc: RegistryDoc, modelId: string): { tiers: string[]; agents: string[] } {
  const tiers: string[] = [];
  for (const tier of CLAUDE_TIERS) if (doc.tiers?.claude?.[tier] === modelId) tiers.push(`claude.${tier}`);
  for (const tier of CODEX_TIERS) if (doc.tiers?.codex?.[tier] === modelId) tiers.push(`codex.${tier}`);
  for (const field of DEFAULTS_FIELDS) if (doc.defaults?.[field] === modelId) tiers.push(`defaults.${field}`);
  const agents = Object.entries(doc.agents ?? {})
    .filter(([, v]) => v === modelId)
    .map(([k]) => k);
  return { tiers, agents };
}
