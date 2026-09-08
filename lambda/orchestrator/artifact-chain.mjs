/**
 * Artifact chain — the playbook's committed audit trail.
 *
 * A run whose EFFECTIVE def declares `artifactChain` (a framework overlay such
 * as software-delivery's "playbook", selected per run by input.sdlcFramework)
 * runs the AI-native SDLC loop: every stage ends by committing an artifact to
 * the run's shared feature branch, and the next stage starts by reading it:
 *
 *   intent.md          (hub, from the originator's words; product owner accepts)
 *   decisions.md       (the ORCHESTRATOR, from what humans decide at the gates)
 *   spec.md            (requirements analyst; product owner signs off)
 *   design/<agent>.md  (each design-phase persona; role leads + product owner)
 *   plan.md            (the "Plan:" dev ticket; engineer approves)
 *   findings.md        (code reviewer, diff checked against the plan)
 *
 * Pure helpers only — the orchestrator (index.mjs) owns S3/GitHub/ticket I/O.
 * Same split as cd-registry.mjs so this file is unit-testable in isolation. The
 * one import is live-reverify.mjs's `inertOneLine` (TEAM-4248 D3): a gate
 * decision is a string a human typed that ends up in a prompt, and writing a
 * second sanitiser would be a second thing to keep correct.
 */

import { inertOneLine } from "./live-reverify.mjs";

export const ARTIFACT_CHAIN_GATE_MODES = new Set(["enforce", "off"]);

/**
 * The framework a run follows: the requested overlay when the def offers it,
 * else the def's own `sdlcFramework`, else "standard". Twin of
 * src/lib/workflow/workflow-defs.ts resolveFramework.
 */
export function resolveFramework(def, requested) {
  if (typeof requested === "string" && requested !== "standard" && def?.frameworks && requested in def.frameworks) {
    return requested;
  }
  const own = def?.sdlcFramework;
  return own === "playbook" || own === "aidlc" ? own : "standard";
}

/**
 * The effective def for a framework: overlay fields (featureBranchPhase,
 * artifactChain, reviewGates, completionRequiresAgentPhases) laid over the def,
 * `sdlcFramework` stamped. Unknown / "standard" → the def unchanged. Twin of
 * workflow-defs.ts applyFramework; phaseOrder and every other field survive.
 */
export function applyFramework(def, framework) {
  const overlay = framework && framework !== "standard" ? def?.frameworks?.[framework] : undefined;
  if (!overlay) return def;
  const { label: _label, description: _description, ...fields } = overlay;
  return { ...def, ...fields, sdlcFramework: framework };
}

/** The framework a stored workflow row runs under (row stamp, else input, else def). */
export function frameworkOfWorkflow(def, workflow) {
  return resolveFramework(def, workflow?.sdlcFramework || workflow?.input?.sdlcFramework);
}

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

/** design/<agent>.md — the design-phase persona's committed section. */
export function designArtifactName(agentId) {
  return `design/${String(agentId || "").replace(/^agentcore_hub_/, "").replace(/_/g, "-")}.md`;
}

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
  if (agentDef?.phase === "design" && names.has("design/<agent>.md")) {
    want.push(designArtifactName(assignee));
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
 *
 * `openDecisions` (TEAM-4248 D3) additionally emits `## Gate Decisions (REQUIRED
 * checklist)` for the two personas that WRITE the artifacts a gate then judges —
 * design-phase personas and the Plan ticket. Under DECISION_LEDGER=off the
 * caller passes nothing and the block is not emitted at all.
 */
export function sdlcFrameworkContext({ def, workflow, ticket, agentDef, intakeAgentId, openDecisions }) {
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
    } else if (agentDef?.phase === "design") {
      lines.push(`Design-phase persona: commit your design doc as ${owed[0]} (mockups/diagrams alongside it under ${dir}/design/) on ${branch}, in addition to your normal S3 deliverables. Read ${dir}/spec.md first — it is the spec you design against.`);
    } else if (agentDef?.phase === "requirements") {
      lines.push(`Follow the "Playbook mode" section of your blueprint: spec.md (requirements + design brief + policy answers + Concerns) is the artifact; keep the standard designer tiers; add the Plan ticket + Plan Approval gate before implementation.`);
    }
  } else if (agentDef?.phase === "development") {
    lines.push(`your_artifact: none — implement per ${dir}/plan.md. load_blueprint("playbook-build") and follow its "Implementation ticket" section. Record any deviation from the plan in plan.md under "## Deviations" and commit it.`);
  } else {
    lines.push(`your_artifact: none — read the chain (${dir}/) before you start; it is the run's source of truth.`);
  }
  let block = lines.join("\n") + "\n\n";
  // Only the artifact AUTHORS a gate judges get the checklist. Handing it to a QA
  // verifier would be handing another persona's obligation to someone who cannot
  // discharge it.
  const checklist = plan || agentDef?.phase === "design" ? openDecisionChecklist(openDecisions) : "";
  if (checklist) {
    block +=
      `## Gate Decisions (REQUIRED checklist)\n` +
      `A human RESOLVED each line below at a review gate on this run (${dir}/decisions.md is the ledger). ` +
      `For every line: either implement it and cite it in your artifact, or add a "## Deviations" row in ` +
      `your artifact naming it and why you departed from it. To cite, write the id (e.g. TEAM-4174#3) ` +
      `anywhere, or name the gate ticket on the SAME line or table row as the concern number ` +
      `("Concern 3", "#3", or a leading "| 3 |" cell). Citing is the requirement — you may ` +
      `disagree with a decision, but you may not leave it unmentioned. An artifact that cites none of these ` +
      `does not pass its gate; "## Deviations: None yet." with an open line above it is exactly the failure ` +
      `this checklist exists to prevent.\n` +
      checklist +
      "\n\n";
  }
  return block;
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

