import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import seed from "@/config/models.json";
import type { ModelsRegistry } from "@/lib/models-registry";

/**
 * TEAM-4997 — GET /api/models, the intake picker.
 *
 * It used to be two hardcoded rows whose default (sonnet-5) contradicted every
 * other surface's (fable-5-1). These tests pin the three things that made the
 * hardcoding dangerous: WHICH rows are offerable, that exactly one of them is the
 * default and that it is `defaults.persona`, and that the OpenAI append — the one
 * part of the old contract callers depend on — is unchanged.
 */

const h = vi.hoisted(() => ({
  state: { objects: {} as Record<string, string> },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (cmd.constructor.name !== "GetObjectCommand") throw new Error("unexpected S3 write");
      const body = h.state.objects[cmd.input.Key as string];
      if (body === undefined) {
        const e = new Error("no such key");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body }, ETag: '"etag"' };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";

let GET: typeof import("./route").GET;

async function load() {
  vi.resetModules();
  ({ GET } = await import("./route"));
}

function seat(mutate: (reg: ModelsRegistry) => void = () => {}): void {
  const doc = JSON.parse(JSON.stringify(SEED)) as ModelsRegistry;
  mutate(doc);
  h.state.objects[MODELS_KEY] = JSON.stringify(doc);
}

async function models() {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()).models as Array<Record<string, unknown>>;
}

const SAVED = ["ARTIFACT_BUCKET", "OPENAI_API_KEY_ARN"] as const;
const savedEnv: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(async () => {
  h.state.objects = {};
  for (const k of SAVED) savedEnv[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
  delete process.env.OPENAI_API_KEY_ARN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await load();
});

afterEach(() => {
  for (const k of SAVED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("GET /api/models", () => {
  it("offers only rows that are active, priced and routable", async () => {
    seat();
    const list = await models();
    const ids = list.map((m) => m.modelId);

    expect(ids).toContain("us.anthropic.claude-fable-5-1");
    // Retired: the model is gone.
    expect(ids).not.toContain("us.anthropic.claude-opus-4-8");
    // readOnly: kept for cost attribution, never routed to.
    expect(ids).not.toContain("anthropic.claude-opus-5");
    // Every offered row has a price — an unpriced one would bill at the
    // pricing `default` rate and make its own cost card a guess.
    for (const m of list) {
      if (m.provider === "openai") continue;
      const row = SEED.catalog.find((r) => r.modelId === m.modelId)!;
      expect(row.status).toBe("active");
      expect(row.price).toBeTruthy();
      expect(row.readOnly).toBeFalsy();
    }
  });

  it("excludes a candidate and an unpriced row", async () => {
    // Neither row is a routing target: an unpriced TARGET makes the whole
    // document invalid, and the loader would answer from the seed instead
    // (TEAM-5008 finding 3), which is a different behaviour than this test pins.
    seat((reg) => {
      reg.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!.status = "candidate";
      delete reg.catalog.find((r) => r.modelId === "global.anthropic.claude-sonnet-5")!.price;
    });
    const ids = (await models()).map((m) => m.modelId);
    expect(ids).not.toContain("us.anthropic.claude-opus-5-5");
    expect(ids).not.toContain("global.anthropic.claude-sonnet-5");
  });

  it("marks exactly one default, and it is defaults.persona", async () => {
    seat();
    const list = await models();
    const defaults = list.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      modelId: "us.anthropic.claude-fable-5-1",
      label: "Claude Fable 5.1 (Recommended)",
    });
  });

  it("follows the registry when the persona default moves", async () => {
    seat((reg) => {
      reg.defaults.persona = "us.anthropic.claude-sonnet-5";
    });
    const list = await models();
    expect(list.filter((m) => m.isDefault).map((m) => m.modelId)).toEqual(["us.anthropic.claude-sonnet-5"]);
    expect(list.find((m) => m.modelId === "us.anthropic.claude-fable-5-1")!.isDefault).toBeUndefined();
  });

  it("uses a bare alias as the option id, falling back to the model id", async () => {
    seat();
    const list = await models();
    expect(list.find((m) => m.modelId === "us.anthropic.claude-fable-5-1")!.id).toBe("claude-fable-5-1");
    // A `global.*` row has no bare alias of its own.
    expect(list.find((m) => m.modelId === "global.anthropic.claude-opus-5")!.id).toBe(
      "global.anthropic.claude-opus-5"
    );
    // Ids stay unique — they key the picker's <option> elements.
    const ids = list.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes where a model runs and what it costs", async () => {
    seat();
    const list = await models();
    expect(list.find((m) => m.modelId === "us.anthropic.claude-fable-5-1")!.description).toBe(
      "Bedrock (us-east-1) - $11/$55 per 1M in/out - 200K context."
    );
    expect(list.find((m) => m.modelId === "openai.gpt-5.5")!.description).toContain("Bedrock Mantle (us-east-2)");
  });

  it("appends gpt-4-turbo only when OPENAI_API_KEY_ARN is set, unchanged", async () => {
    seat();
    expect((await models()).some((m) => m.id === "gpt-4-turbo")).toBe(false);

    process.env.OPENAI_API_KEY_ARN = "arn:aws:secretsmanager:us-east-1:1234:secret:openai";
    const list = await models();
    expect(list[list.length - 1]).toEqual({
      id: "gpt-4-turbo",
      label: "GPT-4 Turbo (OpenAI)",
      provider: "openai",
      modelId: "gpt-4-turbo-preview",
      description: "OpenAI's most capable model.",
    });
  });

  it("serves the bundled seed when the live document is unreadable", async () => {
    // No object seated at all: the loader falls back rather than serving nothing.
    const list = await models();
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((m) => m.isDefault)).toHaveLength(1);
  });
});
