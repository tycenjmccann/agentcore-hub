/**
 * TEAM-3992 D3.1/D3.2 — orchestrator-created fix tickets + SHA-pinned re-arm.
 *
 * Two responsibilities, both driven off the tickets Lambda (Tickets___* ops) so
 * they are backend-agnostic (dynamodb / jira):
 *
 *   spawnFixTicketsFromFindings — when a verifier (code_reviewer / qa_verifier /
 *     codex) reports `findings`, the orchestrator creates ONE fix ticket per
 *     component, assigned to the run's dev agent, blocked_by the finder. This is
 *     deterministic and idempotent: findingId = sha1(originTicketId + component)
 *     is dedup'd against existing siblings' spawnedBy.findingId, so a re-reported
 *     finding never spawns a second ticket.
 *
 *   rearmVerification — when a fix ticket closes Done, the orchestrator creates a
 *     "Re-verify (<role>)" ticket per role its kind re-arms (def ticketDag.fixRearm),
 *     each PINNED to the fix's final commit SHA and blocked_by the fix. The QA
 *     re-verify is additionally blocked_by the review re-verify (D3.2 — QA must
 *     see the re-reviewed code). When shipBlockedByRearmed, the Ship ticket gains
 *     these re-arm tickets as blockers via the add_blockers op. The re-verify
 *     tickets then report `verification{target_ticket_id, head_sha, kind, verdict}`,
 *     which is what the SHA-pinned completion gate (fixVerificationGaps) reads.
 *
 * Dependency-injected (deps) so fix-rearm.test.mjs can drive the real logic with
 * the tickets-Lambda invoke, event publish, child read, and def/roster lookups
 * mocked at the seam — no AWS, no network.
 */
import { createHash } from "node:crypto";

/** Fix-ticket kinds the pipeline recognizes (mirror of completion.mjs FIX_KINDS). */
export const FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix"]);

/** finder agentId → the fix kind it produces. */
export function finderKind(agentId) {
  const id = String(agentId || "");
  if (id.includes("code_reviewer")) return "review_fix";
  if (id.includes("qa_verifier")) return "qa_fix";
  if (id.includes("codex")) return "codex_fix";
  return null;
}

/** fix kind → the spawnedBy origin key the tickets Lambda records the finder under. */
export const KIND_TO_ORIGIN_KEY = Object.freeze({
  review_fix: "gateTicketId",
  qa_fix: "qaTicketId",
  codex_fix: "codexTicketId",
});

/** Stable finding id — same (origin, component) always collapses to one ticket. */
export function findingId(originTicketId, component) {
  return createHash("sha1").update(`${originTicketId} ${component}`).digest("hex").slice(0, 16);
}

const sha7 = (sha) => String(sha || "").toLowerCase().slice(0, 7);

/** Resolve the role's verifier agentId from the def's ticketDag node. */
function roleAgentId(def, role) {
  const node = def?.ticketDag?.nodes?.[role];
  const ids = node && Array.isArray(node.agentIds) ? node.agentIds : [];
  return ids[0] || null;
}

/**
 * Create fix tickets from a completion's `findings`, one per component, deduped
 * against existing sibling fix tickets. Returns the created ticket descriptors.
 *
 * deps: { invokeTickets(op, params)->result, publishEvent(id,type,detail),
 *         getChildTickets(epicId)->[tickets], getWorkflowDef(defId)->def,
 *         resolveDevAssignee(workflow, children)->agentId,
 *         claimFindingSpawn(workflowId, findingId)->{won,ticketId,status}?  (F5b CAS),
 *         finalizeFindingSpawn(workflowId, findingId, ticketId)? }
 * The two CAS deps are optional: when absent (older callers/tests) the read-first
 * `existing` check is the only dedupe, matching pre-F5b behavior.
 */
