/**
 * Artifact chain — the playbook's committed audit trail.
 *
 * A def that declares `artifactChain` (workflows.json, sdlc-playbook) runs the
 * AI-native SDLC loop: every stage ends by committing an artifact to the run's
 * shared feature branch, and the next stage starts by reading it:
 *
 *   intent.md  (hub, from the originator's words; product owner accepts)
 *   spec.md    (spec author = the intake agent; product owner signs off)
 *   plan.md    (the "Plan:" dev ticket; engineer approves)
 *   findings.md (code reviewer, diff checked against the plan)
 *
 * Pure helpers only — the orchestrator (index.mjs) owns S3/GitHub/ticket I/O.
 * Same split as cd-registry.mjs so this file is unit-testable in isolation.
 */

export const ARTIFACT_CHAIN_GATE_MODES = new Set(["enforce", "off"]);

/** ARTIFACT_CHAIN_GATE env → "enforce" (default) | "off". Only applies to defs with a chain. */
export function normalizeChainGateMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  return ARTIFACT_CHAIN_GATE_MODES.has(v) ? v : "enforce";
}

/** The def's chain, or null when the def does not run the playbook. */
export function chainFor(def) {
  const chain = def?.artifactChain;
  if (!chain || typeof chain !== "object" || !Array.isArray(chain.artifacts) || !chain.dir) return null;
  return chain;
}

/** The chain directory in the target repo for one run (".sdlc/<workflowId>"). */
export function chainDir(def, workflowId) {
  const chain = chainFor(def);
  if (!chain) return null;
  return String(chain.dir).replace("{workflowId}", String(workflowId)).replace(/\/+$/, "");
}

export const CODE_REVIEWER_AGENT = "agentcore_hub_code_reviewer";
export const PLAN_TICKET_TITLE = /^\s*plan\s*:/i;

/**
 * Which chain artifacts a ticket must have committed before it may close.
 *   intake agent ticket          → intent.md + spec.md (it commits both)
 *   "Plan:" ticket (dev phase)   → plan.md
 *   code reviewer ticket         → findings.md
 *   anything else                → none
 * Returns [] for defs without a chain.
 */
export function requiredArtifactsForTicket({ def, ticket, agentDef, intakeAgentId }) {
  const chain = chainFor(def);
  if (!chain || !ticket) return [];
  const names = new Set(chain.artifacts.map((a) => a?.name).filter(Boolean));
  const want = [];
  const assignee = ticket.assignee;
  if (assignee && intakeAgentId && assignee === intakeAgentId) {
    if (names.has("intent.md")) want.push("intent.md");
    if (names.has("spec.md")) want.push("spec.md");
    return want;
  }
  if (agentDef?.phase === "development" && PLAN_TICKET_TITLE.test(String(ticket.title || ""))) {
    if (names.has("plan.md")) want.push("plan.md");
    return want;
  }
  if (assignee === CODE_REVIEWER_AGENT && names.has("findings.md")) {
    want.push("findings.md");
  }
  return want;
}

/** Whether this ticket is the playbook Plan ticket (plan.md author). */
export function isPlanTicket(ticket, agentDef) {
  return agentDef?.phase === "development" && PLAN_TICKET_TITLE.test(String(ticket?.title || ""));
}

/**
 * The `## SDLC Framework` context block every persona on a playbook run sees.
 * Names the chain dir + branch, the whole chain, and — for this ticket — the
 * artifact it owes and the rule the orchestrator enforces.
 */
export function sdlcFrameworkContext({ def, workflow, ticket, agentDef, intakeAgentId }) {
  const chain = chainFor(def);
  if (!chain) return "";
  const dir = chainDir(def, workflow?.id);
  const branch = workflow?.featureBranch || "(shared feature branch — created when the spec author is dispatched)";
  const owed = requiredArtifactsForTicket({ def, ticket, agentDef, intakeAgentId });
  const plan = isPlanTicket(ticket, agentDef);
  const lines = [
    `## SDLC Framework`,
    `framework: ${def.sdlcFramework || "playbook"}`,
    `artifact_dir: ${dir}`,
    `artifact_branch: ${branch}`,
    `chain: ${chain.artifacts.map((a) => `${a.name}${a.gate ? ` → ${a.gate}` : ""}`).join(" → ")}`,
    `Every stage commits its artifact to artifact_dir on artifact_branch; the next stage starts by reading it. The commit chain is the audit trail.`,
  ];
  if (owed.length) {
    lines.push(`your_artifact: ${owed.join(", ")}`);
    lines.push(
      `RULE: commit ${owed.join(" and ")} under ${dir}/ on ${branch} and push BEFORE WorkflowOutput___report_completion. ` +
      `Mirror the same content to S3 shared/<name> for the console viewer. The orchestrator verifies the file exists on the branch ` +
      `when your ticket closes and moves the ticket to Blocked with the missing path if it does not.`
    );
    if (plan) {
      lines.push(`This is the PLAN ticket: write plan.md ONLY — do not implement. load_blueprint("playbook-build") and follow its "Plan ticket" section.`);
    }
  } else if (agentDef?.phase === "development") {
    lines.push(`your_artifact: none — implement per ${dir}/plan.md. load_blueprint("playbook-build") and follow its "Implementation ticket" section. Record any deviation from the plan in plan.md under "## Deviations" and commit it.`);
  } else {
    lines.push(`your_artifact: none — read the chain (${dir}/) before you start; it is the run's source of truth.`);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Gate instruction line for the intake agent. Gates with `instructions` are
 * handed over verbatim (hub-created gates, single-ticket gates); the default
 * "blocked_by ALL <phase> tickets" wording comes from the caller.
 */
export function gateInstructionOverride(gate) {
  if (!gate || typeof gate.instructions !== "string" || !gate.instructions.trim()) return null;
  const block = gate.blocking ? "BLOCKING" : "advisory";
  return `  - "${gate.name || "Review"}" (${block}): ${gate.instructions.trim()}`;
}

/**
 * Resolve the review-package phase for gates the blocker walk cannot resolve:
 * a gate with no agent blockers is the hub-created Intent Acceptance gate
 * ("intake"); a gate whose title names Plan Approval reads the plan package.
 */
export function fallbackReviewPackagePhase(gateTicket) {
  const title = String(gateTicket?.title || "");
  if (/plan approval/i.test(title)) return "plan";
  if (/intent acceptance/i.test(title)) return "intake";
  if (!Array.isArray(gateTicket?.blockedBy) || gateTicket.blockedBy.length === 0) return "intake";
  return undefined;
}

/** GitHub contents-API path for one chain artifact. */
export function artifactRepoPath(def, workflowId, name) {
  const dir = chainDir(def, workflowId);
  return dir ? `${dir}/${name}` : null;
}

/** The ticket comment + resume note when a chain artifact is missing. */
export function missingArtifactNote({ missing, dir, branch }) {
  const list = missing.map((m) => `- ${dir}/${m}`).join("\n");
  return (
    `Artifact chain gate: your ticket closed but the following file(s) are not on branch ${branch}:\n${list}\n` +
    `Commit and push them to that branch (and mirror to S3 shared/), then move this ticket back to Ready. ` +
    `Nothing downstream starts until the artifact exists — that is the point of the chain.`
  );
}
