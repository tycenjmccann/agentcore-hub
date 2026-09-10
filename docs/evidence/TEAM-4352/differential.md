# TEAM-4352 — before/after differential

Round-3 review finding **F1 (P2)** against the workflows-history sidebar: the KEYBOARD
resize path silently destroyed a persisted width preference that the current viewport
could not render. The fix is 8 lines; this document is the evidence that the fix is real
and that the new test would fail without it.

Same discipline as `docs/evidence/TEAM-4332/differential.md`: every claim below was
**measured by running it**, not reasoned about, and the deliberately-broken variants were
run too, so the new assertions are shown to discriminate rather than merely to pass.

## Method

- **Server mode: production build.** `next build` + `next start -p 3000` for every capture,
  not `npm run dev`. This matters specifically here. `reactStrictMode: true`
  (`next.config.mjs`), so on the dev server every effect double-invokes, and a write-COUNT
  differential taken there would be open to the objection that the counts are a StrictMode
  artefact. (They would not be — the mount-read and `recompute` effects only call
  `applyEffectiveWidth`, which never touches `localStorage` — but the production build
  removes the argument instead of answering it.) `next start` serves a prebuilt `.next` and
  does not hot-reload, so **every mutation got its own full rebuild + server restart**.
  `next start` warns about `output: standalone`; it serves correctly regardless (HTTP 200
  on `/workflow` verified before each run).
- Chromium, the repo's single Playwright project, default viewport 1440×900, with the
  file-level `test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })`
  that TEAM-4332 established (without it every scrollbar gutter reads 0 and group A's
  discriminator disappears).
- Raw run output is committed verbatim under `raw/`:
  `before-e6.txt`, `after-e6.txt`, `after-full-file.txt`, `m2-overfix.txt`.
- Each mutation run also executed the `fixture sanity` **control test**, which must pass
  under every mutation. It did in both. TEAM-4332 added that control after a broken harness
  produced a false signature; a mutation result recorded without it is not trustworthy.
- The mutation was reverted with `git checkout -- src/app/workflow/page.tsx`, verified with
  `git diff --exit-code -- src/`, and E6 re-run green on the reverted tree, so the branch
  cannot ship a mutation. `git hash-object src/app/workflow/page.tsx` after the revert:
  `107675330117c9305f2122b50514905aef6a1998`.
- **No PNGs are committed.** TEAM-4345 **F4 (P3)** removed 12 evidence PNGs from tracked
  `docs/` and repointed the spec at the gitignored `playwright-screenshots/`, because
  writing into a tracked path dirties the working tree on every `npm test`. That precedent
  is followed here: `playwright-screenshots/` stays gitignored and nothing visual is
  committed. The `raw/*.txt` captures are `tee`'d run output, not written by the spec, so
  they cannot dirty the tree.

---

## The defect — numbered state trace

Viewport **900×900**, so `clampHistoryWidth`'s ceiling is
`max = min(HISTORY_MAX_CEILING, window.innerWidth * 0.5) = min(640, 450) = 450`.
`localStorage["workflow-history-width"] = "600"`.

| # | step | `preferredWidthRef` | `widthRef` / rendered | `localStorage` |
|---|---|---|---|---|
| 1 | mount-read effect: `preferredWidthRef = 600`, `applyEffectiveWidth(clamp(600))` | **600** | 450 | `"600"` |
| 2 | `recompute`: `maxWidth = 450`, re-applies `clamp(600)` — render-only, no write | 600 | 450 | `"600"` |
| 3 | user presses **ArrowRight** once (asks to WIDEN) | | | |
| 4 | old handler: `clampHistoryWidth(widthRef.current + 16)` = `clamp(466)` = **450** | | | |
| 5 | `applyWidth(450, true)` — overwrites the intent **and** persists | **450** ⚠ | 450 | **`"450"`** ⚠ |
| 6 | observable result: **nothing moved on screen** (450 → 450) | 450 | 450 | `"450"` |
| 7 | later, user maximises the window to 1600 (`max` becomes 640) | 450 | **450** ⚠ | `"450"` |

Step 5 is the defect. The user asked to widen; nothing widened; and the saved width got
permanently **narrower**. Step 7 is where they feel it — the 600px sidebar they configured
is gone for good, replaced by 450.

`localStorage` is rewritten `"600"` → `"450"` by a keypress that changed no pixel.

