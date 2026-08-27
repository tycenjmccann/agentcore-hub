// CLOSED hermetic stub tool registry (design §7.2, security review HERM-2).
// The model gets Converse toolSpecs; executors record (tool, argsDigest) into
// the trajectory and return plausible canned payloads shaped like the real
// tools in deploy/runtime-agent/main.py. Anything not defined here does not
// exist for the agent — there is no passthrough. Network/exec-capable tools
// are FORBIDDEN and must never appear in the registry (self-tested by
// run-battery.mjs before any case runs).

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";

export const FORBIDDEN_TOOLS = Object.freeze([
  // exec / env / network / retrieval — hermeticity breakers
  "shell",
  "environment",
  "http_request",
  "browser",
  "retrieve",
  "code_interpreter",
  "python_repl",
  "download_s3_file",
  "image_reader",
  // GitHub MCP / git-push surface — nothing in the battery may touch a real repo
  "create_branch",
  "create_or_update_file",
  "create_pull_request",
  "push_files",
  "get_file_contents",
  "get_me",
  "list_branches",
  "search_code",
  "search_repositories",
]);

const digest = (obj) =>
  createHash("sha256").update(JSON.stringify(obj ?? {})).digest("hex").slice(0, 12);

const spec = (name, description, properties = {}, required = []) => ({
  toolSpec: {
    name,
    description,
    inputSchema: { json: { type: "object", properties, required } },
  },
});

const str = (description) => ({ type: "string", description });

