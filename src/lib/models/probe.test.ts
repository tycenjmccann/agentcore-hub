import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  API_PROBE_PROMPT,
  CLI_PROBE_PROMPT,
  WORKSPACE_RE,
  runApiProbe,
  runCliProbe,
} from "./probe";
import type { CatalogRow } from "@/lib/models-registry";

/**
 * The CLI probe's whole value is that it does NOT trust the turn's own report:
 * it re-reads the file from a second process. So the tests here are about the
 * evidence path — which workspace the command uses, when no command is sent at
 * all, and that the session is always torn down.
 */

// vi.mock factories are hoisted, so the fakes they return have to be built
// inside vi.hoisted too — a top-level class would not exist yet.
const h = vi.hoisted(() => {
  /** Every command instance the fake clients were asked to send, in order. */
  const sent: Array<{ kind: string; input: unknown }> = [];
  /** Per command kind: a handler returning the fake response (or throwing). */
  let handlers: Record<string, (input: unknown) => unknown> = {};

  class FakeClient {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    async send(command: { __kind: string; input: unknown }) {
      sent.push({ kind: command.__kind, input: command.input });
      const handler = handlers[command.__kind];
      if (!handler) throw new Error(`unexpected command ${command.__kind}`);
      return handler(command.input);
    }
  }

  const fakeCommand = (kind: string) =>
    class {
      input: unknown;
      __kind = kind;
      constructor(input: unknown) {
        this.input = input;
      }
    };

  return {
    sent,
    get handlers() {
      return handlers;
    },
    set handlers(next: Record<string, (input: unknown) => unknown>) {
      handlers = next;
    },
    FakeClient,
    fakeCommand,
    mintBedrockBearerToken: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: h.FakeClient,
  InvokeAgentRuntimeCommand: h.fakeCommand("InvokeAgentRuntime"),
  InvokeAgentRuntimeCommandCommand: h.fakeCommand("InvokeAgentRuntimeCommand"),
  StopRuntimeSessionCommand: h.fakeCommand("StopRuntimeSession"),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: h.FakeClient,
  ConverseCommand: h.fakeCommand("Converse"),
}));

vi.mock("./sigv4", () => ({ mintBedrockBearerToken: h.mintBedrockBearerToken }));

const RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentcore_hub_coding_runtime-abc";

function row(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    modelId: "us.anthropic.claude-fable-5-1",
    label: "Claude Fable 5.1",
    vendor: "anthropic",
    family: "fable",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 200_000,
    aliases: [],
    status: "active",
    ...overrides,
  };
}

/** A turn reply as the coding runtime serializes it. */
function turnReply(body: Record<string, unknown>) {
  return { response: { transformToString: async () => JSON.stringify(body) } };
}

/** A command stream that emits `stdout` then a terminal status. */
function commandStream(stdout: string) {
  return {
    stream: (async function* () {
      // stdout arrives in arbitrary chunks; the probe must concatenate.
      yield { chunk: { contentDelta: { stdout: stdout.slice(0, 1) } } };
      yield { chunk: { contentDelta: { stdout: stdout.slice(1) } } };
      yield { chunk: { contentStop: { status: "completed" } } };
    })(),
  };
}

const sentKinds = () => h.sent.map((s) => s.kind);
const lastCommand = () =>
  (h.sent.filter((s) => s.kind === "InvokeAgentRuntimeCommand").at(-1)?.input as { body?: { command?: string } })
    ?.body?.command;

