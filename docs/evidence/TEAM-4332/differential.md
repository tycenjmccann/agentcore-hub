# TEAM-4332 — mutation differential

The acceptance criterion for this ticket is *"every criterion has an assertion that
would FAIL if the behaviour regressed"*. A passing suite does not demonstrate that.
So each of the two shipped fixes was **deliberately broken**, one mutation at a time,
and the suite was re-run to prove the right test fails with the right number.

## Method

- Every mutation is a patch held **outside the repo** (`/tmp/TEAM-4332/mutations/mN.patch`),
  applied with `git apply`, reverted with `git apply -R`. After every revert,
  `git diff --exit-code -- src/` must be empty. `src/` is byte-identical to the base
  branch at the end (hashes below).
- The patches are **generated from real edits** (`make.py` performs the edit, captures
  `git diff`, reverts, asserts the revert restored the original) rather than hand-written,
  because hand-counted `@@` hunk ranges produced four "corrupt patch" rejections.
- Every run is against the **production build** (`npm run build` + `next start -p 3737`),
  the same configuration as the CI step — not the dev server. `next start` serves a
  prebuilt `.next` and does not hot-reload, so **each mutation gets its own full rebuild**
  (116-130s each).
- Each mutation run first executes a **control test** (`fixture sanity`) that must pass
  under every mutation. If the control fails, the harness is broken and the targeted
  result is discarded rather than recorded. See "Harness defect found and fixed" below —
  this control exists because the first M2 run was invalid and silently looked like a
  pass-shaped failure.
- Only the affected tests are run per mutation (`-g`), so a failure cannot be confused
  with unrelated fallout.

`git hash-object` of the two files under mutation, before the first mutation and after
the last revert — identical, and identical to `origin/feature/TEAM-4314--kiro-opus-workflow-tab-sidebar-dark-sle`:

```
43ab6ee15ae10c1326e3b3d9438db4677994f1f2  src/app/workflow/page.tsx
1dae00db79b901a57ca3615edb67616814d44615  src/styles/globals.css
```

---

## The measured gutter ladder

`offsetWidth - clientWidth` on an overflowing scroller, Chromium 148, headless,
`ignoreDefaultArgs: ["--hide-scrollbars"]` (without which every gutter reads 0 and the
whole discriminator disappears — this is what made an earlier probe wrongly conclude the
check was impossible):

| scroller | clean (TEAM-4330 applied) | under M1 (reset block deleted) |
|---|---|---|
| native — bare page, no app CSS | **15** | 15 (unaffected: no app CSS) |
| `scrollbar-width: thin` control div | **10** | 10 (unaffected by the fix, by design) |
| `[data-testid=workflow-history-list]` | **6** | **10** |
| computed `scrollbarWidth` / `scrollbarColor` on the list | `"auto"` / `"auto"` | `"thin"` / `"rgb(42, 42, 58) rgba(0, 0, 0, 0)"` |

Verbatim logged lines:

```
clean:  [A1] gutter ladder: native=15 thin=10 app=6  | scrollbarWidth="auto" scrollbarColor="auto"
M1:     [A1] gutter ladder: native=15 thin=10 app=10 | scrollbarWidth="thin" scrollbarColor="rgb(42, 42, 58) rgba(0, 0, 0, 0)"
```

Under M1 the app container and the un-fixed `thin` path **collapse to the same 10px**,
which is what `expect.soft(m.gutter).not.toBe(thinGutter)` states directly. The `6 → 10`
flip reproduces TEAM-4330's own recorded BEFORE line:

```
- [chromium/dark] reserved gutter must be 6px (proves the webkit width paints) — got 10
```

## The calibrated title numbers

Measured, not guessed. Available width is the title `<p>`'s **flex parent's**
`clientWidth` — a Tailwind `truncate` `<p>` shrinks to its content when the text fits, so
`clientWidth - scrollWidth` is 0 whenever it is *not* clipped and cannot express headroom.

| fixture title | length | `scrollWidth` | available @288 | available @640 | verdict |
|---|---|---|---|---|---|
| `SHORT_TITLE` | 30 | 189px | 223px | 575px | fits everywhere — control row |
| `MEDIUM_TITLE` | **65** | **393px** | 223px | 575px | **clipped by 170px @288; 182px headroom @640** |
| `ABSURD_TITLE` | 300 | 1823px | 223px | 575px | clipped at every width (by 1248px @640) |

65 maximises the smaller of the two margins (170 / 182), so the reveal is ~170px clear of
the clip boundary in **both** directions and cannot flip on a small font-metric drift
between local and CI. D1 asserts the margins (`>= 100`), not just the booleans.

---

## Committed screenshots

