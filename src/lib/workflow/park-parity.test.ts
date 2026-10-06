import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-5323 — the hub's unparkTicket (src/lib/workflow/park.ts) is a copy of the
 * orchestrator store's (lambda/orchestrator/workflow-store.mjs): separate
 * deployables, one DL-035 contract. If the store ever clears a park differently
 * (another map, a different guard), the hub's retry/nudge must follow, so the
 * two are pinned to the same text here.
 */

const root = resolve(__dirname, "../../..");
const store = readFileSync(resolve(root, "lambda/orchestrator/workflow-store.mjs"), "utf8");
const park = readFileSync(resolve(root, "src/lib/workflow/park.ts"), "utf8");

function bodyOf(src: string, signature: RegExp): string {
  const m = signature.exec(src);
  expect(m, String(signature)).not.toBeNull();
  const start = m!.index;
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

const literal = (body: string, key: string) => {
  const m = new RegExp(`${key}:\\s*"([^"]+)"`).exec(body);
  expect(m, key).not.toBeNull();
  return m![1];
};

describe("unparkTicket parity — park.ts ≡ workflow-store.mjs", () => {
  const storeBody = bodyOf(store, /export async function unparkTicket\(/);
  const hubBody = bodyOf(park, /export async function unparkTicket\(/);

  it("UpdateExpression is identical", () => {
    expect(literal(hubBody, "UpdateExpression")).toBe(literal(storeBody, "UpdateExpression"));
    expect(literal(storeBody, "UpdateExpression")).toBe("REMOVE parkedTickets.#t, redispatchCounts.#t");
  });

  it("ConditionExpression is identical", () => {
    expect(literal(hubBody, "ConditionExpression")).toBe(literal(storeBody, "ConditionExpression"));
  });

  it("names the ticket through the same placeholder and treats a failed condition as false", () => {
    for (const body of [storeBody, hubBody]) {
      expect(body).toMatch(/ExpressionAttributeNames:\s*\{\s*"#t":\s*ticketId\s*\}/);
      expect(body).toMatch(/ConditionalCheckFailedException"\) return false;/);
    }
  });

  it("the claim CAS still refuses a parked ticket — what makes a clear necessary", () => {
    const claim = bodyOf(store, /export async function claimInvocation\(/);
    expect(claim).toContain("attribute_not_exists(parkedTickets.#tid)");
  });
});
