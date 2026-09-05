/**
 * agentcore-hub-jira — Ticket tools Lambda for Jira Cloud.
 *
 * Deploy this when TICKET_PROVIDER=jira.
 * Agents call this Lambda to create/update/transition tickets in Jira.
 *
 * Env vars:
 *   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// ─── Jira Config ─────────────────────────────────────────────────────────────

const SITE = process.env.JIRA_SITE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "TEAM";

const BASE_URL = `https://${SITE}`;
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

// ─── S3 Config (for agent roster) ────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const s3 = new S3Client({ region: REGION });

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_ASSIGNEES = new Set([
  "agentcore_hub_requirements_analyst",
  "agentcore_hub_frontend_designer",
  "agentcore_hub_ios_designer",
  "agentcore_hub_backend_designer",
  "agentcore_hub_android_designer",
  "agentcore_hub_security_reviewer",
  "agentcore_hub_legal_compliance",
  "agentcore_hub_localization",
  "agentcore_hub_analytics_designer",
  "agentcore_hub_backend_dev",
  "agentcore_hub_api_dev",
  "agentcore_hub_frontend_dev",
  "agentcore_hub_code_reviewer",
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
  "agentcore_hub_release_manager",
]);

let VALID_ASSIGNEES = null;

async function loadValidAssignees() {
  if (VALID_ASSIGNEES) return VALID_ASSIGNEES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-jira] No ARTIFACT_BUCKET — using fallback roster");
    VALID_ASSIGNEES = FALLBACK_ASSIGNEES;
    return VALID_ASSIGNEES;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    VALID_ASSIGNEES = new Set(config.agents.map((a) => a.agentId));
    console.log(`[agentcore-hub-jira] Loaded ${VALID_ASSIGNEES.size} agents from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-jira] Failed to load roster from S3: ${err.message} — using fallback`);
    VALID_ASSIGNEES = FALLBACK_ASSIGNEES;
  }
  return VALID_ASSIGNEES;
}

/**
 * TEAM-4100 F2 (layer 2, best-effort create-time check) — the set of assignees a
 * validated ticket plan authorized for a workflow. Twin of the DynamoDB tickets
 * Lambda's planAssigneeSet: the plan is persisted by workflow-output
 * submitTicketPlan at shared/ticket-plan.json in the SAME bucket this Lambda
 * already reads the roster from (one cheap GetObject, no new IAM). Returns null
 * when no plan exists or on any read/parse failure — fails OPEN because the
 * orchestrator's realized-graph gate (layer 1) is the hard gate.
 */
async function planAssigneeSet(workflowId) {
  if (!workflowId || !ARTIFACT_BUCKET) return null;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: `workflows/${workflowId}/shared/ticket-plan.json`,
    }));
    const plan = JSON.parse(await res.Body.transformToString());
    const tickets = Array.isArray(plan?.tickets) ? plan.tickets : [];
    const set = new Set();
    for (const t of tickets) {
      const a = typeof t?.assignee === "string" ? t.assignee.trim() : "";
      if (a) set.add(a);
    }
    return set.size > 0 ? set : null;
  } catch {
    return null; // no plan persisted / unreadable → no create-time check
  }
}

// ─── Status Mapping ──────────────────────────────────────────────────────────

const INTERNAL_TO_JIRA = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

const JIRA_TO_INTERNAL = Object.fromEntries(
  Object.entries(INTERNAL_TO_JIRA).map(([k, v]) => [v.toLowerCase(), k])
);

function mapStatusToInternal(jiraStatus) {
  return JIRA_TO_INTERNAL[jiraStatus.toLowerCase()] || jiraStatus.toLowerCase().replace(/\s+/g, "_");
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

async function jiraFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (resp.status === 204) return null;

  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!resp.ok) {
    // Surface EVERYTHING Jira says — errorMessages, field errors, or the raw
    // body. (A precedence bug here (`a || b ? x : y`) used to reduce real JQL
    // errors to "400: {}", leaving agents unable to self-correct queries.)
    const parts = [];
    if (Array.isArray(body?.errorMessages) && body.errorMessages.length) parts.push(body.errorMessages.join("; "));
    if (body?.errors && Object.keys(body.errors).length) parts.push(JSON.stringify(body.errors));
    const msg = parts.join(" | ") || (typeof body === "string" ? body : JSON.stringify(body));
    throw new Error(`Jira API ${resp.status}: ${msg}`);
  }
  return body;
}

async function jiraSearch(jql, fields = ["summary", "status", "labels", "assignee", "issuetype", "parent"], maxResults = 50) {
  const params = new URLSearchParams({ jql, fields: fields.join(","), maxResults: String(maxResults) });
  return jiraFetch(`/rest/api/3/search/jql?${params.toString()}`);
}

/**
 * Resolve a human-review reviewer reference ("<email | display name | accountId>")
 * to a real Jira accountId so the gate ticket can be assigned to that person —
 * which makes Jira notify them natively. Returns null if no assignable user
 * matches (caller falls back to label-only). Matches against users assignable in
 * the project so we never assign someone who can't act on the ticket.
 */
