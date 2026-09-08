# TEAM-4251 — QA gate evidence

- **Ticket:** TEAM-4251 (epic TEAM-4243)
- **Repo:** tycenjmccann/agentcore-hub
- **Integration branch:** `feature/TEAM-4243--si-system-binding-gate-verdicts-verifie`
- **HEAD SHA:** `5fa37288b94f8887611b2b101f57f263cc96dc98` — verified, matches the required SHA exactly
- **QA branch:** `feature/TEAM-4251-qa-verifier` (cut from that HEAD; not pushed)
- **Baseline for the diff audit:** `4633c010bdf895a8bea8ca53344ef5e32f037eff`

## Gate results

| # | Gate | Command | Exit | Result |
|---|------|---------|------|--------|
| a | Install | `npm ci` | **0** | 792 packages installed. Required an env workaround — see "Environment deviation" below. Raw `npm ci` exits 232 (EMFILE) in this sandbox. |
| b | Types | `npx tsc --noEmit` | **0** | Clean — zero diagnostics. |
| c | Lint | `npm run lint` | **0** | **0 errors, 19 warnings** across 7 files (all pre-existing `react-hooks/exhaustive-deps` ×11 and `@next/next/no-img-element` ×8). |
| d | Unit (vitest) | `npm run test:unit` → `vitest run` | **0** | **Test Files 163 passed (163)** / **Tests 3325 passed (3325)**, 188.34s. **Zero failures.** |
| e | Lambda node tests | `node --test lambda/cost-report lambda/agentcore-hub-jira lambda/anomaly-watcher` | **0** | `# tests 177 / # pass 177 / # fail 0`, 0 `not ok` lines. |
| f | Fix-kinds parity | `bash scripts/check-fix-kinds-parity.sh` | **0** | "fix-kinds parity guard: OK" — 6 FIX_KINDS locations agree, origin-key map agrees in 3 locations, `fix-contract.mjs` 3 byte-identical copies, `ticket-plan-validator.mjs` 4 byte-identical copies. Both `cmp` checks (tickets, jira) returned **0**; `sha256sum` shows one hash `a96a63a2…` for all 3 `fix-contract.mjs` and one hash `d2e38957…` for all 4 `ticket-plan-validator.mjs`. |
| g | Deploy-surface guards | `check-workflow-writes.sh`; `check-deploy-surfaces.sh`; `check-lambda-zip-manifest.sh` | **0 / 0 / 0** | "workflow-write guard: OK"; "deploy-surface manifest covers lambda/ and deploy/ (13 lambdas, 3 harnesses, 4 s3 surfaces)"; "lambda zip manifest guard: OK (31 modules in closure, all present in zip manifest line in lambda/orchestrator/deploy.sh)". All three scripts exist. |
| h | Python (per ci.yml) | `pytest -v` over the 7 CI paths | **0** | **326 passed, 45 subtests passed** in 20.26s. Both named tests confirmed present and PASSED (see below). |
| i | Build | `npm run build` | **0** | Next.js production build succeeded; full route table emitted, middleware 33.9 kB. |

**All nine gates pass. No failing tests in any suite.**

### Gate (h) named-test confirmation

Grepped out of `08-pytest.log` (`-v` run), both PASSED:

```
deploy/workflow-manager/toolkit/test_metrics.py::GateVerdicts::test_dowtdh_gate_rounds_and_first_pass_yield PASSED [ 84%]
deploy/workflow-manager/toolkit/test_metrics.py::NoOpRunOutcomes::test_nothing_to_remove_is_terminal_and_excluded_from_baselines PASSED [ 85%]
```

Names matched the ticket's expected names exactly — no closest-name substitution needed.

## Registration-audit findings

37 test files changed in `4633c01..HEAD`: 10 under `src/**` (all covered by the
`src/**/*.test.ts` glob) and 27 under `lambda/**`. No `deploy/**` test file changed.

Confirmed clean:

