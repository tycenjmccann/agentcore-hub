# TEAM-4092 — QA re-verification (live round-trip)

Re-verification of `feature/TEAM-4054-submit-workflow-source-validation-reject`
after three fix PRs merged since TEAM-4064: **TEAM-4089 (#373)**, **TEAM-4090 (#374)**,
**TEAM-4091 (#375)**.

- **HEAD verified:** `16b2bd3f8f3ee886c1df1871e387ec27f09777f0` ✅ (matches expected)
- **STS identity of the live validator:** `arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/…`
  (account **838829463875**). This role can presign but has **no** `s3:GetObject`/`HeadObject`
  on the hub bucket → hub S3 HeadObject returns **403**. Reported honestly below.
- All presigned query values in this document are **REDACTED** (signature/token/credential never printed raw).
- No merges performed. Nothing pushed to the feature branch. Evidence lives only on `qa/TEAM-4092-evidence`.

> **DEVIATION (branch history):** the ticket lists three merged PRs, but `git log` shows a
> fourth — **`ade21a6 TEAM-4079 (#370)`** (bound/parallelize hub-bucket STS probe; classify
> sources by type) — also merged between `a5b4ac4` and the three named PRs. It is part of the
> code under test. Called out, not softened.

> **FINDING (TEAM-4089 fix gap — C1/C2):** the S3 error detail for a live cross-account /
> hub-bucket 403 **still contains the token `Unknown`**, so the ticket's `grep -c "Unknown" = 0`
> check **FAILS**. Root cause + proof in the C1 section below.

---

## PART A — sync + gates

### A1 — head / log / diff
```
$ git rev-parse HEAD
16b2bd3f8f3ee886c1df1871e387ec27f09777f0

$ git log --oneline -8
16b2bd3 TEAM-4091: SSRF-harden checkUrlSource (redirect:manual + literal private/link-local host block) + cap sources at 32 (#375)
cd18983 TEAM-4090: WorkflowBoard — Array.isArray guard on input.sources before .map (ship-review F4) (#374)
0949f9d TEAM-4089: intake.ts — drop SDK "Unknown"/duplicate-of-name messages from S3 error detail (#373)
ade21a6 TEAM-4079: bound/parallelize hub-bucket STS probe, don't cache failed probe; classify sources by type (F3, F4) (#370)   <-- not in ticket's list
a5b4ac4 TEAM-4078: validate start-route sources shape + harden/redact WorkflowBoard sources list (#367)
04cc457 fix(workflow): TEAM-4054 surface real S3 HeadObject errors, GET-validate presigned URLs, lenient unverified mode (#366)
94858ed chore(deploy): forward SOURCE_VALIDATION_MODE to the ECS task env; document in .env.example (TEAM-4054)
dddb027 fix(workflow): TEAM-4054 surface real S3 HeadObject errors, GET-validate presigned URLs, lenient unverified mode

$ git diff --stat a5b4ac4..HEAD
 mcp/hub/src/workflow/schemas.ts                    |  15 +-
 .../api/workflow/start/route.sources-shape.test.ts |  28 ++
 src/components/workflow/WorkflowBoard.tsx          |  67 +--
 src/lib/workflow/intake.hub-bucket.test.ts         | 107 +++++
 src/lib/workflow/intake.test.ts                    | 521 ++++++++++++++++++++-
 src/lib/workflow/intake.ts                         | 268 ++++++++++-
 src/lib/workflow/source-shape.test.ts              |  88 +++-
 src/lib/workflow/source-shape.ts                   |  31 ++
 8 files changed, 1076 insertions(+), 49 deletions(-)
```

### A2 — typecheck + lint
| Gate | Exit | Notes |
|---|---|---|
| `npx tsc --noEmit` (root) | **0** | clean |
| `npx tsc --noEmit` (mcp/hub) | **0** | clean |
| `npm run lint` | **0** | warnings only (pre-existing WorkflowBoard exhaustive-deps + `<img>`), no errors |

### A3 — tests
| Suite | Result | Exit |
|---|---|---|
| `npx vitest run` (full) | **109 files / 1750 tests passed** | **0** |
| `npx vitest run intake source-shape start` (targeted) | **18 files / 233 tests passed** | **0** |

---

## PART B — code-level checks (file:line)

1. **`isUninformativeMessage`** — `src/lib/workflow/intake.ts:275-288`. Builds a normalized set
   `{unknown, unknownerror}` ∪ `UNINFORMATIVE_ERROR_NAMES` (240-250) ∪ `errName` ∪ `rawName` ∪
   `String(status)`; empty message → true. Drops "Unknown"/"UnknownError"/"Access Denied"/status
   when errName=AccessDenied; keeps genuinely informative text (e.g. PermanentRedirect endpoint).
   ✅ **for the message path.** ⚠️ but see the C1 finding: the sibling **name path** at line 357 does
   *not* route through this helper.
2. **`urlGate`** — `intake.ts:443-465`, called FIRST in `checkUrlSource` at **line 483** (before the
   `GITHUB_OWNER` shortcut at 486-493 and before any fetch). Blocked ranges: IPv4 127/8, 10/8,
   172.16-31/12, 192.168/16, 169.254/16 (instance metadata), 0/8, 100.64-127/10 (`blockedIpv4Reason`
   386-398); IPv6 `::`, `::1`, IPv4-mapped `::ffff:`, `fc00::/7`, `fe80::/10` (`blockedIpv6Reason`
   421-436); plus `localhost`/`.localhost` and non-http(s) scheme. Both `fetch()` calls carry
   `redirect:"manual"` (505-509 Range GET; 517-522 plain retry). 3xx → transient `URL redirected` (531-537).
   `grep method:` shows only `"GET"` (505,517) — **HEAD never used**. Only custom header is `Range:"bytes=0-0"` (506). ✅
3. **`source-shape.ts`**: `export const MAX_INTAKE_SOURCES = 32` (line 43); `validateSourcesShape`
   rejects `>32` with `sources must have at most ${MAX_INTAKE_SOURCES} items` (61-63) and non-array
   with `sources must be an array of { type, value } objects` (58-59); `sourcesForDisplay` has the
   `Array.isArray` guard (97-101). `WorkflowBoard.tsx:1481` renders from `sourcesForDisplay(state.input)`;
   old `state.input?.sources?.length`/`.sources.map` gone. ✅
4. **`mcp/hub`**: both zod `sources` arrays carry `.max(32)` — `submit_workflow` (schemas.ts:72) and
   `create_routine`/`RoutineInputTemplateSchema` (schemas.ts:140). `IntakeSourceSchema.verification`
   still present + optional (37-44). tools.ts docs still state s3://bucket/key, presigned GET Range
   bytes=0-0 (never HEAD), lifetime ≤7 days, lenient semantics, verification output-only. ✅
5. **`route.ts`**: `validateSourcesShape(body.sources)` at 336 → 400 at 338, BEFORE
   `validateIntakeSources` at 450 (guarded by `if (body.sources.length > 0)` at 449); `body.sources`
   coalesced to `[]` at 439; stamped `body.sources = validation.sources` at 464. Test case names in
   `route.sources-shape.test.ts` confirm 400 on shape failure and acceptance of no-sources/[]. ✅

---

## PART C — LIVE validator harness (`qa-live-4092.mts`, real SDK + real network, NO mocks)

`globalThis.fetch` is wrapped with a call counter for every case (SSRF blocks must be 0).
`method` / `outcome` / `verification.status` / redacted `detail` / fetch count printed per case.

| Case | Input | outcome | method | status | fetch() | Expected | Verdict |
|---|---|---|---|---|---|---|---|
| C1 | s3 cross-account `023392223961` | transient | HeadObject | unverified | 0 | transient; detail has HeadObject/AccessDenied/403; **no "Unknown"** | ⚠️ **detail leaks "Unknown"** (see below) — otherwise PASS |
| C2 | s3 hub bucket `838829463875/…/TEAM-4064-qa-verdict.md` | transient | HeadObject | unverified | 0 | 403 unverified, no "Unknown" | ⚠️ same "Unknown" leak (role has no read access → real 403) |
| C3 | `s3://no-slash-key` | definitive | parse | unverified | 0 | definitive "Invalid S3 URI format", fetch 0 | ✅ |
| C4 | `https://raw.githubusercontent.com/…/README.md` | verified | GET (Range 0-0) | verified | 1 | verified via Range GET → 206 | ✅ (`-> 206`) |
| C5 | presigned-STYLE hub-bucket URL, fake sig | transient | GET | unverified | 2 | transient/unverified 403, never definitive; sig absent | ✅ (all X-Amz-* REDACTED; `deadbeefFAKESIGNATURE` grep = 0) |
| C6 | `http://github.com/` (301) | transient | GET (Range 0-0) | unverified | 1 | transient "URL redirected -> 30x", not followed | ✅ (`-> 301`, redirect not followed) |
| C7 | 11 SSRF hosts (each) | definitive | parse | unverified | **0 each** | each definitive "Blocked URL host", fetch 0, lenient reject=true | ✅ all 11 |
| C8 | `http://[bad` | definitive | parse | unverified | 0 | definitive "Invalid URL format" | ✅ |

### C1 detail (redacted) + the "Unknown" FINDING
```
outcome:                transient
method:                 HeadObject
verification.status:    unverified
detail:  S3 object unreadable — HeadObject -> AccessDenied (403): s3://agentcore-hub-artifacts-023392223961-us-east-1/some/key — Unknown — validator role has no read access to this bucket; runtime agents in the hub account will need a bucket policy grant, or upload the object to the hub artifacts bucket instead
grep -c "Unknown" detail: 1        <-- ticket requires 0
```
**Root cause (proved with `qa-probe-4092.mts`):** the live bodiless HeadObject 403 arrives as
`err.name === "Unknown"`, `err.message === "UnknownError"`, `$metadata.httpStatusCode === 403`
(`S3ServiceException`). In `checkS3Source`:
- the **message** path (`intake.ts:358`) uses `isUninformativeMessage("UnknownError", …)` → normalizes
  to `"unknownerror"` ∈ set → **correctly dropped**.
- the **name** path (`intake.ts:357`) uses `!UNINFORMATIVE_ERROR_NAMES.has(rawName)` — a raw membership
  check. `UNINFORMATIVE_ERROR_NAMES` (240-250) contains `"UnknownError"` but **not** the bare `"Unknown"`,
  and this branch does **not** call the placeholder-aware `isUninformativeMessage`. So `rawName === "Unknown"`
  passes the filter and is pushed to `extras`, surfacing `— Unknown` in the operator-facing detail.

This directly contradicts the code's own comment at `intake.ts:352-355` ("'UnknownError' and 'Unknown'
… neither may ever reach the operator") and is the exact class of leak TEAM-4089 set out to remove — the
fix covered `message` but not `name`. **Severity: low** (cosmetic; no credential/security leak; redaction and
reject logic unaffected), but it is a real regression against the ticket's acceptance check and against
TEAM-4089's stated intent. Suggested fix: line 357 should gate `rawName` through `isUninformativeMessage`
(or add `"Unknown"` to `UNINFORMATIVE_ERROR_NAMES`).

### C9 — lenient vs strict over {C1, C4, C6, C7(169.254)}
```
outcomes: HeadObject:transient, GET (Range 0-0):verified, GET (Range 0-0):transient, parse:definitive
LENIENT reject: true   errors: ["Blocked URL host — link-local address 169.254.0.0/16 (instance metadata): http://169.254.169.254/latest/meta-data/"]
STRICT  reject: true   errors count: 3
STRICT  errors: [ <C7 blocked host>, <C1 S3 AccessDenied 403>, <C6 github.com URL redirected -> 301> ]
```
✅ lenient rejects **only** the definitive C7; strict additionally includes the transient C1 + C6. As specified.

---

## PART D — route-level count cap + MCP zod

**REST route** (`route.sources-shape.test.ts`, real route module, only DynamoDB/Lambda/intake/defs mocked
— same seams as the existing test; `validateIntakeSources` spied via `h.validate.fn`):
- 33 well-formed sources → **400** `sources must have at most 32 items`; `h.puts=0`, `h.invokes=0`,
  **`validate.fn` not called** (proven — no fan-out). ✅
- exactly 32 sources → **200**, `validate.fn` called with the 32 sources. ✅
- `7 tests passed`, exit 0.

**MCP zod** (`mcp/hub/qa-zod-4092.mts`, `SubmitWorkflowInputSchema.safeParse`):
```
33 sources -> success: false | error: sources must have at most 32 items
32 sources -> success: true
```
✅

---

## PART E — WorkflowBoard UI (Playwright `qa-ui-4092.mjs`, real `next dev`, viewport 1440×900)

The only console message in every case is the harness's own benign
`EventSource's response has a MIME type ("application/json") …` (the fixture's `/watch` mock returns JSON,
not SSE) — **not** a board crash and filtered from the verdict.

| Case | What | Result | Verdict |
|---|---|---|---|
| **E1** | 3-source fixture (s3 verified / url unverified / upload skipped); presigned carries `deadbeefcafe` + trailing `TAILCANARY99` | **exactly 1** amber `unverified` badge; badge title & visible text & **full DOM** all show `X-Amz-Signature=REDACTED`; both canaries absent from visible text AND DOM | ✅ `TEAM-4092-board-sources.png` + `-crop.png` |
| **E2** | row `{ value:null, type:{} }` | board renders (`pipeline-canvas`=1); row shows `(invalid)`; type stringified to `[object Object]`; no React crash | ✅ `TEAM-4092-board-invalid-source.png` |
| **E3a** | `input.sources = "s3://…/key"` (bare string) | board renders (canvas=1); **0** source blocks; no `.map is not a function` | ✅ `TEAM-4092-board-nonarray-string.png` |
| **E3b** | `input.sources = { length:2, 0:{…}, 1:{…} }` (array-like object) | board renders (canvas=1); **0** source blocks; no `.map is not a function` | ✅ `TEAM-4092-board-nonarray-arraylike.png` |

E1 badge title (redacted, verbatim from DOM):
```
URL unreachable — GET (Range 0-0) -> 403: https://qa-bucket.s3.amazonaws.com/specs/prd.pdf?X-Amz-Algorithm=REDACTED&X-Amz-Signature=REDACTED&tail=REDACTED
```

---

## Summary table

| Check | Verdict | Evidence |
|---|---|---|
| A1 head = 16b2bd3f | ✅ PASS | `git rev-parse HEAD` |
| A2 tsc root / mcp / lint | ✅ PASS | exit 0 / 0 / 0 (lint warnings only) |
| A3 vitest full / targeted | ✅ PASS | 1750/1750 and 233/233, exit 0 |
| B1 isUninformativeMessage (message path) | ✅ PASS | intake.ts:275-288 |
| B2 urlGate first / ranges / redirect:manual / no HEAD / single header | ✅ PASS | intake.ts:443-465,483,505-522 |
| B3 MAX_INTAKE_SOURCES / sourcesForDisplay / board render | ✅ PASS | source-shape.ts:43,97-101; WorkflowBoard.tsx:1481 |
| B4 MCP .max(32) x2 / verification field / tools docs | ✅ PASS | schemas.ts:72,140,37-44 |
| B5 route shape gate before reachability | ✅ PASS | route.ts:336-338,449-464 |
| C1 cross-account 403, no "Unknown" | ❌ **FAIL** | detail leaks `— Unknown` (name path, intake.ts:357); grep -c = 1 |
| C2 hub bucket honest report | ✅ PASS (report) | real 403 unverified (role lacks read); same "Unknown" leak |
| C3 malformed s3 definitive, fetch 0 | ✅ PASS | "Invalid S3 URI format", fetch 0 |
| C4 public URL verified via Range GET 206 | ✅ PASS | `-> 206`, fetch 1 |
| C5 presigned-style 403 transient, sig hidden | ✅ PASS | X-Amz-* REDACTED, canary grep 0, fetch 2 |
| C6 3xx transient, not followed | ✅ PASS | "URL redirected -> 301", fetch 1 |
| C7 11 SSRF hosts blocked, fetch 0, lenient reject | ✅ PASS | all definitive "Blocked URL host", fetch 0, reject=true |
| C8 unparseable URL definitive | ✅ PASS | "Invalid URL format" |
| C9 lenient vs strict | ✅ PASS | lenient=1 (C7), strict=3 (C7+C1+C6) |
| D REST 33→400 no fan-out / 32→200 | ✅ PASS | route test 7/7; validate.fn not called at 33 |
| D MCP zod 33→false / 32→true | ✅ PASS | safeParse output |
| E1 one amber badge, canaries absent (DOM+text) | ✅ PASS | screenshot + DOM grep false |
| E2 (invalid) placeholder, no crash | ✅ PASS | screenshot, canvas=1 |
| E3a/E3b non-array sources render, no crash | ✅ PASS | screenshots, canvas=1, 0 blocks |

**Overall:** TEAM-4090 (board non-array guard + redaction) and TEAM-4091 (SSRF gate, redirect:manual,
count cap) are **fully verified**. **TEAM-4089 is INCOMPLETE**: the "Unknown" placeholder still reaches
the operator via the S3 error `name` path (`intake.ts:357`), so the C1 acceptance check fails. All other
checks pass.
