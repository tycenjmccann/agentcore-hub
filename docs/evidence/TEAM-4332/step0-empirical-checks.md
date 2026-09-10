# TEAM-4332 step 0 — the measurements the spec's assertions are derived from

Every threshold in `tests/tab-workflow-resize.spec.ts` was measured before it was
written. Raw probe output is committed alongside this file:

| file | check |
|---|---|
| `step0-gutter.txt` | E0.1 / E0.2 — the reserved-gutter ladder under three launch configs |
| `step0-pixels.txt` | E0.3 — is the scrollbar thumb in the raster, and is the arrow-button chrome pixel-distinguishable |
| `step0-titles.txt` | fixture title calibration — `scrollWidth` vs available width at 240 / 288 / 640 |
| `step0-misc.txt` | E0.4 — headroom denominator, Tab distance, keyboard ±16 / clamp ladder |

Environment: Chromium `148.0.7778.0` (Playwright 1.60.0), viewport 1440x900,
`npm run dev` on :3000, dark theme unless stated.

---

## E0.1 / E0.2 — `--hide-scrollbars` was the whole problem

Playwright passes `--hide-scrollbars` to headless Chromium **by default**. With it
on, every scroller reserves a 0px gutter, which is why an earlier probe read
`0 → 0` for both the broken and fixed states and wrongly concluded the layout
check was impossible.

| launch config | native | thin | app (`workflow-history-list`) |
|---|---|---|---|
| `{ ignoreDefaultArgs: ["--hide-scrollbars"] }` | **15** | **10** | **6** |
| Playwright defaults (reference row) | 0 | 0 | 0 |
| `{ channel: "chromium", ignoreDefaultArgs: [...] }` | 15 | 10 | 6 |

- *native* = a bare `page.setContent()` page with no author scrollbar CSS.
- *thin* = an injected forced-overflow div with inline
  `scrollbar-width: thin; scrollbar-color: rgb(42,42,58) transparent` — i.e. the
  state the whole app was in **before** TEAM-4330.
- *app* = the real overflowing list container.

`CSS.supports("selector(::-webkit-scrollbar)")` is `true` in all three.

**Decision: the default `browserName: "chromium"` (headless shell) already reports
the full 15 / 10 / 6 ladder, so the spec uses only**

```ts
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
```

**No `channel: "chromium"` and therefore no CI change.** For completeness,
`npx playwright install --dry-run chromium` showed the CI job's existing
`npx playwright install --with-deps chromium` step provisions both
`chromium-1223` and `chromium_headless_shell-1223`, so the channel would have been
free had it been needed.

`10 → 6` is exactly the broken → fixed flip, which is why A1 asserts `toBe(6)`
rather than "whatever the engine reports". It reproduces the verbatim line in
`docs/TEAM-4330-scrollbar-verification.md`'s BEFORE block:

```
- [chromium/dark] reserved gutter must be 6px (proves the webkit width paints) — got 10
```

---

## E0.3 — the thumb IS in the raster, so A4 is a real assertion, not a control

Rightmost gutter strip of the list container, `scrollTop = 0`, ~40 rows, decoded
in-page (screenshot → base64 data URL → `Image` → canvas → `getImageData`).

| | dark AFTER (shipped fix, 6px gutter) | dark BEFORE (M1 simulated, 10px gutter) |
|---|---|---|
| `anyNearWhite` (all channels ≥ 235) | `false` | `false` |
| pixels near `rgb(42,42,58)` (`--color-surface-4`) | **774** | present |
| top of strip | thumb flush at **row 0** (rounded, radius 3px) | rows **0–8 are pure background** (top-40 all-bg rows: 9/40) |
| bottom 40 rows | **40/40 background** — no `▼` chrome | **37/40 background**; the last 3 rows are non-background |

So there are two discriminating pixel channels, and A4 asserts both:

1. `topRowsHaveThumb` — a thumb-token pixel within the first 4 rows. True only
   when `::-webkit-scrollbar-button { display: none }` is honoured; on the
   standard thin path the thumb is inset behind arrow-button chrome.
2. `bottomRowsAllBackground` — the last 4 rows are plain container background,
   i.e. no bottom arrow button.