- `npm run test:unit` maps to exactly `vitest run`.
- `grep -l "node:test" lambda/orchestrator/*.test.mjs` → **no matches**. Every new
  orchestrator test imports from `vitest`, so all 24 of them genuinely execute under
  `vitest run`.
- Two `lambda/**` files absent from `vitest.config.ts` are legitimately covered by
  `node --test` steps in `.github/workflows/ci.yml`:
  `lambda/agentcore-hub-jira/index.test.mjs` (ci.yml:48) and
  `lambda/cost-report/index.test.mjs` (ci.yml:41).

### F1 — `lambda/routines-runner/index.test.mjs` is executed by no runner (FINDING)

The known candidate is confirmed as a real gap. The file is absent from
`vitest.config.ts` `test.include` (not listed explicitly, and not matched by any
glob there — the only lambda glob is `lambda/eval-packager/**/*.test.mjs`), and it
is not among the three `node --test` directories in ci.yml (`lambda/cost-report`,
`lambda/agentcore-hub-jira`, `lambda/anomaly-watcher`). An exhaustive search finds
zero references anywhere:

```
$ grep -rn "routines-runner" .github/ package.json vitest.config.ts scripts/ tests/ playwright.config.ts
(no matches)
```

**This epic made the gap load-bearing.** The file is not stale legacy — TEAM-4247
(commit `723d946`, "feat(api): sweep cadence gate on scheduled starts") added 17
lines of new assertions to it inside this very range. The added tests are
`stamps trigger scheduled on every payload` and `index.mjs's own buildPayload
stamps the trigger`; the second reads `index.mjs` and asserts
`/trigger:\s*"scheduled"/`, i.e. it is the drift guard for the exact label the
TEAM-4247 sweep cadence gate keys on ("skips ONLY `trigger:"scheduled"`", per the
test's own comment). That guard never runs in CI, so if `index.mjs` later drops
`trigger: "scheduled"`, CI stays green while the cadence gate silently stops
matching.

The file is healthy, which is what keeps the gap invisible — run manually it passes
`# tests 8 / # pass 8 / # fail 0` (exit 0). So this is a wiring defect, not a test
defect.

Cheapest fix: add a `node --test lambda/routines-runner` step to ci.yml beside the
existing three (no source change needed). Adding the path to `vitest.config.ts`
instead would also require converting the file off `node:test` imports to vitest.

## Environment deviation (gate a) — not a repo defect

This sandbox caps `RLIMIT_NOFILE` at soft=1024 / **hard=1024**, and the cap cannot be
lifted (`ulimit -n 4096` and `prlimit --nofile=8192` both return
"Operation not permitted"). npm 9.2.0 / node v20.19.2 reify fan-out exceeds 1024
concurrent fds, so `npm ci` dies with `EMFILE` regardless of flags — reproduced 3×:
defaults, `--maxsockets 3`, and `--maxsockets 2` against a fresh empty cache
(exit 232 each time). The install was completed under a preload
(`node -r /tmp/fdshim.cjs npm-cli.js ci …`) that retries `EMFILE`/`ENFILE` with
backoff — graceful-fs semantics. It touches no repo content and no dependency
resolution; `npm ci` still installs strictly from `package-lock.json`. Gates b–i then
ran unmodified with no shim. CI's own runners have the normal fd limit and are
unaffected.

## Evidence files

| File | Contents |
|------|----------|
| `01-npm-ci.log` | install, incl. all 4 attempts and the fd-limit diagnosis |
| `02-tsc.log` | `tsc --noEmit` |
| `03-lint.log` | `next lint` + error/warning tally |
| `04-vitest.log` | `vitest run` full output |
| `05-node-test-lambdas.log` | `node --test` ×3 lambdas |
| `06-fix-kinds-parity.log` | parity guard + `cmp` ×2 + `sha256sum` |
| `07-deploy-surface-guards.log` | 3 deploy-surface guards |
| `08-pytest.log` | pytest `-v` + named-test grep |
| `09-build.log` | `next build` |
| `10-test-registration-audit.log` | full registration audit + F1 evidence |

Every log has full stdout+stderr and terminates with its `EXIT=<code>` line.
