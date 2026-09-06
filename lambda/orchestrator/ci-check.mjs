/**
 * CI reachability pre-flight (TEAM-4122 FR-5) — orchestrator twin of
 * repo-check.mjs, for the question "can a CodeBuild build for this head SHA
 * exist AT ALL?"
 *
 * The gap this closes: the CI agent's PIPELINE-mode contract is "read the
 * authoritative CodeBuild PR-check for the head SHA". When neither the PR
 * webhook is installed NOR the pipeline-tools Lambda can StartBuild, no build
 * can ever appear for any head — so the honest CI verdict is permanently
 * BLOCKED, and the run reaches the human merge gate with a green-looking board
 * whose CI evidence is `ci_status: unverified` at best. That is discoverable
 * only by reading the CI agent's completion record, which the approver does not
 * do. This module probes the two capabilities ONCE per workflow (cached with a
 * TTL), states the answer in every persona's context as `## CI Certification`,
 * and in enforce mode labels the epic + prefixes the merge-gate package so the
 * approver is told before they click.
 *
 * Fail-safe direction: off by default, and `unknown` (a probe that could not
 * answer) never becomes `uncertifiable`. A missing IAM permission on the probe
 * itself must not manufacture a warning about the pipeline.
 *
 * Pure + DI: every AWS/GitHub call arrives through `deps`, so the whole module
 * is unit-testable with plain objects and constructs no clients of its own
 * (same split as repo-check.mjs / pipeline-enabled.mjs).
 *
 * SECURITY (F10): a CodeBuild project description contains `webhook.url`,
 * `webhook.secret` and the project's environment variables. This module
 * destructures the probe result to BOOLEANS at the boundary and never lets the
 * raw project object reach a return value, a log line, or the persisted
 * ciCheck record. See probeWebhook.
 */

const MODES = new Set(["off", "shadow", "enforce"]);

/**
 * off | shadow | enforce. STRICT allow-list: unset, "", and anything
 * unrecognized → "off".
 *
 * Same fail-safe direction as LIVE_REVERIFY (not REWORK_LOOP_CAP): enforce here
 * WRITES A LABEL on the epic and rewrites the human merge gate's ping, so a
 * typo'd mode must never do that on its own.
 */
export function normalizeCiCheckMode(v) {
  if (v === undefined || v === null) return "off";
  const s = String(v).trim().toLowerCase();
  if (MODES.has(s)) return s;
  return "off";
}

/** A settled verdict is stable for a work day — the webhook/IAM state behind it
 * only changes on a deploy. */
export const CI_CHECK_TTL_MS_DEFAULT = 6 * 60 * 60 * 1000;
/** `unknown` is re-probed far sooner: it usually means a transient API error or
 * a not-yet-created project, both of which resolve on their own. */
export const CI_CHECK_UNKNOWN_TTL_MS_DEFAULT = 30 * 60 * 1000;

/** The PR events a CodeBuild webhook filter must carry for a PR check to fire. */
const PR_EVENT_PATTERNS = [
  "PULL_REQUEST_CREATED",
  "PULL_REQUEST_UPDATED",
  "PULL_REQUEST_REOPENED",
];

const DEFAULT_CI_PROJECT = "agentcore-hub-ci";

/**
 * Which CodeBuild project is this repo's PR check?
 *
 * `entry.pipeline` is DELIBERATELY not a fallback: it names a CodePipeline, not
 * a CodeBuild project. Using it would make BatchGetProjects miss (→ a bogus
 * `project_not_found` → an `unknown` verdict on every run) and would point the
 * scoped IAM grant at the wrong resource name.
 */
export function resolveCiProjectName({ delivery, env = {} } = {}) {
  const fromEntry = typeof delivery?.entry?.ciProject === "string" ? delivery.entry.ciProject.trim() : "";
  if (fromEntry) return fromEntry;
  const fromEnv = typeof env.CI_PROJECT_NAME === "string" ? env.CI_PROJECT_NAME.trim() : "";
  if (fromEnv) return fromEnv;
  return DEFAULT_CI_PROJECT;
}

