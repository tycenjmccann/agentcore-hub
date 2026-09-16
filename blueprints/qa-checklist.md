# QA Checklist (shared)

This is THE verification checklist for the hub. It is not a persona: any agent
that has to decide "does this change actually work?" loads it with
`load_blueprint("qa-checklist")` and runs the checks that apply — the QA
verifier as its verification core, the operator in its LIVE VERIFY step, a dev
or release manager asked to prove a fix. One file, one standard: a PASS means
the same thing no matter who says it.

The single rule underneath every check: **a PASS covers only what actually
RAN.** Reading the code, reading the tests, a green build, a green mocked suite —
none of those are a run. If you did not exercise it against the real thing, the
row is UNVERIFIED and you say so.

Who loads this file decides what happens on FAIL (the QA verifier files fix
tickets; the operator sends findings back to its worker). This file decides
what counts as verified.

## C0. Which checks apply (decide from the DIFF, not the ticket title)

| The change… | Run |
|---|---|
| touches any UI — components, pages, styles, layouts, a rendered response | C1 Visual |
| calls anything outside the process — an external API/SDK, an AgentCore runtime or harness, a Lambda, DynamoDB/S3, another service, a vendor sandbox, the app's own API route from a client | C2 Live integration |
| is an iOS / Xcode project | C3 iOS gateway (replaces the build/test rows and C1) |
| claims a performance improvement | C4 Perf re-measure |
| every change | C5 Acceptance walk, then C6 Verification Ledger + verdict |

"The app's own API route" counts as an integration: a client component and the
route it calls are two processes with a contract between them, and a test that
mocks the route with a hand-written payload verifies the client against the
author's guess, not against the route.

## C1. Visual verification (MANDATORY for UI changes)

The `claude_code` workspace is remote — screenshots it takes are not local files
you can read. It screenshots + reviews INSIDE the session; the file reaches you
via the auto-harvested S3 keys.

