/**
 * TEAM-5034 — the harness setup scripts' registry read, as data.
 *
 * The defect this pins is a SILENT one: in the live Deploy stage all three
 * harness setup scripts logged `[models] registry.fallback reason=s3 (Error)`
 * and re-pinned their harness from their own LITERAL_MODEL_ID. The "(Error)" was
 * an ERR_MODULE_NOT_FOUND on `import("@aws-sdk/client-s3")` — Target 2b's scratch
 * node_modules never carried the S3 client — reported as an S3 failure, and the
 * deploy went green while reverting whatever an operator had pinned on /models.
 *
 * So there are three properties here, not one:
 *   1. the log line names the REAL failure (reason + name + code + message),
 *   2. under PIPELINE_MODE a model that did not come out of the registry document
 *      exits non-zero BEFORE any UpdateHarness, rather than shipping the literal,
 *   3. the three scripts really do share this one module, and the package list
 *      that broke it really does carry @aws-sdk/client-s3.
 *
 * (1) and (2) are driven through the real helper with injected seams — a fake S3
 * client, the REAL src/lib/models/models-registry.mjs, a captured logger and a
 * fake exit — so no AWS, no network. (3) is static text over the tracked sources,
 * because no unit test can see a package.json list inside a buildspec.
 */
import { describe, it, expect, vi } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatErr, loadRegistryDoc, resolveHarnessModel, REGISTRY_KEY } from "./harness-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const AGENT_ID = "agentcore_hub_builder";
const LITERAL = "us.anthropic.claude-sonnet-5";
const PINNED = "us.anthropic.claude-opus-5";
const PERSONA = "us.anthropic.claude-fable-5-1";

/** The real seed, so "a valid document" means one the validator actually accepts. */
const SEED = () => JSON.parse(read("src/config/models.json"));

/** The real resolver — the same module the scripts import at runtime. */
const realRegistry = () =>
  import(new URL("../../src/lib/models/models-registry.mjs", import.meta.url).href);

/** A logger that records every line, in order. */
function capture() {
  const lines = [];
  return { log: { log: (l) => lines.push(String(l)) }, lines };
}

const lineWith = (lines, needle) => lines.find((l) => l.includes(needle));

/**
 * A fake `import("@aws-sdk/client-s3")`. `body` is what GetObject returns;
 * `throws` makes the send fail instead.
 */
function fakeS3({ body, throws } = {}) {
  const sent = [];
  const importS3 = async () => ({
    S3Client: class {
      constructor(cfg) {
        this.cfg = cfg;
        sent.push({ kind: "client", cfg });
      }
      async send(cmd) {
        sent.push({ kind: "send", input: cmd.input });
        if (throws) throw throws;
        return { Body: { transformToString: async () => body } };
      }
    },
    GetObjectCommand: class {
      constructor(input) {
        this.input = input;
      }
    },
  });
  return { importS3, sent };
}

/** An error the way a Node module-resolution failure arrives: name "Error". */
const moduleMissing = () =>
  Object.assign(new Error("Cannot find package '@aws-sdk/client-s3' imported from /codebuild/output/src/deploy/pipeline/harness-model.mjs"), {
    code: "ERR_MODULE_NOT_FOUND",
  });

/** ...and the way S3 does. */
const accessDenied = () =>
  Object.assign(new Error("Access Denied"), {
    name: "AccessDenied",
    code: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
  });

// ───────────────────────────────────────────────────────────────────────────────
// formatErr — the line an operator has to read in a CodeBuild log
// ───────────────────────────────────────────────────────────────────────────────

