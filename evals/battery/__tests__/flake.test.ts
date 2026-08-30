// Flake-flag logic (TEAM-3090, FR-10): verdict flips ≥2 of the last 5 runs on
// unchanged config ⇒ flagged. Pure module, no AWS. Flags are informational
// only — flake.mjs never touches the gate verdict (that stays in thresholds.mjs).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configFingerprint,
  appendFlakeLedger,
  readFlakeLedger,
  flagFlakyCases,
  FLAKE_WINDOW,
  FLAKE_FLIP_THRESHOLD,
} from "../lib/flake.mjs";

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const entry = (caseId: string, verdict: string, fingerprint = "fp-1", runId = "run-x") => ({
  ts: "2026-08-28T00:00:00.000Z",
  runId,
  caseId,
  fingerprint,
  verdict,
});

describe("configFingerprint", () => {
  it("is stable across key order and changes with case def or prompt text", () => {
    const a = configFingerprint({ id: "c", modelTier: "haiku", evaluators: ["Builtin.Correctness"] }, "prompt");
    const b = configFingerprint({ evaluators: ["Builtin.Correctness"], modelTier: "haiku", id: "c" }, "prompt");
    expect(a).toBe(b);
    expect(configFingerprint({ id: "c", modelTier: "haiku", evaluators: ["Builtin.Correctness"] }, "prompt EDITED")).not.toBe(a);
    expect(configFingerprint({ id: "c", modelTier: "sonnet", evaluators: ["Builtin.Correctness"] }, "prompt")).not.toBe(a);
  });
});

describe("flagFlakyCases", () => {
  it("constants match the documented rule (last 5, ≥2 flips)", () => {
    expect(FLAKE_WINDOW).toBe(5);
    expect(FLAKE_FLIP_THRESHOLD).toBe(2);
  });

  it("0 flips ⇒ not flagged (all pass, and all fail)", () => {
    expect(flagFlakyCases(["pass", "pass", "pass", "pass", "pass"].map((v) => entry("c1", v)))).toEqual([]);
    expect(flagFlakyCases(["fail", "fail", "fail"].map((v) => entry("c1", v)))).toEqual([]);
  });

  it("1 flip ⇒ not flagged (a real regression is not a flake)", () => {
    expect(flagFlakyCases(["pass", "pass", "fail", "fail"].map((v) => entry("c1", v)))).toEqual([]);
  });

  it("2 flips in the last 5 ⇒ flagged with caseId, flips, window", () => {
    const flagged = flagFlakyCases(["pass", "fail", "pass"].map((v, i) => entry("c1", v, "fp-1", `run-${i}`)));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ caseId: "c1", flips: 2 });
    expect(flagged[0].window.map((w: any) => w.verdict)).toEqual(["pass", "fail", "pass"]);
  });

  it("flips across a fingerprint change do not count — a config change resets the window", () => {
    const ledger = [
      entry("c1", "pass", "fp-old"),
      entry("c1", "fail", "fp-old"),
      entry("c1", "pass", "fp-old"), // 2 flips, but under the OLD config
      entry("c1", "pass", "fp-new"),
      entry("c1", "pass", "fp-new"),
    ];
    expect(flagFlakyCases(ledger)).toEqual([]);
  });

  it("errored/timed_out verdicts count as fail", () => {
    const flagged = flagFlakyCases([entry("c1", "pass"), entry("c1", "errored"), entry("c1", "pass")]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].flips).toBe(2);
    expect(flagged[0].window.map((w: any) => w.verdict)).toEqual(["pass", "fail", "pass"]);
  });

  it("only the last 5 same-fingerprint entries count — older flips are ignored", () => {
    const ledger = ["pass", "fail", "pass", "pass", "pass", "pass", "pass"].map((v) => entry("c1", v));
    // slice(-5) = [pass, pass, pass, pass, pass] → 0 flips despite the old flip pair
    expect(flagFlakyCases(ledger)).toEqual([]);
  });

  it("flags per case independently", () => {
    const ledger = [
      ...["pass", "fail", "pass"].map((v) => entry("flaky-1", v)),
      ...["pass", "pass", "pass"].map((v) => entry("steady-1", v)),
    ];
    const flagged = flagFlakyCases(ledger);
    expect(flagged.map((f) => f.caseId)).toEqual(["flaky-1"]);
  });
});

describe("ledger io", () => {
  function tempLedger() {
    const dir = mkdtempSync(join(tmpdir(), "battery-flake-"));
    tempDirs.push(dir);
    return join(dir, "flake-ledger.jsonl");
  }

  it("append/read round-trips across multiple appends, and a missing file is empty", () => {
    const path = tempLedger();
    expect(readFlakeLedger(path)).toEqual([]);
    appendFlakeLedger(path, [entry("c1", "pass"), entry("c2", "fail")]);
    appendFlakeLedger(path, [entry("c1", "fail", "fp-1", "run-2")]);
    const back = readFlakeLedger(path);
    expect(back).toHaveLength(3);
    expect(back[2]).toMatchObject({ caseId: "c1", verdict: "fail", runId: "run-2" });
  });

  it("a corrupt line costs only itself", () => {
    const path = tempLedger();
    appendFlakeLedger(path, [entry("c1", "pass")]);
    // simulate a truncated write from a killed run
    appendFileSync(path, '{"caseId": "c2", "verd\n');
    appendFlakeLedger(path, [entry("c3", "fail")]);
    expect(readFlakeLedger(path).map((e: any) => e.caseId)).toEqual(["c1", "c3"]);
  });

  it("writes go through the C2 redaction choke point (redactText)", () => {
    const path = tempLedger();
    // "TEAM-" + digits is on the FORBIDDEN table (real Jira project key);
    // built by concatenation so this test file itself stays clean.
    const forbidden = "TEAM" + "-4242";
    appendFlakeLedger(path, [entry("c1", "pass", "fp-1", `run-${forbidden}`)]);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(forbidden);
    expect(raw).toContain("[REDACTED:");
    // the redacted line is still valid JSONL
    expect(readFlakeLedger(path)).toHaveLength(1);
  });
});
