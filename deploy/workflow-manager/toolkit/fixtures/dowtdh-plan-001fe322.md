# Plan: Clear the Activity feed with an undo window
- Workflow: wf_1788731227559_dowtdh / Epic: TEAM-4162 / Plan ticket: TEAM-4177 / Spec commit: b7b40187 / Design doc: .sdlc/wf_1788731227559_dowtdh/design/frontend-designer.md / Author: agentcore_hub_frontend_dev / Status: proposed

## Approach

Build the spec's Design and the designer's DOM/CSS into the existing store and feed component. No new module, no new dependency, no backend. Ordered steps:

### (a) `src/activity/activityStore.ts` — two new exported functions

Add both functions after `addActivity`, reusing the existing private helpers so the fail-soft `try`/`catch` (`readStoredActivities` :93, `writeStoredActivities` :118), the `sanitizeActivities` de-dupe/sort/cap (:71), and the `MAX_VALID_DATE_TIMESTAMP` bound (:37) are inherited, never duplicated.

- `export function clearActivities(): Activity[]` — `const removed = readStoredActivities()` (already sanitized, newest-first); `writeStoredActivities([])`; `notifySubscribers()` (:135); `return removed`. The return is exactly the removed entries, newest-first, matching R1's "returns the removed entries".
- `export function restoreActivities(entries: Activity[]): Activity[]` — `const merged = sanitizeActivities([...entries, ...readStoredActivities()])` (snapshot first so on an id collision the snapshot entry wins under sanitize's keep-first-occurrence rule, matching R2's "same ids"); `writeStoredActivities(merged)`; `notifySubscribers()`; `return merged`.

**Return type deviates from spec deliberately.** The spec's Design brief (line 98) types `restoreActivities(entries): void`. This plan returns the sanitized `Activity[]` instead so the component can keep its in-memory list correct when a storage write fails (see R8 below). The signature is a strict superset: any `void` caller is unaffected. Tracked as Concern 10.

### (b) `src/activity/ActivityFeed.tsx` — Clear button, undo affordance, status, timer, focus

Module constant: `const UNDO_WINDOW_MS = 5000`.

State (added to the existing `activities` / `now`): `isWindowOpen: boolean`, `statusMessage: '' | 'Activity cleared.' | 'Activity restored.'`, `undoWindowKey: number` (incremented on each clear to restart the timer effect).

Refs: `undoSnapshotRef: Activity[] | null` (memory-only snapshot, `useRef<Activity[] | null>(null)`), `clearButtonRef: useRef<HTMLButtonElement>(null)`, `undoButtonRef: useRef<HTMLButtonElement>(null)`, `headingRef: useRef<HTMLHeadingElement>(null)`, `pendingFocusRef: useRef<'undo' | 'clear' | null>(null)`.

Follow the designer's DOM skeleton (frontend-designer.md lines 380–422) exactly:
- header `div.activity-feed__header` containing `<h2 id="activity-feed-title" className="activity-feed__title" tabIndex={-1} ref={headingRef}>Recent Activity</h2>` and, only when `hasStoredEntries`, the `<button type="button" className="activity-feed__button" ref={clearButtonRef} onClick={handleClear}>Clear activity</button>`.
- always-mounted `div` with class `activity-feed__notice` plus `activity-feed__notice--active` when `isNoticeActive` (`statusMessage !== '' || isWindowOpen`), containing `<p role="status" className="activity-feed__status">{statusMessage}</p>` and, only when `isWindowOpen`, the `<button ... ref={undoButtonRef} onClick={handleUndo}>Undo</button>`.
- body slot: `hasStoredEntries ? <ul className="activity-feed__list" aria-live="polite"> … </ul> : !isWindowOpen ? <p className="activity-feed__empty">No recent activity yet. Actions you take will show up here.</p> : null`. The empty paragraph is suppressed while the window is open (satisfies R2 "replaces the empty-state paragraph").