async function resolveReviewerAccountId(ref) {
  if (!ref) return null;
  // Already an accountId (Jira account ids contain a ':' or are 24-hex)?
  if (ref.includes(":")) return ref;
  try {
    const q = encodeURIComponent(ref);
    const users = await jiraFetch(
      `/rest/api/3/user/assignable/search?project=${PROJECT_KEY}&query=${q}&maxResults=5`
    );
    if (!Array.isArray(users) || users.length === 0) return null;
    const lref = ref.toLowerCase();
    const exact = users.find(
      (u) => (u.emailAddress || "").toLowerCase() === lref ||
             (u.displayName || "").toLowerCase() === lref
    );
    return (exact || users[0]).accountId || null;
  } catch (err) {
    console.log(`[jira-tools] reviewer resolve failed for "${ref}": ${err.message}`);
    return null;
  }
}

/**
 * List human reviewers available in the project, each tagged with the Jira
 * project ROLES they hold (Designer, Developer, QA & CI, ...). Roles are the
 * domain mapping: the orchestrator filters this roster to a gate's phase so the
 * intake agent picks a real, domain-appropriate person. 100% API-driven — no
 * config of names. Returns [{ accountId, displayName, email, roles[] }].
 */
async function listReviewers(params = {}) {
  // 1. Assignable users in the project (only people who can actually own a ticket).
  const users = await jiraFetch(
    `/rest/api/3/user/assignable/search?project=${PROJECT_KEY}&maxResults=200`
  );
  const byId = new Map();
  for (const u of Array.isArray(users) ? users : []) {
    if (u.accountType && u.accountType !== "atlassian") continue; // skip app/customer accts
    byId.set(u.accountId, {
      accountId: u.accountId,
      displayName: u.displayName,
      email: u.emailAddress || null,
      roles: [],
    });
  }

  // 2. Tag each user with the project roles they belong to (= their domains).
  try {
    const roleMap = await jiraFetch(`/rest/api/3/project/${PROJECT_KEY}/role`);
    for (const [roleName, roleUrl] of Object.entries(roleMap || {})) {
      const roleId = String(roleUrl).split("/").pop();
      try {
        const detail = await jiraFetch(`/rest/api/3/project/${PROJECT_KEY}/role/${roleId}`);
        for (const actor of detail.actors || []) {
          const accId = actor.actorUser?.accountId;
          if (accId && byId.has(accId)) byId.get(accId).roles.push(roleName);
        }
      } catch { /* skip unreadable role */ }
    }
  } catch (err) {
    console.log(`[jira-tools] role tagging failed: ${err.message}`);
  }

  let reviewers = [...byId.values()];

  // Optional role filter (orchestrator passes the gate's domain → e.g. "Designer").
  if (params.role) {
    const want = String(params.role).toLowerCase();
    reviewers = reviewers.filter((r) => r.roles.some((rn) => rn.toLowerCase().includes(want)));
  }
  return { reviewers };
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function createTicket(params, { caller } = {}) {
  const { summary, description, parent_key, assignee, issue_type, blocked_by, workflow_id, spawned_by, phase } = params;

  // TEAM-4100 F5 — a fix ticket's stable finding id (sha1(originTicketId+component)).
  // Present only on orchestrator-spawned fix tickets; drives the finding-label dedupe.
  const findingId =
    spawned_by && typeof spawned_by === "object" && typeof spawned_by.findingId === "string" && spawned_by.findingId
      ? spawned_by.findingId
      : null;

  // Validate assignee against known roster — reject hallucinated agent names.
  // "human:<who>" assignees are human-review gates, not agents, and are always
  // allowed (the orchestrator parks them for a person instead of invoking).
  const isHumanReviewer = typeof assignee === "string" && assignee.startsWith("human:");
  if (assignee && !isHumanReviewer && !VALID_ASSIGNEES.has(assignee)) {
    const valid = [...VALID_ASSIGNEES].join(", ");
    throw new Error(
      `Invalid assignee "${assignee}". Valid agents: ${valid}. ` +
      `Note: There is NO "agentcore_hub_ios_dev" agent. ALL iOS/SwiftUI/Android/Web development goes to "agentcore_hub_frontend_dev".`
    );
  }

  // TEAM-4100 F2 (layer 2) — when a validated plan exists for this workflow, the
  // analyst may only create AGENT tickets for assignees the plan authorized.
  // Trusted server-side callers (orchestrator fix/re-verify spawns, console,
  // telegram) bypass; human gates (human:*) and no-plan runs are not checked.
  // Layer 1 (the orchestrator realized-graph gate) remains the hard gate.
  if (!caller && assignee && !isHumanReviewer) {
    const planSet = await planAssigneeSet(workflow_id);
    if (planSet && !planSet.has(assignee)) {
      throw new Error(
        `TICKET_NOT_IN_PLAN — assignee "${assignee}" is not in the validated ticket plan ` +
        `for ${workflow_id}. The plan authorizes: ${[...planSet].sort().join(", ")}. ` +
        `Update and resubmit the plan (submit_ticket_plan) before creating tickets for a new assignee.`
      );
    }
  }

  // ─── F5: fix-ticket uniqueness on (workflow, findingId) ────────────────────
  // Two verifier completions with the same finding can race spawnFixTicketsFromFindings
  // and both reach create. Jira has NO conditional create (unlike the DynamoDB
  // twin's atomic dedupe item), so the strongest available guarantee is a
  // deterministic `finding:<fid>` label matched by search-before-create: it kills
  // the fuzzy-summary false-negatives and makes any retry converge on the same
  // ticket. A sub-second true race can still double-create under Jira's
  // eventually-consistent search index — a documented Jira limitation, not the
  // DynamoDB twin's behaviour. Checked first (more precise than summary matching).
  if (findingId && workflow_id) {
    try {
      const jql =
        `project = ${PROJECT_KEY} AND labels = "wf:${workflow_id}" AND labels = "finding:${findingId}" ORDER BY created ASC`;
      const found = await jiraSearch(jql, ["summary", "status", "labels", "assignee", "issuetype", "parent"], 2);
      const live = (found.issues || []).find((iss) => {
        const internal = mapStatusToInternal(iss.fields?.status?.name || "");
        return internal !== "done" && internal !== "closed";
      });
      if (live) {
        const dupBlockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
        await reconcileBlockersAndStatus(live.key, dupBlockers, assignee);
        console.log(`[jira-tools] DEDUPED fix finding ${findingId} in ${workflow_id} → existing ${live.key} (reconciled)`);
        return { ...mapIssue(live), deduped: true, deduplicated: true };
      }
    } catch (err) {
      console.warn(`[jira-tools] finding dedupe check failed (proceeding to create): ${err.message}`);
    }
  }

  // ─── Idempotency guard ───────────────────────────────────────────────────
  // create_ticket has no natural idempotency, so any repeat (a model retry, an
  // agentic-loop replay, a redelivered invocation) silently creates a full
  // duplicate ticket plan. Before creating, look for an existing ticket in the
  // same workflow with the same summary + assignee; if found, return it instead
  // of making a copy. Keyed on the wf:<id> label so it only dedupes within a run.
  if (workflow_id && summary) {
    try {
      const jql = `project = ${PROJECT_KEY} AND labels = "wf:${workflow_id}" AND summary ~ "\\"${summary.replace(/"/g, '\\"')}\\"" ORDER BY created ASC`;
      const existingSearch = await jiraSearch(jql, ["summary", "status", "labels", "assignee", "issuetype", "parent"], 5);
      const wantAgentLabel = assignee && !isHumanReviewer ? `agent:${assignee}` : null;
      const wantReviewerLabel = isHumanReviewer ? `reviewer:${assignee.slice("human:".length)}` : null;
      // Normalize so cosmetic rewordings of the SAME planned ticket dedupe:
      // trim, collapse internal whitespace, lowercase, drop a trailing period.
      // (A full re-plan with materially different titles is caught upstream by
      // the analyst's list-first/verify-after step, not here.)
      const normSummary = (s) =>
        (s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/\.$/, "");
      const wantSummary = normSummary(summary);
      // A same-summary ticket that is already Done/Closed must NOT be treated as
      // a duplicate. Escalation gates (e.g. "ship-review not converging") are
      // recreated on purpose; if we returned the prior, resolved gate its stale
      // "DECISION: continue" comment gets re-parsed and the round cap resets
      // forever without a fresh human decision. A terminal status → create anew.
      const isDoneStatus = (iss) => {
        const internal = mapStatusToInternal(iss.fields?.status?.name || "");
        return internal === "done" || internal === "closed";
      };
      const dup = (existingSearch.issues || []).find((iss) => {
        if (isDoneStatus(iss)) return false; // completed gate is not a live duplicate
        if (normSummary(iss.fields?.summary) !== wantSummary) return false; // summary ~ is fuzzy; require normalized-exact
        const labs = iss.fields?.labels || [];
        if (wantAgentLabel) return labs.includes(wantAgentLabel);
        if (wantReviewerLabel) return labs.includes(wantReviewerLabel);
        return true; // no assignee to disambiguate — same summary in same run is a dup
      });
      if (dup) {
        // The original invocation may have been interrupted after the issue was
        // created but before its blocker links + initial status were set. If we
        // returned the bare dup now, the orchestrator would see a ticket missing
        // the dependencies/state it relies on and could run or wedge it early.
        // Reconcile (idempotently) before returning.
        const dupBlockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
        await reconcileBlockersAndStatus(dup.key, dupBlockers, assignee);
        console.log(`[jira-tools] IDEMPOTENT: "${summary}" (${assignee || "unassigned"}) already exists as ${dup.key} in ${workflow_id} — reconciled blockers/status, returning existing instead of duplicating.`);
        return { ...mapIssue(dup), deduplicated: true };
      }
    } catch (err) {
      // Never let the dedupe check block creation — fail open.
      console.warn(`[jira-tools] idempotency check failed (proceeding to create): ${err.message}`);
    }
  }
  // ─── End idempotency guard ─────────────────────────────────────────────────

  // Assignee is carried as a label (Jira's assignee field needs an accountId).
  // Human-review gates use a "reviewer:<who>" label + a "human-review" marker so
  // the orchestrator recognizes them and parks instead of invoking an agent.
  const labels = [];
  if (isHumanReviewer) {
    labels.push("human-review");
    labels.push(`reviewer:${assignee.slice("human:".length)}`);
  } else if (assignee) {
    labels.push(`agent:${assignee}`);
  }
  if (workflow_id) labels.push(`wf:${workflow_id}`);
  // F5 — the deterministic dedupe key for fix tickets (see the finding guard above).
  if (findingId) labels.push(`finding:${findingId}`);

  // Normalize common LLM variations of issue type names to Jira's canonical form
  const ISSUE_TYPE_ALIASES = {
    "subtask": "Subtask",
    "sub-task": "Subtask",
    "sub task": "Subtask",
    "task": "Task",
    "story": "Story",
    "epic": "Epic",
    "bug": "Bug",
  };
  const requestedType = (issue_type || "Task").toString().trim();
  let canonicalType = ISSUE_TYPE_ALIASES[requestedType.toLowerCase()] || requestedType;

  // Jira forbids a Subtask whose parent is an Epic (subtasks may only live under
  // standard issue types). Intake agents plan phase tickets as children of the
  // run's Epic, so a Subtask request there is always invalid — Jira 400s it, the
  // agent then retries WITHOUT a parent, and the resulting orphan is invisible to
  // both the orchestrator's epic->children unblock cascade and the nudge/unstick
  // tool, wedging the whole run. Coerce Subtask->Task when the parent is an Epic
  // so the ticket is created correctly as an Epic child on the first try.
  if (canonicalType === "Subtask" && parent_key) {
    try {
      const parent = await jiraFetch(`/rest/api/3/issue/${parent_key}?fields=issuetype`);
      const parentType = (parent?.fields?.issuetype?.name || "").toLowerCase();
      if (parentType === "epic") {
        console.log(`[jira-tools] parent ${parent_key} is an Epic — coercing Subtask -> Task (Jira forbids subtask-of-Epic) so the child isn't orphaned.`);
        canonicalType = "Task";
      }
    } catch (err) {
      // Can't confirm parent type — coerce anyway; an orphan is worse than a Task.
      console.warn(`[jira-tools] could not read parent ${parent_key} issuetype (${err.message}); coercing Subtask -> Task to avoid orphaning.`);
      canonicalType = "Task";
    }
  }

  const fields = {
    project: { key: PROJECT_KEY },
    summary,
    issuetype: { name: canonicalType },
    labels,
  };

  // Human-review gate: assign the ticket to a REAL Jira user so they're notified
  // natively. The reviewer:<who> label still drives the orchestrator/UI; this
  // additionally sets Jira's assignee field when <who> resolves to a project
  // user. Unresolvable → label-only (no hard failure).
  if (isHumanReviewer) {
    const reviewerRef = assignee.slice("human:".length);
    const accountId = await resolveReviewerAccountId(reviewerRef);
    if (accountId) {
      fields.assignee = { accountId };
      console.log(`[jira-tools] review gate assigned to ${reviewerRef} (${accountId})`);
    } else {
      console.log(`[jira-tools] reviewer "${reviewerRef}" not assignable in ${PROJECT_KEY} — label-only`);
    }
  }

  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }

  if (parent_key) {
    fields.parent = { key: parent_key };
  }

  // 1. Create in Jira. If the type/parent combo is still rejected, retry ONCE as
  // a Task while KEEPING the parent — never drop the parent, since an orphaned
  // ticket silently breaks the unblock cascade. Only drop the parent as a last
  // resort if even the parented Task is refused.
  let created;
  try {
    created = await jiraFetch("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    const isTypeParentErr = /issuetype|parent|subtask|hierarchy/i.test(err.message || "");
    if (!isTypeParentErr || fields.issuetype.name === "Task") throw err;
    console.warn(`[jira-tools] create failed (${err.message}); retrying as Task with parent ${parent_key} kept.`);
    fields.issuetype = { name: "Task" };
    try {
      created = await jiraFetch("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
    } catch (err2) {
      console.error(`[jira-tools] parented Task retry also failed (${err2.message}); creating parentless as last resort — this ticket will need manual linking.`);
      delete fields.parent;
      created = await jiraFetch("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields }),
      });
    }
  }

  const ticketId = created.key;

  // 2 + 3. Link blockers and set the initial status. Shared with the dedup path
  // so an interrupted-then-retried create still ends up fully wired.
  const blockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
  const status = await reconcileBlockersAndStatus(ticketId, blockers, assignee);

  // TEAM-3991 D2.2 — the parked→fix edge, the Jira twin of the DynamoDB tickets
  // Lambda's blockedBy append: a fix ticket BLOCKS the origin it answers, so the
  // origin can't be re-dispatched (or closed) while the fix is open.
  await linkFixToOrigin(ticketId, spawned_by, phase);

  console.log(`[jira-tools] Created ${ticketId} in Jira. Status: ${status}`);
  return { ticketId, status, message: `Created ${ticketId}: ${summary}` };
}

/**
 * TEAM-3991 D2.2 — link a fix ticket so it BLOCKS the origin ticket that filed it
 * (same link type/direction as reconcileBlockersAndStatus: inward blocks
 * outward, so inward = the fix, outward = the origin). Jira dedupes issue links
 * by (type, pair), so a retried create converges. Best-effort: a link failure
 * must never fail the create.
 */
const FIX_ORIGIN_KEYS = ["gateTicketId", "qaTicketId", "codexTicketId"];

async function linkFixToOrigin(fixTicketId, spawnedBy, phase) {
  if (!spawnedBy || typeof spawnedBy !== "object") return false;
  const originId = FIX_ORIGIN_KEYS.map((k) => spawnedBy[k]).find((v) => typeof v === "string" && v);
  if (!originId || originId === fixTicketId) return false;
  try {
    await jiraFetch("/rest/api/3/issueLink", {
      method: "POST",
      body: JSON.stringify({
        type: { name: "Blocks" },
        inwardIssue: { key: fixTicketId },
        outwardIssue: { key: originId },
      }),
    });
    console.log(`[jira-tools] ${fixTicketId} (${spawnedBy.kind || "fix"}${phase ? `, phase ${phase}` : ""}) now blocks origin ${originId}`);
    return true;
  } catch (err) {
    console.log(`Warning: could not link fix ${fixTicketId} -> origin ${originId}: ${err.message}`);
    return false;
  }
}

// Bring a ticket to its intended blocker-links + initial status. Idempotent:
// safe to call on a freshly created ticket OR on one found via the dedup path
// whose original setup may have been interrupted. Jira issue links dedupe by
// (type, pair), and re-issuing a transition to the current status is a no-op,
// so repeated calls converge without side effects.
//   - blockers present → link each + transition to "Blocked" (prevents a
//     premature "Ready" webhook before dependencies are done)
//   - no blockers + has assignee → transition to "Ready" (tells orchestrator to
//     invoke)
async function reconcileBlockersAndStatus(ticketId, blockers, assignee) {
  for (const blockerKey of blockers) {
    try {
      await jiraFetch("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({
          type: { name: "Blocks" },
          inwardIssue: { key: blockerKey },
          outwardIssue: { key: ticketId },
        }),
      });
    } catch (err) {
      console.log(`Warning: could not link blocker ${blockerKey} -> ${ticketId}: ${err.message}`);
    }
  }

  const status = blockers.length > 0 ? "blocked" : "todo";
  if (blockers.length > 0) {
    try {
      const transitions = await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`);
      const blockedTransition = transitions.transitions.find(
        (t) => t.name.toLowerCase() === "blocked" || t.to.name.toLowerCase() === "blocked"
      );
      if (blockedTransition) {
        await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: blockedTransition.id } }),
        });
      } else {
        console.warn(`[jira-tools] No "Blocked" transition available for ${ticketId} — ticket stays in To Do. Orchestrator blockedBy guard will prevent premature invocation.`);
      }
    } catch (err) {
      console.warn(`[jira-tools] Could not transition ${ticketId} to Blocked: ${err.message}`);
    }
  } else if (assignee) {
    try {
      const transitions = await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`);
      const readyTransition = transitions.transitions.find(
        (t) => t.name.toLowerCase() === "ready" || t.to.name.toLowerCase() === "ready"
      );
      if (readyTransition) {
        await jiraFetch(`/rest/api/3/issue/${ticketId}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: readyTransition.id } }),
        });
      }
    } catch (err) {
      console.log(`[jira-tools] Could not transition ${ticketId} to Ready: ${err.message}`);
    }
  }
  return status;
}

/**
 * TEAM-3992 D3.2 — add Blocks links so `ticket_id` is blocked_by each id in
 * `blocked_by` (the DynamoDB twin's add_blockers op). Same link type/direction as
 * reconcileBlockersAndStatus: inward blocks outward, so inward = the blocker,
 * outward = ticket_id. Jira dedupes issue links by (type, pair), so a retried
 * call converges — no explicit already-linked probe needed. Minimal: link only,
 * no status transition (the ship ticket already carries its own status).
 */
async function addBlockers(params) {
  const { ticket_id } = params;
  const blockers = Array.isArray(params.blocked_by)
    ? params.blocked_by
    : params.blocked_by
      ? [params.blocked_by]
      : [];
  if (!ticket_id) throw new Error("add_blockers requires ticket_id");
  if (blockers.length === 0) throw new Error("add_blockers requires a non-empty blocked_by");

  const added = [];
  for (const blockerKey of blockers) {
    if (!blockerKey || blockerKey === ticket_id) continue;
    try {
      await jiraFetch("/rest/api/3/issueLink", {
        method: "POST",
        body: JSON.stringify({
          type: { name: "Blocks" },
          inwardIssue: { key: blockerKey },
          outwardIssue: { key: ticket_id },
        }),
      });
      added.push(blockerKey);
    } catch (err) {
      console.log(`Warning: could not link blocker ${blockerKey} -> ${ticket_id}: ${err.message}`);
    }
  }
  return { status: "ok", ticket_id, added };
}

async function transitionTicket(params, { caller = null } = {}) {
  const { ticket_id, transition_id, reason } = params;

  const targetStatus = transition_id;
  const jiraStatusName = INTERNAL_TO_JIRA[targetStatus] || targetStatus;

  // Handle "skip" as transition to Done
  const isSkip = targetStatus === "skip";
  const effectiveStatus = isSkip ? "Done" : jiraStatusName;

  // One read serves both gate checks: `labels` says whether this is a human-review
  // gate, `status` says whether we are taking it out of In Review. Skipped entirely
  // for a trusted caller that is not targeting In Review, so the common
  // agent transition (its own ticket → Done) still costs no extra Jira call.
  const targetsInReview = jiraStatusName.toLowerCase() === "in review";
  let gateLabels = [];
  let currentStatusName = "";
  if (targetsInReview || !caller) {
    const issue = await jiraFetch(`/rest/api/3/issue/${ticket_id}?fields=labels,status`);
    gateLabels = issue?.fields?.labels || [];
    currentStatusName = String(issue?.fields?.status?.name || "");
  }
  const isHumanGate = gateLabels.some((l) => l.startsWith("reviewer:"));

  // in_review is reserved for human-review-gate tickets (reviewer:<who> label).
  // An agent ticket parked there is never invoked → the workflow stalls. Reject.
  if (targetsInReview && !isHumanGate) {
    throw new Error(`Cannot move ${ticket_id} to In Review: only human-review tickets can be sent to review.`);
  }

  // TEAM-4099 F3 — authz floor, mirror of the dynamodb twin
  // (lambda/agentcore-hub-tickets/index.mjs). Moving a human-review gate OUT of In
  // Review, or to a terminal Done (including `skip`), IS the reviewer's decision.
  // The tool path has no caller identity, so without a trusted marker any agent
  // could sign off its own merge gate — and gate-bypass.mjs would then read that
  // status as the approval. Gate decisions come from the console/Telegram only,
  // where they are also written to the gate ledger.
  if (isHumanGate && !caller &&
      (currentStatusName.toLowerCase() === "in review" || effectiveStatus.toLowerCase() === "done")) {
    throw new Error(
      `Cannot transition ${ticket_id}: it is a human-review gate (${gateLabels.filter((l) => l.startsWith("reviewer:")).join(", ")}) ` +
      `and "${transition_id}" is that reviewer's decision to make. Gate decisions are only accepted from the ` +
      `console or Telegram, where they are recorded in the gate ledger. Report your work and leave the gate alone — ` +
      `moving it yourself does not approve anything.`
    );
  }

  // Add the reason as a comment BEFORE the transition. The transition fires the
  // status webhook → orchestrator rejection handler reads the latest comment;
  // commenting first avoids a race where rework starts before the feedback lands.
  if (reason) {
    await addComment({ ticket_id, comment: isSkip ? `Skipped: ${reason}` : reason });
  }

  // Transition in Jira
  const data = await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`);
  const match = data.transitions.find(
    (t) => t.name.toLowerCase() === effectiveStatus.toLowerCase() ||
           t.to.name.toLowerCase() === effectiveStatus.toLowerCase()
  );

  if (!match) {
    const available = data.transitions.map((t) => `${t.name} (-> ${t.to.name})`).join(", ");
    throw new Error(`No transition to "${effectiveStatus}" found. Available: ${available}`);
  }

  await jiraFetch(`/rest/api/3/issue/${ticket_id}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  const finalStatus = isSkip ? "done" : mapStatusToInternal(match.to.name);
  console.log(`[jira-tools] Transitioned ${ticket_id} to ${finalStatus} in Jira`);
  return { ticketId: ticket_id, status: finalStatus, message: `Transitioned to ${finalStatus}` };
}