// ---------------------------------------------------------------------------
// Decision ledger (TEAM-4248 D3)
//
// dowtdh is the whole reason this exists. The product owner resolved Concern 3
// at Spec Approval TEAM-4174 as "5000 ms window; pause the countdown while Undo
// has focus or hover", and restated it at Design Approval TEAM-4176. The design
// then recommended the opposite, plan.md TEAM-4177 wrote "Keep fixed 5000 ms; no
// focus-pause" under "## Deviations: None yet.", and TEAM-4178 (Plan Approval)
// APPROVED that plan — the engineer's review package never mentioned the
// contradiction. It surfaced at the very end as reviewer finding F1 P1 and cost
// a fix ticket. The dossier proves the mechanism: its tickets carry no
// `comments` array at all, so the human's words exist nowhere in the run's own
// record. A decision a human paid attention to is strictly weaker than an
// artifact, so D3 makes it one.
// ---------------------------------------------------------------------------

export const DECISION_LEDGER_MODES = new Set(["off", "shadow", "enforce"]);

/**
 * DECISION_LEDGER env → "off" | "shadow" (default) | "enforce".
 *
 * Fail-safe direction is deliberately RECORD, not silence: losing a decision is
 * the danger this feature exists for, so unset AND garbage both land on shadow,
 * which records the ledger without gating any human. Only an explicit "off"
 * turns the feature off, and only an explicit "enforce" lets it withhold a gate.
 *
 * Not `normalizeReworkLoopMode`: that one maps the legacy truthy strings
 * ("on"/"true"/"1") to ENFORCE (rework-loop-cap.mjs), and for a flag whose
 * enforce mode pushes a commit and can reject a human gate, `DECISION_LEDGER=on`
 * must not silently mean "push".
 */
export function normalizeDecisionLedgerMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "off" || v === "enforce" ? v : "shadow";
}

/**
 * A numbered decision: "Concern 3 (…): RESOLVED - <text>" or "#3: DECIDED — …".
 * The concern number is what makes the id stable and citable, so it is the
 * preferred grammar and the one the blueprints ask humans for.
 *
 * The descriptor group is LAZY and allows colons on purpose. dowtdh's real
 * TEAM-4174 comment writes the policy owner into it —
 * "#1 Brand (human:brand-lead): RESOLVED - …" — and a colon-free descriptor
 * class silently matched none of that run's six decisions: the first colon it
 * could reach was the one inside `human:brand-lead`. Lazy means the split lands
 * on the first colon actually followed by the verdict keyword, so the owner tag
 * stays in the descriptor and the decision text stays whole.
 */
