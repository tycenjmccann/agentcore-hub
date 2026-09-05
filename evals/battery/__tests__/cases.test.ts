// Preflight over tiny synthetic repo trees (injectable root). No AWS, no
// network — pure fs in temp dirs.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { preflight, resolveFixtureRef } from "../lib/cases.mjs";
import { createRegistry } from "../lib/registry.mjs";

const REAL_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL_SCHEMA = readFileSync(join(REAL_ROOT, "evals/battery/schema/case.schema.json"), "utf8");

const VALID_CASE = {
  id: "valid-case-001",
  title: "A valid battery case",
  targetAgentId: "agentcore_hub_qa_verifier",
  taskPrompt: "This is a sufficiently long task prompt for the schema minimum.",
  referenceInputs: { expectedOutcomes: ["produces a verdict via report_completion"] },
  evaluators: ["Builtin.Correctness"],
  modelTier: "haiku",
  timeoutSeconds: 60,
  status: "active",
  provenance: { source: "synthetic" },
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a minimal valid repo tree, then let the test break it. */
function makeRepo(mutate?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "battery-test-repo-"));
  tempDirs.push(root);
  const bat = join(root, "evals", "battery");
  mkdirSync(join(bat, "schema"), { recursive: true });
  mkdirSync(join(bat, "cases"), { recursive: true });
  mkdirSync(join(bat, "fixtures"), { recursive: true });
  mkdirSync(join(root, "src", "config"), { recursive: true });
  mkdirSync(join(root, "deploy", "runtime-agent", "prompts"), { recursive: true });
  writeFileSync(join(bat, "schema", "case.schema.json"), REAL_SCHEMA);
  writeFileSync(join(bat, "cases", "valid-case-001.json"), JSON.stringify(VALID_CASE, null, 2));
  writeFileSync(
    join(bat, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, minActiveCases: 1, activeCases: ["valid-case-001"] })
  );
  writeFileSync(
    join(bat, "thresholds.json"),
    JSON.stringify({
      schemaVersion: 1,
      overallDropMaxPoints: 5,
      floorRule: { floorDelta: 10, minAbsoluteFloor: 40 },
      maxRunUsd: 20,
    })
  );
  writeFileSync(
    join(bat, "baseline.json"),
    JSON.stringify({ schemaVersion: 1, scoringBackend: "local-judge", bootstrap: true, source_commit: "x", cases: {} })
  );
  writeFileSync(
    join(root, "src", "config", "agents.json"),
    JSON.stringify({ agents: [{ agentId: "agentcore_hub_qa_verifier" }] })
  );
  writeFileSync(join(root, "src", "config", "workflows.json"), "{}");
  writeFileSync(join(root, "deploy", "runtime-agent", "prompts", "agentcore_hub_qa_verifier.txt"), "You are QA.");
  mutate?.(root);
  return root;
}

const errorText = (pf: any) => pf.errors.map((e: any) => `[${e.check}] ${e.file}: ${e.message}`).join("\n");

describe("preflight happy path", () => {
  it("passes on a minimal valid tree", () => {
    const pf = preflight(makeRepo());
    expect(pf.errors).toEqual([]);
    expect(pf.ok).toBe(true);
    expect(pf.activeCases.map((c: any) => c.id)).toEqual(["valid-case-001"]);
  });
});

describe("malformed cases fail loudly (before any Bedrock spend)", () => {
  it("names the file on unparseable JSON", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(join(root, "evals/battery/cases/broken.json"), "{ not json");
    }));
    expect(pf.ok).toBe(false);
    const err = pf.errors.find((e: any) => e.check === "parse");
    expect(err?.file).toBe("evals/battery/cases/broken.json");
  });

  it("names the file on a schema violation", () => {
    const pf = preflight(makeRepo((root) => {
      const bad = { ...VALID_CASE, id: "bad-case-002", taskPrompt: "short" };
      writeFileSync(join(root, "evals/battery/cases/bad-case-002.json"), JSON.stringify(bad));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "schema" && e.file.includes("bad-case-002"))).toBe(true);
  });
});

