# Dev completion report: notification preferences (BATT-112 verification input)

**Branch:** feature/BATT-106-bug-fixer

## What was done

- Added per-category digest frequency selector (immediate / daily / weekly) to
  the settings page, persisted per user.
- New categories default to `immediate` so users see activity right away.
- Digest email template renders category summaries with counts and deep links.
  Footer shows the product name and a settings-page link.
- Preference changes apply on the next digest cycle.

## Evidence

```
✓ selector persists frequency per category
✓ digest renders category summaries
✓ preference change applies next cycle
3 passed; build and typecheck clean
```