`const hasStoredEntries = activities.length > 0`. This equals "stored count >= 1" because `getVisibleActivities()` is `getActivities().slice(0, 20)` and `slice(0, 20)` of a non-empty array is non-empty; so no second store read is needed to gate the Clear button. The existing `ul aria-live="polite"` is unchanged (R7).

**TIMER (R3):** implement as an effect that owns its own id, mirroring the existing `REFRESH_INTERVAL_MS` interval pattern (ActivityFeed.tsx:65):
```
useEffect(() => {
  if (!isWindowOpen) return
  const id = setTimeout(handleExpire, UNDO_WINDOW_MS)
  return () => clearTimeout(id)
}, [isWindowOpen, undoWindowKey])
```
This is the spec's R3 "each effect invocation owns and clears its own timer id" pattern: StrictMode-safe (double-invoke creates and clears its own id) and it cleans up on unmount for free (no callback fires after unmount). The designer's sketch used an imperative `timerRef`; **we follow the spec's effect-owned pattern instead** — the visible behavior is identical, and `undoWindowKey++` on a second clear re-runs the effect so the window restarts.

**R8 in-memory consistency (critical — verified against the code).** The existing subscriber does `setActivities(getVisibleActivities())` (ActivityFeed.tsx:57), i.e. it RE-READS localStorage on every notification. If `setItem` throws during clear, storage still holds the old entries, so the pub/sub re-read would re-render them and the list would NOT empty — the R8 component test ("with setItem throwing, clicks Clear and asserts the list still empties in memory, the Undo affordance still shows") would fail. Therefore:
- `handleClear` calls `const removed = clearActivities()` then `setActivities([])` itself (last).
- `handleUndo` calls `setActivities(restoreActivities(snapshot).slice(0, MAX_VISIBLE_ACTIVITIES))`.

Ordering guarantee: `clearActivities()`/`restoreActivities()` run `notifySubscribers()` synchronously, so the subscriber's `setActivities(getVisibleActivities())` is queued first; the handler's own `setActivities(...)` is queued last. Both queued setState calls run inside the same React event batch, so the handler's value wins. On the success path both values are identical (`[]` for clear; `merged.slice(0,20)` equals the fresh read for undo); only on write failure does the handler's value differ and correctly hold the in-memory truth. This is why `restoreActivities` returns the sanitized list (Concerns 10, 11).

**handleClear:** `const removed = clearActivities()`; `undoSnapshotRef.current = [...removed, ...(undoSnapshotRef.current ?? [])]` (second-clear merge, newest clear first); `setActivities([])`; `setStatusMessage('Activity cleared.')`; `setIsWindowOpen(true)`; `setUndoWindowKey(k => k + 1)` (restart timer); `pendingFocusRef.current = 'undo'`.

**handleUndo:** `const snapshot = undoSnapshotRef.current ?? []`; `const merged = restoreActivities(snapshot)`; `undoSnapshotRef.current = null`; `setActivities(merged.slice(0, MAX_VISIBLE_ACTIVITIES))`; `setIsWindowOpen(false)`; `setStatusMessage('Activity restored.')`; `pendingFocusRef.current = 'clear'`. Setting `isWindowOpen=false` tears down the timer effect (cleanup clears the timeout).

**handleExpire (timer callback):** read `const undoHadFocus = document.activeElement === undoButtonRef.current` FIRST (before any state update unmounts the button); then `undoSnapshotRef.current = null`; `setIsWindowOpen(false)`; `setStatusMessage('')` (removing text announces nothing — R7); if `undoHadFocus`, `headingRef.current?.focus()` (the heading is always mounted, so this is safe synchronously).

**FOCUS effect:** `useEffect(() => { const target = pendingFocusRef.current; if (!target) return; pendingFocusRef.current = null; if (target === 'undo') undoButtonRef.current?.focus(); else clearButtonRef.current?.focus() }, [isWindowOpen, hasStoredEntries])`. The dep list changes exactly when the target button mounts (`isWindowOpen` for Undo, `hasStoredEntries` for Clear after undo). RTL's `fireEvent`/`act` flushes effects, so `toHaveFocus()` assertions in the R6 tests are synchronous.