describe("manifest drift", () => {
  it("fails when an active case file is missing from activeCases", () => {
    const pf = preflight(makeRepo((root) => {
      const extra = { ...VALID_CASE, id: "extra-case-002" };
      writeFileSync(join(root, "evals/battery/cases/extra-case-002.json"), JSON.stringify(extra));
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("active case 'extra-case-002' missing from activeCases");
  });

  it("fails when activeCases lists an id with no active case file", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(
        join(root, "evals/battery/manifest.json"),
        JSON.stringify({ schemaVersion: 1, minActiveCases: 1, activeCases: ["valid-case-001", "ghost-case"] })
      );
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("'ghost-case'");
  });

  it("fails when activeCases count is below minActiveCases", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(
        join(root, "evals/battery/manifest.json"),
        JSON.stringify({ schemaVersion: 1, minActiveCases: 5, activeCases: ["valid-case-001"] })
      );
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("< minActiveCases 5");
  });
});

describe("duplicate case ids (B4)", () => {
  it("fails preflight naming the id and every file that claims it", () => {
    const pf = preflight(makeRepo((root) => {
      // Same id, different file — every downstream roster is id-keyed, so one of
      // the two would silently never run.
      writeFileSync(join(root, "evals/battery/cases/copy-of-valid.json"), JSON.stringify(VALID_CASE, null, 2));
    }));
    expect(pf.ok).toBe(false);
    const err = pf.errors.find((e: any) => e.check === "duplicate-id");
    expect(err?.message).toContain("duplicate case id 'valid-case-001'");
    expect(err?.message).toContain("evals/battery/cases/copy-of-valid.json");
    expect(err?.message).toContain("evals/battery/cases/valid-case-001.json");
  });

  it("fails preflight when manifest.json lists the same id twice", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(
        join(root, "evals/battery/manifest.json"),
        JSON.stringify({ schemaVersion: 1, minActiveCases: 1, activeCases: ["valid-case-001", "valid-case-001"] })
      );
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("activeCases lists 'valid-case-001' more than once");
  });
});

