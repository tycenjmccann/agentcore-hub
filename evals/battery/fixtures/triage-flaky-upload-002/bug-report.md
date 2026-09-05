# Bug Report: File uploads intermittently fail with an empty error toast

**Reported by:** battery-user-2
**Environment:** sample-service web console
**Severity:** medium — retry usually works, but the error gives no information

## What happened

Uploading input files to a new workflow sometimes fails. When it fails, a toast
appears with no message text (just the red error styling). Retrying the same
file usually succeeds on the second attempt.

Things the reporter noticed after some experimenting:

- Files under roughly 5 MB have never failed for them.
- A 5.2 MB PDF failed twice in a row, then succeeded.
- A colleague saw the same thing with a 6 MB PNG.
- The browser network tab showed the upload request returning status 413 on the
  failures, but the toast showed nothing.
- No failures observed on files around 1–2 MB despite dozens of uploads.

## Expected

Either the upload succeeds, or the toast tells the user what went wrong (e.g.
"file exceeds the 5 MB limit") so they don't blindly retry.

## Notes

The reporter is not sure whether the boundary is exactly 5 MB or whether
retries "succeeding" were actually smaller files. Frequency is "a few times a
day across the team".
