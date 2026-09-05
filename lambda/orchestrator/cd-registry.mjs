/**
 * CD registry — WHICH repos the hub is allowed to merge + deploy.
 *
 * The registry is a small JSON document (config/cd-registry.json in the
 * artifact bucket, seeded from src/config/cd-registry.json, edited through the
 * app's /api/workflow/cd-registry or scripts/cd-registry.sh). Each entry names a
 * GitHub `owner/repo` and, optionally, the CodePipeline that deploys it.
 *
 * Delivery modes it selects (per workflow, by the run's first repo URL):
 *
 *   NOT registered → HANDOFF. The hub never merges or deploys this repo. The
 *                    run's ship phase (release manager Ship + CD tickets and the
 *                    human Merge Approval gate) is removed from the effective
 *                    workflow def; the run completes once review/QA/CI are done
 *                    and the orchestrator opens the unified PR against the
 *                    default branch and LEAVES IT OPEN for the owning team.
 *   registered     → CD. Full ship phase: release manager reviews the final PR,
 *                    a human approves the merge, the RM merges + deploys —
 *                    through the named pipeline (Pipeline___* tools) when the
 *                    entry has one and PIPELINE_ENABLED is set, else via the
 *                    repo's DEPLOY.md (legacy mode).
 *
 * Pure helpers only — no I/O — so index.mjs owns the S3 read and this file is
 * unit-testable in isolation (same split as pipeline-enabled.mjs).
 */

export const CD_REGISTRY_KEY = "config/cd-registry.json";

export const EMPTY_CD_REGISTRY = Object.freeze({ version: 1, repos: [] });

/**
 * Canonical `owner/repo` (lower-case) for any of:
 *   https://github.com/owner/repo(.git) | git@github.com:owner/repo(.git) | owner/repo
 * Returns null when the value is not a two-segment repo reference.
 */
