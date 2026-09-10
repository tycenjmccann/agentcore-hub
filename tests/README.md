# Cloud Code — test & validation tiers

Three tiers, cheapest first. Tier 1 is the merge gate (runs in CI on every PR,
no AWS). Tiers 2–3 are opt-in against a deployed environment.

## Tier 1 — merge gate (hermetic, no credentials)

Runs on every push/PR in BOTH CI surfaces, and nothing here touches AWS:
`.github/workflows/ci.yml` (GitHub Actions) and `deploy/pipeline/buildspec-ci.yml`
(CodeBuild `agentcore-hub-ci` — the *authoritative* required check branch protection
blocks merge on). A gate wired into only one of the two is not a gate: TEAM-4332's
resize suite was GH-only and CodeBuild ran zero of it (TEAM-4353). That is why every
hermetic UI spec is reached through the single `test:cloud-code` script below — add
new ones there, in `package.json`, never as a new CI step.

| Command | What it covers |
|---------|----------------|
| `npm run test:unit` | Vitest. Pure logic that's easy to break and expensive to break in prod: tenant S3-key layout + `..` traversal guard, GitHub HMAC state round-trip (SSO emails carry `.`, the token delimiter) + purpose separation, SSE frame plumbing, the `mutateSession` optimistic-concurrency CAS (`/stop` vs `/message` write race). |
| `npm run test:cloud-code` | Playwright, every backend call intercepted via `page.route` — the single entrypoint for hermetic UI specs, run by both CI surfaces. `tests/cloud-code-ui.spec.ts`: composer mic ⇄ send ⇄ stop, Artifacts gallery/empty state, GitHub App connect/disconnect, pull-to-laptop copy. `tests/tab-workflow-resize.spec.ts`: workflows-sidebar drag/keyboard resize + clamp bounds, drag lifecycle, and the dark-scrollbar paint. Needs a running server (CI boots `next start`; locally set `PLAYWRIGHT_BASE_URL`). |

Both spec files above run in one `playwright test` invocation, pinned to
`--workers=1` — see the comment on the script in `package.json` (TEAM-4353) for why.
The resize spec's bound/clamp values, its 6px-vs-10px scrollbar gutter discriminator,
and the TEAM-4331 drag-lifecycle cases are documented in the spec's own file comments
and in `docs/evidence/TEAM-4332/`; not repeated here to keep this table scannable.

Run the UI suite locally:

```bash
npm run build
npm run start -- -p 3737 &
PLAYWRIGHT_BASE_URL=http://localhost:3737 npm run test:cloud-code
```

## Tier 2 — integration (needs staging AWS + a test GitHub App)

Not yet automated — validate on a deployed environment:

- GitHub App install → callback → `cloneTokenForUser` mints a scoped token that clones a private repo.
- Full turn: warm → message (SSE) → **stop mid-stream** → `STOP_MARKER` persisted → session re-warms.
- Artifact round-trip: runtime `_sync_turn_artifacts` → S3 → web list presigns → thumbnail renders.

`tests/cloud-code-demo.spec.ts` drives the live deployed tab against the real
runtime (opt-in): set `PLAYWRIGHT_BASE_URL` to the App Runner URL, `--headed`.

## Tier 3 — multi-tenant isolation (security-sensitive)

The boundary that matters most. Validate on a two-tenant staging deploy:

- Tenant A cannot list/read tenant B's artifacts, configs, or GitHub install record (403/empty across the `t/<tenantId>/` prefix).
- Default-tenant legacy unprefixed keys still resolve (zero-migration guarantee).
