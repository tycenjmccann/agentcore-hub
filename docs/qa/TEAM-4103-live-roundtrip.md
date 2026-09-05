# TEAM-4103 — QA re-verification, live round-trip evidence

**Verified head:** `45694ddcefd00da682c15c581708c3156f9b7266`
**Branch:** `feature/TEAM-4054-submit-workflow-source-validation-reject` (PR #371 → `main`)
**Repo:** tycenjmccann/agentcore-hub
**Date:** 2026-09-05
**Verifier identity (ambient IAM role):** coding-runtime-role, account `838829463875` (no read grant on the hub artifacts bucket — every S3 probe legitimately returns 403).

## Head-mismatch resolution (READ FIRST)

The TEAM-4103 brief named an *expected* head of `6c9d2cd8dea2956844be13f7269d855b5811f388`.
On checkout the branch tip was **`45694dd…`**, a 2-parent merge commit that integrates
`6c9d2cd` (the feature tip, TEAM-4102 #379) with a `main`-merge (2e31e3d, TEAM-4106). Per the
brief's "if it does not, STOP and report the actual SHA" instruction I stopped and reported. The
requester chose **Option 1**: verify the actual tip `45694dd` (now the PR #371 head;
GitHub `mergeable_state` = "clean"). Everything below is against `45694dd`.

**Merge integrity is proven in Section A:** the entire source-validation *logic* surface
(`intake.ts`, `redact.ts`, `source-shape.ts`, `mcp/hub` `schemas.ts` + `tools.ts`, and the
`start` route) is **byte-identical to `6c9d2cd`** at this tip (empty diff). The merge added only
`main`'s CD-registry work plus `types.ts` (+7, a `delivery?` field) and `WorkflowBoard.tsx` (+28,
a new *delivery badge* that is a separate block from the sources block — see G1).

---

## Section A — checkout + git facts

| # | Check | Result | Exit |
|---|---|---|---|
| A1 | `git rev-parse HEAD` | `45694ddcefd00da682c15c581708c3156f9b7266` — **matches Option-1 target** | 0 |
| A3 | merge parents | `45694dd` ← `2e31e3d` (main-merge) + `6c9d2cd` (feature tip) | 0 |
| A3b | `origin/main` tip | `c12a8f73df5385472c4773e47592c7612bc7dc9a` | 0 |
| A3c | feature delta `origin/main...HEAD` | **24 files, +3415 / −74** (matches GitHub PR #371) | 0 |
| A4a | validator logic files vs `6c9d2cd` | **empty diff (byte-identical)** | 0 |
| A4b | TEAM-4093 `formatSourceLine` in orchestrator | def @3321, call @3542 | 0 |
| A4c | main's CD-registry survived merge | all 4 files present at HEAD | 0 |
| A4d | `sourcesForDisplay` / `delivery` in WorkflowBoard | 3 / 10 hits (both present) | 0 |
| A6 | `deploy/ecs-express/deploy.sh` delta | forwards **only** `SOURCE_VALIDATION_MODE` env | 0 |

```
$ git log --graph --oneline -6
*   45694dd merge: integrate origin/feature/TEAM-4054 (6c9d2cd TEAM-4102 #379) with main-merge (TEAM-4106)
|\
| * 6c9d2cd fix(mcp): TEAM-4102 advertise 32-source cap (maxItems + description) ...
* |   2e31e3d merge: origin/main into feature/TEAM-4054 — pick up 10955cd0 ... (TEAM-4106)
|\ \
| |/
|/|
| * c12a8f7 feat: CD registry — unregistered repos hand off at an open PR ... (#369)
...

$ git diff --shortstat origin/main...HEAD
 24 files changed, 3415 insertions(+), 74 deletions(-)        # exit 0

$ git diff --stat 6c9d2cd..HEAD -- src/lib/workflow/intake.ts src/lib/workflow/redact.ts \
    src/lib/workflow/source-shape.ts mcp/hub/src/workflow/schemas.ts \
    mcp/hub/src/workflow/tools.ts src/app/api/workflow/start/route.ts
(no output — byte-identical)                                  # exit 0
```

**A5 — `WorkflowBoard.tsx` delta `6c9d2cd..HEAD` (+28):** a new terminal-phase *delivery badge*
block at line 1818, gated on `isTerminalPhase(state.phase) && state.delivery`
(`data-testid="delivery-badge"`; "Handoff" amber vs "CD" emerald). It is rendered down in the
terminal-phase footer region (next to `RunPerformanceCard` / `WorkflowManagerPanel`), **separate
from the sources block** which lives at the top of the board (`sourcesForDisplay(state.input)`,
line ~1481). No overlap — confirmed visually in G1.

---

## Section B — build gates (all exit 0)

| # | Gate | Result | Exit |
|---|---|---|---|
| B1 | `npx tsc --noEmit` (root) | clean | 0 |
| B2 | `npx tsc --noEmit` (mcp/hub) | clean | 0 |
| B3 | `npm run lint` | pass — **warnings only** (React-hooks deps + `<img>`; none in intake/source files) | 0 |
| B4 | targeted vitest (5 source-validation files) | **5 files / 168 tests passed** | 0 |
| B5 | full vitest (`npx vitest run`) | **114 files / 1829 tests passed** | 0 |

```
B4 targeted files:
  src/lib/workflow/intake.test.ts               (110 tests)
  src/lib/workflow/source-shape.test.ts          (33 tests)
  lambda/orchestrator/source-context.test.mjs    (14 tests)
  src/app/api/workflow/start/route.sources-shape.test.ts (7 tests)
  src/lib/workflow/intake.hub-bucket.test.ts      (4 tests)
 Test Files  5 passed (5) | Tests  168 passed (168)             # exit 0

B5:  Test Files  114 passed (114) | Tests  1829 passed (1829)   # exit 0
```

---

## Section C — LIVE validator harness (real AWS SDK + real network)

`qa-probe-4103.mts` imports the **real** `validateIntakeSources` / `shouldRejectSubmission` and
wraps `fetch` (counting proxy: url / method / header-keys / redirect) and `dns.lookup` (real
`node:dns/promises`, counted). Run: `npx tsx qa-probe-4103.mts` → **exit 0**. Canaries redacted.

| Case | Scenario | Observed | fetch | lookup | Verdict |
|---|---|---|---|---|---|
| C1 | cross-account S3 (**TEAM-4105 fix**) | raw SDK `err.name="Unknown"`/`msg="UnknownError"`/403; detail `HeadObject -> AccessDenied (403)` + bucket-policy hint, **`grep -ci unknown = 0`** | 0 | 0 | **PASS** |
| C2 | hub-bucket S3 (honest report) | transient 403, `grep -ci unknown = 0` | 0 | 0 | **PASS** |
| C3 | malformed `s3://bucket-only-no-key` | definitive/parse; **S3 `send`=0** | 0 | 0 | **PASS** |
| C4 | public https (Range GET) | 206 verified; header `Range`, `redirect:"manual"` | 1 | 1 | **PASS** |
| C5 | presigned-style URL | transient GET 403; **every method GET (no HEAD)**; URL byte-identical; canary count = 0 in detail / persisted / strict-422 errors; `value` preserved | 2 | 1 | **PASS** |
| C6 | redirect not followed | 301/302 → transient "URL redirected"; destination **never fetched** (see note) | 1 | 1 | **PASS** |
| C7 | blocked-host literal matrix (32 rows) | **all** definitive/parse/blocked/**fetch0/lookup0**/lenientReject | 0 | 0 | **PASS** |
| C7-neg | non-private literals (172.32 / 100.128 / 11 / 8.8.8.8) | verified, **lookup0** (literal ⇒ no DNS) | 1 | 0 | **PASS** |
| C8 | real-DNS private-resolving names + injected variants | all `Blocked … resolves to a private/link-local address` (no IP disclosed); ENOTFOUND/empty → transient DNS | 0 | 1 | **PASS** |
| C9 | gate ordering vs `GITHUB_OWNER` | (a) loopback blocked **before** owner shortcut; (b) github-name→private blocked; (c) real-DNS github → `trusted-github` skipped | 0 | ≤1 | **PASS** |
| C10 | DNS timeout bound | transient/DNS, `detailHasTimeout=true`, elapsed **2003 ms** (≤ ~2500) | 0 | — | **PASS** |

### C1 — TEAM-4105 "Unknown" leak is fixed (the TEAM-4092 F1 finding)
```
RAW err.name="Unknown" err.message="UnknownError" httpStatusCode=403
### C1 validate  outcome=transient method=HeadObject status=unverified
detail: S3 object unreadable — HeadObject -> AccessDenied (403): s3://…-023392223961-… —
        validator role has no read access to this bucket; runtime agents in the hub account
        will need a bucket policy grant, or upload the object to the hub artifacts bucket instead
grep -ci unknown => 0   (must be 0)     ✅   fetch=0 lookup=0
```
The raw SDK error is the bodiless-403 `name:"Unknown" / message:"UnknownError"` shape, yet the
user-facing detail carries **zero** "unknown" — both slots pass through `isUninformativeMessage`.

### C5 — presigned URL, no secret leak
Input URL (canaries redacted as required):
`https://…-023392223961-….s3.amazonaws.com/prd/spec.md?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=<CANARY>%2F…&…&X-Amz-Signature=<CANARY>`
```
detail: URL unreachable — GET -> 403: https://…/prd/spec.md?X-Amz-Algorithm=REDACTED&
        X-Amz-Credential=REDACTED&…&X-Amz-Signature=REDACTED
every method GET (no HEAD)=true   fetched URL byte-identical to input on every call=true
header keys per call=[["Range"],[]]   redirects=["manual","manual"]
canary <sig> in result JSON => 0   canary <akia> in result JSON => 0   canary in strict 422 => sig:0 akia:0
r.sources[0].value === original full URL => true
```

### C6 — redirect note (harness-check artifact, not a failure)
For the real-302 sub-case the harness line prints `destination(example.com) requested? => true`.
This is a **substring false-positive**: the *only* fetched URL is the httpbingo redirector
`https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302`, whose
`url=` query param literally contains the text "example.com". **`fetchCalls=1`** (the redirector
only, `redirect:"manual"`, 302 → transient "URL redirected"); the destination was **never**
requested. The `http://github.com/` sub-case confirms the intended assertion cleanly:
`destination (https) requested? => false`.

### C7 — blocked-host literal matrix (32/32)
All rows `definitive / parse / blocked / fetch0 / lookup0 / lenientReject=true`, including
`localhost`/trailing-dot/`foo.localhost.`, obfuscated IPv4 (`127.1`, `0x7f000001`, `2130706433`,
`0177.0.0.1`), IMDS `169.254.169.254` + `169.254.170.2` (and their `/latest/meta-data/` URLs),
all private ranges, `0.0.0.0`, `100.64.0.1`, IPv6 `[::1]`/`[::]`/`[fd00::1]`/`[fc00::1]`/`[fe80::1]`,
IPv4-mapped `[::ffff:127.0.0.1]`/`[::ffff:7f00:1]`/`[::ffff:169.254.169.254]`, and userinfo/port
`https://user:pw@127.0.0.1:8080/x` + `https://localhost.:3000/x`.
`C7 ALL PASS => true`.

### C8 — resolved-address blocking (no IP disclosure)
Real DNS resolved `127.0.0.1.nip.io`, `10.0.0.1.nip.io`, `169.254.169.254.nip.io`,
`127-0-0-1.sslip.io`, `a.169.254.170.2.nip.io` → each **definitive/parse, fetch0, exactDetail=true**:
`Blocked URL host — resolves to a private/link-local address: <url>` (the private IP is **not**
disclosed). Injected variants (single/mixed/`fd00::1`/`fe80::1%eth0`/`::ffff:169.254.169.254`/
non-IP) all block; `ENOTFOUND` → `transient/DNS`, empty `[]` → `transient/DNS "no addresses"`.

---

## Section D — count cap (MAX_INTAKE_SOURCES=32) + MCP schema

| # | Check | Result | Exit |
|---|---|---|---|
| D1 | route cap tests (`>MAX`→400 before fan-out; `==MAX`→200) | 2 passed (5 unrelated skipped by `-t`) | 0 |
| D2 | constant in both TS layers | `source-shape.ts:43 =32`, `mcp/hub schemas.ts:28 =32` (zod `.max(32)` on both submit + routine) | 0 |
| D3 | MCP JSON schema probe (`qa-schema-4103.mts`) | zod rejects 33 / accepts 32 on both schemas; **`submit_workflow` sources `maxItems=32`** + desc "At most 32 sources per submission"; **`create_routine` input.sources `maxItems=32`** + same desc | 0 |

```
WorkflowInputSchema 33 -> success:false | issue: sources must have at most 32 items
WorkflowInputSchema 32 -> success:true
RoutineInputTemplateSchema 33 -> false ; 32 -> true
submit_workflow .inputSchema.properties.sources.maxItems = 32   desc includes 'At most 32 sources' => true
create_routine  input.properties.sources.maxItems = 32          desc includes 'At most 32 sources' => true
```

---

## Section E — orchestrator agent-context (TEAM-4093)

| # | Check | Result | Exit |
|---|---|---|---|
| E1 | `lambda/orchestrator/source-context.test.mjs` | **14 tests passed** | 0 |
| E2 | `formatSourceLine` wiring | def @3321; called @3542 inside `## Input Sources` (gated on intake agent) | 0 |

`formatSourceLine` renders `- [type] label|value`; for `unverified` appends
`— UNVERIFIED at intake: <detail>` (detail is **already** redacted upstream by
`intake.ts→redactUrl`; not re-shaped here), for `skipped` appends `— not network-validated`,
and renders verified / legacy (no-`verification`) rows exactly as before. The intake agent's
context gains a `## Input Sources` list only when `ticket.assignee === wfDef.intakeAgentId`.

---

## Section G — Playwright board re-verification (WorkflowBoard changed in the merge)

`qa-ui-4103.mjs` renders the real `WorkflowBoard` against fixture state (every `/api/workflow/*`
intercepted by `page.route`; no live AWS). Ran against a real `next dev` on
`http://localhost:3000` → **all cases 0 real console errors** (the EventSource-MIME notice from
the stubbed `text/event-stream` is filtered as harness noise).

| Case | Fixture | Observed | console errors |
|---|---|---|---|
| G1 | 3 sources: s3 verified / presigned URL unverified / upload skipped — **plus** `delivery:{mode:"handoff",…}` | **exactly 1 amber "unverified" badge**; badge `title` and page text end in `…=REDACTED`; canaries **absent from visible text AND full DOM** (`document.documentElement.outerHTML`); **delivery badge = 1** (coexists, no collision) | 0 |
| G2 | `[{ value:null, type:{} }]` | board renders (pipeline canvas); row shows type `[OBJECT OBJECT]` + **`(invalid)`** placeholder | 0 |
| G3a | `sources = "s3://…/key"` (bare string) | board renders; **0 source blocks**; no `.map is not a function` | 0 |
| G3b | `sources = {length:2, 0:{…}, 1:{…}}` (array-like) | board renders; **0 source blocks**; no `.map is not a function` | 0 |

```
G1: unverifiedBadgeCount=1  deliveryBadgeCount=1
    badgeTitle = "URL unreachable — GET (Range 0-0) -> 403: https://qa-bucket.s3.amazonaws.com/
                  specs/prd.pdf?X-Amz-Algorithm=REDACTED&X-Amz-Signature=REDACTED&tail=REDACTED"
    visibleText_contains_SIG=false  TAIL=false   DOM_contains_SIG=false  TAIL=false
    realConsoleErrors: []
G2: boardRendered=1  rowText_shows_invalid_placeholder=true  realConsoleErrors: []
G3a/G3b: boardRendered=1  sourcesBlockCount=0  mapCrash=false  realConsoleErrors: []
```

**Delivery-badge / sources-block coexistence:** in `TEAM-4103-board-sources.png` the sources
block (S3 / URL+amber-"unverified" / UPLOAD rows) sits at the **top** of the board directly under
the header; the new delivery badge renders in the terminal-phase footer region far below (the
G1 fixture's `delivery.mode:"handoff"` yields `deliveryBadgeCount=1`). The two never overlap —
they are independent JSX blocks (sources @~1481, delivery @1818).

**Screenshots (in `docs/qa/`):**
- `TEAM-4103-board-sources.png` — full board; header "Workflow: TEAM-4103 QA fixture — intake source verification badges", `PLAYBOOK`/`Complete`, three source rows at top with one amber `unverified` badge on the redacted URL row, phases 1–3 canvas below.
- `TEAM-4103-board-sources-crop.png` — tight crop of the three source rows: `S3` (no badge), `URL …=REDACTED&tail=REDACTED` + amber `unverified`, `UPLOAD design-mockups.zip` (no badge).
- `TEAM-4103-board-invalid-source.png` — the crash row rendered as `[OBJECT OBJECT] (invalid) unverified`; full board intact.
- `TEAM-4103-board-nonarray-string.png` / `-arraylike.png` — no sources block at all; full pipeline canvas renders; no crash.

---

## Summary

| Section | Scope | Result |
|---|---|---|
| A | checkout + git facts + merge integrity | **PASS** — HEAD `45694dd`; validator logic byte-identical to `6c9d2cd`; 24 files +3415/−74 |
| B | build gates (tsc×2, lint, targeted+full vitest) | **PASS** — all exit 0; 168 targeted, 1829 full tests |
| C | live validator (real AWS SDK + real network) | **PASS** — TEAM-4105 "Unknown" leak fixed; SSRF blocks fetch0/lookup-controlled; no secret leak |
| D | count cap + MCP schema | **PASS** — 32 enforced in REST/zod/JSON schema (submit + routine), maxItems + description |
| E | orchestrator agent-context | **PASS** — 14 tests; `formatSourceLine` wired, uses upstream-redacted detail |
| G | Playwright board (post-merge WorkflowBoard) | **PASS** — 1 amber badge, canaries absent from text+DOM, delivery badge coexists, no `.map` crash, 0 console errors |

**Overall: PASS.** The final head `45694dd` of PR #371 carries the complete, unmodified
TEAM-4054/4078/4089/4091/4093/4101/4102/4105 source-validation surface; the TEAM-4102 main-merge
added only orthogonal CD-registry work plus a separate delivery badge that does not regress the
sources UI. No source files were modified during this verification.