beforeEach(() => {
  h.sent.length = 0;
  h.handlers = {};
  h.mintBedrockBearerToken.mockReset().mockResolvedValue("bedrock-api-key-XYZ");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("WORKSPACE_RE", () => {
  it("accepts a real workspace path and rejects anything shell-active", () => {
    expect(WORKSPACE_RE.test("/mnt/workspace/sessions/cc-abc/repo-name")).toBe(true);
    for (const bad of [
      '/mnt/work"space',
      "/mnt/$HOME",
      "/mnt/work space",
      "/mnt/`id`",
      "/mnt/a\\b",
      "/mnt/a\nb",
      "/mnt/a;rm -rf /",
      "",
    ]) {
      expect(WORKSPACE_RE.test(bad)).toBe(false);
    }
  });
});

describe("runApiProbe", () => {
  it("runs a 16-token Converse turn for an anthropic row", async () => {
    h.handlers.Converse = () => ({ output: { message: { content: [{ text: "ok" }] } } });

    const outcome = await runApiProbe(row());

    expect(outcome.ok).toBe(true);
    expect(outcome.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof outcome.seconds).toBe("number");
    expect(outcome.error).toBeUndefined();
    expect(h.sent[0]).toEqual({
      kind: "Converse",
      input: {
        modelId: "us.anthropic.claude-fable-5-1",
        messages: [{ role: "user", content: [{ text: API_PROBE_PROMPT }] }],
        inferenceConfig: { maxTokens: 16 },
      },
    });
  });

  it("fails a Converse turn that produces no text", async () => {
    h.handlers.Converse = () => ({ output: { message: { content: [{ text: "  " }] } } });
    const outcome = await runApiProbe(row());
    expect(outcome).toMatchObject({ ok: false, error: "empty Converse output" });
  });

  it("never throws when the endpoint rejects the call", async () => {
    h.handlers.Converse = () => {
      throw new Error("AccessDeniedException");
    };
    expect(await runApiProbe(row())).toMatchObject({ ok: false, error: "AccessDeniedException" });
  });

  it("uses the Mantle Responses API with a Bearer token for an openai row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: "ok" })));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runApiProbe(
      row({ modelId: "openai.gpt-5.5", vendor: "openai", endpoint: "bedrock-mantle", region: "us-east-2", api: "responses" })
    );

    expect(outcome.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer bedrock-api-key-XYZ");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "openai.gpt-5.5",
      input: "Reply with ok",
      max_output_tokens: 16,
    });
    vi.unstubAllGlobals();
  });

  it("reports the HTTP status when the Responses call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    const outcome = await runApiProbe(row({ modelId: "openai.gpt-9", vendor: "openai", endpoint: "bedrock-mantle" }));
    expect(outcome).toMatchObject({ ok: false, error: "HTTP 404" });
    vi.unstubAllGlobals();
  });
});

