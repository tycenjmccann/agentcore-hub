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