export function createRegistry({ caseDef, repoRoot, workspaceDir }) {
  const trajectory = [];
  const tickets = [];
  let nextTicket = 901; // fake keys BATT-9xx
  const s3 = new Map(); // in-memory object store seeded from fixtures

  // Seed fixture files into the in-memory S3 (under shared/inputs/) AND the
  // /tmp workspace so both S3Storage___read_object and file_read find them.
  const fixtureRefs = [
    ...(caseDef.input?.files || []),
    ...(caseDef.input?.transcript ? [caseDef.input.transcript] : []),
  ];
  for (const ref of fixtureRefs) {
    const abs = join(repoRoot, "evals", "battery", ref);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    s3.set(`shared/inputs/${basename(ref)}`, content);
    const dest = join(workspaceDir, basename(ref));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }

  const inWorkspace = (p) => {
    const abs = resolve(workspaceDir, p);
    if (!abs.startsWith(resolve(workspaceDir))) {
      throw new Error(`path '${p}' escapes the case workspace — denied`);
    }
    return abs;
  };

  // name -> executor(args) => string. Return shapes mirror main.py's
  // _invoke_lambda string results closely enough for the agent to proceed.
  const executors = {
    // ── Tickets___* ──────────────────────────────────────────────────────
    Tickets___create_ticket(args) {
      const key = `BATT-${nextTicket++}`;
      tickets.push({ key, ...args });
      return JSON.stringify({
        ticket_id: key,
        status: "todo",
        summary: args.title || args.summary || "",
        assignee: args.assignee || "",
        blocked_by: args.blocked_by || [],
        message: `Created ticket ${key}`,
      });
    },
    Tickets___transition_ticket(args) {
      return JSON.stringify({
        ticket_id: args.ticket_id,
        status: args.transition_id,
        message: `Transitioned ${args.ticket_id} to ${args.transition_id}`,
      });
    },
    Tickets___update_ticket(args) {
      return JSON.stringify({ ticket_id: args.ticket_id, message: `Updated ${args.ticket_id}` });
    },
    Tickets___add_comment(args) {
      return JSON.stringify({ ticket_id: args.ticket_id, message: `Comment added to ${args.ticket_id}` });
    },
    Tickets___list_tickets(args) {
      return JSON.stringify({ parent_id: args.parent_id, tickets });
    },
    Tickets___search_issues(args) {
      return JSON.stringify({ query: args.query, results: tickets.slice(0, args.max_results || 20) });
    },

    // ── WorkflowOutput___* ───────────────────────────────────────────────
    WorkflowOutput___report_completion(args) {
      return JSON.stringify({
        ticket_id: args.ticket_id,
        message: `Completion recorded for ${args.ticket_id}; ticket transitioned to done by the orchestrator.`,
      });
    },
    WorkflowOutput___save_design_doc(args) {
      const key = `workflows/${args.workflow_id}/shared/output.md`;
      s3.set(key, args.content || "");
      return JSON.stringify({ saved: key });
    },
    WorkflowOutput___submit_ticket_plan(args) {
      return JSON.stringify({
        workflow_id: args.workflow_id,
        message:
          "Ticket plan recorded. This did NOT create tickets — call Tickets___create_ticket once per planned ticket.",
      });
    },

    // ── S3Storage___* (in-memory dict) ───────────────────────────────────
    S3Storage___list_objects(args) {
      const prefix = args.prefix || "";
      return JSON.stringify({ keys: [...s3.keys()].filter((k) => k.startsWith(prefix)) });
    },
    S3Storage___read_object(args) {
      if (s3.has(args.key)) return s3.get(args.key);
      const byName = [...s3.keys()].find((k) => k.endsWith(`/${basename(args.key)}`));
      if (byName) return s3.get(byName);
      return `ERROR: NoSuchKey: ${args.key}`;
    },
    S3Storage___write_object(args) {
      s3.set(args.key, args.content || "");
      return JSON.stringify({ written: args.key, bytes: (args.content || "").length });
    },

    // ── Blueprints: served from the WORKING TREE — this is how changed
    //    blueprints get under test (prod serves s3://.../blueprints/{name}.md).
    load_blueprint(args) {
      const name = String(args.blueprint_name || "").replace(/[^a-z0-9_-]/gi, "");
      const path = join(repoRoot, "blueprints", `${name}.md`);
      if (existsSync(path)) return readFileSync(path, "utf8");
      const available = readdirSync(join(repoRoot, "blueprints"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
      return `Blueprint '${args.blueprint_name}' not found. Available: ${available.join(", ")}`;
    },

    // ── Coding engines: canned delegation acks. Real work never happens —
    //    the judge scores whether the agent delegated correctly.
    claude_code(args) {
      return (
        "[battery-stub] Delegation recorded. claude_code session report: task received and executed as instructed — " +
        "root cause located, fix applied on the requested branch, regression test added and verified to fail on the " +
        "pre-fix code and pass on the fix. All checks exit 0. Committed and pushed to the feature branch. " +
        "[coding-artifacts: none]"
      );
    },
    codex(args) {
      return "[battery-stub] Delegation recorded. codex session report: task executed as instructed; checks exit 0.";
    },

    // ── Local files: restricted to the case's /tmp workspace ───────────
    file_read(args) {
      const abs = inWorkspace(args.path || args.file_path || "");
      return existsSync(abs) ? readFileSync(abs, "utf8") : `ERROR: file not found: ${args.path}`;
    },
    file_write(args) {
      const abs = inWorkspace(args.path || args.file_path || "");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content || "");
      return `Wrote ${(args.content || "").length} bytes`;
    },
    editor(args) {
      const abs = inWorkspace(args.path || args.file_path || "");
      if (args.command === "view" || !args.command)
        return existsSync(abs) ? readFileSync(abs, "utf8") : `ERROR: file not found: ${args.path}`;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.file_text || args.new_str || "");
      return "OK";
    },

    // ── Real but harmless ────────────────────────────────────────────────
    current_time() {
      return new Date().toISOString();
    },
    calculator(args) {
      const expr = String(args.expression || "");
      if (!/^[0-9+\-*/().%\s eE]+$/.test(expr)) return "ERROR: unsupported expression";
      try {
        return String(Function(`"use strict"; return (${expr});`)());
      } catch (err) {
        return `ERROR: ${err.message}`;
      }
    },
  };
  for (const fn of Object.values(executors)) fn.isStub = true;

  const toolSpecs = [
    spec("Tickets___create_ticket", "Create a new ticket in the project tracker.",
      { title: str("Ticket title"), description: str("Ticket description"), parent_id: str("Parent epic/story id"),
        assignee: str("Agent id to assign"), ticket_type: str("task|bug|story"),
        blocked_by: str("Comma-separated blocking ticket ids"), workflow_id: str("Workflow id") },
      ["title", "description"]),
    spec("Tickets___transition_ticket", "Transition a ticket to a new status (done, skip, blocked, in_progress, todo).",
      { ticket_id: str("Ticket id"), transition_id: str("Target status"), reason: str("Reason") },
      ["ticket_id", "transition_id"]),
    spec("Tickets___update_ticket", "Update an existing ticket's title or description.",
      { ticket_id: str("Ticket id"), description: str("New description"), title: str("New title") }, ["ticket_id"]),
    spec("Tickets___add_comment", "Add a comment to a ticket.",
      { ticket_id: str("Ticket id"), comment: str("Comment text") }, ["ticket_id", "comment"]),
    spec("Tickets___list_tickets", "List all child tickets under a parent.",
      { parent_id: str("Parent ticket id") }, ["parent_id"]),
    spec("Tickets___search_issues", "Search for tickets matching a query.",
      { query: str("Search query"), max_results: { type: "integer" } }, ["query"]),
    spec("WorkflowOutput___report_completion",
      "Report that your work is complete. Saves your summary and transitions your ticket — do NOT call Tickets___transition_ticket on your own ticket.",
      { ticket_id: str("Your assigned ticket id"), summary: str("Concise outcome summary"),
        artifacts: str("Comma-separated artifact paths"), branch: str("Git branch"), commit_sha: str("Commit sha"),
        pr_url: str("PR URL") },
      ["ticket_id", "summary"]),
    spec("WorkflowOutput___save_design_doc", "Save a design document for the workflow.",
      { workflow_id: str("Workflow id"), agent_id: str("Your agent id"), content: str("Markdown content"),
        doc_type: str("design|requirements|spec") },
      ["workflow_id", "agent_id", "content"]),
    spec("WorkflowOutput___submit_ticket_plan",
      "Persist your ticket plan. Does NOT create tickets — follow with Tickets___create_ticket per ticket.",
      { workflow_id: str("Workflow id"), epic_id: str("Epic id"), tickets: str("JSON array of ticket objects") },
      ["workflow_id", "epic_id", "tickets"]),
    spec("S3Storage___list_objects", "List objects under a prefix.", { prefix: str("Key prefix") }),
    spec("S3Storage___read_object", "Read an object.", { key: str("Object key") }, ["key"]),
    spec("S3Storage___write_object", "Write an object.",
      { key: str("Object key"), content: str("Content") }, ["key", "content"]),
    spec("load_blueprint",
      "Load a process blueprint with step-by-step workflow instructions for your role. Call this FIRST when starting a ticket.",
      { blueprint_name: str("Blueprint name, e.g. 'qa-verifier'") }, ["blueprint_name"]),
    spec("claude_code", "Delegate a coding task to the Claude Code engine (clone, edit, test, commit).",
      { task: str("The coding task"), repo: str("Repo (owner/name)"), resume_session: str("Ported session id") },
      ["task"]),
    spec("codex", "Fallback coding engine — same contract as claude_code.", { task: str("The coding task") }, ["task"]),
    spec("file_read", "Read a local file from your workspace.", { path: str("Path") }, ["path"]),
    spec("file_write", "Write a local file in your workspace.",
      { path: str("Path"), content: str("Content") }, ["path", "content"]),
    spec("editor", "View or edit a workspace file.",
      { command: str("view|create|str_replace"), path: str("Path"), file_text: str("Full content"),
        new_str: str("Replacement text") },
      ["path"]),
    spec("current_time", "Get the current time (ISO 8601)."),
    spec("calculator", "Evaluate an arithmetic expression.", { expression: str("Expression") }, ["expression"]),
  ];

  function execute(name, args) {
    const entry = { tool: name, args: args ?? {}, argsDigest: digest(args), ts: new Date().toISOString() };
    trajectory.push(entry);
    const fn = executors[name];
    if (!fn) return `ERROR: tool '${name}' is not available in this environment.`;
    try {
      return String(fn(args ?? {}));
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  return { toolSpecs, execute, trajectory, executors, tickets };
}
