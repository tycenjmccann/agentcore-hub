import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-5323 / TEAM-5345 F3 — the hub's unparkTicket (src/lib/workflow/park.ts) is
 * a copy of the orchestrator store's (lambda/orchestrator/workflow-store.mjs):
 * separate deployables, one DL-035 contract. The clear is defined ONCE as the
 * store's PARK_CLEAR_WRITES (one scoped write per map, legacy leaf first); the hub
 * carries the same literal. If the store ever clears a park differently (another
 * leaf, a different guard, a different order), the hub's retry/nudge must follow,
 * so every expression is pinned to the store's text here.
 */

const root = resolve(__dirname, "../../..");
const store = readFileSync(resolve(root, "lambda/orchestrator/workflow-store.mjs"), "utf8");
const park = readFileSync(resolve(root, "src/lib/workflow/park.ts"), "utf8");

function bodyOf(src: string, signature: RegExp): string {
  const m = signature.exec(src);
  expect(m, String(signature)).not.toBeNull();
  const start = m!.index;
  const end = src.indexOf("\n];\n", start);
  expect(end, `end of ${signature}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The `{ update, condition }` literals of a PARK_CLEAR_WRITES declaration, in order. */
function writesOf(src: string) {
  const body = bodyOf(src, /export (?:const|async function)?\s*PARK_CLEAR_WRITES[^=]*=\s*\[/);
  return [...body.matchAll(/\{\s*update:\s*"([^"]+)",\s*condition:\s*"([^"]+)"\s*\}/g)].map((m) => ({ update: m[1], condition: m[2] }));
}

const fnBody = (src: string, signature: RegExp) => {
  const m = signature.exec(src);
  expect(m, String(signature)).not.toBeNull();
  return src.slice(m!.index, src.indexOf("\n}\n", m!.index));
};

describe("unparkTicket parity — park.ts ≡ workflow-store.mjs (PARK_CLEAR_WRITES)", () => {
  const storeWrites = writesOf(store);
  const hubWrites = writesOf(park);

  it("the clear is the same ordered list of scoped writes in both deployables", () => {
    expect(storeWrites.length).toBeGreaterThan(0);
    expect(hubWrites).toEqual(storeWrites);
  });

  it("clears every DL-035 leaf: the park, the budget AND the legacy counter (TEAM-5345 F3)", () => {
    const leaves = new Set(storeWrites.flatMap((w) => [...w.update.matchAll(/([A-Za-z]+)\.#t/g)].map((m) => m[1])));
    expect(leaves).toEqual(new Set(["deadSessionRetries", "parkedTickets", "redispatchCounts"]));
    // Every write is guarded by the existence of the map it removes through — a
    // REMOVE through a missing map is a ValidationException, not a no-op.
    for (const w of storeWrites) {
      for (const leaf of leaves) if (w.update.includes(`${leaf}.#t`)) expect(w.condition).toContain(`attribute_exists(${leaf})`);
    }
    expect(storeWrites[0].update).toBe("REMOVE deadSessionRetries.#t"); // legacy leaf first
  });

  it("both loops name the ticket through the same placeholder and treat a lost condition as not-cleared", () => {
    for (const body of [fnBody(store, /export async function unparkTicket\(/), fnBody(park, /export async function unparkTicket\(/)]) {
      expect(body).toMatch(/for \(const w of PARK_CLEAR_WRITES\)/);
      expect(body).toMatch(/ExpressionAttributeNames:\s*\{\s*"#t":\s*ticketId\s*\}/);
      expect(body).toMatch(/ConditionalCheckFailedException"\) throw err;/);
      expect(body).toMatch(/cleared = true;/);
    }
  });

  it("the store's legacy-reset name is the same clear (no second definition)", () => {
    expect(store).toMatch(/export const resetDeadSessionRetry = unparkTicket;/);
  });

  it("the claim CAS still refuses a parked ticket — what makes a clear necessary", () => {
    const claim = fnBody(store, /export async function claimInvocation\(/);
    expect(claim).toContain("attribute_not_exists(parkedTickets.#tid)");
  });
});