describe("cross-file integrity", () => {
  it("fails on a targetAgentId not present in src/config/agents.json", () => {
    const pf = preflight(makeRepo((root) => {
      const dangling = { ...VALID_CASE, id: "dangling-agent-002", targetAgentId: "agentcore_hub_ghost" };
      writeFileSync(join(root, "evals/battery/cases/dangling-agent-002.json"), JSON.stringify(dangling));
      const m = { schemaVersion: 1, minActiveCases: 1, activeCases: ["valid-case-001", "dangling-agent-002"] };
      writeFileSync(join(root, "evals/battery/manifest.json"), JSON.stringify(m));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "roster" && e.message.includes("agentcore_hub_ghost"))).toBe(true);
  });

  it("fails when the agent's prompt file is missing", () => {
    const pf = preflight(makeRepo((root) => {
      rmSync(join(root, "deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt"));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "prompt")).toBe(true);
  });

  it("fails when a referenced fixture path does not exist", () => {
    const pf = preflight(makeRepo((root) => {
      const withInput = { ...VALID_CASE, input: { files: ["fixtures/valid-case-001/missing.md"] } };
      writeFileSync(join(root, "evals/battery/cases/valid-case-001.json"), JSON.stringify(withInput));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "fixture")).toBe(true);
  });

  it("fails when a broken agents.json roster cannot parse (config regression)", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(join(root, "src/config/agents.json"), "{ broken");
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "config" && e.file === "src/config/agents.json")).toBe(true);
  });

  it("requires expectedToolTrajectory when the custom dependency-chain evaluator is listed", () => {
    const pf = preflight(makeRepo((root) => {
      const c = { ...VALID_CASE, evaluators: ["dependency_chain_compliance-VyBv7H2bCi"] };
      writeFileSync(join(root, "evals/battery/cases/valid-case-001.json"), JSON.stringify(c));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "reference-inputs")).toBe(true);
  });

  it("requires referenceInputs.personaContract when persona_contract_compliance is listed", () => {
    const pf = preflight(makeRepo((root) => {
      const c = { ...VALID_CASE, evaluators: ["persona_contract_compliance"] };
      writeFileSync(join(root, "evals/battery/cases/valid-case-001.json"), JSON.stringify(c));
    }));
    expect(pf.ok).toBe(false);
    expect(pf.errors.some((e: any) => e.check === "reference-inputs" && /personaContract/.test(e.message))).toBe(true);
  });

  it("passes when persona_contract_compliance comes with a pinned contract", () => {
    const pf = preflight(makeRepo((root) => {
      const c = {
        ...VALID_CASE,
        evaluators: ["persona_contract_compliance"],
        referenceInputs: {
          ...VALID_CASE.referenceInputs,
          personaContract: ["Never transitions tickets itself."],
        },
      };
      writeFileSync(join(root, "evals/battery/cases/valid-case-001.json"), JSON.stringify(c));
    }));
    expect(pf.errors).toEqual([]);
    expect(pf.ok).toBe(true);
  });
});

describe("baseline fail-closed", () => {
  it("fails when baseline.json is missing", () => {
    const pf = preflight(makeRepo((root) => {
      rmSync(join(root, "evals/battery/baseline.json"));
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("baseline.json");
  });

  it("fails when baseline.json is unparseable", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(join(root, "evals/battery/baseline.json"), "not json at all");
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("baseline.json");
  });

  it("fails when baseline.json lacks required keys", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(join(root, "evals/battery/baseline.json"), JSON.stringify({ schemaVersion: 1 }));
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("scoringBackend");
    expect(errorText(pf)).toContain("fail closed");
  });

  it("fails when baseline scoringBackend mismatches the current backend", () => {
    const pf = preflight(makeRepo((root) => {
      writeFileSync(
        join(root, "evals/battery/baseline.json"),
        JSON.stringify({ schemaVersion: 1, scoringBackend: "agentcore-ondemand", cases: {} })
      );
    }));
    expect(pf.ok).toBe(false);
    expect(errorText(pf)).toContain("not comparable across backends");
  });
});

describe("retired cases", () => {
  it("excludes retired cases from the run set but reports them with reasons", () => {
    const pf = preflight(makeRepo((root) => {
      const retired = {
        ...VALID_CASE,
        id: "retired-case-002",
        status: "retired",
        retirement_reason: "flaked three times in a row; retired pending fixture rework",
      };
      writeFileSync(join(root, "evals/battery/cases/retired-case-002.json"), JSON.stringify(retired));
    }));
    expect(pf.ok).toBe(true);
    expect(pf.activeCases.map((c: any) => c.id)).toEqual(["valid-case-001"]);
    expect(pf.retiredCases).toEqual([
      expect.objectContaining({ id: "retired-case-002", retirement_reason: expect.stringContaining("flaked") }),
    ]);
  });
});

describe("preflight on the real working tree", () => {
  it("passes (mirrors what battery:dry-run asserts)", () => {
    const pf = preflight(REAL_ROOT);
    expect(errorText(pf)).toBe("");
    expect(pf.activeCases.length).toBeGreaterThanOrEqual(10);
    expect(pf.retiredCases.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fixture references are confined to evals/battery/fixtures/ (Codex P1 on #358)", () => {
  const TRAVERSAL = "../../../../etc/hosts";

  it("preflight fails a case whose input.files escapes the fixtures directory", () => {
    const pf = preflight(
      makeRepo((root) => {
        const c = { ...VALID_CASE, input: { files: [TRAVERSAL] } };
        writeFileSync(join(root, "evals", "battery", "cases", "valid-case-001.json"), JSON.stringify(c));
      })
    );
    expect(pf.errors.some((e) => e.check === "fixture" && /escapes evals\/battery\/fixtures/.test(e.message))).toBe(true);
  });

  it("preflight fails on an absolute path and on a ref outside fixtures/ even when it exists", () => {
    const pf = preflight(
      makeRepo((root) => {
        const c = { ...VALID_CASE, input: { files: ["/etc/hosts", "manifest.json"] } };
        writeFileSync(join(root, "evals", "battery", "cases", "valid-case-001.json"), JSON.stringify(c));
      })
    );
    const msgs = pf.errors.filter((e) => e.check === "fixture").map((e) => e.message);
    expect(msgs.some((m) => /must be a relative path/.test(m))).toBe(true);
    expect(msgs.some((m) => /manifest\.json.*escapes/.test(m))).toBe(true);
  });

  it("resolveFixtureRef accepts a normal fixture path and rejects traversal", () => {
    const root = makeRepo();
    expect(resolveFixtureRef(root, "fixtures/x/a.md")).toBe(join(root, "evals", "battery", "fixtures", "x", "a.md"));
    expect(() => resolveFixtureRef(root, TRAVERSAL)).toThrow(/escapes/);
    expect(() => resolveFixtureRef(root, "fixtures/../cases/valid-case-001.json")).toThrow(/escapes/);
  });

  it("createRegistry refuses to seed a traversal ref instead of silently reading it", () => {
    const root = makeRepo();
    const ws = mkdtempSync(join(tmpdir(), "battery-ws-"));
    tempDirs.push(ws);
    expect(() =>
      createRegistry({ caseDef: { ...VALID_CASE, input: { files: [TRAVERSAL] } }, repoRoot: root, workspaceDir: ws })
    ).toThrow(/escapes/);
  });
});
