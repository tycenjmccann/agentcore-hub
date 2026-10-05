import { describe, it, expect } from "vitest";
import {
  gateConditionActive as activeTs,
  deliverablePresent as presentTs,
} from "./workflow-defs";
// The orchestrator (Lambda) port. Both copies MUST agree: the TS twin decides
// which gates intake materializes, the .mjs decides whether the orchestrator
// pages a human for one — a drift means a gate is planned that is never
// resolved, or resolved that was never planned (DL-035).
import {
  gateConditionActive as activeMjs,
  deliverablePresent as presentMjs,
} from "../../../lambda/orchestrator/completion.mjs";

/**
 * DL-035 parity contract, shaped like review-cap-parity.test.ts: feed ONE shared
 * table of condition × requested × ctx through both gateConditionActive twins
 * and assert identical answers. The table is full of values a TS signature
 * forbids (null, 3, {}): workflows.json is hand-editable, so both twins must
 * mishandle those the same way — toward paging.
 */

const PR_URL = "https://github.com/o/r/pull/7";
const unreadable = new Proxy({}, { ownKeys() { throw new Error("unreadable row"); } });

const CONDITIONS: unknown[] = [
  "always",
  "flagged",
  undefined,
  null,
  "",
  3,
  {},
  "deliverable_present(kind=pr)",
  "deliverable_present(kind=zip)",
  "deliverable_present(kind=PR)",
  "nonsense",
];
const REQUESTED: unknown[] = [[], ["ship"], ["design"], undefined];
const CTXS: { name: string; ctx: unknown }[] = [
  { name: "no ctx", ctx: undefined },
  { name: "empty ctx", ctx: {} },
  { name: "with prUrl", ctx: { agentTasks: { T1: { prUrl: PR_URL }, T2: {} } } },
  { name: "without prUrl", ctx: { agentTasks: { T1: {}, T2: { prUrl: "  " } } } },
  { name: "null agentTasks", ctx: { agentTasks: null } },
  { name: "unreadable row", ctx: { agentTasks: unreadable } },
];

describe("gateConditionActive parity (TS ≡ mjs, DL-035)", () => {
  for (const condition of CONDITIONS) {
    for (const requested of REQUESTED) {
      for (const { name, ctx } of CTXS) {
        it(`condition=${JSON.stringify(condition)} requested=${JSON.stringify(requested)} ${name}`, () => {
          const gate = { afterPhase: "ship", condition };
          const ts = activeTs(gate, requested as string[], ctx as { agentTasks?: unknown });
          const mjs = activeMjs(gate, requested as string[], ctx);
          expect(ts).toBe(mjs);
        });
      }
    }
  }

  it("pins the shipped answers for the table's headline rows", () => {
    const g = (condition: string) => ({ afterPhase: "ship", condition });
    for (const active of [activeTs, activeMjs]) {
      expect(active(g("always"), [])).toBe(true);
      expect(active(g("flagged"), [])).toBe(false);
      expect(active(g("flagged"), ["ship"])).toBe(true);
      expect(active(g("deliverable_present(kind=pr)"), [], { agentTasks: { T1: { prUrl: PR_URL } } })).toBe(true);
      expect(active(g("deliverable_present(kind=pr)"), [], { agentTasks: { T1: {} } })).toBe(false);
      expect(active(g("deliverable_present(kind=pr)"), [])).toBe(true); // intake: planned as always
      expect(active(g("deliverable_present(kind=zip)"), [], { agentTasks: { T1: {} } })).toBe(true);
      expect(active(g("deliverable_present(kind=pr)"), [], { agentTasks: unreadable })).toBe(true);
    }
  });
});

describe("deliverablePresent parity (TS ≡ mjs, DL-035)", () => {
  const TASKS: unknown[] = [undefined, null, {}, { T1: { prUrl: PR_URL } }, { T1: { prUrl: " " } }, { T1: { prUrl: 7 } }, { T1: null }];
  for (const tasks of TASKS) {
    for (const kind of ["pr", "zip", ""]) {
      it(`tasks=${JSON.stringify(tasks)} kind=${kind}`, () => {
        expect(presentTs(tasks, kind)).toBe(presentMjs(tasks, kind));
      });
    }
  }
});