export function normalizeRepoKey(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  s = s.replace(/^git@[^:]+:/, "").replace(/^[a-z]+:\/\/[^/]+\//i, "");
  s = s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/**
 * Parse the registry document (string or object). Tolerant: a malformed
 * document or entry is dropped rather than thrown — the registry must never be
 * able to take the orchestrator down; an unparseable registry simply means "no
 * repo is CD-registered", the fail-safe direction (nothing gets merged).
 */
export function parseCdRegistry(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    try { doc = JSON.parse(raw); } catch { return { ...EMPTY_CD_REGISTRY }; }
  }
  if (!doc || typeof doc !== "object") return { ...EMPTY_CD_REGISTRY };
  const list = Array.isArray(doc.repos) ? doc.repos : [];
  const seen = new Set();
  const repos = [];
  for (const e of list) {
    const ref = typeof e === "string" ? e : e?.repo;
    const key = normalizeRepoKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = { repo: key };
    if (e && typeof e === "object") {
      const pipeline = typeof e.pipeline === "string" ? e.pipeline.trim() : "";
      if (pipeline) entry.pipeline = pipeline;
      const region = typeof e.region === "string" ? e.region.trim() : "";
      if (region) entry.region = region;
      const deployDoc = typeof e.deployDoc === "string" ? e.deployDoc.trim() : "";
      if (deployDoc) entry.deployDoc = deployDoc;
      const notes = typeof e.notes === "string" ? e.notes.trim() : "";
      if (notes) entry.notes = notes;
      if (typeof e.addedAt === "string") entry.addedAt = e.addedAt;
    }
    repos.push(entry);
  }
  return { version: Number(doc.version) || 1, repos };
}

/** The registry entry for a workflow's repo ({ repos: [{ url }] }), or null. */
export function findCdEntry(registry, repoConfig) {
  const key = normalizeRepoKey(repoConfig?.repos?.[0]?.url);
  if (!key) return null;
  return (registry?.repos || []).find((e) => e.repo === key) || null;
}

export function isCdRegistered(registry, repoConfig) {
  return findCdEntry(registry, repoConfig) !== null;
}

/**
 * Derive the workflow def a HANDOFF run actually follows: the ship completion
 * phases and every review gate guarding a ship phase are removed. Everything
 * else (phase order, intake agent, feature-branch/PR flags) is untouched, so
 * the run still creates its branch and gets its PR at completion.
 *
 * Returns the def itself when nothing needs stripping (registered repo, or a
 * def with no ship phase) — call sites can rely on identity in that case.
 */
export function stripShipPhases(def, shipPhases) {
  if (!def) return def;
  const ship = shipPhases instanceof Set ? shipPhases : new Set(shipPhases || ["ship"]);
  const required = Array.isArray(def.completionRequiresAgentPhases) ? def.completionRequiresAgentPhases : [];
  const gates = Array.isArray(def.reviewGates) ? def.reviewGates : [];
  const hasShipPhase = required.some((p) => ship.has(p));
  const hasShipGate = gates.some((g) => ship.has(g?.afterPhase));
  if (!hasShipPhase && !hasShipGate) return def;
  return {
    ...def,
    completionRequiresAgentPhases: required.filter((p) => !ship.has(p)),
    reviewGates: gates.filter((g) => !ship.has(g?.afterPhase)),
    cdHandoff: true,
  };
}

/**
 * The def a run follows given the registry: registered → the def as written;
 * not registered → the def with its ship phase stripped (HANDOFF).
 */
export function effectiveWorkflowDef(def, registry, repoConfig, shipPhases) {
  if (isCdRegistered(registry, repoConfig)) return def;
  return stripShipPhases(def, shipPhases);
}

/**
 * Delivery decision for a run, in one place so the agent context, the dispatch
 * guard and the completion path can never disagree:
 *   { mode: "cd" | "handoff", entry, pipelineMode, pipeline, region }
 * pipelineMode is true only when the repo is registered WITH a pipeline name and
 * the PIPELINE_ENABLED flag is on (the Pipeline___* tools Lambda is deployed).
 */
export function resolveDelivery(registry, repoConfig, { pipelineEnabled = false } = {}) {
  const entry = findCdEntry(registry, repoConfig);
  if (!entry) return { mode: "handoff", entry: null, pipelineMode: false, pipeline: null, region: null };
  const pipeline = entry.pipeline || null;
  return {
    mode: "cd",
    entry,
    pipelineMode: Boolean(pipelineEnabled && pipeline),
    pipeline,
    region: entry.region || null,
  };
}

/**
 * The `## Delivery Mode` block every persona sees. `repo` is "owner/repo" (or
 * null when the run has no repo), `defaultBranch` the base branch.
 */
export function deliveryModeContext(delivery, { repo = null, defaultBranch = "main" } = {}) {
  let out = `## Delivery Mode\n`;
  if (delivery.mode === "cd") {
    out += `CD_REGISTERED: true\n`;
    out += `The hub owns merge + deploy for ${repo || "this repo"} (it is in the hub's CD registry). `;
    out += `The ship phase runs: the release manager reviews the final PR, a human approves the merge `;
    out += `(Merge Approval gate), then the release manager merges into ${defaultBranch} and deploys`;
    if (delivery.pipeline) {
      out += ` through the ${delivery.pipeline} pipeline`;
      if (delivery.region) out += ` (${delivery.region})`;
      out += `.\n`;
      out += `pipeline_name: ${delivery.pipeline}\n`;
      if (delivery.region) out += `pipeline_region: ${delivery.region}\n`;
    } else {
      out += ` per the repo's ${delivery.entry?.deployDoc || "DEPLOY.md"}.\n`;
    }
    if (delivery.entry?.notes) out += `notes: ${delivery.entry.notes}\n`;
  } else {
    out += `CD_REGISTERED: false\n`;
    out += `${repo || "This repo"} is NOT in the hub's CD registry, so the hub does NOT merge or deploy it. `;
    out += `This run ENDS when code review, QA verification and CI are done: the orchestrator opens the `;
    out += `unified PR from the feature branch against ${defaultBranch} and leaves it OPEN for the owning `;
    out += `team to merge and deploy.\n`;
    out += `- Intake/requirements: do NOT create Ship, Merge Approval or CD tickets — stop the ticket chain at CI.\n`;
    out += `- Every agent: never merge into ${defaultBranch}, never run a deploy, never call Pipeline___* tools.\n`;
    out += `- Review/QA/CI: your evidence is what the owning team will read on the PR — make it complete.\n`;
  }
  return out + `\n`;
}
