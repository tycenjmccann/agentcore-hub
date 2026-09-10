# TEAM-4331 — BEFORE/AFTER differential

Same workspace, same dev server (`http://localhost:3000`), same probe
(`verify-resize-lifecycle.mjs`). Only `src/app/workflow/page.tsx` was swapped
between runs (BASE = `git show origin/feature/TEAM-4314--kiro-opus-workflow-tab-sidebar-dark-sle:src/app/workflow/page.tsx`,
AFTER = the committed fix at `f159402`), the dev server hot-reloaded each swap
(confirmed live by re-running case C1 immediately after each swap, before
capturing the full run), and the fixed file was restored and verified
byte-identical to the committed version (`git diff --exit-code`) before and
after the BEFORE run.

Full verbatim output: [`probe-before.txt`](./probe-before.txt) (17 failures),
[`probe-after.txt`](./probe-after.txt) (0 failures, 50/50 assertions).

## Per-case result

| Case | What it proves | BEFORE (base) | AFTER (fix) |
|---|---|---|---|
| C1 | B1 — lost pointer capture (mouse released outside the window) | **7 FAIL** | PASS (11/11) |
| C2 | B1 — `pointercancel` mid-drag | PASS (6/6) — already landed (`6bafd77`) | PASS (6/6) |
| C3 | B3 — viewport clamp must not overwrite the stored preference | **7 FAIL** | PASS (13/13) |
| C4 | B2 — a stuck drag must not leak listeners into the next drag | **4 FAIL** | PASS (9/9) |
| C5 | dblclick reset still works with capture active; zero-move press must not downgrade the preference | **1 FAIL** (of 10) | PASS (10/10) |

C2 passing on both is expected and not a gap in the probe: `pointercancel`
handling was added in a prior commit (`6bafd77`, "TEAM-4316 follow-up") that
predates this ticket, per the review's own note that it was already landed.

Every case ran to completion on base — none were structurally unrunnable
there. (`FAIL` counts are exact per-case failure counts machine-counted from
the saved output, not estimates.)

## The one discriminating assertion per finding

Each of these is a single line, pulled verbatim from the two output files,
that by itself proves the defect existed on base and is fixed on the branch.

### B1 — pointer capture / lost-capture drag-end path

> `probe-before.txt`, case C1:
> `FAIL  body.style.userSelect restored to "" ("none")`

> `probe-after.txt`, case C1:
> `PASS  body.style.userSelect restored to "" ("")`

On base, a drag interrupted by `lostpointercapture` (the proxy for a mouse
released outside the browser window — see the probe's honest caveat below)
never runs `cleanup()`, so `document.body.style.userSelect` is stuck at
`"none"` app-wide. On the fix, `lostpointercapture` is a registered drag-end
path and restores it every time.

### B2 — teardown before installing a new drag's listeners

> `probe-before.txt`, case C4:
> `FAIL  drag B's release produced exactly ONE write (a leaked drag-A onEnd would make 2) (2: ["560","560"])`

> `probe-after.txt`, case C4:
> `PASS  drag B's release produced exactly ONE write (a leaked drag-A onEnd would make 2) (1: ["560"])`

On base, drag A is left stuck (no `pointerup`, ever) and its `onEnd` is still
attached to `window` when drag B starts (`dragCleanupRef.current` was
overwritten, not torn down first). Drag B's single `pointerup` release fires
**both** `onEnd` closures, producing two `localStorage` writes of the same
value — a leak that is invisible if you only check the *value*, which is why
the assertion counts writes, not just compares the final stored number. On the
fix, `handleResizeStart` tears down any pending drag before installing a new
one, so exactly one write occurs.

### B3 — a resize event must never persist the viewport-clamped width

> `probe-before.txt`, case C3:
> `FAIL  ZERO width writes fired during the viewport resize (1: ["450"])`

> `probe-after.txt`, case C3:
> `PASS  ZERO width writes fired during the viewport resize (0: [])`

On base, `recompute()` calls `applyWidth(max, true)` when the current width
exceeds the new max, which persists the *clamped* value — a stored preference
of 600 becomes a stored 450 merely by narrowing the window, and widening back
never recovers 600 (`FAIL  after reload the sidebar renders the preserved
~600 (450px)`). On the fix, `recompute()` calls the render-only
`applyEffectiveWidth`, which never touches `localStorage`; the preference
round-trips through a narrow-then-wide viewport change unchanged.

## Honest caveats carried over from the probe's own header comment

- **C1** cannot literally drag the OS cursor outside the browser window from
  Playwright's input API. It dispatches `lostpointercapture` — the exact
  event Chromium fires at the capture element in that situation — with no
  `pointerup` ever delivered, which is the harder case: on base, nothing at
  all runs in response, matching what a real out-of-window release would also
  fail to trigger without capture.
- **C4** deliberately never sends the stuck drag A a `pointerup` release (that
  is the scenario B2 exists for); its second drag is driven by direct
  `PointerEvent` dispatch (pointerdown on the handle, pointermove/pointerup on
  `window`) rather than `page.mouse`, because a real mouse's second
  `pointerdown` has to hit the handle's 4px-wide strip, whose on-screen
  position becomes a moving target once a prior drag is (deliberately) left
  leaking a listener — a hit-testing problem, not a fact about the
  application logic under test. Direct dispatch reaches the same React
  synthetic-event delegation a real event would.