**Second clear during an open window:** handled by handleClear's merge + `setUndoWindowKey(k => k + 1)`; `statusMessage` is re-set to `'Activity cleared.'` (same string; some SRs won't re-announce identical live text — acceptable per R7 and the designer's note).

No Activity entry is written by clear or undo (R5). No `console` output anywhere (R8, and the `console.error` spy test at line 143 must stay green).

### (c) `src/activity/ActivityFeed.css` — append the designer's block verbatim

Append the ready-to-paste CSS block from frontend-designer.md lines 289–376 verbatim: `.activity-feed__header`, `.activity-feed__header .activity-feed__title`, `.activity-feed__title:focus`, `.activity-feed__button` (+ `:hover, :active`, `:focus-visible`), `.activity-feed__notice`, `.activity-feed__notice--active`, `.activity-feed__status`, `.activity-feed__status:empty`. Only existing token values are used, plus the two flagged numerics: `min-height: 2.75rem` (44 px target) and `2px` outline width/offset (designer Concern 9). The existing `@media (max-width: 400px)` block is left untouched.

### (d) Tests — append only, never edit an existing test

- `src/activity/activityStore.test.ts`: append a new `describe('clearActivities / restoreActivities', ...)` block. The existing top-level `describe('activity store', ...)` already does `localStorage.clear()` + `vi.useRealTimers()` in its own `beforeEach`; a sibling `describe` needs its own identical `beforeEach`. No existing test or setup is touched.
- `src/activity/ActivityFeed.test.tsx`: append a new `describe('Clear activity + undo window', ...)` block with its own `beforeEach`/`afterEach` mirroring lines 20–27. The file already imports `act, fireEvent, render, screen, within` and `addActivity`; the new block additionally needs `getActivities`, `clearActivities`, `restoreActivities` from `./activityStore` — **importing more symbols from an already-imported module is an added import line, not an edit to an existing test**, so it is allowed; if a reviewer prefers zero change to the existing import line, put the new suite in a new sibling file `src/activity/ActivityFeed.clear.test.tsx` with its own imports. Recommendation: append to the existing files (simpler, matches the "new cases may be added to the existing files" allowance in the spec Design brief line 101). Decision recorded in Open questions (4)/Concerns if appending proves to require touching setup.

### (e) Verification commands

`npm test` (vitest run — all suites, existing unmodified and passing), `npm run lint` (`tsc --noEmit`), `npm run build` (`tsc -b && vite build`). Then: `git diff --stat` touches only the four source/test files plus plan.md (and docs/ screenshots at implement time); `git diff --quiet -- src/App.tsx src/App.css` (byte-identical, R9); `git diff -- package.json package-lock.json` shows no dependency change; confirm no `DEPLOY.md` exists.

### (f) Visual evidence (implementation ticket)

Screenshots at 320 px and 1280 px saved under `docs/`, following the existing `docs/TEAM-<n>-*.png` convention (e.g. `docs/TEAM-3649-empty-state.png`): `docs/TEAM-4162-clear.png`, `docs/TEAM-4162-undo.png`, `docs/TEAM-4162-narrow.png`. `docs/` screenshots ARE an allowed file touch for the implementation ticket (the convention already exists and the spec Test plan names these artifacts); they are produced at implement/QA time, not in this plan step. Listed in Files.

## Files

| Path | Change (add/modify/delete) | Why |
| --- | --- | --- |
| `src/activity/activityStore.ts` | modify | Add exported `clearActivities()` and `restoreActivities()` reusing existing private helpers (R1, R2, R8). |
| `src/activity/ActivityFeed.tsx` | modify | Add Clear button, inline Undo affordance, `role="status"`, effect-owned timer, focus management (R1–R8). |
| `src/activity/ActivityFeed.css` | modify | Append the designer's header/button/notice/status CSS block verbatim. |
| `src/activity/activityStore.test.ts` | modify (append new `describe` only) | Store unit tests for clear/restore (R1, R2, R8, R10). |
| `src/activity/ActivityFeed.test.tsx` | modify (append new `describe` only) | Component tests for clear/undo/expiry/reload/keyboard/focus/no-self-log (R1–R8, R10). |
| `.sdlc/wf_1788731227559_dowtdh/plan.md` | add (this file) | The plan; also carries the Deviations log. |
| `docs/TEAM-4162-clear.png`, `docs/TEAM-4162-undo.png`, `docs/TEAM-4162-narrow.png` | add (implement/QA ticket) | Visual evidence at 1280 px and 320 px per spec Test plan and docs/ convention. |

