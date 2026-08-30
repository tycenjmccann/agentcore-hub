# Bug Report: stop request silently lost when it races a message write

**Ticket:** BATT-106
**Severity:** high — user hits stop, the run keeps going

## What happened

Two captured occurrences (sanitized session ids battery-sess-a, battery-sess-b):

1. User sends a message; the server begins persisting the updated conversation
   record.
2. ~50 ms later the user clicks Stop; the stop handler sets `stopRequested: true`
   on the same record and saves.
3. The message write, which had read the record BEFORE the stop write landed,
   finishes last and saves its stale copy — `stopRequested` is back to `false`.
4. The run loop reads `stopRequested === false` and keeps generating.

In both captures the stop flag existed in the store for under a second before
being overwritten. Nothing in the logs errors — both writes "succeed".

## Expected

Once a stop is requested it must survive any concurrent writer; the run loop
must observe it.

## Notes

store.ts (attached) is the state store wrapper both handlers use. The store
backend supports conditional writes / version fields; the wrapper just doesn't
use them.