| file | what it shows |
|---|---|
| `truncation-reveal-dark.png` | D1's own output. Dark theme, sidebar driven to the **640px** max. The 65-char `MEDIUM_TITLE` (TEAM-4401) renders **in full** — "…persist width acr" with no ellipsis — while the 300-char `ABSURD_TITLE` (TEAM-4402) is **still clipped** with a trailing ellipsis ("…for operators R…"). The 30-char control row (TEAM-4400) fits, as it does at every width. No horizontal scrollbar on the list; the vertical thumb is visible as a thin light line at the list's right edge. |
| `A4-gutter-strip-dark.png` | The raw strip A4 decodes: **6 × 735 px**, 228 bytes. Correct but essentially unreadable at 1:1, hence the magnified version below. |
| `A4-gutter-strip-dark-8x.png` | The same strip at **8× nearest-neighbour**, two panels: left = top 155 source rows, right = bottom 155. Left shows the thumb token `rgb(42,42,58)` starting **flush at row 0** (corner pixels slightly darker — the 3px `border-radius`) and running ~128 rows before dropping to container background `rgb(18,18,26)`; **no arrow button above it**. Right shows uniform background — **no `▼` button at the bottom either**. Each panel is 48px wide = 6 source px, i.e. the 6px gutter. Generated with Playwright + `image-rendering: pixelated` (no new dependency). |

Note that the *absence* of arrow buttons is what the picture shows, but per the table below
it is **not** a discriminator: Chromium's thin scrollbar paints no arrow buttons here
either. The discriminating pixel fact is the thumb being flush at row 0.

---

## BEFORE / AFTER table

"BEFORE" = the clean base branch (assertion passes). "AFTER" = the mutation applied
(assertion fails). Lines are verbatim from the Playwright output in
`/tmp/TEAM-4332/mutations/mN-after.txt`.

| # | Mutation | Test(s) run | BEFORE | AFTER — verbatim discriminating line |
|---|---|---|---|---|
| **M1** | `globals.css`: delete the whole `@supports selector(::-webkit-scrollbar)` reset block | A1, A4, A5 | 3 passed | **A1** `expect.soft(m.gutter).toBe(6)` → `Expected: 6` / `Received: 10`<br>**A1** `expect.soft(m.gutter).not.toBe(thinGutter)` → `Expected: not 10`<br>**A1** `Expected: "auto"` / `Received: "thin"`<br>**A1** `Expected: "auto"` / `Received: "rgb(42, 42, 58) rgba(0, 0, 0, 0)"`<br>**A4** `Expected: 6` / `Received: 10`, and `expect.soft(s.topRowsHaveThumb).toBe(true)` → `Expected: true` / `Received: false`<br>**A5** `Expected: 6` / `Received: 10`, `Expected: "auto"` / `Received: "thin"`, `Expected: "auto"` / `Received: "rgb(206, 212, 218) rgba(0, 0, 0, 0)"` |
| **M2** | `page.tsx`: drop `clampHistoryWidth(...)` from the ArrowLeft/ArrowRight handler | C3, C4, C5 | 3 passed | **C3** `expect(await aria(page, "aria-valuenow")).toBe(MIN_WIDTH)` → `Expected: 240` / `Received: -32`<br>**C4** `Expected: 640` / `Received: 768`<br>**C5** `Expected: 450` / `Received: 768` |
| **M3** | `page.tsx`: delete the ArrowLeft/ArrowRight handler body entirely | C2 | 1 passed | **C2** `expect(await aria(page, "aria-valuenow")).toBe(304)` → `Expected: 304` / `Received: 288` |
| **M4** | `page.tsx`: `recompute` calls `applyWidth(x, true)` instead of `applyEffectiveWidth(x)` | E3 | 1 passed | **E3** `expect((await widthWrites(page)).length).toBe(0)` → `Expected: 0` / `Received: 1` |
| **M5** | `page.tsx`: remove the `pointercancel` listener | E1 | 1 passed | **E1** `expect(body.userSelect).toBe("")` → `Expected: ""` / `Received: "none"` |
| **M6** | `page.tsx`: remove `truncate` from the title `<p>` | D1, D2 | 2 passed | **D1** `expect(at288.clipped).toBe(true)` → `Expected: true` / `Received: false` |

Every mutation's control test (`fixture sanity`) passed, so each failure above is
attributable to the mutation and not to a broken harness.

### M4 fails on the write COUNT, not on a stored value

This is the point of instrumenting `Storage.prototype.setItem` into `window.__setItemLog`.
TEAM-4331's original leak wrote the *same* value twice, so an assertion that compared only
the final stored string passes on the broken code. E3 fails at
`expect((await widthWrites(page)).length).toBe(0)` — `Expected: 0 / Received: 1` — before
it ever looks at the value. Every write assertion in the suite counts writes.

---

## Honest notes — deviations and non-discriminating assertions

### M2's C5 signature is 768, not the predicted 464

The prediction was that an unclamped keyboard path would read **464** at a 900px viewport
(288 + 16k passes through 448 then 464, never landing on 450). The measured value is
**768**. The prediction assumed the press walk stops at the first value past the bound;
it does not — C5 presses ArrowRight 30 times unconditionally, so with no clamp the width
runs all the way to 288 + 16·30 = **768**. The assertion is still fully discriminating
(`450` vs `768`); only the predicted number was wrong. 464 is what a *single* press past
448 would produce, and it never appears because nothing stops the walk.

