# Bug Report: App crashes when archiving a workflow with no completed tickets

**Reported by:** battery-user-1 (internal dogfood)
**Environment:** sample-service web console, production build
**Severity:** high — archive is unusable for fresh workflows

## What happened

Clicked "Archive" on a workflow that had been created but where no ticket had
reached done. The page went blank and the console showed:

```
TypeError: Cannot read properties of undefined (reading 'filter')
    at archiveWorkflow (src/lib/workflow/archive.ts:47:31)
    at onArchiveClick (src/components/workflow/WorkflowActions.tsx:88:9)
```

## Steps to reproduce

1. Create a new workflow (any definition) and let intake fail or cancel it before any ticket completes.
2. Open the workflow detail page.
3. Click "Archive".
4. Observe blank page and the TypeError above.

## Expected

Archiving a workflow with zero completed tickets should succeed (archive the
epic and open tickets as-is) or show a clear validation message — never crash.

## Notes

Archiving workflows that have at least one done ticket works fine, which is why
this survived QA: every QA fixture workflow had completed tickets.