1. Have `claude_code` (same session) start the dev server and screenshot the
   changed view with Playwright (viewport 1440x900; Chromium is baked into the
   image — never `playwright install`; run only the spec(s) for the changed
   screens, never the whole suite), saving the PNG under the session's artifact
   dir (`.cloud-code/artifacts/` or the loader's evidence dir) — never into the
   repo tree.
2. The screenshot must show the feature DOING its job with real data on the
   screen — a reply rendered, a row loaded, a state changed — not the empty
   shell or the loading state. For a feature that talks to a backend, the
   screenshot is taken during C2 (real backend, no route stubs) so the two
   checks share one run.
3. Have it (same session) describe exactly what the screenshot shows against
   the spec / acceptance criteria — iterate until the description is concrete
   (what text, which elements, which states).
4. Never commit the screenshot: a verification commit moves the head off the
   reviewed/certified SHA, and a PNG on the branch is a review finding.
5. The runtime auto-harvests generated files to S3 — the keys appear in the
   `[coding-artifacts: ...]` footer of the `claude_code` result. Look at it
   YOURSELF: `download_s3_file(<key>)` → `image_reader`. Then copy it to durable
   evidence: `workflows/{workflow_id}/shared/qa-evidence/<name>.png`
   (`S3Storage___write_object` / `upload_file_to_s3` from your downloaded copy).
6. Rendered UI does not match the spec → FAIL with the exact discrepancies.

**A UI verdict without a screenshot of the working feature is INVALID.**

## C2. Live integration verification (MANDATORY when the change calls anything outside the process)

Unit tests and a green build do NOT verify an integration — they exercise the
code's OWN assumptions about the other side. If the author guessed the endpoint,
the model id, the secret name, the event/frame shape, the tests were written
against that same guess: they pass by construction and still fail 100% against
the real service. You MUST prove it against reality:

1. **Establish the REAL contract independently — do not trust the branch.**
   - External vendor: fetch the authoritative docs (`docs.<vendor>`, the vendor
     `/llms.txt`, the API reference, the official SDK/cookbook) with
     `http_request` / `browser` and confirm the exact endpoint (incl. `wss://` vs
     `https://`), the model/resource ids (against the models endpoint), the
     request/response/event schema, and that every secret the code reads EXISTS
     in Secrets Manager (list names — never values; a referenced-but-nonexistent
     secret is an automatic FAIL). "It's a marketing/blog link" is not a spec.
   - Internal dependency (a runtime, Lambda, table, the app's own route): the
     contract is what the real thing emits. Capture one real response body /
     event stream / item from it and compare against what the tests assume.
   Any mismatch between the branch and the real contract = FAIL with the source
   (doc URL or captured body) and the exact discrepancy.
2. **EXERCISE it end to end, for real, once.** Through `claude_code`: start the
   app against the real environment the workspace has (its ambient AWS
   credentials are the runtime role; `.env.local` from `.env.example` with the
   run's account/region/table/bucket values), then do the smallest real
   round-trip that proves the protocol — hit the changed route with `curl` /
   drive the changed screen with Playwright **with NO `page.route` / mock on the
   changed path** — and capture the ACTUAL response body, status codes, event
   frames or transcript. For a streaming path, capture the raw upstream body AND
   what the client rendered from it. Upload the captures to
   `workflows/{workflow_id}/shared/qa-evidence/`.
3. **"Verified by construction" is a finding, not a pass.** If every test of a
   seam mocks that seam with a hand-written shape and no fixture was captured
   from the real system, say so explicitly in the ledger's Evidence column; the
   author's fixtures are a hypothesis until step 2 confirms them.
4. **If you genuinely cannot reach the live dependency** (no credentials in the
   workspace, network blocked, the service is down): you may NOT substitute the
   author's mocks, a fake, or a code read. The row is UNVERIFIED / BLOCKED — not
   PASS — and you state exactly what prevented the live run (the command and its
   error). Whoever loaded this file decides what BLOCKED does next; this file
   only forbids calling it a pass.

**A PASS on an integration that was verified only by the author's own tests is
INVALID. No real round-trip against the real contract = not a pass.**

## C3. iOS projects (MANDATORY — replaces the build/test rows and C1 for iOS)

`claude_code` cannot build iOS. The CodeBuild macOS gateway is your build + test
evidence:

1. `list_schemes(branch)` if the scheme is unknown.
2. `ios_test(branch, scheme)` — async, returns `build_id`. Pass
   `record_session=true` for UI-facing changes so you get a simulator video.
3. Poll `ios_build_status(build_id)` every ~60s until terminal → `test_summary`
   (total/passed/failed), `failures[]`, `artifacts`.
4. `get_test_logs(build_id, test_name)` for each failure — includes screenshots.
5. Verdict mapping: `BUILD_ERROR` → FAIL (build_errors are the evidence); test
   failures relevant to the change → FAIL with test names + logs; pre-existing
   failures unrelated to the change → note them, do not block on them.
6. If the author's PR references a gateway `build_id`, still run your own —
   verify, don't trust.
7. Coverage: the branch must include tests for the acceptance criteria; new
   behaviour with no tests = FAIL even on a green build.
8. **Persist the evidence to S3.** The gateway's artifact URLs are presigned and
   EXPIRE. For each artifact (session video, failure screenshots): have
   `claude_code` (same session) `curl` it into its workspace — the runtime
   auto-harvests those files and returns the keys in the `[coding-artifacts:
   ...]` footer (do NOT curl to `/tmp` and upload yourself: that path is not on
   your side). Copy each harvested file to
   `workflows/{workflow_id}/shared/qa-evidence/<name>` and write
   `qa-evidence/test-summary.md` with the `build_id`, the numbers and the
   evidence file list. Cite the S3 keys, never the presigned URLs.

**Gateway missing or failing = BLOCKED, never PASS.** If `ios_test` /
`ios_build_status` / `list_schemes` are not in your tool list, or a gateway call
errors or times out, you have NOT verified the change: static analysis, reading
the diff and "the code looks correct" are not a compile + test run. Say exactly
which tool was missing and what you could NOT verify (compiles? tests pass? the
button responds?). "macOS/Xcode unavailable" is exactly this case — the reason
to stop, not a reason to wave the change through.

## C4. Performance re-measure (MANDATORY when the change claims a perf fix)

A perf change's acceptance criterion IS the measured delta — not the suite, not
the build.

1. The author's evidence must contain measured before/after numbers (operation
   counts, latency). Missing numbers = FAIL: "measure it".
2. REPRODUCE the measurement yourself: run the counting test / measurement
   script on the base branch and on the change, same seeded scenario, and
   confirm the delta. On iOS, route it through the gateway like any test run.
3. Check the SYMPTOM is gone, not just one contributor: count the total
   operations the affected screen/endpoint issues end to end after the change.
   One N+1 removed while the same surface still issues N-scaling calls elsewhere
   = FAIL with the counts.
4. The regression test must assert the invariant (an operation-count or latency
   bound), not an implementation detail — a test asserting "filters on field X"
   passes while the perf bug returns. FAIL if so.
5. Persist YOUR numbers to `qa-evidence/` and put before/after in the ledger.

**A perf PASS with no independently reproduced numbers is INVALID.**

## C5. Acceptance criteria walk

Walk every acceptance criterion from the spec / plan / work order:
- code-level criteria → grep/read the source and cite `file:line`;
- visual criteria → cite the C1 screenshot key;
- integration criteria → cite the C2 captured round-trip key;
- perf criteria → cite the C4 numbers.
Mark each PASS or FAIL with one line of reasoning. A criterion with no test AND
no live evidence is FAIL, not "covered by review".

## C6. Verification Ledger + verdict

Every verdict opens with a **Verification Ledger** — an explicit table of what
was and was NOT actually executed, so no one mistakes a static read for a
tested build:

| Check | Ran? | Result | Evidence |
|-------|------|--------|----------|
| Compile / build | yes/NO | pass/fail/— | build_id or S3 key |
| Test suite | yes/NO | X passed / Y failed | build_id / test-summary.md |
| Live integration (C2: what was hit, for real) | yes/NO/n-a | real response/frames captured? | qa-evidence key |
| UI behaviour (C1: the feature working, real data) | yes/NO/n-a | matches spec? | screenshot key |
| Acceptance criteria (C5) | yes/NO | n of m PASS | this report |
| Perf delta (C4, perf changes) | yes/NO/n-a | before → after, independently reproduced | qa-evidence key |

Rules of the table:
- `n-a` is allowed ONLY when C0 says the check does not apply to this diff, and
  the Evidence column says why in five words ("no UI in diff").
- Any row marked `NO` is UNVERIFIED: the verdict cannot be PASS on that
  dimension. Never describe a code read as if it were a run.
- Evidence must be DURABLE: keys under `workflows/{workflow_id}/shared/qa-evidence/`.
  Presigned URLs, repo-only files and "see my session" do not count.

Verdicts:
- **PASS** — every applicable row is `yes` with passing evidence, every
  criterion met, nothing unresolved. PASS asserts "this was built, run and it
  works"; it is valid only when that is literally true. **ZERO-ISSUE PASS:** any
  unresolved check, criterion or suspicion, of any severity, is a FAIL (or a
  BLOCKED row), never "PASS with notes". Prove it or report it.
- **FAIL** — something ran and failed, or a criterion is unmet. Report exact
  failure output / discrepancy + evidence key per finding, grouped by
  file/component. The loader's own blueprint says how a FAIL is routed.
- **BLOCKED** — a required check could not run at all (gateway tools missing,
  no credentials for the live dependency, dev server will not start — which is
  itself a FAIL: the code should be runnable). NOT a soft pass: the change is
  not merge-ready. State precisely what was blocked and what remains unverified.

**Never emit "CONDITIONAL PASS", "PASS pending build", or "looks correct, ready
to merge" for something you could not run. Use BLOCKED and say so plainly.**

### `evidence_kind` on the completion record

`WorkflowOutput___report_completion(evidence_kind=…, evidence_keys=…)` is the
only durable record that a check was EXECUTED rather than read:
- `"live"` — you actually RAN the system for the applicable C1/C2/C3/C4 rows
  (real backend, real screenshot, real round-trip). `evidence_keys` = those
  `qa-evidence/` keys. This is the only value that means "verified".
- `"unit"` — only the mechanical rows ran (build/tests, possibly mocked). On a
  diff where C1 or C2 applies, `"unit"` says "NOT verified" and the summary must
  say why (BLOCKED reason).
- `"static"` — you only read it. Never valid where C1/C2/C3/C4 applies.
Never inflate: a `"live"` record with no live evidence behind it is worse than
an honest `"unit"`, because downstream readers (release manager, orchestrator
re-verify) act on it.

## Rules (apply to every loader)
- NEVER pass a UI change without a screenshot of the working feature (C1).
- NEVER pass a change that calls a service, runtime, Lambda, table or its own
  API route without one real round-trip against the real thing (C2). The
  author's own tests are not verification of a contract they may have guessed.
- NEVER pass a perf change without independently reproduced before/after (C4).
- A secret the code reads that does not exist in Secrets Manager = FAIL.
- Evidence for every claim — actual command output, not assumptions — and every
  evidence file durable under `shared/qa-evidence/`.
- The dev server not starting is a FAIL (the code should be runnable), not a
  reason to fall back to a mocked run.
- Compare rendered output against the spec / wireframe / acceptance criteria,
  and check for regressions: does existing functionality on the touched surface
  still work?
- Pick the `claude_code` intelligence tier per call with `model=`: `"fable"`
  (default — top reasoning, debugging), `"opus"` (deep implementation work),
  `"sonnet"` (routine, well-specified), `"haiku"` (trivial mechanical edits).
- Include the `[coding-session: ...]` footer(s) in your completion record so
  the exact verification session can be reopened.
