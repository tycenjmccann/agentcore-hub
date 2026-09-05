# TEAM-4064 — Live round-trip evidence (Part C)

Branch: feature/TEAM-4054-submit-workflow-source-validation-reject @ 04cc457c6d48ea228cdfc291ea8e2358d03d6cf8
Date: 2026-09-05. All presigned signature/credential/token values REDACTED.

## Caller identity (aws CLI absent; boto3 used)
```
Account: 838829463875
Arn: arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/BedrockAgentCore-...
```
IMPORTANT: this is the **coding-runtime role**, NOT the hub ECS task role. It has
**no s3:GetObject / HeadObject / ListBucket / PutObject / CreateBucket** on the hub
artifacts bucket. So a genuine "verified" S3 round-trip cannot be produced from this
environment — every hub-bucket HeadObject returns 403 AccessDenied. This does not
break the test; it exercises the exact transient/unverified path the fix is about,
and it corroborates intake.ts's rationale (the validator's IAM identity != the
identity the pipeline agents read under). Reported honestly, not faked.

## (a) Upload probe object — FAILED (AccessDenied)
```
s3:PutObject on agentcore-hub-artifacts-838829463875-us-east-1/workflows/wf_1788582225496_yteqfl/shared/qa-evidence/probe.txt
-> AccessDenied (no identity-based policy allows s3:PutObject)
```
HeadObject on the hub bucket also -> 403 AccessDenied; ListBucket -> AccessDenied; CreateBucket -> AccessDenied.

## (b) Presigned GET URL (600s) — generated for the hub probe path
Note: boto3 with a session token emits a **SigV2** presign (AWSAccessKeyId/Signature/
x-amz-security-token), not X-Amz-Signature. redactUrl drops ALL query values, so it is
covered either way.
```
https://agentcore-hub-artifacts-838829463875-us-east-1.s3.amazonaws.com/workflows/wf_1788582225496_yteqfl/shared/qa-evidence/probe.txt?AWSAccessKeyId=REDACTED&Signature=REDACTED&x-amz-security-token=REDACTED&Expires=REDACTED
```
(NOTE: an earlier draft of this file accidentally pasted the RAW SigV2 presigned URL here —
real AWSAccessKeyId/Signature/security-token. It has been redacted in place before this file
was ever committed/pushed; the leaked STS values were time-limited (Expires 600s) and are
expired. This is a QA-artifact hygiene note, not a finding against the branch under test.)

## (c) Bug premise via curl (HEAD vs GET Range 0-0)
```
HEAD          -> 403
GET Range 0-0 -> 403
```
Both 403: HEAD because the URL is GET-signed (method mismatch — the original bug's
premise), AND GET because the signer (coding-runtime role) lacks s3:GetObject. The
GET->200/206 success half cannot be shown here (no readable S3 object for this role).
The success half IS demonstrated live in (d) using a public https URL (206).

## (d) REAL validateIntakeSources (no mocks, real network + AWS SDK)
Actual outcomes (redacted). Full JSON in the QA transcript.