describe("runCliProbe", () => {
  it("returns a clear failure when no coding runtime is configured", async () => {
    const outcome = await runCliProbe(row(), { runtimeArn: "" });
    expect(outcome).toMatchObject({ ok: false, error: "CODING_AGENT_RUNTIME_ARN is not set" });
    expect(h.sent).toEqual([]);
  });

  it("verifies the turn's work with a command against the workspace the TURN reported", async () => {
    h.handlers.InvokeAgentRuntime = () =>
      turnReply({ workspace: "/mnt/workspace/sessions/cc-abc/repo", response: "wrote it" });
    h.handlers.InvokeAgentRuntimeCommand = () => commandStream("ok\n");
    h.handlers.StopRuntimeSession = () => ({});

    const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN, region: "us-east-1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(sentKinds()).toEqual(["InvokeAgentRuntime", "InvokeAgentRuntimeCommand", "StopRuntimeSession"]);
    expect(lastCommand()).toBe(`bash -c 'cat "/mnt/workspace/sessions/cc-abc/repo/hello.txt"'`);

    const turn = h.sent[0].input as { payload: Uint8Array; runtimeSessionId: string; agentRuntimeArn: string };
    expect(turn.agentRuntimeArn).toBe(RUNTIME_ARN);
    expect(turn.runtimeSessionId.length).toBeGreaterThanOrEqual(33);
    expect(turn.runtimeSessionId.startsWith("probe-us-anthropic-claude-fable-5-1-")).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(turn.payload))).toMatchObject({
      prompt: CLI_PROBE_PROMPT,
      cli: "claude",
      model: "us.anthropic.claude-fable-5-1",
      origin: "probe",
      session_id: turn.runtimeSessionId,
    });

    const command = h.sent[1].input as { body: { timeout: number }; runtimeSessionId: string };
    expect(command.body.timeout).toBe(30);
    // Same session: the evidence must come from the container that did the work.
    expect(command.runtimeSessionId).toBe(turn.runtimeSessionId);
  });

  it("sends NO command when the turn reports no workspace", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ response: "I wrote hello.txt, honest" });
    h.handlers.StopRuntimeSession = () => ({});

    const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN });

    expect(outcome).toMatchObject({ ok: false, error: "no workspace in turn result" });
    // No guessed path: a cat against one can only produce a false result.
    expect(sentKinds()).toEqual(["InvokeAgentRuntime", "StopRuntimeSession"]);
  });

  it("sends NO command when the reported workspace is shell-active", async () => {
    for (const workspace of ['/mnt/work"space', "/mnt/$(id)", "/mnt/work space"]) {
      h.sent.length = 0;
      h.handlers.InvokeAgentRuntime = () => turnReply({ workspace });
      h.handlers.StopRuntimeSession = () => ({});

      const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN });

      expect(outcome).toMatchObject({ ok: false, error: "unsafe workspace path" });
      expect(sentKinds()).toEqual(["InvokeAgentRuntime", "StopRuntimeSession"]);
    }
  });

  it("fails when the file does not contain ok, quoting what it did contain", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ workspace: "/mnt/ws" });
    h.handlers.InvokeAgentRuntimeCommand = () => commandStream("cat: no such file\n");
    h.handlers.StopRuntimeSession = () => ({});

    const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("hello.txt did not contain ok");
    expect(outcome.error).toContain("cat: no such file");
  });

  it("treats a non-chunk stream member as the error channel", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ workspace: "/mnt/ws" });
    h.handlers.InvokeAgentRuntimeCommand = () => ({
      stream: (async function* () {
        yield { validationException: { message: "bad command" } };
      })(),
    });
    h.handlers.StopRuntimeSession = () => ({});

    const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN });
    expect(outcome).toMatchObject({ ok: false, error: "command stream error: validationException" });
  });

  it("stops the session even when the turn throws", async () => {
    h.handlers.InvokeAgentRuntime = () => {
      throw new Error("runtime unavailable");
    };
    h.handlers.StopRuntimeSession = () => ({});

    const outcome = await runCliProbe(row(), { runtimeArn: RUNTIME_ARN });

    expect(outcome).toMatchObject({ ok: false, error: "runtime unavailable" });
    expect(sentKinds()).toEqual(["InvokeAgentRuntime", "StopRuntimeSession"]);
    expect(h.sent[1].input).toEqual({
      runtimeSessionId: expect.any(String),
      agentRuntimeArn: RUNTIME_ARN,
      qualifier: "DEFAULT",
    });
  });

  it("does not let a failed teardown mask a successful probe", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ workspace: "/mnt/ws" });
    h.handlers.InvokeAgentRuntimeCommand = () => commandStream("ok\n");
    h.handlers.StopRuntimeSession = () => {
      throw new Error("already gone");
    };

    expect((await runCliProbe(row(), { runtimeArn: RUNTIME_ARN })).ok).toBe(true);
  });

  it("reports a runtime error payload rather than calling it a pass", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ error: "model not enabled" });
    h.handlers.StopRuntimeSession = () => ({});
    expect(await runCliProbe(row(), { runtimeArn: RUNTIME_ARN })).toMatchObject({
      ok: false,
      error: "model not enabled",
    });
  });

  it("drives codex for an openai row", async () => {
    h.handlers.InvokeAgentRuntime = () => turnReply({ workspace: "/mnt/ws" });
    h.handlers.InvokeAgentRuntimeCommand = () => commandStream("ok\n");
    h.handlers.StopRuntimeSession = () => ({});

    await runCliProbe(row({ modelId: "openai.gpt-5.5", vendor: "openai", endpoint: "bedrock-mantle" }), {
      runtimeArn: RUNTIME_ARN,
    });

    const payload = JSON.parse(
      new TextDecoder().decode((h.sent[0].input as { payload: Uint8Array }).payload)
    );
    expect(payload.cli).toBe("codex");
    expect(payload.model).toBe("openai.gpt-5.5");
  });
});
