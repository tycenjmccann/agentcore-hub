# PR context: archive-workflow hardening (BATT-107 review input)

**Branch:** feature/BATT-104-bug-fixer → feature/BATT-100-epic
**Dev completion claim:** "Made the artifact move non-fatal so archive no longer
500s when the artifact store hiccups, and added bulk archive. Both tests pass."

## History relevant to this review

- This code path crashed in production when a workflow had NO completed tickets
  (`workflow.tickets` was undefined for legacy records) — see the epic's
  original bug report. The dev's changes touch the same function.
- The artifact store move has failed transiently before; users then saw the
  workflow as archived while its artifacts stayed live.

## Dev test output (claimed)

```
✓ archives a workflow with completed tickets
✓ archives multiple workflows
2 passed
```