/**
 * Probe 1 — does the CI project have a PR-triggering webhook?
 *
 * F10: `out.projects[0]` carries webhook.url, webhook.secret and the project's
 * environment variables. Everything this function returns is derived to a
 * boolean/string HERE; the project object never leaves this scope, is never
 * logged, and is never persisted. Do not "improve" this by returning the
 * project, spreading it into the result, or logging it on the error path.
 */
async function probeWebhook(projectName, deps) {
  try {
    const out = await deps.codebuildSend({ names: [projectName] });
    const project = (out?.projects || [])[0];
    if (!project) return { webhook: "unknown", reason: "project_not_found" };
    // ── boundary: booleans only from here down ──
    const hasUrl = Boolean(project.webhook?.url);
    const filterGroups = Array.isArray(project.webhook?.filterGroups) ? project.webhook.filterGroups : [];
    const hasPrEvent = filterGroups.some((group) =>
      Array.isArray(group) &&
      group.some(
        (f) =>
          f?.type === "EVENT" &&
          typeof f.pattern === "string" &&
          PR_EVENT_PATTERNS.some((p) => f.pattern.includes(p))
      )
    );
    return { webhook: hasUrl && hasPrEvent, reason: null };
  } catch (err) {
    // Only the error NAME — an SDK error message can echo request parameters.
    return { webhook: "unknown", reason: err?.name || "codebuild_error" };
  }
}

/**
 * Probe 2 — can the pipeline-tools Lambda start a CI build?
 *
 * Asks the Lambda itself (Pipeline___capabilities), because that is the thing
 * whose IAM role decides. The invoke shape matches what that handler actually
 * reads: `event.tool_name` (it also accepts `_tool_name`/`name`, and strips the
 * `Tool___` prefix) + `event.parameters`, and its reply is the standard
 * `{content:[{type:"text",text:<json>}]}` envelope.
 *
 * An older pipeline-tools deployment has no `capabilities` tool and answers
 * `{error:"Unknown tool: ..."}` → "unknown", never false: "this Lambda is out
 * of date" is not "this Lambda cannot start builds".
 */
async function probeStartBuild(projectName, env, deps) {
  const fn = env.PIPELINE_TOOLS_LAMBDA || "agentcore-hub-pipeline-tools";
  let capability = "unknown";
  let reason = null;
  try {
    const parsed = await deps.invokeLambda(fn, {
      tool_name: "Pipeline___capabilities",
      parameters: {},
    });
    if (parsed?.error) {
      reason = "capabilities_unavailable";
    } else {
      const text = parsed?.content?.[0]?.text;
      const body = typeof text === "string" ? JSON.parse(text) : parsed;
      if (typeof body?.startCiBuild === "boolean") capability = body.startCiBuild;
      else reason = "capabilities_malformed";
    }
  } catch (err) {
    reason = err?.name || "invoke_error";
  }

  // IAM simulate is the stronger signal when it is available: it reads the
  // pipeline-tools ROLE's real policy instead of trusting a flag that Lambda's
  // own env var (PIPELINE_CI_START_BUILD) reports. Opt-in, because it needs an
  // extra grant (iam:SimulatePrincipalPolicy) on the orchestrator.
  if (env.CI_CHECK_USE_IAM_SIMULATE === "1" && env.PIPELINE_TOOLS_ROLE_ARN && deps.iamSimulate) {
    const simulated = await simulateStartBuild(projectName, env, deps);
    if (simulated !== "unknown") return { startBuild: simulated, reason: null };
  }
  return { startBuild: capability, reason: capability === "unknown" ? reason : null };
}

/** SimulatePrincipalPolicy for codebuild:StartBuild on the CI project, or
 * "unknown" when it cannot be evaluated (no account id, throw, odd shape). */
