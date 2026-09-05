// Infra read retry (TEAM-3405): a transient fs error reading case inputs
// (fixture seed, transcript, system prompt — e.g. an NFS/EFS lease blip) gets
// ONE retry, marked infraRetried; behavioral failures never take this path.
// Fake transports throughout — no AWS.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCase, isInfraReadError, isRetryableTransportError } from "../lib/agent-runner.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BATTERY_DIR = join(REPO_ROOT, "evals", "battery");

// chmod 000 only denies reads to non-root users; skip the integration tests
// when the suite happens to run as root.
const canDenyRead = typeof process.getuid === "function" && process.getuid() !== 0;

const coded = (code: string) => Object.assign(new Error(`${code}: boom`), { code });

// Minimal case with no required-tool guards, whose only pre-turn fs
// dependency we control via input.transcript (resolved relative to
// evals/battery, so escape to a temp dir with ../ segments).
const caseWithTranscript = (transcriptAbs: string) => ({
  id: "infra-retry-probe",
  targetAgentId: "agentcore_hub_qa_verifier",
  taskPrompt: "Say done.",
  timeoutSeconds: 30,
  modelTier: "haiku",
  evaluators: [],
  referenceInputs: {},
  input: { transcript: relative(BATTERY_DIR, transcriptAbs) },
});

const endTurn = () => ({
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  output: { message: { role: "assistant", content: [{ text: "done" }] } },
});

const signal = () => new AbortController().signal;

describe("isInfraReadError classification", () => {
  it("accepts the transient fs read codes an NFS lease blip produces", () => {
    for (const code of ["EACCES", "EIO", "ESTALE", "EBUSY", "EMFILE", "ENFILE"])
      expect(isInfraReadError(coded(code)), code).toBe(true);
  });
  it("rejects ENOENT — a missing file is a deterministic config error", () => {
    expect(isInfraReadError(coded("ENOENT"))).toBe(false);
  });
  it("rejects transport-shaped and code-less errors (no classifier overlap)", () => {
    expect(isInfraReadError(coded("ECONNRESET"))).toBe(false);
    expect(isInfraReadError(Object.assign(new Error("throttled"), { name: "ThrottlingException" }))).toBe(false);
    expect(isInfraReadError(new Error("plain"))).toBe(false);
    // And the transport classifier does not claim fs read errors either.
    expect(isRetryableTransportError(coded("EACCES"))).toBe(false);
  });
});

describe.runIf(canDenyRead)("runCase infra retry on unreadable case inputs", () => {
  it("retries once, marks infraRetried, and never reaches the model when the blip persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "battery-infra-"));
    const transcript = join(dir, "transcript.json");
    writeFileSync(transcript, JSON.stringify([{ role: "user", content: "context" }]));
    chmodSync(transcript, 0o000);
    let converseCalls = 0;
    try {
      const result = (await runCase({
        caseDef: caseWithTranscript(transcript),
        repoRoot: REPO_ROOT,
        runId: "test",
        converse: async () => (converseCalls++, endTurn()),
        signal: signal(),
        infraRetryDelayMs: 20,
      })) as any;
      expect(result.status).toBe("errored");
      expect(result.error).toContain("EACCES");
      expect(result.infraRetried).toBe(true);
      expect(converseCalls).toBe(0);
    } finally {
      chmodSync(transcript, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers when the blip clears before the retry (the NFS-lease scenario)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "battery-infra-"));
    const transcript = join(dir, "transcript.json");
    writeFileSync(transcript, JSON.stringify([{ role: "user", content: "context" }]));
    chmodSync(transcript, 0o000);
    setTimeout(() => chmodSync(transcript, 0o644), 60);
    try {
      const result = (await runCase({
        caseDef: caseWithTranscript(transcript),
        repoRoot: REPO_ROOT,
        runId: "test",
        converse: async () => endTurn(),
        signal: signal(),
        infraRetryDelayMs: 400,
      })) as any;
      expect(result.status).toBe("completed");
      expect(result.infraRetried).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what the infra retry must NOT touch", () => {
  it("ENOENT on a case input is not retried (deterministic config error)", async () => {
    const result = (await runCase({
      caseDef: caseWithTranscript(join(tmpdir(), "battery-infra-missing", "nope.json")),
      repoRoot: REPO_ROOT,
      runId: "test",
      converse: async () => endTurn(),
      signal: signal(),
      infraRetryDelayMs: 20,
    })) as any;
    expect(result.status).toBe("errored");
    expect(result.error).toContain("ENOENT");
    expect(result.infraRetried).toBe(false);
  });

  it("an fs-coded error AFTER the first model turn is not infra-retried", async () => {
    let converseCalls = 0;
    const dir = mkdtempSync(join(tmpdir(), "battery-infra-"));
    const transcript = join(dir, "transcript.json");
    writeFileSync(transcript, JSON.stringify([{ role: "user", content: "context" }]));
    try {
      const result = (await runCase({
        caseDef: caseWithTranscript(transcript),
        repoRoot: REPO_ROOT,
        runId: "test",
        converse: async () => {
          converseCalls++;
          throw coded("EACCES");
        },
        signal: signal(),
        infraRetryDelayMs: 20,
      })) as any;
      expect(result.status).toBe("errored");
      expect(result.infraRetried).toBe(false);
      expect(converseCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
