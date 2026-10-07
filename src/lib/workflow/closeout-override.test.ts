import { describe, it, expect } from "vitest";
import {
  CLOSEOUT_OVERRIDE_KEY,
  CLOSEOUT_OVERRIDE_REASON_MAX,
  buildCloseoutOverride,
  offenderSetHash,
  verifyCloseoutOverride,
} from "./closeout-override";
import { parseCloseoutOverride } from "./performance";
import { closeoutOverrideCovers } from "./completion-evidence";

/** TEAM-5358 FR-2 / F1 — the signed closeout override record. */
const KEY = "closeout-override-test-key";
const build = (over: Partial<Parameters<typeof buildCloseoutOverride>[0]> = {}, key = KEY) =>
  buildCloseoutOverride({ workflowId: "wf_1", by: "eng@example.com", reason: "known gap", offenders: ["T-2", "T-1", "T-2"], ...over }, key);
const raw = (r: unknown) => JSON.stringify(r);

describe("closeout override record", () => {
  it("lives at the key every TEAM-5359 reader parses", () => {
    expect(CLOSEOUT_OVERRIDE_KEY("wf_1")).toBe("workflows/wf_1/shared/closeout-override.json");
  });

  it("build -> verify round-trips, offenders sorted and de-duplicated", () => {
    const r = build();
    expect(r.offenders).toEqual(["T-1", "T-2"]);
    expect(r.offenderSetHash).toBe(offenderSetHash(["T-2", "T-1"]));
    expect(verifyCloseoutOverride(raw(r), [KEY], "wf_1")).toEqual({ by: "eng@example.com", reason: "known gap", offenders: ["T-1", "T-2"], at: r.at });
  });

  it("the shared parser (orchestrator, cost-report, performance) reads the signed record unchanged", () => {
    const r = build();
    expect(parseCloseoutOverride(raw(r))).toEqual({ by: r.by, reason: r.reason, offenders: r.offenders, at: r.at });
    expect(closeoutOverrideCovers(verifyCloseoutOverride(raw(r), [KEY], "wf_1"), ["T-1", "T-2@review"])).toBe(true);
  });

  it("verify rejects a record whose sig was made with another key; accepts it under a rotated key list", () => {
    const r = build({}, "other-key");
    expect(verifyCloseoutOverride(raw(r), [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw(r), [KEY, "other-key"], "wf_1")).not.toBeNull();
  });

  it("verify rejects edited offenders (with and without a recomputed hash)", () => {
    const r = build();
    expect(verifyCloseoutOverride(raw({ ...r, offenders: ["T-1", "T-2", "T-3"] }), [KEY], "wf_1")).toBeNull();
    const offenders = ["T-1", "T-2", "T-3"];
    expect(verifyCloseoutOverride(raw({ ...r, offenders, offenderSetHash: offenderSetHash(offenders) }), [KEY], "wf_1")).toBeNull();
  });

  it("verify rejects another run's record, a wrong version or kind, and edited by/reason", () => {
    const r = build();
    expect(verifyCloseoutOverride(raw(r), [KEY], "wf_2")).toBeNull();
    expect(verifyCloseoutOverride(raw({ ...r, v: 2 }), [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw({ ...r, kind: "gate-decision" }), [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw({ ...r, by: "agent" }), [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw({ ...r, reason: "other" }), [KEY], "wf_1")).toBeNull();
  });

  it("unsigned, unparseable, absent, or no keys -> null (never throws)", () => {
    const { sig: _sig, ...unsigned } = build();
    expect(verifyCloseoutOverride(raw(unsigned), [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride("{not json", [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(null, [KEY], "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw(build()), null, "wf_1")).toBeNull();
    expect(verifyCloseoutOverride(raw(build()), [], "wf_1")).toBeNull();
  });

  it("the reason is required, stripped of control chars, and clamped", () => {
    expect(() => build({ reason: " \u0007 " })).toThrow(/reason/);
    expect(() => build({ by: "" })).toThrow(/by/);
    const r = build({ reason: "a\u0000b" + "x".repeat(2000) });
    expect(r.reason.startsWith("abx")).toBe(true);
    expect(r.reason.length).toBe(CLOSEOUT_OVERRIDE_REASON_MAX);
  });
});