export async function spawnFixTicketsFromFindings(workflow, finderTicket, completion, deps) {
  const findings = Array.isArray(completion?.findings) ? completion.findings : [];
  if (findings.length === 0) return [];
  const kind = finderKind(finderTicket?.assignee);
  if (!kind) return [];
  const originTicketId = finderTicket.ticketId;
  const originKey = KIND_TO_ORIGIN_KEY[kind];

  // Group findings by component (blank component → its own bucket keyed "general").
  const byComponent = new Map();
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const component = typeof f.component === "string" && f.component.trim() ? f.component.trim() : "general";
    if (!byComponent.has(component)) byComponent.set(component, []);
    byComponent.get(component).push(f);
  }
  if (byComponent.size === 0) return [];

  const children = (await deps.getChildTickets(workflow.epicId)) || [];
  const existing = new Set(
    children.map((t) => t?.spawnedBy?.findingId).filter((x) => typeof x === "string")
  );
  const def = deps.getWorkflowDef(workflow.workflowDefId);
  const assignee = deps.resolveDevAssignee(workflow, children);

  const created = [];
  for (const [component, group] of byComponent) {
    const fid = findingId(originTicketId, component);
    if (existing.has(fid)) continue; // already spawned on a prior report

    // TEAM-4100 F5b — provider-independent create-time dedupe. The `existing`
    // read above misses an in-flight concurrent spawn, and the Jira twin has no
    // conditional create (its finding:<fid> label is only a secondary marker). The
    // orchestrator is the sole caller passing findingId, so a CAS on the workflows
    // table closes the race for BOTH ticket providers. Loser skips the create and
    // reports the winner's key (once finalized); a still-pending winner yields no
    // key yet, and the loser publishes no second fix_spawned event either way.
    if (deps.claimFindingSpawn) {
      const claim = await deps.claimFindingSpawn(workflow.id, fid);
      if (!claim.won) {
        created.push({ ticketId: claim.ticketId || null, component, kind, findingId: fid, assignee, deduped: true });
        continue;
      }
    }

    const severity = group.find((g) => g.severity)?.severity || "";
    const summary = group.map((g) => g.summary).filter(Boolean).join("; ").slice(0, 500) || component;
    const files = [...new Set(group.flatMap((g) => (Array.isArray(g.files) ? g.files : [])))];
    const title = `Fix (${component}): ${summary}`.slice(0, 240);
    const description =
      `Fix the following issue(s) found by ${originTicketId} in component "${component}"` +
      `${severity ? ` [${severity}]` : ""}:\n\n${summary}` +
      (files.length ? `\n\nFiles: ${files.join(", ")}` : "");

    const spawned_by = { kind, [originKey]: originTicketId, by: "orchestrator", findingId: fid };
    const params = {
      summary: title,
      description,
      assignee,
      blocked_by: [originTicketId],
      workflow_id: workflow.id,
      parent_key: workflow.epicId,
      spawned_by,
    };
    if (finderTicket.phase) params.phase = finderTicket.phase;

    try {
      const res = await deps.invokeTickets("create_ticket", params);
      const ticketId = res?.ticket_id || res?.ticketId || res?.key || null;
      // TEAM-4100 F5b — record the winner's key on the claim so a concurrent loser
      // reports the same ticket. TEAM-4100 F5: the DDB tickets Lambda also enforces
      // (workflow, findingId) uniqueness at create time (defense-in-depth); a
      // `deduped` response means a concurrent create beat us at the Lambda — return
      // the same key but do NOT publish a second fix_spawned event.
      if (deps.finalizeFindingSpawn && ticketId) {
        await deps.finalizeFindingSpawn(workflow.id, fid, ticketId);
      }
      const deduped = !!(res?.deduped || res?.deduplicated);
      created.push({ ticketId, component, kind, findingId: fid, assignee, deduped });
      if (!deduped) {
        await deps.publishEvent(workflow.epicId, "orchestrator.fix_spawned", {
          workflowId: workflow.id, ticketId, originTicketId, kind, component, assignee, findingId: fid, by: "orchestrator",
        });
      }
    } catch (err) {
      console.warn(`[fix-tickets] create_ticket failed for finding ${fid} (${component}): ${err?.message || err}`);
    }
  }
  return created;
}

/**
 * Create SHA-pinned re-verify tickets for a fix that just closed Done. Returns
 * { created: [{ticketId, role}], shipTicketId }.
 *
 * deps additionally needs: getAgentDef(id)->{phase}.
 * fixTicket must carry spawnedBy.kind (∈ FIX_KINDS) and its final commit SHA is
 * read from agentTasks via deps.commitShaOf(fixTicket.ticketId).
 */
