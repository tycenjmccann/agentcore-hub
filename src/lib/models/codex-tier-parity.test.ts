import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TEAM-4995 / DL-033 parity contract: the tier NAMES are a contract between four
 * places that cannot import each other —
 *
 *   1. the `codex()` tool's signature + docstring in deploy/runtime-agent/main.py
 *      (what the agent is told it may pass),
 *   2. the blueprints (what the agent is actually told to pass, in prose),
 *   3. `tiers.claude` / `tiers.codex` in src/config/models.json (what resolves),
 *   4. the LITERAL_* fallback constants, byte-copied four ways.
 *
 * A tier that exists in the blueprints and not in the registry resolves to
 * nothing and silently takes the default; a tier in the registry that no
 * blueprint names is dead config. Codex gets its OWN four names (astra/sol/
 * terra/luna) rather than reusing fable/opus/sonnet/haiku, because one name
 * meaning two different models per tool is exactly the ambiguity this ticket
 * deletes. So the sets are PINNED here, not derived from each other.
 *
 * Pure text + fs: no AWS, no network, no registry load.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const CODEX_TIERS = ["astra", "sol", "terra", "luna"] as const;
const CLAUDE_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;

const FLEET_MAIN = "deploy/runtime-agent/main.py";
const PY_TWINS = [
  "deploy/runtime-agent/models_registry.py",
  "deploy/coding-agent-runtime/models_registry.py",
];
const MJS_TWINS = [
  "lambda/token-aggregator/models-registry.mjs",
  "deploy/telegram-bug-intake/models-registry.mjs",
];
const SEED = "src/config/models.json";

// Every blueprint, concatenated. Tier names are grepped out of the whole corpus
// rather than per file: the contract is "these four names exist in the prose the
// agents are given", not "every blueprint mentions every tier".
function blueprintText(): string {
  return readdirSync(join(ROOT, "blueprints"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => read(join("blueprints", f)))
    .join("\n");
}

function tiersIn(corpus: string, tool: "codex" | "claude_code"): string[] {
  const re = new RegExp(`${tool}\\([^)]*model="([a-z]+)"`, "g");
  const found = new Set<string>();
  for (const m of corpus.matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

describe("codex tier parity (DL-033)", () => {
  const main = read(FLEET_MAIN);

  it("the codex() tool takes a model argument", () => {
    // `model: str = ""` — empty means "the configured default", which is what
    // makes tier selection optional rather than a new mandatory step.
    const sig = main.slice(main.indexOf("def codex("), main.indexOf("def codex(") + 200);
    expect(sig).toContain('model: str = ""');
  });

  it("the codex() docstring offers exactly the four Codex tiers", () => {
    const line = main
      .split("\n")
      .find((l) => l.trim().startsWith("model: one of "));
    expect(line, `no "model: one of …" line in ${FLEET_MAIN}'s codex() docstring`).toBeTruthy();
    const named = (line as string)
      .replace(/.*model: one of /, "")
      .replace(/\(.*$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(named).toEqual([...CODEX_TIERS].sort());
  });

  it("the blueprints name exactly the four Codex tiers", () => {
    // EQUALS, not includes: a fifth name in the prose is a tier the registry
    // cannot resolve, and a missing one is a rung of the ladder no agent knows
    // about. The guidance lives on the claude_code tier lines as the Codex peer.
    expect(tiersIn(blueprintText(), "codex")).toEqual([...CODEX_TIERS].sort());
  });

  it("the blueprints pass only real Claude tiers to claude_code", () => {
    // Subset, not equality: not every blueprint needs all four rungs (haiku is
    // named in prose as "never plan on haiku" rather than in a call).
    for (const tier of tiersIn(blueprintText(), "claude_code")) {
      expect(CLAUDE_TIERS as readonly string[]).toContain(tier);
    }
  });

  it.skipIf(!existsSync(join(ROOT, SEED)))(
    "the registry seed's tier maps carry exactly those names",
    () => {
      // TEAM-4997 authors src/config/models.json; this becomes strict when it lands.
      const doc = JSON.parse(read(SEED)) as {
        tiers?: { claude?: Record<string, string>; codex?: Record<string, string> };
      };
      expect(Object.keys(doc.tiers?.codex ?? {}).sort()).toEqual([...CODEX_TIERS].sort());
      expect(Object.keys(doc.tiers?.claude ?? {}).sort()).toEqual([...CLAUDE_TIERS].sort());
    },
  );
});

describe("registry twins agree on the literal fallbacks (DL-033)", () => {
  // The constant NAMES differ by language convention (LITERAL_PERSONA in Python,
  // LITERAL_PERSONA_DEFAULT in the mjs copies); the VALUES may not. This is the
  // last resort when S3 is unreadable, so a drift here means two components boot
  // on different models in exactly the situation nobody is watching.
  const grab = (text: string, name: string): string | undefined =>
    text.match(new RegExp(`${name}(?:_DEFAULT)?\\s*=\\s*['"]([^'"]+)['"]`))?.[1];

  const NAMES = ["LITERAL_PERSONA", "LITERAL_CODING_CLAUDE", "LITERAL_CODING_CODEX"] as const;
  const FILES = [...PY_TWINS, ...MJS_TWINS];

  for (const name of NAMES) {
    it(`${name} is the same value in all four loaders`, () => {
      const values = FILES.map((f) => [f, grab(read(f), name)] as const);
      for (const [f, v] of values) expect(v, `${name} missing from ${f}`).toBeTruthy();
      const distinct = [...new Set(values.map(([, v]) => v))];
      expect(distinct, `${name} drifted: ${JSON.stringify(values)}`).toHaveLength(1);
    });
  }

  it("the Python pair and the mjs pair are each byte-identical", () => {
    // scripts/check-models-registry-parity.sh is the CI guard; this keeps the
    // contract visible to anyone editing one copy from an editor.
    expect(read(PY_TWINS[0])).toEqual(read(PY_TWINS[1]));
    expect(read(MJS_TWINS[0])).toEqual(read(MJS_TWINS[1]));
  });
});