const NUMBERED_DECISION_RE =
  /^\s*(?:#|Concern\s+)(\d+)\b(.*?):\s*(?:RESOLVED|DECIDED|DECISION)\s*[-–—:]\s*(.+)$/i;

/** An unnumbered decision: "DECISION: <text>" — no concern to anchor to. */
const UNNUMBERED_DECISION_RE = /^\s*DECISION:\s*(.+)$/i;

/**
 * Gate-ticket comments → ledger entries. Two grammars only; a comment that
 * matches neither is NOT a decision — "LGTM", "approved", "thanks" must never
 * become ledger entries an artifact is then required to cite.
 *
 * ids: "<gateTicketId>#<n>" for the numbered grammar (dowtdh's PO comment yields
 * TEAM-4174#3), "<gateTicketId>#D<seq>" for the unnumbered one, seq being the
 * 1-based index among unnumbered hits IN THIS COMMENT SET — so a webhook
 * redelivery of the same comments produces the same ids and appends nothing.
 *
 * Every text goes through inertOneLine: the entry ends up in a prompt and in a
 * committed file, and a newline in a human's comment is how "a decision" becomes
 * a second instruction line.
 */
export function extractGateDecisions(comments, { gateTicketId, gateName, reviewer } = {}) {
  const out = [];
  let unnumberedSeq = 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = typeof c === "string" ? c : String(c?.content ?? c?.body ?? "");
    if (!body.trim()) continue;
    const author = (typeof c === "string" ? "" : String(c?.author || "")) || reviewer || "unknown";
    const at = typeof c === "string" ? "" : String(c?.timestamp || c?.created || "");
    // extractAdfText has no hardBreak handling, so a multi-line Jira comment can
    // arrive already line-joined; splitting still handles the DynamoDB provider
    // and hand-written comments, and the joined case matches on its first clause.
    for (const line of body.split(/\r?\n/)) {
      const numbered = NUMBERED_DECISION_RE.exec(line);
      if (numbered) {
        const concern = Number(numbered[1]);
        out.push({
          id: `${gateTicketId}#${concern}`,
          concern,
          gateTicketId: gateTicketId || null,
          gateName: gateName || null,
          reviewer: author,
          at,
          text: inertOneLine(numbered[3]),
          status: "open",
        });
        continue;
      }
      const unnumbered = UNNUMBERED_DECISION_RE.exec(line);
      if (unnumbered) {
        unnumberedSeq += 1;
        out.push({
          id: `${gateTicketId}#D${unnumberedSeq}`,
          concern: null,
          gateTicketId: gateTicketId || null,
          gateName: gateName || null,
          reviewer: author,
          at,
          text: inertOneLine(unnumbered[1]),
          status: "open",
        });
      }
    }
  }
  return out;
}

/** The header a fresh decisions.md opens with (the file is orchestrator-owned). */
export const DECISIONS_LEDGER_HEADER =
  `# Gate Decisions\n\n` +
  `Every decision a human recorded at a review gate on this run, extracted from the gate ticket's ` +
  `comments by the orchestrator. Do not hand-edit — append happens on each gate resolution.\n\n` +
  `Downstream artifacts must CITE the id of every open decision they act on, or record a ` +
  `"## Deviations" row naming the id and the reason for departing from it.\n`;

/** One ledger entry, rendered. Round-trips through parseDecisionsLedger. */
export function renderDecisionEntry(d) {
  return (
    [
      `### ${d?.id ?? ""}`,
      `- **id:** ${d?.id ?? ""}`,
      `- **Gate:** ${d?.gateName || "Review"} (${d?.gateTicketId || "unknown"})`,
      `- **Concern:** ${d?.concern == null ? "-" : d.concern}`,
      `- **Reviewer:** ${d?.reviewer || "unknown"}`,
      `- **At:** ${d?.at || ""}`,
      `- **Status:** ${d?.status || "open"}`,
      `- **Decision:** ${d?.text || ""}`,
    ].join("\n") + "\n"
  );
}

const FIELD_RE = (label) => new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, "im");

/**
 * decisions.md → entries. `status` is read back as a real field, not assumed:
 * a human or a later feature marking an entry resolved must be able to retire it
 * without the gate check re-firing on it forever.
 */
export function parseDecisionsLedger(md) {
  const text = typeof md === "string" ? md : "";
  const out = [];
  for (const block of text.split(/^### /m).slice(1)) {
    const field = (label) => {
      const m = FIELD_RE(label).exec(block);
      return m ? m[1].trim() : "";
    };
    const id = field("id") || block.split(/\r?\n/, 1)[0].trim();
    if (!id) continue;
    const gate = /^- \*\*Gate:\*\* (.*?)\s*\(([^)]*)\)\s*$/im.exec(block);
    const concernRaw = field("Concern");
    out.push({
      id,
      concern: concernRaw && concernRaw !== "-" ? Number(concernRaw) : null,
      gateTicketId: gate ? gate[2] : "",
      gateName: gate ? gate[1] : "",
      reviewer: field("Reviewer"),
      at: field("At"),
      status: field("Status") || "open",
      text: field("Decision"),
    });
  }
  return out;
}

/**
 * Append entries not already in the ledger. Idempotent BY ID, not by text: a
 * human editing their own comment changes the prose but resolves the same
 * concern, and the artifacts downstream cite the id. `added` is what the caller
 * writes on — added.length === 0 means no GitHub PUT, no S3 write, no event, so
 * a webhook redelivery costs nothing.
 */
