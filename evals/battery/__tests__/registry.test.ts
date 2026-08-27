// Hermetic registry (HERM-2): closed tool set, forbidden tools absent,
// everything stubbed and side-effect-free outside its in-memory state and the
// per-case /tmp workspace.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRegistry, FORBIDDEN_TOOLS } from "../lib/registry.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeRegistry(caseDef: any = { id: "reg-test", input: {} }) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "battery-reg-test-"));
  tempDirs.push(workspaceDir);
  return { registry: createRegistry({ caseDef, repoRoot: REPO_ROOT, workspaceDir }), workspaceDir };
}

describe("closed registry", () => {
  it("has zero overlap with FORBIDDEN_TOOLS", () => {
    const { registry } = makeRegistry();
    const names = new Set(registry.toolSpecs.map((t: any) => t.toolSpec.name));
    for (const forbidden of FORBIDDEN_TOOLS) expect(names.has(forbidden)).toBe(false);
    // The classics explicitly absent:
    for (const t of ["python_repl", "shell", "http_request", "browser", "code_interpreter", "environment"]) {
      expect(names.has(t)).toBe(false);
      expect(FORBIDDEN_TOOLS).toContain(t);
    }
    // git-push surface forbidden too
    expect(FORBIDDEN_TOOLS).toContain("push_files");
    expect(FORBIDDEN_TOOLS).toContain("create_pull_request");
  });

  it("returns an error string (not a crash, not a passthrough) for unknown tools", () => {
    const { registry } = makeRegistry();
    const result = registry.execute("shell", { command: "rm -rf /" });
    expect(result).toContain("not available");
    // …and even the refusal is recorded in the trajectory for the forbidden check
    expect(registry.trajectory[0]).toMatchObject({ tool: "shell" });
  });

  it("keeps 'eval_' out of every session id the runner would mint (eval-packager substring defense)", () => {
    const caseIds = readdirSync(join(REPO_ROOT, "evals/battery/cases"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    for (const id of caseIds) {
      expect(`battery-abc123-${id}`.includes("eval_")).toBe(false);
    }
  });
});

describe("stub executors", () => {
  it("marks every Tickets/WorkflowOutput executor as a stub returning canned payloads", () => {
    const { registry } = makeRegistry();
    for (const [name, fn] of Object.entries<any>(registry.executors)) {
      if (name.startsWith("Tickets___") || name.startsWith("WorkflowOutput___")) {
        expect(fn.isStub, `${name} must be a stub`).toBe(true);
        const out = registry.execute(name, {
          title: "t", description: "d", ticket_id: "BATT-1", transition_id: "done",
          comment: "c", parent_id: "BATT-0", query: "q", summary: "s",
          workflow_id: "wf_battery_x", epic_id: "BATT-0", agent_id: "a", content: "x", tickets: "[]",
        });
        expect(typeof out).toBe("string");
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it("mints fake BATT-9xx ticket keys and keeps them in memory only", () => {
    const { registry } = makeRegistry();
    const first = JSON.parse(registry.execute("Tickets___create_ticket", { title: "a", description: "d" }));
    const second = JSON.parse(registry.execute("Tickets___create_ticket", { title: "b", description: "d" }));
    expect(first.ticket_id).toBe("BATT-901");
    expect(second.ticket_id).toBe("BATT-902");
    expect(registry.tickets).toHaveLength(2);
    const listed = JSON.parse(registry.execute("Tickets___list_tickets", { parent_id: "BATT-0" }));
    expect(listed.tickets).toHaveLength(2);
  });

  it("records (tool, argsDigest) for every call", () => {
    const { registry } = makeRegistry();
    registry.execute("current_time", {});
    registry.execute("calculator", { expression: "2+2" });
    expect(registry.trajectory.map((t: any) => t.tool)).toEqual(["current_time", "calculator"]);
    for (const entry of registry.trajectory) expect(entry.argsDigest).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("in-memory S3 + fixture seeding", () => {
  it("seeds case input files under shared/inputs/ and serves reads/writes/lists from memory", () => {
    const { registry } = makeRegistry({
      id: "qa-verifier-regression-001",
      input: { files: ["fixtures/qa-verifier-regression-001/ticket.json"] },
    });
    const listed = JSON.parse(registry.execute("S3Storage___list_objects", { prefix: "shared/inputs/" }));
    expect(listed.keys).toContain("shared/inputs/ticket.json");
    const content = registry.execute("S3Storage___read_object", { key: "shared/inputs/ticket.json" });
    expect(content).toContain("BATT-110");
    registry.execute("S3Storage___write_object", { key: "shared/qa-evidence/notes.md", content: "evidence" });
    expect(registry.execute("S3Storage___read_object", { key: "shared/qa-evidence/notes.md" })).toBe("evidence");
    expect(registry.execute("S3Storage___read_object", { key: "nope/missing.txt" })).toContain("NoSuchKey");
  });
});

describe("working-tree blueprints", () => {
  it("serves blueprints/<name>.md from the working tree (changed blueprints get under test)", () => {
    const { registry } = makeRegistry();
    const real = readFileSync(join(REPO_ROOT, "blueprints/qa-verifier.md"), "utf8");
    expect(registry.execute("load_blueprint", { blueprint_name: "qa-verifier" })).toBe(real);
    expect(registry.execute("load_blueprint", { blueprint_name: "no-such-blueprint" })).toContain("Available:");
  });
});

describe("workspace jail", () => {
  it("confines file tools to the case workspace and blocks traversal + sibling-prefix escapes", () => {
    const { registry, workspaceDir } = makeRegistry();
    registry.execute("file_write", { path: "notes/scratch.txt", content: "hi" });
    expect(registry.execute("file_read", { path: "notes/scratch.txt" })).toBe("hi");
    expect(existsSync(join(workspaceDir, "notes/scratch.txt"))).toBe(true);
    expect(registry.execute("file_read", { path: "../../etc/passwd" })).toContain("escapes the case workspace");
    expect(registry.execute("file_write", { path: `${workspaceDir}-evil/x`, content: "x" })).toContain(
      "escapes the case workspace"
    );
  });
});

describe("coding-engine stubs", () => {
  it("returns delegation acks — no real repo, no push", () => {
    const { registry } = makeRegistry();
    expect(registry.execute("claude_code", { task: "fix it" })).toContain("[battery-stub]");
    expect(registry.execute("codex", { task: "fix it" })).toContain("[battery-stub]");
  });
});