describe("formatErr", () => {
  it("names name, code and message", () => {
    expect(formatErr(accessDenied())).toBe("name=AccessDenied code=AccessDenied message=Access Denied");
  });

  it("is ONE line and at most 200 chars of message", () => {
    const err = new Error(`first line\nsecond   line\n${"x".repeat(400)}`);
    const out = formatErr(err);
    expect(out).not.toContain("\n");
    const message = out.slice(out.indexOf("message=") + "message=".length);
    expect(message.length).toBe(200);
    expect(message.startsWith("first line second line")).toBe(true);
  });

  it("still emits all three fields for an error carrying none of them", () => {
    expect(formatErr({})).toBe("name=Error code=- message=");
    expect(formatErr(undefined)).toBe("name=Error code=- message=");
  });

  it("falls back to the HTTP status when there is no code", () => {
    const err = Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    expect(formatErr(err)).toBe("name=NoSuchKey code=404 message=nope");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// loadRegistryDoc — the read, and which of the four reasons a failure gets
// ───────────────────────────────────────────────────────────────────────────────

describe("loadRegistryDoc", () => {
  it("reads config/models.json from the given bucket, with an EXPLICIT region", async () => {
    const { importS3, sent } = fakeS3({ body: JSON.stringify(SEED()) });
    const { log, lines } = capture();
    const { doc, error } = await loadRegistryDoc({
      bucket: "agentcore-hub-artifacts-1234-us-east-1",
      region: "us-east-1",
      importS3,
      log,
    });

    expect(error).toBeNull();
    expect(doc.agents[AGENT_ID]).toBe(LITERAL);
    expect(sent[0]).toEqual({ kind: "client", cfg: { region: "us-east-1" } });
    expect(sent[1].input).toEqual({
      Bucket: "agentcore-hub-artifacts-1234-us-east-1",
      Key: "config/models.json",
    });
    expect(REGISTRY_KEY).toBe("config/models.json");
    expect(lines).toEqual([]);
  });

  it("reports the MISSING PACKAGE as module-missing, not as s3 (the TEAM-5034 defect)", async () => {
    const err = moduleMissing();
    const { log, lines } = capture();
    const { doc, error } = await loadRegistryDoc({
      bucket: "b",
      region: "us-east-1",
      importS3: async () => {
        throw err;
      },
      log,
    });

    expect(doc).toBeNull();
    expect(error).toMatchObject({ reason: "module-missing", name: "Error", code: "ERR_MODULE_NOT_FOUND" });
    expect(error.message).toContain("Cannot find package '@aws-sdk/client-s3'");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[models] registry.fallback reason=module-missing");
    expect(lines[0]).toContain("code=ERR_MODULE_NOT_FOUND");
    // The old line printed `(Error)` and nothing else — the whole bug.
    expect(lines[0]).not.toBe("[models] registry.fallback reason=s3 (Error)");
  });

  it("separates any other import failure as import", async () => {
    const { log, lines } = capture();
    const { error } = await loadRegistryDoc({
      bucket: "b",
      region: "us-east-1",
      importS3: async () => {
        throw Object.assign(new SyntaxError("Unexpected token"), { code: "ERR_SOMETHING_ELSE" });
      },
      log,
    });
    expect(error.reason).toBe("import");
    expect(lines[0]).toContain("reason=import name=SyntaxError code=ERR_SOMETHING_ELSE");
  });

  it("reports a GetObject failure as s3, with the SDK's name and code", async () => {
    const { importS3 } = fakeS3({ throws: accessDenied() });
    const { log, lines } = capture();
    const { doc, error } = await loadRegistryDoc({ bucket: "b", region: "us-east-1", importS3, log });

    expect(doc).toBeNull();
    expect(error).toEqual({
      reason: "s3",
      name: "AccessDenied",
      code: "AccessDenied",
      message: "Access Denied",
    });
    expect(lines).toEqual([
      "[models] registry.fallback reason=s3 name=AccessDenied code=AccessDenied message=Access Denied",
    ]);
  });

  it("reports an unparseable object as parse", async () => {
    const { importS3 } = fakeS3({ body: "not json" });
    const { log, lines } = capture();
    const { doc, error } = await loadRegistryDoc({ bucket: "b", region: "us-east-1", importS3, log });

    expect(doc).toBeNull();
    expect(error.reason).toBe("parse");
    expect(lines[0]).toContain("[models] registry.fallback reason=parse name=SyntaxError");
  });

  it("honours an alternate key", async () => {
    const { importS3, sent } = fakeS3({ body: "{}" });
    await loadRegistryDoc({ bucket: "b", region: "us-east-1", key: "config/other.json", importS3, log: capture().log });
    expect(sent[1].input.Key).toBe("config/other.json");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// resolveHarnessModel — the pick, and the fail-closed gate
// ───────────────────────────────────────────────────────────────────────────────

describe("resolveHarnessModel: the registry answers", () => {
  it("prefers the agents pin over the script's literal", async () => {
    const doc = SEED();
    doc.agents[AGENT_ID] = PINNED;
    const { log, lines } = capture();
    const exit = vi.fn();

    const chosen = await resolveHarnessModel({
      agentId: AGENT_ID,
      doc,
      literalModelId: LITERAL,
      pipelineMode: true,
      env: {},
      log,
      exit,
      importRegistry: realRegistry,
    });

    expect(chosen).toBe(PINNED);
    expect(lines).toEqual([`[models] harness.model agentId=${AGENT_ID} modelId=${PINNED} source=agents`]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("WARNS but does NOT exit when the document has no pin for the agent", async () => {
    const doc = SEED();
    delete doc.agents[AGENT_ID];
    const { log, lines } = capture();
    const exit = vi.fn();

    const chosen = await resolveHarnessModel({
      agentId: AGENT_ID,
      doc,
      literalModelId: LITERAL,
      pipelineMode: true,
      env: {},
      log,
      exit,
      importRegistry: realRegistry,
    });

    expect(chosen).toBe(PERSONA);
    expect(lineWith(lines, "harness.model")).toContain("source=defaults");
    const warn = lineWith(lines, "WARN");
    expect(warn).toContain(`[models] WARN ${AGENT_ID} has no agents.${AGENT_ID} pin in config/models.json`);
    expect(warn).toContain(`following defaults.persona (${PERSONA})`);
    expect(warn).toContain("pin it on /models");
    expect(exit).not.toHaveBeenCalled();
    expect(lineWith(lines, "FATAL")).toBeUndefined();
    expect(lineWith(lines, "registry.fallback")).toBeUndefined();
  });
});

/**
 * Every way the read can fail, against both modes. One table, because the
 * property is the same in each case: the log names the reason, PIPELINE_MODE
 * exits 1, and a hand-run keeps the literal.
 */
const FAILURES = [
  {
    what: "s3 read failure",
    reason: "s3",
    args: () => {
      const { importS3 } = fakeS3({ throws: accessDenied() });
      return { importS3 };
    },
  },
  {
    what: "missing @aws-sdk/client-s3",
    reason: "module-missing",
    args: () => ({
      importS3: async () => {
        throw moduleMissing();
      },
    }),
  },
  {
    what: "unparseable document",
    reason: "parse",
    args: () => {
      const { importS3 } = fakeS3({ body: "{not json" });
      return { importS3 };
    },
  },
  {
    what: "invalid document (validateRegistry refuses it)",
    reason: "parse",
    args: () => {
      // defaults.persona pointing at a model no catalog row carries is a fatal
      // read error, so validateRegistry hands back registry: null.
      const doc = SEED();
      doc.defaults.persona = "us.anthropic.claude-nobody-has-heard-of";
      const { importS3 } = fakeS3({ body: JSON.stringify(doc) });
      return { importS3 };
    },
  },
];

describe.each(FAILURES)("resolveHarnessModel fails closed: $what", ({ reason, args }) => {
  /** The whole chain the scripts run: load, then resolve. */
  async function run(pipelineMode) {
    const { log, lines } = capture();
    const exit = vi.fn();
    const { doc, error } = await loadRegistryDoc({
      bucket: "b",
      region: "us-east-1",
      log,
      ...args(),
    });
    const chosen = await resolveHarnessModel({
      agentId: AGENT_ID,
      doc,
      docError: error,
      literalModelId: LITERAL,
      pipelineMode,
      env: {},
      log,
      exit,
      importRegistry: realRegistry,
    });
    return { chosen, lines, exit };
  }

  it(`logs reason=${reason} with name, code and message`, async () => {
    const { lines } = await run(false);
    const fallback = lineWith(lines, "registry.fallback");
    expect(fallback).toContain(`reason=${reason}`);
    expect(fallback).toMatch(/ name=\S+ code=\S+ message=/);
  });

  it("exits 1 under PIPELINE_MODE, naming the consequence", async () => {
    const { lines, exit } = await run(true);
    expect(exit).toHaveBeenCalledWith(1);
    const fatal = lineWith(lines, "FATAL");
    expect(fatal).toContain(`[models] FATAL harness model NOT taken from registry for ${AGENT_ID}`);
    expect(fatal).toContain(`refusing to re-pin from the literal ${LITERAL} under PIPELINE_MODE`);
    expect(fatal).toContain("an operator repin on /models would be silently reverted");
    expect(lineWith(lines, "[models] WARN")).toBeUndefined();
  });

  it("keeps the literal with a WARN outside PIPELINE_MODE", async () => {
    const { chosen, lines, exit } = await run(false);
    expect(chosen).toBe(LITERAL);
    expect(exit).not.toHaveBeenCalled();
    expect(lineWith(lines, "WARN")).toBe(
      `[models] WARN harness model NOT taken from registry — keeping literal ${LITERAL}`,
    );
    expect(lineWith(lines, "FATAL")).toBeUndefined();
  });
});

describe("resolveHarnessModel: the registry loader itself is missing", () => {
  const throwingRegistry = async () => {
    throw moduleMissing();
  };

  it("logs module-missing and exits 1 under PIPELINE_MODE", async () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    await resolveHarnessModel({
      agentId: AGENT_ID,
      doc: SEED(),
      literalModelId: LITERAL,
      pipelineMode: true,
      env: {},
      log,
      exit,
      importRegistry: throwingRegistry,
    });
    expect(lines[0]).toContain("[models] registry.fallback reason=module-missing");
    expect(exit).toHaveBeenCalledWith(1);
    expect(lineWith(lines, "FATAL")).toContain("NOT taken from registry");
  });

  it("keeps the literal outside PIPELINE_MODE", async () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    const chosen = await resolveHarnessModel({
      agentId: AGENT_ID,
      doc: SEED(),
      literalModelId: LITERAL,
      pipelineMode: false,
      env: {},
      log,
      exit,
      importRegistry: throwingRegistry,
    });
    expect(chosen).toBe(LITERAL);
    expect(exit).not.toHaveBeenCalled();
    expect(lineWith(lines, "WARN")).toContain(`keeping literal ${LITERAL}`);
  });

  it("classifies a non-resolution import failure as import", async () => {
    const { log, lines } = capture();
    await resolveHarnessModel({
      agentId: AGENT_ID,
      doc: SEED(),
      literalModelId: LITERAL,
      pipelineMode: false,
      env: {},
      log,
      exit: vi.fn(),
      importRegistry: async () => {
        throw new TypeError("boom");
      },
    });
    expect(lines[0]).toContain("reason=import name=TypeError");
  });
});

describe("resolveHarnessModel: a readable document that did not choose the model", () => {
  /** A document the validator accepts but that routes nothing for this agent. */
  function personaless() {
    const doc = SEED();
    delete doc.agents[AGENT_ID];
    delete doc.defaults.persona;
    return doc;
  }

  it("treats source=literal as a registry failure under PIPELINE_MODE", async () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    await resolveHarnessModel({
      agentId: AGENT_ID,
      doc: personaless(),
      literalModelId: LITERAL,
      pipelineMode: true,
      env: {},
      log,
      exit,
      importRegistry: realRegistry,
    });
    expect(lineWith(lines, "harness.model")).toContain("source=literal");
    expect(exit).toHaveBeenCalledWith(1);
    expect(lineWith(lines, "FATAL")).toContain(`refusing to re-pin from the literal ${LITERAL}`);
    // No read failed, so nothing claims the document was unreadable.
    expect(lineWith(lines, "registry.fallback")).toBeUndefined();
  });

  it("treats source=env ($MODEL_ID) the same way, and names it in the hand-run WARN", async () => {
    const { log, lines } = capture();
    const exit = vi.fn();
    const chosen = await resolveHarnessModel({
      agentId: AGENT_ID,
      doc: personaless(),
      literalModelId: LITERAL,
      pipelineMode: false,
      env: { MODEL_ID: PINNED },
      log,
      exit,
      importRegistry: realRegistry,
    });
    expect(lineWith(lines, "harness.model")).toContain("source=env");
    expect(chosen).toBe(PINNED);
    expect(exit).not.toHaveBeenCalled();
    expect(lineWith(lines, "WARN")).toBe(
      `[models] WARN harness model NOT taken from registry — keeping $MODEL_ID ${PINNED}`,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Static pins — the three callers and the package list that broke them
// ───────────────────────────────────────────────────────────────────────────────

const SCRIPTS = [
  { path: "deploy/setup-builder-agent.mjs", importPath: "./pipeline/harness-model.mjs" },
  { path: "deploy/workflow-manager/setup-workflow-manager.mjs", importPath: "../pipeline/harness-model.mjs" },
  { path: "deploy/routine-builder/setup-routine-builder.mjs", importPath: "../pipeline/harness-model.mjs" },
];

describe.each(SCRIPTS)("$path uses the shared helper", ({ path, importPath }) => {
  const src = () => read(path);

  it(`imports ${importPath}`, () => {
    expect(src()).toContain(`from "${importPath}"`);
    expect(src()).toContain("resolveHarnessModel");
    expect(src()).toContain("loadRegistryDoc");
  });

  it("carries no inline copy of the read or the resolution", () => {
    const text = src();
    // The three copies of these were the bug: one fix, three places to miss.
    expect(text).not.toContain('import("@aws-sdk/client-s3")');
    expect(text).not.toMatch(/function\s+resolveDefaultModelId/);
    expect(text).not.toMatch(/function\s+loadRegistryDoc/);
    // ...and no copy of the now-wrong justification for having had them.
    expect(text).not.toContain("Inlined rather than shared");
  });

  it("still lets --model-id win and keeps its own literal tail", () => {
    const text = src();
    expect(text).toContain('const MODEL_ID_ARG = getArg("model-id")');
    expect(text).toMatch(/const LITERAL_MODEL_ID = "/);
    expect(text).toContain("literalModelId: LITERAL_MODEL_ID");
    expect(text).toContain("pipelineMode: PIPELINE_MODE");
  });

  it("resolves the region before S3, through one chain that accepts AWS_REGION_HUB", () => {
    expect(src()).toContain('process.env.AWS_REGION || process.env.AWS_REGION_HUB || "us-east-1"');
    expect(src()).toContain("region: REGION");
  });
});

describe("buildspec-deploy.yml Target 2b", () => {
  const buildspec = () => read("deploy/pipeline/buildspec-deploy.yml");

  it("installs @aws-sdk/client-s3 into the scratch node_modules", () => {
    const pkgs = buildspec()
      .split("\n")
      .find((l) => l.includes('PKGS="$(node -e'));
    expect(pkgs, "the Target 2b PKGS line").toBeTruthy();
    // The whole defect: the scripts read config/models.json from S3 and this list
    // is the only thing that puts the client in their node_modules.
    expect(pkgs).toContain('"@aws-sdk/client-s3"');
    // The three it always had must stay — STS/IAM are statically imported and the
    // control client is what UpdateHarness rides on.
    for (const pkg of [
      "@aws-sdk/client-bedrock-agentcore-control",
      "@aws-sdk/client-sts",
      "@aws-sdk/client-iam",
    ]) {
      expect(pkgs).toContain(`"${pkg}"`);
    }
    // Every package is pinned to the version root package.json carries.
    expect(pkgs).toContain('if(!d[n])throw new Error(n+" missing from package.json")');
  });

  it("names packages that root package.json actually declares", () => {
    const deps = JSON.parse(read("package.json")).dependencies;
    const pkgs = buildspec()
      .split("\n")
      .find((l) => l.includes('PKGS="$(node -e'));
    for (const name of pkgs.match(/@aws-sdk\/client-[a-z0-9-]+/g)) {
      expect(deps[name], `${name} must be a root dependency for the PKGS guard to pass`).toBeTruthy();
    }
  });
});

describe("the helper itself", () => {
  const src = () => read("deploy/pipeline/harness-model.mjs");

  it("plants no model id literal (DL-033: the literals belong to the callers)", () => {
    expect(src()).not.toMatch(/us\.anthropic\.|global\.anthropic\.|anthropic\.claude-|openai\.gpt-/);
  });

  it("imports no AWS SDK at the top level, so importing it costs nothing", () => {
    for (const line of src().split("\n")) {
      if (/^import\s/.test(line)) expect(line).not.toContain("@aws-sdk/");
    }
  });
});