### Assertions that are CORROBORATING ONLY — they do NOT detect their regression

These are documented in-code with the same wording, so nobody later mistakes them for
coverage:

| Assertion | Why it is not discriminating |
|---|---|
| **All of A2** — `::-webkit-scrollbar` `width`/`height` `6px`, thumb `backgroundColor`/`borderRadius`, `-button { display: none }` | Chromium returns the **declared** pseudo-element values whether or not they paint, so all of A2 passes on the broken code. This *is* review finding C1 — it is exactly why the old spec's `width === "6px"` assertion passed on a regression. A2 documents the intended declarations; **A1's gutter and A4's raster are what discriminate.** |
| **A4 `bottomRowsAllBackground`** | Measured `true` under M1 as well. Chromium's thin scrollbar paints **no bottom arrow button** in this configuration, so there is no `▼` chrome to lose. An earlier dev-server observation ("last 3 rows non-background") did **not** reproduce on the production build and was wrong. Kept only to pin `::-webkit-scrollbar-button{display:none}` against a future change that reintroduces arrow chrome. |
| **A4 `anyNearWhite === false`** | The R1.5 literal ("never a solid white bar"), but `false` in both states — the thin scrollbar paints the same dark token. Documents the requirement; detects nothing. |
| **A4 `thumbTokenPixels > 50`** | A **non-vacuity guard**, not a discriminator: 774 clean vs 768 under M1, both far above the threshold. Its job is to prove the decode captured a real thumb, so `anyNearWhite === false` cannot pass on an empty buffer. |
| **A3 (the `thin` control div reserves 10px)** | Unchanged by the fix by design — that is what makes it a control. It shows 10-vs-6 in the same page and same run, so "declared but not painting" is legible; it is not itself a regression detector. |
| **A1's `nativeGutter` (15)** | A platform metric, so it is asserted only as an **ordering** (`native > thin`), never pinned to 15. |
| **D2 under M6** | D2 **passed** under M6 and is therefore not a discriminator for it. Correctly so: removing `truncate` makes the title *wrap*, which produces no horizontal overflow. D1 alone carries M6. D2 covers R2.8 clause 2 (no horizontal scrollbar at 240/288/640), which no mutation here targets. |

### A4's discriminating channel is `topRowsHaveThumb`

At `scrollTop = 0` the thumb sits flush against row 0 only when the `::-webkit-scrollbar`
rules govern the paint; on the standard thin path it is inset behind ~9 rows of track.
`true → false` under M1. Verbatim logs:

```
clean:  [A4] anyNearWhite=false thumbTokenPixels=774 topRowsHaveThumb=true  bottomRowsAllBackground=true
M1:     [A4] anyNearWhite=false thumbTokenPixels=768 topRowsHaveThumb=false bottomRowsAllBackground=true
```

### Two spec defects the differential itself exposed

The mutation runs were not just confirmation — they found two real weaknesses, both fixed:

1. **A1/A4/A5 used hard `expect`s on independent measurements.** M1's first run aborted
   each test at its first failure, so A1's `auto`/`auto` pair and **all** of A4's raster
   channels never executed — A4 added nothing over A1 in exactly the regression it exists
   to catch. Converted to `expect.soft`, and A4/A5 now clip the **measured** gutter rather
   than a hardcoded 6, so the raster is compared like-for-like in both states instead of
   sampling 6px of a 10px scrollbar. Re-ran M1: A1 now reports 4 failing channels.
2. **`titleMetric` selected `${LIST} p.truncate`** — the class under test. Under M6 the
   element simply vanished from the selector and D1 failed with
   `no title <p> with exact text (len 65); saw lengths []`, i.e. it was proving *the class
   string exists*, not that the title is clipped. Changed to `${LIST} p` matched by exact
   `textContent`, so the element is findable in both states and D1 now fails on the real
   behavioural consequence: `expect(at288.clipped).toBe(true)` → `Expected: true /
   Received: false`, because a wrapping `<p>` has `scrollWidth === clientWidth`.

### Harness defect found and fixed — why the control test exists

The first M2 run produced a **false signature**: C3/C4/C5 all failed with
`page.waitForSelector: Test timeout of 30000ms exceeded` on the resize handle, and the
failure screenshot was a blank white page. The cause was not the mutation. `npm run start`
forks `next-server` as a child, so killing the npm wrapper **orphaned** the server, which
kept listening on 3737; the next `npm run build` then overwrote `.next` underneath that
live process, which went on serving HTML referencing chunk hashes that no longer existed.
React never mounted. The new server's `EADDRINUSE` was in a log nobody was reading.

Fixed three ways: launch `npx next start` directly, kill by command-line match (with the
bracket trick — a bare `pkill -f "next start"` matches its own command line and kills the
invoking shell), abort the run if `EADDRINUSE` appears, and **run a control test first**
so a broken harness can never be recorded as a mutation result. Re-run, M2 produced the
real clamp signature. This machine has no `ss`, `fuser` or `lsof`, so the original
port-to-pid lookup was dead code.
