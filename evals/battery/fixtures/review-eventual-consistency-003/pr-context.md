# PR context: artifact listing refresh (BATT-109 review input)

**Branch:** feature/BATT-105-backend-dev → feature/BATT-100-epic
**Dev completion claim:** "Small helper so the artifacts panel refreshes right
after an upload and highlights the new file. Test passes."

## Notes for the reviewer

- The artifact client in production is backed by an object store whose LIST
  operation lags PUT under load; the test uses an in-memory fake where a put is
  immediately visible to the next list.
- Multiple agents in the same workflow write to the same `shared/` prefix
  concurrently.
- The non-null assertion on `latestKey` was flagged by lint and suppressed by
  the dev with a `!`.

## Dev test output (claimed)

```
✓ returns the new key in the listing
1 passed
```