| # | source | outcome | method | verification.status |
|---|--------|---------|--------|---------------------|
| 1 | s3 hub bucket probe.txt | transient | HeadObject | unverified (403 AccessDenied — role can't read hub bucket; ticket expected "verified") |
| 2 | presigned GET URL | transient | GET (Range->plain-GET fallback, both 403) | unverified |
| 3 | s3 cross-account 023392223961 | transient | HeadObject | unverified — detail names HeadObject + AccessDenied + 403 + bucket-policy hint ✅ |
| 4 | s3 hub does-not-exist.txt | transient | HeadObject | unverified (403, NOT 404 — role lacks s3:ListBucket so S3 masks NoSuchKey as AccessDenied; ticket expected definitive 404) |
| 5 | s3://no-slash-key | **definitive** | parse | unverified — "Invalid S3 URI format" ✅ (no network call) |
| 6 (extra) | https://raw.githubusercontent.com/.../README.md | **verified** | GET (Range 0-0) -> 206 | verified ✅ (genuine verified-via-GET-Range over real network) |

shouldRejectSubmission:
- LENIENT: reject=true, errors=["Invalid S3 URI format: s3://no-slash-key"]  (only the definitive one)
- STRICT:  reject=true, errors=[the malformed one + all 4 transient 403s]

Signature leak check (grep raw un-redacted validator surface for the literal signature/token):
```
presigned signature value present in validator output?  false  (0 matches)
presigned security-token value present in validator output?  false
```
(Both encoded and decoded forms absent — redactUrl replaced every query value with REDACTED.)

### Observation (candidate for TEAM-4078 / minor)
The live 403 detail carries a stray "— Unknown —" token:
`S3 object unreadable — HeadObject -> AccessDenied (403): <uri> — Unknown — validator role has no read access...`
The AWS SDK v3 bodiless-403 error message is literally `"Unknown"`, but intake.ts only
filters the exact string `"UnknownError"` (line 265) from extras, so `"Unknown"` slips
through. Benign (the detail still names AccessDenied/403/HeadObject + the hint; no leak),
but the tests use message="UnknownError" so they don't catch the real "Unknown" message.

## (e) BASE-BRANCH (origin/main) validator — before-state, ARTIFACT_BUCKET unset
Returns `string[]` (any error => the old route 422'd the whole submission):
```
- Source unreachable: s3://agentcore-hub-artifacts-838829463875-us-east-1/.../probe.txt — UnknownError
- URL unreachable (403): https://agentcore-hub-artifacts-...s3.amazonaws.com/...?AWSAccessKeyId=REDACTED&Signature=REDACTED&x-amz-security-token=REDACTED&Expires=...
```
Demonstrates BOTH original defects:
1. The S3 HEAD 403 is laundered into the useless bare "UnknownError".
2. URLs are probed with **HEAD** -> guaranteed 403 on a GET-signed presigned URL.
3. **Credential leak**: the raw (un-redacted) old error string embeds the full presigned
   URL — grep of the raw string for the URL-**encoded** signature fragment => **True**
   (present). The new validator's output => 0 matches. (With ARTIFACT_BUCKET *set* to the
   hub bucket, the old code's own-bucket shortcut would instead have returned null/pass
   for source #1 without any check.)

## Part D — WorkflowBoard UI (Playwright, real Next dev server, fixture state)
Harness: qa-ui-sources.mjs (page.route intercepts every /api/workflow/* — no live AWS).
Fixture = 3 sources: s3 verified (HeadObject 200), url unverified (GET Range 0-0 -> 403)
carrying a presigned URL whose X-Amz-Signature="deadbeefcafe…", upload skipped.
Viewport 1440x900. Screenshots: TEAM-4064-workflowboard-sources.png (full) + -crop.png.

Extracted:
- unverified badge count: **1** (only the url row; verified & skipped rows show NO badge) ✅
- badge title attr = "URL not verified — GET (Range 0-0) -> 403 (Forbidden):
  https://qa-bucket.s3.amazonaws.com/specs/product-requirements-v3.pdf?X-Amz-Algorithm=REDACTED&X-Amz-Credential=REDACTED&X-Amz-Date=REDACTED&X-Amz-Expires=REDACTED&X-Amz-SignedHeaders=REDACTED&X-Amz-Signature=REDACTED"
  → contains "deadbeefcafe"? **false** ✅  contains "REDACTED"? **true** ✅ (redactUrl applied to the title)
- full page visible text contains "deadbeefcafe"? **false** — BUT only because the value
  truncation (slice(0,40)+…+slice(-23)) happened to drop that exact substring. The visible
  URL row still shows RAW signature tail material: "…specs…0abcdef1234567890abcdef".
  The value span (WorkflowBoard.tsx:1483-1485) is NOT run through redactUrl, so raw
  query-string bytes are shown verbatim — this is the standing TEAM-4078 concern; the badge
  TITLE is redacted, the inline VALUE is not.
- console errors: only "EventSource MIME type application/json not text/event-stream" — an
  artifact of the harness stubbing /watch with JSON, not an app error.

Crop screenshot shows three rows under the board header: [S3] <uri> (no badge),
[URL] <presigned, truncated> [unverified] (amber pill: amber-500/40 border, amber-400
text, amber-500/10 fill), [UPLOAD] design-mockups.zip (no badge). The amber "unverified"
badge sits at the right end of the URL row only.

---

# Re-verification on a5b4ac42 (TEAM-4078 / PR #367 merged into the branch)

New HEAD: a5b4ac42534806f2bed399f142fa1fa024d273ff
`TEAM-4078: validate start-route sources shape + harden/redact WorkflowBoard sources list (#367)`

## Diff since 04cc457c (`git diff --stat 04cc457c..HEAD`)
```
 .../api/workflow/start/route.sources-shape.test.ts | 156 +++++++++++++++
 src/app/api/workflow/start/route.ts                |  12 ++
 src/components/workflow/WorkflowBoard.tsx          |  48 +++--
 src/lib/workflow/source-shape.test.ts              | 213 +++++++++++++++++++++
 src/lib/workflow/source-shape.ts                   | 142 ++++++++++++++
 5 files changed, 551 insertions(+), 20 deletions(-)
```

## Tests / gates (all EXIT 0)
- `redact.test.ts` does NOT exist — redaction is covered inside `intake.test.ts`. Existing
  workflow test files listed under `src/lib/workflow/*.test.ts` (19 files incl. the new
  `source-shape.test.ts`).
- Targeted: `npx vitest run intake.test.ts source-shape.test.ts src/app/api/workflow/start`
  -> **Test Files 9 passed (9), Tests 122 passed (122)**, EXIT 0.
- Whole suite: `npx vitest run` -> **Test Files 108 passed (108), Tests 1682 passed (1682)**,
  EXIT 0. No failures -> no origin/main comparison needed.
- `npx tsc --noEmit` (root) -> EXIT 0.

## New shape gate (route.ts) — runs BEFORE reachability, no-sources still accepted
`src/app/api/workflow/start/route.ts:336-339` calls `validateSourcesShape(body.sources)` and
returns **400** on a bad shape. It is at line 336; `validateIntakeSources` is not called until
line 450 (inside `if (body.sources.length > 0)`), and `body.sources` is coalesced to `[]` at
line 439. `validateSourcesShape` returns null for undefined/null (`source-shape.ts:43`) and for
an empty array (loop body never runs) — so undefined / `[]` sources are still accepted. The
route test `route.sources-shape.test.ts` includes "does NOT reject a submission with no sources
at all" and "does NOT reject a well-formed source — it reaches the reachability validator".

`source-shape.ts formatSourceDisplay` (read path) redacts BEFORE truncating
(`source-shape.ts:115-142`): `full = redactUrl(value)`, `text = truncateMiddle(full)` where
truncateMiddle = `slice(0,40)+"…"+slice(-23)`. Non-string value -> `"(invalid)"`; non-string
type -> `String(type)` (so an object can't crash React). Both value and detail pass through
`redactUrl`.

## Part D re-run (Playwright, real dev server on a5b4ac42) — qa-ui-sources.mjs
Fixture presigned URL carries TWO canaries: `deadbeefcafe` inside the X-Amz-Signature value
AND `TAILCANARY99` as the LAST 12 chars of the URL (trailing `&tail=…`), so the old raw
`slice(-23)` would have surfaced the tail canary.

### CASE 1 — main fixture (3 sources)
- unverified badge count: **1** (verified S3 row and skipped upload row show **no** badge)
- badge title (redacted): `URL not verified — GET (Range 0-0) -> 403 (Forbidden):
  https://qa-bucket.s3.amazonaws.com/specs/prd.pdf?X-Amz-Algorithm=REDACTED&X-Amz-Signature=REDACTED&tail=REDACTED`
  - contains `deadbeefcafe`? **false**   contains `TAILCANARY99`? **false**
- sources-list visible text (redacted): URL row shows `https://qa-bucket.s3.amazonaws.com/specs…=REDACTED&tail=REDACTED`
  - full-page visible text contains `deadbeefcafe`? **false**   contains `TAILCANARY99`? **false**
- IMPROVEMENT vs 04cc457c: on the old head the inline value showed RAW signature-tail bytes
  (redact-then-truncate was not yet in place). On a5b4ac42 both canaries are gone from the
  visible value — the standing TEAM-4078 concern is now fixed.
- console errors: only the harness's own EventSource-MIME notice (from stubbing `/watch` with
  JSON) — not an app error.
- Screenshots overwritten: TEAM-4064-workflowboard-sources.png (full) + -crop.png.
  Crop shows 3 rows: `[S3] s3://…/spec.md` (no badge), `[URL] https://qa-bucket…=REDACTED&tail=REDACTED`
  `[unverified]` (amber pill), `[UPLOAD] design-mockups.zip` (no badge).

### CASE 2 — TEAM-4078 crash row `{ value: null, type: {} }`
- board rendered (pipeline canvas present, count=1) — **no React crash**, no error boundary
- source row text: `[OBJECT OBJECT]` (CSS-uppercased `String({})`="[object Object]") + `(invalid)` value placeholder + `unverified` badge
- placeholder shown? **true**
- console errors: only the EventSource-MIME notice — **no** "Objects are not valid as a React child" / "Cannot read properties of null"
- Screenshot: TEAM-4064-workflowboard-invalid-source.png — full board renders normally.