export async function rearmVerification(workflow, fixTicket, deps) {
  const kind = fixTicket?.spawnedBy?.kind;
  if (!FIX_KINDS.has(kind)) return { created: [], shipTicketId: null };
  if (fixTicket?.spawnedBy?.rearmOf) return { created: [], shipTicketId: null }; // a re-arm is not itself re-armed

  const def = deps.getWorkflowDef(workflow.workflowDefId);
  const fixRearm = def?.ticketDag?.fixRearm;
  const roles = fixRearm && Array.isArray(fixRearm[kind]) ? fixRearm[kind] : [];
  if (roles.length === 0) return { created: [], shipTicketId: null };

  const headSha = deps.commitShaOf(fixTicket.ticketId);
  if (!headSha) {
    console.warn(`[fix-tickets] cannot re-arm ${fixTicket.ticketId} — no commit sha harvested yet`);
    return { created: [], shipTicketId: null };
  }
  const fixId = fixTicket.ticketId;
  const originKey = KIND_TO_ORIGIN_KEY[kind];

  const children = (await deps.getChildTickets(workflow.epicId)) || [];
  // Dedup on (rearmOf, role, headSha): re-running the done handler must not
  // create a second re-verify for the same fix at the same SHA.
  const existing = new Set(
    children
      .map((t) => t?.spawnedBy)
      .filter((sb) => sb && sb.rearmOf === fixId && sb.headSha === headSha)
      .map((sb) => `${sb.rearmOf} ${sb.role} ${sb.headSha}`)
  );

  const created = [];
  let reviewRearmId = null;
  for (const role of roles) {
    const dedupKey = `${fixId} ${role} ${headSha}`;
    if (existing.has(dedupKey)) continue;
    const assignee = roleAgentId(def, role);
    if (!assignee) {
      console.warn(`[fix-tickets] no agent for re-arm role "${role}" in def ${def?.id}`);
      continue;
    }
    // D3.2 — the verification re-verify must see the re-REVIEWED code, so it is
    // blocked_by the review re-verify (when one exists this round) as well as the fix.
    const blocked_by = [fixId];
    if (role === "verification" && reviewRearmId) blocked_by.push(reviewRearmId);

    const spawned_by = { kind, [originKey]: fixTicket.spawnedBy?.[originKey], rearmOf: fixId, headSha, role };
    const params = {
      summary: `Re-verify (${role}): ${fixTicket.title || fixId} @ ${sha7(headSha)}`.slice(0, 240),
      description:
        `Re-verify fix ${fixId} at HEAD ${headSha}. Report a verification object in report_completion ` +
        `(target_ticket_id=${fixId}, head_sha=${headSha}).`,
      assignee,
      blocked_by,
      workflow_id: workflow.id,
      parent_key: workflow.epicId,
      spawned_by,
    };
    const phase = deps.getAgentDef(assignee)?.phase;
    if (phase) params.phase = phase;

    try {
      const res = await deps.invokeTickets("create_ticket", params);
      const ticketId = res?.ticket_id || res?.ticketId || res?.key || null;
      created.push({ ticketId, role });
      if (role === "review") reviewRearmId = ticketId;
    } catch (err) {
      console.warn(`[fix-tickets] re-arm create_ticket failed for ${fixId}/${role}: ${err?.message || err}`);
    }
  }

  // Ship gate: block the Ship ticket on the freshly-created re-verify tickets so a
  // run cannot ship before its fixes are re-verified at the code that landed.
  let shipTicketId = null;
  if (fixRearm.shipBlockedByRearmed && created.length > 0) {
    const ship = children.find(
      (t) => t?.assignee === roleAgentId(def, "ship") && /^ship:/i.test(String(t?.title || ""))
    );
    shipTicketId = ship?.ticketId || null;
    if (shipTicketId) {
      const rearmIds = created.map((c) => c.ticketId).filter(Boolean);
      if (rearmIds.length > 0) {
        try {
          await deps.invokeTickets("add_blockers", { ticket_id: shipTicketId, blocked_by: rearmIds });
        } catch (err) {
          console.warn(`[fix-tickets] add_blockers failed for ship ${shipTicketId}: ${err?.message || err}`);
        }
      }
    }
  }

  if (created.length > 0) {
    await deps.publishEvent(workflow.epicId, "orchestrator.verification_rearmed", {
      workflowId: workflow.id, fixTicketId: fixId, headSha, created, shipTicketId,
    });
  }
  return { created, shipTicketId };
}