Files that MUST NOT change: `src/App.tsx`, `src/App.css` (R9, byte-identical), `package.json`, `package-lock.json` (R9, no dependency change). Also unchanged: every existing test case, `DEPLOY.md` (must not be created).

## What could this break?

- **Existing store callers** — `App.tsx` imports only `addActivity`; `ActivityFeed.tsx` imports `getActivities, subscribe`; the two test files import `addActivity, getActivities, subscribe` (grepped). New exports are additive; no existing import breaks. *Mitigation: additive-only API.*
- **pub/sub re-read vs local setState race (R8)** — the subscriber re-reads storage on notify; on a failed write it would resurface stale entries. *Mitigation: handler's own `setActivities` is queued last in the same batch and wins.* On the next `addActivity` after a failed clear, the store re-reads storage (still holding the old entries) and prepends the new one, so old entries resurface — this is the accepted "persistence degraded" behavior of R8/R9 (no error UI, no throw).
- **StrictMode double effects** — timer effect, focus effect, and the existing subscription+interval effect all double-invoke in dev. *Mitigation: each owns and clears its own id/subscription (timer via effect cleanup; focus effect is idempotent because it nulls `pendingFocusRef` on run).*
- **Timer after unmount** — *Mitigation: the effect's cleanup `clearTimeout(id)` runs on unmount; no callback fires late.*
- **Second-clear timer restart** — *Mitigation: `undoWindowKey++` changes the effect dep, so the old timeout is cleared and a fresh `UNDO_WINDOW_MS` starts.*
- **Focus when Undo unmounts on expiry** — reading `document.activeElement` after `setIsWindowOpen(false)` would be too late. *Mitigation: read `undoHadFocus` before any state update; heading stays mounted so `.focus()` is safe.*
- **`:empty { display:none }` on the live region** — a `display:none` live region can miss a first announcement. *Mitigation: the paragraph is always mounted and only display-toggled in the same frame the text is set; designer documents the `min-height: 0` fallback if manual QA shows a missed announcement.*
- **`.settings__section h2` margin override specificity** — verified: `.settings__section h2` is (0,1,1) with `margin: 0 0 0.5rem` (App.css:29–34); `.activity-feed__header .activity-feed__title` is (0,2,0) with `margin: 0`, which wins regardless of stylesheet order, and `.activity-feed__header` supplies `margin-bottom: 0.5rem` so list/empty spacing below the heading is unchanged.
- **Existing-test query collisions** — all verified against the real test file (line numbers current at spec commit, re-confirmed):
  - empty-state structural test at line 159, assertions `queryByRole('list')` null (168), `queryAllByRole('listitem')` length 0 (169), `document.querySelector('ul')` null (170), `document.querySelector('li')` null (171): satisfied because in the empty state neither button renders and the notice/header are `div`/`p`, never `ul`/`li`/`role="list"`.
  - bare `getByText('settings')` at lines 46 and 64; `getByText('just now')` at line 48 — new strings `Clear activity`/`Undo`/`Activity cleared.`/`Activity restored.` collide with none.
  - `getByRole('list')` at lines 106 and 137 — no second list role added.
  - `getByRole('button', { name: 'Toggle email notifications' })` at line 54; `getByText('On')` at line 60 — new button names/strings are distinct.
  - `records production settings interactions` at line 51 renders `<App />`, clicks the toggle → one entry stored → the `Clear activity` button now renders in that test; it does not collide with any query there and the toggle lookup still resolves uniquely.
  - `cleans up its subscription on unmount` at line 143 spies on `console.error` and asserts it is never called — the new timer effect adds no logging and cleans up on unmount, so it stays green.
