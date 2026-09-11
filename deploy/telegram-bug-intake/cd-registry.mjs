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
  s = s.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/, "");
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
      // Optional (TEAM-4122 FR-5): this repo's CodeBuild PR-check PROJECT — a
      // different thing from `pipeline` above, which names a CodePipeline. Read
      // by pipelineProjects() below (an explicit value here wins over the
      // hub-<slug>-ci convention); absent → derived from `pipeline`, then
      // CI_PROJECT_NAME, then agentcore-hub-ci.
      const ciProject = typeof e.ciProject === "string" ? e.ciProject.trim() : "";
      if (ciProject) entry.ciProject = ciProject;
      // Cross-account CD (optional). The pipeline lives in ANOTHER AWS account;
      // the tools Lambda reaches it by assuming `roleArn` there. Honored ONLY as
      // a complete, valid triple: `account` = 12 digits, `roleArn` =
      // arn:aws:iam::<account>:role/hub-cd-trigger-<slug> (the RESERVED
      // trigger-role name — a roleArn naming any other role, or a different
      // account than `account`, is a misconfiguration and DROPPED, never
      // assumed), and a non-empty `externalId` (the confused-deputy guard the
      // trust role's policy requires). Any part missing or malformed → all three
      // dropped, and the entry falls back to same-account behavior (which safely
      // refuses a foreign pipeline it cannot see). This is the ONLY place a role
      // the hub will assume is admitted.
      const account = typeof e.account === "string" ? e.account.trim() : "";
      const roleArn = typeof e.roleArn === "string" ? e.roleArn.trim() : "";
      const externalId = typeof e.externalId === "string" ? e.externalId.trim() : "";
      if (
        account && roleArn && externalId &&
        /^[0-9]{12}$/.test(account) &&
        new RegExp(`^arn:aws:iam::${account}:role/hub-cd-trigger-[a-z0-9-]+$`).test(roleArn)
      ) {
        entry.account = account;
        entry.roleArn = roleArn;
        entry.externalId = externalId;
      }
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
 * The CodePipeline + the three CodeBuild projects a registry entry implies, by
 * the hub-<slug>-{ci,build,deploy} naming convention. `pipeline` is the
 * CodePipeline name and ends in "-deploy" by convention; base = that suffix
 * removed. An explicit entry.ciProject WINS over the derived name (a repo may
 * keep a differently named PR-check project). Returns null for an entry with
 * no pipeline — a DEPLOY.md-mode CD repo has no CodeBuild projects to name.
 *
 * Hub: agentcore-hub-deploy -> ci/build/deploy = agentcore-hub-{ci,build,deploy}.
 */
export function pipelineProjects(entry) {
  const pipeline = typeof entry?.pipeline === "string" ? entry.pipeline.trim() : "";
  if (!pipeline) return null;
  const base = pipeline.endsWith("-deploy") ? pipeline.slice(0, -"-deploy".length) : pipeline;
  return {
    pipeline,
    region: entry.region || null,
    // Cross-account: null on a same-account entry (the common case), so
    // clientsFor() builds plain clients. parseCdRegistry only ever sets these as
    // a validated triple.
    roleArn: entry.roleArn || null,
    externalId: entry.externalId || null,
    ciProject: entry.ciProject || `${base}-ci`,
    buildProject: `${base}-build`,
    deployProject: pipeline,
  };
}

/**
 * Delivery decision for a run, in one place so the agent context, the dispatch
 * guard and the completion path can never disagree:
 *   { mode: "cd" | "handoff", entry, pipelineMode, pipeline, region,
 *     ciProject, buildProject, deployProject }
 * pipelineMode is true only when the repo is registered WITH a pipeline name and
 * the PIPELINE_ENABLED flag is on (the Pipeline___* tools Lambda is deployed).
 * ciProject/buildProject/deployProject are null whenever pipeline is null (a
 * DEPLOY.md-mode CD repo, or a handoff repo) — pipelineProjects() derives them.
 */
export function resolveDelivery(registry, repoConfig, { pipelineEnabled = false } = {}) {
  const entry = findCdEntry(registry, repoConfig);
  if (!entry) {
    return {
      mode: "handoff", entry: null, pipelineMode: false, pipeline: null, region: null,
      ciProject: null, buildProject: null, deployProject: null,
    };
  }
  const projects = pipelineProjects(entry);
  const pipeline = entry.pipeline || null;
  return {
    mode: "cd",
    entry,
    pipelineMode: Boolean(pipelineEnabled && pipeline),
    pipeline,
    region: entry.region || null,
    roleArn: entry.roleArn || null,
    externalId: entry.externalId || null,
    ciProject: projects?.ciProject || null,
    buildProject: projects?.buildProject || null,
    deployProject: projects?.deployProject || null,
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