async function simulateStartBuild(projectName, env, deps) {
  const accountId = typeof env.AWS_ACCOUNT_ID === "string" ? env.AWS_ACCOUNT_ID.trim() : "";
  if (!accountId) return "unknown"; // no account id → cannot build the ARN
  const region = env.AWS_REGION || "us-east-1";
  const projectArn = `arn:aws:codebuild:${region}:${accountId}:project/${projectName}`;
  try {
    const out = await deps.iamSimulate({
      PolicySourceArn: env.PIPELINE_TOOLS_ROLE_ARN,
      ActionNames: ["codebuild:StartBuild"],
      ResourceArns: [projectArn],
    });
    const decision = out?.EvaluationResults?.[0]?.EvalDecision;
    if (decision === "allowed") return true;
    // explicitDeny / implicitDeny are both a real "no".
    if (typeof decision === "string" && decision) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Probe 3 (optional, best-effort) — corroborate the webhook from GitHub's side.
 *
 * Only ever ADDS information: the verdict below is computed from webhook +
 * startBuild. A 403 (token without admin:repo_hook) or 404 is the normal case
 * on a repo the hub does not own, so any throw is "unknown", never a warning.
 */
async function probeGithubHook(owner, repo, deps) {
  if (!deps?.githubApi || !owner || !repo) return "unknown";
  try {
    const hooks = await deps.githubApi(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`
    );
    if (!Array.isArray(hooks)) return "unknown";
    return hooks.some(
      (h) =>
        typeof h?.config?.url === "string" &&
        h.config.url.toLowerCase().includes("codebuild") &&
        Array.isArray(h.events) &&
        h.events.includes("pull_request")
    );
  } catch {
    return "unknown";
  }
}

/**
 * Run all three probes and reduce them to a verdict.
 *
 * certifiable  — at least one route to a build for a head SHA exists.
 * uncertifiable — BOTH routes are provably absent. The only verdict that acts.
 * unknown      — a probe could not answer; treated as "do not warn".
 */
export async function probeCiCheck({ projectName, env = {}, deps = {}, repo = null } = {}) {
  const now = typeof deps.now === "function" ? deps.now() : new Date();
  const { webhook, reason: webhookReason } = await probeWebhook(projectName, deps);
  const { startBuild, reason: startBuildReason } = await probeStartBuild(projectName, env, deps);
  const githubHook = await probeGithubHook(repo?.owner, repo?.repo, deps);

  const certifiable = webhook === true || startBuild === true;
  let verdict;
  if (certifiable) verdict = "certifiable";
  else if (webhook === false && startBuild === false) verdict = "uncertifiable";
  else verdict = "unknown";

  return {
    checkedAt: now.toISOString(),
    projectName,
    webhook,
    startBuild,
    githubHook,
    certifiable,
    verdict,
    reason: buildReason({ verdict, projectName, webhook, startBuild, webhookReason, startBuildReason }),
  };
}

/** One human sentence — it is rendered verbatim into the epic comment, the
 * `## CI Certification` block and the merge-gate ping. */
function buildReason({ verdict, projectName, webhook, startBuild, webhookReason, startBuildReason }) {
  if (verdict === "uncertifiable") {
    return `CodeBuild project ${projectName} has no PR webhook and the pipeline-tools Lambda cannot start a build.`;
  }
  if (verdict === "certifiable") {
    if (webhook === true && startBuild === true) {
      return `CodeBuild project ${projectName} has a PR webhook and the pipeline-tools Lambda can start a build.`;
    }
    if (webhook === true) {
      return `CodeBuild project ${projectName} has a PR webhook, so a PR push produces a build for the head SHA.`;
    }
    return `The pipeline-tools Lambda can start a build on ${projectName} on demand (no PR webhook installed).`;
  }
  const unresolved = [
    webhook === "unknown" ? `webhook: ${webhookReason || "unknown"}` : null,
    startBuild === "unknown" ? `start_build: ${startBuildReason || "unknown"}` : null,
  ].filter(Boolean);
  return `Could not determine whether a CodeBuild build can exist for a head SHA on ${projectName}${
    unresolved.length ? ` (${unresolved.join("; ")})` : ""
  }. Treating CI as certifiable-unknown — no warning is raised on an unproven probe.`;
}

/**
 * Resolve the CI check for a workflow at dispatch time, cheaply:
 *   - stored result for the SAME project and inside its TTL → reuse (no calls)
 *   - absent / stale / different project → probe now and persist
 * Returns the ciCheck, or the previous one / null on any failure. NEVER throws:
 * a broken probe must not stop an agent from being dispatched.
 */
export async function ensureCiCheck(
  workflow,
  { store, env = process.env, deps = {}, delivery = null, mode = "off", repo = null, log } = {}
) {
  if (mode === "off") return null;
  const warn = log || ((msg) => console.warn(`[ci-check] ${msg}`));
  const stored = workflow?.ciCheck || null;
  try {
    const projectName = resolveCiProjectName({ delivery, env });
    const ttlMs = resolveTtlMs(env, stored);
    if (isFresh(stored, projectName, ttlMs, deps)) return stored;

    const probed = await probeCiCheck({ projectName, env, deps, repo });
    const ciCheck = {
      ...probed,
      mode,
      // A label already written must never be written twice, so `labeled`
      // survives every re-probe (including one that flips the verdict back).
      ...(stored?.labeled ? { labeled: true } : {}),
    };
    if (store?.setCiCheck) {
      try {
        await store.setCiCheck(workflow?.id || workflow?.workflowId, ciCheck);
      } catch (err) {
        warn(`persist failed for ${workflow?.id}: ${err.message}`);
      }
    }
    if (ciCheck.verdict === "uncertifiable") {
      warn(`${workflow?.id}: ${ciCheck.reason}`);
    }
    return ciCheck;
  } catch (err) {
    warn(`skipped for ${workflow?.id}: ${err.message}`);
    return stored;
  }
}

/** 6h for a settled verdict, 30min for `unknown`; CI_CHECK_TTL_MS overrides the
 * settled one (a positive finite number only). */
function resolveTtlMs(env, stored) {
  if (stored?.verdict === "unknown") return CI_CHECK_UNKNOWN_TTL_MS_DEFAULT;
  const raw = Number(env.CI_CHECK_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return CI_CHECK_TTL_MS_DEFAULT;
}

function isFresh(stored, projectName, ttlMs, deps) {
  if (!stored || stored.projectName !== projectName) return false;
  const at = Date.parse(stored.checkedAt || "");
  if (!Number.isFinite(at)) return false;
  const now = typeof deps?.now === "function" ? deps.now().getTime() : Date.now();
  return now - at < ttlMs;
}

/**
 * The `## CI Certification` context block (design §6.5). Every persona on a
 * pipeline-mode run reads it — the CI agent to know whether BLOCKED is the
 * honest verdict, the release manager to know whether "certified" is even
 * achievable. Returns "" for a null check so `context +=` is safe.
 */
export function formatCiCheckBlock(ciCheck, mode = "off") {
  if (!ciCheck) return "";
  const lines = [
    "## CI Certification",
    `verdict: ${ciCheck.verdict}`,
    `ci_project: ${ciCheck.projectName}`,
    `webhook: ${ciCheck.webhook} · start_build: ${ciCheck.startBuild} · github_hook: ${ciCheck.githubHook}`,
    `reason: ${ciCheck.reason}`,
  ];
  if (ciCheck.verdict === "uncertifiable") {
    lines.push(
      "Consequence: no CodeBuild build can exist for ANY head SHA on this repo. " +
        "The CI agent must report BLOCKED with ci_status=unverified (or " +
        "github-actions-proxy when the head's GitHub check-runs are green) and must " +
        "NOT claim ci_status=certified; the release manager must surface this on the " +
        "merge gate rather than presenting CI as passed."
    );
  }
  if (mode === "shadow") {
    lines.push("mode: shadow (observe-only — no label, no gate prefix)");
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Prefix an uncertifiable-CI warning onto a review package (pure).
 *
 * The merge-gate ping's `details` is `pkg.summary`, so putting the warning
 * FIRST there is what makes it reach the phone notification, the mirrored gate
 * comment and the attached package in one edit. Caps match loadReviewPackage's
 * contract (summary 500, bullets 10) so a prefixed package stays phone-sized.
 */
export function prefixCiWarning(pkg, ciCheck) {
  const reason = ciCheck?.reason || "no CodeBuild build can exist for this head.";
  const projectName = ciCheck?.projectName || "the CI project";
  const summary = `⚠ CI UNCERTIFIABLE: ${reason}${pkg?.summary ? ` · ${pkg.summary}` : ""}`.slice(0, 500);
  const bullets = [
    `CI: no CodeBuild build can exist for this head (${projectName})`,
    ...(Array.isArray(pkg?.bullets) ? pkg.bullets : []),
  ].slice(0, 10);
  return {
    ...(pkg || {}),
    summary,
    bullets,
    links: Array.isArray(pkg?.links) ? pkg.links : [],
  };
}