async function updateTicket(params) {
  const { ticket_id, description, title } = params;

  const fields = {};
  if (title) fields.summary = title;
  if (description) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: description }] }],
    };
  }

  await jiraFetch(`/rest/api/3/issue/${ticket_id}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });

  return { ticketId: ticket_id, message: "Updated" };
}

async function listTickets(params) {
  const { parent_id } = params;
  const jql = `parent = ${parent_id} ORDER BY created ASC`;

  const data = await jiraSearch(jql, ["summary", "status", "labels", "assignee", "issuetype"], 100);
  const tickets = (data.issues || []).map(mapIssue);
  return { tickets };
}

async function addComment(params) {
  const { ticket_id, comment } = params;

  await jiraFetch(`/rest/api/3/issue/${ticket_id}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
      },
    }),
  });

  return { ticketId: ticket_id, message: "Comment added" };
}

async function searchIssues(params) {
  // Accept `jql` as an alias — agents regularly pass it and used to get an
  // opaque 400 (empty jql param) back.
  const { query, jql, max_results } = params;
  const q = query || jql;
  if (!q) throw new Error("search_issues requires a `query` (JQL string)");
  const data = await jiraSearch(q, ["summary", "status", "labels", "assignee", "issuetype", "parent"], max_results || 50);
  const tickets = (data.issues || []).map(mapIssue);
  return { tickets };
}

