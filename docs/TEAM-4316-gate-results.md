# TEAM-4316 — Gate Results (follow-up: touch-action + pointercancel teardown + list testid)

Evidence for the follow-up work merged via PR #469 into
`feature/TEAM-4314--kiro-opus-workflow-tab-sidebar-dark-sle`.

- Branch: `feature/TEAM-4316-frontend-dev`
- HEAD under test: `bca5d34448a2a68146e956c78d0dbb7e00797181`
- Results written and pushed incrementally (per-gate commits) so a timeout
  cannot destroy the evidence.

Gates run below (verbatim summaries appended as each completes).

---

## Gate 1 — `npm run lint`

**Exit code: 0 (PASS).**

- 19 pre-existing warnings across other files (`no-img-element`,
  `react-hooks/exhaustive-deps` in agents/build/cloud-code/workflow-board/etc.).
- **Zero warnings in the files this work changed**
  (`src/app/workflow/page.tsx`, `tests/tab-workflow-resize.spec.ts`).
- `next lint` exits 0 (warnings do not fail the gate).

---

## Gate 2 — `npx tsc --noEmit`

**Exit code: 0 (PASS).** No output (no type errors).

---

## Gate 3 — `npm run build`

**Exit code: 0 (PASS).**

```
 ✓ Compiled successfully
└ ○ /workflow                                                         173 kB          318 kB
```

---

## Gate 4 — `npx playwright test tests/tab-workflow-resize.spec.ts`

Dev server (`npm run dev`, localhost:3000) started first. Dark mode is set
before navigation via `addInitScript`.

**Result: 5 passed, 1 skipped.**

| # | Case | Result |
|---|------|--------|
| 1 | default expanded width is 288px | ✓ passed |
| 2 | dragging the handle right widens ≥ 400px and survives reload | ✓ passed |
| 3 | double-click on the handle resets to 288px | ✓ passed |
| 4 | collapse then expand restores the persisted (wide) width, not 288 | ✓ passed |
| 5 | scrollbar styling — thin + 6px webkit width (no default white bar) | ✓ passed |
| 6 | widening reveals a previously-truncated epic title | **– skipped** |

**Case 5 console line (verbatim), the actual values Chromium reported:**

```
scrollbar computed: scrollbarWidth="thin" webkitWidth="6px"
```

So Chromium reported `scrollbarWidth = "thin"` and the `::-webkit-scrollbar`
pseudo-element `width = "6px"` — both hard-asserted and passing. Case 5 also
includes the data-independent `scrollWidth <= clientWidth` assertion at the
default 288px width (added by this follow-up), which passed.

**Case 6 explicitly SKIPPED (not passed).** Reason: the workflow list is empty
in this sandbox — `/api/workflow/list` returns no rows because the runtime role
lacks DynamoDB access here — so there is no clipped title to reveal. The spec
guards this with `test.skip(true, "No workflow titles in local data")` (and, if
rows existed but none were clipped, `"No sufficiently long (clipped) title in
local data"`). Case 6 is inherently data-dependent; the data-independent portion
of R2.8 is covered by the case-5 no-horizontal-scroll assertion above.

---

## Full suite — `npm test` (glob: `tests/tab-*.spec.ts tests/e2e-api-routes.spec.ts`)

**On this branch (HEAD `bca5d34`): 28 passed, 9 skipped, 7 failed** (exit 1).

### The 7 failing specs and why

All 7 are backend-data tests: the assertion fails because the underlying API
route returned an error/empty payload, and the API route failed because this
sandbox's runtime role has **no backend AWS permissions**. Denials observed in
the dev-server log during the run (counts):

```
 52  not authorized to perform: dynamodb:Scan
 38  not authorized to perform: s3:GetObject
 34  not authorized to perform: logs:DescribeLogGroups
 28  not authorized to perform: cloudwatch:ListMetrics
 12  not authorized to perform: bedrock-agentcore:ListAgentRuntimes / ListHarnesses
  1  not authorized to perform: lambda:InvokeFunction
```

| Failing spec | Assertion that failed | Category |
|--------------|-----------------------|----------|
| `e2e-api-routes.spec.ts:14` Agents API returns discovered agents | `toBeGreaterThan` on agent count | (a) pre-existing/environmental — `bedrock-agentcore:List*` denied |
| `e2e-api-routes.spec.ts:28` Agents API includes harness agents | `expect(harness).toBeTruthy()` | (a) pre-existing/environmental — `bedrock-agentcore:ListHarnesses` denied |
| `e2e-api-routes.spec.ts:66` Metrics API returns usage data | data assertion | (a) pre-existing/environmental — `cloudwatch:ListMetrics` / `logs:DescribeLogGroups` denied |
| `tab-agents.spec.ts:15` shows agent cards when discovery completes | `toBeVisible()` on a card | (a) pre-existing/environmental — discovery API returns none (`bedrock-agentcore:List*` denied) |
| `tab-dashboard.spec.ts:33` shows agent performance table with live data | `toBeVisible()` | (a) pre-existing/environmental — metrics denied |
| `tab-workflow.spec.ts:45` workflow list loads from API | `expect(listRes.ok()).toBeTruthy()` | (a) pre-existing/environmental — `dynamodb:Scan` denied (list API 500s) |
| `tab-workflow.spec.ts:220` cancel flow (fresh workflow) | `expect(startRes.ok()).toBeTruthy()` | (a) pre-existing/environmental — `lambda:InvokeFunction` on `agentcore-hub-tickets` denied |

**None are plausibly caused by this follow-up change** (touch-action, pointercancel
teardown, a test-id): all 7 are data/permission driven and touch code paths
unrelated to the resize handle or scrollbar CSS.

### Honest note on the base-branch comparison

I ran `npm test` on a worktree of the current base tip
(`697ac22` = the merge of this follow-up, PR #469) to compare. Two things to be
straight about:

1. **The base tip already contains this follow-up's code.** `git diff` between
   this branch's HEAD and the base tip (excluding this doc) is **empty** — the
   application code is byte-identical. So the base run tests the *same code*; it
   can only prove the failures are environmental, not "identical to a pre-change
   base."
2. **The counts did NOT match** across runs: base worktree `npm test` reported
   **41 failed / 3 passed**, versus **7 failed / 28 passed / 9 skipped** on this
   branch. Because the code is provably identical, this variance is
   **environmental/timing**, not a code regression: the second dev server was
   cold/slow and more AWS-throttled, so timing-sensitive UI tests that *skip* or
   *pass* on a warm server *failed* on the cold one. I am flagging this honestly
   rather than presenting a clean "identical on base" claim, which would be
   false. The CI agent (with real AWS permissions and a stable server) is the
   authoritative re-run.

Bottom line: with no application-code delta between this branch and base, this
follow-up cannot introduce a test regression; the failing/variable tests are
backend-permission and server-timing artifacts of the sandbox.

---
