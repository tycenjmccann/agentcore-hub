import { describe, it, expect } from "vitest";
import * as ticketsGateContract from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import {
  gateHoldState,
  parseTransitionResponse,
  type TransitionOutcome,
} from "./transition-result";
import { GATE_APPROVED_UNVERIFIED_RE, GATE_VERIFYING_RE } from "./decision-grammar";

describe("transition-result: parseTransitionResponse (TEAM-5339)", () => {
  it("a normal done 2xx is 'moved' to the response's newStatus, never the caller's targetStatus", () => {
    const outcome = parseTransitionResponse(200, { success: true, ticketId: "TEAM-1", newStatus: "done" });
    expect(outcome).toEqual({ kind: "moved", status: "done" });
  });

  it("carries the decision through on a moved outcome", () => {
    const outcome = parseTransitionResponse(200, { success: true, ticketId: "TEAM-1", newStatus: "done", decision: "repaired" });
    expect(outcome).toEqual({ kind: "moved", status: "done", decision: "repaired" });
  });

  it("TEAM-5338 F8: held/verifying is reported as held, never as done — the exact DDB/jira twin shape", () => {
    const body = {
      success: true, held: true, status: "verifying", ticketId: "TEAM-G", targetStatus: "done",
      newStatus: "in_review", verifyUntil: "2026-10-06T12:30:00.000Z",
      postCondition: { met: false, detail: "lambda_version: want 7, have 6" },
      decision: "continue",
    };
    const outcome = parseTransitionResponse(200, body);
    expect(outcome).toEqual({
      kind: "held",
      status: "in_review",
      verifyUntil: "2026-10-06T12:30:00.000Z",
      detail: "lambda_version: want 7, have 6",
      decision: "continue",
    });
  });

  it("held with a null verifyUntil/detail still parses (both are nullable in the contract)", () => {
    const outcome = parseTransitionResponse(200, {
      success: true, held: true, status: "verifying", newStatus: "in_review",
      verifyUntil: null, postCondition: { met: false, detail: null },
    });
    expect(outcome).toEqual({ kind: "held", status: "in_review", verifyUntil: null, detail: null });
  });

  it("a 2xx with no recognizable newStatus is an error, not a guess at targetStatus", () => {
    const outcome = parseTransitionResponse(200, { success: true });
    expect(outcome.kind).toBe("error");
  });

  it("a 2xx with an unknown status string is an error", () => {
    const outcome = parseTransitionResponse(200, { success: true, newStatus: "nonsense" });
    expect(outcome.kind).toBe("error");
  });

  it("409 decision_required maps to the required picker with the server's options", () => {
    const outcome = parseTransitionResponse(409, {
      error: "Ticket transition rejected", reason: "decision_required", options: ["repaired", "abort"],
      ticketId: "TEAM-1", targetStatus: "done",
    });
    expect(outcome).toEqual({ kind: "decision", notice: "required", options: ["repaired", "abort"] });
  });

  it("409 decision_required with no options falls back to an empty list (the modal falls back to declaredOptions)", () => {
    const outcome = parseTransitionResponse(409, {
      error: "Ticket transition rejected", reason: "decision_required", ticketId: "TEAM-1", targetStatus: "done",
    });
    expect(outcome).toEqual({ kind: "decision", notice: "required", options: [] });
  });

  it("403 decision_required is the service-identity notice regardless of detail", () => {
    const outcome = parseTransitionResponse(403, {
      error: "Ticket transition rejected", reason: "decision_required", ticketId: "TEAM-1", targetStatus: "done",
    });
    expect(outcome).toEqual({ kind: "decision", notice: "service", options: [] });
  });

  it("409 decision_required with decision_channel_unavailable is the channel notice", () => {
    const outcome = parseTransitionResponse(409, {
      error: "Ticket transition rejected", reason: "decision_required", detail: "decision_channel_unavailable",
      ticketId: "TEAM-1", targetStatus: "done",
    });
    expect(outcome).toEqual({ kind: "decision", notice: "channel", options: [] });
  });

  it("any other 409 is a generic error carrying the server's message", () => {
    const outcome = parseTransitionResponse(409, { error: "Ticket transition rejected", details: "nope" });
    expect((outcome as TransitionOutcome & { kind: "error" }).kind).toBe("error");
  });

  it("a non-JSON / empty body still produces an error, not a throw", () => {
    const outcome = parseTransitionResponse(500, {});
    expect(outcome).toEqual({ kind: "error", message: "HTTP 500" });
  });
});

describe("transition-result: gateHoldState (TEAM-5339 requirement 4)", () => {
  it("no labels → no hold", () => {
    expect(gateHoldState({})).toBeNull();
  });

  it("gate:verifying (colon form) with a gateVerify.verifyUntil and lastProbe.detail", () => {
    expect(gateHoldState({
      labels: ["gate:verifying"],
      gateVerify: { verifyUntil: "2026-10-06T12:30:00.000Z", lastProbe: { detail: "lambda_version: want 7, have 6" } },
    })).toEqual({ kind: "verifying", verifyUntil: "2026-10-06T12:30:00.000Z", detail: "lambda_version: want 7, have 6" });
  });

  it("gate-verifying (Jira hyphen rewrite) with no gateVerify → verifyUntil/detail null", () => {
    expect(gateHoldState({ labels: ["gate-verifying"] })).toEqual({ kind: "verifying", verifyUntil: null, detail: null });
  });

  it("gate:approved-unverified (colon form)", () => {
    expect(gateHoldState({ labels: ["gate:approved-unverified"] })).toEqual({ kind: "approved-unverified" });
  });

  it("gate-approved-unverified (Jira hyphen rewrite)", () => {
    expect(gateHoldState({ labels: ["gate-approved-unverified"] })).toEqual({ kind: "approved-unverified" });
  });

  it("approved-unverified wins over a stale verifying label on the same ticket", () => {
    expect(gateHoldState({ labels: ["gate:verifying", "gate:approved-unverified"] }))
      .toEqual({ kind: "approved-unverified" });
  });

  it("ignores an unrelated label and a non-array labels field", () => {
    expect(gateHoldState({ labels: ["reviewer:ops", "wf:abc"] })).toBeNull();
    expect(gateHoldState({ labels: "gate:verifying" as unknown as string[] })).toBeNull();
  });
});

// TEAM-5339 R-3 (parity): the TS mirrors of the two gate labels this helper reads
// must agree with the canonical copy the twins actually write — a drift here would
// mean the console silently stops recognizing a real hold/re-page.
describe("transition-result: label regex parity with the canonical gate contract", () => {
  it("GATE_VERIFYING_RE matches the same strings as the tickets twin's regex", () => {
    expect(GATE_VERIFYING_RE.source).toBe(ticketsGateContract.GATE_VERIFYING_RE.source);
  });

  it("GATE_APPROVED_UNVERIFIED_RE matches the same strings as the tickets twin's regex", () => {
    expect(GATE_APPROVED_UNVERIFIED_RE.source).toBe(ticketsGateContract.GATE_APPROVED_UNVERIFIED_RE.source);
  });
});