- **200% zoom / 320 px wrap (designer Concerns 8, 9)** — header and notice use `flex-wrap`; the Clear pill drops under the heading below ~388 px, label wraps to two lines at 200% zoom; measured `scrollWidth` 320 with no horizontal scroll. *Mitigation: accept the designed wrap; no new media query.*
- **Performance** — one extra `setTimeout` per clear; storage read count per render is unchanged (still one `getVisibleActivities()` on notify; `hasStoredEntries` derives from `activities`, no extra read). *Negligible.*
- **tsc strictness** — refs typed `useRef<HTMLButtonElement>(null)` / `useRef<HTMLHeadingElement>(null)` / `useRef<Activity[] | null>(null)` / `useRef<'undo' | 'clear' | null>(null)`; `statusMessage` typed as the literal union; `noUnusedLocals`/`noUnusedParameters` satisfied. *Mitigation: no `any`; all refs read.*
- **vitest fake timers vs the existing 30s interval and `vi.setSystemTime`** — under `vi.useFakeTimers()`, `advanceTimersByTime` advances both the 5000 ms undo timeout and the 30_000 ms refresh interval; tests scope assertions to what they check and advance precise amounts (4999/5000). *Mitigation: each new component test seeds with `vi.setSystemTime` where relative labels matter and uses `act(() => vi.advanceTimersByTime(...))`.*

## Test plan

Run: `npm test`. Component tests use `vi.useFakeTimers()` + `vi.setSystemTime(...)` and `act(() => vi.advanceTimersByTime(ms))`; scope with `within(section)` where a role/label could be ambiguous; storage-failure via `vi.spyOn(Storage.prototype, 'setItem'|'getItem').mockImplementation(() => { throw ... })`; reload simulated by `unmount()` + fresh `render(...)`. Keyboard via `fireEvent.keyDown`/`fireEvent.click` for Enter/Space on native buttons.

