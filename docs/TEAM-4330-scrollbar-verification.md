# TEAM-4330 — scrollbar CSS verification

## Important: this revision replaces an already-merged fix

TEAM-4330 was first fixed and merged as **PR #470** (`b3f392c`, merged 2026-09-09
18:48 by tycenjmccann) into `feature/TEAM-4314--kiro-opus-workflow-tab-sidebar-dark-sle`,
using an **inverted `@supports` guard**:

```css
@supports selector(::-webkit-scrollbar) { *::-webkit-scrollbar{...} ... }
@supports (scrollbar-width: thin) and (not selector(::-webkit-scrollbar)) { * { scrollbar-width: thin; ... } }
```

That shape was never compared against the `auto`-reset variant (below) before shipping.
This revision replaces it, for two measured reasons:

1. **The reset variant is empirically green on Chromium** (see the AFTER probe below) —
   the inverted guard was not a required fallback.
2. **The inverted guard leaves a Firefox 64–68 regression** and **does not fully fix
   A2**. Firefox 64–68 has `scrollbar-width`/`scrollbar-color` but not
   `@supports selector()` — the `not selector(::-webkit-scrollbar)` branch is exactly
   as unresolvable there as the plain `selector()` branch, so **both** `@supports`
   blocks drop and that engine falls back to the platform-native bar (a real
   regression vs. the pre-TEAM-4316 base, never recorded in PR #470's body). Separately,
   the inverted guard's webkit block never resets `scrollbar-color` to `auto`, so a
   descendant of `.scrollbar-thin` still inherits its non-`auto` `scrollbar-color`,
   which per MDN overrides the webkit rules — **A2 is not fixed for that case**. Measured
   directly: probing an overflowing element inside `.scrollbar-thin` under PR #470's
   shape returns `scrollbarColor: "rgb(42, 42, 58) rgba(0, 0, 0, 0)"` (non-auto,
   inherited) where the reset variant returns `"auto"`. See the BEFORE probe, `A2
   descendant scrollbarColor must be auto` failures.

## Browser versions (verbatim `browser.version()`)

- Chromium: `"148.0.7778.0"` (launched with `channel: 'chromium'`, `ignoreDefaultArgs: ['--hide-scrollbars']`)
- Firefox: `"150.0.2"`

## Firefox abort gate (non-negotiable, run first)

```
CSS.supports: selector(::-webkit-scrollbar)=false  not selector(...)=true  scrollbar-width:auto=true  scrollbar-color:auto=true
GATE OK for firefox.
```

`CSS.supports('selector(::-webkit-scrollbar)') === false` on Firefox 150.0.2, confirmed
before any CSS assertion ran. Chromium's gate (`=== true`) also confirmed. Neither
browser failed to launch — no BLOCKED state.

## BEFORE = pre-TEAM-4330 dead code (TEAM-4316, commit `fde1de8`)

The original, unguarded `* { scrollbar-width: thin; scrollbar-color: ... } *::-webkit-scrollbar{...}`
block — i.e. finding A1 as filed. Captured by temporarily checking out
`git show fde1de8:src/styles/globals.css` over the rebased tree, probing, then restoring.

```
################ CHROMIUM — browser.version() = "148.0.7778.0" ################
CSS.supports: selector(::-webkit-scrollbar)=true  not selector(...)=false  scrollbar-width:auto=true  scrollbar-color:auto=true
GATE OK for chromium.
CONTROL (bare page, no author scrollbar CSS): {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":15}

---- chromium / theme=dark (documentElement[data-theme]="dark") ----
  guard canary bg = rgb(2, 2, 2)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"thin","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"thin","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"thin","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  CSSOM readback of shipped scrollbar rules:
    .scrollbar-thin { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    * { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--color-surface-4); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--color-surface-4) 70%, var(--color-text-muted)); }
    ::-webkit-scrollbar-button { display: none; }

---- chromium / theme=light (documentElement[data-theme]="light") ----
  guard canary bg = rgb(2, 2, 2)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"thin","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"thin","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"thin","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}

################ FIREFOX — browser.version() = "150.0.2" ################
CSS.supports: selector(::-webkit-scrollbar)=false  not selector(...)=true  scrollbar-width:auto=true  scrollbar-color:auto=true
GATE OK for firefox.
CONTROL (bare page, no author scrollbar CSS): {"scrollbarWidth":"none","scrollbarColor":"auto","gutterPx":0}
  ^ scrollbar-width reads "none" where the CSS initial value is "auto"
    => Playwright's Firefox build overrides it above author !important; treated as UNOBSERVABLE below.

---- firefox / theme=dark (documentElement[data-theme]="dark") ----
  guard canary bg = rgb(3, 3, 3)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}

---- firefox / theme=light (documentElement[data-theme]="light") ----
  guard canary bg = rgb(3, 3, 3)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}

================ RESULT (before) ================
FAILURES (8):
  - [chromium/dark] plain scrollbarWidth must be auto — got "thin"
  - [chromium/dark] plain scrollbarColor must be auto — got "rgb(42, 42, 58) rgba(0, 0, 0, 0)"
  - [chromium/dark] reserved gutter must be 6px (proves the webkit width paints) — got 10
  - [chromium/dark] A2 descendant scrollbarColor must be auto — got "rgb(42, 42, 58) rgba(0, 0, 0, 0)"
  - [chromium/light] plain scrollbarWidth must be auto — got "thin"
  - [chromium/light] plain scrollbarColor must be auto — got "rgb(206, 212, 218) rgba(0, 0, 0, 0)"
  - [chromium/light] reserved gutter must be 6px (proves the webkit width paints) — got 10
  - [chromium/light] A2 descendant scrollbarColor must be auto — got "rgb(206, 212, 218) rgba(0, 0, 0, 0)"
```

Reading this: on Chromium the native `scrollbar-width: thin` path governs
(`scrollbarWidth: "thin"`, not `"auto"`), the reserved gutter is `10px` (the classic
thin-bar gutter), not `6px` — proof the `::-webkit-scrollbar{width:6px}` declaration,
while present in the CSSOM, never actually paints. This is finding A1.

## AFTER = this fix (reset variant, rebased onto the merged base)

```
################ CHROMIUM — browser.version() = "148.0.7778.0" ################
CSS.supports: selector(::-webkit-scrollbar)=true  not selector(...)=false  scrollbar-width:auto=true  scrollbar-color:auto=true
GATE OK for chromium.
CONTROL (bare page, no author scrollbar CSS): {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":15}

---- chromium / theme=dark (documentElement[data-theme]="dark") ----
  guard canary bg = rgb(2, 2, 2)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":6,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"thin","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":6,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(42, 42, 58)","thumbRadius":"3px","buttonDisplay":"none"}}
  CSSOM readback of shipped scrollbar rules:
    .scrollbar-thin { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    * { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    @supports selector(::-webkit-scrollbar) [matches=true] * { scrollbar-width: auto; scrollbar-color: auto; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--color-surface-4); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--color-surface-4) 70%, var(--color-text-muted)); }
    ::-webkit-scrollbar-button { display: none; }
  screenshot -> docs/TEAM-4330-chromium-dark-after.png  (clip 22x140 @3x = 66x420px)

---- chromium / theme=light (documentElement[data-theme]="light") ----
  guard canary bg = rgb(2, 2, 2)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":6,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"thin","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":10,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"auto","scrollbarColor":"auto","gutterPx":6,"wk":{"width":"6px","height":"6px","trackBg":"rgba(0, 0, 0, 0)","thumbBg":"rgb(206, 212, 218)","thumbRadius":"3px","buttonDisplay":"none"}}

---- chromium / real /workflow list [data-testid=workflow-history-list] ----
  {"scrollbarWidth":"auto","scrollbarColor":"auto","wkWidth":"6px","wkThumb":"rgb(42, 42, 58)","wkRadius":"3px"}
---- chromium / pipeline.css restoration (A2) — --pipeline-border=#1e293b ----
  .modal-content        {"cls":"modal-content","scrollbarColor":"auto","wkWidth":"6px","wkHeight":"6px","wkThumb":"rgb(30, 41, 59)","wkRadius":"3px","gutterPx":6}
  .code-block-content   {"cls":"code-block-content","scrollbarColor":"auto","wkWidth":"6px","wkHeight":"4px","wkThumb":"rgb(30, 41, 59)","wkRadius":"2px","gutterPx":6}

################ FIREFOX — browser.version() = "150.0.2" ################
CSS.supports: selector(::-webkit-scrollbar)=false  not selector(...)=true  scrollbar-width:auto=true  scrollbar-color:auto=true
GATE OK for firefox.
CONTROL (bare page, no author scrollbar CSS): {"scrollbarWidth":"none","scrollbarColor":"auto","gutterPx":0}
  ^ scrollbar-width reads "none" where the CSS initial value is "auto"
    => Playwright's Firefox build overrides it above author !important; treated as UNOBSERVABLE below.

---- firefox / theme=dark (documentElement[data-theme]="dark") ----
  guard canary bg = rgb(3, 3, 3)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"none","scrollbarColor":"rgb(42, 42, 58) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  CSSOM readback of shipped scrollbar rules:
    .scrollbar-thin { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    * { scrollbar-width: thin; scrollbar-color: var(--color-surface-4) transparent; }
    @supports selector(::-webkit-scrollbar) [matches=false] * { scrollbar-width: auto; scrollbar-color: auto; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--color-surface-4); border-radius: 3px; }
    ::-webkit-scrollbar-button { display: none; }

---- firefox / theme=light (documentElement[data-theme]="light") ----
  guard canary bg = rgb(3, 3, 3)   (rgb(2, 2, 2)=selector() matched -> reset fires | rgb(3, 3, 3)=not selector() matched)
  #probe-plain                                          {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-thin  (.scrollbar-thin — constraint 3)          {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}
  #probe-prose-pre (descendant of .scrollbar-thin — A2)  {"scrollbarWidth":"none","scrollbarColor":"rgb(206, 212, 218) rgba(0, 0, 0, 0)","gutterPx":0,"wk":{"width":"","height":"","trackBg":"","thumbBg":"","thumbRadius":"","buttonDisplay":""}}

================ RESULT (after) ================
ALL ASSERTIONS PASSED
```

**No fallback needed.** The Chromium auto-restore assertions (step 3 of the plan's
decision tree) came back green on the first probe of the reset variant, both before
and after the rebase onto the merged base — the inverted-guard fallback documented in
the plan was never triggered.

Readouts of note:
- Chromium `#probe-plain`: `scrollbarWidth`/`scrollbarColor` both `auto` (the reset
  fired), `::-webkit-scrollbar` width `6px`, thumb `rgb(42, 42, 58)` dark /
  `rgb(206, 212, 218)` light, radius `3px`, track transparent, button `none`. Gutter
  `6px` (up from the bare-page control's `15px`, and down from the pre-fix `10px`) —
  proof the paint is real, not just declared.
- `.scrollbar-thin` (constraint 3): `thin` / `rgb(42,42,58) rgba(0,0,0,0)`, gutter
  `10px` — **identical to the pre-fix and to the original base** in every field. Not
  regressed.
- `#probe-prose-pre` (A2, descendant of `.scrollbar-thin`): `scrollbarColor: "auto"`,
  `wk.width: "6px"` — the declared-`auto`-on-`*` beats inherited-non-`auto` mechanism
  described in the code comment. This is the case the inverted guard gets wrong (see
  the BEFORE section above).
- Real `/workflow` sidebar list (`[data-testid=workflow-history-list]`): matches the
  synthetic probe exactly.
- `pipeline.css` restoration: `.modal-content` and `.code-block-content` both report
  `scrollbarColor: "auto"` and their own per-class `wk` values (`--pipeline-border`
  thumb `rgb(30, 41, 59)`, radii `3px`/`2px`, heights `6px`/`4px`) — A2 fixed app-wide,
  not just at the probe site.
- Firefox: `scrollbarColor` unchanged in both themes vs. the pre-fix run, canary
  `rgb(3, 3, 3)` (the webkit path never activates) — R1.3/R1.5 preserved, no
  regression from this fix (unlike the inverted guard's Firefox 64–68 gap, which this
  fix does not have — the standard-properties `*` rule here is unguarded).

## Screenshot review (I looked at these; this is what they show)

`docs/TEAM-4330-chromium-dark-comparison.png` — Chromium 148, dark theme, right edge
of an overflowing 220×140 probe container, captured at `deviceScaleFactor: 3`,
clip-cropped to a 22×140 CSS-px strip, composited at 2x with annotations.

- **BEFORE** (pre-TEAM-4330 dead code, `fde1de8`): a native thin scrollbar — visible
  ▲/▼ triangular arrow buttons at the top and bottom (rows ~10-20 and ~399-409 of 420
  device px), a rounded thumb inset ~2 CSS px from the right edge, sitting inside a
  **10px** reserved gutter (the red rule).
- **AFTER** (this fix): no arrow buttons at either end — `::-webkit-scrollbar-button
  {display:none}` is now in effect. The thumb is the same visual width (6 CSS px,
  measured pixel-for-pixel in both images) but sits flush against the right edge,
  filling a now-**6px** gutter, because the classic buttons that ate 2px on each side
  are gone.

`docs/TEAM-4330-workflow-pipeline-scrollbars.png` — `/workflow` route (which ships
`src/components/workflow/pipeline.css`, unmodified by this ticket), dark theme,
probes injected with the real `.modal-content` / `.code-block-content` class names.

- **`.modal-content`** (vertical, right edge): BEFORE has the same native thin bar
  with arrow buttons and a thumb coloured `rgb(42, 42, 58)` — `globals.css`'s
  `--color-surface-4`, because `pipeline.css`'s own `::-webkit-scrollbar-thumb` rule
  was dead. AFTER has no arrow buttons and a thumb coloured `rgb(30, 41, 59)` —
  `pipeline.css`'s own `--pipeline-border` token, now painting.
- **`.code-block-content`** (horizontal, bottom edge): BEFORE is **18 device px = 6
  CSS px** tall (globals.css's size, not pipeline.css's `height: 4px`). AFTER is **12
  device px = 4 CSS px** tall — `pipeline.css`'s own declaration now governs, because
  `.code-block-content` (specificity 0-1-0) beats `*` (0-0-0) once `*` no longer
  claims the pseudo-element via a non-`auto` `scrollbar-color`.

Both figures were re-measured pixel-by-pixel (`/tmp/measure.mjs`, `/tmp/pipemeasure.mjs`)
before being captioned — the colour/size values in the captions are read from the
images, not from the CSS source.

## Gates

- `npx tsc --noEmit` — **pass**, exit 0, no output.
- `npm run build` — **pass**, production build completed, all routes compiled
  (including `/workflow` at 172 kB / 318 kB First Load JS).
- `npm run lint` — **pass**, exit 0. All warnings are pre-existing (`react-hooks/exhaustive-deps`,
  `@next/next/no-img-element` in unrelated components) and zero of them mention
  `globals.css`. Caveat: `next lint` is ESLint-only and does not lint CSS, and this
  repo has no stylelint — this gate cannot catch a CSS regression here.

## `tests/tab-workflow-resize.spec.ts` case 5 — NOT edited, run on both branches

```
BASE TIP (b3f392c, PR #470's inverted guard, currently merged):
  scrollbar computed: scrollbarWidth="auto" webkitWidth="6px"
  ✘ 5: scrollbar styling — thin + 6px webkit width (no default white bar)
    Expected: "thin"   Received: "auto"
  1 failed, 4 passed, 1 skipped

THIS FIX (reset variant, rebased on top of the base tip):
  scrollbar computed: scrollbarWidth="auto" webkitWidth="6px"
  ✘ 5: scrollbar styling — thin + 6px webkit width (no default white bar)
    Expected: "thin"   Received: "auto"
  1 failed, 4 passed, 1 skipped
```

Identical outcome on both: case 5 was already broken by PR #470 (any `@supports`
split that makes the webkit path win on Chromium computes `scrollbarWidth: "auto"`,
not `"thin"`) — this fix does not introduce a new failure, it inherits an existing
one. `webkitWidth` (`"6px"`) passes on both, unchanged. Per the ticket's scope, the
spec is TEAM-4332's to update; it is not edited here.

## Files changed by this revision

Only `src/styles/globals.css` (replacing PR #470's inverted-guard block with the
reset variant) plus the four evidence files under `docs/`:
`TEAM-4330-scrollbar-verification.md` (this file), `TEAM-4330-chromium-dark-before.png`,
`TEAM-4330-chromium-dark-after.png`, `TEAM-4330-chromium-dark-comparison.png`,
`TEAM-4330-workflow-pipeline-scrollbars.png`. `src/app/workflow/page.tsx`,
`tests/tab-workflow-resize.spec.ts`, `src/app/agents/[id]/page.tsx`,
`src/components/workflow/pipeline.css`, and `.scrollbar-thin` are untouched — confirmed
via `git diff --stat` against the base tip. No raw hex was introduced; all colours are
`var(--color-surface-4)` / `color-mix()` against existing tokens, matching PR #470 and
the original TEAM-4316 block.