export function appendDecisions(existingMd, entries) {
  const md0 = typeof existingMd === "string" ? existingMd : "";
  const have = new Set(parseDecisionsLedger(md0).map((d) => d.id));
  const added = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e?.id || have.has(e.id)) continue;
    have.add(e.id);
    added.push(e);
  }
  if (!added.length) return { md: md0, added };
  const base = md0.trim() ? `${md0.replace(/\s*$/, "")}\n` : DECISIONS_LEDGER_HEADER;
  return { md: `${base}\n${added.map(renderDecisionEntry).join("\n")}`, added };
}

/**
 * Open decisions the artifact under review does not cite.
 *
 * The rule is a CITATION rule, deliberately, and it is the whole contract. A
 * decision counts as referenced iff, case-insensitively, either
 *   1. the artifact contains its id token ("TEAM-4174#3") anywhere, or
 *   2. ONE LINE of the artifact contains BOTH the gate ticket key ("TEAM-4174")
 *      and the concern number, the number written as "Concern <n>", "#<n>", or the
 *      FIRST cell of a markdown table row ("| 3 | … |").
 * Nothing else counts — no substring matching on the decision prose, which is
 * unpredictable for the agent being judged and untestable for us. An unnumbered
 * ("#D<seq>") decision has no concern number and is referenced only by rule 1.
 *
 * Rule 2 is LINE-SCOPED, which cuts both ways on purpose. It is stricter than a
 * document-wide match — the gate key in a header and "Concern 3" in an unrelated
 * paragraph 80 lines later is not a citation of anything — and it is the only way
 * to accept the form a real fixed artifact uses. dowtdh's post-fix plan.md cites
 * its decisions in the Concerns table:
 *
 *   | 3 | (spec) Undo auto-dismisses at 5000 ms… | UX | human:design-lead |
 *     5000 ms window; pause… (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
 *
 * That row names the gate and the concern in one place and is unambiguous to a
 * human reader; flagging it would reopen a good plan under enforce, which is the
 * worst false positive this feature can produce. The table-cell form requires the
 * first cell to be EXACTLY the number, so a "| 13 |" row is not a citation of
 * concern 3.
 *
 * Consequence, and it is intended: a "## Deviations" row that names the id — or
 * names the gate and the concern on that row — is "referenced" and passes. The
 * contract is "cite the decision and say what you did with it", NOT "obey it": a
 * designer who disagrees with the product owner records the departure and the
 * human sees it at the gate. dowtdh's approved plan.md fails this check not
 * because it chose "no focus-pause" but because it cites TEAM-4174 nowhere at
 * all, under "## Deviations: None yet."
 *
 * status !== "open" is never reported: a retired decision is settled.
 */
export function unreferencedDecisions(decisions, artifactText) {
  const text = typeof artifactText === "string" ? artifactText : "";
  const lower = text.toLowerCase();
  const lines = lower.split(/\r?\n/);
  return (Array.isArray(decisions) ? decisions : []).filter((d) => {
    if (!d || String(d.status || "open").toLowerCase() !== "open") return false;
    const id = String(d.id || "");
    if (id && lower.includes(id.toLowerCase())) return false;
    const key = String(d.gateTicketId || "").toLowerCase();
    if (!key || d.concern == null) return true;
    const n = Number(d.concern);
    // "Concern 3" / "#3" anywhere on the line, or the line is a table row whose
    // first cell is exactly "3".
    const concernOnLine = new RegExp(`(?:concern\\s*|#)${n}\\b|^\\s*\\|\\s*${n}\\s*\\|`, "i");
    return !lines.some((line) => line.includes(key) && concernOnLine.test(line));
  });
}

/**
 * "Decisions not honoured" bullets for a review package. Each leads with the id
 * (the token the artifact was supposed to cite) and clamps to 200 chars — the
 * same per-bullet clamp loadReviewPackage applies to agent bullets, so a long
 * decision cannot push a package over the wire budget. The remedy is stated once
 * in the section preamble rather than repeated into every bullet's clamp.
 */
export function decisionsNotHonouredBullets(entries) {
  return (Array.isArray(entries) ? entries : []).map((d) => {
    const head = `${d?.id || "decision"} not cited — `;
    return (head + inertOneLine(d?.text, Math.max(20, 200 - head.length))).slice(0, 200);
  });
}

/** The `## Gate Decisions (REQUIRED checklist)` body: one `- [ ]` per open decision. */
export function openDecisionChecklist(entries) {
  const open = (Array.isArray(entries) ? entries : []).filter(
    (d) => d?.id && String(d.status || "open").toLowerCase() === "open",
  );
  if (!open.length) return "";
  return open
    .map((d) => {
      const gate = d.gateName ? ` (${d.gateName}, ${d.gateTicketId || "?"})` : "";
      return `- [ ] ${d.id} — ${inertOneLine(d.text, 300)}${gate}`;
    })
    .join("\n");
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