This is the same failure class as TEAM-4331's **B3**, which the POINTER path already
fixes: `onEnd` persists `String(preferredWidthRef.current)`, not the clamped render width,
and case **E5** pins it ("a press that moved nothing must not quietly overwrite the user's
wider preference"). The keyboard path never got the same treatment — it is the one channel
E5 does not cover.

---

## The fix and why

One `stepWidth(delta)` helper behind both arrows (`src/app/workflow/page.tsx`):

```tsx
const stepWidth = useCallback((delta: number) => {
  let next = clampHistoryWidth(preferredWidthRef.current + delta);
  if (next === widthRef.current) {
    const fromRendered = clampHistoryWidth(widthRef.current + delta);
    if (fromRendered === widthRef.current) return; // at a clamp bound — silent no-op
    next = fromRendered;
  }
  applyWidth(next, true);
}, [applyWidth]);
```

1. **Intent first.** Step `preferredWidthRef`, not the render width. This alone is what
   makes the headline case correct: `clamp(600 + 16) = 450`.
2. **Rendered fallback when the step is absorbed.** If the intent step lands exactly on the
   current rendered width, nothing would move on screen, so retry from the rendered width.
3. **Silent no-op at a true bound.** If the rendered step also cannot move, we are at a
   genuine clamp bound in that direction: return with **no state change, no localStorage
   write**, and `preferredWidthRef` untouched. The wider preference survives.

### Why the fallback, and why the ArrowLeft asymmetry is deliberate

From pref 600 / rendered 450 the two directions behave differently **on purpose**:

- **ArrowRight** → intent `clamp(616) = 450` (absorbed) → rendered `clamp(466) = 450`
  (also absorbed) → **silent no-op**. The 600 survives and a later widen restores it.
- **ArrowLeft** → intent `clamp(584) = 450` (absorbed) → rendered `clamp(434) = 434` ≠ 450
  → apply 434. The sidebar **visibly narrows**, and 434 becomes the honest new intent.

Stepping the *preference* in the ArrowLeft case (600 → 584 → 568 → …) would require ~10
keypresses before anything moved, with zero feedback in between — a worse defect than the
one being fixed, and one no user would read as anything but a broken control. So the
invariant this fix protects is deliberately narrower than "never overwrite the preference":

> **A keypress that changes NOTHING VISIBLE must not rewrite the preference. One that
> visibly moves the sidebar may.**

A stale or tampered preference *below* the floor behaves correctly through the same
fallback: stored `"100"` renders 240, and ArrowRight gives intent `clamp(116) = 240`
(absorbed) → rendered `clamp(256) = 256` → widens normally.

### Why the existing keyboard cases are unaffected

The press that **first reaches** a bound is *not* absorbed, so it still writes the clamped
bound value — C5 still stores `"450"`, C4 `"640"`, C3 `"240"`. Only the presses *after*
that become silent no-ops instead of redundant rewrites of a value already stored. D2's
`keyboardToWidth(240, extra 4)` → `keyboardToWidth(288)` chain depends on the bail leaving
`preferredWidthRef` untouched, which it does, so `pref === rend === 240` and the next three
steps land exactly on 288. Confirmed by the full-file run below, not by argument.

---

## BEFORE / AFTER — the five measured channels

BEFORE = the committed spec run against the **unfixed** handler (`raw/before-e6.txt`).
AFTER = the same spec against the fix (`raw/after-e6.txt`). Both production build.

Verbatim console lines:

```
BEFORE  [E6] ArrowRight at the clamped ceiling: seen=450 writes=[{"key":"workflow-history-width","value":"450"}] stored=450
BEFORE  [E6] widened to 1600: rendered=450 valuenow=450 stored=450 writes=1

AFTER   [E6] ArrowRight at the clamped ceiling: seen=450 writes=[] stored=600
AFTER   [E6] widened to 1600: rendered=600 valuenow=600 stored=600 writes=0
```

| # | channel | assertion | BEFORE (unfixed) | AFTER (fixed) | verbatim failure line |
|---|---|---|---|---|---|
| 1 | **write count** after one ArrowRight | `expect.soft(writes.length).toBe(0)` | **1** ❌ | **0** ✅ | `Expected: 0` / `Received: 1` |
| 2 | **stored value** after the press | `expect.soft(storedWidth).toBe("600")` | **`"450"`** ❌ | `"600"` ✅ | `Expected: "600"` / `Received: "450"` |
| 3 | **rendered width** after widening to 1600 | `expect.soft(near(restored, 600, 3))` | **450** ❌ | **600** ✅ | `Expected: true` / `Received: false` |
| 4 | **`aria-valuenow`** after widening | `expect.soft(aria valuenow).toBe(600)` | **450** ❌ | **600** ✅ | `Expected: 600` / `Received: 450` |
| 4b | stored value after widening | `expect.soft(storedWidth).toBe("600")` | **`"450"`** ❌ | `"600"` ✅ | `Expected: "600"` / `Received: "450"` |
| 4c | write count after widening | `expect.soft(widthWrites.length).toBe(0)` | **1** ❌ | **0** ✅ | `Expected: 0` / `Received: 1` |
| 5 | **`seen[]` from `pressKey`** (aria after the press) | logged; rendered width pinned separately | `450` — same in both | `450` | *(not a discriminator — see below)* |

Result: **BEFORE `1 failed` (all five channels), AFTER `2 passed`.**

### `seen[]` is not a discriminator, and that is the point

`pressKey` returns `aria-valuenow` after each press, and it reads **450 in both states** —
because the whole defect is that *nothing visible changes*. Recorded here so nobody later
mistakes it for coverage: it is the **non-vacuity** channel. It proves the press was
delivered and that the rendered width genuinely did not move, which is what makes "0 writes"
meaningful rather than an artefact of a keypress that never landed. The discriminating
channels are 1-4c.

### Why `expect.soft`

The first BEFORE capture used hard `expect`s and **aborted at channel 1**: the run recorded
`Expected: 0 / Received: 1` and never executed the stored-value or widened-render
assertions — so the differential was single-channel, and the two channels that exist
precisely to make it multi-channel contributed nothing. That is the identical weakness
TEAM-4332 found and fixed in group A ("M1's first run aborted each test at its first
failure … Converted to `expect.soft`"). E6's five measurement channels were converted to
`expect.soft` and the capture re-taken; the table above is the re-taken run.

The **preconditions stay hard** (`rendered ≈ 450`, `stored === "600"`,
`aria-valuemax === 450`, `aria-valuenow === 450`): if that is not the starting state, the
rest of the test is measuring nothing and should stop rather than emit six confusing
failures.

---

## Mutation table — the over-fix (why E6b is kept)

**E6b does NOT detect F1.** From pref 600 / rendered 450 the unfixed handler also computes
`clamp(450 - 16) = 434` and stores `"434"`, so E6b passes on the broken code — verbatim
from `raw/before-e6.txt`:

```
[E6b] ArrowLeft from pref 600 / rendered 450: seen=434 writes=[{"key":"workflow-history-width","value":"434"}] rendered=434
  ✓  2 … E6b: an ArrowLeft that VISIBLY narrows may replace the preference — exactly one write
```

E6b exists to detect the **over-fix**: a reviewer who reads "step the intent, never
overwrite the preference" and drops the rendered fallback. Two such variants were built,
rebuilt and run (`raw/m2-overfix.txt`):

| # | mutation to `stepWidth` | E6 (ArrowRight) | E6b (ArrowLeft) | C5 | control |
|---|---|---|---|---|---|
| **M2a** | pure intent step, no bail, no fallback:<br>`applyWidth(clampHistoryWidth(pref + delta), true)` | ❌ **fails** — identical to F1 | ❌ **fails** — `Expected: "434"` / `Received: "450"` | ✅ passes | ✅ |
| **M2b** | intent step **+** absorbed-bail, **no** rendered fallback:<br>`const next = clamp(pref+delta); if (next === widthRef.current) return; applyWidth(next, true)` | ✅ **passes** | ❌ **fails** — `Expected: 1` / `Received: 0` | ✅ passes | ✅ |

Verbatim mutation lines:

```
M2a  [E6]  ArrowRight at the clamped ceiling: seen=450 writes=[{"key":"workflow-history-width","value":"450"}] stored=450
M2a  [E6]  widened to 1600: rendered=450 valuenow=450 stored=450 writes=1
M2a  [E6b] ArrowLeft from pref 600 / rendered 450: seen=450 writes=[{"key":"workflow-history-width","value":"450"}] rendered=450
     → 2 failed

M2b  [E6]  ArrowRight at the clamped ceiling: seen=450 writes=[] stored=600
M2b  [E6]  widened to 1600: rendered=600 valuenow=600 stored=600 writes=0   → ✓
M2b  [E6b] ArrowLeft from pref 600 / rendered 450: seen=450 writes=[] rendered=450
     → 1 failed (E6b), 1 passed (E6)
```

**M2b is the case that earns E6b its keep.** Under M2b the fix looks correct on every
channel E6 measures, and the *only* signal that anything is wrong is E6b: ArrowLeft becomes
a dead key — `writes=[]`, `rendered=450`, aria stuck at 450 — the "ten keypresses with zero
feedback" defect the fallback exists to prevent. No other case in the file notices.

### Two honest notes on the mutations

1. **The predicted M2 signature was wrong, and the plan's numbers are corrected here.**
   The prediction was that the over-fix would store `"584"`. It does not: `stepWidth`
   applies `clampHistoryWidth`, and `clamp(584) = 450` on a 900px viewport. M2a stores
   `"450"`; M2b stores **nothing at all**. A variant that really would store `"584"` is one
   that drops the clamp entirely — that is TEAM-4332's own M2 mutation, already covered by
   C3/C4/C5 (`Expected: 450` / `Received: 768`), so it was not re-run.
2. **C5 does not detect either over-fix.** It passed under both, with
   `[C5] observed tail=450,450,450,450,450,450 max=450`. Correctly so: C5 starts from
   `clearWidth`, where `preferredWidthRef === widthRef` for the whole press walk, so the
   render/preference split it would need is never created. C5 covers the clamp bound; only
   E6/E6b cover the split. This is why the new cases seed `600` on a 900px viewport instead
   of extending C5.

---

## Full-file run — `raw/after-full-file.txt`

`npx playwright test tests/tab-workflow-resize.spec.ts`, fixed handler, production build:
**27 passed (47.7s)**, no skips.

| # | case | |
|---|---|---|
| 1-4 | core TEAM-4316: default 288 · drag widens + survives reload · dblclick resets · collapse/expand restores | ✅ |
| 5 | A1 gutter ladder — `native=15 thin=10 app=6`, `scrollbarWidth="auto"` | ✅ |
| 6-9 | A2 webkit declarations · A3 `thin` control = 10px · A4 gutter raster (`thumbTokenPixels=774 topRowsHaveThumb=true`) · A5 light theme | ✅ |
| 10-12 | B1 drag floor 240 · B2 drag ceiling 640 · B3 drag ceiling 450 @900px | ✅ |
| 13 | C1 handle reachable by Tab (`tabs=5`) | ✅ |
| **14** | **C2 ArrowRight/ArrowLeft move exactly 16px, one write each** | ✅ |
| **15** | **C3 ArrowLeft clamps at 240** — `tail=240,240,240,240,240,240 min=240` | ✅ |
| **16** | **C4 ArrowRight clamps at 640 @1440px** — `tail=640,…,640 max=640` | ✅ |
| **17** | **C5 ArrowRight clamps at 450 @900px** — `tail=450,…,450 max=450`, stored `"450"` | ✅ |
| **18** | **D1 truncation reveal 288 → 640** (`keyboardToWidth`) — clipped by 170px @288, 182px headroom @640 | ✅ |
| **19** | **D2 no horizontal overflow at 240/288/640** (`keyboardToWidth`, incl. the extra-press bound targets) | ✅ |
| 20-21 | E1 pointercancel teardown · E2 lostpointercapture ends the drag once | ✅ |
| 22 | E3 viewport resize clamps the render with ZERO writes | ✅ |
| 23 | E4 stuck drag then full drag — `writes=[{"value":"560"}]` | ✅ |
| 24 | E5 zero-movement press keeps stored `"600"`; dblclick resets to 288 | ✅ |
| **25** | **E6 (new)** — `writes=[] stored=600`, widened `rendered=600 valuenow=600` | ✅ |
| **26** | **E6b (new)** — one write of `"434"`, `rendered=434` | ✅ |
| 27 | fixture sanity (titles distinct, calibrated lengths) | ✅ |

The bolded rows are the R2.9 regression surface: C3/C4/C5 tails confirm the presses after a
bound are now silent no-ops **without** changing what ends up stored, and D1/D2 confirm
`keyboardToWidth` still lands on exact widths through the bail path.

---

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 — **zero warnings in the changed files** (19 pre-existing warnings elsewhere in the repo) |
| `npm run build` | `✓ Compiled successfully`, 37/37 static pages |
| `npx playwright test tests/tab-workflow-resize.spec.ts` | **27 passed** |

## Files changed

| file | change |
|---|---|
| `src/app/workflow/page.tsx` | `HISTORY_KEY_STEP` + the `stepWidth` rule behind both arrows |
| `tests/tab-workflow-resize.spec.ts` | `KEY_STEP` import + E6 / E6b in group E |
| `docs/evidence/TEAM-4352/differential.md` | this document |
| `docs/evidence/TEAM-4352/raw/*.txt` | verbatim run captures |

`tests/helpers/workflow-resize.ts` is **unchanged** — `pressKey`, `widthWrites`, `resetLog`,
`storedWidth`, `settledWidth`, `aria`, `near`, `setup({ seedWidth })` and `KEY_STEP` already
provided everything the new cases needed.