`anyNearWhite === false` is the R1.5 literal ("never a solid white bar") but is
**non-discriminating on its own** — it holds in both states. The light-theme
positive control in A5 is what proves the decode reads the real region: the light
container background is itself near-white (`--color-surface-1` `#f1f3f5` =
`rgb(241,243,245)`), so `anyNearWhite` **must** be `true` there. If A4 were passing
because the decode sampled an empty buffer, A5 fails.

The BEFORE column was produced by injecting `scrollbar-width: thin` at runtime
with `addStyleTag`, which is what deleting the `@supports` reset leaves behind —
so `src/` was never touched to obtain it. The real file-level mutation is M1 in
the next step.

---

## Fixture title calibration

Measured under the launch config above, so the 6px gutter that eats `clientWidth`
is already accounted for. The available width is the title `<p>`'s **flex parent's**
`clientWidth`: a Tailwind `truncate` `<p>` shrinks to its content when the text
fits, so `clientWidth - scrollWidth` is 0 whenever it is *not* clipped and cannot
express headroom. (This corrected a flaw in the plan, which had proposed
`clientWidth - scrollWidth >= 60`, an assertion that can never hold.)

| length | `scrollWidth` | available @288 | available @640 | verdict |
|---|---|---|---|---|
| 30 (`SHORT_TITLE`) | 189px | 223px | 575px | fits everywhere — the control row |
| **65 (`MEDIUM_TITLE`)** | **393px** | 223px | 575px | **clipped at 288 by 170px; fits at 640 with 182px spare** |
| 300 (`ABSURD_TITLE`) | 1823px | 223px | 575px | clipped at every width (by 1248px at 640) |

65 maximises the smaller of the two margins (170 / 182), so the reveal is ~170px
clear of the clip boundary in **both** directions and cannot flip on a small
font-metric drift between local and CI. D1 asserts the margins (`>= 100`), not
just the booleans, and logs both plus `document.fonts.check("12px Inter")`.

Exact strings (from `titleOfLength`, a deterministic word-based generator):

```
SHORT_TITLE  (30) = "Refactor the workflow sidebarx"
MEDIUM_TITLE (65) = "Refactor the workflow sidebar resize handle and persist width acr"
ABSURD_TITLE(300) = "Refactor the workflow sidebar resize handle and persist width across reloads for operators " x3 + "Refactor the workflow sideb"
```

`MEDIUM_TITLE` is cut mid-word (`"...width acr"`) and so **is a substring of**
`ABSURD_TITLE` (`"...width across..."`). `titleMetric()` therefore matches on exact
`textContent`, not Playwright's substring `hasText`, which would silently match the
300-char row as well.

The 3-row calibration measured 229/581 available; the committed fixture uses 18
rows so the list overflows vertically and reserves the 6px gutter, giving 223/575.
That 6px difference is the gutter, and it is why the D thresholds carry ~70px of
slack rather than being pinned.

---

## E0.4 — side-effects of a real gutter, and the keyboard ladder

- `window.innerWidth` is **1440, unchanged** with the gutter reserved (it includes
  the scrollbar), and the `documentElement` gutter is 0. So `clampHistoryWidth`'s
  `min(640, innerWidth * 0.5)` is unaffected: the R2.3/R2.9 bounds are still
  **640 @1440** and **450 @900**.
- `scrollWidth - clientWidth === 0` on the list at 240, 288 and 640 (R2.8 clause 2).
- Tab distance from the search input to the handle with the 2-row fixture:
  **exactly 5** (Archive, Delete, Archive, Delete, separator) — which is why C1
  uses `SMALL_ROWS` and a bound of 25. A 40-row fixture would be ~80 tabs.
- Keyboard: `ArrowRight` / `ArrowLeft` move **exactly ±16px** with **exactly one**
  `localStorage` write per press. 30x `ArrowRight` → **640 @1440** and **450 @900**;
  40x `ArrowLeft` → **240**, minimum observed 240 (never below the floor at any
  intermediate step). `aria-valuemax` reads 640 @1440 and 450 @900.
- 288 + 16k gives 448 then 464 — it never lands on 450. So an unclamped keyboard
  path reads 464 at a 900px viewport, and C5's `toBe(450)` is precisely the
  assertion that catches a handler that skips `clampHistoryWidth`.