export async function getIssue(params) {
  // Accept both `issue_key` (agent-facing tool schema) and `ticket_id` (the
  // gateway tool schema for Tickets___get_issue exposes ONLY ticket_id). Without
  // this, a schema-conforming gateway-direct call hits Jira with `undefined`.
  const issue_key = params.issue_key || params.ticket_id;
  if (!issue_key) {
    throw new Error("get_issue requires an issue_key (or ticket_id)");
  }
  // Read only the fields mapIssue needs. Comments are NOT requested here: the
  // embedded `comment` container paginates ASCENDING, so on long threads the
  // NEWEST comments (where the release manager's DECISION lives) get cut off.
  const query = new URLSearchParams({
    fields: "summary,status,labels,assignee,issuetype,parent",
  });
  const issue = await jiraFetch(`/rest/api/3/issue/${issue_key}?${query.toString()}`);

  // Fetch comments via the dedicated endpoint newest-first so the latest/decision
  // comments are always in the first page, then reverse to chronological
  // (oldest→newest) — callers parse the LAST matching DECISION line, so ordering
  // matters. Comments are supplementary context: if the fetch fails, log and
  // return comments: [] rather than failing the whole getIssue.
  let comments = [];
  try {
    const commentQuery = new URLSearchParams({ orderBy: "-created", maxResults: "50" });
    const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/comment?${commentQuery.toString()}`);
    comments = (data?.comments || [])
      .map((c) => ({
        author: c.author?.displayName || null,
        body: adfToText(c.body),
        created: c.created,
      }))
      .reverse();
  } catch (err) {
    console.log(`[jira-tools] could not fetch comments for ${issue_key}: ${err.message}`);
  }

  return { ...mapIssue(issue), comments };
}

async function getTransitions(params) {
  const { issue_key } = params;
  const data = await jiraFetch(`/rest/api/3/issue/${issue_key}/transitions`);
  const transitions = data.transitions.map((t) => ({
    id: t.id,
    name: t.name,
    to: t.to.name,
    toInternal: mapStatusToInternal(t.to.name),
  }));
  return { issue_key, transitions };
}

async function listProjects() {
  const data = await jiraFetch("/rest/api/3/project/search?maxResults=50");
  const projects = (data.values || []).map((p) => ({
    key: p.key,
    name: p.name,
    id: p.id,
  }));
  return { projects };
}

async function getProjectIssueTypes() {
  return {
    issueTypes: [
      { name: "Epic", description: "A large body of work" },
      { name: "Story", description: "User-facing feature" },
      { name: "Task", description: "A unit of work" },
      { name: "Bug", description: "A defect to fix" },
    ],
  };
}

async function lookupUser(params) {
  const { query } = params;
  const jql = `project = ${PROJECT_KEY} AND labels in ("agent:${query}") ORDER BY created DESC`;

  try {
    const data = await jiraSearch(jql, ["labels"], 1);
    const agents = new Set();
    for (const issue of data.issues || []) {
      for (const label of issue.fields.labels || []) {
        if (label.startsWith("agent:") && label.toLowerCase().includes(query.toLowerCase())) {
          agents.add(label.replace("agent:", ""));
        }
      }
    }

    if (agents.size === 0) {
      const broadJql = `project = ${PROJECT_KEY} AND labels is not EMPTY ORDER BY created DESC`;
      const broadData = await jiraSearch(broadJql, ["labels"], 50);
      for (const issue of broadData.issues || []) {
        for (const label of issue.fields.labels || []) {
          if (label.startsWith("agent:") && label.toLowerCase().includes(query.toLowerCase())) {
            agents.add(label.replace("agent:", ""));
          }
        }
      }
    }

    return { users: [...agents].map((name) => ({ name, type: "agent" })) };
  } catch (err) {
    console.log(`lookupUser error: ${err.message}`);
    return { users: [], message: `No agents found matching "${query}"` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Flatten an Atlassian Document Format (ADF) node tree to plain text. Comment
// bodies come back as ADF; agents want readable text. Plain strings pass
// through unchanged.
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  // A hardBreak (Shift+Enter inside a comment) is a logical line break with no
  // content — without this it flattens to "" and two lines merge into one, which
  // can silently join an isolated `DECISION:` line to its rationale.
  if (node.type === "hardBreak") return "\n";
  const inner = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  // Block-level nodes each end on their own line so every logical line in the ADF
  // doc lands on its own line in the flattened text (the release manager parses an
  // isolated `DECISION: <value>` line). The endsWith guard avoids gratuitous double
  // blank lines when a block already ends in a newline (e.g. a listItem whose only
  // child is a paragraph that already added its own trailing "\n").
  if (BLOCK_NODES.has(node.type)) {
    return inner.endsWith("\n") ? inner : `${inner}\n`;
  }
  return inner;
}

// Block-level ADF node types that should each terminate a line when flattened.
// bulletList/orderedList are intentionally omitted: their separation comes from
// each child listItem's trailing newline, so listing them here would only add
// blank lines between lists.
const BLOCK_NODES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "codeBlock",
]);

function mapIssue(issue) {
  const fields = issue.fields || {};
  const labels = fields.labels || [];
  const agentLabel = labels.find((l) => l.startsWith("agent:"));
  const reviewerLabel = labels.find((l) => l.startsWith("reviewer:"));
  const wfLabel = labels.find((l) => l.startsWith("wf:"));

  // Agent tickets: "agent:<id>". Human-review gates: "reviewer:<who>" →
  // "human:<who>" (matches the orchestrator + TS mappers).
  const assignee = agentLabel
    ? agentLabel.replace("agent:", "")
    : reviewerLabel
    ? `human:${reviewerLabel.replace("reviewer:", "")}`
    : fields.assignee?.displayName || null;

  return {
    ticketId: issue.key,
    title: fields.summary || "",
    status: mapStatusToInternal(fields.status?.name || "To Do"),
    assignee,
    issueType: fields.issuetype?.name || "Task",
    parentKey: fields.parent?.key || null,
    workflowId: wfLabel ? wfLabel.replace("wf:", "") : null,
    labels,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const TOOLS = {
  Tickets___create_ticket: createTicket,
  Tickets___transition_ticket: transitionTicket,
  Tickets___update_ticket: updateTicket,
  Tickets___list_tickets: listTickets,
  Tickets___add_comment: addComment,
  Tickets___search_issues: searchIssues,
  Tickets___get_issue: getIssue,
  Tickets___get_transitions: getTransitions,
  Tickets___list_projects: listProjects,
  Tickets___get_project_issue_types: getProjectIssueTypes,
  Tickets___lookup_user: lookupUser,
  Tickets___list_reviewers: listReviewers,
  Tickets___add_blockers: addBlockers,
  // Backward compat: accept old prefix during transition
  JiraIntegration___create_ticket: createTicket,
  JiraIntegration___transition_ticket: transitionTicket,
  JiraIntegration___update_ticket: updateTicket,
  JiraIntegration___list_tickets: listTickets,
  JiraIntegration___add_comment: addComment,
  JiraIntegration___search_issues: searchIssues,
  JiraIntegration___get_issue: getIssue,
  JiraIntegration___get_transitions: getTransitions,
  JiraIntegration___list_projects: listProjects,
  JiraIntegration___get_project_issue_types: getProjectIssueTypes,
  JiraIntegration___lookup_user: lookupUser,
  JiraIntegration___list_reviewers: listReviewers,
};

/**
 * TEAM-4099 F3 — the callers allowed to DECIDE a human-review gate. Twin of the
 * dynamodb Lambda's guard (lambda/agentcore-hub-tickets/index.mjs); see the long
 * rationale there. Read from the event ROOT and only when the tool arguments came
 * in NESTED under `parameters`, which is the only shape this handler accepts — an
 * agent owns the argument object, never the envelope around it.
 */
const TRUSTED_CALLERS = new Set(["console", "telegram", "orchestrator"]);

function trustedCallerOf(event) {
  if (!event?.parameters || typeof event.parameters !== "object") return null;
  return TRUSTED_CALLERS.has(event?._caller) ? event._caller : null;
}

export const handler = async (event) => {
  // Load roster from S3 on first invocation (cached for warm starts)
  await loadValidAssignees();

  const toolName = event.tool_name;
  const params = event.parameters || {};

  console.log(`[jira-tools] tool=${toolName} params=${JSON.stringify(params)}`);

  const fn = TOOLS[toolName];
  if (!fn) {
    console.log(`[jira-tools] Unknown tool: ${toolName}`);
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    const result = await fn(params, { caller: trustedCallerOf(event) });
    console.log(`[jira-tools] tool=${toolName} result=${JSON.stringify(result).slice(0, 500)}`);
    return result;
  } catch (err) {
    console.error(`[jira-tools] tool=${toolName} ERROR: ${err.message}`);
    return { error: err.message };
  }
};
