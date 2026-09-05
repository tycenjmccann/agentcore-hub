import { describe, it, expect } from "vitest";
import { classifyProtection as classifyTs, PROTECTION_REQUIREMENTS as REQS_TS } from "./repo-check";
// The orchestrator (Lambda) port. Both copies MUST agree: the .mjs one decides
// whether a run publishes workflow.protection_warning, the .ts one is what the
// console/API path reports — a drift means the UI and the run disagree about
// whether the default branch could even enforce the Merge Approval gate.
import {
  classifyProtection as classifyMjs,
  PROTECTION_REQUIREMENTS as REQS_MJS,
} from "../../../lambda/orchestrator/repo-check.mjs";

/**
 * TEAM-3991 D1.1 parity contract (same shape as lease-parity.test.ts): drive the
 * SAME (protection status × protection body × rules status × rules body) matrix
 * through both classifyProtection implementations and assert identical results.
 */
const PROTECTION_BODIES: Array<[string, unknown]> = [
  ["absent", null],
  ["full", { required_pull_request_reviews: { required_approving_review_count: 2 }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false } }],
  ["pr-no-approvals", { required_pull_request_reviews: { required_approving_review_count: 0 }, enforce_admins: { enabled: false }, allow_force_pushes: { enabled: true } }],
  ["pr-only", { required_pull_request_reviews: {} }],
  ["admins-only", { enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false } }],
  ["empty-object", {}],
  ["message", { message: "Branch not protected" }],
];

const RULES_BODIES: Array<[string, unknown]> = [
  ["absent", null],
  ["empty", []],
  ["pr+ff+del", [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "non_fast_forward" }, { type: "deletion" }]],
  ["pr-zero", [{ type: "pull_request", parameters: { required_approving_review_count: 0 } }]],
  ["ff-only", [{ type: "non_fast_forward" }]],
  ["unrelated", [{ type: "creation" }]],
  ["not-an-array", { message: "Not Found" }],
];

const STATUSES: Array<number | null> = [null, 200, 401, 403, 404, 409, 500];

describe("classifyProtection parity: repo-check.ts ≡ repo-check.mjs", () => {
  it("exposes the same requirement vocabulary", () => {
    expect(REQS_TS).toEqual(REQS_MJS);
  });

  it("agrees on every status × body combination", () => {
    let compared = 0;
    for (const protectionStatus of STATUSES) {
      for (const [, protectionJson] of PROTECTION_BODIES) {
        for (const rulesStatus of STATUSES) {
          for (const [, rulesJson] of RULES_BODIES) {
            const probe = { protectionStatus, protectionJson, rulesStatus, rulesJson } as never;
            expect(classifyTs(probe)).toEqual(classifyMjs(probe));
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(STATUSES.length ** 2 * PROTECTION_BODIES.length * RULES_BODIES.length);
  });

  it("agrees on the undefined-probe default", () => {
    expect(classifyTs()).toEqual(classifyMjs());
  });
});