| Req | File | Case name (`it('...')`) | What it asserts |
| --- | --- | --- | --- |
| R1 | activityStore.test.ts | `clearActivities empties storage and returns removed entries newest-first` | Seed several entries; `clearActivities()` returns them newest-first; `getActivities()` is `[]`; raw `demo.activity` parses to `[]`. |
| R1 | ActivityFeed.test.tsx | `shows Clear activity only when entries are stored` | With entries seeded, `within(section).getByRole('button', { name: 'Clear activity' })` present; with storage empty, `queryByRole('button', { name: 'Clear activity' })` null and empty copy shows. |
| R1 | ActivityFeed.test.tsx | `Clear removes all stored entries not just the visible 20` | Seed >20 entries; click Clear; list gone; `getActivities()` is `[]`; `document.querySelector('li')` null. |
| R2 | activityStore.test.ts | `restoreActivities merges, de-dupes by id, sorts newest-first, caps at 100` | Snapshot + a stored entry overlapping by id; result de-duped (snapshot wins), newest-first, length capped at 100. |
| R2 | ActivityFeed.test.tsx | `Clear shows Undo and status, Undo restores exact entries in order` | Fake timers; seed; click Clear → `Undo` button + `Activity cleared.` status; click Undo → same entries in same order render, Undo affordance gone. |
| R2 | ActivityFeed.test.tsx | `Undo stays available at 4999ms and disappears at 5000ms` | After Clear, `advanceTimersByTime(4999)` still shows Undo; one more ms (`advanceTimersByTime(1)`) removes it. |
| R3 | ActivityFeed.test.tsx | `expiry removes Undo and restores empty copy, snapshot unrecoverable` | After Clear, `advanceTimersByTime(5000)`; Undo gone, empty copy back; no Undo button offered. |
| R3 | ActivityFeed.test.tsx | `no timer callback and no console error after unmount` | Spy `console.error`; render, Clear, `unmount()`, `advanceTimersByTime(5000)`; spy never called, no throw. |
| R4 | ActivityFeed.test.tsx | `reload inside window shows empty feed with no Undo` | Clear; `unmount()` + fresh `render()` while inside window; empty feed, no Undo. |
| R4 | ActivityFeed.test.tsx | `reload after Undo shows restored entries` | Clear then Undo; `unmount()` + fresh `render()`; restored entries render. |
| R5 | ActivityFeed.test.tsx | `clear and undo write no activity entry` | Capture `getActivities().length` around Clear and around Undo; neither adds an entry. |
| R5 | ActivityFeed.test.tsx | `entry added during window appears and re-enables Clear` | Open window; `act(() => addActivity('settings', '...'))`; new entry in list; `Clear activity` present again; Undo still shown. |
| R5 | ActivityFeed.test.tsx | `second Clear merges snapshot and restarts window, Undo restores both` | Clear; add entry; Clear again; advance <5000 from second clear; Undo → all entries from both clears restored. |
| R6 | ActivityFeed.test.tsx | `Enter activates Clear and focus moves to Undo` | Focus Clear, Enter → `Undo` `toHaveFocus()`. |
| R6 | ActivityFeed.test.tsx | `Space activates Clear and focus moves to Undo` | Space on Clear → `Undo` `toHaveFocus()`. |
| R6 | ActivityFeed.test.tsx | `Undo activation moves focus to Clear` | After Clear, activate Undo → `Clear activity` `toHaveFocus()`. |
| R6 | ActivityFeed.test.tsx | `expiry while Undo focused moves focus to heading` | Clear (focus on Undo), `advanceTimersByTime(5000)` → `Recent Activity` heading `toHaveFocus()`. |
| R7 | ActivityFeed.test.tsx | `status region announces cleared then restored and is not a list` | `getByRole('status')` reads `Activity cleared.` after Clear, `Activity restored.` after Undo; it is a `<p>` (not ul/li/role=list); the `ul` `aria-live="polite"` is unchanged; nothing new announced on expiry (status text becomes `''`). |
| R8 | activityStore.test.ts | `clearActivities and restoreActivities fail soft and still notify` | Spy `Storage.prototype.setItem` (and `getItem`) to throw; neither function throws; subscriber still notified. |
| R8 | ActivityFeed.test.tsx | `Clear empties the list in memory even when setItem throws` | Spy `setItem` to throw; click Clear; list empties in memory, Undo affordance shows, no error text rendered. |
| R10 | (coverage) | — | The rows above are the coverage R10 enumerates. |

Visual evidence artifacts (implement/QA ticket): `docs/TEAM-4162-clear.png` (cleared-with-undo, 1280 px), `docs/TEAM-4162-undo.png` (restored, 1280 px), `docs/TEAM-4162-narrow.png` (320 px, header wrapped).

## Rollback

Revert the single squash commit / merged PR for this feature branch. No data migration is needed — the localStorage format for `demo.activity` is unchanged (still a JSON array of the same Activity shape); reverting the code simply removes the Clear/Undo controls and the two store functions. Entries that users cleared before a rollback are gone by design (the clear committed to storage at click time and the snapshot was memory-only). There is no feature flag in this repo — none exists to toggle — so rollback is code revert only.

## Open questions

1. **`restoreActivities` returns `Activity[]` vs spec's `void`.** Recommended: accept `Activity[]` (strict superset; enables the R8 in-memory component assertion). Alternative: keep `void` and relax the R8 component test to assert only that Undo/status appear, not that the list empties on write failure. (Concern 10.)
2. **Effect-owned timer vs designer's imperative `timerRef`.** Recommended: effect-owned `setTimeout` keyed on `[isWindowOpen, undoWindowKey]`, per spec R3 and the existing interval pattern — StrictMode-safe and auto-cleans on unmount. Visible behavior is identical to the designer's sketch.
3. **Commit docs/ screenshots on the feature branch (implementation ticket).** Recommended: yes — the docs/ `TEAM-<n>-*.png` convention already exists and the spec Test plan names these artifacts. They are an allowed file touch.
4. **Accept designer Concerns 7/8/9 as rendered.** Recommended: yes — notice row above the list (7), `flex-wrap` at 320 px (8), and the `2.75rem` / `2px` numerics (9). This plan follows the design as written.

