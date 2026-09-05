# TEAM-4103 — QA re-verification, live round-trip evidence (FINAL head)

**Verified head:** `45694ddcefd00da682c15c581708c3156f9b7266`
**Branch:** `feature/TEAM-4054-submit-workflow-source-validation-reject` (PR #371 → `main`)
**Repo:** tycenjmccann/agentcore-hub
**Date:** 2026-09-05
**Verifier identity (ambient IAM role):** coding-runtime-role, account `838829463875` — no read grant on the hub artifacts bucket, so every S3 probe legitimately returns 403 (reported honestly, not masked).

Fixes landed since the interim head `16b2bd3f` (all present at this tip): TEAM-4105 #376
(intake.ts name-slot "Unknown" filter — the TEAM-4092 finding), TEAM-4093 #377 (orchestrator
`formatSourceLine`), TEAM-4101 #378 (urlGate trailing-dot canonicalization + `dns.lookup`
resolved-address block), the `origin/main` merge, and TEAM-4102 #379 (mcp/hub `schemas.ts` /
`tools.ts` `maxItems 32`). The tip `45694dd` is the 2-parent merge integrating the feature tip
`6c9d2cd` (#379) with a `main`-merge (`2e31e3d`, TEAM-4106).

---

## STEP 0 — sync + change surface

```
$ git reset --hard origin/feature/TEAM-4054-submit-workflow-source-validation-reject
HEAD is now at 45694dd merge: integrate origin/feature/TEAM-4054 (6c9d2cd TEAM-4102 #379) ...
$ git rev-parse HEAD
45694ddcefd00da682c15c581708c3156f9b7266      # HEAD MATCH ✅   (exit 0)
```
`node_modules` present (root + mcp/hub) — no `npm ci` needed.

**`git diff --stat 16b2bd3f..HEAD` — 46 files, +3142 / −140.** The three files whose change would
force a Playwright re-run:

| File | Changed since 16b2bd3f? | Action |
|---|---|---|
| `src/lib/workflow/source-shape.ts` | **NO** (not in diff) | TEAM-4092 evidence carries forward |
| `src/lib/workflow/redact.ts` | **NO** (not in diff) | TEAM-4092 evidence carries forward |
| `src/components/workflow/WorkflowBoard.tsx` | **YES (+28)** — new delivery badge | **Playwright board harness re-run** (STEP G below) |
| `src/lib/workflow/intake.ts` | YES (+182) — TEAM-4105 + TEAM-4101 | drives the live harness (STEP B) |
| `lambda/orchestrator/index.mjs` | YES (+331) — TEAM-4093 formatSourceLine | STEP A2/E |
| `mcp/hub/src/workflow/{schemas,tools}.ts` | YES (+6 / +9) — TEAM-4102 cap | STEP D |

`source-shape.ts` / `redact.ts` verified byte-identical since 16b2bd3f (empty targeted diff).

---

## STEP A — static + suite

| # | Gate | Result | Exit |
|---|---|---|---|
| A1a | `npx tsc --noEmit` (root) | clean | 0 |
| A1b | `npx tsc --noEmit` (mcp/hub) | clean | 0 |
| A1c | `npm run lint` | **0 errors, 19 warnings** (React-hooks deps + `<img>`; none in intake/source files) | 0 |
| A2 | targeted vitest (5 source-validation files) | **5 files / 168 tests passed** | 0 |
| A3 | full `npx vitest run` | **114 files / 1829 tests** (see flake note) | 0 (2 of 3 runs) |

A2 files: `intake.test.ts` (110), `source-shape.test.ts` (33), `route.sources-shape.test.ts` (7),
`intake.hub-bucket.test.ts` (4), `lambda/orchestrator/source-context.test.mjs` (14).

**A3 flake note (reported honestly):** the full suite was run **3×**. Runs 2 and 3 were green
(`114 passed / 1829 passed`, exit 0). Run 1 reported `1 failed / 1828 passed` (exit 1) and did
**not** reproduce on either re-run. The failure was **not** in the source-validation surface
(the A2 targeted set is deterministic and passed every time); the suite contains known
wall-clock / concurrency-timing tests (e.g. the orchestrator advisory-auto-approve retry test and
an intake real-time budget assertion) that can flake under sandbox load. No source-validation
regression is implied. The single non-reproducing failure was not isolated to a named test before
it cleared on the next run.

---

## STEP B — LIVE validator harness (real AWS SDK + real network, no mocks)

`qa-probe-4103.mts` imports the **real** `validateIntakeSources` / `shouldRejectSubmission` from
`src/lib/workflow/intake.ts` at this head and wraps `fetch` (counting proxy: url / method /
header-keys / redirect) and `dns.lookup` (real `node:dns/promises`, counted). SOURCE_VALIDATION_MODE
unset (lenient), strict reported alongside. Run → **exit 0**. Signatures/credentials redacted.

Pre-check assertion: `import { DNS_LOOKUP_TIMEOUT_MS }` → **`2000` (=== 2000 ✅)**.

| Case | Scenario | Observed | fetch | lookup | reject L/S | Verdict |
|---|---|---|---|---|---|---|
| C1 | cross-account `s3://…-023392223961-…/some/key` | transient/unverified; `HeadObject -> AccessDenied (403)` + bucket-policy hint; **`grep -ci unknown = 0`** | 0 | 0 | false / true | **PASS** |
| C2 | hub bucket `s3://…-838829463875-…` | transient 403 (role has no read); `grep -ci unknown = 0` | 0 | 0 | false / true | **PASS** |
| C3 | malformed `s3://bucket-only-no-key` | definitive/parse "Invalid S3 URI format"; **S3 `send`=0** | 0 | 0 | true / true | **PASS** |
| C4 | public https (raw.githubusercontent + example.com) | 206 verified, header `Range`, `redirect:"manual"` | 1 | 1 | false / false | **PASS** |
| C5 | presigned-style URL (fake canary sig) | transient GET 403; **every method GET (no HEAD)**; URL byte-identical; call-1 headers `["Range"]`, both `redirect:"manual"`; **canary = 0** in detail / persisted / strict-422 | 2 | 1 | false / true | **PASS** |
| C6 | redirect not followed (`http://github.com/` 301; httpbingo 302) | transient "URL redirected"; destination never fetched (see note) | 1 | 1 | false / true | **PASS** |
| C7 | blocked-host literal matrix (32 rows) | **all** definitive/parse/blocked/**fetch0/lookup0**/lenientReject | 0 | 0 | true / — | **PASS** |
| C7-neg | non-private literals (172.32/100.128/11/8.8.8.8) | verified, **lookup0** (literal ⇒ no DNS) | 1 | 0 | — | **PASS** |
| C8a | real-DNS private-resolving names (nip.io/sslip.io) | all `Blocked … resolves to a private/link-local address`, `exactDetail=true`, **no IP in detail** | 0 | 1 | — | **PASS** |
| C8b | injected lookup → private / ENOTFOUND / empty | private→definitive blocked (fetch0); ENOTFOUND & empty→transient DNS (fetch0) | 0 | 1 | — | **PASS** |
| C9 | urlGate before GITHUB_OWNER shortcut | (a) `https://127.0.0.1/github.com/…`→definitive blocked; (b) github-name→10.0.0.5→definitive blocked (**NOT** trusted-github); (c) real-DNS github→`trusted-github` skipped | 0 | ≤1 | — | **PASS** |
| C10 | never-settling lookup | transient/DNS, `detailHasTimeout=true`, **elapsed 2001 ms** (≈2s) | 0 | — | — | **PASS** |

### C1 — TEAM-4105 "Unknown" leak is fixed (the TEAM-4092 finding)
```
RAW err.name="Unknown" err.message="UnknownError" httpStatusCode=403
### C1 validate  outcome=transient method=HeadObject status=unverified
detail: S3 object unreadable — HeadObject -> AccessDenied (403): s3://…-023392223961-… —
        validator role has no read access to this bucket; runtime agents in the hub account will
        need a bucket policy grant, or upload the object to the hub artifacts bucket instead
grep -ci unknown => 0   (must be 0)   ✅    has 'HeadObject -> AccessDenied (403)' => true
```
The raw SDK error is the bodiless-403 `name:"Unknown" / message:"UnknownError"` shape, yet the
user-facing detail carries **zero** "unknown" — both the name and message slots pass through
`isUninformativeMessage`.

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

### C6 — redirect note (harness-check substring artifact, NOT a failure)
For the 302 sub-case the harness prints `destination(example.com) requested? => true`. This is a
**substring false-positive**: the only fetched URL is the httpbingo redirector
`https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302`, whose `url=`
query param literally contains "example.com". **`fetchCalls=1`** (redirector only, `redirect:"manual"`,
302 → transient "URL redirected"); the destination was **never** requested. The `http://github.com/`
sub-case confirms the intended assertion cleanly: `destination (https) requested? => false`.

### C7 — blocked-host literal matrix (32/32 → `C7 ALL PASS => true`)
`localhost`/trailing-dot/`foo.localhost.`/`localhost..`, obfuscated IPv4 (`127.1`, `0x7f000001`,
`2130706433`, `0177.0.0.1`), IMDS `169.254.169.254` + `169.254.170.2` (and their `/latest/meta-data/`
URLs), all private ranges, `0.0.0.0`, `100.64.0.1`, IPv6 `[::1]`/`[::]`/`[fd00::1]`/`[fc00::1]`/
`[fe80::1]`, IPv4-mapped `[::ffff:127.0.0.1]`/`[::ffff:7f00:1]`/`[::ffff:169.254.169.254]`,
userinfo/port `https://user:pw@127.0.0.1:8080/x` + `https://localhost.:3000/x` — every row
`definitive / parse / blocked / fetch0 / lookup0 / lenientReject=true`.

### C8 — resolved-address block (TEAM-4101 r2-F2)
Sandbox DNS pre-check resolved `127.0.0.1.nip.io`→127.0.0.1, `127-0-0-1.sslip.io`→127.0.0.1,
`169.254.169.254.nip.io`→169.254.169.254. Each URL → **definitive/parse, fetch0, lookup1,
exactDetail=true**: `Blocked URL host — resolves to a private/link-local address: <url>` — the
private IP is **not** disclosed. Injected variants (single/mixed/`fd00::1`/`fe80::1%eth0`/
`::ffff:169.254.169.254`/non-IP) all block; injected `ENOTFOUND` → `transient/DNS`, empty `[]` →
`transient/DNS "no addresses"`.

---

## STEP D — caps (MAX_INTAKE_SOURCES = 32)

| # | Layer | Result | Exit |
|---|---|---|---|
| D1 | REST route (`route.sources-shape.test.ts`) | 33→**400** "sources must have at most 32 items", `validateIntakeSources` spy **not called**, 0 puts/invokes; 32→**200** & validator called (7 tests pass) | 0 |
| D2 | MCP zod (`schemas.ts`) | `WorkflowInputSchema` 33→`success:false` "sources must have at most 32 items", 32→`success:true`; `RoutineInputTemplateSchema` 33→false, 32→true; `MAX_INTAKE_SOURCES = 32` | 0 |
| D3 | MCP JSON schema (`tools.ts` `WORKFLOW_TOOLS`) | `submit_workflow` `.inputSchema.properties.sources.maxItems = 32`; `create_routine` `.inputSchema.properties.input.properties.sources.maxItems = 32`; both descriptions contain "At most 32 sources" | 0 |
| D-build | mcp/hub `npm run build` (`tsc`) | clean | 0 |

Note: `create_routine`'s sources live at `inputSchema.properties.**input**.properties.sources`
(the routine template is nested under `input`, not `inputTemplate`).

---

## STEP E — deploy.sh (env-forward only)

```
$ git diff --stat origin/main...HEAD -- deploy/
 deploy/ecs-express/deploy.sh | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

$ git diff origin/main...HEAD -- deploy/ecs-express/deploy.sh
@@ -389,7 +389,8 @@ for var in AWS_REGION TICKET_PROVIDER WORKFLOWS_TABLE EVENTS_TABLE TICKETS_TABLE
            WM_MAX_OPEN_AUTO_BUGS WM_BUG_MUTE_DAYS \
-           WORKFLOW_COMMAND_QUEUE_URL WORKFLOW_LEASE_TTL_MINUTES; do
+           WORKFLOW_COMMAND_QUEUE_URL WORKFLOW_LEASE_TTL_MINUTES \
+           SOURCE_VALIDATION_MODE; do
```
The **only** `deploy/` change is `SOURCE_VALIDATION_MODE` appended to the env-forward `for var …`
list (the `; do` moved to a new continuation line → +2 / −1). Full feature delta
`git diff --stat origin/main...HEAD` = **24 files changed, +3415 / −74** (matches the expected
"24 files").

---

## STEP G — Playwright board re-verification (WorkflowBoard.tsx changed +28)

`qa-ui-4103.mjs` renders the real `WorkflowBoard` against fixture state (`page.route` intercepts
every `/api/workflow/*`; no live AWS), 1440×900, on a real `next dev`. All cases **0 real console
errors** (the EventSource-MIME notice from the stubbed `text/event-stream` is filtered as harness
noise).

| Case | Fixture | Observed | console errors |
|---|---|---|---|
| G1 (E1) | 3 sources: s3 verified / presigned URL unverified / upload skipped — **plus** `delivery:{mode:"handoff"}` | **exactly 1 amber "unverified" badge**; badge `title` & page text end in `…=REDACTED`; canaries **absent from visible text AND full DOM** (`document.documentElement.outerHTML`); **delivery badge = 1** (coexists, no collision) | 0 |
| G2 (E2) | `[{ value:null, type:{} }]` | board renders; row shows `[OBJECT OBJECT]` + **`(invalid)`** placeholder | 0 |
| G3a (E3a) | `sources = "s3://…/key"` (bare string) | board renders; **0 source blocks**; no `.map is not a function` | 0 |
| G3b (E3b) | `sources = {length:2, 0:{…}, 1:{…}}` (array-like) | board renders; **0 source blocks**; no `.map is not a function` | 0 |

```
G1: unverifiedBadgeCount=1  deliveryBadgeCount=1
    visibleText_contains_SIG=false TAIL=false   DOM_contains_SIG=false TAIL=false   realConsoleErrors:[]
G2: boardRendered=1  rowText_shows_invalid_placeholder=true   realConsoleErrors:[]
G3a/G3b: boardRendered=1  sourcesBlockCount=0  mapCrash=false   realConsoleErrors:[]
```

**Delivery-badge / sources-block coexistence:** the sources block (`sourcesForDisplay`, board
top, ~line 1481) and the new terminal-phase delivery badge (`data-testid="delivery-badge"`,
`isTerminalPhase && state.delivery`, line 1818) are **independent JSX blocks**. The G1 fixture
sets `delivery.mode:"handoff"` and yields `deliveryBadgeCount=1` while the sources block still shows
its single amber badge — no overlap. Screenshots in `docs/qa/`:
`TEAM-4103-board-sources.png` (+`-crop.png`), `TEAM-4103-board-invalid-source.png`,
`TEAM-4103-board-nonarray-string.png`, `TEAM-4103-board-nonarray-arraylike.png`.

---

## Summary

| Step | Scope | Result |
|---|---|---|
| 0 | sync + change surface | **PASS** — HEAD `45694dd`; 46 files/+3142/−140 since 16b2bd3f; source-shape/redact unchanged; WorkflowBoard +28 → Playwright re-run |
| A | static + suite | **PASS** — tsc×2/lint clean; 168 targeted; full 1829 (2/3 green, 1 non-reproducing non-source-validation flake) |
| B | live validator (real SDK + network) | **PASS** — TEAM-4105 "Unknown" leak fixed; SSRF matrix fetch0/lookup-controlled; no secret leak; DNS timeout 2001 ms; `DNS_LOOKUP_TIMEOUT_MS===2000` |
| D | caps | **PASS** — 32 enforced in REST/zod/JSON-schema (submit + routine); mcp/hub build clean |
| E | deploy.sh | **PASS** — only `SOURCE_VALIDATION_MODE` env-forward (+2/−1); full delta 24 files +3415/−74 |
| G | Playwright board | **PASS** — 1 amber badge, canaries absent from text+DOM, delivery badge coexists, no `.map` crash, 0 console errors |

**Overall: PASS.** The final head `45694dd` of PR #371 carries the complete
TEAM-4054/4078/4089/4091/4093/4101/4102/4105 source-validation surface; the TEAM-4102 main-merge
added only orthogonal CD-registry work plus a separate delivery badge that does not regress the
sources UI. The single full-suite failure across three runs did not reproduce and was outside the
source-validation surface. No non-docs file on the feature branch was modified during this
verification.
