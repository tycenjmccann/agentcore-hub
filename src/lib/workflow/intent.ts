/**
 * Playbook PLAN stage — intent capture.
 *
 * The originator's request is rendered VERBATIM into intent.md (never
 * paraphrased by a model), stored at workflows/{id}/shared/intent.md, and
 * accepted by the product owner at the Intent Acceptance gate before any agent
 * runs. The spec author later commits the same file to the run's feature
 * branch as the first link of the artifact chain (.sdlc/{id}/intent.md).
 *
 * Pure helpers — no I/O — so the start route owns the S3/ticket writes and
 * this module is unit-testable.
 */

import type { IntentBrief, IntakeSource, WorkflowInput } from "./types";
import type { ReviewGate, WorkflowDef } from "./workflow-defs";

/** The hub-created gate that guards the intake phase (playbook defs), if the def declares one. */
export function intentGateFor(def: WorkflowDef, requestedGates: string[] = []): ReviewGate | null {
  const gate = (def.reviewGates || []).find((g) => g.afterPhase === "intake" && g.blocking);
  if (!gate) return null;
  if (gate.condition === "always" || requestedGates.includes("intake")) return gate;
  return null;
}

/** Directory of the committed artifact chain for a run, or null for non-playbook defs. */
export function artifactChainDir(def: WorkflowDef, workflowId: string): string | null {
  if (!def.artifactChain?.dir) return null;
  return def.artifactChain.dir.replace("{workflowId}", workflowId);
}

const orNotStated = (v: string | undefined, fallback = "Not stated.") =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

function sourceLine(s: IntakeSource): string {
  const label = s.label ? `${s.label}: ` : "";
  return `- ${label}${s.value}`;
}

/**
 * Render intent.md. Field text is copied as-is (trimmed) — the whole point is
 * that the originator's words survive intact. Section headings are fixed so
 * the spec author and the product owner always find the same structure.
 */
export function renderIntentMarkdown(opts: {
  workflowId: string;
  input: WorkflowInput;
  filedAt?: string;
  intakeChannel?: string;
}): string {
  const { workflowId, input } = opts;
  const intent: IntentBrief | undefined = input.intent;
  const filedAt = opts.filedAt || new Date().toISOString();
  const channel = opts.intakeChannel || input.intakeChannel || "console";
  const originator = orNotStated(intent?.originator, "Not stated");
  const repos = (input.repoConfig?.repos || []).map((r) => r.url).filter(Boolean);

  const lines: string[] = [
    `# Intent: ${input.title.trim()}`,
    "",
    `- Workflow: ${workflowId}`,
    `- Originator: ${originator} (via ${channel})`,
    `- Filed: ${filedAt}`,
    `- Status: proposed — becomes accepted when the product owner approves the Intent Acceptance gate`,
    ...(repos.length ? [`- Target repo: ${repos.join(", ")}`] : []),
    "",
    "## Problem",
    orNotStated(intent?.problem, orNotStated(input.description, "Not stated.")),
    "",
    "## Who is affected",
    orNotStated(intent?.who),
    "",
    "## Success criteria",
    orNotStated(intent?.successCriteria, "Not stated — the product owner confirms the success criteria at acceptance."),
    "",
    "## Constraints",
    orNotStated(intent?.constraints, "None stated."),
    "",
    "## Out of scope",
    orNotStated(intent?.outOfScope),
    "",
  ];

  // When a structured brief was given, the free-text description is still the
  // originator's words — keep it, labelled, so nothing they wrote is lost.
  if (intent && input.description && input.description.trim() && input.description.trim() !== intent.problem?.trim()) {
    lines.push("## Original request (verbatim)", input.description.trim(), "");
  }

  if (input.sources?.length) {
    lines.push("## Sources", ...input.sources.map(sourceLine), "");
  }

  lines.push(
    "---",
    "This file is the first link of the run's artifact chain. It is accepted, not edited, by the product owner;",
    "corrections come from the originator. The spec author commits it unchanged to the feature branch.",
    ""
  );
  return lines.join("\n");
}

/**
 * The review package for the Intent Acceptance ping (blueprints/review-package.md
 * schema). Written by the hub — there is no upstream agent for this gate.
 */
export function intentReviewPackage(opts: {
  workflowId: string;
  input: WorkflowInput;
}): { gate: string; summary: string; bullets: string[]; links: { label: string; artifactKey: string }[] } {
  const { workflowId, input } = opts;
  const intent = input.intent;
  const who = intent?.originator ? ` — filed by ${intent.originator.trim()}` : "";
  const bullets = [
    `Problem: ${orNotStated(intent?.problem, orNotStated(input.description)).slice(0, 180)}`,
    `Success: ${orNotStated(intent?.successCriteria, "not stated — confirm at acceptance").slice(0, 180)}`,
    ...(intent?.constraints?.trim() ? [`Constraints: ${intent.constraints.trim().slice(0, 180)}`] : []),
    ...(intent?.outOfScope?.trim() ? [`Out of scope: ${intent.outOfScope.trim().slice(0, 180)}`] : []),
    "Approve = accept this intent as written and start the spec. Request changes = send it back to the originator.",
  ];
  return {
    gate: "intake",
    summary: `Intent Acceptance: "${input.title.trim()}"${who}. Approving starts the spec author; nothing runs until you do.`,
    bullets,
    links: [{ label: "intent.md", artifactKey: `workflows/${workflowId}/shared/intent.md` }],
  };
}

/** Ticket body for the Intent Acceptance gate (plain text — both ticket backends render it). */
export function intentGateDescription(intentMarkdown: string, workflowId: string): string {
  return [
    "Intent Acceptance gate (playbook PLAN stage).",
    "",
    "You are the product owner. Decide whether this intent, in the originator's own words, is worth building.",
    "Approve (Done) → the spec author starts. Request changes (Blocked) → leave a comment for the originator; nothing runs.",
    `Artifact: workflows/${workflowId}/shared/intent.md (also committed to the feature branch as the first link of the chain).`,
    "",
    "----- intent.md -----",
    intentMarkdown,
  ].join("\n");
}