## Policy re-check

- **Security:** no new endpoint, tool, queue, webhook, bucket, table, secret, or network call; the only storage surface is the existing `demo.activity` key, now also written by `clearActivities`/`restoreActivities`. Restore input flows through the existing `sanitizeActivities`/`isActivity` validation. No `console` output added. Matches the spec's Security answers.
- **Compliance:** no new stored field; the undo snapshot is memory-only (`undoSnapshotRef`), never written to storage or transmitted. This is a deletion mechanism plus a transient in-memory restore. Matches the spec's data inventory.
- **Brand:** copy limited to the four proposed strings (`Clear activity`, `Undo`, `Activity cleared.`, `Activity restored.`); tokens limited to the listed existing values plus the two Concern-9 numerics (`2.75rem`, `2px`). No new hex, font, or icon. Matches the spec/design Brand answers.
- **UX:** states (default/empty/cleared-with-undo/restored/expired/storage-failure/disabled-none), keyboard (Tab/Enter/Space on native buttons), focus (Clear→Undo→Clear, heading on expiry), screen reader (single `role="status"`), 320 px, and 200% zoom all as designed. Deviations from the spec's literal wording are the effect-owned timer (spec R3 explicitly permits it) and the notice row placed above the list slot (designer Concern 7); no UX deviation beyond those Concern rows.

## Concerns

| # | Concern | Policy | Owner | Proposed resolution | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | (spec) Brand kit missing; labels/status strings/raw CSS values unverifiable against approved tokens. | Brand | human:brand-lead | Approve as written; plan adds no copy/token beyond the listed set + Concern 9. | open |
| 2 | (spec) Destructive Clear has no confirmation dialog; undo is the safety net. | UX | human:design-lead | Accept undo-only. | open |
| 3 | (spec) Undo auto-dismisses at 5000 ms, not persistent. | UX | human:design-lead | Keep fixed 5000 ms; no focus-pause (designer rec). | open |
| 4 | (spec) Reload inside the window loses undo (commit-at-click-time). | UX/intent | human:product-owner | Accept commit-at-click; snapshot memory-only. | open |
| 5 | (spec) Focus not moved into live region; no `aria-live` on Undo. | UX | human:design-lead | Accept as specified. | open |
| 6 | (spec) Second Clear during window merges snapshot and restarts window. | UX/correctness | human:product-owner | Accept merge-and-restart. | open |
| 7 | (design) Notice row rendered above the list slot so Undo survives a new entry during the window. | UX | human:product-owner | Accept design placement. | open |
| 8 | (design) Heading + Clear cannot share one line at 320 px; button wraps under heading via `flex-wrap`. | UX | human:design-lead | Accept the wrap; no horizontal scroll. | open |
| 9 | (design) Two new numerics: `min-height: 2.75rem` (44 px) and `2px` focus outline. | Brand/UX | human:brand-lead | Approve both values. | open |
| 10 | `restoreActivities` returns the sanitized `Activity[]` instead of `void`, so the component can keep the in-memory list consistent when storage writes fail (R8). | correctness | human:engineer | Accept the superset signature (void callers unaffected). Alternative: keep `void` and relax the R8 component test to assert only Undo/status appear. | open |
| 11 | Component sets `activities` state directly from the clear/restore return values in addition to the pub/sub re-read (needed for R8; behavior identical on the success path, handler's setState wins in-batch). | correctness | human:engineer | Accept the direct setState. Alternative: rely on pub/sub only and drop the R8 in-memory list assertion. | open |
| 12 | New component tests append a `describe` block and add symbols to the existing `./activityStore` import line in `ActivityFeed.test.tsx`; store tests append a `describe` block. No existing test case is edited. If a reviewer treats the added import symbols as touching existing setup, the suite moves to a new sibling file (`ActivityFeed.clear.test.tsx`). | process | human:engineer | Append to existing files (recommended); fall back to sibling file if disallowed. | open |

## Deviations

None yet.
