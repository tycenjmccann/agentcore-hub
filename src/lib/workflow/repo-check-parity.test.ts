import { describe, it, expect } from "vitest";
import { classifyProtection as classifyTs, PROTECTION_REQUIREMENTS as REQS_TS, checkRepoUrl as checkRepoUrlTs } from "./repo-check";
// The orchestrator (Lambda) port. Both copies MUST agree: the .mjs one decides
// whether a run publishes workflow.protection_warning, the .ts one is what the
// console/API path reports — a drift means the UI and the run disagree about
// whether the default branch could even enforce the Merge Approval gate.
import {
  classifyProtection as classifyMjs,
  PROTECTION_REQUIREMENTS as REQS_MJS,
  checkRepoUrl as checkRepoUrlMjs,
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

/**
 * TEAM-3992 D4.1 — checkRepoUrl now keeps the GitHub body (default_branch,
 * full_name) and flags a renamed/transferred repo. The API path (.ts) and the
 * dispatch path (.mjs) MUST resolve these identically, or a run and the console
 * would disagree about which branch is the base and which owner/name is canonical.
 */
type Route = { status: number; json?: unknown; url?: string; redirected?: boolean };
function fakeFetch(routes: Record<string, Route>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    void init;
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const r: Route = hit ? hit[1] : { status: 404, json: { message: "Not Found" } };
    return {
      status: r.status,
      ok: r.status < 400,
      url: r.url ?? url,
      redirected: r.redirected ?? false,
      json: async () => r.json ?? {},
    } as unknown as Response;
  }) as typeof fetch;
}

describe("checkRepoUrl parity: repo-check.ts ≡ repo-check.mjs (D4.1 body capture)", () => {
  const GOOD = "https://github.com/tycenjmccann/agentcore-hub";
  const SCENARIOS: Array<[string, Record<string, Route>]> = [
    ["200 + main + full_name", { "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub", default_branch: "main" } } }],
    ["200 + master", { "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub", default_branch: "master" } } }],
    ["301 rename (redirected)", { "/repos/tycenjmccann/agentcore-hub": { status: 200, redirected: true, url: "https://api.github.com/repos/tycenjmccann/agentcore-console", json: { full_name: "tycenjmccann/agentcore-console", default_branch: "main" } } }],
    ["full_name mismatch only", { "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "newowner/agentcore-hub", default_branch: "develop" } } }],
    ["200 empty body", { "/repos/tycenjmccann/agentcore-hub": { status: 200, json: {} } }],
  ];

  it("resolves the same defaultBranch/fullName/renamed/owner/repo across both twins", async () => {
    for (const [, routes] of SCENARIOS) {
      const ts = await checkRepoUrlTs(GOOD, { token: "t", fetchImpl: fakeFetch(routes) });
      const mjs = await checkRepoUrlMjs(GOOD, { token: "t", fetchImpl: fakeFetch(routes) });
      expect(ts).toEqual(mjs);
    }
  });
});
