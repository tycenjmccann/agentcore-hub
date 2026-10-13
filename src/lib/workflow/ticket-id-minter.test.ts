import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * TEAM-5781 — the tickets Lambda (lambda/agentcore-hub-tickets/index.mjs
 * nextTicketId, behind create_ticket) must be the ONLY ticket-id minter: the
 * one place that bumps the `__COUNTER__` row and turns the result into a
 * `<PROJECT_KEY>-<n>` id. Two orphan copies of that exact UpdateExpression
 * existed outside it — lambda/orchestrator/index.mjs nextTicketId (zero
 * callers) and the webhook route's nextTicketId (called only from the dead
 * `request_fix` branch, which upserted the fix ticket straight into DynamoDB,
 * bypassing create_ticket's validation/gate guards/idempotency). Both are
 * deleted; this pins that nothing like them grows back.
 *
 * Source-scan, same idiom as tool-signature-parity.test.ts: pure text, no
 * imports (these Lambdas/routes construct AWS SDK clients at module scope),
 * fails on any new site that writes the literal counter-bump expression.
 */

const ROOT = join(__dirname, "..", "..", "..");
const COUNTER_BUMP = "SET #n = if_not_exists(#n, :zero) + :one";
const LEGITIMATE_MINTER = "lambda/agentcore-hub-tickets/index.mjs";

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const rel = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(rel, out);
    } else if (!/\.test\./.test(ent.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe("ticket-id minter (TEAM-5781): tickets Lambda is the only one", () => {
  it("the __COUNTER__ bump expression appears nowhere outside the tickets Lambda", () => {
    const candidates = [...walk("src"), ...walk("lambda")];
    const offenders = candidates.filter((rel) => {
      if (rel === LEGITIMATE_MINTER) return false;
      return readFileSync(join(ROOT, rel), "utf8").includes(COUNTER_BUMP);
    });
    expect(offenders).toEqual([]);
  });

  it("sanity: the legitimate minter is actually found by the scan (the detector works)", () => {
    const text = readFileSync(join(ROOT, LEGITIMATE_MINTER), "utf8");
    expect(text).toContain(COUNTER_BUMP);
  });
});
