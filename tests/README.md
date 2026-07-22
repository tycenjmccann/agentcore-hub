# Cloud Code — test & validation tiers

Three tiers, cheapest first. Tier 1 is the merge gate (runs in CI on every PR,
no AWS). Tiers 2–3 are opt-in against a deployed environment.

## Tier 1 — merge gate (hermetic, no credentials)

Runs in `.github/workflows/ci.yml` on every push/PR. Nothing here touches AWS.

| Command | What it covers |
|---------|----------------|
| `npm run test:unit` | Vitest. Pure logic that's easy to break and expensive to break in prod: tenant S3-key layout + `..` traversal guard, GitHub HMAC state round-trip (SSO emails carry `.`, the token delimiter) + purpose separation, SSE frame plumbing, the `mutateSession` optimistic-concurrency CAS (`/stop` vs `/message` write race). |
| `npm run test:cloud-code` | Playwright with every backend call intercepted via `page.route`. Composer mic ⇄ send ⇄ stop state machine, Artifacts gallery + empty state + upload affordance, GitHub App connect/disconnect section, pull-to-laptop command copy. Needs a running server (CI boots `next start`; locally set `PLAYWRIGHT_BASE_URL`). |

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
